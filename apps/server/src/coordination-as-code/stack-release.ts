import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ReleaseStackOwnershipResponse, StackReleaseRelationship } from "@scp/schemas";
import { objects, relationships } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { conflict } from "../errors.js";
import { writePermissionFor, type ScopeCheck } from "./plans-repo.js";
import {
  releaseObjectStackOwnership,
  releaseRelationshipStackOwnership
} from "./stack-ownership.js";

/** The authority a release requires: what DECOMMISSIONING the whole stack would. See docs/coordination-as-code.md §330. */
export async function stackReleaseAuthorityChecks(
  tx: TenantTx,
  orgId: string,
  stackName: string
): Promise<ScopeCheck[]> {
  const ownedObjects = await tx
    .select({ id: objects.id, typeId: objects.typeId })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.managedByStack, stackName),
        isNull(objects.deletedAt)
      )
    );
  const ownedEdges = await tx
    .select({ fromId: relationships.fromId, toId: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.managedByStack, stackName),
        isNull(relationships.deletedAt)
      )
    );

  // The same (permission, scope) pairs `prepareApplyChecks` pushes for a `delete` entry.
  const checks = new Map<string, ScopeCheck>();
  const add = (check: ScopeCheck) =>
    checks.set(`${check.permission} ${check.scopeObjectId}`, check);
  for (const o of ownedObjects) {
    add({ permission: writePermissionFor(o.typeId), scopeObjectId: o.id });
  }
  for (const e of ownedEdges) {
    add({ permission: "relationship:write", scopeObjectId: e.fromId });
    add({ permission: "relationship:write", scopeObjectId: e.toId });
  }
  return [...checks.values()];
}

/** Why a named row is not releasable from `stackName`, or null when it is. */
function refusalFor(
  label: string,
  row: { managedByStack: string | null; deletedAt: Date | null } | undefined,
  stackName: string,
  noun: string
): string | null {
  if (!row) return `${label}: no such ${noun}`;
  if (row.deletedAt !== null) return `${label}: deleted`;
  if (row.managedByStack === null) return `${label}: not managed by any stack`;
  if (row.managedByStack !== stackName) return `${label}: owned by stack '${row.managedByStack}'`;
  return null;
}

const edgeLabel = (r: StackReleaseRelationship) => `${r.typeId} ${r.fromUrn} -> ${r.toUrn}`;

/** Validates, releases and audits, in the caller's transaction. See docs/coordination-as-code.md §331. */
export async function releaseStackOwnership(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    stackName: string;
    urns: readonly string[];
    relationships: readonly StackReleaseRelationship[];
  }
): Promise<ReleaseStackOwnershipResponse> {
  const { orgId, stackName } = input;
  const urns = [...new Set(input.urns)];
  const refusals: string[] = [];

  // `urn` is unique per org INCLUDING tombstones, so this reads the one row each URN can name.
  // FOR UPDATE: a concurrent apply cannot move ownership between this read and the write.
  const objectRows =
    urns.length === 0
      ? []
      : await tx
          .select({
            id: objects.id,
            urn: objects.urn,
            typeId: objects.typeId,
            managedByStack: objects.managedByStack,
            deletedAt: objects.deletedAt,
            domainLocal: objects.domainLocal
          })
          .from(objects)
          .where(and(eq(objects.orgId, orgId), inArray(objects.urn, urns)))
          .for("update");
  const byUrn = new Map(objectRows.map((r) => [r.urn, r]));
  for (const urn of urns) {
    const refusal = refusalFor(urn, byUrn.get(urn), stackName, "object");
    if (refusal) refusals.push(refusal);
  }

  const edges = [...new Map(input.relationships.map((r) => [edgeLabel(r), r])).values()];
  const endpointUrns = [...new Set(edges.flatMap((r) => [r.fromUrn, r.toUrn]))];
  const endpoints =
    endpointUrns.length === 0
      ? []
      : await tx
          .select({ id: objects.id, urn: objects.urn, domainLocal: objects.domainLocal })
          .from(objects)
          .where(
            and(
              eq(objects.orgId, orgId),
              inArray(objects.urn, endpointUrns),
              isNull(objects.deletedAt)
            )
          );
  const endpointByUrn = new Map(endpoints.map((r) => [r.urn, r]));

  const releasedEdges: ReleaseStackOwnershipResponse["releasedRelationships"] = [];
  let edgeTouchesDomainLocal = false;
  for (const edge of edges) {
    const label = edgeLabel(edge);
    const from = endpointByUrn.get(edge.fromUrn);
    const to = endpointByUrn.get(edge.toUrn);
    const [row] =
      from && to
        ? await tx
            .select({
              id: relationships.id,
              managedByStack: relationships.managedByStack,
              deletedAt: relationships.deletedAt
            })
            .from(relationships)
            .where(
              and(
                eq(relationships.orgId, orgId),
                eq(relationships.typeId, edge.typeId),
                eq(relationships.fromId, from.id),
                eq(relationships.toId, to.id)
              )
            )
            .for("update")
        : [];
    const refusal = refusalFor(label, row, stackName, "relationship");
    if (refusal || !row) {
      refusals.push(refusal ?? `${label}: no such relationship`);
      continue;
    }
    if (from?.domainLocal || to?.domainLocal) edgeTouchesDomainLocal = true;
    releasedEdges.push({
      id: row.id,
      typeId: edge.typeId,
      fromUrn: edge.fromUrn,
      toUrn: edge.toUrn
    });
  }

  // ALL OR NOTHING: a partial release would report success for a request naming a row the stack
  // never owned — exactly the typo this refusal exists to surface.
  if (refusals.length > 0) {
    throw conflict(
      `stack '${stackName}' does not own every row this release names, so nothing was released: ` +
        refusals.join("; ")
    );
  }

  const releasedObjects = urns.map((urn) => byUrn.get(urn)!);
  const objectCount = await releaseObjectStackOwnership(
    tx,
    orgId,
    stackName,
    releasedObjects.map((o) => o.id)
  );
  const edgeCount = await releaseRelationshipStackOwnership(
    tx,
    orgId,
    stackName,
    releasedEdges.map((e) => e.id)
  );
  if (objectCount !== releasedObjects.length || edgeCount !== releasedEdges.length) {
    // Unreachable under the row locks above; refusing beats auditing a list that is not true.
    throw conflict(`stack '${stackName}' ownership changed during the release; retry`);
  }

  // Principle 6: one hash-chained event per release, in this transaction, naming every row.
  await appendAuditEvent(tx, {
    orgId,
    actorId: input.actorObjectId,
    action: "stack.release",
    reason:
      `released from stack '${stackName}': ` +
      `objects=[${releasedObjects.map((o) => o.urn).join(", ")}] ` +
      `relationships=[${releasedEdges.map(edgeLabel).join(", ")}]`,
    requestId: input.requestId,
    // The reason names URNs, so a domain-local row's identity must not leave in the audit segment.
    subjectDomainLocal: edgeTouchesDomainLocal || releasedObjects.some((o) => o.domainLocal)
  });

  return {
    stackName,
    releasedObjects: releasedObjects.map(({ id, urn, typeId }) => ({ id, urn, typeId })),
    releasedRelationships: releasedEdges
  };
}

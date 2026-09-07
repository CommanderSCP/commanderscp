import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { GraphObject, TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { createObject, toGraphObject } from "./objects-repo.js";
import { computeObjectContentHash } from "./content-hash.js";
import { ProblemError, notFound } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";

/** The immutable built thing, minted at the promotion boundary. See docs/graph.md §4. */

export interface ArtifactMintInput {
  /** `'oci' | 'blob'` today (`ArtifactRefSchema`), but read as a plain string here — the registered
   *  `artifact` type's `artifactType` property is deliberately OPEN (0095's header; ADR-0045 D1),
   *  and this module must not narrow what its own caller already widened. */
  artifactType: string;
  digest: string;
}

export interface MintArtifactObjectsOptions {
  actorObjectId: string;
  requestId: string;
  /** ADR-0045 D2 — which side of the boundary minted this row. Optional, open provenance: never an
   *  enforcement input, purely for an operator asking "where did this artifact object come from". */
  mintedBy: "export" | "import";
  /** The promotion change that first caused this identity to be minted, when known. Optional: a
   *  row found already minted (by this call or an earlier one) is returned unchanged — this field
   *  is stamped only on the row this call itself creates, never overwritten on convergence (see
   *  the "first" in the name). */
  firstPromotedChangeId?: string;
}

/** One `artifact` row, keyed by its identity. See docs/graph.md §5. */
export async function findArtifactByIdentity(
  tx: TenantTx,
  orgId: string,
  artifactType: string,
  digest: string
): Promise<GraphObject | undefined> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "artifact"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'digest' = ${digest}`,
        sql`${objects.properties} ->> 'artifactType' = ${artifactType}`
      )
    )
    .limit(1);
  return rows[0] ? toGraphObject(rows[0]) : undefined;
}

/** UPSERT-BY-IDENTITY, one artifact at a time. See docs/graph.md §6. */
async function upsertArtifactByIdentity(
  tx: TenantTx,
  orgId: string,
  artifact: ArtifactMintInput,
  options: MintArtifactObjectsOptions
): Promise<GraphObject> {
  const existing = await findArtifactByIdentity(tx, orgId, artifact.artifactType, artifact.digest);
  if (existing) return existing;

  try {
    // A SAVEPOINT (nested `tx.transaction`), not a bare `try`/`catch`. See docs/graph.md §7.
    return await tx.transaction((inner) =>
      createObject(inner, {
        orgId,
        typeId: "artifact",
        actorObjectId: options.actorObjectId,
        requestId: options.requestId,
        id: uuidv7(),
        // The digest IS the identity — a readable name beats an invented label, and `deriveUrn`
        // slugifies it into a valid urn segment.
        name: `${artifact.artifactType}:${artifact.digest}`,
        properties: {
          digest: artifact.digest,
          artifactType: artifact.artifactType,
          mintedBy: options.mintedBy,
          ...(options.firstPromotedChangeId
            ? { firstPromotedChangeId: options.firstPromotedChangeId }
            : {})
        }
      })
    );
  } catch (err) {
    if (err instanceof ProblemError && err.status === 409) {
      // Lost the race — the row this call would have created now exists under a different id.
      // Converge on it rather than surfacing a conflict neither caller can act on.
      const winner = await findArtifactByIdentity(
        tx,
        orgId,
        artifact.artifactType,
        artifact.digest
      );
      if (winner) return winner;
    }
    throw err;
  }
}

/** Mint (or find) one `artifact` object per entry in `artifacts`. See docs/graph.md §8. */
export async function mintArtifactObjects(
  tx: TenantTx,
  orgId: string,
  artifacts: ArtifactMintInput[],
  options: MintArtifactObjectsOptions
): Promise<GraphObject[]> {
  const minted: GraphObject[] = [];
  // Sequential, not `Promise.all`. See docs/graph.md §9.
  for (const artifact of artifacts) {
    minted.push(await upsertArtifactByIdentity(tx, orgId, artifact, options));
  }
  return minted;
}

export interface AdoptArtifactIdentityInput {
  /** THIS domain's own row — found by identity (digest+artifactType), never by the incoming urn:
   *  see the caller (`federation/import-repo.ts`'s `object_upsert` branch). Stays the id AND the
   *  urn after adoption; only authority and content move. */
  existingId: string;
  /** The cryptographically-verified signer of the incoming entry (never `payload.originDomainId`
   *  — same authority rule every other import branch enforces). */
  originDomainId: TrustDomainId;
  revision: number;
  /** The incoming signed entry's own `properties` — merged over the existing row's (see the
   *  `firstPromotedChangeId` carve-out below). */
  incomingProperties: Record<string, unknown>;
  actorObjectId: string;
  requestId: string;
}

/** Converge by adoption, the fix for the identity collision. See docs/graph.md §10. */
export async function adoptArtifactIdentity(
  tx: TenantTx,
  orgId: string,
  input: AdoptArtifactIdentityInput
): Promise<GraphObject> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, input.existingId),
        eq(objects.typeId, "artifact"),
        isNull(objects.deletedAt)
      )
    )
    .for("update");
  const existing = rows[0];
  if (!existing) throw notFound(`artifact '${input.existingId}' not found`);

  // IDEMPOTENT REPLAY (DESIGN §13 DoD: "double-import is a no-op"). See docs/graph.md §11.
  if (existing.originDomainId === input.originDomainId && existing.revision >= input.revision) {
    return toGraphObject(existing);
  }

  const existingProperties = existing.properties as Record<string, unknown>;
  const nextProperties: Record<string, unknown> = {
    ...input.incomingProperties,
    ...(typeof existingProperties.firstPromotedChangeId === "string"
      ? { firstPromotedChangeId: existingProperties.firstPromotedChangeId }
      : {})
  };
  const nextVersion = existing.version + 1;
  const afterHash = computeObjectContentHash({
    id: existing.id,
    orgId,
    domainId: existing.domainId,
    typeId: "artifact",
    name: existing.name,
    urn: existing.urn,
    properties: nextProperties,
    labels: existing.labels,
    version: nextVersion
  });

  const [row] = await tx
    .update(objects)
    .set({
      originDomainId: input.originDomainId,
      revision: input.revision,
      // Same as any signature-verified import: not an unverified hand-fill.
      provenance: null,
      properties: nextProperties,
      version: nextVersion,
      contentHash: afterHash,
      updatedAt: new Date()
    })
    .where(eq(objects.id, existing.id))
    .returning();
  if (!row) throw new Error("failed to adopt artifact identity");

  await appendAuditEvent(tx, {
    orgId,
    domainId: existing.domainId,
    actorId: input.actorObjectId,
    action: "artifact.update",
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash,
    reason:
      `converged by adoption (ADR-0045 D2a): this domain's own import-minted artifact anchor now ` +
      `adopts origin domain '${input.originDomainId}' as the shared base's authority — id/urn unchanged`,
    requestId: input.requestId,
    // ADR-0045 D3 — an artifact is never domain-local.
    subjectDomainLocal: false
  });

  return toGraphObject(row);
}

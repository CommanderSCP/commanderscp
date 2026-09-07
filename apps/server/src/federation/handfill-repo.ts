import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest, forbidden } from "../errors.js";
import { hasPermission } from "../authz/resolve.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import {
  isGovernanceManagedObjectType,
  isProjectionBoundObjectType,
  projectionBoundRefusalDetail
} from "../governance/governance-managed-types.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { isPeerBoundObjectType } from "./outpost-binding.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  assertEnforceableDependencySubscriptionScope,
  assertNoDelegatedDependencyUpdates
} from "../dependencies/subscription-authoring-guard.js";
import {
  assertMayWriteGovernanceLabels,
  assertSelectorKeysAreGovernanceLabels
} from "../governance/governance-labels.js";
import { assertValidComponentSecurityDeclarations } from "../governance/component-declaration-guard.js";
import { assertValidCampaignRecipe } from "../governance/campaign-recipe-guard.js";
import { assertScanOverrideGrantNotSelfDecided } from "../governance/scan-override-grant-authoring-guard.js";

/** Hand-fill for air-gapped outposts with no transport. See docs/federation.md §233. */
export interface HandFillInput {
  orgId: string;
  /** The REAL requesting subject, for authorization only. See docs/federation.md §234. */
  actorObjectId: string;
  peerIdOrName: string;
  typeId: string;
  urn: string;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

/** The fifth local write door, and its own narrowing. See docs/federation.md §235. */
async function assertHandFillableType(tx: TenantTx, input: HandFillInput): Promise<void> {
  // Pair-bound types: the fifth door of that census. See docs/federation.md §236.
  if (isPairBoundObjectType(input.typeId)) {
    throw forbidden(
      `object type '${input.typeId}' is identified by a pair of objects and cannot be hand-filled — ` +
        `use /api/v1/${input.typeId}s, which requires both endpoints, writes the derived edges ` +
        `atomically and enforces the containment depth bound for both (ADR-0037)`
    );
  }
  if (!isPeerBoundObjectType(input.typeId)) return;
  const raw = input.properties?.peerDomainId;
  const self = await ensureFederationSelf(tx, input.orgId);
  if (typeof raw !== "string" || raw !== self.domainId) {
    throw badRequest(
      `hand-fill cannot create a '${input.typeId}' object about another domain: properties.peerDomainId ` +
        `must be this instance's own federation domain id ('${self.domainId}') — that is the only shape a ` +
        `real replica has. To declare config ABOUT a paired outpost, use POST /v1/federation/outposts, ` +
        `which enforces the 1:1 peer binding (paired peer, role 'outpost', no duplicate)`
    );
  }
}

/** M21.7 (ADR-0032 §6a census amendment). See docs/federation.md §237. */
async function assertGovernanceAuthorityForHandFill(
  tx: TenantTx,
  input: HandFillInput
): Promise<void> {
  // Ahead of the permission check, which is wrong for this type. See docs/federation.md §238.
  if (isProjectionBoundObjectType(input.typeId)) {
    throw forbidden(projectionBoundRefusalDetail(input.typeId, "a hand-fill"));
  }
  if (!isGovernanceManagedObjectType(input.typeId)) return;
  const ok = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "policy:write",
    // The org root object's id IS the org id (auth/local-auth.ts `ensureOrgRootObject`).
    scopeObjectId: input.orgId
  });
  if (!ok) {
    throw forbidden(
      `object type '${input.typeId}' is governance-managed: hand-filling one requires 'policy:write' ` +
        `at the organization root (a hand-filled row lands at org-root containment, and an unscoped ` +
        `policy matches every target in the org) — 'federation:write' alone is not that authority`
    );
  }
}

/** This permission stops being a graph-write one at this door. See docs/federation.md §239. */
async function assertObjectWriteAuthorityForHandFill(
  tx: TenantTx,
  input: HandFillInput
): Promise<void> {
  const ok = await hasPermission(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "object:write",
    // The org root object's id IS the org id (auth/local-auth.ts `ensureOrgRootObject`), and it is
    // where a hand-filled row lands — see the docblock.
    scopeObjectId: input.orgId
  });
  if (!ok) {
    throw forbidden(
      `hand-filling a '${input.typeId}' writes a graph object into this organization's estate and ` +
        `requires 'object:write' at the organization root (a hand-filled row lands at org-root ` +
        `containment) — 'federation:write' operates the federation link and is not authority to ` +
        `author estate objects. Both are required; neither substitutes for the other`
    );
  }
}

/** The second check this door has to run for itself. See docs/federation.md §240. */
export async function handFillObject(tx: TenantTx, input: HandFillInput): Promise<GraphObject> {
  await assertHandFillableType(tx, input);
  // The component-declaration guard, in the same position. See docs/federation.md §241.
  assertValidComponentSecurityDeclarations({
    typeId: input.typeId,
    properties: input.properties ?? {}
  });
  // M25.4 (ADR-0041) — the same door, the same closing. Hand-fill is the second half of the
  // `federationImport` two-module census, and it is a LOCAL operator keying a document in by hand:
  // there is no bundle a 400 could wedge, and exempting it would hand every `federation:write`
  // holder an unvalidated write to `campaign.properties.recipe`.
  assertValidCampaignRecipe({
    typeId: input.typeId,
    properties: input.properties ?? {}
  });
  await assertGovernanceAuthorityForHandFill(tx, input);
  assertEnforceableDependencySubscriptionScope({
    typeId: input.typeId,
    properties: input.properties
  });
  // M21.5 — the same door, the same closing. `handFillObject` wears the `federationImport` flag that
  // exempts the choke point, so both dependency-subscription authoring refusals must be called here
  // explicitly or a `federation:write` holder has the bypass they exist to close.
  await assertNoDelegatedDependencyUpdates(tx, {
    orgId: input.orgId,
    typeId: input.typeId,
    properties: input.properties
  });
  // The same door, the same closing, another guard. See docs/federation.md §242.
  assertScanOverrideGrantNotSelfDecided({
    typeId: input.typeId,
    properties: input.properties ?? {}
  });
  // THE GOVERNANCE-LABEL NAMESPACE. See docs/federation.md §243.
  assertSelectorKeysAreGovernanceLabels({
    typeId: input.typeId,
    properties: input.properties
  });
  // WHY `assertPolicyScopeWithinAuthority` IS NOT ALSO CALLED HERE. See docs/federation.md §244.
  await assertMayWriteGovernanceLabels(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    // A hand-fill is an upsert, so an EXISTING row's governance labels are also reachable here; the
    // stored value is the honest `before`, and `{}` would silently permit a removal on the update
    // branch while refusing an identical no-op create.
    before:
      ((
        await tx.query.objects.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(t.orgId, input.orgId), eqOp(t.urn, input.urn))
        })
      )?.labels as Record<string, unknown> | undefined) ?? {},
    after: input.labels ?? {},
    subject: `hand-filled ${input.typeId} '${input.urn}'`
  });
  // THE ESTATE-AUTHORING BAR. See docs/federation.md §245.
  await assertObjectWriteAuthorityForHandFill(tx, input);
  const peer = await getPeerByIdOrName(tx, input.orgId, input.peerIdOrName);
  const { object } = await upsertObjectByUrn(tx, {
    orgId: input.orgId,
    typeId: input.typeId,
    actorObjectId: FEDERATION_IMPORT_ACTOR_ID,
    requestId: `federation-handfill:${input.urn}`,
    urn: input.urn,
    name: input.name,
    properties: input.properties,
    labels: input.labels,
    federationImport: { originDomainId: peer.id, revision: 0, provenance: "manual" }
  });
  return object;
}

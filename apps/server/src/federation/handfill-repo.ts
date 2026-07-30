import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { badRequest } from "../errors.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import { isPeerBoundObjectType } from "./outpost-binding.js";
import { ensureFederationSelf } from "./self-repo.js";

/**
 * Hand-fill for air-gapped outposts with no bundle transport at all (DESIGN.md §13): "manually
 * entered commander-origin objects are stored as `provenance: manual` shadow copies, flagged as
 * unverified in API and UI, and reconciled (confirmed or replaced) the next time a signed bundle
 * arrives."
 *
 * Reconciliation happens FOR FREE through the exact same single-writer-authority machinery a real
 * import uses (graph/objects-repo.ts): a hand-filled row is created here with
 * `federationImport: { originDomainId: <claimed commander's id>, revision: 0, provenance: 'manual' }`
 * — revision 0 so ANY later real import (which always carries `revision >= 1`) is guaranteed to
 * be treated as newer and overwrite it, and `originDomainId` already matches the peer the operator
 * claimed it came from, so the single-writer authority check in `updateObject` passes and the
 * `provenance` column naturally clears to `null` on that overwrite (a real, cryptographically
 * verified update always passes `provenance: null`). No separate "reconcile" code path exists
 * because none is needed — this IS the reconciliation mechanism, just invoked implicitly by the
 * next ordinary import.
 */
export interface HandFillInput {
  orgId: string;
  peerIdOrName: string;
  typeId: string;
  urn: string;
  name: string;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
}

/**
 * THE FIFTH LOCAL WRITE DOOR, AND WHY IT NEEDS ITS OWN NARROWING (M16.2 phase A, review round 4).
 *
 * `handFillObject` is a free-form-`typeId` write door reachable by any `federation:write` operator, and
 * it stamps `federationImport`. That flag is what makes `graph/objects-repo.ts`'s peer-binding choke
 * point SKIP — a skip whose whole justification is "a replica's `peerDomainId` names the RECEIVING
 * instance's own domain, which is never one of its peers". That is true of the OUTPOST-side use and
 * FALSE of the COMMANDER-side one, where the operator supplies `properties.peerDomainId` freely. With
 * the blanket skip, hand-fill bypassed all three clause-(4) refusals: it accepted an UNPAIRED
 * `peerDomainId`, a `commander`-role peer (whose tier `GET /v1/federation/status` then reported), and a
 * SECOND live `outpost` object for a peer that already had a legitimate one — which then made the
 * commander's own `PATCH /v1/federation/outposts/{peer}` 409 forever.
 *
 * THE NARROWING, and why it is a self-comparison rather than the full guard. Applying
 * `assertOutpostPeerBinding` to every `federationImport` write is NOT safe: a genuine sync bundle can
 * legitimately carry the `outpost` object of a DIFFERENT outpost (commander → outpost A, full scope,
 * carrying outpost B's config), whose `peerDomainId` is not a peer of the receiver — refusing it would
 * abort the whole bundle (the fail-closed version-skew class this same review round fixed for
 * `additionalProperties`). So the JOURNAL path keeps the skip, and the narrowing lives HERE, at the one
 * other `federationImport` caller: a hand-filled peer-bound object may name ONLY this instance's own
 * `federation_self.domainId` — exactly the shape a real replica has, and the only shape the skip's
 * justification actually covers. Anything else is a commander-side claim about one of its peers, which
 * has a real door (`POST /v1/federation/outposts`) that enforces the binding.
 *
 * CENSUS (kept filterless on purpose): `federationImport` is supplied in exactly two modules —
 * `federation/import-repo.ts` (signature/chain-verified journal replay) and this one. There is no third.
 */
async function assertHandFillableType(tx: TenantTx, input: HandFillInput): Promise<void> {
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

export async function handFillObject(tx: TenantTx, input: HandFillInput): Promise<GraphObject> {
  await assertHandFillableType(tx, input);
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

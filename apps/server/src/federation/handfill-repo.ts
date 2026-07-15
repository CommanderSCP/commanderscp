import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { getPeerByIdOrName } from "./peers-repo.js";
import { upsertObjectByUrn } from "../graph/objects-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";

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

export async function handFillObject(tx: TenantTx, input: HandFillInput): Promise<GraphObject> {
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

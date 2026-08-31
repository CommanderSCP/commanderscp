import { and, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationUnattachedChangeStatus } from "../db/schema.js";

/**
 * UNATTACHED PEER CHANGE STATUS (drizzle/0040) — the federation-layer store that
 * `federation/import-repo.ts`'s `change_status` branch has named in its own comment as the missing
 * feature ever since M6: *"Carrying it honestly needs a federation-layer store for unattached peer
 * status."*
 *
 * WHAT IT RECORDS. A `change_status` entry is POSITIVE EVIDENCE that a change exists and is moving
 * on the peer — it names `payload.objectId` and a lifecycle state. Two import-side chokepoints drop
 * it:
 *
 *   (a) `no_local_replica` — the entry was admitted by this receiver's scope filter, but this
 *       domain holds no replica of `payload.objectId`. That is the NORMAL shape when the SENDER
 *       ships change status without the change's `object_upsert` (a `status_only` export), and a
 *       transient one at wider scopes when the status entry precedes the object it refers to.
 *   (b) `receiver_scope` — this receiver's OWN `entryMatchesScope` discarded the entry.
 *
 * WHY IT EXISTS: THE SENDER/RECEIVER SCOPE MISMATCH. `federation_peers.sync_scope` is purely local
 * per-peer config. It is written by `pairPeer` and read only by export filtering, import
 * defense-in-depth, and the board — it NEVER rides the wire, and the two sides' values are set
 * independently by two operators and never reconciled. So a caveat derived from the RECEIVER's own
 * scope is blind to the case where the SENDER is the narrow side: commander exports `status_only`,
 * outpost receives at `changes_only`, and the outpost's scope predicate cheerfully says "I can see
 * change objects" while none is ever shipped. The drop recorded HERE happens downstream of BOTH
 * scopes, so it fires on that mismatch exactly as it fires on the receiver-scope case.
 *
 * GRAIN: (peer, change object), NOT (component). Stated plainly because the limitation is
 * load-bearing for how the board renders it. Neither `change_status` payload shape carries
 * `targets` — propose sends `{objectId, urn, name, state, sourceKind, sourceRef, emergency,
 * importedFromDomain, rollbackOfObjectId}`, transition sends `{objectId, fromState, toState,
 * trigger, reason, importedFromDomain}` — and the change urn (`urn:scp:{org}:change:{slug(name)}`)
 * encodes nothing about targets. The only entry that carries `properties.targets` across a boundary
 * is the change's own `object_upsert`, which is precisely the entry that was withheld. So at import
 * time this domain holds an object id and a state and nothing that resolves a component, and the
 * board's caveat must stay BOARD-LEVEL. Widening the propose-time payload with `targets` would buy
 * per-component attribution and is wire-safe (entry payloads are `z.record(z.string(), z.unknown())`
 * passthrough and the rowHash canonicalizes deep-sorted, so an un-upgraded importer still verifies
 * and simply ignores the extra key) — but it would disclose target component ids to a peer scoped
 * precisely to withhold graph content. That is an owner decision; see drizzle/0040's header.
 *
 * SELF-CLEARING. {@link clearUnattachedChangeStatus} runs from the `object_upsert` path, so once the
 * change object actually lands the evidence resolves and the caveat stops firing. Combined with the
 * upsert key that makes a from-genesis re-sync converge rather than accumulate, the mechanism can
 * never fabricate persistent ignorance — the property that separates it from a counter.
 */

export type UnattachedDropReason = "no_local_replica" | "receiver_scope";

export interface UnattachedChangeStatusRow {
  peerDomainId: TrustDomainId;
  changeObjectId: string;
  urn: string | null;
  name: string | null;
  lastState: string | null;
  dropReason: UnattachedDropReason;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Upsert one dropped `change_status` entry. Idempotent on (org, peer, change object): re-importing
 * the same journal segment from genesis converges on one row rather than accumulating.
 *
 * `urn`/`name` are COALESCEd, never overwritten with null — they ride only the propose payload, so
 * a later transition entry for the same change must not erase the naming the propose gave us.
 * `lastState` is COALESCEd for the same reason and NOT, as this said before, an overwrite: a
 * malformed entry whose payload carries no parseable state (`import-repo.ts`'s
 * `reportedChangeState` returns null whenever `toState`/`state` is not a string) must not blank a
 * state we already read correctly. A real transition always carries one, so the ordinary
 * `proposed -> accepted` reading still lands.
 *
 * `dropReason` alone DOES overwrite: it is not nullable and it describes THIS entry's drop, so the
 * latest reading is the only correct one.
 */
export async function recordUnattachedChangeStatus(
  tx: TenantTx,
  input: {
    orgId: string;
    peerDomainId: TrustDomainId;
    changeObjectId: string;
    urn?: string | null;
    name?: string | null;
    lastState?: string | null;
    dropReason: UnattachedDropReason;
  }
): Promise<void> {
  await tx
    .insert(federationUnattachedChangeStatus)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.peerDomainId,
      changeObjectId: input.changeObjectId,
      urn: input.urn ?? null,
      name: input.name ?? null,
      lastState: input.lastState ?? null,
      dropReason: input.dropReason
    })
    .onConflictDoUpdate({
      target: [
        federationUnattachedChangeStatus.orgId,
        federationUnattachedChangeStatus.peerDomainId,
        federationUnattachedChangeStatus.changeObjectId
      ],
      set: {
        urn: sql`coalesce(excluded.urn, ${federationUnattachedChangeStatus.urn})`,
        name: sql`coalesce(excluded.name, ${federationUnattachedChangeStatus.name})`,
        lastState: sql`coalesce(excluded.last_state, ${federationUnattachedChangeStatus.lastState})`,
        dropReason: sql`excluded.drop_reason`,
        lastSeenAt: sql`now()`
      }
    });
}

/**
 * Resolve the evidence for one change: the change's graph object finally landed locally, so this
 * domain is no longer blind to it and the row must go. Called from the `object_upsert` import path.
 *
 * This is the half that makes the signal honest in the OTHER direction — without it, a single
 * out-of-order `change_status` (status entry ahead of its object, which happens at every scope wide
 * enough to ship both) would leave a permanent row claiming an ignorance that resolved seconds
 * later.
 */
export async function clearUnattachedChangeStatus(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  changeObjectId: string
): Promise<void> {
  await tx
    .delete(federationUnattachedChangeStatus)
    .where(
      and(
        eq(federationUnattachedChangeStatus.orgId, orgId),
        eq(federationUnattachedChangeStatus.peerDomainId, peerDomainId),
        eq(federationUnattachedChangeStatus.changeObjectId, changeObjectId)
      )
    );
}

/**
 * The board's read: unattached evidence whose last reported state is one of `states` — i.e. changes
 * this domain KNOWS are moving on a peer and cannot attribute to anything local.
 *
 * Conditioned on state, not merely on existence, so a board does not claim ignorance forever
 * because of one change that completed last quarter. Index-backed on
 * `(org_id, last_state)`; `limit` bounds it because the caller only needs "is there any", plus
 * enough rows to name the peers for an operator.
 */
export async function listUnattachedChangeStatusInStates(
  tx: TenantTx,
  orgId: string,
  states: string[],
  limit = 50
): Promise<UnattachedChangeStatusRow[]> {
  if (states.length === 0) return [];
  const rows = await tx
    .select()
    .from(federationUnattachedChangeStatus)
    .where(
      and(
        eq(federationUnattachedChangeStatus.orgId, orgId),
        inArray(federationUnattachedChangeStatus.lastState, states)
      )
    )
    .limit(limit);
  return rows.map((row) => ({
    peerDomainId: row.peerDomainId,
    changeObjectId: row.changeObjectId,
    urn: row.urn,
    name: row.name,
    lastState: row.lastState,
    dropReason: row.dropReason as UnattachedDropReason,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  }));
}

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, objects } from "../db/schema.js";
import { badRequest, conflict } from "../errors.js";

/**
 * M16.2 phase A (E1) — THE AUTHORITY-SPLIT RULE, and the one choke point that enforces it.
 *
 * ============================================================================================
 * THE RULE (normative; `outpost-object.integration.test.ts` checks every clause of it)
 * ============================================================================================
 * After this increment "an outpost" exists TWICE in a commander's database, and the two halves own
 * DISJOINT, NON-OVERLAPPING sets of facts:
 *
 *  (1) THE `federation_peers` ROW (+ `federation_peer_keys`) IS THE SOLE AUTHORITY FOR TRANSPORT
 *      IDENTITY AND REACHABILITY: the peer's trust-domain id, its Ed25519 signing key and cosign
 *      verification key (with their sequence-anchored windows), `base_url`, `sync_scope`,
 *      `delivery_target`, `poke_mode`, and the scheduler's per-peer timestamps. It is LOCAL and
 *      PER-SIDE: it never rides the sync journal, is never reconciled with the other side, and is
 *      operationally load-bearing (the exporter, the puller, the poke sender and every signature
 *      verification read it and nothing else). Its only write doors are `POST /v1/federation/peers`
 *      (pair/re-pair, the only door that may touch key material) and
 *      `PATCH /v1/federation/peers/{id}` (transport only, structurally keyless).
 *
 *  (2) THE `outpost` GRAPH OBJECT IS THE SOLE AUTHORITY FOR COMMANDER-DECLARED CONFIG ABOUT THAT
 *      OUTPOST: today `trustTier`, plus the `peerDomainId` that binds it to (1). It is
 *      commander-origin, rides `object_upsert` on the sync journal, and lands at the outpost as a
 *      READ-ONLY REPLICA (`objects-repo.ts`'s single-writer guard). Its write doors are
 *      `POST/PATCH /v1/federation/outposts…`, and — for a future IaC manifest — the plan-apply path,
 *      which resolves `federation:write` for this type rather than plain `object:write`.
 *
 *  (3) NEITHER MAY EXPRESS THE OTHER'S FIELDS, structurally rather than by convention:
 *        * no transport field is REPRESENTABLE in the object — the registered type's JSON Schema is
 *          `additionalProperties: false` over exactly `{peerDomainId, trustTier}` (drizzle/0043), and
 *          the create/update request bodies carry no transport field at all;
 *        * no declared-config field is REPRESENTABLE on the peer row — there is no trust-tier column,
 *          and the PATCH body admits only `{name, baseUrl, syncScope, deliveryTarget, pokeMode}`.
 *      Consequence, and the shape the tests assert in BOTH directions: a config write leaves
 *      `federation_peers`/`federation_peer_keys` untouched and appends exactly one journal entry; a
 *      transport write leaves the object's `version`/`revision` untouched and appends NO journal
 *      entry at all (F1 — peer state cannot ride the journal, by construction).
 *
 *  (4) THE PEER ROW IS THE ANCHOR; THE BINDING IS 1:1 AND OBJECT→PEER ONLY. An `outpost` object must
 *      name an already-paired peer that holds role `outpost` (an unbound `peerDomainId` is a 400); a
 *      second object for the same peer is a 409. The object never creates, mutates, or is required
 *      by the peer row — deleting nothing and blocking nothing. Federation works exactly as before
 *      for a peer that has no `outpost` object; the object only adds declared config.
 *
 *  (5) TIE-BREAK, when both halves could seem to answer one question: THE PEER ROW WINS for anything
 *      about reachability. "Is this outpost air-gapped?" is derived from `base_url`/`delivery_target`
 *      on the peer row — never from `trustTier`, which is why connectivity is deliberately NOT a
 *      trust tier (one field meaning both trust posture and reachability would mean neither).
 * ============================================================================================
 *
 * WHERE THIS IS ENFORCED, AND WHY HERE. Clause (4) is checked in ONE place — `graph/objects-repo.ts`'s
 * `createObject`/`updateObject`, for LOCAL-ORIGIN writes only — rather than at each route. Guarding
 * routes one at a time is precisely the incomplete-call-site-census failure this project keeps
 * hitting: the free-form-`typeId` local write doors are the generic `/objects/{type}` endpoints, the
 * IaC plan-apply path, the federation OVERLAY route, and `POST /discovery/{...}/accept`, and any
 * future door would silently be a fifth. Sitting inside the repo write path covers all of them and
 * everything added later.
 *
 * IMPORT PATHS STAY PERMISSIVE BY CONSTRUCTION, and must: the check is skipped whenever
 * `federationImport` is set. At the OUTPOST, the arriving replica names the outpost's OWN domain id
 * as `peerDomainId` — which is deliberately NOT in that instance's `federation_peers` (an instance is
 * not its own peer), so applying clause (4) to a replica would refuse every legitimate sync. Hand-fill
 * (`handfill-repo.ts`) always stamps a FOREIGN origin through the same `federationImport` channel, so
 * it is covered by the same skip, exactly as the journal-replay path is.
 */

/** Object types whose objects must be bound to a paired federation peer. A ReadonlySet so the guard
 *  generalizes if a second peer-bound type ever appears, rather than hard-coding `"outpost"` at each
 *  call site (the `service-member-types.ts` convention). */
export const PEER_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["outpost"]);

export function isPeerBoundObjectType(typeId: string): boolean {
  return PEER_BOUND_OBJECT_TYPE_IDS.has(typeId);
}

/** The federation role a peer must hold to be the subject of an `outpost` config object. `retrans`
 *  and `commander` peers are refused: an `outpost` object asserting a trust tier about the commander
 *  this instance reports UP to is nonsense, and silently accepting it would put declared config on a
 *  peer no outpost UI will ever render. */
const REQUIRED_PEER_ROLE = "outpost";

/**
 * Clause (4) of the rule above, for one local-origin `outpost` write. Throws `badRequest` when the
 * binding is missing/unbound/wrong-role and `conflict` when another live object already claims the
 * peer. `objectId` is the id being written — excluded from the duplicate scan so an UPDATE of an
 * existing object never conflicts with itself.
 */
export async function assertOutpostPeerBinding(
  tx: TenantTx,
  input: { orgId: string; objectId: string; properties: Record<string, unknown> }
): Promise<void> {
  const raw = input.properties.peerDomainId;
  if (typeof raw !== "string" || raw.length === 0) {
    throw badRequest(
      "an 'outpost' object must carry properties.peerDomainId — the trust-domain id of the already-paired peer it describes"
    );
  }
  const peerDomainId = raw;

  const peerRows = await tx
    .select({ id: federationPeers.id, role: federationPeers.role })
    .from(federationPeers)
    // BOUNDARY (ADR-0021 D4): `properties.peerDomainId` names a PEER'S FEDERATION IDENTITY — the
    // TRUST sense — which is exactly what `federation_peers.id` holds. This lookup is where the
    // operator-supplied string is asserted to be that, and it fails closed one line below if it is
    // not actually a paired peer.
    .where(
      and(
        eq(federationPeers.orgId, input.orgId),
        eq(federationPeers.id, asTrustDomainId(peerDomainId))
      )
    )
    .limit(1);
  const peer = peerRows[0];
  if (!peer) {
    // FAIL-CLOSED on the anchor: config about a peer this instance has never paired with has no
    // transport to ride down and no identity to be verified against. Refuse rather than store a
    // dangling assertion that would look configured in a UI.
    throw badRequest(
      `peerDomainId '${peerDomainId}' is not a paired federation peer — pair it first ` +
        `('scp federation pair'), then declare its outpost config`
    );
  }
  if (peer.role !== REQUIRED_PEER_ROLE) {
    throw badRequest(
      `peer '${peerDomainId}' has federation role '${peer.role}', not '${REQUIRED_PEER_ROLE}' — ` +
        `an 'outpost' config object may only describe a peer this instance holds as an outpost`
    );
  }

  const clashing = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, input.orgId),
        eq(objects.typeId, "outpost"),
        isNull(objects.deletedAt),
        ne(objects.id, input.objectId),
        // The binding lives in the object's JSONB properties (graph-native: no new column), so the
        // uniqueness scan is a JSONB text comparison. Bounded by the number of outpost objects in
        // the org — one per enrolled outpost, i.e. tens at most.
        sql`${objects.properties} ->> 'peerDomainId' = ${peerDomainId}`
      )
    )
    .limit(1);
  if (clashing[0]) {
    throw conflict(
      `peer '${peerDomainId}' already has an outpost config object ('${clashing[0].id}') — ` +
        `the binding is one-to-one; PATCH that object instead of declaring a second one`
    );
  }
}

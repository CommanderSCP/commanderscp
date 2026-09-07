import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, objects } from "../db/schema.js";
import { badRequest, conflict } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";

/** The authority-split rule, and the choke point enforcing it. See docs/federation.md §309. */

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

/** The federation role THIS instance must hold (`federation_self.role`) to author the HQ
 *  outpost record (§10.5) — the record about its own trust domain. Only a commander declares outpost
 *  config (clause (2)); on an outpost that record is the commander's replica, and a local one authored
 *  ahead of it would outrank the replica in every `byAuthority` read (see the check below). */
const SELF_BINDING_ROLE = "commander";

/** Clause four of that rule, for one local-origin write. See docs/federation.md §310. */
export async function assertOutpostPeerBinding(
  tx: TenantTx,
  input: {
    orgId: string;
    objectId: string;
    properties: Record<string, unknown>;
    /** Set by the UPDATE half of the choke point only (review round 4, H1). See the note on the clash
     *  scan below: an UNVERIFIED hand-filled shadow must not be able to VETO an edit to the row that
     *  actually holds authority — that veto WAS the unrecoverable wedge. A CREATE stays strict, so the
     *  create door can never grow a second live claimant in the first place. */
    ignoreUnverifiedClash?: boolean;
  }
): Promise<void> {
  const raw = input.properties.peerDomainId;
  if (typeof raw !== "string" || raw.length === 0) {
    throw badRequest(
      "an 'outpost' object must carry properties.peerDomainId — the trust-domain id of the already-paired peer it describes, or this instance's own domain id for the HQ outpost (the outpost in this instance's own trust domain)"
    );
  }
  const peerDomainId = raw;

  // §10.5 — THE HQ OUTPOST. See docs/federation.md §311.
  const self = await ensureFederationSelf(tx, input.orgId);
  const isSelf = peerDomainId === (self.domainId as string);
  if (isSelf && self.role !== SELF_BINDING_ROLE) {
    throw badRequest(
      `peerDomainId '${peerDomainId}' is this instance's own trust domain, but this instance's ` +
        `federation role is '${self.role}', not '${SELF_BINDING_ROLE}' — an outpost's own record is ` +
        `commander-declared and arrives replicated from the commander; declare it there ` +
        (self.role === "unset"
          ? `(or designate this instance's role first: 'scp federation init --role commander')`
          : `('scp federation outpost declare --peer ${peerDomainId}' at the commander)`)
    );
  }

  const peerRows = isSelf
    ? []
    : await tx
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
  if (!isSelf && !peer) {
    // FAIL-CLOSED on the anchor: config about a peer this instance has never paired with has no
    // transport to ride down and no identity to be verified against. Refuse rather than store a
    // dangling assertion that would look configured in a UI. The copy names BOTH accepted shapes.
    throw badRequest(
      `peerDomainId '${peerDomainId}' is neither a paired federation peer nor this instance's own ` +
        `trust domain ('${self.domainId}') — an 'outpost' config object may name a paired peer of role ` +
        `'${REQUIRED_PEER_ROLE}' (pair it first: 'scp federation pair') or this instance's own domain id ` +
        `(GET /federation/self) for the HQ outpost`
    );
  }
  if (peer && peer.role !== REQUIRED_PEER_ROLE) {
    throw badRequest(
      `peer '${peerDomainId}' has federation role '${peer.role}', not '${REQUIRED_PEER_ROLE}' — ` +
        `an 'outpost' config object may only describe a peer this instance holds as an outpost, or ` +
        `this instance's own trust domain ('${self.domainId}') as the HQ outpost`
    );
  }

  const clashing = await tx
    .select({ id: objects.id, provenance: objects.provenance })
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
    .orderBy(asc(objects.createdAt), asc(objects.id));
  // An unverified shadow is not an authority and gets no veto. See docs/federation.md §312.
  const blocking = input.ignoreUnverifiedClash
    ? clashing.filter((row) => row.provenance !== "manual")
    : clashing;
  if (blocking[0]) {
    const unverified = blocking[0].provenance === "manual";
    throw conflict(
      `peer '${peerDomainId}' already has an outpost config object ('${blocking[0].id}') — ` +
        `the binding is one-to-one; PATCH that object instead of declaring a second one` +
        (unverified
          ? `. That object is an UNVERIFIED hand-filled shadow copy: POST ` +
            `/v1/federation/outposts/${peerDomainId}/reconcile adopts it as this domain's own config ` +
            `(or removes it when an authoritative row already exists)`
          : "")
    );
  }
}

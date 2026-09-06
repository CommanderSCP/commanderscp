# outposts-repo

Reference for `apps/server/src/federation/outposts-repo.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE RECOVERY DOOR

THE RECOVERY DOOR (review round 4) — `POST /v1/federation/outposts/{peerDomainId}/reconcile`.

WHY IT EXISTS. Before the hand-fill narrowing, `POST /v1/federation/hand-fill` could plant a second live `outpost` object for a peer that already had a legitimate one. That left the peer UNRECOVERABLE THROUGH THE API: the commander's own `PATCH /v1/federation/outposts/{peer}` 409'd forever ("already has an outpost config object" / "read-only replica"), `DELETE /api/v1/objects/outpost/{id}` is 403 by this milestone's own refusal, and no delete verb for the config existed. An unrecoverable state reachable by a supported action is the one-way-ratchet failure class this project has already paid for (PR #149), so the door is closed AND the existing wedge is made fixable — a database wedged by an older build must be repairable without SQL.

WHAT IT DOES, and nothing more: * keeps the single most authoritative row for the peer (`byAuthority`); * when NO authoritative row exists but an UNVERIFIED shadow does, ADOPTS the first shadow as this domain's own object (`unverifiedShadowOverride` — origin re-stamped, `provenance` cleared, and it journals from then on like any local object), so the operator's entered config is not thrown away; * SOFT-DELETES every remaining unverified shadow for that peer, restoring the 1:1 binding — a silent local cleanup, reported as `removedShadowObjectIds`; * with `?keep=` naming a row THIS domain authored as the survivor (N9 below), also soft-deletes any OTHER locally-authored surplus row for that peer — an ordinary JOURNALED TOMBSTONE that propagates downstream, reported SEPARATELY as `removedLocalObjectIds` so the caller cannot describe it as a shadow tidy-up (review round 6, M1 — the two cases produce different output on every surface).

WHAT IT REFUSES. A VERIFIED foreign-origin replica is never adopted and never DELETED: deleting one would make the next real import a single-writer violation and wedge that peer's sync — trading one unrecoverable state for a worse one. Two verified rows for one peer therefore stay a 409 and are reported as such, which is an honest authority conflict rather than a silent pick.

`keepObjectId` — THE VERIFIED-DUPLICATE ESCAPE (review round 5, N9). Without it, a VERIFIED foreign-origin duplicate bound to one peer had NO public-API recovery AT ALL: `PATCH` 409s (the binding scan's `blocking` filter exempts only `provenance='manual'`), the default reconcile refuses by design, `DELETE /objects/outpost/{id}` is 403, and IaC prune only touches stack-managed objects — and the refusal message named an action the API did not offer. That state is NOT reachable today (in canonical hub-and-spoke, no bundle a commander imports carries an `outpost` row bound to one of ITS peers) but becomes reachable the moment two authoring domains describe one outpost — hierarchical sub-commanders, or a dual-homed outpost. Naming the row to KEEP lets the operator resolve the authority conflict the only way that is actually safe: this domain DELETES THE ROW IT AUTHORED ITSELF, which is an ordinary local tombstone that journals normally and can be re-declared at any time. The refusal to delete a signature-verified replica is unchanged and unconditional — that half is what stops this from trading the wedge for a sync wedge.

## §2. 409, NOT 404

409, NOT 404 (review round 5, N3). This branch fires when the peer DEMONSTRABLY HAS config — `GET /v1/federation/outposts/{peer}` answers 200 for the very same peer at the same instant — so answering 404 told a status-keyed consumer "no outpost config" and HID the authority conflict on the one door that exists to recover from it. The route's own response map already declared 409 and the schema comment already called this a "409-shaped notFound"; the code is now the shape it always described. 404 stays for the genuinely-no-rows branch above, which is the only branch where the resource really is absent. THE MESSAGE NAMES AN ACTION THE API ACTUALLY OFFERS (review round 5, N9). It previously said "resolve the authority conflict at its source" — advice, not a verb, on a door whose whole purpose is to be the verb.

## §3. Edits the commander-origin config

Edits the commander-origin config. ABSENT MEANS PRESERVE for every field — an omitted `trustTier` never clears an asserted one, and (phase A) there is no clear-to-unknown verb at all: un-asserting a tier is a distinct, deliberate operation, and inventing it as a side effect of an omitted field is exactly how a UI silently erases an operator's assertion.

ON AN OUTPOST THIS CALL FAILS, and that is the point: the object there is a read-only replica, so `updateObject`'s existing single-writer guard raises 409 before any of this module's logic runs (proved by `outpost-config-sync.integration.test.ts`). No second mechanism was added for it.

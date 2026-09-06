# federation

Reference for `packages/schemas/src/federation.ts`. The source carries a one-line headline at each site and points here.

> Partial: 12 of 43 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE RECONCILE PRECONDITION TOKEN

THE RECONCILE PRECONDITION TOKEN — one `objectId:version` pair per live claimant the caller PREVIEWED, sent as the repeatable `?ifClaimant=` query parameter (optimistic concurrency).

WHY A PAIR AND NOT A BARE ID. Reconcile's outcome is derived from the set of live `outpost` rows bound to one peer, read INSIDE the write transaction — i.e. after whatever the caller previewed. Three things can change in that window and all three change the outcome: * a claimant APPEARS — a new id enters the set (a locally-authored row can then outrank the shadow the operator meant to adopt, silently DROPPING their entered value); * a claimant DISAPPEARS — an id leaves the set (soft-deleted elsewhere); * a claimant's ORIGIN/PROVENANCE CHANGES — the id is UNCHANGED, so ids alone are blind to it, yet a shadow adopted in the meantime is no longer a shadow and no longer ranks last. `version` catches the third: every writer of `objects` that can restamp `originDomainId` or clear `provenance` bumps `version` unconditionally (`graph/objects-repo.ts` — adoption is `updateObject` with `existing.version + 1`). `revision` would NOT do: it is AUTHOR-assigned on the import path, so it is not locally monotone.

Both halves are already on `OutpostConfigSchema`, so the token is constructible from exactly the array `GET /federation/outposts` returned — no second fetch, no new read-side field, and the request stays CHECKABLE against the preview that was rendered beside it (which an opaque digest or a server-minted ETag would not be).

## §2. THE STALE-PRECONDITION REFUSAL BODY

THE STALE-PRECONDITION REFUSAL BODY — `412 Precondition Failed` from `POST /federation/outposts/{peer}/reconcile` when the `?ifClaimant=` set does not match the live claimants read inside the transaction.

412, NOT A SECOND 409. The 409 on this route is the AUTHORITY CONFLICT and it is PERMANENT until the operator chooses differently (`?keep=`); staleness is TRANSIENT and retryable after a re-preview. Collapsing both onto one status turns "choose differently" into "look again, then press the same button" — and consumers here key on status alone. 412 is also already the house's optimistic-concurrency refusal (`updateObject`'s `expectedVersion`). NOT 428: the precondition is optional by design, so the server must never demand one.

`claimants` IS THE POINT. A bare refusal would force a second read and open a second window; the refusal carries the FRESH claimant list so a caller CAN re-render a real preview from the same response, then re-issue with a fresh token, without a second read. It is an RFC 9457 extension member, like the in-house `decision_id`.

NOT EVERY CALLER TAKES THAT OFFER (R3, PR #156 residual). `scp federation outpost reconcile` (`packages/cli/src/cli.ts`) does: it re-previews straight from this body. The Outposts web panel (`apps/web/src/routes/outpost-configuration.tsx`) does not — it treats the 412 as a signal to refetch the list instead, deliberately paying the second round trip this field exists to save.

## §3. M16.2 phase A (E4) — THE NARROW PEER PATCH

M16.2 phase A (E4) — THE NARROW PEER PATCH. `POST /federation/peers` (pair/re-pair) is the only peer write there was, and it is a FOOTGUN for a settings form: `publicKey` is REQUIRED there, and a DIFFERENT value is treated as a KEY ROTATION that supersedes the current key window and hard-revokes the old key (sequence-anchored, `peers-repo.ts`). A UI that round-trips a peer and re-pairs it therefore rotates the peer's trust anchor whenever it drops or mangles the key.

This request body admits NO KEY MATERIAL AT ALL — not `publicKey`, not `cosignPublicKey` — so the PATCH route is STRUCTURALLY incapable of rotating, superseding or revoking a peer key. `role` is likewise absent: a peer's federation role is an identity-level assertion established at pairing, not a settings-form field. Every field is optional and ABSENT MEANS PRESERVE (the same tri-state discipline re-pair uses); `deliveryTarget: null` explicitly CLEARS back to the instance-env fallback. Key rotation stays exactly where it was — a deliberate re-pair.

## §4. M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY

M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY. Every field below is optional/additive and nullable ("no observation"), and every NAME says what it MEASURES.

THE ONE-SIDED DERIVATION (the reason there is no `appliedAtPeer` field here, and never will be until M16.4 builds one): `sync_cursors` records only what WE applied FROM a peer, never what a peer applied FROM US; `export-repo.ts` ships only this domain's own entries, so a return bundle cannot carry our sequences back; and `bundle_transfers` has no production UPDATE path, so every EXPORT row is inserted `created` and never advances. The strongest honest commander-side statement is therefore PENDING-EXPORT — "this much of my own journal has not been put into a bundle addressed to that peer yet" — which says NOTHING about what the peer applied. A field named for application at the peer would be a fabrication, so there isn't one.

## §5. THE CONFIGURED TRANSPORT CHANNEL

THE CONFIGURED TRANSPORT CHANNEL — config-derived, never an observation, and named for that (review round 4 replaced a `connectivity` field whose `"connected"` value asserted reachability this instance had not observed). `"dialable"` = an https/mTLS `baseUrl` is configured, so this side MAY dial the peer — it does NOT mean the peer has ever been reached; `lastPullAttemptAt`/ `lastPullSuccessAt`/`effectiveCadence` in this same row are the observations, and they do reflect failure. `"air-gap"` = NO base URL and a configured `deliveryTarget` (a file/object channel). `null` = not honestly derivable, declared in `unknownFields`, in two cases: no transport configured at all, or a base URL federation refuses to dial (plain http) — which is a contradictory configuration to surface, not an air-gap posture to infer.

## §6. DIVERGENCE RAIL 2

DIVERGENCE RAIL 2 (multi-region-instance-resilience.md §7.2) — the puller's cursor anchor: the `rowHash` of the entry it has applied AT `sinceSequence`. The exporter compares it against its OWN journal row at that sequence and refuses (`journal_divergence`) on mismatch — proof its tail was rolled back and re-minted after an async-replication failover. Additive & OPTIONAL: only FULL-scope receivers hold a real anchor (a sparse receiver's cursor `rowHash` is null and it omits this), and an un-upgraded puller simply never sends it (rail 1 still covers the strict `sinceSequence > tail` case with no new wire data).

## §7. The `journal_divergence` 409 body

The `journal_divergence` 409 body. Extension members carry the exporter's OWN tail at the moment of refusal so an operator (or `scp federation doctor`) can see how far the fork/rollback reaches in one round trip. OPTIONAL, never required (the PR #156 lesson `OutpostReconcileStaleProblemSchema` records: a REQUIRED extension a throw path fails to populate turns a valid 409 into a serializer 500). Rails 1, 2, and 4 all refuse with this shape.

## §8. The `.scpbundle` envelope (DESIGN §13 file transport)

The `.scpbundle` envelope (DESIGN §13 file transport). Deliberately NOT a tar/zip archive — see federation-journal.ts's module doc for the robustness rationale — a single bounded, checksummed, signed JSON document instead.

## §9. DIVERGENCE RAIL 4

DIVERGENCE RAIL 4 (multi-region-instance-resilience.md §7.2) — the exporter's SIGNED attestation of its OWN journal tail, carried on EVERY export (even an empty one). Signed over `{exporterDomainId, peerDomainId, tailSequence, tailRowHash}` with the same instance key the bundle uses — the domain ids are bound in so an attestation cannot be replayed onto another bundle. The importer persists it as a MONOTONIC high-water mark per (peer, origin) and refuses `journal_divergence` on any regression or same-height content change — which is what makes a lost/rolled-back tail detectable for a NARROW-scope peer, where rails 1–3 are silent.

## §10. §7.2.6 RESYNC — the SIGNED CROSS-DOMAIN HANDSHAKE

§7.2.6 RESYNC — the SIGNED CROSS-DOMAIN HANDSHAKE. The IMPORTER (the diverged side) sends this to the exporter's `POST /federation/resync`. `requestSignature` is the importer's signature over a canonical `{resync:true, importerDomainId, exporterDomainId}` payload, made with the importer's own instance key — the exporter verifies it against the importer's paired public key, so the request authenticates the importer authorizing a forced overwrite of ITS OWN replica. `peer` is the importer's own domain id (how the exporter knows it as a peer).

## §11. M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2)

M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2). The byte tarball itself is a SEPARATE channel artifact (never part of any federation bundle — bundles stay metadata-only, ADR-0009); these are only the API request/response shapes for driving the relay. The tarball crosses the CDS out-of-band as a file, exactly like the `.scpbundle` walk.

## §12. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7) — `GET /federation/audit-witnesses?originDomainId=`, the OPERATOR READ SURFACE for what this domain has passively witnessed of a peer's audit-chain head. This is what the post-failover runbook's peers-witness comparison (§7.2 step 5) actually reads: `scp audit verify` alone cannot see a truncated chain because any prefix of a valid hash chain verifies as valid, so the comparison needs a peer's independent, earlier-recorded view of the origin's chain. Data access: `federation/audit-witness-repo.ts`'s `listAuditWitnessesForOrigin`.

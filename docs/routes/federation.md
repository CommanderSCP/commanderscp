# federation

Reference for `apps/server/src/routes/federation.ts`. The source carries a one-line headline at each site and points here.

> Partial: 8 of 23 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. `/federation` (DESIGN.md §13, BUILD_AND_TEST.md §8 M6)

`/federation` (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Every mutating route requires `federation:write`; every read requires `federation:read` (roles seeded in drizzle/0012_federation.sql). Scoped at the org root (`auth.orgId`) rather than per-object — federation identity/peers/journal are org-instance-wide concerns, not containment-scoped.

ONE ROUTE TAKES MORE (owner ruling D4, 2026-08-25): `POST /federation/peers` — pairing, i.e. declaring whose signature this instance believes — demands `federation:pair` (drizzle/0094) ON TOP OF `federation:write`. Nothing else does, deliberately: operating an established link must keep working for an actor that cannot establish a new one.

## §2. THE RETRANS DOOR

THE RETRANS DOOR (owner decision 2026-08-24). An org declared `retrans` activates relay machinery (inbox loop, auto-relay obligations) and flips that org's dependencyManagement to `managedHere: false` — correct at a CDS boundary, a stray config anywhere else. The deployment is the arbiter: a real retrans box declares `SCP_FEDERATION_ROLE=retrans` at install time (which is also what withholds its SPA — retrans-no-spa.integration.test.ts), so an org-level retrans declaration on any OTHER deployment is refused here, at the sole write door for `federation_self.role` (initFederationSelf has exactly this one non-test caller). Sentence-only 400, no decision_id — a door-level refusal, not an engine verdict. The wire enum deliberately still carries "retrans" (narrowing it is an oasdiff break, and on a retrans-profile deployment this same route accepts it).

## §3. THE SECOND BAR

THE SECOND BAR (owner ruling D4, 2026-08-25 — docs/proposals/role-model.md §4.1). ADDED, NEVER SUBSTITUTED: the `federation:write` check above is untouched, so this door only ever got harder. This route is where an operator declares WHOSE SIGNATURE this instance believes — `publicKey` is taken verbatim from the body, and `pairPeer` treats a changed value as a KEY ROTATION that supersedes the current window — and from there `POST /federation/imports` (still `federation:write`) will apply anything signed with it through `applyEntry`'s `object_upsert`, i.e. estate write authority without `object:write`. The import path is deliberately left ungated: a throw there wedges a legitimately paired peer's whole signed bundle, and pairing is the link that can be gated without breaking the contract. See `authz/resolve.ts`'s `federation:pair` note.

NO OTHER federation route demands `federation:pair` — not import, export, status, outposts, resync, poke, nor the transport-only peer PATCH — so a paired link keeps working under an actor that cannot establish a new one. (Their own gates are unchanged, which for some is more than `federation:write`: hand-fill also takes `object:write`, a federating freeze also takes `freeze:write`.)

## §4. THE FIVE TRANSPORT FIELDS, SPREAD EXPLICITLY

THE FIVE TRANSPORT FIELDS, SPREAD EXPLICITLY (review round 4, H9b). This used to be `{ orgId, domainId: existing.id, ...request.body }` — the spread LAST, so a body-supplied `domainId` would have overridden the RESOLVED peer id and the PATCH would land on a different peer. It is safe today only because fastify-type-provider-zod's validatorCompiler replaces `request.body` with a key-stripping parse — a behaviour documented nowhere near this call site and one nobody would think to re-check when swapping validators. Naming the fields makes the safety local and total: there is no key here that could carry an identity.

## §5. M15.5(c) — the retrans validate-then-relay (ADR-0019 §2)

M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). SOURCE side: build the signed byte tarball for an imported, M17.4(a)-verified promotion. Only a `role: retrans` instance may run it (the repo function enforces the role, 409 otherwise). The tarball lands in the operator-configured SCP_RELAY_OUT_DIR drop directory — the CDS crossing itself is out-of-band, the same boundary the `.scpbundle` walk draws.

## §6. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7) — the OPERATOR READ SURFACE for the post-failover runbook's peers-witness comparison (resilience.md §7.2 step 5): `scp audit verify` alone cannot see a truncated chain (any prefix of a valid hash chain verifies as valid), so the operator compares the restored origin's chain head against what THIS domain earlier witnessed of it. Same simple authorize-in-its-own-tx shape as `/federation/relay-builds` above — this handler has no out-of-tx work either.

## §7. WAKE — enqueue immediate ticks and return fast

WAKE — enqueue immediate ticks and return fast. The loops' workers do the actual work; we never pull inline. No queue on this process (pure role=api, or the loops are disabled) → accepted-but-no-op (the sparse safety-net is the reliability floor).

THREE loops, THREE independent try/catches (M14.4 S6, extended by M13.1b): 1. the federation-sync loop — the CONNECTED leg (an outpost that dials its commander); the wake carries `{reason:"poke", orgId}` so the worker runs a FORCED tick that bypasses the M14.4 due-gate. The orgId is the CALLER'S OWN AUTHENTICATED org, never a request body. 2. the inbox loop — the AIR-GAP leg. An air-gapped outpost has NO role:commander peer with a baseUrl; its content arrives as a FILE. Without this, the ADR-0009 §38 "required" high-side-retrans→outpost poke would wake a sweep that resolves to ZERO peers. 3. the auto-relay loop — the BYTE leg at a `role: retrans` staging node (M13.1b). Legs 1 and 2 move METADATA; until this one existed, a poke landing on a retrans woke the import of the arriving `.scpbundle` and then waited for a human to run the byte hop (M14.4's honest-scope note, owner decision D3). This is what makes the chain move bytes. Each in its own try/catch so a missing queue on any side still returns accepted:true.

## §8. THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS

THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS (role-model.md §8.6)
Every other `authorize()` in this file is correctly pinned at `auth.orgId`: a federation identity, a peer, a journal, an outpost topology and an import/export are org-level concepts, and a binding narrower than the org root holds authority over none of them. These two are the exception, and a census sorted BY FILE sweeps them into that bucket wrongly — what they write and read is an annotation ON a base graph object: a service, a component, a policy.

SO EACH GAINS A SECOND CHECK AT THE RESOLVED BASE OBJECT — ADDED, NEVER SUBSTITUTED.

WHY THE BASE. `getMergedOverlayView` is a READ-TIME merge (DESIGN §13), so an overlay on a component silently changes what every consumer of that component sees, without touching the component's own row. Authority over the thing being annotated is the bar that was missing.

WHY THE ORG-ROOT BAR STAYS. `createOverlay` calls `createObject` with no `domainId`, so an overlay's row always lands at ORG-ROOT containment. That is a STORAGE fact, not an AUTHORITY fact, and it must not be read in either direction: it does not make org-root `object:write` the whole story (see above), and it does not make a base-scoped check a replacement for it. `federation/overlay-repo.ts`'s governance-managed guard demands `policy:write` AT THE ORG ROOT for exactly the storage reason, and its own doc explains why substituting a base-scoped check there would let a component-scoped principal mint overlays outranking a commander-origin object. §8.6 lists that guard among the deliberate escalation bars this increment must not sweep. Keeping the org-root bar first also keeps these doors' 403 for an unbound caller byte-identical to today's, and keeps the base resolution behind an authorization check.

THESE TWO DOORS WERE **TIGHTENED**, NOT RE-SCOPED — SO THE PURE-WIDENING INVARIANT DOES NOT GOVERN THEM (owner-level judgement, 2026-08-26)
Increment 2.5a re-scoped 21 get-by-id doors OFF `scopeObjectId: auth.orgId` and ONTO the object each governs, and that re-scope carries a strict invariant: every request that succeeded before must still succeed. `authz/org-root-arm.ts` exists to make it hold, because `scopeExpandCte` joins every ancestor `deleted_at IS NULL` and so reaches nothing at all from an object whose parents are tombstoned — something an org-root pin could never do to anybody.

THESE TWO DOORS ARE NOT IN THAT SET. Nothing was moved off the org root here: BAR 1 is the pre-2.5a check, unchanged, and BAR 2 was ADDED beside it. Adding a bar is a DELIBERATE NARROWING — it is the entire point of the change (§8.6, and the hand-fill/publish precedent from PR #286) — so measuring it against an invariant written for a widening is a category error, and it was made once already on this branch. The right question for a conjunction is "does the new bar refuse the right things", not "does it refuse anyone the old bar admitted"; by construction it does refuse some of them, or it would not be a bar.

WHAT BAR 2 REFUSES — TWO CASES, both accepted, neither a defect:

```text
1. an explicit `deny` binding AT THE BASE. The bar's purpose, and pinned by
   `federation-overlay-base-authority.integration.test.ts` — a deny is reached only by a check
   scoped at the base, which is what makes the added bar observable at all.
2. A BASE WHOSE CONTAINMENT ANCESTORS ARE TOMBSTONED. `scopeExpandCte` joins every ancestor
   `deleted_at IS NULL`, so the walk from such a base reaches NOTHING — not even the org root
   — and BAR 2 then refuses EVERYONE, an org-root Owner included. Stated plainly, because it
   is a real operational state and not a footnote: **an overlay whose base has tombstoned
   containment ancestors cannot be created or read by anybody until that base's containment
   chain is repaired.** Reachability is narrow but real — `deleteObject`'s orphan guard stops
   a LIVE base from having a tombstoned parent locally, and is deliberately skipped on the
   federation-import path, which is precisely where a foreign-origin base lives. The remedy is
   to repair the chain (re-import or re-parent the base), not to hold an overlay door open
   over an object nothing can currently establish authority over.
```

AND THE ORG-ROOT ARM IS DELIBERATELY NOT APPLIED TO BAR 2. `checkAtOrgRootOrScopes` composes "at the org root OR at the governed object", which is the right shape for a re-scope and the wrong shape here: BAR 1 has already established that the caller holds the permission at the org root, so an org-root arm on BAR 2 is satisfied by every principal that reaches it. That does not "fix case 2" — it deletes BAR 2 entirely, case 1 with it, and would leave two mutation-proven tests green over a door with one bar. Distinguishing "explicitly denied" from "nothing reached" is the only fix that would preserve case 1, and that is a new authz primitive and an owner decision, not a comment. Case 2 is therefore a KNOWN, ACCEPTED state, pinned by a test that asserts the 403 so it is discovered here rather than in production.

The bar is built now because the increment that gives out bindings below the org root is the one where it starts mattering, and because a later sweep that relaxes the org-root pin here would otherwise leave the door with no bar at all.

THE BASE IS RESOLVED BEFORE IT IS SCOPED. `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so a check scoped at an unresolved caller-supplied value refuses everybody — including an org-root Owner, who would get a 403 where a 404 is the honest answer.

PINNED BY `routes/federation-overlay-base-authority.integration.test.ts` (mutation-proven), with the no-regression half in `governance/governance-managed-write-doors.integration.test.ts`.

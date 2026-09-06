# cli

Reference for `packages/cli/src/cli.ts`. The source carries a one-line headline at each site and points here.

> Partial: 25 of 97 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ABSENT — `null` OR `undefined`, never one of the two

ABSENT — `null` OR `undefined`, never one of the two.

A key an older or newer server OMITS arrives as `undefined` whatever the TypeScript type says. SINCE ADR-0023 the SDK validates every 2xx JSON body of every spec'd operation, so for a field that is `.nullable()` WITHOUT `.optional()` an omitted key now REJECTS at the boundary and this guard is defence in depth. For a field that IS `.optional()` nothing changed: an omitted key is contract-legal, passes validation untouched, and this guard is the only thing left. A strict `=== null` therefore guards ONE of two legal absences and lets the other through to a printer, where it becomes the literal string `undefined`, a crash on `.toFixed(…)`, or — worst — the CONFIDENT branch of a ternary whose other branch was the honest one. `apps/web/src/lib/absent.ts` is the same rule for the browser half; this is the CLI's copy, because the two share no runtime.

## §2. One paired peer as a `scp federation peers` table row

One paired peer as a `scp federation peers` table row.

EXPORTED, like `federationStatusRow` beside it and for the same reason (round 4, Y2): a guard no test can invoke is a guard nothing holds in place. This function was module-private, so the `?.mode ?? "?"` below could be reverted without a single test noticing.

`syncScope` is required-not-optional on `FederationPeerSchema`, and BEFORE ADR-0023 the generated SDK validated NO response at runtime, so `p.syncScope.mode` was a bare dereference of a promise about the server (since ADR-0023 such a body rejects at the SDK boundary and `bin.ts` prints the operation and the field; this stays for every other source of a peer, and this function is what a test can actually invoke) — the EXACT field `outpost-settings.tsx`'s `peerSyncScopeMode` guards on the web side (its doc comment states the rule). MEASURED here: `TypeError: Cannot read properties of undefined (reading 'mode')`, thrown while building the FIRST row, so `scp federation peers` printed no table at all.

`"?"` RATHER THAN `"full"`, deliberately, and matching `transport` below: substituting a default would tell the operator this peer exports everything on no evidence whatsoever. An unknown scope is unknown.

## §3. `scp federation status` in table form

`scp federation status` in table form. EXPORTED for the reason given on `peerRow`.

`peers` is required-not-optional on `FederationStatusResponseSchema` and BEFORE ADR-0023 the SDK validated no response — the LAST unguarded consumer of that field (Z5). Since ADR-0023 a body without the key rejects at the boundary rather than reaching this printer. `outposts.tsx` reads it as `statusQuery.data?.peers ?? []` and `outpost-detail.tsx` passes `data?.peers` into a function that accepts `undefined`; this and `federation-status.tsx` were the two that did not. "No paired peers." is the honest degradation: it says this side has no peer rows to show, which is exactly what an absent list means here.

## §4. M16.2 phase A (E3) — PENDING-EXPORT, never pending-apply

M16.2 phase A (E3) — PENDING-EXPORT, never pending-apply. "N pending" counts THIS domain's own journal entries not yet carried in any bundle addressed to the peer; it says NOTHING about what the peer applied (this side cannot observe that — see the schema's note and `unknownFields`). `?` is printed whenever the field is declared unknown, so a null never reads as "nothing pending"/"synced".

## §5. M16.2 phase A (E1) — one `outpost` config object as a table row

M16.2 phase A (E1) — one `outpost` config object as a table row. `trustTier` prints "?" when the operator has never asserted one; `origin` distinguishes a commander's own authored object from the read-only REPLICA an outpost holds of it.

EXPORTED for the reason given on `peerRow`: this was module-private, so the `?? []` below was unreachable by any test.

`unknownFields` is required-not-optional (`packages/schemas/src/federation.ts` `OutpostConfigSchema`) and BEFORE ADR-0023 the SDK validated no response, so `o.unknownFields.join(", ")` was bare (since ADR-0023 that body rejects at the boundary). MEASURED: `TypeError: Cannot read properties of undefined (reading 'join')`. Its web twin at `outpost-configuration.tsx` took the `?? []` last round and IS pinned; this half was not fixed even though the PR body claimed the field "closed as a class". Blast radius is SIX commands (`cli.ts` ~2963/2993/3005/3017/3044/3050).

`?? []` collapses to the same `"-"` an EMPTY `unknownFields` prints — and that is the honest reading either way: this side has nothing to report as not-observable. It is NOT a claim that every field is observable, which is why the column is headed "notObservable" and not "observable".

## §6. The verdict line of `scp dependency-subscriptions resolve`

The verdict line of `scp dependency-subscriptions resolve`. The `contributions` are printed as their own table beside it (below) — they are the answer to "WHICH level turned this off", and folding them into one cell would make the explainability surface unreadable at the exact moment it is being consulted.

`granularity`/`delivery` are guarded even though the server always sends them: a key an older or newer server omits arrives as `undefined` whatever the type says, and printing the literal `undefined` in a DELIVERY column — where the two values are "open a PR" and "merge it automatically" — is a fabrication with teeth.

`managedHere`/`managedReason` carry the server's `dependencyManagement` envelope (ADR-0032 §7d), printed BESIDE the verdict because they QUALIFY it: on a deployment that is not an explicitly declared commander, `enabled: true` is arithmetically correct and NOTHING THERE WILL EVER ACT ON IT. Guarded like the pair above, and for a sharper reason — a server that omits the key must render `-`, never a fabricated `true`, because inventing "yes, managed here" is the exact false reassurance the envelope exists to remove.

## §7. THE TWO ABSENCES ARE DIFFERENT CLAIMS AND ARE NOT COLLAPSED

THE TWO ABSENCES ARE DIFFERENT CLAIMS AND ARE NOT COLLAPSED (which is why this does not reach for `isAbsent`, whose job is the opposite — to stop the two being told apart *by accident*). `null` is the server saying "this change coupled nothing"; an omitted key is the server saying nothing at all, which is contract-legal for an `.optional()` field and is exactly what a pre-increment-4 server puts on the wire. Printing "coupled nothing" for the second would be a fabricated observation about a change that may well be held.

## §8. M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1)

M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1). All 8 resources — domain/service/ component/deployment-target/team/group/user/service-account — expose the exact same create/list/get/update/delete/upsertByUrn shape (ScpClient.typedResource), and the 4 `owns`-eligible + 2 `consumes`/`depends_on`-eligible resources add ownership/edge methods on top. These three factories build the `register`/`list`/`get`/`update`/`delete`/`upsert` and `add-owner`/`add-consumes`/`add-depends-on` command families once, instead of hand-copying them per resource — mirroring routes/typed-registries.ts and routes/ownership.ts server-side.

## §9. doctor — read-only operational self-checks (`GET /doctor`)

doctor — read-only operational self-checks (`GET /doctor`).

Sibling of `scp graph integrity` in spirit: a report, never a repair. The distinction from `pnpm doctor` (scripts/doctor.mjs) is deliberate and worth keeping straight — that one checks the TOOLCHAIN on a developer's machine and never opens a database; this one checks a running INSTANCE's state, over the public API like everything else in this CLI.

## §10. M25.1 — THE EXITS

M25.1 — THE EXITS. `scp freeze` was create/list/get, so an operator could declare a freeze and had no way to take it back: the only escapes were `scp change cancel` / `scp change rollback`, which throw the RELEASE away rather than lifting the FREEZE. Since M25.2's per-target admission that is worse than waiting — a mistyped `--ends-at` year now holds a SUBSET of a wave's targets while the siblings have already shipped.

## §11. WHAT LIFTING COSTS

WHAT LIFTING COSTS (M25.9 / owner ruling D1(a-ii), 2026-08-25): * YOUR OWN freeze — `freeze:write` at the freeze's own scope, the same permission that declared it. Your own mistake stays yours to undo, or `scp freeze create` would be an entrance with no exit for the very role that uses it. * A freeze ANOTHER ACTOR declared — that PLUS the Owner-only `freeze:override`, at the freeze's own scope. Retracting someone else's protection for everyone it covers costs the same permission that admits one change past it (`scp change accept --override-freeze`). Expect a 403 naming `freeze:override` if you hold only the first.

Scope expands UPWARD only: `freeze:override` bound at a service lifts that service's freezes and never the org-root freeze that covers everyone.

## §12. WHAT EACH DIRECTION COSTS

WHAT EACH DIRECTION COSTS (M25.9 / owner ruling D1(a-ii), 2026-08-25) — the two are NOT the same price, and the server decides from the direction it computes under the row lock: * SHORTENING — it ends the protection early for everyone the freeze covers, which is `lift` with a different record, so on ANOTHER ACTOR'S freeze it takes the Owner-only `freeze:override` on top of `freeze:write`, at the freeze's own scope. Gating `lift` alone would have left the retraction one `update` away. On your own freeze it stays `freeze:write`. * EXTENDING — it ADDS protection and takes nothing from anyone the freeze covers, so it stays `freeze:write` whoever declared the freeze. So does re-sending the `endsAt` it already has.

(A FEDERATING freeze is the one case where extending is the sharper direction, because it grows a block inside another security domain — that is a separate `federation:write` bar, and both apply.)

## §13. campaign (M5 Campaigns — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5)

campaign (M5 Campaigns — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). A Campaign coordinates many Changes across targets, wave by wave, over the SAME plan compiler a Change uses; unlike Change, it has no accept/cancel verbs — `status` is always a pure derived field, so `campaign status <id>` (its `get`) IS the CLI's window into that field.

## §14. M25.6a (owner decision D4) — SET, MOVE or CLEAR the deadline

M25.6a (owner decision D4) — SET, MOVE or CLEAR the deadline. `--clear` is THE BLUNT EXIT: it releases every target the deadline was withholding this campaign's fan-out from, on the next tick, with no unlock verb. `scp campaign deadline-override` (M25.6b) is the per-target one: narrower radius, same permission on the widening acts, and it leaves the deadline standing.

WHAT EACH ACT COSTS (owner ruling 2026-08-25, D1 b-i): * `--at <iso>` SETTING a first deadline, or SHORTENING an existing one — plain `object:write` at the campaign. Both withhold this campaign's changes from strictly MORE targets, so neither can launder a waiver, and routine campaign hygiene must not need an Owner. * `--clear`, or `--at <iso>` naming an instant LATER than the one stored — `object:write` PLUS the Owner-only `campaign:deadline-override`. Both release targets that were being withheld, and clearing is a strict superset of waiving one target, so it cannot cost less than `deadline-override` does. Expect a 403 naming that permission if you hold only the first.

`--reason` is required on ALL THREE acts, clear included: it is the operator's own words on the hash chain, beside a Decision carrying the previous instant.

## §15. instance scan-floors (M17.5 — ADR-0016)

instance scan-floors (M17.5 — ADR-0016). The two ABOVE-org tiers of the six-tier, most-restrictive-wins scan-requirement chain: platform -> trust domain (partition) -> org -> containment domain -> service -> component These are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an OPERATOR action gated by the deployment's SCP_OPERATOR_TOKEN — never a tenant role, however privileged inside its own org. Reading is an ordinary authenticated call, because a gate you cannot inspect is not explainable.

`trust-domain` is the AMBIENT FEDERATION boundary (a partition) above org — NOT the intra-org containment `domain` object type below org (`scp domain ...`). Different concepts; the stored tier literal is `trust_domain`, never bare `domain`.

## §16. instance scan-exclusion-admissions (M22.9 — ADR-0033 §1, §7a)

instance scan-exclusion-admissions (M22.9 — ADR-0033 §1, §7a). The two ABOVE-org rungs of the exclusion dimension's monotone AND: a clause authored at any tier has effect only if EVERY represented tier strictly above it admits that clause's CLASS, and `platform` + `trust_domain` are ALWAYS represented. No policy can contribute those two — a policy anchors at a graph object and the containment chain is org-rooted — so with this table empty (the shipped default) every exclusion clause on the deployment is inert. This command is how an operator changes that.

The five org-and-below rungs are NOT here and need nothing: they admit through the ordinary `scanExclusion` policy effect (`scp policy create ... {"scanExclusion":{"admit":[...]}}`).

`set` REPLACES the admitted set for the tier, so withdrawing everything is `--revoke-all` rather than simply omitting `--class` — omitting it is refused, because an empty set at an instance rung makes every exclusion clause on the deployment inert and that is not something to reach by forgetting a flag.

## §17. THE DESTRUCTIVE DEFAULT, MADE EXPLICIT

THE DESTRUCTIVE DEFAULT, MADE EXPLICIT (owner decision, 2026-08-18).

`set` is a whole-set REPLACE, and that is the right server contract: an additive verb would make withdrawal the harder operation on a LOOSENING, which is the wrong way round. But it means `--class` omitted sends `classes: []`, and an empty admitted set at an instance rung makes EVERY exclusion clause on the deployment inert — every org, every tier beneath it — because the monotone AND fails at the top. That is a bigger blast radius than any other single CLI call in this tool, and it was reachable by forgetting a flag.

The server contract is unchanged; this refusal is CLI-side only. `--revoke-all` is the withdrawal path and it says what it does.

## §18. instance scanner-assignments (M13.3a — ADR-0020 §2)

instance scanner-assignments (M13.3a — ADR-0020 §2). The executor Type -> managed scan method(s) registry the commander's promotion scan step selects scanners from. Keyed on the EXISTING ExecutorType taxonomy (image|rpm|deb|npm|maven|python|go|chart|vm-image|infrastructure|configuration). Like scan floors these are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an OPERATOR action gated by SCP_OPERATOR_TOKEN — never a tenant role. Reading is an ordinary authenticated call. An empty methods set CLEARS the assignment (that Type produces no managed evidence — fail-closed: E6 refuses unless org-pipeline evidence covers the digest).

## §19. scan-db (M13.3b-ii — ADR-0020, proposal §13.3b)

scan-db (M13.3b-ii — ADR-0020, proposal §13.3b). The commander's managed-scan vulnerability DB: `status` + `staleness-policy get` are ordinary reads (a promotion blocked for a stale DB must be explainable); `staleness-policy set`, `refresh` (connected skopeo-pull), and `load` (air-gap cosign-signed blob) bind every org and are OPERATOR actions gated by SCP_OPERATOR_TOKEN.

## §20. dependency-subscriptions (M21.3 — ADR-0032 §3a, §6)

dependency-subscriptions (M21.3 — ADR-0032 §3a, §6). Enablement is a monotone AND:

```text
  effective_enabled(component, line) =
      instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
```

`unlock` is an ordinary read (a team whose subscription is inert because the DEPLOYMENT never opened the feature must be able to see that — charter principle 6); `set-unlock` binds every org and is an OPERATOR action gated by SCP_OPERATOR_TOKEN, never a tenant role. `resolve` is the explainability surface: it prints the verdict AND the per-tier contributions that produced it.

THERE IS NO `subscribe` VERB, AND ONE MUST NOT BE ADDED. A dependency subscription IS a `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a), so it is authored with `scp policy register` — the same command, versioning and federation path every other policy uses. `scp dependency-subscriptions --help` says so out loud, because the first thing someone will look for here is the verb that does not exist.

## §21. M21.2 (ADR-0032 §4) — the inventory backfill

M21.2 (ADR-0032 §4) — the inventory backfill.

Ingestion is event-driven: an accepted, correlated change re-reads its component's dependency manifests. That covers components that RELEASE and nothing else, so an existing estate — and any component that has not pushed since it was enabled — needs this once. Idempotent, so running it twice is a no-op, and it reports every skip rather than a bare count.

POINT IT AT THE COMMANDER. All dependency automation is commander-only (ADR-0032 §7d), so an instance whose `SCP_FEDERATION_ROLE` is not an explicitly declared `commander` answers 409 with a detail naming why — including the fail-closed case where the role was never declared at all. It is said in the description because that 409 is a mistake an operator makes when choosing `--base-url`, not a mistake in the request, and the flag is right here.

## §22. THE HELP TEXT IS DERIVED FROM THE SCHEMA, NOT RETYPED

THE HELP TEXT IS DERIVED FROM THE SCHEMA, NOT RETYPED (review round 5, N1). The first cut of the tier enum was `commercial|fedramp-high|il5`; ADR-0022 widened it to the glossary's five members, and every OTHER site was corrected while these two option descriptions kept listing the old three — the only place an operator ever reads the list. An operator enrolling a GovCloud outpost was told no value existed for it, and pushed to either leave the tier unknown or assert `commercial`: the INVENTED POSTURE this milestone exists to prevent. Joining the enum's own members here makes that drift structurally impossible; `outpost-cli-surface.test.ts` pins it.

## §23. THE RECOVERY VERB, ON THE ONLY SURFACE ITS OPERATOR CAN REACH

THE RECOVERY VERB, ON THE ONLY SURFACE ITS OPERATOR CAN REACH (review round 5, N2). Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and this verb exists precisely so somebody can UN-WEDGE a peer whose database holds duplicate `outpost` objects. That operator is the one person who cannot use the UI for it — the wedged peer is exactly what the UI fails to render — so of all the verbs this milestone added, `reconcile` is the one that most needs a command line.

## §24. M15.5(c) — the retrans validate-then-relay (ADR-0019 §2)

M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). `relay` runs on the RETRANS-role instance: pull + validate the imported promotion's authorized artifact bytes and build the signed byte tarball in the server's SCP_RELAY_OUT_DIR drop directory. The tarball crosses the CDS out-of-band (a file walk, exactly like `.scpbundle`); `relay-import` runs on the DESTINATION outpost to verify it and push the bytes into the local registry by digest.

## §25. `scp discovery backfill-mappings` IS GONE with the route it called

`scp discovery backfill-mappings` IS GONE with the route it called. It repaired the ~50 argocd components imported through `discovery/accept` before discovery emitted source mappings. That population is CLOSED — accept is gone (ADR-0047), so no door can create a mapping-less component any more — and the repair path for one that predates the change is now to adopt it into a stack (`scp iac export` carries existing mappings) and declare the source in the manifest, which the ordinary `sourceMappings` collection reconciles on apply.

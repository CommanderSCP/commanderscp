# cli

Long-form reference for the **cli** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 151 of 151 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/cli/src/audit-witnesses-cli.test.ts`](#packages-cli-src-audit-witnesses-cli-test-ts) — §1–§1
- [`packages/cli/src/campaign-adoption-cli.test.ts`](#packages-cli-src-campaign-adoption-cli-test-ts) — §2–§2
- [`packages/cli/src/cli-absent-formatters.test.ts`](#packages-cli-src-cli-absent-formatters-test-ts) — §3–§7
- [`packages/cli/src/cli.ts`](#packages-cli-src-cli-ts) — §8–§104
- [`packages/cli/src/client-factory.ts`](#packages-cli-src-client-factory-ts) — §105–§105
- [`packages/cli/src/connect-argocd-cli.test.ts`](#packages-cli-src-connect-argocd-cli-test-ts) — §106–§106
- [`packages/cli/src/dependency-producer-cli.test.ts`](#packages-cli-src-dependency-producer-cli-test-ts) — §107–§107
- [`packages/cli/src/dependency-read-verbs-wire.test.ts`](#packages-cli-src-dependency-read-verbs-wire-test-ts) — §108–§108
- [`packages/cli/src/dependency-subscription-cli.test.ts`](#packages-cli-src-dependency-subscription-cli-test-ts) — §109–§112
- [`packages/cli/src/domain-local-cli-surface.test.ts`](#packages-cli-src-domain-local-cli-surface-test-ts) — §113–§113
- [`packages/cli/src/governance-move-cli-wire.test.ts`](#packages-cli-src-governance-move-cli-wire-test-ts) — §114–§114
- [`packages/cli/src/governance-move-cli.test.ts`](#packages-cli-src-governance-move-cli-test-ts) — §115–§115
- [`packages/cli/src/iac-estate-program.roundtrip.test.ts`](#packages-cli-src-iac-estate-program-roundtrip-test-ts) — §116–§116
- [`packages/cli/src/iac-estate-reader.ts`](#packages-cli-src-iac-estate-reader-ts) — §117–§119
- [`packages/cli/src/iac-export-cli.test.ts`](#packages-cli-src-iac-export-cli-test-ts) — §120–§121
- [`packages/cli/src/iac-render-cli.test.ts`](#packages-cli-src-iac-render-cli-test-ts) — §122–§122
- [`packages/cli/src/iac-scaffold-cli.test.ts`](#packages-cli-src-iac-scaffold-cli-test-ts) — §123–§123
- [`packages/cli/src/iac-scaffold-reader.ts`](#packages-cli-src-iac-scaffold-reader-ts) — §124–§124
- [`packages/cli/src/index.ts`](#packages-cli-src-index-ts) — §125–§125
- [`packages/cli/src/outpost-cli-surface.test.ts`](#packages-cli-src-outpost-cli-surface-test-ts) — §126–§129
- [`packages/cli/src/outpost-reconcile-precondition.test.ts`](#packages-cli-src-outpost-reconcile-precondition-test-ts) — §130–§131
- [`packages/cli/src/output.test.ts`](#packages-cli-src-output-test-ts) — §132–§132
- [`packages/cli/src/output.ts`](#packages-cli-src-output-ts) — §133–§134
- [`packages/cli/src/plan-diff-row.test.ts`](#packages-cli-src-plan-diff-row-test-ts) — §135–§136
- [`packages/cli/src/rbac-cli-wire.test.ts`](#packages-cli-src-rbac-cli-wire-test-ts) — §137–§137
- [`packages/cli/src/relay-builds-cli.test.ts`](#packages-cli-src-relay-builds-cli-test-ts) — §138–§138
- [`packages/cli/src/report-test-bundle-flags-wire.test.ts`](#packages-cli-src-report-test-bundle-flags-wire-test-ts) — §139–§139
- [`packages/cli/src/scan-exclusion-admissions-cli.test.ts`](#packages-cli-src-scan-exclusion-admissions-cli-test-ts) — §140–§142
- [`packages/cli/src/source-mapping-row.test.ts`](#packages-cli-src-source-mapping-row-test-ts) — §143–§143
- [`packages/cli/src/stage-dependencies-flags.test.ts`](#packages-cli-src-stage-dependencies-flags-test-ts) — §144–§144
- [`packages/cli/src/stage-dependency-surface.test.ts`](#packages-cli-src-stage-dependency-surface-test-ts) — §145–§148
- [`packages/cli/src/test-support/ts-harness.ts`](#packages-cli-src-test-support-ts-harness-ts) — §149–§149
- [`packages/cli/vitest.config.ts`](#packages-cli-vitest-config-ts) — §150–§151

## `packages/cli/src/audit-witnesses-cli.test.ts`

### §1. Federation audit witness

Federation audit witness (multi-region-instance-resilience.md §7.2.7) — THE CLI HALF of the post-failover runbook's peers-witness comparison read surface (resilience runbook §7.2 step 5), `scp audit witnesses --origin <domainId>`.

Same wiring-not-wording shape as `relay-builds-cli.test.ts`: `@scp/sdk` is mocked wholesale and every assertion is against the ACTUAL call the mock recorded, plus the rendered table text.

## `packages/cli/src/campaign-adoption-cli.test.ts`

### §2. The CLI half of the campaign adoption read surface

M25.5 — THE CLI HALF of the campaign adoption read surface, `scp campaign adoption <id>` ("has each of this campaign's components migrated yet?"). The route (`GET /campaigns/{id}/adoption`) already existed; only the `ScpClient` wrapper and this CLI command were missing. Same wiring-not-wording shape as `relay-builds-cli.test.ts`.

## `packages/cli/src/cli-absent-formatters.test.ts`

### §3. THE PINS FOR THE CLI HALF OF THE `isAbsent` CENSUS

THE PINS FOR THE CLI HALF OF THE `isAbsent` CENSUS (review round 4, Y2).

WHY THIS FILE EXISTS AT ALL. Round 3 replaced `=== null` with `isAbsent(...)` at eleven CLI sites, and the PR body reported all of them as mutation-proven. A lens reverted them ONE AT A TIME and found TEN SURVIVORS: only `formatReconcileResultLines` (already exported, already tested) went red. The other ten lived either in a module-private function (`printFederationStatus`, `campaignDetailRow`) or inline in a Commander `.action()` closure (the scan-floor and scan-db mappers), so NO test could reach them — the guards were correct and completely unheld.

The fix was structural: those mappers are now exported functions rather than closures, and this file calls each one with the key ABSENT. Each assertion below has been mutation-proven by reverting its `isAbsent(...)` to `=== null` and watching this file go red.

WHAT "ABSENT" MEANS, and why `=== null` is not enough (see `isAbsent`'s own doc in `cli.ts`): an omitted key arrives as `undefined` whatever `.nullable()` says. For an `.optional()` field that is CONTRACT-LEGAL and ADR-0023's response validation passes it through untouched, so these guards are the only thing; for a required field the SDK now rejects the body at the boundary instead and they are defence in depth. Either way the formatters are called DIRECTLY here, which is the only level at which the guard itself — as opposed to the boundary in front of it — can be pinned. Every fixture below therefore DELETES the key rather than setting it to `null` — `null` is the case that already worked.

### §4. THE MOST CONSEQUENTIAL MUTANT IN THIS FILE

THE MOST CONSEQUENTIAL MUTANT IN THIS FILE. `trustTierProvenance` is itself a field an older server omits, so provenance-only detection is not enough: the server ALSO declares the tier in `unknownFields`, and dropping the `|| (p.unknownFields ?? []).includes("trustTier")` OR makes `scp federation status` print a hand-typed `il5` as though the commander had asserted it — the exact fabrication the web `TrustTierCell` exists to prevent, reproduced on the CLI.

### §5. The twin of the block above, which shipped with no test

instanceScanExclusionAdmissionRow — M22.9's twin of the block above, and it shipped with NO test at all. A filterless `grep -rna 'instanceScanExclusionAdmissionRow'` over `--include='*.ts'` found the formatter referenced ONLY by `cli.ts` itself, while its sibling `instanceScanFloorRow` three lines up was covered here — the round-4 finding recurring on the next feature: the lift-out happened, the pin did not, so deleting the whole M22.9 command block left this package green.

### §6. ROUND 5 (Z2/Z3/Z4) — THE CLI TWINS OF GUARDS THE WEB SIDE ALREADY TOOK

ROUND 5 (Z2/Z3/Z4) — THE CLI TWINS OF GUARDS THE WEB SIDE ALREADY TOOK.

Each of the three below is the SAME required-not-optional field, off the SAME endpoint, as a web-side site fixed in an earlier round; each was left bare on the CLI half, and each lived in a MODULE-PRIVATE function so no test could have caught it. `peerRow` and `outpostConfigRow` are now exported for that reason — round 4's Y2 finding restated: a guard no test can invoke is a guard nothing holds in place.

### §7. THE MUTANT: `p.syncScope.mode` throws

THE MUTANT: `p.syncScope.mode` throws `TypeError: Cannot read properties of undefined (reading 'mode')` while building the FIRST row, so the command prints NO table at all — not a degraded one. `syncScope` is required-not-optional on `FederationPeerSchema` and the generated BEFORE ADR-0023 the SDK validated no response; this is the same field `outpost-settings.tsx` guards on the web. These cases drive the FORMATTER directly, which is where the guard lives.

## `packages/cli/src/cli.ts`

### §8. ABSENT — `null` OR `undefined`, never one of the two

ABSENT — `null` OR `undefined`, never one of the two.

A key an older or newer server OMITS arrives as `undefined` whatever the TypeScript type says. SINCE ADR-0023 the SDK validates every 2xx JSON body of every spec'd operation, so for a field that is `.nullable()` WITHOUT `.optional()` an omitted key now REJECTS at the boundary and this guard is defence in depth. For a field that IS `.optional()` nothing changed: an omitted key is contract-legal, passes validation untouched, and this guard is the only thing left. A strict `=== null` therefore guards ONE of two legal absences and lets the other through to a printer, where it becomes the literal string `undefined`, a crash on `.toFixed(…)`, or — worst — the CONFIDENT branch of a ternary whose other branch was the honest one. `apps/web/src/lib/absent.ts` is the same rule for the browser half; this is the CLI's copy, because the two share no runtime.

### §9. Parse the stage-dependency flags into their request shape

ADR-0028 — parse `--stage-depends-on` / `--stage-depends-at` into `stageDependencies` (the SAME pair of flags on `scp change propose` and `scp change-source report`).

`--stage-depends-on` is comma-separated `componentIdOrUrn` or `componentIdOrUrn@minWeight`; the '@' split is the LAST one, so a URN (which contains ':' but never '@') survives, exactly as `parseRequiresFlag` does. A present-but-unparseable weight is an error, not a silent drop to "no qualifier": the two mean different things and coercing one into the other would quietly widen the hold the author asked for.

`--stage-depends-at` scopes EVERY entry to the same deployment targets. The wire shape carries `atTargets` PER dependency, which is strictly more expressive; a release needing two dependencies scoped to different places must use the API/SDK. Said plainly here rather than pretending the flags are complete.

### §10. M5 Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5)

M5 Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN.md §9.5) — row formatters. Campaign `status` is a pure derived field (no accept/cancel verbs), so it's surfaced prominently in both the compact and detail rows.

### §11. Which targets a deadline override excuses, by id only

M25.6b — WHICH targets are excused, so `scp campaign deadline-override` has a signal beside its lever. Ids only: the stored waiver's `reason`, `actorId` and `at` are on the hash chain (`campaign.deadline.override`), and a table cell is the wrong place to render prose an operator would then be tempted to treat as the record. BLANK when there are none, never the word `undefined` — the same rule the two rows above it follow.

### §12. One paired peer as a `scp federation peers` table row

One paired peer as a `scp federation peers` table row.

EXPORTED, like `federationStatusRow` beside it and for the same reason (round 4, Y2): a guard no test can invoke is a guard nothing holds in place. This function was module-private, so the `?.mode ?? "?"` below could be reverted without a single test noticing.

`syncScope` is required-not-optional on `FederationPeerSchema`, and BEFORE ADR-0023 the generated SDK validated NO response at runtime, so `p.syncScope.mode` was a bare dereference of a promise about the server (since ADR-0023 such a body rejects at the SDK boundary and `bin.ts` prints the operation and the field; this stays for every other source of a peer, and this function is what a test can actually invoke) — the EXACT field `outpost-settings.tsx`'s `peerSyncScopeMode` guards on the web side (its doc comment states the rule). MEASURED here: `TypeError: Cannot read properties of undefined (reading 'mode')`, thrown while building the FIRST row, so `scp federation peers` printed no table at all.

`"?"` RATHER THAN `"full"`, deliberately, and matching `transport` below: substituting a default would tell the operator this peer exports everything on no evidence whatsoever. An unknown scope is unknown.

### §13. `scp federation status` in table form

`scp federation status` in table form. EXPORTED for the reason given on `peerRow`.

`peers` is required-not-optional on `FederationStatusResponseSchema` and BEFORE ADR-0023 the SDK validated no response — the LAST unguarded consumer of that field (Z5). Since ADR-0023 a body without the key rejects at the boundary rather than reaching this printer. `outposts.tsx` reads it as `statusQuery.data?.peers ?? []` and `outpost-detail.tsx` passes `data?.peers` into a function that accepts `undefined`; this and `federation-status.tsx` were the two that did not. "No paired peers." is the honest degradation: it says this side has no peer rows to show, which is exactly what an absent list means here.

### §14. ONE peer's row in `scp federation status`

ONE peer's row in `scp federation status` — EXTRACTED FROM the `printResult` callback inside `printFederationStatus` (itself module-private), and exported, so that every honest-unknown rule below is reachable by a test.

WHY THE EXTRACTION IS THE POINT (Y2). Every `isAbsent` guard here was added to stop a fabrication, and every one of them could be reverted with the CLI suite still GREEN, because nothing could invoke the closure they lived in. `cli-absent-formatters.test.ts` now reverts each of them and watches a named assertion go red. The most consequential is `trustTier`: without the `unknownFields` clause a HAND-TYPED (shadow) tier prints BARE, with no `(unverified)` suffix — the CLI reproduction of exactly the fabrication the web `TrustTierCell` exists to prevent.

### §15. M16.2 phase A (E3) — PENDING-EXPORT, never pending-apply

M16.2 phase A (E3) — PENDING-EXPORT, never pending-apply. "N pending" counts THIS domain's own journal entries not yet carried in any bundle addressed to the peer; it says NOTHING about what the peer applied (this side cannot observe that — see the schema's note and `unknownFields`). `?` is printed whenever the field is declared unknown, so a null never reads as "nothing pending"/"synced".

### §16. M16.2 phase A (E1) — one `outpost` config object as a table row

M16.2 phase A (E1) — one `outpost` config object as a table row. `trustTier` prints "?" when the operator has never asserted one; `origin` distinguishes a commander's own authored object from the read-only REPLICA an outpost holds of it.

EXPORTED for the reason given on `peerRow`: this was module-private, so the `?? []` below was unreachable by any test.

`unknownFields` is required-not-optional (`packages/schemas/src/federation.ts` `OutpostConfigSchema`) and BEFORE ADR-0023 the SDK validated no response, so `o.unknownFields.join(", ")` was bare (since ADR-0023 that body rejects at the boundary). MEASURED: `TypeError: Cannot read properties of undefined (reading 'join')`. Its web twin at `outpost-configuration.tsx` took the `?? []` last round and IS pinned; this half was not fixed even though the PR body claimed the field "closed as a class". Blast radius is SIX commands (`cli.ts` ~2963/2993/3005/3017/3044/3050).

`?? []` collapses to the same `"-"` an EMPTY `unknownFields` prints — and that is the honest reading either way: this side has nothing to report as not-observable. It is NOT a claim that every field is observable, which is why the column is headed "notObservable" and not "observable".

### §17. §10.5 — WHAT `peerDomainId` NAMES

§10.5 — WHAT `peerDomainId` NAMES (GLOSSARY / ADR-0021 D7 vocabulary): `hq` = THIS instance's own trust domain — the HQ outpost (formerly "co-located"), which has no peer row; `field` = a paired peer in another trust domain — a field outpost, whatever its connectivity. `peerIsSelf` is optional on the wire (additive): an older server that does not resolve it prints `?`, never "field" — absence is not a statement.

### §18. One auto-relay build ledger row as a table row

One auto-relay build ledger row as a table row (`scp federation relay-builds`, M13.1b operator read surface) — exported for the same reason as `peerRow`/`outpostConfigRow`: a guard no test can invoke is a guard nothing holds in place.

`sourceChangeObjectId`, `claimedUntil`, `lastReason` and `lastDecisionId` are ALL genuinely nullable on the wire (relay-builds-repo.ts's `RelayBuildLedgerRow` doc: no source id was recorded / unclaimed / no verdict yet / no verdict Decision yet) — `null` there is a real fact, not an omission an older server would produce, but `isAbsent` still guards it the same way every other nullable column in this file does, so an older/newer server that omits the key outright prints `-` instead of the literal `undefined`. `attempts`/`failedAttempts` are printed EXACTLY AS THE RESPONSE STATES — it carries no verdict cap, so this row never computes or implies one.

### §19. One federation audit-witness row as a table row

One federation audit-witness row as a table row (`scp audit witnesses --origin <domainId>`) — the post-failover peers-witness comparison's read surface (resilience runbook §7.2 step 5, multi-region-instance-resilience.md §7.2.7). Exported for the same reason as `relayBuildRow`: a guard no test can invoke is a guard nothing holds in place.

### §20. One instance-scoped scan-requirement floor as a table row

One instance-scoped scan-requirement floor as a table row (`scp scan-floors list`) — LIFTED OUT of the action closure it was written inside, and exported, for the reason given on `federationStatusRow`: a guard no test can invoke is a guard nothing holds in place.

THE FABRICATION EACH `isAbsent` STOPS is specific and severe here. `null` on a ceiling means UNBOUNDED — no limit was authored — and it is NOT `0`. An unguarded `String(undefined)` prints the literal `undefined` in a security ceiling column; the honest rendering is `-`.

### §21. One instance-scoped exclusion admission as a table row

One instance-scoped exclusion admission as a table row (`scp scan-exclusion-admissions list`) — same lift, same reason as `instanceScanFloorRow`.

THE FABRICATION `isAbsent` STOPS HERE is the reverse of the floor's: an admission row's mere EXISTENCE is the grant, so there is no value to print `undefined` in — but `note` is nullable and a literal `null` in an operator's audit column reads as a value somebody authored.

### §22. The managed-scan DB status row (`scp scan-db status`)

The managed-scan DB status row (`scp scan-db status`) — same lift, same reason.

`ageHours` is the one where absence is not merely dishonest but FATAL: `.toFixed(1)` on `undefined` throws, so the whole command dies rather than printing a status. "(unknown)" is the honest reading — and it must not read as "fresh", because an unknown age is precisely the state a staleness gate cannot clear.

### §23. `scp scan-db refresh` / `scp scan-db load` outcome as a table row

`scp scan-db refresh` / `scp scan-db load` outcome as a table row — LIFTED OUT of the two `.action()` closures it was duplicated inside, and exported, for the reason given on `scanDbStatusRow`.

THE TWIN ONE COMMAND OVER (Z5). `scanDbStatusRow` guards `ageHours` because absence there is both dishonest and FATAL; the identical read in these two closures was `String(r.status.ageHours)`, left bare — so an omitted key printed the literal `undefined` in the age column of a SECURITY cache, and an omitted `status` object threw over the report of a load that had already happened. Same shape as Z4: the verb ran, and only the telling of it died.

`"(unknown)"`, not `0` and not blank: an unknown age is precisely the state a staleness gate cannot clear.

### §24. The instance dependency-subscription unlock as a table row

The instance dependency-subscription unlock as a table row (`scp dependency-subscriptions unlock`) — exported, and written outside the action closure, for the reason given on `instanceScanFloorRow`.

`updatedAt` distinguishes NEVER SET (no row — the locked default) from DELIBERATELY RE-LOCKED (a timestamp beside `unlocked: false`), which is exactly the distinction an operator needs and exactly the one a bare boolean loses. `"(never set)"`, not blank and not "now".

### §25. The verdict line of `scp dependency-subscriptions resolve`

The verdict line of `scp dependency-subscriptions resolve`. The `contributions` are printed as their own table beside it (below) — they are the answer to "WHICH level turned this off", and folding them into one cell would make the explainability surface unreadable at the exact moment it is being consulted.

`granularity`/`delivery` are guarded even though the server always sends them: a key an older or newer server omits arrives as `undefined` whatever the type says, and printing the literal `undefined` in a DELIVERY column — where the two values are "open a PR" and "merge it automatically" — is a fabrication with teeth.

`managedHere`/`managedReason` carry the server's `dependencyManagement` envelope (ADR-0032 §7d), printed BESIDE the verdict because they QUALIFY it: on a deployment that is not an explicitly declared commander, `enabled: true` is arithmetically correct and NOTHING THERE WILL EVER ACT ON IT. Guarded like the pair above, and for a sharper reason — a server that omits the key must render `-`, never a fabricated `true`, because inventing "yes, managed here" is the exact false reassurance the envelope exists to remove.

### §26. Says in words when nothing here will act on the verdict

…AND THE SAME THING IN WORDS, when nothing on this deployment will act on the verdict (ADR-0032 §7d). `undefined` means print nothing.

A `false` in a column is easy to read past, and the whole point of the envelope is that an operator reading `enabled: true` on a field outpost is being told something true and misleading at once. Printed ONLY for the refusals: a declared commander needs no caveat, and a caveat on every invocation is one nobody reads.

EXPORTED, AND OUTSIDE THE `.action()` CLOSURE, FOR THE REASON THE FORMATTERS ABOVE RECORD. This lived inline in the resolve command's Commander closure, where no test can reach it: inverting the condition — so the note prints on a healthy commander and is SILENT on the deployment it exists to warn, the one inversion that matters — left the entire suite green. `dependency-subscription-cli. test.ts` now pins BOTH directions, which is the only shape in which a conditional caveat is held.

ABSENT IS NOT A REFUSAL. A server that omits the envelope gets no note (`=== false`, never falsy): the row already renders `-` there rather than fabricating a posture, and asserting a refusal the server never claimed would be the same fabrication with a louder voice.

### §27. One backfill row, where `skipped` is a first-class column

One component's row from `scp dependency-subscriptions backfill-inventory` (M21.2, ADR-0032 §4).

`skipped` is a first-class column, not a footnote: a dependency manifest that could not be READ is deliberately left alone rather than treated as declaring nothing (unreadable is not empty), so a nonzero count means part of this component's inventory is STALE rather than wrong — and that is invisible unless it is printed.

### §28. ONE governance:move rung as a table row

ONE governance:move rung as a table row — `scp governance move-enforcement rungs`, and the per-object chain a `status`/`enable`/`disable` response carries. `depth` is present only on the per-object explain read (0 = org root, increasing toward the object); the org-wide `rungs` list walks no chain, so it prints `-` there rather than fabricating a position.

### §29. The verdict line of `scp governance move-enforcement status`

The verdict line of `scp governance move-enforcement status` — `enforced` is an OR across the instance rung and every rung on the queried object's OWN containment chain. It answers about ONE end of a move; the rungs table printed beside it (`governanceMoveRungRow`) is where "which rung" lives, because the verdict alone cannot say that.

### §30. The instance rung as a row, never blank when unset

The instance (commander) rung as a table row (`scp governance move-enforcement instance get|set`) — mirrors `dependencySubscriptionUnlockRow`'s "never set" distinction: `updatedAt: null` is the shipped default (never configured), not "disabled just now".

### §31. The response to a rung write (`enable`/`disable`)

The response to a rung write (`enable`/`disable`) — the subject, the tier it was recorded at, the resulting enabled state, and the Decision id every governance write carries (charter principle 6). `enforcement` (the resolved state AT THE SUBJECT after the write) is available on the response but not printed here — the caller already knows what it just did; `status` is where the full chain belongs.

### §32. The line both read verbs print when nothing is managed here

The one line BOTH read verbs print when the answering deployment does not manage dependencies (`dependencyManagement.managedHere === false`, ADR-0032 §7d) — and then print NOTHING ELSE of the envelope: on such a deployment an empty inventory is "nothing here ever ingested a manifest", not "declares nothing", and an empty bump list is "nothing is ever dispatched here", not "up to date", so a table there is a table of a fact that does not exist. `undefined` when dependencies ARE managed here — and ALSO when the server omitted the envelope (`=== false`, never falsy): an older server claims no posture and this must not invent one. Exported and pure so both directions are pinned (`dependency-subscription-cli.test.ts`, `dependency-read-verbs-wire.test.ts`).

### §33. The header lines of `scp dependency-subscriptions inventory`

The header lines of `scp dependency-subscriptions inventory` (M21.6) — the envelope BEFORE the rows: which component, the ingestion STAMP (M21.7), the newest ingestion Decision, and the component-level ingestion gate. Exported and pure for the reason `cli-absent-formatters.test.ts` records. The caller has ALREADY handled `managedHere: false` (see `dependencyReadNotManagedLine`); these lines describe a deployment that manages dependencies.

THE STAMP IS THE TRICHOTOMY, PRINTED AS ONE (`ingestion-stamp-repo.ts`): a null stamp is NEVER ATTEMPTED (there is no row, and only a pass writes one); `ok` with 0 rows written is "read fine — no dependencies declared" (the sentence an empty inventory could not earn before the stamp); `partial` / `unreadable` list every manifest with its per-file verdict, because the operator's next action is a file, not a component; `not_enabled` is "the gate was closed; nothing fetched". None of these is inferred from `rows` — the printer reads the stamp and says what it says. A null `lastIngestionDecision` is "no ingestion Decision exists" (never ingested, OR refused as not-enabled / not-addressable / superseded, none of which write one).

`componentGate.reason` is a THIRD vocabulary (`enabled | instance_locked | no_enabling_contribution`), distinct from a row's `subscription.reason`; it is printed under its own label so the two are never read as one.

### §34. The ingestion stamp as one line

The ingestion stamp as one line — see `dependencyInventoryHeaderLines` for the four readings. `manifests[]` is listed as `repo:path=outcome (detail)`; on `ok` the list is the receipt of what was read, on `partial`/`unreadable` it is the work list.

`lastIngestionDecision` is consulted ONLY when the stamp is absent: the stamp table (migration 0065) was created without a backfill from the `dependency_inventory_ingestion` Decisions, so a component ingested before it has a Decision and no stamp — "never attempted" would contradict the Decision line printed right under it. That case is stated as NOT STAMPED and defers to the Decision; "never attempted" is printed only when NEITHER is on record.

### §35. ONE ROW of `scp dependency-subscriptions inventory` (M21.6)

ONE ROW of `scp dependency-subscriptions inventory` (M21.6): one (major line × dependency manifest) declaration with the line's observed head and its resolved dependency subscription.

The coordinate is printed VERBATIM (`@acme/lib` is not `acme-lib`; case and punctuation decide which package an opt-out named). `resolvedVersion: null` is "the manifest pins none" and `head.latestVersion: null` is "not observed" — never "nothing newer" — both print `-`, the CLI's absent-value convention. `granularity`/`delivery` are meaningful ONLY when the subscription is enabled, so they are shown only then; an `ignored` contribution (a malformed or unevaluable opt-out that admitted to NEITHER side — it fails OPEN) is surfaced in the REASON column rather than dropped, because hiding it hides exactly the opt-out that silently did not apply.

### §36. ONE ROW of `scp dependency-subscriptions bumps` (M21.6)

ONE ROW of `scp dependency-subscriptions bumps` (M21.6): a bump SCP authored for the component.

Progress is `pullRequestNumber` (opened), `mergedAt` (the provider confirmed the merge) and the merge Decision's verdict — never the change's `state`, which sits at `proposed` for a bump's whole life. The PR column is `pullRequestUrl` when the server stored one, else `#<number>`; a URL is NEVER composed from `repo` + number (the provider is not known here, and a guessed link is a fabricated record). `mergedAt: null` prints `-`, not "open": the provider has not confirmed a merge, which is all that is known. `delivery` is what the dispatch RESOLVED TO — the first look is always `pull_request` — and `-` when no dispatch Decision is on record.

### §37. One ROW of `scp dependency-producers list`

One ROW of `scp dependency-producers list` — the declaration NAMED (server-side view, ADR-0032 §7e, dependency-subscription-ui.md §12.6 Q1): the producing component and the declaring principal by name, with the ids beside them so a name is never the only handle. `""` (an id that named no row in the org — see `namesForObjectIds`) prints as the id, never as a blank cell.

Exported and unit-tested DIRECTLY, for the reason `cli-absent-formatters.test.ts` records.

### §38. One LINE of a producer declaration's blast radius

One LINE of a producer declaration's blast radius (`scp dependency-producers declare|retract`, ADR-0032 §7e).

THE THREE COLUMNS THAT ARE NOT DECORATION:

- `subscribers` is the number of components whose repositories this act reaches. It is the whole reason declaring is a VERB with a report rather than a field write: the operator names one coordinate and affects a set of repositories the request never mentions. - `headWas` is what the observed head WAS. Both verbs clear it, and an operator needs to see the value that was discarded rather than only that something was — a wrong declaration is undone by re-observing, and knowing `2.7.0` was thrown away is how you know what to look for. - `headCleared` distinguishes "there was a head and it is gone" from "there was nothing to clear". Printing only `headWas` would render both as a blank.

Exported and unit-tested DIRECTLY, for the reason `cli-absent-formatters.test.ts` records: a mapper written inline in a Commander `.action()` closure is unreachable by any test.

### §39. WHO, by name

WHO, by name — the same set as `subscribers` counts, named server-side (one batched read, dependency-subscription-ui.md §12.6 Q1). Names, not ids: the operator reading this table is about to affect these teams' repositories, and an id is not a name they can act on. `-` when the server sent no names (an older server, or an empty radius) — never a fabricated list, and never a count that disagrees with `subscribers`.

### §40. One OPEN bump at the moment of a retraction

One OPEN bump at the moment of a retraction — a pull request SCP already opened in someone else's repository.

IT IS PRINTED BECAUSE SCP WILL NOT CLOSE IT. Retraction stops future triggers only; a dispatched bump has left SCP, and closing it from here would make SCP assert it closed a PR it did not close. This table is the operator's only list of what to go and close by hand, so the URL column prints `-` rather than composing one: `repo` + number is a github.com convention and the row does not record which provider authored the bump.

### §41. Read this before believing an empty producer list

The sentence a caller must read before believing an empty producer list, and after a write.

BOTH ARMS ARE LOAD-BEARING AND BOTH ARE TESTED. On a field outpost `dependency_line_producers` is empty BY DESIGN (declarations live at the commander, ADR-0032 §7d), so an unqualified empty table reads as "nothing is declared" when the truth is "you asked the wrong deployment". On a declared commander the note must be SILENT — a caveat printed on every invocation is one nobody reads, which is how the M21.7 inversion (`dependencyManagementNote`) went green while warning the wrong deployment.

### §42. The whole receipt of a declare or a retract

The whole receipt of a declare or a retract — the table, the note, and the in-flight bumps.

IT IS A FUNCTION, NOT INLINE IN TWO `.action()` CLOSURES, for two reasons. The tested one: a printer written inside a Commander action is unreachable by any test, and this one carries the `dryRun` banner and the open-bump table, both of which are conditional and therefore both of which have a silent-wrong arm. The other: declare and retract must print the SAME receipt, and two copies of a receipt are two receipts that drift.

### §43. `scp federation outpost reconcile`'s "what this WOULD do" lines

`scp federation outpost reconcile`'s "what this WOULD do" lines — one per live claimant, printed BEFORE the call from the very listing the `?ifClaimant=` token is derived from.

WHY THE CLI NEEDS ITS OWN PREVIEW. This verb exists to un-wedge a peer, and the operator who needs it is precisely the one who cannot use the UI (the wedged peer is what the UI fails to render). Without these lines the command went straight to the write with NO read at all: the largest unguarded window of any surface, and no preview whatsoever of a call that can adopt an entered config, discard it, or delete a row this domain authored and JOURNAL that delete downstream.

BE HONEST ABOUT WHAT THE TOKEN BUYS HERE. Between this listing and the call is a ~millisecond window, so for the CLI `?ifClaimant=` is a TOCTOU guard — NOT evidence that a human read anything. The informed-consent claim belongs to the UI, where an operator actually reads the preview and confirms. Both are worth having; this one must not be described as consent.

THE RANKING IS MIRRORED, NOT AUTHORITATIVE. The server's `byAuthority` is the only thing that decides the outcome; this reproduces its three classes (local-origin > verified replica > unverified shadow, ties in listing order) from the fields the API already publishes (`originIsSelf`, `provenance`). A drifted mirror would mis-PREDICT — which is exactly why the token exists to make a divergence a refusal instead of a surprise.

### §44. Without `--keep` the survivor is predictable only at a sole top

WITH NO `--keep`, THE SURVIVOR IS ONLY PREDICTABLE WHEN ONE ROW HOLDS THE TOP RANK ALONE. The server breaks a tie inside one authority class by `(created_at, id)`; reconstructing that here and printing it as a prediction is exactly the guess the panel refuses to make (`reconcile-default-indeterminate`), and a preview that MIGHT be wrong is worse than no preview — the whole value of these lines is that they say what WILL happen.

### §45. `scp federation outpost reconcile`'s "what happened" lines

`scp federation outpost reconcile`'s "what happened" lines (review round 6, M1). The two removal buckets on `OutpostConfigReconcileResult` are reported with DELIBERATELY DIFFERENT WORDING, and must stay that way: `removedShadowObjectIds` is a silent local tidy-up of a hand-typed copy this domain never authored (invisible to the outpost), while `removedLocalObjectIds` is THIS DOMAIN'S OWN declared config being permanently deleted — an ordinary journaled tombstone that PROPAGATES DOWNSTREAM to the outpost. Collapsing the two into one "unverified shadow(s)" sentence (the N9-era bug this fixes) told an operator who had just deleted their own config, and pushed that delete to the outpost, that they had merely cleaned up a stray copy. Exported so the CLI surface test can pin the wording gap directly rather than only via the command's `--keep` help text.

`?? []` ON BOTH BUCKETS (Z4). Both are required-not-optional on `OutpostConfigReconcileResultSchema` and BEFORE ADR-0023 the SDK validated no response, so both were bare `.length`/`.join` reads (since ADR-0023 that body rejects at the boundary). MEASURED: `TypeError: Cannot read properties of undefined (reading 'length')`. This is the WORST place in the CLI for it — the operator has just run a DESTRUCTIVE, DOWNSTREAM-PROPAGATING verb and the throw kills the entire report of what it did, so they are told NOTHING about deletes that already happened and already journaled. The web twin (`outpost-configuration.tsx`) took this guard last round for exactly that reason; the CLI half was left bare.

Absence degrades to "Removed: nothing (no surplus rows)" only when BOTH are empty-or-absent, which is the same line an all-empty result already printed. That is a reporting gap, not a fabrication: it says nothing about what the server did, and the server's own JSON is one `--output json` away.

### §46. `federates` on the default row, and why the header carries it

M25.7 — `federates`, AND THE HEADER IS THE ONLY QUESTION `objectId` CAN ANSWER
On the DEFAULT row for the same reason `liftedAt` is: `scp freeze list` on an outpost now mixes freezes that stop at this instance with freezes that ride the journal, and two rows rendering identically leave an operator to discover the difference from a 409.

THIS COLUMN WAS CALLED `federated` AND THE NAME WAS A LIE, which is the whole reason for this paragraph. It was introduced to tell an operator whether a listed freeze is one they can lift — i.e. whether it came from ANOTHER domain — and `objectId` cannot answer that. It is non-null on a commander's own federating freeze and on an outpost's replica of it alike; the fact that separates them is the OBJECT's `origin_domain_id`, which is not on this wire shape at all. A column whose header asks one question and whose value answers a different one is worse than no column: it reads as an answer.

`federates` is exactly what a non-null `objectId` supports: this freeze has a graph object, so it rides `object_upsert` to this org's peers and blocks there too. Read from the field, never inferred from role or from the presence of a peer.

TO ANSWER "CAN I LIFT THIS?", resolve the object: `--output json` carries `objectId`, and `scp object get freeze <objectId> --output json` reports `originDomainId` — a replica's is not this instance's, and `DELETE`/`PATCH` answer 409 naming that domain. Surfacing origin on the freeze row itself needs `originDomainId` on the wire (a required-nullable response field plus a join in `listFreezes`); it is deliberately NOT invented here from data that cannot support it.

### §47. `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4)

`@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4) — `scp plan` computes a diff (dry run); `scp apply` does plan + apply in one shot, since that's the natural CLI UX and what "`scp apply` twice = no-op the second time" means end to end, not two manual steps.

### §48. One `source_mappings` row as a table row

One `source_mappings` row as a table row (`scp change-source list-mappings`), lifted out of the action closure and exported for the reason `federationStatusRow` gives. Column order is the order an operator reads a rule in: what routes where, then the labels on it. `scope` (§10.6, migration 0066) prints BLANK when not declared — the printer's absent-field convention, and the honest one: no label was set, and nothing here guesses one from the site's role. `?` when the key is ABSENT (absence is not "undeclared") — DEFENSIVE ONLY: `scope` is required-nullable on the wire and the generated SDK validates every response body (ADR-0023), so a pre-0066 server's body is a contract error at the SDK boundary and never reaches this printer; what an operator actually sees against such a server is that error, not `?`. The widening stays so a hand-built row cannot crash the table (the `outpostConfigRow` lesson above), not because the `?` is reachable through the SDK.

### §49. Every collection the plan diff can emit, as a closed union

EVERY collection `computePlanDiff` can emit, and the union is the point: a collection that is computed, counted in `summary`, but missing here is a change the operator approves without ever being shown it. `printPlanResult` spreads all of them, and the `never` arm below is what makes "add a collection, forget the table" a TYPE ERROR rather than a silent omission — which is how `placements`, `producers` and `governanceMoveRungs` each went unprinted for a while.

### §50. Every collection flattened into the rows `scp plan` prints

EVERY collection the diff can carry, flattened into the rows `scp plan` prints. Exported so the "nothing computed is invisible" property is testable without capturing stdout.

All but the first two are optional on the wire (a plan stored before the collection existed has no key; for `producers` and `governanceMoveRungs` an absent key additionally means "this stack manages none") — but every one that IS present must be PRINTED, or a plan whose only content is bindings, placements, producers or rungs shows an EMPTY table under a NON-ZERO summary, and an operator approves a diff they were never shown. Sharpest for a rung `delete`: it turns off a governance bar whose only symptom is an absence of refusals, so no later signal catches it.

### §51. Prints an apply summary

Prints an apply summary — `--output json` gives a flat, machine-parseable `{creates,updates,deletes,noops}` shape (not just prose), which is what makes DoD (b)'s "`scp apply` twice = no-op" assertable from a test (plans.cli.integration.test.ts).

### §52. `scp iac render`'s `--output json` shape

`scp iac render`'s `--output json` shape — one entry per `RenderedPipeline` plus the SAME honesty disclaimer the text picture always carries (D21(d)): JSON output is not exempt from "the picture must be the truth" any more than the table/comment-block form is, so it is echoed here too rather than dropped as prose only the human-readable path bothers with.

### §53. Renders a Change's coupled-pipeline wait status (M12 P4B)

Renders a Change's coupled-pipeline wait status (M12 P4B) — the shared body of `scp change explain` (embedded, alongside plan/Decisions) and `scp change wait-status` (standalone). `null` means the change declared no `requires`; a `wait-status` caller wants an explicit line for that case (there is nothing else on the screen to say so), `explain` silently omits the section instead (unchanged since Phase 4's `explain` support landed) — hence the `standalone` flag.

### §54. Derived from `outstanding`, not `waitStatus.waiting` alone

Derived from `outstanding`, not `waitStatus.waiting` alone: `waiting` reflects the change's STATE (`state === "waiting"`), which is false for a change read before it ever parked (still `coordinated`/`proposed`) or after it released (`executing`/`validating`/`accepted`) — either of which can still have an outstanding row (a not-yet-evaluated requirement, or a provider that was cancelled after release). Heading off `waiting` alone would print "all satisfied" over a row printing OUTSTANDING.

### §55. A change's stage-dependency status, kept a separate section

ADR-0028 increment 4 — a Change's STAGE-DEPENDENCY status, the second and deliberately separate section of `scp change explain` and `scp change wait-status`.

WHY A SIBLING SECTION AND NOT A WIDENING OF `printWaitStatusBody`. The two couplings answer different questions and are keyed differently: `requires` is `{key, at}` and parks the WHOLE change in `waiting`, whereas a stage dependency is (component x deployment-target) and withholds ONE wave target's trigger while the change stays `executing`. A change can be in either, both or neither. The server made the same call one layer up — `stageDependencyStatus` is a sibling field on `explain`, not a widening of `waitStatus`, whose `requirements[]` shape two consumers already read.

EXPORTED, AND RETURNING LINES INSTEAD OF PRINTING THEM, for the reason `cli-absent-formatters.test.ts` sets out at length: a renderer that is module-private — or worse, inline in a Commander `.action()` closure — is unreachable by any test, and every one of the ten guards that survived last round's mutation sweep lived in exactly that position. This is the surface an operator reads at 2am; it is pinned directly.

EVERY FIELD HERE IS LIVE. The server re-runs reconcile's own predicate per request rather than reading back the pinned `stage_dependency` Decision — which is never cleared when a hold releases, and whose kind ALSO carries a promotion-import `allow`. So "HELD" below means held right now, and stops saying so the moment the dependency lands, with no clearing row to wait for.

### §56. THE TWO ABSENCES ARE DIFFERENT CLAIMS AND ARE NOT COLLAPSED

THE TWO ABSENCES ARE DIFFERENT CLAIMS AND ARE NOT COLLAPSED (which is why this does not reach for `isAbsent`, whose job is the opposite — to stop the two being told apart *by accident*). `null` is the server saying "this change coupled nothing"; an omitted key is the server saying nothing at all, which is contract-legal for an `.optional()` field and is exactly what a pre-increment-4 server puts on the wire. Printing "coupled nothing" for the second would be a fabricated observation about a change that may well be held.

### §57. The printing half of `formatStageDependencyLines`

The printing half of `formatStageDependencyLines` — shared by `explain` (embedded) and `wait-status` (standalone). The blank separator is unconditional because this section is never first on the screen: `explain` has printed the change line above it, and `wait-status` has printed the `requires` section, which always emits at least its "(no coupled-pipeline prerequisites)" line. `standalone` therefore governs only whether an ABSENT status is worth a line of its own.

### §58. Prints a Change's compiled plan

Prints a Change's compiled plan (waves/targets) and every Decision made about it, in order — the CLI's window into the coordination engine's reasoning (BUILD_AND_TEST.md §8 M3 DoD: "`scp change explain` renders" the Decision record). Deviates from `printResult`/`printTable` (which assume flat rows), same as `printPlanResult`/`printApplyResult` above and for the same reason — this shape (a change, an optional plan tree, an ordered decision list) isn't a table.

### §59. Prints a Campaign's compiled plan

Prints a Campaign's compiled plan (waves/targets, each resolved to its member Change) and every Decision made about it — the campaign-scoped analogue of `printExplainResult` above (M5, DESIGN.md §9.5). Same shape deviation from `printResult`/`printTable` and for the same reason.

### §60. Prints a Campaign's per-target adoption verdicts

Prints a Campaign's per-target adoption verdicts (M25.5, `scp campaign adoption <id>`) — the campaign-scoped answer to "has each of this campaign's components migrated yet?", derived live at read time. Same shape deviation from `printResult`/`printTable` as `printCampaignExplainResult` above, and for the same reason: this is one object with array fields, not a list of rows.

### §61. Drives the CLI side of the device authorization flow

Drives the CLI side of the device authorization flow (BUILD_AND_TEST.md §8 M2 item 3): starts the request, prints the code+URL for the human to open in a browser, then polls at the server-suggested interval until a token, a denial, or expiry — capping total wait at the request's own `expiresIn`. `authorization_pending` is expected/normal while the human hasn't approved yet; every other device-flow error code is terminal.

### §62. M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1). All 8 resources

M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1). All 8 resources — domain/service/ component/deployment-target/team/group/user/service-account — expose the exact same create/list/get/update/delete/upsertByUrn shape (ScpClient.typedResource), and the 4 `owns`-eligible + 2 `consumes`/`depends_on`-eligible resources add ownership/edge methods on top. These three factories build the `register`/`list`/`get`/`update`/`delete`/`upsert` and `add-owner`/`add-consumes`/`add-depends-on` command families once, instead of hand-copying them per resource — mirroring routes/typed-registries.ts and routes/ownership.ts server-side.

### §63. Registers the register/list/get/update/delete verb family

Registers `scp <name> register|list|get|update|delete|upsert`, options mirroring `object create`/`object list`/etc. exactly. Returns the resource's top-level `Command` so callers can attach `add-owner`/`add-consumes`/`add-depends-on` families on top where applicable.

### §64. Routed through the generic object resource, since name is type

Routed through the GENERIC object resource rather than the typed one, because `name` here IS the type id ("service", "deployment-target", …) and publish has exactly one endpoint — `POST /objects/{type}/{idOrUrn}/publish`. The typed SDK namespaces wrap per-type routes that have no publish counterpart, so adding a method there would mean six call sites threading a type string to reach the same generic operation this reaches directly.

### §65. RBAC — roles, bindings, effective permissions

RBAC — roles, bindings, effective permissions (role-model.md §5 steps 5, 6, 10)

Until this existed the whole roles milestone was reachable only by hand-written HTTP: granting a role, authoring a custom one, mapping a group to an IdP claim. Charter principle 3 is API -> SDK -> CLI -> IaC -> UI and this is the CLI rung.

### §66. Instance-tier operator credentials

Instance-tier operator credentials (role-model.md §5 step 9)

Named, hashed, individually revocable replacements for the single shared SCP_OPERATOR_TOKEN. All three verbs carry `x-scp-operator-token` — including the LISTING, which discloses how many credentials exist and when each was last used.

### §67. IdP group mapping (SSO groups)

IdP group mapping (SSO groups) — the one surface that was a RAW PROPERTIES WRITE

Tagging a group with `externalIdentity.claimValue` is a `PATCH /groups/{id}` carrying a nested object. That is not something to ask an administrator to hand-write, and getting the property name wrong fails silently — an unmapped group is simply never synced. These commands own the shape so the operator names only the group and the claim.

### §68. `scp component scan-requirements <idOrUrn>`

`scp component scan-requirements <idOrUrn>` — M22.8, charter principle 3 (API -> SDK -> CLI).

WHICH SCAN RULES ARE IN FORCE for this component: the resolved six-tier severity ceiling with every tier that contributed to it, and which exclusion classes are admitted and where a clause of each would take effect.

THIS IS THE POLLABLE ONE. `scp policy evaluate` runs the real orchestrator and writes a Decision row per invocation with no write suppression; a watch loop on it recreates the amplification ADR-0024 §D0 exists over. This command reads and writes nothing.

The table view answers the one question that has no other answer today — "will the exclusion I am about to author do anything?" — by printing each class's `effectiveAtTiers`. An EMPTY column there is the shipped default (admission is empty at every tier) and is the state that was previously invisible from every surface.

### §69. Repair only what this command can delete through an audited door

REPAIR ONLY WHAT THIS COMMAND CAN ACTUALLY DELETE THROUGH AN AUDITED DOOR.

Relationships have one (`DELETE /relationships/{id}`), and it works even when an endpoint is dead. The projection rows do NOT have an id-addressed door — `deleteMapping` matches on the identity TUPLE and the binding door addresses its target object — so repairing them from this report's `id` alone is not possible today. Rather than reach past the API into SQL, this command repairs the edges and NAMES the rest, with the count, so the output can never read as "all clean" when it is not.

### §70. doctor — read-only operational self-checks

doctor — read-only operational self-checks (`GET /doctor`).

Sibling of `scp graph integrity` in spirit: a report, never a repair. The distinction from `pnpm doctor` (scripts/doctor.mjs) is deliberate and worth keeping straight — that one checks the TOOLCHAIN on a developer's machine and never opens a database; this one checks a running INSTANCE's state, over the public API like everything else in this CLI.

### §71. plan / apply

plan / apply (`@scp/iac` server-side plan/apply — BUILD_AND_TEST.md §8 M2 item 4). A manifest file is what `@scp/iac`'s `synthToFile` writes (or any hand-authored/CI-generated JSON matching `DesiredStateManifestSchema`) — the CLI never imports/executes a user's IaC TypeScript program directly, only the synthesized manifest (DESIGN.md §15).

### §72. `scp iac render` (team-pipeline-iac.md D21(d), §12)

`scp iac render` (team-pipeline-iac.md D21(d), §12) — regenerates the human-readable pipeline picture from a SYNTHESIZED manifest. Deliberately OFFLINE (no `clientFromStoredCredentials`, no `--base-url`): D21(d)'s own honesty requirement is that render states plainly what it CANNOT know from a manifest alone (`@scp/iac`'s `render.ts` module doc), which is only true if it never reaches for a network call to paper over that gap. `--write` is committed, drift-checkable codegen — the same convention `scp gen`'s SDK output and `products.ts`'s D20 module both follow.

### §73. `scp iac export` (team-pipeline-iac.md §9/D5)

`scp iac export` (team-pipeline-iac.md §9/D5) — reverse-generates `@scp/iac` construct code (or the synthesized manifest) from a service's LIVE subtree, over the already-generated SDK's own read verbs (`services.get`, `relationships.list`, `components.get`, `placements.list`, `deploymentTargets.get`, `changeSources.listMappings`, the generic `object(type).get`) — the onboarding path for the homelab's ~50 imported components and 61 placements, and for any org bringing an existing estate in (D5). ONLINE (reads the live graph); `--format` picks the shape.

### §74. `scp iac scaffold` (team-pipeline-iac.md §7/D1, ADR-0047)

`scp iac scaffold` (team-pipeline-iac.md §7/D1, ADR-0047) — runs the existing `discovery/run` (unchanged; only `discovery/accept` is retired, and not by this increment) and renders the proposal as construct code, GROUPED into services BY FLAG (ADR-0047: "the grouping decision... requires a human, and accept is the one point in the flow where no human is present" — this command is where that human acts instead). `--repo-pr` (opening a PR against the config repo) is OUT OF SCOPE here — it needs a git-provider WRITE path, a different capability class; this command only ever writes local files or stdout.

### §75. The change and decision command family

change / decision (M3 Change Coordination Engine — DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). `scp change propose` submits a Change against >=1 target object (usually components/services/deployment-targets); the engine compiles a wave plan from their `depends_on` edges (or an explicit `--topology`), gates each state transition behind policy Decisions, and executes waves via executor plugins. `scp change explain` is the CLI's window into that reasoning — the compiled plan's waves/targets plus every Decision made about the change, in order. `decision get/list` are read-only: Decisions are written by the coordination engine itself (policy/guard verdicts), never created directly via the CLI.

### §76. Both keys: one alone hid a change held with no requires

BOTH KEYS. This branch printed `result.waitStatus` alone until increment 4, so a change held by a stage dependency that declared no `requires` — the common ADR-0028 shape, since the two couplings are independent — printed the literal `null`. The scripted path would have gone on reporting "nothing is holding this" while the table path said HELD. `stageDependencyStatus` is passed through UNNORMALISED: `JSON.stringify` drops an omitted key, so an older server's silence stays silence here rather than being dressed as `null`.

### §77. Federation audit witness (multi-region-instance-resilience.md §7.2.7)

Federation audit witness (multi-region-instance-resilience.md §7.2.7) — the post-failover runbook's peers-witness comparison (resilience.md §7.2 step 5): `scp audit verify` alone cannot see a truncated chain (any prefix of a valid hash chain still verifies), so this reads what THIS domain earlier witnessed of an origin peer's audit-chain head, for comparison against that origin's restored `scp audit verify` head after a failover.

### §78. M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10)

M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN.md §10): policy/control documents (typed-registry resources — same CRUD family as domains/services/etc.), approvals (N-of-M quorum), freezes, and `scp policy evaluate`'s dry-run gate check.

### §79. M25.1 — THE EXITS

M25.1 — THE EXITS. `scp freeze` was create/list/get, so an operator could declare a freeze and had no way to take it back: the only escapes were `scp change cancel` / `scp change rollback`, which throw the RELEASE away rather than lifting the FREEZE. Since M25.2's per-target admission that is worse than waiting — a mistyped `--ends-at` year now holds a SUBSET of a wave's targets while the siblings have already shipped.

### §80. WHAT LIFTING COSTS

WHAT LIFTING COSTS (M25.9 / owner ruling D1(a-ii), 2026-08-25): * YOUR OWN freeze — `freeze:write` at the freeze's own scope, the same permission that declared it. Your own mistake stays yours to undo, or `scp freeze create` would be an entrance with no exit for the very role that uses it. * A freeze ANOTHER ACTOR declared — that PLUS the Owner-only `freeze:override`, at the freeze's own scope. Retracting someone else's protection for everyone it covers costs the same permission that admits one change past it (`scp change accept --override-freeze`). Expect a 403 naming `freeze:override` if you hold only the first.

Scope expands UPWARD only: `freeze:override` bound at a service lifts that service's freezes and never the org-root freeze that covers everyone.

### §81. WHAT EACH DIRECTION COSTS

WHAT EACH DIRECTION COSTS (M25.9 / owner ruling D1(a-ii), 2026-08-25) — the two are NOT the same price, and the server decides from the direction it computes under the row lock: * SHORTENING — it ends the protection early for everyone the freeze covers, which is `lift` with a different record, so on ANOTHER ACTOR'S freeze it takes the Owner-only `freeze:override` on top of `freeze:write`, at the freeze's own scope. Gating `lift` alone would have left the retraction one `update` away. On your own freeze it stays `freeze:write`. * EXTENDING — it ADDS protection and takes nothing from anyone the freeze covers, so it stays `freeze:write` whoever declared the freeze. So does re-sending the `endsAt` it already has.

(A FEDERATING freeze is the one case where extending is the sharper direction, because it grows a block inside another security domain — that is a separate `federation:write` bar, and both apply.)

### §82. campaign (M5 Campaigns — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5)

campaign (M5 Campaigns — DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). A Campaign coordinates many Changes across targets, wave by wave, over the SAME plan compiler a Change uses; unlike Change, it has no accept/cancel verbs — `status` is always a pure derived field, so `campaign status <id>` (its `get`) IS the CLI's window into that field.

### §83. M25.6a (owner decision D4) — SET, MOVE or CLEAR the deadline

M25.6a (owner decision D4) — SET, MOVE or CLEAR the deadline. `--clear` is THE BLUNT EXIT: it releases every target the deadline was withholding this campaign's fan-out from, on the next tick, with no unlock verb. `scp campaign deadline-override` (M25.6b) is the per-target one: narrower radius, same permission on the widening acts, and it leaves the deadline standing.

WHAT EACH ACT COSTS (owner ruling 2026-08-25, D1 b-i): * `--at <iso>` SETTING a first deadline, or SHORTENING an existing one — plain `object:write` at the campaign. Both withhold this campaign's changes from strictly MORE targets, so neither can launder a waiver, and routine campaign hygiene must not need an Owner. * `--clear`, or `--at <iso>` naming an instant LATER than the one stored — `object:write` PLUS the Owner-only `campaign:deadline-override`. Both release targets that were being withheld, and clearing is a strict superset of waiving one target, so it cannot cost less than `deadline-override` does. Expect a 403 naming that permission if you hold only the first.

`--reason` is required on ALL THREE acts, clear included: it is the operator's own words on the hash chain, beside a Decision carrying the previous instant.

### §84. M25.6b (§4.5) — WAIVE the deadline for NAMED targets

M25.6b (§4.5) — WAIVE the deadline for NAMED targets: excuse one laggard without clearing the deadline for everybody, which is all `deadline --clear` can do.

Takes `campaign:deadline-override` (Owner-only) AT THE CAMPAIGN plus `object:write` at each named target. `--target` is REPEATABLE; omitting it waives every target the campaign declares, which is still not the same act as clearing — the deadline stands, each waiver is audited separately, and `--until` expires them one by one.

`--until` is a BOUNDARY with READ-TIME expiry: past it the deadline applies again on the next tick with no job to run. An instant already in the past is accepted, stored and audited, and is simply not effective — which is the honest outcome rather than a special case.

### §85. instance scan-floors (M17.5 — ADR-0016)

instance scan-floors (M17.5 — ADR-0016). The two ABOVE-org tiers of the six-tier, most-restrictive-wins scan-requirement chain: platform -> trust domain (partition) -> org -> containment domain -> service -> component These are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an OPERATOR action gated by the deployment's SCP_OPERATOR_TOKEN — never a tenant role, however privileged inside its own org. Reading is an ordinary authenticated call, because a gate you cannot inspect is not explainable.

`trust-domain` is the AMBIENT FEDERATION boundary (a partition) above org — NOT the intra-org containment `domain` object type below org (`scp domain ...`). Different concepts; the stored tier literal is `trust_domain`, never bare `domain`.

### §86. instance scan-exclusion-admissions (M22.9 — ADR-0033 §1, §7a)

instance scan-exclusion-admissions (M22.9 — ADR-0033 §1, §7a). The two ABOVE-org rungs of the exclusion dimension's monotone AND: a clause authored at any tier has effect only if EVERY represented tier strictly above it admits that clause's CLASS, and `platform` + `trust_domain` are ALWAYS represented. No policy can contribute those two — a policy anchors at a graph object and the containment chain is org-rooted — so with this table empty (the shipped default) every exclusion clause on the deployment is inert. This command is how an operator changes that.

The five org-and-below rungs are NOT here and need nothing: they admit through the ordinary `scanExclusion` policy effect (`scp policy create ... {"scanExclusion":{"admit":[...]}}`).

`set` REPLACES the admitted set for the tier, so withdrawing everything is `--revoke-all` rather than simply omitting `--class` — omitting it is refused, because an empty set at an instance rung makes every exclusion clause on the deployment inert and that is not something to reach by forgetting a flag.

### §87. THE DESTRUCTIVE DEFAULT, MADE EXPLICIT

THE DESTRUCTIVE DEFAULT, MADE EXPLICIT (owner decision, 2026-08-18).

`set` is a whole-set REPLACE, and that is the right server contract: an additive verb would make withdrawal the harder operation on a LOOSENING, which is the wrong way round. But it means `--class` omitted sends `classes: []`, and an empty admitted set at an instance rung makes EVERY exclusion clause on the deployment inert — every org, every tier beneath it — because the monotone AND fails at the top. That is a bigger blast radius than any other single CLI call in this tool, and it was reachable by forgetting a flag.

The server contract is unchanged; this refusal is CLI-side only. `--revoke-all` is the withdrawal path and it says what it does.

### §88. instance scanner-assignments (M13.3a — ADR-0020 §2)

instance scanner-assignments (M13.3a — ADR-0020 §2). The executor Type -> managed scan method(s) registry the commander's promotion scan step selects scanners from. Keyed on the EXISTING ExecutorType taxonomy (image|rpm|deb|npm|maven|python|go|chart|vm-image|infrastructure|configuration). Like scan floors these are INSTANCE-scoped: they bind EVERY org on the deployment, so authoring one is an OPERATOR action gated by SCP_OPERATOR_TOKEN — never a tenant role. Reading is an ordinary authenticated call. An empty methods set CLEARS the assignment (that Type produces no managed evidence — fail-closed: E6 refuses unless org-pipeline evidence covers the digest).

### §89. scan-db (M13.3b-ii — ADR-0020, proposal §13.3b)

scan-db (M13.3b-ii — ADR-0020, proposal §13.3b). The commander's managed-scan vulnerability DB: `status` + `staleness-policy get` are ordinary reads (a promotion blocked for a stale DB must be explainable); `staleness-policy set`, `refresh` (connected skopeo-pull), and `load` (air-gap cosign-signed blob) bind every org and are OPERATOR actions gated by SCP_OPERATOR_TOKEN.

### §90. dependency-subscriptions (M21.3 — ADR-0032 §3a, §6)

dependency-subscriptions (M21.3 — ADR-0032 §3a, §6). Enablement is a monotone AND:

```text
  effective_enabled(component, line) =
      instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
```

`unlock` is an ordinary read (a team whose subscription is inert because the DEPLOYMENT never opened the feature must be able to see that — charter principle 6); `set-unlock` binds every org and is an OPERATOR action gated by SCP_OPERATOR_TOKEN, never a tenant role. `resolve` is the explainability surface: it prints the verdict AND the per-tier contributions that produced it.

THERE IS NO `subscribe` VERB, AND ONE MUST NOT BE ADDED. A dependency subscription IS a `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a), so it is authored with `scp policy register` — the same command, versioning and federation path every other policy uses. `scp dependency-subscriptions --help` says so out loud, because the first thing someone will look for here is the verb that does not exist.

### §91. M21.2 (ADR-0032 §4) — the inventory backfill

M21.2 (ADR-0032 §4) — the inventory backfill.

Ingestion is event-driven: an accepted, correlated change re-reads its component's dependency manifests. That covers components that RELEASE and nothing else, so an existing estate — and any component that has not pushed since it was enabled — needs this once. Idempotent, so running it twice is a no-op, and it reports every skip rather than a bare count.

POINT IT AT THE COMMANDER. All dependency automation is commander-only (ADR-0032 §7d), so an instance whose `SCP_FEDERATION_ROLE` is not an explicitly declared `commander` answers 409 with a detail naming why — including the fail-closed case where the role was never declared at all. It is said in the description because that 409 is a mistake an operator makes when choosing `--base-url`, not a mistake in the request, and the flag is right here.

### §92. The `governance:move` lattice, top-down and monotone

governance move-enforcement (governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18) — the `governance:move` LATTICE: a top-down monotone OR of enabled RUNGS (the instance, or one container object — org root, containment domain, service, assembly) that decides whether a containment move ALSO requires `governance:move`, at-or-above BOTH the moved object and the destination. Nothing is enforced until a rung is enabled — every deployment ships with none, and `status`/`rungs` say so honestly.

AN UPPER RUNG CANNOT BE UNDONE BELOW IT. `disable` answers 409 while an ancestor's rung (or the instance rung) is still enabled, naming it — see `governanceMoveRungWriteRow`'s note on why a "successful" disable that left the subtree enforced anyway would be worse than refusing.

THE INSTANCE RUNG IS OPERATOR-ONLY (SCP_OPERATOR_TOKEN) — never a tenant role — because it ACTIVATES enforcement for every org on the deployment (owner ruling Q1-A; contrast the dependency-subscription unlock, which only PERMITS). `rungs`/`status`/`instance get` are ordinary tenant reads; `enable`/`disable` need `policy:write` at-or-above the subject.

### §93. dependency-producers (ADR-0032 §7e)

dependency-producers (ADR-0032 §7e) — WHICH COORDINATES THIS ORG PUBLISHES.

This is the switch between two entirely different head ingresses. A DECLARED coordinate's versions come from the org's own production releases; an undeclared one's are fetched from a public index. Getting it wrong fails in both directions and both are silent:

```text
- declare a coordinate you do NOT publish -> it leaves the third-party poll permanently, and
  every subscriber stops receiving upstream versions INCLUDING SECURITY RELEASES. There is no
  error, because the failure is an absence.
- fail to declare one you DO publish -> the coordinate is polled against a public index, and
  a stranger's package answering `9.9.9` bumps every subscriber onto it, on a daily timer.
```

SO `--dry-run` IS ON BOTH WRITE VERBS AND IS THE FIRST THING TO REACH FOR. It prints the same blast radius and writes nothing.

THERE IS NO `--producer none`. Retraction is its own subcommand: a flag that switches a verb between declaring and undeclaring is how an omitted value becomes a destructive default.

POINT IT AT THE COMMANDER. The writes are commander-only (ADR-0032 §7d) and answer 409 elsewhere; the read works anywhere but is empty by design on a field outpost.

### §94. The federation command family, over bundle files on disk

federation (M6 Federation Basics — DESIGN.md §13, BUILD_AND_TEST.md §8 M6). `export`/`import` work on `.scpbundle` files on disk (the built-in file transport — "the air gap is the design center", §13) so they're the ones CI's two-domain E2E drives via a real file-copy across an isolated compose network. `promote` is the Promotion Bundle's own export verb — kept distinct from `export` (which only ever produces sync bundles) so the CLI surface mirrors the two distinct bundle kinds `packages/schemas/src/federation.ts` defines.

`scp federation promote` KEEPS its name (ADR-0021 D1/D2/D5 scope note): it is a genuine promotion — an already-built artifact advancing to the next step. The change-lifecycle approval gate that used to share the word is now `scp change accept` (D5). The two verbs are deliberately different words for deliberately different things; do not unify them.

### §95. M16.2 phase A (E4) — `scp federation peer-update`

M16.2 phase A (E4) — `scp federation peer-update`: the NARROW, TRANSPORT-ONLY peer edit.

DELIBERATELY A SEPARATE COMMAND FROM `pair`, not a flag on it. `pair` is a re-pair: it REQUIRES `--public-key`, and a different value there is a KEY ROTATION that supersedes the peer's current key window and hard-revokes the old key. This command takes no key flag at all, so "I just want to fix the base URL" can never become a trust-anchor rotation. Rotating a key remains an explicit `scp federation pair --public-key <new>`.

### §96. M16.2 phase A (E1) — `outpost` config objects

M16.2 phase A (E1) — `outpost` config objects: the commander-authored declared config that SYNCS DOWN (a peer ROW never can — the journal has no peer-shaped entry kind). Commander-side commands; on an outpost these read the local read-only replica, and a write there is refused with 409.

### §97. THE HELP TEXT IS DERIVED FROM THE SCHEMA, NOT RETYPED

THE HELP TEXT IS DERIVED FROM THE SCHEMA, NOT RETYPED (review round 5, N1). The first cut of the tier enum was `commercial|fedramp-high|il5`; ADR-0022 widened it to the glossary's five members, and every OTHER site was corrected while these two option descriptions kept listing the old three — the only place an operator ever reads the list. An operator enrolling a GovCloud outpost was told no value existed for it, and pushed to either leave the tier unknown or assert `commercial`: the INVENTED POSTURE this milestone exists to prevent. Joining the enum's own members here makes that drift structurally impossible; `outpost-cli-surface.test.ts` pins it.

### §98. THE RECOVERY VERB, ON THE ONLY SURFACE ITS OPERATOR CAN REACH

THE RECOVERY VERB, ON THE ONLY SURFACE ITS OPERATOR CAN REACH (review round 5, N2). Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and this verb exists precisely so somebody can UN-WEDGE a peer whose database holds duplicate `outpost` objects. That operator is the one person who cannot use the UI for it — the wedged peer is exactly what the UI fails to render — so of all the verbs this milestone added, `reconcile` is the one that most needs a command line.

### §99. M15.5(c) — the retrans validate-then-relay

M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). `relay` runs on the RETRANS-role instance: pull + validate the imported promotion's authorized artifact bytes and build the signed byte tarball in the server's SCP_RELAY_OUT_DIR drop directory. The tarball crosses the CDS out-of-band (a file walk, exactly like `.scpbundle`); `relay-import` runs on the DESTINATION outpost to verify it and push the bytes into the local registry by digest.

### §100. M13.1b — the auto-relay build ledger's OPERATOR READ SURFACE

M13.1b — the auto-relay build ledger's OPERATOR READ SURFACE (owner ask): see queue depth and exhausted rows without DB surgery. ROLE-AGNOSTIC BY CONSTRUCTION (relay-builds-repo.ts's `listRelayBuilds` doc): rows exist only on a `role: retrans` instance, seeded at promotion import there; on any other role the table is honestly empty, so this never 409s on role — an empty table is the truth, matching every other read surface in this codebase. Mirrors docs/runbooks/retrans-relay.md's "Seeing queue depth and exhausted rows without database surgery" section, including its exit from `exhausted`.

### §101. M7: Real Executor Integrations

M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12) — secrets, executor/ notification bindings, plugin manifests, discovery run/accept, webhook signing secrets, and `scp change report` (Terraform Mode 1's `--plan-json` CLI step).

### §102. `scp connect` (M12 P4)

`scp connect` (M12 P4) — one command to register an execution system SCP will coordinate (Mode A / BYO): stores the token, creates the `execution-system` object, and best-effort validates connectivity. Wraps `secret put` + `object create` so an operator doesn't hand-craft the properties JSON. After this, `scp discovery run --module argocd-discovery` imports the apps.

### §103. Credential locality: `connect` chooses where it lives

CREDENTIAL LOCALITY. `connect` is the moment the operator chooses where this system's credential lives, and nothing used to say so — you found out by reading the secrets table.

A single commander coordinating several places is a legitimate topology, and the RIGHT default (charter principle 7 orders Simplicity above Federation; a second instance means a second database and a small PKI). But it has one consequence worth stating out loud: this token now lives HERE, so anyone with access to this instance can reach that system. That is fine when this instance is at least as protected as the system it controls, and is exactly the case where an outpost earns its cost when it is not.

Printed as a NOTE, not a warning: it is unconditionally true rather than a problem, and dressing a fact as an alarm is how operators learn to skim output. `federation.self()` is best-effort — a connect must not fail because we could not decorate its success.

### §104. `scp discovery backfill-mappings` IS GONE with the route it called

`scp discovery backfill-mappings` IS GONE with the route it called. It repaired the ~50 argocd components imported through `discovery/accept` before discovery emitted source mappings. That population is CLOSED — accept is gone (ADR-0047), so no door can create a mapping-less component any more — and the repair path for one that predates the change is now to adopt it into a stack (`scp iac export` carries existing mappings) and declare the source in the manifest, which the ordinary `sourceMappings` collection reconciles on apply.

## `packages/cli/src/client-factory.ts`

### §105. Resolves the base URL for `scp login`

Resolves the base URL for `scp login` (both password and device flows), with precedence: explicit `--base-url` flag > `SCP_API_URL` env > saved credentials.json baseUrl > localhost default.

`login` can't use `clientFromStoredCredentials` (there's no token yet), but it should still honor a baseUrl the user already has saved — so a plain `scp login` against a remote instance targets that instance instead of silently hitting localhost.

## `packages/cli/src/connect-argocd-cli.test.ts`

### §106. `scp connect argocd`'s printed "Next:" hint

`scp connect argocd`'s printed "Next:" hint. `scp discovery accept` was removed with the route it called (ADR-0047, commit c7aa2a9) and replaced by `scp iac scaffold`, but the hint kept pointing at the gone command — an operator following it verbatim would hit "unknown command". This pins the CURRENT hint text: `scp iac scaffold --from <executionSystemId>`, and that neither the removed command name nor the old multi-flag `discovery run` invocation appears anywhere in it.

## `packages/cli/src/dependency-producer-cli.test.ts`

### §107. The CLI half of the producer declaration

`scp dependency-producers` — THE CLI HALF OF THE PRODUCER DECLARATION (ADR-0032 §7e).

Charter principle 3 is API → SDK → CLI, so a capability that stops at the SDK is a parity hole. What only this layer can hold:

1. **THE THREE VERBS EXIST, AND `--dry-run` IS ARGUMENT-LESS ON BOTH WRITES.** A `--dry-run <bool>` with a default is how "the operator said nothing" silently becomes a value, and here the two values are "look" and "change every subscriber's upstream". The list is CLOSED, because a fourth verb that quietly retracted (a `--producer none`) would be exactly the destructive default the API refused to build.

2. **THE FORMATTERS ARE HONEST ABOUT ABSENCE AND ABOUT WHAT WAS LOST.** They are exported and called DIRECTLY here for the reason `cli-absent-formatters.test.ts` records at length: a mapper written inline in a Commander `.action()` closure is unreachable by any test, so its guards are correct and completely unheld.

3. **THE `dependencyManagement` CAVEAT IS HELD IN BOTH DIRECTIONS.** M21.7's measured failure was an inline note whose condition, when inverted, warned the healthy deployment and went SILENT on the one it exists for — with the whole suite green. A conditional caveat is only held when both arms are pinned.

## `packages/cli/src/dependency-read-verbs-wire.test.ts`

### §108. The read verbs' action bodies really do call the SDK

WHAT THIS FILE PINS THAT `dependency-subscription-cli.test.ts` CANNOT: that the two M21.6 read verbs' ACTION BODIES actually call the SDK and feed the printers.

The closed-list test proves `.command("inventory")` / `.command("bumps")` are REGISTERED, and the pure printers are unit-pinned; but a Commander `.action()` closure is unreachable from either. A mutation that inserted `return;` as the first statement of BOTH actions left the whole package green (116/116) — the M21 lesson ("component built, never installed") one layer down. So here the commands are DRIVEN through `buildProgram().parseAsync([...])` against a stubbed SDK (the `outpost-reconcile-precondition.test.ts` pattern): what the verb asked the SDK for, and what it printed off the answer, are the assertions.

MUTATIONS WATCHED TO FAIL: `return;` before `clientFromStoredCredentials` in the inventory action → both inventory cases RED (no SDK call, no header, no row); the same in the bumps action → both bumps cases RED; restored.

## `packages/cli/src/dependency-subscription-cli.test.ts`

### §109. M21.3 — THE CLI HALF OF THE ENABLEMENT SURFACE

M21.3 — THE CLI HALF OF THE ENABLEMENT SURFACE (ADR-0032 §3a/§6).

Charter principle 3 is API → SDK → CLI, so a capability that stops at the SDK is a parity hole. Three things need a witness here:

1. **The three commands exist and carry the right shape** — in particular `set-unlock` takes TWO mutually exclusive flags rather than one defaulted boolean, because absent never means enabled (ADR-0032 §6) and a defaulted boolean flag is precisely how an omission becomes a value.

2. **There is NO `subscribe` verb, and the help says where to author one instead.** A dependency subscription IS a `dependencySubscription` policy effect (ADR-0032 §3a); a bespoke CLI verb would be a second authoring path for one concept. The ABSENCE is the guarantee, and an absence is exactly what nobody notices regressing.

3. **The formatters are honest about absent values, and about which level decided the verdict.** They are exported and called DIRECTLY here for the reason `cli-absent-formatters.test.ts` records at length: a mapper written inline in a Commander `.action()` closure is unreachable by any test, so its guards are correct and completely unheld.

### §110. A CLOSED list on purpose

A CLOSED list on purpose: there is still no `subscribe` verb, and there must not be — a subscription is a `dependencySubscription` effect on an ordinary policy (ADR-0032 §3a), so a bespoke one here would be a second authoring surface for one concept. `backfill-inventory` is not that: it authors nothing, it reads manifests an enabled component already declares. `inventory` and `bumps` (M21.6) are READS of the component-scoped read surface — they author nothing either. This list is also the DELETE-THE-WIRING gate for those two verbs: remove either `.command(...)` registration and this assertion dies.

### §111. THE OPERATOR-FACING CAVEAT, HELD IN BOTH DIRECTIONS

THE OPERATOR-FACING CAVEAT, HELD IN BOTH DIRECTIONS (ADR-0032 §7d, M21.7 follow-up).

This note used to be written INLINE inside the resolve command's Commander `.action()` closure, where nothing could call it: inverting its condition — so the note printed on a healthy commander and went SILENT on the deployment it exists to warn, the exact inversion that matters — left the whole suite green. A conditional caveat is only held when BOTH arms are pinned, so both are below. The wording is deliberately NOT pinned beyond the two facts an operator acts on (the posture, and where to go instead), so a rewrite passes and a wrong condition fails.

### §112. M21.6 — THE TWO READ VERBS

M21.6 — THE TWO READ VERBS (proposal §3.3) and their formatters. Both consume the component-scoped read surface through the SDK (`client.dependencySubscriptions.inventory` / `.bumps`); the formatters are exported and called DIRECTLY here because a mapper inside a Commander `.action()` closure is unreachable by any test (see the file doc above).

## `packages/cli/src/domain-local-cli-surface.test.ts`

### §113. M20 (ADR-0031) — THE CLI HALF OF THE DOMAIN-LOCAL SURFACE

M20 (ADR-0031) — THE CLI HALF OF THE DOMAIN-LOCAL SURFACE.

Charter principle 3 is API → SDK → CLI → IaC → UI, and a capability that stops at the SDK is a parity hole. Two things need a witness here, and neither is about wording for its own sake:

1. **Every typed registry gets the flag.** `--domain-local` is added inside ONE factory (`registerTypedResourceCrud`) that generates the command set for every registered type, so a regression would silently drop it from all of them at once. Asserting across the whole list — derived from the program itself rather than retyped — is what makes "every registry" a claim rather than a hope.

2. **Publish is a VERB, and its help says the thing that cannot be undone.** `publish` is one-way: federation has no un-send. An operator meets that fact either in the help text or by discovering it afterwards, so the word "one-way" being present is a real requirement, not decoration. Equally, there must be NO `unpublish`/`--no-domain-local` anywhere — the absence is the guarantee, and an absence is exactly what nobody notices regressing.

## `packages/cli/src/governance-move-cli-wire.test.ts`

### §114. `scp governance move-enforcement …`

`scp governance move-enforcement …` — THE ACTION BODIES ACTUALLY CALL THE SDK.

`governance-move-cli.test.ts` proves the six verbs are REGISTERED and pins the pure formatters; neither reaches a Commander `.action()` closure. The `dependency-read-verbs-wire.test.ts` lesson ("component built, never installed" one layer down — a `return;` inserted first in the action left a fully green package) applies exactly the same way here, so every verb is driven through `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk`.

MUTATIONS WATCHED TO FAIL (each applied alone, then reverted): `return;` as the first statement of every action → that verb's call-count assertion goes RED (no SDK call, nothing printed); dropping the `--enabled` parse guard in `instance set`'s action → the "rejects a non-boolean" case goes RED; dropping the `SCP_OPERATOR_TOKEN` guard → the "refuses without a token" case goes RED and the SDK is called anyway (the negative assertion on `setInstanceCalls` catches it).

## `packages/cli/src/governance-move-cli.test.ts`

### §115. `scp governance move-enforcement …`

`scp governance move-enforcement …` — THE CLI HALF OF THE `governance:move` LATTICE (governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18; SDK facade `client.governanceMove` in `packages/sdk/src/client.ts`).

What this file pins, and why it is not readable from `governance-move-cli-wire.test.ts` alone:

1. **A closed verb list**, both at `move-enforcement` and at `instance` — mirrors `dependency-subscription-cli.test.ts`'s reasoning: a verb silently added or dropped from the command tree is invisible to every other test in the package. 2. **`instance set` takes `--enabled <bool>`, mandatory** — an omitted flag must be a CLI-level error before any SDK call, not a defaulted `false` that silently disables enforcement. 3. **The formatters are honest about absent values**, called DIRECTLY here (never through a Commander `.action()` closure, which no test can reach — `cli-absent-formatters.test.ts`'s standing reason).

## `packages/cli/src/iac-estate-program.roundtrip.test.ts`

### §116. Export, synth and compare through the real compiler

THE CENTREPIECE: export → synth → compare, executed through the REAL TypeScript compiler and the REAL `@scp/iac` package (team-pipeline-iac.md §9's stated correctness property — "exported ts, when synthesized, must produce a manifest equivalent to the json export of the same scope").

`@scp/iac`'s own `estate-program.test.ts` covers the two emitters' behavior in isolation; this file proves the stronger claim neither of those tests can: that the rendered TS source ACTUALLY COMPILES against the published `@scp/iac` surface (not just "looks plausible"), and that RUNNING it produces the same manifest `buildEstateManifest` computes directly from the same `ServiceSpec`.

MUTATION-WATCHED (restored before commit — see each case's own note): - dropping a placement from `renderEstateProgram`'s emission turns "round-trips a full export" RED (the compared manifests stop matching); - emitting a plausible fabricated `repo` instead of the loud `undefined` placeholder turns "the placeholder case FAILS to typecheck" RED (the compile would now succeed).

## `packages/cli/src/iac-estate-reader.ts`

### §117. Turns live SDK reads into the shape the emitter consumes

Turns LIVE SDK reads into the `ServiceSpec` shape `@scp/iac`'s shared emitter (`estate-program.ts`) consumes — the CLI-side half of `scp iac export` (team-pipeline-iac.md §9/D5). `scp iac scaffold`'s own reading logic (a `discovery run` proposal, not a live graph walk) lives beside it in `iac-scaffold-reader.ts`; both hand their output to the SAME shared emitter. Everything here talks to `@scp/sdk`; `@scp/iac` stays free of that dependency (its own module doc explains why), so the SDK-shaped reading logic belongs on this side of the boundary.

### §118. Mirrors the server's list of git-hosting source kinds

Mirrors `apps/server/src/dependencies/manifest-reader.ts`'s `GIT_PROVIDER_MODULES` — the three git-hosting `source_mappings.sourceKind` values this platform's own adapters carry. Duplicated as a literal, not imported: `@scp/cli` must not depend on `apps/server` (a CLI package pulling in the server would be a layering violation, and there is no shared package this vocabulary lives in today). Keep in sync with that file if the provider set ever grows.

### §119. `source_mappings` are listed per source kind

`source_mappings` are listed per source kind (`GET /change-sources/{sourceKind}/mappings`, D9's registration-by-pattern only narrows how a config source APPLIES, not how this read works) — export has no way to know which kinds an org uses, so it probes each of these and keeps whatever matches one of the scope's components. Defaulting to only ONE kind would make a GitHub- or GitLab-backed component silently read as "no source mapping" (a loud placeholder per pipeline, but with an invisible CAUSE) — so every known git provider is probed by default, and `--source-kind` only narrows it.

## `packages/cli/src/iac-export-cli.test.ts`

### §120. `scp iac export`

`scp iac export` — DRIVEN through `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk` (the house pattern: `outpost-reconcile-precondition.test.ts`/`dependency-read-verbs-wire.test.ts`). What matters here is CLI wiring and honesty, not the emitter's own logic — `@scp/iac`'s `estate-program.test.ts` and this package's `iac-estate-program.roundtrip.test.ts` already prove the emitter itself (round-trip, typecheck, placeholder behavior). This file proves the ACTION BODY actually calls `readServiceExportSpec` off the SDK and prints its answer honestly, including the placeholder count.

### §121. D5's whole point

D5's whole point: applying an exported program must ADOPT the live topology, never duplicate it (owner fix). MUTATION-WATCHED: dropping `topologyUrn: topologyObj.urn` from `iac-estate-reader.ts`'s `readComponentSpec` makes this go red — the emitted pipeline would carry no `adoptTopologyUrn` at all, and a second `scp apply` of the export would create a duplicate `release-topology` object beside the real one.

## `packages/cli/src/iac-render-cli.test.ts`

### §122. `scp iac render` (team-pipeline-iac.md D21(d), §12)

`scp iac render` (team-pipeline-iac.md D21(d), §12) — DRIVEN through `buildProgram().parseAsync ([...])`, the established pattern for a Commander `.action()` closure (`dependency-read-verbs- wire.test.ts`'s doc explains why: neither a pure-printer unit test nor a hand-called function reaches the closure itself). This is deliberately OFFLINE — no login, no `--base-url` — so unlike most of this file's siblings it needs no stubbed `@scp/sdk` client.

## `packages/cli/src/iac-scaffold-cli.test.ts`

### §123. `scp iac scaffold`

`scp iac scaffold` — DRIVEN through `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk` (house pattern). What matters here — and what a unit test of `groupDiscoveryProposal` alone cannot pin — is that the ACTION BODY resolves the execution-system into a discovery request, calls `discovery.run`, and prints the grouped/ungrouped split honestly (ADR-0047's whole point: "the orphan problem is solved at authoring time" only holds if ungrouped components are actually loud here, not just correctly computed by a pure function nothing calls).

## `packages/cli/src/iac-scaffold-reader.ts`

### §124. The `scp iac scaffold` half of the estate-reading layer

The `scp iac scaffold` half of the estate-reading layer (team-pipeline-iac.md §7/D1, ADR-0047) — turns a `discovery run` proposal into `@scp/iac`'s `ServiceSpec` shape, GROUPED into services by the caller-supplied lookup table. Sibling to `iac-estate-reader.ts` (the `scp iac export` half); split into its own file/commit because scaffold's grouping logic is genuinely independent of export's live-graph reads — both hand their output to the SAME shared emitter (`@scp/iac`'s `estate-program.ts`), landed first.

## `packages/cli/src/index.ts`

### §125. The estate reader, exported so the server test can drive it

The estate READER behind `scp iac export`, exported so the server's estate-migration test can drive the real journey — export a live estate, synthesize, apply, assert adoption — rather than re-implementing the read and proving only that its copy works.

A test that reimplements the thing it is testing proves the reimplementation. This is the same reader the CLI verb calls.

## `packages/cli/src/outpost-cli-surface.test.ts`

### §126. M16.2 phase A, REVIEW ROUND 5 — THE CLI HALF OF THE OUTPOST SURFACE

M16.2 phase A, REVIEW ROUND 5 — THE CLI HALF OF THE OUTPOST SURFACE (N1, N2).

N1 — THE TIER FIX MISSED THE ONLY PLACE AN OPERATOR READS THE LIST. ADR-0022 widened `OutpostTrustTier` from `commercial|fedramp-high|il5` to the glossary's five members, and the schema, the migration header, the proposal and the glossary alignment were all corrected — while `--trust-tier`'s two option descriptions kept printing the OLD THREE. `scp federation outpost declare --help` is the only place an operator learns what to type, so an operator enrolling a GovCloud outpost was told there was no value for it, and pushed to leave the tier unknown or assert `commercial` — the INVENTED POSTURE the whole honest-unknown design exists to prevent. The help text is now DERIVED from the enum; this test is the assertion that keeps documentation and enum from drifting apart again, and it is deliberately written against the ENUM'S OWN MEMBERS rather than a retyped list, so adding a sixth tier cannot leave the help behind.

N2 — THE RECOVERY VERB HAD NO CLI. Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and `reconcileOutpost` shipped in the SDK with no command. It is the verb an operator uses to un-wedge a peer holding duplicate `outpost` objects — and that operator is the one person who cannot reach it through the UI, because the wedged peer is what the UI fails to render.

### §127. A journaled delete must not be described as a local cleanup

M1 (review round 6) — THE RECOVERY COMMAND MUST NOT DESCRIBE A JOURNALED, DOWNSTREAM-PROPAGATING DELETE OF THIS DOMAIN'S OWN CONFIG AS "removed N unverified shadow(s)". That wording is true only for `removedShadowObjectIds` (a stray hand-typed copy this domain never authored — nothing rides the journal). For `removedLocalObjectIds` (the `?keep=` verified-duplicate escape, N9) it is false: the row dropped is this domain's OWN declared config, and the tombstone journals down to the outpost. The two cases must read differently — this test fails if they are ever collapsed back into one bucket/one sentence, which is exactly the regression a `removedObjectIds.length` mutant would reintroduce.

### §128. The concurrency precondition on the widest unguarded window

THE OPTIMISTIC-CONCURRENCY PRECONDITION, ON THE SURFACE WITH THE LARGEST UNGUARDED WINDOW. `reconcile` went straight to the write with no read at all, so the CLI had neither a preview nor a staleness guard on a call that can adopt an operator's entered config, DISCARD it, or delete a row this domain authored and journal that delete downstream.

### §129. ROUND 3 — THE SAME HALF-GUARD, IN THE CLI

ROUND 3 — THE SAME HALF-GUARD, IN THE CLI. `adoptedObjectId` is required-NULLABLE (`federation.ts`), and BEFORE ADR-0023 the generated SDK validated NO response, so a server that omits the key hands this function `undefined`. Keyed on `=== null`, that took the OTHER branch and printed

Adopted: undefined (an unverified hand-filled shadow is now this domain's own object)

— an adoption that did not happen, reported as one that did, from the CLI's own recovery verb. The browser half of this bug was fixed in `routes/outpost-configuration.tsx`; the class is broader than the file, so it is pinned in both.

## `packages/cli/src/outpost-reconcile-precondition.test.ts`

### §130. WHAT THIS FILE PINS THAT THE SURFACE TEST CANNOT

WHAT THIS FILE PINS THAT THE SURFACE TEST CANNOT: that `scp federation outpost reconcile` ACTUALLY SENDS the `?ifClaimant=` precondition, derived from a listing it took itself.

The surface test can only read the command's OPTIONS — so a build in which the flag exists, the help text is perfect, and the action quietly issues the bare call passes it completely. That "wording, not behaviour" shape is this project's second-most-common recurring bug, so the wire argument is asserted here against a stubbed SDK, and the stub is what a mutation flips.

`@scp/sdk` is mocked wholesale (the `login-base-url.test.ts` pattern): the CLI consumes only the SDK, so intercepting it is the honest seam for "what did the command ask the API to do".

### §131. Warm the dynamic import in a hook, not in the first test

Warm the dynamic import ONCE, in a hook, so the first `it` does not pay it.

`runReconcile` imports `./cli.js` lazily (it must: the SDK mock above has to be installed before the CLI module graph is evaluated). Dynamic imports are cached, so the FIRST test in this file silently absorbed the cost of transforming and evaluating the entire CLI module graph — ~0.3s on a warm dev machine, but 5.4s on a cold CI runner, which blew vitest's 5000ms default test timeout and failed a test whose own work takes milliseconds. (Its three siblings ran in 30-180ms, all on the cached module — the tell that the cost is one-time setup, not the behaviour under test.)

A bigger `testTimeout` would have hidden it behind a number nobody could interpret. Charging the cost to a hook is both honest and more robust: hooks get vitest's separate `hookTimeout` (10s), and a genuine 5s regression in the COMMAND is still caught by the per-test budget.

## `packages/cli/src/output.test.ts`

### §132. The table printer owns cell coercion

The table printer owns cell coercion. Before this, `printTable` typed rows as `Record<string, string>` while 22 call sites handed it raw API objects through a cast; the first numeric field (`scp federation import` → `appliedEntries`) crashed with `v.padEnd is not a function` — AFTER the import had already applied server-side, so the operator saw an error for a command that had succeeded. The property is "a cell that is not a string", not "the import command", so the fixture below is the whole class: number, 0, boolean, false, null, undefined, nested object, array.

## `packages/cli/src/output.ts`

### §133. A row is whatever a mapper hands us

A row is whatever a mapper hands us — API objects arrive with numbers, booleans, nulls and nested objects, not just strings — so the TABLE printer owns the string coercion, not 100+ callers. (Before this, `printTable` typed rows as `Record<string, string>` and every caller that passed an API object straight through lied about it with a cast; the first numeric field — `scp federation import`'s `appliedEntries` — crashed the printer with `v.padEnd is not a function` AFTER the import had already applied.)

### §134. Render one table cell as text. Kept deliberately plain

Render one table cell as text. Kept deliberately plain: - string → as is - number / bigint / boolean → their canonical text (`0` and `false` are VALUES, not absences) - null / undefined → blank (the printer's long-standing convention for an absent field; row mappers that want `—` or `?` say so themselves — see cli-absent-formatters.test.ts) - object / array → compact JSON, so a nested field never prints as `[object Object]`

## `packages/cli/src/plan-diff-row.test.ts`

### §135. `scp iac plan`'s source-mapping row must show the REF

`scp iac plan`'s source-mapping row must show the REF (ADR-0030 §1).

This is review integrity, not formatting. The ref is part of the mapping identity, so a prune matches on it — and two mappings differing only by ref (`refs/heads/dev` → the dev pipeline, `refs/heads/main` → production) render IDENTICALLY without it. An operator approving "delete source-mapping github:acme/api:*" would have no way to tell which of the two routes the plan is about to remove.

### §136. NOTHING `computePlanDiff` COMPUTES MAY BE INVISIBLE IN `scp plan`

NOTHING `computePlanDiff` COMPUTES MAY BE INVISIBLE IN `scp plan`.

The summary counters are computed over EVERY collection, but the table used to be built from four of them. A plan whose only content was a `governanceMoveRungs` delete therefore printed an EMPTY table under `creates=0 updates=0 deletes=1 noops=0` — the table and the summary contradicting each other, with the missing row being the one that says "this DISABLES the governance:move bar on service X". That is the worst omission of the three, because a disabled bar's symptom is an ABSENCE of refusals: nothing downstream ever surfaces the mistake.

The gate is deliberately a COUNT over the whole diff rather than a per-kind assertion, so it is a statement about the property ("every collection is printable") and not about the three instances that happened to be missing on the day it was written.

MUTATION LOG — each applied, watched fail, reverted, watched pass: | Mutation | Measured |
| drop `...(diff.governanceMoveRungs ?? [])` from `planDiffEntries` | "every entry the diff carries reaches the table": `expected 7 to be 8`, and the rung-row case reds too | | drop `...(diff.placements ?? [])` / `...(diff.producers ?? [])` | same count case reds (`7 to be 8`) | | `diffEntryRow`'s governance-move-rung branch removed (falls through) | TYPE ERROR at the `const unknown: never = entry` binding — the omission cannot even compile |

## `packages/cli/src/rbac-cli-wire.test.ts`

### §137. The RBAC command bodies really do call the SDK

`scp role` / `role-binding` / `authz` / `operator-credential` / `idp` — THE ACTION BODIES ACTUALLY CALL THE SDK.

Registering a command and having it do something are different facts, and only the second one matters. A `return;` inserted as the first statement of every action leaves a fully green package unless something drives the Commander closures — this repo has paid for that once already (`dependency-read-verbs-wire.test.ts`), so every verb here is driven through `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk`.

The cases that are NOT merely call-count assertions, and why each exists:

- `--acknowledge` absent vs present-but-empty must reach the API as `undefined` vs `[]`. D7 treats them as different statements — "I did not look" and "I looked and it is empty" — and the door refuses the first for a group subject. Defaulting one to the other in the CLI would silently convert a refusal into an admission. - `role update` must send `undefined` for flags the operator omitted, never `[]`. The API reads absent as "leave alone" and empty as "clear", so conflating them would silently widen where a role may be bound. - `operator-credential` verbs must REFUSE without a token rather than send an empty header.

## `packages/cli/src/relay-builds-cli.test.ts`

### §138. The CLI half of the auto-relay build ledger

M13.1b — THE CLI HALF OF THE AUTO-RELAY BUILD LEDGER'S OPERATOR READ SURFACE, `scp federation relay-builds`.

WHY THE WIRE AND NOT ONLY THE OPTIONS. A build in which `--status`/`--limit` exist, the help text is perfect, and the action drops them on the floor before calling the SDK passes a surface-only test completely. That "wording, not behaviour" shape is this project's second-most-common recurring bug (`outpost-reconcile-precondition.test.ts`, `scan-exclusion-admissions-cli.test.ts`), so `@scp/sdk` is mocked wholesale here and every assertion is against the ACTUAL call the mock recorded, plus the rendered table text — the CLI consumes only the SDK (charter principle 3), so intercepting it is the honest seam.

## `packages/cli/src/report-test-bundle-flags-wire.test.ts`

### §139. `scp change-source report`

`scp change-source report` — THE D23/D13 FLAGS ACTUALLY REACH THE REQUEST BODY.

WHAT WAS BROKEN, AND WHY IT MADE THE WHOLE INCREMENT UNREACHABLE FROM CI
Increment 8 shipped `ChangeReportRequestSchema.commitSha` (#316), `.testBundle` (#316) and `.artifactClass` (#317), and the CLI could send NONE of them — it had `--sbom-*` and `--artifact-digest` and stopped there. `scp change-source report` is THE channel a build declares through (a raw provider webhook cannot carry any of this), so in practice no CI step could produce a D23 pin at all: `deriveCapturedWorkflow` needs the declared workflow, the built commit AND the bundle, and two of those three had no flag. Every declared hook would trigger, terminalize, write no evidence, and hold its wave forever with a correctly-named reason nobody could act on.

That is charter principle 3 (API → SDK → CLI → IaC → UI) failing at the CLI rung, and it is the same built-never-installed shape #317 closed one layer down — which is why this file asserts the VALUES ON THE WIRE and not merely that the options are registered. A flag that parses into a variable nothing threads is exactly as useless as no flag, and `stage-dependencies-flags.test.ts` (registration + pure parsers) could not tell the two apart. The `dependency-read-verbs-wire` lesson applies verbatim: a `return;` at the top of the action leaves a fully green package.

Every asserted body is parsed by `ChangeReportRequestSchema` itself rather than compared to a retyped literal, so a future contract change cannot leave these flags emitting a shape the API refuses.

## `packages/cli/src/scan-exclusion-admissions-cli.test.ts`

### §140. The operator surface for both rungs, which shipped unheld

M22.9 — THE OPERATOR SURFACE FOR THE TWO RUNGS EVERY EXCLUSION CLAUSE NEEDS, AND IT SHIPPED WITH NOTHING HOLDING IT.

A filterless `grep -rna 'instanceScanExclusionAdmissionRow|scan-exclusion-admissions' --include='*.ts'` (dist excluded) found ZERO references outside `cli.ts` itself: the row formatter, `list` and `set` were all reachable only from the command block that defines them, so DELETING THE ENTIRE BLOCK left `@scp/cli` green. Four behaviours were untested and every one of them is one-way:

```text
- the `trust-domain` -> `trust_domain` literal mapping (ADR-0016/ADR-0033 terminology: the
  AMBIENT federation partition, never the intra-org containment `domain` object);
- the class allowlist, whose whole point is that a typo admits NOTHING while the operator
  believes they granted something;
- the `SCP_OPERATOR_TOKEN` precondition — an admission opens a loosening for every org on the
  deployment, so a tenant login must not be able to reach it;
- and THE DESTRUCTIVE DEFAULT: `set` is a REPLACE, so omitting `--class` sends `classes: []`
  and REVOKES every admission at that rung. With that rung empty the monotone AND fails at the
  top for every clause beneath it, and every exclusion on the deployment goes inert.
```

WHY THE WIRE AND NOT ONLY THE OPTIONS. `outpost-cli-surface.test.ts` can pin what a command DECLARES; a build in which the options exist, the help text is perfect and the action sends the wrong body passes it completely. That "wording, not behaviour" shape is this project's second-most-common recurring bug, so the four assertions above are made against a stubbed `@scp/sdk` — the `outpost-reconcile-precondition.test.ts` pattern, and the honest seam, because the CLI consumes only the SDK (charter principle 3).

### §141. Warm the dynamic import in a hook, not in the first test

Warm the dynamic import in a hook rather than charging it to the first `it` — the reason `outpost-reconcile-precondition.test.ts` gives: the whole CLI module graph is transformed on first import, which is milliseconds warm and seconds on a cold runner, and vitest's per-test budget is 5s while `hookTimeout` is 10s. The import must be lazy so the SDK mock above is installed before the graph is evaluated.

### §142. THIS CASE CHANGED DELIBERATELY

THIS CASE CHANGED DELIBERATELY (owner decision, 2026-08-18), and its previous revision said so in advance: it pinned the silent-revocation default as SHIPPED-BUT-NOT-ENDORSED and named itself as the test that must change if a flag were ever added. This is that change.

`set` is still a whole-set REPLACE on the wire — that server contract is right, because an additive verb would make withdrawal the harder operation on a LOOSENING. What changed is that the CLI no longer lets you reach the destructive case by forgetting a flag. `platform` is ALWAYS represented in the monotone AND, so an empty set there makes every exclusion clause on the whole deployment inert, for every org.

## `packages/cli/src/source-mapping-row.test.ts`

### §143. `scp change-source list-mappings` carries a SCOPE column

`scp change-source list-mappings` carries a SCOPE column (§10.6, migration 0066) — `global` | `domain`, BLANK when not declared. Blank and not a guess: the CLI, like the pipeline tile, never infers a scope from the site it is talking to. `?` is reserved for an OLDER server whose response predates the field — absence of the key is not "undeclared".

## `packages/cli/src/stage-dependencies-flags.test.ts`

### §144. ADR-0028 increment 1 — the CLI half of the declaration channel

ADR-0028 increment 1 — the CLI half of the declaration channel (charter principle 3: API → SDK → CLI → IaC → UI). `scp change-source report` is THE channel a microservice's CI declares through, so the flags are the surface an engineer actually types.

Every parse result is validated against `StageDependencySchema` itself rather than a retyped literal, so a future schema change cannot leave the flag parser emitting a shape the API refuses.

## `packages/cli/src/stage-dependency-surface.test.ts`

### §145. ADR-0028 increment 4 — the CLI half of the hold's operator surfaces

ADR-0028 increment 4 — the CLI half of the hold's operator surfaces.

WHAT THIS FILE IS FOR. Until increment 4 a held wave target reached the CLI as exactly one line in `explain`'s flat Decision list, indistinguishable from a gate or a transition, and `scp change wait-status` reported on the OTHER coupling entirely (`requires`) — so the operator best placed to act had to already know to go read a Decision's `inputContext`. These pin the rendering that fixes that: the dependency by name, the stage it is scoped to, and WHICH BRANCH held it, because ADR-0028 decision 4 made the branches distinguishable precisely so the remedies could differ.

EVERY FIXTURE IS VALIDATED AGAINST `ChangeStageDependencyStatusSchema` ITSELF (`held()` below) rather than hand-typed to match the renderer. A retyped literal is the fixture-that-never-applied failure this repo keeps meeting: it would let a server-side shape change leave this file green while the renderer read a field that no longer arrives.

THE ASSERTIONS ARE ON WHAT IS SAID, NOT ON HOW. They check that a name, a place, a branch or a fail-open APPEARS — never that a whole sentence matches, which would pin wording and pass for the wrong reason the moment the sentence was reworded without the field being read at all.

### §146. The fail-open: `unscopeable` means there was no stage to scope

THE FAIL-OPEN. `unscopeable` means the wave target names a component rather than a placement, so there was no stage to scope by and the declared coupling was NOT APPLIED. It is satisfied on the wire because the release proceeds; rendering that word would tell an operator their coupling held when nothing was ever checked. ADR-0028 gave it its own branch so it would be findable — this is the CLI honouring that rather than flattening it back into "satisfied".

THE FIXTURE CARRIES THE SERVER'S REAL SENTENCE, which itself says "is satisfied here" (that is `describeBranch`'s default arm). A blanket "the line must not contain 'satisfied'" would therefore be a fixture that only passed because it was written unrealistically — so the assertion is on the MARK this renderer chooses, with the server's sentence still printed verbatim beside it.

### §147. THE TWO ABSENCES ARE DIFFERENT CLAIMS

THE TWO ABSENCES ARE DIFFERENT CLAIMS. `null` is the server reporting no coupling; an omitted key is a pre-increment-4 server, which is contract-legal for an `.optional()` field and passes ADR-0023's response validation untouched. Printing "coupled nothing" for the second would be a fabricated observation about a change that may well be held — the exact class `cli-absent-formatters.test.ts` exists for, arriving here through the SAME door.

### §148. THE WORDING TRAP, pinned deliberately

THE WORDING TRAP, pinned deliberately. The description was hard-coded to "M12 P4B: print ONLY a Change's coupled-pipeline wait status — which `requires` prerequisites…". Teaching the command a second coupling while leaving that sentence would make the help text FALSE, and it is the only documentation an operator gets at the terminal. This is an assertion about coverage (both couplings are named), not about phrasing.

## `packages/cli/src/test-support/ts-harness.ts`

### §149. Compiles one generated file against this repo's real types

TEST-ONLY. Compiles ONE generated TypeScript source file (`scp iac export --format ts`'s output, or `scp iac scaffold`'s) against this repo's real strict tsconfig and the REAL `@scp/iac` package — proving the emitter's stated guarantee ("emitted code must actually compile against the real constructs", team-pipeline-iac.md §9) rather than assuming it.

The temp project lives INSIDE `packages/cli`'s own directory tree (not `os.tmpdir()`) on purpose: `packages/cli/node_modules/@scp/iac` is a real pnpm workspace symlink (`@scp/iac` is a dependency of this package), so ordinary Node/TS module resolution finds it by walking UP from the compiled file — no `paths` mapping, no dependency on where `os.tmpdir()` happens to point in CI.

`emit: true` additionally writes JS to `outDir` so the round-trip test can `import()` and execute it (`estate-program.test.ts`'s sibling in `@scp/iac` covers the same ground at the emitter-unit level; this one proves it through the same compiler a real team's CI would run).

## `packages/cli/vitest.config.ts`

### §150. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §151. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

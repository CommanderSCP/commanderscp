# oasdiff breaking-change exceptions

The `/v1` API is additive-only; `tools/openapi/check.sh` runs `oasdiff breaking` between the
committed spec at the merge base with `main` and the freshly emitted spec, and fails on any
ERR-level (breaking) change. That gate is **not** self-overriding — `check.sh`'s own header records
that an intentional breaking change requires an explicit **`api-v2-exception`** label + review
(BUILD_AND_TEST.md §7 "API breaking change" row, `.github/workflows/ci.yml`). This file is the
durable record of each such exception so the label is never a mystery in the git history.

## Log

### Outpost-run probes — three `JournalEntryKind` values (2026-08-28)

**Spec:** team-pipeline-iac D11/D23 ("SCP triggers locally at the outpost; results flow upward as
gate evidence through the existing status/journal path"). Owner decisions, 2026-08-28: hooks travel
by new journal kinds; the outpost maintains the CronWorkflow; evidence returns by journal.

**What breaks (deliberate, one-time):** three values are ADDED to `JournalEntryKindSchema` —
`pipeline_hook_upsert`, `pipeline_hook_tombstone`, `pipeline_evidence_upsert`. `entryKind` appears
in two RESPONSE positions, so this is oasdiff-breaking even though it is purely additive:

- `POST /federation/exports` → `200.entries[].entryKind`
- `POST /federation/resync` → `200.bundle.entries[].entryKind`

(The third occurrence, `POST /federation/imports` request body, is a REQUEST position and additive
there.) Measured rather than assumed — response enum-value additions are breaking under
`tools/openapi/check.sh`, while response `oneOf` member additions are not.

**Why not avoid the break.** Two alternatives were considered and rejected:

- _Restructure `entryKind` as a discriminated union_, which would make this and every future kind
  free. Converting a shipped enum response into a union is itself a break, so it costs an exception
  AND a refactor to buy what later kinds get anyway once someone does it deliberately.
- _Make `pipeline_hooks` graph objects_ so they ride `object_upsert`. This reverses migration
  0096's stated design — a side table whose ownership DERIVES from `component_object_id`, with no
  `managed_by_stack` column — to dodge a process step.

**Why one entry for three values.** They are one decision and one wire change. Splitting them across
PRs would spend three exceptions on the same break and leave the journal half-able to express the
round trip in between.

**Scope of the risk:** none to existing peers. A consumer that does not understand a kind already
has to tolerate one — `import-repo.ts` switches on `entryKind` and an unknown kind is not fatal — and
the platform is pre-release with no external usage (charter dev-stage note: the ledger is process
hygiene, not user protection).

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; job 3b reads the
label and this entry and reports green-with-warning instead of red. Job **3 (codegen drift)** stays
green — `tools/openapi/openapi.v1.json` and `packages/sdk/src/generated/*` are regenerated
(`@scp/schemas` built first, per CLAUDE.md) and committed in this PR.

### ADR-0007 — executor binding `purpose` → Type taxonomy (2026-07-17)

**Spec:** [docs/adr/0007-executor-binding-type-taxonomy.md](../../docs/adr/0007-executor-binding-type-taxonomy.md),
[docs/proposals/executor-type-taxonomy.md](../../docs/proposals/executor-type-taxonomy.md).
Migration: `apps/server/drizzle/0026_executor_binding_type.sql`.

**What breaks (deliberate, one-time):** the flat routing key `purpose ∈ {infra, software}` is
replaced by the two-level Category/Type taxonomy and the wire field is renamed `purpose → type`. In
**request** positions this is oasdiff-breaking:

- `?purpose=` query params renamed to `?type=` on `GET/DELETE/PATCH /executors/{idOrUrn}/binding`
  (parameter removed + added; enum values `infra`/`software` removed).
- request-body property `purpose` renamed to `type`, with the enum changed from
  `{infra, software}` to `{image, rpm, deb, npm, infrastructure, configuration}`, on
  `POST /changes`, `POST /campaigns`, `POST /change-sources/{sourceKind}/mappings`, the discovery
  `sourceMappings[]`, and `PATCH /executors/{idOrUrn}/binding`.
- response field `movedBindingPurposes` renamed to `movedBindingTypes` on `POST /components/{idOrUrn}/merge`.

Additive-in-response parts (the new `type`/`category` fields on binding / source-mapping /
wave-target responses) are **not** breaking.

**Why it is acceptable here:** owner decision D3 (ADR-0007) — a hard cutover with no legacy aliases,
safe because there is a **single instance** (homelab) and therefore no federation version-skew and
no external SDK consumer to break. This is explicitly **not** a precedent for post-GA `/v1`
breakage; a post-federation cutover would instead require a lockstep fleet upgrade.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; reviewers approve the
break against this record. `check.sh` still reports the breaking change (by design) — the label is
the branch-protection override, not a suppression in the script.

### ADR-0021 D5/D6 — change-lifecycle `promote` → `accept`, service-board `stage` → `wave` (2026-07-25)

**Spec:** [docs/adr/0021-terminology.md](../../docs/adr/0021-terminology.md) D5 (the `promote` →
`accept` rename) and D6 (`stage` vs `wave`); vocabulary fixed by
[docs/GLOSSARY.md](../../docs/GLOSSARY.md). Migration:
`apps/server/drizzle/0039_change_state_accepted.sql`.

**What breaks (deliberate, one-time):** two independent renames land in one batch, because they
would otherwise cost two separate `/v1` exceptions for one vocabulary decision.

_D5 — the change-lifecycle approval gate:_

- **Route path renamed:** `POST /v1/changes/{id}/promote` → `POST /v1/changes/{id}/accept`
  (path removed + added).
- **`operationId` renamed:** `promoteChange` → `acceptChange`, which renames the generated SDK
  operation and every derived type (`PromoteChange*` → `AcceptChange*`).
- **`ChangeState` enum value renamed:** `promoted` → `accepted`. This enum appears in a **response**
  position on every change-bearing payload — `GET/POST /changes`, `/changes/{id}`,
  `/changes/{id}/explain`, `/changes/{id}/cancel|accept|rollback`, and the campaign rollback
  response's nested `rollbackChange` — and as a **request** value on `GET /changes?state=`.

_D6 — the service release board (`GET /v1/services/{idOrUrn}/board`), response body only:_

- Response field renamed `currentStage` → `currentWave`.
- Response field renamed `stages` → `waves`.
- The element schema behind that array is renamed `ServiceBoardStageSchema` → `ServiceBoardWaveSchema`
  (exported type `ServiceBoardStage` → `ServiceBoardWave`), which renames the inlined object in the
  emitted spec and its generated SDK type.

**Why it is acceptable here:** the same single-instance reasoning ADR-0007 relied on still holds,
and it was re-checked against the deployment as it stands today rather than inherited — owner
decision O1, 2026-07-24. CommanderSCP runs as **one instance** (the homelab k3s deployment). There
is no second instance to skew against, so no federation peer can be on the other side of the
rename; the journal exchange carries graph objects and status, not this route or this enum's
spelling. There is **no SDK consumer outside this monorepo** — the CLI, the IaC package and the web
UI are the only callers, they consume the generated SDK exclusively (charter principle 3), and all
of them ship from the same commit as the server. So the window in which an old caller could meet a
new server does not exist, which is exactly the condition that would otherwise force an
expand/contract with a dual-accept period. The rename is therefore done **in place, single-phase**,
with no legacy alias and no deprecation window (ADR-0021 D5, and the migration's own header).

The cost argument for paying it now rather than later is in ADR-0021 D5: the price of this rename
only grows — with each additional deployment, each additional SDK consumer, and each additional
month of documentation written in the old vocabulary. Pre-1.0 with one instance is the cheapest
this will ever be. As with ADR-0007, this is **not** a precedent for post-GA `/v1` breakage.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; reviewers approve
the break against this record. CI job **3b (oasdiff)** reports the breaking change and goes red —
that is the designed, approved outcome, not a failure to fix. `check.sh` is not suppressed,
bypassed, or edited; the label plus this entry are the record of owner approval. Job 3b is deliberately NOT a required status check on `main`, so there is no protection for a label to override (see `check.sh`'s header and BUILD_AND_TEST.md §6); since PR #144, job 3b READS the label, so an approved break carrying an entry here reports green-with-warning instead of red. Job **3 (codegen drift)** must
still be **green** — the regenerated `tools/openapi/openapi.v1.json` and `packages/sdk/src/generated/*`
are committed in this PR.

### ADR-0036 — remove the `initiative` object type (2026-08-10, on the `claude/ui-review-worktree-efc42b` branch)

**Spec:** [docs/adr/0036-remove-initiative.md](../../docs/adr/0036-remove-initiative.md). Migration:
`apps/server/drizzle/0065_remove_initiative.sql` (renumbered from 0056 with a `when` bump when the
branch merged main).

**What breaks (deliberate, one-time):** the portfolio rung above campaigns is removed entirely —
graph type, API, SDK, CLI, IaC construct, UI. On the wire that is:

- **Four operations removed:** `GET /initiatives`, `POST /initiatives`, `GET /initiatives/{id}`,
  `POST /initiatives/{id}/campaigns` (`operationId`s `listInitiatives`, `proposeInitiative`,
  `getInitiative`, `addInitiativeCampaign` — and with them the generated `client.initiatives.*`
  SDK surface and the `scp initiative …` CLI verbs).
- **Enum narrowed on `/graph/query/{name}`:** the `initiative-rollup` member is removed from the
  `name` path parameter's enum (a **request** position — oasdiff ERR) and from the response's
  echoed `name` enum. The remaining named queries are untouched.
- The `Initiative` / `InitiativeProps` IaC constructs are removed with no shim (ADR-0036
  "Consequences").

The `coordinates` relationship type survives, narrowed to `campaign -> change` (migration
`0061`); nothing about the `/relationships` wire changes.

**Why it is acceptable here:** owner instruction, 2026-08-10, given explicitly AFTER the charter
and API-gate consequences were put in front of them (ADR-0036 header). The single-instance
reasoning ADR-0007 and ADR-0021 relied on still holds: the initiative surface had **no SDK
consumer outside this monorepo** (CLI, IaC and web ship from the same commit as the server), the
type never federated anything a peer's journal depends on, and — the removal's own finding — the
rung carried no plan, no waves, no gates and no execution, so no coordination state is lost. This
is, as before, **not** a precedent for post-GA `/v1` breakage.

**How the gate is satisfied:** the PR carrying this branch applies the **`api-v2-exception`**
label; job **3b** reads the label and this entry (both are required — the label alone leaves 3b
red) and reports green-with-warning. Job **3 (codegen drift)** stays green — the regenerated
`tools/openapi/openapi.v1.json` and `packages/sdk/src/generated/*` are committed on the branch.

### team-pipeline-IaC increment 2a — `ExecutorType` grows the build family; `RolloutTargetClass`'s kubernetes kind renamed to `cluster` (2026-08-26)

**Spec:** [docs/proposals/team-pipeline-iac.md](../../docs/proposals/team-pipeline-iac.md) D13/D24,
owner ruling this session. No migration — this is a `@scp/schemas` vocabulary change only.

**What breaks (deliberate, one-time), MEASURED with the vendored `oasdiff breaking` (not assumed):**

Running `tools/openapi/check.sh` against this branch reports **139 changes: 1 error, 138 warning**.
Only the one ERR-level change trips `--fail-on ERR` / job 3b; the 138 are all
`response-property-enum-value-added` at WARN severity (oasdiff does not, by default, treat an
_added_ response enum member as breaking) and would not fail the gate on their own — they are
recorded here anyway because they are the visible fingerprint of the same deliberate change and a
reviewer scanning job 3b's output should be able to match every line back to this entry.

- **The ERR:** `request-property-enum-value-removed` on `POST /plans`, the request property
  `manifest/rollouts/items/targetClass` — the enum value `kubernetes` was removed (renamed to
  `cluster`). This is `RolloutTargetClassSchema` (`@scp/schemas/pipeline-behaviors.ts`), which
  merged onto `main` in the immediately prior session (PR #294, "pipeline behaviour contract") as a
  **provisional** declaration explicitly marked for this session to delete and replace with the D24
  canonical vocabulary. It is renamed here from `kubernetes` to `cluster` to match `InfraKindSchema`
  (D24: the kubernetes product kind is named `Cluster`) — see `InfraKindSchema`'s doc comment for the
  full reconciliation. The same rename propagates to `@scp/plugin-api`'s sanctioned hand-written
  twin (`RolloutTargetClass`) and its pinning test
  (`apps/server/src/coordination/rollout-capability-vocabulary.test.ts`), so no side is left holding
  the old spelling.
- **The 138 WARNs:** `ExecutorTypeSchema` (`@scp/schemas/executors.ts`) grows from six members
  (`image | rpm | deb | npm | infrastructure | configuration`) to eleven, adding `maven`, `python`,
  `go`, `chart`, `vm-image` — D13's ruling this session that Type, not Category, is where D13's full
  artifact-class vocabulary belongs (D13's "Type stays the closed three-value enum" names this
  package's _Category_, which is untouched and still exactly `{build, infrastructure,
configuration}`). The five new values surface as enum-value additions on every response containing
  an executor `type`/`executorType` field across `POST /plans`, `POST /plans/{id}/apply`,
  `GET/PUT /instance/scanner-assignments`, `GET/PATCH/PUT/DELETE /executors/{idOrUrn}/binding(s)`,
  `GET/POST/PATCH /change-sources/{sourceKind}/mappings(/{id}/scope)`, `POST /discovery/run`,
  `GET /changes/{id}/explain`, `GET /services/{idOrUrn}/board`, and
  `GET /environments/{environment}/regional-executors` — all additive-in-response, none request-only,
  so none trip `--fail-on ERR`.

**Why it is acceptable here:** the same single-instance, no-external-SDK-consumer reasoning
ADR-0007/ADR-0021/ADR-0036 relied on still holds — CommanderSCP is dev-stage, pre-release, runs as
one instance, and the CLI/IaC/web UI are the only callers, all shipping from this commit. D24's own
requirement is stronger than "acceptable": it states the compatibility matrix and the full artifact
vocabulary must "live once" in `@scp/schemas`, which is unreachable while `ExecutorTypeSchema` is
missing five of the values D13 already named. `RolloutTargetClassSchema` was merged as an explicitly
PROVISIONAL placeholder one session ago specifically so this rename could land before anything (a
construct, a real manifest, a federated peer) came to depend on the `kubernetes` spelling — this is
the cheapest this rename will ever be, the same argument ADR-0021 D5 made for `promote`→`accept`.

**How the gate is satisfied:** the PR carries the **`api-v2-exception`** label; job 3b reads the
label and this entry and reports green-with-warning instead of red. Job **3 (codegen drift)** stays
green — `tools/openapi/openapi.v1.json` and `packages/sdk/src/generated/*` are regenerated (`@scp/
schemas` built first, per CLAUDE.md — `pnpm gen` reads `packages/schemas/dist`, not source) and
committed in this PR.

### ADR-0047 — `POST /discovery/accept` removed; discovery becomes a scaffolder (2026-08-29)

**Spec:** [docs/adr/0047-discovery-scaffolder-land-through-review.md](../../docs/adr/0047-discovery-scaffolder-land-through-review.md),
[docs/proposals/team-pipeline-iac.md](../../docs/proposals/team-pipeline-iac.md) §7 (D1, §14 resolution 3).

**What breaks (deliberate, one-time):** the path `POST /api/v1/discovery/accept` is **removed**, along
with `AcceptDiscoveryRequest` / `AcceptDiscoveryResponse` and the SDK's `discovery.accept`. Removing a
path is oasdiff-breaking on its face; there is no additive spelling of a deletion.

**Why it is removed rather than deprecated:** it was the only observation-driven graph-write path and
it bypassed strict create — the homelab's ~50 imported components landed as RBAC orphans through it,
which is the defect ADR-0047 exists to close. A deprecation window would keep the orphan-making door
open for the duration of the window, for no user: the platform is pre-release with no external
consumers (proposal header, owner 2026-08-26), so §14 resolution 3 rules no transition flag.

**What replaces it:** `POST /discovery/run` is unchanged and is now the scaffolder's engine. Its
output becomes `@scp/iac` construct code — through `scp iac scaffold` or the `/connect` wizards —
which a human groups into services and commits. The graph write then happens through the ordinary
`POST /plans` + apply path, with strict create and the same authorization every other IaC write gets.

**Blast radius inside the repo, for the record:** the route and its two schemas; the SDK method;
`createOrphanComponent` in the server test harness, which used the route's import-permissiveness and
now writes through `graph/objects-repo.ts` (there is deliberately no HTTP door that produces an
orphan any more); the `move-enforcement` m9 case and `governance-managed-write-doors` DOOR 2, both of
which drove the route as a door under test; and the write-door census table, which went from five
doors to four — the census failing on a **vanished** write site is that mechanism working.

`discovery-relationship-import.integration.test.ts` is **deleted in full**, and that is the one
removal worth naming individually. Its whole subject was the door: a proposal could declare a
BATCH-LOCAL `urn` alias, and the file pinned how accept resolved edges against it — an unresolvable
alias refused rather than silently skipped, a duplicate alias a 409, an alias shadowing a live object
a 409, and the stored object keyed by its own derived URN rather than the alias. That alias mechanism
existed only inside accept's transaction; the scaffolder emits code in which a service is a construct
reference, so there is no alias to resolve and nothing of the behaviour survives to re-test
elsewhere. Deleting the file is therefore accurate rather than lossy — but it is a real reduction in
what is covered, so it is recorded here rather than left to a diff.

`relationship-typeid-doors.integration.test.ts` is likewise **deleted in full**, and for the same
reason: its subject was `POST /discovery/accept` as a relationship write door — the one its own
census table marked "THE HOLE", because it checked NEITHER endpoint's scope. The door is gone, so
the hole is gone. Its remaining half compared accept against the generic `/relationships` door
("the two doors agree"), and that door's both-endpoints rule is covered independently by
`graph/relationship-authz.integration.test.ts` — verified before deleting, not assumed: that file
pins from-only, to-only, both-succeed, the `member_of` escalation case and DELETE.

### team-pipeline-IaC increment 7 tail — `POST /discovery/backfill-source-mappings` removed (2026-08-29)

**Breaking change:** `api-path-removed` for `POST /api/v1/discovery/backfill-source-mappings`, plus
the removal of `BackfillSourceMappingsRequest`/`BackfillSourceMappingsResponse` from the components.

**Why now, and why this was always the plan:** team-pipeline-iac.md §13 wrote the condition down when
`accept` was retired — the backfill route "survives until the estate migration (§9, increment 7)
completes, then is removed the same way". Increment 7 merged (#337), so the condition is met.

**Why waiting for a specific estate to convert was not the real gate.** The route repaired components
imported BEFORE discovery emitted source mappings. That population is **closed**: `POST
/discovery/accept` was the only door that could create a mapping-less component, and ADR-0047 removed
it, so nothing can add to the set. The homelab's own gap had already been closed by an earlier run
(source_mappings measured 0 → 47 → 148 on 2026-08-03).

**What replaces it:** authoring the mapping in IaC. `scp iac export` carries a component's existing
mappings into the emitted program, and a component under a stack gets its mappings from the manifest
through the ordinary `sourceMappings` collection, reconciled on apply. For a one-off outside IaC,
`scp change-source create-mapping` is unchanged. Both are ordinary authorized writes, which the
removed route deliberately was not — it took one org-root bar and then wrote a row per proposal entry.

**Blast radius inside the repo, for the record:** the route and its two schemas; the SDK method;
`scp discovery backfill-mappings`; `backfillSourceMappings` and its two interfaces in
`coordination/source-mappings-repo.ts`; and the org-root write-door census entry, which drops with
its door. Four prose citations of the route as a design precedent (ADR-0032, `schemas/dependencies.ts`,
`routes/dependency-subscriptions.ts`) were reworded rather than deleted — the pattern they cite is
still the pattern, but a comment pointing at a route that no longer exists misleads the next reader.

`source-mappings-on-import.integration.test.ts` is **deleted in full**. Its three `accept`-based cases
had already gone with ADR-0047, leaving only the backfill describe block, so the file's remaining
subject was entirely the removed door. Its incidental coverage — that a mapped component self-reports
a release — was verified to be covered elsewhere before deleting rather than assumed: 21 other files
exercise `matchComponentForSource`/`resultingChangeObjectId`, including the whole
`source-mapping-{enabled,precedence,path-routing,scope,mirror-of-shared,deleted-component}` family.

**A near-miss worth recording, because the reasoning was wrong in a way that would have shipped.**
**And a census miss, recorded because the pattern is the lesson.** The first census ran on the ROUTE
name (`backfill-source-mappings`) and the function name, and came back complete. It was not: the CLI
verb is `backfill-mappings` — no `source` — so `typed-registries-cli.integration.test.ts`, which
drives it as a string array, matched none of those patterns and only surfaced as a red integration
shard. When a capability's names DIVERGE across layers (route path vs CLI verb vs function), a census
on any one of them is a census on one layer. Take the shortest common substring — here `backfill` —
and read the noise.

`change-source-mapping-authz.integration.test.ts` pinned the backfill door's org-root bar, and its
header warns that nothing else in the tree pins the discovery doors' org-root requirement. Removing
the case looked like it would leave `/discovery/run` — the last discovery door — unpinned, so a
replacement case was written for it. It was **redundant**: the credential-doors case in the same file
already probes `/discovery/run` directly (component-bound admin → 403, org root → 400), which the
mutation run surfaced by failing BOTH cases. The replacement was dropped and only the prose corrected.
Two things came out of measuring instead of asserting: a first attempt at the replacement used a
made-up `pluginModule` and got 400 for _every_ principal, including an unbound one, because the
handler's unknown-module check runs BEFORE the transaction that authorizes — which reads exactly like
a missing bar until the statement order is checked.

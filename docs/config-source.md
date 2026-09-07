# config-source

Long-form reference for the **config-source** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 37 of 37 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/config-source/authoring-guard.ts`](#apps-server-src-config-source-authoring-guard-ts) — §1–§3
- [`apps/server/src/config-source/cli-apply-guard.ts`](#apps-server-src-config-source-cli-apply-guard-ts) — §4–§5
- [`apps/server/src/config-source/config-source-document.test.ts`](#apps-server-src-config-source-config-source-document-test-ts) — §6–§7
- [`apps/server/src/config-source/config-source-document.ts`](#apps-server-src-config-source-config-source-document-ts) — §8–§10
- [`apps/server/src/config-source/config-source-doors.integration.test.ts`](#apps-server-src-config-source-config-source-doors-integration-test-ts) — §11–§12
- [`apps/server/src/config-source/config-sources-repo.ts`](#apps-server-src-config-source-config-sources-repo-ts) — §13–§16
- [`apps/server/src/config-source/drain-sync-queue.ts`](#apps-server-src-config-source-drain-sync-queue-ts) — §17–§18
- [`apps/server/src/config-source/manifest-path-selection.ts`](#apps-server-src-config-source-manifest-path-selection-ts) — §19–§21
- [`apps/server/src/config-source/registration-match.ts`](#apps-server-src-config-source-registration-match-ts) — §22–§25
- [`apps/server/src/config-source/stack-delivery-repo.ts`](#apps-server-src-config-source-stack-delivery-repo-ts) — §26–§26
- [`apps/server/src/config-source/sync-engine.integration.test.ts`](#apps-server-src-config-source-sync-engine-integration-test-ts) — §27–§27
- [`apps/server/src/config-source/sync-engine.ts`](#apps-server-src-config-source-sync-engine-ts) — §28–§31
- [`apps/server/src/config-source/sync-queue-repo.ts`](#apps-server-src-config-source-sync-queue-repo-ts) — §32–§34
- [`apps/server/src/config-source/sync-status.ts`](#apps-server-src-config-source-sync-status-ts) — §35–§36
- [`apps/server/src/config-source/trigger.integration.test.ts`](#apps-server-src-config-source-trigger-integration-test-ts) — §37–§37

## `apps/server/src/config-source/authoring-guard.ts`

### §1. THE AUTHORING DOOR FOR `config-source`

THE AUTHORING DOOR FOR `config-source` — a row of that type is an IDENTITY DELEGATION, so writing one demands authority over the identity being delegated (ADR-0046 §1; migration 0100's header; team-pipeline-iac §4, D9).

WHAT THE ROW GRANTS, AND WHY PLAIN `object:write` IS NOT THE RIGHT BAR
A config source says "manifests matching these globs, in this repo, at this ref, apply AS THIS TEAM." The sync loop passes that team's object id in as `actorObjectId`, and `authz/resolve.ts` seeds its CTE AT THE SUBJECT — so the team's own role bindings resolve at depth 0 and everything the team may write, the repo may now write.

That is the same escalation shape a `member_of` edge has, and this codebase already refuses that one at both endpoints for exactly this reason (`routes/relationships.ts`'s module doc: "a from-side-only check would let any subject with `relationship:write` somewhere add themselves `member_of` an arbitrary team and inherit its role bindings"). Without the check below, an actor holding `object:write` at any scope they own could mint a `config-source` naming ANOTHER team, pointed at a repo they control, and the sync loop would faithfully apply their manifest with that team's authority. The per-diff-entry `authorize()` ADR-0046 leans on would not save it: the checks would run as the delegated team, and pass.

THE BAR IS `role_binding:write` AT THE NAMED TEAM'S OWN OBJECT — not `object:write`. Delegating an identity is a GRANT, not an edit: `object:write` at a team is the permission to rename it or fix its description, which a team's own members plausibly hold, whereas `role_binding:write` is already this codebase's spelling of "may decide what authority this subject carries" (seeded on `Administrator` and `Owner` only, `drizzle/0002_rls_rbac_seed.sql:216-223`). Registering a repo as a team is nearer the second.

WHY IT IS INSTALLED IN `graph/objects-repo.ts` AND NOT ON A ROUTE
The same reason the five authoring refusals already there are (`objects-repo.ts`'s own comments, and `governance-managed-types.ts`'s header): `POST /objects/{type}`, `POST /plans` + apply, `POST /federation/hand-fill` and `POST /federation/overlays` all reach `createObject` / `updateObject` with a free-form `typeId` and free-form `properties`. A per-route install is four lists that must agree; a choke-point install is one rule that cannot be forgotten at a door that did not exist when it was written.

`federationImport` is exempt, on the identical ground stated at every other guard there and in ADR-0033 §8: that branch has no try/catch, so a throw aborts the peer's whole signed bundle and wedges the channel. The refusal belongs at the AUTHORING instance — and a config source that arrives over the journal was authored at one, where this door ran.

### §2. Refuse a malformed or over-reaching `config-source` write

Refuse a malformed or over-reaching `config-source` write. A no-op for every other type, so the choke point pays one string comparison.

Ordering inside is deliberate and matches the convention at the call site: the SYNCHRONOUS shape refusal runs first, so a document that could never be valid is rejected before anything pays for a database round trip.

### §3. An unresolvable reference is a refusal, not a skipped check

AN UNRESOLVABLE REFERENCE IS A REFUSAL, NEVER A SKIPPED CHECK. The tempting alternative — "no such object, so there is nothing to authorize against, carry on" — is the exact shape that turns an authority check into a formality: name a team that does not exist yet, get the row written, create the team afterwards. It is also useless in the honest case: a config source naming a team nobody can resolve can never apply anything.

## `apps/server/src/config-source/cli-apply-guard.ts`

### §4. The D7 single-ownership predicate

The D7 single-ownership predicate (team-pipeline-iac proposal §4/§5, D7):

> "The one new rule is single ownership per stack: a stack bound to a config source is > repo-owned, and a direct CLI apply against it is refused (409 naming the owning config > source) — otherwise the next sync would silently revert the push. Removing the stack from the > config-source registration returns it to CLI-push."

PURE LOGIC ONLY: whether a stack IS bound to a config source is a DB read (a later increment's job, once the API-surface slot frees). This module is the decision that read feeds — given the binding (or its absence), decide whether `scp apply`'s direct path is refused, and build the self-explaining detail a 409 response carries. Every stack that is not repo-owned behaves exactly as it does today (`allowed: true`, unconditionally) — this module changes nothing about that path; it only adds the one new refusal D7 describes.

### §5. A null binding returns the stack to CLI-push

`binding` is `null` for every stack not bound to a config source — including a stack that WAS bound and had the binding removed (D7: "removing the stack from the config-source registration returns it to CLI-push"), since that removal is exactly what turns this function's next call for the same stack from the refusing branch back to `{ allowed: true }`. There is no third state: "bound but ambiguous" is `registration-match.ts`'s concern at SYNC time, not this predicate's — by the time a stack carries a binding here, sync has already resolved it to exactly one config source.

## `apps/server/src/config-source/config-source-document.test.ts`

### §6. The pure half of the config-source authoring door

The pure half of the config-source authoring door. Everything asserted here is a fact about one `properties` bag; the door that CALLS it, and the authority check that follows the parse, are driven end to end in `config-source-doors.integration.test.ts`.

The cases are chosen around one property: **a refusal here is the only thing standing between a malformed registration and a silent non-sync.** Migration 0100 deliberately keeps these rules OUT of the registered JSON Schema (a closed rule there fails a peer's whole signed bundle), so if a rule is not enforced in this file it is not enforced anywhere.

### §7. Assert on `detail`, since the title matches any 400

Every refusal here is a `ProblemError`, whose `message` is the RFC 9457 TITLE ("Bad Request") and whose sentence lives on `detail` (`errors.ts`). Asserting on `.toThrow(/…/)` therefore matches the title and passes for ANY 400 — which is how a test that names one rule ends up green for a different one. This helper returns the detail so each case asserts the rule it is about.

## `apps/server/src/config-source/config-source-document.ts`

### §8. The `config-source` DOCUMENT

The `config-source` DOCUMENT — pure shape rules for the registration object migration 0100 registers (ADR-0046 §1; team-pipeline-iac §4, D2/D7/D9).

Everything here is a fact about one `properties` bag and nothing else: no DB, no authorization, no I/O. The two consumers are the authoring door (`authoring-guard.ts`, which refuses a malformed or over-reaching document at `graph/objects-repo.ts`'s create/update choke point) and the registry read (`config-sources-repo.ts`, which turns stored rows into the `ConfigSourceRegistration` values `registration-match.ts` already decides over).

WHY THE STRICTNESS IS HERE AND NOT IN THE REGISTERED JSON SCHEMA
Migration 0100's header has the long form. Short version: the registered `property_schema` is Ajv-validated on the RECEIVING side of federation with no try/catch, so a constraint there that a peer one migration behind cannot satisfy fails that peer's WHOLE signed bundle. "Exactly one of `repo`/`repoPattern`" is precisely such a constraint — it encodes a closed set of addressing modes — so it lives here, at the operator's door, where the cost of a refusal is one 400 to the author. Strict at the operator's door, permissive on the wire.

### §9. Parse a config-source document, or 400 naming the defect

Parse and validate a `config-source` object's `properties`, or throw a 400 naming the defect.

`subject` is the caller's own description of the row ("config-source 'payments-fleet'"), so one refusal reads the same whether it came from the generic object route, an IaC apply, or a hand-fill.

### §10. Every team the document delegates to, computed not passed

Every team a document delegates TO — the default `team` plus every value in `stackTeams`, deduplicated and sorted so a refusal names them in the same order every run.

This is the set the authoring door must hold authority over, and it is computed from the document rather than passed in, so a field added to the delegation surface later cannot reach a door that never learned to look at it.

## `apps/server/src/config-source/config-source-doors.integration.test.ts`

### §11. A config-source row is an identity delegation

THE CONFIG-SOURCE REGISTRATION, AT EVERY DOOR THAT CAN WRITE ONE (ADR-0046 §1/§3, migration 0100, team-pipeline-iac §4 D7/D9).

WHAT THIS FILE HAS TO PROVE
A `config-source` row is not a document — it is an IDENTITY DELEGATION. It says "manifests from this repo apply AS THIS TEAM", and the sync loop hands that team's object id to `executePlanDiff` as `actorObjectId`, so the per-diff-entry `authorize()` ADR-0046 rests on runs AS THE TEAM and passes. The whole guarantee — "a team's stack cannot mutate another team's service" — therefore reduces to one question: who may write a row of this type, naming whom.

Three properties, and none is provable by asserting a row exists:

1. **AUTHORITY OVER THE DELEGATED IDENTITY** — writing a config source that names team T demands `role_binding:write` AT T, at every door. `object:write` somewhere is not enough, and the UPDATE half matters more than the create half because the escalation is an EDIT. 2. **THE CHECK IS NEVER SKIPPED** — an unresolvable team reference, or one naming a non-team subject, is a refusal. "No such object, so nothing to authorize against" is how an authority check becomes a formality. 3. **D7 SINGLE OWNERSHIP** — a stack bound to a config source refuses a direct CLI apply with a 409 naming it, and removing the registration returns that stack to CLI-push. Every unbound stack behaves exactly as it did before this increment.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Result (MEASURED, not predicted — two are wider than first written) |
| delete the `assertConfigSourceAuthoring` call from `createObject` | 4 FAIL — (1), (3), (4) and (5). Every case whose refusal is authored through a CREATE loses it at once, including the IaC apply door, which is the point: one choke point, four doors. | | delete it from `updateObject` | (2) alone FAILS — the PATCH repoints `team` to a team the author does not administer and returns 200. | | `authoring-guard.ts` skips (`continue`) instead of throwing on an unresolvable team | (3) alone FAILS — the ghost-team registration is written. | | the permission drops from `role_binding:write` to `object:write` | 3 FAIL — (1), (2) and (5). The Operator-at-org-root actor is admitted at every delegation door, which is exactly the bar this guard exists to raise above. | | delete the D7 block from `routes/plans.ts` | (6) alone FAILS — the repo-owned stack applies (200) and the next sync would silently revert it. | | `findStackConfigSourceBinding` matches by `repoPattern` instead of the `stackTeams` claim | (6) alone FAILS — the UNBOUND stack is refused 409, i.e. registering a namespace would have locked stacks nobody claimed. | | `listConfigSourceRegistrations` drops malformed rows instead of reporting them | (7) alone FAILS. |

ONE DEFECT THIS FILE CAUGHT IN THE CODE UNDER TEST, recorded because the fix is not obvious from the outside: case (7) first reported `detail: "Bad Request"`. A `ProblemError`'s `message` is the RFC 9457 TITLE and the sentence naming the broken rule is on `detail` — so the honest-failure report was carrying no information at all while passing an "is it reported?" assertion. Asserting the TEXT, not the presence, is what found it.

### §12. Assert status and `detail`, never the SDK's error title

Refusals are asserted as STATUS + `detail`, never as a thrown SDK error's message: the SDK surfaces the RFC 9457 TITLE ("Forbidden"), so `rejects.toThrow(/Forbidden/)` passes for any 403 — including one from a permission check that fired long before the guard under test. Every case below names the rule it is about.

## `apps/server/src/config-source/config-sources-repo.ts`

### §13. THE DB-BACKED CONFIG-SOURCE REGISTRY

THE DB-BACKED CONFIG-SOURCE REGISTRY — the read half of ADR-0046 §1, and the layer the four pure modules beside it were written to be called from (`registration-match.ts`'s own header names this as "a later increment's job").

Config sources are ordinary graph objects of type `config-source` (migration 0100): there is no table, no projection row, and no second write anywhere. So the registry read is a plain typed select over `objects`, and this module's whole job is turning stored rows into the two shapes its callers already decide over — `ConfigSourceRegistration` for `registration-match.ts`, and `StackConfigSourceBinding` for `cli-apply-guard.ts`.

A ROW THAT DOES NOT PARSE IS REPORTED, NEVER SKIPPED
`authoring-guard.ts` refuses a malformed document at every local write door, so a malformed row should not exist. "Should not" is not "cannot": the door is deliberately exempt on the federation import path (a throw there wedges a peer's whole bundle — ADR-0033 §8), and a row written before the guard existed does not re-validate itself.

Dropping such a row from the list would produce the precise failure §4 of the proposal rules out: a repository silently ahead of the graph, with a registration that exists, looks fine in a list, and never syncs. So `listConfigSourceRegistrations` returns the malformed ones ALONGSIDE the valid ones, with the reason attached, for the sync loop to surface as status. This costs the caller one field it must decide what to do with — which is the point.

### §14. Read every live config source in the org

Read every live config source in the org.

Not paginated, deliberately: every consumer needs the WHOLE set to answer its question at all — `registration-match.ts`'s two refusals are "this repo matched more than one registration" and "another registration already claims this stack name", and both are false-negative-prone on a page. One registration covers a team's entire fleet of repos (D9), so the row count is per-team-ish, not per-repo.

### §15. `.detail`, NOT `.message`

`.detail`, NOT `.message`. A `ProblemError`'s `message` is the RFC 9457 TITLE — the bare word "Bad Request" (`errors.ts`) — and the sentence saying WHICH rule the row breaks is on `detail`. Reporting the title would satisfy every "is it reported?" test while telling an operator staring at a repo that will not sync exactly nothing, which is the failure this module's header says it exists to prevent. Measured, not assumed: case (7) of `config-source-doors.integration.test.ts` failed on precisely this.

### §16. The D7 lookup

The D7 lookup: is this stack repo-owned, and by which config source?

BINDING IS THE EXPLICIT `stackTeams` CLAIM, never the repo pattern. §4 is precise about this — "per-stack ownership: `stackName → team` … Binding a stack here marks it repo-owned (D7)" — and the distinction matters in the direction that protects the operator: a team registering its whole repo namespace does NOT thereby lock every stack name it might ever push from a terminal. A stack becomes repo-owned when someone writes it into the map, which is a thing they did on purpose.

THAT IS HALF THE PREDICATE, AND THE OTHER HALF ARRIVES IN ROUND C (D26, owner ruling 2026-08-27 — proposal §5). §4's map and D9's default-team rule disagree about an UNCLAIMED stack: `registration-match.ts` resolves one to the registration's default team and the sync will apply it, but nothing here marks it repo-owned, so a CLI push to that stack succeeds and the next sync silently reverts it — D7's own failure mode, reached by forgetting a line rather than by doing anything wrong. The ruling is that **ownership follows delivery**: the sync records every stack it has applied for a config source, and this function returns the explicit claims UNION that record. `stack-delivery-repo.ts` writes it when the sync applies a stack, and this function returns the explicit claims UNION it.

ORDER OF THE UNION IS NOT ARBITRARY: the explicit claim is checked FIRST, because it is what an operator wrote and is therefore what a refusal should name. The delivered record answers only for a stack nobody claimed — precisely the case that was unprotected.

WHEN TWO REGISTRATIONS CLAIM ONE STACK NAME this returns the lowest-id one, and that is a reporting choice, not an adjudication: the answer to "is this stack repo-owned" is `true` under either, so the 409 fires either way and only the name it prints is at stake. `resolveConfigSourceForSync` refuses that same state loudly (`stack_owned_elsewhere`) when the sync itself runs, which is where it can be fixed.

## `apps/server/src/config-source/drain-sync-queue.ts`

### §17. THE CONFIG-SOURCE TRIGGER'S DRAIN

THE CONFIG-SOURCE TRIGGER'S DRAIN — the step that finally gives `syncConfigSourceCommit` a production caller (ADR-0046 section 2; proposal section 4).

THE THREE-PHASE SHAPE, AND WHY IT IS NOT ONE TRANSACTION
Reading a manifest is an out-of-process RPC into the git-provider plugin subprocess. Applying one writes the graph. Those cannot share a transaction: holding a DB connection open across an external call is the hazard already tracked against `triggerWaveTarget`, and a failed write in a shared tx aborts everything else in it — a try/catch does not help, because a caught Postgres error leaves the tx aborted and the next statement dies somewhere unrelated.

```text
1. READ-ONLY tx — what is pending, and which registrations cover it.
2. NO tx — fetch every selected manifest over the plugin RPC.
3. WRITE tx — CLAIM the entries (`FOR UPDATE SKIP LOCKED`), run the sync against the already-
   fetched bytes, mark them drained.
```

The claim lives in phase 3, which is where correctness lives: two concurrent ticks may both prefetch the same manifest (wasted bytes, no harm), and exactly one will claim the row and apply.

THE ENGINE'S `readManifest` SEAM IS WHY THIS COMPOSES AT ALL
`syncConfigSourceCommit` takes the read as a parameter rather than doing it. So phase 3 hands it a closure over the phase-2 results and the engine runs entirely inside the write transaction with no I/O of its own — which is exactly what that seam was for.

### §18. A throw is a real fault: mark drained rather than retry

The sync engine does not throw for an ordinary stopping point — it returns a status. So a throw here is a genuine fault, and the entry is marked drained WITH it rather than retried: the repo stays ahead of the graph as a displayed state, and the next push enqueues fresh work. Its own transaction, so the failed one is already rolled back and this write is on a clean connection.

## `apps/server/src/config-source/manifest-path-selection.ts`

### §19. Manifest path selection

Manifest path selection (team-pipeline-iac proposal §4, D9): given a config source's `paths` globs and the paths one commit diff touched (`ExtractedHint.paths`, `coordination/webhook-processor.ts`), decide which changed paths are stack manifests this sync should read.

MATCHER CHOICE — deliberately NOT `coordination/glob-match.ts`
`glob-match.ts` translates a leading `**\/` literally: `.*` followed by a literal `/`, which requires AT LEAST ONE character before that slash. So `**\/go.mod` matches `services/go.mod` but MISSES a repo-root `go.mod` — the exact case `packages/plugins/git-provider-core/src/read-tree.ts`'s `globMatchesPath` documents and fixes (a leading `**\/` also matches ZERO leading segments).

A repo-root `scp/manifest.json` is the single most common config-source case (D9: "the same repo that drives a component's releases carries `scp/stack.ts` + its committed `scp/manifest.json`" — for a great many components that IS the repo root). Inheriting `glob-match.ts`'s gap here would make the default case — a team registers `paths: ["**\/scp/manifest.json"]` (or the scaffolder's own emitted default) expecting it to also catch a root-level `scp/manifest.json` — silently miss the manifest on every sync. That is precisely the "repo ahead of the graph, displayed as nothing" failure §4 rules out, one layer earlier than `sync-status.ts` even gets involved: the manifest is never read, so there is no attempt to report a status for.

This module therefore uses a CORRECTED matcher, `manifestPathGlobMatch`, whose regex translation is IDENTICAL to `read-tree.ts`'s `globMatchesPath` (same grammar: `*` within a segment, `**` across `/`, PLUS a leading `**\/` also matching zero leading segments). It is duplicated rather than imported from `@scp/git-provider-core` for the same reason `registration-match.ts` duplicates `manifest-reader.ts`'s identity rule instead of importing it: every existing `apps/server` reference to `@scp/git-provider-core` is a TYPE-ONLY import (the package's runtime code executes inside the plugin subprocess, never in the host process — see `plugin-host/host.ts`'s `gitFileRead()`); a fresh runtime import would be a new, unprecedented dependency shape for a dozen lines of pure regex logic that this codebase's own convention says to duplicate instead (`read-tree.ts`'s own header gives the identical reasoning for why IT duplicates `glob-match.ts` rather than importing it, in the opposite direction).

WHAT WOULD CHANGE IF `glob-match.ts` WERE FIXED CENTRALLY INSTEAD — REPORTED, NOT DECIDED HERE
`glob-match.ts` has two existing consumers: `dependencies/inventory-ingestion.ts` and `coordination/correlation.ts`. Measured against what they actually store (both files' own comments and the patterns their tests/docs give):

- Every `source_mappings.pathPattern`/`repoPattern` this codebase's own code documents as ACTUALLY AUTHORED is a SUFFIX wildcard (`${componentPath}/**`) or a plain namespace pattern (`acme/*`) — never a pattern that STARTS with `**`. `read-tree.ts`'s own header states this explicitly ("every `source_mappings.pathPattern` in this codebase is `${componentPath}/**`, a SUFFIX use"). So on TODAY's stored data, fixing `glob-match.ts` centrally would be a no-op for both consumers — no stored pattern exercises the changed branch. - It would stop being a no-op the moment an operator authored a leading-`**` pattern, and `inventory-ingestion.ts` is the more likely place that happens: its whole job is finding dependency manifests (`go.mod`, `package.json`, …) anywhere in a repo, and its own module doc already reasons carefully about wildcard-headed patterns (`hasGlobMeta`, the literal-prefix walk in `repoManifestScope`) — a `pathPattern` of `**\/go.mod` to catch a root-level `go.mod` is exactly the shape that doc anticipates an operator reaching for, and it would silently fail to match the root file today, the identical hazard this module exists to avoid for config-source manifests. `correlation.ts`'s `pathPattern`/`repoPattern` matching has the same latent gap but no equivalent "root file" framing in its own comments — it is a smaller realistic hit.

RECOMMENDATION: fix `glob-match.ts` centrally (add the same leading-`**\/`-matches-zero-segments rule `globMatchesPath` already carries) rather than leave two call sites carrying a landmine that is merely unexercised today, not absent. Left to the owner per this increment's brief.

### §20. A PROVISIONAL grouping key

A PROVISIONAL grouping key — the manifest's containing directory (everything before its final path segment; `""` for a repo-root manifest). This is NOT the manifest's `stackName`: a synthesized `scp/manifest.json` can declare a stack name unrelated to its directory, and the only way to learn it is to read and parse the file (a later, DB/HTTP-backed increment). This key exists so a sync loop can dedupe "read this manifest" work items — two changed paths sharing a directory are almost certainly the same manifest touched twice in one diff — BEFORE any I/O happens, and it must never be presented to a user as the stack's identity.

### §21. Filter a commit's changed paths by the registered globs

Filter `changedPaths` (a commit diff's touched files) down to the ones matching at least one of `pathGlobs` (a config source's registered `paths`), deduplicated and in the order they first appeared in `changedPaths`. An empty `pathGlobs` matches nothing — the caller's registration schema is responsible for requiring at least one glob; this function does not assume that and simply returns no matches rather than throwing, since "this registration selects nothing" is a legible (if useless) state to report, not a caller bug this function is positioned to catch.

## `apps/server/src/config-source/registration-match.ts`

### §22. Config-source registration matching

Config-source registration matching (team-pipeline-iac proposal §4, D9; ADR-0046 §1).

A config source names either ONE repo or a namespace/pattern covering a team's whole fleet (`git.corp.example/payments/*` -> `team-payments`), plus a per-stack `stackName -> team` ownership map — the team whose identity a matched stack's plan/apply runs as (D9, corrected 2026-08-27: the acting subject is the `team` object itself, never a service account).

Two things must be a LOUD REFUSAL rather than a silent pick, per D9's own text: "a repo that appears in two patterns, or a stack name already owned elsewhere, is a loud refusal at sync, never last-writer-wins." This module is the pure decision behind both — no I/O, no persistence, a plain array of registrations and a plain repo/stack identity in, one typed, exhaustive result out.

PURE LOGIC ONLY (increment 4): this module never reads a config-source registration from Postgres. The DB-backed registry (create/list/persist a `ConfigSourceRegistration`) is a later increment's job, once the API-surface slot frees; this is the decision that registry will call.

REPO IDENTITY: reuses the exact rule `apps/server/src/dependencies/manifest-reader.ts` already established for matching a repo against a git-provider binding — trimmed, slashes stripped, case-folded, and EXACT for a single-repo registration ("never a prefix, never the org's first binding"). Duplicated here (not imported) because `manifest-reader.ts` also pulls in `Db`/ `PluginHost`/`withTenantTx` for its DB-backed half, and this module must stay free of anything requiring a database — the same reasoning `read-tree.ts` gives for duplicating `coordination/glob-match.ts`'s grammar rather than importing across a package boundary. The RULE is reused verbatim; only the machinery around it differs.

PATTERN IDENTITY: a `repoPattern` registration matches using `coordination/glob-match.ts`'s existing grammar (`*` within a segment, `**` across `/`) — chosen deliberately over `read-tree.ts`'s corrected matcher (see `manifest-path-selection.ts` for that one and why it diverges): every `repoPattern` this proposal's own examples give (`git.corp.example/payments/*`) is a SUFFIX wildcard, the same shape `source_mappings.repoPattern` already uses everywhere in this codebase, so `glob-match.ts`'s leading-`**\/`-vs-zero-segments gap never arises here. See `manifest-path-selection.ts`'s module doc for the full report on that gap and why THAT module cannot inherit it.

### §23. One config-source registration

One config-source registration. Exactly one of `repo` / `repoPattern` identifies what it covers — the caller (the DB-backed layer, a later increment) is responsible for enforcing that shape; this module treats "neither set" defensively as "matches nothing" rather than throwing, because a registration that matches nothing is a legible (if useless) state, not a caller bug this function is positioned to catch.

### §24. The result of resolving ONE

The result of resolving ONE (repo, stackName) sync attempt against every registration in force.

"No match" (`no_match`) is an ordinary outcome — most repos are not registered at all. The two refusal kinds are distinguishable from it AND from each other by `outcome`, never collapsed into a boolean or a thrown error a caller has to inspect a message to classify.

### §25. Resolve which registration

Resolve which registration (and therefore which team identity) governs a sync attempt for one repo/stackName pair, or which of D9's two loud refusals applies.

Ordering is deliberate: repo ambiguity is checked before stack ownership, because an ambiguous repo match has no single "matched registration" to check stack ownership against in the first place — reporting `ambiguous_repo` first is the only choice that is even well-defined.

## `apps/server/src/config-source/stack-delivery-repo.ts`

### §26. THE DELIVERY RECORD

THE DELIVERY RECORD (D26, owner ruling 2026-08-27) — which stacks a config source has actually applied, and therefore owns.

`config-sources-repo.ts`'s header states the gap this closes: §4 makes the explicit `stackTeams` map the D7 binding, D9 gives an unclaimed stack the registration's default team, and between them sat a stack the sync applies every time the repo changes while the CLI-apply guard called it unowned — so a push succeeded and the next sync silently reverted it. Ownership follows delivery.

ONE STACK HAS ONE OWNER, AND THE DATABASE IS WHAT SAYS SO
The primary key is `(org_id, stack_name)`. `recordStackDelivery` therefore does an UPSERT whose `DO UPDATE` is GUARDED by `config_source_id` — a second config source delivering a stack the first already owns updates ZERO rows, and this function reports that as `owned_by_other_source` rather than swallowing it. An unguarded `DO UPDATE` would be last-writer-wins, which is exactly what D9 says must never happen, and it would be invisible: the insert would "succeed" every time and the owner would flip with whichever repo pushed last.

## `apps/server/src/config-source/sync-engine.integration.test.ts`

### §27. THE SYNC ENGINE, END TO END

THE SYNC ENGINE, END TO END (ADR-0046 §1/§2; team-pipeline-iac §4/§5, D3/D9/D26).

WHAT THIS FILE HAS TO PROVE
Round A merged four pure decisions and wired none of them; round B made the registration real. This is the caller, and the properties that matter are the ones a green "it applied" would not establish:

1. **THE TEAM IS THE ACTOR, AND ITS AUTHORITY BINDS.** A manifest that reaches outside the team's scope is refused even though the sync loop holds no credential and could trivially have called `executePlanDiff` with a system actor — the shortcut ADR-0046 §1 names and forbids, whose defining property is that everything still works. 2. **EVERY REFUSAL IS EVALUATED, NOT THE FIRST.** The status an operator reads is all of them. 3. **FAILURE IS DISPLAYED, NEVER INFERRED.** Unreadable, unparseable, invalid, refused, frozen — each produces a status AND a Decision carrying the commit SHA and manifest content hash. 4. **FREEZES HOLD, THEY DO NOT BLOCK** — nothing is written, nothing errors, and the same commit applies once the window lifts. 5. **D26: OWNERSHIP FOLLOWS DELIVERY** — a stack nobody wrote into `stackTeams` is repo-owned after the sync applies it, and D7's refusal then covers it.

MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
| Mutation | Result |
| apply with `SYSTEM_ACTOR_ID` instead of the team, checks skipped — THE SHORTCUT ADR-0046 §1 FORBIDS | (1) FAILS: the out-of-scope manifest applies. Nothing else notices, which is the whole reason that shortcut is named in the ADR rather than left to judgement. | | collect only the FIRST authz refusal (`break`) | (1) FAILS: one refusal reported where three are real. | | `findStackConfigSourceBinding` drops the delivered half | (4) FAILS: a stack the sync just applied reads as unowned, so a CLI push would be admitted and reverted. | | record the delivery AFTER `executePlanDiff` instead of before | (6) FAILS: the second config source's objects are written before the ownership refusal is discovered. | | the delivery upsert loses its `setWhere` ownership guard | (6) FAILS: ownership silently transfers to whichever source pushed last — D9's "never last-writer-wins", in the one place a read-then-write cannot see it. | | freeze targets read `id` only, without the `scopeObjectId` fallback | (7) FAILS: a create-only manifest waves straight through an active freeze, because a diff of creates has no ids yet and an empty target list is indistinguishable from "nothing frozen". |

THE LAST ONE WAS A REAL DEFECT, found by writing the case rather than by review: the first cut of `affectedObjectIds` returned ids only.

## `apps/server/src/config-source/sync-engine.ts`

### §28. THE CONFIG-SOURCE SYNC ENGINE

THE CONFIG-SOURCE SYNC ENGINE (ADR-0046 §1/§2; team-pipeline-iac §4/§5, D2/D3/D9/D26) — one commit's worth of repo-driven IaC delivery, and the first production caller the four pure decision modules beside it have ever had.

WHAT IT DOES, IN THE ORDER IT DOES IT
For one (config source, commit) pair: select the changed paths that are manifests, read each, validate it, decide whose identity applies it, run the SAME plan/apply path the HTTP route runs, and record a status and a Decision for every one of those steps that can stop.

THE FORBIDDEN SHORTCUT, NAMED IN ADR-0046 §1 AND NOT TAKEN HERE
This engine is not an HTTP caller and holds no credential, so it would be trivially easy to call `executePlanDiff` with `SYSTEM_ACTOR_ID` the way the reconcile engine does for its own writes. That would void this design's central promise — "a team's stack cannot mutate another team's service" — silently, because everything would still work. Instead the config source's resolved TEAM OBJECT is the actor: `authz/resolve.ts` seeds its CTE at the subject, so a team's own role bindings resolve at depth 0, and `prepareApplyChecks` + a per-check permission test run exactly as `routes/plans.ts` runs them.

ONE DELIBERATE DIVERGENCE FROM THE ROUTE, and it is about honesty rather than authority: the route calls `authorize()`, which THROWS on the first denial. Here every check is evaluated and every refusal collected, because the status this produces is the only thing an operator will see — "refused" naming one of nine denials, when the other eight are also real, sends them round the loop nine times. The apply is refused if ANY check fails, identically to the route.

WHY A `readManifest` SEAM RATHER THAN A PLUGIN-HOST CALL
The caller supplies the read. The host's `gitFileRead(instanceId).readFileAtRef(...)` needs a resolved git-provider instance (`dependencies/manifest-reader.ts` does that resolution today), it is an out-of-process RPC, and it must not run inside the transaction this engine mutates the graph in. Keeping it a parameter is what lets the trigger layer own instance resolution and lifetime while this module stays a decision that can be driven from a test without a subprocess. SCP reads ONLY the committed JSON and never executes team TypeScript (D2, charter principle 1).

### §29. Attempt status and registration refusal stay distinct

The six-way display status, OR a registration-level refusal that happens BEFORE a sync attempt has a governing registration at all (`registration-match.ts`'s two). Kept distinguishable because they are answers to different questions: "which registration governs this?" versus "where did this attempt stop?" — collapsing them would make `sync-status.ts`'s exhaustive six-way space quietly seven-way and untyped.

### §30. The scope fallback is the point: a create has no id yet

Every object a diff would touch, for the freeze coverage question.

`id ?? scopeObjectId`, AND THE FALLBACK IS THE WHOLE POINT. A `create` entry has NO id until `executePlanDiff` runs it, so an id-only reading would ask about an empty target set for a manifest that creates rather than updates — i.e. a freeze would hold edits to existing objects and wave brand-new ones straight through, which is backwards and would be invisible (an empty list produces no freezes, which reads exactly like "nothing frozen"). `scopeObjectId` is the resolved containment parent the create would land under, and containment is what `freezesByTarget` walks, so it is the correct question for a not-yet-existing object.

Relationship entries are addressed by their endpoints, which are objects, so the object set covers them.

### §31. Sync one commit of one config source

Sync one commit of one config source. Returns one outcome per manifest path it selected — an empty array when the commit touched nothing this registration selects, which is the ordinary case and is not an error.

NOTHING THROWS FOR AN ORDINARY FAILURE. A manifest that cannot be read, does not parse, is refused by authz, or is held by a freeze produces an OUTCOME and a Decision, because §4's failure honesty rule is that "the repo being ahead of the graph must be a displayed state, not an inferred one" — and a throw here would abandon the remaining manifests of the same commit.

## `apps/server/src/config-source/sync-queue-repo.ts`

### §32. THE CONFIG-SOURCE TRIGGER'S TWO HALVES

THE CONFIG-SOURCE TRIGGER'S TWO HALVES (migration 0109; ADR-0046 section 2, proposal section 4).

ENQUEUE runs inside the webhook pass's transaction and does the one thing that is safe there: records that a registered repo moved. DRAIN runs on its own reconcile step, outside that transaction, because reading a manifest is an out-of-process RPC and applying one writes the graph - neither belongs inside a shared tx whose other work is correlating unrelated events.

A FAILED DRAIN IS STILL A DRAIN. `processed_at` is set either way and the reason is recorded, so a repo that is ahead of the graph shows up as a DISPLAYED state (proposal section 4's failure honesty) rather than as an entry retried forever. Retrying a manifest that does not validate would never converge, and the next push enqueues fresh work anyway.

### §33. Record that a registered repo moved

Record that a registered repo moved.

ON CONFLICT DO NOTHING against the PENDING partial unique index: a provider redelivery while an entry is still pending is the same work. Once drained, the same commit may enqueue again — see the migration header for why that is deliberate rather than a leak.

### §34. Claim pending entries for one org, oldest first

Claim pending entries for one org, oldest first.

`FOR UPDATE SKIP LOCKED`, the same claim `processChangeSourceEvents` uses: two concurrent ticks (or two workers, once the deployment scales) never both drain one entry. Without it the second would re-apply a manifest the first is mid-apply on.

## `apps/server/src/config-source/sync-status.ts`

### §35. Config-source sync status computation

Config-source sync status computation (team-pipeline-iac proposal §4, "failure honesty"):

> "A manifest that fails validation or an apply that is refused (authz, freeze, strict-create) > produces a visible config-source status (API/UI/CLI) and a Decision — never a silent skip. The > repo being ahead of the graph must be a *displayed* state, not an inferred one."

A sync attempt stops at exactly one of six places, and this module's whole job is making that six-way space EXHAUSTIVE in the type system, so a status can never be inferred by its absence:

```text
1. the manifest could not be read at all (git error, not found, refused-too-large) —
   `manifest_unreadable`
2. it was read but failed schema validation — `manifest_invalid`
3. it validated but `authorize()` refused one or more diff entries — `authz_refused`
4. it authorized but an active freeze parks the apply (ADR-0028 hold shape, "freezes hold, not
   block") — `freeze_held`
5. it applied, and the plan carried at least one non-noop entry — `applied`
6. it applied, and the plan was entirely `noop` (idempotent re-sync of an unchanged manifest,
   §5 "Idempotent") — `no_op`
```

`computeConfigSourceSyncStatus` takes `SyncAttemptOutcome` — where ONE sync attempt actually stopped, as the caller (a later increment's DB-backed sync loop) observed it — and maps it onto the display status above. The switch below has NO `default:` branch: TypeScript's exhaustiveness check on the `never` assignment is what makes a forgotten case a COMPILE ERROR here rather than a status that silently falls through to nothing, which is exactly the bug this module exists to make structurally impossible.

### §36. A new stage without a case fails the build here

Unreachable for any value `SyncAttemptOutcome` can type-check as: `outcome` narrows to `never` here only if every stage above was handled. A NEW stage added to the union without a matching `case` fails the build at this line — the type system, not a code reviewer, is what keeps this switch exhaustive. Left as a thrown error (never a fallback status) so that even a `// @ts-expect-error`-forced bad value at a call site is loud at runtime too, rather than being silently reported as some OTHER, unrelated status.

## `apps/server/src/config-source/trigger.integration.test.ts`

### §37. THE CONFIG-SOURCE TRIGGER, END TO END

THE CONFIG-SOURCE TRIGGER, END TO END (ADR-0046 section 2; proposal section 4, increment 4).

WHAT WAS MISSING UNTIL NOW
The registration (round B), the sync engine (round C) and the ownership record (D26) all landed and NOTHING CALLED THEM. `syncConfigSourceCommit` had no production caller — the repo's named dominant failure, and I said so in every PR rather than implying a live path.

This is the path: a push arrives as a `change_source_events` row -> the webhook pass ENQUEUES it against every registration covering that repo -> a reconcile tick DRAINS the queue, reads the manifest over the plugin RPC, and applies it as the team.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| delete the enqueue from `processChangeSourceEvents` | (1) and (2) FAIL — nothing is recorded, so nothing drains | | **delete the drain from `reconcileOrgTick`** | (2) and (3) FAIL, and (1) stays green — the enqueue half cannot tell a wired drain from an unwired one, which is why (2) and (3) go through the REAL tick rather than calling the drain directly | | the drain never marks an entry processed | (2) and (3) FAIL — the entry stays pending and is re-applied on the next tick |

THREE FIXTURE FACTS THIS TEST TAUGHT ME, each a failure first and each recorded where it bit: a GitHub delivery needs its `x-github-event` HEADER or `extractHint` falls back to the flat generic shape and never sees the repo; `bindingRepoIdentity` reads `owner`+`repo` (or a GitLab `projectPath`), never a bare `repo`; and two registrations covering ONE repo is `registration_ambiguous` by design, so sharing a repo across cases made every drain refuse — the matcher working and the fixture wrong.

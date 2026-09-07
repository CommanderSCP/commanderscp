# plugin-api

Long-form reference for the **plugin-api** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 28 of 28 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/plugin-api/src/contract-shape.test.ts`](#packages-plugin-api-src-contract-shape-test-ts) — §1–§1
- [`packages/plugin-api/src/dedup-cache.test.ts`](#packages-plugin-api-src-dedup-cache-test-ts) — §2–§2
- [`packages/plugin-api/src/dedup-cache.ts`](#packages-plugin-api-src-dedup-cache-ts) — §3–§3
- [`packages/plugin-api/src/index.ts`](#packages-plugin-api-src-index-ts) — §4–§25
- [`packages/plugin-api/src/scoped-http-response-too-large.test.ts`](#packages-plugin-api-src-scoped-http-response-too-large-test-ts) — §26–§26
- [`packages/plugin-api/vitest.config.ts`](#packages-plugin-api-vitest-config-ts) — §27–§28

## `packages/plugin-api/src/contract-shape.test.ts`

### §1. `@scp/plugin-api` IS TYPES ONLY

`@scp/plugin-api` IS TYPES ONLY — every export above `STUB`-level is an `interface` or a `type`, and `dist/index.js` is empty. That is why this package had no tests and why its `test` script carried `--passWithNoTests`: there was no runtime surface to call.

WHAT THIS FILE HONESTLY IS, AND IS NOT. It is NOT a behaviour test — there is no behaviour here. It is a TYPE-LEVEL PIN of the three closed unions the rest of the product switches on, and its teeth are in `pnpm typecheck`, not in `vitest`: `Exactly<…>` fails to compile if a member is added to or removed from the union without updating the list beside it. The runtime `expect` below is the weaker half — it makes the package non-empty so `vitest run` (now without `--passWithNoTests`) has something to run, and it prints the intended list when the type check fires.

WHY THESE THREE UNIONS. Each is consumed by an exhaustive `switch`/mapping somewhere that does NOT live in this package — `ExecutionPhase` by the reconciler and the UI's status badges, `ControlOutcomeStatus` by the gate evaluation, `DependencyIndexEcosystem` by the manifest parsers. Widening one of them is a source-compatible edit HERE that silently leaves a hole THERE.

## `packages/plugin-api/src/dedup-cache.test.ts`

### §2. Six executor plugins

Six executor plugins (`argocd`, `argo-workflows`, `pipeline-generic`, `managed-iac`, `fake-executor`, `git-provider-core`) each carried their own copy of this write-to-temp+rename dedup-state triad; this pins the ONE shared implementation's contract so a future fix to the atomic-write logic lands everywhere at once instead of needing six manual edits.

## `packages/plugin-api/src/dedup-cache.ts`

### §3. File-backed JSON dedup-state cache

File-backed JSON dedup-state cache — the write-to-temp+rename persistence shape every `ExecutorPlugin` uses to survive a subprocess-host restart mid-wave without losing its idempotency ledger (`trigger()`'s dedup map). Extracted after this exact triad — a module- or instance-scoped in-memory fallback plus a `loadState`/`saveState` pair — was found character-for-character duplicated across `@scp/plugin-argocd`, `@scp/plugin-argo-workflows`, `@scp/plugin-pipeline-generic`, `@scp/plugin-managed-iac`, `@scp/plugin-fake-executor` and `@scp/plugin-git-provider-core`: a bug fix to the atomic-write logic needed six manual copies.

`normalize` exists only for `argo-workflows`, whose on-disk shape predates the `abortedNames` field and backfills it on load; every other caller can omit it and get a plain `as T` cast.

## `packages/plugin-api/src/index.ts`

### §4. The six stable, independently semver'd plugin interfaces

@scp/plugin-api — the six stable, independently semver'd plugin interfaces (DESIGN.md §11).

M3 (BUILD_AND_TEST.md §8 M3 item 7) is the first real implementation: `ExecutorPlugin` is fully specified and exercised (the in-repo fake executor + the subprocess plugin host + `@scp/plugin-testkit`'s conformance suite). The other five interfaces are specified here to the same contract shape (JSON-serializable args/results only, injected `PluginContext`) so their M4/M6/M7 implementations never need a breaking change to this package, but nothing implements them yet.

Every call crosses a host-mediated seam (DESIGN.md §11): JSON-serializable args/results only, an injected scoped `PluginContext`, host-enforced timeouts, and standardized error mapping. In M3 the host is the subprocess plugin host (`apps/server/src/plugin-host/`) — one child process per configured plugin instance, JSON-RPC 2.0 over stdio.

### §5. Response-body ceiling, enforced while accumulating

Optional hard ceiling on the response BODY size in bytes, enforced by every conforming `ScopedHttpClient` implementation DURING accumulation — never after the full body already sits in memory (M21.2 review MAJOR 5: a cap checked post-buffer is not a cap). Exceeding it aborts the read mid-stream (the implementation cancels the underlying transport read rather than letting it run to completion) and the call REJECTS with a `ScopedHttpResponseTooLargeError` — never a silently truncated body.

OPT-IN, not a default: `undefined` preserves the pre-existing unbounded-accumulation behavior for any call site that has not been migrated to set it yet — adding this field does not, by itself, change what an existing caller experiences. `@scp/git-provider-core`'s `readFileAtRef`/`api()` helpers are the first callers to set it on every request they make.

### §6. The typed failure `maxResponseBytes` raises, shared by all

ScopedHttpResponseTooLargeError — the typed, loud failure `maxResponseBytes` produces. Lives here (not in a single implementation) because every conforming `ScopedHttpClient` — the production fetch-backed one (`apps/server/src/plugin-host/subprocess-entry.ts`) AND every package's own `node:http`/`node:https`-backed test client (`*-test-support.ts`, needed because `nock` does not intercept `fetch` — see those files' module docs) — throws the SAME shape, so a consumer like `@scp/git-provider-core`'s `wrapProviderRequestError` can recognize it by property regardless of which transport produced it.

### §7. An opaque scope key for plugin-instance isolation

An opaque, host-supplied **scope key** for plugin-instance isolation: the label the host stamps on a plugin invocation so logs, secret lookups and egress accounting can be partitioned per plugin instance. Treat it as a partition label, never as an identifier you can resolve, join on, or dereference.

**This is not a domain id in either SCP sense.** It is neither a `TrustDomainId` (the federation/security-domain identity of a deployment) nor a `ContainmentDomainId` (the id of a `domain` graph object) — see `@scp/schemas`'s `domain-ids.ts` and [ADR-0021](../../../docs/adr/0021-terminology.md) D4, which brands those two so they can never be confused. In practice this value is not a uuid at all: every in-tree host populates it with a literal (`"default"`, `"commander"`, `"shared"`, `"domain-1"`).

It stays a plain, deliberately **unbranded** `string` for exactly that reason — branding it would either force a bogus brand onto `"default"` or fail to compile against values that were never ids.

Until 2026-07-24 this field was named `domainId`, which made it look like a third sense of "domain id". ADR-0021 D4 records the owner decision to rename it to `scopeKey` — a **breaking change to a public plugin contract**: an out-of-tree plugin reading `ctx.domainId` must be updated. The wire form crossing the host/subprocess seam changed with it (the plugin host's `SCP_PLUGIN_DOMAIN_ID` env var is now `SCP_PLUGIN_SCOPE_KEY`), so host and plugin runtime move together.

### §8. ExecutorPlugin (DESIGN.md §11, §12)

ExecutorPlugin (DESIGN.md §11, §12) — the coordination boundary is enforced structurally: no execute()/deploy() verb exists. `trigger` can only invoke automation the target execution system already defines (its own workflow, its own Application sync, its own pipeline).

### §9. EVERY path the event touched

EVERY path the event touched — the changed-file set of a push, not a single location.

`path` (singular) is a *location* hint some providers carry natively (a release's target commitish, a package path). It cannot express a commit, because one commit touches many files, and a `source_mappings` row with a `pathPattern` is SKIPPED outright when the event carries no path it can test (`coordination/correlation.ts`). That is why a repo-only mapping set on a monorepo collapses to exactly ONE live route — the most-constrained-then-oldest winner — and every other mapping on that repo silently never fires.

A pattern matches when it matches `path` OR **any** entry here, so populating this is what lets one repo fan out to per-directory components. Additive and optional: a provider that cannot determine the changed set leaves it undefined and behaves exactly as before.

### §10. An opaque provider identity, used only to deduplicate

An OPAQUE provider-side identity for the state this event reports — used only to deduplicate repeated observations of an unchanged thing. Never parsed, never matched against `source_mappings`; the host treats it as a bag of bytes.

It exists because not every provider's "what state is this in" is a single commit or digest. A multi-source Argo CD Application is synced to a TUPLE of revisions (`status.sync.revisions`), one per source, and none of them alone identifies the deployment — so neither `commitSha` nor `artifactDigest` can honestly carry it, and stuffing a joined list into a field named "commit SHA" would lie to every consumer that reads one.

Set this whenever an event would otherwise fall back to `occurredAt` for its identity and the provider's timestamp advances on its own schedule — Argo CD rewrites `reconciledAt` every few minutes whether or not anything changed, so without a state ref every idle reconcile is a new row forever.

### §11. The fully-qualified git ref

The fully-qualified git ref (`refs/heads/dev`) this event is on — the input a `refPattern` source mapping routes on (ADR-0030 §1). Kept distinct from `correlationKey`, which is a GROUPING identity whose composition varies by event kind; see `GitProviderEventHint.ref`.

Poll-vs-push equivalence (DESIGN §12) depends on this being set here as well as on the webhook path: a git provider's `observe()` and its webhook adapter run the SAME `mapEvent`, so a ref-scoped mapping must route a POLLED push exactly as it routes a delivered one. Undefined for any event with no ref.

### §12. What `trigger` may ask: a closed coordination vocabulary

What `trigger` may ask for — deliberately a closed, coordination-shaped vocabulary (invoke automation the org already defined; never "deploy this artifact"). `rollback` carries the `priorStateRef` a prior `status()` call captured, so trigger-a-rollback and trigger-a-forward change are the exact same verb with different intent data (DESIGN §9.4).

### §13. Stable across retries of the SAME logical trigger attempt

Stable across retries of the SAME logical trigger attempt (PR #7 review, CRITICAL #2: the engine derives this deterministically from the wave-target row's own id, so it is IDENTICAL every time coordination/reconcile.ts re-calls `trigger()` for that target — including after a crash/resume where the engine can't tell whether the previous call's side effect actually fired before the process died). A real executor plugin uses this to de-duplicate: the SAME key must return the SAME `ExternalRunRef` without firing the automation a second time; a DIFFERENT key is a genuinely new run. Optional only because `TriggerIntent` predates this field and hand-constructed test intents may omit it — the engine itself always sets it.

### §14. Opaque executor state, bounded before it is ever stored

Opaque snapshot of executor-side state at this point in time — what a later rollback restores.

BOUNDED BEFORE IT IS STORED (M23.1f), on BOTH routes it takes: `change_wave_targets.observed_state` as `revision`, and `prior_state_ref` via `markWaveTargetTriggered`. A snapshot that renders to more than the column policy comes back shortened, so an executor that needs a rollback to address it must keep it SMALL — a hash or a handle, not a serialised world. The rollback path is exercised end to end against a real bound in `apps/server/src/coordination/executor-ref-prior-state-bound.integration.test.ts`.

### §15. A structured snapshot of what the executor has deployed

Structured, machine-readable snapshot of what the executor currently has deployed (ADR-0008 decision 2) — distinct from the free-form `detail` string and the rollback-reserved `stateRef`. Optional and additive: executors that expose no such signal simply omit it. It carries the deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or `...@sha256:...`) and, for progressive-delivery executors (Argo Rollouts), an OBSERVE-ONLY `rollout` sub-state (ADR-0008 signal / P4D increment 4).

`rollout` mirrors a canary/blue-green rollout's progress as the executor reports it — it does NOT let CommanderSCP DRIVE the rollout (charter principle 1: coordinate, not execute; ADR-0008 "rollout state is OBSERVED, NOT DRIVEN"). No verb here promotes/pauses/aborts/re-weights a rollout. EVERY field is optional because only `phase`/`message` are near-free from the parent Application body; structured `step`/`weight` require the executor to expose the live Rollout manifest and are version-dependent — omitted (never fabricated) when the executor does not report them.

### §16. D12's rollout authority split

D12's rollout authority split — WHO OWNS THE ROLLOUT, DECLARED BY THE PLUGIN.

```text
authoritative — the plugin performs the rollout to SCP's declaration (the `scp-runner-*`
                managed classes, where SCP is the executor).
triggerParams — the executor runs its own automation and accepts SCP's declaration as trigger
                parameters.
verified      — the executor owns the rollout entirely; SCP compares DECLARED against the
                OBSERVED state it already reads (`ExecutionStatus.observed.rollout`, ADR-0008)
                and surfaces divergence LOUDLY. It never re-weights anything: no verb here
                promotes, pauses, aborts or re-weights a rollout, and none may be added
                (charter principle 1; ADR-0008 "rollout state is OBSERVED, NOT DRIVEN").
```

The point of putting this on the CAPABILITY DECLARATION rather than in a server-side table keyed by executor kind is D12's own rule: the authority split is READ FROM THE BINDING, never assumed per executor kind. Two Argo CD instances can be bound with different rollout arrangements, and a hardcoded "argocd means verified" would be wrong for one of them with no way to say so.

### §17. Must stay identical to the schemas' rollout target class

MUST stay identical to `RolloutTargetClassSchema` in `@scp/schemas/pipeline-behaviors` — which is itself now a DERIVED NARROWING of `InfraKindSchema` (D24), not a hand-written list; this copy stays hand-written string literals regardless, for the reason below.

Kept as a self-contained string union here for the same reason `DependencyIndexEcosystem` and `DiscoveryProposal.sourceMappings[].type` are: `@scp/plugin-api` stays free of a `@scp/schemas` dependency, and that boundary is worth more than enum non-duplication. But read the warning on `DependencyIndexEcosystem` before treating a third copy as harmless — the first two copies of the ecosystem vocabulary DID drift (`image` vs `oci`), precisely because no test crossed the boundary. So this copy is pinned against the Zod enum at runtime by a total-`Record` test whose keys this union generates, exactly as that one is: a value added on one side and not the other is then a compile error rather than a silently misrouted rollout.

RENAMED `"kubernetes"` → `"cluster"` (team-pipeline-IaC D24, this session): the canonical `InfraKindSchema` names this member after the product KIND (matching `instanceGroup`/`database`/ `bucket`/`queue`), not the technology backing it. See `InfraKindSchema`'s doc comment in `@scp/schemas/pipeline-behaviors` for the full reconciliation between D24's `Cluster` prose name and this repo's `kubernetes` precedent.

### §18. A recurring probe the executor holds until retracted

A recurring probe the executor should hold until told otherwise (team-pipeline-iac D11, owner decision 2026-08-28: outposts run the probes).

`cadenceSeconds` is the SCHEDULE THE EXECUTOR OWNS. SCP does not tick it — the three places that say so (`ManifestContinuousHookSchema`, `pipelineHooks.everySeconds`, migration 0096) are unchanged by this: SCP declares the cadence once and the executor's own scheduler runs it. That is the difference between this and `trigger`, which invokes exactly one run.

### §19. Declare a recurring automation: additive, not a core verb

Declare a RECURRING automation the executor holds until retracted. OPTIONAL — the four verbs above stay the closed set every executor implements (ADR-0032 §9); this is additive, so every existing plugin is unchanged and simply declares no schedule capability.

STILL COORDINATION, NOT EXECUTION. It hands the executor a declaration naming the executor's OWN automation and the cadence to run it at — the same shape `trigger` uses, differing only in "once" versus "until told otherwise". It composes no command, supplies no script, and cannot make the executor do anything it was not already able to do.

IDEMPOTENT BY `scheduleId`: re-declaring the same id updates in place. The driver re-declares every tick, so a schedule an operator deleted out-of-band is restored rather than silently absent — which is what "until they hear otherwise" has to mean to be worth anything.

### §20. A discovery plugin emits `contains`, service to component

THE MEMBERSHIP EDGE A DISCOVERY PLUGIN EMITS IS `contains`, POINTING SERVICE -> COMPONENT.

Read this before writing `part_of` — it is the intuitive spelling, all three in-tree git plugins shipped it, and it has never once landed a row.

`docs/proposals/service-component-model.md` §2 considered `component --part_of--> service` and REJECTED it; the owner accepted `contains` (decision 1), and it landed as migration `0021`. `part_of` is registered by no migration, so `POST /discovery/accept` answered every proposal carrying one with `404 relationship type 'part_of' is not registered` — the whole discovery relationship channel, dead from the day it was written, behind a green suite (every end-to-end discovery test sent `relationships: []` at the accept step).

The direction is FORCED, not stylistic. Cardinality `one_to_many` constrains the *to* side to one live incoming edge, which is exactly "each component has at most one service"; migration 0022's partial unique index on `(org_id, to_id)` enforces the same thing at the database. Reverse the edge and both mean the opposite. And `contains` is what the engine actually walks — `graph/containment.ts` route 2 walks it BACKWARDS to reach a component's service, which is what puts a service on the containment chain that policy scope, RBAC scope expansion, domain inheritance and pipeline resolution are all derived from. An edge of any other name is a row no consumer reads: an import that returns 201 and leaves the component governed by nothing.

`service -> assembly -> component` is legal too (migration `0055`): `contains` accepts `{service, assembly} -> {assembly, component}`, so a plugin that learns to propose the middle rung needs no new edge type.

### §21. The routing Type (ADR-0007). Closed set

The routing Type (ADR-0007). Closed set: image|rpm|deb|npm|maven|python|go|chart|vm-image| infrastructure|configuration (the build family grew by 5 members — D13/D24, team-pipeline-IaC rework). Omitted ⇒ the server default ('configuration'). Kept as a self-contained string-union here so `@scp/plugin-api` stays free of a `@scp/schemas` dependency — MUST stay identical to `ExecutorTypeSchema` in `@scp/schemas/executors`, same discipline as `RolloutTargetClass` above, though (unlike that one) this copy has no cross-package pinning test today.

### §22. DependencyIndexPlugin: resolution behind the egress guard

DependencyIndexPlugin (M21.4, ADR-0032 §7) — "a daily self-rescheduling tick resolving versions through per-ecosystem INDEX PLUGINS, so the existing egress guard and host allowlist apply".

WHY THIS IS A PLUGIN AT ALL, rather than a `fetch()` in the server. The registry URL an operator points this at is CONFIGURABLE (a mirror, an Artifactory/Nexus proxy, an in-cluster Athens), and the plugin host is the ONE seam that applies `egress-guard.ts`'s post-DNS internal-IP deny-list and the per-instance `allowedHosts` allowlist to such a URL (plugin-host/contract.ts's `allowedHosts`/`allowInternalEgress` doc comments). A server-side fetch would reach the same registries with none of that, which is the SSRF exposure MAJOR #6 closed for every other network-calling plugin.

WHAT AN INDEX PLUGIN MUST NEVER DO (ADR-0032 §7, and the reason `listVersions` returns versions rather than a verdict): it does not decide which version is "newest", does not order strings, and does not skip or invent anything. It REPORTS what the index says, verbatim, or reports that it could not ask. Ranking happens in exactly one place server-side (`apps/server/src/dependencies/version-index.ts`), over `@scp/dependency-manifests`'s single `parseComparableVersion`/`compareVersions` pair — a rule enforced in five plugins is a rule with five places to regress.

### §23. Must stay identical to the schemas' dependency ecosystem

MUST stay identical to `DependencyEcosystemSchema` in `@scp/schemas/dependencies` and to `DependencyEcosystem` in `@scp/dependency-manifests`. Kept as a self-contained string union here for the same reason `DiscoveryProposal.sourceMappings[].type` is: `@scp/plugin-api` stays free of a `@scp/schemas` dependency. That is a THIRD copy of one vocabulary, and the first two drifted already (`image` vs `oci`) precisely because no test crossed the boundary — so this copy is pinned against the Zod enum at runtime by "the ecosystem vocabulary is the same list on all THREE sides" in `apps/server/src/dependencies/version-index.test.ts`, via the total `INDEX_MODULE_BY_ECOSYSTEM` record whose keys this type generates.

### §24. Why `unavailable` exists: unreachable is not empty

WHY AN EXPLICIT `unavailable` EXISTS AT ALL, and why it is not an empty list.

"The index said this coordinate has no versions" and "I could not reach an index" produce identical downstream behaviour — no bump — and mean opposite things. Collapsing them makes an air-gapped deployment (where four of the five ecosystems have no reachable index by design) look exactly like an estate that is fully up to date, which would silently stop every dependency subscription with nothing to read (ADR-0032 §7, charter principle 5). Every failure below is a distinct, operator-legible reason for that state.

### §25. Plugin manifest (DESIGN.md §11)

Plugin manifest (DESIGN.md §11) — every plugin is an npm package declaring this shape. Config schemas auto-surface as validated config forms in API/CLI/UI; distribution is compile-time only (bundled into the server image) — no runtime hot-loading, ever.

## `packages/plugin-api/src/scoped-http-response-too-large.test.ts`

### §26. The one runtime surface this interface package carries

`ScopedHttpResponseTooLargeError` (M21.2 review MAJOR 5) is the ONE runtime surface `@scp/plugin-api` carries — see `contract-shape.test.ts`'s doc for why the rest of this package is types-only. Every `ScopedHttpClient` implementation (the production fetch-backed one in `apps/server/src/plugin-host/subprocess-entry.ts`, and each package's own `node:http`-backed test client) constructs this error the SAME way, via this factory, so a consumer like `@scp/git-provider-core`'s `wrapProviderRequestError` recognizes it by property regardless of which transport produced it. These tests pin that contract at its one source.

## `packages/plugin-api/vitest.config.ts`

### §27. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §28. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

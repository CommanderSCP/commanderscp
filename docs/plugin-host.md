# plugin-host

Long-form reference for the **plugin-host** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 105 of 106 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/plugin-host/call-policy.test.ts`](#apps-server-src-plugin-host-call-policy-test-ts) — §1–§9
- [`apps/server/src/plugin-host/call-policy.ts`](#apps-server-src-plugin-host-call-policy-ts) — §10–§16
- [`apps/server/src/plugin-host/contract.ts`](#apps-server-src-plugin-host-contract-ts) — §17–§25
- [`apps/server/src/plugin-host/egress-guard.test.ts`](#apps-server-src-plugin-host-egress-guard-test-ts) — §26–§27
- [`apps/server/src/plugin-host/egress-guard.ts`](#apps-server-src-plugin-host-egress-guard-ts) — §28–§30
- [`apps/server/src/plugin-host/executor-tls-ca.test.ts`](#apps-server-src-plugin-host-executor-tls-ca-test-ts) — §31–§36
- [`apps/server/src/plugin-host/federation-mtls.test.ts`](#apps-server-src-plugin-host-federation-mtls-test-ts) — §37–§38
- [`apps/server/src/plugin-host/git-file-read-bounds.test.ts`](#apps-server-src-plugin-host-git-file-read-bounds-test-ts) — §39–§39
- [`apps/server/src/plugin-host/git-file-read.test.ts`](#apps-server-src-plugin-host-git-file-read-test-ts) — §40–§41
- [`apps/server/src/plugin-host/host-bootstrap.integration.test.ts`](#apps-server-src-plugin-host-host-bootstrap-integration-test-ts) — §42–§42
- [`apps/server/src/plugin-host/host-bootstrap.ts`](#apps-server-src-plugin-host-host-bootstrap-ts) — §43–§44
- [`apps/server/src/plugin-host/host.test.ts`](#apps-server-src-plugin-host-host-test-ts) — §45–§49
- [`apps/server/src/plugin-host/host.ts`](#apps-server-src-plugin-host-host-ts) — §50–§65
- [`apps/server/src/plugin-host/managed-timeout-boot-gate.test.ts`](#apps-server-src-plugin-host-managed-timeout-boot-gate-test-ts) — §66–§66
- [`apps/server/src/plugin-host/managed-trigger-budget.test.ts`](#apps-server-src-plugin-host-managed-trigger-budget-test-ts) — §67–§70
- [`apps/server/src/plugin-host/managed-trigger-whole-run-budget.test.ts`](#apps-server-src-plugin-host-managed-trigger-whole-run-budget-test-ts) — §71–§75
- [`apps/server/src/plugin-host/plugin-manifests-argo-workflows.test.ts`](#apps-server-src-plugin-host-plugin-manifests-argo-workflows-test-ts) — §76–§77
- [`apps/server/src/plugin-host/plugin-manifests-dependency-index.test.ts`](#apps-server-src-plugin-host-plugin-manifests-dependency-index-test-ts) — §78–§78
- [`apps/server/src/plugin-host/plugin-manifests-fail-closed.test.ts`](#apps-server-src-plugin-host-plugin-manifests-fail-closed-test-ts) — §79–§81
- [`apps/server/src/plugin-host/plugin-manifests-managed-dep.test.ts`](#apps-server-src-plugin-host-plugin-manifests-managed-dep-test-ts) — §82–§82
- [`apps/server/src/plugin-host/plugin-manifests-runner-launcher.test.ts`](#apps-server-src-plugin-host-plugin-manifests-runner-launcher-test-ts) — §83–§83
- [`apps/server/src/plugin-host/plugin-manifests.ts`](#apps-server-src-plugin-host-plugin-manifests-ts) — §84–§91
- [`apps/server/src/plugin-host/rpc-protocol.ts`](#apps-server-src-plugin-host-rpc-protocol-ts) — §92–§93
- [`apps/server/src/plugin-host/subprocess-entry.ts`](#apps-server-src-plugin-host-subprocess-entry-ts) — §94–§104
- [`apps/server/src/plugin-host/test-support/runaway-stdout-entry.ts`](#apps-server-src-plugin-host-test-support-runaway-stdout-entry-ts) — §105–§105

## `apps/server/src/plugin-host/call-policy.test.ts`

### §1. The per-method RPC budget and the ceiling it derives from

M23.1c — the per-method RPC budget, and the manifest ceiling it is derived from.

The end-to-end proof that the budget reaches a real managed run lives in `managed-trigger-budget.test.ts` (a real `managed-iac` through a DEFAULT-constructed host). This file covers the parts that test cannot reach in reasonable wall-clock time: the arithmetic, the clamp on rows stored before the ceiling existed, and the boot assertion whose absence is what would let a deleted `maximum` degrade SILENTLY back to the 10s SIGKILL.

### §2. A loop over the enumerated list, not three assertions

A LOOP OVER THE ENUMERATED LIST, not three assertions about `managed-iac`. The defect record named one plugin; the property was in all three, each declaring its own copy of `{ type: "integer", minimum: 1000 }` with no ceiling. A census that fixes the instance instead of the class is this repository's recurring bug source (CLAUDE.md, "census by property"), and a fourth managed class fails here until it carries the same bounds.

### §3. THE CLAMP IS FOR ROWS THAT ALREADY EXIST

THE CLAMP IS FOR ROWS THAT ALREADY EXIST. `maximum` refuses a bad value at the write door, and a write door only ever sees new writes: a binding stored while the schema was `{ minimum: 1000 }` with no ceiling — including the 2^31 that motivated the cap — is still in the database and is never re-validated on read. Without this the ceiling would be true only of deployments that had never been configured.

### §4. The boot gate, and why the schema test does not cover it

THE BOOT GATE, and why it is not redundant with the schema test above.

If a `maximum` is ever deleted, nothing FAILS — `resolveCallPolicy` stops recognising that module as managed and quietly hands its `trigger` the 10s hang detector back. That is the M23.1c defect, restored on exactly one plugin, with a green suite. So the degradation has to be made loud at the one moment it can be: module load, beside the allowlist, in `coordination/executor-bindings-repo.ts`. These two tests assert BOTH halves — that the gate fires, and that the thing it is guarding against really is silent.

### §5. Cross-package numbers that used to be drifting comments

M23.1e — THE CROSS-PACKAGE RELATIONSHIPS THAT USED TO BE COMMENTS THAT DRIFTED
Two numbers in `@scp/runner-launcher` and one here have to stand in a fixed order, and every previous phase expressed that order in prose. `RUNNER_REAP_GRACE_MS`'s own doc said it plainly: "nothing enforces the relationship automatically, precisely because nothing CAN import across that boundary." That is true from the LAUNCHER's side and false from this one — `apps/server` depends on `@scp/runner-launcher`, never the reverse — so the gate belongs here.

IT IS NOT PEDANTRY. Every one of M23.1e's HIGH defects was a number sized against a quantity that had since changed, with a well-written comment still asserting the old arithmetic. A comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md).

### §6. A grace merely equal to the remove timeout is not enough

The Docker adapter's `finally { docker rm -f }` is capped at RUNNER_REMOVE_TIMEOUT_MS. A grace merely EQUAL to it (which is what 30_000 was) is spent entirely by one worst-case teardown, leaving zero for the `withRecordedOutcome` write and `saveState` that the grace exists to make room for — so the host SIGKILLs the subprocess at precisely the moment the ledger entry would have landed.

THIS ARM IS ABOUT ONE TEARDOWN AND THAT IS NOW ITS LIMIT, said plainly because it read as the whole gate and was not: it is true of an adapter whose teardown is one call, and M23.5 found the Kubernetes teardown had become three with this still green. The per-kind arms below are the gate; this one is kept because the Docker default is what most deployments run.

### §7. The container's deadline against when the host gives up

A container's `scp.launcher.deadline` is `runDeadline + RUNNER_REAP_GRACE_MS`; the host gives up on the subprocess at `runDeadline + MANAGED_TRIGGER_GRACE_MS`. If the stamp expired FIRST, there would be a window in which a peer launcher sees a container as `foreign AND past deadline` — the exact predicate `reap()` destroys on — while the process that owns it is still alive and still running `tofu apply`. That is HIGH-2 arriving through the other door.

### §8. The ordering holds for every adapter, not just one

M23.5 HIGH-2 — THE ORDERING HOLDS FOR EVERY ADAPTER, NOT FOR THE ONE THAT EXISTED WHEN IT WAS WRITTEN

`MANAGED_TRIGGER_GRACE_MS` was 60s, chosen in prose as "two worst-case teardowns" of `RUNNER_REMOVE_TIMEOUT_MS`, and gated by `grace > RUNNER_REMOVE_TIMEOUT_MS` — ONE teardown. The Kubernetes `finally` is three bounded calls, so sixty seconds of bounded work consumed the whole grace and left nothing for the outcome write it exists to protect. The number was gated; the MODEL was not, and nothing knew the teardown had grown.

THE GATE IS NOW `it.each` OVER THE KINDS, so an adapter cannot be added without its ordering being checked, and `teardown-model.test.ts` in the launcher counts what each adapter's `finally` ACTUALLY issues against the declared count these numbers are derived from. Between them: adding a fourth teardown step reddens the census by name, and correcting the count moves every number here.

### §9. MEDIUM (verification pass 5)

MEDIUM (verification pass 5) — THE CEILING IS ONE NUMBER AND BOTH SIDES OF THE RPC APPLY IT

`resolveCallPolicy` clamped the HOST's budget and nothing else. The plugin on the other side of the same RPC read the same stored row and handed `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` to `RunnerSpec.timeoutMs` untouched, so above the ceiling the two numbers were not two views of one budget — they were hours apart, in the direction that defeats `reap()`.

THIS FILE IS WHERE THAT RELATIONSHIP CAN BE CHECKED AT ALL. `@scp/runner-launcher` may not import from the server (the dependency only goes one way), which is the same reason the grace-ordering arms below live here rather than beside the constants they relate.

## `apps/server/src/plugin-host/call-policy.ts`

### §10. PER-METHOD RPC POLICY FOR THE SUBPROCESS PLUGIN HOST

PER-METHOD RPC POLICY FOR THE SUBPROCESS PLUGIN HOST (M23.1c).

THE DEFECT THIS EXISTS TO CLOSE, stated as the measurement rather than as a worry.
`host.ts`'s `DEFAULTS.callTimeoutMs` is 10 SECONDS and applied to EVERY method uniformly, and the only non-test construction of a `SubprocessPluginHost` in the product — `host-bootstrap.ts`'s `new SubprocessPluginHost()` — passes no options at all. Production therefore ran the 10s default. Meanwhile all three managed executors run their container SYNCHRONOUSLY inside `trigger()`, with their own budget of 10 minutes (managed-iac, managed-scan) or 5 (managed-dep).

On expiry `sendOnce` does not merely reject: it `instance.child?.kill("SIGKILL")`. There is no `finally`, no `catch`, no outcome write, no `saveState`. So every managed run longer than ten seconds — which is every real one — ended like this:

```text
- the runner container ORPHANS `state=running`, with the resolved credentials still in its
  `Config.Env` where `docker inspect` can read them;
- managed-iac's idempotency ledger entry is NEVER WRITTEN (`saveState` sits after the run), so
  `reconcile.ts`'s attempt/backoff retry issues a SECOND `tofu apply` against live
  infrastructure while the first container is still applying — against a plugin whose own header
  calls this "the strongest idempotency guarantee of any M7 executor";
- `status()` reports `pending` forever for a run that is over, on all three plugins.
```

Nothing caught it because the real plugins are tested WITHOUT the host and every test that builds a host passes an explicit `callTimeoutMs` and drives a fast fake executor. Component correct, wiring untested, suite green — CLAUDE.md's dominant failure class.

THE POLICY (owner decision, M23.1c (a)): PER-METHOD, NOT A BIGGER GLOBAL NUMBER.
Raising `callTimeoutMs` globally is the obvious fix and it is the wrong one: the 10s budget is a HANG DETECTOR, and it is meaningful for exactly the methods that are supposed to be fast — `observe`, `status`, `abort`, `evaluate`, `discover`, `send`, `listVersions`. Making it ten minutes so that one method can be slow would blind the host to a wedged `status()` on every plugin in the product.

So the budget is a function of (module, method): - `trigger` on a MANAGED executor -> that instance's own resolved `timeoutMs` + `MANAGED_TRIGGER_GRACE_MS`. What guarantees the plugin's own bound fires first is NOT this grace (M23.1e — see that constant's doc for the measurement that disproved it) but the launcher: `RunnerSpec.timeoutMs` is the WHOLE-RUN budget, read once as a deadline and spent down across every step, so a run cannot exceed it however many `execFile`s it takes. The grace covers exactly what happens after that deadline — one `docker rm -f` teardown, the recorded-outcome write (M23.1 phase 2's `withRecordedOutcome`) and `saveState`. - everything else -> the host's unchanged 10s hang detector.

AND NO TRANSPARENT RETRY FOR A MANAGED `trigger`. `host.call()` retries once per crash while budget remains, which is right for an idempotent read and actively dangerous here: this change widens the crash window from ≤10s to ≤11min, and the retry would re-enter a `trigger()` whose ledger entry is (by construction) not yet written — a SECOND `tofu apply` against live infrastructure while the first is still applying. Its container name is derived from the same `idempotencyKey`, so its `docker create` also collides with the still-running first container; since M23.1e the loser at least no longer `rm -f`s the winner (the adapter skips teardown on a name conflict — `@scp/runner-launcher`'s `isContainerNameConflict`), but a retry that cannot proceed is not a retry worth having. A crash mid-apply must surface to `reconcile.ts`, not be papered over one layer below it.

WHY THE NUMBERS COME FROM THE MANIFEST AND NOWHERE ELSE.
The floor/ceiling/default this reads are the SAME JSON Schema object `validatePluginConfig` gates tenant writes on (`MANIFEST_BY_MODULE`). Re-declaring them here would create a second copy that drifts silently: a manifest could accept a value the host refuses to wait for, which is precisely the "two lists of the same vocabulary" shape this repo has been bitten by. There is one number and both readers read it.

The CLAMP is not belt-and-braces either. `maximum` was added to those schemas in this same change, so a binding row stored BEFORE it — including the 2^31 the old `{ minimum: 1000 }` admitted — is still in the database and is never re-validated on read. Clamping on the way into the budget is what makes the ceiling true of THIS number.

WHAT THIS CLAMP DOES NOT COVER, BECAUSE THE SENTENCE ABOVE USED TO CLAIM IT DID.
It said clamping here "is what makes the ceiling true of the running system". It made the ceiling true of ONE number in the running system — `budgetMs`, the host's own RPC deadline — and of nothing else. `resolveCallPolicy` clamps its return value; it does not write anything back, and the plugin on the other side of the RPC read the SAME stored row and passed `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` straight into `RunnerSpec.timeoutMs`. For a stored 4h the host budgeted 3_660_000ms and the launcher ran to 14_400_000ms, so the host's SIGKILL orphaned a container stamped 181 minutes past the moment `reap()` could collect it.

`@scp/runner-launcher`'s `clampRunTimeoutMs` is the other half, applied inside `run()` where all three plugins and both adapters converge. The two clamps must read the SAME ceiling or they reintroduce the ordering defect this file exists to close, so `assertManagedTimeoutSchemas` refuses at boot unless every managed manifest's `maximum` IS `MANAGED_RUN_TIMEOUT_MAX_MS`.

### §11. The managed-execution classes

The managed-execution classes — the charter's single scoped exception to "coordination, not execution" (principle 1), and therefore the only plugins whose `trigger()` legitimately blocks for minutes. Membership is defined by "does this module's manifest declare a bounded `timeoutMs`", checked at boot by `assertManagedTimeoutSchemas`, so a fourth managed class cannot be added without either joining this list or failing the boot.

### §12. How much longer the host waits than the plugin's budget

How much longer the HOST waits than the plugin's own WHOLE-RUN budget.

ORDERING IS THE WHOLE POINT, not headroom for slowness. The plugin's own bound must be the one that fires, because it is the only one attached to code that cleans up: it stops the `docker start -a`, the adapter's `finally` issues `rm -f <name>`, `withRecordedOutcome` records a failure, and managed-iac's `saveState` writes the ledger entry that stops the retry from double-applying. The host's expiry is a `SIGKILL` of the subprocess and runs NONE of that.

WHAT THIS COMMENT USED TO CLAIM, WHY IT WAS FALSE, AND WHAT IS TRUE NOW (M23.1e).
It said the grace was "sized so the plugin's inner `execFile` timeout fires first". That was true of ONE `execFile`. A managed run issues four (managed-iac, managed-dep) to six (managed-scan) SEQUENTIAL ones, and `@scp/runner-launcher` handed each of them `{ timeout: spec.timeoutMs }` INDEPENDENTLY — so what the grace was sized against was a per-call bound while what it had to cover was their SUM, which nothing bounded at all. Measured through a default-constructed `SubprocessPluginHost` driving the real managed-iac plugin with `timeoutMs: 20_000` and steps of 18s/9s/18s/9s — every one of them comfortably under the inner 20s bound — the run reached 50003ms against a 50000ms budget and was SIGKILLed: an orphaned container still applying, and no ledger entry, so `reconcile.ts` issued a second `tofu apply` on top of the first. Reachable at the shipped 10-minute defaults, because `docker create` PULLS THE IMAGE when it is absent — a cold pull plus an ordinary apply clears 630s with no single call reaching 600s. The proof that nothing here was load-bearing: shrinking this constant from 30_000 to 3_000 reddened NOTHING.

SO THE ORDERING IS NOW A PROPERTY OF THE LAUNCHER, NOT OF THIS NUMBER. `RunnerSpec.timeoutMs` is the WHOLE-RUN budget: the adapter reads one deadline at the top of `run()` and issues every step with what is LEFT of it, so a run cannot exceed `timeoutMs` however many steps it takes. This constant no longer has to guess at a sum. It has to cover exactly the work that happens AFTER that deadline.

AND THAT WORK IS NOT ONE CALL — M23.5 HIGH-2, THE SAME DEFECT ONE LEVEL UP.
This block used to name exactly one term — `RUNNER_REMOVE_TIMEOUT_MS`, "the adapter's `finally { docker rm -f }`" — and chose 60s as TWO worst-case teardowns. True of the Docker adapter. The Kubernetes adapter's `finally` is THREE bounded calls: DELETE the Job, DELETE the Secret, remove the workspace subtree. Sixty seconds of bounded work therefore consumed the entire grace and left nothing for the outcome write the grace exists to protect — verbatim what the paragraph below calls "WRONG BY CONSTRUCTION" about the 30s this replaced, arriving on the adapter nobody re-derived the number for.

THE NUMBER WAS GATED AND THE MODEL WAS NOT. `call-policy.test.ts` asserted `MANAGED_TRIGGER_GRACE_MS > RUNNER_REMOVE_TIMEOUT_MS` — ONE teardown — so the teardown could grow to three with every test still green and nothing anywhere knowing it had.

SO THE GRACE IS DERIVED FROM THE ADAPTER IN USE, and the model it derives from lives in the launcher, where the calls do: `RUNNER_POST_DEADLINE_CALLS` NAMES every bounded call each adapter may issue after the run deadline, `teardown-model.test.ts` COUNTS every effect each one actually issues at or after that deadline, and `runnerPostDeadlineMs` turns the count into milliseconds. A new post-deadline call does not compile until it is named there, and naming it moves this grace, the reap stamp and the stated `run()` bound together. The terms:

```text
  runnerPostDeadlineMs(kind)   one possible abandonment of the step that was in flight when
                               the deadline passed, plus every call that may follow it —
                               63s on Docker, 94s on Kubernetes
+ MANAGED_OUTCOME_TAIL_MS      what the grace EXISTS for: `withRecordedOutcome`'s write,
                               managed-iac's `saveState` fsync, and the RPC response crossing
                               the pipe                                                   30s
```

30s was WRONG BY CONSTRUCTION rather than merely tight: one worst-case teardown consumed the entire grace. The RELATIONSHIP, not the number, is what `call-policy.test.ts` gates — and it now gates it for EVERY adapter kind rather than for the one that happened to exist when it was written. The launcher package cannot check it from its side; the dependency only goes one way, which is exactly why the old "re-derived here rather than shared, and padded well past it" drifted.

### §13. The DOCKER grace

The DOCKER grace — the default, because an unset `runnerLauncher` is Docker everywhere else in this product (`resolveRunnerLauncher`: "an unset value is Docker — byte-identical behaviour for every deployment that does not opt in"). It stays a constant because it is what every non-Kubernetes deployment gets; a deployment that selected the Kubernetes launcher gets `managedTriggerGraceMs``("kubernetes")` instead, off the same server-injected config field the launcher resolver itself switches on.

### §14. WHICH ADAPTER THIS INSTANCE'S `trigger()` WILL ACTUALLY USE

WHICH ADAPTER THIS INSTANCE'S `trigger()` WILL ACTUALLY USE.

`runnerLauncher` is server-injected into every managed executor's config by `executor-bindings-repo.ts`'s `managedRunnerSettings()` — the same field, in the same object, that `resolveRunnerLauncher` switches on inside the plugin subprocess. Reading it HERE is what makes "derived from what teardown costs on the adapter in use" true rather than aspirational: the host and the launcher answer the question from one value, which is the same argument `assertManagedTimeoutSchemas` makes about the ceiling.

ANYTHING ELSE IS DOCKER, and the fail-safe direction is the one that matters. An unrecognised value makes the launcher resolver fall through to Docker too (`config.runnerLauncher !== "kubernetes"`), so the two agree by construction; and Docker is the SHORTER grace, so a disagreement in this direction could only make the host give up early — never wait past a reap stamp that has already expired, which is the direction that puts a peer's sweep on a live run.

### §15. Fails loud at load if a managed manifest omits it

Fails LOUD at module load if any managed executor's manifest does not publish a `timeoutMs` that is bounded at BOTH ends with an in-range default.

This is the install-site gate, and it is here rather than in a test for the reason `assertEveryModuleHasManifest` is: an unbounded ceiling is a defect the moment it is committed, not the moment some write door happens to be exercised. Without it, deleting `maximum` from one manifest degrades silently — `timeoutSchemaFor` returns `undefined`, that plugin's `trigger` quietly falls back to the 10s hang detector, and the M23.1c defect is back on exactly one of the three plugins with a green suite. A boot that would do that does not boot.

### §16. AND THE CEILING MUST BE THE ONE THE LAUNCHER ENFORCES

AND THE CEILING MUST BE THE ONE THE LAUNCHER ENFORCES — see the module doc's last section. There are now TWO clamps on one number and they must not be allowed to drift: a manifest ceiling ABOVE the launcher's makes the host wait for a run the launcher already killed, and one BELOW it puts the M23.1c SIGKILL back on a run that is still legitimately inside its own budget. Equality, not "<=", because both directions are defects.

## `apps/server/src/plugin-host/contract.ts`

### §17. ControlPlugin's client shape

ControlPlugin's client shape (DESIGN.md §11 `ControlPlugin`), M4's counterpart to `ExecutorPluginClient` above — same subprocess host, same timeout/restart-with-backoff guarantees, one method.

### §18. M8 counterpart for `FederationTransportPlugin`

M8 counterpart for `FederationTransportPlugin` (`federation-https` — DESIGN §13). Subprocess hosting so this transport runs under the same host-enforced timeout/restart-with-backoff/ egress-guard machinery as every other network-calling plugin, and so its mTLS client certificate (subprocess-entry.ts's `loadFederationMtlsMaterial`) is presented on a connection this process's own `ScopedHttpClient` controls, never a raw fetch bypassing the plugin host.

### §19. M21.4 counterpart for a `DependencyIndexPlugin` instance

M21.4 counterpart for a `DependencyIndexPlugin` instance (ADR-0032 §7) — the per-ecosystem third-party version index the daily poll asks. Subprocess-hosted for the reason that makes it a plugin at all: the registry URL is operator-CONFIGURABLE (a mirror, an in-cluster Athens/Nexus), and this host is the one seam that applies `egress-guard.ts` and the per-instance `allowedHosts` allowlist to such a URL.

### §20. Reading one file out of a user repo at a ref

M21.4 (ADR-0032 §7a) — READING ONE FILE OUT OF A USER REPO AT A REF, from the server.

THIS IS THE MISSING HALF OF M21.2, AND WITHOUT IT THAT MILESTONE WAS DEAD CODE
M21.2 built `readFileAtRef` on `GitProviderAdapter` and three adapters implement it — but nothing under `apps/server` could reach it, because NO client shape in this file carried a file-read method and the subprocess dispatched no such RPC. ADR-0032 §7a's language strategies (npm, python, maven) read the producing component's own manifest at the released commit, so with no route they every one recorded nothing under `manifest_reader_unavailable`: the entire "formulated from the users' code" ingress did not exist. This is that route.

IT IS A SEPARATE CLIENT BECAUSE IT IS A SEPARATE CAPABILITY (ADR-0032 §9)
It is deliberately NOT a fifth method on `ExecutorPluginClient`. The four-verb executor set IS the structural enforcement of charter principle 1 ("coordination, not execution"), and `createExecutorPluginFromAdapter` still refuses to surface this hook — a permanent test in `@scp/git-provider-core` pins that. So the hook is dispatched from the loaded ADAPTER that sits beside the executor plugin in the subprocess (`subprocess-entry.ts`'s `ReadFileHook`), and a caller asks for it through its own accessor. The same instance id addresses both: one git binding is one subprocess, and this read runs under exactly the timeouts, restart-with-backoff, egress allowlist and SSRF guard every other call on that instance does.

READ ONLY. There is no write counterpart and ADR-0032 §9 says there will not be one through this seam: the bump actuator (§8) is a managed executor class contingent on a charter amendment, not a verb added here.

An instance whose module carries no adapter hook (every non-git-provider executor) REJECTS the call with a message naming that fact — it never answers `not_found`, which would be a claim about the repo rather than about the binding.

### §21. Every in-repo plugin module a subprocess can load

Every in-repo plugin module a subprocess can load (subprocess-entry.ts's `loadPlugin` switch is the single source of truth this union must stay in sync with). M7 widens this from M3/M4's closed `"fake-executor" | "webhook-control"` pair: `github`/`argocd`/`terraform`/`managed-iac` are `ExecutorPlugin`s, `github-discovery` is github's separate `DiscoveryPlugin` export (a distinct module name because ONE subprocess-hosted instance loads exactly one plugin `kind` — an org that wants both github's executor AND its discovery scan configures two instances, same package, two module names), `webhook-notify`/`smtp-notify` are `NotificationPlugin`s. M8 adds `federation-https`, a `FederationTransportPlugin`. M15.1b adds `gitea`, a second git-provider `ExecutorPlugin` built (like `github`) on `@scp/git-provider-core`; M15.3a adds `gitea-discovery`, gitea's separate `DiscoveryPlugin` export (same package, distinct module — like github/github-discovery). M15.3b adds `gitlab`, a third git-provider `ExecutorPlugin` (same core) plus `gitlab-discovery`, its separate `DiscoveryPlugin` export (same executor/discovery split). M17.1 adds `scan-result-control`, a second `ControlPlugin` (sibling of `webhook-control`) that turns a coordinated Trivy scan verdict into gate evidence (ADR-0013). M13.3a adds `managed-scan`, a second managed-execution `ExecutorPlugin` (sibling of `managed-iac`, same charter-enumerated pattern): the thin orchestrator behind the commander's promotion scan step, launching ephemeral `scp-runner-scan` containers (ADR-0020 §1). Like `managed-iac` it is a `KNOWN_EXECUTOR_MODULE` and gets server-injected runner settings (executor-bindings-repo.ts). M10.4 adds `github-check`, a third `ControlPlugin` (sibling of `webhook-control`/ `scan-result-control`): turns a GitHub Check Run/status verdict for the change's own commit into gate evidence (BUILD_AND_TEST.md §8 M10.4). M10.6 adds `pipeline-generic`, the generic URL-templated `ExecutorPlugin` extracted from `terraform`'s Mode-1 shape (`terraform` becomes a preset of it — same `KNOWN_EXECUTOR_MODULE` allowlist, own module name so an operator can bind the generic executor directly for a pipeline with no dedicated plugin).

### §22. Already-decrypted secret values for this instance

Resolved (plaintext, already-decrypted) secret values for this instance — M7's `executor_bindings`/`notification_bindings` `secretRefs` resolved via `secrets/secrets-repo.ts`'s `resolveSecretRefs` BEFORE this config ever reaches `host.start()`. Never logged; injected into the subprocess only via env (subprocess-entry.ts's `SCP_PLUGIN_SECRETS_JSON`), read into an in-memory `SecretsAccessor`, never written to disk.

### §23. The egress allowlist for this instance's HTTP client

Egress allowlist (SSRF mitigation) for this instance's `PluginContext.http` — hostnames (not URLs) a `ScopedHttpClient.request()` call may target. Empty/omitted preserves M3/M4's unscoped behavior (needed by `webhook-control`, whose entire point is POSTing to an operator-configured arbitrary URL) — every M7 network-calling plugin (github/argocd/ webhook-notify) sets this explicitly from its own binding config instead.

### §24. Relax the SSRF egress guard's internal-IP block

Relax the SSRF egress guard's internal-IP block (loopback/private ranges) for THIS instance's `ctx.http` — so a self-hosted SCP can coordinate an execution system reachable only at a private address (an in-cluster Argo CD ClusterIP, an on-prem executor by RFC1918 IP; charter principle 5 "self-hosting & air-gap first-class"). `linkLocal`/`unspecified` (cloud metadata) stay blocked for every plugin regardless.

NEVER set this from anything a tenant can write. It is computed ONLY by `executor-bindings-repo.ts`'s `resolveInternalEgress`, which requires BOTH layers to agree (ADR-0003): (1) the operator's host-level `SCP_INTERNAL_EGRESS_HOSTS` allowlist — the hard boundary, same trust tier as `SCP_MANAGED_IAC_RUNNER_IMAGE`/`SCP_FEDERATION_MTLS_*`, unset by default ⇒ nothing is ever reachable; and (2) the execution-system's `allowInternalEgress` property — a per-system DECLARATION of intent, not a grant. Deliberately layered so that graph state or an RBAC misconfiguration can never, on its own, produce an SSRF: a tenant who declares the property on a system pointing at an un-allowlisted host gets nothing (egress-guard.ts, MAJOR #6). Threaded to the subprocess via its own env var (host.ts) so tenant `config`/`secrets` can neither reach nor override it. Omitted/false is the fail-closed default.

### §25. Stop and forget just these, leaving the others running

Stop and forget JUST these instances, leaving every other one running (M21.4).

WHY A PARTIAL STOP EXISTS AT ALL. Every pre-M21.4 caller starts a bounded, long-lived set: the reconcile/observe/watchdog loops start an instance per executor BINDING, which is operator configuration that persists, so leaving them up between ticks is the correct behaviour and a partial stop would just re-spawn a child per tick. The dependency version poll is the first caller whose instances are DERIVED FROM ITS OWN WORK-LIST rather than from configuration: it starts a per-(ecosystem, org) index subprocess on demand, and on a multi-tenant commander that accumulated up to five idle children PER ORG for the lifetime of the worker — for a job that runs once a DAY. Nothing was leaked per tick (`start()` skips an id it already holds), so the symptom is a standing process count that grows with tenancy and never falls, which is exactly the kind of cost nobody attributes to a daily poll.

Unknown ids are ignored rather than refused: a sweep that failed before starting an instance must still be able to hand its whole intended set to this in a `finally`.

## `apps/server/src/plugin-host/egress-guard.test.ts`

### §26. Unit tests for the SSRF egress guard

Unit tests for the SSRF egress guard (MAJOR #6). All cases use IP LITERALS so `assertEgressAllowed` short-circuits DNS resolution (`isIP` !== 0) and never touches the network — the guard's blocking logic is fully exercised without a real DNS lookup or HTTP server.

### §27. DNS-rebinding pinning (`createEgressPinRegistry`)

DNS-rebinding pinning (`createEgressPinRegistry`). These run REAL undici requests through the exact Agent shape `subprocess-entry.ts`'s `scopedFetchHttpClient` builds — `connect.lookup` set to the registry — because the defect being closed lives entirely in what the SOCKET does, not in what the guard returns. The only server involved is a loopback one this file starts; the hostnames used are `.invalid`, which by RFC 6761 no real resolver can answer, so a request that ARRIVES proves the pin (and nothing else) chose the address.

## `apps/server/src/plugin-host/egress-guard.ts`

### §28. SSRF egress guard for plugin `ctx.http`

SSRF egress guard for plugin `ctx.http` (adversarial-review MAJOR #6). The `allowedHosts` allowlist alone doesn't stop (a) a plugin being steered at the cloud metadata endpoint / loopback / an internal service, or (b) an allowlisted HOSTNAME that DNS-resolves (or rebinds) to an internal IP. This adds an internal-range deny-list enforced AFTER DNS resolution, plus the caller disables HTTP redirect-following (a redirect can't be re-pointed at an internal host).

The rule (see `assertEgressAllowed`): - link-local incl. cloud metadata 169.254.169.254 (169.254/16, fe80::/10) and the unspecified address (0.0.0.0, ::) are ALWAYS blocked — for EVERY plugin, no exceptions: no plugin ever legitimately reaches the metadata endpoint. - loopback (127/8, ::1) and private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are blocked UNLESS `allowInternalPrivate` is true. That flag is derived by the CALLER from the plugin's MODULE IDENTITY (subprocess-entry.ts's `OPERATOR_PLANE_MODULES`), NEVER from tenant config: only the genuine operator-plane escape hatches — `webhook-control` (its control-server URL is operator-configured behind `policy:write`) and `federation-https` (on-prem/single-host peers) — may reach internal hosts. EVERY tenant-configurable plugin (webhook-notify, github, argocd, terraform, managed-iac) has `allowInternalPrivate === false`, so a tenant that creates a binding with `config.url = http://127.0.0.1/...` or `http://10.x/internal` is BLOCKED — closing the SSRF hole an earlier "unscoped ⇒ allowed" heuristic (based on `allowedHosts` emptiness, which tenant bindings default to) had reopened. The `allowedHosts` allowlist is a SEPARATE, additional gate (a scoped plugin's hostname must be on it); it does NOT decide the internal-range allowance.

Classifying an address is worth nothing unless it is the address actually dialled, so `assertEgressAllowed` RETURNS what it verified and `createEgressPinRegistry` (below) makes that set the only answer the connect-time resolver will give — see its doc for the rebinding window that was open while the HTTP client resolved the name a second time on its own.

### §29. Throws if the URL is not a permitted egress target

Throws (an `EgressGuardError`) if `url` is not a permitted egress target; returns the addresses it verified. Enforced AFTER DNS resolution — see module doc. `allowInternalPrivate` MUST be derived from the plugin's module identity by the caller (never from tenant config), and is true ONLY for the operator-plane escape hatches.

Returning the verified addresses is not a convenience: a caller that then lets the HTTP client re-resolve the name has verified nothing (DNS rebinding, see `createEgressPinRegistry`).

### §30. Closes the gap between classifying a name and dialling it

Closes the TOCTOU between "the guard classified this name's addresses" and "the socket connected somewhere". `assertEgressAllowed` used to be followed by a `fetch(url)` that performed its OWN, INDEPENDENT `getaddrinfo` at connect time, so a hostname whose DNS an attacker controls could answer the guard with a public address and the connect-time query, milliseconds later, with `127.0.0.1` / `10.x` / `169.254.169.254` — a textbook DNS rebind that defeated every check above for every tenant-configurable plugin.

The registry's `lookup` is installed as the undici Agent's `connect.lookup`, which is the ONLY resolver the socket ever consults. It answers exclusively from the pin the guard just wrote, so the address connected to is provably the address classified; an unpinned hostname is refused outright rather than falling back to DNS. The name itself still travels to the transport (TLS SNI and certificate verification are unaffected — only the address selection is pinned).

Pins are REFERENCE-COUNTED, not last-write-wins: two concurrent requests to one hostname each hold the pin until their own body is read, so the first to finish cannot pull the address out from under the second's in-flight connect.

## `apps/server/src/plugin-host/executor-tls-ca.test.ts`

### §31. `SCP_EXECUTOR_TLS_CA_FILE` — SECURITY-SENSITIVE

`SCP_EXECUTOR_TLS_CA_FILE` — SECURITY-SENSITIVE: proves an executor plugin can verify a PRIVATELY-SIGNED endpoint when (and only when) the operator supplies the CA, over a REAL TLS handshake.

WHAT THIS CLOSES
The bundled Argo Workflows server listens on 2746 and serves HTTPS with a SELF-SIGNED certificate (its vendored Deployment's readiness probe uses `scheme: HTTPS`). Plugin traffic had no CA-trust path at all — the subprocess only ever built a custom dispatcher for `federation-https`'s client certificate — so every request to it failed verification and the coordinated-test path was unreachable on the bundled tier even with the NetworkPolicy open (#321 opened the network; this opens the trust).

WHY IT IS TESTED THIS WAY
Not a unit test of Agent construction. Asserting "we passed a `ca` option" would pass just as happily if undici ignored it, if the PEM never loaded, or if verification had been switched off entirely — and the last of those is the failure this feature must never have. So this spawns a REAL executor subprocess through `SubprocessPluginHost` and drives it against a REAL `node:https` server presenting a privately-signed certificate. The verdict is the handshake itself.

The negative case (case 1) is the load-bearing one and runs FIRST: without the CA the request must FAIL. If it passed, every other assertion here would be meaningless — a build that trusts everything also "succeeds" at trusting this server.

`argo-workflows` is the module under test rather than a synthetic one because it is the executor that forced the feature, and because it is a TENANT-plane module: it is NOT in `OPERATOR_PLANE_MODULES`, so it reaches a loopback address only via the operator's `allowedHosts` allowlist — exercising the egress guard and the TLS trust together, in the arrangement a real deployment uses.

### §32. Both layers, as a real in-cluster executor needs

BOTH ADR-0003 layers, which is what a real in-cluster executor needs: the operator's per-instance allowlist AND the execution system's own `allowInternalEgress` declaration. 127.0.0.1 is a private address, so the allowlist alone is not enough — the internal-IP deny-list refuses it independently. Setting only one was how the first run of this file failed, with an egress error the TLS assertions would have happily read as "the handshake refused it" had they not matched on the certificate text.

### §33. Why the assertion is shaped this way, despite looking weak

WHY THE ASSERTION IS SHAPED LIKE THIS, since it is the weakest-looking part of the file. Node's `fetch` reports a TLS verification failure as the bare string "fetch failed" and hangs the real reason off `err.cause`, which the plugin-host RPC boundary does not serialize — so there is no certificate text to match on here.

The proof is therefore DIFFERENTIAL, not textual: case 2 runs the SAME server, SAME plugin, SAME allowlist and SAME ref, differing ONLY in `SCP_EXECUTOR_TLS_CA_FILE`, and SUCCEEDS. One variable, opposite outcomes.

Matching the message still does real work — it excludes the two ways this file has ALREADY been green for the wrong reason. First draft: a malformed ref threw before any socket opened. Second: the egress guard refused 127.0.0.1 ("not in the configured allowedHosts allowlist") because the allowlist carried a port and `allowInternalEgress` was unset. Both produced a failing call with `requestCount === 0` — exactly what a naive `expect(ok).toBe(false)` wants — and neither had anything to do with TLS.

### §34. The distinction the whole design rests on

The distinction the whole design rests on. If the implementation had reached for `rejectUnauthorized: false` — or if supplying any bundle degraded to "trust anything" — this case would pass and the feature would be a verification bypass wearing a CA's clothes. `client-bad.crt` is a real certificate from a DIFFERENT issuer, so trusting it must leave the server's own chain unverifiable.

### §35. A GUARD, not a description

A GUARD, not a description. The reason this feature is a CA bundle rather than a skip flag is that a skip flag would inevitably be reachable from tenant-writable binding config. This fails the moment someone adds the easier option, which is exactly when it is most tempting.

Read with `readFileSync` over the source text rather than grep: two of this repo's files carry literal NUL bytes and are silently dropped from recursive greps, and a security census that can return a false zero is worse than none.

### §36. A SOURCE GUARD, and it is one on purpose

A SOURCE GUARD, and it is one on purpose — stated plainly because a reader deserves to know which kind of claim this is.

undici's `ca` option REPLACES the default trust store rather than adding to it, so passing the operator's bundle alone would make every publicly-signed BYO executor stop verifying. The bundled-backend cases above would all still pass, because they use a private CA either way: this is precisely a regression no test in this file can see.

MEASURED: removing `...rootCertificates` from the `ca` array left all 7 behavioural cases GREEN. Proving the positive behaviourally needs a publicly-signed endpoint, i.e. the internet, which this suite never touches. So the choice is this guard or nothing, and nothing means the regression ships silently and surfaces as "our executor stopped working after an upgrade".

## `apps/server/src/plugin-host/federation-mtls.test.ts`

### §37. Federation mutual TLS, and what the hardening added

M8 hardening (DESIGN.md §13, BUILD_AND_TEST.md §8 M8 item 6, "Federation mTLS transport identity") — SECURITY-SENSITIVE: proves `federation-https` genuinely presents a client certificate over a real TLS handshake, and that a peer without a valid one is rejected. Not a unit test of the Agent-construction code in isolation — this spawns a REAL `federation-https` subprocess (`SubprocessPluginHost`) and drives it against a REAL `node:https` server requiring (`requestCert: true`) and verifying (`rejectUnauthorized: true`) client certificates, exactly the posture a real commander domain's `federation-https` server-side listener would run.

No Postgres needed (this is entirely plugin-host + subprocess + a loopback TLS server), so this lives under `pnpm test`, not the Testcontainers integration suite — same tier as `plugin-host/host.test.ts`.

### §38. A real server requiring and verifying client certificates

A real HTTPS server requiring AND verifying client certificates — `rejectUnauthorized: true` means Node's TLS layer itself refuses the handshake for any peer that doesn't present a certificate signed by `ca`, before this server's request handler ever runs. Responds to any request with a minimal, well-formed `.scpbundle` body so a successfully-authenticated `federation-https` `pull()` call has something valid to parse.

## `apps/server/src/plugin-host/git-file-read-bounds.test.ts`

### §39. M21.2 review MAJOR 5, closed

M21.2 review MAJOR 5, closed — THE TRANSPORT BOUND, PROVED OVER THE REAL SUBPROCESS BOUNDARY.

`git-file-read.test.ts` proves `readFileAtRef` reaches the adapter's own hook inside the subprocess; this file proves the fix for the gap that hook's own `decodeBoundedBase64` doc flagged as a LIVE GAP (now closed — see `packages/plugins/git-provider-core/src/read-file.ts`): before this fix, `apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient` did `await res.text()` over the WHOLE response with no cap, so Gitea/GitLab's uncapped contents API would have buffered an arbitrarily large blob in full before `decodeBoundedBase64`'s gates ever ran.

WHY THE FAKE SERVER NEVER ENDS THE RESPONSE. This is the strongest proof available that the bound is enforced DURING accumulation and not after: the local server below writes chunks in an unbounded loop and never calls `res.end()`. `await res.text()` (or any "wait for the stream to finish, then check the size" implementation) would hang on this response FOREVER — there is no "after" to check at. Only an implementation that inspects the running total as bytes arrive, and aborts the read once the total exceeds the bound, can ever settle this call. So the test passing at all (rather than timing out) is itself the proof, independent of the specific assertion below. `gitea` is used (a single static PAT, no App-JWT token exchange) so the fake server only needs to answer the two REST calls `readFileAtRef` actually makes — the ref-resolution list and the contents fetch — rather than also emulate an OAuth-shaped exchange.

## `apps/server/src/plugin-host/git-file-read.test.ts`

### §40. The git file read crosses the plugin-host boundary

M21.4 (ADR-0032 §7a) — THE GIT-PROVIDER FILE READ CROSSES THE PLUGIN-HOST BOUNDARY.

These spawn REAL child processes (like `host.test.ts`) and touch no database, so they belong at the unit layer. They exist because M21.2's `readFileAtRef` was, until this milestone, unreachable from the server: it is a `GitProviderAdapter` hook and deliberately not an `ExecutorPlugin` verb (ADR-0032 §9), and no plugin-host client shape carried a file-read method. Three of the five ADR-0032 §7a ecosystems therefore recorded nothing, every time, under `manifest_reader_unavailable`.

WHAT MAKES THESE REAL PROOFS RATHER THAN SHAPE ASSERTIONS. Neither needs a network:

- the POSITIVE test asserts an error message that ONLY `@scp/git-provider-core`'s `assertSafeRepo` produces, and the github adapter runs it before any HTTP. So seeing that text means the call travelled server → JSON-RPC → subprocess → `loadPlugin`'s adapter hook and executed inside it. A stub, a mis-wired dispatch, or a client that never left the server cannot produce it. - the NEGATIVE test pins that a non-git module refuses by naming the missing HOOK. Before the wiring, every module answered `unknown method "readFileAtRef" for an ExecutorPlugin instance` — which is what the dispatch's default arm still says for a genuinely unknown verb, so the two outcomes stay distinguishable.

### §41. Instances started from a work list need a lifecycle

M21.4 MINOR E — instances started from a WORK-LIST need a lifecycle.

`stop()` tears down everything; there was no way to stop ONE. The dependency version poll starts an index instance per (ecosystem, org) on demand and, with no partial stop, those children stood for the worker's lifetime — up to five per org on a multi-tenant commander, for a job that runs once a day.

## `apps/server/src/plugin-host/host-bootstrap.integration.test.ts`

### §42. A pure API process must be able to dispatch a scan

A PURE `role=api` PROCESS MUST BE ABLE TO DISPATCH A DISCOVERY SCAN.

THE PROPERTY
`main.ts` used to construct the `SubprocessPluginHost` inside its `role === "all" || "worker"` guard. That guard exists to stop TWO processes running the reconcile/watchdog/observe loops; it has nothing to say about whether a process may host a plugin for the duration of one request.

Conflating them broke discovery in the deployment shape the Helm chart actually ships. On a split api/worker install the api process — the only one serving HTTP — had no host, so `POST /discovery/run` answered 400 for every caller, and the message told the operator to set `SCP_ROLE=all`, which would have started a second set of loops beside the worker's. Measured on the live homelab on 2026-08-02: the route was unreachable there, which is what blocked the post-import-configuration.md §6 migration's required verification step (re-resolving a moved binding against the real Argo CD).

WHAT IS ASSERTED, AND WHY IT IS THE FAILURE MODE RATHER THAN A SUCCESS
A genuinely successful scan needs a reachable Argo CD, which an offline test must not require (CLAUDE.md: tests never touch the internet). So the measurement is that the request gets PAST the host check and fails later, for a reason that can only be reached once a host exists. `400 unknown discovery plugin module` is that reason: it is evaluated immediately after the host guard, and it was unreachable on an api process before this change.

That is a real distinction, not a semantic one — before the fix EVERY body produced the same "no plugin host" answer, so a caller could not tell a misconfigured request from a misconfigured deployment.

NOTE on `test-support/harness.ts`: it mirrors the OLD coupling, creating a host only under `withReconcileLoop`. That is why no existing test caught this — the harness reproduced the bug faithfully. These tests therefore call the PRODUCTION wiring (`startPluginHostForRole`) directly rather than relying on the harness.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `host-bootstrap.ts`: assign `deps.pluginHost` only for all/worker (the old behaviour) | BOTH the deps test and the api-dispatch test FAIL — the route answers "no plugin host" again | | `host-bootstrap.ts`: drop the role check in `sharedPluginInstancesForRole` so api also starts the shared fake-executor | the instance-gating test FAILS (an api process would run a coordination singleton it does not own) | | `host-bootstrap.ts`: have `sharedPluginInstancesForRole` return `[]` for every role | the worker test FAILS — the coordination loops would lose the shared instance they depend on |

## `apps/server/src/plugin-host/host-bootstrap.ts`

### §43. Which role gets a plugin host, and which gets the fake

WHICH ROLE GETS A PLUGIN HOST, AND WHICH GETS THE SHARED FAKE-EXECUTOR INSTANCE.

THE CONFLATION THIS SEPARATES
`main.ts` used to build the `SubprocessPluginHost` INSIDE its `role === "all" || "worker"` guard, beside pg-boss, the outbox relay and the reconcile/watchdog/observe loops. That guard is about BACKGROUND WORK — who owns the single-writer loops — and hosting a plugin for the duration of one HTTP request is not background work.

The consequence was not theoretical. In a split api/worker deployment — which is what the Helm chart ships and how the homelab runs — `deps.pluginHost` was undefined on the api process, the only process that serves HTTP, so `POST /discovery/run` answered 400 for every caller. Discovery was unreachable in the topology the chart defaults to, and the error's own remediation ("run SCP_ROLE=all") was actively wrong: it would have started a SECOND reconcile/watchdog/observe loop set alongside the worker's, which is the one thing the role guard exists to prevent.

THE TWO DECISIONS, NOW SEPARATE
```text
the HOST      — every role. An idle supervisor with no children costs almost nothing, and it is
                what makes a request-scoped plugin call possible at all.
the INSTANCES — role-gated. The shared fake-executor instance exists for the coordination loops
                (`coordination/executor-config.ts` explains why it is a process-wide singleton),
                so an api-only process starts with NONE. Discovery registers its own instance
                per request, so it never depended on that default and gains nothing from it.
```

Neither egress boundary moves. The chart's executor NetworkPolicies select every pod of the release rather than the worker alone, and the app-level SSRF egress guard is per-plugin-instance, not per-process — so which process dispatches a plugin changes no permission.

### §44. Constructs the host, publishes it and starts it

Constructs the host, publishes it on `deps` and starts it with whatever instances this role owns.

Assignment happens BEFORE `start()` resolves on purpose: route handlers read `deps.pluginHost` at REQUEST time, and the server does not accept connections until `main` reaches `app.listen`, so there is no window in which a request can observe a half-started host.

## `apps/server/src/plugin-host/host.test.ts`

### §45. Wraps the REAL `child_process.spawn`

Wraps the REAL `child_process.spawn` (calls through — this must still spawn genuine children, not a stub) so the env-leak test below can inspect exactly what `host.ts` passed it. `vi.mock` factories are hoisted above imports by Vitest, and ESM named exports can't be `vi.spyOn`'d directly ("Module namespace is not configurable") — re-exporting a `vi.fn(actual.spawn)` wrapper is the supported pattern.

### §46. Unit tests for the subprocess host's process boundary

Unit-layer tests for the subprocess plugin host's PROCESS boundary (no Postgres — these spawn real child `node` processes but never touch the DB, so they belong under `pnpm test`, not the Testcontainers integration suite). Two PR #7 adversarial-review findings against `host.ts`:

- CRITICAL #3: the child inherited the full parent `process.env` (admin `DATABASE_URL`, cookie/OIDC secrets) — a plugin could connect to Postgres as the admin/superuser role and bypass RLS entirely. - CRITICAL #4: the readline framing of the child's stdout had no line-length cap, so a plugin that streams bytes without ever emitting `\n` grows the PARENT process's memory unboundedly.

### §47. M7 SSRF mitigation

M7 SSRF mitigation (subprocess-entry.ts's `scopedFetchHttpClient` + egress-guard.ts) — enforced over the REAL subprocess boundary. The loopback/private allowance is gated on MODULE IDENTITY, NOT `allowedHosts` (MAJOR #6 follow-up: tenant bindings default to empty `allowedHosts`, so an emptiness heuristic reopened the hole). This drives BOTH plugin kinds at the SAME loopback server: a TENANT plugin (`webhook-notify`) is refused (server never hit), while the OPERATOR-PLANE escape hatch (`webhook-control`) reaches it. If the module gate were removed, webhook-notify would reach the server and this test would fail — the regression guard. (The full allow/block IP matrix is exhaustively unit-tested in egress-guard.test.ts with IP literals.)

### §48. Simulates a Mode-A in-cluster executor

Simulates a Mode-A in-cluster executor: `webhook-notify` is a TENANT module (never in OPERATOR_PLANE_MODULES), so under default rules loopback/private is blocked. The ONLY thing that flips it is `allowInternalEgress` — which host.ts threads from a persisted execution-system object's property, NOT tenant config. This drives BOTH the granted and the ungranted instance at the SAME loopback server: exactly one reaches it. If the env-var path (host.ts → subprocess-entry.ts's `allowInternalPrivate` OR) regressed, either the grant would stop working (hits 0) or the default would leak (hits 2).

### §49. The fixture floods standard output as fast as it can

The fixture floods stdout with 64KB, newline-free writes forever, as fast as it can. If the guard is broken (mutated away), readline just keeps concatenating those chunks into one ever-growing in-memory line and this line-guard message never appears — the host would instead eventually time out or OOM. With the guard in place, it should trip (and the child get killed + respawned, which floods again and trips again) multiple times within a few seconds.

## `apps/server/src/plugin-host/host.ts`

### §50. The subprocess plugin host

The subprocess plugin host (DESIGN.md §11, BUILD_AND_TEST.md §8 M3 item 7): "one child process per configured plugin instance (`scpd plugin-host`, same image), speaking JSON-RPC 2.0 over stdio, with host-enforced call timeouts, restart-with-backoff, and OS-level resource limits. A crashed or hung plugin cannot take down the worker."

`contract.ts` declares the `PluginHost`/`ExecutorPluginClient` interfaces this implements — written first so `coordination/reconcile.ts` depends on a narrow, stable seam rather than this file's process-management internals. What this file adds on top of the wire protocol (rpc-protocol.ts) and the child's own entry point (subprocess-entry.ts):

- **Spawn**: `node <subprocess-entry.js>` per instance, config passed via env vars (never argv — subprocess-entry.ts's module doc), stdout/stdin reserved exclusively for newline-delimited JSON-RPC (readline-framed), stderr passed through for log aggregation. - **Readiness gate**: calls queued against an instance block until its `ready` notification arrives (or the instance's overall call budget elapses) — see `call()` below. - **Host-enforced timeouts**: every RPC round trip races a timer; on timeout the (possibly hung) child is killed, which converts a "hung" plugin into the same recovery path as a "crashed" one. - **Restart-with-backoff**: an unexpected child exit (crash, killed-for-timeout, killed by an operator/test) schedules a respawn after an exponentially growing delay (reset once the instance has stayed up past a stability window) — never gives up, since a plugin instance is load-bearing infrastructure for whatever wave targets reference it. - **Transparent retry across a respawn**: `contract.ts`'s promise that "callers never see a dead subprocess, only a slower/retried call" is honored by `call()` itself: if the in-flight request's promise is rejected because ITS child exited mid-call, and time remains in the call's own timeout budget, `call()` waits for the respawned instance to become ready and retries once more — the caller (coordination/reconcile.ts) only ever sees either a successful result or a timeout, never a raw "child process died" error. - **Soft resource limit**: children are spawned with `--max-old-space-size` (Node's own heap ceiling) — a real cgroup/container memory limit is a deployment-level concern (the Kubernetes pod / compose service the whole `scpd` process runs in), out of reach from inside a plain `child_process.spawn` on every platform this needs to run on (macOS dev, Linux CI, air-gapped VMs), so this is the honest, portable subset: it bounds the ONE resource every plugin instance (a Node process) can blow up in-process, without a new dependency.

### §51. When THIS module is itself executing as compiled JS

When THIS module is itself executing as compiled JS (production `node dist/main.js`), the compiled sibling `subprocess-entry.js` sits right next to it. But when this module is executing as TS source directly — `tsx watch src/main.ts` in dev, or vitest's on-the-fly TS transform for every `*.test.ts` — there is no compiled sibling to find, and the correct default is to run the `.ts` entry point through the same `tsx` loader this process itself is already running under (see `spawnInstance`'s `--import tsx` below). `import.meta.url` reliably keeps the ORIGINAL source extension under both tsx and vite-node, so checking it is a robust signal, not a heuristic — this is NOT a "which file happens to exist on disk" check (dist/ can be stale or absent in dev) but a "how was I, this very module, loaded" check.

### §52. The HANG DETECTOR

The HANG DETECTOR: per-call RPC budget (ms), including any wait-for-ready + one transparent retry. Default 10s.

NOT A UNIVERSAL BUDGET SINCE M23.1c. It applies to every method that is supposed to be fast, and a managed executor's `trigger` — the one method that legitimately runs a container to completion — derives its own from the instance's resolved `timeoutMs` instead (`call-policy.ts`). Do not "fix" a slow managed run by raising this: doing so blinds the host to a wedged `status()` on every plugin in the product, which is the thing this number is for.

### §53. The previous environment passthrough was far too wide

CRITICAL #3 (PR #7 review): the previous `{ ...process.env, SCP_PLUGIN_* }` spread handed every plugin subprocess the FULL parent environment — `DATABASE_URL` (the admin/superuser connection, main.ts phase 1), `SCP_COOKIE_SECRET`, `SCP_OIDC_CLIENT_SECRET`, `SCP_RUNTIME_DATABASE_URL`, all of it. This allowlists only the handful of variables a Node child genuinely needs to boot and run `tsx`/module resolution: `PATH` (module resolution / any tool the loader shells out to), and the tmp/home dirs a couple of Node/esbuild internals fall back to when unset. Every `SCP_PLUGIN_*` config var the plugin actually needs is passed explicitly by the caller below — never inherited.

SCOPE OF THIS CONTROL — read before treating it as a sandbox. This narrows what the subprocess INHERITS; it is NOT an OS isolation boundary. The child is spawned same-uid with no namespace/seccomp confinement, so code that runs INSIDE it can still read the parent's `/proc/<ppid>/environ` directly, and can ignore the injected `ctx.http` egress guard by using `node:net`/`node:fs` itself. So this defends against ACCIDENTAL env leakage and a COOPERATIVE plugin — and shrinks the blast radius of a bug — but it does not contain a plugin that is actively hostile at the code level. Real OS-level isolation (separate uid, unshare/PID-ns, seccomp) is the follow-up that would make the in-process `ctx.http`/env mediation a true boundary; see DESIGN.md §11.

### §54. The line reader has no built-in cap, so one is added

CRITICAL #4 (PR #7 review): `readline.createInterface` has no built-in cap on how many bytes it will accumulate while waiting for the next `\n` — a plugin that streams bytes without ever emitting a newline (buggy, hung, or malicious) would otherwise grow the PARENT process's memory without bound, defeating DESIGN.md §11's "a crashed or hung plugin cannot take down the worker."

A plain byte-counting tracker rather than an intermediate `Transform` piped in front of readline: Node readable streams happily deliver each chunk to MULTIPLE `'data'` listeners, so this taps the exact same chunks readline consumes, independently, with none of the destroy/ unpipe race conditions a Transform-in-the-pipe-chain approach has to fight when it needs to abort mid-stream. `record()` tracks bytes seen since the last `\n` — across chunk boundaries, and at every `\n` found WITHIN a single chunk (not just the chunk's tail), so one pathologically oversized embedded line can't slip through just because the chunk happens to end on a newline — and returns `true` the moment that count exceeds `maxBytes`. The caller (`spawnInstance`) reacts by killing the child directly, routing through the exact same exit handler — and therefore the same restart-with-backoff recovery — as a crash or a call timeout.

### §55. Kills the whole process group, not just the one child

Kills the WHOLE process group the plugin subprocess leads, not just that one PID.

WHY. The child is spawned `detached: true` below specifically so it becomes its own process group leader — anything IT execs (`runner-launcher`'s `execFileAsync(dockerBinary, …)`, one `docker create`/`cp`/`start`/`rm` per step) inherits THAT group by default, not this host process's. A plain `child.kill(signal)` therefore only ever hit the plugin's own event loop; a `docker start -a` it had already spawned survived every SIGKILL this file issues — on a genuine hang-timeout in production exactly as on `killInstanceForTest` in a test — as an ownerless process on the host, still holding stdio open, until the container it wraps finished on its own. `managed-trigger-budget.test.ts`'s ENOTEMPTY flake was that same orphan's startup preamble (a `docker create`/`start` stub unconditionally does `mkdir -p`+append-log on every invocation, orphan or not) landing mid-walk of a directory `afterEach` was already removing — a symptom of this leak, not a test-only race to retry past.

`-child.pid` is the POSIX process-group-kill form of `process.kill` (the negated pid addresses the group `detached: true` made this child the leader of, not the single process). Falls back to the single-process kill when the child never got a pid (already gone) or the platform has no process groups (Windows). Two error codes are swallowed rather than thrown, both MEASURED, not guessed — `host.test.ts`'s own CRITICAL #4 case (a second kill, from `stop()`'s `tearDown`, racing the line-guard's own already-issued kill of the same instance) reproduced the second one within one `--force` test loop: - `ESRCH` — the group is already empty (child and everything it spawned are already gone). - `EPERM` — on macOS/BSD, `kill(-pid, …)` on a pid whose process (and process GROUP) has ALREADY EXITED and been reaped can resolve against a DIFFERENT, unrelated process group that has since reused the same numeric id, which this process has no permission to signal. That is a races-with-reaping artifact of asking twice, not a real permission failure in our own tree — the single-process kill below is attempted regardless, for the same reason the ESRCH case falls through to it.

### §56. Idempotent per instance id

Idempotent per instance id (M4 addition — DESIGN §10.2's control bindings have no plugin-instance-configuration API yet, same gap `executor-config.ts` documents for executors, so `governance/control-runner.ts` provisions a control's plugin instance ON DEMAND from whatever `control_bindings` row it finds, calling `start()` again every time it might be needed). A config whose `id` is ALREADY registered is silently skipped rather than re-spawned — re-spawning would leak the previous child process (never killed) while a fresh one takes its place under the same id, and would race any in-flight call against it. Main.ts's own single boot-time `start()` call is unaffected (every id it passes is new).

### §57. Stop and forget a named subset, leaving the rest

M21.4 — stop and FORGET a named subset, leaving every other instance running. See `PluginHost.stopInstances` for why a partial stop exists (the version poll's index instances are derived from a work-list, not from operator configuration, and accumulated per org forever).

Teardown is byte-identical to `stop()`'s — the same `tearDown` both now call, so the two can never drift on what "stopped" means. `stopped = true` BEFORE the kill is what makes it a stop rather than a crash: `scheduleRestart` checks that flag, so the child's `exit` event does not respawn it. Deleting the id from the registry is what lets a later `start()` spawn it afresh — `start()` skips an id it already holds.

Unknown ids are ignored: a sweep that threw before starting an instance must still be able to hand its whole intended set to this from a `finally`.

### §58. Test-only: forcibly kills the running child, simulating

Test-only: forcibly kills the currently-running child for `instanceId`, simulating a crash (an OOM, a segfault, an operator's `kill -9`) so integration tests can exercise the plugin-host isolation DoD scenario ("kill the fake-executor SUBPROCESS mid-wave — the worker survives, the plugin restarts with backoff, the wave resumes") without needing OS access to the real PID from outside this class. No-ops if the instance isn't currently running (already mid-restart) — the point is to induce exactly one crash, not to assert one.

### §59. M21.4 (ADR-0032 §7a) — the git-provider file read

M21.4 (ADR-0032 §7a) — the git-provider file read. Same host, same instance registry, same timeout/restart-with-backoff and the same egress-guarded `ScopedHttpClient` the executor verbs on this instance use, because it IS the same subprocess and the same binding's credentials.

The instance id is an EXECUTOR instance's id — a git binding is one hosted instance, and the subprocess loads the adapter's hook beside the four-verb plugin (subprocess-entry.ts's `ReadFileHook`). Addressed through its own accessor rather than as a fifth method on `executor()` so the four-verb set stays the four-verb set (ADR-0032 §9). An instance whose module has no such hook rejects the call, from the subprocess, naming that.

### §60. The federation mutual-TLS material handed to a subprocess

M8 hardening (DESIGN.md §13, BUILD_AND_TEST.md §8 M8 item 6 "Federation mTLS transport identity"): forward the HOST-level (operator-configured, NEVER tenant-suppliable — same trust tier as `SCP_MANAGED_IAC_RUNNER_IMAGE` in executor-bindings-repo.ts) client-certificate file paths into ONLY the `federation-https` subprocess's env, gated on MODULE IDENTITY (the exact same discipline `subprocess-entry.ts`'s `OPERATOR_PLANE_MODULES` already uses for the internal-IP egress allowance) — no other plugin module ever sees these vars, and a tenant's `PluginHostInstanceConfig.config`/`secrets` can never reach or override them, since they are read straight from THIS (the scpd parent) process's own environment, not from any binding row. `subprocess-entry.ts` reads the actual PEM files (if the paths are set) and presents the client certificate for every request `federation-https` makes to the parent — real transport-level peer identity on top of the existing bearer+RBAC+Ed25519 journal signing, not a replacement for it. Unset (the pre-M8 default): federation-https keeps working exactly as before, with no client certificate.

### §61. The operator's extra certificate bundle, forwarded to all

The OPERATOR's extra CA bundle for executor TLS, forwarded to EVERY plugin subprocess rather than gated on module identity the way the mTLS material above is. The asymmetry is deliberate and worth stating: those three vars carry a client CERTIFICATE — an identity only `federation-https` may present, so leaking them to another module would let it speak as this instance. This one carries a trust ANCHOR: it decides whom a plugin is willing to verify, grants no identity, and weakens no check (there is deliberately no skip-verify option anywhere on this path). Any executor can face a privately-signed endpoint — the bundled Argo Workflows server is the case that forced it, serving HTTPS on 2746 with a self-signed certificate — so restricting it by module would just reintroduce the gap for the next backend.

Still SERVER-PROVENANCE: it is an env var on the host process, read from a file path only the operator controls. It is never read from the executor binding or plugin config, which are tenant-writable — a tenant that could name the CA could vouch for the endpoint it also names.

### §62. Detached makes this child its own process-group leader

`detached: true` makes this child the LEADER of its own new process group (POSIX; harmless — Node ignores it — on Windows) rather than a member of this host process's own group. That is what lets `killInstanceProcess` below target `-child.pid` and take down everything the plugin itself spawned (a `docker create`/`cp`/`start`/`rm` per runner-launcher step) in the same signal, instead of leaving those grandchildren as orphans once the plugin process it addressed is gone. See that function's doc comment.

### §63. A timeout means hung, not crashed, so it is killed

A timeout means the plugin is hung, not necessarily crashed — kill it so the normal exit handler reclaims it and restart-with-backoff kicks in, converting "hung forever" into "will come back". `sendOnce`'s caller (`call`) still only sees a timeout error.

THIS SIGKILL IS WHY THE BUDGET HAS TO BE PER-METHOD (M23.1c). There is no `finally` here and there cannot be one: the cleanup that matters lives in the CHILD (the runner launcher's `rm -f`, `withRecordedOutcome`, managed-iac's `saveState`) and SIGKILL runs none of it. So the only defence is to never let this fire while a legitimate managed run is in progress — see `call-policy.ts`'s grace, which exists to guarantee the plugin's own inner `execFile` timeout is the one that wins.

### §64. The entry point every client method funnels through

The public entry point every `ExecutorPluginClient` method funnels through: waits for the instance to be ready (bounded by the remaining call budget), sends the request, and — if the ONLY reason it failed was the child exiting mid-call (`PluginInstanceCrashedError`) — waits for the respawned instance and retries exactly once more per crash, as long as time remains. This is what makes `contract.ts`'s "callers never see a dead subprocess, only a slower/retried call" true rather than aspirational.

WITH ONE EXCLUSION, M23.1c: a managed executor's `trigger` is NOT retried. It is not idempotent from here — its ledger entry is written only after the run completes, so a retry re-enters a `tofu apply` that may still be in flight, and the retry's container name (derived from the same `idempotencyKey`) collides with the first run's and gets it torn down. That crash belongs to `reconcile.ts`, which has the Decision record and the backoff; it must not be swallowed here.

### §65. PER-METHOD, NOT ONE NUMBER FOR EVERYTHING

PER-METHOD, NOT ONE NUMBER FOR EVERYTHING (M23.1c). `opts.callTimeoutMs` stays the 10s HANG DETECTOR for `observe`/`status`/`abort`/`evaluate`/`send`/… — it is meaningful precisely because those are supposed to be fast. A managed executor's `trigger` is the one method that legitimately blocks for minutes (the charter's scoped execution exception runs its container synchronously), so its budget is derived from that instance's own resolved `timeoutMs` and its transparent crash-retry is switched OFF. See `call-policy.ts` for the measured consequences of the uniform 10s this replaces — an orphaned runner holding live credentials, and a second `tofu apply` issued while the first was still applying.

## `apps/server/src/plugin-host/managed-timeout-boot-gate.test.ts`

### §66. The install-site gate for the boot-time schema assertion

THE INSTALL-SITE GATE for M23.1c's `assertManagedTimeoutSchemas()`.

`call-policy.test.ts` proves the assertion WORKS. This proves it is CALLED — and the distinction is this repository's single most common defect (CLAUDE.md: "a component correctly built, well tested, and installed nowhere", six instances in one recent milestone, one of them a live RCE). A boot check that nothing invokes is a comment with a stack trace.

The check therefore has to be exercised the way production reaches it: by IMPORTING the module that owns the allowlist. `coordination/executor-bindings-repo.ts` calls it at module load, beside `assertEveryModuleHasManifest`, so this test replaces one managed plugin's manifest with an unbounded one and asserts the IMPORT ITSELF rejects.

DELETE THE `assertManagedTimeoutSchemas()` LINE FROM `executor-bindings-repo.ts` AND THIS TEST FAILS BY NAME — the import resolves happily and `.rejects` has nothing to catch. Nothing else in the suite would notice: `call-policy.ts` would simply stop treating `managed-scan` as managed and hand its `trigger` the 10s hang detector back, which is the original defect, restored on one plugin, green.

## `apps/server/src/plugin-host/managed-trigger-budget.test.ts`

### §67. The test shape that did not exist at any level

M23.1c — THE ONE TEST SHAPE THAT DID NOT EXIST AT ANY LEVEL, and the reason a ten-second SIGKILL through every managed run shipped and stayed shipped.

WHAT WAS ALREADY COVERED, AND WHY IT COVERED NOTHING. `managed-iac.integration.test.ts`'s own header says it plainly: "it calls the plugin, not the server" — the real managed executor is driven DIRECTLY, with no plugin host anywhere in the picture. And every test in the repository that does construct a `SubprocessPluginHost` (four files, twenty-one constructions) passes an explicit `callTimeoutMs` of 5–20s AND drives `fake-executor`, which answers instantly. So the product's real configuration — `host-bootstrap.ts`'s `new SubprocessPluginHost()` with NO options, i.e. the 10s default, in front of a plugin that runs a container for minutes — was the one combination nothing exercised. Component correct, wiring untested, suite green: CLAUDE.md's dominant defect class, and this file is the standing gate against it.

THE HOST IS THEREFORE DEFAULT-CONSTRUCTED HERE. `new SubprocessPluginHost()`, no options, on purpose — passing `callTimeoutMs` would reproduce exactly the blind spot being closed. If a future edit adds an option to these constructions to "make the test faster", it has deleted the test.

NO REAL DOCKER, AND THAT IS NOT A COMPROMISE. What is under test is the RPC BUDGET, not the runner: the seam is `config.dockerBinary` — the server-injected, tenant-refused field the plugin `execFile`s — pointed at a stub `sh` script that sleeps past the old budget and keeps a directory of "containers" that `create` adds to and `rm -f` removes from. That directory is what makes "no container is left behind" an assertion with teeth rather than a hope, and the second test below proves it has them by showing the stub DOES report an orphan under the old budget.

### §68. A stub that models the one property this asserts

A stub `docker` that models the ONE property this test asserts about the daemon: a container exists between `create` and `rm -f`. Absolute paths are baked into the script text rather than passed as env, because `host.ts` allowlists the child's environment (CRITICAL #3) and nothing this file sets would survive to the plugin subprocess, let alone to its own grandchild.

### §69. That error is a race with a process this file orphans

ENOTEMPTY IS A RACE WITH A PROCESS THIS FILE DELIBERATELY ORPHANS, NOT A TIDINESS PROBLEM. The stub `docker` recreates its state directory (`mkdir -p "$STATE"`) at the top of EVERY invocation, and the cases here SIGKILL a plugin subprocess mid-run precisely so a grandchild outlives it. A `rm -r` that walks, empties and then `rmdir`s loses to an invocation that lands between the walk and the rmdir: measured once in ~15 full `pnpm -w test` runs as `Error: ENOTEMPTY: directory not empty, rmdir '/tmp/scp-fake-docker-…'`, failing a test whose own assertions had already passed.

`maxRetries` IS THE DOCUMENTED ANSWER, not a sleep in disguise: `fs.rm` retries exactly this error set (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) with linear backoff. Both files that orphan a grandchild carry it — the property is "a temp-dir cleanup racing a process the test deliberately left running", and it is two files wide.

### §70. THE OTHER HALF OF DECISION

THE OTHER HALF OF DECISION (a), and a second guard against a vacuous first test.

A managed `trigger` no longer gets the host's transparent crash-retry. `host.call()` normally re-issues a request once per crash while budget remains — correct for an idempotent read, and actively dangerous here now that the budget is minutes rather than seconds: the retry re-enters a `trigger()` whose ledger entry is by construction not yet written, and its container name (derived from the same `idempotencyKey`) collides with the first run's, whose unconditional teardown then `rm -f`s the container that legitimately holds it.

`killInstanceForTest` is the SAME `child.kill("SIGKILL")` the old uniform timeout performed, so this also records what that timeout actually did to a run in flight — the container orphans and the ledger stays empty — which is what makes the first test's assertions measurements rather than hopes.

## `apps/server/src/plugin-host/managed-trigger-whole-run-budget.test.ts`

### §71. The wiring that had no test at any level, asked directly

M23.1e — THE WIRING THAT HAD NO TEST AT ANY LEVEL, ASKED THE ONE QUESTION IT WAS NEVER ASKED

`managed-trigger-budget.test.ts` is this file's sibling and it closed M23.1c: a managed run longer than the 10s hang detector must not be SIGKILLed. It drives a stub `docker` whose ONE slow step is `start`, because that was the shape of the defect it was written for.

THAT SHAPE IS EXACTLY WHY THE NEXT DEFECT SURVIVED IT. `@scp/runner-launcher` handed `{ timeout: spec.timeoutMs }` to `create`, to EVERY `docker cp`, to `start` and to the copy-out INDEPENDENTLY — four to six sequential calls, each with a fresh, full budget — so a run's wall clock was k x timeoutMs and nothing bounded the sum, while the host budget derived from it was `timeoutMs + a constant`. With one slow step there is nothing to sum, so a suite built around one slow step is structurally blind to it. Measured with four: `timeoutMs: 20_000`, steps of 18s/9s/18s/9s (every one under the inner 20s bound), budget 50000ms, elapsed 50003ms — `plugin 'managed-iac-overrun' call 'trigger' timed out after 50000ms`, container still held, no ledger entry, so `reconcile.ts` issues a SECOND `tofu apply` while the first is still applying.

SO THIS FILE'S STUB IS SLOW ON EVERY STEP. That is the whole difference, and it is the reason the file exists rather than another case in the sibling.

THE HOST IS DEFAULT-CONSTRUCTED, for the sibling's reason, restated because it is the standing gate: `new SubprocessPluginHost()` with no options is `host-bootstrap.ts` verbatim, and every other test in the repository that builds a host passes an explicit `callTimeoutMs` and drives a fast fake executor. Passing options here would delete the test.

### §72. What the teardown costs

What the teardown costs. Under `RUNNER_REMOVE_TIMEOUT_MS` (30s), and deliberately NOT free: it is the post-deadline work `MANAGED_TRIGGER_GRACE_MS` has to cover, and a stub that tore down instantly would make that constant untestable here.

IT IS NOT "THE ONLY WORK THAT HAPPENS AFTER THE RUN DEADLINE", WHICH IS WHAT THIS SAID — corrected by M23.5. That was true of the DOCKER adapter, which is the one this file drives, and false of the Kubernetes adapter, whose `finally` is three bounded calls; a step abandoned at the deadline can also cost one `RUNNER_STEP_ABANDON_GRACE_MS` before the teardown even begins. The whole term is `runnerPostDeadlineMs(kind)`, and the count it derives from is checked against the code by `@scp/runner-launcher`'s `teardown-model.test.ts` — this file cannot see either, because it drives one adapter through a stub `docker`.

### §73. A stub that is slow on every subcommand, modelling one

A stub `docker` that is SLOW ON EVERY SUBCOMMAND and models the one property this file asserts about the daemon: a container exists between `create` and `rm -f`. Absolute paths are baked into the script text rather than passed as env, because `host.ts` allowlists the child's environment and nothing set here would survive to the plugin subprocess, let alone to its grandchild.

IT DOES NOT NEED TO MODEL `timeout` ITSELF: the real `execFile` in the plugin subprocess is doing that, which is the point of driving this end to end rather than through a seam.

### §74. That error is a race with a process this file orphans

ENOTEMPTY IS A RACE WITH A PROCESS THIS FILE DELIBERATELY ORPHANS, NOT A TIDINESS PROBLEM. The stub `docker` recreates its state directory (`mkdir -p "$STATE"`) at the top of EVERY invocation, and the cases here SIGKILL a plugin subprocess mid-run precisely so a grandchild outlives it. A `rm -r` that walks, empties and then `rmdir`s loses to an invocation that lands between the walk and the rmdir: measured once in ~15 full `pnpm -w test` runs as `Error: ENOTEMPTY: directory not empty, rmdir '/tmp/scp-fake-docker-…'`, failing a test whose own assertions had already passed.

`maxRetries` IS THE DOCUMENTED ANSWER, not a sleep in disguise: `fs.rm` retries exactly this error set (EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM) with linear backoff. Both files that orphan a grandchild carry it — the property is "a temp-dir cleanup racing a process the test deliberately left running", and it is two files wide.

### §75. (vi) HIGH-2, END TO END

(vi) HIGH-2, END TO END: the container's own reap deadline had not passed while the run that stamped it was still going. This is the FLOOR of that property — the sharp, scale-free version (sampled continuously against a run that spends every millisecond of its budget) is `@scp/runner-launcher`'s `whole-run-budget.test.ts`, because at these wall clocks the two-minute grace hides the 18s overshoot that the defect actually produced.

## `apps/server/src/plugin-host/plugin-manifests-argo-workflows.test.ts`

### §76. team-pipeline-iac increment 8

team-pipeline-iac increment 8 — `argo-workflows` IS REACHABLE FROM THE SERVER, not merely from its own package.

WHY THIS FILE EXISTS
A passing `packages/plugins/argo-workflows` test suite proves the PLUGIN works. It proves nothing about whether `apps/server` can ever load it — that needs the module name to clear `isKnownExecutorModule` (`coordination/executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES` allowlist), have a manifest in `MANIFEST_BY_MODULE` (what `validatePluginConfig` gates a tenant binding's config on), and — the boot-time backstop — pass `assertEveryModuleHasManifest`, which runs at MODULE LOAD in `executor-bindings-repo.ts` and would take the whole server process down before this file's own `it()`s ever ran if the module name were allowlisted with no manifest. `managed-scan` sat allowlisted with no manifest for several milestones (CLAUDE.md's "component built, never installed" class); this file is the same shape of proof `managed-dep`'s sibling file (`plugin-manifests-managed-dep.test.ts`) established for that module, done here for `argo-workflows`.

### §77. Unlike the managed ones, this is loaded in-process

UNLIKE managed-iac/managed-scan/managed-dep, `argo-workflows` is loaded IN-PROCESS via a dynamic `import()` in `subprocess-entry.ts`'s `loadPlugin()` switch — exactly like `argocd` — never docker-spawned. `resolveExecutorPluginInstance` only injects `dockerBinary`/`runnerImage`/`networkMode`/`workspaceRoot` for those three docker-executed modules by name (apps/server/src/coordination/executor-bindings-repo.ts ~1169-1206); it never does so for `argo-workflows`, and the plugin itself never reads those keys. So — correctly mirroring `argocd`'s own manifest, which has no `additionalProperties: false` either — this manifest does not need to refuse them. `statePath`, by contrast, IS always server-injected (every module gets one) and IS part of `ArgoWorkflowsConfig`, so it round-trips as a legitimate key rather than something to refuse.

## `apps/server/src/plugin-host/plugin-manifests-dependency-index.test.ts`

### §78. A deliberate asymmetry that reads like an oversight

M21.4 pins a DELIBERATE ASYMMETRY that reads like an oversight, so it is pinned rather than only commented: the five `dependency-index` manifests are in `MANIFEST_BY_MODULE` and NOT in `BUNDLED_PLUGIN_MANIFESTS`.

Without this file the next reader "tidies" it one way or the other: - adding them to the published list widens `GET /api/v1/plugins/manifests`' response enum, i.e. changes the public v1 contract, in a milestone that ships no route for them; and - dropping them from the module map removes the `validatePluginConfig` gate that keeps the OCI index's SERVER-GOVERNED `skopeoBinary`/`allowedRegistryHosts` unsettable by a binding.

## `apps/server/src/plugin-host/plugin-manifests-fail-closed.test.ts`

### §79. A module a binding may name must have a config schema

THE PROPERTY: a plugin module a binding may name must have a config schema, and a module with no schema must be REFUSED rather than skipped.

`validatePluginConfig` used to open `if (!manifest) return;`, justified by a comment saying an unknown module is "caught separately (the module allowlist)". True of an UNKNOWN module; silent about the case that existed — a module ON the allowlist with NO manifest. Three were in that state on shipped main (`fake-executor`, `pipeline-generic`, `managed-scan`), so their bindings' configs were stored with no validation at all. `@scp/plugin-managed-scan` runs `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` was not among the keys the server injected either — so that was a tenant principal reaching arbitrary code execution on the SCP host. (It IS injected now, as independent defence in depth; the schema refusal below is the primary gate and this file is what proves the gate runs.)

A COMMENT IS NOT THE GUARD — the comment above `MANIFEST_BY_MODULE` already reasoned about this exact property for the dependency-index plugins, and `managed-scan` slipped past it anyway. Hence this file, plus the module-load `assertEveryModuleHasManifest` calls beside each allowlist.

MUTATION LOG (each applied ALONE against a green suite, then reverted): | mutation                                                    | result                          |
| restore `if (!manifest) return;` in `validatePluginConfig`   | 1 failed — the fail-CLOSED test | | drop `"managed-scan"` from `MANIFEST_BY_MODULE`              | file fails to LOAD: the boot     | |                                                              | assertion throws, naming it     | | drop `additionalProperties:false` from pipeline-generic      | 2 failed — pipeline-generic AND | |                                                              | its `terraform` preset          | | drop `additionalProperties:false` from fake-executor         | 1 failed — fake-executor        | | add manifest-less `webhook-control` to the NOTIFICATION list | file fails to LOAD: that        | |                                                              | allowlist's assertion throws    | | drop `stateRefByTarget` from fake-executor's `configSchema`  | 2 failed — the hand-typed       | |                                                              | negative control (`expected 400 | |                                                              | to be undefined`) AND the       | |                                                              | derived census (`expected […5]  | |                                                              | to include 'stateRefByTarget'`) |

A MUTATION TO A `packages/plugins/*` MANIFEST NEEDS `turbo build --force` BEFORE THIS FILE RUNS (pass 11): the manifests are imported through `main: dist/index.js`, so a `src/`-only edit leaves this suite green for the most misleading possible reason.

### §80. The escalation itself, per module

The escalation itself, per module: each server-governed key is refused, and — the control that makes the refusals mean something — a legitimate config for the same module is still ACCEPTED. A schema that refuses everything closes the hole and breaks the executor, and the refusal tests alone cannot tell the two apart.

### §81. THE SAME PROPERTY, CENSUSED RATHER THAN LISTED

THE SAME PROPERTY, CENSUSED RATHER THAN LISTED — M23.0 verification pass 11.

The literal above is a hand-typed restatement of "the tenant surface", and it was TWO KEYS behind when this was written: `detailByTarget` (added by pass 8) and `stateRefByTarget` (pass 10) had both reached `configSchema` without reaching this list. That is the same shape as the defect pass 8 found one level down — `@scp/plugin-fake-executor`'s own `config-schema-parity.test.ts` censuses the INTERFACE against the SCHEMA for exactly this reason — and a hand-typed list here reintroduces it at the place where the schema is actually ENFORCED.

So: read the schema's own properties, build a value from each property's declared TYPE, and require the enforcement point to accept it. A key that the schema declares but the validator rejects is a tenant-facing 400 on a documented option; a key added to the schema later is covered on the day it is added. The sample builder deliberately fills one entry of an `additionalProperties` map rather than passing `{}`, so the VALUE type is exercised too — `{}` satisfies every object schema and would make this arm vacuous.

## `apps/server/src/plugin-host/plugin-manifests-managed-dep.test.ts`

### §82. That module is registered, and its schema is strict

M21.5 — `managed-dep` IS REGISTERED, and its `additionalProperties: false` therefore RUNS.

WHY THIS TEST EXISTS AND WHAT IT IS ABOUT
An authored `configSchema` is worth exactly nothing until its module is in `MANIFEST_BY_MODULE`: `validatePluginConfig` looks the module up there and RETURNS SILENTLY when it finds nothing, so an unregistered module is an UNVALIDATED one. That is not hypothetical — shipped `managed-scan` authored the same schema, was never registered, and its `dockerBinary` (the executable it spawns) was settable from a tenant binding config as a result.

So this asserts BOTH halves that have to hold together: the entry exists, AND the refusal it enables actually fires on the server-governed keys. Deleting the map entry fails the second assertion, not merely the first — a test that only read the map would pass against a schema whose gate nothing ran.

The last case is the class rather than the instance: EVERY module on the executor allowlist must have a manifest here. That is the boot assertion PR #238 adds, expressed as a test so this milestone cannot be the one that breaks it.

## `apps/server/src/plugin-host/plugin-manifests-runner-launcher.test.ts`

### §83. Layer two of the three the adapter selection rests on

M23.2 — LAYER 2 OF THE THREE THE ADAPTER-SELECTION FIELD HAS TO MOVE THROUGH.

`@scp/runner-launcher`'s own header has said since M23.1 that `dockerBinary` and anything added beside it live in a class enforced in three layers that must move together — each plugin's manifest `configSchema` (`additionalProperties: false`), `validatePluginConfig` at the four write doors, and the LAST-wins injection sites — and that "WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated in that same change". This file is the second layer, pinned BY NAME.

WHY IT NEEDS ITS OWN TEST WHEN THE SCHEMAS ALREADY SAY `additionalProperties: false`. Because that is exactly the argument that was false for `managed-scan`, and the failure was arbitrary code execution on the SCP host: it authored a schema refusing `dockerBinary`, and the schema was never consulted because the module had no entry in `MANIFEST_BY_MODULE` and `validatePluginConfig` returned early for a module it had no manifest for. The protection existed in a doc comment. A key that decides WHICH SUBSTRATE runs a tenant's managed executor — and, through `kubernetes.workspaceVolume`, WHICH HOST PATH a pod mounts — is at least that class of key, so its refusal is asserted rather than argued.

`kubernetes.io` DESERVES ITS OWN SENTENCE. It is a FUNCTION-CARRYING object and therefore cannot survive a JSON round trip at all — but a binding config is stored as JSON and read back, so an attacker cannot smuggle a callable through it in any case. What a tenant COULD smuggle, absent this refusal, is `kubernetes.workspaceVolume: { kind: "hostPath", path: "/" }`, which mounts the node's root filesystem into a runner container. That is the reason the whole `kubernetes` block is refused as one key rather than field by field.

## `apps/server/src/plugin-host/plugin-manifests.ts`

### §84. The bundled plugin manifest catalog

The bundled plugin manifest catalog (static — no runtime hot-loading, DESIGN §11) and the config-schema gate every write door must run before a tenant-supplied binding config is stored.

Extracted out of `routes/executors.ts` when IaC apply became a SECOND door that stores executor bindings (docs/proposals/post-import-configuration.md §8 C1). The property that made this necessary is the one the original comment named: "a tenant attempt to set those server-governed fields is rejected HERE" — a gate that lives inside one route handler is a gate the next write path silently doesn't have. `managed-iac`'s schema is `additionalProperties: false` with no runnerImage/networkMode/workspaceRoot, so this is what keeps adversarial-review CRITICAL #1 closed on both doors rather than on the one that happened to be written first.

### §85. Narrow a manifest to the public contract, or fail loud

Narrow a plugin's own manifest to the PUBLIC v1 contract's shape, or fail LOUD at module load.

`@scp/plugin-api`'s `PluginKind` and `@scp/schemas`' `PluginKindSchema` are two lists of the same vocabulary, and M21.4 made them diverge on purpose: the plugin contract gained `dependency-index` (a seventh kind) while the v1 RESPONSE enum did not, because a dependency index is not a bindable, form-configurable plugin (see the note on `BUNDLED_PLUGIN_MANIFESTS` below).

A silent `filter` here would be the wrong shape for that divergence: the next kind added to the plugin contract AND intended for the API would quietly vanish from this endpoint, and the symptom would be a missing config form nobody could trace. Validating instead means adding such a manifest to the list below fails at BOOT with a message naming the enum that has to widen with it.

### §86. Two modules are deliberately absent from that list

`managed-dep` (M21.5) and `managed-scan` are DELIBERATELY absent from the list above and present in the module map below — the same split, for the same reason, as the dependency-index manifests noted further down. That list is a CONFIG-FORM CATALOG for what a tenant binds through `POST /executors`; neither of those classes is dispatched that way in practice. `managed-scan` is constructed directly by `federation/promotion-scan-step.ts`, and `managed-dep`'s instance is assembled by `dependencies/bump-dispatch.ts` from the component's own git-provider binding — its work-list is the subscription resolution, never a wave target, so nothing ever asks "which binding drives this target's pipeline?". Offering a form for a class whose enablement is an operator env var (`SCP_MANAGED_DEP_RUNNER_IMAGE`, unset ⇒ off) would advertise a control that does nothing on most deployments.

`managed-iac` IS in the list because a tenant genuinely binds it to a target (DESIGN §12 Mode 2). The distinction is "does a tenant bind this?", not "is it a managed class".

### §87. M21.4's five `dependency-index` manifests

M21.4's five `dependency-index` manifests (ADR-0032 §7) are DELIBERATELY ABSENT from the list above and present in the module map below. Two reasons, and the second is the load-bearing one:

1. THE LIST ABOVE IS A CONFIG-FORM CATALOG for things a tenant BINDS. A dependency index is not bindable: there is no `dependency_index_bindings` table and no write door that creates one. Its instances are constructed by the server from OPERATOR environment (`dependencies/version-index.ts`'s `resolveIndexInstanceConfig`), so a generated form for it would offer a tenant a control nothing reads. 2. THAT LIST IS THE BODY OF `GET /api/v1/plugins/manifests`, typed by `@scp/schemas`' `PluginKindSchema` — a six-value enum in the PUBLIC v1 contract. Adding these here would require widening that response enum, i.e. an API change, in a milestone that ships no route. When M21.6 gives dependency indexes a surface, the enum widens with it, deliberately.

They ARE in `MANIFEST_BY_MODULE`, which is what `validatePluginConfig` gates on — so the `additionalProperties: false` schemas still refuse a config carrying the OCI index's SERVER-GOVERNED `skopeoBinary`/`allowedRegistryHosts`, exactly as `managed-iac`'s runner settings are refused. Pinned by `plugin-manifests-dependency-index.test.ts` so neither half is "tidied".

### §88. Three are here and deliberately not in the other list

`fake-executor`, `pipeline-generic` and `managed-scan` are here and NOT in the published list above, for the same reason the dependency indexes are: the list above is the CONFIG-FORM CATALOG (`GET /api/v1/plugins/manifests`), and none of these three is a plugin an operator picks from a form — `fake-executor` is the in-repo test executor, `pipeline-generic` is already published under its `terraform` preset id (byte-identical schema), and `managed-scan` is driven by the commander's promotion scan step rather than bound by hand. Widening the PUBLIC v1 response body is a separate, deliberate change; closing the gate is not.

This map, by contrast, is the GATE — the one `validatePluginConfig` reads — and all three were missing from it while sitting on `KNOWN_EXECUTOR_MODULES`. Because `validatePluginConfig` used to return early when it found no manifest, every executor-binding write door (`PUT /executors/{id}/binding`, IaC apply) stored their configs with NO schema validation at all. For `managed-scan` that was arbitrary code execution on the SCP host: the plugin does `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` is not among the keys `resolveExecutorPluginInstance` injects, so nothing else stood in the way. `managed-iac` was safe from the identical config shape ONLY because it was in this map and its schema is `additionalProperties: false` — i.e. by exactly the check that no-oped for its sibling.

### §89. This entry is the whole point of authoring a schema

M21.5 — AND THIS ENTRY IS THE WHOLE POINT OF HAVING AUTHORED A SCHEMA.

`managed-dep`'s manifest declares `additionalProperties: false` over the TENANT surface only (`provider`/`appId`/`installationId`/`privateKeySecretKey`/`apiBaseUrl`/`timeoutMs`) and omits every server-governed field. That refusal is worth exactly nothing until the module appears in THIS map, because `validatePluginConfig` looks the module up here and RETURNS SILENTLY when it finds nothing — an unregistered module is an unvalidated one.

That is not a hypothetical: shipped `managed-scan` authored the same schema and was never registered, which left `dockerBinary` — the executable `managed-scan` spawns — settable from a tenant binding config. PR #238 closes the class by asserting at BOOT that every module in `executor-bindings-repo.ts`'s allowlist has a manifest here, which is why this entry is a prerequisite for M21.5 starting at all once that lands, not merely good hygiene.

The keys this entry refuses, named because they are the ones that matter: `dockerBinary` (what binary is executed), `runnerImage` (what image runs), `workspaceRoot` (what directory is written), and `networkMode` — which is refused here even though nothing reads it any more, so that a binding cannot look as though it configured an egress posture the plugin fixes as a literal.

### §90. Throws if the config does not satisfy the declared schema

Throws `badRequest` if `config` doesn't satisfy `module`'s declared `configSchema`, and ALSO if `module` has no manifest at all.

FAILS CLOSED, and the previous early `return` is the reason this comment is long. It read: "an unknown module has no schema to validate against — that's caught separately (the module allowlist)". That sentence is true of an UNKNOWN module and says nothing whatever about the case that actually existed: a module that PASSES the allowlist and has no manifest. `fake-executor`, `pipeline-generic` and `managed-scan` were all in that state on shipped main, so their bindings' configs were stored unread — and `managed-scan`'s config selects the binary it `execFile`s.

The allowlists really do run first at every one of this function's four call sites (`routes/executors.ts` binding-create + notification-upsert + discovery-run, and `coordination-as-code/plans-repo.ts`'s `assertInlineBindingsValid`), so in practice this branch is reached only by a NEW allowlisted module whose author forgot the manifest — which is precisely the mistake being closed, and it must be refused rather than waved through. A never-reached refusal is the correct cost of a gate that cannot be forgotten.

### §91. Fails loud at load if an allowlisted module has none

Fails LOUD at module load if any module on a binding allowlist has no manifest.

`validatePluginConfig`'s refusal above is the runtime net; this is the one that means a mistake can never SHIP. The distinction matters because the runtime net only bites on a write door someone exercises, whereas an allowlist entry with no manifest is a defect the moment it is committed — `managed-scan` sat in exactly that state through several milestones with a doc comment in its own package asserting that the gate protected it.

A comment is not the guard: the comment above `MANIFEST_BY_MODULE` already reasoned about this exact property for the dependency-index plugins, and `managed-scan` slipped past it anyway. Called at module load by `coordination/executor-bindings-repo.ts` and `notify/notification-bindings-repo.ts`, next to the allowlists themselves, so the two can never drift apart unobserved — a boot that would accept an unvalidated config does not boot.

## `apps/server/src/plugin-host/rpc-protocol.ts`

### §92. JSON-RPC 2.0 message shapes for the subprocess plugin host

JSON-RPC 2.0 message shapes for the subprocess plugin host (DESIGN.md §11: "speaking JSON-RPC 2.0 over stdio"). Framing choice: newline-delimited JSON ("ndjson") on the child's stdin (requests in) and stdout (responses + one "ready" notification out) — one complete JSON value per line. Chosen over a length-prefixed/Content-Length framing (as LSP uses) for simplicity (CLAUDE.md's #1 decision priority): Node's pipes are already line-buffer-friendly, our messages are always small (a `TriggerIntent`, an `ExecutorEvent[]`, never a large binary payload — the plugin-api contract is JSON-serializable args/results only), and `readline` gives us the splitting for free on both ends.

Shared by host.ts (the parent/caller side, apps/server/src/plugin-host/host.ts) and subprocess-entry.ts (the child/callee side) so both sides agree on one wire shape.

CRITICAL: a child's stdout carries ONLY these messages, ever — never a plain log line. Any human-readable logging goes to stderr instead (subprocess-entry.ts's `Logger`), or it would corrupt the RPC stream host.ts is parsing.

### §93. THE INVENTORY OF EVERY METHOD THAT CROSSES THIS WIRE

THE INVENTORY OF EVERY METHOD THAT CROSSES THIS WIRE — one member per `case` in subprocess-entry.ts's `dispatch()`, and one per method on a `plugin-host/contract.ts` client.

It is documentation with a compiler behind it rather than a parameter type: `RpcRequest.method` is deliberately a plain `string` (see below), because the callee must be able to receive a method it has never heard of and refuse it explicitly. The union is what makes "which verbs exist" answerable from one place — and it had gone stale, which is exactly the failure mode a list maintained by hand has: M8's four `FederationTransportPlugin` methods and M21.4's three `DependencyIndexPlugin` methods were dispatched by the subprocess and called by the host without ever appearing here. They are added below with M21.4's `readFileAtRef`, so the inventory describes the wire again.

## `apps/server/src/plugin-host/subprocess-entry.ts`

### §94. Subprocess plugin host entry point

Subprocess plugin host entry point (DESIGN.md §11: "Plugin instances run under a subprocess plugin host: one child process per configured plugin instance (`scpd plugin-host`, same image), speaking JSON-RPC 2.0 over stdio"). `host.ts` `spawn()`s this file directly as its own process — one per configured `PluginHostInstanceConfig`.

Implemented as a small standalone script under `apps/server/src` rather than a new `scpd plugin-host` CLI subcommand threaded through `main.ts`/Fastify: the isolation semantics this file provides (construct one plugin instance, speak JSON-RPC over stdio) need none of the HTTP server or main.ts's DB/pg-boss boot sequence, and `tsc -b` already compiles anything under `src/` to `dist/`, so this needs no build-config changes — `host.ts`'s `resolveSubprocessCommand` spawns `dist/plugin-host/subprocess-entry.js` right alongside `dist/main.js`.

Config surface (documented framing choice, mirrors host.ts's `spawnChild`): the module to load and the instance's identity/config arrive as env vars — `SCP_PLUGIN_MODULE`, `SCP_PLUGIN_INSTANCE_ID`, `SCP_PLUGIN_ORG_ID`, `SCP_PLUGIN_SCOPE_KEY`, `SCP_PLUGIN_CONFIG_JSON`, and (M7) `SCP_PLUGIN_SECRETS_JSON` (resolved, already-decrypted secret values — `envSecretsAccessor()` below) and `SCP_PLUGIN_ALLOWED_HOSTS_JSON` (the egress allowlist — `scopedFetchHttpClient()` below) — rather than argv, because they're simple strings the host already fully controls and never touch a shell (`spawn()`'s array-argv form has no quoting/escaping surface either way, but env vars keep the process's argv itself uninteresting/unloggable-as-a-command-line, which matters now that `SCP_PLUGIN_SECRETS_JSON` genuinely does carry secret material).

Wire protocol: newline-delimited JSON-RPC 2.0 (rpc-protocol.ts). CRITICAL: this process's stdout carries ONLY protocol messages — never `console.log`/plain text, or it corrupts the RPC stream host.ts is parsing. All logging (including the plugin's own `PluginContext.logger`) goes to stderr.

### §95. The file-read hook that rides alongside an executor

M21.4 (ADR-0032 §7a) — the file-read hook that rides ALONGSIDE an executor plugin, never ON it.

`readFileAtRef` is a `GitProviderAdapter` hook and `createExecutorPluginFromAdapter` deliberately omits it (ADR-0032 §9): the four-verb `ExecutorPlugin` set IS the structural enforcement of charter principle 1, so a fifth verb would remove the enforcement mechanism rather than extend it. Carrying the hook as a SEPARATE field on the loaded record is what keeps that true — the `plugin` object below still exposes exactly observe/trigger/status/abort, and git-provider-core's "it does NOT surface readFileAtRef as an ExecutorPlugin verb" test is untouched — while giving the host a route to the adapter's read for the three modules that have one.

Absent for every non-git-provider executor, which is why the dispatch below refuses by naming the MODULE rather than the method: "this instance's plugin has no file-read hook" is the operator's actual situation, where "unknown method" would send them hunting for a typo.

### §96. Static module map

Static module map (DESIGN.md §11: "No runtime hot-loading, ever") — grows as M4/M7 ship more in-repo plugins, never by loosening this to a dynamic/unchecked import. `kind` on the returned union drives `dispatch()`'s method routing below (executor methods vs. `evaluate` vs. `discover` vs. `send`). Every case here MUST also be a member of `PluginModule` (plugin-host/contract.ts) — that union is the compile-time half of this same contract.

### §97. The plugin HTTP client: egress-controlled and instrumented

`PluginContext.http` (DESIGN.md §11: "egress-controlled, instrumented"). M3 shipped this backed by a plain `fetch` with NO egress scoping/allowlist enforcement at all — acceptable for M3 because the only shipped plugin (fake-executor) never called it. M7 closes that TODO: every plugin instance's `PluginHostInstanceConfig.allowedHosts` (resolved from `executor_bindings`/ `notification_bindings.allowed_hosts` — contract.ts's doc comment) arrives here via `SCP_PLUGIN_ALLOWED_HOSTS_JSON` and is enforced BEFORE the request is ever dispatched — an out-of-allowlist URL throws instead of reaching `fetch()` at all (SSRF mitigation: a plugin can't be redirected into hitting an attacker-controlled or internal-only host it wasn't explicitly configured to reach).

Empty/unset `allowedHosts` preserves the M3-M6 unscoped behavior — required for `webhook-control` (DESIGN §10.2's "generic webhook escape hatch": its entire purpose is POSTing to an arbitrary operator-configured URL, which by definition isn't a fixed allowlist) and for `federation-https` (peer URLs come from `federation_peers`, not a plugin-instance-level allowlist). Every M7 network-calling plugin (github/argocd/webhook-notify) is expected to set `allowedHosts` explicitly at binding-creation time for real SSRF protection.

MAJOR #6 — the allowlist alone doesn't stop the cloud metadata endpoint / loopback / internal services, nor an allowlisted hostname that DNS-resolves (or a 3xx redirects) to an internal IP. `egress-guard.ts`'s `assertEgressAllowed` adds an internal-range deny-list enforced AFTER DNS resolution (link-local/metadata ALWAYS blocked; loopback + private blocked for every plugin EXCEPT the operator-plane escape hatches in `OPERATOR_PLANE_MODULES` — gated on MODULE identity, never tenant config), and this client disables redirect-following entirely.

### §98. The only modules permitted to reach internal hosts

The ONLY plugin modules permitted to reach loopback/private internal hosts (MAJOR #6 follow-up): the genuine operator-plane escape hatches. `webhook-control`'s control-server URL is operator-configured behind `policy:write` (never an ordinary tenant), `scan-result-control`'s scan-verdict source URL is the same (a control binding, same `policy:write` trust tier, and the verdict store is often an in-cluster/on-prem artifact registry reachable only at a private address), `federation-https` dials on-prem/single-host peers, and `github-check` (M10.4) is the same `policy:write`-gated control-binding trust tier again — its `apiBaseUrl` legitimately targets a self-hosted GitHub Enterprise Server at a private address, exactly the on-prem case `scan-result-control`'s own justification names. EVERY tenant-configurable plugin (webhook-notify, github, argocd, terraform, managed-iac) is absent here, so its `ctx.http` cannot be pointed at `127.0.0.1`/`10.x`/... — this gate is on MODULE IDENTITY, not on `allowedHosts` emptiness (which tenant bindings default to, and which a tenant controls). Metadata/link-local stay blocked for these modules too.

### §99. The federation mutual-TLS material, in the subprocess

M8 hardening (DESIGN.md §13, BUILD_AND_TEST.md §8 M8 item 6, "Federation mTLS transport identity"): reads the HOST-level (operator-configured, never tenant-suppliable — `host.ts`'s `spawnInstance` forwards these into ONLY the `federation-https` subprocess's env, gated on module identity) client-certificate material `federation-https` presents to the parent. All three are OPTIONAL — unset (the pre-M8 default) means no client certificate, and federation-https keeps working exactly as it did in M6 (bearer+RBAC+Ed25519 journal signing, no transport-level peer identity). Reads synchronously, once, at subprocess boot — this is static per-deployment config, not something that changes per call or per instance.

A configured-but-unreadable path fails LOUD (throws, taking the subprocess boot down with a clear error the plugin-host surfaces to its own stderr) rather than silently degrading to "no client cert" — a misconfigured mTLS setup that quietly falls back to unauthenticated transport is a false sense of security worse than an obvious boot failure.

### §100. The OPERATOR's additional CA bundle for executor TLS

The OPERATOR's additional CA bundle for executor TLS (`SCP_EXECUTOR_TLS_CA_FILE`).

WHY THIS EXISTS. A bundled or on-prem execution system commonly serves HTTPS with a certificate signed by a private CA — the vendored Argo Workflows server is the case that forced this: it listens on 2746 with a SELF-SIGNED certificate (its own readiness probe uses `scheme: HTTPS`), so every plugin request to it failed verification and the coordinated-test path was unreachable on the bundled tier even with the NetworkPolicy open.

WHAT IT IS NOT: a verification bypass. There is deliberately no "insecure"/"skipVerify" option anywhere on this path. This ADDS a trust anchor; it never disables the check, so a certificate that chains to neither the system roots nor this bundle is still refused. The failure mode of the alternative — a per-binding skip flag — is that TLS verification becomes TENANT-WRITABLE, and this codebase's standing rule is that transport security is never decided by data a tenant can author (the same provenance discipline `allowInternalPrivate` follows: module identity, never config).

SERVER-PROVENANCE, LIKE THE MTLS MATERIAL. It arrives as an env var the HOST chooses to forward (`host.ts`'s `spawnInstance`), read from a file path only the operator controls — never from the executor binding, never from plugin config, never from a graph property. An executor binding is tenant-writable, so a CA reference living there would let a tenant nominate the authority that vouches for the endpoint it is also nominating.

Unset (the default) returns `undefined` and every request keeps using Node's system trust store exactly as before — byte-for-byte the previous behaviour for every existing deployment.

A configured-but-unreadable path THROWS rather than degrading to system-roots-only: a CA bundle that silently fails to load looks identical to one that loaded and did not match, and the operator would debug the endpoint instead of the path.

### §101. Reads a response body, enforcing the cap while reading

Reads a fetch `Response` body as text, enforcing `maxResponseBytes` DURING accumulation rather than after (M21.2 review MAJOR 5 — the gap this closes: `res.text()` used to buffer the WHOLE body before anything downstream got a chance to refuse it, so a hostile or misconfigured host serving a multi-gigabyte blob exhausted this process before `@scp/git-provider-core`'s decode bound ever ran).

Reads via `getReader()` chunk-by-chunk rather than `for await…of res.body` so the abort path is explicit: the moment the running total exceeds the bound, the reader is `cancel()`ed (which signals the underlying transport to stop pulling bytes off the wire, not merely "stop looking at them") and the promise REJECTS with a `scopedHttpResponseTooLargeError` — verified empirically (a throw from inside a bare `for await` loop over a fetch body does eventually unwind, but does not reliably signal the server to stop; an explicit `cancel()` does, and exits promptly rather than leaving a dangling response read).

Typed as accepting only the two members this needs (`body`, `text()`) rather than the concrete `Response` type, because `undiciFetch`'s and the global `fetch`'s `Response` types are two separately-vendored shapes that do not structurally unify without a cast (see the comment on the two fetch branches below) — this narrower shape is satisfied by both without one.

### §102. A dedicated agent presenting the client certificate

A dedicated undici Agent presenting the client certificate on every TLS handshake this dispatcher makes — constructed once and reused (undici pools connections per-origin internally), not per-request. It is now built UNCONDITIONALLY, where it used to be `undefined` without mTLS/CA material and every request fell through to Node's global `fetch()`: the dispatcher is what carries `connect.lookup`, and address pinning is not optional. Node's global `fetch` re-resolves the hostname itself at connect time, which is precisely the DNS-rebinding window `createEgressPinRegistry` exists to close (egress-guard.ts) — there is no longer a request path out of this process that resolves a name twice.

MUST use the explicitly-imported `undici` package's OWN `fetch` (`undiciFetch`) with this Agent, never Node's global `fetch` — Node's global `fetch` is powered by its OWN internal, separately-bundled copy of undici, and passing a `dispatcher` constructed from a DIFFERENT undici install across that boundary throws (`UND_ERR_INVALID_ARG: invalid onError method`) at request time, not at construction time. Confirmed empirically while building this fix — global `fetch` + an externally-constructed `undici.Agent` are simply not interoperable. A dispatcher is now needed for EITHER reason: a client certificate to present (mtls), or an extra trust anchor to verify the peer against (`executorTlsCa`). When both are set the CAs are passed together — undici accepts an array — so adding an executor CA never silently drops the federation CA that was already there.

`ca` REPLACES the default trust store rather than extending it, which is a Node/undici behaviour worth stating: when only an executor CA is supplied we pass `[...rootCertificates, ca]` so a publicly-signed executor endpoint keeps verifying. Passing the bundle alone would "work" in the bundled-backend test and break every BYO executor behind a public CA — a regression that would look like an unrelated outage.

### §103. M3's `noSecretsAccessor()` always resolved `undefined`

M3's `noSecretsAccessor()` always resolved `undefined` — "there is no plugin-instance secrets config API yet". M7 adds one (`executor_bindings`/`notification_bindings.secret_refs`, `secrets/secrets-repo.ts`'s `resolveSecretRefs`) and threads the RESOLVED (already-decrypted) values through `SCP_PLUGIN_SECRETS_JSON` (host.ts's spawn env — contract.ts's `PluginHostInstanceConfig.secrets` doc comment) — this reads that map. Never logs it (this function's own body is the only place these plaintext values exist in this process, until a plugin's own code — e.g. `ctx.secrets.get()` callers — receives one by explicit key). Unset `SCP_PLUGIN_SECRETS_JSON` (any pre-M7 caller, or a plugin instance with no secretRefs configured) parses to `{}`, preserving "no secrets configured" as the honest default.

### §104. Loopback egress is permitted for two named reasons

Loopback/private egress permitted for (a) operator-plane escape hatches by MODULE identity, or (b) an instance whose backing execution-system object an operator explicitly marked `allowInternalEgress` (host.ts injects `SCP_PLUGIN_ALLOW_INTERNAL_EGRESS` from that persisted object only — never from tenant config; MAJOR #6 follow-up). Either way, `linkLocal`/`unspecified` (cloud metadata) stay blocked for every plugin (egress-guard.ts). A tenant binding's own `config.url = http://10.x` still resolves `false` here — it is not an execution-system property.

## `apps/server/src/plugin-host/test-support/runaway-stdout-entry.ts`

### §105. Test fixture ONLY

Test fixture ONLY — never referenced by production code. Deliberately violates the plugin-host wire protocol (DESIGN.md §11 / rpc-protocol.ts: stdout carries ONLY newline-delimited JSON-RPC) by, after announcing `ready` like a real plugin instance, flooding stdout with large newline-free chunks forever. Stands in for a buggy/hung/malicious plugin that never terminates a line.

Used by `host.test.ts`'s CRITICAL #4 regression test (PR #7 review: the readline framing had no line-length cap, so a plugin like this would grow the PARENT process's memory unboundedly) via `PluginHostOptions.subprocessEntryPath`, which `host.ts` documents as "overridable for tests only."

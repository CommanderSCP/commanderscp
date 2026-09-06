# index

Reference for `packages/runner-launcher/src/index.ts`. The source carries a one-line headline at each site and points here.

> Partial: 35 of 133 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M23.6 CLAUSE 1

M23.6 CLAUSE 1 — "no plugin spawns a Docker CLI on the Kubernetes path", stated as a test that "asserts the injected process spawner was NEVER called … asserted on the recorded spawn (argv), not on a mock's call count, so a renamed binary cannot pass it".

THERE WAS NO SUCH SPAWNER TO ASSERT ON. Every `execFile` in this package went straight to the module-private `execFileAsync` above, `RunnerLauncherConfig` exposes only `dockerBinary`, and the Kubernetes adapter is never handed it — so a spawn on the Kubernetes path had nothing recording it anywhere. Measured before this existed: a real `execFile(dockerBinary, ["version", …])` added to `resolveRunnerLauncher`'s KUBERNETES branch left `pnpm -w test` green (72/72), and a marker file proved the mutation was reached six times across the suite.

WHY A LEDGER AND NOT AN INJECTED FUNCTION. An injectable spawner on `RunnerLauncherConfig` would be a plugin-facing, server-injected field naming an arbitrary callable — a new hole in exactly the surface `dockerBinary`'s own doc spends three paragraphs bounding. A module-level ledger needs no new configuration, cannot be reached by a plugin, and records what actually happened rather than what a mock was asked for.

WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT. The BINARY (so `podman`, `/usr/local/bin/docker` or any rename is visible by name) and `argv[0]`, which for every call this package makes is a subcommand — `create`, `cp`, `start`, `rm`, `ps`. NOT the rest of the argv: M23.1a moved credentials out of argv into an `--env-file` precisely because argv leaks, and a permanent in-memory copy of every argv would put some of that back. `argv.length` is kept so a test can tell two spawns of the same subcommand apart.

BOUNDED, because an unbounded in-process array that grows once per container operation for the life of a long-running worker is the shape this milestone has already fixed twice elsewhere.

## §2. THE ONLY PLACE THIS PACKAGE STARTS A PROCESS

THE ONLY PLACE THIS PACKAGE STARTS A PROCESS. `execFileAsync` above is referenced exactly once, here — asserted as a source census by `no-docker-on-kubernetes.test.ts`, because a second direct call would be a spawn no ledger sees and therefore a clause-1 gate that silently stopped gating.

## §3. Where a FAILED copy-out lands

Where a FAILED copy-out lands. - `"swallow"` — managed-iac: `.catch(() => undefined)`, the run stays `succeeded`. - `"propagate"` — managed-scan and managed-dep: the rejection escapes `RunnerLauncher.run`. The two plugins then answer it differently (scan lets it escape `trigger()`; dep's outer catch turns it into a `failed` outcome), which is the plugins' business, not this port's.

## §4. THE CALLER'S OWN NAME FOR THIS RUN

THE CALLER'S OWN NAME FOR THIS RUN — unique per run, DNS-safe, and matching `RUNNER_RUN_ID_PATTERN`. The Docker adapter turns it into `--name scp-runner-<runId>`; the Kubernetes adapter (M23.2) puts the same string in `metadata.name`.

CALLER-SUPPLIED, NOT ADAPTER-MINTED, and that is the whole point. Only the caller knows what a run IS — managed-iac derives this from `intent.idempotencyKey` precisely so a retry addresses the same container name, which no adapter could know to do. An adapter that minted its own name would force the Kubernetes arm to invent a second naming scheme and recreate exactly the three-implementations-of-one-mechanism divergence M23.1 removed.

Build it with `toRunnerRunId`; the adapter REFUSES a runId that does not match the pattern rather than sanitising one silently, because a silently-sanitised name is how two runs come to share one container.

## §5. The network the runner gets

The network the runner gets. SERVER-GOVERNED where it is a config read (managed-iac, managed-scan) and a CHARTER LITERAL where it is not (managed-dep's `RUNNER_NETWORK_MODE`, ADR-0032 §8d) — this port takes the resolved value and never decides it, precisely so the difference between "an operator may change this" and "an operator may not" stays at the call site where the charter clause is quoted.

## §6. THE WHOLE-RUN BUDGET

THE WHOLE-RUN BUDGET — the maximum wall clock `RunnerLauncher.run` may spend on this run, from the moment it is called to the moment it returns, teardown excepted. 10 min for managed-iac and managed-scan, 5 min for managed-dep.

IT USED TO BE A PER-CALL BOUND, AND THAT IS THE DEFECT M23.1e EXISTS TO CLOSE. Every `execFile` this adapter issues — `create`, each `cp` in, `start -a`, the `cp` out — was handed `{ timeout: spec.timeoutMs }` INDEPENDENTLY, so a run of k sequential calls had a wall clock of k x timeoutMs and nothing bounded the sum. Measured: managed-iac (4 calls) with `timeoutMs: 20_000` and steps of 18s/9s/18s/9s — every one of them comfortably UNDER the inner 20s timeout — ran 50s and was SIGKILLed by the host budget that had been sized as `timeoutMs + 30s`, leaving an orphaned container mid-`tofu apply` and an unwritten idempotency ledger, so `reconcile.ts` issued a SECOND apply on top of the first. Reachable at the shipped 10-minute defaults, because `docker create` PULLS THE IMAGE when it is absent: a cold pull plus an ordinary apply clears 630s without any single call reaching 600s.

SO IT IS A DEADLINE, NOT A PER-CALL CAP. `createDockerRunnerLauncher` computes `deadline = now + clampRunTimeoutMs(timeoutMs)` ONCE, at the top of `run()`, and every `execFile` it issues gets `timeout: deadline - now` — never `spec.timeoutMs`, and never `0`, which Node reads as NO TIMEOUT AT ALL (measured on the running Node 26.7.0: `{ timeout: 0 }` let a 1.5s child run to completion). A step reached with the budget already spent is REFUSED before it is issued, with a `RunnerLaunchError` carrying `RunnerLaunchError.deadlineExceeded`.

THE TWO NUMBERS DERIVED FROM THIS ONE — the host's RPC budget (`call-policy.ts`) and the container's own `RUNNER_LAUNCHER_DEADLINE_LABEL` — ARE CORRECT BY CONSTRUCTION UP TO A CEILING, AND `clampRunTimeoutMs` IS WHAT MAKES THE CEILING TRUE. The sentence that used to end this paragraph said the two were "correct BY CONSTRUCTION rather than because a padding constant happened to be big enough". The construction was sound for every value BELOW `MANAGED_RUN_TIMEOUT_MAX_MS`, which is not the same as every value in the database: `call-policy.ts` clamped its OWN return value and the three plugins handed the STORED number to this field untouched, so above the ceiling the two derived numbers diverged by hours rather than by a padding constant. The clamp now runs inside `run()`, so a caller cannot skip it and a second adapter cannot forget it.

AND SINCE M23.5 SO DOES THE DEADLINE ITSELF, for exactly the reason that sentence gives. The clamp was hoisted into `run()`; the per-step deadline was not, and the second adapter forgot it on the two verbs that move bytes — `copyDir` and `removeDir` had no bound at all, so a copy onto a wedged network volume made `run()` never return. `createRunDeadline` is that same argument applied to the thing it was originally made about, and `withStepBound` is what makes a bound true of work that ignores it.

WHAT IS DELIBERATELY OUTSIDE IT: every call declared in `RUNNER_POST_DEADLINE_CALLS` — the `finally` teardown, which must still run after the budget is gone, and the Docker adapter's secret-env `unlink`, which is cleanup of a credential file and must not be refused because the `create` it follows is what spent the budget; and `reap()`, which is not awaited at all (see `RunnerLauncher.reap`).

THE BOUND `run()` IS HELD TO IS `runnerRunBoundMs``(kind, timeoutMs)`, AND THAT SUM IS WHAT EVERY OUTER BUDGET MUST COVER. This used to read `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, which was a sentence about ONE adapter's ONE-call teardown, written when there was one adapter, and FALSE of the Kubernetes adapter — whose teardown is three calls. The bound is now computed from the post-deadline model (`RUNNER_POST_DEADLINE_CALLS`) rather than asserted in prose, and the model is held to the code from both sides: the type checker forward, and `teardown-model.test.ts` — which counts every effect issued at or after the deadline — backward.

## §7. What a runner run produced

What a runner run produced. `succeeded` is the runner's own exit status, not the launch's.

A UNION, NOT A FLAG PLUS AN OPTIONAL FIELD — MEDIUM (verification pass 5). `start` is the only step whose failure is CAPTURED rather than thrown, and it is the step that consumes essentially all of a real run's budget; it used to be captured as `{ succeeded: false, stdout, stderr }` and nothing else. `promisify(execFile)` ALWAYS attaches `stderr` as a string, so for the two shapes an operator most needs explained — our own budget killing the runner, and a spawn that never happened — that string is `""`. Measured through the real adapter:

```text
  budget-killed `start`, no output   -> {"succeeded":false,"stdout":"","stderr":""}
  runner exits 3 silently            -> {"succeeded":false,"stdout":"","stderr":""}
```

Byte-identical, and through the real plugins that becomes `phase:"failed", detail:""` in the durable ledger, in `status()`, and from there in `reconcile.ts`'s `insertDecision` `inputContext` — the record charter principle 6 exists for, reading as if nothing went wrong at all.

Making `RunnerFailure` a member of the FAILED arm rather than an optional property is what stops that recurring: a caller cannot reach a failed result without also having the diagnosis in hand, and a future adapter cannot construct a failure without producing one. `stdout`/`stderr` stay exactly what the child printed (still possibly `""` — that is a true fact about the child); the never-empty explanation is `RunnerFailure.detail`.

## §8. M23.1 PHASE 4

M23.1 PHASE 4 — CONTAINMENT HYGIENE FOR THE WINDOW PHASES 1–3 CANNOT CLOSE. When the JS process that owns a run is SIGKILLed (or dies for any other reason) mid-`run()`, NO `finally` executes — not the adapter's own teardown, nothing. The container the daemon already started keeps running, `state=running`, doing whatever its workload does (for managed-iac, a `tofu apply` still mutating live infrastructure) with nothing left supervising it. Phases 1–3 made every container NAMED and LABELLED and made the SIGKILL itself rarer (the host's own hang detector no longer fires at 10s against a legitimate multi-minute run) — neither closes this window, because a label nobody reads is not a cleanup mechanism.

Removes every OTHER launcher's container whose `RUNNER_LAUNCHER_DEADLINE_LABEL` has passed. Two things this must NEVER do, and both are the actual hard part: - touch a container this SAME process is still supervising (it is not orphaned — checked by `RUNNER_LAUNCHER_OWNER_LABEL`, not by the container's state); - touch a LIVE PEER's container before that peer's own run has had a chance to finish and tear it down itself (checked by the deadline, not by "does it look idle").

Best-effort: a `docker ps`/`docker rm` failure here is logged (`NODE_DEBUG=scp-runner-launcher`) and swallowed rather than thrown, because a reap that cannot even list containers must not block the run it precedes.

NOT ON THE RUN'S CRITICAL PATH, AND NOT INSIDE ITS BUDGET — M23.1e. Phase 4 prepended `await reap()` to `run()` AFTER phase 3 had sized the trigger budget as `timeoutMs + MANAGED_TRIGGER_GRACE_MS`, and no phase re-checked the sum. Reap's `ps` and every `rm -f` were then spent out of the run's own budget: measured with `timeoutMs: 1_000` and four stale orphans taking 9s each to remove, the budget (31s) expired at 31.2s with `create` NEVER ISSUED. That failure MANUFACTURES ITS OWN WORKLOAD — the host's expiry SIGKILLs the subprocess, the respawned successor mints a new `LAUNCHER_OWNER_ID`, and every container the dead process had created is now FOREIGN, so it joins the next pass: the reaper's cost grows with each timeout it causes. A cleanup mechanism that can prevent the thing it cleans up after from starting is not a backstop, it is the failure.

So `run()` SCHEDULES a pass and does not await it, and each pass is itself hard-bounded by `RUNNER_REAP_BUDGET_MS` and single-flighted process-wide (`whenReapSettled`), which is what stops the amplification: an arbitrarily slow or wedged sweep can no longer delay `create` by so much as a tick, cannot consume a run's budget, and cannot stack up one pass per concurrent run. This method itself stays awaitable and keeps returning the ids it removed — that is what the tests and any future operator-facing sweep drive.

Scheduled by the Docker adapter at the top of every `RunnerLauncher.run`, before `create` — see `reaper.integration.test.ts` for why the mock recording seam (`docker-adapter.test.ts`) cannot prove any of this: it cannot show that a killed process leaves a container, that a label survives on it, or that a real `docker ps --filter` finds it. Returns the ids actually removed.

WHAT THE RETURNED LIST IS, AND THE TWO THINGS IT IS NOT. It is what THIS pass removed — a report on one sweep, never a post-condition on the daemon. Two properties make "everything that was expired when I called is now gone, and it is in this list" FALSE, and both have been measured (2026-08-23) as intermittent reds of `reaper.integration.test.ts`'s predicate case: 1. A JOINER GETS THE IN-FLIGHT PASS'S RESULT. Single-flighting means a caller arriving while a pass is running is handed THAT pass's promise, and that pass's `docker ps` may have been issued before the caller's own container existed — so the caller can be told `[]` about a container that is expired, present, and untouched. Await `whenReapSettled` FIRST if you need an enumeration that begins after your own state does. 2. THE DAEMON IS SHARED AND OWNERSHIP IS PER-PROCESS. "Foreign and past its deadline" is exactly what EVERY process running this package is entitled to collect, so a peer process's pass removes the same containers this one would have. An empty list therefore never means "nothing was expired" — it can equally mean a peer got there first. Nothing in-process can see that, `whenReapSettled` included. No production caller reads this value — `run()` schedules its pass with `void` and ignores it — so neither property is load-bearing today. They are stated because the tests DO read it, and because a future operator-facing sweep that reported "removed 0" as "nothing to remove" would be reporting a lie under both.

ALSO SWEEPS THE TRANSIENT `--env-file` (MEDIUM-4) — the SAME hazard, one level down. A SIGKILL between `writeSecretEnvFile` and the `finally` that unlinks it leaves a plaintext credential on disk with nothing left to remove it, for exactly the reason a killed `run()` leaves an orphaned container: no `finally` executes. ONE cleanup concept, not two — this is the SAME method, not a second one, because a reaper that only knew about containers would leave the higher-value target (a live credential, not a stopped process) uncovered.

`secretEnvDir`, WHEN GIVEN, is swept for `scp-secret-env-*` files older than `RUNNER_SECRET_ENV_MAX_AGE_MS` — mtime-based, deliberately, rather than a registry: a registry lives in the SAME process memory a SIGKILL erases, so it could never identify what a DEAD process left behind. mtime survives the kill because it is a property of the file itself. The age bound is conservative in the same direction the container deadline is: no run still inside its own budget can make its own file look stale, so a live run's file is never a candidate — the same "ambiguous must never read as safe" rule as a missing/garbled container deadline label. That budget is bounded by `MANAGED_RUN_TIMEOUT_MAX_MS` because `run()` applies `clampRunTimeoutMs` to `spec.timeoutMs` itself; see `RUNNER_SECRET_ENV_MAX_AGE_MS` for what this used to rest on instead and why that was false.

Called by the Docker adapter with the CURRENT run's own `spec.secretEnvDir` every time — never a directory this method chooses, for the same reason `writeSecretEnvFile` refuses to choose one. Absent (the caller's own `reap()` calls in tests, and any run whose spec carries no `secretEnvDir`) simply skips the file sweep; the container sweep is unaffected either way.

## §9. The Kubernetes adapter's deployment settings

The Kubernetes adapter's deployment settings. SERVER-INJECTED as one block, for the same reason `dockerBinary` is: the plugin subprocess never sees `process.env` (the host's `minimalChildEnv` strips it), so injected config is the ONLY channel these values have.

REQUIRED when `runnerLauncher` is `"kubernetes"`, and its absence is a NAMED refusal rather than a `TypeError` inside a half-built Job manifest.

## §10. The Kubernetes adapter's server-injected settings

The Kubernetes adapter's server-injected settings. Declared HERE rather than in `kubernetes-adapter.ts` so that `RunnerLauncherConfig` — the one type every plugin passes to its resolver — stays the single description of what a launcher can be configured with.

## §11. How a plugin obtains the launcher for one run

How a plugin obtains the launcher for one run. A FUNCTION rather than a launcher instance because a plugin object is constructed once (`createManagedIacExecutorPlugin()`) while its config arrives per `trigger()` on `ctx.config` — the adapter therefore has to be resolved per run.

This is also the injection seam the wiring tests drive: passing a resolver that throws must make a NAMED test fail, which is the only check that distinguishes "the port is wired" from "the port exists and the plugin still does it the old way" (CLAUDE.md's component-built-never-installed).

## §12. `code` on a maxBuffer overflow

`code` on a maxBuffer overflow. Node's own constant name, and the PRODUCT's copy of it: the table in `docker-adapter.test.ts` imports this rather than restating it, so "THE TABLE IS NOT FICTION" (which spawns a real child and compares `code` against the live Node) checks the string this classifier actually branches on. A second copy in the test would have made that check verify the fixture instead of the product.

## §13. HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED

HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED. The useful end of a `tofu apply`, a Trivy run or an `npm` failure is its LAST lines; a front-slice discards exactly the diagnosis. So this many characters at the END survive every bound this module applies, and anything that has to go goes from the MIDDLE.

## §14. BOUND A DETAIL, KEEPING BOTH ENDS

BOUND A DETAIL, KEEPING BOTH ENDS — the head (who failed, doing what, with which argv) and the last `RUNNER_DETAIL_TAIL_CHARS` characters (the diagnosis). What is dropped is the middle, which for a runner failure is the noise the tool printed on its way to the error.

IDEMPOTENT BY CONSTRUCTION: the result is never longer than the cap, so a second application is the identity. That is what makes it safe to apply at every trust boundary — the port, each plugin's store, the server's Decision write — WITHOUT recreating the defect this fixes, because they are the same bound and not three different slices.

PERSISTABLE BY CONSTRUCTION TOO, and that half is a HIGH regression fix, not a nicety. The bound slices at UTF-16 CODE-UNIT offsets, so both cuts — head and tail — can land in the middle of a surrogate pair. Four emoji in 8 KB of `tofu` output is enough. The product was an ill-formed string, which `jsonb` refuses, which threw inside `reconcileExecutingChange`'s `withTenantTx` — rolling back the `updateWaveTargetObserved` in the same transaction. Measured end to end: the wave target NEVER terminalised, the poll re-threw every tick forever, and the only trace was a `console.error` behind a green health check. That is this repository's own worked example (BUILD_AND_TEST.md §4.4a) — a coordination loop stopped for 13 days behind passing checks.

Sanitising is applied to the RESULT, not the input, for three reasons: it is at most `RUNNER_DETAIL_MAX_CHARS` long so the scan is bounded even for an 8 MB input; it catches the damage this function itself does at the two cuts; and it catches an input that was ALREADY ill-formed or NUL-carrying, including one short enough to skip the slice entirely — a plugin can hand us a detail decoded from a binary stream, and `text.length <= MAX` was previously a straight pass-through for it.

## §15. THE SAME BOUND AT AN ARBITRARY WIDTH

THE SAME BOUND AT AN ARBITRARY WIDTH — ONE implementation serving the operator-facing `detail` (`boundDetail`), the per-string share of a whole persisted structure (`boundPersistedJson`), and any other place that needs to cut a string short before storing it. `boundDetail` is this function at (`RUNNER_DETAIL_MAX_CHARS`, `RUNNER_DETAIL_TAIL_CHARS`).

EXPORTED BECAUSE THE ALTERNATIVE IS ANOTHER BARE `.slice`, and a bare slice at a UTF-16 CODE-UNIT offset is the defect this whole family of fixes is about: it cuts surrogate pairs, `jsonb` refuses the row, and the write throws inside whatever transaction it was in. A filterless census of "slice a string at a code-unit offset, then persist it" found a second live instance in `apps/server/src/dependencies/version-index-feed.ts`, so the primitive is offered rather than left private for each caller to re-invent.

`tailChars` of 0 gives a HEAD-ONLY bound with an honest elision count — the right shape for a short diagnostic preview, where a reserved tail would leave almost no head.

## §16. THE ONE KEY THIS FILE REFUSES TO WRITE

THE ONE KEY THIS FILE REFUSES TO WRITE — HIGH, M23.0 verification pass 14. PROTOTYPE POLLUTION REACHABLE FROM AN UNTRUSTED EXECUTOR'S RESPONSE.
`JSON.parse` gives `__proto__` as an ORDINARY OWN PROPERTY. A plugin's JSON-RPC response is parsed exactly that way, so `{"revision":"abc","__proto__":{"polluted":true}}` arrives here as a three-key object with `__proto__` among its own keys, and `Object.entries` hands it to the walk like any other field. `walkObjectFields` then wrote it with `out[field.key] = field.value` — which for THIS key is not a store at all. It is a call to `Object.prototype`'s `__proto__` SETTER. Measured on the build before this fix:

```text
  input   {"revision":"abc","__proto__":{"polluted":true},"images":["i1"]}
  stored  {"revision":"abc","images":["i1"]}          <- the field is simply gone
  own keys of the stored object   [ 'revision', 'images' ]
  stored.polluted                 true                <- read off the plugin's object
  Object.getPrototypeOf(stored) === Object.prototype   false
  truncation                      undefined           <- and nothing was reported
```

THREE DEFECTS IN ONE LINE. (i) The stored object's PROTOTYPE is an object the plugin chose, so every property lookup that misses now consults plugin-controlled data — a `for...in` enumerates it, and a downstream `observed.rollout` can be answered by the executor rather than by the reading. `{"__proto__":null}` is the same defect wearing the other hat: the stored object loses `hasOwnProperty` and every other `Object.prototype` method. (ii) The field is charged and then silently DROPPED — the walk paid for it out of the budget, so the money came off the siblings' share and nothing was stored for it. Measured: two 3 000-character fields at a budget of 4 000, one of them named `__proto__`, stored 1 950 characters of the other and nothing of the first. (iii) The value came back different from the input with `truncation === undefined`, which is exactly the property M23.1g's gate exists to hold — its sweep's shapes simply had no such key.

AND IT IS THE ONLY KEY WITH THE PROPERTY, WHICH IS MEASURED AND NOT ASSUMED. `Object.getOwnPropertyNames(Object.prototype)` has exactly one entry whose descriptor carries a getter or a setter — `__proto__` — and none that is a non-writable data property. So it is the only string key for which `obj[k] = v` differs from defining an own data property. That enumeration is a TEST (`persisted-json-proto.test.ts`), not a sentence here, because it is a claim about the runtime that a future runtime can falsify.

WHY REFUSE IT RATHER THAN STORE IT HONESTLY WITH `Object.defineProperty`. Defining it works — the prototype is untouched, `JSON.stringify` emits it, and a `JSON.parse` round trip through `jsonb` gives an own property back. It was rejected because it does not stop at this row. `observed_state` is served over the public API to the generated SDK, the CLI and `apps/web`, and shipping `"__proto__": {...}` in a JSON response hands every one of those consumers a pollution gadget that fires the moment any of them does `Object.assign({}, observed)` (measured: it pollutes) rather than a spread. A key that is never legitimate observed-executor state is not worth carrying at that price — which is what `qs`, `lodash` and every other library that has met this decided too. The loss is REPORTED (`dropped: true`) rather than silent, which is the difference between this and the defect.

WHERE THE GUARD LIVES: at the two places a plugin-chosen string becomes a computed property key on an object we build — `walkObjectFields`'s phase 1 for the VALUE, and `boundTruncationReport` for the REPORT. Both are the line that has the hazard rather than a filter somewhere upstream of it, because a filter upstream is what the next call site misses. The report needs its own guard for a reason worth naming: the report is keyed by ROOT FIELD NAME, so a refused `__proto__` would otherwise be described BY NAME in a record we then serialise — re-creating the gadget in the field that exists to explain its absence.

## §17. WHAT THE BOUND REMOVED, AS DATA

WHAT THE BOUND REMOVED, AS DATA — M23.1g, and the reason it is a RETURN VALUE rather than something a reader recovers from the stored bytes.
M23.1f turned a verbatim plugin value into one that may be cut, and told nobody outside this package. Everything downstream of it — `packages/schemas`' documented "the opaque stateRef as-is", `PipelineWaveCard`'s "no rollout" — went on describing the old value. An elided `rollout` arrives at the UI as `undefined`, which is the SAME bytes as "this executor reports no rollout", and the card renders the wrong cause. That is the provenance-label defect this repository has already shipped once (charter principle 6): the label named the branch that matched rather than what was true.

THE THREE WAYS A READER COULD BE TOLD, AND WHY THIS IS THE ONE.

```text
(a) LET THE READER PATTERN-MATCH THE MARKERS. Rejected. `apps/web` depends on `@scp/schemas`,
    `@scp/sdk` and `@scp/server` and must not learn this package's sentinels — a UI regexing a
    server sentinel is the UI reimplementing server semantics, against charter principle 3.
    And it does not work even inside the server: `boundTextWithLoss`'s narrow branch
    emits NO marker, and a plugin can put the marker text in a value on purpose.
(b) DERIVE IT AT READ TIME BY COMPARING STORED-TO-ORIGINAL. There is no original — the
    unbounded value never reaches a row, which is the entire point of M23.1f.
(c) HAVE THE FUNCTION THAT DID THE CUTTING SAY SO. This. The counts are free at the cut site
    and unrecoverable anywhere else.
```

THE SIGNAL AND THE BOUND ARE NOT SEPARABLE, BY TYPE. `boundPersistedJson` returns `BoundedPersistedJson`, so there is no way to obtain the bounded value without also being handed the report; a caller that drops it does so visibly, at a named line, and `apps/server/src/coordination/observed-truncation.test.ts` is the gate that a bound applied to an `observed_state` write without emitting the signal fails.

## §18. Keyed by the ROOT FIELD of the bounded value

Keyed by the ROOT FIELD of the bounded value. A value whose root is not a plain object — a bare string, an array — reports under the empty key `""`, meaning "the value itself".

A key is present ONLY when something was removed from that field, so an empty report is never produced: `truncation === undefined` is "nothing was cut", which is the state of every honest reading and costs nothing to store.

## §19. HOW WIDE THE REPORT ITSELF MAY BE

HOW WIDE THE REPORT ITSELF MAY BE. The report is OURS — the counts are integers and `dropped` is a boolean — with exactly one plugin-chosen component: the root field NAMES, each already bounded to `PERSISTED_JSON_MAX_KEY_CHARS` by the walk that stored them. What is NOT bounded by that is HOW MANY of them there are, and a plugin choosing 5 000 root keys is the shape this file already measures elsewhere. So the report is bounded like everything else here — by measurement, not by argument — and the entries that do not fit are replaced by one `PERSISTED_JSON_ELIDED_KEY` entry carrying their count, which is a legal `PersistedJsonFieldTruncation` rather than a shape a schema would refuse.

IT IS NOT TAKEN OUT OF THE VALUE'S BUDGET. The report is a separate return value and its storage is the caller's decision; `wave-targets-repo.ts` reserves for it out of the `observed_state` column policy at the call site, so no arithmetic in this walk changes and no reading loses a character to a report it did not need.

## §20. WHAT AN ARRAY HOLDS BACK FOR ITS OWN TAIL MARKER

WHAT AN ARRAY HOLDS BACK FOR ITS OWN TAIL MARKER — MEDIUM, M23.0 verification pass 11.

`PERSISTED_JSON_MIN_LEAF` says of itself: "Never start a new element/field with less than this much budget left: enough for a short marker and its punctuation, SO THE ELISION ITSELF CAN NEVER BE WHAT PUSHES THE ROW OVER." Measured, the second half of that sentence was false, and it was false for the reason a guard on STARTING an element cannot fix: the element it admits at exactly `PERSISTED_JSON_MIN_LEAF` may spend ALL of it — a string is bounded to whatever is left, by construction — and the marker is then charged against nothing.

array given 160   `[]` 2 -> 158   one string element takes 158 -> 0   marker 28 -> -28

EVERY CUT ARRAY OVERSPENT ITS ALLOCATION BY EXACTLY THE MARKER, and the overspends COMPOUND: a reading with four cut arrays anywhere in it is 112 over, past the single `PERSISTED_JSON_MIN_LEAF` that `boundPersistedJson` reserves for the whole row. What happens then is the worst loss this file can produce — not a truncated list a reader can recognise with `isPersistedJsonEntriesElision`, but the measured backstop discarding the WHOLE value and storing a diagnostic sentence in its place, so `revision`, `images` and `rollout.weight` all vanish together, silently, on every tick.

Measured over 12 000 mixed random shapes at budgets 100…8 000, before this reserve existed:

backstop fired   pass 7: 697/12 000   pass 8: —   pass 9: 30/12 000   pass 10: 238/12 000

i.e. the redistribution rounds pass 10 added made it EIGHT TIMES more likely than pass 9, because a round hands a field a share computed from a pool that the previous round's marker overspends had already eaten. Pass 10's own comment saw the mechanism — "`sub.left` may go slightly negative when a leaf overshoots its own share ... which is what the measured check in `boundPersistedJson` is the backstop for" — and stopped at "the backstop holds", without asking what the backstop DOES when it fires. It throws the row away.

SO THE MARKER IS BOUGHT FIRST. The array subtracts this reserve before any element is offered a character and adds it back at exactly one of two places: to the marker, or — if the list ran to the end and no marker is needed — to the parent, unspent. A complete array therefore costs EXACTLY what it cost before; a cut one holds back the marker's own worst-case price and then spends it on the marker, so the only residue is the digits the real count did not need.

WHY IT IS DERIVED FROM THE MARKER AND NOT `PERSISTED_JSON_MIN_LEAF` SPELLED TWICE. They are different facts that a shared number would fuse: MIN_LEAF is "the least a new element is worth starting", this is "what the marker costs", and 96 is over three times what the marker needs. The difference is not free — a reserve is subtracted from what the ELEMENTS may spend, so an over-sized one comes straight out of retention on exactly the arrays that were already losing their tail. Measured on `imageRefs(400)` beside a revision and a rollout at the 8 000 budget:

```text
  no reserve (the defect)   72 refs kept, `328 more entries`, row 7 870, and 28 OVER
  flat MIN_LEAF reserve     71 refs kept, `329 more entries`, row 7 763
  derived from the marker   72 refs kept, `328 more entries`, row 7 870, and 0 over
```

i.e. deriving it costs this reading NOTHING — the row is byte-identical to the unfixed one — and a flat 96 would have cost it an image ref. Deriving it also cannot go stale: widen the marker's wording and the reserve widens with it, which a hand-tuned constant cannot.

## §21. WHAT ONE FIELD OF AN OBJECT MAY SPEND

WHAT ONE FIELD OF AN OBJECT MAY SPEND — MEDIUM, M23.0 verification passes 8, 9 and 10, and the reason this is a SHARE rather than "whatever is left".

WHAT WENT WRONG, MEASURED. The walk used to spend one budget in INSERTION ORDER: each field took as much as it wanted and, once the remainder fell under `PERSISTED_JSON_MIN_LEAF`, every field still unwalked was replaced wholesale by `PERSISTED_JSON_ELIDED_KEY`. `observedStateFrom` builds `{revision, images, rollout}` in that order, so `rollout` was always the first thing dropped — and `rollout.weight` is the leaf ADR-0028's `minWeight` gate reads. End to end through the fake-executor seam against real Postgres, 80 image refs of ordinary shape (`ghcr.io/acme/platform/service-N@sha256:<64>`) plus a canary at weight 60:

```text
before  images, rollout, revision, observedAt   weight 60     min_weight         satisfied TRUE
after   images, revision, observedAt, __scpElided  undefined  weight_unreadable  satisfied FALSE
```

Threshold: 73 refs. Not hostile input — `status.summary.images` on an Argo CD Application is the uncapped image list across every managed resource, and an umbrella app with 73+ images containing a Rollout is ordinary. A long `revision` does NOT reach it (each string is separately capped at `RUNNER_DETAIL_MAX_CHARS`), so an array is the only route in, which is why READING the code did not surface it.

THE RULE — WATER-FILLING IN TWO PHASES (arrived at over three corrections; pass 10 is this one)
```text
PHASE 1 SEATS THE KEYS AND CHARGES NOTHING ELSE. A key is seated only while
`PERSISTED_JSON_MIN_LEAF` of budget remains available for it AND for every key already
seated. The first key that fails that test turns itself and everything after it into
`PERSISTED_JSON_ELIDED_KEY`.
```

```text
PHASE 2 DIVIDES WHAT IS LEFT EQUALLY BETWEEN THE SEATED FIELDS, walks all of them, and then
RE-DIVIDES what the satisfied ones did not want between the ones that are still short,
repeating while somebody finishes. That is max-min fairness: at the end every field is either
SATISFIED (it took less than its share and kept everything) or holds an EQUAL share of what the
satisfied fields left behind. Neither outcome can be influenced by where a field sits.
```

WHY PASS 2 EXISTS, MEASURED (pass 9). Pass 8 shipped phase 1 alone, as a CEILING with no way back, and a ceiling throws away whatever the small fields do not want. `observedStateFrom` puts `images` in the MIDDLE of `{revision, images, rollout}`: `images` was capped at ~1/2 the budget while `revision` + `rollout` spent ~110 of the ~3 950 they were handed, and those ~3 840 characters were never returned. End to end through the fake-executor seam against real Postgres, 40 refs — a case that had NEVER been broken, because at 40 refs the pass-8 defect did not bite:

```text
pass 7 (one budget)        40/40 images kept   row 4 659   resolveReleasedVersion  determined
pass 8 (share as ceiling)  34/40 images kept   row 4 063   resolveReleasedVersion  REFUSED
pass 9 (redistribution)    40/40 images kept   row 4 659   resolveReleasedVersion  determined
```

For every n in 35…69 that was a strict loss with no compensating benefit, and the loss is the fail-SILENT one: a coordinate whose ref fell past the cut yields `observed_images_elided`, `latest_version` is never determined and dependants are never bumped.

WHY THE KEYS ARE CHARGED FIRST — HIGH, PASS 10. IT IS THE WHOLE OF PROPERTY (2).
Passes 8 and 9 walked field `i` against `floor(left / n)` where `left` was the budget REMAINING at that point in a single in-order loop. Two order-dependent consequences followed, and neither is visible in the row's LENGTH: a field that underspent raised every LATER field's share, and the LAST field was handed the entire remainder rather than a share at all. Measured on `{a: 4 000-char string, b: 4 000-char string, phase, step}` over all 24 permutations, on pass 9 plus this round's `boundStringToCost` correction:

```text
a 3 858 / b 4 000    4 orders                        row 7 904
a 3 929 / b 3 929   16 orders   <- the fair answer    row 7 904
a 4 000 / b 3 858    4 orders                        row 7 904
```

The ROW IS THE SAME SIZE in all three, so no length or utilisation assertion can see it, and each is a different answer to "how much of `a` survived". The reorder alternative below is rejected BECAUSE it makes source-line order a load-bearing contract — a rejection this design has to earn rather than assert. Charging the keys up front is what earns it: the sum of the key costs is the same in every permutation, so the pool phase 2 divides is a FIXED number, and phase 2 never reads `budget.left` again. All 24 permutations are now byte-identical, pinned by `persisted-json-bound.test.ts` -> "ORDER-INDEPENDENT RETENTION ... TWO TRUNCATED STRINGS".

A `PERSISTED_JSON_MIN_LEAF` FLOOR, WHICH PASS 9 DELIBERATELY DID NOT HAVE. REVERSED, WITH THE MEASUREMENT THAT REVERSED IT.
Pass 9 argued that an equal SLIVER is order-independent at every budget while a floor re-creates insertion-order starvation at a tighter budget. The first half is true and the second half is what phase 1 now owns; what the argument missed is what a sliver actually stores. Charging the keys first makes it visible — 5 000 fields of `"v".repeat(50)` at the 8 000 budget:

```text
sliver (pass 9)   792 fields seated, every one of them the EMPTY STRING, row 7 844
floor  (pass 10)    76 fields seated, every one of them its whole 50-character value
```

`"k123": ""` in a governed row does not read as "this was cut". It reads as an observation — the executor reported an empty value — which is the provenance-label defect this repository has already shipped once (charter principle 6). `__scpElided: "4924 more fields"` says what actually happened. A floor is therefore the honest rule, and phase 1 applies it to the KEY SEATING rather than to the share, which is what keeps it from being insertion-order starvation: the decision reads key costs ONLY and never looks at a value, so property (1) is now strictly true — a key is never elided because a SIBLING'S VALUE was large, at any budget.

ITS RESIDUE, STATED. The seated set is a PREFIX in insertion order, so when the fields differ wildly in what they NEED — a 5 000-character key, or a value too big to price against a tiny one — which ones are seated still varies with order. Pinned as a bound rather than left to be discovered: `persisted-json-bound.test.ts` -> "WHAT A FIELD NEEDS, NOT A FLAT 96".

THE PROPERTIES, STATED SO A REVIEWER CAN FALSIFY THEM.
```text
(1) NO OBJECT KEY IS ELIDED FOR ROOM A SIBLING DOES NOT NEED. A key can still be elided when
    an object has more keys than the budget can seat — but the price of a seat is
    `admissionCost`, i.e. `PERSISTED_JSON_MIN_LEAF` for a value too big to price
    and the value's EXACT cost for anything smaller, so the elision says something true about
    the content rather than about a constant. It is visible in the row as `__scpElided`.
```

```text
    RESTATED AT PASS 12, AND WEAKER ON PURPOSE. Passes 10 and 11 said "never because a
    SIBLING'S VALUE was large", which was true because every field reserved the same 96
    whatever it held — and that flat reserve is what elided keys with nothing behind them:
    200 fields of `"v"` seated 71 and a marker, at 8 000, for 4 091 characters of content.
    They now all seat, and the row is byte-identical to the input. The new rule reads values,
    so a large sibling CAN now be the reason a later key is elided — but only for room it
    genuinely needs, and the seated set is a SUPERSET of the flat rule's at every budget,
    because `admissionCost <= PERSISTED_JSON_MIN_LEAF` always. A key the old rule seated is
    never elided by the new one. Pinned by `persisted-json-bound.test.ts` -> "WHAT A FIELD
    NEEDS, NOT A FLAT 96".
(2) RETENTION DOES NOT DEPEND ON INSERTION ORDER — not just which keys survive, but how much of
    each survives, byte for byte. Pass 8 failed this on array contents (the same three fields
    kept 26, 39 or 77 of 80 image refs depending only on where `images` sat); pass 9 failed it
    on string contents (the 24-permutation table above). Pinned over all six permutations of a
    3-field object AND all 24 of a 4-field one, with an ARRAY-shaped large field and with
    STRING-shaped ones, by `persisted-json-bound.test.ts`. The one carve-out is the key-length
    residue named above.
(3) BUDGET UTILISATION. A value that overflows BECAUSE A FIELD WANTED MORE THAN ITS SHARE
    leaves at most one field's worth of the budget unspent, rather than a fixed fraction of it.
    Measured at the 8 000 budget: 400 image refs beside a revision and a rollout spend 7 870;
    two 4 000-character strings beside two small fields spend 7 904; a single string field at
    budget B spends exactly `B - PERSISTED_JSON_MIN_LEAF` — exactly, for a string of ordinary
    characters, at every integer B. STATED NO MORE STRONGLY THAN THAT LAST CLAUSE ALLOWS: an
    ESCAPED string lands a few characters short of the figure, because the width that fits is
    found by bisection over whole characters and one more character costs 2 (a backslash or a
    quote) or 6 (a C0 control). Measured over every B in 200…4 000: 0 short for ASCII and for
    astral characters, at most 1 for backslashes and quotes, at most 5 for C0 controls.
```

```text
    NARROWED, BECAUSE MEASUREMENT FALSIFIES THE UNQUALIFIED FORM. In the ELISION regime —
    phase 1 could not seat every key — phase 1 has reserved `admissionCost` for each key
    it DID seat, and a field that turns out to want less than that leaves the difference
    unspent. Pass 10 reserved a flat `PERSISTED_JSON_MIN_LEAF` instead and paid 4 554 of
    8 000 (57 %) for it on its own worst shape — 50 keys of 5 000 characters with
    one-character values. Pricing the seat closes that gap without reintroducing the sliver:
```

```text
        pass 9 sliver rule   6 651 / 8 000 (83 %)   every seated field the EMPTY STRING
        pass 10 flat floor   4 554 / 8 000 (57 %)   every seated field its whole value
        pass 12 priced seat  6 651 / 8 000 (83 %)   every seated field its whole value
```

```text
    i.e. the residue the floor cost is gone and what the floor BOUGHT is kept. It is pinned as
    a FLOOR ON UTILISATION by `persisted-json-bound.test.ts` -> "THE ELISION REGIME'S
    UTILISATION RESIDUE", so it cannot silently regrow.
```

THE TWO ALTERNATIVES AND HOW THEY FAIL. (a) ORDER `rollout` BEFORE `images` in `observedStateFrom`: makes source-line order in an unrelated function a load-bearing contract, which the next person reorders innocently, and it fixes only the one pair we happen to know about today. Property (2) is what earns this rejection — pass 8 and pass 9 each rejected the alternative on a disease their own design still had, which is why (2) is now pinned byte-for-byte by tests rather than asserted in a comment. (b) RESERVE A SHARE FOR NAMED CRITICAL LEAVES: explicit, but the list of names is exactly the per-field census that finding M2 replaced this walk with — `ExecutionStatus.observed` is documented as "optional and additive", so the list goes stale on the day an executor contributes the next signal a gate reads. A share is a property of the WALK: it protects a field nobody has written yet.

WHAT IT STILL COSTS, STATED. A very large array can keep slightly fewer entries than a single-budget walk kept, because the guaranteed shares of its siblings are spent before it is offered the remainder. The gap is bounded by what the siblings actually spend (~110 characters for `observedStateFrom`'s reading), not by their share. Readers can now tell a cut from an absence (`isPersistedJsonEntriesElision`), rather than a whole sibling key vanishing silently.

ARRAYS ARE NOT FAIR-SHARED, and that is the point rather than an omission. An object's keys are different facts for different readers; an array's entries are instances of ONE kind, and cutting the tail off a list is an honest degradation while cutting each ELEMENT in half is corruption — a half-written `ghcr.io/acme/api@sha256:…` still parses, into a repository and a digest that name bytes nobody deployed. So arrays keep spending in order and truncating the tail.

HOW MANY TIMES THE UNSPENT REMAINDER IS RE-OFFERED. Each round finalises every field that no longer clips at the bigger share and re-walks only the rest; the cap exists so a pathological object (5 000 fields of geometrically increasing size) cannot turn a per-row bound into O(n²) walks. Reaching the cap is not a correctness failure — it leaves budget unspent, which is the direction that only costs retention.

WHY FIVE, MEASURED — M23.0 verification pass 14, and the reason the number is no longer a guess. It was 4, and the sentence above used to go on "the useful work is done in one or two rounds for any shape this file actually sees". Both halves were measured and both were wrong. Instrumenting the loop to record the round it REACHES, over 182 365 (shape, budget) pairs — ladders of strings, geometric fields, ladders of lists and of objects, nested objects to depth 4, and a 400-image Argo CD reading — 5 290 pairs run four rounds and 527 run FIVE. So 4 was truncating the loop on real work. What that cost, against a 64-round ceiling over the same family:

```text
  rounds   retention vs the ceiling   worst single shortfall
       1          -29.04 %                 5 350 characters
       2           -0.5999 %                 181
       3           -0.0466 %                  41
       4           -0.0028 %                  19
       5            0        %                   0
       6, 8, 64     0        %                   0
```

FIVE IS THE FIXED POINT, and that is the property the number is chosen for rather than a round figure: it is the SMALLEST cap at which raising it further changes no output anywhere in the family. So a mutation that lowers it is detectable and one that raises it is not — which is the shape a well-chosen cap should have, and the opposite of what 4 had, where BOTH directions were detectable and the upward one meant the constant was simply too small. Pinned by `persisted-json-bound.test.ts` -> "FIVE ROUNDS IS THE FIXED POINT".

## §22. AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED

AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED — HIGH, M23.0 verification pass 13, a REGRESSION introduced by pass 12's own fix, and the sixth consecutive round whose fix created the next defect.

WHAT PASS 12 CHANGED. A seat used to cost a flat `PERSISTED_JSON_MIN_LEAF`; it now costs `admissionCost` — the value's exact rendered cost when that is under 96. Pass 12 argued the change was safe in one direction only: "`admissionCost <= PERSISTED_JSON_MIN_LEAF` by construction, so the change can only admit content the old rule refused." That is true, and it is a statement about the SEATED SET. The flat 96 was never only a price. It was also the GUARANTEE that every seated field would be handed at least 96 characters in phase 2 — which is exactly what `PERSISTED_JSON_MIN_LEAF`'s own comment says it is for: "enough for a short marker and its punctuation". A well-written comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md); pass 12 REWROTE that comment and swept the three places the 96 was CHARGED, missing the places the reserved characters were SPENT.

WHAT BROKE. Phase 1 promises field `i` exactly `need_i` characters and charges the budget for them. Phase 2 then ignores the promise and hands every pending field `floor(pool / n)`. Under the flat rule the split could fall below 96 too, but 96 covers every marker this file can emit, so nothing overspent. Under the exact rule a field can be offered LESS than the value it was seated for costs — and a value that no longer fits emits a marker that was never costed: `[elided: N more entries]` is 26 rendered characters where the list it replaces was 5.

The overspends compound across siblings and the row goes over. Measured, `{k0..k4: ["a"]}` — five one-element lists, 56 characters — at a budget of 143:

```text
  phase 1 seats k0..k3 (need 5 each), refuses k4, and charges 30 for `__scpElided`
  pool -8  ->  share 0  ->  each surviving list renders `["[elided: 1 more entries]"]`
  row 167 of a 143 budget  ->  THE BACKSTOP DISCARDS THE WHOLE VALUE
```

and that is the worst loss this file can produce — `revision`, `images` and `rollout.weight` gone together, replaced by a diagnostic sentence, silently, on every tick. Measured over 197 934 (shape, budget) pairs of one-element and five-element lists at widths 3…400:

```text
  pass 11 (bcabfdf3^)   0 / 197 934 discarded
  pass 12 pre-fix       0 / 197 934 discarded
  pass 12 as shipped    34 900 / 197 934 discarded, at budgets up to 13 981
```

IT REACHED THE PRODUCTION BUDGET. `{300 fields, each a five-element list}` — 8 591 characters — was discarded WHOLESALE by `boundPersistedJson(value)` with no explicit budget at all, storing 145 characters of apology in place of the reading. Six of twenty-two straightforward per-resource shapes did the same at the default 8 000.

THE FIX IS THE PROMISE, KEPT. A field is offered `max(share, need)`. It cannot overspend the pool, because `need` is only below `PERSISTED_JSON_MIN_LEAF` when it is the value's EXACT total cost — such a field spends `need` however large a share it is given, and phase 1 already proved `pool >= sum(need)`. A field whose `need` is the capped 96 spends at most its share, and `pool >= 96 x (capped fields)` by the same invariant. So `sum(spend) <= pool` at every round.

WHY ELEVEN PASSES OF RANDOM FUZZING WOULD NEVER HAVE FOUND IT, and what to do instead. The defect needs a budget in a NARROW BAND relative to one specific structure: phase 1 must refuse exactly enough fields for the `__scpElided` charge to drive the pool under what the survivors were seated for. 6 000 random shapes — widths to 25 x 60, depth 10, arrays to 120, bigints, functions, over-long and colliding keys — found ZERO instances against the broken build. The corpus that finds it is a DENSE BUDGET SWEEP over a structured family, which is what `persisted-json-bound.test.ts` -> "A SEAT PHASE 1 PAID FOR IS A SHARE PHASE 2 MUST HONOUR" is. Randomness is the wrong instrument for a defect whose trigger is an arithmetic coincidence.

## §23. REFUSED FOR SAFETY, NOT FOR ROOM

REFUSED FOR SAFETY, NOT FOR ROOM — see `isUnsafePersistedKey`. Charged nothing, because nothing is stored; counted as a dropped field, because one is. Tested on the BOUNDED key and not the raw one: `boundStringToCost`'s narrow branch keeps the END of an over-long key, so a 300-character key ending in `__proto__` bounds to exactly `__proto__` at a tight budget. A guard on the raw key would pass it straight through.

## §24. BOUND `text` SO ITS RENDERED COST FITS `left`

BOUND `text` SO ITS RENDERED COST FITS `left`. `boundText` bounds the CHARACTER count; `left` is measured in RENDERED characters, and the difference is the two quotes `JSON.stringify` always adds plus whatever the escapes cost. So the widest attempt overshoots by construction, and the width that fits has to be found by MEASURING rather than by guessing.

SEARCH FOR THE WIDEST WIDTH THAT FITS; DO NOT HALVE — MEDIUM, M23.0 verification pass 10. This function used to shrink the width by HALF on every miss, and said of itself that it "halves until the ESCAPES fit ... the worst escape expansion is 6x". That is not the case it fires on. For ANY unescaped string — every image ref, digest, revision, URL and branch name a real executor reports — the first attempt overshoots by exactly TWO characters, the quotes, and halving then threw away half the budget to recover them. Measured, against a text longer than the budget:

```text
  left    halving stores/renders    search stores/renders    utilisation
   400          200 / 202                 398 / 400            50.5 %  ->  100.0 %
  1000          500 / 502                 998 / 1000           50.2 %  ->  100.0 %
  2634         1317 / 1319               2632 / 2634           50.1 %  ->  100.0 %
  3900         1950 / 1952               3898 / 3900           50.1 %  ->  100.0 %
```

A WELL-WRITTEN COMMENT NAMING A HAZARD IS A SIGNAL TO SWEEP, NOT EVIDENCE IT WAS HANDLED (CLAUDE.md). The escape hazard the old comment named is real — a backslash doubles, a C0 control sextuples — and halving was not serving THAT case either, because a power of two is not where the boundary sits for any particular escape density:

```text
  backslashes, left 3900   halving 1950 / 3873    search 1963 / 3899
  C0 controls, left 3900   halving  487 / 2779    search  673 / 3895   <- 71 % -> 99.9 %
```

IT IS THIS FAMILY OF ROUNDS' OWN DEFECT, not a pre-existing one. While a field could take the whole budget the loop ran once and returned (`min(4000, 7902)` renders to 4 002 <= 7 902), so the shrink never fired. It went live the moment `walkObjectFields` started handing each field a SHARE — a share is exactly the regime where the first attempt misses. And nothing recovers it downstream: the field is still `clipped`, so the water-filling loop re-offers it a larger share and the same halving throws away half of THAT too.

WHY A SEARCH AND NOT A CORRECTION TERM. Correcting the width by the measured overshoot collapses to nothing on a 6x string (the overshoot exceeds the whole width); correcting it by the measured RATIO converges in two steps but is not monotone, and a 20 000-case differential fuzz found 625 inputs where it stored LESS than halving and one where it ran out of attempts and stored nothing. A bisection has none of those failure modes: it terminates in at most `log2(4000)` ~ 12 steps, and every value it returns has been MEASURED to fit — which is the same discipline `boundPersistedJson` applies to the whole row. The same fuzz over the same 20 000 inputs (ASCII, backslash, quote, C0-control and astral alphabets, budgets 0…5 000): zero over budget, zero worse than halving, zero cases where halving found something and the search did not.

The first call is the FAST PATH and is the only one a string that already fits ever makes.

## §25. THE BACKSTOP'S OWN REPORT

THE BACKSTOP'S OWN REPORT — and it is the one the reader needs most, because the backstop is the worst loss this file can produce: `revision`, `images` and `rollout.weight` gone TOGETHER, replaced by a diagnostic sentence. Before this, that arrived at an operator as three fields the executor apparently never reported.

Every root field is `dropped`, because every root field is. The walk's own per-field accounting is deliberately NOT reused here: it describes a value that was measured over budget and thrown away, i.e. a value nobody will ever read.

## §26. MEASURED, NOT ARGUED

MEASURED, NOT ARGUED — the same discipline `boundPersistedJson` applies to the value. A report that could itself grow without limit would be a second unbounded plugin-influenced write on the same row, which is the finding this whole family of rounds started from.

The entries that do not fit become ONE `PERSISTED_JSON_ELIDED_KEY` entry carrying their count. That is a legal `PersistedJsonFieldTruncation`, so a schema over `Record<string, PersistedJsonFieldTruncation>` still validates the report — the alternative, a bare marker string in a record of objects, is a shape the response serializer would refuse and therefore a stall.

## §27. HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD

HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD — MEDIUM, M23.0 verification pass 7 finding M1, and the half of the 1.44 GB/day class the previous round did NOT fix.

BOUNDING ONE ENTRY DID NOT BOUND THE MAP. Every managed executor caches `{succeeded, detail}` per `idempotencyKey` so a re-`trigger()` cannot re-run a completed job, and NONE of the three pruned anything, ever. Measured on managed-iac at 500 keys: `bytes=2074290  bytesPerKey=4149`, i.e. the per-entry bound is doing its job and the map is still unbounded because the map is a different quantity. Worse for the DURABLE one: `loadState` `JSON.parse`s the whole file on EVERY `status()` poll and `saveState` rewrites it whole on every `trigger()` — O(total history ever) per poll, forever, on a loop that ticks every second.

THE RETENTION RULE, AND WHY IT IS SAFE. Oldest-first, keeping the most recent `max` entries. What an entry has to outlive is short and knowable: `trigger()` in all three plugins runs the job SYNCHRONOUSLY to completion before writing the entry, so by the time an entry exists the work is already done and the only remaining reader is `reconcile.ts`'s next `status()` poll — under two seconds away — plus a crash-and-retry window in which reconcile re-issues the SAME `idempotencyKey`. Dropping an entry that a retry then asks for is the one real hazard (it means a second run of a job that already ran), so the caps below are set orders of magnitude above the number of runs that can physically be in flight, not at the smallest value that would "work".

AND THE DURABLE CACHE GETS A SMALLER CAP THAN THE IN-MEMORY ONES, which is the whole reason this is a parameter rather than a constant: managed-iac re-reads and re-parses its entire file on every poll, so its size is a per-poll CPU cost as well as a disk cost, while managed-scan's and managed-dep's `Map.get` is O(1) and their size is only memory. The two are not the same tradeoff and pretending they were would either waste memory or re-introduce the parse cost.

## §28. The transient `--env-file`

The transient `--env-file`. Mode 0600, under the CALLER's own governed state dir, and unlinked the instant `create` returns — see `RunnerSpec.secretEnv` for exactly how partial a fix this is, and for what happens when the process is killed before that unlink runs.

`wx` refuses an existing file rather than truncating one: the path carries a fresh UUID, so an existing file at it means something is very wrong and writing a credential into it is the last thing to do.

## §29. IS THE BUDGET GONE?

IS THE BUDGET GONE? — the ONE way anything in this package asks that question, and the reason it is a method rather than a `Date.now() >= deadline.at` at each site.

THREE SITES ASKED IT RAW AND ALL THREE WERE WRONG THE SAME WAY. A budget kill is a libuv timer; the deadline is `Date.now()`; the two clocks disagree by up to a millisecond, so a step killed BY ITS OWN DERIVED TIMEOUT could arrive at its `catch` with `Date.now()` still one millisecond short of the deadline that timeout came from. The Docker adapter then reported `deadlineExceeded: false` for a kill that was purely its own budget — `exit-nonzero`/`signalled` instead of `budget-exhausted`, which is a verdict about the TENANT'S runner for something the launcher did. Measured: 1 run in 20 of the full launcher suite, and a different arm of `whole-run-budget.test.ts` each time.

SO THE ANSWER IS THE SAME ONE `spend` REFUSES ON — `RUNNER_MIN_STEP_BUDGET_MS` — and it is defined once. "Enough left to refuse a step on" and "enough left to call this our deadline" cannot be two different questions: they are the same instant, and asking them with two expressions is how they came to disagree by a millisecond.

## §30. REFUSE, BOUND, OR ABANDON

REFUSE, BOUND, OR ABANDON — the three-way decision every step of every adapter goes through, written once.

- nothing left -> a `RunnerLaunchError` with `deadlineExceeded`, and the step is NEVER ISSUED. `timeout: 0` is no timeout at all in Node and a negative one throws synchronously with an unredacted argv in the message, so the refusal is the part with the teeth. - otherwise -> `work` is handed what remains and raced against `RUNNER_STEP_ABANDON_GRACE_MS` past it. - work rejected on its own -> the rejection is RE-THROWN RAW, because the two adapters shape a step failure differently (Docker keeps Node's `code`/`killed`/`signal` and replaces only the message; Kubernetes builds a fresh cause from an HTTP status) and normalising that here would silently rewrite four goldens. Callers therefore re-throw a `RunnerLaunchError` they receive unchanged — it is already this port's own verdict.

## §31. THE DOCKER ADAPTER

THE DOCKER ADAPTER — `create` / `cp` in / `start -a` / `cp` out / `rm -f`, reproducing what the three plugins each did, byte for byte. Every argv string and every options object below is what the three `launch-argv.golden.test.ts` files recorded BEFORE this package existed; those goldens are the proof, and they were not edited to make this pass.

Never a `-v` bind mount, never a docker socket, always the caller's resolved `--network`: a host-path escape stays structurally impossible because nothing is mounted, only copied.

## §32. See {@link RunnerLauncher.reap}

See `RunnerLauncher.reap`. Lists every container THIS PACKAGE labelled (any owner), then removes exactly the ones that are BOTH foreign (owner != `LAUNCHER_OWNER_ID`) AND past their deadline. A container with a missing or unparsable deadline is left alone — the same fail-closed direction as everything else in this file: an ambiguous label must never read as "safe to destroy".

## §33. THE WHOLE-RUN DEADLINE

THE WHOLE-RUN DEADLINE — the one clock in this function, read once and never recomputed. See `RunnerSpec.timeoutMs`: the budget is for the RUN, not for each of the four-to-six `execFile`s a run issues, and the ONLY reason the host's RPC budget and the container's own reap stamp are now correct is that this line makes them derivable.

IT IS THE PORT'S OBJECT, NOT THIS ADAPTER'S ARITHMETIC (M23.5). The refusal, the `Math.max(1, …)` and the bound handed to each step all live in `createRunDeadline` now, for one reason: this adapter got that arithmetic right and the SECOND adapter got two thirds of it right, which is what an invariant re-implemented per adapter is worth.

## §34. BOUNDED BEFORE `record` EVER SEES IT

BOUNDED BEFORE `record` EVER SEES IT. A thrown `Error`'s `.message` is freeform text this package did not compose — a `docker create` rejection carries the whole of stderr in it — and `record` writes to a store that is never pruned. Redact, then bound; both are the plugin's store's problem and neither is optional. `boundDetail` keeps the END, so the reason the throw happened survives the bound.

## §35. THE SECOND ADAPTER

THE SECOND ADAPTER (M23.2). Re-exported from the package entry point rather than reached by a subpath, because `package.json` declares only `main: dist/index.js` — a subpath would be a new packaging surface for one import. The re-export sits at the BOTTOM and `kubernetes-adapter.ts` imports only FUNCTIONS and CONSTANTS from here, so the module cycle resolves: nothing in that file reads a binding of this one at module-evaluation time. `kubernetes-adapter.test.ts`'s first case imports the package entry and calls `resolveRunnerLauncher`, which is what would fail loudly if that ever stopped being true.

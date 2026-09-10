# runner-launcher

Long-form reference for the **runner-launcher** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 434 of 434 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/runner-launcher/src/adversarial-corpus.ts`](#packages-runner-launcher-src-adversarial-corpus-ts) — §1–§3
- [`packages/runner-launcher/src/docker-adapter.test.ts`](#packages-runner-launcher-src-docker-adapter-test-ts) — §4–§34
- [`packages/runner-launcher/src/failure-detail-bound.test.ts`](#packages-runner-launcher-src-failure-detail-bound-test-ts) — §35–§42
- [`packages/runner-launcher/src/index.ts`](#packages-runner-launcher-src-index-ts) — §43–§175
- [`packages/runner-launcher/src/kubernetes-adapter.kind.test.ts`](#packages-runner-launcher-src-kubernetes-adapter-kind-test-ts) — §176–§199
- [`packages/runner-launcher/src/kubernetes-adapter.test.ts`](#packages-runner-launcher-src-kubernetes-adapter-test-ts) — §200–§234
- [`packages/runner-launcher/src/kubernetes-adapter.ts`](#packages-runner-launcher-src-kubernetes-adapter-ts) — §235–§309
- [`packages/runner-launcher/src/kubernetes-launch.golden.test.ts`](#packages-runner-launcher-src-kubernetes-launch-golden-test-ts) — §310–§315
- [`packages/runner-launcher/src/kubernetes-rbac-contract.test.ts`](#packages-runner-launcher-src-kubernetes-rbac-contract-test-ts) — §316–§320
- [`packages/runner-launcher/src/module-load.integration.test.ts`](#packages-runner-launcher-src-module-load-integration-test-ts) — §321–§321
- [`packages/runner-launcher/src/no-docker-on-kubernetes.test.ts`](#packages-runner-launcher-src-no-docker-on-kubernetes-test-ts) — §322–§324
- [`packages/runner-launcher/src/no-spawn-on-kubernetes.behaviour.test.ts`](#packages-runner-launcher-src-no-spawn-on-kubernetes-behaviour-test-ts) — §325–§329
- [`packages/runner-launcher/src/ordering-conformance.ts`](#packages-runner-launcher-src-ordering-conformance-ts) — §330–§338
- [`packages/runner-launcher/src/outcome-cache-bound.test.ts`](#packages-runner-launcher-src-outcome-cache-bound-test-ts) — §339–§339
- [`packages/runner-launcher/src/persistable-detail.test.ts`](#packages-runner-launcher-src-persistable-detail-test-ts) — §340–§346
- [`packages/runner-launcher/src/persisted-json-bound.test.ts`](#packages-runner-launcher-src-persisted-json-bound-test-ts) — §347–§374
- [`packages/runner-launcher/src/persisted-json-budget-sweep.test.ts`](#packages-runner-launcher-src-persisted-json-budget-sweep-test-ts) — §375–§378
- [`packages/runner-launcher/src/persisted-json-proto.test.ts`](#packages-runner-launcher-src-persisted-json-proto-test-ts) — §379–§382
- [`packages/runner-launcher/src/persisted-json-truncation.test.ts`](#packages-runner-launcher-src-persisted-json-truncation-test-ts) — §383–§387
- [`packages/runner-launcher/src/port-deadline.test.ts`](#packages-runner-launcher-src-port-deadline-test-ts) — §388–§394
- [`packages/runner-launcher/src/reaper-integration-child.ts`](#packages-runner-launcher-src-reaper-integration-child-ts) — §395–§395
- [`packages/runner-launcher/src/reaper.integration.test.ts`](#packages-runner-launcher-src-reaper-integration-test-ts) — §396–§403
- [`packages/runner-launcher/src/recorded-outcome.test.ts`](#packages-runner-launcher-src-recorded-outcome-test-ts) — §404–§407
- [`packages/runner-launcher/src/secret-env-leak-integration-child.ts`](#packages-runner-launcher-src-secret-env-leak-integration-child-ts) — §408–§408
- [`packages/runner-launcher/src/teardown-model.test.ts`](#packages-runner-launcher-src-teardown-model-test-ts) — §409–§411
- [`packages/runner-launcher/src/test-support/yield-between-tests.ts`](#packages-runner-launcher-src-test-support-yield-between-tests-ts) — §412–§414
- [`packages/runner-launcher/src/whole-run-budget.test.ts`](#packages-runner-launcher-src-whole-run-budget-test-ts) — §415–§428
- [`packages/runner-launcher/vitest.config.ts`](#packages-runner-launcher-vitest-config-ts) — §429–§432
- [`packages/runner-launcher/vitest.integration.config.ts`](#packages-runner-launcher-vitest-integration-config-ts) — §433–§433
- [`packages/runner-launcher/vitest.kind.config.ts`](#packages-runner-launcher-vitest-kind-config-ts) — §434–§434

## `packages/runner-launcher/src/adversarial-corpus.ts`

### §1. THE ADVERSARIAL CORPUS

THE ADVERSARIAL CORPUS — ONE TABLE, TWO LAYERS

WHY IT IS A MODULE AND NOT A CONST IN A TEST FILE (M23.1f clause 4). Every one of these shapes was asserted only against PROXIES — `isWellFormed()`, "no NUL", "under 8,000 characters" — in a pure unit test with no database anywhere near it. The clause the corpus exists to satisfy is "zero rows refused by a REAL Postgres", and the non-vacuity control for it is "the PRE-BOUND shape IS refused", which only a real server can answer. Two tests in two packages need the same table, and a second copy of it is a copy that goes stale in the direction that matters: the layer that gets the new hostile shape is the one whose author was thinking about it.

`persisted-json-bound.test.ts` reads it for the proxies, cheaply, on every PR; `apps/server`'s `persisted-json-postgres-corpus.integration.test.ts` reads it for the real answer.

EVERY ONE OF THESE IS SOMETHING AN `ExecutionStatus` OFF THE JSON-RPC BOUNDARY CAN ACTUALLY BE: the plugin host types that response with a BARE CAST — `call<ExecutionStatus>("status", …)` — with no runtime validation anywhere on the path, so "the plugin promised a `string[]`" is not a fact.

### §2. LAYER 2 — THE ALPHABETS THE PROXIES CANNOT SEPARATE

LAYER 2 — THE ALPHABETS THE PROXIES CANNOT SEPARATE (M23.1f clause 4)
The table above was built against the proxies: `isWellFormed`, no-NUL, under budget. These were built against the QUESTION — "is there a byte sequence a bounded value can still carry that PostgreSQL's `jsonb` input refuses?" — and each names the specific refusal it is probing for. Measured against real PostgreSQL 16: 0 of the whole corpus refused after the bound; 9 of it refused BEFORE, split `unsupported Unicode escape sequence` and `invalid input syntax for type json`.

### §3. A key and a value that are the bound's OWN markers

A key and a value that are the bound's OWN markers: a round trip must not read them as a cut. THE LITERAL, NOT THE CONSTANT, AND DELIBERATELY. Importing `PERSISTED_JSON_ELIDED_KEY` from `./index.js` makes a module cycle — `index.ts` re-exports this file — and a cycle here resolves to `undefined` at module-evaluation time, which turns the whole corpus into an empty array in any consumer that imports it through the package entry. That is a vacuous sweep with no symptom. `persisted-json-bound.test.ts` asserts this literal still equals the constant.

## `packages/runner-launcher/src/docker-adapter.test.ts`

### §4. The Docker adapter's own conformance suite

M23.1 — THE DOCKER ADAPTER'S OWN CONFORMANCE SUITE

WHY THIS FILE EXISTS. `packages/runner-launcher` is, since M23.1, THE ONLY PLACE IN THE PRODUCT THAT SPAWNS A PROCESS. Before this file it had **no tests of its own**: every byte of its behaviour was borrowed from the three plugins' `launch-argv.golden.test.ts`, and its `package.json` said `vitest run --passWithNoTests`, so `turbo run test --filter=@scp/runner-launcher --force` printed "No test files found" and reported SUCCESS. Those two facts together were a primed time bomb: the goldens still carried M23.0's own instruction that they be "deleted or superseded by the port's own conformance suite" once the port landed, so a later increment could follow that instruction to the letter and take coverage of the only process-spawning code in the product to zero **in one commit, with every task still green**. That is exactly the vacuous-green class BUILD_AND_TEST.md §4.4 and CLAUDE.md name. This file is the conformance suite that sentence promised; `--passWithNoTests` is gone from this package in the same change, so an empty package now FAILS instead of reporting success.

WHAT IT PROVES, AND WHAT IT DELIBERATELY DOES NOT. It drives `createDockerRunnerLauncher` **directly**, over the same spec shapes the plugin goldens cover (6 iac + 6 scan + 5 dep = 17 as of this writing; this comment and BUILD_AND_TEST.md have each gone stale on this exact number more than once, which is why the count now lives in a gate — `packages/source-census/src/golden-count-gate.test.ts` — rather than in a THIRD place prose has to remember to update), and asserts the **recorded argv ARRAY** of every `execFile` — never a call count, never `expect.arrayContaining`. A renamed binary, a reordered flag, a dropped operand or a `cp` that lost its trailing `/.` must fail here, and must fail by printing the actual argv next to the expected one.

It does NOT prove that any plugin still hands this adapter the right `RunnerSpec` — a spec is this suite's INPUT, not its subject, so a plugin that silently started passing `when: "on-success"` where it used to pass `"always"` would produce a perfectly conformant launch of the wrong shape and nothing here would notice. That other half is the three goldens' job, which is why M23.1 did not retire them and why their headers now say so.

WHAT IS PINNED: 1. THE FULL FIVE-STEP argv — `create` (with `--network`, each `-e` pair, the image, the operands), each `cp` IN in the caller's order, `start -a`, the `cp` OUT, and `rm -f`. 2. THE OPTIONS OBJECT alongside each argv, asserted with `toStrictEqual` so that the ABSENCE of `maxBuffer` on `rm` — and the absence of any `cwd`/`env` anywhere — is part of the record rather than merely untested. The three callers' pairs (10 min/16 MiB, 10 min/32 MiB, 5 min/8 MiB) are driven as data: a port that collapsed them into one shared default would be a behaviour change wearing a refactor's clothes, and this is where that is caught. 3. BOTH AXES OF THE COPY-OUT, independently: `when` (`always` vs `on-success`) and `onFailure` (`swallow` vs `propagate`). All FOUR combinations of the two axes are exercised — including `{on-success, swallow}`, which no real caller pairs (managed-iac is `{always, swallow}`; managed-scan and managed-dep are both `{on-success, propagate}`) and which this file left unconstructed until it was found missing: a gate keyed on the wrong axis (`onFailure` instead of `when`) passed every case that DID exist and copied evidence out of a failed run. 4. THE FAILURE PATHS — a rejected `start` (captured, not rethrown), a rejected `cp` in, a rejected `rm` (swallowed), and — since M23.0's defect 1 was fixed — that a rejected `create` STILL tears down the NAME the caller chose. That last one was the opposite assertion until this milestone; it is INVERTED and renamed rather than deleted, so the invariant cannot regress in either direction unnoticed. 5. WHAT HAPPENS WHEN THE LEVERS FIRE — the four shapes `promisify(execFile)` actually rejects with (timeout-kill, maxBuffer, spawn ENOENT, exit 125), on every step that can produce them. Points 2 and 4 assert that `timeout` and `maxBuffer` are PASSED; this is the only thing here that asserts what the adapter does when one of them goes off, and the shapes are measured against the running Node rather than imagined. 6. THAT TWO RUNS IN FLIGHT NEVER ADDRESS EACH OTHER'S CONTAINER — in the parameterised ordering suite rather than in this file, so the M23.2 Kubernetes adapter inherits it. 7. THAT NOTHING CARRYING A `secretEnv` VALUE LEAVES THIS PACKAGE — not on an argv, not in a returned `RunnerResult`, and not through any channel of a thrown `RunnerLaunchError` (`.message`, `String(err)`, `.stack`, `JSON.stringify`). The port is the only place that can assert this exactly rather than heuristically: it knows both the argv it built and which of those entries the caller declared secret.

THE RECORDING SEAM is the one the three goldens use — `vi.mock("node:child_process")` with a hand-written `execFile`. No Docker is required, so this runs on every PR under `pnpm test`.

### §5. What the env file held while create was in flight

WHAT THE `--env-file` LOOKED LIKE WHILE `create` WAS IN FLIGHT.

Read by the seam, synchronously, at the moment `create` is issued — which is the only moment it can be read, because the adapter unlinks the file as soon as `create` returns. Asserting on it afterwards would be asserting on nothing; asserting only that it is GONE afterwards would pass for an adapter that never wrote it and never passed a credential at all. Both halves are needed and only the seam is standing in the right place for the first one.

`node:fs` is NOT mocked here — only `node:child_process` is — so these are real files in a real temp directory.

### §6. Concurrency only: successive creates are numbered

CONCURRENCY ONLY: with this set, successive `create`s print `container-1`, `container-2`, … so that two runs in flight are distinguishable. Off everywhere else, where the literal `container-abc123` is asserted and must stay.

### §7. M23.1 PHASE 4 — THE REAPER'S OWN SIDE CHANNEL

M23.1 PHASE 4 — THE REAPER'S OWN SIDE CHANNEL.
`reap()` now runs at the top of every `run()`, which means every test in this file that calls `run()` ALSO issues one more `execFile` — `docker ps -a --filter label=scp.launcher.owner` — and `create` now always carries two more `--label` pairs. Every existing assertion in this file pins `calls` as the LITERAL create/cp/start/rm sequence, so both of those would break every one of them for a reason unrelated to what each test is actually about. Both are therefore diverted into their OWN side channels here, verified by their OWN dedicated describe block below, and kept out of `calls` entirely — the same reasoning as `envFileSnapshots` above for the transient `--env-file` path: asserting on the stripped-out value in place would be asserting on nothing, so it is captured where it can still be seen and checked on its own terms.

### §8. PER-STEP FAILURE INJECTION

PER-STEP FAILURE INJECTION — the very object `execFile`'s callback is handed for that step, or absent for a step that succeeds.

IT IS AN ERROR OBJECT AND NOT A BOOLEAN ON PURPOSE, and that is the whole of what this knob fixed: the seam used to reject `start` with `new Error("container exited non-zero")` carrying nothing but `stdout`/`stderr`, so nothing in this file could tell "the runner exited non-zero" apart from "our own `timeout` fired and WE killed it" or "its output blew `maxBuffer`". Two mutations of the `succeeded = false` at `index.ts:227` therefore passed all thirty tests —

```text
  succeeded = false;  ->  succeeded = (err as { killed?: boolean }).killed === true;
  succeeded = false;  ->  succeeded = (err as { code?: string }).code === MAXBUFFER_CODE;
```

— which is the "verify the lever, not just the signal" class CLAUDE.md names: four tests assert that `timeout` and `maxBuffer` REACH the options object, and none asserted what happens when one of them FIRES. `NODE_FAILURE_SHAPES` fires them, on every step that can produce them.

### §9. The ordinary `start` rejection

The ordinary `start` rejection: a non-zero exit carrying the child's own output. A builder rather than a literal because the absent-property arms exercise the adapter's `?? ""` / `?? e.message` falls — see the measured note on those falls in the shapes table below.

### §10. A copy-out is distinguishable from a copy-in

A copy-OUT is distinguishable from a copy-IN without knowing the container id: the copy-IN's DESTINATION is `<id>:<path>` and the copy-OUT's destination is a bare host directory. Every host path in this file is colon-free, so this stays unambiguous.

### §11. THE OPTIONS, AS LITERALS

THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts` — an expectation re-derived from the code it guards cannot detect a change to that code. These three pairs are what the three callers pass TODAY (managed-iac / managed-scan / managed-dep).

### §12. The per-call timeout is no longer a constant

THE PER-CALL `timeout` IS NO LONGER A CONSTANT, AND THAT IS THE POINT (M23.1e)
`RunnerSpec.timeoutMs` is the WHOLE-RUN budget, so each step is issued with what is LEFT of it — `deadline - now`, off ONE clock read at the top of `run()`. Handing every step the full `spec.timeoutMs` is exactly the defect: four sequential calls, each individually well under the bound, made a run of 4 x timeoutMs, which the host budget (sized `timeoutMs + grace`) then SIGKILLed mid-`tofu apply`.

So the equality these constants used to be asserted with was pinning the DEFECT. Two facts are asserted instead, and both are the property rather than a number: - NEVER ABOVE the caller's budget. A step handed more than `timeoutMs` is the old behaviour back, whatever arithmetic produced it. - NEVER MORE THAN `BUDGET_SLACK_MS` BELOW it in this file, where every step settles on the next tick of the loop — which is what stops a degenerate "always 1ms" from passing. The strict decrease across a run, and the refusal once nothing is left, are in `whole-run-budget.test.ts`, which can hold a step open for a measured duration.

`toStrictEqual` KEEPS ITS TEETH: the asymmetric matcher substitutes for the `timeout` VALUE only. The ABSENCE of `maxBuffer` on `rm`, and the absence of any other key anywhere, is still asserted exactly as it was.

### §13. A minimal, entirely explicit spec

A minimal, entirely explicit spec. Every test below overrides only what it is about.

`runId` IS A FIXED LITERAL, and `labels` EMPTY, so that the argv assertions stay readable and so that a spurious label is a visible extra pair rather than noise. The ordering substrate at the bottom overrides `runId` per run — two concurrent runs must not share a container NAME any more than they may share a container id, and the case that proves it needs distinct ones.

### §14. THE FOURTH COMBINATION

THE FOURTH COMBINATION. No real caller pairs these two — managed-iac is `{always, swallow}`, managed-scan and managed-dep are both `{on-success, propagate}` — so nothing above this test ever constructs `{on-success, swallow}`, and it was never asserted anywhere in this file. `onFailure` decides what happens to a FAILED copy-out call; `when` alone decides whether the copy is issued at all. A gate that checked `copyOut.onFailure === "swallow"` instead of `copyOut.when === "always"` would pass every other case in this describe — none of them pairs "swallow" with "on-success" — and would copy evidence out of a run this caller explicitly asked to treat as fail-closed, breaking the exact property `index.ts`'s file header names.

### §15. The fallbacks do fire, and this comment is a correction

THE `?? ""` / `?? e.message` FALLS, AND A CORRECTION. This test's comment used to say the fall covers the cases where "`execFile` rejects with a bare Error … (ENOENT on the binary, or the `timeout` firing)". MEASURED, that is false: `promisify(execFile)` attaches `stdout` and `stderr` to EVERY rejection it produces — including ENOENT and the timeout kill, where both are `""` — so in production these falls never fire and an operator gets an EMPTY `detail` for a runner we killed ourselves. The four arms of `NODE_FAILURE_SHAPES` below pin that consequence as it actually is; this test keeps covering the falls themselves, which remain the adapter's only defence against a rejection that did not come from `promisify(execFile)` at all.

### §16. M23.0's DEFECT 1, FIXED

M23.0's DEFECT 1, FIXED — AND THIS TEST IS THE INVERSION OF THE ONE THAT PINNED IT.
It used to be named "THE RECORDED DEFECT — a REJECTED `create` issues NO `rm`, because its await is outside the `try`", and it asserted that the ONLY call was the `create`. That was the honest record of a real bug: a `create` that times out after the daemon already made the container leaves it behind, unattributed and un-reaped. It is INVERTED rather than deleted, because the invariant it now states is the one that must not silently regress in either direction.

AND IT DOES NOT INHERIT THE OLD FILE'S ADVICE. That test's comment said the right fix was to "move that `await` inside the `try`". IT IS NOT, and this file was wrong about its own subject: moving the await alone leaves `containerId` unbound when `create` rejects, so the `finally` issues `rm -f undefined` — measured against a real daemon (Docker 29.5.2), `docker rm -f` on a name that does not exist EXITS ZERO, so that call is not even a visible failure. It repairs nothing, it reaches no orphan, and it breaks this test. The fix needs BOTH halves: a name computed BEFORE `create` is issued, and `create` inside the `try`.

THE DELETE-THE-WIRING CHECK FOR THAT FIX, MEASURED (each mutation applied alone, whole file re-run): teardown addresses `containerId` again        -> RED here (a `rm -f undefined` is recorded) `create`'s await moves back outside the `try` -> RED here (no `rm` at all is recorded)

### §17. THE LEVERS, FIRED

THE LEVERS, FIRED — what happens when `timeout` or `maxBuffer` actually goes off.

Everything above asserts that `timeout` and `maxBuffer` are ON THE OPTIONS OBJECT. That is the signal, not the actuator, and CLAUDE.md names the gap: five tests (the three profile rows, "A TENANT `timeoutMs` NEVER REACHES `rm`", and `RUNNER_REMOVE_TIMEOUT_MS`) assert those numbers, and not one of them said what the adapter DOES when a number is exceeded. The consequence was measurable: with the old boolean seam, `succeeded = false` at `index.ts:227` could be replaced by `succeeded = (err as { killed?: boolean }).killed === true` and all thirty tests still passed — a build in which every runner WE killed on timeout is reported to the plugin as a SUCCESS, with a truncated or empty plan.json cached as evidence.

MEASURED, each mutation applied to a clean tree and the whole file re-run:

```text
succeeded = false -> `.killed === true`          CAUGHT (1/52) by the TIMEOUT-KILL `start` arm
                                                 — and by that arm ALONE, because the measured
                                                 maxBuffer error has no `killed` property.
succeeded = false -> `.code === MAXBUFFER_CODE`  CAUGHT (1/52) by the MAXBUFFER `start` arm.
stdout  = e.stdout ?? "" -> ""                   CAUGHT (3/52)
stderr  = e.stderr ?? e.message -> e.message     CAUGHT (5/52) — all four `start` arms.
`create` swallows a `killed` failure             CAUGHT (1/52) by the TIMEOUT-KILL `create` arm
copy-IN swallows an ENOENT failure               CAUGHT (1/52) by the ENOENT copy-IN arm
swallowed copy-OUT rethrows on ENOENT            CAUGHT (1/52) by the ENOENT copy-OUT arm
teardown rethrows a `killed` failure             CAUGHT (1/52) by the TIMEOUT-KILL teardown arm
NODE_FAILURE_SHAPES timeout row: killed -> false CAUGHT (1/52) by THE TABLE IS NOT FICTION —
                                                 the fixture itself is mutated, because a table
                                                 nothing checks is a fixture that never applied.
```

WHAT THESE ARMS STILL CANNOT PROVE, STATED RATHER THAN IMPLIED. - That `timeout` or `maxBuffer` ever actually fires. The options object is asserted elsewhere and the CONSEQUENCE is asserted here, but nothing in this file lets a real 10-minute limit elapse; only a real Docker run can join the two halves. The seam injects the shape Node WOULD produce. - That the numbers are the right numbers. 16/32/8 MiB and 10/10/5 min are pinned as the callers' values, and no test here says whether a real `terraform plan` output fits in 16 MiB. - Anything about the runner-side truncation itself. The MAXBUFFER arms assert what the adapter reports; they do not assert that a truncated `plan.json` is REJECTED downstream — nothing in this package parses evidence, and `succeeded: false` is all the adapter offers a caller to go on. - (CLOSED — MEDIUM, verification pass 5.) This bullet read: "That an operator can tell these four apart afterwards. They cannot, today: `run()` returns the same `{ succeeded: false, stdout, stderr }` shape for all of them and drops `killed`, `signal` and `code` on the floor … pinned here as it stands rather than quietly improved." It stood for a milestone, which is what a well-written comment naming a hazard does (CLAUDE.md). `RunnerResult`'s failed arm now carries a `RunnerFailure` — the `classifiedAs` column below is per-ROW, so two rows with byte-identical `stdout`/`stderr` must still classify differently — and all three plugins record `runnerOutcomeDetail(result)` instead of `succeeded ? stdout : stderr`, so the distinction reaches the durable ledger and the Decision rather than stopping at the port. What is STILL not proven here: that a BUDGET exhaustion classifies apart from an ordinary signal. This seam settles every step on the next tick and can never reach the run deadline; `whole-run-budget.test.ts` is the seam that models duration and owns that arm.

### §18. `code` on a maxBuffer overflow

`code` on a maxBuffer overflow — THE PRODUCT'S OWN CONSTANT, imported rather than restated. `classifyRunnerFailure` branches on this exact string, and "THE TABLE IS NOT FICTION" below spawns a real child and compares `code` against the live Node. Importing is what joins those two: a local copy would let the check verify the fixture while the classifier branched on something else.

### §19. The four shapes the promisified call rejects with

THE FOUR SHAPES `promisify(execFile)` ACTUALLY REJECTS WITH — MEASURED, NOT INVENTED.

Each was captured from a real child process (`node -e …`, plus a spawn of a binary that does not exist) and its own-properties printed; the objects below reproduce what came back. Three of the four are things WE did rather than things the runner did, and the adapter cannot currently tell them apart from a plain non-zero exit:

```text
- TIMEOUT-KILL  `killed: true, signal: "SIGTERM", code: null` — OUR `timeout` fired and Node
                SIGTERM'd the runner mid-flight. `stdout`/`stderr` hold what it had printed.
- MAXBUFFER     a **RangeError** with `code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` and — measured,
                and load-bearing — **no `killed` property at all**, so a mutation keyed on
                `killed` is caught by the timeout arm and NOT by this one. `stdout` is the
                output TRUNCATED at `maxBuffer`, which is the whole hazard: it looks like data.
- SPAWN ENOENT  `code: "ENOENT"` (a string) with `stdout` and `stderr` both `""` — the docker
                binary is missing. The run is reported failed with NOTHING to explain it.
- EXIT 125      `code: 125` (a NUMBER), `killed: false, signal: null` — docker's own "container
                failed to run", the only one of the four the runner itself caused.
```

`.code` IS OVERLOADED and all three of its inhabitants are in this table on purpose: `null`, a string errno, and a numeric exit status. `index.ts` READS NONE OF THEM — it derives `succeeded` from the fact of the rejection alone — so today there is nothing to conflate, and these arms are what keeps that true: any future refactor that starts branching on `.code` (`=== 0`, `typeof === "number"`, an errno allowlist) changes the outcome of at least one row and fails BY NAME rather than by a diff.

### §20. Which failure kind must be derived from this shape

WHICH FAILURE KIND `classifyRunnerFailure` MUST DERIVE FROM THIS SHAPE — MEDIUM (verification pass 5). This column is the whole fix for "an operator cannot tell these four apart afterwards", which the header above pinned as a known behaviour gap. It is per-ROW rather than one assertion for all four precisely because the rows must NOT agree: two of them here report `stdout`/`stderr` that are byte-identical and must still be distinguishable.

### §21. `signalled`, NOT `budget-exhausted`

`signalled`, NOT `budget-exhausted`: this fixture's kill did not come from the run's own deadline (the seam settles on the next tick, so the clock never reaches it). The budget arm is in `whole-run-budget.test.ts`, which is the only seam that can model duration — and the two being DIFFERENT kinds from the same Node shape is the reason `deadlineExceeded` is tested first and is a field of its own rather than a re-reading of `killed`.

### §22. Each row's claim, reduced to something comparable

The claim each row makes, reduced to something comparable. `stdout`/`stderr` are compared by TYPE rather than value — their contents are the child's business — because the load-bearing fact about them is that they are ALWAYS PRESENT STRINGS, which is what makes the adapter's `?? e.message` fall unreachable in production.

### §23. WHAT SURVIVES THE WRAP

WHAT SURVIVES THE WRAP. Since the argv-leak fix these arms can no longer assert `rejects.toBe(err)` — the adapter never rethrows the original, precisely so `err.message`'s `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=…` cannot cross the plugin-host RPC boundary. That makes it possible to LOSE the diagnosis while looking correct, so this asserts the opposite direction: the wrapper is a `RunnerLaunchError` for the right STEP, and Node's own `code`/`killed`/`signal` and the original's own words all came across. A wrapper that dropped them would turn "our own timeout SIGTERM'd it" into an indistinguishable blank, which is the whole reason the shapes table exists.

### §24. A recorded constant nobody re-derives goes stale

A recorded constant nobody re-derives goes stale in silence, and this table is a recording of another program's behaviour. So it is checked against that program: `importActual` reaches PAST this file's own `vi.mock` to the real `child_process`, four real children are spawned (no network, no Docker — `process.execPath` is the node running this test, and one binary that cannot exist), and the fields each row claims are compared. If a future Node renames `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, stops setting `killed`, or starts omitting `stderr`, THIS fails and names the row rather than the twenty arms below quietly testing a museum piece.

### §25. Secrets: the split, and that none ever leaves the process

SECRETS — the `secretEnv` split, and the promise that nothing carrying one ever leaves this file.

WHAT THESE PROVE, AND THE MUTATION EACH ONE ANSWERS (every mutation applied alone to a clean tree, the whole file re-run):

```text
secretEnv goes back through `flatMap(e => ["-e", e])`   -> RED: "no value from secretEnv appears
                                                           anywhere in any recorded argv"
the create catch rethrows the original error            -> RED: "a rejected create throws a
                                                           RunnerLaunchError whose message
                                                           contains no secret value"
the wrapper keeps the original as `cause`               -> RED: the same test's `err.stack` arm
the `--env-file` is never unlinked                      -> RED: "the env-file is gone by the time
                                                           `create` has returned"
the env-file is written 0o644 instead of 0o600          -> RED: the same test's mode arm
`env` is routed through `--env-file` too                -> RED: "a spec with NO secretEnv emits
                                                           NO --env-file"
```

WHAT THEY CANNOT PROVE is stated with the rest at the bottom of this file.

### §26. The housekeeping guard, per case not one final test

THE REAL HOUSEKEEPING GUARD, per case rather than as one final test. Every case in this describe is EITHER a refusal that never writes a file, OR a run whose `create` step is responsible for unlinking its own `--env-file` by the time the case's own assertions have run — so `stateDir` must already be empty of files here, before we remove it. A final "CLEANUP" test that made its OWN fresh (and therefore trivially empty) directory could never see a leak from an earlier case; this runs against THIS case's directory, immediately after THIS case, so a leak is caught by the case that caused it rather than being invisible forever.

### §27. The higher-value half, and the one that actually leaked

1d — THE HIGHER-VALUE HALF, AND THE ONE THE PRODUCT ACTUALLY LEAKED THROUGH.
`promisify(execFile)` rejects with `Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=… …` as its MESSAGE. That message is what `subprocess-entry.ts` serialises across the plugin-host RPC boundary — it serialises `err.message` and nothing else — and what reaches `console.error`. So every channel that can carry it is checked, not just the one that is convenient: `.message`, `String(err)`, `.stack` (which embeds the message, and which would embed a `cause`'s stack too), and `JSON.stringify` (which sees own ENUMERABLE properties, so the wrapper's `argv`, `stdout` and `stderr` are all in scope).

### §28. Returned rather than thrown, then recorded directly

`run()` RETURNS this one rather than throwing it, and the plugins put it straight into a Decision's `detail` (charter principle 6). managed-iac redacts it again on its own way out; that is belt-and-braces, not the control — a fourth managed plugin would inherit nothing. THE FIXTURE CARRIES THE SECRET IN ITS `message` TOO, and that is not decoration. `failure.detail` embeds `err.message` and NOT `err.stdout`/`err.stderr`, so a fixture whose message was clean would make the two `not.toContain`s below pass no matter what the classifier did with it — vacuous by construction (CLAUDE.md, "green for the WRONG REASON"). Real Node puts the child's stderr in that message: `Command failed: <cmd>\n<stderr>`. This reproduces that.

### §29. FOUND BY MUTATION, NOT BY READING

FOUND BY MUTATION, NOT BY READING. Dropping `redact()` from the SUCCESS arm of `start` survived the whole suite: every secret case above drove a FAILURE, so the one path a real `tofu plan` takes every day was the one path with no assertion on it. A provider that echoes its own credential into a plan summary — or a runner that prints its environment on `--debug` — lands in `RunnerResult.stdout`, which the plugins put straight into a Decision (charter principle 6).

### §30. Await ordering, which the argv assertions cannot see

AWAIT ORDERING — the half of the contract the argv assertions above are structurally blind to.

Everything above records ISSUE order. Issue order is identical whether a step was awaited or fired and forgotten, so two real mutations of `index.ts` used to survive all twenty of those tests: `await pending.catch(() => undefined)` -> `void pending.catch(() => undefined)` (the evidence copy-out), and `await execFileAsync(docker, ["rm","-f",id], …)` -> `void …` (teardown). The cases below hold one step OPEN and assert that the next one has not been issued, which is the only formulation that can tell the two apart. They are parameterised so the M23.2 Kubernetes adapter inherits them by supplying a substrate rather than by re-deriving the race.

THE MEASURED TABLE — EVERY `await` in `packages/runner-launcher/src/index.ts` (there are six), dropped in turn and the suite re-run. RE-MEASURED against today's 52-test file; the counts and the selector both moved when the LEVERS FIRE arms landed, because those arms share the "M23.1 conformance:" prefix the old selector used. "argv-only" is now the four pre-ordering describes, selected with `-t "what the Docker adapter puts|the per-call timeout|copyOut.when|the failure paths"` (20 tests); "whole file" is all 52.

```text
index.ts:195  create, `const { stdout } = await execFileAsync(…)`
              argv-only: CAUGHT (20/20)   whole file: CAUGHT (51/52)
              Dropping it destroys the value flow too — `createOut` becomes a Promise and
              `.trim()` throws — so this await cannot be dropped in an ordering-only way. The
              named ordering case is "`create` IS AWAITED".
index.ts:205  copy-in loop, `await execFileAsync(…)` -> `void`
              argv-only: CAUGHT (1)       whole file: CAUGHT (7)
              "A REJECTED COPY-IN REJECTS the run" and the four copy-IN shape arms catch the
              un-awaited rejection; "THE COPY-INS ARE SEQUENTIAL" catches the ORDER (two copies
              racing into one container, and `start` racing both), and "TWO RUNS AT ONCE"
              catches it as a cross-run identity error.
index.ts:218  start, `const r = await execFileAsync(…)`
              argv-only: CAUGHT (7)       whole file: CAUGHT (21)
              Value flow again (`r.stdout` undefined), plus "`start` IS AWAITED".
index.ts:242  copy-out swallow arm, `await pending.catch(…)` -> `void pending.catch(…)`
              argv-only: **SURVIVED**     whole file: CAUGHT (2)
              THE managed-iac plan.json RACE. Measured, not assumed: against the argv-only
              selection the run is "20 passed | 32 skipped" and exit 0. Caught only by "THE
              SWALLOWED COPY-OUT IS AWAITED" and "A FAILING SWALLOWED COPY-OUT IS STILL
              AWAITED" — the twenty LEVERS FIRE arms do NOT catch it either, because a shape
              changes what the failure IS and not when it is waited for.
index.ts:244  copy-out propagate arm, `await pending;` -> `void pending;`
              argv-only: CAUGHT (1)       whole file: CAUGHT (6)
              The argv-only catch is incidental — the rejection stops escaping `run()`.
              "THE PROPAGATING COPY-OUT IS AWAITED" is what names the teardown race.
index.ts:251  teardown, `await execFileAsync(… "rm","-f" …).catch(…)` -> `void …`
              argv-only: **SURVIVED**     whole file: CAUGHT (2)
              Also measured at exit 0 against the argv-only selection alone.
```

AND THE MUTATION NO SINGLE-RUN TEST CAN SEE. Hoisting `const containerId` (index.ts:200) out of the `run()` body to module scope typechecks clean and is caught by exactly ONE case in this file, "TWO RUNS AT ONCE": measured at 1 failed | 51 passed, and the failure prints `container-1` having been addressed by ten steps and `container-2` by two.

NOT OBSERVABLE HERE, STATED RATHER THAN GLOSSED. The suite proves each step is awaited BEFORE THE NEXT ONE IS ISSUED. It does NOT prove that the process the adapter waited on is the one that finished — a substrate settles a step when the test says so, not when a container really exits; only `managed-iac.integration.test.ts` (real Docker) can speak to that. It also says nothing about the plugins' own awaits AROUND `run()` (writing the workspace, reading the evidence back), which live in each plugin's suites, nor about WHERE `create`'s await sits relative to the `try` — that has its own named test above ("a create that REJECTS after the daemon committed…"), and it is a teardown-reachability property rather than an ordering one. And the concurrency case runs TWO runs, not N: it would not notice a limit, a pool or a lock that only misbehaves at higher concurrency, and it interleaves them at the points a test chooses rather than at the points a scheduler would.

### §31. WHICH CONTAINER AN argv ADDRESSES

WHICH CONTAINER AN argv ADDRESSES — the Docker spelling of the port's per-run identity. Read off the argv rather than tracked alongside it, so a step aimed at the wrong container is visible here for the same reason it would be visible to the daemon. `create` addresses none, so it reports the id it was ALLOCATED (`createdIds`, in issue order), which is what the run will go on to use.

### §32. M23.1 PHASE 4 — THE REAPER

M23.1 PHASE 4 — THE REAPER. See `RunnerLauncher.reap`'s own doc in index.ts for the defect this closes, and `reaper.integration.test.ts` for why THIS suite (mocked `execFile`, no real Docker daemon) cannot be the proof: it cannot show that a killed process leaves a container behind, that a label survives on it, or that a real `docker ps --filter` actually finds it. What it CAN prove, cheaply and on every PR, is the shape of what `reap()` sends and the LOGIC of its predicate — exactly the two things a real-Docker test would be slow and awkward to drive through every branch of.

### §33. Reap also sweeps a leaked env file, by modification time

MEDIUM-4 — `reap()` ALSO SWEEPS A LEAKED `--env-file`, mtime-based, in the caller's OWN `secretEnvDir`. This describe block is the fs-level proof of the sweep's PREDICATE (mirrors the container predicate suite above, at the same altitude — no real process, no real SIGKILL). The real-process proof — a genuine kill mid-`create` that really does leave the file, really does get swept by a later real run() — is `reaper.integration.test.ts`'s job, for the same reason a real SIGKILL cannot be produced inside this file's single-threaded mocked-`execFile` world.

### §34. REAL disk cleanup, not an assertion

REAL disk cleanup, not an assertion — unlike the secretEnv describe above, several cases HERE deliberately leave a fixture behind (a spared file, a dedup state file the sweep must never touch), so "this dir must be empty" would be a false claim about this describe's own cases. Every case already asserts what it expects to remain or be gone via `existsSync` inline; this just stops the mkdtemp'd fixture directory itself from accumulating on disk across runs.

## `packages/runner-launcher/src/failure-detail-bound.test.ts`

### §35. The failure tail was inert in the case it claimed

THE FAILURE TAIL WAS INERT IN EXACTLY THE CASE ITS DOC CLAIMED IT EXISTED FOR — HIGH, M23.0 verification pass 7. This file is the proof for the fix and, more importantly, the proof that the MECHANISM is pinned rather than merely its output being non-empty.

WHY THE FOUR TESTS THAT ALREADY COVERED THIS PATH DID NOT CATCH IT. Every one of them (`whole-run-budget.test.ts`) pins the BUDGET-KILL arm, and that is the one path whose `err.message` is REPLACED with a short synthesised string rather than being Node's `Command failed: <cmd>\n<the ENTIRE stderr>`. With a short message ahead of it the appended tail lands inside every consumer's front-slice, so the append looked like it worked. It did not work anywhere else: `output.slice(-N)` -> `output.slice(0, N)` — head instead of tail, negating the mechanism's whole purpose — SURVIVED 1542 tests. The PRESENCE of output was pinned; its TAIL-ness was pinned by nothing.

THE COMPANION NUMBER, CORRECTED — LOW, verification pass 7 finding L1, re-measured in pass 8 and the disagreement turned out to be about the MUTATION, not the count. "Deleting the append entirely reddened 4" was reported here; pass 7 re-measured six. Both are right, and they are measurements of two different things. Re-run against `a0a3ab59^` with the round's own test files removed, in the same tree so `dist` resolution is the real one:

```text
suffix = "" in the TAIL BRANCH ONLY            -> 4 red  (0 launcher, 1 iac, 2 scan, 1 dep)
the WHOLE suffix computation deleted           -> 6 red  (1 launcher, 1 iac, 2 scan, 2 dep)
```

The extra two are not about the tail at all: they pin the `output.length === 0` arm's "[the runner printed nothing on stdout or stderr]" wording, which the broader mutation also removes. So the honest statement is the narrow one — FOUR tests pinned the append, none of them its TAIL-ness — and the sentence now says which mutation it is talking about, because a bare "deleting the append" admits both readings and they differ by 50%.

SO EVERY ARM BELOW USES A MESSAGE OF NODE'S REAL SHAPE and puts the diagnosis at the END of the output, which is where a `tofu apply`, a Trivy run and an `npm` failure all put theirs. An assertion that only checks "the detail mentions the runner" passes under both slices; an assertion that the LAST line survived does not.

### §36. A rejection shaped like the one the runtime produces

A rejection shaped like the one `promisify(execFile)` actually produces for a non-zero exit: `message` is the command followed by the WHOLE of stderr, and `stderr` carries it again. `noise` is what the tool printed on its way to the error; `REAL_CAUSE` is its last line.

### §37. THE ONE THE SURVIVING MUTATION MUST REDDEN

THE ONE THE SURVIVING MUTATION MUST REDDEN. `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` -> `output.slice(0, FAILURE_OUTPUT_TAIL_CHARS)` takes the noise the tool printed FIRST instead of the error it ended on, and at 5 KB and 50 KB the message region — front-kept and elided to what the budget leaves — no longer carries the last line either. Both larger arms go red.

1.5 KB is deliberately included and deliberately does NOT depend on the slice: at that size the output fits inside the message whole and the append is skipped as a duplicate. It is here because the property is "the real cause survives AT EVERY SIZE", and a test suite that only covered the sizes where the tail path runs would let the small-output arm rot.

### §38. Below the cap the append is skipped, already inside

Below the tail cap the output is already inside Node's message, so the append is skipped as a duplicate — and then nothing in this function is holding the cause in a reserved region. The string can still overflow on the OTHER axis: a 6 KB argv (a `-var` per resource) with only 1.5 KB of stderr. This is the arm that says the bound is a MIDDLE elision rather than a truncation: a front-slice of the composed string loses the cause here even though the tail append never ran.

### §39. The elision says how much went, and the count is honest

THE ELISION SAYS HOW MUCH WENT, and the count is ARITHMETICALLY HONEST rather than merely present — a reader who cannot trust it is back to wondering whether the runner simply stopped there, which is the diagnostic hazard a bare truncation carries. Asserted as the invariant `kept head + stated drop + kept tail === the original`, NOT by recomputing the split the way `boundDetail` computes it: a test that re-derives the product's arithmetic passes whatever that arithmetic does.

### §40. The magnitude of the bound, pinned against literals

THE MAGNITUDE OF THE BOUND IS A PRODUCT DECISION, PINNED HERE AGAINST ABSOLUTE LITERALS — HIGH, M23.0 verification pass 7.

WHY THIS EXISTS AT ALL. Every other length assertion in this repository reads `expect(x.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS)` — against the very constant that DEFINES the bound, so it is a tautology about the magnitude and says only "the function applied itself". MEASURED: with `RUNNER_DETAIL_MAX_CHARS = 4_000` mutated to `40_000`, managed-iac (29), managed-scan (42) and managed-dep (247) stayed fully green and runner-launcher lost exactly one test — a FIXTURE PRECONDITION, not a product assertion. At `400_000` the 432 KB end-to-end integration test still passed, writing a 400 KB `Decision` row, because its only non-self-referential defence was `toContain("characters elided")`, which merely needs `MAX < 432_078`. The whole "1.44 GB/day" argument the bound makes for itself was defended by nothing.

SO THE NUMBERS ARE WRITTEN OUT. A `Decision` row's size is governed state, not an implementation detail: changing it is a product decision that should require editing a test that says so, in a file whose name says what it protects. This is the test the prompt asks to redden when someone types `40_000`.

### §41. THE ARM THAT MATTERS

THE ARM THAT MATTERS. These runs normally end AT the whole-run deadline, so if `deadlineExceeded` were tested first every one of them would be re-labelled `budget-exhausted` — "the runner was stopped mid-flight" — which is precisely the claim the producer has just declared it cannot make. Swapping the two tests reddens here and nowhere else.

### §42. THE SECOND DECLARED CODE, AND IT IS THE SAME RULE

THE SECOND DECLARED CODE, AND IT IS THE SAME RULE — M23.5 verification pass 20.

`RUNNER_NEVER_STARTED_CODE` used to reach `spawn-failed` BY BEING A STRING, through the errno test at the very bottom of the chain — which meant it only ever got there when `deadlineExceeded` happened to be `false`. It is a verdict produced almost exclusively by runs that polled to the whole-run deadline, so the flag was `true` essentially every time, and the only thing keeping "SIGTERMed mid-flight" off a Job that never started a container was the Kubernetes verdict FORCING the flag back down on the way past. That force made the durable record contradict itself: `deadlineExceeded: false` printed beside "the whole-run budget … was already spent". These two cases are what let the force be deleted.

## `packages/runner-launcher/src/index.ts`

### §43. No plugin spawns a Docker CLI on the Kubernetes path

M23.6 CLAUSE 1 — "no plugin spawns a Docker CLI on the Kubernetes path", stated as a test that "asserts the injected process spawner was NEVER called … asserted on the recorded spawn (argv), not on a mock's call count, so a renamed binary cannot pass it".

THERE WAS NO SUCH SPAWNER TO ASSERT ON. Every `execFile` in this package went straight to the module-private `execFileAsync` above, `RunnerLauncherConfig` exposes only `dockerBinary`, and the Kubernetes adapter is never handed it — so a spawn on the Kubernetes path had nothing recording it anywhere. Measured before this existed: a real `execFile(dockerBinary, ["version", …])` added to `resolveRunnerLauncher`'s KUBERNETES branch left `pnpm -w test` green (72/72), and a marker file proved the mutation was reached six times across the suite.

WHY A LEDGER AND NOT AN INJECTED FUNCTION. An injectable spawner on `RunnerLauncherConfig` would be a plugin-facing, server-injected field naming an arbitrary callable — a new hole in exactly the surface `dockerBinary`'s own doc spends three paragraphs bounding. A module-level ledger needs no new configuration, cannot be reached by a plugin, and records what actually happened rather than what a mock was asked for.

WHAT IS RECORDED, AND WHAT DELIBERATELY IS NOT. The BINARY (so `podman`, `/usr/local/bin/docker` or any rename is visible by name) and `argv[0]`, which for every call this package makes is a subcommand — `create`, `cp`, `start`, `rm`, `ps`. NOT the rest of the argv: M23.1a moved credentials out of argv into an `--env-file` precisely because argv leaks, and a permanent in-memory copy of every argv would put some of that back. `argv.length` is kept so a test can tell two spawns of the same subcommand apart.

BOUNDED, because an unbounded in-process array that grows once per container operation for the life of a long-running worker is the shape this milestone has already fixed twice elsewhere.

### §44. THE ONLY PLACE THIS PACKAGE STARTS A PROCESS

THE ONLY PLACE THIS PACKAGE STARTS A PROCESS. `execFileAsync` above is referenced exactly once, here — asserted as a source census by `no-docker-on-kubernetes.test.ts`, because a second direct call would be a spawn no ledger sees and therefore a clause-1 gate that silently stopped gating.

### §45. The one place a managed runner is launched

`@scp/runner-launcher` — THE ONE PLACE A MANAGED RUNNER IS LAUNCHED (BUILD_AND_TEST.md §8 M23.1).

WHY THIS PACKAGE EXISTS. Three managed executors — `scp-managed-iac`, `scp-managed-scan` and `scp-managed-dep` — each hand-rolled the identical five-step sequence against a Docker CLI: `create` -> `cp` in -> `start -a` -> `cp` out -> `rm -f`. Three independent implementations of one mechanism is exactly the incomplete-call-site-census property CLAUDE.md and BUILD_AND_TEST.md §4.4 name: a fix, a hardening or a new platform arm has to be applied three times, and the instance that gets missed is invisible because the other two are green. A fourth managed class would make it four. THE SEAM IS THE DELIVERABLE.

WHAT THIS PACKAGE IS NOT. It is not a normalisation. The three call sites disagree about real things — whether evidence is copied out after a failed run, whether a failed copy-out fails the run, how big a stdout buffer to allow, whether the network mode is a config read or a charter literal — and every one of those disagreements is load-bearing and pinned by a golden (`launch-argv.golden.test.ts` in each plugin). They are therefore expressed as FIELDS OF THE SPEC the caller supplies (`RunnerCopyOut.when`, `RunnerCopyOut.onFailure`, `RunnerSpec.maxBuffer`, `RunnerSpec.networkMode`), never as a shared default this package chose. A port that made the three uniform would be a behaviour change wearing a refactor's clothes.

THE THREE DEFECTS M23.0 RECORDED, AND WHERE EACH STANDS NOW (M23.0 deliberately shipped all three unfixed, because fixing one means knowingly breaking a golden and "byte-identical" then becomes untestable; M23.0's promise has been kept and cashed, so two of them are fixed HERE): 1. FIXED (M23.0 defect 1). `docker create` failing used to clean nothing: the `finally { rm -f }` only began after `create` RESOLVED, and no `--name`/`--label` was passed, so a container the daemon made for a call that then timed out was left behind with no attribution. Now the container's NAME is computed from the caller's `RunnerSpec.runId` BEFORE `create` is issued, `create` is inside the `try`, and teardown addresses that NAME. See `runnerContainerName` for why the obvious "just move the await inside the try" is NOT the fix. 2. FIXED (M23.0 defect 2), by the PLUGINS rather than by this port, and this entry said "STILL OPEN" for a release after it stopped being true. A managed-scan run whose copy-out fails used to end stuck in `pending`, because the `RunnerCopyOut.onFailure` `"propagate"` rejection escaped `trigger()` with no outcome ever recorded. M23.1 phase 2 wrapped every managed plugin's `trigger()` body in `withRecordedOutcome`, which catches that rejection and records `failed`. MEASURED, not reasoned: `@scp/plugin-managed-scan`'s `launch-argv.golden.test.ts` ("A FAILED COPY-OUT IS NOT SWALLOWED") fails the second `docker cp` and asserts `status()` reports `failed`. managed-iac's create/copy-in failures take the same catch. 3. FIXED (M23.0 defect 3) for the host process table, PARTIALLY. Resolved credentials used to ride the `create` argv as `-e KEY=VALUE`, readable by any local process. They now travel as `RunnerSpec.secretEnv` and reach Docker through a mode-0600 `--env-file` that is unlinked the instant `create` returns. NAMED AS THE PARTIAL FIX IT IS: the value is out of the process table, but it is still in `docker inspect` for the container's life and it is still on a disk for the duration of one `create`. What the split really buys is the Kubernetes arm (M23.2): `env` maps to `env[].value` and `secretEnv` to a per-run Secret with `envFrom.secretRef`, and under one undifferentiated list "port env to Kubernetes" reads as `env[].value` for everything — plaintext credentials in etcd and in every etcd backup, which is strictly worse than the host process table this replaced.

AND THE DEFECT NEITHER M23.0 NOR THIS FILE HAD A NAME FOR: a rejected `execFile` carries the FULL argv in `err.message` (`Command failed: docker create --network none -e AWS_SECRET_ACCESS_KEY=… …`), and that message crosses the plugin-host RPC boundary (`subprocess-entry.ts` serialises `err.message` and nothing else) and reaches `console.error`. Every rejection out of this adapter is therefore wrapped in a `RunnerLaunchError` built from a REDACTED argv. This is the one place in the product that can do that exactly rather than heuristically, because it is the only place that knows both the argv it built and which of those entries came from `secretEnv`.

NO NEW CONFIG SURFACE, ON PURPOSE. The server-injected/never-tenant-settable class (`dockerBinary`, `runnerImage`, `networkMode`, `workspaceRoot`, `statePath`) is enforced in three layers that must move together: each plugin's manifest `configSchema` (`additionalProperties: false`), `validatePluginConfig` at the four write doors (`routes/executors.ts` x3 and `coordination-as-code/plans-repo.ts`), and the LAST-wins injection sites (`coordination/executor-bindings-repo.ts`, `dependencies/managed-dep-instance.ts`, `federation/promotion-scan-step.ts`). M23.1 adds NO field to that class: the adapter is chosen in CODE (there is only one), and the seam a test drives is a factory parameter, not configuration. WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated in that same change — `RunnerLauncherConfig` is where the field will land.

### §46. The bounds a tenant-settable timeout must lie within

The bounds every managed executor's tenant-settable `timeoutMs` must lie within, declared ONCE here because all three managed plugins depend on this package and each publishes the same `configSchema` property.

WHY A MAXIMUM IS NOT HYGIENE. All three plugins run their container SYNCHRONOUSLY inside `trigger()`, and `apps/server/src/plugin-host/host.ts` sizes that RPC's budget from this very number (`managed-call-budget.ts`). A `timeoutMs` with `{ minimum: 1000 }` and no maximum — which is what all three manifests shipped — therefore had two distinct consequences, and the second is the one that made this a defect rather than a smell:

```text
1. The runner itself becomes unkillable BY ITS OWN TIMEOUT. `execFile`'s `timeout` is the only
   thing that stops a wedged `docker start -a`, and a tenant with plain `object:write` on a
   Component could set 2^31 ms (24.9 days) and remove it.
2. The plugin-host budget derived from it becomes unbounded too, which would replace one bad
   failure mode (a 10s SIGKILL through a live `tofu apply`) with another (an RPC that never
   returns and an executor instance whose single-threaded `subprocess-entry.ts` head-of-line
   blocks every `status()`/`observe()`/`abort()` for weeks).
```

The ceiling is what makes the budget COMPUTABLE — an upper bound on how long a managed run may legitimately still be in flight is the predicate an orphan sweep needs, and there is no such predicate while a run may claim any duration it likes.

ONE HOUR is chosen against the defaults it must not squeeze: managed-iac and managed-scan default to 10 minutes and managed-dep to 5, so the ceiling is 6x the largest default — room for a genuinely slow `tofu apply` or a full-filesystem Trivy scan, and still a bound.

### §47. The ceiling, applied where every consumer converges

THE CEILING, APPLIED WHERE EVERY CONSUMER OF IT CONVERGES — MEDIUM (verification pass 5).

WHAT WAS ACTUALLY TRUE BEFORE THIS FUNCTION EXISTED. `MANAGED_RUN_TIMEOUT_MAX_MS` appeared in exactly two kinds of place: the three manifests' `configSchema.properties.timeoutMs.maximum` (the WRITE door, which a row stored before the ceiling existed never passes through again) and `apps/server/src/plugin-host/call-policy.ts`, whose `resolveCallPolicy` clamps — and clamps ONLY ITS OWN RETURN VALUE, the host's RPC budget. All three plugins passed `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` STRAIGHT into `RunnerSpec.timeoutMs`, and nothing between there and `execFile` looked at the ceiling again. Measured for a stored `timeoutMs` of 14_400_000 (4h), which the old `{ minimum: 1000 }` schema admitted and which is still in the database:

```text
  host budgetMs (call-policy, CLAMPED)          3_660_000   (3_600_000 + the 60s grace)
  RunnerSpec.timeoutMs, iac and scan           14_400_000   (UNCLAMPED)
  -> the host SIGKILLs the subprocess at t+3_660_000ms, and that SIGKILL is the event that
     CREATES the orphan; the container it leaves behind is stamped t+14_520_000ms, so it is
     UNREAPABLE for a further 10_860_000ms — 181 minutes of a `tofu apply` with nobody
     supervising it and its credentials readable via `docker inspect`.
```

SO THE CLAMP DEFEATED ITSELF ON EXACTLY THE ROWS IT EXISTS FOR. `RunnerLauncher.reap`'s predicate is "foreign AND past its stamp", and the stamp was `unclamped timeoutMs + RUNNER_REAP_GRACE_MS`. At the 2^31 the call-policy comment names, that is ~24.9 days.

WHY HERE AND NOT A THIRD CLAMP IN EACH PLUGIN. Three plugins build a spec, the Docker adapter consumes it, and M23.2's Kubernetes adapter will consume the same one; this port is the single place all of them pass through. A per-plugin clamp is three copies of one rule, which is the shape that leaves the fourth managed executor unbounded on the day it lands. `run()` calls this ONCE, at the top, and derives the deadline, the container's reap stamp and every step's `timeout` from the clamped value — so the ceiling is a property of the RUNNING SYSTEM rather than only of future writes. ANY FUTURE ADAPTER MUST CALL IT TOO; it is exported for that reason.

THE FLOOR IS DELIBERATELY NOT APPLIED HERE, and the asymmetry is the point rather than an omission. `MANAGED_RUN_TIMEOUT_MIN_MS` is a USABILITY bound — a `timeoutMs` of 1 makes every run of that binding fail fast and harms nothing outside it — and it belongs at the write door, where it already is. The MAXIMUM is a CONTAINMENT bound: it is the sole term that makes the orphan stamp and `RUNNER_SECRET_ENV_MAX_AGE_MS` computable, and both of those are about what a run can do to OTHER runs and to the host after nobody is watching. Only the containment half has to be true of a value read back out of the database, so only the containment half is enforced here. Raising a too-small budget at this port would also silently rewrite the caller's spec on the one axis the three `launch-argv.golden.test.ts` files pin.

A NON-FINITE `timeoutMs` (`NaN`, `Infinity`) COLLAPSES TO THE CEILING rather than propagating. `NaN` is the dangerous one: `now + NaN` is `NaN`, the `remaining <= 0` refusal below is then FALSE, and `Math.max(1, NaN)` is `NaN` — a `docker start -a` with no bound at all, arrived at through the one branch that exists to prevent exactly that. The ceiling is the fail-closed answer for both.

### §48. Whether the evidence copy-out runs after a FAILED start

Whether the evidence copy-out runs after a FAILED start. - `"always"` — managed-iac: a failed `apply` may still have produced a partial `plan.json`. - `"on-success"` — managed-scan (a failed scan must produce NO evidence, so E6 refuses) and managed-dep (a partial manifest must never reach the verifiers).

### §49. Where a FAILED copy-out lands. - `"swallow"`

Where a FAILED copy-out lands. - `"swallow"` — managed-iac: `.catch(() => undefined)`, the run stays `succeeded`. - `"propagate"` — managed-scan and managed-dep: the rejection escapes `RunnerLauncher.run`. The two plugins then answer it differently (scan lets it escape `trigger()`; dep's outer catch turns it into a `failed` outcome), which is the plugins' business, not this port's.

### §50. THE CALLER'S OWN NAME FOR THIS RUN

THE CALLER'S OWN NAME FOR THIS RUN — unique per run, DNS-safe, and matching `RUNNER_RUN_ID_PATTERN`. The Docker adapter turns it into `--name scp-runner-<runId>`; the Kubernetes adapter (M23.2) puts the same string in `metadata.name`.

CALLER-SUPPLIED, NOT ADAPTER-MINTED, and that is the whole point. Only the caller knows what a run IS — managed-iac derives this from `intent.idempotencyKey` precisely so a retry addresses the same container name, which no adapter could know to do. An adapter that minted its own name would force the Kubernetes arm to invent a second naming scheme and recreate exactly the three-implementations-of-one-mechanism divergence M23.1 removed.

Build it with `toRunnerRunId`; the adapter REFUSES a runId that does not match the pattern rather than sanitising one silently, because a silently-sanitised name is how two runs come to share one container.

### §51. Attribution labels, emitted in insertion order

Attribution labels, emitted in INSERTION ORDER as one `--label k=v` each (Kubernetes: `metadata.labels`). This is the other half of M23.0's defect 1 — an orphaned container that carries no label cannot be found, attributed or reaped by an operator, and `docker ps --filter label=…` is the only thing that makes a fleet-wide sweep possible.

### §52. The network the runner gets

The network the runner gets. SERVER-GOVERNED where it is a config read (managed-iac, managed-scan) and a CHARTER LITERAL where it is not (managed-dep's `RUNNER_NETWORK_MODE`, ADR-0032 §8d) — this port takes the resolved value and never decides it, precisely so the difference between "an operator may change this" and "an operator may not" stays at the call site where the charter clause is quoted.

### §53. Ordered environment entries that are not secret

Ordered `KEY=VALUE` environment entries THAT ARE NOT SECRET. The Docker adapter emits each as its own `-e` pair before the image, exactly as it always has, so these stay visible in the host process table — which is correct for what they are: container paths and run parameters. Empty for managed-dep, which passes no environment at all.

### §54. Ordered environment entries that carry a secret

Ordered `KEY=VALUE` environment entries THAT CARRY A SECRET. The split is along the SECRECY axis because that is the axis both adapters must branch on, and neither could infer it: Docker delivers these through a mode-0600 `--env-file` instead of `-e`, and Kubernetes must deliver them as a per-run Secret + `envFrom.secretRef` rather than as `env[].value`.

It is also what makes redaction EXACT. `RunnerLaunchError` is built by removing these VALUES from the argv and from the child's output — no substring heuristic over unknown text, no allowlist of key names that goes stale, because the caller has already told the port which strings are secret.

managed-iac puts `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` here and leaves `PRIOR_STATE_FILE` in `RunnerSpec.env`; managed-scan's `SCP_SCAN_*_DIR` are container paths and stay in `env`; managed-dep holds no credential and passes both empty.

THE REAL BOUND ON THE `--env-file` (MEDIUM-4, corrected — it used to claim less than it now guarantees). ON THE ORDINARY PATH the file lives for the duration of one `create` and no longer: it is unlinked from the SAME process, in the `finally` right after `create` settles, on the success path and the failure path alike. THAT PROMISE IS ONLY AS GOOD AS THE PROCESS KEEPING IT, and a SIGKILL between `writeSecretEnvFile` and that `finally` — the exact shape `plugin-host/host.ts`'s hang detector produces — leaves the file behind with nothing left to unlink it: no `finally` runs, no signal handler fires. Measured: a killed create leaves a mode-0600 file carrying the plaintext credential in the caller's own durable, governed `secretEnvDir` indefinitely, with nothing sweeping it.

SWEPT BY THE SAME MECHANISM THAT SWEEPS AN ORPHANED CONTAINER, on purpose — ONE cleanup concept rather than two. `RunnerLauncher.reap` removes any `scp-secret-env-*` file under the CURRENT run's `secretEnvDir` whose age exceeds `RUNNER_SECRET_ENV_MAX_AGE_MS` — a bound no run still inside its own budget can reach, so a live run's file is never a candidate. THE ACTUAL BOUND ON EXPOSURE IS THEREFORE: instantly, on the ordinary path; otherwise, at most `RUNNER_SECRET_ENV_MAX_AGE_MS` after the run that wrote it, once ANY later run against the same `secretEnvDir` (this process's successor after a respawn, in production) schedules a pass — never "for the duration of one `create`" unconditionally, which was true only when nothing killed the process mid-flight.

### §55. Where the adapter may stage the transient env file

Where the Docker adapter may stage the transient `--env-file`. REQUIRED when `RunnerSpec.secretEnv` is non-empty and ignored otherwise; the adapter refuses rather than choosing a directory of its own, because "which directory is the plugin's own governed state dir" is caller knowledge and `os.tmpdir()` is shared with every other local user.

### §56. THE WHOLE-RUN BUDGET

THE WHOLE-RUN BUDGET — the maximum wall clock `RunnerLauncher.run` may spend on this run, from the moment it is called to the moment it returns, teardown excepted. 10 min for managed-iac and managed-scan, 5 min for managed-dep.

IT USED TO BE A PER-CALL BOUND, AND THAT IS THE DEFECT M23.1e EXISTS TO CLOSE. Every `execFile` this adapter issues — `create`, each `cp` in, `start -a`, the `cp` out — was handed `{ timeout: spec.timeoutMs }` INDEPENDENTLY, so a run of k sequential calls had a wall clock of k x timeoutMs and nothing bounded the sum. Measured: managed-iac (4 calls) with `timeoutMs: 20_000` and steps of 18s/9s/18s/9s — every one of them comfortably UNDER the inner 20s timeout — ran 50s and was SIGKILLed by the host budget that had been sized as `timeoutMs + 30s`, leaving an orphaned container mid-`tofu apply` and an unwritten idempotency ledger, so `reconcile.ts` issued a SECOND apply on top of the first. Reachable at the shipped 10-minute defaults, because `docker create` PULLS THE IMAGE when it is absent: a cold pull plus an ordinary apply clears 630s without any single call reaching 600s.

SO IT IS A DEADLINE, NOT A PER-CALL CAP. `createDockerRunnerLauncher` computes `deadline = now + clampRunTimeoutMs(timeoutMs)` ONCE, at the top of `run()`, and every `execFile` it issues gets `timeout: deadline - now` — never `spec.timeoutMs`, and never `0`, which Node reads as NO TIMEOUT AT ALL (measured on the running Node 26.7.0: `{ timeout: 0 }` let a 1.5s child run to completion). A step reached with the budget already spent is REFUSED before it is issued, with a `RunnerLaunchError` carrying `RunnerLaunchError.deadlineExceeded`.

THE TWO NUMBERS DERIVED FROM THIS ONE — the host's RPC budget (`call-policy.ts`) and the container's own `RUNNER_LAUNCHER_DEADLINE_LABEL` — ARE CORRECT BY CONSTRUCTION UP TO A CEILING, AND `clampRunTimeoutMs` IS WHAT MAKES THE CEILING TRUE. The sentence that used to end this paragraph said the two were "correct BY CONSTRUCTION rather than because a padding constant happened to be big enough". The construction was sound for every value BELOW `MANAGED_RUN_TIMEOUT_MAX_MS`, which is not the same as every value in the database: `call-policy.ts` clamped its OWN return value and the three plugins handed the STORED number to this field untouched, so above the ceiling the two derived numbers diverged by hours rather than by a padding constant. The clamp now runs inside `run()`, so a caller cannot skip it and a second adapter cannot forget it.

AND SINCE M23.5 SO DOES THE DEADLINE ITSELF, for exactly the reason that sentence gives. The clamp was hoisted into `run()`; the per-step deadline was not, and the second adapter forgot it on the two verbs that move bytes — `copyDir` and `removeDir` had no bound at all, so a copy onto a wedged network volume made `run()` never return. `createRunDeadline` is that same argument applied to the thing it was originally made about, and `withStepBound` is what makes a bound true of work that ignores it.

WHAT IS DELIBERATELY OUTSIDE IT: every call declared in `RUNNER_POST_DEADLINE_CALLS` — the `finally` teardown, which must still run after the budget is gone, and the Docker adapter's secret-env `unlink`, which is cleanup of a credential file and must not be refused because the `create` it follows is what spent the budget; and `reap()`, which is not awaited at all (see `RunnerLauncher.reap`).

THE BOUND `run()` IS HELD TO IS `runnerRunBoundMs``(kind, timeoutMs)`, AND THAT SUM IS WHAT EVERY OUTER BUDGET MUST COVER. This used to read `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, which was a sentence about ONE adapter's ONE-call teardown, written when there was one adapter, and FALSE of the Kubernetes adapter — whose teardown is three calls. The bound is now computed from the post-deadline model (`RUNNER_POST_DEADLINE_CALLS`) rather than asserted in prose, and the model is held to the code from both sides: the type checker forward, and `teardown-model.test.ts` — which counts every effect issued at or after the deadline — backward.

### §57. What a runner run produced

What a runner run produced. `succeeded` is the runner's own exit status, not the launch's.

A UNION, NOT A FLAG PLUS AN OPTIONAL FIELD — MEDIUM (verification pass 5). `start` is the only step whose failure is CAPTURED rather than thrown, and it is the step that consumes essentially all of a real run's budget; it used to be captured as `{ succeeded: false, stdout, stderr }` and nothing else. `promisify(execFile)` ALWAYS attaches `stderr` as a string, so for the two shapes an operator most needs explained — our own budget killing the runner, and a spawn that never happened — that string is `""`. Measured through the real adapter:

```text
  budget-killed `start`, no output   -> {"succeeded":false,"stdout":"","stderr":""}
  runner exits 3 silently            -> {"succeeded":false,"stdout":"","stderr":""}
```

Byte-identical, and through the real plugins that becomes `phase:"failed", detail:""` in the durable ledger, in `status()`, and from there in `reconcile.ts`'s `insertDecision` `inputContext` — the record charter principle 6 exists for, reading as if nothing went wrong at all.

Making `RunnerFailure` a member of the FAILED arm rather than an optional property is what stops that recurring: a caller cannot reach a failed result without also having the diagnosis in hand, and a future adapter cannot construct a failure without producing one. `stdout`/`stderr` stay exactly what the child printed (still possibly `""` — that is a true fact about the child); the never-empty explanation is `RunnerFailure.detail`.

### §58. The port: one verb, because a runner has one lifecycle

THE PORT. One verb, because a managed runner has exactly one lifecycle: run it to completion and hand back what it printed. Adapters: Docker (below, for compose/VM) and — M23.2, not before — Kubernetes Jobs.

### §59. Containment hygiene for the remaining window

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

### §60. The adapter-selecting slice of a plugin's

The adapter-selecting slice of a plugin's (server-injected) config.

`dockerBinary` is the only field today, and it is already in the server-injected, never-tenant-settable class: absent from all three manifests' `additionalProperties: false` schemas, refused by `validatePluginConfig` at the four write doors, and injected LAST from `SCP_MANAGED_RUNNER_DOCKER_BINARY`. `managed-scan` shipped a live RCE precisely because that chain had a hole in it (it sat on `KNOWN_EXECUTOR_MODULES` with no manifest, so `validatePluginConfig` returned early); `assertEveryModuleHasManifest` closes that at boot now. ANY FIELD ADDED HERE JOINS THAT CLASS ON DAY ONE — all three layers, in the same change.

### §61. WHICH ADAPTER (M23.2)

WHICH ADAPTER (M23.2) — SERVER-INJECTED, never tenant, and EXPLICIT rather than detected.

This is the field the note above predicted, and it arrives under the rule that note set: it joins the server-injected class on day one, in all three layers, in this same change. Absent or anything other than `"kubernetes"` means the Docker adapter — so every deployment that does not opt in behaves byte-identically, which is what makes a second adapter safe to merge at all.

NEVER AUTO-DETECTED. Guessing the platform from the presence of a service-account token is the runtime/install-time fork M15.4 declined to create, and it guesses wrong in both directions: a compose deployment inside a pod (the eval stack) would be switched to Jobs it has no RBAC for, and a Kubernetes deployment with `automountServiceAccountToken: false` — which is this chart's hardened default — would silently keep shelling out to a `docker` binary the image does not ship.

### §62. The Kubernetes adapter's deployment settings

The Kubernetes adapter's deployment settings. SERVER-INJECTED as one block, for the same reason `dockerBinary` is: the plugin subprocess never sees `process.env` (the host's `minimalChildEnv` strips it), so injected config is the ONLY channel these values have.

REQUIRED when `runnerLauncher` is `"kubernetes"`, and its absence is a NAMED refusal rather than a `TypeError` inside a half-built Job manifest.

### §63. The Kubernetes adapter's server-injected settings

The Kubernetes adapter's server-injected settings. Declared HERE rather than in `kubernetes-adapter.ts` so that `RunnerLauncherConfig` — the one type every plugin passes to its resolver — stays the single description of what a launcher can be configured with.

### §64. How a plugin obtains the launcher for one run

How a plugin obtains the launcher for one run. A FUNCTION rather than a launcher instance because a plugin object is constructed once (`createManagedIacExecutorPlugin()`) while its config arrives per `trigger()` on `ctx.config` — the adapter therefore has to be resolved per run.

This is also the injection seam the wiring tests drive: passing a resolver that throws must make a NAMED test fail, which is the only check that distinguishes "the port is wired" from "the port exists and the plugin still does it the old way" (CLAUDE.md's component-built-never-installed).

### §65. What a {@link RunnerSpec.runId} must look like

What a `RunnerSpec.runId` must look like: lowercase RFC-1123-ish, so the SAME string can be a Docker container name suffix and a Kubernetes `metadata.name`. Bounded at 40 so `scp-runner-<runId>` stays inside Kubernetes' 63-character label/name budget.

### §66. Turn a caller's own run key

Turn a caller's own run key (an `idempotencyKey`, a scratch-dir name, a UUID) into a `RunnerSpec.runId`.

INJECTIVE ON PURPOSE, and this is the part that is easy to get wrong. A plain "lowercase and replace the bad characters" is NOT injective — `prod/eu-west-1` and `prod-eu-west-1` collapse to one string, and two different runs then fight over one container name, one of them losing its `create` to a name conflict and the other losing its container to the loser's teardown. So the slug is used verbatim ONLY when it is a byte-identical, in-bounds rendering of the input; anything else keeps a readable prefix and appends a digest of the ORIGINAL input. Deterministic either way, so managed-iac's retry with the same `idempotencyKey` still lands on the same container name.

### §67. The container's name

The container's name — computed from the runId BEFORE `create` is issued, which is the entire mechanism behind M23.0's defect 1.

WHY "MOVE THE `await` INSIDE THE `try`" IS NOT THE FIX, MEASURED RATHER THAN ASSERTED. That was this repository's own recorded advice (`docker-adapter.test.ts` used to say it in so many words) and it is wrong: if `create` rejects, there is no id to tear down, so the `finally` issues `rm -f undefined`. Run against a real daemon (Docker 29.5.2), `docker rm -f` on a name that does not exist EXITS ZERO — so the extra call is not even an error that surfaces; it silently does nothing, the actual orphan is still there, and the only thing that changed is that a golden broke. Addressing the NAME is what makes the teardown reach a container the daemon committed for a `create` we never got an answer from.

THE HAZARD THIS USED TO INTRODUCE — CLOSED IN M23.1e, and the closing is worth reading, because the note that stood here for one milestone is a specimen of the failure CLAUDE.md names. It said: teardown is unconditional and addresses a name the caller chose, so a `create` that failed BECAUSE THE NAME WAS ALREADY TAKEN tears down the run that legitimately holds it; reachable for two concurrent triggers of one `idempotencyKey`; "retry-stable naming is what makes the fix work at all, so the two cannot both be had; the documented cost of the trade, not an oversight."

THE REACHABILITY WAS RIGHT AND THE TRADE WAS FALSE. Nothing was being traded: the alternatives on offer were "stable names" and "no teardown after a lost name", and those are not in tension. The conflict is DISTINGUISHABLE from every other create failure (`isContainerNameConflict`), so the destructive step is skipped for exactly that one case and every other create failure still tears down by name. A well-written comment naming a hazard is a signal to sweep, not evidence it was handled — this one read as handled for a milestone.

### §68. Every rejection out of a launch, with redacted argv

EVERY REJECTION OUT OF A MANAGED RUNNER LAUNCH, with the argv it came from — redacted.

WHAT IT DELIBERATELY DOES NOT CARRY: the original error. Not as `cause`, not as a property. A `cause` survives `console.error(err)` (Node prints the cause's own stack, argv and all) even though `JSON.stringify` drops it, and the whole point of this class is that there is no channel left. Everything worth keeping — the exit `code`, `killed`, `signal`, and the child's own output — is copied across REDACTED, so the diagnosis survives and the credential does not.

Every own property below is enumerable, so `JSON.stringify(err)` sees exactly this redacted set; `message` is non-enumerable on `Error`, as always, and is built from the redacted argv.

### §69. TRUE when this rejection is the WHOLE-RUN budget

TRUE when this rejection is the WHOLE-RUN budget (`RunnerSpec.timeoutMs`) running out, rather than the step itself going wrong — either the step was refused before it was issued because nothing was left to issue it with, or it was killed by a `timeout` derived from what remained.

WHO READS IT, AND WHY THE ANSWER THIS DOC USED TO GIVE WAS WRONG (MEDIUM, verification pass 5). It said "callers that retry need to tell them apart: a run that exhausted its budget will exhaust it again at the same setting", and a census for `deadlineExceeded` over `apps` and `packages` found exactly ONE reader in the whole repository: an assertion in `whole-run-budget.test.ts`. Nothing in the product read it. Worse, the named caller does not retry a failed run at all — `reconcile.ts` terminalises a `failed` status (`updateWaveTargetObserved(..., "failed")` plus a `block` Decision); its backoff/`attempt` path governs a trigger that REJECTED, and since M23.1 phase 2 all three managed plugins catch and record instead of rejecting. So the justification named a consumer that could not exist, which is this repository's dominant defect wearing a doc comment.

THE REAL READER IS `classifyRunnerFailure`, and it is a reader nothing else can replace: `killed === true` alone cannot distinguish "OUR deadline killed it" from "something else killed it", because only `run()` knows what the deadline was. That classification is what reaches `RunnerResult.failure.detail`, the plugins' recorded outcome, `status().detail` and finally reconcile's `inputContext` — so the audience that actually needs the distinction is the OPERATOR reading a failed run, not a retry loop.

### §70. `code` on a maxBuffer overflow

`code` on a maxBuffer overflow. Node's own constant name, and the PRODUCT's copy of it: the table in `docker-adapter.test.ts` imports this rather than restating it, so "THE TABLE IS NOT FICTION" (which spawns a real child and compares `code` against the live Node) checks the string this classifier actually branches on. A second copy in the test would have made that check verify the fixture instead of the product.

### §71. How a run failed, at operator granularity

HOW A RUN FAILED, at the granularity an operator has to act on. Not a restatement of Node's `code`: the four inhabitants of `code` (`null`, a string errno, a numeric exit status, and `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) do not line up with the four questions a person reading a failed `tofu apply` actually asks, and one of the distinctions — did OUR budget kill it? — is not in `code` at all.

- `budget-exhausted`  `RunnerSpec.timeoutMs` ran out. Either the step was refused before it was issued or it was killed by a `timeout` derived from what remained. THE ONE AN OPERATOR MUST NOT MISREAD AS A RUNNER BUG: for managed-iac it means a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown, and re-running at the same setting will do it again. - `output-exceeded`   the runner printed more than `maxBuffer`. `stdout` holds the output TRUNCATED at the limit, which is the hazard — it looks like data. - `signalled`         something killed the child that was not our own budget. - `spawn-failed`      an errno-coded failure: the container CLI could not be executed at all (`ENOENT` — `dockerBinary` is not on PATH; `EACCES` — not executable). Nothing ran, so nothing was mutated. - `exit-nonzero`      the runner itself exited non-zero. The only one the RUNNER caused. - `outcome-unknown`   the launcher never learned what became of the runner. NOT a sixth way to fail — it is the ABSENCE of a verdict, recorded as one. See below.

WHY THERE IS A SIXTH, AND WHAT IT COSTS — M23.5 verification pass 18.

THE FIVE ABOVE ARE ALL CLAIMS ABOUT THE RUNNER, and every one of them was reachable for a run about which this launcher had learned NOTHING. Measured against a real cluster: the unsuspend PATCH reaches the API server and succeeds, every `GET pods` after it stalls past the budget, and the real Job, the real pod and the real kubelet do the work anyway. The launcher recorded `spawn-failed` — "the container CLI could not be executed at all — nothing ran … so NOTHING RAN and nothing was mutated" — while a real container had written a real file to the real volume. The evidence that the claim was unfounded sat IN THE SAME SENTENCE ("the Job had not yet been observed") and the classification ignored it.

THE TWO EXISTING CANDIDATES ARE BOTH LIES, IN OPPOSITE DIRECTIONS, so choosing between them is choosing which one to tell. `spawn-failed` asserts nothing was mutated; `budget-exhausted` asserts the runner "was stopped mid-flight", which is equally unfounded when the Job never produced a pod at all. Reusing either with a franker `detail` leaves the KIND — the machine-readable word that heads every recorded string and every audit row — saying something the launcher cannot know. Charter principle 6 is that a Decision persists its inputs; an input that is a guess is worse than one that says it is missing.

AND THE ACTION IS DIFFERENT, which is this type's own test for a new inhabitant ("at the granularity an operator has to act on"). `budget-exhausted` -> raise the budget and re-run. `spawn-failed` -> fix the image or the quota and re-run freely, nothing was touched. `outcome-unknown` -> DO NOT re-run yet: look at the real infrastructure first, because a `tofu apply` may be half-applied and the teardown that follows this verdict DELETEs the Job, which kills whatever it was doing.

WHAT IT COSTS. `RunnerFailureKind` is exported, so this is a contract change every consumer sees. A filterless census over `apps`, `packages`, `docs` and `deploy` found NO exhaustive switch on it anywhere and NO schema that carries it: the plugins and `reconcile.ts` read `detail` (whose first word is the kind) and `deadlineExceeded`, never the kind itself. Inside this package `FAILURE_WORDING` is a `Record<RunnerFailureKind, string>`, so the compiler refuses a missing arm — that is the mechanism, and the census is only what says the blast radius is small. What changes for a reader is that the routes where this launcher was BLIND no longer borrow the vocabulary of the routes where it could see.

### §72. The code that makes a failure outcome-unknown

THE `code` THAT MAKES A FAILURE `RunnerFailureKind` `outcome-unknown`.

A STRING, like `RUNNER_NEVER_STARTED_CODE`, and read by `classifyRunnerFailure` BEFORE `deadlineExceeded` — because the runs this describes usually end AT the deadline, and `budget-exhausted` would otherwise win and assert the runner "was stopped mid-flight". `RunnerFailure.deadlineExceeded` still reports which bound ended the run, honestly: WHICH CLOCK RAN OUT and WHAT IS KNOWN ABOUT THE RUNNER are different questions, and conflating them is the defect this constant exists to end.

### §73. THE `code` A RUN CARRIES WHEN NOTHING EVER STARTED

THE `code` A RUN CARRIES WHEN NOTHING EVER STARTED — the producer's own statement that the runner container does not exist and never did, so nothing it could have touched was touched.

READ BY `classifyRunnerFailure` BEFORE `deadlineExceeded`, exactly like `RUNNER_OUTCOME_UNKNOWN_CODE` and for the same reason: it is a DECLARATION, and a declaration may not be overwritten by an inference. Nearly every run that carries it ends AT the whole-run deadline (the poll loop is what discovers the deadline), so `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — would otherwise win and assert the exact opposite of what the producer just said.

IT USED TO REACH `spawn-failed` THROUGH THE ERRNO TEST, i.e. by being a string, and that was load-bearing by accident: the classification only came out right because the producer ALSO forced `deadlineExceeded: false` on the way past — a boolean that then contradicted its own message ("the whole-run budget … was already spent", with `deadlineExceeded: false`). M23.5 verification pass 20 separated the two: the code decides the KIND, the boolean reports WHICH CLOCK RAN OUT, and neither has to lie to protect the other. `classifyRunnerFailure`'s ordering is what makes that safe, and `A DECLARED "NOTHING STARTED" SURVIVES A TRUE deadlineExceeded` is the test that pins it.

IT LIVES HERE, NEXT TO THE OTHER DECLARED CODE, RATHER THAN IN THE KUBERNETES ADAPTER — where it was defined and where it is still produced. `classifyRunnerFailure` now reads it, and the module cycle only resolves while `kubernetes-adapter.ts` imports from this file and never the reverse (see the re-export block at the bottom of this file).

### §74. The total budget for any operator-facing detail here

THE TOTAL BUDGET FOR ANY OPERATOR-FACING `detail` THIS PACKAGE PRODUCES OR ACCEPTS (MEDIUM, M23.0 verification pass 7). It lives here because THE PORT IS THE ONLY PLACE THAT KNOWS WHAT THE STRING IS MADE OF — the classification, the replaced message and the child's own output — and the defect this fixes is precisely three consumers each truncating a string none of them composed.

WHAT WENT WRONG, MEASURED. `classifyRunnerFailure` capped the child's output it appended but placed it AFTER `err.message`, which is uncapped: Node formats a non-zero exit as `Command failed: <cmd>\n<the ENTIRE stderr>`, so for 200 KB of stderr the message alone is ~200 KB and the 2000-character tail sat behind all of it. Every consumer then sliced from the FRONT — managed-scan and managed-dep at 2000 on capture, managed-iac at 4000 on read — so the tail the append exists to preserve was unreachable at EVERY output size for two of the three plugins and inside a ~1.8 KB window for the third. With 5 KB of runner output the real cause reached no operator at all. The four tests that covered this path all pinned the budget-kill arm, whose message is REPLACED with a short string, which is why the whole mechanism could be inert.

WHY 4 000. It is managed-iac's existing read slice, i.e. the largest bound any consumer already imposed, so nothing that reached an operator before is smaller now. It is also the ceiling on a row: `detail` is copied into `reconcile.ts`'s `insertDecision` `inputContext` and, for managed-iac, into a durable on-disk ledger keyed by `idempotencyKey` that is never pruned — the same family as this repository's 1.44 GB/day Decision incident, where an unbounded write per key was the whole mechanism.

### §75. HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED

HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED. The useful end of a `tofu apply`, a Trivy run or an `npm` failure is its LAST lines; a front-slice discards exactly the diagnosis. So this many characters at the END survive every bound this module applies, and anything that has to go goes from the MIDDLE.

### §76. A detail provably within the maximum, by construction

A `detail` that is PROVABLY within `RUNNER_DETAIL_MAX_CHARS`, because the only way to obtain one is `boundDetail`. This is the "a caller should not be able to receive an unbounded `detail` at all" property expressed where the compiler can enforce it rather than as a comment three consumers each read differently: the plugins' own outcome stores declare their `detail` field as this type, so composing `` `my prefix — ${detail}` `` and storing it does not typecheck until it is bounded again. Assignable TO `string` (so `ExecutionStatus.detail` needs no change); not assignable FROM one.

### §77. The two code points Postgres refuses to store

THE TWO CODE POINTS POSTGRES REFUSES TO STORE, AND WHAT WE PUT THERE INSTEAD (HIGH regression, M23.0 verification pass 8). Measured against a real `postgres:16`, inserting into a `jsonb` column and into a `text` column:

| input                       | jsonb                                    | text                                        |
| `"a\u{1F600}b"` (astral)    | OK                                       | OK                                          | | lone HIGH surrogate `\uD83D`| FAIL `invalid input syntax for type json`| OK                                          | | lone LOW surrogate `\uDE00` | FAIL `invalid input syntax for type json`| OK                                          | | `U+0000`                    | FAIL `unsupported Unicode escape sequence`| FAIL `invalid byte sequence for encoding "UTF8": 0x00` | | `U+FFFD`, `U+FFFF`, C0, DEL | OK                                       | OK                                          |

So the predicate a persisted detail must satisfy is NOT "well-formed UTF-16" — `isWellFormed()` returns TRUE for a string carrying `U+0000`, which `jsonb` still refuses. It is well-formed AND NUL-free, and both halves were measured against the database rather than modelled, because the database is the authority on what the database accepts.

WHY U+FFFD FOR BOTH. It is the standard "there was a character here and it could not be represented" mark, so an operator reading the detail sees that something was dropped instead of silently reading a shortened string. It is also a ONE-code-unit replacement for a one-code-unit input, which is why the elision arithmetic below stays exact: sanitising never changes `.length`.

### §78. BOUND A DETAIL, KEEPING BOTH ENDS

BOUND A DETAIL, KEEPING BOTH ENDS — the head (who failed, doing what, with which argv) and the last `RUNNER_DETAIL_TAIL_CHARS` characters (the diagnosis). What is dropped is the middle, which for a runner failure is the noise the tool printed on its way to the error.

IDEMPOTENT BY CONSTRUCTION: the result is never longer than the cap, so a second application is the identity. That is what makes it safe to apply at every trust boundary — the port, each plugin's store, the server's Decision write — WITHOUT recreating the defect this fixes, because they are the same bound and not three different slices.

PERSISTABLE BY CONSTRUCTION TOO, and that half is a HIGH regression fix, not a nicety. The bound slices at UTF-16 CODE-UNIT offsets, so both cuts — head and tail — can land in the middle of a surrogate pair. Four emoji in 8 KB of `tofu` output is enough. The product was an ill-formed string, which `jsonb` refuses, which threw inside `reconcileExecutingChange`'s `withTenantTx` — rolling back the `updateWaveTargetObserved` in the same transaction. Measured end to end: the wave target NEVER terminalised, the poll re-threw every tick forever, and the only trace was a `console.error` behind a green health check. That is this repository's own worked example (BUILD_AND_TEST.md §4.4a) — a coordination loop stopped for 13 days behind passing checks.

Sanitising is applied to the RESULT, not the input, for three reasons: it is at most `RUNNER_DETAIL_MAX_CHARS` long so the scan is bounded even for an 8 MB input; it catches the damage this function itself does at the two cuts; and it catches an input that was ALREADY ill-formed or NUL-carrying, including one short enough to skip the slice entirely — a plugin can hand us a detail decoded from a binary stream, and `text.length <= MAX` was previously a straight pass-through for it.

### §79. THE SAME BOUND AT AN ARBITRARY WIDTH

THE SAME BOUND AT AN ARBITRARY WIDTH — ONE implementation serving the operator-facing `detail` (`boundDetail`), the per-string share of a whole persisted structure (`boundPersistedJson`), and any other place that needs to cut a string short before storing it. `boundDetail` is this function at (`RUNNER_DETAIL_MAX_CHARS`, `RUNNER_DETAIL_TAIL_CHARS`).

EXPORTED BECAUSE THE ALTERNATIVE IS ANOTHER BARE `.slice`, and a bare slice at a UTF-16 CODE-UNIT offset is the defect this whole family of fixes is about: it cuts surrogate pairs, `jsonb` refuses the row, and the write throws inside whatever transaction it was in. A filterless census of "slice a string at a code-unit offset, then persist it" found a second live instance in `apps/server/src/dependencies/version-index-feed.ts`, so the primitive is offered rather than left private for each caller to re-invent.

`tailChars` of 0 gives a HEAD-ONLY bound with an honest elision count — the right shape for a short diagnostic preview, where a reserved tail would leave almost no head.

### §80. Bounded text, plus how many characters it removed

`boundText`, PLUS HOW MANY OF THE ORIGINAL'S CHARACTERS IT REMOVED — M23.1g.

WHY THE COUNT IS RETURNED RATHER THAN READ BACK OFF THE RESULT. The obvious way to recover it is to match `elisionMarker` in the returned string. That is exactly the mistake M23.1g exists to stop being made one layer up: the marker is CONTENT-SHAPED, a plugin can put the same characters in a revision on purpose (`observed-state-gate-critical-leaf.integration.test.ts` drives precisely that fixture), and a reader that pattern-matches it cannot tell our cut from their string. Worse, the NARROW branch below — a `max` too small to carry both ends and an honest count — emits NO marker at all, so a matcher reports "not truncated" for the case that lost the most. The function that did the cutting is the only place the number is known for free.

`dropped` is in ORIGINAL characters (UTF-16 code units), and `keptHead + dropped + keptTail === text.length` holds through sanitising because `persistableText` is length-preserving.

### §81. The total budget for one plugin-supplied structure

THE TOTAL BUDGET FOR ONE PLUGIN-SUPPLIED STRUCTURE ENTERING A `jsonb` COLUMN — MEDIUM/HIGH, M23.0 verification pass 7 finding M2, and the reason it is a BUDGET rather than another per-field cap.

WHAT WENT WRONG, MEASURED. The previous round bounded ONE field of `ExecutionStatus` — `detail` — and missed its siblings three lines away in the same function. `observedStateFrom` reads `stateRef` and `observed.images` off the SAME free-form object the round declares untrusted, and `updateWaveTargetObserved` writes them into `change_wave_targets.observed_state` on the `succeeded`, `failed`/`aborted` AND `observing` branches — i.e. EVERY tick, not only on failure. Through the pre-existing `imagesByTarget` seam, with no product code modified:

OBSERVED-PROBE imageChars=500017 persistedImageChars=500017 rowJsonBytes={"b":500093,...}

500 093 bytes of plugin-chosen text, verbatim, in a row rewritten every second. And `stateRef` reaches persistence a SECOND time, on a different write — `markWaveTargetTriggered`'s `prior_state_ref` — as does `trigger()`'s whole `ExternalRunRef` in `executor_ref`. Three unbounded plugin-supplied `jsonb` columns on one table.

SO THE BOUND IS NOT A LIST OF FIELDS. A per-field patch list that happens to cover today's fields is exactly what produced this finding: `ExecutionStatus.observed` is documented as "optional and additive", so the next field an executor contributes arrives unbounded by default and nothing goes red. This walks a whole VALUE against ONE budget, so a field nobody has written yet is covered on the day it is added, and the guarantee is a fact about the ROW rather than about a field: `JSON.stringify(boundPersistedJson(v).value).length <= PERSISTED_JSON_MAX_CHARS`, always, checked exactly before returning. The `truncation` half of that return value is NOT inside this number — it is a separate value with a separate bound (`PERSISTED_JSON_TRUNCATION_MAX_CHARS`), so that a store which chooses to persist it reserves for it out of its own column policy and no reading loses a character to a report it did not need. `wave-targets-repo.ts` is the one store that does.

WHY 8 000. Two `RUNNER_DETAIL_MAX_CHARS` worth of room, i.e. an `observed_state` may carry an operator-readable revision, a realistic image list and a rollout message and still be about a tenth the size of the smallest row in the 1.44 GB/day incident. It is a CEILING and not a target: a real Argo CD reading is a few hundred bytes and is untouched by this.

### §82. How deep a structure may nest before a marker replaces

How deep a plugin-supplied structure may nest before the rest is replaced by a marker. Also the cycle guard: a self-referential object would otherwise recurse until the stack gave out, and the values this walks are `unknown` from a subprocess whose serialiser we do not control.

### §83. A CEILING ON WHAT AN OBJECT KEY MAY RENDER TO

A CEILING ON WHAT AN OBJECT KEY MAY RENDER TO. Keys are plugin-chosen too, and a key is not a place a reader looks for content, so it gets a much smaller share than a value.

IN RENDERED CHARACTERS, WHICH IS TWO MORE THAN THE KEY ITSELF — this comment used to say "no object KEY may be longer than this", and that is measurably false. `boundStringToCost` bounds the RENDERED cost, and `JSON.stringify` adds two quotes, so the widest key that survives a walk is 126 characters: measured, a 126-character key comes back verbatim at L + 96 and a 127-character one comes back at NO budget, replaced by a head/marker/tail form. Recorded rather than "fixed" by adding 2, because the number that has to be a ceiling is the one the column is measured in; pinned as a boundary by `persisted-json-bound.test.ts` -> "THE LAW'S DOMAIN".

### §84. Never start a field with less budget left than this

Never start a new element/field with less than this much budget left: enough for a short marker and its punctuation.

THIS COMMENT USED TO GO ON: "…so the elision itself can never be what pushes the row over." Measured false, M23.0 verification pass 11 — a guard on STARTING an element says nothing about what that element then spends, and the one it admits may take all of it. The marker's own money is `tailMarkerCost`, reserved before the elements are offered anything; this constant is only "the least a new element is worth starting".

AND IT IS A CEILING ON WHAT A REFUSAL HOLDS BACK, NOT A FLAT PRICE — M23.0 verification pass 12. Spelled as a flat 96 at the two places that REFUSE content, it reserved ninety-six characters for a value of `60` and elided the next key to pay for it; a reading of 2 495 characters came back damaged, and larger, at a budget of 8 000. Both sites now ask `admissionCost`, which is this number OR the value's own cost, whichever is smaller. Nothing else may spell it.

### §85. THE ONE KEY THIS FILE REFUSES TO WRITE

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

### §86. WHAT THE BOUND REMOVED, AS DATA

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

### §87. The field is absent, and that is our doing

The field is NOT IN THE STORED VALUE AT ALL and that is our doing, not the executor's. This is the bit the wrong-cause defect turned on: without it, "absent" and "we cut it" are the same bytes on the wire.

### §88. Keyed by the ROOT FIELD of the bounded value

Keyed by the ROOT FIELD of the bounded value. A value whose root is not a plain object — a bare string, an array — reports under the empty key `""`, meaning "the value itself".

A key is present ONLY when something was removed from that field, so an empty report is never produced: `truncation === undefined` is "nothing was cut", which is the state of every honest reading and costs nothing to store.

### §89. HOW WIDE THE REPORT ITSELF MAY BE

HOW WIDE THE REPORT ITSELF MAY BE. The report is OURS — the counts are integers and `dropped` is a boolean — with exactly one plugin-chosen component: the root field NAMES, each already bounded to `PERSISTED_JSON_MAX_KEY_CHARS` by the walk that stored them. What is NOT bounded by that is HOW MANY of them there are, and a plugin choosing 5 000 root keys is the shape this file already measures elsewhere. So the report is bounded like everything else here — by measurement, not by argument — and the entries that do not fit are replaced by one `PERSISTED_JSON_ELIDED_KEY` entry carrying their count, which is a legal `PersistedJsonFieldTruncation` rather than a shape a schema would refuse.

IT IS NOT TAKEN OUT OF THE VALUE'S BUDGET. The report is a separate return value and its storage is the caller's decision; `wave-targets-repo.ts` reserves for it out of the `observed_state` column policy at the call site, so no arithmetic in this walk changes and no reading loses a character to a report it did not need.

### §90. WHAT `null` COSTS

WHAT `null` COSTS — MEDIUM, M23.0 verification pass 11, and the reason it is a NAMED CONSTANT used by all three branches rather than a `4` typed in one of them.

THE PROPERTY: every leaf branch of `walk` must charge what its return value RENDERS to. Four of the leaf branches did. Three returned something that `JSON.stringify` writes as the four characters `null` and, of those three, only the non-finite-number branch charged for it:

```text
  value                      renders   charged (before)   charged (now)
  NaN / Infinity             null           4                  4
  null / undefined           null           0   <- bug         4
  function / symbol          null           0   <- bug         4
```

The comment on the non-finite branch even names the reason ("a non-finite number is `null` to `JSON.stringify` anyway; making that explicit means the accounting below is the truth") — a well-written comment naming a hazard, handled in ONE of the three places that have it (CLAUDE.md, "census by property, not by symptom"). Both misses are on the branches a reader skims past because they look like they do nothing.

WHY IT WAS NOT MERELY UNTIDY. Free elements DEFEAT THE ARRAY GUARD. An array element is admitted while `budget.left >= PERSISTED_JSON_MIN_LEAF`, so the guard can only stop a list whose elements actually spend; a `null` charged 0 spends 1 (its comma) and renders 5 (`,null`). Measured at the production 8 000 budget, with NOTHING else in the value:

```text
  {a: [ ...1 598 nulls ]}   row 7 997             stored
  {a: [ ...1 599 nulls ]}   walk rendered 8 004   FALLBACK — the whole value is discarded
```

and the fallback is the worst possible loss: not a truncated list a reader can recognise with `isPersistedJsonEntriesElision`, but `observed_state` replaced WHOLESALE by a diagnostic string, so `revision`, `images` and `rollout.weight` are all simultaneously gone, silently, on every tick. It is the exact failure this file was written to prevent, arriving through the one leaf nobody costed.

WHY THE SUITE WAS GREEN. `persisted-json-bound.test.ts` has a 19-arm adversarial corpus and an arm asserting THE INTERNAL OVERFLOW FALLBACK NEVER FIRES — but every array in that corpus holds strings or integers, both of which are charged exactly. A fixture cannot witness a defect in a branch it never reaches; the corpus now carries `null`, `undefined` and a function.

PRE-EXISTING, NOT THIS FAMILY OF ROUNDS'. Verified against the walk as it stood at passes 7, 8 and 9: all three render 10 007 characters for `{a: [2 000 nulls]}` and all three fall back.

### §91. WHAT AN ARRAY HOLDS BACK FOR ITS OWN TAIL MARKER

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

### §92. WHAT AN OBJECT HOLDS BACK FOR ITS OWN ELISION ENTRY

WHAT AN OBJECT HOLDS BACK FOR ITS OWN ELISION ENTRY — HIGH, M23.0 verification pass 14, and the defect pass 11's array fix left standing one branch away.

Pass 11 found that a cut ARRAY charged its tail marker against a budget it had already spent, and bought the marker first. The OBJECT does the identical thing with the identical consequence and was not swept: phase 1 subtracts `jsonCost(marker) + jsonCost(__scpElided) + 2` with no check that it can be afforded. A well-written comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md) — the array's fix names the hazard in full and fixes one of the two places that have it.

WHY IT IS WORSE HERE THAN IT WAS FOR THE ARRAY. An array's overspend is one marker on one list. An object's is one marker PER ELIDING OBJECT, and an eliding object is the normal state of every level of a nested reading at a tight budget — so the overspends multiply by the tree's width and depth rather than adding up over a handful of lists. Measured on `{d5f0..d5f2: {...}}`, five levels of three fields, 4 483 characters of ordinary content, at the DENSE BUDGET SWEEP this pass is built around:

```text
  budget 1200   walk given 1104   rendered 1189   budget.left  -85
  budget 3000   walk given 2904   rendered 2917   budget.left  -13
  budget 4000   walk given 3904   rendered 3916   budget.left  -12
```

and four levels of three fields — 1 486 characters — rendered 1 297 against a budget of 1 200, i.e. 193 over, past the single `PERSISTED_JSON_MIN_LEAF` the row reserves, so THE BACKSTOP DISCARDED THE WHOLE VALUE. It did so at EVERY budget from 4 to 1 296, and the five-level shape at every budget up to 3 915: `revision`, `images` and `rollout.weight` replaced together by a 145-character apology, silently, on every tick. 15 982 backstop firings over 145 048 (shape, budget) pairs.

THE FIX IS THE ARRAY'S, APPLIED TO THE BRANCH THAT WAS MISSED. The object asks first whether it fits whole; if it does not, it buys the widest elision entry it could need BEFORE phase 1 seats anything, and hands the reserve back at exactly one of two places — to the marker, or to the pool if every key seated. So a complete object costs exactly what it cost before (the reserve is zero for it, which is what keeps "L + 96 IS THE WHOLE LAW" true), and an eliding one has already paid.

AND IT MAKES THE OVERSPEND A THEOREM RATHER THAN A HOPE. Every container is walked with at least `admissionCost` — the value's exact cost when that is under 96, and 96 otherwise. A container whose exact cost fits keeps everything and needs no marker; one admitted at 96 can afford any marker this file emits, because 96 exceeds all of them (the widest object entry is 47 rendered characters at 2^53 fields, the widest array tail 37, the depth marker 60). So the ONLY container that can overspend is the ROOT, which `boundPersistedJson` hands `maxChars - 96` — and the 96 it held back is larger than the one marker the root can fail to afford. Zero backstop firings and zero over-budget rows over the sweep is the measurement of that.

### §93. DOES THIS ARRAY ENTRY MEAN "THE LIST WAS CUT HERE"?

DOES THIS ARRAY ENTRY MEAN "THE LIST WAS CUT HERE"? — the difference between "the executor never deployed that image" and "we stopped writing the list down". Those are different facts and reporting one as the other is the provenance-label defect this repository has already shipped once (a Decision whose label named the branch that matched rather than what was true; charter principle 6).

A reader that pulls a SPECIFIC entry out of a bounded array needs this, because after a cut a MISS is not evidence of absence. `internal-release-version.ts` is the live case: it scans `observed_state.images` for the ref whose repository equals a dependency line's coordinate, and without this a miss caused by the bound is reported as `no_matching_image_ref` — which blames the executor for something this file did.

A PLUGIN CAN SPOOF IT by returning this exact string as an entry, and that is deliberately not defended against. The consequence of a false positive is a reader refusing to determine something it could have determined — the safe direction. The reverse, a real cut going unrecognised, is the one that produces a confident wrong answer.

### §94. What the walk would spend, measured up to the cap

WHAT THE WALK WOULD ACTUALLY SPEND ON `value`, MEASURED UP TO `cap` — HIGH, M23.0 verification pass 12, and the reason `PERSISTED_JSON_MIN_LEAF` may no longer be spelled as a flat number anywhere content is REFUSED.

WHAT WENT WRONG, MEASURED. `PERSISTED_JSON_MIN_LEAF` is 96, and both places that decide whether to keep the next thing held back 96 characters for it WITHOUT ASKING WHAT IT COSTS. For a field whose whole value is `60`, that reserves 96 characters for two — and the reservation is what elides the NEXT key. The losses are silent, they are worst on the small uniform readings a controller actually reports, and they are not visible in the row's length, because the row comes out THOUSANDS OF CHARACTERS SHORT of the budget while content is being thrown away:

```text
{resources: {30 x {status, health, version}}}   input 2 495   budget 8 000
    stored 2 825 characters, LOSSY — a value that fits three times over came back damaged
    AND LARGER, because `__scpElided: "1 more fields"` (30 chars) replaced `"version":"v1.4.2"`
the same reading at 80 resources                input 6 645   budget 8 000
    stored 3 684 — 4 316 characters, 54 % of the column, abandoned while entries were cut
{svc-i: {c-k: {ready, restarts, image}}}, 8 x 4  input 1 553 -> stored 2 097, every leaf's
    `image` replaced by a marker saying a field was dropped
```

The 8 000-character budget was never the constraint in any of those: 96 x (keys at that level) was, at EVERY level, multiplying down the tree. And the redistribution rounds cannot give it back — when every sibling is clipped for the same reason, `stillPending.length === pending.length` and the loop breaks at round 0 with the pool untouched.

IT IS ALSO WHY RETENTION WAS NOT MONOTONE IN THE BUDGET. Measured over budgets 4 to 8 200, one character MORE of budget stored strictly less: `{revision, images(40), rollout}` at 417 kept two whole image refs and rendered 300; at 418 it seated a third key, every field's share fell to 96, `images` could no longer afford a single entry, and the row fell to 148 of the 418 available. Pinned as a property (`persisted-json-bound.test.ts` -> "RETENTION IS MONOTONE IN THE BUDGET"), because "more budget stores less" is the shape of a rule that is measuring the wrong thing.

WHAT THIS RETURNS. The EXACT rendered cost of `value` when that is at most `cap`, and any number greater than `cap` once the walk is known to spend more. Callers take `min(PERSISTED_JSON_MIN_LEAF, thisCost)`, so an over-`cap` answer reproduces the old flat reservation EXACTLY — the change can only ever admit content the old rule refused, never the reverse, which is what keeps it from becoming a new way to overspend.

WHY IT IS SAFE TO CALL IN THE HOT LOOP. It never reads more than `cap` characters' worth: every accumulation is followed by a `> cap` test, a string longer than `cap` is rejected on its `.length` before `JSON.stringify` is called on it, and the recursion is bounded by `PERSISTED_JSON_MAX_DEPTH` as well as by `cap`. That second bound is not redundant — it is the cycle guard, and the values this walks are `unknown` from a subprocess whose serialiser we do not control.

IT MIRRORS `walk`, BRANCH FOR BRANCH, AND THAT IS A COUPLING. A leaf `walk` charges more for than this predicts is a leaf that can be admitted for less than it costs. The two are pinned against each other over millions of small shapes at every budget by `persisted-json-bound.test.ts` -> "WHAT THE WALK CHARGES IS WHAT THE ESTIMATE PREDICTED", so a new branch in one that is missing from the other reddens rather than silently overspending.

### §95. A negative cap is reachable and its answer unobservable

A NEGATIVE CAP IS REACHABLE AND ITS ANSWER IS NOT OBSERVABLE — M23.0 verification pass 14, recorded because pass 13 listed `return over` -> `return 0` as a mutation that survived and asked for a corpus or a measured argument. This is the measured argument.

Recursion never passes a negative cap (every `cap - total` is guarded by a `total > cap` test immediately above it), so the only callers that can are the two that ask "does this container fit whole in what I have left" — `walk`'s array branch and its object branch — and `budget.left` can be negative there. Instrumented over the 145 048-pair budget sweep:

```text
  renderedCostAtMost calls                       33 785 292
  entered with cap < 0                               11 960   (most negative: -92)
  where `over` and `0` would compare differently          0
```

Both callers use the result ONLY as `wholeCost <= room`, where `room === cap`. For cap < 0, `cap + 1 <= cap` is false and `0 <= cap` is false, so the two answers are the same decision at every negative cap there is. The branch is a FAST PATH, not a correctness requirement — delete it and the string branch's `value.length > cap` and the container branches' `total > cap` each return `over` anyway. It is kept because it says at the top what the reader would otherwise have to derive from three later comparisons.

### §96. THE LEAST BUDGET THAT ADMITTING `value` CAN REQUIRE

THE LEAST BUDGET THAT ADMITTING `value` CAN REQUIRE: `PERSISTED_JSON_MIN_LEAF`, unless the whole value is cheaper than that, in which case it is what the value actually costs. One function, called from both places a flat 96 used to be spelled — the object's key seating and the array's element admission — because they are the same fact, and a census that fixed one of them would have left the other (CLAUDE.md: census by property, not by symptom).

### §97. WHAT ONE FIELD OF AN OBJECT MAY SPEND

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

### §98. Walks an object's fields under the water-filling rule

Walk an object's fields under the water-filling rule documented on `PERSISTED_JSON_SHARE_ROUNDS`. Split out of `walk` because phase 2 needs the raw value of every field it may re-walk, which a single in-place loop cannot keep.

### §99. AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED

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

### §100. REFUSED FOR SAFETY, NOT FOR ROOM

REFUSED FOR SAFETY, NOT FOR ROOM — see `isUnsafePersistedKey`. Charged nothing, because nothing is stored; counted as a dropped field, because one is. Tested on the BOUNDED key and not the raw one: `boundStringToCost`'s narrow branch keeps the END of an over-long key, so a 300-character key ending in `__proto__` bounds to exactly `__proto__` at a tight budget. A guard on the raw key would pass it straight through.

### §101. Every seated field must still get what it needs

EVERY seated field must still be able to get what IT needs, not just this one: the guarantee has to hold for the fields already seated, whose values are not walked until phase 2. What a field needs is `admissionCost` — capped at `PERSISTED_JSON_MIN_LEAF` for anything large, and the value's exact cost for anything small. `entries.length - i` counts THIS field plus the ones behind it; a later `undefined` value makes that an over-count, which only makes the marker's number too big — and the marker is a count of fields the reader cannot see either way.

### §102. THE RESERVE, SPENT ON WHAT IT WAS BOUGHT FOR

THE RESERVE, SPENT ON WHAT IT WAS BOUGHT FOR. `fieldsElisionCost(entries.length)` is the widest this can be, so what is charged here is never more than what was held back — and the difference (the digits the real count did not need) returns to the pool. ONE function prices both, deliberately: this line used to spell the arithmetic out a second time, and two spellings of one price is how a reserve stops covering the charge it was bought for.

### §103. Both assignment forms are the same here, and both safe

`out[key] = value` AND `Object.assign(out, {[key]: value})` ARE THE SAME HERE, and both passes 14 and 15 record that as a measured no-op rather than as a caught mutation: zero differing pairs over 145 048 (pass 14) and over 700 536 (pass 15, a family with a ladder in it).

PASS 14'S STATED REASON WAS WRONG AND IS CORRECTED HERE, because a false reason is worse than none — a reader would conclude the guard below is what makes `Object.assign` safe. It is not. `Object.assign` copies with `[[Set]]`, exactly as `out[key] = value` does, so the two are identical for EVERY key INCLUDING `__proto__` — measured: both leave `Object.getPrototypeOf` changed and `polluted` readable, and rebuilding with `isUnsafePersistedKey` DELETED still gives zero differing pairs between them. What actually differs from `out[key] = value` is a SPREAD or `Object.defineProperty`, both of which create an own data property instead of calling the setter — which is why `wave-targets-repo.ts` spreading `...bounded.value` is safe and an `Object.assign({}, observed)` in a consumer is not (see `isUnsafePersistedKey`).

So this substitution is an unconditional no-op, not a no-op contingent on the guard. Pass 13 listed it as a surviving mutation and read its SIGNIFICANCE correctly — it was a proxy for the prototype-pollution hole — but the hole is closed by the refusal in phase 1 above, not by the choice of write form here. Neither form would be safe without it.

### §104. BOUND `text` SO ITS RENDERED COST FITS `left`

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

### §105. The walk's budget, plus what allows redistribution

THE WALK'S BUDGET, PLUS THE ONE BIT THAT MAKES REDISTRIBUTION POSSIBLE.

`clipped` means "this sub-walk lost content it would have kept had its budget been larger" — a truncated string, an array whose tail became a marker, an object whose fields became `__scpElided`. It is what `walkObjectFields`'s pass 2 selects on, so it is deliberately NOT set by the two losses more budget cannot fix: the depth-limit marker, and a non-finite number rendering as `null`. Setting it for those would spend a redistribution round producing byte-identical output.

### §106. What this sub-walk removed, in actionable units

WHAT THIS SUB-WALK REMOVED, in the units a reader can act on. Separate from `clipped`, which is a scheduling bit ("offer me more budget and I will keep more") that the redistribution loop consumes and then forgets. `loss` is the DURABLE fact — it is what `boundPersistedJson` turns into `PersistedJsonTruncation`, and the reason a consumer can tell `rollout: undefined` because the executor reported no rollout from `rollout: undefined` because we cut it.

NOT SET BY SANITISING. `persistableText` replaces U+0000 and lone surrogates with U+FFFD one code unit for one; nothing is removed, the value stays readable, and calling that "truncation" would make the signal fire on readings that lost nothing.

### §107. Root-level attribution, carried by the root budget

ROOT-LEVEL ATTRIBUTION, and only the root budget carries it. `loss` alone answers "was anything cut"; this answers "cut from WHICH field", which is the whole difference between an operator told "no rollout" and an operator told "we truncated the rollout". Populated by `walkObjectFields` at depth 0 only — below the root the field names are not addressable from the API, and a path-shaped key would be plugin-chosen text in a governed row.

### §108. A list that fits whole is not charged for a marker

A LIST THAT FITS WHOLE IS NOT CHARGED FOR A MARKER IT CANNOT NEED — HIGH, M23.0 verification pass 12, and the half of the tail reserve its own author flagged as unreviewed ("an array whose reserve is released on one path and not the other").

The reserve below is real money taken out of what the ELEMENTS may spend, and pass 11 took it unconditionally. So a list whose every entry fits was cut anyway, and the marker it stored is WIDER than the entries it replaced. Measured, `{a: ["a"]}` — eleven rendered characters:

```text
  budget 107..133   stored {"a":["[elided: 1 more entries]"]}   <- 26 characters of
                    apology for one character of content, on a list that fits
```

and the same at every scale: `{a: [40 short entries]}` (237 characters) needed 361, not 333. Asking first costs one bounded pass over the elements — the same order as walking them, and it stops the moment the answer is "no" — and it makes the law uniform: a value of L rendered characters comes back BYTE-IDENTICAL at every budget of L + PERSISTED_JSON_MIN_LEAF or more, for arrays exactly as for scalars and objects. Pinned as `persisted-json-bound.test.ts` -> "L + 96 IS THE WHOLE LAW".

### §109. Every field against an equal share, and what is declined

EVERY FIELD AGAINST AN EQUAL SHARE, AND WHAT THE SATISFIED ONES DO NOT WANT RE-OFFERED TO THE REST. With a single budget spent in insertion order, the first large field took the row and every later key became `__scpElided` — so which leaf a gate could read was decided by source-line order in whatever function composed the value. With a share that was only a CEILING, half the budget was thrown away instead. With a share computed from the budget REMAINING mid-loop, how much of each field survived still varied with order. See `PERSISTED_JSON_SHARE_ROUNDS`.

### §110. BOUND A WHOLE PLUGIN-SUPPLIED VALUE FOR PERSISTENCE

BOUND A WHOLE PLUGIN-SUPPLIED VALUE FOR PERSISTENCE. Every string inside it comes back through the same both-ends bound `boundDetail` applies (so it is persistable — see `boundDetail` for what Postgres actually refuses), and the RENDERED size of the whole is at most `maxChars`.

THE GUARANTEE IS CHECKED, NOT ARGUED. The walk's accounting is exact, but "exact" is a claim about code that will be edited; so the rendered result is measured before returning and, if it somehow does not fit, a small diagnostic object is returned in its place. The fallback losing the payload is strictly better than the alternative — the row is what a coordination loop stalls on, and a stall is invisible.

AND THE FALLBACK IS CHECKED TOO — M23.0 verification pass 9. It used to be returned unmeasured, which broke the guarantee in the one direction nobody looks: at `maxChars = 0` the diagnostic itself rendered to 140 characters. Latent (`boundPluginJson` always passes 8 000), but "checked, not argued" is the whole point of this function, and an unmeasured escape hatch out of a measured check is the shape of the next defect. Each candidate below is measured, shortest last.

THE ONE PRECONDITION, STATED RATHER THAN ASSUMED: `maxChars >= 4`. `null` is the shortest thing `JSON.stringify` can produce, so no value at all satisfies a budget under four characters and the function returns `null` regardless. Callers pass a column bound; a column that cannot hold `null` does not exist.

WHERE IT BELONGS: at the STORE, not at the composition sites. The write function is the one place that sees every value that becomes a row, including the ones a future field adds, and it cannot be forgotten the way a call at a composition site can. See `wave-targets-repo.ts`.

AND IT RETURNS WHAT IT REMOVED — M23.1g. Not a courtesy: a bound that shortens a value and says nothing hands every reader downstream a value that is indistinguishable from an honest one, and the reader then reports a cause that is false. See `PersistedJsonFieldTruncation` for the defect, the three ways a reader could have been told, and why this is the only one that works. The pair is the whole return value precisely so the two cannot be separated by accident.

### §111. THE BACKSTOP'S OWN REPORT

THE BACKSTOP'S OWN REPORT — and it is the one the reader needs most, because the backstop is the worst loss this file can produce: `revision`, `images` and `rollout.weight` gone TOGETHER, replaced by a diagnostic sentence. Before this, that arrived at an operator as three fields the executor apparently never reported.

Every root field is `dropped`, because every root field is. The walk's own per-field accounting is deliberately NOT reused here: it describes a value that was measured over budget and thrown away, i.e. a value nobody will ever read.

### §112. Turns the walk's accounting into a report, or nothing

Turn the walk's accounting into the report, or `undefined` when there is nothing to report.

`rootLoss` is the fallback for a value whose root is not an object — a bare over-long string, an array of image refs handed in directly. `walkObjectFields` is the only thing that fills `fields`, so without this clause the ONE shape that has no field names would report nothing at all while losing content, which is precisely the silence M23.1g exists to end.

### §113. MEASURED, NOT ARGUED

MEASURED, NOT ARGUED — the same discipline `boundPersistedJson` applies to the value. A report that could itself grow without limit would be a second unbounded plugin-influenced write on the same row, which is the finding this whole family of rounds started from.

The entries that do not fit become ONE `PERSISTED_JSON_ELIDED_KEY` entry carrying their count. That is a legal `PersistedJsonFieldTruncation`, so a schema over `Record<string, PersistedJsonFieldTruncation>` still validates the report — the alternative, a bare marker string in a record of objects, is a shape the response serializer would refuse and therefore a stall.

### §114. A key unsafe to write never enters the report's key space

A KEY THAT IS NOT SAFE TO WRITE AS A COMPUTED PROPERTY NEVER ENTERS THE REPORT'S KEY SPACE — see `isUnsafePersistedKey`. `out[key] = entry` below is the same call to the same setter the walk's own write loop was making, so the report needs its own guard rather than trusting a filter one function away; and the report is the one place a refused `__proto__` would be named OUT LOUD in a record we serialise, which would put the gadget back in the very field that exists to explain its absence. Such a field is counted in the elision bucket, which already means exactly this: fields were removed and their names are not recoverable.

### §115. HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD

HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD — MEDIUM, M23.0 verification pass 7 finding M1, and the half of the 1.44 GB/day class the previous round did NOT fix.

BOUNDING ONE ENTRY DID NOT BOUND THE MAP. Every managed executor caches `{succeeded, detail}` per `idempotencyKey` so a re-`trigger()` cannot re-run a completed job, and NONE of the three pruned anything, ever. Measured on managed-iac at 500 keys: `bytes=2074290  bytesPerKey=4149`, i.e. the per-entry bound is doing its job and the map is still unbounded because the map is a different quantity. Worse for the DURABLE one: `loadState` `JSON.parse`s the whole file on EVERY `status()` poll and `saveState` rewrites it whole on every `trigger()` — O(total history ever) per poll, forever, on a loop that ticks every second.

THE RETENTION RULE, AND WHY IT IS SAFE. Oldest-first, keeping the most recent `max` entries. What an entry has to outlive is short and knowable: `trigger()` in all three plugins runs the job SYNCHRONOUSLY to completion before writing the entry, so by the time an entry exists the work is already done and the only remaining reader is `reconcile.ts`'s next `status()` poll — under two seconds away — plus a crash-and-retry window in which reconcile re-issues the SAME `idempotencyKey`. Dropping an entry that a retry then asks for is the one real hazard (it means a second run of a job that already ran), so the caps below are set orders of magnitude above the number of runs that can physically be in flight, not at the smallest value that would "work".

AND THE DURABLE CACHE GETS A SMALLER CAP THAN THE IN-MEMORY ONES, which is the whole reason this is a parameter rather than a constant: managed-iac re-reads and re-parses its entire file on every poll, so its size is a per-poll CPU cost as well as a disk cost, while managed-scan's and managed-dep's `Map.get` is O(1) and their size is only memory. The two are not the same tradeoff and pretending they were would either waste memory or re-introduce the parse cost.

### §116. Drops the oldest cache entries down to the maximum

Drop the OLDEST entries of an insertion-ordered outcome cache until at most `max` remain. Returns how many went, so a caller can log a prune rather than have history vanish silently.

ORDER: a `Map` iterates in insertion order by specification, and deleting an entry the iterator has already visited is explicitly safe. This is the in-memory form; `pruneOutcomeRecord` is the JSON-object form the durable ledger needs.

### §117. The same rule for a plain object

The same rule for a plain object — the shape a durable JSON ledger round-trips through.

THE ORDERING CAVEAT, STATED RATHER THAN ASSUMED. `Object.keys` returns INTEGER-LIKE keys first, in ascending numeric order, and only then string keys in insertion order. Every key these caches use is an `idempotencyKey` (a UUID) or a `randomUUID()`, none of which is integer-like, so insertion order holds. If that ever stopped being true the COUNT would still be bounded — which is the property that matters here — and only the choice of which entry to drop would degrade.

### §118. ONE REDACTED LINE, NEVER EMPTY AND NEVER UNBOUNDED

ONE REDACTED LINE, NEVER EMPTY AND NEVER UNBOUNDED — the string a plugin puts in its outcome store and `status()` hands to `reconcile.ts`. Never-empty is the property, not a nicety: the whole defect this fixed first was that `""` was the recorded reason for the two shapes that most need explaining. NEVER-UNBOUNDED is the second half of the same property and was missing for a release: see `RUNNER_DETAIL_MAX_CHARS`. The type is `BoundedDetail` so a consumer cannot be handed a megabyte, and — the point — so no consumer has any reason to slice it.

### §119. Which bound actually ended the run

`RunnerLaunchError.deadlineExceeded` — WHICH BOUND ENDED THE RUN, which is not the same question as `kind`. Kept as its own field because it is the one fact a caller is most likely to want as a boolean.

THIS DOC USED TO SAY "i.e. `kind === 'budget-exhausted'`" AND THAT EQUIVALENCE IS GONE (M23.5 verification pass 18). `outcome-unknown` is normally reached AT the whole-run deadline and carries `deadlineExceeded: true`, because the budget really did run out; what it declines to say is what became of the runner. A caller deciding whether it is safe to re-run must branch on `kind`, never on this boolean — `true` covers both "we stopped it, so it is stopped" and "we stopped LOOKING, and it may still have finished".

### §120. Turns a launch error into something actionable

TURN A `RunnerLaunchError` INTO SOMETHING AN OPERATOR CAN ACT ON — MEDIUM (verification pass 5), and the fix is for the CLASS, not for one flag.

WHAT WAS WRONG. `run()`'s `start` catch kept `e.stdout`/`e.stderr` and threw the rest away — the replaced message, `code`, `killed`, `signal` and `deadlineExceeded` all of it. Because `promisify(execFile)` always attaches `stderr` as a string, `RunnerLaunchError`'s `?? message` fallback never fires, so a budget-kill with no output and a silent non-zero exit were BYTE-IDENTICAL at the port and reached the durable ledger as `detail: ""`. `index.ts` said "THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT" about the thrown path; on the captured one the message was replaced and then dropped.

THE ORDER OF THE TESTS IS LOAD-BEARING and every step of it is a measured Node shape (the table in `docker-adapter.test.ts`, which spawns real children to keep itself honest): 0. `RUNNER_OUTCOME_UNKNOWN_CODE` BEFORE ANYTHING (M23.5 verification pass 18). A producer that has declared it does not know what became of the runner must not have that declaration overwritten by a test that infers one: `deadlineExceeded` would call it `budget-exhausted` ("stopped mid-flight") and the errno test would call it `spawn-failed` ("nothing ran"), and those are the two opposite claims it exists to refuse. 0b. `RUNNER_NEVER_STARTED_CODE` NEXT, and it is the SAME RULE as step 0 rather than a second special case (M23.5 verification pass 20): a producer that has declared what became of the runner outranks a test that infers it. This step is what lets the Kubernetes verdict report `deadlineExceeded` HONESTLY — before it, the only thing keeping "the budget was already spent when this run reached `start`" out of `budget-exhausted` was that same verdict forcing the boolean to `false`, so the durable record said the budget ran out in words and denied it in the field beside them. 1. `deadlineExceeded` next, because a budget kill also sets `killed: true` and would otherwise read as `signalled` — and it is the distinction with the largest consequence. 2. maxBuffer BEFORE the errno test, because its `code` IS a string (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) and `typeof code === "string"` would otherwise call a TRUNCATED-output run a spawn failure — the opposite diagnosis, since the runner ran fine. 3. `killed` BEFORE the errno test, because a signalled child's `code` is `null`. 4. A STRING `code` is an errno (the CLI could not be run); anything else — a number, or `null` with no kill — is the runner's own exit status.

ONE ORDERING HERE IS DEFENSIVE RATHER THAN LOAD-BEARING TODAY, AND IT IS SAID PLAINLY because a reader who takes it for live code will look for the test that kills it. Swapping steps 2 and 3 — testing `killed` before maxBuffer — reddens NOTHING against the shape the running Node actually produces, MEASURED: that RangeError carries no `killed` property at all (pinned by `docker-adapter.test.ts`'s NODE_FAILURE_SHAPES, which spawns a real child to keep itself honest), so it reaches the maxBuffer test either way. The order is kept because Node DOES kill the child on a maxBuffer overflow and adding `killed: true` to that rejection would be an unremarkable change on Node's side — after which the swapped order silently reclassifies a run whose evidence is TRUNCATED as a plain signal. `A maxBuffer OVERFLOW THAT ALSO REPORTS killed` below is the arm that makes the order matter; it is explicitly a FORWARD guard against a shape today's Node does not emit, not a recording of one that it does.

THE DETAIL CARRIES `err.message` VERBATIM rather than re-deriving one. That message is already redacted, already names the step and the argv, and on the budget path is already the REPLACEMENT text naming the budget and the deadline — re-deriving it here is how the two drift. What is added is exactly what the message cannot say: the kind, `code`/`signal` (Node's `Command failed:` text omits the exit status), and an explicit marker when the child printed nothing at all, so "no output" is a recorded fact rather than an absence a reader has to interpret.

AND THE CHILD'S OWN LAST WORDS ARE APPENDED WHEN THE MESSAGE DOES NOT ALREADY CARRY THEM, which is the part that must not be left to luck. Today's Node formats a non-zero exit as `Command failed: <cmd>\n<stderr>`, so for that ONE shape the message happens to contain the runner's own error — and nothing pins that. `docker-adapter.test.ts`'s live-Node check compares `code`/`killed`/`signal` and the TYPES of `stdout`/`stderr`; it says nothing about the message's wording, and the whole subject of this fix is a diagnosis that survived only by accident. So the output is appended explicitly, skipped only when it is provably already present.

THE TAIL, NOT THE WHOLE THING, AND THE WHOLE `detail` IS BUDGETED AROUND IT (MEDIUM, M23.0 verification pass 7 — the correction of a claim this doc used to make falsely). `maxBuffer` is up to 32 MiB and the useful end of a `tofu apply` or a Trivy failure is the LAST lines, so the tail is what is carried. THE CLAIM THAT WAS FALSE was the next clause: it said a front-slice "would discard" those lines, while the code placed the capped tail AFTER an UNCAPPED `err.message` — and Node's message for a non-zero exit is `Command failed: <cmd>\n<the ENTIRE stderr>`. So the front-slice every consumer then applied discarded the tail instead, at every output size for managed-scan and managed-dep and above ~1.8 KB for managed-iac. The mechanism was inert in exactly the case its own doc named as its reason to exist.

SO THE ORDER IS THE FIX, AND IT IS ONE MECHANISM RATHER THAN TWO. The composition still puts `err.message` in whole — nothing is re-derived, which is what kept the budget-kill path's REPLACEMENT text intact — but the child's last words now come AFTER it and the whole string is closed by `boundDetail`, which keeps the last `RUNNER_DETAIL_TAIL_CHARS` characters and elides the MIDDLE. So the reader gets the classification and the argv at the front, the diagnosis at the back, and the noise the tool printed on its way there is what goes.

THE APPENDED REGION IS SIZED TO THE RESERVE EXACTLY — tail plus its longest introducer is `RUNNER_DETAIL_TAIL_CHARS` — so a CALLER that prefixes its own text and bounds again cannot push the diagnosis out either. That is arithmetic, not luck, and `failure-detail-bound.test.ts` pins it.

WHY NOT ALSO PRE-ELIDE THE MESSAGE against a computed budget: the first draft did, and a mutation run showed the two mechanisms covered each other — EITHER could be deleted with all 17 tests still green, which is the definition of a mechanism nothing pins. Simplicity (charter priority 1) picks the single bound. The `includes` search is still skipped above the tail cap, because a substring search over 32 MiB to save an append is the wrong trade.

### §121. The longer introducer, whose length is load-bearing

The longer of the two introducers, and its LENGTH IS LOAD-BEARING rather than decorative: the appended output is sized so that introducer + tail is exactly `RUNNER_DETAIL_TAIL_CHARS`, the span `boundDetail` keeps at the end. That is what makes "the marker and the whole tail both survive a caller's own prefix" arithmetic instead of luck. Pinned by `failure-detail-bound.test.ts`.

### §122. Nothing-ran normally ends at the deadline too

has declared NOTHING RAN normally ends at the deadline too, so `budget-exhausted` was one test away from asserting "SIGTERMed mid-flight" about a container that never existed. It used to be kept out of that branch by the PRODUCER forcing `deadlineExceeded: false`, which made the record's own boolean contradict its own sentence; the ordering does it here instead, once, for every producer.

### §123. The tail is last, and the bound keeps the last of it

THE TAIL IS LAST AND THE BOUND KEEPS THE LAST RUNNER_DETAIL_TAIL_CHARS, which is the whole inversion: the old code let an unbounded `err.message` sit between the reader and the diagnosis. ONE mechanism, not two — an earlier draft also pre-elided the message against a computed budget, and a mutation run showed the two covered each other, so either could be deleted with 17 tests still green. Simplicity (charter priority 1) picks the one that is visible to a mutation: delete `boundDetail` here and this stops being bounded at all.

### §124. The one string a caller records for a run

THE ONE STRING A CALLER RECORDS FOR A RUN, whatever became of it — success or any of the six failure kinds. Exported because all three plugins need the same answer and each of them used to spell it `result.succeeded ? result.stdout : result.stderr`, which is precisely the expression that produced `""`.

On SUCCESS this is the runner's own stdout — the evidence (`tofu plan` output, a scan summary) the previous behaviour correctly recorded — BOUNDED, which it was not.

THE SUCCESS ARM WAS THE WORSE HALF OF THE UNBOUNDED-LEDGER DEFECT and the measurement that found the failure arm did not reach it. managed-iac records this string into `saveState`, a durable JSON file keyed by `idempotencyKey` that is never pruned, and only `status()` sliced it — on READ, at 4000. A `tofu plan` over a large estate can print megabytes within the 16 MiB `maxBuffer`, so a successful apply wrote megabytes to disk per key, forever, to serve 4000 characters. Bounding here rather than at the three call sites is the whole point of the fix: `boundDetail` keeps the END, which for a plan is `Plan: 3 to add, 0 to change, 1 to destroy` — the line a front-slice at either 2000 or 4000 was the first thing to lose.

### §125. Does this rejection mean the name was already taken

Does this `create` rejection mean THE NAME WAS ALREADY TAKEN?

WHY IT HAS TO BE ASKED AT ALL. `runnerContainerName` named the hazard when it landed and left it open: teardown is unconditional and addresses the NAME, so a `create` that failed BECAUSE THE NAME IS IN USE goes on to `rm -f` that name — which by the definition of the conflict is a container this run did not create and is not supervising. For managed-iac that is two concurrent triggers of one `idempotencyKey`, and the loser destroys the winner's live `tofu apply`. It is the same family as the reaper's own cardinal rule: never destroy a container you do not own.

WHY NOT "GIVE EACH ATTEMPT A UNIQUE NAME". That would trade this bug for a worse one. Retry-stable naming is exactly what makes a retry address the SAME container instead of starting a second run of the same apply, and it is what lets the Kubernetes arm (M23.2) rely on `create` being idempotent on `metadata.name`. The name is the feature; the unconditional teardown was the bug.

MEASURED, NOT GUESSED (Docker 29.5.2, via `promisify(execFile)`): a second `docker create --name X` rejects with `code: 1`, `killed: false`, and `stderr: 'Error response from daemon: Conflict. The container name "/X" is already in use by container "<id>". You have to remove (or rename) that container to be able to reuse that name.'` The `Conflict.` token is Docker's own; `already in use by container` is the part every OCI CLI in this class shares, and `dockerBinary` is server-injected precisely so an operator MAY point it at podman or nerdctl (whose wording differs and is NOT measured here). The match is therefore the broad one, and DELIBERATELY so: the two ways to be wrong are not symmetric. A false POSITIVE skips one teardown and leaves a container that `reap()` collects on its deadline; a false NEGATIVE `rm -f`s live infrastructure somebody else is running.

### §126. Every env file this package writes carries this prefix

Every `--env-file` this package ever writes carries this prefix and nothing else does — it is what lets `RunnerLauncher.reap`'s sweep (MEDIUM-4) recognise its own leftovers in a directory it does not otherwise own without touching a single byte it did not create.

### §127. The transient `--env-file`

The transient `--env-file`. Mode 0600, under the CALLER's own governed state dir, and unlinked the instant `create` returns — see `RunnerSpec.secretEnv` for exactly how partial a fix this is, and for what happens when the process is killed before that unlink runs.

`wx` refuses an existing file rather than truncating one: the path carries a fresh UUID, so an existing file at it means something is very wrong and writing a credential into it is the last thing to do.

### §128. The teardown call's own timeout, not the run's

The teardown call's own timeout, and it is NOT the run timeout — a tenant `timeoutMs` never reaches `rm`. It also carries NO `maxBuffer`; both absences are pinned by all three goldens.

IT IS THE UNIT THE TEARDOWN MODEL IS BUILT FROM, NOT THE WHOLE OF IT (M23.5). This doc used to call it "the ONLY work that happens after the whole-run deadline" and to state the bound as `run()` returns within `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`. That was a sentence about the DOCKER adapter's one-call `finally`, written when there was one adapter. The Kubernetes adapter's teardown is THREE bounded calls, so what an outer budget must carry is their SUM — see `runnerPostDeadlineCallsMs` and `runnerRunBoundMs`, which DERIVE it from `RUNNER_POST_DEADLINE_CALLS` instead of restating a number in a comment nothing can check.

### §129. Why this section exists, stated as the measurement

WHY THIS SECTION EXISTS, stated as the measurement rather than as a principle.

`clampRunTimeoutMs`'s own doc already argued the shape: the clamp runs INSIDE `run()` "so a caller cannot skip it and a SECOND ADAPTER CANNOT FORGET IT". That reasoning was applied to the clamp and to nothing else. The per-step deadline stayed hand-rolled in each adapter — three copies of `remaining = deadline - now; refuse if spent; pass what is left down` — and the second adapter promptly forgot one of the three.

MEASURED, against `dist`, on `KubernetesRunnerIo`: `timeoutMs` is a field of `KubernetesApiRequest` and of NOTHING else. `copyDir` and `removeDir` carried no deadline at all, and `createFetchKubernetesIo` implemented them as a bare `cp`/`rm`. The adapter's `copy()` checked the remaining budget BEFORE the call and then awaited it forever:

```text
  after 15003ms with timeoutMs=3000: STILL RUNNING
  requests issued: ["GET …/jobs timeoutMs=30000", "POST …/jobs timeoutMs=2999"]
```

and the volume is BY CONSTRUCTION a network filesystem — the chart names NFS, CephFS, EFS and Azure Files — which is the kind that hangs rather than errors. The chain from there is M23.1c verbatim: `run()` never returns, the host SIGKILLs the subprocess, `withRecordedOutcome` never writes, managed-iac's ledger entry never lands, `reconcile.ts` retries, and a SECOND `tofu apply` goes at live infrastructure. Worse than M23.1c, in fact: copy-in precedes `start`, so the abandoned Job is still SUSPENDED — it never finishes, `ttlSecondsAfterFinished` never applies, and the per-run credential Secret survives until some later run's `reap()` happens by.

THE PROPERTY, NAMED: *the whole-run deadline was enforced by whoever happened to implement the adapter.* The fix is not "give `copyDir` a `timeoutMs` too" — that is the same property with one more instance patched, and a third adapter forgets it again. A field on an interface obliges the CALLER to supply a number; nothing whatsoever obliges the IMPLEMENTATION to honour it. So the enforcement is hoisted to the port: `withStepBound` is the only way any adapter in this package awaits anything, and it gives up on work that did not honour the bound it was handed.

### §130. How long past a step's bound the launcher waits

HOW LONG PAST A STEP'S OWN STATED BOUND THE LAUNCHER WAITS BEFORE ABANDONING IT.

IT IS NOT PADDING, AND IT MAY NOT BE ZERO. The mechanisms that DO honour a bound — `execFile`'s `timeout`, `AbortSignal.timeout` — express it as a timer of their own, and a timer of ours set for the same instant would win the race essentially always: `execFile` fires its timer, SIGTERMs the child, and rejects only after the child actually exits. Abandoning at the same instant would therefore convert every ordinary budget kill into an abandonment, throwing away the `code`/`signal`/partial-stdout diagnosis that `classifyRunnerFailure` exists to preserve — a regression in operator-facing detail bought by a mechanism aimed at a different failure.

So the inner mechanism gets first refusal, by this margin, and abandonment is what happens ONLY when the inner mechanism did not exist (a bare `cp`) or did not work (a `SIGTERM` a process in uninterruptible disk sleep will never take — the exact NFS/CephFS shape this whole section is about). One second is far longer than any honest self-bounded call needs to settle after its own timer fires and far shorter than anything an operator would notice.

AT MOST ONE ABANDONMENT PER RUN, so this is an additive term and not a multiplied one: the first abandonment spends the budget, after which every later step is REFUSED before it is issued.

### §131. The smallest remaining budget a step may be issued

THE SMALLEST REMAINING BUDGET A STEP MAY BE ISSUED WITH — and the reason the refusal's old boundary was unreachable exactly where it mattered most.

THE REFUSAL USED TO READ `remaining <= 0`, and for the step that FOLLOWS a budget kill that condition is essentially never true. `RunDeadline` measures the deadline with `Date.now()`, while the kill that lands on it is a libuv timer read off a different clock; the two disagree by up to a millisecond. MEASURED, in `whole-run-budget.test.ts` under the full suite's load: a `start` killed by its own derived timeout reported `Date.now()` ONE MILLISECOND BEFORE the deadline that timeout was derived from, so the copy-out behind it saw `remaining === 1` and was ISSUED — `docker cp … { timeout: 1 }`. Three arms of that file failed intermittently on it, 3 runs in 8, a different arm each time, which is the signature of a boundary the process cannot land on rather than of a test that is wrong.

AND A 1ms `docker cp` IS NOT A CALL, IT IS A SPAWN AND A SIGTERM. `whole-run-budget.test.ts`'s own comment said so before any of this was measured — "issuing a doomed `docker cp` at the deadline is a call whose only possible outcome is another SIGTERM". Spawning a process costs several milliseconds before the image is even resolved, so a bound below that is a promise to kill the work rather than a budget to do it in: it burns a spawn, produces a `killed`/`SIGTERM` diagnosis about our own impatience rather than about the step, and arrives at the same `deadlineExceeded` verdict the refusal would have given for free.

TEN MILLISECONDS: an order of magnitude above the clock disagreement that makes `<= 0` unreachable, below the cost of the cheapest thing any step here does, and 1% of the smallest whole run budget the product will accept (`call-policy.ts` floors a stored timeout at one second). It is NOT padding on the budget — the deadline does not move — it is the point below which "what is left" stops being budget at all.

### §132. Thrown when the work did not honour its bound

WHAT `withStepBound` THROWS WHEN THE WORK DID NOT HONOUR ITS BOUND. Never leaves this package: `run()` turns it into a `RunnerLaunchError` with `deadlineExceeded`, which is what makes `classifyRunnerFailure` call it `budget-exhausted` — the honest answer, since the whole-run budget is precisely what ran out.

THE WORK IS ABANDONED, NOT CANCELLED, and the message says so. `fs.cp` and `fs.rm` take no `AbortSignal`; there is no way to stop a copy that is wedged on a network mount. What the launcher can guarantee is that `run()` RETURNS — which is the whole difference between a failed run the ledger records and a SIGKILLed subprocess that retries into a second `tofu apply`.

### §133. The only way this package awaits anything external

THE ONLY WAY THIS PACKAGE AWAITS ANYTHING THAT LEAVES THE PROCESS — one call, one bound, and a return that is guaranteed whether or not the work cooperates.

`work` RECEIVES THE BOUND so that a mechanism which CAN self-limit does (that is strictly better: it cancels rather than abandons, and it keeps its own diagnosis). The race is what makes the bound true for the mechanisms that cannot.

THE TIMER IS `unref`'d, DELIBERATELY. An abandonment timer must never be the reason a process stays alive: if nothing else is pending there is no in-flight I/O to abandon. A genuinely wedged `fs.cp` holds a libuv threadpool request, which keeps the loop alive, so the timer fires exactly when it is needed. (A test that models a hang as a promise which simply never settles must therefore hold a handle of its own — `port-deadline.test.ts` does, and says why.)

WORK THAT REJECTS AFTER IT WAS ABANDONED IS NOT AN UNHANDLED REJECTION, AND THERE IS NO EXPLICIT GUARD FOR THAT — said plainly, because the obvious guard is exactly what a reader will look for. A rejection nobody is listening to takes a plugin subprocess down, which is the failure this function exists to prevent arriving by the back door, so the property matters. It is already true: `Promise.race` SUBSCRIBES to every promise it is given and keeps that subscription after it has settled, so `pending` is handled from the moment it enters the race, forever. A first draft added `void pending.catch(() => undefined)` in a `finally` for this; mutating it away reddened NOTHING across the whole suite, measured — the definition of a mechanism nothing pins — so Simplicity (charter priority 1) removed it. The PROPERTY is still gated (`port-deadline.test.ts`: "WORK THAT REJECTS AFTER IT WAS ABANDONED IS NOT AN UNHANDLED REJECTION"), which is what a rewrite away from `Promise.race` — an `AbortController` and a `.then`, say — would have to keep true.

### §134. The one clock a run is held to, spent by adapters

THE ONE CLOCK A RUN IS HELD TO, and the only thing either adapter may spend it through.

Created once at the top of `run()` from `clampRunTimeoutMs(spec.timeoutMs)` — the same "inside `run()` so nobody can forget it" placement the clamp already had, now extended to the thing the clamp's own doc claimed for it.

### §135. IS THE BUDGET GONE?

IS THE BUDGET GONE? — the ONE way anything in this package asks that question, and the reason it is a method rather than a `Date.now() >= deadline.at` at each site.

THREE SITES ASKED IT RAW AND ALL THREE WERE WRONG THE SAME WAY. A budget kill is a libuv timer; the deadline is `Date.now()`; the two clocks disagree by up to a millisecond, so a step killed BY ITS OWN DERIVED TIMEOUT could arrive at its `catch` with `Date.now()` still one millisecond short of the deadline that timeout came from. The Docker adapter then reported `deadlineExceeded: false` for a kill that was purely its own budget — `exit-nonzero`/`signalled` instead of `budget-exhausted`, which is a verdict about the TENANT'S runner for something the launcher did. Measured: 1 run in 20 of the full launcher suite, and a different arm of `whole-run-budget.test.ts` each time.

SO THE ANSWER IS THE SAME ONE `spend` REFUSES ON — `RUNNER_MIN_STEP_BUDGET_MS` — and it is defined once. "Enough left to refuse a step on" and "enough left to call this our deadline" cannot be two different questions: they are the same instant, and asking them with two expressions is how they came to disagree by a millisecond.

### §136. REFUSE, BOUND, OR ABANDON

REFUSE, BOUND, OR ABANDON — the three-way decision every step of every adapter goes through, written once.

- nothing left -> a `RunnerLaunchError` with `deadlineExceeded`, and the step is NEVER ISSUED. `timeout: 0` is no timeout at all in Node and a negative one throws synchronously with an unredacted argv in the message, so the refusal is the part with the teeth. - otherwise -> `work` is handed what remains and raced against `RUNNER_STEP_ABANDON_GRACE_MS` past it. - work rejected on its own -> the rejection is RE-THROWN RAW, because the two adapters shape a step failure differently (Docker keeps Node's `code`/`killed`/`signal` and replaces only the message; Kubernetes builds a fresh cause from an HTTP status) and normalising that here would silently rewrite four goldens. Callers therefore re-throw a `RunnerLaunchError` they receive unchanged — it is already this port's own verdict.

### §137. Every bounded call allowed after the run deadline

EVERY BOUNDED CALL AN ADAPTER MAY ISSUE AFTER THE RUN DEADLINE, BY NAME — the model, and the question its first version asked wrongly.

THIS NUMBER IS THE MODEL, AND THE MODEL IS WHAT WAS MISSING. `MANAGED_TRIGGER_GRACE_MS` was 60s chosen as "two worst-case teardowns", written when a teardown was one `docker rm -f`. The Kubernetes adapter's teardown is THREE calls — DELETE the Job, DELETE the Secret, remove the workspace subtree — so sixty seconds of bounded work consumed the entire grace and left nothing for the outcome write the grace exists to protect. That is precisely what `call-policy.ts`'s own comment calls "WRONG BY CONSTRUCTION" about the 30s it replaced: the number was gated (`grace > RUNNER_REMOVE_TIMEOUT_MS`, one teardown) and the MODEL was not, so nothing anywhere knew the teardown had grown.

AND THEN THE CENSUS THAT BUILT IT ASKED THE WRONG QUESTION. It asked *what does the teardown `finally` issue?* — a right answer to a question one narrower than the property, which is *what bounded call can be issued after the run deadline?* The very same round added one that is not in any teardown `finally`: the secret-env `unlink` in the Docker adapter's `create` `finally`, whose own comment says "BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET … the commonest way to reach it with nothing left is that `create` is what spent the budget". The words were written; the number was not moved. MEASURED, with `secretEnv` set and `create`, `unlink` and `rm -f` all wedged: `run()` returned after 64004ms against a stated bound of 33000ms — exactly one extra `RUNNER_BOUNDED_CALL_WORST_CASE_MS`, which lands 1004ms PAST the host's SIGKILL, so `withRecordedOutcome` never writes, managed-iac's ledger entry never lands, `reconcile.ts` retries, and a second `tofu apply` goes at live infrastructure. M23.1c verbatim.

SO THE MODEL IS A LIST OF NAMES AND THE COUNT IS DERIVED FROM IT, in both directions:

- FORWARD, at compile time. `withPostDeadlineBound` is the only way either adapter issues one of these, and its `call` parameter is typed as a member of THIS list, so a new post-deadline call does not compile until it is declared here — and declaring it moves `runnerPostDeadlineCallsMs`, the reap stamp and `MANAGED_TRIGGER_GRACE_MS` together. - BACKWARD, at test time. `teardown-model.test.ts` drives each adapter to a run whose budget is ALREADY SPENT and counts every effect issued at or after the deadline, whatever its SHAPE. That last word is the fix: the old Docker counter filtered `args[0] === "rm"`, so an `fs.unlink` was structurally invisible to it, and it drove a spec with no `secretEnv`, so the worst case was unreachable even in principle. The Kubernetes counter beside it passed `secretEnv` deliberately and said why — the reasoning was applied to one adapter and not the other.

A DECLARED COUNT PINNED BY ONE ASSERTION IS A CONSTANT WITH A COMMENT, NOT A MODEL. Editing the old `RUNNER_TEARDOWN_STEPS.docker` from 1 to 2 reddened exactly one test, because every consumer derived its expected value from the same constant. Nothing here is written twice.

### §138. What a sum of timers costs beyond the arithmetic

WHAT A SUM OF TIMERS COSTS THAT THE ARITHMETIC DOES NOT SAY.

Every term in the bound below is a `setTimeout`, and a `setTimeout` NEVER FIRES EARLY AND ALWAYS FIRES LATE — by however long the event loop takes to come back to it. A bound stated as the exact sum is therefore exceeded by that latency once per timer, every time, on a perfectly healthy process. MEASURED on the four-timer worst case (the abandonment of the step in flight at the deadline, plus both of Docker's post-deadline calls): `run()` returned at 64009ms against an exact sum of 64000ms.

NINE MILLISECONDS IS NOT A DEFECT, AND AN UNSTATED SLOP IS. This is a flat allowance of ~100x the measurement rather than a per-timer one because its purpose is not to be tight: it is so that `runnerRunBoundMs`'s "THE BOUND `run()` IS HELD TO" is a sentence that is TRUE, instead of one that is true to within a margin every reader has to rediscover by measuring. It is noise against the 30s outcome tail every consumer already carries on top.

### §139. Everything run may still do past its deadline

EVERYTHING `run()` MAY STILL DO AFTER ITS WHOLE-RUN DEADLINE — one possible abandonment of the step that was in flight when the deadline passed, then every post-deadline call, plus the allowance for the fact that all of those are timers. This is the term every outer budget has to carry on top of `RunnerSpec.timeoutMs`.

### §140. The only bounded call not spent from the run budget

THE ONLY WAY EITHER ADAPTER ISSUES A BOUNDED CALL THAT IS NOT SPENT FROM THE RUN BUDGET.

NOT A CONVENIENCE WRAPPER — IT IS THE DECLARATION SITE. Every call routed through it names itself from `RUNNER_POST_DEADLINE_CALLS`, so the set of things that can happen after the deadline is a list the type checker holds the code to rather than a census someone runs and writes down. The bound is `RUNNER_REMOVE_TIMEOUT_MS` for all of them, which is the unit `runnerPostDeadlineCallsMs` multiplies; handing the caller a choice of bound would put the arithmetic back where it drifted from.

### §141. The bound a run is held to, for a requested timeout

THE BOUND `run()` IS HELD TO on `kind`, for a requested `timeoutMs`. The sentence three documents used to state as `timeoutMs + RUNNER_REMOVE_TIMEOUT_MS`, now computable rather than asserted — and true of the Kubernetes adapter, of which the old sentence was false.

### §142. How far clear of its post-deadline work a run stamps

HOW FAR CLEAR OF ITS OWN POST-DEADLINE WORK A RUN STAMPS ITS REAP DEADLINE.

The stamp must stay in the future for as long as the owning PROCESS may be alive, and the process outlives `run()` by the host's own grace (`MANAGED_TRIGGER_GRACE_MS`, which this package may not import — the dependency only goes one way). This headroom is what covers that, and `call-policy.test.ts` gates the relationship from the side that CAN import, for every adapter kind rather than for the one that happened to exist when the constant was written.

### §143. The label reap filters the container listing on

Presence of this label is what `reap()` filters `docker ps -a` on — every container this package ever creates carries it, so a container with no `scp.launcher.*` labels at all (created by something else entirely — a stray `docker run`, a Testcontainers fixture, an operator's own manual container) is excluded at the DAEMON'S OWN filter, before a single byte of its state reaches this process. Reap is a targeted sweep of what this package made, never `docker container prune`.

### §144. How far past its deadline a container's stamp sits

How far past a run's own WHOLE-RUN DEADLINE its container's `RUNNER_LAUNCHER_DEADLINE_LABEL` is stamped — the label's value is `runDeadline + this`, and `runDeadline` is the single `now + clampRunTimeoutMs(spec.timeoutMs)` computed once at the top of `run()`.

THE INVARIANT IT BUYS, AND WHY IT IS NOW STRUCTURAL. `reap()` removes containers that are foreign AND past their stamped deadline, so the one thing that must never be true is a container being past its own stamp while the run that made it is still in flight — a peer's `rm -f` then lands on a live `tofu apply`, which `RunnerLauncher.reap`'s own contract names as the thing it must never do.

IT USED TO BE FALSE, MEASURED. The stamp was `Date.now() + spec.timeoutMs + this` while `timeoutMs` was a PER-CALL bound, so a run's wall clock was k x timeoutMs and nothing tied the two together. Real managed-scan shape (3 copy-ins, `timeoutMs: 30_000`, steps of 28s): the container was stamped for ~t0+150000ms and `run()` returned after 168354ms — 18s spent `foreign AND past deadline` to any peer launcher. The threshold was ~24s of `timeoutMs`; all three shipped defaults are far above it.

NOW IT IS ARITHMETIC, AND SINCE M23.5 IT IS ARITHMETIC PER ADAPTER. `run()` cannot outlive `runDeadline` by more than `runnerPostDeadlineMs` — one possible abandonment plus that adapter's whole teardown — so THAT is the term this has to cover, plus `RUNNER_REAP_HEADROOM_MS` for the window in which the run is over but the owning process is still finishing (the host's `MANAGED_TRIGGER_GRACE_MS`, which this package may not import).

IT WAS A FLAT `2 * 60_000` AND THAT WAS THE SAME DEFECT AS THE GRACE'S. Two minutes was "four worst-case teardowns" when a teardown was one `docker rm -f`; on the Kubernetes adapter a teardown is three bounded calls and the host's own grace grows with it, so a flat two minutes could put the stamp in the PAST while the owning process was still alive — HIGH-2 through the other door, on the adapter nobody re-derived the number for.

### §145. THE HARD BOUND ON ONE `reap()` PASS

THE HARD BOUND ON ONE `reap()` PASS — see `RunnerLauncher.reap` for the measurement.

A pass is `docker ps` plus one `docker rm -f` per expired orphan, and the orphan count is unbounded (it grows with every crash the fleet has had). Bounding only the individual calls, as phase 4 did, bounds nothing: n orphans at `RUNNER_REMOVE_TIMEOUT_MS` each is n x 30s. The pass therefore has its own deadline and simply STOPS issuing removals when it passes; whatever is left is still expired, still labelled, and still there for the next pass — a sweep is idempotent, so finishing it late costs nothing and finishing it inside an unbounded loop costs a run.

Two minutes: room for four worst-case removals, which is far more than a healthy fleet ever has to do, and short enough that a wedged daemon does not leave a background pass running for the life of the process.

### §146. The hard bound on an env file's age before orphaned

THE HARD BOUND ON A `--env-file`'s AGE BEFORE `reap()` TREATS IT AS ORPHANED (MEDIUM-4). Purely mtime-based — see `RunnerLauncher.reap` for why a registry cannot do this job: it lives in the same process memory a SIGKILL erases, so the one process that could tell reap() "this file is still mine" is exactly the one that is gone.

SIZED SO NO LIVE RUN CAN EVER LOOK STALE, the same direction every other bound in this file leans. A run's `--env-file` is written once, at the very top of `RunnerLauncher.run`, before a single `execFile` is issued — so the OLDEST a live run's file can legitimately be, at any later instant of that same run, is bounded by that run's OWN whole-run budget. Add `RUNNER_REAP_GRACE_MS` — the same margin the container's own deadline label carries, for the same reason (a run that is past its deadline but still inside one teardown is not yet fair game) — and a file cannot be BOTH this old AND still belong to a run inside its own budget. A false positive would delete a live run's credential mid-`create`; this bound is chosen so that never happens, at the cost of a leaked file surviving for a while rather than being swept the instant it could safely be.

WHAT ENFORCES THE BOUND THAT ARGUMENT RESTS ON, because the answer this doc used to give was FALSE (MEDIUM, verification pass 5). It said a run's budget is "at most `MANAGED_RUN_TIMEOUT_MAX_MS`, the ceiling every tenant-settable `timeoutMs` in the product is clamped to." It was not clamped to it. `apps/server/src/plugin-host/call-policy.ts` clamped the HOST's RPC budget and nothing else; all three plugins passed the stored `timeoutMs` into `RunnerSpec.timeoutMs` untouched. What ACTUALLY bounded a live run at that point was the host SIGKILLing the plugin subprocess at `budget + MANAGED_TRIGGER_GRACE_MS` — a margin supplied by a constant in a package this one may not import, whose own doc did not mention this dependency, and which is absent entirely on the ONE in-process caller (`promotion-scan-step.ts` calls `plugin.trigger()` with no host and therefore no SIGKILL at all). An age bound resting on a ceiling nobody applied and on a killer that is not always present is not a bound.

`clampRunTimeoutMs` IS THE ENFORCEMENT, and it is in this package, called by `run()` on the same line that computes the deadline the `--env-file` is written under. The bound is therefore now arithmetic inside one file — the same repair `RUNNER_REAP_GRACE_MS` records for the container stamp — rather than a claim about what some other package's write door and some third package's grace period jointly happen to guarantee.

### §147. This process's own identity, minted once at load

This PROCESS's own identity, for the lifetime of the process — minted ONCE, at module load, and NOT inside `createDockerRunnerLauncher`. That distinction is the whole mechanism: a plugin resolves a fresh launcher on every `trigger()` (`ResolveRunnerLauncher`'s own doc explains why), so if the id were minted inside the factory, this SAME long-lived subprocess would mint a new "owner" for every run and could never recognise its own prior container as its own. One id per Node process — which is exactly one id per managed-executor plugin INSTANCE, since `plugin-host/host.ts` spawns one subprocess per configured instance and keeps it alive (with respawn-on-crash) across every call — is what makes "owned by me" mean the same thing for every run this process ever performs, and mean something DIFFERENT the moment a respawn happens: the successor process mints its own id, so it correctly treats its dead predecessor's leftover container as foreign and reapable once that container's deadline has passed.

### §148. The single-flight slot for the background sweep

THE SINGLE-FLIGHT SLOT FOR THE BACKGROUND SWEEP, one per container CLI — module scope for exactly the reason `LAUNCHER_OWNER_ID` is: a launcher instance lives for ONE run, so a guard held in the factory's closure would guard nothing at all.

WHAT IT IS FOR. `run()` no longer awaits its sweep, so without this, k concurrent triggers start k concurrent passes, all listing the same containers and all racing to `rm -f` the same ids — and the losers' rejections are swallowed, so the waste is invisible. Every pass is idempotent, so a caller arriving while one is in flight has nothing to add and simply joins it.

KEYED BY BINARY because `dockerBinary` is server-injected and a test (or a future operator with two runtimes) may drive two different CLIs from one process; a shared slot would let one CLI's pass satisfy the other's.

### §149. The sweep in flight for this binary, or a resolved one

The background sweep currently in flight for `dockerBinary`, or a resolved promise when there is none. Nothing in production awaits it — that is the entire point of the change (see `RunnerLauncher.reap`) — and it exists so a shutdown path, or a test that needs the sweep to have SETTLED before it asserts on what was removed, has something to await instead of a sleep.

AWAITING IT DOES DRAIN THE SLOT: `reapInFlight`'s entry is deleted by the pass's own `.finally`, which runs BEFORE the promise this returns resolves, so a `reap()` issued after this settles always starts a FRESH enumeration rather than joining the drained one.

IT KNOWS ONLY ABOUT THIS PROCESS. The single-flight map is module state, so this says nothing about a pass running in a PEER process against the same daemon — and such a peer is entitled to remove exactly the containers this process's next pass would have (property 2 in `RunnerLauncher.reap`'s doc). A test that needs its own pass to be the one that collects a fixture must handle losing that race, not assume this call prevents it.

### §150. THE DOCKER ADAPTER

THE DOCKER ADAPTER — `create` / `cp` in / `start -a` / `cp` out / `rm -f`, reproducing what the three plugins each did, byte for byte. Every argv string and every options object below is what the three `launch-argv.golden.test.ts` files recorded BEFORE this package existed; those goldens are the proof, and they were not edited to make this pass.

Never a `-v` bind mount, never a docker socket, always the caller's resolved `--network`: a host-path escape stays structurally impossible because nothing is mounted, only copied.

### §151. See {@link RunnerLauncher.reap}

See `RunnerLauncher.reap`. Lists every container THIS PACKAGE labelled (any owner), then removes exactly the ones that are BOTH foreign (owner != `LAUNCHER_OWNER_ID`) AND past their deadline. A container with a missing or unparsable deadline is left alone — the same fail-closed direction as everything else in this file: an ambiguous label must never read as "safe to destroy".

### §152. The half of reap that sweeps a leaked env file

MEDIUM-4 — the half of `reap()` that sweeps a leaked `--env-file` rather than an orphaned container. See `RunnerLauncher.reap` and `RUNNER_SECRET_ENV_MAX_AGE_MS` for the mechanism and the age bound; this function is the sweep itself.

NEVER TOUCHES A FILE THIS PACKAGE DID NOT NAME — the `SECRET_ENV_FILE_PREFIX` check is not an optimisation, it is the entire safety argument for being handed an arbitrary directory: a plugin's `secretEnvDir` is its OWN governed state dir, and for managed-iac that is the very directory the dedup-cache `statePath` lives in. A sweep that matched on age alone would delete that file the moment it happened to be old enough.

BEST-EFFORT, exactly like the container half: a `readdir`/`stat`/`unlink` failure here is logged and swallowed rather than thrown, because a sweep that cannot even list a directory must not block the run it precedes, and a file that is merely a little late to be swept costs nothing — the same idempotent-sweep argument `RUNNER_REAP_BUDGET_MS` makes.

### §153. Single-flighted per binary, as that slot explains

`reapOnce`, single-flighted per binary through `reapInFlight` — see that map's own doc for why a per-launcher guard would guard nothing. The `--env-file` sweep (`sweepStaleSecretEnvFiles`, MEDIUM-4) is DELIBERATELY OUTSIDE that single-flight: it touches no daemon, is keyed by DIRECTORY rather than by `dockerBinary`, and joining a peer's in-flight container pass must never silently skip sweeping THIS run's own `secretEnvDir`.

### §154. SCHEDULED AT THE TOP, BEFORE `create`, AND NOT AWAITED

SCHEDULED AT THE TOP, BEFORE `create`, AND NOT AWAITED — M23.1 phase 4's placement, M23.1e's coupling. The placement is still right: one place, reached before the next container this process makes and — because the host respawns a SIGKILLed subprocess with backoff — within one retry of the very event that orphans a container. The `await` was not: reap's `ps` and every `rm -f` were spent out of the run's own budget, and with four stale orphans a run could exhaust it with `create` never issued (measurement in `RunnerLauncher.reap`). `void`, not `await`: the sweep is idempotent, single-flighted and hard-bounded, and it can now delay `create` by no ticks at all. `reap()` never rejects; the `.catch` is for the case where some future edit makes it able to, so an unhandled rejection can never take the subprocess down over a cleanup pass.

`spec.secretEnvDir` PASSED THROUGH (MEDIUM-4): this is the CURRENT run's own governed directory, so a stale `--env-file` a SIGKILLed predecessor left here — the one place this run is about to write its own — is swept before this run adds another. See `RunnerLauncher.reap`.

### §155. THE WHOLE-RUN DEADLINE

THE WHOLE-RUN DEADLINE — the one clock in this function, read once and never recomputed. See `RunnerSpec.timeoutMs`: the budget is for the RUN, not for each of the four-to-six `execFile`s a run issues, and the ONLY reason the host's RPC budget and the container's own reap stamp are now correct is that this line makes them derivable.

IT IS THE PORT'S OBJECT, NOT THIS ADAPTER'S ARITHMETIC (M23.5). The refusal, the `Math.max(1, …)` and the bound handed to each step all live in `createRunDeadline` now, for one reason: this adapter got that arithmetic right and the SECOND adapter got two thirds of it right, which is what an invariant re-implemented per adapter is worth.

### §156. `spec.timeoutMs` WITH THE PRODUCT CEILING APPLIED

`spec.timeoutMs` WITH THE PRODUCT CEILING APPLIED. See `clampRunTimeoutMs`: the ceiling used to be enforced on the host's RPC budget and on NEITHER of the two numbers this function derives, so a stored `timeoutMs` above it produced a container stamped hours past the SIGKILL that orphaned it. It is read off the deadline object rather than recomputed, because two clamps of one number is how the two drift.

### §157. The deadline label's value for this run

`RUNNER_LAUNCHER_DEADLINE_LABEL`'s value for the container THIS run is about to create — `runDeadlineAt` plus `RUNNER_REAP_GRACE_MS`, off the SAME clock read the run itself is bounded by.

THAT SHARED READ IS THE FIX FOR HIGH-2. It used to be its own `Date.now() + spec.timeoutMs + grace` while the run's real duration was k x `timeoutMs`, so a run routinely outlived the deadline it had stamped on its own container and spent that window looking, to every peer launcher, exactly like an orphan to be `rm -f`'d. Now the run cannot pass `runDeadlineAt` except by one teardown, and the grace is four of those.

### §158. The only external call, and the only raw escape

THE ONLY `execFile` IN THE PRODUCT, AND THE ONLY PLACE A RAW REJECTION CAN ESCAPE — the redaction wrapper, with the `timeout` supplied by the caller.

EXACTLY ONE STEP MAY USE IT DIRECTLY, AND ONLY BECAUSE IT IS OUTSIDE THE RUN BUDGET: the `finally` teardown, which has to work when the budget is precisely what ran out. Every other step goes through `exec`, which derives its bound from the run's one deadline.

### §159. OUTSIDE THE RUN BUDGET IS NOT OUTSIDE A BOUND

OUTSIDE THE RUN BUDGET IS NOT OUTSIDE A BOUND (M23.5). `RUNNER_REMOVE_TIMEOUT_MS` is still what reaches `execFile` — every golden pins it — and `withStepBound` is what makes it TRUE when the child cannot take a SIGTERM. A teardown that never returns is the same unreturned `run()` as a copy-in that never returns.

AND IT NAMES ITSELF FROM THE MODEL. The bound and the timeout both come from `withPostDeadlineBound`, so this call cannot be issued without appearing in `RUNNER_POST_DEADLINE_CALLS` — which is what the count every outer grace is built from is derived from.

### §160. Every step bounded by what is left of the budget

EVERY STEP OF THE RUN PROPER, BOUNDED BY WHAT IS LEFT OF THE ONE BUDGET — the whole of M23.1e's HIGH-1 fix. `options` carries NO `timeout`: each caller below used to hand in `spec.timeoutMs` and get a fresh, FULL budget of its own, so k sequential steps meant a k x timeoutMs run and no bound on the sum.

THE ARITHMETIC IS NO LONGER HERE, AND THAT MOVE IS M23.5's WHOLE POINT. The refusal at exhaustion, the `Math.max(1, …)` that keeps Node in range, and the abandonment of work that ignores its bound all live in `RunDeadline.spend` — read that doc for the three Node traps this used to spell out, because they are properties of the PORT and not of this adapter. What survives here is the only part that genuinely differs between adapters: how a step's OWN failure is shaped into a `RunnerLaunchError`.

### §161. THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT

THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT. `code`/`killed`/`signal` and whatever the child managed to print before we killed it are carried across unchanged — a partial `tofu plan` on stdout is exactly what an operator needs from a run that ran out of budget — while the text says WHY it died instead of `Command failed: docker start -a …`, which is indistinguishable from the runner having crashed on its own.

### §162. The plain environment had no check at all

`env` is as caller-shaped as `secretEnv` and had no check at all. Docker reads a bare `-e KEY` (no `=`) as "inherit KEY from THIS process's environment" — so a malformed entry imports the SERVER's own variable into the runner instead of failing — and the Kubernetes adapter's `indexOf("=")` split turns the same entry into a name missing its last character. Two different silent wrong answers from one unvalidated string. Newlines are NOT refused here (unlike `secretEnv`): these travel as argv / `env[].value`, where a multi-line value is exactly one variable, not two.

### §163. THROUGH THE ONE DEADLINE, LIKE EVERY OTHER STEP

THROUGH THE ONE DEADLINE, LIKE EVERY OTHER STEP (M23.5 census). `secretEnvDir` is a server-injected path — `SCP_MANAGED_*_WORKSPACE_ROOT`, which an operator may perfectly well point at the same shared mount the Kubernetes workspace uses — so an `mkdir` + `writeFile` here is the same unbounded network-filesystem call as a `copyDir`, and it sits BEFORE `create`, where a hang costs the whole run with no container to show for it.

### §164. DID `create` LOSE THE NAME TO SOMEBODY ELSE?

DID `create` LOSE THE NAME TO SOMEBODY ELSE? Declared out here because it is read in the `finally` and written in the `try`, and it is the ONE thing that makes the unconditional teardown conditional. Anything else that goes wrong with `create` — a timeout, a missing image, a dead daemon — still tears down, because the daemon may have committed a container for a call we never got an answer from (M23.0 defect 1, and the reason the name is computed before `create` is issued at all).

### §165. Create, not run: it exists but has not started

2. CREATE (not run). The container exists but has not started; `docker cp` requires exactly that state.

```text
 INSIDE THE `try`, WITH THE NAME ALREADY DECIDED — the two halves of the fix, and
 neither works alone.
```

### §166. Unlinked the instant create returns, either way

UNLINKED THE INSTANT `create` RETURNS, on the failure path too. Docker has read the file by then; nothing later in the run needs it. The window is one `create`.

BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET (M23.5 census). This is CLEANUP of a mode-0600 credential file, and the commonest way to reach it with nothing left is that `create` is what spent the budget — so refusing it would leave the credential on disk for `reap()` to find later, which is the wrong direction. It still may not hang: an unbounded `unlink` on a wedged mount holds `run()` open exactly like an unbounded copy.

AND IT IS IN THE MODEL, WHICH IS THE PART THE ROUND THAT WROTE THIS COMMENT MISSED. The sentence above says "bounded like a teardown"; the census that built `RUNNER_POST_DEADLINE_CALLS` asked what the TEARDOWN `finally` issues and never saw this line, so `run()` overran its own stated bound by one whole `RUNNER_BOUNDED_CALL_WORST_CASE_MS` — past the host's SIGKILL, which is a second `tofu apply`. `withPostDeadlineBound` is now the only way to reach here.

### §167. Already redacted, fallbacks already applied

ALREADY REDACTED, and the `?? ""` / `?? message` falls already applied — they moved into `RunnerLaunchError` so that a captured failure and a thrown one cannot drift apart.

AND THE DIAGNOSIS IS NOW KEPT — MEDIUM (verification pass 5). This is the ONLY step whose failure is captured instead of thrown, and it is the step that spends essentially all of a real run's budget, so everything this catch dropped was dropped on the commonest failure path in the product. It kept `stdout`/`stderr` alone; `promisify(execFile)` always supplies `stderr` as a string, so a budget-kill with no output and a silent non-zero exit both arrived here as two empty strings and left as the same `{ succeeded: false, stdout: "", stderr: "" }` — `detail: ""` in managed-iac's durable ledger, in every `status()`, and in reconcile's Decision `inputContext`.

### §168. 6. Destroy the container unconditionally

6. Destroy the container unconditionally — BY NAME, which is the identity that exists even when `create` is what failed. `docker rm -f` on a name that never existed exits ZERO (measured, Docker 29.5.2), so the no-container case costs one harmless daemon call. SWALLOWED, but not SILENT: a failed teardown here means a container may be about to orphan — `reap()` is the backstop, but the reason THIS teardown failed had nowhere to go before this line, which is a defect the same shape as the one this whole phase exists to close (a hazard with no reader). `NODE_DEBUG=scp-runner-launcher` surfaces it.

AND EXACTLY ONE THING IT MUST NOT DO — M23.1e. `create` failing BECAUSE THE NAME IS ALREADY TAKEN means the container behind that name is SOMEBODY ELSE'S, still running, and an unconditional `rm -f` here destroys it. That is not the orphan case this teardown exists for; it is the exact opposite of it. See `isContainerNameConflict` for the measured signal and for why the answer is not per-attempt unique names.

`execFixed`, NOT `exec`: the teardown is deliberately OUTSIDE the whole-run budget, since the commonest reason to reach it is that the budget is what ran out. Its own `RUNNER_REMOVE_TIMEOUT_MS` is what every golden records, and what `RUNNER_REAP_GRACE_MS` is sized against.

### §169. The default resolver every managed executor uses today

The default resolver every managed executor uses today: one adapter, Docker, built from the server-injected `dockerBinary`. M23.2 replaces this with a switch on an explicit operator setting — NEVER an auto-detection of the platform (M15.4 declined to create that runtime/install-time fork, and guessing from the presence of a service-account token is exactly that guess).

### §170. Recorded outcomes: every path out of trigger records one

RECORDED OUTCOMES — every path out of a plugin's `trigger()` records something, redacted (M23.1 phase 2). NOT a port concept: this holds no state and knows nothing about Docker. It exists here only because three plugins would otherwise duplicate it three times.

### §171. How a plugin writes one terminal outcome to its store

How a plugin writes ONE terminal outcome to whatever store it already keeps — an in-memory `Map` for managed-scan/managed-dep, a durable JSON file for managed-iac. May be async (a file write); `withRecordedOutcome` awaits it either way.

### §172. The fix for a path out of trigger that records nothing

THE FIX FOR "A PATH OUT OF `trigger()` THAT RECORDS NO OUTCOME" (BUILD_AND_TEST.md §4.4, CLAUDE.md incomplete-call-site-census). Before this, managed-scan and managed-iac each had a `trigger()` whose success path recorded an outcome but whose THROW path did not — a launcher failure, a `writeSourceFiles` refusal, a disk error, anything — escaped `trigger()` as a rejection instead, and left the run's own store with nothing keyed to it. `status()` then reports `pending` forever, indistinguishable from "still running". managed-dep's `trigger()` never had this hole (its whole body already sits in one big try/catch); this helper is that same shape, factored out so the other two stop being three hand-written copies of "wrap it in try/catch" that a fourth plugin would make four.

SUCCESS RECORDING IS UNCHANGED, DELIBERATELY. This only catches what `fn` THROWS. Each plugin still records its own success outcome from inside `fn`, in its own shape (managed-iac's carries a `stateRef`, managed-dep's a `result`/`merge`) — a shape this package has no business inventing a common ancestor for.

THE RECORDED DETAIL IS BOUNDED HERE, not by the plugin. `record`'s parameter is `BoundedDetail` precisely so a plugin cannot store the raw message: managed-iac's `record` writes to a durable, never-pruned JSON file and from there into a `Decision`'s `inputContext`, and the message of a `docker create` rejection contains the child's entire stderr. See `RUNNER_DETAIL_MAX_CHARS`.

`redact` IS NOT OPTIONAL AND IS NOT COSMETIC. A thrown `Error`'s `.message` is freeform text a plugin did not construct and cannot trust — for managed-iac specifically, a `docker create` rejection's message is `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=<value> …` before anything strips it, and whatever `record` does with the resulting `detail` (managed-iac's goes to a durable, replicated, backed-up JSON file and from there into a `Decision`'s `inputContext`) is exactly the channel CLAUDE.md's "a claim about a tool cannot be verified with that tool" warns about: `RunnerLaunchError` already redacts what IT knows to redact, but a plugin whose injected launcher throws something else entirely — a stub in a test, a future adapter, a bug — must not depend on that already having happened. `redact` is the plugin's OWN, independent knowledge of which values in its world are secret; managed-scan and managed-dep hold no credential, so theirs is the identity function, and that is a fact about THEM, not a default this package chose for them.

### §173. The message suffices for one adapter, not the other

M23.5 MEDIUM-8 — `.message` ALONE IS COMPLETE FOR DOCKER AND EMPTY OF THE REASON FOR KUBERNETES, and this used to read only `.message`. `RunnerLaunchError.message` is built from its CAUSE's `.message` (see the class doc, `causeMessage`): for the Docker adapter that cause is `promisify(execFile)`'s own rejection, whose `.message` already IS `Command failed: ...` plus the whole of stderr — nothing was ever missing there. The Kubernetes adapter's `api()` fails with a cause `{ message: "kubernetes POST /path -> HTTP 403", stderr: res.body }` — a deliberately short `.message` — and puts the API SERVER'S OWN RESPONSE BODY in `.stderr` instead: the quota text, the RBAC sentence, a 422's field path, an admission webhook's policy name. `RunnerLaunchError.stderr` carries it (see the class doc), already redacted the same way `.message` is — `causeMessage` and `this.stderr` both run through the same `redact` closure in the constructor — so appending it here adds no new redaction obligation. `create`, `secret-env` and `copy-in` failures reject `run()` directly (no `classifyRunnerFailure` runs for them — that only happens for `start`), so this was the ONLY place those three steps' failures were ever turned into a recorded detail, and it was dropping the one field the rejection existed to carry.

### §174. BOUNDED BEFORE `record` EVER SEES IT

BOUNDED BEFORE `record` EVER SEES IT. A thrown `Error`'s `.message` is freeform text this package did not compose — a `docker create` rejection carries the whole of stderr in it — and `record` writes to a store that is never pruned. Redact, then bound; both are the plugin's store's problem and neither is optional. `boundDetail` keeps the END, so the reason the throw happened survives the bound.

### §175. THE SECOND ADAPTER

THE SECOND ADAPTER (M23.2). Re-exported from the package entry point rather than reached by a subpath, because `package.json` declares only `main: dist/index.js` — a subpath would be a new packaging surface for one import. The re-export sits at the BOTTOM and `kubernetes-adapter.ts` imports only FUNCTIONS and CONSTANTS from here, so the module cycle resolves: nothing in that file reads a binding of this one at module-evaluation time. `kubernetes-adapter.test.ts`'s first case imports the package entry and calls `resolveRunnerLauncher`, which is what would fail loudly if that ever stopped being true.

## `packages/runner-launcher/src/kubernetes-adapter.kind.test.ts`

### §176. The Kubernetes adapter against a real API server

M23.2 — THE KUBERNETES ADAPTER AGAINST A REAL API SERVER (owner decision 3)

"A fake Kubernetes client only proves the adapter agrees with itself" — owner decision 3, BUILD_AND_TEST.md M23. `kubernetes-adapter.test.ts` drives every branch of the failure mapping cheaply and cannot answer a single question about whether any of it is TRUE of Kubernetes. This file answers those, and only those:

```text
1. The API server ACCEPTS the Job manifest `jobManifest()` builds. A fake accepts anything;
   a 422 on a mistyped field is invisible until production.
2. `suspend: true` then PATCH `false` really is create-then-start against a live Job controller
   — the decision the whole create/copy-in/start ordering rests on.
3. The `subPath` layout puts the copied bytes where the runner looks for them AND brings what it
   wrote back out. That is the entirety of owner decision 5's byte-movement story, and nothing
   short of a running pod can check it.
4. A duplicate `metadata.name` really is `409 AlreadyExists`, so `isKubernetesAlreadyExists`
   matches something real rather than a shape invented in a fixture.
5. An RFC3339 deadline really is rejected as a label VALUE and accepted as an annotation. That
   measurement is the reason `RUNNER_LAUNCHER_DEADLINE_ANNOTATION` exists; re-measuring it in CI
   is what keeps it a fact rather than a remembered one.
6. THE CHART'S OWN RBAC IS SUFFICIENT. `scripts/kind-runner-harness.sh` binds this token to the
   Role rendered by `helm template` from `deploy/helm/templates/runner-iac.yaml` — not to a
   hand-written copy — so every request below is authorised by exactly what a `helm install`
   grants. A verb the adapter needs and the chart does not grant is a 403 here.
```

WHAT IT STILL DOES NOT PROVE, said plainly: - Network containment. kind's kindnet does not enforce NetworkPolicy (re-measured with a known-positive control), so this cluster cannot speak to owner decision 1 at all. That stays with `scripts/airgap-drill.sh`, which installs Calico. - The in-cluster credential path. The adapter reads a PROJECTED service-account token from `/var/run/secrets/...` and trusts the cluster CA through `NODE_EXTRA_CA_CERTS`; this test process is outside the cluster, so it supplies the token from `kubectl create token` and the CA through a `fetchImpl`. The SHIPPED `createFetchKubernetesIo` is what runs — its header construction, its `AbortSignal.timeout`, its body serialisation and its status/text handling — and only the TLS trust anchor arrives by a different route than in a pod. - RWX. A single-node cluster has no RWX class; the workspace is a host directory kind mounts into the node. That proves the subPath layout and the byte movement, not that any particular storage class is ReadWriteMany. - The real runner images. `alpine:3.20` stands in — it is already in `tools/ci-mirror/images.list` and it has a shell, which is all three classes' observable behaviour reduced to one image. `managed-iac.integration.test.ts` still owns real-runner coverage on the Docker path.

NO SKIP PATH, DELIBERATELY. A `describe.skipIf(noCluster)` is how a gate becomes decorative: the job goes green having run nothing, which is the "checks that pass without running" class CLAUDE.md records. This file is run ONLY by `pnpm --filter @scp/runner-launcher test:kind`, from a CI job that stands the cluster up first, and it FAILS with a readable message when the harness is absent.

### §177. A fetch-shaped shim that trusts the cluster authority

A `fetch`-shaped shim over `node:https` that trusts the cluster CA.

IT EXISTS FOR ONE REASON AND CARRIES NO LOGIC. Node's global `fetch` cannot be given a custom CA without an undici Agent, which is why the two shipped in-cluster callers (`bundled-argocd-autowire-bin.ts`, `bundled-gitea-autowire-bin.ts`) rely on `NODE_EXTRA_CA_CERTS` being set in their Job spec — an environment variable Node reads at PROCESS START, which a test inside an already-running vitest worker cannot set. Everything else about the transport — authorization header, accept, content-type, timeout, JSON body, status and text — is the shipped `createFetchKubernetesIo`, which is the code that must be exercised.

### §178. Every case runs under the RBAC the chart rendered

EVERY CASE RUNS UNDER RBAC THE CHART RENDERED, NEVER UNDER A PERMISSION THE HARNESS HANDED ITSELF — that is the whole reason owner decision 3 required a real cluster ("a fake authorises everything"). The default namespace carries the chart's DEFAULT render, which since M23.4 means the per-run Secret grant is present; `perRunSecrets: false` switches to the namespace rendered at that value, and to that namespace's own token, so an opt-out case is exercised under exactly the grant a `helm install --set managedRunners.kubernetes.perRunSecrets=false` makes.

### §179. The self-heal: two findings that are one defect

THE SELF-HEAL — M23.5 verification pass 20, LOW-13 and LOW-14, WHICH ARE ONE DEFECT

WHAT HAPPENS WHEN THIS SUITE IS INTERRUPTED. A run stopped by a SIGTERM — Ctrl-C while iterating, a CI cancellation, a killed fork — leaves two things behind, and neither of the cleanups that exist is reached, because both of them run at the END of a process that no longer exists:

```text
1. A Job in the cluster. MEASURED: `scp-runner-quota-refused` survived, and the next run's
   `create` POST got the typed 409 the adapter is right to refuse on ("tearing down nothing:
   the Job behind this name belongs to that run" — that rule is load-bearing and stays). Four
   CONSECUTIVE red runs, then self-recovery, because `reap()` is SCHEDULED, NOT AWAITED (see
   `run()`) and therefore races the very `create` it would have unblocked. Re-measured here by
   seeding one leftover: ROUTE 1 red, and the leftover gone by the time the run finished — a
   gate red for a reason with nothing to do with the change under test, exactly while someone
   is iterating on it. Fresh CI clusters never see it, which is why it survived.
2. A scratch directory in `os.tmpdir()`. Ten were present at the last cleanup, several
   non-empty, spanning two sessions — despite LOW-12's `afterAll`, which is not bypassed by
   anything IN this file: it is bypassed by the process ending without running it.
```

SO THE CLEANUP MOVES TO THE FRONT. An `afterAll` is a promise about how this process will end; a `beforeAll` sweep is a statement about the state the suite starts from, and only the second survives the way the suite actually dies. The `afterAll` STAYS — it keeps the machine tidy on the normal path and it is what makes the leak rare — but nothing depends on it any more.

WHY THE SWEEP MAY DELETE WHAT `reap()` MUST NOT. `reap()` is production code against a shared cluster: it is fail-closed on the deadline stamp, because deleting a foreign Job whose deadline has not passed would destroy somebody's live `tofu apply`. These three namespaces belong to this suite and to nothing else, the config is `singleFork` and the harness script stands them up, so any launcher-labelled object here at `beforeAll` is debris from a process that is gone. That is the whole difference, and it is why the fix is HERE and not in the 409 path or in `reap`.

### §180. The hook made a directory once and nothing removed it

LOW-12 — `beforeAll` mkdtemp's ONCE per file and nothing removed it: 50 accumulated across repeat local runs of this suite. Each plugin's `runner-launcher-selection.test.ts` pairs its `mkdtemp` with a cleanup at the matching cardinality (`beforeEach`/`afterEach` there; `beforeAll`/`afterAll` here, since this file creates exactly one scratch dir for the whole suite, not one per test).

AND IT IS NO LONGER THE GUARANTEE — LOW-14, pass 20. Ten dirs were present at the next cleanup anyway, several non-empty, spanning two sessions: nothing in this file bypasses this hook, the PROCESS ENDING WITHOUT RUNNING IT does, which is every Ctrl-C and every cancelled CI job. What makes the leak self-healing is `sweepStaleScratchDirs` in `beforeAll`; this stays because it keeps the normal path clean and makes the leak rare, not because anything now depends on it.

### §181. A whole run proves the adapter's own call sequence

"A WHOLE RUN" above proves the adapter's OWN two-step call sequence produces a successful run end to end — which a single-step, always-unsuspended adapter would ALSO pass. It never queries the API server between `create` and `start`, so nothing in this suite actually watched the suspended Job have no pod. This test does, directly against the controller and without racing the adapter's own internal timing: it builds the SAME manifest `jobManifest()` produces, applies it with `kubectl` (deterministic, not a hope of catching a window `run()` closes in milliseconds), and checks the controller's real behaviour at each half.

### §182. A subresource is not what the plain question asks

`pods/log` IS A SUBRESOURCE AND `can-i get pods/log` DOES NOT ASK ABOUT ONE — a false positive this test carried until M23.6, found by narrowing the Role. `kubectl auth can-i` reads `resource/name` as "this verb on the OBJECT NAMED name" (its own usage string says "verb resource or verb resource/resourceName"), so `get pods/log` was asking whether the ServiceAccount may GET a pod called "log". The Role at the time granted `get` on `pods`, so it answered "yes" — for a reason that had nothing to do with reading a log. Splitting `pods` down to `list` turned that "yes" into a "no" and exposed it. `--subresource=log` is the question that was meant, and it answers "yes" against the same Role.

### §183. AND THE OTHER DIRECTION, AGAINST THE REAL AUTHORIZER

AND THE OTHER DIRECTION, AGAINST THE REAL AUTHORIZER (M23.6 clause 5). Every check above is "the answer was yes", and a Role granting `*` on everything answers yes to all of them. These are the verbs the chart USED to grant and the adapter has never issued: `watch` on both resources (this adapter POLLS — see `KUBERNETES_POLL_INTERVAL_MS`'s doc — and there is no `watch=` query anywhere in it), and the two halves of the `pods`/`pods/log` collapse, which gave each resource the other's verbs. `tools/helm-verify` diffs the rendered rules against `kubernetesRunnerRbac()` as a set; this is the same claim asked of a real API server, which is the only thing that can say what the Role MEANS rather than what it says.

### §184. The cluster-scoped question nothing here had asked

AND THE CLUSTER-SCOPED QUESTION NOTHING HERE HAD EVER ASKED (M23.6, second pass). Every narrowness assertion above is about `batch/jobs` and `pods` — the resources the Role names. The M23.6 verification pass pointed a real authorizer at this identity and asked `delete nodes`, which no assertion in this repository covered, because "the chart grants exactly what the adapter calls" had only ever been checked against ONE Role's `rules` array. `tools/helm-verify` now refuses a ClusterRole or ClusterRoleBinding in every render AND in every template; this is the same claim asked of a real API server, which is the only thing that can say what the whole cluster's RBAC adds up to for this ServiceAccount rather than what one manifest says.

### §185. AND THE TWO VERBS IT DID NOT

AND THE TWO VERBS IT DID NOT. These are narrowness assertions AND the negative controls in one: every assertion above is "the answer was yes", which is also what a broken `canI` that always returned "yes" would produce, and what a `--as` that silently fell back to the cluster-admin kubeconfig would produce too. A cluster-admin fallback answers "yes" to `list secrets`; the real Role does not, so these "no"s are what make the yeses mean something.

### §186. The chart's reference Job shape, asserted here too

`deploy/helm/templates/runner-iac.yaml`'s reference Job shape asserts `runAsNonRoot: true`, and a filterless read of apps/runner-{iac,scan,dep}/Dockerfile finds no `USER` line in any of them. This is that combination, executed: the kubelet refuses the container before the entrypoint, and the adapter must call it `spawn-failed` ("nothing ran, so nothing was mutated") rather than polling to the deadline and reporting `budget-exhausted` — which for managed-iac would mean "a tofu apply was SIGTERMed mid-flight, so the real infrastructure state is unknown".

### §187. The in-cluster credential path the earlier pass could not

M23.4 — THE IN-CLUSTER CREDENTIAL PATH, WHICH M23.2 SAID IT COULD NOT PROVE

M23.2 shipped `secretEnv` as a declared, DISABLED capability and listed the in-cluster credential path as one of the two things it could not prove: the grant did not exist, so the code could only be exercised in a namespace the harness had opted into, and nothing showed what a real credential does on the way through. With the owner's grant (2026-08-20) it is provable, so these cases prove it — a real value, delivered through a per-run Secret, reaching the runner's environment, and appearing in NO argv, NO log, NO API object a reader can list, and nothing left behind.

EVERY SWEEP HERE HAS A NON-VACUITY CONTROL, and the last case in this block IS that control: the same probe, run against a credential deliberately delivered the WRONG way (`env[].value`), must FIND it. A sweep that cannot fail is a sweep that proves nothing, and this suite has already been bitten by tests that were green for the wrong reason.

### §188. (1) NOT IN ANY API OBJECT A READER CAN LIST

(1) NOT IN ANY API OBJECT A READER CAN LIST. The Job carries the container's `args` (this adapter's argv), its `env`, its labels and its annotations; the pod carries the resolved spec; events carry the kubelet's own messages. The credential is in exactly one object — the Secret — and a `get secrets -o name` proves the sweep saw that namespace at all without reading a single body.

### §189. The one that matters, and the reason for the reordering

THE ONE THAT MATTERS, AND THE WHOLE REASON FOR THE ORDERING CHANGE. M23.1d's lesson is that no `finally` survives a SIGKILL: the plugin host's hang detector kills a subprocess mid-`trigger()` and nothing in that process runs again. Docker had no analogue for `ownerReferences`, so the answer there had to be a sweep. Here the deletion is the cluster's obligation, and this case proves it the only way that means anything — by taking the launcher out of the picture and watching the Secret go anyway.

THE JOB IS DELETED FROM OUTSIDE, which is what `ttlSecondsAfterFinished`, an operator's `kubectl delete job`, and a SUCCESSOR process's `reap()` all reduce to. The launcher's own teardown never runs against this object — its subsequent DELETE 404s, which is why the run's rejection is caught and discarded.

### §190. AND THE VACUITY THIS CASE HAS TO CLOSE

AND THE VACUITY THIS CASE HAS TO CLOSE: the launcher's OWN teardown would eventually delete this Secret too, when the run ends. If the observation window overlapped that, the case would pass whether or not the ownerReference existed. So the run is given a 30-SECOND budget, the moment of the Job deletion is timed, and the collection must be observed in the FIRST HALF of that budget — a window in which the launcher is provably still parked in its `start` poll and has issued no DELETE at all. `settled` is the second half of the same guard.

### §191. Without this, every absence assertion is unfalsifiable

WITHOUT THIS CASE EVERY "not.toContain(CREDENTIAL)" ABOVE IS UNFALSIFIABLE. A typo in the constant, a `kubectlIn` that silently returned "", a namespace with nothing in it — all three produce a clean sweep. So: deliver the SAME value the way the port exists to prevent (`env[].value`, which is what a fallback would do), run the identical probe, and require it to HIT. If this case ever goes green-by-passing, the sweep is broken and the cases above are lies.

### §192. The gate for the sweep, or it pins nothing

THE GATE FOR THE `beforeAll` SWEEP, and without it the sweep is a mechanism nothing pins: every case in this file passes whether or not it runs, because a clean cluster has nothing to sweep. So the debris is SEEDED, in the exact shape a killed run leaves it, and the two halves are asserted separately.

THE DEADLINE IS IN THE FUTURE, DELIBERATELY. `reap()` is fail-closed on the stamp — it must be, because on a shared cluster a foreign Job inside its deadline is somebody's live `tofu apply` — so `reap()` will never take this object, at any point, on any later run. That is the arm that proves the sweep is doing work `reap()` cannot, rather than duplicating it: the seeded Job is exactly what a SIGTERM at second 3 of a 120s run leaves behind.

### §193. 3. AND THE PROOF THAT IT IS THE 409 THAT WAS HEALED

3. AND THE PROOF THAT IT IS THE 409 THAT WAS HEALED: the name is usable again. This is the assertion the four measured red runs were failing. THE QUOTA NAMESPACE'S FULL CONVENTION SET, which is ROUTE 1b's verbatim — `limits.cpu` AND `limits.memory`. Measured the hard way: with `limits.memory` alone the admission refusal is "must specify limits.cpu", the Job creates no pod, and this arm polls its whole budget before failing for a reason that has nothing to do with the sweep.

### §194. THE MEASUREMENT THAT STARTED THIS

THE MEASUREMENT THAT STARTED THIS. The image is ALREADY ON THE NODE (the harness `kind load`s it) and this cluster has no registry credentials and, for a `:latest` tag, no reason to believe the local copy. Kubernetes defaults an unset `imagePullPolicy` to `Always` for `:latest`, so the kubelet reaches for docker.io and the run dies before its entrypoint — charter principle 5, broken in production, by an omission in a manifest builder.

NOTHING ABOUT THIS IS VISIBLE TO A FAKE: it needs a kubelet, a node with an image on it, and a registry it cannot reach.

### §195. The route no fake can produce, and the third namespace

THE ROUTE NO FAKE CAN PRODUCE AND THE WHOLE REASON THE THIRD NAMESPACE EXISTS. The Job is ACCEPTED and unsuspended; the Job CONTROLLER then tries to create a pod and admission refuses it, so no pod is ever created. `kubernetesTermination` reads `pod.status.containerStatuses` and nothing else, so before M23.5 the adapter polled to the whole-run deadline and reported `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — for a run in which NOTHING RAN. The refusal's only record is the controller's `FailedCreate` Event, and teardown deletes the Job.

### §196. AND THE BOUND IS REPORTED AS IT WAS

AND THE BOUND IS REPORTED AS IT WAS — M23.5 verification pass 20. This run really did poll to its 20s deadline, so `true` is the fact; `spawn-failed` is what the producer DECLARED about the runner, and `classifyRunnerFailure` now reads that declaration ahead of the flag instead of relying on the flag being suppressed. The assertion here was `false` while the run's own message named the budget, which is the contradiction pass 20 removed.

### §197. THE ONE ROUTE WHERE SOMETHING DID RUN

THE ONE ROUTE WHERE SOMETHING DID RUN — a node drain, an eviction — and the reason the `everStarted` flag exists rather than being re-derived from whatever is left. Reporting this as `spawn-failed` would claim nothing was mutated, which is the OPPOSITE lie to the one being fixed. Measured rather than assumed: with `backoffLimit: 0` a deleted pod really does make the Job report `Failed`/`BackoffLimitExceeded` rather than creating a replacement.

### §198. THE PROBE THAT FOUND THE DEFECT, KEPT AS A GATE

THE PROBE THAT FOUND THE DEFECT, KEPT AS A GATE — and only a real cluster can run it, because the whole point is that the Job, the pod, the kubelet and the volume are real while the LAUNCHER'S VIEW of them is not.

WHAT IS FAKED IS EXACTLY ONE THING: the pod reads never land. That is an API-server stall or a partition, and it is the shape measured in the field. Everything else is real — the unsuspend PATCH reaches the real API server and succeeds, the real Job controller creates a real pod, the real kubelet pulls and runs the real container, and the container writes a REAL FILE to the REAL shared volume, which this test reads off the disk as ground truth.

WHAT THE LAUNCHER USED TO RECORD FOR THIS RUN: kind=spawn-failed code=RunnerContainerNeverStarted deadlineExceeded=false spawn-failed: the container CLI could not be executed at all — nothing ran … so NOTHING RAN and nothing was mutated — the Job had not yet been observed with `marker.txt` on the volume saying `THE-RUNNER-RAN-AND-MUTATED`. The clause that disproves the sentence is inside the sentence.

### §199. The same defect, through the arm left standing

THE SAME DEFECT, THROUGH THE ARM PASS 18 LEFT STANDING. Pass 18 split `!everStarted` into "never observed" (arm 6, `outcome-unknown`) and "observed, nothing had started" (arm 7, `spawn-failed`, "NOTHING RAN and nothing was mutated"). It moved the boundary to WHETHER a read landed and not to WHEN it landed or WHAT it said.

So: let exactly ONE `GET pods` through — the one the adapter issues immediately after the unsuspend, before the Job controller has created a pod — and stall every read after it. The observation is real, it is 25 seconds stale by the deadline, and it says only "not yet". `kubernetesStartVerdict` reaches arm 7 and the record says the run never started.

ONLY A REAL CLUSTER CAN JUDGE IT, for the same reason as the case above: the Job, the pod, the kubelet, the container and the file are real; only the launcher's view of them is not.

## `packages/runner-launcher/src/kubernetes-adapter.test.ts`

### §200. The adapter at the seam that records every effect

M23.2 — THE KUBERNETES ADAPTER, AT THE SEAM THAT CAN RECORD AND HOLD EVERY EFFECT

WHAT THIS FILE IS AND IS NOT. It is the Kubernetes counterpart of `docker-adapter.test.ts`: it proves WHAT the adapter sends and, through `ordering-conformance.ts`, WHEN. It cannot prove that an API server accepts any of it, that a Job actually runs, that a `subPath` mount lands the bytes where the runner looks for them, or that a pod's log is readable — a fake agrees with itself by construction, and owner decision 3 says so in those words ("a fake Kubernetes client only proves the adapter agrees with itself"). `kubernetes-adapter.integration.test.ts` drives a REAL kind cluster for exactly that, and the two are complementary rather than redundant: the real cluster is the only thing that can speak to acceptance, and this file is the only thing that can drive every branch of the failure mapping cheaply on every PR.

THE DOCKER PATH IS UNTOUCHED BY EVERYTHING HERE. No file in `packages/plugins/*` moves, and the three `launch-argv.golden.test.ts` files do not move by a byte — the whole point of M23.1's port.

### §201. A FAKE API SERVER AND A FAKE SHARED VOLUME

A FAKE API SERVER AND A FAKE SHARED VOLUME.

Deliberately STATEFUL rather than a canned response list: the adapter POSTs a Job and then PATCHes and DELETEs it BY NAME, and a response list cannot notice that the name it is asked about is not the name it was given. The fake stores what it was sent and answers from it, so a step aimed at the wrong object 404s here for the same reason it would against a real API server.

### §202. WHICH PORT STEP AN OP MARKS

WHICH PORT STEP AN OP MARKS — the Kubernetes spelling of `docker-adapter.test.ts`'s `stepKind(args)`, and derived the same way: from what was SENT, not from a flag the adapter set for the test's benefit.

ONLY THE FIRST OP OF EACH STEP MARKS IT, and the rule is structural rather than a de-duplication hack: `start` is one PATCH followed by N status GETs and one log GET, and `teardown` is a Job DELETE followed by a Secret DELETE and a directory removal. The op that MARKS the step is the one that cannot happen twice — the PATCH, the Job DELETE, the Job POST — so a step is recorded exactly once no matter how long its tail is. Everything else returns `undefined` and is invisible to `issued()`, including the `reap()` listing GET that every `run()` schedules.

### §203. The API server stamps a uid, so this fake does too

THE API SERVER STAMPS `metadata.uid` ON CREATE, AND THIS FAKE HAS TO TOO — not for realism's sake but because the adapter READS it: the per-run Secret's `ownerReference` needs the Job's uid, and a fake that echoed the POSTed body unchanged would make every `secretEnv` run refuse with "the Job create response carried no metadata.uid". Monotonic rather than random so a RECREATED Job of the same name gets a DIFFERENT uid, which is the property the stale-owner arm below turns on.

### §204. KUBERNETES' GARBAGE COLLECTOR, MODELLED

KUBERNETES' GARBAGE COLLECTOR, MODELLED — and it is modelled because the adapter DEPENDS on it. `ownerReferences` is what makes the per-run Secret's deletion survive a SIGKILL of this process, and a fake in which deleting a Job left its owned Secret behind would let a regression that dropped the `ownerReference` pass every unit test in this file. The real behaviour is proved against a real API server in `kubernetes-adapter.kind.test.ts`; this is the model that keeps the unit suite from being wrong in the same direction.

### §205. THE ADAPTER'S OWN DEFAULT, NOT `1`

THE ADAPTER'S OWN DEFAULT, NOT `1` — M23.5 verification pass 19. `sleep` is stubbed to resolve immediately below, so this number is NEVER A DELAY here: it costs the suite nothing, and it is read as a FACT by `kubernetesStartVerdict` ("how old may a landed observation be and still speak for the budget?"). At `1` every fixture's blind window was a hundred poll intervals wide and the arm that reasons about staleness could not be exercised honestly.

### §206. THIS IS NOT THE MODULE-CYCLE PROOF, AND IT SAID IT WAS

THIS IS NOT THE MODULE-CYCLE PROOF, AND IT SAID IT WAS. The sentence here used to read: "if any binding of this file's imports were read at module-evaluation time rather than at call time, THIS line would throw a TDZ ReferenceError before the assertion." It was measured false one commit later — `kubernetes-adapter.ts` had exactly such a top-level read (`RUNNER_LAUNCHER_DEADLINE_ANNOTATION = RUNNER_LAUNCHER_DEADLINE_LABEL`), this case stayed GREEN, and the built package could not be imported by Node at all: every managed plugin subprocess died at load. Vitest resolves the cycle through its own module graph in the other order, so a claim about Node's loader cannot be checked here at all. `module-load.integration.test.ts` builds the package and loads it with `node`, which is the only instrument that can settle it. What THIS case still proves is the ordinary thing its name says: an unset `runnerLauncher` yields a working Docker launcher.

### §207. The mutation table found two links nothing gated

THIS TEST EXISTS BECAUSE THE MUTATION TABLE FOUND TWO LINKS NOTHING GATED, and both are the component-built-never-installed shape. `kubernetes-launch.golden.test.ts` calls `jobManifest` DIRECTLY, so it stays green when the block never reaches it; `managed-runner-selection.test.ts` reads `managedRunnerSettings()`, so it stays green when nothing consumes what that returns. Deleting `...(k8s.pod ? { pod: k8s.pod } : {})` from `resolveRunnerLauncher`, or `...(config.pod ? { pod: config.pod } : {})` from the `create` step, reddened NOTHING across all three suites: a channel built end to end and connected in the middle by nobody.

So this drives the SHIPPED selection path and reads the bytes that were actually POSTed.

### §208. Never terminal: the loop spins until the deadline

Never terminal: the poll loop spins until the deadline, exactly as a wedged runner would.

THE FIXTURE WAS NOT WHAT ITS COMMENT SAID, and M23.5 is where that mattered. `containerStatuses: []` on a `Running` pod is a shape no kubelet produces — a pod is `Running` only once every container has been created — and the distinction was invisible while every non-terminal poll had the same verdict. It does not any more: a run where the container never started is `spawn-failed` ("nothing ran"), not `budget-exhausted` ("SIGTERMed mid-flight, state unknown"). So the wedged runner is now described as a wedged runner: RUNNING, and never finishing.

### §209. The three routes that all reported budget exhausted

M23.5 — THE THREE ROUTES THAT ALL REPORTED `budget-exhausted` AFTER BURNING THE WHOLE BUDGET

`kubernetesTermination` reads `pod.status.containerStatuses` AND NOTHING ELSE. Every route below was measured on a real cluster, and every one produced the identical verdict — "the whole-run budget ran out and the runner was stopped mid-flight" — which for managed-iac means "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown". Two of the three ran NOTHING. `FATAL_WAITING_REASONS`' own doc calls that "the single worst misdiagnosis available here", about a set that catches a container the kubelet refused; these are the routes where no container was ever asked for, and nothing looked at them.

AND THE EVIDENCE WAS BEING DELETED. Nothing read `job.status.conditions` or the Job's events, and teardown deletes the Job — so the only record of a `FailedCreate` went with it. It is read here while the run is still alive.

### §210. AND THE BOUND THAT ENDED IT IS REPORTED, NOT SUPPRESSED

AND THE BOUND THAT ENDED IT IS REPORTED, NOT SUPPRESSED (M23.5 verification pass 20). This asserted `false` while the run had polled to the deadline and the message said so, because the producer forced the flag down to keep `budget-exhausted` from winning the classification. `classifyRunnerFailure` now tests `RUNNER_NEVER_STARTED_CODE` itself, ahead of the flag, so the KIND is settled by what the producer declared and the FLAG is free to say which clock ran out. The two answer different questions; they were one field.

### §211. The verdict follows observed facts, not the clock

M23.5 D2 + D3 — THE VERDICT IS A FUNCTION OF OBSERVED FACTS, NOT OF WHERE THE CLOCK WAS NOTICED

TWO DEFECTS, ONE PROPERTY. `budget-exhausted` beat `spawn-failed` 6 runs in 20 (D2) and `exit-nonzero` beat `signalled` 6 runs in 10 against a real cluster (D3), and both are the same thing: a verdict decided by WHICH LINE of the control flow happened to observe the state, rather than by what the state WAS.

### §212. MODELS `AbortSignal.timeout(req.timeoutMs)` FIRING

MODELS `AbortSignal.timeout(req.timeoutMs)` FIRING — the way a real transport discovers the deadline. The request is ISSUED with what little was left of the budget (the deadline had not passed when `spend` checked), the clock crosses while it is in flight, and it rejects. This is the shape a guard placed before the call cannot cover, because the guard and the call are not atomic — which is why moving the guard to the top of the loop fixed nothing.

### §213. THE ARM THE PREVIOUS ROUND'S FIX COULD NOT PASS

THE ARM THE PREVIOUS ROUND'S FIX COULD NOT PASS. A check at the top of the poll loop reads the clock and then issues `GET pods`; the clock can cross in between, and then the REQUEST reports the deadline instead. The same is true of `GET events`, `GET job` and `GET log` — four places to discover it, every one of which used to yield "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" for a run in which NOTHING EVER STARTED.

### §214. The one place the deadline fires with the answer known

THE ONE PLACE THE DEADLINE CAN FIRE WITH THE ANSWER ALREADY KNOWN. `termination` says the runner exited 3; the log is DIAGNOSIS, read afterwards. Letting a refused log read throw replaces "the runner exited 3" with "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — discarding a known outcome for the worst sentence this package produces, at the last possible moment.

### §215. M23.5 VERIFICATION PASS 18

M23.5 VERIFICATION PASS 18 — WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY

`!everStarted` MEANT TWO THINGS AT ONE SITE. "Observed, and nothing had started" — the fact D2's fix rests on — and "never observed at all", which is not a fact about the run at all. The second was unguarded, and MEASURED against a real cluster it is the one that happens: the unsuspend PATCH reaches the API server and succeeds, every `GET pods` after it stalls past the budget, the real Job and the real kubelet do the work, a real container writes a real file to the real volume — and the durable record says `spawn-failed: … so NOTHING RAN and nothing was mutated — the Job had not yet been observed`. THE EVIDENCE THAT THE CLAIM IS UNFOUNDED IS IN THE SAME SENTENCE AS THE CLAIM.

TWO MUTATIONS SURVIVED THE WHOLE SUITE BEFORE THESE CASES EXISTED, and each has its arm below: S1  `let waiting = "the Job had not yet been observed"` -> "the pod was observed and no container had started": a lie about what was observed, in the operator-facing detail. 377/377 green. Nothing pinned the never-observed case at all. S2  `api()`'s `const deadlineExceeded = runDeadline.spent()` -> `= true`: 377/377 unit AND 18/18 kind green. Nothing pinned that a transport failure with budget LEFT is not a budget exhaustion, in either adapter's spelling.

### §216. A TRANSPORT THAT ANSWERS NOTHING

A TRANSPORT THAT ANSWERS NOTHING — `AbortSignal.timeout` firing on every `GET pods`, which is what an API-server stall or a partition looks like from inside this adapter. Unconditional, unlike D2's `abortingPodGetIo`, which only fires near the deadline and therefore always leaves the run an observation to reason from: the WHOLE point here is a run that never gets one.

`letThrough` reads succeed first, so the same fixture produces the negative control — one landed observation, and the verdict is entitled to say nothing started again.

### §217. Without this arm, calling every deadline unknown passes

WITHOUT THIS ARM, "call every deadline `outcome-unknown`" passes the case above — and ROUTE 1 and ROUTE 2, where the cluster SAID why it could not start the pod, would stop telling an operator that nothing was touched. The distinguishing fact is a read that COMPLETED, AND that is no older than one poll interval when the budget runs out (pass 19: the second half was missing, and the title of this case used to claim ONE landed read was enough on its own).

### §218. THE DEFECT PASS 18 LEFT STANDING, at the seam

THE DEFECT PASS 18 LEFT STANDING, at the seam. Its fix moved the boundary to WHETHER a read landed — not to WHEN. Let exactly ONE `GET pods` through, the one issued immediately after the unsuspend and before any pod exists, then stall every read after it: `observed` is true, arm 6 is skipped, and arm 7 said "NOTHING RAN and nothing was mutated" about the 990ms of the budget that nothing in this process could see.

`kubernetes-adapter.kind.test.ts` runs the same shape against a REAL cluster, where the pod, the container and the file it writes are real. This arm is the cheap gate for the same property; that one is the proof that the property matters.

### §219. A transport consuming all but a sliver of its bound

A TRANSPORT THAT CONSUMES ALL BUT `shortfallMs` OF THE BOUND IT WAS HANDED, AND THEN REJECTS — M23.5 verification pass 20, and the ONE fixture in this file that does not let real time decide how much of the bound was used.

WHY IT HAS TO MOVE THE CLOCK ITSELF. Every other fixture here waits `req.timeoutMs + 5` on a real `setTimeout`, so it always OVERSHOOTS the bound — and `Date.now() - issuedAt >= boundGiven` is true for an overshoot with or without the slack `api()` subtracts. That is exactly why removing the slack survived 392 unit and 20 kind cases. The case that separates them is an UNDERSHOOT of less than a millisecond, which is what a real `AbortSignal.timeout` produces: it fires on a libuv timer and `issuedAt`/`Date.now()` come from the wall clock, the sub-millisecond disagreement D4 already measured turning a budget kill into a verdict about the tenant's runner. A real `setTimeout` cannot be asked to fire early, so the clock is faked and stepped by an exact amount instead — `toFake: ["Date"]` only, so every `setTimeout` in the adapter (the poll sleep, `withStepBound`'s abandon timer) is still a real one.

### §220. THE MUTATION THAT SURVIVED EVERYTHING

THE MUTATION THAT SURVIVED EVERYTHING. `api()` asks whether the request consumed the bound it was handed:

Date.now() - issuedAt >= boundGiven - RUNNER_MIN_STEP_BUDGET_MS

and dropping the `- RUNNER_MIN_STEP_BUDGET_MS` passed 392/392 unit and 20/20 kind, because every fixture in both suites overshoots its bound on a real timer. A real transport does not: an `AbortSignal.timeout` fires on a libuv timer while `issuedAt` and `Date.now()` are wall clock, so the measured elapsed can land a hair SHORT of the bound that ended the request.

WITHOUT THE SLACK THAT MISS BECOMES `deadlineExceeded: false`, the verdict falls out of arm 7 into arm 8, and the record turns from "the runner container never started within the whole-run budget … NOTHING RAN" into `outcome-unknown` — "check the target's real state before re-running". A FALSE UNKNOWN sends an operator to inspect infrastructure after a transient, which is the same family of defect as a verdict that depended on WHERE the deadline was discovered, one order of magnitude smaller.

ONE MILLISECOND SHORT, DELIBERATELY: inside `RUNNER_MIN_STEP_BUDGET_MS`, so the slack is what decides the answer and nothing else is.

### §221. Without this arm, always-exceeded passes the case above

WITHOUT THIS ARM, `deadlineExceeded = true` passes the case above — and S2's whole finding (a reset with budget left is not a budget exhaustion) would stop being pinned at the one site that can now tell the two apart by a measured margin rather than by which fixture was used. 60ms of a 200ms bound is six times `RUNNER_MIN_STEP_BUDGET_MS`, so 60ms of budget really is left: this transport broke, it did not run out of time.

### §222. The arm where the mutation changes the sentence too

THE ARM WHERE S2'S MUTATION CHANGES THE SENTENCE AND NOT ONLY THE FLAG. One `GET pods` lands (the pod is Pending, nothing started), the next resets, and 10 seconds of budget remain — so the Job is still perfectly able to start a pod after this run stops looking. With `deadlineExceeded` forced true this becomes `spawn-failed`: "NOTHING RAN and nothing was mutated", asserted about a Job that is still live.

### §223. The same class from the RBAC side, live for a release

THE SAME CLASS FROM THE RBAC SIDE, and it was live for a release: the chart's Role granted `create,get,list,watch,delete` on `batch/jobs` and NO `patch`, so `start` was a 403 on every managed run. A numeric `code` is what `classifyRunnerFailure` reads as an exit status, so an operator was told "the runner itself exited non-zero" — code 403 — about a Job that never left `suspend: true`.

### §224. THE THIRD INSTANCE THE CENSUS TURNED UP

THE THIRD INSTANCE THE CENSUS TURNED UP. M23.5 made a log read REFUSED BY THE DEADLINE degrade, and left every other way it can fail — a Role without `pods/log`, a 500, a reset — able to replace the verdict exactly as before. A 403 is a NUMERIC `code`, so the operator was told "the runner itself exited non-zero" with 403 as the exit status, about a runner whose real exit code (3) this process was holding at that moment.

### §225. THE KNOWABLE HALF OF "NOBODY ANSWERED"

THE KNOWABLE HALF OF "NOBODY ANSWERED". A copy-in on a slow network filesystem finishes legitimately, inside its own bound, with nothing left for the step after it; `spend` then refuses the unsuspend BEFORE issuing it, so the Job is exactly as `create` left it. Sweeping this into `outcome-unknown` would tell an operator to go and inspect infrastructure that was never touched — a weaker claim than the truth is still the wrong claim.

### §226. AND THE BOOLEAN AGREES WITH THE SENTENCE

AND THE BOOLEAN AGREES WITH THE SENTENCE — M23.5 verification pass 20, MEDIUM.

This record used to read `deadlineExceeded: false` under a message that begins "the whole-run budget of 300ms (RunnerSpec.timeoutMs) was already spent when this run reached 'start'". The budget PROVABLY ended this run — that is the entire reason the unsuspend was never issued, and the remedy an operator needs is to raise `timeoutMs` — and the one field a caller is told to read as "which bound ended the run" denied it. Nothing pinned either half, so the flip is pinned in BOTH directions here: the flag is true, and the kind stays `spawn-failed` rather than becoming `budget-exhausted` ("SIGTERMed mid-flight") about a Job still sitting at `suspend: true`.

### §227. The opt-out arm comes first because it is what inverted

THE OPT-OUT ARM COMES FIRST BECAUSE IT IS THE ONE THAT INVERTED. Until M23.4 `perRunSecrets` defaulted to false and this was the shipped behaviour of every Kubernetes deployment; the owner granted the RBAC on 2026-08-20, so the chart now renders the rule by default and this is what an operator who deliberately turns it back off gets. It has to stay a loud refusal either way — the failure it replaces is a 403 from inside a promotion, minutes in.

### §228. The credential's lifetime is the job's, cluster-enforced

M23.4 — THE CREDENTIAL'S LIFETIME IS THE JOB'S, ENFORCED BY THE CLUSTER AND NOT BY A `finally`

WHY THIS BLOCK EXISTS AT ALL. M23.1a moved the credential out of the `docker create` argv; M23.1d then found that the mode-0600 `--env-file` it moved into was left on disk whenever the plugin host SIGKILLed the subprocess mid-`trigger()`, because no `finally` survives a SIGKILL. That defect is now reachable on the OTHER adapter, in a worse place: a Kubernetes Secret does not sit on one machine's disk, it sits in etcd and in every etcd backup, replicated across the control plane. The answer is not a better `finally`. It is `ownerReferences` — the cluster deleting the Secret because the Job it belongs to is gone, whether or not this process still exists.

### §229. The uid comes from the create response

THE UID COMES FROM THE CREATE RESPONSE, and this is the assertion that a `uid: jobName` or a `uid: ""` regression fails: the fake stamps `uid-N` on create, so a uid derived from anything the adapter already knew would not match. An ownerReference with a WRONG uid is worse than none — the collector treats the owner as already deleted and removes the Secret out from under a live run, which is a `CreateContainerConfigError` on a pod that has not started yet.

### §230. THE ONE THAT MATTERS, AND THE ONE NO `finally` CAN PASS

THE ONE THAT MATTERS, AND THE ONE NO `finally` CAN PASS. The plugin host's hang detector (`apps/server/src/plugin-host/host.ts`) SIGKILLs a subprocess mid-`trigger()`. Modelled here the only way a single process can model its own death: the run is PARKED at `start` and then never touched again — no teardown, no `finally`, not one further op from the launcher — and the Secret's disappearance is caused entirely by the Job going away.

### §231. M23.4 INVERTED THIS CASE, AND THE INVERSION IS THE POINT

M23.4 INVERTED THIS CASE, AND THE INVERSION IS THE POINT. Until M23.4 the Secret POST came FIRST, so a 409 there meant "another run holds this runId" and the correct response was to touch nothing at all. Now the JOB POST stakes the name (which is what lets the Secret carry an `ownerReference` to it), so a Secret 409 is only reachable AFTER a Job POST that did NOT 409 — i.e. this run owns the name, and what is behind it is a Secret whose owning Job is gone. Two different objects, two different owners, two different answers: - the Job this run just created is ITS OWN, so teardown deletes it; - the Secret is not, so nothing here deletes it. The collector will, because its `ownerReference` no longer resolves.

### §232. AND YET THE DEBRIS IS GONE BY THE END OF THE RUN

AND YET THE DEBRIS IS GONE BY THE END OF THE RUN — collected, not deleted. The assertion directly above is what makes this one mean something: no `DELETE .../secrets/...` was issued by the adapter at all, so the only thing that could have removed it is the garbage collector reacting to the Job teardown, which is precisely the mechanism the whole ordering exists to buy. A retry therefore succeeds rather than looping on the same 409 forever.

### §233. THE KUBERNETES SUBSTRATE

THE KUBERNETES SUBSTRATE.

`ordering-conformance.ts` was written for this moment and says so: "M23.2 adds a Kubernetes-Job adapter... The Kubernetes adapter inherits every case below by writing a substrate, not by re-deriving the race." This is that substrate, and every one of the ten cases is MEANINGFUL for a Job-based launcher — none is skipped. Two are worth naming because their premise changes shape:

```text
THE COPY-INS ARE SEQUENTIAL. On Docker the hazard is two `docker cp`s racing into one container
and racing `start`. Here the copies are ordinary filesystem writes into a shared volume, and the
race they would lose is worse rather than milder: an unawaited copy-in lets the PATCH that
unsuspends the Job fire while bytes are still landing, so the runner starts against a partial
workspace. Same case, same assertion, a hazard that is if anything sharper.
```

```text
WITH NO COPY-OUT, TEARDOWN STILL WAITS ON `start`. Its `issued()` expectation is
`["create","start","teardown"]`, i.e. it requires `create` and `start` to be TWO issued steps. A
Job is created running, and an adapter that collapsed them would fail this case. `suspend: true`
is what keeps them two, and it is the right answer for an independent reason (the name must be
staked before the bytes move) — so this case is not merely satisfied, it is the check that the
design decision stayed made.
```

WHAT IT STILL CANNOT SEE, inherited verbatim from the Docker substrate's own caveat: it proves each step is awaited before the next is ISSUED; it does not prove the process the adapter waited on is the one that finished. Here that gap is wider than on Docker — a held PATCH is not a running pod — and `kubernetes-adapter.integration.test.ts` against a real kind cluster is the only thing that can close it.

### §234. The hold delays the settle, not the issue

If `hold` delayed the ISSUE rather than the SETTLE, every held case above would pass while proving nothing. `ordering-conformance.ts` records the measurement that this protection lives in the held cases' own pre-release assertions; this is that property stated directly against the Kubernetes substrate, so a substrate regression fails HERE with a readable message rather than as nine confusing failures.

## `packages/runner-launcher/src/kubernetes-adapter.ts`

### §235. THE KUBERNETES ADAPTER

THE KUBERNETES ADAPTER (M23.2) — THE SECOND IMPLEMENTATION OF THE PORT M23.1 EXTRACTED

WHY IT IS A SECOND ADAPTER AND NOT A FOURTH LAUNCH SEQUENCE. M23.1's whole finding was that three plugins had each hand-rolled one mechanism, so a fix or a new platform arm had to be applied three times and the instance that got missed was invisible. This file is the test of that claim: it adds a platform arm and touches **no plugin**. The three `launch-argv.golden.test.ts` files do not move by a byte, and `launcher-seam.test.ts` — which pins each plugin's whole `RunnerSpec` with `toStrictEqual` and constructs its launcher by hand — is adapter-independent by construction and is likewise untouched.

THE LIFECYCLE MAPPING, AND WHY `suspend` IS THE ONE THAT MAKES IT FAITHFUL
The port's five steps are `create` -> `copy-in` -> `start` -> `copy-out` -> `teardown`, and the order is not decoration: `docker create` stakes the NAME before a single byte is copied, so two concurrent runs of one `runId` collide on the name rather than on each other's workspace bytes (`isContainerNameConflict`, M23.1e). Any Kubernetes mapping that moved the name-staking after the byte movement would re-open that race in a worse form — two runs writing the same files.

```text
create    POST a Job with `spec.suspend: true`. The Job object exists; no pod does. This is the
          precise analogue of `docker create`: the name is claimed (a duplicate is a typed 409
          `AlreadyExists`, which is STRICTLY better than Docker's `already in use` stderr
          substring match) and nothing is running yet.
copy-in   A recursive filesystem copy into a per-run subtree of the SHARED workspace volume.
          There is no `docker cp` on Kubernetes and there cannot be: a ConfigMap fails the 1 MiB
          etcd limit and `pods/exec` + tar is impossible against `apps/runner-dep`'s seven-applet
          `FROM scratch` image, which has no tar and no shell. Owner decision 5 (2026-08-18)
          therefore makes RWX storage a documented deployment prerequisite, and this is where
          that prerequisite is spent. The copies are sequential and awaited for the same reason
          they are on Docker — see `ordering-conformance.ts`.
start     PATCH `spec.suspend: false`, then poll the run's pod to a terminal state and read its
          log. This is the only step that can consume real time and it is the one the whole-run
          deadline mostly bounds.
copy-out  A recursive filesystem copy back OUT of the same subtree, honouring `when` and
          `onFailure` unchanged — the two asymmetries M23.1 refused to normalise.
teardown  DELETE the Job (background propagation), DELETE the per-run Secret, remove the
          workspace subtree. The Secret DELETE is a latency optimisation over the
          `ownerReference` the Job already carries, never the thing the credential's lifetime
          depends on — see step 2b. Unconditional, outside the run budget, swallowed-but-not-silent —
          all three exactly as the Docker adapter, and with the same ONE exception: a run that
          lost the name to somebody else tears down NOTHING, because none of it is its own.
```

BYTES ARE COPIED, NEVER MOUNTED FROM THE HOST — the same structural property the Docker adapter keeps by never passing `-v`. The Job mounts one operator-declared volume, at subpaths this adapter derives from the caller's `containerPath`s; no caller-supplied host path becomes a mount.

WHAT THE PORT COULD NOT PROMISE, SAID OUT LOUD RATHER THAN PAPERED OVER
1. `networkMode` CANNOT BE HONOURED, and this adapter does not pretend otherwise (owner decision 1, BUILD_AND_TEST.md M23). No pod-spec field, annotation, `securityContext` or RuntimeClass removes a pod's network namespace. The strongest portable substitute is a deny-all-egress NetworkPolicy — traffic denial, not interface absence, and fail-open on a CNI that does not enforce (measured on kind + kindnet: a pod SELECTED by a deny-all-egress policy reached a public IP and a resolver, indistinguishable from an unselected control). So the adapter does the one honest thing available: it CARRIES the resolved value to where a policy can act on it, as the pod label `RUNNER_NETWORK_LABEL`, and CLAIMS NOTHING. The port's own rule is unchanged — it "takes the resolved value and never decides it". 2. `pods/log` MERGES stdout AND stderr into one stream and does not preserve their interleaving (measured: a container printing STDOUT-LINE then STDERR-LINE returned them reversed). The port's `RunnerResult` has two fields. This adapter puts the whole merged stream in `stdout` and leaves `stderr` EMPTY — see `KUBERNETES_MERGES_STDERR_INTO_STDOUT` for why that direction and not the other, and for the two readers that decide it. 3. `maxBuffer` IS AN `execFile` CONCEPT. Kubernetes offers `limitBytes`, which truncates at the SERVER and returns success. `output-exceeded` is kept REACHABLE anyway — see `logRequestPath` — because the hazard it names ("the output looks like data but is truncated") is a property of the evidence, not of Node. 4. THE PER-RUN SECRET IS ON (M23.4, owner decision 2026-08-20). It was shipped in M23.2 as a declared, DISABLED capability; the grant has since been taken, so the chart renders the RBAC by default and `managed-iac` launches on Kubernetes. What the grant BOUGHT and what it COST are both recorded, as an accepted combination, in ADR-0035 §"the accepted combination". See `KubernetesRunnerLauncherConfig.perRunSecrets`.

### §236. Kubernetes hands back one stream; this picks the field

KUBERNETES HANDS BACK ONE STREAM; THE PORT HAS TWO FIELDS. THIS IS WHICH ONE GETS IT.

`GET pods/<pod>/log` returns the container's stdout and stderr already merged, with no marker saying which line came from where and no guarantee of interleaving order (measured on a real cluster: `echo STDOUT-LINE; echo STDERR-LINE >&2` came back STDERR-LINE first). There is no second endpoint that splits them. So one of `RunnerResult.stdout` / `RunnerResult.stderr` gets everything and the other gets `""`, and the choice is a PORT-CONTRACT decision an operator can feel — not an accident of which field the adapter happened to fill.

IT IS `stdout`, DECIDED BY THE TWO READERS THAT EXIST: - `runnerOutcomeDetail` returns `result.stdout` ON SUCCESS, and for managed-iac that string is the durable evidence a `tofu plan` wrote. Filling `stderr` instead would make every successful managed run record an empty detail — the exact `detail: ""` defect `RunnerResult`'s union was introduced to end. - `classifyRunnerFailure` reads `err.stderr.length > 0 ? err.stderr : err.stdout`, with the comment "a runner that explains itself on stdout (managed-dep's does) must not be recorded as silent". With `stderr` empty that fall-through is taken and the merged log reaches the diagnosis unchanged. Filling `stderr` would have broken the first reader and merely coincidentally satisfied the second.

### §237. The pod label carrying the unhonourable network mode

THE POD LABEL THAT CARRIES THE UNHONOURABLE `networkMode`.

Owner decision 1 accepted that `--network none` has no pod-spec equivalent. What it did NOT accept is the adapter silently dropping the caller's value: managed-dep passes `RUNNER_NETWORK_MODE` as a charter LITERAL (ADR-0032 §8d) precisely so no operator setting can contradict it, and a value that vanishes at the adapter is a setting contradicted by omission. The value is therefore stamped on the pod, where a NetworkPolicy `podSelector` can act on it and where `kubectl get pod -L` shows an operator what the runner ASKED for.

THIS IS NOT ENFORCEMENT AND MUST NEVER BE READ AS ENFORCEMENT. Whether anything denies that pod's egress depends on a NetworkPolicy existing AND on the CNI enforcing it, and the repo's own measurements say the default kind CNI does neither (`scripts/airgap-drill.sh:8-11`; re-measured for M23.2 with a known-positive control).

### §238. THE DEADLINE IS AN ANNOTATION, NOT A LABEL

THE DEADLINE IS AN ANNOTATION, NOT A LABEL — MEASURED, NOT ASSUMED.

`reap()`'s predicate is "foreign AND past its stamped deadline", and on Docker both halves are labels. On Kubernetes only the first half can be: a label VALUE must match `(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?`, and an RFC3339 instant contains colons. Measured against a real API server:

```text
  kubectl label job k1 scp.launcher.owner=abc-123          -> job.batch/k1 labeled
  kubectl label job k1 scp.launcher.deadline=2026-...:00Z  -> error: invalid label value
```

The same value is accepted verbatim as an ANNOTATION, and one `GET jobs?labelSelector=<owner>` returns both, so the predicate is preserved exactly. Storing a reformatted deadline (epoch millis, colons stripped) was the alternative and is worse: `reap()` fails CLOSED on an unparsable deadline, so a stamp only this package can read is a stamp an operator cannot audit, and a silently reformatted one is precisely the "ambiguous must never read as safe" hazard the Docker predicate guards.

### §239. A literal rather than the constant, and the defect why

A LITERAL, NOT `= RUNNER_LAUNCHER_DEADLINE_LABEL`, AND THE REASON IS A DEFECT THIS FILE SHIPPED FOR ONE COMMIT.

`index.ts` re-exports this module and this module imports `index.ts`, which is a legal ESM cycle for FUNCTION bodies (nothing reads a binding until it is called) and an immediate `ReferenceError` for a top-level `const` initialised from the other module's binding. Written as `= RUNNER_LAUNCHER_DEADLINE_LABEL`, loading `@scp/runner-launcher` from a real Node ESM loader failed with `Cannot access 'RUNNER_LAUNCHER_DEADLINE_LABEL' before initialization` — so every managed-executor plugin SUBPROCESS died at import and `plugin instance … did not become ready` was the only symptom.

WHAT MAKES IT WORTH THIS MANY LINES: the unit test written to catch exactly this passed. It imports `./index.js` under vitest, whose module graph resolved the cycle in the other order, so "the module cycle resolves" was asserted, green, and false. Only loading the BUILT package under `node` found it — `module-load.integration.test.ts` now does that permanently, and `runner-launcher-selection.test.ts` in each plugin package would also have caught it had it run against `dist`. The equality this line used to express is asserted there instead, where being wrong is a failed assertion rather than a dead subprocess.

### §240. WHAT EVERY OPERATION ON THIS PORT CARRIES

WHAT EVERY OPERATION ON THIS PORT CARRIES — and `timeoutMs` IS PART OF IT, on all three verbs.

IT WAS ON `request` AND ONLY ON `request`, WHICH IS M23.5's HIGH-1. `copyDir` and `removeDir` took no deadline at all and `createFetchKubernetesIo` implemented them as a bare `cp`/`rm`; the adapter's `copy()` checked the remaining budget BEFORE the call and then awaited it forever. On a volume the chart requires to be NFS/CephFS/EFS/Azure Files — the kind that hangs rather than errors — that is a `run()` which never returns, and from there the M23.1c chain runs verbatim: host SIGKILL, no outcome write, no ledger entry, `reconcile.ts` retries, second `tofu apply`.

AND THE FIELD IS NOT THE FIX. It obliges the CALLER to state a bound; nothing obliges an IMPLEMENTATION to honour one, which is exactly how the property survived being noticed. The field is here so a transport that CAN self-limit does (`AbortSignal.timeout` on `fetch`); what makes the bound TRUE for the ones that cannot is `withStepBound` in `index.ts`, through which this adapter issues every one of these calls.

### §241. Everything this adapter touches outside its process

EVERYTHING THIS ADAPTER TOUCHES OUTSIDE ITS OWN PROCESS, behind one injected object — the same shape `dockerBinary` + `execFile` is for the Docker adapter, and for the same reason: a unit suite has to be able to record and hold every effect, and a golden has to be able to pin every byte.

TWO KINDS OF EFFECT, DELIBERATELY NOT UNIFIED. `request` talks to the API server; `copyDir` and `removeDir` move bytes on the shared workspace volume. Collapsing them into one "do a thing" verb would hide the fact that the byte movement is NOT an API call — which is the single most important structural difference between this adapter and the Docker one, and the thing owner decision 5 is about. What they now SHARE is `KubernetesIoOp`: a step, and a deadline.

### §242. Where the Job's shared workspace volume comes from

Where the Job's shared workspace volume comes from. A CLOSED UNION, not an operator-supplied JSON blob: this object lands verbatim inside a pod spec this process POSTs with its own service-account token, so "whatever JSON the operator put in an env var" would be an arbitrary-volume-mount primitive wearing a config field's clothes.

### §243. The pod conventions this deployment applies elsewhere

THE POD CONVENTIONS THIS DEPLOYMENT APPLIES TO EVERY OTHER POD IT CREATES, carried to the one it does NOT render (M23.5).

WHY THIS BLOCK EXISTS AT ALL, AND WHY IT IS A BLOCK RATHER THAN THREE MORE SCALARS. `deploy/helm` creates six pods. Five of them are Helm templates and inherit the deployment's conventions (`.Values.imagePullSecrets`, `.Values.image.pullPolicy`, a `resources` block) because a human wrote the same six lines into each. The sixth is built HERE, at runtime, from a settings object that carried a namespace, a workspace root, a volume, and two booleans — nothing about the POD. So it inherited nothing, and not for the two fields that were reported but for ALL of them: the missing channel is the defect, and adding one field to it would leave the next convention exactly as unreachable as these were.

WHAT THAT COST, MEASURED ON A REAL CLUSTER, image already loaded on the node and tagged `:latest`: `spawn-failed, code=ErrImagePull — failed to pull and unpack image docker.io/library/ scp-probe-runner:latest`. An unset `imagePullPolicy` defaults to `Always` for a `:latest` tag, and the identical image runs fine under `docker create`. That is charter principle 5 — "no runtime network calls to the outside world" — broken in production, by an omission. And with no `imagePullSecrets` a runner image in a private registry cannot be pulled at all, which is the norm for self-hosted and mandatory behind the per-outpost Harbor SCP itself designs, while the worker pod pulling `scpd` from that same registry works.

IT IS OPERATOR-SUPPLIED DATA THAT LANDS VERBATIM IN A POD SPEC, so it is parsed into a CLOSED shape exactly like `KubernetesWorkspaceVolume` — see `managedRunnerKubernetesSettings()` in `apps/server`, which is where the strings are validated. The distinction that makes `resources` acceptable where a raw volume would not be: a `ResourceRequirements` is a flat map of validated resource names to validated quantities. It names no path, no object and no host, so the worst a malformed one can do is make the pod unschedulable — where an arbitrary `volumes[]` entry is a `hostPath: /` away from reading the node.

### §244. Per-run secrets are granted; this field opts out

PER-RUN SECRETS — GRANTED, ON BY DEFAULT SINCE M23.4, AND THIS FIELD IS NOW THE OPT-OUT.

THE HISTORY MATTERS BECAUSE THE FIELD'S MEANING INVERTED. `RunnerSpec.secretEnv` exists because credentials had to leave the argv (M23.1a, ADR-0035), and the port's own doc names the Kubernetes mapping as the reason the field is split at all: "a per-run Secret + `envFrom.secretRef` rather than as `env[].value`". M23.2 built that mapping and shipped it OFF, because the mapping needs `""/secrets` on the worker ServiceAccount and widening a Role is an owner decision. The owner took it on 2026-08-20 ("grant the secrets RBAC, keep going"), so the chart renders the rule by default and this defaults to `true`. WITHOUT THE GRANT, managed-iac — the only class that populates `secretEnv` — could not run on Kubernetes at all; ending that state is the whole purpose of the decision.

WHAT THE GRANT IS, EXACTLY, AND WHY IT IS NOT WIDER. `create` and `delete` on `""/secrets`, namespaced. NOT `get` — a filterless read of every `SECRETS_PATH` use in this file finds one POST and two DELETEs and no GET, so `get` would be a verb granted for nothing. NOT `list` — and that one is a refusal rather than an omission, because a `list` on secrets returns every Secret BODY in the namespace, including the chart's own database password; the reap sweep is built to work without it (it lists JOBS, which are not secret, and derives the Secret name). NOT `update`/`patch` on `jobs/finalizers`, which is what `blockOwnerDeletion: true` would have cost.

WHAT COULD NOT BE NARROWED, SAID PLAINLY RATHER THAN LEFT AS A GAP: `resourceNames`. Per-run Secret names derive from `runId`, so the set is unbounded — and Kubernetes RBAC cannot restrict a `create` by `resourceNames` under ANY circumstances, because the object's name is not known to the authorizer at admission time. The grant is therefore namespace-wide on the `secrets` resource, and the honest mitigations are deployment-shaped rather than RBAC-shaped: `managedRunners.kubernetes.namespace` puts the runner Jobs and their Secrets in a namespace of their own, and the Role+RoleBinding follow the value there (M23.4 — before it, they did not, and setting that value produced a silent 403 on every launch).

SETTING IT `false` STILL WORKS AND STILL REFUSES LOUDLY: a spec carrying a non-empty `secretEnv` fails at step `"secret-env"` before anything is created. The two alternatives to refusing were both worse and are named so nobody reaches for them later: - Fall back to `env[].value`. That is plaintext credentials in etcd and in every etcd backup, which the port's own header calls "strictly worse than the host process table this replaced". - Drop `secretEnv` silently. A managed-iac apply would then run with no AWS credentials and fail somewhere inside OpenTofu, which is a mystery instead of a refusal.

WHICH CLASSES THIS AFFECTS, MEASURED RATHER THAN ASSUMED. A filterless grep for `secretEnv:` across `packages/plugins` finds three production assignments: `managed-iac/src/index.ts:345` builds it from `infraCreds`; `managed-scan/src/index.ts:243` and `managed-dep/src/index.ts:692` are the literal `[]`, the latter with "NO ENVIRONMENT AT ALL, SECRET OR OTHERWISE" beside it (managed-dep's credential lives on the ORCHESTRATOR side of the boundary, charter `scp-managed-dep` as amended 2026-08-15). So this flag is load-bearing for managed-iac and inert for the other two — which is a statement about their SPECS, not about their RBAC: all three are launched by the same worker ServiceAccount through the same Role, and M23.4 fixed that Role being rendered only when `managedIac.enabled` (see `deploy/helm/templates/runner-iac.yaml`).

### §245. The pod `securityContext.runAsNonRoot`

The pod `securityContext.runAsNonRoot`. DEFAULTS TO FALSE, AND THAT IS A FINDING RATHER THAN A PREFERENCE: `deploy/helm/templates/runner-iac.yaml`'s reference Job shape asserts `runAsNonRoot: true`, and NONE of the three runner images satisfies it — a filterless read of `apps/runner-{iac,scan,dep}/Dockerfile` finds no `USER` line in any of them, so all three run as uid 0. Shipping the reference shape's value would make every managed run on Kubernetes fail with `CreateContainerConfigError` before the entrypoint ran. `kubernetes-adapter.integration.test.ts` drives exactly that failure against a real cluster and asserts it lands as `spawn-failed`.

### §246. One workspace slot per distinct container path

ONE WORKSPACE SLOT PER DISTINCT `containerPath`, AND THAT IS WHAT MAKES managed-iac WORK.

managed-iac copies IN to `/workspace` and copies OUT of `/workspace` — the same directory, because the runner edits in place and the evidence is what it left there. A slot allocated per copy OPERATION would give the copy-out its own empty directory and silently lose every `plan.json`, with the run still reporting success: the exact shape of the race `ordering-conformance.ts` exists for, arrived at from the other direction. Slots are therefore keyed by `containerPath`, in first-appearance order over `copyIn` then `copyOut`, so the mapping is a pure function of the spec and a golden can pin it.

### §247. The log read, and how output-exceeded stays reachable

THE LOG READ, AND HOW `output-exceeded` STAYS REACHABLE WITHOUT AN `execFile`.

`maxBuffer` is Node's `execFile` buffer and `RUNNER_MAXBUFFER_CODE` is Node's error code; neither exists here. Kubernetes offers `limitBytes`, whose semantics are DIFFERENT in the way that matters: `execFile` FAILS the call, `limitBytes` returns a short body successfully. Returning the short body as if it were the whole thing is precisely the hazard the port names — "`stdout` holds the output TRUNCATED at the limit, which is the hazard: it looks like data".

So the request asks for `maxBuffer + 1` bytes and the adapter FAILS the run when it gets more than `maxBuffer` — same verdict as Docker, same `RunnerFailureKind`, reached through the one mechanism Kubernetes offers. The `+1` is the whole trick: it is the smallest read that can distinguish "exactly at the limit" from "over it".

### §248. The accept header for a log read, measured not guessed

THE `Accept` HEADER FOR A LOG READ, AND `text/plain` IS THE WRONG ANSWER — MEASURED, NOT INFERRED.

`pods/log` serves a plain-text body, so `Accept: text/plain` looks obviously right and the API server answers it with **406 Not Acceptable**. Kubernetes content-negotiates every subresource against its own serializer list, which offers `application/json`, `application/yaml` and `application/vnd.kubernetes.protobuf` — `text/plain` is not among them, and the log body arrives as an unnegotiated stream regardless.

WHAT THAT COST BEFORE THE HARNESS RAN: every failed run reported `exit-nonzero` with `code: 406`. The log read rejected, the rejection replaced the pod's real termination, and an operator reading a `spawn-failed` ImagePullBackOff would have been told the runner exited 406. Nothing in `kubernetes-adapter.test.ts` could see it — a fake answers whatever Accept it is given.

### §249. The chart grants exactly what the adapter calls

M23.6 clause 5: "the chart grants exactly what the adapter calls, and no more".

WHY A DECLARATION AND A DERIVATION, NOT JUST ONE OF THEM. Before this, `tools/helm-verify` checked the rendered Role with `JSON.stringify(rules).includes('"patch"')` for `batch/jobs`, set-equality for `events` and for `secrets`, and NOTHING AT ALL for `pods` / `pods/log`. That gate catches a verb the adapter needs and the Role omits — the M23.2 defect — and is structurally unable to catch the opposite. Measured, on this file, before the fix: four unused verbs added to the chart (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`) left helm-verify green, the whole workspace green, and the kind suite green. **A grant may only ever drift wider**, which is the direction that matters for a privilege.

AND THE SHIPPED ROLE HAD ALREADY DRIFTED. It granted `watch` on `batch/jobs` and on `pods,pods/log`, inherited from M8's reference shape — while `KUBERNETES_POLL_INTERVAL_MS`'s own doc says, in as many words, "A POLL AND NOT A WATCH, deliberately". There is no `watch=` query anywhere in this file. It also gave `pods` and `pods/log` ONE verb list, so `get` on `pods` and `list` on `pods/log` were granted and never used.

THE TABLE BELOW IS A DECLARATION, and a declaration alone is prose with a type. It is held to the code by `kubernetes-rbac-contract.test.ts`, which RUNS the adapter through a recording io across every route — a whole successful run, a run whose pod never appears, and a reap pass — maps each `(method, path)` that actually reached the wire onto its Kubernetes verb with `kubernetesRbacRequirement`, and asserts the derived set EQUALS this table. `helm-verify` then asserts the rendered Role equals it too. Three things agree, or the build is red.

### §250. Every rule this adapter's requests require

Every rule this adapter's requests require, for a deployment with `perRunSecrets` as given.

`secrets` is a PARAMETER and not a fifth constant entry because the chart renders that rule behind `managedRunners.kubernetes.perRunSecrets` and the same value sets the server-side flag — so "what the adapter calls" genuinely differs between the two deployments, and a diff that ignored the value would have to be loose in one direction or wrong in the other.

### §251. The Kubernetes verb an HTTP request requires

The Kubernetes verb an HTTP request against the API server requires — the mapping the authorizer itself performs, written here so a request can be turned into a grant and diffed.

Returns `null` for a path this adapter never issues, which the contract test asserts is unreachable: an unrecognised path must fail the census loudly rather than be silently excused.

### §252. Is this label entry expressible as a Kubernetes label

IS THIS `RunnerSpec.labels` ENTRY EXPRESSIBLE AS A KUBERNETES LABEL?

The port validates labels only against Docker's much looser rules (`[\r\n]` in the value). It says so: `RunnerSpec.labels`'s doc promises "Kubernetes: `metadata.labels`" and the port makes no promise the values are legal there. Today all three plugins pass `scp.executor` and `scp.run-id` with values that are legal on both — but "today all three happen to comply" is exactly the property that goes false when a fourth managed class arrives, and the failure mode without this check is a 422 from the API server mid-`create`, i.e. a launch that fails for a reason no operator can act on. Refuse at step `"spec"`, before anything exists, naming the offending key.

### §253. The uid of an object the API server just created

THE `metadata.uid` OF AN OBJECT AN API SERVER JUST CREATED, or `undefined`.

ONE CALLER, AND IT REFUSES THE RUN WHEN THIS RETURNS `undefined` (see step 2b). That is why this is a parse rather than a cast: the uid is what makes the per-run Secret's deletion the garbage collector's obligation instead of this process's, and an `ownerReferences` entry with an empty or WRONG uid does not fail — the API server accepts it and the collector then treats the owner as already deleted, which deletes the Secret out from under a LIVE run. A missing uid must therefore be a refusal, and a non-string one must read as missing rather than as `String(undefined)`.

### §254. A pod state that is FATAL BEFORE THE ENTRYPOINT RAN

A pod state that is FATAL BEFORE THE ENTRYPOINT RAN — the Kubernetes spelling of `spawn-failed` ("the container CLI could not be executed at all — nothing ran. Nothing ran, so nothing was mutated"). Every one of these is terminal in practice and none of them will resolve by waiting; polling through them to the whole-run deadline would report `budget-exhausted`, which is the single worst misdiagnosis available here — for managed-iac it means "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown", when in fact nothing ran at all.

### §255. WHAT THE RUN'S POD SAYS HAPPENED

WHAT THE RUN'S POD SAYS HAPPENED — or `undefined` while it is still going.

THE RETURN IS SHAPED AS AN `execFile` REJECTION ON PURPOSE, and that is the single most useful thing in this file. `classifyRunnerFailure` is the port's only producer of a `RunnerFailure`, it is 30 lines of measured branch ORDER, and its kinds are the operator-facing vocabulary the whole product records. Writing a second Kubernetes classifier would have been the M23.1 defect again — one mechanism, two implementations, and the one that gets missed is invisible. So this function's job is translation, not classification: it produces `code`/`killed`/`signal` such that the EXISTING classifier reaches the right kind, and every one of them is exercised by a named test.

```text
pod Succeeded                      -> succeeded
terminated, signal != 0            -> killed: true            -> `signalled`
terminated, reason OOMKilled       -> killed: true            -> `signalled`
waiting, a fatal image/config      -> code: "<Reason>"        -> `spawn-failed` (a STRING code)
terminated, exitCode != 0          -> code: <number>          -> `exit-nonzero`
```

`budget-exhausted` and `output-exceeded` are not produced here: the first is the deadline path (`deadlineExceeded`) and the second is the log-size check, exactly as on Docker.

### §256. The platform deleted this pod, and that outranks

THE PLATFORM DELETED THIS POD, AND THAT FACT OUTRANKS WHATEVER THE CONTAINER STATUS SAYS NEXT.

MEASURED against a real cluster, `kubectl delete pod` on a running runner:

```text
t+0    deletionTimestamp set; the pod is still Running
t+2s   Job condition FailureTarget=True (BackoffLimitExceeded)   <- not yet `Failed`
t+31s  the grace expires; the container is SIGKILLed -> terminated{exitCode:137,reason:"Error"}
t+32s  the pod object is collected
t+34s  Job condition Failed=True (BackoffLimitExceeded)
```

A poll landing at t+31s read `exitCode 137` and reported `exit-nonzero` — THE TENANT'S RUNNER EXITED 137 — for a pod the platform destroyed. A poll landing at t+32s found no pod and got `signalled` from the Job instead. One event, two verdicts, chosen by a race (6 runs in 10 against a real cluster), and one of them blames the tenant for a drain. 137 is 128+9: it IS the SIGKILL this deletion sent, and the kubelet writes it into `exitCode` with NO `signal` field, so nothing downstream of here can tell it from a genuine `exit 137`.

THE DELETION TIMESTAMP CAN, and it is first-class evidence rather than a tie-break: it is set when the deletion is REQUESTED — 31 seconds before the exit code exists — so reading it also ends the run at once instead of polling out the termination grace, which is 31 seconds during which four different reads could each discover the deadline and answer `budget-exhausted`.

A CONTAINER THAT HAD ALREADY EXITED CLEANLY IS STILL A SUCCESS. Deletion of a pod whose runner finished is ordinary garbage collection, not a kill, and calling that a failure would be the same class of lie in the other direction.

### §257. DID THE RUNNER CONTAINER EVER START?

DID THE RUNNER CONTAINER EVER START? — the fact every verdict below turns on.

`budget-exhausted` says, in `RunnerFailureKind`'s own words, "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown". That sentence is true only if something ran. Once, for every route where nothing did, it was what an operator was told — which is the same misdiagnosis `FATAL_WAITING_REASONS` already calls "the single worst available here", arrived at from the other side: that set catches a container the kubelet REFUSED, and this catches the routes where no container was ever asked for.

STICKY, not a reading of the current state: a pod deleted mid-run leaves no status at all, and the whole point of the distinction is to remember that there had been one.

### §258. AND THE PHASE ALONE IS ENOUGH FOR THREE OF THE FIVE

AND THE PHASE ALONE IS ENOUGH FOR THREE OF THE FIVE. `Running` means the kubelet has created every container and at least one is running — a pod blocked on an image pull or an admission refusal is `Pending`, never `Running` — and `Succeeded`/`Failed` are terminal. So a pod whose container status has been pruned, or that a fake describes only by phase, still reads as having started, which is the direction that must not be wrong: calling a run that DID start "nothing ran" is the same class of lie as the one this whole function exists to end.

### §259. WHY THIS RUN IS STILL WAITING

WHY THIS RUN IS STILL WAITING — one operator-facing clause, assembled from whatever said anything.

THE THREE MEASURED ROUTES, all of which produced the identical `budget-exhausted` verdict after burning the entire run budget, and none of which `kubernetesTermination` can see because it reads ONLY `pod.status.containerStatuses`:

```text
1. A ResourceQuota requiring compute limits. `jobManifest` set no `resources` block at all
   (M23.5 gives the chart one), so the pod CREATE is rejected — `must specify limits.memory for:
   runner` — no pod ever exists, and the refusal is written down in exactly one place: the Job
   controller's `FailedCreate` event.
2. An unschedulable pod. The pod EXISTS, has no `containerStatuses` whatsoever, and carries
   `PodScheduled=False` with `Unschedulable` and the scheduler's own message. That is also the
   shape of an unbound RWX claim — the failure `assertRunnerPrerequisites` exists to pre-empt.
3. The pod deleted mid-run (a node drain, an eviction). Handled by
   `kubernetesJobTermination` rather than here, because the Job says so outright.
```

### §260. WHAT THE JOB ITSELF SAYS HAPPENED

WHAT THE JOB ITSELF SAYS HAPPENED — the terminal verdict no pod can carry, or `undefined`.

`kubernetesTermination` reads `pod.status.containerStatuses` and nothing else, which is correct for every run that produced a pod that ran and WRONG, in one specific and expensive way, for every run that did not: with no terminal pod the loop polls to the whole-run deadline and reports `budget-exhausted`, i.e. "the runner was stopped mid-flight, the real infrastructure state is unknown", when nothing ran at all.

A `Failed` condition on the Job is that missing verdict, and the KIND depends on `everStarted` — which is the whole reason that flag is threaded through:

```text
pod deleted mid-run (drain/eviction)  everStarted -> killed  -> `signalled`
the Job never produced a running pod  !everStarted -> STRING code -> `spawn-failed`
```

The second is the honest one: `spawn-failed`'s own wording is "the container CLI could not be executed at all — nothing ran. Nothing ran, so nothing was mutated", which is exactly true of a quota rejection and exactly false of the budget verdict it used to get.

### §261. The failure target is read alongside the failure itself

`FailureTarget` IS READ ALONGSIDE `Failed`, AND THE 32 SECONDS BETWEEN THEM ARE THE POINT. Measured on a drained pod: `FailureTarget=True(BackoffLimitExceeded)` at t+2s, `Failed=True` at t+34s. Waiting for `Failed` alone leaves half a minute in which the pod object has been collected, no verdict exists yet, and every poll is another chance for one of four reads to discover the deadline and answer `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — instead. `FailureTarget` is the Job controller's own statement that this Job IS going to fail, written down before it gets round to saying so terminally, and it carries the same `reason`.

### §262. WHAT THIS RUN OBSERVED

WHAT THIS RUN OBSERVED — the whole input to `kubernetesStartVerdict`, and deliberately not one boolean more. Every field is something the run WATCHED HAPPEN, never something inferred from which line of the control flow raised the failure.

### §263. The failure carries the cluster's own statement

The failure already carries the CLUSTER'S OWN STATEMENT about the runner — a terminal pod or Job read through `kubernetesTermination`/`kubernetesJobTermination`, or this adapter's `maxBuffer` check on the runner's own output. Nothing below knows better than that.

### §264. What the API server said about the unsuspend

WHAT THE API SERVER SAID ABOUT THE UNSUSPEND, which is a different question from whether the request went well for us: - `accepted`    2xx. The Job left `suspend: true`; from this instant a pod may exist and a container may run WHETHER OR NOT ANYTHING HERE IS STILL WATCHING. - `refused`     the server answered with a status (403, 422, 404). It did not apply the patch, so the Job is still suspended and no pod can have been created for it. That is knowledge, not an inference. - `not-issued`  the request PROVABLY never left this process — the whole-run budget was already spent when the run reached `start`, so `spend` refused it. Also knowledge: a request that was never sent cannot have applied. - `unanswered`  no answer reached this process and none of the above is provable — it was issued and the transport never came back, or it failed in a way that does not say which. Whether the patch applied is NOT KNOWN.

### §265. At least one read completed after the unsuspend

AT LEAST ONE READ COMPLETED AFTER THE UNSUSPEND and described this run's world. An empty pod list counts: "the controller has created no pod" is a description, and it is the one ROUTE 1 rests on. What does NOT count is a read that failed, was refused, or was abandoned.

### §266. HOW LONG THIS RUN WAS BLIND BEFORE IT ENDED

HOW LONG THIS RUN WAS BLIND BEFORE IT ENDED — the gap between the last read that COMPLETED and the moment the verdict is made, in milliseconds. `0` when nothing was ever observed (arm 6 owns that case and says so in its own words).

IT IS THE FACT ARM 7 IS MISSING WITHOUT, and the one M23.5 verification pass 19 measured against a real cluster. `observed` says a read landed; it does not say WHEN, and "the runner container never started within the whole-run budget" is a claim about the WHOLE budget. One read that landed a tenth of a second after the unsuspend — an empty pod list, because the controller had not created the pod yet — supported that sentence for a run whose real container then started, ran and wrote a real file to the real volume during the 24 seconds this launcher could not see.

### §267. WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY

WHAT A LAUNCHER THAT COULD NOT SEE IS ALLOWED TO SAY — M23.5 verification pass 18

THE DEFECT THIS REPLACES, MEASURED AGAINST A REAL CLUSTER. `!everStarted` meant two different things at one site: "observed, and nothing had started" (true, and the whole point of M23.5's D2 fix) and "never observed at all" (unfounded). The second was unguarded. The unsuspend PATCH reached the API server and succeeded; every `GET pods` after it stalled past the budget; the real Job, the real pod and the real kubelet did the work and a real container wrote a real file to the real volume. The record said `spawn-failed: the container CLI could not be executed at all — nothing ran … so NOTHING RAN and nothing was mutated — the Job had not yet been observed`. THE EVIDENCE THAT THE CLAIM WAS UNFOUNDED WAS IN THE SAME SENTENCE AS THE CLAIM.

SO THE RULE IS ONE SENTENCE: THE VERDICT MAY NOT ASSERT WHAT THIS RUN DID NOT OBSERVE. Both existing claims are assertions — `spawn-failed` says nothing was mutated, `budget-exhausted` says the runner was stopped mid-flight — and for a blind run each is a coin toss dressed as a finding. `outcome-unknown` (`RUNNER_OUTCOME_UNKNOWN_CODE`) is the third answer, and for managed-iac it is the one that matters: it is the difference between "re-run it" and "go and look at your infrastructure before you touch anything".

A PURE FUNCTION, AND THAT IS THE POINT. The previous version of this decision was three lines inside a `catch` in a 200-line block, which is why nothing pinned the arm that was wrong.

AND `observed` ALONE WAS THE SAME MISTAKE ONE STEP ALONG — M23.5 verification pass 19, measured the same way. The paragraph that stood here claimed arm 7's read "is up to one poll interval older than the deadline" and that "the arm is only reached when the last read said the pod COULD NOT start". NEITHER WAS TRUE OF THE CODE. Nothing measured the read's age, and nothing looked at what it said: one `GET pods` landing a tenth of a second after the unsuspend — an empty list, because the controller had not created the pod yet — set `observed` and satisfied arm 7 for the whole remaining budget. Against the real cluster: the pod, the kubelet and the container are real, the container writes `THE-RUNNER-RAN-AND-MUTATED` to the real volume, and the record says `NOTHING RAN and nothing was mutated`. The bound is now a FACT the run measures — `KubernetesStartFacts.unwatchedMs` against `KubernetesStartFacts.pollIntervalMs` — and past it arm 7b says the window out loud in milliseconds.

THE ONE THING IT STILL CANNOT SEE, SAID PLAINLY RATHER THAN LEFT FOR THE NEXT PASS TO FIND — and CORRECTED BY VERIFICATION PASS 20, which found this paragraph describing a window half the width of the one the code admits.

ARM 7 ASSERTS MORE THAN IT WATCHED, FOR UP TO `2 * pollIntervalMs + RUNNER_MIN_STEP_BUDGET_MS`. That is the arm's own guard, and it is TWO intervals plus the slack, not one: at the default `KUBERNETES_POLL_INTERVAL_MS` of 2,000ms the record may claim `NOTHING RAN and nothing was mutated` about 4,010ms this process did not see, and at the 500ms the kind harness uses, 1,010ms. A container that starts anywhere in that window is not in the last landed read.

TWO THINGS NARROW IT AND NEITHER BOUNDS THE CLAIM ITSELF, WHICH IS THE PART THIS USED TO GET WRONG. `everStarted` is re-evaluated on EVERY poll, so any start that was VISIBLE wins — that makes the residual rare, not sound. And a pod whose container starts inside the window is still `Running` when teardown DELETEs the Job moments later — that bounds HOW LONG the runner ran, and `spawn-failed`'s sentence is not about duration: it is `nothing was mutated`, and a `tofu apply` that got a second of CPU can have mutated. So the honest statement is that the window is narrow and the claim inside it is unfounded, not that anything makes the claim true.

CLOSING IT COMPLETELY would need a read AFTER the deadline, which is a fourth post-deadline call — `RUNNER_POST_DEADLINE_CALLS` declares three for `kubernetes`, it would have to declare a fourth, and `runnerPostDeadlineCallsMs`, the reap stamp and `MANAGED_TRIGGER_GRACE_MS` all move with the count. That is the price, and it is why this is written down rather than fixed.

A SECOND RESIDUAL, NAMED RATHER THAN IMPLIED: arm 7 does not ask WHAT the last read said, so a pod the cluster reported as conclusively blocked (a quota refusal, `Unschedulable`) that is unblocked and starts inside that same window is still recorded as never having started.

### §268. 2. THE UNSUSPEND WAS NEVER SENT

2. THE UNSUSPEND WAS NEVER SENT. The budget was already gone when the run reached `start`, so `spend` refused it before it was issued: the Job is exactly as `create` left it. This arm exists so that the KNOWABLE half of "nobody answered" is not swept into arm 3 with the unknowable half — telling an operator to go and inspect infrastructure that was never touched is a weaker claim than the truth, and a weaker claim is still the wrong one.

### §269. The API server refused to start the job, and said so

3. THE API SERVER REFUSED TO START THE JOB, and said so with a status. The patch did not apply, so the Job never left `suspend: true` and the controller never created a pod for it. Without this arm the refusal reaches `classifyRunnerFailure` as a NUMERIC code and is recorded as `exit-nonzero` — "the runner itself exited non-zero" — for a runner that does not exist. That is the same class as the defect above, arrived at from the RBAC side: the chart shipped without `patch` on `batch/jobs` for a whole release, so this was every managed run.

### §270. Observed, nothing had started, and the budget ended it

7. OBSERVED, NOTHING HAD STARTED, AND THE BUDGET IS WHAT ENDED US — M23.5's D2 verdict, and it is warranted ONLY IF THIS RUN WAS STILL WATCHING WHEN THE BUDGET RAN OUT. That qualifier is M23.5 verification pass 19, and without it this arm makes arm 6's claim through the back door: `observed` says a read LANDED, never that it landed recently or said anything conclusive, and "never started within the whole-run budget" is a claim about the whole budget. See this function's doc for the measurement.

### §271. Two poll intervals, both earned rather than chosen

TWO POLL INTERVALS, AND BOTH ARE EARNED RATHER THAN CHOSEN. One is the sleep between reads — the granularity this design already accepts, and the deadline lands somewhere inside it. The second is the allowance for the read that DISCOVERED the deadline: a read expected to take longer than a poll interval would make the poll cadence meaningless, so a call still inside that is a run that was reading, not a run that went blind. MEASURED against the real cluster: ROUTE 1 and ROUTE 2 end 132ms and 134ms unwatched at `pollIntervalMs: 500`; the case this arm exists for ends 24,500ms unwatched at the same setting.

### §272. With Docker selected, this adapter is never built

The clause is: "with the Docker launcher selected, the Kubernetes adapter is never constructed and no Kubernetes client is instantiated, so an air-gapped VM install gains no new dependency."

WHAT STOOD FOR IT PROVED THE WEAKER HALF. The three `runner-launcher-selection.test.ts` files assert that the Kubernetes **io is never touched** — a statement about calls. Measured: making the Docker branch of `resolveRunnerLauncher` construct `createFetchKubernetesIo(...)` AND `createKubernetesRunnerLauncher(...)`, discard both, and return the Docker launcher left `pnpm -w test` green (72/72). Nothing anywhere asserted that they were not BUILT.

This counter is the difference. Two increments, one in each of this module's two constructors, and `no-docker-on-kubernetes.test.ts` censuses the source so a third constructor cannot join them unrecorded.

### §273. Lists every Job this package labelled, and deletes

See `RunnerLauncher.reap`. Lists every Job this package labelled (any owner) and deletes exactly the ones that are BOTH foreign AND past their stamped deadline — the SAME predicate as the Docker adapter's, fail-closed on a missing or unparsable deadline, because an ambiguous stamp must never read as "safe to destroy".

### §274. THE WORKSPACE SUBTREE GOES WITH THE JOB

THE WORKSPACE SUBTREE GOES WITH THE JOB. A SIGKILLed predecessor's copy-in bytes are on a SHARED volume with nothing else sweeping them, and for managed-dep those bytes are a tenant's manifest. This is the Kubernetes form of the `--env-file` sweep MEDIUM-4 added on the Docker side: ONE cleanup concept, reached through the same method.

AND IT IS THE `rm` ON THE NETWORK VOLUME — the same unbounded call as the copy-in, in the one place whose whole job is to make progress when a predecessor already wedged.

### §275. `reapOnce`, single-flighted per NAMESPACE

`reapOnce`, single-flighted per NAMESPACE. `secretEnvDir` IS ACCEPTED AND IGNORED, and that is a fact worth a sentence rather than a shrug: it is the Docker adapter's transient `--env-file` directory, and this adapter writes no env file — the credential lives in a Secret object whose lifetime is the Job's, swept above. The parameter stays in the port signature because the port has ONE `reap`, and an adapter that refused the argument would make the port two.

### §276. The one clock, and it is the port's object

THE ONE CLOCK, AND IT IS THE PORT'S OBJECT RATHER THAN THIS ADAPTER'S ARITHMETIC (M23.5). The refusal at exhaustion, the `Math.max(1, …)` and — the part this adapter did not have — the BOUND on the awaited work all live in `createRunDeadline`. This file's own `api()` doc used to say `clampRunTimeoutMs` "runs inside `run()` so a second adapter cannot forget it, and this is the second adapter, so it does not". It forgot the other half on `copyDir` and `removeDir`; hoisting the enforcement is what stops a third adapter repeating it.

### §277. The redaction set, bigger here by exactly one

THE REDACTION SET, AND IT IS BIGGER HERE THAN ON DOCKER BY EXACTLY ONE THING. The Docker adapter redacts the secret VALUES and the `--env-file` path. This adapter puts those same values into a Secret body, where the API requires them BASE64-ENCODED — and a base64 string does not match its own plaintext, so a redaction set built the Docker way would let the whole credential through in any echoed request or response body. Both encodings are in the set.

### §278. Every API call, bounded by the one budget

EVERY API CALL, BOUNDED BY WHAT IS LEFT OF THE ONE BUDGET — the Docker adapter's `exec`, in the Kubernetes spelling, and the three traps it records are the same three. A step reached with the budget spent is REFUSED BEFORE IT IS ISSUED rather than issued with a zero or negative bound; `clampRunTimeoutMs` runs inside `run()` so a second adapter cannot forget it, and this is the second adapter, so it does not.

A NON-2xx STATUS IS A REJECTION. `fetch` resolves on a 403 and a 422 alike; treating a resolved promise as success is how a Job that was never created gets waited on to its deadline. The RESPONSE BODY reaches the error redacted — the API server echoes the object it refused, and for a Secret POST that object contains the credential.

### §279. The transport rejected of its own accord

SO THE TRANSPORT REJECTED OF ITS OWN ACCORD, AND THE QUESTION IS WHETHER IT WAS ENDED BY THE BOUND THIS RUN GAVE IT — M23.5 verification pass 18, S2, and the answer is not the one the finding assumed.

THE DOCKER ANALOGUE ASKS A FACT: `e.killed === true && runDeadline.spent()`, where `killed` is Node's own statement that the `timeout` WE set is what ended the child. This transport has no such flag to offer — `io` is an injection point, and the three implementations in this repository reject with three different shapes (a `TimeoutError` DOMException from `AbortSignal.timeout`, a destroyed socket from the kind harness's `node:https` shim, a plain `Error` from a fake) — so the fact is MEASURED here instead: a request that consumed the bound it was handed was ended by that bound.

AND THE ALGEBRA IS SAID OUT LOUD, BECAUSE IT IS WHY NO TEST COULD TELL THE TWO APART. `spend` hands a request EXACTLY what remains (`boundGiven = at - issuedAt`), so `now - issuedAt >= boundGiven - MIN` is `now >= at - MIN`, which is `spent()`. The two expressions are the SAME PROPOSITION on this adapter today, and the mutation survived for a plainer reason than the finding proposed: NOTHING PINNED THIS SITE AT ALL. The gate is `A TRANSPORT FAILURE WITH BUDGET LEFT IS NOT A BUDGET EXHAUSTION` in `kubernetes-adapter.test.ts`, which kills `= true` in either form.

THE REQUEST-RELATIVE FORM IS STILL THE ONE KEPT, for the assumption it stops depending on silently: the equality above holds only while the per-request bound IS the whole remainder. The day anything caps a single call — a poll read that may not eat a whole `tofu apply`'s budget is an obvious future — the clock form starts answering "the run's budget ran out" for a request that merely hit its own cap, and nothing would say so. `RUNNER_MIN_STEP_BUDGET_MS` is the slack, and it is the deadline's OWN slack rather than a second number: an `AbortSignal.timeout` fires on a libuv timer and `Date.now()` reads a different clock, which is the sub-millisecond disagreement M23.5's D4 measured turning a budget kill into a verdict about the tenant's runner.

### §280. The byte movement, through the same deadline

THE BYTE MOVEMENT, THROUGH THE SAME DEADLINE AS EVERY API CALL — M23.5's HIGH-1, and the difference is one word. This function used to check the budget and then `await io.copyDir(...)` with no bound at all: the pre-check answered "may I start?" and nothing answered "how long may this take?". `spend` answers both, and abandons work that answers neither.

### §281. A run that lost its name tears down nothing

A RUN THAT LOST ITS NAME TO SOMEBODY ELSE TEARS DOWN NOTHING. The Docker adapter's `createNameConflict`, and every word of its reasoning applies unchanged: the Job (and the Secret, and the workspace subtree) behind that name belong to a run this one did not start and is not supervising, and an unconditional teardown destroys a live `tofu apply`. What changes is only the SIGNAL — a typed 409 `AlreadyExists` instead of a stderr substring.

THE JOB POST IS WHAT STAKES THE NAME (M23.4 reordered it — see step 2b). It used to be the Secret POST, and the swap is not cosmetic: it is what lets the Secret carry an `ownerReference` to the Job, which is what makes its deletion the KERNEL's obligation rather than this process's.

### §282. A second, narrower ownership flag

AND A SECOND, NARROWER OWNERSHIP FLAG, because the two objects can now diverge. `foreignRun` says "the NAME is someone else's, touch nothing". This one says "the Secret behind this name is not the one I POSTed", which is reachable on its own: the Job POST succeeded (so the name IS mine) and the Secret POST 409'd on debris whose owning Job has already gone. Tearing that debris down would be deleting an object this process cannot prove it created, so it does not — Kubernetes' own garbage collector will, because the owner it references no longer exists.

### §283. The refusal standing in when no grant was made

1. THE REFUSAL THAT STANDS IN FOR THE SECRET WHEN THE GRANT WAS NOT MADE. Before the `try`, exactly like the Docker adapter's `--env-file`: a failure here has created no Job. The chart grants `secrets` by DEFAULT since M23.4 (owner decision, 2026-08-20 — "grant the secrets RBAC, keep going"), so this arm is now the OPT-OUT path rather than the shipped one; it stays, because an operator who sets `perRunSecrets=false` must get this sentence and not a 403 from inside a promotion.

### §284. 2b. THE PER-RUN SECRET (`secret-env`)

2b. THE PER-RUN SECRET (`secret-env`) — AFTER the Job, OWNED BY the Job, and both halves of that sentence are the credential-lifetime guarantee.

```text
  WHY NOT A `finally`. There is one, twenty lines below, and it is the FAST path — it
  deletes the Secret the instant the run ends. It is not the guarantee, because M23.1d's
  whole lesson is that no `finally` survives a SIGKILL: the plugin host's hang detector
  (`apps/server/src/plugin-host/host.ts`) kills a subprocess mid-`trigger()` and nothing
  in this process runs again. On Docker the answer was a sweep (MEDIUM-4's `--env-file`
  reaper) because a file has no owner. A Kubernetes object does, so the answer here is
  the API's own: `ownerReferences` makes the Secret's deletion the garbage collector's
  obligation the moment the Job goes, and `ttlSecondsAfterFinished` makes the Job go
  without anyone asking. Kill this process at any instant and the credential still has a
  bounded life, enforced by the cluster rather than by code that is no longer running.
```

```text
  `blockOwnerDeletion: false` IS DELIBERATE AND IT IS AN RBAC FACT, not a preference:
  setting it true requires `update` on `jobs/finalizers`, a third verb on a second
  resource, bought for a guarantee this does not need (nothing here depends on the
  Secret outliving a Job deletion request).
```

```text
  `controller: false` likewise — the Job controller is the Job's controller. This is an
  ownership edge for garbage collection, not a claim to reconcile the Secret.
```

### §285. Not a foreign run: the create did not conflict

NOT `foreignRun`. The Job POST above did NOT 409, so this run owns the name; what it does not own is the Secret already sitting behind it, whose owning Job is by construction gone (a live one would have 409'd the Job POST). So: refuse, tear down the Job THIS run created, and leave the debris to the collector that is already obliged to take it. A retry on the same runId then succeeds.

### §286. Outside the try, because the catch decides

OUTSIDE THE `try`, BECAUSE THE VERDICT IS DECIDED IN THE `catch` — M23.5.

STICKY. A pod deleted mid-run leaves no status at all, and remembering that there had been one is the difference between `signalled` and `spawn-failed`.

### §287. The initial value is a fact, not a placeholder

THE INITIAL VALUE IS A FACT, NOT A PLACEHOLDER, AND SAYING SO IS THE M23.5-pass-18 FIX. It used to be read in a sentence that also asserted "NOTHING RAN and nothing was mutated", which is the assertion this string contradicts. It is now only ever read by `kubernetesStartVerdict` arm 5 — the arm that says the outcome is UNKNOWN — and `observed` below is the flag that decides which arm sees it.

### §288. Did anything describe this run's world after

DID ANYTHING EVER DESCRIBE THIS RUN'S WORLD AFTER IT ASKED FOR IT TO START?

SEPARATE FROM `everStarted` BECAUSE THEY ARE SEPARATE FACTS, and merging them is the whole defect: `!everStarted` was "observed, and nothing had started" on one route and "never observed at all" on another, and only the first can support "nothing ran".

### §289. WHAT THE API SERVER SAID ABOUT THE UNSUSPEND

WHAT THE API SERVER SAID ABOUT THE UNSUSPEND. See `KubernetesStartFacts.unsuspend`: a STATUS is the server's own "no" and means the Job is still suspended; anything else leaves that unknown, and a run whose Job may be live may not be told nothing ran.

### §290. IS THE BUDGET ALREADY GONE?

IS THE BUDGET ALREADY GONE? — READ BEFORE THE CALL, AND THAT PLACEMENT IS THE OPPOSITE OF THE GUARD M23.5 DELETED RATHER THAN A RETURN TO IT.

The deleted guard read the clock before a call and used the answer to decide the verdict AFTER it, in the direction that can be wrong: the clock could cross in between, so "there is budget left" did not mean the call would be issued, and the run reported `budget-exhausted` for a run in which nothing ever started (6 in 20).

THIS READS IT IN THE DIRECTION THAT CANNOT BE WRONG. The clock only moves forward, so `spent()` here means `spend` WILL refuse and the request WILL NOT be issued — a positive proof. A `false` proves nothing and is used to prove nothing: the run falls through to `unanswered`, the conservative arm. Non-atomicity can only ever cost precision here, never make the verdict false.

### §291. POLL TO A TERMINAL POD

POLL TO A TERMINAL POD — OR TO A TERMINAL JOB, which is the half M23.5 added and the half three measured failure routes needed.

THERE IS STILL EXACTLY ONE BOUND, AND NOW EXACTLY ONE PLACE THAT SAYS WHAT REACHING IT MEANS. Every request goes through `api()`, which refuses once `runDeadlineAt` is spent, so the deadline can be DISCOVERED at any of four calls in this loop — `GET pods`, `GET events`, `GET job`, `GET log`. A guard at the top of the loop cannot fix that and the previous round's attempt to (moving the check up, and calling the placement load-bearing) did not: the check and the `api()` it guards are not atomic, so the clock could cross between them and the run reported `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown" — for a run in which NOTHING EVER STARTED. 6 runs in 20, only under the full file's timing.

SO THE CHECK IS GONE and the verdict is decided ONCE, in the `catch` below, from the facts this loop observed rather than from which line noticed the clock. What is left here is the polling itself.

### §292. NO TERMINAL POD

NO TERMINAL POD. Everything below is DIAGNOSIS, and it is gathered while the run is still alive because teardown deletes the Job and takes the Job's events with it.

AND DIAGNOSIS NEVER BECOMES THE FAILURE. The whole block is swallowed: a Role that predates M23.5 has no `events` grant, a `GET job` can 404 against a Job something else deleted, and either of those replacing the real cause would be this same defect wearing a different mask. What is lost when it fails is specificity, never the verdict.

### §293. Every failure of it degrades too

AND EVERY FAILURE OF IT DEGRADES, NOT ONLY THE DEADLINE — M23.5 verification pass 18, and the third instance the census of "what turns a condition into a verdict" turned up.

`termination` IS ALREADY SETTLED by the line above: the pod, or the Job, has said what became of the runner. This read is DIAGNOSIS. M23.5 made a refused-by-deadline log read degrade rather than replace "the runner exited 3" with "budget-exhausted", and then left every OTHER way that read can fail — a 403 from a Role without `pods/log`, a 500, a reset, a node that went away between the two calls — able to do exactly the same thing. Those reached `classifyRunnerFailure` as an HTTP status, which is a NUMERIC `code`, i.e. `exit-nonzero`: "the runner itself exited non-zero", with the status as the exit code, about a runner whose real exit code this process was holding at the time.

"DIAGNOSIS NEVER BECOMES THE FAILURE" IS THIS FILE'S OWN RULE, stated forty lines above about the events/Job reads, where the whole block is swallowed. The log read is the one that was left outside it, twice.

### §294. The one place saying what the failure meant

AND THIS IS THE ONE PLACE THAT SAYS WHAT THE FAILURE MEANT — M23.5, corrected by verification pass 18.

`budget-exhausted`'s wording is "a `tofu apply` was SIGTERMed mid-flight, so the real infrastructure state is unknown", which `FATAL_WAITING_REASONS` calls the single worst misdiagnosis available here. It is true only if something RAN — and `spawn-failed` ("NOTHING RAN and nothing was mutated") is true only if this run WATCHED nothing run. WHICH of the deadline's four possible discovery points happened to fire is not a fact about the run at all; what this loop OBSERVED is, so the decision is made from the observations, once, here.

IT WAS `e.deadlineExceeded && !everStarted`, AND `!everStarted` MEANT TWO THINGS. "Observed, and nothing had started" and "never observed at all" were one flag, and only the first can support "nothing was mutated". `kubernetesStartVerdict` is the same decision with the two separated — and as a pure function, because three lines buried in a `catch` is why the arm that was wrong had nothing pinning it.

### §295. The failure that ended the run is carried

AND THE FAILURE THAT ACTUALLY ENDED THE RUN IS CARRIED, NOT DISCARDED. The previous rewrite replaced the whole message, so a 403, a reset or a refused step vanished behind a sentence about the budget: the reader was told the conclusion and never the evidence, which is the half of principle 6 a Decision cannot do without.

### §296. A string code, read by the classifier

A STRING `code`, read by `classifyRunnerFailure`, and BOTH of these are tested there ahead of `deadlineExceeded`: `RUNNER_NEVER_STARTED_CODE` so that "nothing ran" cannot be overwritten by "stopped mid-flight", and `RUNNER_OUTCOME_UNKNOWN_CODE` so that "I do not know" cannot be either. Neither reaches its kind by being a string any more — that was the accident pass 20 removed.

### §297. The evidence the original carried is kept

AND THE EVIDENCE THE ORIGINAL CARRIED IS CARRIED TOO. These used to be blanked, which was invisible while this rewrite only ever fired on a deadline path where both were already empty — and a lost property the moment it also fires on a REFUSED unsuspend, whose `stderr` is the API server's echoed (and redacted) body. `A FAILURE MID-RUN REDACTS THE BASE64 ENCODING TOO` is the test that found it.

### §298. The bound is reported as it was, every arm

AND THE BOUND IS REPORTED AS IT WAS, FOR EVERY ARM — M23.5 verification pass 20, and the deletion of a `false` that had become a contradiction.

IT USED TO READ `verdict.code === RUNNER_OUTCOME_UNKNOWN_CODE ? e.deadlineExceeded : false`, defended as load-bearing twice over: it stopped `budget-exhausted` winning the classification, and it was said to be "TRUE in the sense the boolean is read, because a Job the controller could not place would not have started with any budget at all". THE FIRST HALF IS NO LONGER TRUE AND THE SECOND NEVER WAS.

- The classification no longer depends on it: `classifyRunnerFailure` tests `RUNNER_NEVER_STARTED_CODE` itself, ahead of `deadlineExceeded`, so the kind is `spawn-failed` whatever this boolean says. A flag suppressed to protect a ternary somewhere else is a workaround, not a fact. - The reading it was defended on — "would more budget have helped?" — is not the reading `RunnerFailure.deadlineExceeded` documents. That field is WHICH BOUND ENDED THE RUN, and it says so at the type, one sentence long. Arm 2 made the disagreement undeniable: its message is "the whole-run budget of Nms was already spent when this run reached 'start'", the remedy really is to raise the budget, and the record carried `deadlineExceeded: false` beside those words.

SO IT PASSES THROUGH. `false` still arrives here for every arm the budget did NOT end — a REFUSED unsuspend (arm 3) is an HTTP status, not a clock — because it comes from the failure rather than from a rewrite of it.

### §299. Teardown: unconditional, outside the run budget

6. TEARDOWN — unconditional, OUTSIDE the run budget (the commonest reason to reach it is that the budget is what ran out), swallowed but not silent, and skipped ENTIRELY for a run that lost its name. Three objects, in the order that leaves nothing addressable if an earlier one fails: the Job (which owns the pod), then the Secret, then the bytes.

```text
 THIS IS THE FAST PATH FOR THE SECRET, NOT THE GUARANTEE. The guarantee is the
 `ownerReference` step 2b attaches: delete the Job and the collector takes the Secret
 whether or not this block ever runs. What this block buys is LATENCY — seconds instead
 of however long the collector takes — and it is worth having for exactly that, which is
 also why its failure is swallowed rather than escalated. A `finally` that is the only
 thing standing between a credential and an unbounded lifetime is the M23.1d defect; a
 `finally` that merely shortens a bounded one is not.
```

### §300. THREE BOUNDED CALLS, AND THE NAMES ARE THE MODEL

THREE BOUNDED CALLS, AND THE NAMES ARE THE MODEL (M23.5 HIGH-2). `RUNNER_POST_DEADLINE_CALLS` lists them, `withPostDeadlineBound` will not accept a name that is not in that list, `teardown-model.test.ts` counts every effect this adapter issues at or after the run deadline whatever its shape, and every grace downstream — the reap stamp here, `MANAGED_TRIGGER_GRACE_MS` in the host — is derived from the count. A fourth call added here does not compile until it is declared, and declaring it moves every grace that depends on it. Before this, the grace was 60s chosen as "two worst-case teardowns" of a teardown that had since become three, and nothing anywhere knew.

EACH ONE IS BOUNDED. `removeDir` in particular is the `rm` on the network volume, which had no bound at all — a teardown that never returns is the same unreturned `run()` as a copy-in that never returns, arriving one line later.

### §301. Escapes the operands and values for variable expansion

ESCAPES `spec.operands` AND `spec.env[].value` FOR THE KUBERNETES `$(VAR)` EXPANSION SYNTAX (M23.5 MEDIUM-6). The API server expands `args` and `env[].value` itself, independent of and before the shell the runner's image runs: `$$` collapses to a literal `$`, and `$(NAME)` is replaced with the value of a container env var named `NAME` (defined ones substitute; undefined ones pass through as literal text) — INCLUDING a key that arrives only through `envFrom`'s `secretRef`, which is exactly the channel `spec.secretEnv` uses to keep a credential out of this manifest. Measured: an operand `"$(MY_CREDENTIAL)"` with a matching `secretEnv` key put that credential's VALUE into the runner's argv — a manifest built to keep secrets out of `args` defeating itself the moment a caller's text happened to look like a reference. `spec.operands` and `spec.env` are caller-controlled (an IaC action name today; managed-dep already puts tenant manifest text in an operand), so this is not a hypothetical those callers must remember — it is applied here, once, to both fields, so BYTE-FOR-BYTE pass-through is what every caller gets. `$` is the only character `$(VAR)`/`$$` expansion is sensitive to, so escaping it alone is sufficient: `$$` in the caller's text becomes `$$$$`, which the API server collapses back to `$$`, and `$(` becomes `$$(`, which is never a `$(VAR)` opener. Pinned in `kubernetes-launch.golden.test.ts` ("MEDIUM-6").

### §302. THE JOB MANIFEST

THE JOB MANIFEST — this adapter's `argv`, and the thing its golden pins whole.

A PURE FUNCTION OF THE SPEC AND THE DEPLOYMENT SETTINGS, exported for exactly that reason: the Docker adapter's complete statement of intent is one array of strings a test can compare, and the Kubernetes equivalent has to be equally comparable or the golden degrades into "some of the fields we remembered to check". `kubernetes-launch.golden.test.ts` asserts the whole object with `toStrictEqual`, so a field ADDED here without a golden update is a red test rather than a silent change to what every managed run does.

`args` and `env[].value` are escaped through `escapeKubernetesVarExpansion` before they reach this object (M23.5 MEDIUM-6) — see that function for why an unescaped caller string can leak a `secretEnv` value into the runner's argv.

### §303. A backstop for the budget, enforced by the controller

A BACKSTOP FOR THIS RUN'S OWN BUDGET, ENFORCED BY THE CONTROLLER RATHER THAN BY A PROCESS THAT MUST STAY ALIVE TO ENFORCE IT (M23.5 MEDIUM-9). Every OTHER Job this chart creates (migrations, both bundled auto-wire hooks) states one; this one — the only Job that ever holds a mounted cloud credential — did not. `run()`'s own budget already bounds the LAUNCHER's wait via `runDeadline` and `withStepBound`, but that bound lives in a process: if the launcher is killed (a SIGKILL mid-`trigger()`, the same shape M23.1d's whole fix was about) between `start` and its own teardown, nothing left running enforces it, and the pod — with its mounted credential — keeps going until some LATER `reap()` pass notices. The Job controller enforces this one independently of this process's survival. Derived from `spec.timeoutMs` via `runnerRunBoundMs` rather than a flat constant: the same bound the launcher's own promise to the caller already is, so a class with a longer `timeoutMs` (managed-iac's `tofu apply` against a large estate) does not get truncated by a value sized for a different one.

### §304. THE DEPLOYMENT'S OWN PULL SECRETS

THE DEPLOYMENT'S OWN PULL SECRETS (M23.5). Every other pod this chart creates carries `.Values.imagePullSecrets`; this one carried none, so a runner image in a private registry could not be pulled at all while the worker pulling `scpd` from that SAME registry worked. Omitted entirely when the deployment states none, so nothing changes for a public-registry install.

### §305. An unset pull policy means always for latest

AN UNSET `imagePullPolicy` IS `Always` FOR A `:latest` TAG, and that is charter principle 5 broken in production: measured on a real cluster with the image already loaded on the node, the run failed `spawn-failed, code=ErrImagePull` while the identical image ran fine under `docker create`. The chart passes `.Values.image.pullPolicy` here, the same value its other five pods use.

### §306. NO KUBERNETES CLIENT LIBRARY

NO KUBERNETES CLIENT LIBRARY (owner decision 7, and it is verified rather than asserted: a filterless grep for `@kubernetes/client-node`/`kubernetes-client` over `package.json`, `pnpm-lock.yaml`, `apps` and `packages` returns zero). The precedent already ships twice — `bundled-argocd-autowire-bin.ts:69-95` and `bundled-gitea-autowire-bin.ts:71-97` — and both rely on the SAME constraint this transport inherits: Node's global `fetch` cannot take a custom CA without an undici Agent, so the cluster CA must reach it through `NODE_EXTRA_CA_CERTS`. That is a DEPLOYMENT obligation, not a code one, and the chart is where it is met.

`token` and `apiBase` are read per request rather than captured: a projected token is rotated in place by the kubelet, and a launcher instance outlives one rotation only if it re-reads.

### §307. The timeout is handed down as a best effort

`timeoutMs` IS HANDED DOWN, and honouring it is a BEST EFFORT rather than the guarantee (M23.5). `node:fs/promises`' `cp` and `rm` take no `AbortSignal`, so the filesystem implementations below cannot honour it at all; what makes the bound true is `withStepBound` in `index.ts`, which the adapter wraps every one of these calls in. The parameter is here so that an implementation which CAN self-limit does — cancelling beats abandoning, since abandoned work stays in flight.

### §308. THE SELECTING RESOLVER

THE SELECTING RESOLVER — one switch on an EXPLICIT operator setting, never an auto-detection.

`resolveDockerRunnerLauncher`'s own doc has said since M23.1 that this is "NEVER an auto-detection of the platform (M15.4 declined to create that runtime/install-time fork, and guessing from the presence of a service-account token is exactly that guess)". This function is that promise cashed: the ONLY thing it reads is `config.runnerLauncher`, and an unset value is Docker — byte-identical behaviour for every deployment that does not opt in, which is what makes M23.2 safe to merge.

WHERE THE VALUE COMES FROM AND WHY IT CANNOT COME FROM A TENANT. `runnerLauncher` and the `kubernetes` block below it join the server-injected/never-tenant-settable class on day one, and that class is three layers, all of which move in this same change (index.ts's own note: "WHEN M23.2 ADDS ADAPTER SELECTION it becomes a config field, and all three layers must be updated in that same change"): each plugin's manifest `configSchema` (`additionalProperties: false`, so the key is refused by schema), `validatePluginConfig` at the four write doors (refused by name), and the LAST-wins injection sites in `executor-bindings-repo.ts` / `managed-dep-instance.ts` / `promotion-scan-step.ts` (overwritten even if the first two ever regress). Two defences that fail independently, plus the injection that wins — the same posture `dockerBinary` has since the managed-scan RCE.

### §309. The production adapter object, as a named export

THE PRODUCTION `io`, AS A NAMED EXPORT RATHER THAN AS THREE ANONYMOUS CLOSURES (M23.6 clause 1).

WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL INSIDE THE RESOLVER, WHICH IS WHERE IT LIVED. These three closures are the ONLY part of the Kubernetes path that no test could reach. Every unit fixture in this repository — all four behaviour drivers, all three plugin selection tests, the kind suite — supplies its own `io`, so the right-hand side of `k8s.io ??` was DEAD to the whole suite: it was neither evaluated nor executed anywhere, which is exactly how a `spawnSync` planted on that right-hand side ran a real `docker version` with 427 + 38 + 50 + 255 tests green. Code a gate cannot reach is code the gate does not gate, and the fix is to make it reachable BY NAME rather than to write a cleverer gate over the same unreachable expression.

`no-spawn-on-kubernetes.behaviour.test.ts` now drives all three of these under the spawn observer: `request` far enough to prove `readToken` ran (its ENOENT names the token path — this process is not a pod), and `copyDir`/`removeDir` all the way, against real temp directories.

It changes nothing at runtime: the resolver calls this and only this, `createFetchKubernetesIo` still counts the one construction, and no new field appears on `RunnerLauncherConfig` — an injectable io/spawner on that server-injected surface was rejected for M23.2 and is still rejected.

## `packages/runner-launcher/src/kubernetes-launch.golden.test.ts`

### §310. THE KUBERNETES LAUNCH GOLDEN

THE KUBERNETES LAUNCH GOLDEN — the whole manifest, pinned, in one `toStrictEqual`

THIS FILE EXISTED AS A CLAIM BEFORE IT EXISTED AS A FILE, and that is why it is here. M23.2's `jobManifest` doc says, verbatim: "`kubernetes-launch.golden.test.ts` asserts the whole object with `toStrictEqual`, so a field ADDED here without a golden update is a red test rather than a silent change to what every managed run does." A filterless grep for that filename across the repo returned exactly ONE hit — the sentence itself. The function was exported for a gate that was never written, which is the precise shape CLAUDE.md names: "treat a well-written comment naming a hazard as a signal to sweep, not as evidence it was handled". M23.4 changes what a launch sends, so the gate is written before the change rather than after it.

WHY A GOLDEN AND NOT FIELD-BY-FIELD ASSERTIONS. The Docker adapter's complete statement of intent is one array of strings and `launch-argv.golden.test.ts` pins it whole; the Kubernetes equivalent is this object, and pinning "the fields we remembered to check" degrades into a test that cannot see an ADDED one. `toStrictEqual` on the whole manifest is the only shape where a new field — a `hostNetwork`, a `serviceAccountName`, a mount, an `env` entry carrying a credential — reddens a test instead of shipping.

THE SECOND OBJECT A LAUNCH PRODUCES — the per-run Secret — is NOT built by a pure function and so is not pinned here. It is pinned in `kubernetes-adapter.test.ts` ("THE SECRET IS OWNED BY THE JOB" and "the value travels as a Secret + envFrom"), which reaches it through the recording fake.

### §311. The owner id cannot be a literal: it is per process

`LAUNCHER_OWNER_ID` IS THE ONE FIELD THAT CANNOT BE A LITERAL — it is a per-PROCESS uuid, and that is deliberate rather than incidental: `reap()` distinguishes "my Job" from "a dead peer's Job" by it, so a stable literal would make every launcher in a replica set believe it owned every other's runs. Pinned by identity to the exported constant, which still catches a change to WHICH label carries it.

### §312. The golden is an equality, so it already forbids it

THE GOLDEN IS AN EQUALITY, so it already forbids the value — but only for THIS spec's literal. This is the same claim as a PROPERTY, which is what survives someone regenerating the golden from actual output: whatever the manifest becomes, the secret half of `secretEnv` is not in it. (The KEY is expected to be absent too: it arrives through `envFrom`, which names only the Secret, so a key appearing here would mean a fallback to `env[].value` had been reintroduced.)

### §313. THE DEPLOYMENT'S POD CONVENTIONS

THE DEPLOYMENT'S POD CONVENTIONS (M23.5)

THE GOLDEN ABOVE IS THE FIRST HALF OF THIS PROOF AND IT IS UNCHANGED, which is the point: a deployment that states no conventions produces the SAME manifest it produced before the channel existed. What follows pins the other half — what arrives when a deployment states them, and that each one is emitted only when stated.

WHAT WAS WRONG. `deploy/helm` creates six pods; five are templates that carry `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a `resources` block, and the sixth is this object, built at run time from settings that described a namespace, a workspace and two booleans. It inherited none of them. Measured on a real cluster, image already on the node and tagged `:latest`: `spawn-failed, code=ErrImagePull — failed to pull and unpack image docker.io/library/scp-probe-runner:latest`, while the identical image ran fine under `docker create`. An unset `imagePullPolicy` is `Always` for `:latest` — charter principle 5 broken in production by an omission.

### §314. Arguments and values are escaped for variable expansion

MEDIUM-6 — `args` AND `env[].value` ARE ESCAPED FOR KUBERNETES `$(VAR)`/`$$` EXPANSION

Kubernetes expands `$(VAR)` and collapses `$$` -> `$` in `args` and `env[].value`, ON THE API SERVER, independent of the runner image's own shell. Measured: `"A[$$]B[$(NOT_DEFINED)]C[$PLAIN]"` came back as `"A[$]B[$(NOT_DEFINED)]C[$PLAIN]"`, and an operand `"$(MY_CREDENTIAL)"` with a matching `secretEnv` key interpolated that credential's VALUE from the `envFrom` secretRef straight into the runner's argv — visible only as `***` because the adapter's own redactor happened to catch it. `escapeKubernetesVarExpansion` is applied to both fields so the caller's text survives byte-for-byte instead of being run through a second, undocumented interpreter.

### §315. MEDIUM-9 — `activeDeadlineSeconds`

MEDIUM-9 — `activeDeadlineSeconds`: A CONTROLLER-ENFORCED BACKSTOP, NOT JUST A PROCESS'S PROMISE

Every OTHER Job this chart creates (migrations, both bundled auto-wire hooks) states one. This is the only Job that ever holds a mounted cloud credential, and until this fix it had none: the launcher's own `run()` budget lives in a process, and a SIGKILL of that process between `start` and its own teardown (the exact shape M23.1d's whole fix was about) leaves the pod running, credential mounted, with nothing enforcing a stop until some LATER `reap()` pass notices.

## `packages/runner-launcher/src/kubernetes-rbac-contract.test.ts`

### §316. What the adapter asks the API server for, derived

M23.6 CLAUSE 5 — WHAT THE ADAPTER ASKS THE API SERVER FOR, DERIVED FROM RUNNING IT

`kubernetesRunnerRbac()` is a DECLARATION, and a declaration on its own is prose with a type. This file holds it to the code: it drives the adapter across every route it has, over a recording io, maps each `(method, path)` that ACTUALLY REACHED THE WIRE onto the Kubernetes verb the authorizer would require, and asserts the derived set EQUALS the declaration. `tools/helm-verify` then asserts the RENDERED ROLE equals the same declaration. Three things agree, or the build is red — and the diff fails in BOTH directions, which is the half M23.6's clause 5 was missing.

WHY BOTH DIRECTIONS ARE THE POINT. Before this, helm-verify checked `batch/jobs` with `JSON.stringify(rules).includes('"patch"')`, `events` and `secrets` with a set-equality, and `pods`/`pods/log` not at all. Measured against that gate: adding four UNUSED verbs to the chart (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`) left helm-verify green, `pnpm -w test` green (72/72) and the kind suite green (21/21). A gate that only catches a MISSING verb lets a privilege drift wider forever.

AND IT HAD ALREADY DRIFTED. The shipped Role granted `watch` on `batch/jobs` and on `pods,pods/log` — inherited from M8's reference shape — while `KUBERNETES_POLL_INTERVAL_MS`'s own doc says "A POLL AND NOT A WATCH, deliberately" and there is no `watch=` query anywhere in the adapter. It also collapsed `pods` and `pods/log` into ONE rule, which grants each the other's verbs: `get` on `pods` and `list` on `pods/log`, neither ever issued.

THE CENSUS SLOT AT THE BOTTOM is what stops this file being a test of the routes it happens to know about. Every request this adapter can issue is built from a `method: "<VERB>"` literal; the count and multiset of those literals is pinned, so a NEW call site — the one this matrix would not drive — fails here by count before it can reach a cluster with no grant behind it.

### §317. A recording io over a minimal stateful cluster

A recording io over a minimal stateful cluster. Deliberately NOT a canned response list: the adapter POSTs a Job and then PATCHes and DELETEs it BY NAME, and a list cannot notice being asked about a name it never issued.

### §318. ROUTE 1 — a whole successful run

ROUTE 1 — a whole successful run: the Secret POST, the Job POST, the unsuspend PATCH, the pod list, the log read, and the teardown's two DELETEs. `secretEnv` is populated ONLY when the deployment has the grant: with `perRunSecrets: false` the adapter REFUSES the run rather than falling back to `env[].value`, which is the correct behaviour and would drive no routes at all.

### §319. M23.6, SECOND PASS

M23.6, SECOND PASS — THE ONE PRESENT-TENSE FALSEHOOD OF ITS KIND IN THE TREE
`deploy/helm/README.md` told operators the Role granted "`batch/jobs` create/get/list/watch/patch/delete, `pods`/`pods/log` read, and `secrets` create/delete". Every clause of that was wrong after M23.6 narrowed the Role: there is no `watch` (this adapter POLLS), `pods` and `pods/log` are two resources with one verb each rather than a shared "read", and `events: list` — added in M23.5 and the only record of why a Job that never produced a pod failed — was missing from the sentence entirely. The commit that wrote the section never touched it again and the narrowing never came back to it.

A SENTENCE AN OPERATOR USES TO PLAN THEIR RBAC IS AS LOAD-BEARING AS THE ROLE, so it is read here and compared to the same declaration `tools/helm-verify` compares the RENDERED Role to. Three things now agree — the wire, the chart, and the prose — or the build is red.

### §320. The matrix cannot, on its own, prove the rest

The matrix above proves what the routes it drives require. It cannot, on its own, prove there is no ELEVENTH route — the one nothing drives and no Role grants, which is exactly how a managed run turns into a 403 nobody predicted. Every request in this adapter is built from a `method: "<VERB>"` literal, so the multiset of those literals is the count of what can be issued at all. Add a call site and this fails BY COUNT before it can reach a cluster.

`method: req.method` (the transport, in `createFetchKubernetesIo`) and the `method` field on `KubernetesApiRequest` itself are not literals and are correctly invisible here.

## `packages/runner-launcher/src/module-load.integration.test.ts`

### §321. THE BUILT PACKAGE LOADS UNDER A REAL NODE ESM LOADER

THE BUILT PACKAGE LOADS UNDER A REAL NODE ESM LOADER — M23.2, AND IT IS HERE BECAUSE IT CAUGHT ONE

WHAT HAPPENED, MEASURED, NOT IMAGINED. M23.2 added `kubernetes-adapter.ts`, which imports `./index.js`, and made `index.ts` re-export it. That cycle is legal ESM for function bodies and an immediate `ReferenceError` for a top-level `const` initialised from the other module's binding — and the file had exactly one such line:

export const RUNNER_LAUNCHER_DEADLINE_ANNOTATION = RUNNER_LAUNCHER_DEADLINE_LABEL;

Under a real loader:

```text
  ReferenceError: Cannot access 'RUNNER_LAUNCHER_DEADLINE_LABEL' before initialization
      at .../packages/runner-launcher/dist/kubernetes-adapter.js:138
```

Every managed-executor plugin subprocess died at import, and the only symptom anywhere was `plugin instance 'managed-iac-budget' did not become ready within 10000ms` from `apps/server`'s budget suites — three failures whose message names nothing about a module cycle.

AND THE PART THAT MAKES THIS FILE NECESSARY RATHER THAN TIDY: a unit test written to catch exactly this was GREEN. `kubernetes-adapter.test.ts`'s first case says in its own comment "if any binding of this file's imports were read at module-evaluation time rather than at call time, THIS line would throw a TDZ ReferenceError before the assertion" — it did not, because vitest resolves the cycle through its own module graph in the other order. A claim about a loader cannot be verified with a different loader (CLAUDE.md: "a claim about a tool cannot be verified with that tool").

SO THIS TEST BUILDS THE PACKAGE AND LOADS IT WITH `node`. Building first is not politeness: the manifests and plugins resolve `main: dist/index.js`, so a test that read a stale `dist` would report the previous commit's answer — the same "checks that pass without running" family.

## `packages/runner-launcher/src/no-docker-on-kubernetes.test.ts`

### §322. M23.6 CLAUSES 1 AND 7

M23.6 CLAUSES 1 AND 7 — THE TWO LEDGERS, AND THE CENSUS THAT KEEPS THEM COMPLETE

The per-class arms live in each plugin's `runner-launcher-selection.test.ts`, because the clause asks for "each of the three plugins" by name. What lives HERE is the thing those three arms rest on and cannot check for themselves: that the ledgers see EVERYTHING.

A gate built on "the spawn ledger was empty" is worth exactly as much as the guarantee that a spawn cannot happen off-ledger. So: - `execFileAsync` — the package's only binding of `promisify(execFile)` — must be referenced EXACTLY ONCE, inside `spawnRunnerProcess`. A second direct call is a spawn no ledger sees. - `kubernetesConstructions += 1` must appear exactly twice, once in each of the Kubernetes module's two constructors, and that module must export exactly those two constructors. - the three managed plugins must import no process-spawning API of their own. A plugin that called `child_process` directly would bypass this package entirely, and the three selection tests would keep passing while the clause was false.

WHY A SOURCE CENSUS RATHER THAN A RUNTIME CHECK. Both are "this never happens anywhere", and a runtime check can only speak for the paths a test drives. `grep -rna`, deliberately: CLAUDE.md §4.4b — some tracked source files carry literal NUL bytes and a plain recursive search drops them with no output and exit 1, which is indistinguishable from "no such code exists". This file reads the bytes itself rather than shelling out to a search tool, which sidesteps the hazard entirely.

### §323. Comments removed, so a census counts CODE

Comments removed, so a census counts CODE. This file's own subjects are heavily documented — the Docker adapter's doc explains `execFile`'s three traps and the Kubernetes adapter's explains why `maxBuffer` is an `execFile` concept it does not have — and a census that counted prose would be a gate on how much a hazard is explained rather than on whether it exists. That is the inverse of CLAUDE.md's rule: a comment naming a hazard is a signal to sweep, never the thing swept.

### §324. THREE NAMES, TWO COUNTED CONSTRUCTIONS

THREE NAMES, TWO COUNTED CONSTRUCTIONS. `createDefaultKubernetesIo` (M23.6) builds nothing of its own — it delegates to `createFetchKubernetesIo`, which is why the count above stays at two — and it exists because the three closures it now holds were, as an object literal inside `resolveRunnerLauncher`, the one stretch of the Kubernetes path NO test could reach. That is where a planted `spawnSync` ran a real `docker version` with every suite green.

## `packages/runner-launcher/src/no-spawn-on-kubernetes.behaviour.test.ts`

### §325. M23.6 CLAUSE 1, CLOSED BEHAVIOURALLY

M23.6 CLAUSE 1, CLOSED BEHAVIOURALLY — "NOTHING WAS SPAWNED" AS AN OBSERVATION

WHAT WAS WRONG WITH THE GATE THIS REPLACES, MEASURED RATHER THAN SUSPECTED. `runner-iac.yaml`'s replacement for the retired HONEST SCOPE note asserts "NOTHING SPAWNS A CONTAINER CLI ON THIS PATH". Two things stood behind that sentence and neither could carry it:

```text
1. THE LEDGER. `spawnRunnerProcess` records every spawn it makes, and each managed plugin
   asserts the ledger is empty on the Kubernetes path. But the ledger only sees what goes
   THROUGH it. A real `child_process.execFile(dockerBinary, …)` planted in
   `resolveRunnerLauncher`'s Kubernetes branch left all three of those tests GREEN while the
   verification pass recorded FOURTEEN spawns actually happening.
2. THE SOURCE CENSUS in `no-docker-on-kubernetes.test.ts`, which is what did redden. It is a
   statement about TEXT. A census can prove a string is present; it can never prove an execution
   is absent, because the next spawn is written in whatever spelling the census does not hold —
   a helper in a new file, a rename, a dynamic `import()`. This repository has a named failure
   for reading text and calling it behaviour, and `@scp/source-census`'s own module doc opens
   with ten instances of it.
```

SO THE OBSERVATION MOVES OUTSIDE THE SUBJECT. Every case below runs the BUILT package in a child `node` whose `node:child_process` was wrapped before the subject loaded, and asserts over the list of processes that were actually created. See `@scp/source-census`'s `spawn-observer.ts` for the mechanism, the `util.promisify.custom` trap that would have made it silently blind to the exact call this package makes, what it does not cover, and why an injectable spawner on `RunnerLauncherConfig` — the shape the clause's own wording suggested — was rejected as both a new hole in the server-injected config surface AND strictly weaker than this.

THE CONTROLS ARE THE POINT, NOT THE PADDING. An observer that recorded nothing at all would satisfy the negative arm forever, and this file's whole reason for existing is that a green negative arm was already worthless once. So: the Docker path must be observed spawning (which also proves the promisified route is wrapped, since that is the only way this package spawns), a raw `execFile` in the driver must be observed, and — the measurement that names the defect — that same raw `execFile` must be observed while `runnerSpawnCount()` stays at zero, which is the ledger's blind spot reproduced on purpose so it cannot be quietly re-introduced as the whole gate.

COST, STATED. Four child `node` processes, ~1s each, plus one `tsc -b`. The subject has to be reachable as built `dist` (vitest's loader is not in the picture, deliberately — the module-cycle defect `module-load.integration.test.ts` exists for was invisible to it), and the driver is a string rather than type-checked code.

### §326. A stateful in-child fake, not a canned response list

A stateful in-child fake API server, deliberately NOT a canned response list: the adapter POSTs a Job and then PATCHes and DELETEs it BY NAME, and a list cannot notice being asked about a name it never issued. Written as source because it has to be constructed inside the observed child.

### §327. THE DEFECT, EXECUTED

THE DEFECT, EXECUTED. This is the shape of the mutation that left the three per-plugin ledger assertions green: a spawn that does not go through `spawnRunnerProcess`. It is planted in the driver rather than in the package so it can stand permanently, and it asserts BOTH halves — the observer sees it, and `runnerSpawnCount()` does not. Delete the observer and the only thing left watching this is a count that reads zero.

### §328. THE HOLE THE CASE ABOVE LEFT, NAMED AND MEASURED

THE HOLE THE CASE ABOVE LEFT, NAMED AND MEASURED (M23.6, third pass)

EVERY case above — and every one of the three plugin selection tests, and the whole kind suite — INJECTS `k8s.io`. `resolveRunnerLauncher` reads it as `k8s.io ?? createDefaultKubernetesIo(…)`, and the right-hand side of a `??` is not evaluated when the left is present. So the resolver's own default transport was, until this case existed, code that NO test in this repository ever evaluated or executed.

THAT IS NOT A THEORETICAL GAP; IT WAS EXERCISED. A `spawnSync(config.dockerBinary ?? "docker", ["version"])` planted on that right-hand side — in a NEW module, so no `node:child_process` string appears in `kubernetes-adapter.ts` and the source census in `no-docker-on-kubernetes.test.ts` sees nothing — ran a REAL `docker version` on this machine while `@scp/runner-launcher` reported 427/427 and the three managed plugins reported 38 + 50 + 255, all green. It was proven reached, not merely present: the probe appended to a marker file and the marker said `reached docker`. The gate above did not miss it by a hair; it could not see that expression at all.

THE FIX IS REACHABILITY, NOT A CLEVERER ASSERTION. A gate that names the place a spawn could happen keeps missing the place it does happen — that is what the source census was, and "the direct call in the Kubernetes branch" is the same mistake one level in. So the two cases below take the two things no test took before: the resolver with NO `io` injected (which forces the `??` right-hand side to be evaluated — `kubernetesConstructionCount()` moving by TWO rather than ONE is the machine-checked proof of that, and it is the assertion that fails if a future edit quietly restores an injected default), and the default transport's own three closures, EXECUTED.

NEITHER CASE PASSES `dockerBinary`, deliberately. The Kubernetes adapter is not given one in production and must not need one; with the field absent a probe reaching for a container CLI can only fall back to `DEFAULT_DOCKER_BINARY`, and `run.spawns` must still be empty — so `[]` here is the whole assertion and no binary name has to be guessed in advance.

### §329. The case above reaches `readToken` and stops there

The case above reaches `readToken` and stops there: the run cannot get past a token this process does not have. `copyDir` and `removeDir` are the two closures a run would reach NEXT, they move real bytes on the shared volume, and a `fork()` behind a dynamic `import()` inside either of them is reached by no construction-time check and named by no census. So they are driven directly, on real directories, with the bytes checked afterwards — a `copyDir` that silently did nothing would spawn nothing either.

## `packages/runner-launcher/src/ordering-conformance.ts`

### §330. THE AWAIT-ORDERING CONFORMANCE SUITE

THE AWAIT-ORDERING CONFORMANCE SUITE — ADAPTER-NEUTRAL, AND REUSED BY EVERY ADAPTER

WHY THIS EXISTS AS ITS OWN FILE. `docker-adapter.test.ts` proves WHAT the adapter puts on the command line. It cannot prove WHEN, and for a while nobody noticed: its recording seam invoked every `execFile` callback SYNCHRONOUSLY, so each step resolved before the next line of the adapter ran and the recorded array was ISSUE order — which is identical whether a step was awaited or fired and forgotten. Twenty tests, twenty mutations "caught", and these two both SURVIVED:

```text
  await pending.catch(() => undefined);              ->   void pending.catch(() => undefined);
  await execFileAsync(docker, ["rm", "-f", id], …)   ->   void execFileAsync(…)
```

managed-iac's copy-out arm is `when: "always", onFailure: "swallow"`. Drop the first await and the `finally { docker rm -f }` fires while `docker cp <id>:/workspace/. <workspaceDir>` is still streaming: the container dies mid-copy, `plan.json` lands truncated or absent, `run()` still returns `{ succeeded: true }`, and the plugin caches a succeeded apply with no evidence — with the whole build green.

WHY IT IS PARAMETERISED RATHER THAN TWO MORE DOCKER TESTS. M23.2 adds a Kubernetes-Job adapter and will be written against `docker-adapter.test.ts` as its conformance contract. Ordering is not a Docker property — a Job adapter that deletes the Job while the evidence copy is still streaming loses exactly the same plan.json — so these checks are expressed over the PORT's five lifecycle steps, and an adapter supplies a `LaunchOrderingSubstrate` that can hold one step open. The Kubernetes adapter inherits every case below by writing a substrate, not by re-deriving the race.

WHAT A SUBSTRATE MUST DO, AND THE ONE THING THAT MAKES IT HONEST: a held step must be ISSUED and must NOT SETTLE.

CORRECTED CREDIT (this used to say a substrate that delayed the ISSUE instead of the settle "would make every held case below pass vacuously — which is why the first case is the UNHELD CONTROL". Measured false: forcing a held step's recording to wait for delivery instead of happening at issue time reddens EIGHT of the nine held cases directly — each one's own pre-release assertion that the held step already appears in `issued()` fails — while the unheld control, which holds nothing, passes unaffected. The protection is real; it lives in the held cases' own assertions, not in the control. The control's actual job is the one stated in its own name below: proving the substrate issues the full sequence AT ALL, so a held case with a step simply missing from `issued()` can be read as "the hold ate it" rather than as "nothing here works."

THE SECOND DESCRIBE IS ABOUT IDENTITY, NOT ORDER, and it is here for the same inheritance reason. Every case above — and every case in `docker-adapter.test.ts` — has exactly ONE `run()` in flight, so one run's steps are the only steps there are and nothing can catch a per-run value kept somewhere shared. Hoisting `const containerId` (index.ts:200) to module scope typechecks clean and passed all thirty tests of the M23.1 suite; with two runs in flight it makes one run's `rm -f` destroy the OTHER run's container, orphaning the first with its resolved credentials still in its environment and tearing the second down twice. That is not a Docker property either: a Job adapter that kept the Job name in a module binding loses exactly the same way, so the case is expressed over identities and inherited by writing a substrate.

### §331. The per-run identity each issued step addressed

THE PER-RUN IDENTITY each issued step ADDRESSED, aligned one-for-one with `issued` — the Docker container id, a Kubernetes Job name, whatever this adapter's runs are named by. For a `create`, the identity that call PRODUCES (Docker reads it out of the call's stdout; an adapter that generates the name up front already has it on the argv).

REQUIRED, not optional, and the concurrency case THROWS rather than skips when a substrate reports `undefined`: an adapter author who could opt out would opt out, and the case would then pass vacuously for exactly the adapter that had not thought about two runs at once.

### §332. Settle the OLDEST still-held occurrence of `kind`

Settle the OLDEST still-held occurrence of `kind` — successfully, or with `failure`.

CORRECTED CLAIM (this used to take a third `nth` argument selecting AMONG held occurrences, on the theory that releasing out of order was what the concurrency case below needed — measured false. Every identity this suite checks is allocated at ISSUE time, not at settle time: the Docker substrate's `stepIdentity` reads the id off `createdIds`, populated the instant `create` is issued (see docker-adapter.test.ts, "ALLOCATED AT ISSUE TIME, not at delivery"), so no order of *releasing* two held creates can move which identity either run ends up with. Measured directly: forcing every release to the oldest-held occurrence (removing `nth` entirely) still catches the containerId-hoist mutation the concurrency case exists for, at the same one case. The mechanism was never load-bearing; removed rather than kept as an unexercised obligation a future adapter's `release` would have had to implement with nothing checking it did.

### §333. Optional: flush this substrate's deliveries once

Optional: flush whatever this substrate's deliveries ride on, ONE round. The default drains three macrotask turns; the suite calls it repeatedly until no further step is issued, so an adapter whose steps each cost several turns needs no override. An adapter that delivers on a real timer does.

### §334. ONE CASE'S BOOKKEEPING

ONE CASE'S BOOKKEEPING. It exists for a reason found the hard way: the first draft let a FAILED case leave a run in flight with a step still held, and when the next case reset the recorder that abandoned run resumed and interleaved its steps into the next case's recording — turning one real failure into four bogus ones with unreadable diffs. `Case.cleanup` releases whatever is still held and awaits the run, so a failing case fails alone.

### §335. Runs the await-ordering cases against one adapter

Runs the await-ordering cases against one adapter.

`createSubstrate` is called ONCE PER CASE and must return a substrate carrying no state from the previous one.

### §336. Non-vacuity for every case below

Non-vacuity for every case below: it proves the substrate ISSUES the full sequence AT ALL, so that a missing later step in a held case can be read as "the hold ate it" rather than as "nothing here works". It is NOT what catches a substrate that delays the ISSUE rather than the SETTLE — measured, that defect reddens eight of the nine held cases directly (each one's own pre-release assertion that the held step already appears in `issued()`) and leaves this control passing, since nothing is held here for a delayed issue to be visible against.

### §337. WHAT THIS CATCHES, EXACTLY

WHAT THIS CATCHES, EXACTLY. Hoisting `containerId` out of the `run()` body to module scope typechecks clean and passes every other test in this package, because no other test has two `run()` calls in flight — one run's steps are always the only ones there are. Under that mutation the second run's later steps address the FIRST run's container and both teardowns `rm -f` the same id: one container is orphaned still holding whatever the run gave it, and the other is destroyed twice, the second time out from under a live run.

PER-RUN IDENTITY IS NOW TWO THINGS, NOT ONE, and both are covered by the same partition: the container id `create` returns, and the `--name` the CALLER chose (`RunnerSpec.runId`), which is what teardown addresses. A substrate reports them under one identity — see the Docker substrate's `stepIdentity` — so a teardown aimed at the OTHER run's name fails here exactly as a copy aimed at the other run's id does. That is why the substrate must hand out a distinct `runId` per run: two runs sharing one name is the same bug wearing new clothes, and with managed-iac deriving `runId` from `intent.idempotencyKey` it is reachable in production by two concurrent triggers of one key.

It is not a live bug today — `index.ts` holds no module-level mutable state — and that is the reason to pin it rather than to skip it: the three managed plugins are three pg-boss `work()` handlers in ONE Node process, so two `run()` calls across plugins overlap as a matter of course, and this suite's own framing (a substrate that holds a step OPEN) is an invitation to park per-run state where it is convenient.

### §338. Groups issued steps by identity, preserving order

Groups the issued steps by the identity they addressed, preserving issue order within each group. Throws rather than returning something weaker when a substrate reports no identity: an all- `undefined` substrate would collapse both runs into one group and the case would pass for the wrong reason, which is the exact failure mode it exists to catch.

## `packages/runner-launcher/src/outcome-cache-bound.test.ts`

### §339. MEDIUM (M23.0 verification pass 7, finding M1)

MEDIUM (M23.0 verification pass 7, finding M1) — BOUNDING ONE ENTRY DID NOT BOUND THE MAP.

The previous round capped each managed executor's `detail` and left the CACHES that hold them unpruned. Measured on managed-iac's durable ledger at 500 keys: `bytes=2074290`, `bytesPerKey=4149` — the per-entry bound working perfectly while the map grew without limit, because the map is a different quantity from the entry. Worse for that one specifically: `loadState` `JSON.parse`s the whole file on EVERY `status()` poll and `saveState` rewrites it whole on every `trigger()`, so an unbounded ledger is O(total history ever) of parsing on a loop that ticks once a second.

THIS FILE PINS THE MECHANISM. The three plugins' own suites pin that they are WIRED to it.

## `packages/runner-launcher/src/persistable-detail.test.ts`

### §340. The bound cut surrogate pairs and Postgres refused

HIGH REGRESSION — `boundDetail` CUT SURROGATE PAIRS, POSTGRES REFUSED THE ROW, AND THE WAVE NEVER TERMINALISED (M23.0 verification pass 7, fixed pass 8).

THE MECHANISM, END TO END. `boundDetail` slices at UTF-16 CODE-UNIT offsets. An astral character (any emoji, any CJK extension, any of the mathematical alphanumerics a Terraform provider is perfectly capable of printing) occupies TWO code units, so either cut — the head at `headShare` or the tail at `length - RUNNER_DETAIL_TAIL_CHARS` — can land between them and leave a LONE SURROGATE. The result is an ill-formed string. `jsonb` refuses it. The refusal is thrown by the `insertDecision` inside `reconcileExecutingChange`'s `withTenantTx`, which ALSO holds that tick's `updateWaveTargetObserved` — so the whole transaction rolls back:

```text
[reconcile] … poll failed (will retry next tick):
  DrizzleQueryError: Failed query: insert into "decisions" (…, "input_context", …) values …
    detail: 'Unicode low surrogate must follow a high surrogate.'
```

No Decision, no `observed_state`, no terminal wave — every tick, forever, behind a green health check and a single `console.error`. That is the shape of this repository's own worked example (BUILD_AND_TEST.md §4.4a), where 231 changes went unevaluated for 13 days.

WHAT THE DATABASE ACTUALLY REFUSES — measured against a real `postgres:16`, not modelled:

```text
lone high surrogate  -> jsonb FAIL "invalid input syntax for type json"     | text OK
lone low surrogate   -> jsonb FAIL "invalid input syntax for type json"     | text OK
U+0000               -> jsonb FAIL "unsupported Unicode escape sequence"    | text FAIL
U+FFFD, U+FFFF, C0, DEL, combining marks, astral pairs -> OK everywhere
```

NOTE THE SECOND ROW OF THAT TABLE, because it is the reason this file does not simply assert `isWellFormed()`. `String.prototype.isWellFormed()` returns TRUE for a string carrying `U+0000`, and `jsonb` refuses it anyway. `isWellFormed()` is a MODEL of what Postgres rejects and it is an incomplete one; the database is the authority. So every arm here asserts BOTH halves, and `reconcile-decision-detail-bound.integration.test.ts` drives the astral case through a real `insert` so the model is checked against the authority at least once.

AND IT IS A PROPERTY, NOT A STRING. A hand-picked input pins the offset it happens to produce; the defect is about WHERE THE CUT LANDS, so the arms below sweep the cut across every alignment by shifting a single-code-unit pad in front of an adversarial alphabet. One example would have been green against a `boundDetail` that repaired only the head cut, which was the first fix tried.

### §341. Adversarial alphabets, each a repeating unit

Adversarial alphabets. Each is a repeating unit; `unitLength` is deliberately NOT all 1, because an alphabet of single-code-unit characters can never expose the defect — that is exactly why the round's own 100 000-character `"x".repeat(...)` fixture was green.

### §342. Pads shift the payload so both cuts walk across

Pads shift the whole payload by 0..5 single code units, which walks BOTH cuts across every alignment relative to a two-unit character. Six is enough to cover a width-2 alphabet several times over and is not a multiple of any unit length above.

### §343. Lengths chosen to exercise the three regimes separately

Lengths chosen to exercise the three regimes separately: comfortably under the cap (no slice at all — the pass-through the short path used to be), straddling the cap by a few units, and far over it (both cuts active, middle elided). Expressed in COPIES of the unit, so each alphabet lands at its own set of code-unit lengths.

### §344. The control: if this reddens, the sweep tests nothing

The control. If this assertion ever goes red, the sweep above is no longer testing anything — it would mean a code-unit slice of these inputs is well-formed by accident, and every arm would be green for the wrong reason. This is the exact slice `boundDetail` performed before the fix, reproduced here rather than referenced, so the control survives refactors of the product.

### §345. A head-only repair was tried first, and this catches it

A HEAD-ONLY REPAIR WAS THE FIRST FIX TRIED, AND THE OBVIOUS FIXTURE CANNOT TELL. With a body of nothing but emoji, the TAIL cut is aligned no matter what: the cut sits at `len - RUNNER_DETAIL_TAIL_CHARS`, the reserve is EVEN, so the cut's parity always equals the body's start parity and never lands inside a pair. Shifting a leading pad moves the HEAD cut and leaves the tail cut aligned every time — a 2x2 with an empty column.

So the alignment of each cut is steered independently: `headPad` (leading single-unit characters) moves the head cut, and an ODD-length trailing run moves the tail cut, because the tail offset shifts by the trailing run's length mod 2. Each of the four cells asserts the two halves separately, split AT the elision marker so `head` ends exactly where the head cut landed and `tail` begins exactly where the tail cut landed.

### §346. AND THE 2x2 HAS NO EMPTY CELL

AND THE 2x2 HAS NO EMPTY CELL — asserted, not assumed. This recomputes, from the raw slice offsets alone, which cut each cell actually misaligns, and requires that across the four cells the head cut is misaligned at least once and the tail cut is misaligned at least once. Without this the block above is satisfiable by a fixture where neither cut ever splits a pair, which is precisely the state it was written in and shipped in.

## `packages/runner-launcher/src/persisted-json-bound.test.ts`

### §347. THE VALUE ALONE

THE VALUE ALONE. `boundPersistedJson` returns `{ value, truncation }` since M23.1g — deliberately inseparable, so no caller can obtain the bounded value without being handed the report — and every arm below this line is about the VALUE. The report has its own file, `persisted-json-truncation.test.ts`, because it is a different property: these arms measure what survives, those measure whether we say what did not.

### §348. MEDIUM (M23.0 verification pass 7, findings M2 and M3)

MEDIUM (M23.0 verification pass 7, findings M2 and M3) — BOUND THE STRUCTURE, NOT A LIST OF ITS FIELDS.

WHY THIS FUNCTION EXISTS RATHER THAN FOUR MORE `boundDetail` CALLS. The previous round bounded `ExecutionStatus.detail` and missed `stateRef` and `observed.images` — the same untrusted object, three lines away, on a write that runs EVERY tick rather than only on failure. Measured through an unmodified test seam: 500 093 bytes of plugin-chosen text, verbatim, in `change_wave_targets.observed_state`. `ExecutionStatus.observed` is documented as "optional and additive", so a per-field patch list is a list that goes stale on the next signal an executor contributes. The guarantee here is therefore about the WHOLE VALUE and is stated in the unit the column is measured in:

JSON.stringify(boundPersistedJson(v)).length <= PERSISTED_JSON_MAX_CHARS,  for every v

The sweep below is the evidence for "every v" that a hand-picked object cannot be. Note the last two arms in particular: a REALISTIC reading has to come back byte-identical, and the internal overflow fallback must never fire — either would make the guarantee true for a useless reason.

### §349. The table moved out, and it gained a second layer

THE TABLE MOVED TO `adversarial-corpus.ts`, AND IT GAINED A SECOND LAYER (M23.1f clause 4). This file asserts the PROXIES — well-formed, no NUL, under budget — which is all a pure unit test can ask. `apps/server`'s `persisted-json-postgres-corpus.integration.test.ts` reads the SAME table and asks a real PostgreSQL whether it accepts the row, with the PRE-BOUND shape as the control. One table, because two copies of a hostile-input corpus diverge in the direction that matters: a new shape is added by whoever was thinking about it, in the file they were looking at.

### §350. THE CYCLE GUARD

THE CYCLE GUARD. `adversarial-corpus.ts` cannot import `PERSISTED_JSON_ELIDED_KEY` from `./index.js` — `index.ts` re-exports the corpus, and the cycle resolves to `undefined` at module-evaluation time, which silently turns `ADVERSARIAL_ALL` into an empty array for every consumer that imports it through the package entry. So the corpus spells the marker as a literal, and this is what stops the literal drifting from the constant.

### §351. SMALL (M23.0 verification pass 9)

SMALL (M23.0 verification pass 9) — THE OVERFLOW FALLBACK WAS THE ONE VALUE THIS FUNCTION RETURNED WITHOUT MEASURING IT.

"The guarantee is CHECKED, not argued" is the function's own headline, and the escape hatch out of the check was itself unchecked: at `maxChars = 0` the diagnostic object rendered to 140 characters. Latent today — `boundPluginJson` always passes 8 000 — but an unmeasured branch inside a measured function is where the next one lives. Swept down to and past the stated precondition.

### §352. MEDIUM (M23.0 verification pass 8)

MEDIUM (M23.0 verification pass 8) — THE BUDGET USED TO BE SPENT IN INSERTION ORDER, SO THE FIELD A GATE READS WAS DECIDED BY SOURCE-LINE ORDER IN AN UNRELATED FUNCTION.

`observedStateFrom` composes `{revision, images, rollout}` in that order. The walk charged each field as it went and, once the remainder fell under the per-leaf minimum, replaced EVERY still-unwalked field with `__scpElided` — so `rollout`, always last, was always the first thing dropped. Measured end to end against real Postgres through the ordinary fake-executor seam, with 80 image refs of the shape an Argo CD Application actually reports:

```text
before  images, rollout, revision, observedAt   weight 60     min_weight         satisfied TRUE
after   images, revision, observedAt, __scpElided  undefined  weight_unreadable  satisfied FALSE
```

`rollout.weight` is the leaf ADR-0028's `minWeight` gate reads (`stage-dependency-hold.ts`), and losing it degrades the dependency to the universal `succeeded` test — fail-CLOSED, so nothing wrong ships, but a correct configuration holds indefinitely and the recorded cause (`no_weight`) blames the executor for what the bound did.

THE ARMS BELOW ARE ORDER-INDEPENDENT ON PURPOSE. A test that only pinned `{revision, images, rollout}` would be satisfied by the alternative fix — reordering the composition — which makes source-line order a load-bearing contract that the next person reorders innocently. The property is about the WALK: no key is lost because a SIBLING was large, whatever order they arrive in.

### §353. HIGH (M23.0 verification pass 9)

HIGH (M23.0 verification pass 9) — WHICH KEYS SURVIVE IS NOT THE WHOLE PROPERTY. HOW MUCH OF EACH SURVIVES IS PART OF IT.

The allocator's doc (on `PERSISTED_JSON_SHARE_ROUNDS`) rejects the reorder alternative (order `rollout` before `images` in `observedStateFrom`) because it "makes source-line order in an unrelated function a load-bearing contract". Pass 8's own design had that disease on a different observable: every arm above was green while the same three fields kept

```text
revision, images, rollout (SHIPPED)  ->  39 refs, row 4 065
revision, rollout, images            ->  77 refs, row 7 864
images, revision, rollout            ->  26 refs, row 2 765
```

— a 3x spread decided by nothing but insertion order. A rejection argument the chosen design also fails is not a rejection argument, so the property is pinned here rather than asserted in a comment: retention is IDENTICAL, not merely "nonzero", across all six permutations.

### §354. HIGH (M23.0 verification pass 9)

HIGH (M23.0 verification pass 9) — THE SHARE IS A FLOOR, NOT A CEILING; UNSPENT BUDGET COMES BACK.

Pass 8 handed each field `floor(left / unwalkedSiblings)` as a CAP and never returned the remainder to a field already walked. `images` sits in the MIDDLE of `{revision, images, rollout}`, so it was capped at ~1/2 the budget while `revision` + `rollout` spent ~110 of the ~3 950 they were handed. Utilisation fell from 99.4 % to 50.6 %, and end to end that turned `resolveReleasedVersion` from `determined` into `observed_images_elided` for every list of 35…69 refs — a window that had never been broken.

DELETE-THE-WIRING for pass 2: remove the redistribution loop in `walkObjectFields` and this arm fails at n = 40 (34 of 40 kept) and on utilisation (~50 %).

### §355. The whole external run reference is bounded

`markWaveTargetTriggered` bounds `trigger()`'s whole `ExternalRunRef`, and reconcile polls with it verbatim — `client.status(target.executorRef)`. Every executor plugin reads `ref.externalId` out of it. A chatty plugin that puts a big field FIRST used to take that leaf with it, and a target whose ref can no longer be interpreted is polled as an unknown run forever, on every tick, with nothing in the row to say why.

### §356. The arm that should have caught it and did not

THE ARM THAT SHOULD HAVE CAUGHT PASS 8's DEFECT AND DID NOT, now expressed in the field order production actually produces — AT EVERY ORDER, so it cannot go blind that way again.

It used to build `{revision, rollout, images}` with `images` LAST. That is the ONE permutation where the old per-field share short-circuited (`if (unwalkedSiblings <= 1) return walk(...)` — the last field was handed the whole remainder) and no share was ever applied, so the arm measured the one layout that could not fail. Against its own 0.8 threshold, on pass 8's code:

```text
alone (images only)                        : 79
this arm's old order {revision,rollout,images}: 78   ratio 0.987  PASSED
PRODUCTION order {revision,images,rollout}    : 39   ratio 0.494  FAILS
```

### §357. MEDIUM (M23.0 verification pass 10)

MEDIUM (M23.0 verification pass 10) — THE PER-STRING BOUND HALVED ON A TWO-CHARACTER OVERSHOOT, AND EVERY ARM THAT COULD HAVE SEEN IT WAS SHAPED LIKE AN ARRAY.

`boundText` bounds a CHARACTER count; the budget is measured in RENDERED characters, and the difference for an unescaped string is exactly the two quotes `JSON.stringify` adds. The old loop recovered those two characters by HALVING the width, so every plain-ASCII string — every image ref, digest, revision, URL and branch name a real executor reports — stored half of what it was given:

```text
share    stored   rendered   utilisation
  400      200       202       50.5 %
 2634     1317      1319       50.1 %   <- one field's share of the 8 000 budget
 3900     1950      1952       50.1 %
```

WHY NO EXISTING ARM SAW IT, AND WHY THAT IS STRUCTURAL. Every fixture in this file whose field is large enough to be cut is an ARRAY (`images`), and an array is cut by dropping ENTRIES — the halving never runs on the array itself, only on entries that individually fit. The integration harness could not reach it either: the fake executor's only free-form `observed` field was `imagesByTarget`, an array. So the one shape the defect lives in was unreachable end to end BY CONSTRUCTION, in the unit tests and in the integration tests alike. The arms below are the string-shaped half of every property this file already states about arrays.

MUTATION LOG — applied, watched fail, reverted, watched pass.

| Mutation | Result |
| The pass-9 HALVING restored in `boundStringToCost` (`width = Math.floor(width / 2)`) | 5 of the 6 arms below fail: `budget - 96` at its first budget (`{budget: 400, row: 160}`), every escape density at 0.40, string-shaped utilisation at 0.497, key seating, and the elision residue at 0.43 | | The pass-9 IN-LOOP KEY CHARGING restored in `walkObjectFields` (each field walked against `floor(budget.left / unwalkedSiblings)` as the loop decrements `budget.left`, the last field handed the remainder) | 3 arms fail: order-independence with 3 distinct payloads, key seating (200 keys all seated at a one-character sliver), and the elision residue (`expected 792 to be 0` — 792 fields whose stored value is the empty string) |

The two mutations redden DIFFERENT arms, with the seating arms overlapping: order-independence is blind to the halving and the utilisation arms are blind to the allocation. Two defects, two levers.

### §358. The bound reserves a minimum for each leaf

`boundPersistedJson` reserves PERSISTED_JSON_MIN_LEAF = 96 characters of the budget up front, and that reserve is the whole of the `O(small)`. Written as the literal 96 rather than imported, for the reason the magnitude arms in this repository exist: an assertion against the constant that defines the bound cannot notice the constant moving.

### §359. The string-shaped half of budget utilisation

THE STRING-SHAPED HALF OF "BUDGET UTILISATION", which the array fixture cannot express.

`{revision, images, rollout}` with a big `images` is the only overflowing composition this file had, and an array overflows by dropping whole entries — a path the per-string bound never touches. Two truncated STRINGS beside two small fields is the same property in the shape the defect lives in. Measured: 7 904 of 8 000 (98.8 %); under the halving, 3 976 (49.7 %).

WHY THE STRINGS ARE 50 000 CHARACTERS AND NOT 4 000, which took a mutation run to discover. At 4 000 the halving DOES NOT FIRE at this budget, and the arm would have been green under the defect. The elision marker is sized against the widest count it could ever carry (`text.length`), so when the ACTUAL dropped count has fewer digits the result comes back a character or two under the requested width — and at a share of 3 931, dropping 97 of 4 000 leaves exactly the two characters the quotes need. At 50 000 the dropped count has the same five digits as the length, there is no slack, and the first attempt misses by two. A utilisation arm that cannot see the defect is the "green for the wrong reason" mode this repository keeps shipping, so the fixture is chosen against the MEASURED mutation, not by eye.

### §360. HIGH (M23.0 verification pass 10)

HIGH (M23.0 verification pass 10) — PROPERTY (2), ON STRING CONTENTS, WHERE PASSES 8 AND 9 BOTH STILL FAILED IT.

The allocator's doc rejects "reorder the composition" as an alternative BECAUSE it makes source-line order a load-bearing contract. Pass 8 failed that test on array contents and pass 9 fixed it there; pass 9 then failed it on STRING contents, because it computed each field's share from the budget REMAINING mid-loop and handed the LAST field the entire remainder. All 24 permutations of the fixture above, on pass 9 plus this round's width search:

```text
a 3 858 / b 4 000    4 orders     row 7 904
a 3 929 / b 3 929   16 orders     row 7 904   <- the fair answer
a 4 000 / b 3 858    4 orders     row 7 904
```

THE ROW IS THE SAME SIZE IN ALL THREE. No length assertion, and no utilisation assertion, can see this — which is why it is asserted on the PAYLOAD, byte for byte.

AND WHY THIS FIXTURE IS 4 000 CHARACTERS WHERE THE UTILISATION ARM ABOVE IS 50 000. The spread exists because one of the two strings can be SATISFIED — handed the whole remainder as the last field, it fits entirely and keeps its spend out of the redistribution pool. A string long enough never to be satisfied (50 000) makes every order agree even on pass 9, so the arm would have been green under the defect. Each fixture is sized against the mutation it has to see.

DELETE-THE-WIRING: move the key charging back inside the value loop in `walkObjectFields` (so phase 2's pool is read from a `budget.left` the walk is still decrementing) and this arm fails with 3 distinct payloads.

### §361. The property as stated, then as measured

PROPERTY (1), AS PASS 10 STATED IT AND AS PASS 12 MEASURED IT.

Pass 10 charged the keys before any value is walked, so the seating decision read KEY COSTS ONLY, and it pinned exactly that here: "a value's size changed which keys were seated" was the failure message. The property was true. What it did not ask is what a KEY COSTS TO SEAT — a flat `PERSISTED_JSON_MIN_LEAF`, whatever was behind it — and that is what the first arm measures now: 200 keys whose every value is `"v"` hold 4 091 characters and were seated 71 at a budget of 8 000, the other 129 replaced by a marker. The seat is now priced at what the field needs, so all 200 seat and the value comes back byte-identical.

WHAT THAT COSTS IN STRICTNESS, STATED RATHER THAN GLOSSED. The rule now reads values, so pass 10's absolute form is gone: a sibling large enough to need the whole floor CAN be the reason a later key is elided. It can only ever go one way — `admissionCost <= PERSISTED_JSON_MIN_LEAF` by construction — so the seated set is a SUPERSET of the flat rule's, which is the third arm.

### §362. 69 fields plus the marker

69 fields plus the marker. It was 70 + the marker until pass 14 made the object BUY its elision entry before phase 1 seats anything (see `fieldsElisionCost`): those 30 characters used to be spent out of the row's backstop cushion, and one seat is exactly what they buy. The measurement that says the trade is worth making is in that comment — 15 982 whole-value discards over a 145 048-pair budget sweep, gone above a budget of 31.

### §363. THE PRICE OF THE FLOOR, PINNED AS A FLOOR OF ITS OWN

THE PRICE OF THE FLOOR, PINNED AS A FLOOR OF ITS OWN.

Phase 1 seats a key only while PERSISTED_JSON_MIN_LEAF of budget remains for it AND for every key already seated. A field that then wants less than 96 characters leaves the difference unspent, so in the ELISION regime — and only there — utilisation drops. Pass 9's sliver rule scored higher on this number and lower on every other: 5 000 fields of `"v".repeat(50)` seated 792 fields, EVERY ONE OF THEM THE EMPTY STRING, for a row of 7 844. An empty value in a governed row reads as an observation, not as a cut (charter principle 6).

Property (3) in the allocator's doc is narrowed to say so. This arm is what stops the residue growing quietly afterwards.

### §364. A CUT LIST AND A COMPLETE ONE MUST BE TELLABLE APART

A CUT LIST AND A COMPLETE ONE MUST BE TELLABLE APART. `internal-release-version.ts` scans `observed_state.images` for the ref whose repository is a dependency line's coordinate; after a cut, a miss is not evidence of absence, and reporting it as `no_matching_image_ref` blames the executor for what this file did (charter principle 6).

### §365. MEDIUM (M23.0 verification pass 11)

MEDIUM (M23.0 verification pass 11) — WHAT THE WALK CHARGES MUST BE WHAT IT RENDERS, AND IN TWO PLACES IT WAS NOT. BOTH ENDED IN THE SAME LOSS: THE WHOLE ROW.
`boundPersistedJson` measures its own output and, when the walk's accounting turns out to be wrong, replaces the payload with a diagnostic sentence. Every round so far has read that as a safety net and asserted only that the ROW stays inside the budget. It does. What it costs when it fires had never been asked: `revision`, `images` and `rollout.weight` all disappear TOGETHER, silently, on a write that runs every tick — strictly worse than the truncation `isPersistedJsonEntriesElision` exists to make legible, and the exact fail-silent shape this whole file was written to prevent.

Measured over 12 000 random mixed shapes at budgets 100…8 000, the backstop fired for pass 7 on 697, for pass 9 on 30 and for pass 10 on 238 — the redistribution rounds pass 10 added made the total-loss case EIGHT TIMES more likely than the round before it, which no assertion in this file could see because each one only ever asked whether the row fitted.

THE TWO CAUSES, BOTH "a leaf/marker rendered characters nobody charged for":

```text
1. `null`, `undefined` and a function/symbol all render as the four characters `null`. The
   non-finite-number branch charged for that; the other two charged NOTHING. A `null` in a list
   therefore cost 1 (its comma) and rendered 5, and since an array element is admitted while
   the budget is merely non-trivial, free elements DEFEAT the array guard outright: 1 599 of
   them overflow the 8 000 budget with nothing else in the value.
```

```text
2. An array's tail marker was charged after the elements had already spent everything. The
   element admitted at exactly `PERSISTED_JSON_MIN_LEAF` may take all of it — a string is
   bounded to whatever is left, by construction — so EVERY CUT ARRAY overspent by exactly the
   marker, and four of them anywhere in one value put the row past the single reserve
   `boundPersistedJson` holds back. `PERSISTED_JSON_MIN_LEAF`'s own comment claims the opposite
   in as many words ("so the elision itself can never be what pushes the row over") — a
   well-written comment naming a hazard is a signal to sweep, not evidence it was handled.
```

WHY THE CORPUS ABOVE COULD NOT SEE EITHER. Every array in it holds strings or integers, both charged exactly, and every value in it is cut at most once. A fixture cannot witness a defect in a branch it never reaches — the same mechanical blindness that hid the string-shaped defects for three rounds, one shape further along.

### §366. The sweep the hand-picked corpus above cannot do

THE SWEEP THAT WOULD HAVE CAUGHT BOTH, AND WHICH THE HAND-PICKED CORPUS ABOVE CANNOT BE. Deterministic (a fixed seed, no `Math.random`), so a failure is reproducible and a green is not luck. It asserts the two facts every hand-picked arm asserts — the row fits, and the backstop did not fire — over shapes nobody chose.

SIZED DELIBERATELY, AND SMALLER THAN THE FIRST DRAFT. 2 000 shapes with 6 000-character strings ran for 5.5 SECONDS, which is not free in a suite whose slowest FILE (`whole-run-budget.ts`, 9.9s) measures real subprocess deadlines in a sibling worker — a CPU-bound arm is a wall-clock hazard to a timing arm running beside it, which is a bad trade for a property test. 800 shapes with 2 500-character strings runs in ~0.7s and still reddens on both pass-11 defects: removing the tail reserve fails it at `case 9 at budget 6000`, removing the `null` charge fails four other arms in this file. Raise the count when hunting, not in the committed suite; 30 000-case sweeps over five seeds were run out of tree for this round and found nothing this one does not.

### §367. HIGH (M23.0 verification pass 12)

HIGH (M23.0 verification pass 12) — WHAT A REFUSAL HOLDS BACK MUST BE WHAT THE CONTENT COSTS.

Two places decided whether to keep the next thing, and both reserved a flat `PERSISTED_JSON_MIN_LEAF` (96) for it without asking what it was worth: `walkObjectFields` phase 1 seating a key, and the array loop admitting an element. A third — pass 11's tail reserve — took the marker's price out of every list, including the ones that demonstrably never need a marker.

NONE OF IT IS VISIBLE IN THE ROW'S LENGTH, which is why eleven passes did not find it: the row comes out THOUSANDS OF CHARACTERS SHORT of the budget while content is being thrown away, and in the worst cases LARGER than the value it damaged, because `__scpElided: "1 more fields"` is 30 characters and `"version":"v1.4.2"` is 18. Measured before the fix, at the production budget:

```text
{resources: {30 x {status, health, version}}}   input 2 495 -> stored 2 825, LOSSY
the same at 80 resources                        input 6 645 -> stored 3 684, LOSSY (54 % of
                                                the column abandoned)
{svc-i: {c-k: {ready, restarts, image}}} 8 x 4  input 1 553 -> stored 2 097, LOSSY
{a: ["a"]}                                      eleven characters, cut at every budget to 133
```

The unit each arm asserts in is therefore RETENTION, never length.

### §368. The law's domain, found missing and then measured

THE LAW'S DOMAIN, WHICH PASS 13 FOUND MISSING AND PASS 14 MEASURED.

"L + 96 IS THE WHOLE LAW" was pinned over atoms whose largest string is 300 characters, so it sampled only where the claim happens to hold. It is FALSE for a string past `RUNNER_DETAIL_MAX_CHARS`, and false for four other reasons the atoms never reached. The law is not wrong — it has a DOMAIN, and an unstated domain is a law that goes false silently the first time somebody writes a fixture outside it. Measured, `{a: <atom>}`, searching every budget to 60 000 for the first at which the value comes back byte-identical:

```text
  atom                              L      verbatim at
  string of 4 000                4 008    L + 96
  string of 4 001                4 009    NEVER          <- boundStringToCost caps at 4 000
  key of 126 characters            140    L + 96
  key of 127 characters            141    NEVER          <- the 128 is a RENDERED cost, and
                                                            two quotes leave room for 126
  seven levels of nesting           54    L + 96
  eight levels of nesting           60    NEVER          <- PERSISTED_JSON_MAX_DEPTH
  "a\u{1F600}b"                      12    L + 96
  a string carrying U+0000          16    NEVER          <- sanitised to U+FFFD
  a lone surrogate                  16    NEVER          <- sanitised to U+FFFD
  a function-valued field            2    NEVER          <- stored as null, omitted by
                                                            JSON.stringify
  a `__proto__` key                 27    NEVER          <- refused, see isUnsafePersistedKey
```

AND THE DOMAIN IS ABOUT THE ATOMS, NOT THE TOTAL, which is the half pass 13's wording missed. Two 4 000-character strings side by side are 8 021 characters and obey the law exactly; 400 image refs are 35 897 characters and obey it exactly. "False past 4 008 characters" is not the boundary — "false past a 4 000-character STRING" is.

### §369. What the water-filling cap is worth, and why

WHAT THE WATER-FILLING CAP IS WORTH, AND WHY IT IS FIVE — M23.0 verification pass 14.

`PERSISTED_JSON_SHARE_ROUNDS` was 4, and pass 13 recorded that 3 and 8 both SURVIVED the whole suite: a constant nothing could distinguish in either direction. Neither survives measurement. Instrumenting the loop over 182 365 (shape, budget) pairs found 5 290 that run four rounds and 527 that run FIVE, so 4 was truncating real work; and against a 64-round ceiling the retention cost of each cap is 1: -29.04 %, 2: -0.60 %, 3: -0.047 %, 4: -0.0028 %, 5 and above: zero.

FIVE IS THE FIXED POINT — the smallest cap at which raising it changes no output anywhere. The shape below is the witness the round-demand instrument found, and it separates every cap from 1 to 5, which is what makes an exact byte count here a gate rather than a golden:

```text
  ladder n=10 base=4 delta=40, L = 1 921, at a budget of 1 978
      1 round  1 401     3 rounds  1 855     5 rounds  1 882
      2 rounds 1 777     4 rounds  1 881     8 and 64  1 882
```

WHY THE LADDER. Rounds are demanded only when exactly ONE field becomes satisfied per round — fields whose sizes are close enough together that a share satisfies one at a time. Geometric sizes (the family the constant's own comment names) satisfy several at once and never reach round four; this is the shape eleven passes' corpora did not contain.

### §370. THE TWO MARKER CHARGES, PRICED TO THE CHARACTER

THE TWO MARKER CHARGES, PRICED TO THE CHARACTER — M23.0 verification pass 14, and the two mutations pass 13 recorded as surviving all 227 tests.

`tailMarkerCost` reserves `jsonCost(marker) + 1`; `fieldsElisionCost` reserves `jsonCost(marker) + jsonCost(__scpElided) + 2`. The trailing terms are PUNCTUATION — the comma that separates an array's marker from the entries before it, and the `:` and comma that attach an object's elision entry — and punctuation is the kind of term a reader deletes as noise. A reserve short by N is not "N characters of retention"; it is a container that spends N more than it was allocated, and those overspends COMPOUND across siblings until the row's own 96-character cushion is gone and the backstop discards the whole reading.

NEITHER IS PINNED BY A BYTE COUNT HERE, because a byte count says nothing about WHY. A reserve short by N shifts the budget at which the next thing becomes affordable by EXACTLY N, and that is both a sharper statement and a two-sided one. Measured over every budget 4…400:

```text
  list(3) of list(3), first sub-list survives at   base 138    with `+ 1` deleted  137
  3 fields x list(2), first field seated at        base 142    with `+ 2` deleted  140
```

### §371. AND THE CONSEQUENCE, WHICH IS NOT TWO CHARACTERS

AND THE CONSEQUENCE, WHICH IS NOT TWO CHARACTERS. An object's overspend happens once per ELIDING OBJECT, and at depth 6 width 3 there are 1 093 of them, so two characters each is 2 186 — past the row's 96-character cushion many times over. Measured with the `+ 2` deleted: this 9 103-character value is DISCARDED WHOLE at 2 062 budgets, the lowest 3 907; the current build discards it at none. This band is the cheap part of that measurement (300 budgets, ~0.4 s) rather than the whole of it.

### §372. ONE LAW FOR EVERY SHAPE

ONE LAW FOR EVERY SHAPE. `boundPersistedJson` reserves PERSISTED_JSON_MIN_LEAF from the row as its overspend backstop and the walk gets the rest, so a field that costs L wants exactly L + 96 — and that was true of scalars and objects while ARRAYS wanted `L + 96 + the tail marker's price`, a marker the complete list never stores. Measured before the fix:

```text
  {a: ["a"]}          L 11    verbatim from 134, not 107
  {a: [40 entries]}   L 237   verbatim from 361, not 333
```

Stated as a two-sided law so it cannot be satisfied by simply reserving more: verbatim at L + 96, and NOT verbatim at L + 95.

### §373. HIGH (M23.0 verification pass 13)

HIGH (M23.0 verification pass 13) — A SEAT PHASE 1 PAID FOR IS A SHARE PHASE 2 MUST HONOUR.

A REGRESSION IN PASS 12'S OWN FIX, not a pre-existing defect. Pass 12 replaced a flat `PERSISTED_JSON_MIN_LEAF` seat price with the value's exact cost and argued the change was safe because it "can only admit content the old rule refused" — a statement about the seated SET. The flat 96 was also the guarantee that a seated field would be HANDED 96 characters, which is what that constant's own comment says it is for ("enough for a short marker and its punctuation"). Phase 2 kept dividing the pool equally, so a field could be offered less than the value it was seated for costs, and the value then emitted a marker nobody had costed: `[elided: N more entries]` is 26 rendered characters where the list it replaced was 5.

Measured on the shipped build, over 197 934 (shape, budget) pairs:

```text
pass 11        0 / 197 934 whole values discarded by the backstop
pass 12 pre    0 / 197 934
pass 12 as shipped   34 900 / 197 934, at budgets up to 13 981 — INCLUDING the production
                     8 000 with no explicit budget argument
```

THE UNIT HERE IS THE BACKSTOP, not the row length. Every arm below is green on a function that stores nothing at all; the last one is the counter-arm for that.

WHY IT IS A DENSE BUDGET SWEEP AND NOT A RANDOM CORPUS. The trigger is an arithmetic coincidence — phase 1 must refuse exactly enough fields for the `__scpElided` charge to push the pool under what the survivors were seated for. 6 000 random shapes (widths to 25 x 60, depth 10, arrays to 120, bigints, functions, over-long and colliding keys) found ZERO instances against the broken build; this sweep finds 49 518 of 335 496. Random shape generation is the wrong instrument, and that is the reason eleven passes of it went past this.

### §374. WHAT MOVED AND WHY IT IS THE RIGHT DIRECTION

WHAT MOVED AND WHY IT IS THE RIGHT DIRECTION. Pass 13 asserted four of the five lists survive at 143. One does now, and the four were being paid for out of the row's backstop cushion: the walk is handed `143 - PERSISTED_JSON_MIN_LEAF` = 47 characters, and four lists plus their keys plus a 30-character elision entry is 75. Pass 14 made the object BUY that entry before phase 1 seats anything (`fieldsElisionCost`), so the walk now spends what it was given. Measured over every budget in 100…175, both builds:

```text
  budget   108   119   130   141   149   152
  pass 13    1     2     3     4     4     5   <- borrowing from the cushion
  pass 14    0     0     0     1     2     5
```

The borrowing is what produced 15 982 whole-value discards over the pass-14 sweep, five of which are CLIFFS: one more character of budget took `depth 5 width 3` from 2 539 stored characters to 145 of apology. Nine cliffs remain in the fixed build and NOT ONE of them lands on the backstop.

## `packages/runner-launcher/src/persisted-json-budget-sweep.test.ts`

### §375. THE DENSE BUDGET SWEEP

THE DENSE BUDGET SWEEP — M23.0 verification pass 14, and the instrument eleven passes did not have.
BUILD_AND_TEST.md's M23.1f entry records the finding that produced this file: **random shape generation is the wrong instrument for this class**. 6 000 random shapes — widths to 25 x 60, depth 10, arrays to 120, bigints, functions, over-long and colliding keys — found ZERO instances of pass 12's defect against the build that had it, while a structured budget sweep found 49 518. The axis eleven passes never varied is the BUDGET. Every defect this file's family has produced is an arithmetic coincidence between one structure and one budget, and a corpus that samples budgets at three hand-picked values cannot see any of them.

So the permanent gate is a SWEEP: a small, named, structured family of shapes, run at EVERY INTEGER BUDGET from 4 upward. `persisted-json-bound.test.ts` and `persisted-json-truncation.test.ts` each carry their own narrower sweep for their own property; this file is the one that asks the three questions that are about the WHOLE bound at once, over the whole family, at every width and at depths 0 to 5.

```text
(1) NO ROW EVER EXCEEDS ITS BUDGET. The row bound is the guarantee the column depends on.
(2) THE BACKSTOP NEVER FIRES above the width of the walk's own shortest honest output. The
    backstop discards the WHOLE value — `revision`, `images` and `rollout.weight` gone
    together, replaced by a diagnostic sentence, silently, on every tick — so a firing is not
    a safety net doing its job, it is the worst loss this file can produce.
(3) A VALUE THAT CAME BACK CHANGED CAME BACK WITH A REPORT (M23.1g), swept here over shapes
    `persisted-json-truncation.test.ts`'s own sweep does not carry.
```

WHAT IT CAUGHT, WHICH IS WHY IT EXISTS (pass 14). `walkObjectFields` phase 1 subtracted its `__scpElided` entry's price from a budget it had already spent, with no check that it could be afforded — the identical defect pass 11 found and fixed in the ARRAY's tail marker, one branch away, left standing in the object. An object's overspend multiplies by the tree's width and depth where an array's merely adds, so:

```text
  five levels of three fields, 4 483 characters of ordinary content
      budget 1200   walk given 1104   rendered 1189   budget.left  -85
      budget 3000   walk given 2904   rendered 2917   budget.left  -13
  four levels of three fields, 1 486 characters
      budget 1200   walk given 1104   rendered 1297   -> 193 OVER -> WHOLE VALUE DISCARDED
```

and the four-level shape was discarded at every budget from 4 to 1 296, the five-level one at every budget up to 3 915. Over this sweep's 145 048 (shape, budget) pairs: **15 982 backstop firings before, 0 above a budget of 31 after**. The retention that bought is measured beside it in `persisted-json-bound.test.ts` -> "AND THE COUNT THAT SURVIVES IS THE LAW'S, NOT THE CUSHION'S".

AND THE SHAPE OF THE EVIDENCE MATTERS AS MUCH AS THE COUNT. Before the fix, five of the thirteen places where one more character of BUDGET stored more than 100 characters LESS landed on 145 — the length of the apology. `depth 5 width 3` went from 2 539 stored characters to 145 between budget 3 201 and 3 202. Nine such cliffs remain and NOT ONE of them lands on the backstop; they are the flat-96 seating cliff pass 12 named, which is a different property and a smaller loss.

### §376. What the serializer would write for that input

WHAT `JSON.stringify` WOULD WRITE FOR THE INPUT IF A FUNCTION FIELD RENDERED AS `null` THE WAY THE WALK STORES IT. Without this, "the walk changed the value" fires on a difference that is about `JSON.stringify` OMITTING a field rather than about anything being removed — and a gate that fires on a non-loss is a gate whose reds stop being read.

### §377. THE BACKSTOP, AND NOT A TOTAL ELISION

THE BACKSTOP, AND NOT A TOTAL ELISION — they are the SAME SHAPE and only one of them is a defect. `{__scpElided: "3 more fields"}` is the walk saying, truthfully and within its budget, "every field was cut". The backstop is the walk's whole output being MEASURED over budget and thrown away. An earlier draft of this sweep conflated them and reported 17 284 firings for a build whose real number was 3 483 — the wrong number in the safe direction, which is still the wrong number.

### §378. THE FLOOR BELOW WHICH A BACKSTOP FIRING IS NOT A DEFECT

THE FLOOR BELOW WHICH A BACKSTOP FIRING IS NOT A DEFECT. The walk's shortest honest output for a value it had to elide entirely is `{"__scpElided":"<n> more fields"}` — 32 characters for a one-digit count — and there is nothing shorter to store; the widest this family reaches is 47. MEASURED rather than chosen: over this sweep the highest budget at which the backstop fires at all is **31**, so 100 is comfortably clear of it and still two orders of magnitude below the 8 000 the column actually uses. Before pass 14's fix the same number was **3 915**.

## `packages/runner-launcher/src/persisted-json-proto.test.ts`

### §379. Prototype pollution from an untrusted response

PROTOTYPE POLLUTION FROM AN UNTRUSTED EXECUTOR'S RESPONSE — HIGH, M23.0 verification pass 14.
`JSON.parse` gives `__proto__` as an ORDINARY OWN PROPERTY, and a plugin's JSON-RPC response is parsed exactly that way. `walkObjectFields` wrote every field with `out[field.key] = value`, which for that one key is not a store at all — it is a call to `Object.prototype`'s `__proto__` SETTER. Measured on the build before the fix:

```text
  input   {"revision":"abc","__proto__":{"polluted":true},"images":["i1"]}
  stored  {"revision":"abc","images":["i1"]}
  stored.polluted                      true
  getPrototypeOf(stored) === Object.prototype   false
  truncation                           undefined
```

Three defects in one line: the stored object carries a PLUGIN-CHOSEN PROTOTYPE, the field is charged to the budget and then silently DROPPED (two 3 000-character fields at a budget of 4 000, one of them named `__proto__`: the other stored 1 950 characters where it now stores 3 011), and the value came back changed with NO REPORT — the exact property M23.1g's gate holds, missed because that gate's sweep had no such key in its shapes.

THE FIX IS A REFUSAL, NOT A DEFINITION, and the reason is that this row is served over the public API. `Object.defineProperty` would store the field honestly and leave the prototype alone — but it would then ship `"__proto__": {...}` in a JSON response to the generated SDK, the CLI and `apps/web`, handing every one of them a gadget that fires on `Object.assign({}, observed)` (measured: it pollutes; a spread does not). A key that is never legitimate observed-executor state is not worth carrying at that price. The loss is REPORTED rather than silent, which is the whole difference between the fix and the defect.

### §380. `isUnsafePersistedKey` refuses exactly one key

`isUnsafePersistedKey` refuses exactly one key. That is only correct if `__proto__` is the only string key for which `obj[k] = v` differs from defining an own data property — i.e. the only own property of `Object.prototype` that is an ACCESSOR, with no non-writable data property beside it. This is a claim about the RUNTIME, and a future runtime can falsify it, so it is enumerated here instead of asserted in a comment.

### §381. The other side of the measurement above

The other side of the measurement above. `constructor`, `toString`, `hasOwnProperty` and the rest of `Object.prototype` are WRITABLE DATA properties, so `out[k] = v` creates an own property exactly as it does for `revision`. Refusing them would silently drop legitimate observed state — an executor reporting a `constructor` field is odd, not dangerous — and a guard that is broader than the hazard is a guard nobody can reason about. Without this arm a predicate that refuses half of `Object.prototype` is green.

### §382. The walk paid for the key and stored nothing for it

The walk paid for `__proto__` out of the budget and stored nothing for it, so the money came off the siblings' share. Two 3 000-character fields at a budget of 4 000:

```text
  before   the surviving field stored 1 950 characters
  after                              3 011
```

## `packages/runner-launcher/src/persisted-json-truncation.test.ts`

### §383. M23.1g — THE BOUND CUT SOMETHING AND SAID SO

M23.1g — THE BOUND CUT SOMETHING AND SAID SO. THE PROPERTY IS "AND SAID SO".
`persisted-json-bound.test.ts` measures WHAT SURVIVES: 63 arms, every one of them about the value. Not one of them could see the defect M23.1g exists for, because that defect is not in the value — it is in everything the value does NOT say. A row that lost `rollout` and a row whose executor never reported one are byte-identical, and a suite that only reads the row cannot tell them apart any better than the UI could.

So this file asserts the pair. Every arm reads `truncation`, and the two arms that matter most are the ones that assert it is ABSENT — a signal that fires on readings that lost nothing is a signal an operator learns to ignore.

THE GATE: A BOUND MAY NOT BE APPLIED WITHOUT EMITTING THE SIGNAL
"THE BOUND CUT SOMETHING AND SAID NOTHING" IS THE DEFECT, and it is stated here as a sweep rather than as a fixture, for the reason M23.1f's own definition of done gives: "Random shape generation is the wrong instrument for this class. 6 000 random shapes found ZERO instances against a build a structured budget sweep caught 49 518 times. The axis eleven passes never varied was the BUDGET." So the gate below varies the budget densely over a structured family and asserts, at every point, that `renderedValue !== renderedInput` implies `truncation !== undefined`. Delete any one of the four accounting sites in the walk and it goes red naming the shape.

WHAT IT DELIBERATELY DOES NOT ASSERT: the converse. `truncation` defined implies something was cut is a weaker and less useful law, and sanitising (U+0000 -> U+FFFD) is a legitimate case where the value changes and nothing was removed — see "SANITISING IS NOT TRUNCATION" below.

MUTATION LOG — applied one at a time against a clean tree, watched fail, reverted
| Mutation | Result |
| `budget.loss.entries += value.length - i` deleted (array tail) | RED, 5 of 12 | | `budget.loss.fields += entries.length - i` deleted (phase-1 elision) | RED, 1 of 12 | | `budget.loss.characters += bounded.dropped` deleted (string leaf) | RED, 3 of 12 | | the depth-limit accounting deleted | RED, 1 of 12 — only the depth arm. THE SWEEP STAYS GREEN, and that is recorded rather than hidden: its family is shallow by construction, so a sweep is the wrong instrument for a depth defect and the separate arm is not redundant with it | | `refusedKeys` never collected (the `if (collector)` block in phase 1) | RED, 1 of 12 — and it is the arm that matters: `dropped: true` is the ONLY thing separating a cut field from one the executor never reported. The sweep stays green because the other counters still fire, which is exactly why "something was cut" and "WHICH field" are two different assertions | | `field.loss = { characters: field.keyDropped, … }` deleted, so `addLoss` ACCUMULATES across rounds | RED, 1 of 12 — a re-walked field reports its cut two and three times over | | `truncation: wholesaleTruncation(value)` -> `truncation: undefined` (the backstop reports nothing) | RED, 1 of 12 | | `boundTruncationReport`'s reserve -> 0 | RED, 2 of 12 — the report itself goes over its own bound | | `truncationOf(field.loss, false)` -> `truncationOf(field.loss, true)` | RED, 2 of 12 — every shortened field would read as dropped |

NINE MUTATIONS, NINE REDS, each applied to a clean tree and reverted. No rebuild is needed for this file — it imports `./index.js` from `src` — but every server-side arm that reaches the same code through the plugin host does need `pnpm exec turbo build --force`, because `@scp/runner-launcher` resolves through `main: dist/index.js`.

### §384. The composer builds those fields in that order

`observedStateFrom` composes `{revision, images, rollout}` in that order and `rollout` is the one ADR-0028's `minWeight` gate reads. Before M23.1g this arrived at the UI as `rollout: undefined`, which the card renders as "no rollout" — an operator told the executor reported nothing, about a field this repository removed. 160 sits in the measured band [126, 206] where phase 1 seats `revision` and `images` and can no longer seat `rollout`: the two survivors need 4 and 5 characters, `rollout` needs its exact 70, and the budget covers the first two and not the third. Stated as a band rather than a magic number so a retune that moved it out reads as a fixture drift.

### §385. Not a budget clip

Not a budget clip — no amount of extra budget brings the subtree back — but it IS content the reader is not seeing, which is a different question and the one the report answers. Exactly `PERSISTED_JSON_MAX_DEPTH` wrappers, so the object the limit replaces is the three-field one and the count below is a fact about it. One wrapper more and the limit falls on a `{ next }` — a different, correct, answer of 1, which is what a first draft of this arm measured and mistook for a defect.

### §386. M23.0 verification pass 15

M23.0 verification pass 15. The arm above exercises exactly ONE of the depth limit's two accounting branches — `budget.loss.fields += Object.keys(...).length` — and the array branch beside it, `budget.loss.entries += value.length`, had no arm at all. Deleting either one reddens the pair, which is why the mutation log recorded the deletion as caught; but a WRONG COUNT in the array branch was invisible to the whole 255-test suite. Measured: replacing `value.length` with `1` leaves every test green while the report tells a reader that ONE entry was replaced where FORTY were — a number the reader cannot check against anything, because the subtree it describes is exactly what the row no longer contains (charter principle 6, and the same class as a provenance label that is read rather than inferred).

The count is asserted against `ENTRY_COUNT` rather than a literal, and the literal is deliberately not 1: `+= 1` is the mutation this arm exists to kill, and an arm whose fixture has one entry cannot tell the two apart.

### §387. A DENSE BUDGET SWEEP over a structured family

A DENSE BUDGET SWEEP over a structured family — never a random corpus. M23.1f's own definition of done records why: 6 000 random shapes found zero instances of a defect a structured budget sweep caught 49 518 times, because the axis that matters is the BUDGET and randomness does not vary it. Every shape below is a plausible `observed_state`.

## `packages/runner-launcher/src/port-deadline.test.ts`

### §388. The whole-run deadline is the port's, not the author's

M23.5 HIGH-1 — THE WHOLE-RUN DEADLINE IS THE PORT'S, NOT THE ADAPTER-AUTHOR'S

THE DEFECT, AS THE MEASUREMENT. `KubernetesRunnerIo` carried `timeoutMs` on `request` and on nothing else. `copyDir` and `removeDir` took no deadline; `createFetchKubernetesIo` implemented them as a bare `cp`/`rm`. The adapter's `copy()` checked the remaining budget BEFORE the call and then awaited it forever — against `dist`, `timeoutMs: 3000`, a `copyDir` that never settles:

```text
  after 15003ms with timeoutMs=3000: STILL RUNNING
  requests issued: ["GET …/jobs timeoutMs=30000", "POST …/jobs timeoutMs=2999"]
```

and the volume is BY CONSTRUCTION a network filesystem — the chart names NFS, CephFS, EFS and Azure Files — which is the kind that hangs rather than errors. `run()` never returns; the host SIGKILLs the subprocess at `timeoutMs + MANAGED_TRIGGER_GRACE_MS`; `withRecordedOutcome` never writes; managed-iac's ledger entry never lands; `reconcile.ts` retries; a SECOND `tofu apply` goes at live infrastructure. Copy-in precedes `start`, so the abandoned Job is still SUSPENDED — it never finishes, `ttlSecondsAfterFinished` never applies, and the per-run credential Secret survives until some later run's `reap()` happens by.

WHY THIS FILE IS NOT `kubernetes-adapter.test.ts`. That suite's fake settles every operation on the next tick — deliberately, because it asks WHAT was issued and in what ORDER. It is structurally unable to ask whether an operation that never settles is given up on, which is the only question here. The same blindness is what let the surviving mutation the adversarial pass found — DELETE `copy()`'s budget pre-check entirely — leave 328 unit tests and 11 kind tests all green.

THE HANG IS MODELLED WITH A HANDLE, AND THAT IS LOAD-BEARING. See `neverSettles`.

### §389. THE FILESYSTEM SEAM

THE FILESYSTEM SEAM — the Docker adapter's secret-env staging, which is I/O the port drives too.

`secretEnvDir` is a SERVER-INJECTED path (`SCP_MANAGED_*_WORKSPACE_ROOT`), and an operator may perfectly well point it at the same shared mount the Kubernetes workspace uses. So the `mkdir` + `writeFile` that stages a mode-0600 credential file is the same unbounded network-filesystem call as a `copyDir` — and it happens BEFORE `create`, where a hang costs the whole run with no container to show for it. The census that found HIGH-1 found this too.

### §390. A promise that never settles but holds a real handle

A promise that never settles AND holds a real libuv handle while it does not.

`withStepBound`'s abandonment timer is `unref`'d on purpose: an abandonment timer must never be the reason a process stays alive, because if nothing else is pending there is no in-flight I/O to abandon. Real wedged I/O — `fs.cp` on an unresponsive NFS mount, a child in uninterruptible sleep — holds a threadpool request or a process handle, so the loop stays alive and the `unref`'d timer fires exactly when it is needed. A test that modelled the hang as a bare `new Promise(() => {})` would hold NOTHING, let the loop drain, and be asking a different question than production asks.

### §391. The boundary that condition could not reach

THE BOUNDARY `remaining <= 0` COULD NOT REACH, and it is the port primitive rather than an adapter because the defect is in the primitive. `RunDeadline` measures the deadline with `Date.now()`; the budget kill that lands on it is a libuv timer on a different clock, and the two disagree by up to a millisecond — so the step BEHIND a killed one saw `remaining === 1` and was issued as `docker cp … { timeout: 1 }`. Three arms of `whole-run-budget.test.ts` failed on that intermittently (3 runs in 8, a different arm each time), which is the shape of a boundary the process cannot land on rather than of a wrong test.

DETERMINISTIC BY CONSTRUCTION, which the arms it replaces could not be: the budget is BORN under the floor rather than whittled down to it by a race.

### §392. The second half of the same defect

THE SECOND HALF OF THE SAME DEFECT, and the one that produced a verdict about the TENANT for something the launcher did. Three sites asked "is the budget gone?" with a raw `Date.now() >= deadline.at` while the kill that lands on it is a libuv timer on another clock; the Docker adapter's was `e.killed === true && Date.now() >= runDeadlineAt`, and it reported FALSE for a `create` its own derived timeout had just killed — `exit-nonzero` instead of `budget-exhausted`. If `spent()` ever answers "no" where `spend()` refuses, they have drifted apart again.

### §393. Why the work rejects after its bound rather than at it

WHY THE WORK REJECTS AFTER ITS BOUND RATHER THAN AT IT, and it is the whole point of the arm. `execFile`'s `timeout` does not reject when it fires: it fires, SIGTERMs the child, and the promise settles on the child's exit — at least one turn of the loop later, and in practice a few milliseconds. Set the abandonment timer for the same instant and it wins that race, so EVERY ordinary budget kill arrives as an abandonment and the `code`/`killed`/`signal` and partial stdout that `classifyRunnerFailure` exists to preserve are thrown away.

THE EXISTING SUITES CANNOT ASK THIS. `whole-run-budget.test.ts`'s seam settles a killed step EXACTLY at `timeout`, and its callback timer is registered before ours, so it wins whatever the grace is — which is why shrinking the grace to zero leaves those arms green. This one models the settle delay, so it does not.

### §394. An abandoned promise rejecting late, unheard

An abandoned promise that rejects at minute nine with nobody listening takes a plugin subprocess down — the failure this whole mechanism exists to prevent, arriving by the back door.

AND THERE IS NO EXPLICIT GUARD IN `withStepBound` FOR IT — recorded here rather than left for a reader to wonder about. `Promise.race` subscribes to every promise it is given and keeps that subscription after it settles, so `pending` is handled from the moment it enters the race. A first draft added `void pending.catch(() => undefined)`; mutating it away reddened NOTHING across the whole suite, so it went (charter priority 1). This arm is what a rewrite away from `Promise.race` — an `AbortController` and a `.then`, say — would have to keep true, which is why it stays even though nothing in today's code can break it.

## `packages/runner-launcher/src/reaper-integration-child.ts`

### §395. NOT A TEST FILE

NOT A TEST FILE. Standalone entry point spawned BY `reaper.integration.test.ts` — never imported, never run by vitest.

Its whole job is to launch ONE real container through the REAL Docker adapter — the same `createDockerRunnerLauncher().run()` production code path a managed executor's subprocess would take — and then do nothing else, so the PARENT test can SIGKILL this process while `docker start -a` is attached. That reproduces exactly the scenario M23.1 phase 4 exists for: the host's own hang detector (`apps/server/src/plugin-host/host.ts`, sized by `call-policy.ts`) `child.kill("SIGKILL")`s a subprocess mid-`trigger()`, no `finally` runs, and the container the daemon already started keeps running with nothing left supervising it.

Nothing in this file's OWN exit path matters — the whole point of the scenario is that this process never gets the chance to run one. If `run()` ever resolves or rejects on its own (the happy path, useful for the parent's OTHER negative-arm container — see the test file), this just reports it and exits; the parent does not wait for that under the SIGKILL scenario.

## `packages/runner-launcher/src/reaper.integration.test.ts`

### §396. REAL-DOCKER PROOF OF THE REAPER

REAL-DOCKER PROOF OF THE REAPER (M23.1 phase 4) — WHAT THE MOCK SEAM STRUCTURALLY CANNOT SHOW
`docker-adapter.test.ts` settles argv shape and the predicate's LOGIC against a hand-written `execFile`. It cannot prove any of the three things that actually matter here, because a mock has no daemon behind it to be wrong about: 1. that a process SIGKILLed mid-`run()` really does leave a container behind, `state=running`; 2. that the two labels `create` stamped on it really do survive that kill, on disk, in the daemon's own store — not just in an in-memory recorder; 3. that a REAL `docker ps -a --filter label=...` really does find it, and that a REAL `docker rm -f` really does remove it — Docker's own filter/label semantics, not this package's idea of them. This file drives all three against a live daemon. Needs Docker — excluded from `pnpm test` (`vitest.config.ts`), run via `pnpm test:integration` in the CI integration-shard job (GitHub-hosted `ubuntu-latest`, native Docker daemon), or locally.

THE IMAGE: `alpine:3.20`, chosen because it is one of the images `tools/ci-mirror/images.list` pre-mirrors into every CI runner under this EXACT literal tag — the integration-shard job's "deny the mirrored upstream registries for the rest of the job" step (`ci.yml`) would otherwise block a fresh pull of anything else. Locally it is whatever is already pulled or gets pulled once.

WHY A PAST DEADLINE IS CRAFTED DIRECTLY RATHER THAN WAITED FOR. `RUNNER_REAP_GRACE_MS` is sized in real minutes (see its own doc in `index.ts`) precisely so a legitimate peer's container is never touched early — which is exactly why this suite cannot afford to wait for one to elapse. The two containers that need a PAST deadline are therefore created with `docker create --label` directly (bypassing the port, not `reap()` — `reap()` itself is real code, driven exactly as production drives it), the same "fabricate an already-expired record" technique any TTL sweep is tested with. The one container that needs to be REAL end-to-end (killed process, daemon-assigned state, adapter-computed deadline) is built the other way — see the first test below — and its naturally-future deadline is what makes it double as the FUTURE-deadline negative case.

A REAL, PRE-EXISTING ORPHAN ALREADY LIVES ON THIS MACHINE (`scp-runner-scan:m13-3b-integration- test`, `state=created`, no `scp.launcher.*` labels — left in place deliberately as evidence, per this milestone's own instructions). It carries none of this package's labels, so it is excluded at `reap()`'s own `docker ps -a --filter label=scp.launcher.owner` — before a single byte of its state reaches this process — on EVERY test below, not only the one that checks it explicitly.

### §397. THE PARENT calls reap()

THE PARENT calls reap() — a DIFFERENT process from the one that created this container (the child minted its own `LAUNCHER_OWNER_ID` at its own module load), so this container is FOREIGN from the parent's point of view. Its deadline is minutes in the future (the child only just created it), so reap() must spare it. If "foreign" and "future" were not both being evaluated for real — if, say, the predicate only checked one of them, or a stale identity happened to collide — this is where that would show.

### §398. The two negative arms are race-free, so crafted once

THE TWO NEGATIVE ARMS ARE RACE-FREE, so they are crafted ONCE, up front, and left standing across every attempt below: a FUTURE deadline is spared by every reaper that exists (this process's or any other's), and a container carrying no `scp.launcher.owner` label at all is excluded by `reap()`'s own `--filter` before a predicate runs. Only the POSITIVE arm is something another process is entitled to take, so only it is crafted inside the loop.

### §399. Two races can hand this case an empty result

TWO RACES CAN HAND THIS CASE AN EMPTY `removed`, AND ONLY THE FIRST IS IN THIS PROCESS.

(1) IN-PROCESS, closed by `whenReapSettled()` (PR #266). `reap()` is single-flighted per binary (`reapInFlight`): a caller arriving while a pass is running is handed THAT pass's promise, and that pass's `docker ps` can predate the fixture. Awaiting `whenReapSettled` drains the slot (its `.finally` deletes the entry before the promise resolves), so the `reap()` below always starts a FRESH enumeration.

(2) CROSS-PROCESS, which nothing in this process can see — and this is what STILL red'd the assertion with #266's fix in tree (`main` run 32668830570, and PR #267/#268 runs). `reap()` is a shared-daemon janitor and ownership is per-PROCESS: the fixture below is FOREIGN to everyone (its owner label is a fresh random UUID) and 60s past its deadline, which is precisely what EVERY process running this package is entitled to collect. CI's `pnpm test:integration` is `turbo run test:integration`, which runs `@scp/plugin-managed-{iac,scan,dep}` in parallel with this package, in their own Node processes, against the SAME daemon — and each `plugin.trigger()` there reaches `RunnerLauncher.run()`, whose first act is `void reap()`. If one of those passes lands in the window between the `docker create` below and this pass's `docker ps`, the fixture is ALREADY GONE, this pass correctly reports `[]`, and the container-state assertions below would all still have passed. (#266's own commit message records `scp-managed-scan-plugin- it-*` containers leaking in the very CI run it was diagnosing — that suite was live on that daemon at that moment.) MEASURED HERE, deterministically: a second Node process's `reap()` returned `["e121f6511911"]` and this process's next pass then returned `[]`, with the container gone — the reported failure, exactly.

SO: SHRINK THE WINDOW, THEN RE-RUN THE EXPERIMENT WHEN IT IS STOLEN — AND ONLY THEN. Drain first and craft the stealable fixture LAST (window: one `create`+`start`, ~220ms measured, against ~660ms when all three were crafted before the drain). A pass that reports none of OUR ids has exactly two possible causes, and the container itself tells them apart: still running = the predicate under test failed, and that fails HERE, by name, on attempt 1; already gone = a peer's pass took it, which is the library working as designed and is worth another attempt rather than a red main.

### §400. CRAFT A STEALABLE ORPHAN AND OBSERVE IT STANDING

CRAFT A STEALABLE ORPHAN AND OBSERVE IT STANDING — recraft on a peer's steal, bounded. The orphan is a legitimate reap candidate for EVERY process on this daemon from the instant `docker create` returns (foreign owner, past deadline), so a concurrent `@scp/plugin-managed-*` suite's pass can take it before this case's precondition looks at it: mid-`rm` reads `removing`, a completed steal reads undefined, and a steal inside the builder itself makes its `docker start` throw. All three are the library working as designed in ANOTHER process — recraft and try again; only a bounded run of steals is a failure, and it names the cause. (Observed for real: PR #272 run 32755551605 red exactly here with `expected 'removing' to be 'running'`.)

### §401. THE SWEEP IS NOT AWAITED BY `run()` SINCE M23.1e

THE SWEEP IS NOT AWAITED BY `run()` SINCE M23.1e — that is the fix for HIGH-3 (a reap that spends the run's budget can stop `create` being issued at all), so this test has to await it explicitly instead of racing it. THE GATE KEEPS ITS TEETH: with the scheduling deleted there is no pass in flight, `whenReapSettled()` resolves immediately, and the orphan is still there below.

THE SAME CROSS-PROCESS PROPERTY THE PREDICATE CASE ABOVE LOOPS OVER APPLIES HERE, in two windows with opposite consequences. BEFORE the precondition, a peer's steal CAN red this case — that window is what the craft loop above absorbs (it did red, once: see the loop's comment). AFTER the precondition, a steal landing inside this one run() can only mask a genuinely deleted wiring for that narrow window — provided the final assertion reads the container's state as the TRI-STATE it is (running / mid-`rm` 'removing' / gone), which is why it asserts not-"running" rather than gone: a peer's rm still in flight at read time is a collected orphan, not a standing one. Left as an assertion on the container rather than on `whenReapSettled()`'s id list deliberately: keying the gate on THIS process's report would trade that rare vacuous pass for a rare flaky red on the one test whose whole job is to go red when the wiring is gone.

### §402. A real kill mid-create genuinely leaves the env file

MEDIUM-4 — A REAL SIGKILL MID-`create` GENUINELY LEAVES THE `--env-file`, AND `reap()` SWEEPS IT.
Deliberately its own top-level `describe`, NOT nested inside `describe.runIf(dockerAvailable())` above: what is under test is `@scp/runner-launcher`'s OWN file lifecycle (write, then unlink in a `finally`), not Docker's, so a real daemon buys nothing here and would only make the suite Docker-dependent for no reason. The `dockerBinary` this block hands the adapter is a stub shell script that sleeps on `create` — the same "give the parent a wide, deterministic window instead of racing a real sub-hundred-millisecond call" technique `apps/server/src/plugin-host/managed-trigger- budget.test.ts` already uses for a different budget-shaped hazard. See `secret-env-leak-integration-child.ts` for what the killed process actually runs.

### §403. Polls for a file whose content equals the expected

Polls `dir` for a file carrying `prefix` WHOSE CONTENT equals `expected` — the same "observe the real adapter's real state" technique `reaper.integration.test.ts`'s own `waitUntil` uses for a container's `docker inspect` state, applied to a file instead.

NAME-VISIBILITY IS NOT CONTENT-VISIBILITY. `writeSecretEnvFile` writes with a single `writeFile(path, …, { flag: "wx" })` — open, then write, then close, three separate syscalls — so the name is in `readdir` before the bytes are in the file. A waiter that returns on the name and reads once caught the gap on a loaded CI runner (2026-08-24, PR #271 shard 1: `expected '' to be 'AWS_SECRET_ACCESS_KEY=…'` — an EMPTY read, not ENOENT, which is this race's exact signature and rules out anything sweeping the file). Waiting for the CONTENT collapses both causes of emptiness (mid-write vs never-written) into one loud timeout.

## `packages/runner-launcher/src/recorded-outcome.test.ts`

### §404. `withRecordedOutcome` in isolation

`withRecordedOutcome` in isolation — the plugin-level tests (`managed-iac`/`managed-scan`'s `launcher-seam.test.ts`) prove it is actually WIRED into `trigger()`; this file proves the primitive itself does what its doc claims, independent of any plugin.

### §405. FOUND BY A MUTATION, NOT BY READING

FOUND BY A MUTATION, NOT BY READING (M23.0 verification pass 7). Removing the bound from `withRecordedOutcome` left all 17 tests in `failure-detail-bound.test.ts` green, because none of them came through this helper — and this helper is the path for EVERY throw out of a plugin's `trigger()`, which is where the freeform, unbounded strings actually are: a `docker create` rejection's `.message` carries the child's whole stderr, and managed-iac's `record` writes it to a durable JSON file that is never pruned and from there into a `Decision`'s `inputContext`.

### §406. A rejection's standard error reaches the record

M23.5 MEDIUM-8 — A `create`/`secret-env`/`copy-in` REJECTION'S `.stderr` REACHES THE RECORD TOO

`create`, `secret-env` and `copy-in` failures reject `run()` directly — `classifyRunnerFailure` never runs for them, so `withRecordedOutcome` is the ONLY place their rejection becomes a recorded `detail`. The Kubernetes adapter's `api()` builds a deliberately SHORT `.message` ("kubernetes POST /path -> HTTP 403") and puts the API server's own response body — the reason — in `.stderr` instead. Before this fix, only `.message` was read.

### §407. The Docker cause is that call's own rejection

The Docker adapter's cause IS `promisify(execFile)`'s own rejection, whose `.message` is Node's own `Command failed: ... \n<stderr>` format — the reason is already in `.message`, and `RunnerLaunchError`'s constructor falls `.stderr` back to that SAME `.message` when the cause carries no `stderr` of its own (see the class doc's "THE `?? \"\" / ?? message` FALLS"). If `withRecordedOutcome` concatenated unconditionally, every Docker failure would print its reason twice.

## `packages/runner-launcher/src/secret-env-leak-integration-child.ts`

### §408. NOT A TEST FILE

NOT A TEST FILE. Standalone entry point spawned BY `reaper.integration.test.ts` — never imported, never run by vitest. Sibling of `reaper-integration-child.ts`, same technique, different hazard.

Its whole job is to launch ONE real run through the REAL Docker adapter — `createDockerRunnerLauncher`, the same production code path a managed executor's subprocess takes — with a `secretEnv` credential and a `dockerBinary` pointed at a STUB (argv[1], a slow `create`), so the PARENT test can observe the transient `--env-file` genuinely existing on disk and SIGKILL this process while `create` is still in flight. That reproduces MEDIUM-4 exactly: the host's own hang detector (`apps/server/src/plugin-host/host.ts`) `child.kill("SIGKILL")`s a subprocess mid-`trigger()`, no `finally` runs anywhere in this process, and the mode-0600 credential file the adapter wrote is left behind with nothing left to unlink it.

THE STUB, NOT A REAL DAEMON, ON PURPOSE. What is under test here is the ADAPTER's own file lifecycle — write, then unlink in a `finally` — not Docker's. A stub gives the parent a wide, deterministic window (a `sleep` the parent knows the length of) instead of racing a real `docker create`'s sub-hundred-millisecond duration, which is exactly the technique `managed-trigger-budget.test.ts` already uses for a different budget-shaped hazard.

Nothing in this file's OWN exit path matters — the whole point of the scenario is that this process never gets the chance to run one.

## `packages/runner-launcher/src/teardown-model.test.ts`

### §409. What may happen after the deadline, counted from code

M23.5 HIGH-2 — WHAT MAY HAPPEN AFTER THE RUN DEADLINE IS COUNTED FROM THE CODE

THE DEFECT WAS NOT THE NUMBER. `call-policy.ts` writes the arithmetic out and chose 60s as "two worst-case teardowns" of `RUNNER_REMOVE_TIMEOUT_MS`. That was true when a teardown was one `docker rm -f`. The Kubernetes `finally` is THREE bounded calls, so sixty seconds of bounded work consumed the entire grace and left nothing for the outcome write the grace exists to protect.

AND THEN THIS FILE ASKED THE WRONG QUESTION. Its first version asked *what does the teardown `finally` issue?* — one question narrower than the property, which is *what bounded call can be issued after the run deadline?* The same round that wrote it added one that is in no teardown `finally`: the Docker adapter's secret-env `unlink`, in `create`'s own `finally`, whose comment says outright "BOUNDED LIKE A TEARDOWN, NOT SPENT FROM THE BUDGET". Two things hid it:

```text
1. THE COUNTER FILTERED ON SHAPE. `dockerCalls.filter((c) => c.args[0] === "rm")` can only ever
   count a `docker rm`; an `fs.unlink` was structurally invisible to it. A filter is where the
   next instance hides (CLAUDE.md).
2. THE FIXTURE COULD NOT REACH THE CASE. It drove a bare `spec()` with no `secretEnv`, so no
   env-file was ever staged and no `unlink` was ever possible. The KUBERNETES counter beside it
   passed `secretEnv` deliberately and said why — "a spec without `secretEnv` would count two
   and agree with a model that is wrong by a third". The reasoning was applied to one adapter
   and not the other.
```

Measured cost: `run()` returned 64004ms into a run whose stated bound (`runnerRunBoundMs("docker", 1000)`, whose own doc calls itself "THE BOUND `run()` IS HELD TO") was 33000ms — 1004ms past the host's SIGKILL, so `withRecordedOutcome` never writes and `reconcile.ts` retries into a second `tofu apply`.

SO THE COUNTING RULE IS TIME, NOT SHAPE: drive each adapter to a run whose budget is ALREADY SPENT, record EVERY effect it issues — `execFile`, `fs`, `io.request`, `io.removeDir`, whatever later arrives — and count the ones at or after the deadline. Nothing is filtered by what a call looks like, so a fifth kind of post-deadline call reddens this the same way a fourth `DELETE` would. The other direction is the type checker: `withPostDeadlineBound` accepts only a name declared in `RUNNER_POST_DEADLINE_CALLS`, and `RUNNER_POST_DEADLINE_CALL_COUNT` is that list's length rather than a second copy of it — so no number anywhere has to be remembered.

### §410. Non-vacuity, and the one thing that could pollute it

NON-VACUITY, AND THE ONE THING THAT COULD POLLUTE THE WINDOW. `reap()` is `void`-scheduled at the top of `run()` and is NOT post-deadline work of this run; both fixtures answer its listing with nothing to remove, so its only effects are the listing itself and (on Docker) the `readdir` of `secretEnvDir`. If either ever drifted into the window the count would be wrong, so it is asserted out rather than filtered out.

### §411. THE CENSUS SLOT

THE CENSUS SLOT. Every kind in `RUNNER_POST_DEADLINE_CALLS` must have a counter here, and the arm below asserts the two key sets are EQUAL — so a third adapter cannot join the model with its declared calls checked by nothing.

## `packages/runner-launcher/src/test-support/yield-between-tests.ts`

### §412. RETURN THE WORKER'S EVENT LOOP BETWEEN TESTS

RETURN THE WORKER'S EVENT LOOP BETWEEN TESTS — OR THE RUN FAILS WITH EVERY TEST PASSING

WHAT WENT WRONG. CI job 4 ("Unit tests", `pnpm test -- --coverage`) failed on `@scp/runner-launcher#test` with:

```text
  Test Files  17 passed (17)
       Tests  429 passed (429)
      Errors  1 error
  Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

Nothing was wrong with any assertion. vitest exits 1 on an unhandled error, so turbo failed the task on a suite that had just reported 429 passes.

THE MECHANISM, MEASURED RATHER THAN INFERRED. `onTaskUpdate` is the worker → main-thread RPC that carries per-test results. It is a birpc CALL: the worker posts the request and awaits a reply, and birpc arms a timer for `DEFAULT_TIMEOUT = 60_000`ms when the call is issued. That constant is compiled into vitest's bundled copy of birpc; vitest passes no `timeout` option from `getRpcOptions()`, so it is NOT reachable from any config file.

The reply is not slow. The reply cannot be READ. `persisted-json-bound.test.ts` is 79 purely SYNCHRONOUS sweeps (`for (let budget = 400; budget <= 3_900; budget++)` and friends). A run of synchronous tests never lets the worker's event loop reach its poll phase — `await`ing a non-promise only drains microtasks — so an `onTaskUpdate` issued near the start of the file has its reply sitting unread in the IPC channel for the file's WHOLE duration. When the loop finally turns, the timers phase runs before poll, so birpc's 60s timer fires first and throws.

The trigger is therefore ONE NUMBER: the longest stretch in which the worker's loop does not turn. On CI that file measured 62,948ms — 61,134ms of it in eight synchronous tests — against a 60,000ms deadline. It is 4,301ms isolated on the author's machine and 11,628ms under the local 71-task graph; what pushed it over was a 4-vCPU runner executing turbo's graph, ~14x.

REPRODUCED, AND CONTROLLED, BEFORE ANY OF THIS WAS WRITTEN:

| condition                                                  | result                        |
```text
| this suite, 110 CPU spinners (test time 91s)                | Timeout calling "onTaskUpdate" |
| this suite, 80 CPU spinners, twice (test time 67.5s, 71.7s) | Timeout calling "onTaskUpdate" |
| 3 synthetic sync tests x 21s = 63s, NO load, NO coverage    | Timeout calling "onTaskUpdate" |
| 3 synthetic sync tests x 16s = 48s, NO load                 | clean                          |
| 3 synthetic sync tests x 21s = 63s WITH a yield per test    | clean                          |
| 6 synthetic sync tests x 21s = 126s WITH a yield per test   | clean                          |
```

The last two rows are the whole argument. 126s of the same blocking is HARMLESS once the loop is allowed to turn between tests, and 63s is fatal without it. This is not about duration, load, payload size or the main thread — it is about starvation inside one worker.

WHAT THIS FILE DOES, AND WHY IT IS NOT A PAPER-OVER. One macrotask tick before each test. That removes the starvation itself; nothing is suppressed, no budget is weakened, no assertion or real-timer deadline moves, and all 429 tests still run. It also converts the bound from "the whole FILE must stay under 60s" — a number that grows every time a property is added, and that is measured on a machine nobody controls — into "one TEST must stay under 60s", which `testTimeout` (30,000ms here, gated by @scp/source-census's test-budget-census.test.ts) already fails loudly and legibly.

WHAT THE YIELD DOES NOT COVER, MEASURED IN THE FIELD RATHER THAN ASSUMED. A `beforeEach` runs between TESTS, so the window it cannot reach is the one before the first test: module load and collection. That window is real. Under a deliberately excessive local load — a 16-spinner CPU flood on top of the whole turbo graph, several times what CI applies — `no-spawn-on-kubernetes.behaviour.test.ts` spent 129,783ms in it and took the RPC deadline with it. The tripwire below caught that one and named it (`around "<file setup>"`), which is exactly the division of labour intended here: bound what can be bounded, REPORT what cannot, and leave neither to a run whose only symptom is "429 passed, 1 error".

WHY THE REAL `setImmediate` IS CAPTURED AT MODULE LOAD. `whole-run-budget.test.ts` calls `vi.useFakeTimers()`, which replaces `globalThis.setImmediate`. A yield through a faked `setImmediate` never resolves, which would hang the suite instead of unblocking it. Setup files are evaluated once per test FILE before any test runs, so the binding taken here is always the real one — the same trick vitest's own `withSafeTimers` uses for exactly this reason.

### §413. The tripwire, below the worker deadline

THE TRIPWIRE. Below vitest's 60,000ms worker-RPC deadline, above anything a healthy file can reach: with the yield in place the longest possible stall is one test, and a test over 30,000ms is already a `testTimeout` failure. So this can only fire if the yield stops working — if the setup file is unwired, or a single test learns to block for three quarters of a minute — and when it does it fires with the cause written on it, 15 seconds before the failure that says nothing but "429 passed, 1 error".

### §414. `process.hrtime.bigint()`, NOT `Date.now()`

`process.hrtime.bigint()`, NOT `Date.now()` — this suite MOVES THE WALL CLOCK. `kubernetes-adapter.test.ts` runs `vi.useFakeTimers({ toFake: ["Date"] })` and then `vi.setSystemTime(Date.now() + req.timeoutMs - shortfallMs)` to walk a run up to its deadline without waiting for it. Those arms restore with `vi.useRealTimers()` in a `finally`, so a wall clock read BETWEEN tests happens to be safe today — which is exactly the kind of "safe by where the other file happens to put its cleanup" that this gate should not be built on. A test that leaves a stepped clock installed (an early throw past the `finally`, a new arm written without one) would make this tripwire fire on a suite that never stalled: a gate against a load-dependent failure, itself producing a load-independent false alarm. `hrtime` is monotonic and lives on `process`, which vitest's fake timers — they patch `globalThis` — do not touch.

## `packages/runner-launcher/src/whole-run-budget.test.ts`

### §415. The whole-run budget and the stamp it makes true

M23.1e — THE WHOLE-RUN BUDGET, THE REAP STAMP IT MAKES TRUE, AND THE TEARDOWN THAT MUST NOT FIRE

WHY THIS FILE EXISTS SEPARATELY FROM `docker-adapter.test.ts`. That suite's seam settles every step on the NEXT TICK, deliberately — it is about WHAT goes on the command line and in what ORDER, and a step that takes no time is the cleanest way to ask those questions. It is therefore structurally unable to ask the only question M23.1e is about: HOW LONG. Every one of the four defects below was invisible to eighty green tests for exactly that reason.

THE SEAM HERE MODELS DURATION AND MODELS `timeout`, and the second half is not decoration: - a step takes `durations`[sub] milliseconds before its callback fires; - if the `timeout` the adapter passed is a POSITIVE number smaller than that, the callback fires at the timeout instead, with `killed: true, signal: "SIGTERM"` — the shape `promisify(execFile)` really produces (pinned against the running Node by `docker-adapter.test.ts`'s NODE_FAILURE_SHAPES table); - if `timeout` is `0` or absent, THE STEP IS NOT INTERRUPTED. That is not a simplification, it is Node's actual behaviour and the trap this change had to avoid: measured on the running Node, `execFile(…, { timeout: 0 })` let a 1.5s child run to completion. Modelling it here is what makes a regression to a naive `deadline - now` (which reaches 0 at exactly the moment a bound matters most) fail LOUDLY rather than pass. A seam that ignored `timeout` would make every assertion below vacuous: the adapter's bound would never be exercised and the run would simply take as long as the steps took.

WHAT EACH DESCRIBE BLOCK IS THE STANDING GATE FOR: 1. HIGH-1 — k steps, each individually under the bound, may not sum past the budget. 2. HIGH-2 — the container's own `scp.launcher.deadline` may never be in the past while `run()` is still in flight. This is the one where being wrong destroys live infrastructure: to any peer launcher that container is then `foreign AND past deadline`, which is precisely and only what `reap()` removes. 3. HIGH-3 — `reap()` may not spend the run's budget, may not delay `create`, and may not fail the run. 4. The fourth defect — a `create` that lost the NAME must not tear that name down, while every other create failure still must.

### §416. The numbers are chosen so only the property can fail

THE NUMBERS ARE CHOSEN SO THAT THE ONLY THING THAT CAN FAIL IS THE PROPERTY. Every step — 800ms, 800ms, 1800ms — is comfortably inside the 2000ms bound the old code handed out AFRESH to each of them, so "no single call exceeded its timeout" is true either way and cannot be what distinguishes the two. Their SUM (3400ms) is what the budget has to cut off, and it cuts it off mid-`start`: the run ends at 2000ms.

### §417. And it really is the spent time that came off

And it really is the SPENT time that came off, not an arbitrary decrement.

THE PER-STEP MILLISECOND IS THE CLOCK DISAGREEMENT THIS PACKAGE HAS ALREADY MEASURED AND WRITTEN DOWN — not a fudge factor bolted on to make a red test green. `RunDeadline` reads `Date.now()`; each fake step here completes on a libuv timer; the two clocks disagree by up to a millisecond, so `setTimeout(150)` can hand control back with `Date.now()` having advanced only 149. `index.ts`'s `isExhausted()` docblock records exactly this mechanism, measured on three OTHER arms of this same file — "3 runs in 8, a different arm each time, which is the signature of a boundary the process cannot land on rather than of a test that is wrong". That fix hardened the production refusal and left this arm's arithmetic still assuming a step always spends at least its NOMINAL duration. CI then caught it at exactly one millisecond: `expected 4851 to be less than or equal to 4850`.

IT ACCUMULATES, so the allowance is per-step rather than a single constant: step N has N completed sleeps behind it and can therefore under-report by up to N ms.

AND IT STAYS NON-VACUOUS BY TWO ORDERS OF MAGNITUDE. The hypothesis these three lines exist to refute is "the budget was decremented by an arbitrary constant rather than by the time actually spent". A fixed per-step decrement would leave `timeouts[1]` up around 4990 against a bound of 4851 — a ~140ms gap. Three milliseconds of clock slop does not reach across it, so every one of these lines still fails against the defect it was written for.

### §418. The formula, so an absurdly distant stamp cannot satisfy

The formula, so that "always in the future" cannot be satisfied by an absurdly distant stamp, which would make `reap()` never collect a real orphan.

CORRECTED CLAIM (this comment used to say the bracket also caught a stamp "derived from a second, later `Date.now()`" — measured false). `before`/`after` bracket the WHOLE `run()` call, so ANY clock read taken during that call satisfies both bounds, including a second read taken at the reapDeadline call site itself: `new Date(runDeadlineAt + RUNNER_REAP_GRACE_MS)` mutated to `new Date(Date.now() + runTimeoutMs + RUNNER_REAP_GRACE_MS)`, at the same line, survives the whole file (117/117) and the managed-iac/scan/dep and plugin-host sibling suites — no time elapses between the two reads at that point in `run()`, so the two stamps are indistinguishable in practice. The mutation is SAFE, not undetected-and-dangerous: a later read only ever makes the stamp later (the conservative direction), and the actually dangerous direction — dropping the grace entirely — IS caught, here and by the siblings. The real HIGH-2 regression this file guards against was a stamp read much LATER in `run()`, after real async work had elapsed; "SAMPLED THROUGHOUT A RUN THAT SPENDS ITS WHOLE BUDGET" above is what actually catches that.

### §419. Bounding each call bounds nothing if the count is not

BOUNDING THE INDIVIDUAL CALLS BOUNDS NOTHING when the number of calls is the unbounded term: n orphans at RUNNER_REMOVE_TIMEOUT_MS each is n x 30s, and n grows with every crash the fleet has had — including the crashes an over-long reap causes, which is HIGH-3's amplification. A pass therefore has its own deadline and simply STOPS; what is left is still expired, still labelled and still there next time, because a sweep is idempotent.

FAKE TIMERS, BECAUSE THE BUDGET IS TWO REAL MINUTES. Vitest's fake clock drives `Date.now()` as well as `setTimeout`, so the adapter's own deadline arithmetic runs against it — the alternative is either a two-minute test or a budget shrunk to suit the test, and the second is how a constant stops meaning what it says.

### §420. WHAT WAS WRONG

WHAT WAS WRONG. `MANAGED_RUN_TIMEOUT_MAX_MS` was enforced in exactly two places — the three manifests' `configSchema` (the write door, which a row stored before the ceiling existed never passes through again) and `resolveCallPolicy`, which clamps only its OWN return value, the host's RPC budget. All three plugins passed the STORED `timeoutMs` into `RunnerSpec.timeoutMs` untouched and this adapter derived its deadline, its step timeouts and its container's reap stamp from that unclamped number. Measured for a stored 4h:

```text
  host budgetMs                 3_660_000   (clamped: 3_600_000 + the 60s trigger grace)
  RunnerSpec.timeoutMs         14_400_000   (UNCLAMPED)
  the host SIGKILLs at t+3_660_000ms and the container it orphans is stamped t+14_520_000ms
  -> UNREAPABLE for a further 181 minutes, with `docker inspect` still holding its credentials
```

THE ARMS BELOW DRIVE THE THREE PLACES THE UNCLAMPED NUMBER REACHED, one each, so that removing the clamp reddens them BY NAME rather than reddening one composite assertion.

THE STORED VALUE USED THROUGHOUT is 4 hours — a real inhabitant of the pre-ceiling schema (`{ minimum: 1000 }` admitted up to 2^31), large enough that every bound below is unambiguous, and small enough that its arithmetic is readable next to a one-hour ceiling.

### §421. BRACKETED, NOT COMPARED TO A SINGLE PRE-RUN READ

BRACKETED, NOT COMPARED TO A SINGLE PRE-RUN READ — verification pass 6. The stamp is `t_run + BOUND`, where `t_run` is run()'s OWN single clock read and `before <= t_run <= after` by construction. The previous form asserted `stamp - before <= BOUND`, which expands to `(t_run - before) + BOUND <= BOUND` and is therefore satisfiable ONLY when `t_run === before` — i.e. only when zero milliseconds elapsed between this test's clock read and run()'s own. It failed whenever the setup between them crossed a millisecond boundary: measured at 5/10 in isolation, 3/8 at package scope and 1/4 on a full `turbo test --force`, on an UNMUTATED tree, with the excess always exactly the elapsed setup time (probed by injecting a 50ms sleep: the overshoot became 51ms). Bracketing needs no slack constant and is exact in both directions.

### §422. The secret file's maximum age is the sum of those two

`RUNNER_SECRET_ENV_MAX_AGE_MS` is `MANAGED_RUN_TIMEOUT_MAX_MS + RUNNER_REAP_GRACE_MS`, and its safety argument is "no run still inside its own budget can make its own `--env-file` look this old". The `--env-file` is written at the top of `run()`, off the same clock the stamp is; so the argument is true exactly when the stamp is never further out than that age. That is the arithmetic this asserts, against the SAME emitted stamp the reaper reads — the doc used to rest instead on a ceiling nothing applied plus a SIGKILL from a package this one may not import (and which the one in-process caller does not have at all).

### §423. Bracketed for the same reason the stamp arm above is

BRACKETED for the same reason as the REAP STAMP arm above (verification pass 6) — and the reference point matters here in a way it did not there. The `--env-file` is written INSIDE `run()`, so its mtime is at or after run()'s clock read; `writtenAt` is read BEFORE the call and is therefore an upper bound on the file's age that is strictly LARGER than the real one. Comparing that proxy against the bound could only pass when the two reads landed in the same millisecond. `after` brackets run()'s read from above, which is the true comparison.

### §424. THE COMPOSITION, DRIVEN RATHER THAN ASSERTED IN PROSE

THE COMPOSITION, DRIVEN RATHER THAN ASSERTED IN PROSE. The stamp is read back from the launcher's own `create` argv (never a literal), shifted back by the bound, and fed to a REAL `reap()` pass as a FOREIGN container. If the bound holds, a peer that started `bound` ago is past its stamp NOW and is removed; without the clamp that same shifted stamp is ~3 hours in the FUTURE and `reap()` correctly leaves it — which is precisely the defect.

### §425. The defect: start alone is captured, not thrown

THE DEFECT. `start` is the only step whose failure is CAPTURED rather than thrown, and the step that spends essentially all of a real run's budget. Its catch kept `e.stdout`/`e.stderr` and nothing else — and `promisify(execFile)` ALWAYS attaches `stderr` as a string, so `RunnerLaunchError`'s `?? message` fall never fires. Measured through the real adapter:

```text
  budget-killed `start`, no output   ->  {"succeeded":false,"stdout":"","stderr":""}
  runner exits 3 silently            ->  {"succeeded":false,"stdout":"","stderr":""}
```

Byte-identical, and through the real plugins that became `phase:"failed", detail:""` in the durable ledger, in `status()` and in reconcile's Decision `inputContext`. `index.ts` said "THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT" about the thrown path; on the captured one the message was replaced and then dropped.

THIS FILE OWNS THE BUDGET ARM because it is the only seam that models DURATION. The other four shapes are classified in `docker-adapter.test.ts`, whose steps settle on the next tick and can therefore never reach a run deadline at all.

### §426. EXPLICITLY NOT A RECORDING OF TODAY'S NODE

EXPLICITLY NOT A RECORDING OF TODAY'S NODE. The measured RangeError carries no `killed` property at all (NODE_FAILURE_SHAPES pins that against a real child), so with today's shapes the maxBuffer test could sit on either side of the `killed` test and nothing would change — stated in `classifyRunnerFailure`'s own doc rather than implied. Node DOES kill the child on an overflow, though, so gaining `killed: true` there is an unremarkable future change, and after it the wrong order reclassifies a run whose evidence is TRUNCATED as a plain signal. That is a diagnosis an operator acts on differently: truncated output means the recorded `plan.json` is not the whole plan.

### §427. The OTHER budget path

The OTHER budget path — the step never reaches Node at all, so there is no child, no `code` and no output of any kind. It rejects out of `run()` rather than being captured, and `classifyRunnerFailure` must give it the same kind: to an operator "we ran out mid-`start`" and "we ran out before `copy-in`" are one diagnosis with one remedy. `start` is killed by the derived timeout, which lands the clock ON the deadline; the copy-out that follows is therefore REFUSED rather than issued. `propagate` so it escapes `run()` (managed-scan's and managed-dep's axis) instead of being swallowed.

### §428. No child ever existed, so there is no code and no signal

NO CHILD EVER EXISTED, so there is no `code` and no `signal`, and this is the ONE path where `RunnerLaunchError`'s `?? message` fall does fire (the cause is a synthesised `Error`, not a `promisify(execFile)` rejection) — so `stderr` carries the refusal text rather than being empty. The record is complete either way, which is the property; the ABSENT `code` is asserted because a classifier that read a missing `code` as an errno would call this `spawn-failed`.

## `packages/runner-launcher/vitest.config.ts`

### §429. Unit layer (BUILD_AND_TEST.md §4.1)

Unit layer (BUILD_AND_TEST.md §4.1) — mirrors `@scp/plugin-managed-iac`'s exact pattern: excludes `*.integration.test.ts` (the real-Docker reaper test, `reaper.integration.test.ts` — M23.1 phase 4) so `pnpm test` never depends on a Docker daemon being available.

### §430. ONE MACROTASK TICK BEFORE EACH TEST

ONE MACROTASK TICK BEFORE EACH TEST — WITHOUT IT THIS SUITE FAILS THE RUN WITH 429 PASSES. CI job 4 failed `@scp/runner-launcher#test` on `[vitest-worker]: Timeout calling "onTaskUpdate"` while reporting `17 passed / 429 passed / 1 error`. vitest's worker->main task-result RPC carries a birpc deadline of 60,000ms that is compiled into vitest's bundle and reachable from no config, and `persisted-json-bound.test.ts` is 79 PURELY SYNCHRONOUS sweeps: a run of synchronous tests never lets the worker's loop reach its poll phase, so the reply — sent within milliseconds — cannot be READ for the file's whole duration. That file measured 62,948ms on the CI runner against the 60,000ms deadline (4,301ms isolated here; ~14x inflation from turbo's 71-task graph on a 4-vCPU runner).

The setup file's own module doc carries the measurements and the two controls that pin the mechanism: 63s of synchronous blocking fails with NO load and NO coverage, and the SAME 63s with one yield per test is clean — as is 126s. Nothing is suppressed and no budget moves; the tick bounds the stall by ONE TEST rather than by the whole file, and a test is what `testTimeout` below already governs.

### §431. The per-test budget is declared here because it was not

THE PER-TEST BUDGET IS DECLARED HERE BECAUSE IT WAS NOT, AND THAT IS WHAT FLAKED (M23.1f clause 6). This package ran on vitest's IMPLICIT 5,000ms default while holding the repo's heaviest unit sweeps. Measured on this machine: isolated, 420 consecutive runs of this suite were clean (396 tests each); under `pnpm -w test`'s 109-task parallel graph, 5 runs in 23 failed, every one `Error: Test timed out in 5000ms.` and every one in this package. The slowest test with no budget of its own is `persisted-json-bound.test.ts`'s "EVERY BUDGET 100…900 …" at 3,548ms isolated — 1.4x headroom against the default — and it was observed at 5,259/5,582/5,651/5,745ms under the graph; `docker-adapter.test.ts`'s env-file 0600 case runs in 409ms isolated and was observed at 7,485ms.

THE PROPERTY, NOT THE INSTANCE: `persisted-json-budget-sweep.test.ts` — the sibling sweep, in the next file — ALREADY declared `}, 60_000)` per test. The same hazard was seen and bounded in one of the two places that had it, which is §4.4a's shape exactly. The class fix is `@scp/source-census`'s `test-budget-census.test.ts`: no package may run its unit suite on an implicit default.

30,000 is 8.5x the isolated worst case and 4x the worst load-inflated observation. It is headroom, not a slow-test licence: a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

AND ONE CONSEQUENCE THE `onTaskUpdate` ROUND MADE VISIBLE. With the yield above, the longest a worker's loop can stall is the longest single TEST — which this number bounds at 30,000ms, half the RPC deadline. The one exception is the very per-test override praised above: `persisted-json-budget-sweep.test.ts`'s `}, 60_000)` is EXACTLY the deadline, so that one test could in principle stall right up to it. That is what the setup file's `MAX_WORKER_STALL_MS` tripwire (45,000ms) exists to catch — it fires first, and with the cause on it. The override is left at its measured value rather than tightened by guesswork: it was observed at 27,829ms on the loaded CI runner and 11,969ms under the local graph.

### §432. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

## `packages/runner-launcher/vitest.integration.config.ts`

### §433. Docker-requiring integration layer

Docker-requiring integration layer (M23.1 phase 4). Mirrors `apps/server/vitest.integration.config.ts`'s and `@scp/plugin-managed-iac`'s `vitest.integration.config.ts` shape but has no Postgres/globalSetup dependency — this suite's only external dependency is a reachable Docker daemon (`DOCKER_HOST`, colima locally / native Docker in CI — see `reaper.integration.test.ts`'s own module doc). `singleFork` because the suite creates and removes real containers by a small, deliberately colliding set of names/labels — parallel workers racing each other's fixtures would be indistinguishable from a real reap bug.

## `packages/runner-launcher/vitest.kind.config.ts`

### §434. THE KIND LAYER

THE KIND LAYER (M23.2) — its own config, and the separation is the point.

`kubernetes-adapter.kind.test.ts` needs a real Kubernetes API server and FAILS rather than skips when there is none (see that file's header: a `skipIf` is how a gate becomes a green job that ran nothing). That is only safe if exactly one runner ever invokes it, so it lives behind its own `test:kind` script and its own include pattern, invoked by CI job 4e after `scripts/kind-runner-harness.sh up`. `vitest.config.ts` and `vitest.integration.config.ts` both exclude the pattern, so `pnpm test` and `pnpm test:integration` cannot reach it by accident.

`singleFork` for the same reason the Docker integration layer uses it: the suite creates and deletes real Jobs by a small, deliberately colliding set of names, and parallel workers racing each other's fixtures would be indistinguishable from a real teardown or reap bug.

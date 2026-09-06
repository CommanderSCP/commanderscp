# docker-adapter.test

Reference for `packages/runner-launcher/src/docker-adapter.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 9 of 31 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M23.1 PHASE 4

M23.1 PHASE 4 — THE REAPER'S OWN SIDE CHANNEL.
`reap()` now runs at the top of every `run()`, which means every test in this file that calls `run()` ALSO issues one more `execFile` — `docker ps -a --filter label=scp.launcher.owner` — and `create` now always carries two more `--label` pairs. Every existing assertion in this file pins `calls` as the LITERAL create/cp/start/rm sequence, so both of those would break every one of them for a reason unrelated to what each test is actually about. Both are therefore diverted into their OWN side channels here, verified by their OWN dedicated describe block below, and kept out of `calls` entirely — the same reasoning as `envFileSnapshots` above for the transient `--env-file` path: asserting on the stripped-out value in place would be asserting on nothing, so it is captured where it can still be seen and checked on its own terms.

## §2. PER-STEP FAILURE INJECTION

PER-STEP FAILURE INJECTION — the very object `execFile`'s callback is handed for that step, or absent for a step that succeeds.

IT IS AN ERROR OBJECT AND NOT A BOOLEAN ON PURPOSE, and that is the whole of what this knob fixed: the seam used to reject `start` with `new Error("container exited non-zero")` carrying nothing but `stdout`/`stderr`, so nothing in this file could tell "the runner exited non-zero" apart from "our own `timeout` fired and WE killed it" or "its output blew `maxBuffer`". Two mutations of the `succeeded = false` at `index.ts:227` therefore passed all thirty tests —

```text
  succeeded = false;  ->  succeeded = (err as { killed?: boolean }).killed === true;
  succeeded = false;  ->  succeeded = (err as { code?: string }).code === MAXBUFFER_CODE;
```

— which is the "verify the lever, not just the signal" class CLAUDE.md names: four tests assert that `timeout` and `maxBuffer` REACH the options object, and none asserted what happens when one of them FIRES. `NODE_FAILURE_SHAPES` fires them, on every step that can produce them.

## §3. THE OPTIONS, AS LITERALS

THE OPTIONS, AS LITERALS. Deliberately NOT imported from `index.ts` — an expectation re-derived from the code it guards cannot detect a change to that code. These three pairs are what the three callers pass TODAY (managed-iac / managed-scan / managed-dep).

## §4. A minimal, entirely explicit spec

A minimal, entirely explicit spec. Every test below overrides only what it is about.

`runId` IS A FIXED LITERAL, and `labels` EMPTY, so that the argv assertions stay readable and so that a spurious label is a visible extra pair rather than noise. The ordering substrate at the bottom overrides `runId` per run — two concurrent runs must not share a container NAME any more than they may share a container id, and the case that proves it needs distinct ones.

## §5. THE FOURTH COMBINATION

THE FOURTH COMBINATION. No real caller pairs these two — managed-iac is `{always, swallow}`, managed-scan and managed-dep are both `{on-success, propagate}` — so nothing above this test ever constructs `{on-success, swallow}`, and it was never asserted anywhere in this file. `onFailure` decides what happens to a FAILED copy-out call; `when` alone decides whether the copy is issued at all. A gate that checked `copyOut.onFailure === "swallow"` instead of `copyOut.when === "always"` would pass every other case in this describe — none of them pairs "swallow" with "on-success" — and would copy evidence out of a run this caller explicitly asked to treat as fail-closed, breaking the exact property `index.ts`'s file header names.

## §6. THE LEVERS, FIRED

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

## §7. WHAT SURVIVES THE WRAP

WHAT SURVIVES THE WRAP. Since the argv-leak fix these arms can no longer assert `rejects.toBe(err)` — the adapter never rethrows the original, precisely so `err.message`'s `Command failed: docker create … -e AWS_SECRET_ACCESS_KEY=…` cannot cross the plugin-host RPC boundary. That makes it possible to LOSE the diagnosis while looking correct, so this asserts the opposite direction: the wrapper is a `RunnerLaunchError` for the right STEP, and Node's own `code`/`killed`/`signal` and the original's own words all came across. A wrapper that dropped them would turn "our own timeout SIGTERM'd it" into an indistinguishable blank, which is the whole reason the shapes table exists.

## §8. FOUND BY MUTATION, NOT BY READING

FOUND BY MUTATION, NOT BY READING. Dropping `redact()` from the SUCCESS arm of `start` survived the whole suite: every secret case above drove a FAILURE, so the one path a real `tofu plan` takes every day was the one path with no assertion on it. A provider that echoes its own credential into a plan summary — or a runner that prints its environment on `--debug` — lands in `RunnerResult.stdout`, which the plugins put straight into a Decision (charter principle 6).

## §9. M23.1 PHASE 4

M23.1 PHASE 4 — THE REAPER. See `RunnerLauncher.reap`'s own doc in index.ts for the defect this closes, and `reaper.integration.test.ts` for why THIS suite (mocked `execFile`, no real Docker daemon) cannot be the proof: it cannot show that a killed process leaves a container behind, that a label survives on it, or that a real `docker ps --filter` actually finds it. What it CAN prove, cheaply and on every PR, is the shape of what `reap()` sends and the LOGIC of its predicate — exactly the two things a real-Docker test would be slow and awkward to drive through every branch of.

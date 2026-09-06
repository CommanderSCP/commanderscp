# test-budget-census.test

Reference for `packages/source-census/src/test-budget-census.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 7 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE PER-TEST BUDGET CENSUS

THE PER-TEST BUDGET CENSUS — NO UNIT SUITE MAY RUN ON A DEADLINE NOBODY CHOSE

WHAT WENT WRONG (M23.1f clause 6). `@scp/runner-launcher`'s unit suite failed roughly 1 run in 5 of `pnpm -w test` with `Error: Test timed out in 5000ms.` — vitest's IMPLICIT default, because that package's `vitest.config.ts` set `exclude` and nothing else. It failed **zero** times in 420 consecutive isolated runs of the same 396 tests, which is why eleven earlier passes could not measure it: isolation is the wrong load profile. What consumes the headroom is the 109-task parallel graph `turbo run test` builds, not the test.

WHY THIS IS A CENSUS AND NOT A ONE-LINE FIX. `apps/server/vitest.config.ts` had already raised its own budget to 20,000ms in 2026-08, for this exact reason, with the measurement written down beside it — and the other thirty-four packages were left on the default. The hazard was seen, correctly diagnosed, and fixed in one of the places that had it. That is §4.4a's shape and CLAUDE.md's incomplete-call-site-census property, so the deliverable is the rule, not the number.

THE RULE. Every package whose `test` script runs vitest must DECLARE `testTimeout` in the config that script loads, and the declared number must be one this file's table names. Both directions are checked: a package that declares nothing fails, a package that declares a number nobody reviewed fails, and a table entry for a package that no longer exists fails.

WHAT THIS DOES NOT COVER, SAID PLAINLY. A **per-test** override (`it(..., 10_000)`) is an explicit declaration and passes this gate by construction; it can still be too small under load, and one was — `apps/server/src/governance/cel-sandbox.test.ts` timed out twice at 10,017ms under the same parallel graph while its package budget was 20,000. That is a chosen number being wrong, not a number nobody chose, and it is fixed at the site rather than gated here. Nor does this gate say anything about `test:integration` / `test:kind` configs — all five of those already declare a budget, and they are checked below only for staleness of that claim.

WHY IT LIVES IN `@scp/source-census`. Same reason `test-script-census.test.ts` does: this package is the repo's census-over-its-own-tracked-source utility, and it reads `git ls-files` rather than walking directories so `node_modules` and build output can never enter the set.

## §2. THE REVIEWED BUDGETS

THE REVIEWED BUDGETS. A package may not simply pick a number: it must pick one of these, so the set of budgets in the repo is readable in one place instead of being spread over 35 files.

- 20,000ms — the default for a package with no measured hot spot. Chosen to match `apps/server`, whose number was derived from a real measurement (v8 coverage instrumentation pushing real-cryptography tests from ~500ms to ~5,100ms, straddling the 5s default and flaking about 1 run in 4). - 30,000ms — `@scp/runner-launcher` only. Its slowest test with no budget of its own is 3,548ms isolated and was observed at 5,745ms under the parallel graph; `docker-adapter.test.ts`'s env-file case is 409ms isolated and was observed at 7,485ms — an 18x load factor. 30,000 is 8.5x the isolated worst case and 4x the worst load-inflated observation.

## §3. The same reader for `hookTimeout`

The same reader for `hookTimeout`. Deliberately a SECOND function rather than a parameterised one: the two options have different defaults (5,000ms vs 10,000ms), different tables and different reasons, and a shared reader is the kind of convenience that makes one of them silently inherit the other's verdict.

## §4. THE SECOND DEADLINE NOBODY DECLARED

THE SECOND DEADLINE NOBODY DECLARED — vitest's 60,000ms worker->main RPC timeout

WHAT WENT WRONG (the round after the one above). CI job 4 failed `@scp/runner-launcher#test` with `17 passed / 429 passed / 1 error` and `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`. No assertion was wrong. `onTaskUpdate` is the worker->main RPC carrying test results, and birpc arms a 60,000ms timer on every such CALL. That constant is compiled into vitest's bundle and vitest passes no override from `getRpcOptions()`, so unlike `testTimeout` above it CANNOT be declared — it is a ceiling every suite lives under whether or not it knows.

WHAT CROSSES IT is not a slow test but a STARVED WORKER: a file of purely synchronous tests never lets its event loop reach the poll phase, so the main thread's reply — sent in milliseconds — cannot be read. Measured: 63s of synchronous blocking fails with no load and no coverage; the same 63s with one macrotask yield per test is clean, and so is 126s.

SO THE DECLARABLE THING IS THE YIELD, AND THIS IS WHERE IT IS DECLARED. A package whose suite yields between tests can stall at most one TEST, which `testTimeout` above already bounds; a package that does not is bounded by its whole FILE, a number that grows with every property added and is measured on a machine nobody controls.

THE CLASS IS NOT PACKAGE-SPECIFIC, AND THE FIRST CENSUS THAT SAID OTHERWISE WAS WRONG. Ranking every per-file duration in the failing CI job put two files near the ceiling, both in `@scp/runner-launcher` (62,948ms and 27,832ms), with the next-heaviest at 12,714ms — a 4.7x margin. That ranking was then USED AS A PREDICTION, and the prediction failed: driving the whole workspace under a deliberately excessive local load (a 16-spinner CPU flood on top of the turbo graph, several times CI's), `@scp/plugin-managed-scan` produced the identical `Timeout calling "onTaskUpdate"` — from `scanner-containment.test.ts`, which had measured 2,481ms on CI, a 24x margin. Its "NO product code outside apps/runner-scan EXECUTES a scanner binary" arm — a synchronous `git ls-files` sweep that reads every tracked file — took 109,591ms there. A CI duration is one load profile, and an I/O-heavy synchronous sweep degrades far harder under contention than a pure-CPU one: 44x against runner-launcher's 14x.

SO WHY IS THIS STILL A TABLE. Because at that same load the run failed FOUR OTHER WAYS that no amount of yielding addresses — `@scp/airgap` on its chosen 20,000ms budget, `@scp/cli` twice on its chosen 30,000ms hook budgets, and `@scp/runner-launcher` itself on a 129,783ms stall in MODULE LOAD, a window a between-tests yield cannot reach. Of five runs at a load CI does not apply, wiring every package would have changed exactly one. The load is the dominant lever and it is fixed where it belongs, in `.github/workflows/ci.yml`; the yield is the structural one and is declared per package here.

WHAT GENERALISES is therefore the RULE and the TRIPWIRE, not a preemptive edit to 36 configs: a package that grows a heavy synchronous sweep adds itself below, and `MAX_WORKER_STALL_MS` inside the setup file fires at 45,000ms — with the cause written on it — before the deadline does. That tripwire is not theoretical either: it is what named the 129,783ms module-load stall above, in a run whose only other symptom was "429 passed, 1 error".

## §5. THE HOOK BUDGET

THE HOOK BUDGET — THE OTHER HALF OF THE SAME CENSUS, AND IT WAS LEFT UNDONE

WHAT THE FIRST HALF MISSED. Everything above is about `testTimeout`. `hookTimeout` is a SECOND, INDEPENDENT deadline with its own implicit default (10,000ms, not 5,000ms), and the census that fixed the first one did not look at it. Measured on this tree, filterless, over every tracked `vite*.config.*` in the repo — 43 files, of which 36 are the unit configs a `test` script loads:

```text
- 36 of 36 unit configs declared NO `hookTimeout`. Every `beforeAll`/`beforeEach`/`afterAll`/
  `afterEach` in the unit layer — 159 call sites across 23 of those 36 packages — ran on a
  number nobody chose.
- All 6 non-unit configs (the five integration ones and the kind one) DID declare it, at
  60,000 / 120,000 / 300,000 / 600,000ms. So the option was known, deliberately set where a
  container start made it obvious, and left implicit everywhere else. That is CLAUDE.md's
  incomplete-call-site-census property again, in the same file that was written to close it.
```

THE HAZARD IS NOT HYPOTHETICAL AND THE REPO ALREADY PAID FOR IT. `@scp/cli`'s three CLI-warm-up hooks exist because a lazy `import("./cli.js")` cost ~0.3s warm and **5,400ms on a cold CI runner** — an 18x load factor — and the fix was to move that cost OUT of a test and INTO a hook, reasoned in `outpost-reconcile-precondition.test.ts` as "hooks get vitest's separate `hookTimeout` (10s)". 5,400 of 10,000 is 1.9x of margin on the one hook cost this repo has ever measured on CI. All three sites then wrote `}, 30_000)` at the call site anyway — the authors did not trust the default either, three times, and still nobody moved the package-level knob.

WHAT `hookTimeout` DOES *NOT* REACH, SAID PLAINLY, BECAUSE IT IS EASY TO ASSUME OTHERWISE. It governs `beforeAll`/`beforeEach`/`afterAll`/`afterEach` only. It does NOT govern `globalSetup`: vitest awaits that with no timer at all (`await globalSetupFile.setup?.(this)`, main process), so `apps/server`'s Testcontainers Postgres + template migration — measured at **5,384ms** here, warm image, idle machine — is not on a 10,000ms budget, it is on no budget. Nor does it govern `setupFiles`, nor the kind cluster, which `scripts/kind-runner-harness.sh up` creates outside vitest entirely (`kubernetes-adapter.kind.test.ts`'s `beforeAll` only READS the harness file). Those are worth stating because a gate that claims to bound them would be false comfort.

THE RULE, IDENTICAL IN SHAPE TO THE ONE ABOVE. Every package whose `test` script runs vitest must DECLARE `hookTimeout`, and the declared number must be one this file's table names; every non-unit config must declare the number ITS table names. Both directions, both layers.

## §6. THE REVIEWED UNIT HOOK BUDGET

THE REVIEWED UNIT HOOK BUDGET. One number, because the measurement supports one.

MEASURED, isolated, over every unit suite in the repo (a custom vitest reporter recording `onHookStart`->`onHookEnd`, 2026-08-23, this machine): the slowest hook in the whole unit layer is 1,205ms (`packages/runner-launcher/src/port-deadline.test.ts`'s `afterEach`), the next 926ms (`no-spawn-on-kubernetes.behaviour.test.ts`'s `beforeAll`, an incremental `tsc -b`), the next 268ms. 75 of 79 hooks that cost more than 1ms cost under 270ms.

MEASURED ON CI, and this is the number that actually sets the budget: `@scp/cli`'s CLI-warm-up `beforeAll` was 5,400ms on a cold runner against ~0.3s warm. It is the only hook cost this repo has measured under CI's load profile, and it is 18x its warm figure.

30,000ms is 25x the isolated worst case and 5.5x that cold-runner observation, and it is the number the three `@scp/cli` sites independently arrived at for exactly this hazard.

WHY NOT 20,000 — the default on the `testTimeout` side. 20,000 is 3.7x the 5,400ms cold-runner figure, against load factors this repo has already measured at 14x, 18x and 44x. Reusing it because it is there is how a table becomes decoration.

WHY NOT MORE THAN 30,000. `WORKER_RPC_DEADLINE_MS` above, unchanged: a purely synchronous hook starves the worker exactly as a synchronous test does, and a budget at or above 60,000 lets one cross the un-declarable `onTaskUpdate` deadline — a failure that names no test and reports every test as passing. 30,000 is half of it, matching the per-test budget's own ceiling argument.

## §7. The non-unit hook budgets

The non-unit hook budgets. Unlike the unit layer these were already declared; they are named here so a future config cannot double one silently, and each is checked BOTH ways.

They are legitimately far above the unit ceiling and above `WORKER_RPC_DEADLINE_MS`, for a reason that does not apply upward: these hooks AWAIT real containers and images (`docker pull`, a Postgres start, a Trivy DB preload). Awaiting I/O yields the worker's event loop every tick, so the RPC-starvation argument that caps the unit budget has no purchase here. A synchronous sweep appearing in one of these hooks would be a defect regardless of the number beside it.

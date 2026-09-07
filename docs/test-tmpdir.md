# test-tmpdir

Long-form reference for the **test-tmpdir** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 11 of 11 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/test-tmpdir/src/guard-outside-test.test.ts`](#packages-test-tmpdir-src-guard-outside-test-test-ts) — §1–§2
- [`packages/test-tmpdir/src/index.test.ts`](#packages-test-tmpdir-src-index-test-ts) — §3–§4
- [`packages/test-tmpdir/src/index.ts`](#packages-test-tmpdir-src-index-ts) — §5–§9
- [`packages/test-tmpdir/vitest.config.ts`](#packages-test-tmpdir-vitest-config-ts) — §10–§11

## `packages/test-tmpdir/src/guard-outside-test.test.ts`

### §1. THE REFUSING HALF of `assertInsideTest` (index.ts)

THE REFUSING HALF of `assertInsideTest` (index.ts) — the guard that turns "per-test allocator used on a `beforeAll` fixture" from a green suite plus a leaked directory into a loud throw.

WHY A WHOLE FILE. The condition being asserted is "there is no current test", which is true at module top level and inside `beforeAll` — and a throw from either of those ABORTS the file instead of asserting anything, so the misuse cannot be driven from where it really happens. Stubbing is the only way to present that condition inside an `it()`, `vitest/suite` is a frozen ESM namespace (measured: `Object.defineProperty` on it throws "Cannot redefine property"), and `vi.mock` is MODULE-SCOPED — it would disable the guard for every test in whatever file it appears in. Hence the split: the silent half is `index.test.ts`'s whole body, this is the loud half.

### §2. This file sweeps its own fixture; the allocator cannot

THIS FILE SWEEPS ITS OWN FIXTURE, and cannot delegate that to the allocator it is testing.

`index.ts` registers its `afterEach`/`afterAll` sweeps at MODULE LOAD. Every `it()` below imports it with a DYNAMIC `await import("./index.js")` — deliberately, so the `vi.mock` above is in place first — which means those hooks are registered while the file is already RUNNING, after vitest finished collecting this file's hooks. They therefore never fire, and the one directory the third case legitimately creates survived the run: the repo's own tmpdir-leak gate caught it on CI (`scp-test-tmpdir-selftest-guard-*`) while a local run missed it, because turbo replayed this package from cache rather than executing it.

That is the same shape as the defect the guard exists to catch — a cleanup that is registered and does not run — one level further in: here it is the SWEEP itself that was never installed. So the sweep here is explicit and local, and depends on nothing that has to be imported early.

## `packages/test-tmpdir/src/index.test.ts`

### §3. The real assertion here is cross-test

The real assertion here is cross-test: a directory created in one `it()` must be gone by the time the NEXT `it()` runs, because that is exactly the property `managed-trigger-budget.test.ts` needed (cleanup between tests in the same file, not only at the end of the file) — see this package's `index.ts` module doc for why `afterEach` and not `afterAll`.

### §4. POSITIVE CONTROL FOR `assertInsideTest`

POSITIVE CONTROL FOR `assertInsideTest` (index.ts). Every `it()` above calls the per-test pair from inside a running test, which is the case the guard must stay SILENT for — so a guard that threw unconditionally, or whose `getCurrentTest()` detection broke and reported "no test" always, reds this file rather than passing quietly. The refusing half is driven in `guard-outside-test.test.ts`, which needs its own file because stubbing `vitest/suite` is module-scoped.

## `packages/test-tmpdir/src/index.ts`

### §5. One temp directory a test never has to remember to clean

THE ONE PLACE A TEST FILE MAKES A TEMP DIRECTORY IT DOES NOT HAVE TO REMEMBER TO CLEAN UP.

WHAT WENT WRONG (CLAUDE.md "Census by property, not by symptom"). A repo-wide census found mkdtemp/mkdtempSync called directly from `node:fs`/`node:fs/promises` in dozens of test files. Most paired it with a correct `try/finally` or `afterEach` `rm(dir, { recursive: true, force: true })` — but the PROPERTY that makes a leak possible is not "this file forgot to write a cleanup line", it is "cleanup is opt-in and invisible at the call site" — nothing at `mkdtemp(...)` itself says whether the three lines below it exist. Two real instances shipped with none at all (a plugin conformance-suite fixture whose factory runs once per `it()`, `@scp/plugin-testkit`'s `runExecutorConformanceSuite`, plus a couple of hand-written test files), and 463 directories were sitting on the author's machine, unnoticed, at the time this was found — each rediscovery got hand-swept and the property shipped again.

THE FIX MAKES CLEANUP NOT A SEPARATE STEP. `mkdtempTracked*` allocates the directory AND registers its removal in the same call — there is no second line to forget, and nothing to keep in sync with a variable name. Call it once per directory a test needs; that is the whole API.

TWO LIFETIMES, BECAUSE THE REPO GENUINELY HAS BOTH. Most call sites make a fresh directory per `it()` — those want `mkdtempTracked`/`mkdtempTrackedSync`, swept in `afterEach`. A few build ONE directory in `beforeAll` and share it read-only across every test in the file (a fake binary's shim dir, a fixture root) — those want `mkdtempTrackedForFile`/`mkdtempTrackedForFileSync`, swept once in `afterAll`. Using the per-test pair on a `beforeAll` fixture would delete out from under test 2 the moment test 1 finishes; that failure mode is exactly why this is a named choice at the call site instead of one function guessing from where it was called.

WHY `afterEach` (not `afterAll`) IS THE RIGHT DEFAULT. A leaked directory from test N should not survive to be blamed on test N+1's failure, and — more concretely — the reproduction of the ENOTEMPTY race in `managed-trigger-budget.test.ts` depended on cleanup running BETWEEN tests in the same file, not only at the very end. `afterAll`-only cleanup by default would have hidden that race, not fixed it — which is why it is the named, opt-in exception here, not the default.

WHY THIS IS SAFE TO IMPORT FROM ANY TEST FILE WITHOUT SETUP. Both hooks are registered ONCE, at MODULE LOAD (below) — never lazily on first call: an `afterEach`/`afterAll` added later, from inside a running `it()`, still gets called eventually but is NOT guaranteed to run at the right boundary (measured — it silently missed exactly that boundary here first; see git history if this file ever grows a "lazy register on first call" variant again, and revert it). The registration is MODULE-SCOPED — safe because every vitest config in this repo runs with the (vitest 3 default) `isolate: true`, so each test FILE gets its own fresh module registry (`vitest.integration.config.ts`'s own doc comment measured and pinned this). A file that imports this but calls neither pair still pays two empty `Promise.all`s per file — negligible.

### §6. WHY THE PER-TEST PAIR REFUSES TO RUN OUTSIDE A TEST

WHY THE PER-TEST PAIR REFUSES TO RUN OUTSIDE A TEST — the doc above already NAMED this hazard ("using the per-test pair on a `beforeAll` fixture would delete out from under test 2"), and it shipped anyway, silently, in the same round that wrote the warning. CLAUDE.md: a well-written comment naming a hazard is a signal to sweep, not evidence it was handled.

WHAT IT ACTUALLY COST (measured 2026-08-23, `executor-ref-prior-state-bound.integration.test.ts`, a fully green 888-test run). `mkdtempTracked` in `beforeAll` put the fixture directory on the PER-TEST list. The module `afterEach` deleted it after arm 1 — taking the live fake-executor's `fake-executor-state.json` with it — and then `fake-executor`'s next persist re-created the directory (`packages/plugins/fake-executor/src/index.ts`: `mkdir(dirname(statePath), {recursive: true})` before every write). The re-created directory is on NO list, so nothing removes it: the repo's own tmpdir-leak gate caught it on disk at the end of the run. So the visible symptom was a leak, but the SILENT one was worse — every test after the first ran against an executor whose durable run registry had just been wiped, which is precisely the "unknown run ⇒ answer pending" branch that file exists to rule out.

`getCurrentTest()` is `undefined` at module top level and inside `beforeAll`/`afterAll`, and is set for `beforeEach` and `it` (measured on vitest 3.2.7 — a probe printed both, in all five positions). That is EXACTLY the boundary the two lifetimes are named after, so the wrong choice is now a loud throw at the call site instead of a green suite and a directory on disk.

### §7. A tracked temp directory one test owns, swept afterEach

`fs.promises.mkdtemp(prefix)`, tracked: removed automatically in the module-level `afterEach` above — use this for a directory one `it()` owns. `prefix` is passed straight through — pass `path.join(os.tmpdir(), "scp-whatever-")` exactly as you would to the raw `mkdtemp`.

### §8. A shared temp directory for a file, swept afterAll

Like `mkdtempTracked`, but for a directory a `beforeAll` builds once and every `it()` in the file shares — removed in the module-level `afterAll` above instead of after each test. Using the per-test pair here would delete the directory out from under the second test the moment the first one finishes.

### §9. Escape hatch: remove a tracked directory early

Escape hatch for the rare test that needs to assert ON the directory's removal itself (or otherwise wants it gone before its own `afterEach`/`afterAll` runs) rather than waiting for the automatic sweep. Safe to call on a directory either tracked pair already tracks — the automatic sweep silently no-ops on a path that is already gone.

## `packages/test-tmpdir/vitest.config.ts`

### §10. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

This package arrived on a branch that forked before the budget census existed, so it shipped with no config at all and ran on vitest's implicit 5,000ms default — the exact omission the census exists to catch, reintroduced by a merge rather than by an edit. That is worth noting: a gate over "every package" is only as complete as the set of packages at the moment it runs, and a branch merged in afterwards is a package the gate never saw.

20,000ms, matching every sibling that does not need 30,000. See the census table in `@scp/source-census`'s `test-budget-census.test.ts` for why the number is declared and not inherited.

### §11. The hook budget: a second deadline nobody chose by default

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

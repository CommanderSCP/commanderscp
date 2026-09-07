# source-census

Long-form reference for the **source-census** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 40 of 40 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/source-census/src/ci-gate-census.test.ts`](#packages-source-census-src-ci-gate-census-test-ts) — §1–§1
- [`packages/source-census/src/coverage-census.test.ts`](#packages-source-census-src-coverage-census-test-ts) — §2–§2
- [`packages/source-census/src/documented-claim-gate.test.ts`](#packages-source-census-src-documented-claim-gate-test-ts) — §3–§6
- [`packages/source-census/src/golden-count-gate.test.ts`](#packages-source-census-src-golden-count-gate-test-ts) — §7–§8
- [`packages/source-census/src/hash.test.ts`](#packages-source-census-src-hash-test-ts) — §9–§9
- [`packages/source-census/src/hash.ts`](#packages-source-census-src-hash-ts) — §10–§12
- [`packages/source-census/src/index.ts`](#packages-source-census-src-index-ts) — §13–§14
- [`packages/source-census/src/spawn-observer.ts`](#packages-source-census-src-spawn-observer-ts) — §15–§17
- [`packages/source-census/src/test-budget-census.test.ts`](#packages-source-census-src-test-budget-census-test-ts) — §18–§29
- [`packages/source-census/src/test-script-census.test.ts`](#packages-source-census-src-test-script-census-test-ts) — §30–§32
- [`packages/source-census/src/tracked.ts`](#packages-source-census-src-tracked-ts) — §33–§33
- [`packages/source-census/src/ts.ts`](#packages-source-census-src-ts-ts) — §34–§38
- [`packages/source-census/vitest.config.ts`](#packages-source-census-vitest-config-ts) — §39–§40

## `packages/source-census/src/ci-gate-census.test.ts`

### §1. THE GATE-REACHABILITY CENSUS

THE GATE-REACHABILITY CENSUS — EVERY CI JOB EITHER BLOCKS MERGE OR IS NON-GATING BY NAME

WHAT WENT WRONG, TWICE, AND WHAT ALMOST WENT WRONG A THIRD TIME. `main` branch protection requires exactly two checks: "5z. Integration (aggregation gate)" and "3. Codegen drift". Every other job blocks merge ONLY by being reachable from 5z's `needs:` closure — 5z treats any non-success (skips included) as a failure, so a job in the closure that reds or is skipped reds 5z. That reachability was HAND-MAINTAINED and it has already failed silently: job 4b (helm-verify) sat reachable from nothing for weeks while its own comment claimed it gated (ci.yml's CORRECTION note), and the 2026-08-31 needs-graph restructure moved static-checks/unit-tests from transitive coverage (via the shard matrix) to hand-listed entries in 5z's `needs:` — where forgetting one would have dropped it from branch protection with every check still showing green in the PR list. ci.yml's comment on that list says "REMOVE A NAME FROM THIS LIST AND IT LEAVES BRANCH PROTECTION"; this census is that sentence made machinery.

THE RULE, BOTH DIRECTIONS. Every job in ci.yml must be reachable from 5z (in its `needs:` closure, walked upward — a needed job's own needs also gate, because their failure skips it and a skip is a failure at 5z), OR be named in NON_GATING with its documented reason. An allowlist entry that becomes reachable, or names a job that no longer exists, is stale and fails. And every job 5z `needs:` must ALSO appear in its result-check loop — `if: always()` means 5z runs regardless, so a needs entry the loop never reads is a job whose failure 5z silently ignores.

THE LIMIT, STATED PLAINLY (this package's rule): this census reads the WORKFLOW, not GitHub's settings. It cannot see branch protection itself — if the required-check names change on the GitHub side, or protection is disabled, nothing here reds. The two required names are asserted against the jobs' `name:` fields below so a rename in ci.yml (which would orphan the protection rule) is at least caught on this side.

## `packages/source-census/src/coverage-census.test.ts`

### §2. THE COVERAGE-ENABLEMENT CENSUS

THE COVERAGE-ENABLEMENT CENSUS — A THRESHOLD ONLY GATES WHEN COVERAGE IS ACTUALLY COLLECTED

WHAT WENT WRONG, TWICE. BUILD_AND_TEST.md §7 once claimed "≥80% unit coverage" while no config declared a threshold and `pnpm test` ran bare — aspiration presented as policy (the 2026-08-01 owner decision fixed that by adding thresholds to the two app configs). CI then enforced them by appending `-- --coverage` to `pnpm test`, which worked — but anything after turbo's `--` is folded into the hash of EVERY task in the graph, so all 38 `:build` tasks missed cache and re-executed inside the unit-test job (measured 2026-08-31: @scp/server#build finished at t+162s of that step, delaying the package's own suite by exactly that). The fix moved enablement into the configs themselves — CI-conditional, see below — which un-busts the cache while keeping local behaviour exactly what it was.

THE HOLE THAT LEAVES OPEN, AND WHAT THIS FILE CLOSES. A vitest threshold only fails a run when coverage is actually collected. With no `--coverage` on the CI command line, the next config to declare `thresholds` WITHOUT enabling collection would be decorative from the day it lands — green in CI, never once measured — which is precisely the state §7 was in before 2026-08-01. So the rule, both directions: a config that declares `coverage.thresholds` must declare EXACTLY `enabled: process.env.CI === "true"` (CI-conditional, not a bare `true`, because an unconditional enable gates FILTERED local runs against whole-package floors — measured: one apps/web file run reports 11.55% against the 38% floor and exits 1; the exact literal is pinned so a well-meaning variant cannot drift into either failure mode), and the census must actually find the configs known to gate today (non-vacuity — an empty census passes every "this set is empty" assertion for free). The distinctive literal also keeps `typecheck: { enabled: true }` — the same line shape in a different vitest block — from satisfying this check by accident.

WHY IT LIVES IN `@scp/source-census`: same as its siblings — this package is the repo's census-over-tracked-source utility, reading `git ls-files` so node_modules and build output can never enter the set, and reading config SOURCE rather than importing it (importing executes `defineConfig` and every plugin the config pulls in).

## `packages/source-census/src/documented-claim-gate.test.ts`

### §3. THE DOCUMENTED-CLAIM GATE

THE DOCUMENTED-CLAIM GATE — FOUR FALSE STATEMENTS IN ACCEPTED DOCS, FOUND BY ONE PASS

WHAT HAPPENED. M23's final verification pass read the Accepted and operator-facing documents against the code on disk and found FOUR statements that were measurably false, none of them a typo and all of them load-bearing:

```text
- `deploy/helm/README.md` described the collapsed `pods`/`pods/log` verb list and the `watch`
  that M23.6 had removed — the only present-tense falsehood of its kind in the tree, written by
  the commit that introduced the section and never touched by the narrowing.
- `deploy/airgap/assets/install.sh` told air-gapped operators "helm — there is NO lever", "the
  plugins have no Kubernetes-native launch mode yet" and "`SCP_MANAGED_SCAN_RUNNER_IMAGE` has no
  chart value at all". All three had been false since M23.2/M23.4, and the same commit that made
  them false rewrote the OUTPUT block ninety lines below and left the comment. This is the
  expensive one: it is read where re-checking a claim costs a courier run. A SECOND stale
  comment in the same file said the same thing and directly contradicted the block beneath it —
  found only because the first was.
- `docs/adr/0035-*.md`'s Status still said two shipped milestones were "(pending)".
- `docs/BUILD_AND_TEST.md` asserted in the present tense that all three managed executors shell
  out to a Docker CLI and that "there is no second launch path behind an interface", with three
  line-number citations pointing at unrelated code. Its SIBLING bullet carried a SUPERSEDED
  marker; this one did not, which is the whole reason it survived four passes.
```

FOUR IN ONE PASS IS NOT FOUR MISTAKES — IT IS AN UNGATED SURFACE. Nothing in this repository ever read a sentence of prose and compared it to a measurement, with one exception (`golden-count-gate`, added after the SAME number was restated wrongly three times). So this file generalises that one exception into the two shapes that are actually gateable:

```text
(1) A NUMBER RESTATED IN PROSE. Every count a document quotes about a machine-checked sweep is
    read out of the CODE THAT PINS IT and compared. Six such numbers live across three files;
    every one of them was stale within one round of the sweep changing size, including the two
    this very milestone made stale by adding six matrix points.
(2) A CLAIM OF THE FORM "X DOES NOT EXIST" ABOUT SOMETHING THE REPOSITORY CAN LOOK UP. Whether
    a chart value exists, whether a call site exists. These go false silently and in one
    direction only: the code gains the thing, the sentence keeps denying it.
```

WHAT THIS CANNOT DO, STATED RATHER THAN IMPLIED. It cannot gate arbitrary prose — no test can decide whether a paragraph of reasoning is true. What it CAN do is make the specific load-bearing claims machine-checked and make the ledger itself impossible to drift: every entry pins an exact surrounding wording, so EDITING the sentence fails this file too and forces the entry to be updated deliberately rather than orphaned. A claim that leaves the ledger leaves it visibly.

### §4. The ledger: the wording is part of the key

THE LEDGER. Each entry is (file, a regex that pins the SURROUNDING WORDING and captures the number, the measurement). The wording is part of the key on purpose: a rewrite that drops the claim fails here rather than silently leaving an entry pointed at nothing.

### §5. The three plugin entry points and their bullet

THE THREE PLUGIN ENTRY POINTS, AND THE BULLET THAT DESCRIBES THEM. The claim was "all three managed executors launch a runner by shelling out to a Docker CLI … there is no second launch path behind an interface". It is checked in BOTH directions: while the count is zero the bullet must be marked SUPERSEDED, and if a plugin ever spawns for itself again the marker must come off — so this cannot be satisfied by deleting the code OR by deleting the sentence.

COMMENTS STRIPPED, and that is the load-bearing part. A raw read finds THREE `execFile` occurrences across these files and every one is prose explaining why `dockerBinary` is server-injected or what `promisify(execFile)` attaches to a rejection. A comment naming a hazard is a signal to sweep, never evidence it was handled (CLAUDE.md); counting one as a call site would make this gate report the opposite of the truth.

### §6. The installer's claims about what the chart cannot do

THE AIR-GAP INSTALLER'S CLAIMS ABOUT WHAT THE CHART CANNOT DO. Two things are checked. The retired sentences must not come back — each one was false for a full milestone and each is quoted here verbatim so a copy-paste revival is a red build. And every chart value the script NAMES as the lever must actually exist in `values.yaml`, which is the general form of the "`SCP_MANAGED_SCAN_RUNNER_IMAGE` has no chart value at all" mistake — a claim about existence, made about something this repository can simply look up.

## `packages/source-census/src/golden-count-gate.test.ts`

### §7. The golden count in prose, made a gate not a restatement

MEDIUM-5 — THE GOLDEN COUNT IN PROSE, MADE A GATE INSTEAD OF A THING RESTATED BY HAND
`docs/BUILD_AND_TEST.md`'s M23.0 bullet has stated the number of `launch-argv.golden.test.ts` cases across the three managed-executor plugins THREE times, and been wrong on at least two of them: - it said "Fourteen" when the true count (at the time) was fifteen (corrected by commit e72e629e, itself the ONLY one of the three corrections that actually re-measured); - it then said "Fifteen (4 iac + 6 scan + 5 dep)" for a full round afterward, including through a Phase 5 verification pass that reported the line as checked, while commit 39b387d2 had already added a sixth-then-fifth iac case and a later M23.1e round (bf608300) added a sixth — the true count by then was seventeen (6 iac + 6 scan + 5 dep).

A number in prose that three separate rounds each restated wrongly is a number that must stop living in prose. This file reads BOTH sides — the documented count and the actual `it(` count in the three golden files — and fails the moment they diverge, naming the exact mismatch rather than requiring a fourth human recount.

WHY `^\s*it\(`, MIRRORING THE MEASUREMENT THAT FOUND THE DEFECT. Counting top-level `it(` calls is the same method MEDIUM-5's own measurement used ("Counting `^\s*it(` in the three golden files"). `readStripped` (not a bare `readFileSync`) is used so a commented-out or described-but-deleted `it(` cannot inflate the count — see `@scp/source-census`'s own module doc for why that distinction is load-bearing rather than decorative.

PROVEN BY ADDING A CASE AND WATCHING IT REDDEN — that is this file's own DoD, not merely a claim about it: add a fixture `it(` to any of the three files below (or bump the documented count without touching a file) and this suite fails, naming the file and the two numbers that disagree.

### §8. Parses the bullet's own count, not its position

Parses the M23.0 bullet's own count out of `docs/BUILD_AND_TEST.md` — `<word> tests (<n> iac + <n> scan + <n> dep)` — rather than assuming its position. A doc restructure that drops or renames the bullet fails this HERE, naming what could not be found, instead of the count silently going unchecked.

## `packages/source-census/src/hash.test.ts`

### §9. NEGATIVE CONTROLS FOR THE `#`-LANGUAGE READERS

NEGATIVE CONTROLS FOR THE `#`-LANGUAGE READERS.

Every consumer of these helpers is a test that asserts something is PRESENT, and the whole class of bug being fixed is such a test passing when it should not. So the helpers themselves are proven to BITE — each case below is a real shape taken from the files that were measured false-green on 2026-08-17 (package doc), not an invented one.

## `packages/source-census/src/hash.ts`

### §10. `#`-comment sources: the TS stripper fails here silently

`#`-COMMENT SOURCE — Dockerfiles, shell, YAML, `pin.env`
`./ts.ts`'s `stripComments` is the WRONG TOOL here and fails silently: it knows `//` and slash-star only, so running a Dockerfile through it strips nothing and the census keeps counting commented-out lines as live. That was not hypothetical — it is what left the cosign, skopeo and scanner pin gates green with seven pins commented out (package doc, and the four measurements quoted there).

Two tools, because the sites need both and neither subsumes the other:

```text
`atLineStart`       — a PRESENCE matcher anchored to the start of a line. Strictly the
                            stronger of the two: a `#` prefix cannot satisfy it, and neither
                            can an occurrence buried in a TRAILING comment on a live line.
                            Use it whenever the thing asserted really does begin its line
                            (`ARG X=`, `COPY …`, `FROM …`, `d=…`, `exec …`, `KEY=value`).
`stripHashComments` — removes WHOLE-line comments and leaves everything else. Use it when
                            the text cannot be anchored: a token mid-line (`run: scripts/x.sh`
                            in a YAML step), or a shell/Dockerfile CONTINUATION line, where the
                            live line legitimately starts with `&&` or `\`.
```

DO NOT USE EITHER ON MARKDOWN. There `#` is a heading, and a `#`-line filter would delete the document's structure — silently, producing a false RED at best.

ONLY FOR PRESENCE ASSERTIONS. For an ABSENCE assertion (`expect(text).not.toMatch(…)`), a comment marker already makes the check strictly harder to pass, and anchoring would NARROW what counts as a violation — i.e. weaken the gate. Leave those reading the raw text, and say so where they are.

WHAT THIS STILL DOES NOT PROVE: everything in the package doc's list. Anchoring fixes the comment case and no more. A `#`-language census still passes over a stage nothing `COPY --from`s, a shell line behind a condition that is never true, a job disabled by an `if:` above it, and — since nothing here tracks quoting — the same text inside a heredoc or a quoted string.

### §11. `pattern`, re-anchored to the START of a line

`pattern`, re-anchored to the START of a line: leading whitespace is allowed, a `#` is not.

Accepts a literal string (escaped for you — the common case, replacing a `.toContain(…)` that a comment could satisfy) or a RegExp (whose capture groups survive, so an existing `/ARG\s+TRIVY_IMAGE=(\S+)/.exec(…)` keeps working unchanged apart from the wrapping). The returned RegExp always carries `m`, so `^` means "start of a line", not "start of the file".

The alternation trap this avoids: naively prefixing `^[ \t]*` to `/a|b/` yields `^[ \t]*a|b`, which anchors only the first arm. The pattern is wrapped in a NON-capturing group first.

### §12. `source` with whole-line `#` comments removed

`source` with whole-line `#` comments removed — what the build/shell/parser actually acts on.

A line counts as a comment when its first non-whitespace character is `#`. Blank lines and the line numbering are preserved (comments become empty lines) so a failure message still points at a plausible place in the real file.

IT DOES NOT REMOVE TRAILING COMMENTS. `RUN foo   # ARG COSIGN_IMAGE=sha256:…` survives whole, so a token that could plausibly appear after a `#` on an otherwise live line is NOT protected by this function — use `atLineStart` for those. Trailing comments are deliberately left alone because stripping them correctly needs shell quoting rules (`echo "a # b"` contains no comment), and a stripper that guesses would corrupt the very lines the census is asserting on.

## `packages/source-census/src/index.ts`

### §13. Shared machinery for reading this repo's own source

`@scp/source-census` — THE SHARED MACHINERY FOR READING THIS REPO'S OWN SOURCE IN A TEST

A "source census" is any test that reads a file of this repo as TEXT and asserts something about what it contains: that `main.ts` still starts a loop, that the root `Dockerfile` still pins the cosign the code asserts, that `install.sh` only prescribes env vars the server actually reads. They exist because the realistic regression is an edit that DROPS a line, and nothing else in the suite looks at a composition root, a Dockerfile or a shell script at all.

WHY THIS IS A PACKAGE AND NOT A FUNCTION IN WHOEVER NEEDED IT FIRST
It was, twice, and both copies were wrong in the same way. On 2026-08-17 a filterless census found TEN of these across four packages reading source as RAW TEXT — so a COMMENTED-OUT line satisfied them. Every one was measured passing over wiring that had been commented out, and the worst were the ones built to catch "component built, never installed", the failure class CLAUDE.md names as this codebase's dominant one:

```text
- `apps/server` — `bump-dispatch.test.ts` stayed green at 20/20, including a case named "the
  composition root actually wires it", with `startBumpDispatchLoop` commented out of `main.ts`;
  the whole unit suite stayed green at 972/972. Six siblings had it too.
- `deploy/airgap` — `cosign-bin.test.ts` and `skopeo-bin.test.ts` stayed green at 10 passed /
  1 skipped each with SEVEN pins commented out, including `ARG COSIGN_IMAGE=` at
  `Dockerfile:28`. Those gates exist so the runtime image cannot ship an unvetted binary.
- `deploy/airgap` — `bundle-images.test.ts` stayed green at 87/87 with the env var whose
  existence it verifies commented out of `executor-bindings-repo.ts`.
- `@scp/plugin-managed-scan` — `pin.test.ts` stayed green at 7/7 with `ARG TRIVY_IMAGE=` and
  `ARG OPENSCAP_IMAGE=` commented out of the scan runner's Dockerfile. Its oscap-version
  assertion was satisfied by two PROSE COMMENTS describing the check, so the check itself
  could be deleted outright.
- `@scp/plugin-managed-dep` — `runner-image.test.ts`, whose comment on the property was correct
  and whose `#`-line filter was right, still read `run.sh` raw for two assertions. A
  well-written note naming a hazard is a signal to sweep, not evidence it was handled.
```

The three packages could not share a fix because there was nowhere to put one, and `@scp/ plugin-testkit` — the only existing cross-package test utility — is scoped to PUBLIC per-plugin conformance suites an operator runs to vet a third-party plugin (see its module doc); internal repo-hygiene machinery does not belong in it, and neither `@scp/airgap` nor `@scp/server` is a plugin. Hence this package: small, private, dev-only, imported as a devDependency.

WHAT A SOURCE CENSUS CAN AND CANNOT PROVE — READ THIS BEFORE WRITING ONE, AND BEFORE BELIEVING ONE
The readers here buy EXACTLY ONE THING: the census stops mistaking a DESCRIPTION of code for code. They buy nothing else, and the temptation after fixing that is to believe the census is now sound. It is not. A source census is a grep with good manners. All of this still passes:

```text
1. DEAD CODE. The line is real, compiles, and is never reached — a function nobody calls, a
   branch behind `if (false)`, a module never imported, a Dockerfile stage never `COPY --from`ed.
   Text has no call graph.
2. A FALSE CONDITION. `if (config.enableX) startXLoop(...)` satisfies a census for `startXLoop(`
   while `enableX` is never true in any shipped configuration. This is the likeliest way a
   wiring census goes quietly wrong, because the code looks completely correct.
3. A STRING LITERAL. `stripComments` deliberately PRESERVES string and template contents
   (they are data, and eating them would corrupt the source), so `const doc = "call startXLoop()
   to begin"` still matches a census for `startXLoop(`. Stripping moved the hazard from comments
   into strings; it did not remove it. The `#`-language equivalent is a heredoc or a quoted
   shell string.
4. A CALL THAT DOES NOTHING. The composition root calls the starter and the starter's own body
   registers no worker. Measured, and recorded in `inventory-ingestion.test.ts`: deleting
   `startInventoryIngestionLoop`'s own `boss.createQueue`/`boss.work` left that file green.
5. THE WRONG ARGUMENTS. `toMatch(/startXLoop\(/)` cannot tell which db, host, queue or guard was
   handed over. A census that slices the call text out and inspects it narrows this, never closes it.
6. A SHADOW. A locally-declared `function startXLoop()` in the same file matches the text of a
   census aimed at the imported one.
```

SO: A SOURCE CENSUS PROVES A NECESSARY CONDITION, NEVER A SUFFICIENT ONE. It answers "does this file still say this, for real" — not "does this run in production". Only executing the thing does.

PAIR EVERY SOURCE CENSUS WITH SOMETHING THAT RUNS, and say in the test file which is which: - anything IMPORTABLE is asserted by RUNNING it, not by matching its text (M21.7 moved the router list out of `main.ts` into `events/domain-event-registry.ts` for exactly this reason); - an image's real contents are asserted by BUILDING it and asking the artifact (`runner-image.integration.test.ts`), which is the only thing that can see what the BASE brought in; - the BEHAVIOUR is an integration test that drives the real component and asserts an effect. The standing check from CLAUDE.md still governs and no census replaces it: DELETE THE WIRING AND WATCH A TEST DIE. If nothing goes red, the wiring is not covered — whatever the census says.

AN OVER-CLAIMING CENSUS IS HOW THIS BUG HAPPENED, so state the limit in the test file too, next to the assertion. A comment claiming a protection that does not exist is the hazard, not the documentation of one — `commander-only.test.ts` carried a note saying its census was "the one consumer still reading raw text" while six others were, and a reviewer who trusted it would have stopped looking.

### §14. Proving a census's blind spot, not just reading source

THE OTHER HALF OF THE SAME LESSON, AND THE REASON IT LIVES HERE. Everything above is machinery for reading source; `spawn-observer.ts` is machinery for proving a source census's blind spot is covered — that NO PROCESS WAS CREATED, observed from outside the code under test rather than inferred from its text. M23.6 clause 1 needed exactly that: a census over three plugins and one package stayed green in the only direction it could ever fail, while a planted `execFile` on the Kubernetes path spawned fourteen real processes and every ledger stayed empty.

## `packages/source-census/src/spawn-observer.ts`

### §15. Nothing was spawned, as a measurement not a census

`observeNodeSpawns` — "NOTHING WAS SPAWNED" AS A MEASUREMENT RATHER THAN AS A CENSUS

THE DEFECT THIS EXISTS FOR, MEASURED. M23.6 clause 1 is "no plugin spawns a Docker CLI on the Kubernetes path". What stood for it was two things, and neither could carry it:

```text
- A LEDGER inside `@scp/runner-launcher`: `spawnRunnerProcess` records the binary by name, and
  each managed plugin asserts the ledger is empty on the Kubernetes path. But the ledger only
  sees calls that go THROUGH it. A real `execFile(dockerBinary, ["version", …])` planted in
  `resolveRunnerLauncher`'s Kubernetes branch left all three ledger tests GREEN while fourteen
  spawns actually happened.
- A SOURCE CENSUS: `execFileAsync` must appear exactly twice in `index.ts`, the Kubernetes
  adapter must not name `execFile(`, no plugin may import `node:child_process`. That is a
  statement about TEXT. This repository has a named failure for reading text and calling it
  behaviour — `@scp/source-census` was created because ten such censuses were each measured
  green over wiring that had been COMMENTED OUT — and the same asymmetry applies here in its
  sharpest form: a census can prove a string is present; it can never prove an execution is
  absent, because the next spawn is written in whatever spelling the census does not hold.
```

SO THE OBSERVER SITS OUTSIDE THE SUBJECT. It runs the subject in a CHILD `node` with `test-support/spawn-observer-preload.cjs` `--require`d ahead of it (see that file for why a CJS preload is the only ordering that works, and for the `util.promisify.custom` trap that would otherwise have made this silently blind to the exact call `@scp/runner-launcher` makes). Every process creation is appended to a file as it happens. The assertion is then over WHAT THE PROCESS DID, not over what its source says — so a rename, an indirection, a dynamic `import()`, a helper in a new file, or a call site nobody censused all land in the same list.

WHY NOT AN INJECTABLE SPAWNER ON `RunnerLauncherConfig`, which the clause's own wording suggested. It was considered and rejected on the same grounds `index.ts` states for `dockerBinary`: that interface is the SERVER-INJECTED, never-tenant-settable plugin config surface, and a field naming an arbitrary callable is a new hole in exactly the surface a live RCE was already shipped through. It is also strictly WEAKER than this: an injected spawner is only consulted by code that chose to consult it, so the planted `execFile` above would have walked past it untouched — which is the same reason the ledger did not catch it. The cost of doing it this way instead is real and is named here rather than left to be discovered: each observed run is a fresh `node` process (~0.3–1.5s), the subject must be reachable as BUILT `dist` rather than through vitest's loader, and the driver script is a string rather than type-checked code.

COVERAGE, STATED. Every process-creating export of `node:child_process`, its promisified form, and `ChildProcess.prototype.spawn` beneath them all. NOT a native addon calling `posix_spawn` directly — see the preload's own note for why that is out of reach portably, and for the pinned census that keeps the wrapped set complete as Node changes.

### §16. The preload, resolved from the package root not this file

The preload, resolved from the PACKAGE ROOT rather than from this file's directory — `src/` and `dist/` are siblings, so one expression is correct whether this module is being run by vitest from source or imported as built output by another package's test.

### §17. Runs a module under the observer, never throwing

Run `module` in a child `node` under the spawn observer and report every process it created.

NEVER THROWS ON A NON-ZERO CHILD. A driver that crashed is a result the caller must be able to assert about — "the list was empty because the subject never ran" is the vacuity every caller of this function has to rule out for itself, and it can only do that if it can see `ok` and `stderr`.

## `packages/source-census/src/test-budget-census.test.ts`

### §18. THE PER-TEST BUDGET CENSUS

THE PER-TEST BUDGET CENSUS — NO UNIT SUITE MAY RUN ON A DEADLINE NOBODY CHOSE

WHAT WENT WRONG (M23.1f clause 6). `@scp/runner-launcher`'s unit suite failed roughly 1 run in 5 of `pnpm -w test` with `Error: Test timed out in 5000ms.` — vitest's IMPLICIT default, because that package's `vitest.config.ts` set `exclude` and nothing else. It failed **zero** times in 420 consecutive isolated runs of the same 396 tests, which is why eleven earlier passes could not measure it: isolation is the wrong load profile. What consumes the headroom is the 109-task parallel graph `turbo run test` builds, not the test.

WHY THIS IS A CENSUS AND NOT A ONE-LINE FIX. `apps/server/vitest.config.ts` had already raised its own budget to 20,000ms in 2026-08, for this exact reason, with the measurement written down beside it — and the other thirty-four packages were left on the default. The hazard was seen, correctly diagnosed, and fixed in one of the places that had it. That is §4.4a's shape and CLAUDE.md's incomplete-call-site-census property, so the deliverable is the rule, not the number.

THE RULE. Every package whose `test` script runs vitest must DECLARE `testTimeout` in the config that script loads, and the declared number must be one this file's table names. Both directions are checked: a package that declares nothing fails, a package that declares a number nobody reviewed fails, and a table entry for a package that no longer exists fails.

WHAT THIS DOES NOT COVER, SAID PLAINLY. A **per-test** override (`it(..., 10_000)`) is an explicit declaration and passes this gate by construction; it can still be too small under load, and one was — `apps/server/src/governance/cel-sandbox.test.ts` timed out twice at 10,017ms under the same parallel graph while its package budget was 20,000. That is a chosen number being wrong, not a number nobody chose, and it is fixed at the site rather than gated here. Nor does this gate say anything about `test:integration` / `test:kind` configs — all five of those already declare a budget, and they are checked below only for staleness of that claim.

WHY IT LIVES IN `@scp/source-census`. Same reason `test-script-census.test.ts` does: this package is the repo's census-over-its-own-tracked-source utility, and it reads `git ls-files` rather than walking directories so `node_modules` and build output can never enter the set.

### §19. THE REVIEWED BUDGETS

THE REVIEWED BUDGETS. A package may not simply pick a number: it must pick one of these, so the set of budgets in the repo is readable in one place instead of being spread over 35 files.

- 20,000ms — the default for a package with no measured hot spot. Chosen to match `apps/server`, whose number was derived from a real measurement (v8 coverage instrumentation pushing real-cryptography tests from ~500ms to ~5,100ms, straddling the 5s default and flaking about 1 run in 4). - 30,000ms — `@scp/runner-launcher` only. Its slowest test with no budget of its own is 3,548ms isolated and was observed at 5,745ms under the parallel graph; `docker-adapter.test.ts`'s env-file case is 409ms isolated and was observed at 7,485ms — an 18x load factor. 30,000 is 8.5x the isolated worst case and 4x the worst load-inflated observation.

### §20. Read the declared timeout from source, never by importing

Read the declared `testTimeout` out of a vitest config's SOURCE rather than by importing it. Importing would execute `defineConfig` and every plugin the config pulls in — which is how a census turns into a second copy of the build. The number is a literal in every config in this repo, and a config that computed it would fail here loudly rather than silently.

### §21. The same reader for `hookTimeout`

The same reader for `hookTimeout`. Deliberately a SECOND function rather than a parameterised one: the two options have different defaults (5,000ms vs 10,000ms), different tables and different reasons, and a shared reader is the kind of convenience that makes one of them silently inherit the other's verdict.

### §22. THE SECOND DEADLINE NOBODY DECLARED

THE SECOND DEADLINE NOBODY DECLARED — vitest's 60,000ms worker->main RPC timeout

WHAT WENT WRONG (the round after the one above). CI job 4 failed `@scp/runner-launcher#test` with `17 passed / 429 passed / 1 error` and `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`. No assertion was wrong. `onTaskUpdate` is the worker->main RPC carrying test results, and birpc arms a 60,000ms timer on every such CALL. That constant is compiled into vitest's bundle and vitest passes no override from `getRpcOptions()`, so unlike `testTimeout` above it CANNOT be declared — it is a ceiling every suite lives under whether or not it knows.

WHAT CROSSES IT is not a slow test but a STARVED WORKER: a file of purely synchronous tests never lets its event loop reach the poll phase, so the main thread's reply — sent in milliseconds — cannot be read. Measured: 63s of synchronous blocking fails with no load and no coverage; the same 63s with one macrotask yield per test is clean, and so is 126s.

SO THE DECLARABLE THING IS THE YIELD, AND THIS IS WHERE IT IS DECLARED. A package whose suite yields between tests can stall at most one TEST, which `testTimeout` above already bounds; a package that does not is bounded by its whole FILE, a number that grows with every property added and is measured on a machine nobody controls.

THE CLASS IS NOT PACKAGE-SPECIFIC, AND THE FIRST CENSUS THAT SAID OTHERWISE WAS WRONG. Ranking every per-file duration in the failing CI job put two files near the ceiling, both in `@scp/runner-launcher` (62,948ms and 27,832ms), with the next-heaviest at 12,714ms — a 4.7x margin. That ranking was then USED AS A PREDICTION, and the prediction failed: driving the whole workspace under a deliberately excessive local load (a 16-spinner CPU flood on top of the turbo graph, several times CI's), `@scp/plugin-managed-scan` produced the identical `Timeout calling "onTaskUpdate"` — from `scanner-containment.test.ts`, which had measured 2,481ms on CI, a 24x margin. Its "NO product code outside apps/runner-scan EXECUTES a scanner binary" arm — a synchronous `git ls-files` sweep that reads every tracked file — took 109,591ms there. A CI duration is one load profile, and an I/O-heavy synchronous sweep degrades far harder under contention than a pure-CPU one: 44x against runner-launcher's 14x.

SO WHY IS THIS STILL A TABLE. Because at that same load the run failed FOUR OTHER WAYS that no amount of yielding addresses — `@scp/airgap` on its chosen 20,000ms budget, `@scp/cli` twice on its chosen 30,000ms hook budgets, and `@scp/runner-launcher` itself on a 129,783ms stall in MODULE LOAD, a window a between-tests yield cannot reach. Of five runs at a load CI does not apply, wiring every package would have changed exactly one. The load is the dominant lever and it is fixed where it belongs, in `.github/workflows/ci.yml`; the yield is the structural one and is declared per package here.

WHAT GENERALISES is therefore the RULE and the TRIPWIRE, not a preemptive edit to 36 configs: a package that grows a heavy synchronous sweep adds itself below, and `MAX_WORKER_STALL_MS` inside the setup file fires at 45,000ms — with the cause written on it — before the deadline does. That tripwire is not theoretical either: it is what named the 129,783ms module-load stall above, in a run whose only other symptom was "429 passed, 1 error".

### §23. THE HOOK BUDGET

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

### §24. THE REVIEWED UNIT HOOK BUDGET

THE REVIEWED UNIT HOOK BUDGET. One number, because the measurement supports one.

MEASURED, isolated, over every unit suite in the repo (a custom vitest reporter recording `onHookStart`->`onHookEnd`, 2026-08-23, this machine): the slowest hook in the whole unit layer is 1,205ms (`packages/runner-launcher/src/port-deadline.test.ts`'s `afterEach`), the next 926ms (`no-spawn-on-kubernetes.behaviour.test.ts`'s `beforeAll`, an incremental `tsc -b`), the next 268ms. 75 of 79 hooks that cost more than 1ms cost under 270ms.

MEASURED ON CI, and this is the number that actually sets the budget: `@scp/cli`'s CLI-warm-up `beforeAll` was 5,400ms on a cold runner against ~0.3s warm. It is the only hook cost this repo has measured under CI's load profile, and it is 18x its warm figure.

30,000ms is 25x the isolated worst case and 5.5x that cold-runner observation, and it is the number the three `@scp/cli` sites independently arrived at for exactly this hazard.

WHY NOT 20,000 — the default on the `testTimeout` side. 20,000 is 3.7x the 5,400ms cold-runner figure, against load factors this repo has already measured at 14x, 18x and 44x. Reusing it because it is there is how a table becomes decoration.

WHY NOT MORE THAN 30,000. `WORKER_RPC_DEADLINE_MS` above, unchanged: a purely synchronous hook starves the worker exactly as a synchronous test does, and a budget at or above 60,000 lets one cross the un-declarable `onTaskUpdate` deadline — a failure that names no test and reports every test as passing. 30,000 is half of it, matching the per-test budget's own ceiling argument.

### §25. The non-unit hook budgets

The non-unit hook budgets. Unlike the unit layer these were already declared; they are named here so a future config cannot double one silently, and each is checked BOTH ways.

They are legitimately far above the unit ceiling and above `WORKER_RPC_DEADLINE_MS`, for a reason that does not apply upward: these hooks AWAIT real containers and images (`docker pull`, a Postgres start, a Trivy DB preload). Awaiting I/O yields the worker's event loop every tick, so the RPC-starvation argument that caps the unit budget has no purchase here. A synchronous sweep appearing in one of these hooks would be a defect regardless of the number beside it.

### §26. Per-hook overrides are named rather than absorbed

PER-HOOK OVERRIDES IN THE UNIT LAYER, NAMED RATHER THAN ABSORBED.

A `beforeAll(fn, 190_000)` is an explicit declaration and passes the config-level gate by construction, exactly as `it(..., 10_000)` does for `testTimeout`. That is a real hole in a gate that only reads configs, and in the unit layer it is small enough to close: there are four such sites in the whole repo, so they are listed, and a fifth appearing — or one of these changing — fails here. The integration layer's 97 overrides are deliberately NOT listed: they are the container-pull budgets the configs above already reason about, and enumerating them would be bookkeeping rather than a gate.

THE ONE THAT IS A FINDING, NOT A SETTING: `no-spawn-on-kubernetes.behaviour.test.ts` needs 190,000ms — 6.3x the reviewed maximum — because its `beforeAll` shells out to `npx tsc -b` with an inner 180,000ms subprocess timeout. It is a build in a hook. The budget is NOT raised to accommodate it (that would hand every other hook in the repo a 190s licence to hide in); it stays a site-local override with its cost written on it, and it is recorded here so it stays visible.

### §27. Every hook call site passing an explicit numeric timeout

Every hook call site in `source` that passes an explicit numeric timeout, e.g. `beforeAll(fn, N)`.

Brace/paren matching rather than a regex over the closing line, because `}, 60_000);` also ends an `it(...)` and a `describe(...)`, and a census that cannot tell them apart is a census of the wrong thing. Strings, template literals and comments are skipped so a `")"` inside one cannot close the call early.

ANCHORED TO LINE START, for the same reason `declaredTimeoutMs` is: a REGISTRATION always begins its line (indented inside a `describe` or not), and a MENTION never does — this file's own prose, a few paragraphs up, contains the words `beforeAll(fn, 190_000)`. The unanchored first draft read that sentence, attributed a 190,000ms override to THIS file, and failed. The census reading its own source is correct and stays that way — no path filters, because a filter is where the next instance hides — so it was the reader that was wrong and the reader that was fixed. The anchor also rejects `cfg.beforeEach(...)`, a method call that is not a hook registration.

### §28. The tracked test files a package's UNIT config runs

The tracked test files a package's UNIT config runs: its own `*.test.ts(x)`, minus the two patterns every config in this repo excludes from that layer, minus anything belonging to a nested workspace package.

### §29. No allowlist, and that choice is asserted not assumed

No allowlist, deliberately, and this asserts that choice rather than leaving it to drift. Thirteen of the thirty-six unit suites contained no hook at all when this was written (measured 2026-08-23; the assertion below deliberately does not pin the count, which would red on the next package added rather than on anything going wrong), so a budget there bounds nothing today — but the cost of declaring it is a line, and the cost of NOT declaring it is that the next hook to be added arrives on the implicit default with nobody looking. That is the precise shape of the defect this file exists for, so uniformity wins over minimalism.

## `packages/source-census/src/test-script-census.test.ts`

### §30. THE `--passWithNoTests` GATE

THE `--passWithNoTests` GATE — A PACKAGE MAY NOT REPORT SUCCESS FOR HAVING RUN NOTHING

WHAT WENT WRONG. `@scp/runner-launcher` — the only code in the product that spawns a process — had no tests and ran `vitest run --passWithNoTests`, so `turbo run test` printed "No test files found" and reported SUCCESS. M23.1 wrote the suite and dropped the flag from THAT ONE package and stopped there. The argument for dropping it applied verbatim to the other thirty-three: six packages held their entire unit coverage in a SINGLE FILE, so `git rm` of one file would have yielded a green empty package, and the three plugins holding the launch-argv goldens this branch had just declared irreplaceable were among them. Fixing the instance and not the class is the incomplete-call-site-census property CLAUDE.md names; this file is the census made standing.

THE RULE, IN TWO PARTS. 1. NO `test` SCRIPT MAY CARRY THE FLAG. The allowlist is EMPTY and is meant to stay empty — a package with nothing to run gets a test that says what it is (see `@scp/plugin-local-auth`'s `stub.test.ts`), not a flag that hides it. 2. EVERY VITEST `test` SCRIPT MUST HAVE A FILE TO RUN. Part 1 alone is not enough: without this, deleting a package's last test file turns `pnpm test` red for a package but the reviewer sees an error about "no test files", not about the coverage that vanished. Asserted as a census so the failure NAMES the package.

`test:integration` IS DIFFERENT, AND IT IS NOT AN OVERSIGHT. CI job 5 shards vitest 4 ways (via the SCP_INTEGRATION_SHARD env var — see the shard-lever census at the bottom of this file), and vitest shards at FILE granularity: a single-file suite (managed-iac, managed-dep) runs in whichever shard vitest assigns it and legitimately finds ZERO files in the others. Removing the flag there would red most of every CI run for a suite that is working correctly. Those scripts are therefore allowlisted BY NAME with that reason, and the allowlist is checked for staleness in both directions.

WHY THIS FILE LIVES IN `@scp/source-census`. This package is the repo's "census over its own tracked source" utility (`readStripped` is what the repo-wide containment gates read with); a census over the repo's own package manifests belongs beside it. It reads `git ls-files`, not a directory walk, for the reason `scanner-containment.test.ts` states: a walk sweeps in `node_modules` and build output and ends up either permanently red or "fixed" with exclusions.

### §31. Integration scripts that may carry the flag, with reasons

`test:integration` scripts that may carry the flag, each with the reason. ONE REASON ONLY IS LEGITIMATE — vitest's file-granularity `--shard`, which hands a shard zero files for a single-file suite.

`@scp/plugin-managed-scan` USED TO BE LISTED HERE AS A DEBT (the M13.3 real-Docker scan suite was scaffolded and never written — zero files in EITHER shard). M23.0 verification pass 8 wrote `managed-scan.integration.test.ts`, closing it; it is now a single-file suite like its two siblings and needs no special reason beyond theirs.

### §32. The shard arrives by env var, never a turbo passthrough

CI job 5 delivers vitest's `--shard=i/N` through the SCP_INTEGRATION_SHARD env var — NOT a turbo `--` passthrough, which folds into every task hash in the graph and rebuilt the whole workspace inside each shard (~76s/shard, measured 2026-08-31; ci.yml's job-5 env comment). That mechanism has exactly two rot points a workflow-side guard cannot see, censused here:

```text
1. turbo runs STRICT env — drop the var from `test:integration`'s `passThroughEnv` and
   turbo strips it before the script runs, `${SCP_INTEGRATION_SHARD:-}` expands empty, and
   every shard runs the FULL suite: 4x the work, still green, invisible.
2. a `test:integration` script that omits the `${SCP_INTEGRATION_SHARD:-}` suffix (the
   likely shape of the NEXT package, copied from a stale example) runs its full file set in
   every shard — the same rotted-lever shape one package at a time.
```

(ci.yml's own assert step covers the third rot point, the workflow `env:` block itself.)

## `packages/source-census/src/tracked.ts`

### §33. Every path `git ls-files` tracks under `repoRoot`

Every path `git ls-files` tracks under `repoRoot` — THE population for any census over this repo's own source. `git ls-files -z`, not a directory walk, for the reason `scanner-containment.test.ts` states: a walk sweeps in `node_modules` and build output and ends up either permanently red or "fixed" with exclusions; and `-z` because some tracked files legitimately contain bytes that would corrupt line-based parsing (see CLAUDE.md on the NUL-byte files).

Hoisted here 2026-08-31 from three byte-identical private copies inside this package's own census tests — the package whose module doc calls it "THE SHARED MACHINERY FOR READING THIS REPO'S OWN SOURCE" had not shared the very first step of every census it hosts, so a fix to one copy (maxBuffer, submodules) would have silently missed the other two.

## `packages/source-census/src/ts.ts`

### §34. TS and JS source: enumeration, read with comments removed

TS/JS SOURCE — enumeration, and reading with `//` and slash-star comments removed
For `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`. For Dockerfiles, shell, YAML and `pin.env` see `./hash.ts` — `#` is not a comment here and slash-slash is not a comment there, and using the wrong one strips nothing (silently, which is how this class of bug survives).

The limits of ALL of this are in the package's `index.ts`. Read them before believing a result.

### §35. Every non-test source file under a directory

Every `.ts` file under `dir` that is not a test and not a declaration file.

`test-support/*.ts` IS included, deliberately: a census exists to find the instance that does not look like the others, and a fixture parked in `test-support` that declares a router or a loop should fail loudly rather than teach the filter to hide the next real one. `node_modules` and `dist` are skipped because they are copies of the tree, not the tree.

### §36. The start of an exported function declaration

The start of an exported function declaration, up to and including its opening parenthesis.

DECLARATION FORMS THIS HAS TO SURVIVE — censused across `apps/server/src` rather than assumed, because the first version of this regex used `\([^)]*\)` and therefore recognised exactly one form. Forms in use in this tree today: - `export function name(…): T` on one line, and split across lines (399 of them); - a parameter that is ITSELF a function — `rand: () => number` (`load-test/stats.ts`), a dependency-injected clock, `fn: () => Promise<T>` — which `[^)]*` cannot cross, so a router factory written `export function subscriptionDriftRouter(clock: () => Date): DomainEventRouter` was invisible to the old census; - a default value that calls something: `now: Date = new Date()` (`federation/crl-parse.ts`); - a generic: `export function sampleDistinct<T>(…)` (`load-test/stats.ts`). `export const name = (…) =>` is NOT used for exported functions anywhere in this tree; it is matched anyway, because the point of a census is to find the instance that does not look like the others. `export async function` is matched too — whether an async declaration counts is the CALLER's decision, made on `ExportedDeclaration.tail` (a router factory returning `Promise<DomainEventRouter>` does not qualify; a loop starter returning `Promise<XLoopHandle>` does).

The parameter list is not matched by this regex at all — `matchingParen` walks it — which is what makes the nested-paren forms work.

### §37. Source with COMMENTS REMOVED

Source with COMMENTS REMOVED — both `//` and block comments, and neither inside a string or template literal, where those character pairs are data. The predecessor of this function handled `//` only while its own comment claimed a commented-out registration would not count: a registration inside a block comment still counted as registered, which is precisely the "comment asserting a protection that does not exist" M21.7 was cleaning up.

NOT TRACKED: regular-expression literals, so a regex containing a block-comment opener would start a spurious comment. The failure direction is a false RED (text removed, the caller's checks fail loudly), never a silent pass.

### §38. Read + strip in one step

Read + strip in one step. Use this, never a bare `readFileSync`, for any census over TS/JS source — see the package doc for the seven censuses that were measured false-green without it, and for the six things stripping still does NOT prove.

## `packages/source-census/vitest.config.ts`

### §39. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §40. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

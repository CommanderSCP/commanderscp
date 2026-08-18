/**
 * ================================================================================================
 * `@scp/source-census` — THE SHARED MACHINERY FOR READING THIS REPO'S OWN SOURCE IN A TEST
 * ================================================================================================
 *
 * A "source census" is any test that reads a file of this repo as TEXT and asserts something about
 * what it contains: that `main.ts` still starts a loop, that the root `Dockerfile` still pins the
 * cosign the code asserts, that `install.sh` only prescribes env vars the server actually reads.
 * They exist because the realistic regression is an edit that DROPS a line, and nothing else in
 * the suite looks at a composition root, a Dockerfile or a shell script at all.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS IS A PACKAGE AND NOT A FUNCTION IN WHOEVER NEEDED IT FIRST
 * ------------------------------------------------------------------------------------------------
 * It was, twice, and both copies were wrong in the same way. On 2026-08-17 a filterless census
 * found TEN of these across four packages reading source as RAW TEXT — so a COMMENTED-OUT line
 * satisfied them. Every one was measured passing over wiring that had been commented out, and the
 * worst were the ones built to catch "component built, never installed", the failure class
 * CLAUDE.md names as this codebase's dominant one:
 *
 *   - `apps/server` — `bump-dispatch.test.ts` stayed green at 20/20, including a case named "the
 *     composition root actually wires it", with `startBumpDispatchLoop` commented out of `main.ts`;
 *     the whole unit suite stayed green at 972/972. Six siblings had it too.
 *   - `deploy/airgap` — `cosign-bin.test.ts` and `skopeo-bin.test.ts` stayed green at 10 passed /
 *     1 skipped each with SEVEN pins commented out, including `ARG COSIGN_IMAGE=` at
 *     `Dockerfile:28`. Those gates exist so the runtime image cannot ship an unvetted binary.
 *   - `deploy/airgap` — `bundle-images.test.ts` stayed green at 87/87 with the env var whose
 *     existence it verifies commented out of `executor-bindings-repo.ts`.
 *   - `@scp/plugin-managed-scan` — `pin.test.ts` stayed green at 7/7 with `ARG TRIVY_IMAGE=` and
 *     `ARG OPENSCAP_IMAGE=` commented out of the scan runner's Dockerfile. Its oscap-version
 *     assertion was satisfied by two PROSE COMMENTS describing the check, so the check itself
 *     could be deleted outright.
 *   - `@scp/plugin-managed-dep` — `runner-image.test.ts`, whose comment on the property was correct
 *     and whose `#`-line filter was right, still read `run.sh` raw for two assertions. A
 *     well-written note naming a hazard is a signal to sweep, not evidence it was handled.
 *
 * The three packages could not share a fix because there was nowhere to put one, and `@scp/
 * plugin-testkit` — the only existing cross-package test utility — is scoped to PUBLIC per-plugin
 * conformance suites an operator runs to vet a third-party plugin (see its module doc); internal
 * repo-hygiene machinery does not belong in it, and neither `@scp/airgap` nor `@scp/server` is a
 * plugin. Hence this package: small, private, dev-only, imported as a devDependency.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT A SOURCE CENSUS CAN AND CANNOT PROVE — READ THIS BEFORE WRITING ONE, AND BEFORE BELIEVING ONE
 * ------------------------------------------------------------------------------------------------
 * The readers here buy EXACTLY ONE THING: the census stops mistaking a DESCRIPTION of code for
 * code. They buy nothing else, and the temptation after fixing that is to believe the census is now
 * sound. It is not. A source census is a grep with good manners. All of this still passes:
 *
 *   1. DEAD CODE. The line is real, compiles, and is never reached — a function nobody calls, a
 *      branch behind `if (false)`, a module never imported, a Dockerfile stage never `COPY --from`ed.
 *      Text has no call graph.
 *   2. A FALSE CONDITION. `if (config.enableX) startXLoop(...)` satisfies a census for `startXLoop(`
 *      while `enableX` is never true in any shipped configuration. This is the likeliest way a
 *      wiring census goes quietly wrong, because the code looks completely correct.
 *   3. A STRING LITERAL. {@link stripComments} deliberately PRESERVES string and template contents
 *      (they are data, and eating them would corrupt the source), so `const doc = "call startXLoop()
 *      to begin"` still matches a census for `startXLoop(`. Stripping moved the hazard from comments
 *      into strings; it did not remove it. The `#`-language equivalent is a heredoc or a quoted
 *      shell string.
 *   4. A CALL THAT DOES NOTHING. The composition root calls the starter and the starter's own body
 *      registers no worker. Measured, and recorded in `inventory-ingestion.test.ts`: deleting
 *      `startInventoryIngestionLoop`'s own `boss.createQueue`/`boss.work` left that file green.
 *   5. THE WRONG ARGUMENTS. `toMatch(/startXLoop\(/)` cannot tell which db, host, queue or guard was
 *      handed over. A census that slices the call text out and inspects it narrows this, never closes it.
 *   6. A SHADOW. A locally-declared `function startXLoop()` in the same file matches the text of a
 *      census aimed at the imported one.
 *
 * SO: A SOURCE CENSUS PROVES A NECESSARY CONDITION, NEVER A SUFFICIENT ONE. It answers "does this
 * file still say this, for real" — not "does this run in production". Only executing the thing does.
 *
 * PAIR EVERY SOURCE CENSUS WITH SOMETHING THAT RUNS, and say in the test file which is which:
 *   - anything IMPORTABLE is asserted by RUNNING it, not by matching its text (M21.7 moved the
 *     router list out of `main.ts` into `events/domain-event-registry.ts` for exactly this reason);
 *   - an image's real contents are asserted by BUILDING it and asking the artifact
 *     (`runner-image.integration.test.ts`), which is the only thing that can see what the BASE
 *     brought in;
 *   - the BEHAVIOUR is an integration test that drives the real component and asserts an effect.
 * The standing check from CLAUDE.md still governs and no census replaces it: DELETE THE WIRING AND
 * WATCH A TEST DIE. If nothing goes red, the wiring is not covered — whatever the census says.
 *
 * AN OVER-CLAIMING CENSUS IS HOW THIS BUG HAPPENED, so state the limit in the test file too, next
 * to the assertion. A comment claiming a protection that does not exist is the hazard, not the
 * documentation of one — `commander-only.test.ts` carried a note saying its census was "the one
 * consumer still reading raw text" while six others were, and a reviewer who trusted it would have
 * stopped looking.
 */

export {
  exportedDeclarations,
  matchingParen,
  productionSourceFiles,
  readStripped,
  stripComments,
  type ExportedDeclaration
} from "./ts.js";

export { atLineStart, readHashStripped, stripHashComments } from "./hash.js";

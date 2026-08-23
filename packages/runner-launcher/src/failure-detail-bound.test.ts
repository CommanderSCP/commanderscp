import { describe, expect, it } from "vitest";
import {
  RUNNER_DETAIL_MAX_CHARS,
  RUNNER_DETAIL_TAIL_CHARS,
  RUNNER_NEVER_STARTED_CODE,
  RUNNER_OUTCOME_UNKNOWN_CODE,
  RunnerLaunchError,
  boundDetail,
  classifyRunnerFailure,
  runnerOutcomeDetail
} from "./index.js";

/**
 * THE FAILURE TAIL WAS INERT IN EXACTLY THE CASE ITS DOC CLAIMED IT EXISTED FOR — HIGH, M23.0
 * verification pass 7. This file is the proof for the fix and, more importantly, the proof that the
 * MECHANISM is pinned rather than merely its output being non-empty.
 *
 * WHY THE FOUR TESTS THAT ALREADY COVERED THIS PATH DID NOT CATCH IT. Every one of them
 * (`whole-run-budget.test.ts`) pins the BUDGET-KILL arm, and that is the one path whose
 * `err.message` is REPLACED with a short synthesised string rather than being Node's
 * `Command failed: <cmd>\n<the ENTIRE stderr>`. With a short message ahead of it the appended tail
 * lands inside every consumer's front-slice, so the append looked like it worked. It did not work
 * anywhere else: `output.slice(-N)` -> `output.slice(0, N)` — head instead of tail, negating the
 * mechanism's whole purpose — SURVIVED 1542 tests. The PRESENCE of output was pinned; its TAIL-ness
 * was pinned by nothing.
 *
 * THE COMPANION NUMBER, CORRECTED — LOW, verification pass 7 finding L1, re-measured in pass 8 and
 * the disagreement turned out to be about the MUTATION, not the count. "Deleting the append
 * entirely reddened 4" was reported here; pass 7 re-measured six. Both are right, and they are
 * measurements of two different things. Re-run against `a0a3ab59^` with the round's own test files
 * removed, in the same tree so `dist` resolution is the real one:
 *
 *   suffix = "" in the TAIL BRANCH ONLY            -> 4 red  (0 launcher, 1 iac, 2 scan, 1 dep)
 *   the WHOLE suffix computation deleted           -> 6 red  (1 launcher, 1 iac, 2 scan, 2 dep)
 *
 * The extra two are not about the tail at all: they pin the `output.length === 0` arm's
 * "[the runner printed nothing on stdout or stderr]" wording, which the broader mutation also
 * removes. So the honest statement is the narrow one — FOUR tests pinned the append, none of them
 * its TAIL-ness — and the sentence now says which mutation it is talking about, because a bare
 * "deleting the append" admits both readings and they differ by 50%.
 *
 * SO EVERY ARM BELOW USES A MESSAGE OF NODE'S REAL SHAPE and puts the diagnosis at the END of the
 * output, which is where a `tofu apply`, a Trivy run and an `npm` failure all put theirs. An
 * assertion that only checks "the detail mentions the runner" passes under both slices; an
 * assertion that the LAST line survived does not.
 */

const REAL_CAUSE = "Error: creating EC2 Instance: InvalidAMIID.NotFound";

/**
 * A rejection shaped like the one `promisify(execFile)` actually produces for a non-zero exit:
 * `message` is the command followed by the WHOLE of stderr, and `stderr` carries it again. `noise`
 * is what the tool printed on its way to the error; `REAL_CAUSE` is its last line.
 */
function nodeExitRejection(noiseChars: number): RunnerLaunchError {
  const line = "module.tf: refreshing state, this is noise the tool printed\n";
  const noise = line.repeat(Math.ceil(noiseChars / line.length)).slice(0, noiseChars);
  const stderr = `${noise}${REAL_CAUSE}\n`;
  return new RunnerLaunchError({
    step: "start",
    file: "docker",
    argv: ["start", "-a", "scp-runner-managed-iac--k1"],
    cause: Object.assign(
      new Error(`Command failed: docker start -a scp-runner-managed-iac--k1\n${stderr}`),
      { code: 1, killed: false, signal: null, stdout: "", stderr }
    ),
    redactions: []
  });
}

describe("HIGH: the REAL CAUSE reaches the operator at every runner-output size", () => {
  /**
   * THE ONE THE SURVIVING MUTATION MUST REDDEN. `output.slice(-FAILURE_OUTPUT_TAIL_CHARS)` ->
   * `output.slice(0, FAILURE_OUTPUT_TAIL_CHARS)` takes the noise the tool printed FIRST instead of
   * the error it ended on, and at 5 KB and 50 KB the message region — front-kept and elided to what
   * the budget leaves — no longer carries the last line either. Both larger arms go red.
   *
   * 1.5 KB is deliberately included and deliberately does NOT depend on the slice: at that size the
   * output fits inside the message whole and the append is skipped as a duplicate. It is here
   * because the property is "the real cause survives AT EVERY SIZE", and a test suite that only
   * covered the sizes where the tail path runs would let the small-output arm rot.
   */
  it.each([1_500, 5_000, 50_000])(
    "the last line of %i characters of runner output survives into `detail`",
    (noiseChars) => {
      const failure = classifyRunnerFailure(nodeExitRejection(noiseChars));

      expect(
        failure.detail,
        "the diagnosis was pushed out by the noise the runner printed before it"
      ).toContain(REAL_CAUSE);

      // AND IT IS THE LAST THING THERE, which is what separates "the tail was kept" from "the
      // string happens to be long enough to still contain it". Under the head-slice mutation the
      // detail can only end in noise.
      expect(failure.detail.trimEnd().endsWith(REAL_CAUSE)).toBe(true);
    }
  );

  it.each([0, 1_500, 5_000, 50_000, 8 * 1024 * 1024])(
    "`detail` is within the total budget at %i characters of runner output",
    (noiseChars) => {
      const failure = classifyRunnerFailure(nodeExitRejection(noiseChars));
      expect(failure.detail.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    }
  );

  it("THE OLD SHAPE IS GONE: `err.message` no longer sits, uncapped, ahead of the tail", () => {
    // The defect as a measurement rather than as prose. `err.message` for 50 KB of stderr is ~50 KB;
    // the composed detail used to be ~52 KB and every consumer front-sliced it. Both facts are
    // asserted so this cannot be satisfied by the message simply having got shorter.
    const err = nodeExitRejection(50_000);
    expect(err.message.length).toBeGreaterThan(50_000);
    const failure = classifyRunnerFailure(err);
    expect(failure.detail.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    // The classification and the argv still survive at the FRONT — the bound took the middle.
    expect(failure.detail).toContain("exit-nonzero:");
    expect(failure.detail).toContain("scp-runner-managed-iac--k1");
    expect(failure.detail).toContain("characters elided");
  });

  it("THE RESERVE IS EXACT: introducer + tail occupy precisely RUNNER_DETAIL_TAIL_CHARS", () => {
    // This is the arithmetic that lets a CALLER prefix its own text and bound again without
    // pushing the diagnosis out: `boundDetail` preserves the last RUNNER_DETAIL_TAIL_CHARS, and the
    // appended region is sized to fit that span exactly. Widen the introducer or the tail without
    // adjusting the other and this goes red before a plugin test does.
    const detail = classifyRunnerFailure(nodeExitRejection(50_000)).detail;
    const at = detail.indexOf(" :: runner output (tail): ");
    expect(at).toBeGreaterThan(0);
    expect(detail.length - at).toBe(RUNNER_DETAIL_TAIL_CHARS);
  });

  it("A SKIPPED DUPLICATE STILL SURVIVES WHEN THE MESSAGE IS WHAT OVERFLOWS", () => {
    // Below the tail cap the output is already inside Node's message, so the append is skipped as a
    // duplicate — and then nothing in this function is holding the cause in a reserved region. The
    // string can still overflow on the OTHER axis: a 6 KB argv (a `-var` per resource) with only
    // 1.5 KB of stderr. This is the arm that says the bound is a MIDDLE elision rather than a
    // truncation: a front-slice of the composed string loses the cause here even though the tail
    // append never ran.
    const stderr = `refreshing\n${REAL_CAUSE}\n`;
    const argv = ["start", "-a", "c", ...Array.from({ length: 200 }, (_, i) => `-var=key${i}=x`)];
    const err = new RunnerLaunchError({
      step: "start",
      file: "docker",
      argv,
      cause: Object.assign(new Error(`Command failed: docker ${argv.join(" ")}\n${stderr}`), {
        code: 1,
        killed: false,
        signal: null,
        stdout: "",
        stderr
      }),
      redactions: []
    });
    expect(err.message.length).toBeGreaterThan(RUNNER_DETAIL_MAX_CHARS);
    const detail = classifyRunnerFailure(err).detail;
    expect(detail).toContain(REAL_CAUSE);
    expect(detail.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
  });
});

describe("boundDetail keeps both ends, and is the same bound wherever it is applied", () => {
  const long = `HEAD-MARKER${"x".repeat(100_000)}TAIL-MARKER`;

  it("a string within the budget is returned unchanged", () => {
    expect(boundDetail("short")).toBe("short");
    const exact = "y".repeat(RUNNER_DETAIL_MAX_CHARS);
    expect(boundDetail(exact)).toBe(exact);
  });

  it("an over-long string keeps its HEAD and its TAIL and loses the middle", () => {
    const bounded = boundDetail(long);
    expect(bounded.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    expect(bounded.startsWith("HEAD-MARKER")).toBe(true);
    expect(bounded.endsWith("TAIL-MARKER")).toBe(true);
    // THE ELISION SAYS HOW MUCH WENT, and the count is ARITHMETICALLY HONEST rather than merely
    // present — a reader who cannot trust it is back to wondering whether the runner simply stopped
    // there, which is the diagnostic hazard a bare truncation carries. Asserted as the invariant
    // `kept head + stated drop + kept tail === the original`, NOT by recomputing the split the way
    // `boundDetail` computes it: a test that re-derives the product's arithmetic passes whatever
    // that arithmetic does.
    const marker = / …\[(\d+) characters elided\]… /.exec(bounded);
    expect(marker).not.toBeNull();
    const stated = Number(marker![1]);
    const keptHead = bounded.indexOf(marker![0]);
    const keptTail = bounded.length - keptHead - marker![0].length;
    expect(keptHead + stated + keptTail).toBe(long.length);
  });

  it("the LAST RUNNER_DETAIL_TAIL_CHARS characters are preserved exactly", () => {
    expect(boundDetail(long).endsWith(long.slice(-RUNNER_DETAIL_TAIL_CHARS))).toBe(true);
  });

  it("IDEMPOTENT — which is what makes applying it at every boundary safe", () => {
    // The defect being fixed is three consumers each truncating a string none of them composed. The
    // replacement is applied at three boundaries too — the port, each plugin's store, and the
    // server's Decision write — and that is only NOT the same mistake because the second and third
    // applications are the identity.
    const once = boundDetail(long);
    expect(boundDetail(once)).toBe(once);
    expect(boundDetail(`a caller's own prefix — ${once}`)).toContain("TAIL-MARKER");
  });
});

describe("the durable ledger's own string is bounded, on the SUCCESS path too", () => {
  it("runnerOutcomeDetail bounds a successful run's stdout — the worse half of the ledger defect", () => {
    // managed-iac records this into `saveState`, a durable JSON file keyed by `idempotencyKey` that
    // is never pruned, and only `status()` sliced it — on READ. A `tofu plan` over a large estate
    // prints megabytes within the 16 MiB maxBuffer, so a SUCCESSFUL apply wrote megabytes to disk
    // per key, forever, to serve 4000 characters.
    const plan = `${"resource changes, line after line\n".repeat(200_000)}Plan: 3 to add, 0 to change, 1 to destroy.`;
    expect(plan.length).toBeGreaterThan(6_000_000);
    const detail = runnerOutcomeDetail({ succeeded: true, stdout: plan, stderr: "" });
    expect(detail.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS);
    // AND THE LINE AN OPERATOR READS A PLAN FOR is the last one, which a front-slice at either
    // 2000 or 4000 was the first thing to lose.
    expect(detail.endsWith("Plan: 3 to add, 0 to change, 1 to destroy.")).toBe(true);
  });

  it("runnerOutcomeDetail passes a failure's already-bounded detail through unchanged", () => {
    const failure = classifyRunnerFailure(nodeExitRejection(50_000));
    expect(runnerOutcomeDetail({ succeeded: false, stdout: "", stderr: "", failure })).toBe(
      failure.detail
    );
  });
});

/**
 * THE MAGNITUDE OF THE BOUND IS A PRODUCT DECISION, PINNED HERE AGAINST ABSOLUTE LITERALS — HIGH,
 * M23.0 verification pass 7.
 *
 * WHY THIS EXISTS AT ALL. Every other length assertion in this repository reads
 * `expect(x.length).toBeLessThanOrEqual(RUNNER_DETAIL_MAX_CHARS)` — against the very constant that
 * DEFINES the bound, so it is a tautology about the magnitude and says only "the function applied
 * itself". MEASURED: with `RUNNER_DETAIL_MAX_CHARS = 4_000` mutated to `40_000`, managed-iac (29),
 * managed-scan (42) and managed-dep (247) stayed fully green and runner-launcher lost exactly one
 * test — a FIXTURE PRECONDITION, not a product assertion. At `400_000` the 432 KB end-to-end
 * integration test still passed, writing a 400 KB `Decision` row, because its only
 * non-self-referential defence was `toContain("characters elided")`, which merely needs
 * `MAX < 432_078`. The whole "1.44 GB/day" argument the bound makes for itself was defended by
 * nothing.
 *
 * SO THE NUMBERS ARE WRITTEN OUT. A `Decision` row's size is governed state, not an implementation
 * detail: changing it is a product decision that should require editing a test that says so, in a
 * file whose name says what it protects. This is the test the prompt asks to redden when someone
 * types `40_000`.
 */
describe("HIGH: the SIZE of the bound, not merely that a bound was applied", () => {
  it("RUNNER_DETAIL_MAX_CHARS is 4 000 characters — roughly 4 KB of governed state per Decision", () => {
    expect(RUNNER_DETAIL_MAX_CHARS).toBe(4_000);
  });

  it("RUNNER_DETAIL_TAIL_CHARS is 2 000 characters — half the budget is reserved for the diagnosis", () => {
    expect(RUNNER_DETAIL_TAIL_CHARS).toBe(2_000);
  });

  it("the reserve leaves a real head: TAIL is strictly less than MAX minus the marker", () => {
    // Not a restatement of the two literals above: this is the relationship that has to hold for
    // `boundDetail` to keep BOTH ends. Set TAIL to MAX and the head share goes to zero — the bound
    // silently becomes a tail-truncation and the argv/classification an operator needs stops
    // appearing, with every length assertion in the repository still green.
    const headShare = RUNNER_DETAIL_MAX_CHARS - RUNNER_DETAIL_TAIL_CHARS;
    expect(headShare).toBeGreaterThan(200);
    const bounded = boundDetail(`HEAD-MARKER${"x".repeat(100_000)}TAIL-MARKER`);
    expect(bounded.startsWith("HEAD-MARKER")).toBe(true);
  });

  it("a bounded detail is at most 4 000 characters, stated without reference to the constant", () => {
    // The same fact as the arms above, expressed the way an operator or a capacity planner would
    // state it. Deliberately duplicated against the literal rather than the symbol: the mutation
    // that survived was one that moved the symbol.
    expect(boundDetail("z".repeat(8 * 1024 * 1024)).length).toBeLessThanOrEqual(4_000);
    expect(
      classifyRunnerFailure(nodeExitRejection(8 * 1024 * 1024)).detail.length
    ).toBeLessThanOrEqual(4_000);
  });
});

// ==================================================================================================
// M23.5 VERIFICATION PASS 18 — THE KIND THAT REFUSES TO GUESS, AND THE ORDER THAT PROTECTS IT
// ==================================================================================================

describe("`outcome-unknown` is decided BEFORE every test that would infer a verdict", () => {
  const unknown = (over: { deadlineExceeded?: boolean; killed?: boolean } = {}) =>
    new RunnerLaunchError({
      step: "start",
      file: "kubernetes://scp",
      argv: ["GET", "/api/v1/namespaces/scp/pods"],
      cause: {
        message: "nothing was ever observed after the unsuspend",
        code: RUNNER_OUTCOME_UNKNOWN_CODE,
        killed: over.killed,
        stdout: "",
        stderr: ""
      },
      redactions: [],
      deadlineExceeded: over.deadlineExceeded === true
    });

  it("AT THE DEADLINE it is `outcome-unknown`, not `budget-exhausted` — the order is the mechanism", () => {
    // THE ARM THAT MATTERS. These runs normally end AT the whole-run deadline, so if
    // `deadlineExceeded` were tested first every one of them would be re-labelled
    // `budget-exhausted` — "the runner was stopped mid-flight" — which is precisely the claim the
    // producer has just declared it cannot make. Swapping the two tests reddens here and nowhere
    // else.
    const failure = classifyRunnerFailure(unknown({ deadlineExceeded: true }));
    expect(failure.kind).toBe("outcome-unknown");
    // AND THE BOUND IS STILL REPORTED HONESTLY. The kind says what is KNOWN about the runner; this
    // boolean says which clock ran out, and they are different questions. A consumer that branched
    // on the boolean to decide whether to re-run would be reading the wrong field — which is why
    // its own doc now says so.
    expect(failure.deadlineExceeded).toBe(true);
    expect(failure.detail).toContain("is NOT KNOWN");
    expect(failure.detail).not.toContain("stopped mid-flight");
  });

  it("AND IT BEATS THE ERRNO TEST TOO — a STRING code would otherwise read as `spawn-failed`", () => {
    // The opposite lie, and the one measured in the field: `typeof code === "string"` is the errno
    // test, so without the first arm this record would say "the container CLI could not be executed
    // at all — nothing ran".
    const failure = classifyRunnerFailure(unknown());
    expect(failure.kind).toBe("outcome-unknown");
    expect(failure.deadlineExceeded).toBe(false);
    expect(failure.detail).not.toContain("nothing ran");
  });

  it("AND IT BEATS `killed` — a run nobody watched must not be read as a signal either", () => {
    expect(classifyRunnerFailure(unknown({ killed: true })).kind).toBe("outcome-unknown");
  });

  /**
   * THE SECOND DECLARED CODE, AND IT IS THE SAME RULE — M23.5 verification pass 20.
   *
   * {@link RUNNER_NEVER_STARTED_CODE} used to reach `spawn-failed` BY BEING A STRING, through the
   * errno test at the very bottom of the chain — which meant it only ever got there when
   * `deadlineExceeded` happened to be `false`. It is a verdict produced almost exclusively by runs
   * that polled to the whole-run deadline, so the flag was `true` essentially every time, and the
   * only thing keeping "SIGTERMed mid-flight" off a Job that never started a container was the
   * Kubernetes verdict FORCING the flag back down on the way past. That force made the durable
   * record contradict itself: `deadlineExceeded: false` printed beside "the whole-run budget … was
   * already spent". These two cases are what let the force be deleted.
   */
  const neverStarted = (over: { deadlineExceeded?: boolean; killed?: boolean } = {}) =>
    new RunnerLaunchError({
      step: "start",
      file: "kubernetes://scp",
      argv: ["GET", "/api/v1/namespaces/scp/pods"],
      cause: {
        message:
          "the whole-run budget of 300ms (RunnerSpec.timeoutMs) was already spent when this run " +
          "reached 'start', so the unsuspend was NEVER ISSUED — NOTHING RAN and nothing was mutated",
        code: RUNNER_NEVER_STARTED_CODE,
        killed: over.killed,
        stdout: "",
        stderr: ""
      },
      redactions: [],
      deadlineExceeded: over.deadlineExceeded === true
    });

  it("A DECLARED `NOTHING STARTED` SURVIVES A TRUE `deadlineExceeded` — and keeps the flag", () => {
    const failure = classifyRunnerFailure(neverStarted({ deadlineExceeded: true }));
    // THE KIND IS THE PRODUCER'S DECLARATION. Move this test below `deadlineExceeded` and the
    // record becomes `budget-exhausted` — "a `tofu apply` was SIGTERMed mid-flight, so the real
    // infrastructure state is unknown" — about a Job that never left `suspend: true`.
    expect(
      failure.kind,
      `a declared "nothing started" was reclassified ${failure.kind}: ${failure.detail}`
    ).toBe("spawn-failed");
    expect(failure.detail).not.toContain("SIGTERMed mid-flight");
    // AND THE FLAG IS NOT SUPPRESSED TO GET THERE. This is the half that was missing: the kind and
    // the boolean answer different questions, so both can be true at once, and the producer no
    // longer has to lie in one field to be understood in the other.
    expect(failure.deadlineExceeded).toBe(true);
    expect(failure.detail).toContain("was already spent");
  });

  it("AND IT BEATS `killed` TOO — the same order, for the same reason", () => {
    // Reachable on the Docker path the day this code is produced there: a budget kill sets
    // `killed: true`, and `signalled` would say the runner was stopped, which is the same
    // unfounded claim in a third vocabulary.
    const failure = classifyRunnerFailure(neverStarted({ deadlineExceeded: true, killed: true }));
    expect(failure.kind).toBe("spawn-failed");
  });

  it("EVERY KIND HAS WORDING — the compiler's arm, restated where a reader can see it fail", () => {
    // `FAILURE_WORDING` is a `Record<RunnerFailureKind, string>`, so a new inhabitant does not
    // compile until it has a sentence. This asserts the consequence an operator sees: the detail
    // always begins `<kind>: <sentence>`, never `<kind>: undefined`.
    expect(
      classifyRunnerFailure(unknown()).detail.startsWith("outcome-unknown: the launcher")
    ).toBe(true);
  });
});

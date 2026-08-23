import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "./ts.js";

/**
 * ================================================================================================
 * THE DOCUMENTED-CLAIM GATE — FOUR FALSE STATEMENTS IN ACCEPTED DOCS, FOUND BY ONE PASS
 * ================================================================================================
 *
 * WHAT HAPPENED. M23's final verification pass read the Accepted and operator-facing documents
 * against the code on disk and found FOUR statements that were measurably false, none of them a
 * typo and all of them load-bearing:
 *
 *   - `deploy/helm/README.md` described the collapsed `pods`/`pods/log` verb list and the `watch`
 *     that M23.6 had removed — the only present-tense falsehood of its kind in the tree, written by
 *     the commit that introduced the section and never touched by the narrowing.
 *   - `deploy/airgap/assets/install.sh` told air-gapped operators "helm — there is NO lever", "the
 *     plugins have no Kubernetes-native launch mode yet" and "`SCP_MANAGED_SCAN_RUNNER_IMAGE` has no
 *     chart value at all". All three had been false since M23.2/M23.4, and the same commit that made
 *     them false rewrote the OUTPUT block ninety lines below and left the comment. This is the
 *     expensive one: it is read where re-checking a claim costs a courier run. A SECOND stale
 *     comment in the same file said the same thing and directly contradicted the block beneath it —
 *     found only because the first was.
 *   - `docs/adr/0035-*.md`'s Status still said two shipped milestones were "(pending)".
 *   - `docs/BUILD_AND_TEST.md` asserted in the present tense that all three managed executors shell
 *     out to a Docker CLI and that "there is no second launch path behind an interface", with three
 *     line-number citations pointing at unrelated code. Its SIBLING bullet carried a SUPERSEDED
 *     marker; this one did not, which is the whole reason it survived four passes.
 *
 * FOUR IN ONE PASS IS NOT FOUR MISTAKES — IT IS AN UNGATED SURFACE. Nothing in this repository ever
 * read a sentence of prose and compared it to a measurement, with one exception (`golden-count-gate`,
 * added after the SAME number was restated wrongly three times). So this file generalises that one
 * exception into the two shapes that are actually gateable:
 *
 *   (1) A NUMBER RESTATED IN PROSE. Every count a document quotes about a machine-checked sweep is
 *       read out of the CODE THAT PINS IT and compared. Six such numbers live across three files;
 *       every one of them was stale within one round of the sweep changing size, including the two
 *       this very milestone made stale by adding six matrix points.
 *   (2) A CLAIM OF THE FORM "X DOES NOT EXIST" ABOUT SOMETHING THE REPOSITORY CAN LOOK UP. Whether
 *       a chart value exists, whether a call site exists. These go false silently and in one
 *       direction only: the code gains the thing, the sentence keeps denying it.
 *
 * WHAT THIS CANNOT DO, STATED RATHER THAN IMPLIED. It cannot gate arbitrary prose — no test can
 * decide whether a paragraph of reasoning is true. What it CAN do is make the specific load-bearing
 * claims machine-checked and make the ledger itself impossible to drift: every entry pins an exact
 * surrounding wording, so EDITING the sentence fails this file too and forces the entry to be
 * updated deliberately rather than orphaned. A claim that leaves the ledger leaves it visibly.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

function read(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

const VERIFY_TS = "tools/helm-verify/src/verify.ts";

/** Pull one pinned number out of `helm-verify`'s own non-vacuity asserts — the code that fails the
 *  build if the sweep changes size, and therefore the only honest source for a prose restatement. */
function pinned(pattern: RegExp): number {
  const source = read(VERIFY_TS);
  const match = pattern.exec(source);
  expect(
    match,
    `${VERIFY_TS} no longer pins a number matching ${pattern}. That assert is what makes every documented count below meaningful; if it moved, point this gate at its new home rather than deleting the entry`
  ).not.toBeNull();
  return Number(match![1]);
}

describe("the documented-claim gate: a number in prose is read out of the code that pins it", () => {
  const points = () => pinned(/points\.length === (\d+)/);
  const rendered = () => pinned(/rendered === (\d+) && refused === \d+/);
  const refused = () => pinned(/rendered === \d+ && refused === (\d+)/);
  const runnerJobs = () => pinned(/runnerJobs === (\d+)/);
  /** Call sites, not the declaration — the same measurement the prose claims to be reporting. */
  const renderChartCalls = () =>
    [...readStripped(resolve(REPO_ROOT, VERIFY_TS)).matchAll(/\brenderChart\(/g)].length - 1;

  /**
   * THE LEDGER. Each entry is (file, a regex that pins the SURROUNDING WORDING and captures the
   * number, the measurement). The wording is part of the key on purpose: a rewrite that drops the
   * claim fails here rather than silently leaving an entry pointed at nothing.
   */
  const NUMERIC_CLAIMS: {
    file: string;
    what: string;
    pattern: RegExp;
    expected: () => number;
  }[] = [
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the matrix size, in the M23 honest-scope bullet",
      pattern: /`tools\/helm-verify` renders (\d+) value combinations/,
      expected: points
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the derived runner Job count, in the M23 honest-scope bullet",
      pattern: /renders \d+ value combinations and (\d+) derived runner Job manifests/,
      expected: runnerJobs
    },
    // The two entries above key on the TOOL'S phrasing. The clause-6 summary in M23.6's
    // "ALL SEVEN MET" block words the same two facts differently, so both slid past this ledger
    // and went stale (156/107 against a real 162/110) inside the round that built this gate.
    // A ledger keyed on wording is only as complete as its wordings — these are the other two.
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the matrix size, in M23.6's clause-6 MET summary",
      pattern: /`helm template` across \*\*(\d+)\*\* value combinations/,
      expected: points
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the derived runner Job count, in M23.6's clause-6 MET summary",
      pattern: /\*\*(\d+)\*\* runner Job manifests derived/,
      expected: runnerJobs
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the matrix size, in the cost note",
      pattern: /The matrix was re-factored to (\d+) points/,
      expected: points
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the matrix size, in the M23.6 clause-6 record",
      pattern: /\*\*(\d+) combinations: \d+ rendered, \d+ refused/,
      expected: points
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the rendered count, in the M23.6 clause-6 record",
      pattern: /\*\*\d+ combinations: (\d+) rendered, \d+ refused/,
      expected: rendered
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the refusal count, in the M23.6 clause-6 record",
      pattern: /\*\*\d+ combinations: \d+ rendered, (\d+) refused/,
      expected: refused
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the derived runner Job count, in the M23.6 clause-6 record",
      pattern: /\*\*(\d+) runner Job manifests\*\*/,
      expected: runnerJobs
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the matrix size, in the sweep-cost paragraph",
      pattern: /(\d+) points, 22 s instead of 40 s/,
      expected: points
    },
    {
      file: "docs/BUILD_AND_TEST.md",
      what: "the hand-picked `renderChart` call count",
      pattern: /The (\d+) existing `renderChart` calls/,
      expected: renderChartCalls
    },
    {
      file: "deploy/helm/templates/runner-iac.yaml",
      what: "the matrix size, in the module header that REPLACED the HONEST SCOPE note",
      pattern: /`helm-verify` renders (\d+)\s*\n\s*combinations/,
      expected: points
    },
    {
      file: VERIFY_TS,
      what: "the hand-picked `renderChart` call count, in `socketMatrix`'s own doc",
      pattern: /The (\d+) `renderChart` calls elsewhere in/,
      expected: renderChartCalls
    }
  ];

  for (const claim of NUMERIC_CLAIMS) {
    it(`${claim.file} — ${claim.what}`, () => {
      const match = claim.pattern.exec(read(claim.file));
      expect(
        match,
        `${claim.file} no longer contains a sentence matching ${claim.pattern}. Either the claim was rewritten (update this ledger entry in the same change) or it was deleted (delete the entry). An orphaned entry is how a gate stops gating`
      ).not.toBeNull();
      expect(
        Number(match![1]),
        `${claim.file} states ${match![1]} for ${claim.what}; the code pins ${claim.expected()}. This exact class — a count restated by hand — has now gone stale five separate times in this milestone alone`
      ).toBe(claim.expected());
    });
  }
});

describe("the documented-claim gate: a claim that something DOES NOT EXIST, looked up", () => {
  /**
   * THE THREE PLUGIN ENTRY POINTS, AND THE BULLET THAT DESCRIBES THEM. The claim was "all three
   * managed executors launch a runner by shelling out to a Docker CLI … there is no second launch
   * path behind an interface". It is checked in BOTH directions: while the count is zero the bullet
   * must be marked SUPERSEDED, and if a plugin ever spawns for itself again the marker must come off
   * — so this cannot be satisfied by deleting the code OR by deleting the sentence.
   *
   * COMMENTS STRIPPED, and that is the load-bearing part. A raw read finds THREE `execFile`
   * occurrences across these files and every one is prose explaining why `dockerBinary` is
   * server-injected or what `promisify(execFile)` attaches to a rejection. A comment naming a hazard
   * is a signal to sweep, never evidence it was handled (CLAUDE.md); counting one as a call site
   * would make this gate report the opposite of the truth.
   */
  const PLUGIN_ENTRIES = [
    "packages/plugins/managed-iac/src/index.ts",
    "packages/plugins/managed-scan/src/index.ts",
    "packages/plugins/managed-dep/src/index.ts"
  ];

  it("the three managed plugins contain no `execFile` call, and the bullet says so", () => {
    const calls = PLUGIN_ENTRIES.flatMap((file) =>
      [...readStripped(resolve(REPO_ROOT, file)).matchAll(/\bexecFileS?y?n?c?\s*\(/g)].map(
        () => file
      )
    );
    const bullet =
      /- \*\*All three managed executors launch a runner by shelling out to a Docker CLI[^\n]*/.exec(
        read("docs/BUILD_AND_TEST.md")
      );
    expect(
      bullet,
      "docs/BUILD_AND_TEST.md no longer carries the M23 honest-scope bullet this entry gates"
    ).not.toBeNull();
    if (calls.length === 0) {
      expect(
        bullet![0],
        `the three plugins contain zero execFile calls, so the bullet asserting they all shell out to a Docker CLI is false in the present tense and must carry a SUPERSEDED marker — which is exactly what its sibling bullet has and what let this one survive four verification passes`
      ).toContain("SUPERSEDED");
    } else {
      expect(
        bullet![0],
        `a plugin spawns for itself again (${[...new Set(calls)].join(", ")}), so the bullet is true again and must NOT be marked SUPERSEDED`
      ).not.toContain("SUPERSEDED");
    }
  });

  /**
   * THE AIR-GAP INSTALLER'S CLAIMS ABOUT WHAT THE CHART CANNOT DO. Two things are checked. The
   * retired sentences must not come back — each one was false for a full milestone and each is
   * quoted here verbatim so a copy-paste revival is a red build. And every chart value the script
   * NAMES as the lever must actually exist in `values.yaml`, which is the general form of the
   * "`SCP_MANAGED_SCAN_RUNNER_IMAGE` has no chart value at all" mistake — a claim about existence,
   * made about something this repository can simply look up.
   */
  it("install.sh does not deny a lever the chart has, and names only values that exist", () => {
    const script = read("deploy/airgap/assets/install.sh");
    const RETIRED_FALSEHOODS = [
      "helm — there is NO lever",
      "The plugins have no",
      "no Kubernetes-native launch mode yet",
      "has no chart value at all",
      "under Kubernetes there is no\n  # lever to hand the operator"
    ];
    for (const phrase of RETIRED_FALSEHOODS) {
      expect(
        script.includes(phrase),
        `deploy/airgap/assets/install.sh has revived "${phrase}". Every one of these was false from M23.2/M23.4 onward while the block ninety lines below it already said the opposite, and this file is read on the far side of an air gap where re-checking costs a courier run`
      ).toBe(false);
    }
    const values = read("deploy/helm/values.yaml");
    // The four levers the helm block now instructs an operator to set. Each must be a real key.
    for (const lever of [
      "managedRunners.launcher",
      "managedRunners.kubernetes.workspace.claimName",
      "managedRunners.kubernetes.perRunSecrets",
      "managedIac.enabled",
      "managedIac.runnerImage",
      "managedDep.runnerImage",
      "managedScan.runnerImage"
    ]) {
      expect(
        script.includes(lever),
        `install.sh no longer names ${lever}. The helm block's whole job is to hand the operator the levers that mode HAS; a lever dropped from it is the silent no-op in the other direction`
      ).toBe(true);
      const leaf = lever.split(".").pop()!;
      expect(
        new RegExp(`^\\s*${leaf}:`, "m").test(values),
        `install.sh tells an operator to set ${lever}, and deploy/helm/values.yaml has no '${leaf}:' key — the script is naming a knob that does nothing, which is the exact failure it exists to prevent`
      ).toBe(true);
    }
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "./ts.js";

/** THE DOCUMENTED-CLAIM GATE. See docs/source-census.md §3. */

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

  /** The ledger: the wording is part of the key. See docs/source-census.md §4. */
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
      // The prose moved to the subsystem doc when the long-form comments were consolidated; the
      // NUMBER is still measured out of `verify.ts` by `renderChartCalls`, so the gate still pins
      // a claim against the code it is about. Only the claim's home changed.
      file: "docs/helm-verify.md",
      what: "the hand-picked `renderChart` call count, in the socket-matrix section",
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
  /** The three plugin entry points and their bullet. See docs/source-census.md §5. */
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

  /** The installer's claims about what the chart cannot do. See docs/source-census.md §6. */
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

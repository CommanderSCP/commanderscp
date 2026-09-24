import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";
import { stripComments } from "./ts.js";

/**
 * THE STANDING GATE for M28's four executor lanes (M28.5) — one census enumerating every lane's
 * seam and asserting `reconcile.ts` — specifically, not merely "somewhere in production code" — is
 * still calling it. Each per-lane increment (M28.1/M28.2/M28.3/M28.4) already has its own
 * reachability file (`build-lane-reachability.test.ts`, `host-reaching-reachability.test.ts`,
 * `infra-lane-reachability.test.ts`, `deployment-authoring-reachability.test.ts`); this file is not
 * a replacement for any of them — it is the cross-cutting roll-up M28.5 asks for: ONE table naming
 * all four lanes together, so a change that silently drops one lane's call while leaving the others
 * (and every per-lane census) green is still caught here.
 *
 * The behavioural half is `apps/server/src/coordination/m28-estate.integration.test.ts`, which
 * spies on each lane's exported derivation and shows it was CALLED, with a database and a real
 * reconcile loop. This half is the cheap, no-database version of the same property: it cannot be
 * satisfied by accident, because deleting the call in `reconcile.ts` (or commenting it out) is
 * exactly what turns the matching row red.
 *
 * Read with `readFileSync`, never a grep tool: some tracked sources carry literal NUL bytes and
 * every search tool silently drops them from a recursive search (CLAUDE.md, §4.4b).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const RECONCILE = "apps/server/src/coordination/reconcile.ts";

/** All four lanes' seams. */
const LANE_SEAMS: Record<string, { file: string; why: string }> = {
  buildLaneTriggerParameters: {
    file: "apps/server/src/coordination/build-trigger-parameters.ts",
    why:
      "the build lane's only producer of source identity and destination (M28.1, ADR-0053); with " +
      "no caller, no build trigger carries a repo, a commit or a destination at all"
  },
  opsLaneTriggerParameters: {
    file: "apps/server/src/coordination/ops-lane-trigger-parameters.ts",
    why:
      "the ops-Argo lane's only producer of the sealed run material (M28.2, ADR-0054); with no " +
      "caller, a host-reaching run submitted to an org's own Argo Workflows carries nothing a pod " +
      "could ever redeem"
  },
  deployLaneTriggerParameters: {
    file: "apps/server/src/coordination/deploy-lane-trigger-parameters.ts",
    why:
      "the deploy lane's only producer of the authored Application/Rollout (M28.4, ADR-0055); with " +
      "no caller, a component SCP did not import has no way to reach Argo CD at all"
  },
  infraLaneTriggerParameters: {
    file: "apps/server/src/coordination/infra-lane-trigger-parameters.ts",
    why:
      "the infra lane's only producer of plan/apply parameters AND the apply gate (M28.3, " +
      "ADR-0056); with no caller, the infrastructure Category reaches its executor with nothing " +
      "and an apply can never be refused for lacking an approved plan"
  }
};

const isTest = (p: string): boolean =>
  p.includes(".test.") || p.includes("/test-support/") || p.includes("/testkit/");

const PRODUCTION_SOURCES = trackedFiles(REPO_ROOT).filter(
  (p) =>
    (p.startsWith("apps/") || p.startsWith("packages/")) &&
    p.endsWith(".ts") &&
    !p.endsWith(".d.ts") &&
    !isTest(p)
);

/** MEMOISED comment-stripped reads — every lane name reads every production source once. */
const strippedSources = new Map<string, string>();
function readSource(file: string): string {
  let text = strippedSources.get(file);
  if (text === undefined) {
    text = stripComments(readFileSync(resolve(REPO_ROOT, file), "utf8"));
    strippedSources.set(file, text);
  }
  return text;
}

function definitionFiles(name: string): Set<string> {
  const defined = new Set<string>();
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  for (const path of PRODUCTION_SOURCES) {
    if (declaration.test(readSource(path))) defined.add(path);
  }
  return defined;
}

/** A CALL, not a mention — comments are stripped first, so a commented-out call (exactly the shape
 *  of "the wiring was removed and a note left behind") is not counted as a caller. */
function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) => used.test(readSource(p)));
}

describe("all four M28 executor lanes are INSTALLED into reconcile.ts, together, not merely built", () => {
  it.each(Object.entries(LANE_SEAMS))("%s has a non-test caller", (name, { why }) => {
    expect(
      callersOf(name),
      `${name}() has NO production caller anywhere. It is ${why}. A test calling it directly ` +
        `does not make it reachable — that is exactly how M27 shipped eight green increments ` +
        `with no working host-reaching path.`
    ).not.toEqual([]);
  });

  it.each(Object.entries(LANE_SEAMS))(
    "%s is called from reconcile.ts SPECIFICALLY — the trigger path, not merely somewhere",
    (name) => {
      // A caller elsewhere (a route previewing the manifests, say, or the lane's own test) would
      // satisfy the row above while no real trigger ever carried this lane's material. Every one of
      // the four lanes is wired at exactly one place in production: the reconcile trigger step.
      expect(
        callersOf(name),
        `${name}() is reachable from SOME production file, but not from reconcile.ts — the lane ` +
          `is not wired into the trigger path`
      ).toContain(RECONCILE);
    }
  );

  it("a commented-out call is not a caller (known-positive control for the comment stripping)", () => {
    for (const name of Object.keys(LANE_SEAMS)) {
      const used = new RegExp(`\\b${name}\\s*\\(`);
      const commentedOut = `// await ${name}(tx, {\n/* ${name}( */`;
      expect(used.test(commentedOut)).toBe(true);
      expect(used.test(stripComments(commentedOut))).toBe(false);
    }
  });

  it("every lane name in the census is actually DEFINED where this file says it is", () => {
    // Otherwise a rename silently empties the gate: `callersOf` on a name nothing defines returns
    // every file that never mentions it, the two rows above pass vacuously, and the census reports
    // green while protecting nothing.
    for (const [name, { file }] of Object.entries(LANE_SEAMS)) {
      const defined = definitionFiles(name);
      expect(
        [...defined],
        `${name} is in the M28.5 lane census but nothing exports it — it was renamed or removed`
      ).not.toEqual([]);
      expect(
        [...defined],
        `${name} is expected to be defined in ${file}, but isn't — update the census`
      ).toContain(file);
    }
  });
});

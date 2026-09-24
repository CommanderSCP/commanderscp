import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";
import { stripComments } from "./ts.js";

/**
 * THE INSTALLATION GATE for SCP-authored deployments (M28.4, ADR-0055) — the sibling of
 * `host-reaching-reachability.test.ts`, over the same property: a capability whose every test calls
 * it directly, so no test notices when nothing else does. A sibling file rather than new rows in
 * that one so concurrent M28 increments do not collide in one table; the method is identical and is
 * copied rather than imported so neither gate can be emptied by editing the other.
 *
 * The behavioural half is `argocd-authored-deployment.integration.test.ts`, which goes red (the
 * plain sync of a never-created Application 404s) when the reconcile call is deleted. This half
 * names the function that became unreachable, in the unit suite, without a database.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  deployLaneTriggerParameters:
    "the only producer of the Application SCP authors; with no caller, a component that is not " +
    "imported has no way to reach Argo CD at all — its plain sync addresses an Application nobody " +
    "created",
  authoredRollbackTrigger:
    "the only thing that turns a rollback of an authored target into the PRIOR manifest (ADR-0055 " +
    "D-c); with no caller, every authored rollback re-syncs the release it is undoing",
  parseTopologyWaves:
    "where the wave plan's `rollout` is validated at propose time and read back at trigger time — " +
    "the Rollout's steps come from nowhere else"
};

const isTest = (p: string): boolean =>
  p.includes(".test.") || p.includes("/test-support/") || p.includes("/testkit/");

/** Read with `readFileSync`, never a grep tool — NUL-carrying sources are dropped silently (§4.4b). */
const PRODUCTION_SOURCES = trackedFiles(REPO_ROOT).filter(
  (p) =>
    (p.startsWith("apps/") || p.startsWith("packages/")) &&
    p.endsWith(".ts") &&
    !p.endsWith(".d.ts") &&
    !isTest(p)
);

function definitionFiles(name: string): Set<string> {
  const defined = new Set<string>();
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  for (const path of PRODUCTION_SOURCES) {
    if (declaration.test(readFileSync(resolve(REPO_ROOT, path), "utf8"))) defined.add(path);
  }
  return defined;
}

/** A CALL, not a mention: comments are stripped first (`ts.ts`'s reader), so a commented-out call —
 *  the exact shape of "the wiring was removed and a note left behind" — is not counted as a caller. */
function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) =>
    used.test(stripComments(readFileSync(resolve(REPO_ROOT, p), "utf8")))
  );
}

describe("SCP-authored deployment is INSTALLED, not merely built", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      expect(
        callersOf(name),
        `${name}() has NO production caller. It is ${why}. Wire it, or delete it and say so.`
      ).not.toEqual([]);
    }
  );

  it("the deploy lane is called from the reconcile loop specifically — the trigger path", () => {
    // A caller elsewhere (a route previewing the manifests, say) would satisfy the row above while
    // no trigger ever carried an authored Application.
    expect(callersOf("deployLaneTriggerParameters")).toContain(
      "apps/server/src/coordination/reconcile.ts"
    );
  });

  it("a commented-out call is not a caller (known-positive control for the comment stripping)", () => {
    const used = /\bdeployLaneTriggerParameters\s*\(/;
    const commentedOut = "// authored = await deployLaneTriggerParameters(tx, {\n/* deployLaneTriggerParameters( */";
    expect(used.test(commentedOut)).toBe(true);
    expect(used.test(stripComments(commentedOut))).toBe(false);
  });

  it("every name in the census is actually DEFINED somewhere", () => {
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the reachability census but nothing exports it — the entry protects nothing.`
      ).not.toEqual([]);
    }
  });
});

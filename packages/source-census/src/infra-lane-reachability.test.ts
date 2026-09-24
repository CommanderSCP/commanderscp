import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";

/**
 * THE INSTALLATION GATE for the infrastructure lane (M28.3, ADR-0056).
 *
 * The sibling of `build-lane-reachability.test.ts` and `host-reaching-reachability.test.ts`, for the
 * same property: a capability whose every test calls it directly, so no test notices when nothing
 * else does. The behavioural proof is `infra-lane.integration.test.ts` (the real reconcile loop, the
 * real argo-workflows plugin, the shipped script in the pinned image) — which needs a database and,
 * for its last leg, Docker. This census is the cheap half that cannot be satisfied by accident: each
 * producer below must be reached from production code, the reconcile call must route a refusal to
 * the terminal Decision path and a no-op to its own recorder, the lane's bounds must be spread
 * LAST, and the plugin's status() must actually read the plan evidence it defines.
 *
 * Read with `readFileSync`, never a grep tool: some tracked sources carry literal NUL bytes and
 * every search tool silently drops them from a recursive search (§4.4b).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  infraLaneTriggerParameters:
    "derives an infrastructure trigger AND decides whether an apply may be triggered at all; with " +
    "no caller, the infrastructure Category reaches its executor with nothing and no apply gate",
  assertNotAnUngatedInfraApply:
    "holds the shipped apply template away from every trigger the lane did not derive; with no " +
    "caller, a binding naming scp-infra-apply-v1 directly is an apply nobody approved",
  infraApplyTemplateFor:
    "derives the apply template from the bound plan template, so no binding can point a plan's " +
    "trigger at an apply"
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

const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), "utf8");

function definitionFiles(name: string): Set<string> {
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  return new Set(PRODUCTION_SOURCES.filter((p) => declaration.test(read(p))));
}

function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) => used.test(read(p)));
}

describe("the infrastructure lane is INSTALLED, not merely built", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      expect(
        callersOf(name),
        `${name}() has NO production caller. It is what ${why}. A test calling it directly does ` +
          `not make it reachable.`
      ).not.toEqual([]);
    }
  );

  it("every name in the census is actually DEFINED somewhere", () => {
    // A rename would otherwise empty the gate: `callersOf` a name nothing defines passes vacuously.
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the census but nothing exports it`
      ).not.toEqual([]);
    }
  });

  const reconcile = () => read("apps/server/src/coordination/reconcile.ts");

  it("reconcile routes the lane's REFUSAL to the terminal path and its NO-OP to the recorder", () => {
    const source = reconcile();
    expect(source).toMatch(
      /const infra = await infraLaneTriggerParameters\(tx, \{[^}]*\}\)\.catch\(asRefusal\)/
    );
    expect(source).toMatch(
      /if \(infra instanceof TriggerParameterRefusal\) \{\s*await refuseTrigger\(tx, infra\);\s*return null;/
    );
    expect(source).toMatch(
      /if \(infra\?\.kind === "noop"\) \{\s*await recordInfraApplyNoop\(tx, \{/
    );
    expect(source).toMatch(/async function recordInfraApplyNoop\(/);
  });

  it("the lane chooses the TEMPLATE and its bounds are spread LAST (a recipe cannot restate them)", () => {
    const source = reconcile();
    expect(source).toContain("const triggerRef = infra ? infra.templateRef : externalRef;");
    expect(source).toContain("{ ...(parameters ?? {}), ...(infra?.parameters ?? {}) }");
    expect(source).toMatch(/externalRef: triggerRef, parameters: triggerParameters/);
  });

  it("the argo-workflows plugin's status() READS the plan evidence it defines", () => {
    // The evidence channel: without this read the plan never reaches `observed.plan`, the apply
    // gate refuses every apply for want of a digest, and every unit test of the parser still passes.
    const plugin = read("packages/plugins/argo-workflows/src/index.ts");
    expect(plugin).toMatch(/planFromOutputs\(wf\.status\?\.outputs\)/);
    expect(plugin).toMatch(/\.\.\.\(plan \? \{ observed: \{ plan \} \} : \{\}\)/);
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";
import { stripComments } from "./ts.js";

/**
 * THE INSTALLATION GATE for the infrastructure lane (M28.3, ADR-0056).
 *
 * The sibling of `build-lane-reachability.test.ts` and `host-reaching-reachability.test.ts`, for the
 * same property: a capability whose every test calls it directly, so no test notices when nothing
 * else does. The behavioural proof is `infra-lane.integration.test.ts` (the real reconcile loop, the
 * real argo-workflows plugin, the shipped script in the pinned image) — which needs a database and,
 * for its last leg, Docker. This census is the cheap half that cannot be satisfied by accident.
 *
 * EVERY SOURCE IS READ WITH ITS COMMENTS STRIPPED (`stripComments`): a call that has been commented
 * out — or a comment that merely NAMES the call, as the ones explaining it do — is not a caller.
 * The control below proves the stripping is what makes that true. Read with `readFileSync`, never a
 * grep tool: some tracked sources carry literal NUL bytes (§4.4b).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  infraLaneTriggerParameters:
    "derives an infrastructure trigger AND decides whether an apply may be triggered at all; with " +
    "no caller, the infrastructure Category reaches its executor with nothing and no apply gate",
  recordInfraTrigger:
    "records what a plan submitted, which is what an apply is built from; with no caller every " +
    "apply is refused for want of a record — or, worse, someone re-derives it",
  assertNotAnUngatedInfraTemplate:
    "holds both shipped infra templates away from every trigger the lane did not derive, with a " +
    "Decision; with no caller, a binding naming scp-infra-plan-v1 directly runs a plan anywhere",
  authorizeInfraLaneIntent:
    "is the lane's authority at the plugin host's door; with no caller the lane's own triggers are " +
    "refused there",
  assertInfraTemplateTrigger:
    "is the plugin host's door for every server path that submits a template name",
  assertInfraTemplateSchedule: "is the same door for schedules",
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

const read = (p: string): string => stripComments(readFileSync(resolve(REPO_ROOT, p), "utf8"));

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

  it("CONTROL — a commented-out call is not a caller (the stripping is load-bearing)", () => {
    const used = /\binfraLaneTriggerParameters\s*\(/;
    const commentedOut =
      "// const infra = await infraLaneTriggerParameters(tx, {});\n/* infraLaneTriggerParameters(x) */";
    expect(used.test(commentedOut), "the raw text DOES match — the control's premise").toBe(true);
    expect(used.test(stripComments(commentedOut))).toBe(false);
  });

  it("the lane's authority at the plugin host is granted by reconcile ALONE", () => {
    // Anything else that could mark an intent would be a second, ungated way through the door.
    expect(callersOf("authorizeInfraLaneIntent")).toEqual([
      "apps/server/src/coordination/reconcile.ts"
    ]);
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
    expect(source).toMatch(
      /if \(claimed && infra\?\.kind === "trigger"\) \{\s*await recordInfraTrigger\(tx, \{/
    );
  });

  it("the lane chooses the TEMPLATE and its bounds are spread LAST (a recipe cannot restate them)", () => {
    const source = reconcile();
    expect(source).toContain("const triggerRef = infra ? infra.templateRef : externalRef;");
    expect(source).toContain("? { ...(parameters ?? {}), ...infra.parameters }");
    expect(source).toMatch(/externalRef: triggerRef,\s*parameters: triggerParameters/);
  });

  it("the plugin host's executor client puts EVERY trigger and schedule through the door", () => {
    const host = read("apps/server/src/plugin-host/host.ts");
    expect(host).toMatch(
      /trigger: async \(intent: TriggerIntent\) => \{\s*assertInfraTemplateTrigger\(intent\);\s*return call<ExternalRunRef>\("trigger", \{ intent \}\);/
    );
    expect(host).toMatch(
      /ensureSchedule: async \(spec: ScheduleSpec\) => \{\s*assertInfraTemplateSchedule\(spec\);\s*return call<void>\("ensureSchedule", \{ spec \}\);/
    );
  });

  it("the accept gate holds an infrastructure plan's separation of duties", () => {
    const gates = read("apps/server/src/coordination/gates.ts");
    expect(gates).toMatch(
      /const separation = await infraPlanSeparationOfDuties\(tx, ctx, changeObject\.properties\);\s*if \(separation\) return separation;/
    );
  });

  it("the argo-workflows plugin's status() READS the plan evidence it defines", () => {
    // The evidence channel: without this read the plan never reaches `observed.plan`, the apply
    // gate refuses every apply for want of a digest, and every unit test of the parser still passes.
    const plugin = read("packages/plugins/argo-workflows/src/index.ts");
    expect(plugin).toMatch(/planFromOutputs\(wf\.status\?\.outputs\)/);
    expect(plugin).toMatch(/\.\.\.\(plan \? \{ observed: \{ plan \} \} : \{\}\)/);
  });
});

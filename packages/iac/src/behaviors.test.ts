import { describe, expect, it } from "vitest";
import {
  BakeAlarms,
  CanaryRollout,
  ContinuousTest,
  DeploymentTarget,
  Duration,
  ImagePipeline,
  PostDeployTest,
  PostMergeTest,
  RollingRollout,
  Service,
  Stack,
  Workflow
} from "./index.js";

/**
 * THE TYPED PIPELINE BEHAVIOURS (L2) — `behaviors.ts`.
 *
 * ============================================================================================
 * THE ONE PROPERTY THAT MATTERS, AND WHY IT IS AN EQUALITY RATHER THAN A SHAPE ASSERTION
 * ============================================================================================
 * D16(1): "an L1-authored entry and its L2 equivalent synthesize identically." A shape assertion
 * on the L2 output would pass while the two doors drifted — which is the failure this library is
 * most exposed to, because the L1 door is what a standards package or a generated file uses and
 * the L2 door is what a human writes. So the central case builds the SAME declaration both ways
 * and compares whole manifests.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `Workflow` stops inheriting `repo` from the pipeline (hard-codes `""`) | 3 FAIL — (1), (2), (3). The L1/L2 equality is the first to go, which is the drift this case exists to catch |
 * | `PipelineBase.componentUrn` returns the URN even at the shared rung | (5) FAILS — a service-rung hook is accepted and synthesizes keyed on a SERVICE urn, which no read path resolves |
 * | `ContinuousTest` passes `props.every` through without `.toSeconds()` | (3) FAILS — a raw `Duration` reaches the entry, the hazard `duration.ts`'s header records |
 * | `PostDeployTest` defaults `stage` to `"production"` instead of omitting it | 2 FAIL — (1) and (2). Absent means EVERY wave (D21(a)), so a default silently REMOVES gates |
 */
describe("@scp/iac L2: typed pipeline behaviours", () => {
  const REPO = "payments/payments-api";

  // NO explicit return type: the typed pipeline classes are GENERATED values, so `ImagePipeline`
  // names a value and not a type (`TS2749`) — inference gives the right one. Caught by `tsc`, not
  // by the suite: vitest never typechecks, which is why `pnpm check` is the gate that matters.
  function pipeline(stackName: string) {
    const svc = Service.fromName("payments");
    return new ImagePipeline(stackName, {
      service: svc,
      repo: REPO,
      branch: "main",
      waves: [{ name: "staging", targets: [DeploymentTarget.fromName("commercial-amer-staging")] }]
    });
  }

  it("(1) an L2-authored hook synthesizes IDENTICALLY to the same declaration through L1", () => {
    const l2 = pipeline("equality");
    const workflow = new Workflow(l2, "integration", { path: ".argo/integration.yaml" });
    new PostDeployTest(workflow);

    const l1 = pipeline("equality");
    l1.stack.addPipelineHook(
      { urn: "urn:scp:equality:component:equality", typeId: "component" },
      {
        kind: "postDeploy",
        hookId: "postDeploy",
        // Spelled out by hand, including the repo and branch the L2 form INHERITED from the
        // pipeline's scope chain — if that inheritance broke, these two would differ.
        workflow: { repo: REPO, branch: "main", path: ".argo/integration.yaml" }
      }
    );

    expect(JSON.stringify(l2.stack.synth())).toBe(JSON.stringify(l1.stack.synth()));
  });

  it("(1b) PostMergeTest defaults its id to the construct kind and inherits the workflow ref", () => {
    // The natural-singleton rule (D16(6)): one post-merge gate per workflow, so `id` defaults to
    // the kind and an author types one only for same-kind siblings.
    const p = pipeline("postmerge");
    const workflow = new Workflow(p, "unit", { path: ".argo/unit.yaml", templateName: "unit" });
    new PostMergeTest(workflow);

    expect(p.stack.synth().pipelineHooks).toEqual([
      {
        kind: "postMerge",
        hookId: "postMerge",
        componentUrn: "urn:scp:postmerge:component:postmerge",
        workflow: {
          repo: REPO,
          branch: "main",
          path: ".argo/unit.yaml",
          templateName: "unit"
        }
      }
    ]);
  });

  it("(2) `stage` is OMITTED by default — absent gates every wave, and a default would remove gates", () => {
    const p = pipeline("stages");
    const workflow = new Workflow(p, "integration", { path: ".argo/integration.yaml" });
    new PostDeployTest(workflow);
    new PostDeployTest(workflow, "staging-only", { stage: "staging" });

    const hooks = p.stack.synth().pipelineHooks ?? [];
    const byId = Object.fromEntries(hooks.map((h) => [h.hookId, h]));
    expect("stage" in (byId.postDeploy ?? {})).toBe(false);
    expect(byId["staging-only"]).toMatchObject({ stage: "staging" });
  });

  it("(3) durations resolve to plain seconds before they can reach a manifest entry", () => {
    const p = pipeline("durations");
    const workflow = new Workflow(p, "canary", { path: ".argo/canary.yaml" });
    new ContinuousTest(workflow, "continuous", {
      every: Duration.minutes(5),
      maxAge: Duration.minutes(15)
    });
    new BakeAlarms(p, "bakeAlarms", { quietWindow: Duration.minutes(10) });

    const hooks = p.stack.synth().pipelineHooks ?? [];
    expect(hooks.find((h) => h.kind === "continuous")).toMatchObject({
      everySeconds: 300,
      maxAgeSeconds: 900
    });
    expect(hooks.find((h) => h.kind === "bakeAlarms")).toMatchObject({ quietWindowSeconds: 600 });
    // A `Duration` that reached the entry would survive `JSON.stringify` as an object and fail
    // Zod — so the assertion above is on the VALUE, not merely on the key being present.
    expect(
      typeof (hooks.find((h) => h.kind === "bakeAlarms") as { quietWindowSeconds: unknown })
        .quietWindowSeconds
    ).toBe("number");
  });

  it("(4) the strategy IS the class — canary and rolling reach the manifest keyed by target class", () => {
    const p = pipeline("rollouts");
    new CanaryRollout(p, "canaryRollout", {
      targetClass: "cluster",
      steps: [{ weightPercent: 10, pause: Duration.minutes(1) }, { weightPercent: 50 }]
    });
    new RollingRollout(p, "rollingRollout", {
      targetClass: "instanceGroup",
      batchPercent: 25,
      pauseBetween: Duration.seconds(30)
    });

    expect(p.stack.synth().rollouts).toEqual([
      {
        componentUrn: "urn:scp:rollouts:component:rollouts",
        targetClass: "cluster",
        rollout: {
          strategy: "canary",
          steps: [{ weightPercent: 10, pauseSeconds: 60 }, { weightPercent: 50 }]
        }
      },
      {
        componentUrn: "urn:scp:rollouts:component:rollouts",
        targetClass: "instanceGroup",
        rollout: { strategy: "rolling", batchPercent: 25, pauseBetweenSeconds: 30 }
      }
    ]);
  });

  it("(5) a hook under a SERVICE-rung pipeline is REFUSED, naming why rather than guessing a component", () => {
    const stack = new Stack("shared-rung");
    const svc = new Service(stack, "payments", { name: "payments" });
    // D8's shared-rung exception: the pipeline attaches to the SERVICE, so it names no component,
    // and which components inherit it is resolved at READ time by the nearest-rung ladder.
    // The SERVICE is the scope — that is how the shared rung is spelled (`resolvePipelineCtorArgs`
    // sets `isComponentScoped` from `scope instanceof Component`), not a `scope:` prop.
    // No `service:` prop in the nested form — that belongs to the ROOT form, which auto-creates a
    // component. Here the scope IS the service.
    const shared = new ImagePipeline(svc, { repo: REPO, waves: [] });
    const workflow = new Workflow(shared, "integration", { path: ".argo/integration.yaml" });
    expect(() => new PostDeployTest(workflow)).toThrow(
      /shared-rung exception.*names no component/s
    );
  });

  it("(6) a behaviour declared outside any pipeline is refused, pointing at the L1 door", () => {
    const stack = new Stack("orphan");
    expect(() => new Workflow(stack, "integration", { path: "x.yaml" })).toThrow(
      /not inside a pipeline.*addPipelineHook/s
    );
  });
});

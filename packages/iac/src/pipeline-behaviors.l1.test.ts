import { describe, expect, it } from "vitest";
import { Component, Service, Stack } from "./index.js";

/** THE L1 DOOR FOR THE INCREMENT-8 CONTRACT. See docs/iac.md §276. */
describe("@scp/iac L1: the increment-8 manifest collections", () => {
  function stackWithComponent(): { stack: Stack; component: Component } {
    const stack = new Stack("behaviors");
    const service = new Service(stack, "payments", { name: "payments" });
    // `Component` takes its service as a PROP (it writes the `contains` edge), not as its scope.
    const component = new Component(stack, "api", { name: "api", service });
    return { stack, component };
  }

  const workflow = {
    repo: "git.corp.example/payments/api",
    branch: "main",
    path: ".argo/integration.yaml"
  };

  it("(1) a hook authored through L1 reaches the manifest — the collection is assembled, not dropped", () => {
    const { stack, component } = stackWithComponent();
    stack.addPipelineHook(component, { kind: "postMerge", hookId: "postMerge", workflow });

    const manifest = stack.synth();
    expect(manifest.pipelineHooks).toEqual([
      {
        kind: "postMerge",
        hookId: "postMerge",
        componentUrn: "urn:scp:behaviors:component:api",
        workflow
      }
    ]);
  });

  it("(2) the CONSTRUCT decides the subject — a `componentUrn` smuggled into the spec does not win", () => {
    const { stack, component } = stackWithComponent();
    // The type omits that field, so this is reachable only from JS. See docs/iac.md §277.
    stack.addPipelineHook(component, {
      kind: "postMerge",
      hookId: "postMerge",
      workflow,
      componentUrn: "urn:scp:behaviors:component:someone-elses"
    } as unknown as Parameters<typeof stack.addPipelineHook>[1]);
    expect(stack.synth().pipelineHooks?.[0]?.componentUrn).toBe(component.urn);
  });

  it("(3) every hook kind in the contract is expressible, including the one that carries no workflow", () => {
    const { stack, component } = stackWithComponent();
    stack
      .addPipelineHook(component, { kind: "postMerge", hookId: "postMerge", workflow })
      .addPipelineHook(component, { kind: "postDeploy", hookId: "integration", workflow })
      .addPipelineHook(component, {
        kind: "postDeploy",
        hookId: "staging-only",
        workflow,
        stage: "staging"
      })
      .addPipelineHook(component, {
        kind: "continuous",
        hookId: "canary",
        workflow,
        everySeconds: 300,
        maxAgeSeconds: 900
      })
      // `bakeAlarms` triggers nothing, so it carries NO workflow. The distributive `Omit` is what
      // keeps that narrowing alive at this door: without it the union collapses and a `bakeAlarms`
      // hook carrying a `workflow` would typecheck here and be refused only by Zod at synth.
      .addPipelineHook(component, {
        kind: "bakeAlarms",
        hookId: "bakeAlarms",
        quietWindowSeconds: 600
      });

    const kinds = stack.synth().pipelineHooks?.map((h) => `${h.kind}/${h.hookId}`);
    expect(kinds).toEqual([
      "bakeAlarms/bakeAlarms",
      "continuous/canary",
      "postDeploy/integration",
      "postDeploy/staging-only",
      "postMerge/postMerge"
    ]);
  });

  it("(4) output is byte-identical regardless of declaration order — including same-kind siblings", () => {
    function build(order: "forward" | "reverse"): string {
      const { stack, component } = stackWithComponent();
      const decls = [
        () => stack.addPipelineHook(component, { kind: "postDeploy", hookId: "b", workflow }),
        () => stack.addPipelineHook(component, { kind: "postDeploy", hookId: "a", workflow }),
        () =>
          stack.addRollout(component, {
            targetClass: "cluster",
            rollout: { strategy: "canary", steps: [{ weightPercent: 10, pauseSeconds: 60 }] }
          }),
        () =>
          stack.addRollout(component, {
            targetClass: "instanceGroup",
            rollout: { strategy: "rolling", batchPercent: 25 }
          })
      ];
      for (const declare of order === "forward" ? decls : [...decls].reverse()) declare();
      return JSON.stringify(stack.synth());
    }
    expect(build("forward")).toBe(build("reverse"));
  });

  it("(5) an empty collection is OMITTED, never `[]` — and for pipelineHooks that omission is load-bearing", () => {
    const { stack } = stackWithComponent();
    const manifest = stack.synth();
    // Absent, not `[]`. For `pipelineHooks` the contract makes absent mean UNMANAGED rather than
    // "manages none", exactly as `producers` does — so an author who deletes their last hook does
    // NOT silently disarm a gate, and retraction needs a hand-authored `"pipelineHooks": []`.
    expect("pipelineHooks" in manifest).toBe(false);
    expect("rollouts" in manifest).toBe(false);
    expect("convergence" in manifest).toBe(false);
  });

  it("(6) rollouts and convergence reach the manifest with their identities intact", () => {
    const { stack, component } = stackWithComponent();
    stack.addRollout(component, {
      targetClass: "cluster",
      rollout: {
        strategy: "canary",
        steps: [{ weightPercent: 10, pauseSeconds: 60 }, { weightPercent: 50 }]
      }
    });
    stack.addConvergence(component, "urn:scp:behaviors:deployment-target:pay-blue", {
      converge: true,
      scope: "changedSubset"
    });

    const manifest = stack.synth();
    expect(manifest.rollouts).toEqual([
      {
        componentUrn: component.urn,
        targetClass: "cluster",
        rollout: {
          strategy: "canary",
          steps: [{ weightPercent: 10, pauseSeconds: 60 }, { weightPercent: 50 }]
        }
      }
    ]);
    expect(manifest.convergence).toEqual([
      {
        componentUrn: component.urn,
        targetUrn: "urn:scp:behaviors:deployment-target:pay-blue",
        converge: true,
        scope: "changedSubset"
      }
    ]);
  });

  it("(7) a malformed hook is refused by synth WITH the construct path, not accepted onto the wire", () => {
    const { stack, component } = stackWithComponent();
    stack.addPipelineHook(component, {
      kind: "continuous",
      hookId: "bad",
      workflow,
      everySeconds: 300,
      // A RUNTIME contract violation, not a type error. See docs/iac.md §278.
      maxAgeSeconds: -1
    });
    // MEASURED path, not assumed: `Component` scopes to the STACK and takes its service as a prop
    // (it writes the `contains` edge), so the path is `behaviors/api`. Asserting the
    // service-nested path I first guessed would have failed even with the location array correct —
    // and asserting something looser would have passed even with it misaligned.
    expect(() => stack.synth()).toThrow(
      /pipelineHooks\.0\.maxAgeSeconds \[construct: behaviors\/api\]/
    );
  });
});

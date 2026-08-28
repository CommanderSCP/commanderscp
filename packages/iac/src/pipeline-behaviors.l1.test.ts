import { describe, expect, it } from "vitest";
import { Component, Service, Stack } from "./index.js";

/**
 * THE L1 DOOR FOR THE INCREMENT-8 CONTRACT — `pipelineHooks`, `rollouts`, `convergence`.
 *
 * ============================================================================================
 * WHAT WAS BROKEN, MEASURED BEFORE THIS FILE EXISTED
 * ============================================================================================
 * The contract merged in #294 and the server half has been live since: `plans-repo.ts` applies
 * `pipelineHooks` through `upsertHook`, `render.ts` displays them per component, the gates read
 * them, and `POST /plans` accepts them. **And `@scp/iac` could not emit one by any route.** There
 * were no L2 constructs (`duration.ts` said so in a comment) and — the part that made it a blocker
 * rather than an ergonomic gap — no L1 hatch and no assembly: `synth()` did not build the three
 * collections at all, so even a hand-rolled declaration would have been dropped on the floor.
 *
 * D16(1) promises that no L2 construct may block reaching L1. For these three collections there was
 * no L1 to reach, which is a stronger failure than the promise anticipated: the whole increment-8
 * runtime was unreachable from a CDK program, and the only way to author a hook was to hand-write
 * manifest JSON and POST it — exactly the experience the construct library exists to replace.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Result (MEASURED) |
 * |---|---|
 * | `synth()` stops assembling `pipelineHooks` into `candidate` | 4 FAIL — (1), (2), (3), (7). This is the pre-existing bug, and it fails silently: the declaration simply is not in the output. |
 * | `addPipelineHook` spreads the caller's object AFTER the resolved `componentUrn` instead of before | (2) FAILS — a smuggled `componentUrn` attaches the hook to another component. **SURVIVED the first version of case (2)**, which passed a well-typed spec and asserted the URN matched: true under both spread orders. The smuggled key is what makes it discriminating. |
 * | the hook sort key drops `hookId` | (4) FAILS — same-kind siblings stop sorting deterministically, so declaration order changes the bytes. |
 * | `pipelineHooks` emitted as `[]` when empty instead of omitted | (5) FAILS. The omission is load-bearing: absent means UNMANAGED for this collection, so emitting `[]` would make a program that declares no hooks RETRACT every hook the component has — a disarmed gate, whose symptom is an absence of refusals. |
 *
 * The `rollouts`/`convergence` omissions are pinned by the same case (5); they follow the ORDINARY
 * rule (absent = empty = prune) because neither gates anything.
 */
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
    // The type `Omit`s `componentUrn`, so this is only reachable from JavaScript or through a cast
    // — which is exactly why it is worth pinning. The hatch spreads the caller's object FIRST and
    // writes the resolved URN AFTER, so the construct wins; the opposite order would let a stray
    // key silently attach a hook to a component the caller never passed, and every type-level
    // protection would be intact while it happened.
    //
    // THIS CASE WAS VACUOUS WHEN FIRST WRITTEN. It passed a well-typed spec and asserted the URN
    // matched, which is true under BOTH spread orders — the mutation that reverses them survived
    // it. The smuggled key is what makes the assertion discriminating.
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
      // A RUNTIME contract violation, not a type error: `maxAgeSeconds` is
      // `z.number().int().positive()`, whose refinements are invisible to TypeScript (the inferred
      // type is plain `number`), so `-1` typechecks and only Zod refuses it. That is exactly what
      // this case is for — synth must still VALIDATE the collection it now assembles, and D16(5)
      // requires the refusal to name the construct path.
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

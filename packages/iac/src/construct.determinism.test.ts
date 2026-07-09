import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  App,
  Component,
  Domain,
  ResourceConstruct,
  Service,
  Stack,
  Team,
  type ResourceProps
} from "./index.js";
import { canonicalJson } from "./canonical.js";

/**
 * The load-bearing determinism property (goal statement, Part A): `app.synth()`/`stack.synth()`
 * is a PURE function of the construct tree. This test asserts two things fast-check-style:
 *
 *  1. Re-synthesizing the SAME tree object twice gives identical output.
 *  2. Two INDEPENDENTLY-BUILT trees with the same logical content — same resources, same
 *     relationships — synthesize to byte-identical canonical JSON even when constructed in a
 *     DIFFERENT order, because identity is URN-keyed and both the objects/relationships arrays
 *     are sorted before being returned (construct.ts's `Stack.synth()`).
 */

const RESOURCE_CTORS = [Service, Component, Domain, Team] as const;

interface ResourceSpec {
  typeIndex: number;
  name: string;
  tier: "low" | "mid" | "high";
}

interface RelSpec {
  relType: "depends_on" | "consumes" | "owns";
  fromIndex: number;
  toIndex: number;
}

interface TreeSpec {
  stackName: string;
  resources: ResourceSpec[];
  relationships: RelSpec[];
}

const treeSpecArb: fc.Arbitrary<TreeSpec> = fc.record({
  stackName: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  resources: fc.array(
    fc.record({
      typeIndex: fc.integer({ min: 0, max: RESOURCE_CTORS.length - 1 }),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      tier: fc.constantFrom<"low" | "mid" | "high">("low", "mid", "high")
    }),
    { minLength: 1, maxLength: 6 }
  ),
  relationships: fc.array(
    fc.record({
      relType: fc.constantFrom<"depends_on" | "consumes" | "owns">(
        "depends_on",
        "consumes",
        "owns"
      ),
      fromIndex: fc.nat(),
      toIndex: fc.nat()
    }),
    { maxLength: 6 }
  )
});

/** Builds a Stack from `spec`, constructing resources in `order` (a permutation of resource indices). */
function buildStack(spec: TreeSpec, order: number[]): Stack {
  const app = new App();
  const stack = new Stack(app, spec.stackName);
  const constructs: ResourceConstruct[] = new Array(spec.resources.length) as ResourceConstruct[];

  for (const i of order) {
    const r = spec.resources[i];
    if (!r) continue;
    const Ctor = RESOURCE_CTORS[r.typeIndex] ?? Service;
    const props: ResourceProps = { name: r.name, properties: { tier: r.tier } };
    constructs[i] = new Ctor(stack, `res-${i}`, props);
  }

  for (const rel of spec.relationships) {
    const fromI = rel.fromIndex % spec.resources.length;
    const toI = rel.toIndex % spec.resources.length;
    if (fromI === toI) continue; // self-edges aren't interesting for this property
    const from = constructs[fromI];
    const to = constructs[toI];
    if (!from || !to) continue;
    if (rel.relType === "depends_on") from.dependsOn(to);
    else if (rel.relType === "consumes") from.consumes(to);
    else from.owns(to);
  }

  return stack;
}

describe("@scp/iac: synth determinism (fast-check)", () => {
  it("re-synthesizing the same tree twice is byte-identical", () => {
    fc.assert(
      fc.property(treeSpecArb, (spec) => {
        const order = spec.resources.map((_, i) => i);
        const stack = buildStack(spec, order);
        expect(canonicalJson(stack.synth())).toBe(canonicalJson(stack.synth()));
      }),
      { numRuns: 50 }
    );
  });

  it("two independently-built-but-equivalent trees synthesize identically regardless of construction order", () => {
    fc.assert(
      fc.property(treeSpecArb, (spec) => {
        const order = spec.resources.map((_, i) => i);
        const reversedOrder = [...order].reverse();

        const stackA = buildStack(spec, order);
        const stackB = buildStack(spec, reversedOrder);

        expect(canonicalJson(stackA.synth())).toBe(canonicalJson(stackB.synth()));
      }),
      { numRuns: 50 }
    );
  });

  it("URN derivation is deterministic and stable across synths for a construct without an explicit urn", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
        (stackName, resourceName) => {
          const app1 = new App();
          const stack1 = new Stack(app1, stackName);
          const svc1 = new Service(stack1, "fixed-id", { name: resourceName });

          const app2 = new App();
          const stack2 = new Stack(app2, stackName);
          const svc2 = new Service(stack2, "fixed-id", { name: resourceName });

          // Same (stack name, construct id) -> same URN, regardless of `name`/other props.
          expect(svc1.urn).toBe(svc2.urn);
        }
      ),
      { numRuns: 30 }
    );
  });
});

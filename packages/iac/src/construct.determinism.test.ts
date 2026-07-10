import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  App,
  Campaign,
  Component,
  Domain,
  Initiative,
  ReleaseTopology,
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

/**
 * Same determinism property as above (re-synthesizing the same tree twice is byte-identical;
 * two independently-built-but-equivalent trees synthesize identically regardless of construction
 * order), applied to the M5 constructs (`Campaign`/`Initiative`/`ReleaseTopology`). These can't
 * join `RESOURCE_CTORS` above — each needs its own typed props (`waves`, `targets`, `topology`)
 * rather than plain `ResourceProps` — so this is a small dedicated tree builder instead, varying
 * both the random content (names, wave mode/fan-in, descriptions) and, within real dependency
 * constraints (a Campaign's targets must exist before the Campaign does), the construction order.
 * (An `Initiative` carries no synth-declarable membership — `coordinates` is system-managed, added
 * via API only — so it's a standalone object here, same as any other resource construct.)
 */
interface CampaignTreeSpec {
  stackName: string;
  serviceAName: string;
  serviceBName: string;
  waveMode: "parallel" | "sequential";
  requiresFanIn: boolean;
  campaignDescription: string;
  initiativeDescription: string;
}

const campaignTreeSpecArb: fc.Arbitrary<CampaignTreeSpec> = fc.record({
  stackName: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  serviceAName: fc.string({ minLength: 1, maxLength: 20 }),
  serviceBName: fc.string({ minLength: 1, maxLength: 20 }),
  waveMode: fc.constantFrom<"parallel" | "sequential">("parallel", "sequential"),
  requiresFanIn: fc.boolean(),
  campaignDescription: fc.string({ minLength: 0, maxLength: 20 }),
  initiativeDescription: fc.string({ minLength: 0, maxLength: 20 })
});

/** Builds a stack with 2 services, a topology and campaign referencing them (built in either
 *  `"topology-first"` or `"campaign-first"` order — both legal, since neither depends on the
 *  other), and a standalone initiative — every construction order a real IaC author could legally
 *  choose, given `Campaign`/`ReleaseTopology` need the services to exist first. */
function buildCampaignTree(spec: CampaignTreeSpec, serviceOrder: ["a", "b"] | ["b", "a"], topologyOrder: "topology-first" | "campaign-first"): Stack {
  const app = new App();
  const stack = new Stack(app, spec.stackName);

  const services: { a?: ResourceConstruct; b?: ResourceConstruct } = {};
  for (const which of serviceOrder) {
    if (which === "a") services.a = new Service(stack, "svc-a", { name: spec.serviceAName });
    else services.b = new Service(stack, "svc-b", { name: spec.serviceBName });
  }
  const svcA = services.a!;
  const svcB = services.b!;

  function buildTopology(): ReleaseTopology {
    return new ReleaseTopology(stack, "topo", {
      name: "Topology",
      waves: [{ mode: spec.waveMode, targets: [svcA, svcB], requiresFanIn: spec.requiresFanIn }]
    });
  }
  function buildCampaign(): Campaign {
    return new Campaign(stack, "campaign", {
      name: "Campaign",
      targets: [svcA, svcB],
      description: spec.campaignDescription
    });
  }

  let campaign: Campaign;
  if (topologyOrder === "topology-first") {
    buildTopology();
    campaign = buildCampaign();
  } else {
    campaign = buildCampaign();
    buildTopology();
  }

  // Standalone — `coordinates` (initiative -> campaign membership) is system-managed and NOT
  // synth-declarable in IaC (M5 CRITICAL); membership is added via the authority-checked
  // `POST /initiatives/{id}/campaigns` API. `campaign` is still referenced above (its targets).
  void campaign;
  new Initiative(stack, "initiative", {
    name: "Initiative",
    description: spec.initiativeDescription
  });

  return stack;
}

describe("@scp/iac: synth determinism (fast-check) — Campaign/Initiative/ReleaseTopology", () => {
  it("re-synthesizing the same tree twice is byte-identical", () => {
    fc.assert(
      fc.property(campaignTreeSpecArb, (spec) => {
        const stack = buildCampaignTree(spec, ["a", "b"], "topology-first");
        expect(canonicalJson(stack.synth())).toBe(canonicalJson(stack.synth()));
      }),
      { numRuns: 50 }
    );
  });

  it("two independently-built-but-equivalent trees synthesize identically regardless of construction order", () => {
    fc.assert(
      fc.property(campaignTreeSpecArb, (spec) => {
        const stackA = buildCampaignTree(spec, ["a", "b"], "topology-first");
        const stackB = buildCampaignTree(spec, ["b", "a"], "campaign-first");
        expect(canonicalJson(stackA.synth())).toBe(canonicalJson(stackB.synth()));
      }),
      { numRuns: 50 }
    );
  });
});

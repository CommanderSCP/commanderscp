import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  Campaign,
  Domain,
  ReleaseTopology,
  ResourceConstruct,
  Service,
  Stack,
  Team,
  type ResourceProps
} from "./index.js";
import { canonicalJson } from "./canonical.js";

/** The load-bearing determinism property (goal statement, Part A). See docs/coordination-as-code.md §179. */

// Only the uniform `defineResourceConstruct` types belong here. See docs/coordination-as-code.md §180.
const RESOURCE_CTORS = [Service, Domain, Team] as const;

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
  const stack = new Stack(spec.stackName);
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
    if (fromI === toI) continue;
    const from = constructs[fromI];
    const to = constructs[toI];
    if (!from || !to) continue;
    if (rel.relType === "depends_on") from.dependsOn(to);
    else if (rel.relType === "consumes") from.consumes(to);
    else from.owns(to);
  }

  return stack;
}

describe("@scp/coordination-as-code: synth determinism (fast-check)", () => {
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
          const stack1 = new Stack(stackName);
          const svc1 = new Service(stack1, "fixed-id", { name: resourceName });

          const stack2 = new Stack(stackName);
          const svc2 = new Service(stack2, "fixed-id", { name: resourceName });

          // Same (stack name, construct id) -> same URN, regardless of `name`/other props.
          expect(svc1.urn).toBe(svc2.urn);
        }
      ),
      { numRuns: 30 }
    );
  });
});

/** Same determinism property as above. See docs/coordination-as-code.md §181. */
interface CampaignTreeSpec {
  stackName: string;
  serviceAName: string;
  serviceBName: string;
  waveMode: "parallel" | "sequential";
  requiresFanIn: boolean;
  campaignDescription: string;
}

const campaignTreeSpecArb: fc.Arbitrary<CampaignTreeSpec> = fc.record({
  stackName: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  serviceAName: fc.string({ minLength: 1, maxLength: 20 }),
  serviceBName: fc.string({ minLength: 1, maxLength: 20 }),
  waveMode: fc.constantFrom<"parallel" | "sequential">("parallel", "sequential"),
  requiresFanIn: fc.boolean(),
  campaignDescription: fc.string({ minLength: 0, maxLength: 20 })
});

/** Builds a stack with 2 services, a topology and campaign referencing them (built in either
 *  `"topology-first"` or `"campaign-first"` order — both legal, since neither depends on the
 *  other) — every construction order a real IaC author could legally choose, given
 *  `Campaign`/`ReleaseTopology` need the services to exist first. */
function buildCampaignTree(
  spec: CampaignTreeSpec,
  serviceOrder: ["a", "b"] | ["b", "a"],
  topologyOrder: "topology-first" | "campaign-first"
): Stack {
  const stack = new Stack(spec.stackName);

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

  // `campaign` is referenced above (its targets); the binding is kept for readability.
  void campaign;

  return stack;
}

describe("@scp/coordination-as-code: synth determinism (fast-check) — Campaign/ReleaseTopology", () => {
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

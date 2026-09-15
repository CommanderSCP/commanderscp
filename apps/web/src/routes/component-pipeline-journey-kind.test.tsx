import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentPipelineSourceMapping } from "@scp/schemas";
import type { ComponentPipelineStage } from "@scp/sdk";

/** THE DECLARED JOURNEY DECIDES WHAT THE LANE DRAWS (§8.14, migration 0112). See docs/web.md §317.
 *
 *  Before the declaration existed the only signal was the source's CATEGORY, and `CATEGORY_OF_TYPE`
 *  maps BOTH `image` and `chart` to `build` — so a chart-typed source, which is what the CONFIG node
 *  consumes, put Path A's whole head on a component that builds nothing (§8.2). These cases fix which
 *  reading wins, and the last group fixes that an UNDECLARED source still renders exactly as it did. */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { laneNodes, LANES, StageCardForTest } = await import("./component-pipeline");

const SOFTWARE = LANES.find((l) => l.key === "software")!;
const INFRA = LANES.find((l) => l.key === "infrastructure")!;

function source(
  over: Partial<ComponentPipelineSourceMapping> = {}
): ComponentPipelineSourceMapping {
  return {
    id: `019f0000-0000-7000-8000-00000000${Math.floor(Math.random() * 9000 + 1000)}`,
    sourceKind: "github",
    repoPattern: "acme/thing",
    pathPattern: null,
    refPattern: null,
    type: "configuration",
    category: "configuration",
    classification: null,
    mirrorOfShared: false,
    enabled: true,
    disabledUntil: null,
    effectivelyEnabled: true,
    url: null,
    scope: null,
    journeyKind: null,
    ...over
  };
}

/** Only the fields `laneNodes` reads. */
function data(sources: ComponentPipelineSourceMapping[]): Parameters<typeof laneNodes>[0] {
  return { sources, stages: [], registry: null, artifact: null, observedRun: null };
}

const kindsOf = (nodes: ReturnType<typeof laneNodes>) => nodes.map((n) => n.kind);
const sourceNodes = (nodes: ReturnType<typeof laneNodes>) =>
  nodes.filter(
    (n): n is Extract<ReturnType<typeof laneNodes>[number], { kind: "source" }> =>
      n.kind === "source"
  );

describe("laneNodes: the declared journey decides which node a source hangs under", () => {
  it("a `chart`-typed source declared `config` goes to the CONFIG node — the §8.2 defect, fixed", () => {
    // Its CATEGORY is `build` (CATEGORY_OF_TYPE maps chart -> build), so the pre-0112 reading put it
    // in the build arm and drew source -> build -> registry -> scan/sign on a component that builds
    // nothing. The declaration overrules the Category.
    const chart = source({ type: "chart", category: "build", journeyKind: "config" });
    const nodes = laneNodes(data([chart]), [], SOFTWARE, "commander");

    expect(kindsOf(nodes)).toEqual(["source"]);
    const [stageSource] = sourceNodes(nodes);
    expect(stageSource!.label, "no build arm ⇒ the source node is the journey's entry").toBe(
      "Source code"
    );
    expect(stageSource!.sources).toEqual([chart]);
  });

  it("the SAME source undeclared still draws the whole build spine — no behaviour change without a declaration", () => {
    // THE CONTROL for the case above. The estate's 148 mappings declare nothing, so this is what they
    // render today and must keep rendering until someone declares otherwise.
    const chart = source({ type: "chart", category: "build", journeyKind: null });
    const nodes = laneNodes(data([chart]), [], SOFTWARE, "commander");
    expect(kindsOf(nodes)).toEqual(["source", "build", "registry", "scan-sign", "source"]);
  });

  it("a source declared `source` draws the build spine even when its Category says configuration", () => {
    // The estate's actual shape: service repos are typed `configuration` because that is what ROUTES
    // them (§8.14), so the Category can never put them in the build arm. The declaration is the only
    // thing that can, and being able to say this without retyping is the entire point of the column.
    const svc = source({ type: "configuration", category: "configuration", journeyKind: "source" });
    const nodes = laneNodes(data([svc]), [], SOFTWARE, "commander");
    expect(kindsOf(nodes)).toEqual(["source", "build", "registry", "scan-sign", "source"]);
    const [buildHead, configNode] = sourceNodes(nodes);
    expect(buildHead!.label).toBe("Source code");
    expect(buildHead!.sources).toEqual([svc]);
    expect(configNode!.label).toBe("Config");
    expect(configNode!.sources, "it is the build arm's head, not also the config node").toEqual([]);
  });

  it("both arms declared over one repo: each source lands on its own node, and the spine is drawn once", () => {
    const svc = source({
      repoPattern: "acme/agentkit",
      type: "configuration",
      category: "configuration",
      journeyKind: "source"
    });
    const gitops = source({
      repoPattern: "acme/agentkit-gitops",
      type: "configuration",
      category: "configuration",
      journeyKind: "config"
    });
    const nodes = laneNodes(data([svc, gitops]), [], SOFTWARE, "commander");
    expect(kindsOf(nodes)).toEqual(["source", "build", "registry", "scan-sign", "source"]);
    const [buildHead, configNode] = sourceNodes(nodes);
    expect(buildHead!.sources).toEqual([svc]);
    expect(configNode!.sources).toEqual([gitops]);
  });

  it("a declared and an undeclared source coexist — the declaration places one, the Category the other", () => {
    const declaredSource = source({
      repoPattern: "acme/svc",
      category: "configuration",
      journeyKind: "source"
    });
    const undeclaredConfig = source({ repoPattern: "acme/gitops", category: "configuration" });
    const [buildHead, configNode] = sourceNodes(
      laneNodes(data([declaredSource, undeclaredConfig]), [], SOFTWARE, "commander")
    );
    expect(buildHead!.sources).toEqual([declaredSource]);
    expect(configNode!.sources).toEqual([undeclaredConfig]);
  });

  it("a declared journey NEVER conjures a build node in the infrastructure lane", () => {
    // That lane has no build arm by design — plan and apply are the same executor at each place — so a
    // `source` declaration there must land on the one node the lane has, not invent a step nothing runs.
    const infra = source({
      type: "infrastructure",
      category: "infrastructure",
      journeyKind: "source"
    });
    const nodes = laneNodes(data([infra]), [], INFRA, "commander");
    expect(kindsOf(nodes)).toEqual(["source"]);
    const [only] = sourceNodes(nodes);
    expect(only!.label).toBe("Source code");
    expect(only!.sources).toEqual([infra]);
  });

  it("the Category still decides LANE membership: a declared journey cannot drag a source across lanes", () => {
    // The trap in the first version of this fix. A configuration source declared `config` belongs to
    // the delivery lane; the infrastructure lane must not show it whatever it declares.
    const cfg = source({ category: "configuration", journeyKind: "config" });
    const infra = source({ category: "infrastructure", journeyKind: "source" });
    const softwareNodes = sourceNodes(laneNodes(data([cfg, infra]), [], SOFTWARE, "commander"));
    const infraNodes = sourceNodes(laneNodes(data([cfg, infra]), [], INFRA, "commander"));
    expect(softwareNodes.flatMap((n) => n.sources)).toEqual([cfg]);
    expect(infraNodes.flatMap((n) => n.sources)).toEqual([infra]);
  });
});

describe("StageCard: which path the release at this place took", () => {
  function stage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
    return {
      placement: { id: "019f0000-0000-7000-8000-00000000aaaa", urn: "urn:scp:o:placement:x/y" },
      order: 0,
      wave: { index: 0, name: "prod" },
      deploymentTarget: {
        id: "019f0000-0000-7000-8000-00000000bbbb",
        name: "prod",
        environment: "prod",
        region: null,
        substrate: null,
        account: null,
        cluster: null
      },
      stageName: "prod",
      maintainedBy: { domainId: null, name: "c", isSelf: true, role: "commander" },
      outpost: {
        state: "self",
        id: null,
        name: "c",
        trustTier: null,
        peerDomainId: null,
        peerRole: null
      },
      binding: null,
      bindings: [],
      current: null,
      currents: [
        {
          changeId: "019f0000-0000-7000-8000-0000000c0ffe",
          changeName: "push: agentkit",
          changeState: "accepted",
          waveName: "prod",
          targetStatus: "succeeded",
          type: "configuration",
          category: "configuration",
          journeyKind: null,
          correlationKey: null
        }
      ],
      gate: { policies: [], checks: [] },
      version: null,
      unknownFields: ["version"],
      ...over
    };
  }
  const html = (over: Partial<ComponentPipelineStage>) =>
    renderToStaticMarkup(<StageCardForTest detailsExpanded stage={stage(over)} />);
  const withKind = (journeyKind: "source" | "config" | null) =>
    html({ currents: [{ ...stage().currents[0]!, journeyKind }] });

  it("names the source-code path when the change declared it", () => {
    const out = withKind("source");
    expect(out).toContain('data-journey-kind="source"');
    expect(out).toContain("via the source-code path");
  });

  it("names the config path when the change declared that", () => {
    const out = withKind("config");
    expect(out).toContain('data-journey-kind="config"');
    expect(out).toContain("via the config path");
  });

  it("says NOTHING when the change declares no journey — an absence is not a claim of the config path", () => {
    expect(withKind(null)).not.toContain('data-testid="stage-current-journey"');
  });

  it("says nothing when nothing has released here", () => {
    const out = html({ currents: [] });
    expect(out).not.toContain('data-testid="stage-current-journey"');
    expect(out).toContain("nothing has released here");
  });
});

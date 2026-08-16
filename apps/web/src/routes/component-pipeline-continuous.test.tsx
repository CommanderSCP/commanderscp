import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage
} from "@scp/sdk";

/**
 * THE RENDERING HALF of "a component's pipeline is continuous, and it is the WHOLE journey".
 *
 * The server half (`apps/server/src/coordination/component-pipeline.integration.test.ts`) proves the
 * projection is well-defined for a component that has never released, and that it carries the stages
 * the component is NOT placed at. This file owns the part a browser can still undo: given that
 * response, does the UI actually PAINT a pipeline — does it keep "not observed" distinct from
 * "nothing deployed", and "not placed" distinct from "placed, nothing released yet"?
 *
 * Same reasoning and same mechanism as `service-board-honesty.test.tsx`: it runs in the plain unit
 * job (transitively required on PRs), needs no browser, and takes milliseconds. The E2E spec proves
 * the real route and real SDK; this proves the presentational contract.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | render the version cell as `{stage.version}` (empty when null) instead of the unknown treatment | the honesty test FAILS — a blank reads as "nothing deployed" |
 * | drop the `No executor` badge for a null binding | the unbound test FAILS |
 * | gate the stage list on `stage.current` being set | the never-released test FAILS with no stages painted — the old bug, in the UI |
 * | drop `unplacedStages` from `buildJourney`'s input | the interleaving test FAILS — the unplaced stage vanishes, which is the bug this view was rebuilt for |
 * | concatenate the two arrays with NO sort | the interleaving test FAILS — the journey paints gamma→prod→staging |
 * | group waves by NAME instead of wave index | the parallel-wave test FAILS — two same-named sequential waves merge into one row |
 * | drop the "Not placed" badge and the consequence line from `UnplacedStageCard` | the not-placed test FAILS — greyed alone is indistinguishable from quiet |
 * | drop the `registry` node from the software chain | the node-order test FAILS — the glossary puts registry between build and config, so omitting it misdraws the pipeline |
 * | stop deduping build bindings across placements | the dedupe test FAILS — a build repeated at every place would draw as several builds |
 * | render a `<a href="#">` when the server sent `url: null` | both link tests FAIL — a node must be clickable exactly when there is somewhere real to go |
 * | drop the "none required" text when a gate asks for no control | the gate test FAILS — a blank Checks line reads as "we cannot see checks", when none are configured |
 * | render the stage's deployment row from `stage.current` instead of the lane's | the per-lane release test already covers it; noted here because the deployment row is the SECOND consumer of that field |
 * | sort the journey by `wave.index` instead of `order` | ALL TESTS STAY GREEN, and that is CORRECT, not a gap: the server emits `order` as the union index with null-wave entries last, so the two orderings agree on every response it can produce. Recorded here so nobody "fixes" this by writing a test that pins an ordering the API does not promise |
 * | fall back to `deploymentTarget.name` when no facet value is declared | the no-facet test FAILS — the element appears carrying the name, which is exactly the "derived from what it is called" trap |
 * | join the facet as substrate · region · account · cluster | the four-value test FAILS on the fixed order |
 * | draw the registry node only on `buildsHere` (ignore `registry`) | the outpost-case and ambiguous node-order tests FAIL — a declared registry with no build draws nothing |
 * | draw the registry node for `state: "none"` too | the stated-absence test FAILS — a node appears for a fact the server said is absent |
 * | draw the registry node in the INFRA lane when a registry is declared | the infra-lane test FAILS |
 * | render `ambiguous` through the `declared` branch | the ambiguous header test FAILS — no count, no amber |
 * | link the registry name to `url + "/" + repository` (a guessed deep path) | the declared header test FAILS on the base-only href |
 * | drop the `instanceRole === "commander"` gate on the Scan & sign node | SIX tests FAIL — the outpost/undefined-role orders and every pre-§9.3 pinned chain grow a node this site never performs |
 * | draw the Scan & sign node in the infra lane too | the infra-lane test FAILS |
 * | mark a scan row `managed` from `scanner === "openscap"` instead of the wire's `managed` flag | the flag-not-name test FAILS — a trivy managed row loses its mark, an org openscap row gains one |
 * | make the Build tile reviewable whenever an artifact exists (ignore SBOM/PM) | the two "no click affordance" tests FAIL — a button appears with nothing to review |
 * | make the Scan & sign tile reviewable on scans only (ignore exports) | the exports-only test FAILS — a signed manifest is reviewable too |
 * | take the FIRST export as "newest" | the PM-line test FAILS — the older peer is named |
 * | take the FIRST digest as "latest" | the several-digests test FAILS |
 * | link an SBOM location whatever its scheme | the OCI-ref test FAILS — a non-URL is drawn as somewhere to go |
 * | render `artifact: null` through the "not observed" (unknown) branch of the Registry body | the absence-vs-unknown test FAILS |
 * | word the outpost's absent PM the way the commander's is | the outpost test FAILS — the tile would claim "not created" about a manifest another site may well have imported |
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

/** SourceNode's mapping rows mount a delete mutation, so a QueryClient must be in scope even for a
 *  static render — same helper the writes test uses. */
function renderWithQueryClient(node: React.JSX.Element): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

const {
  StageCardForTest,
  UnplacedStageCardForTest,
  SourceNodeForTest,
  SourceOpenCloseDialogForTest,
  WaveRowForTest,
  arrowInto,
  RegistryNodeForTest,
  BuildNodeForTest,
  BuildReviewBody,
  ScanSignNodeForTest,
  ScanSignReviewBody,
  buildJourney,
  laneNodes,
  sharedConnectorVisible,
  targetFacetValues,
  sbomLine,
  sbomLocationHref,
  shortDigest,
  LANES
} = await import("./component-pipeline");

const SOFTWARE_LANE = LANES.find((l) => l.key === "software")!;

/** The infrastructure lane. `StageCardForTest` defaults to the software lane (`LANES[0]`). */
const INFRA_LANE = LANES.find((l) => l.key === "infrastructure")!;

function stage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
  return {
    placement: { id: "019f0000-0000-7000-8000-00000000aaaa", urn: "urn:scp:o:placement:x/y" },
    order: 0,
    wave: { index: 0, name: "prod" },
    deploymentTarget: {
      id: "019f0000-0000-7000-8000-00000000bbbb",
      name: "prod",
      environment: "prod",
      region: "nyc3",
      substrate: null,
      account: null,
      cluster: null
    },
    stageName: "commercial-nyc3-prod",
    maintainedBy: { domainId: null, name: "commercial", isSelf: true, role: "commander" },
    binding: {
      externalRef: "my-app",
      type: "configuration",
      category: "configuration",
      url: null,
      executionSystemId: "019f0000-0000-7000-8000-00000000cccc",
      executionSystemName: "argocd-prod"
    },
    bindings: [
      {
        externalRef: "my-app",
        type: "configuration",
        category: "configuration",
        url: null,
        executionSystemId: "019f0000-0000-7000-8000-00000000cccc",
        executionSystemName: "argocd-prod"
      }
    ],
    current: null,
    currents: [],
    gate: { policies: [], checks: [] },
    version: null,
    unknownFields: ["version"],
    ...over
  };
}

function unplaced(
  over: Partial<ComponentPipelineUnplacedStage> = {}
): ComponentPipelineUnplacedStage {
  return {
    order: 1,
    wave: { index: 1, name: "prod" },
    deploymentTarget: {
      id: "019f0000-0000-7000-8000-00000000dddd",
      name: "prod (DOKS hosted)",
      environment: "prod",
      region: "nyc3",
      substrate: null,
      account: null,
      cluster: null
    },
    stageName: "commercial-nyc3-prod",
    maintainedBy: { domainId: null, name: "commercial", isSelf: true, role: "commander" },
    ...over
  };
}

describe("a component pipeline stage renders honestly", () => {
  it("paints a stage that has NEVER released — the whole point", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html, "the stage must render from the placement alone").toContain(
      "commercial-nyc3-prod"
    );
    expect(html, "and say plainly that nothing has released, not go blank").toContain(
      "nothing has released here"
    );
  });

  it("says the version is NOT OBSERVED rather than leaving it blank", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(
      html,
      "an empty version cell reads as 'nothing is deployed' — a claim nobody has made (Phase 4a is unbuilt)"
    ).toContain("not observed yet");
  });

  it("renders a real version once one IS observed", () => {
    // Guards the other direction: the unknown treatment must not swallow a genuine value when
    // Phase 4a lands and `unknownFields` no longer lists it.
    const html = renderToStaticMarkup(
      <StageCardForTest stage={stage({ version: "v1.4.2", unknownFields: [] })} />
    );
    expect(html).toContain("v1.4.2");
    expect(html).not.toContain("not observed yet");
  });

  it("flags an UNBOUND placement loudly", () => {
    // `bindings: []` is what "unbound" MEANS — clearing only `binding` leaves a stage that still has
    // a pipeline, and the badge correctly would not fire. Setting both keeps the fixture honest
    // about the state it claims to describe.
    const html = renderToStaticMarkup(
      <StageCardForTest stage={stage({ binding: null, bindings: [] })} />
    );
    expect(
      html,
      "an unbound placement fake-succeeds under stage-shaped compilation (ADR-0006 case (a)) — it cannot be silent"
    ).toContain("No executor");
  });

  it("splits a stage's pipelines into LANES — software here, infra there", () => {
    // The owner-reported gap: "Each component needs 2 pipelines: infra & software". A stage runs
    // them as separate pipelines (ADR-0007 Category), and the first version of this card rendered
    // `binding` alone — one of them, with no sign of the rest. Rendering all three in ONE card was
    // the next wrong answer: it says a component has one pipeline that happens to do three things.
    const threePipelines = stage({
      bindings: [
        {
          externalRef: "deploy-app",
          type: "configuration",
          category: "configuration",
          url: null,
          executionSystemId: null,
          executionSystemName: "argocd-prod"
        },
        {
          externalRef: "build-app",
          type: "image",
          category: "build",
          url: null,
          executionSystemId: null,
          executionSystemName: "github"
        },
        {
          externalRef: "tf-app",
          type: "infrastructure",
          category: "infrastructure",
          url: null,
          executionSystemId: null,
          executionSystemName: "argo-workflows"
        }
      ]
    });

    const software = renderToStaticMarkup(<StageCardForTest stage={threePipelines} />);
    expect(software, "the config sync is what executes AT a deploy stage").toContain("deploy-app");
    expect(
      software,
      "the infra pipeline belongs to the OTHER lane — showing it here is what made one component look like it had a single pipeline"
    ).not.toContain("tf-app");
    expect(
      software,
      "and the BUILD is a node of its own ahead of the stages, not something that happens at each of them (glossary: build → registry → config → gamma → prod)"
    ).not.toContain("build-app");

    const infra = renderToStaticMarkup(
      <StageCardForTest stage={threePipelines} lane={INFRA_LANE} />
    );
    expect(infra).toContain("tf-app");
    expect(infra).not.toContain("build-app");
    expect(infra).not.toContain("deploy-app");
    expect(infra, "and a stage with pipelines is never the unbound alarm").not.toContain(
      "No executor"
    );
  });

  it("says a stage is 'not managed by this pipeline' WITHOUT raising the unbound alarm", () => {
    // A component whose substrate someone else manages is ordinary. Painting the ADR-0006 case (a)
    // alarm over it would fire on nearly every component and train the alarm away.
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} lane={INFRA_LANE} />);
    expect(html).toContain("not managed by this pipeline here");
    expect(
      html,
      "'No executor' means bound to NOTHING anywhere — a different and genuinely alarming state"
    ).not.toContain("No executor");
  });

  it("shows each lane's OWN last release, never the newest across all of them", () => {
    // Two pipelines release independently. Crediting the infra lane with the software pipeline's
    // release makes a lane that has never run look up to date — the same collapse as `bindings[0]`,
    // one field over.
    const withHistory = stage({
      bindings: [
        {
          externalRef: "deploy-app",
          type: "configuration",
          category: "configuration",
          url: null,
          executionSystemId: null,
          executionSystemName: "argocd-prod"
        },
        {
          externalRef: "tf-app",
          type: "infrastructure",
          category: "infrastructure",
          url: null,
          executionSystemId: null,
          executionSystemName: "argo-workflows"
        }
      ],
      currents: [
        {
          changeId: "019f0000-0000-7000-8000-0000000c0ffe",
          changeName: "ship-the-app",
          changeState: "accepted",
          waveName: "prod",
          targetStatus: "succeeded",
          type: "configuration",
          category: "configuration"
        }
      ]
    });

    expect(renderToStaticMarkup(<StageCardForTest stage={withHistory} />)).toContain(
      "ship-the-app"
    );
    const infra = renderToStaticMarkup(<StageCardForTest stage={withHistory} lane={INFRA_LANE} />);
    expect(
      infra,
      "the infra pipeline has never run here, and must say so rather than borrow the software release"
    ).toContain("nothing has released here");
    expect(infra).not.toContain("ship-the-app");
  });
});

describe("a stage the component is NOT placed at", () => {
  it("says 'not placed' in words, and says what that MEANS", () => {
    const html = renderToStaticMarkup(<UnplacedStageCardForTest stage={unplaced()} />);
    expect(html, "greyed alone is indistinguishable from 'quiet'").toContain("Not placed");
    expect(
      html,
      "the consequence is the point — this is usually the most important fact on the page"
    ).toContain("never reach this stage");
    expect(html, "and it is still a named stage, not an id").toContain("commercial-nyc3-prod");
  });

  it("shows NO executor row — 'no placement' must never be painted as the unbound ALARM", () => {
    const html = renderToStaticMarkup(<UnplacedStageCardForTest stage={unplaced()} />);
    expect(
      html,
      "'No executor' means a bound-to-nothing placement that would fake-succeed (ADR-0006 case (a)); an absent placement is not that, and crying wolf on every component that simply does not go to prod would train the alarm away"
    ).not.toContain("No executor");
    expect(html, "nor a version it cannot have observed").not.toContain("not observed yet");
    expect(html, "nor a last-release line for a stage nothing can release to").not.toContain(
      "nothing has released here"
    );
  });
});

describe("the target's SUBSTRATE FACET — read from the target's declared properties, never its name", () => {
  // pipeline-substrate-registry-scan.md §9.1: `substrate`, `account`, `region`, `cluster` are
  // typed, optional string properties of a deployment-target (migration 0065). A quiet line beside
  // the hint joins ONLY the values that are declared. Null is an ABSENCE of a declaration, not an
  // unknown observation, so it earns no `—` and no badge — and nothing declared means no line at
  // all. `name` is never read: `us-east-1-prod (k8s)` looks parseable and is exactly the trap.
  const facetOf = (html: string): string | null =>
    html.match(/data-testid="pipeline-target-facet"[^>]*>([^<]*)</)?.[1] ?? null;

  it("joins all four values in the fixed order substrate · account · region · cluster", () => {
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          deploymentTarget: {
            id: "019f0000-0000-7000-8000-00000000bbbb",
            name: "us-east-1-prod (k8s)",
            environment: "prod",
            region: "us-east-1",
            substrate: "aws",
            account: "210987654321",
            cluster: "prod-eks"
          }
        })}
      />
    );
    expect(facetOf(html)).toBe("aws · 210987654321 · us-east-1 · prod-eks");
    expect(html, "the hint sentence the older test pins is still there, beside it").toContain(
      "deploys to us-east-1-prod (k8s)"
    );
  });

  it("joins ONLY the present values — no placeholder, no dangling separator", () => {
    // An on-prem cluster: substrate + cluster, no account, no region. Two values, one separator.
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          deploymentTarget: {
            id: "019f0000-0000-7000-8000-00000000bbbb",
            name: "field-cluster",
            environment: "prod",
            region: null,
            substrate: "kubernetes",
            account: null,
            cluster: "field-eks"
          }
        })}
      />
    );
    expect(facetOf(html)).toBe("kubernetes · field-eks");
    expect(facetOf(html), "null is an absence, not an unknown — no em-dash").not.toContain("—");
  });

  it("renders NO facet element when nothing is declared, and never falls back to the name", () => {
    // The name is deliberately shaped like something a naive renderer would parse into a facet.
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          deploymentTarget: {
            id: "019f0000-0000-7000-8000-00000000bbbb",
            name: "aws-us-east-1-prod-eks",
            environment: "prod",
            region: null,
            substrate: null,
            account: null,
            cluster: null
          }
        })}
      />
    );
    expect(html, "no values → no element, not an empty span").not.toContain(
      "pipeline-target-facet"
    );
    // The name legitimately appears in the title and the hint; what must NOT happen is a facet
    // element carrying any of it. Assert on the helper directly for the same target.
    expect(
      targetFacetValues({ substrate: null, account: null, region: null, cluster: null }),
      "the helper never derives anything from a name it is not even given"
    ).toEqual([]);
  });

  it("appears on an UNPLACED stage too — the target is the stage there, and it still has a substrate", () => {
    const html = renderToStaticMarkup(
      <UnplacedStageCardForTest
        stage={unplaced({
          deploymentTarget: {
            id: "019f0000-0000-7000-8000-00000000dddd",
            name: "prod (DOKS hosted)",
            environment: "prod",
            region: "nyc3",
            substrate: "kubernetes",
            account: null,
            cluster: "doks-prod"
          }
        })}
      />
    );
    expect(facetOf(html)).toBe("kubernetes · nyc3 · doks-prod");
    expect(html, "the older hint sentence is still beside it").toContain(
      "declared at prod (DOKS hosted)"
    );
  });

  it("does not read the name even when the facet is PARTLY declared", () => {
    // Region declared, substrate not — the name says "k8s" and the line must not.
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          deploymentTarget: {
            id: "019f0000-0000-7000-8000-00000000bbbb",
            name: "nyc3 (k8s)",
            environment: "prod",
            region: "nyc3",
            substrate: null,
            account: null,
            cluster: null
          }
        })}
      />
    );
    expect(facetOf(html)).toBe("nyc3");
  });
});

describe("the journey rejoins the response's two arrays", () => {
  it("interleaves placed and unplaced stages by `order`, not by array", () => {
    // gamma placed, staging unplaced, prod placed — the arrays alternate, so a naive
    // "stages then unplacedStages" concatenation would paint the pipeline in the wrong order.
    const waves = buildJourney({
      stages: [
        stage({ order: 0, wave: { index: 0, name: "gamma" } }),
        stage({
          order: 2,
          wave: { index: 2, name: "prod" },
          placement: { id: "019f0000-0000-7000-8000-00000000eeee", urn: "urn:scp:o:placement:x/z" }
        })
      ],
      unplacedStages: [unplaced({ order: 1, wave: { index: 1, name: "staging" } })]
    });

    expect(waves.map((w) => w.name)).toEqual(["gamma", "staging", "prod"]);
    expect(
      waves.map((w) => w.entries[0]!.placed),
      "and each keeps its own placed/unplaced identity through the rejoin"
    ).toEqual([true, false, true]);
  });

  it("groups a PARALLEL wave into one row, and never merges two waves that share a name", () => {
    const waves = buildJourney({
      stages: [
        stage({ order: 0, wave: { index: 0, name: "canary" } }),
        stage({
          order: 1,
          wave: { index: 0, name: "canary" },
          placement: { id: "019f0000-0000-7000-8000-00000000eeee", urn: "urn:scp:o:placement:x/z" }
        }),
        stage({
          order: 2,
          // SAME name, DIFFERENT index — the topology declared a sequence, and grouping on the name
          // would draw it as one parallel wave.
          wave: { index: 1, name: "canary" },
          placement: { id: "019f0000-0000-7000-8000-00000000ffff", urn: "urn:scp:o:placement:x/w" }
        })
      ],
      unplacedStages: []
    });

    expect(waves.map((w) => w.entries.length)).toEqual([2, 1]);
  });

  it("puts an OFF-TOPOLOGY placement (no wave) in its own trailing row", () => {
    const waves = buildJourney({
      stages: [
        stage({ order: 0, wave: { index: 0, name: "gamma" } }),
        stage({
          order: 1,
          wave: null,
          placement: { id: "019f0000-0000-7000-8000-00000000eeee", urn: "urn:scp:o:placement:x/z" }
        }),
        stage({
          order: 2,
          wave: null,
          placement: { id: "019f0000-0000-7000-8000-00000000ffff", urn: "urn:scp:o:placement:x/w" }
        })
      ],
      unplacedStages: []
    });

    expect(waves.map((w) => w.waveIndex)).toEqual([0, null]);
    expect(
      waves[1]!.entries.length,
      "both off-topology placements share ONE row rather than each claiming a wave of its own"
    ).toBe(2);
  });
});

function source(over: Partial<ComponentPipelineResponse["sources"][number]> = {}) {
  return {
    id: "019f0000-0000-7000-8000-00000000e001",
    sourceKind: "github",
    repoPattern: "AgentKitProject/agentkit",
    pathPattern: "services/market/**",
    refPattern: null,
    type: "configuration",
    category: "configuration" as const,
    classification: null,
    mirrorOfShared: false,
    // migration 0063: every mapping is enabled by default; tests that care about the disabled
    // treatment override this explicitly, same as every other field here.
    enabled: true,
    disabledUntil: null,
    effectivelyEnabled: true,
    url: "https://github.com/AgentKitProject/agentkit",
    ...over
  };
}

describe("a pipeline is a CHAIN OF NODES, in the order the glossary defines", () => {
  // GLOSSARY: "build → registry → config → gamma → prod for a software pipeline; plan → gate →
  // apply for an infrastructure pipeline". Owner, 2026-08-03: "Each part of the pipeline should be
  // a node. Source code repo should be its own node, image/rpm repo should be its own node."
  const waves = buildJourney({
    stages: [stage({ order: 0, wave: { index: 0, name: "gamma" } })],
    unplacedStages: []
  });

  it("puts source, build and registry AHEAD of the deploy stages when a build exists", () => {
    const nodes = laneNodes(
      {
        sources: [
          source({ id: "s1", type: "image", category: "build" }),
          source({ id: "s2", type: "configuration", category: "configuration" })
        ],
        stages: [
          stage({
            bindings: [
              {
                externalRef: "build-app",
                type: "image",
                category: "build",
                url: null,
                executionSystemId: null,
                executionSystemName: "github"
              }
            ]
          })
        ]
      },
      waves,
      SOFTWARE_LANE
    );

    expect(
      nodes.map((n) => n.kind),
      "the repo and the registry are NODES of the pipeline, not metadata hung off it"
    ).toEqual(["source", "build", "registry", "source", "wave"]);
    expect(
      nodes.filter((n) => n.kind === "source").map((n) => (n as { label: string }).label),
      "the first source node is the code, the second is the config commit that triggers the deploy"
    ).toEqual(["Source code", "Config"]);
  });

  it("DEDUPES a build binding repeated at every placement into ONE build node", () => {
    // A build happens once per release, not once per place, whatever scope its binding hangs off.
    const build = {
      externalRef: "build-app",
      type: "image",
      category: "build" as const,
      url: null,
      executionSystemId: null,
      executionSystemName: "github"
    };
    const nodes = laneNodes(
      { sources: [], stages: [stage({ bindings: [build] }), stage({ bindings: [build] })] },
      waves,
      SOFTWARE_LANE
    );
    const buildNode = nodes.find((n) => n.kind === "build") as { bindings: unknown[] };
    expect(buildNode.bindings).toHaveLength(1);
  });

  it("OMITS build and registry when this component has no build pipeline at all", () => {
    // All 148 source mappings on the live estate are `configuration`: for most components the
    // software pipeline genuinely starts at a config change, and a permanently-empty "Build" box
    // would be decoration claiming a step that nothing runs.
    const nodes = laneNodes({ sources: [source()], stages: [stage()] }, waves, SOFTWARE_LANE);
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
    expect(
      (nodes[0] as { label: string }).label,
      "and with no build ahead of it, the config repo IS the source code node"
    ).toBe("Source code");
  });

  it("gives the INFRASTRUCTURE lane no build or registry node — it has neither", () => {
    // plan → gate → apply. Plan and apply are the same executor acting at each place, so there is
    // no hoisted node, and infra produces no registry artifact to advance by digest.
    const nodes = laneNodes(
      {
        sources: [source({ id: "s3", type: "infrastructure", category: "infrastructure" })],
        stages: [
          stage({
            bindings: [
              {
                externalRef: "tf-app",
                type: "infrastructure",
                category: "infrastructure",
                url: null,
                executionSystemId: null,
                executionSystemName: "argo-workflows"
              }
            ]
          })
        ]
      },
      waves,
      INFRA_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
  });

  it("routes each source rule to the lane that owns it", () => {
    const sources = [
      source({ id: "s1", type: "image", category: "build" }),
      source({ id: "s2", type: "configuration", category: "configuration" }),
      source({ id: "s3", type: "infrastructure", category: "infrastructure" })
    ];
    const softwareRepos = laneNodes({ sources, stages: [stage()] }, waves, SOFTWARE_LANE)
      .filter((n) => n.kind === "source")
      .flatMap((n) => (n as { sources: { id: string }[] }).sources.map((s) => s.id));
    const infraRepos = laneNodes({ sources, stages: [stage()] }, waves, INFRA_LANE)
      .filter((n) => n.kind === "source")
      .flatMap((n) => (n as { sources: { id: string }[] }).sources.map((s) => s.id));

    expect(softwareRepos).toEqual(["s1", "s2"]);
    expect(
      infraRepos,
      "the infra repo belongs to the infra pipeline, not beside the app's"
    ).toEqual(["s3"]);
  });

  // pipeline-substrate-registry-scan.md §9.2: the registry node is drawn when the component builds
  // here OR when a registry is DECLARED here — an outpost builds nothing, but its registry still
  // receives the promoted image, and leaving the node out there would say the image lands nowhere.
  it("draws the registry node for a DECLARED registry even when nothing builds here (the outpost case)", () => {
    const nodes = laneNodes(
      { sources: [source()], stages: [stage()], registry: registryDeclared() },
      waves,
      SOFTWARE_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["registry", "source", "wave"]);
    const node = nodes[0] as { registry: { name: string | null } | null };
    expect(node.registry?.name, "and the node CARRIES the fact, so the tile can name it").toBe(
      "hq-registry"
    );
  });

  it("draws it for an AMBIGUOUS registry too — a stated fact, not a chosen one", () => {
    const nodes = laneNodes(
      {
        sources: [source()],
        stages: [stage()],
        registry: {
          state: "ambiguous",
          executionSystemId: null,
          name: null,
          kind: null,
          url: null,
          repository: null,
          edgeCount: 2
        }
      },
      waves,
      SOFTWARE_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["registry", "source", "wave"]);
  });

  it("does NOT draw it for `state: none` without a build — a stated absence draws no node", () => {
    const nodes = laneNodes(
      {
        sources: [source()],
        stages: [stage()],
        registry: {
          state: "none",
          executionSystemId: null,
          name: null,
          kind: null,
          url: null,
          repository: null,
          edgeCount: 0
        }
      },
      waves,
      SOFTWARE_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
  });

  it("keeps the registry between build and config when both a build AND a declared registry exist", () => {
    const nodes = laneNodes(
      {
        sources: [source({ id: "s1", type: "image", category: "build" }), source()],
        stages: [stage()],
        registry: registryDeclared()
      },
      waves,
      SOFTWARE_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "build", "registry", "source", "wave"]);
    const node = nodes[2] as { registry: { state: string } | null };
    expect(node.registry?.state).toBe("declared");
  });

  it("never draws it in the INFRASTRUCTURE lane, declared registry or not", () => {
    const nodes = laneNodes(
      {
        sources: [source({ id: "s3", type: "infrastructure", category: "infrastructure" })],
        stages: [stage()],
        registry: registryDeclared()
      },
      waves,
      INFRA_LANE
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
  });
});

/** A `declared` registry — one `publishes_to` edge, joined to its execution-system. */
function registryDeclared(
  over: Partial<NonNullable<ComponentPipelineResponse["registry"]>> = {}
): NonNullable<ComponentPipelineResponse["registry"]> {
  return {
    state: "declared",
    executionSystemId: "019f0000-0000-7000-8000-00000000fff0",
    name: "hq-registry",
    kind: "gitea",
    url: "https://registry.hq.invalid",
    repository: "acme/checkout-api",
    edgeCount: 1,
    ...over
  };
}

describe("the REGISTRY node names the registry this component publishes to, at this site", () => {
  // §9.2: the header states `declared | ambiguous | none`. It is READ off `publishes_to`, never
  // the image binding (that names what BUILDS the artifact). `ambiguous` is stated, not resolved.
  it("declared → `name (kind) · repository`, the name a console link to the registry's BASE url", () => {
    const html = renderToStaticMarkup(<RegistryNodeForTest registry={registryDeclared()} />);
    expect(html).toContain('data-testid="pipeline-node-registry"');
    expect(html).toContain('data-registry-state="declared"');
    const name = html.match(/data-testid="pipeline-registry-name"[^>]*>(.*?)<\/span>/)?.[1] ?? "";
    expect(name, "the name and kind are read off the execution-system").toContain(
      "hq-registry (gitea)"
    );
    expect(html, "the repository is the edge's own property, after a separator").toMatch(
      /hq-registry \(gitea\).*·.*acme\/checkout-api/
    );
    expect(html, "the link is the console base — no guessed deep path").toContain(
      'href="https://registry.hq.invalid"'
    );
    expect(html, "the body is still an explicit unknown until §9.3 lands a digest").toContain(
      "not observed yet"
    );
  });

  it("declared with no url → plain text, no link (a node is clickable exactly when there is somewhere real to go)", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared({ url: null, repository: null })} />
    );
    expect(html).toContain("hq-registry (gitea)");
    expect(html).not.toContain("<a ");
    expect(html, "no repository → no dangling separator").not.toMatch(
      /\(gitea\)<\/span><\/span> ·/
    );
  });

  it("ambiguous → says HOW MANY, in the amber attention tone, and does not name either", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest
        registry={{
          state: "ambiguous",
          executionSystemId: null,
          name: null,
          kind: null,
          url: null,
          repository: null,
          edgeCount: 2
        }}
      />
    );
    expect(html).toContain("2 registries declared — ambiguous");
    expect(html).toContain('data-registry-state="ambiguous"');
    expect(html, "design-system amber for 'operator should notice'").toMatch(
      /class="[^"]*text-amber-700[^"]*"[^>]*data-testid="pipeline-registry-state"/
    );
    expect(html, "and a tooltip that says what to do").toMatch(/title="[^"]*publishes_to[^"]*"/);
    expect(html).not.toContain("pipeline-registry-name");
  });

  it("none → 'no registry declared for this component here' — an absence, not an unknown", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest
        registry={{
          state: "none",
          executionSystemId: null,
          name: null,
          kind: null,
          url: null,
          repository: null,
          edgeCount: 0
        }}
      />
    );
    expect(html).toContain("no registry declared for this component here");
    expect(html).toContain('data-registry-state="none"');
    expect(html, "no amber: a stated absence is not an attention signal").not.toContain(
      "text-amber-700"
    );
    expect(html).not.toContain("pipeline-registry-name");
  });

  it("older server (no `registry` on the wire) → the pre-§9.2 sentence, no state claimed", () => {
    const html = renderToStaticMarkup(<RegistryNodeForTest registry={null} />);
    expect(html).toContain("where the built artifact lands");
    expect(html).not.toContain("pipeline-registry-state");
  });
});

describe("a node is clickable exactly when there is somewhere real to go", () => {
  // Owner, 2026-08-03: "if I click the code source, it should take me to the repo … The service
  // takes me to ArgoCD". The other half of that is the honesty rule: a node whose address the
  // server could not KNOW renders as plain text, because a dead link in an operator console is a
  // claim that something is over there.
  it("links a source node to its repo", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    // The stage card's executor row carries the binding url; the fixture's binding has none.
    expect(html).not.toContain("<a");
  });

  it("links a stage's executor to its console, and leaves it plain when unknown", () => {
    const linked = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          bindings: [
            {
              externalRef: "market",
              type: "configuration",
              category: "configuration",
              url: "https://argocd.example.com/applications/market",
              executionSystemId: null,
              executionSystemName: "argocd-prod"
            }
          ]
        })}
      />
    );
    expect(linked).toContain('href="https://argocd.example.com/applications/market"');
    expect(linked, "and it opens away from the pipeline view rather than replacing it").toContain(
      'target="_blank"'
    );

    const plain = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          bindings: [
            {
              externalRef: "market",
              type: "configuration",
              category: "configuration",
              url: null,
              executionSystemId: null,
              executionSystemName: "argocd-prod"
            }
          ]
        })}
      />
    );
    expect(
      plain,
      "an execution system with no recorded address gives no link — guessing one sends an operator nowhere"
    ).not.toContain("<a ");
    expect(plain, "but the executor is still NAMED, not hidden").toContain("market");
  });
});

describe("the entry gate — a SUBNODE of the stage it governs", () => {
  // Owner, 2026-08-04: a gate is not a step a release passes through, it is a condition on entering
  // one place — so it hangs off the stage rather than doubling the length of the chain.
  const gated = (
    over: Partial<ComponentPipelineStage["gate"]["policies"][number]> = {}
  ): ComponentPipelineStage["gate"] => ({
    checks: [],
    policies: [
      {
        name: "prod-gate",
        enforcement: "required",
        requireControls: [],
        requireApprovals: [{ count: 1, fromRole: "Owner", scope: "organization" }],
        ...over
      }
    ]
  });

  it("names the approval and says NO CHECK is required, rather than going quiet", () => {
    // Measured 2026-08-10: every live policy requires one Owner approval and asks for NO automated
    // check (0 control bindings, 0 control runs estate-wide). A blank would be indistinguishable
    // from a view that cannot see checks; the truth is that none are configured.
    const html = renderToStaticMarkup(<StageCardForTest stage={stage({ gate: gated() })} />);
    expect(html).toContain("Owner");
    expect(html, "the policy that imposes it is named — principle 6").toContain("prod-gate");
    expect(html).toContain("no automated check required");
  });

  it("renders each required CHECK with a mark AND a word for its state", () => {
    // Owner, 2026-08-04: "not started, in progress, check marks and failed marks for tests".
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          gate: {
            policies: gated({ name: "scan-gate", requireControls: ["c1", "c2", "c3", "c4"] })
              .policies,
            checks: [
              { controlId: "c1", name: "trivy-high", status: "pass", changeId: null },
              { controlId: "c2", name: "unit-tests", status: "fail", changeId: null },
              { controlId: "c3", name: "e2e", status: "pending", changeId: null },
              { controlId: "c4", name: "load-test", status: "not_started", changeId: null }
            ]
          }
        })}
      />
    );
    expect(html).toContain("trivy-high");
    expect(html).toContain("unit-tests");
    expect(html, "a passed check carries a tick").toContain('data-status="pass"');
    expect(html, "and a failed one a cross").toContain('data-status="fail"');
    expect(html).not.toContain("no automated check required");

    // THE DISTINCTION THAT MATTERS: "nothing is here to run" and "it is here and hasn't answered"
    // are different facts, and one grey dot for both is the confusion this view removes.
    expect(html).toContain("in progress — no outcome reported yet");
    expect(html).toContain("not started — nothing is at this gate");
  });

  it("shows a DANGLING control reference loudly rather than dropping it", () => {
    // A policy requiring a control that no longer exists blocks every release through this stage.
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          gate: {
            policies: gated({ requireControls: ["gone"] }).policies,
            checks: [{ controlId: "gone", name: null, status: "not_started", changeId: null }]
          }
        })}
      />
    );
    expect(html).toContain("(missing control)");
  });

  it("says plainly when NOTHING gates a stage", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(
      html,
      "an ungated stage is a real state — and different from 'we did not look'"
    ).toContain("Entry gate");
    expect(html).toContain("a release enters as soon as the previous stage succeeds");
  });

  it("belongs to the STAGE, so two placements in one wave keep their own gates", () => {
    // As a wave-level node this had to merge several placements' policies into one; as a subnode
    // each target simply carries its own, which is also what the server resolved.
    const withGate = renderToStaticMarkup(<StageCardForTest stage={stage({ gate: gated() })} />);
    const without = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(withGate).toContain("prod-gate");
    expect(without, "the ungated sibling is not tarred with its neighbour's gate").not.toContain(
      "prod-gate"
    );
  });
});

describe("the DEPLOYMENT at a stage", () => {
  it("shows the deployment outcome in words, not only as an arrow colour", () => {
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          currents: [
            {
              changeId: "019f0000-0000-7000-8000-0000000c0ffe",
              changeName: "ship-it",
              changeState: "accepted",
              waveName: "prod",
              targetStatus: "succeeded",
              type: "configuration",
              category: "configuration"
            }
          ]
        })}
      />
    );
    expect(html).toContain("succeeded");
    expect(html, "and which wave carried it").toContain("wave prod");
  });

  it("says 'never deployed here' rather than leaving the row blank", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html).toContain("never deployed here");
  });
});

describe("each node kind is visually distinct and self-explaining", () => {
  // Owner, 2026-08-04: "different symbols for the different pipeline node types … they look very
  // bare and basic". Every node used to be an identical white rectangle, so the KIND of each step
  // was carried only by its title text.
  it("gives every node kind its OWN glyph", () => {
    const src = laneNodes(
      {
        sources: [source({ id: "s1", type: "image", category: "build" }), source()],
        stages: [
          stage({
            bindings: [
              {
                externalRef: "b",
                type: "image",
                category: "build",
                url: null,
                executionSystemId: null,
                executionSystemName: "gha"
              }
            ]
          })
        ]
      },
      [],
      SOFTWARE_LANE
    );
    expect(src.map((n) => n.kind)).toEqual(["source", "build", "registry", "source"]);

    const marks = [
      renderToStaticMarkup(<StageCardForTest stage={stage()} />),
      renderToStaticMarkup(<UnplacedStageCardForTest stage={unplaced()} />)
    ].map((html) => html.match(/data-node-icon="([a-z]+)"/)?.[1]);
    expect(marks, "a placed stage and one never reached must not share a symbol").toEqual([
      "stage",
      "unplaced"
    ]);
  });

  it("says what each node DOES, not just what it is called", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html, "a bare title assumes the reader already knows the pipeline model").toContain(
      "deploys to"
    );
  });

  it("carries the deployment outcome as a pill, and never renders an empty header", () => {
    const never = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(never, "an empty header would read as 'fine'").toContain("never deployed");

    const failed = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          currents: [
            {
              changeId: "019f0000-0000-7000-8000-0000000c0ffe",
              changeName: "boom",
              changeState: "failed",
              waveName: "prod",
              targetStatus: "failed",
              type: "configuration",
              category: "configuration"
            }
          ]
        })}
      />
    );
    expect(failed).toContain("failed");
  });
});

describe("who MAINTAINS a place", () => {
  // Owner, 2026-08-04: "even though the Commander gives the go ahead, the outpost still maintains
  // those targets". ADR-0017 §2 devolves execution to the originating outpost; ADR-0011 has the
  // receiving outpost validate every deploy in its own domain. A stage with no domain on it reads
  // as if the commander deploys it — the one thing charter principle 1 says it does not do.
  it("names the domain on a placed stage", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html).toContain("Maintained by");
    expect(html).toContain("commercial");
  });

  it("says an OUTPOST runs it, and that this instance only coordinates", () => {
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          maintainedBy: {
            domainId: "019f0000-0000-7000-8000-00000000f001",
            name: "edge-eu",
            isSelf: false,
            role: "outpost"
          }
        })}
      />
    );
    expect(html).toContain("edge-eu");
    expect(html).toContain("outpost");
    expect(html, "the split is stated, not implied").toContain("that domain runs it");
  });

  it("shows an UNRECOGNISED domain as unknown, never as ours", () => {
    // Real on a replica whose peer row has not arrived. Defaulting to "ours" would be the exact
    // misreading this field exists to prevent.
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({
          maintainedBy: {
            domainId: "019f0000-0000-7000-8000-00000000f002",
            name: null,
            isSelf: false,
            role: null
          }
        })}
      />
    );
    const maintainer = /data-testid="stage-maintainer">(.*?)<\/div>/s.exec(html)?.[1] ?? "";
    expect(maintainer).toContain("an unrecognised domain");
    // Asserted against the MAINTAINER BLOCK, not the whole card: "commercial" also appears in the
    // derived stage name, so a whole-document assertion here would pass for the wrong reason.
    expect(maintainer, "an unknown domain must never render as ours").not.toContain("commercial");
  });

  it("names the domain on an UNPLACED stage too — it is still somebody's to run", () => {
    const html = renderToStaticMarkup(<UnplacedStageCardForTest stage={unplaced()} />);
    expect(html, "'not placed' must not read as 'nowhere'").toContain("Maintained by");
  });
});

/**
 * ADR-0028 INCREMENT 4 — A HELD STAGE IS LEGIBLE AS ONE.
 *
 * The defect in one line: a wave target whose trigger is withheld by a stage-scoped component
 * coupling keeps `change_wave_targets.status = "pending"` forever — the server's hold `continue`s
 * before the target is ever handed to an executor — and this view painted that identically to "the
 * wave has not reached this stage yet". Those are opposite facts. One is waiting on something NAMED
 * and clears itself; the other is waiting on nothing.
 *
 * The server half (`apps/server/src/coordination/stage-dependency-surfaces.integration.test.ts`)
 * proves `stages[].hold` is computed live and self-clearing. This file owns what a browser can still
 * undo: given that response, does the page say WHAT it is waiting on?
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `StatusPill` renders `status ?? "never deployed"` regardless of the hold | 1 fails — `expected 'pending' to contain 'held'`. The pill reads `pending`: the defect verbatim |
 * | `HoldSubnode` maps over `[]` instead of `hold.dependencies` | 4 fail — the naming, id-fallback, edge-provenance and per-lane cases. The card still says "Held here" and gives no way to find out by what |
 * | `holdFor` ignores the lane and returns `stage.hold` whenever it is set | 1 fails — `expected … not to contain 'payments-api'`. The infrastructure lane, whose release here succeeded a month ago, is painted as held by the software pipeline's coupling |
 * | `stateOf` maps a hold to `"blocked"` — the union member that already existed | 2 fail — `expected 'blocked' to be 'held'`. Worth keeping in mind: it type-checks, it renders, and it re-creates the permanent-red marker the server deliberately wrote `verdict: "hold"` rather than `"block"` to avoid |
 * | `arrowInto` checks `held` AFTER `approval` | 1 fails — `expected 'approval' to be 'held'` |
 * | `arrowInto` checks `held` BEFORE `blocked` (by dropping the `blocked` rung) | 1 fails — `expected 'held' to be 'blocked'`. This is the rung the ladder test was given a two-target fixture for; with one target per wave it would have stayed green, which is why the fixture holds a held target and a FAILED one in the same wave |
 */
describe("a HELD stage is not a `pending` one", () => {
  const HELD_CHANGE = "019f0000-0000-7000-8000-00000000e001";
  const OTHER_CHANGE = "019f0000-0000-7000-8000-00000000e002";
  const DEP = "019f0000-0000-7000-8000-00000000e003";

  /** The software lane's release at this stage is held; nothing else about the stage is unusual. */
  function heldStage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
    return stage({
      currents: [
        {
          changeId: HELD_CHANGE,
          changeName: "bump-config",
          changeState: "executing",
          waveName: "gamma",
          // THE RAW COLUMN, verbatim — and the whole reason this fixture is shaped this way. A held
          // target really is `pending`, so a fixture that gave it any other status would be testing
          // a state the server cannot produce.
          targetStatus: "pending",
          type: "configuration",
          category: "configuration"
        }
      ],
      hold: {
        changeId: HELD_CHANGE,
        changeName: "bump-config",
        waveIndex: 0,
        dependencies: [
          {
            dependsOn: DEP,
            dependsOnName: "payments-api",
            branch: "never_deployed",
            satisfied: false,
            summary: "payments-api has never deployed here"
          }
        ]
      },
      ...over
    });
  }

  it("says HELD where it used to say `pending` — the defect, verbatim", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={heldStage()} />);
    const pill = /data-testid="stage-status-pill"[^>]*>(.*?)<\/span>/s.exec(html)?.[1] ?? "";
    expect(pill, "the headline must not be the word that means the opposite here").toContain(
      "held"
    );
    expect(pill).not.toContain("pending");
    // The raw column is NOT hidden — it is reported where it is reported verbatim, with the reason
    // appended rather than substituted, so "never triggered" and "in progress" stay separable.
    const deployment = /data-testid="stage-deployment">(.*?)<\/div>/s.exec(html)?.[1] ?? "";
    expect(deployment).toContain("pending");
    expect(deployment).toContain("never triggered");
  });

  it("NAMES what it is waiting on — the entire point of the increment", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={heldStage()} />);
    const hold = /data-testid="stage-hold"[^>]*>(.*?)<\/div><\/div>/s.exec(html)?.[1] ?? "";
    expect(
      hold,
      "a badge saying only 'held' moves the reader one question along, not to the answer"
    ).toContain("payments-api");
    expect(hold, "and the server's own sentence, not a re-worded one").toContain(
      "has never deployed here"
    );
    expect(hold, "and which release is being withheld").toContain("bump-config");
  });

  it("falls back to the dependency's id when the server resolved no name", () => {
    // A deleted component, or an `undeclarable` entry whose raw JSON never had an id to resolve.
    // The id is worse than a name and much better than nothing.
    const held = heldStage();
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={{
          ...held,
          hold: {
            ...held.hold!,
            dependencies: [{ ...held.hold!.dependencies[0]!, dependsOnName: null }]
          }
        }}
      />
    );
    expect(html).toContain(DEP);
  });

  it("says when the coupling came from a `depends_on` EDGE, because the remedy differs", () => {
    const held = heldStage();
    const html = renderToStaticMarkup(
      <StageCardForTest
        stage={{
          ...held,
          hold: {
            ...held.hold!,
            dependencies: [{ ...held.hold!.dependencies[0]!, source: "edge" }]
          }
        }}
      />
    );
    expect(html, "an edge is deleted in the graph, not edited in a pipeline").toContain(
      "depends_on"
    );
  });

  it("marks ONLY the lane whose release is being withheld", () => {
    // The hold is keyed on the PLACEMENT, so it says a release is withheld HERE without saying
    // which pipeline. A stage can hold its `configuration` release while its infrastructure
    // pipeline is simply idle, and painting the infra lane held would claim a pipeline is waiting
    // when nothing of it is running.
    const shared = heldStage({
      currents: [
        {
          changeId: HELD_CHANGE,
          changeName: "bump-config",
          changeState: "executing",
          waveName: "gamma",
          targetStatus: "pending",
          type: "configuration",
          category: "configuration"
        },
        {
          changeId: OTHER_CHANGE,
          changeName: "tf-apply",
          changeState: "accepted",
          waveName: "gamma",
          targetStatus: "succeeded",
          type: "infrastructure",
          category: "infrastructure"
        }
      ]
    });

    const software = renderToStaticMarkup(<StageCardForTest stage={shared} lane={SOFTWARE_LANE} />);
    expect(software).toContain("payments-api");

    const infra = renderToStaticMarkup(<StageCardForTest stage={shared} lane={INFRA_LANE} />);
    expect(infra, "the infra pipeline released here a month ago and is not waiting").not.toContain(
      "payments-api"
    );
    expect(infra).not.toContain('data-testid="stage-hold"');
  });

  it("colours the arrow into the wave `held`, and names the dependency on it", () => {
    // Neither `blocked` (red, and permanent-reading — the exact conflation the server's
    // `verdict: "hold"` was chosen to avoid) nor `approval` (which claims a human gate nobody is
    // standing at). The reason has to survive on the arrow, so it is readable without opening a
    // stage.
    const waves = buildJourney({ stages: [heldStage()], unplacedStages: [] });
    const arrow = arrowInto(waves[0]!, SOFTWARE_LANE);
    expect(arrow.state).toBe("held");
    expect(arrow.detail).toContain("payments-api");
  });

  it("lets a FAILED target outrank a held one, and a held one outrank an approval", () => {
    // The ladder, with a fixture that can actually tell the rungs apart. A wave that has already
    // gone wrong is not a wave to describe as waiting — and the server agrees: it stops holding on
    // a failed wave, because the dependency is not going to arrive in it.
    const failed = stage({
      placement: { id: "019f0000-0000-7000-8000-00000000e0f1", urn: "urn:scp:o:placement:x/f" },
      deploymentTarget: {
        id: "019f0000-0000-7000-8000-00000000e0f2",
        name: "gamma-b",
        environment: "gamma",
        region: null,
        substrate: null,
        account: null,
        cluster: null
      },
      currents: [
        {
          changeId: OTHER_CHANGE,
          changeName: "broke-it",
          changeState: "executing",
          waveName: "gamma",
          targetStatus: "failed",
          type: "configuration",
          category: "configuration"
        }
      ]
    });
    const bothWaves = buildJourney({ stages: [heldStage(), failed], unplacedStages: [] });
    expect(arrowInto(bothWaves[0]!, SOFTWARE_LANE).state).toBe("blocked");

    const awaiting = stage({
      placement: { id: "019f0000-0000-7000-8000-00000000e0a1", urn: "urn:scp:o:placement:x/a" },
      deploymentTarget: {
        id: "019f0000-0000-7000-8000-00000000e0a2",
        name: "gamma-c",
        environment: "gamma",
        region: null,
        substrate: null,
        account: null,
        cluster: null
      },
      currents: [
        {
          changeId: OTHER_CHANGE,
          changeName: "needs-a-human",
          changeState: "waiting",
          waveName: "gamma",
          targetStatus: "pending",
          type: "configuration",
          category: "configuration"
        }
      ]
    });
    const heldAndAwaiting = buildJourney({
      stages: [heldStage(), awaiting],
      unplacedStages: []
    });
    expect(
      arrowInto(heldAndAwaiting[0]!, SOFTWARE_LANE).state,
      "a hold names a specific other thing to go and look at; an approval names a queue"
    ).toBe("held");
  });

  it("leaves an ordinary stage untouched — `hold` absent is not an empty claim", () => {
    // The boundary. Every response predating increment 4, and every stage that is simply not held,
    // must render exactly as before.
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html).not.toContain('data-testid="stage-hold"');
    expect(html).toContain("never deployed");
  });
});

/**
 * ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile —
 * commander and outposts alike; the only thing that ever shares a tile is a test with its target").
 * The target side already obeyed it (one StageCard per target under a wave label). This pins the
 * source side: N inputs → N tiles, side by side, and never two repos inside one tile. The
 * commander-as-opaque-input is itself a tile when present.
 */
describe("the SOURCE side is a row of tiles — one per input", () => {
  const SELF = { domainId: "d-self", name: "field-outpost", isSelf: true, role: "outpost" };
  const COMMANDER = { domainId: "d-cmd", name: "hq-commander", isSelf: false, role: "commander" };
  const src = (over: Partial<ComponentPipelineResponse["sources"][number]>) => ({
    id: `019f0000-0000-7000-8000-${String(Math.random()).slice(2, 14).padEnd(12, "0")}`,
    sourceKind: "gitea",
    repoPattern: "field/repo",
    pathPattern: null,
    refPattern: "main",
    type: "infrastructure",
    category: "infrastructure" as const,
    classification: null,
    mirrorOfShared: false,
    enabled: true,
    disabledUntil: null,
    effectivelyEnabled: true,
    url: null,
    ...over
  });
  const tiles = (html: string, testid: string) =>
    (html.match(new RegExp(`data-testid="${testid}"`, "g")) ?? []).length;

  it("three inputs (commander + mirror + domain-specific) render as THREE tiles, each its own card", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          src({ repoPattern: "field/mirror-of-shared-asg-iac", mirrorOfShared: true }),
          src({ repoPattern: "field/checkout-network-cidr" })
        ]}
        upstream={COMMANDER}
        domainLocal={false}
      />
    );
    expect(tiles(html, "pipeline-source-commander-input")).toBe(1);
    expect(tiles(html, "pipeline-source-tile-mirror")).toBe(1);
    expect(tiles(html, "pipeline-source-tile-domain-specific")).toBe(1);
    // Every mapping row lives in exactly one tile — the count of rows equals the count of repo tiles.
    expect(tiles(html, "pipeline-source-mapping")).toBe(2);
    // The commander tile shows NO repo — this domain does not know it (§9.3a).
    const cmdTile = html.slice(html.indexOf('data-testid="pipeline-source-commander-input"'));
    expect(cmdTile.slice(0, cmdTile.indexOf("</div></div>"))).not.toContain("field/");
    expect(html).toContain("repos not visible in this domain");
  });

  it("N domain repos on a self-maintained component render as N unlabelled tiles (the commander's own site)", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          src({ repoPattern: "acme/asg" }),
          src({ repoPattern: "acme/network" }),
          src({ repoPattern: "acme/ebs" })
        ]}
        upstream={SELF}
        domainLocal={false}
      />
    );
    expect(tiles(html, "pipeline-source-tile")).toBe(3);
    expect(tiles(html, "pipeline-source-commander-input")).toBe(0);
    // No provenance eyebrows where they'd be noise: on its own site these are simply its repos.
    expect(html).not.toContain("Mirror of global");
    expect(html).not.toContain("Domain-specific — tracked only here");
  });

  it("zero inputs render ONE honest empty tile, not zero tiles", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest label="Source code" sources={[]} upstream={SELF} domainLocal={false} />
    );
    expect(tiles(html, "pipeline-source-tile-none")).toBe(1);
    expect(html).toContain("No repo is mapped to this component here");
  });
});

/**
 * EACH SOURCE TILE GETS ITS OWN ARROW (owner, 2026-08-14: "each [source] should have its own arrow
 * so I can enable and disable each as needed", "they should also appear side by side" — for ALL
 * pipelines, commander and outpost). The describe above pins ONE-TILE-PER-SOURCE; this pins the two
 * things layered on top of it: a fan-in arrow PER tile instead of one shared connector for the whole
 * row, and the durable per-mapping enable/disable the correlation matcher now honours (migration
 * 0063's `matchComponentForSource`) — a toggle that does not change matching would be theatre.
 */
describe("each source tile carries its own fan-in arrow, and its own enable/disable toggle", () => {
  const SELF = { domainId: "d-self", name: "field-outpost", isSelf: true, role: "outpost" };
  const COMMANDER = { domainId: "d-cmd", name: "hq-commander", isSelf: false, role: "commander" };
  const count = (html: string, testid: string) =>
    (html.match(new RegExp(`data-testid="${testid}"`, "g")) ?? []).length;

  it("N enabled sources render N tiles AND N of their OWN fan-in arrows — never one shared arrow for the row", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          source({ id: "019f0000-0000-7000-8000-00000000f001", repoPattern: "acme/one" }),
          source({ id: "019f0000-0000-7000-8000-00000000f002", repoPattern: "acme/two" }),
          source({ id: "019f0000-0000-7000-8000-00000000f003", repoPattern: "acme/three" })
        ]}
        upstream={SELF}
        domainLocal={false}
      />
    );
    expect(count(html, "pipeline-source-tile")).toBe(3);
    expect(
      count(html, "promotion-arrow"),
      "three tiles, three fan-in arrows — one PER TILE, not one shared arrow for the whole row"
    ).toBe(3);
  });

  it("suppresses the SHARED lane connector right after a source node — its tiles already drew the transition", () => {
    // Renderer-level, not a full page mount: `sharedConnectorVisible` IS the suppression rule the
    // lane loop applies before each node, so pinning it directly proves the rule without a fetch.
    const nodes = [
      { kind: "source" },
      { kind: "build" },
      { kind: "registry" },
      { kind: "scan-sign" },
      { kind: "source" }
    ] as const;
    expect(sharedConnectorVisible(nodes, 0), "no connector before the first node, ever").toBe(
      false
    );
    expect(
      sharedConnectorVisible(nodes, 1),
      "build follows a source — its shared connector is skipped; the source's own tiles already drew it"
    ).toBe(false);
    expect(
      sharedConnectorVisible(nodes, 2),
      "registry follows build, an ordinary pair — untouched"
    ).toBe(true);
    expect(
      sharedConnectorVisible(nodes, 3),
      "scan-sign follows registry — it joins the chain exactly as registry does (§9.3)"
    ).toBe(true);
    expect(
      sharedConnectorVisible(nodes, 4),
      "the config source after scan-sign gets its connector too — scan-sign is not a source"
    ).toBe(true);
  });

  it("a DISABLED source renders muted, says it routes nothing, and draws an INERT arrow", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          source({
            id: "019f0000-0000-7000-8000-00000000f004",
            enabled: false,
            effectivelyEnabled: false
          })
        ]}
        upstream={SELF}
        domainLocal={false}
      />
    );
    expect(html, "the muted treatment — NodeShell's own dashed/quiet card").toContain(
      "border-dashed"
    );
    expect(html).toContain("closed until re-opened — routes nothing");
    expect(
      html,
      "the arrow beneath it carries the inert style, not an ordinary pending one"
    ).toContain('data-inert="true"');
    // THE ARROW IS THE SWITCH (owner, 2026-08-14): a closed source's arrow is a BUTTON that says
    // "closed", offers "click to open", and is RED (owner: "red should signify closed") — a
    // clickable switch, visibly distinct from the GREY of arrows that are not switches at all.
    expect(html).toContain('data-switch="closed"');
    expect(html).toContain("source closed — click to open");
    expect(html).toContain("bg-red-500");
    expect(html).toContain(">closed<");
  });

  it("the toggle sits on every mapping tile, and NEVER on the commander's opaque input tile", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          source({ id: "019f0000-0000-7000-8000-00000000f005" }),
          source({ id: "019f0000-0000-7000-8000-00000000f006" })
        ]}
        upstream={COMMANDER}
        domainLocal={false}
      />
    );
    // 1 commander tile + 2 mapping tiles = 3 tiles, 3 fan-in arrows — but only the two MAPPING
    // arrows are switches. The commander's arrow stays a plain connector: this domain does not own
    // that input, so it cannot open or close it. `data-switch` marks a clickable arrow; its count
    // staying at 2 (not 3) is what proves that.
    expect(count(html, "pipeline-source-commander-input")).toBe(1);
    expect(count(html, "promotion-arrow")).toBe(3);
    expect((html.match(/data-switch="/g) ?? []).length).toBe(2);
    // Open = green, and the switch says so in words too (colour alone must not carry the state).
    expect((html.match(/data-switch="open"/g) ?? []).length).toBe(2);
    expect(html).toContain("source open — click to close");
    expect(html).toContain("bg-green-500");
    // The old separate button is GONE — the arrow replaced it, it did not join it.
    expect(count(html, "toggle-mapping-enabled-button")).toBe(0);
  });

  it("tiles sit side by side in ONE flex-wrap row, never stacked", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          source({ id: "019f0000-0000-7000-8000-00000000f007" }),
          source({ id: "019f0000-0000-7000-8000-00000000f008" })
        ]}
        upstream={SELF}
        domainLocal={false}
      />
    );
    const rowTag = html.match(/<div[^>]*data-testid="pipeline-source-row"[^>]*>/)?.[0];
    expect(rowTag, "the source row's own container element").toBeDefined();
    expect(rowTag).toContain("flex-wrap");
  });
});

/**
 * A WAVE LABEL STATES ITS ORDER CLAIM (owner, 2026-08-14: "why would we deploy to gamma and prod
 * in parallel?"). Targets side by side are legitimately one wave that fans out (us-east-1-prod ∥
 * us-west-1-prod) — so a row that is NOT a declared wave must say so, or side-by-side placements
 * read as "released to all at once". Pinned: a declared wave labels itself "Wave N · name"; the
 * off-topology row labels itself as unordered placements and never as a wave.
 */
describe("a wave label carries the ORDER claim, not just membership", () => {
  const entry = (name: string, id: string, waveIndex: number | null = null) => ({
    placed: true as const,
    order: 0,
    waveIndex,
    stage: stage({
      deploymentTarget: {
        id,
        name,
        environment: null,
        region: null,
        substrate: null,
        account: null,
        cluster: null
      },
      placement: {
        id: `019f0000-0000-7000-8000-${id.slice(-12).padStart(12, "0")}`,
        urn: `urn:scp:o:placement:${name}`
      }
    })
  });

  it("a declared wave says 'Wave N · name' — one wave, fanning out to its targets", () => {
    const html = renderWithQueryClient(
      <WaveRowForTest
        wave={{
          waveIndex: 1,
          name: "prod",
          entries: [
            entry("us-east-1-prod", "0000000000e1", 1),
            entry("us-west-1-prod", "0000000000e2", 1)
          ]
        }}
      />
    );
    expect(html).toContain("Wave 2");
    expect(html).toContain("prod");
    expect(html).not.toContain("no wave order declared");
    // Two targets, two tiles, one wave — the sanctioned fan-out.
    expect((html.match(/data-testid="pipeline-stage"/g) ?? []).length).toBe(2);
  });

  it("the off-topology row says the placements are UNORDERED — never 'Wave', never 'parallel'", () => {
    const html = renderWithQueryClient(
      <WaveRowForTest
        wave={{
          waveIndex: null,
          name: null,
          entries: [entry("gamma-cluster", "0000000000a1"), entry("prod-cluster", "0000000000a2")]
        }}
      />
    );
    expect(html).toContain('data-testid="pipeline-wave-unordered"');
    expect(html).toContain("no wave order declared");
    expect(html).not.toMatch(/Wave \d/);
    // The tooltip carries the remedy: attach a topology, gamma in its own wave, then prod fans out.
    expect(html).toContain("gamma in its own wave");
  });
});

/**
 * NOT ONE CLICK (owner, 2026-08-14): "Enabled is default. If clicking on it while enabled, it should
 * give you the option to disable for x period of time or until manually enabled again. There
 * should also be a confirmation screen. When disabled, users can enable but it also needs a
 * confirmation screen." The arrow opens a DIALOG; the dialog holds the choice and the confirm; the
 * mutation fires only from the confirm. Radix's dialog renders nothing under renderToStaticMarkup,
 * so the dialog body is pinned by rendering it open via its own component export.
 */
describe("the arrow opens a dialog — closing offers a period or until-re-opened, and both directions confirm", () => {
  const src = (over: Partial<ComponentPipelineResponse["sources"][number]>) => ({
    id: "019f0000-0000-7000-8000-00000000d001",
    sourceKind: "gitea",
    repoPattern: "field/network-cidr",
    pathPattern: "cidr/**",
    refPattern: "main",
    type: "infrastructure",
    category: "infrastructure" as const,
    classification: null,
    mirrorOfShared: false,
    enabled: true,
    disabledUntil: null,
    effectivelyEnabled: true,
    url: null,
    ...over
  });

  it("an OPEN source's arrow is a switch that opens the dialog — it does not carry a one-click mutation", () => {
    // The arrow is a button (aria-pressed) with the "click to close" affordance; that click opens
    // the dialog rather than flipping state, and the dialog exists in the tree only when open —
    // asserted here by its absence in a static render (Radix portals nothing while closed).
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[src({})]}
        upstream={{ domainId: "d", name: "field-outpost", isSelf: true, role: "outpost" }}
        domainLocal={false}
      />
    );
    expect(html).toContain('data-switch="open"');
    // (apostrophe HTML-escapes under static render — match the stable tail of the phrase)
    expect(html).toContain("choose for how long, and confirm");
    expect(html).not.toContain('data-testid="source-open-close-dialog"');
  });

  it("the CLOSE dialog offers periods plus until-re-opened, names the consequence, and confirms with the chosen duration", () => {
    const html = renderWithQueryClient(
      <SourceOpenCloseDialogForTest source={src({})} currentlyOpen={true} />
    );
    expect(html).toContain("Close this source?");
    for (const key of ["1h", "4h", "24h", "7d", "manual"]) {
      expect(html, `duration ${key}`).toContain(`data-testid="close-duration-${key}"`);
    }
    expect(html).toContain("a push matching this rule starts no release");
    expect(html).toContain("this is not a delete");
    // Default = until re-opened (the conservative default: nothing re-opens by itself unless asked).
    expect(html).toContain("It stays closed until someone opens it again");
    expect(html).toContain('data-testid="source-open-close-confirm"');
    expect(html).toContain("Close until re-opened");
  });

  it("the OPEN dialog confirms too, and says what re-opens — including bringing a timed re-open forward", () => {
    const html = renderWithQueryClient(
      <SourceOpenCloseDialogForTest
        source={src({
          enabled: false,
          effectivelyEnabled: false,
          disabledUntil: "2026-08-20T12:00:00.000Z"
        })}
        currentlyOpen={false}
      />
    );
    expect(html).toContain("Open this source?");
    expect(html).toContain("starts a release again");
    expect(html).toContain("opening now brings that forward");
    expect(html).toContain('data-testid="source-open-close-confirm"');
    expect(html).not.toContain('data-testid="close-duration-1h"');
  });

  it("a CLOSED tile's badge says until WHEN — a timed close and a manual close read differently", () => {
    const timed = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          src({
            enabled: false,
            effectivelyEnabled: false,
            disabledUntil: "2026-08-20T12:00:00.000Z"
          })
        ]}
        upstream={{ domainId: "d", name: "field-outpost", isSelf: true, role: "outpost" }}
        domainLocal={false}
      />
    );
    expect(timed).toContain("closed until ");
    expect(timed).not.toContain("closed until re-opened");
    const manual = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[src({ enabled: false, effectivelyEnabled: false })]}
        upstream={{ domainId: "d", name: "field-outpost", isSelf: true, role: "outpost" }}
        domainLocal={false}
      />
    );
    expect(manual).toContain("closed until re-opened");
  });

  it("paints from the READ-TIME truth: a timed close whose bound has passed renders OPEN", () => {
    // enabled still false on the row (the operator never re-opened), but the bound is in the past
    // so the matcher routes it — the arrow must be green, not shut, or the UI lies about a live rule.
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          src({
            enabled: false,
            effectivelyEnabled: true,
            disabledUntil: "2020-01-01T00:00:00.000Z"
          })
        ]}
        upstream={{ domainId: "d", name: "field-outpost", isSelf: true, role: "outpost" }}
        domainLocal={false}
      />
    );
    expect(html).toContain('data-switch="open"');
    expect(html).not.toContain("routes nothing");
  });
});

/**
 * GREY MEANS "NOT A SWITCH", NEVER "CLOSED" (owner question, 2026-08-14: "the grey arrows are not
 * clickable — is that intentional?"). Yes, and this pins the rule so it stays legible: only arrows
 * this domain can open/close are switches (green open / red closed, always clickable). The
 * commander's opaque-input arrow and every chain connector are NOT switches — grey, not clickable —
 * because there is nothing there for the operator to toggle.
 */
describe("grey is reserved for arrows that are not switches", () => {
  it("the commander's opaque-input arrow is grey and NOT a button; a closed mapping's arrow is red AND a button", () => {
    const html = renderWithQueryClient(
      <SourceNodeForTest
        label="Source code"
        sources={[
          {
            id: "019f0000-0000-7000-8000-00000000c001",
            sourceKind: "gitea",
            repoPattern: "field/x",
            pathPattern: null,
            refPattern: null,
            type: "infrastructure",
            category: "infrastructure" as const,
            classification: null,
            mirrorOfShared: false,
            enabled: false,
            disabledUntil: null,
            effectivelyEnabled: false,
            url: null
          }
        ]}
        upstream={{ domainId: "d-cmd", name: "hq-commander", isSelf: false, role: "commander" }}
        domainLocal={false}
      />
    );
    // Split at the mapping tile: everything before it is the commander tile + its arrow.
    const cmdPart = html.slice(
      0,
      html.indexOf('data-testid="pipeline-source-tile-domain-specific"')
    );
    const mapPart = html.slice(html.indexOf('data-testid="pipeline-source-tile-domain-specific"'));
    // Commander arrow: a plain div, grey (pending slate), no data-switch, not red.
    expect(cmdPart).toContain('data-testid="promotion-arrow"');
    expect(cmdPart).not.toContain("data-switch=");
    expect(cmdPart).toContain("bg-slate-300");
    expect(cmdPart).not.toContain("bg-red-500");
    // Mapping arrow (closed): a BUTTON, red, says closed — clickable to re-open.
    expect(mapPart).toContain('data-switch="closed"');
    expect(mapPart).toContain("<button");
    expect(mapPart).toContain("bg-red-500");
    expect(mapPart).not.toContain("bg-slate-200 opacity-60");
  });
});

/* ================================================================================================
 * §9.3 — the ARTIFACT on the tiles: Registry body (latest digest), Build (SBOM + PM), Scan & sign
 * (commander only). pipeline-substrate-registry-scan.md §9.3/§9.6. Every rendered value is READ
 * from `artifact` or stated absent; a tile is clickable exactly when it has something to review.
 * ============================================================================================== */

type Artifact = NonNullable<ComponentPipelineResponse["artifact"]>;
type Sbom = NonNullable<Artifact["sbom"]>;
type Scan = Artifact["scans"][number];
type Export = Artifact["signing"]["promotionExports"][number];

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DIGEST_2 = "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const CHANGE_ID = "019f0000-0000-7000-8000-00000000c4a6";
const PEER_ID = "019f0000-0000-7000-8000-00000000fee1";
const EXPORTER_ID = "019f0000-0000-7000-8000-00000000c0de";
const KEY_FP = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    changeId: CHANGE_ID,
    changeName: "checkout-api@1.4.2",
    changeCreatedAt: "2026-08-15T09:00:00.000Z",
    digests: [DIGEST],
    sbom: null,
    scans: [],
    exportGate: "not_run",
    signing: { promotionExports: [], originSignatureRefs: [] },
    unknownFields: [],
    ...over
  };
}

function sbom(over: Partial<Sbom> = {}): Sbom {
  return {
    format: "cyclonedx",
    specVersion: "1.5",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    location: "https://ci.acme.invalid/sbom/checkout-api.cdx.json",
    mediaType: "application/vnd.cyclonedx+json",
    signatureRef: "https://ci.acme.invalid/sbom/checkout-api.cdx.json.sig",
    scanner: "syft",
    scannerVersion: "1.0.0",
    generatedAt: "2026-08-15T08:59:00Z",
    ...over
  };
}

function scan(over: Partial<Scan> = {}): Scan {
  return {
    method: "trivy",
    scanner: "trivy",
    scannerVersion: "0.55.0",
    digest: DIGEST,
    digestMatch: true,
    status: "pass",
    counts: { critical: 0, high: 2, medium: 5, low: 9 },
    threshold: { maxCritical: 0, maxHigh: 2 },
    evaluatedAt: "2026-08-15T10:00:00.000Z",
    controlRunId: "019f0000-0000-7000-8000-00000000ac01",
    managed: false,
    ...over
  };
}

function promotionExport(over: Partial<Export> = {}): Export {
  return {
    peerDomainId: PEER_ID,
    peerName: "field-outpost",
    exportedAt: "2026-08-15T11:00:00.000Z",
    checksum: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    manifest: {
      manifestVersion: "scp-promotion-manifest/v1",
      createdAt: "2026-08-15T11:00:00.000Z",
      sourceChangeObjectId: CHANGE_ID,
      exporterDomainId: EXPORTER_ID,
      peerDomainId: PEER_ID,
      changeUrn: "urn:scp:o:change:acme/checkout-api@1.4.2",
      artifacts: [
        { type: "oci", digest: DIGEST },
        {
          type: "blob",
          digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          signatureRef: "sig://sbom"
        }
      ]
    },
    manifestSignature: "MEUCIQD…",
    keyFingerprint: KEY_FP,
    ...over
  };
}

const BUILD_BINDING = {
  externalRef: "build-app",
  type: "image",
  category: "build" as const,
  url: null,
  executionSystemId: null,
  executionSystemName: "github"
};

/** A commander-shaped software lane: a build source + binding, a config source, one wave. */
function commanderLaneData(over: Partial<Parameters<typeof laneNodes>[0]> = {}) {
  return {
    sources: [
      source({ id: "s1", type: "image", category: "build" }),
      source({ id: "s2", type: "configuration", category: "configuration" })
    ],
    stages: [stage({ bindings: [BUILD_BINDING] })],
    registry: registryDeclared(),
    artifact: artifact(),
    ...over
  };
}

const ONE_WAVE = buildJourney({
  stages: [stage({ order: 0, wave: { index: 0, name: "gamma" } })],
  unplacedStages: []
});

const REVIEW_BUILD = 'aria-label="Review SBOM and promotion manifest"';
const REVIEW_SCAN = 'aria-label="Review scan and signing results"';

describe("the Scan & sign node — commander only, after Registry, before Config", () => {
  it("commander software lane: source, build, registry, SCAN-SIGN, config, wave", () => {
    const nodes = laneNodes(commanderLaneData(), ONE_WAVE, SOFTWARE_LANE, "commander");
    expect(nodes.map((n) => n.kind)).toEqual([
      "source",
      "build",
      "registry",
      "scan-sign",
      "source",
      "wave"
    ]);
    const node = nodes[3] as { artifact: Artifact | null | undefined };
    expect(node.artifact?.changeId, "the node CARRIES the artifact the tile renders from").toBe(
      CHANGE_ID
    );
  });

  it("outpost: the SAME data draws the pre-§9.3 chain — no Scan & sign node", () => {
    for (const role of ["outpost", "retrans", undefined] as const) {
      const nodes = laneNodes(commanderLaneData(), ONE_WAVE, SOFTWARE_LANE, role);
      expect(
        nodes.map((n) => n.kind),
        `role=${String(role)}`
      ).toEqual(["source", "build", "registry", "source", "wave"]);
    }
  });

  it("commander with a DECLARED registry and no build (outpost-shaped data) still gets it, after the registry", () => {
    const nodes = laneNodes(
      commanderLaneData({ sources: [source()], stages: [stage()] }),
      ONE_WAVE,
      SOFTWARE_LANE,
      "commander"
    );
    expect(nodes.map((n) => n.kind)).toEqual(["registry", "scan-sign", "source", "wave"]);
  });

  it("commander with NO build, NO registry and NO artifact draws no Scan & sign box — a permanently 'no artifact yet' tile is decoration", () => {
    const nodes = laneNodes(
      { sources: [source()], stages: [stage()], registry: undefined, artifact: null },
      ONE_WAVE,
      SOFTWARE_LANE,
      "commander"
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
  });

  it("… but an artifact ALONE earns it (there is something to scan even with no registry declared)", () => {
    const nodes = laneNodes(
      { sources: [source()], stages: [stage()], registry: undefined, artifact: artifact() },
      ONE_WAVE,
      SOFTWARE_LANE,
      "commander"
    );
    expect(nodes.map((n) => n.kind)).toEqual(["scan-sign", "source", "wave"]);
  });

  it("the INFRASTRUCTURE lane never has it, commander or not", () => {
    const nodes = laneNodes(
      commanderLaneData({
        sources: [source({ id: "s3", type: "infrastructure", category: "infrastructure" })],
        stages: [
          stage({
            bindings: [
              {
                externalRef: "tf-app",
                type: "infrastructure",
                category: "infrastructure",
                url: null,
                executionSystemId: null,
                executionSystemName: "argo-workflows"
              }
            ]
          })
        ]
      }),
      ONE_WAVE,
      INFRA_LANE,
      "commander"
    );
    expect(nodes.map((n) => n.kind)).toEqual(["source", "wave"]);
  });

  it("carries its OWN glyph — distinct from the registry's", () => {
    const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={null} />);
    expect(html).toContain('data-node-icon="scan-sign"');
    expect(html).toContain("Scan &amp; sign");
    expect(html).toContain("at source — authorises cross-boundary transfer");
  });
});

describe("the REGISTRY node body — the latest digest, or the stated absence", () => {
  it("shows the newest digest folded (full value in title) and WHICH change it came from", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared()} artifact={artifact()} />
    );
    expect(html).toContain('data-testid="pipeline-registry-digest"');
    expect(html).toContain(shortDigest(DIGEST));
    expect(html, "the full digest is never lost, only folded").toContain(`title="${DIGEST}"`);
    expect(html).toContain("from change");
    expect(html).toContain("checkout-api@1.4.2");
    expect(html, "a tile with a digest is no longer the muted dashed box").not.toContain(
      "border-dashed"
    );
  });

  it("with several digests, shows the LAST one and says how many more", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest
        registry={registryDeclared()}
        artifact={artifact({ digests: [DIGEST_2, DIGEST] })}
      />
    );
    expect(html).toContain(shortDigest(DIGEST));
    expect(html).not.toContain(shortDigest(DIGEST_2));
    expect(html).toContain("+1 more");
  });

  it("artifact null → 'no artifact digest recorded yet' — an ABSENCE, not an unknown", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared()} artifact={null} />
    );
    expect(html).toContain("no artifact digest recorded yet");
    expect(html).toContain('data-artifact-state="none"');
    expect(html).not.toContain("not observed yet");
  });

  it("artifact present but no digest listed → the same stated absence", () => {
    const html = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared()} artifact={artifact({ digests: [] })} />
    );
    expect(html).toContain("no artifact digest recorded yet");
  });

  it("older server (no `artifact` on the wire) → the pre-§9.3 'not observed' sentence, an UNKNOWN", () => {
    const html = renderToStaticMarkup(<RegistryNodeForTest registry={registryDeclared()} />);
    expect(html).toContain("not observed yet");
    expect(html).toContain('data-artifact-state="unknown"');
    expect(html).not.toContain("no artifact digest recorded yet");
  });
});

describe("the BUILD tile — SBOM and promotion manifest, present or stated absent", () => {
  it("older server: no SBOM/PM lines and no review affordance", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest bindings={[BUILD_BINDING]} artifact={undefined} />
    );
    expect(html).not.toContain("pipeline-build-sbom");
    expect(html).not.toContain("pipeline-build-pm");
    expect(html).not.toContain(REVIEW_BUILD);
    expect(html, "the executor line is kept").toContain("pipeline-build-executor");
  });

  it("artifact null: says 'no artifact yet' — and is NOT clickable", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest bindings={[BUILD_BINDING]} artifact={null} />
    );
    expect(html).toContain(
      "no artifact yet — no change of this component reports an artifact digest"
    );
    expect(html).not.toContain(REVIEW_BUILD);
    expect(html).not.toContain("data-reviewable");
  });

  it("commander, artifact with neither SBOM nor export: both absences stated, no click affordance", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest bindings={[BUILD_BINDING]} artifact={artifact()} instanceRole="commander" />
    );
    expect(html).toContain("no SBOM reported for this artifact");
    expect(html).toContain("not created — a promotion manifest is created at export to a peer");
    expect(html).toContain('data-sbom-state="absent"');
    expect(html).toContain('data-pm-state="absent"');
    expect(html, "nothing to review → no button").not.toContain(REVIEW_BUILD);
    expect(html).not.toContain("data-reviewable");
    expect(html).not.toContain("<button");
  });

  it("outpost, no export: the imported manifest is NOT on this wire, and the tile says so rather than inventing one", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest bindings={[]} artifact={artifact()} instanceRole="outpost" />
    );
    expect(html).toContain("imported manifest not projected yet");
    expect(html).not.toContain("not created — a promotion manifest is created at export to a peer");
    expect(html).not.toContain(REVIEW_BUILD);
  });

  it("SBOM present: `format specVersion · scanner scannerVersion · generatedAt`, linked to an http(s) location — and the tile IS clickable", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[BUILD_BINDING]}
        artifact={artifact({ sbom: sbom() })}
        instanceRole="commander"
      />
    );
    expect(html).toContain("cyclonedx 1.5 · syft 1.0.0 · 2026-08-15T08:59:00Z");
    expect(html).toContain('href="https://ci.acme.invalid/sbom/checkout-api.cdx.json"');
    expect(html).toContain('data-sbom-state="present"');
    expect(html).toContain(REVIEW_BUILD);
    expect(html).toContain('data-reviewable="true"');
    expect(html, "the PM half is still absent, and still says so").toContain(
      "not created — a promotion manifest is created at export to a peer"
    );
  });

  it("SBOM whose location is an OCI ref (not http): text with the ref in title, NO link", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[]}
        artifact={artifact({
          sbom: sbom({
            location: "registry.hq.invalid/acme/checkout-api@sha256:abcd",
            scanner: undefined,
            scannerVersion: undefined,
            generatedAt: undefined
          })
        })}
      />
    );
    expect(html).not.toContain("pipeline-build-sbom-link");
    expect(html).toContain('title="registry.hq.invalid/acme/checkout-api@sha256:abcd"');
    expect(html, "only the present parts join — no dangling separator").toContain(
      ">cyclonedx 1.5</span>"
    );
  });

  it("PM present: `signed for <peer> · <when> · N artifacts` from the NEWEST export, and the tile IS clickable", () => {
    const older = promotionExport({
      exportedAt: "2026-08-14T11:00:00.000Z",
      peerName: "old-peer",
      peerDomainId: "019f0000-0000-7000-8000-00000000fee0"
    });
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[BUILD_BINDING]}
        artifact={artifact({
          signing: { promotionExports: [older, promotionExport()], originSignatureRefs: [] }
        })}
        instanceRole="commander"
      />
    );
    expect(html).toContain("signed for");
    expect(html).toContain("field-outpost");
    expect(html, "the NEWEST (last) export, not the first").not.toContain("old-peer");
    expect(html).toContain("2 artifacts");
    expect(html).toContain('data-pm-state="signed"');
    expect(html).toContain(REVIEW_BUILD);
  });

  it("PM peer with no name left here → the peer DOMAIN ID verbatim, never a guess", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[]}
        artifact={artifact({
          signing: {
            promotionExports: [promotionExport({ peerName: null })],
            originSignatureRefs: []
          }
        })}
        instanceRole="commander"
      />
    );
    expect(html).toContain(`signed for <span class="font-mono">${PEER_ID}</span>`);
  });

  it("an export ALSO makes an outpost's tile clickable (a downstream re-export is a signed manifest too)", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[]}
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] }
        })}
        instanceRole="outpost"
      />
    );
    expect(html).toContain(REVIEW_BUILD);
    expect(html).not.toContain("imported manifest not projected yet");
  });

  it("`sbom:unparseable` STATED by the projection → 'recorded but unreadable', NEVER 'no SBOM reported' (an unreadable presence is not an absence)", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[BUILD_BINDING]}
        artifact={artifact({ sbom: null, unknownFields: ["sbom:unparseable"] })}
        instanceRole="commander"
      />
    );
    expect(html).toContain('data-sbom-state="unparseable"');
    expect(html).toContain(
      "SBOM reference recorded but unreadable — it does not parse as an SBOM reference"
    );
    expect(html).not.toContain("no SBOM reported for this artifact");
    expect(html).not.toContain('data-sbom-state="absent"');
    expect(html, "the PM half is untouched by the SBOM flag").toContain('data-pm-state="absent"');
    expect(html, "nothing parseable to review → still no affordance").not.toContain(REVIEW_BUILD);
  });

  it("`promotionExports:unparseable` with NO readable export → PM 'recorded but unreadable', never 'not created' — on the commander AND the outpost", () => {
    for (const role of ["commander", "outpost"] as const) {
      const html = renderToStaticMarkup(
        <BuildNodeForTest
          bindings={[]}
          artifact={artifact({ unknownFields: ["promotionExports:unparseable"] })}
          instanceRole={role}
        />
      );
      expect(html, role).toContain('data-pm-state="unparseable"');
      expect(html, role).toContain(
        "export stamp recorded but unreadable — some export stamps could not be read"
      );
      expect(html, role).not.toContain(
        "not created — a promotion manifest is created at export to a peer"
      );
      expect(html, role).not.toContain("imported manifest not projected yet");
      expect(html, `${role}: the SBOM half is untouched by the exports flag`).toContain(
        'data-sbom-state="absent"'
      );
    }
  });

  it("`promotionExports:unparseable` BESIDE a readable export → the signed line keeps its facts and says some stamps could not be read", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[]}
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] },
          unknownFields: ["promotionExports:unparseable"]
        })}
        instanceRole="commander"
      />
    );
    expect(html).toContain('data-pm-state="signed"');
    expect(html).toContain("signed for");
    expect(html).toContain("(some export stamps could not be read)");
    expect(html).toContain('data-testid="pipeline-exports-unparseable"');
  });

  it("an empty unknownFields renders NO unparseable wording anywhere (the flag is read, not assumed)", () => {
    const html = renderToStaticMarkup(
      <BuildNodeForTest
        bindings={[]}
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] }
        })}
        instanceRole="commander"
      />
    );
    expect(html).not.toContain("unreadable");
    expect(html).not.toContain("could not be read");
  });

  it("sbomLine joins ONLY the present parts, in order", () => {
    expect(sbomLine(sbom())).toBe("cyclonedx 1.5 · syft 1.0.0 · 2026-08-15T08:59:00Z");
    expect(sbomLine(sbom({ specVersion: undefined, scannerVersion: undefined }))).toBe(
      "cyclonedx · syft · 2026-08-15T08:59:00Z"
    );
    expect(
      sbomLine(
        sbom({
          specVersion: undefined,
          scanner: undefined,
          scannerVersion: undefined,
          generatedAt: undefined
        })
      )
    ).toBe("cyclonedx");
  });

  it("sbomLocationHref links ONLY an http(s) URL", () => {
    expect(sbomLocationHref("https://ci.acme.invalid/x.json")).toBe(
      "https://ci.acme.invalid/x.json"
    );
    expect(sbomLocationHref("http://ci.acme.invalid/x.json")).toBe("http://ci.acme.invalid/x.json");
    expect(sbomLocationHref("oci://registry.hq.invalid/acme/checkout-api@sha256:abcd")).toBeNull();
    expect(sbomLocationHref("registry.hq.invalid/acme/checkout-api@sha256:abcd")).toBeNull();
    expect(sbomLocationHref("s3://bucket/sbom.json")).toBeNull();
    expect(sbomLocationHref("javascript:alert(1)")).toBeNull();
  });
});

describe("the BUILD review dialog body renders the SBOM and the manifest VERBATIM (portal-free)", () => {
  it("every SBOM reference field, by its wire name", () => {
    const html = renderToStaticMarkup(<BuildReviewBody artifact={artifact({ sbom: sbom() })} />);
    for (const [label, value] of [
      ["format", "cyclonedx"],
      ["specVersion", "1.5"],
      ["digest", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["location", "https://ci.acme.invalid/sbom/checkout-api.cdx.json"],
      ["mediaType", "application/vnd.cyclonedx+json"],
      ["signatureRef", "https://ci.acme.invalid/sbom/checkout-api.cdx.json.sig"],
      ["scanner", "syft"],
      ["scannerVersion", "1.0.0"],
      ["generatedAt", "2026-08-15T08:59:00Z"]
    ]) {
      expect(html, `label ${label}`).toContain(`>${label}</dt>`);
      expect(html, `value of ${label}`).toContain(value!);
    }
    expect(html, "no export → the PM absence, stated").toContain(
      "not created — a promotion manifest is created at export to a peer"
    );
  });

  it("every promotion-manifest field, the artifacts table, signature presence and the key fingerprint", () => {
    const html = renderToStaticMarkup(
      <BuildReviewBody
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] }
        })}
      />
    );
    expect(html).toContain("scp-promotion-manifest/v1");
    expect(html).toContain(">createdAt</dt>");
    expect(html).toContain("2026-08-15T11:00:00.000Z");
    expect(html).toContain(EXPORTER_ID);
    expect(html).toContain("field-outpost");
    expect(html).toContain(PEER_ID);
    expect(html).toContain("urn:scp:o:change:acme/checkout-api@1.4.2");
    expect(html).toContain(">oci</td>");
    expect(html).toContain(">blob</td>");
    expect(html).toContain(DIGEST);
    expect(html).toContain("sig://sbom");
    expect(html).toContain(">present</dd>");
    expect(html).toContain(KEY_FP);
    expect(html, "no SBOM → its absence, stated").toContain("no SBOM reported for this artifact");
  });

  it("a stamp with no fingerprint says 'not recorded'; an empty signature says 'absent'", () => {
    const html = renderToStaticMarkup(
      <BuildReviewBody
        artifact={artifact({
          signing: {
            promotionExports: [promotionExport({ keyFingerprint: null, manifestSignature: "" })],
            originSignatureRefs: []
          }
        })}
      />
    );
    expect(html).toContain(">not recorded</dd>");
    expect(html).toContain(">absent</dd>");
  });

  it("the review body states the projection's unknowns too: an unparseable SBOM, and unreadable stamps with or without a readable one beside them", () => {
    const bothUnreadable = renderToStaticMarkup(
      <BuildReviewBody
        artifact={artifact({ unknownFields: ["sbom:unparseable", "promotionExports:unparseable"] })}
      />
    );
    expect(bothUnreadable).toContain('data-testid="build-review-sbom-unparseable"');
    expect(bothUnreadable).toContain("SBOM reference recorded but unreadable");
    expect(bothUnreadable).not.toContain("no SBOM reported for this artifact");
    expect(bothUnreadable).toContain('data-testid="build-review-exports-unparseable"');
    expect(bothUnreadable).toContain("export stamp recorded but unreadable");
    expect(bothUnreadable).not.toContain(
      "not created — a promotion manifest is created at export to a peer"
    );

    const besideReadable = renderToStaticMarkup(
      <BuildReviewBody
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] },
          unknownFields: ["promotionExports:unparseable"]
        })}
      />
    );
    expect(besideReadable, "the readable stamp is still rendered in full").toContain(
      "scp-promotion-manifest/v1"
    );
    expect(besideReadable).toContain('data-testid="build-review-exports-unparseable"');
    expect(besideReadable).toContain("some export stamps could not be read");
  });
});

describe("the SCAN & SIGN tile — each state stated, clickable only with something to review", () => {
  it("artifact null → 'no artifact yet — nothing to scan', not clickable", () => {
    const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={null} />);
    expect(html).toContain("no artifact yet — nothing to scan");
    expect(html).toContain('data-scan-state="no-artifact"');
    expect(html).not.toContain(REVIEW_SCAN);
    expect(html).not.toContain("<button");
  });

  it("no scans, no exports → 'not run' for the digest, gate not run, not signed, origin signature not recorded — not clickable", () => {
    const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={artifact()} />);
    expect(html).toContain("not run — no scan result recorded for");
    expect(html).toContain(shortDigest(DIGEST));
    expect(html).toContain(`title="${DIGEST}"`);
    expect(html).toContain('data-scan-state="not-run"');
    expect(html).toContain("export gate (E6):");
    expect(html).toContain('data-export-gate="not_run"');
    expect(html).toContain(">not run</span>");
    expect(html).toContain("not signed yet — the promotion manifest is signed at export to a peer");
    expect(html).toContain("origin artifact signature:");
    expect(html).toContain(">not recorded</span>");
    expect(html).not.toContain(REVIEW_SCAN);
    expect(html).not.toContain("<button");
  });

  it("scan rows: `scanner version · digest · status · C H M L · when`, the managed step marked from the FLAG (never the scanner name) — and clickable", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          scans: [
            scan(),
            scan({
              method: "openscap",
              scanner: "openscap",
              scannerVersion: "1.3.10",
              status: "fail",
              counts: { critical: 1, high: 0, medium: 0, low: 3 },
              controlRunId: "019f0000-0000-7000-8000-00000000ac02",
              managed: true
            })
          ],
          exportGate: "fail"
        })}
      />
    );
    expect(html).toContain('data-scan-state="rows"');
    expect(html).toContain("trivy 0.55.0");
    expect(html).toContain("C0 H2 M5 L9");
    expect(html).toContain("openscap 1.3.10");
    expect(html).toContain("C1 H0 M0 L3");
    expect(html).toContain(`title="${DIGEST}"`);
    expect(html).toContain('title="2026-08-15T10:00:00.000Z"');
    const rows = html.split('data-testid="pipeline-scan-row"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0], "org-pipeline trivy row: no managed mark").not.toContain(">managed<");
    expect(rows[1], "the commander's own step: marked managed off the flag").toContain(">managed<");
    expect(html).toContain('data-export-gate="fail"');
    // The VISIBLE label is READ from `exportGate`, never derived from the rows: a pass row exists
    // here, yet the wire says `fail` (E6 needs a digest-bound pass for EVERY substantive artifact),
    // and the text must say `fail`.
    expect(html).toMatch(/data-export-gate="fail"[\s\S]*?>fail<\/span>/);
    expect(html).toContain(REVIEW_SCAN);
    expect(html).toContain('data-reviewable="true"');
  });

  it("the export-gate label mirrors the WIRE, not the rows: `pass` over fail-only rows reads pass; the review body too", () => {
    const failOnly = artifact({ scans: [scan({ status: "fail" })], exportGate: "pass" });
    const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={failOnly} />);
    expect(html).toMatch(/data-export-gate="pass"[\s\S]*?>pass<\/span>/);
    const body = renderToStaticMarkup(<ScanSignReviewBody artifact={failOnly} />);
    expect(body).toMatch(/data-testid="scan-review-export-gate">pass<\/span>/);
    // And the third value spelled out — the enum's `not_run` reads "not run" on both surfaces.
    const notRun = artifact({ scans: [scan()], exportGate: "not_run" });
    expect(renderToStaticMarkup(<ScanSignNodeForTest artifact={notRun} />)).toMatch(
      /data-export-gate="not_run"[\s\S]*?>not run<\/span>/
    );
    expect(renderToStaticMarkup(<ScanSignReviewBody artifact={notRun} />)).toMatch(
      /data-testid="scan-review-export-gate">not run<\/span>/
    );
  });

  it("a `trivy` row with managed=false and an `openscap` row with managed=true — the mark follows the flag, not the name", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          scans: [
            scan({ scanner: "trivy", managed: true }),
            scan({
              scanner: "openscap",
              method: "openscap",
              managed: false,
              controlRunId: "019f0000-0000-7000-8000-00000000ac03"
            })
          ]
        })}
      />
    );
    const rows = html.split('data-testid="pipeline-scan-row"').slice(1);
    expect(rows[0]).toContain(">managed<");
    expect(rows[1]).not.toContain(">managed<");
  });

  it("counts the evidence omitted → 'counts not recorded', never zeros", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest artifact={artifact({ scans: [scan({ counts: null })] })} />
    );
    expect(html).toContain("counts not recorded");
    expect(html).not.toContain("C0 H0 M0 L0");
  });

  it("exports present, no scans → 'manifest signed for <peer> <when> (key <fp>)' per export — and clickable", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          signing: {
            promotionExports: [
              promotionExport(),
              promotionExport({
                peerName: null,
                peerDomainId: "019f0000-0000-7000-8000-00000000fee2",
                exportedAt: "2026-08-15T12:00:00.000Z"
              })
            ],
            originSignatureRefs: []
          }
        })}
      />
    );
    expect(html).toContain('data-sign-state="signed"');
    expect(html.split('data-testid="pipeline-sign-row"').length - 1).toBe(2);
    expect(html).toContain("manifest signed for");
    expect(html).toContain("field-outpost");
    expect(html).toContain("019f0000-0000-7000-8000-00000000fee2");
    expect(html).toContain(`(key <span class="font-mono">${KEY_FP.slice(0, 16)}…</span>)`);
    expect(html).toContain(`title="${KEY_FP}"`);
    expect(html, "the scan half is still 'not run'").toContain(
      "not run — no scan result recorded for"
    );
    expect(html).toContain(REVIEW_SCAN);
  });

  it("an origin signatureRef, when one exists, is listed instead of 'not recorded'", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          signing: { promotionExports: [], originSignatureRefs: ["sig://origin"] }
        })}
      />
    );
    const line = html.slice(html.indexOf('data-testid="pipeline-origin-signature"'));
    expect(line).toContain("sig://origin");
    expect(line.slice(0, 400)).not.toContain(">not recorded<");
  });

  it("older server (no `artifact` on the wire) → 'not observed', an unknown, not clickable", () => {
    const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={undefined} />);
    expect(html).toContain('data-scan-state="unknown"');
    expect(html).not.toContain(REVIEW_SCAN);
  });

  it("`promotionExports:unparseable` with no readable export → sign-state 'unparseable', never 'not signed yet'", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({ unknownFields: ["promotionExports:unparseable"] })}
      />
    );
    expect(html).toContain('data-sign-state="unparseable"');
    expect(html).toContain(
      "signing recorded but unreadable — some export stamps could not be read"
    );
    expect(html).not.toContain("not signed yet");
    expect(html).not.toContain('data-sign-state="not-signed"');
    expect(html, "the scan half is untouched by the exports flag").toContain(
      'data-scan-state="not-run"'
    );
  });

  it("`promotionExports:unparseable` beside a readable export → the signed rows stay, plus the note", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] },
          unknownFields: ["promotionExports:unparseable"]
        })}
      />
    );
    expect(html).toContain('data-sign-state="signed"');
    expect(html).toContain("manifest signed for");
    expect(html).toContain("(some export stamps could not be read)");
    expect(
      renderToStaticMarkup(
        <ScanSignNodeForTest
          artifact={artifact({
            signing: { promotionExports: [promotionExport()], originSignatureRefs: [] }
          })}
        />
      ),
      "no flag → no note"
    ).not.toContain("could not be read");
  });
});

describe("the SCAN & SIGN review dialog body (portal-free) — the full tables, and the way to the raw evidence", () => {
  it("scan table: every ScanRunSummary field incl. threshold JSON, digestMatch and managed; exports table; change link; NO CVE rows", () => {
    const html = renderToStaticMarkup(
      <ScanSignReviewBody
        artifact={artifact({
          scans: [
            scan(),
            scan({
              managed: true,
              threshold: null,
              digestMatch: null,
              controlRunId: "019f0000-0000-7000-8000-00000000ac02"
            })
          ],
          exportGate: "pass",
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] }
        })}
      />
    );
    for (const head of [
      "method",
      "scanner",
      "digest",
      "digestMatch",
      "status",
      "counts",
      "threshold",
      "evaluatedAt",
      "managed",
      "controlRunId"
    ]) {
      expect(html, `column ${head}`).toContain(`>${head}</th>`);
    }
    expect(html.split('data-testid="scan-review-row"').length - 1).toBe(2);
    // renderToStaticMarkup escapes the quotes; the JSON is verbatim underneath.
    expect(html).toContain("{&quot;maxCritical&quot;:0,&quot;maxHigh&quot;:2}");
    expect(html).toContain(">true</td>");
    expect(html).toContain(">not recorded</td>");
    expect(html).toContain(">managed</td>");
    expect(html).toContain(">org pipeline</td>");
    expect(html).toContain("019f0000-0000-7000-8000-00000000ac01");
    expect(html).toContain("2026-08-15T10:00:00.000Z");
    expect(html).toContain('data-testid="scan-review-export-gate"');
    expect(html).toContain(">pass</span>");
    // exports table
    for (const head of [
      "peer",
      "exportedAt",
      "checksum",
      "keyFingerprint",
      "signature",
      "artifacts"
    ]) {
      expect(html, `export column ${head}`).toContain(`>${head}</th>`);
    }
    expect(html).toContain("c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00");
    expect(html).toContain(KEY_FP);
    expect(html).toContain(">present</td>");
    // The router `Link` is mocked to a bare `<a>` at the top of this file, so the props (`to`,
    // testid) are not in the markup — the link's presence and its text are.
    expect(html).toContain("<a>raw evidence on the change</a>");
    expect(html.toLowerCase(), "no CVE list is stored, so none is drawn").not.toContain("cve");
  });

  it("with no scans and no exports, both absences are stated in the dialog too", () => {
    const html = renderToStaticMarkup(<ScanSignReviewBody artifact={artifact()} />);
    expect(html).toContain("not run — no scan result recorded");
    expect(html).toContain("not signed yet — the promotion manifest is signed at export to a peer");
  });

  it("unreadable export stamps are stated in the dialog — alone, and beside a readable one", () => {
    const alone = renderToStaticMarkup(
      <ScanSignReviewBody
        artifact={artifact({ unknownFields: ["promotionExports:unparseable"] })}
      />
    );
    expect(alone).toContain('data-testid="scan-review-exports-unparseable"');
    expect(alone).toContain("signing recorded but unreadable");
    expect(alone).not.toContain("not signed yet");

    const beside = renderToStaticMarkup(
      <ScanSignReviewBody
        artifact={artifact({
          signing: { promotionExports: [promotionExport()], originSignatureRefs: [] },
          unknownFields: ["promotionExports:unparseable"]
        })}
      />
    );
    expect(beside.split('data-testid="scan-review-export-row"').length - 1).toBe(1);
    expect(beside).toContain('data-testid="scan-review-exports-unparseable"');
    expect(beside).toContain("some export stamps could not be read");
  });
});

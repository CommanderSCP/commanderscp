import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage
} from "@scp/sdk";

/**
 * TILE DENSITY (pipeline-substrate-registry-scan.md §10.3, owner) — the STATIC half.
 *
 * Every pipeline tile is a COMPACT part plus a Details disclosure, collapsed by default. This file
 * pins, tile by tile, that the compact markup holds EXACTLY the compact set and NOT the detail
 * rows — and that rendering the same tile expanded reveals them (nothing that rendered before
 * §10.3 became unreachable; it moved). The doubles' `detailsExpanded` prop is the pin: omitted, a
 * tile takes the production default (collapsed); `true` opens it through the same context the
 * page's Expand-all control drives.
 *
 * The BEHAVIOURAL half — a real click on the chevron, Expand all / Collapse all flipping every
 * tile, a tile's own override until the next page flip — lives in
 * `component-pipeline-density-interaction.test.tsx` under happy-dom, because a string cannot fire a
 * handler (see `test-support/render-dom.tsx`).
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `TileDetails` renders its children whether or not `open` (only `hidden` toggles) | every "compact does NOT contain" assertion FAILS — the detail rows are back in the markup |
 * | `useTileDetails` reads `scope.expandedAll ?? true` (default open) | the collapsed-by-default tests FAIL, and every compact-set test with them |
 * | `NodeShell` draws `<TileDetails>` even with no `details` | the Build "no toggle" test FAILS — a chevron over nothing |
 * | keep `MaintainerLine` in the compact part of `StageCard` | the target compact test FAILS on `stage-maintainer` |
 * | `GateSummary` reads `gate.checks.length` for the "none" branch instead of `gate.policies.length` | the approval-only gate test FAILS — an approval-gated stage reads "none" |
 * | `scanSummary` folds a `fail` row as `pass` when another row passed | the fail-verdict test FAILS |
 * | put the Registry's "from change" back on the compact digest line | the Registry compact test FAILS on "from change" |
 * | drop `aria-label` from the `TileDetails` button (or pass no `label` from `NodeShell`) | the disclosure-ARIA test and the "every kind of tile names WHOSE details" test FAIL |
 * | render the Registry's absent-imported-manifest line for every role (drop the `!== "commander"` guard) | the §10.4 absent-manifest test FAILS on the commander half |
 * | put the Registry's PRESENT imported-manifest line under Details (or drop `registryHasReview`) | the §10.4 present-manifest test FAILS (compact lacks the line / no Review button) |
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  StageCardForTest,
  UnplacedStageCardForTest,
  RegistryNodeForTest,
  BuildNodeForTest,
  ScanSignNodeForTest,
  gateSummaryText,
  scanSummary
} = await import("./component-pipeline");

function renderWithQueryClient(node: React.JSX.Element): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

const TOGGLE = 'data-testid="tile-details-toggle"';
const REGION = 'data-testid="tile-details"';

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
      substrate: "aws",
      account: null,
      cluster: "prod-eks"
    },
    stageName: "commercial-nyc3-prod",
    maintainedBy: { domainId: null, name: "commercial", isSelf: true, role: "commander" },
    outpost: {
      state: "self",
      id: null,
      name: "commercial",
      trustTier: null,
      peerDomainId: null,
      peerRole: null
    },
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
    ],
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
    outpost: {
      state: "self",
      id: null,
      name: "commercial",
      trustTier: null,
      peerDomainId: null,
      peerRole: null
    },
    ...over
  };
}

type Gate = ComponentPipelineStage["gate"];
type Check = Gate["checks"][number];

function check(over: Partial<Check> = {}): Check {
  return {
    controlId: "019f0000-0000-7000-8000-00000000c001",
    name: "unit-tests",
    status: "pass",
    changeId: "019f0000-0000-7000-8000-0000000c0ffe",
    ...over
  };
}

function gate(checks: Check[], approvals = 0): Gate {
  return {
    checks,
    policies: [
      {
        name: "prod-gate",
        enforcement: "required",
        requireControls: checks.map((c) => c.controlId),
        requireApprovals:
          approvals > 0 ? [{ count: approvals, fromRole: "Owner", scope: "organization" }] : []
      }
    ]
  };
}

type Artifact = NonNullable<ComponentPipelineResponse["artifact"]>;
type Scan = Artifact["scans"][number];
type Export = Artifact["signing"]["promotionExports"][number];

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CHANGE_ID = "019f0000-0000-7000-8000-00000000c4a6";
const PEER_ID = "019f0000-0000-7000-8000-00000000fee1";

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

function scan(over: Partial<Scan> = {}): Scan {
  return {
    method: "trivy",
    scanner: "trivy",
    scannerVersion: "0.55.0",
    digest: DIGEST,
    digestMatch: true,
    status: "pass",
    counts: { critical: 0, high: 2, medium: 5, low: 9 },
    threshold: null,
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
      exporterDomainId: "019f0000-0000-7000-8000-00000000c0de",
      peerDomainId: PEER_ID,
      changeUrn: "urn:scp:o:change:acme/checkout-api@1.4.2",
      artifacts: [{ type: "oci", digest: DIGEST }]
    },
    manifestSignature: "MEUCIQD…",
    keyFingerprint: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ...over
  };
}

type Imported = NonNullable<Artifact["signing"]["importedManifest"]>;
function importedManifest(over: Partial<Imported> = {}): Imported {
  return {
    manifest: {
      manifestVersion: "scp-promotion-manifest/v1",
      createdAt: "2026-08-15T11:00:00.000Z",
      sourceChangeObjectId: CHANGE_ID,
      exporterDomainId: "019f0000-0000-7000-8000-00000000c0de",
      peerDomainId: PEER_ID,
      changeUrn: "urn:scp:o:change:acme/checkout-api@1.4.2",
      artifacts: [
        { type: "oci", digest: DIGEST },
        { type: "blob", digest: "sha256:" + "b".repeat(64) }
      ]
    },
    manifestSignature: "MEUCIQD…",
    exporterDomainId: "019f0000-0000-7000-8000-00000000c0de",
    exporterName: "hq-commander",
    importedFromDomain: "019f0000-0000-7000-8000-00000000c0de",
    artifactCount: 2,
    ...over
  };
}

const registryDeclared: NonNullable<ComponentPipelineResponse["registry"]> = {
  state: "declared",
  executionSystemId: "019f0000-0000-7000-8000-00000000fff0",
  name: "hq-registry",
  kind: "gitea",
  url: "https://registry.hq.invalid",
  repository: "acme/checkout-api",
  edgeCount: 1
};

const BUILD_BINDING = {
  externalRef: "build-app",
  type: "image",
  category: "build" as const,
  url: null,
  executionSystemId: null,
  executionSystemName: "github"
};

/** The Details rows a PLACED target tile owns — every one of them must be absent from the compact
 *  markup and present once expanded. Named by testid where one exists, by wording otherwise. */
const STAGE_DETAIL_MARKERS = [
  'data-testid="stage-maintainer"',
  "Maintained by",
  'data-testid="stage-gate"',
  'data-testid="stage-executor"',
  'data-testid="stage-version"',
  'data-testid="stage-deployment"',
  'data-testid="stage-current"',
  "Last release",
  "ship-the-app",
  'data-testid="remove-placement-button"'
] as const;

describe("§10.3 — a PLACED target tile: identity + state compact, everything else under Details", () => {
  it("collapsed by default: heading, hint + facet, outpost line, status pill and the one-line entry gate — and NONE of the detail rows", () => {
    const html = renderWithQueryClient(
      <StageCardForTest stage={stage()} pipelineKey={["pipeline", "c"]} />
    );
    // The compact set.
    expect(html).toContain("commercial-nyc3-prod");
    expect(html).toContain("deploys to prod");
    expect(html, "the facet stays beside the hint").toContain(
      'data-testid="pipeline-target-facet"'
    );
    expect(html).toContain('data-testid="pipeline-target-outpost"');
    expect(html).toContain('data-testid="stage-status-pill"');
    expect(html).toContain('data-testid="stage-gate-summary"');
    expect(html).toContain("entry gate:");
    // The disclosure, shut.
    expect(html).toContain(TOGGLE);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(html, "the region is in the DOM (aria-controls resolves) but hidden and EMPTY").toMatch(
      /<div id="[^"]+" class="[^"]*" hidden="" data-testid="tile-details" data-state="closed"><\/div>/
    );
    // NOT the detail rows — the property, not a sample of it.
    for (const marker of STAGE_DETAIL_MARKERS) {
      expect(html, `${marker} belongs under Details`).not.toContain(marker);
    }
  });

  it("expanded: every detail row is back — nothing that rendered before became unreachable", () => {
    const html = renderWithQueryClient(
      <StageCardForTest detailsExpanded stage={stage()} pipelineKey={["pipeline", "c"]} />
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-state="open"');
    for (const marker of STAGE_DETAIL_MARKERS) {
      expect(html, marker).toContain(marker);
    }
    // And the compact set is still there — Details ADDS, it does not replace.
    expect(html).toContain('data-testid="stage-gate-summary"');
    expect(html).toContain('data-testid="pipeline-target-outpost"');
  });

  it("`detailsExpanded={false}` is the same picture as the default — the default IS collapsed", () => {
    const shut = renderToStaticMarkup(<StageCardForTest detailsExpanded={false} stage={stage()} />);
    const byDefault = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    // `useId` differs per render tree; compare with the ids blanked.
    const blank = (s: string) => s.replace(/(aria-controls|id)=":[^"]+"/g, '$1=""');
    expect(blank(shut)).toBe(blank(byDefault));
  });

  it("the toggle is a native button with the disclosure ARIA — Enter/Space come free", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    const button = /<button[^>]*data-testid="tile-details-toggle"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toContain('type="button"');
    expect(button).toMatch(/aria-expanded="(true|false)"/);
    const controls = /aria-controls="([^"]+)"/.exec(button)?.[1];
    expect(controls, "aria-controls names the region").toBeTruthy();
    expect(html).toContain(`<div id="${controls}"`);
    expect(html, "a lucide chevron, never a glyph literal").toContain("lucide-chevron-right");
    expect(html).not.toContain("▸");
    expect(html).toContain(">Details</button>");
    // Its ACCESSIBLE NAME is per tile — `Details of <title>` — so a page of N tiles does not hand a
    // rotor/screen-reader user N indistinguishable "Details, collapsed, button" controls; the
    // visible text stays the plain word.
    expect(button).toContain('aria-label="Details of commercial-nyc3-prod"');
  });

  it("every kind of tile names WHOSE details its toggle opens — the target's stage name, `Registry`, `Scan & sign`", () => {
    const labelOf = (html: string) =>
      /aria-label="([^"]+)"/.exec(
        /<button[^>]*data-testid="tile-details-toggle"[^>]*>/.exec(html)?.[0] ?? ""
      )?.[1];
    expect(labelOf(renderToStaticMarkup(<StageCardForTest stage={stage()} />))).toBe(
      "Details of commercial-nyc3-prod"
    );
    expect(
      labelOf(renderToStaticMarkup(<StageCardForTest stage={stage({ stageName: null })} />)),
      "no stage name → the target's name, the same fallback the heading uses"
    ).toBe("Details of prod");
    expect(
      labelOf(
        renderWithQueryClient(
          <UnplacedStageCardForTest
            stage={unplaced()}
            componentId="c"
            pipelineKey={["pipeline", "c"]}
          />
        )
      )
    ).toBe("Details of commercial-nyc3-prod");
    expect(
      labelOf(
        renderToStaticMarkup(<RegistryNodeForTest registry={registryDeclared} artifact={null} />)
      )
    ).toBe("Details of Registry");
    expect(labelOf(renderToStaticMarkup(<ScanSignNodeForTest artifact={artifact()} />))).toBe(
      "Details of Scan &amp; sign" // the entity is renderToStaticMarkup's; the DOM reads "&"
    );
  });

  it("the hold moves under Details too — the header pill still says `held` in the compact part", () => {
    const held = stage({
      currents: [
        {
          changeId: "019f0000-0000-7000-8000-00000000e001",
          changeName: "bump-config",
          changeState: "executing",
          waveName: "gamma",
          targetStatus: "pending",
          type: "configuration",
          category: "configuration"
        }
      ],
      hold: {
        changeId: "019f0000-0000-7000-8000-00000000e001",
        changeName: "bump-config",
        waveIndex: 0,
        dependencies: [
          {
            dependsOn: "019f0000-0000-7000-8000-00000000e003",
            dependsOnName: "payments-api",
            branch: "never_deployed",
            satisfied: false,
            summary: "payments-api has never deployed here"
          }
        ]
      }
    });
    const compact = renderToStaticMarkup(<StageCardForTest stage={held} />);
    expect(compact).toContain(">held</");
    expect(compact).not.toContain('data-testid="stage-hold"');
    expect(compact).not.toContain("payments-api");
    const open = renderToStaticMarkup(<StageCardForTest detailsExpanded stage={held} />);
    expect(open).toContain('data-testid="stage-hold"');
    expect(open).toContain("payments-api");
  });
});

describe("§10.3 — the one-line ENTRY GATE summary (compact), the per-check list under Details", () => {
  it("no policy → `entry gate: none — enters as soon as the previous stage succeeds`", () => {
    const html = renderToStaticMarkup(<StageCardForTest stage={stage()} />);
    expect(html).toContain('data-gate-summary="none"');
    expect(html).toContain("none — enters as soon as the previous stage succeeds");
    expect(html, "the full gate subnode is a Details row").not.toContain(
      'data-testid="stage-gate"'
    );
  });

  it("checks → `N checks · <counts by status>`, coloured by the same precedence the marks use", () => {
    expect(gateSummaryText(gate([check(), check({ controlId: "c2", name: "e2e" })]))).toBe(
      "2 checks · 2 passed"
    );
    expect(
      gateSummaryText(
        gate([
          check(),
          check({ controlId: "c2", name: "e2e", status: "fail" }),
          check({ controlId: "c3", name: "lint", status: "pending" })
        ])
      ),
      "failures first — what needs acting on"
    ).toBe("3 checks · 1 failed · 1 in progress · 1 passed");
    expect(gateSummaryText(gate([check({ status: "not_started", changeId: null })]))).toBe(
      "1 check · 1 not started"
    );

    const passing = renderToStaticMarkup(
      <StageCardForTest stage={stage({ gate: gate([check()]) })} />
    );
    expect(passing).toContain('data-gate-summary="pass"');
    expect(passing).toContain("text-green-700");
    const failing = renderToStaticMarkup(
      <StageCardForTest stage={stage({ gate: gate([check({ status: "fail" })]) })} />
    );
    expect(failing).toContain('data-gate-summary="fail"');
    expect(failing).toContain("text-red-700");
    const warned = renderToStaticMarkup(
      <StageCardForTest
        stage={stage({ gate: gate([check(), check({ controlId: "c2", status: "warning" })]) })}
      />
    );
    expect(warned).toContain('data-gate-summary="warning"');
    expect(warned).toContain("text-amber-700");
  });

  it("an APPROVAL-ONLY gate says so — never `0 checks` and nothing else, never `none`", () => {
    // Measured 2026-08-10: every live policy is exactly this shape (an Owner approval, no controls).
    const text = gateSummaryText(gate([], 1));
    expect(text).toBe("0 checks · approval required");
    const html = renderToStaticMarkup(<StageCardForTest stage={stage({ gate: gate([], 1) })} />);
    expect(html).toContain("0 checks · approval required");
    expect(html).not.toContain('data-gate-summary="none"');
    // The approval's WHO/HOW MANY is a Details fact.
    expect(html).not.toContain('data-testid="gate-approval"');
    expect(
      renderToStaticMarkup(
        <StageCardForTest detailsExpanded stage={stage({ gate: gate([], 1) })} />
      )
    ).toContain('data-testid="gate-approval"');
  });

  it("checks AND an approval → both stated", () => {
    expect(gateSummaryText(gate([check()], 2))).toBe("1 check · 1 passed · approval required");
  });
});

describe("§10.3 — an UNPLACED target tile", () => {
  it("compact: heading, hint, Not placed badge, outpost line — the maintainer, the consequence sentence and Place-at-target are Details", () => {
    const compact = renderWithQueryClient(
      <UnplacedStageCardForTest
        stage={unplaced()}
        componentId="c"
        pipelineKey={["pipeline", "c"]}
      />
    );
    expect(compact).toContain("Not placed");
    expect(compact).toContain("declared at prod (DOKS hosted)");
    expect(compact).toContain('data-testid="pipeline-target-outpost"');
    expect(compact).toContain(TOGGLE);
    expect(compact).not.toContain('data-testid="stage-maintainer"');
    expect(compact).not.toContain("never reach this stage");
    expect(compact).not.toContain('data-testid="place-at-target-button"');
    expect(
      compact,
      "no gate on the wire for an unplaced stage → no gate line invented"
    ).not.toContain('data-testid="stage-gate-summary"');

    const open = renderWithQueryClient(
      <UnplacedStageCardForTest
        detailsExpanded
        stage={unplaced()}
        componentId="c"
        pipelineKey={["pipeline", "c"]}
      />
    );
    expect(open).toContain('data-testid="stage-maintainer"');
    expect(open).toContain("never reach this stage");
    expect(open).toContain('data-testid="place-at-target-button"');
  });
});

describe("§10.3 — the BUILD tile has NO Details, so it draws NO toggle", () => {
  it("executor line + SBOM line are the whole tile; no chevron whatever the page asks", () => {
    for (const expanded of [undefined, true, false]) {
      const html = renderToStaticMarkup(
        <BuildNodeForTest
          detailsExpanded={expanded}
          bindings={[BUILD_BINDING]}
          artifact={artifact()}
        />
      );
      expect(html, `expanded=${String(expanded)}`).toContain(
        'data-testid="pipeline-build-executor"'
      );
      expect(html).toContain('data-testid="pipeline-build-sbom"');
      expect(html).not.toContain(TOGGLE);
      expect(html).not.toContain(REGION);
      expect(html).not.toContain(">Details<");
    }
  });

  it("… nor with no bindings, nor with no artifact, nor on an older server", () => {
    for (const art of [artifact(), null, undefined]) {
      const html = renderToStaticMarkup(<BuildNodeForTest bindings={[]} artifact={art} />);
      expect(html, `artifact=${String(art)}`).not.toContain(TOGGLE);
    }
  });
});

describe("§10.3 — the REGISTRY tile: header + digest compact; provenance / explanation under Details", () => {
  it("with a digest: the folded digest is compact, `from change …` is Details", () => {
    const compact = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared} artifact={artifact()} />
    );
    expect(compact).toContain('data-testid="pipeline-registry-digest"');
    expect(compact).toContain("sha256:0123456789ab…");
    expect(compact).toContain("hq-registry");
    expect(compact).toContain("acme/checkout-api");
    expect(compact).toContain(TOGGLE);
    expect(compact).not.toContain("from change");
    expect(compact).not.toContain("checkout-api@1.4.2");
    expect(compact).not.toContain('data-testid="pipeline-registry-provenance"');

    const open = renderToStaticMarkup(
      <RegistryNodeForTest detailsExpanded registry={registryDeclared} artifact={artifact()} />
    );
    expect(open).toContain('data-testid="pipeline-registry-provenance"');
    expect(open).toContain("from change");
    expect(open).toContain("checkout-api@1.4.2");
  });

  it("stated absence / unknown: the one-line state is compact; WHY is a Details sentence (and still the title)", () => {
    const none = renderToStaticMarkup(
      <RegistryNodeForTest registry={registryDeclared} artifact={null} />
    );
    expect(none).toContain("no artifact digest recorded yet");
    expect(none).toContain('data-artifact-state="none"');
    expect(none).toContain(TOGGLE);
    expect(none).not.toContain('data-testid="pipeline-registry-explanation"');
    const noneOpen = renderToStaticMarkup(
      <RegistryNodeForTest detailsExpanded registry={registryDeclared} artifact={null} />
    );
    expect(noneOpen).toContain('data-testid="pipeline-registry-explanation"');
    expect(noneOpen).toContain("the first-party change report is the sole way one arrives");

    const unknownOpen = renderToStaticMarkup(
      <RegistryNodeForTest detailsExpanded registry={registryDeclared} />
    );
    expect(unknownOpen).toContain('data-artifact-state="unknown"');
    expect(unknownOpen).toContain('data-testid="pipeline-registry-explanation"');
    expect(unknownOpen).toContain("does not project the artifact on the component pipeline");
  });

  it("§10.4 — off the commander, the ABSENT imported manifest is a stated absence under Details (`no imported manifest yet — one arrives with a promotion from the commander`), never a silent absence; the commander imports none and says nothing", () => {
    const MARK = 'data-testid="pipeline-registry-imported-manifest"';
    for (const role of ["outpost", "retrans", undefined] as const) {
      const compact = renderToStaticMarkup(
        <RegistryNodeForTest
          registry={registryDeclared}
          artifact={artifact()}
          instanceRole={role}
        />
      );
      expect(compact, `role=${String(role)}: Details, not compact`).not.toContain(MARK);
      const open = renderToStaticMarkup(
        <RegistryNodeForTest
          detailsExpanded
          registry={registryDeclared}
          artifact={artifact()}
          instanceRole={role}
        />
      );
      expect(open, `role=${String(role)}`).toContain(MARK);
      expect(open).toContain('data-state="absent"');
      expect(open).toContain(
        "no imported manifest yet — one arrives with a promotion from the commander"
      );
      expect(open, "the interim §10.1 copy is gone").not.toContain("not projected yet");
      expect(open, "nothing to review → no Review button").not.toContain(
        "Review imported promotion manifest"
      );
    }
    // With NO artifact on the wire the line is still there — it is about the manifest, not the digest.
    expect(
      renderToStaticMarkup(
        <RegistryNodeForTest
          detailsExpanded
          registry={registryDeclared}
          artifact={null}
          instanceRole="outpost"
        />
      )
    ).toContain(MARK);
    const commander = renderToStaticMarkup(
      <RegistryNodeForTest
        detailsExpanded
        registry={registryDeclared}
        artifact={artifact()}
        instanceRole="commander"
      />
    );
    expect(commander).not.toContain(MARK);
    expect(commander).not.toContain("imported manifest");
  });

  it("§10.4 — a PRESENT imported manifest is a COMPACT line (`arrived under a manifest signed by <exporter> · N artifacts · verified at import`) and makes the tile reviewable, on any site; the Details keep the provenance", () => {
    const imported = importedManifest();
    const compact = renderToStaticMarkup(
      <RegistryNodeForTest
        registry={registryDeclared}
        artifact={artifact({
          signing: { promotionExports: [], originSignatureRefs: [], importedManifest: imported }
        })}
        instanceRole="outpost"
      />
    );
    expect(compact).toContain('data-testid="pipeline-registry-imported-manifest"');
    expect(compact).toContain('data-state="present"');
    expect(compact).toContain("arrived under a manifest signed by");
    expect(compact).toContain("hq-commander");
    expect(compact).toContain("2 artifacts");
    expect(compact).toContain("verified at import");
    expect(compact, "reviewable now").toContain('data-reviewable="true"');
    expect(compact).toContain('aria-label="Review imported promotion manifest"');
    expect(compact, "compact: no provenance row").not.toContain(
      'data-testid="pipeline-registry-provenance"'
    );
    const open = renderToStaticMarkup(
      <RegistryNodeForTest
        detailsExpanded
        registry={registryDeclared}
        artifact={artifact({
          signing: { promotionExports: [], originSignatureRefs: [], importedManifest: imported }
        })}
        instanceRole="outpost"
      />
    );
    expect(open).toContain('data-testid="pipeline-registry-provenance"');
    expect(open, "present ⇒ no absence line").not.toContain('data-state="absent"');
  });
});

describe("§10.3 — the SCAN & SIGN tile: four one-liners compact; rows, export lines and origin signature under Details", () => {
  const SCAN_DETAIL_MARKERS = [
    'data-testid="pipeline-scan-state"',
    'data-testid="pipeline-scan-row"',
    'data-testid="pipeline-sign-state"',
    'data-testid="pipeline-sign-row"',
    'data-testid="pipeline-origin-signature"',
    "manifest signed for",
    "origin artifact signature:"
  ] as const;

  it("compact: `scan: pass (2 runs)` · E6 · PM · `signed: for <peer> · <when>` — and none of the rows", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({
          scans: [scan(), scan({ controlRunId: "019f0000-0000-7000-8000-00000000ac02" })],
          exportGate: "pass",
          signing: {
            promotionExports: [
              promotionExport({ exportedAt: "2026-08-14T11:00:00.000Z", peerName: "old-peer" }),
              promotionExport()
            ],
            originSignatureRefs: []
          }
        })}
      />
    );
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(html).toContain('data-scan-summary="pass"');
    expect(html).toContain("scan:");
    expect(html).toContain("pass (2 runs)");
    expect(html).toContain('data-export-gate="pass"');
    expect(html).toContain('data-pm-state="created"');
    expect(html).toContain('data-testid="pipeline-sign-summary"');
    expect(html).toContain("signed:");
    expect(html, "the NEWEST export, and how many there are").toContain("field-outpost");
    expect(html).toContain("2 exports");
    const signed = /data-testid="pipeline-sign-summary"[^>]*>(.*?)<\/p>/s.exec(html)?.[1] ?? "";
    expect(signed).not.toContain("old-peer");
    // Order: scan → E6 → PM → signed.
    expect(at("pipeline-scan-summary")).toBeLessThan(at("pipeline-scan-export-gate"));
    expect(at("pipeline-scan-export-gate")).toBeLessThan(at("pipeline-scan-pm"));
    expect(at("pipeline-scan-pm")).toBeLessThan(at("pipeline-sign-summary"));
    // The Details toggle is there, shut, and none of the rows are.
    expect(html).toContain(TOGGLE);
    expect(html).toContain('aria-expanded="false"');
    for (const marker of SCAN_DETAIL_MARKERS) {
      expect(html, `${marker} belongs under Details`).not.toContain(marker);
    }
    // The review affordance stays in the compact header (reviewable: rows exist).
    expect(html).toContain('data-testid="pipeline-node-scan-sign-review"');
  });

  it("expanded: the rows are back — 2 scan rows, 2 sign rows, the origin-signature line", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        detailsExpanded
        artifact={artifact({
          scans: [scan(), scan({ controlRunId: "019f0000-0000-7000-8000-00000000ac02" })],
          signing: {
            promotionExports: [
              promotionExport({ exportedAt: "2026-08-14T11:00:00.000Z", peerName: "old-peer" }),
              promotionExport()
            ],
            originSignatureRefs: ["sig://origin"]
          }
        })}
      />
    );
    for (const marker of SCAN_DETAIL_MARKERS) {
      expect(html, marker).toContain(marker);
    }
    expect(html.split('data-testid="pipeline-scan-row"').length - 1).toBe(2);
    expect(html.split('data-testid="pipeline-sign-row"').length - 1).toBe(2);
    expect(html).toContain("old-peer");
    expect(html).toContain("sig://origin");
  });

  it("`scan:` folds the ROWS' own statuses, never E6: a fail row → `fail (…)` even when the wire's E6 says pass", () => {
    expect(scanSummary([])).toEqual({ verdict: "not-run", text: "not run" });
    expect(scanSummary([scan()])).toEqual({ verdict: "pass", text: "pass (1 run)" });
    expect(scanSummary([scan(), scan({ status: "fail" })])).toEqual({
      verdict: "fail",
      text: "fail (1 of 2 runs failed · 1 fail · 1 pass)"
    });
    expect(scanSummary([scan({ status: "timed_out" })]).verdict).toBe("fail");
    expect(scanSummary([scan(), scan({ status: "warning" })])).toEqual({
      verdict: "warning",
      text: "warning (1 pass · 1 warning)"
    });
    expect(scanSummary([scan({ status: "skipped" })])).toEqual({
      verdict: "mixed",
      text: "1 skipped (1 run)"
    });
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({ scans: [scan({ status: "fail" })], exportGate: "pass" })}
      />
    );
    expect(html).toContain('data-scan-summary="fail"');
    expect(html).toMatch(/data-scan-summary="fail"[\s\S]*?text-red-700/);
    expect(html, "E6 is its own line and keeps the wire's verdict").toContain(
      'data-export-gate="pass"'
    );
  });

  it("nothing yet: `scan: not run` · E6 not run · PM not created · `signed: not yet` compact; the digest-naming not-run line and the not-signed line are Details", () => {
    const compact = renderToStaticMarkup(<ScanSignNodeForTest artifact={artifact()} />);
    expect(compact).toContain('data-scan-summary="not-run"');
    expect(compact).toContain(">not run</span>");
    expect(compact).toContain('data-pm-state="absent"');
    expect(compact).toMatch(/data-testid="pipeline-sign-summary" data-sign-state="not-signed"/);
    expect(compact).toContain("not yet — signed at export to a peer");
    expect(compact).not.toContain("not run — no scan result recorded for");
    expect(compact).not.toContain("not signed yet — the promotion manifest");
    expect(compact).not.toContain("origin artifact signature:");
    expect(
      compact,
      "there ARE details (the stated absences with their digest) → a toggle"
    ).toContain(TOGGLE);
    const open = renderToStaticMarkup(
      <ScanSignNodeForTest detailsExpanded artifact={artifact()} />
    );
    expect(open).toContain("not run — no scan result recorded for");
    expect(open).toContain("not signed yet — the promotion manifest");
    expect(open).toContain("origin artifact signature:");
  });

  it("`promotionExports:unparseable` with no readable export → `signed: recorded but unreadable`, never `not yet`", () => {
    const html = renderToStaticMarkup(
      <ScanSignNodeForTest
        artifact={artifact({ unknownFields: ["promotionExports:unparseable"] })}
      />
    );
    expect(html).toMatch(/data-testid="pipeline-sign-summary" data-sign-state="unparseable"/);
    expect(html).toContain("recorded but unreadable");
    expect(html).not.toContain("not yet — signed at export");
  });

  it("no artifact (null) or an older server (undefined): ONE stated line, no Details, no toggle", () => {
    for (const art of [null, undefined]) {
      const html = renderToStaticMarkup(<ScanSignNodeForTest artifact={art} />);
      expect(html, `artifact=${String(art)}`).toContain('data-testid="pipeline-scan-state"');
      expect(html).not.toContain(TOGGLE);
      expect(html).not.toContain(REGION);
      expect(html).not.toContain('data-testid="pipeline-scan-summary"');
      expect(html).not.toContain('data-testid="pipeline-sign-summary"');
    }
  });
});

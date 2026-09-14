import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentPipelineArtifact, ComponentPipelineCurrent } from "@scp/schemas";
import type { ComponentPipelineStage } from "@scp/sdk";

/** THE TWO RELEASE PATHS AT A WAVE NODE (journey-view §8.7 D1, §8.11). See docs/web.md §316.
 *
 *  What is under test is the ONE question the old view could not answer: is the artifact this tile is
 *  holding the one this release produced, or one it merely rolls forward? Type cannot answer it — both
 *  deploy-stage changes are `configuration` — so every case here fixes a correlation-key reading. */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, params }: { children?: React.ReactNode; params?: { id?: string } }) => (
    <a data-to-id={params?.id}>{children}</a>
  )
}));

const { artifactRelationToStage, StageCardForTest, LANES } = await import("./component-pipeline");

const SOFTWARE_LANE = LANES.find((l) => l.key === "software")!;
const INFRA_LANE = LANES.find((l) => l.key === "infrastructure")!;

const IMAGE_CHANGE = "019f0000-0000-7000-8000-00000000f00d";
const CONFIG_CHANGE = "019f0000-0000-7000-8000-0000000c0ffe";
const DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function artifact(over: Partial<ComponentPipelineArtifact> = {}): ComponentPipelineArtifact {
  return {
    changeId: IMAGE_CHANGE,
    changeName: "push: agentkit (image)",
    changeCreatedAt: "2026-09-14T10:00:00.000Z",
    correlationKey: null,
    digests: [DIGEST],
    sbom: null,
    scans: [],
    exportGate: "not_run",
    signing: { promotionExports: [], originSignatureRefs: [] },
    unknownFields: [],
    ...over
  };
}

function current(over: Partial<ComponentPipelineCurrent> = {}): ComponentPipelineCurrent {
  return {
    changeId: CONFIG_CHANGE,
    changeName: "push: agentkit-gitops (configuration)",
    changeState: "accepted",
    waveName: "prod",
    targetStatus: "succeeded",
    type: "configuration",
    category: "configuration",
    correlationKey: null,
    ...over
  };
}

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
    binding: null,
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
    currents: [current()],
    gate: { policies: [], checks: [] },
    version: null,
    unknownFields: ["version"],
    ...over
  };
}

describe("artifactRelationToStage — correlation, not Type (journey-view §8.11)", () => {
  it("the SAME change produced it: a one-change release, the only case the old view got right", () => {
    expect(artifactRelationToStage(artifact({ changeId: CONFIG_CHANGE }), current())).toBe(
      "produced"
    );
  });

  it("Path A — a correlated `image` arm built it, so the config release owns it too", () => {
    const key = `change-source-event:${"019f0000-0000-7000-8000-0000000000ee"}`;
    expect(
      artifactRelationToStage(artifact({ correlationKey: key }), current({ correlationKey: key }))
    ).toBe("produced");
  });

  it("Path B — a bare chart bump rolls an artifact from an event it is not part of", () => {
    expect(
      artifactRelationToStage(
        artifact({ correlationKey: "change-source-event:aaa" }),
        current({ correlationKey: "change-source-event:bbb" })
      )
    ).toBe("deployed");
  });

  it("null vs null is NOT a match — two absences are not one shared event", () => {
    // THE CASE THE ESTATE IS ACTUALLY IN. `linkToCoordinatedChange` synthesises a key only on a
    // fan-out, so a single-Type push leaves `changes.correlation_key` NULL — which is why treating
    // null-vs-null as equal would report every Path-B bump as `produced`, the original defect.
    expect(artifactRelationToStage(artifact(), current())).toBe("deployed");
  });

  it("an older server projecting NEITHER key says `unknown` rather than guessing", () => {
    expect(
      artifactRelationToStage(
        artifact({ correlationKey: undefined }),
        current({ correlationKey: undefined })
      )
    ).toBe("unknown");
  });

  it("`unknown` needs only ONE side absent — a half-known comparison is not an answer", () => {
    expect(
      artifactRelationToStage(
        artifact({ correlationKey: "k" }),
        current({ correlationKey: undefined })
      )
    ).toBe("unknown");
    expect(
      artifactRelationToStage(
        artifact({ correlationKey: undefined }),
        current({ correlationKey: "k" })
      )
    ).toBe("unknown");
  });

  it("nothing has released here: no release to attribute the artifact to", () => {
    expect(artifactRelationToStage(artifact(), null)).toBe("unknown");
  });
});

describe("StageArtifactLine — what the wave node says out loud", () => {
  const html = (over: Parameters<typeof StageCardForTest>[0]): string =>
    renderToStaticMarkup(<StageCardForTest detailsExpanded lane={SOFTWARE_LANE} {...over} />);

  it("a Path-B release shows the digest it deploys, labelled `deployed` (D1)", () => {
    const out = html({ stage: stage(), artifact: artifact() });
    expect(out).toContain('data-artifact-relation="deployed"');
    expect(out).toContain("deployed here — built by another release");
    // The digest is SHOWN, not withheld: a chart change does deploy an image (owner, D1).
    expect(out).toContain("sha256:1111");
    // …and it names the change that built it, so the claim is checkable.
    expect(out).toContain(`data-to-id="${IMAGE_CHANGE}"`);
  });

  it("a release that produced the artifact says so, and links nowhere else", () => {
    const out = html({ stage: stage(), artifact: artifact({ changeId: CONFIG_CHANGE }) });
    expect(out).toContain('data-artifact-relation="produced"');
    expect(out).toContain("built by this release");
    expect(out).not.toContain('data-testid="stage-artifact-change-link"');
  });

  it("an older server's silence is stated, not resolved to either path", () => {
    const out = html({
      stage: stage({ currents: [current({ correlationKey: undefined })] }),
      artifact: artifact({ correlationKey: undefined })
    });
    expect(out).toContain('data-artifact-relation="unknown"');
    expect(out).toContain("does not say which release built it");
  });

  it("no artifact prop draws NO line — the caller made no claim", () => {
    expect(html({ stage: stage() })).not.toContain('data-testid="stage-artifact"');
  });

  it("a stated absence of an artifact draws no line either", () => {
    expect(html({ stage: stage(), artifact: null })).not.toContain('data-testid="stage-artifact"');
  });

  it("an artifact carrying no digest draws no line — there is nothing to name", () => {
    expect(html({ stage: stage(), artifact: artifact({ digests: [] }) })).not.toContain(
      'data-testid="stage-artifact"'
    );
  });

  it("a stage nothing has released to draws no line — it would assert a deployment", () => {
    expect(html({ stage: stage({ currents: [] }), artifact: artifact() })).not.toContain(
      'data-testid="stage-artifact"'
    );
  });

  it("the INFRA lane draws no OCI line — an infra apply produces no digest-addressed artifact", () => {
    const out = renderToStaticMarkup(
      <StageCardForTest
        detailsExpanded
        lane={INFRA_LANE}
        stage={stage({
          currents: [current({ type: "infrastructure", category: "infrastructure" })]
        })}
        artifact={artifact()}
      />
    );
    expect(out).not.toContain('data-testid="stage-artifact"');
  });
});

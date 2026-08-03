import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentPipelineStage } from "@scp/sdk";

/**
 * THE RENDERING HALF of "a component's pipeline is continuous".
 *
 * The server half (`apps/server/src/coordination/component-pipeline.integration.test.ts`) proves the
 * projection is well-defined for a component that has never released. This file owns the part a
 * browser can still undo: given that response, does the UI actually PAINT a pipeline — and does it
 * keep "not observed" visually distinct from "nothing deployed"?
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
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { StageCardForTest } = await import("./component-pipeline");

function stage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
  return {
    placement: { id: "019f0000-0000-7000-8000-00000000aaaa", urn: "urn:scp:o:placement:x/y" },
    deploymentTarget: {
      id: "019f0000-0000-7000-8000-00000000bbbb",
      name: "prod",
      environment: "prod",
      region: "nyc3"
    },
    stageName: "commercial-nyc3-prod",
    binding: {
      externalRef: "my-app",
      type: "configuration",
      executionSystemId: "019f0000-0000-7000-8000-00000000cccc",
      executionSystemName: "argocd-prod"
    },
    current: null,
    version: null,
    unknownFields: ["version"],
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
    const html = renderToStaticMarkup(<StageCardForTest stage={stage({ binding: null })} />);
    expect(
      html,
      "an unbound placement fake-succeeds under stage-shaped compilation (ADR-0006 case (a)) — it cannot be silent"
    ).toContain("No executor");
  });
});

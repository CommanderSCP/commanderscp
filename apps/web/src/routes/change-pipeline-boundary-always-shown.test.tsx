import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoundarySegment, Change, ChangeExplainResponse } from "@scp/sdk";

/**
 * "THE BOUNDARY SEGMENT IS **ALWAYS SHOWN**" — pinned at the PAGE, by a check that runs on every PR.
 *
 * ## Why this file exists separately from `change-pipeline-boundary-honesty.test.tsx`
 *
 * That file is the presentational contract: given a segment, does `BoundarySegmentStrip` keep
 * "cannot see" and "observed" distinct and refuse to dress either as a pass? It renders
 * `BoundarySegmentStrip` / `NoBoundarySegment` DIRECTLY. Nothing in it — and nothing anywhere else
 * in the required PR checks — renders `ChangePipelinePage`. The Playwright specs that do walk the
 * real route are guarded in `.github/workflows/ci.yml` by `github.event_name == 'push' &&
 * github.ref == 'refs/heads/main'`, i.e. SKIPPED on pull requests.
 *
 * The gap that left: DELETING the boundary card from `change-pipeline.tsx`, or flipping its
 * `boundarySegment ? <Strip/> : <NoBoundarySegment/>` to render nothing when the segment is null,
 * passes every required PR check with both components still perfectly honest in isolation. "Always
 * shown" is a DoD clause (`docs/BUILD_AND_TEST.md` M16) and it was the one clause no PR-gate test
 * held. This file holds it, at the only altitude that can: the page.
 *
 * ## Both branches, because only one of them is the interesting one
 *
 * The null branch is where "always shown" actually bites. A change that never crossed a domain
 * boundary is the COMMON case, and the tempting simplification is to render nothing for it — which
 * would silently turn "this change has not crossed a domain boundary" (a statement) into an absence
 * (which an operator reads as "there is nothing to say here", i.e. nothing to check). So the
 * present-and-null cases are asserted as a pair.
 *
 * ## Mocking
 *
 * The page's data comes from four `useQuery` calls and its id from the router. Both are stubbed at
 * the module seam: `useQuery` answers off `queryKey[1]`, `useIdParam` returns a fixed id, and
 * `../lib/client` is replaced so no `ScpClient` is constructed. Nothing about the boundary card
 * itself is stubbed — the real `ChangePipelinePage`, the real `BoundarySegmentStrip` and the real
 * `NoBoundarySegment` render.
 */

const CHANGE_ID = "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7b";
const PEER_DOMAIN_ID = "9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d";

const explainData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/use-route-params", () => ({
  useIdParam: () => "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7b"
}));

// The page never reaches the network in this test — every `useQuery` is answered from the fixture
// below — but importing the real module would construct an `ScpClient`, so it is stubbed too.
vi.mock("../lib/client", () => ({ client: {} }));

// Partial: `lib/query-client.ts` constructs a real `QueryClient` at import time, so only `useQuery`
// is replaced.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    // ["change", <what>, id] — see lib/query-client.ts.
    const data = queryKey[1] === "detail" ? explainData.current : undefined;
    return { data, isLoading: false, isError: false, error: null };
  }
}));

const { ChangePipelinePage } = await import("./change-pipeline");

const change = {
  id: CHANGE_ID,
  urn: `urn:scp:change:${CHANGE_ID}`,
  name: "m16.1 always-shown fixture",
  state: "executing",
  emergency: false,
  correlationKey: null,
  sourceKind: null,
  createdAt: "2026-07-29T10:00:00.000Z",
  updatedAt: "2026-07-29T10:00:00.000Z"
} as unknown as Change;

/** A receiving outpost's segment: a real import hop and a real `allow` verdict. */
const receivedAndVerified: BoundarySegment = {
  transfer: {
    state: "received",
    hops: [
      {
        direction: "import",
        status: "confirmed",
        peerDomainId: PEER_DOMAIN_ID,
        checksum: "a".repeat(64),
        observedAt: "2026-07-29T10:05:00.000Z"
      }
    ],
    observedAt: "2026-07-29T10:05:00.000Z"
  },
  validate: {
    state: "verified",
    decisionId: "1b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e",
    observedAt: "2026-07-29T10:06:00.000Z",
    authorizedArtifactCount: 1
  },
  unknownFields: []
};

function renderPage(boundarySegment: BoundarySegment | null): string {
  explainData.current = {
    change,
    plan: null,
    decisions: [],
    controlRuns: [],
    waitStatus: null,
    boundarySegment
  } satisfies ChangeExplainResponse;
  return renderToStaticMarkup(<ChangePipelinePage />);
}

describe("change pipeline page: the boundary segment is ALWAYS shown", () => {
  it("renders the boundary card when the change DID cross a boundary", () => {
    const html = renderPage(receivedAndVerified);

    // Premise: the page rendered at all (not the loading/error early-returns).
    expect(html).toContain('data-testid="pipeline-change-name"');

    expect(html).toContain('data-testid="pipeline-boundary-card"');
    expect(html).toContain("Domain boundary");
    // ...and it is the REAL segment, not a placeholder: the two phases and the real verdict.
    expect(html).toContain('data-testid="boundary-phase-transfer"');
    expect(html).toContain('data-testid="boundary-phase-validate"');
    expect(html).toContain("signatures verified");
    expect(html).not.toContain('data-testid="boundary-segment-absent"');
  });

  it("STILL renders the boundary card — as an explicit statement — when there is NO segment", () => {
    // THE BRANCH THAT MATTERS. `null` is the common case (a domain-local change), and rendering
    // nothing for it is the tempting simplification this assertion exists to stop: an absence reads
    // as "nothing to check here", where the card reads as "checked; it never crossed a boundary".
    const html = renderPage(null);

    expect(html).toContain('data-testid="pipeline-change-name"');
    expect(html).toContain('data-testid="pipeline-boundary-card"');
    expect(html).toContain("Domain boundary");
    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("has not crossed a domain boundary");
    // An absent segment is not a green one.
    expect(html).not.toContain("signatures verified");
    expect(html).not.toContain("bg-green-600");
  });

  it("renders the card for a pre-M16.1 server that omits the field entirely (undefined, not null)", () => {
    // `boundarySegment` is optional/additive within /v1, so an older server simply omits it. The
    // page must not disappear the card on `undefined` either.
    explainData.current = {
      change,
      plan: null,
      decisions: [],
      controlRuns: [],
      waitStatus: null
    } satisfies ChangeExplainResponse;
    const html = renderToStaticMarkup(<ChangePipelinePage />);

    expect(html).toContain('data-testid="pipeline-boundary-card"');
    expect(html).toContain('data-testid="boundary-segment-absent"');
  });
});

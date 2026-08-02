// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScpClient } from "@scp/sdk";
import type { FederationPeerStatus } from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * `/outposts` MUST REPORT A CONTRACT FAILURE, NOT AN EMPTY TABLE (ADR-0023).
 *
 * WHY THIS FILE EXISTS. `outposts-honesty.test.tsx` owns the RENDERING contract of one row and
 * drives the components directly with `renderToStaticMarkup`. Nothing drove the PAGE. So the
 * `statusQuery.isError` branch in `outposts.tsx` — the branch that decides whether a
 * response-validation failure ever reaches a human on this page — had no test at all, and the
 * failure mode it prevents is precisely the one the SPA is worst at showing: `peers` defaults to
 * `[]` on a rejected query, `outposts.length === 0`, and the card would otherwise render
 * "No outpost or retrans peers are paired yet" — a confident, false statement of federation state
 * produced by a failure the SDK had already diagnosed in full.
 *
 * WHY IT DRIVES THE REAL SDK. The behaviour spans two packages: `@scp/sdk` turns a malformed 2xx
 * body into an `ScpResponseValidationError`, react-query turns the rejected `queryFn` into
 * `isError`, and this page must RENDER that. Mocking `client` would stub out the first half — the
 * half that decides whether the second half is reachable at all — which is exactly how a guard test
 * becomes a wording test. So a REAL `ScpClient` runs over a stubbed `fetch`: everything from the
 * wire bytes up is production code.
 *
 * REVERT TESTS:
 *   * delete the `statusQuery.isError` branch in `outposts.tsx` → the first two cases fail on the
 *     missing `outposts-error` node, and the first also fails on the fabricated "No outpost or
 *     retrans peers are paired yet";
 *   * replace `<QueryErrorNotice error={statusQuery.error} …/>` with a fixed string → the second
 *     case fails on the missing operation and field name.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

/** One real `ScpClient` — the same class `lib/client.ts` constructs — so the generated
 *  `responseValidator` and the error interceptor are both live. */
const realClient = new ScpClient({ baseUrl: "/api/v1" });

vi.mock("../lib/client", () => ({ client: realClient }));

const { OutpostsPage } = await import("./outposts");

function peerFixture(overrides: Partial<FederationPeerStatus> = {}): FederationPeerStatus {
  return {
    peer: {
      id: PEER_ID,
      name: "amer-prod",
      role: "outpost",
      baseUrl: "https://outpost.example.net",
      syncScope: { mode: "full" },
      publicKey: "AAAA",
      pokeMode: false,
      pairedAt: "2026-07-01T00:00:00.000Z"
    },
    lastAppliedSequence: 7,
    lastSyncedAt: "2026-07-02T00:00:00.000Z",
    trustTier: null,
    trustTierProvenance: null,
    transportMode: "dialable",
    lastExportedThroughSequence: null,
    lastExportedAt: null,
    lastExportedBundleChecksum: null,
    lastSyncedBundleChecksum: null,
    pendingExportEntryCount: null,
    unknownFields: [],
    recentTransfers: [],
    ...overrides
  };
}

/** What a server that never learned to send `recentTransfers` actually puts on the wire — the KEY
 *  DELETED, which no TYPE in this repo can rule out; only the response validator can. */
function peerWithoutTransfersKey(): FederationPeerStatus {
  const peer: Partial<FederationPeerStatus> = peerFixture();
  delete peer.recentTransfers;
  return peer as FederationPeerStatus;
}

/** A `FederationStatusResponse` whose OTHER required keys are all well-formed, so that a case which
 *  omits one key fails for that key alone. */
function statusBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return { self: null, peers: [], ...overrides };
}

/** Serve `GET /federation/status` as a real HTTP 200 JSON body, VERBATIM — a missing key here is a
 *  missing key on the network. */
function stubFetch(body: unknown): void {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    )
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function renderPage() {
  const rendered = render(
    <QueryClientProvider client={newQueryClient()}>
      <OutpostsPage />
    </QueryClientProvider>
  );
  // React Query settles across several microtask/timer turns; loop until the "Loading…" placeholder
  // is gone rather than guessing a fixed number of ticks (a fixed count is how this class of test
  // first goes green-on-nothing).
  for (let i = 0; i < 50 && rendered.html().includes("Loading…"); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(rendered.html()).not.toContain("Loading…");
  return rendered;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/outposts: a body that fails contract validation must reach the operator", () => {
  it("never reports 'no outposts paired' for a response it could not parse", async () => {
    stubFetch(statusBody({ peers: [peerWithoutTransfersKey()] }));

    const rendered = await renderPage();
    const html = rendered.html();

    // THE FABRICATION: `peers ?? []` makes a REJECTED query indistinguishable from a real empty
    // federation, and the empty-state copy states a fact nobody measured.
    expect(html).not.toContain("outposts-empty");
    expect(html).not.toContain("No outpost or retrans peers are paired yet");
    // …and the failure is reported instead.
    expect(() => rendered.byTestId("outposts-error")).not.toThrow();

    rendered.unmount();
  });

  it("names the operation and the offending field, not a fixed 'could not load' string", async () => {
    stubFetch(statusBody({ peers: [peerWithoutTransfersKey()] }));

    const rendered = await renderPage();
    const text = rendered.byTestId("outposts-error").textContent ?? "";

    // The whole point of the boundary: a version skew, a 401 and an unreachable instance are three
    // faults with three different remedies, and a fixed string reads identically for all three.
    expect(text).toContain("GET /federation/status");
    expect(text).toContain("peers.0.recentTransfers");

    rendered.unmount();
  });

  it("an omitted `peers` list is reported too, and never as an empty federation", async () => {
    stubFetch({ self: null });

    const rendered = await renderPage();

    expect(rendered.html()).not.toContain("No outpost or retrans peers are paired yet");
    expect(rendered.byTestId("outposts-error").textContent ?? "").toContain("peers");

    rendered.unmount();
  });
});

describe("/outposts: a well-formed response is unaffected", () => {
  it("renders the outpost row and no error notice", async () => {
    stubFetch(statusBody({ peers: [peerFixture()] }));

    const rendered = await renderPage();
    const html = rendered.html();

    expect(html).toContain("amer-prod");
    expect(html).not.toContain("outposts-error");

    rendered.unmount();
  });

  it("a genuinely empty peer list still reads as an empty federation", async () => {
    // PREMISE for the cases above: the empty-state copy is reachable, so its ABSENCE there is the
    // error branch winning and not the copy having been deleted.
    stubFetch(statusBody({ peers: [] }));

    const rendered = await renderPage();
    const html = rendered.html();

    // Asserted on the EMPTY-STATE ELEMENT, not on its sentence. This previously pinned the literal
    // copy and broke when the wording changed to say "no OTHER outposts" (the self-domain panel now
    // sits above it, so the old sentence had become untrue). The premise this case exists to
    // establish — that the empty branch is reachable, so its absence in the cases above is the error
    // branch winning — is about which branch rendered, and a testid says that without pinning prose.
    expect(html).toContain('data-testid="outposts-empty"');
    expect(html).not.toContain("outposts-error");

    rendered.unmount();
  });
});

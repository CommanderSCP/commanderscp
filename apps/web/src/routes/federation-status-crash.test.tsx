// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScpClient } from "@scp/sdk";
import type { FederationPeerStatus } from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * Z1 — `/federation` MUST REPORT A CONTRACT FAILURE, NOT SWALLOW IT.
 *
 * WHY THIS FILE WAS REWRITTEN (ADR-0023). Its previous form mocked `client.federation.status()` to
 * RESOLVE with a body whose `recentTransfers` key was deleted, and asserted the row rendered "none".
 * The SDK now validates every 2xx JSON body against the generated schema, so THE REAL SDK CAN NO
 * LONGER PRODUCE THAT RESOLUTION — it rejects. The old assertions therefore pinned a scenario that
 * cannot occur while staying green, giving the web suite zero signal about what the page actually
 * does with a malformed response: the vacuous-guard class (wording, not behaviour) in its purest
 * form. The REVERT TEST it advertised — "delete the `?? []`s and this goes red" — had stopped being
 * true for exactly the same reason.
 *
 * WHAT IT PINS NOW, AND WHY IT DRIVES THE REAL SDK. The behaviour under test spans two packages: the
 * SDK converts a malformed body into an `ScpResponseValidationError`, react-query converts the
 * rejected `queryFn` into `isError`, and this page must RENDER that. Mocking `client` would stub out
 * the first half — the exact half that decides whether the second half is reachable at all. So these
 * tests construct a REAL `ScpClient` over a stubbed `fetch`: everything from the wire bytes up is
 * production code.
 *
 * THE REGRESSION THIS CLOSES, MEASURED. With the real SDK and a body whose one peer omits
 * `recentTransfers`, the page rendered the identity card and an EMPTY "Peers" card — no peer row, and
 * no occurrence anywhere in the DOM of "fail", "error", "contract", "invalid", or "skew". The
 * failure was detected, diagnosed, and then died in the query cache. Before response validation, the
 * `?? []` guard at least rendered that peer's row with "none". Detection that never reaches a human
 * is worse than the guard it replaced; the `isError` branches restore, and improve on, what an
 * operator sees.
 *
 * REVERT TEST: delete the `statusQuery.isError` branch in `federation-status.tsx` and the first case
 * below fails on the missing `federation-status-error` node.
 */

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
const OTHER_PEER_ID = "1f1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

/** One real `ScpClient` — the same class `lib/client.ts` constructs — so the generated
 *  `responseValidator` and the error interceptor are both live. */
const realClient = new ScpClient({ baseUrl: "/api/v1" });

vi.mock("../lib/client", () => ({ client: realClient }));

const { FederationStatusPage } = await import("./federation-status");

function selfFixture() {
  return {
    domainId: "aa11bb22-cc33-4d44-8e55-ff6677889900",
    name: "hq",
    role: "commander",
    publicKey: "AAAA"
  };
}

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/** Serve `GET /federation/self` and `GET /federation/status` as real HTTP 200 JSON. `statusBody` is
 *  written to the wire VERBATIM — a missing key here is a missing key on the network. */
function stubFetch(statusBody: unknown): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      jsonResponse(url.includes("/federation/self") ? selfFixture() : statusBody)
    );
  });
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function renderPage() {
  const rendered = render(
    <QueryClientProvider client={newQueryClient()}>
      <FederationStatusPage />
    </QueryClientProvider>
  );
  // Flush the settled queries into a committed render. React Query settles across several
  // microtask/timer turns; loop until the "Loading…" placeholders are gone rather than guessing a
  // fixed number of ticks (a fixed count is exactly how this file first went green-on-nothing).
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

describe("/federation: a body that fails contract validation must reach the operator", () => {
  it("reports a contract failure naming the operation and the field, not an empty card", async () => {
    stubFetch({ self: selfFixture(), peers: [peerWithoutTransfersKey()] });
    const rendered = await renderPage();

    const notice = rendered.byTestId("federation-status-error");
    expect(notice.getAttribute("data-error-kind")).toBe("contract");
    // the OPERATION — the thing no call-site census could have produced
    expect(notice.textContent).toContain("GET /federation/status");
    // the FIELD that was missing
    expect(notice.textContent).toContain("recentTransfers");
    // and it is legible AS a contract/version-skew failure, not as a network or permission fault
    expect(notice.textContent).toMatch(/contract/i);
    expect(notice.textContent).toMatch(/version skew/i);

    // THE REGRESSION, stated as an assertion: the page must not present this as "no peers".
    expect(rendered.html()).not.toContain("No peers paired yet");
    rendered.unmount();
  });

  it("an omitted `peers` list is reported too, and never as 'no peers paired yet'", async () => {
    stubFetch({ self: selfFixture() });
    const rendered = await renderPage();

    const notice = rendered.byTestId("federation-status-error");
    expect(notice.textContent).toContain("GET /federation/status");
    expect(rendered.byTestId("query-error-fields").textContent).toContain("peers");
    expect(rendered.html()).not.toContain("No peers paired yet");
    rendered.unmount();
  });

  it("the identity card still renders — one bad response is not the whole page", async () => {
    stubFetch({ self: selfFixture(), peers: [peerWithoutTransfersKey()] });
    const rendered = await renderPage();

    // `GET /federation/self` is a SEPARATE operation with its own validator; its body is well
    // formed, so it must be unaffected by the other query's failure.
    expect(rendered.html()).toContain("This domain");
    expect(rendered.html()).toContain("hq");
    rendered.unmount();
  });
});

describe("/federation: a well-formed response is unaffected", () => {
  it("renders every peer row and its transfers, with no error notice", async () => {
    stubFetch({
      self: selfFixture(),
      peers: [
        peerFixture({
          recentTransfers: [
            {
              id: "11111111-2222-4333-8444-555555555555",
              peerDomainId: PEER_ID,
              direction: "export",
              kind: "sync",
              status: "confirmed",
              sinceSequence: null,
              throughSequence: 12,
              createdAt: "2026-07-02T00:00:00.000Z",
              confirmedAt: "2026-07-02T01:00:00.000Z"
            }
          ]
        }),
        peerFixture({
          peer: {
            id: OTHER_PEER_ID,
            name: "emea-prod",
            role: "outpost",
            baseUrl: "https://emea.example.net",
            syncScope: { mode: "full" },
            publicKey: "BBBB",
            pokeMode: false,
            pairedAt: "2026-07-01T00:00:00.000Z"
          }
        })
      ]
    });
    const rendered = await renderPage();

    const html = rendered.html();
    expect(html).toContain(`data-testid="federation-peer-${PEER_ID}"`);
    expect(html).toContain(`data-testid="federation-peer-${OTHER_PEER_ID}"`);
    expect(html).toContain("export");
    expect(html).toContain("confirmed");
    // the second peer HAS an empty ledger, which is still the honest "none"
    expect(html).toContain("none");
    // no false positive: a valid body must not trip the boundary
    expect(html).not.toContain('data-testid="federation-status-error"');
    rendered.unmount();
  });

  it("an empty peer list renders the empty reading, not an error", async () => {
    stubFetch({ self: selfFixture(), peers: [] });
    const rendered = await renderPage();

    expect(rendered.html()).toContain("No peers paired yet");
    expect(rendered.html()).not.toContain('data-testid="federation-status-error"');
    rendered.unmount();
  });
});

describe("/federation: loading is still distinct from every other state", () => {
  it("claims neither 'no peers paired yet' nor a failure while still fetching", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/federation/self")) return Promise.resolve(jsonResponse(selfFixture()));
      return new Promise<Response>(() => {});
    });
    const rendered = render(
      <QueryClientProvider client={newQueryClient()}>
        <FederationStatusPage />
      </QueryClientProvider>
    );
    expect(rendered.html()).toContain("Loading…");
    expect(rendered.html()).not.toContain("No peers paired yet");
    expect(rendered.html()).not.toContain('data-testid="federation-status-error"');
    rendered.unmount();
  });
});

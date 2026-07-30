// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FederationPeerStatus } from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * Z1 — `/federation` MUST NOT WHITE-SCREEN WHEN ONE PEER OMITS ONE KEY.
 *
 * WHAT THIS FILE OWNS. `outposts-honesty.test.tsx` and `outpost-detail-status.test.tsx` pin the
 * `?? []` guard on the two OTHER consumers of `client.federation.status()`. This is the third, and
 * the only one where the dereference sits inside the page body's own `.map` rather than inside a
 * leaf card — so the throw is not contained: it escapes `FederationStatusPage` entirely.
 *
 * THE DEFECT CLASS, stated once (see `outpost-settings.tsx:61-74` for the rule verbatim):
 * `FederationPeerStatus.recentTransfers` is required-not-optional in the schema, and the GENERATED
 * SDK VALIDATES NO RESPONSE AT RUNTIME. A required field is therefore a claim about the server, not
 * a guarantee about the value in hand — an older or partial commander that omits the key hands this
 * page `undefined`, and `undefined.length` throws.
 *
 * MEASURED, before the fix, with exactly the setup below (happy-dom + a real `QueryClientProvider`
 * + one peer whose `recentTransfers` key is deleted):
 *   TypeError: Cannot read properties of undefined (reading 'length')
 * and `container.innerHTML.length === 0` — the WHOLE page painted nothing, including the identity
 * card and the rows of every well-formed peer. `outposts.tsx` routes the operator here by name
 * ("see Federation status"), so the page they are sent to is the page that died.
 *
 * WHY THE WHOLE PAGE AND NOT A LEAF COMPONENT. The row is inline JSX inside `FederationStatusPage`;
 * there is nothing smaller to render. Pinning it therefore requires driving the real query layer,
 * which is why this file opts into the DOM environment rather than using `renderToStaticMarkup`
 * like its siblings.
 *
 * REVERT TEST: delete the `?? []`s at the `recentTransfers` cell in `federation-status.tsx` and the
 * first case below fails with that TypeError.
 */

const statusMock = vi.fn();
const selfMock = vi.fn();

vi.mock("../lib/client", () => ({
  client: {
    federation: {
      status: () => statusMock(),
      self: () => selfMock()
    }
  }
}));

const { FederationStatusPage } = await import("./federation-status");

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
const OTHER_PEER_ID = "1f1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

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
 *  DELETED, which no type in this repo can rule out at runtime. */
function peerWithoutTransfersKey(
  overrides: Partial<FederationPeerStatus> = {}
): FederationPeerStatus {
  const peer: Partial<FederationPeerStatus> = peerFixture(overrides);
  delete peer.recentTransfers;
  return peer as FederationPeerStatus;
}

/** Render the page against a fresh, retry-free QueryClient and let both queries settle. `peers`
 *  is passed straight through, so `undefined` here means the response OMITTED the key. */
async function renderPage(peers: FederationPeerStatus[] | undefined) {
  statusMock.mockResolvedValue(peers === undefined ? {} : { peers });
  selfMock.mockResolvedValue(selfFixture());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <FederationStatusPage />
    </QueryClientProvider>
  );
  // flush the resolved queries into a committed render. React Query settles across several
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
  statusMock.mockReset();
  selfMock.mockReset();
});

describe("/federation: one peer missing `recentTransfers` must not take the page down", () => {
  it("renders the peer, and the page, when the server omits the key entirely", async () => {
    // THE CRASH THIS PINS: without `?? []` this render throws
    // `TypeError: Cannot read properties of undefined (reading 'length')` and the container is empty.
    const rendered = await renderPage([peerWithoutTransfersKey()]);

    expect(rendered.container.innerHTML.length).toBeGreaterThan(0);
    expect(rendered.html()).toContain(`data-testid="federation-peer-${PEER_ID}"`);
    // the absence degrades to the honest empty reading, never to a fabricated ledger
    expect(rendered.html()).toContain("none");
    rendered.unmount();
  });

  it("still renders the OTHER peers' rows and the identity card — one bad row is not the page", async () => {
    const rendered = await renderPage([
      peerWithoutTransfersKey(),
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
    ]);

    const html = rendered.html();
    expect(html).toContain(`data-testid="federation-peer-${OTHER_PEER_ID}"`);
    expect(html).toContain("emea-prod");
    // the identity card sits ABOVE the table: it is collateral of the same throw
    expect(html).toContain("This domain");
    expect(html).toContain("hq");
    rendered.unmount();
  });

  it("renders the transfer rows when the server does send them", async () => {
    const rendered = await renderPage([
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
      })
    ]);

    expect(rendered.html()).toContain("export");
    expect(rendered.html()).toContain("confirmed");
    rendered.unmount();
  });
});

describe("/federation: an omitted `peers` list must not take the page down either (Z5)", () => {
  it("renders the empty reading instead of throwing on `peers.length`", async () => {
    // THE CRASH THIS PINS: `statusQuery.data && statusQuery.data.peers.length === 0` throws
    // `TypeError: Cannot read properties of undefined (reading 'length')` the moment the query
    // resolves a body without the key. `outposts.tsx` has read this as `data?.peers ?? []` since
    // round 3; this page was the twin one file over that never got it.
    const rendered = await renderPage(undefined);

    expect(rendered.container.innerHTML.length).toBeGreaterThan(0);
    expect(rendered.html()).toContain("No peers paired yet");
    // and the identity card above it survives
    expect(rendered.html()).toContain("hq");
    rendered.unmount();
  });

  it("an omitted list is NOT reported while still loading — the two states stay distinct", async () => {
    // `?? []` alone would have made a still-fetching page claim "No peers paired yet". The guard
    // keeps `peersLoaded` separate so the loading placeholder still wins.
    statusMock.mockReturnValue(new Promise(() => {}));
    selfMock.mockResolvedValue(selfFixture());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } }
    });
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <FederationStatusPage />
      </QueryClientProvider>
    );
    expect(rendered.html()).toContain("Loading…");
    expect(rendered.html()).not.toContain("No peers paired yet");
    rendered.unmount();
  });
});

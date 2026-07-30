import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FederationPeerStatus } from "@scp/schemas";

/**
 * `OutpostStatusCard` — the per-outpost detail page's FIRST section, and until now the only
 * exported component on this branch with no test of any kind.
 *
 * WHAT THIS FILE OWNS, and why it is not a duplicate of `outposts-honesty.test.tsx`: that file pins
 * the OVERVIEW row. This card renders the same cells on a different page, and the failure mode it
 * missed is not a wording failure but a CRASH. `recentTransfers` is required-not-optional by
 * `FederationPeerStatusSchema` and the generated SDK validates no response, so a server that omits
 * the key reaches `transfers.length` on `undefined`. On the overview that throw kills one row's
 * page; here the card is the first child of the detail route, so the throw takes Status AND
 * Settings AND Configuration down together — a white screen where three sections should be.
 *
 * The guard therefore has to be pinned by RENDERING with the key absent, not by reading the source:
 * removing `?? []` from `outpost-detail.tsx` must make the first test below throw.
 *
 * `Link` is stubbed for the same reason as in `outposts-honesty.test.tsx` — `useRouter` throws
 * outside a `RouterProvider`.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { OutpostStatusCard, findPeerStatus } = await import("./outpost-detail");

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

function basePeer(overrides: Partial<FederationPeerStatus> = {}): FederationPeerStatus {
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
    lastAppliedSequence: null,
    lastSyncedAt: null,
    trustTier: null,
    trustTierProvenance: null,
    transportMode: "dialable",
    lastExportedThroughSequence: null,
    lastExportedAt: null,
    lastExportedBundleChecksum: null,
    lastSyncedBundleChecksum: null,
    pendingExportEntryCount: null,
    unknownFields: [
      "trustTier",
      "lastSyncedBundleChecksum",
      "lastExportedThroughSequence",
      "lastExportedBundleChecksum",
      "pendingExportEntryCount",
      "healthRollup",
      "appliedAtPeer"
    ],
    recentTransfers: [],
    ...overrides
  };
}

/** The same peer with the `recentTransfers` KEY DELETED — what a server that never learned to send
 *  it actually puts on the wire, which no type in this repo can rule out at runtime. */
function peerWithoutTransfersKey(): FederationPeerStatus {
  const peer: Partial<FederationPeerStatus> = basePeer();
  delete peer.recentTransfers;
  return peer as FederationPeerStatus;
}

describe("OutpostStatusCard: a missing key must not white-screen the detail page", () => {
  it("renders — and does not throw — when the server omits `recentTransfers` entirely", () => {
    // THE CRASH THIS PINS: without `?? []` at the `RecentTransfersCell` call this line throws
    // `TypeError: Cannot read properties of undefined (reading 'length')`, and because this card is
    // the first child of the detail route the whole page paints nothing.
    const html = renderToStaticMarkup(<OutpostStatusCard status={peerWithoutTransfersKey()} />);

    // and the absence degrades to the HONEST empty reading, not to a fabricated ledger
    expect(html).toContain('data-testid="outpost-transfers-none"');
    expect(html).toContain("none recorded here");
    expect(html).not.toContain('data-testid="outpost-transfers"');
  });

  it("still renders every other section when the key is missing — the page is not half-dead", () => {
    const html = renderToStaticMarkup(<OutpostStatusCard status={peerWithoutTransfersKey()} />);

    // the fields that come BEFORE and AFTER the transfers block both survive
    expect(html).toContain("Trust tier");
    expect(html).toContain("Recent transfers (last 5 recorded here)");
    expect(html).toContain('data-testid="outpost-last-poke"');
  });

  it("renders the transfer rows when the server does send them", () => {
    const html = renderToStaticMarkup(
      <OutpostStatusCard
        status={basePeer({
          recentTransfers: [
            {
              id: "11111111-2222-4333-8444-555555555555",
              peerDomainId: PEER_ID,
              direction: "export",
              kind: "sync",
              status: "created",
              sinceSequence: null,
              throughSequence: 12,
              createdAt: "2026-07-02T00:00:00.000Z",
              confirmedAt: null
            }
          ]
        })}
      />
    );

    expect(html).toContain('data-testid="outpost-transfers"');
    expect(html).not.toContain('data-testid="outpost-transfers-none"');
  });
});

describe("OutpostStatusCard: unknowns stay unknown on the detail page too", () => {
  it("never paints a tier for a peer that has none", () => {
    const html = renderToStaticMarkup(<OutpostStatusCard status={basePeer()} />);

    expect(html).toContain('data-trust-tier="unknown"');
    expect(html).not.toContain('data-trust-tier="commercial"');
    // `effectiveCadence` is optional on the wire; absent must read as unreported, never as a number
    expect(html).toContain("unreported");
  });
});

describe("findPeerStatus", () => {
  it("returns null rather than a neighbouring peer when the id matches nothing", () => {
    expect(findPeerStatus([basePeer()], "not-a-peer")).toBeNull();
    expect(findPeerStatus(undefined, PEER_ID)).toBeNull();
    expect(findPeerStatus([basePeer()], undefined)).toBeNull();
    expect(findPeerStatus([basePeer()], PEER_ID)?.peer.name).toBe("amer-prod");
  });
});

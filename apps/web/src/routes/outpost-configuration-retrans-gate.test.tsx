// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { FederationPeerStatus, OutpostConfig } from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * THE STRAY-CONFIG HAZARD, CLOSED (LANE A, retrans-noun sweep).
 *
 * `TrustTierCard`/the tier editor used to be gated only on a config OBJECT existing, never on the
 * PEER's own federation role. `assertOutpostPeerBinding` (`outpost-binding.ts`, ADR-0004) refuses
 * (400) an UPDATE against a peer whose role is not `outpost` exactly as it refuses a CREATE — so a
 * STRAY config object bound to a peer whose role changed to `retrans` after the object was declared
 * (nothing deletes the row when that happens) rendered a live, clickable Save button the server
 * would refuse confusingly. This file pins the fix: the editor is withheld for such a peer and the
 * SAME refusal sentence `DeclareConfigCard` already renders for a non-outpost peer is shown instead.
 *
 * It also pins the two other retrans-role gates on this same wired-up section: the CardDescription
 * branch (a retrans peer holds no commander-declared outpost configuration — only poke-mode applies)
 * and the "managed elsewhere" notes being withheld for a retrans peer (freeze windows / the
 * outpost-local Gitea registry / bundled backends are outpost concepts a CDS-boundary retrans has
 * none of, per M13.1).
 *
 * Driven through the real wired-up `OutpostConfigurationSection` (not just the presentational
 * sub-components) with a mocked SDK, mirroring `outpost-configuration-tier-precondition.test.tsx`'s
 * pattern — a happy-dom render is what lets "no Save control is offered at all" be asserted as an
 * absence in the actual DOM rather than as an attribute beside a control that still renders.
 */

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OWN_DOMAIN = "aa11bb22-cc33-4d44-8e55-ff6677889900";

let listed: OutpostConfig[] = [];

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/client", () => ({
  client: {
    federation: {
      self: async () => ({ domainId: OWN_DOMAIN }),
      listOutposts: async () => listed,
      updateOutpost: vi.fn(),
      updatePeer: vi.fn()
    }
  }
}));

const { OutpostConfigurationSection } = await import("./outpost-configuration");

function configFixture(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return {
    objectId: "11111111-1111-4111-8111-111111111111",
    urn: `urn:scp:outpost:${PEER_ID}`,
    name: "amer-prod",
    peerDomainId: PEER_ID,
    trustTier: "il5",
    originDomainId: OWN_DOMAIN,
    originIsSelf: true,
    provenance: null,
    revision: 1,
    version: 1,
    unknownFields: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function statusFixture(role: "outpost" | "retrans"): FederationPeerStatus {
  return {
    peer: {
      id: PEER_ID,
      name: "amer-prod",
      role,
      baseUrl: "https://peer.example.net",
      syncScope: { mode: "full" },
      publicKey: "AAAA",
      pokeMode: false,
      pairedAt: "2026-07-01T00:00:00.000Z"
    },
    lastAppliedSequence: null,
    lastSyncedAt: null,
    lastPokeReceivedAt: null,
    effectiveCadence: "poll",
    unknownFields: ["healthRollup", "appliedAtPeer"],
    recentTransfers: []
  } as unknown as FederationPeerStatus;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The section has three settled shapes (tier editor / refusal / declare-card) and one loading
 *  shape (`SkeletonRows`) — waiting for any of the three settled testids to appear is the same
 *  "poll a real condition, not a fixed tick count" discipline the sibling precondition tests use. */
const SETTLED_SELECTOR =
  '[data-testid="config-tier-current"], [data-testid="config-role-not-outpost"], [data-testid="config-declare-card"]';

async function renderSection(status: FederationPeerStatus) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OutpostConfigurationSection status={status} />
    </QueryClientProvider>
  );
  await waitUntil(
    () => view.container.querySelector(SETTLED_SELECTOR) !== null,
    "the configuration section to settle"
  );
  return view;
}

describe("a stray config object bound to a retrans peer: no live editor, the measured refusal instead", () => {
  it("offers the tier Save control for an outpost peer with a config object", async () => {
    listed = [configFixture()];
    const view = await renderSection(statusFixture("outpost"));

    expect(view.container.querySelector('[data-testid="config-tier-save"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="config-role-not-outpost"]')).toBeNull();

    view.unmount();
  });

  it("withholds the Save control for a retrans peer and shows the role-not-outpost refusal instead", async () => {
    listed = [configFixture()];
    const view = await renderSection(statusFixture("retrans"));

    expect(view.container.querySelector('[data-testid="config-tier-save"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="config-tier-select"]')).toBeNull();
    const refusal = view.byTestId("config-role-not-outpost");
    expect(refusal.textContent).toContain("federation role is");
    expect(refusal.textContent).toContain("retrans");

    view.unmount();
  });
});

describe("the Configuration card's description branches for a retrans peer", () => {
  it("states a retrans peer holds no commander-declared configuration, and does not call it an outpost", async () => {
    listed = [];
    const view = await renderSection(statusFixture("retrans"));

    const text = view.html().replace(/<[^>]*>/g, " ");
    expect(text).toContain("holds no commander-declared outpost configuration");
    expect(text).toContain("poke-mode below");

    view.unmount();
  });
});

describe("managed-elsewhere notes are withheld for a retrans peer", () => {
  it("renders the notes for an outpost peer", async () => {
    listed = [configFixture()];
    const view = await renderSection(statusFixture("outpost"));

    expect(view.container.querySelector('[data-testid="managed-elsewhere"]')).not.toBeNull();

    view.unmount();
  });

  it("does not render the notes for a retrans peer — freezes/local-registry/bundled-backends are outpost concepts", async () => {
    listed = [configFixture()];
    const view = await renderSection(statusFixture("retrans"));

    expect(view.container.querySelector('[data-testid="managed-elsewhere"]')).toBeNull();

    view.unmount();
  });
});

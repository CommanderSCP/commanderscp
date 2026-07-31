// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { FederationPeerStatus, OutpostConfig } from "@scp/schemas";
import { render, fire } from "../test-support/render-dom";

/**
 * R2 (PR #156 residual) — THE PANEL'S OTHER WRITE DOOR ALSO SENDS ITS PREMISE.
 *
 * `outpost-configuration-precondition.test.tsx` pins that reconcile carries `?ifClaimant=`. This
 * file is the same class of test for `tierMutation`: the trust-tier save button reads `config` off
 * screen and edits it, so the request must carry `expectedVersion` — the same optimistic-concurrency
 * premise, on the API's OTHER door for this object (`PATCH /federation/outposts/{peer}`, which has
 * always accepted `expectedVersion` and always declared 412; only this call site omitted it).
 */

const updateCalls: { peer: string; body: Record<string, unknown> }[] = [];
let listed: OutpostConfig[] = [];

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OWN_DOMAIN = "aa11bb22-cc33-4d44-8e55-ff6677889900";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/client", () => ({
  client: {
    federation: {
      self: async () => ({ domainId: OWN_DOMAIN }),
      listOutposts: async () => listed,
      updateOutpost: async (peer: string, body: Record<string, unknown>) => {
        updateCalls.push({ peer, body });
        return { ...listed[0], trustTier: body.trustTier, version: (listed[0]!.version ?? 0) + 1 };
      }
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
    trustTier: null,
    originDomainId: OWN_DOMAIN,
    originIsSelf: true,
    provenance: null,
    revision: 1,
    version: 7,
    unknownFields: ["trustTier"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

const status = {
  peer: { id: PEER_ID, name: "amer-prod", role: "outpost" }
} as unknown as FederationPeerStatus;

async function renderSection() {
  updateCalls.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OutpostConfigurationSection status={status} />
    </QueryClientProvider>
  );
}

/** One flush of pending promises INSIDE `act` — see the sibling precondition test file for why this
 *  polls a condition rather than sleeping a fixed amount. */
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

describe("the wired-up Configuration card sends expectedVersion on the trust-tier save", () => {
  it("the tier-save button carries the on-screen row's version as expectedVersion", async () => {
    listed = [configFixture()];
    const view = await renderSection();

    await waitUntil(
      () => view.container.querySelector('[data-testid="config-tier-select"]') !== null,
      'data-testid="config-tier-select"'
    );

    const select = view.byTestId("config-tier-select") as HTMLSelectElement;
    select.value = "il5";
    fire(select, new Event("change", { bubbles: true }));

    view.click("config-tier-save");
    await waitUntil(() => updateCalls.length > 0, "the updateOutpost request to be issued");

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.peer).toBe(PEER_ID);
    expect(updateCalls[0]!.body.trustTier).toBe("il5");
    // THE POINT: the version read off the SAME row the form rendered from, not omitted.
    expect(updateCalls[0]!.body.expectedVersion).toBe(7);

    view.unmount();
  });
});

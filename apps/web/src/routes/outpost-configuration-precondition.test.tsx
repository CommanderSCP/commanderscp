// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { FederationPeerStatus, OutpostConfig } from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * WHAT THE CLICK SENDS TO THE SERVER — the request, not the handler argument.
 *
 * `outpost-configuration-interaction.test.tsx` proves the buttons pass the survivor they NAMED into
 * `onReconcile`. That stops at the panel's boundary: the wired-up card turns that argument into an
 * actual `reconcileOutpost` call, and the argument it adds there — the `?ifClaimant=` precondition —
 * is invisible to every test above it. Without this file, a build that computes a perfect preview
 * and then issues an UNGUARDED call passes the whole web suite.
 *
 * THE TWO FAILURES IT GUARDS, both silent 200s without the token:
 *   * the ADOPT-SHADOW control sends no `keep`, so the server re-derives the survivor from rows read
 *     inside its own transaction — a locally-authored claimant that appeared since this card's query
 *     resolved outranks the shadow, and the entered value the button promised to keep is DROPPED;
 *   * naming the shadow with `keep` instead makes that concurrent row surplus, and removing a row
 *     this domain authored journals a tombstone that PROPAGATES to the outpost.
 *
 * The SDK and `@tanstack/react-router` are stubbed; everything else is the real component tree in a
 * real DOM, so the assertion is on the call the card actually made.
 */

const reconcileCalls: { peer: string; opts: Record<string, unknown> }[] = [];
let listed: OutpostConfig[] = [];

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const OWN_DOMAIN = "aa11bb22-cc33-4d44-8e55-ff6677889900";
const OTHER_DOMAIN = "bb22cc33-dd44-4e55-9f66-001122334455";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/client", () => ({
  client: {
    federation: {
      self: async () => ({ domainId: OWN_DOMAIN }),
      listOutposts: async () => listed,
      reconcileOutpost: async (peer: string, opts: Record<string, unknown>) => {
        reconcileCalls.push({ peer, opts });
        return {
          config: listed[0],
          adoptedObjectId: null,
          removedShadowObjectIds: [],
          removedLocalObjectIds: []
        };
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
    version: 4,
    unknownFields: ["trustTier"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function shadowFixture(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return configFixture({
    objectId: "22222222-2222-4222-8222-222222222222",
    trustTier: "il5",
    originDomainId: OTHER_DOMAIN,
    originIsSelf: false,
    provenance: "manual",
    version: 2,
    ...overrides
  });
}

const status = {
  peer: { id: PEER_ID, name: "amer-prod", role: "outpost" }
} as unknown as FederationPeerStatus;

async function renderSection() {
  reconcileCalls.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OutpostConfigurationSection status={status} />
    </QueryClientProvider>
  );
}

/** One flush of pending promises INSIDE `act`, so a query-driven re-render is applied before the
 *  next check (and React does not warn about an unwrapped update). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

/**
 * Wait for a CONDITION, never for a fixed delay.
 *
 * A single `settle()` after render was enough on a fast machine and NOT on a loaded CI runner,
 * where the two queries (`self`, `listOutposts`) had not both resolved before the click — the test
 * then failed looking for a control that simply had not rendered yet. A fixed sleep long enough to
 * be safe everywhere is also a fixed cost paid on every run; polling is both faster and correct.
 */
async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function clickWhenReady(
  view: Awaited<ReturnType<typeof renderSection>>,
  testId: string
): Promise<void> {
  await waitUntil(
    () => view.container.querySelector(`[data-testid="${testId}"]`) !== null,
    `data-testid="${testId}"`
  );
  view.click(testId);
  await waitUntil(() => reconcileCalls.length > 0, "the reconcile request to be issued");
}

describe("the wired-up Configuration card sends the ifClaimant precondition", () => {
  it("the CONFLICT panel's default button carries both the survivor AND the previewed claimant set", async () => {
    const local = configFixture();
    const shadow = shadowFixture();
    listed = [local, shadow];
    const view = await renderSection();
    await clickWhenReady(view, "reconcile-default");

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.peer).toBe(PEER_ID);
    expect(reconcileCalls[0]!.opts.keep).toBe(local.objectId);
    // objectId:version, one per claimant the panel PREVIEWED — `version` is what catches a shadow
    // adopted in place, which keeps its id and would otherwise read as unchanged.
    expect(reconcileCalls[0]!.opts.ifClaimants).toEqual([
      `${local.objectId}:${local.version}`,
      `${shadow.objectId}:${shadow.version}`
    ]);
    view.unmount();
  });

  it("THE DEFECT'S OWN CONTROL: the adopt-shadow button is preconditioned too, though it sends no keep", async () => {
    // The single-claimant path — `TrustTierCard`'s `onReconcile`, which was the one bare
    // `reconcileMutation.mutate(undefined)` left in the panel. Its copy PREDICTS that the entered
    // value is kept and journals down; without the token the server would be free to keep a
    // different row entirely.
    const shadow = shadowFixture();
    listed = [shadow];
    const view = await renderSection();
    await clickWhenReady(view, "config-adopt-shadow");

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.opts.keep).toBeUndefined();
    expect(reconcileCalls[0]!.opts.ifClaimants).toEqual([`${shadow.objectId}:${shadow.version}`]);
    view.unmount();
  });
});

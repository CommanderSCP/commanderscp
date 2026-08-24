// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScpClient } from "@scp/sdk";
import { render } from "../test-support/render-dom";

/**
 * LANE A — the init form offers exactly the roles this instance could honestly hold.
 *
 * OWNER DECISION 2026-08-24, reversing this file's earlier premise. The form USED to offer
 * `retrans` for API-first parity, with a hint shown while it was selected. But a real retrans
 * deployment never serves this UI at all (`app.ts` gates SPA registration on
 * `federationRole !== "retrans"` — M16.3 P3, `retrans-no-spa.integration.test.ts`), so on ANY
 * instance where this form can render, declaring an org retrans is by construction a stray config —
 * it idles relay machinery on a non-boundary box and flips the org's dependencyManagement to
 * `managedHere: false`. The server now refuses it at the init door unless the deployment declares
 * `SCP_FEDERATION_ROLE=retrans` (`apps/server/src/federation/init-role-door.integration.test.ts`),
 * and the form stops offering what every instance able to show it would refuse.
 *
 * What this file pins:
 *   1. the select offers exactly commander|outpost — no retrans option to walk into the 400;
 *   2. the retrans role stays DISCOVERABLE — a persistent note names where it actually lives
 *      (the CDS-boundary deployment + CLI), so the absence reads as structural, never as a
 *      hidden capability (design-system honesty: structurally-expected absence is explained).
 *
 * Driven through the real wired-up `FederationStatusPage` with a real `ScpClient` over a stubbed
 * `fetch`, mirroring `federation-status-crash.test.tsx`'s pattern.
 */
const realClient = new ScpClient({ baseUrl: "/api/v1" });
vi.mock("../lib/client", () => ({ client: realClient }));

const { FederationStatusPage } = await import("./federation-status");

/** `role: "unset"` is the actual not-yet-initialized signal (`ensureFederationSelf` lazily mints it)
 *  — the one state that renders `FederationInitForm` at all. */
function selfFixture() {
  return {
    domainId: "aa11bb22-cc33-4d44-8e55-ff6677889900",
    name: "hq",
    role: "unset",
    publicKey: "AAAA"
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function stubFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      jsonResponse(url.includes("/federation/self") ? selfFixture() : { self: null, peers: [] })
    );
  });
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderInitForm() {
  stubFetch();
  const view = render(
    <QueryClientProvider client={newQueryClient()}>
      <FederationStatusPage />
    </QueryClientProvider>
  );
  for (let i = 0; i < 50 && view.html().includes("Loading…"); i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(view.html()).toContain('data-testid="federation-init-name"');
  return view;
}

describe("the federation-init form's role choices", () => {
  it("offers exactly commander|outpost — retrans is not a choice this instance could honestly hold", async () => {
    const view = await renderInitForm();
    const select = view.byTestId("federation-init-role") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) =>
      o.getAttribute("value")
    );
    expect(options).toEqual(["commander", "outpost"]);
    view.unmount();
  });

  it("keeps retrans DISCOVERABLE: a persistent note names the deployment env var and the CLI path", async () => {
    const view = await renderInitForm();
    const note = view.byTestId("federation-init-retrans-note");
    expect(note.textContent).toContain("retrans");
    expect(note.textContent).toContain("SCP_FEDERATION_ROLE=retrans");
    expect(note.textContent).toContain("scp federation init");
    expect(note.textContent).toContain("serves no UI");
    view.unmount();
  });

  it("the old selection-tracking hint is gone with the selection it tracked", async () => {
    const view = await renderInitForm();
    expect(view.container.querySelector('[data-testid="federation-init-retrans-hint"]')).toBeNull();
    view.unmount();
  });
});

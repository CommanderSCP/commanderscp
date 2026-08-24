// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScpClient } from "@scp/sdk";
import { render, fire } from "../test-support/render-dom";

/**
 * LANE A — the honest retrans hint on `/federation`'s init form.
 *
 * API-first parity (charter principle 3) is why `retrans` stays a real choice in this form's role
 * select — the UI must not shrink the API's own role enum. But a REAL deployment running as a
 * retrans never serves this UI at all: `app.ts` gates SPA registration on
 * `federationRole !== "retrans"` (`SCP_FEDERATION_ROLE`, the M16.3 P3 owner decision —
 * `apps/server/src/federation/retrans-no-spa.integration.test.ts`), so an operator who genuinely
 * reaches this page is, by construction, not on that deployment. Offering the choice with no word
 * about that would let an operator believe initializing as retrans HERE is how a retrans deployment
 * is set up, when the role that actually matters is the install-time env var. This file pins the
 * hint that keeps the choice honest without removing it — shown ONLY while `retrans` is selected, so
 * it never clutters the ordinary commander/outpost path.
 *
 * Driven through the real wired-up `FederationStatusPage` (not the un-exported form directly) with a
 * real `ScpClient` over a stubbed `fetch`, mirroring `federation-status-crash.test.tsx`'s pattern —
 * `FederationInitForm` is stateful (the selected role lives in its own `useState`) and unexported, so
 * the only way to reach the "retrans is selected" state is to actually select it in a real DOM.
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

/** A `<select>`'s value must go through its own prototype setter — a plain assignment leaves
 *  React's change tracker believing nothing happened, and `onChange` never fires (the same class of
 *  gotcha `typeInto` in `render-dom.tsx` documents for `<input>`). */
function selectRole(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter)
    throw new Error("HTMLSelectElement.prototype has no value setter in this environment");
  setter.call(select, value);
  fire(select, new Event("change", { bubbles: true }));
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

describe("the federation-init form's retrans hint", () => {
  it("is absent for the default (commander) selection", async () => {
    const view = await renderInitForm();
    expect(view.container.querySelector('[data-testid="federation-init-retrans-hint"]')).toBeNull();
    view.unmount();
  });

  it("is absent when outpost is selected", async () => {
    const view = await renderInitForm();
    const select = view.byTestId("federation-init-role") as HTMLSelectElement;
    selectRole(select, "outpost");
    expect(view.container.querySelector('[data-testid="federation-init-retrans-hint"]')).toBeNull();
    view.unmount();
  });

  it("appears when retrans is selected, and names the real gate rather than nothing", async () => {
    const view = await renderInitForm();
    const select = view.byTestId("federation-init-role") as HTMLSelectElement;
    selectRole(select, "retrans");

    const hint = view.byTestId("federation-init-retrans-hint");
    expect(hint.textContent).toContain("withholds this UI");
    expect(hint.textContent).toContain("SCP_FEDERATION_ROLE=retrans");
    expect(hint.textContent).toContain("CLI/API");

    // …and selecting back away from retrans withdraws it — the hint tracks the SELECTION, not a
    // one-shot "you once considered retrans" flag.
    selectRole(select, "commander");
    expect(view.container.querySelector('[data-testid="federation-init-retrans-hint"]')).toBeNull();

    view.unmount();
  });

  it("does not remove retrans as a choice — API-first parity stays intact", async () => {
    const view = await renderInitForm();
    const select = view.byTestId("federation-init-role") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option")).map((o) =>
      o.getAttribute("value")
    );
    expect(options).toEqual(["commander", "outpost", "retrans"]);
    view.unmount();
  });
});

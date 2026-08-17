// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import type { CreateObjectRequest } from "@scp/schemas";
import { render } from "../test-support/render-dom";
import {
  COMPONENT,
  bumpFixture,
  inventoryFixture,
  rowFixture,
  unlockFixture
} from "../test-support/dependency-fixtures";

/**
 * WHAT THE CLICK SENDS — the request `client.policies.create` actually receives from the wired-up
 * page, not the builder's return value (component-dependencies.test.tsx pins that half).
 *
 * DELETE-THE-WIRING: the page's `mutationFn` is the ONLY thing that turns a confirm into a policy
 * write. Replace it with a no-op (or point it at another client method) and every case here dies
 * — the enable and opt-out confirms then send nothing, and the refusal case never sees the 409.
 * Also pinned here: the SDK methods the page READS from (unlock / inventory / bumps) — stub any one
 * out and the render fails on that read.
 *
 * The SDK, the route param, the auth context and `@tanstack/react-router`'s Link are stubbed;
 * everything else is the real component tree (Radix dialogs included) in a real DOM.
 */

const createCalls: CreateObjectRequest[] = [];
let createImpl: (req: CreateObjectRequest) => Promise<unknown> = async (req) => ({
  id: "019f0000-0000-7000-8000-00000000f0f0",
  name: req.name
});
let inventoryImpl = () => inventoryFixture({ rows: [rowFixture()] });
let bumpsImpl: () => Promise<unknown> = async () => ({
  component: COMPONENT,
  rows: [bumpFixture()],
  nextCursor: null
});
const readCalls: string[] = [];

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, ...rest }: { children?: React.ReactNode; "data-testid"?: string }) => (
    <a data-testid={rest["data-testid"]}>{children}</a>
  )
}));

vi.mock("../lib/use-route-params", () => ({
  useIdOrUrnParam: () => COMPONENT.id
}));

// The install-time role, mutable per case: the page is a COMMANDER-site page (owner rule
// 2026-08-17 — dependency automation happens only at the commander); any other role gets the
// stated pointer and issues NO reads.
const authState: { instanceRole: "commander" | "outpost" | "retrans" | undefined } = {
  instanceRole: "commander"
};
vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    user: { instanceRole: authState.instanceRole },
    isLoading: false,
    refresh: async () => {}
  })
}));

vi.mock("../lib/client", () => ({
  client: {
    dependencySubscriptions: {
      unlock: async () => {
        readCalls.push("unlock");
        return unlockFixture();
      },
      inventory: async (idOrUrn: string, query: unknown) => {
        readCalls.push(`inventory:${idOrUrn}:${JSON.stringify(query)}`);
        return inventoryImpl();
      },
      bumps: async (idOrUrn: string) => {
        readCalls.push(`bumps:${idOrUrn}`);
        return bumpsImpl();
      }
    },
    policies: {
      create: async (req: CreateObjectRequest) => {
        createCalls.push(req);
        return createImpl(req);
      }
    }
  }
}));

const { ComponentDependenciesPage } = await import("./component-dependencies");

// A case that fails mid-flow leaves its tree mounted (the `unmount()` at its end never runs); the
// next case would then find the previous page's nodes. Start each case from an empty document.
afterEach(() => {
  document.body.innerHTML = "";
});

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

/** Radix portals the dialog to `document.body`, outside the render container. */
function inDocument(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function clickInDocument(testId: string): void {
  const el = inDocument(testId);
  if (!el) throw new Error(`no element carries data-testid="${testId}" in the document`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function renderPage() {
  createCalls.length = 0;
  readCalls.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ComponentDependenciesPage />
    </QueryClientProvider>
  );
  await waitUntil(() => inDocument("enable-open") !== null, "the page to render off the reads");
  return view;
}

describe("the wired-up Dependencies tab is a COMMANDER-site page", () => {
  it.each(["outpost", "retrans", undefined] as const)(
    "instanceRole %s → the 'managed at the commander' pointer renders and NO read is issued",
    async (role) => {
      authState.instanceRole = role;
      createCalls.length = 0;
      readCalls.length = 0;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
      });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <ComponentDependenciesPage />
        </QueryClientProvider>
      );
      await waitUntil(
        () => inDocument("dependencies-managed-at-commander") !== null,
        "the pointer to render"
      );
      expect(document.body.textContent).toContain(
        "Dependency subscriptions are managed at the commander"
      );
      expect(inDocument("enable-open")).toBeNull();
      expect(readCalls).toEqual([]);
      view.unmount();
      authState.instanceRole = "commander";
    }
  );
});

describe("the wired-up Dependencies tab writes ordinary policies through client.policies.create", () => {
  it("reads through the three SDK wrappers (unlock, inventory, bumps) for the route's component", async () => {
    const view = await renderPage();
    expect(readCalls).toContain("unlock");
    expect(readCalls.some((c) => c.startsWith(`inventory:${COMPONENT.id}:`))).toBe(true);
    expect(readCalls).toContain(`bumps:${COMPONENT.id}`);
    // The reads land on the page: the row, the bump, the unlock line.
    expect(inDocument("dependency-row")).not.toBeNull();
    expect(inDocument("bump-row")).not.toBeNull();
    expect(inDocument("instance-unlock")?.getAttribute("data-state")).toBe("unlocked");
    view.unmount();
  });

  it("ENABLE: confirm sends the objectRef-scoped enabling policy with the CHOSEN granularity/delivery, enforcement present, domainId = the component itself", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-confirm") !== null, "the enable dialog to open");
    clickInDocument("enable-granularity-minor_and_patch");
    clickInDocument("enable-delivery-auto_merge");
    clickInDocument("enable-confirm");
    await waitUntil(() => createCalls.length > 0, "the policy create to be issued");

    expect(createCalls).toEqual([
      {
        name: "dependency subscription: checkout-api",
        domainId: COMPONENT.id,
        properties: {
          enforcement: "advisory",
          scope: { objectRef: COMPONENT.id },
          effects: [
            {
              dependencySubscription: {
                enabled: true,
                granularity: "minor_and_patch",
                delivery: "auto_merge"
              }
            }
          ]
        }
      }
    ]);
    // Success closes the dialog and the page says what it wrote; the inventory is re-read.
    await waitUntil(() => inDocument("write-success") !== null, "the success notice");
    expect(inDocument("enable-confirm")).toBeNull();
    expect(readCalls.filter((c) => c.startsWith("inventory:")).length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  it("ENABLE defaults: with nothing chosen the policy asks for the MOST RESTRICTIVE pair (patch / pull_request)", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-confirm") !== null, "the enable dialog to open");
    clickInDocument("enable-confirm");
    await waitUntil(() => createCalls.length > 0, "the policy create to be issued");
    const effect = (
      createCalls[0]!.properties as { effects: { dependencySubscription: unknown }[] }
    ).effects[0]!.dependencySubscription;
    expect(effect).toEqual({ enabled: true, granularity: "patch", delivery: "pull_request" });
    view.unmount();
  });

  it("OPT OUT: the row action's confirm sends the objectRef-scoped opt-out with the line at the EFFECT level", async () => {
    const view = await renderPage();
    clickInDocument("dependency-opt-out");
    await waitUntil(() => inDocument("opt-out-confirm") !== null, "the opt-out dialog to open");
    clickInDocument("opt-out-confirm");
    await waitUntil(() => createCalls.length > 0, "the policy create to be issued");
    expect(createCalls).toEqual([
      {
        name: "dependency opt-out: @acme/lib 1 for checkout-api",
        domainId: COMPONENT.id,
        properties: {
          enforcement: "advisory",
          scope: { objectRef: COMPONENT.id },
          effects: [
            {
              dependencySubscription: {
                enabled: false,
                ecosystem: "npm",
                coordinate: "@acme/lib",
                major: "1"
              }
            }
          ]
        }
      }
    ]);
    view.unmount();
  });

  it("a 409 refusal is rendered IN the open dialog with the server detail and the decision_id Why link; nothing closes", async () => {
    createImpl = async () => {
      throw new ScpApiError("Conflict", {
        status: 409,
        problem: {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "acme/checkout is updated by renovate (renovate.json) — a standing delegation",
          decision_id: "019f0000-0000-7000-8000-00000000d0d0"
        }
      });
    };
    try {
      const view = await renderPage();
      clickInDocument("enable-open");
      await waitUntil(() => inDocument("enable-confirm") !== null, "the enable dialog to open");
      clickInDocument("enable-confirm");
      await waitUntil(() => inDocument("enable-error") !== null, "the refusal to render");
      expect(inDocument("enable-error")!.textContent).toContain("renovate");
      expect(inDocument("enable-error-why")).not.toBeNull();
      expect(inDocument("enable-error-decision-id")!.textContent).toBe(
        "019f0000-0000-7000-8000-00000000d0d0"
      );
      expect(inDocument("enable-confirm")).not.toBeNull();
      expect(inDocument("write-success")).toBeNull();
      view.unmount();
    } finally {
      createImpl = async (req) => ({ id: "019f0000-0000-7000-8000-00000000f0f0", name: req.name });
    }
  });

  it("a 403 refusal names policy:write at this component (or above)", async () => {
    createImpl = async () => {
      throw new ScpApiError("Forbidden", {
        status: 403,
        problem: {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "policy:write is required"
        }
      });
    };
    try {
      const view = await renderPage();
      clickInDocument("dependency-opt-out");
      await waitUntil(() => inDocument("opt-out-confirm") !== null, "the opt-out dialog to open");
      clickInDocument("opt-out-confirm");
      await waitUntil(() => inDocument("opt-out-error") !== null, "the refusal to render");
      const text = inDocument("opt-out-error")!.textContent ?? "";
      expect(text).toContain("policy:write at this component (or above)");
      expect(text).toContain("policy:write is required");
      expect(inDocument("opt-out-error-why")).toBeNull();
      view.unmount();
    } finally {
      createImpl = async (req) => ({ id: "019f0000-0000-7000-8000-00000000f0f0", name: req.name });
    }
  });

  it("the Why control on a row opens the contributions dialog listing every recorded contribution", async () => {
    const view = await renderPage();
    clickInDocument("dependency-why");
    await waitUntil(() => inDocument("contributions-body") !== null, "the Why dialog to open");
    expect(document.querySelectorAll('[data-testid="contribution-row"]')).toHaveLength(2);
    expect(inDocument("contributions-body")!.textContent).toContain(
      "instance:dependency_subscription_unlock"
    );
    view.unmount();
  });

  it("a FAILED bumps read renders as `could not be read` through the page — never `No bumps yet.` beside the error notice", async () => {
    bumpsImpl = async () => {
      throw new Error("listComponentDependencyBumps: 503");
    };
    try {
      const view = await renderPage();
      await waitUntil(
        () => inDocument("dependency-bumps-error") !== null,
        "the bumps error notice"
      );
      expect(inDocument("bumps-unreadable")).not.toBeNull();
      expect(inDocument("bumps-empty")).toBeNull();
      expect(document.body.textContent).not.toContain("No bumps yet.");
      view.unmount();
    } finally {
      bumpsImpl = async () => ({ component: COMPONENT, rows: [bumpFixture()], nextCursor: null });
    }
  });

  it("the not-recorded empty state renders through the page too (no rows, no stamp, no decision)", async () => {
    inventoryImpl = () => inventoryFixture();
    try {
      const view = await renderPage();
      expect(inDocument("inventory-empty")?.getAttribute("data-kind")).toBe("not-recorded");
      expect(document.body.textContent).not.toContain("No dependencies");
      view.unmount();
    } finally {
      inventoryImpl = () => inventoryFixture({ rows: [rowFixture()] });
    }
  });
});

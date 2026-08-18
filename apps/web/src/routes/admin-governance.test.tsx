// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import {
  ObjectListQuerySchema,
  type GovernanceMoveInstanceRung,
  type GovernanceMoveRung,
  type GovernanceMoveRungList,
  type GovernanceMoveRungWriteResponse,
  type PutGovernanceMoveRungRequest
} from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";

/**
 * ADMIN › GOVERNANCE — the wired-up page against a stubbed SDK
 * (governance-reach-on-containment-move.md §9.4).
 *
 * What is pinned, and the mutation each pin exists to catch:
 *
 *   - NO ROLE/WIRE GATE: the page reads and renders identically regardless of `instanceRole` —
 *     enforcement is per-instance, unlike Admin › Dependencies;
 *   - THE INSTANCE WRITE IS NOT OFFERED IN THE BROWSER: no button, form or testid anywhere on the
 *     page can set the instance rung — only the read + the CLI pointer text. Mutation: add a
 *     write control → this test's exhaustive DOM scan goes RED;
 *   - the empty rungs table renders ONLY after a successful zero-row read — never while pending;
 *     mutation: paint it during pending → RED;
 *   - the org rung switch derives its state from the `rungs` list (tier `"org"`), toggles by
 *     calling enable/disable with the org id, and renders 403/409 refusals VERBATIM with a Why
 *     link only when `decision_id` is present;
 *   - Disable on an enabled-rungs row fires on ONE click with no intervening confirm dialog;
 *   - the Enable at… picker's list query stays inside `ObjectListQuerySchema` (limit max 100);
 *   - a successful enable/disable shows the Decision id + Why link and re-reads the rungs list.
 *
 * The SDK, the auth context and `@tanstack/react-router`'s Link are stubbed; everything else is
 * the real component tree (Radix dialogs included) in a real DOM.
 */

const ORG_ID = "019f0000-0000-7000-8000-0000000000f1";
const DOMAIN_ID = "019f0000-0000-7000-8000-00000000d001";
const SERVICE_ID = "019f0000-0000-7000-8000-00000000a001";

function orgRung(overrides: Partial<GovernanceMoveRung> = {}): GovernanceMoveRung {
  return {
    tier: "org",
    subjectObjectId: ORG_ID,
    name: "acme",
    enabledAt: "2026-08-17T00:00:00.000Z",
    enabledByObjectId: "019f0000-0000-7000-8000-00000000ad01",
    ...overrides
  };
}

function serviceRung(overrides: Partial<GovernanceMoveRung> = {}): GovernanceMoveRung {
  return {
    tier: "service",
    subjectObjectId: SERVICE_ID,
    name: "checkout",
    enabledAt: "2026-08-15T00:00:00.000Z",
    enabledByObjectId: "019f0000-0000-7000-8000-00000000ad02",
    ...overrides
  };
}

const calls: { method: string; req?: unknown }[] = [];

let rungsImpl: () => Promise<GovernanceMoveRungList> = async () => ({
  instance: { enabled: false },
  rungs: [serviceRung()]
});
let instanceImpl: () => Promise<GovernanceMoveInstanceRung> = async () => ({
  enabled: false,
  updatedAt: null
});
let enableImpl: (
  idOrUrn: string,
  req: PutGovernanceMoveRungRequest
) => Promise<GovernanceMoveRungWriteResponse> = async (idOrUrn) => ({
  subjectObjectId: idOrUrn,
  tier: idOrUrn === ORG_ID ? "org" : "service",
  enabled: true,
  enforcement: { enforced: true, instance: { enabled: false }, rungs: [] },
  decisionId: "019f0000-0000-7000-8000-00000000d101"
});
let disableImpl: (idOrUrn: string) => Promise<GovernanceMoveRungWriteResponse> = async (
  idOrUrn
) => ({
  subjectObjectId: idOrUrn,
  tier: idOrUrn === ORG_ID ? "org" : "service",
  enabled: false,
  enforcement: { enforced: false, instance: { enabled: false }, rungs: [] },
  decisionId: "019f0000-0000-7000-8000-00000000d102"
});

const RESET_RUNGS = rungsImpl;
const RESET_INSTANCE = instanceImpl;
const RESET_ENABLE = enableImpl;
const RESET_DISABLE = disableImpl;

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    "data-testid"?: string;
  }) => (
    <a
      data-testid={rest["data-testid"]}
      href={
        params ? Object.entries(params).reduce((p, [k, v]) => p.replace(`$${k}`, v), to ?? "") : to
      }
    >
      {children}
    </a>
  )
}));

const authState: { instanceRole: "commander" | "outpost" | "retrans" | undefined } = {
  instanceRole: "commander"
};
vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      orgId: ORG_ID,
      orgName: "acme",
      instanceRole: authState.instanceRole,
      userId: "019f0000-0000-7000-8000-00000000u001",
      username: "admin",
      subjectObjectId: "019f0000-0000-7000-8000-00000000ad01"
    },
    isLoading: false,
    refresh: async () => {}
  })
}));

vi.mock("../lib/client", () => ({
  client: {
    governanceMove: {
      rungs: async () => {
        calls.push({ method: "governanceMove.rungs" });
        return rungsImpl();
      },
      instance: async () => {
        calls.push({ method: "governanceMove.instance" });
        return instanceImpl();
      },
      enable: async (idOrUrn: string, req: PutGovernanceMoveRungRequest) => {
        calls.push({ method: "governanceMove.enable", req: { idOrUrn, ...req } });
        return enableImpl(idOrUrn, req);
      },
      disable: async (idOrUrn: string) => {
        calls.push({ method: "governanceMove.disable", req: { idOrUrn } });
        return disableImpl(idOrUrn);
      }
    },
    domains: {
      list: async (query: unknown) => {
        calls.push({ method: "domains.list", req: query });
        return {
          items: [
            {
              id: DOMAIN_ID,
              name: "payments",
              urn: "urn:scp:default:domain:payments",
              typeId: "domain"
            }
          ],
          nextCursor: null
        };
      }
    },
    services: {
      list: async (query: unknown) => {
        calls.push({ method: "services.list", req: query });
        return {
          items: [
            {
              id: SERVICE_ID,
              name: "checkout",
              urn: "urn:scp:default:service:checkout",
              typeId: "service"
            }
          ],
          nextCursor: null
        };
      }
    },
    assemblies: {
      list: async (query: unknown) => {
        calls.push({ method: "assemblies.list", req: query });
        return { items: [], nextCursor: null };
      }
    }
  }
}));

const { AdminGovernancePage } = await import("./admin-governance");

afterEach(() => {
  document.body.innerHTML = "";
  authState.instanceRole = "commander";
  rungsImpl = RESET_RUNGS;
  instanceImpl = RESET_INSTANCE;
  enableImpl = RESET_ENABLE;
  disableImpl = RESET_DISABLE;
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

function inDocument(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}
function allInDocument(testId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}
function clickInDocument(testId: string): void {
  const el = inDocument(testId);
  if (!el) throw new Error(`no element carries data-testid="${testId}" in the document`);
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function mount() {
  calls.length = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminGovernancePage />
    </QueryClientProvider>
  );
}

async function renderPage() {
  const view = mount();
  await waitUntil(() => inDocument("org-rung-switch") !== null, "the page to render off the reads");
  return view;
}

function problem(status: number, title: string, detail: string, decisionId?: string): ScpApiError {
  return new ScpApiError(title, {
    status,
    problem: {
      type: "about:blank",
      title,
      status,
      detail,
      ...(decisionId ? { decision_id: decisionId } : {})
    }
  });
}

// -------------------------------------------------------------------------------------------

describe("Admin › Governance has NO role/wire gate — enforcement is per-instance", () => {
  it.each(["commander", "outpost", "retrans", undefined] as const)(
    "instanceRole %s still reads and renders the page — never the 'managed at the commander' pointer",
    async (role) => {
      authState.instanceRole = role;
      const view = await renderPage();
      expect(document.body.textContent).not.toContain("managed at the commander");
      expect(inDocument("org-rung-switch")).not.toBeNull();
      view.unmount();
    }
  );
});

describe("the instance rung — READ ONLY, no browser write anywhere on the page", () => {
  it("renders disabled/never-set by default", async () => {
    const view = await renderPage();
    expect(inDocument("instance-badge")?.textContent).toBe("Disabled");
    expect(inDocument("instance-updated-at")?.textContent).toBe("(never set)");
    expect(inDocument("instance-cli-pointer")?.textContent).toContain(
      "scp governance move-enforcement instance set --enabled true|false"
    );
    view.unmount();
  });

  it("renders enabled + the updated-at instant when set", async () => {
    instanceImpl = async () => ({ enabled: true, updatedAt: "2026-08-18T00:00:00.000Z" });
    const view = await renderPage();
    expect(inDocument("instance-badge")?.textContent).toBe("Enabled");
    expect(inDocument("instance-updated-at")?.textContent).toMatch(/ago$/);
    view.unmount();
  });

  it("a failed instance read shows the diagnosis, never a fabricated state", async () => {
    instanceImpl = async () => {
      throw new Error("getGovernanceMoveInstanceRung: 503");
    };
    const view = await renderPage();
    await waitUntil(() => inDocument("instance-error") !== null, "the instance error notice");
    expect(inDocument("instance-error")?.textContent).toContain("503");
    expect(inDocument("instance-badge")).toBeNull();
    view.unmount();
  });

  it("MUTATION-SENSITIVE: no element anywhere on the page can set the instance rung", async () => {
    instanceImpl = async () => ({ enabled: true, updatedAt: "2026-08-18T00:00:00.000Z" });
    const view = await renderPage();
    // Exhaustive: every button/input on the page, none targets the instance rung.
    const controls = [
      ...document.querySelectorAll("button, input, select"),
      ...document.querySelectorAll<HTMLElement>("[data-testid]")
    ];
    for (const el of controls) {
      const testId = el.getAttribute("data-testid") ?? "";
      expect(testId.toLowerCase()).not.toMatch(/instance-(set|enable|disable|toggle|write)/);
    }
    view.unmount();
  });
});

describe("the org rung switch", () => {
  it("reads its state off the rungs list (tier org) — disabled by default, offers Enable at org root", async () => {
    const view = await renderPage();
    expect(inDocument("org-rung-state")?.textContent).toBe("Disabled");
    expect(inDocument("org-rung-toggle")?.textContent).toBe("Enable at org root");
    expect(inDocument("org-rung-name")?.textContent).toBe("acme");
    view.unmount();
  });

  it("shows Enabled + a Disable button when the org rung is present in the list", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [orgRung(), serviceRung()] });
    const view = await renderPage();
    expect(inDocument("org-rung-state")?.textContent).toBe("Enabled");
    expect(inDocument("org-rung-toggle")?.textContent).toBe("Disable");
    view.unmount();
  });

  it("clicking Enable at org root calls governanceMove.enable(orgId, {}) and shows the Decision id + Why link", async () => {
    const view = await renderPage();
    clickInDocument("org-rung-toggle");
    await waitUntil(() => inDocument("rung-write-success") !== null, "the success notice");
    expect(calls.filter((c) => c.method === "governanceMove.enable")).toEqual([
      { method: "governanceMove.enable", req: { idOrUrn: ORG_ID } }
    ]);
    expect(inDocument("rung-write-decision-id")?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000d101"
    );
    expect(inDocument("rung-write-why")).not.toBeNull();
    // The list was re-read.
    expect(calls.filter((c) => c.method === "governanceMove.rungs").length).toBeGreaterThanOrEqual(
      2
    );
    view.unmount();
  });

  it("clicking Disable calls governanceMove.disable(orgId)", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [orgRung()] });
    const view = await renderPage();
    clickInDocument("org-rung-toggle");
    await waitUntil(() => inDocument("rung-write-success") !== null, "the success notice");
    expect(calls.filter((c) => c.method === "governanceMove.disable")).toEqual([
      { method: "governanceMove.disable", req: { idOrUrn: ORG_ID } }
    ]);
    view.unmount();
  });

  it("a 403 renders the server's sentence VERBATIM, with no Why link (no decision_id)", async () => {
    enableImpl = async () => {
      throw problem(403, "Forbidden", "subject '019f...' lacks 'policy:write' at scope '019f...'");
    };
    const view = await renderPage();
    clickInDocument("org-rung-toggle");
    await waitUntil(() => inDocument("org-rung-error") !== null, "the refusal");
    expect(inDocument("org-rung-error")?.textContent).toContain("lacks 'policy:write'");
    expect(inDocument("org-rung-error-why")).toBeNull();
    view.unmount();
  });

  it("a 409 with a decision_id renders the upper-rung sentence AND a Why link", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [orgRung()] });
    disableImpl = async () => {
      throw problem(
        409,
        "Conflict",
        "cannot disable governance:move enforcement: it is also enabled at the instance (commander) rung",
        "019f0000-0000-7000-8000-00000000d999"
      );
    };
    const view = await renderPage();
    clickInDocument("org-rung-toggle");
    await waitUntil(() => inDocument("org-rung-error") !== null, "the refusal");
    expect(inDocument("org-rung-error")?.textContent).toContain("also enabled at the instance");
    expect(inDocument("org-rung-error-why")).not.toBeNull();
    expect(inDocument("org-rung-error-decision-id")?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000d999"
    );
    view.unmount();
  });
});

describe("the enabled-rungs table (containment_domain | service | assembly)", () => {
  it("renders one row per rung, EXCLUDING the org tier (that has its own switch) — tier badge, name linking to the object, enabled-by, relative time", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [orgRung(), serviceRung()] });
    const view = await renderPage();
    const rows = allInDocument("rung-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-tier")).toBe("service");
    expect(inDocument("rung-tier")?.textContent).toBe("service");
    const link = inDocument("rung-link") as HTMLAnchorElement | null;
    expect(link?.textContent).toBe("checkout");
    expect(link?.getAttribute("href")).toBe(`/services/${SERVICE_ID}`);
    expect(inDocument("rung-enabled-by")?.textContent).toBe("019f0000-0000-7000-8000-00000000ad02");
    expect(inDocument("rung-enabled-at")?.textContent).toMatch(/ago$/);
    expect(inDocument("rung-enabled-at")?.getAttribute("title")).toBe("2026-08-15T00:00:00.000Z");
    view.unmount();
  });

  it("the empty state renders ONLY after a successful zero-row read", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [] });
    const view = await renderPage();
    expect(inDocument("rungs-empty")?.textContent).toContain(
      "No rungs enabled below the org root."
    );
    expect(inDocument("rung-row")).toBeNull();
    view.unmount();
  });

  it("while the rungs read is PENDING, nothing paints the empty state", async () => {
    let release: (() => void) | null = null;
    rungsImpl = () =>
      new Promise<GovernanceMoveRungList>((resolve) => {
        release = () => resolve({ instance: { enabled: false }, rungs: [] });
      });
    const view = mount();
    await settle();
    await settle();
    expect(inDocument("governance-pending")).not.toBeNull();
    expect(inDocument("rungs-empty")).toBeNull();
    expect(document.body.textContent).not.toContain("No rungs enabled");
    act(() => release?.());
    await waitUntil(() => inDocument("rungs-empty") !== null, "the empty state after success");
    view.unmount();
  });

  it("a failed rungs read renders the diagnosis, never the empty state", async () => {
    rungsImpl = async () => {
      throw new Error("listGovernanceMoveRungs: 503");
    };
    const view = mount();
    await waitUntil(() => inDocument("rungs-error") !== null, "the error notice");
    expect(inDocument("rungs-error")?.textContent).toContain("503");
    expect(inDocument("rungs-empty")).toBeNull();
    view.unmount();
  });

  it("MUTATION-SENSITIVE: Disable fires on ONE click with NO intervening confirm dialog", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [serviceRung()] });
    const view = await renderPage();
    expect(inDocument("rung-disable")).not.toBeNull();
    clickInDocument("rung-disable");
    // No dialog opens between click and call — the call lands without a second click anywhere.
    await waitUntil(
      () => calls.some((c) => c.method === "governanceMove.disable"),
      "the disable call to fire without an intervening confirm"
    );
    expect(calls.filter((c) => c.method === "governanceMove.disable")).toEqual([
      { method: "governanceMove.disable", req: { idOrUrn: SERVICE_ID } }
    ]);
    expect(inDocument("enable-dialog")).toBeNull();
    view.unmount();
  });

  it("a refusal on a row's Disable renders inline on that row, and the row survives", async () => {
    rungsImpl = async () => ({ instance: { enabled: false }, rungs: [serviceRung()] });
    disableImpl = async () => {
      throw problem(403, "Forbidden", "subject lacks 'policy:write' at scope 'checkout'");
    };
    const view = await renderPage();
    clickInDocument("rung-disable");
    await waitUntil(() => inDocument("rung-disable-error") !== null, "the refusal");
    expect(inDocument("rung-disable-error")?.textContent).toContain("lacks 'policy:write'");
    expect(inDocument("rung-row")).not.toBeNull();
    view.unmount();
  });
});

describe("Enable at… — the container picker", () => {
  it("opens, offers a tier selector, and the domains/services/assemblies list queries stay inside ObjectListQuerySchema", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-confirm") !== null, "the enable dialog to open");
    await waitUntil(() => inDocument("enable-match") !== null, "the domains list (default tier)");
    const pickerReads = calls.filter((c) =>
      ["domains.list", "services.list", "assemblies.list"].includes(c.method)
    );
    expect(pickerReads.length).toBeGreaterThan(0);
    for (const read of pickerReads) {
      const parsed = ObjectListQuerySchema.safeParse(read.req ?? {});
      expect(parsed.success, JSON.stringify(read.req)).toBe(true);
    }
    expect(inDocument("enable-match")?.textContent).toContain("payments");
    view.unmount();
  });

  it("switching tier to Service lists the service picker instead", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-confirm") !== null, "the dialog to open");
    const select = inDocument("enable-tier") as HTMLSelectElement;
    select.value = "service";
    fire(select, new Event("change", { bubbles: true }));
    await waitUntil(
      () => (inDocument("enable-match")?.textContent ?? "").includes("checkout"),
      "the service picker"
    );
    view.unmount();
  });

  it("picking a listed container and confirming calls governanceMove.enable, closes the dialog, and shows success", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-match") !== null, "the picker list");
    clickInDocument("enable-match");
    await waitUntil(() => inDocument("enable-picked") !== null, "the pick to register");
    expect(
      inDocument("enable-confirm") && !(inDocument("enable-confirm") as HTMLButtonElement).disabled
    ).toBe(true);
    clickInDocument("enable-confirm");
    await waitUntil(() => inDocument("rung-write-success") !== null, "the success notice");
    expect(calls.filter((c) => c.method === "governanceMove.enable")).toEqual([
      { method: "governanceMove.enable", req: { idOrUrn: DOMAIN_ID } }
    ]);
    expect(inDocument("enable-dialog")).toBeNull();
    view.unmount();
  });

  it("Enable is DISABLED with nothing typed or picked; a typed id/URN is sent as-is", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-confirm") !== null, "the dialog to open");
    expect((inDocument("enable-confirm") as HTMLButtonElement).disabled).toBe(true);
    typeInto(inDocument("enable-search") as HTMLInputElement, "urn:scp:default:domain:pasted");
    await settle();
    expect((inDocument("enable-confirm") as HTMLButtonElement).disabled).toBe(false);
    clickInDocument("enable-confirm");
    await waitUntil(
      () => calls.some((c) => c.method === "governanceMove.enable"),
      "the enable call"
    );
    expect(calls.filter((c) => c.method === "governanceMove.enable")).toEqual([
      { method: "governanceMove.enable", req: { idOrUrn: "urn:scp:default:domain:pasted" } }
    ]);
    view.unmount();
  });

  it("a 403 on Enable renders the server sentence inline and the dialog stays open", async () => {
    enableImpl = async () => {
      throw problem(403, "Forbidden", "subject lacks 'policy:write' at scope 'payments'");
    };
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-match") !== null, "the picker list");
    clickInDocument("enable-match");
    await waitUntil(() => inDocument("enable-picked") !== null, "the pick");
    clickInDocument("enable-confirm");
    await waitUntil(() => inDocument("enable-error") !== null, "the refusal");
    expect(inDocument("enable-error")?.textContent).toContain("lacks 'policy:write'");
    expect(inDocument("enable-confirm")).not.toBeNull();
    expect(inDocument("rung-write-success")).toBeNull();
    view.unmount();
  });

  it("threads an optional --note into the enable request", async () => {
    const view = await renderPage();
    clickInDocument("enable-open");
    await waitUntil(() => inDocument("enable-match") !== null, "the picker list");
    clickInDocument("enable-match");
    await waitUntil(() => inDocument("enable-picked") !== null, "the pick");
    typeInto(inDocument("enable-note") as HTMLInputElement, "quarterly reorg freeze");
    clickInDocument("enable-confirm");
    await waitUntil(
      () => calls.some((c) => c.method === "governanceMove.enable"),
      "the enable call"
    );
    expect(calls.filter((c) => c.method === "governanceMove.enable")).toEqual([
      {
        method: "governanceMove.enable",
        req: { idOrUrn: DOMAIN_ID, note: "quarterly reorg freeze" }
      }
    ]);
    view.unmount();
  });
});

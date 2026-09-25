// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StackBackendSchema, type StackView } from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";

/**
 * ADMIN › STACK (M29.4, ADR-0058), over a mocked SDK. What is pinned: the page reads through
 * `client.stack.get` with the session alone; every change goes through its `client.stack.*` verb
 * WITH the typed operator credential, and is impossible without one; the honesty of an enabled
 * backend the controller never reported, and of a controller that stopped reporting.
 */

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function view(over: Partial<StackView> = {}): StackView {
  return {
    settings: { updatePolicy: "automatic", upgradeGeneration: 0 },
    controller: {
      release: "1.0.0",
      lastSeenAt: new Date(NOW - 5_000).toISOString(),
      reporting: true,
      observedUpgradeGeneration: 0
    },
    backends: StackBackendSchema.options.map((backend) => ({
      backend,
      enabled: backend === "argo-events" || backend === "argo-workflows",
      sizeTier: "small" as const,
      status:
        backend === "argo-events"
          ? {
              phase: "ready" as const,
              runningVersion: "1.0.0",
              targetVersion: "1.0.0",
              lastError: null,
              needs: [],
              observedAt: new Date(NOW - 5_000).toISOString()
            }
          : backend === "gitea"
            ? {
                phase: "degraded" as const,
                runningVersion: "0.9.0",
                targetVersion: "1.0.0",
                lastError: "release 1.0.0 did not become healthy; rolled back to 0.9.0",
                needs: [
                  {
                    code: "upgrade-rolled-back" as const,
                    message:
                      "The change to release 1.0.0 did not become healthy and was rolled back."
                  }
                ],
                observedAt: new Date(NOW - 5_000).toISOString()
              }
            : null
    })),
    ...over
  };
}

const calls: { method: string; args: unknown[] }[] = [];
let current: StackView = view();

vi.mock("../lib/client", () => ({
  client: {
    stack: {
      get: async () => {
        calls.push({ method: "get", args: [] });
        return current;
      },
      putBackend: async (...args: unknown[]) => {
        calls.push({ method: "putBackend", args });
        return current;
      },
      putSettings: async (...args: unknown[]) => {
        calls.push({ method: "putSettings", args });
        return current;
      },
      requestUpgrade: async (...args: unknown[]) => {
        calls.push({ method: "requestUpgrade", args });
        return current;
      },
      diagnostics: async (...args: unknown[]) => {
        calls.push({ method: "diagnostics", args });
        return { generatedAt: "2026-09-24T12:00:00.000Z", stack: current, backends: [] };
      },
      /** The controller's doors. A page must never reach them. */
      spec: async () => {
        calls.push({ method: "spec", args: [] });
        throw new Error("the browser must never read the controller's spec door");
      },
      putStatus: async () => {
        calls.push({ method: "putStatus", args: [] });
        throw new Error("the browser must never write controller status");
      }
    }
  }
}));

const { AdminStackPage } = await import("./admin-stack");

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}

async function mount() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AdminStackPage />
    </QueryClientProvider>
  );
  for (let i = 0; i < 100 && !calls.some((c) => c.method === "get"); i++) await settle();
  await settle();
  await settle();
  return view;
}

afterEach(() => {
  calls.length = 0;
  current = view();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Admin › Stack", () => {
  it("reads the stack with the session alone, and shows every backend", async () => {
    const page = await mount();
    expect(calls.map((c) => c.method)).toEqual(["get"]);
    for (const b of StackBackendSchema.options)
      expect(page.byTestId(`stack-row-${b}`)).toBeTruthy();
    expect(page.byTestId("stack-phase-argo-events").textContent).toBe("ready");
    expect(page.byTestId("stack-controller-ok").textContent).toContain("release 1.0.0");
  });

  it("an enabled backend the controller has not reported is PENDING, amber-dashed — never a guessed phase", async () => {
    const page = await mount();
    const pending = page.byTestId("stack-phase-argo-workflows");
    expect(pending.textContent).toBe("pending");
    expect(pending.className).toContain("border-dashed");
    expect(pending.className).toContain("text-amber-700");
    // A backend never enabled is a structural absence: an em-dash, not an attention colour.
    expect(page.byTestId("stack-phase-argocd").textContent).toBe("—");
  });

  it("shows a rolled-back upgrade's running and target versions, its need and its error", async () => {
    const page = await mount();
    expect(page.byTestId("stack-phase-gitea").textContent).toBe("degraded");
    expect(page.byTestId("stack-running-gitea").textContent).toBe("0.9.0 → 1.0.0");
    expect(page.byTestId("stack-needs-gitea").textContent).toContain("rolled back");
    expect(page.byTestId("stack-error-gitea").textContent).toContain("did not become healthy");
  });

  it("every change is disabled until the operator credential is entered", async () => {
    const page = await mount();
    for (const id of [
      "stack-toggle-argocd",
      "stack-upgrade",
      "stack-diagnostics",
      "stack-update-policy"
    ]) {
      expect((page.byTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
    page.click("stack-toggle-argocd");
    await settle();
    expect(calls.map((c) => c.method)).toEqual(["get"]);
  });

  it("enable, disable, upgrade and the update policy send the typed credential through their SDK verbs", async () => {
    const page = await mount();
    typeInto(page.byTestId("stack-operator-token") as HTMLInputElement, "scp_op_typed.secret");
    await settle();
    page.click("stack-toggle-argocd");
    await settle();
    page.click("stack-toggle-argo-events");
    await settle();
    page.click("stack-upgrade");
    await settle();
    const policy = page.byTestId("stack-update-policy") as HTMLSelectElement;
    policy.value = "manual";
    fire(policy, new Event("change", { bubbles: true }));
    await settle();
    expect(calls.filter((c) => c.method !== "get")).toEqual([
      { method: "putBackend", args: ["argocd", { enabled: true }, "scp_op_typed.secret"] },
      { method: "putBackend", args: ["argo-events", { enabled: false }, "scp_op_typed.secret"] },
      { method: "requestUpgrade", args: ["scp_op_typed.secret"] },
      { method: "putSettings", args: [{ updatePolicy: "manual" }, "scp_op_typed.secret"] }
    ]);
    expect(page.byTestId("stack-notice").textContent).toContain("Update policy saved");
  });

  it("changing an enabled backend's size sends the tier with it enabled", async () => {
    const page = await mount();
    typeInto(page.byTestId("stack-operator-token") as HTMLInputElement, "tok");
    await settle();
    const size = page.byTestId("stack-size-argo-events") as HTMLSelectElement;
    size.value = "large";
    fire(size, new Event("change", { bubbles: true }));
    await settle();
    expect(calls.find((c) => c.method === "putBackend")?.args).toEqual([
      "argo-events",
      { enabled: true, sizeTier: "large" },
      "tok"
    ]);
    // A disabled backend's size cannot be changed from here: there is nothing running to size.
    expect((page.byTestId("stack-size-argocd") as HTMLSelectElement).disabled).toBe(true);
  });

  it("the diagnostics download goes through the SDK with the credential", async () => {
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      created.push("blob");
      return "blob:x";
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    const page = await mount();
    typeInto(page.byTestId("stack-operator-token") as HTMLInputElement, "tok");
    await settle();
    page.click("stack-diagnostics");
    await settle();
    expect(calls.find((c) => c.method === "diagnostics")?.args).toEqual(["tok"]);
    expect(created).toEqual(["blob"]);
  });

  it("a refused change says why, verbatim", async () => {
    const { ScpApiError } = await import("@scp/sdk");
    const page = await mount();
    const { client } = await import("../lib/client");
    vi.spyOn(client.stack, "putBackend").mockRejectedValueOnce(
      new ScpApiError("Forbidden", {
        status: 403,
        problem: {
          title: "Forbidden",
          status: 403,
          detail: "the Standard Stack requires a deployment operator credential"
        } as never
      })
    );
    typeInto(page.byTestId("stack-operator-token") as HTMLInputElement, "wrong");
    await settle();
    page.click("stack-toggle-gitea");
    await settle();
    expect(page.byTestId("stack-refusal").textContent).toContain(
      "requires a deployment operator credential"
    );
  });

  it("a controller that stopped reporting is said so, and its last report is labelled as such", async () => {
    current = view({
      controller: {
        release: "1.0.0",
        lastSeenAt: new Date(NOW - 3_600_000).toISOString(),
        reporting: false,
        observedUpgradeGeneration: 0
      }
    });
    const page = await mount();
    expect(page.byTestId("stack-controller-stale").textContent).toContain(
      "last report, not the current state"
    );
  });

  it("a controller that never reported says nothing is installed yet", async () => {
    current = view({
      controller: {
        release: null,
        lastSeenAt: null,
        reporting: false,
        observedUpgradeGeneration: null
      }
    });
    const page = await mount();
    expect(page.byTestId("stack-controller-never").textContent).toContain("nothing is installed");
  });

  it("never touches the controller's two doors", async () => {
    const page = await mount();
    typeInto(page.byTestId("stack-operator-token") as HTMLInputElement, "tok");
    page.click("stack-upgrade");
    await settle();
    expect(calls.some((c) => c.method === "spec" || c.method === "putStatus")).toBe(false);
  });
});

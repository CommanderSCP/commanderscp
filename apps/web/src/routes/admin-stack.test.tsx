// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StackBackendSchema, type StackView } from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";

/**
 * ADMIN › STACK (M29.4, ADR-0058), over a mocked SDK. What is pinned: the page reads through
 * `client.stack.get` with the session alone; every change goes through its `client.stack.*` verb
 * with NO credential (owner decision 2026-09-25: the server checks the session's instance-operator
 * role) and is offered only when the session holds that role; the page has no credential field at
 * all; purge needs the backend's name retyped; and the honesty of an enabled backend the controller
 * never reported, and of a controller that stopped reporting.
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
      purgeGeneration: 0,
      rotateGeneration: 0,
      wiring:
        backend === "argo-rollouts"
          ? null
          : backend === "argo-workflows"
            ? {
                wired: true,
                serverUrl: "https://argo-server.scp-argo-workflows.svc:2746",
                caSha256: "c".repeat(64),
                account: "scp-coordinator",
                wiredAt: new Date(NOW - 5_000).toISOString(),
                rotationGeneration: 0
              }
            : backend === "argo-events"
              ? {
                  wired: true,
                  serverUrl: null,
                  caSha256: null,
                  account: null,
                  wiredAt: new Date(NOW - 5_000).toISOString(),
                  rotationGeneration: 0
                }
              : {
                  wired: false,
                  serverUrl: null,
                  caSha256: null,
                  account: null,
                  wiredAt: null,
                  rotationGeneration: null
                },
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
    servesThisOrg: true,
    ...over
  };
}

const calls: { method: string; args: unknown[] }[] = [];
let current: StackView = view();
let holdsRole = true;
const ORG_A = "0198f0a0-0000-7000-8000-00000000000a";
const orgList = {
  items: [
    {
      orgId: ORG_A,
      orgName: "acme",
      attachedAt: new Date(NOW - 60_000).toISOString(),
      attachedBy: {
        mechanism: "install" as const,
        orgId: null,
        userId: null,
        username: null,
        credentialId: null
      }
    }
  ]
};

vi.mock("../lib/client", () => ({
  client: {
    instanceOperators: {
      self: async () => {
        calls.push({ method: "self", args: [] });
        return holdsRole;
      }
    },
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
      purge: async (...args: unknown[]) => {
        calls.push({ method: "purge", args });
        return current;
      },
      rotate: async (...args: unknown[]) => {
        calls.push({ method: "rotate", args });
        return current;
      },
      orgs: async (...args: unknown[]) => {
        calls.push({ method: "orgs", args });
        return orgList;
      },
      attachOrg: async (...args: unknown[]) => {
        calls.push({ method: "attachOrg", args });
        return orgList;
      },
      detachOrg: async (...args: unknown[]) => {
        calls.push({ method: "detachOrg", args });
        return { items: [] };
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
      },
      /** M29.2: the controller's wiring doors. A page must never reach them either. */
      putWiring: async () => {
        calls.push({ method: "putWiring", args: [] });
        throw new Error("the browser must never hand over a wiring");
      },
      deleteWiring: async () => {
        calls.push({ method: "deleteWiring", args: [] });
        throw new Error("the browser must never unwire");
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
  holdsRole = true;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Admin › Stack", () => {
  it("reads the stack with the session alone, and shows every backend", async () => {
    const page = await mount();
    // (With the role, the served-organizations panel reads its list too.)
    expect(calls.map((c) => c.method).sort()).toEqual(["get", "orgs", "self"]);
    for (const b of StackBackendSchema.options)
      expect(page.byTestId(`stack-row-${b}`)).toBeTruthy();
    expect(page.byTestId("stack-phase-argo-events").textContent).toBe("ready");
    expect(page.byTestId("stack-controller-ok").textContent).toContain("release 1.0.0");
  });

  it("OWNER DECISION: the page has no credential field — nothing asks for, or holds, a deployment credential", async () => {
    const page = await mount();
    expect(page.container.querySelector('input[type="password"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="stack-operator-token"]')).toBeNull();
    expect(page.html()).not.toMatch(/scp_op_|operator credential/i);
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

  it("without the instance-operator role every change is off, and the page says why", async () => {
    holdsRole = false;
    const page = await mount();
    for (const id of [
      "stack-toggle-argocd",
      "stack-upgrade",
      "stack-diagnostics",
      "stack-update-policy"
    ]) {
      expect((page.byTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
    }
    expect(page.byTestId("stack-no-role").textContent).toContain("instance-operator role");
    page.click("stack-toggle-argocd");
    await settle();
    expect(calls.filter((c) => !["get", "self", "orgs"].includes(c.method))).toEqual([]);
  });

  it("with the role, enable, disable, upgrade and the update policy go through their SDK verbs with NO credential", async () => {
    const page = await mount();
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
    expect(calls.filter((c) => !["get", "self", "orgs"].includes(c.method))).toEqual([
      { method: "putBackend", args: ["argocd", { enabled: true }] },
      { method: "putBackend", args: ["argo-events", { enabled: false }] },
      { method: "requestUpgrade", args: [] },
      { method: "putSettings", args: [{ updatePolicy: "manual" }] }
    ]);
    expect(page.byTestId("stack-notice").textContent).toContain("Update policy saved");
  });

  it("changing an enabled backend's size sends the tier with it enabled", async () => {
    const page = await mount();
    const size = page.byTestId("stack-size-argo-events") as HTMLSelectElement;
    size.value = "large";
    fire(size, new Event("change", { bubbles: true }));
    await settle();
    expect(calls.find((c) => c.method === "putBackend")?.args).toEqual([
      "argo-events",
      { enabled: true, sizeTier: "large" }
    ]);
    expect((page.byTestId("stack-size-argocd") as HTMLSelectElement).disabled).toBe(true);
  });

  it("purge is offered only for a disabled backend, and only fires once its name is retyped exactly", async () => {
    const page = await mount();
    expect(page.container.querySelector('[data-testid="stack-purge-argo-events"]')).toBeNull();
    page.click("stack-purge-argocd");
    await settle();
    const confirm = page.byTestId("stack-purge-confirm-argocd") as HTMLInputElement;
    expect((page.byTestId("stack-purge-go-argocd") as HTMLButtonElement).disabled).toBe(true);
    typeInto(confirm, "ArgoCD");
    await settle();
    expect((page.byTestId("stack-purge-go-argocd") as HTMLButtonElement).disabled).toBe(true);
    typeInto(confirm, "argocd");
    await settle();
    page.click("stack-purge-go-argocd");
    await settle();
    expect(calls.find((c) => c.method === "purge")?.args).toEqual(["argocd"]);
  });

  it("the diagnostics download goes through the SDK", async () => {
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      created.push("blob");
      return "blob:x";
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    const page = await mount();
    page.click("stack-diagnostics");
    await settle();
    expect(calls.find((c) => c.method === "diagnostics")?.args).toEqual([]);
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

  it("never touches the controller's doors (spec, status, wiring)", async () => {
    const page = await mount();
    page.click("stack-upgrade");
    await settle();
    page.click("stack-rotate-argo-workflows");
    await settle();
    expect(
      calls.some((c) => ["spec", "putStatus", "putWiring", "deleteWiring"].includes(c.method))
    ).toBe(false);
  });

  // ---- M29.2 (ADR-0061) -----------------------------------------------------------------------

  it("M29.2: each backend's wiring is shown — where scpd reaches it and the CA it trusts; Rollouts is n/a", async () => {
    const page = await mount();
    const wf = page.byTestId("stack-wiring-argo-workflows").textContent ?? "";
    expect(wf).toContain("wired");
    expect(wf).toContain("https://argo-server.scp-argo-workflows.svc:2746");
    expect(wf).toContain("CA cccccccccccc");
    expect(page.byTestId("stack-wiring-argo-events").textContent).toContain("does not call it");
    expect(page.byTestId("stack-wiring-argo-rollouts").textContent).toBe("n/a");
    expect(page.byTestId("stack-serves-this-org").textContent).toContain(
      "This organization is served"
    );
  });

  it("M29.2: Rotate is offered for a wired, called backend and goes through its SDK verb with NO credential", async () => {
    const page = await mount();
    expect(page.container.querySelector('[data-testid="stack-rotate-argo-events"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="stack-rotate-argocd"]')).toBeNull();
    page.click("stack-rotate-argo-workflows");
    await settle();
    expect(calls.find((c) => c.method === "rotate")?.args).toEqual(["argo-workflows"]);
    expect(page.byTestId("stack-notice").textContent).toContain("rotation requested");
  });

  it("M29.2: without the role there is no served-organizations panel and Rotate is off", async () => {
    holdsRole = false;
    const page = await mount();
    expect(page.container.querySelector('[data-testid="stack-orgs"]')).toBeNull();
    expect((page.byTestId("stack-rotate-argo-workflows") as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "orgs")).toBe(false);
  });

  it("M29.2: an operator serves and stops serving organizations through the SDK", async () => {
    const page = await mount();
    expect(page.byTestId(`stack-org-${ORG_A}`).textContent).toContain("by default");
    page.click(`stack-org-detach-${ORG_A}`);
    await settle();
    const id = "0198f0a0-0000-7000-8000-00000000000b";
    expect((page.byTestId("stack-org-attach") as HTMLButtonElement).disabled).toBe(true);
    typeInto(page.byTestId("stack-org-attach-id") as HTMLInputElement, id);
    await settle();
    page.click("stack-org-attach");
    await settle();
    expect(calls.filter((c) => c.method === "detachOrg" || c.method === "attachOrg")).toEqual([
      { method: "detachOrg", args: [ORG_A] },
      { method: "attachOrg", args: [id] }
    ]);
  });
});

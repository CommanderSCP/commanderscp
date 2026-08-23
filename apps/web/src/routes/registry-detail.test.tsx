// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import type { GovernanceMoveEnforcement, GraphObject } from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";

/**
 * REGISTRY DETAIL — two new, provider-free pieces threaded onto `RegistryDetailPage` this round
 * (`RegistryDetailPage` itself needs a live router for `useBasePathParam`/`useIdOrUrnParam`, so it
 * is not mounted directly here — the house pattern `admin-governance.tsx`/`admin-dependencies.tsx`
 * already use for their own dialogs and views: export the piece that carries the real logic, thread
 * the SDK verb in as a prop, test THAT).
 *
 * governance-reach-on-containment-move.md §9.4 Q4 follow-up — the "governed here" line:
 *   - `enforced: true` with rungs renders the NEAREST rung (last = deepest, per the schema doc's
 *     org-root-first ordering) with "+N more" naming the rest in the tooltip;
 *   - `enforced: true` with NO rungs (the instance rung alone) names "the instance level" instead of
 *     a rung that does not exist;
 *   - pending / errored / `enforced: false` all render NOTHING — mutation: render on any of those
 *     three → RED (the "absence makes no claim" pin) — each is its own case below;
 *   - the fetch fires exactly ONCE per mount (spy call count) — mutation: fire on every render → RED.
 *
 * Delete… (owner decision 2026-08-18, every registry type):
 *   - the confirm gate requires the object's OWN NAME typed back EXACTLY — mutation: drop the gate
 *     (always enabled) → RED (a case types a near-miss and asserts Delete stays disabled);
 *   - a refusal (409 container-delete guard / 403) renders the server's sentence VERBATIM
 *     (`problem.detail`, not the RFC 9457 `title`) and the dialog stays open — mutation: read
 *     `.message` instead of `.problem.detail` → RED; mutation: close on error → RED;
 *   - success calls `onDeleted` exactly once and nothing is removed optimistically before it does.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    "data-testid": testId,
    className
  }: {
    children?: React.ReactNode;
    to?: string;
    "data-testid"?: string;
    className?: string;
  }) => (
    <a data-testid={testId} href={to} className={className}>
      {children}
    </a>
  )
}));

const { GovernedHereLine, GovernedHereLineForObject, DeleteObjectCard, DeleteObjectDialogBody } =
  await import("./registry-detail");

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

function isDisabled(testId: string): boolean {
  const el = inDocument(testId) as HTMLButtonElement | null;
  if (!el) throw new Error(`no ${testId}`);
  return el.disabled;
}

function mountWithQueryClient(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function rung(
  overrides: Partial<GovernanceMoveEnforcement["rungs"][number]> = {}
): GovernanceMoveEnforcement["rungs"][number] {
  return {
    tier: "containment_domain",
    subjectObjectId: "019f0000-0000-7000-8000-00000000d001",
    name: "platform",
    enabledAt: "2026-08-18T00:00:00.000Z",
    enabledByObjectId: "019f0000-0000-7000-8000-00000000a001",
    ...overrides
  };
}

// -------------------------------------------------------------------------------------------

describe("GovernedHereLine — pure rendering off an already-resolved GovernanceMoveEnforcement", () => {
  it("one rung: names its tier and name, no '+N more', links to /admin/governance", () => {
    const view = render(
      <GovernedHereLine
        enforcement={{ enforced: true, instance: { enabled: false }, rungs: [rung()] }}
      />
    );
    expect(view.byTestId("governed-here-line").textContent).toContain(
      "Moves here are governed — enforcement enabled at"
    );
    expect(view.byTestId("governed-here-rung").textContent).toContain("containment domain");
    expect(view.byTestId("governed-here-rung").textContent).toContain("platform");
    expect(view.byTestId("governed-here-rung").textContent).not.toContain("more");
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/admin/governance");
    view.unmount();
  });

  it("multiple rungs: the LAST (nearest — org-root-first ordering) is named; '+N more' names the rest in the tooltip", () => {
    const org = rung({
      tier: "org",
      name: "acme",
      subjectObjectId: "019f0000-0000-7000-8000-00000000d000"
    });
    const domain = rung({ name: "platform" });
    const service = rung({
      tier: "service",
      name: "checkout",
      subjectObjectId: "019f0000-0000-7000-8000-00000000d002"
    });
    const view = render(
      <GovernedHereLine
        enforcement={{
          enforced: true,
          instance: { enabled: false },
          rungs: [org, domain, service]
        }}
      />
    );
    const rungEl = view.byTestId("governed-here-rung");
    // The NEAREST (last) rung is named in the visible text — "service" and "checkout", not the
    // org-root or the containment-domain rung.
    expect(rungEl.textContent).toContain("service");
    expect(rungEl.textContent).toContain("checkout");
    expect(rungEl.textContent).toContain("(+2 more)");
    // The other two are named in the tooltip, not silently dropped.
    expect(rungEl.title).toContain("org root 'acme'");
    expect(rungEl.title).toContain("containment domain 'platform'");
    view.unmount();
  });

  it("enforced with NO rungs (instance alone) names 'the instance level' — never a rung that does not exist", () => {
    const view = render(
      <GovernedHereLine enforcement={{ enforced: true, instance: { enabled: true }, rungs: [] }} />
    );
    expect(view.byTestId("governed-here-line").textContent).toContain("the instance level");
    view.unmount();
  });
});

describe("GovernedHereLineForObject — the query wiring", () => {
  it("renders the line off a successful enforced:true read, and fetches EXACTLY ONCE", async () => {
    const fetchEnforcement = vi.fn(async (): Promise<GovernanceMoveEnforcement> => ({
      enforced: true,
      instance: { enabled: false },
      rungs: [rung()]
    }));
    const view = mountWithQueryClient(
      <GovernedHereLineForObject
        typeId="component"
        objectId="019f0000-0000-7000-8000-00000000c001"
        detailKey={["registry", "components", "detail", "019f0000-0000-7000-8000-00000000c001"]}
        fetchEnforcement={fetchEnforcement}
      />
    );
    await waitUntil(() => inDocument("governed-here-line") !== null, "the governed-here line");
    expect(fetchEnforcement).toHaveBeenCalledTimes(1);
    expect(fetchEnforcement).toHaveBeenCalledWith(
      "component",
      "019f0000-0000-7000-8000-00000000c001"
    );
    await settle();
    // Settling further does not re-fire the read — exactly once per mount, not per render.
    expect(fetchEnforcement).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("renders NOTHING while pending", async () => {
    const fetchEnforcement = vi.fn(() => new Promise<GovernanceMoveEnforcement>(() => {}));
    const view = mountWithQueryClient(
      <GovernedHereLineForObject
        typeId="domain"
        objectId="019f0000-0000-7000-8000-00000000d001"
        detailKey={["k"]}
        fetchEnforcement={fetchEnforcement}
      />
    );
    await settle();
    expect(inDocument("governed-here-line")).toBeNull();
    view.unmount();
  });

  it("renders NOTHING on a failed read — absence makes no claim, never an error banner here", async () => {
    const fetchEnforcement = vi.fn(async (): Promise<GovernanceMoveEnforcement> => {
      throw new ScpApiError("Forbidden", { status: 403 });
    });
    const view = mountWithQueryClient(
      <GovernedHereLineForObject
        typeId="team"
        objectId="019f0000-0000-7000-8000-00000000e001"
        detailKey={["k"]}
        fetchEnforcement={fetchEnforcement}
      />
    );
    await waitUntil(() => fetchEnforcement.mock.results.length > 0, "the failed read to settle");
    await settle();
    expect(inDocument("governed-here-line")).toBeNull();
    view.unmount();
  });

  it("renders NOTHING on a successful enforced:false read", async () => {
    const fetchEnforcement = vi.fn(async (): Promise<GovernanceMoveEnforcement> => ({
      enforced: false,
      instance: { enabled: false },
      rungs: []
    }));
    const view = mountWithQueryClient(
      <GovernedHereLineForObject
        typeId="service"
        objectId="019f0000-0000-7000-8000-00000000f001"
        detailKey={["k"]}
        fetchEnforcement={fetchEnforcement}
      />
    );
    await waitUntil(() => fetchEnforcement.mock.results.length > 0, "the read to settle");
    await settle();
    expect(inDocument("governed-here-line")).toBeNull();
    view.unmount();
  });
});

// -------------------------------------------------------------------------------------------

function graphObjectStub(): GraphObject {
  // Only `DeleteObjectDialogBody`'s `run()` return type needs satisfying — the dialog reads none
  // of these fields on success, only that the promise resolved.
  return {
    id: "019f0000-0000-7000-8000-00000000b001",
    orgId: "019f0000-0000-7000-8000-00000000a000",
    domainId: null,
    typeId: "team",
    name: "platform-team",
    urn: "urn:scp:default:team:platform-team",
    properties: {},
    labels: {},
    originDomainId: "019f0000-0000-7000-8000-00000000a000",
    revision: 1,
    provenance: null,
    domainLocal: false,
    domainLocalInheritedFrom: null,
    version: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    deletedAt: "2026-08-19T00:00:00.000Z"
  };
}

function problem(status: number, title: string, detail: string): ScpApiError {
  return new ScpApiError(title, {
    status,
    problem: { type: "about:blank", title, status, detail }
  });
}

describe("DeleteObjectDialogBody — the typed-confirmation gate and refusal rendering", () => {
  it("Delete stays disabled until the typed text matches the object's name EXACTLY", async () => {
    const run = vi.fn(async () => graphObjectStub());
    const view = render(
      <DeleteObjectDialogBody
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        run={run}
        onDeleted={() => {}}
        onCancel={() => {}}
      />
    );
    expect(isDisabled("delete-confirm")).toBe(true);
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-tea");
    expect(isDisabled("delete-confirm")).toBe(true);
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-team");
    expect(isDisabled("delete-confirm")).toBe(false);
    // Belt and braces: a dispatched click while mismatched writes nothing.
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-tea");
    fire(
      view.byTestId("delete-confirm"),
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await settle();
    expect(run).not.toHaveBeenCalled();
    view.unmount();
  });

  it("a 409 (container-delete guard) renders the SERVER sentence verbatim; the dialog stays open (onDeleted NOT called)", async () => {
    const detail =
      "cannot delete 'urn:scp:default:team:platform-team': 2 live object(s) are still contained by it — move or delete them first";
    const run = vi.fn(async (): Promise<GraphObject> => {
      throw problem(409, "Conflict", detail);
    });
    const onDeleted = vi.fn();
    const view = render(
      <DeleteObjectDialogBody
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        run={run}
        onDeleted={onDeleted}
        onCancel={() => {}}
      />
    );
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-team");
    fire(
      view.byTestId("delete-confirm"),
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await settle();
    expect(view.byTestId("delete-error").textContent).toBe(detail);
    // NEVER the bare RFC 9457 title ("Conflict") standing in for the explanation.
    expect(view.byTestId("delete-error").textContent).not.toBe("Conflict");
    expect(onDeleted).not.toHaveBeenCalled();
    // The confirm control is still present (the dialog body has not been torn down/closed).
    expect(view.byTestId("delete-confirm")).not.toBeNull();
    view.unmount();
  });

  it("a 403 renders the server's sentence verbatim; the dialog stays open", async () => {
    const detail = "actor lacks 'object:write' at scope '019f0000-0000-7000-8000-00000000b001'";
    const run = vi.fn(async (): Promise<GraphObject> => {
      throw problem(403, "Forbidden", detail);
    });
    const onDeleted = vi.fn();
    const view = render(
      <DeleteObjectDialogBody
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        run={run}
        onDeleted={onDeleted}
        onCancel={() => {}}
      />
    );
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-team");
    fire(
      view.byTestId("delete-confirm"),
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await settle();
    expect(view.byTestId("delete-error").textContent).toBe(detail);
    expect(onDeleted).not.toHaveBeenCalled();
    view.unmount();
  });

  it("success calls onDeleted exactly once, with no error rendered", async () => {
    const run = vi.fn(async () => graphObjectStub());
    const onDeleted = vi.fn();
    const view = render(
      <DeleteObjectDialogBody
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        run={run}
        onDeleted={onDeleted}
        onCancel={() => {}}
      />
    );
    typeInto(view.byTestId("delete-confirm-name") as HTMLInputElement, "platform-team");
    fire(
      view.byTestId("delete-confirm"),
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await waitUntil(() => onDeleted.mock.calls.length > 0, "onDeleted to fire");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe("DeleteObjectCard — the trigger, the dialog, and NO optimistic removal", () => {
  it("names the type + name + urn in the dialog; closed dialogs render no confirm control at all", () => {
    const view = mountWithQueryClient(
      <DeleteObjectCard
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        idOrUrn="019f0000-0000-7000-8000-00000000b001"
        runDelete={async () => graphObjectStub()}
        onDeleted={() => {}}
      />
    );
    // Never offered as already-done: no delete has happened, and the confirm control does not
    // exist in the DOM until the dialog is opened (Radix's `open ? <Body/> : null` pattern).
    expect(inDocument("delete-confirm")).toBeNull();
    clickInDocument("delete-open");
    expect(inDocument("delete-dialog")).not.toBeNull();
    expect(document.body.textContent).toContain("platform-team");
    expect(document.body.textContent).toContain("urn:scp:default:team:platform-team");
    view.unmount();
  });

  it("on success, calls the runDelete verb with the given idOrUrn and invokes onDeleted", async () => {
    const runDelete = vi.fn(async () => graphObjectStub());
    const onDeleted = vi.fn();
    const view = mountWithQueryClient(
      <DeleteObjectCard
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        idOrUrn="019f0000-0000-7000-8000-00000000b001"
        runDelete={runDelete}
        onDeleted={onDeleted}
      />
    );
    clickInDocument("delete-open");
    typeInto(inDocument("delete-confirm-name") as HTMLInputElement, "platform-team");
    clickInDocument("delete-confirm");
    await waitUntil(() => onDeleted.mock.calls.length > 0, "onDeleted to fire");
    expect(runDelete).toHaveBeenCalledWith("019f0000-0000-7000-8000-00000000b001");
    view.unmount();
  });

  it("on a refusal, the dialog stays open and onDeleted is never called", async () => {
    const detail =
      "cannot delete 'urn:scp:default:team:platform-team': 1 live placement(s) name it";
    const runDelete = vi.fn(async (): Promise<GraphObject> => {
      throw problem(409, "Conflict", detail);
    });
    const onDeleted = vi.fn();
    const view = mountWithQueryClient(
      <DeleteObjectCard
        typeLabel="team"
        name="platform-team"
        urn="urn:scp:default:team:platform-team"
        idOrUrn="019f0000-0000-7000-8000-00000000b001"
        runDelete={runDelete}
        onDeleted={onDeleted}
      />
    );
    clickInDocument("delete-open");
    typeInto(inDocument("delete-confirm-name") as HTMLInputElement, "platform-team");
    clickInDocument("delete-confirm");
    await waitUntil(() => inDocument("delete-error") !== null, "the refusal to render");
    expect(inDocument("delete-error")?.textContent).toBe(detail);
    expect(inDocument("delete-dialog")).not.toBeNull();
    expect(onDeleted).not.toHaveBeenCalled();
    view.unmount();
  });
});

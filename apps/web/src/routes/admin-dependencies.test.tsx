// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import {
  ObjectListQuerySchema,
  type DeclareDependencyLineProducerRequest,
  type DependencyLineProducerVerbResponse,
  type ListDependencyLineProducersResponse,
  type RetractDependencyLineProducerRequest
} from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";
import {
  COMPONENT,
  lineImpactFixture,
  producerFixture,
  verbResponseFixture
} from "../test-support/dependency-fixtures";

/**
 * ADMIN › DEPENDENCIES — the wired-up page against a stubbed SDK
 * (docs/proposals/dependency-subscription-ui.md §12.5).
 *
 * What is pinned, and the mutation each pin exists to catch:
 *   - the ROLE GATE: any non-commander role renders the pointer and issues ZERO SDK calls (spy);
 *     mutation: issue the list read regardless of role → RED;
 *   - the WIRE gate: `dependencyManagement.managedHere: false` on a commander → pointer, no table;
 *   - the empty state renders ONLY after a successful zero-row read — never while pending or after
 *     an error; mutation: paint it during pending → RED;
 *   - the Declare dialog runs `dryRun: true` BEFORE the write and the Declare button is disabled
 *     until a preview exists for the SAME values; mutation: drop the preview gate → RED (the
 *     "disabled before preview" assertion and the "no non-dry-run call before preview" spy);
 *     invalidation is pinned PER FIELD — ecosystem, coordinate AND producer each re-disable Declare
 *     (mutation: drop any one of the three from the preview key → that field's case goes RED);
 *   - the picker's components.list query stays inside ObjectListQuerySchema (limit max 100 — a
 *     larger value is a 400 on the real server, invisible behind a mocked SDK); mutation: 200 → RED;
 *   - every refusal status renders the server sentence; the retract dialog renders the real
 *     response's open bumps and stays open on them.
 *
 * The SDK, the auth context and `@tanstack/react-router`'s Link are stubbed; everything else is
 * the real component tree (Radix dialogs included) in a real DOM.
 */

type ProducersList = ListDependencyLineProducersResponse;

const calls: { method: string; req?: unknown }[] = [];
let listImpl: () => Promise<ProducersList> = async () => ({
  producers: [producerFixture()],
  dependencyManagement: { managedHere: true, reason: "commander" }
});
let declareImpl: (
  req: DeclareDependencyLineProducerRequest
) => Promise<DependencyLineProducerVerbResponse> = async (req) =>
  verbResponseFixture({
    ecosystem: req.ecosystem,
    coordinate: req.coordinate,
    dryRun: req.dryRun === true,
    declaration: req.dryRun ? null : producerFixture({ coordinate: req.coordinate }),
    decisionId: req.dryRun ? null : "019f0000-0000-7000-8000-00000000d3c1"
  });
let retractImpl: (
  req: RetractDependencyLineProducerRequest
) => Promise<DependencyLineProducerVerbResponse> = async (req) =>
  verbResponseFixture({
    action: "retract",
    coordinate: req.coordinate,
    dryRun: req.dryRun === true,
    declaration: null,
    decisionId: req.dryRun ? null : "019f0000-0000-7000-8000-00000000d3c2",
    openBumpAuthorships: req.dryRun
      ? []
      : [
          {
            changeObjectId: "019f0000-0000-7000-8000-00000000c4a1",
            componentObjectId: "019f0000-0000-7000-8000-00000000c0d1",
            repo: "acme/ledger",
            manifestPath: "package.json",
            fromVersion: "1.4.1",
            toVersion: "1.4.2",
            pullRequestUrl: "https://github.example/acme/ledger/pull/7"
          },
          {
            changeObjectId: "019f0000-0000-7000-8000-00000000c4a2",
            componentObjectId: "019f0000-0000-7000-8000-00000000c0d2",
            repo: "acme/billing",
            manifestPath: "services/billing/package.json",
            fromVersion: "1.4.0",
            toVersion: "1.4.2"
          }
        ]
  });
const RESET_DECLARE = declareImpl;
const RESET_RETRACT = retractImpl;
const RESET_LIST = listImpl;

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
    user: { instanceRole: authState.instanceRole },
    isLoading: false,
    refresh: async () => {}
  })
}));

vi.mock("../lib/client", () => ({
  client: {
    dependencyProducers: {
      list: async () => {
        calls.push({ method: "producers.list" });
        return listImpl();
      },
      declare: async (req: DeclareDependencyLineProducerRequest) => {
        calls.push({ method: "producers.declare", req });
        return declareImpl(req);
      },
      retract: async (req: RetractDependencyLineProducerRequest) => {
        calls.push({ method: "producers.retract", req });
        return retractImpl(req);
      }
    },
    components: {
      list: async (query: unknown) => {
        calls.push({ method: "components.list", req: query });
        return {
          items: [
            {
              id: COMPONENT.id,
              name: COMPONENT.name,
              urn: "urn:scp:default:component:checkout-api",
              typeId: "component"
            },
            {
              id: "019f0000-0000-7000-8000-00000000c0d1",
              name: "ledger-api",
              urn: "urn:scp:default:component:ledger-api",
              typeId: "component"
            }
          ],
          nextCursor: null
        };
      }
    }
  }
}));

const { AdminDependenciesPage } = await import("./admin-dependencies");

afterEach(() => {
  document.body.innerHTML = "";
  authState.instanceRole = "commander";
  listImpl = RESET_LIST;
  declareImpl = RESET_DECLARE;
  retractImpl = RESET_RETRACT;
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
      <AdminDependenciesPage />
    </QueryClientProvider>
  );
}

async function renderPage() {
  const view = mount();
  await waitUntil(() => inDocument("declare-open") !== null, "the page to render off the list");
  return view;
}

function declareCalls(): DeclareDependencyLineProducerRequest[] {
  return calls
    .filter((c) => c.method === "producers.declare")
    .map((c) => c.req as DeclareDependencyLineProducerRequest);
}
function retractCalls(): RetractDependencyLineProducerRequest[] {
  return calls
    .filter((c) => c.method === "producers.retract")
    .map((c) => c.req as RetractDependencyLineProducerRequest);
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

describe("Admin › Dependencies is a COMMANDER-site page", () => {
  it.each(["outpost", "retrans", undefined] as const)(
    "instanceRole %s → the 'managed at the commander' pointer renders and ZERO SDK calls are issued",
    async (role) => {
      authState.instanceRole = role;
      const view = mount();
      await waitUntil(
        () => inDocument("dependencies-managed-at-commander") !== null,
        "the pointer to render"
      );
      await settle();
      expect(document.body.textContent).toContain(
        "Dependency subscriptions are managed at the commander"
      );
      if (role === "outpost") {
        expect(document.body.textContent).toContain("reach this outpost through");
      } else {
        expect(document.body.textContent).toContain(
          "this deployment holds no dependency inventory"
        );
        expect(document.body.textContent).not.toContain("this outpost");
      }
      expect(inDocument("declare-open")).toBeNull();
      expect(inDocument("producer-row")).toBeNull();
      expect(calls).toEqual([]);
      view.unmount();
    }
  );

  it("on a commander-role client the SERVER's `managedHere: false` renders the pointer WITH its reason and no table (the wire is the authority)", async () => {
    listImpl = async () => ({
      producers: [producerFixture()],
      dependencyManagement: { managedHere: false, reason: "role_undeclared" }
    });
    const view = mount();
    await waitUntil(
      () => inDocument("dependencies-managed-at-commander") !== null,
      "the pointer to render off the wire"
    );
    expect(inDocument("dependencies-managed-reason")?.textContent).toContain("role_undeclared");
    expect(document.body.textContent).not.toContain("this outpost");
    expect(calls.map((c) => c.method)).toEqual(["producers.list"]);
    expect(inDocument("producer-row")).toBeNull();
    expect(inDocument("declare-open")).toBeNull();
    expect(document.body.textContent).not.toContain("@acme/lib");
    view.unmount();
  });
});

describe("the producers table", () => {
  it("renders one row per declaration off the enriched wire: ecosystem badge, verbatim coordinate, producer NAME linking to its Dependencies tab, declared (relative, ISO on title), declarer name", async () => {
    listImpl = async () => ({
      producers: [
        producerFixture(),
        producerFixture({
          ecosystem: "oci",
          coordinate: "ghcr.io/acme/base",
          producerObjectId: "019f0000-0000-7000-8000-00000000c0d9",
          producer: { objectId: "019f0000-0000-7000-8000-00000000c0d9", name: "" },
          declaredBy: { objectId: "019f0000-0000-7000-8000-00000000ad31", name: "" }
        })
      ],
      dependencyManagement: { managedHere: true, reason: "commander" }
    });
    const view = await renderPage();
    const rows = allInDocument("producer-row");
    expect(rows).toHaveLength(2);
    expect(inDocument("producers-empty")).toBeNull();
    // Row 1: named producer.
    const first = rows[0]!;
    expect(first.querySelector('[data-testid="producer-ecosystem"]')?.textContent).toBe("npm");
    expect(first.querySelector('[data-testid="producer-coordinate"]')?.textContent).toBe(
      "@acme/lib"
    );
    const link = first.querySelector<HTMLAnchorElement>('[data-testid="producer-link"]');
    expect(link?.textContent).toBe("checkout-api");
    expect(link?.getAttribute("href")).toBe(`/components/${COMPONENT.id}/dependencies`);
    expect(first.querySelector('[data-testid="producer-declared"]')?.getAttribute("title")).toBe(
      "2026-08-15T00:00:00.000Z"
    );
    expect(first.querySelector('[data-testid="producer-declared"]')?.textContent).toMatch(/ago$/);
    expect(first.querySelector('[data-testid="producer-declared-by"]')?.textContent).toBe("admin");
    expect(first.querySelector('[data-testid="producer-unnamed"]')).toBeNull();
    // Row 2: an unnamed producer renders the id and the amber `unknown` pill — never a blank cell.
    const second = rows[1]!;
    expect(second.querySelector('[data-testid="producer-link"]')?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000c0d9"
    );
    expect(second.querySelector('[data-testid="producer-unnamed"]')?.textContent).toBe("unnamed");
    // The pill's tooltip states the SERVER's fact: `name: ""` is namesForObjectIds' answer for an id
    // that resolves to NO object in this org (objects.name is NOT NULL, so an existing object never
    // yields ""), not a client paraphrase about a component "carrying no name".
    const unnamedTitle =
      second.querySelector('[data-testid="producer-unnamed"]')?.getAttribute("title") ?? "";
    expect(unnamedTitle).toContain("No component with this id resolves in this org");
    expect(unnamedTitle).not.toContain("carries no name");
    // An unnamed DECLARER carries the same signal as an unnamed producer — one row, one rule: the
    // id, plus the amber pill stating the server's fact. Not a bare id in one cell and a flagged id
    // in the other.
    expect(second.querySelector('[data-testid="producer-declared-by"]')?.textContent).toContain(
      "019f0000-0000-7000-8000-00000000ad31"
    );
    expect(second.querySelector('[data-testid="producer-declarer-unnamed"]')?.textContent).toBe(
      "unnamed"
    );
    expect(
      second.querySelector('[data-testid="producer-declarer-unnamed"]')?.getAttribute("title")
    ).toContain("No principal with this id resolves in this org");
    expect(first.querySelector('[data-testid="producer-declarer-unnamed"]')).toBeNull();
    // The page's own copy (§12.2/§12.3): the header names the noun the API and CLI use, and says
    // what the table is — pinned so the sentence cannot drift silently.
    expect(document.body.textContent).toContain("Dependency producers");
    expect(document.body.textContent).toContain(
      "which components this org publishes which coordinates from"
    );
    // The enablement pointer is on the page (§12.3.1) — the CLI verb named exactly, and the term
    // spelled in full (GLOSSARY: bare "subscription" is the notification_bindings sense).
    const pointer = inDocument("enablement-pointer")?.textContent ?? "";
    expect(pointer).toContain("scp dependency-subscriptions set-unlock --unlocked");
    expect(pointer).toContain("Dependency subscriptions are enabled per component");
    expect(pointer).not.toMatch(/(^|[^y] )Subscriptions are/);
    // The chips filter client-side.
    clickInDocument("ecosystem-chip-oci");
    expect(allInDocument("producer-row")).toHaveLength(1);
    expect(inDocument("producer-coordinate")?.textContent).toBe("ghcr.io/acme/base");
    clickInDocument("ecosystem-chip-all");
    expect(allInDocument("producer-row")).toHaveLength(2);
    view.unmount();
  });

  it("the empty state renders ONLY after a successful zero-row read — the exact sentence", async () => {
    listImpl = async () => ({
      producers: [],
      dependencyManagement: { managedHere: true, reason: "commander" }
    });
    const view = await renderPage();
    expect(inDocument("producers-empty")?.textContent).toContain(
      "No producers declared. Every coordinate in this org is polled as third-party."
    );
    expect(inDocument("producer-row")).toBeNull();
    view.unmount();
  });

  it("while the list read is PENDING nothing says 'No producers' (skeleton, not the empty state)", async () => {
    let release: (() => void) | null = null;
    listImpl = () =>
      new Promise<ProducersList>((resolve) => {
        release = () =>
          resolve({
            producers: [],
            dependencyManagement: { managedHere: true, reason: "commander" }
          });
      });
    const view = mount();
    await settle();
    await settle();
    expect(inDocument("producers-pending")).not.toBeNull();
    expect(inDocument("producers-empty")).toBeNull();
    expect(document.body.textContent).not.toContain("No producers declared");
    act(() => release?.());
    await waitUntil(() => inDocument("producers-empty") !== null, "the empty state after success");
    view.unmount();
  });

  it("a FAILED list read renders the diagnosis — never the empty state", async () => {
    listImpl = async () => {
      throw new Error("listDependencyLineProducers: 503");
    };
    const view = mount();
    await waitUntil(() => inDocument("producers-error") !== null, "the error notice");
    expect(inDocument("producers-error")?.textContent).toContain("503");
    expect(inDocument("producers-empty")).toBeNull();
    expect(document.body.textContent).not.toContain("No producers declared");
    view.unmount();
  });
});

// -------------------------------------------------------------------------------------------

async function openDeclareAndFill(coordinate = "@acme/newlib") {
  clickInDocument("declare-open");
  await waitUntil(() => inDocument("declare-confirm") !== null, "the declare dialog to open");
  // The picker's components read lands.
  await waitUntil(() => inDocument("declare-producer-match") !== null, "the picker's list");
  typeInto(inDocument("declare-coordinate") as HTMLInputElement, coordinate);
  // Pick checkout-api by name.
  typeInto(inDocument("declare-producer-search") as HTMLInputElement, "checkout");
  const match = allInDocument("declare-producer-match").find(
    (m) => m.getAttribute("data-id") === COMPONENT.id
  );
  if (!match) throw new Error("checkout-api not offered by the picker");
  act(() => {
    match.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await waitUntil(() => inDocument("declare-producer-picked") !== null, "the pick to register");
}

function isDisabled(testId: string): boolean {
  const el = inDocument(testId) as HTMLButtonElement | null;
  if (!el) throw new Error(`no ${testId}`);
  return el.disabled;
}

describe("Declare… — dry run FIRST, then the write, and never the write without a current preview", () => {
  it("end to end: Declare is DISABLED before a preview; Preview sends dryRun:true and renders the blast radius by NAME; Declare then sends the real write; success shows the decision id and re-reads the list", async () => {
    const view = await renderPage();
    await openDeclareAndFill();

    // Step 1 gate: nothing written yet, and the write cannot be clicked.
    expect(isDisabled("declare-confirm")).toBe(true);
    expect(declareCalls()).toEqual([]);
    // Belt and braces: even a dispatched click on the disabled button sends nothing.
    clickInDocument("declare-confirm");
    await settle();
    expect(declareCalls()).toEqual([]);

    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("declare-preview") !== null, "the preview report");
    expect(declareCalls()).toEqual([
      { ecosystem: "npm", coordinate: "@acme/newlib", producerIdOrUrn: COMPONENT.id, dryRun: true }
    ]);
    // The report: the major, the head that will be cleared, the subscribers by NAME.
    const line = inDocument("blast-radius-line")!;
    expect(line.textContent).toContain("1");
    expect(inDocument("blast-radius-head")?.textContent).toContain("1.4.2");
    expect(inDocument("blast-radius-head")?.textContent).toContain("will be cleared");
    expect(inDocument("blast-radius-subscribers")?.textContent).toBe("ledger-api");

    // Step 2: enabled now, and the real write goes out WITHOUT dryRun.
    expect(isDisabled("declare-confirm")).toBe(false);
    clickInDocument("declare-confirm");
    await waitUntil(() => inDocument("producer-write-success") !== null, "the success notice");
    expect(declareCalls()).toEqual([
      { ecosystem: "npm", coordinate: "@acme/newlib", producerIdOrUrn: COMPONENT.id, dryRun: true },
      { ecosystem: "npm", coordinate: "@acme/newlib", producerIdOrUrn: COMPONENT.id }
    ]);
    expect(inDocument("declare-confirm")).toBeNull();
    expect(inDocument("producer-write-decision-id")?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000d3c1"
    );
    expect(inDocument("producer-write-why")).not.toBeNull();
    expect(calls.filter((c) => c.method === "producers.list").length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  // One case PER FIELD, deliberately not one case that edits everything: a preview key that silently
  // drops the ecosystem or the producer (a different blast radius, a different producer) would still
  // pass a coordinate-only edit. Each case edits exactly one field after a preview.
  const editors: [string, () => void][] = [
    [
      "the coordinate",
      () => typeInto(inDocument("declare-coordinate") as HTMLInputElement, "@acme/otherlib")
    ],
    [
      "the ecosystem",
      () => {
        const select = inDocument("declare-ecosystem") as HTMLSelectElement;
        select.value = "oci";
        fire(select, new Event("change", { bubbles: true }));
      }
    ],
    [
      "the producer",
      () => {
        // Re-pick a DIFFERENT listed component (ledger-api) — the picked id is what the request
        // carries, so it is the picked id, not the search text, that must be part of the key.
        typeInto(inDocument("declare-producer-search") as HTMLInputElement, "ledger");
        const other = allInDocument("declare-producer-match").find(
          (m) => m.getAttribute("data-id") === "019f0000-0000-7000-8000-00000000c0d1"
        );
        if (!other) throw new Error("ledger-api not offered by the picker");
        act(() => {
          other.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        });
      }
    ]
  ];

  it.each(editors)(
    "editing %s after a preview INVALIDATES it — Declare goes back to disabled, the stale marker shows, and a dispatched click writes nothing until a fresh preview",
    async (_field, edit) => {
      const view = await renderPage();
      await openDeclareAndFill();
      clickInDocument("declare-preview-run");
      await waitUntil(() => inDocument("declare-preview") !== null, "the preview report");
      expect(isDisabled("declare-confirm")).toBe(false);
      edit();
      await settle();
      expect(isDisabled("declare-confirm")).toBe(true);
      expect(inDocument("declare-preview")).toBeNull();
      expect(inDocument("declare-preview-stale")).not.toBeNull();
      clickInDocument("declare-confirm");
      await settle();
      expect(declareCalls().filter((r) => r.dryRun !== true)).toEqual([]);
      view.unmount();
    }
  );

  it("after an edit, a FRESH preview carries the edited values and re-enables Declare (the key is the request, not the first preview)", async () => {
    const view = await renderPage();
    await openDeclareAndFill();
    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("declare-preview") !== null, "the first preview");
    const select = inDocument("declare-ecosystem") as HTMLSelectElement;
    select.value = "go";
    fire(select, new Event("change", { bubbles: true }));
    await settle();
    expect(isDisabled("declare-confirm")).toBe(true);
    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("declare-preview") !== null, "the second preview");
    expect(declareCalls().map((r) => r.ecosystem)).toEqual(["npm", "go"]);
    expect(isDisabled("declare-confirm")).toBe(false);
    clickInDocument("declare-confirm");
    await waitUntil(() => inDocument("producer-write-success") !== null, "the success notice");
    expect(declareCalls().at(-1)).toEqual({
      ecosystem: "go",
      coordinate: "@acme/newlib",
      producerIdOrUrn: COMPONENT.id
    });
    view.unmount();
  });

  it("an empty `lines[]` preview renders the exact 'no lines yet' sentence (ordinary — declared before any consumer minted a line)", async () => {
    declareImpl = async (req) =>
      verbResponseFixture({
        dryRun: req.dryRun === true,
        lines: [],
        declaration: null,
        decisionId: null
      });
    const view = await renderPage();
    await openDeclareAndFill();
    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("blast-radius-no-lines") !== null, "the no-lines sentence");
    expect(inDocument("blast-radius-no-lines")?.textContent).toBe(
      "no lines yet — this coordinate has not been seen in any manifest; the declaration still takes effect for every future major"
    );
    view.unmount();
  });

  it("a line with no subscribers says 'none subscribed'; a subscriber with no name falls back to its id", async () => {
    declareImpl = async (req) =>
      verbResponseFixture({
        dryRun: req.dryRun === true,
        declaration: null,
        decisionId: null,
        lines: [
          lineImpactFixture({
            major: "1",
            headBefore: { latestVersion: null, latestDigest: null, latestObservedAt: null },
            headCleared: false,
            subscribedComponentObjectIds: [],
            subscribedComponents: []
          }),
          lineImpactFixture({
            lineId: "019f0000-0000-7000-8000-00000000aaa2",
            major: "2",
            subscribedComponentObjectIds: ["019f0000-0000-7000-8000-00000000c0d2"],
            subscribedComponents: [{ objectId: "019f0000-0000-7000-8000-00000000c0d2", name: "" }]
          })
        ]
      });
    const view = await renderPage();
    await openDeclareAndFill();
    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("blast-radius") !== null, "the report");
    const subs = allInDocument("blast-radius-subscribers");
    expect(subs[0]?.textContent).toBe("none subscribed");
    expect(subs[1]?.textContent).toBe("019f0000-0000-7000-8000-00000000c0d2");
    const heads = allInDocument("blast-radius-head");
    expect(heads[0]?.textContent).toContain("no head to clear");
    view.unmount();
  });

  it.each([
    [
      400,
      "Bad Request",
      "producer urn:scp:default:service:checkout is a service; declare a component"
    ],
    [404, "Not Found", "no component or service named nope-nope resolves in this org"],
    [403, "Forbidden", "policy:write at the org root is required"],
    [409, "Conflict", "producer declarations are commander-only on the federation axis"]
  ] as const)(
    "a %i refusal on the preview renders the server's sentence INLINE and nothing is written",
    async (status, title, detail) => {
      declareImpl = async () => {
        throw problem(status, title, detail);
      };
      const view = await renderPage();
      await openDeclareAndFill();
      clickInDocument("declare-preview-run");
      await waitUntil(() => inDocument("declare-error") !== null, "the refusal");
      const text = inDocument("declare-error")!.textContent ?? "";
      expect(text).toContain(detail);
      if (status === 403) expect(text).toContain("policy:write at the org root");
      expect(isDisabled("declare-confirm")).toBe(true);
      expect(declareCalls().filter((r) => r.dryRun !== true)).toEqual([]);
      expect(inDocument("declare-confirm")).not.toBeNull();
      view.unmount();
    }
  );

  it("a 409 on the real write with a decision_id renders the Why link beside the sentence; the dialog stays open", async () => {
    declareImpl = async (req) => {
      if (req.dryRun)
        return verbResponseFixture({ dryRun: true, declaration: null, decisionId: null });
      throw problem(409, "Conflict", "not a commander", "019f0000-0000-7000-8000-00000000d0d0");
    };
    const view = await renderPage();
    await openDeclareAndFill();
    clickInDocument("declare-preview-run");
    await waitUntil(() => inDocument("declare-preview") !== null, "the preview");
    clickInDocument("declare-confirm");
    await waitUntil(() => inDocument("declare-error") !== null, "the refusal");
    expect(inDocument("declare-error-why")).not.toBeNull();
    expect(inDocument("declare-error-decision-id")?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000d0d0"
    );
    expect(inDocument("declare-confirm")).not.toBeNull();
    expect(inDocument("producer-write-success")).toBeNull();
    view.unmount();
  });

  it("the picker offers COMPONENTS from client.components.list and a typed URN is sent as-is", async () => {
    const view = await renderPage();
    clickInDocument("declare-open");
    await waitUntil(() => inDocument("declare-producer-match") !== null, "the picker's list");
    const pickerReads = calls.filter((c) => c.method === "components.list");
    expect(pickerReads.length).toBeGreaterThan(0);
    // The mocked SDK accepts anything; the REAL route validates the query with ObjectListQuerySchema
    // (limit max 100) BEFORE auth and answers 400 above it — which would leave the picker permanently
    // on its "could not be listed" pill on a real commander. Parse what was sent with the real schema.
    for (const read of pickerReads) {
      const parsed = ObjectListQuerySchema.safeParse(read.req ?? {});
      expect(parsed.success, JSON.stringify(read.req)).toBe(true);
    }
    expect(allInDocument("declare-producer-match")).toHaveLength(2);
    typeInto(inDocument("declare-coordinate") as HTMLInputElement, "@acme/x");
    typeInto(
      inDocument("declare-producer-search") as HTMLInputElement,
      "urn:scp:default:service:checkout"
    );
    await settle();
    expect(inDocument("declare-producer-none")).not.toBeNull();
    clickInDocument("declare-preview-run");
    await waitUntil(() => declareCalls().length > 0, "the preview call");
    expect(declareCalls()[0]).toEqual({
      ecosystem: "npm",
      coordinate: "@acme/x",
      producerIdOrUrn: "urn:scp:default:service:checkout",
      dryRun: true
    });
    view.unmount();
  });
});

// -------------------------------------------------------------------------------------------

describe("Retract… — preview, then the write; open bumps rendered and the dialog stays open on them", () => {
  it("opens with a dryRun preview, Retract sends the real call, the REAL response's openBumpAuthorships render as 'still in flight' with PR links only when present, plus the decision id; the list is re-read; the dialog stays until Done", async () => {
    const view = await renderPage();
    clickInDocument("producer-retract");
    await waitUntil(() => inDocument("retract-preview") !== null, "the retract preview");
    expect(retractCalls()).toEqual([{ ecosystem: "npm", coordinate: "@acme/lib", dryRun: true }]);
    expect(inDocument("blast-radius-subscribers")?.textContent).toBe("ledger-api");
    expect(isDisabled("retract-confirm")).toBe(false);

    clickInDocument("retract-confirm");
    await waitUntil(() => inDocument("retract-result") !== null, "the retract result");
    expect(retractCalls()).toEqual([
      { ecosystem: "npm", coordinate: "@acme/lib", dryRun: true },
      { ecosystem: "npm", coordinate: "@acme/lib" }
    ]);
    const bumps = allInDocument("retract-open-bump");
    expect(bumps).toHaveLength(2);
    expect(bumps[0]?.textContent).toContain("acme/ledger");
    expect(bumps[0]?.textContent).toContain("package.json");
    expect(bumps[0]?.textContent).toContain("1.4.1 → 1.4.2");
    const pr = bumps[0]?.querySelector<HTMLAnchorElement>('[data-testid="retract-open-bump-pr"]');
    expect(pr?.getAttribute("href")).toBe("https://github.example/acme/ledger/pull/7");
    expect(pr?.getAttribute("rel")).toBe("noopener noreferrer");
    // The second bump recorded no URL: no link, and none composed.
    expect(bumps[1]?.querySelector('[data-testid="retract-open-bump-pr"]')).toBeNull();
    expect(bumps[1]?.textContent).toContain("acme/billing");
    expect(document.body.textContent).toContain("Still in flight — SCP does not close these");
    expect(inDocument("retract-decision-id")?.textContent).toBe(
      "019f0000-0000-7000-8000-00000000d3c2"
    );
    expect(inDocument("retract-why")).not.toBeNull();
    // Stays open on the list; the list read has been re-issued.
    expect(inDocument("retract-close")).not.toBeNull();
    expect(inDocument("retract-confirm")).toBeNull();
    expect(calls.filter((c) => c.method === "producers.list").length).toBeGreaterThanOrEqual(2);
    clickInDocument("retract-close");
    await waitUntil(() => inDocument("retract-result") === null, "the dialog to close");
    view.unmount();
  });

  it("Retract is DISABLED until the preview resolved; a preview refusal renders and offers a retry", async () => {
    let attempt = 0;
    retractImpl = async (req) => {
      attempt++;
      if (attempt === 1)
        throw problem(
          400,
          "Bad Request",
          "nothing to retract: npm @acme/lib has no declared producer"
        );
      return RESET_RETRACT(req);
    };
    const view = await renderPage();
    clickInDocument("producer-retract");
    await waitUntil(() => inDocument("retract-error") !== null, "the refusal");
    expect(inDocument("retract-error")?.textContent).toContain("nothing to retract");
    expect(isDisabled("retract-confirm")).toBe(true);
    expect(retractCalls().filter((r) => r.dryRun !== true)).toEqual([]);
    clickInDocument("retract-preview-retry");
    await waitUntil(() => inDocument("retract-preview") !== null, "the retried preview");
    expect(isDisabled("retract-confirm")).toBe(false);
    view.unmount();
  });

  it("a 400 'nothing to retract' on the REAL retract renders the server sentence and the dialog stays open", async () => {
    retractImpl = async (req) => {
      if (req.dryRun) return RESET_RETRACT(req);
      throw problem(
        400,
        "Bad Request",
        "nothing to retract: npm @acme/lib has no declared producer"
      );
    };
    const view = await renderPage();
    clickInDocument("producer-retract");
    await waitUntil(() => inDocument("retract-preview") !== null, "the preview");
    clickInDocument("retract-confirm");
    await waitUntil(() => inDocument("retract-error") !== null, "the refusal");
    expect(inDocument("retract-error")?.textContent).toContain("nothing to retract");
    expect(inDocument("retract-result")).toBeNull();
    expect(inDocument("retract-confirm")).not.toBeNull();
    view.unmount();
  });
});

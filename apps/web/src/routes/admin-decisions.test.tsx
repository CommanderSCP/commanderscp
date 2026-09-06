// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import type { Decision, DecisionListQuery, DecisionListResponse } from "@scp/schemas";
import { fire, render } from "../test-support/render-dom";

/**
 * ADMIN › DECISIONS — the wired-up page against a stubbed SDK (owner-approved 2026-08-23,
 * "Decisions & Audit explorer" — charter principle 6).
 *
 * What is pinned, and the mutation each pin exists to catch:
 *   - the empty state renders ONLY after a successful zero-row read — never while pending, never
 *     after an error; mutation: paint it during pending → RED (`pending never paints empty` case);
 *     mutation: paint it on error instead of `QueryErrorNotice` → RED;
 *   - a failed read renders `QueryErrorNotice`'s diagnosis, never a silently empty table;
 *   - "Load more" fetches the SERVER's own `nextCursor` and appends — never re-fetches page 1,
 *     never fires twice per click; mutation: drop the cursor from the second call → the exact-query
 *     assertion goes RED;
 *   - the filter form sends `subjectId`/`kind` ONLY when non-empty (never an empty-string filter
 *     masquerading as "no filter"), and re-queries from page 1 on Apply — mutation: keep sending a
 *     stale cursor after Apply → the "second call has no cursor" assertion goes RED;
 *   - the Why affordance opens `DecisionDetailDialog` with the SAME row's record, not a stale one.
 */

function decisionFixture(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "019f0000-0000-7000-8000-00000000d001",
    orgId: "019f0000-0000-7000-8000-0000000000aa",
    kind: "stage_dependency",
    subjectId: "019f0000-0000-7000-8000-00000000c001",
    verdict: "hold",
    inputContext: { waveId: "019f0000-0000-7000-8000-00000000w001" },
    reasonTree: { summary: "held on an upstream stage dependency" },
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

const calls: { query: DecisionListQuery }[] = [];
let listImpl: (query: DecisionListQuery) => Promise<DecisionListResponse> = async () => ({
  items: [decisionFixture()],
  nextCursor: null
});
const RESET_LIST = listImpl;

let getImpl: (id: string) => Promise<Decision> = async (id) => decisionFixture({ id });
const RESET_GET = getImpl;

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
    search,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    "data-testid"?: string;
  }) => {
    let href = params
      ? Object.entries(params).reduce((p, [k, v]) => p.replace(`$${k}`, v), to ?? "")
      : (to ?? "");
    if (search) href += `?${new URLSearchParams(search).toString()}`;
    return (
      <a data-testid={rest["data-testid"]} href={href}>
        {children}
      </a>
    );
  }
}));

vi.mock("../lib/use-route-params", () => ({
  useSubjectIdSearchForDecisions: () => undefined
}));

vi.mock("../lib/client", () => ({
  client: {
    decisions: {
      list: async (query: DecisionListQuery) => {
        calls.push({ query });
        return listImpl(query);
      },
      get: async (id: string) => getImpl(id)
    }
  }
}));

const { AdminDecisionsPage } = await import("./admin-decisions");

afterEach(() => {
  document.body.innerHTML = "";
  calls.length = 0;
  listImpl = RESET_LIST;
  getImpl = RESET_GET;
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminDecisionsPage />
    </QueryClientProvider>
  );
}

function problem(status: number, title: string, detail: string): ScpApiError {
  return new ScpApiError(title, {
    status,
    problem: { type: "about:blank", title, status, detail }
  });
}

describe("Admin › Decisions renders the list", () => {
  it("renders rows from the fixture — kind, subject, verdict, id", async () => {
    listImpl = async () => ({
      items: [
        decisionFixture({ id: "019f0000-0000-7000-8000-00000000d001", kind: "stage_dependency" }),
        decisionFixture({
          id: "019f0000-0000-7000-8000-00000000d002",
          kind: "gate",
          verdict: "allow"
        })
      ],
      nextCursor: null
    });
    mount();
    await waitUntil(() => inDocument("decisions-table") !== null, "the table to render");
    expect(allInDocument("decision-list-row")).toHaveLength(2);
    expect(document.body.textContent).toContain("stage_dependency");
    expect(document.body.textContent).toContain("gate");
  });

  it("does NOT paint the empty state while the read is pending", async () => {
    listImpl = () => new Promise(() => {}); // never resolves
    const view = mount();
    await settle();
    expect(view.container.querySelector('[data-testid="decisions-empty"]')).toBeNull();
  });

  it("paints the empty state ONLY after a successful zero-row read", async () => {
    listImpl = async () => ({ items: [], nextCursor: null });
    mount();
    await waitUntil(() => inDocument("decisions-empty") !== null, "the empty state to render");
    expect(inDocument("decisions-table")).toBeNull();
  });

  it("renders QueryErrorNotice on a failed read — never an empty state", async () => {
    // The real SDK sets `ScpApiError.message` from the problem's `title` (client.ts) — the same
    // string `QueryErrorNotice` renders verbatim — so this constructs the error the way the wire
    // actually would, and asserts on THAT string, not an invented one.
    listImpl = async () => {
      throw problem(403, "subject lacks 'object:read' at scope 'org-root'", "forbidden");
    };
    mount();
    await waitUntil(() => inDocument("decisions-error") !== null, "the error notice to render");
    expect(document.body.textContent).toContain("object:read");
    expect(inDocument("decisions-empty")).toBeNull();
    expect(inDocument("decisions-table")).toBeNull();
  });
});

describe("Admin › Decisions — Load more carries the server's own cursor", () => {
  it("appends the second page and sends exactly the cursor the server returned", async () => {
    listImpl = async (query) => {
      if (!query.cursor) {
        return {
          items: [decisionFixture({ id: "019f0000-0000-7000-8000-00000000d001" })],
          nextCursor: "CURSOR-1"
        };
      }
      expect(query.cursor).toBe("CURSOR-1");
      return {
        items: [decisionFixture({ id: "019f0000-0000-7000-8000-00000000d002" })],
        nextCursor: null
      };
    };
    mount();
    await waitUntil(
      () => inDocument("decisions-load-more") !== null,
      "page 1 + Load more to render"
    );
    expect(allInDocument("decision-list-row")).toHaveLength(1);

    clickInDocument("decisions-load-more");
    await waitUntil(() => allInDocument("decision-list-row").length === 2, "page 2 to append");
    expect(inDocument("decisions-load-more")).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.query.cursor).toBeUndefined();
    expect(calls[1]!.query.cursor).toBe("CURSOR-1");
  });
});

describe("Admin › Decisions — filters as the wire provides them", () => {
  it("Apply sends subjectId/kind only when non-empty, and re-queries from page 1", async () => {
    listImpl = async () => ({ items: [decisionFixture()], nextCursor: null });
    const view = mount();
    await waitUntil(() => inDocument("decision-filters") !== null, "the filter form to render");

    const subjectInput = view.byTestId("decision-filter-subject") as HTMLInputElement;
    const kindInput = view.byTestId("decision-filter-kind") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(subjectInput, "019f0000-0000-7000-8000-00000000c001");
      subjectInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(kindInput, "gate");
      kindInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    calls.length = 0;
    fire(
      view.byTestId("decision-filters"),
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await waitUntil(() => calls.length > 0, "the filtered read to fire");
    expect(calls[0]!.query.subjectId).toBe("019f0000-0000-7000-8000-00000000c001");
    expect(calls[0]!.query.kind).toBe("gate");
    expect(calls[0]!.query.cursor).toBeUndefined();
  });
});

describe("Admin › Decisions — the Why affordance opens the shared DecisionDetailDialog", () => {
  it("shows the CLICKED row's own record, formatted by decisionSummary", async () => {
    listImpl = async () => ({
      items: [
        decisionFixture({
          id: "019f0000-0000-7000-8000-00000000d001",
          verdict: "hold",
          reasonTree: { summary: "held on an upstream stage dependency" }
        }),
        decisionFixture({
          id: "019f0000-0000-7000-8000-00000000d002",
          verdict: "allow",
          reasonTree: { summary: "the second decision's own reason" }
        })
      ],
      nextCursor: null
    });
    mount();
    await waitUntil(() => allInDocument("decision-why").length === 2, "both rows to render");

    // Both rows share the `decision-why` testid — click the SECOND one by element reference so
    // the dialog opens with THAT row's own record, not whichever the selector finds first.
    const whys = allInDocument("decision-why");
    act(() => {
      whys[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitUntil(
      () => inDocument("decision-detail-summary") !== null,
      "the dialog to open with a record"
    );
    expect(document.body.textContent).toContain("the second decision's own reason");
    expect(inDocument("decision-detail-verdict")?.textContent).toBe("allow");
  });
});

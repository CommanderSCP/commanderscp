// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import type {
  AuditEvent,
  AuditEventListQuery,
  AuditEventListResponse,
  Decision
} from "@scp/schemas";
import { render } from "../test-support/render-dom";

/**
 * ADMIN › AUDIT — the wired-up page against a stubbed SDK (owner-approved 2026-08-23).
 *
 * What is pinned, and the mutation each pin exists to catch:
 *   - the empty state renders ONLY after a successful zero-row read; mutation: paint it during
 *     pending → RED;
 *   - pending never paints empty (separate case: an unresolved promise leaves both the table and
 *     the empty state absent);
 *   - `audit:read` 403 renders the server's sentence VERBATIM via `QueryErrorNotice` — never a
 *     generic "could not load" with the detail swallowed, never an empty table;
 *   - "Load more" fetches the SERVER's `nextCursor` and appends, never re-fetching page 1;
 *     mutation: fire the fetch twice per click → the exactly-one-more-read count assertion goes RED;
 *   - a null `subjectId`/`decisionId`/`reason` renders "—", never a fabricated link or blank Why;
 *   - the WhyLink-equivalent on `decisionId` fetches `client.decisions.get` by THAT id and opens
 *     `DecisionDetailDialog` — mutation: hardcode the first row's id regardless of which was
 *     clicked → the "second row's own decision" assertion goes RED.
 */

function auditEventFixture(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "019f0000-0000-7000-8000-00000000a001",
    orgId: "019f0000-0000-7000-8000-0000000000aa",
    domainId: null,
    actorId: "019f0000-0000-7000-8000-00000000u001",
    action: "change.cancel",
    subjectId: "019f0000-0000-7000-8000-00000000c001",
    beforeHash: null,
    afterHash: null,
    reason: "operator cancelled — bad manifest",
    decisionId: null,
    requestId: "req-1",
    occurredAt: "2026-08-20T12:00:00.000Z",
    prevHash: "0000000000000000000000000000000000000000000000000000000000000000000000000000",
    rowHash: "1111111111111111111111111111111111111111111111111111111111111111111111111111",
    ...overrides
  };
}

function decisionFixture(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "019f0000-0000-7000-8000-00000000d001",
    orgId: "019f0000-0000-7000-8000-0000000000aa",
    kind: "gate",
    subjectId: "019f0000-0000-7000-8000-00000000c001",
    verdict: "block",
    inputContext: {},
    reasonTree: { summary: "blocked by an active freeze" },
    createdAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

const listCalls: { query: AuditEventListQuery }[] = [];
let listImpl: (query: AuditEventListQuery) => Promise<AuditEventListResponse> = async () => ({
  items: [auditEventFixture()],
  nextCursor: null
});
const RESET_LIST = listImpl;

const getCalls: string[] = [];
let getImpl: (id: string) => Promise<Decision> = async (id) => decisionFixture({ id });
const RESET_GET = getImpl;

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

vi.mock("../lib/client", () => ({
  client: {
    auditEvents: {
      list: async (query: AuditEventListQuery) => {
        listCalls.push({ query });
        return listImpl(query);
      }
    },
    decisions: {
      get: async (id: string) => {
        getCalls.push(id);
        return getImpl(id);
      }
    }
  }
}));

const { AdminAuditPage } = await import("./admin-audit");

afterEach(() => {
  document.body.innerHTML = "";
  listCalls.length = 0;
  getCalls.length = 0;
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
      <AdminAuditPage />
    </QueryClientProvider>
  );
}

function problem(status: number, title: string): ScpApiError {
  return new ScpApiError(title, { status, problem: { type: "about:blank", title, status } });
}

describe("Admin › Audit renders the list", () => {
  it("renders rows from the fixture — at, action, actor, subject, reason, decision", async () => {
    listImpl = async () => ({
      items: [
        auditEventFixture({ id: "019f0000-0000-7000-8000-00000000a001", action: "change.cancel" })
      ],
      nextCursor: null
    });
    mount();
    await waitUntil(() => inDocument("audit-table") !== null, "the table to render");
    expect(allInDocument("audit-list-row")).toHaveLength(1);
    expect(document.body.textContent).toContain("change.cancel");
    expect(inDocument("audit-subject-link")).not.toBeNull();
  });

  it("renders '—' for null subjectId, reason, and decisionId — never a fabricated link", async () => {
    listImpl = async () => ({
      items: [auditEventFixture({ subjectId: null, reason: null, decisionId: null })],
      nextCursor: null
    });
    mount();
    await waitUntil(() => inDocument("audit-table") !== null, "the table to render");
    expect(inDocument("audit-subject-link")).toBeNull();
    expect(inDocument("audit-decision-why")).toBeNull();
    const row = inDocument("audit-list-row")!;
    expect(row.textContent).toContain("—");
  });

  it("does NOT paint the empty state while the read is pending", async () => {
    listImpl = () => new Promise(() => {});
    const view = mount();
    await settle();
    expect(view.container.querySelector('[data-testid="audit-empty"]')).toBeNull();
  });

  it("paints the empty state ONLY after a successful zero-row read", async () => {
    listImpl = async () => ({ items: [], nextCursor: null });
    mount();
    await waitUntil(() => inDocument("audit-empty") !== null, "the empty state to render");
    expect(inDocument("audit-table")).toBeNull();
  });

  it("renders the server's audit:read refusal VERBATIM — never an empty table", async () => {
    listImpl = async () => {
      throw problem(403, "subject lacks 'audit:read' at scope 'org-root'");
    };
    mount();
    await waitUntil(() => inDocument("audit-error") !== null, "the error notice to render");
    expect(document.body.textContent).toContain("audit:read");
    expect(inDocument("audit-empty")).toBeNull();
    expect(inDocument("audit-table")).toBeNull();
  });

  it("states that chain integrity is verified by the CLI, not this page", () => {
    mount();
    expect(inDocument("audit-integrity-note")?.textContent).toContain("scp audit verify");
  });
});

describe("Admin › Audit — Load more carries the server's own cursor", () => {
  it("appends the second page and never re-fetches page 1", async () => {
    listImpl = async (query) => {
      if (!query.cursor) {
        return {
          items: [auditEventFixture({ id: "019f0000-0000-7000-8000-00000000a001" })],
          nextCursor: "SEQ-CURSOR-1"
        };
      }
      expect(query.cursor).toBe("SEQ-CURSOR-1");
      return {
        items: [auditEventFixture({ id: "019f0000-0000-7000-8000-00000000a002" })],
        nextCursor: null
      };
    };
    mount();
    await waitUntil(() => inDocument("audit-load-more") !== null, "page 1 + Load more to render");
    expect(allInDocument("audit-list-row")).toHaveLength(1);

    clickInDocument("audit-load-more");
    await waitUntil(() => allInDocument("audit-list-row").length === 2, "page 2 to append");
    expect(inDocument("audit-load-more")).toBeNull();
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]!.query.cursor).toBeUndefined();
    expect(listCalls[1]!.query.cursor).toBe("SEQ-CURSOR-1");
  });
});

describe("Admin › Audit — the decisionId WhyLink-equivalent", () => {
  it("fetches the CLICKED row's own decision by id, not the first row's", async () => {
    listImpl = async () => ({
      items: [
        auditEventFixture({
          id: "019f0000-0000-7000-8000-00000000a001",
          decisionId: "019f0000-0000-7000-8000-00000000d001"
        }),
        auditEventFixture({
          id: "019f0000-0000-7000-8000-00000000a002",
          decisionId: "019f0000-0000-7000-8000-00000000d002"
        })
      ],
      nextCursor: null
    });
    getImpl = async (id) => decisionFixture({ id, reasonTree: { summary: `reason for ${id}` } });

    mount();
    await waitUntil(() => allInDocument("audit-decision-why").length === 2, "both rows to render");
    const whys = allInDocument("audit-decision-why");
    act(() => {
      whys[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await waitUntil(() => getCalls.length === 1, "the decision fetch to fire");
    expect(getCalls[0]).toBe("019f0000-0000-7000-8000-00000000d002");
    await waitUntil(
      () => inDocument("decision-detail-summary") !== null,
      "the dialog to render the fetched record"
    );
    expect(document.body.textContent).toContain("reason for 019f0000-0000-7000-8000-00000000d002");
  });

  it("renders the fetch failure in the dialog rather than a stale/blank record", async () => {
    listImpl = async () => ({
      items: [auditEventFixture({ decisionId: "019f0000-0000-7000-8000-00000000d001" })],
      nextCursor: null
    });
    getImpl = async () => {
      throw problem(404, "decision not found");
    };
    mount();
    await waitUntil(() => inDocument("audit-decision-why") !== null, "the row to render");
    clickInDocument("audit-decision-why");
    await waitUntil(
      () => inDocument("decision-detail-error") !== null,
      "the dialog to show the fetch failure"
    );
    expect(document.body.textContent).toContain("decision not found");
  });
});

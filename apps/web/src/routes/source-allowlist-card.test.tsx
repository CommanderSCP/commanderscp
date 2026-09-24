// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../test-support/render-dom";

/** M28.3 (ADR-0056 §7a) — an execution system's source allowlist, as the page reads it back. */
const getSourceAllowlist = vi.hoisted(() => vi.fn());
vi.mock("../lib/client", () => ({ client: { executors: { getSourceAllowlist } } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { SourceAllowlistCard } = await import("./registry-detail");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SourceAllowlistCard systemId="sys-1" detailKey={["registry", "sys-1"]} />
    </QueryClientProvider>
  );
}

describe("SourceAllowlistCard", () => {
  it("lists each allowed repo, read through the SDK for THIS system", async () => {
    getSourceAllowlist.mockReset();
    getSourceAllowlist.mockResolvedValue({
      executionSystemId: "sys-1",
      repos: ["acme/*", "acme/infra"],
      recordedBySubjectId: null,
      updatedAt: null
    });
    const view = renderCard();
    for (let i = 0; i < 50 && !view.html().includes('data-testid="source-allowlist"'); i++)
      await flush();
    expect(getSourceAllowlist).toHaveBeenCalledWith("sys-1");
    expect(view.byTestId("source-allowlist").textContent).toBe("acme/*acme/infra");
    view.unmount();
  });

  it("says plainly that NOTHING may run when the list is empty", async () => {
    getSourceAllowlist.mockReset();
    getSourceAllowlist.mockResolvedValue({
      executionSystemId: "sys-1",
      repos: [],
      recordedBySubjectId: null,
      updatedAt: null
    });
    const view = renderCard();
    for (let i = 0; i < 20 && !view.html().includes("source-allowlist"); i++) await flush();
    expect(view.byTestId("source-allowlist-empty").textContent).toContain("No repos may run");
    view.unmount();
  });
});

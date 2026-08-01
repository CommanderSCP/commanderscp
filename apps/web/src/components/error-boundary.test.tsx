// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ScpResponseValidationError } from "@scp/sdk";
import { render } from "../test-support/render-dom";
import { ErrorBoundary } from "./error-boundary";

/**
 * ADR-0023's CONTAINMENT HALF. Response validation makes a contract failure loud and single; a
 * boundary makes it contained. `apps/web` shipped the first without the second, so any throw during
 * render unmounted the whole tree and left a literally blank page — MEASURED as
 * `container.innerHTML.length === 0` in `routes/federation-status-crash.test.tsx`'s original form.
 *
 * These cases pin the boundary's BEHAVIOUR (what an operator can read off the screen), and the last
 * one pins that it is actually MOUNTED around the router outlet — a boundary that exists but wraps
 * nothing is the wording-not-behaviour failure this repo keeps re-learning.
 */

/** React logs every caught error to `console.error`; silence it so a passing run is readable, and
 *  restore it afterwards so a real unexpected log is never swallowed for other files. */
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.resetModules();
});

function Boom({ error }: { error: unknown }): React.JSX.Element {
  throw error;
}

describe("ErrorBoundary", () => {
  it("renders the message verbatim instead of a blank page", () => {
    const rendered = render(
      <ErrorBoundary>
        <Boom error={new Error("borked while formatting a wave")} />
      </ErrorBoundary>
    );

    expect(rendered.container.innerHTML.length).toBeGreaterThan(0);
    expect(rendered.byTestId("app-error-detail").textContent).toContain(
      "borked while formatting a wave"
    );
    expect(rendered.byTestId("app-error-boundary").getAttribute("data-error-kind")).toBe("render");
    rendered.unmount();
  });

  it("names the operation and every offending field for a response-validation failure", () => {
    const error = new ScpResponseValidationError({
      method: "GET",
      path: "/federation/status",
      status: 200,
      issues: [{ path: "peers.0.recentTransfers", message: "Required", code: "invalid_type" }]
    });
    const rendered = render(
      <ErrorBoundary>
        <Boom error={error} />
      </ErrorBoundary>
    );

    const panel = rendered.byTestId("app-error-boundary");
    expect(panel.getAttribute("data-error-kind")).toBe("contract");
    expect(panel.textContent).toContain("GET /federation/status");
    expect(panel.textContent).toMatch(/version skew/i);
    expect(rendered.byTestId("app-error-fields").textContent).toContain("peers.0.recentTransfers");
    rendered.unmount();
  });

  it("'Try again' re-renders the children rather than requiring a full page load", () => {
    let shouldThrow = true;
    function Flaky(): React.JSX.Element {
      if (shouldThrow) throw new Error("transient");
      return <p data-testid="recovered">recovered</p>;
    }

    const rendered = render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(rendered.byTestId("app-error-boundary")).toBeTruthy();

    shouldThrow = false;
    rendered.click("app-error-retry");

    expect(rendered.byTestId("recovered").textContent).toBe("recovered");
    expect(rendered.html()).not.toContain('data-testid="app-error-boundary"');
    rendered.unmount();
  });

  it("does not interfere with a tree that renders cleanly", () => {
    const rendered = render(
      <ErrorBoundary>
        <p data-testid="ok">fine</p>
      </ErrorBoundary>
    );
    expect(rendered.byTestId("ok").textContent).toBe("fine");
    expect(rendered.html()).not.toContain('data-testid="app-error-boundary"');
    rendered.unmount();
  });
});

describe("the boundary is MOUNTED around the router outlet", () => {
  it("RootLayout contains a throwing route instead of white-screening", async () => {
    // The router `Outlet` stands in for whatever route is active; `useEventStream` opens a real
    // network connection to the live event stream, which has no place in a component test.
    vi.doMock("@tanstack/react-router", () => ({
      Outlet: () => {
        throw new Error("a route blew up");
      }
    }));
    vi.doMock("../lib/use-event-stream", () => ({ useEventStream: () => {} }));
    const { RootLayout } = await import("./layout/RootLayout");

    const rendered = render(<RootLayout />);

    expect(rendered.byTestId("app-error-detail").textContent).toContain("a route blew up");
    rendered.unmount();
    vi.doUnmock("@tanstack/react-router");
    vi.doUnmock("../lib/use-event-stream");
  });
});

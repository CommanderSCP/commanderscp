import { Component, type ErrorInfo, type ReactNode } from "react";
import { isResponseValidationError, queryErrorMessage } from "./query-error";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";

/**
 * THE CONTAINMENT HALF OF ADR-0023 — `apps/web` HAD NO ERROR BOUNDARY AT ALL.
 *
 * Response validation makes a contract failure LOUD and SINGLE. A boundary makes it CONTAINED. The
 * two are complements, and until this component the SPA shipped only the first: any throw during
 * render — a validation error surfaced by a `useSuspenseQuery`-style read, an unguarded dereference
 * in one leaf cell, a bug in a formatter — unmounted React's whole tree and left the operator a
 * literally blank page with the diagnosis only in the devtools console. That is measured behaviour,
 * not a worry: `federation-status-crash.test.tsx` recorded `container.innerHTML.length === 0` for
 * exactly one such throw.
 *
 * WHERE IT SITS. Wrapped around the router `Outlet` in `RootLayout`, so it contains EVERY route.
 * It is deliberately NOT per-card: a boundary is the last line, and the per-query `isError`
 * branches (`QueryErrorNotice`) are the first — a page that handles its own read failure never
 * reaches this component, and a page that does reach it has a bug worth showing as a bug.
 *
 * WHAT IT RENDERS. The same diagnosis the `isError` branches render — verbatim `error.message`,
 * plus the contract/version-skew framing when the throw is a response-validation failure — because
 * the failure mode this exists to catch is precisely the one a fixed "Something went wrong" would
 * make undiagnosable again. `Try again` clears the captured error and re-renders the route; a
 * transient fault recovers without a full page load, and a persistent one immediately re-renders
 * this panel.
 */
interface ErrorBoundaryState {
  error: unknown;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the component stack — the rendered panel names the operation and the field, the console
    // names the component that dereferenced it.
    console.error("[scp] uncaught render error", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;

    const isContract = isResponseValidationError(error);
    // Rendered through the shared Alert (design spec §2.3) — the diagnostic CONTENT below and the
    // three testids are behaviour pinned by `error-boundary.test.tsx` and must not change.
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <Alert
          tone="danger"
          role="alert"
          data-testid="app-error-boundary"
          data-error-kind={isContract ? "contract" : "render"}
          className="w-full max-w-2xl p-4"
          title="This page failed to render."
        >
          {isContract ? (
            <p className="mt-2">
              This instance answered <code className="font-mono">{error.operation}</code> with a
              body that does not match the API contract this UI was built from — most likely a
              version skew between this UI and the instance. Upgrading the UI and the instance to
              the same release is the fix; nothing here is a network or permission failure.
            </p>
          ) : (
            <p className="mt-2">
              The error below escaped the page rather than being handled by it. It is reported
              verbatim — no part of it is a guess about what went wrong.
            </p>
          )}
          <p className="mt-2 break-words font-mono text-xs" data-testid="app-error-detail">
            {queryErrorMessage(error)}
          </p>
          {isContract && error.issues.length > 0 && (
            <ul className="mt-2 list-disc pl-5 font-mono text-xs" data-testid="app-error-fields">
              {error.issues.map((issue) => (
                <li key={`${issue.path}:${issue.code ?? ""}:${issue.message}`}>
                  {issue.path} — {issue.code ?? "invalid"}: {issue.message}
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={this.reset}
            data-testid="app-error-retry"
            className="mt-3 border-red-400 text-red-800 hover:bg-red-100"
          >
            Try again
          </Button>
        </Alert>
      </div>
    );
  }
}

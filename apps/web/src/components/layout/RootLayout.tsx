import { Outlet } from "@tanstack/react-router";
import { useEventStream } from "../../lib/use-event-stream";
import { ErrorBoundary } from "../error-boundary";

/** Root route component (router.tsx) — owns the app's ONE SSE connection for its whole lifetime,
 *  and the app's ONE error boundary (ADR-0023's containment half; `../error-boundary.tsx`). The
 *  boundary wraps `Outlet` rather than sitting above this component so a throw inside a route
 *  cannot take the SSE subscription down with it: `useEventStream` keeps running, and "Try again"
 *  re-renders the route into a still-live tree. */
export function RootLayout(): React.JSX.Element {
  useEventStream();
  return (
    <ErrorBoundary>
      <Outlet />
    </ErrorBoundary>
  );
}

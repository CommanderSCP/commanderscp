import { Outlet } from "@tanstack/react-router";
import { useEventStream } from "../../lib/use-event-stream";
import { ErrorBoundary } from "../error-boundary";

/** Root route component (router.tsx). See docs/web.md §65. */
export function RootLayout(): React.JSX.Element {
  useEventStream();
  return (
    <ErrorBoundary>
      <Outlet />
    </ErrorBoundary>
  );
}

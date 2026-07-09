import { Outlet } from "@tanstack/react-router";
import { useEventStream } from "../../lib/use-event-stream";

/** Root route component (router.tsx) — owns the app's ONE SSE connection for its whole lifetime. */
export function RootLayout(): React.JSX.Element {
  useEventStream();
  return <Outlet />;
}

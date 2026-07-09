import { Outlet } from "@tanstack/react-router";
import { RequireAuth } from "../RequireAuth";
import { AppShell } from "./AppShell";

/** Pathless layout route (router.tsx) wrapping every authenticated page in the nav chrome + guard. */
export function AuthenticatedLayout(): React.JSX.Element {
  return (
    <RequireAuth>
      <AppShell>
        <Outlet />
      </AppShell>
    </RequireAuth>
  );
}

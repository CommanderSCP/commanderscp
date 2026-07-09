import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context";

/**
 * Route guard for every authenticated page (BUILD_AND_TEST.md §8 M2 item 2: "route-guard
 * authenticated routes (redirect to /login if /auth/me 401s)"). Client-side redirect only — the
 * SPA has no server-rendered path to a real HTTP redirect here, `/auth/me`'s 401 is what's
 * authoritative; this just reacts to it.
 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isLoading && !user) {
      void navigate({ to: "/login" });
    }
  }, [isLoading, user, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}

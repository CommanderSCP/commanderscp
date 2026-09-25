import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context";

/** Route guard for every authenticated page. See docs/web.md §32.
 *
 * #422 review fix — ALSO redirects to `/change-password` whenever the session still carries
 * `mustChangePassword` (a bootstrap/one-time password never retired). This is a convenience, not
 * the actual enforcement: the server refuses every route but /auth/{me,logout,password} regardless
 * (require-auth.ts) — without this redirect the user would just see 403s on whatever page they
 * landed on instead of the door that fixes it. */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      void navigate({ to: "/login" });
    } else if (user.mustChangePassword) {
      void navigate({ to: "/change-password" });
    }
  }, [isLoading, user, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  if (!user || user.mustChangePassword) return null;
  return <>{children}</>;
}

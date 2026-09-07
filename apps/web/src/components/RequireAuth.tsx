import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context";

/** Route guard for every authenticated page. See docs/web.md §32. */
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

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CurrentUser } from "@scp/schemas";
import { client } from "./client";
import { authMeKey } from "./query-client";

interface AuthState {
  user: CurrentUser | undefined;
  isLoading: boolean;
  /** Re-run `GET /auth/me` — call after login/logout so the rest of the app sees the new state. */
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Root-level session provider (BUILD_AND_TEST.md §8 M2 item 2's "small root-level provider that
 * calls GET /auth/me once on load"). The SPA can't read the httpOnly `scp_session` cookie
 * itself, so this is the ONLY way it learns whether/who it's logged in as — every route-guard
 * (components/RequireAuth.tsx) and the nav (components/AppShell.tsx) reads from here rather than
 * each firing its own `/auth/me` request.
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: authMeKey,
    queryFn: () => client.auth.me(),
    // A 401 here just means "not logged in" — not worth retrying, and definitely not worth
    // TanStack Query's default exponential-backoff retries before settling into that state.
    retry: false
  });

  const value = useMemo<AuthState>(
    () => ({
      user: data,
      isLoading,
      refresh: () => queryClient.invalidateQueries({ queryKey: authMeKey })
    }),
    [data, isLoading, queryClient]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be used within <AuthProvider>");
  return ctx;
}

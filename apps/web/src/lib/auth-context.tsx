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

/** Root-level session provider. See docs/web.md §115. */
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

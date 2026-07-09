import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { authConfigKey } from "../lib/query-client";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

/** `/login` (BUILD_AND_TEST.md §8 M2 item 2) — local-auth form, plus an OIDC "Continue with SSO" link. */
export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Public — no auth required (routes/auth.ts `getAuthConfig`) — decides whether to render the
  // SSO link below.
  const { data: authConfig } = useQuery({
    queryKey: authConfigKey,
    queryFn: () => client.auth.config()
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await client.login(username, password);
      await refresh();
      await navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>CommanderSCP</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-sm font-medium text-slate-700">
                Username
              </label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-slate-700">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p className="text-sm text-red-600" data-testid="login-error">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {authConfig?.oidcEnabled && (
            <div className="mt-4 border-t border-slate-200 pt-4 text-center">
              {/* A real full-page browser navigation (an <a href>, not a fetch/SDK call) — the
                  OIDC login redirect flow (routes/oidc.ts) is a 302 to the IdP, which only makes
                  sense as top-level navigation. */}
              <a
                href="/api/v1/auth/oidc/login"
                className="text-sm font-medium text-slate-700 underline underline-offset-4 hover:text-slate-900"
              >
                Continue with SSO
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

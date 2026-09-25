import { useState, type FormEvent } from "react";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent } from "../components/ui/card";
import { BrandMark } from "../components/layout/BrandMark";

/**
 * `/change-password` (#422 review fix, SHOULD-FIX 3) — the UI door for `POST /auth/password`, the
 * ONLY thing that clears `CurrentUser.mustChangePassword`. `RequireAuth.tsx` redirects here
 * whenever the signed-in user still carries that flag (a bootstrap/one-time password that has
 * never been retired) and refuses to route anywhere else until it is cleared — every other API
 * call 403s in the meantime (require-auth.ts's gate), so a page other than this one would just
 * show refusals.
 */
export function ChangePasswordPage(): React.JSX.Element {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    setSubmitting(true);
    try {
      await client.auth.changePassword(currentPassword, newPassword);
      // #422 re-verify — measured live (a real Playwright run, not a guess): a client-side
      // navigate() here raced RequireAuth's own effect on the dashboard route against React
      // Query's cache-update notification for the CURRENT user's mustChangePassword — sometimes
      // landing on the dashboard, sometimes bounced straight back to /change-password because the
      // guard's very next render still read the stale cached value. A full page load sidesteps
      // that class of race entirely: the browser's fresh GET /auth/me on reload can only ever see
      // the server's ACTUAL current state (mustChangePassword: false, since changePassword above
      // already succeeded), never a client-cache snapshot that hasn't caught up yet. This page is
      // a one-time detour, not a route a user bounces through repeatedly, so trading the SPA's
      // usual no-reload navigation for a guaranteed-correct one here is a good trade.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-army-50 p-4">
      <Card className="w-full max-w-sm border-t-2 border-t-army-700 p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2 pb-6 text-center">
          <BrandMark size="lg" />
          <h1 className="text-lg font-semibold text-slate-900">Change your password</h1>
          <p className="text-xs text-slate-500">
            {user?.username ? `Signed in as ${user.username}. ` : ""}
            This account was created with a one-time password that must be changed before you can
            continue.
          </p>
        </div>
        <CardContent className="p-0">
          <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="current-password" className="text-sm font-medium text-slate-700">
                Current (one-time) password
              </label>
              <Input
                id="current-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-password" className="text-sm font-medium text-slate-700">
                New password (min 12 characters)
              </label>
              <Input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={12}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="confirm-password" className="text-sm font-medium text-slate-700">
                Confirm new password
              </label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={12}
                required
              />
            </div>
            {error && (
              <p className="text-sm text-red-600" data-testid="change-password-error">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Changing…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

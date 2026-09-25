// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CurrentUser } from "@scp/schemas";
import { ChangePasswordPage } from "./change-password.js";
import { AuthProvider } from "../lib/auth-context.js";
import { authMeKey } from "../lib/query-client.js";
import { client } from "../lib/client.js";
import { flush, render, typeInto, type Rendered } from "../test-support/render-dom.js";

const user: CurrentUser = {
  userId: "u1",
  orgId: "o1",
  orgName: "acme",
  username: "admin",
  subjectObjectId: "obj1",
  instanceRole: "commander",
  mustChangePassword: true,
  roleBindings: [],
  permissionsAnywhere: []
};

function renderPage(): Rendered {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(authMeKey, user);
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ChangePasswordPage />
      </AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * #422 re-verify — measured live in a real Playwright run: a client-side `navigate()` here raced
 * RequireAuth's own effect on the dashboard route against React Query's cache-update notification
 * for mustChangePassword, sometimes bouncing straight back to /change-password instead of landing
 * on the dashboard. Fixed with a full page load instead (`window.location.assign`), which cannot
 * race a client-side cache at all — the browser's next GET /auth/me can only see the server's
 * actual, already-updated state. This test proves THAT call happens on success, without needing a
 * real browser or a router to observe the (now moot) client-side race.
 */
describe("ChangePasswordPage", () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("MUTATION-CAUGHT: a successful change triggers a full page load to '/', not a client-side navigation", async () => {
    vi.spyOn(client.auth, "changePassword").mockResolvedValue(undefined);
    const rendered = renderPage();

    const currentInput = rendered.container.querySelector<HTMLInputElement>("#current-password")!;
    const newInput = rendered.container.querySelector<HTMLInputElement>("#new-password")!;
    const confirmInput = rendered.container.querySelector<HTMLInputElement>("#confirm-password")!;
    typeInto(currentInput, "one-time-password-123");
    typeInto(newInput, "a-brand-new-password-456");
    typeInto(confirmInput, "a-brand-new-password-456");

    const form = rendered.container.querySelector("form")!;
    await flush();
    form.requestSubmit();
    await flush();

    expect(client.auth.changePassword).toHaveBeenCalledWith(
      "one-time-password-123",
      "a-brand-new-password-456"
    );
    expect(assignSpy).toHaveBeenCalledWith("/");
  });

  it("shows a client-side error and does NOT navigate when the passwords don't match", async () => {
    vi.spyOn(client.auth, "changePassword").mockResolvedValue(undefined);
    const rendered = renderPage();

    const currentInput = rendered.container.querySelector<HTMLInputElement>("#current-password")!;
    const newInput = rendered.container.querySelector<HTMLInputElement>("#new-password")!;
    const confirmInput = rendered.container.querySelector<HTMLInputElement>("#confirm-password")!;
    typeInto(currentInput, "one-time-password-123");
    typeInto(newInput, "a-brand-new-password-456");
    typeInto(confirmInput, "does-not-match-789012");

    const form = rendered.container.querySelector("form")!;
    await flush();
    form.requestSubmit();
    await flush();

    expect(client.auth.changePassword).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(rendered.byTestId("change-password-error").textContent).toContain("do not match");
  });
});

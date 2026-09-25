import type { Page } from "@playwright/test";

/** Origin the SPA is served from (e2e/global-setup.ts) — e.g. `http://127.0.0.1:53821`. */
export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL is unset — did e2e/global-setup.ts run?");
  return url;
}

/** The API's own base URL (`{baseUrl()}/api/v1`) — for fixture setup via `@scp/sdk` directly. */
export function apiBaseUrl(): string {
  const url = process.env.E2E_API_BASE_URL;
  if (!url) throw new Error("E2E_API_BASE_URL is unset — did e2e/global-setup.ts run?");
  return url;
}

export interface AdminCredentials {
  username: string;
  password: string;
  orgName: string;
}

export function adminCredentials(): AdminCredentials {
  const username = process.env.E2E_ADMIN_USERNAME;
  const password = process.env.E2E_ADMIN_PASSWORD;
  const orgName = process.env.E2E_ORG_NAME;
  if (!username || !password || !orgName) {
    throw new Error("E2E admin credentials are unset — did e2e/global-setup.ts run?");
  }
  return { username, password, orgName };
}

/**
 * Drives `/change-password` to completion — assumes the page is already there (RequireAuth.tsx's
 * own redirect). #422 re-verify: `ensureBootstrapAdmin` always sets `mustChangePassword: true`
 * (docs/adr/0060-front-door.md §2), so the FIRST browser login of the one shared compose admin
 * lands here instead of the dashboard. A same-password "change" is refused server-side
 * (changeLocalPassword), so this genuinely changes the password — `process.env.E2E_ADMIN_PASSWORD`
 * is updated so every LATER call to `adminCredentials()`/`loginAsAdmin` (in this file OR another
 * spec) uses the new value. Safe as a plain env-var mutation because `apps/web/playwright.config.ts`
 * runs with `workers: 1`/`fullyParallel: false` — every spec file executes sequentially in the
 * same worker process, never concurrently, so there is no race to change the SAME shared account's
 * password from two places at once.
 */
async function completeForcedPasswordChange(page: Page): Promise<void> {
  const { password: current } = adminCredentials();
  const fresh = `e2e-ui-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  await page.fill("#current-password", current);
  await page.fill("#new-password", fresh);
  await page.fill("#confirm-password", fresh);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${baseUrl()}/`);
  process.env.E2E_ADMIN_PASSWORD = fresh;
}

/** Logs in via the real local-auth form (not a raw API call) and waits for the dashboard —
 *  transparently satisfying a forced password change first if this is the account's first login
 *  (see `completeForcedPasswordChange` above). `apps/web/e2e/00-forced-password-change.spec.ts`
 *  is the one spec that drives this exact flow itself, with explicit assertions on the
 *  intermediate screen, rather than through this shared, silent-about-it helper. */
export async function loginAsAdmin(page: Page): Promise<void> {
  const { username, password } = adminCredentials();
  await page.goto(`${baseUrl()}/login`);
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === "/" || url.pathname === "/change-password", {
    timeout: 10_000
  });
  if (new URL(page.url()).pathname === "/change-password") {
    await completeForcedPasswordChange(page);
    return;
  }
}

/** Enables the graph explorer's dev-only Cytoscape testability hook. See docs/web.md §9. */
export async function enableGraphTestHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __SCP_E2E__?: boolean }).__SCP_E2E__ = true;
  });
}

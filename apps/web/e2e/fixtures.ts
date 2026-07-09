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

/** Logs in via the real local-auth form (not a raw API call) and waits for the dashboard. */
export async function loginAsAdmin(page: Page): Promise<void> {
  const { username, password } = adminCredentials();
  await page.goto(`${baseUrl()}/login`);
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${baseUrl()}/`);
}

/**
 * Enables the graph explorer's dev-only Cytoscape testability hook
 * (apps/web/src/routes/graph-explorer.tsx `window.__cy`) for every subsequent navigation on this
 * page — the ONLY way to reach it against the production build this suite runs against
 * (`import.meta.env.DEV` is false there). Call before navigating.
 */
export async function enableGraphTestHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __SCP_E2E__?: boolean }).__SCP_E2E__ = true;
  });
}

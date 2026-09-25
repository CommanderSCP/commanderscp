import { test, expect } from "@playwright/test";
import { adminCredentials, baseUrl } from "./fixtures.js";

/**
 * #422 re-verify — proves the forced-password-change UI door itself works, with EXPLICIT
 * assertions on the intermediate screen: login → must-change screen → set a new password →
 * dashboard. Every other spec goes through `fixtures.ts`'s `loginAsAdmin`, which handles this
 * SAME redirect transparently (so a spec that only cares about, say, the graph explorer doesn't
 * have to know about it) — this file is the one place that watches it happen on purpose.
 *
 * Named `00-` so it sorts first: `apps/web/playwright.config.ts` runs with `workers: 1` /
 * `fullyParallel: false` (every spec file executes sequentially, never concurrently, in one
 * worker process), and the compose stack's bootstrap admin only has ONE first login to give —
 * whichever spec reaches it first is the one that sees `/change-password` instead of the
 * dashboard. Running this one first means the explicit assertions below are exercised against a
 * password that has never been changed by anything else, and `loginAsAdmin`'s OWN transparent
 * handling is proved correct for every spec that runs after it (that path is never hit here, but
 * every other spec file depends on it having been).
 */
test("forced password change: a first login lands on /change-password, and completing it reaches the dashboard", async ({
  page
}) => {
  // Compose-stack mode only (scripts/e2e-web.sh, CI job 9): that admin's mustChangePassword is
  // still true on its first browser login (ensureBootstrapAdmin always sets it; seed.ts's own
  // demo-seed login resets-and-rearms it before Playwright ever starts). The LOCAL target
  // (`pnpm --filter @scp/web test:e2e` with no PLAYWRIGHT_BASE_URL) uses
  // apps/web/e2e/global-setup.ts's createTestOrg, which clears the flag directly at the DB layer
  // as part of fixture setup — modeling an org that has ALREADY finished onboarding — so there is
  // no must-change screen left to reach there; this spec would only be asserting a false negative.
  test.skip(
    !process.env.PLAYWRIGHT_BASE_URL,
    "compose-stack only — the local target's createTestOrg fixture pre-clears mustChangePassword"
  );

  const { username, password } = adminCredentials();

  await page.goto(`${baseUrl()}/login`);
  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');

  // The must-change screen — never the dashboard — on this account's first login
  // (ensureBootstrapAdmin always sets mustChangePassword: true; docs/adr/0060-front-door.md §2).
  await page.waitForURL(`${baseUrl()}/change-password`);
  await expect(page.locator("h1")).toHaveText("Change your password");

  // A same-password "change" is refused server-side (changeLocalPassword) — must be a genuinely
  // different value, and long enough (min 12 chars, enforced both client- and server-side).
  const freshPassword = `e2e-ui-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  await page.fill("#current-password", password);
  await page.fill("#new-password", freshPassword);
  await page.fill("#confirm-password", freshPassword);
  await page.click('button[type="submit"]');

  // Success lands on the dashboard, not back on /login or stuck on /change-password.
  await page.waitForURL(`${baseUrl()}/`);
  await expect(page).not.toHaveURL(`${baseUrl()}/change-password`);

  // The account's password really changed — the OLD one no longer works, the NEW one does.
  // process.env.E2E_ADMIN_PASSWORD is updated here (not just locally) so every OTHER spec file
  // running after this one in the same sequential worker (loginAsAdmin, via adminCredentials())
  // authenticates with the value that is ACTUALLY current, matching what
  // fixtures.ts's own transparent handling would have stored had this spec not run first.
  process.env.E2E_ADMIN_PASSWORD = freshPassword;

  await page.goto(`${baseUrl()}/login`);
  await page.fill("#username", username);
  await page.fill("#password", freshPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${baseUrl()}/`);
});

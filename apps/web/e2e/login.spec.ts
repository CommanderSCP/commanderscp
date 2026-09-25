import { expect, test } from "@playwright/test";
import { adminCredentials, baseUrl, loginAsAdmin } from "./fixtures.js";

/** Smoke test 1 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section). See docs/web.md §14. */
test("login: unauthenticated visit to / redirects to /login, and logging in reaches the dashboard", async ({
  page
}) => {
  const { orgName } = adminCredentials();

  await page.goto(`${baseUrl()}/`);
  await page.waitForURL(`${baseUrl()}/login`);
  await expect(page.getByRole("heading", { name: "CommanderSCP" })).toBeVisible();

  // Through the shared helper (not a second, manual re-implementation of the same form-fill) —
  // it transparently satisfies a forced password change first if this account's first login
  // hasn't happened yet (#422 re-verify: see fixtures.ts's own doc comment). In this suite's
  // normal run, 00-forced-password-change.spec.ts already did that (it sorts first and this
  // suite runs single-worker/sequential — apps/web/playwright.config.ts), so this call just logs
  // in; the transparent handling is what makes this test correct even if that ever changes.
  await loginAsAdmin(page);

  // The account chrome lives in the header bar since the design overhaul; `current-org` is its
  // pinned testid (AppShell §3.3) and renders "org · username".
  await expect(page.getByTestId("current-org")).toContainText(orgName);
});

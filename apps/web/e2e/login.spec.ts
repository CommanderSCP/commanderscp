import { expect, test } from "@playwright/test";
import { adminCredentials, baseUrl } from "./fixtures.js";

/** Smoke test 1 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section). See docs/web.md §14. */
test("login: unauthenticated visit to / redirects to /login, and logging in reaches the dashboard", async ({
  page
}) => {
  const { username, password, orgName } = adminCredentials();

  await page.goto(`${baseUrl()}/`);
  await page.waitForURL(`${baseUrl()}/login`);
  await expect(page.getByRole("heading", { name: "CommanderSCP" })).toBeVisible();

  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click('button[type="submit"]');

  await page.waitForURL(`${baseUrl()}/`);
  // The account chrome lives in the header bar since the design overhaul; `current-org` is its
  // pinned testid (AppShell §3.3) and renders "org · username".
  await expect(page.getByTestId("current-org")).toContainText(orgName);
});

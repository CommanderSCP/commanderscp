import { expect, test } from "@playwright/test";
import { adminCredentials, baseUrl } from "./fixtures.js";

/**
 * Smoke test 1 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to `/`, get redirected
 * to `/login` (RequireAuth's client-side guard reacting to `GET /auth/me`'s 401), fill the
 * local-auth form with the seeded test-org admin credentials, submit, assert redirect to `/` and
 * the dashboard renders the org name.
 */
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
  await expect(page.getByTestId("org-name")).toHaveText(orgName);
});

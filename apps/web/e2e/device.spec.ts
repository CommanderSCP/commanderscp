import { expect, test } from "@playwright/test";
import { baseUrl, loginAsAdmin } from "./fixtures.js";

/**
 * Smoke test 5 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to
 * `/device?user_code=XXXX-XXXX` while logged in, assert the form is pre-filled. The full
 * approve round-trip against a real polling CLI is covered by stage 2's server-side integration
 * test (auth/device-flow.integration.test.ts) — this just proves the page renders and the field
 * is populated from the query param.
 */
test("device flow page: pre-fills the user_code from the query param", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`${baseUrl()}/device?user_code=ABCD-1234`);
  await expect(page.getByTestId("device-code-input")).toHaveValue("ABCD-1234");
});

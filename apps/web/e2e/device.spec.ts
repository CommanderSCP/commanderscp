import { expect, test } from "@playwright/test";
import { baseUrl, loginAsAdmin } from "./fixtures.js";

/** Smoke test 5 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section). See docs/web.md §7. */
test("device flow page: pre-fills the user_code from the query param", async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`${baseUrl()}/device?user_code=ABCD-1234`);
  await expect(page.getByTestId("device-code-input")).toHaveValue("ABCD-1234");
});

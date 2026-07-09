import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";

/**
 * Smoke test 2 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to `/services`, assert
 * the list renders without error; create a service directly against the API (via `@scp/sdk`,
 * same real HTTP path `scp service register` uses), reload the page, assert it now appears.
 */
test("browse: /services list renders, and a service created via the API appears after reload", async ({
  page
}) => {
  await loginAsAdmin(page);

  await page.goto(`${baseUrl()}/services`);
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  const { username, password } = adminCredentials();
  const client = new ScpClient({ baseUrl: apiBaseUrl() });
  await client.login(username, password);
  const name = `browse-test-${randomUUID()}`;
  await client.services.create({ name });

  await page.reload();
  // `exact: true` — otherwise this also (correctly) matches the row's URN cell, which contains
  // `name` as a substring (`urn:scp:{org}:service:{name}`), tripping Playwright's strict mode.
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
});

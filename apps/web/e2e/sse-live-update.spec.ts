import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";

/**
 * Smoke test 3 — the core mechanism DoD (a) tests (BUILD_AND_TEST.md §8 M2 item 2): with
 * `/services` already open, create a NEW service via the API WITHOUT reloading the page, and
 * assert it appears within a short timeout. `expect(...).toBeVisible()` is Playwright's built-in
 * auto-retrying (polling) assertion — deliberately NOT a `page.reload()`, which would defeat the
 * point of testing SSE (routes/events.ts -> events/sse-hub.ts -> apps/web's
 * src/lib/use-event-stream.ts query-cache invalidation).
 */
test("SSE live update: a service created via the API appears in /services without a reload", async ({
  page
}) => {
  await loginAsAdmin(page);

  await page.goto(`${baseUrl()}/services`);
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

  const { username, password } = adminCredentials();
  const client = new ScpClient({ baseUrl: apiBaseUrl() });
  await client.login(username, password);
  const name = `sse-live-${randomUUID()}`;

  await client.services.create({ name });

  // The outbox relay's poll fallback runs every 1s (events/outbox-relay.ts) — this timeout gives
  // comfortable headroom over "one SSE tick" without masking a genuine regression. `exact: true`
  // — otherwise this also (correctly) matches the row's URN cell, which contains `name` as a
  // substring (`urn:scp:{org}:service:{name}`), tripping Playwright's strict mode.
  await expect(page.getByRole("cell", { name, exact: true })).toBeVisible({ timeout: 8_000 });
});

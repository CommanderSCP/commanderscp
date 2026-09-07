import { randomUUID, generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";
import {
  apiPathOf,
  isDeclaredOperation,
  loadOpenApiDocument,
  operationsOf,
  unexpectedCalls,
  type ApiCall
} from "./openapi-conformance.js";

/** Nav, list and detail, and nothing bypasses the public API. See docs/web.md §20. */

test("Outposts: nav → list → detail, and every API call the browser makes is a declared operation", async ({
  page
}) => {
  const { username, password } = adminCredentials();
  const api = new ScpClient({ baseUrl: apiBaseUrl() });
  await api.login(username, password);

  // A REAL paired outpost peer, created through the public API (the only way one exists). Federation
  // self is initialized first because pairing is a commander-side act; `initFederationSelf` is an
  // UPDATE, so re-declaring the same role in a suite that shares one org is not a state change.
  await api.federation.init({ name: `commander-${randomUUID().slice(0, 8)}`, role: "commander" });
  const peerDomainId = randomUUID();
  const { publicKey } = generateKeyPairSync("ed25519");
  await api.federation.pair({
    domainId: peerDomainId,
    name: `e2e-outpost-${peerDomainId.slice(0, 8)}`,
    role: "outpost",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    baseUrl: "https://e2e-outpost.example.test"
  });

  await loginAsAdmin(page);

  // Capture starts only now, so the login form's own calls are not part of the sweep — they are
  // `login.spec.ts`'s subject, not this one's.
  const captured: ApiCall[] = [];
  page.on("request", (request) => {
    const apiPath = apiPathOf(request.url());
    if (apiPath !== null) captured.push({ method: request.method(), path: apiPath });
  });

  // 1. NAV — reached by CLICKING the sidebar, not by typing a URL: a page nothing links to is a page
  //    nobody finds.
  await page.getByRole("link", { name: "Outposts", exact: true }).click();
  await page.waitForURL(`${baseUrl()}/federation/outposts`);

  // 2. LIST — the peer paired above is listed, with the honest cells the overview owes it.
  const row = page.locator(`[data-testid="outpost-row"][data-peer-id="${peerDomainId}"]`);
  await expect(row).toHaveCount(1);
  // No tier was ever asserted for this peer, so the tier cell is an explicit unknown — NOT
  // `commercial`, and not a blank.
  await expect(row.locator('[data-testid="outpost-tier"]')).toHaveAttribute(
    "data-trust-tier",
    "unknown"
  );
  await expect(row.getByTestId("outpost-unknown").first()).toHaveText("unknown here");
  // Nothing has been exported to it, so the export cell says exactly that and offers no zero.
  await expect(row.locator('[data-testid="outpost-export"]')).toHaveAttribute(
    "data-export-state",
    "none-recorded"
  );

  await row.getByTestId("outpost-link").click();
  await page.waitForURL(`${baseUrl()}/federation/outposts/${peerDomainId}`);
  await expect(page.getByTestId("outpost-detail-name")).toBeVisible();
  // Both halves of the authority split are on the page, each naming the door it writes through.
  await expect(page.getByTestId("peer-settings-form")).toBeVisible();
  await expect(page.getByTestId("peer-role-readonly")).toHaveText("outpost");
  await expect(page.getByTestId("poke-mode-card")).toBeVisible();
  await expect(page.getByTestId("managed-elsewhere")).toBeVisible();

  // 4. THE SWEEP. Every captured call must be a declared operation.
  const declared = operationsOf(loadOpenApiDocument());
  expect(captured.length, "the walk actually exercised the API").toBeGreaterThan(0);
  expect(
    unexpectedCalls(declared, captured),
    "every API path the browser requested must match an operation in the emitted OpenAPI document " +
      "— with no exemptions: the SSE stream that used to be the one carve-out is now declared"
  ).toEqual([]);

  // NON-VACUITY, here and not only in the matcher's unit test: an assertion that nothing can fail is
  // not a check.
  expect(isDeclaredOperation(declared, { method: "GET", path: "/federation/status" })).toBe(true);
  expect(
    isDeclaredOperation(declared, { method: "GET", path: "/federation/not-an-operation" })
  ).toBe(false);

  // …and the Outposts UI really did reach the federation surface through the public API.
  expect(captured.some((call) => call.path === "/federation/status")).toBe(true);
  expect(captured.some((call) => call.path === "/federation/outposts")).toBe(true);
});

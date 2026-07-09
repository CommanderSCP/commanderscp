import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, enableGraphTestHook, loginAsAdmin } from "./fixtures.js";

interface CyLike {
  nodes: () => { length: number };
  edges: () => { length: number };
}

/**
 * Smoke test 4 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): create fixture data (two services
 * + a `depends_on` edge) via `@scp/sdk` directly, navigate to `/graph/{idOrUrn}` for the source
 * object, assert the Cytoscape container renders and shows at least the expected node/edge
 * count. Cytoscape renders to `<canvas>`, which isn't otherwise inspectable — this suite exposes
 * `window.__cy` for exactly this purpose (routes/graph-explorer.tsx, gated so it's unreachable
 * outside a Playwright-controlled page — see fixtures.ts `enableGraphTestHook`).
 */
test("graph explorer: renders nodes/edges for an object with a real relationship", async ({ page }) => {
  const { username, password } = adminCredentials();
  const client = new ScpClient({ baseUrl: apiBaseUrl() });
  await client.login(username, password);

  const suffix = randomUUID();
  const source = await client.services.create({ name: `graph-source-${suffix}` });
  const target = await client.services.create({ name: `graph-target-${suffix}` });
  await client.services.addDependsOn(source.id, target.id);

  await enableGraphTestHook(page);
  await loginAsAdmin(page);
  await page.goto(`${baseUrl()}/graph/${source.id}`);

  await expect(page.getByTestId("cytoscape-container")).toBeVisible();

  // Default query is "Impact of" (reverse closure — what points AT source), which is empty for a
  // fresh source node; switch to "Traverse (outgoing)" to see the depends_on edge just created.
  await page.getByTestId("graph-query-select").click();
  await page.getByRole("option", { name: "Traverse (outgoing)" }).click();

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __cy?: CyLike }).__cy?.nodes().length ?? -1
        ),
      { timeout: 10_000 }
    )
    .toBeGreaterThanOrEqual(2);

  const edgeCount = await page.evaluate(
    () => (window as unknown as { __cy: CyLike }).__cy.edges().length
  );
  expect(edgeCount).toBeGreaterThanOrEqual(1);
});

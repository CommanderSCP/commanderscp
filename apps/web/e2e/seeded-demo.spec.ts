import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import {
  adminCredentials,
  apiBaseUrl,
  baseUrl,
  enableGraphTestHook,
  loginAsAdmin
} from "./fixtures.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.resolve(__dirname, "../../../packages/cli/dist/bin.js");

interface CyLike {
  nodes: () => { length: number };
  edges: () => { length: number };
}

/** Runs the real `scp` CLI binary as a subprocess against the compose stack, exactly like
 * scripts/e2e-m0.sh — a fresh, throwaway credentials dir per call so this never touches a
 * developer's real `~/.scp`. */
async function runCli(args: string[], env: Record<string, string>): Promise<void> {
  await execFileAsync(process.execPath, [CLI_BIN, ...args], { env: { ...process.env, ...env } });
}

/**
 * Compose-stack-only specs (BUILD_AND_TEST.md §8 M2 DoD (a) literal wording; scripts/e2e-web.sh).
 * Skipped entirely for the LOCAL target (`pnpm --filter @scp/web test:e2e`, no
 * `PLAYWRIGHT_BASE_URL`) — that Testcontainers-backed server has neither `SCP_SEED_DEMO` data
 * nor a built `packages/cli/dist/bin.js` alongside it. Requires `pnpm build` (for the CLI binary)
 * in addition to `pnpm --filter @scp/web build` — scripts/e2e-web.sh does both.
 */
test.describe("seeded demo data (compose stack only)", () => {
  test.skip(!process.env.PLAYWRIGHT_BASE_URL, "compose-stack only — see scripts/e2e-web.sh");

  test("graph explorer: renders the seeded org's real nodes/edges", async ({ page }) => {
    const { username, password } = adminCredentials();
    const client = new ScpClient({ baseUrl: apiBaseUrl() });
    await client.login(username, password);

    const services = await client.services.list({ limit: 100 });
    const checkout = services.items.find((s) => s.name === "checkout");
    if (!checkout) {
      throw new Error(
        "expected the seeded 'checkout' service (SCP_SEED_DEMO=true, seed.ts) to already exist"
      );
    }

    await enableGraphTestHook(page);
    await loginAsAdmin(page);
    await page.goto(`${baseUrl()}/graph/${checkout.id}`);

    await expect(page.getByTestId("cytoscape-container")).toBeVisible();

    // "checkout" depends_on "payments-gateway" (seed.ts) — switch off the default "Impact of"
    // query (a reverse closure, which for checkout only shows its owning team) to "Traverse
    // (outgoing)" so the depends_on edge to payments-gateway is what's asserted on.
    await page.getByTestId("graph-query-select").click();
    await page.getByRole("option", { name: "Traverse (outgoing)" }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __cy?: CyLike }).__cy?.nodes().length ?? -1),
        { timeout: 10_000 }
      )
      .toBeGreaterThanOrEqual(2);

    const edgeCount = await page.evaluate(
      () => (window as unknown as { __cy: CyLike }).__cy.edges().length
    );
    expect(edgeCount).toBeGreaterThanOrEqual(1);
  });

  test("scp service register (real CLI) appears in /services within one SSE tick, without reload", async ({
    page
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${baseUrl()}/services`);
    await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();

    const { username, password } = adminCredentials();
    const name = `cli-e2e-${randomUUID()}`;
    const cliConfigDir = await mkdtemp(path.join(os.tmpdir(), "scp-e2e-web-cli-"));
    try {
      const env = { SCP_CONFIG_DIR: cliConfigDir, SCP_API_URL: apiBaseUrl() };
      await runCli(["login", "--username", username, "--password", password], env);
      await runCli(["service", "register", "--name", name], env);
    } finally {
      await rm(cliConfigDir, { recursive: true, force: true });
    }

    // Deliberately NOT a page.reload() — the point is proving the SSE push (routes/events.ts ->
    // events/sse-hub.ts -> apps/web's src/lib/use-event-stream.ts) actually delivered this
    // CLI-created object to the already-open browser tab. `exact: true` — otherwise this also
    // (correctly) matches the row's URN cell, which contains `name` as a substring.
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible({ timeout: 8_000 });
  });
});

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { GraphObject } from "@scp/schemas";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";
import { FAKE_ARGOCD_APPS } from "./fake-argocd.js";

/**
 * M19.1 — THE "CONNECT ARGO CD" WIZARD, END TO END.
 *
 * WHAT ONLY THIS LAYER CAN PROVE. `src/routes/connect-argocd.test.tsx` pins the credential and
 * honesty clauses on every PR with no browser; what it cannot pin is that the four SDK doors, real
 * authz, the plugin host, the SSRF egress guard and `discovery accept`'s transaction actually
 * compose into an import. Every one of those is server-side, and the enumerate step in particular
 * is a call the SERVER makes — no amount of client-side stubbing reaches it.
 *
 * THE FAKE ARGO CD IS NOT A CONVENIENCE, IT IS TWO ASSERTIONS:
 *
 *   * It lives at a PRIVATE address (a loopback in local mode, a compose-network name in CI). SCP
 *     refuses plugin egress there by default, so the run only succeeds if BOTH ADR-0003 layers
 *     permit — the operator allowlist the harness sets, and the `allowInternalEgress` declaration
 *     the wizard's checkbox writes. Ticking that box below is therefore load-bearing: untick it and
 *     this spec fails at step 2. That is the in-cluster case the wizard exists for.
 *
 *   * It demands a Bearer token, so reaching step 3 proves the credential travelled secrets store ->
 *     server -> plugin subprocess -> Argo CD. A fake that accepted anonymous requests would let a
 *     wizard that never stored the token pass.
 *
 * THE FINAL ASSERTIONS READ THE GRAPH BACK THROUGH THE SDK, not the success screen. A summary
 * agreeing with itself is not evidence; components and executor bindings that exist afterwards are.
 */
test("the wizard registers an Argo CD, enumerates it, and imports its Applications", async ({
  page
}) => {
  const fakeArgoCdUrl = process.env.E2E_FAKE_ARGOCD_URL;
  if (!fakeArgoCdUrl) {
    throw new Error("E2E_FAKE_ARGOCD_URL is unset — did e2e/global-setup.ts run?");
  }

  // A unique system name per run: the compose-stack target reuses one long-lived database across
  // the whole suite, and `execution-system` names are the wizard's plugin-instance id.
  const systemName = `e2e-argocd-${randomUUID().slice(0, 8)}`;
  const token = `fake-argocd-token-${randomUUID()}`;

  await loginAsAdmin(page);

  // --- Step 1: register -----------------------------------------------------------------------
  await page.goto(`${baseUrl()}/plugins`);
  await page.getByTestId("connect-argocd-launch").click();
  await expect(page).toHaveURL(`${baseUrl()}/connect/argocd`);

  await page.getByTestId("argocd-name-input").fill(systemName);
  await page.getByTestId("argocd-url-input").fill(fakeArgoCdUrl);
  await page.getByTestId("argocd-token-input").fill(token);

  await expect(
    page.getByTestId("argocd-token-input"),
    "a credential field is a password field"
  ).toHaveAttribute("type", "password");

  // ADR-0003 layer 2. Without this the enumerate step below is refused by the egress guard — which
  // is precisely the homelab/in-cluster case, and precisely why the control is not hidden.
  await page.getByTestId("argocd-internal-egress-checkbox").check();
  await page.getByTestId("argocd-register-submit").click();

  // --- Step 2: enumerate (the real, server-side connectivity check) ---------------------------
  await expect(page.getByTestId("connect-argocd-enumerate")).toBeVisible();
  await expect(page.getByTestId("argocd-system-name")).toHaveText(systemName);
  await page.getByTestId("argocd-enumerate-submit").click();

  // --- Step 3: review -------------------------------------------------------------------------
  await expect(page.getByTestId("connect-argocd-review")).toBeVisible();
  const proposed = page.getByTestId("argocd-proposal-object");
  await expect(proposed).toHaveCount(FAKE_ARGOCD_APPS.length);
  for (const app of FAKE_ARGOCD_APPS) {
    await expect(proposed.filter({ hasText: app.metadata.name })).toHaveCount(1);
  }

  await page.getByTestId("argocd-accept-submit").click();

  // --- The summary ----------------------------------------------------------------------------
  await expect(page.getByTestId("connect-argocd-summary")).toBeVisible();
  await expect(page.getByTestId("argocd-created-graph-objects")).toContainText(
    String(FAKE_ARGOCD_APPS.length)
  );
  await expect(page.getByTestId("argocd-created-executor-bindings")).toContainText(
    String(FAKE_ARGOCD_APPS.length)
  );
  // `discovery accept` creates no relationships for an argocd import (the 2026-07-15 correction in
  // docs/proposals/import-existing-executors.md §3), so the wizard must SAY the imported components
  // are orphans rather than imply a graph link that is not there.
  await expect(page.getByTestId("argocd-created-graph-relationships")).toContainText("0");
  await expect(page.getByTestId("argocd-orphan-notice")).toBeVisible();

  // --- What is actually in the graph ----------------------------------------------------------
  const { username, password } = adminCredentials();
  const api = new ScpClient({ baseUrl: apiBaseUrl() });
  await api.login(username, password);

  // Paged, not `limit: 200` — `ObjectListQuerySchema` caps `limit` at 100 and the compose stack
  // this runs against is seeded (`SCP_SEED_DEMO=true`), so the imported pair is not guaranteed to
  // be on the first page. A single over-limit page would 400; a single default page (20) would
  // silently miss them, which is worse.
  const components: GraphObject[] = [];
  let cursor: string | null = null;
  do {
    const batch = await api.object("component").list({ limit: 100, ...(cursor ? { cursor } : {}) });
    components.push(...batch.items);
    cursor = batch.nextCursor;
  } while (cursor);
  for (const app of FAKE_ARGOCD_APPS) {
    const imported = components.find((c) => c.name === app.metadata.name);
    expect(imported, `component '${app.metadata.name}' exists after the import`).toBeDefined();
    expect(
      (imported!.properties as { argocdApplication?: string }).argocdApplication,
      "the Argo CD Application name is recorded, so a binding's externalRef addresses the right app"
    ).toBe(app.metadata.name);

    // The half that makes the import COORDINATION rather than a catalogue entry.
    const bindings = await api.executors.listBindings(imported!.id);
    expect(bindings.length, `an executor binding for '${app.metadata.name}'`).toBeGreaterThan(0);
    expect(bindings.some((b) => b.externalRef === app.metadata.name)).toBe(true);
  }
});

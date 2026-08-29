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
  // The review step describes the proposal by TYPE and count rather than listing every object: the
  // per-object list belonged to the import flow, where each row was about to become a graph write.
  // Nothing here is about to be written, so what matters is that the proposal arrived intact and
  // is understood as components. The per-app naming assertion did not go away — it moved to step 4,
  // against the emitted SOURCE, which is the artifact that now carries the names.
  await expect(page.getByTestId("argocd-proposal-counts")).toHaveText(
    `${FAKE_ARGOCD_APPS.length} component`
  );

  // --- Step 4: SCAFFOLD, not import (ADR-0047) -------------------------------------------------
  //
  // This wizard used to end by clicking "accept", which wrote the proposal into the graph — the
  // path that made imported components RBAC orphans. It now asks which service each component
  // belongs to and emits IaC. The assertions below are the INVERSE of the ones they replace: the
  // old spec proved the components existed in the graph afterwards; this one proves they do NOT,
  // which is the guarantee the removal actually bought.
  await expect(page.getByTestId("argocd-scaffold-panel")).toBeVisible();
  await expect(page.getByTestId("argocd-scaffold-no-write-notice")).toBeVisible();

  // Every discovered component starts UNGROUPED and is named as such — the orphan problem surfaced
  // at authoring time, where a human is, instead of repaired afterwards.
  await expect(page.getByTestId("argocd-scaffold-ungrouped")).toBeVisible();

  const serviceName = `e2e-scaffold-${Date.now()}`;
  await page.getByTestId("argocd-scaffold-bulk-input").fill(serviceName);
  await page.getByTestId("argocd-scaffold-apply-all").click();

  // Grouped: the emitted source names every app, and the ungrouped warning is gone.
  const source = page.getByTestId("argocd-scaffold-source");
  await expect(source).toBeVisible();
  for (const app of FAKE_ARGOCD_APPS) {
    await expect(source).toContainText(app.metadata.name);
  }
  await expect(page.getByTestId("argocd-scaffold-ungrouped")).toHaveCount(0);

  // --- NOTHING WAS WRITTEN --------------------------------------------------------------------
  //
  // The load-bearing half. `POST /discovery/scaffold` renders text; the graph write happens only
  // when a human commits the code and runs `scp apply`. A wizard that quietly kept writing would
  // pass every assertion above.
  const { username, password } = adminCredentials();
  const api = new ScpClient({ baseUrl: apiBaseUrl() });
  await api.login(username, password);

  const components: GraphObject[] = [];
  let cursor: string | null = null;
  do {
    const batch = await api.object("component").list({ limit: 100, ...(cursor ? { cursor } : {}) });
    components.push(...batch.items);
    cursor = batch.nextCursor;
  } while (cursor);
  for (const app of FAKE_ARGOCD_APPS) {
    expect(
      components.find((c) => c.name === app.metadata.name),
      `component '${app.metadata.name}' must NOT exist — the wizard scaffolds, it does not import`
    ).toBeUndefined();
  }
});

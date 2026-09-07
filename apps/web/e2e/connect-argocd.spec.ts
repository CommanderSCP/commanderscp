import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { GraphObject } from "@scp/schemas";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";
import { FAKE_ARGOCD_APPS } from "./fake-argocd.js";

/** M19.1 — THE "CONNECT ARGO CD" WIZARD, END TO END. See docs/web.md §3. */
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

  await expect(page.getByTestId("connect-argocd-review")).toBeVisible();
  // The review step describes the proposal by type and count. See docs/web.md §4.
  await expect(page.getByTestId("argocd-proposal-counts")).toHaveText(
    `${FAKE_ARGOCD_APPS.length} component`
  );

  // --- Step 4: SCAFFOLD, not import. See docs/web.md §5.
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

  // Nothing was written, asserted after the refusal. See docs/web.md §6.
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

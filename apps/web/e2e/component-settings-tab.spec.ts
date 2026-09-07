import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ScpClient } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";

/** THE GENERIC REGISTRY DETAIL PAGE IS REACHABLE FOR COMPONENTS. See docs/web.md §2. */
test("a component's Settings tab reaches the generic registry detail, and deep-links", async ({
  page
}) => {
  await loginAsAdmin(page);

  const { username, password } = adminCredentials();
  const client = new ScpClient({ baseUrl: apiBaseUrl() });
  await client.login(username, password);
  const service = await client.services.create({ name: `settings-tab-svc-${randomUUID()}` });
  const componentName = `settings-tab-cmp-${randomUUID()}`;
  const component = await client.components.create({ name: componentName, service: service.id });

  // 1. The component's default view is its PIPELINE, with both tabs present.
  await page.goto(`${baseUrl()}/components/${component.id}`);
  await expect(page.getByTestId("component-name")).toHaveText(componentName);
  await expect(page.getByTestId("component-tabs")).toBeVisible();

  // 2. Settings reaches the generic detail — `object-name` is rendered ONLY by RegistryDetailPage.
  await page.getByTestId("component-tab-settings").click();
  await expect(page).toHaveURL(`${baseUrl()}/components/${component.id}/settings`);
  await expect(page.getByTestId("object-name")).toHaveText(componentName);
  await expect(
    page.getByRole("heading", { name: "Properties" }),
    "the ~570 lines this route un-orphans start with the properties/labels cards"
  ).toBeVisible();

  // 3. It is a real URL, not component state: a cold load lands on the same tab.
  await page.reload();
  await expect(page.getByTestId("object-name")).toHaveText(componentName);

  // 4. And the back button returns to the pipeline rather than leaving the component.
  await page.goBack();
  await expect(page).toHaveURL(`${baseUrl()}/components/${component.id}`);
  await expect(page.getByTestId("component-name")).toHaveText(componentName);
});

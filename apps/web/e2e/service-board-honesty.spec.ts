import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ScpClient, type ServiceBoardResponse } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";

/** The RENDERING half of the service board's federation-honesty rule. See docs/web.md §25. */

const REPLICA_CHANGE_ID = "5f6b4a2c-1d3e-4f8a-9b0c-2d4e6f8a0b1c";
const ORIGIN_DOMAIN_ID = "2c1d3e4f-5a6b-4c8d-9e0f-1a2b3c4d5e6f";

interface StubComponent {
  id: string;
  urn: string;
  name: string;
}

/** The exact board contract under test. See docs/web.md §26. */
function boardPayload(
  service: StubComponent,
  driven: StubComponent,
  replica: StubComponent
): ServiceBoardResponse {
  return {
    // outpost-ui.md §9.3a — the board's `service` block carries its own provenance now. This stub
    // is a SELF-maintained, shared service (the ordinary commander case); the outpost's
    // "commander upstream" shape is exercised by the pipeline-view tests, not this spec.
    service: {
      ...service,
      maintainedBy: { domainId: null, name: null, isSelf: true, role: null },
      domainLocal: false
    },
    rows: [
      {
        component: driven,
        latestChangeId: null,
        changeState: null,
        changeName: null,
        currentWave: null,
        waves: [],
        attention: {
          blocked: false,
          decisionId: null,
          awaitingApproval: false,
          emergency: false
        },
        activeFreeze: null,
        // A null driver means no latest change, not none anywhere. See docs/web.md §27.
        driver: { drivenHere: true, originDomainId: null },
        // Empty on purpose, not by omission: this spec owns the unknown-vs-observed distinction, and
        // per-pipeline chips have their own PR-gated coverage in
        // `src/routes/service-board-honesty.test.tsx`. `[]` claims "no pipelines", which is a fact the
        // renderer handles, rather than smuggling in pipeline state this test does not assert.
        pipelines: [],
        unknownFields: []
      },
      {
        component: replica,
        latestChangeId: REPLICA_CHANGE_ID,
        // Null AND declared unknown — the origin domain has not reported a lifecycle state here yet.
        changeState: null,
        changeName: "commander rollout",
        currentWave: null,
        waves: [],
        attention: {
          blocked: false,
          decisionId: null,
          awaitingApproval: false,
          emergency: false
        },
        activeFreeze: null,
        driver: { drivenHere: false, originDomainId: ORIGIN_DOMAIN_ID },
        pipelines: [],
        unknownFields: [
          "changeState",
          "currentWave",
          "waves",
          "attention.blocked",
          "attention.decisionId",
          "attention.awaitingApproval",
          "attention.emergency",
          "activeFreeze"
        ]
      }
    ],
    summary: { releasing: 0, blocked: 0, stable: 1, notDrivenHere: 1 },
    serviceFreeze: null,
    // Both new-in-#222 board-level fields, empty for the same reason as the per-row ones.
    servicePipelines: [],
    childAssemblies: [],
    // DESIGN §13's "as of" label. Null here on purpose: this stub is about the observed-vs-unknown
    // distinction, and a single-domain board legitimately has no upstream to label. The staleness
    // rendering has its own PR-gated coverage in `src/routes/service-board-honesty.test.tsx`.
    asOf: null,
    // A freeze crosses only if the declaring domain federated it. See docs/web.md §28.
    unknownFields: ["serviceFreeze", "rows[].activeFreeze"]
  };
}

async function stubBoard(
  page: Page,
  serviceId: string,
  payload: ServiceBoardResponse
): Promise<void> {
  await page.route(`**/api/v1/services/${serviceId}/board`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload)
    });
  });
}

test("service board: an unobservable field renders as an explicit unknown, never as a clean row", async ({
  page
}) => {
  const { username, password } = adminCredentials();
  const client = new ScpClient({ baseUrl: apiBaseUrl() });
  await client.login(username, password);

  // Real service + real components — the route, the id and the authz path are genuine. Names are
  // suffixed because URNs are unique per org and this suite runs against a long-lived, seeded stack.
  const suffix = randomUUID().slice(0, 8);
  const service = await client.services.create({ name: `board-honesty-${suffix}` });
  const driven = await client.components.create({
    name: `board-driven-${suffix}`,
    service: service.id
  });
  const replica = await client.components.create({
    name: `board-replica-${suffix}`,
    service: service.id
  });

  await loginAsAdmin(page);
  await stubBoard(
    page,
    service.id,
    boardPayload(
      { id: service.id, urn: service.urn, name: service.name },
      { id: driven.id, urn: driven.urn, name: driven.name },
      { id: replica.id, urn: replica.urn, name: replica.name }
    )
  );
  await page.goto(`${baseUrl()}/services/${service.id}/board`);

  await expect(page.getByTestId("board-table")).toBeVisible();
  const drivenRow = page.locator('[data-testid="board-row"][data-driven-here="true"]');
  const replicaRow = page.locator('[data-testid="board-row"][data-driven-here="false"]');
  await expect(drivenRow).toHaveCount(1);
  await expect(replicaRow).toHaveCount(1);

  await expect(replicaRow.getByTestId("board-not-driven-here")).toBeVisible();

  // 2. Every field the server declared unobservable renders the explicit marker — lifecycle state,
  //    current wave, wave strip and the attention cell (four cells, four markers).
  const markers = replicaRow.getByTestId("board-unknown");
  await expect(markers).toHaveCount(4);
  await expect(markers.first()).toHaveText("unknown here");

  // 3. ...and the row this instance DOES drive, whose empties are real observations, renders NO
  //    unknown marker — it keeps the muted dash. This is the whole point: the two must not look
  //    alike. Note the driven row's attention is all-false exactly like the replica's on the wire.
  await expect(drivenRow.getByTestId("board-unknown")).toHaveCount(0);
  await expect(drivenRow).toContainText("—");
  await expect(drivenRow.getByTestId("board-no-change")).toBeVisible();

  // 4. The fourth summary stat exists, counts the replica row, and is NOT dressed as a success.
  //    Asserted DIFFERENTIALLY against the Stable stat, which genuinely is `variant="success"` —
  //    otherwise this assertion would still pass if the success styling itself were renamed.
  const notDrivenStat = page.getByTestId("board-summary-not-driven-here");
  await expect(notDrivenStat).toContainText("1");
  // Target the BADGE itself (the innermost element carrying the text), not div-last — the
  // StatCard's internal div order is layout, not contract.
  const stableBadgeClass =
    (await page
      .getByTestId("board-summary-stable")
      .getByText("Stable", { exact: true })
      .getAttribute("class")) ?? "";
  const notDrivenBadgeClass =
    (await notDrivenStat.getByText("Not driven here", { exact: true }).getAttribute("class")) ?? "";
  // Six-tone system (docs/design-system.md): success = emerald tint, not the retired solid green.
  expect(stableBadgeClass, "premise: Stable really is the success variant").toContain(
    "bg-emerald-50"
  );
  expect(notDrivenBadgeClass).not.toContain("bg-emerald-50");

  // 5. The board-level freeze-visibility caveat. See docs/web.md §29.
  await expect(page.getByTestId("board-freeze-visibility-unknown")).toBeVisible();
});

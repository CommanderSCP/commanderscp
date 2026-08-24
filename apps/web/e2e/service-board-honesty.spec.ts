import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ScpClient, type ServiceBoardResponse } from "@scp/sdk";
import { adminCredentials, apiBaseUrl, baseUrl, loginAsAdmin } from "./fixtures.js";

/**
 * The RENDERING half of the service board's federation-honesty rule (apps/web/src/routes/
 * service-board.tsx, apps/server/src/coordination/service-board.ts).
 *
 * The server can name every field it cannot observe in `unknownFields` and still fail the operator
 * completely if the browser paints those placeholder zeros the same way it paints a real
 * observed-and-empty value. This spec is what stops that: it pins that an unobservable field renders
 * as an explicit "unknown here" marker, that an observed-and-empty field on the SAME board still
 * renders as the muted dash, and that the not-driven-here count is never dressed as a success.
 *
 * WHY THE BOARD RESPONSE IS STUBBED (`page.route`), unlike every other spec in this directory,
 * which drives real API writes. The distinction under test only appears when a row's change is a
 * READ-ONLY REPLICA of ANOTHER federation domain's — `objects.origin_domain_id` pointing at a peer.
 * That state is reachable only through a signed bundle import from a genuinely separate instance
 * (`importSyncBundle`); no public API this browser can call produces it, by design (single-writer
 * authority, DESIGN §13). The server-side behaviour is covered where it can be produced honestly —
 * on the real two-database federation topology, in
 * `apps/server/src/coordination/service-board-federation.integration.test.ts` and
 * `service-board-precedence.integration.test.ts`. What is left over, and what this spec owns, is
 * purely "given this contract, does the UI render the distinction" — so the contract is exactly what
 * is fed in. The service itself is real (created through the SDK, real route, real authz), so a
 * silently-failing intercept surfaces as a failing assertion rather than a false pass.
 */

const REPLICA_CHANGE_ID = "5f6b4a2c-1d3e-4f8a-9b0c-2d4e6f8a0b1c";
const ORIGIN_DOMAIN_ID = "2c1d3e4f-5a6b-4c8d-9e0f-1a2b3c4d5e6f";

interface StubComponent {
  id: string;
  urn: string;
  name: string;
}

/**
 * The exact board contract under test: one row this instance drives (observed-and-empty) and one it
 * does not (every detail field declared unobservable).
 *
 * TYPED AS THE REAL RESPONSE, and that annotation is the point. This builder and `stubBoard` were
 * both untyped (`payload: unknown`), so when #222 added three REQUIRED fields to
 * `ServiceBoardResponse` — `rows[].pipelines`, `servicePipelines`, `childAssemblies` — this stub kept
 * compiling while serving a payload the UI could no longer render. Typecheck could not see it, the
 * unit fixtures WERE typed so they were fixed, and this one was `main`-only so nothing caught it.
 * With the annotation, the next required field is a compile error in the "2. Static checks" job.
 */
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
        // `driver: null` means NO latest change to attribute to anyone, not "this domain drives
        // it" (fix(web) "qualify data-driven-here", src/routes/service-board.tsx) — that renders
        // "none", the third of three states. This row is genuinely locally-driven, so it needs an
        // explicit driver object to assert `data-driven-here="true"` (mirrors the `locallyDriven`
        // fixture in src/routes/service-board-honesty.test.tsx).
        driver: { drivenHere: true, originDomainId: null },
        // Empty on purpose, not by omission: this spec owns the unknown-vs-observed distinction, and
        // per-pipeline chips have their own PR-gated coverage in
        // `src/routes/service-board-honesty.test.tsx`. `[]` claims "no pipelines", which is a fact the
        // renderer handles, rather than smuggling in pipeline state this test does not assert.
        pipelines: [],
        // Nothing declared unknown: these empties ARE observations.
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
    // Board-level: a freeze crosses only if the domain that declared it federated it (M25.7, owner
    // decision D6), and that defaults off — so no row's "not frozen" is a statement about freezes
    // declared in another domain. This comment said "freezes never ride the sync journal" until D6
    // retracted that; the fixture VALUE is unchanged, because the caveat still fires unconditionally
    // on any peer, and the reason is corrected here rather than left stale in a green spec.
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

  // 1. The not-driven-here row is LABELLED as such.
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

  // 5. The board-level freeze-visibility caveat: a freeze crosses only if the domain that declared
  //    it federated it, and that defaults off (M25.7 / owner decision D6) — so an unfrozen row on a
  //    federated instance means "none VISIBLE here", not "none applies", for EVERY row alike.
  //
  //    THE SECOND COPY OF THE SAME CLAIM IN THIS FILE, and it survived the first pass of the M25.7
  //    census: the fixture comment at the top was corrected and this one was not, so the file
  //    asserted the retracted reasoning ("freezes never replicate") and its replacement at once. A
  //    per-file census that stops at the first hit is the same defect the project instructions name
  //    for a repo-wide one; the fix is to finish the file.
  await expect(page.getByTestId("board-freeze-visibility-unknown")).toBeVisible();
});

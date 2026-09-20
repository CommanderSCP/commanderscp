import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changes, decisions } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import type { GateDeps } from "./gates.js";

/** The gap PR #371 (b48b406d) deliberately left open: `advanceValidatingChanges` surfaces a target
 *  tombstoned while a change merely SITS in `validating`, but `POST /changes/:id/accept` itself —
 *  the human's active attempt to CLOSE that change — never re-derived or checked target liveness at
 *  all. This suite drives a change to `validating` exactly like
 *  `validating-target-liveness.integration.test.ts`, then calls the accept ROUTE (not a reconcile
 *  tick) after tombstoning the target, and never starts a background reconcile loop — same
 *  "competing consumer" avoidance as its sibling. See gates.ts's `evaluateLifecycleGate`. */
describe("POST /changes/:id/accept refuses to close a change onto a target that went dead in `validating`", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let inner: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "accept-liveness");
    sandbox = new CountingCelSandbox();
    // Same deterministic, no-real-clock setup as the `validating`-surfacing sibling test.
    inner = createInMemoryFakeHost({ autoSucceedAfterMs: 0 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  function inject(url: string, payload: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
  }

  async function injectOk(url: string, payload: Record<string, unknown>) {
    const res = await inject(url, payload);
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** The tombstone, taken THROUGH THE PUBLIC API by an authorized actor — same premise as both
   *  liveness sibling tests: a legitimate, permitted call the in-flight change does not otherwise
   *  refuse. */
  async function deleteComponentViaApi(componentId: string) {
    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/components/${componentId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    if (res.statusCode >= 300) {
      throw new Error(`DELETE component -> ${res.statusCode} ${res.body}`);
    }
  }

  function tickWith(host: PluginHost) {
    return reconcileOrgTick(
      server.deps.db,
      org.orgId,
      host,
      sandbox,
      server.deps.config.secretsMasterKey
    );
  }

  const changeRow = async (changeObjectId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return row!;
  };

  const decisionsFor = (changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, changeObjectId))
    );
  const auditFor = (changeObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeObjectId))
    );

  /** Walks a change all the way to `validating` — every wave succeeds against the live target
   *  BEFORE the caller ever tombstones anything, so a failure to reach `validating` here would be a
   *  test-setup bug, never the defect under test. Mirrors
   *  `validating-target-liveness.integration.test.ts`'s helper of the same shape. */
  async function changeReadyForValidating(
    label: string
  ): Promise<{ changeObjectId: string; targetObjectId: string }> {
    const service = await injectOk("/api/v1/services", { name: `svc-${label}` });
    const component = await injectOk("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });

    const gateDeps: GateDeps = { sandbox, host: inner };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "accept-liveness-test",
        name: `change-${label}`,
        targets: [component.id as string]
      });
      for (const toState of ["evaluated", "coordinated", "executing"] as const) {
        if (toState === "coordinated") {
          await compileAndPersistPlan(tx, {
            orgId: org.orgId,
            changeObjectId: change.id,
            targetObjectIds,
            topologyObjectId: null,
            topologyVersion: null
          });
        }
        await transitionChange(
          tx,
          {
            orgId: org.orgId,
            changeObjectId: change.id,
            toState,
            actorObjectId: org.orgId,
            requestId: "accept-liveness-test"
          },
          gateDeps
        );
      }
      return change.id;
    });

    for (let i = 0; i < 8; i++) {
      if ((await changeRow(changeObjectId)).state === "validating") break;
      await tickWith(inner);
    }
    const row = await changeRow(changeObjectId);
    if (row.state !== "validating") {
      throw new Error(
        `test setup: change ${changeObjectId} never reached validating (state=${row.state})`
      );
    }

    return { changeObjectId, targetObjectId: component.id as string };
  }

  // =============================================================================================
  // THE REPRODUCTION. Before the fix, this call returned 200 and the change closed as `accepted` —
  // a terminal, ostensibly-successful state — with no Decision or audit event naming the dead
  // target at all, regardless of whether a reconcile tick had already run.
  // =============================================================================================
  it("accept is refused (409, decision_id) when a target was tombstoned after every wave succeeded — the change stays `validating`, never `accepted`", async () => {
    const { changeObjectId, targetObjectId } = await changeReadyForValidating("dead");

    await deleteComponentViaApi(targetObjectId);

    // No reconcile tick runs here — the reproduction is the ROUTE's own check, not a race with the
    // background loop that `validating-target-liveness.integration.test.ts` already covers.
    const res = await inject(`/api/v1/changes/${changeObjectId}/accept`, {});
    expect(res.statusCode).toBe(409);
    const problem = res.json() as { decision_id?: string; detail?: string };
    expect(problem.decision_id).toBeTruthy();

    // Never closed: still `validating`, not the terminal `accepted` state.
    expect((await changeRow(changeObjectId)).state).toBe("validating");

    // A real, persisted block Decision on the SAME transition-guard path a freeze/policy block
    // already uses (transition.ts's `insertDecision`), carrying `target-liveness.ts`'s own prose —
    // the same summary/remediation vocabulary `advanceValidatingChanges`'s surfacing Decision uses.
    const blockDecision = (await decisionsFor(changeObjectId)).find(
      (d) => d.id === problem.decision_id
    );
    expect(blockDecision).toBeDefined();
    expect(blockDecision!.kind).toBe("transition");
    expect(blockDecision!.verdict).toBe("block");
    const gateContext = (blockDecision!.inputContext as { gate?: Record<string, unknown> }).gate;
    expect(gateContext).toMatchObject({
      targetObjectId,
      gate: "target_deleted",
      liveness: "deleted"
    });
    const gateReasonTree = (blockDecision!.reasonTree as { gate?: Record<string, unknown> }).gate;
    expect(String((gateReasonTree as { summary?: unknown })?.summary)).toContain("soft-deleted");
    expect(String((gateReasonTree as { remediation?: unknown })?.remediation)).toContain(
      "cancel or roll back"
    );

    // The standard guarded-transition block audit event, hash-chained, linked to that Decision.
    const event = (await auditFor(changeObjectId)).find(
      (e) => e.action === "change.transition.blocked" && e.decisionId === blockDecision!.id
    );
    expect(event).toBeDefined();
    expect(event!.rowHash).toEqual(expect.any(String));

    // `GET /changes/:id/explain` renders every Decision generically.
    const explain = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeObjectId}/explain`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(explain.statusCode).toBe(200);
    const explainBody = explain.json() as { decisions: { id: string }[] };
    expect(explainBody.decisions.some((d) => d.id === blockDecision!.id)).toBe(true);
  }, 180_000);

  it("SCOPE GUARD: accept on a LIVE target in `validating` is unchanged — 200, state becomes `accepted`, no block Decision", async () => {
    const { changeObjectId } = await changeReadyForValidating("live");

    const res = await inject(`/api/v1/changes/${changeObjectId}/accept`, {});
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state?: string }).state).toBe("accepted");
    expect((await changeRow(changeObjectId)).state).toBe("accepted");

    expect(
      (await decisionsFor(changeObjectId)).some(
        (d) => d.kind === "transition" && d.verdict === "block"
      )
    ).toBe(false);
  }, 180_000);
});

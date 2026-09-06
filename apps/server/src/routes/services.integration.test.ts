import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaves } from "../db/schema.js";
import { compileAndPersistPlan } from "../coordination/plan-service.js";

/**
 * Phase 2 coordination UI: the Service release board projection (GET /services/:idOrUrn/board,
 * docs/proposals/coordination-ui-views.md § "Service release board"). Pins the contract of the ONE
 * net-new server capability — "the latest change that targeted this component" — plus the Layer-A
 * projection around it: per-component latest-change waves, the releasing/blocked/stable summary, the
 * emergency + blocked attention signals (with the block Decision's id), and authz.
 *
 * Plans are compiled directly via the engine (`compileAndPersistPlan`), the same shortcut
 * coordination.integration.test.ts uses — a freshly-proposed change has no wave-target rows yet, and
 * the board's join keys off exactly those rows, so the test must materialize a plan to exercise it.
 */
describe("services: release board (Phase 2, Layer A)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "service-board");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Give a change a compiled plan (waves + wave-targets) for the given targets — what the board joins on. */
  const compilePlan = (changeId: string, targetIds: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: changeId,
        targetObjectIds: targetIds,
        topologyObjectId: null,
        topologyVersion: null
      })
    );

  it("lists every component; a targeted component shows its latest change + waves, an untargeted one shows none", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const compA = await createTestComponent(admin, { name: "checkout-api", service: svc.id });
    const compB = await createTestComponent(admin, { name: "billing-worker", service: svc.id });

    const change = await admin.changes.propose({ name: "ship checkout", targets: [compA.id] });
    await compilePlan(change.id, [compA.id]);

    const board = await admin.services.board(svc.id);

    expect(board.service.id).toBe(svc.id);
    expect(board.rows).toHaveLength(2);

    const rowA = board.rows.find((r) => r.component.id === compA.id)!;
    const rowB = board.rows.find((r) => r.component.id === compB.id)!;

    // The targeted component links to its change and carries the compiled waves.
    expect(rowA.latestChangeId).toBe(change.id);
    expect(rowA.changeState).toBe("proposed");
    expect(rowA.waves.length).toBeGreaterThan(0);
    expect(rowA.waves[0]!.targetCount).toBeGreaterThan(0);

    // The untargeted component has no active change and no waves.
    expect(rowB.latestChangeId).toBeNull();
    expect(rowB.changeState).toBeNull();
    expect(rowB.waves).toHaveLength(0);

    // Summary: A is in-flight (proposed) and unblocked → releasing; B → stable; nothing blocked.
    // Both changes are driven HERE (single-domain org), so nothing is unobservable.
    expect(board.summary).toEqual({ releasing: 1, blocked: 0, stable: 1, notDrivenHere: 0 });
    expect(rowA.driver).toEqual({ drivenHere: true, originDomainId: null });
    expect(rowA.unknownFields).toEqual([]);
    expect(rowB.driver).toBeNull();
  });

  it("resolves the service by URN as well as by id", async () => {
    const urn = `urn:scp:service-board:service:by-urn-${randomUUID().slice(0, 8)}`;
    const svc = await admin.services.upsertByUrn(urn, { name: "urn-addressed" });
    await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}`, service: svc.id });

    const board = await admin.services.board(urn);
    expect(board.service.id).toBe(svc.id);
    expect(board.rows).toHaveLength(1);
  });

  it("surfaces the emergency flag on the row", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "hotfix-target", service: svc.id });

    const change = await admin.changes.propose({
      name: "emergency ship",
      targets: [comp.id],
      emergency: true
    });
    await compilePlan(change.id, [comp.id]);

    const board = await admin.services.board(svc.id);
    const row = board.rows.find((r) => r.component.id === comp.id)!;
    expect(row.attention.emergency).toBe(true);
  });

  it("marks a row blocked (with the block reason surfaced) when a wave has failed", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const comp = await createTestComponent(admin, { name: "wedge", service: svc.id });

    const change = await admin.changes.propose({ name: "will fail", targets: [comp.id] });
    const plan = await compilePlan(change.id, [comp.id]);

    // Force the first wave into a terminal failure — the board derives `blocked` from a failed wave.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaves)
        .set({ status: "failed" })
        .where(and(eq(changeWaves.orgId, org.orgId), eq(changeWaves.id, plan.waves[0]!.id)))
    );

    const board = await admin.services.board(svc.id);
    const row = board.rows.find((r) => r.component.id === comp.id)!;
    expect(row.attention.blocked).toBe(true);
    expect(board.summary.blocked).toBe(1);
    expect(board.summary.releasing).toBe(0);
  });

  /**
   * REGRESSION (single-domain org — no federation anywhere in this test). An observed `blocked` must
   * never be displaced by a newer change this domain knows less about.
   *
   * THE DEFECT this pins: the board's two lookups — the wave-target join (a REAL local observation:
   * compiled plan, rolled waves, failed target) and the change-object `properties.targets` fallback
   * (which knows only that a change exists) — were merged by "whichever `created_at` is greater",
   * across two DIFFERENT timestamps (`changes.created_at` vs `objects.created_at`) that share no
   * clock. So proposing ANY newer change against the same component — with no plan compiled, nothing
   * executed, nothing observed — silently replaced the failed one, and `summary.blocked` fell to 0.
   * Every field the operator needs (waves, the failed count, the block signal) vanished with it, on
   * the commander's OWN board, for a release it is itself driving.
   *
   * The fix is a strict fallback: the planned arm is authoritative for any component it covers, and
   * the declared arm is consulted only for components it does not. There is no cross-clock
   * comparison left to get wrong.
   */
  it("REGRESSION: a newer unplanned change does NOT displace an older change's observed `blocked`", async () => {
    const suffix = randomUUID().slice(0, 8);
    const svc = await admin.services.create({ name: `svc-${suffix}` });
    const comp = await createTestComponent(admin, { name: `wedge-${suffix}`, service: svc.id });

    // Change A: proposed, planned, first wave forced to a terminal failure — a real observation.
    const changeA = await admin.changes.propose({
      name: `will fail ${suffix}`,
      targets: [comp.id]
    });
    const plan = await compilePlan(changeA.id, [comp.id]);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaves)
        .set({ status: "failed" })
        .where(and(eq(changeWaves.orgId, org.orgId), eq(changeWaves.id, plan.waves[0]!.id)))
    );

    const before = await admin.services.board(svc.id);
    expect(before.summary.blocked, "premise: the failure is observed before B exists").toBe(1);

    // Change B: NEWER, targets the same component, and has NO compiled plan — this domain has
    // observed nothing about it beyond its existence.
    const changeB = await admin.changes.propose({
      name: `next up ${suffix}`,
      targets: [comp.id]
    });
    expect(changeB.id).not.toBe(changeA.id);

    const after = await admin.services.board(svc.id);
    const row = after.rows.find((r) => r.component.id === comp.id)!;

    // The observation survives — asserted POSITIVELY, field by field: "blocked is still 1" alone
    // would also hold if the row had silently swapped to some other blocked change.
    expect(after.summary.blocked).toBe(1);
    expect(after.summary).toEqual({ releasing: 0, blocked: 1, stable: 0, notDrivenHere: 0 });
    expect(row.latestChangeId).toBe(changeA.id);
    expect(row.changeName).toBe(`will fail ${suffix}`);
    expect(row.attention.blocked).toBe(true);
    expect(row.waves.length).toBeGreaterThan(0);
    expect(row.waves.some((w) => w.status === "failed")).toBe(true);
    // Single-domain: every empty here is a real observation, nothing is declared unobservable.
    expect(row.driver).toEqual({ drivenHere: true, originDomainId: null });
    expect(row.unknownFields).toEqual([]);
  });

  it("404s an unknown service, 401s an unauthenticated caller, 403s a caller without read on the service", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });

    const missing = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${randomUUID()}/board`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(missing.statusCode, missing.body).toBe(404);

    const anon = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${svc.id}/board`
    });
    expect(anon.statusCode).toBe(401);

    // 403 — a subject scoped only to an unrelated object has no object:read on this service.
    const unrelated = await admin.services.create({ name: `other-${randomUUID().slice(0, 8)}` });
    const user = await createTestUser(server, org, [{ role: "Operator", scope: unrelated.id }]);
    const scoped = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    await expect(scoped.services.board(svc.id)).rejects.toMatchObject({ status: 403 });
  });
});

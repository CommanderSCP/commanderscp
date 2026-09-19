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
import { WAVE_TARGET_TOMBSTONED_AUDIT_ACTION } from "./target-liveness.js";
import type { GateDeps } from "./gates.js";

/** The `validating` half of "reconcile drove a target without asking if it existed" — see
 *  `wave-target-tombstoned.integration.test.ts` for the `executing`-path sibling this mirrors.
 *  Every wave has already succeeded by the time a change reaches `validating` (it is waiting on a
 *  human `scp change accept`), so there is no wave target left to re-trigger — only a signal to
 *  surface. See docs/coordination.md §755a/§755b. */
describe("a target tombstoned while its change sits in `validating` is surfaced, not silence", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let inner: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "validating-liveness");
    sandbox = new CountingCelSandbox();
    // `autoSucceedAfterMs: 0`: the fake executor reports `succeeded` on the very first poll after a
    // trigger, so the change reaches `validating` in a small, deterministic number of manual ticks —
    // no real-clock waiting, no reconcile loop running concurrently with this test's own ticks (see
    // the "reconcile loop as a competing consumer" hazard this suite deliberately avoids by never
    // starting one).
    inner = createInMemoryFakeHost({ autoSucceedAfterMs: 0 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  async function inject(url: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** The tombstone, taken THROUGH THE PUBLIC API by an authorized actor — same premise as the
   *  executing-path sibling test: a legitimate, permitted call the in-flight change does not
   *  otherwise refuse. */
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
   *  test-setup bug, never the defect under test. */
  async function changeReadyForValidating(
    label: string
  ): Promise<{ changeObjectId: string; targetObjectId: string }> {
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });

    const gateDeps: GateDeps = { sandbox, host: inner };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "validating-liveness-test",
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
            requestId: "validating-liveness-test"
          },
          gateDeps
        );
      }
      return change.id;
    });

    // Trigger -> poll-to-succeeded -> wave terminal -> executing->validating: at most one state
    // change per tick, so a handful of ticks is generous headroom, not a magic number.
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
  // THE REPRODUCTION / EXPLAINABILITY. Before the fix, nothing in this test file's target set
  // produced any signal at all — the change sat in `validating`, looking exactly like a healthy one
  // pending a human `scp change accept`.
  // =============================================================================================
  it("a target tombstoned in `validating` is surfaced: block Decision, hash-chained audit event, parked change, still `validating`", async () => {
    const { changeObjectId, targetObjectId } = await changeReadyForValidating("dead");

    await deleteComponentViaApi(targetObjectId);
    await tickWith(inner);

    // NOT auto-cancelled and NOT a new terminal state — surfacing is the goal, per the task brief.
    expect((await changeRow(changeObjectId)).state).toBe("validating");

    // The SAME vocabulary the executing path uses (`target-liveness.ts`'s one definition of "this
    // target is dead") — a block Decision an operator can resolve by id (charter principle 6).
    const blockDecision = (await decisionsFor(changeObjectId)).find(
      (d) => d.kind === "wave_target" && d.verdict === "block"
    );
    expect(blockDecision).toBeDefined();
    expect(blockDecision!.inputContext).toMatchObject({
      targetObjectId,
      gate: "target_deleted",
      liveness: "deleted"
    });
    expect(String((blockDecision!.reasonTree as { summary?: unknown }).summary)).toContain(
      "soft-deleted"
    );
    expect(String((blockDecision!.reasonTree as { remediation?: unknown }).remediation)).toContain(
      "cancel or roll back"
    );

    const event = (await auditFor(changeObjectId)).find(
      (e) => e.action === WAVE_TARGET_TOMBSTONED_AUDIT_ACTION
    );
    expect(event).toBeDefined();
    expect(event!.decisionId).toBe(blockDecision!.id);
    expect(event!.rowHash).toEqual(expect.any(String));

    // Parked — the same `reconcile_blocked_at` signal the executing path uses, so an operator (or
    // `scp change explain`) sees this change is no longer being actively reconciled.
    expect((await changeRow(changeObjectId)).reconcileBlockedAt).not.toBeNull();

    // `GET /changes/:id/explain` renders every Decision generically — no schema change needed for
    // this to show up there (item 4 of the task brief).
    const explain = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeObjectId}/explain`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(explain.statusCode).toBe(200);
    const explainBody = explain.json() as { decisions: { id: string }[] };
    expect(explainBody.decisions.some((d) => d.id === blockDecision!.id)).toBe(true);
  }, 180_000);

  it("ONCE ONLY: a later tick neither re-parks nor appends a second Decision or audit event", async () => {
    const { changeObjectId, targetObjectId } = await changeReadyForValidating("once");
    await deleteComponentViaApi(targetObjectId);

    await tickWith(inner);
    const decisionsAfterFirst = (await decisionsFor(changeObjectId)).length;
    const auditAfterFirst = (await auditFor(changeObjectId)).length;

    // `reconcile_blocked_at` filters this change out of every future `listChangeRowsInStates`
    // candidate set, `advanceValidatingChanges`'s own included — the durable backstop under the
    // `insertDecisionIfChanged`/`created`-gated audit write.
    await tickWith(inner);
    await tickWith(inner);
    await tickWith(inner);

    expect((await changeRow(changeObjectId)).state).toBe("validating");
    expect((await decisionsFor(changeObjectId)).length).toBe(decisionsAfterFirst);
    expect((await auditFor(changeObjectId)).length).toBe(auditAfterFirst);
  }, 180_000);

  it("SCOPE GUARD: a LIVE target in `validating` is untouched — no block Decision, never parked", async () => {
    // The check must refuse only a confirmed-dead target. Without this arm a liveness read that
    // always reported `live: false` would pass every other test in this file while parking every
    // change that ever reaches `validating`.
    const { changeObjectId } = await changeReadyForValidating("live");

    await tickWith(inner);
    await tickWith(inner);

    expect((await changeRow(changeObjectId)).state).toBe("validating");
    expect((await changeRow(changeObjectId)).reconcileBlockedAt).toBeNull();
    expect(
      (await decisionsFor(changeObjectId)).some(
        (d) => d.kind === "wave_target" && d.verdict === "block"
      )
    ).toBe(false);
  }, 180_000);
});

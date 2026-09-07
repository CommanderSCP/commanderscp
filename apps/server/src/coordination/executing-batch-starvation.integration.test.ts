import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, changeWaveTargets, decisions } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import type { GateDeps } from "./gates.js";

/** THE MEASURED PRODUCTION BUG. See docs/coordination.md §428. */

/** `BATCH_LIMIT` in reconcile.ts. Not exported — pinned here, and the guard test below fails loudly
 *  if the real one is ever raised above this without revisiting the fixture size. */
const ASSUMED_BATCH_LIMIT = 25;
/** Comfortably over the limit: 5 changes that can ONLY be served if the batch rotates. */
const PARKED_COUNT = 30;

describe("executing-batch starvation: >BATCH_LIMIT gate-blocked changes must not starve the queue behind them", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "exec-starvation");
    sandbox = new CountingCelSandbox();
    // Long auto-succeed: a target that does get triggered must sit durably in flight rather than
    // completing and moving its change out of `executing` mid-assertion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
    await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
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

  /** The production shape, trimmed: a component under a service, a `required` policy on that
   *  component whose one effect is an unsatisfiable `requireApprovals`, and a change walked by hand
   *  to `executing` with wave 0 still `pending` — so the first `reconcileOrgTick` is the first thing
   *  ever to evaluate its gate. Nobody votes, so it blocks on every evaluation, forever. */
  async function parkChangeInExecuting(label: string): Promise<string> {
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });
    await inject("/api/v1/policies", {
      name: `prod-gate-${label}`,
      urn: `urn:scp:${org.orgId}:policy:${label}`,
      properties: {
        scope: { objectRef: component.id as string },
        enforcement: "required",
        condition: "change.emergency == false",
        effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
      }
    });

    const gateDeps: GateDeps = { sandbox, host };
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "starvation-test",
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
            requestId: "starvation-test"
          },
          gateDeps
        );
      }
      return change.id;
    });
  }

  async function tick(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        sandbox,
        server.deps.config.secretsMasterKey
      );
    }
  }

  /** The set of those change ids that have had their wave gate evaluated at least once — i.e. that
   *  the engine has actually SERVED. This is the production symptom expressed as a query. */
  async function servedIds(ids: string[]): Promise<Set<string>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .selectDistinct({ subjectId: decisions.subjectId })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, "gate"),
            inArray(decisions.subjectId, ids)
          )
        )
    );
    return new Set(rows.map((r) => r.subjectId));
  }

  const parkedIds: string[] = [];

  it(`parks ${PARKED_COUNT} changes in 'executing' on an unsatisfiable gate (fixture)`, async () => {
    for (let i = 0; i < PARKED_COUNT; i++) {
      parkedIds.push(await parkChangeInExecuting(`s${String(i).padStart(2, "0")}`));
    }
    expect(parkedIds).toHaveLength(PARKED_COUNT);
    expect(PARKED_COUNT).toBeGreaterThan(ASSUMED_BATCH_LIMIT);

    // None has been served yet: the manual walk writes `transition` Decisions and zero `gate` ones.
    expect((await servedIds(parkedIds)).size).toBe(0);
  }, 300_000);

  it("ONE tick serves exactly BATCH_LIMIT of them — the cap is real, and this is what made the bug invisible below 25 parked changes", async () => {
    await tick(1);
    const served = await servedIds(parkedIds);
    // Pins BATCH_LIMIT itself. If someone raises it, this fails and points at PARKED_COUNT rather
    // than letting the suite silently stop covering the >limit case it exists for.
    expect(served.size).toBe(ASSUMED_BATCH_LIMIT);
  }, 120_000);

  it("THE REGRESSION: further ticks reach EVERY parked change — a blocked head must not own the batch forever", async () => {
    // Tick 1 (above) served the 25 oldest and bumped each to `now`, so the 5 never-served changes
    // are now the oldest by `reconcile_cursor_at` and lead the next batch. Three more ticks is generous
    // headroom for a 30/25 fixture; the assertion is on COVERAGE, not on a tick count.
    await tick(3);

    const served = await servedIds(parkedIds);
    const starved = parkedIds.filter((id) => !served.has(id));

    // WITHOUT THE FIX THIS IS THE FAILING LINE, and it fails the same way production did: the 5
    // changes queued behind the blocked head are never evaluated, no matter how many ticks run.
    expect(starved).toEqual([]);
    expect(served.size).toBe(PARKED_COUNT);
  }, 120_000);

  it("the blocked changes are still blocked, still in 'executing', and still un-parked — rotation must not be mistaken for progress", async () => {
    // The bump is a FAIRNESS mechanism, not a resolution one. See docs/coordination.md §429.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          objectId: changes.objectId,
          state: changes.state,
          blockedAt: changes.reconcileBlockedAt
        })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, parkedIds)))
    );

    expect(rows).toHaveLength(PARKED_COUNT);
    for (const row of rows) {
      expect(row.state).toBe("executing");
      expect(row.blockedAt).toBeNull();
    }
  }, 120_000);
});

/** THE SECOND SHAPE OF THE SAME PROPERTY. See docs/coordination.md §430. */
describe("executing-batch starvation, POLLING shape: >BATCH_LIMIT changes whose targets sit 'observing' must not starve the queue behind them", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "poll-starvation");
    sandbox = new CountingCelSandbox();
    // One hour, not sixty seconds, and that is load-bearing. See docs/coordination.md §431.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60 * 60_000 });
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

  /** A change walked by hand to `executing` with wave 0 still `pending` and NO policy anywhere near
   *  it — so the first tick's gate ALLOWS, the wave goes `running`, the target is triggered, and
   *  every tick after that is a pure status poll against an executor that never finishes. */
  async function changeExecutingAndPolling(label: string): Promise<string> {
    const service = await inject("/api/v1/services", { name: `svc-${label}` });
    const component = await inject("/api/v1/components", {
      name: `comp-${label}`,
      service: service.id
    });

    const gateDeps: GateDeps = { sandbox, host };
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "poll-starvation-test",
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
            requestId: "poll-starvation-test"
          },
          gateDeps
        );
      }
      return change.id;
    });
  }

  async function tick(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        sandbox,
        server.deps.config.secretsMasterKey
      );
    }
  }

  /** Which of these changes the engine has actually SERVED. A wave gate is evaluated exactly once
   *  per wave here (it allows, so `markWaveRunning` closes the branch), which makes the presence of
   *  a `gate` Decision a precise "this change was looked at at least once" flag — the same query
   *  the gate-blocked suite uses, reading the same signal from the opposite verdict. */
  async function servedIds(ids: string[]): Promise<Set<string>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .selectDistinct({ subjectId: decisions.subjectId })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, "gate"),
            inArray(decisions.subjectId, ids)
          )
        )
    );
    return new Set(rows.map((r) => r.subjectId));
  }

  /** Every wave-target status in this org, counted. The org holds nothing but this suite's changes,
   *  so this is the whole population without needing a join back through `change_waves`. */
  async function waveTargetStatusCounts(): Promise<Record<string, number>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ status: changeWaveTargets.status })
        .from(changeWaveTargets)
        .where(eq(changeWaveTargets.orgId, org.orgId))
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  const pollingIds: string[] = [];
  /** `state_entered_at` and `updated_at` as the fixture left them, per change — the watchdog's
   *  stall clock and the operator's "last modified". Captured before any tick so the last arm can
   *  prove the bump moved the CURSOR and nothing else. */
  const enteredAt = new Map<string, number>();
  const updatedAtBefore = new Map<string, number>();

  it(`parks ${PARKED_COUNT} changes in 'executing' with an allowing gate and a never-finishing executor (fixture)`, async () => {
    for (let i = 0; i < PARKED_COUNT; i++) {
      pollingIds.push(await changeExecutingAndPolling(`p${String(i).padStart(2, "0")}`));
    }
    expect(pollingIds).toHaveLength(PARKED_COUNT);
    expect(PARKED_COUNT).toBeGreaterThan(ASSUMED_BATCH_LIMIT);

    // Nothing has been served: the manual walk writes `transition` Decisions and zero `gate` ones.
    expect((await servedIds(pollingIds)).size).toBe(0);

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          objectId: changes.objectId,
          enteredAt: changes.stateEnteredAt,
          updatedAt: changes.updatedAt
        })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, pollingIds)))
    );
    for (const row of rows) {
      enteredAt.set(row.objectId, row.enteredAt.getTime());
      updatedAtBefore.set(row.objectId, row.updatedAt.getTime());
    }
    expect(enteredAt.size).toBe(PARKED_COUNT);
    expect(updatedAtBefore.size).toBe(PARKED_COUNT);
  }, 300_000);

  it("ONE tick serves exactly BATCH_LIMIT of them, and their gates ALLOWED — this is precisely the shape the gate-blocked bump does not cover", async () => {
    await tick(1);

    const served = await servedIds(pollingIds);
    expect(served.size).toBe(ASSUMED_BATCH_LIMIT);

    // Every gate here ALLOWED. If any of these blocked, this suite would be re-testing the
    // gate-blocked branch (which is already bumped) and would prove nothing about the poll path.
    const verdicts = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .selectDistinct({ verdict: decisions.verdict })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, "gate"),
            inArray(decisions.subjectId, pollingIds)
          )
        )
    );
    expect(verdicts.map((v) => v.verdict)).toEqual(["allow"]);

    // ...and the served changes really are on the polling path: their waves ran and their targets
    // were handed to the executor. Nothing is terminal, so nothing has freed a batch slot.
    const counts = await waveTargetStatusCounts();
    expect(counts.triggered).toBe(ASSUMED_BATCH_LIMIT);
    expect(counts.succeeded ?? 0).toBe(0);
    expect(counts.failed ?? 0).toBe(0);
  }, 120_000);

  it("THE REGRESSION: further ticks reach EVERY change — a head of merely-POLLING changes must not own the batch forever", async () => {
    await tick(3);

    const served = await servedIds(pollingIds);
    const starved = pollingIds.filter((id) => !served.has(id));

    // WITHOUT THE FIX THIS IS THE FAILING LINE. See docs/coordination.md §432.
    expect(starved).toEqual([]);
    expect(served.size).toBe(PARKED_COUNT);

    // The mechanism, pinned: these targets are being POLLED and are going nowhere. `observing` is
    // written only by the status-poll branch, so its presence proves the ticks above are exercising
    // that branch and not some terminalizing shortcut.
    const counts = await waveTargetStatusCounts();
    expect(counts.observing ?? 0).toBeGreaterThan(0);
    expect(counts.succeeded ?? 0).toBe(0);
    expect(counts.failed ?? 0).toBe(0);
  }, 120_000);

  it("rotation is not progress: every change is still 'executing', still un-parked, and BOTH operator clocks are untouched", async () => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          objectId: changes.objectId,
          state: changes.state,
          blockedAt: changes.reconcileBlockedAt,
          enteredAt: changes.stateEnteredAt,
          updatedAt: changes.updatedAt,
          cursorAt: changes.reconcileCursorAt
        })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), inArray(changes.objectId, pollingIds)))
    );

    expect(rows).toHaveLength(PARKED_COUNT);
    for (const row of rows) {
      expect(row.state).toBe("executing");
      // Same guarantee the gate-blocked suite's last arm protects: "fix" starvation by PARKING a
      // polling change and it stops being re-served, so its executor is never polled again and the
      // change never completes.
      expect(row.blockedAt).toBeNull();

      // THE BUMP LANDED, and on the cursor. Without this the arms above could pass for the wrong
      // reason — e.g. a fixture whose changes all terminalized and freed their slots — so the
      // mechanism is asserted directly and not only through its coverage consequence.
      expect(row.cursorAt.getTime()).toBeGreaterThan(row.enteredAt.getTime());

      // THE `state_entered_at` INVARIANT. `watchdog.ts` measures the `executing` stall SLA off
      // `state_entered_at`; if the round-robin bumped it too, a change whose executor polls forever
      // would look permanently fresh and would never be reported as stalled — the round-robin would
      // have bought fairness by disabling the one alarm that notices a change going nowhere.
      expect(row.enteredAt.getTime()).toBe(enteredAt.get(row.objectId));

      // THE `updated_at` INVARIANT. See docs/coordination.md §433.
      expect(row.updatedAt.getTime()).toBe(updatedAtBefore.get(row.objectId));
    }
  }, 120_000);
});

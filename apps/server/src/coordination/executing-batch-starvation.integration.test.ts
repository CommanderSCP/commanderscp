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

/**
 * THE MEASURED PRODUCTION BUG (live homelab k3s, read-only psql, 2026-08-01): coordination had been
 * COMPLETELY STOPPED for 13 days, behind green health checks, and nothing detected it.
 *
 * `advanceExecutingChanges` selects candidates with `listChangeRowsInStates(..., ["executing"],
 * BATCH_LIMIT)`, which is `ORDER BY reconcile_cursor_at ASC LIMIT 25` (it was `updated_at` when
 * this was measured; migration 0057 moved the round-robin onto its own column, and the property is
 * unchanged — see the note below). A change whose wave gate BLOCKS stays `executing` with its wave
 * `pending` and — deliberately, see reconcile.ts's persist-on-change comment — is never parked, so
 * that it keeps being re-served and re-evaluated (an approval granted elsewhere is noticed only by
 * re-evaluation). But nothing on that path writes the `changes` row, so its cursor never moves
 * again. Twenty-five such changes therefore pin every slot of every tick, permanently.
 *
 * The measurement, which is why this file exists:
 *
 *   band (ORDER BY the cursor)       count   cursor range                  has any gate Decision
 *   positions 1-25                      25   Jul 17 21:41 -> Jul 19 11:04   25 / 25
 *   positions 26+                      231   Jul 19 12:11 -> Aug  1 17:59    0 / 231
 *
 * 231 changes had NEVER BEEN EVALUATED ONCE. The cut is exact: the last wave target to dispatch
 * anywhere on that instance did so at 11:01 that morning, minutes before the 25th permanently
 * blocked change entered `executing` and sealed the queue. All 25 were blocked on one real,
 * un-approved prod policy — correct gate behaviour, trapping 231 unrelated changes behind it.
 *
 * WHY IT SURVIVED REVIEW: this exact hazard was already found and fixed for the `waiting` state
 * (`advanceWaitingChanges`, "STARVATION fix, coupled-pipelines.md §3.5 hazard"), using the same
 * round-robin bump. The fix was applied to the instance, not to the class — `executing` has the
 * identical re-serve-without-writing property and was left alone. `validating` is a third instance
 * (its loop only prewarms governance and never writes the change row); it is bumped now too, before
 * it can bite.
 *
 * MIGRATION 0057 MOVED THE COLUMN, NOT THE PROPERTY. The bumps now write `reconcile_cursor_at`
 * instead of `updated_at`, so that `Change.updatedAt` can stop reporting a gate-blocked change as
 * freshly updated on every tick of the week it spends blocked. This suite is re-pointed rather than
 * rewritten, because what it asserts — COVERAGE, that every parked change eventually gets a turn —
 * never named a column in the first place. That is why the arms below still fail on the unfixed
 * engine, which was re-verified by mutation rather than assumed.
 *
 * This suite is the permanent regression test. It is deliberately built around MORE THAN
 * BATCH_LIMIT parked changes, because at or below the limit the bug is invisible — which is exactly
 * why every pre-existing reconcile suite (all of which park one or a few changes, including
 * `decision-write-amplification.integration.test.ts`, whose `parkChangeOnApproval` this file's
 * builder is a trimmed copy of) stayed green while production was wedged.
 */

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
    // The bump is a FAIRNESS mechanism, not a resolution one. Every one of these changes is still
    // waiting on the same un-cast Owner approval; what changed is that they take turns. If a future
    // refactor "fixes" starvation by parking blocked changes instead, `reconcile_blocked_at` goes
    // non-null, `listChangeRowsInStates` filters them out, and they stop being re-evaluated — which
    // would mean an approval granted elsewhere never unblocks them. That is the failure this arm
    // exists to catch, and it is why the fix bumps rather than parks.
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

/**
 * THE SECOND SHAPE OF THE SAME PROPERTY — and the reason the suite above, which is a faithful
 * regression test for the measured outage, did not stop the bug from still being live.
 *
 * The gate-blocked bump fires on ONE branch: `activeWave.status === "pending"` and the gate said
 * block. The instant a gate ALLOWS, `markWaveRunning` moves the wave to `running`, and from then on
 * every tick of that change SKIPS the gate branch entirely and falls through to the per-target
 * loop. Every write down there lands on `change_wave_targets` or `change_waves`. NOTHING on that
 * path writes the `changes` row — there were exactly four `UPDATE changes` in reconcile.ts (the
 * `waiting` path, the `validating` path, the gate-blocked path and `recordStageDependencyHold`) and
 * not one of them was reachable from it.
 *
 * So a change whose targets are merely being POLLED froze its cursor at the instant it
 * entered `executing` and held a `BATCH_LIMIT` slot for as long as its executor kept answering
 * "still running". That is not an exotic state: it is an Argo CD Application sitting
 * `Progressing`, a workflow parked on a manual approval step, a sync waiting on an image that
 * never lands — anything whose `status()` does not terminalize. Twenty-six of those and the queue
 * behind them is dead, exactly as it was for 13 days on the homelab.
 *
 * WHY THE SUITE ABOVE MISSES IT: its fixture gives every change an unsatisfiable `requireApprovals`
 * policy, so its waves never leave `pending` and every one of its changes exercises the
 * gate-blocked branch. It could not have caught this if the bug had been introduced deliberately.
 * This suite is its complement: NO policy, so the gate allows, the wave runs, and the change lives
 * out its life on the polling path.
 */
describe("executing-batch starvation, POLLING shape: >BATCH_LIMIT changes whose targets sit 'observing' must not starve the queue behind them", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "poll-starvation");
    sandbox = new CountingCelSandbox();
    // ONE HOUR, not the 60s the suite above uses, and the difference is load-bearing.
    // `autoSucceedAfterMs` is the fake executor's only clock: a target that succeeds part-way
    // through this suite terminalizes its wave, completes its change, and FREES ITS BATCH SLOT — so
    // the queue behind it would drain and the suite would go green on the unfixed engine, for a
    // reason that has nothing to do with the round-robin. The fixture must model an executor that
    // never terminalizes, because that is the production case.
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

    // WITHOUT THE FIX THIS IS THE FAILING LINE. The 25 changes served by tick 1 are still in
    // `executing`, their targets are still `observing`, and nothing has written their `changes`
    // row since they entered the state — so `ORDER BY reconcile_cursor_at ASC LIMIT 25` hands back
    // the same 25 rows on every tick from here to the heat death of the instance, and the 5 behind
    // them are never evaluated once.
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

      // THE `updated_at` INVARIANT (migration 0057), and the arm that would have caught the split
      // being done backwards. These changes have been served, polled and bumped across four ticks
      // and NOTHING about them has changed: same state, same wave, same targets, same executor
      // answer. So the field an operator reads as "last modified" must be exactly where the fixture
      // left it. Before 0057 this assertion was impossible to write — `updated_at` WAS the cursor,
      // and this same loop moved it every tick.
      expect(row.updatedAt.getTime()).toBe(updatedAtBefore.get(row.objectId));
    }
  }, 120_000);
});

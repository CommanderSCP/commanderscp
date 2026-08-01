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
import { changes, decisions } from "../db/schema.js";
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
 * BATCH_LIMIT)`, which is `ORDER BY updated_at ASC LIMIT 25`. A change whose wave gate BLOCKS stays
 * `executing` with its wave `pending` and — deliberately, see reconcile.ts's persist-on-change
 * comment — is never parked, so that it keeps being re-served and re-evaluated (an approval granted
 * elsewhere is noticed only by re-evaluation). But nothing on that path writes the `changes` row,
 * so its `updated_at` never moves again. Twenty-five such changes therefore pin every slot of every
 * tick, permanently.
 *
 * The measurement, which is why this file exists:
 *
 *   band (ORDER BY updated_at ASC)   count   updated_at range              has any gate Decision
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
 * `updated_at` round-robin bump. The fix was applied to the instance, not to the class — `executing`
 * has the identical re-serve-without-writing property and was left alone. `validating` is a third
 * instance (its loop only prewarms governance and never writes the change row); it is bumped now
 * too, before it can bite.
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
    // are now the oldest by `updated_at` and lead the next batch. Three more ticks is generous
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

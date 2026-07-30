import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, changeWaves, decisions } from "../db/schema.js";
import {
  CountingCelSandbox,
  distinctDecisionStatements,
  partitionConditionErrors
} from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { proposeChange } from "./changes-repo.js";
import { transitionChange } from "./transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { buildServiceBoard } from "./service-board.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { castApprovalVote, listApprovalRequestsForChange } from "../governance/approvals-repo.js";
import type { GateDeps } from "./gates.js";

/**
 * THE MEASURED PRODUCTION BUG (live homelab k3s, read-only psql, 2026-07-29/30): `decisions` had
 * reached 12,327,844 rows / 15 GB and was growing ~1,079,900 rows (~1.44 GB) per day. 99.99% of the
 * table was ONE writer — `kind='gate', verdict='block'` across just 29 distinct `subject_id`s, all
 * `change` objects parked on a real `requireApprovals` policy (`fromRole: Owner`, scope
 * `organization`, `required_count: 1`) awaiting a human. Measured inter-arrival: 2.000 s per
 * subject. In one sampled hour, 39,175 of those rows collapsed to 25 distinct
 * `(subject_id, input_context, reason_tree)` tuples — 99.94% byte-identical restatements of an
 * unchanged verdict, ~1,567x duplication.
 *
 * This suite reproduces THAT shape — not a synthetic always-block seam — and pins all three halves
 * of the fix, because getting any one of them wrong is worse than the disk growth:
 *
 *  T1  N ticks over a parked change write exactly ONE `gate`/`block` Decision, AND the gate is
 *      still EVALUATED on every one of those N ticks (asserted via a real evaluation count, not
 *      just the row count — "evaluate less often" would make the row assertion pass while breaking
 *      the engine).
 *  T2  RESUMPTION: the approval lands, the very next tick writes a NEW Decision and the wave
 *      actually starts running. This is the test that proves the cadence was not slowed.
 *  T3  `decision_id` CONTINUITY (charter principle 6): while suppressed, the standing block
 *      Decision is still the one the operator-facing surface reports, still resolvable, still
 *      exactly one row in `scp change explain`'s chain.
 *
 * Drives `reconcileOrgTick` DIRECTLY (like `coordination.integration.test.ts`'s race suites) rather
 * than starting the pg-boss loop, so "N ticks" is exactly N and the counts are deterministic.
 */

/** The prod-shaped policy's condition. Real (a required policy that only fires for non-emergency
 *  changes), and — because a contributor `condition` is what makes `resolveFiredPolicies` call the
 *  sandbox — it doubles as the OBSERVABLE EVALUATION COUNTER T1 needs: one call per wave-gate
 *  evaluation, counted in the process, with no module mocking anywhere near the code under test. */
const POLICY_CONDITION = "change.emergency == false";

interface ParkedChange {
  changeObjectId: string;
  componentId: string;
  serviceId: string;
  waveId: string;
}

describe("Decision write amplification: a parked wave gate persists ON CHANGE, not once per tick", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;
  /** An Owner at the org root — eligible to satisfy the prod-shaped `requireApprovals` quorum. */
  let approver: { objectId: string };

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "decision-flood");
    sandbox = new CountingCelSandbox();
    // A long auto-succeed so a target that DOES get triggered (T2) sits durably in flight instead
    // of racing the assertions to completion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
    approver = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
  });

  afterAll(async () => {
    await sandbox.stop();
    await server.close();
  });

  async function inject(
    url: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /**
   * Builds EXACTLY the production shape: a component under a service, a `required` policy scoped to
   * that component whose single effect is `requireApprovals { count: 1, fromRole: Owner, scope:
   * organization }`, and a change walked to `executing` with wave 0 still `pending`. The walk is
   * manual (proposed -> evaluated -> coordinated -> executing, the edges `gates.ts` documents as
   * always-allow) so the very first `reconcileOrgTick` below is the first thing that has ever
   * evaluated this wave's gate.
   */
  async function parkChangeOnApproval(label: string): Promise<ParkedChange> {
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
        condition: POLICY_CONDITION,
        effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
      }
    });

    const gateDeps: GateDeps = { sandbox, host };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "decision-flood-test",
        name: `change-${label}`,
        targets: [component.id as string]
      });
      for (const toState of ["evaluated", "coordinated"] as const) {
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
            requestId: "decision-flood-test"
          },
          gateDeps
        );
      }
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "executing",
          actorObjectId: org.orgId,
          requestId: "decision-flood-test"
        },
        gateDeps
      );
      return change.id;
    });

    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeObjectId)
    );
    expect(plan?.waves[0]?.status).toBe("pending");

    // The gate has never been evaluated for this wave: the manual walk writes `transition`
    // Decisions, and ZERO `gate` ones.
    const before = await allGateDecisions(changeObjectId);
    expect(before).toHaveLength(0);

    return {
      changeObjectId,
      componentId: component.id as string,
      serviceId: service.id as string,
      waveId: plan!.waves[0]!.id
    };
  }

  /** Every `gate` Decision persisted for this change, oldest first — condition-error rows included. */
  function allGateDecisions(changeObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeObjectId),
            eq(decisions.kind, "gate")
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );
  }

  /**
   * The ORDINARY wave-gate verdicts, with the fail-closed condition-error statements split off and
   * their count returned alongside — see `partitionConditionErrors` for the measured reason this
   * suite cannot simply assert a raw row count (a CEL wall-clock miss on a loaded box makes the
   * production code CORRECTLY write a condition-error row AND, on the next tick, an ordinary one;
   * both writes are right, and asserting "exactly one row" against them is asserting the machine is
   * never busy — observed twice here with no injection).
   */
  async function gateDecisions(changeObjectId: string) {
    return partitionConditionErrors(await allGateDecisions(changeObjectId));
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

  it("T1: 20 ticks over a change parked on a requireApprovals policy write exactly ONE gate/block Decision — and evaluate the gate all 20 times", async () => {
    const parked = await parkChangeOnApproval("t1");
    const TICKS = 20;

    const evaluationsBefore = sandbox.countOf(POLICY_CONDITION);
    await tick(TICKS);

    // (a) THE FIX. Before it: 20 byte-identical rows (and 43,200/day in production). Now ONE — plus
    // at most one more per fail-closed condition-error row, which is the only extra statement a
    // loaded box can legitimately produce, and which must still be a RESTATEMENT of the same verdict
    // (asserted next) rather than something new that suppression lost.
    const { ordinary, conditionErrors } = await gateDecisions(parked.changeObjectId);
    expect(ordinary.length).toBeLessThanOrEqual(conditionErrors.length + 1);
    expect(distinctDecisionStatements(ordinary)).toBe(1);
    expect(ordinary[0]!.verdict).toBe("block");
    expect(JSON.stringify(ordinary[0]!.reasonTree)).toContain("prod-gate-t1");

    // (b) THE INVARIANT THE FIX MUST NOT BREAK (and the one a lazy "fix" would): the gate was
    // genuinely re-evaluated on EVERY tick. An arriving approval is noticed only here.
    expect(sandbox.countOf(POLICY_CONDITION) - evaluationsBefore).toBe(TICKS);

    // (c) The change was NOT parked to achieve this: it is still `executing` with
    // `reconcile_blocked_at` NULL (so it is still re-served next tick), and the wave is still
    // `pending` (so it is still re-gated). Parking it would trade this bug for a wedge.
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, parked.changeObjectId)))
    );
    expect(row!.state).toBe("executing");
    expect(row!.reconcileBlockedAt).toBeNull();
    const [wave] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaves).where(eq(changeWaves.id, parked.waveId))
    );
    expect(wave!.status).toBe("pending");
  });

  it("T3: while suppressed, the STANDING block Decision is still the one surfaced — same id, never null, exactly one row in the explain chain", async () => {
    const parked = await parkChangeOnApproval("t3");

    await tick(1);
    const first = (await gateDecisions(parked.changeObjectId)).ordinary[0]!;
    expect(first.id).toBeTruthy();

    await tick(10);

    // The id an operator is pointed at does not churn, and no row saying anything NEW appeared
    // behind it: still one standing statement (plus at most one restatement per condition-error row
    // — see `partitionConditionErrors`), and still the same first row.
    const after = await gateDecisions(parked.changeObjectId);
    expect(after.ordinary.length).toBeLessThanOrEqual(after.conditionErrors.length + 1);
    expect(distinctDecisionStatements(after.ordinary)).toBe(1);
    expect(after.ordinary[0]!.id).toBe(first.id);

    // The operator-facing surface (`GET /services/{id}/board` -> `attention.decisionId`, the
    // board's "blocked, and here is why" field) still reports THAT decision — charter principle 6's
    // "every blocked response carries a decision_id" is satisfied by the first block's row, not by
    // a fresh row per tick.
    const board = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const service = await getObjectByIdOrUrnAnyType(tx, org.orgId, parked.serviceId);
      return buildServiceBoard(tx, org.orgId, service);
    });
    const boardRow = board.rows.find((r) => r.component.id === parked.componentId);
    expect(boardRow?.attention.blocked).toBe(true);
    expect(boardRow?.attention.decisionId).toBe(first.id);
    expect(boardRow?.attention.awaitingApproval).toBe(true);

    // ...and `scp change explain` still reconstructs: the chain holds the transition Decisions plus
    // the standing block, FIRST in gate order — not 11 copies of it.
    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listDecisionsForSubject(tx, org.orgId, parked.changeObjectId)
    );
    const chainGate = partitionConditionErrors(chain.filter((d) => d.kind === "gate"));
    expect(chainGate.ordinary.length).toBeLessThanOrEqual(chainGate.conditionErrors.length + 1);
    expect(chainGate.ordinary[0]!.id).toBe(first.id);
    expect(chain.some((d) => d.kind === "transition")).toBe(true);
  });

  it("T2: the approval lands -> the very next tick writes a NEW Decision and the wave RUNS (suppression never delays resumption)", async () => {
    const parked = await parkChangeOnApproval("t2");

    await tick(5);
    const blocked = await gateDecisions(parked.changeObjectId);
    expect(blocked.ordinary.length).toBeLessThanOrEqual(blocked.conditionErrors.length + 1);
    expect(distinctDecisionStatements(blocked.ordinary)).toBe(1);
    expect(blocked.ordinary[0]!.verdict).toBe("block");

    // Satisfy the quorum the gate has been re-evaluating all along: one Owner-at-org vote on the
    // approval request the gate itself materialized.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const requests = await listApprovalRequestsForChange(tx, org.orgId, parked.changeObjectId);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.requiredCount).toBe(1);
      await castApprovalVote(tx, {
        orgId: org.orgId,
        approvalRequestId: requests[0]!.id,
        voterObjectId: approver.objectId,
        requestId: "decision-flood-test-vote"
      });
    });

    await tick(1);

    // A CHANGED VERDICT writes a new row — suppression keys on CONTENT, never on "we already wrote
    // one for this subject". Exactly ONE `allow`, appended after the standing block, whatever the
    // condition-error rows did in between.
    const after = await gateDecisions(parked.changeObjectId);
    const allows = after.ordinary.filter((d) => d.verdict === "allow");
    expect(allows).toHaveLength(1);
    expect(after.ordinary[after.ordinary.length - 1]!.id).toBe(allows[0]!.id);
    expect(allows[0]!.id).not.toBe(blocked.ordinary[0]!.id);

    // ...and the wave actually PROCEEDED: `markWaveRunning` ran on that same tick. This is what a
    // slowed/skipped evaluation would have broken (the change would sit blocked after its approval
    // landed — far worse than disk growth).
    const [wave] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaves).where(eq(changeWaves.id, parked.waveId))
    );
    expect(wave!.status).not.toBe("pending");

    // Ticking on past the allow does not restart the flood from the other side either: the allow
    // stands as one row (the wave is no longer `pending`, so nothing re-gates it).
    await tick(5);
    const settled = await gateDecisions(parked.changeObjectId);
    expect(settled.ordinary.filter((d) => d.verdict === "allow")).toHaveLength(1);
    expect(distinctDecisionStatements(settled.ordinary)).toBe(2);
  });
});

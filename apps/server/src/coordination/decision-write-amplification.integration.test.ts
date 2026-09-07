import { randomUUID } from "node:crypto";
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
import { auditEvents, changes, changeWaves, decisions } from "../db/schema.js";
import {
  CountingCelSandbox,
  distinctDecisionStatements,
  isConditionErrorReasonTree,
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

/** THE MEASURED PRODUCTION BUG. See docs/coordination.md §408. */

/** The prod-shaped policy's condition. Real (a required policy that only fires for non-emergency
 *  changes), and — because a contributor `condition` is what makes `resolveFiredPolicies` call the
 *  sandbox — it doubles as the OBSERVABLE EVALUATION COUNTER T1 needs: one call per wave-gate
 *  evaluation, counted in the process, with no module mocking anywhere near the code under test. */
const POLICY_CONDITION = "change.emergency == false";

/** A CEL condition that CANNOT BE EVALUATED. See docs/coordination.md §409. */
const BROKEN_POLICY_CONDITION = "change.typoed == true";

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

  /** Builds EXACTLY the production shape. See docs/coordination.md §410. */
  async function parkChangeOnApproval(
    label: string,
    condition: string = POLICY_CONDITION
  ): Promise<ParkedChange> {
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
        condition,
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

  /** Ordinary verdicts, with condition errors split off. See docs/coordination.md §411. */
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

  /** The fault that restored the bug with the fix in place. See docs/coordination.md §412. */
  it("T4: a policy whose CEL condition CANNOT BE EVALUATED writes ONE gate Decision over 15 ticks, not one per tick", async () => {
    const parked = await parkChangeOnApproval("t4", BROKEN_POLICY_CONDITION);
    const TICKS = 15;

    const evaluationsBefore = sandbox.countOf(BROKEN_POLICY_CONDITION);
    await tick(TICKS);

    const rows = await allGateDecisions(parked.changeObjectId);
    // Split off the CEL-TIMEOUT statements the same way the rest of the suite does — a timeout says
    // something genuinely different from "this identifier does not resolve", and a loaded box may
    // legitimately produce one. What must not grow is the PERMANENT fault's statement.
    const timedOut = rows.filter((r) => JSON.stringify(r.reasonTree).includes("timed out after"));
    const permanent = rows.filter((r) => !timedOut.includes(r));

    // (a) THE FIX. Before it: 15 rows, one per tick, forever. `<= timedOut.length + 1` is the same
    // load-independent bound T1/T2/T3 use; on a healthy run timedOut is empty and this is exactly 1.
    expect(permanent.length).toBeLessThanOrEqual(timedOut.length + 1);
    expect(distinctDecisionStatements(permanent)).toBe(1);
    expect(permanent[0]!.verdict).toBe("block");

    // (b) FAIL-CLOSED IS UNCHANGED — this is still the synthetic condition-error statement that
    // blocks, not a policy that quietly stopped applying because its condition was broken.
    expect(isConditionErrorReasonTree(permanent[0]!.reasonTree)).toBe(true);

    // (c) THE DIAGNOSIS SURVIVED, THE CONTEXT DUMP DID NOT — an operator can still see WHICH
    // identifier is wrong (charter principle 6); the Decision's own `input_context` summarizes the
    // gate's inputs, and the dropped dump was a per-tick-unstable restatement of them.
    const reasonTree = JSON.stringify(permanent[0]!.reasonTree);
    expect(reasonTree).toContain('Identifier \\"typoed\\" not found in context');
    expect(reasonTree).not.toContain("not found in context:"); // cel-js's dump always follows this

    // (d) THE INVARIANT THE FIX MUST NOT BREAK: the gate is still evaluated on every tick. A broken
    // condition is fixed by editing the POLICY, and only a re-evaluation notices that edit.
    expect(sandbox.countOf(BROKEN_POLICY_CONDITION) - evaluationsBefore).toBe(TICKS);

    // (e) ...and the change was not parked/wedged to achieve any of it.
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, parked.changeObjectId)))
    );
    expect(row!.state).toBe("executing");
    expect(row!.reconcileBlockedAt).toBeNull();
  });

  /** T5 — THE AUTO-CANCELLED CHANGE'S EPITAPH. See docs/coordination.md §413. */
  it("T5: a change auto-cancelled by a failed plan compile records WHICH object was missing — in both its Decision and its audit event", async () => {
    const service = await inject("/api/v1/services", { name: "svc-t5" });
    const component = await inject("/api/v1/components", {
      name: "comp-t5",
      service: service.id
    });

    // The shape `plan-service.ts` refuses with `notFound`: the change carries a release-topology
    // reference that no longer resolves (the topology object was deleted after the change was
    // proposed — `proposeChange` validates it at propose time, so this is exactly how it arises).
    // Written straight onto the `changes` row because that is where the reconciler reads it from.
    const missingTopologyId = randomUUID();
    const gateDeps: GateDeps = { sandbox, host };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "decision-flood-test",
        name: "change-t5",
        targets: [component.id as string]
      });
      await transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "evaluated",
          actorObjectId: org.orgId,
          requestId: "decision-flood-test"
        },
        gateDeps
      );
      await tx
        .update(changes)
        .set({ topologyObjectId: missingTopologyId })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)));
      return change.id;
    });

    await tick(1);

    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, changeObjectId)))
    );
    expect(row!.state).toBe("cancelled");

    // (a) THE DECISION. `scp change explain`'s account of why this change is dead.
    const transitions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeObjectId),
            eq(decisions.kind, "transition")
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );
    const cancelDecision = transitions.find(
      (d) => (d.inputContext as { toState?: string }).toState === "cancelled"
    );
    expect(cancelDecision).toBeDefined();
    const decisionReason = (cancelDecision!.inputContext as { reason: string }).reason;
    expect(decisionReason).toContain(missingTopologyId);
    expect(decisionReason).not.toBe("auto-cancelled: plan compilation failed — Not Found");

    // (b) THE AUDIT EVENT — the permanent, hash-chained half of the epitaph, which carries the same
    // text and can never be corrected later.
    const events = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.subjectId, changeObjectId)))
        .orderBy(auditEvents.seq)
    );
    const cancelEvent = events.find((e) => (e.reason ?? "").startsWith("auto-cancelled:"));
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.reason).toContain(missingTopologyId);
  });
});

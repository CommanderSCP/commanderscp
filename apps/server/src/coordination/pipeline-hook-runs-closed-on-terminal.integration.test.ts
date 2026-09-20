import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHookRuns } from "../db/schema.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import {
  ensureHookRunTriggered,
  listNonTerminalHookRuns,
  pollNonTerminalHookRuns
} from "./pipeline-hook-runs.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE SAME PROPERTY PR #373 closed for `approval_requests` ("state that outlives the change it
 *  belongs to when the change reaches a TERMINAL state"), one table over — flagged by #373's own
 *  census and deliberately left out of that PR's scope. `pipeline_hook_runs` left `pending`/
 *  `running` when their change is cancelled/rolled back never finish, and (before this fix) stayed
 *  on the poll driver's work list forever, spending a real executor `status()` call every reconcile
 *  tick on a change nothing can act on again. See `coordination/pipeline-hook-runs.ts`'s
 *  `closePipelineHookRunsForChange` doc and `coordination/transition.ts`. */
describe("pipeline hook runs close when their change reaches a terminal state", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    // `withPluginHost` is required: `ensureHookRunTriggered`/`pollNonTerminalHookRuns` both need a
    // real `PluginHost` to start the fake executor instance against. `withReconcileLoop` is
    // required too: the approval-gate park below only materializes an `approval_requests` row once
    // background reconcile actually advances the change — and `withReconcileLoop` is a NO-OP unless
    // `withEventRelay` is ALSO set (`startReconcileLoop`/`startWatchdogLoop` are nested inside
    // harness.ts's `if (opts.withEventRelay)` block; `governance.integration.test.ts`'s own
    // terminal-closure suite passes both for exactly this reason).
    server = await listenTestServer({
      withPluginHost: true,
      withEventRelay: true,
      withReconcileLoop: true
    });
    org = await createTestOrg(server, "hook-runs-close-on-cancel");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);
  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  const WORKFLOW = { repo: "acme/pipelines", branch: "main", path: "workflows/close.yaml" };

  /** A required-approval policy nobody ever votes on, so a proposed change parks indefinitely
   *  instead of racing this suite to a terminal SUCCESS state under background reconcile before the
   *  test gets to trigger/cancel it deterministically — the same control
   *  `governance.integration.test.ts`'s own terminal-closure suite uses. */
  async function parkWithApprovalGate(targetObjectId: string) {
    const suffix = `park-${label()}`;
    await admin.policies.create({
      name: suffix,
      urn: `urn:scp:${org.orgId}:policy:${suffix}`,
      properties: {
        scope: { objectRef: targetObjectId },
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId } }]
      }
    });
  }

  async function waitForApprovalRequest(changeId: string, timeoutMs = 25_000) {
    return waitUntil(
      async () => {
        const page = await admin.approvals.list({ changeId, limit: 20 });
        return page.items[0];
      },
      { describe: `approval request materialized for change ${changeId}`, timeoutMs }
    );
  }

  /** Binds a fake "test"-lane executor whose `.status()` reports `forcePhase` when polled — the
   *  same fixture `hook-run-test-lane.integration.test.ts` uses. */
  async function bindTestLane(subjectId: string, phase: "running" | "succeeded") {
    const pluginInstanceId = `fake-test-${label()}`;
    const externalRef = `run-${label()}`;
    await inOrg((tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: subjectId,
        pluginModule: "fake-executor",
        pluginInstanceId,
        externalRef,
        config: { forcePhase: { [externalRef]: phase } },
        actorObjectId: org.orgId,
        requestId: `close-mechanics-${label()}`,
        lane: "test"
      })
    );
    return pluginInstanceId;
  }

  function triggerCtx() {
    return {
      orgId: org.orgId,
      masterKey: server.deps.config.secretsMasterKey,
      host: server.deps.pluginHost!
    } as Parameters<typeof ensureHookRunTriggered>[1];
  }

  async function trigger(targetObjectId: string, changeObjectId: string, hookId: string) {
    return ensureHookRunTriggered(server.deps.db, triggerCtx(), {
      hook: { componentObjectId: targetObjectId, kind: "postDeploy", hookId, workflow: WORKFLOW },
      change: { objectId: changeObjectId },
      target: { objectId: targetObjectId },
      waveIndex: 0
    } as Parameters<typeof ensureHookRunTriggered>[2]);
  }

  async function runRowFor(hookId: string) {
    const rows = await inOrg((tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.hookId, hookId))
    );
    return rows[0]!;
  }

  it("cancelling a change with an open hook run closes it in the SAME transaction, on the SAME Decision, with one audit event — status is left untouched", async () => {
    const target = await createTestComponent(admin, { name: `close-mech-${label()}` });
    await parkWithApprovalGate(target.id);
    const change = await admin.changes.propose({
      name: `close-mech-change-${label()}`,
      targets: [target.id]
    });
    await waitForApprovalRequest(change.id);

    const hookId = `close-${label()}`;
    await bindTestLane(target.id, "running");
    await trigger(target.id, change.id, hookId);

    const before = await runRowFor(hookId);
    expect(before.status).toBe("running");
    expect(before.closedAt).toBeNull();

    const cancelled = await admin.changes.cancel(change.id, "close mechanics test");
    expect(cancelled.state).toBe("cancelled");

    const after = await runRowFor(hookId);
    // Untouched — no third status value on the wire, mirroring approval_requests.status staying
    // "pending" forever after closure (PR #373).
    expect(after.status).toBe("running");
    expect(after.closedAt).toBeTruthy();
    expect(after.closedReason).toBe("cancelled");

    const auditPage = await admin.auditEvents.list({ limit: 100 });
    const closeEvent = auditPage.items.find((e) => e.action === "pipeline_hook_runs.closed");
    expect(closeEvent).toBeDefined();
    expect(closeEvent!.subjectId).toBe(change.id);
    expect(closeEvent!.decisionId).toBeTruthy();

    // The SAME Decision the cancel transition itself recorded — not a second Decision for the same
    // event (the unbounded-Decision-growth incident).
    const explained = await admin.changes.explain(change.id);
    const cancelDecision = explained.decisions.find(
      (d) =>
        d.kind === "transition" &&
        d.verdict === "allow" &&
        (d.inputContext.toState as string) === "cancelled"
    );
    expect(cancelDecision).toBeDefined();
    expect(closeEvent!.decisionId).toBe(cancelDecision!.id);
  });

  it("a closed run is never polled again — no executor status() call, no state change", async () => {
    const target = await createTestComponent(admin, { name: `close-mech-poll-${label()}` });
    await parkWithApprovalGate(target.id);
    const change = await admin.changes.propose({
      name: `close-mech-poll-change-${label()}`,
      targets: [target.id]
    });
    await waitForApprovalRequest(change.id);

    const hookId = `poll-${label()}`;
    // Bound to `succeeded` — if the poll ever reaches this run after closure, its status and
    // `lastObservedAt` WOULD change. They must not.
    await bindTestLane(target.id, "succeeded");
    await trigger(target.id, change.id, hookId);

    await admin.changes.cancel(change.id, "poll mechanics test");
    const closed = await runRowFor(hookId);
    expect(closed.closedAt).toBeTruthy();
    expect(closed.lastObservedAt).toBeNull();

    // THE WORK-LIST ITSELF must exclude it — this is the "no wasted executor call" property. A
    // redundant DB-write guard inside `applyHookRunObservation` would otherwise let this same
    // assertion pass below even if the poll's candidate list still included the closed run (and
    // still spent a real `status()` call reaching that guard) — checking the list directly is what
    // catches that regression on its own.
    const candidates = await inOrg((tx) => listNonTerminalHookRuns(tx, org.orgId));
    expect(candidates.some((r) => r.id === closed.id)).toBe(false);

    await pollNonTerminalHookRuns(
      server.deps.db,
      triggerCtx() as Parameters<typeof pollNonTerminalHookRuns>[1]
    );

    const after = await runRowFor(hookId);
    // Still `running`, still un-observed — `listNonTerminalHookRuns` excluded it from the poll's
    // work list entirely, so the fake executor's `.status()` was never called for it.
    expect(after.status).toBe("running");
    expect(after.lastObservedAt).toBeNull();
  });

  it("cancelling one change's hook run never touches a different, still-live change's hook run", async () => {
    const targetA = await createTestComponent(admin, { name: `close-mech-a-${label()}` });
    const targetB = await createTestComponent(admin, { name: `close-mech-b-${label()}` });
    await parkWithApprovalGate(targetA.id);
    await parkWithApprovalGate(targetB.id);
    const changeA = await admin.changes.propose({
      name: `close-mech-a-change-${label()}`,
      targets: [targetA.id]
    });
    const changeB = await admin.changes.propose({
      name: `close-mech-b-change-${label()}`,
      targets: [targetB.id]
    });
    await waitForApprovalRequest(changeA.id);
    await waitForApprovalRequest(changeB.id);

    const hookA = `hookA-${label()}`;
    const hookB = `hookB-${label()}`;
    await bindTestLane(targetA.id, "running");
    await bindTestLane(targetB.id, "running");
    await trigger(targetA.id, changeA.id, hookA);
    await trigger(targetB.id, changeB.id, hookB);

    await admin.changes.cancel(changeA.id, "only A is going away");

    const closedA = await runRowFor(hookA);
    expect(closedA.closedAt).toBeTruthy();

    const liveB = await runRowFor(hookB);
    expect(liveB.closedAt).toBeNull();
    expect(liveB.closedReason).toBeNull();

    await admin.changes.cancel(changeB.id, "test cleanup");
  });

  it("ensureHookRunTriggered refuses to claim a hook run for an already-terminal change — no row is inserted", async () => {
    const target = await createTestComponent(admin, { name: `close-mech-refuse-${label()}` });
    await parkWithApprovalGate(target.id);
    const change = await admin.changes.propose({
      name: `close-mech-refuse-change-${label()}`,
      targets: [target.id]
    });
    await waitForApprovalRequest(change.id);
    await admin.changes.cancel(change.id, "terminal before any trigger");

    const hookId = `refuse-${label()}`;
    await bindTestLane(target.id, "running");

    await expect(trigger(target.id, change.id, hookId)).rejects.toThrow(
      /terminal state 'cancelled'/
    );

    // Unreachable in production (the reconciler only selects live-state changes), but the guard
    // must never let a claim land: a fresh row for a change nothing will ever close again.
    const rows = await inOrg((tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.hookId, hookId))
    );
    expect(rows).toHaveLength(0);
  });
});

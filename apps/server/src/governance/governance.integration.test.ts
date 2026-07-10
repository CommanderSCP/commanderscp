import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Governance engine integration suite (BUILD_AND_TEST.md §8 M4 DoD, Testcontainers postgres:16):
 * everything the unit suite (policy-model.test.ts, evaluate.test.ts, cel-sandbox.test.ts) can't
 * reach because it needs a real graph (containment, `member_of`), a real subprocess plugin host
 * (webhook-control, fake-executor), and the real gate seam (coordination/gates.ts) wired through
 * the real HTTP API. Every scenario drives the public API via `@scp/sdk`'s `ScpClient`, exactly
 * like a real caller — this is deliberately NOT a white-box test of governance/*.ts's internals
 * (those are the unit suite's job).
 *
 * Most scenarios share ONE server (module-level `beforeAll`/`afterAll`) — real Postgres, real
 * outbox relay, real reconcile loop, real subprocess plugin host — to amortize boot cost, same
 * pattern as coordination.integration.test.ts. The automatic-rollback scenario gets its own server
 * because it needs `FakeExecutorConfig.forcePhase` pre-configured at plugin-instance boot time for
 * specific, test-known target object ids (harness.ts's `fakeExecutorConfig` passthrough, added for
 * exactly this).
 */

// -----------------------------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------------------------

interface TestWebhookServer {
  url: string;
  close(): Promise<void>;
}

/** A real HTTP server on loopback (never the internet — BUILD_AND_TEST.md's "tests never touch
 *  the internet" is about egress off the test host, not inter-process loopback calls the way
 *  Testcontainers Postgres itself already is) that `@scp/plugin-webhook-control` — running for
 *  real inside a spawned subprocess — POSTs to. Responds with whatever `ControlOutcomeStatus` the
 *  caller asked for via the `x-test-outcome` request header (set per `control_bindings.config`),
 *  so ONE server fixture can back many differently-configured control bindings across many tests. */
async function startTestWebhookServer(): Promise<TestWebhookServer> {
  const server = createServer((req, res) => {
    const outcome = (req.headers["x-test-outcome"] as string | undefined) ?? "pass";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let controlId: string | null = null;
      try {
        controlId = (JSON.parse(raw || "{}") as { controlId?: string }).controlId ?? null;
      } catch {
        // malformed body — evidence just omits controlId, not a test failure
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: outcome, evidence: { via: "test-webhook", controlId } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw an ScpApiError, but it completed successfully");
}

interface PolicyEffectsInput {
  requireControlIds?: string[];
  requireApprovals?: { count: number; fromRole: string; scope: string };
}

interface CreatePolicyOpts extends PolicyEffectsInput {
  name: string;
  urnSuffix: string;
  enforcement: "advisory" | "recommended" | "required";
  scopeObjectId?: string;
  scopeGroupId?: string;
  condition?: string;
  emergencyPolicy?: boolean;
  autoRollbackOnFailure?: boolean;
}

/** A `policy`-typed graph object (DESIGN §10.1) via the real typed-registry API — every test below
 *  builds its policy documents this way rather than poking the DB directly, so the Ajv property
 *  validation path (0010_governance.sql's JSON Schema) is exercised too. */
async function createPolicy(admin: ScpClient, org: TestOrg, opts: CreatePolicyOpts) {
  const effects: Record<string, unknown>[] = [];
  if (opts.requireControlIds && opts.requireControlIds.length > 0) {
    effects.push({ requireControls: opts.requireControlIds });
  }
  if (opts.requireApprovals) {
    effects.push({ requireApprovals: opts.requireApprovals });
  }
  const scope = opts.scopeObjectId
    ? { objectRef: opts.scopeObjectId }
    : opts.scopeGroupId
      ? { group: opts.scopeGroupId }
      : undefined;
  return admin.policies.create({
    name: opts.name,
    urn: `urn:scp:${org.orgId}:policy:${opts.urnSuffix}`,
    properties: {
      ...(scope ? { scope } : {}),
      enforcement: opts.enforcement,
      ...(opts.condition ? { condition: opts.condition } : {}),
      effects,
      ...(opts.emergencyPolicy !== undefined ? { emergencyPolicy: opts.emergencyPolicy } : {}),
      ...(opts.autoRollbackOnFailure !== undefined ? { autoRollbackOnFailure: opts.autoRollbackOnFailure } : {})
    }
  });
}

/** A real `control` graph object bound to the real `webhook-control` plugin (DESIGN §10.2's
 *  escape hatch), pointed at `startTestWebhookServer()`'s fixture with a fixed canned outcome —
 *  the ONE real ControlPlugin module `governance/control-runner.ts` will provision a subprocess
 *  instance for (see its `KNOWN_CONTROL_MODULES` doc comment). */
async function createWebhookControl(
  admin: ScpClient,
  org: TestOrg,
  opts: { urnSuffix: string; webhookUrl: string; outcome: string }
) {
  const control = await admin.controls.create({
    name: `control-${opts.urnSuffix}`,
    urn: `urn:scp:${org.orgId}:control:${opts.urnSuffix}`,
    properties: { category: "security" }
  });
  await admin.controls.putBinding(control.id, {
    pluginModule: "webhook-control",
    pluginInstanceId: `wh-${control.id}`,
    config: { url: opts.webhookUrl, headers: { "x-test-outcome": opts.outcome } }
  });
  return control;
}

async function waitForValidating(admin: ScpClient, changeId: string, timeoutMs = 25_000) {
  return waitUntil(async () => (await admin.changes.get(changeId)).state === "validating" || undefined, {
    describe: `change ${changeId} reaches 'validating'`,
    timeoutMs
  });
}

/** A required policy scoped directly to a change's own (single) target ALSO gates that target's
 *  wave boundary, not just the `validating->promoted` lifecycle edge (coordination/gates.ts's
 *  module doc: every wave boundary is real-governance-evaluated in M4, unlike most other
 *  lifecycle edges) — so `requireControls`/`requireApprovals` effects on such a policy resolve
 *  (control runs for real; approval requests materialize) from wave 0's FIRST gate check, well
 *  before — and independently of — the change ever reaching `validating`. This is the right place
 *  to wait for an approval request in tests below, instead of `waitForValidating` (which the wave
 *  gate blocking would make this policy's own approval/control effects prevent from ever firing). */
async function waitForApprovalRequest(admin: ScpClient, changeId: string, timeoutMs = 25_000) {
  return waitUntil(
    async () => {
      const page = await admin.approvals.list({ changeId, limit: 20 });
      return page.items[0];
    },
    { describe: `approval request materialized for change ${changeId}`, timeoutMs }
  );
}

async function waitForControlRun(
  admin: ScpClient,
  changeId: string,
  controlId: string,
  status: string,
  timeoutMs = 25_000
) {
  return waitUntil(
    async () => {
      const runs = await admin.controlRuns.listForChange(changeId);
      const run = runs.items.find((r) => r.controlObjectId === controlId);
      return run?.status === status ? run : undefined;
    },
    { describe: `control ${controlId} run on change ${changeId} reports '${status}'`, timeoutMs }
  );
}

/** Asserts a change has NOT progressed past `executing` after a grace period long enough for
 *  several reconcile ticks (1s interval) to have had their chance — the direct way to observe "the
 *  wave stayed blocked" without racing the reconcile loop's own timing. */
async function assertStaysExecuting(admin: ScpClient, changeId: string, graceMs = 3_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  const change = await admin.changes.get(changeId);
  expect(change.state).toBe("executing");
}

// -----------------------------------------------------------------------------------------

describe("governance integration (real graph, real subprocess plugin host)", () => {
  let server: ListeningTestServer;
  let webhook: TestWebhookServer;

  beforeAll(async () => {
    webhook = await startTestWebhookServer();
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 15_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
  });

  afterAll(async () => {
    await server.close();
    await webhook.close();
  });

  // -----------------------------------------------------------------------------------------
  // Stricter-wins resolution matrix (org/domain/service/component conflicts) — real containment
  // walk (policy-resolve.ts) + real merge (policy-model.ts), through `scp policy evaluate`'s
  // dry-run endpoint. The pure-merge algorithm itself is exhaustively table/property-tested in
  // policy-model.test.ts; this proves the DB-driven "gather" half actually feeds it correctly.
  // -----------------------------------------------------------------------------------------

  it("resolves a 4-level org->domain->service->component chain: required wins over an attempted domain-level weaken, controls union, non-sibling policies never leak in", async () => {
    const org = await createTestOrg(server, "stricter-wins");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "sw-domain" });
    const siblingDomain = await admin.domains.create({ name: "sw-sibling-domain" });
    const service = await admin.services.create({ name: "sw-service", domainId: domain.id });
    const component = await admin.components.create({ name: "sw-component", domainId: service.id });

    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "org",
      enforcement: "required",
      scopeObjectId: org.orgId,
      requireControlIds: ["org-control"]
    });
    await createPolicy(admin, org, {
      // Attempts to WEAKEN the org-level 'required' down to 'advisory' at the domain level — must
      // never succeed (policy-model.ts's "no weaken effect exists in this schema").
      name: "prod-security",
      urnSuffix: "domain",
      enforcement: "advisory",
      scopeObjectId: domain.id,
      requireControlIds: ["domain-control"]
    });
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "service",
      enforcement: "recommended",
      scopeObjectId: service.id,
      requireControlIds: ["service-control"]
    });
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "component",
      enforcement: "required",
      scopeObjectId: component.id,
      requireControlIds: ["component-control"]
    });
    // A policy scoped to a SIBLING domain (not in component's containment chain) must never match.
    await createPolicy(admin, org, {
      name: "unrelated-sibling-policy",
      urnSuffix: "sibling",
      enforcement: "required",
      scopeObjectId: siblingDomain.id,
      requireControlIds: ["sibling-control"]
    });

    const change = await admin.changes.propose({ name: "sw-change", targets: [component.id] });
    const result = await admin.policyEvaluate(change.id);

    const policies = (result.reasonTree as { policies: Array<Record<string, unknown>> }).policies;
    expect(policies.some((p) => p.name === "unrelated-sibling-policy")).toBe(false);

    const entry = policies.find((p) => p.name === "prod-security");
    expect(entry).toBeDefined();
    expect(entry!.enforcement).toBe("required"); // never weakened by the domain-level 'advisory'

    const controlIds = (entry!.effects as Array<{ kind: string; detail: Record<string, unknown> }>)
      .filter((e) => e.kind === "requireControls")
      .map((e) => e.detail.controlObjectId as string)
      .sort();
    expect(controlIds).toEqual(["component-control", "domain-control", "org-control", "service-control"]);
    expect((entry!.contributingPolicyVersions as unknown[]).length).toBe(4);

    // Required + none of the 4 controls has ever run -> blocks (fails closed, never a silent pass).
    expect(result.verdict).toBe("block");

    // This change's `requireControls` reference synthetic (non-object) ids on purpose — this test
    // only cares about resolution, never about a real control actually running — so its
    // wave-boundary gate can never satisfy them. Cancel it rather than leaving it to occupy the
    // shared reconcile loop's every-tick attention (and the resulting per-tick 'blocked' Decision
    // inserts) for the remaining lifetime of this describe block's server.
    await admin.changes.cancel(change.id, "test cleanup: resolution-only fixture, never meant to execute");
  });

  // -----------------------------------------------------------------------------------------
  // Required control blocks promote; hybrid gate (scan AND approval — either missing blocks);
  // control outcomes + evidence persisted and referenced by the Decision (joined by
  // controlObjectId — see routes/changes.ts's explain handler / control_runs.decision_id's own
  // doc comment for why there's no raw FK).
  // -----------------------------------------------------------------------------------------

  describe("required control + hybrid gate (scan AND approval)", () => {
    it("hybrid: the control failing blocks the wave even though the approval is already satisfied — the change never leaves 'executing'", async () => {
      const org = await createTestOrg(server, "hybrid-control-fails");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
      const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });

      const target = await admin.components.create({ name: "hybrid-fail-target" });
      const control = await createWebhookControl(admin, org, {
        urnSuffix: "hybrid-fail-scan",
        webhookUrl: webhook.url,
        outcome: "fail"
      });
      await createPolicy(admin, org, {
        name: "hybrid-release",
        urnSuffix: "hybrid-fail",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id],
        requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
      });

      const change = await admin.changes.propose({ name: "hybrid-fail-change", targets: [target.id] });

      // Satisfy the approval half up front — materializes from wave 0's own gate check, not from
      // 'validating' (see waitForApprovalRequest's doc comment).
      const approvalRequest = await waitForApprovalRequest(admin, change.id);
      await approverClient.approvals.vote(approvalRequest.id);
      const quorum = await admin.approvals.get(approvalRequest.id);
      expect(quorum.status).toBe("satisfied");

      // The control genuinely runs (real subprocess, real webhook POST) and reports 'fail'.
      await waitForControlRun(admin, change.id, control.id, "fail");

      // Approval satisfied, control failing -> hybrid still blocks: the wave can never start, so
      // the change can never even reach 'validating' for a 'promote' call to be a meaningful
      // re-test of this same gate — the wave's own blocked gate Decision is the real assertion.
      await assertStaysExecuting(admin, change.id);

      const explained = await admin.changes.explain(change.id);
      const gateBlock = explained.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
      expect(gateBlock).toBeDefined();
      const policyEntry = (
        (gateBlock!.reasonTree as { policies?: Array<Record<string, unknown>> }).policies ?? []
      ).find((p) => p.name === "hybrid-release");
      expect(policyEntry).toBeDefined();
      const controlEffect = (
        policyEntry!.effects as Array<{ kind: string; satisfied: boolean; detail: Record<string, unknown> }>
      ).find((e) => e.kind === "requireControls");
      expect(controlEffect?.satisfied).toBe(false);
      expect(controlEffect?.detail.outcome).toBe("fail");
    });

    it("hybrid: the control passing is not enough on its own — approval still gates promote; once both are satisfied promote succeeds and evidence is explainable", async () => {
      const org = await createTestOrg(server, "hybrid-approval-gates");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
      const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });

      const target = await admin.components.create({ name: "hybrid-pass-target" });
      const control = await createWebhookControl(admin, org, {
        urnSuffix: "hybrid-pass-scan",
        webhookUrl: webhook.url,
        outcome: "pass"
      });
      await createPolicy(admin, org, {
        name: "hybrid-release",
        urnSuffix: "hybrid-pass",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id],
        requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
      });

      const change = await admin.changes.propose({ name: "hybrid-pass-change", targets: [target.id] });

      const approvalRequest = await waitForApprovalRequest(admin, change.id);
      // The control passes, but no approval has been cast yet -> the wave stays blocked, so the
      // change stays 'executing' (not 'validating' — see waitForApprovalRequest's doc comment).
      await waitForControlRun(admin, change.id, control.id, "pass");
      await assertStaysExecuting(admin, change.id);

      // Cast the approval — now both halves are satisfied; the wave's NEXT gate check unblocks
      // it, it executes for real against the fake executor, and the change naturally reaches
      // 'validating' on its own.
      await approverClient.approvals.vote(approvalRequest.id);
      await waitForValidating(admin, change.id);

      const promoted = await admin.changes.promote(change.id);
      expect(promoted.state).toBe("promoted");

      // "scp change explain reconstructs policy version + control outcome + evidence" (flagship
      // E2E's own phrasing, BUILD_AND_TEST.md §8 M4): the allow Decision's reasonTree carries the
      // policy version + outcome status; the evidence payload is only ever on controlRuns, joined
      // by controlObjectId.
      const explained = await admin.changes.explain(change.id);
      const allowDecision = explained.decisions.find(
        (d) => d.kind === "transition" && d.verdict === "allow" && (d.inputContext.toState as string) === "promoted"
      );
      expect(allowDecision).toBeDefined();
      // transition.ts: `decision.reasonTree = { summary, gate: gate.reasonTree }` — the per-policy
      // detail (name/enforcement/effects/contributingPolicyVersions) lives on the GATE'S reasonTree
      // (evaluate.ts's `GovernanceEvaluationResult.reasonTree.policies`), nested under `gate` here;
      // `inputContext.gate` (gate-orchestrator.ts's `GateOutcome.inputContext`) is a different,
      // coarser object (matchedPolicyCount/effectivePolicyCount) with no `policies` array at all.
      const gateReasonTree = (allowDecision!.reasonTree as { gate?: { policies?: Array<Record<string, unknown>> } })
        .gate;
      const policyEntry = gateReasonTree?.policies?.find((p) => p.name === "hybrid-release");
      expect(policyEntry).toBeDefined();
      expect((policyEntry!.contributingPolicyVersions as Array<{ policyObjectId: string }>)[0]?.policyObjectId).toBe(
        (await admin.policies.get(`urn:scp:${org.orgId}:policy:hybrid-pass`)).id
      );

      const controlRunEntry = explained.controlRuns.find((r) => r.controlObjectId === control.id);
      expect(controlRunEntry).toBeDefined();
      expect(controlRunEntry!.status).toBe("pass");
      expect(controlRunEntry!.evidence).toMatchObject({ via: "test-webhook" });
    });
  });

  // -----------------------------------------------------------------------------------------
  // N-of-M approval quorum integrity: no double-vote, no non-member vote, satisfied only once
  // quorum is genuinely reached — SECURITY-SENSITIVE surface.
  // -----------------------------------------------------------------------------------------

  it("N-of-M quorum: rejects a non-member vote (403), rejects a double-vote by the same actor (409), and is satisfied only once 2 DISTINCT eligible voters have voted", async () => {
    const org = await createTestOrg(server, "quorum");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await admin.components.create({ name: "quorum-target" });
    await createPolicy(admin, org, {
      name: "quorum-gate",
      urnSuffix: "quorum",
      enforcement: "required",
      scopeObjectId: target.id,
      requireApprovals: { count: 2, fromRole: "Approver", scope: org.orgId }
    });

    const change = await admin.changes.propose({ name: "quorum-change", targets: [target.id] });

    const approverA = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const approverB = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const nonMember = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const clientA = new ScpClient({ baseUrl: server.baseUrl, token: approverA.token });
    const clientB = new ScpClient({ baseUrl: server.baseUrl, token: approverB.token });
    const clientNonMember = new ScpClient({ baseUrl: server.baseUrl, token: nonMember.token });

    // Materializes from wave 0's own gate check (this required policy is scoped directly to the
    // wave's own target), not from 'validating' — see waitForApprovalRequest's doc comment.
    const approvalRequest = await waitForApprovalRequest(admin, change.id);

    const nonMemberErr = await expectApiError(() => clientNonMember.approvals.vote(approvalRequest.id));
    expect(nonMemberErr.status).toBe(403);

    await clientA.approvals.vote(approvalRequest.id);
    let status = await admin.approvals.get(approvalRequest.id);
    expect(status).toMatchObject({ voteCount: 1, status: "pending" });

    const doubleVoteErr = await expectApiError(() => clientA.approvals.vote(approvalRequest.id));
    expect(doubleVoteErr.status).toBe(409);

    // Quorum not yet reached (1/2) -> the wave stays blocked -> the change stays 'executing'.
    await assertStaysExecuting(admin, change.id);

    await clientB.approvals.vote(approvalRequest.id);
    status = await admin.approvals.get(approvalRequest.id);
    expect(status).toMatchObject({ voteCount: 2, status: "satisfied" });

    // Quorum reached -> the wave unblocks on its next gate check, executes, and the change
    // naturally reaches 'validating'.
    await waitForValidating(admin, change.id);
    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");

    // Every accepted vote carries a verifiable Ed25519 attestation (DESIGN §10.2).
    const votes = await admin.approvals.listVotes(approvalRequest.id);
    expect(votes).toHaveLength(2);
    for (const vote of votes) {
      expect(vote.attestation.signature.length).toBeGreaterThan(0);
      expect(vote.attestation.record.approverSubjectId).toBe(vote.voterObjectId);
    }

    // DESIGN §10.2: "approvals are recorded as `approves` relationships" — graph-visible, not
    // just rows in the approval_votes projection table.
    for (const voterObjectId of [approverA.objectId, approverB.objectId]) {
      const approvesRels = await admin.relationships.list({
        fromId: voterObjectId,
        toId: change.id,
        typeId: "approves"
      });
      expect(approvesRels.items.length).toBeGreaterThanOrEqual(1);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Freezes: block, mandatory reason, unauthorized-override 403, authorized override succeeds +
  // audits with the reason. SECURITY-SENSITIVE surface.
  // -----------------------------------------------------------------------------------------

  it("freeze blocks promote; override without permission is 403; override without a reason is 403; authorized override with a reason succeeds and writes an audited, Decision-linked freeze.override event", async () => {
    const org = await createTestOrg(server, "freeze");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await admin.components.create({ name: "freeze-target" });
    const change = await admin.changes.propose({ name: "freeze-change", targets: [target.id] });
    await waitForValidating(admin, change.id);

    const now = Date.now();
    await admin.freezes.create({
      scopeObjectId: target.id,
      name: "code-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "holiday code freeze"
    });

    const blocked = await expectApiError(() => admin.changes.promote(change.id));
    expect(blocked.status).toBe(409);
    expect(blocked.problem?.decision_id).toBeTruthy();

    // Administrator has 'freeze:write' (M4 migration) but deliberately NOT 'freeze:override' —
    // the two highest-blast-radius bypass permissions are Owner-only.
    const administrator = await createTestUser(server, org, [{ role: "Administrator", scope: org.orgId }]);
    const administratorClient = new ScpClient({ baseUrl: server.baseUrl, token: administrator.token });
    const unauthorizedOverride = await expectApiError(() =>
      administratorClient.changes.promote(change.id, "let me through please", true)
    );
    expect(unauthorizedOverride.status).toBe(403);

    // Owner HAS 'freeze:override' but omits the mandatory reason — still 403.
    const missingReason = await expectApiError(() => admin.changes.promote(change.id, undefined, true));
    expect(missingReason.status).toBe(403);

    // Owner, with a reason, succeeds.
    const promoted = await admin.changes.promote(change.id, "hotfix approved by incident commander", true);
    expect(promoted.state).toBe("promoted");

    const auditPage = await admin.auditEvents.list({ limit: 100 });
    const overrideEvent = auditPage.items.find((e) => e.action === "freeze.override");
    expect(overrideEvent).toBeDefined();
    expect(overrideEvent!.reason).toBe("hotfix approved by incident commander");
    expect(overrideEvent!.decisionId).toBeTruthy();

    const decision = await admin.decisions.get(overrideEvent!.decisionId!);
    expect(decision.verdict).toBe("allow");
    expect(decision.kind).toBe("transition");
  });

  // -----------------------------------------------------------------------------------------
  // Group-scoped policy (DESIGN §7's member_of expansion, reused for policy scope).
  // -----------------------------------------------------------------------------------------

  it("a group-scoped policy fires for a member_of subject and does not fire for a non-member", async () => {
    const org = await createTestOrg(server, "group-scope");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await admin.components.create({ name: "group-scope-target" });
    const group = await admin.groups.create({ name: "release-managers" });

    const member = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const nonMember = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    await admin.relationships.create({ typeId: "member_of", fromId: member.objectId, toId: group.id });

    await createPolicy(admin, org, {
      name: "group-gate",
      urnSuffix: "group-gate",
      enforcement: "required",
      scopeGroupId: group.id,
      requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
    });

    const memberClient = new ScpClient({ baseUrl: server.baseUrl, token: member.token });
    const nonMemberClient = new ScpClient({ baseUrl: server.baseUrl, token: nonMember.token });

    const changeAsMember = await memberClient.changes.propose({ name: "as-member", targets: [target.id] });
    await waitForValidating(memberClient, changeAsMember.id);
    const memberBlocked = await expectApiError(() => memberClient.changes.promote(changeAsMember.id));
    expect(memberBlocked.status).toBe(409);

    const changeAsNonMember = await nonMemberClient.changes.propose({ name: "as-non-member", targets: [target.id] });
    await waitForValidating(nonMemberClient, changeAsNonMember.id);
    const promoted = await nonMemberClient.changes.promote(changeAsNonMember.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // Emergency changes (DESIGN §10.3) — SECURITY-SENSITIVE surface: only a permitted actor
  // (change:emergency) may flag a change emergency; a flagged change follows a CONFIGURED
  // emergencyPolicy set instead of the normal required policies, never a blanket bypass, and the
  // bypass itself is visible in the Decision trail (never a silent allow indistinguishable from
  // "no policy applied").
  // -----------------------------------------------------------------------------------------

  describe("emergency changes", () => {
    it("an emergency change follows the configured emergencyPolicy (bypassing an otherwise-unsatisfiable normal required policy) while a non-emergency change against the SAME target stays blocked — both fully audited", async () => {
      const org = await createTestOrg(server, "emergency");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await admin.components.create({ name: "emergency-target" });

      // Deliberately unsatisfiable in this test (nobody ever votes) — any change that gets past
      // this one did so via the emergency bypass, not by chance.
      await createPolicy(admin, org, {
        name: "normal-required-gate",
        urnSuffix: "emergency-normal",
        enforcement: "required",
        scopeObjectId: target.id,
        requireApprovals: { count: 1, fromRole: "Owner", scope: target.id }
      });

      // The org's configured emergency policy for this scope — effect-free (vacuously satisfied)
      // so an emergency change sails through once the normal policy above is swapped out for it.
      await createPolicy(admin, org, {
        name: "emergency-bypass-policy",
        urnSuffix: "emergency-bypass",
        enforcement: "required",
        scopeObjectId: target.id,
        emergencyPolicy: true
      });

      // Non-emergency change against the SAME target: the normal required policy applies (it is
      // NOT filtered out for a non-emergency change) and can never be satisfied -> stays parked.
      const normalChange = await admin.changes.propose({ name: "normal-change", targets: [target.id] });
      await assertStaysExecuting(admin, normalChange.id, 4_000);

      // Emergency change, proposed by a permitted actor (the bootstrap admin holds Owner, which
      // has change:emergency per the M4 migration) -> gate-orchestrator.ts swaps in ONLY the
      // configured emergencyPolicy set -> proceeds cleanly through both the wave boundary and the
      // validating->promoted lifecycle edge.
      const emergencyChange = await admin.changes.propose({
        name: "emergency-change",
        targets: [target.id],
        emergency: true
      });
      await waitForValidating(admin, emergencyChange.id);
      const promoted = await admin.changes.promote(emergencyChange.id);
      expect(promoted.state).toBe("promoted");

      // Fully audited: the bypass is a NAMED fact in the Decision trail, not a silent allow — a
      // retrospective reader can tell this change went through the emergency path.
      const explained = await admin.changes.explain(emergencyChange.id);
      const emergencyDecision = explained.decisions.find((d) => {
        const gate = (d.reasonTree as { gate?: { emergencyNote?: unknown } }).gate;
        return typeof gate?.emergencyNote === "string";
      });
      expect(emergencyDecision).toBeDefined();
      expect(String((emergencyDecision!.reasonTree as { gate: { emergencyNote: string } }).gate.emergencyNote)).toMatch(
        /emergency/i
      );
    });

    it("a non-permitted actor cannot flag a change emergency (403) — the SAME actor can still propose an ordinary change", async () => {
      const org = await createTestOrg(server, "emergency-authz");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const target = await admin.components.create({ name: "emergency-authz-target" });

      // Administrator: object:write (can propose ordinary changes) but deliberately NOT
      // change:emergency (Owner-only per the M4 migration — the two highest-blast-radius bypass
      // permissions, freeze:override and change:emergency, are never granted to Administrator).
      const administrator = await createTestUser(server, org, [{ role: "Administrator", scope: org.orgId }]);
      const administratorClient = new ScpClient({ baseUrl: server.baseUrl, token: administrator.token });

      const err = await expectApiError(() =>
        administratorClient.changes.propose({ name: "attempted-emergency", targets: [target.id], emergency: true })
      );
      expect(err.status).toBe(403);

      const ordinary = await administratorClient.changes.propose({ name: "ordinary-change", targets: [target.id] });
      expect(ordinary.emergency).toBe(false);
    });
  });
});

// -----------------------------------------------------------------------------------------
// Automatic rollback fires on wave (control/gate) failure — its own server because it needs
// `FakeExecutorConfig.forcePhase` fixed at plugin-instance boot time for specific,
// test-known target object ids (created with an explicit `id:`).
// -----------------------------------------------------------------------------------------

describe("governance integration: automatic rollback on wave failure", () => {
  let server: ListeningTestServer;
  const autoRollbackTargetId = randomUUID();
  const parkedTargetId = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 },
      fakeExecutorConfig: { forcePhase: { [autoRollbackTargetId]: "failed", [parkedTargetId]: "failed" } }
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("a failed wave under an autoRollbackOnFailure policy triggers rollback automatically, labeled 'automatic' (not 'manual') in the Decision trail — and a rollback change's OWN failed wave never recurses into a rollback-of-a-rollback", async () => {
    const org = await createTestOrg(server, "auto-rollback");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await admin.components.create({ id: autoRollbackTargetId, name: "auto-rollback-target" });
    await createPolicy(admin, org, {
      name: "auto-rollback-policy",
      urnSuffix: "auto-rollback",
      enforcement: "advisory", // enforcement gates promote; autoRollbackOnFailure is independent of it
      scopeObjectId: target.id,
      autoRollbackOnFailure: true
    });

    const change = await admin.changes.propose({ name: "will-fail", targets: [target.id] });

    // `forcePhase` has no trigger-kind distinction (this file's module doc) — `autoRollbackTargetId`
    // fails EVERY trigger, sync or rollback alike, so the auto-triggered rollback change's own wave
    // fails too and never reaches 'promoted'. That's deliberately exercised by the SECOND
    // assertion below (no infinite rollback-of-a-rollback regress), not a test gap — this test's
    // real subject is the TRIGGER itself, not the rollback's own eventual success (already proven
    // by coordination.integration.test.ts's "rollback restores prior known-good state" case).
    const trigger = await waitUntil(
      async () => {
        const explained = await admin.changes.explain(change.id);
        return explained.decisions.find((d) => d.kind === "rollback_trigger");
      },
      { describe: `change ${change.id}'s wave failure auto-triggers a rollback`, timeoutMs: 30_000 }
    );
    expect(trigger.verdict).toBe("rollback");
    expect(trigger.inputContext["trigger"]).toBe("automatic");
    expect(String(trigger.reasonTree["summary"])).toMatch(/automatic/i);

    const rollbackChangeObjectId = trigger.inputContext["rollbackChangeObjectId"] as string;
    expect(rollbackChangeObjectId).toBeTruthy();

    // coordination/reconcile.ts's fix under test: a ROLLBACK change's own failed wave must not
    // recurse — it just parks (like any other non-qualifying failed wave), never triggering a
    // SECOND rollback_trigger Decision against itself. Give the reconcile loop several more ticks
    // (it would have looped many times over by now if the fix weren't in place) before asserting
    // the negative.
    await waitUntil(
      async () => {
        const explained = await admin.changes.explain(rollbackChangeObjectId);
        return explained.decisions.some((d) => d.kind === "wave_target" && d.verdict === "block") ? true : undefined;
      },
      { describe: `rollback change ${rollbackChangeObjectId}'s own wave is observed failing`, timeoutMs: 15_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const rollbackExplained = await admin.changes.explain(rollbackChangeObjectId);
    expect(rollbackExplained.decisions.filter((d) => d.kind === "rollback_trigger")).toHaveLength(0);
  });

  it("a failed wave with NO autoRollbackOnFailure policy stays parked for manual rollback (M3 behavior unchanged)", async () => {
    const org = await createTestOrg(server, "manual-park");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await admin.components.create({ id: parkedTargetId, name: "parked-target" });
    const change = await admin.changes.propose({ name: "will-park", targets: [target.id] });

    await waitUntil(
      async () => {
        const explained = await admin.changes.explain(change.id);
        return explained.plan?.waves.some((w) => w.status === "failed") ? true : undefined;
      },
      { describe: `change ${change.id}'s wave fails`, timeoutMs: 20_000 }
    );

    // A few more reconcile ticks (1s interval) — long enough that a wrongly-firing auto-rollback
    // would have shown up — then assert it genuinely never did.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stillExecuting = await admin.changes.get(change.id);
    expect(stillExecuting.state).toBe("executing");

    const explained = await admin.changes.explain(change.id);
    expect(explained.decisions.some((d) => d.kind === "rollback_trigger")).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject, ScanThresholdContribution } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaves, decisions } from "../db/schema.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  CountingCelSandbox,
  distinctDecisionStatements,
  partitionConditionErrors
} from "../coordination/test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "../coordination/test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { GateDeps } from "../coordination/gates.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { transitionChange } from "../coordination/transition.js";
import { compileAndPersistPlan, getLatestPlanForChange } from "../coordination/plan-service.js";
import { reconcileOrgTick } from "../coordination/reconcile.js";
import { castApprovalVote, listApprovalRequestsForChange } from "./approvals-repo.js";
import { mergeScanThresholds } from "./scan-requirements.js";

/** The two hardcoded rung lists the migration missed. See docs/governance.md §7. */

/** The blocking policy's condition. Real — and, because a contributor `condition` is what makes
 *  `resolveFiredPolicies` call the sandbox, it doubles as the observable per-tick EVALUATION COUNTER
 *  D2 needs to prove the gate is still evaluated on every tick it writes nothing on. */
const GATE_CONDITION = "change.emergency == false";

/** A scope keyword that is not, and must never become, resolvable. The negative control for A2 — the
 *  whole risk of "add `assembly` to the keyword map" is a fix that makes EVERY string resolve. */
const UNKNOWN_SCOPE_KEYWORD = "widget";

interface Chain {
  domain: GraphObject;
  service: GraphObject;
  assembly: GraphObject;
  component: GraphObject;
}

interface Parked {
  changeObjectId: string;
  waveId: string;
}

describe("M22.0: the assembly rung, and the Decision that explains its own rule", () => {
  let server: ListeningTestServer;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    // No reconcile loop and no plugin host from the harness: this file owns both, so a tick happens
    // exactly when it says so. (`withReconcileLoop` would be a live COMPETING CONSUMER for the very
    // work these tests count.)
    server = await listenTestServer();
    sandbox = new CountingCelSandbox();
    // A long auto-succeed so a wave that DOES start (A1) sits durably in flight rather than racing
    // the assertions to completion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  });

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  async function newOrg(label: string): Promise<{ org: TestOrg; admin: ScpClient }> {
    const org = await createTestOrg(server, label);
    return { org, admin: new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken }) };
  }

  /** `org root -> domain -> service -> ASSEMBLY -> component` — the full ladder, with the component
   *  hanging off the ASSEMBLY so the service is reachable only by continuing up through it. Only one
   *  assembly rung: `assembly -> assembly` is refused at write time (migration 0054's header). */
  async function buildChain(org: TestOrg, admin: ScpClient, label: string): Promise<Chain> {
    const domain = await admin.object("domain").create({ name: `dom-${label}` });
    const service = await admin
      .object("service")
      .create({ name: `svc-${label}`, domainId: domain.id });
    const assembly = await admin.assemblies.create({ name: `asm-${label}` });
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: assembly.id
    });
    const component = await createOrphanComponent(server, org, `comp-${label}`);
    await admin.relationships.create({
      typeId: "contains",
      fromId: assembly.id,
      toId: component.id
    });
    return { domain, service, assembly, component };
  }

  /** The `required` policy every test here parks on: one `requireApprovals` effect, no controls.
   *  `scope` is the string under test in A1/A2 and merely a parking brake in D1/D2. */
  async function requireApprovalPolicy(
    admin: ScpClient,
    org: TestOrg,
    label: string,
    scopeObjectId: string,
    approvalScope: string
  ) {
    return admin.policies.create({
      name: `gate-${label}`,
      urn: `urn:scp:${org.orgId}:policy:gate-${label}`,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "required",
        condition: GATE_CONDITION,
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: approvalScope } }]
      }
    });
  }

  // The guard refuses a scan-threshold rule of that shape. See docs/governance.md §8.
  /** A policy whose effect set is a scan ceiling plus the control that ceiling constrains, scoped at one object — the org-and-below
   *  authoring surface the six-tier MIN reads (ADR-0016). */
  async function scanFloorPolicy(
    admin: ScpClient,
    org: TestOrg,
    name: string,
    scopeObjectId: string,
    threshold: Record<string, number>
  ) {
    return admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ scanThreshold: threshold }, { requireControls: ["security-scan"] }]
      }
    });
  }

  /** Walks a change to executing with wave zero still pending. See docs/governance.md §9. */
  async function parkAtWaveGate(org: TestOrg, componentId: string, label: string): Promise<Parked> {
    const gateDeps: GateDeps = { sandbox, host };
    const changeObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const { change, targetObjectIds } = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "m22-test",
        name: `change-${label}`,
        targets: [componentId]
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
            requestId: "m22-test"
          },
          gateDeps
        );
      }
      return change.id;
    });

    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeObjectId)
    );
    expect(plan?.waves[0]?.status).toBe("pending");
    // The manual walk writes `transition` Decisions and ZERO `gate` ones.
    expect(await gateDecisionRows(org, changeObjectId)).toHaveLength(0);

    return { changeObjectId, waveId: plan!.waves[0]!.id };
  }

  function gateDecisionRows(org: TestOrg, changeObjectId: string) {
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

  async function tick(org: TestOrg, times = 1): Promise<void> {
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

  function waveStatus(waveId: string, org: TestOrg) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const [row] = await tx.select().from(changeWaves).where(eq(changeWaves.id, waveId));
      return row!.status;
    });
  }

  /** The `scanThreshold` block M22.0 added to the gate's Decision `inputContext`. */
  interface DecisionScanThreshold {
    effective: Record<string, number>;
    contributors: ScanThresholdContribution[];
  }
  function scanThresholdOf(inputContext: unknown): DecisionScanThreshold | undefined {
    return (inputContext as { scanThreshold?: DecisionScanThreshold }).scanThreshold;
  }

  // A1 — `requireApprovals: {scope: "assembly"}` is SATISFIABLE. See docs/governance.md §10.

  it("A1: an Approver bound at the ASSEMBLY satisfies requireApprovals {scope: 'assembly'} — and the wave proceeds", async () => {
    const { org, admin } = await newOrg("approval-assembly");
    const chain = await buildChain(org, admin, "approval-assembly");
    await requireApprovalPolicy(admin, org, "assembly", chain.component.id, "assembly");
    const parked = await parkAtWaveGate(org, chain.component.id, "assembly");

    await tick(org);

    // (a) THE FIX ITSELF: the scope resolved to a CONCRETE OBJECT, so a request was materialized.
    //     Before M22.0 this list was EMPTY — that is the whole defect, and it is asserted before any
    //     vote is attempted so the failure mode is legible.
    const requests = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listApprovalRequestsForChange(tx, org.orgId, parked.changeObjectId)
    );
    expect(requests).toHaveLength(1);
    // ...and it resolved to the ASSEMBLY specifically — not to the service above it, and not to the
    // org root, either of which would be a keyword that silently means something else.
    expect(requests[0]!.scopeObjectId).toBe(chain.assembly.id);
    expect(requests[0]!.scopeObjectId).not.toBe(chain.service.id);
    expect(requests[0]!.scopeObjectId).not.toBe(org.orgId);

    // (b) The gate is genuinely BLOCKED on it in the meantime (fail-closed, unchanged).
    const blocked = await gateDecisionRows(org, parked.changeObjectId);
    expect(blocked.at(-1)!.verdict).toBe("block");
    expect(await waveStatus(parked.waveId, org)).toBe("pending");

    // (c) A HUMAN CAN NOW VOTE IT THROUGH. The voter holds `Approver` at the assembly and NOWHERE
    //     else, so eligibility is decided by the resolved scope and nothing broader.
    const approver = await createTestUser(server, org, [
      { role: "Approver", scope: chain.assembly.id }
    ]);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      castApprovalVote(tx, {
        orgId: org.orgId,
        approvalRequestId: requests[0]!.id,
        voterObjectId: approver.objectId,
        requestId: "m22-test-vote"
      })
    );

    await tick(org);

    // (d) THE CHANGE PROCEEDS — a new `allow` Decision, and the wave actually left `pending`.
    const after = await gateDecisionRows(org, parked.changeObjectId);
    expect(after.at(-1)!.verdict).toBe("allow");
    expect(await waveStatus(parked.waveId, org)).not.toBe("pending");
  });

  // A2 — THE NEGATIVE CONTROL. See docs/governance.md §11.

  it("A2: an UNKNOWN scope keyword still resolves to null — it blocks, and no approval request is materialized", async () => {
    const { org, admin } = await newOrg("approval-unknown");
    const chain = await buildChain(org, admin, "approval-unknown");
    await requireApprovalPolicy(admin, org, "unknown", chain.component.id, UNKNOWN_SCOPE_KEYWORD);
    const parked = await parkAtWaveGate(org, chain.component.id, "unknown");

    await tick(org, 3);

    const requests = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listApprovalRequestsForChange(tx, org.orgId, parked.changeObjectId)
    );
    expect(
      requests,
      "an unresolvable scope must materialize NO approval request — there is no scope to hold a role at"
    ).toHaveLength(0);

    const rows = await gateDecisionRows(org, parked.changeObjectId);
    expect(rows.at(-1)!.verdict).toBe("block");
    expect(await waveStatus(parked.waveId, org)).toBe("pending");

    // ...and the block is attributed to the unsatisfied approval effect, not to something incidental.
    const policies =
      (rows.at(-1)!.reasonTree as { policies?: Array<Record<string, unknown>> }).policies ?? [];
    const entry = policies.find((p) => p.name === "gate-unknown");
    const effect = (entry!.effects as Array<{ kind: string; satisfied: boolean }>).find(
      (e) => e.kind === "requireApprovals"
    );
    expect(effect?.satisfied).toBe(false);
  });

  // D1 — THE DECISION EXPLAINS THE RULE. See docs/governance.md §12.

  it("D1: the gate's Decision carries the resolved ceiling and names EVERY contributing tier", async () => {
    const { org, admin } = await newOrg("decision-rule");
    const chain = await buildChain(org, admin, "decision-rule");
    // The parking brake: something that blocks, so the wave stays pending and there is a gate
    // Decision to read. Its scope is `organization`, which has always resolved.
    await requireApprovalPolicy(admin, org, "rule", chain.component.id, "organization");

    // FIVE tiers, each setting exactly ONE severity to a distinctive value and everything else
    // LOOSER, so the persisted `effective` can only be a per-severity MIN across the whole set.
    // Authored in an order that is NOT the sorted order D2 asserts — see D2.
    await scanFloorPolicy(admin, org, "floor-org", org.orgId, {
      maxCritical: 90,
      maxHigh: 90,
      maxMedium: 90,
      maxLow: 7
    });
    await scanFloorPolicy(admin, org, "floor-domain", chain.domain.id, {
      maxMedium: 6,
      maxLow: 80
    });
    await scanFloorPolicy(admin, org, "floor-service", chain.service.id, {
      maxHigh: 70,
      maxMedium: 60
    });
    await scanFloorPolicy(admin, org, "floor-assembly", chain.assembly.id, { maxHigh: 5 });
    await scanFloorPolicy(admin, org, "floor-component", chain.component.id, { maxCritical: 4 });

    const parked = await parkAtWaveGate(org, chain.component.id, "rule");
    await tick(org);

    const rows = await gateDecisionRows(org, parked.changeObjectId);
    expect(rows).toHaveLength(1);
    const st = scanThresholdOf(rows[0]!.inputContext);
    expect(
      st,
      "a gate Decision must state the scan ceiling it was measured against (ADR-0016 §5)"
    ).toBeDefined();

    // (a) THE EFFECTIVE CEILING. See docs/governance.md §13.
    expect(st!.effective).toEqual({ maxCritical: 4, maxHigh: 5, maxMedium: 6, maxLow: 7 });

    // (b) EVERY CONTRIBUTING TIER IS NAMED — including `assembly`, which before M22.0 would have
    //     read `component` and made two of these five indistinguishable.
    expect([...st!.contributors].map((c) => c.tier).sort()).toEqual([
      "assembly",
      "component",
      "containment_domain",
      "org",
      "service"
    ]);
    expect(st!.contributors.find((c) => c.tier === "assembly")!.source).toContain("floor-assembly");

    // (c) THE DECISION IS INTERNALLY CONSISTENT: re-merging the contributor list it persisted
    //     reproduces the effective ceiling it persisted. This is what stops (a) from being a
    //     hand-computed expectation that happens to agree with a Decision explaining something else.
    expect(mergeScanThresholds(st!.contributors).threshold).toEqual(st!.effective);
  });

  // D2 — DETERMINISM, AND THE WRITE AMPLIFICATION IT PROTECTS. See docs/governance.md §14.

  it("D2: re-evaluating the same gate writes ZERO further Decisions, and the persisted contributor list is deterministically ordered", async () => {
    const { org, admin } = await newOrg("determinism");
    const chain = await buildChain(org, admin, "determinism");
    await requireApprovalPolicy(admin, org, "determinism", chain.component.id, "organization");

    // AUTHORING ORDER IS THE POINT. See docs/governance.md §15.
    await scanFloorPolicy(admin, org, "floor-org", org.orgId, { maxHigh: 9 });
    await scanFloorPolicy(admin, org, "floor-domain", chain.domain.id, { maxHigh: 8 });
    await scanFloorPolicy(admin, org, "floor-service", chain.service.id, { maxHigh: 7 });
    await scanFloorPolicy(admin, org, "floor-assembly", chain.assembly.id, { maxHigh: 6 });
    await scanFloorPolicy(admin, org, "floor-component", chain.component.id, { maxHigh: 5 });

    const parked = await parkAtWaveGate(org, chain.component.id, "determinism");

    const evaluationsBefore = sandbox.countOf(GATE_CONDITION);
    await tick(org);
    const firstPass = await gateDecisionRows(org, parked.changeObjectId);
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]!.verdict).toBe("block");
    expect(scanThresholdOf(firstPass[0]!.inputContext)).toBeDefined();

    const TICKS = 9;
    await tick(org, TICKS);

    // (a) ZERO NEW ROWS ON EVERY SUBSEQUENT PASS. See docs/governance.md §16.
    const after = await gateDecisionRows(org, parked.changeObjectId);
    const { ordinary, conditionErrors } = partitionConditionErrors(after);
    const firstPassIds = new Set(firstPass.map((r) => r.id));
    const newOrdinary = ordinary.filter((r) => !firstPassIds.has(r.id));
    expect(newOrdinary.length).toBeLessThanOrEqual(conditionErrors.length);
    expect(distinctDecisionStatements(ordinary)).toBe(1);
    expect(ordinary[0]!.id).toBe(firstPass[0]!.id);

    // ...and the gate really was RE-EVALUATED all N+1 times. "Evaluate less often" would satisfy the
    // row assertion above while breaking the engine — an arriving approval is noticed only here.
    expect(sandbox.countOf(GATE_CONDITION) - evaluationsBefore).toBe(TICKS + 1);

    // (b) THE SORTED INVARIANT, on the array the gate persisted. The sort key is rebuilt in the
    //     production key order from the read-back values — see this test's header for why the raw
    //     serialization cannot be compared across `jsonb`.
    const contributors = scanThresholdOf(ordinary[0]!.inputContext)!.contributors;
    expect(contributors).toHaveLength(5);
    const sortKey = (c: ScanThresholdContribution) =>
      JSON.stringify({
        tier: c.tier,
        source: c.source,
        ...(c.objectTypeId ? { objectTypeId: c.objectTypeId } : {}),
        threshold: c.threshold
      });
    const keys = contributors.map(sortKey);
    expect(keys).toEqual([...keys].sort());
    // The fixture's own authoring order, restated as an assertion so a future edit that accidentally
    // makes it ALREADY sorted turns (b) into a tautology loudly instead of silently.
    expect(contributors.map((c) => c.tier)).toEqual([
      "assembly",
      "component",
      "containment_domain",
      "org",
      "service"
    ]);
  });
});

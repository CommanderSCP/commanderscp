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

/**
 * M22.0 — THE TWO HARDCODED RUNG LISTS MIGRATION 0055 MISSED, AND THE DECISION THAT DID NOT EXPLAIN
 * ITS OWN RULE (ADR-0033 §5/§11; charter principle 6).
 *
 * Migration 0055 added the optional `service -> assembly -> component` rung. `containmentChain`
 * walks it for free because it matches on the `contains` EDGE and never on the parent's TYPE — which
 * is why 0055 shipped no resolver edit at all. But WALKING a rung is edge-generic and NAMING one is
 * not, and two hardcoded lists were left behind:
 *
 *   * `gate-orchestrator.ts`'s `APPROVAL_SCOPE_KEYWORDS` had no `assembly` entry, so
 *     `requireApprovals: {scope: "assembly"}` resolved to `null` and became a PERMANENTLY
 *     unsatisfiable required approval — fail-closed, but silently inexpressible, and no approval
 *     REQUEST was ever materialized, so no human could vote it through either. Pinned by A1/A2 here.
 *   * `scan-requirements.ts`'s `tierForObjectType` fell `assembly` through to `component`. Pinned by
 *     `scoped-scan-requirements.integration.test.ts` (a2), at the real scan gate, where the ceiling
 *     it reports can be read back out of the persisted control-run evidence.
 *
 * And the resolved scan ceiling went only into `control_runs.evidence`, never into the Decision an
 * operator resolves by `decision_id`. D1/D2 pin that it is now in the Decision, and that putting it
 * there did NOT re-open the measured 1.44 GB/day write amplification (ADR-0024 §D0) on the busiest
 * path in the system.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE DRIVES `reconcileOrgTick` DIRECTLY
 * ---------------------------------------------------------------------------------------------
 * The scan ceiling reaches a Decision only from the WAVE-BOUNDARY gate: `evaluateGovernanceGate`
 * resolves it inside its `host` condition, and the lifecycle-edge gate runs with `host: null` on the
 * API tier. So every test here parks a change at a pending wave and ticks the reconciler by hand —
 * "N ticks" is then exactly N (the same discipline, and the same reason, as
 * `coordination/decision-write-amplification.integration.test.ts`), which is what makes D2's row
 * counts mean anything at all.
 *
 * ONE ORG PER TEST, deliberately: `matchPoliciesForTargets` scans every policy in the org, so an
 * org-scoped scan floor authored by one test would silently join another test's contributor list and
 * make D1's exhaustive tier assertion pass or fail for reasons that have nothing to do with it.
 *
 * ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied ALONE against this file, watched fail, then reverted.
 * (Results recorded in the PR body; the mutations themselves are named on each test.)
 * ---------------------------------------------------------------------------------------------
 */

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

  // -------------------------------------------------------------------------------------------
  // Fixture builders
  // -------------------------------------------------------------------------------------------

  async function newOrg(label: string): Promise<{ org: TestOrg; admin: ScpClient }> {
    const org = await createTestOrg(server, label);
    return { org, admin: new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken }) };
  }

  /** `org root -> domain -> service -> ASSEMBLY -> component` — the full ladder, with the component
   *  hanging off the ASSEMBLY so the service is reachable only by continuing up through it. Only one
   *  assembly rung: `assembly -> assembly` is refused at write time (migration 0054's header). */
  async function buildChain(admin: ScpClient, label: string): Promise<Chain> {
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
    const component = await createOrphanComponent(admin, `comp-${label}`);
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

  /** A policy whose ONLY effect is a scan ceiling, scoped at one object — the org-and-below
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
        effects: [{ scanThreshold: threshold }]
      }
    });
  }

  /**
   * Walks a change to `executing` with wave 0 still `pending`, by hand. Every edge used here is one
   * `gates.ts` documents as always-allow (`proposed -> evaluated -> coordinated -> executing`), so
   * the FIRST `tick()` below is the first thing that has ever evaluated this wave's gate — which is
   * what lets D2 count rows against ticks.
   */
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

  // -------------------------------------------------------------------------------------------
  // A1 — `requireApprovals: {scope: "assembly"}` is SATISFIABLE.
  //
  // Before M22.0 `resolveApprovalScope` returned `null` for it, so the gate marked the approval
  // unsatisfied and `continue`d — no request row, nothing in anyone's queue, and no possible vote.
  // The change was parked forever behind an effect its author had legitimately expressed.
  //
  // MUTATION: delete the `assembly: "assembly"` entry from `APPROVAL_SCOPE_KEYWORDS`.
  // -------------------------------------------------------------------------------------------

  it("A1: an Approver bound at the ASSEMBLY satisfies requireApprovals {scope: 'assembly'} — and the wave proceeds", async () => {
    const { org, admin } = await newOrg("approval-assembly");
    const chain = await buildChain(admin, "approval-assembly");
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

  // -------------------------------------------------------------------------------------------
  // A2 — THE NEGATIVE CONTROL. Naming one more keyword must not make every string a keyword.
  //
  // This is the arm that keeps A1 from being satisfied by a "fix" that resolves anything to
  // something. An unknown keyword is not an object id or urn either, so it must still resolve to
  // `null`, still block, and still materialize NOTHING.
  //
  // MUTATION: make `APPROVAL_SCOPE_KEYWORDS` a total function (e.g. default the lookup to
  // `"organization"`) and this test goes red while A1 stays green.
  // -------------------------------------------------------------------------------------------

  it("A2: an UNKNOWN scope keyword still resolves to null — it blocks, and no approval request is materialized", async () => {
    const { org, admin } = await newOrg("approval-unknown");
    const chain = await buildChain(admin, "approval-unknown");
    await requireApprovalPolicy(
      admin,
      org,
      "unknown",
      chain.component.id,
      UNKNOWN_SCOPE_KEYWORD
    );
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
    const effect = (
      entry!.effects as Array<{ kind: string; satisfied: boolean }>
    ).find((e) => e.kind === "requireApprovals");
    expect(effect?.satisfied).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // D1 — THE DECISION EXPLAINS THE RULE (ADR-0016 §5, charter principle 6).
  //
  // Until M22.0 the resolved ceiling and its contributing tiers lived ONLY in
  // `control_runs.evidence`. An operator handed a `decision_id` could read the verdict and not the
  // rule it was measured against. ADR-0033 then adds a way to EXCLUDE findings from that comparison
  // — so the rule has to be in the Decision before any exception can hide inside it.
  //
  // Read out of the persisted `decisions` row, never out of a hand-built merge input.
  //
  // MUTATION: delete the `...(scanThresholdForDecision(effectiveScanThreshold) ?? {})` spread from
  // `evaluateGovernanceGate`'s `inputContext`.
  // -------------------------------------------------------------------------------------------

  it("D1: the gate's Decision carries the resolved ceiling and names EVERY contributing tier", async () => {
    const { org, admin } = await newOrg("decision-rule");
    const chain = await buildChain(admin, "decision-rule");
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
    await scanFloorPolicy(admin, org, "floor-domain", chain.domain.id, { maxMedium: 6, maxLow: 80 });
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

    // (a) THE EFFECTIVE CEILING — the per-severity MIN over all five tiers:
    //     maxCritical: org 90, component 4                  -> 4
    //     maxHigh:     org 90, service 70, assembly 5        -> 5
    //     maxMedium:   org 90, domain 6, service 60          -> 6
    //     maxLow:      org 7, domain 80                      -> 7
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

  // -------------------------------------------------------------------------------------------
  // D2 — DETERMINISM, AND THE WRITE AMPLIFICATION IT PROTECTS.
  //
  // `restatesDecision` canonicalises object KEY order but deliberately PRESERVES array order, and
  // `matchPoliciesForTargets` returns contributors in unordered-scan insertion order. So an unsorted
  // `contributors` array in the Decision would defeat `insertDecisionIfChanged` and re-open the
  // measured 1.44 GB/day flood (ADR-0024 §D0) on the busiest path in the system.
  //
  // WHAT THIS TEST CAN AND CANNOT PROVE — stated plainly rather than implied:
  //
  //   * (a) is the property that matters and it is directly asserted: N ticks over an unchanged
  //     parked gate append ZERO further rows.
  //   * (a) alone, however, is NOT a reliable detector of a missing `.sort(...)`. The unordered scan
  //     `matchPoliciesForTargets` reads from is a seq scan over a small, never-updated table, so
  //     within ONE run it returns the same physical order every tick; the contributor array would be
  //     unsorted but STABLY unsorted, and the rows would still collapse. The order only diverges
  //     across a rewrite (VACUUM FULL, an UPDATE moving a row, a plan flip) — which a single test
  //     run cannot force.
  //   * so (b) asserts the SORTED INVARIANT DIRECTLY, on the array the gate actually persisted. That
  //     is the assertion the `.sort(...)` mutation fails, deterministically: the fixture authors its
  //     floors in an order whose tier labels are not ascending, so "sorted" and "as matched" cannot
  //     coincide.
  //   * what is NOT observable here at all: the FIXED KEY ORDER each contributor object is built
  //     with. `jsonb` does not preserve the author's key order (it stores keys by length, then
  //     bytewise), so the persisted row cannot witness it. (b) therefore rebuilds the sort key from
  //     the read-back values instead of comparing raw serializations. Key order still matters for
  //     the same reason the sort does — it is what makes the sort key content-only — but it is
  //     provable only in-process, not from the record.
  //
  // MUTATIONS: remove the `.sort(...)` from `scanThresholdForDecision` -> (b) fails, (a) does not.
  //            replace `insertDecisionIfChanged` with `insertDecision`   -> (a) fails.
  // -------------------------------------------------------------------------------------------

  it("D2: re-evaluating the same gate writes ZERO further Decisions, and the persisted contributor list is deterministically ordered", async () => {
    const { org, admin } = await newOrg("determinism");
    const chain = await buildChain(admin, "determinism");
    await requireApprovalPolicy(admin, org, "determinism", chain.component.id, "organization");

    // AUTHORING ORDER IS THE POINT. `matchPoliciesForTargets` yields matches in policy-row order, so
    // these arrive as org -> containment_domain -> service -> assembly -> component. Sorted by their
    // own serialization (which begins `{"tier":"…"`) they must come out
    // assembly -> component -> containment_domain -> org -> service. The two orders share no prefix,
    // so an unsorted array cannot pass for a sorted one here by luck.
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

    // (a) ZERO NEW ROWS ON EVERY SUBSEQUENT PASS.
    //
    // Stated as a bound rather than a bare count for the reason
    // `counting-cel-sandbox.ts`'s `partitionConditionErrors` documents and measured: a CEL wall-clock
    // miss on a loaded box makes the production code CORRECTLY write a fail-closed condition-error
    // row, and then an ordinary row again on the next tick. Both writes are right. On a healthy run
    // `conditionErrors` is empty and this reads exactly "not one row was appended".
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

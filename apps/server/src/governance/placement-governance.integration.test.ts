import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { evaluateGovernanceGate } from "./gate-orchestrator.js";
import { getSharedCelSandbox } from "./cel-sandbox.js";
import { hasPermission } from "../authz/resolve.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * GOVERNANCE OVER A PLACEMENT WAVE TARGET (ADR-0026).
 *
 * ============================================================================================
 * THE PROPERTY, AND WHY THESE ARE THE TESTS
 * ============================================================================================
 * Under stage-shaped compilation a `change_wave_targets.target_object_id` is a PLACEMENT, not a
 * component. Every wave-boundary governance decision is derived from that id — policy matching and
 * freeze scoping walk its containment chain, and the CEL context reads the object itself.
 *
 * A placement's chain used to be `[org root, placement]` and nothing more: its `domain_id` is the
 * org root and it has no incoming `contains` edge. So the day a wave target became a placement,
 * every component- and service-scoped policy stopped matching at the wave boundary and every
 * service-scoped freeze failed OPEN — silently, because a policy that stops matching produces the
 * same `allow` verdict as a policy that was never meant to match. On the live estate that is 11
 * `required` component-scoped prod-gate policies.
 *
 * Each test below therefore asserts a VERDICT (or a permission answer), never a message or a count:
 * the question is whether governance still fires over the new shape, and the only honest evidence
 * of that is the decision it produces. Every one is written so that removing the fix flips the
 * verdict from `block` to `allow` — the direction that matters, since `allow` is what a silently
 * dead gate looks like.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `containment.ts`: drop route 3 (the placement -> component branch of the LATERAL union) | the component-scoped policy, service-scoped policy, service-scoped freeze and approval-scope tests all FAIL (verdict flips to `allow` / scope resolves to null) |
 * | `containment.ts`: make route 3 read `deploymentTargetId` instead of `componentId` | the same four FAIL — the route must reach the right endpoint, not just any endpoint |
 * | `gate-orchestrator.ts`: `governanceSubjectOf` returns `targetObjectId` unconditionally | the CEL-subject test FAILS (`subject.typeId` is `placement`, the condition goes false, the required policy stops firing, verdict flips to `allow`) |
 * | `authz/resolve.ts`: drop the shared fragment from `scopeExpandCte` | the component-role-reaches-its-placement test FAILS |
 * | `containment.ts`: drop the CASE guard, cast `componentId` bare | the malformed-`componentId` test FAILS with a Postgres cast error instead of an answer |
 *
 * ROUTE 4 (the deployment-target as a containing scope, owner-approved 2026-08-02):
 *
 * | Mutation | Result |
 * |---|---|
 * | `containment.ts`: drop route 4 from `placementParentsSql` | the target-scoped policy, target-scoped freeze and target-bound role tests all FAIL. The malformed-`deploymentTargetId` test correctly still PASSES — it asserts the COMPONENT route survives a bad place, so it is not a test of route 4's presence |
 * | `containment.ts`: point route 4 at `componentId` instead | the same three FAIL — reaching *an* endpoint is not the same as reaching the right one |
 * | `containment.ts`: drop the CASE guard (shared by both endpoints) | BOTH malformed tests FAIL with `invalid input syntax for type uuid`, which is how the guard is shown to cover the endpoint route 4 added and not just the original |
 *
 * One mutation REFUTED a claim rather than confirming it, and the claim was corrected: swapping
 * `service-board.ts` to the pair fragment leaves its tests green, because arm 1's `IN (componentIds)`
 * filter discards the deployment-target row. See `placementComponentParentSql`'s comment — the
 * fragments stay separate on narrower, true grounds.
 */
describe("governance over a placement wave target (ADR-0026)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let place: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "placement-gov");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    place = await admin.deploymentTargets.create({ name: "prod (DOKS hosted)" });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A component with one placement at `place` (or at `opts.at`), plus (optionally) an owning
   *  service. Route-4 tests pass their OWN deployment-target: every other test in this file places
   *  at the shared `place`, so a gating policy scoped there would silently change their meaning. */
  async function placedComponent(
    label: string,
    opts: { service?: boolean; at?: GraphObject } = {}
  ) {
    const component = await createOrphanComponent(admin, `${label}-comp`);
    let service: GraphObject | null = null;
    if (opts.service) {
      service = await admin.object("service").create({ name: `${label}-svc` });
      await admin.relationships.create({
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
    }
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: (opts.at ?? place).id
    });
    return { component, service, placement };
  }

  /**
   * A `required` policy whose single effect is an approval nobody has cast. If it MATCHES and FIRES,
   * the gate blocks; if it fails to match, the gate allows. That asymmetry is the whole measurement:
   * `allow` is exactly what a silently dead gate returns.
   */
  const gatingPolicy = (name: string, objectRef: string, condition?: string) =>
    admin.policies.create({
      name,
      properties: {
        scope: { objectRef },
        enforcement: "required",
        ...(condition ? { condition } : {}),
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: "organization" } }]
      }
    });

  /** Privileged fixture surgery — writes a `properties` document the API's own validation refuses.
   *  Parameterised over the endpoint, because BOTH endpoints of the pair are cast to uuid and both
   *  therefore need the same guard (see `placementParentsSql`). */
  async function writeMalformedEndpoint(
    placementId: string,
    property: "componentId" | "deploymentTargetId"
  ) {
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      await surgeon.query(
        `UPDATE objects SET properties = jsonb_set(properties, $2::text[], '"not-a-uuid"') WHERE id = $1`,
        [placementId, `{${property}}`]
      );
    } finally {
      await surgeon.end();
    }
  }

  /** The wave-boundary gate, called exactly as `coordination/gates.ts` calls it for a wave. */
  async function waveGate(targetObjectIds: string[], changeObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateGovernanceGate(tx, getSharedCelSandbox(), null, {
        orgId: org.orgId,
        changeObjectId,
        targetObjectIds,
        actorObjectId: org.orgId,
        emergency: false,
        gateKind: "wave_boundary",
        gateRef: { waveIndex: 0 }
      })
    );
  }

  it("a COMPONENT-scoped policy still gates when the wave target is that component's PLACEMENT", async () => {
    const { component, placement } = await placedComponent("comp-scoped");
    await gatingPolicy("comp-scoped-gate", component.id);
    const change = await admin.changes.propose({
      name: "comp-scoped-change",
      targets: [component.id]
    });

    // The control: naming the component blocks, as it always has.
    const overComponent = await waveGate([component.id], change.id);
    expect(overComponent.verdict).toBe("block");

    // The measurement: naming the PLACEMENT must reach the same policy through the same change.
    const overPlacement = await waveGate([placement.id], change.id);
    expect(
      overPlacement.verdict,
      "a component-scoped required policy must still gate a wave whose target is a placement of that component"
    ).toBe("block");
  });

  it("a SERVICE-scoped policy reaches a placement of that service's component", async () => {
    const { service, placement } = await placedComponent("svc-scoped", { service: true });
    await gatingPolicy("svc-scoped-gate", service!.id);
    const change = await admin.changes.propose({
      name: "svc-scoped-change",
      targets: [placement.id]
    });

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "the chain must continue THROUGH the component to its service, not stop at the component"
    ).toBe("block");
  });

  it("a SERVICE-scoped freeze blocks a placement wave target instead of failing open", async () => {
    const { service, placement } = await placedComponent("svc-freeze", { service: true });
    const change = await admin.changes.propose({ name: "freeze-change", targets: [placement.id] });

    const now = Date.now();
    await admin.freezes.create({
      scopeObjectId: service!.id,
      name: "placement-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "holiday code freeze"
    });

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "an active freeze over the placement's service must block the wave — failing open here is the exact bug graph/containment.ts was written to end"
    ).toBe("block");
    // The freeze, not something else, is what stopped it: the outcome names the frozen scope.
    expect(outcome.inputContext.freeze).toMatchObject({ scopeObjectId: service!.id });
  });

  it("does NOT over-reach: a policy scoped at ANOTHER component leaves the placement ungated", async () => {
    const { placement } = await placedComponent("no-reach");
    const stranger = await createOrphanComponent(admin, "no-reach-stranger");
    await gatingPolicy("stranger-gate", stranger.id);
    const change = await admin.changes.propose({
      name: "no-reach-change",
      targets: [placement.id]
    });

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "route 3 must reach the placement's OWN component and nothing else"
    ).toBe("allow");
  });

  it("the CEL subject of a placement target is the COMPONENT it places, not the placement", async () => {
    // A condition that is TRUE only if `subject` is the component. Under the placement it would read
    // `typeId == "placement"`, evaluate false, and the required policy would quietly stop firing.
    const { component, placement } = await placedComponent("cel-subject");
    await gatingPolicy("cel-subject-gate", component.id, 'subject.typeId == "component"');
    const change = await admin.changes.propose({
      name: "cel-subject-change",
      targets: [component.id]
    });

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "a subject-conditioned policy must see the software being released, which is the component"
    ).toBe("block");
  });

  it("a role bound at a COMPONENT reaches that component's placement (authz stays in step with containment)", async () => {
    const { component, placement } = await placedComponent("authz");
    const other = await placedComponent("authz-other");

    const operator = await createTestUser(server, org, [{ role: "Operator", scope: component.id }]);

    const [overOwn, overStranger] = await withTenantTx(server.deps.db, org.orgId, async (tx) => [
      await hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: placement.id
      }),
      await hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: other.placement.id
      })
    ]);

    expect(
      overOwn,
      "a placement is its component at one place — authority over the component must reach it, or the governance chain and the authority chain disagree"
    ).toBe(true);
    expect(overStranger, "and must reach no other component's placements").toBe(false);
  });

  it("a placement carrying a malformed componentId answers instead of erroring the whole walk", async () => {
    // `createObject` is called directly by federation-journal replay, which never passes through the
    // typed /placements route — so a corrupt or hostile peer can ship this. A bare ::uuid cast would
    // throw inside EVERY containment walk in the org, taking out all governance evaluation at once.
    const { component, placement } = await placedComponent("malformed");
    await gatingPolicy("malformed-gate", component.id);
    const change = await admin.changes.propose({
      name: "malformed-change",
      targets: [component.id]
    });

    // Fixture surgery: write a componentId the typed route would never produce.
    await writeMalformedEndpoint(placement.id, "componentId");

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "a malformed pair must lose its component ancestor, not crash the walk — the failure mode of a crash is every gate erroring at once"
    ).toBe("allow");
  });

  // ==============================================================================================
  // ROUTE 4 — the deployment-target as a containing scope. Unlike route 3 these do not restore lost
  // gating; they make gating START, which is why the route was an owner decision (2026-08-02) rather
  // than part of the fix. The live estate's twelfth `required` prod-gate policy is scoped exactly
  // this way and had never once matched.
  // ==============================================================================================

  it("a policy scoped at a DEPLOYMENT-TARGET gates every placement there — and nothing anywhere else", async () => {
    const gated = await admin.deploymentTargets.create({ name: "route4-gated-target" });
    const here = await placedComponent("route4-here", { at: gated });
    const elsewhere = await placedComponent("route4-elsewhere"); // at the shared `place`
    await gatingPolicy("route4-target-gate", gated.id);
    const change = await admin.changes.propose({
      name: "route4-change",
      targets: [here.component.id]
    });

    const atGatedTarget = await waveGate([here.placement.id], change.id);
    expect(
      atGatedTarget.verdict,
      "this is the whole point of route 4: a gate written against a PLACE must fire for what is deployed there. Without it the policy matches nothing and the wave sails through"
    ).toBe("block");

    // The other half of the measurement. A route that reaches everything is not a scope.
    const atAnotherTarget = await waveGate([elsewhere.placement.id], change.id);
    expect(
      atAnotherTarget.verdict,
      "a placement at a DIFFERENT deployment-target must stay ungated — otherwise 'scoped to prod' would silently mean 'scoped to everything'"
    ).toBe("allow");
  });

  it("a freeze scoped at a DEPLOYMENT-TARGET blocks what is placed there ('freeze prod', newly expressible)", async () => {
    const frozenPlace = await admin.deploymentTargets.create({ name: "route4-frozen-target" });
    const { placement } = await placedComponent("route4-freeze", { at: frozenPlace });
    const change = await admin.changes.propose({
      name: "route4-freeze-change",
      targets: [placement.id]
    });

    const now = Date.now();
    await admin.freezes.create({
      scopeObjectId: frozenPlace.id,
      name: "prod-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "change freeze over the whole stage"
    });

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "before route 4 a stage-scoped freeze had no expression at all — `containmentScopeIds` never put the deployment-target on a placement's chain, so the freeze matched nothing"
    ).toBe("block");
    // And it is THIS freeze that stopped it, not some other rule.
    expect(outcome.inputContext.freeze).toMatchObject({ scopeObjectId: frozenPlace.id });
  });

  it("a role bound at a DEPLOYMENT-TARGET reaches placements there, and no others", async () => {
    const owned = await admin.deploymentTargets.create({ name: "route4-authz-target" });
    const here = await placedComponent("route4-authz-here", { at: owned });
    const elsewhere = await placedComponent("route4-authz-elsewhere");

    const operator = await createTestUser(server, org, [{ role: "Operator", scope: owned.id }]);

    const [overHere, overElsewhere] = await withTenantTx(server.deps.db, org.orgId, async (tx) => [
      await hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: here.placement.id
      }),
      await hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: operator.objectId,
        permission: "object:write",
        scopeObjectId: elsewhere.placement.id
      })
    ]);

    expect(
      overHere,
      "authority must track the governance chain: if a deployment-target now GOVERNS its placements, a role bound there must reach them too"
    ).toBe(true);
    expect(
      overElsewhere,
      "and must not leak to placements at other targets — the same containment asymmetry route 2 relies on"
    ).toBe(false);
  });

  it("a placement carrying a malformed deploymentTargetId answers instead of erroring the whole walk", async () => {
    // The SAME hazard as the componentId case, on the endpoint route 4 added. Both are cast to uuid,
    // so a guard on only one of them leaves the class half-fixed — which is the property this
    // codebase has been bitten by four times.
    const target = await admin.deploymentTargets.create({ name: "route4-malformed-target" });
    const { component, placement } = await placedComponent("route4-malformed", { at: target });
    await gatingPolicy("route4-malformed-gate", component.id);
    const change = await admin.changes.propose({
      name: "route4-malformed-change",
      targets: [component.id]
    });

    await writeMalformedEndpoint(placement.id, "deploymentTargetId");

    const outcome = await waveGate([placement.id], change.id);
    expect(
      outcome.verdict,
      "a malformed place must cost the placement its deployment-target ancestor and NOTHING else — the component route must still reach the gating policy"
    ).toBe("block");
  });
});

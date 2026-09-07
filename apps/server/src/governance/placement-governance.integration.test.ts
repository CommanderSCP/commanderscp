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

/** GOVERNANCE OVER A PLACEMENT WAVE TARGET. See docs/governance.md §263. */
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
    const component = await createOrphanComponent(server, org, `${label}-comp`);
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

  /** A required policy whose one effect is an uncast approval. See docs/governance.md §264. */
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

  it("a SERVICE-scoped freeze COVERS a placement wave target instead of failing open — and M25.2 relocated where that coverage is enforced", async () => {
    // REWRITTEN FOR M25.2, NOT RE-EXPECTED. See docs/governance.md §265.
    const { service, placement } = await placedComponent("svc-freeze", { service: true });
    const change = await admin.changes.propose({ name: "freeze-change", targets: [placement.id] });

    const now = Date.now();
    const freeze = await admin.freezes.create({
      scopeObjectId: service!.id,
      name: "placement-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "holiday code freeze"
    });

    const outcome = await waveGate([placement.id], change.id);

    // (a) THE RESOLVER — route 3 walked from the placement THROUGH its component to its service,
    // and the freeze declared there was found. This is the half that survives the relocation.
    expect(outcome.frozenTargets).toEqual([
      {
        targetObjectId: placement.id,
        freezes: [expect.objectContaining({ id: freeze.id, scopeObjectId: service!.id })]
      }
    ]);

    // (b) THE VERDICT — every target of this wave is covered, so the whole-wave block stands.
    expect(
      outcome.verdict,
      "an active freeze over the placement's service must still block a wave EVERY target of which it covers — failing open here is the exact bug graph/containment.ts was written to end"
    ).toBe("block");
    expect(outcome.inputContext.freeze).toMatchObject({ scopeObjectId: service!.id });

    // ...and the relocation itself: add an uncovered sibling and the WAVE is admitted while the
    // covered placement is still reported as covered — which is precisely what reconcile's
    // per-target loop then withholds (`freeze-admission.integration.test.ts` case A).
    const stranger = await placedComponent("svc-freeze-stranger");
    const partial = await waveGate([placement.id, stranger.placement.id], change.id);
    expect(
      partial.verdict,
      "M25.2: one covered target among two no longer parks the wave — enforcement moved to the per-target seam"
    ).toBe("allow");
    expect(
      partial.frozenTargets?.map((entry) => ({
        targetObjectId: entry.targetObjectId,
        frozen: entry.freezes.length > 0
      })),
      "the coverage did not disappear when the block did"
    ).toEqual([
      { targetObjectId: placement.id, frozen: true },
      { targetObjectId: stranger.placement.id, frozen: false }
    ]);
  });

  it("does NOT over-reach: a policy scoped at ANOTHER component leaves the placement ungated", async () => {
    const { placement } = await placedComponent("no-reach");
    const stranger = await createOrphanComponent(server, org, "no-reach-stranger");
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

  // ROUTE 4 — the deployment-target as a containing scope. See docs/governance.md §266.

  it("a policy scoped at a DEPLOYMENT-TARGET gates every placement there — and nothing anywhere else", async () => {
    const gated = await admin.deploymentTargets.create({ name: "route4-gated-target" });
    const here = await placedComponent("route4-here", { at: gated });
    const elsewhere = await placedComponent("route4-elsewhere");
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

  it("a freeze scoped at a DEPLOYMENT-TARGET covers what is placed there ('freeze prod'), and M25.2 ships the OTHER regions", async () => {
    // REWRITTEN FOR M25.2 in the same two halves as the service-scoped case above — read that
    // comment first. This one is route 4's only live coverage on the freeze path, and it is also
    // the literal shape the owner asked M25.2 for: freeze one region, ship the rest.
    const frozenPlace = await admin.deploymentTargets.create({ name: "route4-frozen-target" });
    const { placement } = await placedComponent("route4-freeze", { at: frozenPlace });
    const change = await admin.changes.propose({
      name: "route4-freeze-change",
      targets: [placement.id]
    });

    const now = Date.now();
    const freeze = await admin.freezes.create({
      scopeObjectId: frozenPlace.id,
      name: "prod-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "change freeze over the whole stage"
    });

    const outcome = await waveGate([placement.id], change.id);

    // (a) THE RESOLVER — route 4 put the DEPLOYMENT-TARGET on the placement's chain. Before it
    // existed a stage-scoped freeze had no expression at all: the walk never reached the place, so
    // the freeze matched nothing and the wave sailed through.
    expect(outcome.frozenTargets).toEqual([
      {
        targetObjectId: placement.id,
        freezes: [expect.objectContaining({ id: freeze.id, scopeObjectId: frozenPlace.id })]
      }
    ]);

    // (b) THE VERDICT — this wave's every target is at the frozen place, so it is still blocked
    // whole.
    expect(outcome.verdict).toBe("block");
    expect(outcome.inputContext.freeze).toMatchObject({ scopeObjectId: frozenPlace.id });

    // THE OWNER'S ASK, at the gate: a wave spanning the frozen region AND another one is admitted,
    // with the frozen region still reported as covered so reconcile's per-target loop withholds
    // exactly it. Before M25.2 this second call returned `block` and all four regions parked.
    const elsewhere = await placedComponent("route4-freeze-elsewhere");
    const partial = await waveGate([placement.id, elsewhere.placement.id], change.id);
    expect(
      partial.verdict,
      "freeze one region, ship the others — the wave gate must not park the unfrozen sibling"
    ).toBe("allow");
    expect(
      partial.frozenTargets?.map((entry) => ({
        targetObjectId: entry.targetObjectId,
        // M25.3 made `EffectiveFreeze` a tier union; this case is entirely org-tier (no instance
        // freeze exists on this instance), and narrowing here is what keeps that fact asserted
        // rather than assumed — a platform freeze leaking into this wave would produce `null`.
        scopes: entry.freezes.map((f) => (f.tier === "org" ? f.scopeObjectId : null))
      }))
    ).toEqual([
      { targetObjectId: placement.id, scopes: [frozenPlace.id] },
      { targetObjectId: elsewhere.placement.id, scopes: [] }
    ]);
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

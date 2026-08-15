import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";
import { resolveBindingForTarget, listVisibleBindingsForTarget } from "./binding-resolution.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Placement-aware executor-binding resolution (ADR-0026, amending ADR-0006).
 *
 * ============================================================================================
 * THE VACUITY THIS FILE IS BUILT AGAINST
 * ============================================================================================
 * A test asserting "resolution succeeded" passes for the wrong reason if the fixture only ever has
 * ONE placement — which is the state of all 61 placements on the estate today, and therefore the
 * state a fixture naturally falls into. It would then prove nothing about the case that actually
 * matters: TWO placements must FAIL, not resolve. This has bitten the ADR-0026 chain three times
 * (the placement race test passed with its unique index removed; the stage race test the same; the
 * cancellation-kind test examined an object that never reached the code under test), so every
 * positive case here has a two-placement sibling that asserts refusal.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | `candidates.length > 1` → `> 2` (pick the first instead of refusing) | "REFUSES two placements" fails |
 * | drop the direct-first check (always consult placements) | "direct wins over a placement" fails |
 * | `listVisibleBindingsForTarget` returns only the target's own | "case (a) does not swallow a placed binding" fails |
 * | placement lookup ignores `deleted_at` | "a withdrawn placement stops resolving" fails |
 * | fallback applied in `putExecutorBinding` too | "a write path stays literal" fails |
 */
/**
 * ============================================================================================
 * MUTATION LOG — ADR-0027 service rung (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | return `none` at the no-placements exit instead of the service rung | the PLACEMENT-target test FAILS. This is not hypothetical — it is the bug that shipped in the first draft: the rung was added at the `candidates.length === 0` exit only, so it never fired for a placement, which is exactly what stage-shaped compilation makes every wave target |
 * | raise `MAX_ANCESTOR_HOPS` from 3 to 99 | the hop-cap test FAILS — a binding 4 levels up resolves, so without it the cap is decoration |
 * | walk ancestors farthest-first instead of nearest-first | the nearest-wins test FAILS — a component would inherit the top-level binding over its own parent's, inverting D1 |
 * | let `ambiguous` fall through to the service | 3 tests FAIL — two placements bound for one Type is a refusal, not an absence, and the service must not rescue it (ADR-0027 D2) |
 * | `viaObjectTypeId: ancestor.typeId` -> `"service"` (the shipped defect) | BOTH real-assembly tests fail — a Decision would name an assembly a service |
 * | `containsParentOf` returns `typeId: "service"` instead of the parent's | same two fail — the type must be READ, not assumed |
 * | `ancestors.reverse()` (farthest ancestor first) | three tests fail, incl. hops 2-instead-of-1 — nearest-wins is load-bearing, not incidental |
 */
describe("placement-aware binding resolution", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let prod: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "binding-resolution");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: "br-gamma" });
    prod = await admin.deploymentTargets.create({ name: "br-prod" });
  });

  afterAll(async () => {
    await server?.close();
  });

  const bind = (targetId: string, instanceSuffix: string, type?: string) =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: `br-${instanceSuffix}`,
      ...(type ? { type: type as "configuration" | "image" } : {})
    });

  const resolve = (targetId: string, type?: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      resolveBindingForTarget(
        tx,
        org.orgId,
        targetId,
        (type as "configuration" | "image" | undefined) ?? "configuration"
      )
    );

  async function placedComponent(label: string, places: GraphObject[]) {
    const component = await createTestComponent(admin, { name: `${label}-comp` });
    const placements: GraphObject[] = [];
    for (const p of places) {
      placements.push(
        await admin.placements.create({ component: component.id, deploymentTarget: p.id })
      );
    }
    return { component, placements };
  }

  it("resolves DIRECTLY when the target carries its own binding — unchanged behaviour", async () => {
    const { component } = await placedComponent("direct", [gamma]);
    await bind(component.id, "direct-own");

    const r = await resolve(component.id);
    expect(r.outcome).toBe("direct");
    expect(r.viaPlacementObjectId).toBeNull();
  });

  it("a DIRECT binding wins over a placement's — the fallback never overrides", async () => {
    // Both exist and they are DIFFERENT instances, which is the only way this test can tell
    // precedence from mere resolution. Asserting only `outcome === "direct"` would pass with the
    // order reversed if the placement had no binding.
    const { component, placements } = await placedComponent("precedence", [gamma]);
    await bind(placements[0]!.id, "precedence-placement");
    await bind(component.id, "precedence-own");

    const r = await resolve(component.id);
    expect(r.outcome).toBe("direct");
    expect(r.binding?.pluginInstanceId).toBe("br-precedence-own");
  });

  it("falls back through ONE placement, and says it resolved indirectly", async () => {
    // The migration-safety case: the binding has moved off the component onto its placement, and
    // legacy compilation still names the component as the wave target.
    const { component, placements } = await placedComponent("fallback", [gamma]);
    await bind(placements[0]!.id, "fallback-placement");

    const r = await resolve(component.id);
    expect(r.outcome).toBe("via_placement");
    expect(r.binding?.pluginInstanceId).toBe("br-fallback-placement");
    expect(r.viaPlacementObjectId).toBe(placements[0]!.id);
  });

  it("REFUSES two placements carrying a binding — it does not pick one", async () => {
    // THE test. "Which Argo CD" is a function of where, and the component alone cannot answer it.
    // Resolving here would be the cross-product bug in a new place, with nothing to find it by.
    const { component, placements } = await placedComponent("ambiguous", [gamma, prod]);
    await bind(placements[0]!.id, "ambiguous-a");
    await bind(placements[1]!.id, "ambiguous-b");

    const r = await resolve(component.id);
    expect(r.outcome).toBe("ambiguous");
    expect(r.binding).toBeNull();
    // The refusal must NAME the competitors — the remediation is "make the wave target a placement",
    // which an operator cannot act on without knowing which places are competing.
    expect(
      r.outcome === "ambiguous" && r.candidates.map((c) => c.placementObjectId).sort()
    ).toEqual([placements[0]!.id, placements[1]!.id].sort());
  });

  it("two placements where only ONE is bound is NOT ambiguous — it is the migration's normal state", async () => {
    // Guards the refusal from being over-eager: ambiguity is about competing BINDINGS, not about
    // having several placements. A component placed at gamma and prod with only gamma bound is
    // exactly what the estate looks like mid-migration.
    const { component, placements } = await placedComponent("one-bound", [gamma, prod]);
    await bind(placements[0]!.id, "one-bound-gamma");

    const r = await resolve(component.id);
    expect(r.outcome).toBe("via_placement");
    expect(r.viaPlacementObjectId).toBe(placements[0]!.id);
  });

  it("resolves NOTHING when neither the target nor its placements are bound", async () => {
    const { component } = await placedComponent("unbound", [gamma]);
    const r = await resolve(component.id);
    expect(r.outcome).toBe("none");
    expect(r.binding).toBeNull();
  });

  it("a WITHDRAWN placement stops resolving — a tombstone is not a binding path", async () => {
    const { component, placements } = await placedComponent("withdrawn", [gamma]);
    await bind(placements[0]!.id, "withdrawn-placement");
    expect((await resolve(component.id)).outcome).toBe("via_placement");

    await admin.placements.delete(placements[0]!.id);

    const r = await resolve(component.id);
    expect(r.outcome).toBe("none");
  });

  it("case (a) must not swallow a placed binding — the visible set includes placements", async () => {
    // ADR-0006 case (a) is "nothing anywhere" and fake-succeeds. A component whose `configuration`
    // binding moved to its placement, receiving an `image` release, must read as case (b) — bound,
    // but not for this pipeline — not as zero-bindings. Reading only the target's own bindings here
    // is what would turn a masking gap back into a silent fake-success.
    const { component, placements } = await placedComponent("visible", [gamma]);
    await bind(placements[0]!.id, "visible-config", "configuration");

    const visible = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listVisibleBindingsForTarget(tx, org.orgId, component.id)
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.viaPlacementObjectId).toBe(placements[0]!.id);

    // ...and the `image` pipeline resolves nothing, which is what makes it case (b) rather than (a).
    expect((await resolve(component.id, "image")).outcome).toBe("none");
  });

  // ============================================================================================
  // ADR-0027 — the SERVICE rung. Infrastructure that serves a whole service (a cluster, a shared
  // database) is declared ONCE on the service instead of duplicated onto every component under it.
  // ============================================================================================

  async function servicedComponent(label: string, places: GraphObject[]) {
    const service = await admin.services.create({ name: `${label}-svc-${Date.now()}` });
    const component = await admin.components.create({
      name: `${label}-comp-${Date.now()}`,
      service: service.id
    });
    const placements: GraphObject[] = [];
    for (const p of places) {
      placements.push(
        await admin.placements.create({ component: component.id, deploymentTarget: p.id })
      );
    }
    return { service, component, placements };
  }

  it("falls back to the owning SERVICE when neither the target nor its placements are bound", async () => {
    const { service, component } = await servicedComponent("svc-rung", [gamma]);
    await bind(service.id, "svc-infra", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("via_service");
    expect(r.binding?.targetObjectId).toBe(service.id);
  });

  it("resolves from a PLACEMENT target too — the shape stage-shaped compilation actually produces", async () => {
    // THE CASE A NAIVE RUNG MISSES. `resolveBindingForTarget` has TWO exits that mean "no placement
    // binding": a component whose placements carry none, and a target that HAS no placements —
    // which is every placement, since a placement has none of its own. Wave targets are placements
    // under stage-shaped compilation, so a rung written at only the first exit would never fire on
    // the estate's real traffic.
    const { service, placements } = await servicedComponent("svc-rung-placement", [gamma]);
    await bind(service.id, "svc-infra-p", "infrastructure");

    const r = await resolve(placements[0]!.id, "infrastructure");
    expect(r.outcome).toBe("via_service");
    expect(r.binding?.targetObjectId).toBe(service.id);
  });

  it("MOST-SPECIFIC WINS — a placement's binding beats the service's", async () => {
    // ADR-0027 D1. Adding the rung must not change any resolution that already succeeds, so the
    // service is consulted only after the placement has nothing to say.
    const { service, component, placements } = await servicedComponent("svc-precedence", [gamma]);
    await bind(placements[0]!.id, "placement-wins", "infrastructure");
    await bind(service.id, "service-loses", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("via_placement");
    expect(r.binding?.targetObjectId).toBe(placements[0]!.id);
  });

  it("a DIRECT binding still wins over the service's", async () => {
    const { service, component } = await servicedComponent("svc-direct", [gamma]);
    await bind(component.id, "direct-wins", "infrastructure");
    await bind(service.id, "service-loses-2", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("direct");
    expect(r.binding?.targetObjectId).toBe(component.id);
  });

  it("AMBIGUOUS does not fall through to the service — a refusal is not an absence", async () => {
    // ADR-0027 D2. Two placements bound for one Type is unanswerable, and answering it from the
    // service would suppress exactly the refusal ADR-0026 exists to make.
    const { service, component, placements } = await servicedComponent("svc-ambiguous", [
      gamma,
      prod
    ]);
    await bind(placements[0]!.id, "amb-a", "infrastructure");
    await bind(placements[1]!.id, "amb-b", "infrastructure");
    await bind(service.id, "amb-service", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome, "the service must not rescue an ambiguous placement set").toBe("ambiguous");
    expect(r.binding).toBeNull();
  });

  it("still resolves NOTHING when the service carries no binding of this type either", async () => {
    const { service } = await servicedComponent("svc-none", [gamma]);
    await bind(service.id, "svc-wrong-type", "configuration");

    const { component } = await servicedComponent("svc-none-target", [gamma]);
    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("none");
    expect(service.id).toBeTruthy();
  });

  // ============================================================================================
  // ADR-0029 — the capped CONTAINMENT-ANCESTOR ladder, generalising ADR-0027's single service rung.
  // Infra scope IS the attachment point (intermediate-grouping D4), so resolution must find a
  // binding at whatever level it hangs — including the org.
  // ============================================================================================

  /** A `contains` chain of the given depth above a component, using SERVICES as the intermediate
   *  objects. The ladder is type-agnostic (ADR-0029 D4), so this exercises the walk regardless of
   *  what the `assembly` level ends up being called or typed. */
  /**
   * Loosens ONE registry row so `contains` accepts a service->service edge, then lets the REAL API
   * write it.
   *
   * The alternative — inserting the relationship row directly — fights every integrity column the
   * typed path fills in (`origin_domain_id`, `content_hash`, the cardinality assertion), and a
   * fixture that hand-rolls those is testing a shape the product would never produce. Loosening the
   * type registry instead means the edges under test are written by exactly the code that will write
   * them once nesting is allowed, and the ONLY thing faked is the one row the pending `assembly`
   * decision is going to change anyway.
   *
   * Safe to do here: integration isolation is per FILE (see #219), so this file's widened row cannot
   * reach another suite.
   */
  async function allowNestedContains() {
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      // WIDEN, never REPLACE. The first form of this surgery set to_types = ['service','component']
      // — silently DROPPING 'assembly' (migration 0055's real level) for every test that ran after
      // it, so any later `service -> assembly` edge 400'd with "does not allow 'assembly' as the
      // 'to' endpoint" purely as a function of test ORDER. The real-assembly tests only passed
      // because they happened to run first. Measured 2026-08-14 when the domain-local premise test
      // below landed after the hop-cap tests. Append 'service' to whatever the row already allows.
      await surgeon.query(
        `UPDATE relationship_types
            SET to_types = array_append(array_remove(to_types, 'service'), 'service')
          WHERE id = 'contains'`
      );
    } finally {
      await surgeon.end();
    }
  }

  async function nestedUnder(label: string, depth: number, places: GraphObject[]) {
    if (depth > 1) await allowNestedContains();
    const top = await admin.services.create({ name: `${label}-top-${Date.now()}` });
    let parent = top;
    const chain = [top];
    for (let i = 1; i < depth; i += 1) {
      const mid = await admin.services.create({ name: `${label}-mid${i}-${Date.now()}` });
      // PRIVILEGED FIXTURE SURGERY, and STILL deliberate after migration 0055 — but for a different
      // reason than when it was written, so read this rather than the history.
      //
      // 0055 settled the level: `assembly` is a real object type and `contains` legitimately accepts
      // `service -> assembly -> component`. What it did NOT do is allow arbitrary depth —
      // `assembly -> assembly` is refused outright (intermediate-grouping D2 caps the ladder at three
      // hops, and a refusal beats a number to argue about). So the shapes DEEPER than one intermediate
      // level, which the hop-cap tests need, cannot be built through the API at all — by design.
      //
      // Hence: the real-type case is tested with a REAL assembly and NO surgery (see the
      // `viaObjectTypeId` test below), and the surgery survives only for the depths that exist to
      // prove the CAP holds for a level nobody has added yet. ADR-0029 D4's ladder is type-agnostic,
      // which is what makes that a meaningful thing to test ahead of the level.
      await admin.relationships.create({ typeId: "contains", fromId: parent.id, toId: mid.id });
      chain.push(mid);
      parent = mid;
    }
    const component = await admin.components.create({
      name: `${label}-comp-${Date.now()}`,
      service: parent.id
    });
    const placements: GraphObject[] = [];
    for (const p of places) {
      placements.push(
        await admin.placements.create({ component: component.id, deploymentTarget: p.id })
      );
    }
    return { chain, top, immediate: parent, component, placements };
  }

  it("reports the ancestor's REAL type, so a Decision can name the level it actually used", async () => {
    // Built with a REAL assembly and NO fixture surgery — migration 0055 makes this the shape the
    // product produces. The point is `viaObjectTypeId`: before it, this resolution reported
    // `resolvedVia: "service"` with an ASSEMBLY's id, a false statement in an audit record.
    const service = await admin.services.create({ name: `real-asm-svc-${Date.now()}` });
    const assembly = await admin.assemblies.create({ name: `real-asm-${Date.now()}` });
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: assembly.id
    });
    const component = await admin.components.create({
      name: `real-asm-comp-${Date.now()}`,
      service: assembly.id
    });
    await bind(assembly.id, "assembly-cluster", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("via_service");
    expect(
      r.outcome === "via_service" ? r.viaObjectTypeId : null,
      "the level is read from the object — naming it 'service' here would be false"
    ).toBe("assembly");
    expect(r.outcome === "via_service" ? r.viaServiceObjectId : null).toBe(assembly.id);
    expect(r.outcome === "via_service" ? r.hops : null, "the immediate parent is one hop").toBe(1);
  });

  it("the NEAREST container wins: a real assembly beats the service above it", async () => {
    // Two bindings of the same Type at two levels. Without nearest-first this returns the service's,
    // which is the whole point of the ladder (ADR-0029 D1) and cannot be seen with only one binding.
    const service = await admin.services.create({ name: `near-svc-${Date.now()}` });
    const assembly = await admin.assemblies.create({ name: `near-asm-${Date.now()}` });
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: assembly.id
    });
    const component = await admin.components.create({
      name: `near-comp-${Date.now()}`,
      service: assembly.id
    });
    await bind(service.id, "outer-service-cluster", "infrastructure");
    await bind(assembly.id, "inner-assembly-cluster", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    // Asserted on the binding's OWN target, not on a label in the fixture: `bind` sets
    // `pluginInstanceId`, and checking `externalRef` here passed `null` into the comparison — a
    // green-for-nothing assertion of exactly the kind this file's header is written against.
    expect(r.binding?.targetObjectId, "the nearer declaration wins").toBe(assembly.id);
    expect(r.binding?.pluginInstanceId).toBe("br-inner-assembly-cluster");
    expect(r.outcome === "via_service" ? r.viaObjectTypeId : null).toBe("assembly");
    expect(r.outcome === "via_service" ? r.hops : null).toBe(1);
  });

  it("resolves from the ORG root — the rung ADR-0027 excluded", async () => {
    // intermediate-grouping D4: a cluster that serves the whole org is declared once, at the org.
    const orgRoot = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getOrgRootObjectId(tx, org.orgId)
    );
    await bind(orgRoot, "org-cluster", "infrastructure");

    const { component } = await nestedUnder("org-rung", 1, [gamma]);
    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("via_service");
    expect(r.binding?.targetObjectId).toBe(orgRoot);
    expect(
      r.outcome === "via_service" ? r.hops : null,
      "the org rung is the least specific there is, and says so"
    ).toBe(0);

    // Clean up so the org binding cannot leak into the other tests in this file.
    await admin.executors.deleteBinding(orgRoot, "infrastructure");
  });

  it("NEAREST ancestor wins — the immediate parent beats the one above it", async () => {
    const { top, immediate, component } = await nestedUnder("nearest", 2, [gamma]);
    expect(immediate.id).not.toBe(top.id);
    await bind(top.id, "far-loses", "infrastructure");
    await bind(immediate.id, "near-wins", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.binding?.targetObjectId).toBe(immediate.id);
    expect(r.outcome === "via_service" ? r.hops : null).toBe(1);
  });

  it("reaches a GRANDPARENT when the immediate parent carries nothing", async () => {
    const { top, component } = await nestedUnder("grandparent", 2, [gamma]);
    await bind(top.id, "grandparent-wins", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.binding?.targetObjectId).toBe(top.id);
    expect(r.outcome === "via_service" ? r.hops : null).toBe(2);
  });

  it("STOPS at the hop cap — a binding 4 levels up does not resolve", async () => {
    // The cap is 3 (intermediate-grouping D2), so the walk's cost is provable.
    const { top, component } = await nestedUnder("capped", 4, [gamma]);
    await bind(top.id, "beyond-the-cap", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(
      r.outcome,
      "a binding beyond the cap must not resolve — otherwise the cap is decoration"
    ).toBe("none");
  });

  it("resolves through the ladder from a PLACEMENT target too", async () => {
    const { top, placements } = await nestedUnder("ladder-placement", 2, [gamma]);
    await bind(top.id, "ladder-from-placement", "infrastructure");

    const r = await resolve(placements[0]!.id, "infrastructure");
    expect(r.binding?.targetObjectId).toBe(top.id);
  });

  it("a WRITE path stays literal — binding a component does not touch its placement's row", async () => {
    // `putExecutorBinding` uses the raw lookup on purpose. If it fell back, this upsert would find
    // the placement's binding and UPDATE it, silently moving the placement's executor and leaving
    // the component still unbound.
    const { component, placements } = await placedComponent("writepath", [gamma]);
    await bind(placements[0]!.id, "writepath-placement");

    await bind(component.id, "writepath-own");

    const placementBinding = await admin.executors.getBinding(placements[0]!.id);
    expect(placementBinding.pluginInstanceId).toBe("br-writepath-placement");
    const componentBinding = await admin.executors.getBinding(component.id);
    expect(componentBinding.pluginInstanceId).toBe("br-writepath-own");
  });

  it("GET .../binding answers for the component via its placement, rather than 404ing", async () => {
    // An operator debugging a deploy must see what reconcile will actually use. A 404 saying "no
    // binding configured" about a target that deploys perfectly well is worse than no answer.
    const { component, placements } = await placedComponent("readapi", [gamma]);
    await bind(placements[0]!.id, "readapi-placement");

    const viaApi = await admin.executors.getBinding(component.id);
    expect(viaApi.pluginInstanceId).toBe("br-readapi-placement");
  });

  it("GET .../binding REFUSES rather than picking when two placements compete", async () => {
    const { component, placements } = await placedComponent("readapi-ambig", [gamma, prod]);
    await bind(placements[0]!.id, "readapi-ambig-a");
    await bind(placements[1]!.id, "readapi-ambig-b");

    await expect(admin.executors.getBinding(component.id)).rejects.toThrow(/conflict/i);
  });

  // ============================================================================================
  // THE OUTPOST'S PREMISE (outpost-ui.md §9, owner question 2026-08-14): does the outpost need
  // service and assembly levels at all? Only if a DOMAIN-LOCAL container can carry shared domain
  // infra/config that its components inherit — the cluster shared by a whole domain-local service.
  // The ladder is generic on the `contains` edge and M20.5 makes locality inherit downward, so this
  // SHOULD compose, but the exact combination (ADR-0031 local container × ADR-0027/0029 rung
  // binding) had never been exercised. Measured here, because the whole outpost-catalog shape
  // rests on it.
  // ============================================================================================

  it("PREMISE: a DOMAIN-LOCAL service's rung-bound infra resolves for its (inheriting) components", async () => {
    const service = await admin.services.create({
      name: `local-svc-${randomUUID().slice(0, 8)}`,
      domainLocal: true
    });
    expect(service.domainLocal).toBe(true);
    // Created WITHOUT the flag — inherits locality at create (M20.5 §6a).
    const component = await admin.components.create({
      name: `local-comp-${randomUUID().slice(0, 8)}`,
      service: service.id
    });
    expect(component.domainLocal, "child must inherit the container's locality").toBe(true);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });

    // The shared domain cluster's IaC, declared ONCE at the service.
    await bind(service.id, "local-svc-infra", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(
      r.outcome,
      "a domain-local component must inherit its domain-local service's infra binding — " +
        "otherwise the outpost has no place to bind shared domain infra and the service/assembly " +
        "levels are dead weight there"
    ).toBe("via_service");
    expect(r.binding?.targetObjectId).toBe(service.id);
    expect(r.binding?.pluginInstanceId).toBe("br-local-svc-infra");
  });

  it("PREMISE (assembly rung): a DOMAIN-LOCAL assembly's binding resolves for the components it contains", async () => {
    // The assembly level is the finer-grained shared-infra container ("a cluster shared by this
    // assembly, not the whole service"); same composition, one rung down.
    const service = await admin.services.create({
      name: `local-asvc-${randomUUID().slice(0, 8)}`,
      domainLocal: true
    });
    const assembly = await admin.assemblies.create({ name: `local-asm-${randomUUID().slice(0, 8)}` });
    // service contains assembly (route 2), assembly contains component: use the same doors the
    // fixture and the ancestor-rung tests use.
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: assembly.id
    });
    const component = await admin.components.create({
      name: `local-acomp-${randomUUID().slice(0, 8)}`,
      service: assembly.id
    });
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await bind(assembly.id, "local-asm-infra", "infrastructure");

    const r = await resolve(component.id, "infrastructure");
    expect(r.outcome).toBe("via_service");
    expect(
      r.outcome === "via_service" ? r.viaObjectTypeId : null,
      "the Decision must name the rung honestly"
    ).toBe("assembly");
    expect(r.binding?.targetObjectId).toBe(assembly.id);
  });
});

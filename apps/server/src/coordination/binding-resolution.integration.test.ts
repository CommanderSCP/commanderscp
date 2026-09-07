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

/** Placement-aware executor-binding resolution. See docs/coordination.md §24. */
/** MUTATION LOG — ADR-0027 service rung. See docs/coordination.md §25. */
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
    // THE CASE A NAIVE RUNG MISSES. See docs/coordination.md §26.
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

  // The capped containment-ancestor ladder. See docs/coordination.md §27.

  /** A `contains` chain of the given depth above a component, using SERVICES as the intermediate
   *  objects. The ladder is type-agnostic (ADR-0029 D4), so this exercises the walk regardless of
   *  what the `assembly` level ends up being called or typed. */
  /** Loosens one registry row, then uses the real API. See docs/coordination.md §28. */
  async function allowNestedContains() {
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      // WIDEN, never REPLACE. See docs/coordination.md §29.
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
      // Privileged fixture surgery, deliberate for a new reason. See docs/coordination.md §30.
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

  // THE OUTPOST'S PREMISE. See docs/coordination.md §31.

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
    const assembly = await admin.assemblies.create({
      name: `local-asm-${randomUUID().slice(0, 8)}`
    });
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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { resolveBindingForTarget, listVisibleBindingsForTarget } from "./binding-resolution.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
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
});

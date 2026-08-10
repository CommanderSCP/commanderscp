import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { Decision, GraphObject } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Pipeline inheritance — which release topology a change gets, and FROM WHICH RUNG
 * (ADR-0026, post-import-configuration.md §5, owner decisions D4 / D15).
 *
 * ============================================================================================
 * WHY EVERY TEST HERE ASSERTS THE RUNG, NOT JUST THE TOPOLOGY
 * ============================================================================================
 * This module's tests have a specific vacuity hazard, and it is the same shape as one already
 * caught in this work: the placement race test passed with its unique index removed entirely,
 * because a *different* constraint happened to serialise the writes. Here, a test asserting only
 * "component X's change resolved topology T" passes when X's own edge resolved it, when X's
 * SERVICE's edge resolved it, and when the ORG DEFAULT resolved it — three different behaviours,
 * one green assertion. Precedence would be entirely unenforced and nothing would say so.
 *
 * So every case asserts the rung and the object the winning edge hung off, and each rung is proven
 * by REMOVING THE RUNG ABOVE IT while the lower rungs stay in place — a design that fails if
 * precedence inverts, rather than merely if resolution stops working.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | drop rung 1 (skip the target's own edge) | "own edge WINS over the service's" fails |
 * | drop rung 2 (skip the owning service) | "inherits from the owning service" fails |
 * | drop rung 3 (skip the org root) | both org-default tests fail, incl. the D4 walk-past |
 * | reorder rungs — try the service before the target's own | "own edge WINS" fails |
 * | `targets_disagree` → resolve to the first target's answer | "declines to inherit" fails |
 * | drop the `deleted_at IS NULL` filter on the edge | "detaching stops inheritance" fails |
 * | drop the soft-deleted-topology join filter | "a tombstoned topology is NO pipeline" fails |
 * | omit `rung` from the Decision | every rung assertion in this file fails |
 */
describe("pipeline inheritance: the three-rung walk (D15)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let orgRootId: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-resolution");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const roots = await admin.object("organization").list({ limit: 10 });
    orgRootId = roots.items[0]!.id;
  });

  afterAll(async () => {
    await server?.close();
  });

  const topology = (name: string) =>
    admin.object("release-topology").create({ name, properties: { waves: [] } });

  const attach = (fromId: string, toId: string) =>
    admin.relationships.create({ typeId: "releases_via", fromId, toId });

  /**
   * Attaches an ORG DEFAULT for the duration of `fn`, then detaches it.
   *
   * `releases_via` is `many_to_one`, so the org root may hold at most ONE outgoing edge — a case
   * that leaked its org default would 409 every later case that needs a different one, turning one
   * real failure into a cascade that hides which test actually broke. `finally` so a failing
   * assertion still cleans up.
   */
  async function withOrgDefault<T>(topologyId: string, fn: () => Promise<T>): Promise<T> {
    const edge = await attach(orgRootId, topologyId);
    try {
      return await fn();
    } finally {
      await admin.relationships.delete(edge.id);
    }
  }

  /** The `pipeline` block `proposeChange` writes onto the propose Decision. */
  function pipelineOf(decisions: Decision[]) {
    const propose = decisions.find(
      (d) => (d.inputContext as { trigger?: string }).trigger === "propose"
    );
    expect(propose, "every change must carry a propose Decision").toBeDefined();
    return (propose!.inputContext as { pipeline?: Record<string, unknown> }).pipeline ?? {};
  }

  async function proposeAndExplain(targets: string[], topologyIdOrUrn?: string) {
    const change = await admin.changes.propose({
      name: `chg-${Math.random().toString(36).slice(2, 10)}`,
      targets,
      ...(topologyIdOrUrn !== undefined ? { topology: topologyIdOrUrn } : {})
    });
    const explained = await admin.changes.explain(change.id);
    return { change: explained.change, pipeline: pipelineOf(explained.decisions) };
  }

  /** A component in its own fresh service, so each case's rungs are independent. */
  async function componentInFreshService(label: string): Promise<{
    component: GraphObject;
    service: GraphObject;
  }> {
    const service = await admin.services.create({ name: `${label}-svc` });
    const component = await createTestComponent(admin, {
      name: `${label}-comp`,
      service: service.id
    });
    return { component, service };
  }

  /** A component under an ASSEMBLY under a service (migration 0054). Returns all three so a test can
   *  attach a topology at whichever level it means. */
  async function componentUnderAssembly(label: string): Promise<{
    component: GraphObject;
    assembly: GraphObject;
    service: GraphObject;
  }> {
    const service = await admin.services.create({ name: `${label}-svc-${Date.now()}` });
    const assembly = await admin.object("assembly").create({
      name: `${label}-asm-${Date.now()}`
    });
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: assembly.id
    });
    const component = await admin.components.create({
      name: `${label}-comp-${Date.now()}`,
      service: assembly.id
    });
    return { component, assembly, service };
  }

  it("rung 2 is a LADDER — the ASSEMBLY's topology beats its service's", async () => {
    // intermediate-grouping D1, walk up nearest wins. Both levels are populated and point at
    // DIFFERENT topologies, which is the only way this can tell precedence from mere resolution.
    const { component, assembly, service } = await componentUnderAssembly("ladder-near");
    const asmPipeline = await topology(`asm-near-${Date.now()}`);
    const svcPipeline = await topology(`svc-far-${Date.now()}`);
    await attach(service.id, svcPipeline.id);
    await attach(assembly.id, asmPipeline.id);

    const { change, pipeline } = await proposeAndExplain([component.id]);
    expect(change.topologyObjectId).toBe(asmPipeline.id);
    expect(
      pipeline.attachedToObjectId,
      "the rung enum still says 'service', so the attached-to object is what names the real level"
    ).toBe(assembly.id);
  });

  it("reaches the SERVICE through an assembly that carries nothing", async () => {
    // The quiet failure this replaces: reading ONE `contains` edge meant a component under an
    // assembly inherited NOTHING from its service and released as a single anonymous wave.
    const { component, service } = await componentUnderAssembly("ladder-through");
    const svcPipeline = await topology(`svc-through-${Date.now()}`);
    await attach(service.id, svcPipeline.id);

    const { change, pipeline } = await proposeAndExplain([component.id]);
    expect(change.topologyObjectId).toBe(svcPipeline.id);
    expect(pipeline.attachedToObjectId).toBe(service.id);
  });

  it("rung 1 — the target's OWN edge WINS over its service's", async () => {
    // Both rungs are populated and they point at DIFFERENT topologies, which is the only way this
    // test can tell precedence from mere resolution. Asserting the topology alone would pass with
    // the rungs in either order.
    const { component, service } = await componentInFreshService("r1");
    const own = await topology("r1-own");
    const svcPipeline = await topology("r1-service");
    await attach(service.id, svcPipeline.id);
    await attach(component.id, own.id);

    const { change, pipeline } = await proposeAndExplain([component.id]);
    expect(change.topologyObjectId).toBe(own.id);
    expect(pipeline.rung).toBe("component");
    expect(pipeline.attachedToObjectId).toBe(component.id);
  });

  it("rung 2 — with no edge of its own, it inherits from the OWNING SERVICE", async () => {
    // Rung 1 removed relative to the case above; rung 3 is populated too, so this also proves the
    // service beats the org default rather than merely beating nothing.
    const { component, service } = await componentInFreshService("r2");
    const svcPipeline = await topology("r2-service");
    const orgPipeline = await topology("r2-org");
    await attach(service.id, svcPipeline.id);

    await withOrgDefault(orgPipeline.id, async () => {
      const { change, pipeline } = await proposeAndExplain([component.id]);
      expect(change.topologyObjectId).toBe(svcPipeline.id);
      expect(pipeline.rung).toBe("service");
      expect(pipeline.attachedToObjectId).toBe(service.id);
    });
  });

  it("rung 3 (D4) — it walks PAST a service that has no pipeline, to the org default", async () => {
    // D4 in one assertion: "inheritance walks past the owning service". A walk that STOPPED at the
    // owning service because that service exists would resolve nothing here, and the org default
    // would be dead configuration.
    const { component, service } = await componentInFreshService("r3");
    const orgPipeline = await topology("r3-org");

    await withOrgDefault(orgPipeline.id, async () => {
      const { change, pipeline } = await proposeAndExplain([component.id]);
      expect(change.topologyObjectId).toBe(orgPipeline.id);
      expect(pipeline.rung).toBe("organization");
      expect(pipeline.attachedToObjectId).toBe(orgRootId);
      expect(pipeline.attachedToObjectId).not.toBe(service.id);
    });
  });

  it("an explicit --topology beats every rung, and says so", async () => {
    const { component, service } = await componentInFreshService("explicit");
    const own = await topology("explicit-own");
    const chosen = await topology("explicit-chosen");
    await attach(service.id, own.id);
    await attach(component.id, own.id);

    const { change, pipeline } = await proposeAndExplain([component.id], chosen.id);
    expect(change.topologyObjectId).toBe(chosen.id);
    expect(pipeline.rung).toBe("explicit");
  });

  it("resolves to NOTHING when no rung has an edge — and records why", async () => {
    const { component } = await componentInFreshService("empty");
    const { change, pipeline } = await proposeAndExplain([component.id]);
    expect(change.topologyObjectId).toBeNull();
    expect(pipeline.rung).toBeNull();
    expect(pipeline.reason).toBe("no_pipeline");
  });

  it("DETACHING the edge stops inheritance — a soft-deleted edge is not a pipeline", async () => {
    const { component } = await componentInFreshService("detach");
    const own = await topology("detach-own");
    const edge = await attach(component.id, own.id);

    const before = await proposeAndExplain([component.id]);
    expect(before.change.topologyObjectId).toBe(own.id);

    await admin.relationships.delete(edge.id);

    const after = await proposeAndExplain([component.id]);
    expect(after.change.topologyObjectId).toBeNull();
    expect(after.pipeline.reason).toBe("no_pipeline");
  });

  it("a TOMBSTONED topology is no pipeline — a change is never born pointing at one", async () => {
    // The edge survives the topology's deletion (nothing cascades in this graph — the same fact the
    // placement work hit). Without the join's `deleted_at` filter this resolves a topology id that
    // every later read fails to load, which is worse than resolving nothing.
    const { component } = await componentInFreshService("tombstone");
    const doomed = await topology("tombstone-topology");
    await attach(component.id, doomed.id);
    await admin.object("release-topology").delete(doomed.id);

    const { change, pipeline } = await proposeAndExplain([component.id]);
    expect(change.topologyObjectId).toBeNull();
    expect(pipeline.reason).toBe("no_pipeline");
  });

  it("multi-target: agreeing targets inherit; the rung is recorded once", async () => {
    const service = await admin.services.create({ name: "multi-agree-svc" });
    const a = await createTestComponent(admin, { name: "multi-a", service: service.id });
    const b = await createTestComponent(admin, { name: "multi-b", service: service.id });
    const svcPipeline = await topology("multi-agree");
    await attach(service.id, svcPipeline.id);

    const { change, pipeline } = await proposeAndExplain([a.id, b.id]);
    expect(change.topologyObjectId).toBe(svcPipeline.id);
    expect(pipeline.rung).toBe("service");
  });

  it("multi-target: DISAGREEING targets inherit nothing, and the Decision names each one", async () => {
    // No non-arbitrary winner exists, and silently taking the first target's pipeline would order a
    // release for the other target through a pipeline nobody attached to it.
    const one = await componentInFreshService("disagree-one");
    const two = await componentInFreshService("disagree-two");
    const p1 = await topology("disagree-p1");
    const p2 = await topology("disagree-p2");
    await attach(one.component.id, p1.id);
    await attach(two.component.id, p2.id);

    const { change, pipeline } = await proposeAndExplain([one.component.id, two.component.id]);
    expect(change.topologyObjectId).toBeNull();
    expect(pipeline.reason).toBe("targets_disagree");

    // Explainability (principle 6): an operator must be able to see WHICH targets wanted what,
    // otherwise "targets disagree" is an unactionable dead end.
    const perTarget = pipeline.perTarget as { targetObjectId: string; topologyObjectId: string }[];
    expect(perTarget).toHaveLength(2);
    expect(perTarget.find((t) => t.targetObjectId === one.component.id)!.topologyObjectId).toBe(
      p1.id
    );
    expect(perTarget.find((t) => t.targetObjectId === two.component.id)!.topologyObjectId).toBe(
      p2.id
    );
  });

  it("multi-target: one target with NO pipeline is a disagreement, not a majority vote", async () => {
    const withPipeline = await componentInFreshService("partial-yes");
    const without = await componentInFreshService("partial-no");
    const p = await topology("partial-p");
    await attach(withPipeline.component.id, p.id);

    const { change, pipeline } = await proposeAndExplain([
      withPipeline.component.id,
      without.component.id
    ]);
    expect(change.topologyObjectId).toBeNull();
    expect(pipeline.reason).toBe("targets_disagree");
  });

  it("a component with no service still reaches the org default", async () => {
    // Rung 2 is absent entirely rather than empty. An implementation that required a service to
    // continue the walk would strand every not-yet-organized import on no pipeline.
    const orphan = await createOrphanComponent(admin, "orphan-no-service");
    const orgPipeline = await topology("orphan-org");

    await withOrgDefault(orgPipeline.id, async () => {
      const { change, pipeline } = await proposeAndExplain([orphan.id]);
      expect(change.topologyObjectId).toBe(orgPipeline.id);
      expect(pipeline.rung).toBe("organization");
    });
  });

  it("the org root accepts a `releases_via` edge at all (migration 0052 endpoint types)", async () => {
    // 0049 registered `from_types = ['component']` only. Without 0052 widening it, attaching the
    // org default is a 400 and rung 3 is unreachable no matter how correct the walk is.
    const orgPipeline = await topology("endpoint-org");
    await withOrgDefault(orgPipeline.id, async () => {
      const edges = await admin.relationships.list({
        typeId: "releases_via",
        fromId: orgRootId
      });
      expect(edges.items).toHaveLength(1);
    });

    const service = await admin.services.create({ name: "endpoint-svc" });
    const svcPipeline = await topology("endpoint-svc-topology");
    const svcEdge = await attach(service.id, svcPipeline.id);
    expect(svcEdge.fromId).toBe(service.id);
  });

  it("still refuses a nonsense endpoint — widening is not opening", async () => {
    // 0052 adds `service` and `organization`, NOT "anything". A deployment-target with a pipeline
    // would be attach-but-never-resolve configuration, which is exactly what 0049 deliberately
    // avoided by registering `component` alone in the first place.
    const target = await admin.deploymentTargets.create({ name: "endpoint-nonsense-target" });
    const t = await topology("endpoint-nonsense");
    await expect(attach(target.id, t.id)).rejects.toThrow();
  });
});

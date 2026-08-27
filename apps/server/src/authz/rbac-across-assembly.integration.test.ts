import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { hasPermission, type Permission } from "./resolve.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * RBAC ACROSS AN ASSEMBLY — the two-hop `contains` chain (role-model.md §1.4, build step 2)
 * ================================================================================================
 *
 * THE CLAIM THIS FILE PINS. `scopeExpandCte` (`authz/resolve.ts`) walks the `contains` edge with
 * **no predicate on either endpoint's type**, and migration 0055 registered `contains` as
 * `from_types = ['service','assembly']`, `to_types = ['assembly','component']`. Those two facts
 * together mean `service -> assembly -> component` chains for free, at depths 1 AND 2. That is why
 * 0055 shipped no edit to the resolver at all, and it is why role-model.md §7.1's ruling that
 * *"assembly & component share a role"* (ComponentAdmin, `bindable_at: assembly, component`) costs
 * nothing structurally: bound at an assembly, the role reaches that assembly's components through
 * this walk and no new code.
 *
 * A role design resting on a behaviour that was never asserted is a role design resting on a
 * reading of a SQL fragment. This file makes the behaviour a gate.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS WAS NOT ALREADY COVERED — the exact shape of a vacuous test
 * ------------------------------------------------------------------------------------------------
 * A filterless census (`grep -rna`, per CLAUDE.md) of every role binding in any assembly-bearing
 * test found ONE, and it was checked at the assembly ITSELF — a **depth-0 self-match**, which the
 * seed row of `scope_expand` satisfies before the recursive term runs even once. Such a test passes
 * with the entire `contains` arm deleted from the LATERAL. It reads as coverage of the `contains`
 * route and is coverage of nothing but the seed.
 *
 * That is not a hypothetical failure mode here. `graph/containment.ts`'s header records that two
 * hand-synced copies of this same walk DID drift, and the two symptoms were opposite — a
 * service-scoped freeze that failed **OPEN** and a service-scoped `requireApprovals` that failed
 * **CLOSED** — from one root cause. `scopeExpandCte` is still hand-synced with that file on routes
 * 1 and 2 by design (it is a fragment composed into a larger query and cannot consume row output).
 * So the only thing standing between a future edit and a silent authority change is a test that
 * fails when the arm goes away. Every assertion below was measured against exactly that mutation —
 * see the MUTATION LOG.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS FILE ADDS OVER THE TWO NEIGHBOURS THAT ALSO TOUCH `contains`
 * ------------------------------------------------------------------------------------------------
 * - `authz/service-scope.integration.test.ts` — the ONE-hop `service -> component` grant, at the
 *   real doors. It has no assembly anywhere: every chain in it is a single edge, so a walk bounded
 *   at depth 1 passes it entirely.
 * - `authz/inverse-walk-drift.integration.test.ts` — has a `route 2 … TWO HOPS` case over a
 *   generated estate, and it is the closest thing in the tree to this file. It asserts the two-hop
 *   grant at the **primitive** (`hasPermission`) and at the **downward filter**
 *   (`readableObjectFilterFor`), because its subject is the INVERSE-WALK INVARIANT
 *   (`hasPermission(S,O) ⟺ O ∈ readableSet(S)`), not the chain. Its only HTTP door is the LIST
 *   pagination case.
 *
 *   This file is deliberately the other half: the two-hop chain **through the real get-by-id and
 *   PATCH doors**, plus the two asymmetries that neighbour does not build a fixture for — a
 *   **SIBLING ASSEMBLY** under the same service (it has one sibling *service* and no sibling
 *   assembly), and a **component-bound** subject failing to reach the assembly above it (it checks
 *   assembly-bound -> service, one rung higher).
 *
 *   Overlap is real and is not a reason to drop either: the two-hop primitive assertion appears in
 *   both. Deleting it here would leave the door cases resting on a claim proved in a file whose
 *   fixture is regenerated from `SCP_DRIFT_SEED` and whose stated purpose is a different invariant.
 *
 * ------------------------------------------------------------------------------------------------
 * THE ASYMMETRY IS THE SECURITY PROPERTY, NOT AN IMPLEMENTATION DETAIL
 * ------------------------------------------------------------------------------------------------
 * `contains` is registered service -> component and walked BACKWARDS here (`r.to_id` is the object
 * being checked, `r.from_id` its parent). So authority flows DOWN and only down:
 *
 *   - a binding at a service reaches every assembly and component beneath it;
 *   - a binding at an assembly reaches its own components and **nothing sideways** — not a sibling
 *     assembly, not a sibling assembly's components;
 *   - a binding at a component reaches **nothing upward** — not its assembly, not its service.
 *
 * If the walk were ever "fixed" to be symmetric, the component's own operator would inherit the
 * service, and every ComponentAdmin in the estate would silently become a ServiceAdmin. The
 * negative cases below are therefore not padding; they are the half that cannot be recovered by
 * re-reading the code, because a too-permissive walk still passes every positive assertion.
 *
 * ------------------------------------------------------------------------------------------------
 * THE FIXTURE — built through the REAL API (every object has a door, so nothing is hand-inserted)
 * ------------------------------------------------------------------------------------------------
 *
 *   org root
 *   └── domain D                                   (route 1: objects.domain_id)
 *       ├── service S      --contains-->  assembly A1  --contains-->  component C1
 *       │                                                             └── placement P1 (at target T)
 *       │                  --contains-->  assembly A2  --contains-->  component C2
 *       └── service S2     --contains-->  assembly A3  --contains-->  component C3
 *
 * Assemblies, components and placements take no `domainId`, so `objects-repo.ts` roots them at the
 * ORG ROOT — route 1 gives them the org root and nothing else. Their only path to S, D or each
 * other is the `contains` edge under test. That is deliberate: if the fixture parented C1 under D
 * via `domainId`, a service binding could reach it by route 1 and the `contains` mutation below
 * would not go red.
 *
 * The MUTATION LOG below records what each of those assertions was measured against.
 */

/**
 * MUTATION LOG — each applied ALONE to `authz/resolve.ts`, measured 2026-08-26, then reverted.
 *
 * A test that survives mutation 1 is measuring the seed row of `scope_expand` and nothing else. A
 * test that survives mutation 2 is measuring the PRESENCE of the arm rather than the DEPTH of the
 * walk — the subtler failure, and the one the depth-0 self-match described above hides behind. Both
 * were run; the second is the one that shaped this file's structure.
 *
 * | # | Mutation applied to `scopeExpandCte` | Measured result |
 * |---|---|---|
 * | 1 | DELETE the `contains` arm (`SELECT r.from_id … type_id = 'contains'`) from the LATERAL | **9 of 13 fail.** Headline: `AssertionError: the SERVICE binding must reach the component two hops down, under an assembly: expected false to be true`. Every positive case goes with it — one-hop, two-hop, three-hop, and all four doors (`ScpApiError: Forbidden`). The four NEGATIVE tests stay GREEN, which is exactly why they are here and also exactly why they can never be the proof: a walk that grants nothing satisfies every "must not reach" claim ever written. |
 * | 2 | BOUND the `contains` walk at ONE hop (`AND se.depth = 0` on that arm) | **4 fail, and precisely the right 4.** Red: the two-hop primitive, the three-hop placement case, `DOOR (read, TWO HOPS)` and `DOOR (write) … two hops up`. GREEN: `ONE HOP from the service`, `ONE HOP: a binding at the ASSEMBLY …`, and `DOOR (read, ONE HOP)`. That green/red split is the proof the assertions measure DEPTH. |
 *
 * ⚠️ MUTATION 2 WAS FIRST ATTEMPTED THE OBVIOUS WAY AND THAT WAY IS USELESS HERE. Setting
 * `scopeExpandCte`'s shared bound to 1 outright (`maxDepth: number = 1`) does not fail these tests
 * — it fails `beforeAll`, at `relationships.create`, with all 13 SKIPPED. The org bootstrap admin
 * is bound at the ORG ROOT, and a service sits two hops below it (`service -> domain -> org root`),
 * so a globally-bounded walk stops the FIXTURE from being built through the real API and the suite
 * reports a red that says nothing about the property. Anyone re-running this log should mutate the
 * ARM, not the shared bound; a "13 skipped" run is that mistake, not a discovery.
 */

describe("RBAC across an assembly: `service -> assembly -> component` (role-model.md §1.4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  /** The chain under test, plus the siblings that pin the asymmetry. */
  let tree: {
    domain: string;
    service: string;
    assembly: string;
    component: string;
    placement: string;
    target: string;
    /** A SECOND assembly under the SAME service — the lateral case. */
    siblingAssembly: string;
    siblingComponent: string;
    /** A second service under the same domain, with its own assembly + component. */
    otherService: string;
    otherAssembly: string;
    otherComponent: string;
  };

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  /** The PRIMITIVE, at one object. `object:read` unless a case is specifically about writing. */
  async function can(
    subjectObjectId: string,
    scopeObjectId: string,
    permission: Permission = "object:read"
  ): Promise<boolean> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, { orgId: org.orgId, subjectObjectId, permission, scopeObjectId })
    );
  }

  /** A logged-in client for a user holding exactly ONE built-in role at exactly ONE scope. */
  async function principal(
    role: "Viewer" | "Operator",
    scope: string
  ): Promise<{ objectId: string; client: ScpClient }> {
    const user = await createTestUser(server, org, [{ role, scope }]);
    return {
      objectId: user.objectId,
      client: new ScpClient({ baseUrl: server.baseUrl, token: user.token })
    };
  }

  /** The status of a refusal, asserted as a NUMBER — `rejects.toThrow(/forbidden/i)` would also be
   *  satisfied by a 404 whose detail happens to say "forbidden", and a door that 404s where it
   *  should 403 is a different bug with the same test outcome. */
  async function statusOf(call: Promise<unknown>): Promise<number | string> {
    try {
      await call;
      return "resolved (no error thrown)";
    } catch (err) {
      if (err instanceof ScpApiError && err.status !== undefined) return err.status;
      return `${(err as Error).name}: ${(err as Error).message}`;
    }
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "assembly-rbac");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = (await admin.object("domain").create({ name: uniq("domain") })).id;
    const service = (await admin.services.create({ name: uniq("service"), domainId: domain })).id;
    const otherService = (
      await admin.services.create({ name: uniq("other-svc"), domainId: domain })
    ).id;

    // `contains` is registered service -> assembly by migration 0055; the relationships door is the
    // only way to declare that edge, so the fixture uses it rather than writing a row.
    const assembly = (await admin.assemblies.create({ name: uniq("assembly") })).id;
    const siblingAssembly = (await admin.assemblies.create({ name: uniq("sibling-asm") })).id;
    const otherAssembly = (await admin.assemblies.create({ name: uniq("other-asm") })).id;
    for (const [from, to] of [
      [service, assembly],
      [service, siblingAssembly],
      [otherService, otherAssembly]
    ] as const) {
      await admin.relationships.create({ typeId: "contains", fromId: from, toId: to });
    }

    // `components.create({ service })` writes the component AND its `contains` edge atomically, and
    // 0055's `to_types` admits an ASSEMBLY as that parent — the second hop, declared the way a real
    // caller declares it.
    const component = (
      await admin.components.create({ name: uniq("component"), service: assembly })
    ).id;
    const siblingComponent = (
      await admin.components.create({ name: uniq("sibling-comp"), service: siblingAssembly })
    ).id;
    const otherComponent = (
      await admin.components.create({ name: uniq("other-comp"), service: otherAssembly })
    ).id;

    const target = (await admin.deploymentTargets.create({ name: uniq("target") })).id;
    const placement = (await admin.placements.create({ component, deploymentTarget: target })).id;

    tree = {
      domain,
      service,
      assembly,
      component,
      placement,
      target,
      siblingAssembly,
      siblingComponent,
      otherService,
      otherAssembly,
      otherComponent
    };
  });

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // 1. THE HEADLINE — two hops, at the primitive.
  // ---------------------------------------------------------------------------------------------

  /**
   * Hop 1 and hop 2 are SEPARATE tests on purpose, and the separation is what makes the depth
   * mutation legible. Asserted together in one `it`, the hop-1 `expect` short-circuits the hop-2
   * one, so a walk bounded at depth 1 would report "must reach the assembly one hop down" — a
   * message that names the assertion that STILL HOLDS. Split, the failing test names the hop that
   * actually broke, and the pair reads as a measurement of depth rather than of presence.
   */
  it("ONE HOP from the service: the SERVICE binding reaches the assembly it contains", async () => {
    const { objectId: subject } = await principal("Viewer", tree.service);
    expect(await can(subject, tree.service), "at its own scope, depth 0").toBe(true);
    expect(
      await can(subject, tree.assembly),
      "the SERVICE binding must reach the assembly one hop down"
    ).toBe(true);
  });

  it("TWO HOPS: a binding at the SERVICE grants over a component under an ASSEMBLY", async () => {
    // THE CLAIM. §1.4's "chains for free", and the reason ComponentAdmin can be bound at an
    // assembly without the resolver knowing an assembly exists.
    const { objectId: subject } = await principal("Viewer", tree.service);
    expect(
      await can(subject, tree.component),
      "the SERVICE binding must reach the component two hops down, under an assembly"
    ).toBe(true);
  });

  it("THREE HOPS: the same service binding reaches the placement below that component", async () => {
    // service -> assembly -> component -> placement: route 2 twice, then route 3
    // (`placementParentsSql`, shared with `graph/containment.ts`). Pinned because the composition of
    // routes across a chain is what a depth bound truncates FIRST, and a placement is where a
    // release is actually coordinated.
    const { objectId: subject } = await principal("Viewer", tree.service);
    expect(
      await can(subject, tree.placement),
      "the SERVICE binding must reach the placement three hops down"
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // 2. ONE HOP — "assembly & component share a role" (role-model.md §7.1 role E, ComponentAdmin).
  // ---------------------------------------------------------------------------------------------

  it("ONE HOP: a binding at the ASSEMBLY grants over its own components", async () => {
    const { objectId: subject } = await principal("Viewer", tree.assembly);
    expect(await can(subject, tree.assembly), "at its own scope, depth 0").toBe(true);
    expect(
      await can(subject, tree.component),
      "the ASSEMBLY binding must reach its own component one hop down"
    ).toBe(true);
    // This test stays GREEN under the depth-1 mutation. That is deliberate: read beside the two-hop
    // case above, the pair is what distinguishes "the arm exists" from "the walk goes deep enough".
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE ASYMMETRY — the half a too-permissive walk still passes every positive test with.
  // ---------------------------------------------------------------------------------------------

  it("NO LATERAL LEAK: an assembly binding does not reach a SIBLING assembly or its components", async () => {
    const { objectId: subject } = await principal("Viewer", tree.assembly);
    expect(
      await can(subject, tree.siblingAssembly),
      "a sibling assembly is not below this one — both are below the SERVICE"
    ).toBe(false);
    expect(
      await can(subject, tree.siblingComponent),
      "nor is the sibling assembly's component"
    ).toBe(false);
  });

  it("NO UPWARD LEAK: an assembly binding does not reach the SERVICE that contains it", async () => {
    const { objectId: subject } = await principal("Viewer", tree.assembly);
    // `contains` is walked to_id -> from_id; a service has no incoming `contains` edge, so it is
    // never an element of any descendant's `scope_expand`.
    expect(await can(subject, tree.service)).toBe(false);
    expect(await can(subject, tree.domain), "nor the domain above the service").toBe(false);
    expect(await can(subject, org.orgId), "nor the org root").toBe(false);
  });

  it("NO UPWARD LEAK: a COMPONENT binding reaches neither its assembly nor its service", async () => {
    const { objectId: subject } = await principal("Viewer", tree.component);
    expect(await can(subject, tree.component), "its own scope, depth 0").toBe(true);
    expect(
      await can(subject, tree.assembly),
      "the assembly is ABOVE the component — one rung of upward leak is still full authority over " +
        "every sibling component"
    ).toBe(false);
    expect(await can(subject, tree.service), "and the service two rungs above").toBe(false);
    expect(
      await can(subject, tree.siblingComponent),
      "nor a component under a sibling assembly"
    ).toBe(false);
  });

  it("NO CROSS-SERVICE LEAK: a service binding stops at its own subtree", async () => {
    const { objectId: subject } = await principal("Viewer", tree.service);
    for (const [label, id] of [
      ["the sibling service", tree.otherService],
      ["its assembly", tree.otherAssembly],
      ["its component", tree.otherComponent]
    ] as const) {
      expect(
        await can(subject, id),
        `${label} is under the same DOMAIN, not under this service`
      ).toBe(false);
    }
    // …and the domain binding that DOES contain both still does, so the negatives above are about
    // the `contains` route, not about the fixture being disconnected.
    const { objectId: atDomain } = await principal("Viewer", tree.domain);
    expect(await can(atDomain, tree.otherService)).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // 4. THE REAL DOORS — the layer that actually decides what a caller gets.
  //
  // `hasPermission` is the primitive; a door is where it is (or is not) called with the right
  // scope. CLAUDE.md's "component built, never installed" class lives exactly in that gap, so the
  // property is pinned at BOTH layers or it is pinned at neither.
  // ---------------------------------------------------------------------------------------------

  it("DOOR (read, ONE HOP): `GET /assemblies/{id}` admits a SERVICE-scoped Viewer", async () => {
    // Split from the two-hop case below for the same reason the primitive pair is split: this half
    // must stay GREEN under a depth-1 bound, or the door layer cannot tell depth from presence.
    const { client } = await principal("Viewer", tree.service);
    expect((await client.assemblies.get(tree.assembly)).id).toBe(tree.assembly);
  });

  it("DOOR (read, TWO HOPS): `GET /components/{id}` admits a SERVICE-scoped Viewer up the chain", async () => {
    // `routes/components.ts` authorizes `object:read` at the component's OWN id, so admission here
    // is `scopeExpandCte` walking two `contains` edges and nothing else.
    const { client } = await principal("Viewer", tree.service);
    expect((await client.components.get(tree.component)).id).toBe(tree.component);
  });

  it("DOOR (read): the same door REFUSES a sibling assembly's component with 403", async () => {
    const { client } = await principal("Viewer", tree.assembly);
    expect((await client.components.get(tree.component)).id).toBe(tree.component);
    expect(
      await statusOf(client.components.get(tree.siblingComponent)),
      "a component under a sibling assembly must be forbidden, not served"
    ).toBe(403);
    expect(
      await statusOf(client.services.get(tree.service)),
      "and the service above must be forbidden — `contains` is walked backwards"
    ).toBe(403);
  });

  it("DOOR (write): `PATCH /components/{id}` admits a SERVICE-scoped Operator two hops up", async () => {
    const { client } = await principal("Operator", tree.service);
    // A WRITE, not a read: `object:write` resolves through the identical `scopeExpandCte`, but a
    // grant that only ever admitted reads would still be a design that cannot express
    // "ServiceAdmin operates everything beneath the service" (role-model.md §7.1 role D).
    const updated = await client.components.update(tree.component, { labels: { tier: "gold" } });
    expect(updated.labels).toMatchObject({ tier: "gold" });
  });

  it("DOOR (write): an ASSEMBLY-scoped Operator cannot write a sibling assembly's component", async () => {
    const { client } = await principal("Operator", tree.assembly);
    await expect(
      client.components.update(tree.component, { labels: { tier: "silver" } })
    ).resolves.toBeTruthy();
    expect(
      await statusOf(client.components.update(tree.siblingComponent, { labels: { x: "1" } }))
    ).toBe(403);
  });
});

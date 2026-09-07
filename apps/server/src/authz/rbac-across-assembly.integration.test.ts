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

/** RBAC ACROSS AN ASSEMBLY. See docs/authz.md §33. */

/** Mutation log: each applied alone, measured, then reverted. See docs/authz.md §34. */

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

  /** Hops are separate tests so a depth mutation stays legible. See docs/authz.md §35. */
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

  // 4. THE REAL DOORS. See docs/authz.md §36.

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

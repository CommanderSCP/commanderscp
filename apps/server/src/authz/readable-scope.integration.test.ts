import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, roleBindings, roles } from "../db/schema.js";
import { hasPermission } from "./resolve.js";
import {
  partitionReadableRoots,
  readableObjectFilterFor,
  readableObjectFilterSql,
  readableRootsFor
} from "./readable-scope.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  insertMalformedEffectRoleBinding,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE DOWNWARD HALF OF RBAC — `authz/readable-scope.ts` (role-model.md §8.2, increment 2.5b)
 * ================================================================================================
 *
 * `scopeExpandCte` expands UPWARD, which answers "may this subject read THIS object?" and cannot
 * answer "which objects may it list?". This file is the behavioural gate for the downward walk that
 * does, and for the four silent-failure hazards §8.3 names. Each hazard ships a working-looking bug
 * if missed, so each gets its own named case rather than being implied by a broader one:
 *
 *   1. UPWARD AND DOWNWARD ARE EXACT INVERSES — "the two walks agree object by object" below is the
 *      drift detector for the whole increment. An object `authorize()` admits at its own id but the
 *      list omits reads as a cache bug, not an authz bug, and would be debugged as one.
 *   2. A MALFORMED `role_bindings.effect` — "a malformed effect grants NOTHING". drizzle/0096
 *      now refuses one at the DB, but a row predating that constraint still has to fail closed.
 *   3. DENY IS A SUBTRACTION, NOT AN ABSENCE — "a deny below an allow subtracts its subtree".
 *   4. DOWNWARD TRUNCATION IS SILENT — "the bound is the same constant" pins the boundary case that
 *      makes the two directions inverses *including* their bound.
 *
 * ------------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied alone against `src/authz/`, measured, then reverted
 * ------------------------------------------------------------------------------------------------
 *
 * | Mutation | Measured result (2026-08-26) |
 * |---|---|
 * | `readableObjectFilterSql`: drop the deny descend and the `EXCEPT`, returning the allow descend alone | **2 fail.** "a deny below an allow subtracts its subtree": `expected Set{ …(7) } to deeply equal Set{ …(2) }` — the denied service and its whole subtree are readable again. "the two walks agree object by object": `subject 'denied' — upward and downward disagree: expected [ …(5) ] to deeply equal []`. Deny goes INERT on lists while still working on get-by-id: a deny that fails OPEN. |
 * | `partitionReadableRoots`: `effect === "allow"` → `effect !== "deny"` | **3 fail.** "a malformed effect ('ALLOW') grants NOTHING": `expected [ …(5) ] to deeply equal []`. "the two walks agree object by object": `subject 'malformed' — upward and downward disagree`. "`readableRootsFor` returns the raw effect…": `expected Set{ …(3) } to deeply equal Set{ …(2) }`. A row that grants nothing through `hasPermission` would grant a whole subtree through every list door. |
 * | `containmentChildrenSql`: delete arm 2 (the `contains` inverse) | **6 fail**, incl. "a binding at a SERVICE reaches its assemblies and components" (`expected Set{ 1 id } to deeply equal Set{ …(5) }`), the inverse test, and the drizzle-composition case (`expected Set{} to deeply equal Set{ …(2) }`). The drift the exported fragment exists to make impossible. |
 * | `readableObjectFilterSql`: return `null` instead of `MATCHES_NOTHING` for an empty allow set | **4 fail.** "no allow binding at all matches NOTHING": `an empty allow set must NOT be the no-filter answer: expected null not to be null`; the inverse test reports 33 disagreements for `subject 'malformed'`. The two `null`s mean opposite things, and collapsing them lets a subject with no grant read the entire org. |
 * | `insertMalformedEffectRoleBinding`: skip its `INSERT` (the FIXTURE, not the code under test) | **4 fail**, every one with `insertMalformedEffectRoleBinding did not land … Every assertion resting on this row would have passed VACUOUSLY.` Then the SAME mutation with that read-back guard ALSO removed: **1 fail** here (only "`readableRootsFor` returns the raw effect…", which reads the row directly — `expected undefined to be 'ALLOW'`) and **0 fail, 15 passed, in `inverse-walk-drift.integration.test.ts`**. Both "a malformed effect grants NOTHING" cases go GREEN with no binding in the table at all. Since drizzle/0096 this fixture has to drop a CHECK to do its job, which is exactly what makes a silent no-op possible — hence the guard, and hence this row. |
 *
 * ------------------------------------------------------------------------------------------------
 * FIXTURE — every one of the four containment routes, exercised in both directions
 * ------------------------------------------------------------------------------------------------
 *
 *   orgRoot
 *   ├── domainA                       (route 1)
 *   │   ├── serviceA                  (route 1)
 *   │   │   ├── assemblyA             (route 2 — `contains`)
 *   │   │   │   └── compA1            (route 2)
 *   │   │   ├── compA2                (route 2)
 *   │   │   └── compDoomed            (route 2, then soft-deleted)
 *   │   └── serviceC                  (route 1 — the sibling that survives the deny on serviceA)
 *   ├── domainB ── serviceB ── compB1 (the non-leakage arm)
 *   ├── targetT                       (a deployment-target, `domain_id` = org root)
 *   └── placementP                    (compA1 @ targetT — routes 3 AND 4)
 *
 * Built through the real API (the SDK against a listening server), never by direct row writes. The
 * ONE exception is the malformed-`effect` binding, which exists precisely because no API can write
 * it — that is the hazard.
 */
describe("readable scope: the containment walk run DOWNWARD (role-model.md §8.2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  /** Every fixture id, named — `Record<string, string>` would index as `string | undefined` under
   *  `noUncheckedIndexedAccess` and bury every assertion in `!`. */
  interface Fixture {
    orgRoot: string;
    domainA: string;
    domainB: string;
    serviceA: string;
    serviceB: string;
    serviceC: string;
    assemblyA: string;
    compA1: string;
    compA2: string;
    compB1: string;
    compDoomed: string;
    targetT: string;
    placementP: string;
  }
  let ids: Fixture;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  /** A role binding written with an ARBITRARY `effect` string — the only thing here not built
   *  through the API, because no door will ever write anything but 'allow'/'deny'.
   *
   *  Since drizzle/0096 the DATABASE refuses anything else too (`role_bindings_effect_check`), so a
   *  malformed value is routed to `insertMalformedEffectRoleBinding` — which builds the row THE ONLY
   *  WAY IT CAN STILL EXIST (a privileged path with the CHECK momentarily dropped, i.e. what a
   *  pre-0096 `pg_dump` restores or a DBA does) rather than pretending the shape went away. See that
   *  helper's doc for why the constraint does not retire these cases: it stops the row being
   *  written, not the row being READ, and the resolver's exact-string classification is the inner
   *  layer that keeps it harmless. Legal effects still take the ordinary path, unchanged. */
  async function bindRaw(
    subjectId: string,
    roleName: string,
    scopeObjectId: string,
    effect: string
  ): Promise<void> {
    const roleId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const role = await tx.query.roles.findFirst({
        where: and(isNull(roles.orgId), eq(roles.name, roleName))
      });
      if (!role) throw new Error(`built-in role '${roleName}' not found`);
      return role.id;
    });
    if (effect !== "allow" && effect !== "deny") {
      await insertMalformedEffectRoleBinding({
        orgId: org.orgId,
        subjectId,
        roleId,
        scopeObjectId,
        effect
      });
      return;
    }
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.insert(roleBindings).values({
        id: uuidv7(),
        orgId: org.orgId,
        subjectId,
        roleId,
        scopeObjectId,
        effect
      });
    });
  }

  /** The readable set as a LIST DOOR would compute it: the filter composed into a query over live
   *  objects, exactly the `o.id IN (…)` shape `listObjects` will push before its LIMIT. `null` means
   *  NO FILTER (the org-root short-circuit) and is returned as-is so a test can tell the two apart. */
  async function readableIds(subjectObjectId: string): Promise<string[] | null> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const filter = await readableObjectFilterFor(tx, {
        orgId: org.orgId,
        subjectObjectId,
        permission: "object:read"
      });
      if (filter === null) return null;
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT o.id
        FROM objects o
        WHERE o.org_id = ${org.orgId} AND o.deleted_at IS NULL AND o.id IN ${filter}
      `);
      return rows.rows.map((r) => r.id);
    });
  }

  /** `hasPermission` — the UPWARD walk, at one object. The other side of the inverse invariant. */
  async function can(subjectObjectId: string, scopeObjectId: string): Promise<boolean> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId,
        permission: "object:read",
        scopeObjectId
      })
    );
  }

  async function liveObjectIds(): Promise<string[]> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const rows = await tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), isNull(objects.deletedAt)));
      return rows.map((r) => r.id);
    });
  }

  const viewerAt = async (...scopes: { scope: string; effect?: "allow" | "deny" }[]) =>
    (
      await createTestUser(
        server,
        org,
        scopes.map((s) => ({ role: "Viewer", scope: s.scope, effect: s.effect }))
      )
    ).objectId;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "readable-scope");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const contains = (fromId: string, toId: string) =>
      admin.relationships.create({ typeId: "contains", fromId, toId });

    const domainA = (await admin.object("domain").create({ name: uniq("domain-a") })).id;
    const domainB = (await admin.object("domain").create({ name: uniq("domain-b") })).id;
    const serviceA = (
      await admin.object("service").create({ name: uniq("service-a"), domainId: domainA })
    ).id;
    const serviceC = (
      await admin.object("service").create({ name: uniq("service-c"), domainId: domainA })
    ).id;
    const serviceB = (
      await admin.object("service").create({ name: uniq("service-b"), domainId: domainB })
    ).id;

    const assemblyA = (await admin.assemblies.create({ name: uniq("assembly-a") })).id;
    await contains(serviceA, assemblyA);

    const compA1 = (await createOrphanComponent(server, org, uniq("comp-a1"))).id;
    await contains(assemblyA, compA1);
    const compA2 = (await createOrphanComponent(server, org, uniq("comp-a2"))).id;
    await contains(serviceA, compA2);
    const compB1 = (await createOrphanComponent(server, org, uniq("comp-b1"))).id;
    await contains(serviceB, compB1);

    // Routes 3 + 4: one placement, whose two containing scopes are its component AND its target.
    const targetT = (await admin.deploymentTargets.create({ name: uniq("target-t") })).id;
    const placementP = (
      await admin.placements.create({ component: compA1, deploymentTarget: targetT })
    ).id;

    // The tombstone case: live under serviceA, then soft-deleted through the real DELETE door.
    const compDoomed = (await createOrphanComponent(server, org, uniq("comp-doomed"))).id;
    await contains(serviceA, compDoomed);
    await admin.components.delete(compDoomed);

    ids = {
      orgRoot: org.orgId,
      domainA,
      domainB,
      serviceA,
      serviceB,
      serviceC,
      assemblyA,
      compA1,
      compA2,
      compB1,
      compDoomed,
      targetT,
      placementP
    };
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // 1. The reach of a binding at each rung — one downward arm per case.
  // ---------------------------------------------------------------------------------------------

  it("a binding at a DOMAIN reaches everything under it, and nothing beside it", async () => {
    const subject = await viewerAt({ scope: ids.domainA });
    const readable = await readableIds(subject);

    expect(new Set(readable)).toEqual(
      new Set([
        ids.domainA,
        ids.serviceA,
        ids.serviceC,
        ids.assemblyA,
        ids.compA1,
        ids.compA2,
        // route 3's inverse: the placement is contained by the component, which is under the domain.
        ids.placementP
      ])
    );
    // Not sideways, and not the deployment-target (whose `domain_id` is the org root, not domainA).
    expect(readable).not.toContain(ids.domainB);
    expect(readable).not.toContain(ids.serviceB);
    expect(readable).not.toContain(ids.compB1);
    expect(readable).not.toContain(ids.targetT);
    // Not upward — the org root is above the binding.
    expect(readable).not.toContain(ids.orgRoot);
  });

  it("a binding at a SERVICE reaches its assemblies and components (route 2's inverse)", async () => {
    const subject = await viewerAt({ scope: ids.serviceA });
    expect(new Set(await readableIds(subject))).toEqual(
      new Set([ids.serviceA, ids.assemblyA, ids.compA1, ids.compA2, ids.placementP])
    );
  });

  it("a binding at an ASSEMBLY reaches only that assembly's components — the rung between", async () => {
    const subject = await viewerAt({ scope: ids.assemblyA });
    // compA2 hangs off the SERVICE, not this assembly: a ComponentAdmin bound one rung down must
    // not acquire its sibling.
    expect(new Set(await readableIds(subject))).toEqual(
      new Set([ids.assemblyA, ids.compA1, ids.placementP])
    );
  });

  it("a binding at a COMPONENT reaches the component and its placements, and never upward", async () => {
    const subject = await viewerAt({ scope: ids.compA1 });
    expect(new Set(await readableIds(subject))).toEqual(new Set([ids.compA1, ids.placementP]));
  });

  it("a binding at a DEPLOYMENT-TARGET reaches what is placed there (route 4's inverse)", async () => {
    const subject = await viewerAt({ scope: ids.targetT });
    // The target's placements — NOT the components they place. Route 4 is walked up from the
    // placement, so downward it stops at the placement, exactly as `placementParentsSql` implies.
    expect(new Set(await readableIds(subject))).toEqual(new Set([ids.targetT, ids.placementP]));
  });

  it("a binding reached through a NESTED member_of chain resolves the same set", async () => {
    // user -> group -> team, and the TEAM holds the binding. This is the drift detector for
    // `readableRootsFor`'s hand-synced copy of `hasPermission`'s subject expansion.
    const user = await createTestUser(server, org, []);
    const group = await admin.object("group").create({ name: uniq("nested-group") });
    const team = await admin.object("team").create({ name: uniq("nested-team") });
    await admin.relationships.create({
      typeId: "member_of",
      fromId: user.objectId,
      toId: group.id
    });
    await admin.relationships.create({ typeId: "member_of", fromId: group.id, toId: team.id });
    await bindRaw(team.id, "Viewer", ids.serviceA, "allow");

    expect(new Set(await readableIds(user.objectId))).toEqual(
      new Set([ids.serviceA, ids.assemblyA, ids.compA1, ids.compA2, ids.placementP])
    );
  });

  // ---------------------------------------------------------------------------------------------
  // 2. §8.3 hazard: DENY IS A SUBTRACTION, NOT AN ABSENCE.
  // ---------------------------------------------------------------------------------------------

  it("a deny below an allow subtracts its subtree (and only its subtree)", async () => {
    const subject = await viewerAt({ scope: ids.domainA }, { scope: ids.serviceA, effect: "deny" });

    // serviceA and EVERYTHING under it goes, including the placement two rungs below the deny.
    // serviceC — the sibling under the same allowed domain — stays.
    expect(new Set(await readableIds(subject))).toEqual(new Set([ids.domainA, ids.serviceC]));
  });

  it("a deny standing ALONE leaves nothing readable (it subtracts; it does not grant)", async () => {
    const subject = await viewerAt({ scope: ids.serviceA, effect: "deny" });
    expect(await readableIds(subject)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // 3. §8.3 hazard: A `role_bindings.effect` THAT IS NEITHER 'allow' NOR 'deny'.
  //    `role_bindings_effect_check` (drizzle/0096) refuses one at the database now; these rows are
  //    built through `insertMalformedEffectRoleBinding`, which reproduces the only way one can
  //    still exist — pre-dating the constraint, in a restored dump. See `bindRaw` above.
  // ---------------------------------------------------------------------------------------------

  it("a malformed effect ('ALLOW') grants NOTHING — exactly as hasPermission treats it", async () => {
    const user = await createTestUser(server, org, []);
    await bindRaw(user.objectId, "Viewer", ids.serviceA, "ALLOW");

    // The upward walk: `effects.includes('allow')` is false for 'ALLOW', so this is a default deny.
    expect(await can(user.objectId, ids.serviceA)).toBe(false);
    // The downward walk MUST agree. A filter written `effect <> 'deny'` would hand this subject
    // serviceA's whole subtree — a silent WIDENING relative to the function it mirrors.
    expect(await readableIds(user.objectId)).toEqual([]);
  });

  it("a malformed effect does not subtract either — 'DENY' is not a deny", async () => {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: ids.domainA }]);
    await bindRaw(user.objectId, "Viewer", ids.serviceA, "DENY");
    // `effects.includes('deny')` is false for 'DENY', so upward the allow at domainA still wins.
    expect(await can(user.objectId, ids.serviceA)).toBe(true);
    expect(await readableIds(user.objectId)).toContain(ids.serviceA);
  });

  // ---------------------------------------------------------------------------------------------
  // 4. §8.3 hazard: UPWARD AND DOWNWARD MUST BE EXACT INVERSES. The drift detector.
  // ---------------------------------------------------------------------------------------------

  it("the two walks agree object by object: hasPermission(o) iff o is in the readable set", async () => {
    // A subject whose ONLY binding is malformed belongs in this sample, not just in its own case:
    // it is the one shape where a looser classification here than `hasPermission`'s would show up
    // as authority the get-by-id door refuses and the list door grants.
    const malformed = (await createTestUser(server, org, [])).objectId;
    await bindRaw(malformed, "Viewer", ids.serviceA, "ALLOW");

    const subjects = {
      domain: await viewerAt({ scope: ids.domainA }),
      service: await viewerAt({ scope: ids.serviceA }),
      assembly: await viewerAt({ scope: ids.assemblyA }),
      component: await viewerAt({ scope: ids.compA1 }),
      target: await viewerAt({ scope: ids.targetT }),
      denied: await viewerAt({ scope: ids.domainA }, { scope: ids.serviceA, effect: "deny" }),
      malformed,
      none: (await createTestUser(server, org, [])).objectId
    };
    const live = await liveObjectIds();

    for (const [label, subjectObjectId] of Object.entries(subjects)) {
      // `null` is NO FILTER, so the set a list door would return is EVERY live row — not the empty
      // set. Reading it as empty here would make the sample silently vacuous for any mutation that
      // returns `null` where it should return a filter (measured: it hid exactly that).
      const filtered = await readableIds(subjectObjectId);
      const readable = new Set(filtered === null ? live : filtered);
      const disagreements: string[] = [];
      for (const objectId of live) {
        const upward = await can(subjectObjectId, objectId);
        if (upward !== readable.has(objectId)) {
          disagreements.push(
            `${objectId}: hasPermission=${upward} readableSet=${readable.has(objectId)}`
          );
        }
      }
      expect(disagreements, `subject '${label}' — upward and downward disagree`).toEqual([]);
    }
  });

  it("a TOMBSTONED row is absent from the readable set — over BOTH routes that can reach one", async () => {
    // Route 2 (`contains`): `deleteObject` tombstones the deleted row's edges, so the service's
    // edge to it is gone and the UPWARD walk stops finding the binding too — the two directions
    // agree here for a reason that has nothing to do with this module.
    const viaEdge = await viewerAt({ scope: ids.serviceA });
    expect(await can(viaEdge, ids.compDoomed)).toBe(false);
    expect(await readableIds(viaEdge)).not.toContain(ids.compDoomed);

    // Route 1 (`domain_id`) is the case where they genuinely differ, and it is the ONE deliberate
    // divergence: no cascade rewrites `domain_id`, so upward the raw SEED row still walks up to the
    // live parent and `hasPermission` says TRUE, while downward every CHILD is filtered live and
    // the row is absent. Inert by construction — list doors filter `deleted_at IS NULL` themselves
    // unless `includeDeleted`, so no door can serve a row this omits.
    const domainD = (await admin.object("domain").create({ name: uniq("tombstone-domain") })).id;
    const serviceD = (
      await admin.object("service").create({ name: uniq("tombstone-service"), domainId: domainD })
    ).id;
    await admin.object("service").delete(serviceD);

    const viaDomainId = await viewerAt({ scope: domainD });
    expect(await can(viaDomainId, serviceD)).toBe(true);
    expect(await readableIds(viaDomainId)).toEqual([domainD]);
  });

  // ---------------------------------------------------------------------------------------------
  // 5. The org-root short-circuit, and the `null`/empty distinction it lives next to.
  // ---------------------------------------------------------------------------------------------

  it("an ORG-ROOT allow short-circuits to NO FILTER — today's query, verbatim", async () => {
    const subject = await viewerAt({ scope: ids.orgRoot });
    // `null`, not "every id": the point of the short-circuit is that the list query is not touched
    // at all, so a row whose containment chain is broken keeps being listed exactly as today. That
    // is what makes 2.5b a pure widening.
    expect(await readableIds(subject)).toBeNull();
  });

  it("an org-root allow WITH a deny below it still short-circuits — the door-level inverse", async () => {
    const subject = await viewerAt({ scope: ids.orgRoot }, { scope: ids.serviceA, effect: "deny" });
    // Deliberate, and it keeps the DOORS in agreement rather than breaking them:
    // `checkAtOrgRootOrScopes` tries the org-root arm FIRST and never consults a deny bound below
    // the org root, so get-by-id admits serviceA for this subject. A filter here would remove from
    // the list exactly what get-by-id still serves — a narrowing nobody decided, and the mismatch
    // §8.3's first hazard is about. (`hasPermission` at serviceA in ISOLATION does return false,
    // which is why this case is pinned separately from the object-by-object sample above.)
    expect(await readableIds(subject)).toBeNull();
    expect(await can(subject, ids.serviceA)).toBe(false);
    expect(await can(subject, ids.orgRoot)).toBe(true);
  });

  it("no allow binding at all matches NOTHING — the opposite of `null`, and never it", async () => {
    const filter = readableObjectFilterSql(org.orgId, [], [ids.serviceA]);
    expect(filter, "an empty allow set must NOT be the no-filter answer").not.toBeNull();

    const subject = (await createTestUser(server, org, [])).objectId;
    expect(await readableIds(subject)).toEqual([]);
  });

  it("`readableRootsFor` returns the raw effect, and the partition classifies it exactly", async () => {
    const user = await createTestUser(server, org, [
      { role: "Viewer", scope: ids.domainA },
      { role: "Viewer", scope: ids.serviceA, effect: "deny" }
    ]);
    await bindRaw(user.objectId, "Viewer", ids.serviceC, "ALLOW");
    // Approver adds `approval:write`, which Viewer does not carry — the permission arm below reads
    // that difference, so a root is only ever returned for the permission actually asked about.
    await bindRaw(user.objectId, "Approver", ids.domainB, "allow");

    const rootsFor = async (permission: "object:read" | "approval:write") =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        readableRootsFor(tx, { orgId: org.orgId, subjectObjectId: user.objectId, permission })
      );

    const readRoots = await rootsFor("object:read");
    // The RAW effect comes back — classification is deliberately not done in SQL.
    expect(readRoots.find((r) => r.rootId === ids.serviceC)?.effect).toBe("ALLOW");

    const { allowRoots, denyRoots } = partitionReadableRoots(readRoots);
    // 'ALLOW' lands in NEITHER set, exactly as `hasPermission`'s two `includes` checks treat it.
    expect(new Set(allowRoots)).toEqual(new Set([ids.domainA, ids.domainB]));
    expect(denyRoots).toEqual([ids.serviceA]);

    // The permission filter: only the Approver binding grants `approval:write`.
    const approveRoots = partitionReadableRoots(await rootsFor("approval:write"));
    expect(approveRoots.allowRoots).toEqual([ids.domainB]);
    expect(approveRoots.denyRoots).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // 6. The composition a repo actually performs — the drizzle query-builder shape, before the LIMIT.
  // ---------------------------------------------------------------------------------------------

  it("composes into a drizzle query-builder WHERE, the way `listObjects` will", async () => {
    const subject = await viewerAt({ scope: ids.serviceA });
    const rows = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const filter = await readableObjectFilterFor(tx, {
        orgId: org.orgId,
        subjectObjectId: subject,
        permission: "object:read"
      });
      if (!filter) throw new Error("expected a filter for a service-scoped subject");
      const conditions = [
        eq(objects.orgId, org.orgId),
        isNull(objects.deletedAt),
        eq(objects.typeId, "component"),
        sql`${objects.id} IN ${filter}`
      ];
      return tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(...conditions))
        .limit(50);
    });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([ids.compA1, ids.compA2]));
  });

  // ---------------------------------------------------------------------------------------------
  // 7. §8.3 hazard: the BOUND. Same constant both ways, and unreachable on a legal estate.
  // ---------------------------------------------------------------------------------------------

  it("the bound is the same constant both ways: a row at the ceiling is still readable", async () => {
    // The write doors refuse any live row past CONTAINMENT_WALK_MAX_DEPTH (10 hops from the org
    // root), so the deepest legal row sits at depth 10 — and the deepest legal NON-ROOT binding at
    // depth 1, leaving at most 9 hops between them. This builds exactly that worst case: the
    // descend must reach the bottom of it, and `hasPermission` must agree at the same row.
    const chain: string[] = [];
    let parent = org.orgId;
    for (let level = 1; level <= 10; level += 1) {
      parent = (
        await admin.object("domain").create({ name: uniq(`deep-${level}`), domainId: parent })
      ).id;
      chain.push(parent);
    }
    const top = chain[0]!;
    const bottom = chain[chain.length - 1]!;

    const subject = await viewerAt({ scope: top });
    const readable = await readableIds(subject);
    expect(readable).toContain(bottom);
    expect(new Set(readable)).toEqual(new Set(chain));
    expect(await can(subject, bottom)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, roleBindings, roles } from "../db/schema.js";
import { CONTAINMENT_WALK_MAX_DEPTH, isWalkDepthExceeded } from "../graph/containment.js";
import { hasPermission } from "./resolve.js";
import { readableScopeForListDoor } from "./list-door-scope.js";
import { readableObjectFilterFor } from "./readable-scope.js";
import {
  createTestOrg,
  createTestUser,
  insertMalformedEffectRoleBinding,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE DRIFT DETECTOR. See docs/authz.md §3. */

/** Default fixed so CI is reproducible; override to re-shape the tree. See the header. */
const SEED = Number(process.env.SCP_DRIFT_SEED ?? 20260826);

/** mulberry32 — 4 lines, no dependency, identical sequence on every platform. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The containment graph as PERSISTED, parent -> children. Model (3)'s only input. */
type ChildMap = Map<string, Set<string>>;

describe("upward and downward containment are exact inverses (role-model.md §8.3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  // Probes — the two production walks, and the test-side model.

  /** The UPWARD walk at ONE object. Throws `walkDepthExceeded` (409) rather than returning false
   *  when a refusal cannot be trusted (ADR-0037) — the depth cases below depend on that. */
  async function can(orgId: string, subjectObjectId: string, scopeObjectId: string) {
    return withTenantTx(server.deps.db, orgId, (tx) =>
      hasPermission(tx, { orgId, subjectObjectId, permission: "object:read", scopeObjectId })
    );
  }

  /** The downward walk, run the way a list door runs it. See docs/authz.md §4. */
  async function readableIds(orgId: string, subjectObjectId: string): Promise<string[] | null> {
    return withTenantTx(server.deps.db, orgId, async (tx) => {
      const filter = await readableObjectFilterFor(tx, {
        orgId,
        subjectObjectId,
        permission: "object:read"
      });
      if (filter === null) return null;
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT o.id FROM objects o
        WHERE o.org_id = ${orgId} AND o.deleted_at IS NULL AND o.id IN ${filter}
      `);
      return rows.rows.map((r) => r.id);
    });
  }

  /** Every live object id in the org, with enough label to make a failure diagnosable. */
  async function liveObjects(
    orgId: string
  ): Promise<{ id: string; typeId: string; name: string }[]> {
    return withTenantTx(server.deps.db, orgId, async (tx) => {
      const rows = await tx
        .select({ id: objects.id, typeId: objects.typeId, name: objects.name })
        .from(objects)
        .where(and(eq(objects.orgId, orgId), isNull(objects.deletedAt)));
      return rows.map((r) => ({ id: r.id, typeId: r.typeId, name: r.name ?? "" }));
    });
  }

  /** The containment graph read as three flat selects. See docs/authz.md §5. */
  async function loadChildMap(orgId: string): Promise<ChildMap> {
    return withTenantTx(server.deps.db, orgId, async (tx) => {
      const map: ChildMap = new Map();
      const link = (parent: string | null, child: string) => {
        if (!parent) return;
        const set = map.get(parent) ?? new Set<string>();
        set.add(child);
        map.set(parent, set);
      };

      const byDomain = await tx.execute<{ id: string; domain_id: string | null }>(sql`
        SELECT id, domain_id FROM objects
        WHERE org_id = ${orgId} AND deleted_at IS NULL
      `);
      for (const row of byDomain.rows) link(row.domain_id, row.id);

      const byContains = await tx.execute<{ from_id: string; to_id: string }>(sql`
        SELECT r.from_id, r.to_id
        FROM relationships r
        JOIN objects child ON child.id = r.to_id AND child.org_id = ${orgId}
          AND child.deleted_at IS NULL
        WHERE r.org_id = ${orgId} AND r.type_id = 'contains' AND r.deleted_at IS NULL
      `);
      for (const row of byContains.rows) link(row.from_id, row.to_id);

      const byPlacement = await tx.execute<{
        id: string;
        component_id: string | null;
        target_id: string | null;
      }>(sql`
        SELECT id,
               properties ->> 'componentId' AS component_id,
               properties ->> 'deploymentTargetId' AS target_id
        FROM objects
        WHERE org_id = ${orgId} AND type_id = 'placement' AND deleted_at IS NULL
      `);
      for (const row of byPlacement.rows) {
        link(row.component_id, row.id);
        link(row.target_id, row.id);
      }
      return map;
    });
  }

  /** Model (3)'s walk. See docs/authz.md §6. */
  function descendModel(
    children: ChildMap,
    roots: readonly string[],
    live: Set<string>
  ): Set<string> {
    const seen = new Set<string>();
    let frontier = roots.filter((id) => live.has(id));
    for (const id of frontier) seen.add(id);
    for (let depth = 0; depth < CONTAINMENT_WALK_MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of children.get(parent) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** A role binding written with an ARBITRARY `effect`. See docs/authz.md §7. */
  async function bindRaw(
    orgId: string,
    subjectId: string,
    roleName: string,
    scopeObjectId: string,
    effect: string
  ): Promise<void> {
    const roleId = await withTenantTx(server.deps.db, orgId, async (tx) => {
      const role = await tx.query.roles.findFirst({
        where: and(isNull(roles.orgId), eq(roles.name, roleName))
      });
      if (!role) throw new Error(`built-in role '${roleName}' not found`);
      return role.id;
    });
    if (effect !== "allow" && effect !== "deny") {
      await insertMalformedEffectRoleBinding({
        orgId,
        subjectId,
        roleId,
        scopeObjectId,
        effect
      });
      return;
    }
    await withTenantTx(server.deps.db, orgId, async (tx) => {
      await tx
        .insert(roleBindings)
        .values({ id: uuidv7(), orgId, subjectId, roleId, scopeObjectId, effect });
    });
  }

  /** Every object the fixture generated, with the depth it was built at (for legality only — the
   *  walks derive their own). */
  interface Built {
    id: string;
    kind: string;
    depth: number;
  }

  let built: Built[];
  /** The four routes, pinned by hand so the generated tree can never make them vacuous. */
  let route: {
    domain: string;
    service: string;
    assembly: string;
    component: string;
    target: string;
    placement: string;
    /** A second service under `route.domain`, never bound — the "and nothing beside it" arm. */
    siblingService: string;
  };
  /** The pagination arm: readable rows INTERLEAVED with unreadable ones in `created_at` order. */
  let page: { service: string; readable: string[]; unreadable: string[] };

  /** Subjects, by label. Every one is measured by the object-by-object invariant. */
  let subjects: Record<string, string>;
  /** The scoped subjects' allow/deny roots, as the fixture INTENDED them — model (3)'s seed. */
  let intendedRoots: Record<string, { allow: string[]; deny: string[] }>;
  let pageClient: ScpClient;

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
    org = await createTestOrg(server, "inverse-drift");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const rng = makeRng(SEED);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;

    built = [];
    const add = (id: string, kind: string, depth: number) => {
      built.push({ id, kind, depth });
      return id;
    };
    const kind = (k: string) => built.filter((b) => b.kind === k);

    // The four routes, placed deliberately rather than generated. See docs/authz.md §8.
    const rDomain = add(
      (await admin.object("domain").create({ name: uniq("r-domain") })).id,
      "domain",
      1
    );
    const rService = add(
      (await admin.services.create({ name: uniq("r-service"), domainId: rDomain })).id,
      "service",
      2
    );
    const rSibling = add(
      (await admin.services.create({ name: uniq("r-sibling"), domainId: rDomain })).id,
      "service",
      2
    );
    // Route 2, TWO HOPS: service -contains-> assembly -contains-> component.
    const rAssembly = add(
      (await admin.assemblies.create({ name: uniq("r-assembly") })).id,
      "assembly",
      3
    );
    await admin.relationships.create({ typeId: "contains", fromId: rService, toId: rAssembly });
    const rComponent = add(
      (await admin.components.create({ name: uniq("r-component"), service: rAssembly })).id,
      "component",
      4
    );
    // Routes 3 + 4: one placement, contained by its component AND by its deployment-target.
    const rTarget = add(
      (await admin.deploymentTargets.create({ name: uniq("r-target") })).id,
      "target",
      1
    );
    const rPlacement = add(
      (await admin.placements.create({ component: rComponent, deploymentTarget: rTarget })).id,
      "placement",
      5
    );
    route = {
      domain: rDomain,
      service: rService,
      assembly: rAssembly,
      component: rComponent,
      target: rTarget,
      placement: rPlacement,
      siblingService: rSibling
    };

    // ---- the generated tree ------------------------------------------------------------------
    // Depths are kept inside CONTAINMENT_WALK_MAX_DEPTH because the write doors refuse anything
    // else (ADR-0037); the past-the-bound case gets its own org, below, for that reason.
    for (let i = 0; i < 6; i += 1) {
      const parents = kind("domain").filter((d) => d.depth < 4);
      const parent = i < 2 || parents.length === 0 ? null : pick(parents);
      const created = await admin
        .object("domain")
        .create({ name: uniq(`g-domain-${i}`), ...(parent ? { domainId: parent.id } : {}) });
      add(created.id, "domain", (parent?.depth ?? 0) + 1);
    }
    for (let i = 0; i < 5; i += 1) {
      const parent = pick(kind("domain"));
      const created = await admin.services.create({
        name: uniq(`g-service-${i}`),
        domainId: parent.id
      });
      add(created.id, "service", parent.depth + 1);
    }
    for (let i = 0; i < 4; i += 1) {
      const parent = pick(kind("service"));
      const created = await admin.assemblies.create({ name: uniq(`g-assembly-${i}`) });
      await admin.relationships.create({ typeId: "contains", fromId: parent.id, toId: created.id });
      add(created.id, "assembly", parent.depth + 1);
    }
    for (let i = 0; i < 8; i += 1) {
      // Half under services, half under assemblies — `components.create` takes either as `service`,
      // and the two produce a one-hop and a two-hop `contains` chain respectively.
      const parent = pick(i % 2 === 0 ? kind("service") : kind("assembly"));
      const created = await admin.components.create({
        name: uniq(`g-component-${i}`),
        service: parent.id
      });
      add(created.id, "component", parent.depth + 1);
    }
    for (let i = 0; i < 3; i += 1) {
      const created = await admin.deploymentTargets.create({ name: uniq(`g-target-${i}`) });
      add(created.id, "target", 1);
    }
    const placed = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const component = pick(kind("component"));
      const target = pick(kind("target"));
      // Delimiter is '|', deliberately NOT NUL. See docs/authz.md §9.
      const key = `${component.id}|${target.id}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const created = await admin.placements.create({
        component: component.id,
        deploymentTarget: target.id
      });
      add(created.id, "placement", Math.max(component.depth, target.depth) + 1);
    }

    // ---- the pagination arm ------------------------------------------------------------------
    // INTERLEAVED in creation order, which is the keyset order the cursor walks. A fixture that
    // created all the readable rows first would page correctly even under the disqualified
    // post-filter design — the vacuous-test shape.
    const pageDomain = (await admin.object("domain").create({ name: uniq("p-domain") })).id;
    add(pageDomain, "domain", 1);
    const pageService = (
      await admin.services.create({ name: uniq("p-mine"), domainId: pageDomain })
    ).id;
    add(pageService, "service", 2);
    const otherService = (
      await admin.services.create({ name: uniq("p-other"), domainId: pageDomain })
    ).id;
    add(otherService, "service", 2);
    const readable: string[] = [];
    const unreadable: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      readable.push(
        add(
          (
            await admin.components.create({
              name: uniq(`p-mine-${String(i).padStart(2, "0")}`),
              service: pageService
            })
          ).id,
          "component",
          3
        )
      );
      if (i % 2 === 1) {
        unreadable.push(
          add(
            (
              await admin.components.create({
                name: uniq(`p-other-${String(i).padStart(2, "0")}`),
                service: otherService
              })
            ).id,
            "component",
            3
          )
        );
      }
    }
    page = { service: pageService, readable, unreadable };

    const generatedRoot = pick(built.filter((b) => b.kind !== "placement"));
    const denyAllow = route.domain;
    const denyRoot = route.service;

    const malformedUpper = (await createTestUser(server, org, [])).objectId;
    await bindRaw(org.orgId, malformedUpper, "Viewer", route.service, "ALLOW");
    const malformedEmpty = (await createTestUser(server, org, [])).objectId;
    await bindRaw(org.orgId, malformedEmpty, "Viewer", route.service, "");

    // A binding reached through a NESTED `member_of` chain — the drift detector for
    // `readableRootsFor`'s hand-synced copy of `hasPermission`'s subject expansion.
    const nestedUser = (await createTestUser(server, org, [])).objectId;
    const group = (await admin.object("group").create({ name: uniq("g-group") })).id;
    const team = (await admin.object("team").create({ name: uniq("g-team") })).id;
    await admin.relationships.create({ typeId: "member_of", fromId: nestedUser, toId: group });
    await admin.relationships.create({ typeId: "member_of", fromId: group, toId: team });
    await bindRaw(org.orgId, team, "Viewer", route.assembly, "allow");

    const pageUser = await createTestUser(server, org, [{ role: "Viewer", scope: pageService }]);
    pageClient = new ScpClient({ baseUrl: server.baseUrl, token: pageUser.token });

    subjects = {
      domain: await viewerAt({ scope: route.domain }),
      service: await viewerAt({ scope: route.service }),
      assembly: await viewerAt({ scope: route.assembly }),
      component: await viewerAt({ scope: route.component }),
      target: await viewerAt({ scope: route.target }),
      placement: await viewerAt({ scope: route.placement }),
      generated: await viewerAt({ scope: generatedRoot.id }),
      twoRoots: await viewerAt({ scope: route.assembly }, { scope: route.target }),
      denied: await viewerAt({ scope: denyAllow }, { scope: denyRoot, effect: "deny" }),
      denyOnly: await viewerAt({ scope: route.service, effect: "deny" }),
      malformedUpper,
      malformedEmpty,
      nested: nestedUser,
      paging: pageUser.objectId,
      unbound: (await createTestUser(server, org, [])).objectId,
      orgRoot: await viewerAt({ scope: org.orgId })
    };

    intendedRoots = {
      domain: { allow: [route.domain], deny: [] },
      service: { allow: [route.service], deny: [] },
      assembly: { allow: [route.assembly], deny: [] },
      component: { allow: [route.component], deny: [] },
      target: { allow: [route.target], deny: [] },
      placement: { allow: [route.placement], deny: [] },
      generated: { allow: [generatedRoot.id], deny: [] },
      twoRoots: { allow: [route.assembly, route.target], deny: [] },
      denied: { allow: [denyAllow], deny: [denyRoot] },
      denyOnly: { allow: [], deny: [route.service] },
      // The malformed effects are in NEITHER set — `hasPermission` classifies by exact string, so
      // 'ALLOW' and '' each grant nothing and deny nothing.
      malformedUpper: { allow: [], deny: [] },
      malformedEmpty: { allow: [], deny: [] },
      nested: { allow: [route.assembly], deny: [] },
      paging: { allow: [pageService], deny: [] },
      unbound: { allow: [], deny: [] }
    };
  }, 300_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // 1. THE INVARIANT ITSELF.
  // ---------------------------------------------------------------------------------------------

  /**
   * ⚠️ MUTATION-PROVEN — see the table in the file header. This test is worthless if it survives an
   * arm being deleted from `containmentChildrenSql`, and it does not.
   */
  it("hasPermission(S, O) iff O is in S's readable set — every subject, every live object", async () => {
    const live = await liveObjects(org.orgId);
    const label = new Map(live.map((o) => [o.id, `${o.typeId} '${o.name}'`]));
    const allDisagreements: string[] = [];

    for (const [name, subjectObjectId] of Object.entries(subjects)) {
      const filtered = await readableIds(org.orgId, subjectObjectId);
      // `null` is NO FILTER, so the rows a list door would return are EVERY live row — not none.
      // Reading it as the empty set here would make the whole sample vacuous against any mutation
      // that returns `null` where a real filter belongs.
      const readable = new Set(filtered === null ? live.map((o) => o.id) : filtered);

      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        for (const object of live) {
          let upward: boolean | string;
          try {
            upward = await hasPermission(tx, {
              orgId: org.orgId,
              subjectObjectId,
              permission: "object:read",
              scopeObjectId: object.id
            });
          } catch (error) {
            // A throw is neither true nor false and must never be silently read as "refused":
            // ADR-0037's probe throws on a refusal it cannot trust, and on THIS estate (every row
            // legally within the bound) it must never fire at all.
            upward = `threw: ${(error as Error).message.slice(0, 120)}`;
          }
          if (upward !== readable.has(object.id)) {
            allDisagreements.push(
              `subject '${name}' @ ${label.get(object.id) ?? object.id}: hasPermission=${String(upward)} readableSet=${readable.has(object.id)}`
            );
          }
        }
      });
    }

    expect(
      allDisagreements,
      `the two containment walks disagree (seed ${SEED}) — an object one door admits at its own id ` +
        `is absent from the list that should contain it`
    ).toEqual([]);
  }, 300_000);

  /** MODEL (3). Catches the drift the test above cannot. See docs/authz.md §10. */
  it("both walks agree with an INDEPENDENT model of the persisted containment graph", async () => {
    const live = await liveObjects(org.orgId);
    const liveIds = new Set(live.map((o) => o.id));
    const children = await loadChildMap(org.orgId);
    const mismatches: string[] = [];

    for (const [name, roots] of Object.entries(intendedRoots)) {
      // `descend(allow) EXCEPT descend(deny)` — two walks, mirroring `readableObjectFilterSql`'s
      // shape rather than filtering the allow SEEDS, because a deny subtracts a whole SUBTREE.
      const allowed = descendModel(children, roots.allow, liveIds);
      const denied = descendModel(children, roots.deny, liveIds);
      const expected = new Set([...allowed].filter((id) => !denied.has(id)));
      const actual = await readableIds(org.orgId, subjects[name]!);
      if (actual === null) {
        mismatches.push(`subject '${name}': the filter short-circuited to null (no filter)`);
        continue;
      }
      const got = new Set(actual);
      const missing = [...expected].filter((id) => !got.has(id));
      const extra = [...got].filter((id) => !expected.has(id));
      if (missing.length > 0 || extra.length > 0) {
        mismatches.push(
          `subject '${name}': ${missing.length} rows the model reaches and the query does not ` +
            `(${missing.slice(0, 3).join(", ")}), ${extra.length} the query reaches and the model ` +
            `does not (${extra.slice(0, 3).join(", ")})`
        );
      }
    }

    expect(
      mismatches,
      `the downward walk disagrees with the persisted graph (seed ${SEED}) — if the test above is ` +
        `GREEN and this one is RED, BOTH production walks moved together`
    ).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // 2. THE FOUR ROUTES, each pinned so the generated tree cannot make the sample vacuous.
  // ---------------------------------------------------------------------------------------------

  it("route 1 (`domain_id`): a domain-bound subject reaches its services, both ways", async () => {
    const subject = subjects.domain!;
    const readable = await readableIds(org.orgId, subject);
    expect(readable).toContain(route.service);
    expect(readable).toContain(route.siblingService);
    expect(await can(org.orgId, subject, route.service)).toBe(true);
    // And never upward: the domain's own parent is the org root.
    expect(readable).not.toContain(org.orgId);
    expect(await can(org.orgId, subject, org.orgId)).toBe(false);
  });

  it("route 2 (`contains`), TWO HOPS: service -> assembly -> component, both ways", async () => {
    const atService = subjects.service!;
    const readable = await readableIds(org.orgId, atService);
    expect(readable).toContain(route.assembly);
    expect(readable).toContain(route.component);
    expect(await can(org.orgId, atService, route.assembly)).toBe(true);
    expect(await can(org.orgId, atService, route.component)).toBe(true);

    // The asymmetry that makes `contains` a security property: a binding one rung DOWN reaches the
    // component and never the service above it, nor that service's other children.
    const atAssembly = subjects.assembly!;
    const fromAssembly = await readableIds(org.orgId, atAssembly);
    expect(fromAssembly).toContain(route.component);
    expect(fromAssembly).not.toContain(route.service);
    expect(fromAssembly).not.toContain(route.siblingService);
    expect(await can(org.orgId, atAssembly, route.service)).toBe(false);
  });

  it("route 3 (placement -> component): a component-bound subject reaches its placements", async () => {
    const subject = subjects.component!;
    expect(await readableIds(org.orgId, subject)).toContain(route.placement);
    expect(await can(org.orgId, subject, route.placement)).toBe(true);
    // Downward stops there — a placement has no children, and never reaches its deployment-target.
    expect(await readableIds(org.orgId, subject)).not.toContain(route.target);
    expect(await can(org.orgId, subject, route.target)).toBe(false);
  });

  it("route 4 (placement -> deployment-target): a target-bound subject reaches what is placed there", async () => {
    const subject = subjects.target!;
    const readable = await readableIds(org.orgId, subject);
    expect(readable).toContain(route.placement);
    expect(await can(org.orgId, subject, route.placement)).toBe(true);
    // "Operator of prod" reaches the placements at prod, NOT the components they place — route 4 is
    // walked UP from the placement, so downward it stops at the placement.
    expect(readable).not.toContain(route.component);
    expect(await can(org.orgId, subject, route.component)).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // 3. §8.3 hazard: DENY IS A SUBTRACTION, NOT AN ABSENCE.
  // ---------------------------------------------------------------------------------------------

  /** ⚠️ MUTATION-PROVEN (header table). See docs/authz.md §11. */
  it("a deny below an allow subtracts its whole subtree from the list, exactly as it does at get-by-id", async () => {
    const subject = subjects.denied!;
    const readable = await readableIds(org.orgId, subject);
    expect(readable, "a deny subject must still get a real filter, never `null`").not.toBeNull();
    const got = new Set(readable);

    // Everything below the deny goes — including rows TWO and THREE rungs below it, which is where
    // a "filter the seed roots" implementation (rather than a second descend) fails.
    for (const denied of [route.service, route.assembly, route.component, route.placement]) {
      expect(got.has(denied), `${denied} is below the deny and must be absent from the list`).toBe(
        false
      );
      expect(
        await can(org.orgId, subject, denied),
        `${denied} must also be refused at get-by-id`
      ).toBe(false);
    }
    // The sibling under the same ALLOWED domain stays — the deny subtracts its subtree and nothing
    // else.
    expect(got.has(route.siblingService)).toBe(true);
    expect(got.has(route.domain)).toBe(true);
    expect(await can(org.orgId, subject, route.siblingService)).toBe(true);
  });

  it("a deny standing ALONE grants nothing — it subtracts, it does not seed", async () => {
    expect(await readableIds(org.orgId, subjects.denyOnly!)).toEqual([]);
  });

  // A binding effect that is neither allow nor deny. See docs/authz.md §12.

  /** `hasPermission` classifies in JS. See docs/authz.md §13. */
  it("a malformed effect grants NOTHING — 'ALLOW' and '' alike, upward and downward", async () => {
    for (const [name, subject] of [
      ["ALLOW", subjects.malformedUpper!],
      ["(empty string)", subjects.malformedEmpty!]
    ] as const) {
      expect(await can(org.orgId, subject, route.service), `${name}: get-by-id must refuse`).toBe(
        false
      );
      expect(await readableIds(org.orgId, subject), `${name}: the list must be empty`).toEqual([]);
    }
  });

  it("a malformed effect does not SUBTRACT either — a deny is 'deny' exactly", async () => {
    const subject = await viewerAt({ scope: route.domain });
    await bindRaw(org.orgId, subject, "Viewer", route.service, "DENY");
    // Upward, `includes('deny')` is false for 'DENY', so the allow at the domain still wins. The
    // list must agree — a filter that subtracted on `effect <> 'allow'` would hide rows get-by-id
    // still serves.
    expect(await can(org.orgId, subject, route.service)).toBe(true);
    expect(await readableIds(org.orgId, subject)).toContain(route.service);
  });

  // ---------------------------------------------------------------------------------------------
  // 5. PAGINATION EXACTNESS — the property that disqualified per-row post-filtering (§8.2).
  // ---------------------------------------------------------------------------------------------

  /** §8.2 rejected per-row post-filtering on PAGINATION, not on cost. See docs/authz.md §14. */
  it("readable rows paginate exactly: full pages, honest cursor, no empty page with a nextCursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const limit = 5;

    do {
      const response = await pageClient.components.list({ limit, ...(cursor ? { cursor } : {}) });
      pages += 1;
      const next = (response.nextCursor ?? undefined) as string | undefined;

      if (next !== undefined) {
        expect(
          response.items.length,
          `page ${pages} returned ${response.items.length} of ${limit} rows but still carries a ` +
            `nextCursor — the filter was applied AFTER the LIMIT`
        ).toBe(limit);
      }
      for (const item of response.items) seen.push(item.id);
      cursor = next;
      expect(pages, "pagination did not terminate").toBeLessThanOrEqual(12);
    } while (cursor);

    expect(new Set(seen).size, "a row came back on two different pages").toBe(seen.length);
    expect([...seen].sort()).toEqual([...page.readable].sort());
    for (const id of page.unreadable) expect(seen).not.toContain(id);
    // 12 readable rows at limit 5 is 5 + 5 + 2 — three pages, the last one short and terminal.
    expect(pages).toBe(3);
  });

  // ---------------------------------------------------------------------------------------------
  // 6. §8.3 hazard: DOWNWARD TRUNCATION. Its own org, because the estate has to be ILLEGAL.
  // ---------------------------------------------------------------------------------------------

  /** Depth beyond the bound is loud upward, and what that pins. See docs/authz.md §15. */
  describe("a row past CONTAINMENT_WALK_MAX_DEPTH (the federated/legacy estate)", () => {
    let deepOrg: TestOrg;
    let chain: string[];
    /** Bound at `chain[0]` (hop 1). `atBound` sits 10 hops below it, `pastBound` 11. */
    let scopedSubject: string;
    let orgRootSubject: string;

    beforeAll(async () => {
      deepOrg = await createTestOrg(server, "inverse-drift-deep");
      const deepAdmin = new ScpClient({ baseUrl: server.baseUrl, token: deepOrg.adminToken });

      // Hops 1..10, built THROUGH the doors — this much is legal.
      chain = [];
      let parent: string | undefined;
      for (let hop = 1; hop <= CONTAINMENT_WALK_MAX_DEPTH; hop += 1) {
        const created = await deepAdmin.object("domain").create({
          name: `deep-d${hop}-${randomUUID().slice(0, 8)}`,
          ...(parent ? { domainId: parent } : {})
        });
        chain.push(created.id);
        parent = created.id;
      }
      // Hops 11 and 12: created at the org root (legal), then RE-PARENTED past the bound by direct
      // UPDATE, because every door refuses to do it. This is the federated/legacy shape.
      const eleventh = (
        await deepAdmin.object("domain").create({ name: `deep-d11-${randomUUID().slice(0, 8)}` })
      ).id;
      const twelfth = (
        await deepAdmin.object("domain").create({ name: `deep-d12-${randomUUID().slice(0, 8)}` })
      ).id;
      await withTenantTx(server.deps.db, deepOrg.orgId, async (tx) => {
        await tx.execute(
          sql`UPDATE objects SET domain_id = ${chain[CONTAINMENT_WALK_MAX_DEPTH - 1]!} WHERE id = ${eleventh} AND org_id = ${deepOrg.orgId}`
        );
        await tx.execute(
          sql`UPDATE objects SET domain_id = ${eleventh} WHERE id = ${twelfth} AND org_id = ${deepOrg.orgId}`
        );
      });
      chain.push(eleventh, twelfth);

      scopedSubject = (
        await createTestUser(server, deepOrg, [{ role: "Viewer", scope: chain[0]! }])
      ).objectId;
      orgRootSubject = (
        await createTestUser(server, deepOrg, [{ role: "Viewer", scope: deepOrg.orgId }])
      ).objectId;
    }, 180_000);

    it("the two walks truncate at the SAME hop — 10 below the binding is readable, 11 is not", async () => {
      const readable = await readableIds(deepOrg.orgId, scopedSubject);
      expect(
        readable,
        "a hop-1 binding is not the org root and must produce a real filter"
      ).not.toBeNull();
      const got = new Set(readable);

      // hop 11 == 10 hops below the binding at hop 1: the last row inside the bound.
      const atBound = chain[CONTAINMENT_WALK_MAX_DEPTH]!;
      expect(got.has(atBound), "the row exactly at the bound must be readable").toBe(true);
      expect(await can(deepOrg.orgId, scopedSubject, atBound)).toBe(true);

      // hop 12 == 11 hops below the binding: past it, in BOTH directions.
      const pastBound = chain[CONTAINMENT_WALK_MAX_DEPTH + 1]!;
      expect(got.has(pastBound), "the row past the bound must be absent from the list").toBe(false);
    });

    it("past the bound the LIST is silently short while GET-BY-ID is loudly 409 — decided, not accidental", async () => {
      const pastBound = chain[CONTAINMENT_WALK_MAX_DEPTH + 1]!;

      // The downward decision: SILENT OMISSION. Asserted, so that converting it later to a loud
      // whole-page refusal is a deliberate act with a red test, not a quiet one.
      expect(await readableIds(deepOrg.orgId, scopedSubject)).not.toContain(pastBound);

      // The upward behaviour it is paired with: NOT `false`, and NOT a silent 403 — a 409 that
      // names the bound. Membership therefore agrees (neither direction serves the row); only
      // loudness differs, which is the whole of the divergence.
      await expect(can(deepOrg.orgId, scopedSubject, pastBound)).rejects.toSatisfy(
        (error: unknown) => isWalkDepthExceeded(error),
        "the upward walk must refuse LOUDLY past the bound (ADR-0037), not return false"
      );
    });

    /** `?scopeObjectId=` RE-SEEDS THE BOUND. See docs/authz.md §16. */
    it("a hint re-seeds the bound: the hinted list is NOT a subset of the unhinted one", async () => {
      const pastBound = chain[CONTAINMENT_WALK_MAX_DEPTH + 1]!;
      const hint = chain[2]!; // hop 3 — two hops below the binding at hop 1.

      const idsFor = async (scopeObjectRef: string | undefined) =>
        withTenantTx(server.deps.db, deepOrg.orgId, async (tx) => {
          const filter = await readableScopeForListDoor(tx, {
            orgId: deepOrg.orgId,
            subjectObjectId: scopedSubject,
            permission: "object:read",
            scopeObjectRef,
            resolveScopeObject: async (ref) => ref
          });
          expect(
            filter,
            "a hop-1 binding is not the org root and must produce a real filter"
          ).not.toBeNull();
          const rows = await tx.execute<{ id: string }>(sql`
            SELECT o.id FROM objects o
            WHERE o.org_id = ${deepOrg.orgId} AND o.deleted_at IS NULL AND o.id IN ${filter!}
          `);
          return new Set(rows.rows.map((r) => r.id));
        });

      const unhinted = await idsFor(undefined);
      const hinted = await idsFor(hint);

      // The control: the gate admits, and the hint really does narrow in the ordinary direction —
      // the binding's own hop-1 row is above the hint and drops out. Without this the case below
      // could pass on a hinted filter that was simply broken.
      expect(
        unhinted.has(chain[0]!),
        "control: the unhinted list contains the binding's own row"
      ).toBe(true);
      expect(hinted.has(chain[0]!), "control: the hint excludes rows ABOVE it").toBe(false);

      expect(unhinted.has(pastBound), "unhinted: 11 hops below the binding, past the bound").toBe(
        false
      );
      expect(
        hinted.has(pastBound),
        "hinted: the SAME row, 9 hops below the hint — the hint re-seeded the bound and added it"
      ).toBe(true);

      // …and it is genuinely a superset in that direction, not a different set: get-by-id still
      // refuses the added row LOUDLY, which is why this is tolerated rather than treated as an
      // escalation.
      await expect(can(deepOrg.orgId, scopedSubject, pastBound)).rejects.toSatisfy(
        (error: unknown) => isWalkDepthExceeded(error),
        "the row the hint added is still 409 at get-by-id — ungovernable in both directions"
      );
    });

    it("the org-root principal — the only one who can repair such a row — still sees it", async () => {
      // The org-root short-circuit returns `null`, so the list query is today's verbatim and the
      // past-the-bound row is still listed. This is point 3 of the decision: converting downward
      // truncation into an error would turn a per-ROW fault into a whole-PAGE 409 for the scoped
      // principal while helping nobody, since the principal who can fix it never walks at all.
      expect(await readableIds(deepOrg.orgId, orgRootSubject)).toBeNull();
    });
  });
});

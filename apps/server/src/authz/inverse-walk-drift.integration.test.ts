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

/**
 * ================================================================================================
 * THE DRIFT DETECTOR — upward and downward must be EXACT INVERSES (role-model.md §8.3)
 * ================================================================================================
 *
 * `authz/resolve.ts` walks containment UPWARD from one object and asks "is a binding on this
 * chain?". `authz/readable-scope.ts` walks the SAME containment DOWNWARD from the subject's
 * bindings and asks "which objects does this authority reach?". Every get-by-id door runs the
 * first; since increment 2.5b every LIST door runs the second. §8.3 names the invariant that ties
 * them together and that nothing else in the tree enforces:
 *
 *      for every subject S and every object O:   hasPermission(S, O)  ⟺  O ∈ readableSet(S)
 *
 * **A route present upward but not downward is not a "narrower list".** It is an object that
 * `GET /objects/{id}` hands over at its own id and that `GET /objects/{type}` omits from every
 * page — which an operator debugs as a caching bug, a replication bug or a UI bug, because those
 * are what "the API has it but the list does not" looks like from outside. The opposite drift
 * (downward reaching further than upward) is a read leak on the same silent terms.
 *
 * The two walks are hand-synced ACROSS FILES on routes 1 and 2 (`graph/containment.ts`'s header
 * records that they already drifted once, taking a service-scoped freeze OPEN and a service-scoped
 * approval CLOSED with them, from one root cause), and share ONE fragment for routes 3 and 4. So
 * this file exists to make any future divergence fail loudly here, on its first run, rather than
 * in production as a mystery.
 *
 * ------------------------------------------------------------------------------------------------
 * HOW THIS DIFFERS FROM `authz/readable-scope.integration.test.ts`, WHICH ALSO ASSERTS THE PAIR
 * ------------------------------------------------------------------------------------------------
 * That file pins the invariant over a fixture that was DESIGNED for it — every rung named, every
 * route deliberately placed. A designed fixture proves the routes someone thought of. This one is
 * generated: a pseudo-random containment tree of mixed kinds, mixed parent routes and mixed depths,
 * whose shape nobody chose, plus an INDEPENDENT test-side model of reachability (below) that agrees
 * with neither production walk by construction. The three-way agreement is the point:
 *
 *   1. SQL upward   (`hasPermission`)                — production
 *   2. SQL downward (`readableObjectFilterFor`)      — production
 *   3. a JS breadth-first walk over the rows as they are actually PERSISTED  — this file only
 *
 * (1) vs (2) catches one walk changing. (3) catches BOTH changing together, which is precisely
 * what "hand-synced across two files" invites — a route deleted from `scopeExpandCte` AND from
 * `containmentChildrenSql` in the same edit leaves (1) and (2) in perfect agreement about an
 * authority that silently shrank.
 *
 * > ⚠️ Model (3) is a fourth expression of the four containment routes, and CLAUDE.md's standing
 * > rule ("do not hand-write a fourth copy of the containment walk") is about PRODUCTION code,
 * > where a copy is a thing that can drift unnoticed and be believed. Here it is the control: an
 * > oracle that agrees with the code under test is worthless, so this one is deliberately written
 * > from the persisted rows (three flat, non-recursive `SELECT`s) with the recursion in JS. It is
 * > ~25 lines, it is in one place, and if a FIFTH route is ever added it must be added here too —
 * > by design, because that edit is exactly the moment somebody should be made to prove the new
 * > route was taught to both walks.
 *
 * ------------------------------------------------------------------------------------------------
 * THE SHAPE IS RANDOM; THE RUN IS NOT
 * ------------------------------------------------------------------------------------------------
 * The tree is built from a seeded PRNG with a FIXED default seed, so CI is deterministic — a test
 * whose fixture changes per run reports failures nobody can reproduce, and this one is a gate, not
 * a fuzzer. Set `SCP_DRIFT_SEED` to re-shape it (a good thing to do while changing either walk);
 * the seed is printed in every failure message so a red run is reproducible from its own output.
 *
 * ------------------------------------------------------------------------------------------------
 * TWO STATES DELIBERATELY ABSENT FROM THE GENERATED TREE — the invariant is NOT universal
 * ------------------------------------------------------------------------------------------------
 * The invariant holds exactly on a LEGAL, LIVE estate. Two states diverge on purpose, both already
 * characterised and pinned by name in `authz/readable-scope.integration.test.ts`, and both are kept
 * OUT of this fixture because including them would make the object-by-object sample red for a
 * reason that is not drift:
 *
 *   1. A TOMBSTONED ROW reached by route 1. `scopeExpandCte`'s SEED is raw — no lookup, no liveness
 *      filter — so `hasPermission` walks up from a soft-deleted row to its live parent and answers
 *      TRUE at that row's own id, while every downward arm filters children live and omits it.
 *      Inert: no list door serves tombstones (they all filter `deleted_at IS NULL`), so there is no
 *      row the API hands over that a list hides. **Nothing here is ever deleted**, which is why
 *      this file's sample can assert plain equality.
 *   2. AN ORG-ROOT ALLOW CARRYING A DENY BELOW IT. The filter short-circuits to `null` (the whole
 *      org), while `hasPermission` in ISOLATION at a denied object answers false. That is not a
 *      defect but the thing that keeps the DOORS in agreement: `authz/org-root-arm.ts` evaluates
 *      the org-root arm first and deliberately never consults a below-root deny, so get-by-id
 *      admits those objects too. No subject here holds that combination.
 *
 * If either is ever "fixed", both halves have to move together — and this note is where to start.
 *
 * ------------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied ALONE to production code, measured 2026-08-26, then reverted
 * ------------------------------------------------------------------------------------------------
 * A drift detector that survives an arm being deleted is worthless, so every arm was deleted.
 *
 * | Mutation | Measured result |
 * |---|---|
 * | `containmentChildrenSql`: delete ARM 1 (the `domain_id` inverse) | **6 fail.** The invariant reports **25** disagreements; the model case 3 rows; `route 1 (domain_id)`; the deny case (`expected false to be true` — the ALLOWED sibling vanished with it); `a malformed effect does not SUBTRACT either`; and the depth case (`the row exactly at the bound must be readable: expected false to be true`). |
 * | `containmentChildrenSql`: delete ARM 2 (the `contains` inverse) | **4 fail.** The invariant reports **46** disagreements; the model case 8 rows; `route 2 … TWO HOPS` (`expected [ Array(1) ] to include '…'`); and pagination (`expected [] to deeply equal [ …(12) ]` — the service-bound principal's whole page is gone). |
 * | `containmentChildrenSql`: delete ARM 3 (the placement pair, routes 3 + 4) | **4 fail.** The invariant reports **17**; the model case 8; `route 3 (placement -> component)`; `route 4 (placement -> deployment-target)`. |
 * | `readableObjectFilterSql`: drop the deny descend and the `EXCEPT` | **3 fail.** The invariant reports **6**; the model case 1; the deny case names the row: `… is below the deny and must be absent from the list: expected true to be false`. Deny goes INERT on every list while still refusing at get-by-id — a deny that fails OPEN. |
 * | `partitionReadableRoots`: `effect === "allow"` → `effect !== "deny"` | **3 fail.** The invariant reports **12**; the model case 2; the malformed case: `ALLOW: the list must be empty: expected [ …(6) ] to deeply equal []`. A binding that grants NOTHING at get-by-id would hand over a whole subtree on every list. |
 * | `listObjects`: accept `readableFilter` and never push it into `conditions` (the "built, never installed" shape) | **1 fail — and exactly the right one.** Only the pagination case runs through the real HTTP door, and only it goes red: `expected [ …(27) ] to deeply equal [ …(12) ]`. |
 * | `insertMalformedEffectRoleBinding`: skip its `INSERT` — the FIXTURE, not production code | **File failed, `15 skipped`** — the guard throws in `beforeAll` with `insertMalformedEffectRoleBinding did not land … Every assertion resting on this row would have passed VACUOUSLY.` (Note the reporting shape: a dead `beforeAll` here reads as SKIPPED, never as failed tests. A run summary of `15 skipped` is a red file, not a quiet one.) With that read-back guard ALSO removed: **0 fail, 15 passed** — `a malformed effect grants NOTHING` is satisfied by there being no binding at all. Since drizzle/0096 this fixture has to drop a CHECK to write its row, so it is now the piece that can silently no-op; the guard is what keeps this suite from measuring nothing. |
 * | THE DISQUALIFIED DESIGN, simulated in this file: no filter in the query, `items` filtered in the handler | **1 fail, on the CONTRACT rather than on the row set** — `page 1 returned 0 of 5 rows but still carries a nextCursor — the filter was applied AFTER the LIMIT`. §8.2's measured production failure, reproduced at fixture scale. |
 */

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

  // ---------------------------------------------------------------------------------------------
  // Probes — the two production walks, and the test-side model.
  // ---------------------------------------------------------------------------------------------

  /** The UPWARD walk at ONE object. Throws `walkDepthExceeded` (409) rather than returning false
   *  when a refusal cannot be trusted (ADR-0037) — the depth cases below depend on that. */
  async function can(orgId: string, subjectObjectId: string, scopeObjectId: string) {
    return withTenantTx(server.deps.db, orgId, (tx) =>
      hasPermission(tx, { orgId, subjectObjectId, permission: "object:read", scopeObjectId })
    );
  }

  /**
   * The DOWNWARD walk, run the way a list door runs it: the filter composed into a query over live
   * rows, i.e. `o.id IN (…)` before any LIMIT.
   *
   * `null` is returned AS `null`, never as a set. It means NO FILTER (the org-root short-circuit),
   * which is the opposite of the empty set, and every caller here has to say which one it expects.
   */
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

  /**
   * MODEL (3) — the containment graph read straight out of the tables, as three FLAT selects, with
   * no recursion anywhere in SQL. Parent -> children, over the same four routes the two production
   * walks use, expressed once, here, and nowhere else in test code.
   *
   * Route 1 `objects.domain_id`; route 2 the `contains` edge read forwards; routes 3+4 a live
   * placement's `componentId` and `deploymentTargetId` PROPERTIES (the source of truth per
   * ADR-0026 D17 — the `places`/`placed_at` edges are derived). Only LIVE children are recorded,
   * matching both walks: upward the ancestor JOIN filters `deleted_at IS NULL`, downward every arm
   * does.
   */
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

  /** Model (3)'s walk: breadth-first from `roots`, bounded by the SAME constant both production
   *  walks use — a node found at depth `CONTAINMENT_WALK_MAX_DEPTH` is included, and is not
   *  expanded. `Set` dedupes on FIRST arrival, so a DAG node (a component reachable via its domain
   *  at depth 1 and via its service at depth 2) is visited once, at its SHORTEST depth. The
   *  production `UNION`s do NOT do that — their recursive rows are `(id, depth)` pairs, so such a
   *  node is emitted twice and its subtree walked twice (measured, PostgreSQL 16). The two still
   *  agree on the only thing compared here, MEMBERSHIP, and they agree at the BOUND too: shortest
   *  depth is what decides whether a node is within `CONTAINMENT_WALK_MAX_DEPTH` hops, and a
   *  duplicate arrival deeper down can only be expanded to rows the shorter route already reached. */
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

  /** A role binding written with an ARBITRARY `effect` — the one thing here not built through the
   *  API, because no door will ever write anything but 'allow'/'deny'.
   *
   *  Since drizzle/0096 the DATABASE refuses anything else too (`role_bindings_effect_check`), so a
   *  malformed value is routed to `insertMalformedEffectRoleBinding` — which builds the row THE ONLY
   *  WAY IT CAN STILL EXIST (a privileged path with the CHECK momentarily dropped, i.e. what a
   *  pre-0096 `pg_dump` restores or a DBA does) rather than pretending the shape went away. See that
   *  helper's doc for why the constraint does not retire these cases: it stops the row being
   *  written, not the row being READ, and the resolver's exact-string classification is the inner
   *  layer that keeps it harmless. Legal effects still take the ordinary path, unchanged. */
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

    // ---- the four routes, placed deliberately ------------------------------------------------
    // A generated tree can omit a route by chance, and a drift detector that silently stopped
    // covering route 4 is exactly the failure this file exists to catch elsewhere. So the four
    // routes are ALSO built by hand, named, and asserted individually below; the generated tree is
    // what surrounds them.
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
      // Delimiter is '|', deliberately NOT NUL. This is a throwaway dedupe key for the loop
      // below: never split apart, never persisted, never crossing a boundary. A uuid contains
      // only hex and hyphens, so '|' cannot collide any more than NUL can -- and a NUL here
      // would add this file to scripts/nul-census.mjs's permanent set, after which every
      // recursive census in the repo silently drops one more file. The NUL delimiters in
      // plan-diff.ts and friends ARE correct and load-bearing; this one would buy nothing.
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

  /**
   * MODEL (3). Catches the drift the test above cannot: both production walks changed together.
   * The oracle is built from the persisted rows by three flat selects and a JS breadth-first walk,
   * so it shares no SQL, no fragment and no file with either walk under test.
   */
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

  /**
   * ⚠️ MUTATION-PROVEN (header table): removing the deny descend + `EXCEPT` from
   * `readableObjectFilterSql` fails this test AND the invariant test — deny goes INERT on every
   * list door while still refusing on get-by-id. A deny that fails OPEN.
   */
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

  // ---------------------------------------------------------------------------------------------
  // 4. §8.3 hazard: A `role_bindings.effect` THAT IS NEITHER 'allow' NOR 'deny'.
  //    `role_bindings_effect_check` (drizzle/0096) refuses one at the database now; these rows are
  //    built through `insertMalformedEffectRoleBinding`, which reproduces the only way one can
  //    still exist — pre-dating the constraint, in a restored dump. See `bindRaw` above.
  // ---------------------------------------------------------------------------------------------

  /**
   * `hasPermission` classifies in JS — `effects.includes('deny')`, then `effects.includes('allow')`
   * — so ANY other string grants nothing and denies nothing. A filter written `effect <> 'deny'`
   * mirrors that function while being strictly LOOSER than it: the same row that is refused at
   * get-by-id would hand over a whole subtree on every list door.
   *
   * ⚠️ MUTATION-PROVEN (header table): `partitionReadableRoots`'s `effect === "allow"` relaxed to
   * `effect !== "deny"` fails both cases here and the invariant test.
   *
   * `''` is covered as well as `'ALLOW'` deliberately: `<> 'deny'` and `= 'allow'` differ on EVERY
   * other string, and the empty string is the one a bad migration default or a truncated write
   * produces, where `'ALLOW'` is the one a human types.
   */
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

  /**
   * §8.2 rejected per-row post-filtering on PAGINATION, not on cost: every list repo is
   * keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last
   * UNFILTERED row, so a filter applied to the returned page is applied AFTER the LIMIT. Measured
   * on a 20,910-object estate: an assembly-bound principal's 5 readable components at cursor ranks
   * 97/140/254/339/440 of 18,500 give ONE row on page 1 and ZERO on pages 6 through 185, each
   * carrying a valid `nextCursor`, while 27 of 30 `apps/web` list call sites fetch exactly one page.
   *
   * "The subject sees only their subtree" does NOT catch that — it passes on one small page. These
   * are the assertions that separate a query-side filter from a post-filter:
   *
   *   - a page that carries a `nextCursor` is FULL;
   *   - no page is empty while promising more;
   *   - the walk terminates, and returns each readable row exactly once.
   *
   * 12 readable components interleaved 2:1 with 6 unreadable ones at `limit=5` — so no page is
   * homogeneous, and the last page is deliberately SHORT (2 rows) with a null cursor.
   */
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

  /**
   * ================================================================================================
   * WHAT WAS DECIDED, AND WHAT THIS PINS
   * ================================================================================================
   * ADR-0037 converts an untrustworthy UPWARD refusal at depth > `CONTAINMENT_WALK_MAX_DEPTH` into
   * a loud `walkDepthExceeded` (409). Downward there is no such conversion and — per
   * `authz/readable-scope.ts`'s decision block — deliberately none: a row past the bound is simply
   * absent from the list. §8.3 warns that the two walks disagreeing SILENTLY is the failure mode,
   * so the decision is pinned here rather than left as prose.
   *
   * WHAT THE TWO DIRECTIONS ACTUALLY DO, measured below:
   *
   *   - MEMBERSHIP AGREES. Both walks are bounded by the same constant with the same `depth <`
   *     shape, so `descend(root)` and `scopeExpand(object)` truncate at exactly the same hop count:
   *     a row 10 hops below its binding is readable BOTH ways, and a row 11 hops below is refused
   *     BOTH ways. There is no row the list hides that get-by-id would have handed over.
   *   - ONLY LOUDNESS DIFFERS. At 11 hops the upward door answers **409**, not 200 and not 403,
   *     because the refusal cannot be trusted; the list simply omits the row.
   *   - THE ORG-ROOT PRINCIPAL — the one who can actually repair such a row — short-circuits to
   *     `null` and still sees it, exactly as today.
   *
   * ================================================================================================
   * WHY THIS ORG IS BUILT PARTLY BY HAND, AND WHY IT IS A SEPARATE ORG
   * ================================================================================================
   * A live row past the bound CANNOT be created through the API: `assertContainmentDepthAdmits`
   * refuses it at all three write doors, on create AND on move (`containment-depth-doors.
   * integration.test.ts` is that door's own gate). It exists in exactly two ways — a federation
   * import, which is carved out because the receiver does not referee a peer-authored containment,
   * and legacy rows predating ADR-0037. So the last two links are planted with a direct `UPDATE`,
   * the same "no API can write this, which is the hazard" exception the malformed-`effect` bindings
   * take.
   *
   * It gets its OWN ORG because a past-the-bound row makes `hasPermission` THROW for every subject
   * at that row — it is a property of the row's chain, not of the caller — which would take the
   * object-by-object invariant test above with it.
   */
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

    /**
     * ================================================================================================
     * `?scopeObjectId=` RE-SEEDS THE BOUND — the one case where the hint is NOT a subset
     * ================================================================================================
     * `authz/list-door-scope.ts` documents the hint as "a narrowing of your own results, never a
     * widening", justified by "every row below the hint is below your allow root too". That holds
     * for membership and FAILS for the BOUND, because both descends are bounded
     * `CONTAINMENT_WALK_MAX_DEPTH` FROM THEIR OWN SEED: a hint `k` hops below the allow root pushes
     * the horizon `k` hops deeper.
     *
     * This is the truncation case the three tests above do not reach — they all measure the UNHINTED
     * filter. Measured here instead of argued: the binding is at hop 1, the hint at hop 3, and the
     * hop-12 row that "must be absent from the list" two tests up comes BACK when the hint is
     * supplied, because it is 9 hops below the hint and 11 below the binding.
     *
     * TOLERATED, NOT FIXED — the same trade `readable-scope.ts`'s decision block already takes:
     * unreachable on a legally-built estate (every write door keeps live rows within the bound of
     * the org root), and where it does fire the extra rows are inside the caller's OWN allow subtree
     * and answer 409 rather than 200 at get-by-id. Pinned so that changing it later — by
     * intersecting the two descends, say — is a red test and a deliberate act.
     */
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

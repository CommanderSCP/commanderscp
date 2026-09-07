import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { ScpClient } from "@scp/sdk";
import * as schema from "../db/schema.js";
import { createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { listObjects } from "../graph/objects-repo.js";
import { authorizeListAndScope } from "../authz/list-scope.js";
import type { PermissionCheck } from "../authz/resolve.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  testRuntimeDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** LIST DOORS, ROW-SCOPED. See docs/routes.md §258. */
describe("list doors: rows are scoped to the caller's authority (role-model.md §8.2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  let domainA: string;
  let domainB: string;
  let serviceMine: string;
  let serviceNext: string;
  let serviceFar: string;
  let mineComponents: string[];
  let otherComponents: string[];

  /** Viewer bound ONLY at `serviceMine` — the ComponentAdmin shape §8 is about. */
  let scoped: ScpClient;
  /** Viewer bound at `domainA` — used for the two SERVICE list doors. */
  let domainScoped: ScpClient;
  /** Viewer bound at the org root — must observe today's behaviour, unchanged. */
  let orgRootViewer: ScpClient;
  let orgRootViewerSubjectId: string;
  /** A real user with a live token and NO role binding at all — must still get 403, not `[]`. */
  let unbound: ScpClient;
  /** An org-root allow CANCELLED by an org-root deny — the filter builder's short-circuit trap. */
  let rootDenied: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  async function clientFor(
    bindings: { role: string; scope: string; effect?: "allow" | "deny" }[]
  ): Promise<{ client: ScpClient; subjectObjectId: string }> {
    const user = await createTestUser(server, org, bindings);
    return {
      client: new ScpClient({ baseUrl: server.baseUrl, token: user.token }),
      subjectObjectId: user.objectId
    };
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "list-readable");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    domainA = (await admin.object("domain").create({ name: uniq("domain-a") })).id;
    domainB = (await admin.object("domain").create({ name: uniq("domain-b") })).id;
    serviceMine = (await admin.services.create({ name: uniq("svc-mine"), domainId: domainA })).id;
    serviceNext = (await admin.services.create({ name: uniq("svc-next"), domainId: domainA })).id;
    serviceFar = (await admin.services.create({ name: uniq("svc-far"), domainId: domainB })).id;

    // INTERLEAVED on purpose — see the fixture note. 25 readable, 5 unreadable, one unreadable
    // dropped in after every fifth readable row, so no page of 10 is homogeneous.
    mineComponents = [];
    otherComponents = [];
    for (let i = 0; i < 25; i++) {
      mineComponents.push(
        (
          await admin.components.create({
            name: uniq(`mine-${String(i).padStart(2, "0")}`),
            service: serviceMine
          })
        ).id
      );
      if (i % 5 === 4) {
        otherComponents.push(
          (
            await admin.components.create({
              name: uniq(`next-${String(i).padStart(2, "0")}`),
              service: serviceNext
            })
          ).id
        );
      }
    }
    otherComponents.push(
      (await admin.components.create({ name: uniq("far-00"), service: serviceFar })).id
    );

    scoped = (await clientFor([{ role: "Viewer", scope: serviceMine }])).client;
    domainScoped = (await clientFor([{ role: "Viewer", scope: domainA }])).client;
    const rootViewer = await clientFor([{ role: "Viewer", scope: org.orgId }]);
    orgRootViewer = rootViewer.client;
    orgRootViewerSubjectId = rootViewer.subjectObjectId;
    unbound = (await clientFor([])).client;
    rootDenied = (
      await clientFor([
        { role: "Viewer", scope: org.orgId },
        { role: "Viewer", scope: org.orgId, effect: "deny" }
      ])
    ).client;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  /** Walks EVERY page of a list door, asserting the pagination contract as it goes, and returns the
   *  ids in cursor order. The contract assertions live here rather than in one test because they
   *  are what separates a query-side filter from a post-filter, and they must hold on every door. */
  async function walkAllPages(
    label: string,
    limit: number,
    fetch: (cursor: string | undefined) => Promise<{ items: { id: string }[]; nextCursor: unknown }>
  ): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await fetch(cursor);
      pages += 1;
      const next = (page.nextCursor ?? undefined) as string | undefined;

      // THE POST-FILTER SIGNATURE, refused explicitly: a page that carries a cursor must be FULL.
      // A post-filter shrinks pages after the LIMIT, so it produces short pages — and eventually
      // empty ones — that still promise more.
      if (next !== undefined) {
        expect(
          page.items.length,
          `${label}: page ${pages} returned ${page.items.length} of ${limit} rows but still carries a nextCursor — the filter was applied AFTER the LIMIT`
        ).toBe(limit);
      }
      for (const item of page.items) seen.push(item.id);
      cursor = next;
      expect(pages, `${label}: pagination did not terminate`).toBeLessThanOrEqual(20);
    } while (cursor);
    expect(new Set(seen).size, `${label}: a row was returned on two different pages`).toBe(
      seen.length
    );
    return seen;
  }

  // ---------------------------------------------------------------------------------------------
  // 1. THE CAPABILITY: a scoped principal can list, and sees exactly their subtree.
  // ---------------------------------------------------------------------------------------------

  /** Mutation-proven: deleting that condition fails this. See docs/routes.md §259. */
  it("a service-bound principal lists ONLY its own subtree (GET /components)", async () => {
    const page = await scoped.components.list({ limit: 100 });
    expect(page.items.map((i) => i.id).sort()).toEqual([...mineComponents].sort());
    for (const id of otherComponents) {
      expect(page.items.map((i) => i.id)).not.toContain(id);
    }
  });

  /** THE CASE §8.2's measurement is about. See docs/routes.md §260. */
  it("readable rows paginate exactly: full pages, honest cursor, every row once", async () => {
    const seen = await walkAllPages("GET /components (scoped, limit=10)", 10, (cursor) =>
      scoped.components.list({ limit: 10, ...(cursor ? { cursor } : {}) })
    );
    expect(seen.length).toBe(25);
    expect([...seen].sort()).toEqual([...mineComponents].sort());
  });

  it("the same subtree comes back through the GENERIC door (GET /objects/component)", async () => {
    const page = await scoped.object("component").list({ limit: 100 });
    expect(page.items.map((i) => i.id).sort()).toEqual([...mineComponents].sort());
  });

  it("a domain-bound principal lists its domain's services (GET /services — the registry factory)", async () => {
    const page = await domainScoped.services.list({ limit: 100 });
    const ids = page.items.map((i) => i.id);
    expect(new Set(ids)).toEqual(new Set([serviceMine, serviceNext]));
    expect(ids).not.toContain(serviceFar);
  });

  it("and through the LEGACY door a routes/ census cannot see (GET /objects/service)", async () => {
    const page = await domainScoped.objects.service.list({ limit: 100 });
    const ids = page.items.map((i) => i.id);
    expect(new Set(ids)).toEqual(new Set([serviceMine, serviceNext]));
    expect(ids).not.toContain(serviceFar);
  });

  // ---------------------------------------------------------------------------------------------
  // 2. THE PURE-WIDENING INVARIANT: nothing that worked before may change.
  // ---------------------------------------------------------------------------------------------

  it("an org-root Viewer sees everything, on every one of the four doors", async () => {
    const components = await walkAllPages("GET /components (org root, limit=10)", 10, (cursor) =>
      orgRootViewer.components.list({ limit: 10, ...(cursor ? { cursor } : {}) })
    );
    expect(new Set(components)).toEqual(new Set([...mineComponents, ...otherComponents]));

    const generic = await orgRootViewer.object("component").list({ limit: 100 });
    expect(new Set(generic.items.map((i) => i.id))).toEqual(
      new Set([...mineComponents, ...otherComponents])
    );

    const services = await orgRootViewer.services.list({ limit: 100 });
    expect(new Set(services.items.map((i) => i.id))).toEqual(
      new Set([serviceMine, serviceNext, serviceFar])
    );

    const legacy = await orgRootViewer.objects.service.list({ limit: 100 });
    expect(new Set(legacy.items.map((i) => i.id))).toEqual(
      new Set([serviceMine, serviceNext, serviceFar])
    );
  });

  /** That claim is about the code, so it is checked as code. See docs/routes.md §261. */
  it("an org-root principal's statement is today's — the gate returns null and the SQL gains nothing", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = createPool(testRuntimeDatabaseUrl());
    const loggedDb = drizzle(pool, {
      schema,
      logger: { logQuery: (query, params) => captured.push({ sql: query, params }) }
    });

    try {
      const orgRootCheck: PermissionCheck = {
        orgId: org.orgId,
        subjectObjectId: orgRootViewerSubjectId,
        permission: "object:read",
        scopeObjectId: org.orgId
      };

      const filter = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        authorizeListAndScope(tx, orgRootCheck)
      );
      expect(
        filter,
        "an org-root holder must resolve to NO filter, not to an empty set"
      ).toBeNull();

      // (2) the emitted statement, with that null. `withTenantTx` also logs `SET LOCAL ROLE`, its
      // `SELECT set_config(...)` and `commit`, so the list query is picked out by what it reads
      // rather than by position.
      captured.length = 0;
      await withTenantTx(loggedDb, org.orgId, (tx) =>
        listObjects(tx, org.orgId, "component", { limit: 20 }, null)
      );
      const listQueries = (): { sql: string; params: unknown[] }[] =>
        captured.filter((c) => /^\s*select\b/i.test(c.sql) && /\bfrom\s+"objects"/i.test(c.sql));
      expect(listQueries().length, "listObjects must emit exactly one list query").toBe(1);
      const unfiltered = listQueries()[0];
      expect(unfiltered).toBeDefined();
      // Reported so a future change to the statement is visible in the run, not only in a diff.
      console.log(`[org-root statement] ${unfiltered!.sql}`);
      expect(
        unfiltered!.sql,
        "the org-root statement grew a subquery — it is no longer today's query"
      ).not.toMatch(/\bin\s*\(\s*\(?\s*(?:with|select)\b/i);
      expect(unfiltered!.sql).not.toContain("readable_allow");
      // org_id, type_id, limit — and nothing else. A pushed condition binds at least one more.
      expect(unfiltered!.params).toEqual([org.orgId, "component", 21]);

      // (3) the control: a REAL filter does change the statement, so (2) is not vacuous.
      const realFilter = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        authorizeListAndScope(tx, {
          ...orgRootCheck,
          subjectObjectId: (await createTestUser(server, org, [{ role: "Viewer", scope: domainA }]))
            .objectId
        })
      );
      expect(realFilter, "control: a service-scoped subject must produce a filter").not.toBeNull();
      captured.length = 0;
      await withTenantTx(loggedDb, org.orgId, (tx) =>
        listObjects(tx, org.orgId, "component", { limit: 20 }, realFilter)
      );
      const filtered = listQueries()[0];
      expect(filtered).toBeDefined();
      console.log(`[scoped statement]  ${filtered!.sql}`);
      expect(filtered!.sql).toContain("readable_allow");
      expect(filtered!.params.length).toBeGreaterThan(unfiltered!.params.length);
    } finally {
      await pool.end();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE REFUSALS. A widening that stops refusing is not a widening.
  // ---------------------------------------------------------------------------------------------

  /** Mutation-proven: replacing that branch fails this. See docs/routes.md §262. */
  it("a principal with NO binding still gets 403 — not an empty 200 — on all four doors", async () => {
    await expect(unbound.components.list({ limit: 10 })).rejects.toThrow(/forbidden/i);
    await expect(unbound.object("component").list({ limit: 10 })).rejects.toThrow(/forbidden/i);
    await expect(unbound.services.list({ limit: 10 })).rejects.toThrow(/forbidden/i);
    await expect(unbound.objects.service.list({ limit: 10 })).rejects.toThrow(/forbidden/i);
  });

  /** The short-circuit trap, and why the arm refuses a null. See docs/routes.md §263. */
  it("an org-root allow cancelled by an org-root deny is still a 403, not the whole org", async () => {
    await expect(rootDenied.components.list({ limit: 100 })).rejects.toThrow(/forbidden/i);
    await expect(rootDenied.services.list({ limit: 100 })).rejects.toThrow(/forbidden/i);
  });

  /** The scoped principal's reach excludes objects above them. See docs/routes.md §264. */
  it("a service-bound principal cannot list the services above it", async () => {
    const page = await scoped.services.list({ limit: 100 });
    expect(page.items.map((i) => i.id)).toEqual([serviceMine]);
    expect(page.items.map((i) => i.id)).not.toContain(serviceNext);
  });
});

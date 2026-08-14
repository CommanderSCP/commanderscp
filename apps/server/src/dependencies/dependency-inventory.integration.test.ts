import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { relationships, users } from "../db/schema.js";
import { slugify } from "../graph/urn.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  RawScpAppClient,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  declareDependencyLineProducer,
  getDependencyLineByKey,
  listComponentDependencies,
  listComponentsDeclaringLine,
  listDependencyLinesByIds,
  pruneComponentDependencies,
  recordDependencyLineHead,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";

/**
 * M21.2 — the dependency inventory substrate (ADR-0032 §3/§4/§5/§7, migration 0060).
 *
 * Four properties are load-bearing and each is pinned here rather than left to the migration's
 * comments, because a comment naming a hazard is a signal to sweep, not evidence it was handled
 * (CLAUDE.md, "census by property"):
 *
 *   1. The tables ROUND-TRIP, and both hot queries are the single-hop lookups ADR-0032 §4 promises.
 *   2. RLS ISOLATES TWO ORGS. A dependency inventory is a map of an org's entire software estate;
 *      this is the one that leaks something if it is wrong, so it is probed with a RAW `scp_app`
 *      connection (no application code, no `withTenantTx`) exactly as `graph/rls.integration.test.ts`
 *      does — the database's own defenses, independent of whether the repo layer remembers to filter.
 *   3. `@acme/lib` and `acme-lib` are DIFFERENT LINES. This is the URN-collision case that is the
 *      whole reason the inventory is tabular, and the test asserts the collision is REAL by running
 *      the coordinates through `slugify` itself rather than asserting against a remembered claim.
 *   4. NO `depends_on` EDGE, and no relationship at all, is minted by any of it (ADR-0032 §5).
 *
 * Every absence assertion below carries a NEGATIVE CONTROL in the same test — a test proving nothing
 * happened is vacuous unless it also proves the thing that SHOULD happen did.
 */
describe("dependency inventory substrate (ADR-0032, migration 0060)", () => {
  let server: ListeningTestServer;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let clientA: ScpClient;
  let clientB: ScpClient;
  /** Org A's bootstrap admin's graph `user` object — the PRINCIPAL a producer declaration is
   *  attributed to (charter principle 6: "who asserted this line is internal?"). */
  let adminObjectIdA: string;

  beforeAll(async () => {
    server = await listenTestServer();
    orgA = await createTestOrg(server, "dep-inventory-a");
    orgB = await createTestOrg(server, "dep-inventory-b");
    clientA = new ScpClient({ baseUrl: server.baseUrl, token: orgA.adminToken });
    clientB = new ScpClient({ baseUrl: server.baseUrl, token: orgB.adminToken });
    const [adminRow] = await server.deps.db
      .select({ objectId: users.objectId })
      .from(users)
      .where(eq(users.username, orgA.adminUsername));
    if (!adminRow?.objectId) throw new Error("expected the bootstrap admin to have a user object");
    adminObjectIdA = adminRow.objectId;
  });

  afterAll(async () => {
    await server?.close();
  });

  const componentIn = async (client: ScpClient, name: string): Promise<string> =>
    (await createTestComponent(client, { name: `${name}-${uuidv7()}` })).id;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, orgA.orgId, fn);
  const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, orgB.orgId, fn);

  // -----------------------------------------------------------------------------------------
  // (a) Round-trip
  // -----------------------------------------------------------------------------------------

  it("round-trips a line and a component's declaration of it, in both directions", async () => {
    const componentId = await componentIn(clientA, "api");

    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/lib",
        major: "v1"
      })
    );
    expect(line.coordinate).toBe("github.com/acme/lib");
    expect(line.major).toBe("v1");
    // Third-party until DECLARED otherwise (ADR-0032 §7). Absent never means internal.
    expect(line.producedByObjectId).toBeNull();
    expect(line.producedByDeclaredAt).toBeNull();
    // `tag_pattern` is `oci`-only and is normalised to NULL for the language ecosystems.
    expect(line.tagPattern).toBeNull();

    const declaration = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: line.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.4.0",
        resolvedVersion: "1.4.0",
        observedRef: "refs/heads/main"
      })
    );
    expect(declaration.declaredVersion).toBe("v1.4.0");
    expect(declaration.resolvedVersion).toBe("1.4.0");
    expect(declaration.observedRef).toBe("refs/heads/main");

    // FORWARD — "what does component C declare?"
    const forward = await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId));
    expect(forward).toHaveLength(1);
    expect(forward[0]?.lineId).toBe(line.id);

    // REVERSE — "which components declare line L?" (the dependency-subscription fan-out list).
    const reverse = await inA((tx) => listComponentsDeclaringLine(tx, orgA.orgId, line.id));
    expect(reverse.map((r) => r.componentObjectId)).toEqual([componentId]);

    const hydrated = await inA((tx) => listDependencyLinesByIds(tx, orgA.orgId, [line.id]));
    expect(hydrated.map((l) => l.id)).toEqual([line.id]);
  });

  it("upsert is idempotent on the natural key and does not mint a second line", async () => {
    const key = { ecosystem: "npm", coordinate: "@acme/idem", major: "1" } as const;
    const first = await inA((tx) => upsertDependencyLine(tx, orgA.orgId, key));
    const second = await inA((tx) => upsertDependencyLine(tx, orgA.orgId, key));
    expect(second.id).toBe(first.id);

    const fetched = await inA((tx) => getDependencyLineByKey(tx, orgA.orgId, key));
    expect(fetched?.id).toBe(first.id);
  });

  it("re-observing a manifest updates the declaration in place, and a prune scoped to ONE manifest leaves the others alone", async () => {
    const componentId = await componentIn(clientA, "prune");
    const go = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/kept",
        major: "v1"
      })
    );
    const npmLine = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/dropped",
        major: "2"
      })
    );
    const image = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "docker.io/library/alpine",
        major: "3",
        tagPattern: "3.*"
      })
    );
    // `tag_pattern` is `oci`-ONLY — normalised to NULL at the single write choke point so a language
    // ecosystem can never carry a field a later parser would mistake for configuration.
    expect(image.tagPattern).toBe("3.*");
    expect(npmLine.tagPattern).toBeNull();

    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: go.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.0.0"
      })
    );
    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: npmLine.id,
        manifestPath: "package.json",
        declaredVersion: "^2.0.0"
      })
    );
    // The image case: a `FROM alpine:3.18` in the component's own build input, carrying the DIGEST,
    // because a mutable tag is not an identity (ADR-0032 §7).
    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: image.id,
        manifestPath: "Dockerfile",
        declaredVersion: "3.18",
        resolvedVersion: "3.18.4",
        resolvedDigest: "sha256:" + "a".repeat(64)
      })
    );

    // Re-observing the same (component, line, manifest) UPDATES; it does not insert a second row.
    const updated = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: go.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.5.0"
      })
    );
    expect(updated.declaredVersion).toBe("v1.5.0");
    expect(await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId))).toHaveLength(
      3
    );

    // A `package.json` re-read that no longer declares `@acme/dropped` prunes exactly that row.
    const removed = await inA((tx) =>
      pruneComponentDependencies(tx, orgA.orgId, {
        componentObjectId: componentId,
        manifestPath: "package.json",
        keepLineIds: []
      })
    );
    expect(removed).toBe(1);

    // NEGATIVE CONTROL for the prune's scoping: `go.mod` and `Dockerfile` are untouched. Without the
    // manifest-path predicate this would be 0 and the whole component's inventory would be gone.
    const survivors = await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId));
    expect(survivors.map((s) => s.manifestPath).sort()).toEqual(["Dockerfile", "go.mod"]);
    const dockerfile = survivors.find((s) => s.manifestPath === "Dockerfile");
    expect(dockerfile?.resolvedDigest).toBe("sha256:" + "a".repeat(64));

    // Scoping the forward lookup to one manifest is the same single-hop read, narrowed.
    const onlyGoMod = await inA((tx) =>
      listComponentDependencies(tx, orgA.orgId, componentId, { manifestPath: "go.mod" })
    );
    expect(onlyGoMod.map((d) => d.lineId)).toEqual([go.id]);
  });

  it("the producer link is a separate verb, is retractable, and cannot be half-written", async () => {
    const producer = await componentIn(clientA, "publisher");
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "maven",
        coordinate: "com.acme:internal-lib",
        major: "3"
      })
    );
    // NEGATIVE CONTROL: ingestion alone never makes a line internal (ADR-0032 §7 — declared, never
    // inferred). The coordinate here is as "internal-looking" as a name can be and it changes nothing.
    expect(line.producedByObjectId).toBeNull();

    const declared = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: producer,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(declared.producedByObjectId).toBe(producer);
    expect(declared.producedByDeclaredAt).not.toBeNull();

    const retracted = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: null,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(retracted.producedByObjectId).toBeNull();
    // The declaration timestamp is cleared WITH the link — a stale "declared at" beside a null
    // producer would read as evidence a human had asserted something they had retracted.
    expect(retracted.producedByDeclaredAt).toBeNull();
    expect(retracted.producedByDeclaredByObjectId).toBeNull();

    // The database refuses a producer with no declaration behind it, so an ingestion path that
    // "worked out" a producer cannot persist one even by writing raw SQL: the capability is missing
    // rather than guarded (0060 header; the shape 0059 used for `objects.domain_local`).
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgA.orgId);
    await expect(
      raw.query("UPDATE dependency_lines SET produced_by_object_id = $1 WHERE id = $2", [
        producer,
        line.id
      ])
    ).rejects.toThrow(/dependency_lines_internal_is_declared/i);
    await raw.close();
  });

  it("records an observed line head without disturbing identity or the producer link", async () => {
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "registry.internal/base/node",
        major: "22",
        tagPattern: "22.*"
      })
    );
    // NULL is "not yet observed", NOT "no newer version exists" — absent never means zero.
    expect(line.latestVersion).toBeNull();
    expect(line.latestObservedAt).toBeNull();

    const observed = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "22.6.0",
        latestDigest: "sha256:" + "b".repeat(64)
      })
    );
    expect(observed.latestVersion).toBe("22.6.0");
    expect(observed.latestDigest).toBe("sha256:" + "b".repeat(64));
    expect(observed.latestObservedAt).not.toBeNull();
    // Identity columns are untouched by an observation.
    expect(observed.coordinate).toBe("registry.internal/base/node");
    expect(observed.major).toBe("22");
    expect(observed.tagPattern).toBe("22.*");
  });

  // -----------------------------------------------------------------------------------------
  // (c) The URN-collision case — the reason the inventory is a table at all
  // -----------------------------------------------------------------------------------------

  it("treats '@acme/lib', 'acme/lib' and 'acme-lib' as THREE lines, which one URN could not", () => {
    // The hazard, asserted rather than remembered: `deriveUrn`'s slug collapses all three into one
    // identity (graph/urn.ts:6-14), which is a 409 with no auto-suffix and no upsert-by-coordinate.
    expect(slugify("@acme/lib")).toBe("acme-lib");
    expect(slugify("acme/lib")).toBe("acme-lib");
    expect(slugify("acme-lib")).toBe("acme-lib");
  });

  it("keys lines on the VERBATIM coordinate, so URN-colliding coordinates stay distinct", async () => {
    const coordinates = ["@acme/lib", "acme/lib", "acme-lib"];
    const lines = await inA(async (tx) => {
      const out = [];
      for (const coordinate of coordinates) {
        out.push(
          await upsertDependencyLine(tx, orgA.orgId, { ecosystem: "npm", coordinate, major: "1" })
        );
      }
      return out;
    });

    // Three coordinates, three ids, and each stored byte-for-byte as written.
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
    expect(lines.map((l) => l.coordinate)).toEqual(coordinates);

    // Each is independently addressable by its own natural key — the property a shared slug destroys.
    for (const [i, coordinate] of coordinates.entries()) {
      const fetched = await inA((tx) =>
        getDependencyLineByKey(tx, orgA.orgId, { ecosystem: "npm", coordinate, major: "1" })
      );
      expect(fetched?.id).toBe(lines[i]?.id);
    }

    // NEGATIVE CONTROL: the key really is a key. Re-upserting one of them returns the SAME row, so
    // the three-way distinctness above is the coordinate doing work, not the upsert failing to
    // deduplicate anything at all.
    const again = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        major: "1"
      })
    );
    expect(again.id).toBe(lines[0]?.id);
  });

  it("separates lines that differ ONLY by major, and lines that differ ONLY by ecosystem", async () => {
    const one = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "python",
        coordinate: "shared-name",
        major: "1"
      })
    );
    const two = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "python",
        coordinate: "shared-name",
        major: "2"
      })
    );
    const otherEcosystem = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "shared-name",
        major: "1"
      })
    );
    expect(new Set([one.id, two.id, otherEcosystem.id]).size).toBe(3);
  });

  // -----------------------------------------------------------------------------------------
  // (b) RLS — the load-bearing one
  // -----------------------------------------------------------------------------------------

  describe("RLS isolates two orgs' inventories", () => {
    let lineAId: string;
    let componentAId: string;

    beforeAll(async () => {
      componentAId = await componentIn(clientA, "rls-secret");
      const line = await inA((tx) =>
        upsertDependencyLine(tx, orgA.orgId, {
          ecosystem: "go",
          coordinate: "github.com/acme/org-a-only",
          major: "v1"
        })
      );
      lineAId = line.id;
      await inA((tx) =>
        upsertComponentDependency(tx, orgA.orgId, {
          componentObjectId: componentAId,
          lineId: lineAId,
          manifestPath: "go.mod",
          declaredVersion: "v1.0.0"
        })
      );
    });

    it("both tables ENABLE and FORCE row level security", async () => {
      // FORCE matters independently of ENABLE: without it the table's OWNER bypasses every policy,
      // and a migration or maintenance path running as owner would read across orgs.
      const rows = await server.deps.db.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`SELECT relname, relrowsecurity, relforcerowsecurity
             FROM pg_class
             WHERE relname IN ('dependency_lines', 'component_dependencies')`);
      const byName = new Map(rows.rows.map((r) => [r.relname, r]));
      expect(byName.size).toBe(2);
      for (const name of ["dependency_lines", "component_dependencies"]) {
        expect(byName.get(name)?.relrowsecurity, name).toBe(true);
        expect(byName.get(name)?.relforcerowsecurity, name).toBe(true);
      }
    });

    it("the policy carries BOTH a USING and a WITH CHECK qual on each table", async () => {
      // A USING-only policy filters reads but lets an org WRITE a row stamped with another org's id.
      const rows = await server.deps.db.execute<{
        tablename: string;
        qual: string | null;
        with_check: string | null;
      }>(sql`SELECT tablename, qual, with_check
             FROM pg_policies
             WHERE tablename IN ('dependency_lines', 'component_dependencies')
               AND policyname = 'org_isolation'`);
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.qual, row.tablename).toContain("app.current_org_id");
        expect(row.with_check, row.tablename).toContain("app.current_org_id");
      }
    });

    it("org B cannot READ org A's lines or declarations — raw scp_app connection, no app code", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      const lines = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const deps = await raw.query(
        "SELECT * FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      expect(lines.rows).toHaveLength(0);
      expect(deps.rows).toHaveLength(0);

      // NEGATIVE CONTROL, in the same test so the zeroes above cannot be explained by "the rows were
      // never written". Under org A's context the SAME queries on the SAME connection return them.
      await raw.setOrgContext(orgA.orgId);
      const linesA = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const depsA = await raw.query(
        "SELECT * FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      await raw.close();
      expect(linesA.rows).toHaveLength(1);
      expect(depsA.rows).toHaveLength(1);
    });

    it("fails closed when app.current_org_id is never set", async () => {
      const raw = await RawScpAppClient.connect();
      const lines = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const deps = await raw.query("SELECT * FROM component_dependencies");
      await raw.close();
      expect(lines.rows).toHaveLength(0);
      expect(deps.rows).toHaveLength(0);
    });

    it("org B cannot UPDATE or DELETE org A's rows", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      const updated = await raw.query(
        "UPDATE dependency_lines SET coordinate = 'pwned' WHERE id = $1",
        [lineAId]
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await raw.query(
        "DELETE FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      expect(deleted.rowCount).toBe(0);
      await raw.close();

      // NEGATIVE CONTROL: the row is untouched and still readable by its owner.
      const stillThere = await inA((tx) => listDependencyLinesByIds(tx, orgA.orgId, [lineAId]));
      expect(stillThere[0]?.coordinate).toBe("github.com/acme/org-a-only");
    });

    it("org B cannot INSERT a row claiming org A's org_id (WITH CHECK)", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      await expect(
        raw.query(
          `INSERT INTO dependency_lines (id, org_id, ecosystem, coordinate, major)
           VALUES ($1, $2, 'npm', 'cross-org', '1')`,
          [uuidv7(), orgA.orgId]
        )
      ).rejects.toThrow(/row-level security/i);
      await raw.close();
    });

    it("a declaration cannot reference ANOTHER org's line even under its own org's context", async () => {
      // Barrier 2 (0060 header): the composite `(org_id, line_id)` foreign key. RLS's WITH CHECK
      // only pins the row's OWN org_id, so without this key org B could stamp a row with its own
      // org_id pointing at org A's line — a dangling cross-tenant reference that no read would
      // reveal. The failure here is an FK violation, NOT an RLS one, which is what proves the second
      // barrier is the thing doing the work.
      const componentB = await componentIn(clientB, "rls-b");
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      await expect(
        raw.query(
          `INSERT INTO component_dependencies
             (org_id, component_object_id, line_id, manifest_path, declared_version)
           VALUES ($1, $2, $3, 'go.mod', 'v1.0.0')`,
          [orgB.orgId, componentB, lineAId]
        )
      ).rejects.toThrow(/component_dependencies_line_fk|foreign key/i);
      await raw.close();

      // NEGATIVE CONTROL: the identical insert against org B's OWN line succeeds, so the rejection
      // above is the cross-org reference and not a broken statement.
      const ownLine = await inB((tx) =>
        upsertDependencyLine(tx, orgB.orgId, {
          ecosystem: "go",
          coordinate: "github.com/acme/org-b-only",
          major: "v1"
        })
      );
      const ok = await inB((tx) =>
        upsertComponentDependency(tx, orgB.orgId, {
          componentObjectId: componentB,
          lineId: ownLine.id,
          manifestPath: "go.mod",
          declaredVersion: "v1.0.0"
        })
      );
      expect(ok.lineId).toBe(ownLine.id);
    });

    it("the repo layer scoped to org B returns nothing of org A's, by either hot query", async () => {
      expect(await inB((tx) => listDependencyLinesByIds(tx, orgB.orgId, [lineAId]))).toEqual([]);
      expect(await inB((tx) => listComponentsDeclaringLine(tx, orgB.orgId, lineAId))).toEqual([]);
      expect(await inB((tx) => listComponentDependencies(tx, orgB.orgId, componentAId))).toEqual(
        []
      );
      expect(
        await inB((tx) =>
          getDependencyLineByKey(tx, orgB.orgId, {
            ecosystem: "go",
            coordinate: "github.com/acme/org-a-only",
            major: "v1"
          })
        )
      ).toBeNull();
    });

    it("scp_app holds no DELETE grant on dependency_lines, and does hold one on the projection", async () => {
      // Lines are the identity a dependency subscription is written against; deleting one would
      // orphan the subscription. The projection must be prunable — a manifest can drop a dependency.
      const rows = await server.deps.db.execute<{ table_name: string; privilege_type: string }>(
        sql`SELECT table_name, privilege_type
            FROM information_schema.role_table_grants
            WHERE grantee = 'scp_app'
              AND privilege_type = 'DELETE'
              AND table_name IN ('dependency_lines', 'component_dependencies')`
      );
      const tables = rows.rows.map((r) => r.table_name);
      expect(tables).toContain("component_dependencies");
      expect(tables).not.toContain("dependency_lines");
    });
  });

  // -----------------------------------------------------------------------------------------
  // ADR-0032 §5 and §3 — the two boundaries that are not visible in any single query
  // -----------------------------------------------------------------------------------------

  it("mints NO relationship — package dependencies never become a depends_on edge", async () => {
    const componentId = await componentIn(clientA, "no-edge");
    const before = await inA(
      async (tx) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(relationships)
            .where(eq(relationships.orgId, orgA.orgId))
        )[0]?.count ?? 0
    );

    // The counting query must be able to SEE edges, or "after === before" would hold for a broken
    // query too. `createTestComponent` mints real `contains`/`part_of` edges, so this is > 0.
    expect(before).toBeGreaterThan(0);

    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/no-edge",
        major: "v1"
      })
    );
    const declaration = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: line.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.0.0"
      })
    );

    const after = await inA(
      async (tx) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(relationships)
            .where(eq(relationships.orgId, orgA.orgId))
        )[0]?.count ?? 0
    );

    // The absence: not one edge of ANY type, `depends_on` included. That type is the wave-plan
    // toposort input and a cycle among co-placed targets is a hard plan-compile error, while package
    // graphs routinely contain cycles (ADR-0032 §5).
    expect(after).toBe(before);
    const dependsOn = await inA((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(relationships)
        .where(eq(relationships.typeId, "depends_on"))
    );
    expect(dependsOn[0]?.count).toBe(0);

    // NEGATIVE CONTROL: the ingestion genuinely happened, so "zero edges" is not "zero work".
    expect(declaration.lineId).toBe(line.id);
    expect(await inA((tx) => listComponentsDeclaringLine(tx, orgA.orgId, line.id))).toHaveLength(1);
  });

  it("the inventory path contains no recursive traversal (ADR-0032 §3's load-bearing boundary)", () => {
    // The boundary that justifies the whole tabular representation is a DISCIPLINE, and ADR-0032
    // says in as many words that it "must be enforced by test, not by intention". A source census is
    // the only thing that can catch a future recursive CTE added to this directory, because such a
    // query would pass every behavioural test in this file.
    const repoSource = readFileSync(
      fileURLToPath(new URL("./dependency-inventory-repo.ts", import.meta.url)),
      "utf8"
    );
    expect(/\bwith\s+recursive\b/i.test(repoSource)).toBe(false);

    // NEGATIVE CONTROL for the matcher itself — the single most common way an absence assertion goes
    // vacuous is a pattern that never matches anything. `graph/named-queries.ts` is where this
    // codebase's recursive CTE actually lives (the one measured at 7+ minutes then disk exhaustion),
    // so the same regex MUST fire there.
    const namedQueries = readFileSync(
      fileURLToPath(new URL("../graph/named-queries.ts", import.meta.url)),
      "utf8"
    );
    expect(/\bwith\s+recursive\b/i.test(namedQueries)).toBe(true);
  });
});

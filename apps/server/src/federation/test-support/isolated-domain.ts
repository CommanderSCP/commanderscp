import path from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, createPool, type Db } from "../../db/client.js";
import {
  deriveRuntimeDatabaseUrl,
  provisionRuntimeRole,
  runtimeCredentials
} from "../../db/provision.js";
import { testDatabaseUrl } from "../../test-support/harness.js";
import { withTenantTx } from "../../db/tenant-tx.js";
import { createObject } from "../../graph/objects-repo.js";

/**
 * A genuinely SEPARATE Postgres DATABASE (not merely a separate org row in the shared test
 * database) within the SAME Testcontainers Postgres container — used ONLY by
 * `federation.integration.test.ts` to model two federation "domains" faithfully.
 *
 * WHY THIS EXISTS (found the hard way, via this milestone's own integration tests): every other
 * `*.integration.test.ts` file in this codebase models multi-tenancy as multiple ORGS inside the
 * one shared test database — correct for RLS/authz tests, since real multi-tenancy in this
 * product IS "one database, many orgs, RLS-isolated." Federation is different: DESIGN.md §13's
 * whole premise is that two federation domains are two SEPARATE SCP INSTANCES, each with its OWN
 * Postgres database — there is no shared `objects` table between them in production. That matters
 * concretely because `objects.id` is a single GLOBAL primary key (not composite with `org_id`) —
 * completely safe within one instance's one database (a real deployment never needs two ROWS with
 * the same id), but federation import is SPECIFICALLY DESIGNED to preserve an object's id verbatim
 * across domains (single-writer authority: the replica in the importing domain has the SAME id as
 * the authoritative original, just non-authoritative). Modeling "two domains" as two ORGS sharing
 * ONE physical `objects` table therefore hits a collision no production deployment ever can: the
 * origin domain's own row (id=X, org=A) already occupies id=X globally, so ANY attempt to
 * replicate that same id into another org's rows in the SAME table always violates the PK —
 * regardless of which object, not just an edge case. Two real, separate databases (this helper)
 * eliminates the false collision entirely and is also the MORE faithful test of the real topology.
 *
 * Cheap relative to a second Testcontainers container: `CREATE DATABASE` + migrate, all against
 * the one already-running container (a few hundred ms), not a new container spin-up.
 */
export interface IsolatedDomain {
  db: Db;
  orgId: string;
  orgName: string;
  /** The SUPERUSER connection URL for this domain's OWN database (not the RLS-scoped runtime role).
   *  Exposed so a test can write INSTANCE-SCOPED operator config that the tenant pool cannot (e.g.
   *  `scanner_assignments`, whose RLS/grants make it SELECT-only for the runtime role — the
   *  operator-write path in production runs over the admin connection, routes/scanner-assignments.ts). */
  adminUrl: string;
  close(): Promise<void>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/server/src/federation/test-support/isolated-domain.ts -> apps/server/drizzle (3 levels up)
const migrationsFolder = path.resolve(__dirname, "../../../drizzle");

let counter = 0;

export async function createIsolatedDomain(label: string): Promise<IsolatedDomain> {
  counter += 1;
  const dbName = `fed_${label}_${Date.now()}_${counter}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  const adminUrl = new URL(testDatabaseUrl());
  const bootstrapPool = new pg.Pool({ connectionString: adminUrl.toString() });
  try {
    const client = await bootstrapPool.connect();
    try {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`);
    } finally {
      client.release();
    }
  } finally {
    await bootstrapPool.end();
  }

  const newAdminUrl = new URL(adminUrl.toString());
  newAdminUrl.pathname = `/${dbName}`;

  const migratePool = new pg.Pool({ connectionString: newAdminUrl.toString() });
  const migrateDb = drizzle(migratePool);
  await migrate(migrateDb, { migrationsFolder });

  const runtimeUrl = deriveRuntimeDatabaseUrl(newAdminUrl.toString());
  const creds = runtimeCredentials(runtimeUrl);
  await provisionRuntimeRole(migratePool, creds.user, creds.password);
  await migratePool.end();

  const pool = createPool(runtimeUrl);
  const db = createDb(pool);

  const orgId = uuidv7();
  const orgName = `${label}-${orgId}`;
  await pool.query(`INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, now())`, [
    orgId,
    orgName
  ]);

  // Every org gets exactly one root `organization` graph object (auth/local-auth.ts
  // `ensureOrgRootObject`'s exact convention: "stable, predictable id for the org root object" —
  // `id = orgId`). Safe here (unlike the shared-Postgres org-as-domain approach this helper
  // replaces) because every isolated domain has its OWN physical `objects` table — no cross-
  // domain id collision is possible. Needed so ordinary `createObject` calls that don't pass an
  // explicit `domainId` (handFillObject, createOverlay, ...) have a root to default to.
  await withTenantTx(db, orgId, (tx) =>
    createObject(tx, {
      orgId,
      typeId: "organization",
      actorObjectId: orgId,
      requestId: "test-bootstrap",
      id: orgId,
      name: orgId,
      domainId: null
    })
  );

  return {
    db,
    orgId,
    orgName,
    adminUrl: newAdminUrl.toString(),
    close: async () => {
      await pool.end();
    }
  };
}

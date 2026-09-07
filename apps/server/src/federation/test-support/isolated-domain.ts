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

/** A genuinely SEPARATE Postgres DATABASE. See docs/federation.md §554. */
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

  // Every org gets exactly one root `organization` graph object. See docs/federation.md §555.
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

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { buildApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin, type BootstrapResult } from "./auth/local-auth.js";

/** M2 demo seed. See docs/server.md §88. */

export interface SeedLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "org";
}

/** Matches the `urn:scp:{org}:{type}:{slug-path}` scheme (graph/urn.ts) for our fixed demo URNs. */
function demoUrn(orgSlug: string, typeId: string, slug: string): string {
  return `urn:scp:${orgSlug}:${typeId}:${slug}`;
}

/** Those edges have no upsert-by-urn equivalent. See docs/server.md §89. */
async function addEdgeIdempotently(add: () => Promise<unknown>): Promise<void> {
  try {
    await add();
  } catch (err) {
    if (err instanceof ScpApiError && err.status === 409) return;
    throw err;
  }
}

/** Creates the M2 demo graph. See docs/server.md §90. */
export async function seedDemoData(
  client: ScpClient,
  orgName: string,
  log: SeedLogger
): Promise<void> {
  const org = slugify(orgName);

  log.info("seed: upserting demo domain 'platform'");
  const domain = await client.domains.upsertByUrn(demoUrn(org, "domain", "platform"), {
    name: "Platform"
  });

  log.info("seed: upserting demo services 'checkout' and 'payments-gateway'");
  const checkout = await client.services.upsertByUrn(demoUrn(org, "service", "checkout"), {
    name: "checkout",
    domainId: domain.id
  });
  const paymentsGateway = await client.services.upsertByUrn(
    demoUrn(org, "service", "payments-gateway"),
    { name: "payments-gateway", domainId: domain.id }
  );

  // M12 P5a: a directly-created component belongs to a service (each carries the `contains` parent).
  log.info("seed: upserting demo components in their services");
  const checkoutApi = await client.components.upsertByUrn(
    demoUrn(org, "component", "checkout-api"),
    {
      name: "checkout-api",
      domainId: domain.id,
      service: checkout.id
    }
  );
  await client.components.upsertByUrn(demoUrn(org, "component", "checkout-worker"), {
    name: "checkout-worker",
    domainId: domain.id,
    service: checkout.id
  });
  const paymentsGatewayApi = await client.components.upsertByUrn(
    demoUrn(org, "component", "payments-gateway-api"),
    { name: "payments-gateway-api", domainId: domain.id, service: paymentsGateway.id }
  );

  log.info("seed: upserting demo team 'platform-team' and its ownership of 'checkout'");
  const team = await client.teams.upsertByUrn(demoUrn(org, "team", "platform-team"), {
    name: "platform-team"
  });
  await addEdgeIdempotently(() =>
    client.services.addOwner(checkout.id, team.id, { idempotencyKey: randomUUID() })
  );

  log.info("seed: adding depends_on/consumes edges");
  await addEdgeIdempotently(() =>
    client.services.addDependsOn(checkout.id, paymentsGateway.id, {
      idempotencyKey: randomUUID()
    })
  );
  await addEdgeIdempotently(() =>
    client.components.addConsumes(checkoutApi.id, paymentsGatewayApi.id, {
      idempotencyKey: randomUUID()
    })
  );

  log.info(
    "seed: demo data ready (1 domain, 2 services, 3 components, 1 team, 1 owns + 1 depends_on + 1 consumes edge)."
  );
}

/** Logs in as the bootstrap admin and seeds demo data. See docs/server.md §91. */
export async function loginAndSeedDemoData(
  config: ServerConfig,
  bootstrap: BootstrapResult,
  log: SeedLogger
): Promise<void> {
  if (!bootstrap.oneTimePassword) {
    log.info(
      "seed: bootstrap admin already existed — skipping demo-data login step (no fresh one-time " +
        "password to authenticate with; demo data from a prior fresh boot, if any, is unaffected)."
    );
    return;
  }
  const client = new ScpClient({ baseUrl: config.internalBaseUrl });
  await client.login(config.bootstrapAdminUsername, bootstrap.oneTimePassword);
  await seedDemoData(client, config.bootstrapOrgName, log);
}

/** `pnpm seed` standalone entrypoint. See docs/server.md §92. */
async function main(): Promise<void> {
  const config = loadConfig();

  const adminPool = createPool(config.databaseUrl);
  const adminDb = createDb(adminPool);
  await runMigrations(adminDb);
  const creds = runtimeCredentials(config.runtimeDatabaseUrl);
  await provisionRuntimeRole(adminPool, creds.user, creds.password);
  await adminPool.end();

  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
  const bootstrap = await ensureBootstrapAdmin(
    db,
    { orgName: config.bootstrapOrgName, adminUsername: config.bootstrapAdminUsername },
    { info: (msg) => console.log(msg), warn: (msg) => console.warn(msg) }
  );

  const app = await buildApp({ db, config }, { logger: false });
  await app.listen({ port: config.port, host: config.host });
  try {
    await loginAndSeedDemoData(config, bootstrap, { info: console.log, warn: console.warn });
  } finally {
    await app.close();
  }

  await pool.end();
  console.log("seed: complete.");
}

// Guard `main()` to only run when this module is executed directly. See docs/server.md §93.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  });
}

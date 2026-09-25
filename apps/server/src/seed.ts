import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import * as argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { buildApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { sessions, users } from "./db/schema.js";
import { ensureBootstrapAdmin, randomPassword, type BootstrapResult } from "./auth/local-auth.js";

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
  db: Db,
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
  // #422 re-verify, BLOCKING 0 — measured live: a same-password "change" (current === new) returned
  // 204 and cleared mustChangePassword WITHOUT changing the stored hash, so it never actually
  // retired anything; changeLocalPassword now REFUSES that. The demo-seed path still needs past
  // require-auth.ts's gate to do its own work (services.create, components.create, …), so it mints
  // a genuinely fresh, THROWAWAY password, changes to it (a real change, own session preserved —
  // changeLocalPassword's currentSessionToken param), seeds, and then — because this path's whole
  // point is that the OPERATOR's ALREADY-PRINTED password (main.ts's own log line, this same
  // `bootstrap.oneTimePassword` value) must still be what they log in with — resets the account
  // directly back to that printed password AND re-arms mustChangePassword, so the operator's real
  // first login goes through the SAME forced-change door a non-demo install would. This is a direct
  // DB write (never a second `changeLocalPassword` call, which would refuse restoring the same
  // value it started from) — legitimate here because this whole flow is server-internal bootstrap
  // automation, not a request a human sent. (SCP_SEED_DEMO is eval/demo-stack-only —
  // docker-compose.yml — never set on a `scp install --mode kube` deployment.)
  const scratchPassword = randomPassword();
  await client.auth.changePassword(bootstrap.oneTimePassword, scratchPassword);
  await seedDemoData(client, config.bootstrapOrgName, log);
  const admin = await db.query.users.findFirst({
    where: and(eq(users.orgId, bootstrap.orgId), eq(users.username, config.bootstrapAdminUsername))
  });
  if (!admin) throw new Error("seed: bootstrap admin row vanished mid-seed — cannot reset it");
  const passwordHash = await argon2.hash(bootstrap.oneTimePassword);
  await db.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, admin.id));
  // Every session this seed run minted (the login above, and whatever the rest of seedDemoData's
  // client reused) is spent the moment the account resets to its pre-seed state — the operator's
  // real session starts fresh at their own real login, not by inheriting seed.ts's.
  await db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.userId, admin.id));
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
    await loginAndSeedDemoData(db, config, bootstrap, { info: console.log, warn: console.warn });
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

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { buildApp } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { provisionRuntimeRole, runtimeCredentials } from "./db/provision.js";
import { ensureBootstrapAdmin, type BootstrapResult } from "./auth/local-auth.js";

/**
 * M2 demo seed (BUILD_AND_TEST.md §5.3). This implements the M2-AVAILABLE SUBSET of §5.3's full
 * aspirational "five-minute value" description: a domain, services + components, and
 * ownership/depends_on/consumes edges — all created through the PUBLIC API (never
 * graph/objects-repo.ts or any other repo-layer function directly), using upsert-by-URN
 * (objects) and 409-as-no-op (relationship edges, which have no upsert endpoint) so re-running
 * this function is always a true no-op.
 *
 * Deliberately DOES NOT seed: an executor connection (ExecutorPlugin/fake-executor land in M3),
 * a policy (M4), or an in-flight change (M3). Those milestones should EXTEND `seedDemoData`
 * below with their own idempotent steps, not replace it.
 */

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

/**
 * `owns`/`consumes`/`depends_on` edges have no upsert-by-URN equivalent (they're plain creates
 * guarded by a uniqueness constraint) — a second seed run hits 409 Conflict, which is success
 * here, not an error (routes/ownership.ts module doc).
 */
async function addEdgeIdempotently(add: () => Promise<unknown>): Promise<void> {
  try {
    await add();
  } catch (err) {
    if (err instanceof ScpApiError && err.status === 409) return;
    throw err;
  }
}

/**
 * Creates the M2 demo graph (idempotent — safe to call any number of times against the same
 * org): one domain ("platform"), two services ("checkout", "payments-gateway") and three
 * components under them, one team ("platform-team") owning "checkout", one `depends_on` edge
 * (checkout -> payments-gateway) and one `consumes` edge (checkout-api -> payments-gateway-api).
 * `client` must already be authenticated as a subject with `object:write`/`relationship:write`
 * at the org root (the bootstrap admin, in practice).
 */
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
  const checkoutApi = await client.components.upsertByUrn(demoUrn(org, "component", "checkout-api"), {
    name: "checkout-api",
    domainId: domain.id,
    service: checkout.id
  });
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

/**
 * Logs in as the bootstrap admin and runs `seedDemoData` against the server's own public API
 * (`config.internalBaseUrl` — the same "server calls its own API" pattern historically used by
 * the retired `/ui` stub, apps/server/src/routes/ui.ts). Local-auth's one-time bootstrap
 * password is shown exactly once and never stored (auth/local-auth.ts) — so this can only log in
 * when `bootstrap.oneTimePassword` is set, i.e. the admin was freshly created THIS run. If the
 * admin already existed (a prior boot/seed already ran), there's no credential to log in with;
 * that's fine — either the demo data is already there from that prior run, or it never was and
 * this is a known, documented limitation of not persisting the OTP (a deliberate security
 * tradeoff, not a bug).
 */
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

/**
 * `pnpm seed` standalone entrypoint (`tsx src/seed.ts`, BUILD_AND_TEST.md §5.4 command table) —
 * a one-command "seed my dev database" tool. Same two-phase admin/runtime connection split as
 * main.ts (PR #4 security review, CRITICAL 3): admin connection for migrations + role
 * provisioning, then the seed writes run as the least-privileged `scp_app` runtime role.
 *
 * The demo-data step needs a real listening server to call itself over HTTP (PUBLIC API ONLY —
 * module doc above), so this spins one up just for the duration of seeding, then closes it —
 * this script's whole job is to seed and exit, not to serve traffic. Unlike main.ts's
 * `SCP_SEED_DEMO`-gated boot-time step, this runs unconditionally (not gated on that env var) —
 * deliberate seeding is this script's entire purpose.
 */
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

// Guard `main()` to only run when this module is executed directly (`tsx src/seed.ts` /
// `node dist/seed.js`) — NOT when `loginAndSeedDemoData`/`seedDemoData` are imported as a
// library (main.ts's boot-time `SCP_SEED_DEMO` path, seed.integration.test.ts). ESM has no
// `require.main === module`; comparing `import.meta.url` to the invoked script path is the
// standard equivalent.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  });
}

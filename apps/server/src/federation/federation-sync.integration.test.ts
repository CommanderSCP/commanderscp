import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool, type Db } from "../db/client.js";
import {
  deriveRuntimeDatabaseUrl,
  provisionRuntimeRole,
  runtimeCredentials
} from "../db/provision.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
import type { AppDeps } from "../types.js";
import { testDatabaseUrl, createTestOrg, type TestServer } from "../test-support/harness.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import {
  federationSyncOrgTick,
  pullFromCommanderPeer,
  FEDERATION_SYNC_DECISION_KIND
} from "./federation-sync.js";
import type { FederationClientMtls } from "./federation-outbound.js";
import { listPeers } from "./peers-repo.js";
import { createTestCa, issueLeafCert, opensslAvailable, type TestCa } from "./test-support/mtls-pki.js";

/**
 * M14.0 — the OUTPOST LIVE-PULL SCHEDULER over mTLS, end-to-end against real Postgres + a real
 * HTTPS listener (docs/proposals/outpost-poke.md, ADR-0009; owner full-scope decision 2026-07-24).
 *
 * A commander+outpost TWO-DOMAIN round trip: the OUTPOST's `federationSyncOrgTick` dials the
 * COMMANDER's real `POST /federation/exports` over mTLS (this instance presenting its enrolled
 * per-domain client cert — `urn:scp:domain:<outpostDomainId>` SAN URI — which the commander's
 * `enforceFederationMtls` accepts), pulls the signed `.scpbundle`, and imports it through the
 * UNCHANGED verify path (Ed25519 at the sequence-anchored key window + hash chain). Then the
 * FAIL-CLOSED proof: an mTLS-required peer with NO client cert → the dial is REFUSED with a block
 * Decision, never a plain-HTTP fallback.
 *
 * Each "domain" is a GENUINELY SEPARATE Postgres database booted as a REAL Fastify instance (the
 * commander with a real HTTPS mTLS listener) — the two-domain topology from
 * `federation.integration.test.ts` + the real-listener technique from `mtls.integration.test.ts`.
 * Skipped wholesale when `openssl` is unavailable (mirrors `mtls.integration.test.ts`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/server/src/federation/*.test.ts -> apps/server/drizzle
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

let dbCounter = 0;

interface Domain {
  app: FastifyInstance;
  deps: AppDeps;
  db: Db;
  port: number;
  orgId: string;
  adminToken: string;
  self: FederationSelf;
  close(): Promise<void>;
}

/** Creates a fresh Postgres database in the shared Testcontainers container, migrates + provisions
 *  it, boots a REAL Fastify app on it (with optional federation-server-mTLS env), and mints an org +
 *  admin token + federation self. The commander passes `mtlsEnv`; the outpost passes `{}`. */
async function bootDomain(
  label: string,
  mtlsEnv: Record<string, string> = {}
): Promise<Domain> {
  dbCounter += 1;
  const dbName = `fedsync_${label}_${Date.now()}_${dbCounter}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");

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

  const config = loadConfig({
    DATABASE_URL: newAdminUrl.toString(),
    SCP_RUNTIME_DATABASE_URL: runtimeUrl,
    SCP_COOKIE_SECRET: "test-cookie-secret-value",
    ...mtlsEnv
  });
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
  const deps: AppDeps = { db, config };
  const app = await buildApp(deps, { logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  const server: TestServer = { app, deps, close: async () => undefined };
  const org = await createTestOrg(server, label);
  const self = await withTenantTx(db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId));

  return {
    app,
    deps,
    db,
    port,
    orgId: org.orgId,
    adminToken: org.adminToken,
    self,
    async close() {
      await app.close();
      await pool.end();
    }
  };
}

describe.skipIf(!opensslAvailable())("M14.0 outpost live-pull over mTLS (two-domain)", () => {
  let ca: TestCa;
  let commander: Domain;
  let outpost: Domain;
  let outpostClientMtls: FederationClientMtls;
  let commanderUrl: string;
  let createdObjectId: string;

  beforeAll(async () => {
    ca = createTestCa();

    // The commander runs a REAL mTLS listener: a server leaf (its own TLS identity, SAN DNS:localhost)
    // + the CA as the trust root for verifying inbound peer client certs.
    const serverLeaf = issueLeafCert(ca, { name: `commander-server-${randomUUID()}` });
    commander = await bootDomain("cmd", {
      SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
      SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
      SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
    });
    outpost = await bootDomain("out");
    // Dial the server leaf's SAN (DNS:localhost), not the raw 127.0.0.1 the listener bound to, so the
    // dialer's OWN server-cert hostname validation (undici secure default) passes.
    commanderUrl = `https://localhost:${commander.port}`;

    // The outpost's enrolled CLIENT cert: SAN URI = urn:scp:domain:<outpost domain id>, signed by the
    // shared federation CA. This is what PIECE 1 presents on the outbound dial.
    const outpostLeaf = issueLeafCert(ca, {
      name: `outpost-client-${randomUUID()}`,
      sanUri: federationPeerSanUri(outpost.self.domainId)
    });
    outpostClientMtls = {
      cert: outpostLeaf.certPem.toString("utf8"),
      key: outpostLeaf.keyPem.toString("utf8"),
      ca: ca.caCrtPem.toString("utf8")
    };

    // Pairing (out-of-band, both sides) — the commander knows the outpost by its domain id; the
    // outpost knows the commander by its domain id + Ed25519 signing key + dial URL.
    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: outpost.self.domainId,
        name: "the-outpost",
        role: "outpost",
        publicKey: outpostKey.publicKey
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: commander.self.domainId,
        name: "the-commander",
        role: "commander",
        publicKey: commanderKey.publicKey,
        baseUrl: commanderUrl
      })
    );

    // Something for the commander to export.
    const created = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "m14-seed",
        name: "commander-origin-service",
        properties: { tier: "critical" }
      })
    );
    createdObjectId = created.id;
  }, 120_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  it("round trip: the outpost's sync tick pulls+imports the commander's bundle OVER mTLS", async () => {
    const outcomes = await federationSyncOrgTick(outpost.db, outpost.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: outpostClientMtls
    });

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.outcome).toBe("imported");
    expect(outcome.peerDomainId).toBe(commander.self.domainId);
    expect(outcome.appliedEntries ?? 0).toBeGreaterThan(0);

    // The commander-origin object is now a read-only replica on the outpost, carrying the commander's
    // domain id as its authoritative origin (the import verification ran UNCHANGED).
    const replica = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getObjectByIdOrUrnAnyType(tx, outpost.orgId, createdObjectId)
    );
    expect(replica.name).toBe("commander-origin-service");
    expect(replica.properties.tier).toBe("critical");
    expect(replica.originDomainId).toBe(commander.self.domainId);
  });

  it("idempotent: a second tick applies nothing new (cursor already advanced)", async () => {
    const outcomes = await federationSyncOrgTick(outpost.db, outpost.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: outpostClientMtls
    });
    expect(outcomes[0]!.outcome).toBe("imported");
    expect(outcomes[0]!.appliedEntries ?? 0).toBe(0);
  });

  it("FAIL-CLOSED: an mTLS-required peer with NO client cert -> dial REFUSED + block Decision, no plain-HTTP fallback", async () => {
    const [commanderPeer] = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      listPeers(tx, outpost.orgId)
    ).then((peers) => peers.filter((p) => p.role === "commander"));
    expect(commanderPeer).toBeDefined();

    const outcome = await pullFromCommanderPeer(
      outpost.db,
      outpost.orgId,
      outpost.self.domainId,
      commanderPeer!,
      { bearer: commander.adminToken, mtls: undefined } // NO client cert
    );

    expect(outcome.outcome).toBe("refused");
    expect(outcome.decisionId).toBeTruthy();

    // The refusal is explainable: a block Decision of the loop's own kind, subject = the commander.
    const decision = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, outpost.orgId),
            eq(decisions.id, outcome.decisionId!)
          )
        )
        .limit(1)
    );
    expect(decision[0]?.kind).toBe(FEDERATION_SYNC_DECISION_KIND);
    expect(decision[0]?.verdict).toBe("block");
  });

  it("FAIL-CLOSED via the whole tick: mtls:null yields a refused outcome (never dials plain)", async () => {
    const outcomes = await federationSyncOrgTick(outpost.db, outpost.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: null
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe("refused");
    expect(outcomes[0]!.decisionId).toBeTruthy();
  });
});

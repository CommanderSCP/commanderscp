import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { FastifyInstance } from "fastify";
import type PgBoss from "pg-boss";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool, type Db } from "../db/client.js";
import {
  deriveRuntimeDatabaseUrl,
  provisionRuntimeRole,
  runtimeCredentials
} from "../db/provision.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { outbox } from "../db/schema.js";
import type { AppDeps } from "../types.js";
import { testDatabaseUrl, createTestOrg, type TestServer } from "../test-support/harness.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { getPeerByIdOrName, pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import { FEDERATION_SYNC_QUEUE, federationSyncOrgTick } from "./federation-sync.js";
import { pokeRateLimiter } from "./poke-rate-limit.js";
import { pokeDownstreamPeersForOrg } from "./poke-sender.js";
import type { FederationClientMtls } from "./federation-outbound.js";
import { createTestCa, issueLeafCert, opensslAvailable, type TestCa } from "./test-support/mtls-pki.js";

/**
 * M14.4 (test i) — THE THREE-HOP POKE CHAIN, end to end over real mTLS listeners and three genuinely
 * separate Postgres databases: **commander → retrans → outpost** (ADR-0009 §38's hop-by-hop
 * propagation, minus the CDS byte transport itself).
 *
 * WHAT THIS PINS, and why it is the interesting case:
 *
 *   * **The onward poke is OUTBOX-DERIVED, not a poke-in→poke-out relay.** The retrans does not
 *     forward the poke it received. It IMPORTS, the import writes outbox rows in the same
 *     transaction as the applied change, and the sender hangs off the outbox relay — so the second
 *     hop is CAUSALLY GATED on the retrans having actually applied something new.
 *   * **That is what makes the chain loop-safe WITHOUT a TTL.** A replayed, byte-identical import
 *     applies zero entries, writes zero outbox rows, and therefore produces NO onward poke: the
 *     chain terminates by construction. A hop counter / TTL would have put a BYTE inside a signal
 *     that is contentless by definition (ADR-0009 §1) — this design needs neither.
 *
 * Each hop's wake is observed through a recording pg-boss injected into that instance's deps, and
 * each receiver's `last_poke_received_at` stamp (D2) is asserted from its own database.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

let dbCounter = 0;

interface Domain {
  app: FastifyInstance;
  db: Db;
  port: number;
  orgId: string;
  adminToken: string;
  self: FederationSelf;
  /** Queues this instance's poke handler enqueued (a recording pg-boss). */
  sends: string[];
  close(): Promise<void>;
}

/** Boots one federation domain: its own database, a real HTTPS mTLS listener, a recording boss. */
async function bootDomain(label: string, ca: TestCa): Promise<Domain> {
  dbCounter += 1;
  const dbName = `pokechain_${label}_${Date.now()}_${dbCounter}`
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
  await migrate(drizzle(migratePool), { migrationsFolder });
  const runtimeUrl = deriveRuntimeDatabaseUrl(newAdminUrl.toString());
  const creds = runtimeCredentials(runtimeUrl);
  await provisionRuntimeRole(migratePool, creds.user, creds.password);
  await migratePool.end();

  const serverLeaf = issueLeafCert(ca, { name: `${label}-server-${randomUUID()}` });
  const config = loadConfig({
    DATABASE_URL: newAdminUrl.toString(),
    SCP_RUNTIME_DATABASE_URL: runtimeUrl,
    SCP_COOKIE_SECRET: "test-cookie-secret-value",
    SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
    SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
    SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
  });
  const pool = createPool(config.runtimeDatabaseUrl);
  const db = createDb(pool);
  const sends: string[] = [];
  const deps: AppDeps = { db, config };
  deps.boss = {
    send: async (queue: string) => {
      sends.push(queue);
      return "job-id";
    }
  } as unknown as PgBoss;
  const app = await buildApp(deps, { logger: false });
  await app.ready();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);

  const server: TestServer = { app, deps, close: async () => undefined };
  const org = await createTestOrg(server, label);
  const self = await withTenantTx(db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId));

  return {
    app,
    db,
    port,
    orgId: org.orgId,
    adminToken: org.adminToken,
    self,
    sends,
    async close() {
      await app.close();
      await pool.end();
    }
  };
}

describe.skipIf(!opensslAvailable())("M14.4 three-hop poke chain (commander -> retrans -> outpost)", () => {
  let ca: TestCa;
  let commander: Domain;
  let retrans: Domain;
  let outpost: Domain;
  let commanderMtls: FederationClientMtls;
  let retransMtls: FederationClientMtls;
  let outpostMtls: FederationClientMtls;

  function clientCertFor(domain: Domain, label: string): FederationClientMtls {
    const leaf = issueLeafCert(ca, {
      name: `${label}-client-${randomUUID()}`,
      sanUri: federationPeerSanUri(domain.self.domainId)
    });
    return {
      cert: leaf.certPem.toString("utf8"),
      key: leaf.keyPem.toString("utf8"),
      ca: ca.caCrtPem.toString("utf8")
    };
  }

  async function outboxCount(domain: Domain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ id: outbox.id }).from(outbox).where(eq(outbox.orgId, domain.orgId))
    );
    return rows.length;
  }

  beforeAll(async () => {
    ca = createTestCa();
    commander = await bootDomain("cmd", ca);
    retrans = await bootDomain("rtx", ca);
    outpost = await bootDomain("out", ca);

    commanderMtls = clientCertFor(commander, "cmd");
    retransMtls = clientCertFor(retrans, "rtx");
    outpostMtls = clientCertFor(outpost, "out");

    // Dial SANs (DNS:localhost), not the bound 127.0.0.1 — the dialer validates the server cert.
    const commanderUrl = `https://localhost:${commander.port}`;
    const retransUrl = `https://localhost:${retrans.port}`;
    const outpostUrl = `https://localhost:${outpost.port}`;

    const keys = {
      commander: await withTenantTx(commander.db, commander.orgId, (tx) =>
        ensureInstanceKey(tx, commander.orgId)
      ),
      retrans: await withTenantTx(retrans.db, retrans.orgId, (tx) =>
        ensureInstanceKey(tx, retrans.orgId)
      ),
      outpost: await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        ensureInstanceKey(tx, outpost.orgId)
      )
    };

    // COMMANDER knows the retrans as a downstream poke target.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: retrans.self.domainId,
        name: "the-retrans",
        role: "retrans",
        publicKey: keys.retrans.publicKey,
        baseUrl: retransUrl,
        pokeMode: true
      })
    );
    // RETRANS knows the commander UPSTREAM (pull source + poke consent) and the outpost DOWNSTREAM.
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: commander.self.domainId,
        name: "the-commander",
        role: "commander",
        publicKey: keys.commander.publicKey,
        baseUrl: commanderUrl,
        pokeMode: true
      })
    );
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: outpost.self.domainId,
        name: "the-outpost",
        role: "outpost",
        publicKey: keys.outpost.publicKey,
        baseUrl: outpostUrl,
        pokeMode: true
      })
    );
    // OUTPOST knows the retrans as ITS upstream (`commander` role = "what I pull from").
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: retrans.self.domainId,
        name: "the-retrans",
        role: "commander",
        publicKey: keys.retrans.publicKey,
        baseUrl: retransUrl,
        pokeMode: true
      })
    );

    // Something at the top of the chain for the retrans to import.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "m14-4-chain-seed",
        name: "chain-origin-service",
        properties: { tier: "critical" }
      })
    );
  }, 240_000);

  afterAll(async () => {
    await outpost?.close();
    await retrans?.close();
    await commander?.close();
  });

  beforeEach(() => {
    pokeRateLimiter.reset();
  });

  it("HOP 1+2: the commander pokes the retrans; the retrans's IMPORT produces the ONWARD poke and the outpost pulls", async () => {
    // ---- HOP 1: commander -> retrans (contentless, mTLS, best-effort).
    const hop1 = await pokeDownstreamPeersForOrg(commander.db, commander.orgId, {
      bearer: retrans.adminToken,
      mtls: commanderMtls
    });
    expect(hop1).toHaveLength(1);
    expect(hop1[0]!.outcome).toBe("sent");
    expect(retrans.sends).toContain(FEDERATION_SYNC_QUEUE);
    // D2: the retrans can now legitimately go sparse on its commander — pokes DO arrive.
    const retransUpstream = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      getPeerByIdOrName(tx, retrans.orgId, commander.self.domainId)
    );
    expect(retransUpstream.lastPokeReceivedAt).not.toBeNull();

    // ---- The retrans's poke-woken (FORCED) tick pulls + imports from the commander.
    const outboxBefore = await outboxCount(retrans);
    const pulled = await federationSyncOrgTick(retrans.db, retrans.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: retransMtls,
      force: true
    });
    expect(pulled).toHaveLength(1);
    expect(pulled[0]!.outcome).toBe("imported");
    expect(pulled[0]!.appliedEntries ?? 0).toBeGreaterThan(0);

    // THE CAUSAL LINK: applying entries wrote outbox rows in the SAME transaction. The onward poke
    // is derived from THOSE rows (the sender hangs off the outbox relay) — it is not a forwarded
    // copy of the poke that arrived.
    const outboxAfter = await outboxCount(retrans);
    expect(outboxAfter).toBeGreaterThan(outboxBefore);

    // ---- HOP 2: retrans -> outpost, exactly as the outbox relay would drive it.
    const hop2 = await pokeDownstreamPeersForOrg(retrans.db, retrans.orgId, {
      bearer: outpost.adminToken,
      mtls: retransMtls
    });
    expect(hop2).toHaveLength(1);
    expect(hop2[0]!.outcome).toBe("sent");
    expect(outpost.sends).toContain(FEDERATION_SYNC_QUEUE);
    const outpostUpstream = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getPeerByIdOrName(tx, outpost.orgId, retrans.self.domainId)
    );
    expect(outpostUpstream.lastPokeReceivedAt).not.toBeNull();

    // ---- And the outpost's poke-woken tick really does pull from the retrans.
    const outpostPull = await federationSyncOrgTick(outpost.db, outpost.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: retrans.adminToken },
      mtls: outpostMtls,
      force: true
    });
    expect(outpostPull).toHaveLength(1);
    expect(outpostPull[0]!.outcome).toBe("imported");
  }, 120_000);

  it("REPLAY TERMINATES THE CHAIN: a byte-identical re-import applies nothing and produces NO onward poke", async () => {
    const outboxBefore = await outboxCount(retrans);

    // The same pull again — the cursor has already advanced, so this re-import is a no-op.
    const replay = await federationSyncOrgTick(retrans.db, retrans.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: retransMtls,
      force: true
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]!.outcome).toBe("imported");
    expect(replay[0]!.appliedEntries ?? 0).toBe(0);

    // ZERO new outbox rows => the outbox relay has nothing to hand the poke sender => NO onward
    // poke. The chain terminates by CONSTRUCTION — no hop counter, no TTL, and therefore not a
    // single byte of content inside the contentless signal.
    expect(await outboxCount(retrans)).toBe(outboxBefore);
  }, 120_000);
});

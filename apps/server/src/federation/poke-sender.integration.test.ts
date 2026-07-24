import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
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
import type { AppDeps } from "../types.js";
import { testDatabaseUrl, createTestOrg, type TestServer } from "../test-support/harness.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import { FEDERATION_SYNC_QUEUE } from "./federation-sync.js";
import { pokeRateLimiter } from "./poke-rate-limit.js";
import type { FederationClientMtls } from "./federation-outbound.js";
import {
  createCommanderPokeSender,
  pokeDownstreamPeersForOrg,
  type PokeSendOutcome
} from "./poke-sender.js";
import { createTestCa, issueLeafCert, opensslAvailable, type TestCa } from "./test-support/mtls-pki.js";

/**
 * M14.3 — the COMMANDER POKE SENDER, end-to-end against real Postgres + a real mTLS listener
 * (docs/proposals/outpost-poke.md §"Milestone scope", ADR-0009).
 *
 * A commander (the SENDER, presenting its enrolled `urn:scp:domain:<commanderDomainId>` client cert)
 * pokes an outpost (the RECEIVER, running a real HTTPS mTLS listener with the M14.2 poke endpoint and
 * receiver-side pokeMode=true for the commander). The wake is asserted by injecting a RECORDING
 * pg-boss into the outpost's deps: an accepted poke enqueues exactly one immediate
 * `FEDERATION_SYNC_QUEUE` tick (the pull runs on the loop's worker, never inline).
 *
 * Proves: (1) a poke-mode outpost peer IS poked over mTLS; (2) a pokeMode=false peer is NOT;
 * (3) an unreachable peer fails best-effort — no throw, no escalation, the live peer still poked;
 * (4) coalescing — multiple signals in one window collapse to at most one poke. Skipped wholesale
 * when `openssl` is unavailable (mirrors the M14.0/M14.2 mTLS suites).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

async function bootDomain(label: string, mtlsEnv: Record<string, string> = {}): Promise<Domain> {
  dbCounter += 1;
  const dbName = `pokesend_${label}_${Date.now()}_${dbCounter}`
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

describe.skipIf(!opensslAvailable())("M14.3 commander poke sender (mTLS, two-domain)", () => {
  let ca: TestCa;
  let commander: Domain; // the SENDER (dials, presents its client cert)
  let outpost: Domain; // the RECEIVER (real mTLS listener + poke endpoint)
  let commanderClientMtls: FederationClientMtls;
  let outpostUrl: string;
  let deadOutpostDomainId: string;
  let pollOutpostDomainId: string;

  // The outpost's recording pg-boss: every accepted poke's wake (boss.send) lands here.
  let sends: string[] = [];

  beforeAll(async () => {
    ca = createTestCa();

    // The RECEIVER (outpost) runs a real mTLS listener: server leaf (SAN DNS:localhost) + CA trust.
    const outpostServerLeaf = issueLeafCert(ca, { name: `outpost-server-${randomUUID()}` });
    outpost = await bootDomain("out", {
      SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
      SCP_FEDERATION_SERVER_MTLS_CERT_FILE: outpostServerLeaf.certFile,
      SCP_FEDERATION_SERVER_MTLS_KEY_FILE: outpostServerLeaf.keyFile
    });
    // Inject the recording boss so the poke endpoint's wakeFederationSyncNow is captured.
    outpost.deps.boss = {
      send: async (queue: string) => {
        sends.push(queue);
        return "job-id";
      }
    } as unknown as PgBoss;

    // The SENDER (commander) needs no server mTLS — only client-cert material to DIAL with.
    commander = await bootDomain("cmd");
    outpostUrl = `https://localhost:${outpost.port}`;

    // The commander's enrolled CLIENT cert: SAN URI = urn:scp:domain:<commander domain id>.
    const commanderLeaf = issueLeafCert(ca, {
      name: `commander-client-${randomUUID()}`,
      sanUri: federationPeerSanUri(commander.self.domainId)
    });
    commanderClientMtls = {
      cert: commanderLeaf.certPem.toString("utf8"),
      key: commanderLeaf.keyPem.toString("utf8"),
      ca: ca.caCrtPem.toString("utf8")
    };

    const commanderKey = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const outpostKey = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );

    // COMMANDER side: the outpost is a DOWNSTREAM poke-mode peer to dial. baseUrl = the live outpost.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: outpost.self.domainId,
        name: "the-outpost",
        role: "outpost",
        publicKey: outpostKey.publicKey,
        baseUrl: outpostUrl,
        pokeMode: true
      })
    );
    // A poll-mode downstream peer (pokeMode default false) — must NEVER be poked (SCOPE 1/5).
    pollOutpostDomainId = randomUUID();
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: pollOutpostDomainId,
        name: "poll-outpost",
        role: "outpost",
        publicKey: outpostKey.publicKey,
        baseUrl: "https://localhost:1"
        // pokeMode omitted -> defaults to false.
      })
    );

    // RECEIVER (outpost) side: enroll the commander as an UPSTREAM peer with receiver-side
    // pokeMode=true (both-sides consent). Its baseUrl must be https for the M14.1 pair guard; it is
    // never dialed by the receiver, so a placeholder is fine.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: commander.self.domainId,
        name: "the-commander",
        role: "commander",
        publicKey: commanderKey.publicKey,
        baseUrl: "https://localhost:1",
        pokeMode: true
      })
    );
  }, 120_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  beforeEach(() => {
    sends = [];
    // The RECEIVER's per-peer bucket must start full each case (cases run within one refill window).
    pokeRateLimiter.reset();
  });

  function bySent(outcomes: PokeSendOutcome[]) {
    return outcomes.filter((o) => o.outcome === "sent").map((o) => o.peerDomainId);
  }

  it("SENT: a poke-mode outpost peer is poked over mTLS -> the receiver enqueues one sync tick", async () => {
    const outcomes = await pokeDownstreamPeersForOrg(commander.db, commander.orgId, {
      bearer: outpost.adminToken,
      mtls: commanderClientMtls
    });

    // Only the poke-mode outpost is targeted (the poll-mode peer is filtered out entirely).
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.peerDomainId).toBe(outpost.self.domainId);
    expect(outcomes[0]!.outcome).toBe("sent");
    // The wake reached the receiver: exactly one immediate FEDERATION_SYNC_QUEUE tick, no inline pull.
    expect(sends).toEqual([FEDERATION_SYNC_QUEUE]);
  });

  it("NO POKE to a poll-mode peer: the pokeMode=false outpost is never in the outcome set", async () => {
    const outcomes = await pokeDownstreamPeersForOrg(commander.db, commander.orgId, {
      bearer: outpost.adminToken,
      mtls: commanderClientMtls
    });
    expect(outcomes.map((o) => o.peerDomainId)).not.toContain(pollOutpostDomainId);
  });

  it("BEST-EFFORT: an unreachable poke-mode peer errors WITHOUT throwing or blocking the live peer", async () => {
    // Add an unreachable poke-mode outpost (dead port). One bad peer must never brick the round nor
    // escalate — the live peer is still poked, and the call resolves normally (no throw).
    deadOutpostDomainId = randomUUID();
    const outpostKeyPub = (
      await withTenantTx(outpost.db, outpost.orgId, (tx) => ensureInstanceKey(tx, outpost.orgId))
    ).publicKey;
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      pairPeer(tx, {
        orgId: commander.orgId,
        domainId: deadOutpostDomainId,
        name: "dead-outpost",
        role: "outpost",
        publicKey: outpostKeyPub,
        baseUrl: "https://127.0.0.1:1", // nothing listening -> ECONNREFUSED
        pokeMode: true
      })
    );

    const outcomes = await pokeDownstreamPeersForOrg(commander.db, commander.orgId, {
      bearer: outpost.adminToken,
      mtls: commanderClientMtls
    });

    const dead = outcomes.find((o) => o.peerDomainId === deadOutpostDomainId);
    expect(dead?.outcome).toBe("error"); // failed best-effort, logged+dropped, never thrown
    // The healthy peer was STILL poked despite the dead one — one failure doesn't block others.
    expect(bySent(outcomes)).toContain(outpost.self.domainId);
    expect(sends).toEqual([FEDERATION_SYNC_QUEUE]);
  });

  it("COALESCE: multiple signals for the same peer in one window collapse to at most one poke", async () => {
    // A fixed clock keeps both rounds inside the same coalesce window deterministically.
    const now = () => 5_000_000;
    const sender = createCommanderPokeSender(commander.db, {
      env: { SCP_FEDERATION_SYNC_BEARER: outpost.adminToken },
      mtls: commanderClientMtls,
      coalesceMs: 60_000,
      now
    });
    try {
      sender.onEventsRelayed([commander.orgId]);
      await sender.drain();
      sender.onEventsRelayed([commander.orgId]); // second signal in the SAME window -> coalesced
      await sender.drain();
      // Despite two signals, the receiver was woken at most once.
      expect(sends).toEqual([FEDERATION_SYNC_QUEUE]);
    } finally {
      await sender.stop();
    }
  });

  it("INERT: with no outbound client-cert material the sender no-ops (SCOPE 5, opt-in/default-off)", async () => {
    const sender = createCommanderPokeSender(commander.db, {
      env: {}, // no SCP_FEDERATION_MTLS_* -> not configured
      mtls: null // explicitly none
    });
    try {
      sender.onEventsRelayed([commander.orgId]);
      await sender.drain();
      expect(sends).toEqual([]); // never scanned, never dialed
    } finally {
      await sender.stop();
    }
  });
});

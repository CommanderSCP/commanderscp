import path from "node:path";
import { tmpdir } from "node:os";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { decisions, federationPeers } from "../db/schema.js";
import type { AppDeps } from "../types.js";
import { testDatabaseUrl, createTestOrg, type TestServer } from "../test-support/harness.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import {
  federationSyncOrgTick,
  isPeerDue,
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
      mtls: outpostClientMtls,
      // M14.4: this poll-mode peer was attempted moments ago by the previous case, so the new
      // per-peer due-gate would (correctly) skip it. Advancing the injected clock past the FREQUENT
      // interval is what a real second tick a minute later looks like — the assertions below are
      // unchanged and still prove cursor idempotency.
      now: new Date(Date.now() + 120_000)
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
      mtls: null,
      // M14.4 due-gate: same as the case above — a poll-mode peer is due once per frequent interval,
      // so the injected clock stands in for the elapsed time between real ticks.
      now: new Date(Date.now() + 240_000)
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome).toBe("refused");
    expect(outcomes[0]!.decisionId).toBeTruthy();
  });
});

/**
 * M14.4 — SCHEDULER MODE (ADR-0009; owner decisions D1–D4, 2026-07-24). The same real two-domain
 * mTLS harness as above, driven with a DETERMINISTIC CLOCK so a 15-minute sparse window is a
 * millisecond of test time. Every case asserts on how many peers the tick actually PULLED
 * (`outcomes.length`) — a peer the due-gate skipped produces no outcome at all.
 */
describe.skipIf(!opensslAvailable())("M14.4 scheduler mode — poke vs poll cadence", () => {
  let ca: TestCa;
  let commander: Domain;
  let outpost: Domain;
  let outpostClientMtls: FederationClientMtls;
  let commanderPeerId: string;

  const FREQUENT_SECONDS = 60; // SCP_FEDERATION_SYNC_INTERVAL_SECONDS default
  const SPARSE_SECONDS = 900; // SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS default (D1)
  const T0 = Date.parse("2026-07-24T12:00:00.000Z");

  /** A tick at `T0 + offsetSeconds` on the outpost, with the enrolled client cert unless overridden. */
  function tickAt(
    offsetSeconds: number,
    overrides: { mtls?: FederationClientMtls | null; force?: boolean } = {}
  ) {
    return federationSyncOrgTick(outpost.db, outpost.orgId, {
      env: { SCP_FEDERATION_SYNC_BEARER: commander.adminToken },
      mtls: overrides.mtls === undefined ? outpostClientMtls : overrides.mtls,
      force: overrides.force,
      now: new Date(T0 + offsetSeconds * 1000)
    });
  }

  /** Rewrites the outpost's due-state for its commander peer directly — the equivalent of "this is
   *  where the scheduler left off", without waiting for wall-clock windows. */
  async function setPeerState(patch: {
    pokeMode?: boolean;
    lastPullAttemptAt?: Date | null;
    lastPullSuccessAt?: Date | null;
    lastPokeReceivedAt?: Date | null;
  }): Promise<void> {
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .update(federationPeers)
        .set(patch)
        .where(
          and(
            eq(federationPeers.orgId, outpost.orgId),
            eq(federationPeers.id, commanderPeerId)
          )
        )
    );
  }

  async function peerState() {
    const peers = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      listPeers(tx, outpost.orgId)
    );
    return peers.find((p) => p.id === commanderPeerId)!;
  }

  beforeAll(async () => {
    ca = createTestCa();
    const serverLeaf = issueLeafCert(ca, { name: `commander-server-${randomUUID()}` });
    commander = await bootDomain("cmd144", {
      SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
      SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
      SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
    });
    outpost = await bootDomain("out144");
    const commanderUrl = `https://localhost:${commander.port}`;

    const outpostLeaf = issueLeafCert(ca, {
      name: `outpost-client-${randomUUID()}`,
      sanUri: federationPeerSanUri(outpost.self.domainId)
    });
    outpostClientMtls = {
      cert: outpostLeaf.certPem.toString("utf8"),
      key: outpostLeaf.keyPem.toString("utf8"),
      ca: ca.caCrtPem.toString("utf8")
    };

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
    commanderPeerId = commander.self.domainId;

    await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: "m14-4-seed",
        name: "m144-service",
        properties: {}
      })
    );
  }, 180_000);

  afterAll(async () => {
    await outpost?.close();
    await commander?.close();
  });

  beforeEach(async () => {
    // Fresh due-state before each case: never attempted, never poked, poll-mode.
    await setPeerState({
      pokeMode: false,
      lastPullAttemptAt: null,
      lastPullSuccessAt: null,
      lastPokeReceivedAt: null
    });
  });

  it("(a) POKE-MODE DISABLES THE FREQUENT POLL: a proven poke-mode peer pulls ONCE per sparse window", async () => {
    await setPeerState({ pokeMode: true, lastPokeReceivedAt: new Date(T0 - 1000) });

    // The first tick pulls (never attempted = due now) and stamps both timestamps.
    const first = await tickAt(0);
    expect(first).toHaveLength(1);
    expect(first[0]!.outcome).toBe("imported");

    // Every tick inside the SPARSE window pulls NOTHING — the frequent leg is gone.
    for (const offset of [FREQUENT_SECONDS, 2 * FREQUENT_SECONDS, 300, SPARSE_SECONDS - 1]) {
      expect(await tickAt(offset)).toHaveLength(0);
    }

    // The SAME peer in poll-mode pulls every frequent window instead.
    await setPeerState({
      pokeMode: false,
      lastPullAttemptAt: null,
      lastPullSuccessAt: null
    });
    expect(await tickAt(2000)).toHaveLength(1);
    expect(await tickAt(2000 + FREQUENT_SECONDS / 2)).toHaveLength(0);
    expect(await tickAt(2000 + FREQUENT_SECONDS)).toHaveLength(1);
  });

  it("(b) D2 SELF-PROVING: pokeMode WITHOUT a received poke stays frequent; after a poke it goes sparse", async () => {
    // Flag set on THIS side only — the commander's half may never have been enabled.
    await setPeerState({ pokeMode: true, lastPokeReceivedAt: null });

    expect(await tickAt(0)).toHaveLength(1); // never attempted -> due
    expect(await tickAt(30)).toHaveLength(0); // inside the FREQUENT window
    expect(await tickAt(FREQUENT_SECONDS)).toHaveLength(1); // frequent, NOT sparse — no silent 15min staleness
    expect(await tickAt(2 * FREQUENT_SECONDS)).toHaveLength(1);
    expect((await peerState()).lastPokeReceivedAt).toBeNull();

    // Now a poke actually arrives (what the M14.2 handler stamps) — the peer earns sparse.
    await setPeerState({ lastPokeReceivedAt: new Date(T0 + 2 * FREQUENT_SECONDS * 1000) });
    expect(await tickAt(3 * FREQUENT_SECONDS)).toHaveLength(0);
    expect(await tickAt(600)).toHaveLength(0);
  });

  it("(c) S4 GUARD: a FORCED (poke-woken) tick pulls a peer that is deep inside its sparse window", async () => {
    await setPeerState({ pokeMode: true, lastPokeReceivedAt: new Date(T0 - 1000) });
    expect(await tickAt(0)).toHaveLength(1);
    // 60s later the due-gate says "not for another 14 minutes"…
    expect(await tickAt(FREQUENT_SECONDS)).toHaveLength(0);
    // …but the poke's forced tick pulls anyway. Without this the poke would be silently swallowed
    // by the very feature it complements and poke-mode would degrade to sparse polling.
    const forced = await tickAt(FREQUENT_SECONDS + 1, { force: true });
    expect(forced).toHaveLength(1);
    expect(forced[0]!.outcome).toBe("imported");
  });

  it("(d) DROPPED POKE SELF-HEALS: no poke ever arrives, the sparse safety-net still pulls", async () => {
    await setPeerState({ pokeMode: true, lastPokeReceivedAt: new Date(T0 - 1000) });
    expect(await tickAt(0)).toHaveLength(1);
    expect(await tickAt(SPARSE_SECONDS - 1)).toHaveLength(0);
    const healed = await tickAt(SPARSE_SECONDS);
    expect(healed).toHaveLength(1);
    expect(healed[0]!.outcome).toBe("imported");
  });

  it("(e) RECONNECT LEG: a FAILED pull returns a poke-mode peer to the frequent cadence until one succeeds", async () => {
    await setPeerState({ pokeMode: true, lastPokeReceivedAt: new Date(T0 - 1000) });

    // A failing attempt (no client cert -> fail-closed refusal) stamps the ATTEMPT but not success.
    const refused = await tickAt(0, { mtls: null });
    expect(refused).toHaveLength(1);
    expect(refused[0]!.outcome).toBe("refused");
    const afterFailure = await peerState();
    expect(afterFailure.lastPullAttemptAt).not.toBeNull();
    expect(afterFailure.lastPullSuccessAt).toBeNull();

    // Still FREQUENT despite pokeMode — a peer that cannot sync must keep trying, not go sparse.
    expect(await tickAt(30)).toHaveLength(0);
    const recovered = await tickAt(FREQUENT_SECONDS);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.outcome).toBe("imported");
    expect((await peerState()).lastPullSuccessAt).not.toBeNull();

    // One success RE-ARMS sparse: the next frequent window no longer pulls.
    expect(await tickAt(2 * FREQUENT_SECONDS)).toHaveLength(0);
  });

  it("(f) D4: an instance with NO client-cert material does NOT go sparse", async () => {
    await setPeerState({
      pokeMode: true,
      lastPokeReceivedAt: new Date(T0 - 1000),
      lastPullAttemptAt: new Date(T0 - 120_000),
      lastPullSuccessAt: new Date(T0 - 120_000)
    });
    // With certs this peer is sparse and NOT due 120s after a successful pull…
    expect(await tickAt(0)).toHaveLength(0);
    // …but with the runtime cert material gone the poke path is dead, so it falls back to the
    // frequent cadence and is attempted (and fail-closed refused, never dialed plain).
    const noCerts = await tickAt(1, { mtls: null });
    expect(noCerts).toHaveLength(1);
    expect(noCerts[0]!.outcome).toBe("refused");
  });

  it("REPLICA SAFETY: the claim is a conditional UPDATE — concurrent ticks pull the peer once", async () => {
    await setPeerState({ pokeMode: false });
    const [a, b, c] = await Promise.all([tickAt(0), tickAt(0), tickAt(0)]);
    const pulled = [...a, ...b, ...c];
    expect(pulled).toHaveLength(1);
  });
});

/**
 * M14.4 (l) — MIGRATION 0038 applies cleanly ON TOP OF a database already seeded at 0037, and every
 * PRE-EXISTING peer row reads NULL for all three new columns, which the due-gate treats as DUE NOW.
 * That NULL-is-due property is the whole reason the migration needs no backfill: an upgraded
 * instance's very next tick pulls exactly as it did before.
 *
 * Driven by migrating a scratch database with a TRUNCATED copy of the drizzle folder (journal
 * entries <= 0037), writing a peer row against that older schema, then running the REAL folder.
 */
describe("M14.4 migration 0038 — additive on a DB seeded at 0037", () => {
  it("applies onto 0037 and leaves pre-existing peers with NULL due-state (= due now)", async () => {
    const dbName = `fedsync_mig38_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
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
    const scratchUrl = new URL(adminUrl.toString());
    scratchUrl.pathname = `/${dbName}`;

    // A copy of the migrations folder whose journal stops at 0037 — i.e. the schema as shipped
    // BEFORE this milestone. The SQL files are byte-identical, so drizzle's applied-migration
    // hashes carry over and the second `migrate` applies ONLY 0038.
    const tmpFolder = await mkdtemp(path.join(tmpdir(), "scp-drizzle-0037-"));
    await cp(migrationsFolder, tmpFolder, { recursive: true });
    const journalPath = path.join(tmpFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const truncated = journal.entries.filter((e) => e.idx <= 37);
    expect(truncated.at(-1)?.tag).toBe("0037_federation_peer_poke_mode");
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: truncated }, null, 2));

    const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
    try {
      await migrate(drizzle(pool), { migrationsFolder: tmpFolder });
      // The columns do not exist yet at 0037 — that IS the pre-upgrade state.
      const before = await pool.query(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'federation_peers' AND column_name = 'last_pull_attempt_at'`
      );
      expect(before.rowCount).toBe(0);

      const orgId = randomUUID();
      const peerId = randomUUID();
      await pool.query(
        `INSERT INTO federation_peers (id, org_id, name, role) VALUES ($1, $2, $3, 'commander')`,
        [peerId, orgId, "legacy-commander"]
      );

      // THE UPGRADE.
      await migrate(drizzle(pool), { migrationsFolder });

      const after = await pool.query<{
        last_pull_attempt_at: Date | null;
        last_pull_success_at: Date | null;
        last_poke_received_at: Date | null;
        poke_mode: boolean;
      }>(
        `SELECT last_pull_attempt_at, last_pull_success_at, last_poke_received_at, poke_mode
           FROM federation_peers WHERE id = $1`,
        [peerId]
      );
      const row = after.rows[0]!;
      expect(row.last_pull_attempt_at).toBeNull();
      expect(row.last_pull_success_at).toBeNull();
      expect(row.last_poke_received_at).toBeNull();
      expect(row.poke_mode).toBe(false);

      // NULL reads as "never" -> DUE NOW, for a poll-mode peer and a poke-mode one alike.
      const legacy = {
        pokeMode: row.poke_mode,
        lastPullAttemptAt: null,
        lastPullSuccessAt: null,
        lastPokeReceivedAt: null
      };
      const inputs = { frequent: 60, sparse: 900, hasClientCerts: true };
      expect(isPeerDue(legacy, new Date(), inputs)).toBe(true);
      expect(isPeerDue({ ...legacy, pokeMode: true }, new Date(), inputs)).toBe(true);
    } finally {
      await pool.end();
      await rm(tmpFolder, { recursive: true, force: true });
    }
  }, 120_000);
});

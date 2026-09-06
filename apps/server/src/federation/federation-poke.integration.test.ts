import https from "node:https";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type PgBoss from "pg-boss";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool, type Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { AppDeps } from "../types.js";
import {
  testDatabaseUrl,
  testRuntimeDatabaseUrl,
  testPgBossDatabaseUrl,
  createTestOrg,
  type TestServer
} from "../test-support/harness.js";
import { ensureFederationSelf } from "./self-repo.js";
import { getPeerByIdOrName, pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import { FEDERATION_SYNC_QUEUE, federationSyncOrgTick } from "./federation-sync.js";
import { INBOX_QUEUE } from "./inbox-loop.js";
import { AUTO_RELAY_QUEUE } from "./auto-relay.js";
import { pokeRateLimiter } from "./poke-rate-limit.js";
import {
  createTestCa,
  issueLeafCert,
  opensslAvailable,
  type TestCa,
  type TestLeafCert
} from "./test-support/mtls-pki.js";
import { asTrustDomainId } from "@scp/schemas";

/**
 * M14.2 (ADR-0009, docs/proposals/outpost-poke.md) — the INBOUND CONTENTLESS POKE endpoint, driven
 * end-to-end against real Postgres + a REAL mTLS listener. The receiver is an outpost/retrans that
 * has opted into pokes from an enrolled commander; the caller is that commander, presenting its
 * enrolled `urn:scp:domain:<callerDomainId>` client cert exactly as M14.3's sender will.
 *
 * `fastify.inject()` fakes the socket, so (like `mtls.integration.test.ts`) every case boots a real
 * listener and drives it with `node:https`, presenting/withholding a client cert. The wake itself is
 * asserted by injecting a recording pg-boss into `deps.boss`: an accepted poke enqueues exactly one
 * immediate `FEDERATION_SYNC_QUEUE` tick (the pull runs on the loop's worker, never inline), and a
 * burst coalesces to at most one. Skipped wholesale when `openssl` is unavailable.
 */

interface Recorded {
  queue: string;
  /** The job payload, recorded only by the air-gap fixture below — asserting a wake is CONTENTLESS
   *  needs the payload, not just the queue name. */
  data?: unknown;
}

describe.skipIf(!opensslAvailable())(
  "M14.2 inbound federation poke (mTLS, both-sides consent)",
  () => {
    let ca: TestCa;
    let app: FastifyInstance;
    let deps: AppDeps;
    let db: Db;
    let pool: ReturnType<typeof createPool>;
    let port: number;
    let orgId: string;
    let adminToken: string;

    let pokePeer: { domainId: string; leaf: TestLeafCert };
    let noPokePeer: { domainId: string; leaf: TestLeafCert };

    // The recording boss injected into deps — every accepted poke's wake lands here.
    let sends: Recorded[] = [];

    function generateEd25519PublicKeyB64(): string {
      const { publicKey } = generateKeyPairSync("ed25519");
      return publicKey.export({ format: "der", type: "spki" }).toString("base64");
    }

    /** A real HTTPS POST to the receiver, optionally presenting a client cert / bearer / body. When
     *  `body` is undefined the request carries NO content-type and an empty payload (the contentless
     *  poke shape); a defined `body` is JSON-encoded (used to prove a junk body never drives behavior). */
    function httpsPost(opts: {
      path: string;
      cert?: Buffer;
      key?: Buffer;
      token?: string;
      body?: unknown;
    }): Promise<{ status: number; json: unknown }> {
      return new Promise((resolve, reject) => {
        const hasBody = opts.body !== undefined;
        const payload = hasBody ? JSON.stringify(opts.body) : "";
        const headers: Record<string, string> = {};
        if (hasBody) {
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(payload));
        }
        if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            path: opts.path,
            method: "POST",
            ca: ca.caCrtPem,
            cert: opts.cert,
            key: opts.key,
            rejectUnauthorized: false,
            agent: false,
            headers
          },
          (res) => {
            let raw = "";
            res.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined })
            );
          }
        );
        req.on("error", reject);
        if (hasBody) req.write(payload);
        req.end();
      });
    }

    beforeAll(async () => {
      ca = createTestCa();
      const serverLeaf = issueLeafCert(ca, { name: `receiver-server-${randomUUID()}` });

      const config = loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
        SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
        SCP_COOKIE_SECRET: "test-cookie-secret-value",
        SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
        SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
        SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
      });
      pool = createPool(config.runtimeDatabaseUrl);
      db = createDb(pool);
      deps = { db, config };
      // Inject a recording pg-boss: the poke's wake calls boss.send(FEDERATION_SYNC_QUEUE, {}).
      deps.boss = {
        send: async (queue: string) => {
          sends.push({ queue });
          return "job-id";
        }
      } as unknown as PgBoss;
      app = await buildApp(deps, { logger: false });
      await app.ready();
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      port = Number(new URL(address).port);

      const server: TestServer = { app, deps, close: async () => undefined };
      const org = await createTestOrg(server, "poke");
      orgId = org.orgId;
      adminToken = org.adminToken;
      await withTenantTx(db, orgId, (tx) => ensureFederationSelf(tx, orgId));

      // Enroll two commander peers on the RECEIVER side: one this instance has opted into pokes from
      // (pokeMode=true), one it has not (pokeMode=false). Each carries its own enrolled client cert.
      const pokeDomainId = asTrustDomainId(randomUUID());
      const noPokeDomainId = asTrustDomainId(randomUUID());
      pokePeer = {
        domainId: pokeDomainId,
        leaf: issueLeafCert(ca, { name: "cmd-poke", sanUri: federationPeerSanUri(pokeDomainId) })
      };
      noPokePeer = {
        domainId: noPokeDomainId,
        leaf: issueLeafCert(ca, {
          name: "cmd-nopoke",
          sanUri: federationPeerSanUri(noPokeDomainId)
        })
      };
      await withTenantTx(db, orgId, (tx) =>
        pairPeer(tx, {
          orgId,
          domainId: pokeDomainId,
          name: "cmd-poke",
          role: "commander",
          publicKey: generateEd25519PublicKeyB64(),
          // pokeMode=true requires an https/mTLS-capable baseUrl (M14.1 pair-time guard) — this is the
          // commander's dial URL (unused by the poke receiver, which never dials back).
          baseUrl: "https://localhost:1",
          pokeMode: true
        })
      );
      await withTenantTx(db, orgId, (tx) =>
        pairPeer(tx, {
          orgId,
          domainId: noPokeDomainId,
          name: "cmd-nopoke",
          role: "commander",
          publicKey: generateEd25519PublicKeyB64()
          // pokeMode defaults to false — the receiver never opted in.
        })
      );
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
    });

    beforeEach(() => {
      sends = [];
      pokeRateLimiter.reset();
    });

    it("ACCEPTED: mTLS poke from an enrolled peer with receiver-side pokeMode=true -> 202 + immediate sync tick enqueued", async () => {
      const res = await httpsPost({
        path: "/api/v1/federation/poke",
        cert: pokePeer.leaf.certPem,
        key: pokePeer.leaf.keyPem,
        token: adminToken,
        body: {}
      });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ accepted: true, woken: true });
      // The pull was TRIGGERED (not run inline): exactly one immediate federation-sync tick enqueued.
      expect(sends).toHaveLength(1);
      expect(sends[0]!.queue).toBe(FEDERATION_SYNC_QUEUE);
    });

    it("REJECTED (both-sides consent): an enrolled peer whose receiver-side pokeMode=false -> 409, no wake", async () => {
      const res = await httpsPost({
        path: "/api/v1/federation/poke",
        cert: noPokePeer.leaf.certPem,
        key: noPokePeer.leaf.keyPem,
        token: adminToken,
        body: {}
      });
      expect(res.status).toBe(409);
      expect(sends).toHaveLength(0);
    });

    it("REJECTED (unknown identity): a valid-CA cert whose SAN domain id is not an enrolled peer -> 403, no wake", async () => {
      const stranger = issueLeafCert(ca, {
        name: "stranger",
        sanUri: federationPeerSanUri(randomUUID()) // never paired
      });
      const res = await httpsPost({
        path: "/api/v1/federation/poke",
        cert: stranger.certPem,
        key: stranger.keyPem,
        token: adminToken,
        body: {}
      });
      expect(res.status).toBe(403);
      expect(sends).toHaveLength(0);
    });

    it("RATE-LIMITED (idempotent): a burst of pokes -> at most one pull, excess 429", async () => {
      const one = () =>
        httpsPost({
          path: "/api/v1/federation/poke",
          cert: pokePeer.leaf.certPem,
          key: pokePeer.leaf.keyPem,
          token: adminToken,
          body: {}
        });
      const results = await Promise.all([one(), one(), one(), one(), one()]);
      const accepted = results.filter((r) => r.status === 202);
      const limited = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(1);
      expect(limited).toHaveLength(4);
      // Contentless + idempotent: the whole burst coalesced to a SINGLE pull.
      expect(sends).toHaveLength(1);
      expect(sends[0]!.queue).toBe(FEDERATION_SYNC_QUEUE);
    });

    it("M14.4 D2: an ACCEPTED poke stamps last_poke_received_at for the calling peer (self-proving sparse)", async () => {
      // (Earlier accepted cases in this describe may already have stamped it — assert it ADVANCES.)
      const before = await withTenantTx(db, orgId, (tx) =>
        getPeerByIdOrName(tx, orgId, pokePeer.domainId)
      );
      const beforeMs = before.lastPokeReceivedAt ? Date.parse(before.lastPokeReceivedAt) : 0;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const res = await httpsPost({
        path: "/api/v1/federation/poke",
        cert: pokePeer.leaf.certPem,
        key: pokePeer.leaf.keyPem,
        token: adminToken,
        body: {}
      });
      expect(res.status).toBe(202);

      // The stamp is what lets the scheduler drop THIS peer to the sparse cadence. Without a poke
      // actually arriving it stays on the frequent poll no matter what the local flag says.
      const after = await withTenantTx(db, orgId, (tx) =>
        getPeerByIdOrName(tx, orgId, pokePeer.domainId)
      );
      expect(after.lastPokeReceivedAt).not.toBeNull();
      expect(Date.parse(after.lastPokeReceivedAt!)).toBeGreaterThan(beforeMs);

      // A REJECTED poke (receiver-side consent off) never counts as proof.
      const rejected = await withTenantTx(db, orgId, (tx) =>
        getPeerByIdOrName(tx, orgId, noPokePeer.domainId)
      );
      expect(rejected.lastPokeReceivedAt).toBeNull();
    });

    it("CONTENTLESS: a junk request body never drives behavior — still a plain accepted wake", async () => {
      const res = await httpsPost({
        path: "/api/v1/federation/poke",
        cert: pokePeer.leaf.certPem,
        key: pokePeer.leaf.keyPem,
        token: adminToken,
        body: { pull: "everything", peer: "someone-else", evil: true, sinceSequence: -999 }
      });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ accepted: true, woken: true });
      // Exactly one plain wake — nothing in the body changed the outcome.
      expect(sends).toHaveLength(1);
      expect(sends[0]!.queue).toBe(FEDERATION_SYNC_QUEUE);
    });
  }
);

/**
 * The FAIL-CLOSED TRANSPORT IDENTITY case needs a SEPARATE receiver with federation-server-mTLS
 * UNSET (plain HTTP, `enforceFederationMtls` no-ops). A bearer-only poke must be REFUSED (401) — a
 * bearer does not prove the caller is the enrolled commander. Not gated on openssl (no certs here).
 */
describe("M14.2 inbound federation poke — fail-closed transport identity (mTLS unset)", () => {
  it("REFUSED: a bearer-only poke with federation-server-mTLS unset -> 401 (never honored on bearer alone)", async () => {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
      SCP_COOKIE_SECRET: "test-cookie-secret-value"
      // NO SCP_FEDERATION_SERVER_MTLS_* — plain HTTP, mTLS gate is a no-op.
    });
    const pool = createPool(config.runtimeDatabaseUrl);
    const db = createDb(pool);
    const sends: Recorded[] = [];
    const deps: AppDeps = {
      db,
      config,
      boss: {
        send: async (queue: string) => {
          sends.push({ queue });
          return "job-id";
        }
      } as unknown as PgBoss
    };
    const app = await buildApp(deps, { logger: false });
    await app.ready();
    try {
      const server: TestServer = { app, deps, close: async () => undefined };
      const org = await createTestOrg(server, "pokeplain");
      await withTenantTx(db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId));

      // A well-formed, authenticated request over plain HTTP with a valid bearer — but NO client
      // cert / no mTLS transport identity. The poke MUST be refused fail-closed.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/federation/poke",
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload: {}
      });
      expect(res.statusCode).toBe(401);
      expect(sends).toHaveLength(0);
    } finally {
      await app.close();
      await pool.end();
    }
  });
});

/**
 * M14.4 (S6, test j) — THE AIR-GAP LEG. ADR-0009 §38 makes the high-side-retrans→outpost poke INSIDE
 * the air gap REQUIRED, not optional. But an air-gapped outpost has NO `role: commander` peer with a
 * baseUrl to dial — its content arrives as a FILE that the INBOX loop ingests. So a poke that woke
 * only the federation-sync sweep resolved to ZERO peers and did nothing at all.
 *
 * This receiver models exactly that: its only enrolled peer is the high-side RETRANS (role
 * `retrans`, poke-mode), so the sync sweep has nothing to pull from — the tick returns an EMPTY
 * outcome list — and the inbox tick is the only thing that can move the chain forward.
 */
describe.skipIf(!opensslAvailable())(
  "M14.4 air-gap poke leg — the poke wakes the INBOX loop",
  () => {
    let ca: TestCa;
    let app: FastifyInstance;
    let db: Db;
    let pool: ReturnType<typeof createPool>;
    let port: number;
    let orgId: string;
    let adminToken: string;
    let relay: { domainId: string; leaf: TestLeafCert };
    let sends: Recorded[] = [];
    let previousInboxLoop: string | undefined;
    let previousAutoRelay: string | undefined;
    /** Which queue's `boss.send` should THROW — models "that loop's queue does not exist on this
     *  process" (a split topology), the case the two independent try/catches exist for. */
    let failQueue: string | null = null;

    beforeAll(async () => {
      // The inbox wake is sent only where the deployment actually RUNS an inbox loop — otherwise the
      // queue does not exist and the send is pure noise (the flag is deployment-wide; the worker
      // replica that created the queue shares it with the api replica serving this request).
      previousInboxLoop = process.env.SCP_INBOX_LOOP;
      process.env.SCP_INBOX_LOOP = "1";
      // M13.1b — same rule for the BYTE leg: the auto-relay wake is sent only where the deployment
      // actually runs that loop. Enabled here so the third leg is under test at all.
      previousAutoRelay = process.env.SCP_RETRANS_AUTO_RELAY;
      process.env.SCP_RETRANS_AUTO_RELAY = "1";

      ca = createTestCa();
      const serverLeaf = issueLeafCert(ca, { name: `airgap-receiver-${randomUUID()}` });
      const config = loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
        SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
        SCP_COOKIE_SECRET: "test-cookie-secret-value",
        SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
        SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
        SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
      });
      pool = createPool(config.runtimeDatabaseUrl);
      db = createDb(pool);
      const deps: AppDeps = { db, config };
      deps.boss = {
        send: async (queue: string, data?: unknown) => {
          if (queue === failQueue) {
            throw new Error(`queue ${queue} does not exist on this process`);
          }
          sends.push({ queue, data });
          return "job-id";
        }
      } as unknown as PgBoss;
      app = await buildApp(deps, { logger: false });
      await app.ready();
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      port = Number(new URL(address).port);

      const server: TestServer = { app, deps, close: async () => undefined };
      const org = await createTestOrg(server, "airgappoke");
      orgId = org.orgId;
      adminToken = org.adminToken;
      await withTenantTx(db, orgId, (tx) => ensureFederationSelf(tx, orgId));

      const relayDomainId = asTrustDomainId(randomUUID());
      relay = {
        domainId: relayDomainId,
        leaf: issueLeafCert(ca, {
          name: "high-side-retrans",
          sanUri: federationPeerSanUri(relayDomainId)
        })
      };
      const { publicKey } = generateKeyPairSync("ed25519");
      await withTenantTx(db, orgId, (tx) =>
        pairPeer(tx, {
          orgId,
          domainId: relayDomainId,
          name: "high-side-retrans",
          // NOT a `commander` peer: the sync sweep only ever pulls from `commander`-role peers, so
          // this instance has NOTHING to pull. Its content crosses the CDS as a file.
          role: "retrans",
          publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          baseUrl: "https://localhost:1",
          pokeMode: true
        })
      );
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      if (previousInboxLoop === undefined) delete process.env.SCP_INBOX_LOOP;
      else process.env.SCP_INBOX_LOOP = previousInboxLoop;
      if (previousAutoRelay === undefined) delete process.env.SCP_RETRANS_AUTO_RELAY;
      else process.env.SCP_RETRANS_AUTO_RELAY = previousAutoRelay;
    });

    beforeEach(() => {
      sends = [];
      failQueue = null;
      pokeRateLimiter.reset();
    });

    async function poke(): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/v1/federation/poke",
            method: "POST",
            ca: ca.caCrtPem,
            cert: relay.leaf.certPem,
            key: relay.leaf.keyPem,
            rejectUnauthorized: false,
            agent: false,
            headers: { authorization: `Bearer ${adminToken}` }
          },
          (r) => {
            let raw = "";
            r.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
            r.on("end", () =>
              resolve({ status: r.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined })
            );
          }
        );
        req.on("error", reject);
        req.end();
      });
    }

    it("the sync sweep alone would do NOTHING here (no role:commander peer to pull from)", async () => {
      const outcomes = await federationSyncOrgTick(db, orgId, { env: {}, mtls: null });
      expect(outcomes).toEqual([]);
    });

    it("a poke enqueues an INBOX tick as well as the sync tick, and still returns 202", async () => {
      const res = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/v1/federation/poke",
            method: "POST",
            ca: ca.caCrtPem,
            cert: relay.leaf.certPem,
            key: relay.leaf.keyPem,
            rejectUnauthorized: false,
            agent: false,
            headers: { authorization: `Bearer ${adminToken}` }
          },
          (r) => {
            let raw = "";
            r.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
            r.on("end", () =>
              resolve({ status: r.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined })
            );
          }
        );
        req.on("error", reject);
        req.end();
      });

      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ accepted: true });
      // BOTH loops woken, each behind its own try/catch — the air-gap leg is the INBOX one.
      const queues = sends.map((s) => s.queue);
      expect(queues).toContain(INBOX_QUEUE);
      expect(queues).toContain(FEDERATION_SYNC_QUEUE);
    });

    /**
     * N3 — THE TWO INDEPENDENT TRY/CATCHES, ACTUALLY EXERCISED. Every other test here injects a
     * recording boss whose `send` always succeeds, so the isolation between the two wakes was only
     * correct BY INSPECTION. A real split topology is precisely the case where one queue does not
     * exist on the process serving the request, and a `boss.send` for it THROWS.
     */
    it("N3: when the SYNC queue's send throws, the poke is still accepted and the AIR-GAP (inbox) leg still fires", async () => {
      failQueue = FEDERATION_SYNC_QUEUE;
      const res = await poke();

      expect(res.status).toBe(202);
      // The other legs are unaffected — one failing wake never aborts the handler. (The auto-relay
      // queue joined this list in M13.1b; the sync leg is the only one suppressed here.)
      expect(sends.map((s) => s.queue)).toEqual([INBOX_QUEUE, AUTO_RELAY_QUEUE]);
      // …and `woken` reports the leg that ACTUALLY fired. On a pure air-gap outpost the sync queue is
      // absent by construction, so keying `woken` on the sync wake alone reported `false` for a poke
      // that had just successfully woken the very leg M14.4 added.
      expect(res.json).toMatchObject({
        accepted: true,
        woken: true,
        wokenSync: false,
        wokenInbox: true
      });
    });

    it("N3: when the INBOX queue's send throws, the poke is still accepted and the SYNC leg still fires", async () => {
      failQueue = INBOX_QUEUE;
      const res = await poke();

      expect(res.status).toBe(202);
      expect(sends.map((s) => s.queue)).toEqual([FEDERATION_SYNC_QUEUE, AUTO_RELAY_QUEUE]);
      expect(res.json).toMatchObject({
        accepted: true,
        woken: true,
        wokenSync: true,
        wokenInbox: false
      });
    });

    /**
     * M13.1b — THE BYTE LEG. Legs 1 and 2 move METADATA: a poke landing on a retrans woke the import
     * of the arriving `.scpbundle` and then waited for a human to run the byte hop (M14.4's
     * honest-scope note, owner decision D3). This third leg is what makes the ADR-0009 chain move
     * BYTES, and "a poke triggers an immediate cycle" is half of M13.1b's own DoD — so it is asserted
     * here rather than left correct-by-inspection, exactly as the inbox leg was.
     *
     * Asserted on the QUEUE the wake actually landed on, not on the response alone: `wokenRelay` is a
     * boolean the handler sets, so a regression that dropped the `boss.send` while leaving the flag
     * would keep the response green and move nothing.
     */
    it("M13.1b: a poke wakes the AUTO-RELAY queue too — the leg that makes the chain move bytes, not just metadata", async () => {
      const res = await poke();

      expect(res.status).toBe(202);
      expect(sends.map((s) => s.queue)).toContain(AUTO_RELAY_QUEUE);
      // Contentless: WHICH promotions are owed is discovered by the sweep, exactly as on an interval
      // tick. The reason is a routing marker (it suppresses the re-schedule), never content.
      const relayWake = sends.find((s) => s.queue === AUTO_RELAY_QUEUE);
      expect(relayWake?.data).toEqual({ reason: "poke" });
      expect(res.json).toMatchObject({
        accepted: true,
        woken: true,
        wokenSync: true,
        wokenInbox: true,
        wokenRelay: true
      });
    });

    it("M13.1b: when the AUTO-RELAY queue's send throws, the poke is still accepted and BOTH metadata legs still fire", async () => {
      failQueue = AUTO_RELAY_QUEUE;
      const res = await poke();

      expect(res.status).toBe(202);
      expect(sends.map((s) => s.queue)).toEqual([FEDERATION_SYNC_QUEUE, INBOX_QUEUE]);
      expect(res.json).toMatchObject({
        accepted: true,
        woken: true,
        wokenSync: true,
        wokenInbox: true,
        wokenRelay: false
      });
    });

    /**
     * The gate on the byte leg, proven the same way the inbox leg's is: an instance that never opted
     * into unattended byte egress must not even have its queue poked. `startAutoRelayLoop` never
     * creates that queue when the flag is unset, so a send would be pure noise — but more to the
     * point, "a poke can reach it" is exactly the property the default-off consent denies.
     */
    it("M13.1b: with SCP_RETRANS_AUTO_RELAY unset, a poke does NOT touch the auto-relay queue", async () => {
      const previous = process.env.SCP_RETRANS_AUTO_RELAY;
      delete process.env.SCP_RETRANS_AUTO_RELAY;
      try {
        const res = await poke();
        expect(res.status).toBe(202);
        expect(sends.map((s) => s.queue)).not.toContain(AUTO_RELAY_QUEUE);
        expect(res.json).toMatchObject({ accepted: true, woken: true, wokenRelay: false });
      } finally {
        if (previous === undefined) delete process.env.SCP_RETRANS_AUTO_RELAY;
        else process.env.SCP_RETRANS_AUTO_RELAY = previous;
      }
    });
  }
);

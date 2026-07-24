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
import { pairPeer } from "./peers-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import { FEDERATION_SYNC_QUEUE } from "./federation-sync.js";
import { pokeRateLimiter } from "./poke-rate-limit.js";
import {
  createTestCa,
  issueLeafCert,
  opensslAvailable,
  type TestCa,
  type TestLeafCert
} from "./test-support/mtls-pki.js";

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

    // The enrolled peers on the RECEIVER side.
    let pokePeer: { domainId: string; leaf: TestLeafCert }; // receiver-side pokeMode = TRUE
    let noPokePeer: { domainId: string; leaf: TestLeafCert }; // receiver-side pokeMode = FALSE

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
      const pokeDomainId = randomUUID();
      const noPokeDomainId = randomUUID();
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

import https from "node:https";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { computeBundleChecksum, signBundleChecksum } from "@scp/schemas/federation-journal";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { decisions } from "../db/schema.js";
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
import { exportSyncBundle } from "./export-repo.js";
import { federationPeerSanUri } from "./mtls-enforcement.js";
import {
  createTestCa,
  issueLeafCert,
  revokeLeafCert,
  generateCrl,
  opensslAvailable,
  type TestCa,
  type TestLeafCert
} from "./test-support/mtls-pki.js";

/**
 * M9.3 (ADR-0001, `docs/adr/0001-in-app-federation-mtls.md`) — the attack-matrix integration
 * coverage for in-app federation mTLS. `fastify.inject()` (used everywhere else in this codebase)
 * fakes the request/response objects and never constructs a genuine `tls.TLSSocket` — there is no
 * real `request.raw.socket.getPeerCertificate()`/`.authorized` to assert against — so every test
 * here boots a REAL listener (`app.listen`) and drives it with `node:https`, presenting (or
 * withholding, or mis-presenting) a client certificate exactly as a real federation peer's
 * `federation-https` transport plugin would.
 *
 * PKI material is generated FRESH per test via `openssl` (`test-support/mtls-pki.ts`) — never
 * checked-in fixtures — since the SAN URI must encode a domain id each test only learns at
 * runtime (a freshly-paired peer's real UUID), and the expired-CRL tests need an exact,
 * deterministic `nextUpdate` rather than racing the wall clock. Skipped wholesale if `openssl`
 * isn't on PATH (mirrors `crl-parse.test.ts`/`crl-reload.test.ts`).
 */
describe.skipIf(!opensslAvailable())("in-app federation mTLS (M9.3, ADR-0001)", () => {
  let serversToClose: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(serversToClose.map((close) => close().catch(() => undefined)));
    serversToClose = [];
  });

  interface RunningServer {
    app: FastifyInstance;
    deps: AppDeps;
    port: number;
  }

  /** Boots a real Fastify app + real listener against the shared Testcontainers Postgres, with
   *  `mtlsEnv` merged into the loaded config — `{}` gets plain HTTP (mTLS disabled), matching
   *  every pre-M9.3 test server in this codebase. Auto-registered for cleanup in `afterEach`. */
  async function bootServer(mtlsEnv: Record<string, string> = {}): Promise<RunningServer> {
    const config = loadConfig({
      DATABASE_URL: testDatabaseUrl(),
      SCP_RUNTIME_DATABASE_URL: testRuntimeDatabaseUrl(),
      SCP_PGBOSS_DATABASE_URL: testPgBossDatabaseUrl(),
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
    serversToClose.push(async () => {
      await app.close();
      await pool.end();
    });
    return { app, deps, port };
  }

  interface HttpsCallOpts {
    port: number;
    path: string;
    body: unknown;
    token: string;
    ca: Buffer;
    cert?: Buffer;
    key?: Buffer;
  }

  /** A real HTTPS client request optionally presenting a client certificate — Node's own
   *  `https.request` (not `fetch`, which needs extra dispatcher plumbing to present a client cert
   *  through undici — see `plugin-host/subprocess-entry.ts`'s doc comment on that gotcha). The
   *  test client always sets `rejectUnauthorized: false` itself: it isn't validating the SERVER's
   *  TLS identity, only exercising how the SERVER treats what the CLIENT presents. */
  function httpsPost(opts: HttpsCallOpts): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(opts.body);
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: opts.port,
          path: opts.path,
          method: "POST",
          ca: opts.ca,
          cert: opts.cert,
          key: opts.key,
          rejectUnauthorized: false,
          // Never a pooled/reused connection — each call is its own fresh TLS handshake, so the
          // certificate presented (or withheld) on THIS call is what the server actually sees
          // (confirmed necessary empirically — see crl-reload.test.ts's identical comment).
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            authorization: `Bearer ${opts.token}`
          }
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : undefined });
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  /** A real HTTPS GET presenting NO client certificate (with an optional bearer token) — models a
   *  normal API/UI/CLI client or a k8s probe, none of which ever present a client cert. Used to
   *  prove enabling in-app mTLS (which flips the whole listener to HTTPS with `requestCert: true`)
   *  does not reject certless clients on non-transport routes. */
  function httpsGet(opts: {
    port: number;
    path: string;
    ca: Buffer;
    token?: string;
  }): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: opts.port,
          path: opts.path,
          method: "GET",
          ca: opts.ca,
          // NO cert/key — that is the whole point of this helper.
          rejectUnauthorized: false,
          agent: false,
          headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {}
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
      req.end();
    });
  }

  /** Plain (non-TLS) HTTP POST — for the "mTLS disabled -> plain HTTP still works, no regression"
   *  check. */
  function httpPost(
    port: number,
    path: string,
    body: unknown,
    token: string
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
            authorization: `Bearer ${token}`
          }
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
      req.write(payload);
      req.end();
    });
  }

  function generateEd25519KeypairB64(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")
    };
  }

  /** Builds the `SCP_FEDERATION_SERVER_MTLS_*` env for `bootServer`: a freshly-issued SERVER leaf
   *  cert (the listener's own identity) signed by `ca`, `ca`'s own cert as the trust root for
   *  verifying incoming PEER certs, and an optional CRL. */
  function mtlsEnvFor(
    ca: TestCa,
    opts: { crl?: Buffer; crlHardFailOnExpiry?: boolean } = {}
  ): Record<string, string> {
    const serverLeaf = issueLeafCert(ca, { name: `server-${randomUUID()}` });
    const env: Record<string, string> = {
      SCP_FEDERATION_SERVER_MTLS_CA_FILE: ca.caCrtFile,
      SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
      SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
    };
    if (opts.crl) {
      const crlFile = `${ca.dir}/live-${randomUUID()}.crl`;
      writeFileSync(crlFile, opts.crl);
      env.SCP_FEDERATION_SERVER_MTLS_CRL_FILE = crlFile;
    }
    if (opts.crlHardFailOnExpiry !== undefined) {
      env.SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY = String(opts.crlHardFailOnExpiry);
    }
    return env;
  }

  /** Sets up a test org + admin token + zero or more paired peers (each with a freshly-issued
   *  leaf cert whose SAN URI encodes that peer's real domain id) — using a THROWAWAY plain-HTTP
   *  server purely for setup (org/user/peer rows live in Postgres, independent of which Fastify
   *  instance wrote them, so the ACTUAL mTLS-configured server under test is booted separately,
   *  already knowing the CRL/CA it needs at construction time). */
  async function setupOrgWithPeers(
    ca: TestCa,
    peerSpecs: { key: string; role?: "commander" | "outpost" }[]
  ): Promise<{
    orgId: string;
    selfDomainId: string;
    adminToken: string;
    peers: Record<string, { domainId: string; leaf: TestLeafCert; keys: { publicKey: string; privateKey: string } }>;
  }> {
    const setup = await bootServer();
    const testServerLike: TestServer = { app: setup.app, deps: setup.deps, close: async () => undefined };
    const org = await createTestOrg(testServerLike, "fed");
    const self = await withTenantTx(setup.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId));

    const peers: Record<
      string,
      { domainId: string; leaf: TestLeafCert; keys: { publicKey: string; privateKey: string } }
    > = {};
    for (const spec of peerSpecs) {
      const domainId = randomUUID();
      const leaf = issueLeafCert(ca, { name: spec.key, sanUri: federationPeerSanUri(domainId) });
      const keys = generateEd25519KeypairB64();
      await withTenantTx(setup.deps.db, org.orgId, (tx) =>
        pairPeer(tx, {
          orgId: org.orgId,
          domainId,
          name: spec.key,
          role: spec.role ?? "outpost",
          publicKey: keys.publicKey
        })
      );
      peers[spec.key] = { domainId, leaf, keys };
    }
    return { orgId: org.orgId, selfDomainId: self.domainId, adminToken: org.adminToken, peers };
  }

  it("valid peer cert (SAN URI resolves to a registered peer) -> federation request succeeds", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem,
      cert: setup.peers["child-a"]!.leaf.certPem,
      key: setup.peers["child-a"]!.leaf.keyPem
    });

    expect(res.status).toBe(200);
    expect((res.json as { header: { peerDomainId: string } }).header.peerDomainId).toBe(
      setup.peers["child-a"]!.domainId
    );
  });

  it("REJECTS: no client certificate presented at all", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem
      // no cert/key
    });

    expect(res.status).toBe(401);
  });

  it("REJECTS: a client certificate signed by an untrusted (different) CA", async () => {
    const ca = createTestCa();
    const rogueCa = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    // A cert with the RIGHT SAN URI (the registered peer's real domain id) but signed by a CA the
    // server does not trust — proves CA trust is actually checked, not just SAN-URI plausibility.
    const rogueLeaf = issueLeafCert(rogueCa, {
      name: "rogue",
      sanUri: federationPeerSanUri(setup.peers["child-a"]!.domainId)
    });

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem,
      cert: rogueLeaf.certPem,
      key: rogueLeaf.keyPem
    });

    expect(res.status).toBe(401);
  });

  it("REJECTS: a valid-CA cert whose SAN URI domain id is not a registered peer", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    const strangerLeaf = issueLeafCert(ca, {
      name: "stranger",
      sanUri: federationPeerSanUri(randomUUID()) // never paired
    });

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem,
      cert: strangerLeaf.certPem,
      key: strangerLeaf.keyPem
    });

    expect(res.status).toBe(403);
  });

  it("REJECTS: a REVOKED cert (on the CRL) — proves CRL enforcement is real", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);

    revokeLeafCert(ca, setup.peers["child-a"]!.leaf);
    const crl = generateCrl(ca);
    const real = await bootServer(mtlsEnvFor(ca, { crl }));

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem,
      cert: setup.peers["child-a"]!.leaf.certPem,
      key: setup.peers["child-a"]!.leaf.keyPem
    });

    expect(res.status).toBe(401);
  });

  it("MISCONFIGURATION: CA file missing -> boot throws (fail-closed, never falls back to plain HTTP)", async () => {
    const ca = createTestCa();
    const serverLeaf = issueLeafCert(ca, { name: "server" });

    expect(() =>
      loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        SCP_FEDERATION_SERVER_MTLS_CA_FILE: "/nonexistent/path/ca.crt",
        SCP_FEDERATION_SERVER_MTLS_CERT_FILE: serverLeaf.certFile,
        SCP_FEDERATION_SERVER_MTLS_KEY_FILE: serverLeaf.keyFile
      })
    ).toThrow();
  });

  it("MISCONFIGURATION: only some of ca/cert/key set -> boot throws", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        SCP_FEDERATION_SERVER_MTLS_CA_FILE: "/some/ca.crt"
        // cert/key omitted
      })
    ).toThrow();
  });

  it("/imports: valid cert but exporterDomainId != cert domain id -> import PROCEEDS, Decision recorded (SHOULD, advisory)", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "cert-peer" }, { key: "claimed-exporter" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    const header = {
      formatVersion: 1 as const,
      kind: "sync" as const,
      exporterDomainId: setup.peers["claimed-exporter"]!.domainId,
      peerDomainId: setup.selfDomainId,
      sinceSequence: 0,
      throughSequence: 0,
      exportedAt: new Date().toISOString()
    };
    const entries: unknown[] = [];
    const checksum = computeBundleChecksum({ header, entries });
    const bundleSignature = signBundleChecksum(setup.peers["claimed-exporter"]!.keys.privateKey, checksum);
    const bundle = { header, entries, checksum, bundleSignature };

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/imports",
      body: bundle,
      token: setup.adminToken,
      ca: ca.caCrtPem,
      // The TLS-verified transport peer is "cert-peer" — DIFFERENT from the bundle's own claimed
      // exporterDomainId ("claimed-exporter"), which is what the bundle's signature actually
      // verifies against.
      cert: setup.peers["cert-peer"]!.leaf.certPem,
      key: setup.peers["cert-peer"]!.leaf.keyPem
    });

    // SHOULD, not MUST (ADR-0001 §5, v1): the mismatch does NOT block the import.
    expect(res.status).toBe(200);

    const decisionRows = await withTenantTx(real.deps.db, setup.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.kind, "federation_mtls_exporter_binding"))
    );
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]!.subjectId).toBe(setup.peers["cert-peer"]!.domainId);
    expect(decisionRows[0]!.verdict).toBe("warn");
    expect(decisionRows[0]!.inputContext).toMatchObject({
      mtlsPeerDomainId: setup.peers["cert-peer"]!.domainId,
      exporterDomainId: setup.peers["claimed-exporter"]!.domainId
    });
  });

  it("air-gap file transport (direct repo call, HTTP-independent) works unchanged with in-app mTLS enabled", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    // mTLS IS enabled on this server's config — proving exportSyncBundle (what `scp federation
    // export` calls) neither knows nor cares, since it takes no `config`/`app` parameter at all.
    const real = await bootServer(mtlsEnvFor(ca));

    const bundle = await withTenantTx(real.deps.db, setup.orgId, (tx) =>
      exportSyncBundle(tx, setup.orgId, "child-a", 0)
    );

    expect(bundle.header.peerDomainId).toBe(setup.peers["child-a"]!.domainId);
    expect(bundle.checksum).toBeTruthy();
    expect(bundle.bundleSignature).toBeTruthy();
  });

  it("in-app mTLS ENABLED: a no-client-cert request to a NON-transport route still succeeds (mTLS does not brick normal clients / k8s probes)", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const real = await bootServer(mtlsEnvFor(ca));

    // /healthz is the k8s liveness/readiness probe path — no auth, and critically NO client cert.
    // Under `requestCert: true, rejectUnauthorized: false` the TLS handshake still completes for a
    // certless client, and /healthz never calls the federation mTLS gate, so it must answer 200.
    // If this failed, enabling in-app mTLS would take down every probe (and every browser/CLI
    // client that never presents a client cert) — the whole point of `rejectUnauthorized: false`.
    const health = await httpsGet({ port: real.port, path: "/healthz", ca: ca.caCrtPem });
    expect(health.status).toBe(200);

    // An UNGATED authenticated route (GET /api/v1/federation/self) with a valid bearer token but NO
    // client cert. Only the three transport routes require a cert; a normal client on any other
    // route must not be rejected for lacking one. 401 would mean "refused for missing cert/auth" —
    // which must not happen for a valid token on an ungated route (200 if authorized, 403 at most).
    const self = await httpsGet({
      port: real.port,
      path: "/api/v1/federation/self",
      ca: ca.caCrtPem,
      token: setup.adminToken
    });
    expect(self.status).not.toBe(401);
  });

  it("mTLS DISABLED (default): plain HTTP works, no client certificate required — no regression", async () => {
    // No CA/certs needed at all for this scenario — the peer just needs a placeholder public key.
    const setup = await bootServer(); // {} -> federationServerMtls unset
    const testServerLike: TestServer = { app: setup.app, deps: setup.deps, close: async () => undefined };
    const org = await createTestOrg(testServerLike, "plain");
    await withTenantTx(setup.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId));
    await withTenantTx(setup.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId: randomUUID(),
        name: "plain-child",
        role: "outpost",
        publicKey: generateEd25519KeypairB64().publicKey
      })
    );

    const res = await httpPost(
      setup.port,
      "/api/v1/federation/exports",
      { peer: "plain-child", sinceSequence: 0 },
      org.adminToken
    );

    expect(res.status).toBe(200);
  });

  it("expired CRL + crlHardFailOnExpiry=true -> boot throws (refuses to trust a stale revocation list)", async () => {
    const ca = createTestCa();
    const expiredCrl = generateCrl(ca, { nextUpdate: "20200101000000Z" });

    expect(() =>
      loadConfig({
        DATABASE_URL: testDatabaseUrl(),
        ...mtlsEnvFor(ca, { crl: expiredCrl, crlHardFailOnExpiry: true })
      })
    ).toThrow();
  });

  it("expired CRL + crlHardFailOnExpiry=false (default) -> boot succeeds, CA-trust still enforced, valid cert still accepted", async () => {
    const ca = createTestCa();
    const setup = await setupOrgWithPeers(ca, [{ key: "child-a" }]);
    const expiredCrl = generateCrl(ca, { nextUpdate: "20200101000000Z" });

    // Must NOT throw despite the expired CRL — the "warn and continue" default.
    const real = await bootServer(mtlsEnvFor(ca, { crl: expiredCrl, crlHardFailOnExpiry: false }));

    const res = await httpsPost({
      port: real.port,
      path: "/api/v1/federation/exports",
      body: { peer: "child-a", sinceSequence: 0 },
      token: setup.adminToken,
      ca: ca.caCrtPem,
      cert: setup.peers["child-a"]!.leaf.certPem,
      key: setup.peers["child-a"]!.leaf.keyPem
    });

    // A perfectly valid, non-revoked cert is still accepted — the (stale, dropped) CRL degraded
    // only revocation enforcement, not CA-trust verification.
    expect(res.status).toBe(200);
  });
});

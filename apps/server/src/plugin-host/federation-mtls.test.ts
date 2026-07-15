import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubprocessPluginHost } from "./host.js";

// `vi.mock` factories are hoisted above imports by Vitest, and ESM named exports can't be
// `vi.spyOn`'d directly ("Module namespace is not configurable") — re-exporting a
// `vi.fn(actual.spawn)` wrapper (same pattern as host.test.ts) is the supported way to observe
// what `host.ts` actually passed a spawned child while still spawning REAL children.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * M8 hardening (DESIGN.md §13, BUILD_AND_TEST.md §8 M8 item 6, "Federation mTLS transport
 * identity") — SECURITY-SENSITIVE: proves `federation-https` genuinely presents a client
 * certificate over a real TLS handshake, and that a peer without a valid one is rejected. Not a
 * unit test of the Agent-construction code in isolation — this spawns a REAL `federation-https`
 * subprocess (`SubprocessPluginHost`) and drives it against a REAL `node:https` server requiring
 * (`requestCert: true`) and verifying (`rejectUnauthorized: true`) client certificates, exactly the
 * posture a real commander domain's `federation-https` server-side listener would run.
 *
 * No Postgres needed (this is entirely plugin-host + subprocess + a loopback TLS server), so this
 * lives under `pnpm test`, not the Testcontainers integration suite — same tier as
 * `plugin-host/host.test.ts`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "test-support/mtls-fixtures");

const CA_CRT = readFileSync(path.join(FIXTURES, "ca.crt"));
const SERVER_CRT = path.join(FIXTURES, "server.crt");
const SERVER_KEY = path.join(FIXTURES, "server.key");
const CLIENT_GOOD_CRT = path.join(FIXTURES, "client-good.crt");
const CLIENT_GOOD_KEY = path.join(FIXTURES, "client-good.key");
const CLIENT_BAD_CRT = path.join(FIXTURES, "client-bad.crt");
const CLIENT_BAD_KEY = path.join(FIXTURES, "client-bad.key");
const CA_FILE = path.join(FIXTURES, "ca.crt");

interface TestServerHandle {
  baseUrl: string;
  /** Whether the last accepted-at-the-TLS-layer request's client certificate was verified as
   *  `authorized` by Node's own TLS stack against the server's configured `ca`. */
  lastRequestAuthorized: boolean | undefined;
  close(): Promise<void>;
}

/** A real HTTPS server requiring AND verifying client certificates — `rejectUnauthorized: true`
 *  means Node's TLS layer itself refuses the handshake for any peer that doesn't present a
 *  certificate signed by `ca`, before this server's request handler ever runs. Responds to any
 *  request with a minimal, well-formed `.scpbundle` body so a successfully-authenticated
 *  `federation-https` `pull()` call has something valid to parse. */
function startTestServer(): Promise<TestServerHandle> {
  return new Promise((resolve, reject) => {
    let lastRequestAuthorized: boolean | undefined;
    const server = https.createServer(
      {
        cert: readFileSync(SERVER_CRT),
        key: readFileSync(SERVER_KEY),
        ca: CA_CRT,
        requestCert: true,
        rejectUnauthorized: true
      },
      (req, res) => {
        lastRequestAuthorized = (req.socket as unknown as { authorized?: boolean }).authorized;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            header: { exporterDomainId: "parent-domain", throughSequence: 1 },
            entries: [],
            checksum: "test-checksum",
            bundleSignature: "test-signature"
          })
        );
      }
    );
    server.on("tlsClientError", () => {
      // Expected for the "bad cert" / "no cert" test cases — the handshake itself is refused
      // before any HTTP request exists. Nothing to do here; the client side observes the failure.
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `https://127.0.0.1:${port}`,
        get lastRequestAuthorized() {
          return lastRequestAuthorized;
        },
        close: () =>
          new Promise<void>((res) => server.close(() => res()))
      });
    });
    server.on("error", reject);
  });
}

let host: SubprocessPluginHost | undefined;
let testServer: TestServerHandle | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  await testServer?.close();
  testServer = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("federation-https mTLS client certificate (M8 hardening)", () => {
  it("presents a client certificate signed by the trusted CA — the server accepts the TLS handshake and the pull() call succeeds", async () => {
    testServer = await startTestServer();
    vi.stubEnv("SCP_FEDERATION_MTLS_CERT_FILE", CLIENT_GOOD_CRT);
    vi.stubEnv("SCP_FEDERATION_MTLS_KEY_FILE", CLIENT_GOOD_KEY);
    vi.stubEnv("SCP_FEDERATION_MTLS_CA_FILE", CA_FILE);

    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id: "federation-mtls-good",
        module: "federation-https",
        orgId: "org-1",
        domainId: "domain-1",
        config: { commanderBaseUrl: testServer.baseUrl, selfPeerName: "outpost-domain-test" }
      }
    ]);

    const segments = await host
      .federationTransport("federation-mtls-good")
      .pull({ domainId: "parent-domain", sequence: 0 });

    expect(segments).toHaveLength(1);
    expect(segments[0]!.originDomainId).toBe("parent-domain");
    // The definitive proof this was a REAL mTLS handshake, not just "the connection happened to
    // work": Node's own TLS stack marked the peer certificate as verified against `ca`.
    expect(testServer.lastRequestAuthorized).toBe(true);
  });

  it("REJECTS: no client certificate configured — the TLS handshake itself fails, never reaching the application layer", async () => {
    testServer = await startTestServer();
    // Deliberately NOT stubbing any SCP_FEDERATION_MTLS_* env var — the pre-M8 default (and any
    // deployment where an operator hasn't configured mTLS for this peer).

    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id: "federation-mtls-none",
        module: "federation-https",
        orgId: "org-1",
        domainId: "domain-1",
        config: { commanderBaseUrl: testServer.baseUrl, selfPeerName: "outpost-domain-test" }
      }
    ]);

    await expect(
      host.federationTransport("federation-mtls-none").pull({ domainId: "parent-domain", sequence: 0 })
    ).rejects.toThrow();
    // No request the server's handler ever ran ever got authorized — the socket was refused at
    // the TLS layer, before any HTTP semantics existed.
    expect(testServer.lastRequestAuthorized).toBeUndefined();
  });

  it("REJECTS: a client certificate NOT signed by the trusted CA (an untrusted/attacker-controlled cert) — the TLS handshake fails", async () => {
    testServer = await startTestServer();
    vi.stubEnv("SCP_FEDERATION_MTLS_CERT_FILE", CLIENT_BAD_CRT);
    vi.stubEnv("SCP_FEDERATION_MTLS_KEY_FILE", CLIENT_BAD_KEY);
    vi.stubEnv("SCP_FEDERATION_MTLS_CA_FILE", CA_FILE);

    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id: "federation-mtls-bad",
        module: "federation-https",
        orgId: "org-1",
        domainId: "domain-1",
        config: { commanderBaseUrl: testServer.baseUrl, selfPeerName: "outpost-domain-test" }
      }
    ]);

    await expect(
      host.federationTransport("federation-mtls-bad").pull({ domainId: "parent-domain", sequence: 0 })
    ).rejects.toThrow();
    expect(testServer.lastRequestAuthorized).toBeUndefined();
  });

  it("module-identity gate: a NON-federation-https instance never receives the mTLS env vars even if the operator has them set process-wide", async () => {
    const childProcess = await import("node:child_process");
    const spawnSpy = vi.mocked(childProcess.spawn);
    spawnSpy.mockClear();
    vi.stubEnv("SCP_FEDERATION_MTLS_CERT_FILE", CLIENT_GOOD_CRT);
    vi.stubEnv("SCP_FEDERATION_MTLS_KEY_FILE", CLIENT_GOOD_KEY);
    vi.stubEnv("SCP_FEDERATION_MTLS_CA_FILE", CA_FILE);

    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      { id: "not-federation", module: "fake-executor", orgId: "org-1", domainId: "domain-1" }
    ]);

    const spawnCall = spawnSpy.mock.calls.find(
      (call) => (call[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.SCP_PLUGIN_INSTANCE_ID === "not-federation"
    );
    const env = (spawnCall?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty("SCP_FEDERATION_MTLS_CERT_FILE");
    expect(env).not.toHaveProperty("SCP_FEDERATION_MTLS_KEY_FILE");
    expect(env).not.toHaveProperty("SCP_FEDERATION_MTLS_CA_FILE");
  });
});

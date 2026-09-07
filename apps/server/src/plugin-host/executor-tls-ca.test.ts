import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/** `SCP_EXECUTOR_TLS_CA_FILE` — SECURITY-SENSITIVE. See docs/plugin-host.md §31. */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "test-support/mtls-fixtures");
/** Signed by `ca.crt`, CN=localhost with SAN DNS:localhost + IP:127.0.0.1 — i.e. a certificate that
 *  is perfectly valid but chains to a CA no system trust store has ever heard of. Exactly the shape
 *  a bundled or on-prem execution system presents. */
const SERVER_CRT = path.join(FIXTURES, "server.crt");
const SERVER_KEY = path.join(FIXTURES, "server.key");
const CA_FILE = path.join(FIXTURES, "ca.crt");

interface TestServerHandle {
  baseUrl: string;
  host: string;
  requestCount: number;
  close: () => Promise<void>;
}

/** A plain HTTPS server presenting the privately-signed cert. It does NOT request a client
 *  certificate — this is about verifying the SERVER, which is the direction executor traffic runs. */
async function startArgoLikeServer(): Promise<TestServerHandle> {
  let requestCount = 0;
  return await new Promise<TestServerHandle>((resolve, reject) => {
    const server = https.createServer(
      { cert: readFileSync(SERVER_CRT), key: readFileSync(SERVER_KEY) },
      (req, res) => {
        requestCount += 1;
        // Enough of the Argo Workflows API for `status()` to resolve: a workflow with a phase.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            metadata: { name: "wf-1" },
            status: { phase: "Succeeded", startedAt: "2026-08-28T00:00:00Z" }
          })
        );
      }
    );
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `https://127.0.0.1:${port}`,
        host: "127.0.0.1",
        get requestCount() {
          return requestCount;
        },
        close: () => new Promise<void>((res) => server.close(() => res()))
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

async function startArgoPlugin(serverUrl: string, allowedHost: string): Promise<void> {
  host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
  await host.start([
    {
      id: "argo-tls",
      module: "argo-workflows",
      orgId: "org-1",
      scopeKey: "domain-1",
      // The operator's per-instance allowlist — a tenant-plane module reaches a private address
      // only through this, never by asking.
      allowedHosts: [allowedHost],
      // Both layers, as a real in-cluster executor needs. See docs/plugin-host.md §32.
      allowInternalEgress: true,
      config: { serverUrl, namespace: "argo" }
    }
  ]);
}

/** Drives one real request through the plugin. Returns the error message when the call fails. */
async function statusCall(): Promise<{ ok: boolean; error?: string }> {
  try {
    await host!.executor("argo-tls").status({ externalId: "wf-1" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

describe("SCP_EXECUTOR_TLS_CA_FILE — executor TLS trust", () => {
  it("1. WITHOUT the CA: the request FAILS, and the server is never reached", async () => {
    // THE LOAD-BEARING CASE. This is the pre-existing behaviour and it must survive the feature: a
    // privately-signed endpoint is refused by default. Asserted together with `requestCount === 0`,
    // because "the call threw" alone would also be satisfied by a bug that reached the server and
    // then failed parsing — the point is that the HANDSHAKE stopped it.
    testServer = await startArgoLikeServer();
    await startArgoPlugin(testServer.baseUrl, testServer.host);

    const result = await statusCall();

    expect(result.ok).toBe(false);
    // Why the assertion is shaped this way, despite looking weak. See docs/plugin-host.md §33.
    expect(result.error).toMatch(/fetch failed/);
    expect(testServer.requestCount).toBe(0);
  });

  it("2. WITH the CA: the same request succeeds over a real handshake", async () => {
    testServer = await startArgoLikeServer();
    vi.stubEnv("SCP_EXECUTOR_TLS_CA_FILE", CA_FILE);
    await startArgoPlugin(testServer.baseUrl, testServer.host);

    const result = await statusCall();

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // The server actually served it — the handshake completed rather than the client inventing a
    // response.
    expect(testServer.requestCount).toBeGreaterThan(0);
  });

  it("3. A DIFFERENT private CA does NOT make the endpoint trusted — this ADDS an anchor, never disables the check", async () => {
    // The distinction the whole design rests on. See docs/plugin-host.md §34.
    testServer = await startArgoLikeServer();
    vi.stubEnv("SCP_EXECUTOR_TLS_CA_FILE", path.join(FIXTURES, "client-bad.crt"));
    await startArgoPlugin(testServer.baseUrl, testServer.host);

    const result = await statusCall();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fetch failed/); // differential vs case 2 — see case 1's note
    expect(testServer.requestCount).toBe(0);
  });

  it("4. An unreadable CA path REFUSES TO BOOT rather than degrading to system roots", async () => {
    // A bundle that silently fails to load looks identical to one that loaded and did not match, and
    // the operator would spend the afternoon debugging the endpoint instead of the path. Failing at
    // start is the whole value.
    testServer = await startArgoLikeServer();
    vi.stubEnv("SCP_EXECUTOR_TLS_CA_FILE", path.join(FIXTURES, "does-not-exist.crt"));

    await expect(startArgoPlugin(testServer.baseUrl, testServer.host)).rejects.toThrow();
  });

  it("5. UNSET is byte-for-byte the previous behaviour — no dispatcher, system trust only", async () => {
    // The additive property. Every existing deployment runs this path, and a publicly-signed BYO
    // executor must keep verifying exactly as it did. Proved negatively here (the private cert is
    // still refused with no env set) because a test asserting a PUBLIC endpoint verifies would need
    // the internet, which this suite never touches.
    testServer = await startArgoLikeServer();
    delete process.env.SCP_EXECUTOR_TLS_CA_FILE;
    await startArgoPlugin(testServer.baseUrl, testServer.host);

    const result = await statusCall();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/fetch failed/); // differential vs case 2 — see case 1's note
    expect(testServer.requestCount).toBe(0);
  });
});

describe("the census: no verification bypass exists on the plugin TLS path", () => {
  it("neither the subprocess entry nor the host can disable certificate verification", () => {
    // A GUARD, not a description. See docs/plugin-host.md §35.
    for (const file of ["subprocess-entry.ts", "host.ts"]) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      const withoutComments = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(withoutComments, `${file} disables TLS verification`).not.toMatch(
        /rejectUnauthorized\s*:\s*false/
      );
      expect(withoutComments, `${file} sets NODE_TLS_REJECT_UNAUTHORIZED`).not.toContain(
        "NODE_TLS_REJECT_UNAUTHORIZED"
      );
    }
  });

  it("the system trust store is EXTENDED, not replaced — `rootCertificates` stays in the trust set", () => {
    // A SOURCE GUARD, and it is one on purpose. See docs/plugin-host.md §36.
    const source = readFileSync(path.join(__dirname, "subprocess-entry.ts"), "utf8");
    expect(source).toContain("rootCertificates");
    expect(source).toMatch(/ca:\s*\[\s*\.\.\.rootCertificates/);
  });

  it("the CA is never read from tenant-writable config — only from the operator's env", () => {
    // Server-provenance. `config` on a plugin instance comes from the executor binding, which a
    // tenant can author; a CA reference living there would let a tenant nominate the authority that
    // vouches for the endpoint it is also nominating.
    const source = readFileSync(path.join(__dirname, "subprocess-entry.ts"), "utf8");
    expect(source).toContain("process.env.SCP_EXECUTOR_TLS_CA_FILE");
    expect(source).not.toMatch(/config\.(tlsCa|caBundle|caCert|insecure|skipVerify)/);
  });
});

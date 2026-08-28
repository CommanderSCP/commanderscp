import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubprocessPluginHost } from "./host.js";

/**
 * `SCP_EXECUTOR_TLS_CA_FILE` — SECURITY-SENSITIVE: proves an executor plugin can verify a
 * PRIVATELY-SIGNED endpoint when (and only when) the operator supplies the CA, over a REAL TLS
 * handshake.
 *
 * ============================================================================================
 * WHAT THIS CLOSES
 * ============================================================================================
 * The bundled Argo Workflows server listens on 2746 and serves HTTPS with a SELF-SIGNED certificate
 * (its vendored Deployment's readiness probe uses `scheme: HTTPS`). Plugin traffic had no CA-trust
 * path at all — the subprocess only ever built a custom dispatcher for `federation-https`'s client
 * certificate — so every request to it failed verification and the coordinated-test path was
 * unreachable on the bundled tier even with the NetworkPolicy open (#321 opened the network; this
 * opens the trust).
 *
 * ============================================================================================
 * WHY IT IS TESTED THIS WAY
 * ============================================================================================
 * Not a unit test of Agent construction. Asserting "we passed a `ca` option" would pass just as
 * happily if undici ignored it, if the PEM never loaded, or if verification had been switched off
 * entirely — and the last of those is the failure this feature must never have. So this spawns a
 * REAL executor subprocess through `SubprocessPluginHost` and drives it against a REAL `node:https`
 * server presenting a privately-signed certificate. The verdict is the handshake itself.
 *
 * The negative case (case 1) is the load-bearing one and runs FIRST: without the CA the request must
 * FAIL. If it passed, every other assertion here would be meaningless — a build that trusts
 * everything also "succeeds" at trusting this server.
 *
 * `argo-workflows` is the module under test rather than a synthetic one because it is the executor
 * that forced the feature, and because it is a TENANT-plane module: it is NOT in
 * `OPERATOR_PLANE_MODULES`, so it reaches a loopback address only via the operator's
 * `allowedHosts` allowlist — exercising the egress guard and the TLS trust together, in the
 * arrangement a real deployment uses.
 */

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
      // BOTH ADR-0003 layers, which is what a real in-cluster executor needs: the operator's
      // per-instance allowlist AND the execution system's own `allowInternalEgress` declaration.
      // 127.0.0.1 is a private address, so the allowlist alone is not enough — the internal-IP
      // deny-list refuses it independently. Setting only one was how the first run of this file
      // failed, with an egress error the TLS assertions would have happily read as "the handshake
      // refused it" had they not matched on the certificate text.
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
    // WHY THE ASSERTION IS SHAPED LIKE THIS, since it is the weakest-looking part of the file.
    // Node's `fetch` reports a TLS verification failure as the bare string "fetch failed" and hangs
    // the real reason off `err.cause`, which the plugin-host RPC boundary does not serialize — so
    // there is no certificate text to match on here.
    //
    // The proof is therefore DIFFERENTIAL, not textual: case 2 runs the SAME server, SAME plugin,
    // SAME allowlist and SAME ref, differing ONLY in `SCP_EXECUTOR_TLS_CA_FILE`, and SUCCEEDS. One
    // variable, opposite outcomes.
    //
    // Matching the message still does real work — it excludes the two ways this file has ALREADY
    // been green for the wrong reason. First draft: a malformed ref threw before any socket opened.
    // Second: the egress guard refused 127.0.0.1 ("not in the configured allowedHosts allowlist")
    // because the allowlist carried a port and `allowInternalEgress` was unset. Both produced a
    // failing call with `requestCount === 0` — exactly what a naive `expect(ok).toBe(false)` wants —
    // and neither had anything to do with TLS.
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
    // The distinction the whole design rests on. If the implementation had reached for
    // `rejectUnauthorized: false` — or if supplying any bundle degraded to "trust anything" — this
    // case would pass and the feature would be a verification bypass wearing a CA's clothes.
    // `client-bad.crt` is a real certificate from a DIFFERENT issuer, so trusting it must leave the
    // server's own chain unverifiable.
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
    // A GUARD, not a description. The reason this feature is a CA bundle rather than a skip flag is
    // that a skip flag would inevitably be reachable from tenant-writable binding config. This fails
    // the moment someone adds the easier option, which is exactly when it is most tempting.
    //
    // Read with `readFileSync` over the source text rather than grep: two of this repo's files carry
    // literal NUL bytes and are silently dropped from recursive greps, and a security census that
    // can return a false zero is worse than none.
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
    // A SOURCE GUARD, and it is one on purpose — stated plainly because a reader deserves to know
    // which kind of claim this is.
    //
    // undici's `ca` option REPLACES the default trust store rather than adding to it, so passing the
    // operator's bundle alone would make every publicly-signed BYO executor stop verifying. The
    // bundled-backend cases above would all still pass, because they use a private CA either way:
    // this is precisely a regression no test in this file can see.
    //
    // MEASURED: removing `...rootCertificates` from the `ca` array left all 7 behavioural cases
    // GREEN. Proving the positive behaviourally needs a publicly-signed endpoint, i.e. the internet,
    // which this suite never touches. So the choice is this guard or nothing, and nothing means the
    // regression ships silently and surfaces as "our executor stopped working after an upgrade".
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

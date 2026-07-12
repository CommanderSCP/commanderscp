import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestCa,
  generateCrl,
  issueLeafCert,
  opensslAvailable,
  revokeLeafCert
} from "./test-support/mtls-pki.js";

/**
 * M9.3 (ADR-0001 §8, "CRL reload without a full restart") — proves the actual mechanism
 * `main.ts`'s `SIGHUP` handler relies on: `tls.Server#setSecureContext({ca, cert, key, crl})`
 * atomically swaps in a fresh CRL for all FUTURE handshakes on an already-listening server,
 * without restarting it.
 *
 * SCOPE NOTE (called out explicitly, not silently): this test builds a raw `https.createServer`
 * directly rather than spawning the compiled `scpd` binary and sending it a real `SIGHUP` OS
 * signal — doing the latter would require a child-process integration test in the style of
 * `test-support/cli-runner.ts`, a materially bigger investment for the same proof. What's
 * verified here is the load-bearing part: that `setSecureContext` genuinely changes which
 * certificates authenticate on the NEXT connection. `main.ts`'s `SIGHUP` wiring itself (re-running
 * `loadFederationServerMtlsConfig` and calling this same method) is straightforward glue on top,
 * not independently retested.
 */
describe.skipIf(!opensslAvailable())("federation server mTLS — CRL live reload mechanism", () => {
  let server: https.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("a cert accepted before reload is rejected after setSecureContext loads a CRL revoking it", async () => {
    const ca = createTestCa();
    const serverLeaf = issueLeafCert(ca, { name: "listener" });
    const peer = issueLeafCert(ca, { name: "peer" });

    let lastAuthorized: boolean | undefined;
    server = https.createServer(
      {
        key: serverLeaf.keyPem,
        cert: serverLeaf.certPem,
        ca: ca.caCrtPem,
        requestCert: true,
        rejectUnauthorized: false
      },
      (req, res) => {
        lastAuthorized = (req.socket as unknown as { authorized?: boolean }).authorized;
        res.writeHead(200);
        res.end("ok");
      }
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const request = (): Promise<boolean | undefined> =>
      new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port,
            method: "GET",
            path: "/",
            ca: ca.caCrtPem,
            cert: peer.certPem,
            key: peer.keyPem,
            rejectUnauthorized: false,
            // A fresh connection (new TLS handshake) per call — never a pooled/reused socket from
            // a prior handshake, which would silently keep asserting the OLD `authorized` result
            // regardless of a secure-context reload in between.
            agent: false
          },
          (res) => {
            res.on("data", () => undefined);
            res.on("end", () => resolve(lastAuthorized));
          }
        );
        req.on("error", reject);
        req.end();
      });

    // Before reload: no CRL loaded at all yet — the peer's cert is CA-trusted and unrevoked.
    expect(await request()).toBe(true);

    // Revoke the peer's cert and mint a CRL reflecting it, then swap it in live.
    revokeLeafCert(ca, peer);
    const crl = generateCrl(ca);
    server.setSecureContext({
      ca: ca.caCrtPem,
      cert: serverLeaf.certPem,
      key: serverLeaf.keyPem,
      crl
    });

    // After reload, with NO restart: the SAME cert is now rejected on a new connection.
    expect(await request()).toBe(false);
  });
});

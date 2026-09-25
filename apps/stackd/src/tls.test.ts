import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer, connect } from "node:tls";
import { describe, expect, it } from "vitest";
import { mintSelfSignedCertificate } from "./tls.js";

/** The hand-written DER must be a certificate OpenSSL accepts AND a TLS client can pin. */
describe("mintSelfSignedCertificate", () => {
  const dnsNames = [
    "argo-server",
    "argo-server.scp-argo-workflows",
    "argo-server.scp-argo-workflows.svc",
    "argo-server.scp-argo-workflows.svc.cluster.local"
  ];
  const now = new Date("2026-09-24T00:00:00Z");
  const minted = mintSelfSignedCertificate({
    commonName: "argo-server.scp-argo-workflows.svc",
    dnsNames,
    validDays: 3650,
    now
  });
  const cert = new X509Certificate(minted.certPem);

  it("parses, is self-signed by its own key, and is a CA", () => {
    expect(cert.subject).toContain("CN=argo-server.scp-argo-workflows.svc");
    expect(cert.subject).toContain("O=CommanderSCP");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(true);
    expect(cert.checkPrivateKey(createPrivateKey(minted.keyPem))).toBe(true);
  });

  it("carries every name SCP may dial, and nothing else", () => {
    expect(cert.subjectAltName).toBe(dnsNames.map((d) => `DNS:${d}`).join(", "));
    for (const d of dnsNames) expect(cert.checkHost(d)).toBe(d);
    expect(cert.checkHost("argo-server.other")).toBeUndefined();
  });

  it("is valid for ten years from issue", () => {
    expect(new Date(cert.validFrom).toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2036);
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
  });

  it("a TLS client that pins it as its CA completes a handshake against a server using it", async () => {
    const server = createServer({ cert: minted.certPem, key: minted.keyPem }, (s) => s.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const s = connect(
          { host: "127.0.0.1", port, ca: minted.certPem, servername: dnsNames[2] },
          () => {
            let data = "";
            s.on("data", (d) => (data += d));
            s.on("end", () => resolve(data));
          }
        );
        s.on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      server.close();
    }
  });

  it("uses a fresh P-256 key each time (a rotation is a new key, never a reissue of the old)", () => {
    const again = mintSelfSignedCertificate({ commonName: "x", dnsNames: ["x"], validDays: 1 });
    const a = createPublicKey(minted.keyPem).export({ type: "spki", format: "der" });
    const b = createPublicKey(again.keyPem).export({ type: "spki", format: "der" });
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(createPrivateKey(again.keyPem).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });
});

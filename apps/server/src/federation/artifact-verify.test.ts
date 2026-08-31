/**
 * Unit wiring of `verifyAuthorizedArtifactSet`'s cosign-facing options (the @scp/cosign seam is
 * mocked — these prove the WIRING; the live cosign behavior rides the M15.5(c)/M17.4(b)
 * integration suites):
 *
 *   - PER-HOST TLS scoping: the `allowInsecureRegistry` predicate form grants cosign's
 *     `--allow-insecure-registry` for exactly the registry host each bound ref dials — mirroring
 *     skopeo's per-host `--…-tls-verify=false` (SCP_RELAY_INSECURE_HOSTS) — and NEVER for an
 *     unlisted or hostless ref. This cannot be observed live against a Testcontainers loopback
 *     registry: cosign's go-containerregistry auto-downgrades loopback registry hosts to HTTP
 *     with or without the flag, so the negative case only shows on non-loopback hosts.
 *   - PER-INVOCATION subprocess env: `cosignEnv` (e.g. a scratch `DOCKER_CONFIG` for credentialed
 *     source registries) reaches the cosign invocation as its `env` option — the multi-tenant
 *     alternative to a process-global `process.env` mutation, which would leak one org's registry
 *     auth into every concurrently spawned subprocess.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ArtifactRef } from "@scp/schemas";

vi.mock("@scp/cosign", () => ({
  verifyImageSignature: vi.fn(async () => true),
  verifyBlobDetached: vi.fn(() => ({ ok: true, detail: "mocked" })),
  makeScratchDir: vi.fn(async () => {
    throw new Error("makeScratchDir must not be reached by these OCI-only wiring tests");
  })
}));

import { verifyImageSignature } from "@scp/cosign";
import {
  LocationRegistryReader,
  verifyAuthorizedArtifactSet,
  type ArtifactRegistryReader
} from "./artifact-verify.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const INSECURE_HOST = "gitea.outpost.local:3000";
const SECURE_HOST = "registry.example.com";

const artifactA: ArtifactRef = { type: "oci", digest: DIGEST_A };
const artifactB: ArtifactRef = { type: "oci", digest: DIGEST_B };

/** Resolves A on the (allowlisted-insecure) local host, B on the TLS host. */
const reader: ArtifactRegistryReader = {
  resolveOci: async (artifact) =>
    artifact.digest === DIGEST_A
      ? `${INSECURE_HOST}/scp/app@${DIGEST_A}`
      : `${SECURE_HOST}/scp/app@${DIGEST_B}`,
  resolveBlob: async () => null
};

const mockedVerify = vi.mocked(verifyImageSignature);

function callOptions(): {
  ref: string;
  allowInsecureRegistry?: boolean;
  env?: NodeJS.ProcessEnv;
}[] {
  return mockedVerify.mock.calls.map(([ref, , options]) => ({
    ref,
    allowInsecureRegistry: options?.allowInsecureRegistry,
    env: options?.env
  }));
}

describe("verifyAuthorizedArtifactSet cosign wiring", () => {
  beforeEach(() => {
    mockedVerify.mockClear();
  });

  it("the allowInsecureRegistry PREDICATE grants TLS-off per registry host — listed host yes, unlisted host no", async () => {
    const insecureHosts = [INSECURE_HOST];
    const result = await verifyAuthorizedArtifactSet({
      artifacts: [artifactA, artifactB],
      cosignPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----",
      reader,
      allowInsecureRegistry: (host) => insecureHosts.includes(host.toLowerCase())
    });
    expect(result.ok).toBe(true);
    expect(callOptions()).toEqual([
      { ref: `${INSECURE_HOST}/scp/app@${DIGEST_A}`, allowInsecureRegistry: true, env: undefined },
      { ref: `${SECURE_HOST}/scp/app@${DIGEST_B}`, allowInsecureRegistry: false, env: undefined }
    ]);
  });

  it("a HOSTLESS ref never gets TLS-off, even from an allow-everything predicate (fail-secure)", async () => {
    const hostlessReader: ArtifactRegistryReader = {
      // No registry host component → the predicate is unanswerable → TLS stays on.
      resolveOci: async () => `app@${DIGEST_A}`,
      resolveBlob: async () => null
    };
    await verifyAuthorizedArtifactSet({
      artifacts: [artifactA],
      cosignPublicKeyPem: "mock-pem",
      reader: hostlessReader,
      allowInsecureRegistry: () => true
    });
    expect(callOptions()).toEqual([
      { ref: `app@${DIGEST_A}`, allowInsecureRegistry: false, env: undefined }
    ]);
  });

  it("the BOOLEAN form passes through unchanged (no production caller uses blanket `true` anymore — the M17.4(b) gate and the relay both use the per-host predicate)", async () => {
    await verifyAuthorizedArtifactSet({
      artifacts: [artifactA, artifactB],
      cosignPublicKeyPem: "mock-pem",
      reader,
      allowInsecureRegistry: true
    });
    expect(callOptions().map((c) => c.allowInsecureRegistry)).toEqual([true, true]);
    mockedVerify.mockClear();
    await verifyAuthorizedArtifactSet({
      artifacts: [artifactA],
      cosignPublicKeyPem: "mock-pem",
      reader
      // omitted → defaults to false
    });
    expect(callOptions().map((c) => c.allowInsecureRegistry)).toEqual([false]);
  });

  it("cosignEnv reaches every cosign invocation as PER-INVOCATION subprocess env (never via process.env)", async () => {
    const cosignEnv = { DOCKER_CONFIG: "/scratch/relay-12345/docker-config" };
    const before = process.env.DOCKER_CONFIG;
    await verifyAuthorizedArtifactSet({
      artifacts: [artifactA, artifactB],
      cosignPublicKeyPem: "mock-pem",
      reader,
      allowInsecureRegistry: () => false,
      cosignEnv
    });
    expect(callOptions().map((c) => c.env)).toEqual([cosignEnv, cosignEnv]);
    // The caller's env option must never have leaked into this process's own environment.
    expect(process.env.DOCKER_CONFIG).toBe(before);
  });
});

/**
 * The BLOB byte channel, fetched for real over loopback. `resolveBlob` classifies the URL's
 * addresses with the egress guard and then dials one of THEM — it no longer hands the hostname back
 * to `fetch`, which would resolve it a second time and reopen the DNS-rebinding window the guard
 * exists to close (see `plugin-host/egress-guard.ts`'s `createEgressPinRegistry`, where the pin is
 * proven at socket level). These cases keep that rewiring honest: the bytes still arrive, an absent
 * blob is still `null`, and an off-allowlist URL is still refused before any request.
 */
describe("LocationRegistryReader.resolveBlob (real loopback fetch)", () => {
  let server: Server;
  let base: string;
  let requestedPaths: string[];

  beforeAll(async () => {
    requestedPaths = [];
    server = createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      if (req.url === "/blobs/absent") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/blobs/fault") {
        // A registry 5xx that carries a large body — the response the reader throws on WITHOUT
        // reading. 1 MiB, because the teardown only stalls once the unread body outgrows undici's
        // buffering (a few hundred bytes close instantly and would fixture the bug away).
        const page = Buffer.alloc(1024 * 1024, 0x61);
        res.writeHead(500, { "content-length": String(page.length) });
        res.end(page);
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(req.url === "/blobs/sig" ? "detached-signature" : "sbom-bytes");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches the blob AND its detached signature from an allowlisted base", async () => {
    const reader = new LocationRegistryReader({ allowedBlobBaseUrls: [`${base}/blobs/`] });
    const resolved = await reader.resolveBlob({
      type: "blob",
      digest: DIGEST_A,
      location: `${base}/blobs/sbom.json`,
      signatureRef: `${base}/blobs/sig`
    } as ArtifactRef);

    expect(resolved?.bytes.toString("utf8")).toBe("sbom-bytes");
    expect(resolved?.signature).toBe("detached-signature");
    expect(requestedPaths).toContain("/blobs/sbom.json");
  });

  it("a 404 blob is ABSENT (null), not an error", async () => {
    const reader = new LocationRegistryReader({ allowedBlobBaseUrls: [`${base}/blobs/`] });
    await expect(
      reader.resolveBlob({
        type: "blob",
        digest: DIGEST_A,
        location: `${base}/blobs/absent`
      } as ArtifactRef)
    ).resolves.toBeNull();
  });

  it("a registry FAULT fails closed PROMPTLY — the unread response body must not hold the dial open", async () => {
    // The reader throws on a non-2xx without reading the body, and undici's `Agent.close()` waits
    // for in-flight requests: a body nobody reads never finishes, so the teardown hung until the
    // abandoned body was garbage-collected (measured on undici 7.29.0: 10/10 runs still pending
    // after 5s with this 1 MiB response). `pre-deploy-gate` calls the verifier with no timeout of
    // its own, so that turned a fail-closed verification error into an unbounded stall the
    // registry's response size gets to decide. The bound below is the assertion; the test timeout
    // is only the backstop for the "never settles" case.
    const reader = new LocationRegistryReader({ allowedBlobBaseUrls: [`${base}/blobs/`] });
    const startedAt = Date.now();
    await expect(
      reader.resolveBlob({
        type: "blob",
        digest: DIGEST_A,
        location: `${base}/blobs/fault`
      } as ArtifactRef)
    ).rejects.toThrow(/HTTP 500/);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("a location outside the operator-configured base is refused WITHOUT being fetched", async () => {
    const reader = new LocationRegistryReader({ allowedBlobBaseUrls: [`${base}/blobs/`] });
    const before = requestedPaths.length;
    await expect(
      reader.resolveBlob({
        type: "blob",
        digest: DIGEST_A,
        location: `${base}/elsewhere/secret`
      } as ArtifactRef)
    ).rejects.toThrow(/blob base URL/);
    expect(requestedPaths).toHaveLength(before);
  });
});

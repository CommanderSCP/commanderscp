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
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function callOptions(): { ref: string; allowInsecureRegistry?: boolean; env?: NodeJS.ProcessEnv }[] {
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

/**
 * Unit wiring of the M17.4(b) pre-deploy gate's TLS scoping: `runPreDeployArtifactGate` passes
 * `verifyAuthorizedArtifactSet` a PER-HOST `allowInsecureRegistry` predicate derived from
 * `SCP_ARTIFACT_INSECURE_HOSTS` — never the historical blanket `true`. The @scp verify seam is
 * mocked (this proves the WIRING; live cosign behavior rides the integration suites), and the
 * NEGATIVE case lives here deliberately: it cannot be observed live against a Testcontainers
 * loopback registry, because cosign's go-containerregistry auto-downgrades loopback registry
 * hosts to HTTP with or without the flag — see artifact-verify.test.ts, whose companion tests
 * prove a `false` predicate verdict reaches cosign as `allowInsecureRegistry: false` (TLS-ON
 * verification attempted).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/tenant-tx.js", () => ({
  withTenantTx: vi.fn(async (_db: unknown, _orgId: string, fn: (tx: never) => unknown) =>
    fn({} as never)
  )
}));
vi.mock("../federation/peers-repo.js", () => ({
  currentPeerCosignPublicKey: vi.fn(async () => "-----BEGIN PUBLIC KEY-----\nmock\n-----END PUBLIC KEY-----")
}));
vi.mock("../federation/artifact-verify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../federation/artifact-verify.js")>();
  return {
    ...actual, // keep the REAL parseRegistryHostList — the shared parse is under test too.
    verifyAuthorizedArtifactSet: vi.fn(async () => ({ ok: true, outcomes: [], failing: [] }))
  };
});
vi.mock("./decisions-repo.js", () => ({ insertDecision: vi.fn() }));
vi.mock("../audit/audit-repo.js", () => ({ appendAuditEvent: vi.fn() }));
vi.mock("./changes-repo.js", () => ({ markChangeReconcileBlocked: vi.fn() }));

import { verifyAuthorizedArtifactSet, type ArtifactRegistryReader } from "../federation/artifact-verify.js";
import { runPreDeployArtifactGate } from "./pre-deploy-gate.js";
import type { ChangeRow } from "./changes-repo.js";
import type { Db } from "../db/client.js";

const mockedVerify = vi.mocked(verifyAuthorizedArtifactSet);

const LISTED_HOST = "gitea.outpost.local:3000";
const UNLISTED_HOST = "registry.example.com";

/** A change carrying a verified cross-boundary manifest with one OCI artifact — the gated shape. */
const gatedChange = {
  objectId: "chg-1",
  importedFromDomain: "peer-1",
  sourceRef: {
    promotionManifest: { manifestVersion: "test" },
    promotedFromDomain: "dom-exporter",
    artifacts: [{ type: "oci", digest: `sha256:${"a".repeat(64)}` }]
  }
} as unknown as ChangeRow;

const nullReader: ArtifactRegistryReader = {
  resolveOci: async () => null,
  resolveBlob: async () => null
};

/** Run the gate and return the `allowInsecureRegistry` it wired into the verify call. */
async function capturedPredicate(): Promise<(host: string) => boolean> {
  await runPreDeployArtifactGate({} as Db, "org-1", gatedChange, nullReader);
  expect(mockedVerify).toHaveBeenCalledTimes(1);
  const allow = mockedVerify.mock.calls.at(0)?.[0].allowInsecureRegistry;
  // Never the historical blanket boolean — always the per-host predicate form.
  expect(typeof allow).toBe("function");
  return allow as (host: string) => boolean;
}

describe("runPreDeployArtifactGate TLS scoping (SCP_ARTIFACT_INSECURE_HOSTS)", () => {
  const savedEnv = process.env.SCP_ARTIFACT_INSECURE_HOSTS;

  beforeEach(() => {
    mockedVerify.mockClear();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
    else process.env.SCP_ARTIFACT_INSECURE_HOSTS = savedEnv;
  });

  it("grants TLS-off ONLY to listed hosts — an UNLISTED host gets TLS-ON verification (negative case)", async () => {
    process.env.SCP_ARTIFACT_INSECURE_HOSTS = ` ${LISTED_HOST.toUpperCase()} , other.host:5000 `;
    const allow = await capturedPredicate();
    // Listed (env entry trimmed + lowercased by the shared parse; probe host arrives lowercased
    // from ociRegistryHostOf): TLS-off granted.
    expect(allow(LISTED_HOST)).toBe(true);
    expect(allow("other.host:5000")).toBe(true);
    // THE NEGATIVE CASE: an unlisted host is refused TLS-off — cosign runs with full TLS
    // verification (artifact-verify.test.ts proves the false verdict reaches cosign as
    // `allowInsecureRegistry: false`).
    expect(allow(UNLISTED_HOST)).toBe(false);
  });

  it("UNSET env = TLS verification everywhere (secure default — no host gets TLS-off)", async () => {
    delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
    const allow = await capturedPredicate();
    expect(allow(LISTED_HOST)).toBe(false);
    expect(allow(UNLISTED_HOST)).toBe(false);
  });

  it("reads the env per gate invocation (operator config changes apply without restart-per-test)", async () => {
    process.env.SCP_ARTIFACT_INSECURE_HOSTS = LISTED_HOST;
    const first = await capturedPredicate();
    expect(first(LISTED_HOST)).toBe(true);
    mockedVerify.mockClear();
    delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
    const second = await capturedPredicate();
    expect(second(LISTED_HOST)).toBe(false);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { PromotionBundle } from "@scp/schemas";
import { generateKeyPair, resolveCosign } from "@scp/cosign";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange, getChangeRow } from "../coordination/changes-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { runPreDeployArtifactGate } from "../coordination/pre-deploy-gate.js";
import { putSecret } from "../secrets/secrets-repo.js";
import { ensureInstanceCosignKey, getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, initFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { getCursor } from "./cursors-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "./promotion-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import {
  RETRANS_RELAY_IMPORT_DECISION_KIND,
  RETRANS_RELAY_VALIDATE_DECISION_KIND,
  buildRelayTarball,
  importRelayTarball,
  relayDestPushSecretKey,
  relaySourceReadSecretKey,
  type RelayConfig
} from "./retrans-relay.js";

/**
 * M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2), end to end: THE M15.5(c) DoD suite
 * (BUILD_AND_TEST.md §8). Three REAL isolated federation domains (separate Postgres databases —
 * the same topology-faithful harness federation.integration.test.ts uses), TWO real `registry:2`
 * containers (source + destination), the REAL cosign and skopeo binaries.
 *
 *   commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C
 *        │  (metadata-only)          │        (the CDS crossing,        │
 *        └────.scpbundle (metadata, addressed to C)────────────────────┘
 *
 * Proven here, per the DoD:
 *  (a) FULL ROUND-TRIP — A exports a cosign-manifest-signed promotion (M17.3 E6) of an OCI image
 *      (cosign-signed by A's instance key at the SOURCE registry) + an SBOM blob; B (role:
 *      retrans) imports the .scpbundle (M17.4(a) verifies), relays: skopeo-pulls BY DIGEST from
 *      the source registry, VALIDATES with the M17.4 machinery, packages + cosign-signs the
 *      OCI-layout tarball; C imports the tarball: signature + checksums + local-authorized
 *      cross-check, pushes into the DEST registry by digest + re-inspects (install.sh pattern),
 *      records where the bytes landed — and C's UNCHANGED M17.4(a)+(b) gates pass end-to-end
 *      (the (b) gate is additionally shown to FAIL-CLOSE before the bytes landed).
 *  (b) TAMPER NEVER CROSSES — an artifact signed by the WRONG key at the source refuses the relay
 *      at B (block Decision `retrans-relay-validate` + hash-chained audit event, no tarball) and
 *      NOTHING of it reaches the destination registry; a tarball TAMPERED in CDS transit refuses
 *      at C (block Decision) with nothing pushed.
 *  (c) ALLOWLIST — a source host outside `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` is refused BEFORE any
 *      dial (the counting decoy server receives zero requests).
 *  (d) ROLE — a non-retrans instance refuses to run the relay (the ADR-0004 arm).
 *  (e) CREDS — the destination push credential is resolved from the EXISTING secrets vault
 *      (ADR-0019 §3 artifact-store class, per-registry key) against an AUTH-REQUIRING registry,
 *      and never appears in logs, Decisions, or audit events.
 *  (f) SOURCE CREDS + ENV ISOLATION — the SOURCE-read credential round-trip: the relay pull is
 *      refused by an auth-requiring source registry until `relay/source-read/<host>` is vaulted,
 *      then succeeds (skopeo pull AND cosign validate both authenticate via the per-invocation
 *      authfile/DOCKER_CONFIG); the password appears NOWHERE (stderr, Decisions, audit), and
 *      `process.env.DOCKER_CONFIG` is byte-identical before/during/after the run — sampled on an
 *      interval and with a CONCURRENT M17.4(b) pre-deploy verify (a different auth need) running
 *      unaffected: per-invocation subprocess env, never a process-global mutation.
 *  (g) TLS SCOPING — the validate pass grants cosign's `--allow-insecure-registry` ONLY to hosts
 *      in `SCP_RELAY_INSECURE_HOSTS` (per host, mirroring skopeo's `--…-tls-verify=false`); a
 *      plain-HTTP source NOT in the list is refused end-to-end with TLS verification on. (The
 *      cosign-side per-host wiring itself is unit-proven in artifact-verify.test.ts.)
 */

const sha256 = (buf: Buffer): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

/** Pre-generated bcrypt htpasswd line for the authed destination registry (axis e):
 *  user `relay`, password `relay-push-secret-7`. Static so the test needs no htpasswd binary. */
const HTPASSWD_LINE = "relay:$2y$05$.6wnUMMR2w21boPhbUfAxOeqMSxRAIOe5QU1bmxKaRlDlYtD74hFK\n";
const DEST_PUSH_PASSWORD = "relay-push-secret-7";
const DEST_PUSH_CRED = `relay:${DEST_PUSH_PASSWORD}`;
/** Second pre-generated bcrypt htpasswd line, the SOURCE-read identity (axis f): user `puller`,
 *  password `src-read-secret-13` — distinct from the push credential so the never-leaked
 *  assertions are unambiguous per credential. */
const SRC_HTPASSWD_LINE = "puller:$2y$05$x9zVp7YK9uwbUhYk60AiNeQp/L.ArwqoNmuna52oNtELSMz8biObO\n";
const SRC_PULL_PASSWORD = "src-read-secret-13";
const SRC_PULL_CRED = `puller:${SRC_PULL_PASSWORD}`;

describe("M15.5(c) retrans validate-then-relay (Testcontainers: 3 domains + 2 registries + cosign + skopeo)", () => {
  let commander: IsolatedDomain; // A — the exporter
  let retrans: IsolatedDomain; // B — the CDS-boundary relay
  let outpost: IsolatedDomain; // C — the receiving destination

  let srcRegistry: StartedTestContainer;
  let destRegistry: StartedTestContainer;
  let authedRegistry: StartedTestContainer;
  let srcHost: string;
  let destHost: string;
  let authedHost: string;

  let blobServer: Server; // source-side blob byte channel (SBOM + sig)
  let blobBaseUrl: string;
  const blobStore = new Map<string, Buffer>();
  let destBlobServer: Server; // destination-side blob byte channel (serves the relay's blobOutDir)
  let destBlobBaseUrl: string;
  let destBlobDir: string;
  let forbiddenServer: Server; // decoy host — must NEVER be dialed (axis c)
  let forbiddenHits = 0;
  let forbiddenHost: string;

  let scratch: string;
  let commanderDomainId: string;
  let retransDomainId: string;
  let outpostDomainId: string;
  let commanderCosignPub: string;
  let retransCosignPub: string;
  let commanderKeyPath: string; // A's instance cosign PRIVATE key materialized (harness = A's build executor)
  let attackerKeyPath: string;
  let cosignBin: string;
  let imageSignFlags: string[];
  /** Flags forcing the LEGACY `sha256-<hex>.sig` tag attach scheme (empty when this cosign knows
   *  no other scheme). Cosign v3 defaults to the OCI 1.1 referrers-FALLBACK tag (an image index)
   *  against `registry:2`, so the (a) round-trip exercises that scheme; signing ONE image with
   *  these flags makes the same suite run prove the relay's discovery finds the legacy scheme
   *  too — both storage vintages covered regardless of the ambient cosign's default. */
  let legacySchemeSignFlags: string[];

  let relayOutDir: string;

  /** The (a) round-trip state shared across sequential test steps. */
  let goodImage: { ref: string; digest: string };
  let sbom: { digest: string; location: string; signatureRef: string };
  let changeAtRetrans = "";
  let changeAtOutpost = "";
  let tarballPath = "";

  const SRC_REPO = "scp/app";

  function relayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    return {
      sourceRepo: `${srcHost}/${SRC_REPO}`,
      destRepo: `${destHost}/scp/artifacts`,
      blobOutDir: destBlobDir,
      blobBaseUrl: destBlobBaseUrl,
      insecureHosts: [srcHost, destHost, authedHost],
      ...overrides
    };
  }

  beforeAll(async () => {
    [commander, retrans, outpost] = await Promise.all([
      createIsolatedDomain("relay_a"),
      createIsolatedDomain("relay_b"),
      createIsolatedDomain("relay_c")
    ]);

    // Registries: source (anonymous), destination (anonymous — C's gate reads it credential-less,
    // like a real outpost-local registry), authed destination (axis e — push requires the vaulted
    // credential).
    [srcRegistry, destRegistry, authedRegistry] = await Promise.all([
      new GenericContainer("registry:2").withExposedPorts(5000).start(),
      new GenericContainer("registry:2").withExposedPorts(5000).start(),
      new GenericContainer("registry:2")
        .withExposedPorts(5000)
        .withEnvironment({
          REGISTRY_AUTH: "htpasswd",
          REGISTRY_AUTH_HTPASSWD_REALM: "relay-test",
          REGISTRY_AUTH_HTPASSWD_PATH: "/auth/htpasswd"
        })
        .withCopyContentToContainer([
          { content: HTPASSWD_LINE + SRC_HTPASSWD_LINE, target: "/auth/htpasswd" }
        ])
        .start()
    ]);
    srcHost = `${srcRegistry.getHost()}:${srcRegistry.getMappedPort(5000)}`;
    destHost = `${destRegistry.getHost()}:${destRegistry.getMappedPort(5000)}`;
    authedHost = `${authedRegistry.getHost()}:${authedRegistry.getMappedPort(5000)}`;

    // Source blob channel (SBOM bytes + origin sig) + destination blob channel (served relay
    // blobOutDir) + the forbidden decoy.
    blobServer = createServer((req, res) => {
      const bytes = req.url ? blobStore.get(req.url) : undefined;
      if (!bytes) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(bytes);
    });
    await new Promise<void>((resolve) => blobServer.listen(0, "127.0.0.1", resolve));
    blobBaseUrl = `http://127.0.0.1:${(blobServer.address() as AddressInfo).port}`;

    scratch = await mkdtemp(path.join(tmpdir(), "scp-m155c-"));
    destBlobDir = path.join(scratch, "dest-blobs");
    await mkdir(destBlobDir, { recursive: true });
    relayOutDir = path.join(scratch, "relay-out");
    destBlobServer = createServer((req, res) => {
      const name = req.url ? path.basename(req.url) : "";
      readFile(path.join(destBlobDir, name))
        .then((bytes) => res.end(bytes))
        .catch(() => {
          res.statusCode = 404;
          res.end("not found");
        });
    });
    await new Promise<void>((resolve) => destBlobServer.listen(0, "127.0.0.1", resolve));
    destBlobBaseUrl = `http://127.0.0.1:${(destBlobServer.address() as AddressInfo).port}`;

    forbiddenServer = createServer((_req, res) => {
      forbiddenHits += 1;
      res.end("decoy");
    });
    await new Promise<void>((resolve) => forbiddenServer.listen(0, "127.0.0.1", resolve));
    forbiddenHost = `127.0.0.1:${(forbiddenServer.address() as AddressInfo).port}`;

    // Operator allowlists (ADR-0019 §4): the source registries + blob base (for the relay's pull
    // at B) and the destination registry + blob base (for C's M17.4(b) gate). The decoy host is
    // deliberately NOT listed.
    process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = `${srcHost},${destHost},${authedHost}`;
    process.env.SCP_ARTIFACT_BLOB_BASE_URLS = `${blobBaseUrl},${destBlobBaseUrl}`;

    // Federation identities + roles: A commander, B RETRANS, C outpost.
    commanderDomainId = (
      await withTenantTx(commander.db, commander.orgId, (tx) =>
        ensureFederationSelf(tx, commander.orgId)
      )
    ).domainId;
    retransDomainId = (
      await withTenantTx(retrans.db, retrans.orgId, (tx) => ensureFederationSelf(tx, retrans.orgId))
    ).domainId;
    outpostDomainId = (
      await withTenantTx(outpost.db, outpost.orgId, (tx) => ensureFederationSelf(tx, outpost.orgId))
    ).domainId;
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      initFederationSelf(tx, { orgId: commander.orgId, name: "commander-a", role: "commander" })
    );
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      initFederationSelf(tx, { orgId: retrans.orgId, name: "retrans-b", role: "retrans" })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      initFederationSelf(tx, { orgId: outpost.orgId, name: "outpost-c", role: "outpost" })
    );

    // Keys. A's instance cosign key signs the promotion manifest AND (as the harness "build
    // executor") the artifacts themselves; its PUBLIC half is the trust anchor B and C register on
    // the pairing (M17.3 E5) — exactly the production key flow.
    const commanderPair = await ensureInstanceCosignKey(commander.db, commander.orgId);
    commanderCosignPub = commanderPair.publicKey;
    retransCosignPub = (await getInstanceCosignPublicKey(retrans.db, retrans.orgId)).publicKey;
    commanderKeyPath = path.join(scratch, "commander-cosign.key");
    await writeFile(commanderKeyPath, commanderPair.privateKey, "utf8");
    const attacker = await generateKeyPair();
    attackerKeyPath = path.join(scratch, "attacker.key");
    await writeFile(attackerKeyPath, attacker.privateKeyPem, "utf8");

    const resolvedCosign = resolveCosign();
    if (resolvedCosign.source === "missing") throw new Error("cosign binary not found");
    cosignBin = resolvedCosign.bin;
    const signHelp = execFileSync(cosignBin, ["sign", "--help"], { encoding: "utf8" });
    imageSignFlags = [
      "--tlog-upload=false",
      ...(signHelp.includes("--use-signing-config") ? ["--use-signing-config=false"] : []),
      "--allow-insecure-registry",
      "--yes"
    ];
    legacySchemeSignFlags = signHelp.includes("--new-bundle-format")
      ? ["--new-bundle-format=false"]
      : [];

    // Pairing (all out-of-band key exchange, as in production):
    //   A pairs B and C (so it can export promotions to each);
    //   B and C pair A WITH its cosign key (the M17.4 trust anchor).
    const commanderEd = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureInstanceKey(tx, commander.orgId)
    );
    const retransEd = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      ensureInstanceKey(tx, retrans.orgId)
    );
    const outpostEd = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureInstanceKey(tx, outpost.orgId)
    );
    await withTenantTx(commander.db, commander.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: commander.orgId,
        domainId: retransDomainId,
        name: "retrans-b",
        role: "retrans",
        publicKey: retransEd.publicKey
      });
      await pairPeer(tx, {
        orgId: commander.orgId,
        domainId: outpostDomainId,
        name: "outpost-c",
        role: "outpost",
        publicKey: outpostEd.publicKey
      });
    });
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: commanderDomainId,
        name: "commander-a",
        role: "commander",
        publicKey: commanderEd.publicKey,
        cosignPublicKey: commanderCosignPub
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: commanderDomainId,
        name: "commander-a",
        role: "commander",
        publicKey: commanderEd.publicKey,
        cosignPublicKey: commanderCosignPub
      })
    );
  }, 300_000);

  afterAll(async () => {
    delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
    delete process.env.SCP_ARTIFACT_BLOB_BASE_URLS;
    await commander?.close();
    await retrans?.close();
    await outpost?.close();
    await srcRegistry?.stop();
    await destRegistry?.stop();
    await authedRegistry?.stop();
    for (const server of [blobServer, destBlobServer, forbiddenServer]) {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // Harness — the exporter's build executor side: push + cosign-sign artifacts at the SOURCE.
  // ---------------------------------------------------------------------------------------------

  /** Minimal OCI image push over the distribution API (Basic auth when `auth` is given —
   *  `user:password`, for the authed registry). Returns the digest-pinned reference. */
  async function pushImage(
    host: string,
    repo: string,
    seed: string,
    auth?: string
  ): Promise<{ ref: string; digest: string }> {
    const authHeaders: Record<string, string> = auth
      ? { authorization: `Basic ${Buffer.from(auth).toString("base64")}` }
      : {};
    async function pushBlob(bytes: Buffer): Promise<{ digest: string; size: number }> {
      const digest = sha256(bytes);
      const start = await fetch(`http://${host}/v2/${repo}/blobs/uploads/`, {
        method: "POST",
        headers: authHeaders
      });
      if (start.status !== 202) throw new Error(`blob upload start: HTTP ${start.status}`);
      const loc = start.headers.get("location") ?? "";
      const url = new URL(loc.startsWith("http") ? loc : `http://${host}${loc}`);
      url.searchParams.set("digest", digest);
      const put = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", ...authHeaders },
        body: new Uint8Array(bytes)
      });
      if (put.status !== 201) throw new Error(`blob upload put: HTTP ${put.status}`);
      return { digest, size: bytes.length };
    }
    const layerBytes = Buffer.from(`layer-bytes-${seed}`);
    const layer = await pushBlob(layerBytes);
    const config = await pushBlob(
      Buffer.from(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          config: {},
          rootfs: { type: "layers", diff_ids: [sha256(layerBytes)] }
        })
      )
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: config.digest,
          size: config.size
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar",
            digest: layer.digest,
            size: layer.size
          }
        ]
      })
    );
    const digest = sha256(manifest);
    const put = await fetch(`http://${host}/v2/${repo}/manifests/${digest}`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", ...authHeaders },
      body: new Uint8Array(manifest)
    });
    if (put.status !== 201) throw new Error(`manifest put: HTTP ${put.status}`);
    return { ref: `${host}/${repo}@${digest}`, digest };
  }

  function signImage(
    ref: string,
    keyPath: string,
    extraFlags: string[] = [],
    extraEnv: Record<string, string> = {}
  ): void {
    execFileSync(cosignBin, ["sign", "--key", keyPath, ...imageSignFlags, ...extraFlags, ref], {
      encoding: "utf8",
      env: { ...process.env, COSIGN_PASSWORD: "", ...extraEnv }
    });
  }

  /** A scratch docker-config dir holding Basic auth for `host` — the harness-side ("build
   *  executor at A") counterpart of the relay's own per-invocation authfile: cosign's registry
   *  writes/reads honor DOCKER_CONFIG. */
  async function harnessDockerConfigDir(host: string, cred: string): Promise<string> {
    const dir = await mkdtemp(path.join(scratch, "harness-docker-"));
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ auths: { [host]: { auth: Buffer.from(cred).toString("base64") } } })
    );
    return dir;
  }

  /** Serve an SBOM blob + its origin detached signature (signed with A's instance key). */
  async function serveSignedBlob(
    name: string,
    bytes: Buffer
  ): Promise<{ digest: string; location: string; signatureRef: string }> {
    const blobPath = path.join(scratch, `${name}.bin`);
    const sigPath = path.join(scratch, `${name}.sig`);
    await writeFile(blobPath, bytes);
    execFileSync(
      cosignBin,
      [
        "sign-blob",
        "--key",
        commanderKeyPath,
        "--tlog-upload=false",
        "--new-bundle-format=false",
        ...(imageSignFlags.includes("--use-signing-config=false")
          ? ["--use-signing-config=false"]
          : []),
        "--output-signature",
        sigPath,
        "--yes",
        blobPath
      ],
      { encoding: "utf8", env: { ...process.env, COSIGN_PASSWORD: "" } }
    );
    blobStore.set(`/${name}`, bytes);
    blobStore.set(`/${name}.sig`, await readFile(sigPath));
    return {
      digest: sha256(bytes),
      location: `${blobBaseUrl}/${name}`,
      signatureRef: `${blobBaseUrl}/${name}.sig`
    };
  }

  /** Does `host` have a manifest for `digest` under `repo`? (destination-emptiness assertions). */
  async function registryHasDigest(
    host: string,
    repo: string,
    digest: string,
    auth?: string
  ): Promise<boolean> {
    const res = await fetch(`http://${host}/v2/${repo}/manifests/${digest}`, {
      method: "HEAD",
      headers: {
        accept: "application/vnd.oci.image.manifest.v1+json",
        ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {})
      }
    });
    return res.status === 200;
  }

  // ---------------------------------------------------------------------------------------------
  // Commander-side (A) promotion machinery — change + scan evidence + export.
  // ---------------------------------------------------------------------------------------------

  /** Propose a change at A tracking `imageDigest` (+ optional sbom), seed its passing digest-bound
   *  scan (the M17.3 E6 export gate), and sync A's graph to B and C so the target resolves. */
  async function proposeTrackedChangeAtA(
    imageDigest: string,
    sbomRef?: { digest: string; location: string; signatureRef: string }
  ): Promise<string> {
    const target = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: `t-relay-target-${randomUUID()}`,
        name: `relay-target-${randomUUID().slice(0, 8)}`
      })
    );
    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: `t-relay-change-${randomUUID()}`,
        name: `relay-release-${randomUUID().slice(0, 8)}`,
        targets: [target.id],
        sourceRef: {
          artifact_digest: imageDigest,
          ...(sbomRef
            ? {
                sbom: {
                  digest: sbomRef.digest,
                  location: sbomRef.location,
                  signatureRef: sbomRef.signatureRef,
                  format: "cyclonedx"
                }
              }
            : {})
        }
      })
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      insertControlRun(tx, {
        orgId: commander.orgId,
        controlObjectId: randomUUID(),
        changeObjectId: change.id,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "promoted" },
        status: "pass",
        evidence: {
          scanner: "trivy",
          scannerVersion: "0.50.0",
          artifactDigest: imageDigest,
          expectedDigest: imageDigest,
          digestMatch: true,
          severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
          threshold: { maxCritical: 0, maxHigh: 0 }
        }
      })
    );
    // Sync the graph so the promotion's target resolves at B and C (cursor-tracked, so repeated
    // syncs export only the delta — the same pattern federation.integration.test.ts uses).
    for (const dest of [retrans, outpost]) {
      const peerName = dest === retrans ? "retrans-b" : "outpost-c";
      const cursor = await withTenantTx(dest.db, dest.orgId, (tx) =>
        getCursor(tx, dest.orgId, commanderDomainId, commanderDomainId)
      );
      const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
        exportSyncBundle(tx, commander.orgId, peerName, cursor.sequence)
      );
      await withTenantTx(dest.db, dest.orgId, (tx) => importSyncBundle(tx, dest.orgId, bundle));
    }
    return change.id;
  }

  async function exportPromotionFromA(
    changeId: string,
    peerName: string
  ): Promise<PromotionBundle> {
    const outcome = await exportPromotionBundle(commander.db, {
      orgId: commander.orgId,
      peerIdOrName: peerName,
      changeIdOrUrn: changeId
    });
    if (outcome.refused) throw new Error(`unexpected export refusal: ${outcome.reason}`);
    return outcome.bundle;
  }

  async function latestDecision(domain: IsolatedDomain, kind: string) {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.kind, kind))
        .orderBy(desc(decisions.id))
        .limit(1)
    );
    return rows[0];
  }

  async function auditActions(domain: IsolatedDomain): Promise<string[]> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ action: auditEvents.action }).from(auditEvents)
    );
    return rows.map((r) => r.action);
  }

  // ---------------------------------------------------------------------------------------------
  // (a) FULL ROUND-TRIP — sequential steps sharing state.
  // ---------------------------------------------------------------------------------------------

  it("exporter signs + exports; retrans imports (M17.4a) and the relay pulls, validates, and packages the signed tarball", async () => {
    // The "build executor" at A: image bytes in the SOURCE registry, cosign-signed with A's key;
    // SBOM blob + origin detached sig on the source blob channel.
    goodImage = await pushImage(srcHost, SRC_REPO, "good-artifact");
    signImage(goodImage.ref, commanderKeyPath);
    sbom = await serveSignedBlob(
      "relay-sbom",
      Buffer.from(`{"bomFormat":"CycloneDX","seed":"${randomUUID()}"}`)
    );

    const changeAtA = await proposeTrackedChangeAtA(goodImage.digest, sbom);

    // A → B: the metadata .scpbundle walk; B's import runs the M17.4(a) manifest verify.
    const bundleForB = await exportPromotionFromA(changeAtA, "retrans-b");
    expect(bundleForB.promotionManifest).toBeDefined();
    const importedAtB = await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);
    changeAtRetrans = importedAtB.localChangeObjectId;

    // A → C: the same promotion, addressed to the destination outpost (hub-and-spoke: the
    // outpost's promotion trust runs commander→outpost; the retrans carries only bytes).
    const bundleForC = await exportPromotionFromA(changeAtA, "outpost-c");
    const importedAtC = await importPromotionBundle(outpost.db, outpost.orgId, bundleForC);
    changeAtOutpost = importedAtC.localChangeObjectId;

    // THE RELAY at B: pull by digest (vendored-skopeo resolution), validate (M17.4 machinery),
    // package + sign the tarball.
    const result = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: changeAtRetrans,
      masterKey: Buffer.alloc(32, 7),
      outDir: relayOutDir,
      config: relayConfig()
    });
    expect(result.refused).toBe(false);
    if (result.refused) throw new Error("unreachable");
    tarballPath = result.tarballPath;
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        { type: "oci", digest: goodImage.digest },
        { type: "blob", digest: sbom.digest }
      ])
    );
    // The allow verdict is a persisted Decision (charter principle 6) + audit event.
    const decision = await latestDecision(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND);
    expect(decision?.verdict).toBe("allow");
    expect(await auditActions(retrans)).toContain("federation.relay.built");
    // The tarball exists and is a real gzip tar with the signed checksum manifest.
    const listing = execFileSync("tar", ["tzf", tarballPath], { encoding: "utf8" });
    expect(listing).toContain("CHECKSUMS.txt");
    expect(listing).toContain("CHECKSUMS.txt.sig");
    expect(listing).toContain("relay-manifest.json");
  }, 240_000);

  it("before the bytes land, the destination's M17.4(b) gate fails closed (nothing weakened by the relay's existence)", async () => {
    const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, changeAtOutpost)
    );
    const gate = await runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow);
    expect(gate.blocked).toBe(true);
  }, 120_000);

  it("destination imports the tarball: signature+checksums verified, pushed by digest + re-inspected, locations recorded — and the receiving M17.4(b) gate PASSES end-to-end", async () => {
    const result = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpost,
      tarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: Buffer.alloc(32, 9),
      config: relayConfig()
    });
    expect(result.refused).toBe(false);
    if (result.refused) throw new Error("unreachable");
    expect(result.pushed).toEqual(
      expect.arrayContaining([
        {
          type: "oci",
          digest: goodImage.digest,
          location: `${destHost}/scp/artifacts@${goodImage.digest}`
        },
        expect.objectContaining({ type: "blob", digest: sbom.digest })
      ])
    );
    // The bytes really landed at the destination registry, at the authorized digest.
    expect(await registryHasDigest(destHost, "scp/artifacts", goodImage.digest)).toBe(true);
    const importDecision = await latestDecision(outpost, RETRANS_RELAY_IMPORT_DECISION_KIND);
    expect(importDecision?.verdict).toBe("allow");
    expect(await auditActions(outpost)).toContain("federation.relay.import.applied");

    // ZERO TRUST IN THE RELAY, positively proven: the receiving outpost's UNCHANGED M17.4(b)
    // per-artifact byte gate now verifies the landed bytes (registry-attached cosign signature
    // for the image, blob digest + origin detached signature for the SBOM) against the
    // EXPORTER's distributed key — and passes.
    const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, changeAtOutpost)
    );
    const gate = await runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow);
    expect(gate.blocked).toBe(false);
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (b) TAMPER NEVER CROSSES.
  // ---------------------------------------------------------------------------------------------

  it("a tampered artifact at the source (signed by the WRONG key) refuses the relay with a block Decision + audit — and NOTHING reaches the destination registry", async () => {
    // Real signature, WRONG key — a forged/substituted build — attached under the LEGACY
    // `sha256-<hex>.sig` tag scheme (where this cosign can be told to): the relay's discovery
    // must FIND the signature artifact under EITHER attach scheme first (the (a) round-trip
    // already covers this cosign's default — the referrers-fallback index under cosign v3), and
    // only THEN refuse on verification. A discovery miss would produce the wrong refusal reason.
    const tampered = await pushImage(srcHost, SRC_REPO, "tampered-artifact");
    signImage(tampered.ref, attackerKeyPath, legacySchemeSignFlags);
    const changeAtA = await proposeTrackedChangeAtA(tampered.digest);
    const bundleForB = await exportPromotionFromA(changeAtA, "retrans-b");
    const importedAtB = await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);

    const result = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: importedAtB.localChangeObjectId,
      masterKey: Buffer.alloc(32, 7),
      outDir: relayOutDir,
      config: relayConfig()
    });
    expect(result.refused).toBe(true);
    if (!result.refused) throw new Error("unreachable");
    expect(result.reason).toContain("signature verification failed");
    // Block Decision + hash-chained audit event, naming the failing digest.
    const decision = await latestDecision(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND);
    expect(decision?.verdict).toBe("block");
    expect(JSON.stringify(decision?.inputContext)).toContain(tampered.digest);
    expect(await auditActions(retrans)).toContain("federation.relay.validate.blocked");
    // No tarball was produced for it, and the destination registry has NO trace of the digest.
    const outFiles = await readdir(relayOutDir);
    expect(outFiles).not.toContain(`scp-relay-${changeAtA}.tar.gz`);
    expect(await registryHasDigest(destHost, "scp/artifacts", tampered.digest)).toBe(false);
  }, 240_000);

  it("a tarball tampered in CDS transit is refused at the destination (block Decision) and nothing is pushed", async () => {
    // Take the GOOD tarball, corrupt one packaged file, re-pack WITHOUT re-signing — the CDS
    // transit tamper model. Push it at a FRESH destination repo config to prove zero pushes.
    const tamperDir = await mkdtemp(path.join(scratch, "tamper-"));
    execFileSync("tar", ["xzf", tarballPath, "-C", tamperDir]);
    const [rootName] = await readdir(tamperDir);
    const bundleRoot = path.join(tamperDir, rootName as string);
    const sbomHex = sbom.digest.slice("sha256:".length);
    await writeFile(
      path.join(bundleRoot, "blobs", `${sbomHex}.bin`),
      Buffer.from("tampered-in-transit")
    );
    const tamperedTarball = path.join(tamperDir, "tampered.tar.gz");
    execFileSync("tar", ["czf", tamperedTarball, "-C", tamperDir, rootName as string]);

    const result = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpost,
      tarballPath: tamperedTarball,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: Buffer.alloc(32, 9),
      config: relayConfig({ destRepo: `${destHost}/scp/tamper-check` })
    });
    expect(result.refused).toBe(true);
    if (!result.refused) throw new Error("unreachable");
    const decision = await latestDecision(outpost, RETRANS_RELAY_IMPORT_DECISION_KIND);
    expect(decision?.verdict).toBe("block");
    expect(await auditActions(outpost)).toContain("federation.relay.import.blocked");
    // NOTHING was pushed: the fresh destination repo holds neither artifact.
    expect(await registryHasDigest(destHost, "scp/tamper-check", goodImage.digest)).toBe(false);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (c) ALLOWLIST — refused BEFORE any dial.
  // ---------------------------------------------------------------------------------------------

  it("a source host outside SCP_ARTIFACT_OCI_REGISTRY_HOSTS is refused before any dial (zero requests to the decoy)", async () => {
    const before = forbiddenHits;
    const result = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: changeAtRetrans,
      masterKey: Buffer.alloc(32, 7),
      outDir: relayOutDir,
      config: relayConfig({ sourceRepo: `${forbiddenHost}/scp/app` })
    });
    expect(result.refused).toBe(true);
    if (!result.refused) throw new Error("unreachable");
    expect(result.reason).toContain("not allowlisted");
    expect(forbiddenHits).toBe(before); // the guard fired BEFORE any dial — the decoy saw nothing.
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (d) ROLE — the ADR-0004 arm: only a retrans-role instance relays.
  // ---------------------------------------------------------------------------------------------

  it("a non-retrans instance refuses to run the relay", async () => {
    // The refusal is a 409 ProblemError whose `detail` names the required role (the message
    // itself is the RFC 9457 title, "Conflict").
    await expect(
      buildRelayTarball(outpost.db, {
        orgId: outpost.orgId,
        changeIdOrUrn: changeAtOutpost,
        masterKey: Buffer.alloc(32, 9),
        outDir: relayOutDir,
        config: relayConfig()
      })
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining("requires federation role 'retrans'")
    });
  }, 60_000);

  // ---------------------------------------------------------------------------------------------
  // (e) CREDS — vaulted, per-registry, never logged (ADR-0019 §3).
  // ---------------------------------------------------------------------------------------------

  it("the destination push credential is resolved from the secrets vault against an auth-requiring registry, and never leaks into logs, Decisions, or audit events", async () => {
    // Without the credential, the push is refused by the registry (proves auth is really on).
    const noCred = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpost,
      tarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: Buffer.alloc(32, 9),
      config: relayConfig({ destRepo: `${authedHost}/scp/artifacts` })
    });
    expect(noCred.refused).toBe(true);

    // Store the per-registry push credential in the EXISTING secrets vault (same vault, same
    // AES-256-GCM envelope as executor credentials — ADR-0019 §3).
    const masterKey = Buffer.alloc(32, 9);
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      putSecret(tx, {
        orgId: outpost.orgId,
        key: relayDestPushSecretKey(authedHost),
        value: DEST_PUSH_CRED,
        masterKey
      })
    );

    // Capture EVERYTHING written to stderr during the credentialed run (skopeo argv logging
    // included) to prove the secret never appears.
    let captured = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return (originalWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
        chunk,
        ...rest
      );
    }) as typeof process.stderr.write;
    let result: Awaited<ReturnType<typeof importRelayTarball>>;
    try {
      result = await importRelayTarball(outpost.db, {
        orgId: outpost.orgId,
        changeIdOrUrn: changeAtOutpost,
        tarballPath,
        relayCosignPublicKeyPem: retransCosignPub,
        masterKey,
        config: relayConfig({ destRepo: `${authedHost}/scp/artifacts` })
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(result.refused).toBe(false);
    // The push really landed, authenticated.
    expect(
      await registryHasDigest(authedHost, "scp/artifacts", goodImage.digest, DEST_PUSH_CRED)
    ).toBe(true);
    // The credential appears NOWHERE: not in captured process output (argv is logged; creds ride
    // a 0600 authfile), not in any Decision, not in any audit event.
    expect(captured).not.toContain(DEST_PUSH_PASSWORD);
    const allDecisions = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(decisions)
    );
    expect(JSON.stringify(allDecisions)).not.toContain(DEST_PUSH_PASSWORD);
    const allAudit = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(auditEvents)
    );
    expect(JSON.stringify(allAudit)).not.toContain(DEST_PUSH_PASSWORD);
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (f) SOURCE CREDS + ENV ISOLATION — the authed-SOURCE round-trip and the per-invocation
  //     subprocess-env guarantee (no process.env.DOCKER_CONFIG mutation, ever).
  // ---------------------------------------------------------------------------------------------

  it("an authed SOURCE registry: pull refused without the vaulted read credential, succeeds after putSecret — credential never leaks and process.env.DOCKER_CONFIG is never mutated (concurrent verify unaffected)", async () => {
    // Build-executor side at A: image bytes in the AUTH-REQUIRING source registry, cosign-signed
    // with A's instance key (cosign authenticates via a harness-side DOCKER_CONFIG, the same way
    // any real build executor would).
    const authedImage = await pushImage(
      authedHost,
      "scp/authed-app",
      "authed-source-artifact",
      SRC_PULL_CRED
    );
    const harnessCfg = await harnessDockerConfigDir(authedHost, SRC_PULL_CRED);
    signImage(authedImage.ref, commanderKeyPath, [], { DOCKER_CONFIG: harnessCfg });
    const changeAtA = await proposeTrackedChangeAtA(authedImage.digest);
    const bundleForB = await exportPromotionFromA(changeAtA, "retrans-b");
    const importedAtB = await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);
    const authedConfig = relayConfig({ sourceRepo: `${authedHost}/scp/authed-app` });
    const retransMasterKey = Buffer.alloc(32, 7);

    // WITHOUT the vaulted secret: the source registry refuses the pull; the relay fails closed
    // (block Decision, no tarball) — proves auth is really enforced on the pull path.
    const noCred = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: importedAtB.localChangeObjectId,
      masterKey: retransMasterKey,
      outDir: relayOutDir,
      config: authedConfig
    });
    expect(noCred.refused).toBe(true);
    if (!noCred.refused) throw new Error("unreachable");
    expect(noCred.reason).toMatch(/unauthorized|authentication required/i);

    // Vault the per-registry SOURCE-read credential (ADR-0019 §3 — same vault, same envelope,
    // per-registry key) at the retrans instance.
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      putSecret(tx, {
        orgId: retrans.orgId,
        key: relaySourceReadSecretKey(authedHost),
        value: SRC_PULL_CRED,
        masterKey: retransMasterKey
      })
    );

    // Reset C's landed locations to the ANONYMOUS destination registry (axis (e) re-pointed them
    // at the authed one) so the concurrent M17.4(b) verify below has a genuinely DIFFERENT auth
    // need than the relay: an anonymous registry read.
    const reset = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpost,
      tarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: Buffer.alloc(32, 9),
      config: relayConfig()
    });
    expect(reset.refused).toBe(false);

    // ENV ISOLATION (the multi-tenant guarantee): pin process.env.DOCKER_CONFIG to a sentinel,
    // SAMPLE it on an interval THROUGHOUT the credentialed run, and run a CONCURRENT pre-deploy
    // verify with a different auth need — the relay's registry auth must ride per-invocation
    // subprocess env only. Under a process-global mutation the sampler observes the scratch
    // config dir during the window and byte-identity fails.
    const sentinel = path.join(scratch, "sentinel-docker-config");
    const savedDockerConfig = process.env.DOCKER_CONFIG;
    process.env.DOCKER_CONFIG = sentinel;
    const observed = new Set<string | undefined>();
    const sampler = setInterval(() => observed.add(process.env.DOCKER_CONFIG), 2);
    let captured = "";
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return (originalWrite as (c: string | Uint8Array, ...a: unknown[]) => boolean)(
        chunk,
        ...rest
      );
    }) as typeof process.stderr.write;
    let result: Awaited<ReturnType<typeof buildRelayTarball>>;
    let gate: Awaited<ReturnType<typeof runPreDeployArtifactGate>>;
    let dockerConfigAfterRun: string | undefined;
    try {
      const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
        getChangeRow(tx, outpost.orgId, changeAtOutpost)
      );
      [result, gate] = await Promise.all([
        buildRelayTarball(retrans.db, {
          orgId: retrans.orgId,
          changeIdOrUrn: importedAtB.localChangeObjectId,
          masterKey: retransMasterKey,
          outDir: relayOutDir,
          config: authedConfig
        }),
        runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow)
      ]);
      dockerConfigAfterRun = process.env.DOCKER_CONFIG;
    } finally {
      process.stderr.write = originalWrite;
      clearInterval(sampler);
      if (savedDockerConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = savedDockerConfig;
    }

    // The relay succeeded with the vaulted credential: skopeo pulled AND the cosign validate pass
    // authenticated (per-invocation DOCKER_CONFIG), all against the auth-requiring source.
    expect(result.refused).toBe(false);
    if (result.refused) throw new Error("unreachable");
    expect(result.artifacts).toEqual([{ type: "oci", digest: authedImage.digest }]);
    // The CONCURRENT verify (anonymous destination registry — a different auth need) passed,
    // untouched by the relay's source credentials.
    expect(gate.blocked).toBe(false);
    // process.env.DOCKER_CONFIG: byte-identical after the run, and NEVER anything else during it.
    expect(dockerConfigAfterRun).toBe(sentinel);
    expect([...observed]).toEqual([sentinel]);
    // The source-read password appears NOWHERE: not in process output (skopeo/cosign argv is
    // logged; creds ride the 0600 authfile / per-invocation env), not in Decisions, not in audit.
    expect(captured).not.toContain(SRC_PULL_PASSWORD);
    const allDecisions = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx.select().from(decisions)
    );
    expect(JSON.stringify(allDecisions)).not.toContain(SRC_PULL_PASSWORD);
    const allAudit = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx.select().from(auditEvents)
    );
    expect(JSON.stringify(allAudit)).not.toContain(SRC_PULL_PASSWORD);
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (g) TLS SCOPING — `--allow-insecure-registry` only for SCP_RELAY_INSECURE_HOSTS hosts,
  //     mirroring skopeo's per-host `--…-tls-verify=false`. The cosign-side per-host WIRING is
  //     proven in artifact-verify.test.ts (unit, mocked cosign seam) — cosign's own
  //     go-containerregistry auto-downgrades LOOPBACK registry hosts to HTTP regardless of the
  //     flag, so a Testcontainers loopback registry cannot observe the negative case live. The
  //     skopeo pull path CAN, end-to-end:
  // ---------------------------------------------------------------------------------------------

  it("a plain-HTTP source host not in SCP_RELAY_INSECURE_HOSTS is refused end-to-end (TLS verification enforced on the relay)", async () => {
    const result = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: changeAtRetrans,
      masterKey: Buffer.alloc(32, 7),
      outDir: relayOutDir,
      config: relayConfig({ insecureHosts: [] })
    });
    expect(result.refused).toBe(true);
    if (!result.refused) throw new Error("unreachable");
    expect(result.reason).toMatch(/https|tls/i);
  }, 120_000);
});

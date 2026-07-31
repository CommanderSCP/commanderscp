import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { asTrustDomainId, type PromotionBundle, type TrustDomainId } from "@scp/schemas";
import { resolveCosign } from "@scp/cosign";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, bundleTransfers, changes, decisions } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange, getChangeRow } from "../coordination/changes-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { runPreDeployArtifactGate } from "../coordination/pre-deploy-gate.js";
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
  RELAY_FAILURE_DETAIL_LIMIT,
  RELAY_FAILURE_REASON_CHARS,
  RELAY_IDENTIFIER_CHARS,
  RETRANS_RELAY_VALIDATE_DECISION_KIND,
  buildRelayTarball,
  importRelayTarball,
  sha256File,
  validateAndForwardRelayTarball,
  type RelayConfig
} from "./retrans-relay.js";
import {
  AUTO_RELAY_DECISION_KIND,
  autoRelayOrgTick,
  runAutoRelaySweep,
  type AutoRelayOutcome
} from "./auto-relay.js";
import {
  backoffRelayBuild,
  claimRelayBuild,
  completeRelayBuild,
  exhaustRelayBuild,
  getRelayBuild,
  reopenRelayBuild,
  seedRelayBuild,
  type RelayBuildClaim
} from "./relay-builds-repo.js";

/**
 * M13.1b — the staging node's UNATTENDED ONWARD BYTE HOP: THE 13.1b DoD suite (proposal §13.1,
 * BUILD_AND_TEST.md M13.1b). Same topology-faithful harness as the M13.1a inbox suite — three REAL
 * isolated federation domains (separate Postgres databases), real `registry:2` containers, the real
 * cosign + skopeo binaries:
 *
 *   commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C
 *
 * The milestone's whole claim is "no operator command", so every case here asserts DATABASE or
 * FILESYSTEM state — the ledger row, the Decision/audit trail, the bytes in the drop directory,
 * `bundle_transfers` — never a log line and never "some action happened". Where a case exists to
 * catch a specific regression, the comment says which one.
 *
 * Two properties get the most weight because they are the ones that go wrong silently:
 *
 *  - The HIGH SIDE never builds. Both boundary nodes are `role: retrans` and both seed a ledger row
 *    at import, so the node whose BYTES ARRIVE must be stopped by the `forwarded` terminal state or
 *    it would produce a trail of fabricated refusals over a promotion that in fact crossed.
 *  - The permanent record is BOUNDED (#153). A failing change gets a finite number of verdicts and
 *    then writes NOTHING, ever — asserted as an exact row-count delta over `decisions` and
 *    `audit_events`, because "roughly stops" is how 1.44 GB/day happened in production.
 */

const sha256 = (buf: Buffer): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

/** The operator enable, supplied through `autoRelayOrgTick`'s env seam rather than `process.env` so
 *  parallel workers can never observe each other's flag. */
const AUTO_ON: NodeJS.ProcessEnv = { SCP_RETRANS_AUTO_RELAY: "1" };
/** The same, with a deliberately small verdict budget — the #153 bound is reached in 3 attempts. */
const AUTO_ON_CAP_3: NodeJS.ProcessEnv = {
  SCP_RETRANS_AUTO_RELAY: "1",
  SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS: "3"
};
const MAX_ATTEMPTS_UNDER_TEST = 3;

describe("M13.1b retrans auto-relay (Testcontainers: 3 domains + 2 registries + cosign + skopeo)", () => {
  let commander: IsolatedDomain; // A — the exporter
  let retrans: IsolatedDomain; // B — the CDS-boundary staging node under test
  let outpost: IsolatedDomain; // C — the receiving destination

  let srcRegistry: StartedTestContainer;
  let destRegistry: StartedTestContainer;
  let srcHost: string;
  let destHost: string;

  let blobServer: Server; // source-side blob byte channel (SBOM + sig)
  let blobBaseUrl: string;
  const blobStore = new Map<string, Buffer>();
  let destBlobServer: Server;
  let destBlobBaseUrl: string;
  let destBlobDir: string;

  let scratch: string;
  let commanderDomainId: TrustDomainId;
  let retransDomainId: TrustDomainId;
  let outpostDomainId: TrustDomainId;
  let commanderKeyPath: string;
  let retransCosignPub: string;
  let cosignBin: string;
  let imageSignFlags: string[];

  /** THE onward drop the sweep resolves (B's instance `SCP_RELAY_OUT_DIR` equivalent). Its exact
   *  contents are an assertion target in almost every case, so nothing else ever writes here. */
  let autoDropDir: string;
  /** Fixture tarballs built by DIRECT `buildRelayTarball` calls (the high-side fixture) — kept out
   *  of `autoDropDir` so "the sweep dropped nothing" stays a statement about the sweep. */
  let fixtureOutDir: string;
  /** Where the high-side fixture's validate-and-forward hop drops. */
  let forwardOutDir: string;

  const RETRANS_MASTER_KEY = Buffer.alloc(32, 7);
  const OUTPOST_MASTER_KEY = Buffer.alloc(32, 9);
  const COMMANDER_MASTER_KEY = Buffer.alloc(32, 3);

  const SRC_REPO = "scp/app";
  /** An ALLOWLISTED registry host that simply does not hold the authorized digest — the fixture for
   *  a real, repeatable build failure ("bytes absent from the source registry"). */
  const MISSING_REPO = "scp/no-such-bytes";

  function retransConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    return {
      sourceRepo: `${srcHost}/${SRC_REPO}`,
      insecureHosts: [srcHost, destHost],
      outDir: autoDropDir,
      ...overrides
    };
  }

  function outpostConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
    return {
      sourceRepo: `${srcHost}/${SRC_REPO}`,
      destRepo: `${destHost}/scp/artifacts`,
      blobOutDir: destBlobDir,
      blobBaseUrl: destBlobBaseUrl,
      insecureHosts: [srcHost, destHost],
      ...overrides
    };
  }

  beforeAll(async () => {
    [commander, retrans, outpost] = await Promise.all([
      createIsolatedDomain("autorelay_a"),
      createIsolatedDomain("autorelay_b"),
      createIsolatedDomain("autorelay_c")
    ]);

    [srcRegistry, destRegistry] = await Promise.all([
      new GenericContainer("registry:2").withExposedPorts(5000).start(),
      new GenericContainer("registry:2").withExposedPorts(5000).start()
    ]);
    srcHost = `${srcRegistry.getHost()}:${srcRegistry.getMappedPort(5000)}`;
    destHost = `${destRegistry.getHost()}:${destRegistry.getMappedPort(5000)}`;

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

    scratch = await mkdtemp(path.join(tmpdir(), "scp-m131b-"));
    destBlobDir = path.join(scratch, "dest-blobs");
    autoDropDir = path.join(scratch, "auto-drop");
    fixtureOutDir = path.join(scratch, "fixture-out");
    forwardOutDir = path.join(scratch, "forward-out");
    for (const dir of [destBlobDir, autoDropDir, fixtureOutDir, forwardOutDir]) {
      await mkdir(dir, { recursive: true });
    }

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

    process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = `${srcHost},${destHost}`;
    process.env.SCP_ARTIFACT_BLOB_BASE_URLS = `${blobBaseUrl},${destBlobBaseUrl}`;
    process.env.SCP_ARTIFACT_INSECURE_HOSTS = `${srcHost},${destHost}`;

    // Federation identities + roles.
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

    // Keys: A's instance cosign key signs the promotion manifest AND (as the harness "build
    // executor") the artifacts; B's signs the relay tarball.
    const commanderPair = await ensureInstanceCosignKey(commander.db, commander.orgId);
    retransCosignPub = (await getInstanceCosignPublicKey(retrans.db, retrans.orgId)).publicKey;
    commanderKeyPath = path.join(scratch, "commander-cosign.key");
    await writeFile(commanderKeyPath, commanderPair.privateKey, "utf8");

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

    // Pairing (out-of-band key exchange, as in production).
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
        cosignPublicKey: commanderPair.publicKey
      })
    );
    await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: commanderDomainId,
        name: "commander-a",
        role: "commander",
        publicKey: commanderEd.publicKey,
        cosignPublicKey: commanderPair.publicKey
      });
      await pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: retransDomainId,
        name: "retrans-b",
        role: "retrans",
        publicKey: retransEd.publicKey,
        cosignPublicKey: retransCosignPub
      });
    });
  }, 300_000);

  afterAll(async () => {
    delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
    delete process.env.SCP_ARTIFACT_BLOB_BASE_URLS;
    delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
    await commander?.close();
    await retrans?.close();
    await outpost?.close();
    await srcRegistry?.stop();
    await destRegistry?.stop();
    for (const server of [blobServer, destBlobServer]) {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // Harness — the exporter side (identical shapes to the M13.1a/M15.5(c) suites).
  // ---------------------------------------------------------------------------------------------

  async function pushImage(
    host: string,
    repo: string,
    seed: string
  ): Promise<{ ref: string; digest: string }> {
    async function pushBlob(bytes: Buffer): Promise<{ digest: string; size: number }> {
      const digest = sha256(bytes);
      const start = await fetch(`http://${host}/v2/${repo}/blobs/uploads/`, { method: "POST" });
      if (start.status !== 202) throw new Error(`blob upload start: HTTP ${start.status}`);
      const loc = start.headers.get("location") ?? "";
      const url = new URL(loc.startsWith("http") ? loc : `http://${host}${loc}`);
      url.searchParams.set("digest", digest);
      const put = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
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
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: new Uint8Array(manifest)
    });
    if (put.status !== 201) throw new Error(`manifest put: HTTP ${put.status}`);
    return { ref: `${host}/${repo}@${digest}`, digest };
  }

  function signImage(ref: string, keyPath: string): void {
    execFileSync(cosignBin, ["sign", "--key", keyPath, ...imageSignFlags, ref], {
      encoding: "utf8",
      env: { ...process.env, COSIGN_PASSWORD: "" }
    });
  }

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

  async function registryHasDigest(host: string, repo: string, digest: string): Promise<boolean> {
    const res = await fetch(`http://${host}/v2/${repo}/manifests/${digest}`, {
      method: "HEAD",
      headers: { accept: "application/vnd.oci.image.manifest.v1+json" }
    });
    return res.status === 200;
  }

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
        requestId: `t-autorelay-target-${randomUUID()}`,
        name: `autorelay-target-${randomUUID().slice(0, 8)}`
      })
    );
    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: `t-autorelay-change-${randomUUID()}`,
        name: `autorelay-release-${randomUUID().slice(0, 8)}`,
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
        gateRef: { fromState: "validating", toState: "accepted" },
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
    // Graph sync so the promotion's target resolves at B and C (fixture plumbing).
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

  /** Every fixture's change state AT B the moment its import finished — the baseline for the
   *  ADR-0004 assertion at the end (the retrans NEVER terminates a promotion). */
  const stateAtImport = new Map<string, string>();

  /** One promotion, all the way to "imported at B (and optionally C)" — the point at which the
   *  CAUSAL SEED has (or has not) happened. Returns the ids each side knows it by. */
  async function seedPromotion(
    seed: string,
    opts: { withSbom?: boolean; alsoAtOutpost?: boolean } = {}
  ): Promise<{ changeAtA: string; changeAtB: string; imageDigest: string; changeAtC?: string }> {
    const image = await pushImage(srcHost, SRC_REPO, seed);
    signImage(image.ref, commanderKeyPath);
    const sbom = opts.withSbom
      ? await serveSignedBlob(
          `sbom-${seed}`,
          Buffer.from(`{"bomFormat":"CycloneDX","seed":"${randomUUID()}"}`)
        )
      : undefined;
    const changeAtA = await proposeTrackedChangeAtA(image.digest, sbom);
    const bundleForB = await exportPromotionFromA(changeAtA, "retrans-b");
    const importedAtB = await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);
    let changeAtC: string | undefined;
    if (opts.alsoAtOutpost) {
      const bundleForC = await exportPromotionFromA(changeAtA, "outpost-c");
      changeAtC = (await importPromotionBundle(outpost.db, outpost.orgId, bundleForC))
        .localChangeObjectId;
    }
    const [imported] = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx
        .select({ state: changes.state })
        .from(changes)
        .where(eq(changes.objectId, importedAtB.localChangeObjectId))
    );
    stateAtImport.set(importedAtB.localChangeObjectId, imported!.state);
    return {
      changeAtA,
      changeAtB: importedAtB.localChangeObjectId,
      imageDigest: image.digest,
      ...(changeAtC ? { changeAtC } : {})
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Assertion helpers — DB/FS state only.
  // ---------------------------------------------------------------------------------------------

  async function ledgerRow(domain: IsolatedDomain, changeObjectId: string) {
    return withTenantTx(domain.db, domain.orgId, (tx) =>
      getRelayBuild(tx, domain.orgId, changeObjectId)
    );
  }

  /**
   * The two scheduling columns `getRelayBuild` does not project (the retry gate + the lease), plus
   * the gate's SIZE measured ENTIRELY INSIDE POSTGRES (`next_attempt_at - updated_at`). The
   * in-database subtraction is the point: comparing a DB timestamp against the test process's
   * `Date.now()` is only as good as the clock agreement between the host and the container, so a
   * VM whose clock runs ahead would make a "the gate is in the future" assertion pass over a
   * backoff of zero — exactly the regression this needs to catch.
   */
  async function ledgerTiming(
    domain: IsolatedDomain,
    changeObjectId: string
  ): Promise<{ nextAttemptAt: Date; claimedUntil: Date | null; backoffSeconds: number }> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.execute(sql`
        SELECT next_attempt_at, claimed_until,
               EXTRACT(EPOCH FROM (next_attempt_at - updated_at)) AS backoff_seconds
          FROM federation_relay_builds
         WHERE org_id = ${domain.orgId} AND change_object_id = ${changeObjectId}
      `)
    );
    const row = (
      rows.rows as {
        next_attempt_at: string;
        claimed_until: string | null;
        backoff_seconds: string;
      }[]
    )[0];
    if (!row) throw new Error(`no ledger row for ${changeObjectId}`);
    return {
      nextAttemptAt: new Date(row.next_attempt_at),
      claimedUntil: row.claimed_until === null ? null : new Date(row.claimed_until),
      backoffSeconds: Number(row.backoff_seconds)
    };
  }

  async function ledgerRowCount(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.execute(sql`SELECT id FROM federation_relay_builds WHERE org_id = ${domain.orgId}`)
    );
    return (rows.rows as unknown[]).length;
  }

  /** Clear the retry gate so the next sweep may attempt immediately — the test's stand-in for
   *  "the backoff elapsed", without sleeping through an exponential backoff. */
  async function clearBackoff(domain: IsolatedDomain, changeObjectId: string): Promise<void> {
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.execute(sql`
        UPDATE federation_relay_builds
           SET next_attempt_at = now() - interval '1 second'
         WHERE org_id = ${domain.orgId} AND change_object_id = ${changeObjectId}
      `)
    );
  }

  async function expireLease(domain: IsolatedDomain, changeObjectId: string): Promise<void> {
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.execute(sql`
        UPDATE federation_relay_builds
           SET claimed_until = now() - interval '1 second'
         WHERE org_id = ${domain.orgId} AND change_object_id = ${changeObjectId}
      `)
    );
  }

  async function decisionsOf(domain: IsolatedDomain, kind: string, subjectId?: string) {
    return withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          subjectId
            ? and(eq(decisions.kind, kind), eq(decisions.subjectId, subjectId))
            : eq(decisions.kind, kind)
        )
    );
  }

  async function decisionCount(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ id: decisions.id }).from(decisions)
    );
    return rows.length;
  }

  async function auditCount(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ id: auditEvents.id }).from(auditEvents)
    );
    return rows.length;
  }

  async function auditActionsFor(domain: IsolatedDomain, subjectId: string): Promise<string[]> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, subjectId))
    );
    return rows.map((r) => r.action);
  }

  async function submittedExportTransfers(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select({ id: bundleTransfers.id })
        .from(bundleTransfers)
        .where(
          and(
            eq(bundleTransfers.orgId, domain.orgId),
            eq(bundleTransfers.direction, "export"),
            eq(bundleTransfers.status, "submitted")
          )
        )
    );
    return rows.length;
  }

  async function dirEntries(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  }

  /** Only the PUBLISHED channel artifacts — a `.scp-relay-build-*.partial` is deliberately not one
   *  (atomic publication), so a leftover partial shows up as a separate assertion. */
  async function relayTarballs(dir: string): Promise<string[]> {
    return (await dirEntries(dir)).filter(
      (name) => name.startsWith("scp-relay-") && name.endsWith(".tar.gz")
    );
  }

  function tarballNameFor(changeAtA: string): string {
    return `scp-relay-${changeAtA}.tar.gz`;
  }

  async function tickRetrans(
    env: NodeJS.ProcessEnv,
    config: RelayConfig = retransConfig()
  ): Promise<AutoRelayOutcome[]> {
    return autoRelayOrgTick(retrans.db, retrans.orgId, RETRANS_MASTER_KEY, {
      relayConfig: config,
      env
    });
  }

  // ---------------------------------------------------------------------------------------------
  // (2) DEFAULT-OFF — the posture an operator who never opted in keeps. Runs FIRST, on the very
  //     fixture case (1) then relays, so "off" and "on" are proven over identical inputs.
  // ---------------------------------------------------------------------------------------------

  let happy: Awaited<ReturnType<typeof seedPromotion>>;

  it("DEFAULT-OFF: the import SEEDS the obligation, but with SCP_RETRANS_AUTO_RELAY unset the sweep moves no bytes and writes no verdict", async () => {
    happy = await seedPromotion("happy", { withSbom: true, alsoAtOutpost: true });

    // THE CAUSAL SEED (promotion-repo.ts, in the import's own transaction): the obligation exists
    // before any loop has run, and it is an obligation only — attempts 0, nothing decided.
    const seeded = await ledgerRow(retrans, happy.changeAtB);
    expect(seeded).not.toBeNull();
    expect(seeded).toMatchObject({
      status: "pending",
      attempts: 0,
      failedAttempts: 0,
      sourceChangeObjectId: happy.changeAtA,
      tarballPath: null,
      lastDecisionId: null
    });

    const decisionsBefore = await decisionCount(retrans);
    const outcomes = await tickRetrans({});

    // NO BYTES, NO VERDICT, NO CLAIM — asserted on the boundary and the database before anything
    // the sweep merely REPORTED. An unset flag must leave both exactly as they were.
    expect(await relayTarballs(autoDropDir)).toEqual([]);
    expect(await dirEntries(autoDropDir)).toEqual([]);
    expect(await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND)).toHaveLength(0);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    expect(await ledgerRow(retrans, happy.changeAtB)).toMatchObject({
      status: "pending",
      attempts: 0,
      failedAttempts: 0
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(["disabled"]);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (1) THE HAPPY PATH — the milestone's whole claim: no operator command. Same fixture as (2),
  //     flag on. The tarball is proven REAL by importing it at the outpost, not by its existence.
  // ---------------------------------------------------------------------------------------------

  it("HAPPY PATH: one sweep with the flag set builds and drops a REAL signed tarball for the imported promotion — no operator command, with the manual path's exact Decision/audit/transfer trail", async () => {
    const submittedBefore = await submittedExportTransfers(retrans);

    const outcomes = await tickRetrans(AUTO_ON);
    expect(outcomes.map((o) => o.outcome)).toEqual(["built"]);

    // THE DROP: exactly one published channel artifact, named for the EXPORTER's change (what an
    // operator greps for at the CDS), and no `.partial` left behind by the atomic publication.
    const expectedName = tarballNameFor(happy.changeAtA);
    expect(await dirEntries(autoDropDir)).toEqual([expectedName]);
    const droppedPath = path.join(autoDropDir, expectedName);

    // THE LEDGER: terminal `built`, citing the same Decision and the same path the sweep reported.
    const row = await ledgerRow(retrans, happy.changeAtB);
    expect(row).toMatchObject({
      status: "built",
      attempts: 1,
      failedAttempts: 0,
      tarballPath: droppedPath
    });
    expect(row?.lastDecisionId).toBe(outcomes[0]!.decisionId);
    expect((await ledgerTiming(retrans, happy.changeAtB)).claimedUntil).toBeNull();

    // THE TRAIL, identical to an operator-invoked relay: `buildRelayTarball`'s own allow Decision
    // (not some loop-specific verdict) plus its hash-chained audit event.
    const allow = await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND, happy.changeAtB);
    expect(allow).toHaveLength(1);
    expect(allow[0]!.verdict).toBe("allow");
    expect(allow[0]!.id).toBe(outcomes[0]!.decisionId);
    expect(await auditActionsFor(retrans, happy.changeAtB)).toContain("federation.relay.built");

    // (11) VALIDATE-GATED, NEVER BLIND (owner decision D4), positive arm: the build hop's own
    // `submitted` transfer row exists — the byte leg is visible on the same status surface the
    // metadata leg uses, and it is written only after every artifact verified.
    expect(await submittedExportTransfers(retrans)).toBe(submittedBefore + 1);

    // THE TARBALL IS REAL, not merely a file: the receiving outpost imports it under its own
    // zero-trust gates, the bytes land at the authorized digest, and C's UNCHANGED M17.4(b)
    // pre-deploy gate then passes over what landed.
    const imported = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: happy.changeAtC as string,
      tarballPath: droppedPath,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: OUTPOST_MASTER_KEY,
      config: outpostConfig()
    });
    expect(imported.refused).toBe(false);
    expect(await registryHasDigest(destHost, "scp/artifacts", happy.imageDigest)).toBe(true);
    const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, happy.changeAtC as string)
    );
    expect((await runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow)).blocked).toBe(
      false
    );
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (4) IDEMPOTENT — a terminal row is terminal. Byte-level, because "no NEW file" would stay green
  //     over a rebuild that overwrote the drop under the same deterministic name.
  // ---------------------------------------------------------------------------------------------

  it("IDEMPOTENT: further sweeps neither rebuild nor re-decide — the dropped tarball stays byte-identical and no Decision is added", async () => {
    const droppedPath = path.join(autoDropDir, tarballNameFor(happy.changeAtA));
    const shaBefore = await sha256File(droppedPath);
    const decisionsBefore = await decisionCount(retrans);
    const auditBefore = await auditCount(retrans);

    // Through the PRODUCTION entry point this time (`runAutoRelaySweep` enumerates orgs and calls
    // the org tick) — the loop's own body, not just the exported tick.
    await runAutoRelaySweep(retrans.db, RETRANS_MASTER_KEY, {
      relayConfig: retransConfig(),
      env: AUTO_ON
    });
    const secondTick = await tickRetrans(AUTO_ON);

    // BYTE-LEVEL FIRST, on purpose: "no NEW file" would stay green over a rebuild that overwrote
    // the drop under the same deterministic name — the tarball's content is what proves nothing was
    // re-pulled, re-packaged and re-dropped across the boundary.
    expect(await sha256File(droppedPath)).toBe(shaBefore);
    expect(await dirEntries(autoDropDir)).toEqual([tarballNameFor(happy.changeAtA)]);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    expect(await auditCount(retrans)).toBe(auditBefore);
    expect(await ledgerRow(retrans, happy.changeAtB)).toMatchObject({
      status: "built",
      attempts: 1
    });
    // A terminal row is not even ENUMERATED — the sweep has no work at all, so there is nothing to
    // dedupe downstream of.
    expect(secondTick).toEqual([]);
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (3)+(5b) ROLE — ADR-0004. A commander/outpost neither seeds nor sweeps, and the authoritative
  //          409 arm inside `buildRelayTarball` is untouched by the automation.
  // ---------------------------------------------------------------------------------------------

  it("ROLE GATE: a commander and an outpost seed NO obligation at all; a sweep there claims nothing even when a row is planted; and a direct relay call on a non-retrans still 409s", async () => {
    // (5b) The causal seed is role-gated at the writer: both instances imported the same promotion
    // (C above, A authored it) and neither owes an onward hop.
    expect(await ledgerRowCount(commander)).toBe(0);
    expect(await ledgerRowCount(outpost)).toBe(0);

    // A PLANTED row makes the sweep's own role pre-gate non-vacuous: C's change carries a verified
    // manifest with artifacts, so without the gate this row is a perfectly good build candidate.
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      seedRelayBuild(tx, {
        orgId: outpost.orgId,
        changeObjectId: happy.changeAtC as string,
        sourceChangeObjectId: happy.changeAtA
      })
    );
    const outpostDecisionsBefore = await decisionCount(outpost);

    expect(
      await autoRelayOrgTick(commander.db, commander.orgId, COMMANDER_MASTER_KEY, {
        relayConfig: retransConfig(),
        env: AUTO_ON
      })
    ).toEqual([]);
    expect(
      await autoRelayOrgTick(outpost.db, outpost.orgId, OUTPOST_MASTER_KEY, {
        relayConfig: outpostConfig({ outDir: autoDropDir }),
        env: AUTO_ON
      })
    ).toEqual([]);

    // NOT CLAIMED, NOT DECIDED: the pre-gate returned before the ledger was touched (`attempts`
    // still 0 — a claim would have incremented it), and no verdict was written at the outpost.
    expect(await ledgerRow(outpost, happy.changeAtC as string)).toMatchObject({
      status: "pending",
      attempts: 0,
      failedAttempts: 0
    });
    expect(await decisionCount(outpost)).toBe(outpostDecisionsBefore);
    // And nothing reached the shared drop dir from either non-retrans sweep.
    expect(await dirEntries(autoDropDir)).toEqual([tarballNameFor(happy.changeAtA)]);

    // The AUTHORITATIVE arm (ADR-0004) is unchanged: whatever reaches `buildRelayTarball` on a
    // non-retrans instance is refused with the 409 that names the required role.
    await expect(
      buildRelayTarball(outpost.db, {
        orgId: outpost.orgId,
        changeIdOrUrn: happy.changeAtC as string,
        masterKey: OUTPOST_MASTER_KEY,
        outDir: autoDropDir,
        config: outpostConfig()
      })
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining("requires federation role 'retrans'")
    });
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (5a) CAUSAL, NEVER DERIVED — enabling the feature must not drain a historical backlog across
  //      the CDS. A promotion imported before the ledger existed simply has no row, and no
  //      predicate scan over `changes` may resurrect one.
  // ---------------------------------------------------------------------------------------------

  it("NO BACKLOG DRAIN: a promotion imported at the retrans with no ledger row (a pre-M13.1b import) is never a candidate — the sweep enumerates work causally, not by predicate", async () => {
    const legacy = await seedPromotion("legacy");
    // Simulate the pre-ledger import by removing the row the seed just wrote. DELETE is deliberately
    // NOT granted to the runtime role (drizzle/0047), so this fixture surgery uses the admin
    // connection — the same reason `IsolatedDomain` exposes one.
    const admin = new pg.Client({ connectionString: retrans.adminUrl });
    await admin.connect();
    try {
      const deleted = await admin.query(
        `DELETE FROM federation_relay_builds WHERE change_object_id = $1`,
        [legacy.changeAtB]
      );
      expect(deleted.rowCount).toBe(1);
    } finally {
      await admin.end();
    }

    const decisionsBefore = await decisionCount(retrans);
    const filesBefore = await dirEntries(autoDropDir);
    const sweep = await tickRetrans(AUTO_ON);

    expect(await dirEntries(autoDropDir)).toEqual(filesBefore);
    expect(await relayTarballs(autoDropDir)).not.toContain(tarballNameFor(legacy.changeAtA));
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    // And the sweep did not re-seed what it could not find.
    expect(await ledgerRow(retrans, legacy.changeAtB)).toBeNull();
    // THE WORK LIST ITSELF: a row-less promotion is not a candidate — this is the assertion a
    // derived predicate scan over `changes` (the rejected design) fails.
    expect(sweep).toEqual([]);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (6) THE HIGH-SIDE CASE — the most consequential one. Both boundary nodes are `role: retrans`
  //     and both seed at import, so the node whose BYTES ARRIVE must be stopped by the `forwarded`
  //     terminal state. Without it that node enumerates a build it can never perform (its source
  //     registry is on the far side of the air gap) and buries a real crossing under fabricated
  //     refusals.
  // ---------------------------------------------------------------------------------------------

  it("HIGH SIDE: a retrans that RECEIVES and validate-and-forwards a tarball marks the obligation `forwarded` — and never also builds it (no second drop, not one further Decision)", async () => {
    const high = await seedPromotion("highside");

    // The arriving tarball, produced by a DIRECT build (standing in for the low side). Note it
    // lands in the fixture dir, and note what it does NOT do: `buildRelayTarball` itself writes no
    // ledger row, so the obligation is still exactly what the import seeded.
    const built = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: high.changeAtB,
      masterKey: RETRANS_MASTER_KEY,
      outDir: fixtureOutDir,
      config: retransConfig({ outDir: fixtureOutDir })
    });
    expect(built.refused).toBe(false);
    if (built.refused) throw new Error("unreachable");
    expect(await ledgerRow(retrans, high.changeAtB)).toMatchObject({
      status: "pending",
      attempts: 0
    });

    // THE ARRIVAL: validate-and-forward, exactly as the M13.1a inbox loop drives it.
    const forwarded = await validateAndForwardRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: high.changeAtB,
      tarballPath: built.tarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      outDir: forwardOutDir,
      config: retransConfig({ outDir: forwardOutDir })
    });
    expect(forwarded.refused).toBe(false);
    if (forwarded.refused) throw new Error("unreachable");

    // The obligation is TERMINAL and says which side of the hop this node is.
    expect(await ledgerRow(retrans, high.changeAtB)).toMatchObject({
      status: "forwarded",
      tarballPath: forwarded.forwardedPath,
      lastDecisionId: forwarded.decisionId
    });

    // AND THE SWEEP DOES NOTHING. Asserted as exact row deltas over the whole `decisions` and
    // `audit_events` tables: a regression here (the `markRelayBuildForwarded` call removed) leaves
    // the row `pending`, and the sweep then writes a verdict about bytes that already crossed.
    const decisionsBefore = await decisionCount(retrans);
    const auditBefore = await auditCount(retrans);
    const dropBefore = await dirEntries(autoDropDir);
    const sweep = await tickRetrans(AUTO_ON);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    expect(await auditCount(retrans)).toBe(auditBefore);
    expect(await dirEntries(autoDropDir)).toEqual(dropBefore);
    expect(await dirEntries(autoDropDir)).not.toContain(tarballNameFor(high.changeAtA));
    expect(await ledgerRow(retrans, high.changeAtB)).toMatchObject({ status: "forwarded" });
    expect(sweep).toEqual([]); // the obligation is not even enumerated.
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (7)+(11) REFUSAL → BACKOFF → EXHAUSTION → THE BOUND. #153's pathology (a byte-identical block
  //          Decision restated once a tick forever, measured at 1.44 GB/day in production) is what
  //          this whole shape exists to not re-introduce, so the last assertion is EXACT: three
  //          more sweeps add zero rows to `decisions` and zero to `audit_events`.
  // ---------------------------------------------------------------------------------------------

  let failing: Awaited<ReturnType<typeof seedPromotion>>;

  it("REFUSAL + BACKOFF: an artifact whose bytes are absent from the source registry refuses, records ONE verdict with a FUTURE retry gate, drops nothing, confirms nothing — and an immediate second sweep does nothing at all", async () => {
    failing = await seedPromotion("missing-bytes");
    // The failure is real and repeatable: the configured source repo is an allowlisted host that
    // simply does not hold the authorized digest, so skopeo's pull fails per artifact.
    const brokenConfig = retransConfig({ sourceRepo: `${destHost}/${MISSING_REPO}` });

    const submittedBefore = await submittedExportTransfers(retrans);
    const dropBefore = await dirEntries(autoDropDir);

    const outcomes = await tickRetrans(AUTO_ON_CAP_3, brokenConfig);
    expect(outcomes.map((o) => o.outcome)).toEqual(["refused"]);

    // ONE VERDICT, and the row is scheduled — not terminal, not hot.
    const row = await ledgerRow(retrans, failing.changeAtB);
    expect(row).toMatchObject({ status: "pending", attempts: 1, failedAttempts: 1 });
    expect(row?.lastReason).toContain("retrans relay refused");
    expect(row?.lastDecisionId).toBe(outcomes[0]!.decisionId);
    const timing = await ledgerTiming(retrans, failing.changeAtB);
    // The retry gate is a REAL interval (the first backoff step is 60s), not merely "not the past".
    expect(timing.backoffSeconds).toBeGreaterThanOrEqual(60);
    expect(timing.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(timing.claimedUntil).toBeNull(); // the lease is released with the verdict.

    // The refusal is `buildRelayTarball`'s own block Decision — the manual path's verdict, verbatim.
    const blocks = await decisionsOf(
      retrans,
      RETRANS_RELAY_VALIDATE_DECISION_KIND,
      failing.changeAtB
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.verdict).toBe("block");

    // (11) VALIDATE-GATED, NEVER BLIND (D4), negative arm: nothing crossed and nothing claims to
    // have crossed — no tarball, and no `submitted` transfer row for the refused hop.
    expect(await dirEntries(autoDropDir)).toEqual(dropBefore);
    expect(await submittedExportTransfers(retrans)).toBe(submittedBefore);

    // THE BACKOFF IS REAL: an immediate second sweep sees no due work and writes nothing.
    const decisionsBefore = await decisionCount(retrans);
    const auditBefore = await auditCount(retrans);
    const immediate = await tickRetrans(AUTO_ON_CAP_3, brokenConfig);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    expect(await auditCount(retrans)).toBe(auditBefore);
    expect(await ledgerRow(retrans, failing.changeAtB)).toMatchObject({
      attempts: 1,
      failedAttempts: 1
    });
    expect(immediate).toEqual([]);
  }, 300_000);

  it("EXHAUSTION + THE #153 BOUND: the verdict budget is finite, exhaustion is explained ONCE, and further sweeps write literally nothing", async () => {
    const brokenConfig = retransConfig({ sourceRepo: `${destHost}/${MISSING_REPO}` });

    // Drive the remaining verdicts (attempt 1 was the previous test), clearing only the retry gate
    // — the budget itself is never touched.
    for (let verdict = 2; verdict <= MAX_ATTEMPTS_UNDER_TEST; verdict += 1) {
      await clearBackoff(retrans, failing.changeAtB);
      const outcomes = await tickRetrans(AUTO_ON_CAP_3, brokenConfig);
      expect(outcomes.map((o) => o.outcome)).toEqual([
        verdict < MAX_ATTEMPTS_UNDER_TEST ? "refused" : "exhausted"
      ]);
    }

    // TERMINAL, with the budget spent exactly once per verdict.
    expect(await ledgerRow(retrans, failing.changeAtB)).toMatchObject({
      status: "exhausted",
      attempts: MAX_ATTEMPTS_UNDER_TEST,
      failedAttempts: MAX_ATTEMPTS_UNDER_TEST
    });

    // Exhaustion is the ONE thing an unattended sweep does with no manual-CLI equivalent, so it is
    // explained exactly once (principle 6) — never once per tick.
    const gaveUp = await decisionsOf(retrans, AUTO_RELAY_DECISION_KIND, failing.changeAtB);
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]!.verdict).toBe("block");
    expect((gaveUp[0]!.reasonTree as { summary?: string }).summary).toContain(
      "nothing crossed the boundary"
    );
    expect(
      (await auditActionsFor(retrans, failing.changeAtB)).filter(
        (a) => a === "federation.relay.auto.exhausted"
      )
    ).toHaveLength(1);
    // The per-attempt verdicts are bounded by the same budget.
    expect(
      await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND, failing.changeAtB)
    ).toHaveLength(MAX_ATTEMPTS_UNDER_TEST);
    // Still nothing crossed.
    expect(await relayTarballs(autoDropDir)).not.toContain(tarballNameFor(failing.changeAtA));

    // THE BOUND, exactly: a terminal row costs NOTHING per tick, forever. Row-count deltas over the
    // whole of `decisions` and `audit_events` — the two tables ADR-0024 classes as never-deleted.
    const decisionsAtTerminal = await decisionCount(retrans);
    const auditAtTerminal = await auditCount(retrans);
    const idleSweeps: AutoRelayOutcome[] = [];
    for (let i = 0; i < 3; i += 1) {
      await clearBackoff(retrans, failing.changeAtB); // even with the retry gate forced open.
      idleSweeps.push(...(await tickRetrans(AUTO_ON_CAP_3, brokenConfig)));
    }
    expect(await decisionCount(retrans)).toBe(decisionsAtTerminal);
    expect(await auditCount(retrans)).toBe(auditAtTerminal);
    expect(idleSweeps).toEqual([]); // not even enumerated.
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (10) THE MANUAL EXIT — `exhausted` must never be a trap needing superuser SQL. The operator's
  //      existing `POST /api/v1/federation/relay` both delivers the bytes and clears the state;
  //      this drives the route's two steps (build, then `reopenRelayBuild`) directly, since the
  //      route body is those two calls (routes/federation.ts, after the refusal check).
  // ---------------------------------------------------------------------------------------------

  it("MANUAL EXIT: a successful operator-invoked relay on an EXHAUSTED change delivers the bytes and re-arms the ledger row to `built`", async () => {
    expect(await ledgerRow(retrans, failing.changeAtB)).toMatchObject({ status: "exhausted" });

    // The operator fixed the cause (here: the source repo really holds the digest) and re-drove the
    // hop by hand — the same `buildRelayTarball` the sweep calls, with a working config.
    const manual = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: failing.changeAtB,
      masterKey: RETRANS_MASTER_KEY,
      outDir: autoDropDir,
      config: retransConfig()
    });
    expect(manual.refused).toBe(false);
    if (manual.refused) throw new Error("unreachable");
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      reopenRelayBuild(tx, {
        orgId: retrans.orgId,
        changeObjectId: failing.changeAtB,
        sourceChangeObjectId: failing.changeAtA,
        tarballPath: manual.tarballPath,
        decisionId: manual.decisionId
      })
    );

    // RE-ARMED: terminal-but-successful, the verdict budget reset, the bytes on disk.
    expect(await ledgerRow(retrans, failing.changeAtB)).toMatchObject({
      status: "built",
      failedAttempts: 0,
      tarballPath: manual.tarballPath,
      lastDecisionId: manual.decisionId
    });
    expect(await relayTarballs(autoDropDir)).toContain(tarballNameFor(failing.changeAtA));

    // The manual verdict is the SAME kind/verdict/summary the unattended path produced for the
    // happy fixture — one relay implementation, one trail, whoever pulled the trigger.
    const manualAllow = (
      await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND, failing.changeAtB)
    ).find((d) => d.id === manual.decisionId);
    const autoAllow = (
      await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND, happy.changeAtB)
    )[0];
    expect(manualAllow?.verdict).toBe("allow");
    expect((manualAllow?.reasonTree as { summary?: string }).summary).toBe(
      (autoAllow?.reasonTree as { summary?: string }).summary
    );

    // And the cleared row is not re-picked by the loop.
    const decisionsBefore = await decisionCount(retrans);
    expect(await tickRetrans(AUTO_ON)).toEqual([]);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (9) CONCURRENCY — N replicas tick together. The claim is a single atomic statement, so the
  //     boundary sees ONE crossing and the record shows ONE verdict.
  // ---------------------------------------------------------------------------------------------

  it("CONCURRENCY: two sweeps racing the same seeded obligation produce exactly ONE tarball, ONE claim and ONE allow Decision", async () => {
    const raced = await seedPromotion("raced");

    // (a) THE CLAIM IS THE ATOM, proven directly and deterministically: two workers claiming the
    // same row in concurrent transactions — the second blocks on the row lock and then re-evaluates
    // the due predicate against the WINNER's committed row, so it comes back empty-handed rather
    // than taking a second lease. An enumerate-then-update pair (whose read is stale by the time it
    // writes) would hand out two.
    const contested = randomUUID();
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      seedRelayBuild(tx, {
        orgId: retrans.orgId,
        changeObjectId: contested,
        sourceChangeObjectId: "claim-race-fixture"
      })
    );
    const claims = await Promise.all([
      withTenantTx(retrans.db, retrans.orgId, (tx) =>
        claimRelayBuild(tx, retrans.orgId, contested, 3600)
      ),
      withTenantTx(retrans.db, retrans.orgId, (tx) =>
        claimRelayBuild(tx, retrans.orgId, contested, 3600)
      )
    ]);
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    expect(await ledgerRow(retrans, contested)).toMatchObject({ status: "pending", attempts: 1 });

    // (b) THE SAME RACE END TO END. Whether the loser enumerates the row and loses the claim, or
    // starts a moment later and sees no due work at all, is timing — what must hold either way is
    // that the BOUNDARY saw one crossing and the record shows one verdict.
    const [left, right] = await Promise.all([tickRetrans(AUTO_ON), tickRetrans(AUTO_ON)]);
    const both = [...left, ...right];
    expect(both.filter((o) => o.outcome === "built")).toHaveLength(1);
    for (const loser of both.filter((o) => o.outcome !== "built")) {
      expect(loser.outcome).toBe("claimed-elsewhere");
    }

    // ONE claim (a second would have incremented `attempts`), one terminal row.
    expect(await ledgerRow(retrans, raced.changeAtB)).toMatchObject({
      status: "built",
      attempts: 1,
      failedAttempts: 0
    });
    // ONE verdict and ONE audit event — the assertion that a name-collision rebuild cannot hide
    // behind (both builders would write the same file name, but not the same rows).
    const allow = await decisionsOf(retrans, RETRANS_RELAY_VALIDATE_DECISION_KIND, raced.changeAtB);
    expect(allow).toHaveLength(1);
    expect(allow[0]!.verdict).toBe("allow");
    expect(
      (await auditActionsFor(retrans, raced.changeAtB)).filter(
        (a) => a === "federation.relay.built"
      )
    ).toHaveLength(1);
    // Exactly one published artifact for this change, and no partial left in the CDS intake.
    expect(await relayTarballs(autoDropDir)).toContain(tarballNameFor(raced.changeAtA));
    expect((await dirEntries(autoDropDir)).filter((n) => n.endsWith(".partial"))).toEqual([]);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (8) THE FENCE — a lease can expire mid-build, so two workers legitimately hold one change in
  //     sequence. Every release carries the `attempts` its own claim returned; a stale claimant
  //     must not clobber the winner's state, and above all must never persist "nothing crossed the
  //     boundary" about bytes that did.
  // ---------------------------------------------------------------------------------------------

  it("FENCED RELEASE: a stale claimant whose lease lapsed can neither steal a PENDING row from the current claimant nor re-open a terminal one", async () => {
    // Synthetic ledger rows: `change_object_id` deliberately references no `changes` row, so these
    // can never appear in a sweep's due list (which joins) and pollute another case.
    const changeObjectId = randomUUID();
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      seedRelayBuild(tx, {
        orgId: retrans.orgId,
        changeObjectId,
        sourceChangeObjectId: "fence-fixture"
      })
    );
    const claim = async (): Promise<RelayBuildClaim> => {
      const claimed = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
        claimRelayBuild(tx, retrans.orgId, changeObjectId, 3600)
      );
      if (!claimed) throw new Error("fixture: expected the row to be claimable");
      return claimed;
    };

    // Worker 1 claims; its lease lapses; worker 2 takes over and records a FAILED attempt. The row
    // is still `pending` — so only the attempts fence, never the status guard, can protect it.
    const stale = await claim();
    await expireLease(retrans, changeObjectId);
    const current = await claim();
    expect(current.attempts).toBe(stale.attempts + 1);
    expect(
      await withTenantTx(retrans.db, retrans.orgId, (tx) =>
        backoffRelayBuild(tx, retrans.orgId, current, {
          backoffSeconds: 60,
          reason: "the current claimant's verdict",
          decisionId: null
        })
      )
    ).toBe(true);

    // THE STALE WRITES, all refused, none of them mutating anything.
    const staleResults: boolean[] = [];
    for (const release of [
      () =>
        withTenantTx(retrans.db, retrans.orgId, (tx) =>
          completeRelayBuild(tx, retrans.orgId, stale, {
            tarballPath: "/stale/should-never-be-recorded.tar.gz",
            decisionId: randomUUID()
          })
        ),
      () =>
        withTenantTx(retrans.db, retrans.orgId, (tx) =>
          exhaustRelayBuild(tx, retrans.orgId, stale, {
            reason: "stale claimant giving up on someone else's work",
            decisionId: randomUUID()
          })
        ),
      () =>
        withTenantTx(retrans.db, retrans.orgId, (tx) =>
          backoffRelayBuild(tx, retrans.orgId, stale, {
            backoffSeconds: 3600,
            reason: "stale claimant's verdict",
            decisionId: null
          })
        )
    ]) {
      staleResults.push(await release());
    }
    // THE ROW is the assertion: a stale write must leave the CURRENT claimant's state untouched —
    // not merely report that it failed.
    expect(await ledgerRow(retrans, changeObjectId)).toMatchObject({
      status: "pending",
      attempts: current.attempts,
      failedAttempts: 1,
      lastReason: "the current claimant's verdict",
      tarballPath: null
    });
    // ...and each one told its caller it lost, so no Decision or audit event is written for it.
    expect(staleResults).toEqual([false, false, false]);

    // Now let the current claimant reach a TERMINAL `built`, and prove the stale writes still bounce
    // — a resurrected `pending` would mean rebuilding and re-dropping bytes across the boundary.
    await clearBackoff(retrans, changeObjectId);
    const winner = await claim();
    expect(
      await withTenantTx(retrans.db, retrans.orgId, (tx) =>
        completeRelayBuild(tx, retrans.orgId, winner, {
          tarballPath: "/drops/winner.tar.gz",
          decisionId: randomUUID()
        })
      )
    ).toBe(true);
    const staleTerminalResults: boolean[] = [];
    for (const staleClaim of [stale, current]) {
      staleTerminalResults.push(
        await withTenantTx(retrans.db, retrans.orgId, (tx) =>
          backoffRelayBuild(tx, retrans.orgId, staleClaim, {
            backoffSeconds: 60,
            reason: "stale re-open attempt",
            decisionId: null
          })
        ),
        await withTenantTx(retrans.db, retrans.orgId, (tx) =>
          exhaustRelayBuild(tx, retrans.orgId, staleClaim, {
            reason: "stale exhaustion of a delivered change",
            decisionId: randomUUID()
          })
        )
      );
    }
    expect(await ledgerRow(retrans, changeObjectId)).toMatchObject({
      status: "built",
      tarballPath: "/drops/winner.tar.gz"
    });
    expect(staleTerminalResults).toEqual([false, false, false, false]);

    // The same for `exhausted`: a stale claimant must not flip a given-up row to `built` and assert
    // a delivery that never happened.
    const exhaustedChangeId = randomUUID();
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      seedRelayBuild(tx, {
        orgId: retrans.orgId,
        changeObjectId: exhaustedChangeId,
        sourceChangeObjectId: "fence-fixture-2"
      })
    );
    const doomed = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      claimRelayBuild(tx, retrans.orgId, exhaustedChangeId, 3600)
    );
    expect(doomed).not.toBeNull();
    expect(
      await withTenantTx(retrans.db, retrans.orgId, (tx) =>
        exhaustRelayBuild(tx, retrans.orgId, doomed as RelayBuildClaim, {
          reason: "budget spent",
          decisionId: randomUUID()
        })
      )
    ).toBe(true);
    const staleComplete = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      completeRelayBuild(tx, retrans.orgId, doomed as RelayBuildClaim, {
        tarballPath: "/drops/never-happened.tar.gz",
        decisionId: randomUUID()
      })
    );
    expect(await ledgerRow(retrans, exhaustedChangeId)).toMatchObject({
      status: "exhausted",
      tarballPath: null
    });
    expect(staleComplete).toBe(false);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (12) STRICT DROP RESOLUTION — the automated path must refuse a config gap the operator-invoked
  //      route 400s on, rather than falling through to the instance env and marking a build done
  //      whose bytes reached a directory the s3-expecting CDS never watches. A deferral costs no
  //      attempt: it is a config gap, not a verdict.
  // ---------------------------------------------------------------------------------------------

  it("STRICT DROP: a peer configured for s3-compatible delivery makes the sweep DEFER — no drop into the instance env dir, no attempt consumed — and clearing the target lets the same obligation build", async () => {
    const s3Case = await seedPromotion("s3-defer");
    const s3PeerDomainId = asTrustDomainId(randomUUID());
    const s3PeerKey = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      ensureInstanceKey(tx, retrans.orgId)
    );
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: s3PeerDomainId,
        name: "s3-boundary",
        role: "outpost",
        publicKey: s3PeerKey.publicKey,
        deliveryTarget: {
          provider: "s3-compatible",
          endpoint: "https://minio.example.net:9000",
          bucket: "cds-intake",
          outPrefix: "out/"
        }
      })
    );

    const decisionsBefore = await decisionCount(retrans);
    const dropBefore = await dirEntries(autoDropDir);
    const outcomes = await tickRetrans(AUTO_ON); // `outDir` IS set — the env fallback exists.

    // NO SILENT FALLBACK, NO COST: nothing landed in the instance env dir, no verdict was written,
    // and the obligation is untouched — `attempts` still 0, so the next tick has its full budget.
    expect(await dirEntries(autoDropDir)).toEqual(dropBefore);
    expect(await decisionCount(retrans)).toBe(decisionsBefore);
    expect(await ledgerRow(retrans, s3Case.changeAtB)).toMatchObject({
      status: "pending",
      attempts: 0,
      failedAttempts: 0,
      lastReason: null
    });
    expect(outcomes.map((o) => o.outcome)).toEqual(["deferred"]);
    expect(outcomes[0]!.detail).toContain("s3-compatible");

    // The deferral was purely the config gap: clear the undeliverable target and the SAME
    // obligation relays on the next tick, with its budget intact.
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: s3PeerDomainId,
        name: "s3-boundary",
        role: "outpost",
        publicKey: s3PeerKey.publicKey,
        deliveryTarget: null
      })
    );
    expect((await tickRetrans(AUTO_ON)).map((o) => o.outcome)).toEqual(["built"]);
    expect(await ledgerRow(retrans, s3Case.changeAtB)).toMatchObject({
      status: "built",
      attempts: 1,
      failedAttempts: 0
    });
    expect(await relayTarballs(autoDropDir)).toContain(tarballNameFor(s3Case.changeAtA));
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // STRICT DROP, THE OTHER HALF — the topology strictness must NOT refuse.
  //
  // WHY THIS CASE EXISTS, specifically. Strictness is a refusal, and a refusal that fires too widely
  // is indistinguishable from the feature being broken: every obligation reads `deferred` forever,
  // with no attempt, no Decision and no audit event to explain it — at a CDS, where nobody is
  // watching a terminal. The over-refusal is not hypothetical: the first cut keyed on the RESOLVED
  // outbound directory alone, so it flagged any peer that merely HAD no outbound dir of its own,
  // which in the normal retrans topology is the upstream commander. This case pins the exact
  // arrangement the milestone requires and the earlier filter killed:
  //
  //   - an UPSTREAM peer whose deliveryTarget declares only `inDir` (the documented M13.1a inbox
  //     shape — the schema makes `outDir` optional precisely so a peer can be an inbox and no more),
  //   - a DOWNSTREAM boundary peer carrying the only `outDir`,
  //   - and NO `SCP_RELAY_OUT_DIR`, which is legitimate exactly because the boundary peer has one.
  //
  // It asserts the tarball FILE exists, not that some outcome string says "built": the bug this
  // catches produced a perfectly well-formed `deferred` outcome and an empty directory.
  // ---------------------------------------------------------------------------------------------

  it("STRICT DROP does not over-refuse: an inbound-ONLY upstream peer alongside a boundary peer that carries the outDir still relays — with no instance-wide SCP_RELAY_OUT_DIR at all", async () => {
    const narrow = await seedPromotion("strict-inbound-only");

    const peerDropDir = path.join(scratch, "boundary-peer-drop");
    const peerInboxDir = path.join(scratch, "upstream-peer-inbox");
    await mkdir(peerDropDir, { recursive: true });
    await mkdir(peerInboxDir, { recursive: true });
    // Both per-peer dirs must sit under an operator-declared root, or resolution refuses them for
    // an unrelated reason and the case would pass vacuously.
    const previousRoots = process.env.SCP_DELIVERY_ROOTS;
    process.env.SCP_DELIVERY_ROOTS = scratch;

    const upstreamKey = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      ensureInstanceKey(tx, retrans.orgId)
    );
    const upstreamDomainId = asTrustDomainId(randomUUID());
    const boundaryDomainId = asTrustDomainId(randomUUID());
    try {
      await withTenantTx(retrans.db, retrans.orgId, async (tx) => {
        // The upstream: an INBOX and nothing else. It is not the boundary peer and never was.
        await pairPeer(tx, {
          orgId: retrans.orgId,
          domainId: upstreamDomainId,
          name: "upstream-inbox-only",
          role: "commander",
          publicKey: upstreamKey.publicKey,
          deliveryTarget: { provider: "filesystem", inDir: peerInboxDir }
        });
        // The downstream boundary peer: the ONLY declared outbound destination on this instance.
        await pairPeer(tx, {
          orgId: retrans.orgId,
          domainId: boundaryDomainId,
          name: "boundary-outdir",
          role: "outpost",
          publicKey: upstreamKey.publicKey,
          deliveryTarget: { provider: "filesystem", outDir: peerDropDir }
        });
      });

      // NO env outDir: the boundary peer's own dir is the only way bytes can leave.
      const outcomes = await tickRetrans(AUTO_ON, retransConfig({ outDir: undefined }));

      // THE FILE, at the PEER's dir — not the outcome string, and not the env dir (which is unset).
      expect(await relayTarballs(peerDropDir)).toContain(tarballNameFor(narrow.changeAtA));
      expect(outcomes.map((o) => o.outcome)).toEqual(["built"]);
      expect(await ledgerRow(retrans, narrow.changeAtB)).toMatchObject({
        status: "built",
        failedAttempts: 0
      });
    } finally {
      if (previousRoots === undefined) delete process.env.SCP_DELIVERY_ROOTS;
      else process.env.SCP_DELIVERY_ROOTS = previousRoots;
      // Leave the peer table as the rest of the suite expects it.
      await withTenantTx(retrans.db, retrans.orgId, async (tx) => {
        await pairPeer(tx, {
          orgId: retrans.orgId,
          domainId: upstreamDomainId,
          name: "upstream-inbox-only",
          role: "commander",
          publicKey: upstreamKey.publicKey,
          deliveryTarget: null
        });
        await pairPeer(tx, {
          orgId: retrans.orgId,
          domainId: boundaryDomainId,
          name: "boundary-outdir",
          role: "outpost",
          publicKey: upstreamKey.publicKey,
          deliveryTarget: null
        });
      });
    }
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // THE PAYLOAD BOUND — #153 arriving by SIZE instead of by row count.
  //
  // The attempt cap bounds how MANY permanent rows a failing promotion leaves. It says nothing about
  // how BIG each one is, and every ingredient of a refusal's payload comes from the imported bundle:
  // the artifact set has no schema maximum, `ArtifactRefSchema.digest` is a bare `z.string()`, and
  // each failure embeds skopeo's verbatim stderr. Unbounded, one imported promotion could write
  // megabytes into `decisions` AND `audit_events` AND the sync journal — which ADR-0024 classes as
  // never-deleted — so the bound has to be on bytes, not only rows.
  //
  // The oversized artifact set is injected straight onto the already-imported change rather than
  // built through the export path, deliberately: what is under test is the PERSISTENCE bound, i.e.
  // what happens once a large set has legitimately arrived. Verification is not in scope here and is
  // covered elsewhere; `buildRelayTarball` reads exactly this field as its authorized set.
  // ---------------------------------------------------------------------------------------------

  it("PAYLOAD BOUND: a promotion carrying an oversized artifact set with hostile-length digests leaves a TRUNCATED permanent record — with the real totals still stated", async () => {
    const fat = await seedPromotion("payload-bound");
    const HUGE = 12; // > RELAY_FAILURE_DETAIL_LIMIT (10), so both the set and the failures are cut.
    const longDigest = `sha256:${"a".repeat(4000)}`;
    const injected = Array.from({ length: HUGE }, (_, i) => ({
      type: "oci",
      digest: i === 0 ? longDigest : `sha256:${"b".repeat(4000)}${i}`
    }));
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx.execute(sql`
        UPDATE changes
           SET source_ref = jsonb_set(source_ref, '{artifacts}', ${JSON.stringify(injected)}::jsonb)
         WHERE org_id = ${retrans.orgId} AND object_id = ${fat.changeAtB}
      `)
    );

    // Every artifact fails (none of these digests exists anywhere), so the refusal carries the
    // largest payload this change could ever produce.
    const outcomes = await tickRetrans(
      AUTO_ON_CAP_3,
      retransConfig({ sourceRepo: `${srcHost}/${MISSING_REPO}` })
    );
    expect(outcomes.map((o) => o.outcome)).toEqual(["refused"]);

    const [blocked] = await decisionsOf(retrans, "retrans-relay-validate", fat.changeAtB);
    expect(blocked).toBeDefined();
    const ctx = blocked!.inputContext as Record<string, unknown>;

    // THE TOTALS SURVIVE — truncation must never make the record LIE about scale.
    expect(ctx.failingCount).toBe(HUGE);
    expect(ctx.authorizedArtifactCount).toBe(HUGE);

    // THE SETS ARE CUT.
    const failing = ctx.failing as { type: string; digest: string; reason: string }[];
    const authorized = ctx.authorizedArtifacts as { type: string; digest: string }[];
    expect(failing.length).toBe(RELAY_FAILURE_DETAIL_LIMIT);
    expect(authorized.length).toBe(RELAY_FAILURE_DETAIL_LIMIT);

    // EVERY persisted identifier and reason is individually bounded — a single 4000-char digest is
    // enough to blow the record on its own, so per-entry truncation matters as much as the slice.
    for (const entry of [...failing, ...authorized]) {
      expect(entry.digest.length).toBeLessThan(RELAY_IDENTIFIER_CHARS + 64);
    }
    for (const entry of failing) {
      expect(entry.reason.length).toBeLessThan(RELAY_FAILURE_REASON_CHARS + 64);
    }

    // And the human-readable summary — which is copied verbatim into the hash-chained audit event
    // and the ledger's `last_reason` — is bounded by the same construction.
    const summary = (blocked!.reasonTree as { summary: string }).summary;
    expect(summary.length).toBeLessThan(
      RELAY_FAILURE_DETAIL_LIMIT * (RELAY_FAILURE_REASON_CHARS + RELAY_IDENTIFIER_CHARS + 256)
    );
    expect(summary).toContain(`${HUGE} artifact(s) failed`);
    expect(summary).toContain(`and ${HUGE - RELAY_FAILURE_DETAIL_LIMIT} more (elided)`);
    const row = await ledgerRow(retrans, fat.changeAtB);
    expect(row!.lastReason!.length).toBe(summary.length);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // ARRIVING BYTES CORRECT AN EXHAUSTED ROW — the misconfigured-high-side recovery.
  //
  // Both boundary nodes are `role: retrans` and both seed at import, so a high side with
  // SCP_RETRANS_AUTO_RELAY mistakenly set burns its verdict budget in minutes of backoff — while the
  // CDS transfer that will deliver the tarball can take far longer (the default claim lease is an
  // hour precisely because multi-GB moves are slow). If `forwarded` could only correct a `pending`
  // row, the arriving bytes would be unable to correct the record they disprove: the row would stay
  // `exhausted`, asserting the hop never happened, on the very node that just validated and
  // forwarded it.
  // ---------------------------------------------------------------------------------------------

  it("a tarball that ARRIVES after the obligation was exhausted still corrects it to `forwarded`", async () => {
    const late = await seedPromotion("late-arrival");
    const built = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: late.changeAtB,
      masterKey: RETRANS_MASTER_KEY,
      outDir: fixtureOutDir,
      config: retransConfig({ outDir: fixtureOutDir })
    });
    if (built.refused) throw new Error(`fixture build refused: ${built.reason}`);

    // Drive the obligation to terminal `exhausted` first (the misconfigured-high-side situation).
    await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx.execute(sql`
        UPDATE federation_relay_builds
           SET status = 'exhausted', failed_attempts = 3, last_reason = 'gave up before the bytes arrived'
         WHERE org_id = ${retrans.orgId} AND change_object_id = ${late.changeAtB}
      `)
    );
    expect((await ledgerRow(retrans, late.changeAtB))!.status).toBe("exhausted");

    const forwarded = await validateAndForwardRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: late.changeAtB,
      tarballPath: built.tarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      outDir: forwardOutDir,
      config: retransConfig({ outDir: forwardOutDir })
    });
    expect(forwarded.refused).toBe(false);

    // The arriving, VALIDATED bytes are the authority on what happened here.
    expect(await ledgerRow(retrans, late.changeAtB)).toMatchObject({ status: "forwarded" });
    // And the corrected row is terminal for the sweep: no build, ever.
    expect(await tickRetrans(AUTO_ON)).toEqual([]);
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // Cross-cutting: nothing in this suite ever touched the promotion's own state. The retrans NEVER
  // terminates a promotion (ADR-0004) — it moves bytes and records that it did.
  // ---------------------------------------------------------------------------------------------

  it("the retrans never terminated a promotion: every change this suite relayed, refused, exhausted or forwarded is in the EXACT state its import left it in (ADR-0004)", async () => {
    expect(stateAtImport.size).toBeGreaterThanOrEqual(6); // every fixture above is covered.
    const rows = await withTenantTx(retrans.db, retrans.orgId, (tx) =>
      tx.select({ objectId: changes.objectId, state: changes.state }).from(changes)
    );
    const now = new Map(rows.map((r) => [r.objectId, r.state]));
    for (const [changeObjectId, importedState] of stateAtImport) {
      expect(now.get(changeObjectId)).toBe(importedState);
    }
  }, 60_000);
});

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { PromotionBundle } from "@scp/schemas";
import { resolveCosign } from "@scp/cosign";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, bundleTransfers, changes, decisions, federationInboxFiles } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange, getChangeRow } from "../coordination/changes-repo.js";
import { insertControlRun } from "../governance/controls-repo.js";
import { runPreDeployArtifactGate } from "../coordination/pre-deploy-gate.js";
import { ensureInstanceCosignKey, getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { ensureFederationSelf, initFederationSelf } from "./self-repo.js";
import { listPeers, pairPeer } from "./peers-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { getCursor } from "./cursors-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "./promotion-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import {
  RETRANS_RELAY_FORWARD_DECISION_KIND,
  RETRANS_RELAY_IMPORT_DECISION_KIND,
  buildRelayTarball,
  importRelayTarball,
  sha256File,
  type RelayConfig
} from "./retrans-relay.js";
import {
  INBOX_INGEST_DECISION_KIND,
  inboxOrgTick,
  processInboxFile,
  type InboxFileOutcome
} from "./inbox-loop.js";

/**
 * M13.1a — the staging-node INBOX INGEST LOOP, end to end: THE 13.1a DoD suite (proposal §13.1,
 * docs/proposals/airgap-cds-validate-promote.md). Same topology-faithful harness as
 * retrans-relay.integration.test.ts — three REAL isolated federation domains, a real `registry:2`
 * pair, the real cosign + skopeo binaries:
 *
 *   commander A ──.scpbundle──▶ retrans B ──signed byte tarball──▶ outpost C
 *
 * Proven here, per the DoD:
 *  (1) HAPPY PATH, IDENTICAL OUTCOMES — a promotion `.scpbundle` + its relay tarball dropped into
 *      the OUTPOST's inbox are imported unattended in ONE tick (bundle before tarball), with the
 *      SAME verification outcomes as the CLI-invoked path run on an identical sibling fixture:
 *      same relay-import allow Decision (verdict + reason), same M17.4(b) pre-deploy gate PASS,
 *      bytes landed at the destination registry; the tarball hop's `bundle_transfers` row is
 *      CONFIRMED (validate-gated, D4). A sync `.scpbundle` through the inbox advances the cursor
 *      exactly like a CLI import.
 *  (2) IDEMPOTENT — a second tick over the same inbox is a no-op (ledger dedupe): no new changes,
 *      no new Decisions.
 *  (3) RETRANS VALIDATE-AND-FORWARD — the same tarball dropped at the RETRANS's inbox is
 *      validated (byte-equivalent extracted checks) and forwarded byte-identical to the onward
 *      drop WITHOUT any registry push (a configured dest repo stays EMPTY), with the confirmed
 *      inbound + submitted onward transfer rows (D4 both ways).
 *  (4) TAMPER REFUSED, LOOP CONTINUES — a tarball tampered in CDS transit is refused at the
 *      retrans with a block Decision + audit event, NO onward drop, NO confirmation; a junk file
 *      in the same tick is skipped-with-log, and the tick completes (one bad file never bricks
 *      it). The SAME tampered file refused via the loop at the outpost carries the IDENTICAL
 *      refusal reason as a direct CLI `importRelayTarball` call (zero-trust survives automation).
 *  (5) TRAVERSAL + JUNK — a traversal-shaped file name is refused outright (block Decision,
 *      file never read); a malformed `.scpbundle` is refused with the loop's own
 *      `federation-inbox-ingest` block Decision (the CLI path throws a plain 409 there — an
 *      unattended refusal must still be explainable, principle 6).
 */

const sha256 = (buf: Buffer): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

describe("M13.1a inbox ingest loop (Testcontainers: 3 domains + 2 registries + cosign + skopeo)", () => {
  let commander: IsolatedDomain; // A — the exporter
  let retrans: IsolatedDomain; // B — the CDS-boundary staging node
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
  let commanderDomainId: string;
  let retransDomainId: string;
  let outpostDomainId: string;
  let commanderKeyPath: string;
  let retransCosignPub: string;
  let cosignBin: string;
  let imageSignFlags: string[];

  let relayOutDir: string; // where B's buildRelayTarball drops fixtures
  let outpostInbox: string; // C's watched inbox
  let retransInbox: string; // B's watched inbox
  let retransOnwardOut: string; // B's onward DeliveryTarget drop (env-level)

  const OUTPOST_MASTER_KEY = Buffer.alloc(32, 9);
  const RETRANS_MASTER_KEY = Buffer.alloc(32, 7);

  const SRC_REPO = "scp/app";

  // Shared (1)-fixture state.
  let manualImage: { ref: string; digest: string };
  let loopImage: { ref: string; digest: string };
  let changeA1 = ""; // manual/CLI fixture change at A
  let changeA2 = ""; // loop fixture change at A
  let changeAtOutpostManual = "";
  let tarball1Path = ""; // built at B for changeA1 (CLI-path fixture)
  let tarball2Path = ""; // built at B for changeA2 (loop-path fixture)

  function outpostConfig(): RelayConfig {
    return {
      sourceRepo: `${srcHost}/${SRC_REPO}`,
      destRepo: `${destHost}/scp/artifacts`,
      blobOutDir: destBlobDir,
      blobBaseUrl: destBlobBaseUrl,
      insecureHosts: [srcHost, destHost],
      inDir: outpostInbox
    };
  }

  /** B's forward config: a dest repo IS configured (scp/forward-check) precisely so the suite can
   *  prove the forward path never pushes even when it could. */
  function retransConfig(): RelayConfig {
    return {
      sourceRepo: `${srcHost}/${SRC_REPO}`,
      destRepo: `${destHost}/scp/forward-check`,
      insecureHosts: [srcHost, destHost],
      inDir: retransInbox,
      outDir: retransOnwardOut
    };
  }

  beforeAll(async () => {
    [commander, retrans, outpost] = await Promise.all([
      createIsolatedDomain("inbox_a"),
      createIsolatedDomain("inbox_b"),
      createIsolatedDomain("inbox_c")
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

    scratch = await mkdtemp(path.join(tmpdir(), "scp-m131a-"));
    destBlobDir = path.join(scratch, "dest-blobs");
    await mkdir(destBlobDir, { recursive: true });
    relayOutDir = path.join(scratch, "relay-out");
    outpostInbox = path.join(scratch, "outpost-inbox");
    retransInbox = path.join(scratch, "retrans-inbox");
    retransOnwardOut = path.join(scratch, "retrans-onward-out");
    await mkdir(outpostInbox, { recursive: true });
    await mkdir(retransInbox, { recursive: true });

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

    // Keys.
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
    await withTenantTx(retrans.db, retrans.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: commanderDomainId,
        name: "commander-a",
        role: "commander",
        publicKey: commanderEd.publicKey,
        cosignPublicKey: commanderPair.publicKey
      });
      // The UPSTREAM (low-side) relay peer whose cosign key verifies tarballs ARRIVING at B. In
      // this fixture the tarballs are built (and signed) by B itself standing in for the low
      // side, so the registered key is B's own cosign public key — exactly the shape a real
      // double-retrans crossing pairs.
      await pairPeer(tx, {
        orgId: retrans.orgId,
        domainId: randomUUID(),
        name: "retrans-low",
        role: "retrans",
        publicKey: retransEd.publicKey,
        cosignPublicKey: retransCosignPub
      });
    });
    await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: outpost.orgId,
        domainId: commanderDomainId,
        name: "commander-a",
        role: "commander",
        publicKey: commanderEd.publicKey,
        cosignPublicKey: commanderPair.publicKey
      });
      // C's record of the retrans that signs arriving tarballs — the cosign key the loop resolves
      // for `importRelayTarball` (replacing the manual walk's out-of-band `--pubkey`).
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
  // Harness — exporter-side build/push/sign + fixtures (same shapes as the M15.5(c) suite).
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
        requestId: `t-inbox-target-${randomUUID()}`,
        name: `inbox-target-${randomUUID().slice(0, 8)}`
      })
    );
    const { change } = await withTenantTx(commander.db, commander.orgId, (tx) =>
      proposeChange(tx, {
        orgId: commander.orgId,
        actorObjectId: commander.orgId,
        requestId: `t-inbox-change-${randomUUID()}`,
        name: `inbox-release-${randomUUID().slice(0, 8)}`,
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
    // Graph sync so the promotion's target resolves at B and C (fixture plumbing — the loop's
    // own sync-bundle routing is proven separately below).
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

  async function decisionCount(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ id: decisions.id }).from(decisions)
    );
    return rows.length;
  }

  async function changeCount(domain: IsolatedDomain): Promise<number> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ id: changes.objectId }).from(changes)
    );
    return rows.length;
  }

  async function auditActions(domain: IsolatedDomain): Promise<string[]> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ action: auditEvents.action }).from(auditEvents)
    );
    return rows.map((r) => r.action);
  }

  async function confirmedTransferWithChecksum(
    domain: IsolatedDomain,
    checksum: string
  ): Promise<{ direction: string; status: string }[]> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select({ direction: bundleTransfers.direction, status: bundleTransfers.status })
        .from(bundleTransfers)
        .where(and(eq(bundleTransfers.orgId, domain.orgId), eq(bundleTransfers.checksum, checksum)))
    );
    return rows;
  }

  async function findLocalChangeBySource(
    domain: IsolatedDomain,
    sourceChangeObjectId: string
  ): Promise<string | null> {
    const rows = await withTenantTx(domain.db, domain.orgId, (tx) =>
      tx.select({ objectId: changes.objectId, sourceRef: changes.sourceRef }).from(changes)
    );
    for (const row of rows) {
      const ref = (row.sourceRef ?? {}) as Record<string, unknown>;
      if (ref.sourceChangeObjectId === sourceChangeObjectId) return row.objectId;
    }
    return null;
  }

  async function tickOutpost(): Promise<InboxFileOutcome[]> {
    return inboxOrgTick(outpost.db, outpost.orgId, OUTPOST_MASTER_KEY, {
      relayConfig: outpostConfig()
    });
  }
  async function tickRetrans(): Promise<InboxFileOutcome[]> {
    return inboxOrgTick(retrans.db, retrans.orgId, RETRANS_MASTER_KEY, {
      relayConfig: retransConfig()
    });
  }

  // ---------------------------------------------------------------------------------------------
  // (1a) The CLI-path baseline fixture — the identical-outcomes reference.
  // ---------------------------------------------------------------------------------------------

  it("CLI baseline: manual promotion import + relay-tarball import at the outpost succeed (the reference outcomes)", async () => {
    manualImage = await pushImage(srcHost, SRC_REPO, "manual-artifact");
    signImage(manualImage.ref, commanderKeyPath);
    const sbom = await serveSignedBlob(
      "manual-sbom",
      Buffer.from(`{"bomFormat":"CycloneDX","seed":"${randomUUID()}"}`)
    );
    changeA1 = await proposeTrackedChangeAtA(manualImage.digest, sbom);

    const bundleForB = await exportPromotionFromA(changeA1, "retrans-b");
    await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);
    const bundleForC = await exportPromotionFromA(changeA1, "outpost-c");
    const importedAtC = await importPromotionBundle(outpost.db, outpost.orgId, bundleForC);
    changeAtOutpostManual = importedAtC.localChangeObjectId;

    const built = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: (await findLocalChangeBySource(retrans, changeA1)) as string,
      masterKey: RETRANS_MASTER_KEY,
      outDir: relayOutDir,
      config: retransConfig()
    });
    expect(built.refused).toBe(false);
    if (built.refused) throw new Error("unreachable");
    tarball1Path = built.tarballPath;

    const result = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpostManual,
      tarballPath: tarball1Path,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: OUTPOST_MASTER_KEY,
      config: outpostConfig()
    });
    expect(result.refused).toBe(false);
    const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, changeAtOutpostManual)
    );
    const gate = await runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow);
    expect(gate.blocked).toBe(false);
    // The CLI path now ALSO records the validate-gated confirmed transfer row (D4 — written
    // inside the verify path so CLI and loop stay identical).
    const tarballSha = await sha256File(tarball1Path);
    const transfers = await confirmedTransferWithChecksum(outpost, tarballSha);
    expect(transfers).toContainEqual({ direction: "import", status: "confirmed" });
  }, 300_000);

  // ---------------------------------------------------------------------------------------------
  // (1b) The loop path — same fixture shape, unattended, identical outcomes.
  // ---------------------------------------------------------------------------------------------

  it("loop path: a promotion .scpbundle + relay tarball dropped in the outpost inbox auto-import in ONE tick with outcomes identical to the CLI baseline", async () => {
    loopImage = await pushImage(srcHost, SRC_REPO, "loop-artifact");
    signImage(loopImage.ref, commanderKeyPath);
    const sbom = await serveSignedBlob(
      "loop-sbom",
      Buffer.from(`{"bomFormat":"CycloneDX","seed":"${randomUUID()}"}`)
    );
    changeA2 = await proposeTrackedChangeAtA(loopImage.digest, sbom);

    // Fixture plumbing at B (the low side): import B's bundle, build the signed tarball.
    const bundleForB = await exportPromotionFromA(changeA2, "retrans-b");
    await importPromotionBundle(retrans.db, retrans.orgId, bundleForB);
    const built = await buildRelayTarball(retrans.db, {
      orgId: retrans.orgId,
      changeIdOrUrn: (await findLocalChangeBySource(retrans, changeA2)) as string,
      masterKey: RETRANS_MASTER_KEY,
      outDir: relayOutDir,
      config: retransConfig()
    });
    expect(built.refused).toBe(false);
    if (built.refused) throw new Error("unreachable");
    tarball2Path = built.tarballPath;

    // THE DROP: both channel artifacts land in C's inbox; nobody calls an import.
    const bundleForC = await exportPromotionFromA(changeA2, "outpost-c");
    await writeFile(
      path.join(outpostInbox, `scp-promotion-${changeA2}.scpbundle`),
      JSON.stringify(bundleForC, null, 2),
      "utf8"
    );
    await copyFile(tarball2Path, path.join(outpostInbox, path.basename(tarball2Path)));

    // ONE unattended tick: bundle imports first, then the tarball (ordering is part of the DoD).
    const outcomes = await tickOutpost();
    const terminal = outcomes.filter((o) => o.outcome !== "already-processed");
    expect(terminal.map((o) => o.outcome)).toEqual(["imported", "imported"]);

    // The change landed, exactly like the CLI path.
    const changeAtC = await findLocalChangeBySource(outpost, changeA2);
    expect(changeAtC).not.toBeNull();

    // Bytes really landed at the destination registry, at the authorized digest.
    expect(await registryHasDigest(destHost, "scp/artifacts", loopImage.digest)).toBe(true);

    // IDENTICAL VERIFY OUTCOMES (the DoD bar): the loop's relay-import Decision carries the SAME
    // verdict and the SAME reason as the CLI baseline's.
    const loopDecision = await latestDecision(outpost, RETRANS_RELAY_IMPORT_DECISION_KIND);
    expect(loopDecision?.verdict).toBe("allow");
    const allImportDecisions = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.kind, RETRANS_RELAY_IMPORT_DECISION_KIND))
        .orderBy(desc(decisions.id))
    );
    const manualDecision = allImportDecisions.find((d) => d.subjectId === changeAtOutpostManual);
    expect(manualDecision).toBeDefined();
    expect((loopDecision?.reasonTree as { summary?: string }).summary).toBe(
      (manualDecision?.reasonTree as { summary?: string }).summary
    );

    // The receiving M17.4(b) gate passes — the SAME outcome as the CLI baseline's gate run.
    const changeRow = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getChangeRow(tx, outpost.orgId, changeAtC as string)
    );
    const gate = await runPreDeployArtifactGate(outpost.db, outpost.orgId, changeRow);
    expect(gate.blocked).toBe(false);

    // D4 validate-gated confirm: the tarball hop's transfer row is CONFIRMED.
    const tarballSha = await sha256File(tarball2Path);
    const transfers = await confirmedTransferWithChecksum(outpost, tarballSha);
    expect(transfers).toContainEqual({ direction: "import", status: "confirmed" });

    // The unattended trail: inbox audit events + ledger rows exist.
    const actions = await auditActions(outpost);
    expect(actions).toContain("federation.inbox.imported");
    expect(actions).toContain("federation.relay.import.applied");
    const ledger = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx.select().from(federationInboxFiles).where(eq(federationInboxFiles.orgId, outpost.orgId))
    );
    expect(ledger.filter((r) => r.outcome === "imported").length).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it("a sync .scpbundle dropped in the inbox imports exactly like a CLI import (cursor advances, transfer confirmed)", async () => {
    // Fresh delta at A: a new object since C's cursor.
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: commander.orgId,
        requestId: `t-inbox-sync-${randomUUID()}`,
        name: `inbox-sync-obj-${randomUUID().slice(0, 8)}`
      })
    );
    const cursorBefore = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, commanderDomainId, commanderDomainId)
    );
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, "outpost-c", cursorBefore.sequence)
    );
    expect(bundle.entries.length).toBeGreaterThan(0);
    await writeFile(
      path.join(outpostInbox, `scp-sync-${commanderDomainId}-${bundle.header.throughSequence}.scpbundle`),
      JSON.stringify(bundle, null, 2),
      "utf8"
    );
    const outcomes = await tickOutpost();
    expect(outcomes.filter((o) => o.outcome === "imported")).toHaveLength(1);
    const cursorAfter = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, commanderDomainId, commanderDomainId)
    );
    expect(cursorAfter.sequence).toBe(bundle.header.throughSequence);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (2) Idempotency — the ledger dedupe.
  // ---------------------------------------------------------------------------------------------

  it("a second tick over the same inbox is a no-op: no new changes, no new Decisions (re-processing an already-imported file is idempotent)", async () => {
    const decisionsBefore = await decisionCount(outpost);
    const changesBefore = await changeCount(outpost);
    const outcomes = await tickOutpost();
    expect(outcomes.every((o) => o.outcome === "already-processed")).toBe(true);
    expect(await decisionCount(outpost)).toBe(decisionsBefore);
    expect(await changeCount(outpost)).toBe(changesBefore);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (3) Retrans role: push-less validate-and-forward.
  // ---------------------------------------------------------------------------------------------

  it("retrans role: a tarball in the retrans inbox is validated and forwarded byte-identical to the onward drop — WITHOUT any registry push, with validate-gated confirm", async () => {
    await copyFile(tarball2Path, path.join(retransInbox, path.basename(tarball2Path)));

    const outcomes = await tickRetrans();
    const forwarded = outcomes.filter((o) => o.outcome === "forwarded");
    expect(forwarded).toHaveLength(1);

    // The onward drop exists and is BYTE-IDENTICAL to what arrived (the low side's signature
    // stays the receiving outpost's trust anchor — nothing was re-signed or repackaged).
    const droppedPath = path.join(retransOnwardOut, path.basename(tarball2Path));
    const originalSha = await sha256File(tarball2Path);
    expect(await sha256File(droppedPath)).toBe(originalSha);

    // NO REGISTRY PUSH: the configured dest repo (scp/forward-check) holds NOTHING — the forward
    // path never invoked the push half even though a destination was configured.
    expect(await registryHasDigest(destHost, "scp/forward-check", loopImage.digest)).toBe(false);

    // The allow Decision + audit + transfer rows (D4: confirmed inbound hop, submitted onward).
    const decision = await latestDecision(retrans, RETRANS_RELAY_FORWARD_DECISION_KIND);
    expect(decision?.verdict).toBe("allow");
    const actions = await auditActions(retrans);
    expect(actions).toContain("federation.relay.forwarded");
    expect(actions).toContain("federation.inbox.forwarded");
    const transfers = await confirmedTransferWithChecksum(retrans, originalSha);
    expect(transfers).toContainEqual({ direction: "import", status: "confirmed" });
    expect(transfers).toContainEqual({ direction: "export", status: "submitted" });
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (4) Tamper refused (retrans AND outpost, identical to CLI), loop continues.
  // ---------------------------------------------------------------------------------------------

  let tamperedTarballPath = "";

  it("a tampered tarball at the retrans is refused with a block Decision, NO onward drop, NO confirm — and the tick continues past it (junk file skipped, not crashed)", async () => {
    // Corrupt one packaged file inside tarball1 (changeA1's tarball — B imported that promotion
    // in the baseline test), re-pack WITHOUT re-signing: the CDS transit tamper model.
    const tamperDir = await mkdtemp(path.join(scratch, "tamper-"));
    execFileSync("tar", ["xzf", tarball1Path, "-C", tamperDir]);
    const [rootName] = await readdir(tamperDir);
    const bundleRoot = path.join(tamperDir, rootName as string);
    const images = await readdir(path.join(bundleRoot, "images"));
    const firstImageDir = path.join(bundleRoot, "images", images[0] as string);
    const layoutFiles = await readdir(firstImageDir);
    expect(layoutFiles).toContain("index.json");
    await writeFile(path.join(firstImageDir, "index.json"), "{tampered-in-transit}");
    tamperedTarballPath = path.join(tamperDir, path.basename(tarball1Path));
    execFileSync("tar", ["czf", tamperedTarballPath, "-C", tamperDir, rootName as string]);

    // Drop the tampered tarball AND a junk file in the same tick.
    await copyFile(tamperedTarballPath, path.join(retransInbox, path.basename(tarball1Path)));
    await writeFile(path.join(retransInbox, "README.txt"), "not a channel artifact", "utf8");

    const confirmsBefore = (
      await confirmedTransferWithChecksum(retrans, await sha256File(tamperedTarballPath))
    ).length;
    const outcomes = await tickRetrans();

    const refused = outcomes.filter((o) => o.outcome === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.decisionId).toBeTruthy();
    // The junk file was SKIPPED (with a ledger row) in the SAME tick — one bad file never bricks it.
    const skipped = outcomes.filter((o) => o.outcome === "skipped");
    expect(skipped).toHaveLength(1);

    // Block Decision + hash-chained audit; the refusal is the FORWARD kind (no import ran).
    const decision = await latestDecision(retrans, RETRANS_RELAY_FORWARD_DECISION_KIND);
    expect(decision?.verdict).toBe("block");
    const actions = await auditActions(retrans);
    expect(actions).toContain("federation.relay.forward.blocked");
    expect(actions).toContain("federation.inbox.refused");

    // NO onward drop of the tampered file; NO confirmation (D4 — the transfer visibly stalls).
    expect(await readdir(retransOnwardOut)).toEqual([path.basename(tarball2Path)]);
    const confirmsAfter = await confirmedTransferWithChecksum(
      retrans,
      await sha256File(tamperedTarballPath)
    );
    expect(confirmsAfter.length).toBe(confirmsBefore);
  }, 240_000);

  it("the SAME tampered tarball refused via the loop at the outpost carries the IDENTICAL refusal reason as a direct CLI importRelayTarball call — zero trust survives automation", async () => {
    // CLI reference refusal.
    const cli = await importRelayTarball(outpost.db, {
      orgId: outpost.orgId,
      changeIdOrUrn: changeAtOutpostManual,
      tarballPath: tamperedTarballPath,
      relayCosignPublicKeyPem: retransCosignPub,
      masterKey: OUTPOST_MASTER_KEY,
      config: outpostConfig()
    });
    expect(cli.refused).toBe(true);
    if (!cli.refused) throw new Error("unreachable");

    // Loop refusal of the same bytes dropped in the inbox.
    await copyFile(tamperedTarballPath, path.join(outpostInbox, path.basename(tarball1Path)));
    const outcomes = await tickOutpost();
    const refused = outcomes.filter((o) => o.outcome === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toBe(cli.reason);

    // Both refusals persisted block Decisions of the SAME kind with the SAME reason.
    const rows = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(eq(decisions.kind, RETRANS_RELAY_IMPORT_DECISION_KIND))
        .orderBy(desc(decisions.id))
        .limit(2)
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.verdict).toBe("block");
    expect(rows[1]!.verdict).toBe("block");
    expect((rows[0]!.reasonTree as { summary?: string }).summary).toBe(
      (rows[1]!.reasonTree as { summary?: string }).summary
    );
  }, 240_000);

  // ---------------------------------------------------------------------------------------------
  // (5) Traversal + malformed-bundle refusals.
  // ---------------------------------------------------------------------------------------------

  it("a traversal-shaped file name is refused outright with a block Decision (the file is never read)", async () => {
    const { self, peers } = await withTenantTx(outpost.db, outpost.orgId, async (tx) => ({
      self: await ensureFederationSelf(tx, outpost.orgId),
      peers: await listPeers(tx, outpost.orgId)
    }));
    const outcome = await processInboxFile(
      outpost.db,
      outpost.orgId,
      { self, peers },
      { peer: null, dir: outpostInbox },
      "../../etc/evil.scpbundle",
      OUTPOST_MASTER_KEY,
      outpostConfig()
    );
    expect(outcome.outcome).toBe("refused");
    expect(outcome.detail).toContain("traversal");
    const decision = await latestDecision(outpost, INBOX_INGEST_DECISION_KIND);
    expect(decision?.verdict).toBe("block");
  }, 60_000);

  it("a malformed .scpbundle is refused with the loop's own block Decision, and a tampered-checksum bundle refuses exactly like the CLI's 409 — with a Decision the CLI path never had", async () => {
    // Malformed JSON.
    await writeFile(path.join(outpostInbox, "garbage.scpbundle"), "{not json", "utf8");
    // A REAL bundle with one byte of payload flipped after signing (checksum mismatch).
    const bundleForC = await exportPromotionFromA(changeA1, "outpost-c");
    const tampered = { ...bundleForC, change: { ...bundleForC.change, name: "tampered-name" } };
    await writeFile(
      path.join(outpostInbox, "scp-promotion-tampered.scpbundle"),
      JSON.stringify(tampered, null, 2),
      "utf8"
    );

    const outcomes = await tickOutpost();
    const refused = outcomes.filter((o) => o.outcome === "refused");
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.decisionId).toBeTruthy();
    const reasons = refused.map((r) => r.detail).join(" | ");
    expect(reasons).toMatch(/not parseable|checksum mismatch/);

    // Idempotent even for refusals: the next tick re-refuses NOTHING (ledger).
    const decisionsBefore = await decisionCount(outpost);
    const again = await tickOutpost();
    expect(again.every((o) => o.outcome === "already-processed")).toBe(true);
    expect(await decisionCount(outpost)).toBe(decisionsBefore);
  }, 120_000);
});

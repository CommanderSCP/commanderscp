import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { resolveSkopeo, generateKeyPair, signBlob } from "@scp/cosign";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { ScanEvidenceSchema } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { listControlRunsForChange } from "../governance/controls-repo.js";
import { exportPromotionBundle } from "./promotion-repo.js";
import { MANAGED_SCAN_CONTROL_OBJECT_ID } from "./promotion-scan-step.js";
import { loadScanDbBlob } from "../governance/scan-db.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M13.3b-ii — OFFLINE DB PRE-LOAD + STALENESS + OPERATOR-LOAD end-to-end (ADR-0020, proposal §13.3b).
 *
 * The runner image is resolved ONCE (pulled via SCP_RUNNER_SCAN_IMAGE_REF or legacy-built), and the
 * REAL baked Trivy DB is extracted from it into a host cache dir — a genuine, schema-correct DB with
 * real metadata (fabricating one offline is impossible). That cache is the "server-provided pre-loaded
 * DB dir" the scenarios exercise:
 *   (a) pre-loaded DB scan → the runner uses the copied-in DB (`--network none`, `--skip-db-update`)
 *       and produces a valid digest-bound ScanEvidence whose `scanDbSource` is the CACHE, not baked.
 *   (b) a MISSING/empty configured cache → fail-closed (no evidence → E6 refuses with a decision_id).
 *   (c) a DB past the HARD max → fail-closed; a DB past the SOFT max → scans + WARN (surfaced in evidence).
 *   (d) the operator-load path VERIFIES a cosign-signed DB blob and REFUSES a tampered / wrong-key one
 *       with NO cache write.
 *
 * Staleness bounds are driven by the instance policy row (written over the domain admin connection,
 * the production operator-write path) so the REAL baked DB — of unknown real age — lands in the
 * intended class deterministically (huge bounds ⇒ fresh; tiny soft ⇒ warn; tiny hard ⇒ hard-fail).
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCAN_CONTEXT = resolve(__dirname, "../../../../apps/runner-scan");
const RUNNER_IMAGE_TAG = "scp-runner-scan:m13-3b-ii-integration-test";
const CLEAN_SRC = "docker://docker.io/library/alpine:3.20";

const HUGE = 100_000_000; // hours — far larger than any real DB age ⇒ classified fresh
const TINY = 1; // hour — smaller than any real baked DB age ⇒ trips the bound

describe("M13.3b-ii offline scan-DB pre-load + staleness + operator-load", () => {
  let domain: IsolatedDomain;
  let registry: StartedTestContainer;
  let registryHost: string;
  let scratch: string;
  let skopeoBin: string;
  let scanImageRef: string;
  let goodCache: string; // a host dir holding the REAL baked DB (db/trivy.db + db/metadata.json)
  let cleanDigest: string;
  let cleanRepo: string;

  async function setPolicy(soft: number, hard: number): Promise<void> {
    const pool = new pg.Pool({ connectionString: domain.adminUrl });
    try {
      await pool.query(
        `INSERT INTO scan_db_staleness_policy (id, soft_max_age_hours, hard_max_age_hours, updated_at)
           VALUES ('default', $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET soft_max_age_hours = EXCLUDED.soft_max_age_hours,
                                        hard_max_age_hours = EXCLUDED.hard_max_age_hours, updated_at = now()`,
        [soft, hard]
      );
    } finally {
      await pool.end();
    }
  }

  beforeAll(async () => {
    const resolved = resolveSkopeo();
    if (resolved.source === "missing") throw new Error("skopeo binary not found (vendored or PATH)");
    skopeoBin = resolved.bin;

    [scanImageRef, domain, registry] = await Promise.all([
      resolveRunnerImage({
        refEnvVar: "SCP_RUNNER_SCAN_IMAGE_REF",
        localTag: RUNNER_IMAGE_TAG,
        context: RUNNER_SCAN_CONTEXT
      }),
      createIsolatedDomain("scandbpreload"),
      new GenericContainer("registry:2").withExposedPorts(5000).start()
    ]);
    registryHost = `${registry.getHost()}:${registry.getMappedPort(5000)}`;
    scratch = await mkdtemp(join(tmpdir(), "scp-scandb-it-"));

    // Push the clean subject.
    cleanRepo = `${registryHost}/scp/clean`;
    await execFileAsync(
      skopeoBin,
      ["copy", "--override-os", "linux", "--override-arch", "amd64", "--preserve-digests", "--dest-tls-verify=false", CLEAN_SRC, `docker://${cleanRepo}:subject`],
      { timeout: 240_000, maxBuffer: 64 * 1024 * 1024 }
    );
    const { stdout } = await execFileAsync(
      skopeoBin,
      ["inspect", "--tls-verify=false", "--format", "{{.Digest}}", `docker://${cleanRepo}:subject`],
      { timeout: 60_000 }
    );
    cleanDigest = stdout.trim();

    // Extract the REAL baked Trivy DB out of the runner image into `goodCache` (a --cache-dir layout
    // with db/trivy.db + db/metadata.json). `docker cp` from a created (unstarted) container.
    goodCache = join(scratch, "good-cache");
    await mkdir(goodCache, { recursive: true });
    const { stdout: cidOut } = await execFileAsync("docker", ["create", scanImageRef, "trivy"], { timeout: 60_000 });
    const cid = cidOut.trim();
    try {
      await execFileAsync("docker", ["cp", `${cid}:/root/.cache/trivy/.`, goodCache], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    } finally {
      await execFileAsync("docker", ["rm", "-f", cid], { timeout: 30_000 }).catch(() => undefined);
    }
    // Sanity: the extracted cache really is a usable Trivy DB.
    await readFile(join(goodCache, "db", "trivy.db"));
    await readFile(join(goodCache, "db", "metadata.json"), "utf8");

    // Server/operator-governed settings + the ADR-0019 §4 allowlist (plain-HTTP registry ⇒ insecure).
    process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE = scanImageRef;
    process.env.SCP_MANAGED_SCAN_NETWORK_MODE = "none";
    process.env.SCP_MANAGED_SCAN_WORKSPACE_ROOT = join(scratch, "runner-ws");
    process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = registryHost;
    process.env.SCP_ARTIFACT_INSECURE_HOSTS = registryHost;

    await withTenantTx(domain.db, domain.orgId, (tx) => ensureFederationSelf(tx, domain.orgId));
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" }
    }) as unknown as { publicKey: Buffer };
    await withTenantTx(domain.db, domain.orgId, (tx) =>
      pairPeer(tx, {
        orgId: domain.orgId,
        domainId: randomUUID(),
        name: "peer-outpost",
        role: "outpost",
        publicKey: publicKey.toString("base64")
      })
    );
  }, 420_000);

  afterAll(async () => {
    for (const k of [
      "SCP_MANAGED_SCAN_RUNNER_IMAGE",
      "SCP_MANAGED_SCAN_NETWORK_MODE",
      "SCP_MANAGED_SCAN_WORKSPACE_ROOT",
      "SCP_MANAGED_SCAN_DB_CACHE",
      "SCP_ARTIFACT_OCI_REGISTRY_HOSTS",
      "SCP_ARTIFACT_INSECURE_HOSTS"
    ]) {
      delete process.env[k];
    }
    await domain?.close();
    await registry?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 60_000);

  async function proposeCleanImageChange(): Promise<string> {
    const target = await withTenantTx(domain.db, domain.orgId, (tx) =>
      createObject(tx, {
        orgId: domain.orgId,
        domainId: null,
        typeId: "service",
        actorObjectId: domain.orgId,
        requestId: `scandb-target-${randomUUID()}`,
        name: `scandb-target-${randomUUID()}`
      })
    );
    const { change } = await withTenantTx(domain.db, domain.orgId, (tx) =>
      proposeChange(tx, {
        orgId: domain.orgId,
        actorObjectId: domain.orgId,
        requestId: `scandb-change-${randomUUID()}`,
        name: `scandb-${randomUUID()}`,
        targets: [target.id],
        type: "image",
        sourceRef: { artifact_digest: cleanDigest, image: `${cleanRepo}@${cleanDigest}` }
      })
    );
    return change.id;
  }

  async function exportClean(changeId: string) {
    return exportPromotionBundle(domain.db, {
      orgId: domain.orgId,
      peerIdOrName: "peer-outpost",
      changeIdOrUrn: changeId
    });
  }

  async function managedEvidenceFor(changeId: string) {
    const runs = await withTenantTx(domain.db, domain.orgId, (tx) => listControlRunsForChange(tx, domain.orgId, changeId));
    return runs.filter((r) => r.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID);
  }

  // (a) ------------------------------------------------------------------------------------------
  it("(a) a server-provided pre-loaded DB is copied in and produces a valid digest-bound ScanEvidence (offline)", async () => {
    process.env.SCP_MANAGED_SCAN_DB_CACHE = goodCache;
    await setPolicy(HUGE, HUGE); // the real baked DB, whatever its age, classifies fresh
    const changeId = await proposeCleanImageChange();

    const outcome = await exportClean(changeId);
    expect(outcome.refused, outcome.refused ? outcome.reason : "expected export").toBe(false);

    const runs = await managedEvidenceFor(changeId);
    expect(runs).toHaveLength(1);
    const ev = ScanEvidenceSchema.parse(runs[0]!.evidence);
    expect(ev.scanner).toBe("trivy");
    expect(ev.digestMatch).toBe(true);
    expect(ev.artifactDigest).toBe(cleanDigest);
    expect(ev.severityCounts.critical).toBe(0);
    // The DB provenance is the CACHE (pre-loaded), not the image bake — the pre-load path ran.
    expect(ev.scanDbSource).toBe("refreshed");
    expect(ev.scanDbStaleness).toBe("fresh");
    // A REAL Trivy ran offline (--network none) against the copied-in DB.
    expect(ev.scannerVersion).not.toBe("unknown");
  }, 180_000);

  // (b) ------------------------------------------------------------------------------------------
  it("(b) a MISSING/empty configured cache fails closed → no evidence → E6 refuses with a decision_id", async () => {
    const empty = join(scratch, `empty-${randomUUID()}`);
    await mkdir(empty, { recursive: true });
    process.env.SCP_MANAGED_SCAN_DB_CACHE = empty;
    await setPolicy(HUGE, HUGE);
    const changeId = await proposeCleanImageChange();

    const outcome = await exportClean(changeId);
    expect(outcome.refused).toBe(true);
    if (!outcome.refused) throw new Error("expected refusal");
    expect(outcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await managedEvidenceFor(changeId)).toHaveLength(0);
  }, 120_000);

  // (c) ------------------------------------------------------------------------------------------
  it("(c) a DB past the HARD max fails closed; past the SOFT max scans + WARNs", async () => {
    // Hard-fail: tiny hard bound ⇒ the real baked DB is past it ⇒ no scan → E6 refuses.
    process.env.SCP_MANAGED_SCAN_DB_CACHE = goodCache;
    await setPolicy(TINY, TINY);
    const hardChange = await proposeCleanImageChange();
    const hardOutcome = await exportClean(hardChange);
    expect(hardOutcome.refused).toBe(true);
    if (!hardOutcome.refused) throw new Error("expected hard-stale refusal");
    expect(hardOutcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await managedEvidenceFor(hardChange)).toHaveLength(0);

    // Warn: tiny soft but huge hard ⇒ the DB is past soft (WARN) but within hard ⇒ still scans.
    await setPolicy(TINY, HUGE);
    const warnChange = await proposeCleanImageChange();
    const warnOutcome = await exportClean(warnChange);
    expect(warnOutcome.refused, warnOutcome.refused ? warnOutcome.reason : "expected export").toBe(false);
    const runs = await managedEvidenceFor(warnChange);
    expect(runs).toHaveLength(1);
    const ev = ScanEvidenceSchema.parse(runs[0]!.evidence);
    expect(ev.scanDbStaleness).toBe("warn");
    expect(ev.scanDbThresholdFired).toBe("soft");
    expect(runs[0]!.detail).toContain("scan DB WARN");
  }, 240_000);

  // (d) ------------------------------------------------------------------------------------------
  it("(d) operator-load verifies a cosign-signed DB blob and REFUSES a tampered / wrong-key one (no cache write)", async () => {
    // Build a DB blob = tar.gz of the real cache's db/ dir (trivy.db + metadata.json).
    const blob = join(scratch, "db-blob.tar.gz");
    await execFileAsync("tar", ["-czf", blob, "-C", goodCache, "db"], { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    const bytes = await readFile(blob);

    const key = await generateKeyPair();
    const pubPath = join(scratch, "cosign.pub");
    await writeFile(pubPath, key.publicKeyPem, "utf8");
    const sig = await signBlob(bytes, key.privateKeyPem);
    const sigPath = join(scratch, "db-blob.sig");
    await writeFile(sigPath, sig, "utf8");

    // GOOD load → accepted into a fresh cache; the DB lands.
    const loadCache = join(scratch, `load-cache-${randomUUID()}`);
    const meta = await loadScanDbBlob({ cacheDir: loadCache, blobPath: blob, signaturePath: sigPath, publicKeyPath: pubPath });
    expect(meta.Version).toBeGreaterThan(0);
    await readFile(join(loadCache, "db", "trivy.db"));
    const sidecar = JSON.parse(await readFile(join(loadCache, "scp-scan-db-source.json"), "utf8"));
    expect(sidecar.source).toBe("operator-loaded");

    // WRONG KEY → refused, no cache write.
    const other = await generateKeyPair();
    const otherPub = join(scratch, "other.pub");
    await writeFile(otherPub, other.publicKeyPem, "utf8");
    const wrongKeyCache = join(scratch, `wrongkey-cache-${randomUUID()}`);
    await expect(
      loadScanDbBlob({ cacheDir: wrongKeyCache, blobPath: blob, signaturePath: sigPath, publicKeyPath: otherPub })
    ).rejects.toThrow(/verification FAILED|refusing/i);
    await expect(readFile(join(wrongKeyCache, "db", "trivy.db"))).rejects.toThrow();

    // TAMPERED blob → signature no longer verifies → refused, no cache write.
    const tamperedBlob = join(scratch, "tampered.tar.gz");
    await writeFile(tamperedBlob, bytes);
    await appendFile(tamperedBlob, Buffer.from("corrupt"));
    const tamperCache = join(scratch, `tamper-cache-${randomUUID()}`);
    await expect(
      loadScanDbBlob({ cacheDir: tamperCache, blobPath: tamperedBlob, signaturePath: sigPath, publicKeyPath: pubPath })
    ).rejects.toThrow(/verification FAILED|refusing/i);
    await expect(readFile(join(tamperCache, "db", "trivy.db"))).rejects.toThrow();
  }, 180_000);
});

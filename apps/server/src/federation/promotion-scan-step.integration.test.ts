import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import pg from "pg";
import { resolveSkopeo } from "@scp/cosign";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import { managedScanServerSettings } from "../coordination/executor-bindings-repo.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { proposeChange } from "../coordination/changes-repo.js";
import { transitionChange } from "../coordination/transition.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { ensureFederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { insertControlRun, listControlRunsForChange } from "../governance/controls-repo.js";
import { listAuditEvents } from "../audit/audit-repo.js";
import { exportPromotionBundle } from "./promotion-repo.js";
import {
  MANAGED_SCAN_CONTROL_OBJECT_ID,
  type ManagedScanRunner,
  type ManagedScanRequest,
  type ManagedScanResult
} from "./promotion-scan-step.js";
import { ScanEvidenceSchema } from "@scp/schemas";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";
import { asTrustDomainId } from "@scp/schemas";

/** The commander's promotion scan step, end to end. See docs/federation.md §411. */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCAN_CONTEXT = resolve(__dirname, "../../../../apps/runner-scan");
const RUNNER_IMAGE_TAG = "scp-runner-scan:m13-3b-integration-test";

/** Where the subject fixtures below are pulled from. See docs/federation.md §412. */
const SUBJECT_REGISTRY = process.env.SCP_TEST_SUBJECT_REGISTRY ?? "docker.io/library";

/** A real, deterministically CLEAN subject (calibrated against the pinned Trivy DB: 0 findings). */
const CLEAN_SRC = `docker://${SUBJECT_REGISTRY}/alpine:3.20`;
/** A real, deterministically VULNERABLE subject (calibrated: 6 CRITICAL / 19 HIGH — well over the
 *  fail-closed 0/0 default threshold). `debian:11` (bullseye) is old enough to carry advisories yet
 *  recent enough that they are NOT pruned from the DB the way EOL alpine's are. */
const DIRTY_SRC = `docker://${SUBJECT_REGISTRY}/debian:11`;

// --- OpenSCAP subjects. See docs/federation.md §413.
const OSCAP_CLEAN_SRC = `docker://${SUBJECT_REGISTRY}/debian:11`;
const OSCAP_DIRTY_SRC = `docker://${SUBJECT_REGISTRY}/oraclelinux:8`;
const SSG = "/usr/share/xml/scap/ssg/content";
// The clean case uses the lightest baseline (high-clean under the pinned SSG); the dirty case uses
// the heavier `standard` profile (which does carry a high-severity fail on ol8).
const OSCAP_CLEAN_PROFILE = "xccdf_org.ssgproject.content_profile_anssi_np_nt28_minimal";
const OSCAP_DIRTY_PROFILE = "xccdf_org.ssgproject.content_profile_standard";

// --- MACHINE-IMAGE subjects. See docs/federation.md §414.
const MACHINE_IMAGE_CLEAN_BASE = "alpine:3.20";
const MACHINE_IMAGE_DIRTY_BASE = "debian:11";
/** Collect the files `trivy vm` needs into `/r`, per OS family (release files + the package DB). */
const MACHINE_IMAGE_CLEAN_COLLECT =
  "mkdir -p /r/lib/apk/db /r/etc && cp /lib/apk/db/installed /r/lib/apk/db/installed && " +
  "cp /etc/os-release /r/etc/os-release && cp /etc/alpine-release /r/etc/alpine-release";
const MACHINE_IMAGE_DIRTY_COLLECT =
  "mkdir -p /r/var/lib/dpkg /r/etc && cp /var/lib/dpkg/status /r/var/lib/dpkg/status && " +
  "cp /usr/lib/os-release /r/etc/os-release && cp /etc/debian_version /r/etc/debian_version";
/** The image that builds the disk — needs `mke2fs` (e2fsprogs), which debian:11 already ships. */
const DISK_BUILDER_IMAGE = "debian:11";
/** OCI media types the runner's `trivy-vm` arm recognizes as "this layer IS the disk" (run.sh). */
const MACHINE_IMAGE_DISK_MEDIA_TYPE = "application/vnd.scp.machine-image.disk.v1+raw";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(await dockerAvailable())(
  "M13.3a promotion scan step E6 (Testcontainers: postgres + registry:2 + real scp-runner-scan + real Trivy)",
  () => {
    let domain: IsolatedDomain;
    let registry: StartedTestContainer;
    let registryHost: string;
    let scratch: string;
    let skopeoBin: string;

    let cleanDigest: string;
    let cleanRepo: string;
    let dirtyDigest: string;
    let dirtyRepo: string;
    let oscapCleanDigest: string;
    let oscapCleanRepo: string;
    let oscapDirtyDigest: string;
    let oscapDirtyRepo: string;
    let vmCleanDigest: string;
    let vmCleanRepo: string;
    let vmDirtyDigest: string;
    let vmDirtyRepo: string;

    beforeAll(async () => {
      const resolved = resolveSkopeo();
      if (resolved.source === "missing")
        throw new Error("skopeo binary not found (vendored or PATH)");
      skopeoBin = resolved.bin;

      // LEVER 1: resolve the runner image ONCE. See docs/federation.md §415.
      let scanImageRef: string;
      [scanImageRef, domain, registry] = await Promise.all([
        resolveRunnerImage({
          refEnvVar: "SCP_RUNNER_SCAN_IMAGE_REF",
          localTag: RUNNER_IMAGE_TAG,
          context: RUNNER_SCAN_CONTEXT
        }),
        createIsolatedDomain("scanstep"),
        new GenericContainer("registry:2").withExposedPorts(5000).start()
      ]);
      registryHost = `${registry.getHost()}:${registry.getMappedPort(5000)}`;

      scratch = await mkdtemp(join(tmpdir(), "scp-scanstep-it-"));

      // Push the two REAL subjects into the local registry (single-arch, so the server's
      // `skopeo copy --all` lands exactly one manifest whose digest == what we record here).
      cleanRepo = `${registryHost}/scp/clean`;
      dirtyRepo = `${registryHost}/scp/dirty`;
      cleanDigest = await pushSubject(CLEAN_SRC, cleanRepo);
      dirtyDigest = await pushSubject(DIRTY_SRC, dirtyRepo);

      oscapCleanRepo = `${registryHost}/scp/oscap-clean`;
      oscapDirtyRepo = `${registryHost}/scp/oscap-dirty`;
      oscapCleanDigest = await pushSubject(OSCAP_CLEAN_SRC, oscapCleanRepo);
      oscapDirtyDigest = await pushSubject(OSCAP_DIRTY_SRC, oscapDirtyRepo);

      // MACHINE-IMAGE subjects (13.3a) — built as ext4 disk images, then packaged as OCI artifacts
      // and pushed, so the SERVER pulls them over the very same allowlisted skopeo channel.
      const vmCleanDisk = join(scratch, "machine-image-clean.raw");
      const vmDirtyDisk = join(scratch, "machine-image-dirty.raw");
      await buildMachineImageDisk(
        MACHINE_IMAGE_CLEAN_BASE,
        MACHINE_IMAGE_CLEAN_COLLECT,
        vmCleanDisk
      );
      await buildMachineImageDisk(
        MACHINE_IMAGE_DIRTY_BASE,
        MACHINE_IMAGE_DIRTY_COLLECT,
        vmDirtyDisk
      );
      vmCleanRepo = `${registryHost}/scp/machine-image-clean`;
      vmDirtyRepo = `${registryHost}/scp/machine-image-dirty`;
      vmCleanDigest = await pushMachineImage(vmCleanDisk, vmCleanRepo);
      vmDirtyDigest = await pushMachineImage(vmDirtyDisk, vmDirtyRepo);
      await rm(vmCleanDisk, { force: true });
      await rm(vmDirtyDisk, { force: true });

      // Assigns the scan method to that Type for this domain. See docs/federation.md §416.
      const adminPool = new pg.Pool({ connectionString: domain.adminUrl });
      try {
        await adminPool.query(
          `INSERT INTO scanner_assignments (executor_type, methods) VALUES ('rpm', '["openscap"]'::jsonb)
             ON CONFLICT (executor_type) DO UPDATE SET methods = EXCLUDED.methods`
        );
      } finally {
        await adminPool.end();
      }

      // Server/operator-governed managed-scan settings + the ADR-0019 §4 OCI-host allowlist. The
      // registry is plain-HTTP, so it must also be listed insecure for the server's skopeo pull.
      process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE = scanImageRef;
      process.env.SCP_MANAGED_SCAN_NETWORK_MODE = "none";
      process.env.SCP_MANAGED_SCAN_WORKSPACE_ROOT = join(scratch, "runner-ws");
      process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = registryHost;
      process.env.SCP_ARTIFACT_INSECURE_HOSTS = registryHost;

      // Federation identity + a peer to export a promotion to (export only needs the peer to resolve;
      // no import/pairing round-trip is exercised here — the gate is on the EXPORT side).
      await withTenantTx(domain.db, domain.orgId, (tx) => ensureFederationSelf(tx, domain.orgId));
      const { publicKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" }
      }) as unknown as { publicKey: Buffer };
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        pairPeer(tx, {
          orgId: domain.orgId,
          domainId: asTrustDomainId(randomUUID()),
          name: "peer-outpost",
          role: "outpost",
          publicKey: publicKey.toString("base64")
        })
      );
    }, 300_000);

    afterAll(async () => {
      delete process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE;
      delete process.env.SCP_MANAGED_SCAN_NETWORK_MODE;
      delete process.env.SCP_MANAGED_SCAN_WORKSPACE_ROOT;
      delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
      delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
      await domain?.close();
      await registry?.stop();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }, 60_000);

    /** skopeo-copy a public multi-arch image into the local registry as a SINGLE linux/amd64 manifest
     *  and return the manifest digest the registry now serves at that ref. */
    async function pushSubject(src: string, destRepo: string): Promise<string> {
      await execFileAsync(
        skopeoBin,
        [
          "copy",
          "--override-os",
          "linux",
          "--override-arch",
          "amd64",
          "--preserve-digests",
          "--dest-tls-verify=false",
          src,
          `docker://${destRepo}:subject`
        ],
        { timeout: 240_000, maxBuffer: 64 * 1024 * 1024 }
      );
      const { stdout } = await execFileAsync(
        skopeoBin,
        [
          "inspect",
          "--tls-verify=false",
          "--format",
          "{{.Digest}}",
          `docker://${destRepo}:subject`
        ],
        { timeout: 60_000 }
      );
      const digest = stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error(`unexpected pushed digest: ${digest}`);
      return digest;
    }

    /** Run a throwaway container to completion and copy ONE file out of it. `create` + `cp` + `start`
     *  (never a bind mount) — the same seam the managed-scan orchestrator uses, and the reason this
     *  works identically on a Docker-Desktop host where /tmp is not a shared path. */
    async function runAndExtract(opts: {
      image: string;
      script: string;
      /** Optional host file copied INTO the container before it starts. */
      copyIn?: { from: string; to: string };
      containerPath: string;
      hostPath: string;
    }): Promise<void> {
      const { stdout: created } = await execFileAsync(
        "docker",
        ["create", "--entrypoint", "sh", opts.image, "-c", opts.script],
        { timeout: 120_000 }
      );
      const cid = created.trim();
      try {
        if (opts.copyIn) {
          await execFileAsync("docker", ["cp", opts.copyIn.from, `${cid}:${opts.copyIn.to}`], {
            timeout: 300_000,
            maxBuffer: 64 * 1024 * 1024
          });
        }
        await execFileAsync("docker", ["start", "-a", cid], {
          timeout: 300_000,
          maxBuffer: 64 * 1024 * 1024
        });
        await execFileAsync("docker", ["cp", `${cid}:${opts.containerPath}`, opts.hostPath], {
          timeout: 300_000,
          maxBuffer: 64 * 1024 * 1024
        });
      } finally {
        await execFileAsync("docker", ["rm", "-f", cid], { timeout: 60_000 }).catch(
          () => undefined
        );
      }
    }

    /** Build a MACHINE IMAGE: an ext4 filesystem image carrying `base`'s OS release files + package
     *  DB. Two throwaway containers — one to collect the rootfs (the base may lack `mke2fs`), one to
     *  make the filesystem. Rootless throughout (`mke2fs -d` populates without mounting). */
    async function buildMachineImageDisk(
      base: string,
      collect: string,
      hostDiskPath: string
    ): Promise<void> {
      const rootfsTar = join(scratch, `rootfs-${randomUUID()}.tar`);
      await runAndExtract({
        image: base,
        script: `set -e; ${collect}; tar -cf /rootfs.tar -C /r .`,
        containerPath: "/rootfs.tar",
        hostPath: rootfsTar
      });
      await runAndExtract({
        image: DISK_BUILDER_IMAGE,
        // 96 MiB of 4 KiB blocks. `-O ^64bit,^metadata_csum,^has_journal` keeps the on-disk format
        // within what Trivy's pure-Go ext4 reader supports (it is a reader, not a kernel driver).
        script:
          "set -e; mkdir -p /rootfs && tar -xf /rootfs.tar -C /rootfs && " +
          "mke2fs -q -t ext4 -O ^64bit,^metadata_csum,^has_journal -b 4096 -I 256 -d /rootfs /disk.raw 24576",
        copyIn: { from: rootfsTar, to: "/rootfs.tar" },
        containerPath: "/disk.raw",
        hostPath: hostDiskPath
      });
      await rm(rootfsTar, { force: true });
    }

    /** Package a disk as an OCI ARTIFACT. See docs/federation.md §417. */
    async function pushMachineImage(diskPath: string, destRepo: string): Promise<string> {
      const layoutDir = join(scratch, `oci-${randomUUID()}`);
      const blobs = join(layoutDir, "blobs", "sha256");
      await mkdir(blobs, { recursive: true });
      const put = async (bytes: Buffer): Promise<{ digest: string; size: number }> => {
        const hex = createHash("sha256").update(bytes).digest("hex");
        await writeFile(join(blobs, hex), bytes);
        return { digest: `sha256:${hex}`, size: bytes.length };
      };
      const layer = await put(await readFile(diskPath));
      const config = await put(Buffer.from("{}", "utf8"));
      const manifest = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: "application/vnd.scp.machine-image.v1",
        config: { mediaType: "application/vnd.scp.machine-image.config.v1+json", ...config },
        layers: [
          {
            mediaType: MACHINE_IMAGE_DISK_MEDIA_TYPE,
            ...layer,
            annotations: { "org.opencontainers.image.title": "disk.raw" }
          }
        ]
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      const m = await put(manifestBytes);
      await writeFile(
        join(layoutDir, "oci-layout"),
        JSON.stringify({ imageLayoutVersion: "1.0.0" })
      );
      await writeFile(
        join(layoutDir, "index.json"),
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            {
              mediaType: manifest.mediaType,
              ...m,
              annotations: { "org.opencontainers.image.ref.name": "subject" }
            }
          ]
        })
      );
      await execFileAsync(
        skopeoBin,
        [
          "copy",
          "--preserve-digests",
          "--dest-tls-verify=false",
          `oci:${layoutDir}:subject`,
          `docker://${destRepo}:subject`
        ],
        { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
      );
      await rm(layoutDir, { recursive: true, force: true });
      return m.digest;
    }

    /** Propose a change tracking one OCI artifact (digest + registry location), so the E6 gate sees a
     *  substantive artifact and the scan step can pull it. `type` selects the scanner registry row
     *  ("image" ⇒ trivy; "infrastructure" ⇒ trivy-vm, the machine-image arm; "configuration" ⇒ no
     *  scanner — the fail-closed case). */
    async function proposeArtifactChange(
      digest: string,
      repo: string,
      type: "image" | "configuration" | "rpm" | "infrastructure",
      scan?: { profile: string; datastream: string }
    ): Promise<string> {
      const target = await withTenantTx(domain.db, domain.orgId, (tx) =>
        createObject(tx, {
          orgId: domain.orgId,
          domainId: null,
          typeId: "service",
          actorObjectId: domain.orgId,
          requestId: `scanstep-target-${randomUUID()}`,
          name: `scanstep-target-${randomUUID()}`
        })
      );
      const { change } = await withTenantTx(domain.db, domain.orgId, (tx) =>
        proposeChange(tx, {
          orgId: domain.orgId,
          actorObjectId: domain.orgId,
          requestId: `scanstep-change-${randomUUID()}`,
          name: `scanstep-${randomUUID()}`,
          targets: [target.id],
          type,
          sourceRef: {
            artifact_digest: digest,
            image: `${repo}@${digest}`,
            // OpenSCAP-only per-artifact baseline selection (the OS's SSG datastream + XCCDF profile).
            ...(scan ? { scanProfile: scan.profile, scanDatastream: scan.datastream } : {})
          }
        })
      );
      return change.id;
    }

    async function exportToPeer(
      changeId: string,
      scanRunner?: ManagedScanRunner | null
    ): ReturnType<typeof exportPromotionBundle> {
      return exportPromotionBundle(domain.db, {
        orgId: domain.orgId,
        peerIdOrName: "peer-outpost",
        changeIdOrUrn: changeId,
        ...(scanRunner !== undefined ? { scanRunner } : {})
      });
    }

    /** The managed-scan control_runs rows the step deposited for a change (well-known control id). */
    async function managedRunsFor(changeId: string) {
      const runs = await withTenantTx(domain.db, domain.orgId, (tx) =>
        listControlRunsForChange(tx, domain.orgId, changeId)
      );
      return runs.filter((r) => r.controlObjectId === MANAGED_SCAN_CONTROL_OBJECT_ID);
    }

    /** This change's `federation.promotion.scan.runner_failed` audit events (the whole org's audit
     *  chain, filtered by subjectId — small enough per test that a single unpaged read is fine). */
    async function runnerFailureAuditEventsFor(changeId: string) {
      const { items } = await withTenantTx(domain.db, domain.orgId, (tx) =>
        listAuditEvents(tx, domain.orgId, { limit: 1000 })
      );
      return items.filter(
        (e) => e.action === "federation.promotion.scan.runner_failed" && e.subjectId === changeId
      );
    }

    // -------------------------------------------------------------------------------------------
    // (a) CLEAN — real container scan at export → digest-bound evidence → E6 passes → bundle exports.
    // -------------------------------------------------------------------------------------------
    it("(a) a CLEAN image scans clean at the commander → digest-bound control_runs row → E6 EXPORTS", async () => {
      const changeId = await proposeArtifactChange(cleanDigest, cleanRepo, "image");

      // DEFAULT runner (scanRunner undefined) ⇒ the production server-side skopeo-pull + real
      // scp-runner-scan container. NOTHING was pre-seeded — the evidence exists BY CONSTRUCTION.
      const outcome = await exportToPeer(changeId);

      expect(outcome.refused, outcome.refused ? outcome.reason : "expected export").toBe(false);
      if (outcome.refused) throw new Error(outcome.reason);
      expect(outcome.bundle.artifactDigests).toContain(cleanDigest);

      // The step deposited exactly the digest-bound, self-describing evidence the gate consumed.
      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("pass");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.scanner).toBe("trivy");
      expect(ev.artifactDigest).toBe(cleanDigest);
      expect(ev.expectedDigest).toBe(cleanDigest);
      expect(ev.digestMatch).toBe(true);
      expect(ev.severityCounts.critical).toBe(0);
      expect(ev.severityCounts.high).toBe(0);
      expect(ev.scannerVersion).not.toBe("unknown"); // a REAL Trivy ran (version stamped from the run)
    }, 180_000);

    // -------------------------------------------------------------------------------------------
    // (b) VULNERABLE — real scan exceeds the threshold → status fail → E6 refuses with a decision_id.
    // -------------------------------------------------------------------------------------------
    it("(b) a VULNERABLE image over threshold → managed scan status FAIL → E6 REFUSES with a decision_id", async () => {
      const changeId = await proposeArtifactChange(dirtyDigest, dirtyRepo, "image");

      const outcome = await exportToPeer(changeId);

      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected refusal");
      expect(outcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("fail");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.digestMatch).toBe(true); // it WAS the promoted artifact — it just failed on findings
      expect(ev.artifactDigest).toBe(dirtyDigest);
      expect(ev.severityCounts.critical + ev.severityCounts.high).toBeGreaterThan(0);
    }, 180_000);

    // -------------------------------------------------------------------------------------------
    // (c) SHORT-CIRCUIT — valid org-pipeline evidence already covers the digest ⇒ managed run SKIPPED.
    // -------------------------------------------------------------------------------------------
    it("(c) an artifact already covered by org-pipeline evidence SKIPS the managed run (runner NOT invoked) → E6 passes", async () => {
      const changeId = await proposeArtifactChange(cleanDigest, cleanRepo, "image");

      // Pre-seed a passing, digest-bound org-pipeline scan-result-control outcome (a DIFFERENT
      // control id — the org's own pipeline step), exactly the E6 predicate.
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        insertControlRun(tx, {
          orgId: domain.orgId,
          controlObjectId: randomUUID(),
          changeObjectId: changeId,
          gateKind: "lifecycle_edge",
          gateRef: { fromState: "validating", toState: "accepted" },
          // ADR-0020 §1's alternate ingress, NAMED. The short-circuit admits a covering outcome by
          // its producer (`scan-evidence.ts`, shared with E6), so an unattributed row no longer
          // suppresses the managed run — which is the safe direction: it would otherwise skip the
          // scan and then refuse the export for having none.
          pluginModule: "scan-result-control",
          status: "pass",
          evidence: {
            scanner: "trivy",
            scannerVersion: "0.50.0",
            artifactDigest: cleanDigest,
            expectedDigest: cleanDigest,
            digestMatch: true,
            severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
            threshold: { maxCritical: 0, maxHigh: 0 }
          }
        })
      );

      // A spy runner that FAILS the test if the managed run is ever dispatched.
      let invoked = 0;
      const spy: ManagedScanRunner = {
        async scan(): Promise<ManagedScanResult> {
          invoked += 1;
          return { ok: false, reason: "spy must never be invoked" };
        }
      };

      const outcome = await exportToPeer(changeId, spy);
      expect(invoked, "org-pipeline evidence must short-circuit the managed run").toBe(0);
      expect(outcome.refused).toBe(false);

      // No MANAGED evidence was deposited — the org's evidence is what E6 consumed.
      expect(await managedRunsFor(changeId)).toHaveLength(0);
    }, 60_000);

    // (d) FAIL-CLOSED — an ExecutorType with NO assigned scanner produces NO evidence ⇒ E6 refuses.
    it("(d) an artifact whose type has NO scanner assigned produces no managed evidence → E6 REFUSES (fail-closed)", async () => {
      // `configuration` resolves to `[]` in the seeded scanner registry (no managed scanner).
      const changeId = await proposeArtifactChange(cleanDigest, cleanRepo, "configuration");

      let invoked = 0;
      const spy: ManagedScanRunner = {
        async scan(): Promise<ManagedScanResult> {
          invoked += 1;
          return { ok: false, reason: "spy must never be invoked" };
        }
      };

      const outcome = await exportToPeer(changeId, spy);
      expect(invoked, "an unassigned type must never dispatch a managed run").toBe(0);
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected fail-closed refusal");
      expect(outcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await managedRunsFor(changeId)).toHaveLength(0);
    }, 60_000);

    // (d2) RUNNER FAILURE IS DIAGNOSABLE. See docs/federation.md §418.
    it("(d2) a runner/dispatch error deposits NO evidence but IS recorded as an audit event, reason intact", async () => {
      const changeId = await proposeArtifactChange(cleanDigest, cleanRepo, "image");

      let invoked = 0;
      const failing: ManagedScanRunner = {
        async scan(): Promise<ManagedScanResult> {
          invoked += 1;
          return { ok: false, reason: "docker cp: no such file or directory" };
        }
      };

      const outcome = await exportToPeer(changeId, failing);
      expect(invoked, "the runner must actually have been dispatched for this case").toBe(1);
      // Fail-closed, UNCHANGED: still no passing evidence, still refused.
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected fail-closed refusal");
      expect(await managedRunsFor(changeId)).toHaveLength(0);

      // ...but the WHY is now on the record, not discarded.
      const events = await runnerFailureAuditEventsFor(changeId);
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toContain("docker cp: no such file or directory");
      expect(events[0]?.subjectId).toBe(changeId);
    }, 60_000);

    // -------------------------------------------------------------------------------------------
    // (e) DIGEST-MISMATCH — a report whose scanned digest != promoted ⇒ digestMatch false ⇒ E6 refuses.
    // -------------------------------------------------------------------------------------------
    it("(e) a scan report of a DIFFERENT digest deposits digestMatch:false → E6 REFUSES", async () => {
      const changeId = await proposeArtifactChange(cleanDigest, cleanRepo, "image");

      const wrongDigest = `sha256:${"a".repeat(64)}`;
      const fake: ManagedScanRunner = {
        async scan(_req: ManagedScanRequest): Promise<ManagedScanResult> {
          // Clean counts, but the runner reports it scanned a DIFFERENT artifact than was promoted.
          return {
            ok: true,
            report: {
              scannedDigest: wrongDigest,
              scannerVersion: "trivy-fake",
              severityCounts: { critical: 0, high: 0, medium: 0, low: 0 }
            }
          };
        }
      };

      const outcome = await exportToPeer(changeId, fake);
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected digest-mismatch refusal");

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const ev = ScanEvidenceSchema.parse(runs[0]!.evidence);
      expect(ev.digestMatch).toBe(false);
      expect(runs[0]!.status).toBe("fail");
    }, 60_000);

    // (f) OPENSCAP CLEAN. See docs/federation.md §419.
    it("(f) OPENSCAP: a clean image passes the profile at the commander → digest-bound (scanner:openscap) → E6 EXPORTS", async () => {
      const changeId = await proposeArtifactChange(oscapCleanDigest, oscapCleanRepo, "rpm", {
        profile: OSCAP_CLEAN_PROFILE,
        datastream: `${SSG}/ssg-debian11-ds.xml`
      });

      // ASSERT the runner network is pinned `none` — the flag the plugin passes to `docker create
      // --network`; a clean OFFLINE oscap scan succeeding under it is the network-none proof (the
      // datastream is local, the extracted rootfs is local, so no egress is needed or permitted).
      expect(managedScanServerSettings().networkMode).toBe("none");

      const outcome = await exportToPeer(changeId);
      expect(outcome.refused, outcome.refused ? outcome.reason : "expected export").toBe(false);
      if (outcome.refused) throw new Error(outcome.reason);
      expect(outcome.bundle.artifactDigests).toContain(oscapCleanDigest);

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("pass");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.scanner).toBe("openscap");
      expect(ev.artifactDigest).toBe(oscapCleanDigest);
      expect(ev.expectedDigest).toBe(oscapCleanDigest);
      expect(ev.digestMatch).toBe(true);
      expect(ev.severityCounts.critical).toBe(0); // XCCDF has no critical — always 0 (the mapping)
      expect(ev.severityCounts.high).toBe(0);
      expect(ev.scannerVersion).not.toBe("unknown"); // a REAL oscap ran (version stamped from the run)
    }, 180_000);

    // -------------------------------------------------------------------------------------------
    // (g) OPENSCAP over threshold — real oscap scan yields ≥1 HIGH-severity failed rule → status
    //     fail → E6 refuses with a decision_id.
    // -------------------------------------------------------------------------------------------
    it("(g) OPENSCAP: an image failing the profile over threshold → status FAIL → E6 REFUSES with a decision_id", async () => {
      const changeId = await proposeArtifactChange(oscapDirtyDigest, oscapDirtyRepo, "rpm", {
        profile: OSCAP_DIRTY_PROFILE,
        datastream: `${SSG}/ssg-ol8-ds.xml`
      });

      const outcome = await exportToPeer(changeId);
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected refusal");
      expect(outcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("fail");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.scanner).toBe("openscap");
      expect(ev.digestMatch).toBe(true); // it WAS the promoted artifact — it failed on findings
      expect(ev.artifactDigest).toBe(oscapDirtyDigest);
      expect(ev.severityCounts.high).toBeGreaterThan(0);
      expect(ev.severityCounts.critical).toBe(0); // never a critical from XCCDF
    }, 180_000);

    // (h) MACHINE IMAGE, CLEAN. See docs/federation.md §420.
    it("(h) MACHINE IMAGE: a clean disk image scans clean via `trivy vm` → (scanner:trivy-vm) → E6 EXPORTS", async () => {
      const changeId = await proposeArtifactChange(vmCleanDigest, vmCleanRepo, "infrastructure");

      // The runner is networkless for a machine-image scan exactly as for a container scan — the
      // subject is a multi-MiB disk `docker cp`'d in, never a mount and never a fetch.
      expect(managedScanServerSettings().networkMode).toBe("none");

      const outcome = await exportToPeer(changeId);
      expect(outcome.refused, outcome.refused ? outcome.reason : "expected export").toBe(false);
      if (outcome.refused) throw new Error(outcome.reason);
      expect(outcome.bundle.artifactDigests).toContain(vmCleanDigest);

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("pass");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      // Self-describing: the evidence says it was scanned AS A MACHINE IMAGE, not as a container.
      expect(ev.scanner).toBe("trivy-vm");
      // Digest-bound to the PULL (a `trivy vm` result carries no image digest of its own — the
      // binding is the server-verified layout digest, which must equal the promoted digest).
      expect(ev.artifactDigest).toBe(vmCleanDigest);
      expect(ev.expectedDigest).toBe(vmCleanDigest);
      expect(ev.digestMatch).toBe(true);
      expect(ev.severityCounts.critical).toBe(0);
      expect(ev.severityCounts.high).toBe(0);
      expect(ev.scannerVersion).not.toBe("unknown"); // a REAL trivy ran (version stamped from the run)
    }, 300_000);

    // (i) MACHINE IMAGE, VULNERABLE. See docs/federation.md §421.
    it("(i) MACHINE IMAGE: a vulnerable disk image over threshold → status FAIL → E6 REFUSES with a decision_id", async () => {
      const changeId = await proposeArtifactChange(vmDirtyDigest, vmDirtyRepo, "infrastructure");

      const outcome = await exportToPeer(changeId);
      expect(outcome.refused).toBe(true);
      if (!outcome.refused) throw new Error("expected refusal");
      expect(outcome.decisionId).toMatch(/^[0-9a-f-]{36}$/);

      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("fail");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.scanner).toBe("trivy-vm");
      expect(ev.digestMatch).toBe(true); // it WAS the promoted artifact — it failed on findings
      expect(ev.artifactDigest).toBe(vmDirtyDigest);
      // The counts came from a real `trivy vm` run over the disk's package DB — not zeros.
      expect(ev.severityCounts.critical + ev.severityCounts.high).toBeGreaterThan(0);
    }, 300_000);

    // (j) NO BOUNDARY CROSSING ⇒ NO SCAN SCHEDULED. See docs/federation.md §422.
    it("(j) a promotion that crosses NO boundary schedules NO scan — and the same change DOES scan on export", async () => {
      const changeId = await proposeArtifactChange(vmDirtyDigest, vmDirtyRepo, "infrastructure");

      // Managed scanning IS enabled — this is not a vacuous "nothing configured" pass.
      expect(managedScanServerSettings().runnerImage).toBeTruthy();

      // Run the ENTIRE in-domain lifecycle through the one guarded transition function every
      // `changes.state` mutation goes through (coordination/transition.ts). No export, no peer, no
      // boundary.
      const gateDeps = { sandbox: getSharedCelSandbox(), host: null };
      for (const toState of [
        "evaluated",
        "coordinated",
        "executing",
        "validating",
        "accepted"
      ] as const) {
        const result = await withTenantTx(domain.db, domain.orgId, (tx) =>
          transitionChange(
            tx,
            {
              orgId: domain.orgId,
              changeObjectId: changeId,
              toState,
              actorObjectId: domain.orgId,
              requestId: `no-boundary-${toState}-${randomUUID()}`
            },
            gateDeps
          )
        );
        expect(result.verdict, `in-domain transition to ${toState} must not be blocked`).toBe(
          "allow"
        );
      }

      // THE CLAIM: a full in-domain promotion deposited NO managed-scan evidence at all.
      expect(
        await managedRunsFor(changeId),
        "an in-domain promotion must schedule no managed scan"
      ).toHaveLength(0);

      // THE CONTRAST: the SAME change, exported across a boundary, IS scanned — and refuses, because
      // this artifact is the vulnerable one. (`accepted` is terminal for the lifecycle but the export
      // journey is independent of change state.)
      const outcome = await exportToPeer(changeId);
      expect(outcome.refused).toBe(true);
      const afterExport = await managedRunsFor(changeId);
      expect(afterExport, "the boundary crossing MUST schedule the scan").toHaveLength(1);
      expect(ScanEvidenceSchema.parse(afterExport[0]!.evidence).scanner).toBe("trivy-vm");
    }, 300_000);
  }
);

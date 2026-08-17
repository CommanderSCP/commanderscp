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

/**
 * M13.3a — THE E6 END-TO-END for the commander's promotion scan step (ADR-0020, proposal §13.3 DoD).
 * This is the integration proof the 13.3a DoD demands: "an ephemeral runner at the commander scans a
 * subject artifact pulled by digest over the allowlisted channel, `--network none` otherwise; the
 * emitted evidence parses via `ScanEvidenceSchema`, lands commander-resident, and the UNMODIFIED
 * M17.5/E6 machinery consumes it — a pipeline-less promotion scans → evaluates → signs → exports
 * end-to-end with zero gate-code changes; valid org-pipeline evidence short-circuits the managed run
 * (both ingresses proven); scanner selection follows the registry rows by artifact type, and an
 * unassigned type with no evidence still refuses at E6."
 *
 * REAL vs INJECTED, and WHY. The two scan-substantive verdicts run the REAL `scp-runner-scan`
 * container end-to-end through the DEFAULT server runner (`scanRunner` undefined ⇒
 * `createServerManagedScanRunner`) — the production path — against REAL subject images pushed to a
 * real `registry:2`:
 *   (a) CLEAN  — `alpine:3.20` (0 vulnerabilities in the baked DB) → real Trivy → PASS → E6 exports.
 *   (b) DIRTY  — `debian:11`   (6 CRITICAL / 19 HIGH in the baked DB) → real Trivy exceeds the
 *                fail-closed 0/0 threshold → FAIL → E6 refuses with a `decision_id`.
 * These two carry the container/pull/network proofs: the SERVER pulls the subject BY DIGEST over the
 * `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`-allowlisted skopeo channel, docker-cp's the OCI layout INTO a
 * `--network none` runner, and the deposited `control_runs` evidence is digest-bound
 * (`artifactDigest` == the promoted digest, `digestMatch: true`) under the well-known managed-scan
 * control id — exactly the row the unchanged E6 gate reads.
 *
 * M13.3b adds the second managed-scan METHOD end-to-end through the same DEFAULT server runner, with
 * the runner image built ONCE (shared beforeAll — one oscap clean-pass + one oscap threshold-fail, no
 * rebuild loop): (f) debian:11 vs ssg-debian11 `standard` scans clean → digest-bound `scanner:openscap`
 * evidence → E6 exports; (g) oraclelinux:8 vs ssg-ol8 `standard` yields ≥1 HIGH-severity failed rule →
 * status fail → E6 refuses with a decision_id. The `rpm` executor Type is assigned `openscap` in the
 * instance scanner registry (registry-driven method selection), and `managedScanServerSettings().networkMode`
 * is asserted `none` (the offline oscap scan succeeding under it is the --network none proof).
 *
 * 13.3a's MACHINE-IMAGE arm adds the third managed-scan METHOD end-to-end through the same DEFAULT
 * server runner: (h) a clean ext4 disk image (alpine rootfs) scans clean via a real `trivy vm` →
 * digest-bound `scanner: trivy-vm` evidence → E6 exports; (i) a vulnerable disk image (debian:11
 * rootfs) breaches the fail-closed 0/0 threshold → status fail → E6 refuses with a decision_id. The
 * `infrastructure` executor Type resolves to `trivy-vm` in the seeded registry (drizzle/0048), so
 * method selection is registry-driven here too. (j) closes the DoD's remaining clause: a promotion
 * that crosses NO boundary schedules NO scan, proven against the same artifact that (i) refuses.
 *
 * The three WIRING verdicts inject a `ManagedScanRunner` (the seam the step exposes precisely so
 * these branches are hermetic and DB-drift-free): short-circuit (spy asserted NOT invoked),
 * fail-closed unassigned type (spy asserted NOT invoked), and the `digestMatch: false` evidence
 * branch (which the real runner can never reach — it refuses to even emit a report when the pulled
 * layout digest != the promoted digest, so only an injected report can drive the gate's
 * digest-mismatch refusal). Each drives the SAME deposit → E6-consumption path as (a)/(b).
 *
 * Build the runner image ONCE (beforeAll). Needs a reachable Docker daemon + network for the subject
 * pulls (the same integration tier that builds `scp-runner-iac` and pulls `registry:2`/postgres);
 * excluded from `pnpm test`, run via `pnpm test:integration`.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCAN_CONTEXT = resolve(__dirname, "../../../../apps/runner-scan");
const RUNNER_IMAGE_TAG = "scp-runner-scan:m13-3b-integration-test";

/** A real, deterministically CLEAN subject (calibrated against the pinned Trivy DB: 0 findings). */
const CLEAN_SRC = "docker://docker.io/library/alpine:3.20";
/** A real, deterministically VULNERABLE subject (calibrated: 6 CRITICAL / 19 HIGH — well over the
 *  fail-closed 0/0 default threshold). `debian:11` (bullseye) is old enough to carry advisories yet
 *  recent enough that they are NOT pruned from the DB the way EOL alpine's are. */
const DIRTY_SRC = "docker://docker.io/library/debian:11";

// --- OpenSCAP subjects (M13.3b — the second managed-scan method) ---------------------------------
// Calibrated against the runner image's PINNED, content-addressed SSG content (oscap 1.4.0 /
// scap-security-guide 0.1.74 — tools/openscap/pin.env, installed from the frozen Fedora GA release
// repo, NOT the floating updates repo) using OSCAP_PROBE_ROOT over the runner-extracted image rootfs.
// The mapping folds XCCDF high→high / medium→medium / low→low, critical stays 0 (XCCDF has none),
// unknown/unset fold away:
//   OSCAP CLEAN — debian:11 vs ssg-debian11 `anssi_np_nt28_minimal`: ZERO high/critical failed rules
//                 (only low/medium fail, which are unbounded) → within the fail-closed 0/0 (high)
//                 default → PASS. (Under SSG 0.1.74 the heavier `standard` profile carries one
//                 high-severity fail on debian:11, so the clean case uses the ANSSI *minimal* profile —
//                 the lightest baseline the pinned datastream ships — which is high-clean.)
//   OSCAP DIRTY — oraclelinux:8 vs ssg-ol8 `standard`: ≥1 HIGH-severity fail (rpm-DB-checkable package
//                 rules evaluate offline) → breaches maxHigh=0 → FAIL.
const OSCAP_CLEAN_SRC = "docker://docker.io/library/debian:11";
const OSCAP_DIRTY_SRC = "docker://docker.io/library/oraclelinux:8";
const SSG = "/usr/share/xml/scap/ssg/content";
// The clean case uses the lightest baseline (high-clean under the pinned SSG); the dirty case uses
// the heavier `standard` profile (which does carry a high-severity fail on ol8).
const OSCAP_CLEAN_PROFILE = "xccdf_org.ssgproject.content_profile_anssi_np_nt28_minimal";
const OSCAP_DIRTY_PROFILE = "xccdf_org.ssgproject.content_profile_standard";

// --- MACHINE-IMAGE subjects (13.3a — the `trivy-vm` arm, owner decision D2) -----------------------
//
// A machine image is a DISK, not a layer stack, so these subjects are built rather than pulled: an
// ext4 filesystem image carrying the OS release files + package DB that `trivy vm` reads. Built
// ROOTLESSLY with `mke2fs -d` (populate-from-directory — no mount, no loop device, no privileged
// container), so this runs on an ordinary CI worker. No partition table is written: `trivy vm`
// accepts a bare filesystem image as well as an MBR/GPT-partitioned disk, and skipping the partition
// table drops a `sfdisk`/`util-linux` dependency the base images do not all carry.
//
// Calibrated against the runner image's PINNED, baked Trivy DB, exactly like the container cases:
//   MACHINE-IMAGE CLEAN — an alpine:3.20 rootfs: 0 findings -> within the fail-closed 0/0 -> PASS.
//   MACHINE-IMAGE DIRTY — a debian:11 rootfs: 6 CRITICAL / 22 HIGH -> breaches 0/0 -> FAIL.
// The DIRTY case is the one that matters most for this arm: `trivy vm` emits a result document whose
// `Metadata` carries NO image digest and whose `ArtifactName` is a file path, so a parser that
// quietly found nothing would report all-zero counts and masquerade as clean. A subject with KNOWN
// non-zero findings is what makes the clean case's zeros meaningful.
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

      // LEVER 1: resolve the runner image ONCE (PULL the pre-built content-hash GHCR image in CI via
      // SCP_RUNNER_SCAN_IMAGE_REF, else legacy-builder BUILD it locally as a dev fallback), and start
      // the postgres-domain + a registry:2, in parallel. The DOCKER_BUILDKIT=0 legacy-builder
      // reasoning (the single-daemon net=none session wedge, PR #126 — now scoped to the local
      // fallback only) lives in resolveRunnerImage — same build path, just no longer paid on every
      // CI run.
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

      // OpenSCAP subjects.
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

      // Assign the `openscap` method to the `rpm` executor Type for THIS domain's instance-scoped
      // scanner registry (default seed is `rpm -> [trivy]`). Instance-scoped `scanner_assignments`
      // is SELECT-only for the runtime role, so the write runs over the domain's SUPERUSER admin
      // connection — the same path routes/scanner-assignments.ts uses in production. `image` stays
      // `trivy` (the trivy cases below are untouched); `configuration` stays `[]` (the fail-closed case).
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

    /**
     * Package a disk as an OCI ARTIFACT — form (1) of `run.sh`'s declared machine-image packaging
     * convention: one layer descriptor that IS the disk, carrying the SCP machine-image mediaType —
     * and push it into the local registry. Returns the manifest digest.
     *
     * The layout is hand-authored rather than produced by a packaging tool because that is exactly
     * what the convention is: nothing in the pull path is special-cased for machine images, so the
     * SERVER pulls this with the same allowlisted `skopeo copy` it uses for a container image. The
     * digest is computed from the manifest bytes we author (content-addressing, not a tool's word
     * for it) and PROVEN by the round-trip: the server re-reads the landed layout's digest and
     * refuses the scan unless it equals the promoted digest.
     */
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
      // The bundle carries the promoted OCI digest.
      expect(outcome.bundle.artifactDigests).toContain(cleanDigest);

      // The step deposited exactly the digest-bound, self-describing evidence the gate consumed.
      const runs = await managedRunsFor(changeId);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.status).toBe("pass");
      const ev = ScanEvidenceSchema.parse(run.evidence);
      expect(ev.scanner).toBe("trivy");
      expect(ev.artifactDigest).toBe(cleanDigest); // digest-bound to the PULL == the promoted digest
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

    // -------------------------------------------------------------------------------------------
    // (d) FAIL-CLOSED — an ExecutorType with NO assigned scanner produces NO evidence ⇒ E6 refuses.
    // -------------------------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------------------------
    // (f) OPENSCAP CLEAN — real oscap scan at the commander passes the profile → digest-bound
    //     `scanner: openscap` evidence → E6 exports. The `rpm` type resolves to `openscap` (seeded
    //     above), so this exercises registry-driven scanner selection AND the second method
    //     end-to-end through the DEFAULT server runner (real skopeo pull + real scp-runner-scan).
    // -------------------------------------------------------------------------------------------
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
      expect(ev.scanner).toBe("openscap"); // self-describing: the SECOND method produced this verdict
      expect(ev.artifactDigest).toBe(oscapCleanDigest); // digest-bound to the PULL == promoted digest
      expect(ev.expectedDigest).toBe(oscapCleanDigest);
      expect(ev.digestMatch).toBe(true);
      expect(ev.severityCounts.critical).toBe(0); // XCCDF has no critical — always 0 (the mapping)
      expect(ev.severityCounts.high).toBe(0); // clean of high-severity failed rules
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
      expect(ev.severityCounts.high).toBeGreaterThan(0); // ≥1 high-severity failed rule
      expect(ev.severityCounts.critical).toBe(0); // never a critical from XCCDF
    }, 180_000);

    // -------------------------------------------------------------------------------------------
    // (h) MACHINE IMAGE, CLEAN — the 13.3a `trivy-vm` arm end-to-end through the DEFAULT server
    //     runner: a real DISK image pulled by digest over the allowlisted channel, scanned by a real
    //     `trivy vm` inside a `--network none` runner → digest-bound `scanner: trivy-vm` evidence →
    //     the UNCHANGED E6 machinery exports. The `infrastructure` executor Type resolves to
    //     `trivy-vm` in the seeded registry (drizzle/0048), so this is registry-driven selection of
    //     the machine-image method, not a hard-coded branch.
    // -------------------------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------------------------
    // (i) MACHINE IMAGE, VULNERABLE — the anti-vacuity half of (h). A `trivy vm` result document
    //     differs from a `trivy image` one (no `Metadata` digest, an `ArtifactName` that is a file
    //     path), so a parser that silently matched nothing would report all-zero counts and every
    //     machine image would "scan clean". A subject with KNOWN findings proves the counts flow.
    // -------------------------------------------------------------------------------------------
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

    // -------------------------------------------------------------------------------------------
    // (j) NO BOUNDARY CROSSING ⇒ NO SCAN SCHEDULED (13.3a DoD, "default-permissive = adoption
    //     semantics only"). The commander's managed scan is a step of the CROSS-BOUNDARY export
    //     journey. A change that never crosses a boundary — one that runs its whole lifecycle inside
    //     the domain, `proposed -> ... -> accepted` — must schedule NO scan: no runner dispatch, no
    //     managed evidence, no Decision about scanning. Adopting SCP must not silently start
    //     scanning every in-domain release.
    //
    //     Non-vacuous BY CONSTRUCTION: the subject is the SAME artifact whose scan REFUSES in (i),
    //     managed scanning is fully enabled, and the change's type resolves to a real scanner. The
    //     test then EXPORTS the same change and asserts the scan does happen — so it fails both if
    //     scanning leaked onto the in-domain path and if the boundary path stopped scanning.
    // -------------------------------------------------------------------------------------------
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

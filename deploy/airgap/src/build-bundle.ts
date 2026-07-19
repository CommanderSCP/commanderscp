#!/usr/bin/env node
/**
 * @scp/airgap build-bundle — builds `scp-bundle-<version>.tar.gz` (DESIGN.md §16 "Air-gapped
 * bundle", BUILD_AND_TEST.md §8 M8). See deploy/airgap/README.md for the full bundle format and
 * usage; this file's own comments explain the WHY of each step, not just the WHAT.
 *
 * Run: `pnpm --filter @scp/airgap bundle -- --version 1.0.0-rc` (extra args after `--` are
 * commander's; see `--help` for the full flag list). Requires `skopeo`/`cosign`/`tar` on PATH —
 * see BUILD_AND_TEST.md §1. Reads the three source images from wherever they already are (local
 * Docker daemon by default — see `--*-source`); never pulls anything from the network unless
 * explicitly told to via `--*-source docker` (a deliberate, documented, operator-chosen pull —
 * not a phone-home).
 */
import { Command } from "commander";
import { cp, mkdir, rm, writeFile, chmod, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { run } from "./exec.js";
import * as skopeo from "./skopeo.js";
import * as cosign from "./cosign.js";
import { readOciManifestDigest, verifyOciLayoutIntegrity } from "./oci-layout.js";
import { buildManifest, renderManifestJson, renderManifestSh } from "./manifest.js";
import { computeChecksums, formatChecksums } from "./checksums.js";
import { buildAirgapCompose } from "./compose-retarget.js";
import { renderOfflineInstallDoc } from "./offline-install-doc.js";
import {
  ASSETS_DIR,
  BUILD_AND_TEST_DOC,
  BUNDLED_HELM_CHART_DIR,
  BUNDLED_WRAPPER,
  COMPOSE_FILE,
  DESIGN_DOC,
  HELM_CHART_DIR
} from "./repo-paths.js";
import type { BundleImage } from "./types.js";

interface ImageSourceArg {
  name: string;
  ref: string;
  sourceType: "docker-daemon" | "docker";
}

interface Opts {
  version: string;
  outDir: string;
  scpdRef: string;
  scpdSource: "docker-daemon" | "docker";
  runnerIacRef: string;
  runnerIacSource: "docker-daemon" | "docker";
  postgresRef: string;
  postgresSource: "docker-daemon" | "docker";
  argocdRef: string;
  argocdSource: "docker-daemon" | "docker";
  valkeyRef: string;
  valkeySource: "docker-daemon" | "docker";
  argoWorkflowsCliRef: string;
  argoWorkflowsCliSource: "docker-daemon" | "docker";
  argoWorkflowsControllerRef: string;
  argoWorkflowsControllerSource: "docker-daemon" | "docker";
  argoEventsRef: string;
  argoEventsSource: "docker-daemon" | "docker";
  giteaRef: string;
  giteaSource: "docker-daemon" | "docker";
}

function sourceTypeOption(value: string): "docker-daemon" | "docker" {
  if (value !== "docker-daemon" && value !== "docker") {
    throw new Error(`invalid source type '${value}' — expected "docker-daemon" or "docker"`);
  }
  return value;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("build-bundle")
    .description("Build the CommanderSCP air-gap bundle (scp-bundle-<version>.tar.gz)")
    .requiredOption("--version <version>", "bundle/release version, e.g. 1.0.0-rc")
    .option("--out-dir <dir>", "scratch/output directory", path.resolve(process.cwd(), "dist-bundle"))
    .option("--scpd-ref <ref>", "scpd image reference to bundle", "scp:dev")
    .option("--scpd-source <type>", "docker-daemon|docker", "docker-daemon")
    .option("--runner-iac-ref <ref>", "scp-runner-iac image reference to bundle", "scp-runner-iac:dev")
    .option("--runner-iac-source <type>", "docker-daemon|docker", "docker-daemon")
    .option("--postgres-ref <ref>", "eval postgres image reference to bundle", "postgres:16")
    .option("--postgres-source <type>", "docker-daemon|docker", "docker-daemon")
    .option("--argocd-ref <ref>", "bundled Argo CD image (Mode B) to bundle", "quay.io/argoproj/argocd:v3.4.5")
    .option("--argocd-source <type>", "docker-daemon|docker", "docker")
    .option("--valkey-ref <ref>", "bundled Argo CD's Valkey cache image to bundle", "valkey/valkey:8-alpine")
    .option("--valkey-source <type>", "docker-daemon|docker", "docker")
    .option("--argo-workflows-cli-ref <ref>", "bundled Argo Workflows argocli image", "quay.io/argoproj/argocli:v4.0.7")
    .option("--argo-workflows-cli-source <type>", "docker-daemon|docker", "docker")
    .option("--argo-workflows-controller-ref <ref>", "bundled Argo Workflows controller image", "quay.io/argoproj/workflow-controller:v4.0.7")
    .option("--argo-workflows-controller-source <type>", "docker-daemon|docker", "docker")
    .option("--argo-events-ref <ref>", "bundled Argo Events image", "quay.io/argoproj/argo-events:v1.9.10")
    .option("--argo-events-source <type>", "docker-daemon|docker", "docker")
    .option("--gitea-ref <ref>", "bundled Gitea image (Mode B — the default unified registry)", "docker.gitea.com/gitea:1.26.1-rootless")
    .option("--gitea-source <type>", "docker-daemon|docker", "docker")
    .parse(process.argv);

  const raw = program.opts<Record<string, string>>();
  const opts: Opts = {
    version: raw.version!,
    outDir: raw.outDir!,
    scpdRef: raw.scpdRef!,
    scpdSource: sourceTypeOption(raw.scpdSource!),
    runnerIacRef: raw.runnerIacRef!,
    runnerIacSource: sourceTypeOption(raw.runnerIacSource!),
    postgresRef: raw.postgresRef!,
    postgresSource: sourceTypeOption(raw.postgresSource!),
    argocdRef: raw.argocdRef!,
    argocdSource: sourceTypeOption(raw.argocdSource!),
    valkeyRef: raw.valkeyRef!,
    valkeySource: sourceTypeOption(raw.valkeySource!),
    argoWorkflowsCliRef: raw.argoWorkflowsCliRef!,
    argoWorkflowsCliSource: sourceTypeOption(raw.argoWorkflowsCliSource!),
    argoWorkflowsControllerRef: raw.argoWorkflowsControllerRef!,
    argoWorkflowsControllerSource: sourceTypeOption(raw.argoWorkflowsControllerSource!),
    argoEventsRef: raw.argoEventsRef!,
    argoEventsSource: sourceTypeOption(raw.argoEventsSource!),
    giteaRef: raw.giteaRef!,
    giteaSource: sourceTypeOption(raw.giteaSource!)
  };

  if (!skopeo.skopeoAvailable()) {
    throw new Error("skopeo not found on PATH — see BUILD_AND_TEST.md §1 (skopeo 1.16+)");
  }
  if (!cosign.cosignAvailable()) {
    throw new Error("cosign not found on PATH — see BUILD_AND_TEST.md §1 (cosign 2.x)");
  }

  const images: ImageSourceArg[] = [
    { name: "scpd", ref: opts.scpdRef, sourceType: opts.scpdSource },
    { name: "scp-runner-iac", ref: opts.runnerIacRef, sourceType: opts.runnerIacSource },
    { name: "postgres-eval", ref: opts.postgresRef, sourceType: opts.postgresSource },
    // Bundled executor backends (Mode B) — Argo CD + its Valkey cache. Ride the signed bundle like
    // scp-runner-iac; pulled only by domains that enable bundledExecutor.argocd. install.sh
    // retargets them onto bundledExecutor.argocd.image/.valkeyImage.
    { name: "argocd", ref: opts.argocdRef, sourceType: opts.argocdSource },
    { name: "valkey", ref: opts.valkeyRef, sourceType: opts.valkeySource },
    { name: "argo-workflows-cli", ref: opts.argoWorkflowsCliRef, sourceType: opts.argoWorkflowsCliSource },
    {
      name: "argo-workflows-controller",
      ref: opts.argoWorkflowsControllerRef,
      sourceType: opts.argoWorkflowsControllerSource
    },
    { name: "argo-events", ref: opts.argoEventsRef, sourceType: opts.argoEventsSource },
    // Bundled Gitea (Mode B — the DEFAULT unified registry, ADR-0012). Single image: Gitea runs
    // self-contained on SQLite (chart v12.6.0 minimal profile — the only upstream busybox ref was
    // the helm-test Pod, which is stripped from the vendored manifest). install.sh retargets it onto
    // bundledExecutor.gitea.image. Harbor is REMOVED from the bundled stack; an existing Harbor is
    // served via the import path (coordinated as an execution system), not bundled.
    { name: "gitea", ref: opts.giteaRef, sourceType: opts.giteaSource }
  ];

  const bundleDirName = `scp-bundle-${opts.version}`;
  const bundleRoot = path.join(opts.outDir, bundleDirName);

  process.stderr.write(`\n== @scp/airgap build-bundle: ${bundleDirName} ==\n`);
  process.stderr.write(`out: ${bundleRoot}\n\n`);

  await rm(opts.outDir, { recursive: true, force: true });
  await mkdir(path.join(bundleRoot, "images"), { recursive: true });

  // ---- 1. Images: docker-daemon/docker -> OCI layout, per-image digest capture -------------
  const daemonHost = skopeo.resolveDockerDaemonHost();
  const bundleImages: BundleImage[] = [];
  for (const image of images) {
    process.stderr.write(`\n-- image: ${image.name} (${image.sourceType}:${image.ref}) --\n`);
    const ociDir = path.join(bundleRoot, "images", image.name);
    const ociTag = opts.version;
    skopeo.copyToOciLayout({
      sourceType: image.sourceType,
      sourceRef: image.ref,
      destDir: ociDir,
      destTag: ociTag,
      daemonHost: image.sourceType === "docker-daemon" ? daemonHost : undefined
    });

    const manifestDigest = await readOciManifestDigest(ociDir);
    const integrityIssues = await verifyOciLayoutIntegrity(ociDir);
    if (integrityIssues.length > 0) {
      // skopeo just produced this directory itself — a failure here means skopeo wrote
      // something inconsistent (disk corruption, interrupted copy, a skopeo bug), not tampering.
      // Either way, do not ship it.
      throw new Error(
        `OCI layout skopeo just produced for '${image.name}' failed its own integrity check:\n` +
          integrityIssues.map((m) => `  - ${m.relativePath}: ${m.reason} (${m.detail})`).join("\n")
      );
    }

    process.stderr.write(`   digest: ${manifestDigest}\n`);
    bundleImages.push({
      name: image.name,
      sourceRef: image.ref,
      sourceType: image.sourceType,
      ociPath: path.posix.join("images", image.name),
      ociTag,
      manifestDigest
    });
  }

  // ---- 2. manifest.json / manifest.sh --------------------------------------------------------
  const builtAt = new Date().toISOString();
  const manifest = buildManifest(bundleImages, opts.version, builtAt);
  await writeFile(path.join(bundleRoot, "manifest.json"), renderManifestJson(manifest), "utf8");
  await writeFile(path.join(bundleRoot, "manifest.sh"), renderManifestSh(manifest), "utf8");

  // ---- 3. Helm chart, compose files, docs ----------------------------------------------------
  process.stderr.write("\n-- copying helm chart, compose files, docs --\n");
  await cp(HELM_CHART_DIR, path.join(bundleRoot, "helm"), { recursive: true });
  // The bundled-backends chart + its one-command wrapper ride the bundle too: install.sh applies the
  // Standard Stack via `scp-bundled.sh enable <backend> --chart helm-bundled` AFTER the SCP install
  // (the vendored manifests exceed Helm's 1 MB release-Secret limit, so they can't ride the SCP
  // release — see deploy/helm-bundled/Chart.yaml). Carries the 12 MB of vendored manifests offline.
  await cp(BUNDLED_HELM_CHART_DIR, path.join(bundleRoot, "helm-bundled"), { recursive: true });
  await copyFile(BUNDLED_WRAPPER, path.join(bundleRoot, "scp-bundled.sh"));
  await chmod(path.join(bundleRoot, "scp-bundled.sh"), 0o755);

  await mkdir(path.join(bundleRoot, "compose"), { recursive: true });
  const composeSource = await readFile(COMPOSE_FILE, "utf8");
  await copyFile(COMPOSE_FILE, path.join(bundleRoot, "compose", "docker-compose.yml"));
  await writeFile(path.join(bundleRoot, "compose", "docker-compose.airgap.yml"), buildAirgapCompose(composeSource), "utf8");

  await mkdir(path.join(bundleRoot, "docs"), { recursive: true });
  await writeFile(path.join(bundleRoot, "docs", "OFFLINE_INSTALL.md"), renderOfflineInstallDoc(opts.version), "utf8");
  await copyFile(BUILD_AND_TEST_DOC, path.join(bundleRoot, "docs", "BUILD_AND_TEST.md"));
  await copyFile(DESIGN_DOC, path.join(bundleRoot, "docs", "DESIGN.md"));

  // ---- 4. install.sh ---------------------------------------------------------------------------
  await copyFile(path.join(ASSETS_DIR, "install.sh"), path.join(bundleRoot, "install.sh"));
  await chmod(path.join(bundleRoot, "install.sh"), 0o755);

  // ---- 5. Signing key + per-image signatures ---------------------------------------------------
  process.stderr.write("\n-- signing --\n");
  const scratchDir = await cosign.makeScratchDir();
  const key = await cosign.resolveSigningKey(scratchDir);
  await copyFile(key.pubKeyPath, path.join(bundleRoot, "cosign.pub"));

  for (const image of bundleImages) {
    const digestFile = path.join(bundleRoot, "images", `${image.name}.digest`);
    await writeFile(digestFile, image.manifestDigest + "\n", "utf8");
    cosign.signBlobDetached(digestFile, `${digestFile}.sig`, key);
  }

  // ---- 6. CHECKSUMS.txt (whole extracted-bundle integrity) --------------------------------------
  process.stderr.write("\n-- checksums --\n");
  const checksumEntries = await computeChecksums(bundleRoot);
  const checksumsPath = path.join(bundleRoot, "CHECKSUMS.txt");
  await writeFile(checksumsPath, formatChecksums(checksumEntries), "utf8");
  cosign.signBlobDetached(checksumsPath, `${checksumsPath}.sig`, key);

  // ---- 7. tar+gzip, then sign the tarball itself (whole packaged-artifact integrity) ------------
  process.stderr.write("\n-- packaging --\n");
  const tarballName = `${bundleDirName}.tar.gz`;
  const tarballPath = path.join(opts.outDir, tarballName);
  run("tar", ["czf", tarballPath, "-C", opts.outDir, bundleDirName]);
  cosign.signBlobDetached(tarballPath, `${tarballPath}.sig`, key);
  // The public key travels alongside the tarball too, for the "verify before extracting" step —
  // see docs/OFFLINE_INSTALL.md's own caveat about obtaining it independently for real trust.
  await copyFile(key.pubKeyPath, path.join(opts.outDir, "cosign.pub"));

  process.stderr.write(`\n== done ==\n`);
  process.stderr.write(`tarball:   ${tarballPath}\n`);
  process.stderr.write(`signature: ${tarballPath}.sig\n`);
  process.stderr.write(`pubkey:    ${path.join(opts.outDir, "cosign.pub")}\n`);
  if (key.isEphemeral) {
    process.stderr.write(`\n*** signed with an EPHEMERAL TEST KEY (${scratchDir}) — not a real release ***\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nbuild-bundle failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

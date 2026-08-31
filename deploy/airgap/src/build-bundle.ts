#!/usr/bin/env node
/**
 * @scp/airgap build-bundle — builds `scp-bundle-<version>.tar.gz` (DESIGN.md §16 "Air-gapped
 * bundle", BUILD_AND_TEST.md §8 M8). See deploy/airgap/README.md for the full bundle format and
 * usage; this file's own comments explain the WHY of each step, not just the WHAT.
 *
 * Run: `pnpm --filter @scp/airgap bundle -- --version 1.0.0-rc` (extra args after `--` are
 * commander's; see `--help` for the full flag list). Requires `skopeo`/`cosign`/`tar` on PATH —
 * see BUILD_AND_TEST.md §1. Reads each source image from wherever it already is (local Docker
 * daemon by default — see `--*-source`); never pulls anything from the network unless explicitly
 * told to via `--*-source docker` (a deliberate, documented, operator-chosen pull — not a
 * phone-home).
 *
 * WHAT THE BUNDLE CARRIES IS NOT DECIDED HERE. `bundle-images.ts` holds the canonical list, and
 * this file derives BOTH its `--*-ref`/`--*-source` flags AND the images it copies from that one
 * array — so a bundle cannot carry an image the CLI can't point at, and the CLI cannot advertise a
 * flag for an image the bundle won't carry. `--list-images` prints the resolved list without
 * touching skopeo, which is also how `bundle-images.test.ts` proves this wiring is live.
 */
import { Command } from "commander";
import { cp, mkdir, rm, writeFile, chmod, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { run } from "@scp/cosign";
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
import { BUNDLE_IMAGE_SPECS, optionKey, type ImageSourceType } from "./bundle-images.js";
import type { BundleImage } from "./types.js";

interface ImageSourceArg {
  name: string;
  ref: string;
  sourceType: ImageSourceType;
}

function sourceTypeOption(value: string): ImageSourceType {
  if (value !== "docker-daemon" && value !== "docker") {
    throw new Error(`invalid source type '${value}' — expected "docker-daemon" or "docker"`);
  }
  return value;
}

/**
 * Register one `--<stem>-ref` / `--<stem>-source` pair per canonical image — so the CLI can never
 * advertise a flag for an image the bundle won't carry, nor omit one for an image it will.
 */
function registerImageOptions(program: Command): Command {
  for (const spec of BUNDLE_IMAGE_SPECS) {
    program
      .option(`--${spec.optionStem}-ref <ref>`, spec.flagDescription, spec.defaultRef)
      .option(`--${spec.optionStem}-source <type>`, "docker-daemon|docker", spec.defaultSource);
  }
  return program;
}

/** Resolve parsed commander options into the exact list of images the bundle will copy. */
function resolveImageSources(raw: Record<string, string>): ImageSourceArg[] {
  return BUNDLE_IMAGE_SPECS.map((spec) => ({
    name: spec.name,
    ref: raw[optionKey(spec.optionStem, "ref")]!,
    sourceType: sourceTypeOption(raw[optionKey(spec.optionStem, "source")]!)
  }));
}

async function main(): Promise<void> {
  // `--list-images` answers "which images must be present locally before I can build?", a question
  // that comes BEFORE picking a release version — so it must not trip --version's requiredOption
  // check, which commander enforces inside parse() before any of this file's code runs.
  const listImagesOnly = process.argv.includes("--list-images");

  const program = new Command();
  program
    .name("build-bundle")
    .description("Build the CommanderSCP air-gap bundle (scp-bundle-<version>.tar.gz)");
  const versionFlagDoc = "bundle/release version, e.g. 1.0.0-rc";
  if (listImagesOnly) {
    program.option("--version <version>", versionFlagDoc, "(not needed for --list-images)");
  } else {
    program.requiredOption("--version <version>", versionFlagDoc);
  }
  program
    .option(
      "--out-dir <dir>",
      "scratch/output directory",
      path.resolve(process.cwd(), "dist-bundle")
    )
    .option(
      "--list-images",
      "print the images this bundle would carry (name, source transport, source ref) and exit — " +
        "no skopeo/cosign needed. Use it to work out which images must be present locally before a build."
    );
  registerImageOptions(program).parse(process.argv);

  const raw = program.opts<Record<string, string>>();
  const opts = { version: raw.version!, outDir: raw.outDir! };

  // Resolved BEFORE the tool checks, so `--list-images` answers "what must I have locally?" on a
  // machine that has neither skopeo nor cosign yet.
  const images = resolveImageSources(raw);

  if (raw.listImages) {
    for (const image of images) {
      process.stdout.write(`${image.name}\t${image.sourceType}:${image.ref}\n`);
    }
    return;
  }

  if (!skopeo.skopeoAvailable()) {
    throw new Error("skopeo not found on PATH — see BUILD_AND_TEST.md §1 (skopeo 1.16+)");
  }
  if (!cosign.cosignAvailable()) {
    throw new Error("cosign not found on PATH — see BUILD_AND_TEST.md §1 (cosign 2.x)");
  }

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
  await writeFile(
    path.join(bundleRoot, "compose", "docker-compose.airgap.yml"),
    buildAirgapCompose(composeSource),
    "utf8"
  );

  await mkdir(path.join(bundleRoot, "docs"), { recursive: true });
  await writeFile(
    path.join(bundleRoot, "docs", "OFFLINE_INSTALL.md"),
    renderOfflineInstallDoc(opts.version),
    "utf8"
  );
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
    process.stderr.write(
      `\n*** signed with an EPHEMERAL TEST KEY (${scratchDir}) — not a real release ***\n`
    );
  }
}

main().catch((err) => {
  process.stderr.write(
    `\nbuild-bundle failed: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exitCode = 1;
});

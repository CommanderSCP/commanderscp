#!/usr/bin/env node
/**
 * @scp/airgap verify-bundle — the standalone counterpart to install.sh's own built-in verify
 * step. Cosign-verifies every image + the bundle's checksums (and, given a tarball, the tarball
 * itself) against a SUPPLIED public key, and fails loudly — non-zero exit, every problem listed —
 * on any signature mismatch or content tampering. Never trusts a `cosign.pub` found inside the
 * thing it's verifying as its OWN root of trust for the outer tarball check (see --pubkey below);
 * see deploy/airgap/README.md for the trust model this implements.
 *
 * Run: `pnpm --filter @scp/airgap verify -- --pubkey cosign.pub --dir dist-bundle/scp-bundle-1.0.0-rc`
 * or `... --pubkey cosign.pub --tarball dist-bundle/scp-bundle-1.0.0-rc.tar.gz`.
 */
import { Command } from "commander";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import * as cosignMod from "./cosign.js";
import { readOciManifestDigest, verifyOciLayoutIntegrity } from "./oci-layout.js";
import { parseManifestJson } from "./manifest.js";
import { parseChecksums, verifyChecksums } from "./checksums.js";

interface Finding {
  scope: string;
  detail: string;
}

async function verifyDirectory(bundleRoot: string, pubKeyPath: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const manifestPath = path.join(bundleRoot, "manifest.json");
  let manifest;
  try {
    manifest = parseManifestJson(await readFile(manifestPath, "utf8"));
  } catch (err) {
    findings.push({ scope: "manifest.json", detail: `unreadable/invalid: ${(err as Error).message}` });
    manifest = null;
  }

  if (manifest) {
    for (const image of manifest.images) {
      const ociDir = path.join(bundleRoot, image.ociPath);
      const scope = `images/${image.name}`;

      const integrityIssues = await verifyOciLayoutIntegrity(ociDir);
      for (const issue of integrityIssues) {
        findings.push({ scope, detail: `OCI layout integrity: ${issue.relativePath} ${issue.reason} — ${issue.detail}` });
      }

      let actualDigest: string | null = null;
      try {
        actualDigest = await readOciManifestDigest(ociDir);
      } catch (err) {
        findings.push({ scope, detail: `cannot read manifest digest: ${(err as Error).message}` });
      }
      if (actualDigest && actualDigest !== image.manifestDigest) {
        findings.push({
          scope,
          detail: `manifest.json claims ${image.manifestDigest} but the OCI layout on disk is actually ${actualDigest}`
        });
      }

      const digestFile = path.join(bundleRoot, "images", `${image.name}.digest`);
      const digestFileContent = await readFile(digestFile, "utf8").catch(() => null);
      if (digestFileContent === null) {
        findings.push({ scope, detail: `${digestFile} missing` });
      } else if (digestFileContent.trim() !== image.manifestDigest) {
        findings.push({ scope, detail: `${digestFile} content (${digestFileContent.trim()}) does not match manifest.json's recorded digest (${image.manifestDigest})` });
      } else {
        const sigResult = cosignMod.verifyBlobDetached(digestFile, `${digestFile}.sig`, pubKeyPath);
        if (!sigResult.ok) {
          findings.push({ scope, detail: `cosign signature INVALID for ${image.name}.digest: ${sigResult.detail}` });
        }
      }
    }
  }

  const checksumsPath = path.join(bundleRoot, "CHECKSUMS.txt");
  const checksumsSigPath = `${checksumsPath}.sig`;
  const checksumsText = await readFile(checksumsPath, "utf8").catch(() => null);
  if (checksumsText === null) {
    findings.push({ scope: "CHECKSUMS.txt", detail: "missing" });
  } else {
    const sigResult = cosignMod.verifyBlobDetached(checksumsPath, checksumsSigPath, pubKeyPath);
    if (!sigResult.ok) {
      findings.push({ scope: "CHECKSUMS.txt", detail: `cosign signature INVALID: ${sigResult.detail}` });
    }
    const entries = parseChecksums(checksumsText);
    const mismatches = await verifyChecksums(bundleRoot, entries);
    for (const m of mismatches) {
      findings.push({ scope: `CHECKSUMS.txt:${m.relativePath}`, detail: `${m.reason} (expected ${m.expected ?? "n/a"}, actual ${m.actual ?? "n/a"})` });
    }
  }

  return findings;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("verify-bundle")
    .description("Cosign-verify a CommanderSCP air-gap bundle (fails loudly on any tamper)")
    .requiredOption("--pubkey <path>", "public key to verify against (obtain independently of the artifact under test)")
    .option("--dir <path>", "path to an already-extracted bundle directory")
    .option("--tarball <path>", "path to a scp-bundle-<version>.tar.gz (verified as a whole, then extracted and checked)")
    .parse(process.argv);

  const opts = program.opts<{ pubkey: string; dir?: string; tarball?: string }>();
  if (!opts.dir && !opts.tarball) {
    throw new Error("one of --dir or --tarball is required");
  }
  if (opts.dir && opts.tarball) {
    throw new Error("--dir and --tarball are mutually exclusive");
  }

  const findings: Finding[] = [];
  let bundleRoot: string;
  let cleanupDir: string | null = null;

  if (opts.tarball) {
    const tarballPath = path.resolve(opts.tarball);
    const sigPath = `${tarballPath}.sig`;
    process.stderr.write(`verifying tarball signature: ${tarballPath}\n`);
    const outerResult = cosignMod.verifyBlobDetached(tarballPath, sigPath, opts.pubkey);
    if (!outerResult.ok) {
      findings.push({ scope: "tarball", detail: `cosign signature INVALID: ${outerResult.detail}` });
      // Fail fast here — if the tarball itself doesn't verify, extracting and checking its
      // contents individually would just be re-deriving the same "yes, it's tampered" answer the
      // hard way, and risks running `tar` against a maliciously-crafted archive unnecessarily.
      printAndExit(findings);
      return;
    }
    const extractDir = await mkdtemp(path.join(tmpdir(), "scp-airgap-verify-"));
    cleanupDir = extractDir;
    run("tar", ["xzf", tarballPath, "-C", extractDir]);
    const entries = await readdir(extractDir);
    const first = entries[0];
    if (entries.length !== 1 || !first) {
      throw new Error(`expected exactly one top-level directory in ${tarballPath}, found: ${entries.join(", ") || "(empty)"}`);
    }
    bundleRoot = path.join(extractDir, first);
  } else {
    bundleRoot = path.resolve(opts.dir!);
  }

  try {
    findings.push(...(await verifyDirectory(bundleRoot, opts.pubkey)));
  } finally {
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  }

  printAndExit(findings);
}

function printAndExit(findings: Finding[]): void {
  if (findings.length === 0) {
    process.stderr.write("\nOK — every signature verified, no tampering detected.\n");
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`\nFAILED — ${findings.length} problem(s) found:\n`);
  for (const f of findings) {
    process.stderr.write(`  [${f.scope}] ${f.detail}\n`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`\nverify-bundle failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

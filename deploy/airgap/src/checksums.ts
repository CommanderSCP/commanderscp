/** CHECKSUMS.txt in sha256sum format, dependency-free. See docs/airgap.md §19. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ChecksumEntry } from "./types.js";

/** sha256 of a file's contents, streamed (bundle images can be hundreds of MB — never buffer the whole file). */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** sha256 of an in-memory buffer/string — for small artifacts (digest files, manifest.json) where streaming would be overkill. */
export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Recursively list every regular file under `root`, returned as POSIX-style paths relative to `root`, sorted for deterministic output. */
export async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
      // symlinks are deliberately not followed — a bundle should never contain one, and
      // silently following one is exactly the kind of thing that turns a checksum manifest
      // into a false sense of security.
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/** Entries for every bundle file, excluding itself and its sig. See docs/airgap.md §20. */
export async function computeChecksums(
  bundleRoot: string,
  excludeRelativePaths: string[] = ["CHECKSUMS.txt", "CHECKSUMS.txt.sig"]
): Promise<ChecksumEntry[]> {
  const excluded = new Set(excludeRelativePaths);
  const files = (await listFilesRecursive(bundleRoot)).filter((f) => !excluded.has(f));
  const entries: ChecksumEntry[] = [];
  for (const relativePath of files) {
    const digest = await sha256File(path.join(bundleRoot, relativePath));
    entries.push({ digest, relativePath });
  }
  return entries;
}

export function formatChecksums(entries: ChecksumEntry[]): string {
  return entries.map((e) => `${e.digest}  ${e.relativePath}`).join("\n") + "\n";
}

/** Parse `sha256sum`-format text back into entries. Tolerates trailing newline/blank lines; rejects malformed lines loudly (a truncated/corrupted CHECKSUMS.txt is itself a tamper signal). */
export function parseChecksums(text: string): ChecksumEntry[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(
        `malformed CHECKSUMS.txt line (expected "<64-hex sha256>  <path>"): ${JSON.stringify(line)}`
      );
    }
    const digest = match[1];
    const relativePath = match[2];
    if (!digest || !relativePath) {
      throw new Error(`malformed CHECKSUMS.txt line: ${JSON.stringify(line)}`);
    }
    return { digest, relativePath };
  });
}

export interface ChecksumMismatch {
  relativePath: string;
  expected: string | undefined;
  actual: string | undefined;
  reason: "digest-mismatch" | "missing-on-disk" | "unexpected-extra-file";
}

/** Verify every entry; the installer's exit code hinges on it. See docs/airgap.md §21. */
export async function verifyChecksums(
  bundleRoot: string,
  expected: ChecksumEntry[]
): Promise<ChecksumMismatch[]> {
  const mismatches: ChecksumMismatch[] = [];
  const expectedByPath = new Map(expected.map((e) => [e.relativePath, e.digest]));

  for (const entry of expected) {
    const fullPath = path.join(bundleRoot, entry.relativePath);
    try {
      await stat(fullPath);
    } catch {
      mismatches.push({
        relativePath: entry.relativePath,
        expected: entry.digest,
        actual: undefined,
        reason: "missing-on-disk"
      });
      continue;
    }
    const actual = await sha256File(fullPath);
    if (actual !== entry.digest) {
      mismatches.push({
        relativePath: entry.relativePath,
        expected: entry.digest,
        actual,
        reason: "digest-mismatch"
      });
    }
  }

  // Also catch files that were ADDED and aren't in the manifest at all (excluding the checksums
  // file/signature, which by construction never appear in their own manifest).
  const onDisk = await listFilesRecursive(bundleRoot);
  for (const relativePath of onDisk) {
    if (relativePath === "CHECKSUMS.txt" || relativePath === "CHECKSUMS.txt.sig") continue;
    if (!expectedByPath.has(relativePath)) {
      mismatches.push({
        relativePath,
        expected: undefined,
        actual: undefined,
        reason: "unexpected-extra-file"
      });
    }
  }

  return mismatches;
}

/**
 * `CHECKSUMS.txt` generation/parsing — the coreutils `sha256sum`-format manifest the milestone
 * brief asks for ("checksums file, e.g. sha256sum-format CHECKSUMS.txt"). Kept dependency-free
 * (`node:crypto`/`node:fs` only) and pure enough to unit test without touching skopeo/cosign.
 *
 * Format: one line per file, `<64-hex-char sha256>  <path relative to bundle root>\n` (two
 * spaces, matching `sha256sum`'s own output so `sha256sum -c CHECKSUMS.txt` — a tool every
 * Linux/macOS box already has — works as a manual sanity check even without this package's own
 * verify-bundle.ts).
 */
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

/**
 * Compute a CHECKSUMS.txt-shaped entry list for every file under `bundleRoot`, excluding the
 * checksums file itself and its signature (they can't checksum themselves, and the signature
 * file's own integrity is what covers CHECKSUMS.txt).
 */
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

/** Render entries as `sha256sum -c`-compatible text. */
export function formatChecksums(entries: ChecksumEntry[]): string {
  return entries.map((e) => `${e.digest}  ${e.relativePath}`).join("\n") + "\n";
}

/** Parse `sha256sum`-format text back into entries. Tolerates trailing newline/blank lines; rejects malformed lines loudly (a truncated/corrupted CHECKSUMS.txt is itself a tamper signal). */
export function parseChecksums(text: string): ChecksumEntry[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      throw new Error(`malformed CHECKSUMS.txt line (expected "<64-hex sha256>  <path>"): ${JSON.stringify(line)}`);
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

/**
 * Verify every entry in `expected` against the real files under `bundleRoot`. Returns an empty
 * array on success. This is the function verify-bundle.ts's exit code hinges on — it must never
 * silently pass a bundle where a file was added, removed, or modified.
 */
export async function verifyChecksums(bundleRoot: string, expected: ChecksumEntry[]): Promise<ChecksumMismatch[]> {
  const mismatches: ChecksumMismatch[] = [];
  const expectedByPath = new Map(expected.map((e) => [e.relativePath, e.digest]));

  for (const entry of expected) {
    const fullPath = path.join(bundleRoot, entry.relativePath);
    try {
      await stat(fullPath);
    } catch {
      mismatches.push({ relativePath: entry.relativePath, expected: entry.digest, actual: undefined, reason: "missing-on-disk" });
      continue;
    }
    const actual = await sha256File(fullPath);
    if (actual !== entry.digest) {
      mismatches.push({ relativePath: entry.relativePath, expected: entry.digest, actual, reason: "digest-mismatch" });
    }
  }

  // Also catch files that were ADDED and aren't in the manifest at all (excluding the checksums
  // file/signature, which by construction never appear in their own manifest).
  const onDisk = await listFilesRecursive(bundleRoot);
  for (const relativePath of onDisk) {
    if (relativePath === "CHECKSUMS.txt" || relativePath === "CHECKSUMS.txt.sig") continue;
    if (!expectedByPath.has(relativePath)) {
      mismatches.push({ relativePath, expected: undefined, actual: undefined, reason: "unexpected-extra-file" });
    }
  }

  return mismatches;
}

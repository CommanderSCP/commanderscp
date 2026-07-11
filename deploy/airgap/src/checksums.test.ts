import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeChecksums,
  formatChecksums,
  listFilesRecursive,
  parseChecksums,
  sha256Bytes,
  sha256File,
  verifyChecksums
} from "./checksums.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scp-airgap-test-"));
}

describe("sha256Bytes / sha256File", () => {
  it("agree on the same content", async () => {
    const dir = await makeTempDir();
    try {
      const file = path.join(dir, "a.txt");
      await writeFile(file, "hello world", "utf8");
      expect(await sha256File(file)).toBe(sha256Bytes("hello world"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces the well-known sha256 of an empty string", () => {
    expect(sha256Bytes("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("listFilesRecursive", () => {
  it("finds nested files, sorted, as posix-style relative paths", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(path.join(dir, "b", "c"), { recursive: true });
      await writeFile(path.join(dir, "top.txt"), "1", "utf8");
      await writeFile(path.join(dir, "b", "mid.txt"), "2", "utf8");
      await writeFile(path.join(dir, "b", "c", "deep.txt"), "3", "utf8");

      const files = await listFilesRecursive(dir);
      expect(files).toEqual(["b/c/deep.txt", "b/mid.txt", "top.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("computeChecksums / formatChecksums / parseChecksums round-trip", () => {
  it("round-trips through the sha256sum-format text", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "one.txt"), "one", "utf8");
      await writeFile(path.join(dir, "two.txt"), "two", "utf8");

      const entries = await computeChecksums(dir);
      const text = formatChecksums(entries);
      expect(text).toMatch(/^[a-f0-9]{64} {2}one\.txt\n[a-f0-9]{64} {2}two\.txt\n$/);

      const parsed = parseChecksums(text);
      expect(parsed).toEqual(entries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes CHECKSUMS.txt and CHECKSUMS.txt.sig by default", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "real.txt"), "content", "utf8");
      await writeFile(path.join(dir, "CHECKSUMS.txt"), "stale", "utf8");
      await writeFile(path.join(dir, "CHECKSUMS.txt.sig"), "stale-sig", "utf8");

      const entries = await computeChecksums(dir);
      expect(entries.map((e) => e.relativePath)).toEqual(["real.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parseChecksums rejects a malformed line", () => {
    expect(() => parseChecksums("not-a-valid-line\n")).toThrow(/malformed/);
  });
});

describe("verifyChecksums — the tamper-detection gate", () => {
  it("returns no mismatches for an untouched bundle", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "file.txt"), "original content", "utf8");
      const entries = await computeChecksums(dir);
      const mismatches = await verifyChecksums(dir, entries);
      expect(mismatches).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a modified file (digest-mismatch)", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "file.txt"), "original content", "utf8");
      const entries = await computeChecksums(dir);

      // Tamper: overwrite after the checksum was taken.
      await writeFile(path.join(dir, "file.txt"), "TAMPERED content", "utf8");

      const mismatches = await verifyChecksums(dir, entries);
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]).toMatchObject({ relativePath: "file.txt", reason: "digest-mismatch" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a removed file (missing-on-disk)", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "file.txt"), "content", "utf8");
      const entries = await computeChecksums(dir);
      await rm(path.join(dir, "file.txt"));

      const mismatches = await verifyChecksums(dir, entries);
      expect(mismatches).toEqual([{ relativePath: "file.txt", expected: entries[0]!.digest, actual: undefined, reason: "missing-on-disk" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects an added file not present in the manifest (unexpected-extra-file)", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(path.join(dir, "file.txt"), "content", "utf8");
      const entries = await computeChecksums(dir);

      // Tamper: sneak an extra file in after the checksum manifest was built.
      await writeFile(path.join(dir, "sneaky.txt"), "malicious payload", "utf8");

      const mismatches = await verifyChecksums(dir, entries);
      expect(mismatches).toEqual([{ relativePath: "sneaky.txt", expected: undefined, actual: undefined, reason: "unexpected-extra-file" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

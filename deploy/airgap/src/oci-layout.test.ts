import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOciManifestDigest, verifyOciLayoutIntegrity } from "./oci-layout.js";

/**
 * Builds a minimal-but-real OCI-layout directory by hand (no skopeo dependency for these unit
 * tests — a real skopeo-produced layout is exercised separately in the package README's manual
 * end-to-end run). The shape mirrors exactly what `skopeo copy ... oci:<dir>:<tag>` writes:
 * `index.json` naming one manifest blob by digest, and that blob's bytes stored content-
 * addressed at `blobs/sha256/<hex>`.
 */
async function makeFakeOciLayout(dir: string, manifestBytes: string): Promise<string> {
  const digest = createHash("sha256").update(manifestBytes, "utf8").digest("hex");
  await mkdir(path.join(dir, "blobs", "sha256"), { recursive: true });
  await writeFile(path.join(dir, "blobs", "sha256", digest), manifestBytes, "utf8");
  await writeFile(
    path.join(dir, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${digest}`, size: manifestBytes.length }]
    }),
    "utf8"
  );
  return `sha256:${digest}`;
}

describe("readOciManifestDigest", () => {
  it("reads the digest out of a valid index.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      const digest = await makeFakeOciLayout(dir, '{"fake":"manifest"}');
      expect(await readOciManifestDigest(dir)).toBe(digest);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on a missing index.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      await expect(readOciManifestDigest(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws on an index.json with more than one manifest entry", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "index.json"),
        JSON.stringify({
          schemaVersion: 2,
          manifests: [
            { mediaType: "x", digest: "sha256:" + "a".repeat(64), size: 1 },
            { mediaType: "x", digest: "sha256:" + "b".repeat(64), size: 1 }
          ]
        }),
        "utf8"
      );
      await expect(readOciManifestDigest(dir)).rejects.toThrow(/expected exactly 1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyOciLayoutIntegrity — the OCI-layout tamper-detection gate", () => {
  it("passes a well-formed, untampered layout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      await makeFakeOciLayout(dir, '{"fake":"manifest"}');
      expect(await verifyOciLayoutIntegrity(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a blob whose content no longer matches its content-addressed filename", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      const digest = await makeFakeOciLayout(dir, '{"fake":"manifest"}');
      const hex = digest.slice("sha256:".length);

      // Tamper: overwrite the blob's bytes in place, so the filename (a content digest) now lies
      // about what's actually there — exactly the "swapped image body under an untouched digest
      // file" attack install.sh's own header comment calls out.
      await writeFile(path.join(dir, "blobs", "sha256", hex), '{"tampered":"manifest"}', "utf8");

      const issues = await verifyOciLayoutIntegrity(dir);
      expect(issues.some((i) => i.reason === "blob-digest-mismatch" && i.relativePath === `blobs/sha256/${hex}`)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects index.json pointing at a manifest digest whose blob doesn't exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-airgap-oci-"));
    try {
      await mkdir(path.join(dir, "blobs", "sha256"), { recursive: true });
      await writeFile(
        path.join(dir, "index.json"),
        JSON.stringify({
          schemaVersion: 2,
          manifests: [{ mediaType: "x", digest: "sha256:" + "c".repeat(64), size: 1 }]
        }),
        "utf8"
      );
      const issues = await verifyOciLayoutIntegrity(dir);
      expect(issues.some((i) => i.reason === "missing-blob")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

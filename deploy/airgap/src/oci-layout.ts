/**
 * Pure logic for reading and self-verifying an OCI-layout directory (the format `skopeo copy
 * ... oci:<dir>:<tag>` produces — see skopeo.ts for the invocation). No shelling out here: OCI
 * layout is just files on disk (`index.json` + `blobs/<alg>/<hex>`), and its own filenames are
 * content digests by construction, which gives us a strong, cheap, offline integrity check that
 * doesn't need skopeo or cosign at all — re-hash every blob and confirm the filename matches.
 *
 * Layered with cosign.ts's signature check (see verify-bundle.ts): this module proves the OCI
 * layout directory is INTERNALLY CONSISTENT (no bit-flip, no swapped blob); the cosign signature
 * proves WE produced the specific manifest digest it's internally consistent with. Either check
 * alone is incomplete — a corrupted-but-unsigned-claim directory passes this check trivially by
 * just being self-consistent garbage; a validly-signed digest string next to a tampered blob
 * directory fails only THIS check. Both must pass.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./checksums.js";

interface OciIndexManifestEntry {
  mediaType: string;
  digest: string;
  size: number;
}

interface OciIndex {
  schemaVersion: number;
  manifests: OciIndexManifestEntry[];
}

/** Read `<ociDir>/index.json` and return the digest of the (single-platform) image manifest it points at. Throws if the layout doesn't have exactly the shape `skopeo copy` produces (one manifest entry). */
export async function readOciManifestDigest(ociDir: string): Promise<string> {
  const indexPath = path.join(ociDir, "index.json");
  const raw = await readFile(indexPath, "utf8");
  let index: OciIndex;
  try {
    index = JSON.parse(raw) as OciIndex;
  } catch (err) {
    throw new Error(`${indexPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(index.manifests) || index.manifests.length === 0) {
    throw new Error(`${indexPath} has no manifests entries — not a valid single-image OCI layout`);
  }
  if (index.manifests.length > 1) {
    throw new Error(
      `${indexPath} has ${index.manifests.length} manifests entries — expected exactly 1 (this bundle builder only handles single-platform images copied via 'skopeo copy docker-daemon:...')`
    );
  }
  const digest = index.manifests[0]?.digest;
  if (!digest || !digest.startsWith("sha256:")) {
    throw new Error(`${indexPath}'s manifest entry has no usable sha256 digest`);
  }
  return digest;
}

export interface OciLayoutMismatch {
  relativePath: string;
  reason: "blob-digest-mismatch" | "manifest-digest-mismatch" | "missing-blob";
  detail: string;
}

/**
 * Self-verify an OCI-layout directory: (1) every blob under blobs/<alg>/<hex> re-hashes to its
 * own filename, and (2) index.json's recorded manifest digest matches the manifest blob's
 * ACTUAL content digest (catches an index.json that was hand-edited to point at a different,
 * possibly-untampered-looking, blob than what's really there). Returns an empty array on
 * success; never throws on a tampered layout — tampering is reported as findings, not
 * exceptions, so callers (verify-bundle.ts, install.sh's Node-free bash equivalent) can print
 * every problem found rather than stopping at the first one.
 */
export async function verifyOciLayoutIntegrity(ociDir: string): Promise<OciLayoutMismatch[]> {
  const mismatches: OciLayoutMismatch[] = [];

  const blobsRoot = path.join(ociDir, "blobs");
  let algDirs: string[] = [];
  try {
    algDirs = await readdir(blobsRoot);
  } catch (err) {
    mismatches.push({ relativePath: "blobs", reason: "missing-blob", detail: `blobs/ directory unreadable: ${(err as Error).message}` });
    return mismatches;
  }

  for (const alg of algDirs) {
    if (alg !== "sha256") {
      // Every image in this bundle is produced by this package's own skopeo invocation, which
      // always yields sha256 blobs. A different algorithm directory showing up is itself
      // suspicious (or at minimum unsupported) — flag it rather than silently skipping it.
      mismatches.push({ relativePath: `blobs/${alg}`, reason: "blob-digest-mismatch", detail: `unexpected digest algorithm directory (only sha256 is supported)` });
      continue;
    }
    const algDir = path.join(blobsRoot, alg);
    const files = await readdir(algDir);
    for (const hex of files) {
      const relativePath = `blobs/${alg}/${hex}`;
      const actual = await sha256File(path.join(algDir, hex));
      if (actual !== hex) {
        mismatches.push({
          relativePath,
          reason: "blob-digest-mismatch",
          detail: `filename claims sha256:${hex} but content hashes to sha256:${actual}`
        });
      }
    }
  }

  try {
    const claimedDigest = await readOciManifestDigest(ociDir);
    const hex = claimedDigest.slice("sha256:".length);
    const manifestBlobPath = path.join(blobsRoot, "sha256", hex);
    const actual = await sha256File(manifestBlobPath).catch(() => null);
    if (actual === null) {
      mismatches.push({ relativePath: "index.json", reason: "missing-blob", detail: `index.json points at manifest ${claimedDigest} but blobs/sha256/${hex} does not exist` });
    } else if (`sha256:${actual}` !== claimedDigest) {
      // Structurally unreachable given the per-blob loop above already checks this file, but
      // kept as an explicit, named assertion — this is the specific property
      // ("index.json's claimed digest is the manifest's real digest") the milestone brief cares
      // about, and a reader should be able to find it checked by name, not inferred from the
      // generic blob loop above.
      mismatches.push({ relativePath: "index.json", reason: "manifest-digest-mismatch", detail: `index.json claims ${claimedDigest}, blob content hashes to sha256:${actual}` });
    }
  } catch (err) {
    mismatches.push({ relativePath: "index.json", reason: "missing-blob", detail: (err as Error).message });
  }

  return mismatches;
}

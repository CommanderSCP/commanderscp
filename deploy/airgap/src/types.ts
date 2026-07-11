/**
 * Shared types for the air-gap bundle builder/verifier (DESIGN.md §16 "Air-gapped bundle",
 * BUILD_AND_TEST.md §8 M8). Kept dependency-free so it can be imported from both the CLI
 * entrypoints and the pure-logic modules under test.
 */

/** One image the bundle carries, in OCI layout, alongside its pinned content digest. */
export interface BundleImage {
  /** Short logical name used as the directory/file stem everywhere in the bundle (e.g. "scpd"). */
  name: string;
  /** The image reference `build-bundle` was pointed at (e.g. "scp:dev", "postgres:16"). Informational — NOT trusted for verification; the digest is. */
  sourceRef: string;
  /** Where `skopeo copy`'s source transport pulled from. */
  sourceType: "docker-daemon" | "docker";
  /** Path, relative to the bundle root, of this image's OCI-layout directory. */
  ociPath: string;
  /** The tag skopeo used inside the OCI layout (`oci:<dir>:<tag>`) — NOT a trust anchor, just a layout requirement. */
  ociTag: string;
  /** The manifest digest (`sha256:<hex>`) skopeo produced for this image. This is the trust anchor: install.sh pins the retargeted registry reference to this exact digest. */
  manifestDigest: string;
}

/** The bundle-wide manifest written as both `manifest.json` (rich, for Node tooling) and `manifest.sh` (flat, for install.sh — no jq dependency). */
export interface BundleManifest {
  bundleVersion: string;
  builtAt: string;
  builtBy: string;
  images: BundleImage[];
}

/** A single line of a `sha256sum`-format checksums file: "<hex digest>  <relative path>". */
export interface ChecksumEntry {
  digest: string;
  relativePath: string;
}

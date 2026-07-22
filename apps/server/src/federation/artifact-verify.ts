/**
 * M17.4(b) — PER-ARTIFACT BYTE VERIFICATION at the receiving outpost, a PRE-DEPLOY gate.
 *
 * ## Where this sits (and what it is NOT)
 *
 * M17.4 has two halves. Part (a) (#106, promotion-repo.ts::verifyPromotionManifest) is the
 * METADATA verify that runs at bundle IMPORT: it cosign-verifies the commander's self-binding
 * manifest and asserts `bundle.artifacts` EXACTLY equals the signed `manifest.artifacts` set — so
 * after (a), "the arrived artifact SET == the authorized SET" is already proven, and that verified
 * set is recorded on the imported change's `sourceRef.artifacts` (with `promotionManifest`).
 *
 * Part (b) — THIS module — is the complementary BYTE verify, and it deliberately canNOT run at
 * import: a federation bundle carries no bytes (ADR-0009), the operator side-loads the artifact
 * BYTES into the outpost's local registry AFTER the metadata import (or, commercially, the bytes
 * are commander-registry-resident). So (b) is a PRE-DEPLOY gate: before SCP triggers the deploy
 * executor for a promoted change, it re-reads the registry the bytes landed in and, for EACH
 * artifact in the (a)-verified authorized set, proves the BYTES are present and their signature
 * verifies against the exporter's distributed cosign public key. `verifyPromotionManifest` proved
 * "these are the authorized digests"; this proves "the bytes for THOSE digests are here and
 * authentic". Together they complete M17.4.
 *
 * ## Coordinate-not-execute (charter principle 1)
 *
 * SCP only READS the registry to verify — `cosign verify` (OCI, registry-attached signature) and
 * `cosign verify-blob` (blob, detached origin signature). It NEVER transports bytes between
 * registries/domains (that is byte TRANSPORT, M15.5) and NEVER re-scans (scan-at-source is trusted;
 * the export gate already enforced a passing scan per substantive artifact — M17.1/E6). No
 * byte-moving code lives here.
 *
 * ## Fail-closed
 *
 * A MISSING artifact (bytes absent from the reachable registry) OR a failing/tampered/wrong-key
 * signature makes that artifact FAIL, and any failing artifact blocks the deploy. Keyful and
 * offline throughout (no Fulcio/Rekor) — see @scp/cosign.
 */
import type { ArtifactRef } from "@scp/schemas";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeScratchDir, verifyBlobDetached, verifyImageSignature } from "@scp/cosign";

/** The bytes + origin detached signature a `blob` artifact resolves to in the reachable registry. */
export interface ResolvedBlob {
  bytes: Buffer;
  /** The ORIGIN executor's detached cosign signature over `bytes` (the content of the artifact's
   *  `signatureRef`), as a string — exactly what `cosign verify-blob --signature` consumes. */
  signature: string;
}

/**
 * Resolves each authorized artifact to the concrete thing `cosign verify` needs from the registry
 * the bytes landed in. This is the ONLY seam that knows HOW the outpost locates bytes in ITS
 * registry — decoupled on purpose from "verify the located bytes", because the concrete
 * byte-landing channel (operator side-load into local Gitea vs. commander registry) is M15.5's
 * concern. The verify logic below is registry-agnostic; it just consumes what the reader returns.
 *
 * BOTH methods return `null` when the artifact's BYTES are absent from the reachable registry — a
 * MISSING artifact, which the gate treats as fail-closed. They should NOT throw for "absent"; a
 * thrown error is an infrastructure fault and is likewise treated fail-closed by the caller.
 */
export interface ArtifactRegistryReader {
  /** The fully-qualified, digest-pinned image reference (`registry/repo@sha256:…`) this OCI
   *  artifact resolves to in the reachable registry, or `null` if it is not present. */
  resolveOci(artifact: ArtifactRef): Promise<string | null>;
  /** The blob's bytes + its origin detached signature from the reachable registry, or `null` if
   *  the bytes are not present. */
  resolveBlob(artifact: ArtifactRef): Promise<ResolvedBlob | null>;
}

export interface ArtifactVerifyOutcome {
  type: ArtifactRef["type"];
  digest: string;
  ok: boolean;
  reason: string;
}

export interface PerArtifactVerifyResult {
  ok: boolean;
  outcomes: ArtifactVerifyOutcome[];
  /** The failing subset, for a compact Decision `inputContext` / block reason. */
  failing: ArtifactVerifyOutcome[];
}

async function verifyOne(
  artifact: ArtifactRef,
  cosignPublicKeyPem: string,
  reader: ArtifactRegistryReader,
  allowInsecureRegistry: boolean
): Promise<ArtifactVerifyOutcome> {
  const base = { type: artifact.type, digest: artifact.digest };
  try {
    if (artifact.type === "oci") {
      const imageRef = await reader.resolveOci(artifact);
      if (!imageRef) {
        return { ...base, ok: false, reason: "oci image bytes absent from the reachable registry (fail-closed)" };
      }
      const ok = await verifyImageSignature(imageRef, cosignPublicKeyPem, { allowInsecureRegistry });
      return ok
        ? { ...base, ok: true, reason: `oci signature verified (${imageRef})` }
        : { ...base, ok: false, reason: `oci signature verification failed (${imageRef})` };
    }

    // blob (today: the build-time SBOM, and any other detached-signed document).
    const resolved = await reader.resolveBlob(artifact);
    if (!resolved) {
      return { ...base, ok: false, reason: "blob bytes absent from the reachable registry (fail-closed)" };
    }
    if (!artifact.signatureRef) {
      // No origin signature reference to verify against — cannot prove authenticity, so fail closed
      // rather than wave an unsigned blob through.
      return { ...base, ok: false, reason: "blob carries no origin signatureRef to verify against (fail-closed)" };
    }
    const dir = await makeScratchDir();
    try {
      const blobPath = path.join(dir, "blob.bin");
      const sigPath = path.join(dir, "blob.sig");
      await writeFile(blobPath, resolved.bytes);
      await writeFile(sigPath, resolved.signature, "utf8");
      const pubPath = path.join(dir, "cosign.pub");
      await writeFile(pubPath, cosignPublicKeyPem, "utf8");
      const result = verifyBlobDetached(blobPath, sigPath, pubPath);
      return result.ok
        ? { ...base, ok: true, reason: "blob detached signature verified" }
        : { ...base, ok: false, reason: "blob detached signature verification failed" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    // Infrastructure fault (registry unreachable, reader threw, cosign could not run). Fail closed —
    // an artifact we could not verify is not an artifact we deploy.
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, ok: false, reason: `verification error (fail-closed): ${message}` };
  }
}

export interface VerifyAuthorizedArtifactSetArgs {
  /** The (a)-verified authorized set — the imported change's `sourceRef.artifacts`. */
  artifacts: ArtifactRef[];
  /** The EXPORTER's distributed cosign PUBLIC key PEM (`currentPeerCosignPublicKey` for the
   *  promoting peer). Both OCI and blob signatures are verified against THIS key. */
  cosignPublicKeyPem: string;
  reader: ArtifactRegistryReader;
  /** Passed through to OCI `cosign verify` — true for the outpost-local (HTTP/self-signed)
   *  registry; the signature, not registry TLS, is the trust anchor. */
  allowInsecureRegistry?: boolean;
}

/**
 * Verify EVERY artifact in the authorized set — the pre-deploy gate's core. Never throws: every
 * per-artifact failure (missing, tampered, wrong key, infra fault) is captured as `ok: false`, and
 * the aggregate `ok` is true only when ALL artifacts verified. An EMPTY set verifies vacuously
 * (`ok: true`) — a metadata-only promotion carrying no substantive bytes has nothing to byte-check,
 * exactly as the export scan gate passes vacuously over zero substantive artifacts.
 */
export async function verifyAuthorizedArtifactSet(
  args: VerifyAuthorizedArtifactSetArgs
): Promise<PerArtifactVerifyResult> {
  const allowInsecureRegistry = args.allowInsecureRegistry ?? false;
  const outcomes: ArtifactVerifyOutcome[] = [];
  for (const artifact of args.artifacts) {
    outcomes.push(await verifyOne(artifact, args.cosignPublicKeyPem, args.reader, allowInsecureRegistry));
  }
  const failing = outcomes.filter((o) => !o.ok);
  return { ok: failing.length === 0, outcomes, failing };
}

/**
 * The production {@link ArtifactRegistryReader}: resolves artifacts from their `ArtifactRef.location`
 * (and `signatureRef`) — the reference the receiving outpost's registry resolution populates when
 * the bytes land (M15.5). Registry-agnostic by construction:
 *
 *   - OCI: `location` (when set) is the fully-qualified, digest-pinned image ref in the local
 *     registry; absent an explicit `location`, an OCI `digest` alone does not locate a repository,
 *     so the artifact is UNRESOLVABLE → treated as absent (fail-closed) until the byte channel
 *     records where the image landed.
 *   - blob: `location` is an HTTP(S) URL to fetch the blob bytes; `signatureRef` is an HTTP(S) URL
 *     to fetch the origin detached signature. A `404` (bytes not there yet) resolves to absent; a
 *     transport error propagates and the gate fails closed.
 *
 * This reads bytes only to HASH/VERIFY them (a temp buffer, never re-pushed) — a registry READ, not
 * byte transport (M15.5). No credentials are held; the local registry is reachable to the outpost.
 */
export class LocationRegistryReader implements ArtifactRegistryReader {
  async resolveOci(artifact: ArtifactRef): Promise<string | null> {
    const ref = artifact.location?.trim();
    if (ref && ref.length > 0) return ref;
    return null;
  }

  async resolveBlob(artifact: ArtifactRef): Promise<ResolvedBlob | null> {
    const location = artifact.location?.trim();
    const sigRef = artifact.signatureRef?.trim();
    if (!location || !isHttpUrl(location)) return null;
    const bytes = await fetchBytes(location);
    if (bytes === null) return null; // absent (404) → fail-closed missing.
    // The origin detached signature must itself be fetchable; an unfetchable/absent signature means
    // we cannot prove authenticity → surface as an EMPTY signature, which fails verification closed.
    const signature = sigRef && isHttpUrl(sigRef) ? ((await fetchBytes(sigRef))?.toString("utf8") ?? "") : "";
    return { bytes, signature };
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/** GET a URL's bytes; `null` on a 404 (absent), throw on any other transport/HTTP fault (infra). */
async function fetchBytes(url: string): Promise<Buffer | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry read ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

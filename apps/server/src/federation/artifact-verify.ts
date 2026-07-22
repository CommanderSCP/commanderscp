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
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeScratchDir, verifyBlobDetached, verifyImageSignature } from "@scp/cosign";
import { assertEgressAllowed } from "../plugin-host/egress-guard.js";

/**
 * ## Digest binding (substitution/replay defense)
 *
 * The signed promotion manifest binds `{type, digest, signatureRef}` — `location` is BUNDLE-SIDE
 * metadata, populated when the bytes land, and is NOT covered by any signature. So `location` is
 * hostile-controllable and must NEVER pick what gets verified: a location pointing at a DIFFERENT
 * validly-signed artifact (same exporter key) would otherwise pass. This module therefore binds
 * every verification to the AUTHORIZED `artifact.digest`:
 *
 *   - OCI: the ref handed to `cosign verify` is CONSTRUCTED from the location's repository part +
 *     `@<artifact.digest>` — cosign then registry-verifies content-addressed bytes AT that digest.
 *     If the location carries a digest suffix that differs from `artifact.digest`, that is a
 *     substitution attempt → fail closed WITHOUT invoking cosign.
 *   - blob: sha256 over the FETCHED bytes must equal `artifact.digest` before the detached
 *     signature verdict counts — validly-signed but WRONG bytes fail closed.
 */

/** Normalize a sha256 digest (`sha256:<64 hex>` or bare hex) to lowercase `sha256:<hex>`;
 *  `null` when it is not a well-formed sha256 digest (unverifiable → caller fails closed). */
export function normalizeSha256Digest(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/**
 * Bind a resolved OCI reference to the AUTHORIZED digest: keep the repository (and any tag) part,
 * force the digest to `artifact.digest`. A resolved ref whose own digest suffix disagrees with the
 * authorized digest is a substitution attempt and fails WITHOUT invoking cosign.
 */
function bindOciRefToAuthorizedDigest(
  resolvedRef: string,
  authorizedDigest: string
): { ok: true; ref: string } | { ok: false; reason: string } {
  const digest = normalizeSha256Digest(authorizedDigest);
  if (!digest) {
    return {
      ok: false,
      reason: `authorized artifact digest '${authorizedDigest}' is not a well-formed sha256 digest — cannot bind verification (fail-closed)`
    };
  }
  const at = resolvedRef.lastIndexOf("@");
  let repoPart = resolvedRef;
  if (at >= 0) {
    const refDigest = normalizeSha256Digest(resolvedRef.slice(at + 1));
    if (refDigest !== digest) {
      return {
        ok: false,
        reason:
          `oci digest mismatch: resolved location pins '${resolvedRef.slice(at + 1)}' but the ` +
          `authorized (manifest-signed) digest is '${digest}' — location is unsigned and cannot ` +
          `substitute the artifact (fail-closed)`
      };
    }
    repoPart = resolvedRef.slice(0, at);
  }
  return { ok: true, ref: `${repoPart}@${digest}` };
}

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
      const resolvedRef = await reader.resolveOci(artifact);
      if (!resolvedRef) {
        return { ...base, ok: false, reason: "oci image bytes absent from the reachable registry (fail-closed)" };
      }
      // DIGEST BINDING: never verify whatever the (unsigned) location points at — verify AT the
      // authorized digest. A location pinning a different digest is a substitution → fail closed
      // before cosign ever runs.
      const bound = bindOciRefToAuthorizedDigest(resolvedRef, artifact.digest);
      if (!bound.ok) return { ...base, ok: false, reason: bound.reason };
      const imageRef = bound.ref;
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
    // DIGEST BINDING: the fetched bytes must BE the authorized artifact — a valid signature over
    // DIFFERENT bytes (substitution via the unsigned location) must not pass. Checked before the
    // signature verdict counts.
    const authorizedDigest = normalizeSha256Digest(artifact.digest);
    if (!authorizedDigest) {
      return {
        ...base,
        ok: false,
        reason: `authorized artifact digest '${artifact.digest}' is not a well-formed sha256 digest — cannot bind verification (fail-closed)`
      };
    }
    const fetchedDigest = `sha256:${createHash("sha256").update(resolved.bytes).digest("hex")}`;
    if (fetchedDigest !== authorizedDigest) {
      return {
        ...base,
        ok: false,
        reason:
          `blob digest mismatch: fetched bytes hash to '${fetchedDigest}' but the authorized ` +
          `(manifest-signed) digest is '${authorizedDigest}' — location is unsigned and cannot ` +
          `substitute the artifact (fail-closed)`
      };
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
 *     records where the image landed. The location's REGISTRY HOST is bundle-supplied and unsigned,
 *     so it is egress-guarded BEFORE cosign ever dials it: the host must appear in the
 *     operator-configured `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4; fail-closed
 *     when unset), symmetric with the blob URL guard below — digest binding already prevents
 *     SUBSTITUTION, this prevents a hostile bundle picking the egress TARGET.
 *   - blob: `location` is an HTTP(S) URL to fetch the blob bytes; `signatureRef` is an HTTP(S) URL
 *     to fetch the origin detached signature. A `404` (bytes not there yet) resolves to absent; a
 *     transport error propagates and the gate fails closed. BOTH URLs are bundle-supplied and
 *     unsigned, so they are SSRF-guarded before any request: they must fall under an
 *     operator-configured base URL (`SCP_ARTIFACT_BLOB_BASE_URLS`, fail-closed when unset), may
 *     never resolve to link-local/cloud-metadata or the unspecified address, redirects are refused,
 *     and responses are size-capped — see `assertBlobUrlAllowed`/`fetchBytes`.
 *
 * This reads bytes only to HASH/VERIFY them (a temp buffer, never re-pushed) — a registry READ, not
 * byte transport (M15.5). No credentials are held; the local registry is reachable to the outpost.
 */
export class LocationRegistryReader implements ArtifactRegistryReader {
  /** Operator-configured base URLs blob `location`/`signatureRef` may fall under (SSRF guard). */
  private readonly allowedBlobBaseUrls: URL[];
  /** Operator-configured OCI registry `host[:port]` entries cosign may dial (egress guard —
   *  ADR-0019 §4, the blob allowlist's symmetric other half). */
  private readonly allowedOciRegistryHosts: string[];

  constructor(opts?: { allowedBlobBaseUrls?: string[]; allowedOciRegistryHosts?: string[] }) {
    const raw = opts?.allowedBlobBaseUrls ?? blobBaseUrlsFromEnv();
    this.allowedBlobBaseUrls = raw
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
      .map((b) => new URL(b));
    this.allowedOciRegistryHosts = (opts?.allowedOciRegistryHosts ?? ociRegistryHostsFromEnv())
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0);
  }

  async resolveOci(artifact: ArtifactRef): Promise<string | null> {
    const ref = artifact.location?.trim();
    if (!ref || ref.length === 0) return null;
    // OCI-HOST EGRESS GUARD (fail-closed, BEFORE cosign ever dials): the location's registry host
    // is bundle-supplied, unsigned metadata. Digest binding (verifyOne) already prevents artifact
    // SUBSTITUTION, but `cosign verify` still performs registry-API GETs against whatever host the
    // location names — a blind egress channel symmetric to the blob fetch. The host must be
    // operator-allowlisted (SCP_ARTIFACT_OCI_REGISTRY_HOSTS); throwing surfaces as a
    // `verification error (fail-closed)` on the artifact, exactly like the blob URL guard.
    this.assertOciRegistryHostAllowed(ref);
    return ref;
  }

  async resolveBlob(artifact: ArtifactRef): Promise<ResolvedBlob | null> {
    const location = artifact.location?.trim();
    const sigRef = artifact.signatureRef?.trim();
    if (!location || !isHttpUrl(location)) return null;
    // SSRF GUARD (fail-closed, BEFORE any request): `location`/`signatureRef` are bundle-supplied,
    // unsigned strings — a hostile bundle must not turn the outpost into a blind in-cluster GET
    // client at deploy time. Both URLs must fall under an operator-CONFIGURED blob base URL
    // (SCP_ARTIFACT_BLOB_BASE_URLS), and even then may never target link-local (cloud metadata) or
    // the unspecified address. Throwing here surfaces as a `verification error (fail-closed)`.
    await this.assertBlobUrlAllowed(location);
    const bytes = await fetchBytes(location);
    if (bytes === null) return null; // absent (404) → fail-closed missing.
    // The origin detached signature must itself be fetchable; an unfetchable/absent signature means
    // we cannot prove authenticity → surface as an EMPTY signature, which fails verification closed.
    let signature = "";
    if (sigRef && isHttpUrl(sigRef)) {
      await this.assertBlobUrlAllowed(sigRef);
      signature = (await fetchBytes(sigRef))?.toString("utf8") ?? "";
    }
    return { bytes, signature };
  }

  /** Throws unless `url` falls under an operator-configured blob base URL (origin AND path prefix
   *  — the port matters: a same-host different-port URL is a different service). Reuses the plugin
   *  egress guard afterwards for the always-blocked classes (link-local/cloud-metadata,
   *  unspecified), DNS-resolved; loopback/private are permitted because the operator explicitly
   *  configured this base (the outpost-local registry is commonly in-cluster/private). */
  private async assertBlobUrlAllowed(url: string): Promise<void> {
    if (this.allowedBlobBaseUrls.length === 0) {
      throw new Error(
        `blob location '${url}' rejected: no operator-configured blob base URLs ` +
          `(SCP_ARTIFACT_BLOB_BASE_URLS) — bundle-supplied URLs are never fetched unguarded (SSRF, fail-closed)`
      );
    }
    const target = new URL(url);
    const underAllowedBase = this.allowedBlobBaseUrls.some((base) => {
      if (target.origin !== base.origin) return false;
      const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
      return target.pathname === base.pathname || target.pathname.startsWith(basePath);
    });
    if (!underAllowedBase) {
      throw new Error(
        `blob location '${url}' rejected: not under any operator-configured blob base URL ` +
          `(SCP_ARTIFACT_BLOB_BASE_URLS) — bundle-supplied URLs cannot steer outpost egress (SSRF, fail-closed)`
      );
    }
    // Defense in depth via the EXISTING plugin egress guard: link-local (169.254/16 incl. cloud
    // metadata, fe80::/10) and unspecified are blocked unconditionally, after DNS resolution.
    // Empty allowlist + allowInternalPrivate=true → only those always-blocked classes apply here.
    await assertEgressAllowed(url, [], true);
  }

  /** Throws unless the OCI ref's registry `host[:port]` matches an operator-configured allowlist
   *  entry EXACTLY (case-insensitive; no suffix/wildcard matching — a `host:port` is a specific
   *  service, exactly as the blob guard treats origins). UNSET/empty allowlist rejects every OCI
   *  location (fail-closed) — the operator opts the OCI verify egress in explicitly, symmetric
   *  with SCP_ARTIFACT_BLOB_BASE_URLS. */
  private assertOciRegistryHostAllowed(ref: string): void {
    if (this.allowedOciRegistryHosts.length === 0) {
      throw new Error(
        `oci registry host not allowlisted: location '${ref}' rejected — no operator-configured ` +
          `OCI registry hosts (SCP_ARTIFACT_OCI_REGISTRY_HOSTS unset = every OCI verify refused; ` +
          `bundle-supplied registry hosts are never dialed unguarded, fail-closed)`
      );
    }
    const host = ociRegistryHostOf(ref);
    if (!host) {
      throw new Error(
        `oci registry host not allowlisted: location '${ref}' carries no explicit registry host ` +
          `(a hostless ref would dial an implicit default registry) — refusing to dial (fail-closed)`
      );
    }
    if (!this.allowedOciRegistryHosts.includes(host)) {
      throw new Error(
        `oci registry host not allowlisted: '${host}' (location '${ref}') is not in the ` +
          `operator-configured OCI registry hosts (SCP_ARTIFACT_OCI_REGISTRY_HOSTS) — ` +
          `bundle-supplied locations cannot steer outpost egress (fail-closed)`
      );
    }
  }
}

/**
 * The registry `host[:port]` an OCI reference would dial, lowercased, or `null` when the ref names
 * no explicit registry. Per the docker/OCI reference grammar the first `/`-separated component is a
 * registry host only when it contains a `.` or a `:` or is exactly `localhost` — otherwise the ref
 * is repo-only shorthand that an OCI client resolves against an IMPLICIT default registry, which an
 * allowlist can never vouch for → `null` (caller fails closed).
 */
export function ociRegistryHostOf(ref: string): string | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const first = ref.slice(0, slash).toLowerCase();
  if (first === "localhost" || first.includes(".") || first.includes(":")) return first;
  return null;
}

/** `SCP_ARTIFACT_BLOB_BASE_URLS` — comma-separated, operator-configured base URLs the outpost's
 *  blob byte channel actually lives at. UNSET means NO blob location is fetchable (fail-closed):
 *  the operator opts the byte channel in explicitly; bundles never pick egress targets. */
function blobBaseUrlsFromEnv(): string[] {
  return (process.env.SCP_ARTIFACT_BLOB_BASE_URLS ?? "").split(",");
}

/** `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` — comma-separated, operator-configured OCI registry
 *  `host[:port]` entries the per-artifact `cosign verify` may dial (ADR-0019 §4 — the symmetric
 *  other half of SCP_ARTIFACT_BLOB_BASE_URLS). UNSET means EVERY OCI verify is refused
 *  (fail-closed): the operator opts the OCI egress in explicitly; bundles never pick dial targets. */
function ociRegistryHostsFromEnv(): string[] {
  return (process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS ?? "").split(",");
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/** Blobs here are detached-signed DOCUMENTS (SBOMs et al.), not images — 64 MiB is generous, and a
 *  cap means a hostile/looping location cannot balloon outpost memory (fail-closed above it). */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/** GET a URL's bytes; `null` on a 404 (absent), throw on any other transport/HTTP fault (infra).
 *  Redirects are NOT followed (a redirect could re-point an allowed URL at a forbidden target) and
 *  the response is size-capped — both throw, surfacing as fail-closed verification errors. */
async function fetchBytes(url: string): Promise<Buffer | null> {
  const res = await fetch(url, { redirect: "error" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry read ${url} -> HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
    throw new Error(`registry read ${url} -> declared ${declared} bytes exceeds the ${MAX_BLOB_BYTES}-byte blob cap`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BLOB_BYTES) {
      await reader.cancel();
      throw new Error(`registry read ${url} -> response exceeds the ${MAX_BLOB_BYTES}-byte blob cap`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

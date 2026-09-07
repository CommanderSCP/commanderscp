/** Per-artifact byte verification at the receiving outpost. See docs/federation.md §4. */
import type { ArtifactRef } from "@scp/schemas";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeScratchDir, verifyBlobDetached, verifyImageSignature } from "@scp/cosign";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
  assertEgressAllowed,
  createEgressPinRegistry,
  type VerifiedEgressTarget
} from "../plugin-host/egress-guard.js";

/** ## Digest binding. See docs/federation.md §5. */

/** Normalize a sha256 digest (`sha256:<64 hex>` or bare hex) to lowercase `sha256:<hex>`;
 *  `null` when it is not a well-formed sha256 digest (unverifiable → caller fails closed). */
export function normalizeSha256Digest(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/** Bind a resolved OCI reference to the AUTHORIZED digest. See docs/federation.md §6. */
export function bindOciRefToAuthorizedDigest(
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

/** Resolves each authorized artifact to what cosign needs. See docs/federation.md §7. */
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
  allowInsecureRegistry: AllowInsecureRegistry,
  cosignEnv: NodeJS.ProcessEnv | undefined
): Promise<ArtifactVerifyOutcome> {
  const base = { type: artifact.type, digest: artifact.digest };
  try {
    if (artifact.type === "oci") {
      const resolvedRef = await reader.resolveOci(artifact);
      if (!resolvedRef) {
        return {
          ...base,
          ok: false,
          reason: "oci image bytes absent from the reachable registry (fail-closed)"
        };
      }
      // DIGEST BINDING: never verify whatever the (unsigned) location points at — verify AT the
      // authorized digest. A location pinning a different digest is a substitution → fail closed
      // before cosign ever runs.
      const bound = bindOciRefToAuthorizedDigest(resolvedRef, artifact.digest);
      if (!bound.ok) return { ...base, ok: false, reason: bound.reason };
      const imageRef = bound.ref;
      // PER-HOST TLS scoping: with the predicate form, `--allow-insecure-registry` is granted only
      // for the specific registry host this ref dials (mirroring skopeo's per-host
      // `--…-tls-verify=false`); a hostless ref (predicate unanswerable) stays TLS-verified.
      const host = ociRegistryHostOf(imageRef);
      const allowInsecure =
        typeof allowInsecureRegistry === "function"
          ? host !== null && allowInsecureRegistry(host)
          : allowInsecureRegistry;
      const ok = await verifyImageSignature(imageRef, cosignPublicKeyPem, {
        allowInsecureRegistry: allowInsecure,
        env: cosignEnv
      });
      return ok
        ? { ...base, ok: true, reason: `oci signature verified (${imageRef})` }
        : { ...base, ok: false, reason: `oci signature verification failed (${imageRef})` };
    }

    // blob (today: the build-time SBOM, and any other detached-signed document).
    const resolved = await reader.resolveBlob(artifact);
    if (!resolved) {
      return {
        ...base,
        ok: false,
        reason: "blob bytes absent from the reachable registry (fail-closed)"
      };
    }
    if (!artifact.signatureRef) {
      // No origin signature reference to verify against — cannot prove authenticity, so fail closed
      // rather than wave an unsigned blob through.
      return {
        ...base,
        ok: false,
        reason: "blob carries no origin signatureRef to verify against (fail-closed)"
      };
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

/** Whether verify may skip registry TLS, and how narrowly. See docs/federation.md §8. */
export type AllowInsecureRegistry = boolean | ((registryHost: string) => boolean);

export interface VerifyAuthorizedArtifactSetArgs {
  /** The (a)-verified authorized set — the imported change's `sourceRef.artifacts`. */
  artifacts: ArtifactRef[];
  /** The EXPORTER's distributed cosign PUBLIC key PEM (`currentPeerCosignPublicKey` for the
   *  promoting peer). Both OCI and blob signatures are verified against THIS key. */
  cosignPublicKeyPem: string;
  reader: ArtifactRegistryReader;
  /** Passed through to OCI `cosign verify` — see {@link AllowInsecureRegistry}. The signature,
   *  not registry TLS, is the trust anchor for HTTP/self-signed registries, but TLS-off must
   *  still be host-scoped operator configuration, never a blanket default. */
  allowInsecureRegistry?: AllowInsecureRegistry;
  /** Extra environment for the verify subprocesses only. See docs/federation.md §9. */
  cosignEnv?: NodeJS.ProcessEnv;
}

/** Verify EVERY artifact in the authorized set. See docs/federation.md §10. */
export async function verifyAuthorizedArtifactSet(
  args: VerifyAuthorizedArtifactSetArgs
): Promise<PerArtifactVerifyResult> {
  const allowInsecureRegistry = args.allowInsecureRegistry ?? false;
  const outcomes: ArtifactVerifyOutcome[] = [];
  for (const artifact of args.artifacts) {
    outcomes.push(
      await verifyOne(
        artifact,
        args.cosignPublicKeyPem,
        args.reader,
        allowInsecureRegistry,
        args.cosignEnv
      )
    );
  }
  const failing = outcomes.filter((o) => !o.ok);
  return { ok: failing.length === 0, outcomes, failing };
}

/** The production {@link ArtifactRegistryReader}. See docs/federation.md §11. */
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
    this.allowedOciRegistryHosts = opts?.allowedOciRegistryHosts
      ? parseRegistryHostList(opts.allowedOciRegistryHosts)
      : ociRegistryHostsFromEnv();
  }

  async resolveOci(artifact: ArtifactRef): Promise<string | null> {
    const ref = artifact.location?.trim();
    if (!ref || ref.length === 0) return null;
    // OCI-HOST EGRESS GUARD. See docs/federation.md §12.
    this.assertOciRegistryHostAllowed(ref);
    return ref;
  }

  async resolveBlob(artifact: ArtifactRef): Promise<ResolvedBlob | null> {
    const location = artifact.location?.trim();
    const sigRef = artifact.signatureRef?.trim();
    if (!location || !isHttpUrl(location)) return null;
    // SSRF GUARD (fail-closed, BEFORE any request). See docs/federation.md §13.
    const locationTarget = await this.assertBlobUrlAllowed(location);
    const bytes = await fetchBytes(location, locationTarget);
    if (bytes === null) return null; // absent (404) → fail-closed missing.
    // The origin detached signature must itself be fetchable; an unfetchable/absent signature means
    // we cannot prove authenticity → surface as an EMPTY signature, which fails verification closed.
    let signature = "";
    if (sigRef && isHttpUrl(sigRef)) {
      const sigTarget = await this.assertBlobUrlAllowed(sigRef);
      signature = (await fetchBytes(sigRef, sigTarget))?.toString("utf8") ?? "";
    }
    return { bytes, signature };
  }

  /** Throws unless the URL falls under a configured blob base. See docs/federation.md §14. */
  private async assertBlobUrlAllowed(url: string): Promise<VerifiedEgressTarget> {
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
    // Defense in depth via the EXISTING plugin egress guard. See docs/federation.md §15.
    return assertEgressAllowed(url, [], true);
  }

  /** Throws unless the registry host is on the allowlist. See docs/federation.md §16. */
  protected assertOciRegistryHostAllowed(ref: string): void {
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

/** Normalize a registry `host[:port]` allowlist. See docs/federation.md §17. */
export function parseRegistryHostList(raw: string | readonly string[] | undefined): string[] {
  const entries = typeof raw === "string" ? raw.split(",") : (raw ?? []);
  return entries.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
}

/** The registry host an OCI reference would dial, or null. See docs/federation.md §18. */
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
  return parseRegistryHostList(process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS);
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
async function fetchBytes(url: string, target: VerifiedEgressTarget): Promise<Buffer | null> {
  // Pinned to the address the guard classified, via a short-lived Agent whose `connect.lookup`
  // answers only from that pin (undici's own `fetch`, because Node's global one is powered by a
  // separately-bundled undici and rejects a dispatcher built from this install).
  const pins = createEgressPinRegistry();
  const dispatcher = new UndiciAgent({ connect: { lookup: pins.lookup } });
  const release = pins.pin(target);
  try {
    return await readBoundedBlob(url, dispatcher);
  } finally {
    release();
    // `destroy()`, NOT `close()`. See docs/federation.md §19.
    await dispatcher.destroy();
  }
}

async function readBoundedBlob(url: string, dispatcher: UndiciAgent): Promise<Buffer | null> {
  const res = await undiciFetch(url, { redirect: "error", dispatcher });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry read ${url} -> HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
    throw new Error(
      `registry read ${url} -> declared ${declared} bytes exceeds the ${MAX_BLOB_BYTES}-byte blob cap`
    );
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
      throw new Error(
        `registry read ${url} -> response exceeds the ${MAX_BLOB_BYTES}-byte blob cap`
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

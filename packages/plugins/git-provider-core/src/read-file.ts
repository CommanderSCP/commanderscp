import type { PluginContext } from "@scp/plugin-api";
import { isScopedHttpResponseTooLargeError } from "@scp/plugin-api";

/** The provider-neutral half of reading one file at a ref. See docs/plugins.md §97. */

export interface ReadFileAtRefRequest {
  /** Repository to read from, as the provider's own `owner/repo`. See docs/plugins.md §98. */
  repo?: string;
  /** Repo-relative path to a single file, e.g. `services/api/package.json`. No leading `/`, no `..`
   *  — enforced by {@link assertSafeRepoPath}, which REFUSES rather than normalizes. */
  path: string;
  /** Branch, tag, or commit sha. A fully-qualified `refs/heads/x` form works wherever the provider
   *  accepts it; adapters encode it per path segment so a `feature/x` branch survives. Validated by
   *  {@link assertSafeRef} — percent-encoding alone does NOT make it URL-safe. */
  ref: string;
  /** Upper bound on bytes this call will DECODE. Defaults to {@link DEFAULT_MAX_FILE_BYTES} and is
   *  clamped to {@link HARD_MAX_FILE_BYTES} — see `resolveMaxBytes`. */
  maxBytes?: number;
}

/** The file was read. `content` is the decoded UTF-8 text; `commitSha` is what `ref` RESOLVED TO. */
export interface ReadFileAtRefFound {
  outcome: "found";
  path: string;
  /** The ref as asked for, carried back so a caller can log what it requested vs what it got. */
  requestedRef: string;
  /** The commit `requestedRef` resolved to. See docs/plugins.md §99. */
  commitSha: string;
  content: string;
  /** Decoded length in bytes (NOT `content.length`, which counts UTF-16 code units). */
  sizeBytes: number;
  /** Provider blob/object id when the response carried one — never fabricated when it did not. */
  blobSha?: string;
}

/** The file (or the ref) is not there. See docs/plugins.md §100. */
export interface ReadFileAtRefNotFound {
  outcome: "not_found";
  missing: "path" | "ref" | "unknown";
  path: string;
  requestedRef: string;
  detail?: string;
}

/** Why a file that EXISTS was deliberately not decoded. See docs/plugins.md §101. */
export type ReadFileRefusalReason =
  /** Bigger than the decode bound — see {@link resolveMaxBytes}. */
  | "too_large"
  /** The path resolved to a directory, symlink or submodule, not a blob. */
  | "not_a_file"
  /** Decoded bytes are not text: a NUL byte, or not valid UTF-8. */
  | "not_text"
  /** The provider returned a transfer encoding this decoder does not implement. */
  | "unsupported_encoding"
  /**
   * FEWER BYTES ARRIVED THAN THE PROVIDER SAID THE FILE HAS — a cut response, a truncating proxy, a
   * partially-written payload.
   *
   * NO CONSUMER CAN DETECT THIS FROM THE CONTENT, which is why it is refused here rather than left
   * to them. Every one of ADR-0032's manifest formats is line-oriented or brace-balanced, and the
   * first N bytes of a `requirements.txt` are still a perfectly valid `requirements.txt` — there is
   * no construct missing to notice. The declared size and the payload's own length are both in hand
   * only at this point.
   *
   * It is a REFUSAL rather than a `found` carrying short content because of what the one consumer
   * does with a successful read: the inventory ingestion prunes a manifest's declarations down to
   * exactly what it just parsed, so a body missing its second half would silently DELETE the
   * declarations that never arrived. "Unreadable is not empty" is why four of the five manifest
   * parsers throw on a body that is not their format; this is that same rule for the case none of
   * them can see, and it covers all six manifests at once rather than the one spelling (a Git-LFS
   * pointer) that happens to be recognisable from the text.
   */
  | "incomplete_body";

export interface ReadFileAtRefRefused {
  outcome: "refused";
  reason: ReadFileRefusalReason;
  /** Human-readable specifics — always states the measured/declared numbers where there are any. */
  detail: string;
  path: string;
  requestedRef: string;
  /** Size in bytes where one is known (provider-declared or computed pre-decode). */
  sizeBytes?: number;
}

export type ReadFileAtRefResult = ReadFileAtRefFound | ReadFileAtRefNotFound | ReadFileAtRefRefused;

/** Default decode ceiling. See docs/plugins.md §102. */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;

/** An absolute ceiling, applied to caller-supplied bounds too. See docs/plugins.md §103. */
export const HARD_MAX_FILE_BYTES = 4 * 1_048_576;

/** The effective decode bound for one call. See docs/plugins.md §104. */
export function resolveMaxBytes(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return Math.min(Math.floor(requested), HARD_MAX_FILE_BYTES);
}

// The TRANSPORT bound. See docs/plugins.md §105.

/** Headroom over the decode bound, for the transport ceiling. See docs/plugins.md §106. */
const RESPONSE_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/** The response ceiling a contents fetch should pass. See docs/plugins.md §107. */
export function resolveMaxResponseBytes(maxBytes: number): number {
  return Math.ceil((maxBytes * 4) / 3) + RESPONSE_ENVELOPE_HEADROOM_BYTES;
}

/** The default response ceiling for every other call here. See docs/plugins.md §108. */
export const DEFAULT_API_RESPONSE_MAX_BYTES = 16 * 1_048_576;

/** Decoded byte length, computed without allocating. See docs/plugins.md §109. */
export function base64DecodedByteLength(base64: string): number {
  const compact = base64.replace(/\s+/g, "");
  if (compact.length === 0) return 0;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

export interface DecodeBoundedBase64Input {
  provider: string;
  path: string;
  requestedRef: string;
  commitSha: string;
  /** The provider's base64 payload, with or without embedded newlines. */
  base64: string;
  /** The provider's own `encoding` literal, when it reports one (`"base64"`, GitHub's `"none"`, …). */
  encoding?: string;
  /** The provider's own declared size in bytes, when it reports one. */
  declaredSizeBytes?: number;
  /** Already resolved through {@link resolveMaxBytes} by the caller. */
  maxBytes: number;
  blobSha?: string;
}

/** base64 → bounded, verified UTF-8 text. See docs/plugins.md §110. */
export function decodeBoundedBase64(input: DecodeBoundedBase64Input): ReadFileAtRefResult {
  const { path, requestedRef, maxBytes } = input;

  if (input.encoding !== undefined && input.encoding !== "base64") {
    if (input.encoding === "none") {
      return {
        outcome: "refused",
        reason: "too_large",
        detail:
          `${input.provider}: returned encoding "none" with no inline content for '${path}'` +
          (input.declaredSizeBytes !== undefined
            ? ` (declared ${input.declaredSizeBytes} bytes)`
            : "") +
          " — the provider's own signal that the blob is too large to serve inline",
        path,
        requestedRef,
        sizeBytes: input.declaredSizeBytes
      };
    }
    return {
      outcome: "refused",
      reason: "unsupported_encoding",
      detail: `${input.provider}: unsupported content encoding '${input.encoding}' for '${path}' (only base64 is decoded)`,
      path,
      requestedRef,
      sizeBytes: input.declaredSizeBytes
    };
  }

  // Gate 2 — the size the provider DECLARES, refused before the payload is touched.
  if (input.declaredSizeBytes !== undefined && input.declaredSizeBytes > maxBytes) {
    return {
      outcome: "refused",
      reason: "too_large",
      detail: `${input.provider}: '${path}' is ${input.declaredSizeBytes} bytes, over the ${maxBytes}-byte decode bound (provider-declared size)`,
      path,
      requestedRef,
      sizeBytes: input.declaredSizeBytes
    };
  }

  // Gate 3 — the size the PAYLOAD implies. Independent of gate 2 on purpose.
  const computedBytes = base64DecodedByteLength(input.base64);
  if (computedBytes > maxBytes) {
    return {
      outcome: "refused",
      reason: "too_large",
      detail: `${input.provider}: '${path}' decodes to ${computedBytes} bytes, over the ${maxBytes}-byte decode bound (computed from the payload)`,
      path,
      requestedRef,
      sizeBytes: computedBytes
    };
  }

  // Gate 3b — THE BYTES THAT ARRIVED ARE NOT THE FILE. See docs/plugins.md §111.
  if (input.declaredSizeBytes !== undefined && computedBytes < input.declaredSizeBytes) {
    return {
      outcome: "refused",
      reason: "incomplete_body",
      detail:
        `${input.provider}: '${path}' arrived as ${computedBytes} bytes but the provider declares ` +
        `${input.declaredSizeBytes} — the body is partial, so it is not decoded as the file's ` +
        `content (a truncated manifest parses as FEWER dependencies, which is indistinguishable ` +
        `from a manifest that dropped them)`,
      path,
      requestedRef,
      sizeBytes: computedBytes
    };
  }

  const buffer = Buffer.from(input.base64, "base64");

  // Gate 4a — NUL byte: git's own binary heuristic, applied to the whole (already-bounded) buffer
  // rather than git's first 8000 bytes, since we have all of it and it is cheap.
  const nulAt = buffer.indexOf(0);
  if (nulAt !== -1) {
    return {
      outcome: "refused",
      reason: "not_text",
      detail: `${input.provider}: '${path}' contains a NUL byte at offset ${nulAt} — treated as binary, not decoded as text`,
      path,
      requestedRef,
      sizeBytes: buffer.byteLength
    };
  }

  const content = buffer.toString("utf8");

  // Gate 4b — UTF-8 round trip. `toString("utf8")` substitutes U+FFFD for invalid sequences instead
  // of failing, so re-encoding and comparing is the only way to learn that it did.
  if (!Buffer.from(content, "utf8").equals(buffer)) {
    return {
      outcome: "refused",
      reason: "not_text",
      detail: `${input.provider}: '${path}' is not valid UTF-8 (decode would substitute replacement characters) — treated as binary`,
      path,
      requestedRef,
      sizeBytes: buffer.byteLength
    };
  }

  return {
    outcome: "found",
    path,
    requestedRef,
    commitSha: input.commitSha,
    content,
    sizeBytes: buffer.byteLength,
    blobSha: input.blobSha
  };
}

// URL safety — `path` and `ref` are caller-supplied and get interpolated into a REST path

/** Rejects a repo path that must never reach a URL. See docs/plugins.md §112. */
export function assertSafeRepoPath(provider: string, path: string): void {
  if (path.length === 0) {
    throw new Error(`${provider} readFileAtRef: path is empty`);
  }
  if (path.startsWith("/")) {
    throw new Error(
      `${provider} readFileAtRef: path '${path}' must be repo-relative (no leading '/')`
    );
  }
  if (path.includes("\\")) {
    throw new Error(`${provider} readFileAtRef: path '${path}' contains a backslash`);
  }
  const segments = path.split("/");
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error(
      `${provider} readFileAtRef: path '${path}' contains a '.'/'..' segment — refused (it would re-target the REST route, not just the file)`
    );
  }
  if (segments.some((s) => s.length === 0)) {
    throw new Error(`${provider} readFileAtRef: path '${path}' contains an empty segment`);
  }
}

/** Characters a git ref may never contain. See docs/plugins.md §113. */
// `no-control-regex` exists to catch a control character that got into a pattern by ACCIDENT. Here
// the control range IS the rule being expressed, so the rule is disabled for this one line rather
// than the range being split into a separate charCode loop — which would leave git's single list
// expressed in two places.
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f ~^:?*[\\]/;

/** Rejects a ref that must never reach a URL, refusing not fixing. See docs/plugins.md §114. */
export function assertSafeRef(provider: string, ref: string): void {
  const refuse = (why: string): never => {
    throw new Error(`${provider} readFileAtRef: ref '${ref}' ${why}`);
  };
  if (ref.length === 0) refuse("is empty");
  if (ref.includes("..")) {
    refuse("contains '..' — refused (it would re-target the REST route, not just the ref)");
  }
  if (REF_FORBIDDEN_CHARACTERS.test(ref)) {
    refuse("contains a character git forbids in a ref name (control/space or one of ~^:?*[\\)");
  }
  if (ref.startsWith("/") || ref.endsWith("/")) refuse("begins or ends with '/'");
  if (ref.includes("@{")) refuse("contains '@{' — git's reflog syntax, not a ref name");
  if (ref === "@") refuse("is the single character '@', which git reserves");
  if (ref.endsWith(".")) refuse("ends with '.'");
  for (const segment of ref.split("/")) {
    if (segment.length === 0) refuse("contains an empty segment");
    if (segment.startsWith(".")) refuse(`has a segment beginning with '.' ('${segment}')`);
    if (segment.endsWith(".lock")) refuse(`has a segment ending with '.lock' ('${segment}')`);
  }
}

/** The characters a repo or owner segment may contain. See docs/plugins.md §115. */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Rejects a caller-supplied `repo` that must never reach a URL. See docs/plugins.md §116. */
export function assertSafeRepo(provider: string, repo: string, exactSegments?: number): void {
  const refuse = (why: string): never => {
    throw new Error(`${provider} readFileAtRef: repo '${repo}' ${why}`);
  };
  if (repo.length === 0) refuse("is empty");
  if (repo.startsWith("/") || repo.endsWith("/")) refuse("begins or ends with '/'");
  const segments = repo.split("/");
  // Per-segment checks run BEFORE the count check on purpose: `acme/widgets/../../..` fails both,
  // and "contains a '..' segment" is the message an operator can act on — "wrong segment count"
  // would describe the symptom and hide the reason.
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      refuse("contains a '.'/'..' segment — refused (it would re-target the REST route)");
    }
    if (!REPO_SEGMENT.test(segment)) {
      refuse(`has a segment '${segment}' outside [A-Za-z0-9._-]`);
    }
  }
  if (exactSegments !== undefined && segments.length !== exactSegments) {
    refuse(`must have exactly ${exactSegments} '/'-separated segments for ${provider}`);
  }
}

/** Percent-encodes per segment, keeping the separator literal. See docs/plugins.md §117. */
export function encodePathSegments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/** An error raised by the read path itself, already carrying provider + URL context. Marked so a
 *  wrapper can recognise its own product and not double-wrap it. */
export interface GitProviderReadError extends Error {
  gitProviderRead: true;
  provider: string;
  url: string;
}

export function isGitProviderReadError(err: unknown): err is GitProviderReadError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { gitProviderRead?: unknown }).gitProviderRead === true
  );
}

export function gitProviderReadError(
  provider: string,
  url: string,
  message: string,
  cause?: unknown
): GitProviderReadError {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    gitProviderRead: true as const,
    provider,
    url
  });
}

/** Refuses a redirect that arrived as a status, not a throw. See docs/plugins.md §118. */
export function assertNoRedirect(
  provider: string,
  url: string,
  status: number,
  location?: string
): void {
  if (status < 300 || status >= 400) return;
  throw gitProviderReadError(
    provider,
    url,
    `${provider} readFileAtRef: ${url} returned HTTP ${status}` +
      (location ? ` (Location: ${location})` : "") +
      ' — redirects are refused, never followed: the plugin HTTP client sets redirect:"error" ' +
      "(apps/server/src/plugin-host/subprocess-entry.ts:285,295) so a 3xx cannot re-point a request " +
      "at an internal host after the egress pre-flight. Configure this binding's base URL as the " +
      "provider's FINAL URL (scheme, host and any path prefix exactly as the provider serves it)."
  );
}

/** Turns whatever the client threw into an actionable error. See docs/plugins.md §119. */
export function wrapProviderRequestError(
  provider: string,
  url: string,
  err: unknown
): GitProviderReadError {
  if (isGitProviderReadError(err)) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (isScopedHttpResponseTooLargeError(err)) {
    return gitProviderReadError(
      provider,
      url,
      `${provider} readFileAtRef: response from ${url} exceeded the ${err.limitBytes}-byte transport ` +
        `ceiling and was aborted mid-stream — never a silent truncation. This bound exists so a hostile ` +
        `or misconfigured ${provider} instance cannot exhaust this process's memory by serving an ` +
        `oversized blob (M21.2 review MAJOR 5).`,
      err
    );
  }

  if (
    typeof err === "object" &&
    err !== null &&
    (err as { egressBlocked?: unknown }).egressBlocked
  ) {
    return gitProviderReadError(
      provider,
      url,
      `${provider} readFileAtRef: egress to ${url} was refused by the plugin egress guard (${message}). ` +
        `A self-hosted ${provider} on a loopback/private address is not reachable from a tenant-configurable ` +
        `plugin by design (SSRF control); this is a deployment-topology problem, not something the adapter ` +
        `may relax.`,
      err
    );
  }

  return gitProviderReadError(
    provider,
    url,
    `${provider} readFileAtRef: request to ${url} failed at the transport (${message}). ` +
      `Note that redirects are refused rather than followed (redirect:"error", ` +
      `apps/server/src/plugin-host/subprocess-entry.ts:285,295), so a provider that answers this URL ` +
      `with a 3xx surfaces here as a transport failure — check that the configured base URL is the ` +
      `provider's final URL.`,
    err
  );
}

/**
 * The adapter-facing signature. Kept in this file (rather than inline in `GitProviderAdapter`) so
 * the type and the machinery that implements it stay together.
 */
export type ReadFileAtRefHook = (
  ctx: PluginContext,
  request: ReadFileAtRefRequest
) => Promise<ReadFileAtRefResult>;

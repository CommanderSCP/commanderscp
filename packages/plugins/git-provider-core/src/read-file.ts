import type { PluginContext } from "@scp/plugin-api";
import { isScopedHttpResponseTooLargeError } from "@scp/plugin-api";

/**
 * `readFileAtRef` — the provider-neutral half of the "read ONE file out of a repo at a ref"
 * capability (M21.2, ADR-0032 §4 / proposal §4.3(a)). Until this file existed **SCP could not read a
 * file body from a user repo at all**: the three git adapters' discovery walks call the contents API
 * but read only `entry.name`/`entry.type` from a DIRECTORY LISTING
 * (`packages/plugins/github/src/index.ts:741-753`, and the gitea/gitlab ports of the same walk) —
 * they never fetch or decode a blob. ADR-0032's inventory is built from what a component's own
 * manifests *declare* (`package.json`, `go.mod`, `pom.xml`, `requirements.txt`/`pyproject.toml`,
 * `Dockerfile`), so the missing primitive is exactly this one.
 *
 * WHAT THIS IS NOT (ADR-0032 §9, charter principle 1): `readFileAtRef` is a **`GitProviderAdapter`
 * hook, never a fifth `ExecutorPlugin` verb**. `createExecutorPluginFromAdapter` deliberately does
 * not surface it — the four-verb set (observe/trigger/status/abort) *is* the structural enforcement
 * of "coordination, not execution", and adding a verb would remove the enforcement mechanism rather
 * than extend it. This hook only READS; nothing here can write a branch, a commit or a PR.
 *
 * WHAT LIVES HERE vs IN AN ADAPTER: this file owns the request/result vocabulary, the decode bound,
 * the base64→UTF-8 decode with its refusals, the `repo`/`path`/`ref` URL-safety asserts, and the
 * two failure classifiers
 * (redirect, transport/egress). Each adapter owns only its own wire calls — which endpoint, which
 * field carries the commit sha, how a directory comes back — because those genuinely differ:
 * Gitea's contents API is GitHub-compatible, **GitLab's is not** (different endpoint, different
 * path encoding, and it returns the resolved commit id in the same response).
 */

export interface ReadFileAtRefRequest {
  /**
   * Repository to read from, as the provider's own `owner/repo` (GitLab: a full project path, e.g.
   * `group/subgroup/repo`). OPTIONAL: when omitted the adapter reads the repo its binding is already
   * configured for — the same repo every other hook on that adapter addresses. It is accepted at all
   * because ADR-0032's ingestion work-list is per COMPONENT and one binding legitimately covers
   * several components in one org (the monorepo case discovery already proposes), so pinning the
   * hook to exactly one repo per binding would force a binding per component.
   *
   * Validated by {@link assertSafeRepo} before it reaches a URL — it is caller-supplied and every
   * adapter splices it into a REST route.
   */
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
  /**
   * The commit `requestedRef` resolved to. This is the whole point of returning it: a branch name is
   * not an identity (the same lesson ADR-0032 §7 states for a mutable image tag — "we are on 1.2.3"
   * must be a statement about bytes, not about a label), so an inventory row records the commit it
   * was derived from, not the branch it was derived through.
   */
  commitSha: string;
  content: string;
  /** Decoded length in bytes (NOT `content.length`, which counts UTF-16 code units). */
  sizeBytes: number;
  /** Provider blob/object id when the response carried one — never fabricated when it did not. */
  blobSha?: string;
}

/**
 * The file (or the ref) is not there. This is a ROUTINE answer, not an error: "this component has no
 * `go.mod`" is the expected response for four of the five ecosystems on any given component, so it
 * must not throw.
 *
 * `missing` says WHICH lookup came back empty, and `"unknown"` is a real member rather than a
 * defaulted guess: GitHub/Gitea resolve the ref in a separate call, so a 404 there is attributable;
 * GitLab answers both in ONE call and distinguishes them only in a human-readable `message` string,
 * which is exactly the kind of thing that goes false the moment the wording changes (the
 * provenance-label lesson). So the GitLab adapter reports `"unknown"` and puts the provider's own
 * message in `detail` rather than inferring a label from it.
 */
export interface ReadFileAtRefNotFound {
  outcome: "not_found";
  missing: "path" | "ref" | "unknown";
  path: string;
  requestedRef: string;
  detail?: string;
}

/**
 * Why a file that EXISTS was deliberately not decoded. Distinct from `not_found` because the caller
 * must be able to tell "no manifest here" (skip, silently) from "there is a manifest and we refused
 * it" (report it — a component whose `package.json` is 40 MB is a fact worth surfacing, not one to
 * bury).
 */
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

/**
 * Default decode ceiling: 1 MiB. Sized against what this capability is FOR — a declared-dependency
 * manifest. The largest of the five ADR-0032 ecosystems' manifests in practice is a `pom.xml` with a
 * long `<dependencyManagement>` block, still tens of KB; `Dockerfile`/`go.mod`/`requirements.txt` are
 * smaller again. Lockfiles are the only routinely-megabyte files in this family and ADR-0032 §8 puts
 * them explicitly out of scope ("Manifest-only edits. No lockfile resolution."), so nothing this
 * capability serves needs a larger default.
 *
 * 1 MiB also happens to be where GitHub's contents API stops returning inline content at all, so the
 * default and the provider's own limit agree rather than fighting.
 */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;

/**
 * Absolute ceiling, applied to a CALLER-SUPPLIED `maxBytes` as well as the default. The bound has to
 * be structural, not advisory: `readFileAtRef` takes an arbitrary repo path, and a caller that asked
 * for `maxBytes: 2 ** 31` would otherwise turn one call into an out-of-memory. 4 MiB leaves headroom
 * for a genuinely large manifest without letting the hook become a general file-transfer primitive.
 */
export const HARD_MAX_FILE_BYTES = 4 * 1_048_576;

/**
 * The effective decode bound for one call: the caller's request clamped into
 * `(0, HARD_MAX_FILE_BYTES]`, defaulting to `DEFAULT_MAX_FILE_BYTES`. A zero/negative/NaN request is
 * treated as "not a bound the caller meant" and falls back to the default rather than refusing every
 * file — an accidental `maxBytes: 0` should not silently make the whole inventory empty.
 */
export function resolveMaxBytes(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_MAX_FILE_BYTES;
  }
  return Math.min(Math.floor(requested), HARD_MAX_FILE_BYTES);
}

// -------------------------------------------------------------------------------------------
// The TRANSPORT bound — M21.2 review MAJOR 5, closed. Everything above bounds what this file
// DECODES; everything below bounds what a `ScopedHttpClient` is allowed to BUFFER on the way to
// this file, via `ScopedHttpRequest.maxResponseBytes` (`@scp/plugin-api`). The two bounds serve
// different jobs and are deliberately set to different NUMBERS: the decode bound protects the
// dependency inventory from an oversized-but-legitimate manifest (routine, refused as
// `too_large`); the transport bound protects THIS PROCESS's memory from a hostile or
// misconfigured host that ignores every polite signal (`declaredSizeBytes`, `encoding: "none"`)
// and just keeps sending bytes — measured concretely as the gap: Gitea and GitLab serve arbitrarily
// large blobs inline as base64 with no analogue of GitHub's `encoding: "none"` cutoff, so
// `ctx.http.request()` used to buffer the WHOLE body (`apps/server/src/plugin-host/
// subprocess-entry.ts`'s pre-fix `await res.text()`) before `decodeBoundedBase64`'s gates ever ran.
// -------------------------------------------------------------------------------------------

/**
 * Headroom added on top of the base64-inflated decode bound when sizing the TRANSPORT ceiling for
 * a contents fetch. Base64 inflates by 4/3; on top of that, every provider wraps the blob in a
 * small JSON envelope (path, sha, encoding, links, …) — a few KB at most across all three
 * providers' shapes (`GithubContentFile`/`GiteaContentFile`/`GitlabRepositoryFile`). 64 KiB is
 * generous relative to that envelope and cheap relative to `maxBytes`, so it never becomes the
 * binding constraint — a legitimate response for a file within the decode bound is never rejected
 * at the transport layer for a reason `decodeBoundedBase64`'s own gates never get to explain.
 */
const RESPONSE_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

/**
 * The `ScopedHttpRequest.maxResponseBytes` an adapter's contents-fetch call should pass, derived
 * from the (already-clamped, via {@link resolveMaxBytes}) decode bound for this call. Deliberately
 * a FUNCTION of `maxBytes` rather than a second flat constant: the transport ceiling must always be
 * strictly above the decode bound it is protecting (otherwise a legitimately-sized file would be
 * refused at the transport layer with a message that never mentions `decodeBoundedBase64`'s own,
 * more specific gates), and coupling it structurally to `maxBytes` is what keeps that true if
 * `HARD_MAX_FILE_BYTES` or a caller's `request.maxBytes` ever changes.
 *
 * When THIS bound trips (rather than one of `decodeBoundedBase64`'s), it means the response was
 * far past what any legitimate manifest could be — a multi-gigabyte blob, not an oversized
 * `pom.xml` — and the read is refused before the bytes finish arriving, which is the entire point.
 */
export function resolveMaxResponseBytes(maxBytes: number): number {
  return Math.ceil((maxBytes * 4) / 3) + RESPONSE_ENVELOPE_HEADROOM_BYTES;
}

/**
 * Default `ScopedHttpRequest.maxResponseBytes` for every OTHER git-provider REST call this
 * package's adapters make (trigger/poll/status/abort/discover) — not just `readFileAtRef`'s
 * contents fetch. Same property, per CLAUDE.md's census discipline: every one of those calls also
 * went through `ctx.http.request()` unbounded before this fix, and a hostile or misconfigured host
 * answering a runs-list or a commits-list with gigabytes of JSON is the identical OOM shape, just
 * on a different endpoint. Sized generously for a legitimate list response (thousands of runs or
 * commits, each a few hundred bytes of JSON) while still bounding memory against a host that does
 * not behave.
 */
export const DEFAULT_API_RESPONSE_MAX_BYTES = 16 * 1_048_576;

/**
 * Decoded byte length of a base64 payload, computed from its length WITHOUT allocating the decode.
 * This is what lets the size refusal happen before the memory is spent.
 *
 * Whitespace is stripped first and that is load-bearing, not tidiness: **GitHub's contents API
 * returns base64 wrapped at 60 characters with embedded `\n`**, so a naive `b64.length` over-counts
 * a GitHub payload by ~1.7% and, worse, `Buffer.from` would silently ignore those bytes — the two
 * numbers would disagree. Padding (`=`) is subtracted because each `=` stands for a byte that is not
 * there.
 */
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

/**
 * base64 → bounded, verified UTF-8 text. Every adapter funnels its contents response through this
 * one function so all three refuse identically; only the extraction of `base64`/`encoding`/`size`
 * from the provider's own JSON differs.
 *
 * Five gates, in cost order — the cheapest refusal happens first, so an oversize file is refused
 * having allocated nothing:
 *
 *  1. **Encoding.** Anything that is not `base64` is refused. GitHub's `"none"` is special-cased to
 *     `too_large`, because that is what it documents: for a blob between 1 MB and 100 MB GitHub
 *     returns the metadata with an EMPTY `content` and `encoding: "none"`. Reporting that as
 *     "unsupported encoding" would be technically true and practically misleading.
 *  2. **Declared size.** Refuse on the provider's own `size` before touching the payload.
 *  3. **Computed size.** Refuse on `base64DecodedByteLength` — deliberately NOT trusting gate 2,
 *     which is a number the provider asserts about a payload it also sends. This gate is the one
 *     that actually holds when the two disagree.
 *  3b. **Completeness.** Gates 2 and 3 each compare ONE size against the bound; neither compares the
 *     two with each other. That comparison is the ONLY evidence in the system that a body is
 *     partial — a truncated line-oriented manifest is still a syntactically valid one — so a payload
 *     SHORTER than the provider's declared size is refused as `incomplete_body` rather than handed
 *     on as content. Short only; see the reason's own doc for why over-long is not refused.
 *  4. **Text.** A NUL byte anywhere, or bytes that do not survive a UTF-8 round trip, is refused as
 *     `not_text`. NUL-scanning is git's own binary heuristic; the round trip catches the rest,
 *     because `Buffer.toString("utf8")` NEVER fails — it substitutes U+FFFD — so without it a
 *     binary manifest would come back as plausible-looking mojibake and be *parsed*.
 *
 * There is no post-decode size check: `base64DecodedByteLength` is an exact upper bound on what
 * `Buffer.from(…, "base64")` can produce (it ignores characters it cannot decode), so gate 3 already
 * bounds the allocation.
 *
 * CLOSED — M21.2 review MAJOR 5. These gates bound what SCP DECODES; the TRANSPORT bound (a
 * SEPARATE, larger number — {@link resolveMaxResponseBytes}) now bounds what a `ScopedHttpClient`
 * is allowed to BUFFER on the way here, enforced DURING accumulation by every conforming
 * `ScopedHttpClient` (`apps/server/src/plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient`
 * in production; each package's own `node:http`-backed test client in tests — see
 * `ScopedHttpRequest.maxResponseBytes` in `@scp/plugin-api`).
 *
 * What was measured, per provider, before the fix:
 *
 *  - **GitHub was incidentally bounded**, by the provider and not by us: its contents API stops
 *    returning inline content above 1 MB and answers with `encoding: "none"` instead (gate 1's
 *    `too_large` case), so a GitHub blob response could not exceed ~1.4 MB whatever the file's
 *    size. Still given the same explicit transport bound as the other two now, for defense in
 *    depth — nothing in this package's contract should depend on a provider's incidental behavior.
 *  - **Gitea and GitLab were NOT bounded.** Both serve arbitrarily large blobs inline as base64, so
 *    any file a binding could reach buffered in full — `ctx.http.request()` did `await res.text()`
 *    over the WHOLE response with no cap, no content-length pre-check and no `Range` header, so the
 *    body sat fully in the plugin subprocess's memory — roughly 1.37x the file's size, base64 —
 *    *before* gate 1 ran. This was a real exposure, not a theoretical one.
 *
 * It is fixed HOST-SIDE (covers every plugin, not just these three) rather than per-adapter with a
 * pre-check: GitLab's metadata-only view of a blob is `HEAD .../repository/files/:path`
 * (`X-Gitlab-Size`), and `ScopedHttpRequest.method` is `GET|POST|PUT|PATCH|DELETE` — a plugin
 * cannot issue a HEAD at all; Gitea's is the parent DIRECTORY listing, a second round trip per read
 * whose own response grows with the sibling count, which would have reduced the exposure rather
 * than removed it and left GitLab untouched. Fixing one of three providers with a half-measure is
 * the shape of fix this repo's census discipline exists to prevent (CLAUDE.md) — the transport
 * bound closes the class for all three (and every other `ScopedHttpClient` caller that opts in) in
 * one place instead.
 */
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

  // Gate 3b — THE BYTES THAT ARRIVED ARE NOT THE FILE. Gates 2 and 3 each compare ONE size against
  // the bound; neither compares the two sizes with EACH OTHER, and that comparison is the only
  // evidence anywhere in the system that a body is partial. See `incomplete_body`.
  //
  // SHORT ONLY, deliberately. A payload that decodes to MORE than the provider declared is not the
  // truncation hazard and is not worth failing a read over: `size` is provider metadata and a
  // provider that under-reports (a stale index entry, a size computed pre-filter) would otherwise
  // make every manifest in that repo unreadable. The direction that deletes an inventory is the
  // short one, and it is the only one refused.
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

/**
 * Rejects a repo path that must never reach a URL. This is not defensive decoration: every adapter
 * below interpolates `path` into a REST route, so a `..` segment does not merely name a file outside
 * the repo — it walks the API route itself (`/repos/o/r/contents/../../user` is a *different
 * endpoint*, reached with the binding's credentials). Refused rather than normalized, because
 * silently rewriting a caller's path would make the request differ from what the caller can see.
 *
 * A backslash is refused too: it is a legal character in a POSIX path but is the path separator on
 * the other side of several providers' storage layers, so allowing it means the same string names
 * two things.
 */
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

/**
 * Characters a git ref may never contain, as `git check-ref-format` defines them: ASCII control
 * characters and DEL, space, and the seven metacharacters git reserves for its own revision syntax
 * (`~ ^ : ? * [` and `\`). Three of those are also the ones that would change a REST request rather
 * than name a ref — `?` starts a query string, `[`/`\` are provider-storage hazards — so the git
 * rule and the URL rule want the same refusal here and there is no need for two lists.
 */
// `no-control-regex` exists to catch a control character that got into a pattern by ACCIDENT. Here
// the control range IS the rule being expressed, so the rule is disabled for this one line rather
// than the range being split into a separate charCode loop — which would leave git's single list
// expressed in two places.
// eslint-disable-next-line no-control-regex
const REF_FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f ~^:?*[\\]/;

/**
 * Rejects a `ref` that must never reach a URL, and REFUSES rather than sanitises.
 *
 * Why per-segment encoding is not enough — measured, not assumed: `encodeURIComponent("..")` is
 * `".."`, so {@link encodePathSegments} passes a `..` segment through untouched. A ref of
 * `../../../../user` therefore turned `GET /repos/{o}/{r}/commits/../../../../user` into
 * `GET https://api.github.com/user` — a DIFFERENT endpoint, reached with the binding's installation
 * credentials. Encoding protects the *contents* of a segment; only a validator can refuse a segment
 * that is structural.
 *
 * Refused rather than rewritten, for the same reason {@link assertSafeRepoPath} refuses: silently
 * turning the caller's `../../user` into something else makes the request differ from what the
 * caller asked for and can see, which is its own hazard.
 *
 * The rule set is git's own (`git check-ref-format`), not an invented allowlist, so everything a
 * provider can legitimately be asked for still works: a 40-hex commit sha, `main`, a `feature/x`
 * branch, a `v1.2.3` tag, and a fully-qualified `refs/heads/x`.
 */
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

/**
 * The characters a repo/owner/group/project segment may contain across all three providers. GitHub
 * owner and repo names, Gitea's, and GitLab group/project paths are each drawn from exactly
 * `[A-Za-z0-9._-]`, so this is the providers' own rule rather than a guess — and it is what makes
 * the subsequent {@link encodePathSegments} call provably an identity function (every character
 * here is URL-unreserved), which is why encoding alone was never going to be the control.
 */
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Rejects a caller-supplied `repo` that must never reach a URL. Third of the three asserts, and the
 * one that was missing longest: `request.repo` is spliced into the route by every adapter, and two
 * of the three spliced it **raw** — neither validated nor encoded. Both halves of that were
 * exploitable, and each needs its own refusal:
 *
 *  - a `..` segment re-targets the route exactly as it does for `path`/`ref` — `acme/widgets/../../..`
 *    turned `GET /repos/{repo}/commits/main` into `GET https://api.github.com/commits/main`, and the
 *    gitea adapter into `.../repos/acme/widgets/../../../commits?sha=main`;
 *  - a `?` TERMINATES the route early — `acme/widgets?x=` made
 *    `/repos/acme/widgets?x=/commits/main` a request for the repo itself with the rest of the
 *    intended route folded into a query parameter.
 *
 * The gitlab adapter was the one that already encoded (its `:id` is a single whole-encoded route
 * parameter, so `%2F`/`%3F` made it inert) — that is why this is a shared assert rather than a
 * per-adapter patch: the class was understood for one provider and missed for two, which is the
 * signature of a fix applied to an instance instead of to the property (CLAUDE.md, census).
 *
 * `exactSegments` is the provider's own shape, not a style preference: GitHub and Gitea address a
 * repo as exactly `owner/repo`, while a GitLab project path legitimately nests
 * (`group/subgroup/repo`), so only the first two can assert a count.
 */
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

/**
 * Percent-encodes a path/ref PER SEGMENT, keeping `/` as a literal separator. This is the encoding
 * GitHub's and Gitea's contents routes want (the path is part of the route), and it is what makes a
 * ref like `release/1.x` or a path like `svc a/go.mod` survive.
 *
 * NOTE the divergence, which is the reason this is a named export rather than an inline expression:
 * **GitLab is the opposite** — its files endpoint wants the file path encoded WHOLE, slashes turned
 * into `%2F`, because there the path is a single route parameter. The gitlab adapter therefore does
 * NOT use this function, and says so at its call site.
 */
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

/**
 * Refuses a 3xx that arrived as a STATUS rather than as a thrown error, with a message that says
 * what actually happened.
 *
 * Why this exists at all, measured: the plugin host's HTTP client hard-disables redirect following —
 * `redirect: "error"` on both branches of `scopedFetchHttpClient`
 * (`apps/server/src/plugin-host/subprocess-entry.ts:285,295`), because a 3xx could re-point a request
 * at an internal host AFTER the pre-flight egress check has already passed. Under THAT client a
 * redirect never reaches a plugin as a status; `fetch` rejects and the plugin sees a transport
 * failure (handled by {@link wrapProviderRequestError}).
 *
 * But `ScopedHttpClient` is an interface, and the client a plugin actually gets is whatever the host
 * injected. The suites in this repo inject a `node:http`/`node:https`-backed client so `nock` can
 * intercept — and Node's core `http` does not follow redirects *or* error on them, it hands the 3xx
 * straight back as a status. So a 3xx IS reachable as a status, and without this check it would fall
 * through the adapter's `status < 200 || status >= 300` arm as an anonymous "HTTP 302", which tells
 * an operator nothing about why their `https://gitea.example.com` (which redirects to
 * `https://gitea.example.com/`) never worked. Making the failure legible is the requirement; both
 * shapes of the same failure now name the redirect.
 */
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

/**
 * Turns whatever `ctx.http.request` threw into an error an operator can act on, without changing any
 * policy. Four cases, all deliberately non-swallowing:
 *
 *  - **Already ours** (`assertNoRedirect`'s product) — passed through untouched, so the redirect
 *    explanation is not buried under a generic transport message.
 *  - **Response too large** (`ScopedHttpResponseTooLargeError`, `@scp/plugin-api` —
 *    `ScopedHttpRequest.maxResponseBytes` was exceeded and the read was aborted mid-stream, M21.2
 *    review MAJOR 5) — re-stated naming the limit and that this is a REFUSAL, not a truncation: the
 *    caller never receives partial bytes to mistake for the whole file.
 *  - **Egress-guard refusal** (`egressBlocked: true`, `apps/server/src/plugin-host/egress-guard.ts:83`)
 *    — re-stated with the self-hosted case named, because that is the failure a self-hosted Gitea or
 *    GitLab actually hits: the guard blocks loopback/private addresses for every TENANT-configurable
 *    plugin, and `github`/`gitea`/`gitlab` are all deliberately absent from `OPERATOR_PLANE_MODULES`
 *    (subprocess-entry.ts:210-215). **Nothing here weakens that**, and it must not: the guard is the
 *    SSRF control. The only honest thing this layer can do is stop the operator from reading
 *    "fetch failed" and guessing. The underlying error is preserved as `cause`.
 *  - **Anything else** — a transport failure, which under the production client is ALSO what a
 *    refused redirect looks like (undici rejects rather than returning the 3xx), so the message names
 *    that possibility instead of leaving it invisible.
 */
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

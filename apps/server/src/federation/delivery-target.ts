/**
 * M13.2a — the DeliveryTarget substrate (docs/proposals/airgap-cds-validate-promote.md §13.2).
 *
 * WHERE a signed channel artifact gets dropped for — or picked up from — one peer's CDS crossing:
 * the exact hole ADR-0019's Consequences deferred ("drop-directory vs. diode transfer varies per
 * CDS product; the relay's contract ends at 'signed tarball out / signed tarball in'"), and
 * nothing more. Everything past the drop (diode transfer, content inspection, the CDS product's
 * review queue) is the org's CDS — out of scope (charter principle 1).
 *
 * ## Resolution (the M15.6 `buildRegionalExecutorView` discipline — validated view, per-gap
 * `problems`, never a silent misdeploy)
 *
 * `resolveDeliveryTarget(peer, config)` produces the EFFECTIVE target for one peer:
 *
 *   1. The peer's own `deliveryTarget` (per-direction) wins when configured.
 *   2. NO per-peer value for a direction → the instance env (`SCP_RELAY_OUT_DIR` /
 *      `SCP_RELAY_IN_DIR`, PR #112's `RelayConfig`) — TODAY'S behavior, byte-identical, so
 *      existing setups need no migration.
 *   3. BOTH absent → that direction resolves to a named, per-gap `problem` — FAIL-CLOSED at use
 *      (`requireOutboundDir`/`requireInboundDir` refuse with the problem text); never a silent
 *      default path.
 *
 * A stored per-peer directory is RE-validated here (absolute, traversal-free — the same predicate
 * `DeliveryDirSchema` enforces at config time): a hostile value that somehow reached the DB is a
 * fail-closed problem for its direction, and deliberately does NOT fall back to the env — falling
 * back would silently mask the misconfiguration.
 *
 * ## Operator-root bounding (`SCP_DELIVERY_ROOTS` — the #108→#110 pattern, symmetric with ADR-0019 §4)
 *
 * On a MULTI-TENANT instance, an org admin with `federation:write` supplies the per-peer dirs. An
 * absolute + traversal-free path is NOT enough: any server-writable absolute path (another org's
 * `SCP_RELAY_IN_DIR`, any server-user-writable location) would otherwise be a legal drop target,
 * and `dropDeliveryFile` does `mkdir -p` + overwriting `writeFile` there as the server user — a
 * cross-tenant / arbitrary-path write. So a per-peer directory is honored ONLY when it sits at or
 * under one of the OPERATOR-declared roots in `SCP_DELIVERY_ROOTS` — the same shape as
 * `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` (#110): a data-supplied filesystem endpoint gated by an
 * operator allowlist, enforced in BOTH places — refused at pair time (never stored) and re-checked
 * fail-closed at resolution (a stored out-of-root dir is a named per-gap problem, never a silent
 * env fallback, never used).
 *
 * DEFAULT — the honest multi-tenant default: `SCP_DELIVERY_ROOTS` UNSET + any per-peer dir set/used
 * ⇒ FAIL-CLOSED (refuse). The operator must declare the roots before any per-peer dir is honored.
 * The ENV-FALLBACK path (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — operator-owned by definition)
 * stays EXEMPT: no per-peer dir, no roots requirement, so single-org deploys keep working with zero
 * new config.
 *
 * ## The read-side surface (for the §13.1a inbox loop, stacked next)
 *
 * `listInbox(peer)` returns file NAMES within the resolved inbound directory — names only, never
 * paths: each name is round-tripped through the PR #112 `resolveUnderDir` traversal guard before
 * it is returned, so the guard SURVIVES automation (inbox contents are untrusted data — file
 * names are data, not commands). Consumers hand a name back to the existing import paths, which
 * re-run `resolveUnderDir` themselves.
 *
 * ## Providers (13.2b — `s3-compatible` added)
 *
 * `filesystem` (default) and `s3-compatible` (proposal §13.2, owner decision D3: AWS SDK v3) both
 * ride the SAME put/list/get seams (`dropDeliveryFile`/`listInbox`/`getDeliveryFile`), PROVIDER-
 * DISPATCHED on the resolved target's `provider`: the filesystem path is byte-identical to M13.2a,
 * the s3 path put/list/gets via `delivery-s3.ts`. The s3 provider is OPERATOR-ALLOWLISTED exactly
 * as directories are — the `SCP_DELIVERY_S3_ENDPOINTS` endpoint/bucket allowlist is the ADR-0019 §4
 * symmetry of `SCP_DELIVERY_ROOTS`, enforced at pair-time AND fail-closed at resolution (a tenant
 * must never steer delivery to an arbitrary S3 endpoint). Its credentials live in the vault under
 * `delivery/<peer>/<direction>` (ADR-0019 §3), resolved at use and passed to the s3 seams — never in
 * config, never logged.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeliveryTarget, S3DeliveryTarget } from "@scp/schemas";
import { badRequest } from "../errors.js";
import { resolveUnderDir, relayConfigFromEnv } from "./retrans-relay.js";
import { s3Get, s3List, s3Put, type S3DeliveryCredentials } from "./delivery-s3.js";

/** The slice of a `FederationPeerRow` resolution needs (structural, so tests and the routes can
 *  pass the full row or a stub). `null` peer = "no peer in play" (an env-only resolution — e.g.
 *  a relay build invoked without naming a destination peer, exactly today's shape). */
export interface DeliveryTargetPeerRef {
  name: string;
  deliveryTarget?: DeliveryTarget | null;
}

/** The instance-level fallback dirs — `RelayConfig`'s `outDir`/`inDir` slice (PR #112 env). */
export interface DeliveryEnvDirs {
  outDir?: string;
  inDir?: string;
}

/**
 * `SCP_DELIVERY_ROOTS` — comma/colon-separated ABSOLUTE roots a per-peer delivery directory must
 * sit at or under to be honored (the #110 `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` pattern for a
 * filesystem endpoint). Entries are trimmed, non-absolute ones dropped, and each normalized with
 * `path.resolve` so a root written as `/data/roots/../escape` collapses to its real location.
 * UNSET (or all-empty) ⇒ `[]` ⇒ every per-peer dir fails closed (see the module doc's DEFAULT).
 * Accepts the raw env string or an already-split array (tests pass an array directly).
 */
export function parseDeliveryRoots(raw: string | readonly string[] | undefined): string[] {
  const entries = typeof raw === "string" ? raw.split(/[,:]/) : (raw ?? []);
  return entries
    .map((r) => r.trim())
    .filter((r) => r.startsWith("/"))
    .map((r) => path.resolve(r));
}

/** The live operator-declared roots (`SCP_DELIVERY_ROOTS`). */
export function deliveryRootsFromEnv(): string[] {
  return parseDeliveryRoots(process.env.SCP_DELIVERY_ROOTS);
}

/**
 * Is `dir` at or under one of `roots`? The check is on RESOLVED path SEGMENTS, never a raw string
 * prefix — so a sibling like `/root-evil` never matches the root `/root` (string-prefix would),
 * and `/roots/../escape` is normalized before comparison. `roots` are already resolved by
 * {@link parseDeliveryRoots}; `dir` is resolved here. Mirrors `resolveUnderDir`'s boundary test.
 */
export function isUnderDeliveryRoot(dir: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(dir);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

// -------------------------------------------------------------------------------------------------
// S3 endpoint/bucket allowlist (`SCP_DELIVERY_S3_ENDPOINTS`) — the ADR-0019 §4 symmetry of
// SCP_DELIVERY_ROOTS, but ENDPOINT+BUCKET shaped, NOT path shaped (isUnderDeliveryRoot is a filesystem
// prefix test and MUST NOT be reused here). An s3 `endpoint`/`bucket` is a data-supplied EGRESS
// target set by an org admin; without an operator allowlist a tenant could steer the unattended
// boundary drop to an arbitrary S3 endpoint (data-supplied egress). So — exactly as directories are
// bounded — an s3 target is honored ONLY when its endpoint (and bucket, when the entry pins one) is
// operator-allowlisted, enforced at pair-time (never stored) AND fail-closed at resolution.
// -------------------------------------------------------------------------------------------------

/** One parsed allowlist entry: an endpoint ORIGIN (scheme+host+port, normalized) and an OPTIONAL
 *  bucket. `bucket === null` ⇒ the entry allows ANY bucket at that endpoint; a bucket pins the entry
 *  to exactly that endpoint+bucket pair. */
export interface DeliveryS3AllowEntry {
  origin: string;
  bucket: string | null;
}

/** Normalize an endpoint string to its comparable ORIGIN (`scheme://host[:port]`, lowercased) — the
 *  segment-safe equality anchor, so a look-alike host never matches by string prefix. Returns null
 *  for anything not an absolute http(s) URL. */
export function normalizeS3Origin(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin.toLowerCase();
}

/**
 * Parse `SCP_DELIVERY_S3_ENDPOINTS` — a COMMA/newline-separated list of allowed `endpoint` or
 * `endpoint+bucket` entries (e.g. `https://minio.a:9000, https://minio.b:9000+bundles`). Unlike
 * {@link parseDeliveryRoots}, entries are NOT colon-split: an S3 endpoint URL legitimately contains
 * colons (`https://host:9000`), so a colon can never be an entry separator here; the endpoint↔bucket
 * separator is `+` (per the proposal's `endpoint[+bucket]` notation). Each endpoint is normalized to
 * its origin; unparseable entries are dropped. UNSET/all-empty ⇒ `[]` ⇒ every s3 target fails closed.
 * Accepts the raw env string or an already-split array (tests pass an array directly).
 */
export function parseDeliveryS3Endpoints(
  raw: string | readonly string[] | undefined
): DeliveryS3AllowEntry[] {
  const entries = typeof raw === "string" ? raw.split(/[,\n]/) : (raw ?? []);
  const parsed: DeliveryS3AllowEntry[] = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const plusAt = entry.indexOf("+");
    const endpointPart = plusAt === -1 ? entry : entry.slice(0, plusAt);
    const bucketPart = plusAt === -1 ? "" : entry.slice(plusAt + 1).trim();
    const origin = normalizeS3Origin(endpointPart);
    if (origin === null) continue;
    parsed.push({ origin, bucket: bucketPart === "" ? null : bucketPart });
  }
  return parsed;
}

/** The live operator-declared s3 endpoint allowlist (`SCP_DELIVERY_S3_ENDPOINTS`). */
export function deliveryS3EndpointsFromEnv(): DeliveryS3AllowEntry[] {
  return parseDeliveryS3Endpoints(process.env.SCP_DELIVERY_S3_ENDPOINTS);
}

/**
 * Is `endpoint`+`bucket` allowed by `allow`? Match requires the normalized ORIGINS to be EQUAL (never
 * a string-prefix compare — so `https://minio.evil:9000` never matches an allowlisted
 * `https://minio.ev:9000`, and a path suffix on the configured endpoint can't sneak past) AND the
 * entry's bucket to be either unpinned (any bucket) or exactly `bucket`. An unparseable `endpoint`,
 * or an empty allowlist, is never allowed (fail-closed).
 */
export function isDeliveryS3EndpointAllowed(
  endpoint: string,
  bucket: string,
  allow: readonly DeliveryS3AllowEntry[]
): boolean {
  const origin = normalizeS3Origin(endpoint);
  if (origin === null) return false;
  return allow.some((e) => e.origin === origin && (e.bucket === null || e.bucket === bucket));
}

/** A resolved s3-compatible location for one direction (13.2b) — the endpoint (normalized origin),
 *  bucket, and normalized key prefix (`''` or ends with `/`). Populated only for the `s3-compatible`
 *  provider; `null` on a filesystem direction. */
export interface ResolvedS3Location {
  endpoint: string;
  bucket: string;
  /** `''` (bucket root) or a prefix guaranteed to end in `/`, so `prefix + basename` is a valid key. */
  prefix: string;
}

/** One direction of the resolved view. `dir` is the resolved FILESYSTEM directory (or `null`); the
 *  s3 location, when the provider is `s3-compatible`, lives on the parent's `outboundS3`/`inboundS3`
 *  — this shape is DELIBERATELY unchanged from M13.2a (the filesystem suite asserts it exactly).
 *  A resolved direction has `problem === null`; an unresolved one has `dir === null` + a `problem`
 *  (the text the `require*` helpers refuse with). */
export interface ResolvedDeliveryDirection {
  dir: string | null;
  /** Where the effective location came from: the peer's own config or the instance env. */
  source: "peer" | "env" | null;
  problem: string | null;
}

/** The validated per-peer view (the M15.6 shape: effective config + `valid` + per-gap `problems`). */
export interface ResolvedDeliveryTarget {
  /** 13.2b — widened from the literal `'filesystem'`: the effective provider (`'filesystem'` for a
   *  filesystem target OR the env fallback; `'s3-compatible'` for an s3 target). Every consumer of a
   *  resolved location DISPATCHES on this (the census — filesystem readers keyed on `dir` still work,
   *  s3 readers key on `outboundS3`/`inboundS3`). */
  provider: "filesystem" | "s3-compatible";
  /** The peer in play, or `null` for an env-only resolution. */
  peerName: string | null;
  outbound: ResolvedDeliveryDirection;
  inbound: ResolvedDeliveryDirection;
  /** 13.2b — the resolved OUTBOUND s3 location when `provider === 's3-compatible'` AND the outbound
   *  direction resolved (allowlist passed); `null` for a filesystem target or an unresolved s3
   *  direction (whose gap is on `outbound.problem`). */
  outboundS3: ResolvedS3Location | null;
  /** 13.2b — the resolved INBOUND s3 location; same rules as {@link outboundS3}. */
  inboundS3: ResolvedS3Location | null;
  /** True iff BOTH directions resolved. Consumers needing only one direction gate on that
   *  direction's own `problem` (via the `require*` helpers), not on `valid`. */
  valid: boolean;
  /** Every per-gap problem (both directions), in outbound-then-inbound order. */
  problems: string[];
}

/** The SAME predicate `DeliveryDirSchema` (packages/schemas) enforces at config time — re-checked
 *  here fail-closed so a value that bypassed the schema (direct DB write, older row) still never
 *  steers a write/list outside itself. POSIX-absolute, no `.`/`..` segments. */
function isSafeAbsoluteDir(dir: string): boolean {
  return (
    dir.startsWith("/") && !dir.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/** Normalize an s3 key prefix to `''` (bucket root) or a value ending in `/`, so `prefix + basename`
 *  is a valid, well-scoped key. Leading `/` is stripped (the schema already refuses it; belt-and-
 *  braces for a value that bypassed the schema). */
function normalizeS3Prefix(prefix: string | undefined): string {
  if (!prefix) return "";
  const trimmed = prefix.replace(/^\/+/, "");
  if (trimmed === "") return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** FILESYSTEM direction resolution (unchanged from M13.2a — byte-identical). `peerDir` is the peer's
 *  own configured dir for this direction (or `undefined` to fall through to the env). */
function resolveDirection(
  direction: "outbound" | "inbound",
  peerName: string | null,
  peerDir: string | undefined,
  envDir: string | undefined,
  roots: readonly string[]
): ResolvedDeliveryDirection {
  const field = direction === "outbound" ? "outDir" : "inDir";
  const envVar = direction === "outbound" ? "SCP_RELAY_OUT_DIR" : "SCP_RELAY_IN_DIR";
  const use = direction === "outbound" ? "outbound drops have" : "inbound intake has";

  if (peerDir !== undefined) {
    // A CONFIGURED per-peer value is authoritative for its direction. A hostile value is a
    // fail-closed problem — deliberately NOT an env fallback, which would mask the misconfig.
    if (!isSafeAbsoluteDir(peerDir)) {
      return {
        dir: null,
        source: null,
        problem:
          `peer '${peerName}' deliveryTarget ${field} '${peerDir}' is not an absolute, ` +
          `traversal-free server path — refusing to use it (fail-closed; fix the peer's ` +
          `deliveryTarget via \`scp federation pair\`)`
      };
    }
    // #110 pattern (SCP_ARTIFACT_OCI_REGISTRY_HOSTS): a data-supplied endpoint is honored ONLY
    // inside an operator allowlist. UNSET roots ⇒ no per-peer dir is honored (the honest
    // multi-tenant default); a stored out-of-root dir ⇒ a named per-gap problem, NEVER an env
    // fallback (which would mask a cross-tenant / arbitrary-path write).
    if (roots.length === 0) {
      return {
        dir: null,
        source: null,
        problem:
          `peer '${peerName}' configures a deliveryTarget ${field} '${peerDir}' but no operator ` +
          `delivery roots are declared (SCP_DELIVERY_ROOTS is unset) — refusing to honor any ` +
          `per-peer delivery directory (fail-closed; the operator must set SCP_DELIVERY_ROOTS to ` +
          `the absolute root(s) per-peer dirs may live under before any per-peer dir is used)`
      };
    }
    if (!isUnderDeliveryRoot(peerDir, roots)) {
      return {
        dir: null,
        source: null,
        problem:
          `peer '${peerName}' deliveryTarget ${field} '${peerDir}' is outside every ` +
          `operator-declared delivery root (SCP_DELIVERY_ROOTS) — refusing to use it (fail-closed; ` +
          `the directory must be at or under one of the configured roots, or clear the per-peer ` +
          `deliveryTarget to fall back to ${envVar})`
      };
    }
    return { dir: peerDir, source: "peer", problem: null };
  }
  if (envDir) {
    return { dir: envDir, source: "env", problem: null };
  }
  return {
    dir: null,
    source: null,
    problem: peerName
      ? `peer '${peerName}' configures no deliveryTarget ${field} and the instance env ` +
        `${envVar} is unset — ${use} nowhere to land (fail-closed; configure the peer's ` +
        `deliveryTarget or set ${envVar})`
      : `no delivery peer in play and the instance env ${envVar} is unset — ${use} nowhere ` +
        `to land (fail-closed; set ${envVar} or name a peer with a configured deliveryTarget)`
  };
}

/** S3 direction resolution (13.2b). The endpoint/bucket is the SAME for both directions (the target
 *  carries one `endpoint`+`bucket`); only the per-direction prefix differs. The allowlist gap is
 *  therefore shared: an out-of-allowlist endpoint/bucket makes BOTH directions a fail-closed problem.
 *  There is NO env fallback for an s3 target — the whole target is s3 (the env dirs are filesystem).
 *  Returns the (dir-shaped) direction PLUS the resolved `s3` location (`null` on a gap) — the
 *  direction shape stays byte-identical to filesystem so consumers keyed on it are unchanged. */
function resolveS3Direction(
  direction: "outbound" | "inbound",
  peerName: string | null,
  target: S3DeliveryTarget,
  allow: readonly DeliveryS3AllowEntry[]
): { direction: ResolvedDeliveryDirection; s3: ResolvedS3Location | null } {
  // ADR-0019 §4 symmetry: a data-supplied endpoint/bucket is honored ONLY inside the operator
  // allowlist. UNSET allowlist ⇒ nothing honored (fail-closed default); out-of-allowlist ⇒ a named
  // per-gap problem, NEVER used — a tenant must never steer delivery to an arbitrary S3 endpoint.
  if (allow.length === 0) {
    return {
      direction: {
        dir: null,
        source: null,
        problem:
          `peer '${peerName}' configures an s3-compatible deliveryTarget (endpoint ` +
          `'${target.endpoint}', bucket '${target.bucket}') but no operator s3 delivery endpoints are ` +
          `declared (SCP_DELIVERY_S3_ENDPOINTS is unset) — refusing to honor any s3 delivery target ` +
          `(fail-closed; the operator must allowlist the endpoint[+bucket] before it is used)`
      },
      s3: null
    };
  }
  if (!isDeliveryS3EndpointAllowed(target.endpoint, target.bucket, allow)) {
    return {
      direction: {
        dir: null,
        source: null,
        problem:
          `peer '${peerName}' deliveryTarget endpoint '${target.endpoint}' / bucket ` +
          `'${target.bucket}' is not in the operator s3 delivery allowlist (SCP_DELIVERY_S3_ENDPOINTS) ` +
          `— refusing to use it (fail-closed; allowlist the endpoint[+bucket], or clear the per-peer ` +
          `deliveryTarget)`
      },
      s3: null
    };
  }
  const prefix = normalizeS3Prefix(direction === "outbound" ? target.outPrefix : target.inPrefix);
  return {
    direction: { dir: null, source: "peer", problem: null },
    s3: {
      endpoint: normalizeS3Origin(target.endpoint) ?? target.endpoint,
      bucket: target.bucket,
      prefix
    }
  };
}

/**
 * The effective DeliveryTarget for `peer` (or the env-only target when `peer` is null), with
 * per-gap `problems` — never throws; the `require*` helpers turn a gap into a fail-closed refusal at
 * the point of use. Dispatches on the peer target's provider: an `s3-compatible` target resolves via
 * the endpoint/bucket allowlist (`s3Allow`), everything else (a filesystem target or the env
 * fallback) via the directory logic. `config` defaults to the live env (`relayConfigFromEnv()`).
 */
export function resolveDeliveryTarget(
  peer: DeliveryTargetPeerRef | null,
  config?: DeliveryEnvDirs,
  roots?: readonly string[],
  s3Allow?: readonly DeliveryS3AllowEntry[]
): ResolvedDeliveryTarget {
  const peerName = peer?.name ?? null;
  const target = peer?.deliveryTarget ?? null;

  if (target && target.provider === "s3-compatible") {
    const allow = s3Allow ?? deliveryS3EndpointsFromEnv();
    const outbound = resolveS3Direction("outbound", peerName, target, allow);
    const inbound = resolveS3Direction("inbound", peerName, target, allow);
    const problems = [outbound.direction.problem, inbound.direction.problem].filter(
      (p): p is string => p !== null
    );
    return {
      provider: "s3-compatible",
      peerName,
      outbound: outbound.direction,
      inbound: inbound.direction,
      outboundS3: outbound.s3,
      inboundS3: inbound.s3,
      valid: problems.length === 0,
      problems
    };
  }

  const env = config ?? relayConfigFromEnv();
  // Roots are a SEPARATE operator concern from the env-dir fallback: default them from the env
  // independently so callers that pass a `RelayConfig` as `config` (the relay route) still get the
  // operator's declared roots rather than an empty list.
  const activeRoots = roots ?? deliveryRootsFromEnv();
  const outbound = resolveDirection("outbound", peerName, target?.outDir, env.outDir, activeRoots);
  const inbound = resolveDirection("inbound", peerName, target?.inDir, env.inDir, activeRoots);
  const problems = [outbound.problem, inbound.problem].filter((p): p is string => p !== null);
  return {
    provider: "filesystem",
    peerName,
    outbound,
    inbound,
    outboundS3: null,
    inboundS3: null,
    valid: problems.length === 0,
    problems
  };
}

/** FILESYSTEM-only accessor: the resolved OUTBOUND drop directory, or a fail-closed 400 carrying the
 *  named per-gap problem. Refuses an `s3-compatible` target with a clear provider-mismatch problem —
 *  a caller that needs a local directory path (e.g. the relay build, which writes a tarball to disk)
 *  cannot use an s3 target; that consumer must be s3-aware or the peer must use a filesystem target. */
export function requireOutboundDir(resolved: ResolvedDeliveryTarget): string {
  if (resolved.provider === "s3-compatible") {
    throw badRequest(
      `peer '${resolved.peerName}' is configured for s3-compatible delivery, but this operation ` +
        `requires a filesystem outbound directory (SCP_RELAY_OUT_DIR or a filesystem deliveryTarget)`
    );
  }
  if (resolved.outbound.dir === null) {
    throw badRequest(resolved.outbound.problem ?? "delivery target outbound directory unresolved");
  }
  return resolved.outbound.dir;
}

/** FILESYSTEM-only accessor: the resolved INBOUND intake directory, or a fail-closed 400. Refuses an
 *  `s3-compatible` target for the same reason as {@link requireOutboundDir}. */
export function requireInboundDir(resolved: ResolvedDeliveryTarget): string {
  if (resolved.provider === "s3-compatible") {
    throw badRequest(
      `peer '${resolved.peerName}' is configured for s3-compatible delivery, but this operation ` +
        `requires a filesystem inbound directory (SCP_RELAY_IN_DIR or a filesystem deliveryTarget)`
    );
  }
  if (resolved.inbound.dir === null) {
    throw badRequest(resolved.inbound.problem ?? "delivery target inbound directory unresolved");
  }
  return resolved.inbound.dir;
}

/** The resolved OUTBOUND s3 location, or a fail-closed 400 carrying the named per-gap problem. */
function requireOutboundS3(resolved: ResolvedDeliveryTarget): ResolvedS3Location {
  if (resolved.outboundS3 === null) {
    throw badRequest(resolved.outbound.problem ?? "delivery target outbound s3 location unresolved");
  }
  return resolved.outboundS3;
}

/** The resolved INBOUND s3 location, or a fail-closed 400 carrying the named per-gap problem. */
function requireInboundS3(resolved: ResolvedDeliveryTarget): ResolvedS3Location {
  if (resolved.inboundS3 === null) {
    throw badRequest(resolved.inbound.problem ?? "delivery target inbound s3 location unresolved");
  }
  return resolved.inboundS3;
}

/**
 * PROVIDER-AGNOSTIC outbound assertion (for route pre-checks): a delivery with NO resolvable outbound
 * location refuses fail-closed with its named per-gap problem, BEFORE any export work is done —
 * whether the target is filesystem (no dir) or s3 (no allowlisted endpoint). Never returns a path;
 * use `dropDeliveryFile` to actually write.
 */
export function assertOutboundDeliverable(resolved: ResolvedDeliveryTarget): void {
  if (resolved.provider === "s3-compatible") {
    requireOutboundS3(resolved);
    return;
  }
  requireOutboundDir(resolved);
}

/** Guard a caller-supplied `fileName` down to a single safe basename before it becomes an s3 key —
 *  the s3 analogue of `resolveUnderDir`'s traversal guard (which is path-shaped and can't apply to a
 *  key). A name with a `/` or a `.`/`..` segment is refused fail-closed, so a hostile name can never
 *  escape the configured prefix. Returns the full object key (`prefix + basename`). */
function deliveryObjectKey(prefix: string, fileName: string): string {
  if (fileName === "" || fileName === "." || fileName === ".." || fileName.includes("/")) {
    throw badRequest(
      `delivery file name '${fileName}' is not a safe basename — refusing to use it as an s3 key ` +
        `(fail-closed; names must not contain '/' or be a traversal segment)`
    );
  }
  return prefix + fileName;
}

/** WRITE SEAM — PROVIDER-DISPATCHED: drop `contents` as `fileName` into the peer's resolved outbound
 *  location. `filesystem` = exactly the PR #112 write (mkdir -p + write, byte-identical), `fileName`
 *  riding the `resolveUnderDir` traversal guard. `s3-compatible` = a managed multipart put via
 *  `delivery-s3.ts`, `fileName` riding {@link deliveryObjectKey}; `s3Credentials` (vault-resolved by
 *  the caller) is REQUIRED for the s3 path — its absence is a fail-closed 400. Returns the absolute
 *  filesystem path OR the `s3://bucket/key` URI written. */
export async function dropDeliveryFile(
  resolved: ResolvedDeliveryTarget,
  fileName: string,
  contents: string | Buffer,
  s3Credentials?: S3DeliveryCredentials
): Promise<string> {
  if (resolved.provider === "s3-compatible") {
    const loc = requireOutboundS3(resolved);
    if (!s3Credentials) {
      throw badRequest(
        `peer '${resolved.peerName}' s3-compatible outbound drop needs delivery credentials, but ` +
          `none were resolved from the vault (fail-closed; set the delivery/<peer>/out secret)`
      );
    }
    const key = deliveryObjectKey(loc.prefix, fileName);
    await s3Put(loc, s3Credentials, key, contents);
    return `s3://${loc.bucket}/${key}`;
  }
  const outDir = requireOutboundDir(resolved);
  const filePath = resolveUnderDir(outDir, fileName);
  await mkdir(outDir, { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

/**
 * READ SEAM (the §13.1a inbox surface) — PROVIDER-DISPATCHED: the file NAMES currently sitting in the
 * peer's resolved inbound location — names only, no paths/keys, no traversal.
 *
 * `filesystem` (unchanged from M13.2a):
 *   - an unresolvable inbound direction refuses fail-closed with its named problem;
 *   - only regular files are listed (subdirectories/other are ignored — the two channel artifacts
 *     are always plain files);
 *   - every returned name round-trips the `resolveUnderDir` guard (belt-and-braces);
 *   - a not-yet-created inbox lists as empty (an empty and an absent inbox are the same "nothing
 *     arrived" answer for a polling loop).
 *
 * `s3-compatible` (13.2b): lists object BASENAMES under the inbound prefix via `delivery-s3.ts`
 *   (`s3Credentials` REQUIRED — its absence is a fail-closed 400); nested keys are skipped, exactly
 *   as the filesystem path skips subdirectories.
 *
 * Sorted for deterministic consumption order.
 */
export async function listInbox(
  peer: DeliveryTargetPeerRef | null,
  config?: DeliveryEnvDirs,
  roots?: readonly string[],
  s3Credentials?: S3DeliveryCredentials
): Promise<string[]> {
  const resolved = resolveDeliveryTarget(peer, config, roots);
  if (resolved.provider === "s3-compatible") {
    const loc = requireInboundS3(resolved);
    if (!s3Credentials) {
      throw badRequest(
        `peer '${resolved.peerName}' s3-compatible inbox needs delivery credentials, but none were ` +
          `resolved from the vault (fail-closed; set the delivery/<peer>/in secret)`
      );
    }
    return s3List(loc, s3Credentials);
  }
  const inDir = requireInboundDir(resolved);
  let entries;
  try {
    entries = await readdir(inDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // The PR #112 traversal guard, applied to every name we hand out (throws on escape — an inbox
    // whose listing can name a path outside itself is refused outright, fail-closed).
    const resolvedPath = resolveUnderDir(inDir, entry.name);
    if (path.basename(resolvedPath) !== entry.name) continue;
    names.push(entry.name);
  }
  return names.sort();
}

/** READ SEAM (materialize one inbox object) — PROVIDER-DISPATCHED: fetch the BYTES of `fileName` from
 *  the peer's resolved inbound location, so a consumer can hand it to the existing import paths.
 *  `filesystem` = readFile under the `resolveUnderDir` guard; `s3-compatible` = a GetObject via
 *  `delivery-s3.ts` (`s3Credentials` REQUIRED). Returns the object bytes. */
export async function getDeliveryFile(
  resolved: ResolvedDeliveryTarget,
  fileName: string,
  s3Credentials?: S3DeliveryCredentials
): Promise<Buffer> {
  if (resolved.provider === "s3-compatible") {
    const loc = requireInboundS3(resolved);
    if (!s3Credentials) {
      throw badRequest(
        `peer '${resolved.peerName}' s3-compatible inbox needs delivery credentials to read '${fileName}' ` +
          `(fail-closed; set the delivery/<peer>/in secret)`
      );
    }
    return s3Get(loc, s3Credentials, deliveryObjectKey(loc.prefix, fileName));
  }
  const inDir = requireInboundDir(resolved);
  return readFile(resolveUnderDir(inDir, fileName));
}

/**
 * CONFIG-TIME gate (the pair route): refuse a `deliveryTarget` whose data-supplied ENDPOINT falls
 * outside the operator allowlist BEFORE it is ever stored — the pairing half of the #110 allowlist
 * (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`) pattern. Throws a fail-closed 400 `badRequest`; returns
 * cleanly when there is nothing to bound. Provider-dispatched:
 *
 *   - `null`/`undefined` target — the tri-state CLEAR/PRESERVE cases: env fallback, nothing to bound;
 *   - `filesystem` — each per-direction dir must sit under a `SCP_DELIVERY_ROOTS` root (schema has
 *     already proven it absolute + traversal-free), else refuse; UNSET roots + any dir ⇒ refuse;
 *   - `s3-compatible` (13.2b) — the endpoint[+bucket] must be in the `SCP_DELIVERY_S3_ENDPOINTS`
 *     allowlist, else refuse; UNSET allowlist + s3 target ⇒ refuse (the honest fail-closed default).
 *
 * `roots`/`s3Allow` default to the live `SCP_DELIVERY_ROOTS` / `SCP_DELIVERY_S3_ENDPOINTS`.
 */
export function assertDeliveryTargetRooted(
  target: DeliveryTarget | null | undefined,
  roots?: readonly string[],
  s3Allow?: readonly DeliveryS3AllowEntry[]
): void {
  if (!target) return; // tri-state clear/preserve — env-fallback, nothing to bound.
  if (target.provider === "s3-compatible") {
    const allow = s3Allow ?? deliveryS3EndpointsFromEnv();
    if (allow.length === 0) {
      throw badRequest(
        `deliveryTarget endpoint '${target.endpoint}' / bucket '${target.bucket}' cannot be honored: ` +
          `no operator s3 delivery endpoints are declared (SCP_DELIVERY_S3_ENDPOINTS is unset) — ` +
          `refusing to store any s3 delivery target (set SCP_DELIVERY_S3_ENDPOINTS to the allowed ` +
          `endpoint[+bucket] entries before configuring an s3 deliveryTarget)`
      );
    }
    if (!isDeliveryS3EndpointAllowed(target.endpoint, target.bucket, allow)) {
      throw badRequest(
        `deliveryTarget endpoint '${target.endpoint}' / bucket '${target.bucket}' is not in the ` +
          `operator s3 delivery allowlist (SCP_DELIVERY_S3_ENDPOINTS) — refusing to store it ` +
          `(allowlist the endpoint[+bucket] first)`
      );
    }
    return;
  }
  const activeRoots = roots ?? deliveryRootsFromEnv();
  for (const field of ["outDir", "inDir"] as const) {
    const dir = target[field];
    if (dir === undefined) continue;
    const envVar = field === "outDir" ? "SCP_RELAY_OUT_DIR" : "SCP_RELAY_IN_DIR";
    if (activeRoots.length === 0) {
      throw badRequest(
        `deliveryTarget ${field} '${dir}' cannot be honored: no operator delivery roots are ` +
          `declared (SCP_DELIVERY_ROOTS is unset) — refusing to store any per-peer delivery ` +
          `directory (set SCP_DELIVERY_ROOTS to the absolute root(s) per-peer dirs may live under, ` +
          `or omit the per-peer dir to use the instance-level ${envVar} fallback)`
      );
    }
    if (!isUnderDeliveryRoot(dir, activeRoots)) {
      throw badRequest(
        `deliveryTarget ${field} '${dir}' is outside every operator-declared delivery root ` +
          `(SCP_DELIVERY_ROOTS) — refusing to store it (the directory must be at or under one of ` +
          `the configured roots)`
      );
    }
  }
}

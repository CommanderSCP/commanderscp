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
 * The `filesystem` provider is the only M13.2a provider; 13.2b slots `s3-compatible` in as a new
 * `DeliveryTargetSchema` union member with put/list/get behind these same seams.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeliveryTarget } from "@scp/schemas";
import { badRequest } from "../errors.js";
import { resolveUnderDir, relayConfigFromEnv } from "./retrans-relay.js";

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

/** One direction of the resolved view. `dir === null` ⇔ `problem !== null` (per-gap, fail-closed:
 *  the problem TEXT is what `requireOutboundDir`/`requireInboundDir` refuse with). */
export interface ResolvedDeliveryDirection {
  dir: string | null;
  /** Where the effective dir came from: the peer's own config or the instance env. */
  source: "peer" | "env" | null;
  problem: string | null;
}

/** The validated per-peer view (the M15.6 shape: effective config + `valid` + per-gap `problems`). */
export interface ResolvedDeliveryTarget {
  provider: "filesystem";
  /** The peer in play, or `null` for an env-only resolution. */
  peerName: string | null;
  outbound: ResolvedDeliveryDirection;
  inbound: ResolvedDeliveryDirection;
  /** True iff BOTH directions resolved. Consumers needing only one direction gate on that
   *  direction's own `problem` (via the `require*Dir` helpers), not on `valid`. */
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

function resolveDirection(
  direction: "outbound" | "inbound",
  peer: DeliveryTargetPeerRef | null,
  envDir: string | undefined,
  roots: readonly string[]
): ResolvedDeliveryDirection {
  const field = direction === "outbound" ? "outDir" : "inDir";
  const envVar = direction === "outbound" ? "SCP_RELAY_OUT_DIR" : "SCP_RELAY_IN_DIR";
  const use = direction === "outbound" ? "outbound drops have" : "inbound intake has";

  const peerDir = peer?.deliveryTarget?.[field];
  if (peerDir !== undefined) {
    // A CONFIGURED per-peer value is authoritative for its direction. A hostile value is a
    // fail-closed problem — deliberately NOT an env fallback, which would mask the misconfig.
    if (!isSafeAbsoluteDir(peerDir)) {
      return {
        dir: null,
        source: null,
        problem:
          `peer '${peer?.name}' deliveryTarget ${field} '${peerDir}' is not an absolute, ` +
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
          `peer '${peer?.name}' configures a deliveryTarget ${field} '${peerDir}' but no operator ` +
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
          `peer '${peer?.name}' deliveryTarget ${field} '${peerDir}' is outside every ` +
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
    problem: peer
      ? `peer '${peer.name}' configures no deliveryTarget ${field} and the instance env ` +
        `${envVar} is unset — ${use} nowhere to land (fail-closed; configure the peer's ` +
        `deliveryTarget or set ${envVar})`
      : `no delivery peer in play and the instance env ${envVar} is unset — ${use} nowhere ` +
        `to land (fail-closed; set ${envVar} or name a peer with a configured deliveryTarget)`
  };
}

/**
 * The effective DeliveryTarget for `peer` (or the env-only target when `peer` is null), with
 * per-gap `problems` — never throws; the `require*Dir` helpers turn a gap into a fail-closed
 * refusal at the point of use. `config` defaults to the live env (`relayConfigFromEnv()`).
 */
export function resolveDeliveryTarget(
  peer: DeliveryTargetPeerRef | null,
  config?: DeliveryEnvDirs,
  roots?: readonly string[]
): ResolvedDeliveryTarget {
  const env = config ?? relayConfigFromEnv();
  // Roots are a SEPARATE operator concern from the env-dir fallback: default them from the env
  // independently so callers that pass a `RelayConfig` as `config` (the relay route) still get the
  // operator's declared roots rather than an empty list.
  const activeRoots = roots ?? deliveryRootsFromEnv();
  const outbound = resolveDirection("outbound", peer, env.outDir, activeRoots);
  const inbound = resolveDirection("inbound", peer, env.inDir, activeRoots);
  const problems = [outbound.problem, inbound.problem].filter((p): p is string => p !== null);
  return {
    provider: "filesystem",
    peerName: peer?.name ?? null,
    outbound,
    inbound,
    valid: problems.length === 0,
    problems
  };
}

/** The resolved OUTBOUND drop directory, or a fail-closed 400 carrying the named per-gap problem
 *  — never a silent default path. */
export function requireOutboundDir(resolved: ResolvedDeliveryTarget): string {
  if (resolved.outbound.dir === null) {
    throw badRequest(resolved.outbound.problem ?? "delivery target outbound directory unresolved");
  }
  return resolved.outbound.dir;
}

/** The resolved INBOUND intake directory, or a fail-closed 400 carrying the named per-gap problem. */
export function requireInboundDir(resolved: ResolvedDeliveryTarget): string {
  if (resolved.inbound.dir === null) {
    throw badRequest(resolved.inbound.problem ?? "delivery target inbound directory unresolved");
  }
  return resolved.inbound.dir;
}

/** WRITE SEAM (filesystem provider): drop `contents` as `fileName` into the peer's resolved
 *  outbound directory — exactly the PR #112 write behavior (mkdir -p + write), made per-peer.
 *  `fileName` rides the `resolveUnderDir` traversal guard: a hostile name never escapes the drop
 *  directory. Returns the absolute path written. */
export async function dropDeliveryFile(
  resolved: ResolvedDeliveryTarget,
  fileName: string,
  contents: string | Buffer
): Promise<string> {
  const outDir = requireOutboundDir(resolved);
  const filePath = resolveUnderDir(outDir, fileName);
  await mkdir(outDir, { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

/**
 * READ SEAM (the §13.1a inbox surface): the file NAMES currently sitting in the peer's resolved
 * inbound directory — names only, no paths, no traversal:
 *
 *   - an unresolvable inbound direction refuses fail-closed with its named problem;
 *   - only regular files are listed (subdirectories and anything else are ignored — the two
 *     channel artifacts are always plain files);
 *   - every returned name must round-trip the `resolveUnderDir` guard (belt-and-braces: readdir
 *     yields basenames, but the guard is the single traversal authority and it survives here);
 *   - a not-yet-created inbox lists as empty (the drop side `mkdir -p`s lazily; an empty inbox
 *     and an absent one are the same "nothing has arrived" answer for a polling loop).
 *
 * Sorted for deterministic consumption order.
 */
export async function listInbox(
  peer: DeliveryTargetPeerRef | null,
  config?: DeliveryEnvDirs,
  roots?: readonly string[]
): Promise<string[]> {
  const resolved = resolveDeliveryTarget(peer, config, roots);
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

/**
 * CONFIG-TIME gate (the pair route): refuse a `deliveryTarget` whose directories fall outside the
 * operator-declared roots BEFORE it is ever stored — the pairing half of the #110 allowlist
 * (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`) pattern. Throws a fail-closed 400 `badRequest`; returns
 * cleanly (no roots needed) when there is no per-peer directory to bound:
 *
 *   - `null`/`undefined` target — the tri-state CLEAR/PRESERVE cases: env fallback, no roots gate;
 *   - a target object with a per-direction dir — each dir must sit under a root (schema has already
 *     proven it absolute + traversal-free), else refuse; UNSET roots + any dir ⇒ refuse (the honest
 *     multi-tenant default — the operator declares roots before any per-peer dir is honored).
 *
 * `roots` defaults to the live `SCP_DELIVERY_ROOTS`.
 */
export function assertDeliveryTargetRooted(
  target: DeliveryTarget | null | undefined,
  roots?: readonly string[]
): void {
  if (!target) return; // tri-state clear/preserve — env-fallback, no per-peer dir to bound.
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

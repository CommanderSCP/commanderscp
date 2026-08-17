import { and, eq } from "drizzle-orm";
import { compareVersions } from "@scp/dependency-manifests";
import {
  DependencyEcosystemSchema,
  vendorLatestPackageKey,
  type DependencyEcosystem,
  type ScanVendorLatestFacts
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { componentDependencies, dependencyLines } from "../db/schema.js";
import { lineAcceptsVersion } from "../dependencies/line-head.js";
import { dependencyVersionPollIntervalSeconds } from "../dependencies/version-poll.js";

/**
 * M22.4 (ADR-0033, owner decision D1) — "ARE WE ON THE LATEST OF THIS MAJOR LINE?", resolved once
 * against the ADR-0032 dependency inventory and handed to the pure matcher as data.
 *
 * ===========================================================================================
 * THE RULE
 * ===========================================================================================
 * The owner's headline rule is that a vendor dependency is accepted only if the component is on the
 * LATEST VERSION OF A MAJOR VERSION — no exceptions unless an override is created and approved
 * (M22.6). "Latest of a major version" is not a new concept that needs a new store: it is exactly
 * `dependency_lines`' identity `(org_id, ecosystem, coordinate, major)` plus its observed head, so
 * this file is a READ over the existing inventory and adds no storage of its own.
 *
 * ===========================================================================================
 * WHY THIS FILE IS IN `governance/` AND NOT IN `dependencies/`
 * ===========================================================================================
 * `dependencies/` owns the inventory: what a manifest declared, what an index answered, when a head
 * moved and which write door may move it. This file OWNS NOTHING THERE. It reads two of that
 * module's tables and reuses two of its pure functions (`lineAcceptsVersion` for "is this string a
 * version on this line", `dependencyVersionPollIntervalSeconds` for the freshness bound) and writes
 * nothing anywhere. It is a governance question asked of dependency data, so it lives beside the
 * gate that asks it.
 *
 * ===========================================================================================
 * EVERY ABSENCE FAILS CLOSED, AND THAT LIST IS THE FEATURE
 * ===========================================================================================
 * A vendor-pass is a LOOSENING: it removes a finding before it is counted. So the interesting cases
 * are not the ones where it applies but the ones where it must not, and each is a distinct,
 * named {@link VendorLineRefusal} rather than a fall-through:
 *
 *  1. NO INVENTORY ROW — the component declares nothing, or nothing on this line. Nothing to be at
 *     the head of. Handled by absence: the query returns no row and no key is emitted.
 *  2. NULL `latest_version` — "not yet observed" is NEVER "no newer version exists" (migration 0061
 *     says so on the column, and `scan_requirement_floors` established the same reading for its
 *     nullable ceilings). `head_not_observed`.
 *  3. A STALE HEAD — see {@link vendorLatestStalenessBoundMs}. An observation from before the bound
 *     is a claim about a world that has since moved. `head_stale`.
 *  4. AN OUTPOST — `dependencyVersionPollRoleGuard` (ADR-0032 §7c) refuses to poll on anything that
 *     has not explicitly declared `SCP_FEDERATION_ROLE=commander`, and `dependency_lines` is a
 *     per-domain projection that does not federate. So on an outpost the head was never observed
 *     LOCALLY and the columns are NULL — case 2, reached by data rather than by a role check here.
 *     That is deliberate: a second role predicate in this file would be a predicate to forget, and
 *     the poll's own module doc makes the same argument about its work-list.
 *  5. AN `unresolved` OR `unpinned` `FROM` — `dockerfile.ts` records an ARG-interpolated reference as
 *     `unresolved` and a bare `FROM alpine` as `unpinned`, and neither carries a comparable version,
 *     so `placeDeclarationOnLine` refuses to mint a line for it at all. Case 1 again, by
 *     construction: there is no row to be at the head of.
 *  6. A DIGEST-ONLY `FROM alpine@sha256:…` — pinned, but with no version string, so likewise no
 *     line. Case 1.
 *  7. NO DEPENDENCY AUTOMATION AT ALL (owner decision D7) — no ingested manifests and no polled
 *     head, so no vendor-pass and the component upgrades manually. THE GATE IS DECOUPLED FROM
 *     AUTOMATION; THE DATA IS NOT. Nothing here widens ingestion or polling coverage to make the
 *     rule universally evaluable — that was considered at length and explicitly declined
 *     (ADR-0033 "Alternatives considered").
 */

// -------------------------------------------------------------------------------------------
// Freshness
// -------------------------------------------------------------------------------------------

/**
 * How many POLL CYCLES an observation may be old before it stops counting as evidence.
 *
 * Three, not a wall-clock duration, and the difference is the whole point: the bound is DERIVED from
 * `SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS`, so an operator who slows the poll to weekly does
 * not silently acquire a gate that refuses every vendor-pass, and one who speeds it to hourly gets a
 * correspondingly tighter freshness requirement for free. A hardcoded "7 days" here would be a
 * second, invisible configuration of the same thing — and the two would disagree the first time
 * anybody changed either.
 *
 * Three cycles tolerates one missed tick plus the run that noticed, without tolerating a poll that
 * has been dead for a week.
 */
export const VENDOR_LATEST_STALENESS_POLL_CYCLES = 3;

/**
 * The freshness bound, in milliseconds, read from the LIVE env on every resolution — the rule M14.4
 * established for every value that a re-scheduling loop can have changed underneath it.
 *
 * NOT HARDCODED, BY REQUIREMENT. `dependencyVersionPollIntervalSeconds` is the single definition of
 * how often a head can move, floor included; this is a multiple of it and has no number of its own
 * except the cycle count above.
 */
export function vendorLatestStalenessBoundMs(env: NodeJS.ProcessEnv = process.env): number {
  return dependencyVersionPollIntervalSeconds(env) * 1000 * VENDOR_LATEST_STALENESS_POLL_CYCLES;
}

// -------------------------------------------------------------------------------------------
// One (line, declaration) pair
// -------------------------------------------------------------------------------------------

/** WHY a declaration is not at its line's head. Every one of these yields NO vendor-pass; they are
 *  distinct so an operator can be told which absence stopped it rather than "not applicable". */
export type VendorLineRefusal =
  /** `latest_version IS NULL` — the head has never been observed in THIS domain. Not "there is no
   *  newer version". Also the shape an outpost is always in (`dependencyVersionPollRoleGuard`). */
  | "head_not_observed"
  /** `latest_observed_at` is older than {@link vendorLatestStalenessBoundMs}, or absent. */
  | "head_stale"
  /** `oci` — the line's head tag has no recorded digest, so there is nothing identity-bearing to
   *  compare against. A tag alone is not an identity (ADR-0032 §7). */
  | "head_digest_unknown"
  /** `oci` — the component's `FROM` resolves to no digest, so it cannot be shown to be the same
   *  bytes as the head. The overwhelmingly common shape for a tag-only `FROM`. */
  | "declaration_digest_unknown"
  /** `oci` — both digests are known and they DIFFER. The tags may well agree; that is exactly the
   *  case this rule exists to catch. */
  | "digest_mismatch"
  /** A language line whose declaration pins no concrete version (an open range). "The manifest does
   *  not pin one" — never "we did not look". */
  | "declaration_not_pinned"
  /** One of the two version strings is not a version on this line as the line is defined now. */
  | "version_not_comparable"
  /** The declaration is genuinely BEHIND the head. The ordinary failing case, and the one the rule
   *  is for. */
  | "behind_head";

export type VendorLineVerdict =
  { readonly atHead: true } | { readonly atHead: false; readonly reason: VendorLineRefusal };

const AT_HEAD: VendorLineVerdict = { atHead: true };

/** The line columns this evaluation reads. Deliberately narrow: nothing here may reach
 *  `produced_by_object_id` or any other column and start making a second kind of decision. */
export interface VendorLineFacts {
  /** NARROWED AT THE READ BOUNDARY, never here. `dependency_lines.ecosystem` is plain `text` with no
   *  pg enum and no CHECK (the closed set lives in `DependencyEcosystemSchema`), so a row carrying
   *  something else is dropped by {@link readVendorInventoryRows} rather than reaching this
   *  evaluation as a string nobody can reason about. */
  ecosystem: DependencyEcosystem;
  coordinate: string;
  major: string;
  tagPattern: string | null;
  latestVersion: string | null;
  latestDigest: string | null;
  latestObservedAt: Date | null;
}

/** The declaration columns this evaluation reads. */
export interface VendorDeclarationFacts {
  resolvedVersion: string | null;
  resolvedDigest: string | null;
}

/** Is the line's head fresh enough to be evidence? A NULL timestamp is not "always fresh" — it is
 *  the absence of an observation, which is the same refusal a very old one gets. */
function headIsFresh(observedAt: Date | null, now: Date, boundMs: number): boolean {
  if (observedAt === null) return false;
  return now.getTime() - observedAt.getTime() <= boundMs;
}

/**
 * PURE — is this declaration at its line's head?
 *
 * The two arms are genuinely different questions and are kept apart rather than unified behind a
 * "compare the versions" helper:
 *
 *  - `oci` COMPARES `latest_digest`, NEVER THE TAG. An OCI index reports TAGS, and a tag is mutable:
 *    `3.19` names one set of bytes today and another next week, so two references agreeing on a tag
 *    is not evidence they are the same image. `dependency_lines.latest_digest` exists precisely
 *    because "a mutable tag is not an identity" (ADR-0032 §7), and it is recorded in the SAME
 *    observation as the version so the pair cannot be one that never existed. Comparing
 *    `resolved_version` to `latest_version` here would be comparing tags with extra steps and would
 *    pass a component sitting on a stale `3.19` that the registry has since repointed.
 *  - the four LANGUAGE ecosystems have immutable published versions, so the version IS the identity
 *    and the comparison is an ordering — through `lineAcceptsVersion`, the same door both inventory
 *    ingresses use, so "is `2.1.0` on the `2` line" means one thing in this tree.
 *
 * A declaration AHEAD of the recorded head is accepted (`compareVersions` > 0): the component is not
 * behind, and the poll simply has not caught up. Refusing there would fail a component for its own
 * currency.
 */
export function evaluateVendorLineAtHead(
  line: VendorLineFacts,
  declaration: VendorDeclarationFacts,
  options: { now: Date; stalenessBoundMs: number }
): VendorLineVerdict {
  // NULL `latest_version` DOES NOT QUALIFY, first and unconditionally. Not observed is never up to
  // date, and this is checked before anything else so no later branch can reach past it.
  if (line.latestVersion === null) return { atHead: false, reason: "head_not_observed" };
  if (!headIsFresh(line.latestObservedAt, options.now, options.stalenessBoundMs)) {
    return { atHead: false, reason: "head_stale" };
  }

  if (line.ecosystem === "oci") {
    if (line.latestDigest === null) return { atHead: false, reason: "head_digest_unknown" };
    if (declaration.resolvedDigest === null) {
      return { atHead: false, reason: "declaration_digest_unknown" };
    }
    if (declaration.resolvedDigest !== line.latestDigest) {
      return { atHead: false, reason: "digest_mismatch" };
    }
    return AT_HEAD;
  }

  if (declaration.resolvedVersion === null) {
    return { atHead: false, reason: "declaration_not_pinned" };
  }
  const declared = lineAcceptsVersion(line, declaration.resolvedVersion);
  if (!declared.accepted) return { atHead: false, reason: "version_not_comparable" };
  const head = lineAcceptsVersion(line, line.latestVersion);
  if (!head.accepted) return { atHead: false, reason: "version_not_comparable" };
  const order = compareVersions(declared.parsed, head.parsed);
  if (order === undefined) return { atHead: false, reason: "version_not_comparable" };
  return order < 0 ? { atHead: false, reason: "behind_head" } : AT_HEAD;
}

// -------------------------------------------------------------------------------------------
// One target's facts
// -------------------------------------------------------------------------------------------

/** One row of the inventory read: a declaration joined to the line it sits on. */
export interface VendorInventoryRow extends VendorLineFacts, VendorDeclarationFacts {
  lineId: string;
}

/**
 * PURE — fold one target's inventory rows into the facts the matcher consumes.
 *
 * TWO "ALL, NOT ANY" RULES, both fail-closed and both load-bearing:
 *
 *  1. THE BASE IMAGE. A multi-stage build declares several `oci` lines, and an `os-pkgs` finding
 *     names no image — Trivy reports the package, not which `FROM` it arrived on. There is no
 *     material to attribute it to one of them, so the pass requires EVERY declared base-image line
 *     to be at its head, and requires at least one to exist. "Any" would let a component with a
 *     current builder stage and a stale runtime stage excuse every OS finding in the runtime.
 *  2. A LINE DECLARED FROM TWO MANIFESTS. `component_dependencies` is keyed by manifest path on
 *     purpose (one component can legitimately declare `lodash` from a root and a workspace
 *     `package.json`), so one line can have several rows at different versions. A key is emitted
 *     only if EVERY row for that line is at the head — one stale declaration is a real exposure and
 *     must not be voted away by a current sibling.
 */
export function foldVendorLatestFacts(
  rows: readonly VendorInventoryRow[],
  options: { now: Date; stalenessBoundMs: number }
): ScanVendorLatestFacts {
  let ociLines = 0;
  let ociAllAtHead = true;
  /** lineId → (every row at head so far, key) for the language lines. */
  const langByLine = new Map<string, { allAtHead: boolean; key: string }>();
  const seenOciLines = new Set<string>();

  for (const row of rows) {
    const verdict = evaluateVendorLineAtHead(row, row, options);
    if (row.ecosystem === "oci") {
      if (!seenOciLines.has(row.lineId)) {
        seenOciLines.add(row.lineId);
        ociLines += 1;
      }
      if (!verdict.atHead) ociAllAtHead = false;
      continue;
    }
    const key = vendorLatestPackageKey(row.ecosystem, row.coordinate);
    const current = langByLine.get(row.lineId);
    if (current === undefined) {
      langByLine.set(row.lineId, { allAtHead: verdict.atHead, key });
    } else if (!verdict.atHead) {
      current.allAtHead = false;
    }
  }

  const packageKeys = [...langByLine.values()]
    .filter((entry) => entry.allAtHead)
    .map((entry) => entry.key)
    // Sorted and de-duplicated: two lines can canonicalise to one key (PEP 503 folds `zope.interface`
    // and `zope_interface`), and the array reaches the gate Decision's `inputContext`, where an
    // unstable order would defeat `insertDecisionIfChanged` and re-open the measured 1.44 GB/day
    // write amplification.
    .sort();
  return {
    baseImageAtLatest: ociLines > 0 && ociAllAtHead,
    packageKeys: [...new Set(packageKeys)]
  };
}

/**
 * Read ONE target's declared inventory, joined to its lines.
 *
 * One index descent on `component_dependencies`' primary-key prefix `(org_id, component_object_id)`
 * plus the composite-key join — the same forward lookup `listComponentDependencies` takes. A target
 * that is not a component (a service, an assembly) simply declares nothing and yields no rows, which
 * is the correct answer rather than an error: `component_dependencies` is keyed by the COMPONENT's
 * graph object id and nothing else has declarations.
 */
export async function readVendorInventoryRows(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<VendorInventoryRow[]> {
  const rows = await tx
    .select({
      lineId: dependencyLines.id,
      ecosystem: dependencyLines.ecosystem,
      coordinate: dependencyLines.coordinate,
      major: dependencyLines.major,
      tagPattern: dependencyLines.tagPattern,
      latestVersion: dependencyLines.latestVersion,
      latestDigest: dependencyLines.latestDigest,
      latestObservedAt: dependencyLines.latestObservedAt,
      resolvedVersion: componentDependencies.resolvedVersion,
      resolvedDigest: componentDependencies.resolvedDigest
    })
    .from(componentDependencies)
    .innerJoin(
      dependencyLines,
      and(
        eq(dependencyLines.orgId, componentDependencies.orgId),
        eq(dependencyLines.id, componentDependencies.lineId)
      )
    )
    .where(
      and(
        eq(componentDependencies.orgId, orgId),
        eq(componentDependencies.componentObjectId, targetObjectId)
      )
    );
  // AN UNRECOGNISED ECOSYSTEM IS DROPPED, not coerced. The column is plain `text` with no CHECK, so
  // a sixth ecosystem written by a future ingress (or by raw SQL) would otherwise arrive here as a
  // string this file has no rule for. Dropping it means no key and no base-image credit — the
  // fail-closed direction, and the same reading `readInstanceScanExclusionAdmissions` gives an
  // unrecognised tier label.
  const out: VendorInventoryRow[] = [];
  for (const row of rows) {
    const ecosystem = DependencyEcosystemSchema.safeParse(row.ecosystem);
    if (!ecosystem.success) continue;
    out.push({ ...row, ecosystem: ecosystem.data });
  }
  return out;
}

/** Resolve one target's vendor facts. */
export async function resolveVendorLatestFactsForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  options?: { now?: Date; env?: NodeJS.ProcessEnv }
): Promise<ScanVendorLatestFacts> {
  const rows = await readVendorInventoryRows(tx, orgId, targetObjectId);
  return foldVendorLatestFacts(rows, {
    now: options?.now ?? new Date(),
    stalenessBoundMs: vendorLatestStalenessBoundMs(options?.env)
  });
}

/**
 * PURE — compose several targets' facts into the ONE set that describes the change.
 *
 * AN INTERSECTION, NEVER A UNION, for exactly the reason ADR-0033 §3 forbids unioning CLAUSES: one
 * verdict is produced for one artifact across a change's whole target set, and a fact admitted for
 * one target that leaked onto a sibling would excuse findings on a component nobody said was
 * current. `baseImageAtLatest` is therefore an AND and `packageKeys` a set intersection. A
 * single-target change — the overwhelmingly common shape — is unaffected.
 *
 * NO TARGETS yields `undefined`, not "everything": an intersection over an empty family is
 * conventionally the universe, which here would be a vendor-pass for a change with nothing to be
 * current about.
 */
export function intersectVendorLatestFacts(
  perTarget: readonly ScanVendorLatestFacts[]
): ScanVendorLatestFacts | undefined {
  if (perTarget.length === 0) return undefined;
  let baseImageAtLatest = true;
  let keys: Set<string> | undefined;
  for (const facts of perTarget) {
    if (!facts.baseImageAtLatest) baseImageAtLatest = false;
    if (keys === undefined) {
      keys = new Set(facts.packageKeys);
      continue;
    }
    const here = new Set(facts.packageKeys);
    for (const key of [...keys]) if (!here.has(key)) keys.delete(key);
  }
  return { baseImageAtLatest, packageKeys: [...(keys ?? [])].sort() };
}

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

/** Are we on the latest of this major line. See docs/governance.md §403. */

/** How many poll cycles an observation may be old. See docs/governance.md §404. */
export const VENDOR_LATEST_STALENESS_POLL_CYCLES = 3;

/** The freshness bound, read from the live environment. See docs/governance.md §405. */
export function vendorLatestStalenessBoundMs(env: NodeJS.ProcessEnv = process.env): number {
  return dependencyVersionPollIntervalSeconds(env) * 1000 * VENDOR_LATEST_STALENESS_POLL_CYCLES;
}

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

/** PURE — is this declaration at its line's head? See docs/governance.md §406. */
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

/** One row of the inventory read: a declaration joined to the line it sits on. */
export interface VendorInventoryRow extends VendorLineFacts, VendorDeclarationFacts {
  lineId: string;
}

/** Pure: folds one target's rows into the matcher's facts. See docs/governance.md §407. */
export function foldVendorLatestFacts(
  rows: readonly VendorInventoryRow[],
  options: { now: Date; stalenessBoundMs: number }
): ScanVendorLatestFacts {
  let ociLines = 0;
  let ociAllAtHead = true;
  /** lineId → (every row at head so far, one key per at-head row) for the language lines. */
  const langByLine = new Map<string, { allAtHead: boolean; keys: string[] }>();
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
    // A NULL `resolved_version` yields no key at all. It is the `declaration_not_pinned` refusal —
    // an open range pins nothing, so there is no version for a finding to be equal to — and that
    // same row has already forced `allAtHead` false, so the line emits nothing either way. Skipping
    // it here rather than coercing to `""` keeps the two facts from ever disagreeing.
    const key =
      row.resolvedVersion === null
        ? undefined
        : vendorLatestPackageKey(row.ecosystem, row.coordinate, row.resolvedVersion);
    const current = langByLine.get(row.lineId);
    if (current === undefined) {
      langByLine.set(row.lineId, {
        allAtHead: verdict.atHead,
        keys: verdict.atHead && key !== undefined ? [key] : []
      });
      continue;
    }
    if (!verdict.atHead) current.allAtHead = false;
    else if (key !== undefined) current.keys.push(key);
  }

  const packageKeys = [...langByLine.values()]
    .filter((entry) => entry.allAtHead)
    .flatMap((entry) => entry.keys)
    // Sorted and de-duplicated: two lines at the same version can canonicalise to one key (PEP 503
    // folds `zope.interface` and `zope_interface`), and two manifests can declare one line at the
    // same version. The array reaches the gate Decision's `inputContext`, where an
    // unstable order would defeat `insertDecisionIfChanged` and re-open the measured 1.44 GB/day
    // write amplification.
    .sort();
  return {
    baseImageAtLatest: ociLines > 0 && ociAllAtHead,
    packageKeys: [...new Set(packageKeys)]
  };
}

/** Read ONE target's declared inventory, joined to its lines. See docs/governance.md §408. */
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
  // AN UNRECOGNISED ECOSYSTEM IS DROPPED, not coerced. See docs/governance.md §409.
  const out: VendorInventoryRow[] = [];
  for (const row of rows) {
    const ecosystem = DependencyEcosystemSchema.safeParse(row.ecosystem);
    if (!ecosystem.success) continue;
    out.push({ ...row, ecosystem: ecosystem.data });
  }
  return out;
}

/** Resolve one target's vendor facts. See docs/governance.md §410. */
export async function resolveVendorLatestFactsForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  options: { now: Date; env?: NodeJS.ProcessEnv }
): Promise<ScanVendorLatestFacts> {
  const rows = await readVendorInventoryRows(tx, orgId, targetObjectId);
  return foldVendorLatestFacts(rows, {
    now: options.now,
    stalenessBoundMs: vendorLatestStalenessBoundMs(options.env)
  });
}

/** Pure: composes several targets' facts into one set. See docs/governance.md §411. */
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

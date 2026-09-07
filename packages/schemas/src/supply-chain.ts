import { z } from "zod";
import type { DependencyEcosystem } from "./dependencies.js";
import {
  ScanDbSourceSchema,
  ScanDbStalenessClassSchema,
  ScanDbThresholdFiredSchema
} from "./scan-db.js";

/** Supply-chain governance evidence. See docs/schemas.md §406. */

/** Per-severity vulnerability counts distilled from a Trivy result's `Results[].Vulnerabilities[]`
 *  (Trivy severities: CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN — `unknown` folded away; only the four the
 *  threshold model acts on are surfaced). */
export const ScanSeverityCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative()
});
export type ScanSeverityCounts = z.infer<typeof ScanSeverityCountsSchema>;

/** The four severities the threshold model acts on. Trivy also emits `UNKNOWN`, which is folded
 *  away — see `parseTrivyFindings`. */
const COUNTED_SEVERITIES = ["critical", "high", "medium", "low"] as const;

/** M22.1 (ADR-0033) — ONE Trivy finding, retained. See docs/schemas.md §407. */
export const ScanFindingSchema = z.object({
  /** Trivy `VulnerabilityID` (e.g. `CVE-2026-1234`). */
  vulnerabilityId: z.string().optional(),
  pkgName: z.string().optional(),
  installedVersion: z.string().optional(),
  /** Trivy `FixedVersion`. ABSENT means upstream has shipped no fix — the "no fix available"
   *  exclusion class reads exactly this, and reads absence as the signal rather than inferring it. */
  fixedVersion: z.string().optional(),
  /** Trivy `Results[].Class` — `os-pkgs` distinguishes an OS package (attributable to the BASE
   *  IMAGE line) from `lang-pkgs` (attributable to a declared manifest dependency, or transitive
   *  and attributable to nothing). This single field is what makes the vendor rule expressible
   *  without an inventory join. */
  class: z.string().optional(),
  /** Trivy `Results[].Target` — which artifact layer/file the finding came from. */
  target: z.string().optional(),
  severity: z.enum(COUNTED_SEVERITIES),
  /** `PkgIdentifier.PURL` VERBATIM, never normalized here. The dependency inventory stores its
   *  coordinate deliberately un-normalized too, so any canonicalization belongs at the join, once,
   *  where both sides are visible — not smeared across two parsers. */
  purl: z.string().optional()
});
export type ScanFinding = z.infer<typeof ScanFindingSchema>;

/** THE SHARED TRIVY PARSE. See docs/schemas.md §408. */
export function parseTrivyFindings(raw: unknown): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const results = (raw as { Results?: unknown } | null | undefined)?.Results;
  if (!Array.isArray(results)) return findings;
  for (const result of results) {
    const row = result as { Vulnerabilities?: unknown; Class?: unknown; Target?: unknown };
    const vulns = row.Vulnerabilities;
    if (!Array.isArray(vulns)) continue;
    const cls = typeof row.Class === "string" ? row.Class : undefined;
    const target = typeof row.Target === "string" ? row.Target : undefined;
    for (const v of vulns) {
      const entry = v as {
        Severity?: unknown;
        VulnerabilityID?: unknown;
        PkgName?: unknown;
        InstalledVersion?: unknown;
        FixedVersion?: unknown;
        PkgIdentifier?: { PURL?: unknown };
      };
      if (typeof entry.Severity !== "string") continue;
      const severity = entry.Severity.toLowerCase();
      if (!(COUNTED_SEVERITIES as readonly string[]).includes(severity)) continue;
      const str = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      findings.push({
        severity: severity as (typeof COUNTED_SEVERITIES)[number],
        ...(str(entry.VulnerabilityID) ? { vulnerabilityId: str(entry.VulnerabilityID)! } : {}),
        ...(str(entry.PkgName) ? { pkgName: str(entry.PkgName)! } : {}),
        ...(str(entry.InstalledVersion) ? { installedVersion: str(entry.InstalledVersion)! } : {}),
        ...(str(entry.FixedVersion) ? { fixedVersion: str(entry.FixedVersion)! } : {}),
        ...(cls ? { class: cls } : {}),
        ...(target ? { target } : {}),
        ...(str(entry.PkgIdentifier?.PURL) ? { purl: str(entry.PkgIdentifier?.PURL)! } : {})
      });
    }
  }
  return findings;
}

/** The counts are derived from the retained findings. See docs/schemas.md §409. */
export function severityCountsFromFindings(findings: readonly ScanFinding[]): ScanSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// ===========================================================================================
// M22.1b (ADR-0033 §7) — PERSISTING the findings: the cap, the record marker, and the transport
// seam between a plugin that cannot reach the database and the server that can.
// ===========================================================================================

/** The maximum number of findings persisted per scan. See docs/schemas.md §410. */
export const SCAN_FINDINGS_PERSIST_CAP = 2000;

export interface CappedScanFindings {
  findings: ScanFinding[];
  /** True iff the producer saw MORE findings than were retained. */
  truncated: boolean;
}

export function capScanFindings(
  findings: readonly ScanFinding[],
  cap: number = SCAN_FINDINGS_PERSIST_CAP
): CappedScanFindings {
  if (findings.length <= cap) return { findings: [...findings], truncated: false };
  return { findings: findings.slice(0, cap), truncated: true };
}

/** What a scan's persisted finding set is, stated positively. See docs/schemas.md §411. */
export const ScanFindingsRecordSchema = z.enum(["full", "truncated", "unsupported"]);
export type ScanFindingsRecord = z.infer<typeof ScanFindingsRecordSchema>;

/** Whether a scan METHOD can carry per-finding detail at all. See docs/schemas.md §412. */
export function scanMethodCarriesFindings(method: ScanMethod): boolean {
  switch (method) {
    case "trivy":
    case "trivy-vm":
      return true;
    case "openscap":
      return false;
  }
}

/** The one decision about a scan's finding set, shared. See docs/schemas.md §413. */
export function scanFindingsRecordFor(
  method: ScanMethod,
  capped: CappedScanFindings | undefined
): ScanFindingsRecord | undefined {
  if (!scanMethodCarriesFindings(method)) return "unsupported";
  if (capped === undefined) return undefined;
  return capped.truncated ? "truncated" : "full";
}

/** The ADR-0024 §D1 evidentiary class of ONE persisted finding row. See docs/schemas.md §414. */
export const ScanFindingRetentionClassSchema = z.enum(["E", "O"]);
export type ScanFindingRetentionClass = z.infer<typeof ScanFindingRetentionClassSchema>;

/** The class a finding row is written with. See docs/schemas.md §415. */
export function scanFindingRetentionClass(excluded: boolean): ScanFindingRetentionClass {
  return excluded ? "E" : "O";
}

/** The plugin-to-server transport seam, and why a key. See docs/schemas.md §416. */
export const SCAN_FINDINGS_TRANSPORT_KEY = "$scanFindings";
export const SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY = "$scanFindingsTruncated";
/** M22.2 — which of the transported findings the plugin EXCLUDED, by position. It rides the same
 *  seam and for the same reason: the plugin decided the exclusion (it has the findings and the
 *  gate-resolved clauses on its context) but only the server can write the row's ADR-0024 retention
 *  class, and an excluded finding is accepted-risk evidence (class `E`) rather than telemetry. */
export const SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY = "$scanFindingsExcluded";

/** Attach a producer's capped findings to an outcome's evidence for the trip across the plugin-host
 *  RPC. Called AFTER `ScanEvidenceSchema.parse`, because that parse strips unknown keys. */
export function attachScanFindingsForTransport(
  evidence: Record<string, unknown>,
  capped: CappedScanFindings,
  excludedOrdinals: readonly number[] = []
): Record<string, unknown> {
  return {
    ...evidence,
    [SCAN_FINDINGS_TRANSPORT_KEY]: capped.findings,
    [SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY]: capped.truncated,
    ...(excludedOrdinals.length > 0
      ? { [SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY]: [...excludedOrdinals] }
      : {})
  };
}

/** Read a plugin's transported findings out of the record. See docs/schemas.md §417. */
export function takeScanFindingsFromTransport(evidence: Record<string, unknown>): {
  evidence: Record<string, unknown>;
  capped: CappedScanFindings | undefined;
  /** M22.2 — positions within the (re-capped) finding set the producer excluded. Re-validated
   *  server-side against the array that actually landed: an ordinal past its end is dropped rather
   *  than trusted, exactly as the findings themselves are re-parsed and re-capped. */
  excludedOrdinals: number[];
} {
  const hasKey = SCAN_FINDINGS_TRANSPORT_KEY in evidence;
  const rawTruncated = evidence[SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY];
  const rawExcluded = evidence[SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY];
  const rest = { ...evidence };
  delete rest[SCAN_FINDINGS_TRANSPORT_KEY];
  delete rest[SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY];
  delete rest[SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY];
  if (!hasKey) return { evidence: rest, capped: undefined, excludedOrdinals: [] };
  const parsed = z.array(ScanFindingSchema).safeParse(evidence[SCAN_FINDINGS_TRANSPORT_KEY]);
  if (!parsed.success) return { evidence: rest, capped: undefined, excludedOrdinals: [] };
  const capped = capScanFindings(parsed.data);
  const excluded = z.array(z.number().int().nonnegative()).safeParse(rawExcluded);
  const excludedOrdinals = excluded.success
    ? [...new Set(excluded.data.filter((o) => o < capped.findings.length))].sort((a, b) => a - b)
    : [];
  return {
    evidence: rest,
    capped: { findings: capped.findings, truncated: capped.truncated || rawTruncated === true },
    excludedOrdinals
  };
}

/** The severity threshold a `scan-result-control` binding applied to reach its verdict — echoed
 *  into evidence so a Decision reconstructs exactly WHICH gate policy authorized (or blocked) the
 *  artifact, not just the raw counts. `maxCritical`/`maxHigh` default to 0 (any is a fail);
 *  `maxMedium`/`maxLow` omitted mean "not thresholded" (unbounded). */
export const ScanThresholdSchema = z.object({
  maxCritical: z.number().int().nonnegative(),
  maxHigh: z.number().int().nonnegative(),
  maxMedium: z.number().int().nonnegative().optional(),
  maxLow: z.number().int().nonnegative().optional()
});
export type ScanThreshold = z.infer<typeof ScanThresholdSchema>;

/** The scan methods the promotion step can actually run. See docs/schemas.md §418. */
export const ScanMethodSchema = z.enum(["trivy", "openscap", "trivy-vm"]);
export type ScanMethod = z.infer<typeof ScanMethodSchema>;

/** The subset of methods that read the vulnerability database. See docs/schemas.md §419. */
export function usesTrivyDb(method: ScanMethod): boolean {
  return method === "trivy" || method === "trivy-vm";
}

// M17.5 — SCOPED SCAN-REQUIREMENT POLICIES. See docs/schemas.md §420.

/** The tiers a scan-requirement floor can be authored at, top-down. See docs/schemas.md §421. */
export const ScanRequirementTierSchema = z.enum([
  "platform",
  "trust_domain",
  "org",
  "containment_domain",
  "service",
  "assembly",
  "component"
]);
export type ScanRequirementTier = z.infer<typeof ScanRequirementTierSchema>;

/** Where an above-org floor row came from: authored locally by this deployment's operator, or
 *  arrived over federation from the commander (DESIGN §13 — "the commander is the source of truth
 *  for global config; outposts hold it read-only"). */
export const ScanFloorOriginSchema = z.enum(["local", "federated"]);
export type ScanFloorOrigin = z.infer<typeof ScanFloorOriginSchema>;

/** A PARTIAL threshold. See docs/schemas.md §422. */
export const PartialScanThresholdSchema = z.object({
  maxCritical: z.number().int().nonnegative().optional(),
  maxHigh: z.number().int().nonnegative().optional(),
  maxMedium: z.number().int().nonnegative().optional(),
  maxLow: z.number().int().nonnegative().optional()
});
export type PartialScanThreshold = z.infer<typeof PartialScanThresholdSchema>;

/** One tier's contribution to the merged floor — carried into the scan evidence so a Decision can
 *  answer "WHICH tier set the ceiling that blocked me?" (charter principle 6). */
export const ScanThresholdContributionSchema = z.object({
  tier: ScanRequirementTierSchema,
  source: z.string(),
  /** For org-and-below contributions, the `object_types.id` of the graph object the contributing
   *  policy matched at — recorded verbatim so the tier mapping is auditable rather than implicit. */
  objectTypeId: z.string().optional(),
  threshold: PartialScanThresholdSchema
});
export type ScanThresholdContribution = z.infer<typeof ScanThresholdContributionSchema>;

/** The gate-resolved threshold, threaded to the control. See docs/schemas.md §423. */
export const EffectiveScanThresholdSchema = z.object({
  threshold: PartialScanThresholdSchema,
  contributors: z.array(ScanThresholdContributionSchema)
});
export type EffectiveScanThreshold = z.infer<typeof EffectiveScanThresholdSchema>;

/** Which of the two ceiling sources supplied the value ACTUALLY applied for one severity. */
export const ScanThresholdSourceSchema = z.enum(["config", "scoped", "default"]);
export type ScanThresholdSource = z.infer<typeof ScanThresholdSourceSchema>;

/** Per-severity provenance of the applied threshold. Only severities the applied threshold actually
 *  carries appear (`maxMedium`/`maxLow` are omitted when unbounded). */
export const ScanThresholdSourceMapSchema = z.object({
  maxCritical: ScanThresholdSourceSchema,
  maxHigh: ScanThresholdSourceSchema,
  maxMedium: ScanThresholdSourceSchema.optional(),
  maxLow: ScanThresholdSourceSchema.optional()
});
export type ScanThresholdSourceMap = z.infer<typeof ScanThresholdSourceMapSchema>;

/** One instance-scoped (above-org) floor row — the API projection of `scan_requirement_floors`
 *  (no `orgId`: it applies to EVERY org on the deployment). */
export const InstanceScanFloorSchema = z.object({
  tier: z.enum(["platform", "trust_domain"]),
  origin: ScanFloorOriginSchema,
  maxCritical: z.number().int().nonnegative().nullable(),
  maxHigh: z.number().int().nonnegative().nullable(),
  maxMedium: z.number().int().nonnegative().nullable(),
  maxLow: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  updatedAt: z.string()
});
export type InstanceScanFloor = z.infer<typeof InstanceScanFloorSchema>;

export const InstanceScanFloorListResponseSchema = z.object({
  items: z.array(InstanceScanFloorSchema)
});
export type InstanceScanFloorListResponse = z.infer<typeof InstanceScanFloorListResponseSchema>;

export const InstanceScanFloorTierParamSchema = z.object({
  tier: z.enum(["platform", "trust_domain"])
});

/** Operator-authored write body. Severities are `null`-able so an operator can explicitly CLEAR a
 *  ceiling (making that severity stop contributing) without deleting the row. */
export const PutInstanceScanFloorRequestSchema = z.object({
  origin: ScanFloorOriginSchema.default("local"),
  maxCritical: z.number().int().nonnegative().nullish(),
  maxHigh: z.number().int().nonnegative().nullish(),
  maxMedium: z.number().int().nonnegative().nullish(),
  maxLow: z.number().int().nonnegative().nullish(),
  note: z.string().max(500).nullish()
});
export type PutInstanceScanFloorRequest = z.infer<typeof PutInstanceScanFloorRequestSchema>;

// M22.2 (ADR-0033 §1–§4) — THE EXCLUSION DIMENSION. See docs/schemas.md §424.

/** The CLASSES of exclusion. See docs/schemas.md §425. */
export const ScanExclusionClassSchema = z.enum([
  /** M22.3 — upstream has shipped no fix at all (`FixedVersion` absent). Pure data over the
   *  retained finding; no join. */
  "no_fix_available",
  /** M22.4 (owner decision D1) — the component is on the latest version of that dependency's major
   *  line. Needs the ADR-0032 dependency inventory. */
  "vendor_latest",
  /** M22.5 (owner decision D2) — the component declared a fact that makes the finding
   *  inapplicable. */
  "declared_fact",
  /** M22.6 (owner decisions D3/D4) — a standing, expiring grant approved at the tier that set the
   *  rule. */
  "approved_override"
]);
export type ScanExclusionClass = z.infer<typeof ScanExclusionClassSchema>;

// M22.5 (owner decision D2) — THE COMPONENT-DECLARED FACT's vocabulary. See docs/schemas.md §426.

/** A declared fact's KEY — `egress`, `data.classification`, `internet_facing`. Lower-case, bounded,
 *  and single-line so it can be rendered in a Decision and in an audit trail without escaping. */
export const ScanDeclarationKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, "declaration key must match /^[a-z][a-z0-9_.-]*$/");

/** A declared fact's VALUE — `none`, `internal-only`, `pci`. Deliberately a STRING and not a union:
 *  the vocabulary is the org's, not this project's, and a closed value enum here would be the
 *  SecOps-authored mapping D2 declined. Bounded and single-line for the same reason the key is. */
export const ScanDeclarationValueSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\r\n\t]+$/, "declaration value must be a single line");

/** ONE exclusion clause. See docs/schemas.md §427. */
export const ScanExclusionClauseSchema = z.strictObject({
  class: ScanExclusionClassSchema,
  vulnerabilityId: z.string().min(1).optional(),
  pkgName: z.string().min(1).optional(),
  /** Exact match on `ScanFinding.purl`, VERBATIM as the scanner emitted it — no normalization here,
   *  matching `ScanFindingSchema.purl`'s own rule that canonicalization belongs at a join where both
   *  sides are visible. */
  purl: z.string().min(1).optional(),
  /** Exact match on `ScanFinding.class` (Trivy `Results[].Class`, e.g. `os-pkgs`/`lang-pkgs`). Named
   *  `findingClass` because `class` is already taken by the clause's own admission class, and one
   *  key meaning two different things is how a provenance label goes quietly false. */
  findingClass: z.string().min(1).optional(),
  /** Which component-declared fact this clause relies on. See docs/schemas.md §428. */
  declaredFact: ScanDeclarationKeySchema.optional(),
  declaredValue: ScanDeclarationValueSchema.optional(),
  /** Free text recorded verbatim in evidence and in the Decision (charter principle 6 — an auditor
   *  reads WHY a finding was tolerated, never just that it was). */
  reason: z.string().max(500).optional()
});
export type ScanExclusionClause = z.infer<typeof ScanExclusionClauseSchema>;

/** The `scanExclusion` POLICY EFFECT. See docs/schemas.md §429. */
export const ScanExclusionEffectSchema = z.strictObject({
  admit: z.array(ScanExclusionClassSchema).optional(),
  exclude: ScanExclusionClauseSchema.optional()
});
export type ScanExclusionEffect = z.infer<typeof ScanExclusionEffectSchema>;

/** A clause that survived, with the tiers that admitted it. See docs/schemas.md §430. */
export const AdmittedScanExclusionClauseSchema = z.object({
  clause: ScanExclusionClauseSchema,
  tier: ScanRequirementTierSchema,
  source: z.string(),
  /** Every tier above that admitted this clause's class, with the statement that did it. */
  admittedBy: z.array(z.object({ tier: ScanRequirementTierSchema, source: z.string() }))
});
export type AdmittedScanExclusionClause = z.infer<typeof AdmittedScanExclusionClauseSchema>;

// M22.8 — THE READ SURFACE'S WIRE CONTRACT. See docs/schemas.md §431.

/** One exclusion class, and where a clause would take effect. See docs/schemas.md §432. */
export const ScanExclusionAdmittedClassSchema = z.object({
  class: ScanExclusionClassSchema,
  /** Every admission statement for this class, from any represented tier, content-sorted. */
  admittedBy: z.array(z.object({ tier: ScanRequirementTierSchema, source: z.string() })),
  /** The tiers at which a clause of this class would survive the AND, top-down. May be empty. */
  effectiveAtTiers: z.array(ScanRequirementTierSchema)
});
export type ScanExclusionAdmittedClass = z.infer<typeof ScanExclusionAdmittedClassSchema>;

/** A contributing policy this route did not evaluate, named. See docs/schemas.md §433. */
export const UnevaluatedScanPolicyConditionSchema = z.object({
  policyObjectId: z.string().uuid(),
  policyVersion: z.number().int().nonnegative(),
  name: z.string(),
  condition: z.string()
});
export type UnevaluatedScanPolicyCondition = z.infer<typeof UnevaluatedScanPolicyConditionSchema>;

/** What scan rules are in force for this component. See docs/schemas.md §434. */
export const ComponentScanRequirementsResponseSchema = z.object({
  componentId: z.string().uuid(),
  componentUrn: z.string(),
  /** The rungs of the six-tier chain that EXIST for this component (`platform` and `trust_domain`
   *  always; the rest from its containment chain). A rung that does not exist is never asked to
   *  admit anything — ADR-0033 §1, and the reason the AND is not vacuous in either direction. */
  representedTiers: z.array(ScanRequirementTierSchema),
  /** The resolved per-severity ceiling and every tier that contributed to it. `null` when NO tier
   *  contributes a ceiling at all — the scan control then falls back to its own per-binding
   *  `config.threshold` (the unchanged M17.1 behaviour), which this route cannot see. */
  threshold: EffectiveScanThresholdSchema.nullable(),
  /** Which exclusion classes are admitted, and where a clause of each would have effect. */
  admittedExclusionClasses: z.array(ScanExclusionAdmittedClassSchema),
  /** The exclusion clauses that survive for this component. See docs/schemas.md §435. */
  exclusionClauses: z.array(AdmittedScanExclusionClauseSchema),
  /** Every contributor carrying a CEL condition, which this route did not evaluate. */
  unevaluatedConditions: z.array(UnevaluatedScanPolicyConditionSchema)
});
export type ComponentScanRequirementsResponse = z.infer<
  typeof ComponentScanRequirementsResponseSchema
>;

// M22.9 — THE INSTANCE ADMISSION *WRITE* SURFACE'S WIRE CONTRACT. See docs/schemas.md §436.

/** One instance-scoped admission row. See docs/schemas.md §437. */
export const InstanceScanExclusionAdmissionSchema = z.object({
  tier: z.enum(["platform", "trust_domain"]),
  class: ScanExclusionClassSchema,
  origin: ScanFloorOriginSchema,
  note: z.string().nullable(),
  updatedAt: z.string()
});
export type InstanceScanExclusionAdmission = z.infer<typeof InstanceScanExclusionAdmissionSchema>;

export const InstanceScanExclusionAdmissionListResponseSchema = z.object({
  items: z.array(InstanceScanExclusionAdmissionSchema)
});
export type InstanceScanExclusionAdmissionListResponse = z.infer<
  typeof InstanceScanExclusionAdmissionListResponseSchema
>;

export const InstanceScanExclusionAdmissionTierParamSchema = z.object({
  tier: z.enum(["platform", "trust_domain"])
});

/** Operator-authored write body. See docs/schemas.md §438. */
export const PutInstanceScanExclusionAdmissionsRequestSchema = z.strictObject({
  origin: ScanFloorOriginSchema.default("local"),
  classes: z.array(ScanExclusionClassSchema).max(16),
  note: z.string().max(500).nullish()
});
export type PutInstanceScanExclusionAdmissionsRequest = z.infer<
  typeof PutInstanceScanExclusionAdmissionsRequestSchema
>;

// M22.4 (ADR-0033 D1) — THE VENDOR RULE'S FACTS. See docs/schemas.md §439.

/** The identity of one at-head line, canonicalised once. See docs/schemas.md §440. */
export function vendorLatestPackageKey(
  ecosystem: DependencyEcosystem,
  coordinate: string,
  version: string
): string {
  const canonical =
    ecosystem === "python" ? coordinate.toLowerCase().replace(/[-_.]+/g, "-") : coordinate;
  return `${ecosystem}|${canonical}|${version}`;
}

/** purl `type` → this project's `DependencyEcosystem`. See docs/schemas.md §441. */
const PURL_TYPE_TO_ECOSYSTEM: Readonly<Record<string, DependencyEcosystem>> = {
  npm: "npm",
  golang: "go",
  maven: "maven",
  pypi: "python"
};

/** Read the ecosystem out of a purl's `type` segment — `pkg:npm/lodash@4.17.21` → `npm`. Total: any
 *  string that is not a purl of a known LANGUAGE type yields `undefined`. */
export function purlEcosystem(purl: string | undefined): DependencyEcosystem | undefined {
  if (!purl) return undefined;
  const match = /^pkg:([^/@?#]+)\//.exec(purl);
  const type = match?.[1]?.toLowerCase();
  if (type === undefined) return undefined;
  return PURL_TYPE_TO_ECOSYSTEM[type];
}

/** What the server resolved about this target's inventory. See docs/schemas.md §442. */
export const ScanVendorLatestFactsSchema = z.object({
  /** True when every declared base-image line is at head. See docs/schemas.md §443. */
  baseImageAtLatest: z.boolean(),
  /** {@link vendorLatestPackageKey} for every DECLARED LANGUAGE line this target is at the head of.
   *  Sorted, so two identical resolutions serialize identically — the M22.0 write-suppression rule
   *  reaches this array through the gate Decision's `inputContext`. */
  packageKeys: z.array(z.string())
});
export type ScanVendorLatestFacts = z.infer<typeof ScanVendorLatestFactsSchema>;

// M22.5 (owner decision D2) — WHAT THE COMPONENT DECLARED, and the write door that bounds it.

/** The `component.properties` key the declarations live under. ONE constant, because the migration's
 *  JSON Schema, the request-body validator and the gate-time reader must name the same key — three
 *  string literals is how one of them silently stops being read. */
export const COMPONENT_SECURITY_PROPERTY_KEY = "security";

/** How many declarations one component may carry. They all reach the gate Decision's `inputContext`
 *  verbatim, so the set is countable by construction rather than by hoping nobody writes a thousand. */
export const COMPONENT_SECURITY_DECLARATIONS_CAP = 32;

/** THE REQUEST-BODY VALIDATOR. See docs/schemas.md §444. */
export const ComponentSecurityPropertySchema = z.strictObject({
  declarations: z
    .record(ScanDeclarationKeySchema, ScanDeclarationValueSchema)
    .refine((d) => Object.keys(d).length <= COMPONENT_SECURITY_DECLARATIONS_CAP, {
      message: `at most ${COMPONENT_SECURITY_DECLARATIONS_CAP} declarations`
    })
});
export type ComponentSecurityProperty = z.infer<typeof ComponentSecurityPropertySchema>;

/** What the targets declared, as the gate resolved it. See docs/schemas.md §445. */
export const ScanDeclaredFactsSchema = z.object({
  declarations: z.array(
    z.object({ key: ScanDeclarationKeySchema, value: ScanDeclarationValueSchema })
  )
});
export type ScanDeclaredFacts = z.infer<typeof ScanDeclaredFactsSchema>;

// M22.6 (owner decisions D3/D4) — THE APPROVED OVERRIDE, as the gate resolved it.

/** One standing grant, already approved and unexpired. See docs/schemas.md §446. */
export const ScanOverrideGrantFactSchema = z.object({
  /** The grant's graph object id — what an auditor resolves to read the whole act. */
  grantObjectId: z.string(),
  /** REQUIRED. D4's unit is (component × finding), and a grant naming no finding would be a blanket
   *  waiver on a component — precisely the coarse shape ADR-0033 §2 rejected. */
  vulnerabilityId: z.string(),
  /** Optional NARROWING: the same CVE in a different package is a different exposure. */
  pkgName: z.string().optional(),
  /** The object naming the tier that set the rule — the authority this grant was approved under
   *  (D3). */
  tierObjectId: z.string(),
  /** The tier of that object, derived at resolve time. See docs/schemas.md §447. */
  tier: ScanRequirementTierSchema,
  expiresAt: z.string()
});
export type ScanOverrideGrantFact = z.infer<typeof ScanOverrideGrantFactSchema>;

/** A grant as the ROW says it is, before the authority bar has been applied — the resolver's
 *  intermediate shape. It has no `tier` because a tier is a property of the target's containment
 *  chain, not of the stored row. */
export type ScanOverrideGrantCandidate = Omit<ScanOverrideGrantFact, "tier">;

/** One grant that was live and in date but did NOT clear the authority bar, recorded so the refusal
 *  is a positive statement in the Decision rather than a silent absence (charter principle 6). */
export const RefusedScanOverrideGrantSchema = z.object({
  grantObjectId: z.string(),
  /** Absent when `tierObjectId` is not on the target's containment chain at all — the grant names an
   *  authority that has no standing over this component whatsoever. */
  tier: ScanRequirementTierSchema.optional(),
  reason: z.enum(["tier_not_on_containment_chain", "tier_below_required"])
});
export type RefusedScanOverrideGrant = z.infer<typeof RefusedScanOverrideGrantSchema>;

export const ScanApprovedOverridesSchema = z.object({
  grants: z.array(ScanOverrideGrantFactSchema),
  /** THE DERIVED BAR. See docs/schemas.md §448. */
  requiredTier: ScanRequirementTierSchema.optional(),
  /** Live, in-date grants the bar refused. Sorted by `grantObjectId`, content-only — no timestamps,
   *  so two identical evaluations still serialize identically (the M22.0 write-suppression rule). */
  refusedForAuthority: z.array(RefusedScanOverrideGrantSchema).optional()
});
export type ScanApprovedOverrides = z.infer<typeof ScanApprovedOverridesSchema>;

// The override request as a GRAPH OBJECT (charter principle 2) and its API surface.

/** The registered `object_types.id`. ONE constant: the migration, the governance-managed set, the
 *  repo and the resolver must all name the same type, and four string literals is how one of them
 *  quietly stops being reached. */
export const SCAN_OVERRIDE_GRANT_TYPE_ID = "scan_override_grant";

/** A grant's lifecycle, held in `properties.status`. See docs/schemas.md §449. */
export const ScanOverrideGrantStatusSchema = z.enum(["requested", "approved", "denied", "revoked"]);
export type ScanOverrideGrantStatus = z.infer<typeof ScanOverrideGrantStatusSchema>;

export const ScanOverrideGrantSchema = z.object({
  id: z.string(),
  urn: z.string(),
  name: z.string(),
  status: ScanOverrideGrantStatusSchema,
  componentId: z.string(),
  vulnerabilityId: z.string(),
  pkgName: z.string().nullable(),
  tierObjectId: z.string(),
  reason: z.string(),
  expiresAt: z.string().nullable(),
  decidedByActorId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  requestedByActorId: z.string(),
  createdAt: z.string()
});
export type ScanOverrideGrant = z.infer<typeof ScanOverrideGrantSchema>;

export const ScanOverrideGrantListResponseSchema = z.object({
  items: z.array(ScanOverrideGrantSchema)
});

export const ScanOverrideGrantIdParamSchema = z.object({ id: z.string() });

/** Listing is COMPONENT-SCOPED and the component is REQUIRED. An unscoped list of "every accepted
 *  risk in this org" is a map of deliberately-tolerated weaknesses, and handing one out to any holder
 *  of `object:read` at the org root is a wider disclosure than the read that authorized it. */
export const ScanOverrideGrantListQuerySchema = z.object({
  component: z.string().min(1)
});

/** RAISING a request. See docs/schemas.md §450. */
export const CreateScanOverrideGrantRequestSchema = z.strictObject({
  componentId: z.string().min(1),
  vulnerabilityId: z.string().min(1).max(200),
  pkgName: z.string().min(1).max(200).optional(),
  tierObjectId: z.string().min(1),
  /** MANDATORY and non-empty — the `freeze.override` shape (DESIGN §10.3), never the approvals
   *  shape. */
  reason: z.string().min(1).max(500)
});
export type CreateScanOverrideGrantRequest = z.infer<typeof CreateScanOverrideGrantRequestSchema>;

/** APPROVING. `expiresAt` is REQUIRED: D4's grant is standing *with an expiry*, and a grant with no
 *  expiry is the permanent blanket waiver the decision explicitly did not take. */
export const ApproveScanOverrideGrantRequestSchema = z.strictObject({
  expiresAt: z.string().datetime(),
  reason: z.string().min(1).max(500)
});
export type ApproveScanOverrideGrantRequest = z.infer<typeof ApproveScanOverrideGrantRequestSchema>;

/** DENYING or REVOKING — one shape, because both are the same act on the authority side and both
 *  need the same mandatory reason. */
export const DecideScanOverrideGrantRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500)
});
export type DecideScanOverrideGrantRequest = z.infer<typeof DecideScanOverrideGrantRequestSchema>;

/** The gate-resolved exclusion set, threaded to `scan-result-control` on the control-run CONTEXT
 *  (`context.scanExclusions`) — the SAME conditional-context mechanism that already carries
 *  `artifactDigest` and `scanThreshold`. A plugin has no database and no lookup ability, so every
 *  exclusion FACT is resolved server-side and serialized here. */
export const EffectiveScanExclusionsSchema = z.object({
  clauses: z.array(AdmittedScanExclusionClauseSchema),
  /** M22.4 — resolved ONLY when a `vendor_latest` clause actually survived the AND, so a deployment
   *  that authored no such clause pays no inventory query and writes no extra key. */
  vendorLatest: ScanVendorLatestFactsSchema.optional(),
  /** M22.5 — same conditional resolution, same reason: no `declared_fact` clause, no property read. */
  declaredFacts: ScanDeclaredFactsSchema.optional(),
  /** M22.6 — same again: no `approved_override` clause, no grant query. */
  approvedOverrides: ScanApprovedOverridesSchema.optional()
});
export type EffectiveScanExclusions = z.infer<typeof EffectiveScanExclusionsSchema>;

/** WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED. See docs/schemas.md §451. */
export const ScanExclusionRefusalSchema = z.enum(["truncated", "unsupported", "not_recorded"]);
export type ScanExclusionRefusal = z.infer<typeof ScanExclusionRefusalSchema>;

/** How many APPLIED exclusions are enumerated in evidence. `control_runs.evidence` is copied
 *  VERBATIM into every signed promotion bundle (`federation/promotion-repo.ts`), so the enumeration
 *  is bounded while `appliedCount` stays exact. */
export const SCAN_EXCLUSION_EVIDENCE_CAP = 100;

/** ONE applied exclusion, as it appears in evidence and in the Decision. */
export const AppliedScanExclusionSchema = z.object({
  /** Position of the excluded finding within the PERSISTED set — the `scan_findings.ordinal` of the
   *  row this decision is about, so evidence and table join without a second identity. */
  ordinal: z.number().int().nonnegative(),
  severity: z.enum(COUNTED_SEVERITIES),
  class: ScanExclusionClassSchema,
  /** The tier the clause was anchored at, and the policy that authored it. */
  tier: ScanRequirementTierSchema,
  source: z.string(),
  vulnerabilityId: z.string().optional(),
  pkgName: z.string().optional(),
  reason: z.string().optional(),
  /** M22.5 (ADR-0033 §6 guard 2) — the declaration this exclusion rested on, VERBATIM. An auditor
   *  reads *"passed because component X asserted `egress: none` under admission Y"*; a Decision that
   *  said only "declared_fact" would be the coarse waiver §2 rejected wearing a class name. */
  declaredFact: z.string().optional(),
  declaredValue: z.string().optional(),
  /** M22.6 (ADR-0033 §11) — the grant, its authority and its expiry: "under whose authority, until
   *  when". */
  grantObjectId: z.string().optional(),
  grantTierObjectId: z.string().optional(),
  grantExpiresAt: z.string().optional()
});
export type AppliedScanExclusion = z.infer<typeof AppliedScanExclusionSchema>;

export const ScanExclusionEvidenceSchema = z.object({
  /** How many clauses the gate resolved as admitted for this change's targets. */
  clauseCount: z.number().int().nonnegative(),
  /** How many findings were actually excluded — EXACT, even when `applied` below is capped. */
  appliedCount: z.number().int().nonnegative(),
  applied: z.array(AppliedScanExclusionSchema),
  /** Present iff admitted clauses existed and NONE could be applied, with the reason. */
  refused: ScanExclusionRefusalSchema.optional()
});
export type ScanExclusionEvidence = z.infer<typeof ScanExclusionEvidenceSchema>;

/** THE CLASS'S OWN PREDICATE. See docs/schemas.md §452. */
function scanExclusionClassPredicate(
  clause: ScanExclusionClause,
  facts: ScanExclusionFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  switch (clause.class) {
    case "no_fix_available":
      // Pure data over the retained fields, with no join. See docs/schemas.md §453.
      return (finding) => finding.fixedVersion === undefined;
    case "vendor_latest":
      return vendorLatestPredicate(facts?.vendorLatest);
    case "declared_fact":
      return declaredFactPredicate(clause, facts?.declaredFacts);
    case "approved_override":
      return approvedOverridePredicate(facts?.approvedOverrides);
  }
}

/** The component declared a fact making this inapplicable. See docs/schemas.md §454. */
function declaredFactPredicate(
  clause: ScanExclusionClause,
  facts: ScanDeclaredFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (clause.declaredFact === undefined || clause.declaredValue === undefined) return undefined;
  if (!scanExclusionClauseIsNarrowed(clause)) return undefined;
  if (!facts) return undefined;
  const declared = facts.declarations.some(
    (d) => d.key === clause.declaredFact && d.value === clause.declaredValue
  );
  if (!declared) return undefined;
  return () => true;
}

/** Does this clause narrow which findings it reaches. See docs/schemas.md §455. */
export function scanExclusionClauseIsNarrowed(clause: ScanExclusionClause): boolean {
  return (
    clause.vulnerabilityId !== undefined ||
    clause.pkgName !== undefined ||
    clause.purl !== undefined ||
    clause.findingClass !== undefined
  );
}

/** An override was raised and approved at the required tier. See docs/schemas.md §456. */
function approvedOverridePredicate(
  facts: ScanApprovedOverrides | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (!facts || facts.grants.length === 0) return undefined;
  return (finding) => scanOverrideGrantFor(facts, finding) !== undefined;
}

/** WHICH grant excuses this finding. See docs/schemas.md §457. */
export function scanOverrideGrantFor(
  facts: ScanApprovedOverrides | undefined,
  finding: ScanFinding
): ScanOverrideGrantFact | undefined {
  if (!facts) return undefined;
  return facts.grants.find((g) => {
    // A finding with NO `VulnerabilityID` can never be excused: a grant is per (component × finding)
    // and an unidentifiable finding is not a finding anyone approved. `undefined !== "CVE-…"` already
    // says so; it is spelled out because this is the one comparison whose failure would be silent.
    if (finding.vulnerabilityId !== g.vulnerabilityId) return false;
    if (g.pkgName !== undefined && finding.pkgName !== g.pkgName) return false;
    return true;
  });
}

/** We are on the latest version of this major line. See docs/schemas.md §458. */
function vendorLatestPredicate(
  facts: ScanVendorLatestFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (!facts) return undefined;
  const keys = new Set(facts.packageKeys);
  return (finding) => {
    // NO `fixedVersion` BACKSTOP HERE, AND THAT IS A DECISION. See docs/schemas.md §459.
    if (finding.class === "os-pkgs") return facts.baseImageAtLatest;
    if (finding.class !== "lang-pkgs") {
      // An UNRECOGNISED or ABSENT `Class` attributes to nothing. Trivy emits other classes
      // (`license`, `secret`, `config`) and a finding with no class at all is retained by
      // `parseTrivyFindings` on its severity alone. None of them names a dependency line, and
      // guessing one is the inversion this feature may not make.
      return false;
    }
    // A LANGUAGE PACKAGE → ITS OWN DECLARED LINE. See docs/schemas.md §460.
    const ecosystem = purlEcosystem(finding.purl);
    if (ecosystem === undefined || finding.pkgName === undefined) return false;
    // NO `InstalledVersion` ⇒ NO PASS. See docs/schemas.md §461.
    if (finding.installedVersion === undefined) return false;
    // A TRANSITIVE dependency has no declared line, so its key is simply not in the set and it does
    // not qualify. Neither does a DECLARED package at a version this artifact does not actually ship
    // — same mechanism, one key lookup, no second branch (ADR-0033: a transitive is fixed by moving
    // the direct parent that pulls it).
    return keys.has(vendorLatestPackageKey(ecosystem, finding.pkgName, finding.installedVersion));
  };
}

/** The server-resolved facts a class predicate may consult. Structurally the exclusion set minus its
 *  clauses, so `applyScanExclusions` can hand the whole resolved object down without the pure
 *  matcher needing to know how it was assembled. */
export type ScanExclusionFacts = Pick<
  EffectiveScanExclusions,
  "vendorLatest" | "declaredFacts" | "approvedOverrides"
>;

/** Whether a clause reaches a finding: the class's own predicate AND every present matcher. A
 *  finding lacking a field the clause names never matches — `undefined !== "openssl"`. */
export function scanExclusionClauseMatches(
  clause: ScanExclusionClause,
  finding: ScanFinding,
  facts?: ScanExclusionFacts
): boolean {
  const predicate = scanExclusionClassPredicate(clause, facts);
  if (!predicate) return false;
  if (!predicate(finding)) return false;
  if (clause.vulnerabilityId !== undefined && finding.vulnerabilityId !== clause.vulnerabilityId)
    return false;
  if (clause.pkgName !== undefined && finding.pkgName !== clause.pkgName) return false;
  if (clause.purl !== undefined && finding.purl !== clause.purl) return false;
  if (clause.findingClass !== undefined && finding.class !== clause.findingClass) return false;
  return true;
}

export interface AppliedScanExclusions {
  /** The findings that SURVIVE — what the threshold comparison counts. */
  findings: ScanFinding[];
  /** Ordinals (positions in the input array) that were excluded, ascending. This is what promotes a
   *  `scan_findings` row from retention class `O` to `E`: an excluded finding is accepted-risk
   *  evidence explaining a live verdict (ADR-0024 §D1 per-row assignment, ADR-0033 D10). */
  excludedOrdinals: number[];
  /** The evidence projection — exact counts, bounded enumeration. `undefined` when the gate
   *  resolved NO clauses at all, so a deployment with nothing authored writes byte-identical
   *  evidence to pre-M22. */
  evidence: ScanExclusionEvidence | undefined;
}

/** APPLY the resolved clauses to a scan's findings. See docs/schemas.md §462. */
export function applyScanExclusions(
  findings: readonly ScanFinding[],
  effective: EffectiveScanExclusions | undefined,
  record: ScanFindingsRecord | undefined
): AppliedScanExclusions {
  const clauses = effective?.clauses ?? [];
  if (clauses.length === 0) {
    return { findings: [...findings], excludedOrdinals: [], evidence: undefined };
  }
  if (record !== "full") {
    const refused: ScanExclusionRefusal =
      record === "truncated"
        ? "truncated"
        : record === "unsupported"
          ? "unsupported"
          : "not_recorded";
    return {
      findings: [...findings],
      excludedOrdinals: [],
      evidence: { clauseCount: clauses.length, appliedCount: 0, applied: [], refused }
    };
  }

  const survivors: ScanFinding[] = [];
  const excludedOrdinals: number[] = [];
  const applied: AppliedScanExclusion[] = [];
  for (const [ordinal, finding] of findings.entries()) {
    const hit = clauses.find((c) => scanExclusionClauseMatches(c.clause, finding, effective));
    if (!hit) {
      survivors.push(finding);
      continue;
    }
    excludedOrdinals.push(ordinal);
    if (applied.length < SCAN_EXCLUSION_EVIDENCE_CAP) {
      // M22.6 — resolved through the SAME function the predicate used, so evidence can never name a
      // grant other than the one that actually decided this finding.
      const grant =
        hit.clause.class === "approved_override"
          ? scanOverrideGrantFor(effective?.approvedOverrides, finding)
          : undefined;
      applied.push({
        ordinal,
        severity: finding.severity,
        class: hit.clause.class,
        tier: hit.tier,
        source: hit.source,
        ...(finding.vulnerabilityId ? { vulnerabilityId: finding.vulnerabilityId } : {}),
        ...(finding.pkgName ? { pkgName: finding.pkgName } : {}),
        ...(hit.clause.reason ? { reason: hit.clause.reason } : {}),
        // M22.5 — the declared pair, verbatim. Taken from the CLAUSE rather than re-read from the
        // facts because the predicate already proved the two equal; the whole declared set travels
        // separately into the gate Decision's `inputContext`.
        ...(hit.clause.class === "declared_fact" && hit.clause.declaredFact !== undefined
          ? { declaredFact: hit.clause.declaredFact }
          : {}),
        ...(hit.clause.class === "declared_fact" && hit.clause.declaredValue !== undefined
          ? { declaredValue: hit.clause.declaredValue }
          : {}),
        ...(grant
          ? {
              grantObjectId: grant.grantObjectId,
              grantTierObjectId: grant.tierObjectId,
              grantExpiresAt: grant.expiresAt
            }
          : {})
      });
    }
  }
  return {
    findings: survivors,
    excludedOrdinals,
    evidence: {
      clauseCount: clauses.length,
      appliedCount: excludedOrdinals.length,
      applied
    }
  };
}

/** The post-exclusion counts, derived from what was produced. See docs/schemas.md §463. */
export function effectiveSeverityCountsAfterExclusions(
  counts: ScanSeverityCounts,
  applied: AppliedScanExclusions,
  findings: readonly ScanFinding[]
): ScanSeverityCounts {
  const out = { ...counts };
  for (const ordinal of applied.excludedOrdinals) {
    const finding = findings[ordinal];
    if (!finding) continue;
    out[finding.severity] = Math.max(0, out[finding.severity] - 1);
  }
  return out;
}

/** The full evidence payload a scan outcome carries. See docs/schemas.md §464. */
export const ScanEvidenceSchema = z.object({
  /** WHICH scan method produced this verdict. See docs/schemas.md §465. */
  scanner: ScanMethodSchema,
  /** Trivy's own reported version (result JSON, best-effort) — `"unknown"` when the result omits it. */
  scannerVersion: z.string(),
  /** The artifact digest Trivy actually scanned, normalized to `sha256:<hex>` where derivable from
   *  the Trivy result's `Metadata.RepoDigests`/`Metadata.ImageID`; otherwise the raw reported ref. */
  artifactDigest: z.string(),
  /** The digest the change is promoting — the value `artifactDigest` was bound against. */
  expectedDigest: z.string(),
  /** True iff `artifactDigest` matches `expectedDigest` (the digest-binding guard). A `false` here
   *  is by itself sufficient for a `fail` outcome regardless of the vulnerability counts. */
  digestMatch: z.boolean(),
  severityCounts: ScanSeverityCountsSchema,
  /** What the persisted finding set is for this verdict. See docs/schemas.md §466. */
  findingsRecord: ScanFindingsRecordSchema.optional(),
  /** The counts the threshold was actually compared against. See docs/schemas.md §467. */
  effectiveSeverityCounts: ScanSeverityCountsSchema.optional(),
  /** M22.2 — WHICH findings were excluded, under whose clause and at which tier — or the positive
   *  reason every exclusion was refused. Same absent-when-nothing-authored rule as above. */
  exclusions: ScanExclusionEvidenceSchema.optional(),
  /** M22.7 (ADR-0033 §10) — THE ACTUATOR'S HANDLE. See docs/schemas.md §468. */
  exclusionSetHash: z.string().optional(),
  /** The threshold ACTUALLY applied to reach this verdict (post-merge). */
  threshold: ScanThresholdSchema,
  /** Where the applied ceilings came from, per severity. See docs/schemas.md §469. */
  thresholdSources: ScanThresholdSourceMapSchema.optional(),
  /** Summary of `thresholdSources`. See docs/schemas.md §470. */
  thresholdSource: z.enum(["config", "scoped", "mixed", "default"]).optional(),
  /** M17.5 — every tier that contributed a ceiling to the merged threshold, so a blocked promotion's
   *  Decision can explain WHICH tier set the binding severity floor (charter principle 6). */
  thresholdContributors: z.array(ScanThresholdContributionSchema).optional(),
  /** Provenance and freshness of the scanner database used. See docs/schemas.md §471. */
  scanDbSource: ScanDbSourceSchema.optional(),
  scanDbAgeHours: z.number().nonnegative().optional(),
  scanDbStaleness: ScanDbStalenessClassSchema.optional(),
  scanDbThresholdFired: ScanDbThresholdFiredSchema.optional()
});
export type ScanEvidence = z.infer<typeof ScanEvidenceSchema>;

// M17.2 — BUILD-TIME SBOM, stored as a REFERENCE on the promotion. See docs/schemas.md §472.

/** Reduce any digest reference to its bare lowercase sha256 hex — from `…@sha256:<hex>`,
 *  `sha256:<hex>`, or a bare 64-hex string. Returns `undefined` for anything without a sha256
 *  digest. Deliberately the SAME normalization `scan-result-control` applies to a Trivy result's
 *  digest, so an SBOM reference and a scan verdict for the SAME artifact compare equal. */
export function sbomDigestHex(ref: string): string | undefined {
  const prefixed = /sha256:([a-f0-9]{64})/i.exec(ref);
  if (prefixed?.[1]) return prefixed[1].toLowerCase();
  const bare = /^[a-f0-9]{64}$/i.exec(ref.trim());
  return bare ? bare[0].toLowerCase() : undefined;
}

/** Canonical `sha256:<lowercase-hex>` form of any accepted digest reference — `undefined` when the
 *  input carries no sha256 digest. Applied when the reference is LIFTED onto the change's canonical
 *  `sourceRef.sbom`, so what is persisted is always comparable byte-for-byte. */
export function normalizeSbomDigest(ref: string): string | undefined {
  const hex = sbomDigestHex(ref);
  return hex ? `sha256:${hex}` : undefined;
}

/** The same canonical digest form the normaliser produces. See docs/schemas.md §473. */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "digest must be canonical sha256:<64-lowercase-hex>");

/** The test bundle (D23, §14 resolution 9). See docs/schemas.md §474. */
export const TestBundleRefSchema = z.object({
  /** OCI repository path within the domain's own registry (ADR-0012). The DOMAIN-LOCAL copy is
   *  what runs; replication is the byte channel's job, not this reference's. */
  repository: z.string().min(1),
  digest: Sha256DigestSchema
});
export type TestBundleRef = z.infer<typeof TestBundleRefSchema>;

/** A REFERENCE to a build-time SBOM. See docs/schemas.md §475. */
export const SbomRefSchema = z.strictObject({
  /** SBOM document format. Two, because these are the two cosign/Trivy actually emit. */
  format: z.enum(["cyclonedx", "spdx"]),
  /** The format's spec version as the producer reported it (e.g. `"1.5"`, `"SPDX-2.3"`). */
  specVersion: z.string().optional(),
  /** The SBOM DOCUMENT's content digest. Accepts `sha256:<hex>`, a bare 64-hex string, or a
   *  `<ref>@sha256:<hex>` form; normalized to `sha256:<lowercase-hex>` when persisted. */
  digest: z.string().refine((v) => sbomDigestHex(v) !== undefined, {
    message:
      "digest must carry a sha256 digest (sha256:<64-hex>, <ref>@sha256:<64-hex>, or bare 64-hex)"
  }),
  /** WHERE the document lives — an OCI referrer ref, registry URL, or artifact-store URI. SCP stores
   *  the string and never fetches it as part of persisting the reference. */
  location: z.string().min(1),
  mediaType: z.string().optional(),
  /** The EXECUTOR's ORIGIN cosign signature over the SBOM (a `.sig` ref / OCI referrer / Rekor
   *  entry). SCP NEVER signs the SBOM — it records which origin attestation exists so a downstream
   *  (air-gapped) verifier can check it against the producing domain's key. */
  signatureRef: z.string().optional(),
  /** WHICH external tool produced the SBOM (e.g. `"trivy"`). Not a claim SCP produced it. */
  scanner: z.string().optional(),
  scannerVersion: z.string().optional(),
  /** When the producer emitted it (ISO-8601), as reported by the producer. */
  generatedAt: z.string().optional()
});
export type SbomRef = z.infer<typeof SbomRefSchema>;

import { z } from "zod";

/**
 * Supply-chain governance evidence (DESIGN §10, ADR-0013 "scan as a boundary-authorization gate",
 * BUILD_AND_TEST.md §8 M17). This file carries the TYPED shape of a `ControlOutcome.evidence`
 * payload for a coordinated Trivy scan verdict — the M17.1 `scan-result-control` ControlPlugin
 * produces it, and it is persisted verbatim on the `control_runs.evidence` column (free-form
 * `z.record` at the storage layer — `ControlRunSchema` in governance.ts).
 *
 * Why a typed schema for something the DB stores as free-form JSON: today a control's evidence is
 * an opaque bag, so a policy's CEL condition has no typed field to threshold on. Pinning the scan
 * verdict's shape here gives policy authors stable, documented fields — `evidence.severityCounts.critical`,
 * `evidence.artifactDigest`, `evidence.digestMatch` — to write conditions against, and gives the
 * plugin a single source of truth it validates its own output against (scan-result-control parses
 * its evidence through `ScanEvidenceSchema` before returning it, so a shape regression fails the
 * plugin's own tests rather than silently shipping malformed evidence into a Decision).
 *
 * CHARTER — coordinate, not execute: SCP NEVER runs Trivy. This evidence is the shape of a verdict
 * SCP *consumes* from a scan an execution system already ran (Argo Workflows Trivy step, ADR-0012);
 * `scanner`/`scannerVersion` record WHICH external scanner produced it, they are not a claim SCP
 * scanned anything.
 */

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


// ===========================================================================================
// M17.5 — SCOPED SCAN-REQUIREMENT POLICIES (ADR-0016), most-restrictive-wins over six tiers.
//
//   platform -> trust domain (partition) -> org -> containment domain -> service -> component
//
// The effective threshold is the per-severity MIN of `maxCritical`/`maxHigh`/`maxMedium`/`maxLow`
// across every APPLICABLE tier: a child may only TIGHTEN, never loosen. MIN over a set is
// commutative and associative, so resolution is ORDER-INDEPENDENT by construction — which is
// exactly why the documented containment-domain-vs-service ordering tie
// (`graph/containment.ts:60-73`) is harmless here and why most-restrictive-wins was the safe
// choice rather than "most specific wins" override semantics (ADR-0016 §4).
//
// TWO SENSES OF "DOMAIN", never conflated (ADR-0016 terminology section): `trust_domain` is the
// ambient federation boundary (a partition) ABOVE org; `containment_domain` is the intra-org
// `domain` OBJECT TYPE BELOW org. The stored/emitted literal is `trust_domain` — never bare
// `domain`.
// ===========================================================================================

/** The six tiers a scan-requirement floor can be authored at, top-down. */
export const ScanRequirementTierSchema = z.enum([
  "platform",
  "trust_domain",
  "org",
  "containment_domain",
  "service",
  "component"
]);
export type ScanRequirementTier = z.infer<typeof ScanRequirementTierSchema>;

/** Where an above-org floor row came from: authored locally by this deployment's operator, or
 *  arrived over federation from the commander (DESIGN §13 — "the commander is the source of truth
 *  for global config; outposts hold it read-only"). */
export const ScanFloorOriginSchema = z.enum(["local", "federated"]);
export type ScanFloorOrigin = z.infer<typeof ScanFloorOriginSchema>;

/**
 * A PARTIAL threshold — every severity independently optional. An absent severity means this tier
 * SETS NO CEILING for it and therefore does NOT contribute to the MIN: "no floor" is never read as
 * `0` (which would be the tightest possible ceiling and would silently block everything).
 */
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
  /** Human-legible origin of this contribution: `instance:platform:local`,
   *  `policy:<name>@<objectId>`, … */
  source: z.string(),
  /** For org-and-below contributions, the `object_types.id` of the graph object the contributing
   *  policy matched at — recorded verbatim so the tier mapping is auditable rather than implicit. */
  objectTypeId: z.string().optional(),
  threshold: PartialScanThresholdSchema
});
export type ScanThresholdContribution = z.infer<typeof ScanThresholdContributionSchema>;

/**
 * The gate-resolved effective threshold, threaded to `scan-result-control` on the control-run
 * CONTEXT (`context.scanThreshold`) — reusing the shipped M17.1 `context.artifactDigest` threading
 * pattern (ADR-0016 §4 design A, gate-orchestrator.ts `buildControlContext`).
 */
export const EffectiveScanThresholdSchema = z.object({
  threshold: PartialScanThresholdSchema,
  contributors: z.array(ScanThresholdContributionSchema)
});
export type EffectiveScanThreshold = z.infer<typeof EffectiveScanThresholdSchema>;

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

/**
 * The full evidence payload a `scan-result-control` outcome carries. Bound to a SPECIFIC artifact
 * digest (`artifactDigest` = the digest Trivy actually scanned; `expectedDigest` = the digest the
 * change is promoting): `digestMatch` is the ADR-0013 "nothing slipped in" check at the control
 * level — a verdict whose scanned digest does not match the change's artifact does NOT authorize the
 * change (the control returns `fail`, and this evidence records `digestMatch: false`).
 */
export const ScanEvidenceSchema = z.object({
  /** Always `"trivy"` for M17.1 — the one scanner whose result schema this control parses. A field,
   *  not a constant, so the evidence is self-describing in a Decision and a future second scanner
   *  slots in without a shape change. */
  scanner: z.literal("trivy"),
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
  /** The threshold ACTUALLY applied to reach this verdict (post-merge). */
  threshold: ScanThresholdSchema,
  /** M17.5 (ADR-0016) — WHERE the applied threshold came from. `"config"` = the flat per-binding
   *  `config.threshold` (the M17.1 status quo, unchanged when the gate threads no scoped floor);
   *  `"scoped"` = the gate-resolved, most-restrictive-wins merge across the six tiers. Optional so
   *  every pre-M17.5 evidence document still parses. */
  thresholdSource: z.enum(["config", "scoped"]).optional(),
  /** M17.5 — every tier that contributed a ceiling to the merged threshold, so a blocked promotion's
   *  Decision can explain WHICH tier set the binding severity floor (charter principle 6). */
  thresholdContributors: z.array(ScanThresholdContributionSchema).optional()
});
export type ScanEvidence = z.infer<typeof ScanEvidenceSchema>;

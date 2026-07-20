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
  threshold: ScanThresholdSchema
});
export type ScanEvidence = z.infer<typeof ScanEvidenceSchema>;

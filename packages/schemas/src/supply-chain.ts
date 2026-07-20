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

// -------------------------------------------------------------------------------------------
// M17.2 — BUILD-TIME SBOM, stored as a REFERENCE on the promotion (ADR-0015 §5).
//
// CHARTER — coordinate, not execute: SCP NEVER generates an SBOM and NEVER stores its BYTES. The
// EXECUTOR's coordinated Trivy pass emits the SBOM at BUILD time and cosign-signs it at ORIGIN; SCP
// persists only this reference — WHERE the document lives, WHAT it hashes to, and WHICH origin
// signature attests it. `scanner`/`scannerVersion`/`signatureRef` record WHO produced and signed it
// externally; none of them is a claim that SCP did anything.
//
// Why reference-only is FORCED, not a preference: SCP has no blob storage anywhere (no binary
// column in the schema, no multipart ingress, no object store) — every artifact in the system is
// already a string reference inside a jsonb column — and federation/promotion bundles are
// METADATA-ONLY by ADR-0009. Storing SBOM bytes would be a net-new storage subsystem AND would
// break the metadata-only bundle invariant. So: reference in, reference out.
//
// WHERE it is persisted: `changes.sourceRef.sbom` (the report body is persisted verbatim and becomes
// the change's canonical `sourceRef` — `coordination/webhook-processor.ts`). `source_ref` is jsonb,
// so this shape costs ZERO migration. HOW it arrives: the typed first-party report ingress
// (`POST /change-sources/{sourceKind}/report`, `ChangeReportRequestSchema.sbom`) — the only TYPED,
// SDK-generating ingress (charter principle 3), already PAT-authed and already carrying the
// artifact digest this SBOM describes.
//
// This shape is the M17.3 CONTRACT: the promotion manifest's artifact set reads these fields.
// -------------------------------------------------------------------------------------------

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

/**
 * A REFERENCE to a build-time SBOM. Never the document itself.
 *
 * `digest` is the SBOM DOCUMENT's own content digest (what the reader must verify the fetched bytes
 * hash to) — it is NOT the artifact digest; the artifact this SBOM describes is the change's own
 * `sourceRef.artifact_digest`, which travels alongside it on the same report.
 */
export const SbomRefSchema = z.object({
  /** SBOM document format. Two, because these are the two cosign/Trivy actually emit. */
  format: z.enum(["cyclonedx", "spdx"]),
  /** The format's spec version as the producer reported it (e.g. `"1.5"`, `"SPDX-2.3"`). */
  specVersion: z.string().optional(),
  /** The SBOM DOCUMENT's content digest. Accepts `sha256:<hex>`, a bare 64-hex string, or a
   *  `<ref>@sha256:<hex>` form; normalized to `sha256:<lowercase-hex>` when persisted. */
  digest: z
    .string()
    .refine((v) => sbomDigestHex(v) !== undefined, {
      message: "digest must carry a sha256 digest (sha256:<64-hex>, <ref>@sha256:<64-hex>, or bare 64-hex)"
    }),
  /** WHERE the document lives — an OCI referrer ref, registry URL, or artifact-store URI. SCP stores
   *  the string and never fetches it as part of persisting the reference. */
  location: z.string().min(1),
  /** Media type of the referenced document (e.g. `application/vnd.cyclonedx+json`). */
  mediaType: z.string().optional(),
  /** The EXECUTOR's ORIGIN cosign signature over the SBOM (a `.sig` ref / OCI referrer / Rekor
   *  entry). SCP NEVER signs the SBOM — it records which origin attestation exists so a downstream
   *  (air-gapped) verifier can check it against the producing domain's key. */
  signatureRef: z.string().optional(),
  /** WHICH external tool produced the SBOM (e.g. `"trivy"`). Not a claim SCP produced it. */
  scanner: z.string().optional(),
  /** That tool's reported version. */
  scannerVersion: z.string().optional(),
  /** When the producer emitted it (ISO-8601), as reported by the producer. */
  generatedAt: z.string().optional()
});
export type SbomRef = z.infer<typeof SbomRefSchema>;

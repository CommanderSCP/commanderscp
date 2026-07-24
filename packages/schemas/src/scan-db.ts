import { z } from "zod";

/**
 * M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH (ADR-0020, proposal §13.3b).
 *
 * The commander's promotion scan step (`federation/promotion-scan-step.ts`) runs the
 * `scp-runner-scan` container `--network none`; the Trivy vulnerability DB is either BAKED into that
 * image at build time (the fail-closed fallback) or PRE-LOADED from a server-maintained cache that
 * the operator keeps fresh. This file carries the TYPED shapes for that cache's operator surface
 * (API -> SDK -> CLI, charter principle 3): its status, the operator-configurable staleness policy,
 * the connected refresh, and the air-gap operator-load.
 *
 * WHY OPERATOR-LOADED, NOT PROMOTION-CHANNEL, FOR THE AIR-GAP (owner decision 2026-07-24): the
 * commander sits at the TOP of the federation with NO into-commander byte channel — the relay flows
 * downward + change-bound, and `.scpbundle` is metadata-only (ADR-0009). So a disconnected commander
 * cannot RECEIVE a DB over the promotion channel. The operator instead carries the cosign-signed DB
 * blob across the CDS and loads it into the cache (digest-bound + detached-signature verify before
 * accept). The proposal §13.3b's "promotion-channel refresh (air-gapped)" was wrong for the commander
 * and is corrected to operator-loaded (proposal §13.3b + the scan-db-refresh runbook).
 */

/** WHERE the DB the runner will consume came from. `baked` = the build-time image bake (the
 *  fail-closed fallback, as stale as the image); `refreshed` = a connected operator-invoked skopeo
 *  pull from the upstream OCI trivy-db; `operator-loaded` = a cosign-signed DB blob the operator
 *  carried across a CDS and loaded; `absent` = a cache is configured but holds no usable DB. */
export const ScanDbSourceSchema = z.enum(["baked", "refreshed", "operator-loaded", "absent"]);
export type ScanDbSource = z.infer<typeof ScanDbSourceSchema>;

/** The staleness classification of the DB the runner would consume, against the active policy.
 *  `fresh`/`warn` still scan (warn is surfaced in evidence + the Decision); `hard-fail`/`missing`/
 *  `corrupt` FAIL CLOSED (no scan → no evidence → E6 refuses). */
export const ScanDbStalenessClassSchema = z.enum(["fresh", "warn", "hard-fail", "missing", "corrupt"]);
export type ScanDbStalenessClass = z.infer<typeof ScanDbStalenessClassSchema>;

/** Which staleness threshold (if any) the DB's age tripped. */
export const ScanDbThresholdFiredSchema = z.enum(["none", "soft", "hard"]);
export type ScanDbThresholdFired = z.infer<typeof ScanDbThresholdFiredSchema>;

/** Built-in defaults when the operator has authored no staleness policy (proposal §13.3b: soft 7d,
 *  hard 30d). Exported so the resolver, the status projection, and the tests share one source. */
export const DEFAULT_SCAN_DB_SOFT_MAX_AGE_HOURS = 7 * 24;
export const DEFAULT_SCAN_DB_HARD_MAX_AGE_HOURS = 30 * 24;

/**
 * The commander-level, INSTANCE-SCOPED staleness policy — modeled EXACTLY like M17.5's
 * `scan_requirement_floors` (governance/scan-requirements.ts + drizzle 0029): no `org_id`, tenant
 * SELECT (a gate a tenant cannot inspect is not explainable), operator-only write. A company applies
 * its own rules at RUNTIME (owner decision 2026-07-24), no redeploy. Both bounds nullable so an
 * operator can clear one back to the built-in default without deleting the row.
 */
export const ScanDbStalenessPolicySchema = z.object({
  /** Soft max age in hours — beyond this the DB is WARN (still scans). `null` ⇒ built-in default. */
  softMaxAgeHours: z.number().int().positive().nullable(),
  /** Hard max age in hours — beyond this the DB FAILS CLOSED. `null` ⇒ built-in default. */
  hardMaxAgeHours: z.number().int().positive().nullable(),
  note: z.string().nullable(),
  updatedAt: z.string(),
  /** True when no operator policy is stored and the built-in defaults are in force. */
  isDefault: z.boolean(),
  /** The bounds ACTUALLY in force (built-in defaults substituted for any null). */
  effectiveSoftMaxAgeHours: z.number().int().positive(),
  effectiveHardMaxAgeHours: z.number().int().positive()
});
export type ScanDbStalenessPolicy = z.infer<typeof ScanDbStalenessPolicySchema>;

/** Operator write body. Both bounds `null`-able to explicitly reset to the built-in default. */
export const PutScanDbStalenessPolicyRequestSchema = z.object({
  softMaxAgeHours: z.number().int().positive().nullish(),
  hardMaxAgeHours: z.number().int().positive().nullish(),
  note: z.string().max(500).nullish()
});
export type PutScanDbStalenessPolicyRequest = z.infer<typeof PutScanDbStalenessPolicyRequestSchema>;

/**
 * The DB cache's status — tenant-readable so a blocked promotion's Decision (and an operator's
 * `scp scan-db status`) can explain WHY the DB failed closed / warned. Surfaces the age + source +
 * schema compatibility + which threshold fired + the active thresholds (item 4/5, owner 2026-07-24).
 */
export const ScanDbStatusSchema = z.object({
  /** Whether a DB cache dir is configured at all (`SCP_MANAGED_SCAN_DB_CACHE`). Unset ⇒ the runner
   *  uses the image-baked DB (source `baked`), and there is no staleness gate (as stale as the image). */
  cacheConfigured: z.boolean(),
  /** Whether a usable DB is present (in the cache, or baked when the cache is unconfigured). */
  present: z.boolean(),
  source: ScanDbSourceSchema,
  /** The DB's age in hours from its `metadata.json` `UpdatedAt`; `null` when unknown/absent. */
  ageHours: z.number().nonnegative().nullable(),
  /** trivy-db `metadata.json` timestamps (ISO), when readable. */
  updatedAt: z.string().nullable(),
  nextUpdate: z.string().nullable(),
  /** The DB's own schema version and the version the PINNED Trivy binary requires (tools/trivy/pin.env). */
  schemaVersion: z.number().int().nullable(),
  expectedSchemaVersion: z.number().int(),
  /** True iff `schemaVersion === expectedSchemaVersion` — a DB the pinned binary can actually read. */
  schemaCompatible: z.boolean(),
  staleness: ScanDbStalenessClassSchema,
  thresholdFired: ScanDbThresholdFiredSchema,
  activeSoftMaxAgeHours: z.number().int().positive(),
  activeHardMaxAgeHours: z.number().int().positive(),
  /** Human-legible one-line summary of the above (the block reason a Decision would cite). */
  detail: z.string()
});
export type ScanDbStatus = z.infer<typeof ScanDbStatusSchema>;

/** Connected refresh — skopeo-pull the upstream OCI trivy-db into the cache (atomic swap +
 *  schema-compat assertion). No body fields today; the source registry is the operator-allowlisted
 *  `ghcr.io` (SCP_ARTIFACT_OCI_REGISTRY_HOSTS). */
export const RefreshScanDbRequestSchema = z.object({}).strict();
export type RefreshScanDbRequest = z.infer<typeof RefreshScanDbRequestSchema>;

export const RefreshScanDbResponseSchema = z.object({
  refreshed: z.boolean(),
  status: ScanDbStatusSchema,
  detail: z.string()
});
export type RefreshScanDbResponse = z.infer<typeof RefreshScanDbResponseSchema>;

/**
 * Air-gap operator-load — the operator produced a cosign-signed DB blob at the connected side
 * (skopeo-pull + repackage + cosign sign-blob), walked it across the CDS, and placed it (plus its
 * detached signature + the signing public key) on a path reachable by the commander. The server
 * VERIFIES the detached signature (and, when given, the digest) BEFORE accepting the bytes into the
 * cache (atomic swap). No new federation message/flow; the blob is the SAME `type:'blob'` shape as
 * the connected-repackage. Paths are server-local (operator-token gated) so hundreds of MB never
 * traverse the JSON API.
 */
export const LoadScanDbRequestSchema = z.object({
  /** Server-local path to the DB blob (a gzipped tar of the trivy cache `db/` dir). */
  blobPath: z.string().min(1),
  /** Server-local path to the cosign detached signature over the blob. */
  signaturePath: z.string().min(1),
  /** Server-local path to the operator's cosign public key PEM the signature is verified against. */
  publicKeyPath: z.string().min(1),
  /** Optional `sha256:<hex>` the blob bytes must hash to (defence in depth over the signature). */
  expectedDigest: z.string().optional()
});
export type LoadScanDbRequest = z.infer<typeof LoadScanDbRequestSchema>;

export const LoadScanDbResponseSchema = z.object({
  loaded: z.boolean(),
  status: ScanDbStatusSchema,
  detail: z.string()
});
export type LoadScanDbResponse = z.infer<typeof LoadScanDbResponseSchema>;

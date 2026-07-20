import { z } from "zod";

/**
 * M6 Federation wire contract (DESIGN.md §13, BUILD_AND_TEST.md §8 M6) — Zod schemas/types only.
 * The hashing/signing/verification algorithms (which need `node:crypto`, so they can't be part of
 * this package's browser-importable default entry — `apps/web` imports `@scp/schemas` via
 * `@scp/sdk`) live in `federation-journal.ts`, the `@scp/schemas/federation-journal` subpath —
 * same split as `audit.ts` / `audit-chain.ts`.
 */

/**
 * The three federation-role tiers (owner decision, 2026-07-15 — clean break from the earlier
 * `parent`/`child` vocabulary; see docs/adr/0004-service-naming-commander-outpost-retrans.md):
 *
 *  - `commander` — the top/central service: the single source of truth for global config (the
 *    charter's Global Coordination Layer). Replaces the old `parent` role.
 *  - `outpost` — a lower/environment-specific domain instance (e.g. `commercial-amer`,
 *    `commercial-apac`, `federal`, `airgap-1`). One per environment/region. Replaces the old
 *    `child` role.
 *  - `retrans` (retransmission) — a NEW role for the CDS (cross-domain solution) boundary. It
 *    deliberately does much LESS than an outpost: it still validates (signature/hash-chain
 *    verification, same fail-closed checks as any import), but does essentially nothing beyond
 *    that plus pushing the artifact up through the CDS. It never originates config, never holds
 *    local authoritative objects, and never terminates a promotion — it is a store-and-forward
 *    validation relay. No new CDS transfer logic ships with this declaration; that lands with the
 *    dedicated CDS work.
 */
export const FederationRoleSchema = z.enum(["unset", "commander", "outpost", "retrans"]);
export type FederationRole = z.infer<typeof FederationRoleSchema>;

/** Sync scope, configurable per peer (DESIGN §13: "full graph / policies-only / changes-only /
 *  status-only / label-selector custom"). */
export const SyncScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("full") }),
  z.object({ mode: z.literal("policies_only") }),
  z.object({ mode: z.literal("changes_only") }),
  z.object({ mode: z.literal("status_only") }),
  z.object({ mode: z.literal("custom"), labelSelector: z.record(z.string(), z.string()) })
]);
export type SyncScope = z.infer<typeof SyncScopeSchema>;

export const JournalEntryKindSchema = z.enum([
  "object_upsert",
  "object_tombstone",
  "relationship_upsert",
  "relationship_tombstone",
  "change_status",
  "policy_upsert",
  "approval_evidence",
  "audit_segment",
  "key_rotation"
]);
export type JournalEntryKind = z.infer<typeof JournalEntryKindSchema>;

/** One row of the append-only Sync Journal (DESIGN §13 core). `baseRevision`/`conflict` are the
 *  two reserved, v1-unused fields the overlay decision insures against a future format break. */
export const SyncJournalEntrySchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  originDomainId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  entryKind: JournalEntryKindSchema,
  payload: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  baseRevision: z.number().int().nullable(),
  conflict: z.string().nullable(),
  prevHash: z.string(),
  rowHash: z.string(),
  signature: z.string(),
  createdAt: z.string().datetime()
});
export type SyncJournalEntry = z.infer<typeof SyncJournalEntrySchema>;

export const FederationSelfSchema = z.object({
  domainId: z.string().uuid(),
  name: z.string(),
  role: FederationRoleSchema,
  publicKey: z.string()
});
export type FederationSelfInfo = z.infer<typeof FederationSelfSchema>;

export const InitFederationRequestSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.enum(["commander", "outpost", "retrans"])
});
export type InitFederationRequest = z.infer<typeof InitFederationRequestSchema>;

/** `POST /federation/peers` — pairing (DESIGN §13). Outpost-initiated in the connected-mTLS case
 *  (the outpost dials the commander to exchange keys); for air-gapped peers this is an out-of-band
 *  exchange of each side's public identity (`scp federation status` prints it; the operator
 *  copies it to the other side's `scp federation pair` call). */
export const PairPeerRequestSchema = z.object({
  domainId: z.string().uuid(),
  name: z.string().min(1).max(200),
  role: z.enum(["commander", "outpost", "retrans"]),
  publicKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  syncScope: SyncScopeSchema.optional()
});
export type PairPeerRequest = z.infer<typeof PairPeerRequestSchema>;

export const FederationPeerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: FederationRoleSchema,
  baseUrl: z.string().nullable(),
  syncScope: SyncScopeSchema,
  publicKey: z.string(),
  pairedAt: z.string().datetime()
});
export type FederationPeer = z.infer<typeof FederationPeerSchema>;

export const BundleTransferStatusSchema = z.enum(["created", "submitted", "confirmed"]);
export type BundleTransferStatus = z.infer<typeof BundleTransferStatusSchema>;

export const BundleTransferSchema = z.object({
  id: z.string().uuid(),
  peerDomainId: z.string().uuid(),
  direction: z.enum(["export", "import"]),
  kind: z.enum(["sync", "promotion"]),
  status: BundleTransferStatusSchema,
  sinceSequence: z.number().int().nullable(),
  throughSequence: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  confirmedAt: z.string().datetime().nullable()
});
export type BundleTransfer = z.infer<typeof BundleTransferSchema>;

/** `GET /federation/status` — commander cross-domain view (DESIGN §13): every known peer, its sync
 *  freshness (`lastAppliedSequence` from this side's own cursor), and bundle-transfer status.
 *  Bounded for air-gapped peers: the UI/CLI must label this "as of `lastSyncedAt`", never live. */
export const FederationPeerStatusSchema = z.object({
  peer: FederationPeerSchema,
  lastAppliedSequence: z.number().int().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  recentTransfers: z.array(BundleTransferSchema)
});
export type FederationPeerStatus = z.infer<typeof FederationPeerStatusSchema>;

export const FederationStatusResponseSchema = z.object({
  self: FederationSelfSchema.nullable(),
  peers: z.array(FederationPeerStatusSchema)
});
export type FederationStatusResponse = z.infer<typeof FederationStatusResponseSchema>;

export const ExportJournalRequestSchema = z.object({
  peer: z.string().min(1), // peer domain id or name
  sinceSequence: z.number().int().nonnegative().optional()
});
export type ExportJournalRequest = z.infer<typeof ExportJournalRequestSchema>;

// -------------------------------------------------------------------------------------------
// The `.scpbundle` envelope (DESIGN §13 file transport). Deliberately NOT a tar/zip archive —
// see federation-journal.ts's module doc for the robustness rationale — a single bounded,
// checksummed, signed JSON document instead.
// -------------------------------------------------------------------------------------------

export const SyncBundleHeaderSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal("sync"),
  exporterDomainId: z.string().uuid(),
  peerDomainId: z.string().uuid(),
  sinceSequence: z.number().int().nonnegative(),
  throughSequence: z.number().int().nonnegative(),
  exportedAt: z.string().datetime()
});
export type SyncBundleHeader = z.infer<typeof SyncBundleHeaderSchema>;

export const SyncBundleSchema = z.object({
  header: SyncBundleHeaderSchema,
  entries: z.array(SyncJournalEntrySchema),
  checksum: z.string(),
  bundleSignature: z.string()
});
export type SyncBundle = z.infer<typeof SyncBundleSchema>;

export const ImportBundleResponseSchema = z.object({
  peerDomainId: z.string().uuid(),
  appliedEntries: z.number().int(),
  skippedEntries: z.number().int(),
  lastAppliedSequence: z.number().int()
});
export type ImportBundleResponse = z.infer<typeof ImportBundleResponseSchema>;

// -------------------------------------------------------------------------------------------
// Promotion Bundles (DESIGN §13 federated change promotion).
// -------------------------------------------------------------------------------------------

export const PromotionApprovalEvidenceSchema = z.object({
  record: z.object({
    approverSubjectId: z.string(),
    approverIdpSubject: z.string().nullable(),
    approvedObjectUrn: z.string(),
    approvedObjectContentHash: z.string(),
    decisionId: z.string().nullable(),
    timestamp: z.string()
  }),
  signature: z.string(),
  publicKey: z.string()
});
export type PromotionApprovalEvidence = z.infer<typeof PromotionApprovalEvidenceSchema>;

/**
 * M17.3 (E3) — a TYPED entry in a promotion bundle's artifact set. The rich source of truth the
 * flat `artifactDigests` array is projected FROM: `artifacts[]` holds both the tracked OCI image(s)
 * (`type: "oci"`) and the build-time SBOM blob (`type: "blob"`), while `artifactDigests` stays as
 * `artifacts.map(a => a.digest)` so an OLDER outpost that reads only `artifactDigests` keeps working.
 *
 * EXPAND phase (this increment): `artifacts` is OPTIONAL and DELIBERATELY EXCLUDED from the Ed25519
 * bundle checksum (which stays over `{header, change, controlOutcomes, approvals, artifactDigests}`),
 * so a bundle with `artifacts` present is byte-identical, under the checksum, to a v1 bundle without
 * it — the wire is backward/forward compatible and `formatVersion` stays `1`. The CONTRACT phase
 * (fold `artifacts` into the checksum under `formatVersion 2`, drop `artifactDigests`) is a FUTURE
 * release. NO cosign / signing is introduced here — `signatureRef` merely CARRIES the executor's
 * pre-existing ORIGIN signature reference (empty where none was reported); SCP signs nothing new.
 *
 * A superset shape holding both artifact kinds: `{type, digest}` are required; `location`/`format`
 * describe a blob (e.g. the SBOM document's storage ref + document format); `signatureRef` is the
 * ORIGIN executor's signature reference for that artifact.
 */
export const ArtifactRefSchema = z.object({
  /** `oci` = a tracked container image/artifact by registry digest; `blob` = a referenced document
   *  (today: the build-time SBOM). */
  type: z.enum(["oci", "blob"]),
  /** The artifact's content digest — carried VERBATIM from the change's tracked
   *  `sourceRef.artifact_digest` (OCI) or the already-normalized `sourceRef.sbom.digest` (blob), so
   *  the projected `artifactDigests` remains identical to a pre-E3 export of the same change. */
  digest: z.string(),
  /** The ORIGIN executor's signature reference for this artifact (a `.sig` ref / OCI referrer /
   *  Rekor entry). Empty where the executor reported none. SCP NEVER produces this — it only relays
   *  the reference the producing domain already emitted. */
  signatureRef: z.string().optional(),
  /** WHERE a blob artifact lives (OCI referrer ref, registry URL, or artifact-store URI). Unset for
   *  OCI images, whose `digest` already locates them within their repository. */
  location: z.string().optional(),
  /** A blob artifact's document format (e.g. `"cyclonedx"`/`"spdx"` for the SBOM). Unset for OCI. */
  format: z.string().optional()
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const PromotionControlOutcomeSchema = z.object({
  controlUrn: z.string().nullable(),
  status: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  detail: z.string().nullable()
});
export type PromotionControlOutcome = z.infer<typeof PromotionControlOutcomeSchema>;

export const PromotionBundleHeaderSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal("promotion"),
  exporterDomainId: z.string().uuid(),
  peerDomainId: z.string().uuid(),
  sourceChangeObjectId: z.string().uuid(),
  exportedAt: z.string().datetime()
});
export type PromotionBundleHeader = z.infer<typeof PromotionBundleHeaderSchema>;

export const PromotionBundleSchema = z.object({
  header: PromotionBundleHeaderSchema,
  change: z.object({
    urn: z.string(),
    name: z.string(),
    properties: z.record(z.string(), z.unknown()),
    sourceKind: z.string().nullable(),
    sourceRef: z.record(z.string(), z.unknown()).nullable()
  }),
  controlOutcomes: z.array(PromotionControlOutcomeSchema),
  approvals: z.array(PromotionApprovalEvidenceSchema),
  /** The FLAT projection kept for backward compatibility — `artifacts.map(a => a.digest)`. Required,
   *  unchanged, and IN the Ed25519 checksum payload (an old outpost verifies against exactly this). */
  artifactDigests: z.array(z.string()),
  /** M17.3 (E3) — the TYPED artifact set `artifactDigests` is projected from. Optional and EXCLUDED
   *  from the checksum (see `ArtifactRefSchema`); absent (`undefined`, never `[]`) when the change
   *  tracks no artifacts, so the canonical string is byte-identical to a v1 bundle. */
  artifacts: z.array(ArtifactRefSchema).optional(),
  checksum: z.string(),
  bundleSignature: z.string()
});
export type PromotionBundle = z.infer<typeof PromotionBundleSchema>;

export const ExportPromotionRequestSchema = z.object({
  peer: z.string().min(1),
  change: z.string().min(1) // idOrUrn
});
export type ExportPromotionRequest = z.infer<typeof ExportPromotionRequestSchema>;

export const ImportPromotionResponseSchema = z.object({
  localChangeObjectId: z.string().uuid(),
  localChangeUrn: z.string(),
  importedFromDomain: z.string().uuid(),
  approvalsAccepted: z.number().int(),
  approvalsRejected: z.number().int()
});
export type ImportPromotionResponse = z.infer<typeof ImportPromotionResponseSchema>;

/** `POST /federation/imports` accepts either bundle kind — the importer sniffs `header.kind`. */
export const ImportBundleRequestSchema = z.union([SyncBundleSchema, PromotionBundleSchema]);
export type ImportBundleRequest = z.infer<typeof ImportBundleRequestSchema>;

export const ImportResultSchema = z.union([
  ImportBundleResponseSchema.extend({ kind: z.literal("sync") }),
  ImportPromotionResponseSchema.extend({ kind: z.literal("promotion") })
]);
export type ImportResult = z.infer<typeof ImportResultSchema>;

/** `POST /federation/hand-fill` — DESIGN §13: air-gapped outposts with no bundle transport
 *  manually enter a commander-origin object as an unverified `provenance: manual` shadow copy. */
export const HandFillRequestSchema = z.object({
  peer: z.string().min(1), // the commander peer this is claimed to originate from
  typeId: z.string().min(1),
  urn: z.string().min(1),
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional()
});
export type HandFillRequest = z.infer<typeof HandFillRequestSchema>;

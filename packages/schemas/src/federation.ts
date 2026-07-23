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
  publicKey: z.string(),
  /** M17.3 (E5) — this domain's cosign MANIFEST-VERIFICATION public key (`cosign.pub` PEM), the
   *  non-secret half of the org's `instance_cosign_keys` keypair. Distributed to peers via the SAME
   *  out-of-band pairing exchange as `publicKey` (the operator copies `scp federation status`/`self`
   *  output into the other side's `scp federation pair`), so an air-gapped peer that only receives
   *  files gets it with ZERO new transport. Verification of a cosign-signed promotion manifest AGAINST
   *  this key is E6/M17.4 — this increment only distributes it. `null` until lazily provisioned;
   *  optional so an older peer/client that never carried it still parses. NEVER the private half. */
  cosignPublicKey: z.string().nullable().optional()
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
// -------------------------------------------------------------------------------------------
// M13.2a — DeliveryTarget (docs/proposals/airgap-cds-validate-promote.md §13.2). WHERE a signed
// channel artifact (a `.scpbundle` or an `scp-relay-*.tar.gz` byte tarball) is dropped for — or
// picked up from — one peer's CDS crossing. Per-peer configuration BESIDE `syncScope`; absent
// per-peer config falls back to the instance env (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — PR
// #112's behavior, unchanged). SCP hands files TO the CDS; it never operates the CDS (charter
// principle 1) — everything past the drop is the org's CDS product.
// -------------------------------------------------------------------------------------------

/** A delivery-target directory: SERVER-side, absolute, traversal-free. Validated at CONFIG time
 *  (here) AND re-checked fail-closed at resolution time (`delivery-target.ts`) — a stored value
 *  that somehow bypassed this schema still never steers a write/list outside itself. */
export const DeliveryDirSchema = z
  .string()
  .min(1)
  .refine((dir) => dir.startsWith("/"), {
    message: "delivery-target directories must be absolute server-side paths"
  })
  .refine((dir) => !dir.split("/").some((seg) => seg === ".." || seg === "."), {
    message: "delivery-target directories must not contain '.' or '..' traversal segments"
  });

/** The `filesystem` provider — literally today's `SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` behavior
 *  made per-peer: a directory path per direction. Both directions optional so a peer can configure
 *  only the side it uses (each unresolvable direction is a fail-closed problem AT USE, never a
 *  silent default path). */
export const FilesystemDeliveryTargetSchema = z.object({
  provider: z.literal("filesystem"),
  /** Outbound drop directory — where THIS instance writes channel artifacts addressed to the peer. */
  outDir: DeliveryDirSchema.optional(),
  /** Inbound intake directory — where channel artifacts FROM the peer arrive (the §13.1a inbox). */
  inDir: DeliveryDirSchema.optional()
});
export type FilesystemDeliveryTarget = z.infer<typeof FilesystemDeliveryTargetSchema>;

/** An S3 object-key PREFIX per direction: relative (no leading `/`), traversal-free. The resolver
 *  normalizes a non-empty prefix to end in `/` before it is joined with the file basename, so a
 *  prefix `inbox` and a prefix `inbox/` address the same location. Empty/omitted ⇒ bucket root. A
 *  prefix is NOT an endpoint — it never widens which bucket/endpoint is reachable, so it needs no
 *  allowlist (unlike `endpoint`/`bucket`); it only scopes keys WITHIN the allowlisted bucket. */
export const DeliveryPrefixSchema = z
  .string()
  .refine((p) => !p.startsWith("/"), {
    message: "delivery-target S3 prefixes must be relative object-key prefixes (no leading '/')"
  })
  .refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), {
    message: "delivery-target S3 prefixes must not contain '.' or '..' traversal segments"
  });

/** 13.2b — the `s3-compatible` provider (proposal §13.2, owner decision D3: AWS SDK v3). WHERE a
 *  signed channel artifact is put/listed/got via an S3 API: an `endpoint` + `bucket`, with a
 *  per-direction key prefix. Driven with the SDK's `endpoint` override + `forcePathStyle` so MinIO
 *  and other S3-compatibles work, and `@aws-sdk/lib-storage`'s managed MULTIPART upload so a
 *  multi-GB relay tarball drops without a hand-rolled `PutObject`.
 *
 *  ENDPOINT/BUCKET IS OPERATOR CONFIG, NEVER BUNDLE-STEERED (the ADR-0019 §4 symmetry, load-bearing):
 *  `endpoint`/`bucket` are a data-supplied EGRESS target set by an org admin with `federation:write`,
 *  the same shape of hazard the filesystem `outDir`/`inDir` are — so they get the SAME operator
 *  allowlist treatment `SCP_DELIVERY_ROOTS` gives directories: an operator-declared endpoint/bucket
 *  allowlist (`SCP_DELIVERY_S3_ENDPOINTS`), enforced at BOTH pair-time (never store an out-of-allowlist
 *  target) and fail-closed at resolution (a stored out-of-allowlist target is a named per-gap problem,
 *  never used). UNSET allowlist + any s3 target ⇒ FAIL-CLOSED (refuse). A tenant must NEVER steer
 *  delivery to an arbitrary S3 endpoint. Credentials are NOT here — they live in the vault under
 *  `delivery/<peer>/<direction>` (ADR-0019 §3 artifact-store class), resolved at use, never in config. */
export const S3DeliveryTargetSchema = z.object({
  provider: z.literal("s3-compatible"),
  /** The S3(-compatible) API endpoint (e.g. `https://minio.example.net:9000`). Must be an absolute
   *  URL; its origin (scheme+host+port) must be operator-allowlisted (`SCP_DELIVERY_S3_ENDPOINTS`). */
  endpoint: z.string().url(),
  /** The bucket channel artifacts are put into / listed from. Must be operator-allowlisted (either
   *  the endpoint is allowed for ANY bucket, or the exact endpoint+bucket pair is allowed). */
  bucket: z
    .string()
    .min(1)
    .refine((b) => !b.includes("/"), {
      message: "delivery-target S3 bucket must be a bare bucket name (no '/')"
    }),
  /** Outbound key prefix — where THIS instance PUTs channel artifacts addressed to the peer. */
  outPrefix: DeliveryPrefixSchema.optional(),
  /** Inbound key prefix — where channel artifacts FROM the peer arrive (the §13.1a inbox). */
  inPrefix: DeliveryPrefixSchema.optional()
});
export type S3DeliveryTarget = z.infer<typeof S3DeliveryTargetSchema>;

/** Discriminated on `provider` — 13.2b adds `s3-compatible` as a SECOND union member, ADDITIVELY:
 *  zero shape change to the filesystem member, so an older client/peer that only knows `filesystem`
 *  still parses every filesystem target byte-identically. */
export const DeliveryTargetSchema = z.discriminatedUnion("provider", [
  FilesystemDeliveryTargetSchema,
  S3DeliveryTargetSchema
]);
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;

/** PERMISSIVE RESPONSE VIEW of a DeliveryTarget — the shape RESPONSE bodies advertise, deliberately
 *  NOT a discriminatedUnion. A strict `oneOf` in a RESPONSE is inherently NON-additive: every new
 *  provider member is an oasdiff `response-property-one-of-added` BREAKING change (a strict client
 *  generated against the old contract might reject the new variant). We dodge that permanently by
 *  advertising ONE open object that is a SUPERSET of every provider's fields — `provider` a plain
 *  string, all fields optional, no `oneOf`/discriminator — so adding the Nth provider only ever adds
 *  OPTIONAL properties (additive), never a union member. The stored strict-union value serialized on
 *  the wire is unchanged and is always a valid instance of this superset; this is a TYPE/CONTRACT
 *  loosening only, no runtime/behavior change. REQUESTS keep the strict `DeliveryTargetSchema` union
 *  — widening a REQUEST union is permissive-input, NOT oasdiff-breaking. */
export const DeliveryTargetViewSchema = z.object({
  provider: z.string(),
  outDir: z.string().optional(),
  inDir: z.string().optional(),
  endpoint: z.string().optional(),
  bucket: z.string().optional(),
  outPrefix: z.string().optional(),
  inPrefix: z.string().optional()
});
export type DeliveryTargetView = z.infer<typeof DeliveryTargetViewSchema>;

export const PairPeerRequestSchema = z.object({
  domainId: z.string().uuid(),
  name: z.string().min(1).max(200),
  role: z.enum(["commander", "outpost", "retrans"]),
  publicKey: z.string().min(1),
  /** M17.3 (E5) — the peer's cosign MANIFEST-VERIFICATION public key, carried ALONGSIDE its Ed25519
   *  `publicKey` in the same out-of-band pairing exchange (the operator copies the peer's
   *  `scp federation status`/`self` output here). Optional/additive so an OLD pair request that
   *  predates E5 still pairs. Registered as this peer's TRUSTED cosign key; a cosign pubkey ever
   *  found INSIDE a promotion bundle is only match-checked against this REGISTERED value at verify
   *  time (E6/M17.4), never trusted over it — mirroring how approval-evidence `publicKey` is
   *  compared, never trusted (promotion-repo.ts). */
  cosignPublicKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  syncScope: SyncScopeSchema.optional(),
  /** M13.2a (§13.2) — the peer's per-peer DeliveryTarget. Tri-state on re-pair, mirroring
   *  `cosignPublicKey`'s additive discipline: ABSENT (undefined) preserves whatever is already
   *  configured (an old client that never knew the field can't strip it); an OBJECT sets/replaces
   *  it; explicit `null` clears it back to the instance-env fallback. */
  deliveryTarget: DeliveryTargetSchema.nullable().optional()
});
export type PairPeerRequest = z.infer<typeof PairPeerRequestSchema>;

export const FederationPeerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: FederationRoleSchema,
  baseUrl: z.string().nullable(),
  syncScope: SyncScopeSchema,
  publicKey: z.string(),
  /** M17.3 (E5) — the peer's REGISTERED cosign verification public key (from pairing). `null` for a
   *  peer paired before E5 or one that never supplied one. This is the ONLY value E6/M17.4 trusts to
   *  verify that peer's cosign-signed promotion manifests. */
  cosignPublicKey: z.string().nullable().optional(),
  /** M13.2a (§13.2) — the peer's configured DeliveryTarget, `null` when none is set (the instance
   *  env `SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` fallback applies — today's behavior, unchanged).
   *  RESPONSE uses the permissive `DeliveryTargetViewSchema` (superset object, no `oneOf`) so adding
   *  a provider stays oasdiff-additive; the stored strict-union value is a valid instance of it. */
  deliveryTarget: DeliveryTargetViewSchema.nullable().optional(),
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
  sinceSequence: z.number().int().nonnegative().optional(),
  /** M13.2a (§13.2) — when true the server ALSO drops the exported `.scpbundle` into the peer's
   *  resolved DeliveryTarget (per-peer config, else the `SCP_RELAY_OUT_DIR` instance fallback;
   *  BOTH absent refuses fail-closed). The response body stays the bundle document, unchanged —
   *  the drop is the server-side leg of the CDS walk the operator otherwise does by hand. */
  deliver: z.boolean().optional()
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

/**
 * M17.3 (E6) — the commander's SELF-BINDING promotion MANIFEST. A canonical JSON doc the commander
 * cosign-signs (`manifestSignature`, detached) to attest "I, this exporter, authorized promoting
 * THIS change with THIS artifact set toward THIS peer." It rides as a SIBLING of the Ed25519 bundle
 * envelope and is DELIBERATELY EXCLUDED from the Ed25519 checksum (see `PromotionBundleSchema`), so
 * a bundle with a manifest is byte-identical under the checksum to one without it (E3 invariant).
 *
 * MANIFEST-SWAP DEFENSE (load-bearing): the manifest enumerates `sourceChangeObjectId`,
 * `exporterDomainId`, `peerDomainId`, `changeUrn`, AND the full `artifacts[]` digest set, so a
 * cosign signature computed over one bundle's manifest cannot be lifted onto a DIFFERENT bundle —
 * the self-bound identity would no longer match. SCP signs ONLY this manifest (its own attestation);
 * it NEVER signs an origin artifact (those origin signatures ride untouched in `artifacts[].signatureRef`).
 */
export const PromotionManifestSchema = z.object({
  /** Manifest schema/version marker — pins the canonical shape a verifier reconstructs bytes from. */
  manifestVersion: z.literal("scp-promotion-manifest/v1"),
  /** When the commander produced this manifest (informational; the binding is the identity fields). */
  createdAt: z.string().datetime(),
  /** The EXPORTER's change object id — binds the manifest to this bundle's `header.sourceChangeObjectId`. */
  sourceChangeObjectId: z.string().uuid(),
  /** The signing (exporting) domain — binds to `header.exporterDomainId`. */
  exporterDomainId: z.string().uuid(),
  /** The addressed peer domain — binds to `header.peerDomainId`. */
  peerDomainId: z.string().uuid(),
  /** The change URN — binds to `change.urn`. */
  changeUrn: z.string(),
  /** The full artifact digest set (oci + blob), each with its origin `signatureRef` where present.
   *  Binds the manifest to EXACTLY this bundle's artifacts — a swapped artifact set breaks the bind. */
  artifacts: z.array(
    z.object({
      type: z.enum(["oci", "blob"]),
      digest: z.string(),
      signatureRef: z.string().optional()
    })
  )
});
export type PromotionManifest = z.infer<typeof PromotionManifestSchema>;

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
  /** M17.3 (E6) — the commander's SELF-BINDING cosign-signed promotion manifest (canonical JSON doc).
   *  Optional and DELIBERATELY EXCLUDED from the Ed25519 checksum (never added to
   *  `promotionChecksumPayload`); absent (`undefined`, never `null`) on a v1 bundle, so the canonical
   *  string stays byte-identical and an OLD outpost that ignores it still verifies the Ed25519 bundle. */
  promotionManifest: PromotionManifestSchema.optional(),
  /** M17.3 (E6) — the DETACHED cosign signature (base64) over `canonicalStringify(promotionManifest)`,
   *  verifiable via `cosign verify-blob` with the exporter's distributed cosign PUBLIC key (E5). Also
   *  EXCLUDED from the Ed25519 checksum. Authoritative cross-hop verification lands in M17.4. */
  manifestSignature: z.string().optional(),
  checksum: z.string(),
  bundleSignature: z.string()
});
export type PromotionBundle = z.infer<typeof PromotionBundleSchema>;

export const ExportPromotionRequestSchema = z.object({
  peer: z.string().min(1),
  change: z.string().min(1), // idOrUrn
  /** M13.2a (§13.2) — when true the server ALSO drops the exported `.scpbundle` into the peer's
   *  resolved DeliveryTarget (per-peer config, else the `SCP_RELAY_OUT_DIR` instance fallback;
   *  BOTH absent refuses fail-closed). Response body unchanged (the bundle document). */
  deliver: z.boolean().optional()
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

// ===========================================================================================
// M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2). The byte tarball itself is a
// SEPARATE channel artifact (never part of any federation bundle — bundles stay metadata-only,
// ADR-0009); these are only the API request/response shapes for driving the relay. The tarball
// crosses the CDS out-of-band as a file, exactly like the `.scpbundle` walk.
// ===========================================================================================

/** `POST /federation/relay` — build the signed relay tarball for an imported, M17.4(a)-verified
 *  promotion (retrans-role instances only). */
export const RelayBuildRequestSchema = z.object({
  /** The LOCAL imported change (id or URN) whose authorized artifact bytes should be relayed. */
  change: z.string().min(1),
  /** M13.2a (§13.2) — the DESTINATION peer (id or name) whose DeliveryTarget receives the outbound
   *  tarball drop. Optional/additive: absent, the drop resolves through the instance env
   *  (`SCP_RELAY_OUT_DIR`) exactly as before — byte-identical behavior. */
  peer: z.string().min(1).optional()
});
export type RelayBuildRequest = z.infer<typeof RelayBuildRequestSchema>;

export const RelayArtifactSummarySchema = z.object({
  type: z.enum(["oci", "blob"]),
  digest: z.string()
});
export type RelayArtifactSummary = z.infer<typeof RelayArtifactSummarySchema>;

export const RelayBuildResponseSchema = z.object({
  /** SERVER-side path of the built tarball (inside the operator-configured `SCP_RELAY_OUT_DIR`
   *  drop directory) — the CDS crossing itself is out-of-band, like the `.scpbundle` walk. */
  tarballPath: z.string(),
  artifacts: z.array(RelayArtifactSummarySchema),
  /** The persisted `retrans-relay-validate` allow Decision (principle 6 — every verdict is a Decision). */
  decisionId: z.string()
});
export type RelayBuildResponse = z.infer<typeof RelayBuildResponseSchema>;

/** `POST /federation/relay/import` — destination side: verify a relay tarball and push its
 *  artifacts into the outpost's local registry by digest (+ re-inspect). */
export const RelayImportRequestSchema = z.object({
  /** Tarball file name (relative) inside the server's `SCP_RELAY_IN_DIR` drop directory. */
  file: z.string().min(1),
  /** The LOCAL imported change (id or URN) this tarball's bytes belong to — import the promotion
   *  `.scpbundle` first; its M17.4(a)-verified artifact set is the authority on what may land. */
  change: z.string().min(1),
  /** The RETRANS instance's cosign PUBLIC key PEM (distributed out-of-band) — verifies the
   *  tarball's CHECKSUMS.txt signature. Zero trust beyond transport integrity: the receiving
   *  M17.4(a)+(b) gates still verify everything against the EXPORTER's key. */
  relayCosignPublicKey: z.string().min(1)
});
export type RelayImportRequest = z.infer<typeof RelayImportRequestSchema>;

export const RelayImportResponseSchema = z.object({
  localChangeObjectId: z.string(),
  pushed: z.array(
    RelayArtifactSummarySchema.extend({
      /** Where the bytes landed (digest-pinned registry ref / blob URL) — also recorded on the
       *  change's `sourceRef.artifacts[].location` for the M17.4(b) pre-deploy byte verify. */
      location: z.string().optional()
    })
  ),
  decisionId: z.string()
});
export type RelayImportResponse = z.infer<typeof RelayImportResponseSchema>;

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

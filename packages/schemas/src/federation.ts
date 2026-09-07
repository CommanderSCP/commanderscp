import { z } from "zod";
import { ProblemSchema } from "./common.js";

/** M6 Federation wire contract. See docs/schemas.md §215. */

/** The three federation-role tiers. See docs/schemas.md §216. */
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
  "key_rotation",
  // OUTPOST-RUN PROBES (team-pipeline-iac D11/D23). See docs/schemas.md §217.
  "pipeline_hook_upsert",
  "pipeline_hook_tombstone",
  "pipeline_evidence_upsert"
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
  /** This domain's cosign verification public key. See docs/schemas.md §218. */
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
// The per-peer delivery target, and what it addresses. See docs/schemas.md §219.

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

/** An S3 object-key PREFIX per direction. See docs/schemas.md §220. */
export const DeliveryPrefixSchema = z
  .string()
  .refine((p) => !p.startsWith("/"), {
    message: "delivery-target S3 prefixes must be relative object-key prefixes (no leading '/')"
  })
  .refine((p) => !p.split("/").some((seg) => seg === ".." || seg === "."), {
    message: "delivery-target S3 prefixes must not contain '.' or '..' traversal segments"
  });

/** 13.2b — the `s3-compatible` provider. See docs/schemas.md §221. */
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

/** PERMISSIVE RESPONSE VIEW of a DeliveryTarget. See docs/schemas.md §222. */
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
  /** The peer's cosign key, carried alongside the other. See docs/schemas.md §223. */
  cosignPublicKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  syncScope: SyncScopeSchema.optional(),
  /** M13.2a (§13.2) — the peer's per-peer DeliveryTarget. Tri-state on re-pair, mirroring
   *  `cosignPublicKey`'s additive discipline: ABSENT (undefined) preserves whatever is already
   *  configured (an old client that never knew the field can't strip it); an OBJECT sets/replaces
   *  it; explicit `null` clears it back to the instance-env fallback. */
  deliveryTarget: DeliveryTargetSchema.nullable().optional(),
  /** M14.1 (ADR-0009, proposal §Config). See docs/schemas.md §224. */
  pokeMode: z.boolean().optional()
});
export type PairPeerRequest = z.infer<typeof PairPeerRequestSchema>;

// M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT. See docs/schemas.md §225.

/** An owner-ENTERED trust-posture assertion about an outpost. See docs/schemas.md §226. */
/** The members come from the glossary, which is authoritative. See docs/schemas.md §227. */
export const OutpostTrustTierSchema = z.enum([
  "commercial",
  "govcloud",
  "fedramp-high",
  "il5",
  "airgap"
]);
export type OutpostTrustTier = z.infer<typeof OutpostTrustTierSchema>;

/** Declare the commander-origin config object for a peer. See docs/schemas.md §228. */
export const CreateOutpostConfigRequestSchema = z.strictObject({
  /** The paired peer this config is ABOUT. See docs/schemas.md §229. */
  peerDomainId: z.string().uuid(),
  /** Display name for the config object. Defaults to the peer's own name. The object's URN is
   *  derived from `peerDomainId`, never from this, so renaming can never fork the binding. */
  name: z.string().min(1).max(200).optional(),
  /** Optional at creation ON PURPOSE — an operator who has not decided the tier yet must be able to
   *  create the object without one being invented for them. */
  trustTier: OutpostTrustTierSchema.optional()
});
export type CreateOutpostConfigRequest = z.infer<typeof CreateOutpostConfigRequestSchema>;

/** Edit the commander-origin config for an outpost. See docs/schemas.md §230. */
export const UpdateOutpostConfigRequestSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  trustTier: OutpostTrustTierSchema.optional(),
  /** Optimistic concurrency against the graph object's `version`, as elsewhere in the graph API. */
  expectedVersion: z.number().int().positive().optional()
});
export type UpdateOutpostConfigRequest = z.infer<typeof UpdateOutpostConfigRequestSchema>;

/** The read view of one `outpost` config object. A projection of the underlying graph object — the
 *  object itself remains readable through the ordinary graph reads. */
export const OutpostConfigSchema = z.object({
  /** The graph object's id — the SAME id the replica carries at the outpost. */
  objectId: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  peerDomainId: z.string().uuid(),
  /** `null` when the operator has never asserted one. Always accompanied by `"trustTier"` in
   *  `unknownFields` — an absent tier is an honest unknown, never `commercial`. */
  trustTier: OutpostTrustTierSchema.nullable(),
  /** The graph object's authoritative origin domain (single-writer authority). On the commander this
   *  is the commander's own trust domain; on the outpost holding the replica it is the COMMANDER's,
   *  which is exactly why the outpost's own writes to it are refused. */
  originDomainId: z.string().uuid(),
  /** Review round 4 — ORIGIN-VS-SELF, resolved server-side. See docs/schemas.md §231. */
  originIsSelf: z.boolean().optional(),
  /** pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST. See docs/schemas.md §232. */
  peerIsSelf: z.boolean().optional(),
  /** Review round 4 — `"manual"` for an UNVERIFIED hand-filled shadow copy (DESIGN §13 hand-fill),
   *  `null` for anything a signature verified or this domain authored. A `"manual"` row's `trustTier` is
   *  ALSO listed in `unknownFields`: it is a value somebody typed, not an assertion this instance can
   *  stand behind, and a UI must not render it as a commander assertion. */
  provenance: z.enum(["manual"]).nullable().optional(),
  revision: z.number().int(),
  version: z.number().int(),
  /** Which of this row's fields are NOT observations (the `ServiceBoardRow.unknownFields` contract).
   *  `"trustTier"` appears whenever no tier has been asserted, when the stored tier is one this build
   *  does not recognise (forward-tolerance — see drizzle/0043), and when the row is an unverified
   *  `"manual"` shadow. */
  unknownFields: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type OutpostConfig = z.infer<typeof OutpostConfigSchema>;

/** THE RECONCILE PRECONDITION TOKEN. See docs/schemas.md §233. */
export const OUTPOST_CLAIMANT_TOKEN_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[1-9][0-9]*$/;

export const OutpostClaimantTokenSchema = z
  .string()
  .regex(
    OUTPOST_CLAIMANT_TOKEN_PATTERN,
    "expected '<objectId>:<version>', e.g. 3f1b…-…:4 (the objectId and version of one previewed claimant)"
  );

/** `?ifClaimant=a:1&ifClaimant=b:2`. A SINGLE occurrence parses as a bare string in every Node
 *  query parser, so both shapes are normalized before validation (same trick as
 *  `stringArrayQueryParam`, kept local because the element type is not a bare string). */
export const OutpostIfClaimantQuerySchema = z.preprocess(
  (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]),
  z.array(OutpostClaimantTokenSchema)
);

export interface OutpostClaimantToken {
  objectId: string;
  version: number;
}

/** `{ objectId, version }` -> `"<objectId>:<version>"`. Accepts any object carrying those two
 *  fields, which is exactly what `GET /federation/outposts` hands back. */
export function formatOutpostClaimantToken(claimant: OutpostClaimantToken): string {
  return `${claimant.objectId}:${claimant.version}`;
}

/** The whole token set for ONE peer, derived from a `listOutposts()` response. Order is irrelevant
 *  (the server compares SETS), but it is kept stable here so a rendered preview and the request it
 *  produces read the same way. */
export function outpostClaimantTokens(
  configs: readonly OutpostConfig[],
  peerDomainId: string
): string[] {
  return configs
    .filter((c) => c.peerDomainId === peerDomainId)
    .map((c) => formatOutpostClaimantToken(c));
}

/** Inverse of {@link formatOutpostClaimantToken}. The string is already regex-validated by
 *  {@link OutpostClaimantTokenSchema} at the route edge, so this never has to report a parse error. */
export function parseOutpostClaimantToken(token: string): OutpostClaimantToken {
  const at = token.lastIndexOf(":");
  return { objectId: token.slice(0, at), version: Number(token.slice(at + 1)) };
}

/** The recovery verb, for when the record diverged. See docs/schemas.md §234. */
export const OutpostConfigReconcileResultSchema = z.object({
  config: OutpostConfigSchema,
  /** The object id that was ADOPTED as this domain's own (its `provenance` cleared), or `null` when an
   *  authoritative row already existed and nothing needed adopting. */
  adoptedObjectId: z.string().uuid().nullable(),
  /** Unverified hand-filled shadows soft-deleted by this call — a silent local cleanup that never rode
   *  the sync journal, because this domain never authored them and claiming authorship of their
   *  deletion would push a delete for a row the real authority still owns. Empty when there was
   *  nothing to clean. */
  removedShadowObjectIds: z.array(z.string().uuid()),
  /** Rows THIS domain authored that were removed to resolve a `?keep=`-named authority conflict
   *  (review round 5, N9) — an ORDINARY JOURNALED TOMBSTONE, indistinguishable from any other local
   *  delete: it PROPAGATES DOWNSTREAM to the outpost. Empty on every call that did not use `?keep=`
   *  to drop this domain's own row. */
  removedLocalObjectIds: z.array(z.string().uuid())
});
export type OutpostConfigReconcileResult = z.infer<typeof OutpostConfigReconcileResultSchema>;

/** THE STALE-PRECONDITION REFUSAL BODY. See docs/schemas.md §235. */
export const OutpostReconcileStaleProblemSchema = ProblemSchema.extend({
  /** Every live config row bound to the peer, at refusal. See docs/schemas.md §236. */
  claimants: z.array(OutpostConfigSchema).optional()
});
export type OutpostReconcileStaleProblem = z.infer<typeof OutpostReconcileStaleProblemSchema>;

// M16.2 phase A (E4) — THE NARROW PEER PATCH. See docs/schemas.md §237.

export const UpdateFederationPeerRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /** Tri-state: absent PRESERVES, a URL SETS. There is deliberately no "clear to null" — an
   *  effective poke-mode peer must keep an https/mTLS base URL (the M14.1/M14.3 guard, re-applied
   *  on this path over the MERGED post-write tuple). */
  baseUrl: z.string().url().optional(),
  syncScope: SyncScopeSchema.optional(),
  /** Tri-state, mirroring re-pair: absent PRESERVES, an object SETS/REPLACES, explicit `null`
   *  CLEARS to the instance-env fallback. Re-checked against the operator allowlists
   *  (`SCP_DELIVERY_ROOTS` / `SCP_DELIVERY_S3_ENDPOINTS`) before it is ever stored. */
  deliveryTarget: DeliveryTargetSchema.nullable().optional(),
  /** Per-side LOCAL flag (ADR-0009) — on a commander it means "this side may poke that peer"; it is
   *  NOT a control over the outpost's own flag and never syncs anywhere. Absent PRESERVES. */
  pokeMode: z.boolean().optional()
});
export type UpdateFederationPeerRequest = z.infer<typeof UpdateFederationPeerRequestSchema>;

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
  /** M14.1 (ADR-0009) — whether this peer is configured for poke-mode. `false` (default) is
   *  poll-mode — the outpost's frequent interval pull, unchanged. `true` means the commander MAY
   *  send it a contentless wake signal and its frequent poll is disabled (M14.4). Optional/additive
   *  so an old SDK reading a new response is unaffected; absent is read as `false`. */
  pokeMode: z.boolean().optional(),
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
  /** The bundle's checksum, the only per-change handle. See docs/schemas.md §238. */
  checksum: z.string().nullable().optional(),
  /** drizzle/0087 — WHICH LEG this hop was. See docs/schemas.md §239. */
  channel: z.enum(["metadata", "bytes"]).nullable().optional(),
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
  /** M14.4 (ADR-0009) — LIVE-PULL FRESHNESS. See docs/schemas.md §240. */
  lastPullAttemptAt: z.string().datetime().nullable().optional(),
  lastPullSuccessAt: z.string().datetime().nullable().optional(),
  /** M14.4 (owner decision D2) — when a poke from this peer was last ACCEPTED. `null` on a
   *  `pokeMode` peer is the UNILATERAL-SPARSE misconfiguration made visible: this side opted into
   *  poke-mode but the other side has never actually poked, so the scheduler keeps polling. */
  lastPokeReceivedAt: z.string().datetime().nullable().optional(),
  /** M14.4 — the cadence the scheduler is ACTUALLY using for this peer right now, as opposed to the
   *  raw `peer.pokeMode` flag: `"poke"` (sparse safety-net only) or `"poll"` (the frequent interval).
   *  Reports `"poll"` for a pokeMode peer that has never been poked (D2), when this instance has no
   *  outbound client-cert material (D4), and while the peer's last pull failed (the reconnect leg). */
  effectiveCadence: z.enum(["poke", "poll"]).optional(),
  // M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY. See docs/schemas.md §241.
  /** The highest `throughSequence` of any SYNC EXPORT bundle this instance has produced for this
   *  peer. `null` = never exported to this peer — deliberately NOT `0`, which would read as "synced
   *  up to the beginning". Measures WHAT WE PUT ON THE WIRE, never what the peer accepted. */
  lastExportedThroughSequence: z.number().int().nullable().optional(),
  /** When that highest export bundle was produced HERE (`bundle_transfers.created_at`). Not a
   *  handoff time and not an apply time — this side's own export timestamp. */
  lastExportedAt: z.string().datetime().nullable().optional(),
  /** The Ed25519 CHECKSUM of that export bundle — the only stable per-bundle identifier this system
   *  has (M16.1 established it as the per-change join handle). This is what an honest
   *  "as of ⟨bundle⟩" label names on the EXPORT side. `null` on a pre-M16.1 ledger row. */
  lastExportedBundleChecksum: z.string().nullable().optional(),
  /** The checksum of the last CONFIRMED INBOUND sync bundle — the "as of ⟨bundle⟩" identifier that
   *  goes with `lastSyncedAt` (same ledger row, so the two always agree). `null` when no confirmed
   *  import exists, or when that row predates checksum recording; either way it is declared in
   *  `unknownFields` rather than rendered as a bundle name. */
  lastSyncedBundleChecksum: z.string().nullable().optional(),
  /** How many of THIS domain's own journal entries have never been carried in an export bundle
   *  addressed to this peer: `ownJournalTail - lastExportedThroughSequence`, floored at 0. `null`
   *  when it cannot be derived (nothing exported yet). NOT a count of anything the peer failed to
   *  apply — the peer may have applied everything, or nothing; this side cannot tell. */
  pendingExportEntryCount: z.number().int().nullable().optional(),
  /** M16.2 phase A (E1) — the `trustTier` asserted on this peer's `outpost` GRAPH OBJECT, resolved
   *  through the `peerDomainId` binding. `null` when no `outpost` object exists for the peer or when
   *  its operator never asserted a tier — NEVER defaulted to a tier (there is no source for one),
   *  and always accompanied by `"trustTier"` in `unknownFields`. */
  trustTier: OutpostTrustTierSchema.nullable().optional(),
  /** Whose assertion the trust tier is, so nothing is faked. See docs/schemas.md §242. */
  trustTierProvenance: z.enum(["declared", "unverified"]).nullable().optional(),
  /** THE CONFIGURED TRANSPORT CHANNEL. See docs/schemas.md §243. */
  transportMode: z.enum(["dialable", "air-gap"]).optional().nullable(),
  /** The fields of this row this instance cannot observe. See docs/schemas.md §244. */
  unknownFields: z.array(z.string()).optional(),
  recentTransfers: z.array(BundleTransferSchema)
});
export type FederationPeerStatus = z.infer<typeof FederationPeerStatusSchema>;

export const FederationStatusResponseSchema = z.object({
  self: FederationSelfSchema.nullable(),
  /** M16.2 phase A (E3) — the tail sequence of THIS domain's OWN journal (0 when it has authored
   *  nothing). The denominator every `lastExportedThroughSequence` is read against; one value per
   *  instance, not per peer. Optional/additive. */
  ownJournalTail: z.number().int().nullable().optional(),
  /** The headquarters outpost record, and what it is. See docs/schemas.md §245. */
  selfOutpost: OutpostConfigSchema.nullable().optional(),
  peers: z.array(FederationPeerStatusSchema)
});
export type FederationStatusResponse = z.infer<typeof FederationStatusResponseSchema>;

export const ExportJournalRequestSchema = z.object({
  peer: z.string().min(1),
  sinceSequence: z.number().int().nonnegative().optional(),
  /** M13.2a (§13.2) — when true the server ALSO drops the exported `.scpbundle` into the peer's
   *  resolved DeliveryTarget (per-peer config, else the `SCP_RELAY_OUT_DIR` instance fallback;
   *  BOTH absent refuses fail-closed). The response body stays the bundle document, unchanged —
   *  the drop is the server-side leg of the CDS walk the operator otherwise does by hand. */
  deliver: z.boolean().optional(),
  /** DIVERGENCE RAIL 2. See docs/schemas.md §246. */
  lastAppliedRowHash: z.string().optional()
});

/** RFC 9457 problem `type` for a detected journal fork/rollback. See docs/schemas.md §247. */
export const JOURNAL_DIVERGENCE_PROBLEM_TYPE = "urn:scp:federation:journal_divergence";

/** The `journal_divergence` 409 body. See docs/schemas.md §248. */
export const JournalDivergenceProblemSchema = ProblemSchema.extend({
  exporterTailSequence: z.number().int().nonnegative().optional(),
  exporterTailRowHash: z.string().optional()
});
export type JournalDivergenceProblem = z.infer<typeof JournalDivergenceProblemSchema>;
export type ExportJournalRequest = z.infer<typeof ExportJournalRequestSchema>;

// The `.scpbundle` envelope. See docs/schemas.md §249.

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

/** DIVERGENCE RAIL 4. See docs/schemas.md §250. */
export const JournalTailAttestationSchema = z.object({
  tailSequence: z.number().int().nonnegative(),
  tailRowHash: z.string(),
  signature: z.string()
});
export type JournalTailAttestation = z.infer<typeof JournalTailAttestationSchema>;

export const SyncBundleSchema = z.object({
  header: SyncBundleHeaderSchema,
  entries: z.array(SyncJournalEntrySchema),
  checksum: z.string(),
  bundleSignature: z.string(),
  /** RAIL 4 — additive & OPTIONAL: an un-upgraded importer (or a pre-M26.2 bundle sitting in an
   *  inbox) simply lacks it and the rail no-ops, never blocking. It rides OUTSIDE `checksum`
   *  (which covers only `{header, entries}`) as a sibling field, so old strict readers drop it and
   *  the existing bundle signature is unaffected. */
  tailAttestation: JournalTailAttestationSchema.optional()
});
export type SyncBundle = z.infer<typeof SyncBundleSchema>;

/** §7.2.6 RESYNC — the SIGNED CROSS-DOMAIN HANDSHAKE. See docs/schemas.md §251. */
export const FederationResyncRequestSchema = z.object({
  peer: z.string().min(1),
  requestSignature: z.string()
});
export type FederationResyncRequest = z.infer<typeof FederationResyncRequestSchema>;

/** The exporter's signed response: a FULL re-export from genesis (a normal, signature-verified
 *  `SyncBundle`) plus the exporter's generation stamp at consent time. The exporter records its OWN
 *  consent Decision before returning this — the "both sides record" half on the exporter. */
export const FederationResyncResponseSchema = z.object({
  bundle: SyncBundleSchema,
  exporterGeneration: z.number().int().nonnegative()
});
export type FederationResyncResponse = z.infer<typeof FederationResyncResponseSchema>;

/** The importer-side result of `scp federation resync` — the local operation that dials the
 *  exporter, force-imports the re-export, resets its cursor, bumps its own generation, and clears
 *  the standing divergence (so rail 5's reanchor refusal lifts). */
export const FederationResyncResultSchema = z.object({
  peerDomainId: z.string().uuid(),
  previousCursorSequence: z.number().int().nonnegative(),
  appliedEntries: z.number().int(),
  generation: z.number().int().nonnegative(),
  decisionId: z.string().uuid()
});
export type FederationResyncResult = z.infer<typeof FederationResyncResultSchema>;

export const ImportBundleResponseSchema = z.object({
  peerDomainId: z.string().uuid(),
  appliedEntries: z.number().int(),
  skippedEntries: z.number().int(),
  lastAppliedSequence: z.number().int()
});
export type ImportBundleResponse = z.infer<typeof ImportBundleResponseSchema>;

// Promotion Bundles (DESIGN §13 federated change promotion).

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

/** M17.3 (E3) — a TYPED entry in a promotion bundle's artifact set. See docs/schemas.md §252. */
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

/** M17.3 (E6) — the commander's SELF-BINDING promotion MANIFEST. See docs/schemas.md §253. */
export const PromotionManifestSchema = z.object({
  /** Manifest schema/version marker — pins the canonical shape a verifier reconstructs bytes from. */
  manifestVersion: z.literal("scp-promotion-manifest/v1"),
  /** When the commander produced this manifest (informational; the binding is the identity fields). */
  createdAt: z.string().datetime(),
  /** The EXPORTER's change object id — binds the manifest to this bundle's `header.sourceChangeObjectId`. */
  sourceChangeObjectId: z.string().uuid(),
  exporterDomainId: z.string().uuid(),
  peerDomainId: z.string().uuid(),
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
  change: z.string().min(1),
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

// M15.5(c) — the RETRANS VALIDATE-THEN-RELAY. See docs/schemas.md §254.

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

// M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE. See docs/schemas.md §255.

export const RelayBuildStatusSchema = z.enum(["pending", "built", "forwarded", "exhausted"]);
export type RelayBuildStatus = z.infer<typeof RelayBuildStatusSchema>;

export const RelayBuildSchema = z.object({
  changeObjectId: z.string().uuid(),
  /** The EXPORTER's change id — `text` (drizzle/0047), not `uuid`: it's authored by a foreign
   *  domain and this instance never validates its shape. */
  sourceChangeObjectId: z.string().nullable(),
  status: RelayBuildStatusSchema,
  /** CLAIMS taken; also the fence token every release is guarded on. */
  attempts: z.number().int(),
  /** Attempts that produced a VERDICT and failed — what the operator-configured cap is measured
   *  against (an evicted worker's claim does not spend it). */
  failedAttempts: z.number().int(),
  /** The retry gate: a 'pending' row is workable only at/after this instant. */
  nextAttemptAt: z.string().datetime(),
  claimedUntil: z.string().datetime().nullable(),
  lastReason: z.string().nullable(),
  /** THE OPERATOR'S WHY HANDLE: joins to `GET /decisions/{id}` for the persisted verdict behind
   *  `lastReason` (principle 6 — every verdict is a Decision with its inputs). */
  lastDecisionId: z.string().uuid().nullable(),
  tarballPath: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type RelayBuild = z.infer<typeof RelayBuildSchema>;

/** `GET /federation/relay-builds` response. See docs/schemas.md §256. */
export const RelayBuildListResponseSchema = z.object({
  items: z.array(RelayBuildSchema)
});
export type RelayBuildListResponse = z.infer<typeof RelayBuildListResponseSchema>;

// FEDERATION AUDIT WITNESS. See docs/schemas.md §257.

/** One witnessed entry of an origin domain's audit chain, in the order it was witnessed. */
export const AuditWitnessSchema = z.object({
  originDomainId: z.string(),
  sequence: z.number().int(),
  auditEventId: z.string(),
  contentHash: z.string(),
  witnessedAt: z.string().datetime()
});
export type AuditWitness = z.infer<typeof AuditWitnessSchema>;

/** `GET /federation/audit-witnesses` response — `{ items }`, matching the newer non-cursor list
 *  responses in this file (see `RelayBuildListResponseSchema`'s doc for the precedent survey). */
export const AuditWitnessListResponseSchema = z.object({
  items: z.array(AuditWitnessSchema)
});
export type AuditWitnessListResponse = z.infer<typeof AuditWitnessListResponseSchema>;

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

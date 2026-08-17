import { z } from "zod";
import { ProblemSchema } from "./common.js";

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
  deliveryTarget: DeliveryTargetSchema.nullable().optional(),
  /** M14.1 (ADR-0009, proposal §Config) — per-peer poke-mode. Tri-state on re-pair, mirroring
   *  `deliveryTarget`'s additive discipline: ABSENT (undefined) preserves the current setting (an
   *  old client that never knew the field can't flip it); `true`/`false` SETS it. Default-off: a
   *  peer paired without ever supplying it stays poll-mode. An EFFECTIVE (post-write) `true`
   *  requires an https/mTLS-capable EFFECTIVE `baseUrl` (the M14.1 pair-time guard, made total over
   *  the merged tuple in M14.3) — the poke must authenticate the caller as the enrolled commander
   *  (ADR-0001); full endpoint enforcement is M14.2. So a re-pair can neither set poke-mode true on
   *  a non-https peer NOR downgrade `baseUrl` to http while poke-mode stays true. Boolean, not
   *  nullable — there is no "clear to null" state, only poll (false) vs poke (true). */
  pokeMode: z.boolean().optional()
});
export type PairPeerRequest = z.infer<typeof PairPeerRequestSchema>;

// -------------------------------------------------------------------------------------------
// M16.2 phase A (E1) — THE `outpost` GRAPH OBJECT: commander-authored declared config about one
// outpost, which SYNCS DOWN because it is an ordinary graph object (`object_upsert`) and nothing
// written on a `federation_peers` ROW can ever reach a peer (the journal admits 9 entry kinds, none
// peer-shaped, and `peers-repo.ts` never appends one).
//
// THE AUTHORITY SPLIT — 'outpost' now exists twice, and each half owns disjoint fields:
//   * the `federation_peers` ROW owns TRANSPORT IDENTITY AND REACHABILITY (trust-domain id, keys,
//     `baseUrl`, `syncScope`, `deliveryTarget`, `pokeMode`, scheduler timestamps): local to this
//     side, never journaled, written only by pair/re-pair and the narrow PATCH below;
//   * this OBJECT owns COMMANDER-DECLARED CONFIG (today `trustTier`) plus the `peerDomainId`
//     binding: commander-origin, journaled, read-only at the outpost.
// Neither can express the other's fields, and THE REQUEST BODIES BELOW ARE WHAT ENFORCES IT: they
// carry no transport field of any kind and are the only operator-reachable write path, while
// `federation_peers` has no trust-tier column. The REGISTERED JSON SCHEMA (drizzle/0043) is
// deliberately NOT the enforcement — it is journaled and Ajv-validated on the RECEIVING side, so a
// closed schema would turn every future property into a fail-closed version-skew hazard that aborts
// whole sync bundles (review round 4, H7), and it accordingly carries neither `additionalProperties`
// nor a tier enum. This comment used to claim otherwise (review round 5, N5). See
// `federation/outpost-binding.ts` clause (3) for the normative statement and the tests that check it
// in both directions.
// -------------------------------------------------------------------------------------------

/** An owner-ENTERED trust-posture assertion about an outpost — NOT derived, NOT negotiated with the
 *  outpost, and NOT connectivity. Extendable (new members are additive on a request union and are a
 *  new enum member on the response, which is why every response field carrying it is nullable and
 *  optional). CONNECTIVITY IS DELIBERATELY ABSENT: whether an outpost is air-gapped is a fact about
 *  its transport (`baseUrl`/`deliveryTarget`) and is derived separately — folding it in here would
 *  make one field mean two different things. Until an operator sets a tier there is NO value: the
 *  property is ABSENT from the object, never blank and never defaulted to `commercial`. */
/** THE MEMBERS COME FROM THE GLOSSARY, WHICH IS AUTHORITATIVE FOR VOCABULARY (CLAUDE.md). The trust
 *  tier IS the SECURITY DOMAIN (`docs/GLOSSARY.md` "security domain": "In CommanderSCP this is the trust
 *  tier"), whose values that entry and the stage grammar give as `commercial`, `govcloud`, `il5`,
 *  `airgap`, plus FedRAMP in prose; ADR-0011 says "FedRAMP-High / IL5 / air-gap". The first cut of this
 *  enum was `['commercial','fedramp-high','il5']`, which left a GOVCLOUD outpost with NO representable
 *  value — an operator had to leave the tier unknown or assert `commercial`, an INVENTED POSTURE, which
 *  is the exact failure this milestone exists to prevent. See ADR-0022 for the alignment and for the one
 *  open item (`fedramp-high` carries a hyphen, so it is not usable as a stage `<domain>` SEGMENT). */
export const OutpostTrustTierSchema = z.enum([
  "commercial",
  "govcloud",
  "fedramp-high",
  "il5",
  "airgap"
]);
export type OutpostTrustTier = z.infer<typeof OutpostTrustTierSchema>;

/** `POST /federation/outposts` — declare the commander-origin config object for an ALREADY-PAIRED
 *  outpost peer. Carries no transport field of any kind: the peer row is the authority for those.
 *
 *  `.strict()` IS THE REFUSAL THE DOCS ALREADY PROMISED (review round 5, N6). Zod's default object
 *  parse SILENTLY STRIPS an unknown key, so `{peerDomainId, trustTier, somePhaseBProperty}` answered
 *  **201** and stored `{trustTier, peerDomainId}` — nothing false was stored, but a NEWER CLIENT
 *  writing a phase-B property to an OLDER commander got a success and watched its field vanish with
 *  no signal. That is a real hazard for a federated product whose whole point is version skew across
 *  domains, and drizzle/0043, ADR-0022 and `outpost-binding.ts` all described a refusal the operator
 *  never saw. An unknown key is now an actionable **400** naming the key. This costs nothing in
 *  forward-tolerance: the strictness is at the API, where an OPERATOR is typing; the REGISTERED JSON
 *  SCHEMA stays open so a REPLICA from a newer authority is still stored rather than aborting a whole
 *  sync bundle (H7 — that asymmetry is the entire design). */
export const CreateOutpostConfigRequestSchema = z.strictObject({
  /** The paired peer this config is ABOUT (its trust-domain id = `federation_peers.id`). The peer
   *  row must already exist and hold role `outpost`; an unbound id is refused, and a second config
   *  object for the same peer conflicts. Since pipeline-substrate-registry-scan.md §10.5 the second
   *  accepted value is THIS instance's own domain id (`GET /federation/self`) — the HQ OUTPOST
   *  (formerly 'co-located'; GLOSSARY, ADR-0021 D7) — accepted only from a `commander`-role instance (an outpost's own record is
   *  commander-declared and arrives replicated; any other role is a 400). */
  peerDomainId: z.string().uuid(),
  /** Display name for the config object. Defaults to the peer's own name. The object's URN is
   *  derived from `peerDomainId`, never from this, so renaming can never fork the binding. */
  name: z.string().min(1).max(200).optional(),
  /** Optional at creation ON PURPOSE — an operator who has not decided the tier yet must be able to
   *  create the object without one being invented for them. */
  trustTier: OutpostTrustTierSchema.optional()
});
export type CreateOutpostConfigRequest = z.infer<typeof CreateOutpostConfigRequestSchema>;

/** `PATCH /federation/outposts/{peerDomainId}` — edit the commander-origin config. Absent means
 *  PRESERVE. `peerDomainId` is not patchable: the binding IS the object's identity.
 *
 *  `.strict()` for the same reason as the create body (review round 5, N6) — and it also makes the
 *  "not patchable" sentence above ENFORCED rather than merely stated: sending `peerDomainId` here now
 *  400s instead of being quietly dropped, which is a materially clearer answer for a client that
 *  believed it was re-binding the object. */
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
  /** Review round 4 — ORIGIN-VS-SELF, resolved server-side. `true` on the instance that AUTHORED this
   *  config (the commander); `false` for the read-only replica an outpost holds, and for any
   *  foreign-origin copy. `originDomainId` alone cannot answer this: a client would have to already know
   *  the reading instance's own domain id to compare against, and phase B would then be one join away
   *  from rendering someone else's copy as this instance's own assertion. */
  originIsSelf: z.boolean().optional(),
  /** pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST. `true` when `peerDomainId`
   *  is the READING instance's OWN trust domain (`federation_self.domainId`): the record describes
   *  this instance's own domain as an outpost (the commander-and-outpost-are-one case), and there is
   *  NO `federation_peers` row to join it to — every consumer that joins an outpost record to its
   *  peer row (peer name, role, transport, sync state) must render this record as "this instance"
   *  instead, taking name and role from `federation_self`. `false` for a record bound to a paired
   *  peer (a FIELD outpost — any outpost in another trust domain). Resolved server-side for the same reason `originIsSelf` is: a client would otherwise
   *  have to already know the reading instance's domain id. NOTE the two flags are independent — on
   *  an outpost site its own replica reads `originIsSelf: false` (the commander authored it) and
   *  `peerIsSelf: true` (it is about this domain). Optional for additivity. */
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

/**
 * THE RECONCILE PRECONDITION TOKEN — one `objectId:version` pair per live claimant the caller
 * PREVIEWED, sent as the repeatable `?ifClaimant=` query parameter (optimistic concurrency).
 *
 * WHY A PAIR AND NOT A BARE ID. Reconcile's outcome is derived from the set of live `outpost` rows
 * bound to one peer, read INSIDE the write transaction — i.e. after whatever the caller previewed.
 * Three things can change in that window and all three change the outcome:
 *   * a claimant APPEARS — a new id enters the set (a locally-authored row can then outrank the
 *     shadow the operator meant to adopt, silently DROPPING their entered value);
 *   * a claimant DISAPPEARS — an id leaves the set (soft-deleted elsewhere);
 *   * a claimant's ORIGIN/PROVENANCE CHANGES — the id is UNCHANGED, so ids alone are blind to it,
 *     yet a shadow adopted in the meantime is no longer a shadow and no longer ranks last.
 * `version` catches the third: every writer of `objects` that can restamp `originDomainId` or clear
 * `provenance` bumps `version` unconditionally (`graph/objects-repo.ts` — adoption is `updateObject`
 * with `existing.version + 1`). `revision` would NOT do: it is AUTHOR-assigned on the import path,
 * so it is not locally monotone.
 *
 * Both halves are already on {@link OutpostConfigSchema}, so the token is constructible from exactly
 * the array `GET /federation/outposts` returned — no second fetch, no new read-side field, and the
 * request stays CHECKABLE against the preview that was rendered beside it (which an opaque digest or
 * a server-minted ETag would not be).
 */
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

/** `POST /federation/outposts/{peerDomainId}/reconcile` — THE RECOVERY VERB (review round 4). Restores
 *  the 1:1 peer↔config binding for a peer whose database holds duplicates: keeps the authoritative row,
 *  ADOPTS an unverified hand-filled shadow when nothing authoritative survives (so entered config is not
 *  discarded), and removes the remaining surplus rows. Refuses with **409 Conflict** rather than touch a
 *  signature-verified replica — the peer demonstrably HAS config on that path (`GET` answers 200 for it),
 *  so a 404 would tell a status-keyed consumer "no outpost config" and hide the very authority conflict
 *  this door exists to surface. 404 is reserved for the peer that genuinely has no rows at all.
 *
 *  `?keep=<objectId>` (review round 5, N9) names the row that should SURVIVE — absent keeps the most
 *  authoritative one, so the default call is unchanged. It exists to close the VERIFIED-DUPLICATE
 *  class: a signature-verified foreign-origin duplicate bound to one peer had no public-API recovery
 *  at all (PATCH 409, reconcile refuses, `DELETE /objects/outpost/{id}` 403, IaC prune touches only
 *  stack-managed objects). Not reachable in canonical hub-and-spoke, but reachable the moment two
 *  authoring domains describe one outpost. With `keep`, this domain can DELETE THE ROW IT AUTHORED
 *  ITSELF — an ordinary journaled tombstone, re-declarable at any time. Deleting a signature-verified
 *  replica stays refused unconditionally: that is what stops this trading a config wedge for a sync
 *  wedge. See `federation/outposts-repo.ts`'s `reconcileOutpostConfig`.
 *
 *  `removedObjectIds` WAS ONE BUCKET (review round 6, M1) and that bucket LIED for the local-origin
 *  case `?keep=` exists to serve: a removal it reported as an "unverified shadow" tidy-up is, for a
 *  row THIS domain authored, an ordinary JOURNALED TOMBSTONE that propagates downstream to the outpost
 *  — ordinary local config being permanently dropped and pushed onward, not a stray hand-typed copy
 *  being discarded. The two cases are split into two fields so a caller (the CLI, and any future UI)
 *  cannot collapse them back into one indistinguishable sentence. */
export const OutpostConfigReconcileResultSchema = z.object({
  /** The single row that now holds the binding. */
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

/**
 * THE STALE-PRECONDITION REFUSAL BODY — `412 Precondition Failed` from
 * `POST /federation/outposts/{peer}/reconcile` when the `?ifClaimant=` set does not match the live
 * claimants read inside the transaction.
 *
 * 412, NOT A SECOND 409. The 409 on this route is the AUTHORITY CONFLICT and it is PERMANENT until
 * the operator chooses differently (`?keep=`); staleness is TRANSIENT and retryable after a
 * re-preview. Collapsing both onto one status turns "choose differently" into "look again, then
 * press the same button" — and consumers here key on status alone. 412 is also already the house's
 * optimistic-concurrency refusal (`updateObject`'s `expectedVersion`). NOT 428: the precondition is
 * optional by design, so the server must never demand one.
 *
 * `claimants` IS THE POINT. A bare refusal would force a second read and open a second window; the
 * refusal carries the FRESH claimant list so a caller CAN re-render a real preview from the same
 * response, then re-issue with a fresh token, without a second read. It is an RFC 9457 extension
 * member, like the in-house `decision_id`.
 *
 * NOT EVERY CALLER TAKES THAT OFFER (R3, PR #156 residual). `scp federation outpost reconcile`
 * (`packages/cli/src/cli.ts`) does: it re-previews straight from this body. The Outposts web panel
 * (`apps/web/src/routes/outpost-configuration.tsx`) does not — it treats the 412 as a signal to
 * refetch the list instead, deliberately paying the second round trip this field exists to save. */
export const OutpostReconcileStaleProblemSchema = ProblemSchema.extend({
  /** Every live `outpost` config row bound to the peer AT THE MOMENT OF REFUSAL, most authoritative
   *  first — the same projection `GET /federation/outposts` returns, so a caller can re-derive the
   *  token from it directly.
   *
   *  OPTIONAL, not required (R1 fix, PR #156 residual). This route today only ever throws
   *  `preconditionFailed` with the extension attached (`assertClaimantsUnchanged`), so `claimants`
   *  is always present in practice — but the SERIALIZER, not the throw site, is what decides
   *  whether a 412 reaching this handler is honest. `updateObject`'s bare `expectedVersion` 412 is
   *  unreachable here today only because reconcile never passes one (a prose argument, checked by
   *  `apps/server/src/routes/federation-reconcile-412-schema.test.ts`, not a type-level one), and
   *  the neighbouring verb already plumbs `expectedVersion` end to end — one refactor away. A
   *  REQUIRED field turned that latent
   *  reachability into a 500: zod's response serializer drops a response that fails to validate
   *  against its schema, and fastify has nothing else to fall back to. Optional means a bare 412
   *  still serializes as 412, with no `claimants` array, which is the honest shape of a refusal
   *  that never got the extension. */
  claimants: z.array(OutpostConfigSchema).optional()
});
export type OutpostReconcileStaleProblem = z.infer<typeof OutpostReconcileStaleProblemSchema>;

// -------------------------------------------------------------------------------------------
// M16.2 phase A (E4) — THE NARROW PEER PATCH. `POST /federation/peers` (pair/re-pair) is the only
// peer write there was, and it is a FOOTGUN for a settings form: `publicKey` is REQUIRED there, and
// a DIFFERENT value is treated as a KEY ROTATION that supersedes the current key window and
// hard-revokes the old key (sequence-anchored, `peers-repo.ts`). A UI that round-trips a peer and
// re-pairs it therefore rotates the peer's trust anchor whenever it drops or mangles the key.
//
// This request body admits NO KEY MATERIAL AT ALL — not `publicKey`, not `cosignPublicKey` — so the
// PATCH route is STRUCTURALLY incapable of rotating, superseding or revoking a peer key. `role` is
// likewise absent: a peer's federation role is an identity-level assertion established at pairing,
// not a settings-form field. Every field is optional and ABSENT MEANS PRESERVE (the same tri-state
// discipline re-pair uses); `deliveryTarget: null` explicitly CLEARS back to the instance-env
// fallback. Key rotation stays exactly where it was — a deliberate re-pair.
// -------------------------------------------------------------------------------------------

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
  /** M16.1 (I1) — the `.scpbundle`'s Ed25519 checksum, the ONLY per-change handle this ledger has
   *  (it carries no change/component column). A promotion bundle is 1:1 with a change, and both
   *  the exporting and the receiving instance stamp this same value onto that change's `sourceRef`
   *  (`federation/boundary-bundle-ref.ts`), which is how the boundary segment answers "which
   *  transfers carried THIS change?". Optional/additive — absent for a pre-M16.1 SDK's reads and
   *  null on a row recorded without one. Observational only; never authority. */
  checksum: z.string().nullable().optional(),
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
  /** M14.4 (ADR-0009) — LIVE-PULL FRESHNESS. All optional/additive (an old SDK is unaffected) and
   *  nullable ("never"). `lastPullAttemptAt` is stamped on EVERY attempt, `lastPullSuccessAt` only
   *  on a successful import — so an attempt with no later success is a peer in the RECONNECT LEG
   *  (back on the frequent cadence until one pull succeeds). Distinct from `lastSyncedAt`, which is
   *  the last confirmed BUNDLE TRANSFER (the file/air-gap channel), and from `lastAppliedSequence`,
   *  which is applied progress — neither records that a pull was ATTEMPTED. */
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
  // -----------------------------------------------------------------------------------------
  // M16.2 phase A (E3) — PENDING-VS-APPLIED, HONESTLY. Every field below is optional/additive and
  // nullable ("no observation"), and every NAME says what it MEASURES.
  //
  // THE ONE-SIDED DERIVATION (the reason there is no `appliedAtPeer` field here, and never will be
  // until M16.4 builds one): `sync_cursors` records only what WE applied FROM a peer, never what a
  // peer applied FROM US; `export-repo.ts` ships only this domain's own entries, so a return bundle
  // cannot carry our sequences back; and `bundle_transfers` has no production UPDATE path, so every
  // EXPORT row is inserted `created` and never advances. The strongest honest commander-side
  // statement is therefore PENDING-EXPORT — "this much of my own journal has not been put into a
  // bundle addressed to that peer yet" — which says NOTHING about what the peer applied. A field
  // named for application at the peer would be a fabrication, so there isn't one.
  // -----------------------------------------------------------------------------------------
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
  /** Review round 4 — WHOSE assertion `trustTier` is, so a UI cannot render a hand-typed claim as a
   *  commander one. `"declared"` = the winning `outpost` object is authoritative for this instance (its
   *  own local-origin object on a commander; the signature-verified commander replica on an outpost).
   *  `"unverified"` = the only tier available comes from a `provenance:'manual'` hand-filled SHADOW; the
   *  value still rides the wire, and `"trustTier"` is ALSO listed in `unknownFields`. `null` = no tier.
   *  With two rows bound to one peer the authoritative one always wins — this used to be a
   *  last-write-wins map, in which a shadow could silently override the commander's own assertion. */
  trustTierProvenance: z.enum(["declared", "unverified"]).nullable().optional(),
  /** THE CONFIGURED TRANSPORT CHANNEL — config-derived, never an observation, and named for that
   *  (review round 4 replaced a `connectivity` field whose `"connected"` value asserted reachability
   *  this instance had not observed). `"dialable"` = an https/mTLS `baseUrl` is configured, so this side
   *  MAY dial the peer — it does NOT mean the peer has ever been reached; `lastPullAttemptAt`/
   *  `lastPullSuccessAt`/`effectiveCadence` in this same row are the observations, and they do reflect
   *  failure. `"air-gap"` = NO base URL and a configured `deliveryTarget` (a file/object channel).
   *  `null` = not honestly derivable, declared in `unknownFields`, in two cases: no transport configured
   *  at all, or a base URL federation refuses to dial (plain http) — which is a contradictory
   *  configuration to surface, not an air-gap posture to infer. */
  transportMode: z.enum(["dialable", "air-gap"]).optional().nullable(),
  /** The fields of THIS peer-status row whose values this instance CANNOT OBSERVE, by name — the
   *  same honesty contract `ServiceBoardRowSchema.unknownFields` established. A listed field still
   *  carries its null/zero on the wire for shape stability, but that value is NOT an observation and
   *  a client must render it as unknown, never as a clean reading.
   *
   *  Optional for additivity; an old SDK simply never sees it. Names that appear here include
   *  `"trustTier"` (never asserted, unrecognised, or only an unverified hand-filled claim),
   *  `"transportMode"` (no transport configured, or one federation refuses to dial),
   *  `"lastSyncedBundleChecksum"`/`"lastExportedBundleChecksum"` (no identified bundle),
   *  `"pendingExportEntryCount"` (nothing exported yet), and `"healthRollup"` — a promised Overview
   *  field with NO source in this codebase at all, hence ABSENT from the schema and named here so a
   *  UI cannot mistake its absence for "healthy". */
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
  /** pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST RECORD: the `outpost` config
   *  object whose `peerDomainId` is `self.domainId`, resolved by the same authority rule
   *  `GET /federation/outposts/{peerDomainId}` applies (`peerIsSelf: true` on it). It has NO peer
   *  row, so it can never appear in `peers[]`; this is where a client reads it. `null` = this
   *  instance's own domain has no outpost record (a stated absence — a client says "no outpost
   *  registered", never invents one); absent = an older server that does not resolve it. On an
   *  OUTPOST site this is that site's own replica of its config (`originIsSelf: false`). Optional
   *  for additivity. */
  selfOutpost: OutpostConfigSchema.nullable().optional(),
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

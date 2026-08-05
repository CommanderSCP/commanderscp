import { z } from "zod";
import {
  ChangeRequirementSchema,
  CursorPageQuerySchema,
  StageDependencySchema,
  cursorPageResponseSchema
} from "./common.js";
import { ControlRunSchema } from "./governance.js";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";

/**
 * M3 Change Coordination Engine wire contract (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3).
 * The state machine's legal-edge DATA lives server-side (coordination/transitions.ts +
 * drizzle/0007's `state_transitions` seed) — this file only carries the enum for wire validation.
 */
export const ChangeStateSchema = z.enum([
  "proposed",
  "evaluated",
  "coordinated",
  // M12 P4B: a change with unsatisfied cross-change prerequisites (`properties.requires`) parks HERE
  // instead of entering `executing`, and is released to `executing` the moment every prerequisite is
  // satisfied. A change with no `requires` never enters this state (goes coordinated -> executing as
  // before), so this is additive and behaviour-preserving.
  "waiting",
  "executing",
  "validating",
  // ADR-0021 D5: this value was spelled `promoted` before 2026-07-25. The change-lifecycle
  // APPROVAL GATE is an `accept` — a human decision ABOUT A CHANGE, not an artifact advancing.
  // "Promotion" keeps its genus meaning everywhere else (Promotion Bundle, the `scp federation
  // promote` export verb, cross-domain promotion); see docs/GLOSSARY.md.
  "accepted",
  "cancelled",
  "rolled_back"
]);
export type ChangeState = z.infer<typeof ChangeStateSchema>;

export const ChangeSchema = z.object({
  id: z.string().uuid(), // = the underlying graph object's id (changes.object_id)
  orgId: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  state: ChangeStateSchema,
  sourceKind: z.string().nullable(),
  sourceRef: z.record(z.string(), z.unknown()).nullable(),
  correlationKey: z.string().nullable(),
  emergency: z.boolean(),
  importedFromDomain: z.string().uuid().nullable(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  rollbackOfObjectId: z.string().uuid().nullable(),
  rollbackTriggerReason: z.string().nullable(),
  /**
   * WHO cancelled this change (migration 0053). `system` = the engine auto-cancelled it (today: a
   * plan that would not compile); `user` = a human called cancel. NULL when the change is not
   * cancelled, or was cancelled before this column existed — deliberately not backfilled, because
   * inferring it from the old free-text reason would fabricate a fact.
   *
   * Optional in the contract so a pre-0053 server's response still validates against this schema.
   */
  cancellationKind: z.enum(["system", "user"]).nullable().optional(),
  stateEnteredAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  watchdogFlaggedAt: z.string().datetime().nullable(),
  properties: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * M16.3 P2 (additive) — the underlying graph object's `origin_domain_id` (`objects.
   * origin_domain_id`, same field `GraphObjectSchema.originDomainId` carries for every other
   * typed resource, and the SAME authoritative field `coordination/service-board.ts`'s
   * `drivenHere`/`originDomainId` are already derived from — NOT `importedFromDomain` above,
   * which is a narrower "which peer's promotion bundle did THIS import come through" stamp, set
   * only on promotion-imported changes (federation/promotion-repo.ts), not the general
   * single-writer-authority origin every object carries).
   *
   * `originDomainId` was missing from the wire `Change` shape entirely before this — the ONLY
   * SDK-reachable domain-identity field on a change was `importedFromDomain`, which is null for
   * every plain (non-promotion-bundle) federation-synced change, so a UI could not tell "this
   * change is a read-only replica of another domain's change" from "this change was authored
   * here" without it. `federation.self()` (`GET /federation/self`) already gives a caller its OWN
   * domain id; comparing the two is what `apps/web`'s `isForeignOriginObject`
   * (`apps/web/src/lib/replica-origin.tsx`) uses to render the `ForeignOriginNotice` provenance
   * badge on `change-detail.tsx`. It is deliberately NOT used there to disable Accept/Rollback/
   * Cancel: `apps/server/src/federation/foreign-origin-writes.integration.test.ts` measured the
   * transition verbs answering a foreign-origin change identically to a local one in the same
   * state (never a single-writer refusal, in `proposed` or in `validating`), so a client-side
   * gate on this field would be simulating server enforcement that does not exist.
   *
   * Optional (not `.nullable()`) so it defaults to `undefined` — matching every other additive
   * `/v1` field (CLAUDE.md: "every new field must be OPTIONAL") — rather than forcing every
   * existing caller that builds a `Change`-shaped object by hand (tests, fixtures) to supply it.
   */
  originDomainId: z.string().uuid().optional()
});
export type Change = z.infer<typeof ChangeSchema>;

/**
 * `POST /changes` ("propose") — `targets` (>=1 idOrUrn) is the set of graph objects (usually
 * components/services/deployment-targets) this change acts on; the plan compiler
 * (coordination/plan-compiler.ts) derives wave order from their `depends_on` edges plus the
 * optional `topology`'s explicit wave groups.
 */
// M12 P4B: `ChangeRequirementSchema` (one coupled-pipeline prerequisite `{key, at}`, see
// `CreateChangeRequestSchema.requires`) moved to common.ts so executors.ts's
// `ChangeReportRequestSchema` reuses the EXACT same shape without an import cycle — it is still
// exported from `@scp/schemas` unchanged.

export const CreateChangeRequestSchema = z.object({
  name: z.string().min(1).max(200),
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
  sourceKind: z.string().optional(),
  sourceRef: z.record(z.string(), z.unknown()).optional(),
  correlationKey: z.string().optional(),
  emergency: z.boolean().optional(),
  /** Release-topology object id or URN to compile against (optional — falls back to pure toposort). */
  topology: z.string().optional(),
  /** WHICH pipeline this change rolls (M12 P4A) — the routing Type (ADR-0007), selecting each
   *  target's executor binding. Webhook-born changes inherit this from the matched `source_mappings`
   *  row and never set it here; this field is for a change proposed DIRECTLY against the API, which
   *  has no mapping to inherit from. Omitted means 'configuration' (the server default). */
  type: ExecutorTypeSchema.optional(),
  /** Coupled-pipeline keys this release MAKES TRUE at its own targets when it succeeds (M12 P4B).
   *  Opaque strings; a waiting change is released when some OTHER change provides every key it
   *  requires. Omitted/empty ⇒ this release is a prerequisite for nothing. */
  provides: z.array(z.string().min(1)).optional(),
  /** Cross-change prerequisites (M12 P4B): this release WAITS until, for each entry, some other
   *  change with state validating|accepted `provides` that `key` at that `at` object. `at` is an id
   *  or URN resolved at propose time (a bad ref is a 404, never a silent forever-wait). Omitted/empty
   *  ⇒ no wait; the change goes coordinated→executing as before. */
  requires: z.array(ChangeRequirementSchema).optional(),
  /** Stage-scoped component couplings (ADR-0028): components this release's component must not
   *  deploy AHEAD OF at a shared place. Each entry's `dependsOn` and `atTargets` are ids or URNs
   *  resolved at propose time (a bad ref is a 404, never a silent forever-wait) and stored resolved
   *  in `properties.stageDependencies`. Omitted/empty ⇒ nothing holds this release's triggers.
   *
   *  `.optional()` and NOT `.default([])`: a Zod default renders the property REQUIRED in the
   *  generated SDK type, which oasdiff scores as a /v1 break. */
  stageDependencies: z.array(StageDependencySchema).optional(),
  /** Object ids or URNs this change targets — plan compiler input. */
  targets: z.array(z.string().min(1)).min(1)
});
export type CreateChangeRequest = z.infer<typeof CreateChangeRequestSchema>;

export const ChangeListQuerySchema = CursorPageQuerySchema.extend({
  state: ChangeStateSchema.optional()
});
export type ChangeListQuery = z.infer<typeof ChangeListQuerySchema>;

export const ChangeListResponseSchema = cursorPageResponseSchema(ChangeSchema);
export type ChangeListResponse = z.infer<typeof ChangeListResponseSchema>;

export const ChangeIdParamSchema = z.object({ id: z.string().uuid() });

/** `POST /changes/{id}:cancel` and other reason-carrying transition triggers. `overrideFreeze`
 *  (DESIGN §10.3, M4): attempts to override an active freeze blocking this transition — requires
 *  `freeze:override` permission AND a non-empty `reason` (the same field, doing double duty as
 *  the freeze override's mandatory reason). */
export const ChangeTransitionRequestSchema = z.object({
  reason: z.string().optional(),
  overrideFreeze: z.boolean().optional()
});
export type ChangeTransitionRequest = z.infer<typeof ChangeTransitionRequestSchema>;

/** `POST /changes/{id}:rollback` — DESIGN §9.4: "every rollback writes a Decision naming its trigger". */
export const RollbackChangeRequestSchema = z.object({
  reason: z.string().min(1)
});
export type RollbackChangeRequest = z.infer<typeof RollbackChangeRequestSchema>;

// -------------------------------------------------------------------------------------------
// Decision records (DESIGN §10.4)
// -------------------------------------------------------------------------------------------

export const DecisionSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: z.string(),
  subjectId: z.string().uuid(),
  verdict: z.string(),
  inputContext: z.record(z.string(), z.unknown()),
  reasonTree: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionIdParamSchema = z.object({ id: z.string().uuid() });
export const DecisionListQuerySchema = CursorPageQuerySchema.extend({
  subjectId: z.string().uuid().optional()
});
export type DecisionListQuery = z.infer<typeof DecisionListQuerySchema>;
export const DecisionListResponseSchema = cursorPageResponseSchema(DecisionSchema);
export type DecisionListResponse = z.infer<typeof DecisionListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Plan -> waves -> wave_targets (DESIGN §9.3) — read model for the UI wave-progression view and
// `scp change explain`.
// -------------------------------------------------------------------------------------------

export const ChangeWaveTargetSchema = z.object({
  id: z.string().uuid(),
  waveId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  targetUrn: z.string().optional(),
  targetName: z.string().optional(),
  /** WHICH pipeline this target rolls (M12 P4A) — the routing Type (ADR-0007), snapshotted from the
   *  change at plan time, so it selects the target's executor binding at trigger AND status-poll
   *  time. Plans predating the Type cutover read back as 'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  executorPluginId: z.string().nullable(),
  executorRef: z.record(z.string(), z.unknown()).nullable(),
  /** The snapshot reconcile observed from status() — the per-wave version (ADR-0008 decisions 1-2).
   *  Additive-optional: plans predating the `observed_state` column read back without it; `null` once
   *  observed with nothing. `revision` is the opaque stateRef as-is (a git SHA / Argo revision).
   *  `images` (P4C increment 3) is the deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or
   *  `...@sha256:...`) — the human-facing per-wave version, preferred over the git SHA in the UI.
   *  `rollout` (P4D increment 4) is the OBSERVE-ONLY progressive-delivery snapshot (an Argo Rollout's
   *  phase/step/weight/message as the executor reports it) — display-only; SCP never drives it
   *  (ADR-0008: rollout state is OBSERVED, NOT DRIVEN). Every field is optional (only phase/message
   *  are reliably available; step/weight need the live manifest and are version-dependent). */
  observed: z
    .object({
      revision: z.string().optional(),
      images: z.array(z.string()).optional(),
      rollout: z
        .object({
          phase: z.string().optional(),
          step: z.number().optional(),
          weight: z.number().optional(),
          message: z.string().optional()
        })
        .optional()
    })
    .nullable()
    .optional(),
  status: z.string(),
  attempt: z.number().int(),
  lastObservedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChangeWaveTarget = z.infer<typeof ChangeWaveTargetSchema>;

export const ChangeWaveSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  requiresFanIn: z.boolean(),
  status: z.string(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  targets: z.array(ChangeWaveTargetSchema)
});
export type ChangeWave = z.infer<typeof ChangeWaveSchema>;

export const ChangePlanSchema = z.object({
  id: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  topologyObjectId: z.string().uuid().nullable(),
  topologyVersion: z.number().int().nullable(),
  status: z.string(),
  createdAt: z.string().datetime(),
  waves: z.array(ChangeWaveSchema)
});
export type ChangePlan = z.infer<typeof ChangePlanSchema>;

/** `GET /changes/{id}:explain` — the change, its compiled plan (if any), every Decision made
 *  about it, and every control run evidence persisted against it (DESIGN §10.4: a Decision's
 *  reasonTree names WHICH control fired and what its outcome status was — `contributingPolicyVersions`
 *  and each `requireControls` effect's `detail.controlObjectId`/`detail.outcome` — but the actual
 *  EVIDENCE payload only ever lives on `control_runs`; M4 adds this array so `scp change explain`
 *  can reconstruct "policy version + control outcome + evidence" end to end, not just the first two). */
/** One cross-change prerequisite's live status (M12 P4B Phase 4), for `explain`'s wait-status view. */
export const ChangeRequirementStatusSchema = z.object({
  key: z.string(),
  /** The object id the key must be provided at. */
  at: z.string().uuid(),
  /** The object's display name, for a readable "Waiting on …" surface (null if it can't be resolved). */
  atName: z.string().nullable(),
  satisfied: z.boolean(),
  /** The change (validating|accepted) currently providing this key at `at`, or null while outstanding. */
  satisfiedByChangeId: z.string().uuid().nullable(),
  /** M12 P4B Phase 4 "did you mean" (coupled-pipelines.md §3.7): while UNSATISFIED, the `provides`
   *  keys some change has actually declared at this `at` object — an exact, scoped diagnosis (not a
   *  prefix guess) for a typo'd key. `.optional()`, present only when unsatisfied and non-empty;
   *  absent once satisfied (the question is moot) and for every pre-Phase-4 explain caller. */
  didYouMean: z.array(z.string()).optional()
});
export type ChangeRequirementStatus = z.infer<typeof ChangeRequirementStatusSchema>;

/** A change's coupled-pipeline wait status (M12 P4B Phase 4). Present on `explain` for any change
 *  that declared `requires`; null otherwise. `waiting` reflects the change's current state. */
export const ChangeWaitStatusSchema = z.object({
  waiting: z.boolean(),
  requirements: z.array(ChangeRequirementStatusSchema),
  /** M12 P4B fail-closed (coupled-pipelines.md §6#14): stored `requires` entries that do NOT parse
   *  as `{key, at}` (federation peer skew, a legacy row, or raw-SQL corruption — propose-time typed
   *  validation refuses them, so they can only arrive PAST the API). A change carrying any is
   *  UNSATISFIABLE: it parks in `waiting` (the watchdog SLA flags it) rather than proceeding as if
   *  uncoupled, and the offending entries are surfaced here verbatim so an operator can see exactly
   *  what to fix. `.optional()` not `.default()` — additive, absent for every well-formed change. */
  malformed: z.array(z.unknown()).optional()
});
export type ChangeWaitStatus = z.infer<typeof ChangeWaitStatusSchema>;

// -------------------------------------------------------------------------------------------
// M16.1 — THE UNIVERSAL BOUNDARY SEGMENT (ADR-0011; ADR-0021 D6 vocabulary).
//
// A boundary SEGMENT of the component pipeline, composed of two boundary PHASES — *transferred*
// and *validated*. NOT a "stage" (a stage is a deployment PLACE, `<domain>[-<location>]-<env>`) and
// NOT a "wave" (a wave is the set of stages advanced at once). The segment renders REAL local
// observations plus an explicit not-yet-verified/not-reported state, NEVER a fabricated pass, and
// it DRIVES NOTHING (coordinate-not-execute — this is Layer-B observe-enrichment, ADR-0008,
// applied to the federation boundary rather than to an executor).
// -------------------------------------------------------------------------------------------

/** One observed hop of the bundle-transfer ledger that carried this change (`bundle_transfers`).
 *  Every field is a row this instance actually wrote — the ledger is INSERT-only and per-instance,
 *  so these are strictly THIS side's observations of the handoff, never the far side's. */
export const BoundaryTransferHopSchema = z.object({
  direction: z.enum(["export", "import"]),
  status: z.enum(["created", "submitted", "confirmed"]),
  /** The peer this hop was recorded against (TRUST sense, ADR-0021 D4). */
  peerDomainId: z.string().uuid(),
  /** The bundle's Ed25519 checksum — the value that joins this hop to the change (M16.1 I1). */
  checksum: z.string().nullable(),
  observedAt: z.string().datetime()
});
export type BoundaryTransferHop = z.infer<typeof BoundaryTransferHopSchema>;

/** The TRANSFERRED phase.
 *
 *  `exported` — this instance produced a promotion bundle for this change. It is the ONLY transfer
 *  statement an exporting instance can truthfully make: `bundle_transfers` has no UPDATE anywhere
 *  in the tree, and every `submitted`/`confirmed` row is written by a LATER hop's own database. So
 *  an exporting instance's row is and stays `created`, and whether the peer ever received the
 *  bundle is UNOBSERVABLE here — declared in `unknownFields` as `transfer.handoff`, never rendered
 *  as a delivered/confirmed handoff.
 *
 *  `received` — this instance imported and applied a promotion bundle for this change (a genuine
 *  local observation: the row is written in the same tx as the import).
 *
 *  `not_observed` — no ledger row here names any bundle that carried this change. */
export const BoundaryTransferPhaseSchema = z.object({
  state: z.enum(["exported", "received", "not_observed"]),
  hops: z.array(BoundaryTransferHopSchema),
  /** When this instance observed the most recent hop; null when `not_observed`. */
  observedAt: z.string().datetime().nullable()
});
export type BoundaryTransferPhase = z.infer<typeof BoundaryTransferPhaseSchema>;

/** The VALIDATED phase — the signature + scan-attestation verify at the RECEIVING outpost
 *  (ADR-0011: universal, commercial included), read from the M17.4(b) pre-deploy artifact-verify
 *  Decision this instance persisted.
 *
 *  `verified`   — an `allow` Decision of kind `pre-deploy-artifact-verify` exists HERE: a real
 *                 per-artifact cosign verification ran locally and every authorized artifact was
 *                 present and authentic. (Only recordable since M16.1 I2 — a passing verify used
 *                 to write nothing at all.)
 *  `refused`    — a `block` Decision exists here; `decisionId` carries the "why" (principle 6).
 *  `not_yet_verified` — this instance RECEIVED the change and its verify has not produced a verdict
 *                 yet (or had nothing to verify — a metadata-only promotion deliberately records
 *                 no verdict rather than a vacuous pass). An honest absence, not a failure.
 *  `not_reported` — this instance is NOT the receiving side. Validation happens at the receiving
 *                 outpost and there is NO data path carrying its outcome back: federation journal
 *                 entry kinds are lifecycle/graph-shaped, none is verification-shaped, and audit
 *                 segments are discarded on import. The exporting instance therefore says exactly
 *                 that, and `unknownFields` names `validate.state`. It is never `verified` here. */
export const BoundaryValidatePhaseSchema = z.object({
  state: z.enum(["verified", "refused", "not_yet_verified", "not_reported"]),
  /** The Decision behind `verified`/`refused` — every verdict is explainable (principle 6). */
  decisionId: z.string().uuid().nullable(),
  observedAt: z.string().datetime().nullable(),
  /** How many artifacts the verdict's AUTHORIZED SET held — the set the gate was asked to check,
   *  read off the Decision's `inputContext.authorizedArtifacts`. Deliberately NOT named
   *  "verified": on a `refused` verdict the authorized set still has entries and some or all of
   *  them are precisely the ones that FAILED, so a "verified" count there would report unverified
   *  artifacts as verified — the exact claim class this segment exists to prevent, on the API,
   *  which is the parity surface (charter principle 3).
   *
   *  `null` when there is no verdict at all, AND on `refused`: a refusal's honest artifact story is
   *  the block Decision's `failing` list, not a bare number that reads as progress. So a non-null
   *  value here occurs only alongside `state: "verified"`, where authorized == verified by
   *  construction (the gate returns `ok` only when every authorized artifact passed).
   *  `null` — never 0 — is also what a malformed/absent `inputContext` yields, so a client can
   *  distinguish "no count available" from "a verdict over zero artifacts". */
  authorizedArtifactCount: z.number().int().nullable()
});
export type BoundaryValidatePhase = z.infer<typeof BoundaryValidatePhaseSchema>;

/** The two-phase boundary segment for one change. `unknownFields` follows the established honesty
 *  shape (`ServiceBoardRowSchema.unknownFields`): every listed dotted path still carries its zero
 *  value on the wire for shape stability, but that zero is NOT an observation and a client must not
 *  render it as one. */
export const BoundarySegmentSchema = z.object({
  transfer: BoundaryTransferPhaseSchema,
  validate: BoundaryValidatePhaseSchema,
  unknownFields: z.array(z.string())
});
export type BoundarySegment = z.infer<typeof BoundarySegmentSchema>;

export const ChangeExplainResponseSchema = z.object({
  change: ChangeSchema,
  plan: ChangePlanSchema.nullable(),
  decisions: z.array(DecisionSchema),
  controlRuns: z.array(ControlRunSchema),
  /** Cross-change coupling status (M12 P4B): null when the change declared no `requires`. */
  waitStatus: ChangeWaitStatusSchema.nullable(),
  /** M16.1 — the boundary segment. `null` for a change that has NOT crossed a domain boundary:
   *  absent, deliberately not a fabricated empty pass. Optional/additive within /v1 — a pre-M16.1
   *  SDK reading a new response is unaffected, and an old server's response is valid here. */
  boundarySegment: BoundarySegmentSchema.nullable().optional()
});
export type ChangeExplainResponse = z.infer<typeof ChangeExplainResponseSchema>;

// -------------------------------------------------------------------------------------------
// Change sources / webhook ingress (DESIGN §8 "persist-then-process", §9.2 correlation)
// -------------------------------------------------------------------------------------------

export const SourceMappingSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  sourceKind: z.string(),
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  componentObjectId: z.string().uuid(),
  /** WHICH pipeline releases from this source roll (M12 P4A) — the routing Type (ADR-0007). NOT
   *  inferable from `sourceKind` — a GitHub Actions run can apply Terraform or ship an app — so the
   *  operator declares it per mapping. Mappings predating the Type cutover read back as
   *  'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  createdAt: z.string().datetime()
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const CreateSourceMappingRequestSchema = z.object({
  sourceKind: z.string().min(1),
  repoPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  component: z.string().min(1), // idOrUrn
  /** The routing Type (ADR-0007). Omitted means 'configuration' (defaulted server-side in
   *  `source-mappings-repo.ts`). `.optional()` not `.default()`: a default renders the property
   *  REQUIRED in the generated SDK request type, an unnecessary extra request-shape break. */
  type: ExecutorTypeSchema.optional()
});
export type CreateSourceMappingRequest = z.infer<typeof CreateSourceMappingRequestSchema>;

/**
 * `DELETE /change-sources/{sourceKind}/mappings` body — the full IDENTITY TUPLE, not an id.
 *
 * `source_mappings` has no unique constraint and `POST /discovery/accept` inserts
 * unconditionally, so an estate can hold several byte-identical rows (the homelab does). A by-id
 * delete would remove one and leave the survivor still correlating — the operator would see the
 * mapping "deleted" and a push would still route to it. Matching the tuple removes every row that
 * says the same thing, which is the same reasoning `deleteSourceMappingsMatching` was written with
 * for IaC prune.
 *
 * `repoPattern`/`pathPattern` are NULLABLE rather than optional: a NULL pattern is meaningful (it
 * means "match any"), so absent and null must be distinguishable — omitting one would otherwise
 * silently target a different row than the caller sees in the list.
 */
export const DeleteSourceMappingRequestSchema = z.object({
  component: z.string().min(1), // idOrUrn
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  type: ExecutorTypeSchema.optional()
});
export type DeleteSourceMappingRequest = z.infer<typeof DeleteSourceMappingRequestSchema>;

/** How many rows the delete actually removed — 0 means nothing matched, which is NOT an error but
 *  is the answer an operator needs to see (a silent 204 would look like success). */
export const DeleteSourceMappingResponseSchema = z.object({ deleted: z.number().int().min(0) });
export type DeleteSourceMappingResponse = z.infer<typeof DeleteSourceMappingResponseSchema>;

export const SourceMappingListResponseSchema = cursorPageResponseSchema(SourceMappingSchema);
export type SourceMappingListResponse = z.infer<typeof SourceMappingListResponseSchema>;

/**
 * `POST /change-sources/{sourceKind}/webhook` body — a source-specific payload, kept verbatim
 * (`change_source_events.payload`, DESIGN §8 persist-then-process). M3 ships no per-provider
 * payload parsing (that's M7's real executor plugins); `coordination/webhook-processor.ts` reads
 * only the small, documented, provider-agnostic correlation hint (`repo`/`path`/
 * `correlationKey`) this schema's shape anticipates, but accepts (and persists) any JSON object.
 */
export const ChangeSourceWebhookBodySchema = z.record(z.string(), z.unknown());
export type ChangeSourceWebhookBody = z.infer<typeof ChangeSourceWebhookBodySchema>;

export const WebhookIngressResponseSchema = z.object({
  accepted: z.literal(true),
  eventId: z.string().uuid()
});
export type WebhookIngressResponse = z.infer<typeof WebhookIngressResponseSchema>;

export const ChangeSourceEventParamSchema = z.object({ sourceKind: z.string().min(1) });

/**
 * `PUT /change-sources/{sourceKind}/webhook-secret` (M7, DESIGN §12/BUILD_AND_TEST.md §8 M7) —
 * configures the HMAC signing secret `routes/change-sources.ts`'s webhook route requires and
 * verifies against once set (coordination/webhook-signature.ts). The plaintext secret is
 * write-only from the API's perspective: it is encrypted at rest immediately (secrets/crypto.ts)
 * and never echoed back by any endpoint.
 */
export const CreateWebhookSecretRequestSchema = z.object({
  secret: z.string().min(1)
});
export type CreateWebhookSecretRequest = z.infer<typeof CreateWebhookSecretRequestSchema>;

export const WebhookSecretConfiguredResponseSchema = z.object({
  configured: z.literal(true),
  sourceKind: z.string()
});
export type WebhookSecretConfiguredResponse = z.infer<typeof WebhookSecretConfiguredResponseSchema>;

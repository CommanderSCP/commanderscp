import { z } from "zod";
import {
  ChangeRequirementSchema,
  CursorPageQuerySchema,
  StageDependencySchema,
  cursorPageResponseSchema
} from "./common.js";
import { ControlRunSchema } from "./governance.js";
import {
  ExecutorTypeSchema,
  ExecutorCategorySchema,
  PipelineClassificationSchema,
  SourceMappingScopeSchema
} from "./executors.js";

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
  /**
   * When this change's own row last CHANGED — a transition, a `sourceRef` stamp, a park. It means
   * what its name says, and it is safe to render as "last modified".
   *
   * IT DID NOT ALWAYS. Until migration 0058 this column was also the reconcile engine's ROUND-ROBIN
   * CURSOR: `listChangeRowsInStates` served oldest-first capped at a batch limit, and five paths
   * re-stamped a change they had examined but could not advance, to send it to the back of the
   * queue. Those re-stamps are load-bearing — without them, more than one batch's worth of stuck
   * changes occupy every slot forever and everything behind them is never evaluated even once,
   * measured in production as 13 days of fully stopped coordination behind green health checks. But
   * sharing this field meant a change whose rollout had sat at the same canary weight for three
   * days, polled once a second, reported `updatedAt` of one second ago. The scheduler was talking
   * over the operator's only "last modified" signal, on exactly the changes an operator most needs
   * to look at.
   *
   * The cursor now has its own engine-owned column (`changes.reconcile_cursor_at`, beside
   * `reconcileBlockedAt` and `stateEnteredAt`), and it is deliberately NOT on the wire. It is a
   * queue position, not a fact about the change: a fresh cursor means the engine took this change's
   * turn, which is true of every healthy change every few ticks and says nothing an operator can
   * act on. Exposing it would re-create the misreading the split exists to end, one field over.
   * `/v1` is additive-only, so adding it later stays possible if a real caller ever needs it;
   * un-shipping it would not be.
   *
   * **For "how long has this been stuck", the field is still `stateEnteredAt`** — the round-robin
   * never touched it even when it shared this one, and the watchdog's stall SLA measures from it.
   * `updatedAt` answers a different question ("has anything about this change moved"), which the
   * split is what makes it able to answer honestly.
   */
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
  originDomainId: z.string().uuid().optional(),
  /**
   * M20-A3 (ADR-0031 §5) — mirrors `GraphObjectSchema.domainLocal`: `true` when this change's own
   * existence stays inside its own security domain (INHERITED from its targets at `proposeChange`,
   * never declared on the change itself — a change has no create-time locality checkbox of its
   * own). Gates every journal writer this change touches (`change_status`, the underlying object's
   * `object_upsert`), so a domain-local change never reaches a peer to be asked about.
   *
   * REQUIRED, not optional, following `GraphObjectSchema.domainLocal`'s exact precedent: a boundary
   * predicate has no unknown case, and every change row this instance can return already has this
   * computed at propose time — there is no legacy row lacking it the way `originDomainId` had to
   * accommodate.
   *
   * What it is FOR on the wire: disambiguating an absent `boundarySegment` (M16.1) — "no boundary
   * segment" is genuinely ambiguous between "domain-local, so there is nothing to cross" and
   * "ordinary change, just not promoted yet" without it. `change-detail.tsx`/`change-pipeline.tsx`
   * read it to render the same `DomainLocalBadge` objects already carry, and to branch the
   * `NoBoundarySegment` copy onto the honest reason instead of the generic one.
   */
  domainLocal: z.boolean()
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
  subjectId: z.string().uuid().optional(),
  /** Exact-match filter on `kind` (ADR-0028 increment 4) — `stage_dependency`, `watchdog`, `gate`, …
   *  Additive optional query parameter: an old client omits it and gets the unfiltered page it
   *  always got.
   *
   *  IT ANSWERS "which mechanism", NOT "what happened": several kinds carry more than one verdict
   *  against the same subject. `stage_dependency` in particular is written both as a `hold` (a
   *  trigger withheld — `reconcile.ts`) and as an `allow` (the declaration stripped on promotion
   *  import — `federation/promotion-repo.ts`), so on an outpost the newest row of that kind is an
   *  `allow` for a change that may well be held. Read the `verdict` on each row; a kind alone is not
   *  a state.
   *
   *  Usable WITHOUT `subjectId` on purpose — that is the whole point, the operator asking about a
   *  coupling does not have the change id — and drizzle/0056's `decisions_org_kind_created` is what
   *  makes that shape an index probe instead of the parallel seq scan it measured as. */
  kind: z.string().min(1).max(128).optional()
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
  /** The `ExternalRunRef` the executor's `trigger()` returned — plugin-shaped, opaque to SCP, and
   *  the handle `status()` is polled with.
   *
   *  BOUNDED, NOT VERBATIM (M23.1f), and unlike `observed` below it carries NO structured
   *  truncation signal — recorded here rather than left to be discovered. The reason is that the
   *  reader of this field is the PLUGIN, not an operator: a cut here is a broken handle, not a
   *  wrong thing on a screen, and the honest fix for that is refusing the write rather than
   *  describing the damage. See the note at `markWaveTargetTriggered` in `wave-targets-repo.ts`
   *  and M23.1g in BUILD_AND_TEST.md, where it is carried as still open. */
  executorRef: z.record(z.string(), z.unknown()).nullable(),
  /** The snapshot reconcile observed from status() — the per-wave version (ADR-0008 decisions 1-2).
   *  Additive-optional: plans predating the `observed_state` column read back without it; `null` once
   *  observed with nothing.
   *
   *  `revision` is the executor's stateRef (a git SHA / Argo revision), opaque to SCP — but NOT
   *  necessarily as-is, which is what this comment claimed until M23.1g and what M23.1f made false.
   *  Every string here passes a persistence bound before it becomes a row, so it may be SHORTENED
   *  (an elision marker mid-value) and the two code points `jsonb` refuses — U+0000 and lone
   *  surrogates — are replaced one-for-one by U+FFFD. `truncation` below says which fields that
   *  happened to; nothing else here does.
   *
   *  `images` (P4C increment 3) is the deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or
   *  `...@sha256:...`) — the human-facing per-wave version, preferred over the git SHA in the UI. It
   *  is a PREFIX of what the executor reported when `truncation.images` is present.
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
        .optional(),
      /** WHAT THE PERSISTENCE BOUND REMOVED, KEYED BY THE FIELD IT HAPPENED TO — M23.1g, and the
       *  reason `revision`/`images`/`rollout` above are readable at all rather than merely
       *  present.
       *
       *  ABSENT MEANS NOTHING WAS REMOVED. That is every honest reading and it is the only thing a
       *  consumer has to check: an entry exists only for a field that lost something.
       *
       *  `dropped: true` IS THE WHOLE POINT. A field the bound refused outright is simply not in
       *  `observed`, byte-identical to a field the executor never reported — so a UI that renders
       *  `observed.rollout ?? "no rollout"` states a cause that is FALSE, blaming the executor for
       *  a cut this platform made. Same class as the `no_weight` reason ADR-0028's gate reported
       *  (charter principle 6). Read this before you render an absence.
       *
       *  A CONSUMER MUST NOT PATTERN-MATCH THE STORED VALUE INSTEAD. The bound's markers
       *  (`__scpElided`, `[elided: N more entries]`) are content-shaped — a plugin can put those
       *  exact characters in a revision, and one of the bound's branches emits no marker at all —
       *  and they live in `@scp/runner-launcher`, which the UI does not and must not depend on.
       *  This field is the API's answer, which is what makes it API-first (charter principle 3).
       *
       *  ADDITIVE-OPTIONAL: rows written before M23.1g carry no key, which reads as "nothing was
       *  removed". That is not backfilled and cannot be — the removed content is gone. The key
       *  `__scpElided` can appear here when the report itself was too wide to list every field;
       *  its `droppedFields` is how many were not listed. */
      truncation: z
        .record(
          z.string(),
          z.object({
            /** The field is not in `observed` at all, and that is OUR doing. */
            dropped: z.boolean(),
            /** Characters removed from strings inside this field. */
            droppedCharacters: z.number().int().nonnegative().optional(),
            /** Array entries removed from lists inside this field. */
            droppedEntries: z.number().int().nonnegative().optional(),
            /** Object fields removed from objects inside this field. Their names are not
             *  recoverable below the root — the store keeps a count, not a list. */
            droppedFields: z.number().int().nonnegative().optional()
          })
        )
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
// ADR-0028 increment 4 — THE STAGE-DEPENDENCY WAIT STATUS.
//
// The `requires` wait status above and this one are DIFFERENT COUPLINGS and deliberately do not
// share a shape. `requires` is keyed on `{key, at}` and parks the WHOLE change in `waiting`; a
// stage dependency is keyed on (component x deployment-target) and withholds ONE wave target's
// trigger while the change stays `executing`. Widening `ChangeWaitStatusSchema` to carry both
// would have made `requirements[]` mean two things for its two existing consumers (the CLI's
// `printWaitStatusBody` and the web change-pipeline view), so this is a sibling field instead.
//
// READ LIVE, NEVER OFF THE PINNED DECISION (coupled-pipelines.md §3.6, and the reason
// `resolveWaitStatus` exists at all). `recordStageDependencyHold` writes a `hold` Decision and
// NOTHING ever writes a clearing row, so the newest `stage_dependency` row of a change that was
// briefly held, triggered, succeeded and reached `accepted` is still a `hold` — answering "is this
// held?" from that row would rebuild, on a read surface, precisely the permanent-marker bug the
// `hold` verdict was chosen to avoid. Every field below is re-derived at request time by
// `evaluateStageDependencies`, the same predicate reconcile runs.
// -------------------------------------------------------------------------------------------

/** Which branch of ADR-0028 decision 4 produced a verdict — mirrors `StageDependencyBranch`
 *  (`coordination/stage-dependency-hold.ts`), whose doc comment defines each one. Three satisfy
 *  (`not_placed`/`succeeded`/`min_weight`), three hold (`never_deployed`/`behind`/
 *  `weight_unreadable`), `undeclarable` holds an unparseable stored entry, and `unscopeable`/`self`
 *  record a coupling that had nothing to scope by / named its own declarer. */
export const StageDependencyBranchSchema = z.enum([
  "not_placed",
  "succeeded",
  "min_weight",
  "never_deployed",
  "behind",
  "weight_unreadable",
  "undeclarable",
  "unscopeable",
  "self"
]);
export type StageDependencyBranchWire = z.infer<typeof StageDependencyBranchSchema>;

/** One dependency's LIVE verdict at one place. The optional fields are optional for the same reason
 *  they are optional on the persisted verdict: they are echoes of a qualifier the declaration
 *  carried, and a change that declared none must not grow fields claiming otherwise. */
export const ChangeStageDependencyVerdictSchema = z.object({
  /** The component object id depended on — or, for an `undeclarable` entry, the raw stored entry
   *  rendered as JSON, because there was no parseable id to name. Not `.uuid()` for that reason. */
  dependsOn: z.string(),
  /** The dependency's display name, for a readable "held behind …" surface. Null when the id does
   *  not resolve to a live object (a deleted component, or an `undeclarable` entry's raw JSON). */
  dependsOnName: z.string().nullable(),
  branch: StageDependencyBranchSchema,
  satisfied: z.boolean(),
  /** Present only when this dependency came from a plain `depends_on` edge between two of this
   *  change's own targets rather than from the change's own declaration (ADR-0028 decision 6). The
   *  remedy differs — delete an edge, not edit a pipeline — so it has to be visible. */
  source: z.literal("edge").optional(),
  /** The status of the dependency's most recent wave target at this place, when it had one. */
  dependencyStatus: z.string().optional(),
  /** Echoed only when the declaration carried the qualifier. */
  minWeight: z.number().int().optional(),
  /** The declared `minWeight` was NOT applied, because a `depends_on` edge between two targets of
   *  this change asserts the stricter plain-`succeeded` test and a declaration may not weaken it. */
  minWeightSupersededByEdge: z.literal(true).optional(),
  /** Why a declared `minWeight` could not be read — mirrors `WeightUnreadableCause`. Present even on
   *  a verdict that went on to be SATISFIED by the universal `succeeded` test: the release proceeded,
   *  but not for the reason its author asked for. An unreadable weight never means "satisfied". */
  weightUnreadable: z.enum(["no_weight", "not_observed", "stale"]).optional(),
  /** The one-line operator sentence, from `describeStageDependencyHold` — the SAME function the hold
   *  Decision's `reasonTree.blocked` lines are built from, so the API and the audit record cannot
   *  drift into describing the same verdict differently. */
  summary: z.string()
});
export type ChangeStageDependencyVerdict = z.infer<typeof ChangeStageDependencyVerdictSchema>;

/** One wave target of the active wave that has not been triggered yet, and every dependency verdict
 *  that applies to it. Only `pending`/`triggering` targets appear: a target already handed to its
 *  executor is past the hold, and re-deciding its coupling would report a wait that is over. */
export const ChangeStageDependencyTargetSchema = z.object({
  targetObjectId: z.string().uuid(),
  targetName: z.string().nullable(),
  /** The (component, place) pair this wave target resolves to. BOTH null for a legacy-shaped target
   *  naming a component rather than a placement — the `unscopeable` fail-open, where there is no
   *  place for a stage-scoped hold to be scoped by and the declaration is NOT enforced. */
  componentObjectId: z.string().uuid().nullable(),
  componentName: z.string().nullable(),
  deploymentTargetObjectId: z.string().uuid().nullable(),
  deploymentTargetName: z.string().nullable(),
  /** True when at least one verdict here is unsatisfied — this target's trigger is being withheld
   *  right now. */
  held: z.boolean(),
  dependencies: z.array(ChangeStageDependencyVerdictSchema)
});
export type ChangeStageDependencyTarget = z.infer<typeof ChangeStageDependencyTargetSchema>;

/** A change's stage-dependency status (ADR-0028 increment 4). Present on `explain` for any change
 *  that declared `stageDependencies` (well-formed or not) OR whose own targets are joined by a
 *  `depends_on` edge; null otherwise, so it is absent for every uncoupled change. */
export const ChangeStageDependencyStatusSchema = z.object({
  /** True when any evaluated target is held. This is a LIVE answer: it goes false the moment the
   *  dependency lands, with no clearing row to write and none to wait for. */
  held: z.boolean(),
  /** The wave this reflects — the first one not `succeeded`/`skipped`, exactly the wave reconcile
   *  is working. Null when the change has no plan yet, or every wave is done. */
  waveIndex: z.number().int().nullable(),
  /** True when any verdict landed on the `unscopeable` branch: a coupling was declared and NOT
   *  enforced (the wave target names a component, not a placement). The live counterpart of the
   *  `stage_dependency_unscoped` warn Decision — a fail-open an operator must be able to see. */
  unenforced: z.boolean(),
  targets: z.array(ChangeStageDependencyTargetSchema)
});
export type ChangeStageDependencyStatus = z.infer<typeof ChangeStageDependencyStatusSchema>;

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
  /** ADR-0028 increment 4 — the stage-dependency status, re-evaluated LIVE on this request. `null`
   *  for a change that coupled nothing. `.nullable().optional()` following `boundarySegment`'s
   *  precedent below: additive within /v1, so a pre-increment-4 SDK reading a new response is
   *  unaffected and an old server's response is still valid here. Never `.default()` — a default
   *  renders the property REQUIRED in the generated SDK type, which is an oasdiff ERR. */
  stageDependencyStatus: ChangeStageDependencyStatusSchema.nullable().optional(),
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
  /** Glob matched against the event's git REF (`refs/heads/dev`) — the third routing glob
   *  (ADR-0030 §1). NULL means "match any ref", so every mapping written before it existed keeps
   *  routing exactly as it did. */
  refPattern: z.string().nullable(),
  componentObjectId: z.string().uuid(),
  /** WHICH pipeline releases from this source roll (M12 P4A) — the routing Type (ADR-0007). NOT
   *  inferable from `sourceKind` — a GitHub Actions run can apply Terraform or ship an app — so the
   *  operator declares it per mapping. Mappings predating the Type cutover read back as
   *  'configuration' (the server default). */
  type: ExecutorTypeSchema,
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategorySchema,
  /** The operator's declared classification of this pipeline (ADR-0030 §2) — UI/reporting only,
   *  never an enforcement input. `null` for an ordinary pipeline. */
  classification: PipelineClassificationSchema.nullable(),
  /** The operator's DECLARED provenance of this repo (outpost-ui.md §9.3a, migration 0062): `true`
   *  = this repo mirrors a globally shared source authored at the commander (a domain's local COPY
   *  of shared IaC); `false` = domain-specific, tracked only in this domain. Declared, never
   *  inferred from the repo host; UI/reporting only, never an enforcement input. */
  mirrorOfShared: z.boolean(),
  /** The operator's PAUSE SWITCH (migration 0063, owner ask 2026-08-14). Unlike `mirrorOfShared`
   *  above, this IS an enforcement input: `false` means the mapping stays declared but
   *  `matchComponentForSource` (coordination/correlation.ts) skips it — a push that would
   *  otherwise match this row routes to nothing. `true` for every pre-0063 row (the default),
   *  which was already routing. */
  enabled: z.boolean(),
  /** The timed close's bound, or null (see SetSourceMappingEnabledRequest). */
  disabledUntil: z.string().datetime().nullable(),
  /** The read-time truth the matcher acts on: `enabled`, OR a timed close whose bound has passed.
   *  Paint state from THIS. */
  effectivelyEnabled: z.boolean(),
  /** The operator's DECLARED reach of this repo (pipeline-substrate-registry-scan.md §10.6,
   *  migration 0066): `global` = a cross-domain shared repo authored and tracked at the commander;
   *  `domain` = tracked only in this domain; `null` = NOT DECLARED — the pipeline renders no
   *  provenance label and infers nothing (a pre-0066 row on the commander is not thereby global).
   *  Orthogonal to `mirrorOfShared` (a `domain`-scope mapping may mirror a global one). Read, never
   *  inferred; UI/reporting/IaC only, never an enforcement input — the correlation matcher does not
   *  read it. Required-nullable like `mirrorOfShared`/`disabledUntil` beside it (a new REQUIRED
   *  response property is additive within /v1). */
  scope: SourceMappingScopeSchema.nullable(),
  createdAt: z.string().datetime()
});
export type SourceMapping = z.infer<typeof SourceMappingSchema>;

export const CreateSourceMappingRequestSchema = z.object({
  sourceKind: z.string().min(1),
  repoPattern: z.string().optional(),
  pathPattern: z.string().optional(),
  /** Glob matched against the event's git ref (`refs/heads/dev`), ADR-0030 §1. Omitted means "match
   *  any ref" — the pre-0057 behaviour, so an existing caller is unaffected. */
  refPattern: z.string().optional(),
  component: z.string().min(1), // idOrUrn
  /** The routing Type (ADR-0007). Omitted means 'configuration' (defaulted server-side in
   *  `source-mappings-repo.ts`). `.optional()` not `.default()`: a default renders the property
   *  REQUIRED in the generated SDK request type, an unnecessary extra request-shape break. */
  type: ExecutorTypeSchema.optional(),
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting only. Omitted
   *  means unclassified. Accepting it here is what makes dev-ness DECLARED rather than inferred
   *  from the branch name. */
  classification: PipelineClassificationSchema.optional(),
  /** Declare this repo a MIRROR of a commander-shared source (outpost-ui.md §9.3a). Omitted means
   *  domain-specific — the pre-0062 meaning of every mapping, so existing callers are unaffected.
   *  `.optional()` not `.default()` for the same request-shape reason as `type` above. */
  mirrorOfShared: z.boolean().optional(),
  /** The operator's pause switch (migration 0063). Omitted means enabled — a mapping routes by
   *  default, the pre-0063 behaviour, so an existing caller is unaffected. Pass `false` to create
   *  a mapping that is declared but does not yet route. `.optional()` not `.default()` for the
   *  same request-shape reason as `type`/`mirrorOfShared` above. */
  enabled: z.boolean().optional(),
  /** Declare this repo's reach (§10.6): `global` (shared across domains, tracked at the commander)
   *  or `domain` (tracked only here). Omitted means NOT DECLARED — stored NULL, no label rendered,
   *  nothing inferred; set it later with `PATCH .../mappings/{id}/scope`. `.optional()` not
   *  `.default()` for the same request-shape reason as the fields above. */
  scope: SourceMappingScopeSchema.optional()
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
 *
 * `refPattern` (ADR-0030 §1) JOINS THE TUPLE, and it had to: it is a routing discriminator, so two
 * mappings may now differ ONLY by it — `refs/heads/dev` → the dev pipeline and `refs/heads/main` →
 * the production one, same component, same repo, same path, same Type. A tuple that ignored the ref
 * would match BOTH and delete the production route along with the dev one, silently, reporting a
 * `deleted` count the operator would read as success.
 *
 * It is `.nullable().optional()` rather than plain `.nullable()` — the ONE asymmetry in this tuple —
 * because making it required would break every existing caller's request shape. **An ABSENT
 * `refPattern` is treated as NULL, not as a wildcard**, which is the fail-closed reading: a legacy
 * caller that omits it deletes only ref-agnostic rows and never reaches a ref-scoped one. It can
 * therefore UNDER-delete (visible immediately — `deleted` reports 0, which this response exists to
 * surface) but never OVER-delete a route nobody asked to remove.
 */
export const DeleteSourceMappingRequestSchema = z.object({
  component: z.string().min(1), // idOrUrn
  repoPattern: z.string().nullable(),
  pathPattern: z.string().nullable(),
  refPattern: z.string().nullable().optional(),
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
 * `PATCH /change-sources/{sourceKind}/mappings/{id}` params — the one mapping route addressed by
 * id rather than the identity tuple, because unlike delete/create this is a genuine UPDATE of one
 * specific row (migration 0063): flipping `enabled` on a mapping must never also flip its
 * byte-identical sibling.
 */
export const SourceMappingIdParamSchema = z.object({
  sourceKind: z.string().min(1),
  id: z.string().uuid()
});

/**
 * `PATCH /change-sources/{sourceKind}/mappings/{id}` body — the pause switch (migration 0063).
 * Deliberately not a general "patch a mapping" shape: every other column here is part of the
 * identity tuple (`ManifestSourceMappingSchema`) or, like `mirrorOfShared`/`classification`, a
 * create-time declaration with no update path. `scope` (§10.6) is the one other mutable label and
 * has its OWN sibling PATCH below rather than a field here — `enabled` is REQUIRED in this body, so a
 * caller that only wants to label a mapping would have to restate the pause state to do it (and
 * could clobber a concurrent toggle); a route named `setSourceMappingEnabled` that also sets scope
 * would be a name that lies. Additive either way; the sibling keeps this contract byte-identical.
 */
export const SetSourceMappingEnabledRequestSchema = z.object({
  enabled: z.boolean(),
  /** With `enabled: false` only: close UNTIL this instant (ISO), then re-open automatically at
   *  read time — no timer job. Omitted/null = closed until an operator re-opens. Ignored with
   *  `enabled: true`. */
  disabledUntil: z.string().datetime().nullable().optional()
});
export type SetSourceMappingEnabledRequest = z.infer<typeof SetSourceMappingEnabledRequestSchema>;

/**
 * `PATCH /change-sources/{sourceKind}/mappings/{id}/scope` body (§10.6) — set or clear the
 * declared scope of ONE mapping, by id (same addressing as the pause switch, for the same reason: a
 * genuine in-place update of one row must never touch its byte-identical siblings). `null` clears
 * the declaration (back to "not declared" — no label). Required, not optional: an omitted field
 * would make "clear it" and "I forgot the body" indistinguishable.
 */
export const SetSourceMappingScopeRequestSchema = z.object({
  scope: SourceMappingScopeSchema.nullable()
});
export type SetSourceMappingScopeRequest = z.infer<typeof SetSourceMappingScopeRequestSchema>;

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

import { z } from "zod";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";
import { ComponentPipelineDomainSchema } from "./components.js";
import { WaveTargetObservedSchema } from "./changes.js";

/** Service release board. See docs/schemas.md §394. */

/** A distinct pipeline-kind pair on a wave (ADR-0007): the Category of the wave-target's Type. */
export const ServiceBoardKindSchema = z.object({
  category: ExecutorCategorySchema,
  type: ExecutorTypeSchema
});
export type ServiceBoardKind = z.infer<typeof ServiceBoardKindSchema>;

/** One WAVE of a component's latest change, summarized. See docs/schemas.md §395. */
export const ServiceBoardWaveSchema = z.object({
  waveIndex: z.number().int(),
  name: z.string().nullable(),
  status: z.string(),
  kinds: z.array(ServiceBoardKindSchema),
  targetCount: z.number().int(),
  failedTargets: z.number().int()
});
export type ServiceBoardWave = z.infer<typeof ServiceBoardWaveSchema>;

/** The attention signals for a row's latest change (all real, Layer A). `blocked` is derived from a
 *  failed wave/target OR a persisted block `Decision`; `decisionId` is that block Decision's id (charter
 *  principle 6 — every blocked surface carries a decision_id), null otherwise. `awaitingApproval` is a
 *  pending (unsatisfied) ApprovalRequest on the change. `emergency` is the change's own emergency flag. */
export const ServiceBoardAttentionSchema = z.object({
  blocked: z.boolean(),
  decisionId: z.string().uuid().nullable(),
  awaitingApproval: z.boolean(),
  emergency: z.boolean()
});
export type ServiceBoardAttention = z.infer<typeof ServiceBoardAttentionSchema>;

/** An EXISTING active freeze (read-only) scoped directly to this object. Phase 2 surfaces freezes as
 *  status only — declaring/lifting a freeze is a controls-phase (Phase 5) concern. */
export const ServiceBoardFreezeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string(),
  endsAt: z.string().datetime()
});
export type ServiceBoardFreeze = z.infer<typeof ServiceBoardFreezeSchema>;

/** WHICH DOMAIN DRIVES this row's latest change. See docs/schemas.md §396. */
export const ServiceBoardDriverSchema = z.object({
  drivenHere: z.boolean(),
  originDomainId: z.string().nullable()
});
export type ServiceBoardDriver = z.infer<typeof ServiceBoardDriverSchema>;

/** One board row = one component of the service. `latestChangeId` links the row to that component's
 *  active/most-recent change pipeline (`/changes/{id}/pipeline`); null when the component has never
 *  been a change target. `currentWave` is the running (or last non-pending) wave's display name. */
/** ONE PIPELINE'S HIGH-LEVEL STATE, summarised for a board row. See docs/schemas.md §397. */
export const ServiceBoardPipelineSchema = z.object({
  category: ExecutorCategorySchema,
  /** Is any executor bound for this pipeline — directly, via a placement, or (ADR-0027) via the
   *  owning service? False means nothing can run it. */
  bound: z.boolean(),
  /** The newest `change_wave_targets.status` for THIS pipeline across the component's placements.
   *  Null when this pipeline has never run here — never conflated with a sibling's status. */
  status: z.string().nullable(),
  /** The change that status is as of, so "succeeded" is never a standing property of the row. */
  changeId: z.string().uuid().nullable(),
  /** What actually executes this pipeline, deduplicated. For a COMPONENT row this is the union
   *  across its placements (one entry per distinct type+ref, so a binding repeated at every place
   *  appears once); for a SERVICE-level pipeline it is the binding on the service itself. Empty
   *  exactly when `bound` is false. */
  bindings: z.array(
    z.object({
      type: z.string(),
      externalRef: z.string().nullable(),
      executionSystemName: z.string().nullable(),
      /** Human console URL, or null when it cannot be known — see `console-urls.ts`. */
      url: z.string().nullable()
    })
  )
});
export type ServiceBoardPipeline = z.infer<typeof ServiceBoardPipelineSchema>;

/** An ASSEMBLY child of this service. See docs/schemas.md §398. */
export const ServiceBoardAssemblySchema = z.object({
  id: z.string().uuid(),
  urn: z.string(),
  name: z.string(),
  /** DIRECT component children of this assembly. A count, not a status: rolling release state up
   *  through a level needs a rule for what "the assembly is blocked" means, and inventing one here
   *  would put a claim on the board that nothing computed. */
  componentCount: z.number().int()
});
export type ServiceBoardAssembly = z.infer<typeof ServiceBoardAssemblySchema>;

/** HOW OLD the peer's reading is, in the vocabulary this repo already uses for an observation it
 *  holds but may not believe (`BoundaryValidatePhaseSchema`'s states, `ServiceBoardAsOfSchema`'s
 *  `staleAfterSeconds`). A union so a further verdict is additive.
 *
 *  THE THIRD CASE IS NOT HERE, on purpose: "not reported" is the ABSENCE of a reading, and it is
 *  said the way this board has always said it — `peerObserved: null` plus the `peerObserved` path in
 *  `unknownFields`. Spelling it as a third member here would make a row that never reported look
 *  like a row that reported nothing.
 *
 *  Aged against the peer's own `observedAt`, never against `receivedAt`: a bundle that sat on a USB
 *  stick for a day and arrived a second ago is not a fresh reading. */
export const ServiceBoardPeerObservedFreshnessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fresh"), ageSeconds: z.number().int().nonnegative() }),
  z.object({
    state: z.literal("stale"),
    ageSeconds: z.number().int().nonnegative(),
    /** The bound the verdict used — the same constant the stage-dependency hold ages an observed
     *  canary weight against, so the board and the hold cannot disagree about one row. */
    staleAfterSeconds: z.number().int().positive()
  })
]);
export type ServiceBoardPeerObservedFreshness = z.infer<
  typeof ServiceBoardPeerObservedFreshnessSchema
>;

/** ONE wave target as the EXECUTING domain reported it (`wave_target_observed`, subject `target`). */
export const ServiceBoardPeerObservedTargetSchema = z.object({
  targetObjectId: z.string().uuid(),
  /** The routing Type the peer named. `z.string`: a peer may name a Type this side has not
   *  registered, and the reading is still worth showing verbatim. */
  type: z.string(),
  waveIndex: z.number().int(),
  status: z.string(),
  attempt: z.number().int().nonnegative(),
  /** The observe-only rollout snapshot, reusing {@link WaveTargetObservedSchema}'s shape rather than
   *  restating it — a field added there federates and lands here with no edit. */
  rollout: WaveTargetObservedSchema.shape.rollout,
  /** The peer's own statement of when it looked. */
  observedAt: z.string().datetime(),
  /** RECEIVER-STAMPED: when this instance applied the entry. */
  receivedAt: z.string().datetime(),
  freshness: ServiceBoardPeerObservedFreshnessSchema
});
export type ServiceBoardPeerObservedTarget = z.infer<typeof ServiceBoardPeerObservedTargetSchema>;

/** ONE pipeline-hook run as the executing domain reported it (subject `hook_run`, D3's full
 *  progress). Grain: `pipeline_hook_runs` is identified by `(change, hookId, waveIndex)`, NOT by
 *  target — a `postMerge` run has no target at all, and a `postDeploy` run gates a whole wave. UI
 *  copy must not call one of these "this target's post-deploy test". */
export const ServiceBoardPeerObservedHookRunSchema = z.object({
  hookId: z.string(),
  kind: z.string(),
  /** `null` for `postMerge`, which belongs to no wave. */
  waveIndex: z.number().int().nullable(),
  /** `null` for `postMerge`, which belongs to no target. */
  targetObjectId: z.string().uuid().nullable(),
  status: z.string(),
  attempt: z.number().int().nonnegative(),
  /** The executor's own console URL for the run, when it reported one. The commander cannot serve a
   *  page for a run in another domain, so this is the only honest link. */
  externalUrl: z.string().nullable(),
  startedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  freshness: ServiceBoardPeerObservedFreshnessSchema
});
export type ServiceBoardPeerObservedHookRun = z.infer<typeof ServiceBoardPeerObservedHookRunSchema>;

/** WHAT ANOTHER DOMAIN REPORTED about this row's change (pipeline-mockup-data.md D3/D4).
 *
 *  Only ever present on a row whose change is NOT driven here: those rows have no local plan, so the
 *  board's own `waves`/`currentWave` stay unobservable and stay listed in `unknownFields` even when
 *  this field is full. These are a PEER's readings, replicated read-only and attributed to the peer
 *  that signed them — never merged into the row's own wave summary, which would put a fact this
 *  domain never observed behind a field that means "observed here". */
export const ServiceBoardPeerObservedSchema = z.object({
  /** The peer whose signed bundle carried these readings, as the RECEIVER resolved it. */
  peerDomainId: z.string(),
  targets: z.array(ServiceBoardPeerObservedTargetSchema),
  hookRuns: z.array(ServiceBoardPeerObservedHookRunSchema)
});
export type ServiceBoardPeerObserved = z.infer<typeof ServiceBoardPeerObservedSchema>;

export const ServiceBoardRowSchema = z.object({
  component: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string()
  }),
  latestChangeId: z.string().uuid().nullable(),
  changeState: z.string().nullable(),
  changeName: z.string().nullable(),
  currentWave: z.string().nullable(),
  waves: z.array(ServiceBoardWaveSchema),
  attention: ServiceBoardAttentionSchema,
  /** THE HIGH-LEVEL STATE OF EACH PIPELINE this component runs — one entry per ADR-0007 Category,
   *  always all of them. See {@link ServiceBoardPipelineSchema}. */
  pipelines: z.array(ServiceBoardPipelineSchema),
  /** An active freeze scoped to THIS component (read-only). Null when none covers it directly. */
  activeFreeze: ServiceBoardFreezeSchema.nullable(),
  /** Which domain drives `latestChangeId`. Null exactly when `latestChangeId` is null (there is no
   *  change whose authority could be named). */
  driver: ServiceBoardDriverSchema.nullable(),
  /** THE PEER'S OWN READINGS for a change driven elsewhere — see
   *  {@link ServiceBoardPeerObservedSchema}. Three readings a client must keep apart:
   *  `null` + `peerObserved` in `unknownFields` = NOT REPORTED (nothing has arrived);
   *  present with `freshness.state === "stale"` = REPORTED, and too old to be treated as current;
   *  present and `fresh` = a real reading. `null` with NO `unknownFields` entry means the question
   *  does not apply — the change is driven HERE, so the row's own fields are the observation.
   *  Optional/additive within /v1: absent from an older server's response. */
  peerObserved: ServiceBoardPeerObservedSchema.nullable().optional(),
  /** The row fields this domain cannot observe, by path. See docs/schemas.md §399. */
  unknownFields: z.array(z.string())
});
export type ServiceBoardRow = z.infer<typeof ServiceBoardRowSchema>;

/** The releasing, blocked, stable and not-here summary. See docs/schemas.md §400. */
export const ServiceBoardSummarySchema = z.object({
  releasing: z.number().int(),
  blocked: z.number().int(),
  stable: z.number().int(),
  notDrivenHere: z.number().int()
});
export type ServiceBoardSummary = z.infer<typeof ServiceBoardSummarySchema>;

/** WHEN the upstream data behind this board last arrived, and how. See docs/schemas.md §401. */
export const ServiceBoardAsOfSchema = z.object({
  peerDomainId: z.string(),
  peerName: z.string(),
  at: z.string().datetime().nullable(),
  via: z.enum(["live-pull", "bundle", "never", "unknown"]),
  ageSeconds: z.number().int(),
  expectedWithinSeconds: z.number().int().nullable(),
  staleAfterSeconds: z.number().int().nullable(),
  stale: z.boolean().nullable()
});
export type ServiceBoardAsOf = z.infer<typeof ServiceBoardAsOfSchema>;

export const ServiceBoardResponseSchema = z.object({
  service: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string(),
    /** WHO MAINTAINS THIS SERVICE (outpost-ui.md §9.3a) — same shape as a pipeline stage's
     *  `maintainedBy`. On an outpost, `isSelf: false` means the commander (or another peer) is
     *  UPSTREAM of this domain's repos for the service's shared IaC/CaC; `isSelf: true` means this
     *  domain authored it. READ from `originDomainId` vs federation self — never inferred. */
    maintainedBy: ComponentPipelineDomainSchema,
    /** ADR-0031 — a domain-local service has NO upstream: its rung-bound shared infra/config is
     *  this domain's own, and no commander appears ahead of its repos. */
    domainLocal: z.boolean()
  }),
  rows: z.array(ServiceBoardRowSchema),
  summary: ServiceBoardSummarySchema,
  /** An active freeze scoped directly to the SERVICE object (read-only), covering every component. */
  serviceFreeze: ServiceBoardFreezeSchema.nullable(),
  /** PIPELINES BOUND TO THE SERVICE ITSELF. See docs/schemas.md §402. */
  servicePipelines: z.array(ServiceBoardPipelineSchema),
  /** ASSEMBLY children of this service, each with a component count — see
   *  {@link ServiceBoardAssemblySchema}. Empty for a service whose components sit directly under it,
   *  which is every service on the estate today. */
  childAssemblies: z.array(ServiceBoardAssemblySchema),
  /** DESIGN §13's "as of" label for the LIMITING upstream peer — see {@link ServiceBoardAsOfSchema}.
   *  `null` exactly when no peer's scope can carry change objects (including the single-domain case,
   *  where the board is a complete local observation and claiming an as-of would be theatre). */
  asOf: ServiceBoardAsOfSchema.nullable(),
  /** BOARD-LEVEL unobservable fields, by dotted path. See docs/schemas.md §403. */
  unknownFields: z.array(z.string())
});
export type ServiceBoardResponse = z.infer<typeof ServiceBoardResponseSchema>;

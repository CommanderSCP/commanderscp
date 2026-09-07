import { z } from "zod";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";
import { ComponentPipelineDomainSchema } from "./components.js";

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

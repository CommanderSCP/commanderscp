import { z } from "zod";
import { ExecutorTypeSchema, ExecutorCategorySchema } from "./executors.js";
import { ComponentPipelineDomainSchema } from "./components.js";

/**
 * Service release board (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2,
 * Layer A). A server-side projection: a service's components in one scannable table, each row carrying
 * that component's LATEST change's per-wave summary + attention signals, plus a releasing /
 * blocked / stable summary strip.
 *
 * Why a projection and not client-aggregation: there is no target-filtered changes list, so a browser
 * would have to page every change and `explain()` each to find "the latest change for this component"
 * — an O(all-changes) fan-out per board render. This endpoint collapses that to one HTTP call with the
 * fan-out contained in a single server transaction (the `latest-change-per-target` join is the sole
 * net-new capability). Strictly Layer A: no invented per-wave image versions or health — those are
 * Layer B and are surfaced by the UI as explicit placeholders, never fabricated here.
 */

/** A distinct pipeline-kind pair on a wave (ADR-0007): the Category of the wave-target's Type. */
export const ServiceBoardKindSchema = z.object({
  category: ExecutorCategorySchema,
  type: ExecutorTypeSchema
});
export type ServiceBoardKind = z.infer<typeof ServiceBoardKindSchema>;

/** One WAVE of a component's latest change, summarized (ADR-0021 D6 — this field was called a
 *  "stage" until 2026-07-25; under the glossary a **wave** IS the compiled step of a plan, while a
 *  **stage** is a named deployment *place* (`<domain>[-<location>]-<env>`) that has no entity in the
 *  code yet. What the board renders has always been the compiled wave, so `wave` is what it is now
 *  called). `status` is the raw wave status (pending|running|succeeded|failed|skipped); `kinds` are
 *  the distinct Category·Type pairs across the wave's targets; `failedTargets` counts targets in a
 *  terminal-failure status so the UI can surface a partial-failure wave without re-deriving it. */
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

/** WHICH DOMAIN DRIVES this row's latest change (federation honesty — see `unknownFields`).
 *
 *  A change's graph OBJECT replicates across a federation link; its plan/waves, block Decisions and
 *  approval requests do NOT (they are local projection tables that never ride the sync journal). So
 *  a domain holding a change as a read-only REPLICA can see that the change exists and what
 *  lifecycle state its origin last reported, but genuinely cannot see whether it is blocked,
 *  awaiting approval, or how far its waves have rolled.
 *
 *  FREEZES USED TO BE ON THAT LIST AND ARE NOT ANY MORE (M25.7, owner decision D6). A freeze
 *  authored `federate: true` rides `object_upsert` as a graph object and is rebuilt into the
 *  receiving instance's own `freezes` table, so it is both visible and ENFORCED there. Freeze
 *  visibility is reported BOARD-LEVEL rather than per-row for that reason — see the board's own
 *  `unknownFields`.
 *
 *  `drivenHere` is false exactly when the change object's authoritative origin is another domain
 *  (`objects.origin_domain_id !== this instance's federation domain id`). `originDomainId` names
 *  that authoritative domain (null when this domain is the origin). */
export const ServiceBoardDriverSchema = z.object({
  drivenHere: z.boolean(),
  originDomainId: z.string().nullable()
});
export type ServiceBoardDriver = z.infer<typeof ServiceBoardDriverSchema>;

/** One board row = one component of the service. `latestChangeId` links the row to that component's
 *  active/most-recent change pipeline (`/changes/{id}/pipeline`); null when the component has never
 *  been a change target. `currentWave` is the running (or last non-pending) wave's display name. */
/**
 * ONE PIPELINE'S HIGH-LEVEL STATE, summarised for a board row.
 *
 * The board was change-anchored: one `latestChangeId` per component, so a row said ONE thing about
 * a component that runs several independent pipelines (ADR-0007 Category — a `build`, an
 * `infrastructure` plan/apply, a `configuration` sync). Whichever pipeline moved most recently
 * spoke for all of them, so a pipeline that had never run read exactly like one that just
 * succeeded.
 *
 * EVERY CATEGORY IS EMITTED, always — `bound: false` included. A component with no infrastructure
 * pipeline is a fact worth seeing, and omitting the entry would make "none is bound" impossible to
 * tell from "this board does not show infra".
 */
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

/**
 * An ASSEMBLY child of this service — the optional level between service and component
 * (migration 0055, `intermediate-grouping.md` D3/D5).
 *
 * D3 chose DIRECT children plus a per-child summary over flattening every descendant: a service with
 * several assemblies of dozens of components each would otherwise render hundreds of rows and lose
 * what the board is for. So an assembly appears as its own entry with a count and a link down, not as
 * its components inlined here.
 *
 * Before this the board filtered children to `typeId === "component"`, so an assembly child — and
 * therefore everything under it — was silently absent from its parent's board. That is the one thing
 * this entry exists to stop.
 */
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
  /** The row fields whose values this domain CANNOT OBSERVE, named by dotted path (e.g. `"waves"`,
   *  `"attention.blocked"`). Every listed field still carries its zero value on the wire for shape
   *  stability — but that zero is NOT an observation and a client must not render it as one.
   *
   *  Empty for a change this domain drives (there, `waves: []` / `blocked: false` really do mean
   *  "no waves compiled" / "not blocked"). Non-empty on a read-only replica, where the underlying
   *  plan/Decision/approval rows were never replicated. This is the same rule the graph health
   *  surfaces already follow — absent health renders `unknown`, never `healthy`.
   *
   *  A FREEZE ROW MAY NOW HAVE BEEN REPLICATED (M25.7, owner decision D6) — the list above used to
   *  name it and no longer does. `activeFreeze` still appears in a replica row's `unknownFields`
   *  when none was found locally, because a peer's un-federated freezes remain invisible.
   *
   *  Also non-empty — including `"latestChangeId"` itself — on a row with NO change found, when this
   *  deployment has a peer whose sync scope cannot carry change objects (`status_only` forwards
   *  change STATUS without the change; `policies_only` forwards neither; a `custom` selector may
   *  forward some and not others). There, "no change here" is not an observation: the domain may
   *  simply never have been sent the change that is rolling through this component. */
  unknownFields: z.array(z.string())
});
export type ServiceBoardRow = z.infer<typeof ServiceBoardRowSchema>;

/** The releasing / blocked / stable / not-driven-here summary strip. `blocked` counts rows whose latest
 *  change is blocked (failed wave/target or block Decision); `releasing` counts rows whose latest change
 *  is in-flight and not blocked; `notDrivenHere` counts rows whose latest change is a read-only replica
 *  of another domain's change, where blocked/releasing are not observable at all (see
 *  {@link ServiceBoardDriverSchema}); `stable` is every remaining row (accepted / settled / no active
 *  change). The four are mutually exclusive and sum to `rows.length`.
 *
 *  `notDrivenHere` is deliberately its OWN bucket rather than folded into `stable`: a replica's release
 *  may well be in flight, and counting it as stable is a fabricated all-clear — an operator on an
 *  outpost would read green while the commander drives a release through their components. */
export const ServiceBoardSummarySchema = z.object({
  releasing: z.number().int(),
  blocked: z.number().int(),
  stable: z.number().int(),
  notDrivenHere: z.number().int()
});
export type ServiceBoardSummary = z.infer<typeof ServiceBoardSummarySchema>;

/** WHEN the upstream data behind this board last arrived, and how — DESIGN.md §13's
 *  "as of &lt;bundle/date&gt;" label, which §13 pairs with an explicit ban: *"never presents stale data
 *  as live status"*.
 *
 *  A board on a federated instance renders change objects that arrived over the sync journal. Without
 *  this, nothing on the wire says whether they arrived thirty seconds ago or last quarter — and the
 *  reader has no way to tell a live view from a snapshot. It names the LIMITING peer (the oldest
 *  reading among the peers whose scope can carry change objects), because that is the one that bounds
 *  what the whole board may claim.
 *
 *  - `at` — the `confirmedAt` of the newest confirmed inbound sync bundle from that peer, or null if
 *    none has ever landed. Deliberately derived from bundle-transfer history rather than the live-pull
 *    timestamps, so it is equally true on a connected instance and an air-gapped one (the pull columns
 *    are NULL forever on an instance that never dials).
 *  - `via` — `"live-pull"` (the scheduler dialled the peer), `"bundle"` (a file/pushed/inbox import —
 *    the air-gap case §13 names), `"never"` (nothing has arrived), or `"unknown"` (the transfer
 *    predates the column that records this and is not guessed at). Read from the transfer row, never
 *    inferred from timestamps — "as of 3 days ago via bundle" is a healthy air-gapped domain and "as
 *    of 3 days ago via a wedged poller" is an incident, so a wrong attribution is worse than none.
 *  - `ageSeconds` — seconds since `at`, or since the peer was paired when nothing has ever arrived.
 *  - `expectedWithinSeconds` — the peer's OWN effective pull cadence (frequent poll vs proven sparse
 *    poke), or null when this instance schedules no pulls for that peer at all.
 *  - `staleAfterSeconds` — the age at which `stale` actually flips to `true`: the cadence above WITH
 *    the grace factor already applied, null exactly when `expectedWithinSeconds` is null. It is on
 *    the wire because `expectedWithinSeconds` is NOT the threshold and a client that renders it as
 *    one lies: `stale: false` covers ages well past one cadence, so "within its 60s cadence" is
 *    false of a 90-second-old reading that is legitimately not stale. Clients render this; nothing
 *    downstream re-derives the grace factor (see `federation/upstream-freshness.ts`).
 *  - `stale` — `true`/`false` against that cadence **plus a grace factor** (a peer's age necessarily
 *    exceeds its interval once per cycle; only a MISSED cycle is late — see
 *    `federation/upstream-freshness.ts`'s `FRESHNESS_GRACE_FACTOR`). **`null` when
 *    `expectedWithinSeconds` is null**: null is not "fresh", it means no schedule exists for the data
 *    to be late against (an air-gapped peer, or an outpost seen from the commander), so the label
 *    itself is the whole guarantee. A client must render null as "as of &lt;at&gt;", never as an
 *    all-clear. A scheduled peer that has never delivered anything reads `true`, never `false` —
 *    freshness is a claim about delivered data.
 *
 *  The peer reported is the one with the greatest `ageSeconds`, which is the board's actual freshness
 *  BOUND. `stale` is a per-peer verdict against that peer's own schedule and is never used to order
 *  peers against each other — doing so would let a barely-late connected peer mask an ancient
 *  air-gapped one.
 *
 *  When `stale` is `true` the response's `unknownFields` additionally names `"summary.stable"` and
 *  `"rows[].latestChangeId"`, for the same reason change-object blindness does: a newer change may
 *  exist upstream that this instance has not been sent yet. */
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
  /**
   * PIPELINES BOUND TO THE SERVICE ITSELF — infrastructure that serves the whole service.
   *
   * A cluster, a shared database or a VPC stands up once and every component runs on top; declaring
   * that as N identical component bindings is duplication that drifts. ADR-0027 added the service
   * rung to binding resolution, so a binding here now actually routes — before it, this would have
   * been inert config that ALSO blocked releases (fail-closed `no_executor`), which is why the view
   * and the rung landed together rather than the view first.
   */
  servicePipelines: z.array(ServiceBoardPipelineSchema),
  /** ASSEMBLY children of this service, each with a component count — see
   *  {@link ServiceBoardAssemblySchema}. Empty for a service whose components sit directly under it,
   *  which is every service on the estate today. */
  childAssemblies: z.array(ServiceBoardAssemblySchema),
  /** DESIGN §13's "as of" label for the LIMITING upstream peer — see {@link ServiceBoardAsOfSchema}.
   *  `null` exactly when no peer's scope can carry change objects (including the single-domain case,
   *  where the board is a complete local observation and claiming an as-of would be theatre). */
  asOf: ServiceBoardAsOfSchema.nullable(),
  /** BOARD-LEVEL unobservable fields, by dotted path (`"serviceFreeze"`, `"rows[].activeFreeze"`) —
   *  the ones no row can observe regardless of who drives its change, as opposed to
   *  {@link ServiceBoardRowSchema}'s per-row `unknownFields` (what THAT row's driving domain
   *  withheld).
   *
   *  Two families ride here today.
   *
   *  FREEZE VISIBILITY (`"serviceFreeze"`, `"rows[].activeFreeze"`), whenever this org has a
   *  federation peer. A freeze declared in another domain reaches this instance ONLY if that domain
   *  declared it `federate: true` (M25.7, owner decision D6 — it then rides `object_upsert` as a
   *  `freeze` graph object and is rebuilt into this instance's own `freezes` table, where it blocks
   *  like any local one). Federation is opt-in and DEFAULTS OFF, and nothing in a bundle reports the
   *  freezes a peer withheld. So a null `activeFreeze`/`serviceFreeze` means "no freeze VISIBLE
   *  HERE", never "no freeze applies", and a client must not render it as an all-clear on a
   *  federated deployment. With no peer paired there is no other domain to be blind to, and the
   *  nulls are complete observations — the list is then empty rather than claiming an ignorance
   *  this instance does not have.
   *
   *  THE RETIRED REASON, kept because it is what a reader will otherwise re-derive: until M25.7 this
   *  said `freezes` is a local projection that never rides the sync journal in either direction, and
   *  that was ABSOLUTE — a freeze was not a graph object and no freeze-shaped `JournalEntryKind`
   *  existed. The caveat's wording changed; its conclusion did not.
   *
   *  CHANGE-OBJECT BLINDNESS (`"summary.stable"`, `"rows[].latestChangeId"`), whenever a peer's
   *  sync scope cannot carry change objects. `summary.stable` then mixes genuinely-settled rows
   *  with rows that merely came up empty and must not be painted as an all-clear; and no row's
   *  `latestChangeId` is certainly the LATEST, since a newer change from that peer would never have
   *  arrived. See `coordination/service-board.ts` and `federation/scope-filter.ts`. */
  unknownFields: z.array(z.string())
});
export type ServiceBoardResponse = z.infer<typeof ServiceBoardResponseSchema>;

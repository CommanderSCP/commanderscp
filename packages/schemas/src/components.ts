import { z } from "zod";
import { ChangeStageDependencyVerdictSchema } from "./changes.js";
import { ExecutorCategorySchema, PipelineClassificationSchema } from "./executors.js";

// ---------------------------------------------------------------------------------------------
// COMPONENT PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03)
// ---------------------------------------------------------------------------------------------

/**
 * WHO MAINTAINS A PLACE — the federation domain that owns the deployment-target, and therefore the
 * execution that happens there.
 *
 * The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner,
 * 2026-08-04). That is not a UI nicety, it is the ownership split the platform is built on:
 * ADR-0017 devolves build execution to the originating outpost and leaves the commander owning only
 * the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy inside its
 * own domain. A pipeline view that shows a stage without saying whose domain it is in invites the
 * reading that the commander deploys it — which is the one thing charter principle 1 says it does
 * not do.
 *
 * Derived from the target's OWN `origin_domain_id` matched against `federation_self` and
 * `federation_peers` — never from this instance's identity, for the same reason ADR-0026 D1 derives
 * a stage NAME from the target's origin: a replicated target must read the same at the commander
 * and at the outpost.
 */
export const ComponentPipelineDomainSchema = z.object({
  domainId: z.string().uuid().nullable(),
  /** The domain's name, or null when the target's origin matches neither self nor any known peer —
   *  which is a real state on a replica whose peer row has not arrived, and must not render as
   *  "ours". */
  name: z.string().nullable(),
  /** Is this THIS instance's own domain? False means another domain maintains this place. */
  isSelf: z.boolean(),
  /** `commander` / `outpost` / `retrans` / `unset` — from `federation_self.role` or the peer's
   *  `role`. Null when the domain is unknown. */
  role: z.string().nullable()
});
export type ComponentPipelineDomain = z.infer<typeof ComponentPipelineDomainSchema>;

/** Which topology wave declares a stage, and where it sits in release order. */
export const ComponentPipelineWaveSchema = z.object({
  index: z.number().int(),
  name: z.string().nullable()
});

/** One executor binding at a stage — ONE PIPELINE. `type` is the ADR-0007 routing key (`image`,
 *  `infrastructure`, `configuration`, …), which is what distinguishes a build pipeline from an
 *  infra pipeline from a config-sync pipeline running at the same place. */
export const ComponentPipelineBindingSchema = z.object({
  externalRef: z.string().nullable(),
  type: z.string(),
  /** Where a HUMAN opens this — the Argo CD application, the GitHub Actions tab. Null when it
   *  cannot be KNOWN (no address on the execution system, or a ref nothing can be said about), and
   *  the client then renders an un-clickable node: a dead link in an operator console is a claim
   *  that something is over there. Never the REST base URL the executor is called on. */
  url: z.string().nullable(),
  /** DERIVED from `type` via `categoryOfType` (ADR-0007) — never stored. On the wire so a client
   *  groups pipelines into lanes without carrying its own copy of the Type→Category map, which is
   *  the duplication ADR-0007 kept out of the database in the first place. */
  category: ExecutorCategorySchema,
  executionSystemId: z.string().uuid().nullable(),
  executionSystemName: z.string().nullable()
});
export type ComponentPipelineBinding = z.infer<typeof ComponentPipelineBindingSchema>;

/** The most recent change to touch a stage through ONE pipeline. `category` is which pipeline —
 *  from `change_wave_targets.type`, the routing Type the plan snapshotted for this target. */
export const ComponentPipelineCurrentSchema = z.object({
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  changeState: z.string().nullable(),
  waveName: z.string().nullable(),
  targetStatus: z.string().nullable(),
  type: z.string(),
  category: ExecutorCategorySchema
});
export type ComponentPipelineCurrent = z.infer<typeof ComponentPipelineCurrentSchema>;

/**
 * WHERE A COMPONENT'S RELEASES COME FROM — one `source_mappings` rule: a push matching this repo
 * (and path, if any) becomes a release of this component, of this Type.
 *
 * This is the head of the journey, and the owner's question that prompted it was literal:
 * *"agentkit-bootstrap comes from a repo right? When someone makes a change there, it should affect
 * this right?"* The rule is durable state, so it answers that WITHOUT waiting for a push to prove it.
 *
 * It carries the same `type`/`category` as a binding, so a mapping belongs to the same lane as the
 * pipeline it feeds: an `infrastructure` mapping heads the infra pipeline, an `image` or
 * `configuration` one heads the software pipeline.
 */
export const ComponentPipelineSourceMappingSchema = z.object({
  id: z.string().uuid(),
  sourceKind: z.string(),
  /** The repo this rule matches. */
  repoPattern: z.string().nullable(),
  /** Path glob within the repo, or NULL meaning **the whole repo matches** — which is a much
   *  broader rule than it looks and must not render as an empty cell. Measured on the live estate:
   *  `agentkit-bootstrap` has such a mapping against all of `jag8765-personal/homelab-gitops`. */
  pathPattern: z.string().nullable(),
  /** Git ref glob, or NULL meaning **every branch matches** — the ref-side twin of the whole-repo
   *  case above, and just as broad: without it rendered, two mappings that route `dev` and `main`
   *  to different pipelines look identical in the UI (ADR-0030 §1). */
  refPattern: z.string().nullable(),
  type: z.string(),
  category: ExecutorCategorySchema,
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting ONLY, never an
   *  enforcement input. Rendered as a label; it grants and withholds nothing. */
  classification: PipelineClassificationSchema.nullable(),
  /** The repo's web page, or null when it cannot be known — a GLOBBED `repoPattern` names a set of
   *  repos rather than a page, and a self-hosted provider's host is not recorded on a mapping. */
  url: z.string().nullable()
});
export type ComponentPipelineSourceMapping = z.infer<typeof ComponentPipelineSourceMappingSchema>;

/**
 * WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE — the gate, as durable configuration.
 *
 * Resolved from the `policy` objects matching this placement's containment chain (DESIGN §10.1,
 * `policy-resolve.ts` + `policy-model.ts`'s stricter-wins merge) — the SAME resolution the
 * wave-boundary gate runs, so this view cannot disagree with the engine about what is required.
 *
 * It is a REQUIREMENT, not a verdict. A verdict exists only for a change in flight and carries a
 * `decision_id`; this is what would be required of any release, which is exactly what a durable
 * pipeline view can honestly state for a component with nothing releasing.
 *
 * Measured on the live estate, and the reason this ships: 12 `prod-gate` policies each require ONE
 * Owner approval before prod, and **282 approval requests are pending** against them. None of that
 * appeared anywhere in this view — a release stopping at a gate looked identical to one nobody had
 * started.
 */
/**
 * ONE AUTOMATED CHECK a policy requires at this stage, with where it has got to.
 *
 * `status` deliberately separates two absences that look identical in a naive rendering:
 *   `not_started` — nothing is at this gate, so there is nothing for the check to run against;
 *   `pending`     — a release IS here and this check has produced no outcome yet.
 * The rest are `control_runs.status` verbatim (pass | fail | warning | skipped | timed_out |
 * expired) — SCP does not invent an outcome, it reports the one the control recorded.
 *
 * `changeId` is the release the status is AS OF, so "passed" can never be read as a standing
 * property of the stage. Null exactly when `status` is `not_started`.
 */
export const ComponentPipelineCheckSchema = z.object({
  controlId: z.string(),
  /** The control object's name, or null when the reference dangles — which is worth seeing rather
   *  than silently dropping, since a policy requiring a control that no longer exists blocks. */
  name: z.string().nullable(),
  status: z.enum([
    "not_started",
    "pending",
    "pass",
    "fail",
    "warning",
    "skipped",
    "timed_out",
    "expired"
  ]),
  changeId: z.string().uuid().nullable()
});
export type ComponentPipelineCheck = z.infer<typeof ComponentPipelineCheckSchema>;

export const ComponentPipelineGateSchema = z.object({
  /** Every effective policy governing entry to this stage, stricter-wins-merged. Empty means
   *  nothing gates it — a real state, and different from "we did not look". */
  policies: z.array(
    z.object({
      name: z.string(),
      enforcement: z.enum(["advisory", "recommended", "required"]),
      /** Automated checks that must pass — the TESTS. Measured 2026-08-10: every live policy has
       *  this EMPTY, and the estate holds 0 control bindings and 0 control runs. So a component
       *  showing no required checks is reporting the truth about its configuration, not a gap in
       *  this projection. */
      requireControls: z.array(z.string()),
      /** Human sign-off required before the release may enter. */
      requireApprovals: z.array(
        z.object({ count: z.number().int(), fromRole: z.string(), scope: z.string() })
      )
    })
  ),
  /** Every control the policies above require, de-duplicated, each with its current outcome. Empty
   *  when no policy asks for one — measured 2026-08-10, that is EVERY policy on the live estate
   *  (0 control bindings, 0 control runs), so this array being empty is a fact about the estate's
   *  configuration and not a limit of this projection. */
  checks: z.array(ComponentPipelineCheckSchema)
});
export type ComponentPipelineGate = z.infer<typeof ComponentPipelineGateSchema>;

/**
 * WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING — a stage-scoped component coupling
 * (ADR-0028) is withholding its trigger, and this names what by.
 *
 * THE BUG IT REMOVES. A held wave target's `change_wave_targets.status` is and stays `pending`: the
 * hold `continue`s BEFORE `triggerWaveTarget`, so nothing advances it and nothing marks it. On this
 * view that rendered as the same amber `pending` a stage gets when the wave simply has not reached
 * it yet — so "waiting on something named" and "nothing is happening here" were the same picture,
 * which is the confusion ADR-0028 increment 4 exists to remove.
 *
 * PRESENT EXACTLY WHEN A TRIGGER IS BEING WITHHELD RIGHT NOW, and null otherwise — including for a
 * change that declared a coupling which is now satisfied. It is RE-EVALUATED LIVE on every request
 * by `resolveStageDependencyStatus`, never read off the persisted `stage_dependency` Decision:
 * nothing anywhere writes a clearing row, so that Decision stays `hold` forever — through the
 * trigger, through `accepted` — and a badge sourced from it would be the permanent-marker bug the
 * `hold` verdict (rather than `block`) was chosen to avoid, rebuilt on a read surface. The kind is
 * overloaded too: `applyPromotionImport` writes `stage_dependency`/`allow` for the import-time
 * strip, so on an outpost the newest row of that kind is an `allow` whatever the change is doing.
 *
 * WHOSE HOLD IT IS. Keyed on the wave target, which in stage mode IS the placement — so this is the
 * hold on THIS stage, not the change's hold anywhere. A change held at gamma and free at prod
 * carries this on its gamma stage alone.
 *
 * NOT IN `unknownFields` WHEN NULL, deliberately, and the one case that argues otherwise was
 * checked: on an OUTPOST an imported change has had its `stageDependencies` stripped
 * (`applyPromotionImport`), so the resolver has nothing to evaluate and this is null. That is not an
 * unknown — the commander already withheld the trigger until every dependency was satisfied there,
 * and its promotion of the bundle IS the go-ahead, so locally there genuinely is no hold. Null here
 * always means "no stage dependency is withholding this stage's release", never "we did not look".
 */
export const ComponentPipelineHoldSchema = z.object({
  /** The release being withheld. It is one of this stage's `currents[]` entries — a client shows the
   *  hold against the lane whose `current` this is, since a change can hold the `configuration`
   *  target at a place while the `infrastructure` pipeline there is simply idle. */
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  /** The wave being worked when the hold was evaluated — the first not `succeeded`/`skipped`. Null
   *  only when the change has no plan, which a held target cannot come from. */
  waveIndex: z.number().int().nullable(),
  /** ONLY THE UNSATISFIED verdicts, each naming the dependency, the ADR-0028 decision 4 branch that
   *  applied and a one-line summary — the same `describeStageDependencyHold` sentence the hold
   *  Decision's `reasonTree` is built from, so this view and the audit record cannot drift. Never
   *  empty: a hold with nothing unsatisfied is not a hold, and is reported as null above. */
  dependencies: z.array(ChangeStageDependencyVerdictSchema)
});
export type ComponentPipelineHold = z.infer<typeof ComponentPipelineHoldSchema>;

/**
 * ONE STAGE THE COMPONENT IS PLACED AT — one `placement` (ADR-0026): this component at one
 * deployment-target.
 *
 * A stage exists because the component IS PLACED there, not because something is releasing. That is
 * the correction this view was built for: the previous pipeline surface was keyed on a change, so a
 * component with nothing in flight had no pipeline at all.
 *
 * It is NOT the whole pipeline. The stages a component's releases are DECLARED to pass through come
 * from the release topology, and the ones it is not placed at are `unplacedStages` on the response —
 * see the note there for why the journey is split across two arrays rather than one.
 */
export const ComponentPipelineStageSchema = z.object({
  placement: z.object({ id: z.string().uuid(), urn: z.string() }),
  /** Position in the whole journey, shared with `unplacedStages`: concatenate both arrays and sort
   *  by this to get the pipeline in release order. Contiguous from 0 across the union, so the client
   *  never has to infer an interleaving. */
  order: z.number().int(),
  /** Which topology wave declares this stage. Null when the component is placed at a target NO wave
   *  names — real state, kept rather than hidden behind a document's omission — and null throughout
   *  when `stageSource` is `placements`. */
  wave: ComponentPipelineWaveSchema.nullable(),
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    /** ADR-0026 D1 — present only on a place-role target; without it no stage name derives. */
    environment: z.string().nullable(),
    region: z.string().nullable()
  }),
  /** WHOSE DOMAIN maintains this place — see `ComponentPipelineDomainSchema`. */
  maintainedBy: ComponentPipelineDomainSchema,
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1). Null when the target carries no
   *  `environment`: not every deployment-target is a stage, and inventing a name would be a lie. */
  stageName: z.string().nullable(),
  /** ONE of this stage's pipelines — see `bindings`. Retained because `/v1` is additive-only and it
   *  already ships required; it is `bindings[0]`, i.e. the lowest Type alphabetically, and a client
   *  rendering only this shows ONE of a stage's pipelines with no sign the others exist.
   *
   *  **Read `bindings`.** */
  binding: ComponentPipelineBindingSchema.nullable(),
  /**
   * EVERY PIPELINE BOUND AT THIS STAGE, ordered by Type — the `image` build, the `infrastructure`
   * plan/apply and the `configuration` sync are separate pipelines that a component runs at the same
   * place, and `UNIQUE(org_id, target_object_id, type)` exists precisely so one target can carry all
   * three at once (ADR-0007: Type IS the executor routing key). `listExecutorBindingsForTarget`'s
   * own docstring calls what it returns "every pipeline … (all Types)".
   *
   * This ships because the first version of this view read `bindings[0]` and rendered that alone, so
   * a stage carrying both a build and a deploy pipeline drew one of them and gave no hint of the
   * other — the two live deployment-targets each carry `image` + `configuration` today. Empty means
   * genuinely unbound, which is the ADR-0006 case (a) alarm; a NON-empty array is never truncated.
   */
  bindings: z.array(ComponentPipelineBindingSchema),
  /** The most recent change to touch this stage IN ANY pipeline — see `currents`. Retained because
   *  `/v1` is additive-only; it is the newest entry of `currents`. Rendering it against a particular
   *  pipeline would attribute one pipeline's release to another. **Read `currents`.** */
  current: ComponentPipelineCurrentSchema.nullable(),
  /**
   * THE MOST RECENT CHANGE PER PIPELINE — at most one entry per Category, newest first.
   *
   * A stage's pipelines release independently: the software pipeline may have run an hour ago and
   * the infra pipeline last month. Collapsing them to one "last release" makes whichever ran most
   * recently look like the state of ALL of them, so the quiet pipeline reads as up to date and the
   * lane that has never run reads as if it had. Per-Category is the smallest split that cannot lie,
   * and `change_wave_targets.type` (persisted per target at compile time) is what makes it a direct
   * read rather than an inference.
   */
  currents: z.array(ComponentPipelineCurrentSchema),
  /** WHAT MUST PASS to move a release INTO this stage — see `ComponentPipelineGateSchema`. */
  gate: ComponentPipelineGateSchema,
  /** WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW — see `ComponentPipelineHoldSchema`. Null
   *  when no stage dependency is holding it, which is the ordinary case.
   *
   *  `.nullable().optional()` and never `.default()`: `/v1` is additive-only (charter principle 3)
   *  and a default renders the property REQUIRED in the generated SDK type, which is an oasdiff
   *  ERR. It is a SIBLING of `currents[].targetStatus` rather than a new value inside it — that
   *  field is documented as `change_wave_targets.status` verbatim, and a held target's status IS
   *  and stays `pending`, so overloading it would make the raw column mean something it does not
   *  say. It is also NOT the service board's `blocked`: that flag is derived from a verdict-only
   *  Decision query with no recency gate, and conflating a transient self-clearing wait with a
   *  permanent marker is the exact bug ADR-0028 wrote `verdict: "hold"` to avoid. */
  hold: ComponentPipelineHoldSchema.nullable().optional(),
  /** ALWAYS null today, and ALWAYS listed in this stage's `unknownFields`.
   *
   *  The "version staircase" the design asks for needs a per-stage version/digest captured by
   *  `observe()` — coordination-ui-views.md Phase 4a, unbuilt. The field ships now, always-unknown,
   *  rather than being omitted: an absent field reads as "this view does not do versions", while an
   *  explicitly-unknown one reads as "not observed yet", which is the truth. Same rule as the
   *  service board's `unknownFields` and the graph health surfaces — absent renders `unknown`,
   *  never a confident zero. */
  version: z.string().nullable(),
  /** Dotted paths on THIS stage whose values are not observations. See `version`. */
  unknownFields: z.array(z.string())
});
export type ComponentPipelineStage = z.infer<typeof ComponentPipelineStageSchema>;

/**
 * A DECLARED STAGE THE COMPONENT NEVER REACHES — a place the release topology puts in this
 * component's journey, with no `placement` behind it.
 *
 * This is the single most operationally important thing a pipeline view can say, and the first
 * version of it said nothing at all: stages were derived from placements, so a wave the component is
 * not placed at did not exist in the view. Measured on the live estate the day it was reported —
 * topology `commercial-gamma-then-prod` declares gamma then prod, `agentkit-bootstrap` holds one
 * gamma placement, and prod rendered nowhere (owner, 2026-08-10).
 *
 * It carries no `binding`, `current` or `version`: all three are keyed on a placement that does not
 * exist, and inventing nulls for them would invite a client to render "no executor" — the ADR-0006
 * case (a) ALARM — over what is really just an absence of a placement. The two must not look alike.
 */
export const ComponentPipelineUnplacedStageSchema = z.object({
  /** Position in the whole journey — see `ComponentPipelineStageSchema.order`. */
  order: z.number().int(),
  /** Never null: an unplaced stage exists ONLY because a wave declares it. */
  wave: ComponentPipelineWaveSchema,
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    environment: z.string().nullable(),
    region: z.string().nullable()
  }),
  /** WHOSE DOMAIN maintains this place. A stage this component never reaches is still somebody's to
   *  run, and saying so is what stops "not placed" reading as "nowhere". */
  maintainedBy: ComponentPipelineDomainSchema,
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1), derived exactly as for a placed
   *  stage — the name is a property of the PLACE, not of this component being at it. */
  stageName: z.string().nullable()
});
export type ComponentPipelineUnplacedStage = z.infer<typeof ComponentPipelineUnplacedStageSchema>;

/** Which rung supplied the pipeline — the answer to "why does this component release this way?"
 *  (charter principle 6). `pipeline-resolution.ts` computes it; surfacing it here is what stops an
 *  inheritance surprise (someone attaches a topology to a SERVICE and every component changes). */
export const ComponentPipelineSourceSchema = z.object({
  topologyObjectId: z.string().uuid(),
  topologyName: z.string().nullable(),
  topologyVersion: z.number().int().nullable(),
  rung: z.enum(["component", "service", "organization"]),
  attachedToObjectId: z.string().uuid(),
  attachedToName: z.string().nullable()
});
export type ComponentPipelineSource = z.infer<typeof ComponentPipelineSourceSchema>;

/**
 * A component's pipeline: its stages, and where its pipeline definition came from.
 *
 * Derived entirely from durable graph state — the resolved release topology, the component's
 * placements, their bindings, and the `releases_via` attachment. It is well-defined for a component
 * that has never released, which the change-anchored surface it replaces could not represent at all.
 */
export const ComponentPipelineResponseSchema = z.object({
  component: z.object({ id: z.string().uuid(), urn: z.string(), name: z.string() }),
  /** Null when no rung supplies one — the component releases as a single anonymous wave. */
  pipeline: ComponentPipelineSourceSchema.nullable(),
  /** WHERE THE JOURNEY CAME FROM, which is what decides how to read an EMPTY `unplacedStages`.
   *
   *  `topology` — a stage-shaped release topology resolved, so the journey is its waves in release
   *  order and an empty `unplacedStages` genuinely means "this component reaches every declared
   *  stage".
   *
   *  `placements` — no rung supplies a stage-shaped topology (none is attached, its waves name the
   *  change's own targets rather than places, or the document is malformed). There is no declared
   *  journey, so `stages` is simply where the component is placed, every `wave` is null, and an
   *  empty `unplacedStages` means UNKNOWABLE, not "none". A client must not render "reaches every
   *  stage" from it. */
  stageSource: z.enum(["topology", "placements"]),
  /** EVERY source rule that feeds this component — the head of its journey. Empty means no push to
   *  any repo can ever release this component, which is the source-side twin of an unplaced stage
   *  and just as worth saying out loud. */
  sources: z.array(ComponentPipelineSourceMappingSchema),
  /** The stages the component IS placed at. Ordered by `order`, which interleaves with
   *  `unplacedStages`. Includes any place it is placed at that no wave names — never dropped, since
   *  that would hide real state behind a document's omission. */
  stages: z.array(ComponentPipelineStageSchema),
  /** The declared stages it is NOT placed at.
   *
   *  WHY THE JOURNEY IS TWO ARRAYS rather than one list with a nullable `placement`: `/v1` is
   *  additive-only (charter principle 3), and widening `stages[].placement` to nullable is an
   *  oasdiff ERR three times over — `response-property-type-changed` plus
   *  `response-required-property-removed` on `placement/id` and `placement/urn` (measured, not
   *  assumed). The split is not a workaround dressed up: these ARE two different facts — where the
   *  component is placed, and what the topology declares that it does not reach — and neither array
   *  repeats anything in the other. `order` makes their union a single ordered pipeline. Do NOT
   *  "simplify" this into one array without an `api-v2-exception` (tools/openapi/OASDIFF-EXCEPTIONS.md). */
  unplacedStages: z.array(ComponentPipelineUnplacedStageSchema),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineResponse = z.infer<typeof ComponentPipelineResponseSchema>;

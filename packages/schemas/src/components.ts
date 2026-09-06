import { z } from "zod";
import {
  ChangeStageDependencyVerdictSchema,
  WaveTargetObservedSchema,
  type WaveTargetObserved
} from "./changes.js";
import {
  ExecutorCategorySchema,
  PipelineClassificationSchema,
  SourceMappingScopeSchema
} from "./executors.js";
import { ControlOutcomeStatusSchema } from "./governance.js";
import {
  SbomRefSchema,
  ScanMethodSchema,
  ScanSeverityCountsSchema,
  ScanThresholdSchema
} from "./supply-chain.js";
import { PromotionManifestSchema } from "./federation.js";

// COMPONENT PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03)

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

/**
 * WHICH OUTPOST A TARGET IS PART OF (pipeline-substrate-registry-scan.md §10.2 — the owner's
 * TRUST-DOMAIN RULE; §10.5 — every target is within an outpost, the HQ outpost (formerly 'co-located'; GLOSSARY,
 * ADR-0021 D7)), resolved by
 * the server and READ by the client, never inferred.
 *
 * The rule: an `outpost` object carries `properties.peerDomainId` — a paired peer's federation
 * identity, i.e. its trust domain, OR (§10.5) this instance's OWN trust domain, the HQ
 * outpost (`outpost-binding.ts` refuses anything else); every object carries `originDomainId` — the
 * trust domain that authored it; ADR-0017 §1 puts one outpost deployment per trust domain. So a
 * target's outpost is THE `outpost` OBJECT WHOSE `peerDomainId` EQUALS THE TARGET'S `originDomainId`.
 * No new data. Never derived from the target's name, and never from its containment `domain_id`
 * (GLOSSARY: containment has nothing to do with deployment topology).
 *
 * Five states, each STATED — the identity fields are nullable per state, and a client renders the
 * state it is given rather than guessing from which fields happen to be null. PRECEDENCE (§10.5,
 * OBJECT-FIRST — this supersedes §10.2's self-first sentence): an `outpost` object naming the
 * target's origin domain wins WHETHER OR NOT that domain is self; then `self` (only when NO object
 * names this instance's domain); then the peer lookup. So on an outpost site its own targets read
 * `outpost <its own name> · <tier>` off its replica of its own config, and on a commander with a
 * HQ outpost registered its own targets read that outpost — `self` is the stated absence
 * of one.
 *   - `outpost`               — an `outpost` object names the target's origin domain (a paired peer's,
 *                               or this instance's own — §10.5). `id`/`name` are that object's;
 *                               `trustTier` its declared tier (null when the object declares none, or
 *                               one this build does not know — `outposts-repo.ts`'s `readTrustTier`,
 *                               never defaulted); `peerDomainId` the domain it names (the link target
 *                               on the commander site, `/federation/outposts/$peerDomainId`, which
 *                               renders the HQ record too); `peerRole` the peer row's role,
 *                               or this instance's `federation_self.role` when the domain is self.
 *   - `self`                  — the target's origin IS this instance (`federation_self`) and NO
 *                               `outpost` object names this instance's domain. `name` is this
 *                               instance's federation name; the rest null. A stated absence: "this
 *                               instance's domain — no outpost registered" (one can be declared under
 *                               Federation › Outposts with `peerDomainId` = this instance's domain id).
 *   - `peer-without-outpost`  — the origin is a paired peer of role `outpost` with NO `outpost` object
 *                               registered. `name` is the PEER's name and `peerDomainId` its id, so a
 *                               client can say who — and, because the peer's role IS `outpost`, that an
 *                               outpost record CAN be declared for it (POST /federation/outposts
 *                               accepts only `outpost`-role peers — `outpost-binding.ts`).
 *   - `peer-not-outpost`      — the origin is a paired peer whose role is NOT `outpost` (`commander`
 *                               or `retrans`). This is what EVERY commander-authored (replicated)
 *                               target reads on an outpost site. `name` is the peer's name,
 *                               `peerDomainId` its id, `peerRole` its role. No outpost record can be
 *                               declared for it — the API refuses (400) — so a client must NOT offer
 *                               that fix; it says `commander <name>` / `relay <name>`.
 *   - `unknown-domain`        — the origin names no peer known here (a replica whose peer row has not
 *                               arrived; a foreign origin this instance never paired with).
 *                               `peerDomainId` carries the raw origin id; the rest null. Not "ours".
 */
export const ComponentPipelineTargetOutpostSchema = z.object({
  state: z.enum(["outpost", "self", "peer-without-outpost", "peer-not-outpost", "unknown-domain"]),
  /** The `outpost` object's id — `outpost` only. */
  id: z.string().uuid().nullable(),
  /** `outpost`: the object's name; `self`: this instance's name; `peer-without-outpost` /
   *  `peer-not-outpost`: the peer's name; `unknown-domain`: null. */
  name: z.string().nullable(),
  /** The outpost object's declared `trustTier`, verbatim when this build recognises it; else null. */
  trustTier: z.string().nullable(),
  /** The trust-domain id the state is about: the peer's id (`outpost`, `peer-without-outpost`,
   *  `peer-not-outpost`) or the raw unrecognised origin (`unknown-domain`); null for `self`. */
  peerDomainId: z.string().nullable(),
  /** The paired peer's federation ROLE (`commander` / `outpost` / `retrans`), READ off its peer row,
   *  for the three peer states — the word a client uses for `peer-not-outpost` (`commander …` /
   *  `relay …`). For an `outpost` object naming THIS instance's own domain (§10.5) it is
   *  `federation_self.role`. Null for `self` and `unknown-domain`, and for an `outpost` object whose
   *  `peerDomainId` names neither self nor a peer row held here. */
  peerRole: z.string().nullable()
});
export type ComponentPipelineTargetOutpost = z.infer<typeof ComponentPipelineTargetOutpostSchema>;

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
  executionSystemName: z.string().nullable(),
  /** WHERE the ladder found it (ADR-0027/0029): "placement" when bound on the stage's own
   *  placement, else the ancestor's `object_types.id` verbatim ("component", "assembly",
   *  "service", "organization"). READ from the resolver's own provenance, never inferred
   *  (resolution-provenance.test.ts is the cautionary tale). Optional: absent on responses
   *  emitted before this field existed. */
  resolvedVia: z.string().optional()
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
  category: ExecutorCategorySchema,
  /** THE SAME `change_wave_targets.observed_state` SNAPSHOT `ChangeWaveTargetSchema.observed`
   *  documents — read here from the identical column, per pipeline, so the stage's `version`
   *  below can be derived rather than hardcoded (increment "per-stage version threading").
   *  ADDITIVE-OPTIONAL: absent on responses emitted before this field existed; `null` means the
   *  column itself was `null` (nothing observed yet), never fabricated. */
  observed: WaveTargetObservedSchema.nullable().optional()
});
export type ComponentPipelineCurrent = z.infer<typeof ComponentPipelineCurrentSchema>;

/**
 * THE SHARED VERSION-PREFERENCE RULE (ADR-0008 signal 1) — extracted so the server's stage
 * `version` derivation (`component-pipeline.ts`) and the web's per-target render
 * (`PipelineWaveCard.tsx`) cannot silently diverge on which observed field wins. Mirrors
 * `PipelineWaveCard.tsx`'s `realImages`/version-slot rules exactly: prefer the first REAL
 * (non-marker) deployed image over the git-style `revision`, because an image tag/digest is a
 * better human-facing version than an opaque SHA (decision 1). Returns `undefined` — never `""`
 * or `null` — when neither is observed, so a caller's own "unknown" handling stays a single `if`.
 *
 * `realImages` strips the persistence bound's marker slot using the record's own `droppedEntries`
 * COUNT, never by pattern-matching the stored value (M23.1g, the same rule `PipelineWaveCard.tsx`
 * documents at length) — a cut that removed every real entry leaves the array holding the marker
 * alone, and this must return `[]` for that case, not the marker string.
 */
export function realObservedImages(observed: WaveTargetObserved | null | undefined): string[] {
  const images = observed?.images;
  if (!images) return [];
  const entry = observed?.truncation?.images;
  if (typeof entry?.droppedEntries !== "number" || entry.droppedEntries <= 0) return images;
  return images.slice(0, -1);
}

export function preferredObservedVersion(
  observed: WaveTargetObserved | null | undefined
): string | undefined {
  return realObservedImages(observed)[0] ?? observed?.revision;
}

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
  /** DECLARED provenance (outpost-ui.md §9.3a): `true` = a local mirror of a commander-shared repo;
   *  `false` = domain-specific, tracked only in this domain. The source lane groups by it. Read,
   *  never inferred; never an enforcement input. */
  mirrorOfShared: z.boolean(),
  /** The operator's pause switch (migration 0063) — `false` means this source tile is declared but
   *  `matchComponentForSource` skips it, so a push that matches its repo/path/ref routes nowhere.
   *  This is what lets the UI give each source its own enable/disable, not just its own arrow. */
  enabled: z.boolean(),
  /** Timed close bound, or null; and the read-time truth the matcher acts on. The arrow is
   *  painted from `effectivelyEnabled`, never from `enabled` alone. */
  disabledUntil: z.string().datetime().nullable(),
  effectivelyEnabled: z.boolean(),
  /** The repo's web page, or null when it cannot be known — a GLOBBED `repoPattern` names a set of
   *  repos rather than a page, and a self-hosted provider's host is not recorded on a mapping. */
  url: z.string().nullable(),
  /** DECLARED reach (§10.6, migration 0066): `global` → the tile's eyebrow reads "GLOBAL — shared
   *  across domains"; `domain` → "DOMAIN-SPECIFIC — tracked only here"; `null` (not declared) → NO
   *  eyebrow, nothing inferred. `mirrorOfShared` wins the eyebrow when both are set. Read, never
   *  inferred; never an enforcement input. Required-nullable like `mirrorOfShared`/`disabledUntil`
   *  (a new REQUIRED response property is additive within /v1). */
  scope: SourceMappingScopeSchema.nullable()
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
    region: z.string().nullable(),
    /**
     * THE SUBSTRATE FACET (pipeline-substrate-registry-scan.md §9.1) — what the target physically
     * IS, read verbatim from the target's own `properties` (migration 0065 types them as optional
     * strings; a non-string is read as absent). Well-known `substrate` values are GLOSSARY
     * vocabulary (`aws|gcp|azure|kubernetes|vm|bare-metal|other`), rendered as-is, never enforced
     * on the wire. Null = NOT DECLARED — an absence of a declaration, not an unknown observation,
     * so a client renders nothing (no `—`, no badge). A client MUST NOT derive any of these from
     * `name`: fixture names like `us-east-1-prod (k8s)` look parseable and are exactly the trap.
     */
    substrate: z.string().nullable(),
    /** Provider account / project / subscription id. Same reading rules as `substrate`. */
    account: z.string().nullable(),
    /** Cluster name inside that account/region. Same reading rules as `substrate`. */
    cluster: z.string().nullable()
  }),
  maintainedBy: ComponentPipelineDomainSchema,
  /** WHICH OUTPOST this place is part of — see `ComponentPipelineTargetOutpostSchema` (§10.2).
   *  Required: the server always resolves it (a state, never an omission), and a required additive
   *  response property is the class #222 measured oasdiff accepts. */
  outpost: ComponentPipelineTargetOutpostSchema,
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
  /** THE "version staircase" the design asks for (coordination-ui-views.md Phase 4a) — derived
   *  from this stage's newest `currents[0].observed` via `preferredObservedVersion`
   *  (`realObservedImages`'s first entry, else the git-style `revision`), the SAME preference
   *  `PipelineWaveCard.tsx`'s per-target render applies, so the two can never disagree about which
   *  observed field wins. `null`, with `"version"` listed in `unknownFields` below, exactly when
   *  the stage has never had a wave target report `observed` at all — a real absence, not a
   *  confident zero. Once observed, this stays populated even after the change that produced it
   *  moves on: it is the newest OBSERVED value, not a property of the change in flight. */
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
  order: z.number().int(),
  /** Never null: an unplaced stage exists ONLY because a wave declares it. */
  wave: ComponentPipelineWaveSchema,
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    environment: z.string().nullable(),
    region: z.string().nullable(),
    /** The substrate facet — same fields, same reading rules as `ComponentPipelineStageSchema
     *  .deploymentTarget`: the server builds ONE literal and pushes it into both arrays, so the two
     *  shapes must not drift. */
    substrate: z.string().nullable(),
    account: z.string().nullable(),
    cluster: z.string().nullable()
  }),
  /** WHOSE DOMAIN maintains this place. A stage this component never reaches is still somebody's to
   *  run, and saying so is what stops "not placed" reading as "nowhere". */
  maintainedBy: ComponentPipelineDomainSchema,
  /** WHICH OUTPOST this place is part of — the SAME literal the server pushes into `stages[]`
   *  (`ComponentPipelineTargetOutpostSchema`, §10.2); the two shapes must not drift. */
  outpost: ComponentPipelineTargetOutpostSchema,
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1), derived exactly as for a placed
   *  stage — the name is a property of the PLACE, not of this component being at it. */
  stageName: z.string().nullable()
});
export type ComponentPipelineUnplacedStage = z.infer<typeof ComponentPipelineUnplacedStageSchema>;

/**
 * THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE (pipeline-substrate-registry-scan.md §9.2).
 *
 * Resolved from the component's outgoing `publishes_to` edges (component → execution-system,
 * migration 0065) — a GRAPH FACT, deliberately not the `image` executor binding: a binding's Type is
 * WHICH PIPELINE it drives (ADR-0007), so the image binding names what BUILDS the artifact, never
 * where it lands. A registry is created `domainLocal:true` at each site and an edge with a
 * domain-local endpoint never journals (M20.3), which is what makes this per-site by construction:
 * the commander's Delivery lane shows the commander's registry, an outpost's shows its own.
 *
 * `state` is STATED, never chosen:
 *   `none`      — no `publishes_to` edge here; every identity field null, `edgeCount` 0. A client
 *                 says "no registry declared for this component here" — an absence, not an unknown.
 *   `declared`  — exactly one edge; the identity fields describe it.
 *   `ambiguous` — MORE than one edge. The identity fields are null and `edgeCount` says how many;
 *                 the projection does NOT pick one (there is no rule that would make the pick
 *                 honest, and "one per site" is a projection statement, not a DB constraint).
 */
export const ComponentPipelineRegistrySchema = z.object({
  state: z.enum(["declared", "ambiguous", "none"]),
  /** The execution-system object's id (`declared` only). */
  executionSystemId: z.string().uuid().nullable(),
  /** Its `name` — READ from the object, never from the component. */
  name: z.string().nullable(),
  /** Its `properties.kind` (`gitea`, `harbor`, `ecr`, …) when it is a string; null otherwise. */
  kind: z.string().nullable(),
  /** Console base — `webUrl`, else `serverUrl`, trailing slash trimmed (`executionSystemConsoleBase`).
   *  Base only: no registry has a known deep-link shape here, and a guessed path is a lie. */
  url: z.string().nullable(),
  /** The edge's own `properties.repository` (the repository/path inside the registry, e.g.
   *  `acme/checkout-api`) when it is a string; null otherwise. */
  repository: z.string().nullable(),
  /** How many `publishes_to` edges the component has here — 0, 1, or the count behind `ambiguous`. */
  edgeCount: z.number().int()
});
export type ComponentPipelineRegistry = z.infer<typeof ComponentPipelineRegistrySchema>;

/**
 * ONE SCAN VERDICT over ONE artifact digest (pipeline-substrate-registry-scan.md §9.3) — a
 * `control_runs` row of the artifact's change whose `evidence` parses as `ScanEvidenceSchema`,
 * reduced to the NEWEST per (`scanner`, `digest`). Only what the evidence holds is here: severity
 * COUNTS, never a CVE list (none is stored — §8 "Scan").
 *
 * `managed` is THE ONE server-side discriminator between the commander's own promotion scan step
 * (promotion-scan-step.ts, the synthetic control id) and an org-pipeline `scan-result-control`
 * run — the wire `ControlRun` carries no gateKind/gateRef, so without this flag the two are
 * indistinguishable to a client. Read from `controlObjectId`, not inferred from the scanner.
 */
export const ComponentPipelineScanRunSummarySchema = z.object({
  /** The scan METHOD (`trivy` / `trivy-vm` / `openscap`) — the managed step's `gateRef.method`
   *  when the run carries one, else the evidence's own `scanner`. */
  method: z.string(),
  scanner: ScanMethodSchema,
  scannerVersion: z.string(),
  digest: z.string(),
  /** `evidence.digestMatch` — true iff the scanned digest equals the promoted one. Null only if
   *  the evidence omitted it (the schema requires it, so today never — kept nullable for an older
   *  evidence document). */
  digestMatch: z.boolean().nullable(),
  status: ControlOutcomeStatusSchema,
  counts: ScanSeverityCountsSchema.nullable(),
  /** The threshold the verdict was evaluated against, verbatim; null when the evidence omitted it. */
  threshold: ScanThresholdSchema.nullable(),
  /** The control run's `created_at` — when the verdict was recorded here. */
  evaluatedAt: z.string().datetime(),
  controlRunId: z.string().uuid(),
  managed: z.boolean()
});
export type ComponentPipelineScanRunSummary = z.infer<typeof ComponentPipelineScanRunSummarySchema>;

/**
 * ONE EXPORT OF THIS CHANGE TO ONE PEER, as the commander stamped it at export time (§9.4 —
 * `sourceRef.promotionExports[]`, written under the same row lock as `boundaryBundleChecksums`).
 * This is WHAT THE COMMANDER SIGNED: its own promotion manifest (ADR-0015 §5 — SCP never signs an
 * origin artifact), the detached cosign signature over `canonicalStringify(manifest)`, and the
 * fingerprint of the instance key that signed it. A record here says "signed and exported"; it
 * says nothing about arrival or verification at the peer (`boundary-segment.ts` R1).
 */
export const ComponentPipelinePromotionExportSchema = z.object({
  peerDomainId: z.string(),
  /** The peer's `name` when a `federation_peers` row still exists for it here; null otherwise. */
  peerName: z.string().nullable(),
  exportedAt: z.string(),
  /** The Ed25519 bundle checksum — the same value `boundaryBundleChecksums[]` carries. */
  checksum: z.string(),
  manifest: PromotionManifestSchema,
  manifestSignature: z.string(),
  /** SHA-256 hex of the signing instance's cosign public-key PEM; null on a stamp written before
   *  the fingerprint was recorded. */
  keyFingerprint: z.string().nullable()
});
export type ComponentPipelinePromotionExport = z.infer<
  typeof ComponentPipelinePromotionExportSchema
>;

/**
 * THE IMPORTED PROMOTION MANIFEST (§10.4) — what an OUTPOST's Registry tile shows about the artifact
 * that ARRIVED there. At promotion import the receiving instance stamps, on the imported change's
 * `sourceRef`, the exporter's `promotionManifest` + detached cosign `manifestSignature` (plus
 * `promotedFromDomain`, `artifactDigests[]`, `artifacts[]`, `boundaryBundleChecksums`). Import
 * REJECTS on any signature / set-equality / digest-tie failure (`verifyPromotionManifest`), so a
 * manifest stored here was verified at import BY CONSTRUCTION — the projection re-verifies nothing.
 *
 * Non-null ONLY when BOTH the manifest (parsing as `PromotionManifestSchema`) AND the signature are
 * stamped. A manifest without a signature is stated in `artifact.unknownFields` as
 * `importedManifest:unsigned`; a manifest that does not parse as `importedManifest:unparseable`;
 * neither key ⇒ null with no note (nothing arrived — the commander site reads this).
 *
 *   - `exporterDomainId` — `manifest.exporterDomainId`, verbatim.
 *   - `exporterName`     — the paired peer's `name` here when a `federation_peers` row carries that
 *                          domain id (the exporter IS a paired peer at the importer); null otherwise.
 *   - `importedFromDomain` — `sourceRef.promotedFromDomain` when it is a string; null otherwise.
 *   - `artifactCount`    — `manifest.artifacts.length`.
 */
export const ComponentPipelineImportedManifestSchema = z.object({
  manifest: PromotionManifestSchema,
  manifestSignature: z.string(),
  exporterDomainId: z.string(),
  exporterName: z.string().nullable(),
  importedFromDomain: z.string().nullable(),
  artifactCount: z.number().int().nonnegative()
});
export type ComponentPipelineImportedManifest = z.infer<
  typeof ComponentPipelineImportedManifestSchema
>;

/**
 * THE ARTIFACT this pipeline is about, and every CHANGE-SCOPED fact the projection holds about it
 * (§9.3). The pipeline is component-scoped; a digest, an SBOM reference, a scan verdict and a
 * signed manifest are all facts about ONE CHANGE — so the projection PICKS a change and STATES the
 * pick (`changeId`, `changeName`, `changeCreatedAt`): the newest change of the component whose
 * `sourceRef` carries an artifact digest, preferring the changes at the stages' currents/holds,
 * else the component's newest such change at all. No such change ⇒ the response carries
 * `artifact: null` — "no artifact yet", not an empty artifact.
 *
 * Every field is READ from stored data or stated absent:
 *   - `digests`     — `sourceRef.artifact_digest` / `artifactDigest` (string or string[]) plus the
 *                     importer's `artifactDigests[]` stamp, union in that order, de-duplicated,
 *                     verbatim.
 *   - `sbom`        — `sourceRef.sbom` when it parses as `SbomRefSchema`; else null and
 *                     `unknownFields` carries `sbom:unparseable` (a malformed reference is stated,
 *                     not silently dropped).
 *   - `scans`       — see `ComponentPipelineScanRunSummarySchema`.
 *   - `exportGate`  — the E6 export gate's OWN predicate applied read-only over the same runs:
 *                     `not_run` when no scan evidence exists at all; else `pass`/`fail`. It is a
 *                     re-evaluation, never a remembered verdict (E6 writes no Decision on pass).
 *   - `signing.promotionExports`   — the §9.4 stamps, newest last (append order).
 *   - `signing.originSignatureRefs` — every ORIGIN `signatureRef` the sourceRef holds (today only
 *                     the SBOM blob's; there is no artifact-level one — an empty array is the honest
 *                     answer, never a fabricated ref).
 *   - `signing.importedManifest` — §10.4, see `ComponentPipelineImportedManifestSchema`. Optional
 *                     on the wire (additive; an older server omits it), null when nothing arrived
 *                     under a signed manifest.
 */
export const ComponentPipelineArtifactSchema = z.object({
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  changeCreatedAt: z.string().datetime(),
  digests: z.array(z.string()),
  sbom: SbomRefSchema.nullable(),
  scans: z.array(ComponentPipelineScanRunSummarySchema),
  exportGate: z.enum(["pass", "fail", "not_run"]),
  signing: z.object({
    promotionExports: z.array(ComponentPipelinePromotionExportSchema),
    originSignatureRefs: z.array(z.string()),
    importedManifest: ComponentPipelineImportedManifestSchema.nullable().optional()
  }),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineArtifact = z.infer<typeof ComponentPipelineArtifactSchema>;

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
 * THE OBSERVED CI RUN a change names — component-journey-view.md §3 Segment 2's "upstream build"
 * case. `sourceKind` is the change's own `source_kind` ("github"/"gitea"/"gitlab" — the only kinds
 * `observed-run-facts.ts` reads run identity out of today). `repo` and `url` are nullable because the
 * "carries run identity" predicate accepts either alone (a citable run id plus AT LEAST ONE of
 * url/repo); `workflowName`/`workflowPath` are nullable because not every provider's writer shape
 * cites them (gitea's `GiteaActionRun` and gitlab's `GitlabPipeline` name neither). `observedAt` is
 * the CHANGE's own `created_at` (when SCP recorded it), not a field read out of the run payload —
 * every writer's `sourceRef` names a run creation time under a different, unpinned key. `changeId`
 * is the change this was read off, the same way `artifact.changeId` states its pick.
 */
export const ComponentPipelineObservedRunSchema = z.object({
  sourceKind: z.string(),
  repo: z.string().nullable(),
  runId: z.string(),
  workflowName: z.string().nullable(),
  workflowPath: z.string().nullable(),
  url: z.string().nullable(),
  observedAt: z.string().datetime(),
  changeId: z.string().uuid()
});
export type ComponentPipelineObservedRun = z.infer<typeof ComponentPipelineObservedRunSchema>;

/** The deployment-target a correlated infrastructure change was matched THROUGH — null for a
 *  coupling-only match, which names no place at all (owner decision, 2026-08-24). */
export const ComponentPipelineCorrelatedInfraTargetSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string().nullable()
});

/**
 * ONE infrastructure change correlated to this component (owner decision, 2026-08-24,
 * correlated-infrastructure lane): an infrastructure change is correlated when its wave/bound
 * target names a deployment-target one of this component's placements ALSO names, or this
 * component is `hosted_on` it; a `provides`/`requires` coupling additionally correlates, rendered
 * with a distinct route so a client never renders it as though it were a placement-level fact it
 * is not. `correlatedVia.route` states WHICH kind of match this is — read off the server's own
 * matching, never re-derived client-side. `placement` beats `hosted_on` when both would apply to
 * the same target (a component is rarely both placed at and `hosted_on` the same place, but the
 * placement fact is the more specific one when it happens); a change found ONLY via a coupling
 * gets `route: "coupling"` and a null `target` — there is no place to name for that match. This
 * component's OWN changes are excluded (the lane already renders its own pipeline) by reading
 * `properties.targets`, never re-derived from placement/wave-target identity.
 */
export const ComponentPipelineCorrelatedInfraChangeSchema = z.object({
  changeObjectId: z.string().uuid(),
  name: z.string().nullable(),
  state: z.string(),
  type: z.string(),
  createdAt: z.string().datetime(),
  correlatedVia: z.object({
    route: z.enum(["placement", "hosted_on", "coupling"]),
    target: ComponentPipelineCorrelatedInfraTargetSchema.nullable()
  }),
  /** The `provides`/`requires` key this change satisfies for this component, or null when the
   *  match carries no coupling (a placement/hosted_on-only match). A `placement`/`hosted_on` match
   *  MAY still carry one, when both arms independently correlate the same change. */
  coupledKey: z.string().nullable()
});
export type ComponentPipelineCorrelatedInfraChange = z.infer<
  typeof ComponentPipelineCorrelatedInfraChangeSchema
>;

/** THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — every infrastructure change
 *  this component's placements/hosted-on/couplings implicate, that is not this component's own.
 *  The server ALWAYS emits `{ changes: [...] }` (possibly empty) once it has evaluated the
 *  correlation — an empty array is a real, evaluated "none found", never confused with "not
 *  computed". */
export const ComponentPipelineCorrelatedInfraSchema = z.object({
  changes: z.array(ComponentPipelineCorrelatedInfraChangeSchema)
});
export type ComponentPipelineCorrelatedInfra = z.infer<
  typeof ComponentPipelineCorrelatedInfraSchema
>;

/**
 * A component's pipeline: its stages, and where its pipeline definition came from.
 *
 * Derived entirely from durable graph state — the resolved release topology, the component's
 * placements, their bindings, and the `releases_via` attachment. It is well-defined for a component
 * that has never released, which the change-anchored surface it replaces could not represent at all.
 */
export const ComponentPipelineResponseSchema = z.object({
  component: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string(),
    /** WHO MAINTAINS THIS COMPONENT (outpost-ui.md §9.3a) — same shape as a stage's `maintainedBy`.
     *  `isSelf: false` on an outpost means the commander (or another peer) is UPSTREAM of this
     *  domain's repos in the source lane; `isSelf: true` means this domain authored it. */
    maintainedBy: ComponentPipelineDomainSchema,
    /** ADR-0031 — a domain-local component has NO upstream: its repo is the source, and no
     *  commander appears ahead of it. Structurally consistent with `maintainedBy.isSelf` (a
     *  domain-local object never journaled, so it is always self-maintained). */
    domainLocal: z.boolean()
  }),
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
  /** THE REGISTRY at this site — see `ComponentPipelineRegistrySchema`. Optional on the wire because
   *  `/v1` is additive-only and this shipped after the response did; a server that emits it always
   *  emits an object (`state: "none"` is a value, not an omission). Null/absent = an older server. */
  registry: ComponentPipelineRegistrySchema.nullable().optional(),
  /** THE ARTIFACT and its change-scoped facts — see `ComponentPipelineArtifactSchema`. Optional on
   *  the wire (additive-only `/v1`); a server that emits it sends an object or `null` (null = no
   *  change of this component carries an artifact digest — "no artifact yet"). Absent = an older
   *  server. */
  artifact: ComponentPipelineArtifactSchema.nullable().optional(),
  /** THE OBSERVED CI RUN — component-journey-view.md §3 Segment 2's "upstream build" marker: "the
   *  distinction [coordinated vs upstream] is the whole point of §2, and it must be visible … it
   *  reads 'GitHub Actions · CI · run 30858160395 ↗', not 'build: unknown'". Composed from the MOST
   *  RECENT change of this component whose `sourceRef` carries a citable run id AND at least one of
   *  `url`/`repo` (`coordination/observed-run-facts.ts`) — every provider webhook/observe writer
   *  shape this instance traces (github/gitea flat-and-nested, gitlab pipeline/webhook) is read
   *  defensively; an unrecognized or malformed shape counts as absent, never guessed. Optional on the
   *  wire (additive-only `/v1`); a server that emits it sends an object or `null` (null = no change
   *  names a run). Absent = an older server. */
  observedRun: ComponentPipelineObservedRunSchema.nullable().optional(),
  /** THE CORRELATED-INFRASTRUCTURE LANE — see `ComponentPipelineCorrelatedInfraSchema`. Optional on
   *  the wire (additive-only `/v1`; this shipped after the response did). A server that has
   *  evaluated correlation always sends an object (`{ changes: [] }` is itself a value — "evaluated,
   *  none found"). Absent = an older server that never computed this at all; a client must keep the
   *  two distinguishable, the same rule `registry`/`artifact`/`observedRun` already follow. */
  correlatedInfra: ComponentPipelineCorrelatedInfraSchema.nullable().optional(),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineResponse = z.infer<typeof ComponentPipelineResponseSchema>;

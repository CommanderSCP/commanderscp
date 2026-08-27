import { z } from "zod";
import { UrnSchema } from "./graph.js";
import { ExecutorTypeSchema, type ExecutorType } from "./executors.js";

/**
 * `@scp/schemas` — pipeline BEHAVIOUR contract: test hooks, rollout declarations, convergence, and
 * the evidence those produce (docs/proposals/team-pipeline-iac.md D11/D12/D13/D21/D23/D24/D25).
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS, AND WHY IT IS IN `@scp/schemas` RATHER THAN `@scp/iac`
 * ============================================================================================
 * Same rationale as `iac.ts`: the manifest is the ONE interchange point between offline authoring
 * and server-side reconciliation, so producer (`packages/iac`) and consumer (`apps/server`) must
 * share one contract or they drift. D16(6) makes that explicit for this surface — the construct
 * props in `@scp/iac` reuse the Zod types below VERBATIM, so a prop can never accept something
 * plan/apply refuses.
 *
 * The split is deliberate and cross-session: this file is the semantics (what a hook MEANS, what
 * evidence must PROVE); `@scp/iac`'s `Workflow` / `PostMergeTest` / `PostDeployTest` /
 * `ContinuousTest` / `BakeAlarms` / `CanaryRollout` / `RollingRollout` constructs are the authoring
 * sugar over it, and are built against these types once they are merged — never in parallel with
 * them.
 *
 * ============================================================================================
 * THE THREE MECHANISMS, AND WHICH ONE EACH HOOK COMPILES TO (measured, not assumed)
 * ============================================================================================
 * CommanderSCP has exactly two re-evaluated admission mechanisms, and they differ in blast radius:
 *
 *   WAVE-BOUNDARY GATE  — `coordination/gates.ts`'s `evaluateWaveGate`, called from
 *     `reconcile.ts`'s `if (activeWave.status === "pending")` branch. It is EVALUATED EVERY TICK
 *     while the wave stays pending and fires the transition exactly once; a blocked wave simply
 *     stays `pending` and is re-decided next tick (`gate-orchestrator.ts`: "waiting at a wave
 *     boundary can never deadlock the engine"). Blocking here stops the WHOLE wave.
 *
 *   PER-TARGET HOLD     — ADR-0028's shape: a predicate re-derived per target per tick, refusing
 *     by `continue` inside `reconcile.ts`'s per-target loop, so SIBLINGS PROCEED. A held target's
 *     `status` stays `pending`; the hold explains that status, it does not replace it.
 *
 * The choice per hook is therefore a statement about what SHOULD happen to the siblings, and each
 * one below is picked on that basis rather than by analogy:
 *
 *   postMerge   -> wave-boundary gate at WAVE 1. See the `postMerge` doc for why this is not, and
 *                  cannot be, a gate on "entry to the registry" (owner ruling, 2026-08-26).
 *   postDeploy  -> wave-boundary gate at the NEXT wave's entry. Gating "promotion out of wave N"
 *                  IS gating "entry into wave N+1"; a failing integration suite must stop the whole
 *                  widening, not one target of it.
 *   bakeAlarms  -> wave-boundary gate at the NEXT wave's entry, with evidence collected PER TARGET
 *                  (each target's quiet window starts when THAT target deployed). Owner ruling
 *                  2026-08-26, matching D21(b)'s literal "the wave's exit stays closed": an alarm
 *                  anywhere in wave N stops the widening to wave N+1, which is the entire point of
 *                  progressive delivery. A per-target hold would keep widening around the one
 *                  target that noticed.
 *   continuous  -> PER-TARGET HOLD, and this one genuinely must be: a stale canary probe on target
 *                  A says nothing about target B, so blocking B would be a lie about what is known.
 *
 * ============================================================================================
 * ASYNCHRONY: A TEST RUN TAKES MINUTES, AND THE CONTRACT ALREADY HAS A WORD FOR THAT
 * ============================================================================================
 * `ControlOutcomeStatus` has no `pending`/`running` member, and it does not need one. The shipped
 * async precedent is `github-check`, which returns `expired` while CI is still in flight ("STILL-
 * RUNNING CI -> `expired`, NOT `fail`"), and `control-runner.ts` re-polls ONLY `expired`, at most
 * once per `EXPIRED_RECHECK_INTERVAL_MS`. Every other status is cached for that gate crossing
 * forever. An in-flight Argo Workflows run is exactly the same situation and takes exactly the same
 * answer — so nothing here invents a new outcome vocabulary, and a hook whose run has not concluded
 * MUST NOT report `fail`.
 */

// ---------------------------------------------------------------------------------------------
// Canonical D24 vocabularies — artifact class, infra kind, the deploy-target narrowing, and the
// compatibility matrix that ties them together. Lives ONCE here per D24 ("the compatibility matrix
// ... lives once in @scp/schemas, shared by the construct types and the server"); `@scp/iac`'s
// construct types and the server's plan-time validation both consume these, never a hand-rolled copy.
//
// These replaced two PROVISIONAL declarations (`ArtifactClassSchema` as a bare `z.enum([...])`,
// `RolloutTargetClassSchema` likewise) that a sibling session shipped so the pipeline-behaviour
// contract could merge before this vocabulary existed. Every reference to either symbol below is
// unchanged by the replacement — same name, same shape — only the DEFINITION moved from a hand-
// written list to a derivation of `ExecutorTypeSchema` / `InfraKindSchema`.
// ---------------------------------------------------------------------------------------------

/**
 * D24's infra-kind taxonomy — the closed set of infrastructure PRODUCT kinds (§14 resolution 10:
 * "a new kind arrives as a release carrying the enum value, the typed construct + interface, and
 * its matrix rows"; org-defined custom kinds wait for a real tenant ask). `@scp/iac`'s matching
 * interface types (`ICluster`, `IInstanceGroup`, `IDatabase`, `IBucket`, `IQueue`) are built against
 * this enum by the core IaC increment, not defined here.
 *
 * SPELLING, RECONCILED DELIBERATELY: D24's prose names the kubernetes kind `Cluster` (as in
 * `ICluster`), but the vocabulary that shipped first — the provisional `RolloutTargetClassSchema`
 * this file already carried (`"kubernetes" | "instanceGroup"`) — spelled it `kubernetes`. This enum
 * picks **`cluster`**, matching D24's own construct-name vocabulary and the sibling members' shape
 * (`instanceGroup`, `database`, `bucket`, `queue` are all named after the KIND OF THING, not the
 * technology backing it — `database` isn't spelled `postgres`). `kubernetes` was the odd one out:
 * it named the implementation, not the product kind, and every other member already named the kind.
 * `RolloutTargetClassSchema` below is now DERIVED from this enum, so its `kubernetes` member is
 * renamed to `cluster` as part of the same change — `@scp/plugin-api`'s sanctioned third copy
 * (`packages/plugin-api/src/index.ts`) is renamed identically, and its pinning test
 * (`rollout-capability-vocabulary.test.ts`) is updated in lockstep so no side is left holding the
 * old spelling.
 */
export const InfraKindSchema = z.enum(["cluster", "instanceGroup", "database", "bucket", "queue"]);
export type InfraKind = z.infer<typeof InfraKindSchema>;

/**
 * D13/D24's artifact-class taxonomy, DERIVED as the "build family" subset of `ExecutorTypeSchema`
 * (`@scp/schemas/executors`) — never a second hand-written list. D13's ruling this session: "Type
 * stays the closed three-value enum" describes this package's **Category**, not `ExecutorType`; the
 * resolution was to extend `ExecutorTypeSchema` itself with the missing artifact classes so one
 * vocabulary covers everything, and make this a genuine subset of it.
 *
 * MECHANISM: `.exclude(["infrastructure", "configuration"])` rather than `.extract([...the nine
 * build members...])`, on purpose. `ExecutorCategorySchema` is closed at exactly three values
 * forever (build/infrastructure/configuration — never stored, never accepted as input, see
 * `executors.ts`), so "the build family" is structurally "every Type that is not infrastructure and
 * not configuration" — a fact that holds by construction, not by enumeration. Excluding the two
 * non-build members means a FUTURE build-family addition to `ExecutorTypeSchema` (another artifact
 * class) is automatically part of `ArtifactClassSchema` with no second edit required and no chance
 * to forget one; `.extract()` would have needed that second edit every time. Both `.exclude()` and
 * `.extract()` are compile-checked against `ExecutorTypeSchema`'s own literal union (a member that
 * does not exist on the base enum fails to type-check), so either direction satisfies "cannot
 * drift" for members that DO exist — this choice is about which one also protects against a
 * forgotten ADD.
 */
export const ArtifactClassSchema = ExecutorTypeSchema.exclude(["infrastructure", "configuration"]);
export type ArtifactClass = z.infer<typeof ArtifactClassSchema>;

/**
 * D12/D24's target class — "TargetClass is this same discriminant — one vocabulary, not two" — now
 * a DERIVED NARROWING of `InfraKindSchema`: only the infra kinds an artifact can actually be
 * DEPLOYED ONTO. D24 is explicit that `Database`/`Bucket`/`Queue` are producible and referenceable
 * (`dependsOn`, `hosted_on`) but "are never deploy targets for artifacts at all" — a rollout
 * declaration keyed by one of them is not a thing that can exist, so it must not be a value this
 * type can hold.
 *
 * MECHANISM: `.extract(["cluster", "instanceGroup"])` — an explicit allow-list, DELIBERATELY THE
 * OPPOSITE CHOICE from `ArtifactClassSchema` above, and for a reason that has to be stated or it
 * looks like an inconsistency: here the narrow set (deploy targets) is the minority, and widening it
 * must never happen by default. §14 resolution 10 already requires any new `InfraKind` to arrive
 * "with its matrix rows" as a deliberate act; if this were instead `InfraKindSchema.exclude([
 * "database", "bucket", "queue"])`, a future non-deploy-target kind (say, a `LoadBalancer` product
 * that is likewise never an artifact's placement) would silently become a legal rollout target the
 * moment it was added to `InfraKindSchema`, purely because nobody remembered to add it to an
 * exclude list — exactly the "widen it later for consistency" failure this declaration exists to
 * prevent. An allow-list forces every widening through an edit that names the new deploy target
 * explicitly, here, next to this comment.
 */
export const RolloutTargetClassSchema = InfraKindSchema.extract(["cluster", "instanceGroup"]);
export type RolloutTargetClass = z.infer<typeof RolloutTargetClassSchema>;

/**
 * D24's artifact-class × infra-kind compatibility matrix — the SINGLE definition shared by the
 * construct types (`@scp/iac`, core IaC increment) and the server's plan-time validation
 * (`evaluatePlacementCompatibility`-shaped checks). Keyed on the FULL `ExecutorType` (all eleven
 * members, not just the nine-member `ArtifactClassSchema`) because D24's own initial-rows list
 * includes `configuration` — a GitOps sync pipeline places at a cluster or instance group exactly
 * like a build artifact does, so it needs a row too, and keying on `ExecutorType` gives it one for
 * free instead of inventing a second, wider key type.
 *
 * TOTALITY IS THE POINT: `Record<ExecutorType, readonly InfraKind[]>` is a TOTAL mapping keyed by
 * the enum itself, not a partial lookup table with a fallback default. Adding a member to
 * `ExecutorTypeSchema` without adding its row HERE is a TypeScript compile error (a missing required
 * key on the `Record`), not a silent gap that only shows up when someone tries to place that type
 * and gets an unexplained refusal — or worse, an unchecked placement.
 *
 * ROWS: `image`/`chart` → cluster; `rpm`/`deb`/`vm-image` → instance group (`deb` is not named in
 * D24's own initial-rows prose, which predates `deb` being folded into the artifact-class
 * vocabulary this session — it is given the same row as `rpm`, the other OS-package artifact class,
 * rather than left with no row, which the `Record` type does not allow); `configuration` → cluster
 * OR instance group (ADR-0017 GitOps sync targets either); `npm`/`maven`/`python`/`go` → empty
 * (library artifacts that publish to a registry and are never placed anywhere — D24: "publish and
 * are never placed"); `infrastructure` → empty (an infrastructure pipeline PRODUCES the infra
 * product, it is never itself placed at one — "placement" is not a concept that applies to it).
 */
export const ARTIFACT_INFRA_COMPATIBILITY: Record<ExecutorType, readonly InfraKind[]> = {
  image: ["cluster"],
  chart: ["cluster"],
  rpm: ["instanceGroup"],
  deb: ["instanceGroup"],
  "vm-image": ["instanceGroup"],
  configuration: ["cluster", "instanceGroup"],
  npm: [],
  maven: [],
  python: [],
  go: [],
  infrastructure: []
};

/** The infra kinds `type` may legally be placed at, per `ARTIFACT_INFRA_COMPATIBILITY`. Total over
 *  `ExecutorType` — never throws, never falls back to a default; an unplaceable type (`npm`,
 *  `infrastructure`, …) returns an empty array rather than `undefined`. */
export function compatibleInfraKinds(type: ExecutorType): readonly InfraKind[] {
  return ARTIFACT_INFRA_COMPATIBILITY[type];
}

/** Whether `type` may be placed at an infra product of `kind` — the plan-time hard-check D24
 *  requires ("an L1/hand-written manifest cannot bypass what the types prevent"). */
export function isPlacementCompatible(type: ExecutorType, kind: InfraKind): boolean {
  return ARTIFACT_INFRA_COMPATIBILITY[type].includes(kind);
}

// ---------------------------------------------------------------------------------------------
// Workflow identity (D11, D15b, D23)
// ---------------------------------------------------------------------------------------------

/**
 * WHAT A TEST HOOK POINTS AT — and why it is never a bare template name.
 *
 * A `WorkflowTemplate` name is a pointer into whatever the cluster happens to hold right now. Two
 * domains can hold different objects under one name, and the same domain holds a different object
 * next week; a gate that resolves a name at execution time is therefore gating on "whatever is
 * installed today", which is unreproducible and, across a security boundary, unverifiable.
 *
 * The declared identity is (repo, branch, path) — the pipeline's OWN repo and branch (D17: a
 * `Workflow` scopes to its pipeline, which carries repo + branch, so those are inherited rather
 * than re-typed), and a path within it. `templateName` selects WHICH template inside a multi-
 * template file and is optional only because single-template files are the common case.
 *
 * This is the DECLARED form. What actually runs is `CapturedWorkflowRefSchema` below.
 */
export const WorkflowRefSchema = z.object({
  /** The pipeline's repo, in the same spelling the pipeline's source mapping uses (D18: always
   *  explicit, never inferred from "the repo the manifest shipped in"). */
  repo: z.string().min(1),
  branch: z.string().min(1),
  /** Path to the WorkflowTemplate / CronWorkflow definition WITHIN `repo`. */
  path: z.string().min(1),
  /** Which template inside `path`, when the file declares more than one. */
  templateName: z.string().min(1).optional()
});
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;

/** `sha256:<lowercase-hex>`. Deliberately the same canonical form `normalizeSbomDigest` produces,
 *  so a test-bundle digest and an artifact digest compare byte-for-byte against each other and
 *  against scan evidence. */
export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "digest must be canonical sha256:<64-lowercase-hex>");

/**
 * The test bundle (D23, §14 resolution 9) — an OCI artifact beside the image.
 *
 * WHY TESTS CROSS AS ARTIFACTS AND NOT AS REFERENCES: a govcloud or air-gapped domain provably
 * cannot reach back to the commercial source repo, so a `path:` alone cannot be what runs there.
 * The workflows a pipeline's tests name are captured AT THE BUILT COMMIT into this bundle, which is
 * origin-signed, enumerated in the promotion manifest, signature-verified per hop, and distributed
 * lazily on the image's OWN admitted crossing. It is NOT scanned — scan stays image-only per M13.
 *
 * The consequence worth stating: EVERY domain, commercial included, runs the local digest-pinned
 * copy. One behaviour, not two. A design where commercial resolved from git and the air gap
 * resolved from a bundle would be two mechanisms wearing one contract's name.
 */
export const TestBundleRefSchema = z.object({
  /** OCI repository path within the domain's own registry (ADR-0012). The DOMAIN-LOCAL copy is
   *  what runs; replication is the byte channel's job, not this reference's. */
  repository: z.string().min(1),
  digest: Sha256DigestSchema
});
export type TestBundleRef = z.infer<typeof TestBundleRefSchema>;

/**
 * What a hook's run is ACTUALLY pinned to, once the build has captured it.
 *
 * `commitSha` is the BUILT commit — not "main at trigger time". This is what makes "which tests
 * gate this wave" a reproducible statement about a specific artifact rather than a statement about
 * whatever the branch happened to hold, and it is what lets the same question be answered
 * identically in a domain that has never seen the repo.
 */
export const CapturedWorkflowRefSchema = WorkflowRefSchema.extend({
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/, "commitSha must be a 40-character lowercase hex git SHA"),
  bundle: TestBundleRefSchema
});
export type CapturedWorkflowRef = z.infer<typeof CapturedWorkflowRefSchema>;

// ---------------------------------------------------------------------------------------------
// Hook kinds and manifest entries (D11, D21)
// ---------------------------------------------------------------------------------------------

export const PipelineHookKindSchema = z.enum([
  "postMerge",
  "postDeploy",
  "continuous",
  "bakeAlarms"
]);
export type PipelineHookKind = z.infer<typeof PipelineHookKindSchema>;

/**
 * Every hook carries these. `hookId` is D16(6)'s stated CDK deviation made concrete: a construct
 * that is a natural singleton per scope defaults its id to the construct kind, and an author only
 * types one when declaring same-kind siblings (two continuous probes on one component). The
 * manifest is explicit either way — D8's rule is inference at synth, explicitness at apply, so the
 * construct DEFAULTS it and the wire always CARRIES it.
 *
 * IDENTITY is `(componentUrn, kind, hookId)`. Like `ManifestSourceMappingSchema`, there is no
 * update path keyed on a subset: a changed hook is a delete + create, and declaring the same tuple
 * twice in one manifest is rejected.
 */
const HookBaseFields = {
  componentUrn: UrnSchema,
  hookId: z.string().min(1).max(200),
  /** Where the workflow lives. Absent only on `bakeAlarms`, which triggers nothing. */
  workflow: WorkflowRefSchema
};

/**
 * POST-MERGE — gates entry to WAVE 1.
 *
 * ============================================================================================
 * WHAT THIS DOES NOT GATE, AND WHY (owner ruling 2026-08-26)
 * ============================================================================================
 * An earlier framing had this gating "entry to the registry step". A coordinator cannot do that,
 * and the reason is structural rather than a matter of effort. D22 pins the build step's order as
 * build -> unit -> scan -> origin signature -> push to the registry, ALL INSIDE the team's own
 * build workflow. SCP first learns the artifact exists when the build REPORTS a digest — by which
 * time it is already pushed. There is no moment at which SCP stands between the build and the
 * registry without being in the build's critical path, and standing there would be executing, not
 * coordinating (charter principle 1).
 *
 * So this hook gates the first thing SCP genuinely controls: the change entering its first wave.
 * The build-internal unit gate is not lost — it is DISPLAYED. D21(d) already requires
 * `scp iac render` to show every gate that will apply "including estate-imposed ones the team never
 * declared", and the build's own unit gate is exactly such a gate. The picture stays the truth; it
 * is the enforcement point that is named honestly.
 */
export const ManifestPostMergeHookSchema = z.object({
  kind: z.literal("postMerge"),
  ...HookBaseFields
});

/**
 * POST-DEPLOY — gates promotion OUT of a wave, which is the same edge as entry INTO the next one.
 *
 * `stage` ABSENT IS THE DEFAULT FORM AND GATES EVERY WAVE (D21(a)). A `stage` NARROWS it to waves
 * at that stage. Read that direction carefully, because the intuitive reading is backwards: adding
 * a `stage` REMOVES gates, it does not add one. The default is the strict end of the range on
 * purpose — a team that declares an integration suite and forgets to say where it applies gets it
 * applied everywhere, which is the safe direction to be wrong in.
 */
export const ManifestPostDeployHookSchema = z.object({
  kind: z.literal("postDeploy"),
  ...HookBaseFields,
  /** Stage name (operator data, D6 — SCP never enforces the vocabulary). ABSENT = every wave. */
  stage: z.string().min(1).optional()
});

/**
 * CONTINUOUS — a canary probe on a cron, whose LATEST result is a per-target hold.
 *
 * ============================================================================================
 * `maxAgeSeconds` IS REQUIRED, AND STALE-GREEN READS AS ABSENT — NOT AS PASS, NOT AS FAIL
 * ============================================================================================
 * This is the whole reason the hook exists, so it is not an optional refinement. Evidence from a
 * probe that last succeeded six hours ago is not evidence that the target is healthy now; it is
 * evidence that nobody has looked. Collapsing "stale" into "pass" makes a dead prober indis-
 * tinguishable from a healthy fleet — and a dead prober is the more likely of the two.
 *
 * It does not read as `fail` either, and that distinction is load-bearing for the operator: `fail`
 * means the probe ran and the target is sick; ABSENT means the probe did not report in time. Those
 * demand different actions and must not share a word. Both hold the target; only one of them means
 * the target is broken.
 *
 * `everySeconds` is the CronWorkflow's schedule and is descriptive here — Argo runs the cron, SCP
 * does not. It is carried so `scp iac render` can show the declared cadence beside the freshness
 * window, since a `maxAge` shorter than the cadence is a permanently-held target and is worth
 * seeing in one place.
 */
export const ManifestContinuousHookSchema = z.object({
  kind: z.literal("continuous"),
  ...HookBaseFields,
  /** The cron cadence Argo Workflows runs this probe on. Descriptive: SCP does not schedule it. */
  everySeconds: z.number().int().positive(),
  /** REQUIRED. Evidence older than this is ABSENT, not stale-pass and not fail (see above). */
  maxAgeSeconds: z.number().int().positive()
});

/**
 * BAKE ALARMS — a declared quiet window that must pass alarm-free after a target deploys (D21(b)).
 *
 * Evidence is PER TARGET (each target's window starts when THAT target deployed); the GATE is at
 * the next wave's entry and requires all of them (owner ruling 2026-08-26). Triggers nothing, so it
 * carries no `workflow` — it consumes signals that already exist: the rollout executor's own
 * analysis/health (ADR-0008 observed state, which SCP already reads) and externally PUSHED alarm
 * state (§14 resolution 8). There is no pull integration and no new egress class; see
 * `AlarmStateEvidenceSchema` for why a quiet window has to be ASSERTED rather than inferred from
 * the absence of a report.
 */
export const ManifestBakeAlarmsHookSchema = z.object({
  kind: z.literal("bakeAlarms"),
  componentUrn: UrnSchema,
  hookId: z.string().min(1).max(200),
  /** How long the target must stay alarm-free after its deploy before the wave may exit. */
  quietWindowSeconds: z.number().int().positive(),
  /** ABSENT = every wave, exactly as on `postDeploy`. */
  stage: z.string().min(1).optional()
});

export const ManifestPipelineHookSchema = z.discriminatedUnion("kind", [
  ManifestPostMergeHookSchema,
  ManifestPostDeployHookSchema,
  ManifestContinuousHookSchema,
  ManifestBakeAlarmsHookSchema
]);
export type ManifestPipelineHook = z.infer<typeof ManifestPipelineHookSchema>;

// ---------------------------------------------------------------------------------------------
// Rollout (D12, D15c)
// ---------------------------------------------------------------------------------------------

/**
 * D12's authority split, DECLARED BY THE PLUGIN and read from the binding — never assumed per
 * executor kind. The mirror of this union lives on `ExecutorCapabilities` in `@scp/plugin-api`
 * (which is deliberately free of a `@scp/schemas` dependency) and is pinned to this enum by a
 * total-`Record` test, the same way `DependencyIndexEcosystem` is.
 *
 *   authoritative — SCP's declaration IS the rollout (the `scp-runner-*` managed classes).
 *   triggerParams — passed to the executor's own automation as parameters, where it accepts them.
 *   verified      — the executor owns the rollout; SCP compares DECLARED against OBSERVED
 *                   (ADR-0008 already observes Rollouts weights) and divergence is LOUD. Never
 *                   silently reconciled: SCP does not orchestrate traffic.
 */
export const RolloutAuthoritySchema = z.enum(["authoritative", "triggerParams", "verified"]);
export type RolloutAuthority = z.infer<typeof RolloutAuthoritySchema>;

/** D15(c): the strategy IS the class, so the wire carries a discriminant, never a strategy string
 *  the server has to interpret. D16(3): percentages are plain numbers on self-describing props
 *  (CDK's `minHealthyPercent` pattern) and durations are seconds — never `"25%"`, never `"5m"`. */
export const RolloutStrategySchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("canary"),
    steps: z
      .array(
        z.object({
          weightPercent: z.number().int().min(0).max(100),
          pauseSeconds: z.number().int().nonnegative().optional()
        })
      )
      .min(1)
  }),
  z.object({
    strategy: z.literal("rolling"),
    batchPercent: z.number().int().min(1).max(100),
    pauseBetweenSeconds: z.number().int().nonnegative().optional()
  })
]);
export type RolloutStrategy = z.infer<typeof RolloutStrategySchema>;

/** Identity is `(componentUrn, targetClass)` — D12 keys the declaration by the CLASS of target, so
 *  one component legitimately declares a canary for its clusters and a rolling batch for its
 *  instance groups. */
export const ManifestRolloutSchema = z.object({
  componentUrn: UrnSchema,
  targetClass: RolloutTargetClassSchema,
  rollout: RolloutStrategySchema
});
export type ManifestRollout = z.infer<typeof ManifestRolloutSchema>;

// ---------------------------------------------------------------------------------------------
// Convergence (D25)
// ---------------------------------------------------------------------------------------------

/**
 * D25(b) — when a configuration pipeline places at an infrastructure PRODUCT, a change in that
 * product's observed membership (ASG churn, scale-out, replacement) re-applies the CURRENTLY
 * RELEASED, ALREADY-GATED state to the affected target. Not a new release; no wave re-entry.
 *
 * `converge` is written EXPLICITLY by synth even though it defaults on (D8: inference at synth,
 * explicitness at apply) — so "this fleet self-converges" is a reviewable line in the manifest
 * rather than a server-side default nobody can see. `converge: false` opts out.
 *
 * `scope` defaults to the changed subset (Ansible idempotence makes that sufficient); a full
 * converge is the drift tool, not the routine path.
 */
export const ManifestConvergenceSchema = z.object({
  componentUrn: UrnSchema,
  /** The infrastructure product whose membership drives convergence. */
  targetUrn: UrnSchema,
  converge: z.boolean(),
  /** REQUIRED, and not defaulted on the wire. `z.default()` would emit a JSON Schema that is
   *  simultaneously `required` and carries a default, which is the worst of both readings for a
   *  hand-authored (L1) manifest. D8's rule already settles it: inference at synth, explicitness at
   *  apply — the construct picks `changedSubset`, the manifest always says which. */
  scope: z.enum(["changedSubset", "fullGroup"])
});
export type ManifestConvergence = z.infer<typeof ManifestConvergenceSchema>;

// ---------------------------------------------------------------------------------------------
// Wave-document gates (§14 resolution 5) — vocabulary and entry shape only.
// ---------------------------------------------------------------------------------------------

/**
 * The gate kinds a wave document's native `gates` field may name.
 *
 * OWNERSHIP: this vocabulary and the entry shape are defined here so that the `topology-waves`
 * parser consumes ONE enum rather than minting a second spelling of the same concept; the PARSER
 * change itself belongs to the core IaC increment. `continuous` is deliberately absent — it is a
 * per-target hold, not a wave gate, and a wave document must not be able to ask for it.
 *
 * A NOTE ON THE COMPATIBILITY POSTURE, because the recorded one does not match the code. §14
 * resolution 5 says an older outpost "rejects the entry and federation wedges until upgraded", on
 * migration 0043's precedent. Measured, that is not what happens: `release-topology`'s registered
 * property schema (migration 0007) has NO `additionalProperties: false` on the wave object, so Ajv
 * on the receiving side ACCEPTS an unknown `gates` key and the document federates normally. The
 * refusal happens later and more narrowly — an older outpost's `parseTopologyWaves` rejects the
 * unknown key at PLAN-COMPILE time, failing that one change loudly instead of wedging the peer's
 * whole sync. That is 0043's actual rule ("strict at the operator's door, open on the wire") and it
 * is the better outcome; it is recorded here so nobody later "fixes" the wire to match the prose.
 */
export const WaveGateKindSchema = z.enum(["postDeployTest", "bakeAlarms"]);
export type WaveGateKind = z.infer<typeof WaveGateKindSchema>;

export const WaveGateSchema = z.object({
  kind: WaveGateKindSchema,
  /** Narrows to one declared hook by its `hookId`; absent = every hook of this kind that applies to
   *  the wave (which, per `stage` being absent on the hook, is the default form). */
  hookId: z.string().min(1).max(200).optional()
});
export type WaveGate = z.infer<typeof WaveGateSchema>;

// ---------------------------------------------------------------------------------------------
// Evidence (D21(b), D23, §14 resolution 8)
// ---------------------------------------------------------------------------------------------

/**
 * WHAT A PIECE OF EVIDENCE IS ABOUT — and why it must be bound to bytes or to a commit.
 *
 * Unbound evidence is not evidence. "The integration suite passed" is a claim about a specific
 * artifact at a specific place; without the binding it is a claim about the word "passed", and it
 * will be read as covering whatever is deployed next. This repo has paid for that lesson once in
 * the scan layer, where `evaluateScanCoverage` refuses evidence whose `digestMatch !== true` with
 * an explicit `not_digest_bound` code rather than letting a shape-valid verdict cover a digest it
 * never examined.
 *
 * EXACTLY ONE binding kind is required, and which one is determined by the hook: `postMerge` runs
 * before any artifact exists, so it binds to the built COMMIT; `postDeploy`, `continuous` and
 * `bakeAlarms` all describe something already deployed, so they bind to the artifact DIGEST. Both
 * are permitted on the wire and the consumer requires the one its hook needs — a mismatch is a
 * refusal, never a widening.
 */
export const PipelineEvidenceSubjectSchema = z
  .object({
    componentUrn: UrnSchema,
    /** The deployment-target this evidence describes. Required even for `postMerge`, whose run is
     *  not target-specific, because the AUTHORIZATION is scoped at the target (see the submit
     *  request below) and an evidence row nobody can attribute is an evidence row nobody can
     *  revoke. */
    targetUrn: UrnSchema,
    artifactDigest: Sha256DigestSchema.optional(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/, "commitSha must be a 40-character lowercase hex git SHA")
      .optional()
  })
  .refine((s) => s.artifactDigest !== undefined || s.commitSha !== undefined, {
    message:
      "evidence must be bound to an artifact digest or a built commit — unbound evidence would be read as covering whatever deploys next"
  });
export type PipelineEvidenceSubject = z.infer<typeof PipelineEvidenceSubjectSchema>;

/**
 * A concluded test run. NOTE THE OUTCOME VOCABULARY: there is no `running`/`pending` member, on
 * purpose. Evidence is a record of something that FINISHED; an in-flight run is expressed by the
 * ABSENCE of evidence (which the freshness rule below already handles correctly) plus the control's
 * `expired` status, which is the mechanism the tree already uses and re-polls. A `running` member
 * here would be a second, competing representation of the same fact.
 */
export const TestRunEvidenceSchema = z.object({
  kind: z.literal("testRun"),
  hook: PipelineHookKindSchema,
  hookId: z.string().min(1).max(200),
  /** Pinned to the built commit and the digest-pinned bundle that actually ran (D23). */
  workflow: CapturedWorkflowRefSchema,
  /** The executor-side run identity (an Argo Workflows run name), for the operator's back-link. */
  runId: z.string().min(1).max(500),
  outcome: z.enum(["passed", "failed"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
});
export type TestRunEvidence = z.infer<typeof TestRunEvidenceSchema>;

/**
 * ALARM STATE OVER A NAMED WINDOW — a POSITIVE assertion of quiet, never an inference from silence.
 *
 * ============================================================================================
 * THIS IS THE WHOLE DESIGN OF THE BAKE HOOK, SO IT IS WORTH BEING BLUNT
 * ============================================================================================
 * "No alarm report arrived" and "the window was observed and nothing fired" are not the same fact,
 * and a bake gate that treats them as one passes every time the alarm pipeline is broken — which is
 * precisely when it should not. So a report must NAME the window it covers (`windowStart` ..
 * `windowEnd`) and list what fired in it; an EMPTY `alarms` array is then a real claim, and no
 * report at all leaves the gate closed.
 *
 * Same shape of reasoning as `continuous`'s stale-reads-as-absent rule, and the same failure mode
 * on the other side of it: the state that means "I am not looking" must never be spelled the same
 * way as the state that means "I looked and it was fine".
 */
export const AlarmStateEvidenceSchema = z.object({
  kind: z.literal("alarmState"),
  hookId: z.string().min(1).max(200),
  /** The window this report actually covers. A gate satisfies its `quietWindowSeconds` only from
   *  reports whose covered window spans it — a shorter window is a shorter look, not a pass. */
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  /** EMPTY = an affirmative "nothing fired in that window". Absent evidence is not this. */
  alarms: z.array(
    z.object({
      name: z.string().min(1).max(500),
      severity: z.enum(["warning", "critical"]),
      firedAt: z.string().datetime()
    })
  )
});
export type AlarmStateEvidence = z.infer<typeof AlarmStateEvidenceSchema>;

export const PipelineEvidenceSchema = z.discriminatedUnion("kind", [
  TestRunEvidenceSchema,
  AlarmStateEvidenceSchema
]);
export type PipelineEvidence = z.infer<typeof PipelineEvidenceSchema>;

/**
 * The push door's request body (owner ruling 2026-08-26: a dedicated typed evidence route, NOT an
 * evidence mode bolted onto `POST /change-sources/{kind}/report`).
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY *NOT* IN THIS SHAPE: THE PRODUCER
 * ============================================================================================
 * There is no `producer` / `source` / `reportedBy` field, and one must never be added. The
 * governing rule is already written down in `federation/scan-evidence.ts`, which exists because a
 * shape-valid payload is forgeable by anyone who can read the schema: PROVENANCE — which
 * authenticated principal and which plugin module produced the row — IS THE AUTHORIZATION
 * BOUNDARY, NOT THE PAYLOAD SHAPE. A caller-supplied producer field is a self-attested claim about
 * exactly the thing being checked, so the server stamps it from the authenticated subject at
 * insert, the same way `control_runs.plugin_module` is stamped and deliberately not re-derived
 * later.
 *
 * The second half of the same rule: this route authorizes at the SUBJECT'S TARGET, not at the org
 * root. Pushed alarm state unlocks a production bake gate, so "who may say the window was quiet"
 * has to be as narrow as "who may deploy there" — an org-root-scoped write permission on a gate
 * unlock is a privilege escalation wearing a reporting API's clothes.
 */
export const SubmitPipelineEvidenceRequestSchema = z.strictObject({
  subject: PipelineEvidenceSubjectSchema,
  evidence: PipelineEvidenceSchema
});
export type SubmitPipelineEvidenceRequest = z.infer<typeof SubmitPipelineEvidenceRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Freshness — the Decision `inputContext` shape (§14 build verification 2)
// ---------------------------------------------------------------------------------------------

/**
 * WHAT A HOOK'S DECISION RECORDS, AND WHY `now` IS NOT IN IT.
 *
 * ============================================================================================
 * THE TWO RULES THIS SATISFIES AT ONCE — THEY LOOK OPPOSED AND ARE NOT
 * ============================================================================================
 * Rule 1 (ADR-0033 §6a, and the campaign-deadline note): expiry is a READ-TIME comparison, never a
 * status column a job flips. Nothing in this tree sweeps rows to mark them stale, so staleness must
 * be decided fresh, every tick, against the clock.
 *
 * Rule 2 (ADR-0024, and the measured 1.44 GB/day incident): a Decision persists ON CHANGE, so its
 * `inputContext` must be BYTE-IDENTICAL across ticks while the underlying facts are unchanged.
 * Put `now` in it and every tick writes a new row forever.
 *
 * Both hold simultaneously because they govern different things. The COMPARISON uses the clock and
 * is redone every tick (rule 1). The RECORD carries only the data the comparison consumed — the
 * evidence's own `completedAt`, the declared `maxAgeSeconds`, and their sum as `staleAfter` —
 * so it is stable for as long as that evidence is the latest, and changes exactly when the evidence
 * does (rule 2). `gate-orchestrator.ts` already does precisely this for freezes: `endsAt` is read
 * straight off the row into `inputContext`, with the comment "NOTHING HERE IS DERIVED FROM A
 * CLOCK ... so a re-evaluated block is byte-identical on every tick". This is that pattern, named.
 *
 * `staleAfter` is therefore a DERIVED CONSTANT, not a deadline anybody enforces — the enforcement
 * is the read-time comparison. It is recorded so that an operator reading the Decision six weeks
 * later can see the boundary the engine actually applied, instead of re-deriving it from a
 * `maxAge` that may since have been edited.
 */
export const HookFreshnessContextSchema = z.object({
  hook: PipelineHookKindSchema,
  hookId: z.string().min(1).max(200),
  maxAgeSeconds: z.number().int().positive(),
  /** `null` = no evidence has ever arrived for this (hook, target, binding). Distinct from evidence
   *  that arrived and failed, and distinct from evidence that arrived and went stale. */
  latestEvidence: z
    .object({
      evidenceId: z.string().uuid(),
      outcome: z.enum(["passed", "failed"]),
      completedAt: z.string().datetime(),
      artifactDigest: Sha256DigestSchema.nullable(),
      commitSha: z.string().nullable()
    })
    .nullable(),
  /** `completedAt + maxAgeSeconds`, as data. `null` when there is no evidence to age. NEVER `now`,
   *  and never a value the engine re-derives from the clock at write time — see the doc above. */
  staleAfter: z.string().datetime().nullable()
});
export type HookFreshnessContext = z.infer<typeof HookFreshnessContextSchema>;

/**
 * The per-target hold entry a `continuous` hook produces (ADR-0028 shape).
 *
 * COMPOSED AT READ TIME, NEVER PERSISTED — the same rule the freeze-hold projection on
 * `ChangeWaveTargetSchema` follows and for the same reason: a hold fed from a Decision row would
 * still say "held" long after fresh evidence arrived, because the holding Decision has no clearing
 * counterpart. Present only while the target is genuinely held; absent on the next read once a
 * fresh green lands.
 *
 * `reason` distinguishes the three states that all hold but mean different things, because an
 * operator's next action differs for each: `no_evidence` (the probe has never reported — check the
 * prober), `stale` (it reported and then stopped — check the prober), `failed` (it reported and the
 * target is sick — check the target). `summary` is a SERVER-COMPOSED sentence, per charter
 * principle 6 and the established idiom that the UI composes no copy from raw fields.
 */
export const ContinuousTestHoldSchema = z.object({
  hookId: z.string().min(1).max(200),
  reason: z.enum(["no_evidence", "stale", "failed"]),
  summary: z.string(),
  /** The boundary the engine applied, carried for the same reason `endsAt` is carried on a freeze
   *  hold: the client's own clock contextualizes it, and `now` never crosses this seam. */
  staleAfter: z.string().datetime().nullable(),
  lastReportedAt: z.string().datetime().nullable()
});
export type ContinuousTestHold = z.infer<typeof ContinuousTestHoldSchema>;

// ---------------------------------------------------------------------------------------------
// Artifact-class verification (D13)
// ---------------------------------------------------------------------------------------------

/**
 * D13 — a pipeline DECLARES its artifact class, and the declaration is then VERIFIED against what
 * the build and the registry actually produced. A mismatch is loud, Decision-backed, and never
 * silently re-inferred.
 *
 * WHY VERIFY AT ALL, GIVEN THE ENUM IS CLOSED AND TYPE-CHECKED: the closed enum stops a typo, not
 * a lie. The declared class selects the journey template — an image builds/pushes/bumps/syncs, an
 * RPM builds/publishes/batch-installs — so a component that declares `image` and actually produces
 * an RPM gets an entire journey shaped for bytes it does not have, and every step "succeeds"
 * against nothing. That failure is silent precisely because each individual step is fine.
 *
 * `observed` is `null` when the evidence carried nothing to check — which is NOT a match. The
 * verdict for "no evidence yet" is `unverified`, and it is spelled differently from `match` so that
 * a journey running on an unverified declaration is a visible state rather than an assumed pass.
 */
export const ArtifactClassVerificationSchema = z.object({
  declared: ArtifactClassSchema,
  /** What build/registry evidence says was actually produced. `null` = nothing to check yet. */
  observed: ArtifactClassSchema.nullable(),
  /** Which evidence answered. `null` alongside a `null` `observed`. */
  evidenceSource: z.enum(["buildReport", "registryObservation"]).nullable(),
  verdict: z.enum(["match", "mismatch", "unverified"])
});
export type ArtifactClassVerification = z.infer<typeof ArtifactClassVerificationSchema>;

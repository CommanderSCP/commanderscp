/**
 * TYPED PIPELINE BEHAVIOURS (L2) — `Workflow`, the four test hooks, and the two rollout strategy
 * classes, as thin sugar over the increment-8 contract in `@scp/schemas`.
 *
 * ================================================================================================
 * THE GRAMMAR THESE FOLLOW, AND WHERE IT COMES FROM
 * ================================================================================================
 * D15(b) as amended by D17: **a `Workflow` scopes to its pipeline, which carries repo + branch;
 * `path:` is within that repo; a test hook scopes to the `Workflow`.** That scope chain IS how a
 * test knows where the code and the template live — so the repo is not repeated on every hook, and
 * it cannot drift from the pipeline's own source mapping, because it is read from the same place.
 *
 * D8's rule then applies at the boundary: **inference at synth, explicitness at apply.** The
 * construct infers `repo` and `branch` from the scope chain; the MANIFEST always carries them
 * literally. Nothing server-side ever infers.
 *
 * D16(3): durations are the `Duration` value class on every duration-shaped prop (`every`,
 * `maxAge`, `quietWindow`, `pauseBetween`), percentages are plain numbers on self-describing props
 * (`weightPercent`, `batchPercent`). Never `"5m"`, never `"25%"`.
 *
 * D16(6): every construct exports its props interface, optionals carry `@default`, and the types
 * those props use are the contract's own — one vocabulary from authoring to wire, so a prop cannot
 * drift from what plan/apply accepts. Where a construct is a natural singleton per scope, `id`
 * defaults to the construct kind and is typed only when declaring same-kind siblings.
 *
 * ================================================================================================
 * WHY THESE EMIT THROUGH THE L1 DOORS
 * ================================================================================================
 * Every construct here ends in `stack.addPipelineHook(...)` / `addRollout(...)` — the same L1
 * hatches a hand-authoring caller uses. D16(1)'s "an L1-authored entry and its L2 equivalent
 * synthesize identically" is then true by construction rather than by two code paths agreeing,
 * which is the same reason `addManifestEntry` entries sort in beside typed constructs' objects.
 */

import type {
  ManifestPipelineHook,
  RolloutStrategy,
  RolloutTargetClass,
  WorkflowRef
} from "@scp/schemas";
import { Construct, type Stack } from "./construct.js";
import type { Duration } from "./duration.js";

/**
 * The scope chain a behaviour needs: which stack to declare into, and which component the
 * declaration is ABOUT.
 *
 * A pipeline scoped to a SERVICE (D8's shared-rung exception) has no component — `PipelineBase`
 * says so at length for source mappings and placements, and hooks are in the same position: the
 * contract keys every hook on `componentUrn`, and which components inherit a service-rung pipeline
 * is decided at READ time, not at this program's synth time. So such a pipeline reports
 * `componentUrn: undefined` and the constructs below refuse, naming the reason.
 */
export interface BehaviorHost {
  readonly stack: Stack;
  /** The pipeline's repo (D18 — always explicit on the pipeline itself). */
  readonly repo: string;
  /** The pipeline's branch, if it declared one. */
  readonly branch?: string;
  /** The component this pipeline is attached to, or `undefined` at the shared rung. */
  readonly componentUrn?: string;
}

function hostOf(scope: Construct): BehaviorHost {
  let node: Construct | undefined = scope;
  while (node) {
    const candidate = node as Construct & Partial<BehaviorHost>;
    if (candidate.stack && typeof candidate.repo === "string") {
      return {
        stack: candidate.stack,
        repo: candidate.repo,
        ...(candidate.branch !== undefined ? { branch: candidate.branch } : {}),
        ...(candidate.componentUrn !== undefined ? { componentUrn: candidate.componentUrn } : {})
      };
    }
    node = node.scope;
  }
  throw new Error(
    `construct "${scope.path}" is not inside a pipeline — a Workflow scopes to the pipeline whose ` +
      `repo and branch it inherits (D15(b) as amended by D17). Declare it under a pipeline, or use ` +
      `the L1 door (stack.addPipelineHook) for a component referenced from outside this program.`
  );
}

function requireComponent(host: BehaviorHost, what: string, path: string): string {
  if (host.componentUrn === undefined) {
    throw new Error(
      `${what} "${path}" is declared under a pipeline scoped to a SERVICE (D8's shared-rung ` +
        `exception), which names no component — and every hook keys on one. Which components ` +
        `inherit a service-rung pipeline is resolved at read time, not at synth. Declare the hook ` +
        `on the component's own pipeline instead.`
    );
  }
  return host.componentUrn;
}

export interface WorkflowProps {
  /** Path to the WorkflowTemplate / CronWorkflow definition WITHIN the pipeline's repo. */
  readonly path: string;
  /**
   * Which template inside `path`, when the file declares more than one.
   * @default undefined — the file declares exactly one template
   */
  readonly templateName?: string;
  /**
   * Override the repo the workflow lives in.
   * @default the pipeline's own repo (D17: the Workflow scopes to its pipeline)
   */
  readonly repo?: string;
  /**
   * Override the branch the workflow is read at.
   * @default the pipeline's branch, or `"main"` when the pipeline declares none
   */
  readonly branch?: string;
}

/**
 * WHERE A TEST'S CODE AND TEMPLATE LIVE. Scopes to a pipeline and inherits its repo and branch;
 * the test hooks scope to this.
 *
 * It declares nothing on its own — a workflow nobody gates on is not a manifest entry, it is an
 * unused file — so this construct emits no manifest entry by itself. The hooks under it do.
 */
export class Workflow extends Construct {
  readonly ref: WorkflowRef;
  /** Re-exposed so a hook scoped to this workflow finds the host by walking `scope` upward. */
  readonly stack: Stack;
  readonly repo: string;
  readonly branch: string;
  readonly componentUrn: string | undefined;

  constructor(scope: Construct, id: string, props: WorkflowProps) {
    super(scope, id);
    const host = hostOf(scope);
    this.stack = host.stack;
    this.repo = props.repo ?? host.repo;
    // `"main"` is the default of last resort and is written EXPLICITLY into the manifest, per D8 —
    // the wire never carries "whatever the default was at synth time".
    this.branch = props.branch ?? host.branch ?? "main";
    this.componentUrn = host.componentUrn;
    this.ref = {
      repo: this.repo,
      branch: this.branch,
      path: props.path,
      ...(props.templateName !== undefined ? { templateName: props.templateName } : {})
    };
  }
}

/** Shared plumbing: resolve the workflow a hook is scoped to, and the component it is about. */
function workflowOf(scope: Construct, what: string, path: string): Workflow {
  let node: Construct | undefined = scope;
  while (node) {
    if (node instanceof Workflow) return node;
    node = node.scope;
  }
  throw new Error(
    `${what} "${path}" is not inside a Workflow — a test hook scopes to the Workflow that says ` +
      `where its template lives (D15(b)). Declare it under one.`
  );
}

/**
 * POST-MERGE — gates entry to WAVE 1, and fires on merge to the pipeline's branch.
 *
 * It does NOT gate the artifact reaching the registry, and the contract says why at length: D22 puts
 * build → unit → scan → sign → push inside the team's own workflow, so SCP first sees the artifact
 * when the build reports a digest. The build-internal gate is DISPLAYED by `scp iac render`, not
 * enforced here.
 */
export class PostMergeTest extends Construct {
  constructor(scope: Workflow, id = "postMerge") {
    super(scope, id);
    const workflow = workflowOf(scope, "PostMergeTest", `${scope.path}/${id}`);
    const componentUrn = requireComponent(
      {
        stack: workflow.stack,
        repo: workflow.repo,
        ...(workflow.componentUrn !== undefined ? { componentUrn: workflow.componentUrn } : {})
      },
      "PostMergeTest",
      this.path
    );
    workflow.stack.addPipelineHook({ urn: componentUrn, typeId: "component" }, {
      kind: "postMerge",
      hookId: id,
      workflow: workflow.ref
    } satisfies Omit<Extract<ManifestPipelineHook, { kind: "postMerge" }>, "componentUrn">);
  }
}

export interface PostDeployTestProps {
  /**
   * Narrow this gate to waves at one stage.
   * @default undefined — gates EVERY wave, which is the strict end of the range (D21(a)): adding a
   * `stage` REMOVES gates, it does not add one.
   */
  readonly stage?: string;
}

/** POST-DEPLOY — gates promotion OUT of a wave, which is the same edge as entry into the next. */
export class PostDeployTest extends Construct {
  constructor(scope: Workflow, id = "postDeploy", props: PostDeployTestProps = {}) {
    super(scope, id);
    const workflow = workflowOf(scope, "PostDeployTest", `${scope.path}/${id}`);
    const componentUrn = requireComponent(
      {
        stack: workflow.stack,
        repo: workflow.repo,
        ...(workflow.componentUrn !== undefined ? { componentUrn: workflow.componentUrn } : {})
      },
      "PostDeployTest",
      this.path
    );
    workflow.stack.addPipelineHook(
      { urn: componentUrn, typeId: "component" },
      {
        kind: "postDeploy",
        hookId: id,
        workflow: workflow.ref,
        ...(props.stage !== undefined ? { stage: props.stage } : {})
      }
    );
  }
}

export interface ContinuousTestProps {
  /** The cron cadence Argo Workflows runs this probe on. Descriptive: SCP does not schedule it. */
  readonly every: Duration;
  /**
   * Evidence older than this reads as ABSENT — not stale-pass, and not fail. Required, because it
   * is the entire reason the hook exists: a probe that last succeeded six hours ago is evidence
   * that nobody has looked, not that the target is healthy.
   */
  readonly maxAge: Duration;
}

/** CONTINUOUS — a canary probe on a cron whose LATEST result is a per-target hold. */
export class ContinuousTest extends Construct {
  constructor(scope: Workflow, id = "continuous", props: ContinuousTestProps) {
    super(scope, id);
    const workflow = workflowOf(scope, "ContinuousTest", `${scope.path}/${id}`);
    const componentUrn = requireComponent(
      {
        stack: workflow.stack,
        repo: workflow.repo,
        ...(workflow.componentUrn !== undefined ? { componentUrn: workflow.componentUrn } : {})
      },
      "ContinuousTest",
      this.path
    );
    // `Duration` resolved to plain seconds HERE, before it can reach a manifest entry — the hazard
    // `duration.ts`'s header records (a raw `Duration` inside `properties` would not canonicalize
    // through its own `toJSON`).
    workflow.stack.addPipelineHook(
      { urn: componentUrn, typeId: "component" },
      {
        kind: "continuous",
        hookId: id,
        workflow: workflow.ref,
        everySeconds: props.every.toSeconds(),
        maxAgeSeconds: props.maxAge.toSeconds()
      }
    );
  }
}

export interface BakeAlarmsProps {
  /** How long the target must stay alarm-free after its deploy before the wave may exit. */
  readonly quietWindow: Duration;
  /**
   * Narrow to waves at one stage.
   * @default undefined — every wave, exactly as on `PostDeployTest`
   */
  readonly stage?: string;
}

/**
 * BAKE ALARMS — a declared quiet window that must pass alarm-free after a target deploys.
 *
 * Scopes to the PIPELINE, not to a `Workflow`: it triggers nothing, so it has no template to point
 * at. It consumes signals that already exist (the rollout executor's analysis, plus pushed alarm
 * state), which is why the contract gives it no `workflow` field at all.
 */
export class BakeAlarms extends Construct {
  constructor(scope: Construct, id = "bakeAlarms", props: BakeAlarmsProps) {
    super(scope, id);
    const host = hostOf(scope);
    const componentUrn = requireComponent(host, "BakeAlarms", this.path);
    host.stack.addPipelineHook(
      { urn: componentUrn, typeId: "component" },
      {
        kind: "bakeAlarms",
        hookId: id,
        quietWindowSeconds: props.quietWindow.toSeconds(),
        ...(props.stage !== undefined ? { stage: props.stage } : {})
      }
    );
  }
}

export interface CanaryRolloutProps {
  /** Which CLASS of target this strategy governs (D12) — one component legitimately declares a
   *  canary for its clusters and a rolling batch for its instance groups. */
  readonly targetClass: RolloutTargetClass;
  /** Weight steps, in order. Percentages are plain numbers (D16(3)), pauses are `Duration`. */
  readonly steps: readonly { readonly weightPercent: number; readonly pause?: Duration }[];
}

/** D15(c): THE STRATEGY IS THE CLASS — the wire carries a discriminant, never a strategy string. */
export class CanaryRollout extends Construct {
  constructor(scope: Construct, id = "canaryRollout", props: CanaryRolloutProps) {
    super(scope, id);
    const host = hostOf(scope);
    const componentUrn = requireComponent(host, "CanaryRollout", this.path);
    const rollout: RolloutStrategy = {
      strategy: "canary",
      steps: props.steps.map((step) => ({
        weightPercent: step.weightPercent,
        ...(step.pause !== undefined ? { pauseSeconds: step.pause.toSeconds() } : {})
      }))
    };
    host.stack.addRollout(
      { urn: componentUrn, typeId: "component" },
      { targetClass: props.targetClass, rollout }
    );
  }
}

export interface RollingRolloutProps {
  readonly targetClass: RolloutTargetClass;
  /** CDK's `minHealthyPercent` pattern: a plain number on a self-describing prop. */
  readonly batchPercent: number;
  /** @default undefined — no pause between batches */
  readonly pauseBetween?: Duration;
}

export class RollingRollout extends Construct {
  constructor(scope: Construct, id = "rollingRollout", props: RollingRolloutProps) {
    super(scope, id);
    const host = hostOf(scope);
    const componentUrn = requireComponent(host, "RollingRollout", this.path);
    const rollout: RolloutStrategy = {
      strategy: "rolling",
      batchPercent: props.batchPercent,
      ...(props.pauseBetween !== undefined
        ? { pauseBetweenSeconds: props.pauseBetween.toSeconds() }
        : {})
    };
    host.stack.addRollout(
      { urn: componentUrn, typeId: "component" },
      { targetClass: props.targetClass, rollout }
    );
  }
}

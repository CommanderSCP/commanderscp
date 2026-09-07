/** TYPED PIPELINE BEHAVIOURS. See docs/iac.md §172. */

import type {
  ManifestPipelineHook,
  RolloutStrategy,
  RolloutTargetClass,
  WorkflowRef
} from "@scp/schemas";
import { Construct, type Stack } from "./construct.js";
import type { Duration } from "./duration.js";

/** The scope chain a behaviour needs. See docs/iac.md §173. */
export interface BehaviorHost {
  readonly stack: Stack;
  /** The pipeline's repo (D18 — always explicit on the pipeline itself). */
  readonly repo: string;
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

/** WHERE A TEST'S CODE AND TEMPLATE LIVE. See docs/iac.md §174. */
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

/** Post-merge gates entry to the first wave, on merge. See docs/iac.md §175. */
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
  /** Evidence older than this reads as ABSENT. See docs/iac.md §176. */
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

/** Bake alarms: a quiet window that must pass alarm-free. See docs/iac.md §177. */
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

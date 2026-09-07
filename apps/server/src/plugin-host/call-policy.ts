import { MANAGED_RUN_TIMEOUT_MAX_MS, runnerPostDeadlineMs } from "@scp/runner-launcher";
import type { RunnerLauncherKind } from "@scp/runner-launcher";
import { MANIFEST_BY_MODULE } from "./plugin-manifests.js";

/** PER-METHOD RPC POLICY FOR THE SUBPROCESS PLUGIN HOST. See docs/plugin-host.md §10. */

/** The managed-execution classes. See docs/plugin-host.md §11. */
export const MANAGED_EXECUTOR_MODULES = ["managed-iac", "managed-scan", "managed-dep"] as const;

/** How much longer the host waits than the plugin's budget. See docs/plugin-host.md §12. */
export const MANAGED_OUTCOME_TAIL_MS = 30_000;

/**
 * How much longer the HOST waits than the plugin's own whole-run budget, ON THE ADAPTER IN USE.
 * Both terms above; neither restated.
 */
export function managedTriggerGraceMs(kind: RunnerLauncherKind): number {
  return runnerPostDeadlineMs(kind) + MANAGED_OUTCOME_TAIL_MS;
}

/** The DOCKER grace. See docs/plugin-host.md §13. */
export const MANAGED_TRIGGER_GRACE_MS = managedTriggerGraceMs("docker");

/** WHICH ADAPTER THIS INSTANCE'S `trigger()` WILL ACTUALLY USE. See docs/plugin-host.md §14. */
export function runnerLauncherKindOf(config: unknown): RunnerLauncherKind {
  return (config as { runnerLauncher?: unknown } | undefined)?.runnerLauncher === "kubernetes"
    ? "kubernetes"
    : "docker";
}

/** The one RPC method whose budget is derived rather than fixed. */
const TRIGGER_METHOD = "trigger";

/** The bounded `timeoutMs` shape a managed plugin's manifest must publish. */
interface TimeoutSchema {
  readonly minimum: number;
  readonly maximum: number;
  readonly default: number;
}

/** Reads `configSchema.properties.timeoutMs` off a bundled manifest, or `undefined` if the module
 *  has no manifest or the property is not the bounded-integer shape this file requires. Never
 *  throws — {@link assertManagedTimeoutSchemas} is where a bad shape is refused, at boot, once. */
function timeoutSchemaFor(module: string): TimeoutSchema | undefined {
  const schema = MANIFEST_BY_MODULE[module]?.configSchema as
    { properties?: Record<string, unknown> } | undefined;
  const prop = schema?.properties?.timeoutMs as
    { type?: unknown; minimum?: unknown; maximum?: unknown; default?: unknown } | undefined;
  if (!prop || prop.type !== "integer") return undefined;
  const { minimum, maximum, default: dflt } = prop;
  if (typeof minimum !== "number" || typeof maximum !== "number" || typeof dflt !== "number") {
    return undefined;
  }
  return { minimum, maximum, default: dflt };
}

/** Fails loud at load if a managed manifest omits it. See docs/plugin-host.md §15. */
export function assertManagedTimeoutSchemas(): void {
  const bad: string[] = [];
  for (const module of MANAGED_EXECUTOR_MODULES) {
    const schema = timeoutSchemaFor(module);
    if (
      !schema ||
      !(schema.minimum >= 1) ||
      !(schema.maximum > schema.minimum) ||
      !(schema.default >= schema.minimum && schema.default <= schema.maximum) ||
      // AND THE CEILING MUST BE THE ONE THE LAUNCHER ENFORCES. See docs/plugin-host.md §16.
      schema.maximum !== MANAGED_RUN_TIMEOUT_MAX_MS
    ) {
      bad.push(module);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `managed executor module(s) ${bad.join(", ")} do not publish a bounded ` +
        `configSchema.properties.timeoutMs ({ type: "integer", minimum, ` +
        `maximum: MANAGED_RUN_TIMEOUT_MAX_MS (${MANAGED_RUN_TIMEOUT_MAX_MS}), default }). ` +
        `The plugin host derives that module's 'trigger' RPC budget from those bounds ` +
        `(apps/server/src/plugin-host/call-policy.ts); without a maximum a tenant-settable ` +
        `timeout is an unbounded host budget, and without the property at all the module silently ` +
        `reverts to the 10s hang detector that SIGKILLs a running managed container.`
    );
  }
}

/** What the host should do for one `(instance, method)` RPC. */
export interface CallPolicy {
  /** Total wall-clock budget for the call, including wait-for-ready and any retry. */
  readonly budgetMs: number;
  /** Whether `call()` may transparently re-issue this request after the child crashed mid-call. */
  readonly retryOnCrash: boolean;
}

/**
 * The policy for one call. `hangDetectorMs` is the host's configured `callTimeoutMs` — the default
 * for every method that is not a managed `trigger`, and deliberately left at 10s.
 */
export function resolveCallPolicy(args: {
  module: string;
  config: unknown;
  method: string;
  hangDetectorMs: number;
}): CallPolicy {
  if (args.method !== TRIGGER_METHOD) {
    return { budgetMs: args.hangDetectorMs, retryOnCrash: true };
  }
  const schema = timeoutSchemaFor(args.module);
  if (!schema) return { budgetMs: args.hangDetectorMs, retryOnCrash: true };

  const configured = (args.config as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  const requested =
    typeof configured === "number" && Number.isFinite(configured) ? configured : schema.default;
  // CLAMPED, not refused: this is a read of an already-stored row, and the write door is where a
  // bad value is rejected. See the module comment on why the clamp is load-bearing for rows that
  // predate the ceiling.
  const runBudget = Math.min(schema.maximum, Math.max(schema.minimum, Math.trunc(requested)));
  // THE GRACE IS THE ADAPTER'S, NOT A CONSTANT (M23.5 HIGH-2). See {@link runnerLauncherKindOf}: the
  // field it reads is the one the launcher resolver itself switches on, injected into this same
  // config object, so the host cannot budget for a Docker teardown while the plugin performs a
  // Kubernetes one.
  return {
    budgetMs: runBudget + managedTriggerGraceMs(runnerLauncherKindOf(args.config)),
    retryOnCrash: false
  };
}

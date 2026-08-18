import { MANIFEST_BY_MODULE } from "./plugin-manifests.js";

/**
 * PER-METHOD RPC POLICY FOR THE SUBPROCESS PLUGIN HOST (M23.1c).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS TO CLOSE, stated as the measurement rather than as a worry.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `host.ts`'s `DEFAULTS.callTimeoutMs` is 10 SECONDS and applied to EVERY method uniformly, and
 * the only non-test construction of a `SubprocessPluginHost` in the product — `host-bootstrap.ts`'s
 * `new SubprocessPluginHost()` — passes no options at all. Production therefore ran the 10s default.
 * Meanwhile all three managed executors run their container SYNCHRONOUSLY inside `trigger()`, with
 * their own budget of 10 minutes (managed-iac, managed-scan) or 5 (managed-dep).
 *
 * On expiry `sendOnce` does not merely reject: it `instance.child?.kill("SIGKILL")`. There is no
 * `finally`, no `catch`, no outcome write, no `saveState`. So every managed run longer than ten
 * seconds — which is every real one — ended like this:
 *
 *   - the runner container ORPHANS `state=running`, with the resolved credentials still in its
 *     `Config.Env` where `docker inspect` can read them;
 *   - managed-iac's idempotency ledger entry is NEVER WRITTEN (`saveState` sits after the run), so
 *     `reconcile.ts`'s attempt/backoff retry issues a SECOND `tofu apply` against live
 *     infrastructure while the first container is still applying — against a plugin whose own header
 *     calls this "the strongest idempotency guarantee of any M7 executor";
 *   - `status()` reports `pending` forever for a run that is over, on all three plugins.
 *
 * Nothing caught it because the real plugins are tested WITHOUT the host and every test that builds
 * a host passes an explicit `callTimeoutMs` and drives a fast fake executor. Component correct,
 * wiring untested, suite green — CLAUDE.md's dominant failure class.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE POLICY (owner decision, M23.1c (a)): PER-METHOD, NOT A BIGGER GLOBAL NUMBER.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Raising `callTimeoutMs` globally is the obvious fix and it is the wrong one: the 10s budget is a
 * HANG DETECTOR, and it is meaningful for exactly the methods that are supposed to be fast —
 * `observe`, `status`, `abort`, `evaluate`, `discover`, `send`, `listVersions`. Making it ten
 * minutes so that one method can be slow would blind the host to a wedged `status()` on every
 * plugin in the product.
 *
 * So the budget is a function of (module, method):
 *   - `trigger` on a MANAGED executor -> that instance's own resolved `timeoutMs` + {@link
 *     MANAGED_TRIGGER_GRACE_MS}. The plugin's `execFile` timeout is the inner bound and must fire
 *     FIRST — the grace is what guarantees it does, leaving the plugin's own recorded-outcome path
 *     (M23.1 phase 2's `withRecordedOutcome`) the room to run and `saveState` the room to land.
 *   - everything else -> the host's unchanged 10s hang detector.
 *
 * AND NO TRANSPARENT RETRY FOR A MANAGED `trigger`. `host.call()` retries once per crash while
 * budget remains, which is right for an idempotent read and actively dangerous here: this change
 * widens the crash window from ≤10s to ≤10.5min, and the retry would re-enter a `trigger()` whose
 * ledger entry is (by construction) not yet written. Worse, the retry's container name is derived
 * from the same `idempotencyKey`, so its `docker create` collides with the still-running first
 * container and the adapter's unconditional teardown then `rm -f`s the run that legitimately holds
 * the name (`@scp/runner-launcher`'s `runnerContainerName` names that trade). A crash mid-apply must
 * surface to `reconcile.ts`, not be papered over one layer below it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE NUMBERS COME FROM THE MANIFEST AND NOWHERE ELSE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The floor/ceiling/default this reads are the SAME JSON Schema object `validatePluginConfig` gates
 * tenant writes on (`MANIFEST_BY_MODULE`). Re-declaring them here would create a second copy that
 * drifts silently: a manifest could accept a value the host refuses to wait for, which is precisely
 * the "two lists of the same vocabulary" shape this repo has been bitten by. There is one number and
 * both readers read it.
 *
 * The CLAMP is not belt-and-braces either. `maximum` was added to those schemas in this same change,
 * so a binding row stored BEFORE it — including the 2^31 the old `{ minimum: 1000 }` admitted — is
 * still in the database and is never re-validated on read. Clamping on the way into the budget is
 * what makes the ceiling true of the running system rather than only of future writes.
 */

/**
 * The managed-execution classes — the charter's single scoped exception to "coordination, not
 * execution" (principle 1), and therefore the only plugins whose `trigger()` legitimately blocks for
 * minutes. Membership is defined by "does this module's manifest declare a bounded `timeoutMs`",
 * checked at boot by {@link assertManagedTimeoutSchemas}, so a fourth managed class cannot be added
 * without either joining this list or failing the boot.
 */
export const MANAGED_EXECUTOR_MODULES = ["managed-iac", "managed-scan", "managed-dep"] as const;

/**
 * How much longer the HOST waits than the plugin's own `execFile` timeout.
 *
 * ORDERING IS THE WHOLE POINT, not headroom for slowness. The inner timeout must be the one that
 * fires, because it is the only one attached to code that cleans up: `execFile`'s timeout kills the
 * `docker start -a`, the adapter's `finally` issues `rm -f <name>`, `withRecordedOutcome` records a
 * failure, and managed-iac's `saveState` writes the ledger entry that stops the retry from
 * double-applying. The host's expiry is a `SIGKILL` of the subprocess and runs NONE of that. 30s is
 * sized for the teardown that follows the inner expiry — one `docker rm -f`
 * (`RUNNER_REMOVE_TIMEOUT_MS` is itself 30s), a copy-out that may still be draining, and a
 * `saveState` fsync.
 */
export const MANAGED_TRIGGER_GRACE_MS = 30_000;

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

/**
 * Fails LOUD at module load if any managed executor's manifest does not publish a `timeoutMs` that
 * is bounded at BOTH ends with an in-range default.
 *
 * This is the install-site gate, and it is here rather than in a test for the reason
 * `assertEveryModuleHasManifest` is: an unbounded ceiling is a defect the moment it is committed,
 * not the moment some write door happens to be exercised. Without it, deleting `maximum` from one
 * manifest degrades silently — {@link timeoutSchemaFor} returns `undefined`, that plugin's `trigger`
 * quietly falls back to the 10s hang detector, and the M23.1c defect is back on exactly one of the
 * three plugins with a green suite. A boot that would do that does not boot.
 */
export function assertManagedTimeoutSchemas(): void {
  const bad: string[] = [];
  for (const module of MANAGED_EXECUTOR_MODULES) {
    const schema = timeoutSchemaFor(module);
    if (
      !schema ||
      !(schema.minimum >= 1) ||
      !(schema.maximum > schema.minimum) ||
      !(schema.default >= schema.minimum && schema.default <= schema.maximum)
    ) {
      bad.push(module);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `managed executor module(s) ${bad.join(", ")} do not publish a bounded ` +
        `configSchema.properties.timeoutMs ({ type: "integer", minimum, maximum, default }). ` +
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
  return { budgetMs: runBudget + MANAGED_TRIGGER_GRACE_MS, retryOnCrash: false };
}

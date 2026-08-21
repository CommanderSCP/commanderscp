import {
  MANAGED_RUN_TIMEOUT_MAX_MS,
  RUNNER_TEARDOWN_STEPS,
  runnerPostDeadlineMs
} from "@scp/runner-launcher";
import type { RunnerLauncherKind } from "@scp/runner-launcher";
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
 *     MANAGED_TRIGGER_GRACE_MS}. What guarantees the plugin's own bound fires first is NOT this
 *     grace (M23.1e — see that constant's doc for the measurement that disproved it) but the
 *     launcher: `RunnerSpec.timeoutMs` is the WHOLE-RUN budget, read once as a deadline and spent
 *     down across every step, so a run cannot exceed it however many `execFile`s it takes. The
 *     grace covers exactly what happens after that deadline — one `docker rm -f` teardown, the
 *     recorded-outcome write (M23.1 phase 2's `withRecordedOutcome`) and `saveState`.
 *   - everything else -> the host's unchanged 10s hang detector.
 *
 * AND NO TRANSPARENT RETRY FOR A MANAGED `trigger`. `host.call()` retries once per crash while
 * budget remains, which is right for an idempotent read and actively dangerous here: this change
 * widens the crash window from ≤10s to ≤11min, and the retry would re-enter a `trigger()` whose
 * ledger entry is (by construction) not yet written — a SECOND `tofu apply` against live
 * infrastructure while the first is still applying. Its container name is derived from the same
 * `idempotencyKey`, so its `docker create` also collides with the still-running first container;
 * since M23.1e the loser at least no longer `rm -f`s the winner (the adapter skips teardown on a
 * name conflict — `@scp/runner-launcher`'s `isContainerNameConflict`), but a retry that cannot
 * proceed is not a retry worth having. A crash mid-apply must surface to `reconcile.ts`, not be
 * papered over one layer below it.
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
 * what makes the ceiling true of THIS number.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS CLAMP DOES NOT COVER, BECAUSE THE SENTENCE ABOVE USED TO CLAIM IT DID.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It said clamping here "is what makes the ceiling true of the running system". It made the ceiling
 * true of ONE number in the running system — `budgetMs`, the host's own RPC deadline — and of
 * nothing else. `resolveCallPolicy` clamps its return value; it does not write anything back, and
 * the plugin on the other side of the RPC read the SAME stored row and passed
 * `config.timeoutMs ?? DEFAULT_TIMEOUT_MS` straight into `RunnerSpec.timeoutMs`. For a stored 4h the
 * host budgeted 3_660_000ms and the launcher ran to 14_400_000ms, so the host's SIGKILL orphaned a
 * container stamped 181 minutes past the moment `reap()` could collect it.
 *
 * `@scp/runner-launcher`'s `clampRunTimeoutMs` is the other half, applied inside `run()` where all
 * three plugins and both adapters converge. The two clamps must read the SAME ceiling or they
 * reintroduce the ordering defect this file exists to close, so {@link assertManagedTimeoutSchemas}
 * refuses at boot unless every managed manifest's `maximum` IS `MANAGED_RUN_TIMEOUT_MAX_MS`.
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
 * How much longer the HOST waits than the plugin's own WHOLE-RUN budget.
 *
 * ORDERING IS THE WHOLE POINT, not headroom for slowness. The plugin's own bound must be the one
 * that fires, because it is the only one attached to code that cleans up: it stops the
 * `docker start -a`, the adapter's `finally` issues `rm -f <name>`, `withRecordedOutcome` records a
 * failure, and managed-iac's `saveState` writes the ledger entry that stops the retry from
 * double-applying. The host's expiry is a `SIGKILL` of the subprocess and runs NONE of that.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS COMMENT USED TO CLAIM, WHY IT WAS FALSE, AND WHAT IS TRUE NOW (M23.1e).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It said the grace was "sized so the plugin's inner `execFile` timeout fires first". That was true
 * of ONE `execFile`. A managed run issues four (managed-iac, managed-dep) to six (managed-scan)
 * SEQUENTIAL ones, and `@scp/runner-launcher` handed each of them `{ timeout: spec.timeoutMs }`
 * INDEPENDENTLY — so what the grace was sized against was a per-call bound while what it had to
 * cover was their SUM, which nothing bounded at all. Measured through a default-constructed
 * `SubprocessPluginHost` driving the real managed-iac plugin with `timeoutMs: 20_000` and steps of
 * 18s/9s/18s/9s — every one of them comfortably under the inner 20s bound — the run reached 50003ms
 * against a 50000ms budget and was SIGKILLed: an orphaned container still applying, and no ledger
 * entry, so `reconcile.ts` issued a second `tofu apply` on top of the first. Reachable at the
 * shipped 10-minute defaults, because `docker create` PULLS THE IMAGE when it is absent — a cold
 * pull plus an ordinary apply clears 630s with no single call reaching 600s. The proof that nothing
 * here was load-bearing: shrinking this constant from 30_000 to 3_000 reddened NOTHING.
 *
 * SO THE ORDERING IS NOW A PROPERTY OF THE LAUNCHER, NOT OF THIS NUMBER. `RunnerSpec.timeoutMs` is
 * the WHOLE-RUN budget: the adapter reads one deadline at the top of `run()` and issues every step
 * with what is LEFT of it, so a run cannot exceed `timeoutMs` however many steps it takes. This
 * constant no longer has to guess at a sum. It has to cover exactly the work that happens AFTER
 * that deadline.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND THAT WORK IS NOT ONE CALL — M23.5 HIGH-2, THE SAME DEFECT ONE LEVEL UP.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This block used to name exactly one term — `RUNNER_REMOVE_TIMEOUT_MS`, "the adapter's
 * `finally { docker rm -f }`" — and chose 60s as TWO worst-case teardowns. True of the Docker
 * adapter. The Kubernetes adapter's `finally` is THREE bounded calls: DELETE the Job, DELETE the
 * Secret, remove the workspace subtree. Sixty seconds of bounded work therefore consumed the entire
 * grace and left nothing for the outcome write the grace exists to protect — verbatim what the
 * paragraph below calls "WRONG BY CONSTRUCTION" about the 30s this replaced, arriving on the
 * adapter nobody re-derived the number for.
 *
 * THE NUMBER WAS GATED AND THE MODEL WAS NOT. `call-policy.test.ts` asserted
 * `MANAGED_TRIGGER_GRACE_MS > RUNNER_REMOVE_TIMEOUT_MS` — ONE teardown — so the teardown could grow
 * to three with every test still green and nothing anywhere knowing it had.
 *
 * SO THE GRACE IS DERIVED FROM THE ADAPTER IN USE, and the model it derives from lives in the
 * launcher, where the teardown does: {@link RUNNER_TEARDOWN_STEPS} declares how many bounded calls
 * each adapter's `finally` issues, `teardown-model.test.ts` COUNTS what each one actually issues,
 * and `runnerPostDeadlineMs` turns the count into milliseconds. A fourth teardown step reddens that
 * census by name; correcting the declared count then moves this grace, the reap stamp and the
 * stated `run()` bound together. The terms:
 *
 *     runnerPostDeadlineMs(kind)   one possible abandonment of the step that was in flight when
 *                                  the deadline passed, plus that adapter's WHOLE teardown —
 *                                  32s on Docker, 94s on Kubernetes
 *   + MANAGED_OUTCOME_TAIL_MS      what the grace EXISTS for: `withRecordedOutcome`'s write,
 *                                  managed-iac's `saveState` fsync, and the RPC response crossing
 *                                  the pipe                                                   30s
 *
 * 30s was WRONG BY CONSTRUCTION rather than merely tight: one worst-case teardown consumed the
 * entire grace. The RELATIONSHIP, not the number, is what `call-policy.test.ts` gates — and it now
 * gates it for EVERY adapter kind rather than for the one that happened to exist when it was
 * written. The launcher package cannot check it from its side; the dependency only goes one way,
 * which is exactly why the old "re-derived here rather than shared, and padded well past it"
 * drifted.
 */
export const MANAGED_OUTCOME_TAIL_MS = 30_000;

/**
 * How much longer the HOST waits than the plugin's own whole-run budget, ON THE ADAPTER IN USE.
 * Both terms above; neither restated.
 */
export function managedTriggerGraceMs(kind: RunnerLauncherKind): number {
  return runnerPostDeadlineMs(kind) + MANAGED_OUTCOME_TAIL_MS;
}

/**
 * The DOCKER grace — the default, because an unset `runnerLauncher` is Docker everywhere else in
 * this product (`resolveRunnerLauncher`: "an unset value is Docker — byte-identical behaviour for
 * every deployment that does not opt in"). It stays a constant because it is what every
 * non-Kubernetes deployment gets; a deployment that selected the Kubernetes launcher gets
 * {@link managedTriggerGraceMs}`("kubernetes")` instead, off the same server-injected config field
 * the launcher resolver itself switches on.
 */
export const MANAGED_TRIGGER_GRACE_MS = managedTriggerGraceMs("docker");

/**
 * WHICH ADAPTER THIS INSTANCE'S `trigger()` WILL ACTUALLY USE.
 *
 * `runnerLauncher` is server-injected into every managed executor's config by
 * `executor-bindings-repo.ts`'s `managedRunnerSettings()` — the same field, in the same object,
 * that `resolveRunnerLauncher` switches on inside the plugin subprocess. Reading it HERE is what
 * makes "derived from what teardown costs on the adapter in use" true rather than aspirational:
 * the host and the launcher answer the question from one value, which is the same argument
 * {@link assertManagedTimeoutSchemas} makes about the ceiling.
 *
 * ANYTHING ELSE IS DOCKER, and the fail-safe direction is the one that matters. An unrecognised
 * value makes the launcher resolver fall through to Docker too (`config.runnerLauncher !==
 * "kubernetes"`), so the two agree by construction; and Docker is the SHORTER grace, so a
 * disagreement in this direction could only make the host give up early — never wait past a reap
 * stamp that has already expired, which is the direction that puts a peer's sweep on a live run.
 */
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
      !(schema.default >= schema.minimum && schema.default <= schema.maximum) ||
      // AND THE CEILING MUST BE THE ONE THE LAUNCHER ENFORCES — see the module doc's last section.
      // There are now TWO clamps on one number and they must not be allowed to drift: a manifest
      // ceiling ABOVE the launcher's makes the host wait for a run the launcher already killed, and
      // one BELOW it puts the M23.1c SIGKILL back on a run that is still legitimately inside its own
      // budget. Equality, not "<=", because both directions are defects.
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

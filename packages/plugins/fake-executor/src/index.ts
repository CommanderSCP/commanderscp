/** The in-repo executor with controllable, deterministic outcomes. See docs/plugins.md §62. */
import { randomUUID } from "node:crypto";
import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  AbortResult,
  Cursor,
  ExecutionPhase,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  ExternalRunRef,
  PluginContext,
  PluginManifest,
  TriggerIntent
} from "@scp/plugin-api";

/** Delimiter between targetRef and the run token in a minted externalId — see `mintExternalId`. */
const REF_DELIMITER = "::";
/** `status()` reports "running" until this many ms have elapsed since `trigger()`, then "succeeded". */
const DEFAULT_AUTO_SUCCEED_MS = 200;
/** Fallback target key when a caller omits `TriggerIntent.targetRef` (kept permissive, not fatal —
 *  the conformance suite and ad hoc tests shouldn't have to know fake-executor's own conventions). */
const DEFAULT_TARGET_KEY = "__default__";

interface TargetState {
  /** The "current desired state" version, bumped on every non-rollback trigger; rendered as `v${version}`. */
  version: number;
  phase: ExecutionPhase;
  /** epoch ms — when the current run was triggered; drives the auto-succeed timer. */
  triggeredAt: number;
  /** The externalId of the run currently tracked for this target. */
  externalId: string;
  /** Set by `abort()`; once true, `status()` never lets the auto-succeed timer override the phase. */
  terminal: boolean;
  /** `TriggerIntent.idempotencyKey` of the trigger that produced this state, when the caller set
   *  one — see `trigger()`'s dedup check below (PR #7 review, CRITICAL #2). */
  lastIdempotencyKey?: string;
}

interface FakeExecutorState {
  targets: Record<string, TargetState>;
}

/** `PluginContext.config` shape this plugin understands — validated loosely (BUILD_AND_TEST.md
 *  §8 M3 item 7 brief: "validate loosely"), since config crosses a JSON boundary either way. */
interface FakeExecutorConfig {
  /** ms after trigger() before status() reports "succeeded" instead of "running". Default 200. */
  autoSucceedAfterMs?: number;
  /** Per-target deterministic override — e.g. `{ "target-b": "failed" }` makes wave target
   *  "target-b" always report "failed", regardless of elapsed time. This IS the "explicit test
   *  hook" the M3 build brief asks for: set it in the instance's config up front (config is fixed
   *  for a plugin instance's lifetime) rather than adding a live control channel. */
  forcePhase?: Record<string, ExecutionPhase>;
  /** When set, state is persisted here (JSON) instead of an in-memory Map — see module doc. */
  statePath?: string;
  /** Deterministic `observe()` output for the observe()-driver tests (coordination/observe.ts):
   *  the events this instance emits, filtered by the `since` watermark on `occurredAt` so a poll
   *  with an advanced cursor returns only newer events — exactly a real pull executor's behavior. */
  observeEvents?: ExecutorEvent[];
  /** Per-target deterministic deployed-image refs, surfaced on `status().observed.images` (ADR-0008
   *  signal 1). Mirrors `forcePhase`: an explicit test hook set in instance config up front, so a
   *  coordination integration test can prove reconcile threads `status().observed.images` through to
   *  the wave target's `observed_state` without needing a live ArgoCD. */
  imagesByTarget?: Record<string, string[]>;
  /** Per-target deterministic OBSERVE-ONLY rollout snapshot, surfaced on `status().observed.rollout`
   *  (ADR-0008 P4D — rollout state is OBSERVED, NOT DRIVEN). Mirrors `imagesByTarget`: an explicit
   *  test hook so a coordination integration test can prove reconcile threads
   *  `status().observed.rollout` through to `observed_state` without a live Argo Rollouts. */
  rolloutByTarget?: Record<
    string,
    { phase?: string; step?: number; weight?: number; message?: string }
  >;
  /** Per-target deterministic `status().detail`. See docs/plugins.md §63. */
  detailByTarget?: Record<string, string>;

  /** A generated per-target detail, too large to cross argv. See docs/plugins.md §64. */
  detailRepeatByTarget?: Record<
    string,
    { head: string; unit: string; times: number; tail: string }
  >;

  /** GENERATED image refs, for the same reason `detailRepeatByTarget` exists: a 100 KB+ literal
   *  cannot cross the spawn argv on Linux. `count` refs, each `head` + `unit` repeated `times`. */
  imagesRepeatByTarget?: Record<
    string,
    { head: string; unit: string; times: number; count: number }
  >;
  /** Per-target deterministic `status().stateRef`. See docs/plugins.md §65. */
  stateRefByTarget?: Record<string, unknown>;
  /** Per-target extra fields the returned run ref carries. See docs/plugins.md §66. */
  runRefExtrasByTarget?: Record<string, Record<string, unknown>>;
}

function readConfig(config: unknown): FakeExecutorConfig {
  if (config && typeof config === "object") return config as FakeExecutorConfig;
  return {};
}

function mintExternalId(targetRef: string): string {
  return `${targetRef}${REF_DELIMITER}${randomUUID()}`;
}

function parseTargetRef(externalId: string): string {
  const idx = externalId.lastIndexOf(REF_DELIMITER);
  return idx === -1 ? externalId : externalId.slice(0, idx);
}

/** Parses a prior `status()` call's `stateRef`. See docs/plugins.md §67. */
function coercePriorStateRef(priorStateRef: unknown): number {
  const direct = /^v(\d+)$/.exec(String(priorStateRef ?? ""));
  if (direct) return Number(direct[1]);
  if (priorStateRef !== null && typeof priorStateRef === "object") {
    const nested = (priorStateRef as Record<string, unknown>).version;
    const structured = /^v(\d+)$/.exec(String(nested ?? ""));
    if (structured) return Number(structured[1]);
  }
  return 0;
}

function computePhase(target: TargetState, autoSucceedAfterMs: number): ExecutionPhase {
  if (target.terminal) return target.phase;
  const elapsed = Date.now() - target.triggeredAt;
  return elapsed >= autoSucceedAfterMs ? "succeeded" : "running";
}

function expandRepeatedDetail(
  spec: { head: string; unit: string; times: number; tail: string } | undefined
): string | undefined {
  if (!spec) return undefined;
  return `${spec.head}${spec.unit.repeat(spec.times)}${spec.tail}`;
}

export class FakeExecutorPlugin implements ExecutorPlugin {
  /** Fallback store used only when `ctx.config.statePath` is unset — see module doc. Per-instance
   *  (unlike the module-scoped caches in the other executor plugins), matching this class's
   *  existing per-instance in-memory fallback. */
  private readonly dedupCache = createFileBackedJsonCache<FakeExecutorState>(() => ({
    targets: {}
  }));

  private async loadState(config: unknown): Promise<FakeExecutorState> {
    return this.dedupCache.load(readConfig(config).statePath);
  }

  private async saveState(config: unknown, state: FakeExecutorState): Promise<void> {
    // Write-to-temp + rename: the only atomicity guarantee this tiny JSON blob needs, and it's
    // what protects the "kill subprocess mid-wave, wave resumes" scenario from ever reading a
    // half-written state file if a respawned process races the old one's final write.
    return this.dedupCache.save(readConfig(config).statePath, state);
  }

  async observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]> {
    // Default: no push-based events (the coordination engine drives the fake executor purely by
    // trigger/status). When `config.observeEvents` is set (observe()-driver tests), emit them,
    // honoring the `since` watermark on `occurredAt` so an advanced cursor returns only newer ones.
    const events = readConfig(ctx.config).observeEvents ?? [];
    if (!since?.token) return events;
    return events.filter((e) => typeof e.occurredAt === "string" && e.occurredAt > since.token);
  }

  async trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
    const targetRef = intent.targetRef ?? DEFAULT_TARGET_KEY;
    const state = await this.loadState(ctx.config);
    const existing = state.targets[targetRef];

    // Idempotency dedup (PR #7 review, CRITICAL #2). See docs/plugins.md §68.
    if (intent.idempotencyKey && existing?.lastIdempotencyKey === intent.idempotencyKey) {
      ctx.logger.info("fake-executor: trigger deduped by idempotencyKey", {
        targetRef,
        kind: intent.kind,
        idempotencyKey: intent.idempotencyKey,
        externalId: existing.externalId
      });
      return {
        ...(readConfig(ctx.config).runRefExtrasByTarget?.[targetRef] ?? {}),
        externalId: existing.externalId,
        url: `fake-executor://${targetRef}/${existing.externalId}`
      };
    }

    const isRollback = intent.kind === "rollback";
    const version = isRollback
      ? coercePriorStateRef(intent.priorStateRef)
      : (existing?.version ?? -1) + 1;
    const externalId = mintExternalId(targetRef);

    state.targets[targetRef] = {
      version,
      phase: "running",
      triggeredAt: Date.now(),
      externalId,
      terminal: false,
      lastIdempotencyKey: intent.idempotencyKey
    };
    await this.saveState(ctx.config, state);

    ctx.logger.info("fake-executor: triggered", { targetRef, kind: intent.kind, version });
    return {
      // See `runRefExtrasByTarget`: BEFORE `externalId`, because insertion order is what decides
      // which key the bound seats, and a real plugin does not put the leaf we depend on first.
      ...(readConfig(ctx.config).runRefExtrasByTarget?.[targetRef] ?? {}),
      externalId,
      url: `fake-executor://${targetRef}/${externalId}`
    };
  }

  async status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
    const targetRef = parseTargetRef(ref.externalId);
    const state = await this.loadState(ctx.config);
    const target = state.targets[targetRef];

    if (!target || target.externalId !== ref.externalId) {
      // Unknown / superseded ref. See docs/plugins.md §69.
      return {
        phase: "pending",
        detail: "fake-executor: unknown run (fresh state or superseded ref)"
      };
    }

    const cfg = readConfig(ctx.config);
    const forced = cfg.forcePhase?.[targetRef];
    const autoSucceedAfterMs = cfg.autoSucceedAfterMs ?? DEFAULT_AUTO_SUCCEED_MS;
    const phase = forced ?? computePhase(target, autoSucceedAfterMs);
    const settled = phase === "succeeded" || phase === "failed" || phase === "aborted";

    const images = cfg.imagesByTarget?.[targetRef];
    const rollout = cfg.rolloutByTarget?.[targetRef];
    const observed: { images?: string[]; rollout?: typeof rollout } = {};
    const generated = cfg.imagesRepeatByTarget?.[targetRef];
    if (generated) {
      const ref = `${generated.head}${generated.unit.repeat(generated.times)}`;
      observed.images = Array.from({ length: generated.count }, () => ref);
    } else if (images && images.length > 0) observed.images = images;
    if (rollout && Object.keys(rollout).length > 0) observed.rollout = rollout;
    return {
      phase,
      // The per-target override is the STRING seam into `observed_state.revision`; the default is
      // the version this plugin has always reported. See `stateRefByTarget`.
      stateRef: cfg.stateRefByTarget?.[targetRef] ?? `v${target.version}`,
      detail:
        cfg.detailByTarget?.[targetRef] ??
        expandRepeatedDetail(cfg.detailRepeatByTarget?.[targetRef]) ??
        `fake-executor target=${targetRef} version=v${target.version}`,
      ...(observed.images || observed.rollout ? { observed } : {}),
      progress: settled ? 1 : 0.5
    };
  }

  async abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
    const targetRef = parseTargetRef(ref.externalId);
    const state = await this.loadState(ctx.config);
    const target = state.targets[targetRef];
    if (!target || target.externalId !== ref.externalId) {
      return { aborted: false, detail: "fake-executor: unknown run" };
    }
    target.phase = "aborted";
    target.terminal = true;
    await this.saveState(ctx.config, state);
    return { aborted: true };
  }

  describeCapabilities(): ExecutorCapabilities {
    return {
      supportsObserve: true,
      supportsTrigger: true,
      supportsAbort: true,
      triggerKinds: ["sync", "workflow_dispatch", "rollback", "custom"]
    };
  }
}

export function createFakeExecutorPlugin(): ExecutorPlugin {
  return new FakeExecutorPlugin();
}

/** Manifest — added because "never shipped to a real org". See docs/plugins.md §70. */
export const manifest: PluginManifest = {
  id: "fake-executor",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      autoSucceedAfterMs: { type: "integer", minimum: 0, default: DEFAULT_AUTO_SUCCEED_MS },
      forcePhase: { type: "object", additionalProperties: { type: "string" } },
      observeEvents: { type: "array", items: { type: "object" } },
      imagesByTarget: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } }
      },
      rolloutByTarget: { type: "object", additionalProperties: { type: "object" } },
      detailByTarget: { type: "object", additionalProperties: { type: "string" } },
      imagesRepeatByTarget: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            head: { type: "string" },
            unit: { type: "string" },
            times: { type: "integer" },
            count: { type: "integer" }
          },
          required: ["head", "unit", "times", "count"],
          additionalProperties: false
        }
      },
      detailRepeatByTarget: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            head: { type: "string" },
            unit: { type: "string" },
            times: { type: "integer" },
            tail: { type: "string" }
          },
          required: ["head", "unit", "times", "tail"],
          additionalProperties: false
        }
      },
      // NOT `additionalProperties: {type: "string"}`: `ExecutionStatus.stateRef` is `unknown`, and
      // a structured prior state is the shape `prior_state_ref` is bounded as.
      stateRefByTarget: { type: "object" },
      runRefExtrasByTarget: {
        type: "object",
        additionalProperties: { type: "object" }
      }
    }
  }
};

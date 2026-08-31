/**
 * @scp/plugin-fake-executor — the in-repo `ExecutorPlugin` with controllable, deterministic
 * outcomes (BUILD_AND_TEST.md §4.2: "a fake-executor plugin (in-repo, controllable outcomes)
 * used for full coordination-loop tests without any external system"; §8 M3 item 7). Never
 * shipped to a real org — its only job is letting the reconciliation loop, the subprocess plugin
 * host, and their integration tests drive a realistic multi-wave rollout AND a rollback,
 * deterministically, with no network or external system involved.
 *
 * State-persistence design (documented per the M3 build brief, since it's the thing that makes
 * the plugin-host isolation DoD scenario — "kill the fake-executor SUBPROCESS mid-wave... the
 * wave resumes" — actually true): state is keyed by `TriggerIntent.targetRef` and, when
 * `ctx.config.statePath` is set, persisted to that JSON file after every mutation (write-to-temp
 * + rename, so a concurrent reader never observes a half-written file). A subprocess plugin host
 * (apps/server/src/plugin-host/host.ts) passes a stable `statePath` per instance, so when it
 * kills and respawns the child mid-wave, the NEW process's `FakeExecutorPlugin` re-reads exactly
 * the state the old one left behind and `status()` keeps answering correctly for in-flight refs —
 * this mirrors how a REAL executor's state lives external to the plugin process (GitHub/ArgoCD
 * don't forget a workflow run because SCP's plugin subprocess restarted).
 *
 * When `statePath` is unset (typical for fast in-process unit tests), state lives in a plain
 * in-memory `Map` scoped to the `FakeExecutorPlugin` instance — a "restart" in that mode really
 * would lose state, which is why the subprocess-host path always sets `statePath`.
 */
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
  /**
   * Per-target deterministic `status().detail`. Mirrors `forcePhase`, and exists for one reason
   * `imagesByTarget` and `rolloutByTarget` do not cover: `ExecutionStatus.detail` is free-form
   * `string` from ANY executor plugin, and `reconcile.ts` writes it into a `Decision`'s
   * `inputContext` — permanent governed state, one row per failing poll. Proving that write is
   * BOUNDED needs a plugin that returns an unbounded detail, and no in-repo plugin does: the three
   * managed ones bound their own at composition (`@scp/runner-launcher`'s `boundDetail`, enforced
   * by their stores' types), which is exactly why they cannot be the witness. A THIRD-PARTY plugin
   * is the case the bound is for, and this is the only stand-in for one.
   */
  detailByTarget?: Record<string, string>;

  /**
   * A GENERATED per-target `detail`, for values too large to cross a spawn argv.
   *
   * `detailByTarget` carries its string literally, and the plugin host passes plugin config on the
   * subprocess ARGV (`host.ts` `spawnInstance`). Linux caps a single argument at MAX_ARG_STRLEN
   * (128 KiB) and answers `spawn E2BIG` past it; macOS does not, so a 432 KB literal passed locally
   * and failed only on CI. The bound belongs to the transport, not to this plugin — so a test that
   * needs a large detail sends the RECIPE and the plugin expands it here, in-process.
   */
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
  /**
   * Per-target deterministic `status().stateRef` — the synced revision. Mirrors `imagesByTarget`
   * and `rolloutByTarget`, and exists because of what their SHAPES could not reach.
   *
   * THE HARNESS HAD NO STRING SEAM INTO `observed_state`, and four consecutive verification rounds
   * shipped a regression behind that gap (M23.0 pass 10). `observedStateFrom` builds
   * `{revision, images, rollout}`: `revision` comes from `status().stateRef`, which this plugin
   * HARDCODED to `v${target.version}`, and `detail` never enters `observed_state` at all. So the
   * only free-form field an integration test could vary in that column was `imagesByTarget` — an
   * ARRAY. `@scp/runner-launcher`'s persisted-JSON bound treats arrays and strings by different
   * rules (an array is cut by dropping ENTRIES, a string by the per-string width bound), and every
   * string-shaped defect in that allocator was therefore unreachable end to end BY CONSTRUCTION:
   * a per-string bound that discarded half of every share was invisible to a green integration
   * suite for three rounds.
   *
   * The DEFAULT is unchanged — absent this key, `status()` still reports `v${target.version}` and
   * `coercePriorStateRef` still round-trips it — so this adds a seam without moving any existing
   * assertion.
   */
  stateRefByTarget?: Record<string, unknown>;
  /**
   * Per-target extra fields the returned {@link ExternalRunRef} carries ALONGSIDE `externalId`,
   * emitted BEFORE it — the seam `executor_ref` had none of (M23.0 verification pass 12).
   *
   * WHY THE COLUMN NEEDED ONE. `trigger()`'s whole return value is written to
   * `change_wave_targets.executor_ref` by `markWaveTargetTriggered`, through the same
   * `boundPluginJson` as `observed_state` — and EVERY end-to-end fixture in this repository drives
   * `observed_state`. `PluginHost.executor()` types the JSON-RPC response with a BARE CAST, so at
   * runtime the ref is whatever the plugin serialised: a real executor returns its own vendor
   * fields beside the two this interface names, and their ORDER is whatever its serialiser chose.
   * This plugin returned exactly `{externalId, url}`, both short, so no test could reach the
   * branch that decides whether `externalId` survives the bound.
   *
   * WHY `externalId` IS THE WORST LEAF IN THE PRODUCT (pass 9's census, "Instance 3"). All nine
   * executor plugins read it out of the persisted ref to address the run: `status()` here does
   * `parseTargetRef(ref.externalId)` and compares `target.externalId !== ref.externalId`. A ref the
   * executor can no longer interpret is not an error anywhere — this plugin answers `pending`, Argo
   * CD answers 404 — so reconcile writes `observing` and POLLS THE TARGET AS AN UNKNOWN RUN
   * FOREVER, behind a green health check.
   *
   * EMITTED FIRST, DELIBERATELY. The bound seats an object's keys in insertion order, so a ref
   * whose vendor fields come first is the shape in which `externalId` is the one that does not fit.
   * `externalId` and `url` are spread AFTER these, so a config that names either cannot break the
   * plugin's own contract with itself.
   */
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

/**
 * Parses a prior `status()` call's `stateRef` (e.g. `"v2"`) back into a version number for a
 * `rollback` trigger; defensively falls back to 0 for anything else (unset, malformed,
 * uninterpretable — `priorStateRef` is typed `unknown` on the wire).
 *
 * A STRUCTURED PRIOR STATE IS READ TOO, and that is not a convenience — it is what makes
 * `change_wave_targets.prior_state_ref` drivable end to end (M23.0 verification pass 12).
 * `ExecutionStatus.stateRef` is `unknown` precisely so an executor whose state is not one string
 * can return an object (a Terraform state serial and lineage, an Argo CD revision per source), and
 * that is the shape whose LOAD-BEARING LEAF the persisted-JSON bound can drop while leaving the
 * column populated and plausible. With only the string form here, the harness could put nothing in
 * that column that a wrong answer would be visible in: `String({...})` is `"[object Object]"`, so
 * a damaged object and an intact one coerce identically to 0 and a rollback restores version 0
 * either way — indistinguishable from a rollback that worked on a never-triggered target.
 */
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

    // Idempotency dedup (PR #7 review, CRITICAL #2): the engine re-calls trigger() with the SAME
    // idempotencyKey when it can't tell whether a prior attempt's call actually reached us before
    // the caller crashed/retried. Recognizing a repeat is what makes that safe to do — no second
    // real run, no version bump, just the same answer as last time. Only engages when the caller
    // actually sent a key (falsy `intent.idempotencyKey` never matches `undefined ===
    // undefined`... it would, so the truthiness check below is required — an intent that never
    // sets idempotencyKey must always mint a fresh run, exactly like before this field existed).
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
      // Unknown / superseded ref — e.g. an in-memory (no statePath) instance that lost state
      // across a restart, or a stale ref from before a later trigger on the same target.
      // Reporting "pending" rather than throwing is what keeps a killed-and-respawned subprocess
      // (which, with a shared statePath, would NOT hit this branch — see module doc) from ever
      // looking like a hard failure to the reconciliation loop.
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

/**
 * Manifest — added because "never shipped to a real org" (module doc, above) is a statement about
 * INTENT, not about reach: `fake-executor` is on `executor-bindings-repo.ts`'s
 * `KNOWN_EXECUTOR_MODULES` **and** is `DEFAULT_EXECUTOR_MODULE`, so a tenant `PUT /executors/{id}/
 * binding` naming it is accepted on any deployment. While this package had no manifest,
 * `validatePluginConfig` had no schema to gate on and returned early — every key of that binding's
 * config was stored unread.
 *
 * `additionalProperties: false` with `statePath` DELIBERATELY ABSENT, the `managed-iac` shape: the
 * server injects `statePath` itself for every executor instance (`resolveExecutorPluginInstance`,
 * spread LAST), so it is server-governed here exactly as `runnerImage` is there — a binding that
 * sets it is refused rather than silently overridden. The remaining keys are this plugin's
 * deterministic test hooks, which ARE the tenant-facing surface.
 */
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

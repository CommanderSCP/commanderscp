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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Parses a prior `status()` call's `stateRef` (e.g. `"v2"`) back into a version number for a
 *  `rollback` trigger; defensively falls back to 0 for anything else (unset, malformed, non-string —
 *  `priorStateRef` is typed `unknown` on the wire). */
function coercePriorStateRef(priorStateRef: unknown): number {
  const match = /^v(\d+)$/.exec(String(priorStateRef ?? ""));
  return match ? Number(match[1]) : 0;
}

function computePhase(target: TargetState, autoSucceedAfterMs: number): ExecutionPhase {
  if (target.terminal) return target.phase;
  const elapsed = Date.now() - target.triggeredAt;
  return elapsed >= autoSucceedAfterMs ? "succeeded" : "running";
}

export class FakeExecutorPlugin implements ExecutorPlugin {
  /** Fallback store used only when `ctx.config.statePath` is unset — see module doc. */
  private inMemoryState: FakeExecutorState = { targets: {} };

  private async loadState(config: unknown): Promise<FakeExecutorState> {
    const statePath = readConfig(config).statePath;
    if (!statePath) return this.inMemoryState;
    try {
      const raw = await readFile(statePath, "utf8");
      return JSON.parse(raw) as FakeExecutorState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { targets: {} };
      throw err;
    }
  }

  private async saveState(config: unknown, state: FakeExecutorState): Promise<void> {
    const statePath = readConfig(config).statePath;
    if (!statePath) {
      this.inMemoryState = state;
      return;
    }
    await mkdir(dirname(statePath), { recursive: true });
    // Write-to-temp + rename: the only atomicity guarantee this tiny JSON blob needs, and it's
    // what protects the "kill subprocess mid-wave, wave resumes" scenario from ever reading a
    // half-written state file if a respawned process races the old one's final write.
    const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), "utf8");
    await rename(tmpPath, statePath);
  }

  async observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
    // No push-based events for the fake executor (BUILD_AND_TEST.md §8 M3 item 7 brief) — the
    // coordination engine drives it purely by trigger/status.
    return [];
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
      return { externalId: existing.externalId, url: `fake-executor://${targetRef}/${existing.externalId}` };
    }

    const isRollback = intent.kind === "rollback";
    const version = isRollback ? coercePriorStateRef(intent.priorStateRef) : (existing?.version ?? -1) + 1;
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
    return { externalId, url: `fake-executor://${targetRef}/${externalId}` };
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
      return { phase: "pending", detail: "fake-executor: unknown run (fresh state or superseded ref)" };
    }

    const forced = readConfig(ctx.config).forcePhase?.[targetRef];
    const autoSucceedAfterMs = readConfig(ctx.config).autoSucceedAfterMs ?? DEFAULT_AUTO_SUCCEED_MS;
    const phase = forced ?? computePhase(target, autoSucceedAfterMs);
    const settled = phase === "succeeded" || phase === "failed" || phase === "aborted";

    return {
      phase,
      stateRef: `v${target.version}`,
      detail: `fake-executor target=${targetRef} version=v${target.version}`,
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

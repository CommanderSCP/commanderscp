import type PgBoss from "pg-boss";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import type { CelSandbox } from "./governance/cel-sandbox.js";
import type { PluginHost } from "./plugin-host/contract.js";
import { startReconcileLoop } from "./coordination/reconcile.js";
import { startObserveLoop } from "./coordination/observe.js";
import { startWatchdogLoop } from "./coordination/watchdog.js";
import { startInboxLoop } from "./federation/inbox-loop.js";
import { startAutoRelayLoop } from "./federation/auto-relay.js";
import { startFederationSyncLoop } from "./federation/federation-sync.js";
import { startDependencyVersionPollLoop } from "./dependencies/version-poll.js";
import { startInternalReleaseLoop } from "./dependencies/internal-release-loop.js";
import { startInventoryIngestionLoop } from "./dependencies/inventory-ingestion-loop.js";
import { startBumpDispatchLoop } from "./dependencies/bump-dispatch.js";
import { startBumpGateLoop } from "./dependencies/bump-gate.js";
import { startBumpFreezeRedriveLoop } from "./dependencies/bump-freeze-redrive.js";

/** THE BACKGROUND-WORK COMPOSITION. See docs/server.md §15. */

/** Everything any background loop needs. One context for all of them, so a loop cannot be added in
 *  a shape that the behavioural census below does not know how to start. */
export interface BackgroundLoopContext {
  boss: PgBoss;
  db: Db;
  host: PluginHost;
  /** The process-wide shared CEL sandbox. Passed rather than re-fetched per loop, which is what
   *  makes "the gate loop shares the reconcile loop's sandbox" a fact of this file rather than a
   *  claim resting on `getSharedCelSandbox()` memoising. */
  sandbox: CelSandbox;
  config: ServerConfig;
}

export interface BackgroundLoopHandle {
  stop(): Promise<void>;
}

export interface BackgroundLoop {
  /** The capability an operator would recognise, used in failure messages and the boot log. */
  readonly name: string;
  /** The loop starter AS IMPORTED, kept alongside the adapter so a census can compare against the
   *  actual function object the module exports — a name string would be satisfied by a shadow. */
  readonly loop: (...args: never[]) => unknown;
  readonly start: (ctx: BackgroundLoopContext) => Promise<BackgroundLoopHandle>;
}

/**
 * Every background loop this process starts, in START ORDER — which is also STOP ORDER (see
 * {@link startBackgroundLoops}), byte-for-byte the order `main.ts` used before this extraction.
 */
export const BACKGROUND_LOOPS: readonly BackgroundLoop[] = [
  {
    // M3 coordination engine. See docs/server.md §16.
    name: "reconcile",
    loop: startReconcileLoop,
    start: (ctx) =>
      startReconcileLoop(ctx.boss, ctx.db, ctx.host, ctx.sandbox, ctx.config.secretsMasterKey)
  },
  {
    // CRITICAL #1 fix (PR #7 review): the stuck-change watchdog sweep (DESIGN.md §9.4) had no
    // production caller at all before this — scheduled the same way the reconcile loop is, one
    // queue per capability, both under the same background-work guard.
    name: "watchdog",
    loop: startWatchdogLoop,
    start: (ctx) => startWatchdogLoop(ctx.boss, ctx.db, ctx.host, ctx.config.secretsMasterKey)
  },
  {
    // M10.2 observe()-driver: the PULL side of change detection (webhook is push). Same
    // queue-per-capability pattern under the same guard; a much slower cadence.
    name: "observe",
    loop: startObserveLoop,
    start: (ctx) => startObserveLoop(ctx.boss, ctx.db, ctx.host, ctx.config.secretsMasterKey)
  },
  {
    // M13.1a staging-node inbox ingest (proposal §13.1): same queue-per-capability pattern under
    // the same guard — but DEFAULT-OFF (explicit `SCP_INBOX_LOOP=1` opt-in; without it this returns
    // an inert handle and never schedules a tick — an unconfigured instance does not spin).
    name: "federation inbox",
    loop: startInboxLoop,
    start: (ctx) => startInboxLoop(ctx.boss, ctx.db, ctx.config.secretsMasterKey)
  },
  {
    // M13.1b staging-node AUTO-RELAY (proposal §13.1). See docs/server.md §17.
    name: "retrans auto-relay",
    loop: startAutoRelayLoop,
    start: (ctx) => startAutoRelayLoop(ctx.boss, ctx.db, ctx.config.secretsMasterKey)
  },
  {
    // M14.0 outpost live-pull scheduler. See docs/server.md §18.
    name: "federation sync",
    loop: startFederationSyncLoop,
    start: (ctx) => startFederationSyncLoop(ctx.boss, ctx.db)
  },
  {
    // M21.4 third-party dependency version poll (ADR-0032 §7). See docs/server.md §19.
    name: "third-party version poll",
    loop: startDependencyVersionPollLoop,
    start: (ctx) => startDependencyVersionPollLoop(ctx.boss, ctx.db, ctx.host, ctx.config)
  },
  {
    // M21.4 internal release detection (ADR-0032 §7). See docs/server.md §20.
    name: "internal release detection",
    loop: startInternalReleaseLoop,
    start: (ctx) =>
      startInternalReleaseLoop(ctx.boss, { db: ctx.db, host: ctx.host, config: ctx.config })
  },
  {
    // M21.2 dependency-inventory ingestion (ADR-0032 §4/§6). See docs/server.md §21.
    name: "dependency-inventory ingestion",
    loop: startInventoryIngestionLoop,
    start: (ctx) =>
      startInventoryIngestionLoop(ctx.boss, { db: ctx.db, host: ctx.host, config: ctx.config })
  },
  {
    // M21.5 the bump dispatcher (ADR-0032 §8/§9) — the worker half of the advanced-line-head router,
    // and the thing that makes a dependency subscription DO anything. Commander-only and fail-closed
    // on an undeclared federation role, because it authors into a user's repository with a per-run
    // credential.
    name: "bump dispatch",
    loop: startBumpDispatchLoop,
    start: (ctx) =>
      startBumpDispatchLoop(ctx.boss, { db: ctx.db, host: ctx.host, config: ctx.config })
  },
  {
    // M21.5 the auto-merge link (ADR-0032 §8c). See docs/server.md §22.
    name: "auto-merge gate",
    loop: startBumpGateLoop,
    start: (ctx) =>
      startBumpGateLoop(ctx.boss, {
        db: ctx.db,
        host: ctx.host,
        sandbox: ctx.sandbox,
        config: ctx.config
      })
  },
  {
    // M25.8b the freeze re-drive (owner decision D8). See docs/server.md §23.
    name: "bump freeze redrive",
    loop: startBumpFreezeRedriveLoop,
    start: (ctx) => startBumpFreezeRedriveLoop(ctx.boss, ctx.db, ctx.config)
  }
];

/** Does THIS process own background work? See docs/server.md §24. */
export function runsBackgroundWork(config: Pick<ServerConfig, "role">): boolean {
  return config.role === "all" || config.role === "worker";
}

/** Does THIS process CREATE the bootstrap admin? See docs/server.md §25. */
export function createsBootstrapAdmin(config: Pick<ServerConfig, "role">): boolean {
  return config.role === "all" || config.role === "api";
}

/** Start every loop, and return one handle that stops them. See docs/server.md §26. */
export async function startBackgroundLoops(
  ctx: BackgroundLoopContext,
  loops: readonly BackgroundLoop[] = BACKGROUND_LOOPS
): Promise<BackgroundLoopHandle> {
  const started: BackgroundLoopHandle[] = [];
  for (const loop of loops) {
    started.push(await loop.start(ctx));
  }
  return {
    async stop() {
      for (const handle of started) {
        await handle.stop();
      }
    }
  };
}

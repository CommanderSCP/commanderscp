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

/**
 * ================================================================================================
 * THE BACKGROUND-WORK COMPOSITION — every loop this process starts, as an IMPORTABLE VALUE
 * ================================================================================================
 * This module exists for ONE reason: so that "the composition root starts the loops, and stops them
 * on shutdown" can be proven by RUNNING it instead of by matching text in `main.ts`.
 *
 * `main.ts` calls `main()` at module scope, so no test can import it. Every wiring claim about it
 * was therefore a substring match, and a substring match cannot tell a live call from a dead one.
 * That was not a theoretical weakness — it was measured, twice:
 *
 *   - commenting `startBumpDispatchLoop(…)` out of `main.ts` left `bump-dispatch.test.ts` green at
 *     20/20, INCLUDING a case named "starts the worker, and stops it on shutdown", and left the
 *     whole `apps/server` unit suite green at 972/972 (M21.7);
 *   - making the enclosing `if (runsBackgroundWork)` branch unreachable — a one-token edit — left
 *     ALL of `bump-dispatch`, `bump-gate`, `inventory-ingestion` and `domain-event-routers` green
 *     at 79/79, with all eleven loops dead. `domain-event-routers.test.ts` had named this exact
 *     mutation as a known-uncovered edge; it is closed by this module and no longer a text problem.
 *
 * This is the SAME MOVE M21.7 made for domain-event routers, and for the same reason: the router
 * list moved out of `main.ts` into `events/domain-event-registry.ts`, a pure importable value, and
 * its census went from matching four conditional registrations to executing one function. This is
 * that move for the eleven background loops. `background-work.test.ts` starts every entry below
 * against a probe `boss` and asserts what actually happened.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. The pg-boss handle, the outbox relay, the NATS fan-out and the
 * commander poke sender stay in `main.ts`. They are not loops: they are the substrate the loops run
 * on, they are constructed in a fixed order with interdependencies, and two of them need the raw
 * `Pool` rather than the `Db`. Moving them here would buy a bigger extraction and a worse one — the
 * registry's value is that every entry has the SAME shape, so a new loop cannot be added in a shape
 * the census does not check.
 *
 * ADDING A LOOP: add it to {@link BACKGROUND_LOOPS}. Nothing else. `background-work.test.ts`
 * discovers every `start…Loop` in the tree and fails if one is neither registered here nor
 * explicitly exempted with a reason, so forgetting this step is a red test rather than a capability
 * that silently never runs.
 */

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
    // M3 coordination engine (BUILD_AND_TEST.md §8 M3, DESIGN.md §9.3/§9.4): the resumable
    // reconciliation loop, over the plugin host. The shared fake-executor instance it relies on
    // (coordination/executor-config.ts documents why: M3 has no plugin-instance configuration API
    // yet) is registered there under this same role condition, with its state file under the OS
    // temp dir — durable across the plugin SUBPROCESS restarting (the plugin-host isolation DoD
    // scenario), not across this whole `scpd` process restarting, which is fine: fake-executor is
    // never a real system of record.
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
    // M13.1b staging-node AUTO-RELAY (proposal §13.1): the last operator-gated step of the CDS
    // boundary walk — a `role: retrans` instance builds the onward byte tarball for an imported
    // promotion with no operator command. DEFAULT-OFF behind its own explicit
    // `SCP_RETRANS_AUTO_RELAY=1` (unattended byte egress across a security boundary is opted into
    // separately from unattended INGEST; without it an inert handle, and the queue is never created).
    name: "retrans auto-relay",
    loop: startAutoRelayLoop,
    start: (ctx) => startAutoRelayLoop(ctx.boss, ctx.db, ctx.config.secretsMasterKey)
  },
  {
    // M14.0 outpost live-pull scheduler (docs/proposals/outpost-poke.md §"Milestone scope",
    // ADR-0009) — DEFAULT-OFF (explicit `SCP_FEDERATION_SYNC_LOOP=1` opt-in; without it an inert
    // handle, never a scheduled tick). The deferred federation-over-HTTP live-sync substrate the
    // poke increments (M14.1–M14.4) optimize; it pulls+imports commander config over the
    // fail-closed per-peer mTLS outbound dialer (federation-outbound.ts) and is the
    // sparse-safety-net + pull-on-startup reliability floor.
    name: "federation sync",
    loop: startFederationSyncLoop,
    start: (ctx) => startFederationSyncLoop(ctx.boss, ctx.db)
  },
  {
    // M21.4 third-party dependency version poll (ADR-0032 §7): same queue-per-capability pattern,
    // but with a SECOND, explicit guard on top of the background-work gate — `config.federationRole`
    // must be `commander`. An unguarded background job that dials package registries on a timer
    // would run on AIR-GAPPED OUTPOSTS too, and neither the process-role split nor any runtime
    // predicate would stop it (`self_domain.role` is per-org, lazy and advisory). The guard lives in
    // `dependencyVersionPollRoleGuard`, which returns an inert handle and never creates the queue
    // when it refuses — proven across the full config matrix in `commander-only.test.ts`.
    name: "third-party version poll",
    loop: startDependencyVersionPollLoop,
    start: (ctx) => startDependencyVersionPollLoop(ctx.boss, ctx.db, ctx.host, ctx.config)
  },
  {
    // M21.4 internal release detection (ADR-0032 §7) — the worker half of a domain-event router.
    // Event-driven rather than a timer, because a release IS an event. COMMANDER-ONLY, like every
    // dependency job (ADR-0032 §7d, owner decision 2026-08-17): a FIELD outpost never ORIGINATES a
    // dependency bump — it receives the resulting change down the global pipeline the commander
    // manages — so it derives no inventory and detects no releases for this feature. ("Field" is
    // load-bearing: an HQ outpost is the outpost in the commander's OWN trust domain, which is this
    // process — see `dependencies/commander-only.ts`, which reads that out of the code.) The loop's
    // module doc carries the accepted cost: an internal line released only at a FIELD outpost keeps
    // a NULL head, which §7 defines as "not observed", never "nothing newer exists".
    name: "internal release detection",
    loop: startInternalReleaseLoop,
    start: (ctx) =>
      startInternalReleaseLoop(ctx.boss, { db: ctx.db, host: ctx.host, config: ctx.config })
  },
  {
    // M21.2 dependency-inventory ingestion (ADR-0032 §4/§6) — the worker half of the ingestion
    // router. THIS IS WHAT WRITES `component_dependencies`: without it the table is empty on every
    // deployment and the enablement chain, the version poll and internal detection all resolve over
    // nothing. Same role answer as internal detection and the poll — COMMANDER-ONLY (ADR-0032 §7d).
    // Accepted consequence, in the loop's module doc: dependencies declared in FIELD-outpost-only
    // repositories are out of scope for dependency subscriptions.
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
    // M21.5 the auto-merge link (ADR-0032 §8c) — runs the EXISTING governance gate FOR a bump change
    // once its own commit has been observed back, then merges only if a governed control evidenced
    // the component's own checks passed for exactly that commit. It takes `ctx.sandbox`, the SAME
    // object the reconcile loop above was handed, which is what makes "the same gate machinery"
    // literally the same — previously two `getSharedCelSandbox()` calls that happened to memoise.
    name: "auto-merge gate",
    loop: startBumpGateLoop,
    start: (ctx) =>
      startBumpGateLoop(ctx.boss, {
        db: ctx.db,
        host: ctx.host,
        sandbox: ctx.sandbox,
        config: ctx.config
      })
  }
];

/**
 * Does THIS process own background work?
 *
 * Extracted from `main.ts`'s inline `config.role === "all" || config.role === "worker"` so the
 * predicate is importable and therefore testable. The inline version was the subject of the
 * measured mutation above: setting it `false` killed all eleven loops with a fully green suite,
 * because no test could reach it.
 *
 * `role === "api"` is a pure request server for everything EXCEPT request-scoped plugin dispatch —
 * `main.ts` constructs the plugin host for every role (#200), and that is deliberately NOT gated on
 * this.
 */
export function runsBackgroundWork(config: Pick<ServerConfig, "role">): boolean {
  return config.role === "all" || config.role === "worker";
}

/**
 * Start every loop in `loops`, and return one handle that stops them all.
 *
 * SEQUENTIAL, IN ORDER, AND `stop()` STOPS IN THE SAME ORDER — preserving exactly what `main.ts`'s
 * hand-written `onClose` did. Neither start nor stop swallows an error, also as before: a loop that
 * throws on the way up fails boot loudly, and one that throws on the way down surfaces rather than
 * being hidden behind the loops after it.
 *
 * `loops` is a parameter with a production default so a test can drive this with its own table
 * (proving the runner) as well as with the real one (proving the wiring). The default is what
 * `main.ts` gets, so the test and production share one code path rather than resembling each other.
 */
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

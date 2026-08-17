import type { ServerConfig } from "../config.js";
import {
  acceptedChangeRouter,
  internalReleaseDetectionRoleGuard
} from "../dependencies/internal-release-loop.js";
import {
  inventoryIngestionRouter,
  inventoryIngestionRoleGuard
} from "../dependencies/inventory-ingestion-loop.js";
import { advancedLineHeadRouter, bumpDispatchRoleGuard } from "../dependencies/bump-dispatch.js";
import { observedBumpRouter } from "../dependencies/bump-gate.js";
import type { DomainEventRouter } from "./pgboss.js";

/**
 * ================================================================================================
 * THE ONE REGISTRATION SITE FOR DOMAIN-EVENT ROUTERS
 * ================================================================================================
 * `boss.work()` is a COMPETING consumer, so a capability that reacts to a domain event registers a
 * {@link DomainEventRouter} here rather than a second worker on `domain-events` (see that type's
 * doc for the whole argument). This table is what `main.ts` hands to `startPgBoss`.
 *
 * WHY THIS IS A MODULE AND NOT AN ARRAY LITERAL IN `main.ts`, which is where it lived until M21.7:
 * `main.ts` calls `main()` at module scope, so nothing can import it, so nothing could ever assert
 * what it actually registers. The census that guarded this list therefore read main.ts as TEXT —
 * and a text census passes on a registration that is present but UNREACHABLE. An inverted guard
 * (`allowed ? [] : [router()]`) is invisible to it: the factory name is still right there in the
 * source. Moving the list into an importable, side-effect-free value makes the registration a
 * VALUE a test can execute, which is what `domain-event-routers.test.ts` now does.
 *
 * WHY EACH ENTRY PAIRS THE FACTORY WITH ITS GUARD instead of the old per-router conditional: with
 * one conditional per router there were four places to invert and four places to mis-bind (wire
 * router A's line to router B's guard). Here there is ONE filter, applied uniformly, and the guard
 * a router runs under sits in the same object literal as the router — so a mis-binding is visible
 * in one line rather than spread across a `?:` chain, and the single filter is covered by a
 * config-independent invariant the test asserts directly (an `api` process registers nothing).
 *
 * A REFUSED GUARD CONTRIBUTES NO ROUTER, deliberately: an event must not be enqueued onto a queue
 * that this process will never drain, because the worker half is refused by the same guard.
 */

/** The union of every axis any router's guard reads. Guards themselves take narrower `Pick`s. */
export type RouterGuardConfig = Pick<
  ServerConfig,
  "role" | "federationRole" | "federationRoleDeclared"
>;

/** What a guard answers, structurally — each capability declares its own verdict type with a
 *  capability-specific `reason`, and this is the shape they all share. */
export interface RouterGuardVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

export interface RouterRegistration {
  /** The factory AS IMPORTED. Stored as the function itself, never as a name string, so the census
   *  compares identity: a wrapper (`() => acceptedChangeRouter()`), an alias bound to something
   *  else, or a lookalike defined locally is a DIFFERENT function object, and fails. */
  readonly factory: () => DomainEventRouter;
  /** MAY THIS PROCESS RUN IT? Same guard the capability's worker half consults, by import rather
   *  than by copy — a router registered on a process whose worker is refused would enqueue onto a
   *  queue nothing drains. */
  readonly guard: (config: RouterGuardConfig) => RouterGuardVerdict;
}

/**
 * Every domain-event router in the tree, exactly once. `domain-event-routers.test.ts` proves that
 * sentence rather than asserting it: the set of routers is discovered from the filesystem and
 * compared against this table by function identity, so a router built and never added here fails,
 * and one added twice fails.
 */
export const DOMAIN_EVENT_ROUTERS: readonly RouterRegistration[] = [
  // M21.4 (ADR-0032 §7) internal release detection — the FIRST consumer of the domain-event stream.
  // COMMANDER-ONLY (ADR-0032 §7d, owner decision 2026-08-17); this comment previously said it ran on
  // every federation role, deliberately. An outpost never ORIGINATES a dependency bump — it receives
  // the resulting change down the global pipeline the commander manages — so it derives nothing here.
  { factory: acceptedChangeRouter, guard: internalReleaseDetectionRoleGuard },
  // M21.2 (ADR-0032 §4/§6) dependency-inventory ingestion — the SECOND router on the same event.
  // Routers do not compete: the domain-events worker calls every router for every event and each
  // enqueues onto its OWN queue, so a slow manifest read cannot starve internal detection.
  { factory: inventoryIngestionRouter, guard: inventoryIngestionRoleGuard },
  // M21.5 (ADR-0032 §8) the bump dispatcher — a line's head advancing is what makes a bump due.
  // Commander-only, and derived rather than copied (see `bumpDispatchRoleGuard`): this job writes to
  // a source repository with a credential, which an air-gapped or high-side outpost must never do.
  // It USED to be the strictest guard in the table, because internal detection ran on every role and
  // so heads advanced at outposts; since ADR-0032 §7d (2026-08-17) every dependency job reaches the
  // same verdict, and this one's reason is still its own rather than inherited.
  { factory: advancedLineHeadRouter, guard: bumpDispatchRoleGuard },
  // M21.5 (ADR-0032 §8c) the auto-merge link. Its trigger is an observed provider event that
  // correlated to a bump SCP authored — the authored push, then the CI conclusion on that same
  // commit. Same guard as the dispatcher's, by IMPORT rather than by copy: merging is a repository
  // write, and a strictly more consequential one than opening a pull request.
  { factory: observedBumpRouter, guard: bumpDispatchRoleGuard }
];

/**
 * The routers THIS process registers. Pure: no I/O, no side effects — which is what lets a unit
 * test call it for a matrix of configs and assert what is actually registered, rather than reading
 * the composition root's source and hoping the text means what it looks like.
 */
export function domainEventRouters(config: RouterGuardConfig): DomainEventRouter[] {
  return DOMAIN_EVENT_ROUTERS.filter((registration) => registration.guard(config).allowed).map(
    (registration) => registration.factory()
  );
}

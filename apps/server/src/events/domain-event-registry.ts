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

/** The one registration site for domain-event routers. See docs/events.md §1. */

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

/** Every domain-event router in the tree, exactly once. See docs/events.md §2. */
export const DOMAIN_EVENT_ROUTERS: readonly RouterRegistration[] = [
  // M21.4 (ADR-0032 §7) internal release detection. See docs/events.md §3.
  { factory: acceptedChangeRouter, guard: internalReleaseDetectionRoleGuard },
  // M21.2 (ADR-0032 §4/§6) dependency-inventory ingestion — the SECOND router on the same event.
  // Routers do not compete: the domain-events worker calls every router for every event and each
  // enqueues onto its OWN queue, so a slow manifest read cannot starve internal detection.
  { factory: inventoryIngestionRouter, guard: inventoryIngestionRoleGuard },
  // M21.5 (ADR-0032 §8) the bump dispatcher. See docs/events.md §4.
  { factory: advancedLineHeadRouter, guard: bumpDispatchRoleGuard },
  // M21.5 (ADR-0032 §8c) the auto-merge link. Its trigger is an observed provider event that
  // correlated to a bump SCP authored — the authored push, then the CI conclusion on that same
  // commit. Same guard as the dispatcher's, by IMPORT rather than by copy: merging is a repository
  // write, and a strictly more consequential one than opening a pull request.
  { factory: observedBumpRouter, guard: bumpDispatchRoleGuard }
];

/** The routers THIS process registers. Pure: no I/O, no side effects. See docs/events.md §5. */
export function domainEventRouters(config: RouterGuardConfig): DomainEventRouter[] {
  return DOMAIN_EVENT_ROUTERS.filter((registration) => registration.guard(config).allowed).map(
    (registration) => registration.factory()
  );
}

import PgBoss from "pg-boss";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

/** A SELF-RESCHEDULING LOOP'S STARTUP KICK IS SENT **UNKEYED**. See docs/events.md §41. */
export const LOOP_STARTUP_SEND_IS_UNKEYED = true;

/** One relayed outbox row, typed as the relay writes it. See docs/events.md §42. */
export interface DomainEventJob {
  id: string;
  orgId: string;
  type: string;
  source?: string;
  subject?: string | null;
  data?: unknown;
}

/** A SUBSCRIBER TO THE DOMAIN-EVENT STREAM. See docs/events.md §43. */
export interface DomainEventRouter {
  /** For logs only. */
  readonly name: string;
  /** The capability queue this router enqueues onto. Created before any event can be routed. */
  readonly queue: string;
  /** Enqueue if this event is one this capability reacts to; do nothing otherwise. */
  route(boss: PgBoss, event: DomainEventJob): Promise<void>;
}

/** Thrown when a routers list registers the same one twice. See docs/events.md §44. */
export class DuplicateRouterRegistrationError extends Error {
  /** Router `name`s that appear more than once in the list. */
  readonly duplicateNames: readonly string[];
  /** `[queue, [name, name, …]]` for queues claimed by more than one distinct router. */
  readonly sharedQueues: readonly (readonly [string, readonly string[]])[];

  constructor(
    duplicateNames: readonly string[],
    sharedQueues: readonly (readonly [string, readonly string[]])[]
  ) {
    super(
      "domain-event routers registered more than once — " +
        `duplicate names: [${duplicateNames.join(", ")}]; ` +
        `queues claimed by several routers: [${sharedQueues
          .map(([queue, names]) => `${queue} <- ${names.join("+")}`)
          .join(", ")}]`
    );
    this.name = "DuplicateRouterRegistrationError";
    this.duplicateNames = duplicateNames;
    this.sharedQueues = sharedQueues;
  }
}

/** Refuse a double registration at boot, since it is silent. See docs/events.md §45. */
export function assertRoutersRegisteredOnce(routers: readonly DomainEventRouter[]): void {
  const nameCounts = new Map<string, number>();
  for (const router of routers) {
    nameCounts.set(router.name, (nameCounts.get(router.name) ?? 0) + 1);
  }
  const duplicateNames = [...nameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  const queueClaims = new Map<string, string[]>();
  for (const router of routers) {
    const claimants = queueClaims.get(router.queue) ?? [];
    if (!claimants.includes(router.name)) claimants.push(router.name);
    queueClaims.set(router.queue, claimants);
  }
  const sharedQueues = [...queueClaims.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([queue, names]) => [queue, names] as const);

  if (duplicateNames.length > 0 || sharedQueues.length > 0) {
    throw new DuplicateRouterRegistrationError(duplicateNames, sharedQueues);
  }
}

/** pg-boss worker skeleton. See docs/events.md §46. */
export async function startPgBoss(
  databaseUrl: string,
  routers: readonly DomainEventRouter[] = []
): Promise<PgBoss> {
  // BEFORE the connection, deliberately: a double registration is a wiring defect, and a wiring
  // defect should fail without having touched the database. See the function's own doc.
  assertRoutersRegisteredOnce(routers);
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err) => {
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue(DOMAIN_EVENTS_QUEUE);
  // BEFORE the worker below, never after: a router must never be handed an event whose destination
  // queue does not exist yet.
  for (const router of routers) {
    await boss.createQueue(router.queue);
  }
  await boss.work<DomainEventJob>(DOMAIN_EVENTS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      console.log(
        `[worker] ${DOMAIN_EVENTS_QUEUE}: ${job.data.type} (org=${job.data.orgId} event=${job.data.id})`
      );
      for (const router of routers) {
        try {
          await router.route(boss, job.data);
        } catch (err) {
          console.error(
            `[worker] ${DOMAIN_EVENTS_QUEUE}: router '${router.name}' failed for event ${job.data.id} (${job.data.type}):`,
            err
          );
        }
      }
    }
  });
  return boss;
}

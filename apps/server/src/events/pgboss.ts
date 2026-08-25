import PgBoss from "pg-boss";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

/**
 * A SELF-RESCHEDULING LOOP'S STARTUP KICK IS SENT **UNKEYED**. It must ALWAYS insert.
 *
 * This is the second correction to §4-A4, and the reason is that pg-boss gives standard-policy
 * queues exactly one singleton index and it is the wrong shape for a startup kick
 * (pg-boss 10.4.2, `src/plans.js`):
 *
 *   job_i4 ON (name, singleton_on, COALESCE(singleton_key,'')) WHERE state <> 'cancelled'
 *                                                                AND singleton_on IS NOT NULL
 *
 * Three consequences, all measured:
 *   - it applies ONLY when `singletonSeconds` is supplied (`singleton_on IS NOT NULL`), so a
 *     `singletonKey` alone constrains nothing on these queues — "keyed but no window" is just an
 *     unkeyed send wearing a key;
 *   - it counts COMPLETED jobs as still holding the slot, and `singleton_on` is a wall-clock BUCKET,
 *     so ANY window can swallow a later send — the window size only changes the odds;
 *   - a losing insert is `ON CONFLICT DO NOTHING RETURNING id`: it returns NULL **silently**.
 *
 * A self-rescheduling loop's only other tick source is the reschedule inside its own handler, so one
 * swallowed kick means no job -> no handler -> no reschedule -> **the loop is dead forever**, with no
 * error, no log, and no failing health check. A4 first shipped the kick sharing the chain's `"tick"`
 * key, which killed the 60s loops after a single sweep on ~58 of every 60 boots. Moving it to its own
 * key + a 10s window fixed that and then broke CRASH RESUMPTION instead: a worker that dies mid-tick
 * (so the chain never rescheduled) and restarts inside the window had its kick swallowed by its OWN
 * previous boot, and came back dead. Measured as `coordination.integration.test.ts`'s crash-resumption
 * test timing out waiting for a change to reach `validating` after a worker restart.
 *
 * SO: no key, no window — the kick always inserts, and the loop always lives. What this gives up is
 * A4's stated goal, N replicas booting together collapsing to ONE startup sweep; that was always an
 * EFFICIENCY optimisation, and the redundant sweeps are safe (every sweep claims its rows with
 * `FOR UPDATE SKIP LOCKED` / per-row advisory locks, which is what makes N competing workers correct
 * in the first place). Trading a liveness guarantee for it was the wrong bargain in both directions.
 * `dependencies/bump-freeze-redrive.ts` has always sent unkeyed; it is now the shape for all of them.
 * `coordination/loop-startup-singleton.test.ts` is the census that keeps it true.
 *
 * (Historical note, kept because it is the rule that was violated twice: the interval chain owns
 * `"tick"`, and `federation/federation-sync.ts` — whose startup pull is an OPTIMISATION over a due-gate
 * rather than the loop's only lifeline — documents its own distinct key for the same collision reason.)
 *
 * WHY REUSING `"tick"` IS FATAL, in pg-boss's own terms (pg-boss 10.4.2, src/plans.js):
 *   - the unique index is `(name, singleton_on, COALESCE(singleton_key,''))` WHERE `state <>
 *     'cancelled'` — so a COMPLETED or ACTIVE job STILL HOLDS the slot;
 *   - `singleton_on` is a wall-clock BUCKET (`floor(epoch/singletonSeconds)*singletonSeconds`), not
 *     "time since the last job";
 *   - a losing insert is `ON CONFLICT DO NOTHING RETURNING id`, i.e. it returns NULL **silently**.
 * A self-rescheduling loop's ONLY other source of ticks is the reschedule inside its own worker
 * handler, so one swallowed send means: no job -> no handler -> no reschedule -> the loop is dead
 * forever, with no error, no log and no failing health check.
 *
 * MEASURED: a 60s loop's first reschedule (sent ~2s after its startup job, inside the SAME 60s
 * bucket) was swallowed by that just-completed startup job — killing the loop after ONE sweep on
 * ~58 of every 60 boots, in production as well as in tests.
 *
 * A DISTINCT key with a SHORT window keeps what §4-A4 actually wanted — N replicas booting together
 * dedupe their startup sweeps among themselves — while making a collision with the interval chain
 * impossible. `federation/federation-sync.ts` established this shape first
 * (`FEDERATION_SYNC_STARTUP_SINGLETON_SECONDS`) and its doc already warned that `"tick"` was off
 * limits; these constants are that rule, hoisted to where every loop can see it.
 * `coordination/loop-startup-singleton.test.ts` is the census that keeps it true.
 */
export const LOOP_STARTUP_SEND_IS_UNKEYED = true;

/**
 * One relayed outbox row, as the outbox relay sends it onto {@link DOMAIN_EVENTS_QUEUE}
 * (`events/outbox-relay.ts`). Fields are typed as what the relay writes; `data` stays `unknown`
 * because every event type carries its own payload and a router must narrow its own.
 */
export interface DomainEventJob {
  id: string;
  orgId: string;
  type: string;
  source?: string;
  subject?: string | null;
  data?: unknown;
}

/**
 * A SUBSCRIBER TO THE DOMAIN-EVENT STREAM — and the reason this seam exists at all.
 *
 * `boss.work()` is a COMPETING consumer: a second `work()` call on {@link DOMAIN_EVENTS_QUEUE} does
 * not add a second listener, it splits the jobs between the two handlers at random. So a feature
 * that needs to react to a domain event cannot simply register its own worker on this queue — it
 * would steal roughly half the events from whoever else is on it and receive roughly half of its
 * own. That is why, until M21.4, this queue's handler only logged and NOTHING in the tree consumed
 * a domain event: there was no way to add one without that hazard.
 *
 * A router is the fan-out point instead. It is deliberately NOT where the work happens: it makes
 * one cheap decision ("is this event mine?") and, if so, enqueues onto the CAPABILITY'S OWN QUEUE —
 * the one-queue-per-capability shape every background loop in `main.ts` already uses. Doing the work
 * inline here would put a feature's latency and its retry budget on the shared event stream: one
 * slow git fetch would hold up every other event in the instance, and one poison event would burn
 * the domain-event queue's retries rather than its own.
 *
 * `queue` is declared so {@link startPgBoss} can create it BEFORE the domain-events worker starts —
 * otherwise the very first event could be routed to a queue that does not exist yet.
 */
export interface DomainEventRouter {
  /** For logs only. */
  readonly name: string;
  /** The capability queue this router enqueues onto. Created before any event can be routed. */
  readonly queue: string;
  /** Enqueue if this event is one this capability reacts to; do nothing otherwise. */
  route(boss: PgBoss, event: DomainEventJob): Promise<void>;
}

/**
 * Thrown when a routers list registers the same subscriber twice, or hands two different
 * subscribers the same destination queue. Carries the offending identifiers as DATA rather than
 * only in the message, so a caller (and a test) can assert WHICH registration is duplicated instead
 * of matching prose.
 */
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

/**
 * REFUSE A DOUBLE REGISTRATION AT BOOT, because it is otherwise SILENT.
 *
 * The domain-events worker calls every router for every event, so a router listed twice enqueues
 * TWICE per event onto its capability's queue — and `boss.work()` on that queue is a COMPETING
 * consumer, so the second copy is not deduplicated, it is picked up and the capability's work runs
 * again. None of pg-boss's machinery complains: no error, no warning, just a queue with double the
 * traffic and jobs that fire twice.
 *
 * This is not a hypothetical. During M21's build a rebase put `acceptedChangeRouter()` on BOTH sides
 * of a conflict in the registration array (then a literal in `main.ts`, now
 * `events/domain-event-registry.ts`); concatenating the two sides — the naive resolution — would
 * have shipped exactly that. The protection at the time was a code comment saying "every entry
 * below appears exactly once", which is a claim, not a check. This is the check. It runs BEFORE any
 * connection is opened so that a misregistration fails the process immediately and cheaply, rather
 * than after the first event has already been double-routed.
 *
 * Two different routers sharing one `queue` is the same defect wearing a different hat: that queue
 * has ONE worker, owned by one capability, expecting one job shape — so the other router's jobs are
 * either mis-shaped or a second enqueue of the first's work.
 */
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

/**
 * pg-boss worker skeleton (DESIGN.md §8, BUILD_AND_TEST.md §8 M1 item 7): durable job queue over
 * Postgres, proving the outbox → job pipeline flows end to end.
 *
 * `databaseUrl` is the schema-scoped `scp_pgboss` login role's connection string
 * (config.pgBossDatabaseUrl — M3 tracked security follow-up, drizzle/0008_pgboss_role.sql), not
 * the admin/superuser URL. `schema: "pgboss"` is passed explicitly rather than relying on
 * pg-boss's own default (verified to also be `"pgboss"` in the installed version's
 * src/plans.js#DEFAULT_SCHEMA) — the migration's schema name and pg-boss's own must always agree,
 * and an explicit option here can't silently drift from a future pg-boss upgrade's default.
 *
 * `routers` (M21.4) are the real subscribers — see {@link DomainEventRouter} for why they are
 * routers rather than additional `work()` registrations. A router throwing does NOT stop the batch:
 * every router is isolated per event, because one capability's enqueue failing must not make the
 * shared event stream redeliver events to every OTHER capability. The failure is logged loudly with
 * the event id, and the capability's own recovery is that its work is a DERIVATION — re-running it
 * for a later event of the same subject reaches the same answer.
 */
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

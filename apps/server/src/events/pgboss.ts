import PgBoss from "pg-boss";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

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

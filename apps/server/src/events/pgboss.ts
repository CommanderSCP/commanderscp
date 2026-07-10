import PgBoss from "pg-boss";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

/**
 * pg-boss worker skeleton (DESIGN.md §8, BUILD_AND_TEST.md §8 M1 item 7): durable job queue over
 * Postgres, proving the outbox → job pipeline flows end to end. The handler here only logs
 * receipt — M3's coordination engine is the first real subscriber to this queue.
 *
 * `databaseUrl` is the schema-scoped `scp_pgboss` login role's connection string
 * (config.pgBossDatabaseUrl — M3 tracked security follow-up, drizzle/0008_pgboss_role.sql), not
 * the admin/superuser URL. `schema: "pgboss"` is passed explicitly rather than relying on
 * pg-boss's own default (verified to also be `"pgboss"` in the installed version's
 * src/plans.js#DEFAULT_SCHEMA) — the migration's schema name and pg-boss's own must always agree,
 * and an explicit option here can't silently drift from a future pg-boss upgrade's default.
 */
export async function startPgBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err) => {
    console.error("[pg-boss] error", err);
  });
  await boss.start();
  await boss.createQueue(DOMAIN_EVENTS_QUEUE);
  await boss.work<{ id: string; orgId: string; type: string }>(
    DOMAIN_EVENTS_QUEUE,
    async (jobs) => {
      for (const job of jobs) {
        console.log(
          `[worker] ${DOMAIN_EVENTS_QUEUE}: ${job.data.type} (org=${job.data.orgId} event=${job.data.id})`
        );
      }
    }
  );
  return boss;
}

import PgBoss from "pg-boss";

export const DOMAIN_EVENTS_QUEUE = "domain-events";

/**
 * pg-boss worker skeleton (DESIGN.md §8, BUILD_AND_TEST.md §8 M1 item 7): durable job queue over
 * Postgres, proving the outbox → job pipeline flows end to end. The handler here only logs
 * receipt — M3's coordination engine is the first real subscriber to this queue.
 */
export async function startPgBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss(databaseUrl);
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

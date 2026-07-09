import pg from "pg";
import type PgBoss from "pg-boss";
import { sseHub } from "./sse-hub.js";
import { DOMAIN_EVENTS_QUEUE } from "./pgboss.js";

const { Client } = pg;
type Pool = pg.Pool;

const POLL_INTERVAL_MS = 1000; // air-gap-proof fallback (DESIGN.md §8) when NOTIFY is missed
const BATCH_SIZE = 100;

export interface OutboxRelayHandle {
  stop(): Promise<void>;
}

interface OutboxRow {
  id: string;
  org_id: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  created_at: Date;
}

/**
 * Worker-side half of the transactional outbox (DESIGN.md §8): claims unprocessed rows with
 * `FOR UPDATE SKIP LOCKED` (safe under multiple worker replicas), relays each to the pg-boss
 * `domain-events` queue and to any connected SSE clients for that org, then marks it processed —
 * all in one transaction per batch. Wakes immediately on the `scp_outbox_insert` NOTIFY
 * (drizzle/0002_rls_rbac_seed.sql's trigger fires post-commit) with a 1s poll as the fallback.
 *
 * Runs against the admin connection pool (not `withTenantTx`/`scp_app`) deliberately: this is an
 * internal system process relaying every org's events, not a tenant-facing API request, so it
 * needs cross-org visibility the RLS-restricted app role is designed to never have.
 */
export function startOutboxRelay(adminPool: Pool, listenConnectionString: string, boss: PgBoss): OutboxRelayHandle {
  let stopped = false;

  async function relayOnce(): Promise<void> {
    if (stopped) return;
    const client = await adminPool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<OutboxRow>(
        `SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      for (const row of rows) {
        await boss.send(DOMAIN_EVENTS_QUEUE, {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data
        });
        sseHub.publish({
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data,
          createdAt: row.created_at.toISOString()
        });
        await client.query(`UPDATE outbox SET processed_at = now() WHERE id = $1`, [row.id]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[outbox-relay] relay batch failed", err);
    } finally {
      client.release();
    }
  }

  const listenClient = new Client({ connectionString: listenConnectionString });
  listenClient
    .connect()
    .then(async () => {
      await listenClient.query("LISTEN scp_outbox_insert");
      listenClient.on("notification", () => {
        void relayOnce();
      });
    })
    .catch((err: unknown) => console.error("[outbox-relay] LISTEN setup failed", err));
  listenClient.on("error", (err) => console.error("[outbox-relay] LISTEN connection error", err));

  const timer = setInterval(() => void relayOnce(), POLL_INTERVAL_MS);
  void relayOnce();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listenClient.end().catch(() => undefined);
    }
  };
}

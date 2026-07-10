import pg from "pg";
import type PgBoss from "pg-boss";
import { sseHub } from "./sse-hub.js";
import { DOMAIN_EVENTS_QUEUE } from "./pgboss.js";
import type { NatsFanoutHandle } from "./nats-fanout.js";

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
 * The relay legitimately needs cross-org visibility (it fans out every org's events), but gets
 * it through the narrowest possible mechanism (PR #4 security review, CRITICAL 3): it runs on
 * the least-privileged runtime pool (`scp_app` login) and assumes the `scp_relay` role with
 * `SET LOCAL ROLE` inside each transaction. `scp_relay` (drizzle/0003_runtime_roles.sql) is
 * NOBYPASSRLS and is granted ONLY on `outbox` (SELECT + UPDATE, with a permissive policy on
 * that one table) — it cannot read or write objects/relationships/role_bindings/audit_events.
 *
 * `eventBusBackend` (DESIGN.md §8 "Scaling insurance", BUILD_AND_TEST.md M3 item 8) is the NATS
 * JetStream backend toggle: `"postgres"` (the default) means this relay behaves exactly as it
 * always has (pg-boss + SSE only, zero new dependency). `"nats"` means every row is ALSO
 * republished to JetStream, in the same per-row step as the pg-boss send and the SSE publish — if
 * it throws, the whole batch transaction rolls back and the row is retried on the next
 * NOTIFY/poll, exactly like a pg-boss `send` failure already does today. `EventBus.publish()`
 * itself (events/event-bus.ts) is unchanged for both backends: it only ever writes the outbox row,
 * because write-then-publish atomicity is a Postgres-transaction property no broker can join —
 * the backend distinction lives entirely here, in what the relay fans out to.
 *
 * CRITICAL #5 fix (PR #7 review — "relay can permanently drop a NATS-bound event"): the OLD
 * signature took an optional `natsFanout` handle and gated the JetStream publish on whether that
 * PARTICULAR handle happened to be truthy (`if (natsFanout)`), with nothing tying that to the
 * deployment's actually-configured backend. A relay instance constructed without a `natsFanout`
 * handle — a misconfiguration, a partial rollout, a caller that simply forgot — could win an
 * outbox row via `FOR UPDATE SKIP LOCKED`, silently skip the NATS publish, mark the row
 * `processed_at`, and commit: the event is gone from JetStream forever, with no error anywhere.
 * `eventBusBackend` makes the intended backend an explicit, required argument instead of an
 * inferred side-effect of whether a handle happens to be present — and the constructor below
 * throws immediately if they're inconsistent (`"nats"` with no handle), turning that
 * misconfiguration into a loud boot-time failure instead of a silent per-row data loss. Within one
 * relay instance this is now airtight: `processed_at` is set only after every one of ITS
 * configured sinks (pg-boss, SSE, and — when `eventBusBackend === "nats"` — JetStream) has
 * accepted the row; any sink throwing rolls back the whole batch and the row is retried.
 *
 * Tracked follow-up (same idiom as the pg-boss-role / OIDC-allowlist items in
 * BUILD_AND_TEST.md §8 M3 item 9): this does NOT yet detect two DIFFERENT relay processes sharing
 * one outbox table with genuinely inconsistent `SCP_EVENT_BUS_BACKEND` config across replicas —
 * that needs a small persisted "this deployment's backend is X" marker checked at every relay's
 * boot, which is real scope (a migration + a cross-replica agreement check) beyond this fix. Single
 * -process behavior (main.ts boots exactly one relay per `role=worker/all` process, from exactly
 * one `config.eventBus.backend`) is airtight today; multi-replica config drift is an operator
 * misconfiguration this doesn't yet turn into a startup error.
 */
export function startOutboxRelay(
  runtimePool: Pool,
  listenConnectionString: string,
  boss: PgBoss,
  opts: { eventBusBackend: "postgres" | "nats"; natsFanout?: NatsFanoutHandle }
): OutboxRelayHandle {
  const { eventBusBackend, natsFanout } = opts;
  if (eventBusBackend === "nats" && !natsFanout) {
    throw new Error(
      "startOutboxRelay: eventBusBackend 'nats' requires a connected natsFanout handle — refusing " +
        "to start a relay that could mark NATS-bound events processed without ever publishing them"
    );
  }
  let stopped = false;
  // Tracks every relayOnce() call currently in flight (there can be more than one: the 1s poll
  // timer, the LISTEN/NOTIFY handler, and the initial kick-off below all fire independently — see
  // `trigger()`). `stop()` awaits this set before returning, which is the actual fix for a real
  // shutdown-race bug: without it, a caller that calls `stop()` then immediately closes
  // `runtimePool` (main.ts's onClose hook, test-support/harness.ts's close()) could tear down the
  // pool out from under a relayOnce() that was still mid-query, producing
  // "TypeError: Cannot destructure property 'rows' of ... as it is undefined" — `client.query()`
  // resolving to `undefined` instead of rejecting, a rare-but-real pg behavior when the
  // connection is destroyed mid-flight. See the defensive `result?.rows` guard below too — belt
  // and braces, since ordering discipline alone can't prove every possible teardown interleaving.
  const inFlight = new Set<Promise<void>>();

  async function relayOnce(): Promise<void> {
    if (stopped) return;
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE scp_relay");
      const result = await client.query<OutboxRow>(
        `SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      // Defensive guard (see `inFlight` doc comment above): a client torn down mid-query by pool
      // shutdown has been observed to resolve `query()` with `undefined` rather than rejecting.
      // Treat that as "no rows this pass" instead of crashing — nothing is lost, since the
      // row(s) are simply left unprocessed and picked up by the next relayOnce() (or, if the
      // process really is shutting down, by the relay after restart).
      const rows = result?.rows ?? [];
      for (const row of rows) {
        await boss.send(DOMAIN_EVENTS_QUEUE, {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data
        });
        const relayedEvent = {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data,
          createdAt: row.created_at.toISOString()
        };
        sseHub.publish(relayedEvent);
        if (eventBusBackend === "nats") {
          // `natsFanout` is guaranteed defined here — asserted at construction above — so this can
          // never silently no-op the way the old `if (natsFanout)` check could.
          await natsFanout!.publish(relayedEvent);
        }
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

  /** Fires relayOnce() and tracks it in `inFlight` so `stop()` can await it — every trigger
   *  source (NOTIFY, the poll timer, the initial kick-off) goes through this instead of calling
   *  relayOnce() directly. Synchronous up to its `stopped` check, so once `stop()` sets `stopped`
   *  no new relayOnce() can start afterward (JS's single-threaded run-to-completion semantics: no
   *  interleaving is possible between `stop()`'s synchronous prefix and any event-loop callback
   *  that calls `trigger()`). */
  function trigger(): void {
    if (stopped) return;
    const call = relayOnce().finally(() => {
      inFlight.delete(call);
    });
    inFlight.add(call);
  }

  const listenClient = new Client({ connectionString: listenConnectionString });
  listenClient
    .connect()
    .then(async () => {
      await listenClient.query("LISTEN scp_outbox_insert");
      listenClient.on("notification", () => {
        trigger();
      });
    })
    .catch((err: unknown) => console.error("[outbox-relay] LISTEN setup failed", err));
  listenClient.on("error", (err) => console.error("[outbox-relay] LISTEN connection error", err));

  const timer = setInterval(() => trigger(), POLL_INTERVAL_MS);
  trigger();

  return {
    /**
     * Stops the relay deterministically: no new relayOnce() can start after this is called, AND
     * every already-in-flight relayOnce() has settled by the time this resolves. Callers
     * (main.ts's onClose hook, test-support/harness.ts's close()) rely on that ordering to close
     * `runtimePool` immediately afterward without racing a query against a torn-down client —
     * this is what actually fixes the shutdown-race bug described on `inFlight` above; the
     * `result?.rows` guard in relayOnce() is the belt-and-braces backstop for any interleaving
     * this ordering doesn't cover.
     */
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listenClient.end().catch(() => undefined);
      await Promise.allSettled(inFlight);
    }
  };
}

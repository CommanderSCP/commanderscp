import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { connect } from "@nats-io/transport-node";
import { jetstream, DeliverPolicy, type JsMsg } from "@nats-io/jetstream";
import { v7 as uuidv7 } from "uuid";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../db/tenant-tx.js";
import { eventBus } from "./event-bus.js";
import { sseHub, type RelayedEvent } from "./sse-hub.js";
import { DOMAIN_EVENTS_QUEUE } from "./pgboss.js";
import {
  connectNatsFanout,
  eventSubject,
  STREAM_NAME,
  type NatsFanoutHandle
} from "./nats-fanout.js";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** BUILD_AND_TEST.md §8 M3 item 8 DoD. See docs/events.md §11. */
describe("EventBus: real backend containers", () => {
  let natsContainer: StartedTestContainer;
  let natsUrl: string;

  beforeAll(async () => {
    natsContainer = await new GenericContainer("nats:2.10")
      .withExposedPorts(4222)
      .withCommand(["-js"])
      .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
      .withStartupTimeout(60_000)
      .start();
    natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;
  }, 60_000);

  afterAll(async () => {
    await natsContainer?.stop();
  });

  describe.each([{ backend: "postgres" as const }, { backend: "nats" as const }])(
    "EventBus ($backend backend): publish -> relay -> deliver -> ack",
    ({ backend }) => {
      let server: ListeningTestServer;
      let org: TestOrg;

      beforeAll(async () => {
        server = await listenTestServer({
          withEventRelay: true,
          natsUrl: backend === "nats" ? natsUrl : undefined
        });
        org = await createTestOrg(server, `eventbus-${backend}`);
      });

      afterAll(async () => {
        await server.close();
      });

      it("delivers every published event to pg-boss's domain-events queue and every SSE subscriber, only marking the outbox row processed once every sink accepted it", async () => {
        const eventType = "scp.eventbus_test.published";
        const received: RelayedEvent[] = [];
        const onEvent = (evt: RelayedEvent): void => {
          if (evt.type === eventType) received.push(evt);
        };
        sseHub.on(org.orgId, onEvent);

        // Hermetic starting point (shared-Postgres singleFork suite). See docs/events.md §12.
        const preClean = new pg.Client({ connectionString: testDatabaseUrl() });
        await preClean.connect();
        await preClean.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
        await preClean.end();

        const expectedSubjects = [0, 1, 2].map((i) => `probe-${backend}-${i}`);
        try {
          await withTenantTx(server.deps.db, org.orgId, async (tx) => {
            for (const subject of expectedSubjects) {
              await eventBus.publish(tx, {
                orgId: org.orgId,
                type: eventType,
                source: "/events/event-bus.integration.test",
                subject,
                data: { backend, subject }
              });
            }
          });

          // Generous timeout: this suite shares one forked process. See docs/events.md §13.
          await waitUntil(async () => (received.length >= 3 ? received : undefined), {
            describe: `sseHub delivers all 3 published events for org ${org.orgId} (${backend} backend)`,
            timeoutMs: 90_000
          });
        } finally {
          sseHub.off(org.orgId, onEvent);
        }

        expect(received).toHaveLength(3);
        expect(new Set(received.map((e) => e.subject))).toEqual(new Set(expectedSubjects));
        const eventIds = received.map((e) => e.id);

        // Ack means every sink accepted it, not just the first. See docs/events.md §14.
        const admin = new pg.Client({ connectionString: testDatabaseUrl() });
        await admin.connect();
        try {
          const outboxRows = await waitUntil(
            async () => {
              const rows = await admin.query<{ id: string; processed_at: Date | null }>(
                `SELECT id, processed_at FROM outbox WHERE id = ANY($1::uuid[])`,
                [eventIds]
              );
              if (rows.rows.length !== 3) return undefined;
              return rows.rows.every((r) => r.processed_at !== null) ? rows : undefined;
            },
            {
              describe: `all 3 outbox rows reach processed_at for org ${org.orgId} (${backend} backend)`,
              timeoutMs: 30_000
            }
          );
          expect(outboxRows.rows).toHaveLength(3);
          for (const row of outboxRows.rows) expect(row.processed_at).not.toBeNull();

          // The same commit also reached the job queue, a distinct sink. See docs/events.md §15.
          await waitUntil(
            async () => {
              const bossJobs = await admin.query<{ count: string }>(
                `SELECT count(*) FROM (
                   SELECT data FROM pgboss.job WHERE name = $1
                   UNION ALL
                   SELECT data FROM pgboss.archive WHERE name = $1
                 ) j WHERE j.data ->> 'id' = ANY($2)`,
                [DOMAIN_EVENTS_QUEUE, eventIds]
              );
              const count = Number(bossJobs.rows[0]?.count ?? 0);
              return count >= 3 ? count : undefined;
            },
            { describe: `pg-boss domain-events queue has all 3 jobs (${backend} backend)` }
          );
        } finally {
          await admin.end();
        }

        if (backend === "nats") {
          // The backend-specific half of "parity": the same 3 events must ALSO have reached the
          // real JetStream stream, on the subjects events/nats-fanout.ts derives per org+type.
          const nc = await connect({ servers: natsUrl, name: "event-bus-test-consumer" });
          try {
            const js = jetstream(nc);
            const consumer = await js.consumers.get(STREAM_NAME, {
              filter_subjects: eventSubject(org.orgId, eventType),
              deliver_policy: DeliverPolicy.All
            });
            const seenIds: string[] = [];
            const batch = await consumer.fetch({ max_messages: 3, expires: 5_000 });
            for await (const m of batch) {
              m.ack();
              const body = JSON.parse(new TextDecoder().decode(m.data)) as { id: string };
              seenIds.push(body.id);
            }
            expect(new Set(seenIds)).toEqual(new Set(eventIds));
          } finally {
            await nc.drain();
          }
        }
      }, 120_000);
    }
  );

  describe("EventBus (nats backend): JetStream de-dup by event id", () => {
    let fanout: NatsFanoutHandle;

    beforeAll(async () => {
      fanout = await connectNatsFanout(natsUrl);
    });

    afterAll(async () => {
      await fanout.close();
    });

    it("redelivering the same outbox-row id (msgID) is idempotent — the broker stores/delivers it exactly once inside the duplicate_window", async () => {
      const orgId = uuidv7();
      const eventType = "scp.eventbus_test.dedup";
      const event: RelayedEvent = {
        id: uuidv7(),
        orgId,
        type: eventType,
        source: "/events/event-bus.integration.test",
        subject: "dedup-probe",
        data: { hello: "world" },
        createdAt: new Date().toISOString()
      };

      // Simulates the relay retrying (at-least-once redelivery) the SAME outbox row — e.g. after
      // a crash between the NATS publish and the transaction's COMMIT (outbox-relay.ts's per-row
      // loop). Neither call should throw: JetStream accepts duplicates silently rather than
      // rejecting them.
      await fanout.publish(event);
      await fanout.publish(event);

      const nc = await connect({ servers: natsUrl, name: "event-bus-dedup-test-consumer" });
      try {
        const js = jetstream(nc);
        const consumer = await js.consumers.get(STREAM_NAME, {
          filter_subjects: eventSubject(orgId, eventType),
          deliver_policy: DeliverPolicy.All
        });
        const messages: JsMsg[] = [];
        const batch = await consumer.fetch({ max_messages: 5, expires: 3_000 });
        for await (const m of batch) {
          m.ack();
          messages.push(m);
        }
        // Exactly one stored/delivered message despite two publishes with the same msgID —
        // JetStream's broker-side duplicate_window de-dup (nats-fanout.ts's doc comment).
        expect(messages).toHaveLength(1);
        const body = JSON.parse(new TextDecoder().decode(messages[0]!.data)) as { id: string };
        expect(body.id).toBe(event.id);
      } finally {
        await nc.drain();
      }
    });
  });
});

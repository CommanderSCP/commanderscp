import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { connect } from "@nats-io/transport-node";
import { jetstream, DeliverPolicy, type ConsumerMessages } from "@nats-io/jetstream";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import setupTestDatabase from "../test-support/global-setup.js";
import { sseHub, type RelayedEvent } from "../events/sse-hub.js";
import { DOMAIN_EVENTS_QUEUE } from "../events/pgboss.js";
import { eventSubject, STREAM_NAME } from "../events/nats-fanout.js";
import { formatSummary, summarize } from "./stats.js";

/** M8 informational load test, Pass 2. See docs/load-test.md §1. */

const INGESTION_CONCURRENCY = 20;
const INGESTION_COUNT = 3000;
const EVENT_PATH_CONCURRENCY = 10;
const EVENT_PATH_COUNT = 500;
const DELIVERY_GRACE_MS = 8_000;
const SOURCE_KIND = "loadtest";
const WEBHOOK_SECRET = "load-test-webhook-secret-do-not-use-in-prod";

interface LoadResult<T> {
  results: T[];
  latenciesMs: number[];
  wallMs: number;
  achievedRatePerSec: number;
}

/** Fixed-concurrency worker pool. See docs/load-test.md §2. */
async function runConcurrentLoad<T>(opts: {
  concurrency: number;
  count: number;
  task: (seq: number) => Promise<T>;
}): Promise<LoadResult<T>> {
  const { concurrency, count, task } = opts;
  const results: T[] = [];
  const latenciesMs: number[] = [];
  let nextSeq = 0;
  const start = Date.now();

  async function worker(): Promise<void> {
    for (;;) {
      const seq = nextSeq++;
      if (seq >= count) return;
      const callStart = Date.now();
      const result = await task(seq);
      latenciesMs.push(Date.now() - callStart);
      results.push(result);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallMs = Date.now() - start;
  return { results, latenciesMs, wallMs, achievedRatePerSec: (count / wallMs) * 1000 };
}

function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Fires one signed webhook POST directly via `fetch`. See docs/load-test.md §3. */
async function postWebhook(baseUrl: string, token: string, seq: number): Promise<Response> {
  const payload = {
    repo: "loadtest/repo",
    path: "irrelevant",
    correlationKey: `loadtest-${seq}`,
    seq
  };
  const body = JSON.stringify(payload);
  const signature = signBody(body, WEBHOOK_SECRET);
  return fetch(`${baseUrl}/change-sources/${SOURCE_KIND}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-scp-signature-256": signature,
      "x-scp-delivery": randomUUID()
    },
    body
  });
}

async function runIngestionPhase(server: ListeningTestServer, org: TestOrg): Promise<void> {
  console.log(
    `\n--- Ingestion: POST /change-sources/${SOURCE_KIND}/webhook, concurrency=${INGESTION_CONCURRENCY}, count=${INGESTION_COUNT} ---`
  );
  const load = await runConcurrentLoad({
    concurrency: INGESTION_CONCURRENCY,
    count: INGESTION_COUNT,
    task: async (seq) => {
      const res = await postWebhook(server.baseUrl, org.adminToken, seq);
      if (res.status !== 202) {
        throw new Error(`webhook POST #${seq} failed: ${res.status} ${await res.text()}`);
      }
      return res.status;
    }
  });
  console.log(
    `Ingestion: ${load.results.length} POSTs in ${(load.wallMs / 1000).toFixed(1)}s ` +
      `(${load.achievedRatePerSec.toFixed(1)} req/s sustained)`
  );
  console.log(formatSummary("Ingestion POST latency", summarize(load.latenciesMs)));
}

interface EventPathPhaseResult {
  backend: "postgres" | "nats";
  createLoad: LoadResult<string>;
  sseLatenciesMs: number[];
  bossLatenciesMs: number[];
  natsLatenciesMs: number[];
  sseDeliveredCount: number;
  bossDeliveredCount: number;
  natsDeliveredCount: number;
}

async function runEventPathPhase(
  server: ListeningTestServer,
  org: TestOrg,
  backend: "postgres" | "nats",
  natsUrl: string | undefined
): Promise<EventPathPhaseResult> {
  console.log(
    `\n--- Event path (${backend}): object.create -> outbox -> relay, concurrency=${EVENT_PATH_CONCURRENCY}, count=${EVENT_PATH_COUNT} ---`
  );
  const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

  const writeTimeByObjectId = new Map<string, number>();
  const sseArrivalByObjectId = new Map<string, number>();
  const onEvent = (evt: RelayedEvent): void => {
    if (
      evt.type === "scp.object.created" &&
      evt.subject &&
      !sseArrivalByObjectId.has(evt.subject)
    ) {
      sseArrivalByObjectId.set(evt.subject, Date.now());
    }
  };
  sseHub.on(org.orgId, onEvent);

  let natsConsumeLoop: Promise<void> | undefined;
  const natsArrivalByObjectId = new Map<string, number>();
  // Hoisted OUTSIDE the consume loop deliberately. See docs/load-test.md §4.
  let natsIter: ConsumerMessages | undefined;
  if (backend === "nats" && natsUrl) {
    const nc = await connect({ servers: natsUrl, name: "load-test-events-consumer" });
    const js = jetstream(nc);
    const consumer = await js.consumers.get(STREAM_NAME, {
      filter_subjects: eventSubject(org.orgId, "scp.object.created"),
      deliver_policy: DeliverPolicy.All
    });
    natsIter = await consumer.consume({ max_messages: 10_000 });
    const iter = natsIter;
    natsConsumeLoop = (async () => {
      for await (const m of iter) {
        m.ack();
        try {
          const evt = JSON.parse(new TextDecoder().decode(m.data)) as RelayedEvent;
          if (evt.subject && !natsArrivalByObjectId.has(evt.subject)) {
            natsArrivalByObjectId.set(evt.subject, Date.now());
          }
        } catch {
          // ignore malformed test noise
        }
      }
      await nc.drain();
    })();
  }

  try {
    const load = await runConcurrentLoad({
      concurrency: EVENT_PATH_CONCURRENCY,
      count: EVENT_PATH_COUNT,
      task: async (seq) => {
        const obj = await client.object("service").create({
          name: `loadtest-event-${backend}-${seq}-${randomUUID()}`
        });
        writeTimeByObjectId.set(obj.id, Date.now());
        return obj.id;
      }
    });
    console.log(
      `Event-path creates: ${load.results.length} in ${(load.wallMs / 1000).toFixed(1)}s ` +
        `(${load.achievedRatePerSec.toFixed(1)} req/s sustained)`
    );
    console.log(formatSummary("object.create POST latency", summarize(load.latenciesMs)));

    console.log(`Waiting up to ${DELIVERY_GRACE_MS}ms for the relay to drain...`);
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_GRACE_MS));

    const sseLatenciesMs: number[] = [];
    for (const [objectId, writeTime] of writeTimeByObjectId) {
      const arrival = sseArrivalByObjectId.get(objectId);
      if (arrival !== undefined) sseLatenciesMs.push(arrival - writeTime);
    }

    // pg-boss delivery latency: read straight from pg-boss's own `created_on` timestamp (set at
    // `boss.send()` inside outbox-relay.ts's relayOnce) — exact, no polling-interval noise. Same
    // job/archive union events/event-bus.integration.test.ts uses (a job may already have been
    // completed and archived by pgboss.ts's own logging worker by the time we look).
    const admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    const bossLatenciesMs: number[] = [];
    try {
      const ids = [...writeTimeByObjectId.keys()];
      const rows = await admin.query<{ subject: string; created_on: Date }>(
        `SELECT j.data ->> 'subject' AS subject, j.created_on FROM (
           SELECT data, created_on FROM pgboss.job WHERE name = $1
           UNION ALL
           SELECT data, created_on FROM pgboss.archive WHERE name = $1
         ) j WHERE j.data ->> 'subject' = ANY($2::text[])`,
        [DOMAIN_EVENTS_QUEUE, ids]
      );
      for (const row of rows.rows) {
        const writeTime = writeTimeByObjectId.get(row.subject);
        if (writeTime !== undefined) bossLatenciesMs.push(row.created_on.getTime() - writeTime);
      }
    } finally {
      await admin.end();
    }

    const natsLatenciesMs: number[] = [];
    if (backend === "nats") {
      natsIter?.stop();
      await natsConsumeLoop;
      for (const [objectId, writeTime] of writeTimeByObjectId) {
        const arrival = natsArrivalByObjectId.get(objectId);
        if (arrival !== undefined) natsLatenciesMs.push(arrival - writeTime);
      }
    }

    return {
      backend,
      createLoad: load,
      sseLatenciesMs,
      bossLatenciesMs,
      natsLatenciesMs,
      sseDeliveredCount: sseLatenciesMs.length,
      bossDeliveredCount: bossLatenciesMs.length,
      natsDeliveredCount: natsLatenciesMs.length
    };
  } finally {
    sseHub.off(org.orgId, onEvent);
    natsIter?.stop();
    if (natsConsumeLoop) await natsConsumeLoop.catch(() => undefined);
  }
}

async function runBackendPhase(
  backend: "postgres" | "nats",
  natsUrl: string | undefined
): Promise<EventPathPhaseResult> {
  console.log(`\n=== Backend: ${backend} ===`);
  const server = await listenTestServer({ withEventRelay: true, natsUrl });
  try {
    const org = await createTestOrg(server, `load-test-events-${backend}`);

    const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await client.changeSources.putWebhookSecret(SOURCE_KIND, { secret: WEBHOOK_SECRET });

    await runIngestionPhase(server, org);
    return await runEventPathPhase(server, org, backend, natsUrl);
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  console.log("=== M8 load test — Pass 2: event path (outbox/pg-boss + NATS) ===");
  console.log(
    "CAVEAT: single dev laptop via Testcontainers (postgres:16 + nats:2.10), everything " +
      "(server, relay, pg-boss, NATS, load driver) sharing one machine's CPU/event loop — NOT a " +
      "production benchmark rig. Informational only (BUILD_AND_TEST.md §8 M8: no benchmark gate, " +
      "review decision).\n"
  );

  console.log("Starting Testcontainers postgres:16 (mirrors test-support/global-setup.ts)...");
  const teardownDb = await setupTestDatabase();

  console.log("Starting Testcontainers nats:2.10 -js (mirrors event-bus.integration.test.ts)...");
  const natsContainer: StartedTestContainer = await new GenericContainer("nats:2.10")
    .withExposedPorts(4222)
    .withCommand(["-js"])
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .withStartupTimeout(60_000)
    .start();
  const natsUrl = `nats://${natsContainer.getHost()}:${natsContainer.getMappedPort(4222)}`;

  try {
    const pgResult = await runBackendPhase("postgres", undefined);
    const natsResult = await runBackendPhase("nats", natsUrl);

    console.log(
      "\n=== RESULTS (single dev laptop, Testcontainers postgres:16 + nats:2.10 — informational only) ==="
    );
    for (const r of [pgResult, natsResult]) {
      console.log(`\nBackend: ${r.backend}`);
      console.log(
        `  object.create throughput: ${r.createLoad.achievedRatePerSec.toFixed(1)} req/s ` +
          `(concurrency=${EVENT_PATH_CONCURRENCY}, n=${r.createLoad.results.length})`
      );
      console.log(formatSummary("  outbox -> SSE (relay) latency  ", summarize(r.sseLatenciesMs)));
      console.log(
        `    delivered ${r.sseDeliveredCount}/${EVENT_PATH_COUNT} within ${DELIVERY_GRACE_MS}ms grace`
      );
      console.log(
        formatSummary("  outbox -> pg-boss latency       ", summarize(r.bossLatenciesMs))
      );
      console.log(
        `    delivered ${r.bossDeliveredCount}/${EVENT_PATH_COUNT} within ${DELIVERY_GRACE_MS}ms grace`
      );
      if (r.backend === "nats") {
        console.log(
          formatSummary("  outbox -> NATS JetStream latency", summarize(r.natsLatenciesMs))
        );
        console.log(
          `    delivered ${r.natsDeliveredCount}/${EVENT_PATH_COUNT} within ${DELIVERY_GRACE_MS}ms grace`
        );
      }
    }
    console.log(`\nRepro: pnpm --filter @scp/server load-test:events`);
  } finally {
    console.log("\nTearing down Testcontainers (postgres, nats)...");
    await natsContainer.stop().catch(() => undefined);
    await teardownDb();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("load-test/event-path failed:", err);
    process.exitCode = 1;
  });
}

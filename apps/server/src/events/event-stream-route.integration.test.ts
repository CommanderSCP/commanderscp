import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { RelayedEvent } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { eventBus } from "./event-bus.js";
import { sseHub } from "./sse-hub.js";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `GET /events/stream` end to end, over real HTTP, through the generated SDK (ADR-0025).
 *
 * The unit layer proves the CONTRACT (openapi/build-document.test.ts: the 200 is declared
 * `text/event-stream`) and the SDK layer proves RECONNECTION (packages/sdk/src/event-stream.test.ts,
 * against a loopback server). Neither proves that the real Fastify route still streams: declaring
 * the operation added a `schema` block to a handler that writes to `reply.raw` and never calls
 * `reply.send`, and that is exactly the kind of change that can turn a working stream into a route
 * Fastify tries to serialize. So this drives the shipped path — relay → `sseHub` → the real route →
 * the real generated `streamEvents` operation → `client.events.stream()`.
 */
describe("GET /events/stream: the declared route, consumed through the SDK", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let client: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({ withEventRelay: true });
    org = await createTestOrg(server, "sse-route");
    client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 90_000);

  afterAll(async () => {
    await server?.close();
  });

  it("delivers a relayed event to an SDK subscriber", async () => {
    // Hermetic starting point, for the reason event-bus.integration.test.ts documents at length:
    // this relay drains oldest-first at ~100 rows/poll, and sibling suites in the same singleFork
    // process leave a large unprocessed backlog ahead of what this test publishes.
    const preClean = new pg.Client({ connectionString: testDatabaseUrl() });
    await preClean.connect();
    await preClean.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    await preClean.end();

    const controller = new AbortController();
    const received: RelayedEvent[] = [];
    const consuming = (async () => {
      for await (const event of client.events.stream({ signal: controller.signal })) {
        received.push(event);
      }
    })().catch(() => undefined);

    try {
      // The stream must be CONNECTED before the event is published: `sseHub` is a live fan-out
      // with no replay buffer, so publishing first would race the subscription and flake. The
      // route registers its listener as its last act before streaming, so the hub's listener count
      // is the deterministic signal — not a sleep.
      await waitUntil(async () => sseHub.listenerCount(org.orgId) > 0, {
        describe: `the SSE route to register a listener for org ${org.orgId}`
      });

      // THE SUBJECT MUST BE AN OBJECT THIS CALLER CAN READ. The route admits each frame with an
      // `object:read` check at `event.subject` (routes/events.ts), so the free-form probe string
      // this used to publish is now refused before the pool — correctly: it names no object. The
      // org root IS an object (`objects.id = orgId`) and this caller is the bootstrap admin, bound
      // Owner there, so the frame is delivered on the strength of a real binding rather than on
      // the absence of a check. `scp.object.updated` keeps the probe distinguishable from the
      // org-root creation event `createTestOrg` itself wrote.
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await eventBus.publish(tx, {
          orgId: org.orgId,
          type: "scp.object.updated",
          source: "/events/event-stream-route.integration.test",
          subject: org.orgId,
          data: { probe: true }
        });
      });

      const event = await waitUntil(
        async () => received.find((e) => e.type === "scp.object.updated"),
        {
          describe: `an SSE frame for org ${org.orgId} through client.events.stream()`,
          timeoutMs: 90_000
        }
      );

      // The whole envelope survived the round trip and passed the generated per-frame validator —
      // a frame that failed it would have dropped the connection instead of arriving here.
      expect(event.subject).toBe(org.orgId);
      expect(event.orgId).toBe(org.orgId);
      expect(event.id).toBeTruthy();
    } finally {
      controller.abort();
      await consuming;
    }
  }, 120_000);

  it("answers an UNAUTHENTICATED request with a 401 problem body, not a stream", async () => {
    // The error responses are the half that IS Fastify-serialized (`schema.response`), so they are
    // asserted separately from the streaming 200.
    const response = await fetch(`${server.baseUrl}/events/stream`);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const problem = (await response.json()) as { title?: string; status?: number };
    expect(problem.status).toBe(401);
  });

  it("serves the stream as text/event-stream to an authenticated caller", async () => {
    // Belt and braces on the media type at RUNTIME, not only in the emitted document: the SDK's
    // whole SSE code path is selected by that header being what the contract says it is.
    const controller = new AbortController();
    const response = await fetch(`${server.baseUrl}/events/stream`, {
      headers: { authorization: `Bearer ${org.adminToken}` },
      signal: controller.signal
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});

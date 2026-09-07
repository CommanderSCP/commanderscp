import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";
import { ScpClient } from "@scp/sdk";
import type { GraphObject, RelayedEvent } from "@scp/schemas";
import { createDb, createPool } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { eventBus } from "../events/event-bus.js";
import { SSE_RESYNC_EVENT_TYPE } from "../events/sse-bridge.js";
import { sseHub } from "../events/sse-hub.js";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  testRuntimeDatabaseUrl,
  waitForSseBridgeListening,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { SSE_AUTHZ_POOL_MAX } from "./events.js";

/** RBAC ON `GET /events/stream`. See docs/routes.md §145. */
describe("GET /events/stream: per-frame object:read at the event's subject", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: pg.Client;
  let serviceA: GraphObject;
  let serviceB: GraphObject;
  let componentA: GraphObject;
  let componentB: GraphObject;

  interface Subscription {
    received: RelayedEvent[];
    close(): Promise<void>;
  }
  const subscriptions: Subscription[] = [];
  let publishSeq = 0;

  /** Opens a real SSE connection for `token` through the generated SDK and collects every frame
   *  the server chose to deliver to it. */
  function open(token: string): Subscription {
    const controller = new AbortController();
    const received: RelayedEvent[] = [];
    const client = new ScpClient({ baseUrl: server.baseUrl, token });
    const consuming = (async () => {
      for await (const event of client.events.stream({ signal: controller.signal })) {
        received.push(event);
      }
    })().catch(() => undefined);
    const subscription: Subscription = {
      received,
      close: async () => {
        controller.abort();
        await consuming;
      }
    };
    subscriptions.push(subscription);
    return subscription;
  }

  /** Publishes one event and resolves once the relay has it. See docs/routes.md §146. */
  async function publishRelayed(
    type: string,
    subject: string | null,
    data: unknown = {}
  ): Promise<string> {
    // A NONCE IN `source`, because. See docs/routes.md §147.
    const source = `/routes/events-authz.integration.test#${++publishSeq}`;
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await eventBus.publish(tx, { orgId: org.orgId, type, source, subject, data });
    });
    const row = await waitUntil(
      async () => {
        const result = await admin.query<{ id: string }>(
          `SELECT id FROM outbox
            WHERE org_id = $1 AND source = $2 AND processed_at IS NOT NULL`,
          [org.orgId, source]
        );
        return result.rows[0];
      },
      {
        describe: `the outbox relay to process the '${type}' event for subject ${subject} (${source})`,
        timeoutMs: 60_000
      }
    );
    return row.id;
  }

  /** Waits for one exact frame on one connection, then answers "did this connection ALSO get the
   *  frame it must not have?" from the state at that moment. */
  async function waitForFrame(
    subscription: Subscription,
    frameId: string,
    describe: string
  ): Promise<RelayedEvent> {
    return waitUntil(async () => subscription.received.find((e) => e.id === frameId), {
      describe,
      timeoutMs: 60_000
    });
  }

  function frameIds(subscription: Subscription): string[] {
    return subscription.received.map((e) => e.id);
  }

  let noBindings: Subscription;
  let serviceViewer: Subscription;
  let orgRootViewer: Subscription;

  /** The stand-in for `main.ts`'s `sseAuthzPool`. See docs/routes.md §148. */
  let authzPool: pg.Pool;
  let authzAcquires = 0;

  beforeAll(async () => {
    server = await listenTestServer({ withEventRelay: true });
    authzPool = createPool(testRuntimeDatabaseUrl(), { max: SSE_AUTHZ_POOL_MAX });
    authzPool.on("acquire", () => {
      authzAcquires += 1;
    });
    server.deps.sseAuthzDb = createDb(authzPool);
    org = await createTestOrg(server, "sse-authz");
    const adminClient = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // Two sibling services, one component each. The scope walk reaches a component from its
    // service through the `contains` edge (authz/resolve.ts route 2) and never sideways, so
    // `componentB` is exactly the object a Viewer bound at `serviceA` must not see.
    serviceA = await adminClient.services.create({ name: `svc-a-${org.orgName}` });
    serviceB = await adminClient.services.create({ name: `svc-b-${org.orgName}` });
    componentA = await createTestComponent(adminClient, {
      name: `cmp-a-${org.orgName}`,
      service: serviceA.id
    });
    componentB = await createTestComponent(adminClient, {
      name: `cmp-b-${org.orgName}`,
      service: serviceB.id
    });

    const noBindingsUser = await createTestUser(server, org, []);
    const serviceViewerUser = await createTestUser(server, org, [
      { role: "Viewer", scope: serviceA.id }
    ]);
    const orgRootViewerUser = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId }
    ]);

    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    // Hermetic starting point, for the reason event-bus.integration.test.ts documents at length:
    // the relay drains oldest-first at ~100 rows/poll and sibling suites in the same singleFork
    // process leave a backlog ahead of anything published here.
    await admin.query(`UPDATE outbox SET processed_at = now() WHERE processed_at IS NULL`);
    // NOTIFY has no replay: an event relayed before the bridge's LISTEN is established is gone,
    // and every negative assertion in this file would then pass vacuously.
    await waitForSseBridgeListening(admin);

    noBindings = open(noBindingsUser.token);
    serviceViewer = open(serviceViewerUser.token);
    orgRootViewer = open(orgRootViewerUser.token);
    // The route registers its `sseHub` listener as its last act before streaming, so the listener
    // count is the deterministic "all three are connected" signal — not a sleep.
    await waitUntil(async () => sseHub.listenerCount(org.orgId) >= 3, {
      describe: `all three SSE connections for org ${org.orgId} to register with sseHub`
    });
  }, 180_000);

  afterAll(async () => {
    for (const subscription of subscriptions) await subscription.close();
    await admin?.end();
    await server?.close();
    await authzPool?.end();
  });

  it("delivers nothing about an object a principal with NO role bindings cannot read", async () => {
    const secret = await publishRelayed("scp.object.updated", componentA.id, { name: "secret" });
    // The one frame this principal is allowed to see (see the resync test below for why), used
    // here purely as the ordering fence.
    const fence = await publishRelayed(SSE_RESYNC_EVENT_TYPE, null);

    await waitForFrame(
      noBindings,
      fence,
      "the unbound principal's connection to receive the contentless resync fence"
    );
    expect(frameIds(noBindings)).not.toContain(secret);
  }, 120_000);

  it("delivers a service-bound Viewer its own service's components, and not a sibling's", async () => {
    const otherService = await publishRelayed("scp.object.updated", componentB.id, { n: 1 });
    const ownService = await publishRelayed("scp.object.updated", componentA.id, { n: 2 });

    const frame = await waitForFrame(
      serviceViewer,
      ownService,
      `the serviceA-bound Viewer to receive the event for componentA (${componentA.id})`
    );
    expect(frame.subject).toBe(componentA.id);
    // Same connection, published (and relayed) FIRST — so this is a refusal, not a race.
    expect(frameIds(serviceViewer)).not.toContain(otherService);

    // NO REGRESSION: an org-root Viewer's binding is at-or-above both components, so it still sees
    // everything it could always see. If the gate were checking at the wrong scope — or upward
    // expansion had been inverted — this is the assertion that fails.
    await waitForFrame(
      orgRootViewer,
      otherService,
      `the org-root Viewer to receive the event for componentB (${componentB.id})`
    );
    await waitForFrame(
      orgRootViewer,
      ownService,
      `the org-root Viewer to receive the event for componentA (${componentA.id})`
    );
  }, 120_000);

  it("drops a null-subject event, except the contentless resync — which is delivered EMPTY", async () => {
    // Asserted on the org-root Viewer deliberately: that principal can read every object in the
    // org, so a frame it does not receive was withheld by the null-subject rule and by nothing
    // else. `data` is non-empty on both, which is what makes the normalization observable.
    const nullSubject = await publishRelayed("scp.test.null-subject", null, {
      smuggled: "payload"
    });
    const resync = await publishRelayed(SSE_RESYNC_EVENT_TYPE, null, { smuggled: "payload" });

    const frame = await waitForFrame(
      orgRootViewer,
      resync,
      "the org-root Viewer to receive the allowlisted resync frame"
    );
    // The allowlist is keyed on the event TYPE, and `type` is a column any writer of an outbox row
    // chooses. A frame that skipped the permission check therefore carries no payload.
    expect(frame.data).toEqual({});
    expect(frame.subject).toBeNull();

    // No object to check `object:read` against, and not the one allowlisted synthetic frame.
    expect(frameIds(orgRootViewer)).not.toContain(nullSubject);
    expect(frameIds(serviceViewer)).not.toContain(nullSubject);
    expect(frameIds(noBindings)).not.toContain(nullSubject);
  }, 120_000);

  it("drops a frame whose subject is not a readable object id at all", async () => {
    // `scp.relationship.*` sets `subject` to a RELATIONSHIP id; a non-UUID subject is refused
    // before it can reach the pool. Both are subjects the containment walk cannot start from, and
    // both are dropped for the org-root Viewer, who can read every object there is.
    const notAnObject = await publishRelayed("scp.object.updated", "not-a-uuid", { n: 3 });
    const readable = await publishRelayed("scp.object.updated", componentA.id, { n: 4 });

    await waitForFrame(
      orgRootViewer,
      readable,
      "the org-root Viewer to receive the readable-object fence"
    );
    expect(frameIds(orgRootViewer)).not.toContain(notAnObject);
  }, 120_000);

  /** THE ISOLATION, OBSERVED. See docs/routes.md §149. */
  it("runs the per-frame permission check on the ISOLATED pool, not the request-serving one", async () => {
    expect(server.deps.sseAuthzDb).toBeDefined();
    expect(server.deps.sseAuthzDb).not.toBe(server.deps.db);

    const before = authzAcquires;
    const unknownObject = await publishRelayed("scp.object.updated", randomUUID(), { n: 5 });
    const fence = await publishRelayed("scp.object.updated", componentA.id, { n: 6 });

    await waitForFrame(
      orgRootViewer,
      fence,
      "the org-root Viewer to receive the isolated-pool fence"
    );
    // The check ran (a UUID that names no object is refused only by asking the database) …
    expect(frameIds(orgRootViewer)).not.toContain(unknownObject);
    // … and it ran on the isolated pool. With the route reading `deps.db` this stays at zero.
    expect(
      authzAcquires - before,
      "GET /events/stream opened no transaction on the isolated sse-authz pool — the per-frame " +
        "object:read check is back on the request-serving pool (deps.db)"
    ).toBeGreaterThan(0);
  }, 120_000);
});

/** THE COMPOSITION ROOT. See docs/routes.md §150. */
describe("main.ts hands the route an isolated pool (SOURCE CENSUS — main.ts cannot be imported)", () => {
  const mainTs = readStripped(join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts"));

  it("assigns `deps.sseAuthzDb` from a pool built with `SSE_AUTHZ_POOL_MAX`", () => {
    expect(mainTs).toMatch(/deps\.sseAuthzDb\s*=\s*createDb\(\s*sseAuthzPool\s*\)/);
    expect(mainTs).toMatch(
      /const\s+sseAuthzPool\s*=\s*createPool\([^)]*\{\s*max:\s*SSE_AUTHZ_POOL_MAX\s*\}\s*\)/
    );
  });

  it("closes that pool on shutdown, and imports the bound rather than shadowing it", () => {
    expect(mainTs).toMatch(/sseAuthzPool\.end\(\)/);
    expect(mainTs).toMatch(
      /import\s*\{[^}]*\bSSE_AUTHZ_POOL_MAX\b[^}]*\}\s*from\s*["']\.\/routes\/events\.js["']/
    );
    expect(mainTs).not.toMatch(
      /(?:const|let|var)\s+SSE_AUTHZ_POOL_MAX\b|(?<![\w.$])SSE_AUTHZ_POOL_MAX\s*=(?!=)/
    );
  });
});

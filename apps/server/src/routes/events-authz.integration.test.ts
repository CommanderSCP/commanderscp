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

/**
 * RBAC ON `GET /events/stream` — the boundary below tenancy (routes/events.ts).
 *
 * `sseHub` keys its channels by `orgId`, which is the TENANCY boundary and nothing more. Before
 * this suite existed the route stopped there: any authenticated principal in the org — including
 * one with zero role bindings — was pushed every object's events, each carrying that object's id
 * and a payload, while every REST read of the same objects demanded `object:read` at a resolved
 * scope. These tests drive the SHIPPED path end to end (real HTTP, the generated SDK's
 * `streamEvents`, the real relay → NOTIFY → bridge → `sseHub` → route fan-out) rather than calling
 * the gate directly, because the defect was never in a helper — it was in what the route did not
 * call.
 *
 * ## Every negative assertion here is fenced by a POSITIVE one on the SAME connection
 *
 * "X never arrived" is the assertion shape that passes for free when nothing could have arrived at
 * all (a stream that never connected, an event that was never relayed, a bridge whose LISTEN was
 * still being established — NOTIFY has no replay). So each test publishes the frame it expects to
 * be REFUSED first, waits until the relay has actually processed that outbox row, and only then
 * publishes a frame that principal IS allowed to see; the refusal is asserted at the moment its
 * successor has already been delivered over the same connection. The route serializes its per-frame
 * permission checks into one promise chain per connection precisely so that order is meaningful.
 */
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

  /**
   * Publishes one outbox event and resolves with its outbox row id once the relay has PROCESSED
   * it — which is also the SSE frame's `id`, so every assertion below names an exact frame rather
   * than matching on a type or subject that another suite (or the bridge's own reconnect resync)
   * could also have produced.
   *
   * Waiting for `processed_at` is what makes "published before" mean "reached the hub before": the
   * relay NOTIFYs inside the row's own transaction, but events/sse-bridge.ts fetches each pointer
   * concurrently, so two rows relayed in the same batch can reach `sseHub` in either order. A row
   * whose relay has already committed, followed by a fresh publish that needs its own NOTIFY and
   * its own fetch, cannot.
   */
  async function publishRelayed(
    type: string,
    subject: string | null,
    data: unknown = {}
  ): Promise<string> {
    // A NONCE IN `source`, because (type, subject) IS NOT UNIQUE and looking a row up by it is how
    // this whole file goes vacuous. Measured while mutation-proving: with the lookup keyed on
    // (type, subject) + `processed_at IS NOT NULL`, the SECOND publish of an already-published pair
    // resolved instantly to the FIRST publish's row — a frame this connection had received several
    // assertions ago. Every `waitForFrame` on it then returned immediately, on the old frame, and
    // the payload-normalization assertion passed with the normalization deleted. `source` is a
    // column this test owns outright, so one nonce makes each publish addressable.
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

  /**
   * The stand-in for `main.ts`'s `sseAuthzPool` — an INSTRUMENTED pool, so "the route ran its
   * permission checks somewhere other than `deps.db`" is an observation rather than a reading of
   * the source. `pg.Pool` emits `acquire` on every checkout, so this counter is exactly "how many
   * tenant transactions the SSE fan-out opened on the isolated pool".
   *
   * `test-support/harness.ts` builds deps as `{ db, config }` — it does NOT set `sseAuthzDb`, which
   * is precisely why routes/events.ts's fallback exists — so this assignment IS the wiring under
   * test on the runtime side. It is made before any connection is opened, because the route
   * resolves the pool once per connection.
   */
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

  /**
   * THE ISOLATION, OBSERVED — not "a second pool exists" but "the fan-out's checks ran on it".
   *
   * The previous round put an attacker-influenceable, unbounded-volume database load (one recursive
   * permission walk per connection per distinct subject) onto `deps.db`, the request-serving pool —
   * the exact hazard `main.ts` had already isolated one layer up for the SSE bridge (its `max: 2`
   * pool, review finding SEC-1). `deps.db` has no `max` (pg's default 10) and `createPool` sets
   * `connectionTimeoutMillis: 5000`, so contention there surfaces as timeouts on unrelated API
   * requests.
   *
   * The subject is a FRESH `randomUUID()` on purpose: the per-connection memo would otherwise
   * answer from cache and no checkout would happen at all, which is how this assertion could pass
   * while proving nothing. A random UUID is a guaranteed memo miss on all three connections, and it
   * is UUID-shaped so it clears the route's pre-pool `UUID_RE` gate and genuinely reaches the
   * database (where it matches no object, so the frame is correctly dropped — asserted below, which
   * is what proves the check RAN rather than being skipped).
   */
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

/**
 * THE COMPOSITION ROOT — a SOURCE census, because `main.ts` cannot be imported (`main()` runs at
 * module scope), exactly as background-work.test.ts documents for `startBackgroundLoops`.
 *
 * The suite above proves the ROUTE prefers `deps.sseAuthzDb` when it is set. Nothing above can
 * prove that anything sets it in a deployed process — the harness deliberately does not, and this
 * repo's dominant failure mode is a component that is built, tested, and wired nowhere. These two
 * assertions are the cheapest detector for the single most likely edit: the `main.ts` line going
 * away in a merge or a revert, leaving every deployed process silently on the fallback.
 *
 * WHAT THIS DOES NOT PROVE (the same list background-work.test.ts carries): that the assignment is
 * reachable, that the pool it names is the isolated one at runtime, or that it happens before the
 * first request. Only booting the real process could. `readStripped`, not `readFileSync`, so a
 * mention inside the surrounding comment block cannot satisfy it.
 */
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

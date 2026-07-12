import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutorEvent } from "@scp/plugin-api";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, executorObserveCursors } from "../db/schema.js";
import { SubprocessPluginHost } from "../plugin-host/host.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { runObserveSweep } from "./observe.js";

/**
 * M10.2 — the observe()-DRIVER end-to-end (BUILD_AND_TEST.md §8 M10 item 2 DoD): a bound,
 * observe-capable executor's `observe()` output creates a Change with NO inbound webhook; the
 * cursor persists and advances; a re-poll is a no-op. Real Postgres (Testcontainers, global-setup),
 * a REAL subprocess plugin host running `@scp/plugin-fake-executor`, never mocked.
 */
describe("observe()-driver: pull-based change detection (no inbound webhook)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let host: SubprocessPluginHost;

  const REPO = "AgentKitProject/observe-test";
  const OCCURRED = "2026-07-12T20:00:00.000Z";
  const INSTANCE = "observe-test-fake";

  beforeAll(async () => {
    server = await listenTestServer({});
    org = await createTestOrg(server, "observe");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    host = new SubprocessPluginHost({
      callTimeoutMs: 8_000,
      restartBackoffBaseMs: 50,
      maxRestartBackoffMs: 300
    });
  });

  afterAll(async () => {
    await host.stop();
    await server.close();
  });

  it("observe() -> change_source_events -> Change, with cursor advance and dedup", async () => {
    const component = await admin.components.create({ name: "observe-target" });

    const event: ExecutorEvent = {
      kind: "push",
      occurredAt: OCCURRED,
      correlation: { repo: REPO, correlationKey: "obs-1" },
      raw: { source: "observe-test", note: "verbatim provider payload" }
    };

    // A source_mapping so the observed event correlates to a component, and a binding whose
    // fake-executor emits `event` from observe() (config-driven, honoring the `since` watermark).
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "fake-executor",
        repoPattern: REPO,
        componentIdOrUrn: component.id
      });
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: component.id,
        pluginModule: "fake-executor",
        pluginInstanceId: INSTANCE,
        config: { observeEvents: [event] }
      });
    });

    // --- ACT 1: the sweep polls observe() and normalizes into change_source_events ---
    await runObserveSweep(server.deps.db, host, server.deps.config.secretsMasterKey);

    const afterFirst = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.orgId, org.orgId))
    );
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.sourceKind).toBe("fake-executor");
    expect(afterFirst[0]!.signatureVerified).toBe(true);
    expect(afterFirst[0]!.dedupeKey).toContain("obs-1");
    expect((afterFirst[0]!.payload as { repo?: string }).repo).toBe(REPO);
    expect(afterFirst[0]!.processedAt).toBeNull();

    // Cursor persisted + advanced to the event watermark.
    const cursor = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(executorObserveCursors)
        .where(
          and(
            eq(executorObserveCursors.orgId, org.orgId),
            eq(executorObserveCursors.pluginInstanceId, INSTANCE)
          )
        )
    );
    expect(cursor).toHaveLength(1);
    expect(cursor[0]!.cursorToken).toBe(OCCURRED);

    // --- ACT 2: the SAME processor the webhook route uses turns it into a Change ---
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    const processed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.orgId, org.orgId))
    );
    expect(processed[0]!.processedAt).not.toBeNull();
    expect(processed[0]!.resultingChangeObjectId).not.toBeNull();

    const change = await admin.changes.get(processed[0]!.resultingChangeObjectId as string);
    expect(change.name).toBe(`fake-executor: ${REPO}`);

    // --- ACT 3: a second sweep with the advanced cursor is a no-op (watermark + dedupe) ---
    await runObserveSweep(server.deps.db, host, server.deps.config.secretsMasterKey);
    const afterSecond = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.orgId, org.orgId))
    );
    expect(afterSecond).toHaveLength(1); // no duplicate row -> no duplicate Change
  });
});

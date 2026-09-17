import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { ExecutorEvent } from "@scp/plugin-api";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { SubprocessPluginHost } from "../plugin-host/host.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import { runObserveSweep } from "./observe.js";

/**
 * fix/poll-events-carry-ref — the OUTERMOST layer the poll path uses: `runObserveSweep` (the same
 * driver `observe.ts`'s pg-boss loop calls) normalizes a plugin's `observe()` output into
 * `change_source_events` (`ingestObservedEvents`), then `processChangeSourceEvents` (the SAME
 * processor the webhook route uses) turns an unprocessed row into a Change via
 * `matchComponentsForSource`, which fails closed on a `refPattern` mapping when the event's hint
 * carries no `ref` (`correlation.ts`).
 *
 * This drives a github-shaped POLLED push — exactly the `{ kind: "push", correlation: { repo,
 * commitSha, ref: "refs/heads/<branch>" } }` shape `pollCommits` now produces post-fix — through
 * that real pipeline via the fake-executor plugin's `observeEvents` config (no HTTP mocking of a
 * real git provider needed; the shape under test is the correlation hint, not github's transport).
 */
describe("poll-path ref-scoped routing: a polled push with a stamped ref matches a refPattern mapping", () => {
  let server: ListeningTestServer;
  let host: SubprocessPluginHost;

  const REPO = "acme/gitops";
  const COMMIT_SHA = "f".repeat(40);

  beforeAll(async () => {
    server = await listenTestServer({});
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

  async function driveOneEvent(
    org: TestOrg,
    admin: ScpClient,
    instanceId: string,
    refPattern: string
  ) {
    const component = await createTestComponent(admin, { name: "poll-ref-target" });

    // A github-shaped polled push: same correlation hint pollCommits stamps post-fix (repo,
    // commitSha, ref) — no correlationKey, matching journey-view §8.16's push mapping.
    const event: ExecutorEvent = {
      kind: "push",
      occurredAt: "2026-09-01T00:00:00.000Z",
      correlation: { repo: REPO, commitSha: COMMIT_SHA, ref: "refs/heads/main" },
      raw: { source: "poll-ref-routing-test" }
    };

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "fake-executor",
        repoPattern: REPO,
        refPattern,
        componentIdOrUrn: component.id
      });
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: component.id,
        pluginModule: "fake-executor",
        pluginInstanceId: instanceId,
        config: { observeEvents: [event] },
        actorObjectId: org.orgId,
        requestId: "test-setup"
      });
    });

    // ACT 1: the observe sweep — the SAME driver observe.ts's pg-boss loop invokes.
    await runObserveSweep(server.deps.db, host, server.deps.config.secretsMasterKey);
    // ACT 2: the SAME processor the webhook route uses turns an unprocessed row into a Change.
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.orgId, org.orgId))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).not.toBeNull();
    return rows[0]!;
  }

  it("a mapping with refPattern 'refs/heads/main' ROUTES the polled push (matches the stamped ref)", async () => {
    const org = await createTestOrg(server, "poll-ref-match");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const row = await driveOneEvent(org, admin, "poll-ref-match-instance", "refs/heads/main");

    expect(row.resultingChangeObjectId).not.toBeNull();
    const change = await admin.changes.get(row.resultingChangeObjectId as string);
    expect(change.name).toContain(REPO);
  });

  it("a mapping with refPattern 'refs/heads/dev' does NOT route the SAME polled push (correlation.ts's fail-closed rule, unmodified)", async () => {
    const org = await createTestOrg(server, "poll-ref-mismatch");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const row = await driveOneEvent(org, admin, "poll-ref-mismatch-instance", "refs/heads/dev");

    // Processed (no source_mappings row matched), but no Change was created — the fail-closed
    // outcome `correlation.ts`'s ref-scoped rule already guarantees; this test proves the POLL path
    // reaches that rule with a real ref attached, rather than silently carrying no ref at all.
    expect(row.resultingChangeObjectId).toBeNull();
  });
});

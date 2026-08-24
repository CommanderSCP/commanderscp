import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordMemberClusterHeartbeat, listLiveMemberHeartbeats } from "./member-heartbeat-repo.js";
import { buildTestServer, type TestServer } from "../test-support/harness.js";

/**
 * §7.4 — the member-cluster heartbeat round-trip (also validates that migration 0093 applies and the
 * runtime `scp_app` role can upsert its own row under the instance-wide RLS policy). A live heartbeat
 * is what the migrations Job's version-skew gate and the instance doctor read.
 */
describe("member-cluster heartbeat (§7.4)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  }, 90_000);

  afterAll(async () => {
    await server.close();
  });

  it("upserts a heartbeat and reads it back as live; a second upsert refreshes, not duplicates", async () => {
    await recordMemberClusterHeartbeat(server.deps.db, "cluster-alpha", "1.0.0");
    let live = await listLiveMemberHeartbeats(server.deps.db);
    const alpha = live.find((h) => h.clusterId === "cluster-alpha");
    expect(alpha?.appVersion).toBe("1.0.0");

    // Same cluster id, new version → UPDATE the one row (PK is cluster_id).
    await recordMemberClusterHeartbeat(server.deps.db, "cluster-alpha", "1.1.0");
    live = await listLiveMemberHeartbeats(server.deps.db);
    const alphaRows = live.filter((h) => h.clusterId === "cluster-alpha");
    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0]?.appVersion).toBe("1.1.0");
  });

  it("a heartbeat older than the live window is not returned as live", async () => {
    await recordMemberClusterHeartbeat(server.deps.db, "cluster-stale", "0.9.0");
    // Zero-width window: nothing counts as live.
    const live = await listLiveMemberHeartbeats(server.deps.db, 0);
    expect(live.find((h) => h.clusterId === "cluster-stale")).toBeUndefined();
  });
});

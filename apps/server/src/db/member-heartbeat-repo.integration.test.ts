import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
    // AGE THE ROW EXPLICITLY rather than shrinking the window to zero. The zero-width version
    // compared a DB-clock `updated_at` against a JS-clock cutoff and so depended on the two clocks
    // agreeing to the millisecond — it passed locally and failed in CI, where the row came back
    // "live" because the container's clock ran marginally ahead. Ageing the row by an hour makes the
    // assertion about the WINDOW, which is what it claims to be about, on any clock.
    await server.deps.db.execute(
      sql`UPDATE member_cluster_heartbeat SET updated_at = now() - interval '1 hour' WHERE cluster_id = 'cluster-stale'`
    );
    const live = await listLiveMemberHeartbeats(server.deps.db);
    expect(live.find((h) => h.clusterId === "cluster-stale")).toBeUndefined();

    // NEGATIVE CONTROL: a window wide enough to cover the aged row DOES return it, so the assertion
    // above is about staleness and not about the row having failed to be written at all.
    const wide = await listLiveMemberHeartbeats(server.deps.db, 2 * 60 * 60 * 1000);
    expect(wide.find((h) => h.clusterId === "cluster-stale")?.appVersion).toBe("0.9.0");
  });
});

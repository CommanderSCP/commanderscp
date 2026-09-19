import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `ChangeWaveSchema.entry` (D1, 2026-09-16, docs/proposals/pipeline-mockup-data.md §4/§9): BOTH
 * fan-in facts, as SEPARATE union members — `coupled_changes` (the build-arm fan-in of one push,
 * attaches to wave 0 only) and `previous_wave` (a wave's own predecessor's completion, attaches to
 * any wave with waveIndex > 0). See docs/coordination.md §389 (`coupling.integration.test.ts`) and
 * §343 (`coordination.integration.test.ts`) for the underlying mechanisms this projects.
 */
describe("ChangeWaveSchema.entry: both fan-in facts, server-computed", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "wave-entry-fanin");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  const reaches = (id: string, state: string, ms = 20_000) =>
    waitUntil(
      async () => {
        const c = await admin.changes.get(id);
        return c.state === state ? c : undefined;
      },
      { describe: `change ${id} reaches '${state}'`, timeoutMs: ms }
    );

  it("a wave with NO previous wave reports no `previous_wave` entry, and no `coupled_changes` entry absent `requires`", async () => {
    const comp = await createTestComponent(admin, { name: "entry-no-predecessor" });
    const change = await admin.changes.propose({ name: "single-wave release", targets: [comp.id] });
    await reaches(change.id, "validating");

    const explained = await admin.changes.explain(change.id);
    expect(explained.plan!.waves).toHaveLength(1);
    expect(
      explained.plan!.waves[0]!.entry,
      "wave 0 has no predecessor and this change declared no `requires` — there is nothing to report, so `entry` must be ABSENT, never a fabricated empty array standing in for a real fact"
    ).toBeUndefined();
  });

  it("`previous_wave`: the SECOND wave's entry reports the first wave's own target count immediately, and its DONE count once the first wave completes", async () => {
    const infraA = await createTestComponent(admin, { name: "entry-infra-a" });
    const infraB = await createTestComponent(admin, { name: "entry-infra-b" });
    const app = await createTestComponent(admin, { name: "entry-app" });
    await admin.components.addDependsOn(app.id, infraA.id);
    await admin.components.addDependsOn(app.id, infraB.id);

    const change = await admin.changes.propose({
      name: "two-wave release",
      targets: [app.id, infraA.id, infraB.id]
    });

    // The plan compiles quickly (before any wave necessarily finishes) — `requiredCount` is a
    // structural fact (wave 0's own target count) and must already be correct even before wave 0
    // is done, which is exactly the invariant this early read proves.
    const compiled = await waitUntil(
      async () => {
        const e = await admin.changes.explain(change.id);
        return e.plan && e.plan.waves.length === 2 ? e : undefined;
      },
      { describe: `change ${change.id} compiles into two waves`, timeoutMs: 20_000 }
    );
    expect(compiled.plan!.waves[0]!.targets.map((t) => t.targetObjectId).sort()).toEqual(
      [infraA.id, infraB.id].sort()
    );
    const earlyEntry = compiled.plan!.waves[1]!.entry;
    expect(earlyEntry).toEqual([
      { kind: "previous_wave", satisfiedCount: expect.any(Number), requiredCount: 2 }
    ]);
    // Wave 0 has no predecessor of its own.
    expect(compiled.plan!.waves[0]!.entry).toBeUndefined();

    await reaches(change.id, "validating");
    const finished = await admin.changes.explain(change.id);
    expect(finished.plan!.waves[1]!.entry).toEqual([
      { kind: "previous_wave", satisfiedCount: 2, requiredCount: 2 }
    ]);
  });

  it("`coupled_changes`: wave 0 reports the build-arm fan-in count while parked, and once satisfied", async () => {
    const infra = await createTestComponent(admin, { name: "entry-coupled-infra" });
    const app = await createTestComponent(admin, { name: "entry-coupled-app" });

    const waiter = await admin.changes.propose({
      name: "software waiting on infra (entry)",
      targets: [app.id],
      requires: [{ key: "feature-entry", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    const parked = await admin.changes.explain(waiter.id);
    expect(parked.plan!.waves).toHaveLength(1);
    expect(parked.plan!.waves[0]!.entry).toEqual([
      { kind: "coupled_changes", satisfiedCount: 0, requiredCount: 1 }
    ]);

    const provider = await admin.changes.propose({
      name: "infra providing feature-entry",
      targets: [infra.id],
      provides: ["feature-entry"]
    });
    await reaches(provider.id, "validating");
    await reaches(waiter.id, "validating");

    const released = await admin.changes.explain(waiter.id);
    expect(released.plan!.waves[0]!.entry).toEqual([
      { kind: "coupled_changes", satisfiedCount: 1, requiredCount: 1 }
    ]);
  });
});

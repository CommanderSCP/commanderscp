import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { matchComponentForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `source_mappings.enabled` — the operator's PAUSE SWITCH (migration 0063, owner ask 2026-08-14,
 * component pipeline view: "each [source] should have its own arrow so I can enable and disable
 * each as needed").
 *
 * Unlike `mirrorOfShared` (0062, the same table's other declared marker), this one is NOT inert:
 * `matchComponentForSource` skips a disabled row as its first filter, so flipping it changes what
 * a push actually correlates to. Two properties are pinned here, and the second is the one that
 * matters — a toggle the matcher never checked would be theatre:
 *
 *   1. ROUND-TRIP through the public API: defaults to `true` on create, `false` when explicitly
 *      declared, flips both ways through `PATCH .../mappings/:id`, and every read (create/list)
 *      reflects the current value.
 *   2. ENFORCEMENT: with two mappings identical in every routing respect but one disabled, a push
 *      routes ONLY to the enabled one. Disabling the survivor makes the same push route to
 *      NOTHING. Re-enabling it makes the push route again.
 */
describe("source mapping: enabled (the pause switch, migration 0063)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-enabled");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const match = (sourceKind: string, repo: string, paths?: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, paths })
    );

  it("round-trips: true by default, false when declared, flips both ways via PATCH, list reflects", async () => {
    const component = await createTestComponent(admin, { name: `enabled-rt-${uuidv7()}` });
    const sourceKind = `enabled-rt-${uuidv7()}`;

    const byDefault = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/default-on",
      type: "infrastructure"
      // omitted → enabled, the pre-0063 behaviour
    });
    expect(byDefault.enabled).toBe(true);

    const declaredOff = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/declared-off",
      type: "infrastructure",
      enabled: false
    });
    expect(declaredOff.enabled).toBe(false);

    // Flip the declared-off one ON.
    const flippedOn = await admin.changeSources.setMappingEnabled(
      sourceKind,
      declaredOff.id,
      true
    );
    expect(flippedOn.enabled).toBe(true);
    expect(flippedOn.id).toBe(declaredOff.id);

    // And flip the default-on one OFF.
    const flippedOff = await admin.changeSources.setMappingEnabled(sourceKind, byDefault.id, false);
    expect(flippedOff.enabled).toBe(false);

    const listed = await admin.changeSources.listMappings(sourceKind);
    const byRepo = new Map(listed.items.map((m) => [m.repoPattern, m.enabled]));
    expect(byRepo.get("acme/default-on")).toBe(false); // flipped off above
    expect(byRepo.get("acme/declared-off")).toBe(true); // flipped on above
  });

  it("is ENFORCED at correlation: a disabled mapping never wins, and re-enabling it routes again", async () => {
    const sourceKind = `enabled-enforce-${uuidv7()}`;
    const repo = `acme/svc-${uuidv7()}`;
    const enabledTarget = await createTestComponent(admin, { name: `enabled-on-${uuidv7()}` });
    const disabledTarget = await createTestComponent(admin, { name: `enabled-off-${uuidv7()}` });

    // Two mappings identical in every ROUTING respect (repo + path), differing ONLY in `enabled`.
    const enabledMapping = await admin.changeSources.createMapping(sourceKind, {
      component: enabledTarget.id,
      repoPattern: repo,
      pathPattern: "svc/**",
      type: "infrastructure"
    });
    await admin.changeSources.createMapping(sourceKind, {
      component: disabledTarget.id,
      repoPattern: repo,
      pathPattern: "svc/**",
      type: "infrastructure",
      enabled: false
    });

    // The push routes ONLY to the enabled mapping — the disabled sibling never wins even though it
    // matches identically.
    const first = await match(sourceKind, repo, ["svc/main.tf"]);
    expect(first?.componentObjectId).toBe(enabledTarget.id);

    // Disable the survivor. The identical push now routes to NOTHING — no other row picks it up,
    // because the disabled mapping does not fall back to some other match; it is simply excluded.
    await admin.changeSources.setMappingEnabled(sourceKind, enabledMapping.id, false);
    const second = await match(sourceKind, repo, ["svc/main.tf"]);
    expect(second).toBeNull();

    // Re-enable it. The same push routes again, to the same component.
    await admin.changeSources.setMappingEnabled(sourceKind, enabledMapping.id, true);
    const third = await match(sourceKind, repo, ["svc/main.tf"]);
    expect(third?.componentObjectId).toBe(enabledTarget.id);
  });
});

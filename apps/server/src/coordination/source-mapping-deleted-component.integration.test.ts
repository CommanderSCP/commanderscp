import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { matchComponentForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** A mapping whose component was deleted must not match. See docs/coordination.md §897. */
describe("a source mapping whose component was deleted must not match", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-deleted-comp");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const mapping = (input: {
    sourceKind: string;
    componentIdOrUrn: string;
    repoPattern?: string;
    pathPattern?: string;
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, { orgId: org.orgId, type: "configuration", ...input })
    );

  const match = (sourceKind: string, repo: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo })
    );

  it("routes to NOBODY rather than to a deleted component", async () => {
    const sourceKind = `deleted-comp-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const doomed = await createTestComponent(admin, { name: `doomed-${uuidv7()}` });
    await mapping({ sourceKind, componentIdOrUrn: doomed.id, repoPattern: repo });

    // Control: while it lives, the mapping routes to it. Without this the test could pass because
    // the mapping never matched at all.
    expect((await match(sourceKind, repo))?.componentObjectId).toBe(doomed.id);

    await admin.components.delete(doomed.id);

    expect(
      await match(sourceKind, repo),
      "a push must not route to a dead component — the change it creates fake-succeeds, because zero bindings reads as ADR-0006 'intended-fake'"
    ).toBeNull();
  });

  it("falls through to a LIVE mapping instead of being blocked by the dead one", async () => {
    // The case the live estate is actually in: a broad mapping on the deleted env-suffixed component
    // sits beside a narrower one on the survivor. Skipping the dead row must not merely return null
    // — the surviving mapping has to win, or a pair merge silently stops routing that repo.
    const sourceKind = `deleted-comp-fallthrough-${uuidv7()}`;
    const repo = `acme/monorepo-${uuidv7()}`;
    const doomed = await createTestComponent(admin, { name: `doomed2-${uuidv7()}` });
    const survivor = await createTestComponent(admin, { name: `survivor-${uuidv7()}` });

    // Identical in shape, and the dead one is created first. See docs/coordination.md §898.
    await mapping({ sourceKind, componentIdOrUrn: doomed.id, repoPattern: repo });
    await mapping({ sourceKind, componentIdOrUrn: survivor.id, repoPattern: repo });

    await admin.components.delete(doomed.id);

    const hit = await match(sourceKind, repo);
    expect(
      hit?.componentObjectId,
      "the surviving mapping must take over — skipping the dead row must not mean routing nothing"
    ).toBe(survivor.id);
  });
});

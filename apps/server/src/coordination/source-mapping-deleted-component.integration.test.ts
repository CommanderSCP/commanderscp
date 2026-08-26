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

/**
 * A SOURCE MAPPING WHOSE COMPONENT WAS DELETED MUST NOT MATCH.
 *
 * ============================================================================================
 * THE PROPERTY, AND WHY THIS IS A SILENT FAKE SUCCESS RATHER THAN A STALE ROW
 * ============================================================================================
 * `source_mappings` has no `deleted_at` of its own and no foreign key to `objects`, so the row
 * outlives its component unless a query excludes it. `executor-bindings-repo.ts` already says this
 * in as many words about ITS table ("there is no `executor_bindings.deleted_at`, so the binding row
 * outlives its target unless a query excludes it") and fixed it with `targetObjectIsLive` in M12
 * P5c. `matchComponentForSource` never got the same guard — the incomplete-call-site pattern
 * BUILD_AND_TEST.md §4.4 exists for.
 *
 * The consequence is not a stale row. It is a green release that deployed nothing:
 *
 *   push -> matchComponentForSource returns the DEAD component
 *        -> a change is proposed against it
 *        -> its wave target is a deleted object
 *        -> listVisibleBindingsForTarget correctly reports ZERO (the bindings repo excludes a dead
 *           target — its half of this property IS fixed)
 *        -> reconcile.ts reads zero bindings as ADR-0006 case (a), "intended-fake"
 *        -> the wave target FAKE-SUCCEEDS.
 *
 * The two halves of one property compose into the exact masking failure #66 closed: the fixed half
 * makes the unfixed half worse, because it turns "no binding" into "nothing was meant to deploy".
 *
 * Measured on the live homelab 2026-08-02: FIVE mappings pointed at components soft-deleted that
 * same day by the `docs/proposals/post-import-configuration.md` §6 pair merges, on repo patterns as
 * broad as `AgentKitProject/agentkit`
 * with no path pattern. Every remaining pair merge creates more.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `correlation.ts`: drop `componentIsLive` from the WHERE | the dead-component test FAILS — the matcher routes a push to a deleted component |
 * | `correlation.ts`: make `componentIsLive` check `deleted_at IS NOT NULL` | BOTH tests FAIL — proves the guard is read in the right direction, not merely present |
 *
 * The fall-through test was WRONG when first written: it distinguished the two mappings by
 * `pathPattern` while the hint carried no paths, so the dead row was skipped for an unsatisfiable
 * path rather than for being dead, and it stayed GREEN with the guard removed. Caught by M1.
 */
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

    // Both mappings are IDENTICAL in shape and the dead one is created FIRST, so precedence rule 3
    // (oldest wins, the stable tiebreak) hands it the match. That is what makes this test sensitive
    // to the guard.
    //
    // Its first version gave the dead mapping a narrower `pathPattern` instead, reasoning that
    // "more specific would win". It would have — but `match()` sends no `paths`, so the matcher
    // skipped that row for having an unsatisfiable path pattern, NOT for being dead. The test
    // passed with the guard removed. Caught by mutation.
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

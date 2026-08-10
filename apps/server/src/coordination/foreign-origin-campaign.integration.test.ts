import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, objects, relationships } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createObject } from "../graph/objects-repo.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * THE S10 SINGLE-WRITER HOLE ON THE CAMPAIGN LOOP, and why it is WORSE here than on the change loop.
 *
 * Sibling of `foreign-origin-batch-starvation.integration.test.ts` (the change-side half, closed by
 * `b61054b`); read that file's header and `candidate-loop-registry.test.ts`'s for the class. This
 * suite measures the OTHER half, which that commit recorded and deliberately left open.
 *
 * THE ASYMMETRY IS THE WHOLE POINT — and it is why "latent" was the right word there and the wrong
 * word here:
 *
 *  - A synced CHANGE never becomes a candidate. `federation/import-repo.ts`'s `object_upsert` branch
 *    explicitly never creates a local `changes` state-machine row, and `listChangeRowsInStates`
 *    INNER JOINs that row — so a foreign-origin change was never in the change loop's candidate set
 *    to begin with (measured in `change-origin-domain.integration.test.ts`'s header).
 *  - A synced CAMPAIGN does. `object_upsert` is TYPE-AGNOSTIC (`const typeId = String(payload.typeId)`)
 *    and `graph/objects-repo.ts`'s `journalEntryKindFor` puts every non-`policy` object on that same
 *    entry kind, so a peer's campaign object rides an ordinary `full`-scope journal and lands here
 *    via `upsertObjectByUrn(..., { federationImport: { originDomainId: exporterDomainId } })` —
 *    a real local `objects` row carrying a FOREIGN `origin_domain_id`.
 *
 * And `listActiveCampaignObjectIds` had no origin predicate while `reconcileOneCampaign` had no
 * origin skip. So this instance compiled a plan for ANOTHER DOMAIN'S campaign and proposed member
 * changes from it — writes with real side effects (rows in `campaign_plans`/`campaign_waves`/
 * `campaign_wave_targets`, brand-new `changes`, a `coordinates` edge off a replica), not merely a
 * scheduling problem. It also bumped the replica's own `objects.updated_at` on every tick, via the
 * round-robin write at the bottom of `reconcileCampaignsOrgTick`.
 *
 * THE FIX IS A FILTER, NOT A MID-LOOP `continue` — the same shape `b61054b` chose for changes, and
 * for the same two reasons. (1) `listActiveCampaignObjectIds` IS capped and ordered (`ORDER BY
 * objects.updated_at ASC LIMIT 25`), so a body-level skip that did not write the row would re-create
 * the batch-starvation property that cost 13 days of production coordination. (2) The remedy used
 * for every other instance of that property — a round-robin `updated_at` bump — is ILLEGAL on a
 * replica, because it is itself a write to a row this domain does not own. Filtering removes the row
 * from the candidate set entirely: nothing is written, nothing is starved, and the campaign rejoins
 * the batch by itself the moment authority returns (the last test below).
 *
 * WHAT THIS SUITE SHOWS WITHOUT THE FIX (mutation-checked — note that it pins the end-to-end
 * outcome, NOT the query predicate specifically; see the note on the first regression test): the
 * foreign campaign compiles a plan on the very first tick and proposes a member change for its
 * target — `expected
 * null, received { id: ..., waves: [...] }`.
 *
 * THE LOCAL CONTROL CAMPAIGN IS NOT DECORATION. Every "did not happen" assertion below would pass
 * just as well if the reconciler were broken, mis-wired, or never ran — the exact "green for the
 * wrong reason" shape this codebase keeps getting burned by. The control proves the same ticks
 * drove a campaign all the way to a proposed member change.
 */
describe("S10 single-writer: this instance must not drive ANOTHER domain's campaign", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;
  /** Emphatically not this instance's own `federation_self.domain_id` — asserted below. */
  const FOREIGN = asTrustDomainId(randomUUID());

  let foreignCampaignId: string;
  let foreignTargetId: string;
  let localCampaignId: string;
  let localTargetId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "foreign-origin-campaign");
    sandbox = new CountingCelSandbox();
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60 * 60_000 });
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  /** A component + a campaign over it, both locally originated for now. */
  async function makeCampaign(label: string): Promise<{ campaignId: string; targetId: string }> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "foreign-origin-campaign",
        name: `${label}-comp`,
        properties: {}
      });
      const campaign = await createObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: org.orgId,
        requestId: "foreign-origin-campaign",
        name: `${label}-campaign`,
        properties: { targets: [component.id], type: "configuration" }
      });
      return { campaignId: campaign.id, targetId: component.id };
    });
  }

  async function tick(times: number): Promise<void> {
    // THE REAL VALUE `reconcileOrgTick` threads in — this org's own `federation_self.domain_id`,
    // resolved the same way production resolves it, not a constant invented by the test. That is
    // what makes the foreign campaign below genuinely foreign RELATIVE TO WHAT THE ENGINE BELIEVES.
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
    for (let i = 0; i < times; i++) {
      await reconcileCampaignsOrgTick(server.deps.db, org.orgId, host, sandbox, selfDomainId);
    }
  }

  async function planFor(campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );
  }

  /** Member changes this campaign actually created: `campaign-reconcile.ts` writes BOTH a
   *  `coordinates` edge from the campaign to the change AND a `changes` row whose `source_ref`
   *  names the campaign. Both are checked — the edge is the graph-visible half and the change row
   *  is the one with real coordination consequences. */
  async function memberChangesOf(campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const edges = await tx
        .select({ toId: relationships.toId })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "coordinates"),
            eq(relationships.fromId, campaignObjectId)
          )
        );
      const rows = await tx
        .select({ objectId: changes.objectId, state: changes.state, sourceRef: changes.sourceRef })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.sourceKind, "campaign")));
      const mine = rows.filter(
        (r) =>
          (r.sourceRef as { campaignObjectId?: string } | null)?.campaignObjectId ===
          campaignObjectId
      );
      return { edges, changes: mine };
    });
  }

  async function objectRow(id: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ updatedAt: objects.updatedAt, origin: objects.originDomainId })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, id)))
    );
    return rows[0]!;
  }

  it("fixture: one campaign is made a read-only replica of a peer's, one stays local", async () => {
    const foreign = await makeCampaign("foreign");
    foreignCampaignId = foreign.campaignId;
    foreignTargetId = foreign.targetId;
    const local = await makeCampaign("local");
    localCampaignId = local.campaignId;
    localTargetId = local.targetId;

    // THE SURGERY, in its own transaction AFTER the creating one committed — the same statement
    // `federation/foreign-origin-writes.integration.test.ts` uses, and byte-for-byte the row state
    // `import-repo.ts`'s `object_upsert` branch produces for a peer-authored campaign object.
    //
    // Only the CAMPAIGN is flipped, not its target component: the target being locally replicated is
    // exactly the shape a `full`-scope sync produces, and it keeps the fixture honest — nothing here
    // is unreachable because a target failed to resolve.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ originDomainId: FOREIGN })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, foreignCampaignId)))
    );

    const self = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      ensureFederationSelf(tx, org.orgId)
    );
    expect(FOREIGN, "the fixture is vacuous if this is our own domain").not.toBe(self.domainId);
    expect((await objectRow(foreignCampaignId)).origin).toBe(FOREIGN);
    expect((await objectRow(localCampaignId)).origin).toBe(self.domainId);

    // Neither has been driven yet.
    expect(await planFor(foreignCampaignId)).toBeNull();
    expect(await planFor(localCampaignId)).toBeNull();
    expect(foreignTargetId).not.toBe(localTargetId);
  }, 120_000);

  it("THE CONTROL: the LOCAL campaign is compiled and fans out a member change (so the ticks below are real)", async () => {
    await tick(3);

    const plan = await planFor(localCampaignId);
    expect(
      plan,
      "the reconciler must actually work, or every assertion in this file is vacuous"
    ).not.toBeNull();
    expect(plan!.waves.length).toBeGreaterThan(0);

    const members = await memberChangesOf(localCampaignId);
    expect(
      members.changes.length,
      "a local campaign proposes one member change per wave target"
    ).toBe(1);
    expect(members.edges.map((e) => e.toId)).toEqual(members.changes.map((c) => c.objectId));
  }, 120_000);

  it("THE REGRESSION: NO plan is compiled for the foreign-origin campaign", async () => {
    // WITHOUT EITHER HALF OF THE FIX this fails: the replica was served in the same batch as the
    // control above and `reconcileOneCampaign` compiled it a plan on tick 1 — writing
    // `campaign_plans`, `campaign_waves` and `campaign_wave_targets` for an object this domain does
    // not own.
    //
    // BE PRECISE ABOUT WHICH HALF THIS PINS, because an earlier version of this comment was wrong
    // and a census that trusted it would have drawn the wrong conclusion. The fix has two parts: the
    // `origin_domain_id` predicate on `listActiveCampaignObjectIds` (the starvation-SAFE remedy) and
    // the defence-in-depth `continue` in the loop body. Removing ONLY the query predicate leaves
    // this whole file green, because the body guard still stops the write. What pins the query
    // predicate is `campaign-active-filter.integration.test.ts`'s S10 arm — verified by mutating
    // each half separately. This file pins the END-TO-END outcome, which either half delivers.
    expect(await planFor(foreignCampaignId)).toBeNull();
  }, 120_000);

  it("THE REGRESSION: NO member change is proposed from it — the side effect that makes this more than a scheduling bug", async () => {
    // The change loop's hole could only starve. This one CREATES COORDINATION: a real M3 Change
    // against a real target, which the ordinary reconcile loop then drives toward an executor
    // trigger. Both halves of the fan-out are asserted absent.
    const members = await memberChangesOf(foreignCampaignId);
    expect(members.changes, "a peer's campaign must not propose changes on this instance").toEqual(
      []
    );
    expect(members.edges, "and must not acquire a `coordinates` edge off a replica").toEqual([]);
  }, 120_000);

  it("SKIP, NOT DRIVE and SKIP, NOT PARK: the replica's own row is untouched — not even the round-robin bump", async () => {
    // The filter must not be mistaken for a licence to do anything ELSE to a replica. In particular
    // `reconcileCampaignsOrgTick` ends every iteration with an UNCONDITIONAL `updated_at` bump
    // (the fix for starvation instance 4), which on a replica is itself an S10 write — one more
    // reason the row has to leave the candidate set rather than be skipped inside the loop.
    const before = await objectRow(foreignCampaignId);
    await tick(3);
    const after = await objectRow(foreignCampaignId);

    expect(after.updatedAt.getTime(), "a bump here would be a write to a row we do not own").toBe(
      before.updatedAt.getTime()
    );
    expect(after.origin, "and nothing may re-stamp its authority either").toBe(FOREIGN);
    expect(await planFor(foreignCampaignId)).toBeNull();
    expect((await memberChangesOf(foreignCampaignId)).changes).toEqual([]);
  }, 120_000);

  it("AUTHORITY RETURNS and the campaign rejoins the batch on its own — the filter is not a park", async () => {
    // The other half of "SKIP, NOT PARK": nothing was written to this row, so handing authority back
    // is the ONLY intervention needed. No park to clear, no re-propose, no plan to reset.
    const self = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      ensureFederationSelf(tx, org.orgId)
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ originDomainId: self.domainId })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, foreignCampaignId)))
    );

    await tick(3);

    const plan = await planFor(foreignCampaignId);
    expect(
      plan,
      "once this domain is authoritative the campaign must drive normally"
    ).not.toBeNull();
    expect((await memberChangesOf(foreignCampaignId)).changes.length).toBe(1);
  }, 120_000);
});

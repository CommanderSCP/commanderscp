import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TrustDomainId } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  campaignPlans,
  campaignWaves,
  campaignWaveTargets,
  changes,
  decisions,
  objects,
  relationships
} from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createObject } from "../graph/objects-repo.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/** THE CAMPAIGN RECONCILER HAD ZERO ADVISORY-LOCK COVERAGE. See docs/coordination.md §79. */
describe("campaign reconciliation is single-flight across concurrent replica ticks", () => {
  let server: TestServer;
  let org: TestOrg;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;
  let selfDomainId: TrustDomainId;

  /** Genuinely concurrent replica ticks. Above 1 by enough that a lock that only *usually* holds
   *  loses; below the pg pool's default max so the race is on the lock, not on connections. */
  const CONCURRENT_REPLICAS = 5;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "campaign-coordination-race");
    sandbox = new CountingCelSandbox();
    // Never auto-succeeds within the test: a member Change that raced to `accepted` mid-assertion
    // would terminalize wave targets under us and make the counts below timing-dependent.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60 * 60_000 });
    selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
  }, 120_000);

  afterAll(async () => {
    await sandbox.stop();
    await server?.close();
  });

  /** A campaign over `targetCount` fresh components. `targetsAsUrns` stores the targets as URNs
   *  instead of ids, which is the shape an IaC-authored campaign really lands in (see
   *  `reconcileOneCampaign`'s normalisation block) and the only shape that exercises the
   *  write-back `updateObject` at all. */
  async function makeCampaign(
    label: string,
    targetCount: number,
    targetsAsUrns = false
  ): Promise<{ campaignId: string; targetIds: string[] }> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const targetIds: string[] = [];
      const stored: string[] = [];
      for (let i = 0; i < targetCount; i++) {
        const component = await createObject(tx, {
          orgId: org.orgId,
          typeId: "component",
          actorObjectId: org.orgId,
          requestId: "campaign-coordination-race",
          name: `${label}-comp-${i}`,
          properties: {}
        });
        targetIds.push(component.id);
        stored.push(targetsAsUrns ? component.urn : component.id);
      }
      const campaign = await createObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: org.orgId,
        requestId: "campaign-coordination-race",
        name: `${label}-campaign`,
        properties: { targets: stored, type: "configuration" }
      });
      return { campaignId: campaign.id, targetIds };
    });
  }

  /** N genuinely concurrent `reconcileCampaignsOrgTick` calls — each opens its own transactions on
   *  its own pooled connections, so the interleaving is real Postgres concurrency and not merely a
   *  JS microtask ordering, exactly like `coordination.integration.test.ts`'s race arms. */
  async function raceTicks(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      Array.from({ length: CONCURRENT_REPLICAS }, () =>
        reconcileCampaignsOrgTick(server.deps.db, org.orgId, host, sandbox, selfDomainId)
      )
    );
  }

  async function plansFor(campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(campaignPlans)
        .where(
          and(
            eq(campaignPlans.orgId, org.orgId),
            eq(campaignPlans.campaignObjectId, campaignObjectId)
          )
        )
    );
  }

  async function waveTargetsFor(campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          id: campaignWaveTargets.id,
          targetObjectId: campaignWaveTargets.targetObjectId,
          memberChangeObjectId: campaignWaveTargets.memberChangeObjectId
        })
        .from(campaignWaveTargets)
        .innerJoin(campaignWaves, eq(campaignWaveTargets.waveId, campaignWaves.id))
        .innerJoin(campaignPlans, eq(campaignWaves.planId, campaignPlans.id))
        .where(
          and(
            eq(campaignWaveTargets.orgId, org.orgId),
            eq(campaignPlans.campaignObjectId, campaignObjectId)
          )
        )
    );
  }

  /** Both halves of a fan-out, because the pre-lock bug wrote both: the `coordinates` edge and the
   *  `changes` row whose `source_ref` names the campaign. */
  async function memberChangesFor(campaignObjectId: string) {
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
        .select({ objectId: changes.objectId, sourceRef: changes.sourceRef })
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

  async function campaignObjectRow(campaignObjectId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, campaignObjectId)))
    );
    return rows[0]!;
  }

  async function blockDecisionsFor(campaignObjectId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          kind: decisions.kind,
          verdict: decisions.verdict,
          reasonTree: decisions.reasonTree
        })
        .from(decisions)
        .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, campaignObjectId)))
    );
  }

  it("N concurrent ticks racing the SAME unplanned campaign: exactly ONE plan, ONE wave target per target, ONE member change per target", async () => {
    const { campaignId, targetIds } = await makeCampaign("race", 3);

    const settled = await raceTicks();

    // THE LOSERS DID NOT THROW. `reconcileCampaignsOrgTick` swallows per-campaign errors into
    // `logCampaignError`, so a rejected tick would mean the loop itself blew up — but the swallowed
    // case is covered separately by the "no plan_diff block Decision" arm below, so both halves of
    // "backed off cleanly" are actually checked rather than one standing in for the other.
    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);

    // THE DEFINITIVE PROOF, and a hard COUNT rather than "the latest one looks right":
    // `getLatestCampaignPlan` serves one row however many exist, so only a count can see this bug.
    const plans = await plansFor(campaignId);
    expect(plans).toHaveLength(1);

    // The observable symptom the duplicate plan produces one layer down — the campaign-side twin of
    // the change-side race's "two distinct waveIds for the same targetObjectId".
    const waveTargets = await waveTargetsFor(campaignId);
    expect(waveTargets).toHaveLength(targetIds.length);
    expect([...new Set(waveTargets.map((t) => t.targetObjectId))].sort()).toEqual(
      [...targetIds].sort()
    );

    // And the layer below THAT: real Changes, minted by the SYSTEM actor, one per target. A
    // duplicate plan fans out a second set — a second real coordination intent per component.
    const { edges, changes: members } = await memberChangesFor(campaignId);
    expect(members).toHaveLength(targetIds.length);
    expect(edges).toHaveLength(targetIds.length);
    expect([...new Set(edges.map((e) => e.toId))]).toHaveLength(targetIds.length);

    // NOT VACUOUS: the ticks really drove this campaign rather than all backing off. Without this
    // every count above would pass just as well against a reconciler that never ran.
    expect(waveTargets.every((t) => t.memberChangeObjectId !== null)).toBe(true);
  }, 60_000);

  it("the campaign's own normalisation write-back happens exactly ONCE under N concurrent ticks", async () => {
    // The URN-shaped-targets campaign. See docs/coordination.md §80.
    const { campaignId, targetIds } = await makeCampaign("race-urn", 2, true);
    const before = await campaignObjectRow(campaignId);

    const settled = await raceTicks();
    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);

    const after = await campaignObjectRow(campaignId);
    expect(after.version).toBe(before.version + 1);

    // ...and the write it performed was the right one: real ids, not the URNs it was authored with.
    expect((after.properties as { targets: string[] }).targets.sort()).toEqual(
      [...targetIds].sort()
    );
    expect(await plansFor(campaignId)).toHaveLength(1);
  }, 60_000);

  it("the loser is a clean no-op: it neither throws, nor logs a failure, nor records a compile fault", async () => {
    const { campaignId } = await makeCampaign("race-clean", 2);

    // Every per-campaign failure funnels through one logger. See docs/coordination.md §81.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let settled: PromiseSettledResult<void>[];
    let campaignErrorLines: string[];
    try {
      settled = await raceTicks();
      campaignErrorLines = errorSpy.mock.calls
        .map((args) => args.map((a) => String(a)).join(" "))
        .filter((line) => line.includes("[campaign-reconcile]"));
    } finally {
      errorSpy.mockRestore();
    }

    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
    expect(campaignErrorLines).toEqual([]);

    // The compile catch is the campaign-side catch-and-cancel. See docs/coordination.md §82.
    const written = await blockDecisionsFor(campaignId);
    expect(written.filter((d) => d.kind === "plan_diff" && d.verdict === "block")).toEqual([]);

    // NOT VACUOUS: the campaign really was driven — a `gate` allow Decision for its first wave
    // exists, so "no plan_diff block" is a statement about a reconciler that ran.
    expect(written.some((d) => d.kind === "gate")).toBe(true);
  }, 60_000);
});

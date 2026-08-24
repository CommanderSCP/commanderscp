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

/**
 * THE CAMPAIGN RECONCILER HAD ZERO ADVISORY-LOCK COVERAGE (`campaign-coordination-lock.ts`) — the
 * second home of the property `change-coordination-lock.ts` closed on the change side back in M8,
 * left behind because the fix was made where the symptom appeared rather than everywhere the
 * property lived (CLAUDE.md, "census by property, not by symptom").
 *
 * `reconcileOneCampaign` reads the latest plan in one transaction and, on `null`, compiles and
 * persists one in a second. The Helm chart's default is `worker replicaCount=2` and every 1 s tick
 * runs this loop, so two overlapping ticks reading `null` is the ordinary case.
 *
 * AND THE CAMPAIGN SIDE HAD NO BACKSTOP AT ALL, which is why this is worse than the change-side
 * original rather than a copy of it. `campaign_plans` carries a plain btree index on
 * `(org_id, campaign_object_id)` and NO unique constraint (drizzle/0011_campaigns.sql:40), and a
 * campaign has no transition-guarded state machine to serialise on (`campaign-status.ts`). Nothing
 * throws. Both racing ticks COMMIT a complete plan — two `campaign_plans` rows, two full sets of
 * waves and wave targets, and (because each set fans out) two member Changes per target with two
 * `coordinates` edges. The change side at least produced a loud wrongful cancel; this produced
 * silence.
 *
 * ## Why the assertions are hard COUNTS
 *
 * Every duplicate-row bug of this shape passes a "the latest one looks right" check —
 * `getLatestCampaignPlan` serves exactly one row by `(created_at DESC, id DESC)` no matter how many
 * exist. So each arm counts rows, mirroring `coordination.integration.test.ts`'s
 * `evaluated->coordinated` race arm ("exactly ONE plan is ever persisted", `expect(plans).toHaveLength(1)`).
 *
 * ## Why there is no wrongful-cancel arm
 *
 * Stated plainly rather than implied: the campaign path has NO equivalent of the change side's
 * catch-and-cancel fallback, so the lock closes nothing of that kind here. `reconcileOneCampaign`'s
 * compile `catch` writes a `plan_diff` block Decision through `insertDecisionIfChanged` and returns
 * — a campaign has no `cancelled` state to be wrongfully moved to. What the two paths DO share is
 * the duplicate-plan half, and the "loser is a clean no-op, not a compile failure" property: the
 * third arm below asserts the race leaves NO `plan_diff` block Decision behind, which is the
 * campaign-shaped version of "never wrongfully cancelled".
 */
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
    // The URN-shaped-targets campaign — the IaC-authored shape, and the only one whose compile path
    // reaches the `updateObject` that rewrites the campaign's own `properties.targets`. That write
    // bumps `objects.version` unconditionally (`objects-repo.ts`: `existing.version + 1`, with no
    // content-hash short-circuit and no `expectedVersion` guard on this call), so the version is a
    // direct, mutation-visible count of how many ticks performed it.
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

    // EVERY per-campaign failure in this file funnels through `logCampaignError`, which is the ONLY
    // place `reconcileCampaignsOrgTick`'s swallowed errors become visible at all — so a spy on
    // `console.error` is the assertion that a losing tick "did not throw" in the sense that
    // actually matters. Measured against the lock-removed mutant, the losers really do land here:
    //   `[campaign-reconcile] ... target ... propose failed (will retry next tick): ... 409
    //    urn 'urn:scp:...:change:race-clean-campaign-race-clean-comp-1' is already in use`
    // — a duplicate plan fanning the same target out twice and colliding on the member change's
    // deterministic URN.
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

    // `reconcileOneCampaign`'s compile `catch` is the campaign-side analogue of the change side's
    // catch-and-cancel: it records the failure as a `plan_diff` block Decision and retries. A tick
    // that lost the race must never land there — losing a race is not a compilation fault. (The
    // change side proved the same property by asserting the change never reached `cancelled`; a
    // campaign has no `cancelled` state, so this Decision is where the equivalent damage would show.)
    //
    // HONEST ABOUT ITS OWN STRENGTH: this half alone SURVIVED the lock-removal mutant, and that is
    // a true fact about the code rather than a weak test — the duplicate plans commit cleanly and
    // the damage surfaces one layer later, at the fan-out, which is what the log assertion above
    // catches. Kept because it pins the direction the fix must never drift in (a lock whose loser
    // fell into the compile catch would be the change-side wrongful-cancel bug, re-created).
    const written = await blockDecisionsFor(campaignId);
    expect(written.filter((d) => d.kind === "plan_diff" && d.verdict === "block")).toEqual([]);

    // NOT VACUOUS: the campaign really was driven — a `gate` allow Decision for its first wave
    // exists, so "no plan_diff block" is a statement about a reconciler that ran.
    expect(written.some((d) => d.kind === "gate")).toBe(true);
  }, 60_000);
});

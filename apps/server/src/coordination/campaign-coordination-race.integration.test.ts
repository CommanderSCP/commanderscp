import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { campaignPlans } from "../db/schema.js";
import { CountingCelSandbox } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { proposeCampaign } from "./campaign-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * §4-A2 — the campaign-reconcile coordination lock, under GENUINE multi-replica concurrency. Before
 * the lock, two worker replicas' overlapping ticks both saw "no plan yet" for the SAME campaign and
 * both `compileAndPersistCampaignPlan` — a duplicate `campaign_plans` row (and its waves/targets).
 * This is the campaign twin of the change-path coordination-lock race test: N genuinely concurrent
 * first-ticks against one fresh campaign must compile EXACTLY ONE plan.
 */
describe("campaign reconcile: plan compilation is single-flight under real multi-replica concurrency (§4-A2)", () => {
  let server: TestServer;
  let sandbox: CountingCelSandbox;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    sandbox = new CountingCelSandbox();
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 });
  }, 90_000);

  afterAll(async () => {
    await sandbox.stop();
    await server.close();
  });

  async function inject(
    org: TestOrg,
    url: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  it("N concurrent first-ticks against ONE fresh campaign compile EXACTLY ONE plan (no duplicate)", async () => {
    const org = await createTestOrg(server, "campaign-race");
    const owner = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;

    const ITERATIONS = 6;
    const CONCURRENT_TICKS = 8;
    const planCounts: number[] = [];

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const service = await inject(org, "/api/v1/services", { name: `svc-race-${iter}` });
      const component = await inject(org, "/api/v1/components", {
        name: `comp-race-${iter}`,
        service: service.id
      });
      const campaignObjectId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        const { campaign } = await proposeCampaign(tx, {
          orgId: org.orgId,
          actorObjectId: owner.objectId,
          requestId: `campaign-race-${iter}`,
          name: `race-campaign-${iter}`,
          targets: [component.id as string]
        });
        return campaign.id;
      });

      // GENUINELY concurrent ticks (Promise.all, real independent transactions) all racing to compile
      // this campaign's first plan — the exact multi-replica overlap the lock exists to make safe.
      await Promise.all(
        Array.from({ length: CONCURRENT_TICKS }, () =>
          reconcileCampaignsOrgTick(server.deps.db, org.orgId, host, sandbox, selfDomainId)
        )
      );

      const plans = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select({ id: campaignPlans.id })
          .from(campaignPlans)
          .where(
            and(
              eq(campaignPlans.orgId, org.orgId),
              eq(campaignPlans.campaignObjectId, campaignObjectId)
            )
          )
      );
      planCounts.push(plans.length);
    }

    // EXACTLY ONE plan per campaign, every iteration — a duplicate would be 2+ here.
    expect(planCounts.every((c) => c === 1)).toBe(true);
  }, 120_000);
});

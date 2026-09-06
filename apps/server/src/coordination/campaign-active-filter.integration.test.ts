import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { campaignPlans } from "../db/schema.js";
import { listActiveCampaignObjectIds } from "./campaign-repo.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/**
 * `listActiveCampaignObjectIds` promised "every non-terminal campaign" in its doc and delivered
 * "every campaign that exists" in its WHERE clause — `org_id` + `type_id` + `deleted_at IS NULL`
 * and nothing else. Every campaign whose plan had `completed` months ago was still fetched on every
 * 1s tick, forever, for `reconcileOneCampaign` to early-return on.
 *
 * WHY THE FILTER IS THE DANGEROUS KIND OF FIX, and why this suite is heavier than the change looks.
 * The obvious predicate — "the campaign has no terminal plan" — is WRONG, because a campaign can
 * hold several plans: a re-plan INSERTS a new row rather than mutating the old one. A campaign that
 * completed one plan and was then re-planned has a terminal plan AND a live one, and the naive
 * predicate would strand it: excluded from the reconciler's batch permanently, driving nothing,
 * reporting nothing. Over-inclusion (the old bug) costs a batch slot. WRONG EXCLUSION LOSES A LIVE
 * CAMPAIGN SILENTLY. The two failure directions are not symmetric, so the test for the second one
 * is the point of this file — see "RE-PLANNED" below.
 *
 * The tie arm is the other half. `campaign_plans.created_at` defaults to `now()`, which in Postgres
 * is TRANSACTION time — two plans written in one transaction carry a byte-identical timestamp, so
 * "the latest plan" was genuinely ambiguous and decided by whatever order the planner returned. The
 * filter and `getLatestCampaignPlan` must resolve that tie THE SAME WAY, or a campaign gets
 * excluded here as terminal while the reader hands the reconciler an active plan. Both now order by
 * `(created_at DESC, id DESC)`.
 *
 * THE QUERY LATER GAINED A SECOND, UNRELATED PREDICATE — S10 single-writer, `origin_domain_id =
 * self` — for which the asymmetry above runs the other way: over-inclusion there is not a wasted
 * batch slot, it is this instance compiling a plan for a PEER'S campaign and proposing member
 * changes from it. Its arm is the last test in this file; the end-to-end consequence lives in
 * `foreign-origin-campaign.integration.test.ts`.
 */
describe("listActiveCampaignObjectIds: the LATEST plan decides, and it agrees with getLatestCampaignPlan", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "campaign-active-filter");
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  async function post(url: string, payload: Record<string, unknown>) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  /** A campaign over one freshly-created target, created through the real HTTP route — the same
   *  path `POST /api/v1/campaigns` takes in production, so authorization is exercised rather than
   *  bypassed. (Calling `proposeCampaign` directly with the org-root actor 403s: it authorizes per
   *  target, deliberately.) */
  async function makeCampaign(label: string): Promise<string> {
    const service = await post("/api/v1/services", { name: `svc-${label}` });
    const campaign = await post("/api/v1/campaigns", {
      name: `camp-${label}`,
      targets: [service.id as string]
    });
    return campaign.id as string;
  }

  /** Inserts a plan row directly — the only way to build the multi-plan and same-transaction-tie
   *  shapes this suite needs. `createdAt` is explicit so ordering is controlled, not raced. */
  async function insertPlan(
    campaignObjectId: string,
    status: "active" | "completed" | "aborted",
    createdAt: Date,
    id = uuidv7()
  ): Promise<string> {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(campaignPlans).values({
        id,
        orgId: org.orgId,
        campaignObjectId,
        topologyObjectId: null,
        topologyVersion: null,
        topologyDocument: null,
        status,
        createdAt
      })
    );
    return id;
  }

  async function selfDomainId() {
    return (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
  }

  async function activeIds(): Promise<Set<string>> {
    const self = await selfDomainId();
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listActiveCampaignObjectIds(tx, org.orgId, 100, self)
    );
    return new Set(rows.map((r) => r.id));
  }

  it("a campaign with NO plan yet is included — it is exactly the one that still needs compiling", async () => {
    const id = await makeCampaign("noplan");
    expect(await activeIds()).toContain(id);
  });

  it("a campaign whose only plan is active is included", async () => {
    const id = await makeCampaign("active");
    await insertPlan(id, "active", new Date("2026-01-01T00:00:00Z"));
    expect(await activeIds()).toContain(id);
  });

  it("a campaign whose LATEST plan is completed is EXCLUDED — the wasted work this fix removes", async () => {
    const id = await makeCampaign("done");
    await insertPlan(id, "completed", new Date("2026-01-01T00:00:00Z"));
    expect(await activeIds()).not.toContain(id);
  });

  it("...and the same for an aborted plan", async () => {
    const id = await makeCampaign("aborted");
    await insertPlan(id, "aborted", new Date("2026-01-01T00:00:00Z"));
    expect(await activeIds()).not.toContain(id);
  });

  it("RE-PLANNED: a completed plan followed by a NEWER active one is INCLUDED — the arm a naive `has no terminal plan` predicate fails", async () => {
    // The asymmetric-risk case. Over-including a finished campaign wastes a batch slot; excluding
    // this one strands a live campaign that drives nothing and reports nothing. If anyone ever
    // "simplifies" the filter to NOT EXISTS(terminal plan), THIS is the test that goes red.
    const id = await makeCampaign("replanned");
    await insertPlan(id, "completed", new Date("2026-01-01T00:00:00Z"));
    await insertPlan(id, "active", new Date("2026-02-01T00:00:00Z"));

    expect(await activeIds()).toContain(id);

    // And the reader agrees the live plan is the one in force — the filter is not merely permissive
    // by accident.
    const latest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, id)
    );
    expect(latest?.status).toBe("active");
  });

  it("the reverse order still excludes: an active plan followed by a NEWER completed one", async () => {
    const id = await makeCampaign("finished-after-replan");
    await insertPlan(id, "active", new Date("2026-01-01T00:00:00Z"));
    await insertPlan(id, "completed", new Date("2026-02-01T00:00:00Z"));
    expect(await activeIds()).not.toContain(id);
  });

  it("SAME-TRANSACTION TIE: the filter and getLatestCampaignPlan pick the SAME plan, so a campaign is never excluded here while the reader calls it active", async () => {
    // `created_at` defaults to `now()` = TRANSACTION time, so this shape is reachable in production
    // whenever two plans are written in one transaction. Identical timestamps, distinct UUIDv7 ids;
    // `id DESC` is the tiebreak BOTH sides now use.
    const sameInstant = new Date("2026-03-01T00:00:00Z");
    const olderId = uuidv7();
    const newerId = uuidv7();

    const tiedActive = await makeCampaign("tie-active");
    await insertPlan(tiedActive, "completed", sameInstant, olderId);
    await insertPlan(tiedActive, "active", sameInstant, newerId);

    // Mirror image: same tied instant, but the TERMINAL row carries the higher id (minted second),
    // so the tiebreak must resolve the other way.
    const tiedDone = await makeCampaign("tie-done");
    await insertPlan(tiedDone, "active", sameInstant, uuidv7());
    await insertPlan(tiedDone, "completed", sameInstant, uuidv7());

    const ids = await activeIds();
    const latestActive = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, tiedActive)
    );
    const latestDone = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, tiedDone)
    );

    // THE INVARIANT, stated directly rather than as two independent expectations: inclusion in the
    // batch must be exactly "the reader's latest plan is not terminal". Any disagreement here is a
    // campaign the reconciler either strands or spins on.
    const terminal = (s: string | undefined) => s === "completed" || s === "aborted";
    expect(ids.has(tiedActive)).toBe(!terminal(latestActive?.status));
    expect(ids.has(tiedDone)).toBe(!terminal(latestDone?.status));

    // And concretely, given UUIDv7 ordering: the later-minted row wins on both sides.
    expect(latestActive?.status).toBe("active");
    expect(ids).toContain(tiedActive);
    expect(latestDone?.status).toBe("completed");
    expect(ids).not.toContain(tiedDone);
  });

  it("a soft-deleted campaign stays excluded even with an ACTIVE plan — the pre-existing guard still composes with the new one", async () => {
    const id = await makeCampaign("deleted");
    await insertPlan(id, "active", new Date("2026-01-01T00:00:00Z"));
    expect(await activeIds()).toContain(id);

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(sql`update objects set deleted_at = now() where id = ${id}`)
    );
    expect(await activeIds()).not.toContain(id);
  });

  it("S10: a FOREIGN-ORIGIN campaign is excluded even with an ACTIVE plan, and returns the moment authority does", async () => {
    // The second predicate this query carries, at the query level — the end-to-end consequence (no
    // plan compiled, no member changes proposed) is measured in
    // `foreign-origin-campaign.integration.test.ts`. Both are worth having: this one pins WHERE the
    // exclusion happens, which is the whole design decision. A mid-loop `continue` would leave this
    // test red while the engine still behaved correctly, and that is the point — a body-level skip
    // re-creates the batch-starvation property, because this query is `ORDER BY updated_at ASC
    // LIMIT n` and a skipped row's `updated_at` never moves.
    const id = await makeCampaign("replica");
    await insertPlan(id, "active", new Date("2026-01-01T00:00:00Z"));
    expect(await activeIds()).toContain(id);

    const foreign = randomUUID();
    expect(foreign, "a vacuous fixture if this is our own domain").not.toBe(await selfDomainId());
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(sql`update objects set origin_domain_id = ${foreign}::uuid where id = ${id}`)
    );
    expect(await activeIds()).not.toContain(id);

    // NOT PARKED, merely filtered: handing authority back is the only intervention needed.
    const self = await selfDomainId();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(sql`update objects set origin_domain_id = ${self}::uuid where id = ${id}`)
    );
    expect(await activeIds()).toContain(id);
  });
});

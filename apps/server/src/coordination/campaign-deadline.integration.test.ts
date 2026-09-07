import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, campaignWaveTargets, changes, decisions } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { updateObject } from "../graph/objects-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import {
  upsertComponentDependency,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import { evaluateCampaignAdoption } from "./campaign-adoption.js";
import {
  CAMPAIGN_DEADLINE_DECISION_KIND,
  CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_SET_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_SET_DECISION_KIND,
  evaluateCampaignDeadlineLock
} from "./campaign-deadline-lock.js";
import type { CampaignDeadline, CampaignRecipe } from "@scp/schemas";

/** The deadline-triggered campaign lock, end to end. See docs/coordination.md §123. */

const PY_COORDINATE = "docker.io/library/python";

/** Adoption evidence a `pending` target can never satisfy — §4.4's "very nearly a no-op" default,
 *  used where the point is the LOCK rather than the escape from it. */
const DELIVERED_RECIPE: CampaignRecipe = {
  version: 1,
  trigger: { kind: "sync" },
  adoption: { kind: "delivered" }
};

/** The evidence kind that actually gives the lock force (§4.4 situation (i)): a fact observed
 *  OUTSIDE the campaign's own fan-out, so a target can be adopted without the campaign having
 *  reached it. */
const DEPENDENCY_RECIPE: CampaignRecipe = {
  version: 1,
  trigger: { kind: "sync" },
  adoption: {
    kind: "dependency",
    ecosystem: "oci",
    coordinate: PY_COORDINATE,
    minVersion: "3.0"
  }
};

describe("campaign deadline lock: this campaign's changes only (M25.6a / D4)", () => {
  let server: TestServer;
  let host: PluginHost;

  beforeAll(async () => {
    server = await buildTestServer();
    // Long auto-succeed so a member change that IS minted stays durably in flight rather than
    // racing the assertions to completion.
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 10 * 60_000 });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function post(
    org: TestOrg,
    url: string,
    payload: Record<string, unknown>,
    token = org.adminToken
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  async function fixture(
    label: string,
    componentCount = 1
  ): Promise<{ org: TestOrg; componentIds: string[] }> {
    const org = await createTestOrg(server, label);
    const service = await post(org, "/api/v1/services", { name: `svc-${label}` });
    const componentIds: string[] = [];
    for (let i = 0; i < componentCount; i++) {
      const component = await post(org, "/api/v1/components", {
        name: `comp-${label}-${i}`,
        service: service.id
      });
      componentIds.push(component.id as string);
    }
    return { org, componentIds };
  }

  /** `opts.now` IS THREADED THROUGH EVERY TICK IN THIS FILE. See docs/coordination.md §124. */
  async function tick(org: TestOrg, times: number, now: Date): Promise<void> {
    const selfDomainId = (
      await withTenantTx(server.deps.db, org.orgId, (tx) => ensureFederationSelf(tx, org.orgId))
    ).domainId;
    for (let i = 0; i < times; i++) {
      await reconcileCampaignsOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        selfDomainId,
        { now }
      );
    }
  }

  const planFor = (org: TestOrg, campaignObjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestCampaignPlan(tx, org.orgId, campaignObjectId)
    );

  const changeCount = async (org: TestOrg): Promise<number> => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ n: count() }).from(changes).where(eq(changes.orgId, org.orgId))
    );
    return Number(rows[0]?.n ?? 0);
  };

  const decisionsOfKind = (org: TestOrg, subjectId: string, kind: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, kind)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  const auditsOfAction = (org: TestOrg, action: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.action, action)))
        .orderBy(auditEvents.seq)
    );

  /** What is ACTUALLY STORED on the campaign object, read off `objects.properties` rather than off a
   *  response body: a refused write that half-applied would be worse than one that 403s, and only the
   *  row can say. */
  const storedDeadlineOf = async (org: TestOrg, campaignObjectId: string): Promise<unknown> => {
    const row = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.query.objects.findFirst({ where: (t, { eq: eqOp }) => eqOp(t.id, campaignObjectId) })
    );
    return (row!.properties as { deadline?: unknown }).deadline;
  };

  /** Seed one manifest declaration — the same two verbs `dependencies/inventory-ingestion.ts` uses
   *  when it re-reads a repository, so these rows are the shape ingestion actually writes. */
  async function declare(
    org: TestOrg,
    componentObjectId: string,
    input: { major: string; declaredVersion: string; resolvedVersion: string }
  ): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, {
        ecosystem: "oci",
        coordinate: PY_COORDINATE,
        major: input.major
      });
      await upsertComponentDependency(tx, org.orgId, {
        componentObjectId,
        lineId: line.id,
        manifestPath: "Dockerfile",
        declaredVersion: input.declaredVersion,
        resolvedVersion: input.resolvedVersion
      });
    });
  }

  /** A YEAR OUT, deliberately: a deadline a real migration campaign would carry, and one no test
   *  could ever reach by waiting. */
  function futureDeadline(): { deadline: CampaignDeadline; before: Date; after: Date } {
    const at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    return {
      deadline: { at: at.toISOString() },
      before: new Date(),
      after: new Date(at.getTime() + 1_000)
    };
  }

  // W — THE ACTUATOR (proposal §4.3, actuator-table row 12). THE MUTATION TARGET.

  /** TWO TARGETS, A PAST DEADLINE, ONE OF THEM ADOPTED. See docs/coordination.md §125. */
  it("W: past the deadline, the unmigrated target gets NO member Change while its delivered sibling keeps its own", async () => {
    const { org, componentIds } = await fixture("deadline-w", 2);
    const [b, a] = componentIds as [string, string];
    const { deadline, before, after } = futureDeadline();

    // `depends_on`: A depends on B, so B is wave 0 and A is wave 1.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "campaign-deadline-test",
        typeId: "depends_on",
        fromId: a,
        toId: b
      })
    );

    const campaign = await post(org, "/api/v1/campaigns", {
      name: "python3-migration",
      targets: [b, a],
      recipe: DELIVERED_RECIPE,
      deadline
    });
    const campaignId = campaign.id as string;
    // The create-time authoring door round-trips: the deadline is on the response, not merely
    // accepted and dropped.
    expect(campaign.deadline).toEqual(deadline);

    // ---- PHASE 1: the deadline is NOT DUE. The campaign behaves exactly as it would without one.
    await tick(org, 2, before);
    let plan = await planFor(org, campaignId);
    expect(plan!.waves).toHaveLength(2);
    expect(plan!.waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([b]);
    expect(plan!.waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([a]);
    const bMemberChangeObjectId = plan!.waves[0]!.targets[0]!.memberChangeObjectId;
    expect(bMemberChangeObjectId, "a not-yet-due deadline must withhold nothing").not.toBeNull();
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND)).toHaveLength(0);

    // B's member change is delivered — its campaign wave target reaches `succeeded`, which is what
    // `delivered` evidence reads. (Driven directly: what is under test is the deadline seam, not the
    // member-change lifecycle `campaign.integration.test.ts` already covers end to end.)
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(campaignWaveTargets)
        .set({ status: "succeeded" })
        .where(
          and(
            eq(campaignWaveTargets.orgId, org.orgId),
            eq(campaignWaveTargets.id, plan!.waves[0]!.targets[0]!.id)
          )
        )
    );

    // ---- PHASE 2: the deadline has passed. Wave 0 terminalizes, wave 1 starts, A is locked out.
    await tick(org, 3, after);

    expect(
      await changeCount(org),
      "the locked target must have NO member Change minted for it"
    ).toBe(1);

    plan = await planFor(org, campaignId);
    expect(plan!.waves[0]!.status).toBe("succeeded");
    const lockedTarget = plan!.waves[1]!.targets[0]!;
    expect(lockedTarget.memberChangeObjectId).toBeNull();
    // NOTHING IS WRITTEN TO THE TARGET ROW — the lock is re-derived every tick from
    // `(deadline.at, adoption)`, which is what makes a late adoption or a moved deadline clear it
    // with no unlock verb.
    expect(lockedTarget.status).toBe("pending");
    // §4.6, stated rather than changed: siblings ship, the wave never terminalizes, later waves
    // never start.
    expect(plan!.waves[1]!.status).toBe("running");
    expect(plan!.status).toBe("active");

    // THE PREMISE, ASSERTED RATHER THAN ASSUMED: B really is `adopted`, so "B was not locked" is a
    // statement about the predicate rather than about which branch happened to run.
    const bAdoption = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateCampaignAdoption(tx, org.orgId, campaignId, b, DELIVERED_RECIPE)
    );
    expect(bAdoption.verdict).toBe("adopted");

    // ---- THE RECORD: one Decision naming A and not B, one audit event.
    const lockDecisions = await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND);
    expect(lockDecisions).toHaveLength(1);
    expect(lockDecisions[0]!.verdict).toBe("block");

    const context = lockDecisions[0]!.inputContext as Record<string, unknown>;
    // AN EXACT KEY CENSUS, not "does not contain `now`": a census fails when a NEW clock-shaped key
    // is added, which is how ADR-0024's 1.44 GB/day defect actually arrives.
    expect(Object.keys(context).sort()).toEqual(["deadlineAt", "locked", "waveId", "waveIndex"]);
    expect(context.deadlineAt).toBe(deadline.at);
    expect(context.locked).toEqual([{ targetObjectId: a, adoptionVerdict: "not_adopted" }]);
    expect(JSON.stringify(lockDecisions[0]!)).not.toContain(b);

    const audits = await auditsOfAction(org, CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decisionId).toBe(lockDecisions[0]!.id);
    expect(audits[0]!.reason).toContain(a);
  });

  /** THE RADIUS, ASSERTED DIRECTLY. See docs/coordination.md §126. */
  it("W-radius: a locked component still accepts an UNRELATED change — including a security fix", async () => {
    const { org, componentIds } = await fixture("deadline-radius");
    const [component] = componentIds as [string];
    const { deadline, after } = futureDeadline();

    // No inventory is ever seeded, so this component's adoption is `unknown` — locked from the very
    // first tick past the deadline, with no member change ever minted for it.
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "locked-campaign",
      targets: [component],
      recipe: DEPENDENCY_RECIPE,
      deadline
    });
    const campaignId = campaign.id as string;

    await tick(org, 3, after);
    expect(await changeCount(org), "the campaign's own change must be withheld").toBe(0);
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND)).toHaveLength(1);

    // ===========================================================================================
    // THE RADIUS (owner decision D4). This is the assertion that would fail the day anyone
    // re-implements the lock through `checkFreeze`.
    // ===========================================================================================
    const unrelated = await post(org, "/api/v1/changes", {
      name: "CVE-2026-0001 hotfix",
      targets: [component]
    });
    expect(unrelated.id).toBeTruthy();
    expect(
      await changeCount(org),
      "a component locked out of ONE campaign must still accept unrelated releases"
    ).toBe(1);
    // ...and it is an ordinary change: nothing about the campaign's lock reached it.
    expect(
      await decisionsOfKind(org, unrelated.id as string, CAMPAIGN_DEADLINE_DECISION_KIND)
    ).toHaveLength(0);
  });

  // THE PREDICATE OVER THE **REAL** RESOLUTION CORE — all three verdicts, real PostgreSQL

  /** The unit test stubs adoption; this one does not. See docs/coordination.md §127. */
  it("P: `adopted` is the only exit — a component at 3.12 is not locked; 2.7 and never-ingested are", async () => {
    const { org, componentIds } = await fixture("deadline-predicate", 3);
    const [migrated, laggard, uningested] = componentIds as [string, string, string];
    const { deadline, after } = futureDeadline();

    await declare(org, migrated, {
      major: "3",
      declaredVersion: "3.12-slim",
      resolvedVersion: "3.12-slim"
    });
    await declare(org, laggard, {
      major: "2",
      declaredVersion: "2.7-slim",
      resolvedVersion: "2.7-slim"
    });

    const campaign = await post(org, "/api/v1/campaigns", {
      name: "python3-migration",
      targets: [migrated, laggard, uningested],
      recipe: DEPENDENCY_RECIPE,
      deadline
    });

    const result = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateCampaignDeadlineLock(tx, {
        orgId: org.orgId,
        campaignObjectId: campaign.id as string,
        targetObjectIds: [migrated, laggard, uningested],
        deadline,
        at: new Date(deadline.at),
        recipe: DEPENDENCY_RECIPE,
        now: after
      })
    );

    expect(result.locked.map((l) => [l.targetObjectId, l.adoptionVerdict])).toEqual([
      [laggard, "not_adopted"],
      // NEVER INGESTED IS `unknown` AND STILL LOCKED. "We did not look" is not evidence of
      // migration, and treating it as one would waive the deadline for every component in an estate
      // that has not wired inventory ingestion — failing open at precisely the largest scale.
      [uningested, "unknown"]
    ]);
  });

  // FAIL OPEN, LOUDLY (§4.2)

  /** A MALFORMED BAG LOCKS NOTHING AND SAYS SO. See docs/coordination.md §128. */
  it("M: an unreadable deadline withholds NOTHING and records ONE `warn` — deduped across ticks", async () => {
    const { org, componentIds } = await fixture("deadline-malformed");
    const [component] = componentIds as [string];
    const { after } = futureDeadline();

    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-with-a-typo",
      targets: [component],
      recipe: DELIVERED_RECIPE
    });
    const campaignId = campaign.id as string;

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await tx.query.objects.findFirst({
        where: (t, { eq: eqOp }) => eqOp(t.id, campaignId)
      });
      await updateObject(tx, {
        orgId: org.orgId,
        typeId: "campaign",
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: "campaign-deadline-test",
        idOrUrn: campaignId,
        properties: {
          ...(row!.properties as Record<string, unknown>),
          deadline: { at: "next Tuesday" }
        }
      });
    });

    await tick(org, 5, after);

    // FAIL OPEN: the target fanned out exactly as it would with no deadline at all.
    expect(await changeCount(org), "an unreadable deadline must withhold nothing").toBe(1);

    // LOUDLY: one row, and it is a `warn` rather than a `block` — nothing is being refused.
    const rows = await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("warn");
    expect(JSON.stringify(rows[0]!.reasonTree)).toContain("unreadable");

    // NO AUDIT EVENT: nothing occurred. A hash-chained event per tick for a standing condition is
    // the shape this whole family exists to refuse.
    expect(await auditsOfAction(org, CAMPAIGN_DEADLINE_LOCK_AUDIT_ACTION)).toHaveLength(0);

    // ...and the READ surface degrades honestly: an unreadable document reads as "no deadline",
    // which agrees with the actuator about the only thing an operator can act on — nothing is being
    // withheld.
    const read = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { deadline: unknown }).deadline).toBeNull();
  });

  // THE ESCAPE HATCH — `POST /campaigns/{id}/deadline`, set / move / CLEAR

  /** Clearing the deadline unlocks every target, no verb. See docs/coordination.md §129. */
  /** The deadline here is in the real past, deliberately. See docs/coordination.md §130. */
  it("E: clearing the deadline releases a locked target on the next tick — the exit, with no unlock verb", async () => {
    const { org, componentIds } = await fixture("deadline-clear");
    const [component] = componentIds as [string];
    const deadline: CampaignDeadline = { at: new Date(Date.now() - 60_000).toISOString() };

    // Never ingested => `unknown` => locked. (Not `not_adopted`: nothing was observed at all, which
    // is a different fact and still never a pass.)
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-to-be-released",
      targets: [component],
      recipe: DEPENDENCY_RECIPE,
      deadline
    });
    const campaignId = campaign.id as string;

    await tick(org, 3, new Date());
    expect(await changeCount(org)).toBe(0);
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND)).toHaveLength(1);

    // ...and the campaign SAYS SO. Without this the lever works and the signal is missing — the
    // exact inverse of the postmortem that cost a previous proposal its approval (§4.6).
    const blocked = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect((blocked.json() as { status: string; deadline: unknown }).status).toBe("blocked");
    expect((blocked.json() as { deadline: unknown }).deadline).toEqual(deadline);

    const cleared = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: null,
      reason: "the migration slipped; stop withholding changes while we re-plan"
    });
    expect(cleared.deadline).toBeNull();
    // The response's own status is re-derived through the same predicate, so the call that lifts the
    // lock reports it lifted rather than echoing the pre-write state.
    expect(cleared.status).not.toBe("blocked");

    await tick(org, 1, new Date());
    expect(await changeCount(org), "clearing the deadline must release every locked target").toBe(
      1
    );

    const status = await server.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect((status.json() as { status: string }).status).not.toBe("blocked");

    // THE AUTHORING RECORD: its OWN kind, the previous value beside the new one, and a
    // high-severity audit event citing it.
    const setDecisions = await decisionsOfKind(
      org,
      campaignId,
      CAMPAIGN_DEADLINE_SET_DECISION_KIND
    );
    expect(setDecisions).toHaveLength(1);
    const context = setDecisions[0]!.inputContext as {
      action: string;
      deadline: { from: CampaignDeadline | null; to: CampaignDeadline | null };
      reason: string;
    };
    expect(context.action).toBe("clear");
    expect(context.deadline.from).toEqual(deadline);
    expect(context.deadline.to).toBeNull();
    expect((setDecisions[0]!.reasonTree as { loosening: boolean }).loosening).toBe(true);

    const audits = await auditsOfAction(org, CAMPAIGN_DEADLINE_SET_AUDIT_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decisionId).toBe(setDecisions[0]!.id);
    expect(audits[0]!.reason).toContain("re-plan");
  });

  /** Four slips must be reconstructible from Decisions. See docs/coordination.md §131. */
  it("E2: every MOVE records the PREVIOUS instant, so a slipping deadline is reconstructible", async () => {
    const { org, componentIds } = await fixture("deadline-slip");
    const [component] = componentIds as [string];

    const first = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const second = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const third = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-that-slips",
      targets: [component]
    });
    const campaignId = campaign.id as string;

    for (const [at, why] of [
      [first, "initial plan"],
      [second, "slipped: the platform team is mid-incident"],
      [third, "slipped again: waiting on the vendor"]
    ] as const) {
      await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
        deadline: { at },
        reason: why
      });
    }

    const rows = await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_SET_DECISION_KIND);
    expect(rows).toHaveLength(3);
    const trail = rows.map((r) => {
      const c = r.inputContext as {
        action: string;
        deadline: { from: { at: string } | null; to: { at: string } | null };
      };
      return [c.action, c.deadline.from?.at ?? null, c.deadline.to?.at ?? null];
    });
    expect(trail).toEqual([
      ["set", null, first],
      ["move", first, second],
      ["move", second, third]
    ]);
    // Every one of the three is on the hash chain with the operator's own words.
    const audits = await auditsOfAction(org, CAMPAIGN_DEADLINE_SET_AUDIT_ACTION);
    expect(audits.map((a) => a.reason)).toEqual([
      "initial plan",
      "slipped: the platform team is mid-incident",
      "slipped again: waiting on the vendor"
    ]);
  });

  it("E3: the reason is MANDATORY on all three acts, including the clear", async () => {
    const { org, componentIds } = await fixture("deadline-reason");
    const [component] = componentIds as [string];
    const { deadline } = futureDeadline();
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-needing-a-reason",
      targets: [component],
      deadline
    });

    for (const payload of [
      { deadline: { at: deadline.at } },
      { deadline: { at: deadline.at }, reason: "" },
      { deadline: null }
    ]) {
      const res = await server.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaign.id as string}/deadline`,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("E4: `object:write` is required — a Viewer cannot move a campaign's deadline", async () => {
    const { org, componentIds } = await fixture("deadline-authz");
    const [component] = componentIds as [string];
    const { deadline } = futureDeadline();
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-with-a-deadline",
      targets: [component],
      deadline
    });
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);

    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id as string}/deadline`,
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { deadline: null, reason: "I would like this gone" }
    });
    expect(res.statusCode).toBe(403);

    // ...and the deadline is still standing. A refused write that half-applied would be worse than
    // one that 403s.
    expect(await storedDeadlineOf(org, campaign.id as string)).toEqual(deadline);
  });

  // THE WIDENING GATE — owner ruling 2026-08-25 (decision D1, option b-i)

  /** The bypass this closes, stated as the premise. See docs/coordination.md §132. */
  it("E5: an Operator may SET and SHORTEN a deadline, but CLEARING it or MOVING IT LATER takes `campaign:deadline-override`", async () => {
    const { org, componentIds } = await fixture("deadline-widening");
    const [component] = componentIds as [string];
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-an-operator-runs",
      targets: [component]
    });
    const campaignId = campaign.id as string;
    // `object:write` over every object in the org, and drizzle/0088 grants
    // `campaign:deadline-override` to Owner ALONE — so this subject holds exactly the authority the
    // verb used to require and nothing more.
    const operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);

    // A WHOLE-SECOND BASE, so every instant below renders with `.000` and the equal-value case can
    // restate one of them without its milliseconds.
    const base = Math.floor(Date.now() / 1000) * 1000;
    const day = 24 * 60 * 60 * 1000;
    const far = new Date(base + 90 * day).toISOString();
    const near = new Date(base + 30 * day).toISOString();
    const later = new Date(base + 120 * day).toISOString();

    const asOperator = (payload: Record<string, unknown>) =>
      server.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaignId}/deadline`,
        headers: { authorization: `Bearer ${operator.token}` },
        payload
      });

    // ---- SET, where there was none. A TIGHTENING: strictly more targets are withheld afterwards,
    // so it cannot launder a waiver and it stays at `object:write`. Routine campaign hygiene must not
    // need an Owner.
    const set = await asOperator({ deadline: { at: far }, reason: "this migration needs a date" });
    expect(set.statusCode, set.body).toBe(200);

    const shortened = await asOperator({
      deadline: { at: near },
      reason: "pulling it in, the vendor shipped early"
    });
    expect(shortened.statusCode, shortened.body).toBe(200);

    // ---- RESTATE THE SAME INSTANT, without the milliseconds. NOT a widening: the comparison is on
    // parsed instants, not on the ISO strings. This is the assertion that fails if anyone rewrites
    // the check as a string comparison — `...T00:00:00Z` sorts AFTER `...T00:00:00.000Z`, so a
    // string compare would call an unchanged deadline a slip and 403 an Operator restating it.
    const restated = await asOperator({
      deadline: { at: near.replace(".000Z", "Z") },
      reason: "restating the same instant"
    });
    expect(restated.statusCode, restated.body).toBe(200);

    // ---- MOVE LATER => 403. The act a laggard actually wants, and the one gating only the clear
    // would have left open: "clear it" becomes "move it to 2099".
    const movedLater = await asOperator({
      deadline: { at: later },
      reason: "we would like another three months"
    });
    expect(
      movedLater.statusCode,
      "moving the deadline later releases exactly the targets a clear would"
    ).toBe(403);

    const cleared = await asOperator({
      deadline: null,
      reason: "let us just drop the whole thing"
    });
    expect(
      cleared.statusCode,
      "clearing the deadline excuses EVERY target permanently — it cannot cost less than waiving ONE"
    ).toBe(403);

    // ---- NEITHER REFUSAL HALF-APPLIED: what is stored is still the shortened deadline.
    expect(await storedDeadlineOf(org, campaignId)).toEqual({ at: near.replace(".000Z", "Z") });

    // ---- THE CONTROL, AFTER the refusals: the same subject can still TIGHTEN this very campaign's
    // deadline. So the two 403s are about the direction of the write and not about the Operator
    // having lost standing on the campaign somewhere along the way.
    const shortenedAgain = await asOperator({
      deadline: { at: new Date(base + 10 * day).toISOString() },
      reason: "pulling it in again"
    });
    expect(shortenedAgain.statusCode, shortenedAgain.body).toBe(200);
  });

  /** The gate is an addition, never a substitution. See docs/coordination.md §133. */
  it("E6: an Owner does all four — set, shorten, move LATER and clear — through the same verb", async () => {
    const { org, componentIds } = await fixture("deadline-widening-owner");
    const [component] = componentIds as [string];
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-an-owner-runs",
      targets: [component]
    });
    const campaignId = campaign.id as string;
    // The bootstrap admin is an org-root OWNER (`createTestOrg`), which is where drizzle/0088 put
    // `campaign:deadline-override`, and `hasPermission` expands the checked scope upward from the
    // campaign to reach it.
    const base = Math.floor(Date.now() / 1000) * 1000;
    const day = 24 * 60 * 60 * 1000;

    const set = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: { at: new Date(base + 90 * day).toISOString() },
      reason: "set"
    });
    expect((set.deadline as CampaignDeadline).at).toBe(new Date(base + 90 * day).toISOString());

    const shortened = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: { at: new Date(base + 30 * day).toISOString() },
      reason: "shorten"
    });
    expect((shortened.deadline as CampaignDeadline).at).toBe(
      new Date(base + 30 * day).toISOString()
    );

    const movedLater = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: { at: new Date(base + 120 * day).toISOString() },
      reason: "the migration slipped"
    });
    expect((movedLater.deadline as CampaignDeadline).at).toBe(
      new Date(base + 120 * day).toISOString()
    );

    const cleared = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: null,
      reason: "abandoning the deadline"
    });
    expect(cleared.deadline).toBeNull();
    expect(await storedDeadlineOf(org, campaignId)).toBeUndefined();

    // ALL FOUR ARE ON THE RECORD, labelled by direction. The Decision's `loosening` flag and the
    // permission gate are now ONE predicate, so this also asserts the gate's own reading of each act.
    const rows = await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_SET_DECISION_KIND);
    expect(
      rows.map((r) => [
        (r.inputContext as { action: string }).action,
        (r.reasonTree as { loosening: boolean }).loosening
      ])
    ).toEqual([
      ["set", false],
      ["move", false],
      ["move", true],
      ["clear", true]
    ]);
  });
});

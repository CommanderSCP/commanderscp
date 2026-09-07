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
import { auditEvents, changes, decisions } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { reconcileCampaignsOrgTick } from "./campaign-reconcile.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import {
  CAMPAIGN_DEADLINE_DECISION_KIND,
  CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION,
  CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND
} from "./campaign-deadline-lock.js";
import type { CampaignDeadline, CampaignDeadlineOverride, CampaignRecipe } from "@scp/schemas";

/** The per-target deadline waiver, end to end. See docs/coordination.md §110. */

/** Adoption evidence NOTHING in these fixtures can satisfy — no inventory is ever seeded, so every
 *  target resolves `unknown` and is locked from the first tick past the deadline. `unknown`, not
 *  `not_adopted`, is deliberate: it is the verdict a real estate produces most often, and R3 says it
 *  is still never a pass. */
const DEPENDENCY_RECIPE: CampaignRecipe = {
  version: 1,
  trigger: { kind: "sync" },
  adoption: {
    kind: "dependency",
    ecosystem: "oci",
    coordinate: "docker.io/library/python",
    minVersion: "3.0"
  }
};

describe("campaign deadline override: excuse ONE laggard, not everybody (M25.6b / §4.5)", () => {
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

  /** The raw inject, for the cases whose whole assertion is the status code. */
  const attemptOverride = (
    org: TestOrg,
    campaignId: string,
    payload: Record<string, unknown>,
    token = org.adminToken
  ) =>
    server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/deadline-override`,
      headers: { authorization: `Bearer ${token}` },
      payload
    });

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

  const storedOverrides = async (
    org: TestOrg,
    campaignId: string
  ): Promise<CampaignDeadlineOverride[]> => {
    const row = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.query.objects.findFirst({ where: (t, { eq: eqOp }) => eqOp(t.id, campaignId) })
    );
    const deadline = (row!.properties as { deadline?: CampaignDeadline }).deadline;
    return deadline?.overrides ?? [];
  };

  /** A deadline a year out, and three instants around it. See docs/coordination.md §111. */
  function futureDeadline(): {
    deadline: CampaignDeadline;
    before: Date;
    after: Date;
    lapsedAt: string;
  } {
    const at = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    return {
      deadline: { at: at.toISOString() },
      before: new Date(),
      after: new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000),
      lapsedAt: new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString()
    };
  }

  /** A campaign whose targets are ALL locked the moment the deadline passes: no inventory is ever
   *  seeded, so every target's adoption is `unknown`. */
  async function lockedCampaign(
    label: string,
    componentCount = 1
  ): Promise<{
    org: TestOrg;
    componentIds: string[];
    campaignId: string;
    deadline: CampaignDeadline;
    before: Date;
    after: Date;
    lapsedAt: string;
  }> {
    const { org, componentIds } = await fixture(label, componentCount);
    const { deadline, before, after, lapsedAt } = futureDeadline();
    const campaign = await post(org, "/api/v1/campaigns", {
      name: `campaign-${label}`,
      targets: componentIds,
      recipe: DEPENDENCY_RECIPE,
      deadline
    });
    return {
      org,
      componentIds,
      campaignId: campaign.id as string,
      deadline,
      before,
      after,
      lapsedAt
    };
  }

  /** Two locked siblings, one waived: the whole increment. See docs/coordination.md §112. */
  it("O: a waived target gets its member Change on the next tick — its unwaived sibling does not", async () => {
    const { org, componentIds, campaignId, after } = await lockedCampaign("override-effect", 2);
    const [waived, sibling] = componentIds as [string, string];

    // ---- BOTH LOCKED. The premise, asserted rather than assumed.
    await tick(org, 3, after);
    expect(await changeCount(org), "both targets start out locked by the deadline").toBe(0);
    expect(await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_DECISION_KIND)).toHaveLength(1);

    const updated = await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      targets: [waived],
      reason: "the vendor has not shipped a 3.x base image for this component yet"
    });
    // The response round-trips the stored document: the waiver is on the campaign, not merely
    // accepted and dropped.
    expect((updated.deadline as CampaignDeadline).overrides).toHaveLength(1);
    expect((updated.deadline as CampaignDeadline).overrides![0]!.targetObjectId).toBe(waived);
    // ...and the DEADLINE ITSELF still stands. This is the whole difference from `deadline --clear`.
    expect((updated.deadline as CampaignDeadline).at).toBeTruthy();

    // ---- THE EFFECT, on the very next tick. No unlock verb, no backfill.
    await tick(org, 2, after);
    expect(await changeCount(org), "the waived target must get its member Change minted").toBe(1);

    const plan = await planFor(org, campaignId);
    const targets = plan!.waves[0]!.targets;
    const waivedRow = targets.find((t) => t.targetObjectId === waived)!;
    const siblingRow = targets.find((t) => t.targetObjectId === sibling)!;
    expect(waivedRow.memberChangeObjectId).not.toBeNull();
    // THE OTHER HALF, and the one that would go green if a waiver ever became campaign-wide: the
    // sibling nobody excused is still locked out, still `pending`, still with no member change.
    expect(
      siblingRow.memberChangeObjectId,
      "waiving ONE target must not release the others"
    ).toBeNull();
    expect(siblingRow.status).toBe("pending");
  });

  /** READ-TIME EXPIRY, DRIVEN THROUGH THE RECONCILER. See docs/coordination.md §113. */
  it("U: an `until` in the PAST is stored and audited but NOT effective — and re-waiving replaces it", async () => {
    const { org, componentIds, campaignId, after, lapsedAt } =
      await lockedCampaign("override-until");
    const [component] = componentIds as [string];

    await tick(org, 3, after);
    expect(await changeCount(org)).toBe(0);

    // A waiver that expires a day past the deadline — six days before the tick's clock.
    const lapsed = await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      targets: [component],
      reason: "one week only, while the vendor ships",
      until: lapsedAt
    });
    expect((lapsed.deadline as CampaignDeadline).overrides![0]!.until).toBe(lapsedAt);

    await tick(org, 2, after);
    expect(
      await changeCount(org),
      "a waiver whose `until` has passed must withhold nothing from the deadline"
    ).toBe(0);

    const renewed = await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      targets: [component],
      reason: "the vendor slipped again; excused indefinitely"
    });
    const overrides = (renewed.deadline as CampaignDeadline).overrides!;
    // AT MOST ONE ENTRY PER TARGET. An append-only list would grow `campaign.properties` without
    // bound — it rides `object_upsert` to every replica and is content-hashed on every write — and
    // would make "which waiver applies?" a question about array order.
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.until).toBeUndefined();
    expect(overrides[0]!.reason).toContain("slipped again");

    await tick(org, 2, after);
    expect(await changeCount(org), "the renewed waiver releases the target").toBe(1);

    // BOTH ACTS ARE ON THE HASH CHAIN. The superseded waiver is gone from the document and survives
    // in the record, which is where history belongs.
    const audits = await auditsOfAction(org, CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION);
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.reason)).toEqual([
      "one week only, while the vendor ships",
      "the vendor slipped again; excused indefinitely"
    ]);
  });

  /** The read surface honours the waiver too. See docs/coordination.md §114. */
  it("V: the campaign stops reporting `blocked` once its only locked target is waived", async () => {
    const { org, componentIds } = await fixture("override-view");
    const [component] = componentIds as [string];
    const deadline: CampaignDeadline = { at: new Date(Date.now() - 60_000).toISOString() };
    const campaign = await post(org, "/api/v1/campaigns", {
      name: "campaign-reporting-blocked",
      targets: [component],
      recipe: DEPENDENCY_RECIPE,
      deadline
    });
    const campaignId = campaign.id as string;

    const read = async (): Promise<{ status: string; deadline: CampaignDeadline | null }> => {
      const res = await server.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}`,
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { status: string; deadline: CampaignDeadline | null };
    };

    await tick(org, 3, new Date());
    expect(await changeCount(org)).toBe(0);
    expect((await read()).status, "the lever works; this asserts the signal follows it").toBe(
      "blocked"
    );

    const waived = await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      reason: "excused: this component is being decommissioned next quarter"
    });
    // The response's OWN status is re-derived through the same predicate, so the call that lifts the
    // lock reports it lifted rather than echoing the pre-write state.
    expect((waived as unknown as { status: string }).status).not.toBe("blocked");
    expect((await read()).status).not.toBe("blocked");
    // ...and the deadline is still on the campaign. Nothing was cleared.
    expect((await read()).deadline!.at).toBe(deadline.at);
  });

  /** One Decision, and one audit event per target. See docs/coordination.md §115. */
  it("R: one `campaign_deadline_override` Decision (sorted targets, `until` as a boundary) and one audit event per target", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-record", 3);
    const [a, b, c] = componentIds as [string, string, string];
    const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Named DESCENDING on purpose: the Decision's array must come back sorted regardless of the
    // order the request listed them, because `restatesDecision` canonicalizes object KEYS while
    // deliberately preserving array ORDER.
    const descending = [a, b, c].sort((x, y) => y.localeCompare(x));
    await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      targets: descending,
      reason: "platform-wide exemption while the base image is rebuilt",
      until
    });

    const rows = await decisionsOfKind(org, campaignId, CAMPAIGN_DEADLINE_OVERRIDE_DECISION_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("allow");

    const context = rows[0]!.inputContext as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual(["targets", "until"]);
    expect(context.targets).toEqual([...descending].sort((x, y) => x.localeCompare(y)));
    expect(context.until).toBe(until);
    // NOTHING CLOCK- OR IDENTITY-SHAPED: `at` and `actorId` live on the audit event below.
    expect(JSON.stringify(context)).not.toContain("actorId");
    expect((rows[0]!.reasonTree as { loosening: boolean }).loosening).toBe(true);

    // ONE EVENT PER TARGET, each SUBJECT-KEYED TO THE TARGET — the `freeze.override` shape. One
    // event listing three ids would turn "was this component ever excused?" into a substring search
    // over a blob instead of a subject-keyed query.
    const audits = await auditsOfAction(org, CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION);
    expect(audits).toHaveLength(3);
    expect(audits.map((e) => e.subjectId).sort()).toEqual([a, b, c].sort());
    for (const event of audits) {
      expect(event.decisionId).toBe(rows[0]!.id);
      expect(event.reason).toBe("platform-wide exemption while the base image is rebuilt");
    }

    // AND THE STORED DOCUMENT IS SORTED, so a re-issued waiver over an unchanged set is
    // byte-identical rather than re-hashing and re-federating the campaign object.
    const stored = await storedOverrides(org, campaignId);
    expect(stored.map((o) => o.targetObjectId)).toEqual([a, b, c].sort());
    expect(stored.every((o) => o.actorId.length > 0 && o.at.length > 0)).toBe(true);
  });

  it("B1: the reason is MANDATORY — an absent or empty one is a 400", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-reason");
    const [component] = componentIds as [string];

    for (const payload of [
      { targets: [component] },
      { targets: [component], reason: "" },
      {} // the waive-everything form still needs one
    ]) {
      const res = await attemptOverride(org, campaignId, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);
  });

  /** A waiver over a non-target is dead data. See docs/coordination.md §116. */
  it("B2: refuses a target the campaign does not declare, and a campaign with no deadline", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-nontarget", 1);
    const [component] = componentIds as [string];
    // A second component in the same org that this campaign never targeted.
    const stranger = await post(org, "/api/v1/components", {
      name: "comp-not-in-the-campaign",
      service: (await post(org, "/api/v1/services", { name: "svc-elsewhere" })).id
    });

    const nonTarget = await attemptOverride(org, campaignId, {
      targets: [stranger.id],
      reason: "excuse a component that is not in this campaign"
    });
    expect(nonTarget.statusCode).toBe(400);

    const noDeadline = await post(org, "/api/v1/campaigns", {
      name: "campaign-without-a-deadline",
      targets: [component]
    });
    const nothingToWaive = await attemptOverride(org, noDeadline.id as string, {
      reason: "waive a deadline that does not exist"
    });
    expect(nothingToWaive.statusCode).toBe(400);
  });

  /** No override permission means 403, sharpest subject. See docs/coordination.md §117. */
  it("A1: an org-root ADMINISTRATOR cannot waive this deadline per target — nor, since the D1 ruling, clear it outright", async () => {
    const { org, componentIds, campaignId, deadline } =
      await lockedCampaign("override-authz-admin");
    const [component] = componentIds as [string];
    const administrator = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);

    const refused = await attemptOverride(
      org,
      campaignId,
      { targets: [component], reason: "I would like this target excused" },
      administrator.token
    );
    expect(refused.statusCode).toBe(403);
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);

    // THE BLUNT EXIT IS SHUT TO THE SAME SUBJECT. Without this the narrow door is guarded and the
    // wide one beside it is not, which is worse than guarding neither: it reads as enforced.
    const cleared = await server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/deadline`,
      headers: { authorization: `Bearer ${administrator.token}` },
      payload: {
        deadline: null,
        reason: "clearing used to be the blunt exit, and it was open to me"
      }
    });
    expect(
      cleared.statusCode,
      "clearing excuses every target permanently — it cannot cost less than waiving one"
    ).toBe(403);

    // THE CONTROL that makes both 403s mean what they claim: the SAME subject CAN still move
    // this deadline EARLIER through that verb, so what it lacks is the Owner-only permission and not
    // authority over the campaign.
    const tightened = await server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/deadline`,
      headers: { authorization: `Bearer ${administrator.token}` },
      payload: {
        deadline: { at: new Date(Date.parse(deadline.at) - 60_000).toISOString() },
        reason: "pulling the date in is a tightening, and it is open to me"
      }
    });
    expect(tightened.statusCode, tightened.body).toBe(200);
  });

  /** The permission at the campaign, but not at the target. See docs/coordination.md §118. */
  it("A2: holding `campaign:deadline-override` at the campaign is not enough without `object:write` at the target", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-authz-target");
    const [component] = componentIds as [string];
    const campaignOwner = await createTestUser(server, org, [{ role: "Owner", scope: campaignId }]);

    const refused = await attemptOverride(
      org,
      campaignId,
      { targets: [component], reason: "excuse a component I have no standing on" },
      campaignOwner.token
    );
    expect(refused.statusCode).toBe(403);
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);

    // THE CONTROL: the same subject succeeds the moment it is ALSO given standing at the target's
    // service, so the refusal above is the target check and not the campaign one.
    const empowered = await createTestUser(server, org, [
      { role: "Owner", scope: campaignId },
      { role: "Operator", scope: component }
    ]);
    const allowed = await attemptOverride(
      org,
      campaignId,
      { targets: [component], reason: "now I have standing on this component" },
      empowered.token
    );
    expect(allowed.statusCode).toBe(200);
    expect(await storedOverrides(org, campaignId)).toHaveLength(1);
  });

  /** THE INVERSION §4.5 EXISTS TO PREVENT, asserted directly. See docs/coordination.md §119. */
  it("L: an operator with full authority over the TARGET and none over the campaign cannot self-excuse", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-self-excuse");
    const [component] = componentIds as [string];
    const laggard = await createTestUser(server, org, [{ role: "Owner", scope: component }]);

    const refused = await attemptOverride(
      org,
      campaignId,
      { targets: [component], reason: "we will migrate eventually, honest" },
      laggard.token
    );
    expect(refused.statusCode).toBe(403);
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);
  });

  // THE BROAD FORM, AND WHAT A MOVE DOES TO WAIVERS ALREADY IN FORCE

  /** OMITTING `targets` WAIVES EVERY DECLARED TARGET. See docs/coordination.md §120. */
  it("W: omitting `targets` waives every declared target, one audit event each, deadline still standing", async () => {
    const { org, componentIds, campaignId, deadline, after } = await lockedCampaign(
      "override-all",
      2
    );

    const updated = await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      reason: "the whole fleet is blocked on the vendor; excusing everyone for now"
    });
    expect((updated.deadline as CampaignDeadline).overrides).toHaveLength(2);
    // THE DEADLINE IS STILL THERE. `deadline --clear` would have removed it.
    expect((updated.deadline as CampaignDeadline).at).toBe(deadline.at);

    expect(await auditsOfAction(org, CAMPAIGN_DEADLINE_OVERRIDE_AUDIT_ACTION)).toHaveLength(2);

    await tick(org, 2, after);
    expect(await changeCount(org), "every target fans out once it is waived").toBe(
      componentIds.length
    );
  });

  /** A MOVE MUST NOT SILENTLY DROP WAIVERS ALREADY IN FORCE. See docs/coordination.md §121. */
  it("M: a MOVE preserves waivers already in force; a CLEAR takes them with the deadline", async () => {
    const { org, componentIds, campaignId } = await lockedCampaign("override-move");
    const [component] = componentIds as [string];

    await post(org, `/api/v1/campaigns/${campaignId}/deadline-override`, {
      targets: [component],
      reason: "excused while the vendor ships"
    });
    expect(await storedOverrides(org, campaignId)).toHaveLength(1);

    const moved = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: { at: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() },
      reason: "the migration slipped a month"
    });
    expect(
      (moved.deadline as CampaignDeadline).overrides,
      "moving the date must not silently re-lock an excused target"
    ).toHaveLength(1);
    expect((moved.deadline as CampaignDeadline).overrides![0]!.targetObjectId).toBe(component);

    const cleared = await post(org, `/api/v1/campaigns/${campaignId}/deadline`, {
      deadline: null,
      reason: "abandoning the deadline entirely"
    });
    expect(cleared.deadline).toBeNull();
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);
  });

  /** THE AUTHORING DOORS CANNOT MINT A WAIVER. See docs/coordination.md §122. */
  it("S: neither `POST /campaigns` nor `POST /campaigns/{id}/deadline` accepts an `overrides` key", async () => {
    const { org, componentIds, campaignId, deadline } = await lockedCampaign("override-doors");
    const [component] = componentIds as [string];
    const smuggled = [
      {
        targetObjectId: component,
        reason: "smuggled in at object:write",
        actorId: component,
        at: new Date().toISOString()
      }
    ];

    const atCreate = await server.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        name: "campaign-born-with-waivers",
        targets: [component],
        deadline: { ...deadline, overrides: smuggled }
      }
    });
    expect(atCreate.statusCode).toBe(400);

    const atMove = await server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/deadline`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { deadline: { ...deadline, overrides: smuggled }, reason: "smuggling" }
    });
    expect(atMove.statusCode).toBe(400);
    expect(await storedOverrides(org, campaignId)).toHaveLength(0);
  });
});

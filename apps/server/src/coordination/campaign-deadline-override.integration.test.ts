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

/**
 * ================================================================================================
 * M25.6b — THE PER-TARGET DEADLINE WAIVER, END TO END AGAINST REAL POSTGRES
 * ================================================================================================
 *
 * THE GUARANTEE UNDER TEST, in one sentence: *one laggard can be excused from a campaign's deadline
 * without clearing that deadline for anybody else — by an actor holding the Owner-only
 * `campaign:deadline-override` AT THE CAMPAIGN plus `object:write` at the target, and by nobody
 * else.*
 *
 * THE AUTHORIZATION CASES ARE THE POINT OF THIS FILE, not a formality around the effect case. §4.5's
 * two-check design exists because each check alone is wrong in a specific way, and each 403 below
 * names which:
 *
 *   * NO `campaign:deadline-override` (an org-root Administrator, who holds `object:write` on
 *     everything) => 403. Borrowing `object:write` would make the Owner-only grant decorative. That
 *     case ALSO now asserts the same subject cannot CLEAR the deadline outright: until the
 *     2026-08-25 D1 ruling it could, which made this narrow door's guard decorative in the other
 *     direction — a strictly wider act was available beside it for less.
 *   * THE PERMISSION, BUT NO `object:write` AT THE TARGET (an Owner bound at the campaign object
 *     ALONE) => 403. This is the case that proves the second check is wired at all, and it is the
 *     one that would silently pass if the target loop were ever deleted.
 *
 * The mirror-image case — a target-scoped check letting the laggard waive itself — is not
 * expressible as a test here BECAUSE the check is at the campaign: an actor holding everything at
 * the component and nothing at the campaign fails the FIRST check. That is the design working, and
 * `L: an operator with full authority over the TARGET and none over the campaign cannot self-excuse`
 * pins it.
 *
 * DRIVES `reconcileCampaignsOrgTick` DIRECTLY — never `withReconcileLoop`. A live loop is a
 * COMPETING CONSUMER of the rows these cases read back (`SKIP LOCKED` makes an inline call a silent
 * no-op), and "one tick" must mean exactly one tick for "no member change was minted" to be an
 * assertion rather than a race. The plugin host is the in-memory fake, exactly as
 * `campaign-deadline.integration.test.ts` uses it.
 *
 * NO FIXED SLEEPS, AND NONE ARE POSSIBLE. Every deadline here is a YEAR out and every wait is a tick
 * count against an INJECTED clock (`opts.now`). `until`-expiry is likewise tested by moving the
 * tick's clock past a stored boundary, never by waiting for one — which is the only way to test the
 * year-out deadline a real migration campaign carries.
 * `test-support/integration-sleep-census.test.ts` is the CI gate that keeps this true.
 *
 * A FRESH ORG PER CASE: `reconcileCampaignsOrgTick` serves every campaign in the org and several
 * cases assert org-wide counts ("exactly one Change exists").
 */

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

  /**
   * A DEADLINE A YEAR OUT, and three instants around it that no test could ever reach by waiting:
   * `after` is a week past it, `lapsed` a day past it (so a waiver expiring at `lapsed` is already
   * six days dead when the `after` tick runs).
   */
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

  /**
   * THE CASE THE WHOLE INCREMENT EXISTS FOR: two locked siblings, one waived, and the waiver's
   * entire observable consequence is that ONE member Change gets minted and the other does not.
   *
   * DRIVEN THROUGH THE RECONCILER, not the predicate. A predicate-level assertion would prove the
   * branch computes the right answer and prove nothing about whether anything READS it — the
   * component-built-never-installed failure this repo keeps meeting. What is asserted here is a row
   * in `changes` that exists only because `campaign-reconcile.ts` did not `continue`.
   *
   * MUTATION-PROVEN: delete the override branch — `if (findEffectiveDeadlineOverride(...)) continue;`
   * — from `evaluateCampaignDeadlineLock` and this fails with
   *   `AssertionError: the waived target must get its member Change minted: expected +0 to be 1`.
   */
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

  /**
   * READ-TIME EXPIRY, DRIVEN THROUGH THE RECONCILER. An `until` already past when the tick runs is
   * stored, audited, and NOT effective — with no job to un-flip it and nothing rewriting the
   * document as it lapses. Then re-waiving the same target REPLACES the dead entry rather than
   * appending beside it, and the campaign fans out.
   */
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

  /**
   * THE READ SURFACE HONOURS THE WAIVER TOO, so the page and the engine cannot disagree about who is
   * being withheld from. `getCampaignStatus` runs the SAME predicate — one resolution core, one
   * answer — which is what makes this an assertion about wiring rather than a duplicate of case O.
   *
   * THE DEADLINE HERE IS IN THE REAL PAST, deliberately, and for the reason `campaign-deadline`'s
   * case E records: an HTTP read has no tick and therefore no injected clock, so it reads the real
   * one. A year-out fixture would leave this case asserting `not blocked` against a deadline that was
   * never due — green for the wrong reason.
   */
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

  /**
   * ONE DECISION UNDER ITS OWN KIND, AND ONE HIGH-SEVERITY AUDIT EVENT **PER TARGET**.
   *
   * The `inputContext` key census is exact rather than a "does not contain `now`" check: a census
   * fails when a NEW clock-shaped key is added, which is how ADR-0024's measured 1.44 GB/day defect
   * actually arrives. `at` and `actorId` are deliberately absent — they are clock- and
   * identity-shaped and their home is the audit event and the stored waiver.
   */
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

  /**
   * A WAIVER OVER A NON-TARGET IS DEAD DATA in a permanent governance record, and a campaign with no
   * deadline has nothing to waive. Both are refused at the door rather than written and ignored: an
   * operator who believes they excused something is worse off than one who got an error.
   */
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

  /**
   * NO `campaign:deadline-override` => 403, and the subject chosen is the sharpest available: an
   * ADMINISTRATOR AT THE ORG ROOT. That role holds `object:write` over every object in the org, and
   * drizzle/0088 grants the new permission to Owner ALONE. A Viewer would have failed this for the
   * boring reason; an Administrator fails it for the designed one.
   *
   * ===========================================================================================
   * THIS CASE'S CONTROL USED TO BE THE BUG (owner ruling 2026-08-25, decision D1 b-i)
   * ===========================================================================================
   * It asserted that the SAME Administrator could CLEAR the whole deadline through
   * `POST /campaigns/{id}/deadline` — 200 — as the control proving the 403 above was about the
   * missing permission rather than about authority over the campaign. That assertion was true, and it
   * was the vulnerability, written down and guarded: clearing excuses EVERY target permanently, with
   * no `until` and no per-target check, so the subject refused a ONE-TARGET waiver here had a
   * strictly wider act available one route up for less. The clear now demands
   * `campaign:deadline-override` too, so the old control asserts the opposite of the rule and is
   * REPLACED rather than relaxed: the control is now a TIGHTENING through the same verb, which is
   * still open at `object:write` and still proves exactly what the control existed to prove.
   */
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

  /**
   * THE PERMISSION AT THE CAMPAIGN, BUT NO `object:write` AT THE TARGET => 403.
   *
   * The subject is an OWNER BOUND AT THE CAMPAIGN OBJECT ALONE. `hasPermission` expands the checked
   * scope UPWARD, so that binding satisfies `campaign:deadline-override` at the campaign and reaches
   * NOTHING under the components (a component's chain runs component -> service -> org root, and the
   * campaign is on none of it).
   *
   * THE CASE THAT PROVES CHECK 2 IS WIRED AT ALL, and mutation-proven as such: delete the per-target
   * `authorize` block from `routes/campaigns.ts` and this fails with
   *   `AssertionError: expected 200 to be 403`.
   */
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

  /**
   * THE INVERSION §4.5 EXISTS TO PREVENT, asserted directly. An operator with FULL authority over
   * the component — Owner at the component, which is more than the deploying team normally has —
   * and none over the campaign cannot excuse their own component. If this check were ever moved to
   * the target, the deadline would coerce only the teams that did not think to opt out, which is
   * worse than not having it.
   */
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

  /**
   * OMITTING `targets` WAIVES EVERY DECLARED TARGET — and it is still not `deadline --clear`: the
   * deadline stands on the campaign, each waiver is recorded per target with its own audit event,
   * and the act cost the Owner-only permission at the campaign PLUS `object:write` at every one of
   * them, where clearing costs `object:write` at the campaign alone.
   */
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

  /**
   * A MOVE MUST NOT SILENTLY DROP WAIVERS ALREADY IN FORCE.
   *
   * `POST /campaigns/{id}/deadline` runs at plain `object:write` and its request body CANNOT express
   * `overrides` (that is the authority split). So an author moving the date has said NOTHING about
   * the waivers, and dropping them would be an unexpressed act — a silent TIGHTENING, re-locking
   * targets an Owner deliberately excused, performed by someone who never held the permission to
   * un-excuse them. Carrying them forward is the reading that matches what a waiver means.
   *
   * A CLEAR takes them with it, and that is not an inconsistency: there is then nothing left to be
   * excused from.
   */
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

  /**
   * THE AUTHORING DOORS CANNOT MINT A WAIVER. Both run at plain `object:write`; if either accepted
   * `overrides` it would be the Owner-only permission's bypass. `CampaignDeadlineInputSchema` is
   * strict, so the attempt is a 400 rather than a key silently dropped — which matters, because a
   * dropped key leaves an operator believing they excused a target that is still locked.
   */
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

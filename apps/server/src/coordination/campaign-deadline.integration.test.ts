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

/**
 * ================================================================================================
 * M25.6a — THE DEADLINE-TRIGGERED CAMPAIGN LOCK, END TO END AGAINST REAL POSTGRES
 * ================================================================================================
 *
 * THE GUARANTEE UNDER TEST, in one sentence: *past its deadline, a campaign proposes no further
 * change for a target it cannot observe as migrated — and NOTHING ELSE about that component
 * changes.* Owner decision D4's radius is this campaign's own targets; unrelated releases,
 * including security fixes, keep flowing, which is the property that distinguishes this from a
 * freeze and is why it is not implemented as one.
 *
 * DRIVES `reconcileCampaignsOrgTick` DIRECTLY — never `withReconcileLoop`. A live loop is a
 * COMPETING CONSUMER of the very rows these cases read back (`SKIP LOCKED` makes an inline call a
 * silent no-op), and "one tick" must mean exactly one tick for "no member change was minted" to be
 * an assertion rather than a race.
 *
 * NO FIXED SLEEPS, AND NONE ARE POSSIBLE HERE. Every wait is a tick count, and the clock itself is
 * INJECTED (`opts.now`, resolved once per tick for the whole batch). Without that seam the only way
 * to test a boundary would be to wait for it, which would confine the whole feature's coverage to
 * deadlines seconds away — never to the year-out deadline a migration campaign actually carries.
 * `test-support/integration-sleep-census.test.ts` is the CI gate that keeps this true.
 *
 * A FRESH ORG PER CASE. `reconcileCampaignsOrgTick` serves `ORDER BY updated_at ASC LIMIT 25` over
 * every campaign in the org, and several cases assert org-wide counts ("exactly one Change exists"),
 * which only mean what they say when the org holds one campaign.
 */

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

  /**
   * `opts.now` IS THREADED THROUGH EVERY TICK IN THIS FILE. Deleting that thread from
   * `reconcileCampaignsOrgTick` — replacing `opts.now ?? new Date()` with `new Date()` — makes every
   * deadline in this suite (all of which are a year out, deliberately) read as NOT DUE, so every
   * locked target fans out and the "exactly one Change" assertions fail.
   */
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

  // ===========================================================================================
  // W — THE ACTUATOR (proposal §4.3, actuator-table row 12). THE MUTATION TARGET.
  // ===========================================================================================

  /**
   * TWO TARGETS, A PAST DEADLINE, ONE OF THEM ADOPTED — and the shape of the fixture is dictated by
   * a fact about the shipped code that is worth writing down rather than working around.
   *
   * M25.5's adoption seam sits directly ABOVE this one and terminalizes every `adopted` target
   * `succeeded` WITHOUT minting a member change. So a target that is both `pending` and `adopted`
   * never reaches the deadline seam at all, and "B is adopted AND B has a member change" is only
   * satisfiable by a B the campaign already delivered to — i.e. by a campaign whose deadline passed
   * PART WAY THROUGH it. That is also the honest scenario: a deadline exists to catch the laggards a
   * long-running campaign has not reached yet, and this fixture is exactly that campaign.
   *
   *   * wave 0 = B, fanned out and delivered while the deadline was still weeks away;
   *   * wave 1 = A, reached only after it passed.
   *
   * The two waves come from a real `depends_on` edge (A depends on B), which is how
   * `compileAndPersistCampaignPlan` auto-sequences a campaign with no release topology.
   *
   * MUTATION-PROVEN, TWO WAYS, both landing on the same named assertion:
   *   * delete the `if (locked) { ...; continue; }` refusal from `campaign-reconcile.ts`;
   *   * or delete the clock thread (`opts.now ?? new Date()` -> `new Date()`), which makes a
   *     year-out deadline read as not due.
   * Either way A fans out and this fails with
   *   `AssertionError: the locked target must have NO member Change minted for it: expected 2 to be 1`.
   */
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

  /**
   * THE RADIUS, ASSERTED DIRECTLY (owner decision D4). The lock withholds THIS CAMPAIGN'S change and
   * nothing else: an ordinary release proposed against the same component, past the same deadline,
   * is created and is completely unaffected. This is the assertion that would fail if the lock were
   * ever re-implemented through `checkFreeze`.
   */
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

  // ===========================================================================================
  // THE PREDICATE OVER THE **REAL** RESOLUTION CORE — all three verdicts, real PostgreSQL
  // ===========================================================================================

  /**
   * `campaign-deadline-lock.test.ts` stubs `evaluateCampaignAdoption` to exercise the predicate's
   * branch logic without a database. THIS is what stops that stub hiding anything: the same
   * predicate, over the real core, against the three real evidence states.
   */
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

  // ===========================================================================================
  // FAIL OPEN, LOUDLY (§4.2)
  // ===========================================================================================

  /**
   * A MALFORMED BAG LOCKS NOTHING AND SAYS SO. The departure from `stage-dependency-hold.ts`'s
   * fail-CLOSED `undeclarable` branch is deliberate: that guards a SAFETY coupling, this is a
   * COERCION mechanism, and failing closed on an unreadable one parks an entire campaign on a typo
   * behind a document that by definition cannot explain itself.
   *
   * The bag is planted through `updateObject` rather than through the typed route, because that is
   * the only way it can actually arise: `campaign.properties` validates against an OPEN registry
   * schema, so IaC apply and federation import reach it without passing the strict Zod door.
   */
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

  // ===========================================================================================
  // THE ESCAPE HATCH — `POST /campaigns/{id}/deadline`, set / move / CLEAR
  // ===========================================================================================

  /**
   * CLEARING THE DEADLINE UNLOCKS EVERY TARGET, on the next tick, with no unlock verb. This is what
   * makes M25.6a not an entrance with no exit — §4.5's per-target `deadline-override` is M25.6b,
   * because its permission needs an `array_append` migration this increment deliberately does not
   * spend.
   */
  /**
   * THE DEADLINE HERE IS IN THE REAL PAST, deliberately, and the reason is worth recording because
   * it is a genuine property of the design rather than a test convenience.
   *
   * The lock is re-derived at READ time as well as at tick time — `getCampaignStatus` runs the same
   * predicate so the page and the engine can never disagree — but an HTTP read has no tick and
   * therefore no injected clock: it reads the real one. So the two agree exactly when production's
   * condition holds (both on the real clock), and the `opts.now` seam exists for the ENGINE, whose
   * batch must be internally consistent. A case that pushed only the tick's clock forward would
   * therefore see a `blocked` engine and an `active` page — which is why every other case in this
   * file asserts the engine and this one asserts both.
   */
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

    // THE EXIT.
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

  /**
   * "THE DEADLINE SLIPPED FOUR TIMES" MUST BE RECONSTRUCTIBLE. `audit_events` has no payload column,
   * so each MOVE's Decision is the only place the previous instant survives; without it the chain
   * records four writes that each say only where the deadline landed.
   */
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
    const row = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.query.objects.findFirst({ where: (t, { eq: eqOp }) => eqOp(t.id, campaign.id as string) })
    );
    expect((row!.properties as { deadline?: unknown }).deadline).toEqual(deadline);
  });
});

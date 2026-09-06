import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { Component, Domain, Service, Stack } from "@scp/iac";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import { GOVERNANCE_MOVE_DECISION_KIND } from "../governance/move-rung-write.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE IaC RUNG OF THE `governance:move` LATTICE (charter principle 3: API -> SDK -> CLI -> IaC ->
 * UI; the follow-up named in `docs/proposals/governance-reach-on-containment-move.md` §9.6 Q4).
 *
 * ============================================================================================
 * WHAT MAKES A RUNG DIFFERENT FROM EVERY OTHER MANIFEST COLLECTION
 * ============================================================================================
 * `sourceMappings`, `executorBindings` and `placements` treat an ABSENT collection and an EMPTY one
 * as the same thing, and both PRUNE. `producers` diverges (owner ruling 2026-08-17): absent means
 * UNMANAGED. `governanceMoveRungs` is the SECOND collection to diverge, and its reason is sharper.
 *
 * Pruning a mapping costs a route an operator notices the same day. Pruning a producer declaration
 * re-arms dependency confusion on a daily poll timer. Pruning a RUNG turns off a governance BAR, and
 * the symptom is an ABSENCE OF REFUSALS — moves that should have been refused quietly succeeding,
 * which nothing surfaces until somebody audits where a governed object ended up. So (1) here is the
 * NEGATIVE case, exactly as it is in `iac-dependency-producers.integration.test.ts`: a stack with a
 * standing rung whose manifest omits the key must plan NO rung entries and leave the rung alone.
 *
 * (5) is the positive half, and the two are only correct TOGETHER: a PRESENT collection is
 * authoritative over its members, or "unmanaged on absent" would mean IaC could enable a rung and
 * never disable one.
 *
 * ============================================================================================
 * WHAT EACH GATE REFUSES TO BE SATISFIED BY
 * ============================================================================================
 *  1. **THE RULING.** Not "the summary is zero" — that passes if the entries exist and happen to be
 *     noops. The assertion is that `diff.governanceMoveRungs` is ABSENT and the rung is still
 *     enforced after applying that plan.
 *  2. **WIRING**, read through the LATTICE and not through the table: `governanceMove.enforcement`
 *     — the same read the doors, the CLI and the Admin page use — must answer `enforced: true`. A
 *     plan that SHOWS a create and an apply that PERFORMS one are two different claims, and this
 *     repo has shipped the first without the second before.
 *  3. **THE WHOLE ACT, NOT THE ROW.** A rung write records a Decision under one kind and appends an
 *     audit event. A second door that writes only the row makes
 *     `GET /decisions?kind=governance.move_enforcement` — "every rung this org ever enabled or
 *     disabled" — silently FALSE for exactly the rungs an auditor came looking for (principle 6).
 *  4. **IDEMPOTENCE**, which for this collection is the ordinary case: `scp apply` re-runs.
 *  5. **THE MEMBER QUESTION**, settled behaviourally: removing B from `[A, B]` disables B, and A
 *     stays enforced.
 *  6. **THE AUTHORITY.** `policy:write` at-or-above the subject, against the REAL applying
 *     principal — on the ENABLE and on the DISABLE alike. Paired with a control apply by the same
 *     Operator so the 403 is a statement about the collection and not about Operators and plans.
 *     The disable half (c) is the one that matters more: narrowing the check to `create` would let
 *     an Operator turn a governance bar OFF, and a bar that is off announces itself only by an
 *     absence of refusals.
 *  7. **THE MONOTONE REFUSAL.** A manifest that drops a rung under an ENABLED upper rung fails its
 *     apply with the verb's own 409, naming the upper rung — reporting a successful disable that
 *     leaves every move under the subtree enforced anyway is the worst of both.
 *  8. **THE POINT OF THE WHOLE FEATURE**: a rung written by IaC feeds the SAME lattice. An Operator
 *     is refused a containment move under it, an Administrator makes the identical move, and the
 *     refusal NAMES the container the manifest declared.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Measured |
 * |---|---|
 * | delete `checks.push(governanceMoveRungScopeCheck(…))` from `prepareApplyChecks` | EXACTLY 1 fails: "(6)(b)" — `promise resolved … instead of rejecting`; the rung is written by a principal holding `policy:write` nowhere. "(6)(a)" stays green, which is what makes the 403 a statement about the COLLECTION and not about Operators and plans |
 * | narrow `prepareApplyChecks`'s rung loop to `if (entry.action === "create")` | EXACTLY 1 fails: "(6)(c)" — `promise resolved … instead of rejecting`, then the bar is measurably down. Before (6)(c) existed this mutation was GREEN across all 44 tests of this file, `move-enforcement.integration` and `governance-managed-write-doors`, and a probe confirmed an org-root Operator holding `policy:write` nowhere could disable a standing rung through it |
 * | apply calls the bare `enableGovernanceMoveRung` instead of `enableGovernanceMoveRungWithEffects` | EXACTLY 1 fails: "(3)", `expected [] to have a length of 1` — no Decision, no audit event. "(2) WIRING" STAYS GREEN, which is precisely why a rung-is-enforced gate is not sufficient on its own |
 * | an absent `governanceMoveRungs` key maps to `[]` in `computeDiffForManifest` | EXACTLY 1 fails: "(1)", on the SUBSTANTIVE assertion — `an absent governanceMoveRungs key manages nothing …: expected false to be true`. The standing bar was disabled by a manifest that merely forgot the key. This is the catastrophic direction and it is the one the message names |
 * | drop the `delete` loop from `executePlanDiff`'s rung block | 2 fail: "(5)" (`the dropped member's rung must be disabled: expected true to be false`) and "(7)" (`promise resolved … instead of rejecting` — a disable that never runs cannot be refused by the monotone check either). Recorded as two because the second shows the 409 is reached through the WRITE and not asserted independently of it |
 */
describe("iac: governance:move rungs (ADR-0038 §2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-move-rungs");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const applyLatest = async (manifest: Parameters<typeof admin.plans.create>[0]) => {
    const plan = await admin.plans.create(manifest);
    await admin.plans.apply(plan.id);
    return plan;
  };

  /** Is a move of this service governed? Read through the LATTICE — the same call the doors, the
   *  CLI and the Admin page make — never through a SELECT written here, so a green here cannot
   *  disagree with what an operator sees. */
  const enforcedAt = async (urn: string): Promise<boolean> =>
    (await admin.governanceMove.enforcement("service", urn)).enforced;

  // (1) THE RULING — an absent collection is UNMANAGED, not empty

  describe("(1) an ABSENT governanceMoveRungs key manages NOTHING", () => {
    it("a stack with a STANDING rung, whose manifest omits the key, plans NO rung entries and the rung survives apply", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;

      // `declaring: true` synthesizes a manifest WITH the collection; `false` omits it entirely,
      // because `Stack.synth()` drops an empty one — which is exactly the shape that makes
      // "unmanaged" and "I declare none" indistinguishable, and exactly why absent must not prune.
      function build(declaring: boolean) {
        const stack = new Stack(stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        if (declaring) stack.addGovernanceMoveRung(service);
        return stack.synth();
      }

      await applyLatest(build(true));
      const urn = `urn:scp:${stackName}:service:svc`;
      expect(await enforcedAt(urn)).toBe(true);

      const omitted = build(false);
      expect(omitted).not.toHaveProperty("governanceMoveRungs");

      const plan = await admin.plans.create(omitted);
      await admin.plans.apply(plan.id);

      // THE SUBSTANTIVE ASSERTION FIRST, deliberately: a "fix the inconsistency" edit that makes
      // absent prune fails HERE, on the bar being GONE, rather than on a shape expectation somebody
      // could read as pedantry and update.
      expect(
        await enforcedAt(urn),
        "an absent governanceMoveRungs key manages nothing — the standing rung must survive"
      ).toBe(true);

      // And the shape, which catches the same edit one step earlier and catches a WEAKER version of
      // it (emit `[]`, prune nothing) the assertion above cannot see. NOT "summary.deletes === 0":
      // the key is ABSENT, because an empty array means "this stack manages rungs and has nothing
      // to change" — a different, and here wrong, statement.
      expect(plan.diff.governanceMoveRungs).toBeUndefined();
      expect(plan.diff.summary.deletes).toBe(0);
    });
  });

  // (2) WIRING — the plan SHOWING a create and the apply PERFORMING one are two claims

  describe("(2) WIRING", () => {
    it("apply ENABLES the rung — delete the rung loops in executePlanDiff and this goes red", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      stack.addGovernanceMoveRung(service);

      // The manifest really does carry the collection and the plan really does say `create`, so a
      // failure below is about the APPLY and not about synth or the diff.
      const manifest = stack.synth();
      expect(manifest.governanceMoveRungs).toEqual([
        { subjectIdOrUrn: `urn:scp:${stackName}:service:svc` }
      ]);

      const plan = await admin.plans.create(manifest);
      expect(plan.diff.governanceMoveRungs?.map((r) => r.action)).toEqual(["create"]);
      await admin.plans.apply(plan.id);

      const urn = `urn:scp:${stackName}:service:svc`;
      const enforcement = await admin.governanceMove.enforcement("service", urn);
      expect(enforcement.enforced).toBe(true);
      // The TIER was derived server-side from the object type. A manifest never names one.
      expect(enforcement.rungs.map((r) => r.tier)).toContain("service");

      // …and the org-wide list read agrees, which is the surface the Admin page renders.
      const service_ = await admin.services.get(urn);
      const listed = await admin.governanceMove.rungs();
      expect(listed.rungs.map((r) => r.subjectObjectId)).toContain(service_.id);
    });
  });

  // (3) THE WHOLE ACT — a rung write is a row PLUS a Decision PLUS an audit event

  describe("(3) the apply performs the WHOLE act, not the row", () => {
    it("records its own Decision and audit event, so the Decision log still answers 'every rung ever enabled'", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      stack.addGovernanceMoveRung(service);
      await applyLatest(stack.synth());

      const subject = await admin.services.get(`urn:scp:${stackName}:service:svc`);
      const rows = await inOrg((tx) =>
        tx
          .select()
          .from(decisions)
          .where(
            and(
              eq(decisions.orgId, org.orgId),
              eq(decisions.subjectId, subject.id),
              eq(decisions.kind, GOVERNANCE_MOVE_DECISION_KIND)
            )
          )
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.verdict).toBe("enabled");
      expect(rows[0]?.inputContext).toMatchObject({
        tier: "service",
        subjectObjectId: subject.id
      });

      const audits = await inOrg((tx) =>
        tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.orgId, org.orgId),
              eq(auditEvents.subjectId, subject.id),
              eq(auditEvents.action, "governance.move_enforcement.enable")
            )
          )
      );
      expect(audits).toHaveLength(1);
    });
  });

  // (4) IDEMPOTENCE — re-applying is the ordinary case, not an edge case

  describe("(4) re-applying the same manifest is a noop", () => {
    it("the second plan says noop, and the rung is neither re-created nor disturbed", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      function build() {
        const stack = new Stack(stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        stack.addGovernanceMoveRung(service);
        return stack.synth();
      }

      await applyLatest(build());
      const urn = `urn:scp:${stackName}:service:svc`;
      const subject = await admin.services.get(urn);
      const enabledAt = (await admin.governanceMove.rungs()).rungs.find(
        (r) => r.subjectObjectId === subject.id
      )?.enabledAt;
      expect(enabledAt).toBeTruthy();

      const again = await admin.plans.create(build());
      expect(again.diff.governanceMoveRungs?.map((r) => r.action)).toEqual(["noop"]);
      await admin.plans.apply(again.id);

      expect(await enforcedAt(urn)).toBe(true);
      // A noop is EXEMPT from the apply's write loops, so the row is untouched — not re-stamped
      // with a new `enabled_at` by an upsert that ran anyway.
      expect(
        (await admin.governanceMove.rungs()).rungs.find((r) => r.subjectObjectId === subject.id)
          ?.enabledAt
      ).toBe(enabledAt);
    });
  });

  // (5) THE MEMBER QUESTION — a PRESENT collection is authoritative over its own members

  describe("(5) removing ONE entry from a PRESENT collection disables THAT rung", () => {
    it("dropping B from [A, B] disables B and leaves A enforced", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      function build(subjects: ("a" | "b")[]) {
        const stack = new Stack(stackName);
        const a = new Service(stack, "a", { name: "A" });
        const b = new Service(stack, "b", { name: "B" });
        for (const s of subjects) stack.addGovernanceMoveRung(s === "a" ? a : b);
        return stack.synth();
      }

      await applyLatest(build(["a", "b"]));
      const aUrn = `urn:scp:${stackName}:service:a`;
      const bUrn = `urn:scp:${stackName}:service:b`;
      expect(await enforcedAt(aUrn)).toBe(true);
      expect(await enforcedAt(bUrn)).toBe(true);

      const prune = await admin.plans.create(build(["a"]));
      expect(
        Object.fromEntries(
          (prune.diff.governanceMoveRungs ?? []).map((r) => [r.subjectUrn, r.action])
        )
      ).toEqual({ [aUrn]: "noop", [bUrn]: "delete" });
      await admin.plans.apply(prune.id);

      expect(await enforcedAt(bUrn), "the dropped member's rung must be disabled").toBe(false);
      expect(await enforcedAt(aUrn), "…and the kept member's must survive").toBe(true);
    });
  });

  // (6) AUTHORITY — `policy:write` at-or-above the subject, against the REAL applying principal

  /**
   * `Operator` IS THE RIGHT PRINCIPAL, and the two cases are one pair on purpose. Operator carries
   * `object:write` and NOT `policy:write` (the `0002` seed; `0010` adds `policy:write` to
   * Administrator and Owner only), so at the ORG ROOT it holds authority over every object in the
   * org and still holds none over a governance bar. Case (a) is what makes case (b) mean something:
   * without it a 403 would be satisfied by an Operator who simply cannot apply plans at all.
   */
  describe("(6) enabling a rung needs policy:write at-or-above the subject", () => {
    let operator: ScpClient;

    beforeAll(async () => {
      const user = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
      operator = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    });

    it("(a) an Operator bound at the ORG ROOT applies a plan that declares NO rung", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      new Service(stack, "svc", { name: "Svc" });

      const plan = await operator.plans.create(stack.synth());
      const { plan: applied } = await operator.plans.apply(plan.id);
      expect(applied.status).toBe("applied");
    });

    it("(b) …and the SAME Operator is REFUSED a plan that declares one — object:write over every object in the org is not authority over a governance bar", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      stack.addGovernanceMoveRung(service);

      // The PLAN is fine — computing a diff writes nothing, and the authority is per-apply.
      const plan = await operator.plans.create(stack.synth());
      expect(plan.diff.governanceMoveRungs?.map((r) => r.action)).toEqual(["create"]);

      await expect(operator.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

      // Nothing was written, and nothing was HALF written: the checks are drained to completion
      // before `executePlanDiff` runs, so the service this plan would have created is absent too.
      await expect(admin.services.get(`urn:scp:${stackName}:service:svc`)).rejects.toMatchObject({
        status: 404
      });
    });

    /**
     * THE DISABLE HALF, and the reason it is a separate case rather than a variant of (b).
     *
     * `prepareApplyChecks` authorizes every NON-NOOP entry. Narrow that one predicate to
     * `entry.action === "create"` and (a), (b) and every other gate in this file stay green while an
     * Operator holding `policy:write` NOWHERE can delete a rung out of a manifest and turn a
     * governance bar off. That is strictly worse than the enable direction it shares a check with:
     * an unauthorized ENABLE announces itself the first time somebody is refused a move, an
     * unauthorized DISABLE announces itself by an ABSENCE of refusals — nothing, until an audit
     * notices where a governed object ended up. The same asymmetry is why an absent collection is
     * unmanaged (1) rather than empty.
     */
    it("(c) …and the SAME Operator is REFUSED a plan that DISABLES one — the authority covers deletes, not just creates", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      function build(subjects: ("a" | "b")[]) {
        const stack = new Stack(stackName);
        const a = new Service(stack, "a", { name: "A" });
        const b = new Service(stack, "b", { name: "B" });
        for (const s of subjects) stack.addGovernanceMoveRung(s === "a" ? a : b);
        return stack.synth();
      }

      // The ADMIN establishes both bars — the Operator never had authority to create them, so the
      // delete they attempt below is a delete of somebody else's standing enforcement.
      await applyLatest(build(["a", "b"]));
      const bUrn = `urn:scp:${stackName}:service:b`;
      expect(await enforcedAt(bUrn)).toBe(true);

      // The Operator plans the same stack with B dropped. Planning is fine — it writes nothing.
      const plan = await operator.plans.create(build(["a"]));
      expect(
        Object.fromEntries(
          (plan.diff.governanceMoveRungs ?? []).map((r) => [r.subjectUrn, r.action])
        )
      ).toMatchObject({ [bUrn]: "delete" });

      await expect(operator.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

      // THE SUBSTANTIVE ASSERTION: the bar is still up. A refusal that let the row through anyway
      // would be a 403 nobody is protected by.
      expect(await enforcedAt(bUrn), "a refused apply must leave the standing rung enforcing").toBe(
        true
      );
    });
  });

  // (7) THE MONOTONE REFUSAL — an enablement above cannot be undone below

  describe("(7) a disable under an ENABLED upper rung fails the apply 409", () => {
    it("dropping the lower entry while the parent domain's rung stands is refused, naming the upper rung", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;

      // The domain must EXIST before the service can name it in `domainId` (`ResourceProps.domainId`
      // is a real object id), so this is two applies of one stack — which is also the honest shape:
      // an operator adds the domain, then nests under it.
      const seedStack = new Stack(stackName);
      new Domain(seedStack, "platform", { name: "Platform" });
      await applyLatest(seedStack.synth());
      const domain = await admin.domains.get(`urn:scp:${stackName}:domain:platform`);

      function build(withLower: boolean) {
        const stack = new Stack(stackName);
        const dom = new Domain(stack, "platform", { name: "Platform" });
        const svc = new Service(stack, "svc", { name: "Svc", domainId: domain.id });
        stack.addGovernanceMoveRung(dom);
        if (withLower) stack.addGovernanceMoveRung(svc);
        return stack.synth();
      }

      await applyLatest(build(true));
      const svcUrn = `urn:scp:${stackName}:service:svc`;
      expect(await enforcedAt(svcUrn)).toBe(true);

      // The plan is COMPUTED happily — a disable is a legitimate thing to plan, and whether the
      // lattice admits it is an apply-time question about live state.
      const plan = await admin.plans.create(build(false));
      expect(
        Object.fromEntries(
          (plan.diff.governanceMoveRungs ?? []).map((r) => [r.subjectUrn, r.action])
        )
      ).toMatchObject({ [svcUrn]: "delete" });

      // …and the apply carries the VERB's own sentence, not a second differently-worded copy: the
      // 409 comes from `disableGovernanceMoveRung`, reached through the module both doors share.
      await expect(admin.plans.apply(plan.id)).rejects.toMatchObject({
        status: 409,
        problem: { detail: expect.stringContaining("cannot disable governance:move enforcement") }
      });

      // Nothing half-applied: the refusal threw inside the apply transaction.
      expect(await enforcedAt(svcUrn)).toBe(true);
      expect((await admin.governanceMove.rungs()).rungs.map((r) => r.subjectObjectId)).toContain(
        domain.id
      );
    });
  });

  // (8) THE POINT — a rung written by IaC feeds the SAME lattice the doors consult

  /**
   * This is the case the whole increment exists for. Everything above proves a row was written with
   * the right ceremony; only this proves the row MEANS anything. If the IaC path wrote to some
   * parallel place — or wrote a tier the doors do not recognise — every gate above would still be
   * green and the feature would be inert. The Administrator's identical move is the control that
   * makes the Operator's 403 a statement about `governance:move` rather than about the move being
   * impossible.
   */
  describe("(8) the moved-object doors consult the rung IaC wrote", () => {
    let operator: ScpClient;

    beforeAll(async () => {
      const user = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
      operator = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    });

    it("an Operator is REFUSED a containment move out of the governed service, and an Administrator makes the identical move", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      const keep = new Service(stack, "keep", { name: "Keep" });
      const dest = new Service(stack, "dest", { name: "Dest" });
      new Component(stack, "x", { name: "x", service: keep });
      new Component(stack, "y", { name: "y", service: keep });
      stack.addGovernanceMoveRung(keep);
      await applyLatest(stack.synth());

      const destUrn = `urn:scp:${stackName}:service:dest`;
      expect(await enforcedAt(`urn:scp:${stackName}:service:keep`)).toBe(true);
      // Named so a failure cannot be mistaken for the destination carrying the bar.
      expect(await enforcedAt(destUrn)).toBe(false);

      // THE REFUSAL, and it NAMES the container the manifest declared — which is what proves the
      // door read THIS rung rather than merely refusing for some other reason.
      await expect(
        operator.components.setService(`urn:scp:${stackName}:component:x`, destUrn)
      ).rejects.toMatchObject({
        status: 403,
        problem: { detail: expect.stringContaining("service 'Keep'") }
      });

      // …and the identical move by a principal who DOES hold `governance:move` succeeds. Different
      // component, so neither case depends on the other having run.
      const moved = await admin.components.setService(`urn:scp:${stackName}:component:y`, destUrn);
      expect(moved.id).toBeTruthy();
      expect(dest.urn).toBe(destUrn);
    });
  });
});

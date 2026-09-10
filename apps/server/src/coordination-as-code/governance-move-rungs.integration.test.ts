import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { Component, Domain, Service, Stack } from "@scp/coordination-as-code";
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

/** THE IaC RUNG OF THE `governance:move` LATTICE. See docs/coordination-as-code.md §24. */
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

  /** That role is the right principal, and these are a pair. See docs/coordination-as-code.md §25. */
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

    /** The disable half, and why it is a separate case. See docs/coordination-as-code.md §26. */
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

  /** This is the case the whole increment exists for. See docs/coordination-as-code.md §27. */
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

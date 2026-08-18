import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { App, Component, Service, Stack } from "@scp/iac";
import type { DependencyEcosystem } from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import {
  getDependencyLineByKey,
  getDependencyLineProducer,
  recordDependencyLineHead,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import { PRODUCER_DECISION_KIND } from "../dependencies/producer-declaration.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE IaC RUNG OF THE PRODUCER DECLARATION (charter principle 3: API -> SDK -> CLI -> IaC -> UI).
 *
 * ============================================================================================
 * THE ONE RULE THAT MAKES THIS COLLECTION DIFFERENT, AND WHY THE FIRST TEST IS THE ONE IT IS
 * ============================================================================================
 * `sourceMappings`, `executorBindings` and `placements` treat an ABSENT collection and an EMPTY one
 * as the same thing, and both PRUNE. `plan-diff.ts` is emphatic about it and records that changing
 * it broke three `plans.integration` tests.
 *
 * `producers` DIVERGES, by owner ruling (2026-08-17): AN ABSENT KEY MEANS UNMANAGED AND PRUNES
 * NOTHING. Pruning a mapping costs a route an operator notices the same day; pruning a producer
 * declaration hands a coordinate the org PUBLISHES back to a public index on a daily poll timer, and
 * the symptom is an ABSENCE of dependency updates — dependency confusion (ADR-0032 §7b clause 1)
 * re-armed by a stack that merely forgot a key. So the first case here is the NEGATIVE one: a stack
 * with a standing declaration, whose manifest omits the key, must produce NO producer diff entries
 * at all and leave the declaration alone.
 *
 * The positive rule is in the same file because the two are only correct TOGETHER: a present
 * collection IS authoritative over its own members, or "unmanaged on absent" would mean IaC could
 * add a declaration and never remove one.
 *
 * ============================================================================================
 * WHAT EACH GATE REFUSES TO BE SATISFIED BY
 * ============================================================================================
 *  1. **THE RULING.** Not "the plan summary is zero" — that would pass if the entries existed and
 *     happened to be noops. The assertion is that `diff.producers` is ABSENT, and that the row is
 *     still there after an apply of that plan.
 *  2. **WIRING.** `executePlanDiff` must actually write the row. Named so the mutation is obvious:
 *     delete the producer block from `executePlanDiff` and "(2) WIRING" goes red while everything
 *     that only reads the DIFF stays green. That asymmetry is the whole point — a plan that SHOWS a
 *     create and an apply that PERFORMS one are two different claims, and this repo has shipped the
 *     first without the second before.
 *  3. **THE WHOLE ACT, NOT THE ROW.** A declaration clears every covered line's observed head,
 *     records a Decision and appends an audit event. A second door that writes only the row arms the
 *     exact failures the verb exists to prevent (a poisoned public head surviving the declaration
 *     meant to undo it) and makes `routes/dependency-producers.ts`'s claim that
 *     `GET /decisions?kind=dependency_line_producer` lists every declaration FALSE.
 *  4. **THE MEMBER QUESTION**, settled behaviourally: removing B from `[A, B]` prunes B and leaves A.
 *  5. **THE TRANSFER**, which is this collection's own hazard: identity is the COORDINATE and the
 *     table upserts, so a declaration changes hands with NO row deleted. Owning the destination
 *     component is not enough.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Measured |
 * |---|---|
 * | "fix the inconsistency" in FULL — absent maps to `[]` AND the prune pool is read unconditionally | 1 fails: "(1) an ABSENT producers key…", on the SUBSTANTIVE assertion — `expected undefined to be '<producer id>'`, i.e. the standing declaration was pruned. This is the catastrophic direction and it is the one the message names |
 * | the WEAKER half alone — absent maps to `[]`, prune pool still gated | the same 1 fails, now on the shape: `expected [] to be undefined`. Recorded separately because a half-edit that prunes nothing today is what the next edit completes |
 * | delete both producer loops from `executePlanDiff` | 7 of 11 fail, "(2) WIRING" among them. The 4 that stay green are exactly the plan-time refusals — "(5) cannot declare on a component it does not manage", "(5) SERVICE-valued", and both "(6)" cases — which is the asymmetry the wiring gate exists to expose |
 * | `declareProducerWithEffects` -> a bare `declareDependencyLineProducer` in the apply path | exactly 2 fail: "(3) …CLEARS a poisoned public head" (`expected '2.99.0' to be null`) and "(3) …records its own Decision…". "(2) WIRING" STAYS GREEN — which is precisely why a row-exists gate is not sufficient on its own |
 * | drop the `displacedProducerUrn` guard from `invalidProducerDeclarations` | 1 fails: "(5) a stack cannot TAKE a coordinate…" — the plan is accepted instead of rejected. `plan-diff.test.ts`'s unit case fails alongside it |
 * | drop the commander-only block from `routes/plans.ts`'s apply | 1 fails: "(6) …is refused on a deployment that is not a declared commander" — the apply resolves with a 200 |
 */
describe("iac: dependency-line producer declarations (ADR-0032 §7e)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** `federationRole: "commander"` DECLARES the posture. Producer writes are commander-only and
   *  FAIL-CLOSED on an undeclared deployment (ADR-0032 §7d), and the harness leaves
   *  `SCP_FEDERATION_ROLE` unset by default — under which every apply below would answer 409. The
   *  refusal gets its own server in "(6)". */
  beforeAll(async () => {
    server = await listenTestServer({ federationRole: "commander" });
    org = await createTestOrg(server, "iac-dep-producer");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const npm = (name: string): { ecosystem: DependencyEcosystem; coordinate: string } => ({
    ecosystem: "npm",
    coordinate: `@acme/${name}-${randomUUID().slice(0, 8)}`
  });

  const producerOf = (key: { ecosystem: DependencyEcosystem; coordinate: string }) =>
    inOrg((tx) => getDependencyLineProducer(tx, org.orgId, key));

  const applyLatest = async (manifest: Parameters<typeof admin.plans.create>[0]) => {
    const plan = await admin.plans.create(manifest);
    await admin.plans.apply(plan.id);
    return plan;
  };

  // -------------------------------------------------------------------------------------------
  // (1) THE RULING — an absent collection is UNMANAGED, not empty
  // -------------------------------------------------------------------------------------------

  describe("(1) an ABSENT producers key manages NOTHING", () => {
    it("a stack with a STANDING declaration, whose manifest omits the key, plans NO producer entries and the declaration survives apply", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("unmanaged");

      // `declaring: true` synthesizes a manifest WITH the collection; `false` omits it entirely,
      // because `Stack.synth()` drops an empty one — which is exactly the shape that makes
      // "unmanaged" and "I declare none" indistinguishable, and exactly why absent must not prune.
      function build(declaring: boolean) {
        const app = new App();
        const stack = new Stack(app, stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const component = new Component(stack, "lib", { name: "lib", service });
        if (declaring) component.producesDependency(key);
        return stack.synth();
      }

      await applyLatest(build(true));
      expect((await producerOf(key))?.producerObjectId).toBeTruthy();
      const declaredProducerId = (await producerOf(key))!.producerObjectId;

      // THE ABSENT-KEY MANIFEST. Nothing else about the stack changed, so every OTHER collection is
      // untouched and the only question this plan asks is what an absent `producers` means.
      const omitted = build(false);
      expect(omitted).not.toHaveProperty("producers");

      const plan = await admin.plans.create(omitted);
      await admin.plans.apply(plan.id);

      // THE SUBSTANTIVE ASSERTION FIRST, deliberately: a "fix the inconsistency" edit that makes
      // absent prune fails HERE, on the row being gone, rather than on a shape expectation someone
      // could read as pedantry and update.
      expect(
        (await producerOf(key))?.producerObjectId,
        "an absent producers key manages nothing — the standing declaration must survive"
      ).toBe(declaredProducerId);

      // And the shape, which catches the same edit one step earlier and catches a WEAKER version of
      // it (emit `[]`, prune nothing) that the assertion above cannot see. NOT
      // "summary.deletes === 0" and NOT "no delete entries": the key is ABSENT, because an empty
      // array means "this stack manages producers and has nothing to change" — a different, and
      // here wrong, statement.
      expect(plan.diff.producers).toBeUndefined();
      expect(plan.diff.summary.deletes).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (2) WIRING — the plan SHOWING a create and the apply PERFORMING one are two claims
  // -------------------------------------------------------------------------------------------

  describe("(2) WIRING", () => {
    it("apply WRITES the declaration — delete the producer loops in executePlanDiff and this goes red", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("wiring");

      function build() {
        const app = new App();
        const stack = new Stack(app, stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        new Component(stack, "lib", { name: "lib", service }).producesDependency(key);
        return stack.synth();
      }

      // The manifest really does carry the collection, and the plan really does say `create` — so a
      // failure below is about the APPLY and not about synth or the diff.
      const manifest = build();
      expect(manifest.producers).toEqual([
        {
          producerUrn: `urn:scp:${stackName}:component:lib`,
          ecosystem: key.ecosystem,
          coordinate: key.coordinate
        }
      ]);

      const plan = await admin.plans.create(manifest);
      expect(plan.diff.producers?.map((p) => p.action)).toEqual(["create"]);
      expect(plan.diff.producers?.[0]?.displacedProducerUrn).toBeUndefined();

      await admin.plans.apply(plan.id);

      const component = await admin.components.get(`urn:scp:${stackName}:component:lib`);
      const declaration = await producerOf(key);
      expect(declaration?.producerObjectId).toBe(component.id);
      // Principle 6 — the declaring principal is the APPLYING one, never a manifest field. There is
      // nowhere in `ManifestDependencyProducerSchema` to put a different answer.
      expect(declaration?.declaredByObjectId).toBe((await admin.auth.me()).subjectObjectId);

      // ...and re-applying the identical manifest is a no-op, not a second write (DoD (b)).
      const replan = await admin.plans.create(build());
      expect(replan.diff.producers?.map((p) => p.action)).toEqual(["noop"]);
      expect(replan.diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 4 });
      await admin.plans.apply(replan.id);
      expect((await producerOf(key))?.declaredAt).toBe(declaration?.declaredAt);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (3) THE WHOLE ACT — the row is the least of it
  // -------------------------------------------------------------------------------------------

  describe("(3) IaC performs the WHOLE verb, not just the row write", () => {
    it("declaring through IaC CLEARS a poisoned public head, and retracting through IaC clears the internal one", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("poisoned");

      function build(declaring: boolean) {
        const app = new App();
        const stack = new Stack(app, stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const component = new Component(stack, "lib", { name: "lib", service });
        // A SECOND declaration that is always present, so the "retract one" manifest below still
        // carries a `producers` key — an absent key would manage nothing and prune nothing, which is
        // rule (1) and not what this case is testing.
        component.producesDependency(anchorKey);
        if (declaring) component.producesDependency(key);
        return stack.synth();
      }
      const anchorKey = npm("anchor");

      // THE POISONED HEAD. A stranger published `2.99.0` to the public index under the org's own
      // coordinate and the poll recorded it. Without the clearing this survives the very declaration
      // that exists to undo it, and internal detection can never walk it back down to the org's real
      // `2.1.0` — backward movement is refused at the write door.
      const line = await inOrg(async (tx) => {
        const l = await upsertDependencyLine(tx, org.orgId, { ...key, major: "2" });
        const outcome = await recordDependencyLineHead(
          tx,
          org.orgId,
          { lineId: l.id, latestVersion: "2.99.0", latestDigest: null },
          { kind: "third_party" }
        );
        // Asserted, not assumed: a refused fixture write would leave the head null and make the
        // clearing assertion below pass for the wrong reason.
        expect(outcome.recorded).toBe(true);
        return l;
      });
      expect(
        (await inOrg((tx) => getDependencyLineByKey(tx, org.orgId, { ...key, major: "2" })))
          ?.latestVersion
      ).toBe("2.99.0");

      await applyLatest(build(true));

      const afterDeclare = await inOrg((tx) =>
        getDependencyLineByKey(tx, org.orgId, { ...key, major: "2" })
      );
      expect(afterDeclare?.latestVersion).toBeNull();
      expect(afterDeclare?.latestObservedAt).toBeNull();

      // NOW THE OTHER DIRECTION. The org's own release puts `2.1.0` on the line; retracting must
      // clear it, because `latest_version` is an M22 vendor-scan-rule input and a head from the
      // internal era, on a coordinate that is third-party again, grants a pass against a version no
      // registry ever published.
      const component = await admin.components.get(`urn:scp:${stackName}:component:lib`);
      const internalWrite = await inOrg((tx) =>
        recordDependencyLineHead(
          tx,
          org.orgId,
          { lineId: line.id, latestVersion: "2.1.0", latestDigest: null },
          { kind: "internal", producerObjectId: component.id }
        )
      );
      expect(internalWrite.recorded, JSON.stringify(internalWrite)).toBe(true);
      expect(
        (await inOrg((tx) => getDependencyLineByKey(tx, org.orgId, { ...key, major: "2" })))
          ?.latestVersion
      ).toBe("2.1.0");

      const prune = await admin.plans.create(build(false));
      expect(prune.diff.producers?.map((p) => [p.action, p.coordinate])).toEqual([
        ["noop", anchorKey.coordinate],
        ["delete", key.coordinate]
      ]);
      await admin.plans.apply(prune.id);

      expect(await producerOf(key)).toBeNull();
      expect(
        (await inOrg((tx) => getDependencyLineByKey(tx, org.orgId, { ...key, major: "2" })))
          ?.latestVersion
      ).toBeNull();
    });

    it("records its own Decision and audit event, so the Decision log still answers 'every declaration ever made'", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("recorded");

      const app = new App();
      const stack = new Stack(app, stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(key);
      await applyLatest(stack.synth());

      const component = await admin.components.get(`urn:scp:${stackName}:component:lib`);
      const rows = await inOrg((tx) =>
        tx
          .select()
          .from(decisions)
          .where(
            and(
              eq(decisions.orgId, org.orgId),
              eq(decisions.subjectId, component.id),
              eq(decisions.kind, PRODUCER_DECISION_KIND)
            )
          )
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.verdict).toBe("declared");
      expect(rows[0]?.inputContext).toMatchObject({
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        producerObjectId: component.id,
        // `null` — this declaration displaced nobody. The field is what distinguishes "P is
        // declared" from "the coordinate was taken from Q and given to P".
        displacedProducerObjectId: null
      });

      const audits = await inOrg((tx) =>
        tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.orgId, org.orgId),
              eq(auditEvents.subjectId, component.id),
              eq(auditEvents.action, "dependency.producer.declare")
            )
          )
      );
      expect(audits).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (4) THE MEMBER QUESTION — a PRESENT collection is authoritative over its own members
  // -------------------------------------------------------------------------------------------

  describe("(4) a PRESENT producers collection IS authoritative over its members", () => {
    it("removing entry B from [A, B] prunes B and leaves A — the key stays present, so the prune runs", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const a = npm("keep");
      const b = npm("drop");

      function build(keys: { ecosystem: DependencyEcosystem; coordinate: string }[]) {
        const app = new App();
        const stack = new Stack(app, stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const component = new Component(stack, "lib", { name: "lib", service });
        for (const k of keys) component.producesDependency(k);
        return stack.synth();
      }

      await applyLatest(build([a, b]));
      expect(await producerOf(a)).not.toBeNull();
      expect(await producerOf(b)).not.toBeNull();

      const plan = await admin.plans.create(build([a]));
      const byCoordinate = Object.fromEntries(
        (plan.diff.producers ?? []).map((p) => [p.coordinate, p.action])
      );
      expect(byCoordinate).toEqual({ [a.coordinate]: "noop", [b.coordinate]: "delete" });
      await admin.plans.apply(plan.id);

      expect(await producerOf(a)).not.toBeNull();
      expect(await producerOf(b)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // (5) OWNERSHIP — including the transfer, which is this collection's own hazard
  // -------------------------------------------------------------------------------------------

  describe("(5) ownership", () => {
    it("a stack cannot declare a producer on a component it does not manage", async () => {
      const victimStack = `stack-${randomUUID().slice(0, 8)}`;
      const attackerStack = `stack-${randomUUID().slice(0, 8)}`;

      const victim = new App();
      const vStack = new Stack(victim, victimStack);
      const vService = new Service(vStack, "svc", { name: "Svc" });
      new Component(vStack, "lib", { name: "lib", service: vService });
      await applyLatest(vStack.synth());

      const attacker = new App();
      const aStack = new Stack(attacker, attackerStack);
      const aService = new Service(aStack, "svc", { name: "Svc" });
      new Component(aStack, "own", { name: "own", service: aService });
      aStack.addDependencyProducer(`urn:scp:${victimStack}:component:lib`, npm("stolen"));

      await expect(admin.plans.create(aStack.synth())).rejects.toMatchObject({ status: 400 });
    });

    it("a SERVICE-valued producer is refused, exactly as the typed verb refuses one", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const app = new App();
      const stack = new Stack(app, stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service });
      // The fluent method is on `Component` precisely to make this hard to write; the stack-level
      // escape hatch can still express it, and the SERVER is the authority.
      stack.addDependencyProducer(service, npm("service-valued"));

      await expect(admin.plans.create(stack.synth())).rejects.toMatchObject({ status: 400 });
    });

    it("a stack cannot TAKE a coordinate from another stack's producer — the transfer that deletes no row", async () => {
      const ownerStack = `stack-${randomUUID().slice(0, 8)}`;
      const thiefStack = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("contested");

      const owned = new App();
      const oStack = new Stack(owned, ownerStack);
      const oService = new Service(oStack, "svc", { name: "Svc" });
      new Component(oStack, "lib", { name: "lib", service: oService }).producesDependency(key);
      await applyLatest(oStack.synth());
      const ownerComponent = await admin.components.get(`urn:scp:${ownerStack}:component:lib`);
      expect((await producerOf(key))?.producerObjectId).toBe(ownerComponent.id);

      // The thief owns its OWN component, so the destination-ownership rule passes. What refuses it
      // is that the coordinate's CURRENT producer belongs to a stack this manifest never mentions —
      // and `ON CONFLICT DO UPDATE` would have moved it with nothing deleted, leaving the row
      // outside the owner stack's pool forever.
      const thief = new App();
      const tStack = new Stack(thief, thiefStack);
      const tService = new Service(tStack, "svc", { name: "Svc" });
      new Component(tStack, "mine", { name: "mine", service: tService }).producesDependency(key);

      await expect(admin.plans.create(tStack.synth())).rejects.toMatchObject({ status: 400 });
      expect((await producerOf(key))?.producerObjectId).toBe(ownerComponent.id);
    });

    it("a transfer WITHIN one stack is an UPDATE that names the displaced producer, and it applies", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("moved");

      function build(producer: "old" | "new") {
        const app = new App();
        const stack = new Stack(app, stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const oldLib = new Component(stack, "old", { name: "old", service });
        const newLib = new Component(stack, "new", { name: "new", service });
        (producer === "old" ? oldLib : newLib).producesDependency(key);
        return stack.synth();
      }

      await applyLatest(build("old"));
      const oldComponent = await admin.components.get(`urn:scp:${stackName}:component:old`);
      expect((await producerOf(key))?.producerObjectId).toBe(oldComponent.id);

      const plan = await admin.plans.create(build("new"));
      // NOT a create — the coordinate already has a producer, and a plan that hid that would hide
      // the most consequential thing the apply does.
      expect(plan.diff.producers?.map((p) => p.action)).toEqual(["update"]);
      expect(plan.diff.producers?.[0]?.displacedProducerUrn).toBe(
        `urn:scp:${stackName}:component:old`
      );
      await admin.plans.apply(plan.id);

      const newComponent = await admin.components.get(`urn:scp:${stackName}:component:new`);
      expect((await producerOf(key))?.producerObjectId).toBe(newComponent.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (6) COMMANDER-ONLY — IaC apply is a SECOND door into a commander-only table
  // -------------------------------------------------------------------------------------------

  describe("(6) commander-only", () => {
    let outpost: ListeningTestServer;
    let outpostOrg: TestOrg;
    let outpostAdmin: ScpClient;

    // NO `federationRole` — the harness default leaves `SCP_FEDERATION_ROLE` UNDECLARED, which is
    // the FAIL-CLOSED branch (`config.federationRole` reads 'commander' there, so a value check
    // alone would report the opposite of what happens). That branch is the one that regresses
    // invisibly, which is why it is the one this case constructs.
    beforeAll(async () => {
      outpost = await listenTestServer();
      outpostOrg = await createTestOrg(outpost, "iac-dep-producer-outpost");
      outpostAdmin = new ScpClient({ baseUrl: outpost.baseUrl, token: outpostOrg.adminToken });
    });

    afterAll(async () => {
      await outpost?.close();
    });

    it("applying a plan that DECLARES a producer is refused on a deployment that is not a declared commander", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const app = new App();
      const stack = new Stack(app, stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(npm("elsewhere"));

      // The PLAN computes fine — it writes nothing, and seeing what the commander would do is a
      // legitimate thing to do from anywhere.
      const plan = await outpostAdmin.plans.create(stack.synth());
      expect(plan.diff.producers?.map((p) => p.action)).toEqual(["create"]);

      await expect(outpostAdmin.plans.apply(plan.id)).rejects.toMatchObject({ status: 409 });

      // Fail-closed means the WHOLE apply rolled back, not just the producer half — the component
      // the same plan would have created is not there either.
      await expect(
        outpostAdmin.components.get(`urn:scp:${stackName}:component:lib`)
      ).rejects.toMatchObject({ status: 404 });
    });

    it("a plan that touches NO producer declaration still applies there — the refusal is scoped to the collection, not to IaC", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const app = new App();
      const stack = new Stack(app, stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service });

      const plan = await outpostAdmin.plans.create(stack.synth());
      const { plan: applied } = await outpostAdmin.plans.apply(plan.id);
      expect(applied.status).toBe("applied");
    });
  });
});

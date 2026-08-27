import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { Component, Service, Stack } from "@scp/iac";
import type { DependencyEcosystem } from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import {
  declareDependencyLineProducer,
  getDependencyLineByKey,
  getDependencyLineProducer,
  recordDependencyLineHead,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import { PRODUCER_DECISION_KIND } from "../dependencies/producer-declaration.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
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
 *  7. **THE PLAN/APPLY WINDOW.** Every refusal in (5) is derived from the STORED diff —
 *     deliberately, so a plan written by an older build is re-checked — and that is exactly what
 *     makes the diff's account of WHO HOLDS the coordinate un-recheckable once the world moves.
 *     Three shapes, three different wrong outcomes, all silent; the `delete` one RETRACTS SOMEBODY
 *     ELSE'S declaration.
 *  8. **THE AUTHORITY**, which was present and held by NOTHING — see (8)'s own header.
 *  9. **A HOLDER THAT CANNOT BE NAMED IS STILL A HOLDER.** A tombstoned producer component leaves
 *     its declaration standing, and the snapshot's null-drop made the diff report `create` about a
 *     coordinate that is declared.
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
 * | drop both `assertPlannedProducerHolder` calls from `executePlanDiff` | exactly 3 fail, one per shape, each on the SUBSTANTIVE assertion rather than on the refusal: CREATE and UPDATE read `expected '<the stack's component>' to be '<the interloper>'` — the coordinate was taken from the component that claimed it in the window — and DELETE reads `expected undefined to be '<the interloper>'`, the silent retraction. "(7) …a plan whose world did NOT move still applies" stays green, so the guard is proven to be about DISAGREEMENT and not about refusing to re-apply |
 * | delete `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` | exactly 1 fails: "(8)(b) …the SAME Operator is REFUSED a plan that declares one" — `promise resolved … instead of rejecting`, the plan applies with `creates: 4` and the declaration is written by a principal holding `policy:write` nowhere. "(8)(a)" stays green, which is what makes the 403 a statement about the collection rather than about Operators and plans |
 * | restore the shared null-drop — `toExisting = toManaged`, both pools filtered | exactly 1 fails: "(9) a coordinate whose producer component was deleted…" — `POST /plans` resolves instead of rejecting, and the diff it returns reads `"action":"create"` with the reason `no producer is declared for … it is polled as third-party today` about a coordinate that IS declared. Measured on the same run: the apply is then stopped by (7)'s guard with `409 … it was computed when the coordinate was declared by nobody, and it is now declared by 'urn:scp:…:component:lib'` — the two layers are independent, and only this one keeps the reviewed plan honest |
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
        const stack = new Stack(stackName);
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
        const stack = new Stack(stackName);
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
        const stack = new Stack(stackName);
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

      const stack = new Stack(stackName);
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
        const stack = new Stack(stackName);
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

      const vStack = new Stack(victimStack);
      const vService = new Service(vStack, "svc", { name: "Svc" });
      new Component(vStack, "lib", { name: "lib", service: vService });
      await applyLatest(vStack.synth());

      const aStack = new Stack(attackerStack);
      const aService = new Service(aStack, "svc", { name: "Svc" });
      new Component(aStack, "own", { name: "own", service: aService });
      aStack.addDependencyProducer(`urn:scp:${victimStack}:component:lib`, npm("stolen"));

      await expect(admin.plans.create(aStack.synth())).rejects.toMatchObject({ status: 400 });
    });

    it("a SERVICE-valued producer is refused, exactly as the typed verb refuses one", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
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

      const oStack = new Stack(ownerStack);
      const oService = new Service(oStack, "svc", { name: "Svc" });
      new Component(oStack, "lib", { name: "lib", service: oService }).producesDependency(key);
      await applyLatest(oStack.synth());
      const ownerComponent = await admin.components.get(`urn:scp:${ownerStack}:component:lib`);
      expect((await producerOf(key))?.producerObjectId).toBe(ownerComponent.id);

      // The thief owns its OWN component, so the destination-ownership rule passes. What refuses it
      // is that the coordinate's CURRENT producer belongs to a stack this manifest never mentions —
      // and `ON CONFLICT DO UPDATE` would have moved it with nothing deleted, leaving the row
      // outside the owner stack's pool forever.
      const tStack = new Stack(thiefStack);
      const tService = new Service(tStack, "svc", { name: "Svc" });
      new Component(tStack, "mine", { name: "mine", service: tService }).producesDependency(key);

      await expect(admin.plans.create(tStack.synth())).rejects.toMatchObject({ status: 400 });
      expect((await producerOf(key))?.producerObjectId).toBe(ownerComponent.id);
    });

    it("a transfer WITHIN one stack is an UPDATE that names the displaced producer, and it applies", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("moved");

      function build(producer: "old" | "new") {
        const stack = new Stack(stackName);
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
      const stack = new Stack(stackName);
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
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service });

      const plan = await outpostAdmin.plans.create(stack.synth());
      const { plan: applied } = await outpostAdmin.plans.apply(plan.id);
      expect(applied.status).toBe("applied");
    });
  });

  // -------------------------------------------------------------------------------------------
  // (7) THE WINDOW BETWEEN PLAN AND APPLY — the stored diff is a CLAIM about who holds a coordinate
  // -------------------------------------------------------------------------------------------

  /**
   * `dependency_line_producers` is keyed on the COORDINATE and upserted, so it can change hands with
   * no row deleted, nothing to stale-mark the plan, and no trace in either stack's prune pool. Every
   * guard section (5) proves is derived from the STORED diff — deliberately, so a plan written by an
   * older build is re-checked — and that same property is what makes the diff's own account of the
   * world un-recheckable once the world moves. `executePlanDiff` therefore re-reads the live holder
   * for every non-noop entry.
   *
   * THE WINDOW IS DRIVEN AT THE REPO SEAM, the precedent
   * `version-poll.integration.test.ts`'s race replays set: `declareDependencyLineProducer` is
   * verbatim what the verb writes, called between `POST /plans` and `POST /plans/{id}/apply`, which
   * are two separate HTTP requests in production and therefore a real wall-clock gap.
   */
  describe("(7) a plan is re-checked against the LIVE holder at apply time", () => {
    /** A component outside every stack here — the party that takes the coordinate in the window. */
    let interloper: string;

    beforeAll(async () => {
      interloper = (await createOrphanComponent(admin, `interloper-${randomUUID().slice(0, 8)}`))
        .id;
    });

    /**
     * The apply, DRIVEN TO COMPLETION whichever way it goes, so each case can assert the state of
     * the coordinate FIRST. That ordering is deliberate and is the file's own discipline from (1):
     * with `rejects.toMatchObject` first, removing the guard fails on "promise resolved instead of
     * rejecting" and the damage it did is never read. Here the substantive assertion goes first, so
     * the measured failure names the wrong OUTCOME — whose declaration was overwritten or retracted.
     */
    const applyOutcome = (planId: string): Promise<unknown> =>
      admin.plans.apply(planId).then(
        () => null,
        (err: unknown) => err
      );

    /** The verb's own row write, landing in the plan/apply window. */
    const declareInWindow = (
      key: { ecosystem: DependencyEcosystem; coordinate: string },
      producerObjectId: string
    ) =>
      inOrg((tx) =>
        declareDependencyLineProducer(tx, org.orgId, {
          ...key,
          producerObjectId,
          declaredByObjectId: producerObjectId
        })
      );

    it("a CREATE whose coordinate was claimed in the window is REFUSED, not silently applied over the new holder", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("claimed-late");

      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(key);

      // The plan is computed against a world where the coordinate is third-party, and SAYS SO — the
      // sentence the operator reads, and the reason no ownership guard can object to this diff.
      const plan = await admin.plans.create(stack.synth());
      expect(plan.diff.producers?.map((p) => p.action)).toEqual(["create"]);
      expect(plan.diff.producers?.[0]?.displacedProducerUrn).toBeUndefined();

      await declareInWindow(key, interloper);
      const outcome = await applyOutcome(plan.id);

      // The interloper's declaration is untouched — the outcome the stored diff would otherwise
      // produce is a TRANSFER away from it, performed by a plan that reviewed as a first declaration.
      expect(
        (await producerOf(key))?.producerObjectId,
        "the coordinate must still belong to the component that claimed it in the window"
      ).toBe(interloper);
      expect(outcome).toMatchObject({
        status: 409,
        problem: { detail: expect.stringContaining("this plan is stale") }
      });
      // …and fail-closed means the whole apply rolled back, not just the producer half.
      await expect(
        admin.components.get(`urn:scp:${stackName}:component:lib`)
      ).rejects.toMatchObject({ status: 404 });
    });

    it("an UPDATE is REFUSED when the producer it planned to displace is no longer the one holding the coordinate", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("displaced-late");

      function build(producer: "old" | "new") {
        const stack = new Stack(stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const oldLib = new Component(stack, "old", { name: "old", service });
        const newLib = new Component(stack, "new", { name: "new", service });
        (producer === "old" ? oldLib : newLib).producesDependency(key);
        return stack.synth();
      }

      await applyLatest(build("old"));
      const oldComponent = await admin.components.get(`urn:scp:${stackName}:component:old`);

      // A legitimate WITHIN-STACK transfer, exactly the shape section (5) applies successfully: the
      // plan names `old` as the displaced producer, and `old` is this stack's.
      const plan = await admin.plans.create(build("new"));
      expect(plan.diff.producers?.[0]?.displacedProducerUrn).toBe(
        `urn:scp:${stackName}:component:old`
      );

      // …but in the window the coordinate moves to a THIRD component the plan never names. Applying
      // the stored entry would take it from the interloper, and the displacement guard cannot see
      // that: the diff it re-checks still says the displaced producer is `old`, which this stack owns.
      await declareInWindow(key, interloper);
      const outcome = await applyOutcome(plan.id);

      expect(
        (await producerOf(key))?.producerObjectId,
        "the plan must not take the coordinate from a THIRD component it never named"
      ).toBe(interloper);
      // The refusal NAMES the producer the plan believed it was displacing, because that is the
      // fact an operator has to reconcile against what is actually there now.
      expect(outcome).toMatchObject({
        status: 409,
        problem: { detail: expect.stringContaining(oldComponent.urn) }
      });
    });

    it("a DELETE is REFUSED when the row it planned to retract now belongs to someone else — a silent retraction", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const keep = npm("keep-late");
      const drop = npm("drop-late");

      function build(keys: { ecosystem: DependencyEcosystem; coordinate: string }[]) {
        const stack = new Stack(stackName);
        const service = new Service(stack, "svc", { name: "Svc" });
        const component = new Component(stack, "lib", { name: "lib", service });
        for (const k of keys) component.producesDependency(k);
        return stack.synth();
      }

      await applyLatest(build([keep, drop]));
      const plan = await admin.plans.create(build([keep]));
      expect(
        Object.fromEntries((plan.diff.producers ?? []).map((p) => [p.coordinate, p.action]))
      ).toEqual({ [keep.coordinate]: "noop", [drop.coordinate]: "delete" });

      // The coordinate changes hands in the window. The existence check alone is satisfied — a row
      // IS there — so the pre-fix apply retracted the INTERLOPER's declaration and returned the
      // coordinate to third-party polling for a component that had just claimed it.
      await declareInWindow(drop, interloper);
      const outcome = await applyOutcome(plan.id);

      expect(
        (await producerOf(drop))?.producerObjectId,
        "the interloper's declaration must survive a prune that named a different producer"
      ).toBe(interloper);
      expect(outcome).toMatchObject({
        status: 409,
        problem: { detail: expect.stringContaining(drop.coordinate) }
      });
    });

    it("…and a plan whose world did NOT move still applies — the guard is about disagreement, not about re-reading", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("unmoved");

      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(key);

      const plan = await admin.plans.create(stack.synth());
      const { plan: applied } = await admin.plans.apply(plan.id);
      expect(applied.status).toBe("applied");
      const component = await admin.components.get(`urn:scp:${stackName}:component:lib`);
      expect((await producerOf(key))?.producerObjectId).toBe(component.id);
    });
  });

  // -------------------------------------------------------------------------------------------
  // (8) AUTHORITY — `policy:write` at the ORG ROOT, which is the whole reason this collection
  //     does not use the per-object `object:write` every other one does
  // -------------------------------------------------------------------------------------------

  /**
   * THE GUARD THIS PINS WAS HELD BY NOTHING. Deleting
   * `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` left 46 tests green
   * — a security check that is present and uninstalled, which is the exact class this whole
   * increment exists to close. A guard nobody exercises is one the next refactor removes without a
   * symptom.
   *
   * `Operator` IS THE RIGHT PRINCIPAL, and the two cases below are one pair on purpose. Operator
   * carries `object:write` and NOT `policy:write` (the `0002` seed; `0010` adds `policy:write` to
   * Administrator and Owner only), so at the ORG ROOT it holds authority over every object in the
   * org and still holds none over a producer declaration. Case (a) is what makes case (b) mean
   * something: without it, a 403 would be satisfied by an Operator who simply cannot apply plans.
   *
   * MUTATION — applied, watched fail, reverted, watched pass:
   * | Mutation | Measured |
   * |---|---|
   * | delete `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` | "(8) … a plan that DECLARES one is REFUSED" fails: the apply resolves 200 and the declaration is written by a principal holding no `policy:write` anywhere. "(a)" stays green |
   */
  describe("(8) a producer declaration needs policy:write AT THE ORG ROOT", () => {
    let operator: ScpClient;

    beforeAll(async () => {
      const user = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
      operator = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
    });

    it("(a) an Operator bound at the ORG ROOT applies a plan that declares NO producer", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service });

      const plan = await operator.plans.create(stack.synth());
      const { plan: applied } = await operator.plans.apply(plan.id);
      expect(applied.status).toBe("applied");
    });

    it("(b) …and the SAME Operator is REFUSED a plan that declares one — object:write over every object in the org is not authority over a coordinate", async () => {
      const stackName = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("unauthorized");
      const stack = new Stack(stackName);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(key);

      // The PLAN is fine — computing a diff writes nothing, and the authority is per-apply.
      const plan = await operator.plans.create(stack.synth());
      expect(plan.diff.producers?.map((p) => p.action)).toEqual(["create"]);

      await expect(operator.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

      // Nothing was written, and nothing was HALF written: the checks are drained to completion
      // before `executePlanDiff` runs, so the component this plan would have created is absent too.
      expect(await producerOf(key)).toBeNull();
      await expect(
        admin.components.get(`urn:scp:${stackName}:component:lib`)
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  // -------------------------------------------------------------------------------------------
  // (9) A HOLDER THAT CANNOT BE NAMED IS STILL A HOLDER
  // -------------------------------------------------------------------------------------------

  /**
   * A tombstoned producer component leaves its declaration STANDING — `deleteObject` is a soft
   * delete and `dependency_line_producers` has no `deleted_at` — while every object read in
   * `plans-repo.ts` filters `deleted_at IS NULL`, so the holder resolves to no URN.
   *
   * The snapshot used to DROP such a row from both producer pools and call that "conservative in the
   * safe direction". For the prune pool it is. For the EXISTENCE pool it is the opposite: the diff
   * then emits `create`, whose reason sentence reads "no producer is declared for this coordinate —
   * it is polled as third-party today" about a coordinate that IS declared, and the apply upserts
   * straight over the standing row. The reviewed plan is false about the one fact that separates a
   * first declaration from a transfer.
   *
   * THE STRANDING IS PRODUCED BY THE PRODUCT'S OWN RULES, not by a hand-written row: rule (1) — an
   * absent `producers` key manages nothing — is exactly how a stack deletes a component without
   * retracting what it produced.
   */
  describe("(9) a declaration behind a TOMBSTONED producer still blocks a create", () => {
    it("a coordinate whose producer component was deleted is an UPDATE naming the unresolvable holder, and the plan is refused", async () => {
      const firstStack = `stack-${randomUUID().slice(0, 8)}`;
      const secondStack = `stack-${randomUUID().slice(0, 8)}`;
      const key = npm("stranded");

      const stack = new Stack(firstStack);
      const service = new Service(stack, "svc", { name: "Svc" });
      new Component(stack, "lib", { name: "lib", service }).producesDependency(key);
      await applyLatest(stack.synth());
      const producer = await admin.components.get(`urn:scp:${firstStack}:component:lib`);
      expect((await producerOf(key))?.producerObjectId).toBe(producer.id);

      // THE STRANDING. The same stack, minus the component and WITHOUT a `producers` key: the
      // component is pruned and rule (1) retracts nothing, so the declaration outlives its producer.
      const emptiedStack = new Stack(firstStack);
      new Service(emptiedStack, "svc", { name: "Svc" });
      const strand = emptiedStack.synth();
      expect(strand).not.toHaveProperty("producers");
      await applyLatest(strand);

      await expect(
        admin.components.get(`urn:scp:${firstStack}:component:lib`)
      ).rejects.toMatchObject({ status: 404 });
      expect(
        (await producerOf(key))?.producerObjectId,
        "the declaration must have outlived its producer — otherwise this case tests nothing"
      ).toBe(producer.id);

      // A DIFFERENT stack now claims the coordinate on a component it owns. Destination ownership
      // is satisfied, so refusal (1) passes; what must refuse it is that the coordinate is HELD.
      const sStack = new Stack(secondStack);
      const sService = new Service(sStack, "svc", { name: "Svc" });
      new Component(sStack, "mine", { name: "mine", service: sService }).producesDependency(key);

      await expect(admin.plans.create(sStack.synth())).rejects.toMatchObject({
        status: 400,
        problem: { detail: expect.stringContaining("no longer resolves") }
      });
      expect(
        (await producerOf(key))?.producerObjectId,
        "…and the standing declaration is untouched"
      ).toBe(producer.id);
    });
  });
});

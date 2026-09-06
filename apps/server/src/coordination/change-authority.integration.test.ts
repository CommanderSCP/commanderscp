import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships, roleBindings, roles } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Change target-authority (M12 P4B Phase 2). A `change`, like a `campaign`, binds its authority to
 * a DECLARED `properties.targets` field, and P4B makes that load-bearing (a `requires`/`provides`
 * coupling against an object you don't control is an escalation). Two holes are closed here, mirror-
 * imaging campaign's own SECURITY tests (`campaign.integration.test.ts`):
 *   1. `POST /changes` now authorizes `object:write` over EVERY target, not just the change's domain.
 *   2. the generic `/objects/change` route refuses every write verb, so a change can be created and
 *      mutated ONLY through the typed, target-checked path.
 *
 * ADR-0028 added a THIRD declared field that reaches out of the actor's own scope, and the last
 * section of this file covers it: `stageDependencies` is materialised as a `depends_on` edge
 * (`changes-repo.ts`), and `createRelationship` performs no authz of its own — so every door that
 * carries a declaration has to demand the same both-endpoint `relationship:write`
 * `POST /relationships` demands, or `POST /changes` becomes a way to mint the edge the graph route
 * refuses. Both doors are exercised: the typed propose, and the persist-then-process ingress whose
 * processor runs as SYSTEM_ACTOR_ID and therefore cannot do the check itself.
 */
describe("change target-authority (M12 P4B Phase 2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "change-authority");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  /** Live `depends_on` rows, read straight from the table: the API's own edge listings are
   *  authority-filtered, and a test for an authority hole must not read through the thing it is
   *  testing. */
  const dependsOnEdges = (fromId: string, toId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "depends_on"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );

  it("SECURITY: propose is refused for a target OUTSIDE the actor's authority, but allowed WITHIN it — isolating the target check from the domain check", async () => {
    // `outsideTarget` sits at the org root (default domain); `ownTarget` sits inside a domain the
    // narrow actor administers. The actor holds Administrator ONLY at `ownDomain`.
    const outsideTarget = await createTestComponent(admin, {
      name: `chg-outside-${randomUUID().slice(0, 8)}`
    });
    const ownDomain = await admin.domains.create({
      name: `chg-own-domain-${randomUUID().slice(0, 8)}`
    });
    const ownTarget = await createTestComponent(admin, {
      name: `chg-own-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const narrow = await createTestUser(server, org, [
      { role: "Administrator", scope: ownDomain.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrow.token });

    // domainId = ownDomain PASSES the change's domain-level `object:write` check, so a rejection here
    // can ONLY come from the new per-TARGET check — the actor has no authority over `outsideTarget`.
    await expect(
      narrowClient.changes.propose({
        name: "cross-domain-change",
        domainId: ownDomain.id,
        targets: [outsideTarget.id]
      })
    ).rejects.toMatchObject({ status: 403 });

    // Same actor, same domain, but a target INSIDE its authority — allowed. Proves the guard isn't
    // simply rejecting everything the narrow actor proposes.
    const ok = await narrowClient.changes.propose({
      name: "own-domain-change",
      domainId: ownDomain.id,
      targets: [ownTarget.id]
    });
    expect(ok.id).toBeTruthy();

    const list = await admin.changes.list({ limit: 100 });
    expect(list.items.every((c) => c.name !== "cross-domain-change")).toBe(true);
  });

  it("SECURITY: the generic /objects/change endpoint refuses every write verb, even for the org-root admin", async () => {
    const target = await createTestComponent(admin, {
      name: `chg-generic-${randomUUID().slice(0, 8)}`
    });

    // create via the generic route → 403, even for the full-authority admin: an unconditional
    // type-level block, not a permission gap. Without it, this bypasses proposeChange's whole
    // lifecycle (state machine, plan) AND the per-target check above.
    await expect(
      admin
        .object("change")
        .create({ name: "sneaky-change-via-generic", properties: { targets: [target.id] } })
    ).rejects.toMatchObject({ status: 403 });

    // PATCH/DELETE a legitimately-proposed change → 403: nobody can flip a coordinated change's
    // routing `type` (P4A) or `requires`/`provides` (P4B) mid-flight, or delete it out from under the engine.
    const legit = await admin.changes.propose({
      name: "legit-change-for-generic-block",
      targets: [target.id]
    });
    await expect(
      admin.object("change").update(legit.id, { properties: { type: "infrastructure" } })
    ).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("change").delete(legit.id)).rejects.toMatchObject({ status: 403 });
  });

  // ADR-0028 — the declared STAGE DEPENDENCIES, which mint a `depends_on` edge.

  it("SECURITY: a stage dependency naming a component OUTSIDE the actor's authority is refused, and mints NO edge", async () => {
    // The `targets` check above passes cleanly here — the actor owns its target and its domain — so
    // a rejection can only come from the `stageDependencies` check. Without it, `POST /changes`
    // writes a `depends_on` edge onto a component at the org root that `POST /relationships` refuses
    // this same actor with 403, and nothing ever prunes it: `graph.dependentIds` is a live CEL
    // policy input, so the victim's governance verdicts can be flipped by a stranger's release.
    const outsideDependency = await createTestComponent(admin, {
      name: `sd-outside-${randomUUID().slice(0, 8)}`
    });
    const ownDomain = await admin.domains.create({
      name: `sd-own-domain-${randomUUID().slice(0, 8)}`
    });
    const ownTarget = await createTestComponent(admin, {
      name: `sd-own-target-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const ownDependency = await createTestComponent(admin, {
      name: `sd-own-dep-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const narrow = await createTestUser(server, org, [
      { role: "Administrator", scope: ownDomain.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrow.token });

    await expect(
      narrowClient.changes.propose({
        name: "stage-dep-escalation",
        domainId: ownDomain.id,
        targets: [ownTarget.id],
        stageDependencies: [{ dependsOn: outsideDependency.id }]
      })
    ).rejects.toMatchObject({ status: 403 });

    // The whole point: refused BEFORE anything is written. A 403 that still left the edge behind
    // would leave the escalation intact and only hide it.
    expect(await dependsOnEdges(ownTarget.id, outsideDependency.id)).toHaveLength(0);
    const list = await admin.changes.list({ limit: 100 });
    expect(list.items.every((c) => c.name !== "stage-dep-escalation")).toBe(true);

    // Same actor, a dependency INSIDE its authority — allowed, and the edge IS written. Proves the
    // guard binds to authority rather than simply refusing every declaration a narrow actor makes.
    const ok = await narrowClient.changes.propose({
      name: "stage-dep-within-authority",
      domainId: ownDomain.id,
      targets: [ownTarget.id],
      stageDependencies: [{ dependsOn: ownDependency.id }]
    });
    expect(ok.id).toBeTruthy();
    expect(await dependsOnEdges(ownTarget.id, ownDependency.id)).toHaveLength(1);
  });

  it("SECURITY: an `atTargets` entry the actor cannot even READ is refused", async () => {
    // `atTargets` mints nothing — it only NARROWS the hold on the actor's own change — so its bar is
    // `object:read`, not the endpoint bar. It is still a bar: a coupling may not be scoped by a place
    // its author cannot see.
    const ownDomain = await admin.domains.create({
      name: `sd-at-domain-${randomUUID().slice(0, 8)}`
    });
    const ownTarget = await createTestComponent(admin, {
      name: `sd-at-target-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const ownDependency = await createTestComponent(admin, {
      name: `sd-at-dep-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const outsidePlace = await admin.object("deployment-target").create({
      name: `sd-at-place-${randomUUID().slice(0, 8)}`,
      properties: { environment: "gamma" }
    });
    const ownPlace = await admin.object("deployment-target").create({
      name: `sd-at-own-place-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id,
      properties: { environment: "gamma" }
    });
    const narrow = await createTestUser(server, org, [
      { role: "Administrator", scope: ownDomain.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrow.token });

    await expect(
      narrowClient.changes.propose({
        name: "stage-dep-at-escalation",
        domainId: ownDomain.id,
        targets: [ownTarget.id],
        stageDependencies: [{ dependsOn: ownDependency.id, atTargets: [outsidePlace.id] }]
      })
    ).rejects.toMatchObject({ status: 403 });

    // A place within its authority — allowed, so the qualifier stays usable by the component teams
    // it is for.
    const ok = await narrowClient.changes.propose({
      name: "stage-dep-at-within-authority",
      domainId: ownDomain.id,
      targets: [ownTarget.id],
      stageDependencies: [{ dependsOn: ownDependency.id, atTargets: [ownPlace.id] }]
    });
    expect(ok.properties.stageDependencies).toEqual([
      { dependsOn: ownDependency.id, atTargets: [ownPlace.id] }
    ]);
  });

  it("SECURITY: the CI ingress door demands the SAME edge authority — object:write alone cannot declare a dependency", async () => {
    // THE SECOND DOOR. `POST /change-sources/{kind}/report` (and the raw `/webhook` beside it) lifts
    // `stageDependencies` off the body and threads it into the same `proposeChange`, but the
    // processor runs as SYSTEM_ACTOR_ID — so the reporting principal only exists at the route, and
    // the check has to be there or be vacuous. The ingress permission is `object:write` at the org
    // root, which is NOT `relationship:write`: this reporter holds the former and not the latter,
    // which is exactly the gap a route-name census misses.
    const dependency = await createTestComponent(admin, {
      name: `sd-ingress-dep-${randomUUID().slice(0, 8)}`
    });
    const component = await createTestComponent(admin, {
      name: `sd-ingress-a-${randomUUID().slice(0, 8)}`
    });
    const repo = `acme/sd-ingress-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", {
      repoPattern: repo,
      component: component.id
    });

    const reporter = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = uuidv7();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `object-writer-no-edges-${randomUUID().slice(0, 8)}`,
        permissions: ["object:write"]
      });
      await tx.insert(roleBindings).values({
        id: uuidv7(),
        orgId: org.orgId,
        subjectId: reporter.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    const reporterClient = new ScpClient({ baseUrl: server.baseUrl, token: reporter.token });

    // The legitimate case first, so the refusal below cannot be "this reporter can't report at all".
    const plain = await reporterClient.changeSources.report("terraform", {
      status: "applied",
      repo
    });
    expect(plain.accepted).toBe(true);

    await expect(
      reporterClient.changeSources.report("terraform", {
        status: "applied",
        repo,
        stageDependencies: [{ dependsOn: dependency.id }]
      })
    ).rejects.toMatchObject({ status: 403 });

    // The raw webhook body is the same door wearing different clothes — `genericHint` reads
    // `stageDependencies` off the top level of an arbitrary payload, so a check that only guarded
    // the typed route would guard nothing.
    await expect(
      reporterClient.changeSources.webhook("terraform", {
        repo,
        stageDependencies: [{ dependsOn: dependency.id }]
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("SECURITY: `properties.stageDependencies` is not a third door — the typed field is the only one", async () => {
    // THE DOOR A CENSUS BY FIELD NAME MISSES. `POST /changes` authorizes the TYPED
    // `stageDependencies` and passes `properties` through untouched, so as long as `proposeChange`
    // honoured a `properties.stageDependencies` fallback, the identical declaration the typed field
    // 403s could be smuggled in beside it and the hold would honour it: an authority bypass, plus
    // disclosure of the named component's deployment state through the hold Decision's
    // `branch`/`dependencyStatus`.
    //
    // Closed the way `requires` was — no fallback at all — because no legitimate caller needs one:
    // campaign fan-out and rollback pass no properties, and federation promotion STRIPS
    // `stageDependencies` before it re-proposes.
    const outsideDependency = await createTestComponent(admin, {
      name: `sd-props-outside-${randomUUID().slice(0, 8)}`
    });
    const ownDomain = await admin.domains.create({
      name: `sd-props-domain-${randomUUID().slice(0, 8)}`
    });
    const ownTarget = await createTestComponent(admin, {
      name: `sd-props-target-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const narrow = await createTestUser(server, org, [
      { role: "Administrator", scope: ownDomain.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrow.token });

    // The control: through the typed field this is a 403 (the test above pins why).
    await expect(
      narrowClient.changes.propose({
        name: "sd-props-typed",
        domainId: ownDomain.id,
        targets: [ownTarget.id],
        stageDependencies: [{ dependsOn: outsideDependency.id }]
      })
    ).rejects.toMatchObject({ status: 403 });

    // The same declaration through `properties`. It is ACCEPTED as a propose — nothing about the
    // change is illegitimate — but the declaration itself must not survive into storage, because
    // only a resolved, authorized one may ever be stored.
    const smuggled = await narrowClient.changes.propose({
      name: "sd-props-smuggled",
      domainId: ownDomain.id,
      targets: [ownTarget.id],
      properties: { stageDependencies: [{ dependsOn: outsideDependency.id }] }
    });
    const stored = await admin.changes.get(smuggled.id);
    expect(stored.properties).not.toHaveProperty("stageDependencies");
    // And no edge either way — the writer only ever reads the resolved typed field.
    expect(await dependsOnEdges(ownTarget.id, outsideDependency.id)).toHaveLength(0);
  });
});

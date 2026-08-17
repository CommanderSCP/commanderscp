import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DesiredStateManifest, GraphObject, Plan, PlanDiff, Relationship } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * IaC STACK OWNERSHIP IS NOT WRITABLE BY ITS SUBJECT (drizzle/0068)
 * ================================================================================================
 *
 * THE PROPERTY. A governance decision whose match key is writable by its own subject, at a weaker
 * permission than the one that authored the constraint. Here the decision is the IaC PRUNE POOL —
 * which live rows an apply DELETES — and the match key WAS the `scp:managed-by`/`scp:stack` pair in
 * the row's own `labels`, writable at plain `object:write` AT THE OBJECT, validated by nothing.
 *
 * Both directions were reproduced against these exact doors before the fix; the cases below are
 * those reproductions with their expectations inverted, so the file reads as what it measured:
 *
 *   R1 ENROLMENT — an Operator bound at ONE object, holding no IaC authority at all, PATCHed two
 *   label keys onto it. The stack's UNCHANGED manifest then proposed deleting it, over the reason
 *   "previously managed by this stack, no longer present in the desired manifest", which was false.
 *   The apply executed that delete and the object 404'd.
 *
 *   R2 ESCAPE — the object's owner stripped the two keys. The object left the pool, so when its
 *   stack later dropped it from the manifest to decommission it, ZERO deletes were proposed. It
 *   survived its own decommission with nothing in the diff to notice.
 *
 * WHY THIS FILE IS AN INTEGRATION TEST AND NOT A UNIT TEST. `plan-diff.test.ts` proves the
 * predicate DECIDES correctly and cannot prove it is WIRED — a suite that calls `isStackManaged`
 * directly stays green with every installation deleted, which is this repo's dominant defect class.
 * So every case here drives real HTTP doors: `PATCH /objects/{type}/{id}`, `POST /plans`,
 * `POST /plans/{id}/apply`.
 *
 * INSTALLATION PROVEN BY MUTATION. Each of these was applied alone against a green suite and the
 * named case watched to fail (log in the PR body):
 *
 *   1. `fetchManagedObjects` back to the `labels @> managedLabels(stack)` containment test  -> R1, R2
 *   2. `isStackManaged(existing.managedByStack, …)` -> `isStackManaged(existing.labels?.…)`   -> R1, R2
 *   3. delete the `stampObjectStackOwnership` call in `executePlanDiff`                       -> R2, A1
 *   4. narrow that stamp to `action === "create"` (i.e. drop `update`/`noop`)                 -> A1
 *   5. delete the `stampRelationshipStackOwnership` call                                      -> E1
 *   6. `fetchManagedRelationships` back to the label containment test                         -> E1
 */
describe("IaC stack ownership is server-written, not tenant-written", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "iac-stack-own");
  });

  afterAll(async () => {
    await server.close();
  });

  async function call(
    token: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown
  ) {
    return await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never
    });
  }

  async function planOnly(manifest: DesiredStateManifest): Promise<PlanDiff> {
    const res = await call(org.adminToken, "POST", "/api/v1/plans", { manifest });
    expect(res.statusCode).toBe(201);
    return (res.json() as Plan).diff;
  }

  async function applyManifest(manifest: DesiredStateManifest): Promise<PlanDiff> {
    const planRes = await call(org.adminToken, "POST", "/api/v1/plans", { manifest });
    expect(planRes.statusCode).toBe(201);
    const plan = planRes.json() as Plan;
    const applyRes = await call(org.adminToken, "POST", `/api/v1/plans/${plan.id}/apply`, {});
    expect(applyRes.statusCode).toBe(200);
    return plan.diff;
  }

  function service(urn: string, name: string) {
    return { urn, typeId: "service", name, properties: {}, labels: {} };
  }

  it("R1 ENROLMENT: writing the marker labels onto an object does NOT enrol it in a stack's prune pool", async () => {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const declaredUrn = `urn:scp:${stackName}:service:declared`;
    const victimUrn = `urn:scp:${stackName}-victim:service:victim`;

    // The stack's real desired state — it names ONE object and never mentions the victim.
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [service(declaredUrn, "Declared")],
      relationships: []
    };
    expect((await applyManifest(manifest)).summary).toEqual({
      creates: 1,
      updates: 0,
      deletes: 0,
      noops: 0
    });

    // A victim object created OUTSIDE the stack, by someone else.
    const created = await call(org.adminToken, "PUT", `/api/v1/objects/service/${victimUrn}`, {
      name: "Victim"
    });
    expect(created.statusCode).toBe(201);
    const victim = created.json() as GraphObject;

    // The attacker: an Operator bound at the VICTIM object only — `object:write` there and nowhere
    // else. No IaC authority, no manifest, no plan permission.
    const attacker = await createTestUser(server, org, [{ role: "Operator", scope: victim.id }]);

    // THE WRITE. It is still ALLOWED — `labels` stays free-form tenant data, which is the whole
    // point of moving ownership out of it rather than reserving keys inside it. A 403 here would
    // mean the fix had been rebuilt as a label-namespace rule, which this deliberately is not.
    const relabel = await call(attacker.token, "PATCH", `/api/v1/objects/service/${victim.id}`, {
      labels: { "scp:managed-by": "iac", "scp:stack": stackName }
    });
    expect(relabel.statusCode).toBe(200);
    expect((relabel.json() as GraphObject).labels).toEqual({
      "scp:managed-by": "iac",
      "scp:stack": stackName
    });

    // AND IT BUYS NOTHING. The stack's unchanged manifest proposes exactly what it did before.
    const diff = await planOnly(manifest);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });
    expect(diff.objects.filter((o) => o.action === "delete")).toEqual([]);

    // Belt and braces: the apply is a real no-op and the victim is still there afterwards.
    await applyManifest(manifest);
    const after = await call(org.adminToken, "GET", `/api/v1/objects/service/${victim.id}`);
    expect(after.statusCode).toBe(200);
  });

  it("R2 ESCAPE: stripping the marker labels does NOT remove an object from its stack's prune pool", async () => {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const keptUrn = `urn:scp:${stackName}:service:kept`;
    const escaperUrn = `urn:scp:${stackName}:service:escaper`;

    await applyManifest({
      stackName,
      objects: [service(keptUrn, "Kept"), service(escaperUrn, "Escaper")],
      relationships: []
    });

    const escaperRes = await call(org.adminToken, "GET", `/api/v1/objects/service/${escaperUrn}`);
    const escaper = escaperRes.json() as GraphObject;
    // The mirror is written, and is asserted here precisely so its DEMOTION is visible: it exists,
    // it is readable, and the next two steps show it decides nothing.
    expect(escaper.labels).toMatchObject({ "scp:managed-by": "iac", "scp:stack": stackName });

    const attacker = await createTestUser(server, org, [{ role: "Operator", scope: escaper.id }]);
    const strip = await call(attacker.token, "PATCH", `/api/v1/objects/service/${escaper.id}`, {
      labels: {}
    });
    expect(strip.statusCode).toBe(200);
    expect((strip.json() as GraphObject).labels).toEqual({});

    // The stack author now DECOMMISSIONS the object by removing it from the manifest. Before the
    // fix this diff had `deletes: 0` and the object survived.
    const shrunk: DesiredStateManifest = {
      stackName,
      objects: [service(keptUrn, "Kept")],
      relationships: []
    };
    const diff = await planOnly(shrunk);
    expect(diff.summary.deletes).toBe(1);
    expect(diff.objects.find((o) => o.action === "delete")?.urn).toBe(escaperUrn);

    await applyManifest(shrunk);
    const gone = await call(org.adminToken, "GET", `/api/v1/objects/service/${escaperUrn}`);
    expect(gone.statusCode).toBe(404);
  });

  it("R3 FAIL DIRECTION: absence of ownership orphans, it never deletes", async () => {
    // The highest-severity shape this could have had — "unowned means everyone's, so prune it" —
    // does not hold and must not start holding. An object nobody's IaC manages is untouched by
    // every stack, which is why the ESCAPE direction above was a silent survival rather than a
    // silent deletion.
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const declaredUrn = `urn:scp:${stackName}:service:declared`;
    const bystanderUrn = `urn:scp:${stackName}-by:service:bystander`;

    const manifest: DesiredStateManifest = {
      stackName,
      objects: [service(declaredUrn, "Declared")],
      relationships: []
    };
    await applyManifest(manifest);

    const created = await call(org.adminToken, "PUT", `/api/v1/objects/service/${bystanderUrn}`, {
      name: "Bystander"
    });
    expect(created.statusCode).toBe(201);

    expect((await planOnly(manifest)).summary.deletes).toBe(0);
    await applyManifest(manifest);
    const still = await call(org.adminToken, "GET", `/api/v1/objects/service/${bystanderUrn}`);
    expect(still.statusCode).toBe(200);
  });

  it("A1 ADOPTION VIA A NOOP: declaring a pre-existing object owns it even when the diff has nothing to change", async () => {
    // The branch that is easy to miss and impossible to see from the outside. Under the old scheme,
    // adoption happened as a SIDE EFFECT of merging the marker labels — so a declared object was
    // never a `noop` on the apply that adopted it. Ownership is now explicit, which means `noop`
    // has to be stamped on purpose. Skipping it would leave the object declared-but-unowned:
    // undeletable by the very stack that declares it, i.e. the ESCAPE direction reached by accident.
    //
    // The object is pre-seeded WITH the marker labels, which is what makes its first plan a `noop`
    // and is also the state a pre-0068 estate is full of.
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const adopteeUrn = `urn:scp:${stackName}-pre:service:adoptee`;

    const seeded = await call(org.adminToken, "PUT", `/api/v1/objects/service/${adopteeUrn}`, {
      name: "Adoptee",
      labels: { "scp:managed-by": "iac", "scp:stack": stackName }
    });
    expect(seeded.statusCode).toBe(201);

    const declared: DesiredStateManifest = {
      stackName,
      objects: [{ urn: adopteeUrn, typeId: "service", name: "Adoptee", properties: {}, labels: {} }],
      relationships: []
    };
    // Nothing to change: name, properties and (after the merge) labels all already match.
    const adoptDiff = await applyManifest(declared);
    expect(adoptDiff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });

    // Undeclare it. Ownership must have been taken, or this is a silent no-op forever.
    const empty: DesiredStateManifest = { stackName, objects: [], relationships: [] };
    const pruneDiff = await planOnly(empty);
    expect(pruneDiff.summary.deletes).toBe(1);
    expect(pruneDiff.objects[0]?.urn).toBe(adopteeUrn);
  });

  it("E1 EDGES: a declared relationship that another door already created becomes prunable by the stack that declares it", async () => {
    // The relationship half of the same stamp. Under the label scheme only edge CREATES were ever
    // labelled, so an edge a manifest declared but that some other door had already written was
    // declared-but-unowned forever. Objects never had that gap.
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const fromUrn = `urn:scp:${stackName}:service:from`;
    const toUrn = `urn:scp:${stackName}:service:to`;

    // Both endpoints exist and are owned by the stack; the EDGE is written by hand, outside IaC.
    await applyManifest({
      stackName,
      objects: [service(fromUrn, "From"), service(toUrn, "To")],
      relationships: []
    });
    const from = (
      await call(org.adminToken, "GET", `/api/v1/objects/service/${fromUrn}`)
    ).json() as GraphObject;
    const to = (
      await call(org.adminToken, "GET", `/api/v1/objects/service/${toUrn}`)
    ).json() as GraphObject;

    const handEdge = await call(org.adminToken, "POST", "/api/v1/relationships", {
      typeId: "depends_on",
      fromId: from.id,
      toId: to.id
    });
    expect(handEdge.statusCode).toBe(201);
    expect((handEdge.json() as Relationship).labels).toEqual({});

    // The manifest now declares that edge. It already exists, so the diff is a `noop` — and the
    // stamp is the only thing that can make it this stack's.
    const withEdge: DesiredStateManifest = {
      stackName,
      objects: [service(fromUrn, "From"), service(toUrn, "To")],
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };
    const adoptDiff = await applyManifest(withEdge);
    expect(adoptDiff.relationships).toEqual([
      {
        kind: "relationship",
        action: "noop",
        typeId: "depends_on",
        fromUrn,
        toUrn,
        reason: "matches current state"
      }
    ]);

    // Undeclare it: the stack that declared it can now remove it.
    const withoutEdge: DesiredStateManifest = {
      stackName,
      objects: [service(fromUrn, "From"), service(toUrn, "To")],
      relationships: []
    };
    const pruneDiff = await planOnly(withoutEdge);
    expect(pruneDiff.relationships).toEqual([
      {
        kind: "relationship",
        action: "delete",
        typeId: "depends_on",
        fromUrn,
        toUrn,
        reason: "previously managed by this stack, no longer present in the desired manifest"
      }
    ]);
  });

  it("E2 EDGES: labelling an existing edge does NOT enrol it in a stack's prune pool", async () => {
    // The enrolment direction for relationships. `POST /relationships` accepts `labels` at create,
    // so `relationship:write` at two endpoints was enough to hand a stack a delete candidate.
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const aUrn = `urn:scp:${stackName}-e2:service:a`;
    const bUrn = `urn:scp:${stackName}-e2:service:b`;

    for (const [urn, name] of [
      [aUrn, "A"],
      [bUrn, "B"]
    ]) {
      const res = await call(org.adminToken, "PUT", `/api/v1/objects/service/${urn}`, { name });
      expect(res.statusCode).toBe(201);
    }
    const a = (
      await call(org.adminToken, "GET", `/api/v1/objects/service/${aUrn}`)
    ).json() as GraphObject;
    const b = (
      await call(org.adminToken, "GET", `/api/v1/objects/service/${bUrn}`)
    ).json() as GraphObject;

    const planted = await call(org.adminToken, "POST", "/api/v1/relationships", {
      typeId: "depends_on",
      fromId: a.id,
      toId: b.id,
      labels: { "scp:managed-by": "iac", "scp:stack": stackName }
    });
    expect(planted.statusCode).toBe(201);
    expect((planted.json() as Relationship).labels).toMatchObject({ "scp:stack": stackName });

    // A stack of that name, which has never seen this edge, proposes nothing about it.
    const unrelatedUrn = `urn:scp:${stackName}:service:unrelated`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [service(unrelatedUrn, "Unrelated")],
      relationships: []
    };
    const diff = await planOnly(manifest);
    expect(diff.relationships).toEqual([]);
    expect(diff.summary.deletes).toBe(0);
  });
});

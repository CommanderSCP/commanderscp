import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  findStackConfigSourceBinding,
  listConfigSourceRegistrations
} from "./config-sources-repo.js";

/**
 * THE CONFIG-SOURCE REGISTRATION, AT EVERY DOOR THAT CAN WRITE ONE (ADR-0046 §1/§3, migration
 * 0100, team-pipeline-iac §4 D7/D9).
 *
 * ============================================================================================
 * WHAT THIS FILE HAS TO PROVE
 * ============================================================================================
 * A `config-source` row is not a document — it is an IDENTITY DELEGATION. It says "manifests from
 * this repo apply AS THIS TEAM", and the sync loop hands that team's object id to `executePlanDiff`
 * as `actorObjectId`, so the per-diff-entry `authorize()` ADR-0046 rests on runs AS THE TEAM and
 * passes. The whole guarantee — "a team's stack cannot mutate another team's service" — therefore
 * reduces to one question: who may write a row of this type, naming whom.
 *
 * Three properties, and none is provable by asserting a row exists:
 *
 *  1. **AUTHORITY OVER THE DELEGATED IDENTITY** — writing a config source that names team T
 *     demands `role_binding:write` AT T, at every door. `object:write` somewhere is not enough,
 *     and the UPDATE half matters more than the create half because the escalation is an EDIT.
 *  2. **THE CHECK IS NEVER SKIPPED** — an unresolvable team reference, or one naming a non-team
 *     subject, is a refusal. "No such object, so nothing to authorize against" is how an authority
 *     check becomes a formality.
 *  3. **D7 SINGLE OWNERSHIP** — a stack bound to a config source refuses a direct CLI apply with a
 *     409 naming it, and removing the registration returns that stack to CLI-push. Every unbound
 *     stack behaves exactly as it did before this increment.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Result (MEASURED, not predicted — two are wider than first written) |
 * |---|---|
 * | delete the `assertConfigSourceAuthoring` call from `createObject` | 4 FAIL — (1), (3), (4) and (5). Every case whose refusal is authored through a CREATE loses it at once, including the IaC apply door, which is the point: one choke point, four doors. |
 * | delete it from `updateObject` | (2) alone FAILS — the PATCH repoints `team` to a team the author does not administer and returns 200. |
 * | `authoring-guard.ts` skips (`continue`) instead of throwing on an unresolvable team | (3) alone FAILS — the ghost-team registration is written. |
 * | the permission drops from `role_binding:write` to `object:write` | 3 FAIL — (1), (2) and (5). The Operator-at-org-root actor is admitted at every delegation door, which is exactly the bar this guard exists to raise above. |
 * | delete the D7 block from `routes/plans.ts` | (6) alone FAILS — the repo-owned stack applies (200) and the next sync would silently revert it. |
 * | `findStackConfigSourceBinding` matches by `repoPattern` instead of the `stackTeams` claim | (6) alone FAILS — the UNBOUND stack is refused 409, i.e. registering a namespace would have locked stacks nobody claimed. |
 * | `listConfigSourceRegistrations` drops malformed rows instead of reporting them | (7) alone FAILS. |
 *
 * ONE DEFECT THIS FILE CAUGHT IN THE CODE UNDER TEST, recorded because the fix is not obvious from
 * the outside: case (7) first reported `detail: "Bad Request"`. A `ProblemError`'s `message` is the
 * RFC 9457 TITLE and the sentence naming the broken rule is on `detail` — so the honest-failure
 * report was carrying no information at all while passing an "is it reported?" assertion. Asserting
 * the TEXT, not the presence, is what found it.
 */
describe("config-source: the delegation door and D7 single ownership", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  /**
   * Refusals are asserted as STATUS + `detail`, never as a thrown SDK error's message: the SDK
   * surfaces the RFC 9457 TITLE ("Forbidden"), so `rejects.toThrow(/Forbidden/)` passes for any
   * 403 — including one from a permission check that fired long before the guard under test. Every
   * case below names the rule it is about.
   */
  async function call(
    method: "POST" | "PATCH" | "DELETE",
    url: string,
    token: string,
    payload?: unknown
  ): Promise<{ status: number; detail: string; body: Record<string, unknown> }> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never
    });
    const body = res.body === "" ? {} : (res.json() as Record<string, unknown>);
    return { status: res.statusCode, detail: String(body.detail ?? ""), body };
  }

  interface Fixture {
    org: TestOrg;
    /** An actor with `object:write` everywhere (Operator at the org root) and `role_binding:write`
     *  at team A ONLY (Administrator bound there). The realistic shape of "a platform engineer who
     *  administers one team". */
    authorToken: string;
    teamAId: string;
    teamBId: string;
  }

  async function createObjectAs(
    token: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await call("POST", `/api/v1/objects/${type}`, token, payload);
    if (res.status !== 201) throw new Error(`create ${type} failed: ${res.status} ${res.detail}`);
    return res.body;
  }

  async function fixture(label: string): Promise<Fixture> {
    const org = await createTestOrg(server, label);
    const teamA = await createObjectAs(org.adminToken, "team", {
      name: `team-a-${randomUUID().slice(0, 8)}`
    });
    const teamB = await createObjectAs(org.adminToken, "team", {
      name: `team-b-${randomUUID().slice(0, 8)}`
    });
    const user = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Administrator", scope: teamA.id as string }
    ]);
    return {
      org,
      authorToken: user.token,
      teamAId: teamA.id as string,
      teamBId: teamB.id as string
    };
  }

  function registration(team: string, extra: Record<string, unknown> = {}) {
    return {
      name: `cs-${randomUUID().slice(0, 8)}`,
      properties: {
        repoPattern: "git.corp.example/payments/*",
        ref: "main",
        paths: ["scp/manifest.json"],
        team,
        ...extra
      }
    };
  }

  it("(1) the CREATE door: admits a config source naming a team the author administers, REFUSES one naming a team they do not", async () => {
    const f = await fixture("cs-create");

    const mine = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId)
    );
    expect(mine.status, mine.detail).toBe(201);
    expect(mine.body.properties).toMatchObject({ team: f.teamAId, ref: "main" });

    // The actor holds `object:write` AT THE ORG ROOT — the permission the generic create door
    // checks — so this refusal is not the ordinary write gate answering. It is the delegation gate,
    // and the detail says so by naming both the permission and the team it was asked at.
    const theirs = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamBId)
    );
    expect(theirs.status).toBe(403);
    expect(theirs.detail).toContain("role_binding:write");
    expect(theirs.detail).toContain(f.teamBId);
  });

  it("(2) the UPDATE door: an EDIT cannot repoint the delegation, through `team` OR through `stackTeams`", async () => {
    const f = await fixture("cs-update");
    const created = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId)
    );
    expect(created.status, created.detail).toBe(201);
    const id = created.body.id as string;
    const properties = created.body.properties as Record<string, unknown>;

    const repointed = await call("PATCH", `/api/v1/objects/config-source/${id}`, f.authorToken, {
      properties: { ...properties, team: f.teamBId }
    });
    expect(repointed.status).toBe(403);
    expect(repointed.detail).toContain("role_binding:write");

    // The `stackTeams` half of the delegation surface. A guard that checked only `team` would pass
    // this — and one stack applying as team B is the whole escalation, not a lesser one.
    const viaStackTeams = await call(
      "PATCH",
      `/api/v1/objects/config-source/${id}`,
      f.authorToken,
      { properties: { ...properties, stackTeams: { "some-stack": f.teamBId } } }
    );
    expect(viaStackTeams.status).toBe(403);
    expect(viaStackTeams.detail).toContain("role_binding:write");

    // …and the same edit naming a team the author DOES administer still goes through, so the guard
    // is not simply refusing every update.
    const allowed = await call("PATCH", `/api/v1/objects/config-source/${id}`, f.authorToken, {
      properties: { ...properties, stackTeams: { "some-stack": f.teamAId } }
    });
    expect(allowed.status, allowed.detail).toBe(200);
    expect((allowed.body.properties as Record<string, unknown>).stackTeams).toEqual({
      "some-stack": f.teamAId
    });
  });

  it("(3) an unresolvable or non-team reference is a REFUSAL, never a skipped check", async () => {
    const f = await fixture("cs-refs");

    const ghost = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(`urn:scp:team:${randomUUID()}`)
    );
    expect(ghost.status).toBe(400);
    expect(ghost.detail).toContain("does not resolve");

    // A `user` object is a perfectly resolvable RBAC subject — which is exactly why the type check
    // is separate from the resolution check. Delegating to one would let a repository act as a
    // person.
    const someone = await createObjectAs(f.org.adminToken, "user", {
      name: `u-${randomUUID().slice(0, 8)}`
    });
    const wrongType = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(someone.id as string)
    );
    expect(wrongType.status).toBe(400);
    expect(wrongType.detail).toContain("is a 'user' and not a 'team'");
  });

  it("(4) the shape rules migration 0100 keeps OFF the wire are enforced AT the door", async () => {
    const f = await fixture("cs-shape");

    const both = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId, { repo: "git.corp.example/payments/api" })
    );
    expect(both.status).toBe(400);
    expect(both.detail).toContain("exactly one of 'repo'");

    const neither = await call("POST", "/api/v1/objects/config-source", f.authorToken, {
      name: `cs-${randomUUID().slice(0, 8)}`,
      properties: { ref: "main", paths: ["scp/manifest.json"], team: f.teamAId }
    });
    expect(neither.status).toBe(400);
    expect(neither.detail).toContain("exactly one of 'repo'");

    // `paths` is `required` in the REGISTERED schema, so this one is refused a layer earlier — by
    // Ajv, at `validateProperties`. Asserted so the split between the two layers stays visible: if
    // the registered schema ever drops it, this case still fails rather than silently relocating.
    const noPaths = await call("POST", "/api/v1/objects/config-source", f.authorToken, {
      name: `cs-${randomUUID().slice(0, 8)}`,
      properties: { repoPattern: "git.corp.example/*", ref: "main", team: f.teamAId }
    });
    expect(noPaths.status).toBe(400);
    expect(noPaths.detail).toContain("paths");
  });

  it("(5) THE IaC APPLY DOOR is covered by the same guard — a manifest cannot mint what the route refuses", async () => {
    const f = await fixture("cs-iac");
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${f.org.orgName}:config-source:sneaky-${randomUUID().slice(0, 8)}`;

    const plan = await call("POST", "/api/v1/plans", f.authorToken, {
      manifest: {
        stackName,
        objects: [
          {
            urn,
            typeId: "config-source",
            name: "sneaky",
            properties: {
              repoPattern: "git.corp.example/payments/*",
              ref: "main",
              paths: ["scp/manifest.json"],
              team: f.teamBId
            }
          }
        ],
        relationships: []
      }
    });
    // The diff computes — `POST /plans` writes nothing, and seeing what a manifest WOULD do is not
    // the thing being guarded. The refusal is at apply, where the row would be written.
    expect(plan.status, plan.detail).toBe(201);

    const applied = await call(
      "POST",
      `/api/v1/plans/${plan.body.id as string}/apply`,
      f.authorToken
    );
    expect(applied.status).toBe(403);
    expect(applied.detail).toContain("role_binding:write");

    // Fully closed: the refusal rolls the whole transaction back, so nothing landed.
    const readBack = await server.app.inject({
      method: "GET",
      url: `/api/v1/objects/config-source/${encodeURIComponent(urn)}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` }
    });
    expect(readBack.statusCode).toBe(404);
  });

  it("(6) D7: a repo-owned stack REFUSES a direct CLI apply, an unbound stack applies exactly as before, and removing the registration returns it to CLI-push", async () => {
    const f = await fixture("cs-d7");
    const ownedStack = `owned-${randomUUID().slice(0, 8)}`;
    const freeStack = `free-${randomUUID().slice(0, 8)}`;

    const created = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId, { stackTeams: { [ownedStack]: f.teamAId } })
    );
    expect(created.status, created.detail).toBe(201);
    const configSourceName = created.body.name as string;

    async function planFor(stackName: string): Promise<string> {
      const plan = await call("POST", "/api/v1/plans", f.authorToken, {
        manifest: {
          stackName,
          objects: [
            {
              urn: `urn:scp:${f.org.orgName}:service:${stackName}`,
              typeId: "service",
              name: stackName,
              properties: {}
            }
          ],
          relationships: []
        }
      });
      expect(plan.status, plan.detail).toBe(201);
      return plan.body.id as string;
    }

    // THE UNBOUND STACK IS UNTOUCHED — this increment adds one refusal, not a new gate on the
    // existing path.
    const freeApplied = await call(
      "POST",
      `/api/v1/plans/${await planFor(freeStack)}/apply`,
      f.authorToken
    );
    expect(freeApplied.status, freeApplied.detail).toBe(200);

    const ownedPlanId = await planFor(ownedStack);
    const refused = await call("POST", `/api/v1/plans/${ownedPlanId}/apply`, f.authorToken);
    expect(refused.status).toBe(409);
    expect(refused.detail).toContain(`repo-owned by config source '${configSourceName}'`);

    // "Removing the stack from the config-source registration returns it to CLI-push" (D7),
    // measured rather than asserted — and the SAME pending plan applies, so the refusal parked the
    // work instead of destroying it.
    const deleted = await call(
      "DELETE",
      `/api/v1/objects/config-source/${created.body.id as string}`,
      f.authorToken
    );
    expect(deleted.status, deleted.detail).toBe(200);

    const nowApplied = await call("POST", `/api/v1/plans/${ownedPlanId}/apply`, f.authorToken);
    expect(nowApplied.status, nowApplied.detail).toBe(200);
  });

  it("(7) the registry read: a row that does not parse is REPORTED, never dropped", async () => {
    const f = await fixture("cs-registry");
    const goodRes = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId, { stackTeams: { "some-stack": f.teamAId } })
    );
    const brokenRes = await call(
      "POST",
      "/api/v1/objects/config-source",
      f.authorToken,
      registration(f.teamAId)
    );
    expect(goodRes.status, goodRes.detail).toBe(201);
    expect(brokenRes.status, brokenRes.detail).toBe(201);
    const good = goodRes.body as { id: string; name: string };
    const broken = brokenRes.body as { id: string; name: string };

    // Break it the only way it can be broken: BEHIND the door. This is not a contrivance — the
    // authoring guard is deliberately exempt on the federation import path (a throw there wedges a
    // peer's whole signed bundle, ADR-0033 §8), so a peer-authored row is exactly a row this door
    // never saw.
    await withTenantTx(server.deps.db, f.org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ properties: { ref: "main", team: f.teamAId } })
        .where(eq(objects.id, broken.id));
    });

    const registry = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      listConfigSourceRegistrations(tx, f.org.orgId)
    );
    expect(registry.registrations.map((r) => r.id)).toEqual([good.id]);
    expect(registry.malformed).toEqual([
      { id: broken.id, name: broken.name, detail: expect.stringContaining("repo") }
    ]);

    // And the D7 lookup still answers from the rows that DO parse — one broken registration must
    // not silently unlock every stack.
    const binding = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      findStackConfigSourceBinding(tx, f.org.orgId, "some-stack")
    );
    expect(binding).toEqual({ configSourceId: good.id, configSourceName: good.name });
  });
});

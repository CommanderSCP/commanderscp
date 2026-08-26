import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";

/**
 * THE READ-SURFACE BLOCKER, change half (docs/proposals/role-model.md §4.2, §8.4, increment 2.5a).
 *
 * `authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD only, so an `authorize()`
 * pinned at `scopeObjectId: auth.orgId` is satisfiable by an ORG-ROOT binding and by nothing else.
 * Every change door was pinned that way, which made the whole point of the proposed purpose roles
 * unreachable: a principal administering one component could hold `object:read`/`object:write` and
 * still be 403'd reading, cancelling or accepting the release against their own component.
 *
 * §8.4: a change has NO usable scope of its own — `objects.domain_id` for a change is the org root
 * for every internal `proposeChange` caller — so these doors are scoped to the change's TARGETS,
 * read back off the persisted `properties.targets`.
 *
 *   * READ doors take `object:read` at ANY ONE target. A principal who can see one target is
 *     already told the whole list by `properties.targets`, so an every-target read bar buys nothing
 *     and would make reads strictly harder to satisfy than the writes they gate.
 *   * WRITE doors take `object:write` at EVERY target — otherwise the admin of one target of a
 *     five-target change accepts the release into the four they have no standing on.
 *
 * These tests are the safety net that did not exist: all 334 `403` occurrences across `apps/server`
 * tests were enumerated before this increment and ZERO pinned the org-root behaviour of any door
 * changed here (§8.5). Each assertion below was watched to fail against the org-root pin first.
 *
 * `Operator` bound at a component is the ComponentAdmin SHAPE for the two permissions these doors
 * demand (`object:read` + `object:write`) — the purpose roles themselves are a later increment
 * (§5 step 3) and seeding one here would test a migration this branch does not carry.
 */
describe("change doors are scoped to the change's targets, not to the org root", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Two unrelated components, each with its own component-scoped principal. */
  let componentA: string;
  let componentB: string;
  let adminA: TestUser;
  let adminB: TestUser;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  /** Proposes a change as the ORG-ROOT admin, so the propose door itself is never what is measured. */
  async function propose(name: string, targets: string[]): Promise<string> {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/changes",
      headers: bearer(org.adminToken),
      payload: { name: `${name}-${Math.random().toString(36).slice(2, 8)}`, targets }
    });
    if (res.statusCode !== 201) throw new Error(`propose failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  /** Overwrites a persisted change object's `properties` — the trap-4 fixture. `targets` is
   *  `.min(1)` at PROPOSE, so an empty/malformed set can only arrive on a row (a federation import
   *  writes object properties verbatim), which is exactly why the doors must not trust it. */
  async function setChangeProperties(changeId: string, properties: unknown): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ properties: properties as Record<string, unknown> })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, changeId)));
    });
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "change-target-scope");

    const made = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const a = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "change-target-scope-setup",
        name: `comp-a-${Math.random().toString(36).slice(2, 8)}`
      });
      const b = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "change-target-scope-setup",
        name: `comp-b-${Math.random().toString(36).slice(2, 8)}`
      });
      return { a: a.id, b: b.id };
    });
    componentA = made.a;
    componentB = made.b;

    adminA = await createTestUser(server, org, [{ role: "Operator", scope: componentA }]);
    adminB = await createTestUser(server, org, [{ role: "Operator", scope: componentB }]);
  });

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------
  // READ doors — ANY ONE target
  // ---------------------------------------------------------------------------------------

  it("GET /changes/:id — a component-scoped principal reads a change targeting THEIR component", async () => {
    const changeId = await propose("read-mine", [componentA]);
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(adminA.token)
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }).id).toBe(changeId);
  });

  it("GET /changes/:id — and is REFUSED a change targeting someone else's component", async () => {
    const changeId = await propose("read-theirs", [componentA]);
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(adminB.token)
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /changes/:id — ANY ONE target is enough: a two-target change is readable by either", async () => {
    const changeId = await propose("read-either", [componentA, componentB]);
    for (const user of [adminA, adminB]) {
      const res = await server.app.inject({
        method: "GET",
        url: `/api/v1/changes/${changeId}`,
        headers: bearer(user.token)
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("GET /changes/:id/explain — same target scope as the plain read", async () => {
    const changeId = await propose("explain", [componentA]);
    const mine = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/explain`,
      headers: bearer(adminA.token)
    });
    expect(mine.statusCode).toBe(200);
    const theirs = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/explain`,
      headers: bearer(adminB.token)
    });
    expect(theirs.statusCode).toBe(403);
  });

  it("a MISSING change is 404, not 403 — the object is resolved before it is scoped", async () => {
    // Trap: `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so
    // scoping at an unresolved path param turns every 404 into a 403 (plus two wasted
    // truncation-probe queries) even for an org-root Owner.
    const missing = "00000000-0000-4000-8000-0000000000ff";
    for (const url of [`/api/v1/changes/${missing}`, `/api/v1/changes/${missing}/explain`]) {
      const res = await server.app.inject({ method: "GET", url, headers: bearer(org.adminToken) });
      expect(res.statusCode).toBe(404);
    }
  });

  // ---------------------------------------------------------------------------------------
  // WRITE doors — EVERY target
  // ---------------------------------------------------------------------------------------

  it("POST /changes/:id/cancel — a component-scoped principal cancels a single-target change of theirs", async () => {
    const changeId = await propose("cancel-mine", [componentA]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/cancel`,
      headers: bearer(adminA.token),
      payload: { reason: "not needed" }
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: string }).state).toBe("cancelled");
  });

  it("POST /changes/:id/cancel — REFUSED on a two-target change where they hold only one target", async () => {
    const changeId = await propose("cancel-partial", [componentA, componentB]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/cancel`,
      headers: bearer(adminA.token),
      payload: { reason: "not mine to stop" }
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain(componentB);
  });

  it("POST /changes/:id/accept — REFUSED on a two-target change where they hold only one target", async () => {
    const changeId = await propose("accept-partial", [componentA, componentB]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/accept`,
      headers: bearer(adminA.token),
      payload: {}
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /changes/:id/accept — the authority door OPENS for a single-target change of theirs", async () => {
    // The change is `proposed`, and `proposed -> accepted` is not a legal edge, so the honest
    // outcome once authority is granted is the state conflict. Asserting "409, not 403" is what
    // makes this test fail loudly if the door goes back to demanding an org-root binding.
    const changeId = await propose("accept-mine", [componentA]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/accept`,
      headers: bearer(adminA.token),
      payload: {}
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(409);
  });

  it("POST /changes/:id/rollback — REFUSED on a two-target change where they hold only one target", async () => {
    const changeId = await propose("rollback-partial", [componentA, componentB]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/rollback`,
      headers: bearer(adminA.token),
      payload: { reason: "revert" }
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /changes/:id/rollback — the authority door OPENS for a single-target change of theirs", async () => {
    const changeId = await propose("rollback-mine", [componentA]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/rollback`,
      headers: bearer(adminA.token),
      payload: { reason: "revert" }
    });
    expect(res.statusCode).not.toBe(403);
  });

  // ---------------------------------------------------------------------------------------
  // Trap 4 — an empty or malformed persisted target set is REFUSED, never silently passed
  // ---------------------------------------------------------------------------------------

  it("an EMPTY persisted target array is refused on read and on write — for the org-root Owner too", async () => {
    const changeId = await propose("empty-targets", [componentA]);
    await setChangeProperties(changeId, { targets: [] });

    const read = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(org.adminToken)
    });
    expect(read.statusCode).toBe(403);
    expect(read.body).toMatch(/target/i);

    const write = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/cancel`,
      headers: bearer(org.adminToken),
      payload: {}
    });
    expect(write.statusCode).toBe(403);
  });

  it("a MALFORMED persisted target set is refused — a non-array, and an array with a non-string entry", async () => {
    const notAnArray = await propose("targets-not-array", [componentA]);
    await setChangeProperties(notAnArray, { targets: componentA });
    const res1 = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${notAnArray}`,
      headers: bearer(org.adminToken)
    });
    expect(res1.statusCode).toBe(403);

    const mixed = await propose("targets-mixed", [componentA]);
    await setChangeProperties(mixed, { targets: [componentA, 42] });
    const res2 = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${mixed}`,
      headers: bearer(org.adminToken)
    });
    expect(res2.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------------------
  // The PURE-WIDENING control — an org-root Owner does everything exactly as before
  // ---------------------------------------------------------------------------------------

  it("an org-root Owner reads, explains, cancels and rollbacks exactly as before", async () => {
    const changeId = await propose("owner-control", [componentA, componentB]);

    const get = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(org.adminToken)
    });
    expect(get.statusCode).toBe(200);

    const explain = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/explain`,
      headers: bearer(org.adminToken)
    });
    expect(explain.statusCode).toBe(200);

    const rollback = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/rollback`,
      headers: bearer(org.adminToken),
      payload: { reason: "control" }
    });
    expect(rollback.statusCode).not.toBe(403);

    const cancel = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/cancel`,
      headers: bearer(org.adminToken),
      payload: {}
    });
    expect(cancel.statusCode).toBe(200);
  });

  it("a principal with NO binding anywhere is still refused every door", async () => {
    const nobody = await createTestUser(server, org, []);
    const changeId = await propose("nobody", [componentA]);
    const get = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(nobody.token)
    });
    expect(get.statusCode).toBe(403);
    const cancel = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/cancel`,
      headers: bearer(nobody.token),
      payload: {}
    });
    expect(cancel.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------------------
  // The governance-side change doors
  // ---------------------------------------------------------------------------------------

  it("GET /changes/:idOrUrn/control-runs — target-scoped, and 404 for a change that does not exist", async () => {
    const changeId = await propose("control-runs", [componentA]);
    const mine = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/control-runs`,
      headers: bearer(adminA.token)
    });
    expect(mine.statusCode).toBe(200);
    const theirs = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/control-runs`,
      headers: bearer(adminB.token)
    });
    expect(theirs.statusCode).toBe(403);
    const missing = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/00000000-0000-4000-8000-0000000000fe/control-runs`,
      headers: bearer(org.adminToken)
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /approvals?changeId= — target-scoped", async () => {
    const changeId = await propose("approvals", [componentA]);
    const mine = await server.app.inject({
      method: "GET",
      url: `/api/v1/approvals?changeId=${changeId}`,
      headers: bearer(adminA.token)
    });
    expect(mine.statusCode).toBe(200);
    const theirs = await server.app.inject({
      method: "GET",
      url: `/api/v1/approvals?changeId=${changeId}`,
      headers: bearer(adminB.token)
    });
    expect(theirs.statusCode).toBe(403);
  });

  it("POST /policy-evaluate — target-scoped", async () => {
    const changeId = await propose("policy-evaluate", [componentA]);
    const mine = await server.app.inject({
      method: "POST",
      url: "/api/v1/policy-evaluate",
      headers: bearer(adminA.token),
      payload: { changeId }
    });
    expect(mine.statusCode).toBe(200);
    const theirs = await server.app.inject({
      method: "POST",
      url: "/api/v1/policy-evaluate",
      headers: bearer(adminB.token),
      payload: { changeId }
    });
    expect(theirs.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------------------------------
  // Decisions — the DISJUNCTION, not a re-scope (role-model.md §8.6)
  // ---------------------------------------------------------------------------------------

  it("GET /decisions/:id — readable via `audit:read` at the org root OR `object:read` at the SUBJECT", async () => {
    // §8.6: re-scoping this door to `decision.subjectId` alone would hand the accountability record
    // to the party being held accountable, so the org-root audit arm is kept and the subject arm is
    // ADDED. Subject here is componentA — the arm that a component-scoped principal can satisfy.
    const decisionId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const d = await insertDecision(tx, {
        orgId: org.orgId,
        kind: "test_subject_scoped",
        subjectId: componentA,
        verdict: "allow",
        inputContext: {},
        reasonTree: {}
      });
      return d.id;
    });

    const owner = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(org.adminToken)
    });
    expect(owner.statusCode).toBe(200);

    const subjectAdmin = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(adminA.token)
    });
    expect(subjectAdmin.statusCode).toBe(200);

    const stranger = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(adminB.token)
    });
    expect(stranger.statusCode).toBe(403);

    const missing = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/00000000-0000-4000-8000-0000000000fd`,
      headers: bearer(org.adminToken)
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /decisions?subjectId= — the same disjunction; unfiltered still needs the org-root arm", async () => {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await insertDecision(tx, {
        orgId: org.orgId,
        kind: "test_subject_scoped_list",
        subjectId: componentA,
        verdict: "allow",
        inputContext: {},
        reasonTree: {}
      });
    });

    const subjectAdmin = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions?subjectId=${componentA}`,
      headers: bearer(adminA.token)
    });
    expect(subjectAdmin.statusCode).toBe(200);
    expect((subjectAdmin.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const stranger = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions?subjectId=${componentA}`,
      headers: bearer(adminB.token)
    });
    expect(stranger.statusCode).toBe(403);

    const owner = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions`,
      headers: bearer(org.adminToken)
    });
    expect(owner.statusCode).toBe(200);

    const unfilteredComponentAdmin = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions`,
      headers: bearer(adminA.token)
    });
    expect(unfilteredComponentAdmin.statusCode).toBe(403);
  });
});

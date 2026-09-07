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
import { objects, roles } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";

/** THE READ-SURFACE BLOCKER, change half. See docs/routes.md §45. */
describe("change doors are scoped to the change's targets, not to the org root", () => {
  let server: TestServer;
  let org: TestOrg;
  /** Two unrelated components, each with its own component-scoped principal. */
  let componentA: string;
  let componentB: string;
  let adminA: TestUser;
  let adminB: TestUser;
  /** Component-scoped like `adminA`, but on `ComponentAdmin` — which holds `change:accept`. */
  let acceptorA: TestUser;

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
    // A second component-scoped principal, on a role with accept. See docs/routes.md §46.
    acceptorA = await createTestUser(server, org, [{ role: "ComponentAdmin", scope: componentA }]);
  });

  afterAll(async () => {
    await server?.close();
  });

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
    // The change is proposed, so that edge is not legal. See docs/routes.md §47.
    const changeId = await propose("accept-mine", [componentA]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/accept`,
      headers: bearer(acceptorA.token),
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
    // `ComponentAdmin` for the same reason `accept` above uses it: a rollback proposes a NEW change
    // carrying the original's target set, so drizzle/0099 puts it behind `change:accept` too.
    const changeId = await propose("rollback-mine", [componentA]);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/changes/${changeId}/rollback`,
      headers: bearer(acceptorA.token),
      payload: { reason: "revert" }
    });
    expect(res.statusCode).not.toBe(403);
  });

  // An unreadable persisted target set refuses a scoped one. See docs/routes.md §48.

  /** The three shapes a persisted target set can take that `readChangeTargetScopeIds` calls
   *  unreadable — empty, absent, and malformed (non-array, and an array with a non-string entry). */
  const UNREADABLE_TARGET_SETS: ReadonlyArray<[label: string, properties: unknown]> = [
    ["an EMPTY array", { targets: [] }],
    ["NO targets key at all", { name: "mangled-by-a-peer" }],
    ["a non-array `targets`", { targets: "not-an-array" }],
    ["an array with a non-string entry", { targets: ["11111111-1111-4111-8111-111111111111", 42] }]
  ];

  it("an org-root Owner READS and CANCELS a change whose persisted target set is unreadable", async () => {
    for (const [label, properties] of UNREADABLE_TARGET_SETS) {
      const changeId = await propose("unreadable-targets", [componentA]);
      await setChangeProperties(changeId, properties);

      for (const url of [`/api/v1/changes/${changeId}`, `/api/v1/changes/${changeId}/explain`]) {
        const res = await server.app.inject({
          method: "GET",
          url,
          headers: bearer(org.adminToken)
        });
        expect(res.statusCode, `${label} — GET ${url}: ${res.body}`).toBe(200);
      }

      // The WRITE door too, and last, because cancelling moves the change out of `proposed`.
      const cancelled = await server.app.inject({
        method: "POST",
        url: `/api/v1/changes/${changeId}/cancel`,
        headers: bearer(org.adminToken),
        payload: { reason: "a peer sent us a row we cannot read" }
      });
      expect(cancelled.statusCode, `${label} — cancel: ${cancelled.body}`).toBe(200);
      expect((cancelled.json() as { state: string }).state).toBe("cancelled");
    }
  });

  it("a component-bound principal is REFUSED on those same rows — the empty set authorizes nobody", async () => {
    for (const [label, properties] of UNREADABLE_TARGET_SETS) {
      // Targeted at componentA, so `adminA` READ and WROTE it a moment ago; the row's contents are
      // the only thing that changes between that and the refusal below.
      const changeId = await propose("unreadable-targets-scoped", [componentA]);
      const before = await server.app.inject({
        method: "GET",
        url: `/api/v1/changes/${changeId}`,
        headers: bearer(adminA.token)
      });
      expect(before.statusCode, `${label} — control read: ${before.body}`).toBe(200);

      await setChangeProperties(changeId, properties);

      const read = await server.app.inject({
        method: "GET",
        url: `/api/v1/changes/${changeId}`,
        headers: bearer(adminA.token)
      });
      expect(read.statusCode, `${label} — read: ${read.body}`).toBe(403);
      // The refusal is about the ROW, not about the caller — that distinction is the reason the
      // verdict carries a reason code rather than collapsing into one message.
      expect(read.body, label).toMatch(/no readable target set/);

      const write = await server.app.inject({
        method: "POST",
        url: `/api/v1/changes/${changeId}/cancel`,
        headers: bearer(adminA.token),
        payload: { reason: "should not be permitted" }
      });
      expect(write.statusCode, `${label} — cancel: ${write.body}`).toBe(403);
      expect(write.body, label).toMatch(/no readable target set/);
    }
  });

  // The PURE-WIDENING control — an org-root Owner does everything exactly as before

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

  it("GET /changes/:idOrUrn/control-runs — an org-root Owner passing a NON-change id gets 404, NEVER 403", async () => {
    // THE PURE-WIDENING REGRESSION. See docs/routes.md §49.
    for (const idOrUrn of [componentA, "00000000-0000-4000-8000-0000000000fc"]) {
      const res = await server.app.inject({
        method: "GET",
        url: `/api/v1/changes/${idOrUrn}/control-runs`,
        headers: bearer(org.adminToken)
      });
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).toBe(404);
    }
  });

  it("a SOFT-DELETED change is still served where it was before — the 404 is 'not a change', never 'tombstoned'", async () => {
    // The fourth case where a root read becomes a not-found. See docs/routes.md §50.
    const changeId = await propose("soft-deleted", [componentA]);

    const noApiDelete = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/objects/change/${changeId}`,
      headers: bearer(org.adminToken)
    });
    expect(noApiDelete.statusCode, noApiDelete.body).toBe(403);
    expect(noApiDelete.body).toMatch(/coordination-managed/);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, changeId)));
    });

    // The two `getChange` doors, which never filtered tombstones and are the pre-2.5a control.
    for (const url of [`/api/v1/changes/${changeId}`, `/api/v1/changes/${changeId}/explain`]) {
      const res = await server.app.inject({ method: "GET", url, headers: bearer(org.adminToken) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }

    // The regressed door, reachable without a governance fixture. Its three siblings
    // (`/control-runs/{id}/findings`, `GET /approvals/{id}`, `/votes`) reach their change through
    // this same one resolver — that shared definition is what makes this case cover them.
    const runs = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/control-runs`,
      headers: bearer(org.adminToken)
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect((runs.json() as { items: unknown[] }).items).toEqual([]);

    // And the scoped arm still works on a tombstoned change: the target is what is checked, and
    // `componentA` is very much alive.
    const scoped = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/control-runs`,
      headers: bearer(adminA.token)
    });
    expect(scoped.statusCode, scoped.body).toBe(200);

    // THE DOOR THAT KEEPS ITS 404, because it had one before 2.5a. Same message as "that is not a
    // change", so the two stay indistinguishable on the wire.
    const approvals = await server.app.inject({
      method: "GET",
      url: `/api/v1/approvals?changeId=${changeId}`,
      headers: bearer(org.adminToken)
    });
    expect(approvals.statusCode, approvals.body).toBe(404);
    expect((approvals.json() as { detail?: string }).detail).toBe(`change '${changeId}' not found`);
  });

  it("a NON-change id and an unknown id are INDISTINGUISHABLE on the doors that take a caller-supplied changeId", async () => {
    // The change id is caller-supplied, so the check cannot run. See docs/routes.md §51.
    const nobody = await createTestUser(server, org, []);
    const details: string[] = [];
    for (const changeId of [componentA, "00000000-0000-4000-8000-0000000000fb"]) {
      for (const token of [nobody.token, org.adminToken]) {
        const res = await server.app.inject({
          method: "GET",
          url: `/api/v1/approvals?changeId=${changeId}`,
          headers: bearer(token)
        });
        expect(res.statusCode).not.toBe(403);
        expect(res.statusCode).toBe(404);
        if (token === nobody.token) {
          details.push((res.json() as { detail?: string }).detail?.replace(changeId, "<id>") ?? "");
        }
      }
    }
    expect(details[0]).toBe(details[1]);
    expect(details[0]).toBe("change '<id>' not found");
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

  // Decisions — the DISJUNCTION, not a re-scope (role-model.md §8.6)

  it("the `audit:read` wide arm narrows NOBODY who can exist — every role with object:read has it", async () => {
    // The one place the wide arm is not literally the old check. See docs/routes.md §52.
    const roleRows = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx.select({ name: roles.name, permissions: roles.permissions }).from(roles)
    );
    expect(roleRows.length).toBeGreaterThan(0);
    const missingAuditRead = roleRows
      .filter((r) => r.permissions.includes("object:read") && !r.permissions.includes("audit:read"))
      .map((r) => r.name);
    expect(missingAuditRead).toEqual([]);
  });

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

  // The subject arm has to be REAL for the dominant subject — a CHANGE

  it("GET /decisions/:id — a Decision about a CHANGE is readable at the change's TARGETS", async () => {
    // Almost every Decision is about a change, and its chain. See docs/routes.md §53.
    const changeId = await propose("decision-about-a-change", [componentA]);
    const decisionId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const d = await insertDecision(tx, {
        orgId: org.orgId,
        kind: "test_change_subject",
        subjectId: changeId,
        verdict: "block",
        inputContext: {},
        reasonTree: {}
      });
      return d.id;
    });

    const targetAdmin = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(adminA.token)
    });
    expect(targetAdmin.statusCode).toBe(200);

    // Still not a re-scope: a principal with no standing on any target is refused, so the arm
    // widens to the change's own operators and to nobody else.
    const stranger = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(adminB.token)
    });
    expect(stranger.statusCode).toBe(403);

    const owner = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions/${decisionId}`,
      headers: bearer(org.adminToken)
    });
    expect(owner.statusCode).toBe(200);

    // The list half takes the same arm when the caller pins the change as the subject.
    const listed = await server.app.inject({
      method: "GET",
      url: `/api/v1/decisions?subjectId=${changeId}`,
      headers: bearer(adminA.token)
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: { id: string }[] }).items.map((d) => d.id)).toContain(
      decisionId
    );
  });

  it("/changes/:id/explain and /decisions/:id agree — every row explain serves is gettable by the same principal", async () => {
    // ONE DATASET, ONE BAR. See docs/routes.md §54.
    const changeId = await propose("explain-agrees", [componentA]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await insertDecision(tx, {
        orgId: org.orgId,
        kind: "test_explain_agreement",
        subjectId: changeId,
        verdict: "block",
        inputContext: {},
        reasonTree: {}
      });
    });

    const explain = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/explain`,
      headers: bearer(adminA.token)
    });
    expect(explain.statusCode).toBe(200);
    const served = (explain.json() as { decisions: { id: string }[] }).decisions;
    expect(served.length).toBeGreaterThan(0);

    for (const d of served) {
      const direct = await server.app.inject({
        method: "GET",
        url: `/api/v1/decisions/${d.id}`,
        headers: bearer(adminA.token)
      });
      expect(direct.statusCode).toBe(200);
    }
  });

  // §8.4's dedupe — "read `targetObjectIdsOf`, dedupe, `authorize` at each"

  it("a repeated target is authorized ONCE — the checked set is deduped", async () => {
    // A change may legitimately name the same object twice. Without the dedupe a write door runs
    // the same `authorize` once per repeat and a read door re-walks the same refused chain; the
    // set the 403 names is the observable half of that. `[x, x]` is still a WELL-FORMED two-entry
    // array, so it must reach the permission check rather than the malformed-set refusal.
    const changeId = await propose("dup-targets", [componentB]);
    await setChangeProperties(changeId, { targets: [componentB, componentB] });

    const refused = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(adminA.token)
    });
    expect(refused.statusCode).toBe(403);
    const detail = (refused.json() as { detail: string }).detail;
    // The refusal is about the permission, not about a malformed set…
    expect(detail).toContain("lacks 'object:read' at the org root and at any target of change");
    expect(detail.split(componentB).length - 1).toBe(1);

    // The duplicate is still a real target: its own admin reads the change.
    const allowed = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(adminB.token)
    });
    expect(allowed.statusCode).toBe(200);
  });

  // THE ORG-ROOT ARM — the widening is a DISJUNCTION, and this is the case that proves it

  it("an org-root Owner still reaches a change whose target's ancestors are ALL tombstoned", async () => {
    // The case that makes the org-root arm necessary, not tidy. See docs/routes.md §55.
    const tag = Math.random().toString(36).slice(2, 8);
    const post = (url: string, payload: Record<string, unknown>) =>
      server.app.inject({ method: "POST", url, headers: bearer(org.adminToken), payload });

    const domain = await post("/api/v1/domains", { name: `tomb-domain-${tag}` });
    expect(domain.statusCode, domain.body).toBe(201);
    const domainId = (domain.json() as { id: string }).id;

    const service = await post("/api/v1/services", { name: `tomb-svc-${tag}`, domainId });
    expect(service.statusCode, service.body).toBe(201);
    const serviceId = (service.json() as { id: string }).id;

    // `domainId` AND `service`: route 1 of the walk (`objects.domain_id`) and route 2 (the
    // `contains` edge) are separate arms, so BOTH have to be cut for the chain to dead-end.
    const component = await post("/api/v1/components", {
      name: `tomb-comp-${tag}`,
      service: serviceId,
      domainId
    });
    expect(component.statusCode, component.body).toBe(201);
    const targetId = (component.json() as { id: string }).id;

    const changeId = await propose("tombstoned-target", [targetId]);

    for (const url of [
      `/api/v1/components/${targetId}`,
      `/api/v1/services/${serviceId}`,
      `/api/v1/domains/${domainId}`
    ]) {
      // Asserted, not assumed: if the orphan guard ever stopped permitting these, this test would
      // silently stop covering the case it is named after.
      const res = await server.app.inject({
        method: "DELETE",
        url,
        headers: bearer(org.adminToken)
      });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }

    // READ door. Without the org-root arm this is a 403 — the walk from `targetId` reaches nothing.
    for (const url of [`/api/v1/changes/${changeId}`, `/api/v1/changes/${changeId}/explain`]) {
      const res = await server.app.inject({ method: "GET", url, headers: bearer(org.adminToken) });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }

    // The governance half of the same family, in the other route file.
    const runs = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}/control-runs`,
      headers: bearer(org.adminToken)
    });
    expect(runs.statusCode, runs.body).toBe(200);

    const approvals = await server.app.inject({
      method: "GET",
      url: `/api/v1/approvals?changeId=${changeId}`,
      headers: bearer(org.adminToken)
    });
    expect(approvals.statusCode, approvals.body).toBe(200);

    // `POST /policy-evaluate` reads the SAME verbatim target array, and was excused during review
    // on a comment that claimed an object's own walk always reaches the org root.
    const dryRun = await post("/api/v1/policy-evaluate", { changeId });
    expect(dryRun.statusCode, dryRun.body).toBe(200);

    // And the widening did not leak the other way: a cut chain reaches NO binding, so a check that
    // had simply stopped refusing would look identical to the fix from the Owner's side alone.
    const nobody = await createTestUser(server, org, []);
    const refused = await server.app.inject({
      method: "GET",
      url: `/api/v1/changes/${changeId}`,
      headers: bearer(nobody.token)
    });
    expect(refused.statusCode, refused.body).toBe(403);

    // WRITE door LAST, because it moves the change out of `proposed`. `object:write` at EVERY
    // target, and the org-root arm short-circuits the whole loop rather than each iteration.
    const cancelled = await post(`/api/v1/changes/${changeId}/cancel`, {
      reason: "the component it targeted is gone"
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((cancelled.json() as { state: string }).state).toBe("cancelled");
  });
});

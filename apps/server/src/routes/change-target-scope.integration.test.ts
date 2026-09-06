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
 *
 * ================================================================================================
 * THE ORG-ROOT ARM, AND THE MUTATION THAT PROVES THE LAST CASE IN THIS FILE
 * ================================================================================================
 * Scoping at the targets ALONE would not have been a pure widening. `scopeExpandCte` joins every
 * ANCESTOR `deleted_at IS NULL`, so a target whose containment parents are tombstoned expands to
 * the seed alone and matches NO binding — org-root Owner included — and a change's targets are read
 * back verbatim and never re-resolved. Both helpers therefore take `object:read`/`object:write` at
 * the ORG ROOT **or** at the targets, through the one shared definition in `authz/org-root-arm.ts`.
 *
 * MEASURED, not predicted (2026-08-26). Baseline: 26 passed. Mutation: `checkAtOrgRootOrScopes`'s
 * org-root arm disabled (`if (false && atOrgRoot)`), everything else untouched:
 *
 *   - "an org-root Owner still reaches a change whose target's ancestors are ALL tombstoned" FAILED
 *     at its first read assertion, verbatim: `subject '<owner>' lacks 'object:read' at the org root
 *     and at any target of change '<changeId>' (<targetId>)`, expected 403 to be 200. (It fails
 *     fast, so the control-runs, approvals, policy-evaluate and cancel legs below it are covered by
 *     the same mutation only once the assertion above them is relaxed.)
 *   - "GET /decisions?subjectId= — the same disjunction; unfiltered still needs the org-root arm"
 *     FAILED on the org-root Owner's unfiltered listing: expected 403 to be 200. Two cases, two
 *     different arms of the same helper, from one mutation.
 *   - The other 24 stayed GREEN — which is the point: every ordinary fixture in this file sits on
 *     components whose ancestors are LIVE, so nothing here could have caught the defect before the
 *     tombstoned case was written.
 *
 * ================================================================================================
 * THE ORDER OF THE TWO ARMS, AND THE SOFT-DELETE RESOLVE (2026-08-26, baseline 28 passed)
 * ================================================================================================
 * Two further defects, both found by adversarial review of the arm above, both fixed here and each
 * mutation-proven in BOTH directions. Messages verbatim.
 *
 *  M-A  `checkAtOrgRootOrChangeTargets` reads the target set FIRST and throws on it (the shape this
 *       increment shipped with): `if (!targetObjectIds) unestablishableChangeTargetSet(...)` moved
 *       above the `checkAtOrgRootOrScopes` call => "an org-root Owner READS and CANCELS a change
 *       whose persisted target set is unreadable" FAILED on the first shape: `change '<id>' has no
 *       readable target set (properties.targets must be a non-empty array of object ids), so
 *       authority over it cannot be established`, expected 403 to be 200. One `properties` write by
 *       a federation import was enough to 403 the principal with authority over everything.
 *  M-B  the opposite direction — an unreadable target set PASSES (`if (!targetObjectIds) return
 *       { ok: true }`) => "a component-bound principal is REFUSED on those same rows" FAILED on the
 *       first shape: expected 200 to be 403. Trap 4 is still live; the fix is the ORDER, not the
 *       removal of the refusal.
 *  M-C  `resolveChangeForScope` back to live rows only (drop the `includeDeleted` retry) => "a
 *       SOFT-DELETED change is still served where it was before" FAILED on
 *       `/changes/{id}/control-runs`: `change '<id>' not found`, expected 404 to be 200. Four doors
 *       took that 404 where they returned 200 before 2.5a.
 *  M-D  the tombstone 404 dropped from `GET /approvals?changeId=` (the ONE door that had one before
 *       2.5a) => the same case FAILED on its last leg: `{"items":[],"nextCursor":null}`, expected
 *       200 to be 404. Resolving tombstones is not the same as serving them everywhere.
 */
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
    // A SECOND component-scoped principal, on a role that also holds `change:accept`
    // (drizzle/0099). `Operator` deliberately does NOT, so from step 3 onward `adminA` can cancel
    // but not accept — see the two `accept`/`rollback` cases below, which use this user for the
    // "the SCOPE door opens" half and keep `adminA` for the refusals. Without the split, those two
    // cases would have gone red on a PERMISSION change while claiming to be about SCOPE.
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
    // The change is `proposed`, and `proposed -> accepted` is not a legal edge, so the honest
    // outcome once authority is granted is the state conflict. Asserting "409, not 403" is what
    // makes this test fail loudly if the door goes back to demanding an org-root binding.
    //
    // THE PRINCIPAL IS `ComponentAdmin`, NOT `Operator`, SINCE drizzle/0099. The door now demands
    // `object:write` AND `change:accept` at every target; Operator holds only the first, by design
    // (role-model.md §5 step 3 — the one intentional breakage). Using a role that holds both keeps
    // this case about the SCOPE walk, which is what it was written to measure. The permission half
    // is measured next door, in both directions.
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

  // ---------------------------------------------------------------------------------------
  // Trap 4 — an unreadable persisted target set refuses a SCOPED principal, and only a scoped one
  //
  // BOTH HALVES ARE LOAD-BEARING AND THEY PULL IN OPPOSITE DIRECTIONS, which is why the ORDER of
  // the two arms is what these cases actually measure:
  //
  //   * `properties.targets` is read back off a PERSISTED row, and `federation/import-repo.ts`'s
  //     `object_upsert` branch writes a peer's `properties` verbatim (`federation/scope-filter.ts`
  //     whitelists `typeId === "change"` for it). An empty array must therefore never authorize by
  //     being empty — `every` over `[]` is vacuously true, which would be a total bypass.
  //   * The pre-2.5a check was `object:read`/`object:write` at `auth.orgId` and never read
  //     `properties.targets` at all. So a principal bound at the org root who was served these rows
  //     before must still be served them: a 403 there is an authorization failure reported to the
  //     one principal with authority over everything, which is the outcome the re-scope must never
  //     produce.
  //
  // `checkAtOrgRootOrChangeTargets` runs the ORG-ROOT ARM FIRST and only then inspects the target
  // set, which is what lets both hold. The first cut of this increment read the target set first
  // and threw on it, and 403'd the Owner on every one of the three rows below.
  // ---------------------------------------------------------------------------------------

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
    // THE PURE-WIDENING REGRESSION. This door never validated its parameter: it handed the raw
    // `idOrUrn` to `change_object_id = $1`, so any uuid that is not a change matched no rows and
    // came back `200 []`. Re-scoping it to the change's TARGETS made an object with no targets hit
    // the target-set refusal — a 403 telling a principal with authority over the entire org that
    // they lack authority. `resolveChangeForScope` turns that back into the honest 404.
    //
    // Both spellings of "not a change" must answer identically, and neither may be 403:
    // an object that exists but is not a change, and a uuid that names nothing at all.
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
    // ======================================================================================
    // THE FOURTH ORG-ROOT 200 -> 404, and the line between the 404 that was decided and the one
    // that was an accident.
    //
    // 2.5a made four doors reach their change through `resolveChangeForScope`, which resolved LIVE
    // rows only: `/changes/{idOrUrn}/control-runs`, `/control-runs/{id}/findings`,
    // `GET /approvals/{id}` and its `/votes`. NONE of them resolved a change at all before 2.5a —
    // they authorized at the org root and went straight to their repo — so every one of them
    // served a tombstoned change's rows to an org-root Owner and stopped. Meanwhile the five doors
    // behind `getChange` never filtered `deleted_at` either (`changes-repo.ts`'s
    // `fetchChangeWithObject` has no such clause), so the tombstone was never a 404 anywhere in
    // this family. `resolveChangeForScope` therefore resolves tombstoned rows too, and hands back
    // `deletedAt` so the ONE door that genuinely 404'd them before 2.5a can keep doing so.
    //
    // `GET /approvals?changeId=` is that one door: its pre-2.5a `getObjectByIdOrUrnAnyType`
    // filtered tombstones. It re-applies the 404 itself, AFTER the read check, matching the
    // pre-2.5a authorize-then-resolve order.
    //
    // WHY THE TOMBSTONE IS WRITTEN DIRECTLY, measured rather than asserted: `change` is one of
    // `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS`, so every write verb of the generic object
    // route refuses it — the refusal is exercised below rather than described — and there is no
    // typed DELETE for a change. The only in-tree writer of this row shape is a federation
    // `object_tombstone` import, whose two-instance fixture would measure the same single column.
    // ======================================================================================
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
    // `changeId` is caller-supplied on `GET /approvals`, and the scope check cannot run until the
    // change is resolved — so the resolve necessarily happens before any authorization. The
    // existence oracle that would otherwise open is closed by answering the same 404 for "no such
    // object" and for "an object, but not a change". Probed as a principal with NO binding
    // anywhere, which is the party the oracle would matter to.
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
    // ============================================================================================
    // THE ONE PLACE 2.5a's WIDE ARM IS NOT LITERALLY THE OLD CHECK, decided and pinned rather than
    // left implicit. Pre-2.5a `GET /decisions/{id}` demanded `object:read` at the org root; the
    // disjunction §8.6 specifies is `audit:read` at the org root OR `object:read` at the subject.
    // So a principal holding org-root `object:read` and NOT `audit:read` would be newly refused.
    //
    // DECISION: keep `audit:read`, do not widen the arm to `object:read OR audit:read`.
    //   * §8.6's whole point is that the DEPLOYMENT-WIDE read of every verdict ever recorded is an
    //     auditor's capability, and `object:read` at the org root is held by four of the five
    //     built-in roles. Adding it back to the wide arm re-opens exactly the escalation §8.6
    //     names, and puts the door on the wrong permission just as role-model.md §5 step 3 starts
    //     binding purpose roles in the field.
    //   * The narrowing has NO POSSIBLE HOLDER today, which is what this case measures rather than
    //     asserts: every seeded role carrying `object:read` also carries `audit:read`
    //     (`drizzle/0002_rls_rbac_seed.sql`), and there is no custom-role API to author one that
    //     does not. A behavioural test cannot construct the victim, so the property is pinned at
    //     the source of the victims instead.
    //
    // If a future migration seeds `object:read` without `audit:read`, or a custom-role API lands,
    // this goes red and the decision above has to be made again with a real principal in hand.
    // ============================================================================================
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
    // Almost every Decision in this system is about a change, and a change's containment chain
    // runs to the org root — so a subject arm that checked `object:read` at `decision.subjectId`
    // directly was satisfiable ONLY by an org-root binding, i.e. by exactly the principals the
    // `audit:read` arm already admitted. Inert for the roles it was added for. The arm resolves a
    // change subject to its targets, the same expression the sibling change doors scope at.
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
    // ONE DATASET, ONE BAR (the verdict-read rule in routes/changes.ts). `/explain` embeds
    // `listDecisionsForSubject(change)` behind the change's target read bar; `/decisions/:id`
    // serves the same rows. Two different bars over one dataset made "may I see why I was blocked"
    // depend on which URL was opened — and charter principle 6 hands the blocked principal a
    // `decision_id`, which is a reference to nothing if they are 403'd on it.
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
    // ======================================================================================
    // THE CASE THAT MAKES `authz/org-root-arm.ts` NECESSARY RATHER THAN TIDY.
    //
    // `scopeExpandCte` seeds its walk with the raw uuid and never filters it, but joins every
    // ANCESTOR `deleted_at IS NULL`. So the chain is CUT at the first tombstone and `scope_expand`
    // collapses to the seed alone, which matches NO binding — the org-root Owner's included. A
    // change's `properties.targets` are read back VERBATIM and deliberately never re-resolved
    // (re-resolving would 404 "cancel the release against the component we just removed"), so a
    // target-only check 403s the Owner on exactly the change an operator opens next.
    //
    // BUILT WITH ORDINARY API CALLS, in the order an operator would make them: create the domain,
    // the service and the component; propose the change; then delete the component, its service
    // and its domain. `deleteObject`'s orphan guard permits each delete precisely because every
    // child is already a tombstone. Nothing below reaches into the database.
    // ======================================================================================
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

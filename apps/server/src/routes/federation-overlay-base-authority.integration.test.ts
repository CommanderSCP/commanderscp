import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS — they annotate a BASE GRAPH OBJECT
 * ================================================================================================
 *
 * THE GUARANTEE UNDER TEST, in one sentence: *creating an overlay on a base object, or reading the
 * merged view of one, additionally demands `object:write` / `object:read` AT THAT BASE OBJECT — on
 * top of, never instead of, the org-root bar those doors already carried.*
 *
 * ## Why these two, and none of the other 22 sites in `routes/federation.ts`
 *
 * `docs/proposals/role-model.md` §8.6 flags exactly this: `POST /api/v1/federation/overlays` and
 * `GET /api/v1/federation/overlays/{idOrUrn}` live in the federation route file, so a census sorted
 * by FILE sweeps them into the "federation is correctly org-scoped, leave alone" bucket. That bucket
 * is right for the rest — a federation identity, a peer, a journal and an outpost topology are
 * org-level concepts, so `scopeObjectId: auth.orgId` is their true scope. It is wrong for these two,
 * because what they read and write is an annotation ON a service, a component or a policy.
 *
 * That claim is MEASURED rather than inherited, and the measurement is sharper than "which file is
 * it in". A filterless census of `routes/federation.ts` (2026-08-26) finds 24 `authorize()` sites;
 * 22 demand `federation:read`, `federation:write` or `federation:pair`, and THESE TWO ARE THE ONLY
 * PLACE THE GENERIC GRAPH VERBS `object:read` / `object:write` APPEAR IN THE FILE AT ALL. The
 * generic verbs are exactly the ones whose scope is a graph object, so the PERMISSION is the tell,
 * not the filename. Two near-misses, checked and excluded rather than assumed:
 * `POST /federation/hand-fill` has the same base-object dimension and is not a third gap — its
 * `object:write` bar at the resolved containment scope landed in step 0d and lives in
 * `federation/handfill-repo.ts`, one layer down; `POST /federation/poke` has no `authorize()` at all
 * because it is peer-authenticated (`enforceFederationMtls` plus a both-sides-consent check), not an
 * RBAC door.
 *
 * ## Why the org-root bar STAYS (added, never substituted)
 *
 * An overlay's row lands at ORG-ROOT containment — `createOverlay` calls `createObject` with no
 * `domainId`. That is a STORAGE fact, not an AUTHORITY fact, and the two must not be confused in
 * either direction:
 *
 *  - Downward: it does not make org-root `object:write` the whole story, because read-time merge
 *    (`getMergedOverlayView`, DESIGN §13) means an overlay on a component silently changes what
 *    every consumer of that component sees. Authority over the thing being annotated is the bar
 *    that was missing.
 *  - Upward: it does not make the base check a REPLACEMENT for the org-root one. `overlay-repo.ts`'s
 *    governance-managed guard demands `policy:write` at the org root precisely because the row lands
 *    there, and PR #286 added a sibling of that argument; substituting a base-scoped check here
 *    would let a component-scoped principal mint overlays outranking a commander-origin object.
 *    §8.6 lists that guard among the deliberate escalation bars that must not be swept.
 *
 * ## How a test can see an ADDED check at all
 *
 * Both bars are ANDed, and `scopeExpandCte` walks upward — so anyone who clears the org-root bar
 * ALMOST ALWAYS clears a check at any descendant of it too, and the addition is invisible to an
 * ALLOW-only fixture. `role_bindings.effect` is what makes it visible: a deny at ANY matching scope
 * wins (`authz/resolve.ts`), and a deny bound at the BASE is reached only by a check scoped AT the
 * base. The org-root check is unaffected by it — the org root object has no `domain_id` and no
 * incoming `contains` edge, so its scope expansion is the single row `{org root}`.
 *
 * "ALMOST": the upward walk joins every ANCESTOR `deleted_at IS NULL`, so a base whose containment
 * parents have been tombstoned expands to the seed alone and matches NO binding — the added bar
 * then refuses the org-root Owner too. That is a SECOND way this addition can refuse, it is
 * ACCEPTED rather than deliberate, and the last case below pins it.
 *
 * ## Why that second case is accepted, and is not measured against the 2.5a pure-widening invariant
 *
 * Increment 2.5a re-scoped 21 get-by-id doors OFF the org root, and a re-scope must admit everyone
 * it used to — `authz/org-root-arm.ts` exists to make that hold. THESE TWO DOORS ARE NOT IN THAT
 * SET: nothing moved off the org root here, BAR 1 is the pre-2.5a check unchanged, and BAR 2 was
 * added beside it. Adding a bar is a DELIBERATE NARROWING; by construction it refuses some of the
 * principals one bar admitted, or it is not a bar. Judging it by a widening invariant is a category
 * error, and it was made once on this branch before it was named.
 *
 * The org-root arm cannot be the answer here for the reason the route's block states: on a
 * CONJUNCTION it is satisfied by everyone who just cleared BAR 1, so it would not fix case 2 — it
 * would delete BAR 2 and the deny cases above with it, leaving this file green over one bar. So the
 * consequence is accepted and named instead: **an overlay whose base has tombstoned containment
 * ancestors cannot be created or read by anyone, org-root Owner included, until that base's chain is
 * repaired.** Reachable via the federation-import path, where `deleteObject`'s orphan guard is
 * deliberately not applied — which is where foreign-origin bases live.
 *
 * That is also why the deny actor is the sharpest available one: it holds `Operator` at the org
 * root, so every refusal below is the base-scoped check and nothing else. The control case beside
 * each proves the door did not simply close.
 *
 * ================================================================================================
 * MUTATIONS RUN (2026-08-26). Baseline: 6 passed. MEASURED, not predicted — messages are verbatim.
 * ================================================================================================
 *  M-1  Delete the ADDED `object:write` check at `base.id` from POST /federation/overlays
 *       => "a deny at the base object refuses the overlay CREATE" FAILED: expected 201 to be 403.
 *  M-2  Delete the ADDED `object:read` check at `view.base.id` from GET /federation/overlays/{id}
 *       => "a deny at the base object refuses the merged READ" FAILED: expected 200 to be 403.
 *  M-3  SUBSTITUTE rather than add — drop the org-root bar from BOTH doors, keep only the base
 *       check. **RUN FIRST AGAINST THIS FILE AS ORIGINALLY WRITTEN, PLUS
 *       `governance/governance-managed-write-doors.integration.test.ts`: 29 tests, ALL GREEN.**
 *       Nothing in the tree held the half of the ruling that says "added, never substituted", so
 *       the tidy-up that voids it was free. "a principal bound ONLY at the base is still refused"
 *       was written in response and now FAILS under the same mutation: expected 201 to be 403.
 *       That case, not this line, is the finding.
 *  M-4  Move the added `object:write` check ABOVE the base resolution (scope at `request.body.base`)
 *       => "a base that names nothing is 404, never 403" FAILED: `"lacks 'object:write' at scope
 *       '<ghost uuid>'"`, expected 403 to be 404.
 *  M-5  Move the added `object:read` check ABOVE `getMergedOverlayView` => the GET half of the same
 *       case FAILED: `"lacks 'object:read' at scope '<ghost uuid>'"`, expected 403 to be 404.
 *
 * THE REFRAME, MEASURED (2026-08-26, baseline 7 passed). The tombstoned-ancestor case below was
 * added, and with it the mutation that shows why the "obvious fix" for it is not one:
 *
 *  M-6  Give BAR 2 an ORG-ROOT ARM — `authorize(… scopeObjectId: base.id)` on the create door
 *       replaced by `checkAtOrgRootOrScopes({ orgRootPermission: 'object:write', scopedPermission:
 *       'object:write', quantifier: 'any', scopeObjectIds: [base.id] })`, i.e. exactly what
 *       "fixing" case 2 the way the 21 re-scoped doors were fixed would mean => `Tests 2 failed |
 *       5 passed (7)`. "a deny at the base object refuses the overlay CREATE" FAILED (expected 201
 *       to be 403), and "ACCEPTED AND PINNED: a base whose ancestors are TOMBSTONED refuses
 *       everyone" FAILED (expected 201 to be 403).
 *
 *       "a principal bound ONLY at the base is still refused" STAYS GREEN under the mutation, and
 *       that is the point rather than a gap: it is refused by BAR 1, which the mutation does not
 *       touch. BAR 2 is the only thing the arm deletes — so the deny-at-base refusal, which BAR 1
 *       cannot express, is what is actually lost. The arm does not repair BAR 2; it deletes it.
 *       That measurement is the argument for accepting case 2 rather than papering over it.
 */
describe("federation overlay doors demand authority at the BASE object (role-model §8.6)", () => {
  let server: TestServer;
  let org: TestOrg;
  /** The object an overlay annotates. A plain service — nothing governance-managed. */
  let baseId: string;
  /** `Operator` at the org root AND a `deny` of that same role at `baseId`. */
  let deniedAtBase: TestUser;
  /** `Operator` at the org root only — the control, identical but for the deny. */
  let plainOperator: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "overlay-base-authority");

    const base = await server.app.inject({
      method: "POST",
      url: "/api/v1/objects/service",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: `overlay-base-${randomUUID().slice(0, 8)}` }
    });
    if (base.statusCode !== 201) throw new Error(`base service: ${base.statusCode} ${base.body}`);
    baseId = (base.json() as { id: string }).id;

    deniedAtBase = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Operator", scope: baseId, effect: "deny" }
    ]);
    plainOperator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  const createOverlayVia = (token: string, body: Record<string, unknown>) =>
    server.app.inject({
      method: "POST",
      url: "/api/v1/federation/overlays",
      headers: { authorization: `Bearer ${token}` },
      payload: body
    });

  const overlayBody = (base: string) => ({
    base,
    // A NON-governance, non-service-member, non-pair-bound, non-peer-bound, non-projection-bound
    // type, deliberately: every one of those is refused by `createOverlay` on TYPE, which would
    // make a 403 here prove nothing about the permission under test.
    typeId: "service",
    name: `overlay-${randomUUID().slice(0, 8)}`,
    properties: { note: "locally annotated" }
  });

  const readMerged = (idOrUrn: string, token: string) =>
    server.app.inject({
      method: "GET",
      url: `/api/v1/federation/overlays/${idOrUrn}`,
      headers: { authorization: `Bearer ${token}` }
    });

  it("a deny at the base object refuses the overlay CREATE, even holding org-root object:write", async () => {
    const res = await createOverlayVia(deniedAtBase.token, overlayBody(baseId));
    expect(res.statusCode, res.body).toBe(403);
    // Named at the BASE, not at the org root — which is how this case tells the added check apart
    // from the pre-existing one it sits beside.
    expect(res.body).toContain(baseId);
    expect(res.body).toMatch(/object:write/);
  });

  it("a deny at the base object refuses the merged READ of that base", async () => {
    const res = await readMerged(baseId, deniedAtBase.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(baseId);
    expect(res.body).toMatch(/object:read/);
  });

  it("(control) the same org-root Operator WITHOUT the deny still creates and reads — the doors did not close", async () => {
    const created = await createOverlayVia(plainOperator.token, overlayBody(baseId));
    expect(created.statusCode, created.body).toBe(201);

    const read = await readMerged(baseId, plainOperator.token);
    expect(read.statusCode, read.body).toBe(200);
    const view = read.json() as { base: { id: string }; overlays: unknown[] };
    expect(view.base.id).toBe(baseId);
    expect(view.overlays.length).toBeGreaterThan(0);
  });

  it("a principal bound ONLY at the base is still refused — the org-root bar was added to, not replaced", async () => {
    // ============================================================================================
    // THIS CASE EXISTS BECAUSE ITS MUTATION FOUND NOTHING. Dropping the org-root `object:write` bar
    // from the create door — keeping only the base-scoped one added beside it — was MEASURED against
    // this file AND `governance/governance-managed-write-doors.integration.test.ts`: 29 tests, all
    // green. Nothing in the tree held the "added, never substituted" half of the ruling, so the
    // obvious tidy-up ("two checks where one would do") was free to land.
    //
    // What it would have cost: this actor. `Operator` at ONE service and nothing at the org root —
    // authority to write that service, which is not authority to create a row at the org-root
    // containment every overlay lands at, outranking whatever the base's own origin domain is.
    // ============================================================================================
    const baseOnly = await createTestUser(server, org, [{ role: "Operator", scope: baseId }]);

    const created = await createOverlayVia(baseOnly.token, overlayBody(baseId));
    expect(created.statusCode, created.body).toBe(403);
    // Refused AT THE ORG ROOT specifically — the bar under test, named, so this case cannot be
    // satisfied by a refusal that came from the base-scoped check instead.
    expect(created.body).toContain(org.orgId);

    const read = await readMerged(baseId, baseOnly.token);
    expect(read.statusCode, read.body).toBe(403);
    expect(read.body).toContain(org.orgId);
  });

  it("the org-root Owner is unaffected on both doors — the addition is a bar, not a substitution", async () => {
    const created = await createOverlayVia(org.adminToken, overlayBody(baseId));
    expect(created.statusCode, created.body).toBe(201);
    const read = await readMerged(baseId, org.adminToken);
    expect(read.statusCode, read.body).toBe(200);
  });

  it("ACCEPTED AND PINNED: a base whose ancestors are TOMBSTONED refuses everyone, org-root Owner included", async () => {
    // ============================================================================================
    // THIS 403 IS INTENTIONAL. It is not the pure-widening regression the 21 RE-SCOPED doors had —
    // see the docblock above: these two doors were TIGHTENED, BAR 1 is the pre-2.5a check unchanged
    // and BAR 2 was added beside it, so a widening invariant never governed them. `scopeExpandCte`
    // joins every ancestor `deleted_at IS NULL`, so a base whose containment parents are tombstoned
    // expands to the seed alone and matches NO binding; BAR 2 therefore refuses everybody until the
    // base's chain is repaired. Giving BAR 2 an org-root arm would not fix that — it is satisfied by
    // everyone who cleared BAR 1, so it would delete BAR 2 and the two deny cases above with it.
    //
    // Pinned so this is a KNOWN state with a written reason rather than a surprise found in
    // production, and so that a future change to either the arm or the walk has to come here and
    // decide on purpose.
    //
    // WHY THE ANCESTOR IS TOMBSTONED WITH AN UPDATE, MEASURED RATHER THAN ASSERTED: `deleteObject`'s
    // orphan guard refuses to delete a row with live containment children, and the base IS one —
    // the API refusal is exercised below rather than described. The guard is skipped on the
    // federation-import path and when removing a foreign shadow, which is exactly how a
    // foreign-origin base ends up with a tombstoned parent; the ROW those paths leave behind is this
    // one column on the parent, and that is all `scopeExpandCte` reads.
    // ============================================================================================
    const asAdmin = { authorization: `Bearer ${org.adminToken}` };
    const domain = await server.app.inject({
      method: "POST",
      url: "/api/v1/domains",
      headers: asAdmin,
      payload: { name: `overlay-tomb-domain-${randomUUID().slice(0, 8)}` }
    });
    expect(domain.statusCode, domain.body).toBe(201);
    const domainId = (domain.json() as { id: string }).id;

    const strandedBase = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: asAdmin,
      payload: { name: `overlay-tomb-base-${randomUUID().slice(0, 8)}`, domainId }
    });
    expect(strandedBase.statusCode, strandedBase.body).toBe(201);
    const { id: strandedBaseId, urn: strandedBaseUrn } = strandedBase.json() as {
      id: string;
      urn: string;
    };

    // Sanity BEFORE the tombstone, so the refusal below cannot be blamed on the fixture.
    expect((await createOverlayVia(org.adminToken, overlayBody(strandedBaseId))).statusCode).toBe(
      201
    );
    expect((await readMerged(strandedBaseId, org.adminToken)).statusCode).toBe(200);

    // The orphan guard refuses the ordinary local route to this state — asserted, so that if it
    // ever stops refusing, this test tells us rather than the comment above quietly going stale.
    const refusedDelete = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${domainId}`,
      headers: asAdmin
    });
    expect(refusedDelete.statusCode, refusedDelete.body).toBe(409);
    // The guard enumerates the offending rows by URN, and the base is the one it names.
    expect(refusedDelete.body).toContain(strandedBaseUrn);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, domainId)));
    });

    const created = await createOverlayVia(org.adminToken, overlayBody(strandedBaseId));
    expect(created.statusCode, created.body).toBe(403);
    expect(created.body).toContain(strandedBaseId);
    expect(created.body).toMatch(/object:write/);

    const read = await readMerged(strandedBaseId, org.adminToken);
    expect(read.statusCode, read.body).toBe(403);
    expect(read.body).toContain(strandedBaseId);
    expect(read.body).toMatch(/object:read/);

    // BAR 1 is untouched by the tombstone — the org root's own expansion is a single depth-0 row —
    // so the refusal above really is BAR 2 and not the door closing generally. The control is the
    // LIVE base, which the same Owner still reaches in the same request sequence.
    expect((await readMerged(baseId, org.adminToken)).statusCode).toBe(200);
  });

  it("a base that names nothing is 404, never 403 — the object is resolved before it is scoped", async () => {
    // Same trap as the campaign doors (`campaign-scope-doors.integration.test.ts`): `scopeExpandCte`
    // seeds its CTE with the raw uuid and never checks existence, so a check scoped at an
    // unresolved path/body value refuses everybody, org-root Owner included.
    const ghost = randomUUID();
    const created = await createOverlayVia(org.adminToken, overlayBody(ghost));
    expect(created.statusCode, created.body).toBe(404);
    const read = await readMerged(ghost, org.adminToken);
    expect(read.statusCode, read.body).toBe(404);
  });
});

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

/** THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS. See docs/routes.md §183. */
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
    // THIS CASE EXISTS BECAUSE ITS MUTATION FOUND NOTHING. See docs/routes.md §184.
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
    // THIS 403 IS INTENTIONAL. See docs/routes.md §185.
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

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DesiredStateManifest, Plan } from "@scp/schemas";
import { auditEvents, objects, relationships } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { releaseObjectStackOwnership } from "./stack-ownership.js";
import { releaseStackOwnership, stackReleaseAuthorityChecks } from "./stack-release.js";
import { ProblemError } from "../errors.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/** RELEASING A STACK'S OWNERSHIP, through the real route as `scp_app` (withTenantTx sets the role,
 *  so a missing grant or RLS policy is a 500 here, not a vacuous pass). See docs/coordination-as-code.md §328–§331. */
describe("POST /api/v1/stacks/{stackName}/release", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "stack-release");
  });

  afterAll(async () => {
    await server.close();
  });

  async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown) {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never
    });
    const body = res.body === "" ? {} : (res.json() as Record<string, unknown>);
    return { status: res.statusCode, body, detail: String(body["detail"] ?? res.body) };
  }

  async function plan(manifest: DesiredStateManifest) {
    return call(org.adminToken, "POST", "/api/v1/plans", { manifest });
  }

  async function applyManifest(manifest: DesiredStateManifest): Promise<Plan> {
    const planned = await plan(manifest);
    expect(planned.status, planned.detail).toBe(201);
    const p = planned.body as unknown as Plan;
    const applied = await call(org.adminToken, "POST", `/api/v1/plans/${p.id}/apply`, {});
    expect(applied.status, applied.detail).toBe(200);
    return p;
  }

  function release(token: string, stackName: string, body: Record<string, unknown>) {
    return call(token, "POST", `/api/v1/stacks/${encodeURIComponent(stackName)}/release`, body);
  }

  const service = (urn: string, name: string, domainId?: string) => ({
    urn,
    typeId: "service",
    name,
    properties: {},
    ...(domainId ? { domainId } : {})
  });

  async function ownerOf(urn: string): Promise<string | null> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ managedByStack: objects.managedByStack })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.urn, urn)))
    );
    return rows[0]?.managedByStack ?? null;
  }

  async function releaseEvents() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ reason: auditEvents.reason, actorId: auditEvents.actorId })
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.action, "stack.release")))
    );
  }

  /** A stack owning two services and the `depends_on` edge between them. */
  async function retiredStack(label: string) {
    const stackName = `retired-${label}-${randomUUID().slice(0, 8)}`;
    const shared = `urn:scp:${org.orgName}:service:${stackName}-shared`;
    const other = `urn:scp:${org.orgName}:service:${stackName}-other`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [service(shared, `${stackName}-shared`), service(other, `${stackName}-other`)],
      relationships: [{ typeId: "depends_on", fromUrn: other, toUrn: shared }]
    };
    await applyManifest(manifest);
    expect(await ownerOf(shared)).toBe(stackName);
    return { stackName, shared, other, manifest };
  }

  it("THE JOURNEY: release, then another stack adopts, and the retired stack cannot silently take it back", async () => {
    const a = await retiredStack("journey");
    const successor = `successor-${randomUUID().slice(0, 8)}`;
    const successorManifest: DesiredStateManifest = {
      stackName: successor,
      objects: [service(a.shared, `${a.stackName}-shared`)],
      relationships: []
    };

    // Before: §4's refusal, which is the whole reason release exists.
    const stolen = await plan(successorManifest);
    expect(stolen.status).toBe(409);
    expect(stolen.detail).toContain(a.stackName);

    const eventsBefore = (await releaseEvents()).length;
    const released = await release(org.adminToken, a.stackName, { urns: [a.shared] });
    expect(released.status, released.detail).toBe(200);
    expect(released.body).toMatchObject({
      stackName: a.stackName,
      releasedObjects: [{ urn: a.shared, typeId: "service" }],
      releasedRelationships: []
    });
    expect(await ownerOf(a.shared)).toBeNull();
    // Only what was named: the stack still owns the rest of itself.
    expect(await ownerOf(a.other)).toBe(a.stackName);

    // AUDIT: exactly one hash-chained event, naming the stack and the URN.
    const events = await releaseEvents();
    expect(events.length).toBe(eventsBefore + 1);
    const event = events.find((e) => e.reason?.includes(a.shared));
    expect(event?.reason).toContain(`stack '${a.stackName}'`);
    expect(event?.reason).toContain(a.shared);

    // The successor now ADOPTS it — visibly, as §4 requires of every adoption.
    const adoption = await plan(successorManifest);
    expect(adoption.status, adoption.detail).toBe(201);
    const entry = (adoption.body as unknown as Plan).diff.objects[0];
    expect(entry?.adopted).toBe(true);
    const applied = await call(
      org.adminToken,
      "POST",
      `/api/v1/plans/${(adoption.body as unknown as Plan).id}/apply`,
      {}
    );
    expect(applied.status, applied.detail).toBe(200);
    expect(await ownerOf(a.shared)).toBe(successor);

    // The retired stack re-applying its unchanged manifest is now the THIEF, and is refused.
    const reclaim = await plan(a.manifest);
    expect(reclaim.status).toBe(409);
    expect(reclaim.detail).toContain(successor);
  });

  it("THE STACK'S OWN NEXT APPLY: a still-declared released object is re-ADOPTED (visibly); a dropped one is NOT pruned", async () => {
    const a = await retiredStack("own-next");
    const released = await release(org.adminToken, a.stackName, { urns: [a.shared, a.other] });
    expect(released.status, released.detail).toBe(200);

    // Still declared → not silently re-owned: the plan says ADOPTING, then the apply re-stamps.
    const again = await plan(a.manifest);
    expect(again.status, again.detail).toBe(201);
    const diff = (again.body as unknown as Plan).diff;
    expect(diff.objects.find((o) => o.urn === a.shared)?.adopted).toBe(true);

    // Dropped from the manifest → outside the prune pool, so no delete is proposed for it.
    const shrunk = await plan({
      ...a.manifest,
      objects: [a.manifest.objects[1]!],
      relationships: []
    });
    expect(shrunk.status, shrunk.detail).toBe(201);
    const shrunkDiff = (shrunk.body as unknown as Plan).diff;
    expect(shrunkDiff.objects.filter((o) => o.action === "delete")).toEqual([]);
    expect(shrunkDiff.objects.map((o) => o.urn)).toEqual([a.other]);
  });

  it("releases a named RELATIONSHIP, and only that", async () => {
    const a = await retiredStack("edge");
    const released = await release(org.adminToken, a.stackName, {
      relationships: [{ typeId: "depends_on", fromUrn: a.other, toUrn: a.shared }]
    });
    expect(released.status, released.detail).toBe(200);
    const edgeId = (released.body["releasedRelationships"] as { id: string }[])[0]!.id;
    const [edge] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ managedByStack: relationships.managedByStack })
        .from(relationships)
        .where(inArray(relationships.id, [edgeId]))
    );
    expect(edge?.managedByStack).toBeNull();
    expect(await ownerOf(a.shared)).toBe(a.stackName);
  });

  it("REFUSES (409) a URN the stack does not own — all-or-nothing, nothing released, no audit event", async () => {
    const a = await retiredStack("not-owned");
    const b = await retiredStack("someone-else");
    const unmanaged = await call(org.adminToken, "POST", "/api/v1/objects/service", {
      name: `unmanaged-${randomUUID().slice(0, 8)}`
    });
    expect(unmanaged.status).toBe(201);
    const typo = `urn:scp:${org.orgName}:service:${a.stackName}-shraed`;
    const eventsBefore = (await releaseEvents()).length;

    const refused = await release(org.adminToken, a.stackName, {
      urns: [a.shared, typo, b.shared, unmanaged.body["urn"] as string]
    });
    expect(refused.status).toBe(409);
    expect(refused.detail).toContain(`${typo}: no such object`);
    expect(refused.detail).toContain(`${b.shared}: owned by stack '${b.stackName}'`);
    expect(refused.detail).toContain("not managed by any stack");

    // The one row it DID own is untouched, and nothing was audited as released.
    expect(await ownerOf(a.shared)).toBe(a.stackName);
    expect(await ownerOf(b.shared)).toBe(b.stackName);
    expect((await releaseEvents()).length).toBe(eventsBefore);
  });

  it("REFUSES (409) a TOMBSTONED row the stack still carries — ownership of a deleted row is inert", async () => {
    const a = await retiredStack("tombstone");
    // Prune `shared` through the stack's own apply; the column stays on the tombstone.
    await applyManifest({ ...a.manifest, objects: [a.manifest.objects[1]!], relationships: [] });
    expect(await ownerOf(a.shared)).toBe(a.stackName);

    const refused = await release(org.adminToken, a.stackName, { urns: [a.shared] });
    expect(refused.status).toBe(409);
    expect(refused.detail).toContain(`${a.shared}: deleted`);
  });

  it("REFUSES (400) a release that names nothing — there is no 'release everything' form", async () => {
    const a = await retiredStack("empty");
    for (const body of [{}, { urns: [] }, { urns: [], relationships: [] }]) {
      const refused = await release(org.adminToken, a.stackName, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    expect(await ownerOf(a.shared)).toBe(a.stackName);
  });

  it("AUTHZ (403): a caller with no write authority over the stack's rows is refused", async () => {
    const a = await retiredStack("viewer");
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    const refused = await release(viewer.token, a.stackName, { urns: [a.shared] });
    expect(refused.status).toBe(403);
    expect(await ownerOf(a.shared)).toBe(a.stackName);
  });

  it("AUTHZ (403): write authority at the RELEASED object alone is not enough — §52's escape, through this door", async () => {
    // The Operator bound at exactly the object it wants out of the prune pool. It holds the
    // per-object bar an apply would check to delete THIS row, so a per-object rule admits it and
    // it survives its stack's decommission. The bar is the whole stack's.
    const a = await retiredStack("escaper");
    const sharedRow = await call(
      org.adminToken,
      "GET",
      `/api/v1/objects/service/${encodeURIComponent(a.shared)}`
    );
    const escaper = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: sharedRow.body["id"] as string }
    ]);
    const refused = await release(escaper.token, a.stackName, { urns: [a.shared] });
    expect(refused.status, refused.detail).toBe(403);
    expect(await ownerOf(a.shared)).toBe(a.stackName);
  });

  it("AUTHZ (200): the bar is the stack's authority, not org admin — an Operator over the stack's container may release", async () => {
    const container = await call(org.adminToken, "POST", "/api/v1/objects/domain", {
      name: `team-domain-${randomUUID().slice(0, 8)}`
    });
    expect(container.status, container.detail).toBe(201);
    const domainId = container.body["id"] as string;
    const stackName = `contained-${randomUUID().slice(0, 8)}`;
    const x = `urn:scp:${org.orgName}:service:${stackName}-x`;
    const y = `urn:scp:${org.orgName}:service:${stackName}-y`;
    await applyManifest({
      stackName,
      objects: [service(x, `${stackName}-x`, domainId), service(y, `${stackName}-y`, domainId)],
      relationships: [{ typeId: "depends_on", fromUrn: y, toUrn: x }]
    });

    const teamOperator = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: domainId }
    ]);
    const released = await release(teamOperator.token, stackName, { urns: [x] });
    expect(released.status, released.detail).toBe(200);
    expect(await ownerOf(x)).toBeNull();
    const events = await releaseEvents();
    expect(events.find((e) => e.reason?.includes(x))?.actorId).toBeDefined();
  });

  it("AUTHZ (403): the stack's EDGES count too — an owned edge reaching outside the caller's container refuses it", async () => {
    // Decommissioning the stack deletes this edge, which needs relationship:write at BOTH ends; the
    // caller holds every object the stack owns but not the edge's far end.
    const container = await call(org.adminToken, "POST", "/api/v1/objects/domain", {
      name: `edge-domain-${randomUUID().slice(0, 8)}`
    });
    const domainId = container.body["id"] as string;
    const outside = await call(org.adminToken, "POST", "/api/v1/objects/service", {
      name: `outside-${randomUUID().slice(0, 8)}`
    });
    expect(outside.status, outside.detail).toBe(201);
    const stackName = `edgy-${randomUUID().slice(0, 8)}`;
    const x = `urn:scp:${org.orgName}:service:${stackName}-x`;
    await applyManifest({
      stackName,
      objects: [service(x, `${stackName}-x`, domainId)],
      relationships: [{ typeId: "depends_on", fromUrn: x, toUrn: outside.body["urn"] as string }]
    });

    const teamOperator = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Operator", scope: domainId }
    ]);
    const refused = await release(teamOperator.token, stackName, { urns: [x] });
    expect(refused.status, refused.detail).toBe(403);
    expect(refused.detail).toContain("relationship:write");
    expect(await ownerOf(x)).toBe(stackName);
  });

  it("THE WRITER ITSELF clears only rows carrying the named stack — a mis-passed id is not released", async () => {
    // The route validates first, so this predicate is unreachable through it; it is the writer's own
    // contract, held so a future caller that skips validation still cannot clear another stack's row.
    const a = await retiredStack("writer-a");
    const b = await retiredStack("writer-b");
    const ids = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), inArray(objects.urn, [b.shared])))
    );
    const released = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      releaseObjectStackOwnership(
        tx,
        org.orgId,
        a.stackName,
        ids.map((r) => r.id)
      )
    );
    expect(released).toBe(0);
    expect(await ownerOf(b.shared)).toBe(b.stackName);
  });

  it("D7 (409): a REPO-OWNED stack's rows are not released by a direct call — the next sync would re-adopt them", async () => {
    const a = await retiredStack("repo-owned");
    const team = await call(org.adminToken, "POST", "/api/v1/objects/team", {
      name: `team-${randomUUID().slice(0, 8)}`
    });
    expect(team.status, team.detail).toBe(201);
    const source = await call(org.adminToken, "POST", "/api/v1/objects/config-source", {
      name: `cs-${randomUUID().slice(0, 8)}`,
      properties: {
        repoPattern: "git.corp.example/payments/*",
        ref: "main",
        paths: ["scp/manifest.json"],
        team: team.body["id"],
        stackTeams: { [a.stackName]: team.body["id"] }
      }
    });
    expect(source.status, source.detail).toBe(201);

    const refused = await release(org.adminToken, a.stackName, { urns: [a.shared] });
    expect(refused.status).toBe(409);
    expect(refused.detail).toContain("repo-owned by config source");
    expect(await ownerOf(a.shared)).toBe(a.stackName);

    // ORDERING: an unauthorized caller is refused on AUTHORITY, before the binding is read — a 409
    // here would name the config source to someone with no business knowing it.
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    const viewerRefused = await release(viewer.token, a.stackName, { urns: [a.shared] });
    expect(viewerRefused.status, viewerRefused.detail).toBe(403);
    expect(viewerRefused.detail).not.toContain("config source");
  });

  it("TOCTOU: a row a concurrent apply stamps AFTER the authority bar was read is refused, not released", async () => {
    // The bar is read in the release's transaction. The stack owns nothing yet, so the bar has no
    // checks; a separate connection then commits a legitimate apply stamping Z onto the stack. FOR
    // UPDATE cannot have locked Z (it was not the stack's), so only the set comparison stands
    // between the release and a row whose authority was never checked.
    const stackName = `race-${randomUUID().slice(0, 8)}`;
    const z = `urn:scp:${org.orgName}:service:${stackName}-z`;

    const outcome = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const authorized = await stackReleaseAuthorityChecks(tx, org.orgId, stackName);
      expect(authorized.checks).toEqual([]);

      await applyManifest({
        stackName,
        objects: [service(z, `${stackName}-z`)],
        relationships: []
      });

      return releaseStackOwnership(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "toctou-probe",
        stackName,
        urns: [z],
        relationships: [],
        authorized
      }).then(
        () => null,
        (error: unknown) => error
      );
    });

    expect(outcome).toBeInstanceOf(ProblemError);
    expect((outcome as ProblemError).status).toBe(409);
    expect((outcome as ProblemError).detail).toContain("changed during the release");
    expect(await ownerOf(z)).toBe(stackName);
  });
});

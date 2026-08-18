import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE ROUTE-1 ORPHAN GUARD (objects-repo.ts::deleteObject, measured incident 2026-08-13).
 *
 * Deleting a domain whose live children name it via `objects.domain_id` used to succeed — and
 * every such child then 403'd on UPDATE and DELETE forever (org-root admin included), because the
 * authz scope expansion joins parents on `deleted_at IS NULL` and a `domain_id` chain has exactly
 * one upward path: the tombstone dead-ends it. Two API calls to permanent, admin-proof garbage.
 *
 * The guard refuses the delete with the blockers NAMED.
 *
 * SINCE THE OWNER RULING OF 2026-08-18 IT COVERS ALL THREE DEPENDENT ROUTES (proposal
 * governance-reach-on-containment-move.md §9.3): `domain_id` children, `contains` children, and
 * placements naming the row. The last test in this file used to be the CONTROL asserting route 2
 * still cascaded; it is inverted here with the reason written in, and the wider surface —
 * placements, the `federationImport` / `removedForeignShadow` carve-outs, an assembly, an empty
 * container — lives in `graph/container-delete-guard.integration.test.ts`.
 */
describe("domain delete orphan guard (route-1 containment)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  /** The RFC-9457 `detail` off a rejected call — `ScpApiError.message` carries only the TITLE
   *  ("Conflict"), so asserting refusal COPY means reading `problem.detail`. */
  async function refusalDetail(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (e) {
      if (e instanceof ScpApiError) return String(e.problem?.detail ?? e.message);
      return String(e);
    }
    throw new Error("expected the call to be refused, but it succeeded");
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "orphan-guard");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  it("refuses deleting a domain with a live domain_id child, naming the child", async () => {
    const parent = await admin.object("domain").create({ name: uniq("guard-parent") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("guard-child"), domainId: parent.id });

    const detail = await refusalDetail(admin.object("domain").delete(parent.id));
    // The blocker is NAMED (the child's urn carries its name) …
    expect(detail).toContain("guard-child");
    // … and the refusal says WHY — the orphaning consequence, not just "Conflict".
    expect(detail).toContain("orphan");
    expect(detail).toContain("domain_id");

    // The load-bearing half of the incident: the child must REMAIN administrable after the
    // refused delete — this is the exact write that 403'd forever before the guard.
    const updated = await admin.object("domain").update(child.id, { labels: { touched: "yes" } });
    expect(updated.labels.touched).toBe("yes");
  });

  it("allows the delete once the children are gone — the guard names blockers, not a ban", async () => {
    const parent = await admin.object("domain").create({ name: uniq("clear-parent") });
    const child = await admin
      .object("domain")
      .create({ name: uniq("clear-child"), domainId: parent.id });

    const detail = await refusalDetail(admin.object("domain").delete(parent.id));
    expect(detail).toContain("still name it");
    await admin.object("domain").delete(child.id);
    const gone = await admin.object("domain").delete(parent.id);
    expect(gone.id).toBe(parent.id);
  });

  it("route-2 (contains) children now REFUSE the delete too — the owner ruling that retired the asymmetry", async () => {
    // THIS TEST IS THE INVERSION OF A CONTROL, AND THE REASON IS WRITTEN WHERE THE OLD REASON WAS.
    //
    // It used to assert the opposite: "route-2 (contains) children still CASCADE — deleting a
    // service with components succeeds", pinning that the route-1 guard "cannot quietly widen".
    // That control was doing its job — the widening is not quiet, it is an OWNER RULING
    // (2026-08-18, docs/proposals/governance-reach-on-containment-move.md §9.3 / §9.6 Q3-A) taken
    // after the measurement that the cascade tombstones the EDGES and leaves the children LIVE and
    // detached from every authority, governance and audit chain.
    //
    // What the suite protects now is the CARVE-OUT SET, not the asymmetry: a `federationImport`
    // delete with children must still land or a peer's bundle wedges, and that case lives in
    // `container-delete-guard.integration.test.ts` alongside the `removedForeignShadow` twin.
    const service = await admin.services.create({ name: uniq("cascade-svc") });
    const component = await admin.components.create({
      name: uniq("cascade-comp"),
      service: service.id
    });

    const detail = await refusalDetail(admin.services.delete(service.id));
    expect(detail).toContain("contained by it");
    expect(detail).toContain("contains");
    // The blocker is NAMED, with its type, so the operator knows what to move.
    expect(detail).toContain(component.urn);
    expect(detail).toContain("component");

    // And the delete lands once the child is gone — the guard names blockers, it is not a ban.
    await admin.components.delete(component.id);
    const deleted = await admin.services.delete(service.id);
    expect(deleted.id).toBe(service.id);
  });
});

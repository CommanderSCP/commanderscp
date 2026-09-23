import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { readMembers, replaceMembership } from "./infrastructure-members-repo.js";

/**
 * D25(a) — observed membership, against a real database.
 *
 * The property under test is that a REPORT IS A SNAPSHOT: after any report, the stored set equals
 * exactly what was reported. That is what makes a tenant unable to name the hosts a run reaches,
 * and what stops a dropped message leaving a stale address in an inventory a host-reaching runner
 * will SSH to.
 */
describe("infrastructure membership (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let productId: string;
  const reporter = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "infra-members");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // A real object to hang membership from — the FK refuses an invented id, which is the point.
    const component = await createTestComponent(admin, { name: `ig-${randomUUID().slice(0, 8)}` });
    productId = component.id;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function report(members: { memberId: string; address: string }[]) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      replaceMembership(tx, {
        orgId: org.orgId,
        productObjectId: productId,
        reportedBySubjectId: reporter,
        members
      })
    );
  }

  it("a first report establishes membership and reports every member as added", async () => {
    const diff = await report([
      { memberId: "i-002", address: "10.0.0.2" },
      { memberId: "i-001", address: "10.0.0.1" }
    ]);
    expect(diff.added.map((m) => m.memberId).sort()).toEqual(["i-001", "i-002"]);
    expect(diff.removed).toEqual([]);

    const members = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      readMembers(tx, org.orgId, productId)
    );
    // ORDERED, so an inventory file is byte-stable between runs observing the same set — otherwise
    // every run's inventory diff looks meaningful.
    expect(members.map((m) => m.memberId)).toEqual(["i-001", "i-002"]);
  });

  it("a later report REPLACES rather than accumulates", async () => {
    // The whole reason membership is a snapshot. If this merged instead, i-001 would linger and a
    // host-reaching run would SSH to an address that may now belong to someone else.
    const diff = await report([{ memberId: "i-003", address: "10.0.0.3" }]);
    expect(diff.added.map((m) => m.memberId)).toEqual(["i-003"]);
    expect(diff.removed.map((m) => m.memberId).sort()).toEqual(["i-001", "i-002"]);

    const members = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      readMembers(tx, org.orgId, productId)
    );
    expect(members).toEqual([{ memberId: "i-003", address: "10.0.0.3" }]);
  });

  it("an address change on a known member is readdressed, not add+remove", async () => {
    // D25(b) converges the CHANGED instances. A replacement in place is one host to re-apply to,
    // not one leaving and an unrelated one arriving — counting it as both would converge twice and
    // read as churn that never happened.
    const diff = await report([{ memberId: "i-003", address: "10.9.9.9" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.readdressed).toEqual([{ memberId: "i-003", from: "10.0.0.3", to: "10.9.9.9" }]);
  });

  it("an empty report empties the product — a fleet scaled to zero is a real state", async () => {
    const diff = await report([]);
    expect(diff.removed.map((m) => m.memberId)).toEqual(["i-003"]);
    const members = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      readMembers(tx, org.orgId, productId)
    );
    // NOT "absent means unchanged": a scaled-to-zero group must not keep converging its last
    // known hosts.
    expect(members).toEqual([]);
  });

  it("refuses membership for a product that does not exist", async () => {
    // The FK is the guard. Without it a typo'd product id would silently create a membership set
    // nothing ever reads, and the runner would compile an empty inventory and do nothing.
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        replaceMembership(tx, {
          orgId: org.orgId,
          productObjectId: randomUUID(),
          reportedBySubjectId: reporter,
          members: [{ memberId: "i-x", address: "10.0.0.9" }]
        })
      )
    ).rejects.toThrow();
  });
});

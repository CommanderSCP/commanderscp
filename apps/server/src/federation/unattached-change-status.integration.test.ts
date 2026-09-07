import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrustDomainId } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import {
  clearUnattachedChangeStatus,
  listUnattachedChangeStatusInStates,
  recordUnattachedChangeStatus
} from "./unattached-change-status-repo.js";

/** The store semantics behind the board's blindness caveat. See docs/federation.md §563. */
describe("federation_unattached_change_status — the store behind the evidence-derived caveat", () => {
  let server: TestServer;
  let org: TestOrg;
  let otherOrg: TestOrg;
  const peerA = randomUUID() as TrustDomainId;
  const peerB = randomUUID() as TrustDomainId;

  const IN_FLIGHT = ["proposed", "evaluated", "coordinated", "waiting", "executing", "validating"];

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "unattached-status");
    otherOrg = await createTestOrg(server, "unattached-status-other");
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  it("converges on ONE row under replay, and keeps the propose-time naming across a transition", async () => {
    const changeId = randomUUID();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      for (let i = 0; i < 3; i += 1) {
        await recordUnattachedChangeStatus(tx, {
          orgId: org.orgId,
          peerDomainId: peerA,
          changeObjectId: changeId,
          urn: "urn:scp:acme:change:ledger-rollout",
          name: "ledger rollout",
          lastState: "proposed",
          dropReason: "no_local_replica"
        });
      }
      // A later TRANSITION entry: carries objectId + toState and nothing else.
      await recordUnattachedChangeStatus(tx, {
        orgId: org.orgId,
        peerDomainId: peerA,
        changeObjectId: changeId,
        lastState: "executing",
        dropReason: "no_local_replica"
      });
    });

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, IN_FLIGHT)
    );
    const row = rows.find((r) => r.changeObjectId === changeId);
    expect(rows.filter((r) => r.changeObjectId === changeId)).toHaveLength(1);
    expect(row!.lastState).toBe("executing");
    // ...while the naming the propose gave us is NOT erased by a payload that never carried it.
    expect(row!.name).toBe("ledger rollout");
    expect(row!.urn).toBe("urn:scp:acme:change:ledger-rollout");
  });

  it("a change that has SETTLED stops matching the in-flight filter", async () => {
    const changeId = randomUUID();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordUnattachedChangeStatus(tx, {
        orgId: org.orgId,
        peerDomainId: peerA,
        changeObjectId: changeId,
        lastState: "executing",
        dropReason: "no_local_replica"
      })
    );
    let rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, IN_FLIGHT)
    );
    expect(rows.map((r) => r.changeObjectId)).toContain(changeId);

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordUnattachedChangeStatus(tx, {
        orgId: org.orgId,
        peerDomainId: peerA,
        changeObjectId: changeId,
        lastState: "accepted",
        dropReason: "no_local_replica"
      })
    );
    rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, IN_FLIGHT)
    );
    // Still recorded (the evidence is real), but it no longer makes any board claim ignorance —
    // which is the whole point of conditioning the caveat on the state rather than on existence.
    expect(rows.map((r) => r.changeObjectId)).not.toContain(changeId);
  });

  it("SELF-CLEARS: once the change object lands, the row for that (peer, change) is gone", async () => {
    const changeId = randomUUID();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await recordUnattachedChangeStatus(tx, {
        orgId: org.orgId,
        peerDomainId: peerA,
        changeObjectId: changeId,
        lastState: "proposed",
        dropReason: "no_local_replica"
      });
      // A DIFFERENT peer's evidence for the same change id must survive — clearing is keyed on the
      // peer whose `object_upsert` actually landed, not on the change alone.
      await recordUnattachedChangeStatus(tx, {
        orgId: org.orgId,
        peerDomainId: peerB,
        changeObjectId: changeId,
        lastState: "proposed",
        dropReason: "receiver_scope"
      });
      await clearUnattachedChangeStatus(tx, org.orgId, peerA, changeId);
    });

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, IN_FLIGHT)
    );
    const forChange = rows.filter((r) => r.changeObjectId === changeId);
    expect(forChange.map((r) => r.peerDomainId)).toEqual([peerB]);
    expect(forChange[0]!.dropReason).toBe("receiver_scope");
  });

  it("is org-isolated — another org's evidence is invisible (RLS, DESIGN §4.2)", async () => {
    const changeId = randomUUID();
    await withTenantTx(server.deps.db, otherOrg.orgId, (tx) =>
      recordUnattachedChangeStatus(tx, {
        orgId: otherOrg.orgId,
        peerDomainId: peerA,
        changeObjectId: changeId,
        lastState: "proposed",
        dropReason: "no_local_replica"
      })
    );
    const seenFromOrg = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, IN_FLIGHT)
    );
    expect(seenFromOrg.map((r) => r.changeObjectId)).not.toContain(changeId);
  });

  it("an empty state filter matches nothing rather than everything", async () => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listUnattachedChangeStatusInStates(tx, org.orgId, [])
    );
    expect(rows).toEqual([]);
  });
});

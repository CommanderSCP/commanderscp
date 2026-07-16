import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Change target-authority (M12 P4B Phase 2). A `change`, like a `campaign`, binds its authority to
 * a DECLARED `properties.targets` field, and P4B makes that load-bearing (a `requires`/`provides`
 * coupling against an object you don't control is an escalation). Two holes are closed here, mirror-
 * imaging campaign's own SECURITY tests (`campaign.integration.test.ts`):
 *   1. `POST /changes` now authorizes `object:write` over EVERY target, not just the change's domain.
 *   2. the generic `/objects/change` route refuses every write verb, so a change can be created and
 *      mutated ONLY through the typed, target-checked path.
 */
describe("change target-authority (M12 P4B Phase 2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "change-authority");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  it("SECURITY: propose is refused for a target OUTSIDE the actor's authority, but allowed WITHIN it — isolating the target check from the domain check", async () => {
    // `outsideTarget` sits at the org root (default domain); `ownTarget` sits inside a domain the
    // narrow actor administers. The actor holds Administrator ONLY at `ownDomain`.
    const outsideTarget = await admin.components.create({ name: `chg-outside-${randomUUID().slice(0, 8)}` });
    const ownDomain = await admin.domains.create({ name: `chg-own-domain-${randomUUID().slice(0, 8)}` });
    const ownTarget = await admin.components.create({
      name: `chg-own-${randomUUID().slice(0, 8)}`,
      domainId: ownDomain.id
    });
    const narrow = await createTestUser(server, org, [{ role: "Administrator", scope: ownDomain.id }]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrow.token });

    // domainId = ownDomain PASSES the change's domain-level `object:write` check, so a rejection here
    // can ONLY come from the new per-TARGET check — the actor has no authority over `outsideTarget`.
    await expect(
      narrowClient.changes.propose({
        name: "cross-domain-change",
        domainId: ownDomain.id,
        targets: [outsideTarget.id]
      })
    ).rejects.toMatchObject({ status: 403 });

    // Same actor, same domain, but a target INSIDE its authority — allowed. Proves the guard isn't
    // simply rejecting everything the narrow actor proposes.
    const ok = await narrowClient.changes.propose({
      name: "own-domain-change",
      domainId: ownDomain.id,
      targets: [ownTarget.id]
    });
    expect(ok.id).toBeTruthy();

    // The rejected attempt created nothing.
    const list = await admin.changes.list({ limit: 100 });
    expect(list.items.every((c) => c.name !== "cross-domain-change")).toBe(true);
  });

  it("SECURITY: the generic /objects/change endpoint refuses every write verb, even for the org-root admin", async () => {
    const target = await admin.components.create({ name: `chg-generic-${randomUUID().slice(0, 8)}` });

    // create via the generic route → 403, even for the full-authority admin: an unconditional
    // type-level block, not a permission gap. Without it, this bypasses proposeChange's whole
    // lifecycle (state machine, plan) AND the per-target check above.
    await expect(
      admin.object("change").create({ name: "sneaky-change-via-generic", properties: { targets: [target.id] } })
    ).rejects.toMatchObject({ status: 403 });

    // PATCH/DELETE a legitimately-proposed change → 403: nobody can flip a coordinated change's
    // `purpose` (P4A) or `requires`/`provides` (P4B) mid-flight, or delete it out from under the engine.
    const legit = await admin.changes.propose({ name: "legit-change-for-generic-block", targets: [target.id] });
    await expect(
      admin.object("change").update(legit.id, { properties: { purpose: "infra" } })
    ).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("change").delete(legit.id)).rejects.toMatchObject({ status: 403 });
  });
});

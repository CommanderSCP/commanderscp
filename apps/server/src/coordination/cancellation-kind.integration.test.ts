import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { transitionChange } from "./transition.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * An AUTO-cancelled change must be distinguishable from a USER-cancelled one (§1.5 / §11,
 * migration 0053).
 *
 * Both land in state `cancelled`. Until 0053 the only difference was the wording of a free-text
 * `reason` on the transition's Decision and audit event — so "how many changes did the engine kill
 * last week?" could only be answered by substring-matching an English sentence, and any rewording
 * of that sentence silently changed the answer. `reconcile.ts` auto-cancels on a plan that will not
 * compile, which is exactly the population an operator most needs to count.
 *
 * These tests assert the STRUCTURED field, never the reason text — pinning the sentence would
 * reproduce the very coupling the column exists to remove.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | drop the `cancellationKind` write from `transitionChange` | both cancel tests fail |
 * | always write `"user"` | "the engine's own cancel is marked system" fails |
 * | always write `"system"` | "a human cancel is marked user" fails |
 * | write it on every transition, not just `cancelled` | "a NON-cancel transition writes no kind" fails |
 *
 * That last row is the one worth reading twice. Its test originally examined a freshly PROPOSED
 * change — which never passes through `transitionChange` at all — so it stayed green under the
 * mutation and proved nothing about the `toState === "cancelled"` condition. It now drives a real
 * non-cancel transition, and fails as it should.
 */
describe("cancellation kind: engine vs human", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "cancel-kind");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function proposedChange(label: string) {
    const component = await createTestComponent(admin, { name: `${label}-comp` });
    return admin.changes.propose({ name: `${label}-change`, targets: [component.id] });
  }

  it("a human cancel is marked `user`", async () => {
    const change = await proposedChange("human");
    await admin.changes.cancel(change.id, "changed my mind");

    const after = await admin.changes.get(change.id);
    expect(after.state).toBe("cancelled");
    expect(after.cancellationKind).toBe("user");
  });

  it("the engine's own cancel is marked `system` — the same path reconcile takes", async () => {
    // Driven through `transitionChange` with the system sentinel, which is exactly what
    // `reconcile.ts` passes when a plan fails to compile. Asserting on the ACTOR-derived field
    // rather than on reconcile's reason string is the point: the reason is prose and may be
    // reworded, the actor is structural.
    const change = await proposedChange("engine");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "cancelled",
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "test-reconcile",
          reason: "auto-cancelled: plan compilation failed — anything at all"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      )
    );

    const after = await admin.changes.get(change.id);
    expect(after.state).toBe("cancelled");
    expect(after.cancellationKind).toBe("system");
  });

  it("a NON-cancel transition writes no kind — the field is about cancelling, not about acting", async () => {
    // This test drives a real transition on purpose. An earlier version only checked a freshly
    // PROPOSED change, which never passes through `transitionChange` at all — so it stayed green
    // when the write was mutated to fire on every transition, and proved nothing about the
    // `toState === "cancelled"` condition. A change that merely advanced must carry no kind:
    // otherwise every live change would read as cancelled-by-someone.
    const change = await proposedChange("advanced");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      transitionChange(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          toState: "evaluated",
          actorObjectId: SYSTEM_ACTOR_ID,
          requestId: "test-advance",
          reason: "auto: evaluated"
        },
        { sandbox: getSharedCelSandbox(), host: null }
      )
    );

    const after = await admin.changes.get(change.id);
    expect(after.state).toBe("evaluated");
    expect(after.cancellationKind ?? null).toBeNull();
  });
});

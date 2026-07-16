import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Coupled pipelines (M12 P4B — docs/proposals/coupled-pipelines.md). A change declaring
 * `requires: [{key, at}]` parks in `waiting` and is released to `executing` only once ANOTHER change
 * reaches `validating`/`promoted` and `provides` that key at that object. Real reconcile loop, real
 * Postgres, real (default fake-executor) execution — a change with no binding still drives to
 * `validating` via the shared default instance, so no executor wiring is needed here.
 *
 * The decisive behaviours: a waiter PARKS (does not execute) while its prerequisite is outstanding;
 * it RELEASES the moment the correct provider validates; a provider of the same key at a DIFFERENT
 * object does NOT release it (the `at` is load-bearing); and a bad `at` is a 404 at propose, never a
 * silent forever-wait.
 */
describe("coupled pipelines: a change waits on a cross-change prerequisite (M12 P4B)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "coupling");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  const stateOf = async (id: string): Promise<string> => (await admin.changes.get(id)).state;
  const reaches = (id: string, state: string, ms = 25_000) =>
    waitUntil(async () => ((await stateOf(id)) === state ? true : undefined), {
      describe: `change ${id} reaches '${state}'`,
      timeoutMs: ms
    });

  it("a change with no requires goes straight to validating — behaviour-preserving", async () => {
    const comp = await admin.components.create({ name: "no-requires" });
    const change = await admin.changes.propose({ name: "plain release", targets: [comp.id] });
    await reaches(change.id, "validating");
  });

  it("a change with an UNSATISFIED requirement parks in waiting, then RELEASES when the provider validates", async () => {
    const infra = await admin.components.create({ name: "coupling-infra" });
    const app = await admin.components.create({ name: "coupling-app" });

    // The software release requires `feature-a` provided at the infra object. No provider exists yet.
    const waiter = await admin.changes.propose({
      name: "software waiting on infra",
      targets: [app.id],
      requires: [{ key: "feature-a", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // It stays parked — a wait triggers nothing and never silently advances. Give it several ticks.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await stateOf(waiter.id)).toBe("waiting");

    // The infra release provides the key at the infra object; it drives to validating on its own.
    const provider = await admin.changes.propose({
      name: "infra providing feature-a",
      targets: [infra.id],
      provides: ["feature-a"]
    });
    await reaches(provider.id, "validating");

    // Now the waiter's prerequisite is satisfied — it releases and completes.
    await reaches(waiter.id, "validating");
  });

  it("a provider of the same key at a DIFFERENT object does NOT release the waiter — `at` is load-bearing", async () => {
    const infra = await admin.components.create({ name: "spec-infra" });
    const other = await admin.components.create({ name: "spec-other" });
    const app = await admin.components.create({ name: "spec-app" });

    const waiter = await admin.changes.propose({
      name: "waits on key@infra specifically",
      targets: [app.id],
      requires: [{ key: "shared-key", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // A provider of `shared-key` but at `other`, not `infra`. It validates — and must NOT satisfy the
    // waiter, whose requirement names `infra`.
    const wrongProvider = await admin.changes.propose({
      name: "provides shared-key at the WRONG object",
      targets: [other.id],
      provides: ["shared-key"]
    });
    await reaches(wrongProvider.id, "validating");
    // Give the waiter several more ticks AFTER the wrong provider validated: if the predicate
    // ignored `at` (matched on key alone), this is exactly when it would wrongly release. It must
    // still be parked.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await stateOf(waiter.id)).toBe("waiting");

    // The CORRECT provider (same key, at infra) releases it — proving the wait was genuine, not stuck.
    const rightProvider = await admin.changes.propose({
      name: "provides shared-key at infra",
      targets: [infra.id],
      provides: ["shared-key"]
    });
    await reaches(rightProvider.id, "validating");
    await reaches(waiter.id, "validating");
  });

  it("explain surfaces the wait status — the outstanding requirement (named), then satisfied by the provider (Phase 4)", async () => {
    const infra = await admin.components.create({ name: "explain-infra" });
    const app = await admin.components.create({ name: "explain-app" });
    const waiter = await admin.changes.propose({
      name: "explained waiter",
      targets: [app.id],
      requires: [{ key: "feat-x", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // While parked: waitStatus shows the requirement OUTSTANDING, with the `at` object's name.
    let explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus).not.toBeNull();
    expect(explained.waitStatus!.waiting).toBe(true);
    expect(explained.waitStatus!.requirements).toEqual([
      { key: "feat-x", at: infra.id, atName: "explain-infra", satisfied: false, satisfiedByChangeId: null }
    ]);

    // Provide it; the waiter releases.
    const provider = await admin.changes.propose({
      name: "explain provider",
      targets: [infra.id],
      provides: ["feat-x"]
    });
    await reaches(provider.id, "validating");
    await reaches(waiter.id, "validating");

    // Now waitStatus shows it satisfied, and names the providing change.
    explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus!.waiting).toBe(false);
    expect(explained.waitStatus!.requirements[0]).toMatchObject({
      satisfied: true,
      satisfiedByChangeId: provider.id
    });

    // A change that declared no requires has a null waitStatus — unchanged for every pre-P4B change.
    const plain = await admin.changes.propose({ name: "no coupling", targets: [app.id] });
    expect((await admin.changes.explain(plain.id)).waitStatus).toBeNull();
  });

  it("a bad `at` reference is a 404 at propose time — never a silent forever-wait", async () => {
    const app = await admin.components.create({ name: "bad-at-app" });
    await expect(
      admin.changes.propose({
        name: "requires a nonexistent object",
        targets: [app.id],
        requires: [{ key: "feature-a", at: "urn:scp:does-not-exist:component:nope" }]
      })
    ).rejects.toMatchObject({ status: 404 }); // getObjectByIdOrUrnAnyType 404s on an unresolvable ref
  });
});

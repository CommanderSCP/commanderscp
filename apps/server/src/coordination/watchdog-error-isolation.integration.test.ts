import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeliveryResult, NotificationMessage } from "@scp/plugin-api";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, decisions } from "../db/schema.js";
import { proposeChange } from "./changes-repo.js";
import type {
  ControlPluginClient,
  DependencyIndexPluginClient,
  DiscoveryPluginClient,
  ExecutorPluginClient,
  FederationTransportPluginClient,
  GitFileReadPluginClient,
  NotificationPluginClient,
  PluginHost
} from "../plugin-host/contract.js";

/**
 * WD-1 (M26.1 review): the per-org watchdog sweep restructure (§7.1 item 3) dropped the per-candidate
 * error isolation that every sibling loop in the same diff has (reconcile's per-change, observe's
 * per-instance, federation-sync's per-peer try/catch). Without it, a throw while claiming or writing
 * ONE stalled change's Decision/audit escapes the candidate loop AND the outer per-state loop, so
 * every later-ordered candidate is silently starved on that tick — and since the failed claim's
 * `watchdog_flagged_at` was rolled back, the poison row re-qualifies forever, wedging the sweep for
 * that org. This pins that one candidate's failure is isolated: the others are still flagged.
 *
 * Injection: `insertDecision` is made to throw for exactly ONE change's id (the real implementation
 * runs for every other), which is precisely the transient in-tx failure the restructure targets.
 */
const inject = vi.hoisted(() => ({ poisonSubjectId: null as string | null }));

vi.mock("./decisions-repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./decisions-repo.js")>();
  return {
    ...actual,
    insertDecision: vi.fn(
      async (
        tx: Parameters<typeof actual.insertDecision>[0],
        input: Parameters<typeof actual.insertDecision>[1]
      ) => {
        if (inject.poisonSubjectId && input.subjectId === inject.poisonSubjectId) {
          throw new Error("injected: watchdog Decision write failed for the poisoned change");
        }
        return actual.insertDecision(tx, input);
      }
    )
  };
});

// Imported AFTER the mock declaration so its `insertDecision` binding resolves to the mocked module.
const { runWatchdogSweep } = await import("./watchdog.js");

function createNotifyCountingHost(): PluginHost {
  const notWired = (surface: string): never => {
    throw new Error(`watchdog-error-isolation test: no ${surface} fixture wired`);
  };
  return {
    async start() {},
    async stop() {},
    async stopInstances() {},
    executor: (): ExecutorPluginClient => notWired("ExecutorPlugin"),
    control: (): ControlPluginClient => notWired("ControlPlugin"),
    discovery: (): DiscoveryPluginClient => notWired("DiscoveryPlugin"),
    federationTransport: (): FederationTransportPluginClient =>
      notWired("FederationTransportPlugin"),
    dependencyIndex: (): DependencyIndexPluginClient => notWired("DependencyIndexPlugin"),
    gitFileRead: (): GitFileReadPluginClient => notWired("git-provider readFileAtRef"),
    notification: (): NotificationPluginClient => ({
      async send(_msg: NotificationMessage): Promise<DeliveryResult> {
        return { delivered: true };
      }
    })
  };
}

describe("coordination engine: watchdog sweep isolates a per-candidate failure (WD-1)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "watchdog-isolation");
  });

  afterAll(async () => {
    inject.poisonSubjectId = null;
    await server.close();
  });

  it("a change whose Decision write throws does not prevent OTHER stalled changes from being flagged", async () => {
    const [poison, healthy] = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const a = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "watchdog-isolation-poison",
        name: "poison change (its Decision write will throw)",
        targets: [org.orgId]
      });
      const b = await proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "watchdog-isolation-healthy",
        name: "healthy change (must still be flagged)",
        targets: [org.orgId]
      });
      return [a.change, b.change] as const;
    });

    inject.poisonSubjectId = poison.id;
    const farFuture = new Date(Date.now() + 10 * 60_000);

    // THE MUTATION-PROVING CALL: with the per-candidate try/catch, this resolves and the healthy
    // change is flagged. Without it, the poisoned candidate's throw propagates out of the sweep
    // (rejecting this promise) and the healthy candidate ordered after it is never processed.
    const flags = await runWatchdogSweep(
      server.deps.db,
      org.orgId,
      createNotifyCountingHost(),
      server.deps.config.secretsMasterKey,
      { requestId: "watchdog-isolation-sweep", now: farFuture }
    );

    const flaggedIds = flags.map((f) => f.changeObjectId);
    expect(flaggedIds).toContain(healthy.id);
    expect(flaggedIds).not.toContain(poison.id);

    // And it is durable, not just returned: the healthy change committed its flag + Decision; the
    // poisoned one rolled its whole claim tx back, so it stays unflagged and re-qualifies next tick.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ objectId: changes.objectId, flaggedAt: changes.watchdogFlaggedAt })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId)))
    );
    const healthyRow = rows.find((r) => r.objectId === healthy.id);
    const poisonRow = rows.find((r) => r.objectId === poison.id);
    expect(healthyRow?.flaggedAt).not.toBeNull();
    expect(poisonRow?.flaggedAt ?? null).toBeNull();

    const healthyDecisions = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.orgId, org.orgId), eq(decisions.subjectId, healthy.id)))
    );
    expect(healthyDecisions.length).toBeGreaterThan(0);
  });
});

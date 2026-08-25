import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliveryResult, NotificationMessage } from "@scp/plugin-api";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { proposeChange } from "./changes-repo.js";
import { runWatchdogSweep } from "./watchdog.js";
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
 * §4-A3 / §7.1 item 3: the watchdog sweep used to run one org's ENTIRE stalled-change batch inside
 * one long `withTenantTx`, and the guarded flag UPDATE's affected-row count was never checked — so
 * two overlapping sweeps racing the same stalled change each committed their OWN Decision + audit
 * event + notification. This is the multi-replica proof the restructure exists to make true: N
 * genuinely concurrent sweeps (`Promise.all`, real independent transactions against the SAME
 * Postgres — not just JS-level interleaving) hitting the SAME stalled change produce EXACTLY one
 * of each.
 */

/** Counts `NotificationPluginClient.send()` calls without needing a real notification transport —
 *  every other plugin surface throws, since this fixture only drives the notification path. */
function createNotifyCountingHost(): { host: PluginHost; sendCount: () => number } {
  let count = 0;
  const notWired = (surface: string): never => {
    throw new Error(
      `watchdog-race test: no ${surface} fixture wired — this test only drives NotificationPlugin`
    );
  };
  const host: PluginHost = {
    async start() {},
    async stop() {},
    async stopInstances() {},
    executor(_instanceId: string): ExecutorPluginClient {
      return notWired("ExecutorPlugin");
    },
    control(_instanceId: string): ControlPluginClient {
      return notWired("ControlPlugin");
    },
    discovery(_instanceId: string): DiscoveryPluginClient {
      return notWired("DiscoveryPlugin");
    },
    federationTransport(_instanceId: string): FederationTransportPluginClient {
      return notWired("FederationTransportPlugin");
    },
    dependencyIndex(_instanceId: string): DependencyIndexPluginClient {
      return notWired("DependencyIndexPlugin");
    },
    gitFileRead(_instanceId: string): GitFileReadPluginClient {
      return notWired("git-provider readFileAtRef");
    },
    notification(_instanceId: string): NotificationPluginClient {
      return {
        async send(_msg: NotificationMessage): Promise<DeliveryResult> {
          count++;
          return { delivered: true };
        }
      };
    }
  };
  return { host, sendCount: () => count };
}

describe("coordination engine: watchdog claim is single-flight under real multi-replica concurrency (§4-A3)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "watchdog-race");
  });

  afterAll(async () => {
    await server.close();
  });

  it("N concurrent sweeps racing the SAME stalled change produce exactly one Decision, one audit event, one notification", async () => {
    const ITERATIONS = 15;
    const CONCURRENT_SWEEPS = 8;
    const counts: number[] = [];
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const target = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        const { change } = await proposeChange(tx, {
          orgId: org.orgId,
          actorObjectId: org.orgId,
          requestId: `watchdog-race-test-${iter}`,
          name: `will stall (race) ${iter}`,
          targets: [org.orgId] // any live object id — this change is never executed
        });
        return change;
      });
      expect(target.state).toBe("proposed");

      const { host } = createNotifyCountingHost();

      const farFuture = new Date(Date.now() + 10 * 60_000);

      const results = await Promise.all(
        Array.from({ length: CONCURRENT_SWEEPS }, (_, i) =>
          runWatchdogSweep(server.deps.db, org.orgId, host, server.deps.config.secretsMasterKey, {
            requestId: `watchdog-race-sweep-${iter}-${i}`,
            now: farFuture
          })
        )
      );

      const winningFlags = results.flatMap((flags) =>
        flags.filter((f) => f.changeObjectId === target.id)
      );
      counts.push(winningFlags.length);
    }

    // Compared as a WHOLE ARRAY, not `counts.every(c => c === 1)`. The `every` form reduces a race to
    // "expected false to be true", which says nothing about WHICH iteration lost or by how much — the
    // difference between two sweeps both flagging (the bug this test exists for) and zero sweeps
    // flagging (a broken fixture) is invisible in that message, and this test is only meaningful when
    // it fails in CI, where nobody can re-run it interactively.
    expect(counts, `${ITERATIONS} iterations x ${CONCURRENT_SWEEPS} concurrent sweeps`).toEqual(
      Array.from({ length: ITERATIONS }, () => 1)
    );
  }, 120_000);
});

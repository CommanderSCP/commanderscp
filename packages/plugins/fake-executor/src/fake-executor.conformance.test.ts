/**
 * Wires `@scp/plugin-fake-executor` into `@scp/plugin-testkit`'s generic `ExecutorPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/
 * plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and
 * knows nothing about fake-executor specifics — this file is only the fixture factory.
 */
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite } from "@scp/plugin-testkit";
import { createFakeExecutorPlugin } from "./index.js";

runExecutorConformanceSuite("fake-executor", async () => {
  const plugin = createFakeExecutorPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    domainId: "conformance-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("fake-executor conformance fixture never calls ctx.http");
      }
    },
    // Short auto-succeed so the suite (which doesn't sleep) still sees deterministic phases.
    config: { autoSucceedAfterMs: 5 }
  };
  return { plugin, ctx };
});

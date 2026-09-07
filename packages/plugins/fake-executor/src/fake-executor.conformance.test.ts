/** Wires this plugin into the generic executor conformance suite. See docs/plugins.md §59. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite, mkdtempTracked } from "@scp/plugin-testkit";
import { createFakeExecutorPlugin } from "./index.js";

runExecutorConformanceSuite("fake-executor", async () => {
  const statePath = join(
    await mkdtempTracked(join(tmpdir(), "fake-executor-conformance-")),
    "state.json"
  );
  const build = (): {
    plugin: ReturnType<typeof createFakeExecutorPlugin>;
    ctx: PluginContext;
  } => ({
    plugin: createFakeExecutorPlugin(),
    ctx: {
      orgId: "conformance-org",
      scopeKey: "conformance-domain",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { get: async () => undefined },
      http: {
        request: async () => {
          throw new Error("fake-executor conformance fixture never calls ctx.http");
        }
      },
      // Short auto-succeed so the suite (which doesn't sleep) still sees deterministic phases;
      // statePath makes dedup durable across the simulated restart.
      config: { autoSucceedAfterMs: 5, statePath }
    }
  });
  return { ...build(), restart: async () => build() };
});

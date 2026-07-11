/**
 * Wires `@scp/plugin-fake-executor` into `@scp/plugin-testkit`'s generic `ExecutorPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/
 * plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and
 * knows nothing about fake-executor specifics — this file is only the fixture factory.
 *
 * The factory sets a per-call `statePath` (a fresh temp file) and provides `restart` (MAJOR #4) so
 * the suite's cross-restart dedup test genuinely reads durable on-disk state rather than the
 * first instance's in-process memory.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@scp/plugin-api";
import { runExecutorConformanceSuite } from "@scp/plugin-testkit";
import { createFakeExecutorPlugin } from "./index.js";

runExecutorConformanceSuite("fake-executor", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "fake-executor-conformance-")), "state.json");
  const build = (): {
    plugin: ReturnType<typeof createFakeExecutorPlugin>;
    ctx: PluginContext;
  } => ({
    plugin: createFakeExecutorPlugin(),
    ctx: {
      orgId: "conformance-org",
      domainId: "conformance-domain",
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

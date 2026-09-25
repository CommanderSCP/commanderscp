#!/usr/bin/env node
import { createServer } from "node:http";
import { buildControllerDeps, loadControllerConfig, selfTest } from "./controller.js";
import { inClusterTransport } from "./kube.js";
import { startStackController } from "./reconcile.js";

/**
 * scp-stackd — the Standard Stack controller (M29.4, ADR-0058). Runs as its own Deployment under
 * its own ServiceAccount, never inside scpd (E1).
 *
 *   scp-stackd              reconcile forever (in-cluster)
 *   scp-stackd --self-test  render every backend offline with the pinned helm, then exit
 */

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) {
    const lines = await selfTest({
      chartDir: process.env.SCP_STACKD_CHART_DIR || "/opt/scp/stack/helm-bundled",
      helmPinFile: process.env.SCP_STACKD_HELM_PIN || "/opt/scp/stack/helm.pin.env",
      ...(process.env.SCP_STACKD_HELM_BIN ? { helmBinary: process.env.SCP_STACKD_HELM_BIN } : {}),
      release: process.env.SCP_STACKD_RELEASE || "self-test"
    });
    for (const line of lines) console.log(line);
    return;
  }

  const config = loadControllerConfig();
  const deps = await buildControllerDeps(config, await inClusterTransport());
  console.log(
    `[scp-stackd] release ${deps.release.version}, helm ${deps.helm.version}, SCP namespace ` +
      `${config.scpNamespace}, reconciling every ${config.intervalMs / 1000}s`
  );
  const controller = startStackController(deps, { intervalMs: config.intervalMs });

  // Liveness: the loop has completed a tick recently. A wedged tick (a hung API call) restarts the
  // pod instead of leaving the Stack page frozen on its last report.
  const port = Number(process.env.SCP_STACKD_HEALTH_PORT || 8081);
  const staleAfterMs = Math.max(config.intervalMs, config.readyTimeoutMs) * 3;
  const health = createServer((req, res) => {
    const last = controller.lastTickAt();
    const fresh =
      last === null
        ? process.uptime() * 1000 < staleAfterMs
        : Date.now() - last.getTime() < staleAfterMs;
    res.writeHead(fresh ? 200 : 503, { "content-type": "text/plain" });
    res.end(fresh ? "ok\n" : "reconcile loop has not completed a tick recently\n");
  });
  health.listen(port, "0.0.0.0");

  const shutdown = async (signal: string) => {
    console.log(`[scp-stackd] ${signal}: finishing the current tick`);
    health.close();
    await controller.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[scp-stackd] fatal:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

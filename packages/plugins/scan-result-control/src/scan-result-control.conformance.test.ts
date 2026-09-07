/** Wires this plugin into the generic control conformance suite. See docs/plugins.md §530. */
import type { PluginContext, ScopedHttpResponse } from "@scp/plugin-api";
import { runControlConformanceSuite } from "@scp/plugin-testkit";
import { createScanResultControlPlugin } from "./index.js";

const DIGEST = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

runControlConformanceSuite("scan-result-control", async () => {
  const plugin = createScanResultControlPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    scopeKey: "conformance-domain",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async (): Promise<ScopedHttpResponse> => ({
        status: 200,
        headers: {},
        body: {
          SchemaVersion: 2,
          ArtifactName: "conformance/app:1.0",
          Metadata: { RepoDigests: [`conformance/app@${DIGEST}`] },
          Results: [{ Target: "conformance", Vulnerabilities: [] }]
        }
      })
    },
    config: { url: "https://example.invalid/scan-result", expectedDigest: DIGEST }
  };
  return {
    plugin,
    ctx,
    request: { changeId: "conformance-change", controlId: "conformance-control", context: {} }
  };
});

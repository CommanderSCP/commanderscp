/**
 * Wires `@scp/plugin-scan-result-control` into `@scp/plugin-testkit`'s generic `ControlPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2). Like the webhook-control fixture, this file knows
 * nothing the suite doesn't — it points `ctx.http` at a stub returning a well-formed, clean,
 * digest-matching Trivy result so the shape-only conformance assertions (well-formed
 * `ControlOutcome`, always-present evidence) hold.
 */
import type { PluginContext, ScopedHttpResponse } from "@scp/plugin-api";
import { runControlConformanceSuite } from "@scp/plugin-testkit";
import { createScanResultControlPlugin } from "./index.js";

const DIGEST = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

runControlConformanceSuite("scan-result-control", async () => {
  const plugin = createScanResultControlPlugin();
  const ctx: PluginContext = {
    orgId: "conformance-org",
    domainId: "conformance-domain",
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

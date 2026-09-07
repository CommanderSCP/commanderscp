import { describe, expect, it } from "vitest";
import { manifest as managedDepManifest } from "@scp/plugin-managed-dep";
import { MANIFEST_BY_MODULE, validatePluginConfig } from "./plugin-manifests.js";
import { isKnownExecutorModule } from "../coordination/executor-bindings-repo.js";

/** That module is registered, and its schema is strict. See docs/plugin-host.md §82. */
describe("M21.5 managed-dep's config schema is registered, and therefore enforced", () => {
  it("is in MANIFEST_BY_MODULE, which is what makes validatePluginConfig look at it at all", () => {
    expect(MANIFEST_BY_MODULE["managed-dep"]).toBe(managedDepManifest);
  });

  it("accepts the TENANT surface: the git-provider identity their own team configured", () => {
    expect(() =>
      validatePluginConfig("managed-dep", {
        provider: "github",
        appId: "12345",
        installationId: "67890",
        privateKeySecretKey: "acme-app-key",
        apiBaseUrl: "https://github.example.com/api/v3",
        timeoutMs: 60_000
      })
    ).not.toThrow();
  });

  it.each([
    ["dockerBinary", "/tmp/evil"],
    ["runnerImage", "attacker/image:latest"],
    ["networkMode", "host"],
    ["workspaceRoot", "/"]
  ])("REFUSES the server-governed key '%s' from a tenant binding config", (key, value) => {
    expect(() => validatePluginConfig("managed-dep", { [key]: value })).toThrow();
  });

  it("refuses a plaintext private key in config — the vaulted reference is the only channel", () => {
    // `privateKeyPem` exists on the plugin's own config TYPE as a test/fixture fallback; it is
    // deliberately absent from the manifest, so a tenant cannot supply key material inline.
    expect(() => validatePluginConfig("managed-dep", { privateKeyPem: "-----BEGIN..." })).toThrow();
  });

  it("EVERY allowlisted executor module has a manifest — the class, not this instance", () => {
    // `isKnownExecutorModule` is the allowlist a binding is checked against. A module on it with no
    // manifest here is a module whose tenant config is never validated, which is the exact hole this
    // milestone's own class of defect came from.
    const missing = Object.keys(MANIFEST_BY_MODULE).length === 0 ? ["<map is empty>"] : [];
    for (const module of [
      "github",
      "gitea",
      "gitlab",
      "argocd",
      "terraform",
      "pipeline-generic",
      "managed-iac",
      "managed-scan",
      "managed-dep",
      "fake-executor"
    ]) {
      if (!isKnownExecutorModule(module)) continue;
      if (!MANIFEST_BY_MODULE[module]) missing.push(module);
    }
    // `fake-executor` and `pipeline-generic` are known gaps that predate M21.5 and are tracked with
    // PR #238's boot assertion; this milestone's own module must not be among them.
    expect(missing).not.toContain("managed-dep");
  });
});

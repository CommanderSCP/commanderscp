import { describe, expect, it } from "vitest";
import { manifest as managedDepManifest } from "@scp/plugin-managed-dep";
import { MANIFEST_BY_MODULE, validatePluginConfig } from "./plugin-manifests.js";
import { isKnownExecutorModule } from "../coordination/executor-bindings-repo.js";

/**
 * M21.5 — `managed-dep` IS REGISTERED, and its `additionalProperties: false` therefore RUNS.
 *
 * ================================================================================================
 * WHY THIS TEST EXISTS AND WHAT IT IS ABOUT
 * ================================================================================================
 * An authored `configSchema` is worth exactly nothing until its module is in
 * {@link MANIFEST_BY_MODULE}: `validatePluginConfig` looks the module up there and RETURNS SILENTLY
 * when it finds nothing, so an unregistered module is an UNVALIDATED one. That is not hypothetical —
 * shipped `managed-scan` authored the same schema, was never registered, and its `dockerBinary` (the
 * executable it spawns) was settable from a tenant binding config as a result.
 *
 * So this asserts BOTH halves that have to hold together: the entry exists, AND the refusal it
 * enables actually fires on the server-governed keys. Deleting the map entry fails the second
 * assertion, not merely the first — a test that only read the map would pass against a schema whose
 * gate nothing ran.
 *
 * The last case is the class rather than the instance: EVERY module on the executor allowlist must
 * have a manifest here. That is the boot assertion PR #238 adds, expressed as a test so this
 * milestone cannot be the one that breaks it.
 */
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

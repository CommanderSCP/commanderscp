import { describe, expect, it } from "vitest";
import { PluginKindSchema } from "@scp/schemas";
import {
  BUNDLED_PLUGIN_MANIFESTS,
  MANIFEST_BY_MODULE,
  validatePluginConfig
} from "./plugin-manifests.js";

/**
 * M21.4 pins a DELIBERATE ASYMMETRY that reads like an oversight, so it is pinned rather than only
 * commented: the five `dependency-index` manifests are in `MANIFEST_BY_MODULE` and NOT in
 * `BUNDLED_PLUGIN_MANIFESTS`.
 *
 * Without this file the next reader "tidies" it one way or the other:
 *  - adding them to the published list widens `GET /api/v1/plugins/manifests`' response enum, i.e.
 *    changes the public v1 contract, in a milestone that ships no route for them; and
 *  - dropping them from the module map removes the `validatePluginConfig` gate that keeps the OCI
 *    index's SERVER-GOVERNED `skopeoBinary`/`allowedRegistryHosts` unsettable by a binding.
 */
describe("the dependency-index manifests are module-map-only, on purpose", () => {
  const MODULES = [
    "dependency-index-go",
    "dependency-index-npm",
    "dependency-index-pypi",
    "dependency-index-maven",
    "dependency-index-oci"
  ] as const;

  it("every one is reachable by module, so its config schema gates the write doors", () => {
    for (const module of MODULES) {
      expect(MANIFEST_BY_MODULE[module], module).toBeDefined();
    }
  });

  it("none is published on the v1 manifests endpoint, whose kind enum does not enumerate them", () => {
    const published = new Set(BUNDLED_PLUGIN_MANIFESTS.map((m) => m.id));
    for (const module of MODULES) expect(published.has(module), module).toBe(false);
    expect(PluginKindSchema.options).not.toContain("dependency-index");
    // NEGATIVE CONTROL: the endpoint is not empty, and every manifest it DOES publish carries a kind
    // the v1 enum enumerates — so the exclusion above is about this kind, not about the list being
    // broken.
    expect(BUNDLED_PLUGIN_MANIFESTS.length).toBeGreaterThan(0);
    for (const manifest of BUNDLED_PLUGIN_MANIFESTS) {
      expect(PluginKindSchema.options).toContain(manifest.kind);
    }
  });

  it("the OCI index's server-governed keys are refused by its schema, tenant-settable ones are not", () => {
    // The `managed-scan` shape: `additionalProperties: false` with the governed keys ABSENT, so the
    // server's own spread is the only source of `skopeoBinary`/`allowedRegistryHosts`.
    expect(() =>
      validatePluginConfig("dependency-index-oci", { skopeoBinary: "/bin/sh" })
    ).toThrow();
    expect(() =>
      validatePluginConfig("dependency-index-oci", { allowedRegistryHosts: ["evil.example"] })
    ).toThrow();
    expect(() => validatePluginConfig("dependency-index-oci", { timeoutMs: 5000 })).not.toThrow();
  });

  it("a language index accepts its operator-set baseUrl and refuses an unknown key", () => {
    expect(() =>
      validatePluginConfig("dependency-index-go", { baseUrl: "https://goproxy.internal" })
    ).not.toThrow();
    expect(() =>
      validatePluginConfig("dependency-index-go", { baseUrlTypo: "https://goproxy.internal" })
    ).toThrow();
  });
});

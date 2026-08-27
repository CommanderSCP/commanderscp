import { describe, expect, it } from "vitest";
import { manifest as argoWorkflowsManifest } from "@scp/plugin-argo-workflows";
import { MANIFEST_BY_MODULE, validatePluginConfig } from "./plugin-manifests.js";
import {
  KNOWN_EXECUTOR_MODULES,
  isKnownExecutorModule
} from "../coordination/executor-bindings-repo.js";

/**
 * team-pipeline-iac increment 8 — `argo-workflows` IS REACHABLE FROM THE SERVER, not merely from
 * its own package.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS
 * ================================================================================================
 * A passing `packages/plugins/argo-workflows` test suite proves the PLUGIN works. It proves
 * nothing about whether `apps/server` can ever load it — that needs the module name to clear
 * `isKnownExecutorModule` (`coordination/executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES`
 * allowlist), have a manifest in `MANIFEST_BY_MODULE` (what `validatePluginConfig` gates a tenant
 * binding's config on), and — the boot-time backstop — pass `assertEveryModuleHasManifest`, which
 * runs at MODULE LOAD in `executor-bindings-repo.ts` and would take the whole server process down
 * before this file's own `it()`s ever ran if the module name were allowlisted with no manifest.
 * `managed-scan` sat allowlisted with no manifest for several milestones (CLAUDE.md's "component
 * built, never installed" class); this file is the same shape of proof `managed-dep`'s sibling
 * file (`plugin-manifests-managed-dep.test.ts`) established for that module, done here for
 * `argo-workflows`.
 */
describe("team-pipeline-iac inc8: argo-workflows is registered, not just built", () => {
  it("is on KNOWN_EXECUTOR_MODULES — isKnownExecutorModule('argo-workflows') is true", () => {
    expect(isKnownExecutorModule("argo-workflows")).toBe(true);
    expect(KNOWN_EXECUTOR_MODULES).toContain("argo-workflows");
  });

  it("is in MANIFEST_BY_MODULE, which is what makes validatePluginConfig look at it at all", () => {
    expect(MANIFEST_BY_MODULE["argo-workflows"]).toBe(argoWorkflowsManifest);
  });

  it("accepts the TENANT surface: serverUrl + namespace, the documented minimum config", () => {
    expect(() =>
      validatePluginConfig("argo-workflows", {
        serverUrl: "https://argo-workflows.example.com",
        namespace: "team-platform",
        tokenSecretKey: "argo-token",
        labelSelector: "team=platform"
      })
    ).not.toThrow();
  });

  it("refuses a config missing the required tenant fields", () => {
    expect(() => validatePluginConfig("argo-workflows", {})).toThrow();
  });

  // UNLIKE managed-iac/managed-scan/managed-dep, `argo-workflows` is loaded IN-PROCESS via a
  // dynamic `import()` in `subprocess-entry.ts`'s `loadPlugin()` switch — exactly like `argocd` —
  // never docker-spawned. `resolveExecutorPluginInstance` only injects
  // `dockerBinary`/`runnerImage`/`networkMode`/`workspaceRoot` for those three docker-executed
  // modules by name (apps/server/src/coordination/executor-bindings-repo.ts ~1169-1206); it never
  // does so for `argo-workflows`, and the plugin itself never reads those keys. So — correctly
  // mirroring `argocd`'s own manifest, which has no `additionalProperties: false` either — this
  // manifest does not need to refuse them. `statePath`, by contrast, IS always server-injected
  // (every module gets one) and IS part of `ArgoWorkflowsConfig`, so it round-trips as a legitimate
  // key rather than something to refuse.
  it("accepts a server-injected statePath alongside the tenant config, unchanged from argocd's shape", () => {
    expect(() =>
      validatePluginConfig("argo-workflows", {
        serverUrl: "https://argo-workflows.example.com",
        namespace: "team-platform",
        statePath: "/var/lib/scp/plugin-state/argo-workflows-inst-1.json"
      })
    ).not.toThrow();
  });

  it("EVERY allowlisted executor module has a manifest — the class, not this instance", () => {
    // Mirrors plugin-manifests-managed-dep.test.ts's sweep, named for this module specifically so
    // the sweep going green again (e.g. because a later change deletes the module from the
    // allowlist entirely) is not mistaken for this module's own wiring being intact.
    const missing = KNOWN_EXECUTOR_MODULES.filter((module) => !MANIFEST_BY_MODULE[module]);
    expect(missing).not.toContain("argo-workflows");
    expect(missing).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { manifest as argoWorkflowsManifest } from "@scp/plugin-argo-workflows";
import { MANIFEST_BY_MODULE, validatePluginConfig } from "./plugin-manifests.js";
import {
  KNOWN_EXECUTOR_MODULES,
  isKnownExecutorModule
} from "../coordination/executor-bindings-repo.js";

/** team-pipeline-iac increment 8. See docs/plugin-host.md §76. */
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

  // Unlike the managed ones, this is loaded in-process. See docs/plugin-host.md §77.
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

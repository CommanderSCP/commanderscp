import { describe, expect, it } from "vitest";
import { executionSystemPluginConfig } from "./executor-bindings-repo.js";
import { declaredConfigKeys } from "../plugin-host/plugin-manifests.js";

/** A system-backed binding's plugin config is DERIVED from the execution-system object, and for a
 *  long time that derivation was `{serverUrl, tokenSecretKey}` and nothing else — while the
 *  argo-workflows plugin requires `namespace` and puts it in every API path. The result was a
 *  submit to `/api/v1/workflows/undefined/submit`: no error at bind, no error at resolve. */

const ARGO_WF = {
  kind: "argo-workflows",
  serverUrl: "https://argo-server.scp-argo-workflows.svc:2746",
  namespace: "scp-argo-workflows",
  tokenSecretKey: "argo-workflows-token"
};

describe("executionSystemPluginConfig", () => {
  it("carries `namespace` — the key argo-workflows cannot build without", () => {
    expect(executionSystemPluginConfig(ARGO_WF, "argo-workflows")).toMatchObject({
      serverUrl: ARGO_WF.serverUrl,
      namespace: "scp-argo-workflows",
      tokenSecretKey: "argo-workflows-token"
    });
  });

  it("NEGATIVE CONTROL — the same input carries NO namespace for a module that declares none", () => {
    // Without this, the assertion above is satisfied by a derivation that copies every property
    // regardless of the module, which is precisely what must not happen.
    expect(declaredConfigKeys("argocd")).not.toContain("namespace");
    expect(executionSystemPluginConfig(ARGO_WF, "argocd")).not.toHaveProperty("namespace");
  });

  it("carries ONLY keys the module declares — a tenant cannot inject an undeclared one", () => {
    // execution-system `properties` are tenant-writable, so this intersection is the control that
    // keeps the derivation safe; without it any property name became a plugin config key.
    const config = executionSystemPluginConfig(
      { ...ARGO_WF, statePath: "/etc/shadow", runnerImage: "evil:latest" } as never,
      "argo-workflows"
    );
    expect(config).not.toHaveProperty("statePath");
    expect(config).not.toHaveProperty("runnerImage");
    expect(declaredConfigKeys("argo-workflows")).not.toContain("statePath");
  });

  it("always writes serverUrl from the system, so egress stays pinned to its own host", () => {
    const tenantTried = { ...ARGO_WF, serverUrl: "https://argo.example" };
    expect(executionSystemPluginConfig(tenantTried, "argo-workflows").serverUrl).toBe(
      "https://argo.example"
    );
    // ...and it is never absent, which is what `effectiveAllowedHosts` is derived from.
    expect(executionSystemPluginConfig(ARGO_WF, "argo-workflows")).toHaveProperty("serverUrl");
  });

  it("does NOT refuse modules whose required keys are per-BINDING (gitea, github, terraform)", () => {
    // REGRESSION PIN. An earlier draft ran `validatePluginConfig` on this derived config, which
    // refuses every gitea and github system-backed binding: this branch REPLACES the binding's own
    // config rather than merging it, and `gitea` requires owner/repo, `github` adds
    // appId/installationId, `terraform` and `pipeline-generic` require triggerUrl — none of which a
    // system object supplies. `executors.integration.test.ts`'s M15.1b gitea case caught it.
    for (const module of ["gitea", "github", "terraform", "pipeline-generic"]) {
      expect(() =>
        executionSystemPluginConfig({ serverUrl: "https://x.example", tokenSecretKey: "t" }, module)
      ).not.toThrow();
    }
  });

  it("nor a module that declares neither injected key (fake-executor)", () => {
    // `fake-executor` sets `additionalProperties: false` and declares neither `serverUrl` nor
    // `tokenSecretKey`, both of which this function injects regardless.
    const config = executionSystemPluginConfig(
      { serverUrl: "https://x.example", tokenSecretKey: "t" },
      "fake-executor"
    );
    expect(config).toMatchObject({ serverUrl: "https://x.example", tokenSecretKey: "t" });
  });
});

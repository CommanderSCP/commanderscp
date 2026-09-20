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

  it("KNOWN-POSITIVE CONTROL — without `namespace` it REFUSES, naming the key", () => {
    // Without this the tests around it pass against a derivation that validates nothing, which is
    // the exact shape of the original defect.
    const { namespace: _omitted, ...noNamespace } = ARGO_WF;
    let detail = "";
    try {
      executionSystemPluginConfig(noNamespace, "argo-workflows");
      throw new Error("expected a refusal");
    } catch (err) {
      detail = String((err as { detail?: string }).detail ?? err);
    }
    expect(detail).toMatch(/namespace/);
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
    const config = executionSystemPluginConfig(ARGO_WF, "argo-workflows");
    expect(config.serverUrl).toBe(ARGO_WF.serverUrl);
  });

  it("leaves argocd — the other system-backed module with a required key — satisfied", () => {
    // Regression guard: this derivation now validates on a path that previously had none, so every
    // executor module reachable by execution-system must still resolve.
    const argocd = { kind: "argocd", serverUrl: "https://argocd.example", tokenSecretKey: "t" };
    expect(() => executionSystemPluginConfig(argocd, "argocd")).not.toThrow();
  });

  it("does NOT refuse a module that declares neither injected key (fake-executor)", () => {
    // `fake-executor` sets `additionalProperties: false` and declares neither `serverUrl` nor
    // `tokenSecretKey`, both of which this function injects regardless. Validating the whole
    // config instead of the declared projection refuses it — breaking every Mode A binding that
    // uses it, which is how this was caught.
    const config = executionSystemPluginConfig(
      { serverUrl: "https://x.example", tokenSecretKey: "t" },
      "fake-executor"
    );
    expect(config).toMatchObject({ serverUrl: "https://x.example", tokenSecretKey: "t" });
  });
});

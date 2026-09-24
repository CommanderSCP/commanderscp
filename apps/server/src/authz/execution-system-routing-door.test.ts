import { describe, expect, it } from "vitest";
import {
  executionSystemPropertyDelta,
  executionSystemRoutingFingerprint,
  isLocallyAuthoredExecutionSystem
} from "./execution-system-routing-door.js";

const SYSTEM = {
  kind: "argo-workflows",
  serverUrl: "https://argo.example.invalid",
  namespace: "infra",
  tokenSecretKey: "argo-token"
};

describe("executionSystemPropertyDelta", () => {
  it("names every added, changed and removed key — and nothing for an unchanged re-send", () => {
    expect(executionSystemPropertyDelta(SYSTEM, { ...SYSTEM })).toEqual([]);
    expect(executionSystemPropertyDelta({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    const { namespace: _dropped, ...withoutNamespace } = SYSTEM;
    expect(
      executionSystemPropertyDelta(SYSTEM, {
        ...withoutNamespace,
        serverUrl: "https://argo.prod.invalid",
        webUrl: "https://x.invalid"
      })
    ).toEqual(["namespace", "serverUrl", "webUrl"]);
    // A create: every property is new.
    expect(executionSystemPropertyDelta({}, SYSTEM)).toEqual(Object.keys(SYSTEM).sort());
  });
});

describe("executionSystemRoutingFingerprint", () => {
  const fp = executionSystemRoutingFingerprint(SYSTEM);

  it("moves with EVERY property — the four that name the endpoint, and the ones a list omitted", () => {
    for (const [key, value] of [
      ["kind", "argocd"],
      ["serverUrl", "https://argo.prod.invalid"],
      ["namespace", "prod"],
      ["tokenSecretKey", "argo-prod-token"],
      // Omitted by the first, four-field version (the #415 verifier's NIT): each routes.
      ["webUrl", "https://registry.attacker.invalid"],
      ["allowInternalEgress", true],
      ["authoring", { project: "default" }],
      ["packageFormats", ["oci", "rpm"]],
      ["someManifestDeclaredKey", "x"]
    ] as const) {
      expect(executionSystemRoutingFingerprint({ ...SYSTEM, [key]: value }), key).not.toBe(fp);
    }
    const { namespace: _n, ...noNamespace } = SYSTEM;
    expect(executionSystemRoutingFingerprint(noNamespace)).not.toBe(fp);
  });

  it("does not move for a spelling of the same URL, or for key order", () => {
    expect(
      executionSystemRoutingFingerprint({ ...SYSTEM, serverUrl: "HTTPS://ARGO.example.invalid/" })
    ).toBe(fp);
    const reversed = Object.fromEntries(Object.entries(SYSTEM).reverse());
    expect(executionSystemRoutingFingerprint(reversed)).toBe(fp);
  });
});

describe("isLocallyAuthoredExecutionSystem", () => {
  it("is true only for a system this domain authored", () => {
    expect(isLocallyAuthoredExecutionSystem({ originDomainId: "d1" }, "d1")).toBe(true);
    expect(isLocallyAuthoredExecutionSystem({ originDomainId: "d2" }, "d1")).toBe(false);
  });
});

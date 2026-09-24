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

describe("executionSystemRoutingFingerprint — versions and URL spelling (#417 verification)", () => {
  it("v2 normalises EVERY URL-valued property, at any depth — `https://x` and `https://x/` are one value", () => {
    const withWeb = { ...SYSTEM, webUrl: "https://registry.example.invalid" };
    expect(
      executionSystemRoutingFingerprint({ ...withWeb, webUrl: "https://REGISTRY.example.invalid/" })
    ).toBe(executionSystemRoutingFingerprint(withWeb));
    expect(
      executionSystemRoutingFingerprint({ ...SYSTEM, authoring: { repoUrl: "https://git.x.invalid" } })
    ).toBe(
      executionSystemRoutingFingerprint({ ...SYSTEM, authoring: { repoUrl: "https://git.x.invalid/" } })
    );
    // …and a different URL is still a different value.
    expect(executionSystemRoutingFingerprint({ ...SYSTEM, webUrl: "https://other.invalid" })).not.toBe(
      executionSystemRoutingFingerprint(withWeb)
    );
  });

  it("v1 is #415's four-field fingerprint, kept so an existing row still verifies until re-set", () => {
    const v1 = executionSystemRoutingFingerprint(SYSTEM, 1);
    // Blind to the fields v1 never covered…
    expect(executionSystemRoutingFingerprint({ ...SYSTEM, webUrl: "https://x.invalid" }, 1)).toBe(v1);
    // …still bound to the four it did.
    expect(
      executionSystemRoutingFingerprint({ ...SYSTEM, serverUrl: "https://argo.prod.invalid" }, 1)
    ).not.toBe(v1);
    // And v1 and v2 are different functions (they coincide only on a system with exactly v1's four
    // fields): a v1 row is never checked under v2.
    const wider = { ...SYSTEM, allowInternalEgress: true };
    expect(executionSystemRoutingFingerprint(wider, 2)).not.toBe(
      executionSystemRoutingFingerprint(wider, 1)
    );
  });

  it("an UNKNOWN version never verifies (a row from a newer server fails closed)", () => {
    expect(executionSystemRoutingFingerprint(SYSTEM, 99)).toBe("unknown-fingerprint-version-99");
  });
});

describe("isLocallyAuthoredExecutionSystem", () => {
  it("is true only for a system this domain authored", () => {
    expect(isLocallyAuthoredExecutionSystem({ originDomainId: "d1" }, "d1")).toBe(true);
    expect(isLocallyAuthoredExecutionSystem({ originDomainId: "d2" }, "d1")).toBe(false);
  });
});

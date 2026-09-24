import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCP_OPS_TEMPLATE_PATTERN, normalizeOpsUrl } from "@scp/plugin-argo-workflows";
import { PokeRateLimiter } from "../federation/poke-rate-limit.js";
import {
  ArgoOpsPinInvalid,
  OPS_ARGO_CATALOG_TEMPLATES,
  normalizeServerUrl,
  validateArgoOpsPin,
  type ArgoOpsPinInput
} from "./ops-argo-pin.js";
import { ARGO_OPS_DELIVERY_KEYS } from "./ops-run-redemption.js";
import {
  OPS_RUN_ID_PARAMETER,
  OPS_RUN_TOKEN_SEALED_PARAMETER
} from "./ops-lane-trigger-parameters.js";
import { RESERVED_BY_LANE } from "./reserved-trigger-parameters.js";

/** The Argo host-ops pin's write-time validation (M28.2 fix round, ADR-0054 D9). An unusable pin is
 *  refused at the DOOR, so it can never be the reason a run is refused later. */
describe("the Argo host-ops pin", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 3072 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const good: ArgoOpsPinInput = {
    serverUrl: "https://Argo.Example.test/",
    namespace: "scp-argo-workflows",
    templateRef: "scp-ops-v1",
    sealingPublicKey: rsa,
    sourceAddresses: ["10.42.0.0/16"],
    runnerImageDigest: `sha256:${"a".repeat(64)}`,
    redeemUrl: "http://commanderscp-api.scp.svc:8080"
  };

  it("accepts a good pin and NORMALISES its server URL (so a trailing slash or case cannot defeat the match)", () => {
    expect(validateArgoOpsPin(good).serverUrl).toBe("https://argo.example.test");
    expect(normalizeServerUrl("https://argo.example.test")).toBe(
      normalizeServerUrl("HTTPS://ARGO.example.test/")
    );
    expect(normalizeServerUrl("https://evil.example.test")).not.toBe(
      normalizeServerUrl("https://argo.example.test")
    );
  });

  it.each([
    [
      "a weak sealing key",
      {
        sealingPublicKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .publicKey.export({ type: "spki", format: "pem" })
          .toString()
      },
      /at least 3072/
    ],
    [
      "a non-RSA sealing key",
      {
        sealingPublicKey: generateKeyPairSync("ed25519")
          .publicKey.export({ type: "spki", format: "pem" })
          .toString()
      },
      /RSA/
    ],
    ["NO source addresses (they are mandatory)", { sourceAddresses: [] }, /non-empty/],
    ["a source address that is not one", { sourceAddresses: ["everywhere"] }, /not an address/],
    ["a digest that is not sha256", { runnerImageDigest: "latest" }, /sha256/],
    ["a template that is not SCP's", { templateRef: "org-own-template" }, /catalog templates/],
    ["a non-http server", { serverUrl: "file:///etc/passwd" }, /http/],
    ["a namespace that is not one", { namespace: "Not_A_Namespace" }, /namespace/],
    ["a redeem URL that is not http(s)", { redeemUrl: "ftp://x" }, /redeemUrl/]
  ] as const)("REFUSES %s at write time", (_label, patch, message) => {
    expect(() => validateArgoOpsPin({ ...good, ...patch } as ArgoOpsPinInput)).toThrow(
      ArgoOpsPinInvalid
    );
    expect(() => validateArgoOpsPin({ ...good, ...patch } as ArgoOpsPinInput)).toThrow(message);
  });

  it("the server's and the plugin's URL normalisation are the SAME function (the pin match and the plugin's own-endpoint match cannot disagree)", () => {
    for (const u of [
      "https://Argo.Example.test/",
      "https://argo.example.test:8443/prefix/",
      "http://10.0.0.1:2746",
      "https://argo.example.test/a//",
      "file:///etc/passwd",
      "not a url"
    ]) {
      expect(normalizeOpsUrl(u)).toBe(normalizeServerUrl(u));
    }
    // The path is kept (a reverse-proxied prefix IS a different endpoint), as the comment says.
    expect(normalizeServerUrl("https://h/argo")).not.toBe(normalizeServerUrl("https://h/other"));
  });

  it("the server's catalog templates are exactly the ones the argo-workflows plugin read-back-checks", () => {
    // Two spellings of one set: if the server pinned a template the plugin did not check, the
    // read-back would silently not run for it.
    for (const t of OPS_ARGO_CATALOG_TEMPLATES) expect(SCP_OPS_TEMPLATE_PATTERN.test(t)).toBe(true);
    expect(SCP_OPS_TEMPLATE_PATTERN.test("scp-build-image-v1")).toBe(false);
  });
});

describe("the Argo delivery keys are ONE set, and reserved", () => {
  it("the lane's constants, the redemption module's list and RESERVED_BY_LANE['ops-argo'] agree", () => {
    const lane = [OPS_RUN_TOKEN_SEALED_PARAMETER, OPS_RUN_ID_PARAMETER].sort();
    expect([...ARGO_OPS_DELIVERY_KEYS].sort()).toEqual(lane);
    expect([...RESERVED_BY_LANE["ops-argo"]!.keys].sort()).toEqual(lane);
  });
});

describe("the redeem door's rate limiter is BOUNDED", () => {
  it("holds at most maxKeys buckets, evicting the oldest, and still limits a key it holds", () => {
    let now = 0;
    const limiter = new PokeRateLimiter({
      capacity: 1,
      refillIntervalMs: 60_000,
      maxKeys: 3,
      now: () => now
    });
    for (let i = 0; i < 100; i++) limiter.tryConsume(`10.0.0.${i}`);
    expect(limiter.size).toBe(3);
    expect(limiter.tryConsume("10.0.0.99")).toBe(false);
    now += 1;
    expect(limiter.size).toBe(3);
  });
});

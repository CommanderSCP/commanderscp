import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifierForSourceKind } from "./webhook-signature.js";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";

/**
 * Server webhook ADAPTER REGISTRY (M15.1b). Proves the census point that MATTERS: an inbound webhook
 * resolves its verifier + event-hint mapper by `sourceKind` through the registry, so github keeps its
 * exact behavior AND gitea (which signs and names its event header differently) resolves its OWN
 * scheme — a miss here is a silent event drop. These are pure-function unit tests (no DB/Docker).
 */

const rawBody = Buffer.from(JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40) }));
const secret = "shared-webhook-secret";

const githubSig = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
const bareHexSig = createHmac("sha256", secret).update(rawBody).digest("hex");

describe("verifierForSourceKind — resolves the right provider verifier via the registry", () => {
  it("github resolves the sha256=<hex> verifier on x-hub-signature-256 (behavior preserved)", () => {
    const v = verifierForSourceKind("github");
    expect(v.headerName).toBe("x-hub-signature-256");
    expect(v.verify(rawBody, githubSig, secret)).toBe(true);
    expect(v.verify(rawBody, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
  });

  it("gitea resolves the BARE-HEX verifier on x-gitea-signature", () => {
    const v = verifierForSourceKind("gitea");
    expect(v.headerName).toBe("x-gitea-signature");
    expect(v.verify(rawBody, bareHexSig, secret)).toBe(true);
  });

  it("cross-provider isolation: gitea's verifier REJECTS a github-style sha256=-prefixed signature, and github's REJECTS a bare-hex one — the concrete silent-drop hazard the registry prevents", () => {
    // Same HMAC bytes, different framing: each provider must accept only ITS OWN framing.
    expect(verifierForSourceKind("gitea").verify(rawBody, githubSig, secret)).toBe(false);
    expect(verifierForSourceKind("github").verify(rawBody, bareHexSig, secret)).toBe(false);
  });

  it("a source kind with no provider adapter (terraform) falls back to the generic sha256=<hex> verifier on x-scp-signature-256", () => {
    const v = verifierForSourceKind("terraform");
    expect(v.headerName).toBe("x-scp-signature-256");
    expect(v.verify(rawBody, githubSig, secret)).toBe(true); // generic scheme is sha256=<hex>
  });
});

describe("webhookAdapterForSourceKind — event-hint mapping routes to the right provider", () => {
  it("github maps a push event (regression) and reads its event from x-github-event", () => {
    const adapter = webhookAdapterForSourceKind("github");
    expect(adapter?.eventHeaderName).toBe("x-github-event");
    const hint = adapter?.mapEvent("push", {
      ref: "refs/heads/main",
      head_commit: { id: "1".repeat(40) },
      repository: { full_name: "acme/widgets" }
    });
    expect(hint).toMatchObject({ repo: "acme/widgets", commitSha: "1".repeat(40) });
  });

  it("gitea maps a package event to artifactDigest and reads its event from x-gitea-event", () => {
    const adapter = webhookAdapterForSourceKind("gitea");
    expect(adapter?.eventHeaderName).toBe("x-gitea-event");
    const digest = "sha256:" + "ab".repeat(32);
    const hint = adapter?.mapEvent("package", {
      repository: { full_name: "acme/widgets" },
      package: { name: "widgets", version: digest, type: "container" }
    });
    expect(hint).toMatchObject({ repo: "acme/widgets", artifactDigest: digest });
  });

  it("returns undefined for a source kind with no provider adapter", () => {
    expect(webhookAdapterForSourceKind("terraform")).toBeUndefined();
    expect(webhookAdapterForSourceKind("argocd")).toBeUndefined();
  });
});

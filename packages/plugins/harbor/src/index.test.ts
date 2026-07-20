import { describe, expect, it } from "vitest";
import { harborWebhookSource, mapHarborWebhookEventToHint } from "./index.js";

/**
 * `@scp/plugin-harbor` unit suite (M15.3c). Pure-function tests over Harbor's DOCUMENTED
 * `PUSH_ARTIFACT` webhook payload shape — no DB, no Docker, no network (CLAUDE.md: "Tests never
 * touch the internet"). Proves the one thing this webhook-source package owns: a Harbor image push
 * becomes a `{ repo, artifactDigest }` correlation hint, and every other event type is ignored
 * cleanly (null, never a throw, never a mis-map).
 */

const digest = "sha256:" + "ab".repeat(32);

/** A realistic Harbor PUSH_ARTIFACT delivery (Harbor's documented webhook contract). */
const pushArtifactPayload = {
  type: "PUSH_ARTIFACT",
  occur_at: 1_700_000_000,
  operator: "robot$ci",
  event_data: {
    resources: [
      {
        digest,
        tag: "v1.4.2",
        resource_url: "harbor.example.com/acme/widgets:v1.4.2"
      }
    ],
    repository: {
      name: "widgets",
      namespace: "acme",
      repo_full_name: "acme/widgets",
      repo_type: "private"
    }
  }
};

describe("mapHarborWebhookEventToHint — PUSH_ARTIFACT → { repo, artifactDigest }", () => {
  it("maps a PUSH_ARTIFACT push to the repo full-name and the pushed image digest", () => {
    const hint = mapHarborWebhookEventToHint("PUSH_ARTIFACT", pushArtifactPayload);
    expect(hint).not.toBeNull();
    expect(hint).toMatchObject({
      repo: "acme/widgets",
      artifactDigest: digest
    });
  });

  it("folds the digest into a repo-scoped correlationKey for grouping (not a new correlation dimension)", () => {
    const hint = mapHarborWebhookEventToHint("PUSH_ARTIFACT", pushArtifactPayload);
    expect(hint?.correlationKey).toBe(`acme/widgets@${digest}`);
  });

  it("does NOT set a path — Harbor correlates on repo only via source_mappings", () => {
    const hint = mapHarborWebhookEventToHint("PUSH_ARTIFACT", pushArtifactPayload);
    expect(hint?.path).toBeUndefined();
  });

  it("SCANNING_COMPLETED is recognized-but-ignored (null) — its scan-gate feed is a NOTED M17.1 follow-on, not silently mis-mapped to a Change", () => {
    const scanPayload = {
      type: "SCANNING_COMPLETED",
      event_data: {
        repository: { repo_full_name: "acme/widgets" },
        resources: [{ digest, tag: "v1.4.2" }],
        scan_overview: { "application/vnd.security.vulnerability.report; version=1.1": {} }
      }
    };
    expect(mapHarborWebhookEventToHint("SCANNING_COMPLETED", scanPayload)).toBeNull();
  });

  it("a non-mappable event type (DELETE_ARTIFACT) is ignored cleanly (null, never a throw)", () => {
    expect(
      mapHarborWebhookEventToHint("DELETE_ARTIFACT", {
        type: "DELETE_ARTIFACT",
        event_data: { repository: { repo_full_name: "acme/widgets" } }
      })
    ).toBeNull();
  });

  it("a PUSH_ARTIFACT carrying neither repo nor digest yields null rather than an empty, uncorrelatable hint", () => {
    expect(mapHarborWebhookEventToHint("PUSH_ARTIFACT", { type: "PUSH_ARTIFACT", event_data: {} })).toBeNull();
    expect(mapHarborWebhookEventToHint("PUSH_ARTIFACT", {})).toBeNull();
    expect(mapHarborWebhookEventToHint("PUSH_ARTIFACT", null)).toBeNull();
  });

  it("tolerates a repo-only push (digest missing) — still correlatable on repo", () => {
    const hint = mapHarborWebhookEventToHint("PUSH_ARTIFACT", {
      type: "PUSH_ARTIFACT",
      event_data: { repository: { repo_full_name: "acme/widgets" }, resources: [{ tag: "latest" }] }
    });
    expect(hint).toMatchObject({ repo: "acme/widgets" });
    expect(hint?.artifactDigest).toBeUndefined();
    expect(hint?.correlationKey).toBe("acme/widgets");
  });
});

describe("harborWebhookSource descriptor", () => {
  it("identifies as the open 'harbor' sourceKind and exposes mapEvent (no verify, no eventHeaderName — a passive webhook store)", () => {
    expect(harborWebhookSource.sourceKind).toBe("harbor");
    expect(typeof harborWebhookSource.mapEvent).toBe("function");
    // The descriptor is deliberately mapEvent-only — no verify / trigger / observe surface.
    expect(Object.keys(harborWebhookSource).sort()).toEqual(["mapEvent", "sourceKind"]);
  });
});

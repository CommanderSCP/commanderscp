import { describe, expect, it } from "vitest";
import { canonicalizeSourceRef, extractHint } from "./webhook-processor.js";

/**
 * M17.2 unit — the CANONICALIZATION seam of ingress: what a delivery body turns into on the
 * proposed Change's `sourceRef`.
 *
 * Two things are pinned here.
 *
 * 1. SBOM REFERENCE (ADR-0015 §5). SCP never generates, signs, or stores an SBOM DOCUMENT — the
 *    executor's coordinated Trivy pass emits it at build and cosign-signs it at origin. What lands
 *    on the change is a REFERENCE ONLY: `{format, digest, location, signatureRef, …}`. There is no
 *    bytes path in this codebase to test, by design.
 *
 * 2. The `artifactDigest` CANONICALIZATION FIX. The typed first-party report body sends a flat
 *    camelCase `artifactDigest`; before M17.2 the generic hint never read it, so it was never lifted
 *    to the documented canonical `sourceRef.artifact_digest` key and survived only because two
 *    downstream readers happen to also accept the camelCase spelling. Now it is lifted properly —
 *    and, critically, the RAW key is still preserved verbatim alongside it (DESIGN §8), so nothing
 *    that read the old spelling regresses.
 */
describe("canonicalizeSourceRef: the report body's supply-chain fields become canonical sourceRef keys", () => {
  const SBOM_DIGEST = "sha256:" + "1c".repeat(32);
  const ARTIFACT_DIGEST = "sha256:" + "ab".repeat(32);

  const reportBody = {
    repo: "acme/api",
    correlationKey: "release-42",
    status: "applied",
    artifactDigest: ARTIFACT_DIGEST,
    sbom: {
      format: "cyclonedx",
      specVersion: "1.5",
      digest: SBOM_DIGEST,
      location: "registry.test/acme/api@sha256:" + "1c".repeat(32),
      mediaType: "application/vnd.cyclonedx+json",
      signatureRef: "registry.test/acme/api:sha256-" + "1c".repeat(32) + ".sig",
      scanner: "trivy",
      scannerVersion: "0.58.1",
      generatedAt: "2026-07-20T10:00:00.000Z"
    }
  };

  it("lifts the SBOM REFERENCE to sourceRef.sbom — reference fields only, never a document", () => {
    // `terraform` resolves no webhook adapter, so this is exactly the generic first-party path the
    // typed report route feeds.
    const hint = extractHint("terraform", {}, reportBody);
    const sourceRef = canonicalizeSourceRef(reportBody, hint);

    expect(sourceRef.sbom).toEqual({
      format: "cyclonedx",
      specVersion: "1.5",
      digest: SBOM_DIGEST,
      location: "registry.test/acme/api@sha256:" + "1c".repeat(32),
      mediaType: "application/vnd.cyclonedx+json",
      signatureRef: "registry.test/acme/api:sha256-" + "1c".repeat(32) + ".sig",
      scanner: "trivy",
      scannerVersion: "0.58.1",
      generatedAt: "2026-07-20T10:00:00.000Z"
    });
    // No document, no bytes, no base64 blob — a reference is a set of strings and nothing else.
    const keys = Object.keys(sourceRef.sbom as Record<string, unknown>);
    expect(keys).not.toContain("document");
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("bytes");
  });

  it("CLOSES the latent gap: the flat report body's artifactDigest is lifted to canonical sourceRef.artifact_digest — and the raw key is still preserved verbatim", () => {
    const hint = extractHint("terraform", {}, reportBody);
    expect(hint.artifactDigest).toBe(ARTIFACT_DIGEST);

    const sourceRef = canonicalizeSourceRef(reportBody, hint);
    expect(sourceRef.artifact_digest).toBe(ARTIFACT_DIGEST);
    // DESIGN §8 verbatim-payload promise: the original camelCase key is NOT rewritten away, so any
    // reader still on the legacy spelling (promotion-repo / gate-orchestrator fallbacks) is intact.
    expect(sourceRef.artifactDigest).toBe(ARTIFACT_DIGEST);
    expect(sourceRef.repo).toBe("acme/api");
    expect(sourceRef.status).toBe("applied");
  });

  it("normalizes the SBOM document digest to sha256:<lowercase-hex> (same normalization the scan control applies), so references compare byte-for-byte", () => {
    const upper = { ...reportBody, sbom: { ...reportBody.sbom, digest: "SHA256:" + "1C".repeat(32) } };
    const sourceRef = canonicalizeSourceRef(upper, extractHint("terraform", {}, upper));
    expect((sourceRef.sbom as { digest: string }).digest).toBe(SBOM_DIGEST);
  });

  it("a report WITHOUT an sbom still works — the field is optional and no empty sbom key is invented", () => {
    const noSbom = { repo: "acme/api", status: "applied", artifactDigest: ARTIFACT_DIGEST };
    const sourceRef = canonicalizeSourceRef(noSbom, extractHint("terraform", {}, noSbom));
    expect("sbom" in sourceRef).toBe(false);
    expect(sourceRef.artifact_digest).toBe(ARTIFACT_DIGEST);
  });

  it("a plain git push (no digest, no sbom) is passed through byte-identical — nothing invented", () => {
    const push = { repo: "acme/api", correlationKey: "refs/heads/main" };
    const sourceRef = canonicalizeSourceRef(push, extractHint("terraform", {}, push));
    expect(sourceRef).toEqual(push);
  });

  it("a MALFORMED sbom reference is dropped rather than throwing — ingress must not wedge on one bad supply-chain field, and the raw payload is still preserved for forensics", () => {
    // `digest` is a tag, not a sha256 digest -> the reference cannot be bound to anything.
    const bad = { repo: "acme/api", status: "applied", sbom: { format: "cyclonedx", digest: "v1.2.3", location: "x" } };
    const hint = extractHint("terraform", {}, bad);
    // No TYPED reference is minted from it...
    expect(hint.sbom).toBeUndefined();
    const sourceRef = canonicalizeSourceRef(bad, hint);
    // ...and nothing throws. `sourceRef.sbom` is left UNSET so the M17.3 contract ("sbom, when
    // present, IS a valid reference") holds, while the raw value is quarantined under
    // `sbom_invalid` — auditable (DESIGN §8) but unmistakable for an attested reference.
    expect(sourceRef.sbom).toBeUndefined();
    expect(sourceRef.sbom_invalid).toEqual(bad.sbom);
    expect(sourceRef.repo).toBe("acme/api");
  });

  it("a harbor PUSH_ARTIFACT (provider adapter path) still canonicalizes its digest and carries no sbom — provider payloads have none", () => {
    const digest = "sha256:" + "cd".repeat(32);
    const payload = {
      type: "PUSH_ARTIFACT",
      event_data: {
        resources: [{ digest, tag: "v1" }],
        repository: { repo_full_name: "acme/api" }
      }
    };
    const hint = extractHint("harbor", {}, payload);
    const sourceRef = canonicalizeSourceRef(payload, hint);
    expect(sourceRef.artifact_digest).toBe(digest);
    expect(sourceRef.sbom).toBeUndefined();
  });
});

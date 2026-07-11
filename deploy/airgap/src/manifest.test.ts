import { describe, expect, it } from "vitest";
import { buildManifest, parseManifestJson, renderManifestJson, renderManifestSh } from "./manifest.js";
import type { BundleImage } from "./types.js";

const IMAGES: BundleImage[] = [
  { name: "scpd", sourceRef: "scp:dev", sourceType: "docker-daemon", ociPath: "images/scpd", ociTag: "1.0.0-rc", manifestDigest: "sha256:" + "a".repeat(64) },
  { name: "scp-runner-iac", sourceRef: "scp-runner-iac:dev", sourceType: "docker-daemon", ociPath: "images/scp-runner-iac", ociTag: "1.0.0-rc", manifestDigest: "sha256:" + "b".repeat(64) },
  { name: "postgres-eval", sourceRef: "postgres:16", sourceType: "docker-daemon", ociPath: "images/postgres-eval", ociTag: "1.0.0-rc", manifestDigest: "sha256:" + "c".repeat(64) }
];

describe("manifest.json render/parse round-trip", () => {
  it("round-trips exactly", () => {
    const manifest = buildManifest(IMAGES, "1.0.0-rc", "2026-07-11T00:00:00.000Z");
    const parsed = parseManifestJson(renderManifestJson(manifest));
    expect(parsed).toEqual(manifest);
  });

  it("rejects a manifest missing required fields", () => {
    expect(() => parseManifestJson(JSON.stringify({ foo: "bar" }))).toThrow(/not a valid bundle manifest/);
  });
});

describe("manifest.sh — the shell-sourceable rendering install.sh relies on", () => {
  it("derives the exact shell variable stems install.sh's bash-side tr pipeline also derives", () => {
    const manifest = buildManifest(IMAGES, "1.0.0-rc", "2026-07-11T00:00:00.000Z");
    const sh = renderManifestSh(manifest);

    expect(sh).toContain(`BUNDLE_VERSION='1.0.0-rc'`);
    expect(sh).toContain(`BUNDLE_IMAGE_NAMES='scpd scp-runner-iac postgres-eval'`);

    // "scpd" -> SCPD, "scp-runner-iac" -> SCP_RUNNER_IAC, "postgres-eval" -> POSTGRES_EVAL —
    // exactly what install.sh's `printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c
    // 'A-Z0-9' '_'` pipeline produces (verified interactively against this repo's bash/tr; see
    // install.sh's own comment on the printf-vs-echo trailing-underscore pitfall).
    expect(sh).toContain(`SCPD_DIGEST='sha256:${"a".repeat(64)}'`);
    expect(sh).toContain(`SCP_RUNNER_IAC_DIGEST='sha256:${"b".repeat(64)}'`);
    expect(sh).toContain(`POSTGRES_EVAL_DIGEST='sha256:${"c".repeat(64)}'`);

    expect(sh).toContain(`SCPD_OCI_PATH='images/scpd'`);
    expect(sh).toContain(`SCPD_SOURCE_REF='scp:dev'`);
  });

  it("single-quotes values so the file is safe to `source`", () => {
    const manifest = buildManifest(
      [{ name: "scpd", sourceRef: "scp:dev", sourceType: "docker-daemon", ociPath: "images/scpd", ociTag: "1.0.0-rc", manifestDigest: "sha256:" + "a".repeat(64) }],
      "it's-a-test",
      "2026-07-11T00:00:00.000Z"
    );
    const sh = renderManifestSh(manifest);
    // A raw apostrophe must be escaped, not left to break out of the surrounding quotes.
    expect(sh).toContain(`BUNDLE_VERSION='it'\\''s-a-test'`);
  });
});

/**
 * The image index's transport is the vendored `skopeo` BINARY, not HTTP, so its fixtures are a fake
 * skopeo on disk rather than `nock` interceptors — but the documents it prints are the REAL ones:
 * `skopeo list-tags`'s `{"Repository":…,"Tags":[…]}` and `skopeo inspect`'s top-level `Digest`.
 * Nothing here reaches a network of any kind.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import { createOciIndexPlugin, ociRegistryHostOfCoordinate, ociIndexManifest } from "./index.js";

let scratch: string;

/** A fake skopeo: a shell script that branches on argv exactly as the real binary's two subcommands
 *  would, and exits non-zero with the real error TEXT for the failure cases. */
function writeFakeSkopeo(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function ctx(config: unknown): PluginContext {
  return {
    orgId: "org-test",
    scopeKey: "dependency-index",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        // The image index must never use ctx.http — its reach is the skopeo channel. If this ever
        // fires, a second registry mechanism has appeared.
        throw new Error("the OCI index must not use ctx.http");
      }
    },
    config
  };
}

const REAL_LIST_TAGS = JSON.stringify({
  Repository: "registry.internal/acme/base",
  // A REAL repository's tag set: semver, a variant flavour, a moving 2-component tag, a date stamp
  // and `latest`, all coexisting. None of them is filtered here — that is the server's job.
  Tags: ["3.18", "3.18.4", "3.19.0", "3.19.1", "3.19.1-alpine", "latest", "20240115"]
});

const REAL_INSPECT = JSON.stringify({
  Name: "registry.internal/acme/base",
  Digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  RepoTags: ["3.19.0", "3.19.1"],
  Architecture: "amd64",
  Os: "linux"
});

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "scp-oci-index-test-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const ALLOWED = ["registry.internal"];

describe("skopeo list-tags", () => {
  it("returns the registry's tag list VERBATIM — latest and date stamps included", async () => {
    const bin = writeFakeSkopeo(
      "skopeo-ok",
      `case "$1" in\n  list-tags) echo '${REAL_LIST_TAGS}';;\n  *) exit 1;;\nesac`
    );
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3.19" }
    );
    expect(result).toEqual({
      status: "available",
      versions: [
        { version: "3.18" },
        { version: "3.18.4" },
        { version: "3.19.0" },
        { version: "3.19.1" },
        { version: "3.19.1-alpine" },
        // `latest` and a date stamp survive this layer deliberately: skipping them HERE would put
        // the never-guess rule in a plugin instead of in the one server-side ranking place.
        { version: "latest" },
        { version: "20240115" }
      ]
    });
  });

  it("a repository skopeo does not know is unknown_coordinate, not unreachable", async () => {
    const bin = writeFakeSkopeo(
      "skopeo-404",
      `echo 'FATA[0000] Error listing repository tags: name unknown' >&2\nexit 1`
    );
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/gone", majorLine: "1" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unknown_coordinate" });
  });

  it("a credential refusal is unauthorized, not unreachable", async () => {
    const bin = writeFakeSkopeo(
      "skopeo-401",
      `echo 'FATA[0000] unauthorized: authentication required' >&2\nexit 1`
    );
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/private", majorLine: "1" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unauthorized" });
  });

  it("non-JSON output is malformed_response, never an empty tag set", async () => {
    const bin = writeFakeSkopeo("skopeo-garbage", `echo 'not json at all'`);
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "1" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "malformed_response" });
  });
});

describe("skopeo inspect — a mutable tag is not an identity", () => {
  it("resolves the head tag to its content digest", async () => {
    const bin = writeFakeSkopeo(
      "skopeo-inspect",
      `case "$1" in\n  inspect) echo '${REAL_INSPECT}';;\n  *) exit 1;;\nesac`
    );
    const result = await createOciIndexPlugin().resolveDigest(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", version: "3.19.1" }
    );
    expect(result).toEqual({
      status: "available",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    });
  });

  it("a digest that is not a well-formed sha256 is REFUSED rather than recorded", async () => {
    // Recording an unusable digest would make "the line is on 3.19.1" look like a statement about
    // bytes while being a statement about nothing.
    const bin = writeFakeSkopeo("skopeo-baddigest", `echo '{"Digest":"not-a-digest"}'`);
    const result = await createOciIndexPlugin().resolveDigest(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", version: "3.19.1" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "malformed_response" });
  });

  it("this is the ONLY index that reports a digest at all", () => {
    expect(createOciIndexPlugin().describeIndex()).toEqual({
      ecosystem: "oci",
      reportsDigest: true
    });
  });
});

describe("the fail-closed preconditions", () => {
  it("no injected skopeo ⇒ not_configured, never a PATH fallback", async () => {
    const result = await createOciIndexPlugin().listVersions(
      ctx({ allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "not_configured" });
  });

  it("a registry host outside the allowlist is refused BEFORE skopeo runs", async () => {
    // The fake here would SUCCEED if it were invoked; the assertion is that it is not.
    const bin = writeFakeSkopeo("skopeo-never", `echo '${REAL_LIST_TAGS}'`);
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ["other.internal"] }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unreachable" });
    if (result.status !== "unavailable") throw new Error("unreachable");
    expect(result.detail).toMatch(/SCP_ARTIFACT_OCI_REGISTRY_HOSTS/);
    // HAZARD 3b: on a chart-deployed instance the FIRST cause is the default-deny NetworkPolicy,
    // and an operator must read that here rather than infer it.
    expect(result.detail).toMatch(/DEFAULT-DENY egress NetworkPolicy/);
    expect(result.detail).toMatch(/executorEgress/);
  });

  it("an empty allowlist reaches nothing (fail-closed), which is the air-gap DEFAULT-OFF shape", async () => {
    const bin = writeFakeSkopeo("skopeo-never-2", `echo '${REAL_LIST_TAGS}'`);
    const result = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: [] }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3" }
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "unreachable" });
  });

  it("an implicit Docker Hub coordinate is refused, because it cannot be allowlist-checked", async () => {
    const bin = writeFakeSkopeo("skopeo-never-3", `echo '${REAL_LIST_TAGS}'`);
    for (const coordinate of ["alpine", "library/alpine"]) {
      const result = await createOciIndexPlugin().listVersions(
        ctx({ skopeoBinary: bin, allowedRegistryHosts: ["docker.io"] }),
        { ecosystem: "oci", coordinate, majorLine: "3" }
      );
      expect(result).toMatchObject({ status: "unavailable", reason: "unknown_coordinate" });
    }
    // NEGATIVE CONTROL: the same rule ACCEPTS every registry-qualified spelling, so the refusal
    // above is about the missing host and not about coordinates generally.
    expect(ociRegistryHostOfCoordinate("docker.io/library/alpine")).toBe("docker.io");
    expect(ociRegistryHostOfCoordinate("localhost:5000/acme/base")).toBe("localhost:5000");
    expect(ociRegistryHostOfCoordinate("ghcr.io/CommanderSCP/base")).toBe("ghcr.io");
    expect(ociRegistryHostOfCoordinate("alpine")).toBeNull();
  });

  it("--tls-verify=false is passed ONLY for an operator-named insecure host", async () => {
    // The fake echoes its own argv so the flag set is observable.
    const bin = writeFakeSkopeo(
      "skopeo-argv",
      `echo "{\\"Repository\\":\\"r\\",\\"Tags\\":[\\"$*\\"]}"`
    );
    const secure = await createOciIndexPlugin().listVersions(
      ctx({ skopeoBinary: bin, allowedRegistryHosts: ALLOWED }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3" }
    );
    expect(secure).toMatchObject({ status: "available" });
    if (secure.status !== "available") throw new Error("unreachable");
    expect(secure.versions[0]?.version).not.toMatch(/tls-verify/);

    const insecure = await createOciIndexPlugin().listVersions(
      ctx({
        skopeoBinary: bin,
        allowedRegistryHosts: ALLOWED,
        insecureRegistryHosts: ["registry.internal"]
      }),
      { ecosystem: "oci", coordinate: "registry.internal/acme/base", majorLine: "3" }
    );
    if (insecure.status !== "available") throw new Error("unreachable");
    expect(insecure.versions[0]?.version).toMatch(/--tls-verify=false/);
  });
});

describe("the manifest keeps the server-governed keys unrepresentable", () => {
  it("configSchema admits timeoutMs only", () => {
    // `additionalProperties: false` with neither `skopeoBinary` nor `allowedRegistryHosts` listed is
    // what makes a tenant binding unable to choose the binary or widen the allowlist — the same
    // shape `managed-scan`'s manifest uses for `runnerImage`/`networkMode`.
    expect(ociIndexManifest.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { timeoutMs: { type: "number" } }
    });
    expect(ociIndexManifest.kind).toBe("dependency-index");
  });
});

describe("the fake skopeo harness is real", () => {
  it("executes as a program (so a passing fixture is not a mocked no-op)", () => {
    const bin = writeFakeSkopeo("skopeo-selfcheck", `echo 'harness-live'`);
    expect(execFileSync(bin, ["list-tags"], { encoding: "utf8" }).trim()).toBe("harness-live");
  });
});

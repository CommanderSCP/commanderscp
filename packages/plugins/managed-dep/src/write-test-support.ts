import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import type { ManifestBumpSpec } from "./bump-edit.js";
import { verifyManifestOnlyEdit, type ManifestEditProof } from "./write-guard.js";

/**
 * Shared fixtures for the write path's suites — the same convention `@scp/plugin-github` uses
 * (`github-test-support.ts`), for the same reason: the traversal MATRIX and the wire suite must
 * exercise the identical fixture, or a refusal proven in one could be absent from the other and both
 * would still be green.
 *
 * Nothing here fakes a refusal or hand-builds a proof. {@link realProof} runs the REAL verifier, so
 * a test that needs a valid proof cannot get one for content the verifier would refuse.
 */

/** A genuine npm manifest and a genuine one-declared-version bump of it. */
export const PACKAGE_JSON_BASE = [
  "{",
  '  "name": "widget",',
  '  "version": "0.1.0",',
  '  "dependencies": {',
  '    "@acme/lib": "^1.2.3"',
  "  }",
  "}",
  ""
].join("\n");

export const PACKAGE_JSON_BUMPED = PACKAGE_JSON_BASE.replace("^1.2.3", "^1.4.0");

export const BUMP_SPEC: ManifestBumpSpec = {
  ecosystem: "npm",
  coordinate: "@acme/lib",
  manifestPath: "package.json",
  fromVersion: "^1.2.3",
  toVersion: "^1.4.0"
};

export const DECLARED_MANIFEST_PATHS = ["package.json"];

/** A proof MINTED BY THE REAL VERIFIER for {@link PACKAGE_JSON_BUMPED}, never hand-built. */
export function realProof(): ManifestEditProof {
  return verifyManifestOnlyEdit({
    path: BUMP_SPEC.manifestPath,
    declaredManifestPaths: DECLARED_MANIFEST_PATHS,
    ecosystem: BUMP_SPEC.ecosystem,
    baseContent: PACKAGE_JSON_BASE,
    newContent: PACKAGE_JSON_BUMPED,
    coordinate: BUMP_SPEC.coordinate
  });
}

export const WRITE_TARGET = {
  repo: "acme/widget",
  baseBranch: "main",
  headBranch: "scp/dep-bump/c1"
};

export interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
  authorization?: string;
}

/**
 * A `PluginContext` whose http client RECORDS every request and answers from `handler`.
 *
 * `calls.length` is what the adversarial suites assert on, and that is deliberate: "zero HTTP" is
 * MEASURED, never inferred from an absent interceptor — a request can satisfy an absent interceptor
 * by failing for an unrelated reason, and on this provider the very first request of a run is the
 * App-JWT → installation-token exchange, so a counted zero also proves the refusal precedes AUTH.
 */
export function recordingCtx(handler: (req: ScopedHttpRequest) => ScopedHttpResponse): {
  ctx: PluginContext;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const ctx: PluginContext = {
    orgId: "org",
    scopeKey: "test",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async (req: ScopedHttpRequest) => {
        calls.push({
          method: req.method,
          url: req.url,
          body: req.body,
          authorization: (req.headers ?? {})["authorization"]
        });
        return handler(req);
      }
    },
    config: {}
  };
  return { ctx, calls };
}

/**
 * A GitHub arm that answers every request of a successful bump. `overrides` are matched as URL
 * substrings so a suite can turn one step of the sequence into any status it wants.
 */
export function githubHandler(
  overrides: Record<string, ScopedHttpResponse> = {}
): (req: ScopedHttpRequest) => ScopedHttpResponse {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  return (req: ScopedHttpRequest): ScopedHttpResponse => {
    for (const [fragment, response] of Object.entries(overrides)) {
      if (req.url.includes(fragment)) return response;
    }
    if (req.url.endsWith("/access_tokens")) {
      return {
        status: 201,
        headers: {},
        body: { token: "ghs_run_scoped", expires_at: "2026-08-15T12:00:00Z" }
      };
    }
    if (req.url.includes("/git/ref/heads/")) {
      return { status: 200, headers: {}, body: { object: { sha: "basesha" } } };
    }
    if (req.method === "POST" && req.url.endsWith("/git/refs")) {
      return { status: 201, headers: {}, body: {} };
    }
    if (req.method === "GET" && req.url.includes("/contents/")) {
      return {
        status: 200,
        headers: {},
        body: { content: b64(PACKAGE_JSON_BASE), encoding: "base64", sha: "blobsha" }
      };
    }
    if (req.method === "PUT" && req.url.includes("/contents/")) {
      return { status: 200, headers: {}, body: { commit: { sha: "newcommit" } } };
    }
    if (req.method === "POST" && req.url.endsWith("/pulls")) {
      return { status: 201, headers: {}, body: { number: 7, html_url: "https://x/pull/7" } };
    }
    if (req.method === "PUT" && req.url.includes("/pulls/7/merge")) {
      return { status: 200, headers: {}, body: { merged: true } };
    }
    if (req.method === "DELETE" && req.url.endsWith("/installation/token")) {
      return { status: 204, headers: {}, body: undefined };
    }
    return { status: 404, headers: {}, body: {} };
  };
}

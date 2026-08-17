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

/**
 * A chart's `values.yaml` in the SPLIT shape — the coordinate on one line, the version on the next,
 * and the same version text present three more times where it means something else. M21.7's
 * anchored path is the only way this file is editable at all.
 */
export const VALUES_YAML_BASE = [
  "global:",
  "  imageTag: 1.2.3",
  "api:",
  "  image:",
  "    repository: acme/api",
  "    tag: 1.2.3",
  "appVersion: 1.2.3",
  ""
].join("\n");

export const VALUES_YAML_PATH = "chart/values.yaml";

export const VALUES_BUMP_SPEC: ManifestBumpSpec = {
  ecosystem: "oci",
  coordinate: "acme/api",
  manifestPath: VALUES_YAML_PATH,
  fromVersion: "1.2.3",
  toVersion: "1.2.4"
};

/** A proof MINTED BY THE REAL VERIFIER for {@link PACKAGE_JSON_BUMPED}, never hand-built. */
export function realProof(): ManifestEditProof {
  return verifyManifestOnlyEdit({
    repo: WRITE_TARGET.repo,
    headBranch: WRITE_TARGET.headBranch,
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

/** The commit a governed control evidenced — the merge precondition every merge in this class
 *  carries. Full-length, because `assertWriteCommit` refuses anything shorter, and the reason it
 *  does is that an abbreviated value would never match a head and so would stop being a
 *  precondition at all. */
export const EVIDENCED_COMMIT = "a1b2c3d4".repeat(5);

/** The pull request CommanderSCP itself opened, as the SERVER recorded it. The merge is addressed to
 *  this number; the fixture below answers `GET /pulls/7` with a pull request whose head, base and
 *  state all agree with {@link WRITE_TARGET}, so a suite can contradict exactly one of them. */
export const AUTHORED_PULL_REQUEST = 7;

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
  overrides: Record<string, ScopedHttpResponse> = {},
  /** WHAT THE PROVIDER SAYS THE PULL REQUEST IS. Defaults to a pull request that agrees with
   *  {@link WRITE_TARGET} on every axis the merge path compares — open, from SCP's branch, into the
   *  granted base — so a suite states only the axis it is contradicting. It is a PARAMETER rather
   *  than a constant because the head branch is derived from the change id, and different suites
   *  merge different changes. */
  pullRequest: { state?: string; headRef?: string; baseRef?: string } = {},
  /** What a `GET /contents/…` answers with. Defaults to {@link PACKAGE_JSON_BASE}; a suite bumping a
   *  chart's `values.yaml` passes that instead. It is a parameter rather than an `overrides` entry
   *  because `overrides` matches on the URL alone and the contents READ and WRITE share one. */
  baseContent: string = PACKAGE_JSON_BASE
): (req: ScopedHttpRequest) => ScopedHttpResponse {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const pr = {
    number: AUTHORED_PULL_REQUEST,
    html_url: "https://x/pull/7",
    state: pullRequest.state ?? "open",
    head: { ref: pullRequest.headRef ?? WRITE_TARGET.headBranch },
    base: { ref: pullRequest.baseRef ?? WRITE_TARGET.baseBranch }
  };
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
        body: { content: b64(baseContent), encoding: "base64", sha: "blobsha" }
      };
    }
    if (req.method === "PUT" && req.url.includes("/contents/")) {
      return { status: 200, headers: {}, body: { commit: { sha: "newcommit" } } };
    }
    if (req.method === "POST" && req.url.endsWith("/pulls")) {
      return { status: 201, headers: {}, body: { number: 7, html_url: "https://x/pull/7" } };
    }
    // The open-pull-request lookup the DUPLICATE-PUBLISH path uses. It carries `head` and `base`
    // because the caller compares both: the provider's own query filters are treated as a narrowing,
    // never as a guarantee, so a fixture that omitted them would make the comparison unreachable.
    if (req.method === "GET" && req.url.includes("/pulls?state=open")) {
      return { status: 200, headers: {}, body: [pr] };
    }
    // THE MERGE'S OWN READ: one pull request, by the number the server recorded. Answered with the
    // shape the merge path compares against — an open pull request from SCP's branch into the base
    // the governed grant named.
    if (req.method === "GET" && /\/pulls\/\d+$/.test(req.url)) {
      return { status: 200, headers: {}, body: pr };
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

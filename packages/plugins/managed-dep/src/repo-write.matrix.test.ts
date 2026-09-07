import { describe, expect, it } from "vitest";
import { createGithubAppRepoWriter, type RepoSession } from "./repo-write.js";
import { isRepoWriteRefusal, type RepoWriteRefusalReason } from "./write-guard.js";
import { parseBumpDescriptor } from "./index.js";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BUMPED,
  WRITE_TARGET,
  githubHandler,
  realProof,
  recordingCtx
} from "./write-test-support.js";

/** The traversal census, on the one surviving write path. See docs/plugins.md §316. */

const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const writer = createGithubAppRepoWriter({
  appId: "12345",
  installationId: "67890",
  privateKeyPem
});

const TRAVERSAL_REF = "../../../../user";
const TRAVERSAL_REPO = "acme/widgets/../../..";
const TRAVERSAL_PATH = "a/../../../../etc/passwd";
/** Route TERMINATION — the second half of the M21.2 `repo` hole, which traversal alone misses. */
const QUERY_REPO = "acme/widgets?x=";

// Before the session exists: `repo` reaches the token-mint body AND every route below it

describe("withRunCredential — an adversarial repo is refused before the credential is minted", () => {
  it.each([
    { label: "traversal", repo: TRAVERSAL_REPO },
    { label: "query injection", repo: QUERY_REPO },
    { label: "a third segment", repo: "acme/widgets/extra" },
    { label: "an empty owner", repo: "/widgets" }
  ])("refuses a $label repo with ZERO requests issued", async ({ repo }) => {
    const { ctx, calls } = recordingCtx(githubHandler());
    let entered = false;
    await expect(
      writer.withRunCredential(ctx, repo, async () => {
        entered = true;
      })
    ).rejects.toMatchObject({ reason: "unsafe_repo" satisfies RepoWriteRefusalReason });
    // Not one request — not even the App-JWT exchange, which is the first thing a run does.
    expect(calls).toHaveLength(0);
    // ...and the caller's body never ran, so nothing downstream could have been reached either.
    expect(entered).toBe(false);
  });
});

// Inside the session: every remaining caller-supplied string, on every operation that splices one

interface SessionCase {
  label: string;
  reason: RepoWriteRefusalReason;
  call: (session: RepoSession) => Promise<unknown>;
}

/** One otherwise-valid publish, with a single field poisoned by the caller. */
function publishWith(
  session: RepoSession,
  overrides: {
    repo?: string;
    baseBranch?: string;
    headBranch?: string;
    manifestPath?: string;
    content?: string;
  }
): Promise<unknown> {
  const { repo, baseBranch, headBranch, manifestPath, content } = overrides;
  return session.publishBump({
    target: {
      repo: repo ?? WRITE_TARGET.repo,
      baseBranch: baseBranch ?? WRITE_TARGET.baseBranch,
      headBranch: headBranch ?? WRITE_TARGET.headBranch
    },
    spec: { ...BUMP_SPEC, manifestPath: manifestPath ?? BUMP_SPEC.manifestPath },
    content: content ?? PACKAGE_JSON_BUMPED,
    // A GENUINE proof for the unmutated bytes, always. A case that poisons `content` therefore also
    // proves the proof stops travelling with it — which is the whole design.
    proof: realProof(),
    delivery: "pull_request"
  });
}

const SESSION_MATRIX: SessionCase[] = [
  // --- readFile: both of its strings reach the route/query -------------------------------
  {
    label: "readFile / path",
    reason: "unsafe_path",
    call: (s) => s.readFile(TRAVERSAL_PATH, "main")
  },
  {
    label: "readFile / ref",
    reason: "unsafe_base_ref",
    call: (s) => s.readFile("package.json", TRAVERSAL_REF)
  },
  // --- publishBump: four strings, each spliced into at least one of its five routes -------
  {
    label: "publishBump / target.repo",
    reason: "unsafe_repo",
    call: (s) => publishWith(s, { repo: TRAVERSAL_REPO })
  },
  {
    label: "publishBump / target.repo (query injection)",
    reason: "unsafe_repo",
    call: (s) => publishWith(s, { repo: QUERY_REPO })
  },
  {
    label: "publishBump / spec.manifestPath",
    reason: "unsafe_path",
    call: (s) => publishWith(s, { manifestPath: TRAVERSAL_PATH })
  },
  {
    label: "publishBump / target.baseBranch",
    reason: "unsafe_base_ref",
    call: (s) => publishWith(s, { baseBranch: TRAVERSAL_REF })
  },
  {
    label: "publishBump / target.headBranch",
    reason: "unsafe_branch",
    call: (s) => publishWith(s, { headBranch: TRAVERSAL_REF })
  },
  // --- the branch-name rules a ref in general does not have -------------------------------
  {
    label: "publishBump / a fully-qualified head branch",
    reason: "unsafe_branch",
    // The `refs/heads/` prefix is composed by the create-ref body; a supplied one would produce
    // `refs/heads/refs/heads/x`.
    call: (s) => publishWith(s, { headBranch: "refs/heads/main" })
  },
  {
    label: "publishBump / HEAD as a head branch",
    reason: "unsafe_branch",
    call: (s) => publishWith(s, { headBranch: "HEAD" })
  },
  {
    label: "publishBump / a head branch beginning with '-'",
    reason: "unsafe_branch",
    call: (s) => publishWith(s, { headBranch: "-upload-pack=x" })
  },
  // --- the refusal that keeps the class PROPOSING -----------------------------------------
  {
    label: "publishBump / the bump branch IS the base branch",
    reason: "branch_is_base_ref",
    call: (s) => publishWith(s, { headBranch: "main", baseBranch: "main" })
  },
  // --- the manifest-only proof --------------------------------------------------------------
  {
    label: "publishBump / content mutated after verification",
    reason: "proof_mismatch",
    // The whole reason the proof is HMAC-signed rather than a plain field: bytes changed after the
    // verifier agreed with them cannot reach the wire. This exact payload — a legitimate bump plus
    // an appended dependency — is what the guard exists to stop.
    call: (s) =>
      publishWith(s, {
        content: PACKAGE_JSON_BUMPED.replace(
          '"@acme/lib": "^1.4.0"',
          '"@acme/lib": "^1.4.0", "evil": "1.0.0"'
        )
      })
  }
];

describe("the session's write operations REFUSE adversarial strings before issuing a request", () => {
  it.each(SESSION_MATRIX)(
    "$label — refused with ZERO further requests",
    async ({ reason, call }) => {
      const { ctx, calls } = recordingCtx(githubHandler());
      await writer.withRunCredential(ctx, WRITE_TARGET.repo, async (session) => {
        // The delta across the refusing call is the measurement: the session's own mint already
        // happened and its revoke has not, and neither is what this test is about.
        const before = calls.length;
        await expect(call(session)).rejects.toMatchObject({ reason });
        expect(calls.length - before, `${reason} issued a request before refusing`).toBe(0);
      });
    }
  );

  it("a refusal is a RepoWriteRefusal carrying a reason, not an anonymous Error", async () => {
    const { ctx } = recordingCtx(githubHandler());
    let caught: unknown;
    await writer.withRunCredential(ctx, WRITE_TARGET.repo, async (session) => {
      try {
        await session.readFile(TRAVERSAL_PATH, "main");
      } catch (err) {
        caught = err;
      }
    });
    expect(isRepoWriteRefusal(caught)).toBe(true);
  });

  /** THE POSITIVE CONTROL. See docs/plugins.md §317. */
  it("the SAME fixture, unpoisoned, does reach the wire and open a pull request", async () => {
    const { ctx, calls } = recordingCtx(githubHandler());
    const result = await writer.withRunCredential(ctx, WRITE_TARGET.repo, (session) =>
      publishWith(session, {})
    );
    expect(result).toMatchObject({ pullRequestNumber: 7, merged: false });
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(true);
  });
});

// The descriptor half — the same strings, refused a second time, one layer earlier

/** The parser validates the same strings with the same asserts. See docs/plugins.md §318. */
function intentParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ecosystem: "npm",
    coordinate: "@acme/lib",
    manifestPath: "package.json",
    declaredManifestPaths: DECLARED_MANIFEST_PATHS,
    fromVersion: "^1.2.3",
    toVersion: "^1.4.0",
    repo: "acme/widget",
    baseBranch: "main",
    changeObjectId: "11111111-1111-4111-8111-111111111111",
    delivery: "pull_request",
    ...overrides
  };
}

describe("parseBumpDescriptor — the same census, one layer earlier", () => {
  it("accepts a well-formed descriptor (the positive control for every refusal below)", () => {
    const parsed = parseBumpDescriptor({ kind: "custom", parameters: intentParams() });
    expect(parsed.headBranch).toBe("scp/dep-bump/11111111-1111-4111-8111-111111111111");
    expect(parsed.declaredManifestPaths).toEqual(["package.json"]);
  });

  it.each([
    { label: "repo / traversal", overrides: { repo: TRAVERSAL_REPO }, reason: "unsafe_repo" },
    { label: "repo / query injection", overrides: { repo: QUERY_REPO }, reason: "unsafe_repo" },
    {
      label: "manifestPath / traversal",
      overrides: { manifestPath: TRAVERSAL_PATH, declaredManifestPaths: [TRAVERSAL_PATH] },
      reason: "unsafe_path"
    },
    {
      label: "baseBranch / traversal",
      overrides: { baseBranch: TRAVERSAL_REF },
      reason: "unsafe_base_ref"
    },
    {
      label: "declaredManifestPaths[] / traversal",
      overrides: { declaredManifestPaths: ["package.json", TRAVERSAL_PATH] },
      reason: "unsafe_path"
    }
  ])("refuses $label", ({ overrides, reason }) => {
    expect(() =>
      parseBumpDescriptor({ kind: "custom", parameters: intentParams(overrides) })
    ).toThrow(expect.objectContaining({ reason }));
  });

  it("REQUIRES declaredManifestPaths rather than defaulting it to the target — a default would make the check agree with itself", () => {
    const params = intentParams();
    delete params.declaredManifestPaths;
    expect(() => parseBumpDescriptor({ kind: "custom", parameters: params })).toThrow(
      /declaredManifestPaths is required/
    );
  });

  it("refuses a manifestPath the component does not declare", () => {
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: intentParams({ manifestPath: "other/package.json" })
      })
    ).toThrow(/not one of the manifest paths this component declares/);
  });
});

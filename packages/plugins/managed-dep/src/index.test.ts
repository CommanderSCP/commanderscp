import { beforeEach, describe, expect, it } from "vitest";
import {
  BUMP_BRANCH_PREFIX,
  CONTENT_BEARING_KEYS,
  __resetManagedDepOutcomes,
  bumpBranchFor,
  managedDepExecutorPlugin,
  parseBumpDescriptor,
  parseBumpMergeDescriptor,
  parseIntentAction
} from "./index.js";
import { resolveRepoWriter } from "./repo-write.js";
import { githubHandler, recordingCtx } from "./write-test-support.js";

// A throwaway RSA key, generated in-test, so no key material is committed and the JWT signing path
// is genuinely exercised rather than stubbed — same convention as `repo-write.test.ts`.
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const mergePrivateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/**
 * The orchestrator's REFUSALS, unit-tested. Everything here is reachable without Docker and without
 * a network, which is deliberate: these are the checks that decide whether a container is launched
 * or a repository is touched at all, so they must be provable in the layer that always runs.
 *
 * (The trigger()-through-a-container path needs the `scp-runner-dep` image, which this repository
 * does not build yet — see `index.ts`'s "WHAT THIS INCREMENT DOES NOT SHIP". The verifier that
 * stands between that container and the repository is fully covered in `bump-edit.test.ts`.)
 */

const goodParams = {
  ecosystem: "npm",
  coordinate: "@acme/lib",
  manifestPath: "package.json",
  // The manifest paths the component's own inventory declares. REQUIRED, never defaulted to the
  // target — see `parseBumpDescriptor`: a default would make the manifest-only verifier's
  // "must be a manifest the component already contains" gate agree with itself.
  declaredManifestPaths: ["package.json"],
  fromVersion: "^1.2.3",
  toVersion: "^1.4.0",
  repo: "acme/widget",
  baseBranch: "main",
  changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
  delivery: "pull_request"
};

describe("parseBumpDescriptor — what may be asked for", () => {
  it("accepts a well-formed descriptor and derives the branch from the change id", () => {
    const d = parseBumpDescriptor({ kind: "custom", parameters: goodParams });
    expect(d.headBranch).toBe(`${BUMP_BRANCH_PREFIX}${goodParams.changeObjectId}`);
    expect(d.spec.coordinate).toBe("@acme/lib");
    expect(d.delivery).toBe("pull_request");
  });

  it("REFUSES every content-bearing key — the channel ADR-0032 §9 forbids stays closed", () => {
    // Asserted over the exported list rather than a hand-picked example, so a key added to the list
    // without a refusal (or a refusal that stops covering a listed key) fails here.
    for (const key of CONTENT_BEARING_KEYS) {
      expect(() =>
        parseBumpDescriptor({
          kind: "custom",
          parameters: { ...goodParams, [key]: "anything at all" }
        })
      ).toThrow(new RegExp(`carries '${key}'`));
    }
  });

  it("names `sourceFiles` specifically — the field §9 calls out as NOT a precedent", () => {
    expect(CONTENT_BEARING_KEYS).toContain("sourceFiles");
  });

  /**
   * These three used to pin the prose of this file's OWN `isSafeManifestPath`/`isSafeRepo`/
   * `isSafeBranch` predicates. Those are gone: the descriptor is now validated with the SHARED
   * asserts (`write-guard.ts` → `@scp/git-provider-core`), the same ones the write itself re-applies
   * at the splice site. So the assertion moved to the structured REASON, which is both stronger than
   * a message match and no longer this file's wording to own. The inputs are unchanged, so a
   * refusal that stopped covering one of them still fails here.
   */
  it("refuses a manifest path that escapes the repository", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "a/../../b", "a\\b"]) {
      expect(
        () =>
          parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, manifestPath: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_path" }));
    }
  });

  it("refuses a repo that is not a plain owner/repo identity", () => {
    for (const bad of ["acme", "acme/widget/extra", "acme/wid get", "../acme/widget"]) {
      expect(
        () => parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, repo: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_repo" }));
    }
  });

  it("refuses a base branch that could smuggle a ref-spec or an option", () => {
    // `--force` is the case that proves `assertWriteBaseBranch` exists rather than plain
    // `assertWriteBaseRef`: a leading dash is legal in a REF and refused in a BRANCH.
    for (const bad of ["--force", "a..b", "a//b", "a b", "refs/heads/main", "HEAD"]) {
      expect(
        () =>
          parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, baseBranch: bad } }),
        bad
      ).toThrow(expect.objectContaining({ reason: "unsafe_base_ref" }));
    }
  });

  it("refuses a version token carrying a newline or a control character", () => {
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: { ...goodParams, toVersion: "^1.4.0\nrm -rf /" }
      })
    ).toThrow(/one token on one line/);
  });

  it("refuses a no-op bump", () => {
    expect(() =>
      parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, toVersion: "^1.2.3" } })
    ).toThrow(/there is no bump to author/);
  });

  it("refuses an unknown ecosystem rather than passing it to the runner", () => {
    expect(() =>
      parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, ecosystem: "cargo" } })
    ).toThrow(/unknown ecosystem 'cargo'/);
  });

  it("refuses a delivery outside the closed pair — an unrecognised value never means auto_merge", () => {
    for (const bad of [undefined, "", "AUTO_MERGE", "merge", true]) {
      expect(() =>
        parseBumpDescriptor({ kind: "custom", parameters: { ...goodParams, delivery: bad } })
      ).toThrow(/delivery must be/);
    }
  });

  it("refuses a change id that is not an object id — it becomes a branch name", () => {
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: { ...goodParams, changeObjectId: "../../evil" }
      })
    ).toThrow(/it becomes the branch name/);
  });
});

const EVIDENCED = "a1b2c3d4".repeat(5);
const mergeParams = {
  action: "merge",
  repo: "acme/widget",
  baseBranch: "main",
  changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
  expectedHeadCommit: EVIDENCED,
  // THE PULL REQUEST THE SERVER RECORDED SCP OPENING. Required: a merge intent that does not name
  // one did not come from the server's gate, and the alternative — searching for a pull request on
  // the head branch — lets provider list ordering decide what gets merged.
  pullRequestNumber: 7,
  delivery: "auto_merge"
};

describe("parseIntentAction — an unrecognised action never falls through to the one that writes", () => {
  it("defaults to bump when absent, so every intent built before the merge action keeps its meaning", () => {
    expect(parseIntentAction({ kind: "custom", parameters: goodParams })).toBe("bump");
    expect(parseIntentAction({ kind: "custom" })).toBe("bump");
  });

  it("reads an explicit action, and REFUSES anything else", () => {
    expect(parseIntentAction({ kind: "custom", parameters: mergeParams })).toBe("merge");
    for (const action of ["Merge", "push", "", 1, null]) {
      expect(() => parseIntentAction({ kind: "custom", parameters: { action } })).toThrow(
        /must be 'bump' or 'merge'/
      );
    }
  });
});

describe("parseBumpMergeDescriptor — the merge target is DERIVED, never supplied", () => {
  it("composes the head branch from the change id with the same function the authoring run used", () => {
    const d = parseBumpMergeDescriptor({ kind: "custom", parameters: mergeParams });
    expect(d.headBranch).toBe(bumpBranchFor(mergeParams.changeObjectId));
    expect(d.expectedHeadCommit).toBe(EVIDENCED);
  });

  it("IGNORES a caller-supplied branch entirely — there is no field for one to arrive in", () => {
    // The widening this closes: if a branch name could be passed, "merge the bump we authored"
    // becomes "merge whatever you are told to", and the change's own claim stops being the authority.
    const d = parseBumpMergeDescriptor({
      kind: "custom",
      parameters: { ...mergeParams, headBranch: "main", branch: "release/1.x" }
    });
    expect(d.headBranch).toBe(bumpBranchFor(mergeParams.changeObjectId));
  });

  it("REFUSES a merge with no full-length evidenced commit", () => {
    for (const expectedHeadCommit of [undefined, "", "a1b2c3d"]) {
      expect(() =>
        parseBumpMergeDescriptor({
          kind: "custom",
          parameters: { ...mergeParams, expectedHeadCommit }
        })
      ).toThrow(/expectedHeadCommit|full-length hex commit id/);
    }
  });

  it("REFUSES content-bearing keys on a merge too — the channel is closed per plugin, not per path", () => {
    for (const key of CONTENT_BEARING_KEYS) {
      expect(() =>
        parseBumpMergeDescriptor({
          kind: "custom",
          parameters: { ...mergeParams, [key]: "anything at all" }
        })
      ).toThrow(new RegExp(`carries '${key}'`));
    }
  });

  it("REFUSES a traversal repo and a change id that is not one", () => {
    expect(() =>
      parseBumpMergeDescriptor({
        kind: "custom",
        parameters: { ...mergeParams, repo: "acme/../../../user" }
      })
    ).toThrow(/refused/);
    expect(() =>
      parseBumpMergeDescriptor({
        kind: "custom",
        parameters: { ...mergeParams, changeObjectId: "../../evil" }
      })
    ).toThrow(/it becomes the branch name/);
  });

  it("REFUSES a merge intent that names no pull request — there is no fallback to searching", () => {
    // The number is the ADDRESS of the merge. Without it the only way to proceed is to list open
    // pull requests on the head branch and take one, which is how provider ordering — or a second
    // pull request somebody with write access opened from SCP's branch to a protected base —
    // decides what gets merged. A merge intent that carries none did not come from the server's
    // gate, so it is refused rather than completed by a search.
    for (const pullRequestNumber of [undefined, 0, -3, 2.5, "7"]) {
      expect(() =>
        parseBumpMergeDescriptor({
          kind: "custom",
          parameters: { ...mergeParams, pullRequestNumber }
        })
      ).toThrow(/pullRequestNumber must be a positive integer/);
    }
  });

  it("REFUSES a merge intent that asks for pull_request delivery — that is a contradiction", () => {
    expect(() =>
      parseBumpMergeDescriptor({
        kind: "custom",
        parameters: { ...mergeParams, delivery: "pull_request" }
      })
    ).toThrow(/a merge intent's delivery must be 'auto_merge'/);
  });
});

describe("parseBumpDescriptor — an auto_merge authoring intent must name the evidenced commit", () => {
  it("REFUSES auto_merge with no expectedHeadCommit", () => {
    // A grant that names no commit did not come from `resolveEffectiveDelivery`, which can only
    // grant on a control run whose evidence names the bump's own head.
    expect(() =>
      parseBumpDescriptor({
        kind: "custom",
        parameters: { ...goodParams, delivery: "auto_merge" }
      })
    ).toThrow(/expectedHeadCommit is required/);
  });

  it("accepts auto_merge WITH one, and carries it through to the publish", () => {
    const d = parseBumpDescriptor({
      kind: "custom",
      parameters: { ...goodParams, delivery: "auto_merge", expectedHeadCommit: EVIDENCED }
    });
    expect(d.expectedHeadCommit).toBe(EVIDENCED);
  });

  it("does not require one for pull_request delivery, which never merges", () => {
    expect(parseBumpDescriptor({ kind: "custom", parameters: goodParams }).expectedHeadCommit).toBe(
      undefined
    );
  });
});

describe("bumpBranchFor — the provenance contract's other half", () => {
  it("is deterministic, so a retry converges on one branch and one pull request", () => {
    expect(bumpBranchFor("abc")).toBe(bumpBranchFor("abc"));
    expect(bumpBranchFor("abc")).toBe("scp/dep-bump/abc");
  });
});

/**
 * ================================================================================================
 * `trigger()` ACTUALLY REACHES THE MERGE — the parser being right proves nothing about the verb
 * ================================================================================================
 * `parseBumpMergeDescriptor` and `mergeAuthoredBranch` could both be perfect while `trigger()` never
 * dispatched to them, which is M21's standing failure exactly. So this drives the REAL exported verb
 * with the REAL parameter object the server builds, against the recording http fixture — no Docker,
 * no workspace, no network — and asserts the provider call that came out the other end.
 *
 * That it needs no container is itself the property: a merge is not an edit, so the isolated runner
 * is not involved and `trigger()` must not touch the workspace on this path.
 */
describe("trigger() dispatches the merge action all the way to the provider", () => {
  beforeEach(() => __resetManagedDepOutcomes());

  /** The provider's description of the pull request THIS suite's merge intent names — its head is
   *  the branch `mergeParams.changeObjectId` composes, which is not the shared fixture's default. */
  const mergePullRequest = {
    headRef: bumpBranchFor(mergeParams.changeObjectId),
    baseRef: mergeParams.baseBranch
  };

  function mergeCtx() {
    const { ctx, calls } = recordingCtx(githubHandler({}, mergePullRequest));
    return {
      calls,
      ctx: {
        ...ctx,
        config: {
          // Server-governed. Present because `asConfig` gates EVERY action on them, merge included —
          // a deployment that has not enabled dependency authoring must not merge one either.
          runnerImage: "scp-runner-dep:test",
          workspaceRoot: "/nonexistent-workspace-that-must-never-be-touched",
          provider: "github",
          appId: "12345",
          installationId: "67890",
          privateKeyPem: mergePrivateKeyPem
        }
      }
    };
  }

  it("merges, sends the evidenced commit as the precondition, and launches no container", async () => {
    const { ctx, calls } = mergeCtx();
    const ref = await managedDepExecutorPlugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${mergeParams.changeObjectId}:merge:${EVIDENCED}`,
      parameters: mergeParams
    });
    const status = await managedDepExecutorPlugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).toMatch(/merged pull request #7/);

    const merge = calls.find((c) => c.method === "PUT" && c.url.includes("/merge"));
    expect(merge?.url).toContain(`/repos/acme/widget/pulls/7/merge`);
    expect((merge?.body as { sha?: string }).sha).toBe(EVIDENCED);
    // NEVER AN EDIT: no contents read, no contents write, no branch create.
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/git/refs"))).toBe(false);
  });

  it("reports a FAILED phase when the provider refused, rather than a succeeded run with a note", async () => {
    const { ctx } = mergeCtx();
    const refusing = {
      ...ctx,
      http: {
        request: async (req: { method: string; url: string }) =>
          req.url.includes("/merge")
            ? { status: 405, headers: {}, body: { message: "protected" } }
            : githubHandler({}, mergePullRequest)(req as never)
      }
    };
    const ref = await managedDepExecutorPlugin.trigger(
      refusing as unknown as Parameters<typeof managedDepExecutorPlugin.trigger>[0],
      {
        kind: "custom",
        idempotencyKey: `${mergeParams.changeObjectId}:merge:refused`,
        parameters: mergeParams
      }
    );
    const status = await managedDepExecutorPlugin.status(
      refusing as unknown as Parameters<typeof managedDepExecutorPlugin.status>[0],
      ref
    );
    // The SERVER records this phase, so "the merge did not happen" must never read as "done".
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/NOT merged/);
  });

  it("refuses a malformed merge intent as a failed run, without reaching the provider", async () => {
    const { ctx, calls } = mergeCtx();
    const ref = await managedDepExecutorPlugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: "bad-merge",
      parameters: { ...mergeParams, expectedHeadCommit: "a1b2c3d" }
    });
    const status = await managedDepExecutorPlugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    // Zero requests: the refusal precedes the App-JWT → installation-token exchange, so an
    // adversarial intent costs no credential mint at all.
    expect(calls).toHaveLength(0);
  });
});

describe("resolveRepoWriter — the credential clause, as a refusal", () => {
  beforeEach(() => undefined);

  it("refuses a provider with no per-run, single-repository, short-lived credential", () => {
    for (const provider of ["gitea", "gitlab"]) {
      expect(() => resolveRepoWriter({ provider, appId: "1", installationId: "2" })).toThrow(
        /standing credential/
      );
    }
  });

  it("refuses a GitHub arm with no App identity — a bump needs a token it can mint per run", () => {
    expect(() => resolveRepoWriter({ provider: "github" })).toThrow(
      /appId and config.installationId/
    );
  });

  it("accepts a complete GitHub App identity", () => {
    expect(resolveRepoWriter({ appId: "1", installationId: "2" })).toBeDefined();
  });
});

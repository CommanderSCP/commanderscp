import { describe, expect, it } from "vitest";
import { bumpCommitMessage, bumpPullRequestBody, createGithubAppRepoWriter } from "./repo-write.js";
import {
  AUTHORED_PULL_REQUEST,
  BUMP_SPEC as spec,
  EVIDENCED_COMMIT,
  PACKAGE_JSON_BUMPED,
  WRITE_TARGET as target,
  githubHandler,
  realProof,
  recordingCtx as fakeCtx
} from "./write-test-support.js";

/**
 * The credential clause, exercised against a recording fake of `ctx.http`.
 *
 * "Repository-write credentials are issued per run, scoped to the single repository under change,
 * and are never standing credentials" is a sentence about REQUESTS — which endpoint is called, what
 * body it carries, and whether the token is revoked — so it is testable exactly here and nowhere
 * else in the tree.
 *
 * The fixtures and the recording client are shared with `repo-write.matrix.test.ts`, so the wire
 * behaviour proven here and the refusals proven there are demonstrably about the same request.
 */

// A throwaway RSA key, generated in-test, so no key material is committed and the JWT signing path
// is genuinely exercised rather than stubbed.
const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const writer = createGithubAppRepoWriter({
  appId: "12345",
  installationId: "67890",
  privateKeyPem
});

describe("the per-run repository-write credential", () => {
  it("is minted SCOPED TO THE SINGLE REPOSITORY, with only contents+pull_requests write", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await writer.withRunCredential(ctx, "acme/widget", async () => undefined);

    const mint = calls.find((c) => c.url.endsWith("/access_tokens"));
    expect(mint).toBeDefined();
    expect(mint?.body).toEqual({
      // WITHOUT this the mint returns a token valid for every repository the App is installed on —
      // a standing credential wearing a short-lived name.
      repositories: ["widget"],
      permissions: { contents: "write", pull_requests: "write" }
    });
  });

  it("is REVOKED when the run ends, so it is dead rather than merely expiring later", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await writer.withRunCredential(ctx, "acme/widget", async () => undefined);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );
  });

  it("is revoked even when the run THREW — a failed bump must not leak a live token", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await expect(
      writer.withRunCredential(ctx, "acme/widget", async () => {
        throw new Error("verification refused the runner's output");
      })
    ).rejects.toThrow(/verification refused/);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );
  });

  it("is minted ONCE per run and not cached across runs", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await writer.withRunCredential(ctx, "acme/widget", async (s) => {
      await s.readFile("package.json", "main");
      await s.readFile("package.json", "main");
    });
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);

    const second = fakeCtx(githubHandler());
    await second.ctx.http.request; // touch, so the linter sees the binding used
    await writer.withRunCredential(second.ctx, "acme/widget", async () => undefined);
    expect(second.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
  });
});

describe("publishBump — one file, one branch, one pull request", () => {
  it("commits the runner's bytes and opens a pull request, leaving it unmerged", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.publishBump({
        target,
        spec,
        content: PACKAGE_JSON_BUMPED,
        proof: realProof(),
        delivery: "pull_request"
      })
    );
    expect(result).toMatchObject({
      commitSha: "newcommit",
      pullRequestNumber: 7,
      merged: false
    });
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/contents/"));
    expect((put?.body as { content: string }).content).toBe(
      Buffer.from(PACKAGE_JSON_BUMPED, "utf8").toString("base64")
    );
    // The compare-and-set: the blob sha we actually read, never omitted.
    expect((put?.body as { sha: string }).sha).toBe("blobsha");
    // No merge was attempted at all for pull_request delivery.
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
  });

  it("REFUSES to create a manifest the component does not already contain", async () => {
    const { ctx } = fakeCtx(
      githubHandler({ "/contents/": { status: 404, headers: {}, body: {} } })
    );
    await expect(
      writer.withRunCredential(ctx, "acme/widget", (s) =>
        s.publishBump({
          target,
          spec,
          content: PACKAGE_JSON_BUMPED,
          proof: realProof(),
          delivery: "pull_request"
        })
      )
    ).rejects.toThrow(/refusing to create a file this component does not already contain/);
  });

  it("merges when delivery is auto_merge, CONDITIONED on the evidenced commit", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.publishBump({
        target,
        spec,
        content: PACKAGE_JSON_BUMPED,
        proof: realProof(),
        delivery: "auto_merge",
        expectedHeadCommit: EVIDENCED_COMMIT
      })
    );
    expect(result.merged).toBe(true);
    // THE PRECONDITION IS ON THE WIRE, and asserting it is the whole point of this test: the
    // server's grant names a COMMIT, and a merge sent without `sha` merges whatever the branch is
    // at — including a commit this very run's own PUT just created, which no control ever saw.
    const merge = calls.find((c) => c.method === "PUT" && c.url.includes("/merge"));
    expect((merge?.body as { sha?: string }).sha).toBe(EVIDENCED_COMMIT);
  });

  it("REFUSES auto_merge that names no evidenced commit, before the publish makes any request", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await expect(
      writer.withRunCredential(ctx, "acme/widget", (s) =>
        s.publishBump({
          target,
          spec,
          content: PACKAGE_JSON_BUMPED,
          proof: realProof(),
          delivery: "auto_merge"
        })
      )
    ).rejects.toMatchObject({ reason: "unsafe_commit" });
    // MEASURED, never inferred: the only requests are the run's own mint and revoke, so nothing
    // partial (no branch, no commit, no pull request) was left behind by the refusal.
    expect(calls.map((c) => c.url).filter((u) => !u.includes("token"))).toHaveLength(0);
  });

  it("reports a provider merge refusal honestly instead of retrying or claiming success", async () => {
    const { ctx } = fakeCtx(
      githubHandler({ "/merge": { status: 405, headers: {}, body: { message: "protected" } } })
    );
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.publishBump({
        target,
        spec,
        content: PACKAGE_JSON_BUMPED,
        proof: realProof(),
        delivery: "auto_merge",
        expectedHeadCommit: EVIDENCED_COMMIT
      })
    );
    expect(result.merged).toBe(false);
    expect(result.mergeRefusal).toMatch(/provider refused the merge \(HTTP 405\)/);
    expect(result.pullRequestNumber).toBe(7);
  });

  it("treats an existing branch + duplicate pull request as the same logical bump, not a failure", async () => {
    const { ctx } = fakeCtx((req) => {
      if (req.method === "POST" && req.url.endsWith("/git/refs")) {
        return { status: 422, headers: {}, body: { message: "Reference already exists" } };
      }
      if (req.method === "POST" && req.url.endsWith("/pulls")) {
        return { status: 422, headers: {}, body: { message: "already exists" } };
      }
      return githubHandler()(req);
    });
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.publishBump({
        target,
        spec,
        content: PACKAGE_JSON_BUMPED,
        proof: realProof(),
        delivery: "pull_request"
      })
    );
    expect(result.pullRequestNumber).toBe(AUTHORED_PULL_REQUEST);
  });

  /**
   * THE SAME PROPERTY AS THE MERGE PATH'S, AT THE OTHER CALL SITE. `findOpenPullRequest` used to
   * filter on the head branch alone and return `list.body[0]`, so the "duplicate" this run adopts as
   * its own could be a pull request somebody else opened from the same branch to a different base —
   * and for an `auto_merge` delivery this run would then merge it. One branch can legitimately have
   * several open pull requests against several bases; the one this run is a retry of is the one into
   * OUR base.
   */
  it("REFUSES to adopt a duplicate pull request that targets a DIFFERENT base", async () => {
    const { ctx } = fakeCtx((req) => {
      if (req.method === "POST" && req.url.endsWith("/git/refs")) {
        return { status: 422, headers: {}, body: { message: "Reference already exists" } };
      }
      if (req.method === "POST" && req.url.endsWith("/pulls")) {
        return { status: 422, headers: {}, body: { message: "already exists" } };
      }
      if (req.method === "GET" && req.url.includes("/pulls?state=open")) {
        return {
          status: 200,
          headers: {},
          body: [
            {
              number: 99,
              html_url: "https://x/pull/99",
              state: "open",
              head: { ref: target.headBranch },
              base: { ref: "production" }
            }
          ]
        };
      }
      return githubHandler()(req);
    });
    await expect(
      writer.withRunCredential(ctx, "acme/widget", (s) =>
        s.publishBump({
          target,
          spec,
          content: PACKAGE_JSON_BUMPED,
          proof: realProof(),
          delivery: "pull_request"
        })
      )
    ).rejects.toThrow(/no OPEN pull request between exactly those two branches/);
  });

  it("refuses to read a directory listing as if it were a manifest", async () => {
    const { ctx } = fakeCtx(
      githubHandler({ "/contents/": { status: 200, headers: {}, body: [{ name: "a" }] } })
    );
    await expect(
      writer.withRunCredential(ctx, "acme/widget", (s) => s.readFile("src", "main"))
    ).rejects.toThrow(/not a base64-encoded file blob/);
  });
});

/**
 * ================================================================================================
 * `mergeAuthoredBranch` — THE NEW REPOSITORY-WRITE AUTHORITY, AND EVERY CONDITION ON IT
 * ================================================================================================
 * Until M21.5's auto-merge link the only merge reachable in the tree was the tail of a publish, so
 * this is a genuine widening: SCP can now change a repository's default branch without a human
 * clicking anything. Each test below pins one of the conditions that make that permissible, and each
 * asserts the MECHANISM (a request, a refusal reason) rather than only the outcome — a test that
 * asserted "it did not merge" would stay green with the precondition deleted.
 */
describe("mergeAuthoredBranch — merging is conditioned, never merely authorized", () => {
  const mergeTarget = { ...target };

  it("merges THE PULL REQUEST SCP OPENED, addressed by number, never one found by listing", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "chore(deps): merge SCP-authored bump c1"
      })
    );
    expect(result).toMatchObject({ merged: true, pullRequestNumber: AUTHORED_PULL_REQUEST });
    const merge = calls.find((c) => c.method === "PUT" && c.url.includes("/merge"));
    expect((merge?.body as { sha?: string }).sha).toBe(EVIDENCED_COMMIT);
    // THE PULL REQUEST IS ADDRESSED, NOT SEARCHED FOR. A listing filtered on the head branch returns
    // whatever the provider orders first — including a second pull request somebody else opened from
    // SCP's branch to a protected base — so this path must not perform one at all.
    expect(calls.some((c) => c.url.includes("/pulls?state=open"))).toBe(false);
    expect(
      calls.some((c) => c.method === "GET" && c.url.endsWith(`/pulls/${AUTHORED_PULL_REQUEST}`))
    ).toBe(true);
    // IT NEVER AUTHORS. No branch create, no contents PUT — a merge is not an edit.
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/git/refs"))).toBe(false);
  });

  /**
   * ============================================================================================
   * THE BASE BRANCH IS COMPARED, NOT MERELY CARRIED — the blocker this block exists for
   * ============================================================================================
   * `target.baseBranch` was asserted safe and then DISCARDED: never sent, never compared. Combined
   * with "merge whichever open pull request the listing returns first", that meant an open pull
   * request from SCP's branch to `production`, while the governed grant was about `main`, MERGED —
   * and the server recorded a `merged` Decision naming `main`. Anyone with write or triage on the
   * repository can retarget a pull request or open a second one from a branch they can see, so this
   * is a reachable widening of the grant, not a hypothetical.
   */
  it("REFUSES a pull request whose base is not the base the grant named", async () => {
    const { ctx, calls } = fakeCtx(
      githubHandler({
        [`/pulls/${AUTHORED_PULL_REQUEST}`]: {
          status: 200,
          headers: {},
          body: {
            number: AUTHORED_PULL_REQUEST,
            html_url: "https://x/pull/7",
            state: "open",
            head: { ref: mergeTarget.headBranch },
            // RETARGETED by somebody with write access, after SCP opened it against `main`.
            base: { ref: "production" }
          }
        }
      })
    );
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "t"
      })
    );
    expect(result.merged).toBe(false);
    expect(result.mergeRefusal).toMatch(/targets 'production'.*grant is for 'main'/);
    // NOT MERELY REPORTED AS UNMERGED — no merge request was made at all.
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
  });

  it("REFUSES a pull request whose HEAD is not the branch this change authored", async () => {
    const { ctx, calls } = fakeCtx(
      githubHandler({
        [`/pulls/${AUTHORED_PULL_REQUEST}`]: {
          status: 200,
          headers: {},
          body: {
            number: AUTHORED_PULL_REQUEST,
            state: "open",
            head: { ref: "someone-elses-branch" },
            base: { ref: mergeTarget.baseBranch }
          }
        }
      })
    );
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "t"
      })
    );
    expect(result.merged).toBe(false);
    expect(result.mergeRefusal).toMatch(/has head 'someone-elses-branch'/);
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
  });

  it("REFUSES a pull request number that is absent, zero or not an integer, with zero requests", async () => {
    for (const number of [0, -1, 1.5, Number.NaN] as number[]) {
      const { ctx, calls } = fakeCtx(githubHandler());
      await expect(
        writer.withRunCredential(ctx, "acme/widget", (s) =>
          s.mergeAuthoredBranch({
            target: mergeTarget,
            pullRequestNumber: number,
            expectedHeadCommit: EVIDENCED_COMMIT,
            commitTitle: "t"
          })
        )
      ).rejects.toThrow(/pullRequestNumber must be a positive integer/);
      // There is NO fallback to searching for one: a merge intent that does not name the pull
      // request SCP opened did not come from the server's gate.
      expect(calls.some((c) => c.url.includes("/pulls"))).toBe(false);
    }
  });

  it("a head that has MOVED off the evidenced commit is refused by the provider, and reported as such", async () => {
    // The staleness case, and the reason `sha` is sent rather than trusted: a human pushed to the
    // bump's branch after the control passed, so the tree that would merge is not the tree that was
    // evidenced. GitHub answers 409, and the pull request stands.
    const { ctx } = fakeCtx(
      githubHandler({ "/merge": { status: 409, headers: {}, body: { message: "head changed" } } })
    );
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "t"
      })
    );
    expect(result.merged).toBe(false);
    expect(result.mergeRefusal).toMatch(/no longer a1b2c3d4/);
  });

  it("REFUSES an abbreviated or empty commit — a precondition that cannot match is not one", async () => {
    for (const commit of ["", "a1b2c3d", "not-hex".padEnd(40, "z")]) {
      const { ctx, calls } = fakeCtx(githubHandler());
      await expect(
        writer.withRunCredential(ctx, "acme/widget", (s) =>
          s.mergeAuthoredBranch({
            target: mergeTarget,
            pullRequestNumber: AUTHORED_PULL_REQUEST,
            expectedHeadCommit: commit,
            commitTitle: "t"
          })
        )
      ).rejects.toMatchObject({ reason: "unsafe_commit" });
      expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
    }
  });

  it("REFUSES a traversal repo and a traversal branch, at the splice site, with zero requests", async () => {
    // The traversal census, inherited rather than re-implemented — the property M21.2's read path was
    // hardened for, applied to the newest place a caller-supplied string reaches a REST route.
    const cases: { target: typeof mergeTarget; reason: string }[] = [
      { target: { ...mergeTarget, repo: "acme/../../../user" }, reason: "unsafe_repo" },
      { target: { ...mergeTarget, headBranch: "../../../../user" }, reason: "unsafe_branch" },
      { target: { ...mergeTarget, baseBranch: "main?x=" }, reason: "unsafe_base_ref" },
      // The head branch may never BE the base — merging `main` into `main` is not a bump delivery.
      { target: { ...mergeTarget, headBranch: "main" }, reason: "branch_is_base_ref" }
    ];
    for (const { target: t, reason } of cases) {
      const { ctx, calls } = fakeCtx(githubHandler());
      await expect(
        writer.withRunCredential(ctx, "acme/widget", (s) =>
          s.mergeAuthoredBranch({
            target: t,
            pullRequestNumber: AUTHORED_PULL_REQUEST,
            expectedHeadCommit: EVIDENCED_COMMIT,
            commitTitle: "t"
          })
        )
      ).rejects.toMatchObject({ reason });
      expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
    }
  });

  it("refuses when the pull request has been CLOSED, and never opens a replacement", async () => {
    // A human closing the bump's pull request is a decision about that bump. This action performs
    // one act and has no authoring behaviour to fall back on.
    const { ctx, calls } = fakeCtx(
      githubHandler({
        [`/pulls/${AUTHORED_PULL_REQUEST}`]: {
          status: 200,
          headers: {},
          body: {
            number: AUTHORED_PULL_REQUEST,
            state: "closed",
            head: { ref: mergeTarget.headBranch },
            base: { ref: mergeTarget.baseBranch }
          }
        }
      })
    );
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "t"
      })
    );
    expect(result.merged).toBe(false);
    expect(result.mergeRefusal).toMatch(/is 'closed', not open/);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
  });

  it("holds the same per-run, single-repository credential and revokes it afterwards", async () => {
    const { ctx, calls } = fakeCtx(githubHandler());
    await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.mergeAuthoredBranch({
        target: mergeTarget,
        pullRequestNumber: AUTHORED_PULL_REQUEST,
        expectedHeadCommit: EVIDENCED_COMMIT,
        commitTitle: "t"
      })
    );
    const mint = calls.find((c) => c.url.endsWith("/access_tokens"));
    expect(mint?.body).toEqual({
      repositories: ["widget"],
      permissions: { contents: "write", pull_requests: "write" }
    });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );
  });
});

describe("the authored prose is DERIVED from the descriptor, never supplied", () => {
  it("names the coordinate and both versions and nothing a caller chose", () => {
    expect(bumpCommitMessage(spec)).toBe("chore(deps): @acme/lib ^1.2.3 -> ^1.4.0");
    const body = bumpPullRequestBody(spec, "scp/dep-bump/c1");
    expect(body).toContain("package.json");
    expect(body).toContain("Manifest-only");
    expect(body).toContain("scp/dep-bump/c1");
  });
});

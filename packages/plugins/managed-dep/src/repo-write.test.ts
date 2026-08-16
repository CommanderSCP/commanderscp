import { describe, expect, it } from "vitest";
import { bumpCommitMessage, bumpPullRequestBody, createGithubAppRepoWriter } from "./repo-write.js";
import {
  BUMP_SPEC as spec,
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

  it("merges when delivery is auto_merge (the SERVER already decided; this actuates it)", async () => {
    const { ctx } = fakeCtx(githubHandler());
    const result = await writer.withRunCredential(ctx, "acme/widget", (s) =>
      s.publishBump({
        target,
        spec,
        content: PACKAGE_JSON_BUMPED,
        proof: realProof(),
        delivery: "auto_merge"
      })
    );
    expect(result.merged).toBe(true);
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
        delivery: "auto_merge"
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
      if (req.method === "GET" && req.url.includes("/pulls?state=open")) {
        return { status: 200, headers: {}, body: [{ number: 7, html_url: "https://x/pull/7" }] };
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
    expect(result.pullRequestNumber).toBe(7);
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

describe("the authored prose is DERIVED from the descriptor, never supplied", () => {
  it("names the coordinate and both versions and nothing a caller chose", () => {
    expect(bumpCommitMessage(spec)).toBe("chore(deps): @acme/lib ^1.2.3 -> ^1.4.0");
    const body = bumpPullRequestBody(spec, "scp/dep-bump/c1");
    expect(body).toContain("package.json");
    expect(body).toContain("Manifest-only");
    expect(body).toContain("scp/dep-bump/c1");
  });
});

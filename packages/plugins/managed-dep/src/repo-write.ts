import { encodePathSegments } from "@scp/git-provider-core";
import type { PluginContext, ScopedHttpClient } from "@scp/plugin-api";
import type { ManifestBumpSpec } from "./bump-edit.js";
import {
  MAX_COMMIT_MESSAGE_CHARS,
  MAX_PR_BODY_CHARS,
  MAX_PR_TITLE_CHARS,
  assertBranchIsNotBase,
  assertManifestEditProof,
  assertMessageBound,
  assertWriteBaseBranch,
  assertWriteBaseRef,
  assertWriteBranch,
  assertWritePath,
  assertWriteRepo,
  type ManifestEditProof
} from "./write-guard.js";

/**
 * THE ONE PLACE COMMANDERSCP WRITES TO SOMEBODY ELSE'S REPOSITORY, AND THE CREDENTIAL CLASS THAT
 * MAKES IT POSSIBLE (charter `scp-managed-dep` amendment 2026-08-13, qualified 2026-08-15).
 *
 * THE ONE PLACE, LITERALLY. M21.5 was briefly built twice — once as write hooks on
 * `GitProviderAdapter`, once here — and the owner's 2026-08-15 decision settled it on this side:
 * repository-write authority belongs inside the charter's enumerated managed class, where its
 * containment preconditions bind, not in a library every git-provider plugin loads. See
 * `write-guard.ts`'s header for the ADR-0032 §9 argument that decided it. `GitProviderAdapter` is
 * read-only and pinned so by a type-level assertion in `@scp/git-provider-core`'s own suite.
 *
 * ============================================================================================
 * WHO REACHES THE GIT HOST — THE ORCHESTRATOR, NEVER THE RUNNER
 * ============================================================================================
 * The 2026-08-13 amendment said two things that could not both be true of one process:
 *
 *   "`scp-managed-dep` holds scoped, per-run, short-lived repository-write credentials"
 *   "... runs in isolated single-shot ephemeral runners from a separate `scp-runner-dep` image,
 *    and reaches no hosts."
 *
 * A repository-write credential is only meaningful against a host, so a component that reaches no
 * hosts cannot use one. The charter was amended on 2026-08-15 to qualify the network clause exactly
 * as the 2026-07-23 amendment already qualifies it for `scp-managed-scan`, and THIS FILE IMPLEMENTS
 * THAT SPLIT rather than working around it:
 *
 *   * the RUNNER (`scp-runner-dep`, a separate pinned image) is single-shot, ephemeral, and
 *     `--network none`. It receives manifest bytes by `docker cp`, applies the declared-version edit
 *     offline, and returns bytes by `docker cp`. It reaches no hosts, holds no credential, and
 *     contains no package manager — which is how "never runs a package manager, never resolves or
 *     regenerates a lockfile" becomes true by construction rather than by discipline. See
 *     `index.ts`'s `runEditorContainer`: the container is launched with no environment, no mount and
 *     no socket, and everything it is told is five argv strings that name a declaration.
 *   * the ORCHESTRATOR (this plugin, in the plugin host) holds the repository-write credential and
 *     performs the write. It is the component the credential clause is about.
 *
 * The precedent is shipped, not invented: `federation/promotion-scan-step.ts` records that the
 * managed-scan plugin "does NOT pull the subject's bytes (the SERVER does that, by digest, over the
 * allowlisted skopeo channel — the runner has NO network)".
 *
 * ============================================================================================
 * PER-RUN, SINGLE-REPOSITORY, SHORT-LIVED — AND EXPLICITLY REVOKED
 * ============================================================================================
 * "Repository-write credentials are issued per run, scoped to the single repository under change,
 * and are never standing credentials." Every clause of that is a line of code below:
 *
 *   ISSUED PER RUN      — {@link mintScopedRepoToken} runs inside {@link RepoWriter.withRunCredential},
 *                         once per run, and the token never leaves that scope. It deliberately does
 *                         NOT reuse `@scp/plugin-github`'s module-level `installationTokenCache`:
 *                         that cache is correct for a read-mostly coordination plugin and exactly
 *                         wrong here, because a cached token is a token that outlives its run.
 *   SCOPED TO ONE REPO  — the mint body pins `repositories: [<repo>]`. Without it the mint returns a
 *                         token valid for EVERY repository the App is installed on, which is the
 *                         standing-credential shape wearing a short-lived name.
 *   NARROW PERMISSIONS  — `contents: write` + `pull_requests: write`, and nothing else. No
 *                         `workflows`, no `administration`, no `checks`.
 *   SHORT-LIVED         — GitHub caps an installation token at one hour; nothing here extends one.
 *   NEVER STANDING      — {@link revokeScopedRepoToken} deletes it in the `finally`, so the
 *                         credential is dead when the run ends rather than merely expiring later.
 *
 * The STANDING secret remains the App private key, which is NOT a repository-write credential and is
 * the same secret `@scp/plugin-github` already holds behind the same vaulted AES-256-GCM
 * `SecretsAccessor`. That is why the GitHub App flow is the only arm implemented: a personal access
 * token cannot be minted per run or scoped to one repository, so wiring one would deliver the
 * FEATURE by removing the CREDENTIAL CLAUSE that authorises the feature to exist. See
 * {@link resolveRepoWriter} for the refusal that says so by name.
 */

/** How the bump is delivered (ADR-0032 §8, owner decision 2026-08-13). */
export type BumpDelivery = "pull_request" | "auto_merge";

export interface RepoWriteTarget {
  /** `owner/repo`, as the provider spells it. */
  repo: string;
  /** The branch the bump is based on and the pull request targets (`main`). */
  baseBranch: string;
  /** The branch this run authors. Composed by the orchestrator from the ORIGINATING CHANGE'S ID —
   *  see `index.ts`'s "THE PROVENANCE LOOP" for why the id is IN the ref. */
  headBranch: string;
}

export interface RepoWriteResult {
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  /** True only when `delivery === "auto_merge"` AND the merge call actually succeeded. */
  merged: boolean;
  /** Set when auto-merge was asked for and the provider refused it. The pull request still exists
   *  and is the honest outcome, so this is REPORTED rather than thrown or retried. */
  mergeRefusal?: string;
}

/** One file as the repository currently holds it. `undefined` from `readFile` means the path is not
 *  there — which for this class is a refusal, never an invitation to create it. */
export interface RepoFile {
  content: string;
  blobSha: string;
}

/**
 * The operations available WHILE the run's credential is alive. There is no general-purpose
 * repository write behind this interface: one read of one path, and one publish of one edited file
 * as one pull request.
 */
export interface RepoSession {
  readFile(path: string, ref: string): Promise<RepoFile | undefined>;
  publishBump(input: PublishBumpInput): Promise<RepoWriteResult>;
}

/**
 * What one publish needs — and note what it CANNOT express: content without a proof.
 *
 * `proof` is not documentation. It is an HMAC minted only by `write-guard.ts`'s
 * `verifyManifestOnlyEdit`, over a key no other module holds, bound to the exact bytes in `content`
 * and to `spec.manifestPath`. {@link createGithubAppRepoWriter} re-checks it before any request, so
 * content that did not pass verification is STRUCTURALLY unable to reach a repository — the
 * difference between "the actuator is supposed to check" and "it cannot not have checked".
 */
export interface PublishBumpInput {
  target: RepoWriteTarget;
  spec: ManifestBumpSpec;
  /** The bytes the ISOLATED RUNNER produced, which both verifiers have agreed with. Never authored
   *  by this module. */
  content: string;
  /** Minted by `verifyManifestOnlyEdit` for exactly these bytes at exactly this path. */
  proof: ManifestEditProof;
  delivery: BumpDelivery;
}

/**
 * The provider arm. `withRunCredential` is the ONLY entry point, and its shape is the credential
 * clause made structural: the token is minted on entry, is reachable only through the session handed
 * to `fn`, and is revoked on exit whether `fn` succeeded or threw. There is no way to obtain a
 * session — and therefore no way to write — outside one bounded run.
 */
export interface RepoWriter {
  withRunCredential<T>(
    ctx: PluginContext,
    repo: string,
    fn: (session: RepoSession) => Promise<T>
  ): Promise<T>;
}

export interface GithubAppRepoWriterConfig {
  /** GitHub App identity — the same pair `@scp/plugin-github` uses. */
  appId: string;
  installationId: string;
  /** `SecretsAccessor` key holding the App private key PEM. The ONLY standing secret in this path,
   *  and it is not a repository-write credential. */
  privateKeySecretKey?: string;
  /** Tests/fixtures only, mirroring `@scp/plugin-github`'s identical escape hatch. */
  privateKeyPem?: string;
  apiBaseUrl?: string;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

// -------------------------------------------------------------------------------------------
// GitHub App JWT — lifted in SHAPE from `@scp/plugin-github`, deliberately not imported from it. A
// plugin package depending on another plugin package would have the subprocess host load two modules
// for one instance; `managed-scan` carries its own copy of what it needs for the same reason and
// says so.
// -------------------------------------------------------------------------------------------

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function signAppJwt(
  appId: string,
  privateKeyPem: string,
  now: () => number = Date.now
): Promise<string> {
  const { createSign } = await import("node:crypto");
  const nowSec = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export interface ScopedToken {
  token: string;
  expiresAt: string;
}

/**
 * Mint the run's credential. NOT cached, by construction and by comment: a cache here would be the
 * "never standing" clause failing silently, and a reader who saw a cache lookup would have no way to
 * know it was the thing the charter forbids.
 */
export async function mintScopedRepoToken(
  ctx: PluginContext,
  config: GithubAppRepoWriterConfig,
  repo: string
): Promise<ScopedToken> {
  const privateKeyPem =
    config.privateKeyPem ?? (await ctx.secrets.get(config.privateKeySecretKey ?? ""));
  if (!privateKeyPem) {
    throw new Error(
      "managed-dep: no GitHub App private key configured (config.privateKeySecretKey resolved nothing) — refusing to attempt a repository write with no credential"
    );
  }
  const jwt = await signAppJwt(config.appId, privateKeyPem);
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const repoName = repo.split("/").slice(1).join("/");
  const response = await ctx.http.request({
    method: "POST",
    url: `${apiBaseUrl}/app/installations/${config.installationId}/access_tokens`,
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
    body: {
      // SCOPED TO THE SINGLE REPOSITORY UNDER CHANGE. Omitting this yields a token good for every
      // repository the installation covers — see the module doc.
      repositories: [repoName],
      // The narrowest pair that can open a pull request carrying a file edit. Nothing else.
      permissions: { contents: "write", pull_requests: "write" }
    }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `managed-dep: scoped repository token mint returned HTTP ${response.status} for '${repo}'`
    );
  }
  const body = response.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("managed-dep: scoped repository token mint returned no token");
  }
  return {
    token: body.token,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : "(unreported)"
  };
}

/** Kill the credential at the end of the run rather than letting it expire. Best-effort: a failed
 *  revoke must not turn a delivered bump into a failure, but it is never silent. */
export async function revokeScopedRepoToken(
  ctx: PluginContext,
  apiBaseUrl: string,
  token: string
): Promise<void> {
  try {
    await ctx.http.request({
      method: "DELETE",
      url: `${apiBaseUrl}/installation/token`,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }
    });
  } catch (err) {
    ctx.logger.warn("managed-dep: scoped repository token revoke failed (it will still expire)", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// -------------------------------------------------------------------------------------------
// The authored prose. Composed HERE from the descriptor, never supplied by a caller.
// -------------------------------------------------------------------------------------------

/**
 * The commit subject and pull-request body are DERIVED, not passed in.
 *
 * That is a deliberate narrowing rather than a convenience. If the server — and through it a tenant
 * policy document — could supply the message, this seam would carry caller-controlled text into a
 * repository write, and "never authors any other content" would depend on whoever populated that
 * field. Deriving them means the only tenant-derived strings reaching the repository are the
 * coordinate and the two versions, all three of which already appear in the manifest being edited.
 */
export function bumpCommitMessage(spec: ManifestBumpSpec): string {
  return `chore(deps): ${spec.coordinate} ${spec.fromVersion} -> ${spec.toVersion}`;
}

export function bumpPullRequestBody(spec: ManifestBumpSpec, headBranch: string): string {
  return [
    "Authored by CommanderSCP's `scp-managed-dep` executor for a component with dependency",
    "subscriptions enabled on this line.",
    "",
    `- manifest: \`${spec.manifestPath}\``,
    `- dependency: \`${spec.coordinate}\` (${spec.ecosystem})`,
    `- declared version: \`${spec.fromVersion}\` -> \`${spec.toVersion}\``,
    "",
    "Manifest-only: no lockfile was resolved, no package manager was run, and nothing was built or",
    "tested. Your own CI is what validates this change.",
    "",
    `Branch \`${headBranch}\` carries the originating change's id, which is how the push this commit`,
    "produces correlates back to that change instead of being read as an unrelated release."
  ].join("\n");
}

// -------------------------------------------------------------------------------------------
// The GitHub arm
// -------------------------------------------------------------------------------------------

async function githubApi(
  http: ScopedHttpClient,
  apiBaseUrl: string,
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const response = await http.request({
    method,
    url: `${apiBaseUrl}${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json"
    },
    body
  });
  return { status: response.status, body: response.body };
}

/** The provider name every refusal message from this arm carries. */
const PROVIDER = "github";

export function createGithubAppRepoWriter(config: GithubAppRepoWriterConfig): RepoWriter {
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;

  return {
    async withRunCredential<T>(
      ctx: PluginContext,
      repo: string,
      fn: (session: RepoSession) => Promise<T>
    ): Promise<T> {
      // BEFORE THE MINT, not merely before the write. `repo` is spliced into the mint body and into
      // every route below, so validating it here is what makes an adversarial repo cost ZERO HTTP
      // requests — including the App-JWT → installation-token exchange, which is itself a request
      // that would otherwise happen first. Exactly two segments: this arm addresses `owner/repo`,
      // and a third segment is a different route.
      assertWriteRepo(PROVIDER, repo, 2);
      const minted = await mintScopedRepoToken(ctx, config, repo);
      ctx.logger.info("managed-dep: minted a per-run, single-repository write token", {
        repo,
        expiresAt: minted.expiresAt
      });
      const api = (
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        reqBody?: unknown
      ) => githubApi(ctx.http, apiBaseUrl, minted.token, method, path, reqBody);

      const session: RepoSession = {
        async readFile(path: string, ref: string): Promise<RepoFile | undefined> {
          // The same three-assert census the read path shipped, applied at the SPLICE SITE. `path`
          // is part of the route and `ref` is a query value, and neither is protected by encoding:
          // `encodeURIComponent("..") === ".."`, which is how a `ref` of `../../../../user` once
          // re-targeted a different endpoint with the binding's credentials.
          assertWritePath(PROVIDER, path);
          assertWriteBaseRef(PROVIDER, ref);
          const res = await api(
            "GET",
            // Per SEGMENT, keeping `/` a literal separator — GitHub's contents route takes the path
            // as part of the route, so whole-string encoding would turn `svc/go.mod` into a
            // single, wrong segment. Validation above is the control; this is the encoding.
            `/repos/${repo}/contents/${encodePathSegments(path)}?ref=${encodeURIComponent(ref)}`
          );
          if (res.status === 404) return undefined;
          if (res.status !== 200) {
            throw new Error(
              `managed-dep: reading '${path}' from '${repo}@${ref}' failed (HTTP ${res.status})`
            );
          }
          const body = res.body as { content?: unknown; encoding?: unknown; sha?: unknown };
          if (typeof body.content !== "string" || body.encoding !== "base64") {
            // A directory listing comes back as an ARRAY, and a submodule/symlink entry carries no
            // base64 content. Neither is a manifest, and treating either as "no file" would let the
            // caller conclude the component does not declare the dependency.
            throw new Error(
              `managed-dep: '${path}' on '${repo}@${ref}' is not a base64-encoded file blob — refusing to treat it as a manifest`
            );
          }
          return {
            content: Buffer.from(body.content, "base64").toString("utf8"),
            blobSha: typeof body.sha === "string" ? body.sha : ""
          };
        },

        async publishBump({ target, spec, content, proof, delivery }): Promise<RepoWriteResult> {
          // ----------------------------------------------------------------------------------
          // EVERY REFUSAL, BEFORE THE FIRST REQUEST OF THE PUBLISH. Order is the enforcement:
          // nothing partial can be left behind by a refusal, because a refusal happens before a
          // branch exists. The matrix in `repo-write.matrix.test.ts` MEASURES the zero with a
          // counting client rather than inferring it from an absent interceptor.
          // ----------------------------------------------------------------------------------
          assertWriteRepo(PROVIDER, target.repo, 2);
          assertWritePath(PROVIDER, spec.manifestPath);
          assertWriteBaseBranch(PROVIDER, target.baseBranch);
          assertWriteBranch(PROVIDER, target.headBranch);
          assertBranchIsNotBase(PROVIDER, target.headBranch, target.baseBranch);
          // The prose SCP writes alongside the edit is DERIVED here, never passed in (see
          // `bumpCommitMessage`/`bumpPullRequestBody` for why that is a narrowing rather than a
          // convenience) — but derived is not the same as bounded: it is composed from a coordinate
          // and two version tokens, all tenant-controlled, so its LENGTH is not something this
          // module gets to assume. The one string serves as BOTH commit subject and pull-request
          // title, so both bounds are asserted over it and the tighter of the two governs.
          const commitMessage = bumpCommitMessage(spec);
          const pullRequestBody = bumpPullRequestBody(spec, target.headBranch);
          assertMessageBound(commitMessage, MAX_COMMIT_MESSAGE_CHARS, "commit message");
          assertMessageBound(commitMessage, MAX_PR_TITLE_CHARS, "pull-request title");
          assertMessageBound(pullRequestBody, MAX_PR_BODY_CHARS, "pull-request body");
          // THE MANIFEST-ONLY CONTROL, re-checked at the last moment before any of this leaves the
          // process. Nothing about the input is trusted: the proof is HMAC-bound to these exact
          // bytes and this exact path, so content mutated after verification is refused here.
          assertManifestEditProof(PROVIDER, {
            path: spec.manifestPath,
            content,
            proof
          });

          // 1. Resolve the base branch's head. Everything below anchors to this sha.
          const baseRef = await api(
            "GET",
            // `heads/<branch>` with LITERAL slashes: GitHub's git/ref route takes the ref as part of
            // the route, so a `release/1.x` base must not become `release%2F1.x`.
            `/repos/${target.repo}/git/ref/heads/${encodePathSegments(target.baseBranch)}`
          );
          if (baseRef.status !== 200) {
            throw new Error(
              `managed-dep: cannot resolve base branch '${target.baseBranch}' of '${target.repo}' (HTTP ${baseRef.status})`
            );
          }
          const baseSha = ((baseRef.body as { object?: { sha?: unknown } }).object?.sha ??
            "") as string;
          if (!baseSha) {
            throw new Error(
              `managed-dep: base branch '${target.baseBranch}' of '${target.repo}' resolved to no sha`
            );
          }

          // 2. Create the head branch. A 422 means it already exists — this run is a retry of the
          //    SAME logical bump (the branch name carries the originating change's id, so it is
          //    stable across retries), and continuing is the idempotent answer, not an error.
          const branchCreate = await api("POST", `/repos/${target.repo}/git/refs`, {
            ref: `refs/heads/${target.headBranch}`,
            sha: baseSha
          });
          if (branchCreate.status !== 201 && branchCreate.status !== 422) {
            throw new Error(
              `managed-dep: cannot create branch '${target.headBranch}' on '${target.repo}' (HTTP ${branchCreate.status})`
            );
          }

          // 3. The file's blob sha ON THE HEAD BRANCH. Supplying the sha we actually read is what
          //    makes the write a compare-and-set instead of a blind overwrite, and a missing file
          //    here is a refusal: this class never creates a file the component does not contain.
          const existing = await session.readFile(spec.manifestPath, target.headBranch);
          if (existing === undefined) {
            throw new Error(
              `managed-dep: '${spec.manifestPath}' does not exist on '${target.repo}@${target.headBranch}' — refusing to create a file this component does not already contain`
            );
          }

          // 4. THE WRITE. One file, one branch, content the isolated runner produced and both
          //    verifiers agreed with, message derived from the descriptor.
          const put = await api(
            "PUT",
            `/repos/${target.repo}/contents/${encodePathSegments(spec.manifestPath)}`,
            {
              message: commitMessage,
              content: Buffer.from(content, "utf8").toString("base64"),
              // The blob sha READ AT THE HEAD BRANCH. Sending it is what makes this a
              // compare-and-set: GitHub treats a missing `sha` as a CREATE, so a blind PUT would
              // either 422 or author a file, and neither is a version bump.
              sha: existing.blobSha,
              branch: target.headBranch
            }
          );
          if (put.status < 200 || put.status >= 300) {
            throw new Error(
              `managed-dep: committing '${spec.manifestPath}' to '${target.repo}@${target.headBranch}' failed (HTTP ${put.status})`
            );
          }
          const commitSha = ((put.body as { commit?: { sha?: unknown } }).commit?.sha ??
            "") as string;

          // 5. Open the pull request. A 422 is the "one already exists for this head" case — the
          //    same retry story as the branch — so the existing one is looked up rather than failed.
          let prNumber = 0;
          let prUrl = "";
          const pr = await api("POST", `/repos/${target.repo}/pulls`, {
            title: commitMessage,
            head: target.headBranch,
            base: target.baseBranch,
            body: pullRequestBody
          });
          if (pr.status === 201) {
            const b = pr.body as { number?: unknown; html_url?: unknown };
            prNumber = typeof b.number === "number" ? b.number : 0;
            prUrl = typeof b.html_url === "string" ? b.html_url : "";
          } else if (pr.status === 422) {
            const owner = target.repo.split("/")[0] ?? "";
            const list = await api(
              "GET",
              `/repos/${target.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${target.headBranch}`)}`
            );
            const first = Array.isArray(list.body)
              ? (list.body[0] as { number?: unknown; html_url?: unknown } | undefined)
              : undefined;
            prNumber = typeof first?.number === "number" ? first.number : 0;
            prUrl = typeof first?.html_url === "string" ? first.html_url : "";
            if (prNumber === 0) {
              throw new Error(
                `managed-dep: the pull request for '${target.headBranch}' was refused as a duplicate but no open pull request was found`
              );
            }
          } else {
            throw new Error(
              `managed-dep: opening a pull request for '${target.headBranch}' on '${target.repo}' failed (HTTP ${pr.status})`
            );
          }

          if (delivery === "pull_request") {
            return { commitSha, pullRequestNumber: prNumber, pullRequestUrl: prUrl, merged: false };
          }

          // 6. AUTO-MERGE. Reaching here already means a governed control evidenced this component's
          //    own checks passed — the SERVER decided that, with the existing gate machinery, before
          //    this plugin was dispatched (see `index.ts`, "AUTO-MERGE IS NOT DECIDED HERE"). This
          //    call actuates that decision; it is never a second judgement of it.
          const merge = await api("PUT", `/repos/${target.repo}/pulls/${prNumber}/merge`, {
            commit_title: commitMessage,
            merge_method: "merge"
          });
          if (merge.status >= 200 && merge.status < 300) {
            return { commitSha, pullRequestNumber: prNumber, pullRequestUrl: prUrl, merged: true };
          }
          // The provider refused (branch protection, a required review, a check that went red
          // between the gate and now). The pull request stands and is the honest outcome — reported,
          // never retried into a force-merge, and never reported as if it had merged.
          return {
            commitSha,
            pullRequestNumber: prNumber,
            pullRequestUrl: prUrl,
            merged: false,
            mergeRefusal: `provider refused the merge (HTTP ${merge.status}); the pull request is open and awaits a human`
          };
        }
      };

      try {
        return await fn(session);
      } finally {
        await revokeScopedRepoToken(ctx, apiBaseUrl, minted.token);
      }
    }
  };
}

/**
 * Choose the provider arm, or REFUSE BY NAME.
 *
 * Gitea and GitLab are absent deliberately. Both can be written to with a token — which is exactly
 * the problem: the tokens either provider offers today are STANDING credentials scoped to a user or
 * a group, and the amendment authorising this class says repository-write credentials are "issued
 * per run, scoped to the single repository under change, and are never standing credentials".
 * Shipping a Gitea arm on a standing token would deliver the feature by removing the condition under
 * which the feature is permitted to exist. So the refusal names the MISSING THING rather than the
 * missing provider.
 */
export function resolveRepoWriter(config: unknown): RepoWriter {
  const c = (config ?? {}) as { provider?: unknown } & GithubAppRepoWriterConfig;
  const provider = typeof c.provider === "string" ? c.provider : "github";
  if (provider !== "github") {
    throw new Error(
      `managed-dep: provider '${provider}' has no per-run, single-repository, short-lived write credential, ` +
        "so a bump cannot be authored there without holding a standing credential — which the charter's " +
        "scp-managed-dep amendment forbids. Only the GitHub App installation-token flow qualifies today."
    );
  }
  if (!c.appId || !c.installationId) {
    throw new Error(
      "managed-dep: config.appId and config.installationId are required (the GitHub App whose installation token is minted per run)"
    );
  }
  return createGithubAppRepoWriter(c);
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DeclaredDependency, DependencyEcosystem } from "@scp/dependency-manifests";
import {
  parseDockerfile,
  parseGoMod,
  parseKubernetesImages,
  parsePackageJson,
  parsePomXml,
  parsePyprojectToml,
  parseRequirementsTxt
} from "@scp/dependency-manifests";
import {
  HARD_MAX_FILE_BYTES,
  assertSafeRef,
  assertSafeRepo,
  assertSafeRepoPath
} from "@scp/git-provider-core";

/**
 * `write-guard.ts` — **the refusals that are the condition of `scp-managed-dep` being allowed to
 * write to somebody else's repository at all**, and the HMAC proof that makes them structural rather
 * than advisory.
 *
 * ============================================================================================
 * WHY IT LIVES HERE AND NOT IN `@scp/git-provider-core` (owner decision 2026-08-15)
 * ============================================================================================
 * M21.5 was built twice by two agents: once as write HOOKS on `GitProviderAdapter`, once as this
 * managed executor. Two independent implementations of one authority is the hazard, so there is now
 * one write path and it is this package's.
 *
 * `GitProviderAdapter` went back to READ-ONLY, and the reason is ADR-0032 §9's own argument. §9
 * admits the adapter as an escape hatch on two grounds: the `ExecutorPlugin` object is unchanged,
 * AND "It also only READS." Extending that same mechanism to writes contradicts half of its stated
 * justification — it would put repository-write authority into a library every git-provider plugin
 * loads, outside the charter's enumerated managed classes, where none of the containment
 * preconditions bind. Inside `scp-managed-dep` they do: an isolated single-shot runner, a per-run
 * single-repository credential, an enumerated class, an owner-approved amendment.
 *
 * The GUARD LAYER built on that other path was the best thing in it and is orthogonal to where the
 * HTTP happens, so it was kept whole and moved here, beside its one consumer (`repo-write.ts`).
 *
 * ============================================================================================
 * WHAT AUTHORISES THE WRITE, AND WHAT IT COSTS
 * ============================================================================================
 * PROJECT_CHARTER.md's `scp-managed-dep` amendment (2026-08-13) admits ONE new managed class to the
 * enumerated allowlist, narrowly defined as *editing the declared version of an already-declared
 * dependency in a manifest the component already contains*. Every clause of that amendment is a
 * precondition, not an aspiration, so every clause that can be enforced in code is enforced here:
 *
 *  - **never adds or removes a dependency** → {@link verifyManifestOnlyEdit} re-parses both sides
 *    with M21.2's parsers and refuses unless the dependency SET is identical element-for-element.
 *  - **never edits a file that declares no dependency** → the target must be a known manifest
 *    basename for its ecosystem AND a path the component's own inventory already declares.
 *  - **never resolves or regenerates a lockfile** → an independent lockfile refusal that does not
 *    depend on the manifest allowlist agreeing with it.
 *  - **never runs a package manager, never builds/compiles/tests** → structurally impossible from
 *    here: this module's only reach is `@scp/dependency-manifests`, whose every export is a pure
 *    function of a string with no I/O of any kind.
 *
 * ADR-0002 §3 gate 5 ("single-shot ephemeral runner… no build farm, no compilation") and the
 * anti-CI corollary are what make the lockfile line the boundary rather than a limitation: a class
 * that needs lockfile resolution is CI by definition and is coordinated, never managed.
 *
 * ============================================================================================
 * THE VERB SET DOES NOT CHANGE (ADR-0032 §9, charter principle 1)
 * ============================================================================================
 * A bump is an ordinary `trigger()`, exactly as an apply is for managed-iac and a scan is for
 * managed-scan. `ExecutorPlugin` remains observe/trigger/status/abort — the four verbs ARE the
 * structural enforcement of "coordination, not execution", so a fifth would remove the mechanism
 * rather than extend it.
 *
 * ============================================================================================
 * THE SAME URL-SAFETY PROPERTY AS THE READ PATH, WITH A WORSE BLAST RADIUS
 * ============================================================================================
 * M21.2's read path was hardened after two proven holes, both of the same property: a
 * caller-supplied string spliced into a REST route re-targets the ROUTE, not just the resource, and
 * `encodeURIComponent("..") === ".."` so encoding is not the control — a validator is. A `ref` of
 * `../../../../user` reached `GET https://api.github.com/user` with the binding's credentials, and a
 * raw `repo` of `acme/widgets?x=` terminated the route at a query string.
 *
 * The write path splices the same three strings into routes, plus a fourth (the BRANCH NAME) and a
 * body. It therefore inherits `assertSafeRepo`/`assertSafeRepoPath`/`assertSafeRef` VERBATIM from
 * `@scp/git-provider-core` — those shipped with the read path, are shared with it, and the point of
 * a census is to fix the property, not to write a second, subtly different validator. The wrappers
 * below ({@link assertWriteRepo} and friends) exist only so the refusal carries a structured
 * {@link RepoWriteRefusalReason} instead of a message that says "readFileAtRef", never to soften
 * one. {@link assertWriteBranch} adds the three rules a BRANCH NAME needs on top of a ref's.
 */

// -------------------------------------------------------------------------------------------
// Refusals — structured, because a refusal must be assertable without pinning its wording
// -------------------------------------------------------------------------------------------

/**
 * Why a proposed repository write was refused. Every one of these is a REFUSAL, not a validation
 * failure: the fallthrough of a bug here is a commit on a user's branch, so each is stated as its
 * own reason with its own test rather than folded into a generic "invalid request".
 *
 * The reason exists so tests can assert the refusal that actually fired instead of matching on
 * prose. That is load-bearing for mutation-proving: `lockfile` and `not_a_known_manifest` both
 * refuse `go.sum`, so a test that asserted only "it threw" would stay green with the lockfile check
 * deleted — green for the wrong reason. Asserting the reason code fails the moment the specific
 * control is removed.
 */
export type RepoWriteRefusalReason =
  // --- URL safety, inherited from the read path -------------------------------------------
  /** `repo` failed `assertSafeRepo` — traversal, query injection, or a bad segment charset. */
  | "unsafe_repo"
  /** `path` failed `assertSafeRepoPath` — traversal, leading `/`, backslash, empty segment. */
  | "unsafe_path"
  /** The BASE ref failed `assertSafeRef`. */
  | "unsafe_base_ref"
  /** The branch to write failed `assertSafeRef` or the additional plain-branch-name rules. */
  | "unsafe_branch"
  // --- What may be written, and where ------------------------------------------------------
  /** The target is a lockfile. Manifest-only; a class needing lockfile resolution is CI. */
  | "lockfile"
  /** The target basename is not a manifest this ecosystem is edited through. */
  | "not_a_known_manifest"
  /** The target is not one of the manifest paths the component's own inventory declares. */
  | "not_declared_by_component"
  /** The branch to write IS the base ref — a write to the branch the PR would target. */
  | "branch_is_base_ref"
  /** A commit id that is not a full-length hex object id. Its only use is as a MERGE PRECONDITION,
   *  where an abbreviated or malformed value is the difference between "merge exactly this tree"
   *  and "merge whatever the branch happens to be at now". */
  | "unsafe_commit"
  // --- What the edit itself may be ----------------------------------------------------------
  /** Base and edited content are byte-identical: there is nothing to propose. */
  | "content_unchanged"
  /** Content exceeds the shared decode/transfer bound. */
  | "content_too_large"
  /** Content is not text (a NUL byte) — a manifest never is. */
  | "content_not_text"
  /** More than one LINE differs between base and edit. */
  | "multiple_lines_changed"
  /** The BASE content does not parse as its declared manifest format. */
  | "unparseable_base"
  /** The EDITED content does not parse as its declared manifest format. */
  | "unparseable_edit"
  /** The set of declared dependencies is not identical (added, removed, reordered, re-scoped). */
  | "dependency_set_changed"
  /** No dependency's version differs — the edit changed something else. */
  | "no_version_changed"
  /** More than one dependency's version differs. */
  | "multiple_versions_changed"
  /** The declared constraint KIND changed (a range rewritten as a pin, or vice versa). */
  | "constraint_kind_changed"
  /** The dependency carries no bumpable version (`unpinned`/`unresolved`). */
  | "unbumpable_constraint"
  /** The declaration is pinned by a DIGEST as well as a tag, and only the tag moved. A container
   *  runtime resolves by digest whenever one is present, so the deployed bytes would not change —
   *  the pull request reads as an upgrade and delivers nothing, and the manifest is left
   *  self-contradictory (a tag naming one release beside a digest naming another's bytes). */
  | "digest_pin_not_moved"
  /** The dependency that changed is not the one this subscription is for. */
  | "coordinate_not_expected"
  /** The subscribed coordinate is not declared by this manifest at all. */
  | "coordinate_not_declared"
  /** The textual change is not confined to the dependency's own version text. */
  | "edit_outside_version_text"
  /** A commit message / PR title / PR body exceeds its bound. */
  | "message_too_large"
  // --- The proof ----------------------------------------------------------------------------
  /** Content reached the write path without a proof that {@link verifyManifestOnlyEdit} minted. */
  | "proof_mismatch";

/** A refused repository write. Carries the structured {@link RepoWriteRefusalReason}. */
export class RepoWriteRefusal extends Error {
  readonly reason: RepoWriteRefusalReason;
  constructor(reason: RepoWriteRefusalReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RepoWriteRefusal";
    this.reason = reason;
  }
}

export function isRepoWriteRefusal(err: unknown): err is RepoWriteRefusal {
  return err instanceof RepoWriteRefusal;
}

function refuse(reason: RepoWriteRefusalReason, message: string, cause?: unknown): never {
  throw new RepoWriteRefusal(reason, message, cause);
}

// -------------------------------------------------------------------------------------------
// URL safety on the write path — the READ path's asserts, reused verbatim
// -------------------------------------------------------------------------------------------

/**
 * Runs the read path's own `assertSafeRepo` and re-throws its refusal with a write-path reason
 * code.
 *
 * The delegation is the point. `assertSafeRepo` is where the `..`-segment and `?`-termination
 * refusals were proven and where the `[A-Za-z0-9._-]` charset lives; a second validator written for
 * the write path would be the same class of mistake that produced those holes in the first place —
 * a fix applied to an instance rather than to the property (CLAUDE.md, census-by-property). Only the
 * message is restated, because `assertSafeRepo`'s says "readFileAtRef" and this is not a read.
 */
export function assertWriteRepo(provider: string, repo: string, exactSegments?: number): void {
  try {
    assertSafeRepo(provider, repo, exactSegments);
  } catch (err) {
    refuse(
      "unsafe_repo",
      `${provider} repo write: repo '${repo}' is refused — ${messageOf(err)}`,
      err
    );
  }
}

/** As {@link assertWriteRepo}, for the file path. Delegates to `assertSafeRepoPath`. */
export function assertWritePath(provider: string, path: string): void {
  try {
    assertSafeRepoPath(provider, path);
  } catch (err) {
    refuse(
      "unsafe_path",
      `${provider} repo write: path '${path}' is refused — ${messageOf(err)}`,
      err
    );
  }
}

/** As {@link assertWriteRepo}, for the BASE ref a branch is cut from. Delegates to `assertSafeRef`. */
export function assertWriteBaseRef(provider: string, ref: string): void {
  try {
    assertSafeRef(provider, ref);
  } catch (err) {
    refuse(
      "unsafe_base_ref",
      `${provider} repo write: base ref '${ref}' is refused — ${messageOf(err)}`,
      err
    );
  }
}

/**
 * Everything `assertSafeRef` refuses, plus the three rules a BRANCH NAME needs that a ref in general
 * does not. Returns the reason prose, or `undefined` when the name is a plain branch name.
 *
 *  1. **No `refs/` prefix.** The create-branch call takes a plain branch name and composes
 *     `refs/heads/<name>` itself (GitHub's `POST git/refs` wants the fully-qualified ref in the
 *     body). A caller passing `refs/heads/x` would otherwise produce `refs/heads/refs/heads/x`.
 *  2. **Not `HEAD`.** `HEAD` is a symbolic ref, not a branch; writing "the branch HEAD" is a
 *     request whose meaning depends on the server's current checkout.
 *  3. **No leading `-`.** A branch name is echoed into git plumbing and CLI arguments downstream of
 *     SCP (the org's own CI, a maintainer's `git fetch`), where a leading dash is read as a flag.
 *     Refused here rather than escaped at each future consumer.
 *
 * Factored out rather than inlined because BOTH branch names this class handles need it — the bump
 * branch and the base branch — while carrying different reason codes. Two copies of these three
 * rules is how one of them acquires a fourth.
 */
function branchRuleViolation(branch: string): string | undefined {
  if (branch.startsWith("refs/")) {
    return `'${branch}' must be a plain branch name, not a fully-qualified ref — the provider call composes the 'refs/heads/' prefix itself`;
  }
  if (branch === "HEAD") {
    return "'HEAD' is a symbolic ref, not a branch";
  }
  if (branch.startsWith("-")) {
    return `'${branch}' begins with '-', which downstream git plumbing and CLIs read as a flag`;
  }
  return undefined;
}

/** The branch a bump is WRITTEN to. See {@link branchRuleViolation} for the three extra rules. */
export function assertWriteBranch(provider: string, branch: string): void {
  try {
    assertSafeRef(provider, branch);
  } catch (err) {
    refuse(
      "unsafe_branch",
      `${provider} repo write: branch '${branch}' is refused — ${messageOf(err)}`,
      err
    );
  }
  const violation = branchRuleViolation(branch);
  if (violation) {
    refuse("unsafe_branch", `${provider} repo write: branch ${violation} — refused`);
  }
}

/**
 * The base BRANCH: what the bump is cut from and what the pull request targets.
 *
 * Stricter than {@link assertWriteBaseRef} on purpose, and this distinction is the one place the
 * relocation could have quietly lost a refusal. `assertSafeRef` is a rule about REFS IN GENERAL, so
 * it permits `--force` (a legal, if unwise, ref name) — the leading-dash refusal is a BRANCH rule.
 * The base of a bump is always a branch: it is looked up as `heads/<name>` and sent as a pull
 * request's `base`. So it gets the branch rules, while keeping its own reason code, because "the
 * base you named is not usable" and "the branch we would author is not usable" are different
 * operator problems.
 *
 * {@link assertWriteBaseRef} remains for the general ref position (reading a file at a ref), where a
 * tag or a commit sha is a legitimate answer and a branch rule would be wrong.
 */
export function assertWriteBaseBranch(provider: string, branch: string): void {
  assertWriteBaseRef(provider, branch);
  const violation = branchRuleViolation(branch);
  if (violation) {
    refuse("unsafe_base_ref", `${provider} repo write: base branch ${violation} — refused`);
  }
}

/**
 * The bump branch may never BE the base ref. Checked wherever both names are known, because it is
 * the refusal that keeps the class "propose" rather than "apply": delivery is a pull request
 * (PROJECT_CHARTER `scp-managed-dep`; ADR-0032 §8), and a commit written straight to the branch the
 * pull request would have targeted is the default-branch write this whole design exists to avoid.
 * Auto-merge is a separate, governed control over an OPEN pull request; it never becomes a direct
 * write.
 */
export function assertBranchIsNotBase(provider: string, branch: string, baseRef: string): void {
  if (branch === baseRef) {
    refuse(
      "branch_is_base_ref",
      `${provider} repo write: the bump branch and the base ref are both '${baseRef}'. A bump is DELIVERED as a pull request; it is never committed to the branch it would target`
    );
  }
}

/**
 * The commit id a MERGE is conditioned on.
 *
 * This is not URL safety — the value is a request-body field, never a route segment. It is a
 * PRECONDITION guard, and its shape is the control: GitHub's merge endpoint refuses the merge when
 * its `sha` parameter does not equal the pull request's current head, which is the mechanism that
 * turns "a governed control evidenced commit X" into "the tree that merged IS commit X". A shortened
 * sha would not match that head and would fail the merge for the wrong reason (looking like a
 * provider refusal rather than a malformed request), and an empty string would be dropped from the
 * body and silently remove the precondition altogether — the fail-OPEN this exists to prevent.
 *
 * Full-length hex only, both cases accepted (providers spell object ids either way), 40 for SHA-1
 * and 64 for SHA-256 repositories.
 */
export function assertWriteCommit(provider: string, commit: string): void {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commit)) {
    refuse(
      "unsafe_commit",
      `${provider} repo write: '${commit}' is not a full-length hex commit id — a merge precondition must name exactly one tree, and an abbreviated or malformed id would silently stop being a precondition`
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -------------------------------------------------------------------------------------------
// WHAT MAY BE EDITED — lockfiles, manifests, and the component's own declared set
// -------------------------------------------------------------------------------------------

/**
 * Lockfile basenames, refused outright.
 *
 * This list is deliberately WIDER than the five ecosystems M21 parses. A denylist that only refuses
 * has no cost for being generous, and the failure it prevents — SCP rewriting a resolved dependency
 * graph it did not resolve — is the same failure in an ecosystem M21 has not reached yet.
 *
 * The check is INDEPENDENT of the manifest allowlist rather than derived from it, which matters for
 * a reason that is easy to talk yourself out of: today no lockfile could pass the manifest allowlist
 * anyway (`go.sum` is not `go.mod`), so this looks redundant. It is not — the allowlist is about "is
 * this the file we edit", the lockfile rule is about "is this a file we may never touch", and they
 * answer to different clauses of the charter. Collapsing them would mean a future relaxation of the
 * allowlist silently relaxes the lockfile boundary too.
 */
export const LOCKFILE_BASENAMES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-lock.yml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "requirements.lock",
  "conda-lock.yml",
  "gemfile.lock",
  "cargo.lock",
  "composer.lock",
  "gradle.lockfile",
  "packages.lock.json",
  "mix.lock",
  "flake.lock",
  "deno.lock",
  "podfile.lock",
  "package.resolved",
  "pubspec.lock"
];

/** Structural lockfile shapes, so an ecosystem nobody enumerated is still refused. */
const LOCKFILE_PATTERNS: readonly RegExp[] = [
  /\.lock$/i,
  /\.lockb$/i,
  /\.lockfile$/i,
  /-lock\.(json|ya?ml)$/i,
  /\.lock\.(json|ya?ml)$/i
];

/** The basename of a repo-relative path (already validated — no backslashes, no empty segments). */
export function basenameOf(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}

/** Whether a basename names a lockfile — by the enumerated list or by structural shape. */
export function isLockfileName(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (LOCKFILE_BASENAMES.includes(lower)) return true;
  return LOCKFILE_PATTERNS.some((pattern) => pattern.test(lower));
}

/** A pure `content -> declarations` parser, the only shape `@scp/dependency-manifests` exposes. */
export type ManifestParser = (content: string) => DeclaredDependency[];

/**
 * The manifest basenames each ecosystem is edited THROUGH, and the parser that reads each one.
 *
 * Two ecosystems need a per-basename decision rather than a per-ecosystem one, which is why this is
 * keyed on the pair: `python` is `pyproject.toml` OR a `requirements*.txt` and those are different
 * parsers with different contracts (`parseRequirementsTxt` is the one export in the package that
 * never throws), and `oci` is spelled FIVE ways by TWO parsers — four Dockerfile spellings read by
 * `parseDockerfile`, and a chart's `values.yaml` read by `parseKubernetesImages`. That second one is
 * the reason the table is keyed on (ecosystem, basename) rather than on ecosystem alone: an image
 * pinned in Helm values and an image pinned in a `FROM` are the same `dependency_lines` row, and
 * only the file they were read out of differs.
 *
 * Being an ALLOWLIST is the charter clause "never edits a file that declares no dependency" made
 * structural. It is checked in addition to the component's own declared-manifest set, not instead of
 * it: the declared set comes from the inventory projection tables, which are derived and high-churn,
 * so a bug or a stale row there must not be able to widen what kind of file SCP writes. (They were
 * also described as "per-domain" here, quoting ADR-0032 §3; §7d reverses that — they are derived on
 * the commander only. It changes nothing about this allowlist's reason for existing, which is that a
 * DERIVED set must not decide what SCP writes.)
 */
const MANIFEST_MATCHERS: ReadonlyArray<{
  ecosystem: DependencyEcosystem;
  matches: (basename: string) => boolean;
  parser: ManifestParser;
  /** For the refusal message: what this ecosystem's manifests are actually called. */
  spelling: string;
}> = [
  {
    ecosystem: "npm",
    matches: (b) => b === "package.json",
    parser: parsePackageJson,
    spelling: "package.json"
  },
  { ecosystem: "go", matches: (b) => b === "go.mod", parser: parseGoMod, spelling: "go.mod" },
  { ecosystem: "maven", matches: (b) => b === "pom.xml", parser: parsePomXml, spelling: "pom.xml" },
  {
    ecosystem: "python",
    matches: (b) => b === "pyproject.toml",
    parser: parsePyprojectToml,
    spelling: "pyproject.toml"
  },
  {
    ecosystem: "python",
    matches: (b) => /^requirements[A-Za-z0-9._-]*\.txt$/.test(b),
    parser: parseRequirementsTxt,
    spelling: "requirements*.txt"
  },
  {
    ecosystem: "oci",
    // `Dockerfile`, `Containerfile`, `Dockerfile.prod`, `api.Dockerfile` — the four spellings in
    // ordinary use. Case-sensitive on the stem because that is how the files are actually named and
    // a case-insensitive match would also accept `dockerfile.lock`-shaped names for no gain.
    matches: (b) =>
      b === "Dockerfile" ||
      b === "Containerfile" ||
      b.startsWith("Dockerfile.") ||
      b.endsWith(".Dockerfile"),
    parser: parseDockerfile,
    spelling: "Dockerfile / Containerfile"
  },
  {
    ecosystem: "oci",
    // M21.7 SPLIT-SHAPE ROUND. A chart's `values.yaml` was inventoried but deliberately NOT
    // writable, because `verifyManifestBump`'s clause 3 required the changed line to name the
    // coordinate and in `image: {repository, tag}` it names it on the line above. That clause now
    // has an anchored alternative ({@link locateVersionLine}, `bump-edit.ts`'s anchored branch), so
    // the allowlist opens — and it opens on EXACTLY the basename the ingestion side registers
    // (`inventory-ingestion.ts`'s manifest-candidate map: `["values.yaml", parseKubernetesImages]`).
    // Not `values.yml`, not `*-values.yaml`: a path this allowlist admits and the inventory never
    // reads is a file SCP would write into without ever having declared a dependency in it.
    matches: (b) => b === "values.yaml",
    parser: parseKubernetesImages,
    spelling: "values.yaml"
  }
];

/** The names {@link MANIFEST_MATCHERS} accepts for one ecosystem — used only in refusal messages. */
function spellingsFor(ecosystem: DependencyEcosystem): string {
  return MANIFEST_MATCHERS.filter((m) => m.ecosystem === ecosystem)
    .map((m) => m.spelling)
    .join(" or ");
}

/**
 * The parser for a (ecosystem, path) pair, or a refusal.
 *
 * Refuses BEFORE anything else looks at the content, and in this order — lockfile first, then the
 * manifest allowlist — so the reason an operator is handed names the strongest rule the path broke.
 */
export function manifestParserFor(ecosystem: DependencyEcosystem, path: string): ManifestParser {
  const basename = basenameOf(path);
  if (isLockfileName(basename)) {
    refuse(
      "lockfile",
      `scp-managed-dep: '${path}' is a lockfile. This class is manifest-only: SCP never runs a package manager and never resolves or regenerates a lockfile (PROJECT_CHARTER 'scp-managed-dep'; ADR-0002 §3 gate 5 and the anti-CI corollary — a class needing lockfile resolution is CI by definition and is coordinated)`
    );
  }
  const matcher = MANIFEST_MATCHERS.find((m) => m.ecosystem === ecosystem && m.matches(basename));
  if (!matcher) {
    refuse(
      "not_a_known_manifest",
      `scp-managed-dep: '${path}' is not a ${ecosystem} dependency manifest (expected ${spellingsFor(ecosystem)}). SCP never edits a file that declares no dependency`
    );
  }
  return matcher.parser;
}

// -------------------------------------------------------------------------------------------
// WHICH LINE CARRIES THE DECLARED VERSION — the anchor, derived from the same bytes
// -------------------------------------------------------------------------------------------

/**
 * The line a bump must edit, when the coordinate is not written on it.
 *
 * DERIVED, NEVER TRANSPORTED. Nothing puts this on the wire, in `intent.parameters`, or in a
 * database column: it is computed by {@link locateVersionLine} from the manifest bytes the
 * orchestrator has just read at the base branch, and spent immediately against those same bytes.
 * A line number captured at INGESTION and spent at ACTUATION would be a number derived from a read
 * at one ref and applied to a read at another — a confidently wrong edit, which is the failure this
 * module exists to prevent (`split-shape-image-bumps.md` §2.2).
 *
 * `text` is what makes it safe to carry a number at all: it is COMPARED, never emitted. The edited
 * line is always rebuilt from the file's own bytes, so a wrong or stale descriptor can only cause a
 * REFUSAL, never a smuggled byte.
 */
export interface ManifestVersionAnchor {
  /** 1-based line number of the declaration's version text, as the registered parser reports it. */
  readonly line: number;
  /** The file's own bytes on that line, at derivation time. Compared byte-for-byte before any edit. */
  readonly text: string;
}

/**
 * WHERE IS THIS DECLARATION'S VERSION WRITTEN? — or `undefined`, which is never an error.
 *
 * ============================================================================================
 * WHY THIS IS HERE AND NOT IN `bump-edit.ts`
 * ============================================================================================
 * `bump-edit.ts` is a refusal, and its header's central warning is that a per-ecosystem rewriter
 * "that knew what a valid edit looked like would be a second implementation of the editor". A
 * LOCATOR is exactly that: it chooses the edit target, and a bug in it makes a wrong edit ACCEPTED
 * rather than a right one refused. So the structural knowledge stays in this file, which already
 * owns {@link MANIFEST_MATCHERS} and already parses both sides of every edit — one parser table, one
 * place, nothing to drift. What crosses into `bump-edit.ts` is DATA (a line number and its text) and
 * one branch, not a format.
 *
 * ============================================================================================
 * THE FIVE STEPS, AND WHY STEP 4 IS THE ONE THAT MAKES IT HONEST
 * ============================================================================================
 *  1. The parser for this (ecosystem, path) — the SAME allowlist entry the verifier will use, so an
 *     unlisted basename or a lockfile never reaches step 2. Its refusal is swallowed here (this
 *     function never throws) because `verifyManifestOnlyEdit` re-asks and refuses properly; a
 *     derivation that threw would turn a missing anchor into a failure mode of its own.
 *  2. The declarations whose coordinate AND declared version are exactly what the descriptor names.
 *  3. Exactly one, or NO anchor. Zero means the manifest disagrees with the inventory; more than one
 *     means the target is ambiguous, and choosing would be a guess about which the subscriber meant.
 *  4. It reports a line, and THE FILE'S OWN BYTES ON THAT LINE CONTAIN the declared version — else
 *     no anchor. This is what makes the derivation self-selecting rather than a per-format
 *     allowlist: `pom-xml.ts` records the line of the `<dependency>` OPEN TAG while the version sits
 *     several lines below it (the same fact this file's gate-5 comment already turns on), so a Maven
 *     declaration yields NO anchor and Maven's path cannot change. The anchor exists exactly where
 *     it is honest, by construction rather than by intention.
 *
 *     WHERE THAT LEAVES EACH ECOSYSTEM, enumerated because the useful claim is a map and not a
 *     slogan — "the working ecosystems are untouched BY CONSTRUCTION" was written here once and was
 *     false of four of them. AN ANCHOR IS DERIVED for `go` (go.mod), `python`'s `requirements*.txt`
 *     and `oci`'s Dockerfile: their parsers report the line the version is written on. NO ANCHOR is
 *     derived for `npm` and `python`'s `pyproject.toml` (steps 3–4: those parsers report no `line`
 *     at all) or for `maven` (step 4, above). What keeps the first three unchanged is therefore
 *     clause (c) of `verifyManifestBump` rather than the absence of an anchor: those parsers take
 *     the coordinate VERBATIM off the same line, so the anchor line names the coordinate too and is
 *     a candidate of the coordinate rule itself — the veto then admits it only when it is the sole
 *     candidate, which is the unanchored rule's own condition. The anchor cannot move the edit for
 *     them, because a line naming the coordinate is never a line the coordinate rule is silent
 *     about, and silence is the only gap an anchor fills.
 *  5. It is not a MERGED multi-site entry (`DeclaredDependency.occurrences > 1`). One values file
 *     can pin `acme/api:1.2.3` in a Deployment and in a CronJob; the parser merges them because the
 *     inventory row merges, and editing one line would leave the other behind. Refused here rather
 *     than downstream because it costs no container run and yields a legible reason — gate 5 would
 *     catch it anyway (one declaration before becomes two after → `dependency_set_changed`), which
 *     is fail-closed but illegible.
 *
 * ABSENCE IS NOT AN ERROR. A caller that gets `undefined` proceeds with the coordinate rule
 * unchanged; that is why every ecosystem that works today keeps working without a special case.
 */
export function locateVersionLine(
  before: string,
  spec: {
    readonly ecosystem: DependencyEcosystem;
    readonly manifestPath: string;
    readonly coordinate: string;
    readonly fromVersion: string;
  }
): ManifestVersionAnchor | undefined {
  let parser: ManifestParser;
  try {
    parser = manifestParserFor(spec.ecosystem, spec.manifestPath);
  } catch {
    return undefined;
  }
  let declarations: DeclaredDependency[];
  try {
    declarations = parser(before);
  } catch {
    return undefined;
  }
  const candidates = declarations.filter(
    (dep) => dep.coordinate === spec.coordinate && dep.declared === spec.fromVersion
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only === undefined) return undefined;
  // (step 5) A merged multi-site declaration has no single edit site, so it has no anchor.
  if ((only.occurrences ?? 1) !== 1) return undefined;
  const line = only.line;
  if (line === undefined || !Number.isInteger(line) || line < 1) return undefined;
  const text = before.split("\n")[line - 1];
  // (step 4) The parser's line must actually carry the version text the edit replaces.
  if (text === undefined || !text.includes(spec.fromVersion)) return undefined;
  return { line, text };
}

/**
 * The target must be a manifest the component's own inventory ALREADY records — "a manifest the
 * component already contains", in the charter's words.
 *
 * Compared verbatim, with no normalisation: the inventory stores `manifest_path` exactly as the
 * ingestion read it, and a comparison that trimmed, case-folded or resolved `./` here would accept a
 * path the inventory does not actually hold. An empty declared set refuses everything, which is the
 * correct answer for a component with no ingested manifests — absence is never permission.
 */
export function assertDeclaredManifest(
  path: string,
  declaredManifestPaths: readonly string[]
): void {
  if (!declaredManifestPaths.includes(path)) {
    refuse(
      "not_declared_by_component",
      `scp-managed-dep: '${path}' is not one of the manifest paths this component declares (${declaredManifestPaths.length === 0 ? "it declares none" : declaredManifestPaths.join(", ")}). The edit must target a manifest the component already contains`
    );
  }
}

// -------------------------------------------------------------------------------------------
// THE MANIFEST-ONLY PROOF
// -------------------------------------------------------------------------------------------

/**
 * Per-process HMAC key for {@link ManifestEditProof}. Minted at import, never exported, never
 * persisted.
 *
 * This is what makes the proof a control rather than a label. A plain object — even a branded one —
 * can be constructed by any caller with an `as` cast, so a `proof` field would document an intent
 * without enforcing it. Signed with a key only this module holds, a proof can be minted ONLY by
 * {@link verifyManifestOnlyEdit}, and {@link assertManifestEditProof} — which the write path calls
 * before it issues the commit — refuses anything else. That is the difference between "the actuator
 * is supposed to check" and "content that did not pass the check cannot reach a repo".
 *
 * The key is per-process, so verifier and writer must run in the same process. They do: both are
 * this package, loaded once into one plugin subprocess. If that ever stops being true the signature
 * fails to verify and the write is REFUSED — the failure mode is closed, not open.
 */
const PROOF_KEY = randomBytes(32);

/**
 * Evidence that a specific edited manifest passed {@link verifyManifestOnlyEdit}. Carried into the
 * write and re-checked there.
 *
 * It names the FACTS the verifier established, so a Decision can quote them (charter principle 6):
 * which coordinate moved, from what to what, in which file. `contentSha256` is over the exact bytes
 * that may be written — the proof does not travel with the content, it BINDS to it.
 */
export interface ManifestEditProof {
  /**
   * WHICH REPOSITORY AND WHICH BRANCH these bytes were verified FOR.
   *
   * They are in the proof because the guarantee it states is "these bytes may be written", and a
   * write has a destination. Without them the proof bound path + content and said nothing about
   * where they were going, so a proof minted for `acme/widget@scp/dep-bump/<id>` verified cleanly
   * against a publish to a different repository, or to the BASE branch, at the same path — the
   * guarantee was one field short of what it claimed. `publishBump` re-checks both against the
   * target it is about to send to, which is the only place the pairing is observable.
   */
  readonly repo: string;
  readonly headBranch: string;
  readonly path: string;
  readonly ecosystem: DependencyEcosystem;
  readonly coordinate: string;
  readonly fromDeclared: string;
  readonly toDeclared: string;
  /** SHA-256 (hex) of the edited content this proof authorises, and of nothing else. */
  readonly contentSha256: string;
  /** HMAC over the fields above under {@link PROOF_KEY}. Not forgeable outside this module. */
  readonly signature: string;
}

function proofPayload(proof: Omit<ManifestEditProof, "signature">): string {
  // Length-prefixed so no two different field tuples can serialise to the same string.
  return [
    proof.repo,
    proof.headBranch,
    proof.path,
    proof.ecosystem,
    proof.coordinate,
    proof.fromDeclared,
    proof.toDeclared,
    proof.contentSha256
  ]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

function signProof(proof: Omit<ManifestEditProof, "signature">): string {
  return createHmac("sha256", PROOF_KEY).update(proofPayload(proof)).digest("hex");
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Re-checks a proof against the content and path the write path is about to send. Called before any
 * request that carries content.
 *
 * Three independent checks, because each catches a different mistake: the path check catches a proof
 * minted for a different file in the same run; the content hash catches content mutated after
 * verification (the whole point of binding rather than trusting); the signature catches a proof that
 * never came from {@link verifyManifestOnlyEdit} at all. `timingSafeEqual` is used for the signature
 * because it is a MAC comparison, and its length-mismatch throw is caught and treated as a refusal —
 * fail-closed either way.
 */
export function assertManifestEditProof(
  provider: string,
  input: {
    /** The repository the write is about to go to. */
    repo: string;
    /** The branch the write is about to go to. */
    headBranch: string;
    path: string;
    content: string;
    proof: ManifestEditProof;
  }
): void {
  const { repo, headBranch, path, content, proof } = input;
  // WHERE, before WHAT. A proof states that specific bytes may be written to a specific file on a
  // specific branch of a specific repository; checking only the last two would accept a proof minted
  // for another destination in the same run.
  if (proof.repo !== repo) {
    refuse(
      "proof_mismatch",
      `${provider} repo write: the manifest-only proof was minted for repository '${proof.repo}' but the write targets '${repo}' — refused`
    );
  }
  if (proof.headBranch !== headBranch) {
    refuse(
      "proof_mismatch",
      `${provider} repo write: the manifest-only proof was minted for branch '${proof.headBranch}' but the write targets '${headBranch}' — refused`
    );
  }
  if (proof.path !== path) {
    refuse(
      "proof_mismatch",
      `${provider} repo write: the manifest-only proof was minted for '${proof.path}' but the write targets '${path}' — refused`
    );
  }
  if (proof.contentSha256 !== sha256Hex(content)) {
    refuse(
      "proof_mismatch",
      `${provider} repo write: the content to be written is not the content verifyManifestOnlyEdit checked (sha-256 differs) — refused`
    );
  }
  const expected = Buffer.from(
    signProof({
      repo: proof.repo,
      headBranch: proof.headBranch,
      path: proof.path,
      ecosystem: proof.ecosystem,
      coordinate: proof.coordinate,
      fromDeclared: proof.fromDeclared,
      toDeclared: proof.toDeclared,
      contentSha256: proof.contentSha256
    }),
    "utf8"
  );
  const provided = Buffer.from(proof.signature, "utf8");
  let ok = false;
  try {
    ok = expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    ok = false;
  }
  if (!ok) {
    refuse(
      "proof_mismatch",
      `${provider} repo write: the manifest-only proof carries no valid signature — it was not minted by verifyManifestOnlyEdit in this process. Refused`
    );
  }
}

/** What {@link verifyManifestOnlyEdit} is asked to prove. */
export interface ManifestOnlyEditInput {
  /** The repository the verified bytes are authorised for — carried into the proof, see
   *  {@link ManifestEditProof.repo}. */
  repo: string;
  /** The branch the verified bytes are authorised for. Never the base branch: `assertBranchIsNotBase`
   *  refuses that pairing at the descriptor and again at the splice site, and binding it here means a
   *  proof cannot be re-aimed at one either. */
  headBranch: string;
  /** Repo-relative path of the manifest being edited. */
  path: string;
  /** Every manifest path this component's inventory declares (ADR-0032 §3 projection rows). */
  declaredManifestPaths: readonly string[];
  ecosystem: DependencyEcosystem;
  /** The manifest exactly as read at the base ref. */
  baseContent: string;
  /** The proposed manifest, as the isolated runner produced it. */
  newContent: string;
  /** The dependency coordinate this subscription is bumping — the ONE that may change. */
  coordinate: string;
}

/**
 * Proves an edit is a version-string-only change to one already-declared dependency, or refuses.
 *
 * ============================================================================================
 * WHY IT RE-PARSES INSTEAD OF TRUSTING THE AUTHOR
 * ============================================================================================
 * Whoever authored `newContent` is not the subject of this check; the BYTES are. Re-parsing both
 * sides with M21.2's own parsers and comparing the declaration sets means the guarantee holds for
 * any authoring strategy — including the isolated runner being rebuilt wrong, replaced, or simply
 * handed a manifest whose grammar its editor mis-parses — and it holds against a BUG in the author
 * rather than only against a malicious one.
 *
 * This is the SECOND of the two verifiers this package runs, and they are not redundant: `bump-edit`'s
 * `verifyManifestBump` is a TEXTUAL reconstruction anchored on the descriptor (does replacing
 * `fromVersion` with `toVersion` on the changed line reproduce it exactly?), while this one is a
 * PARSE anchored on the document (is the declared dependency set identical, and did exactly one
 * already-declared version move?). Each catches what the other structurally cannot: the textual one
 * catches a runner that edited the right line wrongly; this one catches a runner that produced a
 * document declaring something different while passing the line test. Only this one mints the proof,
 * so this one is the gate.
 *
 * ============================================================================================
 * THE SEVEN GATES, AND WHY EACH IS SEPARATELY NECESSARY
 * ============================================================================================
 *  1. **Path**: not a lockfile, a known manifest for the ecosystem, and one the component declares.
 *  2. **Content bounds**: non-empty, within the shared byte ceiling, text (no NUL), and actually
 *     different from the base — a no-op write would open a PR that proposes nothing.
 *  3. **One line**: exactly one line of the file differs. A version-string edit never spans lines,
 *     and this is the gate that refuses the "bump a version AND add a `postinstall` script" shape
 *     with a message that names what happened.
 *  4. **Both sides parse**: an unparseable side is refused rather than treated as "declares
 *     nothing" — the collapse `@scp/dependency-manifests` exists to prevent.
 *  5. **The dependency set is identical**: same count, and element-for-element equal on coordinate,
 *     scope, declaredIn and line. This is the charter's "never adds or removes a dependency", and
 *     comparing positionally also refuses a REORDER, which is not a version edit either.
 *  6. **Exactly one version differs, and it is the subscribed one**: with an unchanged constraint
 *     KIND, from a constraint that has a version to change, and — where the declaration is pinned
 *     TWICE — with its digest moved alongside its tag. Refusing a constraint-kind change is not
 *     fussiness: `>=2.0` → `==2.31.0` rewrites a range as a pin, which `types.ts` names as the
 *     thing an actuator must not do, and `unpinned` → `pinned` would be ADDING a version the author
 *     never wrote. The digest clause is the one refusal here that catches an edit which is
 *     structurally perfect and OPERATIONALLY A NO-OP: `alpine:3.19@sha256:…` and a chart's
 *     `{tag, digest}` are both resolved BY DIGEST, so moving the tag alone changes the file and not
 *     the running image (`digest_pin_not_moved`).
 *  7. **The change is confined to the version text**: the one differing region, measured as the span
 *     between the common prefix and the common suffix, must lie inside the dependency's own declared
 *     version text on each side. Gate 3 already refuses two changes on two lines; this refuses two
 *     changes on ONE line, which is the whole attack surface a minified `package.json` presents.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY *NOT* CHECKED, AND WHY
 * ============================================================================================
 * The changed LINE NUMBER is not required to equal the changed dependency's `line`. It looks like a
 * free extra binding and it is not: `pom-xml.ts` records the line of the `<dependency>` OPEN TAG
 * (`current = { line: tagLine }`), while the version sits several lines below it, so that check
 * would refuse every legitimate Maven bump. A rule that is right for four ecosystems and wrong for
 * the fifth is the provenance-label failure — a label named after the branch that happened to match.
 * Gates 5 and 7 already bind the textual change to the parsed entry without it.
 */
export function verifyManifestOnlyEdit(input: ManifestOnlyEditInput): ManifestEditProof {
  const { path, ecosystem, baseContent, newContent, coordinate } = input;

  // --- Gate 1: the path -------------------------------------------------------------------
  const parser = manifestParserFor(ecosystem, path);
  assertDeclaredManifest(path, input.declaredManifestPaths);

  // --- Gate 2: the content bounds ---------------------------------------------------------
  for (const [label, content] of [
    ["base", baseContent],
    ["edited", newContent]
  ] as const) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > HARD_MAX_FILE_BYTES) {
      refuse(
        "content_too_large",
        `scp-managed-dep: ${label} content for '${path}' is ${bytes} bytes, over the ${HARD_MAX_FILE_BYTES}-byte ceiling`
      );
    }
    if (content.includes("\u0000")) {
      refuse(
        "content_not_text",
        `scp-managed-dep: ${label} content for '${path}' contains a NUL byte — a dependency manifest is text, and binary content is never written`
      );
    }
  }
  if (baseContent === newContent) {
    refuse(
      "content_unchanged",
      `scp-managed-dep: the edited '${path}' is byte-identical to the base — there is no bump to propose`
    );
  }

  // --- Gate 3: exactly one line differs ---------------------------------------------------
  const baseLines = baseContent.split("\n");
  const newLines = newContent.split("\n");
  if (baseLines.length !== newLines.length) {
    refuse(
      "multiple_lines_changed",
      `scp-managed-dep: '${path}' changed from ${baseLines.length} lines to ${newLines.length} — a version-string edit adds and removes no lines`
    );
  }
  const changedLineIndexes: number[] = [];
  for (let i = 0; i < baseLines.length; i++) {
    if (baseLines[i] !== newLines[i]) changedLineIndexes.push(i);
  }
  if (changedLineIndexes.length !== 1) {
    refuse(
      "multiple_lines_changed",
      `scp-managed-dep: ${changedLineIndexes.length} lines of '${path}' differ (${changedLineIndexes
        .slice(0, 5)
        .map((i) => i + 1)
        .join(
          ", "
        )}${changedLineIndexes.length > 5 ? ", …" : ""}) — a version-string edit changes exactly one`
    );
  }

  // --- Gate 4: both sides parse -----------------------------------------------------------
  const baseDeps = parseOrRefuse(parser, baseContent, path, ecosystem, "unparseable_base", "base");
  const newDeps = parseOrRefuse(parser, newContent, path, ecosystem, "unparseable_edit", "edited");

  // --- Gate 5: the dependency SET is identical --------------------------------------------
  if (baseDeps.length !== newDeps.length) {
    refuse(
      "dependency_set_changed",
      `scp-managed-dep: '${path}' declares ${baseDeps.length} dependencies at base and ${newDeps.length} after the edit — SCP never adds or removes a dependency`
    );
  }
  const changedIndexes: number[] = [];
  for (let i = 0; i < baseDeps.length; i++) {
    const before = baseDeps[i] as DeclaredDependency;
    const after = newDeps[i] as DeclaredDependency;
    if (
      before.coordinate !== after.coordinate ||
      before.ecosystem !== after.ecosystem ||
      before.scope !== after.scope ||
      before.declaredIn !== after.declaredIn ||
      before.line !== after.line
    ) {
      refuse(
        "dependency_set_changed",
        `scp-managed-dep: declaration ${i + 1} of '${path}' changed identity — '${before.coordinate}' (${before.scope}, ${before.declaredIn}) became '${after.coordinate}' (${after.scope}, ${after.declaredIn}). SCP never adds, removes, re-scopes or reorders a dependency`
      );
    }
    if (before.declared !== after.declared || before.digest !== after.digest) {
      changedIndexes.push(i);
    }
  }

  // --- Gate 6: exactly one version differs, and it is the subscribed one -------------------
  if (changedIndexes.length === 0) {
    refuse(
      "no_version_changed",
      `scp-managed-dep: one line of '${path}' changed but no declared dependency version did — the edit changed something other than a version`
    );
  }
  if (changedIndexes.length > 1) {
    refuse(
      "multiple_versions_changed",
      `scp-managed-dep: ${changedIndexes.length} declared versions in '${path}' differ — one bump changes exactly one`
    );
  }
  const changedIndex = changedIndexes[0] as number;
  const before = baseDeps[changedIndex] as DeclaredDependency;
  const after = newDeps[changedIndex] as DeclaredDependency;

  // Order matters here and is not cosmetic. "This manifest never declared the thing you are
  // bumping" is a stronger and more actionable statement than "something else moved", and checking
  // it SECOND would make it unreachable: a changed coordinate that equals the subscribed one
  // already proves the base declares it.
  if (!baseDeps.some((dep) => dep.coordinate === coordinate)) {
    refuse(
      "coordinate_not_declared",
      `scp-managed-dep: '${path}' declares no dependency on '${coordinate}' at base — SCP never adds a dependency`
    );
  }
  if (before.coordinate !== coordinate) {
    // The subscription names the line being bumped. A different coordinate moving means the edit is
    // not the bump that was authorised, even though it is structurally a valid one.
    refuse(
      "coordinate_not_expected",
      `scp-managed-dep: this bump is for '${coordinate}' but the version that changed in '${path}' is '${before.coordinate}' — refused`
    );
  }
  if (before.constraint !== after.constraint) {
    refuse(
      "constraint_kind_changed",
      `scp-managed-dep: '${coordinate}' in '${path}' changed constraint kind from '${before.constraint}' to '${after.constraint}' — rewriting a range as a pin (or the reverse) restates the author's declaration rather than bumping it`
    );
  }
  if (before.constraint !== "pinned" && before.constraint !== "range") {
    refuse(
      "unbumpable_constraint",
      `scp-managed-dep: '${coordinate}' in '${path}' is '${before.constraint}' — there is no declared version to change (an unpinned or unresolved declaration would have to be AUTHORED, not bumped)`
    );
  }
  const fromDeclared = before.declared;
  const toDeclared = after.declared;
  if (fromDeclared === undefined || toDeclared === undefined) {
    refuse(
      "unbumpable_constraint",
      `scp-managed-dep: '${coordinate}' in '${path}' carries no declared version text on ${fromDeclared === undefined ? "the base" : "the edited"} side`
    );
  }
  // A TAG MOVED WHILE ITS DIGEST STAYED — the bump that silently changes nothing (ADR-0032 §8h).
  //
  // Both `oci` spellings can pin twice: `FROM alpine:3.19@sha256:…` in a Dockerfile, and
  // `{repository, tag, digest}` in a chart's values. Where both are present the digest WINS —
  // containerd and Docker resolve by digest and the tag becomes a label — so moving the tag alone
  // leaves the deployed bytes exactly where they were, while the pull request reads as an upgrade
  // and the manifest now says two different things about which release it wants.
  //
  // Refused rather than half-applied, and refused rather than guessed at: the digest for the new
  // version IS available upstream (`dependency_lines.latest_digest`, resolved by the same poll that
  // moved `latest_version`), but moving both is a TWO-LINE edit in the split shape, and clause 2 of
  // `verifyManifestBump` — "exactly ONE line differs" — is a charter-enforcing refusal that does
  // not get widened to a pair as a side effect of this one. So the tag-only edit is refused with
  // its own name, which is the "skipped rather than guessed" rule (ADR-0032 §7) applied to an
  // actuation instead of to a reading. `split-shape-image-bumps.md` §11 carries the follow-up.
  //
  // The condition is deliberately "the digest did not move", not "a digest exists": an edit that
  // moves the tag AND its digest together is a correct bump and is accepted (a named test drives
  // exactly that literal), and so is a digest-only move.
  if (
    before.digest !== undefined &&
    before.digest === after.digest &&
    fromDeclared !== toDeclared
  ) {
    refuse(
      "digest_pin_not_moved",
      `scp-managed-dep: '${coordinate}' in '${path}' is pinned by a digest as well as a tag, and only the tag moved ('${fromDeclared}' -> '${toDeclared}', digest still '${before.digest}'). A container runtime resolves by digest whenever one is present, so this edit would change the manifest and NOT the image that runs — a pull request that reads as an upgrade and delivers nothing. Re-pin the digest for '${toDeclared}' and the tag together, or drop the digest`
    );
  }

  // --- Gate 7: the textual change is confined to the version text --------------------------
  assertChangeConfinedToVersionText(path, coordinate, baseContent, newContent, before, after);

  const unsigned = {
    repo: input.repo,
    headBranch: input.headBranch,
    path,
    ecosystem,
    coordinate,
    fromDeclared,
    toDeclared,
    contentSha256: sha256Hex(newContent)
  };
  return { ...unsigned, signature: signProof(unsigned) };
}

function parseOrRefuse(
  parser: ManifestParser,
  content: string,
  path: string,
  ecosystem: DependencyEcosystem,
  reason: RepoWriteRefusalReason,
  label: string
): DeclaredDependency[] {
  try {
    return parser(content);
  } catch (err) {
    refuse(
      reason,
      `scp-managed-dep: the ${label} '${path}' does not parse as a ${ecosystem} manifest (${messageOf(err)}). An unreadable manifest is refused, never treated as declaring nothing`,
      err
    );
  }
}

/**
 * The version text of a declaration AS IT APPEARS IN THE FILE.
 *
 * For every ecosystem but `oci` that is just `declared`. For `oci` the parser splits one literal
 * `alpine:3.19@sha256:…` into `declared: "3.19"` and `digest: "sha256:…"`, and a tag bump legitimately
 * moves BOTH — so the text a change may occupy is the two rejoined by the `@` the file itself uses.
 * This is reconstruction of a literal, not invention: it is exactly the substring the Dockerfile
 * contains.
 */
function versionTextOf(dep: DeclaredDependency): string {
  if (dep.declared !== undefined && dep.digest !== undefined) {
    return `${dep.declared}@${dep.digest}`;
  }
  return dep.declared ?? dep.digest ?? "";
}

/**
 * Refuses any textual change that reaches outside the dependency's own version text.
 *
 * The differing region is measured, not guessed: the longest common prefix and the longest
 * non-overlapping common suffix bracket a single contiguous span, and everything that changed is
 * inside it. If that span is a substring of the base's version text, and its counterpart a substring
 * of the edit's, then no byte outside a version string moved.
 *
 * This is the gate that survives a minified manifest. Gate 3 (one line changed) is defeated by a
 * `package.json` written on a single line, where "bump react AND add a `postinstall` script" is one
 * line's worth of change; this one is not, because the resulting span contains the injected script
 * and no version string does.
 */
function assertChangeConfinedToVersionText(
  path: string,
  coordinate: string,
  baseContent: string,
  newContent: string,
  before: DeclaredDependency,
  after: DeclaredDependency
): void {
  let prefix = 0;
  const shortest = Math.min(baseContent.length, newContent.length);
  while (prefix < shortest && baseContent[prefix] === newContent[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    baseContent[baseContent.length - 1 - suffix] === newContent[newContent.length - 1 - suffix]
  ) {
    suffix++;
  }
  const baseSpan = baseContent.slice(prefix, baseContent.length - suffix);
  const newSpan = newContent.slice(prefix, newContent.length - suffix);
  const baseVersionText = versionTextOf(before);
  const newVersionText = versionTextOf(after);
  if (!baseVersionText.includes(baseSpan) || !newVersionText.includes(newSpan)) {
    refuse(
      "edit_outside_version_text",
      `scp-managed-dep: the change in '${path}' is not confined to the version text of '${coordinate}'. ` +
        `The bytes that differ are ${JSON.stringify(truncate(baseSpan))} → ${JSON.stringify(truncate(newSpan))}, ` +
        `which do not lie inside ${JSON.stringify(baseVersionText)} → ${JSON.stringify(newVersionText)}. ` +
        `Only a declared version may move`
    );
  }
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// -------------------------------------------------------------------------------------------
// Bounds on the text SCP writes into a repo alongside the manifest edit
// -------------------------------------------------------------------------------------------

export const MAX_COMMIT_MESSAGE_CHARS = 4096;
export const MAX_PR_TITLE_CHARS = 250;
export const MAX_PR_BODY_CHARS = 8192;

/** Refuses an over-long commit message / PR title / PR body before it reaches a provider. */
export function assertMessageBound(value: string, max: number, label: string): void {
  if (value.length > max) {
    refuse(
      "message_too_large",
      `scp-managed-dep: ${label} is ${value.length} characters, over the ${max}-character bound`
    );
  }
}

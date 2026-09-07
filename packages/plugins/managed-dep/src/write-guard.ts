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

/** The refusals that are the condition of being allowed at all. See docs/plugins.md §378. */

// Refusals — structured, because a refusal must be assertable without pinning its wording

/** Why a proposed repository write was refused. See docs/plugins.md §379. */
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

// URL safety on the write path — the READ path's asserts, reused verbatim

/** Runs the read path's own assert, with a write-path reason. See docs/plugins.md §380. */
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

/** Everything a ref refuses, plus three branch-name rules. See docs/plugins.md §381. */
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

/** The base BRANCH. See docs/plugins.md §382. */
export function assertWriteBaseBranch(provider: string, branch: string): void {
  assertWriteBaseRef(provider, branch);
  const violation = branchRuleViolation(branch);
  if (violation) {
    refuse("unsafe_base_ref", `${provider} repo write: base branch ${violation} — refused`);
  }
}

/** The bump branch may never BE the base ref. See docs/plugins.md §383. */
export function assertBranchIsNotBase(provider: string, branch: string, baseRef: string): void {
  if (branch === baseRef) {
    refuse(
      "branch_is_base_ref",
      `${provider} repo write: the bump branch and the base ref are both '${baseRef}'. A bump is DELIVERED as a pull request; it is never committed to the branch it would target`
    );
  }
}

/** The commit id a MERGE is conditioned on. This is not URL safety. See docs/plugins.md §384. */
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

// WHAT MAY BE EDITED — lockfiles, manifests, and the component's own declared set

/** Lockfile basenames, refused outright. See docs/plugins.md §385. */
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

/** The manifest basenames per ecosystem, and their parsers. See docs/plugins.md §386. */
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
    // M21.7 SPLIT-SHAPE ROUND. See docs/plugins.md §387.
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

/** The parser for a (ecosystem, path) pair, or a refusal. See docs/plugins.md §388. */
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

// WHICH LINE CARRIES THE DECLARED VERSION — the anchor, derived from the same bytes

/** The line a bump must edit: derived, never transported. See docs/plugins.md §389. */
export interface ManifestVersionAnchor {
  /** 1-based line number of the declaration's version text, as the registered parser reports it. */
  readonly line: number;
  /** The file's own bytes on that line, at derivation time. Compared byte-for-byte before any edit. */
  readonly text: string;
}

/** WHERE IS THIS DECLARATION'S VERSION WRITTEN? See docs/plugins.md §390. */
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

/** The target must be a manifest the inventory already records. See docs/plugins.md §391. */
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

// THE MANIFEST-ONLY PROOF

/** Per-process HMAC key for {@link ManifestEditProof}. See docs/plugins.md §392. */
const PROOF_KEY = randomBytes(32);

/** Evidence that an edited manifest passed verification. See docs/plugins.md §393. */
export interface ManifestEditProof {
  /** Which repository and branch these bytes were verified for. See docs/plugins.md §394. */
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

/** Re-checks a proof against what is about to be sent. See docs/plugins.md §395. */
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

/** Proves the edit is a version-only change, or refuses. See docs/plugins.md §396. */
export function verifyManifestOnlyEdit(input: ManifestOnlyEditInput): ManifestEditProof {
  const { path, ecosystem, baseContent, newContent, coordinate } = input;

  const parser = manifestParserFor(ecosystem, path);
  assertDeclaredManifest(path, input.declaredManifestPaths);

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
  // A TAG MOVED WHILE ITS DIGEST STAYED. See docs/plugins.md §397.
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

/** The version text of a declaration AS IT APPEARS IN THE FILE. See docs/plugins.md §398. */
function versionTextOf(dep: DeclaredDependency): string {
  if (dep.declared !== undefined && dep.digest !== undefined) {
    return `${dep.declared}@${dep.digest}`;
  }
  return dep.declared ?? dep.digest ?? "";
}

/** Refuses any change reaching outside the version text. See docs/plugins.md §399. */
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

// Bounds on the text SCP writes into a repo alongside the manifest edit

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

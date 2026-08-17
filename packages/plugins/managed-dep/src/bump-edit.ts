import type { DependencyEcosystem } from "@scp/dependency-manifests";

/**
 * THE MANIFEST-ONLY INVARIANT, AS CODE (charter `scp-managed-dep` amendment 2026-08-13, ADR-0032 §8).
 *
 * The charter defines this managed class by four prohibitions, not by a feature:
 *
 *   1. it edits "the declared version of an already-declared dependency in a manifest the component
 *      already contains";
 *   2. it "never authors any other content, never adds or removes a dependency, and never edits a
 *      file that declares no dependency";
 *   3. it "never runs a package manager, never resolves or regenerates a lockfile, and never builds,
 *      compiles, or tests";
 *   4. "a class that requires lockfile resolution is CI by definition and is coordinated, never
 *      managed".
 *
 * Prohibitions 3 and 4 are enforced by what the runner image CONTAINS (no package manager exists in
 * it) and by `--network none`. Prohibitions 1 and 2 are enforced HERE, and they have to be, because
 * they are properties of the BYTES rather than of the toolchain: a runner image that was rebuilt
 * wrong, replaced, or simply given a manifest whose grammar its editor mis-parses can produce a diff
 * that is not the edit the charter permits, and every layer above would have no way to tell.
 *
 * SO THIS MODULE IS A REFUSAL, NOT A HELPER. {@link verifyManifestBump} is run by the orchestrator
 * on the bytes the runner returned, BEFORE anything is pushed anywhere. A verdict other than `ok`
 * means nothing is written to the repository at all. It is deliberately ecosystem-agnostic and
 * deliberately textual: a per-ecosystem rewriter that "knew" what a valid edit looked like would be
 * a second implementation of the editor, and the two would drift — the point of a verifier is that
 * it agrees with the charter's sentence, not with the editor's intentions.
 *
 * WHY IT IS EXPRESSED AS "EXACTLY ONE LINE, AND ONLY ITS VERSION TOKEN". Every manifest this class
 * touches declares a dependency's version on ONE line — `"@acme/lib": "^1.2.3"` in a package.json,
 * `require github.com/acme/lib v1.2.3` in a go.mod, `FROM alpine:3.18` in a Dockerfile,
 * `acme-lib==1.4.0` in a requirements.txt. So "changed the declared version and nothing else" is
 * decidable without parsing any of them:
 *
 *   * the file has the SAME number of lines           -> nothing was added or removed;
 *   * exactly ONE line differs                        -> no other declaration was touched;
 *   * that line names the coordinate, OR is the line the descriptor ANCHORS to and the coordinate
 *     rule does not disagree                          -> the right declaration was touched;
 *   * replacing the from-version token with the to-version token in the BEFORE line reproduces the
 *     AFTER line EXACTLY                              -> only the version token changed.
 *
 * THE THIRD CLAUSE'S SECOND HALF IS M21.7'S SPLIT-SHAPE WIDENING, and it is worth stating why it is
 * not a loosening. Helm's commonest image spelling puts the coordinate and the version on DIFFERENT
 * lines (`repository: acme/api` above `tag: 1.2.3`), and for `{registry, repository, tag}` the
 * coordinate is a CONSTRUCTION that appears nowhere in the file contiguously — so clause 3 as first
 * written could never be satisfied, and the charter's own sentence ("the declared version of an
 * already-declared dependency in a manifest the component already contains") permits the edit that
 * clause refused. What replaces it, when and only when an anchor is supplied:
 *
 *   (a) the file's line at the anchor index equals the anchor text BYTE FOR BYTE;
 *   (b) that line contains `fromVersion` (the existing `from_version_not_on_line` clause, unchanged,
 *       now measured on the anchor line because the changed line IS the anchor line);
 *   (c) the set of lines naming BOTH the coordinate and `fromVersion` is EMPTY, or is exactly the
 *       anchor line.
 *
 * (c) is the load-bearing one: **the anchored mode widens only where the textual rule was silent.**
 * Wherever any line does name both, the anchor must BE that line, so every refusal the coordinate
 * rule fires today still fires and nothing that works today gets weaker. (a) makes the anchor
 * COMPARED, NEVER EMITTED — the output line is rebuilt from the file's own bytes, so a wrong
 * descriptor can only cause a refusal, never a smuggled byte.
 *
 * WHAT IS GIVEN UP, NAMED. For a declaration where NO line names the coordinate — exactly the shapes
 * refused outright before this — the line→coordinate binding is no longer parser-independent: it
 * rests on `parseKubernetesImages` associating a `tag` scalar with its sibling `repository`. A wrong
 * SELECTION is still caught (write-guard gate 6 re-parses the RETURNED bytes and refuses unless the
 * declaration whose version moved is the subscribed coordinate); a wrong ASSOCIATION is common-mode
 * with that gate's own parser and is NOT. The comparison is "refused" versus "bumped under a parser
 * associativity assumption", never "strong guarantee" versus "weak one", and the residual is stated
 * in `docs/proposals/split-shape-image-bumps.md` §4 as an accepted risk with its own differential
 * tests.
 *
 * The last clause is the load-bearing one and it is why this is a reconstruction rather than a set of
 * `includes()` assertions: `includes(toVersion)` is satisfied by a line that ALSO gained a
 * `--allow-scripts` flag, a changed package name, or a second dependency appended after a `;`. Only
 * rebuilding the expected line and comparing it byte-for-byte rules those out.
 *
 * STRUCTURAL CHECK WHERE THE FORMAT ALLOWS ONE. For `npm` the manifest is JSON, so the textual test
 * is followed by a parse-and-compare of the dependency KEY SETS ({@link verifyJsonDeclarationSets}).
 * That is not redundancy for its own sake: it is the one ecosystem where a single line can carry
 * several declarations, and a key-set comparison answers "was a dependency added or removed?" as a
 * fact about the document rather than about its formatting.
 *
 * NOT A PARSER, AND NEVER A WRITER OF ANYTHING ELSE. Nothing in this file constructs repository
 * content. {@link applyManifestBump} exists as the REFERENCE edit — it is what the `scp-runner-dep`
 * image's editor must agree with, and it is what the orchestrator's own tests use as a stand-in
 * runner so the seam is testable without a container. The orchestrator never uses it to author what
 * it pushes; it pushes what the isolated runner produced, after this module has agreed with it.
 */

/**
 * The five ecosystems ADR-0032 §10 enumerates, in the order that ADR sequences them.
 *
 * The TYPE is re-exported from `@scp/dependency-manifests` rather than declared again here. This
 * file used to declare its own identical union, which was a second definition of one vocabulary —
 * and `types.ts` in that package already carries the warning that the set "MUST stay identical to
 * `DependencyEcosystemSchema`". Two copies is where a sixth ecosystem gets added to one of them.
 * Since `write-guard.ts` now needs that package's parsers anyway, the dependency is already here and
 * there is nothing left to pay for using its type.
 */
export type { DependencyEcosystem };

export const DEPENDENCY_ECOSYSTEMS: readonly DependencyEcosystem[] = [
  "go",
  "oci",
  "npm",
  "python",
  "maven"
];

export function isDependencyEcosystem(value: string): value is DependencyEcosystem {
  return (DEPENDENCY_ECOSYSTEMS as readonly string[]).includes(value);
}

/**
 * WHAT the bump is — a DESCRIPTOR, never content. Every field names something that already exists in
 * the component's repository (the manifest, the coordinate, the version it currently declares) plus
 * the one token that is to replace another. There is no field here that can carry a file body, a
 * patch, or a command, and that is the whole design: see `index.ts`'s
 * "THE DESCRIPTOR IS NOT CONTENT" for why that distinction is the one ADR-0032 §9 actually draws.
 */
export interface ManifestBumpSpec {
  ecosystem: DependencyEcosystem;
  /** The ecosystem-native coordinate, VERBATIM as `dependency_lines.coordinate` stores it. */
  coordinate: string;
  /** Repo-relative manifest path, exactly as `component_dependencies.manifest_path` holds it. */
  manifestPath: string;
  /** What the manifest LITERALLY says today (`^1.2.3`, `v1.2.3`, `3.18-alpine`) — the string the
   *  edit replaces. Verbatim from `component_dependencies.declared_version`, which 0061 keeps
   *  unnormalised precisely because "it is the string the M21.5 actuator has to edit, and a
   *  normalised copy of it would be an edit target that does not appear in the file". */
  fromVersion: string;
  /** What it must say afterwards. Carries any prefix/suffix the declaration's own grammar needs —
   *  the caller composes it from `fromVersion`'s shape, so `^1.2.3` bumps to `^1.3.0` rather than
   *  losing its range operator. */
  toVersion: string;
  /**
   * WHICH LINE, when the coordinate is not written on it (M21.7 split shapes).
   *
   * PLUGIN-INTERNAL AND DERIVED — never transported. `ManifestBumpSpec` is built inside the
   * orchestrator by `parseBumpDescriptor`, and this field is added by `index.ts` from
   * `write-guard.ts`'s {@link import("./write-guard.js").locateVersionLine} run over the manifest
   * bytes it has just read at the base branch. There is no wire schema for it, no `pnpm gen`, no
   * oasdiff exposure and no column: a line number captured at ingestion and spent at actuation would
   * be a number derived from a read at one ref and applied to a read at another.
   *
   * Its ABSENCE is not an error and never becomes one — with no anchor, the coordinate rule runs
   * exactly as it always has. That is what keeps the four working ecosystems untouched.
   *
   * `text` is COMPARED, NEVER EMITTED. Nothing here is ever written into a file; it is an equality
   * test against the file's own bytes, so a stale or wrong descriptor can only cause a refusal.
   */
  anchor?: { readonly line: number; readonly text: string };
}

export type BumpRefusalReason =
  /** The runner returned bytes identical to what it was given — no edit happened. */
  | "unchanged"
  /** Line count differs: something was added or removed. */
  | "line_count_changed"
  /** More than one line differs. */
  | "multiple_lines_changed"
  /** The BEFORE file does not declare this coordinate at all — "never edits a file that declares no
   *  dependency" (this is the file-level half of that clause; the line-level half is below). */
  | "coordinate_not_declared"
  /** The changed line does not name the coordinate: a different declaration was edited. */
  | "wrong_declaration_changed"
  /** The changed BEFORE line does not contain `fromVersion` — the edit target was not what the
   *  inventory said it was, so the whole bump is built on a stale reading. */
  | "from_version_not_on_line"
  /** Reconstructing the line from BEFORE by replacing the version token does not reproduce AFTER:
   *  something other than the declared version changed on that line. */
  | "non_version_edit"
  /** JSON manifest: the set of declared dependencies is not identical. */
  | "declaration_set_changed"
  /** JSON manifest: the returned bytes are not parseable JSON. */
  | "manifest_unparseable"
  // --- Anchored mode (M21.7): the three refusals clause 3's replacement can produce -------------
  /** ANCHORED: the file's line at the anchor index is not the bytes the anchor recorded. The
   *  descriptor was derived from a different revision of this file than the runner was handed, so
   *  the line number addresses something nobody looked at. */
  | "anchor_text_mismatch"
  /** ANCHORED: the ONE line that changed is not the anchor line. The runner edited a line the
   *  descriptor did not point at, whatever else may be true of it. */
  | "anchor_line_not_changed"
  /** ANCHORED: some line DOES name both the coordinate and `fromVersion`, and the anchor is not it
   *  (or there are several). The anchored mode widens only where the textual rule was silent, so a
   *  textual rule that speaks always wins — and a disagreement is refused exactly as an ambiguous
   *  coordinate match is refused in the unanchored mode. */
  | "coordinate_rule_disagrees";

export type BumpVerification =
  | { ok: true; changedLineIndex: number; before: string; after: string }
  | { ok: false; reason: BumpRefusalReason; detail: string };

/** Split preserving nothing but the lines — the caller compares counts, so a trailing newline
 *  difference correctly surfaces as `line_count_changed` rather than being silently normalised. */
function lines(text: string): string[] {
  return text.split("\n");
}

/**
 * Replace the FIRST occurrence of `from` with `to`. Plain index/slice rather than `String.replace`,
 * because a `from` containing `$&`/`$1` would be interpreted as a replacement pattern — and a
 * declared version is arbitrary tenant text (`^1.2.3`, `~=1.4`, `3.18-alpine`), not a literal this
 * code gets to assume anything about. Same reasoning as managed-iac's split/join redaction.
 */
function replaceFirst(haystack: string, from: string, to: string): string {
  const at = haystack.indexOf(from);
  if (at < 0) return haystack;
  return haystack.slice(0, at) + to + haystack.slice(at + from.length);
}

/**
 * THE COORDINATE RULE, as one function — every line index naming BOTH the coordinate and the version
 * the manifest declares today.
 *
 * It is the selector `applyManifestBump` has always used and the one `run.sh`'s awk implements in
 * `index()` terms. It is factored out because the anchored mode needs the same set for its VETO —
 * "the anchor must agree with the coordinate rule wherever that rule speaks" is only checkable
 * against the identical set, and a second, subtly different scan is how a veto comes to permit what
 * the selector refuses.
 *
 * Exported so the orchestrator can ask whether this rule has an answer at all, WITHOUT ever using it
 * to author bytes (`index.ts` uses it for one refusal and for one delivery downgrade). Measuring is
 * not authoring: the runner remains the only thing that produces content.
 */
export function coordinateRuleCandidates(
  beforeLines: readonly string[],
  spec: Pick<ManifestBumpSpec, "coordinate" | "fromVersion">
): number[] {
  const candidates: number[] = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    const line = beforeLines[i] as string;
    if (line.includes(spec.coordinate) && line.includes(spec.fromVersion)) candidates.push(i);
  }
  return candidates;
}

/** Does the coordinate rule agree that `index` is the edit target? See clause (c). */
function coordinateRuleAgrees(candidates: readonly number[], index: number): boolean {
  // EMPTY is agreement — the rule was silent, which is the only gap the anchor fills. One candidate
  // must BE the anchor line. Two or more is the ambiguity the unanchored mode refuses today.
  return candidates.length === 0 || (candidates.length === 1 && candidates[0] === index);
}

/**
 * THE REFUSAL. Given the bytes the manifest had and the bytes the isolated runner produced, decide
 * whether the difference is EXACTLY "the declared version of this already-declared dependency
 * changed from `fromVersion` to `toVersion`" — and nothing else.
 *
 * Every negative verdict names the reason and states the measured specifics, because this is the one
 * place a caller learns that a runner produced something the charter does not permit; "verification
 * failed" with no numbers would leave an operator with a refused bump and no way to tell a broken
 * runner image from a stale inventory row.
 */
export function verifyManifestBump(
  before: string,
  after: string,
  spec: ManifestBumpSpec
): BumpVerification {
  const anchor = spec.anchor;
  // THE FILE-LEVEL CLAUSE IS REPLACED IN THE ANCHORED BRANCH, NOT SUPPLEMENTED. For a
  // `{registry, repository, tag}` image the coordinate is a CONSTRUCTION (`ghcr.io/acme/api` from a
  // `registry:` line and a `repository:` line), so it is legitimately absent from the text and this
  // clause would refuse every such bump as `coordinate_not_declared`. The question it asks — does
  // this file declare this coordinate? — is answered instead by the anchor's own derivation (which
  // found a PARSED declaration carrying exactly this coordinate) and re-answered independently on
  // the RETURNED bytes by `verifyManifestOnlyEdit` gate 6, which refuses unless the base parse
  // declares it and unless the declaration whose version moved IS it.
  if (anchor === undefined && !before.includes(spec.coordinate)) {
    return {
      ok: false,
      reason: "coordinate_not_declared",
      detail: `'${spec.manifestPath}' does not mention '${spec.coordinate}' at all — refusing to edit a file that declares no such dependency`
    };
  }
  if (before === after) {
    return {
      ok: false,
      reason: "unchanged",
      detail: `the runner returned '${spec.manifestPath}' byte-identical to the input — no bump was applied`
    };
  }

  const beforeLines = lines(before);
  const afterLines = lines(after);
  if (beforeLines.length !== afterLines.length) {
    return {
      ok: false,
      reason: "line_count_changed",
      detail: `'${spec.manifestPath}' went from ${beforeLines.length} to ${afterLines.length} lines — a dependency was added or removed, which this class never does`
    };
  }

  const changed: number[] = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changed.push(i);
  }
  if (changed.length > 1) {
    return {
      ok: false,
      reason: "multiple_lines_changed",
      detail: `'${spec.manifestPath}' changed on ${changed.length} lines (${changed.map((i) => i + 1).join(", ")}) — exactly one declaration may change`
    };
  }
  // `changed.length === 0` is unreachable: `before !== after` with equal line counts implies at
  // least one differing line. Handled anyway so the index below is never `undefined` by inference.
  const index = changed[0];
  if (index === undefined) {
    return {
      ok: false,
      reason: "unchanged",
      detail: `'${spec.manifestPath}' differs in length but on no line — refusing an edit this verifier cannot characterise`
    };
  }

  const beforeLine = beforeLines[index] as string;
  const afterLine = afterLines[index] as string;
  if (anchor === undefined) {
    // CLAUSE 3, unanchored and unchanged.
    if (!beforeLine.includes(spec.coordinate)) {
      return {
        ok: false,
        reason: "wrong_declaration_changed",
        detail: `line ${index + 1} of '${spec.manifestPath}' changed but does not name '${spec.coordinate}': '${beforeLine.trim()}' -> '${afterLine.trim()}'`
      };
    }
  } else {
    // CLAUSE 3, ANCHORED: (a) the anchor addresses the bytes it was derived from, (b) is the
    // existing `from_version_not_on_line` check below — which now measures the anchor line, because
    // the changed line has been proven to BE it — and (c) the coordinate rule keeps its veto.
    const anchorIndex = anchor.line - 1;
    const anchoredLine = beforeLines[anchorIndex];
    if (anchoredLine !== anchor.text) {
      return {
        ok: false,
        reason: "anchor_text_mismatch",
        detail: `line ${anchor.line} of '${spec.manifestPath}' reads ${JSON.stringify(anchoredLine ?? "<past the end of the file>")}, but the descriptor anchors to ${JSON.stringify(anchor.text)} — the anchor was derived from different bytes than the runner was handed, so it addresses a line nobody looked at`
      };
    }
    if (index !== anchorIndex) {
      return {
        ok: false,
        reason: "anchor_line_not_changed",
        detail: `line ${index + 1} of '${spec.manifestPath}' changed, but this bump anchors to line ${anchor.line} ('${anchor.text.trim()}') — the runner edited a line the descriptor did not point at`
      };
    }
    const candidates = coordinateRuleCandidates(beforeLines, spec);
    if (!coordinateRuleAgrees(candidates, anchorIndex)) {
      return {
        ok: false,
        reason: "coordinate_rule_disagrees",
        detail: `${candidates.length} line(s) of '${spec.manifestPath}' name both '${spec.coordinate}' and '${spec.fromVersion}' (${candidates.map((i) => i + 1).join(", ")}), and the anchor is line ${anchor.line} — an anchor may only widen where the textual rule is silent, never overrule it`
      };
    }
  }
  if (!beforeLine.includes(spec.fromVersion)) {
    return {
      ok: false,
      reason: "from_version_not_on_line",
      detail: `line ${index + 1} of '${spec.manifestPath}' does not declare '${spec.fromVersion}' (it reads '${beforeLine.trim()}') — the inventory's declared version is stale`
    };
  }

  const expected = replaceFirst(beforeLine, spec.fromVersion, spec.toVersion);
  if (expected !== afterLine) {
    return {
      ok: false,
      reason: "non_version_edit",
      detail: `line ${index + 1} of '${spec.manifestPath}' changed by more than its declared version — expected '${expected.trim()}', got '${afterLine.trim()}'`
    };
  }

  if (spec.ecosystem === "npm") {
    const structural = verifyJsonDeclarationSets(before, after, spec);
    if (structural) return structural;
  }

  return { ok: true, changedLineIndex: index, before, after };
}

/**
 * The npm-only structural half: parse both documents and prove the DECLARED DEPENDENCY KEY SETS are
 * identical across every dependency block a `package.json` can carry.
 *
 * npm is the one ecosystem here whose manifest can legitimately hold several declarations on one
 * line (`{"a":"1","b":"2"}` is valid JSON), so the textual single-line test alone would admit an edit
 * that swapped one declaration for another inside the same line. Comparing key sets answers "was a
 * dependency added or removed?" as a fact about the document rather than about its formatting.
 *
 * Returns a refusal, or `undefined` when the document agrees. An unparseable AFTER is a refusal:
 * pushing a package.json that does not parse would break the component's build, which is a change
 * far beyond "the declared version".
 */
function verifyJsonDeclarationSets(
  before: string,
  after: string,
  spec: ManifestBumpSpec
): BumpVerification | undefined {
  const BLOCKS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "overrides",
    "resolutions"
  ];
  const parse = (text: string): Record<string, unknown> | undefined => {
    try {
      const doc = JSON.parse(text) as unknown;
      return doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const beforeDoc = parse(before);
  const afterDoc = parse(after);
  if (beforeDoc === undefined) {
    // The INPUT did not parse. That is not this runner's doing and must not be reported as one —
    // but it also means the structural check cannot run, so it is skipped rather than failed. The
    // textual verdict above already stands on its own.
    return undefined;
  }
  if (afterDoc === undefined) {
    return {
      ok: false,
      reason: "manifest_unparseable",
      detail: `the runner's '${spec.manifestPath}' is not parseable JSON — refusing to push a manifest the component's own tooling cannot read`
    };
  }
  for (const block of BLOCKS) {
    const b = beforeDoc[block];
    const a = afterDoc[block];
    const keysOf = (v: unknown): string[] =>
      v !== null && typeof v === "object" ? Object.keys(v as Record<string, unknown>).sort() : [];
    const bk = keysOf(b).join(",");
    const ak = keysOf(a).join(",");
    if (bk !== ak) {
      return {
        ok: false,
        reason: "declaration_set_changed",
        detail: `'${spec.manifestPath}' \`${block}\` key set changed ([${bk}] -> [${ak}]) — this class never adds or removes a dependency`
      };
    }
  }
  return undefined;
}

/**
 * THE REFERENCE EDIT — what the `scp-runner-dep` image's editor must agree with, byte for byte.
 *
 * It lives here, beside the verifier, so the two are read together and so this package's tests can
 * stand in for the runner container (`index.test.ts` drives the orchestrator with a fake docker that
 * applies exactly this). THE ORCHESTRATOR NEVER CALLS IT to produce what it pushes: pushing this
 * function's output would make the ephemeral runner decorative, and the runner's isolation is a
 * charter precondition, not an implementation detail.
 *
 * Returns `undefined` when the declaration cannot be located unambiguously — a caller that gets
 * `undefined` has learned the manifest does not say what the inventory says it says, which is a
 * refusal, never a licence to guess.
 */
export function applyManifestBump(before: string, spec: ManifestBumpSpec): string | undefined {
  const beforeLines = lines(before);
  const candidates = coordinateRuleCandidates(beforeLines, spec);
  const anchor = spec.anchor;

  let index: number;
  if (anchor === undefined) {
    // Exactly one line must both name the coordinate and carry the declared version. Zero means the
    // manifest disagrees with the inventory; more than one means the edit target is ambiguous and a
    // choice here would be a guess about which declaration the subscriber meant.
    if (candidates.length !== 1) return undefined;
    index = candidates[0] as number;
  } else {
    // THE ANCHORED RULE, IN THE SAME ORDER `run.sh` APPLIES IT: (a) the anchor text still matches
    // the file's own bytes, (b) that line carries the version to replace, (c) the coordinate rule
    // does not disagree. Any one failing is a refusal, never a fallback to the other rule — falling
    // back would mean two selectors could each choose a different line and the shim and this
    // function would silently disagree about which.
    index = anchor.line - 1;
    if (beforeLines[index] !== anchor.text) return undefined;
    if (!anchor.text.includes(spec.fromVersion)) return undefined;
    if (!coordinateRuleAgrees(candidates, index)) return undefined;
  }

  const edited = [...beforeLines];
  edited[index] = replaceFirst(beforeLines[index] as string, spec.fromVersion, spec.toVersion);
  return edited.join("\n");
}

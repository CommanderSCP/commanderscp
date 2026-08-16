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
 *   * that line names the coordinate                  -> the right declaration was touched;
 *   * replacing the from-version token with the to-version token in the BEFORE line reproduces the
 *     AFTER line EXACTLY                              -> only the version token changed.
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
  | "manifest_unparseable";

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
  if (!before.includes(spec.coordinate)) {
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
  if (!beforeLine.includes(spec.coordinate)) {
    return {
      ok: false,
      reason: "wrong_declaration_changed",
      detail: `line ${index + 1} of '${spec.manifestPath}' changed but does not name '${spec.coordinate}': '${beforeLine.trim()}' -> '${afterLine.trim()}'`
    };
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
  const candidates: number[] = [];
  for (let i = 0; i < beforeLines.length; i += 1) {
    const line = beforeLines[i] as string;
    if (line.includes(spec.coordinate) && line.includes(spec.fromVersion)) candidates.push(i);
  }
  // Exactly one line must both name the coordinate and carry the declared version. Zero means the
  // manifest disagrees with the inventory; more than one means the edit target is ambiguous and a
  // choice here would be a guess about which declaration the subscriber meant.
  if (candidates.length !== 1) return undefined;
  const index = candidates[0] as number;
  const edited = [...beforeLines];
  edited[index] = replaceFirst(beforeLines[index] as string, spec.fromVersion, spec.toVersion);
  return edited.join("\n");
}

import type { DependencyEcosystem } from "@scp/dependency-manifests";

/** THE MANIFEST-ONLY INVARIANT, AS CODE. See docs/plugins.md §255. */

/** The five ecosystems, in the order the ADR sequences them. See docs/plugins.md §256. */
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

/** WHAT the bump is — a DESCRIPTOR, never content. See docs/plugins.md §257. */
export interface ManifestBumpSpec {
  ecosystem: DependencyEcosystem;
  coordinate: string;
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
  /** Which line, when the coordinate is not written on it. See docs/plugins.md §258. */
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

/** Replace the FIRST occurrence of `from` with `to`. See docs/plugins.md §259. */
function replaceFirst(haystack: string, from: string, to: string): string {
  const at = haystack.indexOf(from);
  if (at < 0) return haystack;
  return haystack.slice(0, at) + to + haystack.slice(at + from.length);
}

/** THE COORDINATE RULE, as one function. See docs/plugins.md §260. */
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

/** The refusal: given both byte sets, decide if it is legal. See docs/plugins.md §261. */
export function verifyManifestBump(
  before: string,
  after: string,
  spec: ManifestBumpSpec
): BumpVerification {
  const anchor = spec.anchor;
  // The file-level clause is replaced, not supplemented. See docs/plugins.md §262.
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

/** The npm-only structural half. See docs/plugins.md §263. */
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

/** THE REFERENCE EDIT. See docs/plugins.md §264. */
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
    // The anchored rule, in the same order the runner applies it. See docs/plugins.md §265.
    index = anchor.line - 1;
    if (beforeLines[index] !== anchor.text) return undefined;
    if (!anchor.text.includes(spec.fromVersion)) return undefined;
    if (!coordinateRuleAgrees(candidates, index)) return undefined;
  }

  const edited = [...beforeLines];
  edited[index] = replaceFirst(beforeLines[index] as string, spec.fromVersion, spec.toVersion);
  return edited.join("\n");
}

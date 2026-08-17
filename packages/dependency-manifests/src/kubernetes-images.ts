/**
 * Kubernetes image references — every image a YAML document PINS, whether it pins it the Helm way
 * (`image.repository` + `image.tag` in a chart's `values.yaml`) or the pod-spec way
 * (`spec.template.spec.containers[].image`).
 *
 * ============================================================================================
 * WHY THIS EXISTS: ABSENT READ AS "NO DEPENDENCY", WHICH IS NOT WHAT IT MEANT
 * ============================================================================================
 * M21's inventory read image references only from `Dockerfile` `FROM` lines. Most Kubernetes users
 * — the owner included — pin the image their component actually RUNS in Helm values, not in a
 * `FROM`, so that image did not appear in the inventory at all. Absent renders as "this component
 * declares no dependency"; the honest answer was "SCP cannot read where you declared it". This
 * parser closes the first half of that, and {@link parseKubernetesImages}'s `unresolved` entries
 * close the second: a reference that is FOUND but not resolvable from the file is REPORTED, never
 * silently dropped. Design: `docs/proposals/kubernetes-image-references.md` (§2 shapes, §4 traps).
 *
 * ============================================================================================
 * THE ECOSYSTEM IS `oci`. THERE IS NO SECOND IMAGE ECOSYSTEM.
 * ============================================================================================
 * An image pinned in a values file is the SAME `dependency_lines` row as the same image pinned in a
 * `FROM`: same coordinate, same major, same tag pattern, same registry index, same comparator. The
 * only thing that differs is which file the declaration was read out of, which `manifest_path`
 * already records.
 *
 * ============================================================================================
 * PATH-AGNOSTIC AND SHAPE-COMPLETE, ON PURPOSE
 * ============================================================================================
 * This function takes CONTENT and knows nothing about filenames. Only `values.yaml` is registered in
 * the ingestion's parser table this round — raw Kubernetes manifests (`deployment.yaml`, `api.yaml`,
 * `k8s/web-deploy.yaml`) are *unaddressable*, not hard: the git seam has exactly one file verb
 * (`readFileAtRef`), there is no enumeration, and a guessed path that comes back `not_found` is the
 * branch that PRUNES. But the pod-spec shapes are read here anyway — `containers[]`,
 * `initContainers[]`, `ephemeralContainers[]`, a pod spec at the document root and CronJob's
 * `spec.jobTemplate.spec.template.spec.containers[]` all end at an `image:` key, and the walk below
 * is over every mapping in the document, so all of them are covered by construction. Turning them
 * on later is one line in `MANIFEST_PARSERS` plus an addressability answer, not parser work.
 *
 * `templates/*.yaml` is out permanently: a chart's rendered output is not in the repository, and Go
 * template control blocks (`{{- if … }}`) make those files *not YAML at all*, so a parse failure
 * there would be stamped `unreadable` ("may succeed next pass") — the wrong operator action, forever.
 *
 * ============================================================================================
 * THE TRAPS, AND WHAT EACH ONE DOES HERE
 * ============================================================================================
 *  1. **YAML COERCES THE VERSION AWAY.** `tag: 1.2` parses to the NUMBER 1.2; `tag: 1.20` parses to
 *     1.2; `tag: 3.10` to 3.1. `component_dependencies.declared_version` is "the exact string the
 *     actuator has to edit; a normalised copy would be an edit target that does not appear in the
 *     file". So no version is ever read through a node's JS value — {@link scalarText} reads the
 *     scalar's own SOURCE TEXT, and a node whose source cannot be recovered is reported
 *     `unresolved` rather than guessed. This trap alone is why a real YAML parser is used.
 *     A BLOCK SCALAR (`tag: |`) is the one style whose source text is not the edit target: it
 *     carries the block's own trailing newline and spans lines, so `1.2.3\n` would go into the
 *     inventory as the string an actuator must find on one line. Reported `unresolved`.
 *  2. **Go templates are not resolvable from the file.** `tag: "{{ .Chart.AppVersion }}"`,
 *     `repository: "{{ .Values.global.registry }}/api"`. Reported `unresolved` — the same rule
 *     `dockerfile.ts` applies to `ARG` interpolation, and for the same reason: resolving it would
 *     produce a confidently wrong version. (`.Chart.AppVersion` tracks the CHART's version, not the
 *     dependency's, so it would be wrong even if it were resolvable.)
 *  3. **`latest`, `stable`, `edge`, date stamps and commit shas are not orderable.** Handled by the
 *     shared `parseComparableVersion`, which yields `undefined` for them: they are carried, they get
 *     no line row, and they are reported. A single numeric component gets its own note, because a
 *     registry cannot tell `20240115` from a major line.
 *  4. **A bare `image: acme/api` with no tag is `unpinned`, NOT `latest`.** Kubernetes' implicit
 *     `:latest` is a RESOLUTION rule; writing "latest" into `declared` invents text the author never
 *     wrote.
 *  5. **Digests.** `digest: sha256:…`, with or without a tag: both are carried and neither is
 *     derived from the other. Only the key literally spelled `digest` is read — a chart spelling it
 *     `sha` or `imageDigest` is not guessed at. And what it holds has to BE a digest: the value is
 *     checked against {@link isDigestShaped} before it is recorded, because a `digest:` carrying
 *     `latest` or a truncated hex string lands in `component_dependencies.resolved_digest` and is
 *     then compared against a registry's real digest — a pin to nothing that can never match, which
 *     is the "a wrong version is worse than a missing one" rule applied to identity.
 *  6. **A values file for a chart the org CONSUMES vs its own chart.** Both are read and this parser
 *     does NOT branch on which it is: branching would be a label named after which condition
 *     matched, and it is wrong for umbrella charts where both are true at once. This package reports
 *     the declaration, not the consequence. STATED RESIDUE: an override key the consumed chart does
 *     not actually read is a declaration SCP will faithfully record. The mitigation is
 *     explainability — `declaredIn` carries the DOTTED KEY PATH (`postgresql.image.tag`), so a
 *     Decision names exactly which key was read.
 *  7. **Multi-document YAML.** `---`-separated documents are ordinary here. All of them are parsed;
 *     a document whose root is not a mapping is skipped rather than fatal PROVIDED at least one root
 *     is a mapping (trap 8 is the other half of that sentence). In a multi-document stream every
 *     `declaredIn` is prefixed `doc[i].`, so two same-named keys in two documents stay distinct.
 *  8. **Unreadable must not collapse into empty, and YAML makes that harder than JSON.**
 *     `parseGoMod` and `parsePackageJson` throw on `<!doctype html><title>404</title>` because it is
 *     not their grammar. It IS valid YAML — a plain scalar — so a naive YAML parser would return
 *     "zero images" for a 404 body and the next ingestion pass would PRUNE the component's whole
 *     image inventory. So: the EMPTY STRING throws, a YAML syntax error throws, and a stream with no
 *     mapping root but some non-null root throws. Stated cost: a genuinely zero-byte `values.yaml`
 *     is reported `unreadable` rather than `ok / 0` — a false alarm in the safe direction, because
 *     it does not prune. A comments-only file (no documents at all, but not empty) is the negative
 *     control and returns `[]`. So is a file whose only document is EMPTY (`---` on its own, or an
 *     explicit `null`): `yaml` composes that as a Scalar node holding null, not as `contents:
 *     null`, so "some root that is not a mapping" used to catch it and stamp it `unreadable` —
 *     "this attempt failed and the next may not" about a file that will fail identically forever.
 *     An empty document is an honest empty, and honest empty is `ok / 0`.
 *  9. **The same image twice in one file is ONE row, and its bump is correctly ambiguous.** The
 *     inventory's primary key is `(org, component, line, manifest_path)`, so a Deployment and a
 *     CronJob pinning `acme/api:1.2.3` in one file collapse. Identical declarations are therefore
 *     merged into one entry HERE, and the entry's `note` names every key path that fed it — the
 *     ambiguity is reported at ingestion instead of being discovered months later as a mystery
 *     refusal from the bump verifier. The count is ALSO carried as a number
 *     (`DeclaredDependency.occurrences`), because the note is what an operator reads and a number is
 *     what a gate reads: `@scp/plugin-managed-dep` refuses to anchor a bump on a merged entry, and
 *     matching that refusal against prose would be a gate on wording.
 * 10. **Anchors, aliases and merge keys.** `tag: *appVersion` and `<<: *defaults` are ordinary in
 *     values files, and for them the EDIT SITE IS NOT THE READ SITE: one edit to the anchor moves
 *     every alias, which a single-changed-line verifier would see as one line changed and several
 *     declarations silently moved. So an aliased value is `unresolved`, and a merge key IN IMAGE
 *     CONTEXT (trap 13) is reported as `unresolved` too — the keys it merges in are not in this
 *     mapping's AST. It is scoped to image context deliberately: a `<<: *resourceDefaults` on a
 *     resources block is ordinary YAML and reporting it stamped the whole file `unsupported`
 *     (trap 16). This also settles the billion-laughs question by construction: alias EXPANSION
 *     happens when a document is resolved to plain JS, and this parser never resolves one — it
 *     reads the AST, so there is nothing to expand.
 * 11. **`image` is matched as an EXACT key, never as a substring.** `imagePullSecrets`,
 *     `imagePullPolicy`, `initImage`, `imageCredentials` and `global.imageRegistry` are not images.
 *     A key matched by "contains `image`" is a label named after what happened to match.
 * 12. **The prune blast radius is larger here than for a Dockerfile.** One values file can be the
 *     sole declaration site for a dozen images, so a mis-parse returning `[]` would unsubscribe a
 *     dozen lines in one pass. That is why trap 8's root rule is a THROW and not a skip.
 * 13. **`repository`/`registry`/`tag`/`digest` MEAN NOTHING ON THEIR OWN — the `image` key is what
 *     makes them an image.** Read off every mapping that happens to carry them, they mint phantom
 *     dependencies out of ordinary chart furniture: a `sources:` block's `repository:`, a
 *     `schemaRegistry:`'s `registry:`, a `tag:` on a label or a metrics config. The pod-spec walk
 *     already had the answer — it finds an image because the key is spelled `image`, not because
 *     the value looks like one — and that discipline is extended rather than joined by a heuristic.
 *     A mapping is IN IMAGE CONTEXT iff either
 *       (a) it carries an exact `image` key whose value is a SCALAR — the pod-spec/one-scalar shape,
 *           `containers[].image`, wherever in the tree it sits; or
 *       (b) it IS the value of an exact `image` key (directly, or as an element of a sequence that
 *           is) — Helm's `image: {repository, tag}` block, one hop, never deeper.
 *     Outside image context the four split keys are not read at all, and nothing is reported: this
 *     is not an image reference SCP failed to resolve, it is not an image reference. The
 *     `image:` key holding a MAPPING does not put its own mapping in context — that mapping is the
 *     PARENT of the image block, and reading its sibling `tag:` as a bare tag is the same phantom.
 *     STATED RESIDUE: a chart that spells the repository under `image:` beside a `registry:`
 *     (ingress-nginx does) is read by rule (a), so the coordinate is the repository alone and the
 *     sibling registry is NOT joined onto it — joining would double a registry that a pod spec's
 *     `image:` already spells in full. The un-joined `registry` is named in the entry's note.
 * 14. **An EMPTY coordinate is not a phantom row, it is a SHARED one.** `repository: ""` is a live
 *     chart placeholder, and `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` —
 *     org-scoped. So every component in the org carrying that placeholder collapses onto ONE line:
 *     one team's subscription governs another's, and a bump dispatched for it fans out across
 *     unrelated components. An empty or near-empty coordinate is therefore refused outright
 *     ({@link isUsableCoordinate}) rather than minted, and reported so it is visible.
 * 15. **`registry: ""` MEANS "the default registry", not "a registry named empty".** It is the
 *     standard chart placeholder (bitnami's `global.imageRegistry` override point), so it is the
 *     COMMON case rather than an edge. Joined naively it yields `/acme/api`, which splits one image
 *     across two coordinates depending on whether a values file happened to spell the registry.
 *     An empty/whitespace registry is treated as ABSENT; a non-empty one that is not
 *     repository-shaped is reported, never joined.
 * 16. **`unsupported` must mean "an image reference is in here that I could not resolve".** A
 *     manifest whose every declaration is unresolved is stamped `unsupported` and its component
 *     `partial` (`inventory-ingestion.ts:projectIngestionStamp`), so anything this parser reports
 *     unresolved on an ORDINARY values file destroys the honesty mechanism the round exists to
 *     provide: a warning that fires on everything is a warning nobody reads. Traps 13 and 10 are
 *     what scope it — every `unresolved` this parser emits is an image reference, in image context.
 * 17. **DUPLICATE KEYS, and why `uniqueKeys` is off.** `yaml`'s duplicate-key check scans every
 *     sibling already composed for each new pair, which is QUADRATIC in siblings-per-mapping — a
 *     flat 218 KB mapping composes in 1.26 s and a 32 000-key one in 7.1 s, so the 1 MiB read cap
 *     bounds this ingestion-path call at roughly a minute of CPU per manifest, not at "linear in
 *     the bytes". Measured, not reasoned about: with `uniqueKeys: false` the same 32 000-key file
 *     composes in 0.18 s and the curve is linear. Turning the check off means a duplicated key
 *     arrives as two pairs, and Go's YAML — which is what Helm renders with — takes the LAST while
 *     a scan takes the first, so a duplicated image key is REPORTED rather than picked between.
 *     (The check's other effect, throwing on any duplicate key anywhere in the file, was the wrong
 *     stamp anyway: `unreadable` says "may succeed next pass" about a file that will fail forever.)
 * 18. **A `tag:` BESIDE A POD-SPEC `image:` IS A KEY KUBERNETES NEVER READS.** `containers[].tag`
 *     is not in the Container schema; `image` there is a complete reference. Trap 13's rule (a)
 *     admits container objects and chart image blocks alike, so the sibling split keys are read
 *     only where rule (b) ALSO holds — i.e. where the mapping is the value of an `image:` key and
 *     is therefore an image block, not a container. Since M21.7 made `values.yaml` WRITABLE this
 *     stopped being a reporting question: the sibling's line is the line a bump would EDIT, so
 *     reading it would have SCP author a pull request that moves a key nothing consumes. See
 *     {@link unreadSiblingNote} for what is given up and how it is reported.
 *
 * ============================================================================================
 * WHAT IS NOT READ, DELIBERATELY
 * ============================================================================================
 * `Chart.yaml`'s `dependencies[].version` names SUBCHARTS from a Helm repository — a sixth
 * ecosystem (new enum member, new DB check-constraint value, new version index), not an image.
 * `kustomization.yaml`'s `images: [{name, newTag}]` is bounded and resolvable and is the obvious
 * next basename; it is deliberately not taken this round, because each basename multiplies the
 * ingestion's per-pass read budget and one filename at a time is the measurable way to grow it.
 */
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  Scalar,
  type Node,
  type Pair,
  type YAMLMap
} from "yaml";

import { isDigestShaped, splitImageRef } from "./dockerfile.js";
import { ManifestParseError, type DeclaredDependency } from "./types.js";
import { parseComparableVersion } from "./version.js";

/** The keys this parser reads, EXACTLY (trap 11). Nothing is matched by prefix or by substring. */
const IMAGE_KEY = "image";
const REGISTRY_KEY = "registry";
const REPOSITORY_KEY = "repository";
const TAG_KEY = "tag";
const DIGEST_KEY = "digest";
/** YAML's merge key. Its value is an alias, and the keys it brings in are not in this mapping. */
const MERGE_KEY = "<<";
/** The five image keys, in the order a duplicate report reads them. `<<` is deliberately absent:
 *  a repeated merge key is legal YAML and merges both anchors. */
const IMAGE_KEYS = [IMAGE_KEY, REGISTRY_KEY, REPOSITORY_KEY, TAG_KEY, DIGEST_KEY] as const;

/**
 * Is this text usable as an image coordinate at all? (trap 14)
 *
 * Deliberately a SHAPE test and not a grammar: the OCI reference grammar would refuse things real
 * registries accept, and this package's job is to refuse the values that are not coordinates at all
 * — the empty string, whitespace, and anything that joins to a leading/doubled `/`. Those are the
 * ones that COLLIDE: `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` org-wide, so
 * an empty coordinate is not one bad row, it is every component in the org sharing one line.
 */
export function isUsableCoordinate(text: string): boolean {
  if (text === "" || text !== text.trim()) return false;
  // An empty path segment covers `""`, `"/"`, `"/acme/api"`, `"ghcr.io//api"` and `"acme/api/"`;
  // whitespace anywhere covers a value that is prose rather than a reference.
  return text.split("/").every((segment) => segment !== "" && !/\s/.test(segment));
}

/**
 * One image reference as it was read, before identical ones are merged.
 *
 * `resolved: false` is a first-class outcome and is the point of this parser: a reference SCP FOUND
 * and cannot honestly read must reach an operator as `unsupported`, never as absence.
 */
interface Occurrence {
  readonly resolved: boolean;
  /** The image coordinate when resolved; the DOTTED KEY PATH of the offending node when not. */
  readonly coordinate: string;
  /** The version text exactly as the file spells it, or the raw unresolvable text. */
  readonly declared?: string;
  readonly digest?: string;
  /** Whether the declaration names exactly one version (a tag or a digest). */
  readonly pinned: boolean;
  /** Dotted key path of the node this entry was READ AT — the version's node where there is one. */
  readonly keyPath: string;
  readonly line: number;
  readonly note?: string;
}

/** A scalar's own SOURCE TEXT, or `undefined` when there is no honest text to take (trap 1). */
function scalarText(node: Scalar): string | undefined {
  // `tag:` with nothing after it. The key exists and declares no version; that is absence, not an
  // unreadable value, and it must never become the string "null".
  if (node.value === null || node.value === undefined) return undefined;
  // The parsed SOURCE, which is what `tag: 1.20` actually says. `node.value` is the number 1.2 — an
  // edit target that does not appear in the file.
  if (typeof node.source === "string" && node.source !== "") return node.source;
  // No source to recover. A string value is still the author's own text; anything else would be
  // this parser inventing a spelling for a number.
  return typeof node.value === "string" ? node.value : undefined;
}

function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line of a byte offset. */
function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** What one key held: absent, a usable text, or a named reason it cannot be read. */
type KeyRead =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string; readonly node: Node; readonly path: string }
  | {
      readonly kind: "unresolved";
      readonly why: string;
      readonly node: Node;
      readonly path: string;
    };

interface WalkContext {
  readonly lineStarts: readonly number[];
  readonly push: (occurrence: Occurrence) => void;
}

/** The six keys this parser cares about, found in ONE pass over a mapping's items (trap 17). */
interface MappingKeys {
  /** First pair for each key. `yaml` is composed with `uniqueKeys: false`, so there can be more. */
  readonly pairs: ReadonlyMap<string, Pair>;
  /** Keys spelled more than once here. Reported, never picked between — Helm takes the LAST. */
  readonly duplicated: ReadonlySet<string>;
}

/**
 * ONE pass, not one per key.
 *
 * The previous shape ran `map.items.find(...)` six times per mapping. That was linear too, and it
 * was never the cost that mattered — the composer's own duplicate-key scan was (trap 17) — but a
 * single pass is what lets duplicates be SEEN at all, which turning that scan off makes necessary.
 */
function collectKeys(map: YAMLMap): MappingKeys {
  const pairs = new Map<string, Pair>();
  const duplicated = new Set<string>();
  for (const item of map.items) {
    const key = item.key;
    if (!isScalar(key)) continue;
    const name = String(key.value);
    if (name !== MERGE_KEY && !(IMAGE_KEYS as readonly string[]).includes(name)) continue;
    if (pairs.has(name)) duplicated.add(name);
    else pairs.set(name, item);
  }
  return { pairs, duplicated };
}

function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/**
 * A document with NO CONTENT — `---` on its own, an explicit `null`, a document that is only a
 * comment (trap 8).
 *
 * `yaml` does not report these as `contents: null`; it composes a Scalar node whose `value` is
 * null. So the "some root is not a mapping" refusal caught them, and a `values.yaml` holding only
 * `---` was stamped `unreadable` — "this attempt failed and the next may not" about a file whose
 * next 10 000 passes fail identically. An empty document declares nothing, honestly.
 */
function isEmptyDocument(root: Node | null): boolean {
  return root === null || (isScalar(root) && root.value === null);
}

function nodeLine(ctx: WalkContext, node: Node): number {
  const range = (node as { range?: [number, number, number] | null }).range;
  return lineOf(ctx.lineStarts, range?.[0] ?? 0);
}

/**
 * Parse every image reference a Helm values file or a Kubernetes manifest declares.
 *
 * @param content the file's bytes decoded as UTF-8.
 * @returns one entry per DISTINCT declaration, in file order. An entry whose `constraint` is
 *          `unresolved` is a reference that was FOUND and could not be resolved from this file; it
 *          carries no `version`, so it can never mint a `dependency_lines` row, and the ingestion
 *          reports it rather than dropping it.
 * @throws {ManifestParseError} on the empty string, on invalid YAML, and on a stream with no mapping
 *   at any document root — a 404 HTML body, an error page and a Git-LFS pointer are all VALID YAML
 *   scalars, and returning `[]` for one of them would delete every image row this manifest path
 *   holds on the next ingestion pass (traps 8 and 12).
 */
export function parseKubernetesImages(content: string): DeclaredDependency[] {
  // (trap 8) THE EMPTY STRING IS NOT AN EMPTY DOCUMENT SET. An empty 200 body and a file that
  // genuinely holds nothing are indistinguishable here, and neither may be allowed to prune.
  if (content.trim() === "") {
    throw new ManifestParseError("the manifest is empty; an empty body is not a YAML document");
  }

  let documents;
  try {
    // THE AST, NEVER `toJS`. That is what bounds the work rather than an alias-count cap: alias
    // EXPANSION is a property of resolving a document to plain JS, and this parser never resolves
    // one — it reads nodes, and an alias node is reported `unresolved` at its own site (trap 10).
    // A billion-laughs values file is therefore linear in the bytes the read cap already bounds,
    // with nothing to expand.
    //
    // (trap 17) `uniqueKeys: false` IS A MEASURED CHOICE, NOT A LOOSENING. The default check scans
    // every sibling already composed for each new pair — quadratic in siblings-per-mapping, and
    // this call sits in the ingestion path behind a 1 MiB read cap: a flat 32 000-key mapping
    // composes in 7.1 s with it on and 0.18 s with it off. What the check bought (a throw on any
    // duplicate key) was the wrong outcome anyway — `unreadable` claims the next pass may succeed —
    // and what it protected against is handled where it matters, on the five image keys, by
    // `collectKeys` reporting a duplicate instead of silently taking the first.
    documents = parseAllDocuments(content, { uniqueKeys: false });
  } catch (err) {
    throw new ManifestParseError(
      `the content is not parseable as YAML: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  }
  const firstError = documents.flatMap((doc) => doc.errors)[0];
  if (firstError !== undefined) {
    throw new ManifestParseError(`the content is not valid YAML: ${firstError.message}`);
  }

  const roots: Array<Node | null> = documents.map((doc) => (doc.contents as Node | null) ?? null);
  const anyMapping = roots.some((root) => isMap(root));
  // (traps 8, 12) A 404 HTML BODY IS A VALID YAML SCALAR. `[]` for it would read as "this component
  // declares no images" and would prune every image row this path holds — a dozen of them, from one
  // file. A stream with no mapping anywhere, but with something that is not nothing, is not a
  // Kubernetes document. An EMPTY document is nothing, whatever node `yaml` composes for it.
  if (!anyMapping && roots.some((root) => !isEmptyDocument(root) && !isMap(root))) {
    throw new ManifestParseError(
      "no document in this YAML stream has a mapping at its root, so it is not a Helm values file " +
        "or a Kubernetes manifest (a 404 body, an HTML error page and a Git-LFS pointer all land here)"
    );
  }

  const occurrences: Occurrence[] = [];
  const ctx: WalkContext = {
    lineStarts: lineStartsOf(content),
    push: (occurrence) => occurrences.push(occurrence)
  };
  const multiDocument = documents.length > 1;

  documents.forEach((doc, index) => {
    const root = (doc.contents as Node | null) ?? null;
    // (trap 7) A document that is not a mapping is skipped rather than fatal — the throw above has
    // already refused the case where NO document is one.
    if (!isMap(root)) return;
    walk(root, multiDocument ? `doc[${index}]` : "", ctx, false);
  });

  return toDeclarations(occurrences);
}

/**
 * Every mapping in the document is examined, and every mapping is examined the same way.
 *
 * `underImageKey` is trap 13's rule (b) and it is the ONLY context this walk carries: true for the
 * mapping that is the value of an exact `image:` key, and for a mapping inside a sequence that is.
 * It is not inherited any further — a mapping two hops under `image:` is ordinary again — because
 * "somewhere below a key called image" is precisely the loose reading that mints phantoms.
 */
function walk(node: Node, path: string, ctx: WalkContext, underImageKey: boolean): void {
  if (isMap(node)) {
    readMapping(node, path, ctx, underImageKey);
    for (const pair of node.items) {
      const key = pair.key;
      const value = pair.value;
      if (!isScalar(key)) continue;
      const name = String(key.value);
      if (isMap(value) || isSeq(value)) {
        walk(value as Node, joinPath(path, name), ctx, name === IMAGE_KEY);
      }
    }
    return;
  }
  if (isSeq(node)) {
    // A sequence does not introduce a key, so it neither grants nor revokes context: `image: [{…}]`
    // keeps it, and `containers: [{…}]` never had it (each container mapping earns it by rule (a)).
    node.items.forEach((item, index) => {
      if (isMap(item) || isSeq(item)) walk(item as Node, `${path}[${index}]`, ctx, underImageKey);
    });
  }
}

/**
 * Read one key off a mapping, with every not-a-text outcome named rather than dropped.
 *
 * `mappingIsAnotherMapping` is set for `image` alone, and it is what makes shape B (`image:` with
 * `repository`/`tag` under it) work: an `image` whose value is a MAPPING is not this mapping's
 * declaration at all — it is a nested mapping the walk reaches on its own, and reporting it here as
 * "not a scalar" would attach an unresolved entry to every ordinary chart values file. For the four
 * other keys a mapping value IS nonsense (`tag:` cannot be a mapping), and stays `unresolved`.
 */
function readKey(
  pair: Pair | undefined,
  keyPath: string,
  mappingIsAnotherMapping = false
): KeyRead {
  if (pair === undefined) return { kind: "absent" };
  const value = pair.value as Node | null | undefined;
  if (value === null || value === undefined) return { kind: "absent" };
  if (mappingIsAnotherMapping && isMap(value)) return { kind: "absent" };
  // (trap 10) THE EDIT SITE IS NOT THE READ SITE.
  if (isAlias(value)) {
    return {
      kind: "unresolved",
      why: `the value is a YAML alias (*${String(value.source)}), so its text lives at the anchor — an edit here would either miss it or move every other alias to that same anchor`,
      node: value,
      path: keyPath
    };
  }
  if (!isScalar(value)) {
    return {
      kind: "unresolved",
      why: "the value is not a scalar, so it names no single version or repository",
      node: value,
      path: keyPath
    };
  }
  // (trap 1) A BLOCK SCALAR'S SOURCE IS NOT AN EDIT TARGET. `tag: |` carries the block's own
  // trailing newline in `source`, and its text spans lines, so neither the raw source nor a
  // trimmed copy is a string an actuator can find and replace on one line of a diff.
  if (value.type === Scalar.BLOCK_LITERAL || value.type === Scalar.BLOCK_FOLDED) {
    return {
      kind: "unresolved",
      why: "the value is a YAML block scalar, whose text spans lines and carries the block's own trailing newline, so it is not a single version string and not something one line of a diff can rewrite",
      node: value,
      path: keyPath
    };
  }
  const text = scalarText(value);
  if (text === undefined) {
    // Either the key declares nothing (`tag:`), or its source text could not be recovered — and the
    // second must never be guessed at from the parsed JS value (trap 1).
    if (value.value === null || value.value === undefined) return { kind: "absent" };
    return {
      kind: "unresolved",
      why: "the scalar's own source text could not be recovered, and YAML coerces an unquoted version (1.20 parses to the number 1.2), so reading the parsed value would produce an edit target that does not appear in the file",
      node: value,
      path: keyPath
    };
  }
  // (trap 2) A Go template is rendered from values this file does not carry.
  if (text.includes("{{")) {
    return {
      kind: "unresolved",
      why: `'${text}' is a Go template, rendered by Helm from values this file does not carry, so resolving it here would produce a confidently wrong answer`,
      node: value,
      path: keyPath
    };
  }
  return { kind: "text", text, node: value, path: keyPath };
}

function joinNotes(...parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * (trap 18) The sentence a rule-(a)-only mapping's un-read `tag:`/`digest:` gets. Naming them is
 * the whole difference between this and the phantom-minting round 5 removed: the key is in the
 * file, SCP saw it, and SCP is saying why it did not treat it as this image's version.
 */
function unreadSiblingNote(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  return (
    `a sibling ${names.map((name) => `'${name}:'`).join(" and ")} was NOT read as this image's version: ` +
    "this mapping is an image only because it carries an `image:` SCALAR, which is a COMPLETE " +
    "reference, and that is the shape of a Kubernetes Container object — where `tag` and `digest` " +
    "are not fields at all and nothing reads them. Put the version in the `image:` reference " +
    "itself, or declare the image as an `image:` block with `repository:` and `tag:` under it"
  );
}

/**
 * THE WHOLE OF THE SHAPE LOGIC, applied to every mapping IN IMAGE CONTEXT — which is what makes one
 * parser cover both a chart's `image:` block and a pod spec's `containers[].image` with no
 * per-convention branch, and what makes raw Kubernetes manifests a registration decision rather
 * than parser work.
 *
 * IMAGE CONTEXT IS THE WHOLE GUARD (trap 13). `repository`, `registry`, `tag` and `digest` are
 * ordinary English words that ordinary values files use for ordinary things, and reading them off
 * every mapping minted a dependency for each one. They are read here only when the `image` key —
 * the same marker the pod-spec walk has always used — says this mapping is about an image.
 */
function readMapping(map: YAMLMap, path: string, ctx: WalkContext, underImageKey: boolean): void {
  const keys = collectKeys(map);

  const pushUnresolved = (
    read: Extract<KeyRead, { kind: "unresolved" }>,
    extra?: string,
    declared?: string
  ): void => {
    ctx.push({
      resolved: false,
      coordinate: read.path,
      ...(declared !== undefined ? { declared } : {}),
      pinned: false,
      keyPath: read.path,
      line: nodeLine(ctx, read.node),
      note: joinNotes(read.why, extra)
    });
  };

  // `image` is read FIRST because it is what establishes context: an `image:` scalar here (rule a),
  // or this mapping being the value of an `image:` key (rule b, carried in by the walk). An
  // `image:` whose value is a MAPPING deliberately does NOT put THIS mapping in context — that
  // mapping is the parent of the image block, and its own `tag:` sibling is not the image's tag.
  const image = readKey(keys.pairs.get(IMAGE_KEY), joinPath(path, IMAGE_KEY), true);
  if (image.kind === "unresolved") {
    // Reported even outside rule (b): the mapping spells `image`, so this IS an image reference,
    // and it is one that cannot be read (an alias, a sequence, a Go template).
    pushUnresolved(image);
    return;
  }
  if (!underImageKey && image.kind !== "text") return; // not about an image at all — say nothing

  /**
   * (trap 18) A `tag:` BESIDE A POD-SPEC `image:` IS A KEY KUBERNETES NEVER READS.
   *
   * Rule (a) — a mapping carrying an exact `image:` SCALAR — admits two populations that look
   * identical to a walker and are not the same thing:
   *
   *   * a chart's own image BLOCK, which happens to spell the repository under `image:` beside a
   *     `registry:` and a `tag:` (ingress-nginx does exactly this). That mapping is ALSO the value
   *     of an `image:` key, so rule (b) holds for it too, and its `tag:` is the image's version —
   *     Helm renders `{{ .registry }}/{{ .image }}:{{ .tag }}` out of it.
   *   * a Kubernetes CONTAINER OBJECT — `containers[]`, `initContainers[]`, or a `sidecars:`/
   *     `extraContainers:` fragment a chart splices into a pod spec with `toYaml`. `image` there is
   *     a COMPLETE reference and `tag` is not a field of the Container schema at all: the API
   *     server ignores it, or with a strict decoder rejects it. Such a mapping is in context by
   *     rule (a) ALONE — it is never the value of an `image:` key.
   *
   * Reading the sibling in the second population is trap 13's phantom one level in, and since
   * M21.7 made values files WRITABLE it is no longer only a wrong row: the sibling's line is the
   * line `locateVersionLine` would anchor a bump to, so SCP would author a pull request that moves
   * a key nothing consumes and changes nothing that runs. `underImageKey` is the discriminator
   * because it is the marker the rest of this parser already uses, not a new heuristic — and a rule
   * keyed on the literal name `containers` would miss `sidecars:` and `extraContainers:`, which
   * become container objects just the same.
   *
   * WHAT IS GIVEN UP, NAMED. A flat `myapp: {image: acme/api, tag: 1.2.3}` — in context by rule (a)
   * alone, but whose `tag:` the chart's own template really does read — is recorded `unpinned` with
   * the un-read key named, instead of pinned to 1.2.3. This file cannot tell that from a container,
   * and a version SCP records is a version SCP will try to bump, so the ambiguity resolves to the
   * side that authors nothing.
   *
   * Declared HERE, above the duplicate report, because that report is a call site of the same rule.
   */
  const siblingKeysAreThisImage = !(image.kind === "text" && !underImageKey);
  const absentKey: KeyRead = { kind: "absent" };

  // (trap 17) A DUPLICATED IMAGE KEY IS NOT PICKED BETWEEN. `uniqueKeys` is off for the composer's
  // quadratic scan, so both pairs arrive; Helm's Go YAML takes the LAST and `collectKeys` kept the
  // FIRST. Reporting is the only honest option, and it is scoped to image context like everything
  // else here — a chart repeating some unrelated key is not this parser's business.
  //
  // AND IT IS SCOPED BY TRAP 18 TOO, which is the same rule applied to the same call site rather
  // than a second one: in a mapping that is in image context by rule (a) ALONE the split keys are
  // not read at all (see `siblingKeysAreThisImage` below), so a duplicated `tag:` there is a
  // duplicate of a key nothing consumes. Reporting it would be the "warning that fires on things
  // that are not image references" failure trap 16 names, reintroduced through the duplicate door.
  const duplicates = (siblingKeysAreThisImage ? IMAGE_KEYS : [IMAGE_KEY]).filter((name) =>
    keys.duplicated.has(name)
  );
  if (duplicates.length > 0) {
    for (const name of duplicates) {
      const pair = keys.pairs.get(name);
      if (pair === undefined) continue;
      const keyPath = joinPath(path, name);
      ctx.push({
        resolved: false,
        coordinate: keyPath,
        pinned: false,
        keyPath,
        line: nodeLine(ctx, (pair.value ?? pair.key) as Node),
        note: `'${name}' is declared more than once in this mapping; Helm's YAML takes the last and a reader takes the first, so which one this image actually uses is not knowable from the file — remove the duplicate`
      });
    }
    return;
  }

  // (trap 10) A MERGE KEY BRINGS IN KEYS THAT ARE NOT IN THIS MAPPING'S AST, so the only honest
  // report is the merge itself — silence about a merged-in image block is the same
  // absence-read-as-nothing this parser exists to remove. IN IMAGE CONTEXT ONLY (trap 16): a
  // `<<: *resourceDefaults` on a resources or nodeSelector block is ordinary YAML, and reporting it
  // stamped the whole manifest `unsupported`, which is a warning that fires on everything.
  const merge = keys.pairs.get(MERGE_KEY);
  if (merge !== undefined) {
    const mergeNode = (merge.value ?? merge.key ?? null) as Node;
    ctx.push({
      resolved: false,
      coordinate: joinPath(path, MERGE_KEY),
      pinned: false,
      keyPath: joinPath(path, MERGE_KEY),
      line: nodeLine(ctx, mergeNode),
      note: "this mapping merges keys from a YAML anchor (<<) and the merged keys are not written here — any image reference among them is declared at the anchor, whose edit site is shared with every other mapping that merges it"
    });
  }

  const registry = readKey(keys.pairs.get(REGISTRY_KEY), joinPath(path, REGISTRY_KEY));
  const repository = readKey(keys.pairs.get(REPOSITORY_KEY), joinPath(path, REPOSITORY_KEY));
  const tag = siblingKeysAreThisImage
    ? readKey(keys.pairs.get(TAG_KEY), joinPath(path, TAG_KEY))
    : absentKey;
  const digest = siblingKeysAreThisImage
    ? readKey(keys.pairs.get(DIGEST_KEY), joinPath(path, DIGEST_KEY))
    : absentKey;

  /**
   * (trap 15) `registry: ""` IS "THE DEFAULT REGISTRY", which is what bitnami-style charts spell
   * when nothing has overridden `global.imageRegistry`. Treated as text it joins to `/acme/api` and
   * splits one image across two coordinates depending on whether a values file said the registry.
   */
  const registryRead =
    registry.kind === "text" && registry.text.trim() !== "" ? registry : undefined;
  const registryText = registryRead?.text;

  /** Refuse an unusable coordinate half at its own key, visibly (trap 14). */
  const pushUnusable = (
    read: Extract<KeyRead, { kind: "text" }>,
    what: "registry" | "repository"
  ): void => {
    ctx.push({
      resolved: false,
      coordinate: read.path,
      declared: read.text,
      pinned: false,
      keyPath: read.path,
      line: nodeLine(ctx, read.node),
      note: `'${read.text}' is not usable as an image ${what} (it is empty, or it has whitespace or an empty path segment). An empty coordinate is not one bad row: 'dependency_lines' is keyed on (org, ecosystem, coordinate, major) org-wide, so every component carrying this placeholder would collapse onto ONE line and one team's subscription would govern another's`
    });
  };

  // -----------------------------------------------------------------------------------------
  // THE COORDINATE — one scalar (`image: repo/name:tag`), or `repository` with an optional
  // `registry`. Never both: `image` as a MAPPING is read when the walk reaches that mapping.
  // -----------------------------------------------------------------------------------------
  let coordinate: string;
  let coordinateNode: Node;
  let coordinatePath: string;
  /** A tag/digest carried by the one-scalar form. It wins over a sibling key of the same name. */
  let refTag: string | undefined;
  let refDigest: string | undefined;
  /** Was the coordinate CONSTRUCTED, i.e. does it appear nowhere contiguously in the file? */
  let splitNote: string | undefined;

  if (image.kind === "text") {
    const split = splitImageRef(image.text);
    // Refused outright rather than minted (traps 5, 14): an unusable name is an identity every
    // malformed manifest in the org would COLLIDE on, and a digest that is not one would be
    // recorded as a pin to bytes no registry can produce.
    const malformed = !isUsableCoordinate(split.name)
      ? "its repository is empty, or has whitespace or an empty path segment"
      : split.tag === ""
        ? "an empty tag"
        : split.digest !== undefined && !isDigestShaped(split.digest)
          ? `'${split.digest}' is not an OCI digest (an algorithm such as sha256, then ':', then its full-length hex)`
          : undefined;
    if (malformed !== undefined) {
      ctx.push({
        resolved: false,
        coordinate: image.path,
        declared: image.text,
        pinned: false,
        keyPath: image.path,
        line: nodeLine(ctx, image.node),
        note: `'${image.text}' is not a well-formed image reference (${malformed})`
      });
      return;
    }
    coordinate = split.name;
    coordinateNode = image.node;
    coordinatePath = image.path;
    refTag = split.tag;
    refDigest = split.digest;
    // STATED RESIDUE (traps 13, 18). ingress-nginx and friends put the repository under `image:`
    // beside a `registry:`; a pod spec's `image:` is a COMPLETE reference and joining would double
    // a registry it already spells. So the sibling is not joined — and not silently dropped
    // either. The same sentence governs `tag:`/`digest:` beside a rule-(a)-ONLY `image:` (trap 18),
    // except that those are not read AT ALL: an un-joined registry still leaves a usable
    // coordinate, while a tag read off a Container object is a version nothing consumes.
    splitNote = joinNotes(
      registryText === undefined
        ? undefined
        : `a sibling 'registry: ${registryText}' is NOT joined onto this coordinate — an 'image:' scalar is a complete reference and joining would double a registry it may already name; if this chart means them to be joined, the coordinate SCP records is the repository half alone`,
      siblingKeysAreThisImage
        ? undefined
        : unreadSiblingNote([TAG_KEY, DIGEST_KEY].filter((name) => keys.pairs.has(name)))
    );
  } else if (repository.kind === "unresolved") {
    pushUnresolved(repository);
    return;
  } else if (repository.kind === "text") {
    if (registry.kind === "unresolved") {
      pushUnresolved(registry);
      return;
    }
    if (!isUsableCoordinate(repository.text)) {
      pushUnusable(repository, "repository");
      return;
    }
    if (registryRead !== undefined && !isUsableCoordinate(registryRead.text)) {
      pushUnusable(registryRead, "registry");
      return;
    }
    coordinate =
      registryText !== undefined ? `${registryText}/${repository.text}` : repository.text;
    coordinateNode = repository.node;
    coordinatePath = repository.path;
    // Stated on the entry rather than hidden, because it is exactly what makes this shape
    // unbumpable by a textual, single-changed-line verifier.
    splitNote =
      registryText !== undefined
        ? "the coordinate is constructed from `registry` + `/` + `repository`, so it appears nowhere contiguously in this file"
        : "the coordinate is on the `repository` line and the version is on another, so no single line of this file carries both";
  } else if (tag.kind === "unresolved") {
    pushUnresolved(tag);
    return;
  } else if (tag.kind === "text") {
    // THE OWNER'S CALLED-OUT CASE. A bare `tag:` whose mapping declares no image and no repository:
    // the image NAME is in the chart's templates or hard-coded, so this file names a version for
    // something it does not name. Reported with the dotted key path as its coordinate — it carries
    // no `version`, so it can never mint a `dependency_lines` row.
    ctx.push({
      resolved: false,
      coordinate: tag.path,
      declared: tag.text,
      pinned: false,
      keyPath: tag.path,
      line: nodeLine(ctx, tag.node),
      note: "no image or repository is declared beside this tag, so which image it versions is not knowable from this file — declare the repository next to the tag, or point a source_mappings path_pattern at the chart that does"
    });
    return;
  } else {
    return; // nothing image-shaped in this mapping
  }

  // -----------------------------------------------------------------------------------------
  // THE VERSION — the reference's own tag wins; otherwise the sibling `tag:` key.
  // -----------------------------------------------------------------------------------------
  if (refTag === undefined && tag.kind === "unresolved") {
    pushUnresolved(
      tag,
      `the image '${coordinate}' IS declared here, but its version is not readable from this file, so no version was recorded rather than a wrong one`
    );
    return;
  }
  if (refDigest === undefined && digest.kind === "unresolved") {
    pushUnresolved(digest);
    return;
  }

  const declaredTag = refTag ?? (tag.kind === "text" ? tag.text : undefined);
  const versionNode = refTag === undefined && tag.kind === "text" ? tag.node : coordinateNode;
  const versionPath = refTag === undefined && tag.kind === "text" ? tag.path : coordinatePath;

  // (trap 5) A `digest:` KEY THAT DOES NOT HOLD A DIGEST. `refDigest` came out of the one-scalar
  // form and was already refused above; this is the split shape's own key, and a `digest: latest`
  // or a truncated hex string here lands in `component_dependencies.resolved_digest` and is then
  // compared against what a registry actually publishes — a pin to bytes that can never match.
  //
  // Refused WITHOUT refusing the declaration: the coordinate and the tag beside it are still read
  // correctly, so dropping them too would lose a real dependency over a bad neighbouring key. The
  // bad digest gets its own reported entry and the surviving row says the digest was refused.
  const digestRefused =
    digest.kind === "text" && refDigest === undefined && !isDigestShaped(digest.text)
      ? digest
      : undefined;
  if (digestRefused !== undefined) {
    ctx.push({
      resolved: false,
      coordinate: digestRefused.path,
      declared: digestRefused.text,
      pinned: false,
      keyPath: digestRefused.path,
      line: nodeLine(ctx, digestRefused.node),
      note: `'${digestRefused.text}' is not an OCI digest (an algorithm such as sha256, then ':', then its full-length hex), so it identifies no bytes; it is reported rather than recorded as a pin to nothing`
    });
  }
  const declaredDigest =
    refDigest ?? (digest.kind === "text" && digestRefused === undefined ? digest.text : undefined);
  const digestNote =
    digestRefused === undefined
      ? undefined
      : "the `digest:` beside this declaration is not an OCI digest and was NOT recorded; the row is pinned by its tag alone";

  if (declaredTag === undefined) {
    // (traps 4, 5) A digest-only pin, or a bare name with neither.
    ctx.push({
      resolved: true,
      coordinate,
      ...(declaredDigest !== undefined ? { digest: declaredDigest } : {}),
      pinned: declaredDigest !== undefined,
      keyPath: versionPath,
      line: nodeLine(ctx, versionNode),
      note: joinNotes(
        declaredDigest === undefined
          ? "no tag is declared; Kubernetes resolves this to :latest at admission, which is a resolution rule and is deliberately not recorded as the declared version"
          : "digest-pinned with no tag; there is no version string to compare, so a bump must be driven by the subscribed line's tag pattern",
        digestNote,
        splitNote
      )
    });
    return;
  }

  // (trap 3) The numeric core comes from the ONE shared helper. Image tags are not semver, so
  // `latest`, `stable` and `edge` yield nothing here and are carried without a comparable version.
  const version = parseComparableVersion(declaredTag);
  ctx.push({
    resolved: true,
    coordinate,
    declared: declaredTag,
    ...(declaredDigest !== undefined ? { digest: declaredDigest } : {}),
    pinned: true,
    keyPath: versionPath,
    line: nodeLine(ctx, versionNode),
    // The note names WHAT WAS READ, never which branch matched — `dockerfile.ts`'s own discipline,
    // and the reason a precision-1 tag gets its own sentence instead of being called a moving tag.
    note: joinNotes(
      version === undefined
        ? `tag "${declaredTag}" carries no parseable version core; it must be skipped, never string-ordered`
        : version.precision === 1
          ? `tag "${declaredTag}" carries a single numeric component, which a registry cannot tell apart from a date stamp or a commit sha; it must not be ordered against another tag`
          : version.precision === 2
            ? `tag "${declaredTag}" is a moving tag: it names a line, not a point, and today resolves to the newest release on it`
            : undefined,
      digestNote,
      splitNote
    )
  });
}

/**
 * Merge the occurrences into declarations.
 *
 * (trap 9) IDENTICAL DECLARATIONS COLLAPSE, because the row they produce collapses:
 * `component_dependencies` is keyed `(org, component, line, manifest_path)`, so a Deployment and a
 * CronJob pinning `acme/api:1.2.3` in one file are ONE row however many times the file says it. The
 * surviving entry NAMES every key path that fed it, so "an edit to one of these leaves the others
 * behind" is a fact an operator reads at ingestion rather than a mystery refusal months later.
 */
function toDeclarations(occurrences: readonly Occurrence[]): DeclaredDependency[] {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const key = occurrence.resolved
      ? // THE SEPARATOR IS WRITTEN AS AN ESCAPE, NOT AS A LITERAL NUL, and that is not cosmetic:
        // three raw NUL bytes made `file(1)` report this source as `data` and made grep SKIP THE
        // WHOLE FILE SILENTLY — so a filterless census (CLAUDE.md) could not see this parser at
        // all. The separator itself is right and unchanged: it cannot occur in a coordinate, a tag
        // or a digest, so no two distinct occurrences can collide onto one group key.
        `r ${occurrence.coordinate}\u0000${occurrence.declared ?? ""}\u0000${occurrence.digest ?? ""}\u0000${occurrence.pinned}`
      : `u ${occurrence.keyPath}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [occurrence]);
    else existing.push(occurrence);
  }

  /** How many DISTINCT resolved declarations each coordinate has in this file. */
  const distinctPerCoordinate = new Map<string, number>();
  for (const [key, members] of groups) {
    if (!key.startsWith("r ")) continue;
    const coordinate = members[0]!.coordinate;
    distinctPerCoordinate.set(coordinate, (distinctPerCoordinate.get(coordinate) ?? 0) + 1);
  }

  const out: DeclaredDependency[] = [];
  for (const members of groups.values()) {
    const first = members[0]!;
    const extra: string[] = [];
    if (members.length > 1) {
      extra.push(
        `declared identically at ${members.length} key paths in this file (${members.map((m) => m.keyPath).join(", ")}), which is ONE inventory row — an edit to one of them would leave the others behind`
      );
    }
    if (first.resolved && (distinctPerCoordinate.get(first.coordinate) ?? 0) > 1) {
      extra.push(
        `this file declares '${first.coordinate}' more than once with differing versions or digests, so a bump cannot be applied by matching the coordinate alone`
      );
    }
    const note = joinNotes(first.note, ...extra);
    // Only a RESOLVED declaration can carry a comparable version. An unresolved entry keeps its raw
    // text in `declared` and no `version`, which is what makes it unable to mint a line row.
    const version =
      first.resolved && first.declared !== undefined
        ? parseComparableVersion(first.declared)
        : undefined;

    out.push({
      ecosystem: "oci",
      coordinate: first.coordinate,
      ...(first.declared !== undefined ? { declared: first.declared } : {}),
      constraint: first.resolved ? (first.pinned ? "pinned" : "unpinned") : "unresolved",
      // An image named in a values file or a pod spec is the image the component RUNS — the FORMAT
      // says so, which is the only basis this package accepts for a scope (never the name).
      scope: "runtime",
      ...(version !== undefined ? { version } : {}),
      ...(first.digest !== undefined ? { digest: first.digest } : {}),
      declaredIn: first.keyPath,
      line: first.line,
      // (trap 9) THE MERGE COUNT AS A NUMBER, not only as the sentence below it. The prose note is
      // what an operator reads; this is what a gate reads. An actuator that edits ONE of n merged
      // sites leaves the other n-1 behind, and a fact that exists only as English cannot refuse
      // that — `@scp/plugin-managed-dep`'s `locateVersionLine` declines to anchor when this is > 1.
      occurrences: members.length,
      ...(note === undefined ? {} : { note })
    });
  }

  // File order, so a Decision reads in the order a human reads the file.
  return out.sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.declaredIn < b.declaredIn ? -1 : 1)
  );
}

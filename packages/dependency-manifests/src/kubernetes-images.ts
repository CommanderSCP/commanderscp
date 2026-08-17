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
 *     `sha` or `imageDigest` is not guessed at.
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
 *     control and returns `[]`.
 *  9. **The same image twice in one file is ONE row, and its bump is correctly ambiguous.** The
 *     inventory's primary key is `(org, component, line, manifest_path)`, so a Deployment and a
 *     CronJob pinning `acme/api:1.2.3` in one file collapse. Identical declarations are therefore
 *     merged into one entry HERE, and the entry's `note` names every key path that fed it — the
 *     ambiguity is reported at ingestion instead of being discovered months later as a mystery
 *     refusal from the bump verifier.
 * 10. **Anchors, aliases and merge keys.** `tag: *appVersion` and `<<: *defaults` are ordinary in
 *     values files, and for them the EDIT SITE IS NOT THE READ SITE: one edit to the anchor moves
 *     every alias, which a single-changed-line verifier would see as one line changed and several
 *     declarations silently moved. So an aliased value is `unresolved`, and a merge key is reported
 *     as `unresolved` too — the keys it merges in are not in this mapping's AST at all, and silence
 *     about them is the exact dishonesty this parser exists to remove. This also settles the
 *     billion-laughs question by construction: alias EXPANSION happens when a document is resolved
 *     to plain JS, and this parser never resolves one — it reads the AST, so the work is linear in
 *     the bytes the 4 MB read cap already bounds.
 * 11. **`image` is matched as an EXACT key, never as a substring.** `imagePullSecrets`,
 *     `imagePullPolicy`, `initImage`, `imageCredentials` and `global.imageRegistry` are not images.
 *     A key matched by "contains `image`" is a label named after what happened to match.
 * 12. **The prune blast radius is larger here than for a Dockerfile.** One values file can be the
 *     sole declaration site for a dozen images, so a mis-parse returning `[]` would unsubscribe a
 *     dozen lines in one pass. That is why trap 8's root rule is a THROW and not a skip.
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
  type Node,
  type Scalar,
  type YAMLMap
} from "yaml";

import { splitImageRef } from "./dockerfile.js";
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

function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
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
    // A billion-laughs values file is therefore linear in the bytes the 4 MB read cap already
    // bounds, with nothing to expand.
    documents = parseAllDocuments(content);
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
  // Kubernetes document.
  if (!anyMapping && roots.some((root) => root !== null && !isMap(root))) {
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
    walk(root, multiDocument ? `doc[${index}]` : "", ctx);
  });

  return toDeclarations(occurrences);
}

/** Every mapping in the document is examined, and every mapping is examined the same way. */
function walk(node: Node, path: string, ctx: WalkContext): void {
  if (isMap(node)) {
    readMapping(node, path, ctx);
    for (const pair of node.items) {
      const key = pair.key;
      const value = pair.value;
      if (!isScalar(key)) continue;
      if (isMap(value) || isSeq(value)) walk(value as Node, joinPath(path, String(key.value)), ctx);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (isMap(item) || isSeq(item)) walk(item as Node, `${path}[${index}]`, ctx);
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
  map: YAMLMap,
  key: string,
  path: string,
  mappingIsAnotherMapping = false
): KeyRead {
  const pair = map.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
  if (pair === undefined) return { kind: "absent" };
  const keyPath = joinPath(path, key);
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
 * THE WHOLE OF THE SHAPE LOGIC, applied to EVERY mapping — which is what makes one parser cover both
 * a chart's `image:` block and a pod spec's `containers[].image` with no per-convention branch, and
 * what makes raw Kubernetes manifests a registration decision rather than parser work.
 */
function readMapping(map: YAMLMap, path: string, ctx: WalkContext): void {
  // (trap 10) A MERGE KEY BRINGS IN KEYS THAT ARE NOT IN THIS MAPPING'S AST, so the only honest
  // report is the merge itself — silence about a merged-in image block is the same
  // absence-read-as-nothing this parser exists to remove. Over-reporting is deliberate and points
  // the same way as trap 8's cost: it never prunes and never mints a row.
  const merge = map.items.find(
    (item) => isScalar(item.key) && String(item.key.value) === MERGE_KEY
  );
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

  const image = readKey(map, IMAGE_KEY, path, true);
  const registry = readKey(map, REGISTRY_KEY, path);
  const repository = readKey(map, REPOSITORY_KEY, path);
  const tag = readKey(map, TAG_KEY, path);
  const digest = readKey(map, DIGEST_KEY, path);

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

  if (image.kind === "unresolved") {
    pushUnresolved(image);
    return;
  }
  if (image.kind === "text") {
    const split = splitImageRef(image.text);
    if (split.name === "" || split.tag === "" || split.digest === "") {
      // Refused outright rather than minted: an empty name is an identity every malformed manifest
      // in the org would collide on, and an empty digest would be recorded as a pin to nothing.
      ctx.push({
        resolved: false,
        coordinate: image.path,
        declared: image.text,
        pinned: false,
        keyPath: image.path,
        line: nodeLine(ctx, image.node),
        note: `'${image.text}' is not a well-formed image reference (an empty name, tag or digest)`
      });
      return;
    }
    coordinate = split.name;
    coordinateNode = image.node;
    coordinatePath = image.path;
    refTag = split.tag;
    refDigest = split.digest;
  } else if (repository.kind === "unresolved") {
    pushUnresolved(repository);
    return;
  } else if (repository.kind === "text") {
    if (registry.kind === "unresolved") {
      pushUnresolved(registry);
      return;
    }
    coordinate = registry.kind === "text" ? `${registry.text}/${repository.text}` : repository.text;
    coordinateNode = repository.node;
    coordinatePath = repository.path;
    // Stated on the entry rather than hidden, because it is exactly what makes this shape
    // unbumpable by a textual, single-changed-line verifier.
    splitNote =
      registry.kind === "text"
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
  const declaredDigest = refDigest ?? (digest.kind === "text" ? digest.text : undefined);
  const versionNode = refTag === undefined && tag.kind === "text" ? tag.node : coordinateNode;
  const versionPath = refTag === undefined && tag.kind === "text" ? tag.path : coordinatePath;

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
      ? `r ${occurrence.coordinate} ${occurrence.declared ?? ""} ${occurrence.digest ?? ""} ${occurrence.pinned}`
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
      ...(note === undefined ? {} : { note })
    });
  }

  // File order, so a Decision reads in the order a human reads the file.
  return out.sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.declaredIn < b.declaredIn ? -1 : 1)
  );
}

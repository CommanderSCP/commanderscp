/** Kubernetes image references. See docs/dependency-manifests.md §35. */
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

/** Is this text usable as an image coordinate at all? See docs/dependency-manifests.md §36. */
export function isUsableCoordinate(text: string): boolean {
  if (text === "" || text !== text.trim()) return false;
  // An empty path segment covers `""`, `"/"`, `"/acme/api"`, `"ghcr.io//api"` and `"acme/api/"`;
  // whitespace anywhere covers a value that is prose rather than a reference.
  return text.split("/").every((segment) => segment !== "" && !/\s/.test(segment));
}

/** One reference as read, before identical ones merge. See docs/dependency-manifests.md §37. */
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

/** ONE pass, not one per key. See docs/dependency-manifests.md §38. */
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

/** A document with NO CONTENT. See docs/dependency-manifests.md §39. */
function isEmptyDocument(root: Node | null): boolean {
  return root === null || (isScalar(root) && root.value === null);
}

function nodeLine(ctx: WalkContext, node: Node): number {
  const range = (node as { range?: [number, number, number] | null }).range;
  return lineOf(ctx.lineStarts, range?.[0] ?? 0);
}

/**
 * Parse every image reference the document declares. See docs/dependency-manifests.md §40.
 * @param content the file's bytes decoded as UTF-8.
 * @returns one entry per DISTINCT declaration, in file order. An entry whose `constraint` is
 * `unresolved` is a reference that was FOUND and could not be resolved from this file; it
 * carries no `version`, so it can never mint a `dependency_lines` row, and the ingestion
 * reports it rather than dropping it.
 * @throws {ManifestParseError} on the empty string, on invalid YAML, and on a stream with no mapping
 * at any document root — a 404 HTML body, an error page and a Git-LFS pointer are all VALID YAML
 * scalars, and returning `[]` for one of them would delete every image row this manifest path
 * holds on the next ingestion pass (traps 8 and 12).
 */
export function parseKubernetesImages(content: string): DeclaredDependency[] {
  // (trap 8) THE EMPTY STRING IS NOT AN EMPTY DOCUMENT SET. An empty 200 body and a file that
  // genuinely holds nothing are indistinguishable here, and neither may be allowed to prune.
  if (content.trim() === "") {
    throw new ManifestParseError("the manifest is empty; an empty body is not a YAML document");
  }

  let documents;
  try {
    // THE AST, NEVER `toJS`. See docs/dependency-manifests.md §41.
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

/** Every mapping examined, and examined the same way. See docs/dependency-manifests.md §42. */
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

/** Read one key, naming every not-a-text outcome. See docs/dependency-manifests.md §43. */
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

/** The sentence an un-read `tag:` or `digest:` gets. See docs/dependency-manifests.md §44. */
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

/** The whole shape logic, applied in image context. See docs/dependency-manifests.md §45. */
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

  /** A `tag:` beside a pod-spec `image:` is never read. See docs/dependency-manifests.md §46. */
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

  // A merge key brings in keys this mapping's AST lacks. See docs/dependency-manifests.md §47.
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

  /** An empty `registry:` means the default registry. See docs/dependency-manifests.md §48. */
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
    // STATED RESIDUE (traps 13, 18). See docs/dependency-manifests.md §49.
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

  // THE VERSION — the reference's own tag wins; otherwise the sibling `tag:` key.
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

  // (trap 5) A `digest:` KEY THAT DOES NOT HOLD A DIGEST. See docs/dependency-manifests.md §50.
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

/** Merge the occurrences into declarations. See docs/dependency-manifests.md §51. */
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

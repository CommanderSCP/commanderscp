/**
 * `Dockerfile` — every `FROM` that names a real image.
 *
 * This is the owner's headline case (proposal §6.3): a component builds `FROM alpine:1.0`, Alpine
 * publishes `1.1`, and the subscription rewrites that one line. Images are also the ecosystem that
 * fits SCP best — the org's own registry IS the index, so this is the only one of the five with no
 * air-gap gap.
 *
 * Four things a naive `/^FROM (\S+)/` gets wrong, and each is handled below:
 *
 * 1. **Multi-stage stage references.** `FROM golang:1.22 AS builder` … `FROM builder` — the second
 *    `FROM` names a STAGE defined earlier in this same file, not an image. Reporting it produces a
 *    phantom dependency on a package named `builder` that no registry has ever heard of, and a
 *    subscription would then either fail forever or, worse, match some unrelated public image.
 *    Stage names are tracked as they are declared and a `FROM` naming one yields nothing.
 * 2. **Digest pins.** `FROM alpine@sha256:…` has no tag at all, and `FROM alpine:3.19@sha256:…`
 *    has both. Tag is a mutable label; the digest is identity (proposal §6.3, *"Tag ≠ identity"*),
 *    so both are carried and neither is derived from the other.
 * 3. **`ARG` interpolation.** `ARG TAG=3.19` / `FROM alpine:${TAG}` looks resolvable inside the
 *    file and is not: `docker build --build-arg TAG=edge` overrides it at build time, so the value
 *    in the file is a DEFAULT, not the value. Resolving it would produce a confidently wrong
 *    version, so it is reported as `unresolved` — the ADR-0032 §7 "skipped rather than guessed"
 *    rule applied to the manifest side.
 * 4. **Bare `FROM alpine`.** No tag is `unpinned`, NOT `latest`. Docker's implicit `:latest` is a
 *    resolution rule; writing "latest" into `declared` would be inventing text the author never
 *    wrote, and the provenance-label lesson says a field named after what we inferred goes false.
 *
 * Also deliberate:
 * - **`FROM scratch` yields nothing.** `scratch` is a reserved empty base with no registry entry and
 *   no versions; there is nothing to subscribe to or bump.
 * - **This file reads build inputs; it is no longer the only image source.** Proposal §6.3 used to
 *   say the scope was the component's own `Dockerfile` `FROM` and NOT its deployment manifests,
 *   because "a Helm values image tag is a *placement* concern owned by the promotion path that
 *   already exists". That clause is **superseded** (docs/proposals/kubernetes-image-references.md
 *   §0): it reasoned about who owns the CHANGE and concluded SCP should not record the
 *   DECLARATION, which does not follow — a `tag: 1.2.3` in a values file this repository owns is a
 *   declaration in exactly the sense `FROM alpine:1.2.3` is. `kubernetes-images.ts` reads those,
 *   into this same `oci` ecosystem and onto the same lines.
 * - **Scope is `build`.** A base image is consumed to produce the artifact. That the layers persist
 *   into the runtime image does not make it a runtime *declaration*; it is declared in the build
 *   recipe, and this package reports the declaration, not the consequence.
 * - The `# escape=` parser directive (which can change the continuation character from `\` to a
 *   backtick) is NOT honoured; it is vanishingly rare outside Windows containers, and a Dockerfile
 *   using it will simply yield fewer/no FROMs rather than wrong ones.
 */
import { ManifestParseError, type DeclaredDependency } from "./types.js";
import { parseComparableVersion } from "./version.js";

/** One logical (continuation-joined) instruction plus the line its first physical line sat on. */
interface LogicalLine {
  readonly text: string;
  readonly line: number;
}

/**
 * Join `\`-continued physical lines into logical instructions.
 *
 * Docker's own parser drops comment lines that appear INSIDE a continuation, which is why comments
 * are stripped here rather than before joining — stripping first would splice a comment's text into
 * the middle of an instruction.
 */
function toLogicalLines(content: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  const physical = content.split(/\r?\n/);

  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i] ?? "";
    const trimmed = raw.trim();

    // A comment line is invisible to the instruction, whether or not we are mid-continuation.
    if (trimmed.startsWith("#")) continue;

    if (buffer === "") {
      if (trimmed === "") continue;
      startLine = i + 1;
    }

    if (trimmed.endsWith("\\")) {
      buffer += `${trimmed.slice(0, -1)} `;
      continue;
    }

    buffer += trimmed;
    out.push({ text: buffer.trim(), line: startLine });
    buffer = "";
  }

  // A file ending mid-continuation still yields what it had; discarding it would lose a real FROM.
  if (buffer.trim() !== "") out.push({ text: buffer.trim(), line: startLine });

  return out;
}

/**
 * Registered OCI digest algorithms and the EXACT length of their lowercase-hex encoding.
 *
 * The length is the half that matters. A shape-only check passes `sha256:abc`, which is not a
 * truncation of anything — it is a value that would be compared against a real 64-character digest
 * for the rest of a subscription's life and never match.
 */
const DIGEST_ALGORITHM_HEX_LENGTH: ReadonlyMap<string, number> = new Map([
  ["sha256", 64],
  ["sha512", 128]
]);

/** `algorithm ":" encoded`, per the OCI image spec's descriptor grammar. */
const DIGEST_SHAPE = /^([a-z0-9]+(?:[.+_-][a-z0-9]+)*):([A-Za-z0-9=_-]+)$/;

/**
 * Is this text an OCI digest?
 *
 * SHARED BY BOTH IMAGE READERS, for the same reason {@link splitImageRef} is: `parseDockerfile`
 * takes a digest off a `FROM …@…` and `parseKubernetesImages` takes one off a `digest:` key or off
 * the same `@`, and both write it to `component_dependencies.resolved_digest` — the column the
 * version poller compares a registry's answer against. A digest is IDENTITY (proposal §6.3, *"Tag ≠
 * identity"*), so recording a value that is not one records a pin to bytes that do not exist:
 * strictly worse than recording no digest, because the row then reads as pinned. Fixing this in one
 * parser and not the other would be the incomplete-census failure — the property is "a digest is
 * written without checking it is one", and it had two instances.
 *
 * Deliberately NOT a general "looks hex-ish" test, and deliberately not a full reference grammar.
 * An unregistered algorithm is allowed at the spec's own minimum of 32 encoded characters;
 * `sha256` and `sha512` must be exactly right.
 */
export function isDigestShaped(text: string): boolean {
  const match = DIGEST_SHAPE.exec(text);
  if (match === null) return false;
  const algorithm = match[1] ?? "";
  const encoded = match[2] ?? "";
  const required = DIGEST_ALGORITHM_HEX_LENGTH.get(algorithm);
  if (required !== undefined) return encoded.length === required && /^[0-9a-f]+$/.test(encoded);
  return encoded.length >= 32;
}

/**
 * Split an image reference into registry+name / tag / digest, brace-aware.
 *
 * EXPORTED FOR ONE OTHER READER, and deliberately not copied: `kubernetes-images.ts` splits the
 * same one-scalar reference (`image: "localhost:5000/foo:1.2"`) out of a YAML document. A second
 * splitter is how the port-vs-tag and the digest-colon rules below come to disagree between two
 * parsers that must place the same image on the same `dependency_lines` row.
 *
 * Brace awareness is load-bearing for exactly one construct: `${BASE:-alpine}` (Docker supports
 * shell-style defaults in `ARG` expansion). A plain "last colon wins" split would cut that in half
 * and report a package named `${BASE` — the classic mis-split. Depth-0 tracking also handles the
 * ordinary registry-port case `localhost:5000/foo:1.2`, where the last depth-0 colon after the last
 * depth-0 slash is the tag separator and the earlier one is a port.
 */
export function splitImageRef(ref: string): { name: string; tag?: string; digest?: string } {
  let depth = 0;
  let lastSlash = -1;
  let lastColon = -1;
  let lastAt = -1;

  for (let i = 0; i < ref.length; i++) {
    const ch = ref[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === "/") lastSlash = i;
      else if (ch === ":") lastColon = i;
      else if (ch === "@") lastAt = i;
    }
  }

  let digest: string | undefined;
  let head = ref;
  if (lastAt !== -1) {
    digest = ref.slice(lastAt + 1);
    head = ref.slice(0, lastAt);
    // Recompute the colon position within the head: a digest is `algo:hex`, so the `@` split must
    // happen first or the digest's own colon would be mistaken for the tag separator.
    lastColon = -1;
    let d = 0;
    for (let i = 0; i < head.length; i++) {
      const ch = head[i];
      if (ch === "{") d++;
      else if (ch === "}") d = Math.max(0, d - 1);
      else if (d === 0 && ch === ":") lastColon = i;
    }
  }

  if (lastColon > lastSlash && lastColon !== -1) {
    return {
      name: head.slice(0, lastColon),
      tag: head.slice(lastColon + 1),
      ...(digest !== undefined ? { digest } : {})
    };
  }
  return { name: head, ...(digest !== undefined ? { digest } : {}) };
}

/**
 * Parse a Dockerfile's `FROM` instructions into declared image dependencies.
 *
 * @param content the file's bytes decoded as UTF-8.
 * @returns one entry per `FROM` that names a real, non-`scratch` image; stage references yield
 *          nothing. Order follows the file.
 * @throws {ManifestParseError} when the content carries no `FROM` instruction at all. Every
 *   Dockerfile has one — it is the only required instruction — so its absence means we were handed
 *   something that is not a Dockerfile: a 404 body, an HTML error page, an unexpanded LFS pointer.
 *   Returning `[]` for that is indistinguishable from "this component's Dockerfile declares no base
 *   image", and the next ingestion pass would silently DELETE the component's image inventory. See
 *   {@link ManifestParseError} — unreadable and empty must never collapse.
 */
export function parseDockerfile(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  /** Whether any instruction was a `FROM`. See the @throws above. */
  let sawFrom = false;
  /**
   * Stage names declared by `AS <name>` so far, lower-cased. Docker matches stage names
   * case-insensitively, and a stage shadows any image of the same name, so membership here is
   * decisive — we never fall back to "maybe it is also an image".
   */
  const stages = new Set<string>();

  for (const { text, line } of toLogicalLines(content)) {
    const tokens = text.split(/\s+/).filter((t) => t !== "");
    const keyword = tokens[0];
    if (keyword === undefined || keyword.toUpperCase() !== "FROM") continue;
    sawFrom = true;

    // Skip instruction flags (`--platform=linux/amd64`, and any future one) without interpreting
    // them: `--platform` selects an architecture of the SAME dependency, so it changes nothing here.
    let idx = 1;
    while (idx < tokens.length && (tokens[idx] ?? "").startsWith("--")) idx++;

    const ref = tokens[idx];
    if (ref === undefined) continue;
    idx++;

    // (1) A reference to an EARLIER stage is not a dependency. This is the case a naive parser gets
    // wrong, and it is negative-controlled in the tests: the same file with a genuine second image
    // must still yield two.
    //
    // The membership test is taken against the stages declared by earlier instructions and BEFORE
    // this instruction's own `AS` name is added. A stage cannot reference itself, so recording first
    // makes `FROM alpine AS alpine` — a stage named after its own base image, which is ordinary
    // style — delete a genuine bumpable dependency. Order is the whole fix.
    const isStageRef = stages.has(ref.toLowerCase());

    // `AS <name>` — recorded on EVERY FROM, including the ones that yield nothing below, because
    // `FROM scratch AS base` and `FROM builder AS test` both declare a stage a later FROM can name.
    const asKeyword = tokens[idx];
    const stageName = tokens[idx + 1];
    if (asKeyword !== undefined && asKeyword.toUpperCase() === "AS" && stageName !== undefined) {
      stages.add(stageName.toLowerCase());
    }

    if (isStageRef) continue;

    // `scratch` is the reserved empty base — no registry, no versions, nothing to bump.
    if (ref.toLowerCase() === "scratch") continue;

    const { name, tag, digest } = splitImageRef(ref);

    // A malformed reference is refused outright rather than minted as a row. `FROM :1.0` has an
    // EMPTY name, and an empty-string coordinate is an identity every malformed manifest in the org
    // would collide on; `FROM alpine@` has an empty digest, which would be recorded as `pinned` —
    // a pin to nothing. Both are the "a dependency with a wrong version is worse than a dependency
    // that is missing" rule this package applies in `go-mod.ts:parseRequireLine`.
    if (name === "" || digest === "" || tag === "") continue;

    // (3) Interpolation in the NAME makes the whole coordinate unknowable — we cannot even say
    // which image this is, so the raw reference is kept verbatim as the coordinate and flagged.
    if (name.includes("$")) {
      out.push({
        ecosystem: "oci",
        coordinate: ref,
        declared: ref,
        constraint: "unresolved",
        scope: "build",
        declaredIn: "FROM",
        line,
        note: "image name is ARG-interpolated; --build-arg overrides the file's default, so the reference cannot be resolved from the manifest alone"
      });
      continue;
    }

    const digestIsInterpolated = digest !== undefined && digest.includes("$");
    const tagIsInterpolated = tag !== undefined && tag.includes("$");

    if (tagIsInterpolated || digestIsInterpolated) {
      out.push({
        ecosystem: "oci",
        coordinate: name,
        declared: tag ?? digest,
        constraint: "unresolved",
        scope: "build",
        declaredIn: "FROM",
        line,
        note: "version is ARG-interpolated; --build-arg overrides the file's default, so it is reported unresolved rather than guessed"
      });
      continue;
    }

    // A `@…` THAT IS NOT A DIGEST. `FROM alpine@latest` and `FROM alpine@sha256:abc` are not pins;
    // recorded verbatim they become a `resolved_digest` that no registry answer can ever equal, so
    // the row reads as identity-pinned and the poller compares against nothing. Reported, so the
    // operator learns it here instead of from a subscription that never fires (ADR-0032 §7).
    if (digest !== undefined && !isDigestShaped(digest)) {
      out.push({
        ecosystem: "oci",
        coordinate: name,
        declared: digest,
        constraint: "unresolved",
        scope: "build",
        declaredIn: "FROM",
        line,
        note: `'${digest}' is not an OCI digest (an algorithm such as sha256, then ':', then its full-length hex), so it identifies no bytes; it is reported rather than recorded as a pin to nothing`
      });
      continue;
    }

    if (tag === undefined) {
      // (2) digest-only pin, or (4) bare name with neither.
      out.push({
        ecosystem: "oci",
        coordinate: name,
        constraint: digest !== undefined ? "pinned" : "unpinned",
        scope: "build",
        ...(digest !== undefined ? { digest } : {}),
        declaredIn: "FROM",
        line,
        ...(digest === undefined
          ? {
              note: "no tag declared; Docker resolves this to :latest at build time, which is a resolution rule and is deliberately not recorded as the declared version"
            }
          : {
              note: "digest-pinned with no tag; there is no version string to compare, so a bump must be driven by the subscribed line's tag pattern"
            })
      });
      continue;
    }

    // A real tag. Its numeric core is extracted by the ONE shared helper — image tags are not
    // semver, so `latest`, `stable`, `edge` and `alpine` all yield undefined here and are simply
    // carried without a comparable version (ADR-0032 §7: skipped, never string-ordered).
    //
    // Note the deliberate asymmetry with `parseImageTagVersion`: on this DECLARED side a single
    // numeric component (`node:20`) is kept, because nothing is being ordered — there is exactly
    // one string and it is the component's current state. On the CANDIDATE side, where a registry's
    // whole tag list is ranked, `parseImageTagVersion` refuses precision-1 tags because a date
    // stamp and a major line are indistinguishable there. Ordering is where the guess would happen.
    const version = parseComparableVersion(tag);

    out.push({
      ecosystem: "oci",
      coordinate: name,
      declared: tag,
      constraint: "pinned",
      scope: "build",
      ...(version !== undefined ? { version } : {}),
      ...(digest !== undefined ? { digest } : {}),
      declaredIn: "FROM",
      line,
      // The note names WHAT WAS READ, not which branch matched. "Moving tag" is only true of a tag
      // that actually spells a partial version line (`3.19`, `3.19-alpine`). A precision-1 tag is
      // NOT reliably one: `1a2b3c4d` (a git sha whose first character happens to be a digit) and
      // `20240115` (a date stamp) both parse to precision 1, and telling an operator that a
      // sha-pinned base image "names a line, not a point" is a provenance label named after the
      // branch that matched — false the moment the branch covers a second kind of input. Precision 1
      // gets its own note, mirroring `parseImageTagVersion`'s default `minPrecision: 2` refusal on
      // the candidate side, and for the same reason.
      ...(version === undefined
        ? {
            note: `tag "${tag}" carries no parseable version core; it must be skipped, never string-ordered`
          }
        : version.precision === 1
          ? {
              note: `tag "${tag}" carries a single numeric component, which a registry cannot tell apart from a date stamp or a commit sha; it must not be ordered against another tag`
            }
          : version.precision === 2
            ? {
                note: `tag "${tag}" is a moving tag: it names a line, not a point, and today resolves to the newest release on it`
              }
            : {})
    });
  }

  if (!sawFrom) {
    throw new ManifestParseError("Dockerfile contains no FROM instruction");
  }

  return out;
}

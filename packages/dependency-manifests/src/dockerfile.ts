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

/** Join continued lines into logical instructions. See docs/dependency-manifests.md §4. */
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

/** Digest algorithms and their exact hex lengths. See docs/dependency-manifests.md §5. */
const DIGEST_ALGORITHM_HEX_LENGTH: ReadonlyMap<string, number> = new Map([
  ["sha256", 64],
  ["sha512", 128]
]);

/** `algorithm ":" encoded`, per the OCI image spec's descriptor grammar. */
const DIGEST_SHAPE = /^([a-z0-9]+(?:[.+_-][a-z0-9]+)*):([A-Za-z0-9=_-]+)$/;

/** Is this text an OCI digest? See docs/dependency-manifests.md §6. */
export function isDigestShaped(text: string): boolean {
  const match = DIGEST_SHAPE.exec(text);
  if (match === null) return false;
  const algorithm = match[1] ?? "";
  const encoded = match[2] ?? "";
  const required = DIGEST_ALGORITHM_HEX_LENGTH.get(algorithm);
  if (required !== undefined) return encoded.length === required && /^[0-9a-f]+$/.test(encoded);
  return encoded.length >= 32;
}

/** Split an image reference, brace-aware. See docs/dependency-manifests.md §7. */
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
  /** Stage names so far, lower-cased like Docker. See docs/dependency-manifests.md §8. */
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

    // A reference to an earlier stage is not a dependency. See docs/dependency-manifests.md §9.
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

    // A malformed reference is refused, never minted. See docs/dependency-manifests.md §10.
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

    // A real tag. See docs/dependency-manifests.md §11.
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
      // The note names what was read, not what matched. See docs/dependency-manifests.md §12.
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

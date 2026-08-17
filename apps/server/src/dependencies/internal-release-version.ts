import {
  ManifestParseError,
  readDeclaredProjectVersion,
  type ProjectVersionEcosystem
} from "@scp/dependency-manifests";
import type { DependencyEcosystem } from "@scp/schemas";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";

/**
 * M21.4 — WHICH VERSION DID THIS RELEASE PUBLISH? (ADR-0032 §7)
 *
 * ============================================================================================
 * THE QUESTION THE ADR DOES NOT ANSWER, AND WHY IT NEEDS ONE FUNCTION WITH FIVE STRATEGIES
 * ============================================================================================
 * ADR-0032 §7 defines internal detection as a DERIVATION — an accepted change, its wave targets,
 * a `prod` deployment-target, the component placed there, the lines that component is declared to
 * produce. It says nothing about what VERSION that release put on those lines, and the derivation
 * does not carry one:
 *
 *   - `scp.change.transitioned` publishes `{fromState, toState, trigger}` and a subject that is the
 *     change object id (`coordination/transition.ts:361-368`). No component, no target, no version.
 *   - `changes.source_ref` carries `{repo, ref, commit, run_url, artifact_digest, sbom}`
 *     (`db/schema.ts:423-437`). A commit and a digest are IDENTITIES; neither is a version.
 *   - `change_wave_targets.observed.images` carries the deployed image refs — `ghcr.io/x/y:1.2.3`
 *     or `...@sha256:...` (`packages/schemas/src/changes.ts:264-272`, ADR-0008 decision 1/2). That
 *     IS a version signal, and it is the only one in the coordination record.
 *
 * So the answer is per-ecosystem, and this module is ONE function with an explicit strategy per
 * ecosystem rather than five scattered lookups, so that "which signal did we use, and why is that
 * signal trustworthy" is answerable by reading {@link resolveReleasedVersion} instead of inferred
 * from whichever branch happened to run. Each strategy names its signal in the result
 * ({@link ReleasedVersion.signal}), and that label is READ FROM THE STRATEGY THAT RAN — never
 * derived from the shape of the answer, which is the provenance-label failure this repo has already
 * shipped once (a Decision whose label named the branch that matched, and went false the moment the
 * branch covered a second kind).
 *
 * ============================================================================================
 * NEVER GUESS A VERSION. NOT ONCE, NOT AS A FALLBACK (ADR-0032 §7)
 * ============================================================================================
 * Every path here ends in either a version this code can point at a source for, or
 * `{determined: false}` with a reason. There is no default, no "best effort", and in particular:
 *
 *   - a DIGEST IS NOT A VERSION. `ghcr.io/x/y@sha256:ab…` identifies bytes and answers "which
 *     bytes", never "which release". Recording a digest in `latest_version` would make
 *     `dependency_lines` read as though the line had a head when nobody knows what it is.
 *   - a COMMIT SHA IS NOT A VERSION, for the same reason and with the extra hazard that a sha is
 *     often numerically PARSEABLE (`1a2b3c4d` parses as major 1 — see `version.ts`'s note), so a
 *     careless parse produces a confident wrong answer rather than an error.
 *   - a BRANCH NAME IS NOT A VERSION. `refs/heads/main` is where the release came from, not what it
 *     was called.
 *
 * The cost of refusing is a missed bump, which is visible: `latest_version` stays null, which
 * ADR-0032's schema already defines as "not yet observed" and explicitly NOT as "no newer version
 * exists". The cost of guessing is a component that LOOKS up to date at a version that was never
 * published — invisible, and it silences the whole feature for that line. That asymmetry is why
 * every refusal below is a named reason rather than a fallback.
 *
 * ============================================================================================
 * THE LINE GUARD IS PART OF THE ANSWER, NOT A SEPARATE NICETY
 * ============================================================================================
 * A dependency line is `(ecosystem, coordinate, MAJOR)` — one component legitimately produces
 * several lines at once (a `1.x` maintenance line and a `2.x` line). A released `1.9.9` recorded
 * against the `2` line is not merely a wrong version, it is a version on the wrong line, and it
 * would make every `2.x` subscriber look ahead of a head that is behind them. So
 * {@link lineAcceptsVersion} refuses the pair unless the line's own major is a PREFIX of the
 * released version's numeric core AT THE LINE'S OWN PRECISION — `3.18` accepts `3.18.4` and refuses
 * `3.19.0`, `v2` accepts `v2.1.0` and refuses `1.9.9`. A major line the version grammar cannot
 * compare is refused too, never assumed to match.
 */

// -------------------------------------------------------------------------------------------
// The manifest-read port
// -------------------------------------------------------------------------------------------

/**
 * Reading ONE file out of a user repo at a ref — the ingress M21.2 built as the `readFileAtRef`
 * `GitProviderAdapter` hook (`packages/plugins/git-provider-core/src/read-file.ts`), taken here as
 * an injected port rather than reached for directly.
 *
 * WHY A PORT, STATED RATHER THAN DISCOVERED: `readFileAtRef` is an ADAPTER hook and is deliberately
 * NOT surfaced on `ExecutorPlugin` (ADR-0032 §9 — the four verbs ARE the structural enforcement of
 * charter principle 1). Measured at HEAD: nothing under `apps/server/src` calls it, and the
 * subprocess plugin host exposes no RPC for it either — NOT ONE of `plugin-host/contract.ts`'s
 * per-kind client shapes carries a file-read method (stated as a property of the whole set rather
 * than as a count of it, because a count goes stale the next time a plugin kind is added). So the
 * server-side route from "a component's git binding" to "this hook, in its subprocess, under the
 * egress guard" DOES NOT EXIST YET; building it means changing `rpc-protocol.ts`,
 * `subprocess-entry.ts`, `contract.ts` and `host.ts`, which is a plugin-host change, not a
 * dependency-detection one.
 *
 * Taking it as a port keeps that gap HONEST instead of hidden: with no reader wired, every language
 * ecosystem resolves to `manifest_reader_unavailable` and records NOTHING, which is exactly the
 * behaviour this module promises for anything it cannot determine — rather than a silent
 * never-detects-anything that reads like "no releases happened".
 */
export type ManifestReader = (request: ReadFileAtRefRequest) => Promise<ReadFileAtRefResult>;

// -------------------------------------------------------------------------------------------
// Result vocabulary
// -------------------------------------------------------------------------------------------

/** WHICH signal answered — set by the strategy that ran, never inferred from the answer's shape. */
export type ReleaseVersionSignal =
  /** `change_wave_targets.observed.images` — the deployed image ref (ADR-0008). */
  | "oci_observed_image"
  /** `changes.source_ref.ref`, when it is a TAG. The Go module version IS its git tag. */
  | "source_ref_tag"
  /** The producing component's own dependency manifest, read at the released commit. */
  | "producer_manifest";

/** Every way this can end in NO version. Each is a distinct, legible fact about the release —
 *  there is deliberately no `unknown` catch-all, because "we do not know why we do not know" is
 *  not an explanation (charter principle 6). */
export type ReleaseVersionUnknownReason =
  /** The succeeded wave target recorded no `observed.images` at all — never observed, or an
   *  executor whose status carries none. */
  | "no_observed_images"
  /** Images were observed, but none of them names this line's coordinate. */
  | "no_matching_image_ref"
  /** The matching image ref is digest-only (`repo@sha256:…`). Bytes, not a release name. */
  | "image_ref_has_no_tag"
  /** Two observed refs name this coordinate at DIFFERENT tags. Picking one would be a guess. */
  | "ambiguous_image_refs"
  /** A Go release is a git tag and `source_ref.ref` is not one. */
  | "go_ref_is_not_a_tag"
  /** `source_ref` carries no commit to read a manifest at. */
  | "no_released_commit"
  /** The component's inventory records no manifest of this ecosystem's kind, so there is no
   *  non-guessed path to read. */
  | "no_manifest_path_known"
  /** No `readFileAtRef` reader is wired into this deployment — see {@link ManifestReader}. */
  | "manifest_reader_unavailable"
  /**
   * THIS BUILD HAS NO STRATEGY FOR THE LINE'S ECOSYSTEM at all — the value in
   * `dependency_lines.ecosystem` is one the strategy table below does not cover (the column is plain
   * `text` with no CHECK, so a row can outlive the enum, and a sixth ecosystem arrives here first).
   *
   * ITS OWN REASON, and that is the whole point of it. It used to report
   * `manifest_reader_unavailable`, whose remedy — "wire a readFileAtRef reader" — has nothing to do
   * with this cause: wiring one would change nothing. That is the provenance-label failure this repo
   * has already shipped once, a label named after the branch that matched going false the moment the
   * branch covered a second case (ADR-0030 §2, charter principle 6).
   */
  | "no_strategy_for_ecosystem"
  /** The reader answered `not_found` for every candidate manifest. */
  | "manifest_not_found"
  /** The reader refused it (too large / not a file / not text), or the content did not parse as
   *  the format at all — a `ManifestParseError`. */
  | "manifest_unreadable"
  /** The manifest is readable and states no version of its own. */
  | "manifest_declares_no_version"
  /** The manifest expresses a version that cannot be known without resolution this path is
   *  forbidden to perform (`${revision}`, an inherited parent POM, PEP 621 `dynamic`). */
  | "manifest_version_unresolved"
  /** Two candidate manifests state DIFFERENT versions for the same component. */
  | "ambiguous_manifest_versions";

export type ReleasedVersion =
  | {
      readonly determined: true;
      readonly signal: ReleaseVersionSignal;
      /** The version text as the signal spelled it — never normalised, for the same reason
       *  `dependency_lines.coordinate` is stored verbatim. */
      readonly version: string;
      /** `oci` only, and `null` rather than absent when the observed ref carried none. See
       *  {@link resolveReleasedVersion} for why an ABSENT digest must still be written. */
      readonly digest: string | null;
      /** Human-readable provenance — what was read, and where. */
      readonly why: string;
    }
  | {
      readonly determined: false;
      readonly reason: ReleaseVersionUnknownReason;
      readonly detail: string;
    };

// -------------------------------------------------------------------------------------------
// Image refs
// -------------------------------------------------------------------------------------------

/** One `observed.images` entry, split into the three things a ref can carry. */
export interface ParsedImageRef {
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

/**
 * Split `ghcr.io/acme/api:1.2.3`, `ghcr.io/acme/api@sha256:ab…` and
 * `ghcr.io/acme/api:1.2.3@sha256:ab…` into repository / tag / digest.
 *
 * The digest is split off FIRST, then the tag — and the tag search starts after the last `/`,
 * because a registry host may carry a PORT (`registry.internal:5000/acme/api:1.2.3`) and a naive
 * "split on the last colon" reads `5000/acme/api` as the tag on a ref with no tag at all. That is a
 * silently wrong parse, which is the class of bug this whole module exists to refuse.
 */
export function parseImageRef(ref: string): ParsedImageRef | null {
  const trimmed = ref.trim();
  if (trimmed === "") return null;

  let rest = trimmed;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1).trim();
    rest = rest.slice(0, at);
    if (digest === "") digest = undefined;
  }

  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1).trim();
    rest = rest.slice(0, colon);
    if (tag === "") tag = undefined;
  }

  if (rest.trim() === "") return null;
  return {
    repository: rest.trim(),
    ...(tag !== undefined ? { tag } : {}),
    ...(digest !== undefined ? { digest } : {})
  };
}

// -------------------------------------------------------------------------------------------
// The line guard
// -------------------------------------------------------------------------------------------

/**
 * WHICH LINE A RELEASE LANDS ON IS NOT DECIDED IN THIS FILE — it is `line-head.ts`'s
 * `lineAcceptsVersion`, the SAME function the third-party poll's ranking uses, re-exported here so
 * this module's callers keep one import.
 *
 * It used to be a second implementation living here, and the two disagreed in a way no type could
 * catch: this one compared only the numeric core, so an `oci` line declared as the `-alpine` VARIANT
 * took a plain glibc tag as its head, while the poll — reading the same `tag_pattern` as the literal
 * variant suffix — would never have offered one. `tag_pattern` had two meanings; it now has one, in
 * one place, and this file has no reading of its own left to drift.
 *
 *     line `1`                  accepts 1.2.3, 1.0.0      refuses 2.0.0
 *     line `v2`                 accepts v2.1.0, 2.1.0     refuses 1.9.9
 *     line `3.18`               accepts 3.18.4            refuses 3.19.0
 *     line `3.18` + `-alpine`   accepts 3.18.4-alpine     refuses 3.18.4 and 3.18.4-slim
 */
export { lineAcceptsVersion } from "./line-head.js";
export type { LineAcceptance, LineAcceptanceReason } from "./line-head.js";

// -------------------------------------------------------------------------------------------
// The strategy
// -------------------------------------------------------------------------------------------

/** Which dependency-manifest filename states the PROJECT's own version, per ecosystem. Used to
 *  pick candidates out of the component's ALREADY-RECORDED manifest paths — never to guess a path
 *  that was not observed. `requirements.txt` is absent on purpose: it declares dependencies and
 *  never a project version. */
const PROJECT_MANIFEST_BASENAME: Record<ProjectVersionEcosystem, string> = {
  npm: "package.json",
  python: "pyproject.toml",
  maven: "pom.xml"
};

/** The ecosystems whose released version is read from the producer's own manifest. `go` and `oci`
 *  are absent because their versions live elsewhere — see the switch in
 *  {@link resolveReleasedVersion}. */
function projectVersionEcosystem(
  ecosystem: DependencyEcosystem
): ProjectVersionEcosystem | undefined {
  return ecosystem === "npm" || ecosystem === "python" || ecosystem === "maven"
    ? ecosystem
    : undefined;
}

export interface ResolveReleasedVersionInput {
  /** The line the release might have moved. */
  readonly line: { readonly ecosystem: DependencyEcosystem; readonly coordinate: string };
  /** `changes.source_ref`'s canonical keys, as far as they were populated. */
  readonly sourceRef: {
    readonly repo?: string | undefined;
    readonly ref?: string | undefined;
    readonly commit?: string | undefined;
  };
  /** Every `observed.images` entry from the SUCCEEDED prod wave targets this component was
   *  released through. Deduplicated by the caller; order is irrelevant. */
  readonly observedImages: readonly string[];
  /** Dependency-manifest paths the component's own inventory already records
   *  (`component_dependencies.manifest_path`, M21.2). The producer's manifest location is READ
   *  from what ingestion observed, never guessed from the component's name. */
  readonly manifestPaths: readonly string[];
  /** Absent when no reader is wired — see {@link ManifestReader}. */
  readonly readManifest?: ManifestReader | undefined;
}

/** How many candidate manifests one component's version will be read from. A component with more
 *  than a handful of `package.json` files in its inventory is a monorepo root, and reading all of
 *  them is neither cheap nor more correct — the disagreement check below already refuses to pick. */
const MAX_CANDIDATE_MANIFESTS = 4;

/**
 * THE one entry point. Given a line and everything the coordination record knows about the release
 * that just happened, return the version it published — or the reason there is none.
 *
 * The switch below IS the per-ecosystem strategy table, and each arm states its own signal:
 *
 *   `oci`                  the deployed image ref (`observed.images`). Records the TAG as the
 *                          version and the DIGEST alongside it, because a mutable tag is not an
 *                          identity (ADR-0032 §7).
 *   `go`                   the git TAG in `source_ref.ref`. `go.mod` declares a module PATH and no
 *                          version — a Go module's version IS its tag — so a non-tag ref yields
 *                          nothing rather than a guess.
 *   `npm`/`python`/`maven` the producing component's OWN manifest, read at the released COMMIT.
 *                          This is the same "formulated via the users' code" ingress the inventory
 *                          itself is built from (M21.2's `readFileAtRef`), so it inherits its
 *                          decode bound, its URL-safety asserts and its egress guard.
 */
export async function resolveReleasedVersion(
  input: ResolveReleasedVersionInput
): Promise<ReleasedVersion> {
  if (input.line.ecosystem === "oci") return resolveFromObservedImages(input);
  if (input.line.ecosystem === "go") return resolveFromSourceRefTag(input);
  const ecosystem = projectVersionEcosystem(input.line.ecosystem);
  if (ecosystem === undefined) {
    // Unreachable while `DependencyEcosystem` has five members, and deliberately NOT a silent
    // `undefined`: a sixth ecosystem must arrive here as an explicit refusal, never as a version.
    // Its OWN reason — reporting `manifest_reader_unavailable` here named a remedy ("wire a
    // readFileAtRef reader") that would not fix this at all.
    return {
      determined: false,
      reason: "no_strategy_for_ecosystem",
      detail:
        `no released-version strategy is defined for ecosystem '${input.line.ecosystem}' in this ` +
        `build — this is not a missing reader, it is a line whose ecosystem this build does not know`
    };
  }
  return resolveFromProducerManifest(input, ecosystem);
}

/**
 * `oci` — the version signal that already exists in the coordination record.
 *
 * `observed.images` is what the executor reported it actually deployed (ADR-0008 decision 1/2), so
 * for an internal release it is a first-hand statement about bytes that reached prod, not a
 * registry ranking. Matching is by REPOSITORY, compared VERBATIM against the line's coordinate —
 * the same rule the whole inventory keys on (`DependencyCoordinateSchema`: `@acme/lib`, `acme/lib`
 * and `acme-lib` collapse under slugification and must not be merged here either).
 *
 * A digest-only ref determines NOTHING. It is the single most tempting place in this file to fall
 * back — the digest is right there, it is unambiguous, and it would make the line look observed —
 * and it is exactly the fallback ADR-0032 §7 forbids: `latest_version` is a version, and a digest
 * answers a different question.
 */
function resolveFromObservedImages(input: ResolveReleasedVersionInput): ReleasedVersion {
  if (input.observedImages.length === 0) {
    return {
      determined: false,
      reason: "no_observed_images",
      detail:
        "the succeeded prod wave target(s) recorded no observed.images — the executor's status " +
        "carried none, so nothing here states which image reached prod"
    };
  }

  const matches: ParsedImageRef[] = [];
  for (const raw of input.observedImages) {
    const parsed = parseImageRef(raw);
    if (parsed && parsed.repository === input.line.coordinate) matches.push(parsed);
  }
  if (matches.length === 0) {
    return {
      determined: false,
      reason: "no_matching_image_ref",
      detail: `none of the observed image refs names '${input.line.coordinate}' (observed: ${input.observedImages.join(", ")})`
    };
  }

  const tagged = matches.filter((m) => m.tag !== undefined);
  if (tagged.length === 0) {
    return {
      determined: false,
      reason: "image_ref_has_no_tag",
      detail: `'${input.line.coordinate}' was observed by digest only — a digest identifies bytes, not a release (ADR-0032 §7)`
    };
  }
  const distinctTags = [...new Set(tagged.map((m) => m.tag as string))];
  if (distinctTags.length > 1) {
    return {
      determined: false,
      reason: "ambiguous_image_refs",
      detail: `'${input.line.coordinate}' was observed at more than one tag (${distinctTags.join(", ")}) — picking one would be a guess`
    };
  }
  const tag = distinctTags[0] as string;
  const distinctDigests = [
    ...new Set(tagged.filter((m) => m.tag === tag && m.digest).map((m) => m.digest as string))
  ];
  if (distinctDigests.length > 1) {
    return {
      determined: false,
      reason: "ambiguous_image_refs",
      detail: `'${input.line.coordinate}:${tag}' was observed at more than one digest (${distinctDigests.join(", ")}) — the tag has been repointed and neither reading is the head`
    };
  }

  return {
    determined: true,
    signal: "oci_observed_image",
    version: tag,
    // `null` when no digest was observed — a true "this release's bytes are not known here", never
    // an absence that would let a PREVIOUS observation's digest sit beside a NEW version and read as
    // "1.2.4 is these bytes" about bytes that are 1.2.3's. The version and its digest are written
    // together by `recordDependencyLineHead`, which is why this field cannot be omitted.
    digest: distinctDigests[0] ?? null,
    why: `observed image ref '${input.line.coordinate}:${tag}' on the succeeded prod wave target`
  };
}

/**
 * `go` — the git tag, and only a git tag.
 *
 * There is no version in `go.mod` to read: it declares the module PATH, and the Go toolchain
 * resolves a version from the repository's tags. So `source_ref.ref` is the whole signal, and it
 * determines a version only when it IS a tag. `refs/heads/main` is where the release came from, not
 * what it was called — and a bare commit sha parses as a version (`1a2b3c4d` → major 1; see
 * `version.ts`), so accepting anything but an explicit `refs/tags/` ref would produce confident
 * nonsense rather than an error.
 */
function resolveFromSourceRefTag(input: ResolveReleasedVersionInput): ReleasedVersion {
  const ref = input.sourceRef.ref?.trim() ?? "";
  const TAG_PREFIX = "refs/tags/";
  if (!ref.startsWith(TAG_PREFIX) || ref.length === TAG_PREFIX.length) {
    return {
      determined: false,
      reason: "go_ref_is_not_a_tag",
      detail:
        `a Go module's version is its git tag and source_ref.ref is '${ref || "(absent)"}' — ` +
        "not a tag, so this release names no version"
    };
  }
  const tag = ref.slice(TAG_PREFIX.length);
  return {
    determined: true,
    signal: "source_ref_tag",
    version: tag,
    digest: null,
    why: `changes.source_ref.ref names the git tag '${tag}'`
  };
}

/**
 * `npm` / `python` / `maven` — the producing component's own manifest at the released commit.
 *
 * WHERE the manifest is comes from the component's OWN INVENTORY (`component_dependencies`'s
 * `manifest_path`, written by M21.2 ingestion), never from a convention: a monorepo component's
 * `package.json` is at `services/api/package.json` and guessing the repo root would read a
 * different package's version and be confidently wrong. A component whose inventory records no
 * manifest of the right kind yields `no_manifest_path_known` — a legible "we have never seen this
 * component's manifest", which is true.
 *
 * WHICH COMMIT is `source_ref.commit`, not a branch: `readFileAtRef` returns the commit a ref
 * RESOLVED to precisely because a branch name is not an identity, and reading at a branch would
 * report whatever HEAD says now rather than what was released.
 *
 * TWO CANDIDATES THAT DISAGREE REFUSE. A component with a root and a workspace `package.json` in
 * its inventory has two plausible identities; picking the first would make the answer depend on
 * sort order.
 */
async function resolveFromProducerManifest(
  input: ResolveReleasedVersionInput,
  ecosystem: ProjectVersionEcosystem
): Promise<ReleasedVersion> {
  const basename = PROJECT_MANIFEST_BASENAME[ecosystem];
  const candidates = [...input.manifestPaths]
    .filter((path) => path === basename || path.endsWith(`/${basename}`))
    .sort()
    .slice(0, MAX_CANDIDATE_MANIFESTS);
  if (candidates.length === 0) {
    return {
      determined: false,
      reason: "no_manifest_path_known",
      detail: `this component's inventory records no '${basename}' — the released version is stated there and nowhere else, and its location is read from the inventory rather than assumed`
    };
  }

  const commit = input.sourceRef.commit?.trim() ?? "";
  if (commit === "") {
    return {
      determined: false,
      reason: "no_released_commit",
      detail:
        "changes.source_ref carries no commit — the manifest must be read at the commit that was " +
        "released, never at a branch head that has since moved"
    };
  }
  if (input.readManifest === undefined) {
    return {
      determined: false,
      reason: "manifest_reader_unavailable",
      detail:
        "no readFileAtRef reader is wired into this deployment, so the producing component's " +
        "manifest cannot be read — recording nothing rather than inventing a version"
    };
  }

  const found: { path: string; version: string; declaredIn: string }[] = [];
  let lastRefusal: ReleasedVersion | undefined;
  for (const path of candidates) {
    let result: ReadFileAtRefResult;
    try {
      result = await input.readManifest({
        ...(input.sourceRef.repo ? { repo: input.sourceRef.repo } : {}),
        path,
        ref: commit
      });
    } catch (err) {
      // A THROW from the hook is auth/5xx/egress/redirect or a caller bug (`assertSafeRepo` and
      // friends). Caught per manifest, exactly as `index.ts`'s caller contract requires: unhandled,
      // one bad fetch turns the whole detection run into a rejected job.
      lastRefusal = {
        determined: false,
        reason: "manifest_unreadable",
        detail: `reading '${path}' at ${commit} failed: ${err instanceof Error ? err.message : String(err)}`
      };
      continue;
    }

    if (result.outcome === "not_found") {
      lastRefusal = {
        determined: false,
        reason: "manifest_not_found",
        detail: `'${path}' is not present at ${commit} (${result.missing})`
      };
      continue;
    }
    if (result.outcome === "refused") {
      lastRefusal = {
        determined: false,
        reason: "manifest_unreadable",
        detail: `'${path}' at ${commit} was refused: ${result.reason} — ${result.detail}`
      };
      continue;
    }

    let declared;
    try {
      declared = readDeclaredProjectVersion(ecosystem, result.content);
    } catch (err) {
      // THE CATCH THE PARSER CONTRACT DEMANDS. A 404 HTML body, an unexpanded Git-LFS pointer and a
      // truncated response all arrive here as strings and all land on a `ManifestParseError`.
      // Uncaught it rejects the job; treated as "declares nothing" it would report a false absence.
      lastRefusal = {
        determined: false,
        reason: "manifest_unreadable",
        detail:
          err instanceof ManifestParseError
            ? `'${path}' at ${commit} did not parse as ${ecosystem}: ${err.message}`
            : `'${path}' at ${commit} could not be read: ${err instanceof Error ? err.message : String(err)}`
      };
      continue;
    }

    if (declared.outcome === "unresolved") {
      lastRefusal = {
        determined: false,
        reason: "manifest_version_unresolved",
        detail: `'${path}' at ${commit}: ${declared.detail}`
      };
      continue;
    }
    if (declared.outcome === "absent") {
      lastRefusal = {
        determined: false,
        reason: "manifest_declares_no_version",
        detail: `'${path}' at ${commit}: ${declared.detail}`
      };
      continue;
    }
    found.push({ path, version: declared.version, declaredIn: declared.declaredIn });
  }

  const distinct = [...new Set(found.map((f) => f.version))];
  if (distinct.length > 1) {
    return {
      determined: false,
      reason: "ambiguous_manifest_versions",
      detail: `this component's ${basename} files disagree (${found.map((f) => `${f.path}=${f.version}`).join(", ")})`
    };
  }
  const one = found[0];
  if (!one) {
    return (
      lastRefusal ?? {
        determined: false,
        reason: "manifest_declares_no_version",
        detail: `no candidate ${basename} stated a version at ${commit}`
      }
    );
  }
  return {
    determined: true,
    signal: "producer_manifest",
    version: one.version,
    // A language ecosystem has no digest at all, so the pair this observation writes is
    // (version, null) — see `recordDependencyLineHead`'s "the digest belongs to the version".
    digest: null,
    why: `'${one.path}' at ${commit} declares ${one.declaredIn} = ${one.version}`
  };
}

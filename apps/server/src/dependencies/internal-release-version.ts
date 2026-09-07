import {
  ManifestParseError,
  readDeclaredProjectVersion,
  type ProjectVersionEcosystem
} from "@scp/dependency-manifests";
import type { DependencyEcosystem } from "@scp/schemas";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import { isPersistedJsonEntriesElision } from "@scp/runner-launcher";

/** M21.4 — WHICH VERSION DID THIS RELEASE PUBLISH? See docs/dependencies.md §250. */

/** Reading ONE file out of a user repo at a ref. See docs/dependencies.md §251. */
export type ManifestReader = (request: ReadFileAtRefRequest) => Promise<ReadFileAtRefResult>;

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
  /**
   * THE OBSERVED-IMAGE LIST WAS CUT SHORT before this coordinate could be ruled out — MEDIUM, M23.0
   * verification pass 8, and its own reason for the reason `no_strategy_for_ecosystem` is its own.
   *
   * `observed_state` is a plugin-supplied `jsonb` payload bounded at the store
   * (`wave-targets-repo.ts`), and an Argo CD Application's `status.summary.images` is the uncapped
   * image list across every managed resource — an umbrella app blows the whole-value budget on its
   * own, at a measured 73 refs. The bound then truncates the array's tail and leaves a recognisable
   * marker in its place ({@link isPersistedJsonEntriesElision}).
   *
   * A MISS AFTER A CUT IS NOT EVIDENCE OF ABSENCE. Reported as `no_matching_image_ref` it says "the
   * executor deployed these images and none of them was yours", which is a statement about the
   * EXECUTOR and is false — the platform stopped writing the list down. That is the provenance-label
   * failure this repository has already shipped (charter principle 6), and it is the one that makes
   * the difference operationally: the remedy for `no_matching_image_ref` is to look at what the
   * pipeline actually pushed, and the remedy for this is to raise the bound or narrow the reading.
   */
  | "observed_images_elided"
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
      readonly why: string;
    }
  | {
      readonly determined: false;
      readonly reason: ReleaseVersionUnknownReason;
      readonly detail: string;
    };

/** One `observed.images` entry, split into the three things a ref can carry. */
export interface ParsedImageRef {
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
}

/** Splits an image reference in each of its three forms. See docs/dependencies.md §252. */
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

/** WHICH LINE A RELEASE LANDS ON IS NOT DECIDED IN THIS FILE. See docs/dependencies.md §253. */
export { lineAcceptsVersion } from "./line-head.js";
export type { LineAcceptance, LineAcceptanceReason } from "./line-head.js";

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

/** THE one entry point. See docs/dependencies.md §254. */
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

/** The version signal already in the coordination record. See docs/dependencies.md §255. */
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

  // WAS THE LIST CUT? Read BEFORE the match loop is judged, because it changes what a miss means.
  // The entry is left in `observedImages` rather than filtered out on the way here on purpose: it is
  // part of the honest record, it is what lands in the Decision's `inputContext`, and a reader that
  // stripped it would have destroyed the only evidence that the reading is incomplete.
  const elided = input.observedImages.some(
    (raw) => typeof raw === "string" && isPersistedJsonEntriesElision(raw)
  );

  const matches: ParsedImageRef[] = [];
  for (const raw of input.observedImages) {
    const parsed = parseImageRef(raw);
    if (parsed && parsed.repository === input.line.coordinate) matches.push(parsed);
  }
  if (matches.length === 0) {
    // A MISS AFTER A CUT IS NOT A MISS. `no_matching_image_ref` asserts something about the
    // executor; only the un-cut case is entitled to say it.
    if (elided) {
      return {
        determined: false,
        reason: "observed_images_elided",
        detail:
          `none of the RECORDED image refs names '${input.line.coordinate}', and the recorded list ` +
          `was truncated by the persisted-JSON bound — the refs after the cut were never compared, ` +
          `so this is not a statement that the executor did not deploy it (observed: ` +
          `${input.observedImages.join(", ")})`
      };
    }
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
    // A MATCH IN A TRUNCATED LIST STILL DETERMINES, and says so. See docs/dependencies.md §256.
    why: elided
      ? `observed image ref '${input.line.coordinate}:${tag}' on the succeeded prod wave target — ` +
        `the recorded image list was truncated by the persisted-JSON bound, so the disagreement ` +
        `checks saw only the refs before the cut`
      : `observed image ref '${input.line.coordinate}:${tag}' on the succeeded prod wave target`
  };
}

/** `go` — the git tag, and only a git tag. See docs/dependencies.md §257. */
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

/** `npm` / `python` / `maven`. See docs/dependencies.md §258. */
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

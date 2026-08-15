import { compareVersions, type ComparableVersion } from "@scp/dependency-manifests";
import { resolveSkopeo } from "@scp/cosign";
import type {
  DependencyIndexEcosystem,
  DependencyIndexResult,
  DependencyIndexUnavailableReason,
  DependencyIndexVersion
} from "@scp/plugin-api";
import type {
  PluginHost,
  PluginHostInstanceConfig,
  PluginModule
} from "../plugin-host/contract.js";
import { parseRegistryHostList } from "../federation/artifact-verify.js";
import { lineAcceptsVersion, type LineHeadIdentity, type ThirdPartyLine } from "./line-head.js";
import {
  lookupFeedVersions,
  readDependencyIndexFeed,
  type FeedRead
} from "./version-index-feed.js";

/**
 * M21.4 — THE THIRD-PARTY VERSION INDEX SEAM (ADR-0032 §7).
 *
 * Two jobs, and keeping them in one file is deliberate:
 *
 *  1. REACH an index for one ecosystem — through the plugin host, so `egress-guard.ts` and the
 *     per-instance `allowedHosts` allowlist apply to an operator-configurable registry URL — or say
 *     precisely why it could not be reached.
 *  2. RANK what came back, in the ONE place ranking is allowed to happen.
 *
 * NEVER GUESS A VERSION (ADR-0032 §7). This is the rule the whole module is arranged around, so it
 * is worth stating as the property rather than the behaviour: **if a version cannot be determined,
 * NOTHING is recorded and the reason is legible.** A wrong version is worse than no version, because
 * a wrong one makes a component look up to date — a missed bump is a delay, a wrong bump is a commit
 * in someone's repository. Concretely:
 *
 *  - ordering is `@scp/dependency-manifests`'s `compareVersions` and nothing else. There is no
 *    string comparison of versions anywhere in this file, and there must never be: string order
 *    gives `"9" > "10"` and `"1.2.3-alpine" < "1.2.3"`.
 *  - a candidate whose text does not parse is SKIPPED and COUNTED, never coerced.
 *  - a line whose own `major` does not parse yields `undetermined`, not a scan of everything.
 *  - `unavailable` (nothing answered) is a DIFFERENT outcome from `undetermined` (something answered
 *     and nothing on the line could be understood) and from a head being unchanged. Collapsing any
 *     two of those makes an air-gapped estate indistinguishable from a fully up-to-date one.
 *
 * THE INDEXES ARE OPERATOR CONFIG, NOT TENANT CONFIG. Each ecosystem's base URL comes from this
 * process's own environment, is unset by default, and reaches the plugin instance as its config
 * together with an `allowedHosts` entry derived from that same URL. An unset URL is not a
 * degradation to "no new version" — it is `not_configured`, the air-gap default (charter principle
 * 5: nothing phones home because someone installed the chart).
 *
 * IMAGES NEED NO FALLBACK. `oci` is configured from the allowlist the deployment ALREADY has
 * (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`) and the vendored skopeo it ALREADY resolves, so in an
 * air-gapped domain the org's own registry is a working index while the four language ecosystems
 * report unavailable. `version-poll.integration.test.ts` pins exactly that asymmetry.
 */

// -------------------------------------------------------------------------------------------
// Which plugin module serves which ecosystem
// -------------------------------------------------------------------------------------------

/** Total over `DependencyEcosystem` by construction — adding an ecosystem to the enum without an
 *  index here is a compile error, not a silent "this one never gets polled". */
export const INDEX_MODULE_BY_ECOSYSTEM: Record<DependencyIndexEcosystem, PluginModule> = {
  go: "dependency-index-go",
  npm: "dependency-index-npm",
  python: "dependency-index-pypi",
  maven: "dependency-index-maven",
  oci: "dependency-index-oci"
};

/** The env var an operator sets to point an ecosystem at an index. `oci` has none: its reach is the
 *  existing registry allowlist, not a new URL. */
export const INDEX_URL_ENV_BY_ECOSYSTEM: Record<DependencyIndexEcosystem, string | null> = {
  go: "SCP_DEPENDENCY_INDEX_GO_URL",
  npm: "SCP_DEPENDENCY_INDEX_NPM_URL",
  python: "SCP_DEPENDENCY_INDEX_PYTHON_URL",
  maven: "SCP_DEPENDENCY_INDEX_MAVEN_URL",
  oci: null
};

/**
 * The plugin-instance config for one ecosystem's index, or `null` when this deployment has none.
 *
 * `allowedHosts` is derived from the operator's OWN url rather than taken from anywhere a tenant can
 * write — the same discipline `executor-bindings-repo.ts` applies — so the egress allowlist and the
 * target can never disagree. `allowInternalEgress` is deliberately NOT set: a language index is a
 * registry, and pointing one at `127.0.0.1`/`10.x` is the SSRF shape MAJOR #6 closed. An operator
 * running an in-cluster mirror reaches it the same way every other tenant-configurable plugin does
 * (the two-layer `SCP_INTERNAL_EGRESS_HOSTS` + execution-system declaration), which this path
 * deliberately does not shortcut.
 */
export function resolveIndexInstanceConfig(
  ecosystem: DependencyIndexEcosystem,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env
): PluginHostInstanceConfig | null {
  const module = INDEX_MODULE_BY_ECOSYSTEM[ecosystem];
  const id = `dependency-index:${ecosystem}:${orgId}`;

  if (ecosystem === "oci") {
    // NO NEW MECHANISM (the M21.4 constraint): the image index reuses the reach this deployment
    // already has — the pinned vendored skopeo `governance/scan-db.ts` refreshes through and the
    // `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist `federation/artifact-verify.ts` guards with.
    const allowedRegistryHosts = parseRegistryHostList(env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS);
    if (allowedRegistryHosts.length === 0) return null;
    const skopeo = resolveSkopeo();
    if (skopeo.source === "missing") return null;
    return {
      id,
      module,
      orgId,
      scopeKey: "dependency-index",
      config: {
        // SERVER-INJECTED, never tenant — the manifest's `configSchema` does not admit these keys,
        // so a binding cannot supply them and this spread is the only source.
        skopeoBinary: skopeo.bin,
        allowedRegistryHosts,
        insecureRegistryHosts: parseRegistryHostList(env.SCP_ARTIFACT_INSECURE_HOSTS)
      }
    };
  }

  const envVar = INDEX_URL_ENV_BY_ECOSYSTEM[ecosystem];
  const baseUrl = envVar ? env[envVar]?.trim() : undefined;
  if (!baseUrl) return null;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // A malformed operator URL must not become an unguarded request. Treated as "no index", which
    // surfaces to the caller as `not_configured` with the env var named.
    return null;
  }
  return {
    id,
    module,
    orgId,
    scopeKey: "dependency-index",
    config: { baseUrl },
    allowedHosts: [host]
  };
}

// -------------------------------------------------------------------------------------------
// Ranking — the ONE place a version order is computed
// -------------------------------------------------------------------------------------------

/** Why a head could not be picked even though an index answered. Each is a distinct operator
 *  action, which is the whole reason they are not one value. */
export type LineHeadUndeterminedReason =
  /** The LINE's own `major` text does not parse (`dependency_lines.major` is free text). Nothing can
   *  be tested for membership of a line whose identity cannot be read. */
  | "line_major_unparseable"
  /** The index answered `available` with an EMPTY list: this package EXISTS and has published
   *  nothing. Deliberately not merged with `no_versions_on_line` — "the package has no releases at
   *  all" and "its releases are all on other majors" are two different facts about the world and two
   *  different operator actions (chase the publisher, versus fix the line's `major`). */
  | "no_published_versions"
  /** The index answered with versions, but none of them is on this line (right package, wrong
   *  major, or — for images — the wrong variant suffix). */
  | "no_versions_on_line"
  /** The index answered, but nothing it returned parses as a version at all. */
  | "no_parseable_version";

export interface LineHeadSelection {
  /** The head of the line, or `undefined` — and `undefined` means NOTHING IS RECORDED. */
  head?: { version: string; parsed: ComparableVersion };
  reason?: LineHeadUndeterminedReason;
  /** How many versions the index offered. */
  considered: number;
  /** Offered but UNPARSEABLE — `latest`, `stable`, a branch name, a malformed tag. Counted so a
   *  Decision can say "we looked at 40 tags and understood 12" instead of silently discarding 28. */
  skipped: number;
  /** Parseable but not on this line (a different major, or a different image variant). */
  offLine: number;
}

/**
 * THE HEAD OF A LINE — the single ranking function.
 *
 * Pure and total: no I/O, no throw, and every rejected candidate is accounted for in the returned
 * counts. Extracted as a pure function per BUILD_AND_TEST.md §4.1 so the never-guess properties are
 * pinned without a database, a network, or a plugin host.
 *
 * A caller MUST treat `head === undefined` as "record nothing". There is deliberately no
 * "best-effort" branch and no `?? versions[0]`: the moment such a fallback exists, the failure mode
 * is a plausible-looking wrong answer instead of a visible absence.
 */
export function selectLineHead(
  line: LineHeadIdentity,
  versions: readonly DependencyIndexVersion[]
): LineHeadSelection {
  const considered = versions.length;
  if (considered === 0) {
    // AN EMPTY `available` LIST IS ITS OWN FACT. The index answered, the package exists, and it has
    // published nothing — which is not "its releases are all on other majors" and calls for a
    // different operator action.
    return { reason: "no_published_versions", considered, skipped: 0, offLine: 0 };
  }

  let skipped = 0;
  let offLine = 0;
  let majorUnreadable = false;
  let best: { version: string; parsed: ComparableVersion } | undefined;

  for (const candidate of versions) {
    // MEMBERSHIP IS `lineAcceptsVersion`, THE SHARED HELPER — the same one internal detection uses,
    // so the two writers cannot disagree about which release belongs to which line. It carries the
    // ecosystem's own parse door (an image tag is not semver), the line's variant (`tag_pattern` is
    // the literal suffix and nothing else reads it), and the major test at the line's own precision.
    const acceptance = lineAcceptsVersion(line, candidate.version);
    if (acceptance.accepted) {
      if (best === undefined) {
        best = { version: candidate.version, parsed: acceptance.parsed };
        continue;
      }
      const order = compareVersions(acceptance.parsed, best.parsed);
      // `undefined` is unreachable here — every survivor shares the line's suffix, which is the only
      // condition under which `compareVersions` declines. It is still handled rather than asserted
      // away: if the variant rule is ever loosened, this must SKIP the incomparable pair, not fall
      // through to an arbitrary winner.
      if (order === 1) best = { version: candidate.version, parsed: acceptance.parsed };
      continue;
    }
    if (acceptance.reason === "major_line_not_comparable") {
      // The LINE is unreadable, not this candidate — no candidate can be tested, so stop counting.
      majorUnreadable = true;
      break;
    }
    if (acceptance.reason === "version_not_comparable") skipped += 1;
    else offLine += 1;
  }

  if (majorUnreadable) {
    return { reason: "line_major_unparseable", considered, skipped: 0, offLine: 0 };
  }
  if (best === undefined) {
    return {
      reason: skipped === considered ? "no_parseable_version" : "no_versions_on_line",
      considered,
      skipped,
      offLine
    };
  }
  return { head: best, considered, skipped, offLine };
}

// -------------------------------------------------------------------------------------------
// Asking an index — plugin first, operator-loaded feed second, unavailable last
// -------------------------------------------------------------------------------------------

/** Where an answer came from, carried into the Decision so "why does this line say that?" is
 *  answerable from the record alone (charter principle 6). */
export type LineHeadSource = `index:${string}` | "operator-feed" | "none";

export type LineHeadOutcome =
  | {
      status: "observed";
      source: LineHeadSource;
      /** The version AND the digest that belongs to it, always both — `digest: null` means "this
       *  version's bytes were not resolved" (a language ecosystem has none, the air-gap feed carries
       *  none, an inspect can fail). It is NOT optional, because an ABSENT digest is what let a
       *  previous version's digest survive beside a new tag: the pair moves together (ADR-0032 §7,
       *  `line-head.ts`). */
      head: { version: string; digest: string | null };
      selection: LineHeadSelection;
    }
  | {
      status: "undetermined";
      source: LineHeadSource;
      reason: LineHeadUndeterminedReason;
      selection: LineHeadSelection;
    }
  | {
      status: "unavailable";
      source: LineHeadSource;
      reason: DependencyIndexUnavailableReason | "feed_stale" | "feed_missing_coordinate";
      detail: string;
    };

export interface QueryLineHeadDeps {
  host: PluginHost;
  orgId: string;
  env?: NodeJS.ProcessEnv;
  /** Pre-read once per tick by the caller — reading and staleness-classifying the operator feed per
   *  line would re-stat the same file for every dependency in the estate. */
  feed?: FeedRead;
  /**
   * Called with the id of an index instance this call STARTED (or re-used), immediately after
   * `host.start()` returns, so the caller can stop it when its sweep is over (M21.4 lifecycle).
   *
   * REPORTED, NEVER INFERRED. The caller could compute the same ids by re-running
   * `resolveIndexInstanceConfig` over the ecosystems in its work-list — and that is precisely the
   * shape that goes wrong later: it would be a SECOND derivation of "which instances are running",
   * true only while the two agree. This one is a receipt from the code that actually started them,
   * so an instance the sweep starts can never be one the sweep forgets to stop.
   */
  onIndexInstanceStarted?: (instanceId: string) => void;
}

function unavailableOutcome(
  source: LineHeadSource,
  reason: DependencyIndexUnavailableReason | "feed_stale" | "feed_missing_coordinate",
  detail: string
): LineHeadOutcome {
  return { status: "unavailable", source, reason, detail };
}

/**
 * Resolve ONE line's head.
 *
 * Order of resort, and why it is this order:
 *  1. THE INDEX PLUGIN, when this deployment configures one for the ecosystem. Live, authoritative.
 *  2. THE OPERATOR-LOADED SIGNED FEED, when it does not — the air-gap path (see
 *     `version-index-feed.ts`, which copies the Trivy-DB shape verbatim). A HARD-STALE feed is
 *     refused rather than used, fail-closed, exactly as a hard-stale scanner DB is.
 *  3. UNAVAILABLE. Never "no new version".
 *
 * A feed is not consulted when a live index answered — including when it answered `unknown_coordinate`
 * or `unauthorized`. A live index's "I do not have this package" is a real answer about the world,
 * and letting a months-old operator snapshot override it is how a subscription gets bumped onto a
 * version that was withdrawn.
 *
 * IT TAKES A {@link ThirdPartyLine}, AND THAT IS THE INGRESS SPLIT, NOT A TYPE FLOURISH (ADR-0032
 * §7). An INTERNAL line's head is DERIVED from the org's own production releases; polling one
 * against a public index lets a stranger's package that shares the coordinate overwrite the org's
 * own `2.1.0` with `9.9.9`, and every subscriber is then bumped onto it — dependency confusion,
 * arriving on a daily timer. The brand means a caller cannot pass an internal line by forgetting a
 * filter: the only constructor is `asThirdPartyLine`, which reads `produced_by_object_id`.
 */
export async function queryLineHead(
  line: ThirdPartyLine,
  deps: QueryLineHeadDeps
): Promise<LineHeadOutcome> {
  const env = deps.env ?? process.env;
  const ecosystem = line.ecosystem;
  const instance = resolveIndexInstanceConfig(ecosystem, deps.orgId, env);

  if (instance === null) return fromFeed(line, deps);

  const source: LineHeadSource = `index:${instance.module}`;
  let result: DependencyIndexResult;
  try {
    await deps.host.start([instance]);
    deps.onIndexInstanceStarted?.(instance.id);
    result = await deps.host.dependencyIndex(instance.id).listVersions({
      ecosystem,
      coordinate: line.coordinate,
      majorLine: line.major,
      ...(line.tagPattern !== null ? { tagPattern: line.tagPattern } : {})
    });
  } catch (err) {
    // A plugin-host RPC failure (a crashed/hung subprocess, an exhausted retry budget) is NOT a
    // statement about versions. It is reported as unavailable, and — this is the part that matters —
    // it is CAUGHT, because an unhandled rejection here would abort the whole sweep and every other
    // line in the estate would go unpolled behind one bad index.
    return unavailableOutcome(
      source,
      "unreachable",
      `the ${ecosystem} index plugin failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (result.status === "unavailable") {
    return unavailableOutcome(source, result.reason, result.detail);
  }

  const selection = selectLineHead(line, result.versions);
  if (!selection.head) {
    return {
      status: "undetermined",
      source,
      reason: selection.reason ?? "no_versions_on_line",
      selection
    };
  }

  // A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7): for images the digest is what the version claim
  // actually means, so it is resolved for the head and only the head — one extra call per line, not
  // one per tag.
  //
  // AN UNRESOLVED DIGEST IS `null`, NEVER ABSENT. A digest that cannot be resolved does not void the
  // observation — the tag is still the head, and the air-gap feed carries no digests at all, so
  // requiring one would make an air-gapped estate unable to record an image head ever. But it must
  // travel as an explicit `null`: while this field was optional, an unresolved digest left the
  // PREVIOUS version's digest standing beside the NEW tag, and the row asserted a (tag, digest) pair
  // that never existed in any registry. The pair moves together — `recordDependencyLineHead` writes
  // both from this one observation.
  let digest: string | null = null;
  if (ecosystem === "oci") {
    try {
      const resolved = await deps.host.dependencyIndex(instance.id).resolveDigest({
        ecosystem,
        coordinate: line.coordinate,
        version: selection.head.version
      });
      if (resolved.status === "available") digest = resolved.digest;
    } catch {
      // Same reasoning as the listVersions catch: one line's digest lookup must never end the sweep.
    }
  }

  return {
    status: "observed",
    source,
    head: { version: selection.head.version, digest },
    selection
  };
}

/** The air-gap resort. Kept separate so the "no index configured" path is readable end to end. */
function fromFeed(line: ThirdPartyLine, deps: QueryLineHeadDeps): LineHeadOutcome {
  const env = deps.env ?? process.env;
  const envVar = INDEX_URL_ENV_BY_ECOSYSTEM[line.ecosystem];
  const notConfiguredDetail =
    line.ecosystem === "oci"
      ? "no OCI index is available: SCP_ARTIFACT_OCI_REGISTRY_HOSTS is empty, or no pinned skopeo " +
        "could be resolved. Images need no external feed — the org's OWN registry is the index — so " +
        "the fix is to allowlist that registry, not to load a feed"
      : `no ${line.ecosystem} index is configured on this deployment (set ${envVar}) and no ` +
        `operator-loaded version feed covers it. This is the air-gap default and it is NOT ` +
        `"no new version": nothing was asked, so nothing is known`;

  const feed = deps.feed ?? readDependencyIndexFeed(env);
  if (feed.status === "absent") {
    return unavailableOutcome("none", "not_configured", notConfiguredDetail);
  }
  if (feed.status === "unreadable") {
    return unavailableOutcome("operator-feed", "malformed_response", feed.detail);
  }
  if (feed.staleness === "hard") {
    // FAIL-CLOSED, the Trivy-DB rule: a feed past the operator's hard bound is refused rather than
    // used. A stale answer here does not merely miss a bump — it asserts a head that has since
    // moved, which is the wrong-version failure this whole module is arranged to avoid.
    return unavailableOutcome(
      "operator-feed",
      "feed_stale",
      `the operator-loaded version feed was generated ${feed.ageHours.toFixed(1)}h ago, past the ` +
        `hard bound of ${feed.hardMaxAgeHours}h — refused (fail-closed). Load a fresher signed feed`
    );
  }

  const versions = lookupFeedVersions(feed.document, line.ecosystem, line.coordinate);
  if (versions === null) {
    return unavailableOutcome(
      "operator-feed",
      "feed_missing_coordinate",
      `the operator-loaded version feed does not carry ${line.ecosystem} '${line.coordinate}' — ` +
        `it is not "up to date", it is unlisted`
    );
  }
  const selection = selectLineHead(
    line,
    versions.map((version) => ({ version }))
  );
  if (!selection.head) {
    return {
      status: "undetermined",
      source: "operator-feed",
      reason: selection.reason ?? "no_versions_on_line",
      selection
    };
  }
  return {
    status: "observed",
    source: "operator-feed",
    // An operator-loaded feed carries versions and NO digests (`version-index-feed.ts`), so the
    // digest is explicitly `null` — "this version's bytes were not resolved", never a previously
    // stored digest inherited across a version change.
    head: { version: selection.head.version, digest: null },
    selection
  };
}

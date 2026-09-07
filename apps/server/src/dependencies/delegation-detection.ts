import type { ReadFileAtRefResult } from "@scp/git-provider-core";
import type { TenantTx } from "../db/tenant-tx.js";
import type { Decision } from "@scp/schemas";
import {
  insertDecisionIfChanged,
  latestDecisionForSubjectKind
} from "../coordination/decisions-repo.js";
import type { ManifestReader } from "./internal-release-version.js";

/** Does this repository already delegate its updates. See docs/dependencies.md §153. */

/** The verdict `kind` these probes are recorded under. Read by the choke-point guard and by the
 *  actuator seam; both use `latestDecisionForSubjectKind`, so this string is the join. */
export const DEPENDENCY_DELEGATION_DECISION_KIND = "dependency_delegation";

/** Every path a delegating configuration is known to live at. See docs/dependencies.md §154. */
export const DELEGATION_CONFIG_PATHS = [
  "renovate.json",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.json5",
  ".github/dependabot.yml",
  ".github/dependabot.yaml"
] as const;

export type DelegationTool = "renovate" | "dependabot";

export interface DelegationConfig {
  tool: DelegationTool;
  /** The repo-relative path the config was read from — what the refusal message names. */
  configPath: string;
  /** False only when the config explicitly turns the tool off for the whole repository. */
  active: boolean;
  /** True when the config manages everything it can find; the common Renovate case, and the
   *  fail-closed answer for anything this parser cannot narrow. */
  coversEverything: boolean;
  /** Directory prefixes the config restricts itself to (`/`, `/services/api`). Empty means
   *  unrestricted. Only consulted when `coversEverything` is false. */
  directories: string[];
  /** Ecosystems the config manages, in SCP's own vocabulary. Empty means unrestricted. */
  ecosystems: string[];
  /** Why the parse landed where it did — carried into the Decision so a refusal is explainable
   *  without re-reading the repository. */
  note: string;
}

/** The provider's ecosystem values mapped into our five. See docs/dependencies.md §155. */
const DEPENDABOT_ECOSYSTEM_TO_SCP: Record<string, string> = {
  npm: "npm",
  gomod: "go",
  docker: "oci",
  pip: "python",
  uv: "python",
  maven: "maven",
  gradle: "maven"
};

/** Ecosystems SCP itself authors bumps for (ADR-0032 §10). A delegation restricted to anything
 *  outside this set cannot collide with a bump SCP would write. */
const SCP_AUTHORED_ECOSYSTEMS = new Set(["go", "oci", "npm", "python", "maven"]);

/** Reads a delegating configuration, or returns nothing. See docs/dependencies.md §156. */
export function parseDelegationConfig(
  configPath: string,
  content: string
): DelegationConfig | undefined {
  const isDependabot =
    configPath.endsWith("dependabot.yml") || configPath.endsWith("dependabot.yaml");
  return isDependabot
    ? parseDependabotConfig(configPath, content)
    : parseRenovateConfig(configPath, content);
}

function parseRenovateConfig(configPath: string, content: string): DelegationConfig {
  const base: DelegationConfig = {
    tool: "renovate",
    configPath,
    active: true,
    coversEverything: true,
    directories: [],
    ecosystems: [],
    note: "renovate manages every manifest it detects unless the config narrows it"
  };
  let doc: Record<string, unknown>;
  try {
    // JSON5 files are read as JSON. A JSON5-only construct fails the parse and lands in the
    // fail-closed branch below, which is the correct place for it: a config this code cannot read is
    // a config whose scope it cannot narrow.
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...base, note: "renovate config is not a JSON object; assumed to cover everything" };
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ...base, note: "renovate config did not parse as JSON; assumed to cover everything" };
  }

  if (doc.enabled === false) {
    return {
      ...base,
      active: false,
      coversEverything: false,
      note: "renovate config sets `enabled: false` for the whole repository"
    };
  }

  // `includePaths` is the ONE narrowing this parser honours, because it is the one Renovate
  // documents as an absolute restriction on which files are even considered. `ignorePaths`,
  // `packageRules` and presets can each narrow further, and none of them is read here — which is
  // why an `includePaths` config is still reported as covering those paths ENTIRELY.
  const includePaths = Array.isArray(doc.includePaths)
    ? doc.includePaths.filter((p): p is string => typeof p === "string")
    : [];
  if (includePaths.length > 0) {
    return {
      ...base,
      coversEverything: false,
      directories: includePaths,
      note: `renovate config restricts itself to includePaths ${JSON.stringify(includePaths)}`
    };
  }
  return base;
}

/** Dependabot's `updates:` list, read WITHOUT a YAML parser. See docs/dependencies.md §157. */
export function parseDependabotConfig(configPath: string, content: string): DelegationConfig {
  const base: DelegationConfig = {
    tool: "dependabot",
    configPath,
    active: true,
    coversEverything: false,
    directories: [],
    ecosystems: [],
    note: ""
  };
  const ecosystems = new Set<string>();
  const directories = new Set<string>();
  /** Ecosystem names this reader could not map into SCP's five, kept VERBATIM. They are recorded
   *  rather than counted because an `ecosystems` list that is non-empty but disjoint from SCP's is
   *  what makes `delegationCoversManifest` answer "does not cover" — an EMPTY list there means
   *  "unrestricted", which is the opposite claim. */
  const unmappedEcosystems = new Set<string>();
  let sawAnyEntry = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const eco = /^-?\s*package-ecosystem:\s*["']?([A-Za-z0-9_-]+)["']?/.exec(line);
    if (eco?.[1]) {
      sawAnyEntry = true;
      const raw = eco[1].toLowerCase();
      const mapped = DEPENDABOT_ECOSYSTEM_TO_SCP[raw];
      if (mapped) ecosystems.add(mapped);
      else if (SCP_AUTHORED_ECOSYSTEMS.has(raw)) ecosystems.add(raw);
      else unmappedEcosystems.add(raw);
      continue;
    }
    const dir = /^-?\s*directory:\s*["']?([^"'#]+)["']?/.exec(line);
    if (dir?.[1]) {
      directories.add(dir[1].trim());
      continue;
    }
    // `directories:` (the plural, multi-directory form) is a LIST, so its members are on following
    // lines and are not read here. Seeing the key at all widens the config, because the directories
    // it would have named are unknown.
    if (/^directories:\s*$/.test(line) || /^-?\s*directories:\s*\[/.test(line)) {
      return {
        ...base,
        coversEverything: true,
        note: "dependabot config uses the multi-directory `directories:` form, which this reader does not enumerate"
      };
    }
  }

  if (!sawAnyEntry) {
    return {
      ...base,
      active: false,
      note: "dependabot config declares no `package-ecosystem` updates"
    };
  }
  if (unmappedEcosystems.size > 0 && ecosystems.size === 0) {
    // Every entry naming an ecosystem we do not author for. See docs/dependencies.md §158.
    return {
      ...base,
      ecosystems: [...unmappedEcosystems].sort(),
      note: `dependabot config manages only ${[...unmappedEcosystems].sort().join(", ")}, which CommanderSCP does not author bumps for`
    };
  }
  if (unmappedEcosystems.size > 0) {
    // A MIXTURE: at least one ecosystem SCP authors, plus at least one this reader has not learned.
    // Widened, because narrowing to the mapped subset would be a claim about the unmapped entry that
    // this parser has no basis for.
    return {
      ...base,
      coversEverything: true,
      note: `dependabot config names ${[...unmappedEcosystems].sort().join(", ")}, which this reader does not recognise; assumed to cover everything`
    };
  }
  return {
    ...base,
    ecosystems: [...ecosystems].sort(),
    directories: [...directories].sort(),
    note: `dependabot config manages ${[...ecosystems].sort().join(", ")} under ${[...directories].sort().join(", ") || "/"}`
  };
}

/** Does `config` claim the manifest at `manifestPath`. See docs/dependencies.md §159. */
export function delegationCoversManifest(
  config: DelegationConfig,
  manifestPath: string,
  ecosystem: string
): boolean {
  if (!config.active) return false;
  if (config.coversEverything) return true;
  if (config.ecosystems.length > 0 && !config.ecosystems.includes(ecosystem)) return false;
  if (config.directories.length === 0) return true;
  return config.directories.some((dir) => pathIsUnder(manifestPath, dir));
}

function pathIsUnder(manifestPath: string, directory: string): boolean {
  const norm = (p: string) => p.replace(/^\/+|\/+$/g, "");
  const dir = norm(directory);
  if (dir === "" || dir === "**") return true;
  const path = norm(manifestPath);
  // Renovate `includePaths` entries are globs as often as directories. A `**` suffix is stripped and
  // the prefix compared, which is the widening reading — `services/**` claims everything below it.
  const base = dir.replace(/\/?\*\*?$/, "");
  if (base === "") return true;
  return path === base || path.startsWith(`${base}/`);
}

export interface DelegationProbeSubject {
  /** The component whose enablement this verdict is about — the Decision's `subject_id`. */
  componentObjectId: string;
  /** The repository the component's manifests live in, as `changes.source_ref.repo` spells it. */
  repo: string;
  ref: string;
  /** The manifests this component is known to declare, from `component_dependencies`. Each carries
   *  its ecosystem so a narrowly-scoped delegation can be shown NOT to collide. */
  manifests: { manifestPath: string; ecosystem: string }[];
}

export interface DelegationProbeResult {
  /** True when at least one config was found that covers at least one of the component's manifests. */
  delegated: boolean;
  /** True only when every candidate path was answered. See docs/dependencies.md §160. */
  conclusive: boolean;
  configs: DelegationConfig[];
  /** For each colliding config, which of the component's manifests it claims. */
  collisions: { configPath: string; tool: DelegationTool; manifestPaths: string[] }[];
  /** Config paths whose read failed, with the reason. A probe that could not read is NOT a probe
   *  that found nothing, and the difference is carried rather than flattened. */
  unreadable: { configPath: string; detail: string }[];
}

/** Could not check must never resolve to go ahead. See docs/dependencies.md §161. */
export function delegationProbeIsInconclusive(result: DelegationProbeResult): boolean {
  return !result.delegated && !result.conclusive;
}

/** The sentence an inconclusive probe is reported with, in one place because two callers emit it. */
export function delegationProbeFailureDetail(result: DelegationProbeResult): string {
  return result.unreadable.map((u) => `${u.configPath} (${u.detail})`).join("; ");
}

/** Reads every candidate config and decides whether any. See docs/dependencies.md §162. */
export async function probeDependencyUpdateDelegation(
  reader: ManifestReader,
  subject: DelegationProbeSubject
): Promise<DelegationProbeResult> {
  const configs: DelegationConfig[] = [];
  const unreadable: { configPath: string; detail: string }[] = [];

  for (const configPath of DELEGATION_CONFIG_PATHS) {
    let result: ReadFileAtRefResult;
    try {
      result = await reader({ repo: subject.repo, path: configPath, ref: subject.ref });
    } catch (err) {
      // The reader throws for "no binding names this repo", auth failure, egress refusal and 5xx —
      // all of which mean the file was not read, which is NOT the same as the file not being there.
      unreadable.push({
        configPath,
        detail: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    if (result.outcome === "not_found") continue;
    if (result.outcome === "refused") {
      unreadable.push({ configPath, detail: `${result.reason}: ${result.detail}` });
      continue;
    }
    const parsed = parseDelegationConfig(configPath, result.content);
    if (parsed) configs.push(parsed);
  }

  const collisions: DelegationProbeResult["collisions"] = [];
  for (const config of configs) {
    const claimed = subject.manifests
      .filter((m) => delegationCoversManifest(config, m.manifestPath, m.ecosystem))
      .map((m) => m.manifestPath);
    if (claimed.length > 0) {
      collisions.push({ configPath: config.configPath, tool: config.tool, manifestPaths: claimed });
    }
  }

  return {
    delegated: collisions.length > 0,
    // EVERY candidate path answered, or this probe does not get to say "no delegation here" — see
    // {@link delegationProbeIsInconclusive}. Derived here rather than left to each caller, because a
    // rule applied per caller has one place per caller to regress.
    conclusive: unreadable.length === 0,
    configs,
    collisions,
    unreadable
  };
}

/** Persist the probe's verdict against the component. See docs/dependencies.md §163. */
export async function recordDelegationProbe(
  tx: TenantTx,
  orgId: string,
  subject: DelegationProbeSubject,
  result: DelegationProbeResult
): Promise<Decision> {
  if (delegationProbeIsInconclusive(result)) {
    throw new Error(
      `dependency-delegation probe for '${subject.repo}@${subject.ref}' could not read ` +
        `${result.unreadable.length} of the ${DELEGATION_CONFIG_PATHS.length} candidate config ` +
        `paths, so it cannot state that this repository delegates nothing: ` +
        `${delegationProbeFailureDetail(result)}. No verdict is recorded — "we could not check ` +
        `whether another dependency-update system owns these manifests" never resolves to "go ` +
        `ahead and write to them"`
    );
  }
  const recorded = await insertDecisionIfChanged(tx, {
    orgId,
    kind: DEPENDENCY_DELEGATION_DECISION_KIND,
    subjectId: subject.componentObjectId,
    verdict: result.delegated ? "block" : "allow",
    inputContext: {
      repo: subject.repo,
      ref: subject.ref,
      configsFound: result.configs.map((c) => ({
        configPath: c.configPath,
        tool: c.tool,
        active: c.active,
        coversEverything: c.coversEverything,
        directories: c.directories,
        ecosystems: c.ecosystems,
        note: c.note
      })),
      collisions: result.collisions,
      unreadable: result.unreadable
    },
    reasonTree: {
      summary: result.delegated
        ? `dependency updates for this component are already delegated to ${result.collisions
            .map((c) => `${c.tool} (${c.configPath})`)
            .join(", ")}`
        : "no dependency-update system was found delegating this component's manifests"
    }
  });
  return recorded.decision;
}

/** What the choke-point guard and the actuator both read: the standing verdict, or `undefined` when
 *  nothing has been probed. `undefined` means NOT OBSERVED, never "unknown, refuse" — see the module
 *  doc's "WHAT ABSENT MEANS". */
export async function readStandingDelegationVerdict(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<
  | {
      decisionId: string;
      delegated: boolean;
      collisions: { configPath: string; tool: DelegationTool; manifestPaths: string[] }[];
    }
  | undefined
> {
  const decision = await latestDecisionForSubjectKind(
    tx,
    orgId,
    componentObjectId,
    DEPENDENCY_DELEGATION_DECISION_KIND
  );
  if (!decision) return undefined;
  const ctx = (decision.inputContext ?? {}) as {
    collisions?: { configPath: string; tool: DelegationTool; manifestPaths: string[] }[];
  };
  return {
    decisionId: decision.id,
    delegated: decision.verdict === "block",
    collisions: Array.isArray(ctx.collisions) ? ctx.collisions : []
  };
}

/** The refusal sentence, in one place, because it is emitted from two (the authoring choke point and
 *  the actuator seam) and an operator who meets it twice must not read two different explanations. */
export function delegationRefusalMessage(
  collisions: { configPath: string; tool: DelegationTool; manifestPaths: string[] }[]
): string {
  const named = collisions
    .map(
      (c) =>
        `\`${c.configPath}\` (${c.tool}), which covers ${c.manifestPaths.map((m) => `\`${m}\``).join(", ")}`
    )
    .join("; ");
  return (
    "This component's repository already delegates dependency updates to another system: " +
    `${named}. Enabling dependency subscriptions declares CommanderSCP the execution system for this ` +
    "class of change, and two systems editing the same manifest is the failure that invites. Remove " +
    "or narrow the other system's configuration so it no longer covers these manifests, or leave " +
    "dependency subscriptions off for this component."
  );
}

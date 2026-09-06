import type { ReadFileAtRefResult } from "@scp/git-provider-core";
import type { TenantTx } from "../db/tenant-tx.js";
import type { Decision } from "@scp/schemas";
import {
  insertDecisionIfChanged,
  latestDecisionForSubjectKind
} from "../coordination/decisions-repo.js";
import type { ManifestReader } from "./internal-release-version.js";

/**
 * M21.5 — DOES THIS REPOSITORY ALREADY DELEGATE ITS DEPENDENCY UPDATES TO SOMEBODY ELSE?
 * (charter `scp-managed-dep` amendment 2026-08-13; ADR-0032 §8.)
 *
 * ============================================================================================
 * THIS IS LOAD-BEARING, NOT A NICETY, AND ADR-0032 §8 SAYS WHY IN ONE LINE
 * ============================================================================================
 * ADR-0002 §3's gate 1 asks whether an execution system for this class of change already exists. For
 * dependency bumps the honest answer is that **gate 1 FAILS wherever Renovate or Dependabot exists**
 * — that IS the execution system for this class — so the router's default verdict is COORDINATE and
 * the owner's Mode C selection was made with that analysis in hand. What keeps gate 1 coherent is
 * that **opting a component in is itself the gate-1 flip**: enabling dependency subscriptions
 * declares CommanderSCP the execution system for this class in that domain.
 *
 * A flip can only mean something if it is exclusive. If a component enables subscriptions while its
 * repository still delegates the same manifests to Renovate, then *two actuators edit one file* —
 * which is not a merge conflict to be resolved but a pair of systems each believing it owns the
 * declared version, racing on every release of every line. So the refusal below is not defensive
 * hygiene; it is the condition that makes the gate-1 flip a true statement.
 *
 * ============================================================================================
 * WHY A STORED PROBE RATHER THAN A READ AT THE MOMENT OF AUTHORING
 * ============================================================================================
 * The refusal belongs at the choke point M21.3's sibling guard already uses — `graph/objects-repo.ts`'s
 * `createObject`/`updateObject` — for exactly the reasons that guard's header sets out: the typed
 * `/policies` route is NOT the boundary, and three free-form-`typeId` doors reach `createObject`
 * with the same document. But answering "does this repository delegate?" requires READING FILES OUT
 * OF A REPOSITORY, and `createObject` runs inside a tenant transaction that already holds two per-org
 * advisory locks to commit. Doing provider I/O there would hold those locks across a network call.
 *
 * So the question is answered ASYNCHRONOUSLY, where the repository is already being read — the same
 * `readFileAtRef` route M21.4 built for the inventory — and the ANSWER is persisted as a `Decision`.
 * The choke-point guard then performs one indexed read (`decisions_org_subject_kind_created`, the
 * exact shape `latestDecisionForSubjectKind` was indexed for) inside the transaction and refuses on
 * a `block`.
 *
 * A Decision is the right home for this and not a convenient one: it is the platform's own
 * explainability substrate (charter principle 6 — "every engine verdict persists a Decision record
 * with its inputs; every blocked response carries a `decision_id`"), it is org-scoped and RLS-covered
 * like everything else, `insertDecisionIfChanged` already solves the daily-re-probe write
 * amplification that cost 1.44 GB/day elsewhere, and the refusal the operator reads can hand back the
 * very `decision_id` that explains itself. A bespoke table would have been a fifth place to migrate
 * and a second place to explain from.
 *
 * ============================================================================================
 * WHAT ABSENT MEANS, STATED RATHER THAN LEFT TO INFERENCE
 * ============================================================================================
 * No probe on record means NO DELEGATION HAS BEEN OBSERVED — not "delegation is unknown, refuse".
 * That is the charter's own reading: it refuses to enable "for a component whose repository ALREADY
 * delegates the same manifests", which is a refusal predicated on an observed fact. Requiring a
 * positive clean probe first would make enablement depend on an ingestion having run, and an operator
 * would meet a refusal that named nothing.
 *
 * The cost of that reading is real and is covered rather than accepted: a policy authored BEFORE the
 * probe would stand. The actuator seam (`bump-actuator.ts`) re-checks the same stored verdict before
 * every single authored bump, so a delegation discovered later stops the writes even though it did
 * not stop the policy. Two halves, one stored fact, neither of them fail-open.
 *
 * ============================================================================================
 * WHEN IN DOUBT, IT COVERS
 * ============================================================================================
 * Every ambiguity in {@link delegationCoversManifest} resolves towards "yes, it covers" — an
 * unparseable `renovate.json`, a `dependabot.yml` naming an ecosystem this code does not map, a
 * config shape newer than this parser. Guessing "no" would let two actuators loose on one file, which
 * is the failure this whole module exists to prevent; guessing "yes" costs a legible refusal that
 * names the file and can be resolved by deleting it. The asymmetry is not close.
 */

/** The verdict `kind` these probes are recorded under. Read by the choke-point guard and by the
 *  actuator seam; both use `latestDecisionForSubjectKind`, so this string is the join. */
export const DEPENDENCY_DELEGATION_DECISION_KIND = "dependency_delegation";

/**
 * Every path a delegating configuration is known to live at.
 *
 * Renovate's own documented discovery order plus Dependabot's single location. `.renovaterc` (no
 * extension) is JSON despite the name — that is Renovate's convention, not an assumption made here.
 * A `renovate` key inside `package.json` is deliberately NOT probed: it would require reading and
 * parsing every component manifest for a config that Renovate itself deprecated, and the residual is
 * recorded in {@link probeDependencyUpdateDelegation} rather than hidden.
 */
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

/**
 * Dependabot's `package-ecosystem` values mapped into ADR-0032's five. Only the five matter: a
 * `cargo`/`bundler`/`nuget` entry is real delegation but of a class SCP does not author, so it
 * cannot collide and is not a reason to refuse.
 *
 * An UNRECOGNISED value is NOT dropped — see {@link parseDependabotConfig}, where it widens the
 * config to `coversEverything`. A value this map has not learned yet is exactly the case where
 * guessing "does not collide" is the dangerous guess.
 */
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

/**
 * Read a delegating configuration, or return `undefined` when this file is not one.
 *
 * PARSING IS DELIBERATELY SHALLOW. Renovate's config language is large (presets, `packageRules`,
 * regex managers, inherited org config) and Dependabot's is small; reimplementing either faithfully
 * would be a second, drifting copy of somebody else's product. What this needs to decide is one
 * boolean — could this config edit the same manifest SCP is about to edit? — and every shortcut
 * below widens rather than narrows the answer.
 */
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

/**
 * Dependabot's `updates:` list, read WITHOUT a YAML parser.
 *
 * The server has no YAML dependency and adding one to answer a boolean would be a new required
 * dependency for a probe. What is needed is the set of `package-ecosystem` and `directory` values,
 * both of which are scalar keys on list items — a line scan finds them, and anything the line scan
 * cannot make sense of widens the result to `coversEverything` rather than narrowing it.
 *
 * The honest bound, stated rather than discovered: a `dependabot.yml` using YAML anchors, flow
 * mappings, or multi-line strings for these keys is not narrowed by this reader — it is reported as
 * covering everything, which refuses more than strictly necessary and never less.
 */
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
    // EVERY entry named an ecosystem SCP does not author bumps for (bundler, cargo, nuget, …), so no
    // collision with a bump SCP would write is possible. The unmapped names are carried through as
    // the config's `ecosystems` — a NON-EMPTY list disjoint from SCP's, which is what makes
    // `delegationCoversManifest` answer "does not cover". Leaving the list empty here would have
    // meant "unrestricted" and refused every enablement in the org, which is the opposite claim and
    // is the defect `delegation-detection.test.ts`'s bundler case caught.
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

/**
 * Does `config` claim the manifest at `manifestPath` (declaring a dependency of `ecosystem`)?
 *
 * Directory matching is by PREFIX on path segments, which is how both tools scope themselves: a
 * `directory: /services/api` claims `services/api/package.json` and does not claim
 * `services/api-v2/package.json`. `/` claims everything under it — for Dependabot that is the
 * documented meaning of the repository root, and it is also the shape a bare `directory: "/"` takes.
 */
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
  /**
   * True only when EVERY candidate path in {@link DELEGATION_CONFIG_PATHS} was answered — found or
   * genuinely absent. False the moment one of them could not be read.
   *
   * It is a separate field from `delegated` because the two answer different questions and the
   * difference is the whole refusal: `delegated: false` means "no delegating config was found",
   * which is a claim about the repository, and it may only be made when the repository was actually
   * readable. See {@link delegationProbeIsInconclusive}.
   */
  conclusive: boolean;
  configs: DelegationConfig[];
  /** For each colliding config, which of the component's manifests it claims. */
  collisions: { configPath: string; tool: DelegationTool; manifestPaths: string[] }[];
  /** Config paths whose read failed, with the reason. A probe that could not read is NOT a probe
   *  that found nothing, and the difference is carried rather than flattened. */
  unreadable: { configPath: string; detail: string }[];
}

/**
 * ============================================================================================
 * "WE COULD NOT CHECK" MUST NEVER RESOLVE TO "GO AHEAD AND WRITE TO IT"
 * ============================================================================================
 * A probe that read nothing looks EXACTLY like a probe that found nothing — same `configs: []`, same
 * `collisions: []`, same `delegated: false` — and that is how a bad credential, a provider 5xx or an
 * egress refusal turned into an `allow` verdict and an authored commit. This is the one refusal
 * standing between CommanderSCP and two actuators editing one file, and the cost of the two mistakes
 * is not symmetric: a refused bump is a component that keeps declaring an older version and says so;
 * a wrong one is a commit in somebody else's repository, racing Renovate on every release.
 *
 * So an inconclusive probe is not a verdict at all. It is recorded as NOTHING —
 * {@link recordDelegationProbe} refuses to persist it rather than writing a weaker `allow`, because
 * a stored `allow` would then be read as a standing fact by both readers long after the outage that
 * produced it. The dispatcher skips the candidate with a named cause and re-derives on the next
 * advance.
 *
 * A probe that DID find a collision is conclusive enough to refuse whatever else failed to read:
 * more unread config could only add collisions, never remove the one already found. That is why the
 * test is `!delegated && !conclusive` rather than `!conclusive`.
 */
export function delegationProbeIsInconclusive(result: DelegationProbeResult): boolean {
  return !result.delegated && !result.conclusive;
}

/** The sentence an inconclusive probe is reported with, in one place because two callers emit it. */
export function delegationProbeFailureDetail(result: DelegationProbeResult): string {
  return result.unreadable.map((u) => `${u.configPath} (${u.detail})`).join("; ");
}

/**
 * Read every candidate config out of the component's repository and decide whether any of them
 * claims a manifest this component declares.
 *
 * `reader` is M21.4's `ManifestReader` — the SAME server-side route to `readFileAtRef` the inventory
 * uses, which resolves the git-provider binding CONFIGURED FOR THAT REPO and refuses to read one
 * repository with another binding's credential. Reusing it is deliberate: a second way to read a
 * user's repo would be a second place for that restraint to be forgotten.
 *
 * RESIDUAL, stated rather than hidden: a `renovate` key inside `package.json` is a supported (if
 * deprecated) Renovate config location and is not probed here, because probing it means parsing every
 * component manifest for a config. A repository configured that way is not detected, and the
 * actuator's re-check inherits the same blind spot — this is the known bound of the detection, not a
 * bug in it.
 */
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

/**
 * Persist the probe's verdict against the component.
 *
 * `insertDecisionIfChanged` rather than `insertDecision`, and that is not an optimisation: this probe
 * is re-run on a TIMER (every ingestion pass over a component), which is the exact writer shape that
 * produced 1.44 GB/day of byte-identical rows elsewhere in this system. A repository's delegation
 * status changes when somebody adds or deletes a file; the verdict should be written then and not
 * once per pass.
 *
 * AN INCONCLUSIVE PROBE IS REFUSED HERE, not merely skipped by the one caller that exists today.
 * The refusal belongs at the WRITER because that is the only place every future producer of this
 * verdict must pass through: a caller that forgot the check would otherwise persist an `allow` that
 * both readers then treat as a standing fact about a repository nobody could read. It throws BEFORE
 * touching `tx`, so it is a decision about the argument rather than a database outcome.
 */
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

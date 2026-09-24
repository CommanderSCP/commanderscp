import {
  categoryOfType,
  DEFAULT_REGISTRY_PACKAGE_FORMATS,
  DESTINATION_FORMAT_OF_TYPE,
  type ArtifactClass,
  type ComponentPipelineRegistry,
  type ExecutorType,
  type PackageFormat
} from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, sourceMappings } from "../db/schema.js";
import { registryForComponent } from "./component-pipeline.js";
import { insertDecision } from "./decisions-repo.js";
import { globMatch } from "./glob-match.js";
import {
  TriggerParameterRefusal,
  WAVE_TARGET_DESTINATION_REFUSED_AUDIT_ACTION,
  WAVE_TARGET_DESTINATION_REFUSED_STATUS,
  WAVE_TARGET_SOURCE_REFUSED_AUDIT_ACTION,
  WAVE_TARGET_SOURCE_REFUSED_STATUS
} from "./trigger-parameter-refusal.js";

/** WHAT A BUILD-LANE TRIGGER TELLS ITS EXECUTOR.
 *
 *  A build-lane trigger used to carry `targetRef` and nothing else: `parameters` was populated only
 *  from a campaign recipe (`recipeTriggerParameters`, which returns operator-authored values), so an
 *  ordinary promotion reached the executor with no repo, no commit and no destination. That made a
 *  SHIPPED, parameterised build template impossible — the only workable shape was one template per
 *  component with all three hardcoded, which is a catalog in name only.
 *
 *  The TEST lane already does this and says why: it sends the hook's declared `workflow` ref as a
 *  parameter rather than resolving the run itself, because "SCP coordinates, the executor
 *  executes" (`pipeline-hook-runs.ts`). This is the same rule applied to the build lane. Every
 *  value below is something SCP ALREADY HOLDS and is merely passing on — none of it is computed by
 *  inspecting the source, and nothing here builds anything.
 *
 *  ABSENT KEYS ARE OMITTED, never sent empty. A template that needs `sourceCommit` should fail
 *  because the parameter is missing, loudly, rather than receive "" and build whatever HEAD happens
 *  to be — which is the difference between a refused run and a wrong artifact.
 *
 *  THE DESTINATION IS DERIVED FROM THE TYPE'S CLASS, NOT FROM THE CATEGORY (M28.1, ADR-0053). It used
 *  to be derived for the whole `build` Category, so an `rpm` build was handed `imageDestination` — a
 *  container registry, which is a wrong answer rather than a missing one. Now the Type selects a
 *  destination format (`DESTINATION_FORMAT_OF_TYPE`), the registry declares the formats it serves,
 *  and a registry that cannot hold what this Type builds is REFUSED here, with a sentence, rather
 *  than handed over for a template to push into. */
export interface BuildTriggerParameterInput {
  orgId: string;
  /** The component being built. */
  targetObjectId: string;
  /** The routing Type — only a `build` Category gets these parameters. */
  type: ExecutorType;
  /** The change's `sourceRef` bag (`webhook-processor.ts`'s `canonicalizeSourceRef` writes
   *  `repo`/`ref`/`commit` into it). Untyped on purpose: a row replicated from an older peer, or a
   *  change proposed with a hand-supplied `sourceRef`, was never checked against a shape. */
  sourceRef: unknown;
  changeObjectId: string;
  /** The campaign recipe's `trigger.parameters`, when the change carries one. Read ONLY to refuse a
   *  recipe that restates a destination key (ADR-0053 §4a); the merge itself stays in reconcile. */
  recipeParameters?: Record<string, unknown> | undefined;
}

/** EVERY KEY `destinationParameters` CAN EMIT — the build lane's server-derived destination.
 *
 *  A recipe's parameters win a key collision with derived ones (reconcile's merge order), which is
 *  right for conveniences and wrong for these: a recipe restating `rpmUploadUrl` or
 *  `imageDestination` would route the artifact around the very refusal below. So for a Type whose
 *  destination SCP derives, a recipe naming any of these is refused rather than merged. Kept as
 *  one exported list so a later server-reserved-keys table (M28.4) can absorb it whole. */
export const BUILD_DESTINATION_PARAMETER_KEYS = [
  "registryUrl",
  "registryName",
  "imageRepository",
  "imageDestination",
  "packageRepository",
  "rpmUploadUrl",
  "rpmRepositoryUrl"
] as const;

/** The build lane's refusal: the declared destination cannot hold what this Type builds. */
export class BuildDestinationRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_DESTINATION_REFUSED_STATUS;
  readonly action = WAVE_TARGET_DESTINATION_REFUSED_AUDIT_ACTION;
}

/** The component property that names WHERE this Type's build definition lives in the repo. A fact
 *  about the component (a monorepo puts each one under its own directory), keyed by Type because a
 *  Dockerfile path handed to an RPM build is the same class of wrong answer as an image destination. */
const BUILD_DEFINITION_PROPERTY: Partial<Record<ArtifactClass, string>> = {
  image: "dockerfile",
  rpm: "rpmSpec"
};

function readString(bag: unknown, key: string): string | undefined {
  if (!bag || typeof bag !== "object") return undefined;
  const value = (bag as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function buildLaneTriggerParameters(
  tx: TenantTx,
  input: BuildTriggerParameterInput
): Promise<Record<string, unknown> | undefined> {
  // Only the BUILD Category. A `configuration` trigger drives a deploy that already knows what it
  // is deploying, and an `infrastructure` one has no artifact at all; sending build parameters
  // there would be noise the executor cannot act on.
  if (categoryOfType(input.type) !== "build") return undefined;
  const type = input.type as ArtifactClass;

  const params: Record<string, unknown> = { changeObjectId: input.changeObjectId };

  const repo = readString(input.sourceRef, "repo");
  const ref = readString(input.sourceRef, "ref");
  const commit = readString(input.sourceRef, "commit");
  if (repo) params.sourceRepo = repo;
  if (ref) params.sourceRef = ref;
  if (commit) params.sourceCommit = commit;

  // WHOSE CODE IS BUILT (M28.3 verification, ADR-0053 addendum). The build runs the repo's own
  // Dockerfile/spec and pushes the result with the operator's credentials, so the repo must be one
  // this component DECLARES — its source mappings for this Type — never simply the proposer's
  // choice. A recipe's `sourceRepo` wins the merge in reconcile, so it is checked too.
  await assertSourceIsDeclared(tx, input, type, [
    repo,
    readString(input.recipeParameters, "sourceRepo")
  ]);

  // WHERE THIS COMPONENT'S BUILD DEFINITION LIVES, when it says. A monorepo puts each component's
  // Dockerfile (or spec) under its own directory (`apps/profile-web/Dockerfile`), so the path is a
  // fact ABOUT THE COMPONENT, not a property of the build tooling — carrying it in chart values
  // would force every component in an organization to share one path. Absent ⇒ the catalog
  // template's own default, which is the single-service repo case.
  const definitionKey = BUILD_DEFINITION_PROPERTY[type];
  if (definitionKey) {
    const [component] = await tx
      .select({ properties: objects.properties })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.targetObjectId)))
      .limit(1);
    // Untyped for the same reason `sourceRef` is: a replicated row from an older peer was never
    // checked against a shape here.
    const definition = readString(component?.properties, definitionKey);
    if (definition) params[definitionKey] = definition;
  }

  // A Type with no destination class derives NO destination and does not consult the registry: SCP
  // has nothing to hand it, so there is nothing it could hand wrongly (ADR-0053's table).
  const format = DESTINATION_FORMAT_OF_TYPE[type];
  if (format !== null) {
    // BEFORE the registry is read, and whatever it says: a restated destination is refused even
    // when the component declares no registry, since that is precisely the case where the recipe's
    // value would be the only destination the executor sees.
    assertRecipeDoesNotRestateDestination(type, input.recipeParameters);
    // The SAME resolution the pipeline view renders, not a second one. `declared` is the only
    // state that names a destination: `none` has no edge and `ambiguous` has more than one, and
    // picking one of several would be exactly the silent guess the pipeline view refuses to make.
    const registry = await registryForComponent(tx, input.orgId, input.targetObjectId);
    if (registry.state === "declared") {
      assertRegistryServes(registry, type, format);
      Object.assign(params, destinationParameters(registry, format));
    }
  }

  return Object.keys(params).length > 1 ? params : undefined;
}

/** The build lane's source refusal: the repo is not one the component declares for this Type. */
export class BuildSourceRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_SOURCE_REFUSED_STATUS;
  readonly action = WAVE_TARGET_SOURCE_REFUSED_AUDIT_ACTION;
}

/** A component's DECLARED sources for one Type are its source mappings of that Type: the same rows
 *  that route a push to it (`correlation.ts`), matched the same way — a glob on the repo, a NULL
 *  pattern meaning every repo. Disabled rows still declare: a paused source is still the component's.
 *
 *  A component with NO mapping for this Type has declared nothing, and that is where the live
 *  estate is today (API-proposed builds with a hand-supplied sourceRef). Refusing them would stop
 *  builds that work, so that case is a `warn` Decision naming the undeclared repo and the build
 *  proceeds — an owner question recorded in ADR-0053's addendum, not a silent pass. */
async function assertSourceIsDeclared(
  tx: TenantTx,
  input: BuildTriggerParameterInput,
  type: ArtifactClass,
  candidates: (string | undefined)[]
): Promise<void> {
  const repos = [...new Set(candidates.filter((r): r is string => r !== undefined))];
  if (repos.length === 0) return;
  const rows = await tx
    .select({ repoPattern: sourceMappings.repoPattern })
    .from(sourceMappings)
    .where(
      and(
        eq(sourceMappings.orgId, input.orgId),
        eq(sourceMappings.componentObjectId, input.targetObjectId),
        eq(sourceMappings.type, type)
      )
    );
  const inputContext = {
    gate: "build_source_declared",
    type,
    requestedRepos: repos,
    declaredRepoPatterns: rows.map((r) => r.repoPattern)
  };
  if (rows.length === 0) {
    await insertDecision(tx, {
      orgId: input.orgId,
      kind: "wave_target",
      subjectId: input.changeObjectId,
      verdict: "warn",
      inputContext: { ...inputContext, gate: "build_source_undeclared" },
      reasonTree: {
        summary:
          `building ${repos.join(", ")} for component ${input.targetObjectId}, which declares no ` +
          `'${type}' source mapping — the repo is the proposer's word alone`,
        remediation: `declare this component's '${type}' source with a source mapping`
      }
    });
    return;
  }
  const undeclared = repos.filter(
    (r) => !rows.some((row) => row.repoPattern === null || globMatch(row.repoPattern, r))
  );
  if (undeclared.length > 0) {
    throw new BuildSourceRefused(
      `refusing to build ${undeclared.map((r) => `'${r}'`).join(", ")} for this '${type}' ` +
        `component: its declared sources are ${rows.map((r) => `'${r.repoPattern}'`).join(", ")}. ` +
        `The build runs that repository's own build definition and pushes the result with the ` +
        `operator's credentials, so it builds only what the component declares.`,
      {
        remediation:
          "propose the build from a repo the component's source mappings name, or add a source " +
          "mapping for this repo if it really is this component's source",
        inputContext
      }
    );
  }
}

/** Only ever called with a `declared` resolution — the one state that names a destination. */
type DeclaredRegistry = ComponentPipelineRegistry;

function assertRecipeDoesNotRestateDestination(
  type: ArtifactClass,
  recipeParameters: Record<string, unknown> | undefined
): void {
  if (!recipeParameters) return;
  const restated = BUILD_DESTINATION_PARAMETER_KEYS.filter((k) =>
    Object.hasOwn(recipeParameters, k)
  )
    .slice()
    .sort();
  if (restated.length === 0) return;
  throw new BuildDestinationRefused(
    `refusing to trigger this '${type}' build: its campaign recipe sets ${restated.join(", ")}, ` +
      `which SCP derives from the component's publishes_to registry. A recipe may add parameters ` +
      `but not choose where a '${type}' artifact is published — that would route it around the ` +
      `destination check entirely.`,
    {
      remediation:
        `remove ${restated.join(", ")} from the recipe's trigger.parameters and declare the ` +
        `destination as data instead (the component's publishes_to edge, and the registry's ` +
        `packageFormats), then cancel/rollback/re-propose the change`,
      // The keys only, never the values: a refused destination is not worth persisting verbatim.
      inputContext: { gate: "build_destination_recipe", type, recipeDestinationKeys: restated }
    }
  );
}

/** Refuse a registry that does not declare the format this Type publishes. See ADR-0053 §refusal. */
function assertRegistryServes(
  registry: DeclaredRegistry,
  type: ArtifactClass,
  format: PackageFormat
): void {
  const declared = registry.packageFormats ?? null;
  const serves = declared ?? DEFAULT_REGISTRY_PACKAGE_FORMATS;
  const inputContext = {
    gate: "build_destination_format",
    type,
    requiredFormat: format,
    registryExecutionSystemId: registry.executionSystemId,
    registryName: registry.name,
    registryKind: registry.kind,
    declaredPackageFormats: declared,
    effectivePackageFormats: [...serves]
  };
  const who = `registry '${registry.name ?? registry.executionSystemId}'`;
  if (!serves.includes(format)) {
    const what =
      declared === null
        ? `declares no packageFormats, which means [${DEFAULT_REGISTRY_PACKAGE_FORMATS.join(", ")}] — a container registry`
        : declared.length === 0
          ? `declares packageFormats that are not a list of strings, so it serves nothing SCP can read`
          : `declares packageFormats [${declared.join(", ")}]`;
    throw new BuildDestinationRefused(
      `refusing to trigger this '${type}' build: it publishes '${format}' packages, and its ${who} ` +
        `${what}. Handing it that registry would push this '${type}' artifact somewhere that cannot hold it.`,
      {
        remediation:
          `point this component's publishes_to edge at a registry that serves '${format}', or add ` +
          `'${format}' to the registry's properties.packageFormats if it really serves that format ` +
          `(a unified Gitea serves both: ["oci","rpm"]), then cancel/rollback/re-propose the change`,
        inputContext
      }
    );
  }
  // An RPM upload address is PRODUCT-shaped, unlike an OCI reference: Gitea takes a PUT to
  // `/api/packages/{owner}/rpm[/{group}]/upload`, Pulp and Nexus each take something else. Only the
  // shape SCP actually knows is derived; anything else is refused rather than guessed at.
  if (format === "rpm" && registry.kind !== "gitea") {
    throw new BuildDestinationRefused(
      `refusing to trigger this '${type}' build: its ${who} serves 'rpm' but is kind ` +
        `'${registry.kind ?? "(none)"}', and SCP derives an RPM upload address only for 'gitea'. ` +
        `Guessing another product's upload API would push to an address nobody declared.`,
      {
        remediation:
          `publish this component to a gitea registry, or drive it with a workflow template of your ` +
          `own that knows this registry's upload API (bind that template instead of scp-build-rpm-v1)`,
        inputContext
      }
    );
  }
}

/** The destination parameters for one format — the part that used to be container-shaped for all. */
function destinationParameters(
  registry: DeclaredRegistry,
  format: PackageFormat
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (registry.url) out.registryUrl = registry.url;
  if (registry.name) out.registryName = registry.name;

  if (format === "oci") {
    if (registry.repository) out.imageRepository = registry.repository;
    // THE FULLY-FORMED PUSH TARGET, `host/repository`, with the tag left to the executor.
    //
    // Derived HERE rather than in the workflow template, because a template that assembles it has
    // to strip the scheme off a URL in a templating language — and the failure mode of getting
    // that wrong is not an error, it is a push to the wrong registry. `registryUrl` is a BROWSABLE
    // url (`executionSystemConsoleBase` prefers `webUrl` and falls back to `serverUrl`), so the
    // hostname is the only part that addresses the registry.
    //
    // No try/catch here, and that is load-bearing rather than optimistic: `registry.url` is
    // `executionSystemConsoleBase(...)`, which returns a string only after `new URL()` has already
    // parsed it AND its protocol was http(s) — so a registry whose serverUrl is malformed arrives
    // with url `null` and names no destination at all, which is the refusal we want. Should this
    // ever be re-sourced from a RAW property, the parse becomes fallible and needs handling again.
    if (registry.repository && registry.url) {
      out.imageDestination = `${new URL(registry.url).host}/${registry.repository}`;
    }
    return out;
  }

  // rpm, on gitea (the only kind `assertRegistryServes` lets through). The edge's `repository` is
  // `owner[/group]`: Gitea's RPM registry is per OWNER, optionally split into groups (`el9`,
  // `el9/stable`), so the first segment is the owner and the rest, if any, is the group.
  if (registry.repository) out.packageRepository = registry.repository;
  if (registry.repository && registry.url) {
    const [owner, ...group] = registry.repository.split("/").filter((s) => s !== "");
    if (owner) {
      // Each segment encoded on its own, so an owner or group can never smuggle in a path.
      const path = [owner, "rpm", ...group].map(encodeURIComponent).join("/");
      const base = `${registry.url}/api/packages/${path}`;
      // Assembled here for the same reason `imageDestination` is: a template that concatenates it
      // gets a wrong URL rather than an error. `rpmRepositoryUrl` is the dnf baseurl the result is
      // installable from, carried so the run can name where it published.
      out.rpmUploadUrl = `${base}/upload`;
      out.rpmRepositoryUrl = base;
    }
  }
  return out;
}

import type { DesiredStateManifest, ExecutorType, InfraKind } from "@scp/schemas";
import {
  Component,
  DeploymentTarget,
  Service,
  Stack,
  type IDeploymentTarget
} from "./construct.js";
import { Bucket, Cluster, Database, InstanceGroup, Queue } from "./infra.js";
import {
  ChartPipeline,
  ConfigurationPipeline,
  DebPipeline,
  ExecutionSystem,
  GoPipeline,
  ImagePipeline,
  InfrastructurePipeline,
  MavenPipeline,
  NpmPipeline,
  PythonPipeline,
  RpmPipeline,
  VmImagePipeline,
  type PipelineBase,
  type PipelineParentScope
} from "./pipeline.js";
import { camelIdentifier } from "./products.js";
import type { WaveItem, WaveTarget } from "./waves.js";

/**
 * The shared emitter behind `scp iac export` (team-pipeline-iac.md §9/D5) and `scp iac scaffold`
 * (§7/D1/ADR-0047). Both commands walk a live estate (export: existing graph state; scaffold: a
 * discovery proposal) into the SAME normalized `ServiceSpec` below, then hand it to ONE of two pure
 * functions here:
 *
 *   - `buildEstateManifest(spec)` — INTERPRETS `spec` by calling the REAL `@scp/iac` constructs
 *     (`Component`, the typed `XxxPipeline` classes, `placeAt`, …) and returns `stack.synth()`.
 *   - `renderEstateProgram(spec)` — RENDERS the SAME calls as TypeScript SOURCE TEXT.
 *
 * Both read `spec` and nothing else — no SDK, no I/O, no clock (matching every other pure module in
 * this package). The CLI (`packages/cli`) owns turning live SDK reads into a `ServiceSpec`; this
 * module owns turning a `ServiceSpec` into a manifest or into code. That split is what makes the
 * round-trip property (§9: "exported ts, when synthesized, must produce a manifest equivalent to the
 * json export of the same scope") a fact about ONE input rather than two independently-maintained
 * readers of the live estate that could silently drift from each other.
 *
 * NOT auto-derived from each other (deliberately): `buildEstateManifest` calls real constructs, so
 * TypeScript itself enforces that `spec` matches what `@scp/iac` accepts; `renderEstateProgram`
 * mirrors the same calls as text. Nothing here CHECKS the two stay in lockstep beyond the round-trip
 * test in `estate-program.test.ts` — which is exactly the point: that test is the thing that would
 * go red the moment they diverge, matching the task's "assert this directly" instruction rather than
 * relying on a shared internal representation neither path can prove against the real types.
 */

export interface PipelineSourceSpec {
  /** @default "gitea" (the pipeline construct's own default, D18) */
  readonly sourceKind?: string;
  readonly repoPattern: string;
  readonly pathPattern?: string;
  /** Bare branch name (NOT `refs/heads/...` — the pipeline construct adds that prefix itself). */
  readonly branch?: string;
}

export interface PublishSpec {
  readonly destinationUrn: string;
  readonly repository?: string;
}

export interface PlacementSpec {
  readonly targetUrn: string;
  /** Present iff the live/proposed target is an infra product (D19/D24: a `deployment-target`
   *  object carrying `properties.kind`) — selects the typed `Cluster.fromUrn()`/`InstanceGroup.
   *  fromUrn()`/… reference over the plain `DeploymentTarget.fromUrn()` one. */
  readonly infraKind?: InfraKind;
}

export interface PipelineSpec {
  readonly kind: ExecutorType;
  /** @default the kind (matches `NestedPipelineProps.id`'s own default) */
  readonly id?: string;
  /** `undefined` — no source mapping exists for this pipeline in the live/proposed estate — is what
   *  triggers the D18 loud placeholder (see this module's doc and `renderEstateProgram`'s). */
  readonly source?: PipelineSourceSpec;
  readonly waves: WaveItem[];
  /** Build-kind pipelines only (`PublishProps`); ignored for infrastructure/configuration. */
  readonly publishesTo?: PublishSpec;
  /** Set ⇒ this pipeline already has a live `release-topology` object (export's own case); threads
   *  straight to `Pipeline`'s `adoptTopologyUrn` prop so `scp apply` ADOPTS it instead of creating a
   *  duplicate beside it (`pipeline.ts`'s `adoptTopologyUrn` doc carries the full hazard). Omitted
   *  (scaffold's case — nothing exists yet) ⇒ a fresh, synth-derived URN. */
  readonly topologyUrn?: string;
}

export interface ComponentSpec {
  /** Construct id AND the slug `camelIdentifier` derives the JS variable name from. */
  readonly constructId: string;
  readonly name: string;
  /** Set ⇒ this component already exists live; the emitted `Component` carries this as its explicit
   *  `urn`, so `scp apply` ADOPTS it (D5) instead of creating a new object. Omitted (scaffold's own
   *  case, ADR-0047: nothing here exists yet) ⇒ a fresh, synth-derived URN. */
  readonly urn?: string;
  /** ALL live placements, not just the ones a pipeline's waves would infer — declared explicitly so
   *  every one round-trips regardless of whether it lines up with a wave target (D8: "an explicit
   *  declaration always overrides an inferred one", enforced by `Stack.hasPlacement` dedup — emitting
   *  these BEFORE the pipelines below means an inferred duplicate is never added). */
  readonly placements: PlacementSpec[];
  readonly pipelines: PipelineSpec[];
}

export interface ServiceSpec {
  readonly stackName: string;
  readonly serviceName: string;
  /** Set ⇒ reference an EXISTING service (`Service.fromUrn`, export's own case: the scope you asked
   *  to export already exists). Omitted ⇒ declare a NEW one (scaffold's case). */
  readonly serviceUrn?: string;
  readonly components: ComponentSpec[];
}

// -------------------------------------------------------------------------------------------
// D18's loud placeholder. ONE marker string, shared by both emitters' documentation (not their
// literal output — see `renderEstateProgram`'s doc for why the TS side goes further and fails
// typecheck), so a human grepping either form for "why is this here" finds the same trail.
// -------------------------------------------------------------------------------------------

export const PLACEHOLDER_REPO_MARKER = "TODO-SCP-EXPORT-NO-SOURCE-MAPPING";

function placeholderRepoValue(componentName: string, kind: ExecutorType): string {
  const slug = componentName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PLACEHOLDER_REPO_MARKER}/${slug || "component"}-${kind}`;
}

function isBuildKind(kind: ExecutorType): boolean {
  return kind !== "infrastructure" && kind !== "configuration";
}

// -------------------------------------------------------------------------------------------
// Kind -> {class name, constructor} tables, ONE canonical list each side reads, so the interpreter's
// constructor choice and the renderer's printed class name can never name two different things.
// -------------------------------------------------------------------------------------------

/** Erased constructor shape every generated pipeline-kind class satisfies — `pipeline.ts`'s own
 *  `PipelineConstructStatics<K>` is generic per-kind (its props type varies with `K`, specifically
 *  `MaybePublishProps<K>`), which is exactly right for a program written by hand against ONE known
 *  kind and exactly unusable for a table indexed by `ExecutorType` at large: `Record<ExecutorType,
 *  PipelineConstructStatics<K>>` has no single `K` to be generic over. This interpreter passes a
 *  loosely-typed `props` object built from `spec` (below) instead — the real per-kind type-checking
 *  this erasure steps around is proven elsewhere (`pipeline.placeAt.typecheck.test.ts`); what THIS
 *  table needs is "call the right class", not "re-derive its compile-time prop shape". */
type ErasedPipelineCtor = new (
  scope: PipelineParentScope,
  id: string,
  props: Record<string, unknown>
) => PipelineBase<ExecutorType>;

const PIPELINE_KIND_INFO: Record<ExecutorType, { className: string; ctor: ErasedPipelineCtor }> = {
  image: { className: "ImagePipeline", ctor: ImagePipeline as unknown as ErasedPipelineCtor },
  rpm: { className: "RpmPipeline", ctor: RpmPipeline as unknown as ErasedPipelineCtor },
  deb: { className: "DebPipeline", ctor: DebPipeline as unknown as ErasedPipelineCtor },
  npm: { className: "NpmPipeline", ctor: NpmPipeline as unknown as ErasedPipelineCtor },
  maven: { className: "MavenPipeline", ctor: MavenPipeline as unknown as ErasedPipelineCtor },
  python: { className: "PythonPipeline", ctor: PythonPipeline as unknown as ErasedPipelineCtor },
  go: { className: "GoPipeline", ctor: GoPipeline as unknown as ErasedPipelineCtor },
  chart: { className: "ChartPipeline", ctor: ChartPipeline as unknown as ErasedPipelineCtor },
  "vm-image": {
    className: "VmImagePipeline",
    ctor: VmImagePipeline as unknown as ErasedPipelineCtor
  },
  infrastructure: {
    className: "InfrastructurePipeline",
    ctor: InfrastructurePipeline as unknown as ErasedPipelineCtor
  },
  configuration: {
    className: "ConfigurationPipeline",
    ctor: ConfigurationPipeline as unknown as ErasedPipelineCtor
  }
};

const INFRA_KIND_INFO: Record<
  InfraKind,
  { className: string; fromUrn(urn: string): IDeploymentTarget }
> = {
  cluster: { className: "Cluster", fromUrn: Cluster.fromUrn },
  instanceGroup: { className: "InstanceGroup", fromUrn: InstanceGroup.fromUrn },
  database: { className: "Database", fromUrn: Database.fromUrn },
  bucket: { className: "Bucket", fromUrn: Bucket.fromUrn },
  queue: { className: "Queue", fromUrn: Queue.fromUrn }
};

// -------------------------------------------------------------------------------------------
// The interpreter — `--format json`'s path, and the "expected" half of the round-trip test.
// -------------------------------------------------------------------------------------------

export interface BuiltEstateProgram {
  readonly manifest: DesiredStateManifest;
  /** How many pipelines got the D18 loud placeholder instead of a real `repo` — the export/scaffold
   *  CLI surfaces this count so a reviewer knows how many stacks still need a human to fill one in. */
  readonly placeholderCount: number;
}

export function buildEstateManifest(spec: ServiceSpec): BuiltEstateProgram {
  const stack = new Stack(spec.stackName);
  const serviceRef =
    spec.serviceUrn !== undefined
      ? Service.fromUrn(spec.serviceUrn)
      : new Service(stack, "service", { name: spec.serviceName });

  let placeholderCount = 0;

  for (const c of spec.components) {
    const component = new Component(stack, c.constructId, {
      name: c.name,
      service: serviceRef,
      ...(c.urn !== undefined ? { urn: c.urn } : {})
    });

    // Explicit placements FIRST — see `ComponentSpec.placements`'s doc for why order matters here.
    for (const p of c.placements) {
      component.placeAt(placementRef(p));
    }

    for (const pl of c.pipelines) {
      if (pl.source === undefined) placeholderCount++;
      const repo = pl.source?.repoPattern ?? placeholderRepoValue(c.name, pl.kind);
      const props: Record<string, unknown> = {
        repo,
        waves: pl.waves,
        ...(pl.source?.branch !== undefined ? { branch: pl.source.branch } : {}),
        ...(pl.source?.pathPattern !== undefined ? { path: pl.source.pathPattern } : {}),
        ...(pl.source?.sourceKind !== undefined ? { sourceKind: pl.source.sourceKind } : {}),
        ...(pl.topologyUrn !== undefined ? { adoptTopologyUrn: pl.topologyUrn } : {})
      };
      if (isBuildKind(pl.kind) && pl.publishesTo !== undefined) {
        props["publishesTo"] = ExecutionSystem.fromUrn(pl.publishesTo.destinationUrn);
        if (pl.publishesTo.repository !== undefined) {
          props["repository"] = pl.publishesTo.repository;
        }
      }
      const { ctor } = PIPELINE_KIND_INFO[pl.kind];
      new ctor(component, pl.id ?? pl.kind, props);
    }
  }

  return { manifest: stack.synth(), placeholderCount };
}

function placementRef(p: PlacementSpec): IDeploymentTarget {
  if (p.infraKind !== undefined) return INFRA_KIND_INFO[p.infraKind].fromUrn(p.targetUrn);
  return DeploymentTarget.fromUrn(p.targetUrn);
}

// -------------------------------------------------------------------------------------------
// The renderer — `--format ts`'s path. Mirrors `buildEstateManifest`'s calls as TypeScript source,
// with ONE deliberate divergence: the D18 placeholder.
//
// ============================================================================================
// WHY THE TS PLACEHOLDER IS `undefined`, NOT THE SAME STRING THE JSON PATH USES
// ============================================================================================
// `buildEstateManifest` needs *a* non-empty string (the real `PipelineBase` constructor throws on an
// empty one) so the interpreter can still produce a manifest to inspect/diff. The renderer has a
// stronger tool available and the task calls for using it: a `repo` prop typed `string` (required,
// D18) rejects `undefined` at compile time under this repo's `strict` tsconfig, so emitting an
// `undefined`-typed local as the value makes the whole file FAIL TO TYPECHECK until a human replaces
// it — not just visually obvious, but mechanically unmissable (CI/`tsc --noEmit` refuses it, matching
// this repo's "fail loudly, not just visibly" standard). `estate-program.test.ts`'s placeholder case
// proves this by actually invoking the TypeScript compiler against the rendered output.
// -------------------------------------------------------------------------------------------

export interface RenderedEstateProgram {
  readonly source: string;
  readonly placeholderCount: number;
}

const DEFAULT_HEADER =
  "// GENERATED by `@scp/iac` (team-pipeline-iac.md §9/§7) — review before committing.\n" +
  "// Placeholders marked below (if any) make this file FAIL TO TYPECHECK on purpose; fill them in.";

/**
 * §8's commented starter wave topology — text only, never live code (a scaffolded component's real
 * environments/stages are not something discovery can know). `scp iac scaffold` passes this via
 * `renderEstateProgram`'s `waveGuidance` option so every emitted pipeline that starts with an EMPTY
 * `waves: []` carries the shape a team is expected to grow it into, in `staging`/`production`
 * vocabulary (D6/D21(e)) — never `gamma`, never bare `prod`.
 */
export const WAVE_TOPOLOGY_GUIDANCE =
  "// Starter wave topology (team-pipeline-iac.md §8) — `waves: []` below is EMPTY on purpose: no\n" +
  "// real stages were discovered, so nothing is guessed. Grow it with one of:\n" +
  '//   waves.linear(["staging", "production"])\n' +
  "//   waves.widening([target1, target2, target3, target4], { start: 1, factor: 2 })  // 1 -> 2 -> 4\n" +
  "//   waves.byDomain(commercialTargets, govcloudTargets, airgapTargets)\n" +
  '// import { waves } from "@scp/iac"; canary percentages within a target are the rollout\n' +
  "// executor's job (Argo Rollouts, ADR-0008) — these helpers only order WAVES of stages.";

function jsString(value: string): string {
  return JSON.stringify(value);
}

function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

function renderWaveTarget(t: WaveTarget): string {
  return typeof t === "string" ? jsString(t) : jsString(t.urn);
}

function renderWaveItem(item: WaveItem): string {
  if (Array.isArray(item)) {
    return `[${item.map(renderWaveTarget).join(", ")}]`;
  }
  if (typeof item === "object" && item !== null && "targets" in item) {
    const obj = item as {
      name?: string;
      mode?: "parallel" | "sequential";
      targets: readonly WaveTarget[];
      requiresFanIn?: boolean;
    };
    const parts: string[] = [];
    if (obj.name !== undefined) parts.push(`name: ${jsString(obj.name)}`);
    if (obj.mode !== undefined) parts.push(`mode: ${jsString(obj.mode)}`);
    parts.push(`targets: [${obj.targets.map(renderWaveTarget).join(", ")}]`);
    if (obj.requiresFanIn !== undefined) parts.push(`requiresFanIn: ${String(obj.requiresFanIn)}`);
    return `{ ${parts.join(", ")} }`;
  }
  return renderWaveTarget(item as WaveTarget);
}

function renderWaves(waves: readonly WaveItem[]): string {
  if (waves.length === 0) return "[]";
  return `[\n${indent(waves.map((w) => renderWaveItem(w) + ",").join("\n"))}\n]`;
}

export function renderEstateProgram(
  spec: ServiceSpec,
  opts: { header?: string; waveGuidance?: boolean } = {}
): RenderedEstateProgram {
  let placeholderCount = 0;
  const usedPipelineKinds = new Set<ExecutorType>();
  const usedInfraKinds = new Set<InfraKind>();
  let usesDeploymentTargetRef = false;
  let usesExecutionSystemRef = false;
  const placeholderBlocks: string[] = [];
  const bodyLines: string[] = [];

  bodyLines.push(`export const stack = new Stack(${jsString(spec.stackName)});`);
  if (spec.serviceUrn !== undefined) {
    bodyLines.push(`const service = Service.fromUrn(${jsString(spec.serviceUrn)});`);
  } else {
    bodyLines.push(
      `const service = new Service(stack, "service", { name: ${jsString(spec.serviceName)} });`
    );
  }
  bodyLines.push("");

  for (const c of spec.components) {
    const varName = camelIdentifier(c.constructId);
    const componentProps = [`name: ${jsString(c.name)}`, "service"];
    if (c.urn !== undefined) componentProps.push(`urn: ${jsString(c.urn)}`);
    bodyLines.push(
      `const ${varName} = new Component(stack, ${jsString(c.constructId)}, { ${componentProps.join(", ")} });`
    );

    for (const p of c.placements) {
      let ref: string;
      if (p.infraKind !== undefined) {
        usedInfraKinds.add(p.infraKind);
        ref = `${INFRA_KIND_INFO[p.infraKind].className}.fromUrn(${jsString(p.targetUrn)})`;
      } else {
        usesDeploymentTargetRef = true;
        ref = `DeploymentTarget.fromUrn(${jsString(p.targetUrn)})`;
      }
      bodyLines.push(`${varName}.placeAt(${ref});`);
    }

    for (const pl of c.pipelines) {
      usedPipelineKinds.add(pl.kind);
      const { className } = PIPELINE_KIND_INFO[pl.kind];
      const id = pl.id ?? pl.kind;

      let repoExpr: string;
      if (pl.source !== undefined) {
        repoExpr = jsString(pl.source.repoPattern);
      } else {
        placeholderCount++;
        const constName = `TODO_MISSING_REPO_${placeholderCount}`;
        placeholderBlocks.push(
          [
            `// !!! SCP-EXPORT PLACEHOLDER (${placeholderCount}) !!!`,
            `// No source mapping was found in the live estate for component ${jsString(c.name)}'s`,
            `// "${pl.kind}" pipeline. @scp/iac requires \`repo\` (D18) and never invents one — a`,
            `// fabricated value would produce a stack that applies and points at the wrong source.`,
            `// This constant is deliberately typed \`undefined\`: the file below will NOT typecheck`,
            `// until you replace ${constName} with the real org-relative repo path (see \`repos()\`).`,
            `const ${constName}: undefined = undefined;`
          ].join("\n")
        );
        repoExpr = constName;
      }

      const propLines: string[] = [`repo: ${repoExpr}`];
      if (pl.source?.branch !== undefined) propLines.push(`branch: ${jsString(pl.source.branch)}`);
      if (pl.source?.pathPattern !== undefined) {
        propLines.push(`path: ${jsString(pl.source.pathPattern)}`);
      }
      if (pl.source?.sourceKind !== undefined) {
        propLines.push(`sourceKind: ${jsString(pl.source.sourceKind)}`);
      }
      propLines.push(`waves: ${renderWaves(pl.waves)}`);
      if (pl.topologyUrn !== undefined) {
        // Adoption, not authoring (`pipeline.ts`'s `adoptTopologyUrn` doc carries the full hazard):
        // without this, applying an exported program would create a SECOND `release-topology`
        // object beside the live one this pipeline already has.
        propLines.push(`adoptTopologyUrn: ${jsString(pl.topologyUrn)}`);
      }
      if (isBuildKind(pl.kind) && pl.publishesTo !== undefined) {
        usesExecutionSystemRef = true;
        propLines.push(
          `publishesTo: ExecutionSystem.fromUrn(${jsString(pl.publishesTo.destinationUrn)})`
        );
        if (pl.publishesTo.repository !== undefined) {
          propLines.push(`repository: ${jsString(pl.publishesTo.repository)}`);
        }
      }
      bodyLines.push(
        `new ${className}(${varName}, ${jsString(id)}, {\n${indent(propLines.join(",\n"))}\n});`
      );
    }
    bodyLines.push("");
  }

  // Trailing synth + export — lets a caller (or CI, or this package's own round-trip test) `import()`
  // the file and read `.manifest` straight off it, the same drift-check shape `scp iac render --write`
  // already establishes for the pipeline picture. Real teams' own CI still owns committing this next
  // to a `scp/manifest.json` (D2/D9); this export is what makes THAT step (and this tool's own
  // round-trip proof) a plain `import`, not a second bespoke synth entry point.
  bodyLines.push("export const manifest = stack.synth();");

  const importNames = new Set<string>(["Stack", "Service", "Component"]);
  if (usesDeploymentTargetRef) importNames.add("DeploymentTarget");
  if (usesExecutionSystemRef) importNames.add("ExecutionSystem");
  for (const k of usedPipelineKinds) importNames.add(PIPELINE_KIND_INFO[k].className);
  for (const k of usedInfraKinds) importNames.add(INFRA_KIND_INFO[k].className);

  const importLine = `import { ${[...importNames].sort().join(", ")} } from "@scp/iac";`;
  const header = opts.header ?? DEFAULT_HEADER;

  const source =
    `${header}\n${importLine}\n\n` +
    (opts.waveGuidance === true ? `${WAVE_TOPOLOGY_GUIDANCE}\n\n` : "") +
    (placeholderBlocks.length > 0 ? placeholderBlocks.join("\n\n") + "\n\n" : "") +
    bodyLines.join("\n").replace(/\n{3,}/g, "\n\n") +
    "\n";

  return { source, placeholderCount };
}

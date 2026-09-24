/** The constructs that synthesize a deterministic manifest. See docs/coordination-as-code.md §263. */
// `App` is synth plumbing (D15a) — `new Stack("name")` auto-creates one internally and it never
// appears in user code, so it is module-internal to `construct.ts` and NOT exported here.
export { Stack, ResourceConstruct, Construct } from "./construct.js";
export type { ResourceProps } from "./construct.js";
export {
  Service,
  Component,
  Domain,
  Team,
  Policy,
  DeploymentTarget,
  Group,
  User,
  ServiceAccount,
  Campaign,
  ReleaseTopology,
  Placement
} from "./construct.js";
export type {
  ComponentProps,
  CampaignProps,
  ReleaseTopologyProps,
  ReleaseTopologyWaveSpec,
  SourceMappingSpec,
  ExecutorBindingSpec,
  DependencyProducerSpec
} from "./construct.js";
// fromXxx() reference statics + the interface types they (and every owned construct) implement
// (D16(2)) — an owned construct and a `Service.fromName(...)`/`.fromUrn(...)` reference are
// interchangeable wherever the interface is accepted.
export type {
  IResourceRef,
  IService,
  IComponent,
  IDomain,
  ITeam,
  IPolicy,
  IDeploymentTarget,
  IGroup,
  IUser,
  IServiceAccount
} from "./construct.js";
export { deriveConstructUrn, slugify } from "./urn.js";
export { canonicalJson } from "./canonical.js";
// ADR-0047 — the scaffold grouping decision, shared by `scp iac scaffold` and the /connect wizards.
export { groupDiscoveryProposal } from "./scaffold.js";
export type { ScaffoldGroupingResult, UngroupedComponent } from "./scaffold.js";
export { Duration } from "./duration.js";
// team-pipeline-iac D11/D12/D15/D16 — the typed pipeline behaviours (L2), thin sugar over the
// increment-8 contract's own Zod types. The L1 doors they emit through (`Stack.addPipelineHook`,
// `addRollout`, `addConvergence`) stay available for anything these do not cover.
export {
  Workflow,
  PostMergeTest,
  PostDeployTest,
  ContinuousTest,
  BakeAlarms,
  CanaryRollout,
  RollingRollout
} from "./behaviors.js";

// RBAC (role-model.md — the IaC rung). See docs/coordination-as-code.md §264.
export { RoleBinding, OrgRole } from "./rbac.js";
export type { RoleBindingProps, OrgRoleProps } from "./rbac.js";
export type {
  WorkflowProps,
  PostDeployTestProps,
  ContinuousTestProps,
  BakeAlarmsProps,
  CanaryRolloutProps,
  RollingRolloutProps,
  BehaviorHost
} from "./behaviors.js";

// Round B (team-pipeline-iac.md): typed pipeline-kind constructs, infra products, and wave helpers.
export {
  ImagePipeline,
  RpmPipeline,
  DebPipeline,
  NpmPipeline,
  MavenPipeline,
  PythonPipeline,
  GoPipeline,
  ChartPipeline,
  VmImagePipeline,
  InfrastructurePipeline,
  ConfigurationPipeline,
  PipelineBase,
  PIPELINE_KINDS,
  ExecutionSystem,
  repos
} from "./pipeline.js";
export type {
  PipelineConstructStatics,
  PipelineParentScope,
  PipelineSourceProps,
  PipelineWavesProps,
  PublishProps,
  RootPipelineProps,
  NestedPipelineProps,
  RootPipelinePropsFor,
  NestedPipelinePropsFor,
  IExecutionSystem
} from "./pipeline.js";
export { Cluster, InstanceGroup, Database, Bucket, Queue, PLACEMENT_MATRIX } from "./infra.js";
export type {
  ICluster,
  IInstanceGroup,
  IDatabase,
  IBucket,
  IQueue,
  InfraKindInterfaceMap,
  InfraProductProps,
  InfraProductScope,
  InfraProductStatics,
  PlaceableTarget
} from "./infra.js";
export { linear, widening, byDomain, waves, normalizeWaveItems } from "./waves.js";
export type { WaveTarget, WaveItem, WideningOptions } from "./waves.js";

// D20: the products module a consuming repo imports for a compile-time-checked `placeAt(...)`.
export {
  camelIdentifier,
  collectProducts,
  productsModuleSource,
  renderProductsModule
} from "./products.js";
export type { ProductEntry } from "./products.js";

// D21(d): `scp iac render` — turns a synthesized manifest back into the human-readable pipeline
// picture, honestly labeled where it cannot see an estate-imposed gate.
export {
  MANIFEST_ONLY_DISCLAIMER,
  RENDER_BEGIN_MARKER,
  RENDER_END_MARKER,
  formatPipelineBlock,
  renderManifestPipelines,
  renderManifestSection,
  updateGeneratedSection
} from "./render.js";
export type { RenderedPipeline } from "./render.js";

// team-pipeline-iac.md §9/§7: the shared emitter behind `scp iac export` and `scp iac scaffold` —
// walks a normalized `ServiceSpec` (built by the CLI from SDK reads / a discovery proposal) into
// either a synthesized manifest or TypeScript construct source, guaranteed to agree by construction
// (see `estate-program.ts`'s module doc).
export {
  PLACEHOLDER_REPO_MARKER,
  WAVE_TOPOLOGY_GUIDANCE,
  buildEstateManifest,
  renderEstateProgram
} from "./estate-program.js";
export type {
  BuiltEstateProgram,
  ComponentSpec,
  PipelineSourceSpec,
  PipelineSpec,
  PlacementSpec,
  PublishSpec,
  RenderedEstateProgram,
  ServiceSpec
} from "./estate-program.js";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Stack } from "./construct.js";
import { canonicalJson } from "./canonical.js";
import { productsModuleSource } from "./products.js";
import type { InfraProductScope } from "./infra.js";

/** Writes the canonical JSON manifest to disk. See docs/coordination-as-code.md §265. */
export async function synthToFile(target: Stack, filePath: string): Promise<void> {
  const manifest = target.synth();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, canonicalJson(manifest) + "\n", "utf8");
}

/** Writes a pipeline's products module to disk. See docs/coordination-as-code.md §266. */
export async function synthProductsModuleToFile(
  scope: InfraProductScope,
  filePath: string
): Promise<void> {
  const source = productsModuleSource(scope);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source, "utf8");
}

/**
 * `@scp/iac` — CDK-style TypeScript constructs that synthesize a deterministic desired-state
 * manifest via PURE synth (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15). No API calls, no
 * randomness, no wall-clock reads in `synth()` — works fully offline, so IaC programs can be
 * authored/synthesized in CI or across an air gap and applied later (`scp plan`/`scp apply`,
 * `packages/cli`), exactly like a CDK cloud assembly being `cdk deploy`'d separately from where
 * it was synthesized.
 */
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
export { Duration } from "./duration.js";

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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Stack } from "./construct.js";
import { canonicalJson } from "./canonical.js";

/**
 * Writes the canonical JSON manifest to disk — the interchange point between IaC authoring
 * (pure, offline synth) and server-side reconciliation (`scp plan`/`scp apply`, `POST /plans`),
 * exactly like `cdk synth` writing a cloud-assembly directory that `cdk deploy` reads separately.
 * Uses recursively-sorted-key canonical JSON (`canonicalJson`), not plain `JSON.stringify`, so the
 * file's bytes are stable even when caller-supplied `properties`/`labels` objects were built with
 * different key insertion order — the same byte-identical-output guarantee `synth()` itself makes.
 */
export async function synthToFile(target: Stack, filePath: string): Promise<void> {
  const manifest = target.synth();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, canonicalJson(manifest) + "\n", "utf8");
}

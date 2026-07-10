/**
 * @scp/sdk — generated core (`@hey-api/openapi-ts`, committed under src/generated) plus a thin
 * handwritten layer (auth, pagination) — DESIGN.md §15. The UI and CLI consume only this
 * package; nothing may bypass the public API.
 */
export { ScpClient } from "./client.js";
export type {
  ScpClientOptions,
  ListServiceObjectsQuery,
  LoginResult,
  ListQuery,
  ListObjectsQuery,
  ListRelationshipsQuery,
  GraphQueryParams,
  TraverseParams
} from "./client.js";
export { ScpApiError } from "./errors.js";

export type {
  CreateServiceObjectData,
  CreateServiceObjectResponse,
  ListServiceObjectsData,
  ListServiceObjectsResponse,
  LoginData,
  LoginResponse
} from "./generated/index.js";

// M2 stage 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — re-exported so CLI/consumers
// don't need a direct @scp/schemas dependency for these shapes.
export type {
  CreatePatRequest,
  CreatePatResponse,
  Pat,
  PatListResponse,
  DeviceStartResponse,
  DeviceApproveResponse
} from "@scp/schemas";

// M2 stage 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
export type { ApplyPlanResponse, DesiredStateManifest, Plan, PlanDiff } from "@scp/schemas";
export { DesiredStateManifestSchema } from "@scp/schemas";

// M3: the Change lifecycle + Decision records + change sources (BUILD_AND_TEST.md §8 M3).
export type {
  Change,
  ChangeState,
  ChangeListQuery,
  ChangeListResponse,
  ChangePlan,
  ChangeWave,
  ChangeWaveTarget,
  ChangeExplainResponse,
  CreateChangeRequest,
  Decision,
  DecisionListQuery,
  DecisionListResponse,
  CreateSourceMappingRequest,
  SourceMapping,
  SourceMappingListResponse,
  WebhookIngressResponse
} from "@scp/schemas";

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

// M4: Governance Engine — control runs/bindings, approvals (N-of-M quorum), freezes, and `scp
// policy evaluate`'s dry-run response (BUILD_AND_TEST.md §8 M4). Policy/Control documents
// themselves are plain typed-registry `GraphObject`s (already covered by the M2 exports above) —
// this only adds the projection-table resources that have no graph-object equivalent. Until this
// commit these were only ever re-exported informally (packages/cli/src/cli.ts imported them
// straight from @scp/schemas — allowed by eslint's own restricted-imports rule, but not what
// `@scp/sdk`'s own module doc above promises for a THIRD-PARTY consumer of this package).
export type {
  ControlOutcomeStatus,
  ControlRun,
  ControlRunListResponse,
  CreateControlBindingRequest,
  ControlBinding,
  ApprovalRequest,
  ApprovalRequestListQuery,
  ApprovalRequestListResponse,
  Attestation,
  ApprovalVote,
  CastApprovalVoteRequest,
  Freeze,
  CreateFreezeRequest,
  FreezeListResponse,
  PolicyEvaluateRequest,
  PolicyEvaluateResponse
} from "@scp/schemas";

// M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN.md §11/§12) — executor/
// notification bindings, encrypted secrets (write-only), the plugin-manifest catalog a config
// form is generated from, DiscoveryPlugin run/accept, and the webhook signing-secret + `scp
// change report` wire shapes.
export type {
  CreateExecutorBindingRequest,
  ExecutorBinding,
  NotificationSeverity,
  CreateNotificationBindingRequest,
  NotificationBinding,
  NotificationBindingListResponse,
  PutSecretRequest,
  SecretConfiguredResponse,
  SecretKeyListResponse,
  PluginKind,
  PluginManifest,
  PluginManifestListResponse,
  DiscoveryProposal,
  RunDiscoveryRequest,
  AcceptDiscoveryRequest,
  AcceptDiscoveryResponse,
  ChangeReportRequest,
  CreateWebhookSecretRequest,
  WebhookSecretConfiguredResponse
} from "@scp/schemas";

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
  ListPlacementsQuery,
  ListRelationshipsQuery,
  GraphQueryParams,
  TraverseParams
} from "./client.js";
export { ScpApiError, ScpResponseValidationError, reconcileStaleClaimants } from "./errors.js";
export type { ProblemWithExtensions, ResponseValidationIssue } from "./errors.js";

// The live event stream (`client.events.stream()`) — `RelayedEvent` re-exported so `apps/web` keeps
// consuming ONLY the generated SDK for the SSE channel too (charter principle 3).
export { resilientEventStream } from "./event-stream.js";
export type { EventStreamOptions, OpenEventStream } from "./event-stream.js";
export type { RelayedEvent } from "@scp/schemas";

// Graph-integrity report types — a SEPARATE step from the client method; schema types are not
// re-exported automatically, and omitting this is what made #211's failure look like a missing method.
export type { GraphIntegrityReport, DanglingRelationship, OrphanProjectionRow } from "@scp/schemas";

// `scp doctor` report types — same SEPARATE step as the graph-integrity line above (schema types are
// not re-exported automatically, and forgetting this makes a present client method look missing).
export type { DoctorReport, DoctorCheck, DoctorCheckStatus } from "@scp/schemas";

export type {
  CreateServiceObjectData,
  CreateServiceObjectResponse,
  ListServiceObjectsData,
  ListServiceObjectsResponse,
  LoginData,
  LoginResponse,
  // M23.1g: THE GENERATED shape of `GET /changes/{id}:explain`, re-exported so a consumer can pin
  // itself to what the OpenAPI document actually says rather than to the hand-written
  // `ChangeExplainResponse` alias above. The two are meant to agree; the point of offering this one
  // is that `observed.truncation` has to be reachable through the GENERATED types alone — a signal
  // a consumer can only read by importing `@scp/schemas` (or, worse, `@scp/runner-launcher`) is not
  // an API-first signal (charter principle 3). `observed-truncation.integration.test.ts` is the
  // consumer that proves it.
  ExplainChangeResponse
} from "./generated/index.js";

// M2 step 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — re-exported so CLI/consumers
// don't need a direct @scp/schemas dependency for these shapes.
export type {
  CreatePatRequest,
  CreatePatResponse,
  Pat,
  PatListResponse,
  DeviceStartResponse,
  DeviceApproveResponse
} from "@scp/schemas";

// M2 step 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
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

// M16.1: the universal boundary segment on `explain` (ADR-0011; ADR-0021 D6 vocabulary — a boundary
// SEGMENT of two boundary PHASES, never a "stage" and never a "wave"). Re-exported so `apps/web`
// keeps consuming ONLY the generated SDK (charter principle 3).
export type {
  BoundarySegment,
  BoundaryTransferPhase,
  BoundaryTransferHop,
  BoundaryValidatePhase
} from "@scp/schemas";

// ADR-0028 increment 4: the live stage-dependency status on `explain`. Re-exported for the same
// reason the boundary segment above is — `apps/web` consumes ONLY the generated SDK (charter
// principle 3), and the change-pipeline view names the per-target verdict in a prop type.
export type {
  ChangeStageDependencyStatus,
  ChangeStageDependencyTarget,
  ChangeStageDependencyVerdict
} from "@scp/schemas";

// Phase 2 coordination UI: the service release board projection (coordination-ui-views.md
// § "Service release board") — one HTTP call backing `client.services.board(idOrUrn)`.
export type {
  ComponentPipelineResponse,
  ComponentPipelineSource,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage,
  ServiceBoardResponse,
  ServiceBoardAssembly,
  ServiceBoardRow,
  ServiceBoardWave,
  ServiceBoardKind,
  ServiceBoardAttention,
  ServiceBoardFreeze,
  ServiceBoardSummary,
  ServiceBoardAsOf
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
  ChangeReportRequest,
  CreateWebhookSecretRequest,
  WebhookSecretConfiguredResponse
} from "@scp/schemas";

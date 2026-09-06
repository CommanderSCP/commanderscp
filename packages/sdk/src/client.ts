import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/index.js";
import {
  login as loginRequest,
  // M2 step 4 (BUILD_AND_TEST.md §8 M2 item 2) — how the Web UI discovers/ends its httpOnly
  // cookie session, and whether to offer "Continue with SSO" (routes/auth.ts Part A additions).
  getCurrentUser as getCurrentUserRequest,
  logout as logoutRequest,
  getAuthConfig as getAuthConfigRequest,
  listServiceObjects as listServiceObjectsRequest,
  createServiceObject as createServiceObjectRequest,
  listServiceObjectsForOrg as listServiceObjectsForOrgRequest,
  createServiceObjectForOrg as createServiceObjectForOrgRequest,
  createObjectType as createObjectTypeRequest,
  listObjectTypes as listObjectTypesRequest,
  createRelationshipType as createRelationshipTypeRequest,
  listRelationshipTypes as listRelationshipTypesRequest,
  createObject as createObjectRequest,
  listObjects as listObjectsRequest,
  getObject as getObjectRequest,
  updateObject as updateObjectRequest,
  deleteObject as deleteObjectRequest,
  upsertObjectByUrn as upsertObjectByUrnRequest,
  publishDomainLocalObject as publishDomainLocalObjectRequest,
  createRelationship as createRelationshipRequest,
  listRelationships as listRelationshipsRequest,
  getRelationship as getRelationshipRequest,
  deleteRelationship as deleteRelationshipRequest,
  graphQuery as graphQueryRequest,
  graphTraverse as graphTraverseRequest,
  graphSubgraph as graphSubgraphRequest,
  graphIntegrity as graphIntegrityRequest,
  doctorReport as doctorReportRequest,
  doctorInstanceReport as doctorInstanceReportRequest,
  pushObjectHealth as pushObjectHealthRequest,
  getObjectHealth as getObjectHealthRequest,
  graphHealth as graphHealthRequest,
  listAuditEvents as listAuditEventsRequest,
  // M2 typed registries (routes/typed-registries.ts) — 8 resources × create/list/get/update/
  // delete/upsertByUrn, generated from BUILD_AND_TEST.md §8 M2 item 1's operationIds.
  createAssembly as createAssemblyRequest,
  listAssemblies as listAssembliesRequest,
  getAssembly as getAssemblyRequest,
  updateAssembly as updateAssemblyRequest,
  deleteAssembly as deleteAssemblyRequest,
  upsertAssemblyByUrn as upsertAssemblyByUrnRequest,
  addAssemblyOwner as addAssemblyOwnerRequest,
  listAssemblyOwners as listAssemblyOwnersRequest,
  removeAssemblyOwner as removeAssemblyOwnerRequest,
  createDomain as createDomainRequest,
  listDomains as listDomainsRequest,
  getDomain as getDomainRequest,
  updateDomain as updateDomainRequest,
  deleteDomain as deleteDomainRequest,
  upsertDomainByUrn as upsertDomainByUrnRequest,
  createService as createServiceRequest,
  listServices as listServicesRequest,
  getService as getServiceRequest,
  updateService as updateServiceRequest,
  deleteService as deleteServiceRequest,
  upsertServiceByUrn as upsertServiceByUrnRequest,
  getServiceBoard as getServiceBoardRequest,
  createComponent as createComponentRequest,
  createPlacement as createPlacementRequest,
  listPlacements as listPlacementsRequest,
  getPlacement as getPlacementRequest,
  deletePlacement as deletePlacementRequest,
  setComponentService as setComponentServiceRequest,
  mergeComponents as mergeComponentsRequest,
  listComponents as listComponentsRequest,
  getComponent as getComponentRequest,
  updateComponent as updateComponentRequest,
  deleteComponent as deleteComponentRequest,
  upsertComponentByUrn as upsertComponentByUrnRequest,
  createDeploymentTarget as createDeploymentTargetRequest,
  listDeploymentTargets as listDeploymentTargetsRequest,
  getDeploymentTarget as getDeploymentTargetRequest,
  updateDeploymentTarget as updateDeploymentTargetRequest,
  deleteDeploymentTarget as deleteDeploymentTargetRequest,
  upsertDeploymentTargetByUrn as upsertDeploymentTargetByUrnRequest,
  createTeam as createTeamRequest,
  listTeams as listTeamsRequest,
  getTeam as getTeamRequest,
  updateTeam as updateTeamRequest,
  deleteTeam as deleteTeamRequest,
  upsertTeamByUrn as upsertTeamByUrnRequest,
  createGroup as createGroupRequest,
  listGroups as listGroupsRequest,
  getGroup as getGroupRequest,
  updateGroup as updateGroupRequest,
  deleteGroup as deleteGroupRequest,
  upsertGroupByUrn as upsertGroupByUrnRequest,
  createUser as createUserRequest,
  listUsers as listUsersRequest,
  getUser as getUserRequest,
  updateUser as updateUserRequest,
  deleteUser as deleteUserRequest,
  upsertUserByUrn as upsertUserByUrnRequest,
  createServiceAccount as createServiceAccountRequest,
  listServiceAccounts as listServiceAccountsRequest,
  getServiceAccount as getServiceAccountRequest,
  updateServiceAccount as updateServiceAccountRequest,
  deleteServiceAccount as deleteServiceAccountRequest,
  upsertServiceAccountByUrn as upsertServiceAccountByUrnRequest,
  // M2 ownership ergonomics (routes/ownership.ts) — owns (4 resources) + consumes/depends_on
  // (services, components).
  addDomainOwner as addDomainOwnerRequest,
  listDomainOwners as listDomainOwnersRequest,
  removeDomainOwner as removeDomainOwnerRequest,
  addServiceOwner as addServiceOwnerRequest,
  listServiceOwners as listServiceOwnersRequest,
  removeServiceOwner as removeServiceOwnerRequest,
  addComponentOwner as addComponentOwnerRequest,
  listComponentOwners as listComponentOwnersRequest,
  removeComponentOwner as removeComponentOwnerRequest,
  addDeploymentTargetOwner as addDeploymentTargetOwnerRequest,
  listDeploymentTargetOwners as listDeploymentTargetOwnersRequest,
  removeDeploymentTargetOwner as removeDeploymentTargetOwnerRequest,
  addServiceConsumes as addServiceConsumesRequest,
  listServiceConsumes as listServiceConsumesRequest,
  removeServiceConsumes as removeServiceConsumesRequest,
  addServiceDependsOn as addServiceDependsOnRequest,
  listServiceDependsOn as listServiceDependsOnRequest,
  removeServiceDependsOn as removeServiceDependsOnRequest,
  addComponentConsumes as addComponentConsumesRequest,
  listComponentConsumes as listComponentConsumesRequest,
  removeComponentConsumes as removeComponentConsumesRequest,
  addComponentDependsOn as addComponentDependsOnRequest,
  listComponentDependsOn as listComponentDependsOnRequest,
  removeComponentDependsOn as removeComponentDependsOnRequest,
  // M2 step 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — PATs + device authorization
  // flow. Generic OIDC has no SDK surface — it's a browser-redirect flow (routes/oidc.ts).
  createPat as createPatRequest,
  listPats as listPatsRequest,
  listRoles as listRolesRequest,
  createRole as createRoleRequest,
  updateRole as updateRoleRequest,
  deleteRole as deleteRoleRequest,
  listRoleBindings as listRoleBindingsRequest,
  createRoleBinding as createRoleBindingRequest,
  deleteRoleBinding as deleteRoleBindingRequest,
  previewRoleBindingGrant as previewRoleBindingGrantRequest,
  getEffectivePermissions as getEffectivePermissionsRequest,
  createOperatorCredential as createOperatorCredentialRequest,
  listOperatorCredentials as listOperatorCredentialsRequest,
  revokeOperatorCredential as revokeOperatorCredentialRequest,
  revokePat as revokePatRequest,
  startDeviceAuth as startDeviceAuthRequest,
  approveDeviceAuth as approveDeviceAuthRequest,
  pollDeviceAuthToken as pollDeviceAuthTokenRequest,
  // M2 step 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
  createPlan as createPlanRequest,
  getPlan as getPlanRequest,
  applyPlan as applyPlanRequest,
  // M3: the Change lifecycle + Decision records (BUILD_AND_TEST.md §8 M3, routes/changes.ts).
  proposeChange as proposeChangeRequest,
  listChanges as listChangesRequest,
  getChange as getChangeRequest,
  explainChange as explainChangeRequest,
  cancelChange as cancelChangeRequest,
  acceptChange as acceptChangeRequest,
  rollbackChange as rollbackChangeRequest,
  listDecisions as listDecisionsRequest,
  getDecision as getDecisionRequest,
  // M3: webhook ingress + source_mappings correlation config (routes/change-sources.ts).
  ingestChangeSourceWebhook as ingestChangeSourceWebhookRequest,
  reportChangeSource as reportChangeSourceRequest,
  getComponentPipeline as getComponentPipelineRequest,
  getComponentScanRequirements as getComponentScanRequirementsRequest,
  createSourceMapping as createSourceMappingRequest,
  deleteSourceMapping as deleteSourceMappingRequest,
  listSourceMappings as listSourceMappingsRequest,
  setSourceMappingEnabled as setSourceMappingEnabledRequest,
  setSourceMappingScope as setSourceMappingScopeRequest,
  // M4 Governance Engine (BUILD_AND_TEST.md §8 M4, routes/typed-registries.ts +
  // routes/governance.ts): Policy/Control typed-registry resources, control bindings/runs,
  // approvals (N-of-M quorum), freezes, and the `scp policy evaluate` dry-run endpoint.
  createPolicy as createPolicyRequest,
  listPolicys as listPoliciesRequest,
  getPolicy as getPolicyRequest,
  updatePolicy as updatePolicyRequest,
  deletePolicy as deletePolicyRequest,
  upsertPolicyByUrn as upsertPolicyByUrnRequest,
  createControl as createControlRequest,
  listControls as listControlsRequest,
  getControl as getControlRequest,
  updateControl as updateControlRequest,
  deleteControl as deleteControlRequest,
  upsertControlByUrn as upsertControlByUrnRequest,
  putControlBinding as putControlBindingRequest,
  listChangeControlRuns as listChangeControlRunsRequest,
  listControlRunFindings as listControlRunFindingsRequest,
  listApprovals as listApprovalsRequest,
  getApproval as getApprovalRequest,
  listApprovalVotes as listApprovalVotesRequest,
  castApprovalVote as castApprovalVoteRequest,
  createFreeze as createFreezeRequest,
  listFreezes as listFreezesRequest,
  getFreeze as getFreezeRequest,
  liftFreeze as liftFreezeRequest,
  updateFreezeWindow as updateFreezeWindowRequest,
  policyEvaluate as policyEvaluateRequest,
  // M5: Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN §9.5).
  proposeCampaign as proposeCampaignRequest,
  listCampaigns as listCampaignsRequest,
  getCampaign as getCampaignRequest,
  explainCampaign as explainCampaignRequest,
  campaignAdoption as campaignAdoptionRequest,
  rollbackCampaign as rollbackCampaignRequest,
  // M25.6a (owner decision D4) — the deadline's set/move/CLEAR verb.
  setCampaignDeadline as setCampaignDeadlineRequest,
  // M25.6b (§4.5) — the per-target waiver of that deadline.
  overrideCampaignDeadline as overrideCampaignDeadlineRequest,
  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN §13).
  initFederation as initFederationRequest,
  getFederationSelf as getFederationSelfRequest,
  listFederationPeers as listFederationPeersRequest,
  // M17.5 (ADR-0016) — instance-scoped scan-requirement floors.
  listInstanceScanFloors as listInstanceScanFloorsRequest,
  putInstanceScanFloor as putInstanceScanFloorRequest,
  // M25.3 (campaigns-rework §2, owner decision D1) — instance-scoped (platform) freezes.
  listInstanceFreezes as listInstanceFreezesRequest,
  putInstanceFreeze as putInstanceFreezeRequest,
  liftInstanceFreeze as liftInstanceFreezeRequest,
  // M22.9 (ADR-0033 §1/§7a) — instance-scoped exclusion admissions.
  listInstanceScanExclusionAdmissions as listInstanceScanExclusionAdmissionsRequest,
  putInstanceScanExclusionAdmissions as putInstanceScanExclusionAdmissionsRequest,
  // M22.6 (ADR-0033 §6a) — standing, expiring scan override grants.
  createScanOverrideGrant as createScanOverrideGrantRequest,
  listScanOverrideGrants as listScanOverrideGrantsRequest,
  approveScanOverrideGrant as approveScanOverrideGrantRequest,
  denyScanOverrideGrant as denyScanOverrideGrantRequest,
  revokeScanOverrideGrant as revokeScanOverrideGrantRequest,
  // M13.3a (ADR-0020) — instance-scoped scanner assignments.
  listScannerAssignments as listScannerAssignmentsRequest,
  putScannerAssignment as putScannerAssignmentRequest,
  // M13.3b-ii (ADR-0020) — offline scanner-DB cache.
  getScanDbStatus as getScanDbStatusRequest,
  getScanDbStalenessPolicy as getScanDbStalenessPolicyRequest,
  putScanDbStalenessPolicy as putScanDbStalenessPolicyRequest,
  refreshScanDb as refreshScanDbRequest,
  loadScanDb as loadScanDbRequest,
  // M21.3 (ADR-0032 §3a/§6) — the dependency-subscription enablement chain.
  getDependencySubscriptionUnlock as getDependencySubscriptionUnlockRequest,
  putDependencySubscriptionUnlock as putDependencySubscriptionUnlockRequest,
  getObjectGovernanceMoveEnforcement as getObjectGovernanceMoveEnforcementRequest,
  listGovernanceMoveRungs as listGovernanceMoveRungsRequest,
  enableGovernanceMoveRung as enableGovernanceMoveRungRequest,
  disableGovernanceMoveRung as disableGovernanceMoveRungRequest,
  getGovernanceMoveInstanceRung as getGovernanceMoveInstanceRungRequest,
  putGovernanceMoveInstanceRung as putGovernanceMoveInstanceRungRequest,
  getComponentDependencySubscription as getComponentDependencySubscriptionRequest,
  // M21.2 (ADR-0032 §4) — the inventory backfill.
  backfillDependencyInventory as backfillDependencyInventoryRequest,
  // M21.6 — the component-scoped dependency READ surface (inventory + bumps).
  listComponentDependencyInventory as listComponentDependencyInventoryRequest,
  listComponentDependencyBumps as listComponentDependencyBumpsRequest,
  // ADR-0032 §7e — the producer declaration's authoring surface.
  declareDependencyLineProducer as declareDependencyLineProducerRequest,
  retractDependencyLineProducer as retractDependencyLineProducerRequest,
  listDependencyLineProducers as listDependencyLineProducersRequest,
  pairPeer as pairPeerRequest,
  // M16.2 phase A — E4's narrow peer read/PATCH and E1's `outpost` config object.
  getFederationPeer as getFederationPeerRequest,
  updateFederationPeer as updateFederationPeerRequest,
  federationResyncPeer as federationResyncPeerRequest,
  createOutpostConfig as createOutpostConfigRequest,
  listOutpostConfigs as listOutpostConfigsRequest,
  getOutpostConfig as getOutpostConfigRequest,
  updateOutpostConfig as updateOutpostConfigRequest,
  reconcileOutpostConfig as reconcileOutpostConfigRequest,
  getFederationStatus as getFederationStatusRequest,
  exportSyncBundle as exportSyncBundleRequest,
  exportPromotionBundle as exportPromotionBundleRequest,
  importBundle as importBundleRequest,
  // M15.5(c) — the retrans validate-then-relay (ADR-0019 §2).
  buildRelayTarball as buildRelayTarballRequest,
  importRelayTarball as importRelayTarballRequest,
  // M13.1b — the auto-relay build ledger's operator read surface (owner ask).
  listFederationRelayBuilds as listFederationRelayBuildsRequest,
  // Federation audit witness (multi-region-instance-resilience.md §7.2.7) — the post-failover
  // peers-witness comparison's read surface (resilience runbook §7.2 step 5).
  listFederationAuditWitnesses as listFederationAuditWitnessesRequest,
  createOverlay as createOverlayRequest,
  getMergedOverlayView as getMergedOverlayViewRequest,
  handFillObject as handFillObjectRequest,
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12).
  putChangeSourceWebhookSecret as putChangeSourceWebhookSecretRequest,
  putExecutorBinding as putExecutorBindingRequest,
  getExecutorBinding as getExecutorBindingRequest,
  listExecutorBindings as listExecutorBindingsRequest,
  deleteExecutorBinding as deleteExecutorBindingRequest,
  repurposeExecutorBinding as repurposeExecutorBindingRequest,
  getRegionalExecutors as getRegionalExecutorsRequest,
  putNotificationBinding as putNotificationBindingRequest,
  listNotificationBindings as listNotificationBindingsRequest,
  deleteNotificationBinding as deleteNotificationBindingRequest,
  putSecret as putSecretRequest,
  listSecretKeys as listSecretKeysRequest,
  deleteSecret as deleteSecretRequest,
  listPluginManifests as listPluginManifestsRequest,
  runDiscovery as runDiscoveryRequest,
  scaffoldDiscoveryProposal as scaffoldDiscoveryProposalRequest,
  // The live event stream (`GET /events/stream`) — a generated SSE operation like any other
  // generated operation, `responseValidator` included, since the SSE API-parity work declared it
  // in the contract.
  streamEvents as streamEventsRequest
} from "./generated/sdk.gen.js";
import type {
  ApplyPlanResponse,
  AuditEvent,
  AuditEventListResponse,
  AuthConfig,
  CreateObjectRequest,
  CreateComponentRequest,
  CreatePlacementRequest,
  UpsertComponentRequest,
  MergeComponentsResponse,
  CreateObjectTypeRequest,
  CreateRelationshipRequest,
  CreateRelationshipTypeRequest,
  CreatePatResponse,
  CurrentUser,
  DesiredStateManifest,
  DeviceApproveResponse,
  DeviceStartResponse,
  GraphObject,
  DoctorReport,
  GraphIntegrityReport,
  GraphQueryResult,
  NamedGraphQuery,
  ObjectListResponse,
  ObjectType,
  ObjectTypeListResponse,
  Pat,
  PatListResponse,
  Plan,
  Relationship,
  RelationshipListResponse,
  RelationshipType,
  RelationshipTypeListResponse,
  ServiceObject,
  ServiceObjectListResponse,
  SubgraphResult,
  HealthRecord,
  HealthBatchResult,
  PushHealthRequest,
  TraverseResult,
  UpdateObjectRequest,
  UpsertObjectRequest,
  PublishObjectResponse,
  // M3: the Change lifecycle + Decision records + change sources (BUILD_AND_TEST.md §8 M3).
  Change,
  ChangeListResponse,
  ChangeListQuery,
  ChangeExplainResponse,
  CreateChangeRequest,
  Decision,
  DecisionListResponse,
  DecisionListQuery,
  ComponentPipelineResponse,
  ComponentScanRequirementsResponse,
  CreateSourceMappingRequest,
  DeleteSourceMappingRequest,
  DeleteSourceMappingResponse,
  ChangeReportRequest,
  SourceMapping,
  SourceMappingListResponse,
  SourceMappingScope,
  WebhookIngressResponse,
  // M4 Governance Engine (BUILD_AND_TEST.md §8 M4).
  ControlBinding,
  CreateControlBindingRequest,
  ControlRunListResponse,
  ControlRunFindingsResponse,
  CursorPageQuery,
  ApprovalRequest,
  ApprovalRequestListQuery,
  ApprovalRequestListResponse,
  ApprovalVote,
  CastApprovalVoteRequest,
  Freeze,
  CreateFreezeRequest,
  LiftFreezeRequest,
  UpdateFreezeWindowRequest,
  FreezeListResponse,
  PolicyEvaluateResponse,
  // M5: Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN §9.5).
  Campaign,
  CampaignListQuery,
  CampaignListResponse,
  CampaignExplainResponse,
  CampaignAdoptionResponse,
  CampaignDeadlineInput,
  OverrideCampaignDeadlineRequest,
  CreateCampaignRequest,
  RollbackCampaignResponse,
  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN §13).
  FederationSelfInfo,
  InitFederationRequest,
  FederationPeer,
  FederationResyncResult,
  InstanceScanFloor,
  InstanceFreeze,
  PutInstanceFreezeRequest,
  LiftInstanceFreezeRequest,
  InstanceScanExclusionAdmission,
  PutInstanceScanExclusionAdmissionsRequest,
  ScanOverrideGrant,
  CreateScanOverrideGrantRequest,
  ApproveScanOverrideGrantRequest,
  DecideScanOverrideGrantRequest,
  PutInstanceScanFloorRequest,
  ScannerAssignment,
  PutScannerAssignmentRequest,
  // M13.3b-ii (ADR-0020) — offline scanner-DB cache.
  ScanDbStatus,
  ScanDbStalenessPolicy,
  PutScanDbStalenessPolicyRequest,
  RefreshScanDbResponse,
  LoadScanDbRequest,
  LoadScanDbResponse,
  // M21.3 (ADR-0032 §3a/§6) — the dependency-subscription enablement chain.
  DependencyLineKey,
  DependencySubscriptionUnlock,
  GovernanceMoveEnforcement,
  GovernanceMoveRungList,
  GovernanceMoveRungWriteResponse,
  GovernanceMoveInstanceRung,
  PutGovernanceMoveRungRequest,
  PutGovernanceMoveInstanceRungRequest,
  DependencySubscriptionResolutionResponse,
  PutDependencySubscriptionUnlockRequest,
  // M21.2 (ADR-0032 §4) — the inventory backfill.
  BackfillDependencyInventoryRequest,
  BackfillDependencyInventoryResponse,
  // M21.6 — the component-scoped dependency READ surface.
  ComponentDependencyInventoryResponse,
  ComponentDependencyBumpsResponse,
  // ADR-0032 §7e — the producer declaration's authoring surface.
  DeclareDependencyLineProducerRequest,
  RetractDependencyLineProducerRequest,
  DependencyLineProducerVerbResponse,
  ListDependencyLineProducersQuery,
  ListDependencyLineProducersResponse,
  PairPeerRequest,
  // M16.2 phase A — the narrow peer PATCH (E4) + the `outpost` config object (E1).
  UpdateFederationPeerRequest,
  CreateOutpostConfigRequest,
  UpdateOutpostConfigRequest,
  OutpostConfig,
  OutpostConfigReconcileResult,
  FederationStatusResponse,
  ExportJournalRequest,
  SyncBundle,
  ExportPromotionRequest,
  PromotionBundle,
  ImportBundleRequest,
  ImportResult,
  HandFillRequest,
  // M15.5(c) — the retrans validate-then-relay (ADR-0019 §2).
  RelayBuildRequest,
  RelayBuildResponse,
  RelayImportRequest,
  RelayImportResponse,
  // M13.1b — the auto-relay build ledger's operator read surface (owner ask).
  RelayBuild,
  RelayBuildStatus,
  // Federation audit witness (multi-region-instance-resilience.md §7.2.7) — the post-failover
  // peers-witness comparison's read surface (resilience runbook §7.2 step 5).
  AuditWitness,
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12).
  CreateWebhookSecretRequest,
  WebhookSecretConfiguredResponse,
  CreateExecutorBindingRequest,
  ExecutorBinding,
  ExecutorType,
  RegionalExecutorView,
  CreateNotificationBindingRequest,
  NotificationBinding,
  NotificationBindingListResponse,
  PutSecretRequest,
  SecretConfiguredResponse,
  SecretKeyListResponse,
  PluginManifestListResponse,
  RunDiscoveryRequest,
  ScaffoldDiscoveryRequest,
  ScaffoldDiscoveryResponse,
  DiscoveryProposal,
  ServiceBoardResponse,
  RelayedEvent,
  Role,
  RoleListResponse,
  CreateRoleRequest,
  UpdateRoleRequest,
  DeleteRoleRequest,
  RoleBinding,
  RoleBindingListResponse,
  CreateRoleBindingRequest,
  DeleteRoleBindingRequest,
  GrantPreviewResponse,
  EffectivePermissionsResponse,
  CreateOperatorCredentialRequest,
  CreatedOperatorCredential,
  OperatorCredentialListResponse
} from "@scp/schemas";
import { ScpApiError, ScpResponseValidationError } from "./errors.js";
import { installResponseValidationErrors } from "./response-validation.js";
import { resilientEventStream, type EventStreamOptions } from "./event-stream.js";

export interface ScpClientOptions {
  /** e.g. http://localhost:8080/api/v1 */
  baseUrl: string;
  token?: string;
}

interface ApiResult<TData> {
  data?: TData;
  error?: unknown;
  response?: Response;
}

function unwrap<TData>(result: ApiResult<TData>): TData {
  if (result.error !== undefined) {
    // ADR-0023 — a 2xx body that doesn't match the OpenAPI contract already carries the operation
    // and the offending field(s); wrapping it in a generic `ScpApiError` would destroy exactly the
    // diagnosis it exists to provide.
    if (result.error instanceof ScpResponseValidationError) throw result.error;
    const problem = result.error as { title?: string; status?: number } & Record<string, unknown>;
    throw new ScpApiError(problem.title ?? "CommanderSCP API error", {
      status: typeof problem.status === "number" ? problem.status : result.response?.status,
      problem: problem as never
    });
  }
  if (result.data === undefined) {
    throw new ScpApiError(`empty response body (HTTP ${result.response?.status ?? "unknown"})`, {
      status: result.response?.status
    });
  }
  return result.data;
}

/** Like `unwrap`, but for genuinely body-less 2xx responses (e.g. `logout`'s 204) — `result.data`
 * is expected to be `undefined` on success, so `unwrap`'s "empty response body" check would
 * incorrectly reject it. */
function unwrapVoid(result: ApiResult<unknown>): void {
  if (result.error !== undefined) {
    if (result.error instanceof ScpResponseValidationError) throw result.error;
    const problem = result.error as { title?: string; status?: number } & Record<string, unknown>;
    throw new ScpApiError(problem.title ?? "CommanderSCP API error", {
      status: typeof problem.status === "number" ? problem.status : result.response?.status,
      problem: problem as never
    });
  }
}

export interface ListServiceObjectsQuery {
  cursor?: string;
  limit?: number;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  org: string;
}

export interface ListQuery {
  cursor?: string;
  limit?: number;
}

export interface ListObjectsQuery extends ListQuery {
  domainId?: string;
  includeDeleted?: boolean;
}

/** Wire-INPUT shape (pre-defaults) — the schema's `PlacementListQuery` is the parsed output type. */
export interface ListPlacementsQuery extends ListObjectsQuery {
  component?: string;
  deploymentTarget?: string;
}

export interface ListRelationshipsQuery extends ListQuery {
  fromId?: string;
  toId?: string;
  typeId?: string;
}

export interface GraphQueryParams {
  objectId: string;
  targetId?: string;
  relTypes?: string[];
  maxDepth?: number;
}

export interface TraverseParams {
  objectId: string;
  direction?: "out" | "in" | "both";
  relTypes?: string[];
  maxDepth?: number;
}

export interface SubgraphParams {
  objectId: string;
  ids: string[];
}

export interface HealthBatchParams {
  /** Exploration root — scopes `graph:query` authorization, identical to `SubgraphParams`. */
  objectId: string;
  ids: string[];
}

function idempotencyHeaders(idempotencyKey?: string): Record<string, string> | undefined {
  return idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
}

// ---------------------------------------------------------------------------------------------
// M2 typed registries (DESIGN.md — BUILD_AND_TEST.md §8 M2 item 1). All 8 resources share the
// exact same generic request/response shapes (CreateObjectRequest/.../ObjectListResponse) — the
// generated per-resource functions (createDomain, createService, ...) differ only by which
// operationId/URL they call, so `ScpClient.typedResource` below is a single generic wrapper
// invoked once per resource instead of 8 hand-copies of the same 6 methods, mirroring
// routes/typed-registries.ts's server-side route factory. `ownerMethods`/`edgeMethods` do the
// same for the `owns`/`consumes`/`depends_on` sub-resource ergonomics (routes/ownership.ts).
// ---------------------------------------------------------------------------------------------

interface TypedObjectFns<C = CreateObjectRequest, U = UpsertObjectRequest> {
  create: (opts: {
    client: Client;
    body: C;
    headers?: Record<string, string>;
  }) => Promise<ApiResult<GraphObject>>;
  list: (opts: {
    client: Client;
    query: ListObjectsQuery;
  }) => Promise<ApiResult<ObjectListResponse>>;
  get: (opts: { client: Client; path: { idOrUrn: string } }) => Promise<ApiResult<GraphObject>>;
  update: (opts: {
    client: Client;
    path: { idOrUrn: string };
    body: UpdateObjectRequest;
  }) => Promise<ApiResult<GraphObject>>;
  del: (opts: { client: Client; path: { idOrUrn: string } }) => Promise<ApiResult<GraphObject>>;
  upsert: (opts: {
    client: Client;
    path: { urn: string };
    body: U;
  }) => Promise<ApiResult<GraphObject>>;
}

interface OwnerFns {
  add: (opts: {
    client: Client;
    path: { idOrUrn: string };
    body: { ownerIdOrUrn: string };
    headers?: Record<string, string>;
  }) => Promise<ApiResult<Relationship>>;
  list: (opts: {
    client: Client;
    path: { idOrUrn: string };
    query: ListQuery;
  }) => Promise<ApiResult<RelationshipListResponse>>;
  remove: (opts: {
    client: Client;
    path: { idOrUrn: string; ownerIdOrUrn: string };
  }) => Promise<ApiResult<Relationship>>;
}

interface EdgeFns {
  add: (opts: {
    client: Client;
    path: { idOrUrn: string };
    body: { targetIdOrUrn: string };
    headers?: Record<string, string>;
  }) => Promise<ApiResult<Relationship>>;
  list: (opts: {
    client: Client;
    path: { idOrUrn: string };
    query: ListQuery;
  }) => Promise<ApiResult<RelationshipListResponse>>;
  remove: (opts: {
    client: Client;
    path: { idOrUrn: string; targetIdOrUrn: string };
  }) => Promise<ApiResult<Relationship>>;
}

/**
 * Thin handwritten layer over the `@hey-api/openapi-ts` generated core (DESIGN.md §15): token
 * management (auth), a cursor-pagination iterator, and ergonomic namespaces over the M1 graph
 * endpoints (type registry, generic objects-of-any-type, relationships, named graph queries,
 * audit events). The CLI and the server-rendered UI stub consume only this class — never a raw
 * `fetch` to the API, and every write that accepts an `Idempotency-Key` here too.
 */
export class ScpClient {
  private readonly client: Client;
  private token: string | undefined;

  constructor(options: ScpClientOptions) {
    this.token = options.token;
    this.client = createClient(
      createConfig({
        baseUrl: options.baseUrl,
        // Every generated operation declares `security: [{ scheme: 'bearer', ... }]`; this
        // resolver is consulted automatically to set the Authorization header.
        auth: () => this.token
      })
    );
    // ADR-0023 — every generated operation carries a `responseValidator`; this turns a rejection
    // from any of them into one `ScpResponseValidationError` naming operation + field. Registered
    // once, on the single client every operation flows through, so no call site can miss it.
    installResponseValidationErrors(this.client);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const result = await loginRequest({ client: this.client, body: { username, password } });
    const data = unwrap(result);
    this.token = data.token;
    return data;
  }

  // -----------------------------------------------------------------------------------------
  // Web UI v1 session discovery (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2) — `login()` above
  // stays where every existing caller (CLI, tests) already expects it; these three are new and
  // namespaced so they read as a group at call sites (`client.auth.me()`, etc).
  // -----------------------------------------------------------------------------------------

  readonly auth = {
    /** `GET /auth/me` — how the Web UI discovers "am I logged in" (it can't read the httpOnly
     * `scp_session` cookie itself). 401s (via `unwrap`) if there's no live session/token. */
    me: async (): Promise<CurrentUser> => {
      const result = await getCurrentUserRequest({ client: this.client });
      return unwrap(result) as CurrentUser;
    },
    /** `POST /auth/logout` — ends the calling session; no-op for PAT auth (routes/auth.ts). */
    logout: async (): Promise<void> => {
      const result = await logoutRequest({ client: this.client });
      unwrapVoid(result);
    },
    /** `GET /auth/config` — public, no auth required. */
    config: async (): Promise<AuthConfig> => {
      const result = await getAuthConfigRequest({ client: this.client });
      return unwrap(result) as AuthConfig;
    }
  };

  // M0 legacy /objects/service (unchanged contract — DESIGN.md additive-only-within-v1)

  readonly objects = {
    service: {
      create: async (name: string, opts: { org?: string } = {}): Promise<ServiceObject> => {
        if (opts.org) {
          const result = await createServiceObjectForOrgRequest({
            client: this.client,
            path: { org: opts.org },
            body: { name }
          });
          return unwrap(result) as ServiceObject;
        }
        const result = await createServiceObjectRequest({ client: this.client, body: { name } });
        return unwrap(result) as ServiceObject;
      },

      list: async (
        query: ListServiceObjectsQuery = {},
        opts: { org?: string } = {}
      ): Promise<ServiceObjectListResponse> => {
        if (opts.org) {
          const result = await listServiceObjectsForOrgRequest({
            client: this.client,
            path: { org: opts.org },
            query
          });
          return unwrap(result) as ServiceObjectListResponse;
        }
        const result = await listServiceObjectsRequest({ client: this.client, query });
        return unwrap(result) as ServiceObjectListResponse;
      }
    }
  };

  /** Pagination iterator (DESIGN.md §15) — walks every page via cursor. */
  async *listAllServiceObjects(
    query: Omit<ListServiceObjectsQuery, "cursor"> = {},
    opts: { org?: string } = {}
  ): AsyncGenerator<ServiceObject, void, void> {
    let cursor: string | undefined;
    do {
      const page = await this.objects.service.list({ ...query, cursor }, opts);
      for (const item of page.items) yield item;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  // Runtime type registry (DESIGN.md §4.1)

  readonly typeRegistry = {
    objectTypes: {
      create: async (
        req: CreateObjectTypeRequest,
        opts: { idempotencyKey?: string } = {}
      ): Promise<ObjectType> => {
        const result = await createObjectTypeRequest({
          client: this.client,
          body: req,
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      list: async (query: ListQuery = {}): Promise<ObjectTypeListResponse> => {
        const result = await listObjectTypesRequest({ client: this.client, query });
        return unwrap(result);
      }
    },
    relationshipTypes: {
      create: async (
        req: CreateRelationshipTypeRequest,
        opts: { idempotencyKey?: string } = {}
      ): Promise<RelationshipType> => {
        const result = await createRelationshipTypeRequest({
          client: this.client,
          body: req,
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      list: async (query: ListQuery = {}): Promise<RelationshipTypeListResponse> => {
        const result = await listRelationshipTypesRequest({ client: this.client, query });
        return unwrap(result);
      }
    }
  };

  // -----------------------------------------------------------------------------------------
  // Generic /objects/{type} — works for ANY registered type, built-in or org-defined
  // (BUILD_AND_TEST.md §8 M1 DoD (b): usable through the SDK with no code changes).
  // -----------------------------------------------------------------------------------------

  /** Returns a small ergonomic client scoped to one object type, e.g. `client.object("service")`. */
  object(type: string) {
    return {
      create: async (
        req: CreateObjectRequest,
        opts: { idempotencyKey?: string } = {}
      ): Promise<GraphObject> => {
        const result = await createObjectRequest({
          client: this.client,
          path: { type },
          body: req,
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      list: async (query: ListObjectsQuery = {}): Promise<ObjectListResponse> => {
        const result = await listObjectsRequest({ client: this.client, path: { type }, query });
        return unwrap(result);
      },
      get: async (idOrUrn: string): Promise<GraphObject> => {
        const result = await getObjectRequest({ client: this.client, path: { type, idOrUrn } });
        return unwrap(result);
      },
      update: async (idOrUrn: string, req: UpdateObjectRequest): Promise<GraphObject> => {
        const result = await updateObjectRequest({
          client: this.client,
          path: { type, idOrUrn },
          body: req
        });
        return unwrap(result);
      },
      delete: async (idOrUrn: string): Promise<GraphObject> => {
        const result = await deleteObjectRequest({ client: this.client, path: { type, idOrUrn } });
        return unwrap(result);
      },
      upsertByUrn: async (urn: string, req: UpsertObjectRequest): Promise<GraphObject> => {
        const result = await upsertObjectByUrnRequest({
          client: this.client,
          path: { type, urn },
          body: req
        });
        return unwrap(result);
      },
      /**
       * M20.4 (ADR-0031 §6) — publish a domain-local object so it federates from this point on.
       *
       * ONE-WAY: there is no inverse method and there will not be one, because federation has no
       * un-send. The response reports the edge sweep in two buckets — edges published alongside the
       * object, and edges deliberately withheld because their other endpoint is still domain-local.
       */
      publish: async (idOrUrn: string): Promise<PublishObjectResponse> => {
        const result = await publishDomainLocalObjectRequest({
          client: this.client,
          path: { type, idOrUrn }
        });
        return unwrap(result);
      }
    };
  }

  async *listAllObjects(
    type: string,
    query: Omit<ListObjectsQuery, "cursor"> = {}
  ): AsyncGenerator<GraphObject> {
    let cursor: string | undefined;
    do {
      const page = await this.object(type).list({ ...query, cursor });
      for (const item of page.items) yield item;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  readonly relationships = {
    create: async (
      req: CreateRelationshipRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<Relationship> => {
      const result = await createRelationshipRequest({
        client: this.client,
        body: req,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    list: async (query: ListRelationshipsQuery = {}): Promise<RelationshipListResponse> => {
      const result = await listRelationshipsRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (id: string): Promise<Relationship> => {
      const result = await getRelationshipRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    delete: async (id: string): Promise<Relationship> => {
      const result = await deleteRelationshipRequest({ client: this.client, path: { id } });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M2 typed registries: friendlier ergonomic namespaces over the fixed-type endpoints
  // (BUILD_AND_TEST.md §8 M2 item 1) — same generic request/response contract as `object(type)`,
  // just resource-specific and without a `type` argument to pass at every call site.
  // -----------------------------------------------------------------------------------------

  private typedResource<C = CreateObjectRequest, U = UpsertObjectRequest>(
    fns: TypedObjectFns<C, U>
  ) {
    return {
      create: async (req: C, opts: { idempotencyKey?: string } = {}): Promise<GraphObject> => {
        const result = await fns.create({
          client: this.client,
          body: req,
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      list: async (query: ListObjectsQuery = {}): Promise<ObjectListResponse> => {
        const result = await fns.list({ client: this.client, query });
        return unwrap(result);
      },
      get: async (idOrUrn: string): Promise<GraphObject> => {
        const result = await fns.get({ client: this.client, path: { idOrUrn } });
        return unwrap(result);
      },
      update: async (idOrUrn: string, req: UpdateObjectRequest): Promise<GraphObject> => {
        const result = await fns.update({ client: this.client, path: { idOrUrn }, body: req });
        return unwrap(result);
      },
      delete: async (idOrUrn: string): Promise<GraphObject> => {
        const result = await fns.del({ client: this.client, path: { idOrUrn } });
        return unwrap(result);
      },
      upsertByUrn: async (urn: string, req: U): Promise<GraphObject> => {
        const result = await fns.upsert({ client: this.client, path: { urn }, body: req });
        return unwrap(result);
      }
    };
  }

  private ownerMethods(fns: OwnerFns) {
    return {
      addOwner: async (
        idOrUrn: string,
        ownerIdOrUrn: string,
        opts: { idempotencyKey?: string } = {}
      ): Promise<Relationship> => {
        const result = await fns.add({
          client: this.client,
          path: { idOrUrn },
          body: { ownerIdOrUrn },
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      listOwners: async (
        idOrUrn: string,
        query: ListQuery = {}
      ): Promise<RelationshipListResponse> => {
        const result = await fns.list({ client: this.client, path: { idOrUrn }, query });
        return unwrap(result);
      },
      removeOwner: async (idOrUrn: string, ownerIdOrUrn: string): Promise<Relationship> => {
        const result = await fns.remove({ client: this.client, path: { idOrUrn, ownerIdOrUrn } });
        return unwrap(result);
      }
    };
  }

  /** `.add()/.list()/.remove()` for one edge type (`consumes` or `depends_on`) — callers rename per resource. */
  private edgeMethods(fns: EdgeFns) {
    return {
      add: async (
        idOrUrn: string,
        targetIdOrUrn: string,
        opts: { idempotencyKey?: string } = {}
      ): Promise<Relationship> => {
        const result = await fns.add({
          client: this.client,
          path: { idOrUrn },
          body: { targetIdOrUrn },
          headers: idempotencyHeaders(opts.idempotencyKey)
        });
        return unwrap(result);
      },
      list: async (idOrUrn: string, query: ListQuery = {}): Promise<RelationshipListResponse> => {
        const result = await fns.list({ client: this.client, path: { idOrUrn }, query });
        return unwrap(result);
      },
      remove: async (idOrUrn: string, targetIdOrUrn: string): Promise<Relationship> => {
        const result = await fns.remove({
          client: this.client,
          path: { idOrUrn, targetIdOrUrn }
        });
        return unwrap(result);
      }
    };
  }

  /** The OPTIONAL level between a service and its components (migration 0055). Ownable, like a
   *  service; deliberately WITHOUT edge methods — `consumes`/`depends_on` describe things that call
   *  each other, and an assembly does not make a request (migration 0055's census). */
  readonly assemblies = {
    ...this.typedResource({
      create: createAssemblyRequest,
      list: listAssembliesRequest,
      get: getAssemblyRequest,
      update: updateAssemblyRequest,
      del: deleteAssemblyRequest,
      upsert: upsertAssemblyByUrnRequest
    }),
    ...this.ownerMethods({
      add: addAssemblyOwnerRequest,
      list: listAssemblyOwnersRequest,
      remove: removeAssemblyOwnerRequest
    })
  };

  readonly domains = {
    ...this.typedResource({
      create: createDomainRequest,
      list: listDomainsRequest,
      get: getDomainRequest,
      update: updateDomainRequest,
      del: deleteDomainRequest,
      upsert: upsertDomainByUrnRequest
    }),
    ...this.ownerMethods({
      add: addDomainOwnerRequest,
      list: listDomainOwnersRequest,
      remove: removeDomainOwnerRequest
    })
  };

  readonly services = (() => {
    const consumes = this.edgeMethods({
      add: addServiceConsumesRequest,
      list: listServiceConsumesRequest,
      remove: removeServiceConsumesRequest
    });
    const dependsOn = this.edgeMethods({
      add: addServiceDependsOnRequest,
      list: listServiceDependsOnRequest,
      remove: removeServiceDependsOnRequest
    });
    return {
      ...this.typedResource({
        create: createServiceRequest,
        list: listServicesRequest,
        get: getServiceRequest,
        update: updateServiceRequest,
        del: deleteServiceRequest,
        upsert: upsertServiceByUrnRequest
      }),
      ...this.ownerMethods({
        add: addServiceOwnerRequest,
        list: listServiceOwnersRequest,
        remove: removeServiceOwnerRequest
      }),
      addConsumes: consumes.add,
      listConsumes: consumes.list,
      removeConsumes: consumes.remove,
      addDependsOn: dependsOn.add,
      listDependsOn: dependsOn.list,
      removeDependsOn: dependsOn.remove,
      /**
       * The service release board (coordination-ui-views.md Phase 2, Layer A) — the service's
       * components, each's latest change per-wave status + attention, and a releasing/blocked/
       * stable summary, projected server-side in one call. Read-only.
       *
       * (ADR-0021 D6 residual: this line said "per-stage wave status" until 2026-07-25 — a leftover
       * of the wave-sense misuse of "stage". The field it describes is `waves`; the (iii-b) rename
       * moved the field but missed this caption.)
       */
      board: async (idOrUrn: string): Promise<ServiceBoardResponse> => {
        const result = await getServiceBoardRequest({ client: this.client, path: { idOrUrn } });
        return unwrap(result);
      }
    };
  })();

  readonly components = (() => {
    const consumes = this.edgeMethods({
      add: addComponentConsumesRequest,
      list: listComponentConsumesRequest,
      remove: removeComponentConsumesRequest
    });
    const dependsOn = this.edgeMethods({
      add: addComponentDependsOnRequest,
      list: listComponentDependsOnRequest,
      remove: removeComponentDependsOnRequest
    });
    return {
      ...this.typedResource<CreateComponentRequest, UpsertComponentRequest>({
        create: createComponentRequest,
        list: listComponentsRequest,
        get: getComponentRequest,
        update: updateComponentRequest,
        del: deleteComponentRequest,
        upsert: upsertComponentByUrnRequest
      }),
      /** THE COMPONENT'S PIPELINE — its stages (placements), what executes at each, and what last
       *  released there. Well-defined for a component that has never released, which is the whole
       *  point: the change-anchored surface it replaces could not represent one at all. */
      pipeline: async (idOrUrn: string): Promise<ComponentPipelineResponse> => {
        const result = await getComponentPipelineRequest({
          client: this.client,
          path: { idOrUrn }
        });
        return unwrap(result);
      },
      /** M22.8 — THE SCAN RULES IN FORCE FOR THIS COMPONENT: the resolved six-tier severity ceiling
       *  with every tier that contributed to it (ADR-0016), plus which exclusion classes the tiers
       *  above admit and at which tiers a clause of each would actually take effect (ADR-0033 §1).
       *
       *  READS ONLY — it writes no Decision, which is exactly why it exists beside `policyEvaluate`
       *  rather than being folded into it. `policyEvaluate` runs the real orchestrator and writes a
       *  Decision row per call with no suppression, so polling it from a UI reproduces the
       *  1.44 GB/day amplification ADR-0024 §D0 exists over. Poll THIS one. */
      scanRequirements: async (idOrUrn: string): Promise<ComponentScanRequirementsResponse> => {
        const result = await getComponentScanRequirementsRequest({
          client: this.client,
          path: { idOrUrn }
        });
        return unwrap(result);
      },
      ...this.ownerMethods({
        add: addComponentOwnerRequest,
        list: listComponentOwnersRequest,
        remove: removeComponentOwnerRequest
      }),
      addConsumes: consumes.add,
      listConsumes: consumes.list,
      removeConsumes: consumes.remove,
      addDependsOn: dependsOn.add,
      listDependsOn: dependsOn.list,
      removeDependsOn: dependsOn.remove,
      /**
       * Assign or move a component into a service (M12 P5b) — idempotent: sets the component's sole
       * `contains` parent whether it has none (assign), a different one (atomic move), or the same
       * one (no-op). Closes the missing `contains` SDK helper.
       */
      setService: async (idOrUrn: string, serviceIdOrUrn: string): Promise<GraphObject> => {
        const result = await setComponentServiceRequest({
          client: this.client,
          path: { idOrUrn },
          body: { service: serviceIdOrUrn }
        });
        return unwrap(result);
      },
      /**
       * Merge `loserIdOrUrn` into `survivorIdOrUrn` (M12 P5d) — moves the loser's executor bindings
       * onto the survivor and soft-deletes the loser. Rejects (409) on a binding-type collision
       * (relabel one first) or if either component has an in-flight change / live graph edges.
       */
      merge: async (
        survivorIdOrUrn: string,
        loserIdOrUrn: string
      ): Promise<MergeComponentsResponse> => {
        const result = await mergeComponentsRequest({
          client: this.client,
          path: { idOrUrn: survivorIdOrUrn },
          body: { loser: loserIdOrUrn }
        });
        return unwrap(result);
      }
    };
  })();

  /**
   * Placements — one component at one deployment target (ADR-0026). Declared, never inferred: there
   * is no "pair these by name" helper here and there must not be one (D8).
   *
   * No `update`: a placement's endpoints ARE its identity, so changing one is a new declaration, not
   * an edit (see `routes/placements.ts`).
   */
  readonly placements = {
    create: async (
      req: CreatePlacementRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<GraphObject> => {
      const result = await createPlacementRequest({
        client: this.client,
        body: req,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    list: async (query: ListPlacementsQuery = {}): Promise<ObjectListResponse> => {
      const result = await listPlacementsRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (idOrUrn: string): Promise<GraphObject> => {
      const result = await getPlacementRequest({ client: this.client, path: { idOrUrn } });
      return unwrap(result);
    },
    delete: async (idOrUrn: string): Promise<GraphObject> => {
      const result = await deletePlacementRequest({ client: this.client, path: { idOrUrn } });
      return unwrap(result);
    }
  };

  readonly deploymentTargets = {
    ...this.typedResource({
      create: createDeploymentTargetRequest,
      list: listDeploymentTargetsRequest,
      get: getDeploymentTargetRequest,
      update: updateDeploymentTargetRequest,
      del: deleteDeploymentTargetRequest,
      upsert: upsertDeploymentTargetByUrnRequest
    }),
    ...this.ownerMethods({
      add: addDeploymentTargetOwnerRequest,
      list: listDeploymentTargetOwnersRequest,
      remove: removeDeploymentTargetOwnerRequest
    })
  };

  readonly teams = this.typedResource({
    create: createTeamRequest,
    list: listTeamsRequest,
    get: getTeamRequest,
    update: updateTeamRequest,
    del: deleteTeamRequest,
    upsert: upsertTeamByUrnRequest
  });

  readonly groups = this.typedResource({
    create: createGroupRequest,
    list: listGroupsRequest,
    get: getGroupRequest,
    update: updateGroupRequest,
    del: deleteGroupRequest,
    upsert: upsertGroupByUrnRequest
  });

  readonly users = this.typedResource({
    create: createUserRequest,
    list: listUsersRequest,
    get: getUserRequest,
    update: updateUserRequest,
    del: deleteUserRequest,
    upsert: upsertUserByUrnRequest
  });

  readonly serviceAccounts = this.typedResource({
    create: createServiceAccountRequest,
    list: listServiceAccountsRequest,
    get: getServiceAccountRequest,
    update: updateServiceAccountRequest,
    del: deleteServiceAccountRequest,
    upsert: upsertServiceAccountByUrnRequest
  });

  // Named graph queries + generic traverse (DESIGN.md §5)

  readonly graph = {
    query: async (name: NamedGraphQuery, params: GraphQueryParams): Promise<GraphQueryResult> => {
      const result = await graphQueryRequest({
        client: this.client,
        path: { name },
        query: params
      });
      return unwrap(result) as GraphQueryResult;
    },
    traverse: async (params: TraverseParams): Promise<TraverseResult> => {
      const result = await graphTraverseRequest({ client: this.client, query: params });
      return unwrap(result);
    },
    /**
     * Induced-subgraph edges over an explicit object-id set — the REAL relationships whose both
     * endpoints are in `params.ids`. Lets a caller that already holds a named query's result SET
     * (`impact-of`/`blast-radius`/…) render the true edge structure among it in one round-trip.
     */
    subgraph: async (params: SubgraphParams): Promise<SubgraphResult> => {
      const result = await graphSubgraphRequest({ client: this.client, body: params });
      return unwrap(result);
    },
    /**
     * Rows that outlived the object they hang off. READ-ONLY — repair is issued through the ordinary
     * DELETE doors, so every removal keeps its audit event and journal entry.
     */
    integrity: async (): Promise<GraphIntegrityReport> => {
      const result = await graphIntegrityRequest({ client: this.client });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // `scp doctor` — read-only operational self-checks. Distinct from `/healthz` ("is this process
  // up") and from `client.health` below ("what did an owner say about this object"): these report
  // whether the instance's own state is COHERENT, which is exactly the class of fault a green
  // liveness probe hides.
  // -----------------------------------------------------------------------------------------

  readonly doctor = {
    /**
     * Every operational self-check for the caller's org. READ-ONLY — it never repairs what it finds,
     * because the remedy for each finding depends on which side of a mismatch is wrong.
     */
    report: async (): Promise<DoctorReport> => {
      const result = await doctorReportRequest({ client: this.client });
      return unwrap(result);
    },
    /**
     * §7.3 — INSTANCE-WIDE operational self-checks (DSN reachability, recovery state, delivery
     * config, mTLS/XO readiness). Gated by the deployment OPERATOR token (not a tenant bearer),
     * passed as the `x-scp-operator-token` header. `scp doctor instance`.
     */
    instanceReport: async (operatorToken: string): Promise<DoctorReport> => {
      const result = await doctorInstanceReportRequest({
        client: this.client,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // Object health (observe-enrichment signal 4; ADR-0008 decision 4). SCP STORES pushed health;
  // it never probes/polls/computes it (charter principle 1). Stored graph-natively as an
  // object-referencing projection row keyed by objects(id) (DESIGN §4.1).
  // -----------------------------------------------------------------------------------------

  readonly health = {
    /**
     * PUSH-IN the latest health of an object (idempotent upsert). `source` is binding-ready — an
     * owner writes `owner` today; a future opt-in health-source binding writes the SAME row.
     */
    push: async (type: string, idOrUrn: string, body: PushHealthRequest): Promise<HealthRecord> => {
      const result = await pushObjectHealthRequest({
        client: this.client,
        path: { type, idOrUrn },
        body
      });
      return unwrap(result);
    },
    /** The latest pushed health of one object (status `unknown` when none has been pushed). */
    get: async (type: string, idOrUrn: string): Promise<HealthRecord> => {
      const result = await getObjectHealthRequest({
        client: this.client,
        path: { type, idOrUrn }
      });
      return unwrap(result);
    },
    /**
     * Batch latest-health over an object-id set — the graph node-payload JOIN. `subgraph` returns
     * EDGES ONLY, so the UI fetches health in a parallel follow-up call over the node id set and
     * joins by id. Objects with no pushed health are absent (rendered grey/unknown, not fabricated).
     */
    batchGet: async (params: HealthBatchParams): Promise<HealthBatchResult> => {
      const result = await graphHealthRequest({ client: this.client, body: params });
      return unwrap(result);
    }
  };

  readonly auditEvents = {
    list: async (query: ListQuery = {}): Promise<AuditEventListResponse> => {
      const result = await listAuditEventsRequest({ client: this.client, query });
      return unwrap(result);
    }
  };

  /** Pagination iterator over the org's full audit chain, in chain order. */
  async *listAllAuditEvents(): AsyncGenerator<AuditEvent> {
    let cursor: string | undefined;
    do {
      const page = await this.auditEvents.list({ cursor });
      for (const item of page.items) yield item;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  // Personal Access Tokens (M2 step 2 Part A, BUILD_AND_TEST.md §8 M2 item 3)

  readonly pats = {
    /** `token` in the response is shown ONCE — it cannot be retrieved again after this call returns. */
    create: async (
      name: string,
      opts: { expiresAt?: string; idempotencyKey?: string } = {}
    ): Promise<CreatePatResponse> => {
      const result = await createPatRequest({
        client: this.client,
        body: { name, expiresAt: opts.expiresAt },
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    list: async (): Promise<PatListResponse> => {
      const result = await listPatsRequest({ client: this.client });
      return unwrap(result);
    },
    revoke: async (id: string): Promise<Pat> => {
      const result = await revokePatRequest({ client: this.client, path: { id } });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // RBAC — roles, role bindings, effective permissions (role-model.md §5 steps 5, 6, 10)
  //
  // The generated client carries these operations; this wrapper is what the CLI and the web UI
  // consume, and until now it did not expose them — so the whole roles milestone was reachable
  // only by hand-written HTTP. Charter principle 3 is API -> SDK -> CLI -> IaC -> UI, and the SDK
  // rung is this object, not the generated one.
  // -----------------------------------------------------------------------------------------

  readonly roles = {
    /** Built-ins and this org's own, in one bounded list — `GET /roles` is deliberately unpaginated. */
    list: async (): Promise<RoleListResponse> => {
      const result = await listRolesRequest({ client: this.client });
      return unwrap(result);
    },
    /** Authors an ORG role. Refused if it names a built-in, carries an unknown permission, or
     *  carries a permission the caller does not hold at the org root (role-binding-door.ts §9). */
    create: async (
      body: CreateRoleRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<Role> => {
      const result = await createRoleRequest({
        client: this.client,
        body,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    /** Partial update. Omitted fields are left alone — a PATCH that dropped `bindableAt` because
     *  the caller did not mention it would silently widen where the role may be bound. */
    update: async (id: string, body: UpdateRoleRequest): Promise<Role> => {
      const result = await updateRoleRequest({ client: this.client, path: { id }, body });
      return unwrap(result);
    },
    /** Refused while any binding still points at the role — see the route's own comment on why a
     *  cascade would be an unreviewable mass revoke. */
    delete: async (id: string, body: DeleteRoleRequest): Promise<void> => {
      const result = await deleteRoleRequest({ client: this.client, path: { id }, body });
      unwrap(result);
    }
  };

  readonly roleBindings = {
    list: async (
      query: { subjectId?: string; scopeObjectId?: string; cursor?: string; limit?: number } = {}
    ): Promise<RoleBindingListResponse> => {
      const result = await listRoleBindingsRequest({ client: this.client, query });
      return unwrap(result);
    },
    create: async (
      body: CreateRoleBindingRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<RoleBinding> => {
      const result = await createRoleBindingRequest({
        client: this.client,
        body,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    delete: async (id: string, body: DeleteRoleBindingRequest): Promise<void> => {
      const result = await deleteRoleBindingRequest({ client: this.client, path: { id }, body });
      unwrap(result);
    },
    /** D7 — what `acknowledgedPrincipalIds` must say for a group/team subject. Also reports
     *  `subjectExternallySynced`, i.e. whether an identity provider owns that membership. */
    grantPreview: async (subjectId: string): Promise<GrantPreviewResponse> => {
      const result = await previewRoleBindingGrantRequest({
        client: this.client,
        query: { subjectId }
      });
      return unwrap(result);
    }
  };

  readonly authz = {
    /** The CALLER's own permissions at one object, deny-override applied, plus the bindings that
     *  produced them. Answers about nobody else — see the route's authorization note. */
    effective: async (scopeObjectId: string): Promise<EffectivePermissionsResponse> => {
      const result = await getEffectivePermissionsRequest({
        client: this.client,
        query: { scopeObjectId }
      });
      return unwrap(result);
    }
  };

  // Instance-tier operator credentials (role-model.md §5 step 9)

  readonly operatorCredentials = {
    /**
     * `token` is returned ONCE and is not retrievable afterwards.
     *
     * `operatorToken` is REQUIRED on all three of these, unlike the read half of the other
     * instance-tier surfaces: minting, listing and revoking are each gated by
     * `x-scp-operator-token` (an existing credential, or the bootstrap `SCP_OPERATOR_TOKEN`). The
     * listing is operator-gated too because it discloses how many credentials exist and when each
     * was last used, which is a fact about the deployment's key material.
     */
    create: async (
      body: CreateOperatorCredentialRequest,
      operatorToken: string
    ): Promise<CreatedOperatorCredential> => {
      const result = await createOperatorCredentialRequest({
        client: this.client,
        body,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    /** Never returns secrets. `callerMechanism` reports whether THIS request was admitted by a
     *  minted credential or the bootstrap env token — the only way to see that a deployment is
     *  still on the bootstrap path. */
    list: async (operatorToken: string): Promise<OperatorCredentialListResponse> => {
      const result = await listOperatorCredentialsRequest({
        client: this.client,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    revoke: async (id: string, operatorToken: string): Promise<void> => {
      const result = await revokeOperatorCredentialRequest({
        client: this.client,
        path: { id },
        headers: { "x-scp-operator-token": operatorToken }
      });
      unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // OIDC device authorization flow (M2 step 2 Part C) — `.poll()` is a SINGLE poll; callers own
  // the retry/backoff loop (and can cancel it) rather than the SDK hiding it.
  // -----------------------------------------------------------------------------------------

  readonly deviceFlow = {
    start: async (): Promise<DeviceStartResponse> => {
      const result = await startDeviceAuthRequest({ client: this.client });
      return unwrap(result);
    },
    approve: async (userCode: string): Promise<DeviceApproveResponse> => {
      const result = await approveDeviceAuthRequest({ client: this.client, body: { userCode } });
      return unwrap(result);
    },
    poll: async (deviceCode: string): Promise<LoginResult> => {
      const result = await pollDeviceAuthTokenRequest({
        client: this.client,
        body: { deviceCode }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // `@scp/iac` server-side plan/apply (M2 step 3, BUILD_AND_TEST.md §8 M2 item 4) — the diff
  // engine lives once on the server (routes/plans.ts); `scp plan`/`scp apply` (packages/cli) are
  // thin callers of `.create()`/`.apply()` here, same layering as every other resource.
  // -----------------------------------------------------------------------------------------

  readonly plans = {
    create: async (manifest: DesiredStateManifest): Promise<Plan> => {
      const result = await createPlanRequest({ client: this.client, body: { manifest } });
      return unwrap(result);
    },
    get: async (id: string): Promise<Plan> => {
      const result = await getPlanRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    apply: async (id: string): Promise<ApplyPlanResponse> => {
      const result = await applyPlanRequest({ client: this.client, path: { id } });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M3 Change Coordination Engine (BUILD_AND_TEST.md §8 M3, DESIGN §9/§10.4) —
  // `scp change propose/accept/rollback/explain` (packages/cli) are thin callers of these,
  // same layering as every other resource.
  // -----------------------------------------------------------------------------------------

  readonly changes = {
    propose: async (
      req: CreateChangeRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<Change> => {
      const result = await proposeChangeRequest({
        client: this.client,
        body: req,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    list: async (query: ChangeListQuery = { limit: 20 }): Promise<ChangeListResponse> => {
      const result = await listChangesRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (id: string): Promise<Change> => {
      const result = await getChangeRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    explain: async (id: string): Promise<ChangeExplainResponse> => {
      const result = await explainChangeRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    cancel: async (id: string, reason?: string): Promise<Change> => {
      const result = await cancelChangeRequest({
        client: this.client,
        path: { id },
        body: { reason }
      });
      return unwrap(result);
    },
    /** Accepts a change out of `validating` — the human approval gate before `accepted`.
     *  `overrideFreeze` (DESIGN §10.3, M4) attempts to override an active freeze blocking this
     *  transition — requires `freeze:override` permission AND `reason` to be set (the same
     *  field doubles as the freeze override's mandatory reason). */
    accept: async (id: string, reason?: string, overrideFreeze?: boolean): Promise<Change> => {
      const result = await acceptChangeRequest({
        client: this.client,
        path: { id },
        body: { reason, overrideFreeze }
      });
      return unwrap(result);
    },
    /** Manually triggers a rollback — returns the NEW rollback Change (linked via
     *  `rollbackOfObjectId`), not the original. */
    rollback: async (id: string, reason: string): Promise<Change> => {
      const result = await rollbackChangeRequest({
        client: this.client,
        path: { id },
        body: { reason }
      });
      return unwrap(result);
    }
  };

  readonly decisions = {
    list: async (query: DecisionListQuery = { limit: 20 }): Promise<DecisionListResponse> => {
      const result = await listDecisionsRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (id: string): Promise<Decision> => {
      const result = await getDecisionRequest({ client: this.client, path: { id } });
      return unwrap(result);
    }
  };

  readonly changeSources = {
    /** Persist-then-process webhook ingress (DESIGN §8) — `payload` is kept verbatim. */
    webhook: async (
      sourceKind: string,
      payload: Record<string, unknown>
    ): Promise<WebhookIngressResponse> => {
      const result = await ingestChangeSourceWebhookRequest({
        client: this.client,
        path: { sourceKind },
        body: payload
      });
      return unwrap(result);
    },
    createMapping: async (
      sourceKind: string,
      req: Omit<CreateSourceMappingRequest, "sourceKind">
    ): Promise<SourceMapping> => {
      const result = await createSourceMappingRequest({
        client: this.client,
        path: { sourceKind },
        body: { ...req, sourceKind }
      });
      return unwrap(result);
    },
    listMappings: async (sourceKind: string): Promise<SourceMappingListResponse> => {
      const result = await listSourceMappingsRequest({ client: this.client, path: { sourceKind } });
      return unwrap(result);
    },
    /** Deletes EVERY mapping matching the identity tuple, returning how many rows went. Not by id:
     *  the table has no unique constraint and `discovery accept` inserts unconditionally, so
     *  byte-identical rows exist and removing one would leave the survivor still correlating.
     *  `repoPattern`/`pathPattern` are nullable rather than optional because NULL is meaningful. */
    deleteMapping: async (
      sourceKind: string,
      req: DeleteSourceMappingRequest
    ): Promise<DeleteSourceMappingResponse> => {
      const result = await deleteSourceMappingRequest({
        client: this.client,
        path: { sourceKind },
        body: req
      });
      return unwrap(result);
    },
    /** Flips the pause switch on ONE mapping, by id (migration 0063) — a disabled mapping stays
     *  declared but `matchComponentForSource` skips it, so it routes nothing. */
    setMappingEnabled: async (
      sourceKind: string,
      id: string,
      enabled: boolean,
      /** Timed close (with enabled:false): closed until this ISO instant, then open again at read time. */
      disabledUntil?: string | null
    ): Promise<SourceMapping> => {
      const result = await setSourceMappingEnabledRequest({
        client: this.client,
        path: { sourceKind, id },
        body: { enabled, ...(disabledUntil !== undefined ? { disabledUntil } : {}) }
      });
      return unwrap(result);
    },
    /** Sets or clears ONE mapping's declared scope, by id (migration 0066, §10.6): `global` = a
     *  cross-domain shared repo tracked at the commander, `domain` = tracked only in this domain,
     *  `null` = clear (back to "not declared" — no label). A label read by pipelines, IaC and the
     *  CLI; never a routing input. */
    setMappingScope: async (
      sourceKind: string,
      id: string,
      scope: SourceMappingScope | null
    ): Promise<SourceMapping> => {
      const result = await setSourceMappingScopeRequest({
        client: this.client,
        path: { sourceKind, id },
        body: { scope }
      });
      return unwrap(result);
    },
    /** M7: configures (or rotates) this org+sourceKind's webhook HMAC signing secret — once set,
     *  `webhook()` deliveries for this sourceKind MUST carry a valid signature or are rejected
     *  (coordination/webhook-signature.ts). */
    putWebhookSecret: async (
      sourceKind: string,
      req: CreateWebhookSecretRequest
    ): Promise<WebhookSecretConfiguredResponse> => {
      const result = await putChangeSourceWebhookSecretRequest({
        client: this.client,
        path: { sourceKind },
        body: req
      });
      return unwrap(result);
    },
    /** `scp change-source report` (DESIGN §12 Mode 1) — the GENERATED `reportChangeSource`
     *  operation against its own typed route, `POST /change-sources/{sourceKind}/report`. Same
     *  persist-then-process engine path as `webhook()` (one `change_source_events` row, same
     *  processor), but PAT-authenticated (no HMAC) and fully typed — including the M12 P4B
     *  coupled-pipeline declaration (`provides`/`requires`), which the raw webhook shape cannot
     *  carry. */
    report: async (
      sourceKind: string,
      req: ChangeReportRequest
    ): Promise<WebhookIngressResponse> => {
      const result = await reportChangeSourceRequest({
        client: this.client,
        path: { sourceKind },
        body: req
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN §10). Policy/Control documents reuse
  // `typedResource` exactly like every other typed registry (routes/typed-registries.ts); control
  // bindings/runs, approvals, freezes, and `policy evaluate` are their own thin wrappers.
  // -----------------------------------------------------------------------------------------

  readonly policies = this.typedResource({
    create: createPolicyRequest,
    list: listPoliciesRequest,
    get: getPolicyRequest,
    update: updatePolicyRequest,
    del: deletePolicyRequest,
    upsert: upsertPolicyByUrnRequest
  });

  readonly controls = {
    ...this.typedResource({
      create: createControlRequest,
      list: listControlsRequest,
      get: getControlRequest,
      update: updateControlRequest,
      del: deleteControlRequest,
      upsert: upsertControlByUrnRequest
    }),
    /** Binds a Control to a ControlPlugin instance (DESIGN §10.2). */
    putBinding: async (
      idOrUrn: string,
      req: CreateControlBindingRequest
    ): Promise<ControlBinding> => {
      const result = await putControlBindingRequest({
        client: this.client,
        path: { idOrUrn },
        body: req
      });
      return unwrap(result);
    }
  };

  readonly controlRuns = {
    /** Persisted control outcomes + evidence for one Change (DESIGN §10.2/§10.4). */
    listForChange: async (changeId: string): Promise<ControlRunListResponse> => {
      const result = await listChangeControlRunsRequest({
        client: this.client,
        path: { idOrUrn: changeId }
      });
      return unwrap(result);
    },
    /**
     * The persisted findings of ONE scan control run (M22.1b/ADR-0033 §7), paged by ordinal.
     *
     * OPT-IN, and separate from `listForChange` on purpose: a run can carry up to
     * `SCAN_FINDINGS_PERSIST_CAP` rows, so folding them into the run listing would put thousands of
     * rows on a surface every change page reads.
     *
     * ALWAYS READ `findingsRecord` BEFORE THE ROWS. It is `truncated`, `unsupported`, or absent, and
     * each of those means every exclusion for that scan was REFUSED — you cannot except what you did
     * not record. A caller handed only `items` cannot distinguish "nothing was excluded" from "the
     * finding set was capped and exclusions were therefore disallowed", which is the whole reason the
     * marker travels with the page rather than beside it.
     */
    findings: async (
      controlRunId: string,
      query: CursorPageQuery = { limit: 20 }
    ): Promise<ControlRunFindingsResponse> => {
      const result = await listControlRunFindingsRequest({
        client: this.client,
        path: { id: controlRunId },
        query
      });
      return unwrap(result);
    }
  };

  readonly approvals = {
    list: async (query: ApprovalRequestListQuery): Promise<ApprovalRequestListResponse> => {
      const result = await listApprovalsRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (id: string): Promise<ApprovalRequest> => {
      const result = await getApprovalRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    listVotes: async (id: string): Promise<ApprovalVote[]> => {
      const result = await listApprovalVotesRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /** Casts a vote AS THE AUTHENTICATED CALLER — DESIGN §10.2 N-of-M quorum; there is no way to
     *  vote on someone else's behalf through this API. */
    vote: async (id: string, req: CastApprovalVoteRequest = {}): Promise<ApprovalVote> => {
      const result = await castApprovalVoteRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    }
  };

  readonly freezes = {
    create: async (req: CreateFreezeRequest): Promise<Freeze> => {
      const result = await createFreezeRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    list: async (): Promise<FreezeListResponse> => {
      const result = await listFreezesRequest({ client: this.client });
      return unwrap(result);
    },
    get: async (id: string): Promise<Freeze> => {
      const result = await getFreezeRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /** M25.1 — LIFT (retract) a freeze: it stops being in force immediately, whatever `endsAt`
     *  says. The `reason` is mandatory — lifting is a governance LOOSENING that applies to everyone
     *  the freeze covered.
     *
     *  `freeze:write` AT THE FREEZE'S OWN SCOPE, and — M25.9 / owner ruling D1(a-ii), 2026-08-25 —
     *  the Owner-only `freeze:override` AT THAT SAME SCOPE ON TOP whenever you are not the actor who
     *  declared it (compared on the freeze's `created_by_actor_id`). Lifting YOUR OWN freeze stays
     *  `freeze:write` alone, so the permission that declares a freeze is still the permission that
     *  undoes it; retracting someone else's protection for everyone it covers costs the same
     *  permission that admits one change past it. Expect a 403 naming `freeze:override` otherwise.
     *  Scope is NOT expanded downward: `freeze:override` bound at a service does not reach the
     *  org-root freeze that covers everyone. `routes/governance.ts`'s `assertMayRetractAnothersFreeze`
     *  is where the rule is spelled.
     *
     *  A SOFT lift: the returned row is the freeze, still readable by `get(id)` forever with
     *  `liftedAt` set, because a `gate`/`freeze_admission` Decision cites `freeze.id` in its
     *  `inputContext` and that citation must keep resolving (charter principle 6). */
    lift: async (id: string, req: LiftFreezeRequest): Promise<Freeze> => {
      const result = await liftFreezeRequest({ client: this.client, path: { id }, body: req });
      return unwrap(result);
    },
    /** M25.1 — move a freeze's `endsAt`, in EITHER direction. Shortening it is a loosening and
     *  extending it is a tightening; both take `freeze:write` at the freeze's own scope, both
     *  require a reason, and the server records which direction it was along with the old and new
     *  instants. Shortening to a past instant is allowed and is NOT re-labelled a lift.
     *
     *  THE TWO DIRECTIONS DO NOT COST THE SAME (M25.9 / owner ruling D1(a-ii), 2026-08-25). A
     *  SHORTENING ends the protection early for everyone the freeze covers — the same act as
     *  {@link lift} with a different record — so it additionally takes the Owner-only
     *  `freeze:override` at the freeze's own scope whenever you are not the actor who declared it,
     *  and gating the lift alone would have left the retraction one PATCH away. EXTENDING adds
     *  protection and takes nothing from anyone, so it stays `freeze:write` even on someone else's
     *  freeze; so does re-sending the `endsAt` a freeze already has, which moves nothing. The server
     *  decides this from the direction it computes under the row lock, so the answer is about the
     *  window actually in force, not the one you last read. */
    updateWindow: async (id: string, req: UpdateFreezeWindowRequest): Promise<Freeze> => {
      const result = await updateFreezeWindowRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    }
  };

  /** `scp policy evaluate` — a dry-run gate check against a change's CURRENT state, no transition
   *  attempted (DESIGN §10.1 explainability, reusing the exact orchestrator the real gates run). */
  async policyEvaluate(changeId: string): Promise<PolicyEvaluateResponse> {
    const result = await policyEvaluateRequest({ client: this.client, body: { changeId } });
    return unwrap(result);
  }

  // -----------------------------------------------------------------------------------------
  // M5 Campaigns (BUILD_AND_TEST.md §8 M5, DESIGN §9.5) — `scp campaign
  // create/status` (packages/cli) are thin callers of these, same layering as `changes` above.
  // No `accept`/`cancel` verbs: a campaign has no transition-guarded state machine of its own
  // (coordination/campaign-status.ts's module doc) — `status` is always derived live by `get`.
  // -----------------------------------------------------------------------------------------

  readonly campaigns = {
    propose: async (
      req: CreateCampaignRequest,
      opts: { idempotencyKey?: string } = {}
    ): Promise<Campaign> => {
      const result = await proposeCampaignRequest({
        client: this.client,
        body: req,
        headers: idempotencyHeaders(opts.idempotencyKey)
      });
      return unwrap(result);
    },
    list: async (query: CampaignListQuery = { limit: 20 }): Promise<CampaignListResponse> => {
      const result = await listCampaignsRequest({ client: this.client, query });
      return unwrap(result);
    },
    get: async (id: string): Promise<Campaign> => {
      const result = await getCampaignRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    explain: async (id: string): Promise<CampaignExplainResponse> => {
      const result = await explainCampaignRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /** M25.5 — "has each of this campaign's components migrated yet?", derived live from the
     *  evidence source the recipe names. Same `object:read`-at-the-campaign scope as `explain`. */
    adoption: async (id: string): Promise<CampaignAdoptionResponse> => {
      const result = await campaignAdoptionRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /**
     * M25.6a (owner decision D4) — SET, MOVE or CLEAR this campaign's deadline. `deadline: null`
     * CLEARS it, which releases every target the deadline was withholding fan-out from on the next
     * tick. That is the BLUNT exit; `overrideDeadline` below is the per-target one.
     *
     * WHAT EACH ACT COSTS (owner ruling 2026-08-25, D1 b-i). Setting a FIRST deadline and SHORTENING
     * an existing one are tightenings and run at plain `object:write` at the campaign. CLEARING it
     * (`deadline: null`), or moving `at` to an instant LATER than the one stored, RELEASES targets —
     * so both additionally require the Owner-only `campaign:deadline-override` at the campaign, and
     * throw 403 without it. Clearing is a strict superset of waiving one target via
     * `overrideDeadline`, so it cannot cost less than that call does.
     *
     * `CampaignDeadlineInput`, not `CampaignDeadline`: the stored document carries `overrides[]` and
     * this verb cannot author them whatever the caller holds — minting a waiver goes through
     * `overrideDeadline`, which names its targets and audits one event each. Waivers already in
     * force survive a set or a move.
     *
     * `reason` is MANDATORY on all three acts including the clear: the audit event records the
     * operator's own words and the Decision it cites carries the PREVIOUS value, without which "the
     * deadline slipped four times" is unreconstructible.
     */
    setDeadline: async (
      id: string,
      deadline: CampaignDeadlineInput | null,
      reason: string
    ): Promise<Campaign> => {
      const result = await setCampaignDeadlineRequest({
        client: this.client,
        path: { id },
        body: { deadline, reason }
      });
      return unwrap(result);
    },
    /**
     * M25.6b (§4.5) — WAIVE this campaign's deadline for named targets, so one laggard can be
     * excused without clearing the deadline for everybody.
     *
     * Takes `campaign:deadline-override` (Owner-only) AT THE CAMPAIGN — the thing being waived is
     * *this campaign's* deadline, and a target-scoped check would hand the laggard their own waiver
     * — PLUS `object:write` at each named target. OMITTING `targets` waives every target the
     * campaign declares, which still is not the same as clearing: the deadline stands, each waiver
     * is audited per target, and `until` expires them individually.
     *
     * `until` is a BOUNDARY with read-time expiry: an instant in the past is stored, audited, and
     * simply not effective. There is no un-waive verb, for the same reason there is no unlock verb.
     */
    overrideDeadline: async (
      id: string,
      req: OverrideCampaignDeadlineRequest
    ): Promise<Campaign> => {
      const result = await overrideCampaignDeadlineRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    },
    /** Rolls back every currently-eligible member Change (DESIGN §9.4/§9.5) — each becomes its
     *  own new rollback Change, exactly like `changes.rollback` does per-member. */
    rollback: async (id: string, reason: string): Promise<RollbackCampaignResponse> => {
      const result = await rollbackCampaignRequest({
        client: this.client,
        path: { id },
        body: { reason }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M17.5: instance-scoped scan-requirement floors (ADR-0016 §3) — the two ABOVE-org tiers of the
  // six-tier, most-restrictive-wins scan chain (platform + trust domain (partition)). They bind
  // EVERY org on the deployment, so `put` is an OPERATOR action: it carries the deployment's
  // `x-scp-operator-token`, never a tenant role. `list` is an ordinary authenticated read.
  // -----------------------------------------------------------------------------------------
  // -----------------------------------------------------------------------------------------
  // M22.6 (ADR-0033 §6a) — the override request: a STANDING grant per (component x finding) with an
  // EXPIRY. `create` raises one (`object:write` at the component); `approve`/`deny`/`revoke` are the
  // authority acts and each needs `policy:write` at the object naming the tier that SET the rule
  // (D3). Every act writes a Decision AND a high-severity hash-chained audit event, copying
  // `freeze.override` — never the approvals path, where a vote writes no audit event today.
  // -----------------------------------------------------------------------------------------
  readonly scanOverrideGrants = {
    create: async (req: CreateScanOverrideGrantRequest): Promise<ScanOverrideGrant> => {
      const result = await createScanOverrideGrantRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** COMPONENT-SCOPED and the component is required — an unscoped list of every accepted risk in
     *  the org is a wider disclosure than the read that authorized it. Includes expired, denied and
     *  revoked grants: an operator asking "what has been granted here" must see the ones that no
     *  longer apply. */
    listForComponent: async (componentIdOrUrn: string): Promise<ScanOverrideGrant[]> => {
      const result = await listScanOverrideGrantsRequest({
        client: this.client,
        query: { component: componentIdOrUrn }
      });
      return unwrap(result).items;
    },
    approve: async (
      id: string,
      req: ApproveScanOverrideGrantRequest
    ): Promise<ScanOverrideGrant> => {
      const result = await approveScanOverrideGrantRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    },
    deny: async (id: string, req: DecideScanOverrideGrantRequest): Promise<ScanOverrideGrant> => {
      const result = await denyScanOverrideGrantRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    },
    revoke: async (id: string, req: DecideScanOverrideGrantRequest): Promise<ScanOverrideGrant> => {
      const result = await revokeScanOverrideGrantRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M25.3: instance-scoped (PLATFORM) freezes — the freeze tier ABOVE org (drizzle/0086,
  // campaigns-rework §2, owner decision D1). One row binds EVERY org on the deployment, so the
  // two write verbs take the deployment-level operator token and NO tenant role can grant them —
  // the twin of `instanceScanFloors`, on purpose. `list` is tenant-readable, deliberately: a
  // platform freeze is the one freeze a tenant can neither author nor (by default) override, so a
  // tenant that cannot read it cannot be told why its release stopped.
  // -----------------------------------------------------------------------------------------
  readonly instanceFreezes = {
    /** Every instance freeze, including RETRACTED ones — a block Decision cites the id forever. */
    list: async (): Promise<InstanceFreeze[]> => {
      const result = await listInstanceFreezesRequest({ client: this.client });
      return unwrap(result).items;
    },
    /** Declare or edit the freeze at `key` (a full replace of that row, never a partial merge).
     *  `operatorToken` is the deployment-level `SCP_OPERATOR_TOKEN`. */
    put: async (
      key: string,
      req: PutInstanceFreezeRequest,
      operatorToken: string
    ): Promise<InstanceFreeze> => {
      const result = await putInstanceFreezeRequest({
        client: this.client,
        path: { key },
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    /** RETRACT the freeze at `key` — it stops being in force immediately, whatever `endsAt` says.
     *  A SOFT lift: the row stays readable through `list` forever. The reason is mandatory and a
     *  retraction is final (a second lift is a 409; re-PUTting the key is refused). */
    lift: async (
      key: string,
      req: LiftInstanceFreezeRequest,
      operatorToken: string
    ): Promise<InstanceFreeze> => {
      const result = await liftInstanceFreezeRequest({
        client: this.client,
        path: { key },
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  readonly instanceScanFloors = {
    list: async (): Promise<InstanceScanFloor[]> => {
      const result = await listInstanceScanFloorsRequest({ client: this.client });
      return unwrap(result).items;
    },
    /** Author (upsert) one floor. `operatorToken` is the deployment-level `SCP_OPERATOR_TOKEN`. */
    put: async (
      tier: "platform" | "trust_domain",
      req: PutInstanceScanFloorRequest,
      operatorToken: string
    ): Promise<InstanceScanFloor> => {
      const result = await putInstanceScanFloorRequest({
        client: this.client,
        path: { tier },
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M22.9: instance-scoped scan-exclusion admissions (ADR-0033 §1, §7a) — the `platform` and
  // `trust_domain` rungs of the monotone AND. NO POLICY CAN EVER CONTRIBUTE THESE TWO
  // (`tierForObjectType` maps graph object types and `containmentChain` is org-rooted), so without
  // this surface every exclusion clause on a deployment fails the AND at the top rung and the whole
  // dimension is inert. The five org-and-below rungs admit through the ordinary `scanExclusion`
  // policy effect and are NOT here. The twin of `instanceScanFloors`, on purpose.
  // -----------------------------------------------------------------------------------------
  readonly instanceScanExclusionAdmissions = {
    list: async (): Promise<InstanceScanExclusionAdmission[]> => {
      const result = await listInstanceScanExclusionAdmissionsRequest({ client: this.client });
      return unwrap(result).items;
    },
    /** REPLACE the admitted class set at one instance tier — `classes: []` is the revocation.
     *  `operatorToken` is the deployment-level `SCP_OPERATOR_TOKEN`; no tenant role can grant this. */
    put: async (
      tier: "platform" | "trust_domain",
      req: PutInstanceScanExclusionAdmissionsRequest,
      operatorToken: string
    ): Promise<InstanceScanExclusionAdmission[]> => {
      const result = await putInstanceScanExclusionAdmissionsRequest({
        client: this.client,
        path: { tier },
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result).items;
    }
  };

  // -----------------------------------------------------------------------------------------
  // M13.3a: instance-scoped scanner assignments (ADR-0020 §2) — the executor Type -> managed scan
  // method(s) registry the commander's promotion scan step selects scanners from. They bind EVERY
  // org on the deployment, so `put` is an OPERATOR action carrying the deployment's
  // `x-scp-operator-token`, never a tenant role. `list` is an ordinary authenticated read. The
  // twin of `instanceScanFloors`, on purpose.
  // -----------------------------------------------------------------------------------------
  readonly scannerAssignments = {
    list: async (): Promise<ScannerAssignment[]> => {
      const result = await listScannerAssignmentsRequest({ client: this.client });
      return unwrap(result).items;
    },
    /** Assign (upsert) managed scan methods to an executor Type. `operatorToken` is the
     *  deployment-level `SCP_OPERATOR_TOKEN`; an empty `methods` clears the assignment (fail-closed). */
    put: async (
      req: PutScannerAssignmentRequest,
      operatorToken: string
    ): Promise<ScannerAssignment> => {
      const result = await putScannerAssignmentRequest({
        client: this.client,
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M13.3b-ii: the offline scanner-DB cache (ADR-0020, proposal §13.3b). `status`/`stalenessPolicy`
  // are ordinary authenticated reads (a blocked-for-stale-DB promotion must be explainable). The
  // WRITES bind every org on the deployment, so each is an OPERATOR action carrying the deployment's
  // `x-scp-operator-token`: the staleness-policy PUT, the connected `refresh` (skopeo-pull), and the
  // air-gap `load` of a cosign-signed DB blob (server-local paths, verified before accept).
  // -----------------------------------------------------------------------------------------
  readonly scanDb = {
    status: async (): Promise<ScanDbStatus> => {
      const result = await getScanDbStatusRequest({ client: this.client });
      return unwrap(result);
    },
    stalenessPolicy: async (): Promise<ScanDbStalenessPolicy> => {
      const result = await getScanDbStalenessPolicyRequest({ client: this.client });
      return unwrap(result);
    },
    /** Author (upsert) the staleness policy. `null` bounds reset to the built-in default. */
    setStalenessPolicy: async (
      req: PutScanDbStalenessPolicyRequest,
      operatorToken: string
    ): Promise<ScanDbStalenessPolicy> => {
      const result = await putScanDbStalenessPolicyRequest({
        client: this.client,
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    /** Connected refresh: skopeo-pull the upstream OCI trivy-db into the cache (atomic swap). */
    refresh: async (operatorToken: string): Promise<RefreshScanDbResponse> => {
      const result = await refreshScanDbRequest({
        client: this.client,
        body: {},
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    /** Air-gap load: verify + install a cosign-signed DB blob from server-local paths. */
    load: async (req: LoadScanDbRequest, operatorToken: string): Promise<LoadScanDbResponse> => {
      const result = await loadScanDbRequest({
        client: this.client,
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M21.3: the DEPENDENCY-SUBSCRIPTION ENABLEMENT CHAIN (ADR-0032 §3a, §6).
  //
  //     effective_enabled(component, line) =
  //         instance_unlocked  AND  component_enabled  AND  NOT line_opted_out
  //
  // `unlock` is an ordinary authenticated read (a team whose subscription is inert because the
  // DEPLOYMENT never opened the feature must be able to see that); `setUnlock` binds every org on
  // the deployment, so it is an OPERATOR action carrying `x-scp-operator-token`. The twin of
  // `instanceScanFloors`/`scanDb`, on purpose.
  //
  // THERE IS NO `subscribe()` HERE, AND THERE MUST NOT BE. A dependency subscription IS a
  // `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a) — author it with
  // `client.policies.create(...)`, carrying `effects: [{ dependencySubscription: { enabled: true } }]`
  // at the scope you want it, and opt one line back out with `{ coordinate: "…", enabled: false }`.
  // A convenience wrapper here would be a second authoring path for one concept.
  // -----------------------------------------------------------------------------------------
  // -----------------------------------------------------------------------------------------
  // `governance:move` — THE OPT-IN SECOND BAR ON A CONTAINMENT MOVE (proposal
  // governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18).
  //
  // THERE IS NO `move()` HERE, AND THERE MUST NOT BE. A move is still made through the ordinary
  // verbs — `object(type).update({ domainId })`, `components.setService(...)`, `relationships`
  // create/delete of a `contains` edge, or an IaC apply. What this block exposes is the LATTICE that
  // decides whether those verbs demand `governance:move` as well as `object:write`.
  //
  // `enforcement(type, idOrUrn)` answers about ONE object's containment chain. A move has TWO ends
  // and the door ORs them, so `enforced: false` here is not a promise that a particular move is
  // ungoverned — the destination's chain may carry the rung.
  // -----------------------------------------------------------------------------------------
  readonly governanceMove = {
    /** Is a move of this object governed, and by which rung? (See the note above about two ends.) */
    enforcement: async (type: string, idOrUrn: string): Promise<GovernanceMoveEnforcement> => {
      const result = await getObjectGovernanceMoveEnforcementRequest({
        client: this.client,
        path: { type, idOrUrn }
      });
      return unwrap(result);
    },
    /** Every rung this org has enabled, with the instance rung's state. */
    rungs: async (): Promise<GovernanceMoveRungList> => {
      const result = await listGovernanceMoveRungsRequest({ client: this.client });
      return unwrap(result);
    },
    /** Enable a rung at one container. `policy:write` at-or-above the subject; idempotent. */
    enable: async (
      idOrUrn: string,
      req: PutGovernanceMoveRungRequest = {}
    ): Promise<GovernanceMoveRungWriteResponse> => {
      const result = await enableGovernanceMoveRungRequest({
        client: this.client,
        path: { idOrUrn },
        body: req
      });
      return unwrap(result);
    },
    /** Disable a rung. 409 while an upper rung (an ancestor's, or the instance rung) is enabled —
     *  an enablement above cannot be undone below. */
    disable: async (idOrUrn: string): Promise<GovernanceMoveRungWriteResponse> => {
      const result = await disableGovernanceMoveRungRequest({
        client: this.client,
        path: { idOrUrn }
      });
      return unwrap(result);
    },
    /** The instance (commander) rung. It ACTIVATES for every org on the deployment. */
    instance: async (): Promise<GovernanceMoveInstanceRung> => {
      const result = await getGovernanceMoveInstanceRungRequest({ client: this.client });
      return unwrap(result);
    },
    /** Set the instance rung. `operatorToken` is the deployment-level `SCP_OPERATOR_TOKEN` — no
     *  tenant role can grant this, because the rung binds every org on the deployment. */
    setInstance: async (
      req: PutGovernanceMoveInstanceRungRequest,
      operatorToken: string
    ): Promise<GovernanceMoveInstanceRung> => {
      const result = await putGovernanceMoveInstanceRungRequest({
        client: this.client,
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    }
  };

  readonly dependencySubscriptions = {
    /** The instance unlock — the FIRST conjunct. `unlocked: true` PERMITS; it activates nothing. */
    unlock: async (): Promise<DependencySubscriptionUnlock> => {
      const result = await getDependencySubscriptionUnlockRequest({ client: this.client });
      return unwrap(result);
    },
    /** Set the unlock. `operatorToken` is the deployment-level `SCP_OPERATOR_TOKEN` — no tenant role
     *  can grant this, because the row binds every org on the deployment. */
    setUnlock: async (
      req: PutDependencySubscriptionUnlockRequest,
      operatorToken: string
    ): Promise<DependencySubscriptionUnlock> => {
      const result = await putDependencySubscriptionUnlockRequest({
        client: this.client,
        body: req,
        headers: { "x-scp-operator-token": operatorToken }
      });
      return unwrap(result);
    },
    /** Resolve ONE (component, line) pair, with the per-tier `contributions` that decided it — the
     *  explainability surface (charter principle 6: WHICH level turned this off?). The line key
     *  travels VERBATIM; the coordinate is never slugified on either side.
     *
     *  READ `dependencyManagement` BEFORE ACTING ON `resolution`. It is required and always present,
     *  and when `managedHere` is false the verdict is correct but INERT: this deployment is not an
     *  explicitly declared commander, so no dependency job runs on it and nothing here will ever act
     *  on an `enabled: true` (ADR-0032 §7d, `DependencyManagementSchema`). */
    resolve: async (
      componentIdOrUrn: string,
      line: DependencyLineKey
    ): Promise<DependencySubscriptionResolutionResponse> => {
      const result = await getComponentDependencySubscriptionRequest({
        client: this.client,
        path: { idOrUrn: componentIdOrUrn },
        query: line
      });
      return unwrap(result);
    },
    /**
     * M21.2 (ADR-0032 §4) — read enabled components' dependency manifests and (re)build their
     * inventory.
     *
     * Ingestion is normally event-driven off an accepted change, which covers only components that
     * RELEASE. This is how an existing estate — and any component that has not pushed since being
     * enabled — acquires an inventory at all. Idempotent, and it reports every skip.
     *
     * It does not weaken the enablement gate: a component with no enabling subscription is refused
     * before its repo is read, and no argument here can turn that off.
     */
    backfillInventory: async (
      req: BackfillDependencyInventoryRequest = {}
    ): Promise<BackfillDependencyInventoryResponse> => {
      const result = await backfillDependencyInventoryRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /**
     * M21.6 — a component's dependency INVENTORY: one row per (major line × dependency manifest)
     * with the line's last-observed head, its DECLARED producer and its resolved dependency
     * subscription, plus the component-level ingestion gate.
     *
     * Every `rows[].subscription` is resolved AS THE CALLER — the acting subject is the requesting
     * principal, exactly as `resolve()` threads it — so it is byte-equal to `resolve()` for the same
     * caller and line, and a `scope.group` policy can make one human's answer differ from another's.
     * `ingestion: null` and `lastIngestionDecision: null` mean NOT RECORDED; an empty `rows` beside
     * them is UNKNOWN, never "no dependencies". `object:read` at the component; paged (limit ≤ 200,
     * default 100).
     */
    inventory: async (
      componentIdOrUrn: string,
      query: ListQuery = {}
    ): Promise<ComponentDependencyInventoryResponse> => {
      const result = await listComponentDependencyInventoryRequest({
        client: this.client,
        path: { idOrUrn: componentIdOrUrn },
        query
      });
      return unwrap(result);
    },
    /**
     * M21.6 — the bumps SCP AUTHORED for a component, newest dispatch first: each authorship row
     * joined to its change's name and to the newest dispatch (`delivery`) and merge (`merge`)
     * Decisions. `pullRequestUrl` is `null` until the server persists one — a consumer links only
     * when it is non-null and never composes a URL from `repo` + `pullRequestNumber`. Same
     * authorization and paging as `inventory`.
     */
    bumps: async (
      componentIdOrUrn: string,
      query: ListQuery = {}
    ): Promise<ComponentDependencyBumpsResponse> => {
      const result = await listComponentDependencyBumpsRequest({
        client: this.client,
        path: { idOrUrn: componentIdOrUrn },
        query
      });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // THE PRODUCER DECLARATION (ADR-0032 §7e) — which COMPONENT this org declares it publishes a
  // coordinate from, and therefore which coordinates are INTERNAL.
  //
  // It is the switch between two entirely different head ingresses. An internal coordinate's
  // versions are DERIVED from the org's own production releases; a third-party one's are FETCHED
  // from a public index. Declaring a coordinate the org does not publish silently stops security
  // updates reaching every subscriber of it; failing to declare one it does publish hands that
  // coordinate to a public index, where a stranger's package answering `9.9.9` bumps every
  // subscriber onto it.
  //
  // SO CALL IT WITH `dryRun` FIRST. Both verbs return the BLAST RADIUS — every major line the
  // coordinate covers, each line's observed head, and the components subscribed to it — and with
  // `dryRun: true` they compute it and write nothing. That list is unguessable from the request:
  // you name one coordinate and affect repositories you cannot see.
  //
  // WHO MAY CALL THESE: a principal holding `policy:write` AT THE ORG ROOT. Custody of the
  // producing component is deliberately NOT enough (`governance/policy-scope-authz.ts`'s
  // precedent — custody of a row is not jurisdiction over what it reaches). The READ needs only
  // `object:read`.
  //
  // THERE IS NO `producerIdOrUrn: null` FORM. Retraction is its own verb, because a nullable field
  // that switches a call between "declare" and "undeclare" is how an omitted key becomes a
  // destructive default.
  // -----------------------------------------------------------------------------------------
  readonly dependencyProducers = {
    /**
     * DECLARE that a component produces this coordinate. Idempotent.
     *
     * It CLEARS the observed head of every line the coordinate covers, deliberately: a poisoned
     * public head would otherwise survive the very declaration that exists to undo it, and internal
     * detection can never move a head backwards.
     *
     * `declaredByObjectId` is NOT a parameter and must not become one — the server stamps the
     * authenticated subject, because a provenance label the asserter supplies is forgeable.
     *
     * A `service` is REFUSED with a 400 in the first cut: head derivation reads the COMPONENT a
     * production placement names, so a service declaration would do the harmful half (remove the
     * coordinate from polling) and none of the useful half.
     */
    declare: async (
      req: DeclareDependencyLineProducerRequest
    ): Promise<DependencyLineProducerVerbResponse> => {
      const result = await declareDependencyLineProducerRequest({
        client: this.client,
        body: req
      });
      return unwrap(result);
    },
    /**
     * RETRACT the declaration and return the coordinate to third-party polling.
     *
     * It clears the heads too, and this is the direction that matters most: `latestVersion` is an
     * input to the M22 vendor scan rule, so a head left over from the internal era on a coordinate
     * that is third-party again could grant a vendor-pass against a version no registry published.
     *
     * READ `openBumpAuthorships` IN THE RESPONSE. Those are pull requests SCP already opened in
     * other teams' repositories. Retraction stops FUTURE triggers only — SCP does not close them,
     * because asserting it closed a PR it did not close would be a false record.
     */
    retract: async (
      req: RetractDependencyLineProducerRequest
    ): Promise<DependencyLineProducerVerbResponse> => {
      const result = await retractDependencyLineProducerRequest({
        client: this.client,
        body: req
      });
      return unwrap(result);
    },
    /** The org's declarations. Narrowable by ecosystem, or to one exact coordinate compared
     *  VERBATIM. On a field outpost this is EMPTY BY DESIGN — read `dependencyManagement` before
     *  concluding nothing is declared. */
    list: async (
      query: ListDependencyLineProducersQuery = {}
    ): Promise<ListDependencyLineProducersResponse> => {
      const result = await listDependencyLineProducersRequest({ client: this.client, query });
      return unwrap(result);
    }
  };

  // M6: Federation Basics (BUILD_AND_TEST.md §8 M6, DESIGN §13) — `scp federation
  // init/pair/export/import/status`, overlays, hand-fill.
  readonly federation = {
    init: async (
      req: InitFederationRequest
    ): Promise<{ domainId: string; name: string; role: string }> => {
      const result = await initFederationRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    self: async (): Promise<FederationSelfInfo> => {
      const result = await getFederationSelfRequest({ client: this.client });
      return unwrap(result);
    },
    listPeers: async (): Promise<FederationPeer[]> => {
      const result = await listFederationPeersRequest({ client: this.client });
      return unwrap(result);
    },
    pair: async (req: PairPeerRequest): Promise<FederationPeer> => {
      const result = await pairPeerRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** M16.2 phase A (E4) — read one peer (by trust-domain id or name). */
    getPeer: async (id: string): Promise<FederationPeer> => {
      const result = await getFederationPeerRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /** M16.2 phase A (E4) — the NARROW peer update: transport settings only. Carries NO key material,
     *  so it cannot rotate, supersede or revoke a peer key — unlike `pair`, where a different
     *  `publicKey` IS a rotation. Every field is absent-means-preserve; `deliveryTarget: null` clears.
     *  Every pair-time guard still fires (poke-mode⇒mTLS over the merged tuple, the delivery-target
     *  allowlists, the `full`-scope cursor re-anchor). */
    updatePeer: async (id: string, req: UpdateFederationPeerRequest): Promise<FederationPeer> => {
      const result = await updateFederationPeerRequest({
        client: this.client,
        path: { id },
        body: req
      });
      return unwrap(result);
    },
    /** §7.2.6 — resync this domain's replica with a peer after a journal divergence: the sanctioned
     *  recovery (rail 5 refuses a bare re-anchor). Force-overwrites to the exporter's restored reality
     *  and clears the standing divergence. `scp federation resync --peer <exporter>`. */
    resyncPeer: async (id: string): Promise<FederationResyncResult> => {
      const result = await federationResyncPeerRequest({ client: this.client, path: { id } });
      return unwrap(result);
    },
    /** M16.2 phase A (E1) — declare an already-paired outpost's commander-origin config object. It
     *  syncs DOWN to that outpost as a read-only replica (a peer ROW never can — the journal has no
     *  peer-shaped entry kind). */
    createOutpost: async (req: CreateOutpostConfigRequest): Promise<OutpostConfig> => {
      const result = await createOutpostConfigRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    listOutposts: async (): Promise<OutpostConfig[]> => {
      const result = await listOutpostConfigsRequest({ client: this.client });
      return unwrap(result);
    },
    getOutpost: async (peerDomainId: string): Promise<OutpostConfig> => {
      const result = await getOutpostConfigRequest({ client: this.client, path: { peerDomainId } });
      return unwrap(result);
    },
    /** Absent means PRESERVE; there is deliberately no clear-to-unknown verb for `trustTier` in
     *  phase A. On an instance holding the object as a REPLICA this is refused with 409 by the
     *  existing single-writer guard — the commander is the only writer. */
    updateOutpost: async (
      peerDomainId: string,
      req: UpdateOutpostConfigRequest
    ): Promise<OutpostConfig> => {
      const result = await updateOutpostConfigRequest({
        client: this.client,
        path: { peerDomainId },
        body: req
      });
      return unwrap(result);
    },
    /** RECOVERY (review round 4) — restore the 1:1 peer↔config binding for a peer whose database holds
     *  DUPLICATE `outpost` objects (the wedge a pre-narrowing hand-fill could create). Keeps the
     *  authoritative row, ADOPTS an unverified hand-filled shadow when nothing authoritative survives,
     *  and soft-deletes the remaining shadows. Never touches a signature-verified replica. */
    reconcileOutpost: async (
      peerDomainId: string,
      /** N9 — `keep` names the row that should SURVIVE. Absent keeps the most authoritative one, so
       *  the default call is unchanged. It is the ONLY public-API way out of a VERIFIED foreign-origin
       *  duplicate: with it, this domain deletes the row IT authored (an ordinary journaled tombstone).
       *  Deleting a signature-verified replica stays refused unconditionally.
       *
       *  `ifClaimants` is the OPTIMISTIC-CONCURRENCY PRECONDITION — the `objectId:version` token of
       *  every claimant the caller PREVIEWED, from {@link outpostClaimantTokens}. If the live set has
       *  moved since, the call is refused 412 having written NOTHING, and the refusal body carries
       *  the fresh claimants (parse with `OutpostReconcileStaleProblemSchema`, or use
       *  {@link reconcileStaleClaimants}). Omitting it proceeds unchecked, which is the protocol
       *  default for compatibility — not a recommendation. */
      opts: { keep?: string; ifClaimants?: readonly string[] } = {}
    ): Promise<OutpostConfigReconcileResult> => {
      const query = {
        ...(opts.keep !== undefined ? { keep: opts.keep } : {}),
        ...(opts.ifClaimants !== undefined ? { ifClaimant: [...opts.ifClaimants] } : {})
      };
      const result = await reconcileOutpostConfigRequest({
        client: this.client,
        path: { peerDomainId },
        ...(Object.keys(query).length > 0 ? { query } : {})
      });
      return unwrap(result);
    },
    status: async (): Promise<FederationStatusResponse> => {
      const result = await getFederationStatusRequest({ client: this.client });
      return unwrap(result);
    },
    exportSync: async (req: ExportJournalRequest): Promise<SyncBundle> => {
      const result = await exportSyncBundleRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    exportPromotion: async (req: ExportPromotionRequest): Promise<PromotionBundle> => {
      const result = await exportPromotionBundleRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** Verifies + applies either bundle kind (server sniffs `header.kind`) — fail-closed on any
     *  signature/hash-chain check (DESIGN §13). */
    import: async (bundle: ImportBundleRequest): Promise<ImportResult> => {
      const result = await importBundleRequest({ client: this.client, body: bundle });
      return unwrap(result);
    },
    /** M15.5(c) retrans validate-then-relay (ADR-0019 §2), SOURCE side: pull + validate the
     *  imported promotion's authorized artifact bytes and build the signed relay tarball in the
     *  server's `SCP_RELAY_OUT_DIR` drop directory. Role `retrans` only; a failing artifact
     *  refuses fail-closed with a 409 carrying the block `decision_id`. */
    relay: async (req: RelayBuildRequest): Promise<RelayBuildResponse> => {
      const result = await buildRelayTarballRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** M15.5(c) DESTINATION side: verify a relay tarball from the server's `SCP_RELAY_IN_DIR` and
     *  push its artifacts into the local registry by digest (+ re-inspect). The receiving
     *  M17.4(a)+(b) gates still verify everything — zero trust in the relay. */
    relayImport: async (req: RelayImportRequest): Promise<RelayImportResponse> => {
      const result = await importRelayTarballRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** M13.1b operator read surface (owner ask) — the auto-relay build ledger's queue depth and
     *  exhausted rows, `GET /federation/relay-builds`. ROLE-AGNOSTIC: rows exist only on a
     *  `role: retrans` instance (seeded at promotion import there — `relay-builds-repo.ts`'s
     *  `listRelayBuilds` doc); on any other role this returns an empty array rather than a 409,
     *  matching every other read in this codebase. `opts.status` narrows to one bucket; `opts.limit`
     *  is server-bounded (default 100, max 500) — both omitted apply the server defaults. */
    listRelayBuilds: async (
      opts: { status?: RelayBuildStatus; limit?: number } = {}
    ): Promise<RelayBuild[]> => {
      const query = {
        ...(opts.status !== undefined ? { status: opts.status } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {})
      };
      const result = await listFederationRelayBuildsRequest({
        client: this.client,
        ...(Object.keys(query).length > 0 ? { query } : {})
      });
      return unwrap(result).items;
    },
    /** Federation audit witness (multi-region-instance-resilience.md §7.2.7) — what this domain
     *  has passively witnessed of `originDomainId`'s audit-chain head, in chain order. This is the
     *  post-failover peers-witness comparison's read surface (resilience runbook §7.2 step 5):
     *  `scp audit verify` alone is structurally unable to see a truncated chain, since any prefix
     *  of a valid hash chain still verifies. */
    listAuditWitnesses: async (originDomainId: string): Promise<AuditWitness[]> => {
      const result = await listFederationAuditWitnessesRequest({
        client: this.client,
        query: { originDomainId }
      });
      return unwrap(result).items;
    },
    createOverlay: async (req: {
      base: string;
      typeId: string;
      name: string;
      urn?: string;
      properties?: Record<string, unknown>;
      labels?: Record<string, unknown>;
    }) => {
      const result = await createOverlayRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    getMergedOverlayView: async (baseIdOrUrn: string) => {
      const result = await getMergedOverlayViewRequest({
        client: this.client,
        path: { idOrUrn: baseIdOrUrn }
      });
      return unwrap(result);
    },
    handFill: async (req: HandFillRequest) => {
      const result = await handFillObjectRequest({ client: this.client, body: req });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // M7: Real Executor Integrations (BUILD_AND_TEST.md §8 M7, DESIGN §11/§12) — webhook signing
  // secrets, executor/notification bindings, encrypted secrets (write-only), the plugin-manifest
  // catalog, and DiscoveryPlugin run/accept.
  // -----------------------------------------------------------------------------------------

  readonly executors = {
    putBinding: async (
      idOrUrn: string,
      req: CreateExecutorBindingRequest
    ): Promise<ExecutorBinding> => {
      const result = await putExecutorBindingRequest({
        client: this.client,
        path: { idOrUrn },
        body: req
      });
      return unwrap(result);
    },
    /** `type` omitted ⇒ 'configuration' (server-side default) — a target may hold one binding per
     *  Type (M12 P3 / ADR-0007), so reading a non-default pipeline requires naming its Type. */
    getBinding: async (idOrUrn: string, type?: ExecutorType): Promise<ExecutorBinding> => {
      const result = await getExecutorBindingRequest({
        client: this.client,
        path: { idOrUrn },
        ...(type ? { query: { type } } : {})
      });
      return unwrap(result);
    },
    /** Every pipeline bound to a target (all Types) — M12 P5c. Excludes a soft-deleted target's. */
    listBindings: async (idOrUrn: string): Promise<ExecutorBinding[]> => {
      const result = await listExecutorBindingsRequest({ client: this.client, path: { idOrUrn } });
      return unwrap(result).items;
    },
    /** Delete a target's binding for one Type (default 'configuration') — M12 P5c. Returns the removed binding. */
    deleteBinding: async (idOrUrn: string, type?: ExecutorType): Promise<ExecutorBinding> => {
      const result = await deleteExecutorBindingRequest({
        client: this.client,
        path: { idOrUrn },
        ...(type ? { query: { type } } : {})
      });
      return unwrap(result);
    },
    /** Relabel which pipeline a target's binding drives — M12 P5c. `fromType` (default 'configuration')
     *  names the current binding; `toType` is the new routing Type. */
    repurposeBinding: async (
      idOrUrn: string,
      toType: ExecutorType,
      fromType?: ExecutorType
    ): Promise<ExecutorBinding> => {
      const result = await repurposeExecutorBindingRequest({
        client: this.client,
        path: { idOrUrn },
        body: { type: toType },
        ...(fromType ? { query: { type: fromType } } : {})
      });
      return unwrap(result);
    },
    /** Multi-region Argo CD (M15.6, ADR-0017 §3): read + validate a prod environment's per-region
     *  Argo CD set — `prod env -> {region -> argocd binding}`. `type` omitted ⇒ 'configuration'
     *  (Argo CD is GitOps sync). `valid` is false (with per-gap `problems`) if any region lacks its
     *  own Argo CD binding, so a multi-region prod env is never silently deployed against nothing. */
    getRegionalExecutors: async (
      environment: string,
      type?: ExecutorType
    ): Promise<RegionalExecutorView> => {
      const result = await getRegionalExecutorsRequest({
        client: this.client,
        path: { environment },
        ...(type ? { query: { type } } : {})
      });
      return unwrap(result);
    }
  };

  readonly notifications = {
    putBinding: async (
      instanceId: string,
      req: CreateNotificationBindingRequest
    ): Promise<NotificationBinding> => {
      const result = await putNotificationBindingRequest({
        client: this.client,
        path: { instanceId },
        body: req
      });
      return unwrap(result);
    },
    listBindings: async (): Promise<NotificationBindingListResponse> => {
      const result = await listNotificationBindingsRequest({ client: this.client });
      return unwrap(result);
    },
    deleteBinding: async (instanceId: string): Promise<void> => {
      const result = await deleteNotificationBindingRequest({
        client: this.client,
        path: { instanceId }
      });
      unwrapVoid(result);
    }
  };

  readonly secrets = {
    /** Write-only — a stored value is never readable back through the API. */
    put: async (key: string, req: PutSecretRequest): Promise<SecretConfiguredResponse> => {
      const result = await putSecretRequest({ client: this.client, path: { key }, body: req });
      return unwrap(result);
    },
    listKeys: async (): Promise<SecretKeyListResponse> => {
      const result = await listSecretKeysRequest({ client: this.client });
      return unwrap(result);
    },
    delete: async (key: string): Promise<void> => {
      const result = await deleteSecretRequest({ client: this.client, path: { key } });
      unwrapVoid(result);
    }
  };

  readonly plugins = {
    /** Every bundled plugin's `{id, kind, version, configSchema}` — the source a config form is
     *  generated from (DESIGN §11). */
    listManifests: async (): Promise<PluginManifestListResponse> => {
      const result = await listPluginManifestsRequest({ client: this.client });
      return unwrap(result);
    }
  };

  readonly discovery = {
    /** Runs a `DiscoveryPlugin` scan — returns a PROPOSAL only, nothing is written to the graph
     *  (DESIGN §11: "reviewed/accepted into the graph, never auto-committed"). */
    run: async (req: RunDiscoveryRequest): Promise<DiscoveryProposal> => {
      const result = await runDiscoveryRequest({ client: this.client, body: req });
      return unwrap(result);
    },
    /** ADR-0047 — a proposal in, IaC SOURCE out. Writes nothing; the caller commits what comes
     *  back and a normal `scp apply` lands it. This is what replaced `discovery.accept`, and the
     *  shape difference is the point: accept returned created ids, this returns text. */
    scaffold: async (req: ScaffoldDiscoveryRequest): Promise<ScaffoldDiscoveryResponse> => {
      const result = await scaffoldDiscoveryProposalRequest({ client: this.client, body: req });
      return unwrap(result);
    }
  };

  // -----------------------------------------------------------------------------------------
  // The live event stream (`GET /events/stream`, DESIGN §6/§8). Every frame is validated against
  // the contract schema before it is yielded — the generated `responseValidator` runs per frame,
  // exactly as it does per JSON body everywhere else (ADR-0023), which is what closes that ADR's
  // named "not in the spec at all" hole.
  // -----------------------------------------------------------------------------------------

  readonly events = {
    /**
     * The caller's org's events, as an async iterator that reconnects on its own — the SDK
     * replacement for the browser `EventSource` `apps/web` used to open by hand.
     *
     * `sseMaxRetryAttempts: 1` deliberately switches the generated client's internal retry OFF so
     * that one policy in `event-stream.ts` covers BOTH failure modes; the generated loop only ever
     * covered the error one, and a clean server close would otherwise end the stream silently.
     *
     * Pass `signal` to stop: nothing else ends the iteration.
     */
    stream: (options: EventStreamOptions = {}): AsyncGenerator<RelayedEvent, void, void> =>
      resilientEventStream(
        ({ signal, headers, onError }) =>
          streamEventsRequest({
            client: this.client,
            signal,
            headers,
            sseMaxRetryAttempts: 1,
            onSseError: onError
          }),
        options
      )
  };
}

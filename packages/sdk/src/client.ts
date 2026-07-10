import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/index.js";
import {
  login as loginRequest,
  // M2 stage 4 (BUILD_AND_TEST.md §8 M2 item 2) — how the Web UI discovers/ends its httpOnly
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
  createRelationship as createRelationshipRequest,
  listRelationships as listRelationshipsRequest,
  getRelationship as getRelationshipRequest,
  deleteRelationship as deleteRelationshipRequest,
  graphQuery as graphQueryRequest,
  graphTraverse as graphTraverseRequest,
  listAuditEvents as listAuditEventsRequest,
  // M2 typed registries (routes/typed-registries.ts) — 8 resources × create/list/get/update/
  // delete/upsertByUrn, generated from BUILD_AND_TEST.md §8 M2 item 1's operationIds.
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
  createComponent as createComponentRequest,
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
  // M2 stage 2: AuthN expansion (BUILD_AND_TEST.md §8 M2 item 3) — PATs + device authorization
  // flow. Generic OIDC has no SDK surface — it's a browser-redirect flow (routes/oidc.ts).
  createPat as createPatRequest,
  listPats as listPatsRequest,
  revokePat as revokePatRequest,
  startDeviceAuth as startDeviceAuthRequest,
  approveDeviceAuth as approveDeviceAuthRequest,
  pollDeviceAuthToken as pollDeviceAuthTokenRequest,
  // M2 stage 3: `@scp/iac` server-side plan/apply (BUILD_AND_TEST.md §8 M2 item 4).
  createPlan as createPlanRequest,
  getPlan as getPlanRequest,
  applyPlan as applyPlanRequest,
  // M3: the Change lifecycle + Decision records (BUILD_AND_TEST.md §8 M3, routes/changes.ts).
  proposeChange as proposeChangeRequest,
  listChanges as listChangesRequest,
  getChange as getChangeRequest,
  explainChange as explainChangeRequest,
  cancelChange as cancelChangeRequest,
  promoteChange as promoteChangeRequest,
  rollbackChange as rollbackChangeRequest,
  listDecisions as listDecisionsRequest,
  getDecision as getDecisionRequest,
  // M3: webhook ingress + source_mappings correlation config (routes/change-sources.ts).
  ingestChangeSourceWebhook as ingestChangeSourceWebhookRequest,
  createSourceMapping as createSourceMappingRequest,
  listSourceMappings as listSourceMappingsRequest
} from "./generated/sdk.gen.js";
import type {
  ApplyPlanResponse,
  AuditEvent,
  AuditEventListResponse,
  AuthConfig,
  CreateObjectRequest,
  CreateObjectTypeRequest,
  CreateRelationshipRequest,
  CreateRelationshipTypeRequest,
  CreatePatResponse,
  CurrentUser,
  DesiredStateManifest,
  DeviceApproveResponse,
  DeviceStartResponse,
  GraphObject,
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
  TraverseResult,
  UpdateObjectRequest,
  UpsertObjectRequest,
  // M3: the Change lifecycle + Decision records + change sources (BUILD_AND_TEST.md §8 M3).
  Change,
  ChangeListResponse,
  ChangeListQuery,
  ChangeExplainResponse,
  CreateChangeRequest,
  Decision,
  DecisionListResponse,
  DecisionListQuery,
  CreateSourceMappingRequest,
  SourceMapping,
  SourceMappingListResponse,
  WebhookIngressResponse
} from "@scp/schemas";
import { ScpApiError } from "./errors.js";

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

interface TypedObjectFns {
  create: (opts: {
    client: Client;
    body: CreateObjectRequest;
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
    body: UpsertObjectRequest;
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
  // Web UI v1 session discovery (M2 stage 4, BUILD_AND_TEST.md §8 M2 item 2) — `login()` above
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

  // -----------------------------------------------------------------------------------------
  // M0 legacy /objects/service (unchanged contract — DESIGN.md additive-only-within-v1)
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // Runtime type registry (DESIGN.md §4.1)
  // -----------------------------------------------------------------------------------------

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
      }
    };
  }

  /** Pagination iterator over any object type. */
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

  // -----------------------------------------------------------------------------------------
  // Relationships
  // -----------------------------------------------------------------------------------------

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

  private typedResource(fns: TypedObjectFns) {
    return {
      create: async (
        req: CreateObjectRequest,
        opts: { idempotencyKey?: string } = {}
      ): Promise<GraphObject> => {
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
      upsertByUrn: async (urn: string, req: UpsertObjectRequest): Promise<GraphObject> => {
        const result = await fns.upsert({ client: this.client, path: { urn }, body: req });
        return unwrap(result);
      }
    };
  }

  /** `.addOwner()/.listOwners()/.removeOwner()` — valid on domains/services/components/deploymentTargets. */
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
      removeDependsOn: dependsOn.remove
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
      ...this.typedResource({
        create: createComponentRequest,
        list: listComponentsRequest,
        get: getComponentRequest,
        update: updateComponentRequest,
        del: deleteComponentRequest,
        upsert: upsertComponentByUrnRequest
      }),
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
      removeDependsOn: dependsOn.remove
    };
  })();

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

  // -----------------------------------------------------------------------------------------
  // Named graph queries + generic traverse (DESIGN.md §5)
  // -----------------------------------------------------------------------------------------

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
    }
  };

  // -----------------------------------------------------------------------------------------
  // Audit log
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // Personal Access Tokens (M2 stage 2 Part A, BUILD_AND_TEST.md §8 M2 item 3)
  // -----------------------------------------------------------------------------------------

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
  // OIDC device authorization flow (M2 stage 2 Part C) — `.poll()` is a SINGLE poll; callers own
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
  // `@scp/iac` server-side plan/apply (M2 stage 3, BUILD_AND_TEST.md §8 M2 item 4) — the diff
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
  // `scp change propose/promote/rollback/explain` (packages/cli) are thin callers of these,
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
      const result = await cancelChangeRequest({ client: this.client, path: { id }, body: { reason } });
      return unwrap(result);
    },
    /** Promotes a change out of `validating` — the human approval gate before `promoted`. */
    promote: async (id: string, reason?: string): Promise<Change> => {
      const result = await promoteChangeRequest({ client: this.client, path: { id }, body: { reason } });
      return unwrap(result);
    },
    /** Manually triggers a rollback — returns the NEW rollback Change (linked via
     *  `rollbackOfObjectId`), not the original. */
    rollback: async (id: string, reason: string): Promise<Change> => {
      const result = await rollbackChangeRequest({ client: this.client, path: { id }, body: { reason } });
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
    }
  };
}

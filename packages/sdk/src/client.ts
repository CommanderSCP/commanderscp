import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/index.js";
import {
  login as loginRequest,
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
  removeComponentDependsOn as removeComponentDependsOnRequest
} from "./generated/sdk.gen.js";
import type {
  AuditEvent,
  AuditEventListResponse,
  CreateObjectRequest,
  CreateObjectTypeRequest,
  CreateRelationshipRequest,
  CreateRelationshipTypeRequest,
  GraphObject,
  GraphQueryResult,
  NamedGraphQuery,
  ObjectListResponse,
  ObjectType,
  ObjectTypeListResponse,
  Relationship,
  RelationshipListResponse,
  RelationshipType,
  RelationshipTypeListResponse,
  ServiceObject,
  ServiceObjectListResponse,
  TraverseResult,
  UpdateObjectRequest,
  UpsertObjectRequest
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
}

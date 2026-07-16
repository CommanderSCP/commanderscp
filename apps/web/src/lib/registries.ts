import type { ScpClient } from "@scp/sdk";
import type {
  CreateObjectRequest,
  GraphObject,
  ObjectListResponse,
  Relationship,
  RelationshipListResponse,
  UpdateObjectRequest,
  UpsertObjectRequest
} from "@scp/schemas";

/**
 * The 8 typed registries (BUILD_AND_TEST.md §8 M2 item 1, routes/typed-registries.ts) — one
 * config entry drives the generic list/detail/create routes and nav instead of 8 hand-copies,
 * mirroring how the server and SDK already factor this (typed-registries.ts, ownership.ts,
 * ScpClient.typedResource/ownerMethods/edgeMethods in packages/sdk/src/client.ts).
 */
export type RegistryClientKey =
  | "domains"
  | "services"
  | "components"
  | "deploymentTargets"
  | "teams"
  | "groups"
  | "users"
  | "serviceAccounts";

export interface RegistryConfig {
  /** URL segment, e.g. `/deployment-targets`. */
  basePath: string;
  /** Nav/heading label. */
  label: string;
  /** Property name on `ScpClient` (packages/sdk/src/client.ts). */
  clientKey: RegistryClientKey;
  /** `object_types.id` this resource maps to (routes/typed-registries.ts `TYPED_REGISTRY_RESOURCES`). */
  typeId: string;
  /** Has `.addOwner()/.listOwners()/.removeOwner()` — domains/services/components/deploymentTargets only. */
  ownable: boolean;
  /** Has `.addConsumes()/.addDependsOn()` etc — services/components only. */
  edges: boolean;
  /** Create is strict: the object must belong to a service (the create form requires a service, and
   *  passes it to `create({ ..., service })`). Only `component` today (M12 P5a) — mirrors the server's
   *  `SERVICE_MEMBER_OBJECT_TYPE_IDS` in routes/objects-generic.ts. */
  serviceMember?: boolean;
}

export const REGISTRIES: RegistryConfig[] = [
  {
    basePath: "domains",
    label: "Domains",
    clientKey: "domains",
    typeId: "domain",
    ownable: true,
    edges: false
  },
  {
    basePath: "services",
    label: "Services",
    clientKey: "services",
    typeId: "service",
    ownable: true,
    edges: true
  },
  {
    basePath: "components",
    label: "Components",
    clientKey: "components",
    typeId: "component",
    ownable: true,
    edges: true,
    serviceMember: true
  },
  {
    basePath: "deployment-targets",
    label: "Deployment Targets",
    clientKey: "deploymentTargets",
    typeId: "deployment-target",
    ownable: true,
    edges: false
  },
  {
    basePath: "teams",
    label: "Teams",
    clientKey: "teams",
    typeId: "team",
    ownable: false,
    edges: false
  },
  {
    basePath: "groups",
    label: "Groups",
    clientKey: "groups",
    typeId: "group",
    ownable: false,
    edges: false
  },
  {
    basePath: "users",
    label: "Users",
    clientKey: "users",
    typeId: "user",
    ownable: false,
    edges: false
  },
  {
    basePath: "service-accounts",
    label: "Service Accounts",
    clientKey: "serviceAccounts",
    typeId: "service-account",
    ownable: false,
    edges: false
  }
];

export function findRegistry(basePath: string | undefined): RegistryConfig | undefined {
  return REGISTRIES.find((r) => r.basePath === basePath);
}

export function findRegistryByTypeId(typeId: string | undefined): RegistryConfig | undefined {
  return REGISTRIES.find((r) => r.typeId === typeId);
}

export interface ListObjectsQuery {
  cursor?: string;
  limit?: number;
  domainId?: string;
  includeDeleted?: boolean;
}

export interface ListQuery {
  cursor?: string;
  limit?: number;
}

/** Every typed registry resource shares exactly this shape (ScpClient.typedResource). */
export interface TypedResourceClient {
  create: (req: CreateObjectRequest, opts?: { idempotencyKey?: string }) => Promise<GraphObject>;
  list: (query?: ListObjectsQuery) => Promise<ObjectListResponse>;
  get: (idOrUrn: string) => Promise<GraphObject>;
  update: (idOrUrn: string, req: UpdateObjectRequest) => Promise<GraphObject>;
  delete: (idOrUrn: string) => Promise<GraphObject>;
  upsertByUrn: (urn: string, req: UpsertObjectRequest) => Promise<GraphObject>;
}

export interface OwnerCapableClient extends TypedResourceClient {
  addOwner: (
    idOrUrn: string,
    ownerIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ) => Promise<Relationship>;
  listOwners: (idOrUrn: string, query?: ListQuery) => Promise<RelationshipListResponse>;
  removeOwner: (idOrUrn: string, ownerIdOrUrn: string) => Promise<Relationship>;
}

export interface EdgeCapableClient extends OwnerCapableClient {
  addConsumes: (
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ) => Promise<Relationship>;
  listConsumes: (idOrUrn: string, query?: ListQuery) => Promise<RelationshipListResponse>;
  removeConsumes: (idOrUrn: string, targetIdOrUrn: string) => Promise<Relationship>;
  addDependsOn: (
    idOrUrn: string,
    targetIdOrUrn: string,
    opts?: { idempotencyKey?: string }
  ) => Promise<Relationship>;
  listDependsOn: (idOrUrn: string, query?: ListQuery) => Promise<RelationshipListResponse>;
  removeDependsOn: (idOrUrn: string, targetIdOrUrn: string) => Promise<Relationship>;
}

export function getRegistryClient(client: ScpClient, config: RegistryConfig): TypedResourceClient {
  return client[config.clientKey] as unknown as TypedResourceClient;
}

/** Only meaningful when `config.ownable` — callers check that first. */
export function getOwnerClient(client: ScpClient, config: RegistryConfig): OwnerCapableClient {
  return client[config.clientKey] as unknown as OwnerCapableClient;
}

/** Only meaningful when `config.edges` — callers check that first. */
export function getEdgeClient(client: ScpClient, config: RegistryConfig): EdgeCapableClient {
  return client[config.clientKey] as unknown as EdgeCapableClient;
}

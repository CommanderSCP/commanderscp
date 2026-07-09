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

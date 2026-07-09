import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/index.js";
import {
  login as loginRequest,
  listServiceObjects as listServiceObjectsRequest,
  createServiceObject as createServiceObjectRequest,
  listServiceObjectsForOrg as listServiceObjectsForOrgRequest,
  createServiceObjectForOrg as createServiceObjectForOrgRequest
} from "./generated/sdk.gen.js";
import type { ServiceObject, ServiceObjectListResponse } from "@scp/schemas";
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

/**
 * Thin handwritten layer over the `@hey-api/openapi-ts` generated core (DESIGN.md §15): token
 * management (auth) and a cursor-pagination iterator. The CLI and the server-rendered UI stub
 * consume only this class — never a raw `fetch` to the API.
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
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider
} from "fastify-type-provider-zod";
import { badRequest, ProblemError, sendProblem } from "../errors.js";
import type { AppDeps } from "../types.js";
import type { AuthContext } from "../auth/local-auth.js";
import type { AuditWitnessRow } from "../federation/audit-witness-repo.js";

/**
 * `GET /api/v1/federation/audit-witnesses` — the audit-witness READ surface the post-failover
 * runbook's peers-witness comparison (resilience.md §7.2 step 5) depends on.
 *
 * A ROUTE UNIT TEST, not integration: `requireAuth`/`withTenantTx`/`authorize`/
 * `listAuditWitnessesForOrigin` are mocked, and the real `registerFederationRoutes` is exercised
 * through an in-process Fastify instance with the SAME `fastify-type-provider-zod` compilers the
 * real app uses — so this pins the actual schema (the required `originDomainId` query param, the
 * response shape) and the actual wiring (which permission is checked, which repo fn is called,
 * that `witnessedAt` is serialized to an ISO string), not a paraphrase of them.
 */

const mockRequireAuth = vi.fn();
vi.mock("../auth/require-auth.js", () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args)
}));

const mockWithTenantTx = vi.fn();
vi.mock("../db/tenant-tx.js", () => ({
  withTenantTx: (...args: unknown[]) => mockWithTenantTx(...args)
}));

const mockAuthorize = vi.fn();
vi.mock("../authz/resolve.js", () => ({
  authorize: (...args: unknown[]) => mockAuthorize(...args)
}));

const mockListAuditWitnessesForOrigin = vi.fn();
vi.mock("../federation/audit-witness-repo.js", () => ({
  recordAuditWitness: vi.fn(),
  listAuditWitnessesForOrigin: (...args: unknown[]) => mockListAuditWitnessesForOrigin(...args)
}));

const { registerFederationRoutes } = await import("./federation.js");

const AUTH: AuthContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  orgName: "acme",
  username: "operator",
  subjectObjectId: "33333333-3333-4333-8333-333333333333"
};

const WITNESS_ROWS: AuditWitnessRow[] = [
  {
    originDomainId: "44444444-4444-4444-8444-444444444444" as AuditWitnessRow["originDomainId"],
    sequence: 1,
    auditEventId: "55555555-5555-4555-8555-555555555555",
    contentHash: "deadbeef",
    witnessedAt: new Date("2026-08-30T12:00:00.000Z")
  }
];

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProblemError) {
      sendProblem(request, reply, err);
      return;
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      sendProblem(request, reply, badRequest(err.message));
      return;
    }
    sendProblem(request, reply, new ProblemError(500, "Internal Server Error"));
  });
  const deps = { db: {}, config: {} } as unknown as AppDeps;
  registerFederationRoutes(app, deps);
  await app.ready();
  return app;
}

describe("GET /api/v1/federation/audit-witnesses", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockRequireAuth.mockReset();
    mockWithTenantTx.mockReset();
    mockAuthorize.mockReset();
    mockListAuditWitnessesForOrigin.mockReset();
    mockRequireAuth.mockResolvedValue(AUTH);
    mockWithTenantTx.mockImplementation(async (_db: unknown, _orgId: unknown, fn: (tx: unknown) => unknown) =>
      fn({})
    );
    mockAuthorize.mockResolvedValue(undefined);
    mockListAuditWitnessesForOrigin.mockResolvedValue(WITNESS_ROWS);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("checks federation:read at the org root, calls the repo with the query's originDomainId, and returns { items }", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/federation/audit-witnesses?originDomainId=peer-domain-1"
    });

    expect(res.statusCode).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: AUTH.orgId,
        subjectObjectId: AUTH.subjectObjectId,
        permission: "federation:read",
        scopeObjectId: AUTH.orgId
      })
    );
    expect(mockListAuditWitnessesForOrigin).toHaveBeenCalledWith(
      expect.anything(),
      AUTH.orgId,
      "peer-domain-1"
    );
    const body = res.json();
    expect(body).toEqual({
      items: [
        {
          originDomainId: "44444444-4444-4444-8444-444444444444",
          sequence: 1,
          auditEventId: "55555555-5555-4555-8555-555555555555",
          contentHash: "deadbeef",
          // The repo returns a Date (`AuditWitnessRow.witnessedAt`); the route must serialize it
          // to the ISO string the response schema declares (`z.string().datetime()`), never leak
          // the Date object or a non-ISO format through.
          witnessedAt: "2026-08-30T12:00:00.000Z"
        }
      ]
    });
  });

  it("400s when originDomainId is omitted — the query param is required, not optional", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/federation/audit-witnesses" });
    expect(res.statusCode).toBe(400);
    expect(mockListAuditWitnessesForOrigin).not.toHaveBeenCalled();
  });

  it("an empty witness set returns { items: [] }, not a 404", async () => {
    mockListAuditWitnessesForOrigin.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/federation/audit-witnesses?originDomainId=peer-domain-1"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
  });

  it("propagates an authorize() refusal as the same status it throws — never masked into 200", async () => {
    mockAuthorize.mockRejectedValue(new ProblemError(403, "Forbidden", { detail: "no federation:read" }));
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/federation/audit-witnesses?originDomainId=peer-domain-1"
    });
    expect(res.statusCode).toBe(403);
    expect(mockListAuditWitnessesForOrigin).not.toHaveBeenCalled();
  });
});

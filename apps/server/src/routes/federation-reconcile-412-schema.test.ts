import { describe, expect, it, afterEach } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider
} from "fastify-type-provider-zod";
import { OutpostReconcileStaleProblemSchema } from "@scp/schemas";
import { preconditionFailed, ProblemError, sendProblem, badRequest } from "../errors.js";

/**
 * R1 (PR #156 residual) — PINS THE FIX, not the (currently unreachable) live trigger.
 *
 * `OutpostReconcileStaleProblemSchema.claimants` used to be REQUIRED. Reconcile's own
 * `assertClaimantsUnchanged` always throws `preconditionFailed` WITH the `claimants` extension, so
 * this never fired through the real route — but the schema, not the throw site, is the contract
 * the zod serializer enforces: a `preconditionFailed(...)` thrown WITHOUT the extension bag (as
 * `updateObject`'s bare `expectedVersion` 412 does, and as any future 412 on this route would by
 * default) would fail response serialization against a REQUIRED `claimants` and come back as a
 * 500, not a 412.
 *
 * This test reproduces the exact serialization path the real app uses (the same
 * `fastify-type-provider-zod` compilers, an error handler carrying `app.ts`'s branches) around a
 * single throwaway route, rather than the full app + Testcontainers DB — nothing about this
 * failure mode depends on auth, tenancy, or persistence.
 *
 * ONLY THE FIRST BRANCH IS ON THIS TEST'S PATH — measured by instrumenting the handler, not
 * inferred. It is entered exactly ONCE, with the thrown `ProblemError`, and answers 412. The 500
 * then comes from Fastify's own response-serialization failure, which does NOT re-enter the user
 * error handler: no second entry was observed. So neither the catch-all nor `app.ts`'s
 * framework-status branch (`frameworkClientProblem`, `errors.ts`) is exercised here, and copying
 * the rest of `app.ts` in would buy no coverage while creating a second implementation to keep in
 * step.
 */
describe("OutpostReconcileStaleProblemSchema — a bare 412 (no claimants extension) serializes as 412, not 500", () => {
  async function buildMinimalApp() {
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
    app.route({
      method: "POST",
      url: "/probe",
      schema: { response: { 412: OutpostReconcileStaleProblemSchema } },
      handler: async () => {
        // The unreachable-today branch: a 412 with NO extensions attached.
        throw preconditionFailed("stale, no extension attached");
      }
    });
    await app.ready();
    return app;
  }

  let app: Awaited<ReturnType<typeof buildMinimalApp>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("responds 412 (not 500) and omits claimants entirely", async () => {
    app = await buildMinimalApp();
    const res = await app.inject({ method: "POST", url: "/probe" });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(body.claimants).toBeUndefined();
    expect(body.title).toBe("Precondition Failed");
  });
});

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

/** Pins the fix, not the currently unreachable live trigger. See docs/routes.md §186. */
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

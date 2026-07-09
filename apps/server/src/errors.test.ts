import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { ProblemError, toProblem, unauthorized } from "./errors.js";

const fakeRequest = { url: "/api/v1/objects/service" } as FastifyRequest;

describe("RFC 9457 problem mapping", () => {
  it("maps a ProblemError to a problem+json body", () => {
    const problem = toProblem(fakeRequest, unauthorized("missing token"));
    expect(problem).toMatchObject({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "missing token",
      instance: "/api/v1/objects/service"
    });
  });

  it("carries decision_id when present", () => {
    const err = new ProblemError(403, "Forbidden", {
      decisionId: "0198f2a0-0000-7000-8000-000000000002"
    });
    const problem = toProblem(fakeRequest, err);
    expect(problem.decision_id).toBe("0198f2a0-0000-7000-8000-000000000002");
  });
});

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Problem } from "@scp/schemas";

/** RFC 9457 `application/problem+json` error — DESIGN.md §6. */
export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  readonly decisionId?: string;

  constructor(
    status: number,
    title: string,
    opts: { type?: string; detail?: string; decisionId?: string } = {}
  ) {
    super(title);
    this.status = status;
    this.type = opts.type ?? "about:blank";
    this.detail = opts.detail;
    this.decisionId = opts.decisionId;
  }
}

export function unauthorized(detail?: string): ProblemError {
  return new ProblemError(401, "Unauthorized", { detail });
}

export function forbidden(detail?: string): ProblemError {
  return new ProblemError(403, "Forbidden", { detail });
}

export function notFound(detail?: string): ProblemError {
  return new ProblemError(404, "Not Found", { detail });
}

export function badRequest(detail?: string): ProblemError {
  return new ProblemError(400, "Bad Request", { detail });
}

export function conflict(detail?: string): ProblemError {
  return new ProblemError(409, "Conflict", { detail });
}

export function preconditionFailed(detail?: string): ProblemError {
  return new ProblemError(412, "Precondition Failed", { detail });
}

export function unprocessable(detail?: string): ProblemError {
  return new ProblemError(422, "Unprocessable Entity", { detail });
}

export function toProblem(request: FastifyRequest, err: ProblemError): Problem {
  return {
    type: err.type,
    title: err.message,
    status: err.status,
    detail: err.detail,
    instance: request.url,
    decision_id: err.decisionId
  };
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, err: ProblemError): void {
  reply
    .status(err.status)
    .header("content-type", "application/problem+json")
    .send(toProblem(request, err));
}

import { STATUS_CODES } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Problem } from "@scp/schemas";

/** RFC 9457 `application/problem+json` error — DESIGN.md §6. */
export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  readonly decisionId?: string;
  /** RFC 9457 EXTENSION MEMBERS. See docs/server.md §56. */
  readonly extensions?: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    title: string,
    opts: {
      type?: string;
      detail?: string;
      decisionId?: string;
      extensions?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    super(title);
    this.status = status;
    this.type = opts.type ?? "about:blank";
    this.detail = opts.detail;
    this.decisionId = opts.decisionId;
    this.extensions = opts.extensions;
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

/** `decisionId` lets guarded-transition blocks (coordination/transition.ts) carry `decision_id`
 *  on the 409 they turn into — DESIGN.md §6/§10.4: "every blocked response carries a decision_id". */
export function conflict(detail?: string, opts: { decisionId?: string } = {}): ProblemError {
  return new ProblemError(409, "Conflict", { detail, decisionId: opts.decisionId });
}

/** Extensions carry the refusal-specific payload. See docs/server.md §57. */
export function preconditionFailed(
  detail?: string,
  opts: { extensions?: Readonly<Record<string, unknown>> } = {}
): ProblemError {
  return new ProblemError(412, "Precondition Failed", { detail, extensions: opts.extensions });
}

export function unprocessable(detail?: string): ProblemError {
  return new ProblemError(422, "Unprocessable Entity", { detail });
}

/** A per-caller rate limit was exceeded (e.g. federation/poke-rate-limit.ts's per-peer token
 *  bucket) — the excess request is dropped with a clean 429 rather than doing the work. */
export function tooManyRequests(detail?: string): ProblemError {
  return new ProblemError(429, "Too Many Requests", { detail });
}

/** A server-imposed execution bound was hit (e.g. graph/query-timeout.ts's statement_timeout
 *  guardrail) — a clean, typed timeout response rather than a hung connection or a raw 500. */
export function requestTimeout(detail?: string): ProblemError {
  return new ProblemError(408, "Request Timeout", { detail });
}

/** The one marker every framework-built error class carries. See docs/server.md §58. */
const FASTIFY_ERROR_MARKER = Symbol.for("fastify-error-generic");

/** The status a framework-raised client error already carries. See docs/server.md §59. */
export function frameworkClientProblem(err: unknown): ProblemError | undefined {
  if (err === null || typeof err !== "object") return undefined;
  if ((err as Record<symbol, unknown>)[FASTIFY_ERROR_MARKER] !== true) return undefined;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  if (status < 400 || status > 499) return undefined;
  // Title from `node:http`'s registered reason phrases. See docs/server.md §60.
  const detail = err instanceof Error ? err.message : undefined;
  return new ProblemError(status, STATUS_CODES[status] ?? "Error", { detail });
}

/** THE HUMAN-READABLE TEXT OF ANY THROWN VALUE. See docs/server.md §61. */
export function describeError(err: unknown): string {
  if (err instanceof ProblemError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The six fixed members FIRST, extensions spread UNDER them: an extension member can never
 *  overwrite `status`, `title` or `instance`, whatever a caller of `ProblemError` passes. */
export function toProblem(
  request: FastifyRequest,
  err: ProblemError
): Problem & Record<string, unknown> {
  return {
    ...err.extensions,
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

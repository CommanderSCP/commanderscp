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

/** `decisionId` lets guarded-transition blocks (coordination/transition.ts) carry `decision_id`
 *  on the 409 they turn into — DESIGN.md §6/§10.4: "every blocked response carries a decision_id". */
export function conflict(detail?: string, opts: { decisionId?: string } = {}): ProblemError {
  return new ProblemError(409, "Conflict", { detail, decisionId: opts.decisionId });
}

export function preconditionFailed(detail?: string): ProblemError {
  return new ProblemError(412, "Precondition Failed", { detail });
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

/**
 * THE HUMAN-READABLE TEXT OF ANY THROWN VALUE — the one thing to record in a Decision, a control
 * run, an audit payload, or an operator-facing outcome.
 *
 * WHY THIS EXISTS RATHER THAN `err instanceof Error ? err.message : String(err)` (PR #153 review
 * Q3). {@link ProblemError} is constructed `(status, title, opts)` and passes the TITLE to
 * `super()`, so `err.message` on one of these is the bare HTTP title — `"Not Found"`,
 * `"Bad Request"`, `"Conflict"` — while everything informative (WHICH object, WHY it was refused)
 * lives in `detail`. Two consequences, both real and both measured on this branch:
 *
 *  1. EXPLAINABILITY (charter principle 6). A Decision recording `{ error: "Not Found" }` names
 *     neither the offending object nor the reason. `scp change explain` shows the operator an HTTP
 *     status word.
 *  2. AND, SINCE PERSIST-ON-CHANGE, SUPPRESSION. `insertDecisionIfChanged` compares CONTENT, so two
 *     genuinely DIFFERENT faults that both collapse to `"Not Found"` produce a byte-identical
 *     `input_context` — and the second one is correctly suppressed as a restatement. The operator
 *     keeps reading a Decision about the fault that is no longer the problem. Recording `detail`
 *     restores the discrimination the dedupe needs: different faults say different things, so they
 *     write different rows.
 *
 * Falls back to `message` for a `ProblemError` with no `detail`, then to `Error.message`, then to
 * `String(err)` — so it is a drop-in for the idiom it replaces and never returns `undefined`.
 */
export function describeError(err: unknown): string {
  if (err instanceof ProblemError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
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

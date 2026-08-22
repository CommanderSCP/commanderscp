import { STATUS_CODES } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Problem } from "@scp/schemas";

/** RFC 9457 `application/problem+json` error — DESIGN.md §6. */
export class ProblemError extends Error {
  readonly status: number;
  readonly type: string;
  readonly detail?: string;
  readonly decisionId?: string;
  /**
   * RFC 9457 EXTENSION MEMBERS — refusal-specific fields serialized alongside the six fixed ones.
   *
   * WHY THIS EXISTS. Every refusal in this server is a thrown `ProblemError` funnelled through the
   * single `setErrorHandler` (app.ts) into {@link toProblem}, which emitted exactly six fields — so
   * a refusal whose whole value is the DATA it carries had nowhere to put it, and the zod
   * serializer strips anything a route's response schema does not declare. `decision_id` is the
   * in-house precedent for an extension member; this generalizes it rather than adding a second
   * bespoke field per refusal.
   *
   * A member only reaches the wire if the ROUTE declares it for that status (e.g.
   * `412: OutpostReconcileStaleProblemSchema`) — the serializer is still the contract, so an
   * undeclared extension is dropped, not smuggled out.
   */
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

/** `extensions` carries the refusal-specific payload an optimistic-concurrency 412 needs to be
 *  actionable in ONE round trip — e.g. reconcile's fresh `claimants` list, so a caller CAN re-render
 *  a real preview instead of opening a second staleness window re-reading it. That is what
 *  `scp federation outpost reconcile` does (`packages/cli/src/cli.ts`). It is an offer, not a
 *  guarantee every consumer takes: the Outposts web panel (`apps/web/src/routes/
 *  outpost-configuration.tsx`) reads a 412 here only as a signal to refetch, and discards the
 *  carried preview — a second round trip, on purpose, not a defect (R3, PR #156 residual). */
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

/**
 * THE ONE MARKER every error class built by `@fastify/error` carries — Fastify's own `createError`
 * defines it on the error PROTOTYPE (non-enumerable, non-writable) and uses it for its
 * `Symbol.hasInstance`. `Symbol.for` is the cross-realm registry, so this matches errors from
 * Fastify core AND from any plugin that builds its errors the same way, without importing
 * `@fastify/error` (which is not a direct dependency here — charter principle 5, no new dependency).
 */
const FASTIFY_ERROR_MARKER = Symbol.for("fastify-error-generic");

/**
 * THE STATUS A FRAMEWORK-RAISED CLIENT ERROR ALREADY CARRIES, or `undefined` if this is not one.
 *
 * WHY THIS EXISTS (the census this repo's rules demand). `setErrorHandler` in `app.ts` ignored
 * `err.statusCode` outright, so EVERY error Fastify raises before a route handler runs became a
 * 500. The prototype-poisoning fix repaired exactly one member of that class — a raw `SyntaxError`
 * from the replacement JSON parser — by throwing a `ProblemError` instead. Measured on the branch
 * that shipped that repair, through the real `buildApp`:
 *
 *   | request                                  | was | is  | Fastify error                       |
 *   |------------------------------------------|-----|-----|-------------------------------------|
 *   | body with NO `content-type`              | 500 | 415 | `FST_ERR_CTP_INVALID_MEDIA_TYPE`    |
 *   | `content-type: application/xml`          | 500 | 415 | `FST_ERR_CTP_INVALID_MEDIA_TYPE`    |
 *   | `content-length` larger than the body    | 500 | 400 | `FST_ERR_CTP_INVALID_CONTENT_LENGTH`|
 *   | body over the 64 MiB `bodyLimit`         | 500 | 413 | `FST_ERR_CTP_BODY_TOO_LARGE`        |
 *
 * Two more members of the class were already correct and are listed so the census is complete
 * rather than filtered: `FST_ERR_CTP_EMPTY_JSON_BODY` and `FST_ERR_CTP_INVALID_JSON_BODY` cannot
 * fire at all, because `app.ts` replaces the JSON parser and handles both itself (empty -> the
 * deliberate `undefined` divergence; malformed -> `badRequest`). `FST_ERR_VALIDATION` (400,
 * missing/invalid params) is caught one branch earlier by `hasZodFastifySchemaValidationErrors`.
 * A request timeout is NOT in the class: neither `requestTimeout` nor `connectionTimeout` is set,
 * and Node's own socket timeout destroys the connection without raising into the error handler.
 * `FST_ERR_BAD_URL` (400) and `FST_ERR_MAX_PARAM_LENGTH` (414) are raised by the router BEFORE the
 * request lifecycle starts, so `setErrorHandler` never sees them; measured, `/__probe/%zz` already
 * answers 400 — with Fastify's default error shape rather than `application/problem+json`. That
 * body-shape divergence is real, is not a status defect, and is left alone here.
 *
 * WHY THIS IS NOT `err.statusCode >= 400 && err.statusCode < 500`, WHICH IS THE OBVIOUS SPELLING.
 * `statusCode` is not a Fastify-owned property name. `undici` — a direct dependency of this
 * package, used by the executor plugins — sets `statusCode` on `ResponseError` and
 * `RequestRetryError` from the UPSTREAM response's status, alongside `.body` and `.headers` from
 * that upstream. Honouring `statusCode` blindly would let an Argo CD 403 escaping a plugin become
 * SCP's OWN 403, with the upstream's message in `detail`: a wrong answer and a disclosure in one.
 * The marker restricts this to errors the framework itself minted, whose messages are fixed
 * templates over client-supplied input.
 *
 * 5xx framework errors (`FST_ERR_CTP_INVALID_TYPE` and friends — all local misconfiguration) are
 * deliberately NOT honoured and fall through to the catch-all, so honouring `statusCode` never
 * turns into honouring `message` for a server fault.
 */
export function frameworkClientProblem(err: unknown): ProblemError | undefined {
  if (err === null || typeof err !== "object") return undefined;
  if ((err as Record<symbol, unknown>)[FASTIFY_ERROR_MARKER] !== true) return undefined;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  if (status < 400 || status > 499) return undefined;
  // Title from `node:http`'s registered reason phrases — no table of our own to drift, and it
  // already agrees with the titles the helpers above hand-write ("Bad Request", "Not Found",
  // "Unprocessable Entity", ...). Detail is the framework's own message, which for these classes
  // is a fixed template over client-supplied input ("Unsupported Media Type: application/xml").
  // Returning the whole `ProblemError` rather than a bare number keeps that judgement HERE, next
  // to the reasoning for it, instead of leaving the caller to reach into `err.message` itself.
  const detail = err instanceof Error ? err.message : undefined;
  return new ProblemError(status, STATUS_CODES[status] ?? "Error", { detail });
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

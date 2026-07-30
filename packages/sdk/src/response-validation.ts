import type { Client, ResolvedRequestOptions } from "./generated/client/index.js";
import { ScpResponseValidationError, type ResponseValidationIssue } from "./errors.js";

/**
 * Turns the generated client's per-operation response validator into a single, diagnosable
 * boundary failure (ADR-0023).
 *
 * `@hey-api/openapi-ts` emits `responseValidator: (data) => zXxxResponse.parseAsync(data)` on EVERY
 * operation (see `packages/sdk/openapi-ts.config.ts`), and `client.gen.ts` awaits it on the 2xx
 * JSON path. When it rejects, the generated client swallows the rejection into its normal error
 * channel — a bare `ZodError` with no indication of WHICH call produced it. This error interceptor
 * runs inside that same catch, where the resolved request options still carry the operation's
 * templated URL and method, and rewrites the `ZodError` into an {@link ScpResponseValidationError}
 * naming operation + field. Every other error (RFC 9457 problem bodies, network failures) passes
 * through untouched.
 */

/** The subset of a zod `ZodError` this module reads. Matched structurally so that the check does
 *  not depend on a single zod module instance being shared across the dependency graph. */
interface ValidationErrorLike {
  readonly name?: unknown;
  readonly issues?: unknown;
}

interface RawIssue {
  readonly path?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

function isValidationError(error: unknown): error is Required<ValidationErrorLike> {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as ValidationErrorLike;
  // `ZodError` (zod 3 and 4) is the only thing `responseValidator` can reject with, but match on
  // the shape rather than `instanceof` so a duplicated zod instance can't silently opt out.
  return Array.isArray(candidate.issues) && String(candidate.name ?? "").endsWith("ZodError");
}

function issuePath(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return "<root>";
  return raw.map((segment) => String(segment)).join(".");
}

function toIssues(error: Required<ValidationErrorLike>): ResponseValidationIssue[] {
  return (error.issues as RawIssue[]).map((issue) => ({
    path: issuePath(issue.path),
    message: typeof issue.message === "string" ? issue.message : "invalid value",
    code: typeof issue.code === "string" ? issue.code : undefined
  }));
}

/**
 * Registers the boundary translation on `client`. Called once per {@link ScpClient} construction —
 * every generated operation goes through this one client, so there is no per-call-site wiring and
 * no operation can be forgotten.
 */
export function installResponseValidationErrors(client: Client): void {
  client.interceptors.error.use(
    (
      error: unknown,
      response: Response | undefined,
      _request: Request | undefined,
      options: ResolvedRequestOptions
    ) => {
      if (!isValidationError(error)) return error;
      return new ScpResponseValidationError({
        method: String(options.method ?? "UNKNOWN").toUpperCase(),
        path: String(options.url ?? "unknown"),
        status: response?.status,
        issues: toIssues(error),
        cause: error
      });
    }
  );
}

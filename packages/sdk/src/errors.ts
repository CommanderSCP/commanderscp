import { OutpostReconcileStaleProblemSchema } from "@scp/schemas";
import type { OutpostConfig, Problem } from "@scp/schemas";

/** An RFC 9457 problem AS RECEIVED. See docs/sdk.md §52. */
export type ProblemWithExtensions = Problem & Record<string, unknown>;

/** Thrown by {@link ScpClient} methods when the API returns an RFC 9457 problem response. */
export class ScpApiError extends Error {
  readonly status?: number;
  readonly problem?: ProblemWithExtensions;

  constructor(message: string, opts: { status?: number; problem?: ProblemWithExtensions } = {}) {
    super(message);
    this.name = "ScpApiError";
    this.status = opts.status;
    this.problem = opts.problem;
  }
}

/** The fresh claimant list off a 412, as a typed helper. See docs/sdk.md §53. */
export function reconcileStaleClaimants(err: unknown): OutpostConfig[] | null {
  if (!(err instanceof ScpApiError) || err.status !== 412) return null;
  const parsed = OutpostReconcileStaleProblemSchema.safeParse(err.problem);
  return parsed.success ? (parsed.data.claimants ?? null) : null;
}

/** One field of a 2xx response body that did not match the OpenAPI contract. */
export interface ResponseValidationIssue {
  /** Dot/index path INSIDE the response body, e.g. `peers.0.syncScope`. `<root>` for the body itself. */
  path: string;
  message: string;
  code?: string;
}

/** How many issues the message enumerates before it summarizes the rest. */
const MAX_LISTED_ISSUES = 5;

function describeIssues(issues: readonly ResponseValidationIssue[]): string {
  if (issues.length === 0) return "the response body did not match the contract";
  const listed = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `${issue.path} (${issue.code ?? "invalid"}: ${issue.message})`)
    .join(", ");
  const rest = issues.length - MAX_LISTED_ISSUES;
  return rest > 0 ? `${listed}, and ${rest} more field(s)` : listed;
}

/** Thrown when a 2xx body does not match the generated contract. See docs/sdk.md §54. */
export class ScpResponseValidationError extends Error {
  /** `GET /federation/status` — the OpenAPI coordinates (method + templated path) of the call. */
  readonly operation: string;
  readonly method: string;
  /** Templated request path as declared in the OpenAPI document, e.g. `/federation/peers/{id}`. */
  readonly path: string;
  /** HTTP status of the (successful) response whose body failed validation. */
  readonly status?: number;
  readonly issues: readonly ResponseValidationIssue[];

  constructor(opts: {
    method: string;
    path: string;
    status?: number;
    issues: readonly ResponseValidationIssue[];
    cause?: unknown;
  }) {
    const operation = `${opts.method} ${opts.path}`;
    super(
      `CommanderSCP API response failed contract validation for ${operation}` +
        `${opts.status === undefined ? "" : ` (HTTP ${opts.status})`}: ` +
        `${describeIssues(opts.issues)}. The instance returned a body that does not match the ` +
        `OpenAPI contract this SDK was generated from — most likely a version skew between this ` +
        `client and the instance.`,
      { cause: opts.cause }
    );
    this.name = "ScpResponseValidationError";
    this.operation = operation;
    this.method = opts.method;
    this.path = opts.path;
    this.status = opts.status;
    this.issues = opts.issues;
  }
}

import { OutpostReconcileStaleProblemSchema } from "@scp/schemas";
import type { OutpostConfig, Problem } from "@scp/schemas";

/**
 * An RFC 9457 problem AS RECEIVED — the six fixed members plus whatever EXTENSION MEMBERS the
 * refusal declared. Extensions are how a refusal ships the data that makes it actionable
 * (`decision_id` on a governance block; `claimants` on reconcile's stale-precondition 412), and the
 * bare `Problem` type erased every one of them: the member arrived at runtime and vanished at
 * compile time, so consumers either cast blindly or silently dropped it. Members are typed
 * `unknown` on purpose — a caller narrows the one it expects with that refusal's own schema (e.g.
 * `OutpostReconcileStaleProblemSchema`), which is a real check rather than an assertion.
 */
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

/**
 * THE FRESH CLAIMANT LIST OFF A 412 from `POST /federation/outposts/{peer}/reconcile`, or `null`
 * when the error is anything else.
 *
 * WHY A HELPER RATHER THAN `(err.problem as any).claimants`. The extension member is typed
 * `unknown` on {@link ProblemWithExtensions} deliberately, and every consumer that wants to
 * RE-RENDER A PREVIEW from the refusal (the Outposts panel, `scp federation outpost reconcile`)
 * would otherwise cast it — the cast is the exact move that turns a wire shape nobody checked into
 * a UI nobody can trust. This narrows with the refusal's OWN schema, so a body that does not carry
 * a well-formed claimant list reads as `null` (present the plain `detail`) rather than as an empty
 * preview, which would tell the operator "nothing claims this peer" — the one thing a stale-claimant
 * refusal never means.
 *
 * `claimants` is OPTIONAL on the schema (R1, PR #156 residual) — a 412 this route has never
 * actually thrown yet, but could, carries no extension at all. `?? null` folds that case into the
 * same "no preview to render" answer a schema mismatch gets, for the same reason: an absent list is
 * not an empty one.
 */
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

/**
 * Thrown by {@link ScpClient} when a 2xx response body does NOT match the OpenAPI contract the SDK
 * was generated from (ADR-0023) — a required field is absent, a discriminated union has no
 * matching branch, etc.
 *
 * This exists so that a version skew between a client and an instance fails ONCE, at the SDK
 * boundary, naming BOTH the operation and the offending field(s) — instead of surfacing much later
 * as a bare `TypeError: Cannot read properties of undefined` inside whichever component happened to
 * dereference the missing field first.
 */
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

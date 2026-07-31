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

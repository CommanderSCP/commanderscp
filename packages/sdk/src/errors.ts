import type { Problem } from "@scp/schemas";

/** Thrown by {@link ScpClient} methods when the API returns an RFC 9457 problem response. */
export class ScpApiError extends Error {
  readonly status?: number;
  readonly problem?: Problem;

  constructor(message: string, opts: { status?: number; problem?: Problem } = {}) {
    super(message);
    this.name = "ScpApiError";
    this.status = opts.status;
    this.problem = opts.problem;
  }
}

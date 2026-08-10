import { z } from "zod";

/**
 * `GET /api/v1/doctor` — the operational self-check surface behind `scp doctor`.
 *
 * READ-ONLY, and deliberately so: every check here reports a condition whose remedy depends on
 * which side of a mismatch is wrong, which is an operator decision, not a platform one. There is no
 * companion repair endpoint for the same reason `GET /graph/integrity` has none — a bulk-repair door
 * would be a second, cheaper way to mutate state that skips the audit event and journal entry the
 * ordinary doors write (charter principle 6).
 *
 * A LIST of checks rather than one bespoke payload because more of them are already queued behind
 * this: ADR-0003 names `scp doctor` as the read-only surface for a deployment's executor-egress
 * allowance, and docs/proposals/coupled-pipelines.md names it for "a required key with no
 * prospective producer". Those arrive as additional entries, not as new endpoints.
 */

/** `warn` is the only non-ok status today; anything a check can only ever *report* stays `ok`. */
export const DoctorCheckStatusSchema = z.enum(["ok", "warn"]);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;

export const DoctorCheckSchema = z.object({
  /** Stable machine id, e.g. `federation-self-origin` — safe to alert on, unlike the prose below. */
  id: z.string(),
  status: DoctorCheckStatusSchema,
  /** One line, for a table row. */
  summary: z.string(),
  /**
   * The full operator-facing explanation, newline-separated: what is wrong, why it is silent, how it
   * happens, and what to do. Authored server-side so the boot log, this endpoint and `scp doctor`
   * cannot drift from each other.
   */
  detail: z.string()
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z.object({
  checks: z.array(DoctorCheckSchema)
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

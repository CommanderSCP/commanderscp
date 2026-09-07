import { z } from "zod";

/** The operational self-check surface behind the command. See docs/schemas.md §173. */

/** `warn` is the only non-ok status today; anything a check can only ever *report* stays `ok`. */
export const DoctorCheckStatusSchema = z.enum(["ok", "warn"]);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;

export const DoctorCheckSchema = z.object({
  /** Stable machine id, e.g. `federation-self-origin` — safe to alert on, unlike the prose below. */
  id: z.string(),
  status: DoctorCheckStatusSchema,
  summary: z.string(),
  /** The full operator-facing explanation, newline-separated. See docs/schemas.md §174. */
  detail: z.string()
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorReportSchema = z.object({
  checks: z.array(DoctorCheckSchema)
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

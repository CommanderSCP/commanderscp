import { z } from "zod";

/**
 * RFC 9457 (application/problem+json) error body — DESIGN.md §6.
 * Every policy/gate-blocked 4xx also carries `decision_id`; that field is unused before the
 * Governance Engine (M4) but reserved here so the contract never needs a breaking change.
 */
export const ProblemSchema = z.object({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  decision_id: z.string().uuid().optional()
});
export type Problem = z.infer<typeof ProblemSchema>;

/** Cursor-based pagination query — DESIGN.md §6. */
export const CursorPageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});
export type CursorPageQuery = z.infer<typeof CursorPageQuerySchema>;

/** Cursor-based pagination envelope, parameterized by item schema. */
export function cursorPageResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable()
  });
}

/** Explicit `/orgs/{org}` path override — DESIGN.md §6. */
export const OrgParamSchema = z.object({
  org: z.string().min(1)
});
export type OrgParam = z.infer<typeof OrgParamSchema>;

/**
 * A query-string array parameter (e.g. `?relTypes=a&relTypes=b`). Most Node querystring parsers
 * (including Fastify's default) only produce a real array when the key repeats 2+ times — a
 * single `?relTypes=a` parses as the bare string `"a"`, which `z.array(z.string())` alone would
 * reject. This normalizes both shapes before validating.
 */
export function stringArrayQueryParam() {
  return z.preprocess(
    (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]),
    z.array(z.string())
  );
}

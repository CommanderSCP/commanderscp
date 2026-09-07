import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";

/** Hash-chained append-only audit log wire contract. See docs/schemas.md §5. */

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  domainId: z.string().uuid().nullable(),
  actorId: z.string().uuid(),
  action: z.string(),
  subjectId: z.string().uuid().nullable(),
  beforeHash: z.string().nullable(),
  afterHash: z.string().nullable(),
  reason: z.string().nullable(),
  decisionId: z.string().uuid().nullable(),
  requestId: z.string(),
  occurredAt: z.string().datetime(),
  prevHash: z.string(),
  rowHash: z.string()
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditEventListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
export type AuditEventListQuery = z.infer<typeof AuditEventListQuerySchema>;

export const AuditEventListResponseSchema = cursorPageResponseSchema(AuditEventSchema);
export type AuditEventListResponse = z.infer<typeof AuditEventListResponseSchema>;

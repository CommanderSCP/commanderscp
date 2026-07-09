import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";

/**
 * `service` object — M0's minimal slice of the full graph object model (DESIGN.md §4.1).
 * The real generic `objects`/`object_types` registry lands in M1; M0 ships just enough of the
 * shape (id, org scoping, type discriminator, name, timestamp) to prove the contract pipeline
 * end to end without building the whole graph substrate early.
 */
export const ServiceObjectSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  type: z.literal("service"),
  name: z.string(),
  createdAt: z.string().datetime()
});
export type ServiceObject = z.infer<typeof ServiceObjectSchema>;

export const CreateServiceObjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  // Additive (DESIGN.md §6 "additive-only within v1") — M0 clients that send only `name` are
  // unaffected. Added so `/objects/service` (kept at its M0 path/shape) has the same write
  // capability as the generic `/objects/{type}` endpoint it's now a thin wrapper over
  // (apps/server/src/services/objects-service.ts) — Fastify's router prefers this literal
  // static route over the parametric `/objects/:type` for the exact path `/objects/service`,
  // so without this, custom domainId/properties/labels/id/urn would be silently dropped for
  // the 'service' type specifically.
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional()
});
export type CreateServiceObjectRequest = z.infer<typeof CreateServiceObjectRequestSchema>;

export const ServiceObjectListResponseSchema = cursorPageResponseSchema(ServiceObjectSchema);
export type ServiceObjectListResponse = z.infer<typeof ServiceObjectListResponseSchema>;

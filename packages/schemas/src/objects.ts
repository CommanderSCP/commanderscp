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
  name: z.string().min(1).max(200)
});
export type CreateServiceObjectRequest = z.infer<typeof CreateServiceObjectRequestSchema>;

export const ServiceObjectListResponseSchema = cursorPageResponseSchema(ServiceObjectSchema);
export type ServiceObjectListResponse = z.infer<typeof ServiceObjectListResponseSchema>;

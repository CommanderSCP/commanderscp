import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";
import { GraphObjectSchema } from "./graph.js";

/** The service object, the minimal slice of the model. See docs/schemas.md §329. */
export const ServiceObjectSchema = GraphObjectSchema.extend({
  type: z.literal("service")
});
export type ServiceObject = z.infer<typeof ServiceObjectSchema>;

export const CreateServiceObjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  // Additive (DESIGN.md §6 "additive-only within v1"). See docs/schemas.md §330.
  id: z.string().uuid().optional(),
  urn: z.string().optional(),
  domainId: z.string().uuid().nullable().optional(),
  /** A second instance of exactly the hazard named above. See docs/schemas.md §331. */
  domainLocal: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional()
});
export type CreateServiceObjectRequest = z.infer<typeof CreateServiceObjectRequestSchema>;

export const ServiceObjectListResponseSchema = cursorPageResponseSchema(ServiceObjectSchema);
export type ServiceObjectListResponse = z.infer<typeof ServiceObjectListResponseSchema>;

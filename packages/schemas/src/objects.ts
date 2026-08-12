import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";
import { GraphObjectSchema } from "./graph.js";

/**
 * `service` object — M0's minimal slice of the full graph object model (DESIGN.md §4.1).
 * The real generic `objects`/`object_types` registry lands in M1; M0 ships just enough of the
 * shape (id, org scoping, type discriminator, name, timestamp) to prove the contract pipeline
 * end to end without building the whole graph substrate early.
 *
 * ADR-0023 (the first violation SDK response validation caught): this is now the FULL
 * `GraphObject` plus M0's `type` discriminator, not a five-field subset. Fastify's router prefers
 * the literal static route `POST/GET /objects/service` over the parametric `/objects/:type`, so
 * that handler is the only one that ever runs for the exact path `/objects/service` — while the
 * SDK's `client.object("service")` calls the GENERIC `createObject`/`listObjects` operations,
 * whose declared response is a full `GraphObject`. The narrow shape therefore meant
 * `client.object("service").create(...).urn` (and `.typeId`, `.domainId`, `.properties`,
 * `.labels`, `.version`, …) was `undefined` at runtime while TypeScript insisted it was a string
 * — the exact bug class ADR-0023 exists to stop. Widening is additive within /v1 (response
 * properties added, none removed or renamed; `type` is kept) and costs nothing: the underlying
 * row is already a plain `service`-typed graph object, so every field was there to begin with.
 */
export const ServiceObjectSchema = GraphObjectSchema.extend({
  type: z.literal("service")
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
  /**
   * M20.1 (ADR-0031 §1) — and a second instance of exactly the hazard the comment above names.
   *
   * That comment records that this shadowing route silently dropped `domainId`/`properties`/
   * `labels`/`id`/`urn` for the `service` type until they were added here. `domainLocal` was added
   * to `CreateObjectRequestSchema` and was dropped the same way, for the same reason — Fastify
   * prefers this literal route over the parametric one — until
   * `domain-local-rbac.integration.test.ts`'s contract-derived census caught it.
   *
   * Per CLAUDE.md: a well-written comment naming a hazard is a signal to sweep, not evidence the
   * hazard was handled. Any future field added to the generic create body must be added here too.
   */
  domainLocal: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  labels: z.record(z.string(), z.unknown()).optional()
});
export type CreateServiceObjectRequest = z.infer<typeof CreateServiceObjectRequestSchema>;

export const ServiceObjectListResponseSchema = cursorPageResponseSchema(ServiceObjectSchema);
export type ServiceObjectListResponse = z.infer<typeof ServiceObjectListResponseSchema>;

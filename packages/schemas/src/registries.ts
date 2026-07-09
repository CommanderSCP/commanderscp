import { z } from "zod";

/**
 * M2 typed-registry ergonomics (BUILD_AND_TEST.md §8 M2 item 1). The typed convenience endpoints
 * (routes/typed-registries.ts) and their `owns`/`consumes`/`depends_on` sub-resources
 * (routes/ownership.ts) are structurally identical to the generic `/objects/{type}` and
 * `/relationships` endpoints — they reuse `GraphObjectSchema`, `CreateObjectRequestSchema`,
 * `UpdateObjectRequestSchema`, `UpsertObjectRequestSchema`, `ObjectListResponseSchema`,
 * `RelationshipSchema`, and `RelationshipListResponseSchema` directly (graph.ts). This file only
 * adds the handful of shapes that don't exist yet: the ownership/consumes/depends-on request
 * bodies, and path params for routes with a second id-or-urn segment in the URL.
 */

/** `POST /{basePath}/{idOrUrn}/owners` body — the owner's type is resolved at write time. */
export const AddOwnerRequestSchema = z.object({
  ownerIdOrUrn: z.string().min(1)
});
export type AddOwnerRequest = z.infer<typeof AddOwnerRequestSchema>;

/** `POST /{basePath}/{idOrUrn}/consumes|depends-on` body — shared shape for both edge types. */
export const AddRelationshipTargetRequestSchema = z.object({
  targetIdOrUrn: z.string().min(1)
});
export type AddRelationshipTargetRequest = z.infer<typeof AddRelationshipTargetRequestSchema>;

/** Path params for a typed-registry resource route mounted at a fixed base path (type is not a param). */
export const RegistryIdOrUrnParamSchema = z.object({ idOrUrn: z.string().min(1) });

/** Path params for the `PUT /{basePath}/{urn}` typed upsert-by-URN route. */
export const RegistryUrnParamSchema = z.object({ urn: z.string().min(1) });

/** Path params for `DELETE /{basePath}/{idOrUrn}/owners/{ownerIdOrUrn}` — modeled on ObjectIdOrUrnParamSchema. */
export const RegistryOwnerParamSchema = z.object({
  idOrUrn: z.string().min(1),
  ownerIdOrUrn: z.string().min(1)
});

/** Path params for `DELETE /{basePath}/{idOrUrn}/consumes|depends-on/{targetIdOrUrn}`. */
export const RegistryTargetParamSchema = z.object({
  idOrUrn: z.string().min(1),
  targetIdOrUrn: z.string().min(1)
});

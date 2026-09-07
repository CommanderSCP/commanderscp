import { z } from "zod";

/** M2 typed-registry ergonomics. See docs/schemas.md §378. */

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

export const RegistryTargetParamSchema = z.object({
  idOrUrn: z.string().min(1),
  targetIdOrUrn: z.string().min(1)
});

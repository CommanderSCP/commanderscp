import { z } from "zod";
import { JsonRecordSchema, UrnSchema } from "./graph.js";

/**
 * `@scp/iac` desired-state manifest contract (DESIGN.md §15, BUILD_AND_TEST.md §8 M2 item 4).
 * CDK-style constructs (`packages/iac`) synthesize a value conforming to
 * `DesiredStateManifestSchema` via a PURE function — no API calls, no randomness, no wall-clock
 * reads — so the manifest is the one interchange point between IaC authoring (offline, air-gap
 * safe) and server-side reconciliation (`POST /plans`). Objects and relationships are addressed
 * by URN, never by a synth-time-random id, which is exactly what makes two independent synths of
 * an equivalent construct tree converge to byte-identical JSON.
 *
 * Lives in `@scp/schemas` (not `@scp/iac`) so both the IaC package (producer) and the server
 * (consumer, `apps/server/src/iac/plan-diff.ts`) share one contract — same rationale as every
 * other shape in this package (DESIGN.md §6, §15: "Zod schemas flow untranslated from the server
 * to the generated SDK and IaC").
 */

export const ManifestObjectSchema = z.object({
  urn: UrnSchema,
  typeId: z.string().min(1),
  name: z.string().min(1).max(500),
  /** Object id this URN's containing domain resolves to; `undefined`/omitted defaults to the org root, same as `CreateObjectRequestSchema.domainId` (graph.ts). */
  domainId: z.string().uuid().nullable().optional(),
  properties: JsonRecordSchema.optional(),
  labels: JsonRecordSchema.optional()
});
export type ManifestObject = z.infer<typeof ManifestObjectSchema>;

export const ManifestRelationshipSchema = z.object({
  typeId: z.string().min(1),
  fromUrn: UrnSchema,
  toUrn: UrnSchema,
  properties: JsonRecordSchema.optional()
});
export type ManifestRelationship = z.infer<typeof ManifestRelationshipSchema>;

export const DesiredStateManifestSchema = z.object({
  /** Deployable-unit label — becomes the `scp:stack` managed-by marker (plan-diff.ts) that scopes pruning. */
  stackName: z.string().min(1),
  objects: z.array(ManifestObjectSchema),
  relationships: z.array(ManifestRelationshipSchema)
});
export type DesiredStateManifest = z.infer<typeof DesiredStateManifestSchema>;

// ---------------------------------------------------------------------------------------------
// Server-side plan/apply (`apps/server/src/routes/plans.ts`)
// ---------------------------------------------------------------------------------------------

export const PlanActionSchema = z.enum(["create", "update", "delete", "noop"]);
export type PlanAction = z.infer<typeof PlanActionSchema>;

/** The full desired-state row a `create`/`update` entry will write — labels already include the merged `scp:managed-by`/`scp:stack` markers (plan-diff.ts). */
export const PlanObjectTargetSchema = z.object({
  urn: UrnSchema,
  typeId: z.string(),
  name: z.string(),
  domainId: z.string().uuid().nullable(),
  properties: JsonRecordSchema,
  labels: JsonRecordSchema
});
export type PlanObjectTarget = z.infer<typeof PlanObjectTargetSchema>;

export const PlanObjectDiffEntrySchema = z.object({
  kind: z.literal("object"),
  action: PlanActionSchema,
  urn: UrnSchema,
  typeId: z.string(),
  reason: z.string(),
  /** Present for `create`/`update` only. */
  target: PlanObjectTargetSchema.optional()
});
export type PlanObjectDiffEntry = z.infer<typeof PlanObjectDiffEntrySchema>;

export const PlanRelationshipDiffEntrySchema = z.object({
  kind: z.literal("relationship"),
  action: z.enum(["create", "delete", "noop"]),
  typeId: z.string(),
  fromUrn: UrnSchema,
  toUrn: UrnSchema,
  reason: z.string()
});
export type PlanRelationshipDiffEntry = z.infer<typeof PlanRelationshipDiffEntrySchema>;

export const PlanDiffSummarySchema = z.object({
  creates: z.number().int(),
  updates: z.number().int(),
  deletes: z.number().int(),
  noops: z.number().int()
});
export type PlanDiffSummary = z.infer<typeof PlanDiffSummarySchema>;

export const PlanDiffSchema = z.object({
  objects: z.array(PlanObjectDiffEntrySchema),
  relationships: z.array(PlanRelationshipDiffEntrySchema),
  summary: PlanDiffSummarySchema
});
export type PlanDiff = z.infer<typeof PlanDiffSchema>;

export const PlanStatusSchema = z.enum(["pending", "applied", "stale"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  actorId: z.string().uuid(),
  stackName: z.string(),
  manifest: DesiredStateManifestSchema,
  diff: PlanDiffSchema,
  status: PlanStatusSchema,
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable()
});
export type Plan = z.infer<typeof PlanSchema>;

export const CreatePlanRequestSchema = z.object({
  manifest: DesiredStateManifestSchema
});
export type CreatePlanRequest = z.infer<typeof CreatePlanRequestSchema>;

export const PlanIdParamSchema = z.object({ id: z.string().uuid() });

export const ApplyPlanResponseSchema = z.object({
  plan: PlanSchema,
  summary: PlanDiffSummarySchema
});
export type ApplyPlanResponse = z.infer<typeof ApplyPlanResponseSchema>;

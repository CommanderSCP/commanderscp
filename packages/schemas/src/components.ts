import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// COMPONENT PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03)
// ---------------------------------------------------------------------------------------------

/**
 * One STAGE of a component's pipeline — that is, one `placement` (ADR-0026): this component at one
 * deployment-target.
 *
 * A stage exists because the component IS PLACED there, not because something is releasing. That is
 * the whole correction this view embodies: the previous pipeline surface was keyed on a change, so a
 * component with nothing in flight had no pipeline at all.
 */
export const ComponentPipelineStageSchema = z.object({
  placement: z.object({ id: z.string().uuid(), urn: z.string() }),
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    /** ADR-0026 D1 — present only on a place-role target; without it no stage name derives. */
    environment: z.string().nullable(),
    region: z.string().nullable()
  }),
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1). Null when the target carries no
   *  `environment`: not every deployment-target is a stage, and inventing a name would be a lie. */
  stageName: z.string().nullable(),
  /** What actually executes here. Null when the placement carries no binding of this type — which
   *  after the §6 migration should not happen, and is worth showing loudly if it does: an unbound
   *  placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a)). */
  binding: z
    .object({
      externalRef: z.string().nullable(),
      type: z.string(),
      executionSystemId: z.string().uuid().nullable(),
      executionSystemName: z.string().nullable()
    })
    .nullable(),
  /** The most recent change to touch THIS stage, with the wave that carried it. Null when nothing
   *  has ever released here — a legitimate, common state for a new placement. */
  current: z
    .object({
      changeId: z.string().uuid(),
      changeName: z.string().nullable(),
      changeState: z.string().nullable(),
      waveName: z.string().nullable(),
      targetStatus: z.string().nullable()
    })
    .nullable(),
  /** ALWAYS null today, and ALWAYS listed in this stage's `unknownFields`.
   *
   *  The "version staircase" the design asks for needs a per-stage version/digest captured by
   *  `observe()` — coordination-ui-views.md Phase 4a, unbuilt. The field ships now, always-unknown,
   *  rather than being omitted: an absent field reads as "this view does not do versions", while an
   *  explicitly-unknown one reads as "not observed yet", which is the truth. Same rule as the
   *  service board's `unknownFields` and the graph health surfaces — absent renders `unknown`,
   *  never a confident zero. */
  version: z.string().nullable(),
  /** Dotted paths on THIS stage whose values are not observations. See `version`. */
  unknownFields: z.array(z.string())
});
export type ComponentPipelineStage = z.infer<typeof ComponentPipelineStageSchema>;

/** Which rung supplied the pipeline — the answer to "why does this component release this way?"
 *  (charter principle 6). `pipeline-resolution.ts` computes it; surfacing it here is what stops an
 *  inheritance surprise (someone attaches a topology to a SERVICE and every component changes). */
export const ComponentPipelineSourceSchema = z.object({
  topologyObjectId: z.string().uuid(),
  topologyName: z.string().nullable(),
  topologyVersion: z.number().int().nullable(),
  rung: z.enum(["component", "service", "organization"]),
  attachedToObjectId: z.string().uuid(),
  attachedToName: z.string().nullable()
});
export type ComponentPipelineSource = z.infer<typeof ComponentPipelineSourceSchema>;

/**
 * A component's pipeline: its stages, and where its pipeline definition came from.
 *
 * Derived entirely from durable graph state — placements, their bindings, and the `releases_via`
 * attachment. It is well-defined for a component that has never released, which the change-anchored
 * surface it replaces could not represent at all.
 */
export const ComponentPipelineResponseSchema = z.object({
  component: z.object({ id: z.string().uuid(), urn: z.string(), name: z.string() }),
  /** Null when no rung supplies one — the component releases as a single anonymous wave. */
  pipeline: ComponentPipelineSourceSchema.nullable(),
  /** One per placement, ordered by the topology's wave order where a topology names the targets, so
   *  the stages read left-to-right in release order rather than by id. */
  stages: z.array(ComponentPipelineStageSchema),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineResponse = z.infer<typeof ComponentPipelineResponseSchema>;

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ProblemSchema,
  SubmitPipelineEvidenceRequestSchema,
  SubmitPipelineEvidenceResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  recordAlarmEvidence,
  recordTestRunEvidence,
  type PipelineEvidenceRow
} from "../coordination/pipeline-hooks-repo.js";

/** THE PUSHED-EVIDENCE DOOR. See docs/routes.md §303. */

/** The resolved (component, target) pair an evidence row is keyed by, plus the authorization the
 *  target half carried. Resolution is LIVE and org-scoped — `getObjectByIdOrUrnAnyType` excludes
 *  tombstones and other tenants' rows, so a cross-tenant URN is a 404 here and never a row. */
async function resolveEvidenceSubject(
  tx: TenantTx,
  input: { orgId: string; subjectObjectId: string; componentUrn: string; targetUrn: string }
): Promise<{ componentObjectId: string; targetObjectId: string }> {
  const component = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.componentUrn);
  const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.targetUrn);

  // RULE 1. At the TARGET — see the module doc for why this is not the org root and why
  // `object:write` is the bar rather than a new permission.
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    permission: "object:write",
    scopeObjectId: target.id
  });

  return { componentObjectId: component.id, targetObjectId: target.id };
}

export function registerPipelineRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/pipelines/evidence",
    schema: {
      body: SubmitPipelineEvidenceRequestSchema,
      response: {
        201: SubmitPipelineEvidenceResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "submitPipelineEvidence",
        summary:
          "Push one piece of pipeline evidence — a concluded test run or an alarm-state report over a named window (team-pipeline-iac D21/§14 resolution 8). Authorized with 'object:write' AT THE SUBJECT'S TARGET, never at the org root: this data unlocks bake and post-deploy gates, so the bar is the same one 'who may deploy there' sets. The producer is stamped server-side from the authenticated subject and the source is always 'pushed' — the body has no producer field and a request carrying one is refused",
        tags: ["pipelines"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { subject, evidence } = request.body;

      const row = await withTenantTx(
        deps.db,
        auth.orgId,
        async (tx): Promise<PipelineEvidenceRow> => {
          const resolved = await resolveEvidenceSubject(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            componentUrn: subject.componentUrn,
            targetUrn: subject.targetUrn
          });

          // The binding travels from the SUBJECT, not from the evidence payload: `postMerge` binds to
          // the built commit and the other three kinds to the artifact digest, and
          // `PipelineEvidenceSubjectSchema`'s refine already guarantees at least one is present —
          // "unbound evidence would be read as covering whatever deploys next".
          const binding = {
            artifactDigest: subject.artifactDigest ?? null,
            commitSha: subject.commitSha ?? null
          };
          // RULE 2, at both call sites rather than defaulted anywhere: the two `record*Evidence`
          // functions take `source`/`producerSubjectId` as explicit parameters precisely so the
          // stamping is visible here.
          const stamped = { source: "pushed" as const, producerSubjectId: auth.subjectObjectId };

          // DISPATCH ON THE DISCRIMINANT, exhaustively — `PipelineEvidenceSchema` is a
          // `discriminatedUnion`, so TypeScript narrows each arm and a future third member is a
          // compile error here rather than a silently-dropped submission.
          switch (evidence.kind) {
            case "testRun":
              return await recordTestRunEvidence(tx, auth.orgId, {
                ...resolved,
                ...binding,
                ...stamped,
                hookId: evidence.hookId,
                evidence
              });
            case "alarmState":
              return await recordAlarmEvidence(tx, auth.orgId, {
                ...resolved,
                ...binding,
                ...stamped,
                hookId: evidence.hookId,
                evidence
              });
          }
        }
      );

      // Every field of the receipt is read back off the row. See docs/routes.md §304.
      if (row.source !== "pushed" || row.producerSubjectId === null) {
        throw new Error(
          `pipeline evidence ${row.id} was persisted with source '${row.source}' and producer ` +
            `'${row.producerSubjectId}' — this door stamps 'pushed' and the authenticated subject`
        );
      }
      reply.status(201).send({
        evidenceId: row.id,
        kind: row.kind,
        source: row.source,
        producerSubjectId: row.producerSubjectId,
        componentObjectId: row.componentObjectId,
        targetObjectId: row.targetObjectId,
        recordedAt: row.createdAt.toISOString()
      });
    }
  });
}

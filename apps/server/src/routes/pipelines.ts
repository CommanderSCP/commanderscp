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

/**
 * THE PUSHED-EVIDENCE DOOR (team-pipeline-iac increment 8, D21(b) / §14 resolution 8).
 *
 * `SubmitPipelineEvidenceRequestSchema` shipped in `@scp/schemas` referenced by NO route, which is
 * the built-never-installed shape one layer up from where `pipeline-hooks-repo.ts` met it: the
 * table, the verdict functions and the admission seams were all in place and there was no way for
 * anything outside this process to say "the suite passed" or "the window was quiet". This file is
 * that way in, and it is deliberately ONE route with two dispatch arms rather than a mode bolted
 * onto `POST /change-sources/{kind}/report` (owner ruling, 2026-08-26). The two rules below are
 * the whole reason it is separate; neither survives being folded into the reporter.
 *
 * ============================================================================================
 * RULE 1 — AUTHORIZED AT THE SUBJECT'S TARGET, NOT AT THE ORG ROOT
 * ============================================================================================
 * `SubmitPipelineEvidenceRequestSchema`'s own doc states it: pushed alarm state UNLOCKS A
 * PRODUCTION BAKE GATE, so "who may say the window was quiet" has to be as narrow as "who may
 * deploy there" — an org-root-scoped write permission on a gate unlock is a privilege escalation
 * wearing a reporting API's clothes. That is not a hypothetical difference from the reporter beside
 * it: `POST /change-sources/{kind}/report` takes `object:write` at `auth.orgId`, which
 * `scopeExpandCte` (expanding UPWARD only) makes satisfiable by an ORG-ROOT binding and by nothing
 * else. Every component-scoped CI principal in the estate would have been refused, and every
 * principal that COULD report would have been able to report about every target in the org.
 *
 * THE PERMISSION IS `object:write` AT THE RESOLVED `targetUrn`, chosen by matching the bar the
 * existing target-scoped doors already set rather than by minting a new one:
 * `coordination/campaign-scope-authz.ts`'s `assertCoordinationTargetsWithinAuthority` — the check
 * that decides who may propose a CHANGE against a target, i.e. literally "who may deploy there" —
 * is `object:write` at each resolved target's own object id, and `iac/plans-repo.ts` uses the same
 * pair for a placement. A new `evidence:write` permission would have to be granted by every
 * built-in role before anyone could use it, and would have started life meaning something subtly
 * different from the deploy bar it is supposed to mirror.
 *
 * ONE TARGET, EVERY TIME — no org-root disjunction arm. `authz/org-root-arm.ts` exists for doors
 * whose scope can become UNREACHABLE (a change's targets are read back verbatim off `properties`
 * and their ancestors can be tombstoned out from under an org-root Owner). Nothing like that
 * applies here: the target is resolved LIVE from the graph on this very request, so a caller whose
 * target resolves at all has a live object to be scoped by, and adding the arm would hand exactly
 * the org-root-wide unlock this route exists to refuse back to whoever holds the org root.
 *
 * ============================================================================================
 * RULE 2 — THE PRODUCER IS STAMPED, NEVER ACCEPTED
 * ============================================================================================
 * The request is a `strictObject` with no `producer`/`source`/`reportedBy` member, and one must
 * never be added. `federation/scan-evidence.ts` holds the governing rule: PROVENANCE IS THE
 * AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE, because a shape-valid payload is forgeable by
 * anyone who can read the schema. So `producer_subject_id` comes from `auth.subjectObjectId` and
 * `source` is the constant `'pushed'`.
 *
 * `source` is not a cosmetic label here — `evaluateBakeGate` computes quiet-window coverage PER
 * SOURCE, merging only the intervals one source asserted, so a caller able to choose its own
 * `source` could manufacture single-source coverage of a window nobody observed. The constant is
 * what makes that unreachable through this door.
 *
 * The strictness is load-bearing in the same direction: a body carrying an extra `producer` key is
 * REFUSED (400) rather than silently stripped. A silent strip would tell a forger their claim was
 * accepted while the server quietly recorded something else, and would let a genuinely-confused CI
 * step ship for months believing it had attributed its own runs.
 *
 * ============================================================================================
 * WHAT THIS ROUTE DOES *NOT* DO
 * ============================================================================================
 * It does not check that a matching hook is DECLARED. Evidence for an undeclared hook is inert —
 * every consumer starts from `pipeline_hooks` and joins evidence to it, so an orphan row is never
 * read by any verdict — and refusing it would make the ORDER of `scp iac apply` and the CI step
 * that reports against it load-bearing, which nothing in D11/D21 asks for.
 *
 * It records no Decision, so it returns no `decision_id`: nothing here is an engine VERDICT. The
 * refusals it can produce are a 404 (the subject does not resolve), a 403 (`authorize`'s own
 * unexplained-authority refusal, the same shape every other door's 403 has) and a 400 (Zod). The
 * verdicts this evidence FEEDS — `gate`/`continuous_test` — are Decision-backed on the reconcile
 * side and carry their `decision_id` there, which is where charter principle 6 is satisfied for
 * this data.
 */

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

      // EVERY FIELD OF THE RECEIPT IS READ BACK OFF THE PERSISTED ROW, not restated from the
      // constants above: the receipt describes what is IN THE TABLE, so a stamping regression
      // surfaces in the response a reporter actually reads instead of only in a column nobody
      // looks at. The two narrowings below are therefore checks, not casts — both are unreachable
      // while the stamping above stands, and both would be the first sign that it stopped.
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

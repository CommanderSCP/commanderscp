import {
  categoryOfType,
  infraApplyTemplateFor,
  InfrastructureChangeDeclarationSchema,
  INFRASTRUCTURE_DECLARATION_PROPERTY,
  type ExecutorType
} from "@scp/schemas";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  changePlans,
  changes,
  changeWaves,
  changeWaveTargets,
  decisions,
  objects
} from "../db/schema.js";
import { canonicalJson } from "../util/canonical-json.js";
import { insertDecision } from "./decisions-repo.js";
import {
  TriggerParameterRefusal,
  WAVE_TARGET_INFRA_APPLY_REFUSED_AUDIT_ACTION,
  WAVE_TARGET_INFRA_APPLY_REFUSED_STATUS,
  WAVE_TARGET_INFRA_DECLARATION_REFUSED_AUDIT_ACTION,
  WAVE_TARGET_INFRA_DECLARATION_REFUSED_STATUS
} from "./trigger-parameter-refusal.js";
import type { WaveTargetObservedState } from "./wave-targets-repo.js";

/**
 * THE INFRASTRUCTURE LANE (M28.3, ADR-0056) — what an `infrastructure` trigger tells the org's
 * Argo Workflows, and the gate that decides whether an APPLY is triggered at all.
 *
 * Before this the `infrastructure` Category got no parameters (`buildLaneTriggerParameters`: "an
 * `infrastructure` one has no artifact at all"), so there was no lane to drive. It is the third
 * sibling of `buildLaneTriggerParameters` and `opsLaneTriggerParameters`, and it differs from both
 * in one way that is the whole point: it can REFUSE TO TRIGGER, because an apply is the one trigger
 * in this system that must be preceded by a human decision about a specific artifact.
 *
 * THE APPROVAL IS THE CHANGE LIFECYCLE, NOT A NEW ONE. A plan runs as a change; its digest and tally
 * come back as `observed.plan` (the evidence managed-iac already reports, rendered by the existing
 * plan chip); accepting that change — `change:accept` at every target, by someone OTHER than its
 * proposer (`gates.ts`, separation of duties), plus any quorum policy on the validating→accepted
 * edge — IS approving that plan. An apply is a second change naming it.
 *
 * WHAT A PLAN WAS IS RECORDED, NOT RE-DERIVED. Every plan trigger writes an `infra_plan_trigger`
 * Decision carrying the exact template and parameters it submitted (`recordInfraTrigger`). The
 * apply is built from THAT record — the same workspace, directory, repo, commit and the plan
 * template's own `-apply` sibling — and is refused if the target or its binding now say something
 * else. Re-deriving at apply time is how an approval of one place became an apply to another
 * (verification probes A and B).
 *
 * THE APPLY GATE, all evaluated here, inside the trigger-claim transaction, BEFORE `trigger()`:
 *   1. the named plan change exists, is a PLAN (not an apply, not a rollback), and is `accepted`;
 *   2. it has a SUCCEEDED plan at THIS target, run by the SAME executor instance about to apply,
 *      with a digest and a recorded trigger — an apply is bound to both or it is not triggered;
 *   3. the target's place and its binding still match what the plan recorded;
 *   4. no NEWER plan has been DISPATCHED at this target since (dispatch order, from the time-ordered
 *      ids of the plan-trigger Decisions — not row creation order);
 *   5. no other apply of this plan is in flight, and none has SUCCEEDED — a re-apply of an applied
 *      plan is a no-op: no second trigger, a success recorded with the reason.
 * The template carries the second half: it re-plans and applies only if the digest — which covers
 * the plan's place as well as its changes — still matches (`deploy/helm-bundled/files/scp-infra.sh`).
 *
 * ENGAGES ONLY FOR `argo-workflows`. `managed-iac` stays the Mode C fallback exactly as it was (D2),
 * and every other executor bound to an `infrastructure` Type keeps receiving what it received — but
 * a change that DECLARES an apply is refused wherever this lane does not engage, because an apply
 * declaration silently run as something else is the one misreading that must not happen.
 */

export class InfraDeclarationRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_INFRA_DECLARATION_REFUSED_STATUS;
  readonly action = WAVE_TARGET_INFRA_DECLARATION_REFUSED_AUDIT_ACTION;
}

export class InfraApplyRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_INFRA_APPLY_REFUSED_STATUS;
  readonly action = WAVE_TARGET_INFRA_APPLY_REFUSED_AUDIT_ACTION;
}

/** The only module this lane speaks for. */
export const INFRA_LANE_EXECUTOR_MODULE = "argo-workflows";

/** The SHIPPED infra catalog templates — reachable only through this lane (see
 *  `assertNotAnUngatedInfraTemplate` and the plugin host's `infra-template-guard.ts`). */
export const INFRA_CATALOG_TEMPLATE_PATTERN = /^scp-infra-(plan|apply)-v[0-9]+$/;

/** The Decision gate every plan/apply trigger records its exact submission under. */
export const INFRA_PLAN_TRIGGER_GATE = "infra_plan_trigger";
export const INFRA_APPLY_TRIGGER_GATE = "infra_apply_trigger";

/** A plain name: what OpenTofu accepts as a workspace and the template re-checks. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const FULL_COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_SHAPE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A wave target that has REACHED its executor (or is about to, under a claim). */
const DISPATCHED_STATUSES = ["triggering", "triggered", "observing", "succeeded"] as const;
const IN_FLIGHT_STATUSES = ["triggering", "triggered", "observing"] as const;

export interface InfraLaneInput {
  orgId: string;
  /** The deployment-target this change builds out. */
  targetObjectId: string;
  type: ExecutorType;
  changeObjectId: string;
  /** The change's `sourceRef` bag — untyped for the build lane's reason. */
  sourceRef: unknown;
  isRollback: boolean;
  /** The module and instance the binding resolved to (`ensureExecutorInstanceStarted`) — the SAME
   *  answer the trigger acts on, never a second query. */
  pluginModule: string | null;
  executorInstanceId: string;
  /** The binding's `externalRef` — for this lane, the PLAN template's name. */
  externalRef: string | null;
  /** The keys a campaign recipe (`properties.recipe.trigger.parameters`) would add to this trigger.
   *  Any of {@link INFRA_LANE_RESERVED_PARAMETERS} is refused: see below. */
  recipeParameterKeys?: readonly string[];
}

/** THE KEYS THIS LANE DERIVES AS BOUNDS (ADR-0056 names them). A recipe's parameters flow verbatim
 *  into the trigger and anyone who can propose a change can write one, so a recipe restating any of
 *  these could re-point an approved apply: a different digest, commit, directory or state workspace.
 *  Two defences, deliberately both: reconcile spreads the lane's values LAST (the ADR-0052 ops
 *  rule), and a recipe that NAMES one of them is refused here with a Decision — silently overriding
 *  an author's explicit instruction would leave them believing it had been honoured. */
export const INFRA_LANE_RESERVED_PARAMETERS = [
  "environment",
  "stateWorkspace",
  "region",
  "infraPath",
  "sourceRepo",
  "sourceCommit",
  "sourceRef",
  "planDigest",
  "planChangeObjectId",
  "changeObjectId",
  "targetObjectId"
] as const;

/** The parameters that say WHERE and WHAT a plan planned — what an apply must reuse verbatim. */
const PLAN_SCOPE_KEYS = [
  "environment",
  "stateWorkspace",
  "region",
  "infraPath",
  "sourceRepo",
  "sourceCommit",
  "sourceRef"
] as const;

/** What reconcile does with a trigger this lane derived. */
export type InfraLaneOutcome =
  | {
      kind: "trigger";
      phase: "plan" | "apply";
      /** The WorkflowTemplate to submit — the binding's own for a plan, the RECORDED plan's
       *  `-apply` sibling for an apply. Reconcile uses this in place of the binding's externalRef. */
      templateRef: string;
      /** For a plan: the apply template its approval will be applied with, recorded now. */
      applyTemplateRef: string;
      parameters: Record<string, unknown>;
    }
  | {
      kind: "noop";
      /** Persisted as the wave target's observed plan, so the no-op still renders what it was. */
      plan: NonNullable<WaveTargetObservedState["plan"]>;
      summary: string;
      inputContext: Record<string, unknown>;
    };

function readString(bag: unknown, key: string): string | undefined {
  if (!bag || typeof bag !== "object") return undefined;
  const value = (bag as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

type Declaration = { phase: "plan" } | { phase: "apply"; planChangeObjectId: string };

function readDeclaration(properties: unknown): Declaration {
  const raw =
    properties && typeof properties === "object"
      ? (properties as Record<string, unknown>)[INFRASTRUCTURE_DECLARATION_PROPERTY]
      : undefined;
  if (raw === undefined || raw === null) return { phase: "plan" };
  const parsed = InfrastructureChangeDeclarationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InfraDeclarationRefused(
      `\`properties.${INFRASTRUCTURE_DECLARATION_PROPERTY}\` must be \`{ applyPlan: <plan change id> }\` ` +
        `or absent (a plan). It is neither, so CommanderSCP cannot tell whether this change plans or ` +
        `applies — and guessing "apply" is the one guess that must never be made.`,
      { inputContext: { gate: "infra_declaration_malformed" } }
    );
  }
  return { phase: "apply", planChangeObjectId: parsed.data.applyPlan };
}

interface Place {
  environment: string;
  region: string;
  stateWorkspace: string;
  infraPath: string;
  /** `properties.infrastructureRepo` — the ONE repo this environment's infrastructure comes from. */
  declaredRepo: string;
}

/** The deployment-target facts both phases need, read off the target. */
async function readPlace(tx: TenantTx, orgId: string, targetObjectId: string): Promise<Place> {
  const [target] = await tx
    .select({ typeId: objects.typeId, properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, targetObjectId)))
    .limit(1);
  if (!target || target.typeId !== "deployment-target") {
    throw new InfraDeclarationRefused(
      `an infrastructure buildout is FOR AN ENVIRONMENT, and wave target ${targetObjectId} is ` +
        `${target ? `a '${target.typeId}'` : "not an object in this org"}, not a deployment-target.`,
      {
        remediation:
          "target the deployment-target the infrastructure is for (e.g. prod-us-east-1), and bind " +
          "its 'infrastructure' pipeline to scp-infra-plan-v1",
        inputContext: { gate: "infra_target_not_deployment_target", typeId: target?.typeId ?? null }
      }
    );
  }
  const environment = readString(target.properties, "environment");
  if (!environment || !PLAIN_NAME.test(environment)) {
    throw new InfraDeclarationRefused(
      `deployment-target ${targetObjectId} ${environment ? `declares environment '${environment}', which is not a plain name` : "declares no properties.environment"} — ` +
        `the environment is what names this target's state, so without one there is no state to plan against.`,
      {
        remediation: "set the deployment-target's properties.environment (e.g. 'prod-us-east-1')",
        inputContext: { gate: "infra_environment_missing", environment: environment ?? null }
      }
    );
  }
  const region = readString(target.properties, "region");
  if (region !== undefined && !PLAIN_NAME.test(region)) {
    throw new InfraDeclarationRefused(
      `deployment-target ${targetObjectId} declares region '${region}', which is not a plain name.`,
      { inputContext: { gate: "infra_region_malformed", region } }
    );
  }
  // ONE STATE WORKSPACE PER TARGET, carrying the org and the target's identity: ADR-0044's region
  // targets share an environment (`prod` in amer AND emea), and two orgs on one operator backend
  // can both call an environment `prod` — sharing a state between any of them would make one's
  // plan a plan to destroy the other's. The readable part leads so an operator browsing the backend
  // still sees `prod-us-east-1`.
  const stateWorkspace = `${region ? `${environment}-${region}` : environment}--o${orgId}--t${targetObjectId}`;
  if (!WORKSPACE_NAME.test(stateWorkspace)) {
    throw new InfraDeclarationRefused(
      `the state workspace '${stateWorkspace}' derived for ${targetObjectId} is not a plain name.`,
      { inputContext: { gate: "infra_workspace_malformed", stateWorkspace } }
    );
  }
  // Where in the repo this environment's configuration lives — a fact about the TARGET, the way a
  // Dockerfile path is a fact about a component. Absent ⇒ the repo root.
  const infraPath = readString(target.properties, "infrastructurePath") ?? ".";
  if (infraPath.startsWith("/") || `/${infraPath}/`.includes("/../")) {
    throw new InfraDeclarationRefused(
      `deployment-target ${targetObjectId} declares infrastructurePath '${infraPath}', which ` +
        `leaves the repository.`,
      { inputContext: { gate: "infra_path_escapes", infraPath } }
    );
  }
  // THE DECLARED SOURCE. A plan runs the repository's code — providers, `data "external"` — with the
  // operator's credentials in the pod, so WHICH repository cannot be the proposer's choice. It is
  // a fact about the target, set by whoever may write the target, and a plan from anywhere else is
  // refused (`verification probe C`).
  const declaredRepo = readString(target.properties, "infrastructureRepo");
  if (!declaredRepo || !REPO_SHAPE.test(declaredRepo)) {
    throw new InfraDeclarationRefused(
      `deployment-target ${targetObjectId} ${declaredRepo ? `declares infrastructureRepo '${declaredRepo}', which is not owner/name` : "declares no properties.infrastructureRepo"}. ` +
        `A plan runs its repository's code with the operator's credentials, so the repository is ` +
        `declared on the target — never taken from the change that asks for the plan.`,
      {
        remediation:
          "set the deployment-target's properties.infrastructureRepo to the owner/name of the repo " +
          "its infrastructure lives in",
        inputContext: { gate: "infra_source_undeclared", declaredRepo: declaredRepo ?? null }
      }
    );
  }
  return { environment, region: region ?? "", stateWorkspace, infraPath, declaredRepo };
}

function readSource(sourceRef: unknown): { repo: string; commit: string; ref: string } | undefined {
  const repo = readString(sourceRef, "repo");
  const commit = readString(sourceRef, "commit");
  if (!repo || !commit || !REPO_SHAPE.test(repo) || !FULL_COMMIT.test(commit)) return undefined;
  return { repo, commit, ref: readString(sourceRef, "ref") ?? "" };
}

export async function infraLaneTriggerParameters(
  tx: TenantTx,
  input: InfraLaneInput
): Promise<InfraLaneOutcome | undefined> {
  const [changeObject] = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.changeObjectId)))
    .limit(1);
  const declaration = readDeclaration(changeObject?.properties);
  const engaged =
    categoryOfType(input.type) === "infrastructure" &&
    input.pluginModule === INFRA_LANE_EXECUTOR_MODULE;

  // A DECLARED APPLY THE LANE WILL NOT SERVE IS REFUSED, never silently run as whatever the bound
  // executor does by default (for managed-iac today: a PLAN, reported as success).
  if (!engaged) {
    if (declaration.phase === "apply") {
      throw new InfraApplyRefused(
        `this change declares an APPLY of plan ${declaration.planChangeObjectId}, but its target's ` +
          `'${input.type}' pipeline resolves to '${input.pluginModule ?? "(none)"}', which the ` +
          `apply gate does not serve. Running it anyway would do something other than the apply it ` +
          `declares.`,
        {
          remediation:
            "bind the deployment-target's 'infrastructure' pipeline to an Argo Workflows system with " +
            "externalRef scp-infra-plan-v1, or remove properties.infrastructure",
          inputContext: {
            gate: "infra_apply_lane_absent",
            planChangeObjectId: declaration.planChangeObjectId,
            requestedType: input.type,
            pluginModule: input.pluginModule
          }
        }
      );
    }
    return undefined;
  }

  // NO ROLLBACK REPLAY. Rolling infrastructure back is planning the prior commit and applying THAT
  // plan through the same gate; re-triggering a template with the forward change's inputs would be
  // the forward operation again, unapproved.
  if (input.isRollback) {
    throw new InfraDeclarationRefused(
      "an infrastructure change is not rolled back by replaying it. Plan the prior commit as a new " +
        "change, accept that plan, and apply it — the same gate every apply passes.",
      { inputContext: { gate: "infra_rollback_refused" } }
    );
  }

  const restated = (input.recipeParameterKeys ?? []).filter((k) =>
    (INFRA_LANE_RESERVED_PARAMETERS as readonly string[]).includes(k)
  );
  if (restated.length > 0) {
    throw new InfraDeclarationRefused(
      `this change's recipe sets ${restated.map((k) => `'${k}'`).join(", ")}, which the ` +
        `infrastructure lane derives itself. They are what binds a plan to its target and an apply ` +
        `to its approved plan, so no recipe may supply them.`,
      {
        remediation: `remove ${restated.join(", ")} from properties.recipe.trigger.parameters`,
        inputContext: { gate: "infra_recipe_restates_bound", restated: [...restated].sort() }
      }
    );
  }

  const planTemplate = input.externalRef;
  const applyTemplate = planTemplate ? infraApplyTemplateFor(planTemplate) : null;
  if (!planTemplate || !applyTemplate) {
    throw new InfraDeclarationRefused(
      `this target's 'infrastructure' binding names ${planTemplate ? `'${planTemplate}'` : "no template"}, ` +
        `and an infrastructure binding on Argo Workflows names its PLAN template — the apply template is ` +
        `its '-apply' sibling, derived, so that no binding can point a plan's trigger at an apply.`,
      {
        remediation:
          "bind the 'infrastructure' pipeline with externalRef scp-infra-plan-v1 (or an org template " +
          "named '<name>-plan' whose sibling '<name>-apply' applies it)",
        inputContext: { gate: "infra_binding_not_a_plan_template", externalRef: planTemplate }
      }
    );
  }

  const place = await readPlace(tx, input.orgId, input.targetObjectId);

  if (declaration.phase === "plan") {
    const source = readSource(input.sourceRef);
    if (!source) {
      throw new InfraDeclarationRefused(
        "an infrastructure plan is pinned to ONE revision, and this change's sourceRef names no " +
          "owner/name repo and full commit id. Planning a branch would let the configuration move " +
          "between the plan an approver reads and the apply that follows it.",
        {
          remediation:
            "propose the plan with sourceRef { repo: '<the target's infrastructureRepo>', commit: '<full sha>' }",
          inputContext: { gate: "infra_source_unpinned" }
        }
      );
    }
    if (source.repo !== place.declaredRepo) {
      throw new InfraDeclarationRefused(
        `this plan asks for '${source.repo}', and deployment-target ${input.targetObjectId} declares ` +
          `its infrastructure lives in '${place.declaredRepo}'. A plan runs its repository's code ` +
          `with the operator's credentials, so it runs only the repository the target declares.`,
        {
          remediation: `propose the plan from '${place.declaredRepo}', or change the target's infrastructureRepo`,
          inputContext: {
            gate: "infra_source_not_declared",
            requestedRepo: source.repo,
            declaredRepo: place.declaredRepo
          }
        }
      );
    }
    return {
      kind: "trigger",
      phase: "plan",
      templateRef: planTemplate,
      applyTemplateRef: applyTemplate,
      parameters: {
        environment: place.environment,
        stateWorkspace: place.stateWorkspace,
        region: place.region,
        infraPath: place.infraPath,
        sourceRepo: source.repo,
        sourceCommit: source.commit,
        sourceRef: source.ref,
        changeObjectId: input.changeObjectId,
        targetObjectId: input.targetObjectId
      }
    };
  }

  return evaluateApplyGate(tx, input, {
    planChangeObjectId: declaration.planChangeObjectId,
    planTemplate,
    place
  });
}

/** One wave-target row of an infrastructure change at a target, with its change's facts. */
interface InfraWaveTargetRow {
  id: string;
  changeObjectId: string;
  status: string;
  executorPluginId: string | null;
  observedState: WaveTargetObservedState | null;
}

/** What a plan trigger recorded about itself (`recordInfraTrigger`). */
interface PlanTriggerRecord {
  decisionId: string;
  templateRef: string;
  applyTemplateRef: string;
  executorPluginId: string;
  parameters: Record<string, string>;
}

async function evaluateApplyGate(
  tx: TenantTx,
  input: InfraLaneInput,
  args: { planChangeObjectId: string; planTemplate: string; place: Place }
): Promise<InfraLaneOutcome> {
  const { orgId, targetObjectId } = input;
  const { planChangeObjectId, place } = args;
  const base = { planChangeObjectId, targetObjectId };
  // A function DECLARATION, not a const arrow: only a declared `never` narrows at its call sites.
  function refuse(
    gate: string,
    message: string,
    remediation: string,
    extra: Record<string, unknown> = {}
  ): never {
    throw new InfraApplyRefused(`refusing to apply: ${message}`, {
      remediation,
      inputContext: { gate, ...base, ...extra }
    });
  }

  // SERIALISE EVERY APPLY DECISION FOR THIS TARGET. The in-flight check below reads other applies'
  // claims; two workers deciding two applies of one plan at once would each see the other's
  // `pending` and both trigger. Held to the end of the claim transaction, which is where this
  // target's own claim is written.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`scp-infra-apply:${orgId}`}), hashtext(${targetObjectId}))`
  );

  if (planChangeObjectId === input.changeObjectId) {
    refuse(
      "infra_apply_names_itself",
      "this change names itself as the plan it applies.",
      "set properties.infrastructure.applyPlan to the id of the accepted PLAN change"
    );
  }

  // 1. The plan change — a plan, and ACCEPTED.
  const [planChange] = await tx
    .select({
      state: changes.state,
      rollbackOfObjectId: changes.rollbackOfObjectId,
      properties: objects.properties
    })
    .from(changes)
    .innerJoin(objects, and(eq(objects.orgId, changes.orgId), eq(objects.id, changes.objectId)))
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, planChangeObjectId)))
    .limit(1);
  if (!planChange) {
    refuse(
      "infra_plan_missing",
      `plan change ${planChangeObjectId} does not exist in this organization.`,
      "name the accepted plan change's id in properties.infrastructure.applyPlan"
    );
  }
  const planProperties = planChange.properties as Record<string, unknown> | null;
  if (
    planChange.rollbackOfObjectId !== null ||
    (planProperties?.[INFRASTRUCTURE_DECLARATION_PROPERTY] ?? null) !== null
  ) {
    refuse(
      "infra_plan_not_a_plan",
      `change ${planChangeObjectId} is ${planChange.rollbackOfObjectId !== null ? "a rollback" : "itself an apply"}, not a plan.`,
      "name the PLAN change whose accepted plan should be applied"
    );
  }
  if (planChange.state !== "accepted") {
    refuse(
      "infra_plan_not_approved",
      `plan change ${planChangeObjectId} is '${planChange.state}', not accepted. Accepting the plan ` +
        `change IS approving its plan; until it is accepted there is no approved plan to apply.`,
      "review the plan's evidence on the plan change, have someone other than its proposer accept it (scp change accept), then re-propose this apply",
      { planChangeState: planChange.state }
    );
  }

  // 2. Its plan AT THIS TARGET — succeeded, by this executor, with a digest and a record.
  const [planTarget] = await infraWaveTargetsAt(tx, orgId, targetObjectId, {
    changeObjectId: planChangeObjectId
  });
  if (!planTarget) {
    refuse(
      "infra_plan_not_at_target",
      `plan change ${planChangeObjectId} planned nothing at ${targetObjectId}.`,
      "apply a plan that was made for this deployment-target"
    );
  }
  const plan = planTarget.observedState?.plan;
  if (planTarget.status !== "succeeded" || !plan?.ref || !SHA256.test(plan.ref)) {
    refuse(
      "infra_plan_no_evidence",
      `the plan at ${targetObjectId} is '${planTarget.status}' and reported ${plan?.ref ? `digest '${plan.ref}'` : "no digest"}; ` +
        `an apply is bound to a plan digest, so there is nothing to bind this one to.`,
      "re-run the plan (its template must export scpPlanDigest), accept it, and apply that plan",
      { planTargetStatus: planTarget.status, planDigest: plan?.ref ?? null }
    );
  }
  if (planTarget.executorPluginId !== input.executorInstanceId) {
    refuse(
      "infra_plan_other_executor",
      `the plan at ${targetObjectId} was run by executor ${planTarget.executorPluginId}, and this ` +
        `apply would run on ${input.executorInstanceId}. A plan is evidence about the system that made it.`,
      "re-plan on the executor now bound to this target, accept it, and apply that plan",
      {
        planExecutorPluginId: planTarget.executorPluginId,
        executorPluginId: input.executorInstanceId
      }
    );
  }
  const planDigest = plan.ref;
  const record = await latestPlanTriggerRecord(tx, orgId, planChangeObjectId, planTarget.id);
  if (!record || record.executorPluginId !== planTarget.executorPluginId) {
    refuse(
      "infra_plan_record_missing",
      `the plan at ${targetObjectId} carries no record of what it submitted, so there is no way to ` +
        `apply exactly the place it planned.`,
      "re-plan, accept it, and apply that plan",
      { planDigest }
    );
  }

  // 3. THE PLACE AND THE BINDING STILL MATCH WHAT WAS PLANNED. The apply reuses the record either
  // way; a mismatch is refused because the approver approved a plan for a place that no longer is.
  const now: Record<string, string> = {
    environment: place.environment,
    stateWorkspace: place.stateWorkspace,
    region: place.region,
    infraPath: place.infraPath,
    sourceRepo: place.declaredRepo,
    templateRef: args.planTemplate
  };
  const recorded: Record<string, string> = {
    environment: record.parameters["environment"] ?? "",
    stateWorkspace: record.parameters["stateWorkspace"] ?? "",
    region: record.parameters["region"] ?? "",
    infraPath: record.parameters["infraPath"] ?? "",
    sourceRepo: record.parameters["sourceRepo"] ?? "",
    templateRef: record.templateRef
  };
  const changed = Object.keys(now).filter((k) => now[k] !== recorded[k]);
  if (changed.length > 0) {
    refuse(
      "infra_plan_scope_changed",
      `the target or its binding changed since plan change ${planChangeObjectId} planned it ` +
        `(${changed.map((k) => `${k}: '${recorded[k]}' → '${now[k]}'`).join("; ")}). The approval ` +
        `was of a plan for the place as it was.`,
      "re-plan the target as it is now, accept that plan, and apply it",
      {
        changed,
        recorded: Object.fromEntries(changed.map((k) => [k, recorded[k]])),
        now: Object.fromEntries(changed.map((k) => [k, now[k]])),
        planDigest
      }
    );
  }

  // 4. SUPERSEDED — a newer plan has been DISPATCHED here since. Ordered by the plan-trigger
  // Decisions' time-ordered ids, which is dispatch order; row creation order is plan-compile order,
  // and a plan compiled earlier but dispatched later is the newer plan.
  const others = (
    await infraWaveTargetsAt(tx, orgId, targetObjectId, {
      excludeChangeObjectId: planChangeObjectId
    })
  ).filter(
    (t) =>
      (DISPATCHED_STATUSES as readonly string[]).includes(t.status) &&
      t.changeObjectId !== input.changeObjectId
  );
  const newer: { changeObjectId: string; status: string }[] = [];
  for (const t of await plansOnly(tx, orgId, others)) {
    const theirs = await latestPlanTriggerRecord(tx, orgId, t.changeObjectId, t.id);
    if (theirs && theirs.decisionId > record.decisionId) newer.push(t);
  }
  if (newer.length > 0) {
    const latest = newer[0]!;
    refuse(
      "infra_plan_superseded",
      `plan change ${planChangeObjectId} was superseded at ${targetObjectId} by plan change ` +
        `${latest.changeObjectId}. The newest plan is the one that reflects the configuration now.`,
      `review and accept plan change ${latest.changeObjectId}, then apply THAT plan`,
      { supersededBy: latest.changeObjectId, supersededByStatus: latest.status, planDigest }
    );
  }

  // 5. ALREADY APPLIED, or being applied.
  const applies = (
    await infraWaveTargetsAt(tx, orgId, targetObjectId, {
      excludeChangeObjectId: input.changeObjectId,
      appliesPlan: planChangeObjectId
    })
  ).filter((t) => (DISPATCHED_STATUSES as readonly string[]).includes(t.status));
  const inFlight = applies.find((t) =>
    (IN_FLIGHT_STATUSES as readonly string[]).includes(t.status)
  );
  if (inFlight) {
    refuse(
      "infra_apply_in_flight",
      `apply change ${inFlight.changeObjectId} is already applying plan ${planDigest} at ${targetObjectId}.`,
      "wait for that apply to finish; if it succeeds this plan is applied, if it fails, re-plan",
      { inFlightChangeObjectId: inFlight.changeObjectId, planDigest }
    );
  }
  const applied = applies.find((t) => t.status === "succeeded");
  if (applied) {
    return {
      kind: "noop",
      plan: { ...plan },
      summary:
        `plan ${planDigest.slice(0, 12)} (plan change ${planChangeObjectId}) was already applied at ` +
        `${targetObjectId} by change ${applied.changeObjectId} — nothing triggered, nothing to do`,
      inputContext: {
        gate: "infra_apply_noop",
        ...base,
        planDigest,
        appliedByChangeObjectId: applied.changeObjectId
      }
    };
  }

  // THE PLAN'S OWN SUBMISSION, REUSED: the same workspace, directory, repo, commit — and the plan
  // template's recorded sibling, never whatever the binding names today.
  return {
    kind: "trigger",
    phase: "apply",
    templateRef: record.applyTemplateRef,
    applyTemplateRef: record.applyTemplateRef,
    parameters: {
      ...Object.fromEntries(PLAN_SCOPE_KEYS.map((k) => [k, record.parameters[k] ?? ""])),
      planDigest,
      planChangeObjectId,
      changeObjectId: input.changeObjectId,
      targetObjectId
    }
  };
}

/** RECORD WHAT A PLAN (OR APPLY) TRIGGER SUBMITS — called by reconcile once the claim is won, in the
 *  claim transaction. A Decision (allow), because it is the lane's verdict on what this trigger may
 *  carry, with the inputs that produced it (principle 6); and because Decisions are append-only,
 *  which is what an apply needs of the thing it is bound to. A retry that would record the same
 *  submission records nothing. */
export async function recordInfraTrigger(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    waveTargetId: string;
    targetObjectId: string;
    executorPluginId: string;
    outcome: Extract<InfraLaneOutcome, { kind: "trigger" }>;
  }
): Promise<void> {
  const inputContext = {
    gate: input.outcome.phase === "plan" ? INFRA_PLAN_TRIGGER_GATE : INFRA_APPLY_TRIGGER_GATE,
    waveTargetId: input.waveTargetId,
    targetObjectId: input.targetObjectId,
    executorPluginId: input.executorPluginId,
    templateRef: input.outcome.templateRef,
    applyTemplateRef: input.outcome.applyTemplateRef,
    parameters: input.outcome.parameters
  };
  const [latest] = await tx
    .select({ inputContext: decisions.inputContext })
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, input.orgId),
        eq(decisions.subjectId, input.changeObjectId),
        eq(decisions.kind, "wave_target"),
        sql`${decisions.inputContext} ->> 'gate' = ${inputContext.gate}`,
        sql`${decisions.inputContext} ->> 'waveTargetId' = ${input.waveTargetId}`
      )
    )
    .orderBy(desc(decisions.id))
    .limit(1);
  if (latest && canonicalJson(latest.inputContext) === canonicalJson(inputContext)) return;
  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "wave_target",
    subjectId: input.changeObjectId,
    verdict: "allow",
    inputContext,
    reasonTree: {
      summary:
        `${input.outcome.phase} of ${input.targetObjectId} submitted as '${input.outcome.templateRef}' ` +
        `into workspace '${String(input.outcome.parameters["stateWorkspace"])}'`
    }
  });
}

async function latestPlanTriggerRecord(
  tx: TenantTx,
  orgId: string,
  planChangeObjectId: string,
  waveTargetId: string
): Promise<PlanTriggerRecord | undefined> {
  const [row] = await tx
    .select({ id: decisions.id, inputContext: decisions.inputContext })
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, orgId),
        eq(decisions.subjectId, planChangeObjectId),
        eq(decisions.kind, "wave_target"),
        sql`${decisions.inputContext} ->> 'gate' = ${INFRA_PLAN_TRIGGER_GATE}`,
        sql`${decisions.inputContext} ->> 'waveTargetId' = ${waveTargetId}`
      )
    )
    .orderBy(desc(decisions.id))
    .limit(1);
  if (!row) return undefined;
  const ctx = row.inputContext as Record<string, unknown>;
  const params = ctx["parameters"];
  if (
    typeof ctx["templateRef"] !== "string" ||
    typeof ctx["applyTemplateRef"] !== "string" ||
    typeof ctx["executorPluginId"] !== "string" ||
    !params ||
    typeof params !== "object"
  ) {
    return undefined;
  }
  return {
    decisionId: row.id,
    templateRef: ctx["templateRef"],
    applyTemplateRef: ctx["applyTemplateRef"],
    executorPluginId: ctx["executorPluginId"],
    parameters: Object.fromEntries(
      Object.entries(params as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    )
  };
}

/** Infrastructure wave targets at one target, newest first. */
async function infraWaveTargetsAt(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  filter: {
    changeObjectId?: string;
    excludeChangeObjectId?: string;
    /** Only wave targets of APPLY changes naming this plan change. */
    appliesPlan?: string;
  }
): Promise<InfraWaveTargetRow[]> {
  const rows = await tx
    .select({
      id: changeWaveTargets.id,
      changeObjectId: changePlans.changeObjectId,
      status: changeWaveTargets.status,
      executorPluginId: changeWaveTargets.executorPluginId,
      observedState: changeWaveTargets.observedState
    })
    .from(changeWaveTargets)
    .innerJoin(
      changeWaves,
      and(
        eq(changeWaves.orgId, changeWaveTargets.orgId),
        eq(changeWaves.id, changeWaveTargets.waveId)
      )
    )
    .innerJoin(
      changePlans,
      and(eq(changePlans.orgId, changeWaves.orgId), eq(changePlans.id, changeWaves.planId))
    )
    .innerJoin(
      objects,
      and(eq(objects.orgId, changePlans.orgId), eq(objects.id, changePlans.changeObjectId))
    )
    .where(
      and(
        eq(changeWaveTargets.orgId, orgId),
        eq(changeWaveTargets.targetObjectId, targetObjectId),
        eq(changeWaveTargets.type, "infrastructure"),
        filter.changeObjectId ? eq(changePlans.changeObjectId, filter.changeObjectId) : undefined,
        filter.excludeChangeObjectId
          ? ne(changePlans.changeObjectId, filter.excludeChangeObjectId)
          : undefined,
        filter.appliesPlan
          ? sql`${objects.properties} -> ${INFRASTRUCTURE_DECLARATION_PROPERTY} ->> 'applyPlan' = ${filter.appliesPlan}`
          : undefined
      )
    )
    .orderBy(desc(changeWaveTargets.createdAt));
  return rows.map((r) => ({
    ...r,
    observedState: (r.observedState as WaveTargetObservedState | null) ?? null
  }));
}

/** Keep only the rows whose change is a PLAN (declares no apply) and is not a rollback. */
async function plansOnly(
  tx: TenantTx,
  orgId: string,
  rows: InfraWaveTargetRow[]
): Promise<InfraWaveTargetRow[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.changeObjectId))];
  const kinds = await tx
    .select({
      objectId: changes.objectId,
      rollbackOfObjectId: changes.rollbackOfObjectId,
      properties: objects.properties
    })
    .from(changes)
    .innerJoin(objects, and(eq(objects.orgId, changes.orgId), eq(objects.id, changes.objectId)))
    .where(and(eq(changes.orgId, orgId), inArray(changes.objectId, ids)));
  const isPlan = new Set(
    kinds
      .filter(
        (k) =>
          k.rollbackOfObjectId === null &&
          ((k.properties as Record<string, unknown> | null)?.[
            INFRASTRUCTURE_DECLARATION_PROPERTY
          ] ?? null) === null
      )
      .map((k) => k.objectId)
  );
  return rows.filter((r) => isPlan.has(r.changeObjectId));
}

/** THE SHIPPED INFRA TEMPLATES ARE REACHABLE ONLY THROUGH THIS LANE. A binding of any OTHER Type,
 *  any other executor lane, or a recipe, pointing at `scp-infra-plan-v*` or `scp-infra-apply-v*`
 *  would submit it with whatever parameters that path supplied — a plan in someone else's
 *  workspace, or an apply nobody approved (verification probe D). Reconcile calls this, with a
 *  Decision, for every trigger this lane did not itself derive; the plugin host's
 *  `infra-template-guard.ts` refuses the same thing at the one door every submission passes. */
export function assertNotAnUngatedInfraTemplate(templateRef: string | null): void {
  if (templateRef === null || !INFRA_CATALOG_TEMPLATE_PATTERN.test(templateRef)) return;
  throw new InfraApplyRefused(
    `refusing to trigger '${templateRef}' outside the infrastructure lane: it plans or applies ` +
      `infrastructure, and is triggered only by that lane — a plan for a declared target, an apply ` +
      `of an accepted plan through its gate.`,
    {
      remediation:
        "bind the deployment-target's 'infrastructure' pipeline to scp-infra-plan-v1 and apply an " +
        "accepted plan with properties.infrastructure.applyPlan",
      inputContext: { gate: "infra_template_outside_lane", externalRef: templateRef }
    }
  );
}

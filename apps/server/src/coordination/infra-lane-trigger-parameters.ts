import {
  categoryOfType,
  infraApplyTemplateFor,
  InfrastructureChangeDeclarationSchema,
  INFRASTRUCTURE_DECLARATION_PROPERTY,
  INFRA_CATALOG_APPLY_TEMPLATE,
  type ExecutorType
} from "@scp/schemas";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { changePlans, changes, changeWaves, changeWaveTargets, objects } from "../db/schema.js";
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
 * plan chip); accepting that change — `change:accept` at every target, plus any quorum policy on
 * the validating→accepted edge — IS approving that plan. An apply is a second change naming it.
 * That reuses the gate, the Decision records and the audit chain as they are, instead of growing a
 * parallel approval model with its own roles.
 *
 * THE APPLY GATE, all evaluated here, inside the trigger-claim transaction, BEFORE `trigger()`:
 *   1. the named plan change exists, is a PLAN (not an apply, not a rollback), and is `accepted`;
 *   2. it has a SUCCEEDED plan at THIS target, run by the SAME executor instance about to apply,
 *      with a digest — an apply is bound to a digest or it is not triggered;
 *   3. no NEWER plan has run at this target since (a plan approved and then superseded cannot be
 *      applied — the newer one is what reflects the configuration now);
 *   4. no other apply of this plan is in flight, and none has SUCCEEDED — a re-apply of an applied
 *      plan is a no-op: no second trigger, a success recorded with the reason.
 * The template carries the second half: it re-plans and applies only if the digest still matches
 * (`deploy/helm-bundled/files/scp-infra.sh`).
 *
 * ENGAGES ONLY FOR `argo-workflows`. `managed-iac` stays the Mode C fallback exactly as it was (D2),
 * and every other executor bound to an `infrastructure` Type keeps receiving what it received.
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

/** A plain name: what OpenTofu accepts as a workspace and the template re-checks. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,89}$/;
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

/** What reconcile does with a trigger this lane derived. */
export type InfraLaneOutcome =
  | {
      kind: "trigger";
      phase: "plan" | "apply";
      /** The WorkflowTemplate to submit — the binding's own for a plan, its `-apply` sibling for an
       *  apply. Reconcile uses this in place of the binding's externalRef. */
      templateRef: string;
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

/** The deployment-target facts both phases need, read off the target at trigger time. */
async function readEnvironment(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<{
  environment: string;
  region?: string;
  stateWorkspace: string;
  infraPath?: string;
}> {
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
  // ONE STATE WORKSPACE PER TARGET'S PLACE, not per environment alone: ADR-0044's region targets
  // share an environment (`prod` in amer AND emea), and sharing one state between them would make
  // the second region's plan a plan to destroy the first's.
  const stateWorkspace = region ? `${environment}-${region}` : environment;
  if (!PLAIN_NAME.test(stateWorkspace)) {
    throw new InfraDeclarationRefused(
      `the state workspace '${stateWorkspace}' derived for ${targetObjectId} is not a plain name.`,
      { inputContext: { gate: "infra_workspace_malformed", stateWorkspace } }
    );
  }
  // Where in the repo this environment's configuration lives — a fact about the TARGET, the way a
  // Dockerfile path is a fact about a component. Absent ⇒ the template's own default (the root).
  const infraPath = readString(target.properties, "infrastructurePath");
  if (infraPath !== undefined && (infraPath.startsWith("/") || `/${infraPath}/`.includes("/../"))) {
    throw new InfraDeclarationRefused(
      `deployment-target ${targetObjectId} declares infrastructurePath '${infraPath}', which ` +
        `leaves the repository.`,
      { inputContext: { gate: "infra_path_escapes", infraPath } }
    );
  }
  return {
    environment,
    ...(region ? { region } : {}),
    stateWorkspace,
    ...(infraPath ? { infraPath } : {})
  };
}

function readSource(
  sourceRef: unknown
): { repo: string; commit: string; ref?: string } | undefined {
  const repo = readString(sourceRef, "repo");
  const commit = readString(sourceRef, "commit");
  if (!repo || !commit || !REPO_SHAPE.test(repo) || !FULL_COMMIT.test(commit)) return undefined;
  const ref = readString(sourceRef, "ref");
  return { repo, commit, ...(ref ? { ref } : {}) };
}

export async function infraLaneTriggerParameters(
  tx: TenantTx,
  input: InfraLaneInput
): Promise<InfraLaneOutcome | undefined> {
  if (categoryOfType(input.type) !== "infrastructure") return undefined;
  if (input.pluginModule !== INFRA_LANE_EXECUTOR_MODULE) return undefined;

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

  const [changeObject] = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.changeObjectId)))
    .limit(1);
  const declaration = readDeclaration(changeObject?.properties);
  const place = await readEnvironment(tx, input.orgId, input.targetObjectId);
  // EVERY KEY THE SCRIPT READS IS SENT, even at its default. An omitted `infraPath` would leave the
  // template's default in force — and leave the key open for a recipe to fill, which is a way to
  // plan one directory and apply another. Sent explicitly, the lane's value is the only value.
  const placeParameters = {
    environment: place.environment,
    stateWorkspace: place.stateWorkspace,
    region: place.region ?? "",
    infraPath: place.infraPath ?? ".",
    changeObjectId: input.changeObjectId,
    targetObjectId: input.targetObjectId
  };

  if (declaration.phase === "plan") {
    const source = readSource(input.sourceRef);
    if (!source) {
      throw new InfraDeclarationRefused(
        "an infrastructure plan is pinned to ONE revision, and this change's sourceRef names no " +
          "owner/name repo and full commit id. Planning a branch would let the configuration move " +
          "between the plan an approver reads and the apply that follows it.",
        {
          remediation:
            "propose the plan with sourceRef { repo: 'owner/name', commit: '<full sha>' } (a webhook-born " +
            "change carries both)",
          inputContext: { gate: "infra_source_unpinned" }
        }
      );
    }
    return {
      kind: "trigger",
      phase: "plan",
      templateRef: planTemplate,
      parameters: {
        ...placeParameters,
        sourceRepo: source.repo,
        sourceCommit: source.commit,
        sourceRef: source.ref ?? ""
      }
    };
  }

  return evaluateApplyGate(tx, input, {
    planChangeObjectId: declaration.planChangeObjectId,
    applyTemplate,
    placeParameters
  });
}

/** One wave-target row of an infrastructure change at a target, with its change's facts. */
interface InfraWaveTargetRow {
  id: string;
  changeObjectId: string;
  status: string;
  executorPluginId: string | null;
  observedState: WaveTargetObservedState | null;
  createdAt: Date;
}

async function evaluateApplyGate(
  tx: TenantTx,
  input: InfraLaneInput,
  args: {
    planChangeObjectId: string;
    applyTemplate: string;
    placeParameters: Record<string, unknown>;
  }
): Promise<InfraLaneOutcome> {
  const { orgId, targetObjectId } = input;
  const { planChangeObjectId } = args;
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
      sourceRef: changes.sourceRef,
      properties: objects.properties
    })
    .from(changes)
    .innerJoin(objects, and(eq(objects.orgId, changes.orgId), eq(objects.id, changes.objectId)))
    .where(and(eq(changes.orgId, orgId), eq(changes.objectId, planChangeObjectId)))
    .limit(1);
  if (!planChange) {
    return refuse(
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
      "review the plan's evidence on the plan change, accept it (scp change accept), then re-propose this apply",
      { planChangeState: planChange.state }
    );
  }

  // 2. Its plan AT THIS TARGET — succeeded, by this executor, with a digest.
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

  // 3. SUPERSEDED — a newer plan has run here since.
  const newer = (
    await infraWaveTargetsAt(tx, orgId, targetObjectId, {
      createdAfter: planTarget.createdAt,
      excludeChangeObjectId: planChangeObjectId
    })
  ).filter(
    (t) =>
      (DISPATCHED_STATUSES as readonly string[]).includes(t.status) &&
      t.changeObjectId !== input.changeObjectId
  );
  const newerPlans = await plansOnly(tx, orgId, newer);
  if (newerPlans.length > 0) {
    const latest = newerPlans[0]!;
    refuse(
      "infra_plan_superseded",
      `plan change ${planChangeObjectId} was superseded at ${targetObjectId} by plan change ` +
        `${latest.changeObjectId}. The newest plan is the one that reflects the configuration now.`,
      `review and accept plan change ${latest.changeObjectId}, then apply THAT plan`,
      { supersededBy: latest.changeObjectId, supersededByStatus: latest.status, planDigest }
    );
  }

  // 4. ALREADY APPLIED, or being applied.
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

  // THE PLAN'S SOURCE, not this change's: the apply re-plans the revision that was approved.
  const source = readSource(planChange.sourceRef);
  if (!source) {
    refuse(
      "infra_plan_source_unpinned",
      `plan change ${planChangeObjectId} carries no pinned source, so there is no revision to re-plan.`,
      "re-plan from a pinned commit, accept it, and apply that plan"
    );
  }
  return {
    kind: "trigger",
    phase: "apply",
    templateRef: args.applyTemplate,
    parameters: {
      ...args.placeParameters,
      sourceRepo: source.repo,
      sourceCommit: source.commit,
      sourceRef: source.ref ?? "",
      planDigest,
      planChangeObjectId
    }
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
    createdAfter?: Date;
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
      observedState: changeWaveTargets.observedState,
      createdAt: changeWaveTargets.createdAt
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
        filter.createdAfter ? gt(changeWaveTargets.createdAt, filter.createdAfter) : undefined,
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

/** THE CATALOG APPLY TEMPLATE IS REACHABLE ONLY THROUGH THE GATE. A binding of any OTHER Type (or
 *  on any other lane) whose externalRef names a shipped infra apply template would submit it with
 *  whatever parameters that lane or a recipe supplied — an apply nobody approved. Reconcile calls
 *  this for every trigger this lane did not itself derive. */
export function assertNotAnUngatedInfraApply(templateRef: string | null): void {
  if (templateRef === null) return;
  if (
    templateRef === INFRA_CATALOG_APPLY_TEMPLATE ||
    /^scp-infra-apply-v[0-9]+$/.test(templateRef)
  ) {
    throw new InfraApplyRefused(
      `refusing to trigger '${templateRef}' outside the infrastructure lane: it applies infrastructure, ` +
        `and it is triggered only for an accepted, current plan through that lane's gate.`,
      {
        remediation:
          "bind the deployment-target's 'infrastructure' pipeline to scp-infra-plan-v1 and apply an " +
          "accepted plan with properties.infrastructure.applyPlan",
        inputContext: { gate: "infra_apply_template_outside_lane", externalRef: templateRef }
      }
    );
  }
}

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  REGIONAL_EXECUTOR_EXPECTED_MODULE,
  type ExecutorType,
  type RegionalExecutorEntry,
  type RegionalExecutorView
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  getExecutorBinding,
  DEFAULT_BINDING_TYPE,
  type ExecutorBindingRow
} from "./executor-bindings-repo.js";

/**
 * Multi-region Argo CD config SURFACE (M15.6, ADR-0017 §3).
 *
 * A prod environment that spans regions is modeled with the EXISTING graph — no new object type
 * (charter principle 2). A region is an ordinary `deployment-target` that carries two properties:
 *   - `environment` — the env name it belongs to (e.g. "prod"); the grouping key.
 *   - `region`      — the region label (e.g. "amer", "apac").
 * Its per-region Argo CD is an ordinary per-region executor binding (1:1, resolved per target via
 * `getExecutorBinding`), exactly the mechanism that already fans a change out to a distinct Argo CD
 * per region. This milestone adds two coordinated pieces over that mechanism:
 *
 *   - a first-class READ + VALIDATE view of `prod env -> {region -> argocd binding}`
 *     (`buildRegionalExecutorView`) so an operator can see the whole set coherently, with BOTH the
 *     enforced signal (every region has SOME executor binding of its type) and the advisory signal
 *     (each binding resolves to Argo CD, `isExpectedModule`) surfaced as `problems`; and
 *
 *   - a DEPLOY-TIME gate (`evaluateRegionalDeployGate`, consumed by reconcile at trigger time) that
 *     ENFORCES the first, load-bearing half of that verdict: a declared region target with NO
 *     resolvable executor binding of `type` is REFUSED (fail-closed — a block Decision + audit),
 *     never silently dispatched against the shared default fake executor. The gate and the view read
 *     the SAME membership convention and the SAME `getExecutorBinding` resolution, so they agree on
 *     which targets are region targets and whether each is bound.
 *
 * Precisely what is ENFORCED vs ADVISORY (do not overclaim): the deploy gate blocks an UNBOUND region
 * target (the silent-default-deploy gap). Module-correctness (a region bound to a non-Argo-CD module)
 * is `valid:false` in the view but is NOT hard-blocked at deploy — such a region still deploys against
 * its bound executor; the view names it so an operator can fix it.
 */

/** A region deployment-target as read from the graph (only the fields the view needs). */
interface RegionTargetRow {
  id: string;
  name: string;
  region: string;
}

/** The per-region binding signal shared by BOTH the advisory view and the deploy-time gate, so the
 *  two never disagree on whether a region is bound or resolves to the expected Argo CD module.
 *  `bound` is the ENFORCED half (a region must resolve SOME executor binding of its type or a deploy
 *  would fall to the shared default executor); `isExpectedModule` is the ADVISORY half (it names, but
 *  the deploy gate does not block, a region bound to a non-Argo-CD module). */
function regionBindingSignal(binding: ExecutorBindingRow | undefined): {
  bound: boolean;
  pluginModule: string | null;
  isExpectedModule: boolean;
} {
  const bound = binding !== undefined;
  const pluginModule = binding?.pluginModule ?? null;
  return { bound, pluginModule, isExpectedModule: pluginModule === REGIONAL_EXECUTOR_EXPECTED_MODULE };
}

/**
 * The LIVE `deployment-target` objects that declare membership in `environment` (via
 * `properties.environment`), ordered by their `properties.region` label for a stable view. A target
 * that declares the environment but omits `region` is still returned (with an empty region label) so
 * the validator can flag the misconfiguration rather than silently dropping it.
 */
async function listRegionTargets(
  tx: TenantTx,
  orgId: string,
  environment: string
): Promise<RegionTargetRow[]> {
  const rows = await tx
    .select({
      id: objects.id,
      name: objects.name,
      region: sql<string | null>`${objects.properties} ->> 'region'`
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "deployment-target"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'environment' = ${environment}`
      )
    )
    .orderBy(sql`${objects.properties} ->> 'region'`, objects.createdAt, objects.id);
  return rows.map((r) => ({ id: r.id, name: r.name, region: (r.region ?? "").trim() }));
}

/**
 * Builds the `prod env -> {region -> argocd binding}` view for one environment and validates that
 * every region deployment-target has its own Argo CD binding of `type` (default `configuration` —
 * Argo CD is a GitOps sync). The verdict is FAIL-CLOSED in the honest sense: an env with no region
 * targets, a region missing its `region` label, a region with no binding, or a region bound to a
 * NON-argocd module are each a `problem` that makes `valid: false`. Nothing here dispatches or
 * mutates — it reads bindings that the existing per-target PUT already wrote.
 */
export async function buildRegionalExecutorView(
  tx: TenantTx,
  orgId: string,
  environment: string,
  type: ExecutorType = DEFAULT_BINDING_TYPE
): Promise<RegionalExecutorView> {
  const targets = await listRegionTargets(tx, orgId, environment);
  const regions: RegionalExecutorEntry[] = [];
  const problems: string[] = [];
  const seenRegions = new Map<string, string>(); // region label -> first target name

  for (const target of targets) {
    const binding = await getExecutorBinding(tx, orgId, target.id, type);
    const { bound, pluginModule, isExpectedModule } = regionBindingSignal(binding);
    regions.push({
      region: target.region,
      targetId: target.id,
      targetName: target.name,
      bound,
      pluginModule,
      isExpectedModule,
      executionSystemId: binding?.executionSystemId ?? null,
      externalRef: binding?.externalRef ?? null
    });

    if (target.region.length === 0) {
      problems.push(
        `deployment-target '${target.name}' declares environment '${environment}' but has no 'region' property`
      );
    } else if (seenRegions.has(target.region)) {
      problems.push(
        `region '${target.region}' is declared by more than one deployment-target ('${seenRegions.get(target.region)}' and '${target.name}') in environment '${environment}'`
      );
    } else {
      seenRegions.set(target.region, target.name);
    }

    const regionLabel = target.region.length > 0 ? `region '${target.region}'` : `deployment-target '${target.name}'`;
    if (!bound) {
      problems.push(
        `${regionLabel} has no '${type}' executor binding — bind an Argo CD execution-system to it before deploying environment '${environment}'`
      );
    } else if (!isExpectedModule) {
      problems.push(
        `${regionLabel} is bound to '${pluginModule}', not '${REGIONAL_EXECUTOR_EXPECTED_MODULE}' — a multi-region prod env expects an Argo CD per region`
      );
    }
  }

  if (targets.length === 0) {
    problems.push(
      `no region deployment-targets declared for environment '${environment}' (a region is a deployment-target with properties.environment='${environment}' and properties.region set)`
    );
  }

  return {
    environment,
    type,
    expectedModule: REGIONAL_EXECUTOR_EXPECTED_MODULE,
    regions,
    valid: targets.length > 0 && problems.length === 0,
    problems
  };
}

/** A deployment-target's declared multi-region membership, per the M15.6 convention. */
export interface RegionMembership {
  environment: string;
  region: string;
}

/**
 * Reads whether `targetObjectId` DECLARES multi-region membership — a LIVE `deployment-target`
 * carrying BOTH a non-empty `properties.environment` AND a non-empty `properties.region` (the exact
 * grouping convention `listRegionTargets`/`buildRegionalExecutorView` read). Returns the declared
 * `{ environment, region }`, or `null` when the target is not a region target (missing either
 * property, wrong object type, soft-deleted, or absent). `null` is the SCOPE GUARD: a plain target
 * is out of scope and its coordination behaviour is left entirely unchanged.
 */
export async function readDeclaredRegionMembership(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<RegionMembership | null> {
  const rows = await tx
    .select({
      environment: sql<string | null>`${objects.properties} ->> 'environment'`,
      region: sql<string | null>`${objects.properties} ->> 'region'`
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, targetObjectId),
        eq(objects.typeId, "deployment-target"),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const environment = (row.environment ?? "").trim();
  const region = (row.region ?? "").trim();
  if (environment.length === 0 || region.length === 0) return null;
  return { environment, region };
}

/** The deploy-time verdict for one declared region target. See `evaluateRegionalDeployGate`. */
export interface RegionalDeployGate extends RegionMembership {
  bound: boolean;
  pluginModule: string | null;
  isExpectedModule: boolean;
  /**
   * The ENFORCED deploy property: `true` iff the region target resolves SOME executor binding of
   * `type`, so a deploy is never silently dispatched against the shared default executor. `false`
   * ⇒ the caller MUST refuse (fail-closed). This is the `bound` half of the advisory view's `valid`;
   * module-correctness (`isExpectedModule`) is the ADVISORY half the view surfaces but this gate does
   * NOT block on — a region bound to a non-Argo-CD module still deploys against its bound executor.
   */
  deployAllowed: boolean;
}

/**
 * DEPLOY-TIME gate for the M15.6 no-silent-deploy property, consumed by the reconcile trigger path.
 * Returns `null` when `targetObjectId` is NOT a declared region target — the SCOPE GUARD that leaves
 * every non-region target's existing behaviour (including the shared-default fake executor for an
 * unbound plain target) untouched. When it IS a region target, resolves its `type` binding with the
 * SAME `getExecutorBinding` the advisory view uses and reports `deployAllowed = bound`. Read-only:
 * it dispatches and mutates nothing; the caller owns the block Decision + audit + park.
 */
export async function evaluateRegionalDeployGate(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: ExecutorType = DEFAULT_BINDING_TYPE
): Promise<RegionalDeployGate | null> {
  const membership = await readDeclaredRegionMembership(tx, orgId, targetObjectId);
  if (!membership) return null;
  const binding = await getExecutorBinding(tx, orgId, targetObjectId, type);
  const signal = regionBindingSignal(binding);
  return { ...membership, ...signal, deployAllowed: signal.bound };
}

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  REGIONAL_EXECUTOR_EXPECTED_MODULE,
  type ExecutorType,
  type RegionalExecutorEntry,
  type RegionalExecutorView
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { getExecutorBinding, DEFAULT_BINDING_TYPE } from "./executor-bindings-repo.js";

/**
 * Multi-region Argo CD config SURFACE (M15.6, ADR-0017 §3).
 *
 * A prod environment that spans regions is modeled with the EXISTING graph — no new object type
 * (charter principle 2). A region is an ordinary `deployment-target` that carries two properties:
 *   - `environment` — the env name it belongs to (e.g. "prod"); the grouping key.
 *   - `region`      — the region label (e.g. "amer", "apac").
 * Its per-region Argo CD is an ordinary per-region executor binding (1:1, resolved per target via
 * `getExecutorBinding`), exactly the mechanism that already fans a change out to a distinct Argo CD
 * per region. What was missing — and all this milestone adds — is a first-class READ + VALIDATE view
 * of `prod env -> {region -> argocd binding}` so an operator can see the whole set coherently and be
 * told, helpfully, when a region has no Argo CD of its own rather than silently deploying it against
 * nothing.
 */

/** A region deployment-target as read from the graph (only the fields the view needs). */
interface RegionTargetRow {
  id: string;
  name: string;
  region: string;
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
    const bound = binding !== undefined;
    const pluginModule = binding?.pluginModule ?? null;
    const isExpectedModule = pluginModule === REGIONAL_EXECUTOR_EXPECTED_MODULE;
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

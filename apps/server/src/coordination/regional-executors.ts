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

/** Multi-region Argo CD config SURFACE. See docs/coordination.md §829. */

/** A region deployment-target as read from the graph (only the fields the view needs). */
interface RegionTargetRow {
  id: string;
  name: string;
  region: string;
}

/** The per-region binding signal the view and gate share. See docs/coordination.md §830. */
function regionBindingSignal(binding: ExecutorBindingRow | undefined): {
  bound: boolean;
  pluginModule: string | null;
  isExpectedModule: boolean;
} {
  const bound = binding !== undefined;
  const pluginModule = binding?.pluginModule ?? null;
  return {
    bound,
    pluginModule,
    isExpectedModule: pluginModule === REGIONAL_EXECUTOR_EXPECTED_MODULE
  };
}

/** The live targets declaring membership in an environment. See docs/coordination.md §831. */
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

/** Builds the region-to-binding view and validates it. See docs/coordination.md §832. */
export async function buildRegionalExecutorView(
  tx: TenantTx,
  orgId: string,
  environment: string,
  type: ExecutorType = DEFAULT_BINDING_TYPE
): Promise<RegionalExecutorView> {
  const targets = await listRegionTargets(tx, orgId, environment);
  const regions: RegionalExecutorEntry[] = [];
  const problems: string[] = [];
  const seenRegions = new Map<string, string>();

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

    const regionLabel =
      target.region.length > 0 ? `region '${target.region}'` : `deployment-target '${target.name}'`;
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

/** Does this target declare multi-region membership. See docs/coordination.md §833. */
export async function readDeclaredRegionMembership(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<RegionMembership | null> {
  // Composes over `readStageProperties`. See docs/coordination.md §834.
  const declared = await readStageProperties(tx, orgId, targetObjectId);
  if (!declared) return null;
  const { environment, region } = declared;
  if (environment.length === 0 || region.length === 0) return null;
  return { environment, region };
}

/** The one place that reads the stage convention off a row. See docs/coordination.md §835. */
async function readStageProperties(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<{ environment: string; region: string } | null> {
  const rows = await tx
    .select({
      environment: sql<string | null>`${objects.properties} ->> 'environment'`,
      region: sql<string | null>`${objects.properties} ->> 'region'`
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, id),
        eq(objects.typeId, "deployment-target"),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { environment: (row.environment ?? "").trim(), region: (row.region ?? "").trim() };
}

/** WHERE a wave target runs, as an instance-scoped freeze addresses it (drizzle/0086). `region` is
 *  null for a stage that declares an environment and no region — a real and common shape, and the
 *  reason this is not `RegionMembership` (which requires both halves). */
export interface StageCoordinate {
  environment: string;
  region: string | null;
}

/** The stage coordinate a wave target sits at, or null. See docs/coordination.md §836. */
export async function readStageCoordinate(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<StageCoordinate | null> {
  const placeId = await deploymentTargetOfPlacement(tx, orgId, targetObjectId);
  const declared = await readStageProperties(tx, orgId, placeId ?? targetObjectId);
  if (!declared || declared.environment.length === 0) return null;
  return {
    environment: declared.environment,
    region: declared.region.length > 0 ? declared.region : null
  };
}

/** The deploy-time verdict for one declared region target. See `evaluateRegionalDeployGate`. */
export interface RegionalDeployGate extends RegionMembership {
  bound: boolean;
  pluginModule: string | null;
  isExpectedModule: boolean;
  /** The ENFORCED deploy property. See docs/coordination.md §837. */
  deployAllowed: boolean;
}

/** The deploy-time gate for the no-silent-deploy property. See docs/coordination.md §838. */
export async function evaluateRegionalDeployGate(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: ExecutorType = DEFAULT_BINDING_TYPE
): Promise<RegionalDeployGate | null> {
  // A wave target may now be a PLACEMENT. See docs/coordination.md §839.
  const placeId = await deploymentTargetOfPlacement(tx, orgId, targetObjectId);
  const regionTargetId = placeId ?? targetObjectId;

  const membership = await readDeclaredRegionMembership(tx, orgId, regionTargetId);
  if (!membership) return null;
  // The BINDING is still resolved against the wave target itself, not the region target: a placement
  // carries its own binding, and that is the whole point of the pair. Only the MEMBERSHIP question
  // ("is this a declared region?") hops to the place.
  const binding = await getExecutorBinding(tx, orgId, targetObjectId, type);
  const signal = regionBindingSignal(binding);
  return { ...membership, ...signal, deployAllowed: signal.bound };
}

/** Mirrors `graph/containment.ts`'s `UUID_TEXT_PATTERN` and `gate-orchestrator.ts`'s
 *  `UUID_PATTERN` — the same shape check on the same field, on this side of the DB boundary. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The deployment target a placement names, or null. See docs/coordination.md §840. */
async function deploymentTargetOfPlacement(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<string | null> {
  const rows = await tx
    .select({
      deploymentTargetId: sql<string | null>`${objects.properties} ->> 'deploymentTargetId'`
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, id),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  const declared = rows[0]?.deploymentTargetId ?? null;
  return declared !== null && UUID_PATTERN.test(declared) ? declared : null;
}

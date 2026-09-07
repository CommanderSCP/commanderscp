import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { findObjectByIdOrUrnAnyType, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";

/** Types whose authority binds to a declared field. See docs/coordination.md §217. */
export const COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set([
  "campaign",
  "change"
]);

export function isCoordinationTargetScopedObjectType(typeId: string): boolean {
  return COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS.has(typeId);
}

/** Binds declared targets to the actor's own authority. See docs/coordination.md §218. */
export async function assertCoordinationTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; targets: unknown }
): Promise<void> {
  if (!Array.isArray(input.targets)) return;
  for (const idOrUrn of input.targets) {
    if (typeof idOrUrn !== "string") continue;
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: target.id
    });
  }
}

/** Binds stage dependencies to the actor's own authority. See docs/coordination.md §219. */
export async function assertStageDependenciesWithinAuthority(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    /** The edge `from` endpoints — the change's declared targets. Omitted on the ingress paths,
     *  where the component is chosen at correlation time by an operator-configured `source_mappings`
     *  row rather than by the caller, and is not known until the reconcile tick processes the
     *  event. */
    targets?: unknown;
    stageDependencies: unknown;
  }
): Promise<void> {
  if (!Array.isArray(input.stageDependencies) || input.stageDependencies.length === 0) return;

  const check = async (idOrUrn: unknown, permission: "relationship:write" | "object:read") => {
    if (typeof idOrUrn !== "string") return;
    const object = await findObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    if (!object) return;
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission,
      scopeObjectId: object.id
    });
  };

  if (Array.isArray(input.targets)) {
    for (const idOrUrn of input.targets) await check(idOrUrn, "relationship:write");
  }
  for (const entry of input.stageDependencies as readonly unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const dep = entry as { dependsOn?: unknown; atTargets?: unknown };
    await check(dep.dependsOn, "relationship:write");
    if (!Array.isArray(dep.atTargets)) continue;
    for (const at of dep.atTargets as readonly unknown[]) await check(at, "object:read");
  }
}

/** Campaign wrapper reading `properties.targets`. See docs/coordination.md §220. */
export async function assertCampaignTargetsWithinAuthority(
  tx: TenantTx,
  input: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
): Promise<void> {
  return assertCoordinationTargetsWithinAuthority(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    targets: input.properties?.targets
  });
}

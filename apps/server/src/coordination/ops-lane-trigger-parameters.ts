import type { TrustDomainId } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { deriveOpsRunMaterial } from "./ops-run-material.js";

/**
 * WHAT A HOST-REACHING TRIGGER TELLS `managed-ops` — the production caller `deriveOpsRunMaterial`
 * did not have (M27.9).
 *
 * M27 built the producer's parts and the consumer's refusal and never the call between them. This
 * is the call. It is the ops-lane twin of `buildLaneTriggerParameters`, and deliberately shaped
 * like it so the two lanes are read side by side — but the merge rule is INVERTED, and that
 * inversion is the point (ADR-0052). The build lane lets a recipe win a key collision because a
 * recipe is an operator's explicit instruction. Here the derived values are not conveniences, they
 * are the bound: the inventory is which machines get touched, and the allowlist is what the run can
 * reach at all. So these win, and `reconcile.ts` spreads them LAST.
 */

/** The catalog's three roles, one per charter class (`apps/runner-ops/catalog/catalog.json`).
 *
 *  DUPLICATED HERE ON PURPOSE, and gated by a test that reads the catalog: the catalog lives inside
 *  the runner IMAGE, which the server cannot open at request time and must not learn to. A role
 *  the server would dispatch but the image does not carry has to fail at admission with a sentence,
 *  not inside a container as an Ansible path error. */
export const OPS_CATALOG_ROLES = ["os_package", "config_file", "scheduled_unit"] as const;
export type OpsCatalogRole = (typeof OPS_CATALOG_ROLES)[number];

export class OpsDeclarationRefused extends Error {}

export interface OpsLaneTriggerParameterInput {
  orgId: string;
  /** The infrastructure product whose observed membership becomes the inventory. */
  targetObjectId: string;
  /** The change object. Its `properties` are READ HERE rather than passed in — `reconcile.ts`
   *  holds a `ChangeRow`, whose properties live on the underlying graph object, so a caller passing
   *  "the change's properties" would have had to fetch the object and could fetch the wrong one. */
  changeObjectId: string;
  /** The module the binding resolved to. Anything but `managed-ops` derives nothing. */
  pluginModule: string | null;
  masterKey: Buffer;
}

/** The declared operation, read out of `change.properties.ops`.
 *
 *  A change against an infrastructure product carries WHICH operation it is; nothing else in the
 *  model answers it. It is not a campaign recipe, and it cannot be: `managed-ops` is in
 *  `RECIPE_FORBIDDEN_EXECUTOR_MODULES`, so a recipe naming this executor terminalises the target
 *  before it reaches here. That refusal is what makes `properties.ops` the only door. */
function readDeclaration(bag: unknown): {
  role: OpsCatalogRole;
  arguments: Record<string, unknown>;
} {
  const ops = bag && typeof bag === "object" ? (bag as Record<string, unknown>)["ops"] : undefined;
  if (!ops || typeof ops !== "object") {
    throw new OpsDeclarationRefused(
      "this change targets a host-reaching executor but declares no operation. Set " +
        "`properties.ops` to `{ role, arguments }`, naming one of: " +
        `${OPS_CATALOG_ROLES.join(", ")}.`
    );
  }
  const role = (ops as Record<string, unknown>)["role"];
  if (typeof role !== "string" || !OPS_CATALOG_ROLES.includes(role as OpsCatalogRole)) {
    throw new OpsDeclarationRefused(
      `'${String(role)}' is not a role in the signed task catalog. The catalog is CLOSED to the ` +
        `three classes the charter's 2026-07-12 host-reaching amendment enumerates: ` +
        `${OPS_CATALOG_ROLES.join(", ")}. Adding a fourth is a charter conversation, not a ` +
        `parameter.`
    );
  }
  const args = (ops as Record<string, unknown>)["arguments"];
  // An absent argument bag is a legitimate role invocation, not an error — refusing here would
  // make every zero-argument role unreachable. An argument bag of the WRONG TYPE is a mistake
  // worth surfacing, because it means the author believed they were passing something.
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    throw new OpsDeclarationRefused(
      "`properties.ops.arguments` must be an object of the role's own arguments."
    );
  }
  return { role: role as OpsCatalogRole, arguments: (args as Record<string, unknown>) ?? {} };
}

export async function opsLaneTriggerParameters(
  tx: TenantTx,
  input: OpsLaneTriggerParameterInput
): Promise<Record<string, unknown> | undefined> {
  // Only the host-reaching actuator. Every other executor gets nothing from this lane — deriving a
  // certificate for a run that will never use one would mint host credentials for no reason.
  if (input.pluginModule !== "managed-ops") return undefined;

  const [changeObject] = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.changeObjectId)))
    .limit(1);
  const declaration = readDeclaration(changeObject?.properties);

  // THE TRUST DOMAIN IS READ OFF THE TARGET, never passed in. ADR-0051 D2 makes the CA per-domain
  // precisely so a compromise is bounded by the segment, and a caller-supplied domain would be a
  // way to ask one domain's CA for a certificate against another domain's hosts.
  const [target] = await tx
    .select({ originDomainId: objects.originDomainId })
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.targetObjectId)))
    .limit(1);
  if (!target) {
    throw new OpsDeclarationRefused(
      `refusing to derive host-reaching material: target ${input.targetObjectId} does not resolve.`
    );
  }

  const material = await deriveOpsRunMaterial(tx, {
    orgId: input.orgId,
    domainId: target.originDomainId as TrustDomainId,
    productObjectId: input.targetObjectId,
    role: declaration.role,
    subjectObjectId: input.changeObjectId,
    masterKey: input.masterKey
  });

  // The role's OWN arguments ride alongside, outside the closed derived set — `roleArguments()` in
  // the plugin strips the derived keys back out and `params_to_vars.py` marks every string
  // `!unsafe` on the way in (M27.2), so a value containing `{{ ... }}` reaches the task literally.
  // Spread FIRST so a declared argument colliding with a derived key cannot win.
  return { ...declaration.arguments, ...material };
}

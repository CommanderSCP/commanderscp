import type { TrustDomainId } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  RecipeOverrideRefused,
  SERVER_DERIVED_OPS_KEYS,
  assertNoRecipeOverride
} from "@scp/plugin-managed-ops";
import { deriveOpsRunMaterial } from "./ops-run-material.js";
import { ARGO_OPS_DELIVERY_KEYS, createOpsRunRedemption } from "./ops-run-redemption.js";

/** The role's own arguments with the closed set removed — the same operation `managed-ops`'s
 *  `roleArguments()` performs for Mode C, so a declared argument named like a bound key reaches
 *  neither runner. */
function stripReserved(args: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set<string>([...SERVER_DERIVED_OPS_KEYS, ...ARGO_OPS_DELIVERY_KEYS]);
  return Object.fromEntries(Object.entries(args).filter(([k]) => !reserved.has(k)));
}

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
  /** The module the binding resolved to. See `isOpsLane` for what derives. */
  pluginModule: string | null;
  /** The binding's executor-side target — for `argo-workflows`, the WorkflowTemplate name. */
  externalRef?: string | null;
  /** The wave target this trigger serves; the Argo path's redemption is bound to it. */
  waveTargetId?: string;
  /** The resolved executor config (tenant + execution-system declared settings). The Argo path
   *  reads `opsSealingPublicKey` and `opsSourceAddresses` from it. */
  executorConfig?: Record<string, unknown>;
  /** The campaign recipe's parameters, if any — checked against the closed set (ADR-0052). */
  recipeParameters?: Record<string, unknown>;
  masterKey: Buffer;
}

/** The SCP catalog templates that run the host-ops catalog on an org's Argo Workflows (M28.2).
 *  Versioned in the name, like `scp-build-image-v1`: a new template ships beside the old one. */
export const OPS_ARGO_CATALOG_TEMPLATES = ["scp-ops-v1"] as const;

/**
 * WHICH TRIGGERS ARE HOST-REACHING — and therefore get material derived at all.
 *
 * `managed-ops` (Mode C), or `argo-workflows` bound to an SCP ops catalog template (M28.2). An
 * `argo-workflows` binding to ANY OTHER template gets nothing: an org-authored template is the org's
 * own executor holding its own credentials, and deriving an SCP certificate for it would hand SCP's
 * CA to code SCP never reviewed — exactly what the charter's 2026-09-23 amendment does not grant.
 */
export function isOpsLane(pluginModule: string | null, externalRef: string | null | undefined) {
  if (pluginModule === "managed-ops") return true;
  return (
    pluginModule === "argo-workflows" &&
    typeof externalRef === "string" &&
    (OPS_ARGO_CATALOG_TEMPLATES as readonly string[]).includes(externalRef)
  );
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
  // Only a host-reaching run. Every other executor gets nothing from this lane — deriving a
  // certificate for a run that will never use one would mint host credentials for no reason.
  if (!isOpsLane(input.pluginModule, input.externalRef)) return undefined;

  // ADR-0052's refusal, WIRED. A recipe naming a bound key is an operator believing they can choose
  // hosts or reach; refusing keeps that belief from surviving. `managed-ops` never gets here with a
  // recipe (it is recipe-forbidden), but `argo-workflows` is not, so this is the door that holds.
  if (input.recipeParameters) {
    assertNoRecipeOverride(input.recipeParameters);
    const delivery = ARGO_OPS_DELIVERY_KEYS.filter((k) =>
      Object.prototype.hasOwnProperty.call(input.recipeParameters, k)
    );
    if (delivery.length > 0) {
      throw new RecipeOverrideRefused(
        `a campaign recipe may not set ${delivery.join(", ")} — the run token is minted per run by ` +
          "the server and sealed to the operator's key (ADR-0054)."
      );
    }
  }

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

  if (input.pluginModule === "argo-workflows") {
    // THE ARGO PATH (M28.2). The SAME bound derivation as Mode C — `createOpsRunRedemption` calls
    // `deriveOpsBound`, the function `deriveOpsRunMaterial` is built on — stored server-side and
    // handed to the pod only on redemption. The Workflow carries ciphertext and a row id; nothing a
    // Workflow editor can change reaches what the pod is given.
    if (!input.waveTargetId) {
      throw new OpsDeclarationRefused("an Argo host-ops trigger must name its wave target");
    }
    const config = input.executorConfig ?? {};
    const { opsRunTokenSealed, opsRunId } = await createOpsRunRedemption(tx, {
      orgId: input.orgId,
      domainId: target.originDomainId as TrustDomainId,
      productObjectId: input.targetObjectId,
      role: declaration.role,
      roleArguments: stripReserved(declaration.arguments),
      changeObjectId: input.changeObjectId,
      waveTargetId: input.waveTargetId,
      sealingPublicKeyPem: config["opsSealingPublicKey"],
      sourceAddresses: config["opsSourceAddresses"],
      masterKey: input.masterKey
    });
    return { opsRunTokenSealed, opsRunId };
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

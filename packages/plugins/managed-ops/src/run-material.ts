/**
 * THE CLOSED SET OF SERVER-DERIVED KEYS for a host-reaching run (ADR-0052).
 *
 * `reconcile.ts` merges campaign-recipe parameters with derived ones and, for the build lane,
 * "THE RECIPE WINS on a key collision, deliberately". For host-reaching runs that rule is
 * inverted, because these values are not conveniences — they are the bound:
 *
 *   - `opsInventory` is compiled from OBSERVED membership (D25(a): which hosts is derived, never
 *     authored);
 *   - `opsEgressAllowlist` is the set of addresses the run may reach at all, enforced as a
 *     NetworkPolicy;
 *   - `opsPrincipals` names who the certificate authorizes.
 *
 * A recipe key of the same name would replace the bound with an assertion. So the set is CLOSED
 * and enumerated here once, a recipe carrying any of these names is REFUSED rather than silently
 * overridden, and everything outside the set stays freely authorable — a role's own arguments are
 * unaffected.
 */

/** Every key `reconcile.ts` derives server-side for a host-reaching run. */
export const SERVER_DERIVED_OPS_KEYS = [
  "opsInventory",
  "opsEgressAllowlist",
  "opsPrincipals",
  "opsRole",
  "opsCredentialSecretKey"
] as const;

export type ServerDerivedOpsKey = (typeof SERVER_DERIVED_OPS_KEYS)[number];

export class RecipeOverrideRefused extends Error {}

/**
 * Refuse a parameter bag that tries to author the bound.
 *
 * REFUSES rather than silently dropping: an operator whose recipe names `opsInventory` has a
 * mistaken belief about how this class works, and a run that quietly ignored them would leave that
 * belief intact — next time against a fleet where the difference matters.
 */
export function assertNoRecipeOverride(recipeParameters: Record<string, unknown>): void {
  const offending = SERVER_DERIVED_OPS_KEYS.filter((k) =>
    Object.prototype.hasOwnProperty.call(recipeParameters, k)
  );
  if (offending.length > 0) {
    throw new RecipeOverrideRefused(
      `managed-ops: a campaign recipe may not set ${offending.join(", ")} — these are derived from ` +
        `resolved graph state (observed membership, the per-run egress allowlist, the certificate's ` +
        `principals) and are the bound on what a host-reaching run can reach. Author the role's own ` +
        `arguments instead; everything outside this closed set is yours.`
    );
  }
}

/** The material itself, after the server has derived it. */
export interface ServerDerivedOpsMaterial {
  /** The catalog role to run — resolved from the change's lane, not from a recipe. */
  opsRole: string;
  /** An Ansible INI inventory, compiled from observed membership. */
  opsInventory: string;
  /** The addresses this run may reach. Enforced at the network layer, not by the runner. */
  opsEgressAllowlist: readonly string[];
  /** Who the per-run certificate authorizes. */
  opsPrincipals: readonly string[];
  /**
   * A SECRET REFERENCE, never the certificate itself.
   *
   * Trigger parameters are persisted and surfaced in evidence, so a private key placed here would
   * be written to the database and into every backup of it. The server mints the credential, puts
   * it in the encrypted store under a short-lived key, and passes only the NAME — the plugin
   * resolves it through `ctx.secrets`, which is the channel that exists for exactly this.
   */
  opsCredentialSecretKey: string;
}

/**
 * Read the server-derived material out of a merged parameter bag, refusing anything incomplete.
 *
 * Every field is REQUIRED. A host-reaching run missing its inventory could otherwise start against
 * an empty host list and report success having done nothing — the "unbound placement fake-succeeds"
 * shape, with a host credential in it.
 */
export function readServerDerivedMaterial(
  parameters: Record<string, unknown> | undefined
): ServerDerivedOpsMaterial {
  const p = parameters ?? {};
  const role = p["opsRole"];
  const inventory = p["opsInventory"];
  const allowlist = p["opsEgressAllowlist"];
  const principals = p["opsPrincipals"];
  const credentialSecretKey = p["opsCredentialSecretKey"];

  const missing = SERVER_DERIVED_OPS_KEYS.filter((k) => p[k] === undefined);
  if (missing.length > 0) {
    throw new RecipeOverrideRefused(
      `managed-ops: this trigger is missing server-derived material (${missing.join(", ")}). ` +
        `REFUSING rather than running a host-reaching class against an incomplete bound.`
    );
  }
  if (typeof role !== "string" || role.length === 0) {
    throw new RecipeOverrideRefused("managed-ops: opsRole must be a non-empty string");
  }
  if (typeof inventory !== "string" || inventory.length === 0) {
    throw new RecipeOverrideRefused("managed-ops: opsInventory must be a non-empty string");
  }
  if (!Array.isArray(allowlist) || !allowlist.every((a) => typeof a === "string")) {
    throw new RecipeOverrideRefused("managed-ops: opsEgressAllowlist must be an array of strings");
  }
  if (!Array.isArray(principals) || principals.length === 0) {
    throw new RecipeOverrideRefused("managed-ops: opsPrincipals must be a non-empty array");
  }
  if (typeof credentialSecretKey !== "string" || credentialSecretKey.length === 0) {
    throw new RecipeOverrideRefused(
      "managed-ops: opsCredentialSecretKey must be a non-empty string"
    );
  }
  // A CHEAP GUARD AGAINST THE WRONG THING BEING PASSED. If a caller ever puts the certificate here
  // instead of its key, the value carries PEM/OpenSSH markers — refusing is far better than
  // writing key material into a parameter bag that gets persisted.
  if (/BEGIN |ssh-ed25519|-cert-v01@/.test(credentialSecretKey)) {
    throw new RecipeOverrideRefused(
      "managed-ops: opsCredentialSecretKey looks like credential MATERIAL, not a secret key name. " +
        "Trigger parameters are persisted; the material must stay in the secret store."
    );
  }
  return {
    opsRole: role,
    opsInventory: inventory,
    opsEgressAllowlist: allowlist as string[],
    opsPrincipals: principals as string[],
    opsCredentialSecretKey: credentialSecretKey
  };
}

import type { Db } from "../db/client.js";
import type { FederationRoleConfig } from "../dependencies/commander-only.js";
import {
  getInstanceCosignPublicKey,
  type CosignKeyGenerator,
  type InstanceCosignPublicKey
} from "../governance/cosign-keys.js";

/** Declared federation roles for tests that call repo functions directly (no `buildTestServer`
 *  config). Each names the deployment the fixture MODELS; component-journey-view.md §8.9 makes the
 *  role load-bearing for promotion export and for cosign key custody. */
export const DECLARED_COMMANDER: FederationRoleConfig = {
  federationRole: "commander",
  federationRoleDeclared: true
};
export const DECLARED_RETRANS: FederationRoleConfig = {
  federationRole: "retrans",
  federationRoleDeclared: true
};
export const DECLARED_OUTPOST: FederationRoleConfig = {
  federationRole: "outpost",
  federationRoleDeclared: true
};

/** `getInstanceCosignPublicKey` for a fixture that must HAVE a key — throws rather than returning
 *  `null`, so a custody refusal surfaces as a named fixture error instead of a later `.publicKey`
 *  of null. */
export async function requireCosignPublicKey(
  db: Db,
  orgId: string,
  federation: FederationRoleConfig,
  generate?: CosignKeyGenerator
): Promise<InstanceCosignPublicKey> {
  const key = await getInstanceCosignPublicKey(db, orgId, federation, generate);
  if (!key) throw new Error(`fixture expected a cosign key for org '${orgId}', custody refused it`);
  return key;
}

/**
 * SERVER-RESERVED TRIGGER PARAMETERS (M28.4 fix round, ADR-0055 D9).
 *
 * THE PROPERTY, not the instance. Every lane in `reconcile.ts` derives some trigger parameters as a
 * BOUND — what gets deployed, which machines get touched, where an artifact is published. A bound is
 * only a bound if nothing authored can restate it. The instance found by review was a campaign
 * recipe carrying `scpAuthoredApplication` for a component that declared no deployment: the deploy
 * lane derived nothing, the recipe's value passed straight through, and the argocd plugin created an
 * Application with a foreign source and a cluster-admin ClusterRoleBinding. The same shape existed,
 * unexploited, for every derived key a lane might OMIT: an omitted bound is filled by the recipe.
 *
 * So the rule is one table and one choke point. A key listed here may come from a server lane and
 * from nowhere else; a recipe naming one is refused, terminally, with a Decision and an audit event,
 * before `trigger()` (`resolveRecipeRefusal` in `reconcile.ts` — the only reader of recipe
 * parameters). Keys NOT listed are conveniences an operator may legitimately restate (the build
 * lane's recipe-wins rule stands for those).
 *
 * The census that produced it, lane by lane (every key each derivation writes):
 *
 * | Lane | Key | Reserved | Why |
 * |---|---|---|---|
 * | deploy (M28.4) | `scpAuthoredApplication` | yes | the whole authored deployment |
 * | ops (M27.9, ADR-0052) | `opsRole`, `opsInventory`, `opsEgressAllowlist`, `opsPrincipals`, `opsCredentialSecretKey` | yes | which hosts, what they may reach, which credential |
 * | build destination | `imageDestination`, `imageRepository`, `registryUrl`, `registryName` | yes | where an artifact is published — the `publishes_to` edge is the only door (M28 D1) |
 * | build destination (M28.1, ADR-0053) | `packageRepository`, `rpmUploadUrl`, `rpmRepositoryUrl` | yes | the same, for package repositories |
 * | build | `changeObjectId` | yes | the correlation identity the executor reports back under |
 * | build | `sourceRepo`, `sourceRef`, `sourceCommit`, `dockerfile` (and M28.1's other definition keys) | no | conveniences; a recipe restating them is the documented recipe-wins case |
 */
export const SERVER_RESERVED_TRIGGER_PARAMETERS: Readonly<Record<string, string>> = {
  scpAuthoredApplication: "the SCP-authored Argo CD Application (deploy lane, ADR-0055)",
  opsRole: "the host-reaching operation (ops lane, ADR-0052)",
  opsInventory: "which hosts a host-reaching run touches (ops lane, ADR-0052)",
  opsEgressAllowlist: "what a host-reaching run may reach (ops lane, ADR-0052)",
  opsPrincipals: "the principals a host-reaching certificate names (ops lane, ADR-0052)",
  opsCredentialSecretKey: "the credential a host-reaching run is issued (ops lane, ADR-0052)",
  imageDestination: "where an image is published (build lane; the publishes_to edge)",
  imageRepository: "where an image is published (build lane; the publishes_to edge)",
  registryUrl: "the registry an artifact is published to (build lane)",
  registryName: "the registry an artifact is published to (build lane)",
  packageRepository: "where a package is published (build lane, ADR-0053)",
  rpmUploadUrl: "where an RPM is uploaded (build lane, ADR-0053)",
  rpmRepositoryUrl: "where an RPM is published (build lane, ADR-0053)",
  changeObjectId: "the change identity the executor reports back under (build lane)"
};

/** The reserved keys an authored parameter bag names, sorted (content-stable for the Decision). */
export function reservedKeysIn(parameters: Record<string, unknown> | undefined): string[] {
  if (!parameters) return [];
  return Object.keys(parameters)
    .filter((k) => Object.prototype.hasOwnProperty.call(SERVER_RESERVED_TRIGGER_PARAMETERS, k))
    .sort();
}

export const WAVE_TARGET_RECIPE_RESERVED_PARAMETER_STATUS = "recipe_reserved_parameter";
export const WAVE_TARGET_RECIPE_RESERVED_PARAMETER_AUDIT_ACTION =
  "change.wave_target.recipe_reserved_parameter";

/** The boot-safety check, extracted so it is testable. See docs/server.md §27. */
export function assertProductionSecretsOrThrow(config: {
  deploymentMode: "production" | "evaluation";
  secretsMasterKeyWasGenerated: boolean;
  cookieSecretWasGenerated: boolean;
}): void {
  if (config.deploymentMode !== "production") return;
  const ephemeral: string[] = [];
  if (config.secretsMasterKeyWasGenerated) ephemeral.push("SCP_SECRETS_MASTER_KEY");
  if (config.cookieSecretWasGenerated) ephemeral.push("SCP_COOKIE_SECRET");
  if (ephemeral.length > 0) {
    throw new Error(
      `[scpd] refusing to boot in production mode with EPHEMERAL generated ${ephemeral.join(" and ")} ` +
        "— an ephemeral key silently orphans stored secrets / invalidates sessions on the next restart " +
        "and cannot survive a failover. Provide them via appSecrets.existingSecret (identical across " +
        "member clusters), or set SCP_DEPLOYMENT_MODE=evaluation for a dev/eval stack."
    );
  }
}

/** The ONE boot line for an undeclared federation role, or `null` when it is declared.
 *  SCP_FEDERATION_ROLE defaults to 'commander' for serving the SPA, but every commander-only and
 *  cosign-key-custody decision refuses an undeclared deployment FAIL-CLOSED (commander-only.ts), so
 *  an operator who never set it runs a "commander" that silently cannot promote — say so at boot. */
export function federationRoleUndeclaredWarning(config: {
  federationRoleDeclared: boolean;
}): string | null {
  if (config.federationRoleDeclared) return null;
  return (
    "[scpd] SCP_FEDERATION_ROLE is not set — this deployment is UNDECLARED, so promotion export, " +
    "cosign key minting and dependency automation are all REFUSED (fail-closed). Set " +
    "SCP_FEDERATION_ROLE=commander|outpost|retrans (Helm: federationRole) to enable what this " +
    "deployment is for."
  );
}

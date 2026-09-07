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

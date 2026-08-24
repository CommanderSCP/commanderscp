/**
 * D6 (§7.3) boot-safety check, extracted from `main.ts` so it is directly testable. A PRODUCTION
 * instance must not boot on EPHEMERAL generated secrets: an ephemeral `SCP_SECRETS_MASTER_KEY`
 * orphans every stored credential on restart, and an ephemeral `SCP_COOKIE_SECRET` invalidates
 * every session on restart — neither survives a failover, which is exactly the posture M26 exists to
 * make safe. `evaluation` mode (compose-eval, `pnpm dev`) keeps the zero-required-env boot; the
 * caller emits the loud-not-fatal warning there.
 */
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

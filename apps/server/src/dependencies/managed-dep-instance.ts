import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost, PluginHostInstanceConfig } from "../plugin-host/contract.js";
import {
  managedDepServerSettings,
  resolveExecutorPluginInstance,
  type ExecutorBindingRow
} from "../coordination/executor-bindings-repo.js";
import { isGitProviderModule } from "./manifest-reader.js";

/** HOW A `managed-dep` INSTANCE IS BUILT. See docs/dependencies.md §337. */

/** The component's git-provider binding. See docs/dependencies.md §338. */
export function pickComponentGitBinding(
  bindings: ExecutorBindingRow[],
  componentObjectId: string
): ExecutorBindingRow | undefined {
  return bindings
    .filter((b) => b.targetObjectId === componentObjectId && isGitProviderModule(b.pluginModule))
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
}

export interface ManagedDepInstanceDeps {
  db: Db;
  host: PluginHost;
  config: Pick<ServerConfig, "secretsMasterKey">;
}

/** Build and start the instance for this repository. See docs/dependencies.md §339. */
export async function startManagedDepInstance(
  deps: ManagedDepInstanceDeps,
  orgId: string,
  binding: ExecutorBindingRow,
  /** THIS RUN's receipt — see the module doc. Every caller passes one; a caller that shared one
   *  across jobs would re-create the teardown race the token exists to remove. */
  runToken: string
): Promise<string> {
  const settings = managedDepServerSettings();
  if (!settings.runnerImage) {
    throw new Error(
      "dependency-bump authoring is not enabled on this deployment (SCP_MANAGED_DEP_RUNNER_IMAGE is unset), so no bump is authored"
    );
  }
  const resolved = await withTenantTx(deps.db, orgId, (tx) =>
    resolveExecutorPluginInstance(tx, {
      orgId,
      targetObjectId: binding.targetObjectId,
      masterKey: deps.config.secretsMasterKey,
      type: binding.type
    })
  );
  if (!resolved) {
    throw new Error(
      `the git-provider binding ${binding.id} for this component could not be resolved, so no credential is available to author a bump`
    );
  }
  const tenant = (resolved.instanceConfig.config ?? {}) as Record<string, unknown>;
  if (binding.pluginModule !== "github") {
    // Only the GitHub App arm can mint a per-run, single-repository, short-lived credential, which
    // is the clause that authorises this class to exist at all (`repo-write.ts`'s
    // `resolveRepoWriter` refuses the others by name). Refused HERE too, so the refusal names the
    // binding rather than surfacing as a plugin error with no component in it.
    throw new Error(
      `this component's repository is served by a '${binding.pluginModule}' binding, and only a GitHub App can issue the per-run, repository-scoped, short-lived credential this class requires (charter 2026-08-13) — no bump is authored`
    );
  }
  const instance: PluginHostInstanceConfig = {
    id: `managed-dep:${binding.id}:${runToken}`,
    module: "managed-dep",
    orgId,
    scopeKey: resolved.instanceConfig.scopeKey,
    config: {
      provider: "github",
      appId: tenant.appId,
      installationId: tenant.installationId,
      privateKeySecretKey: tenant.privateKeySecretKey,
      ...(typeof tenant.apiBaseUrl === "string" ? { apiBaseUrl: tenant.apiBaseUrl } : {}),
      ...(typeof tenant.serverUrl === "string" && typeof tenant.apiBaseUrl !== "string"
        ? { apiBaseUrl: tenant.serverUrl }
        : {}),
      runnerImage: settings.runnerImage,
      workspaceRoot: settings.workspaceRoot,
      // The operator's runtime, and the launcher selection. See docs/dependencies.md §340.
      dockerBinary: settings.dockerBinary,
      runnerLauncher: settings.runnerLauncher,
      ...(settings.kubernetes ? { kubernetes: settings.kubernetes } : {})
    },
    ...(resolved.instanceConfig.secrets ? { secrets: resolved.instanceConfig.secrets } : {}),
    ...(resolved.instanceConfig.allowedHosts
      ? { allowedHosts: resolved.instanceConfig.allowedHosts }
      : {}),
    ...(resolved.instanceConfig.allowInternalEgress
      ? { allowInternalEgress: resolved.instanceConfig.allowInternalEgress }
      : {})
  };
  await deps.host.start([instance]);
  return instance.id;
}

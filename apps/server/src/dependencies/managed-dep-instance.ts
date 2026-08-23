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

/**
 * HOW A `managed-dep` INSTANCE IS BUILT — in ONE place, because there are now two callers.
 *
 * `bump-dispatch.ts` builds one to AUTHOR a bump; `bump-gate.ts` builds one to MERGE a bump that was
 * already authored. Those are different acts with different preconditions, but "which credential,
 * from whose binding, with which server-governed runner settings, and which providers are refused"
 * is one question with one answer — and a second copy of that answer is the property CLAUDE.md's
 * census rule is about. It is extracted rather than duplicated the moment the second caller exists,
 * not after the two have drifted.
 *
 * WHAT COMES FROM WHERE, because the trust tiers must not blur:
 *   * the GIT IDENTITY (App id, installation, the vaulted private-key reference and the API base)
 *     is the TENANT's, taken from the binding their team already configured for that repository —
 *     resolved through `resolveExecutorPluginInstance`, so the secret is decrypted by the same code
 *     path and under the same rules as every other plugin's;
 *   * the RUNNER SETTINGS are the SERVER's, from `managedDepServerSettings`, spread LAST so they
 *     win. With `SCP_MANAGED_DEP_RUNNER_IMAGE` unset that function yields no image and this throws
 *     BEFORE a container could be launched or a credential minted — the deployment-level expression
 *     of "managed execution is never a default" (ADR-0006) for the one class that writes to a user's
 *     repository. It gates the MERGE path too, deliberately: a deployment that has not enabled
 *     dependency authoring must not be able to merge one either.
 *   * there is NO network mode to inject: the plugin passes `--network none` as a literal (charter
 *     2026-08-15, unqualified for this class).
 *
 * IT IS ASSEMBLED FROM THE COMPONENT'S OWN GIT BINDING, not from an `executor_bindings` row of its
 * own — and `executor-bindings-repo.ts`'s `managedDepServerSettings` doc says why there is no such
 * row to have: a dependency bump fits none of the six executor Types honestly, and the precedent for
 * a managed class dispatched without one is `scp-managed-scan`, which
 * `federation/promotion-scan-step.ts` constructs directly.
 *
 * ============================================================================================
 * THE INSTANCE ID IS PER RUN, NOT PER BINDING — AND THAT IS A CORRECTNESS PROPERTY
 * ============================================================================================
 * It used to be `managed-dep:<bindingId>` alone. Two DIFFERENT jobs act on the same component's
 * binding — `bump-dispatch.ts` authors, `bump-gate.ts` merges — and both are ordinary background
 * workers that can be in flight at the same moment for the same component (a head advance and a CI
 * conclusion are unrelated events). Each ends with `host.stopInstances([...])` in a `finally`, so
 * with one shared id EITHER JOB TEARS DOWN THE OTHER'S SUBPROCESS MID-RPC — including a `status()`
 * call issued AFTER the provider has already merged, which turns a completed irreversible act into
 * an unreadable outcome the gate then records as a refusal.
 *
 * The `runToken` is the caller's receipt of its OWN run. Within one job it is a constant, so the
 * same component still reuses one subprocess across that job's candidates and the set a caller stops
 * is exact; across jobs the ids are disjoint, so no `finally` can reach another run's instance. It is
 * the same "stopped from a RECEIPT of what this code started, never from a second derivation of what
 * should be running" rule (ADR-0032 §7c clause 4), applied to the ID as well as to the set.
 */

/** The component's git-provider binding — the one that holds the credential for its repository.
 *
 *  DETERMINISTIC BY BINDING ID when a component somehow has several, so two callers looking at the
 *  same component reach the same repository. The repo itself is read from the binding rather than
 *  from a source mapping's glob or from a name: one team's installation token is not authority over
 *  another team's repository (`manifest-reader.ts` states the rule this follows). */
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

/** Build and start the `managed-dep` instance for this component's repository. Returns the instance
 *  id, which the caller is responsible for stopping (see `bump-dispatch.ts`'s `startedInstances`
 *  receipt — stopped from what this code STARTED, never from a second derivation of what "should"
 *  be running), and which is namespaced by `runToken` so one job's teardown cannot reach another's
 *  in-flight RPC. */
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
      // SERVER-GOVERNED, LAST — see this module's doc.
      runnerImage: settings.runnerImage,
      workspaceRoot: settings.workspaceRoot,
      // The operator's container runtime, and since M23.2 the launcher SELECTION with it. This is
      // the path that runs in production (the binding path below it is the hand-made rarity), so
      // omitting `dockerBinary` here meant `scp-managed-dep` `execFile`d a hardcoded `docker` on
      // every ordinary bump however the deployment was configured — while its two sibling managed
      // classes honoured the setting. The launcher selection has the SAME shape and a larger blast
      // radius: omitted here, the ordinary bump path would stay on Docker on a Kubernetes
      // deployment, i.e. M21's actuator would remain exactly as dead as M23 exists to fix.
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

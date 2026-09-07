import {
  manifest as githubExecutorManifest,
  discoveryManifest as githubDiscoveryManifest
} from "@scp/plugin-github";
import {
  manifest as giteaManifest,
  discoveryManifest as giteaDiscoveryManifest
} from "@scp/plugin-gitea";
import {
  manifest as gitlabManifest,
  discoveryManifest as gitlabDiscoveryManifest
} from "@scp/plugin-gitlab";
import {
  manifest as argocdManifest,
  discoveryManifest as argocdDiscoveryManifest
} from "@scp/plugin-argocd";
import { manifest as argoWorkflowsManifest } from "@scp/plugin-argo-workflows";
import { manifest as terraformManifest } from "@scp/plugin-terraform";
import { manifest as pipelineGenericManifest } from "@scp/plugin-pipeline-generic";
import { manifest as managedIacManifest } from "@scp/plugin-managed-iac";
import { manifest as managedScanManifest } from "@scp/plugin-managed-scan";
import { manifest as fakeExecutorManifest } from "@scp/plugin-fake-executor";
import { manifest as managedDepManifest } from "@scp/plugin-managed-dep";
import { manifest as webhookNotifyManifest } from "@scp/plugin-webhook-notify";
import { manifest as smtpNotifyManifest } from "@scp/plugin-smtp-notify";
import {
  goIndexManifest,
  mavenIndexManifest,
  npmIndexManifest,
  pypiIndexManifest
} from "@scp/plugin-dependency-index-registries";
import { ociIndexManifest } from "@scp/plugin-dependency-index-oci";
import { PluginManifestSchema, type PluginManifest as ApiPluginManifest } from "@scp/schemas";
import { validateProperties } from "../graph/property-validation.js";
import { badRequest } from "../errors.js";

/** The bundled plugin manifest catalog. See docs/plugin-host.md §84. */

/** Narrow a manifest to the public contract, or fail loud. See docs/plugin-host.md §85. */
function asApiManifest(manifest: { id: string; kind: string; version: string }): ApiPluginManifest {
  const parsed = PluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(
      `plugin manifest '${manifest.id}' (kind '${manifest.kind}') is not publishable on ` +
        `GET /api/v1/plugins/manifests: '@scp/schemas' PluginKindSchema does not enumerate that ` +
        `kind. Widen the v1 response enum deliberately (it is a public contract change), or leave ` +
        `this manifest out of BUNDLED_PLUGIN_MANIFESTS and reach it through MANIFEST_BY_MODULE only.`
    );
  }
  return parsed.data;
}

/** Every bundled plugin's `{id, kind, version, configSchema}` — the source a config form is generated FROM. */
export const BUNDLED_PLUGIN_MANIFESTS: ApiPluginManifest[] = [
  githubExecutorManifest,
  githubDiscoveryManifest,
  giteaManifest,
  giteaDiscoveryManifest,
  gitlabManifest,
  gitlabDiscoveryManifest,
  argocdManifest,
  argocdDiscoveryManifest,
  argoWorkflowsManifest,
  terraformManifest,
  managedIacManifest,
  webhookNotifyManifest,
  smtpNotifyManifest
].map(asApiManifest);

/** Two modules are deliberately absent from that list. See docs/plugin-host.md §86. */

/** M21.4's five `dependency-index` manifests. See docs/plugin-host.md §87. */

/** Three are here and deliberately not in the other list. See docs/plugin-host.md §88. */

/** Every bundled plugin's manifest, keyed by the module name a binding references. */
export const MANIFEST_BY_MODULE: Record<string, { configSchema: unknown }> = {
  "fake-executor": fakeExecutorManifest,
  github: githubExecutorManifest,
  "github-discovery": githubDiscoveryManifest,
  gitea: giteaManifest,
  "gitea-discovery": giteaDiscoveryManifest,
  gitlab: gitlabManifest,
  "gitlab-discovery": gitlabDiscoveryManifest,
  argocd: argocdManifest,
  "argocd-discovery": argocdDiscoveryManifest,
  "argo-workflows": argoWorkflowsManifest,
  terraform: terraformManifest,
  "pipeline-generic": pipelineGenericManifest,
  "managed-iac": managedIacManifest,
  "managed-scan": managedScanManifest,
  /** This entry is the whole point of authoring a schema. See docs/plugin-host.md §89. */
  "managed-dep": managedDepManifest,
  "webhook-notify": webhookNotifyManifest,
  "smtp-notify": smtpNotifyManifest,
  "dependency-index-go": goIndexManifest,
  "dependency-index-npm": npmIndexManifest,
  "dependency-index-pypi": pypiIndexManifest,
  "dependency-index-maven": mavenIndexManifest,
  "dependency-index-oci": ociIndexManifest
};

/** Whether `module` has a bundled manifest, i.e. whether `validatePluginConfig` has anything to
 *  gate on. Exported so an allowlist can assert its own completeness — see
 *  `assertEveryModuleHasManifest`. */
export function hasPluginManifest(module: string): boolean {
  return MANIFEST_BY_MODULE[module] !== undefined;
}

/** Throws if the config does not satisfy the declared schema. See docs/plugin-host.md §90. */
export function validatePluginConfig(module: string, config: unknown): void {
  const manifest = MANIFEST_BY_MODULE[module];
  if (!manifest) {
    throw badRequest(
      `plugin module '${module}' declares no config schema, so its config cannot be validated — ` +
        `refusing to store it. Add the module's manifest to MANIFEST_BY_MODULE ` +
        `(apps/server/src/plugin-host/plugin-manifests.ts).`
    );
  }
  validateProperties(manifest.configSchema, config ?? {});
}

/** Fails loud at load if an allowlisted module has none. See docs/plugin-host.md §91. */
export function assertEveryModuleHasManifest(modules: readonly string[], label: string): void {
  const missing = modules.filter((module) => !hasPluginManifest(module));
  if (missing.length > 0) {
    throw new Error(
      `${label} allowlists plugin module(s) with no bundled manifest: ${missing.join(", ")}. ` +
        `A binding may name them, and 'validatePluginConfig' would then have no schema to gate ` +
        `their tenant-supplied config on. Export a manifest from the plugin package (with ` +
        `'additionalProperties: false', omitting every server-injected key) and register it in ` +
        `MANIFEST_BY_MODULE.`
    );
  }
}

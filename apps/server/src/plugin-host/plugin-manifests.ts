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
import { manifest as managedOpsManifest } from "@scp/plugin-managed-ops";
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
  "managed-ops": managedOpsManifest,
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

/** Config keys a module DECLARES that only the privileged `execution-system` object may supply
 *  (M28.4 fix round, ADR-0055 D9). `authoring` is the operator's bound on what SCP may author into
 *  that Argo CD — carrier, project, namespaces — so a tenant writing an INLINE binding's config must
 *  never be able to set it: that would let `object:write` choose its own bound. The same rule
 *  ADR-0003 applies to `allowInternalEgress`. */
export const SYSTEM_ONLY_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  argocd: ["authoring"]
};

/** Refuse an inline binding config that sets a system-only key — at every binding write door. */
export function assertNoSystemOnlyConfig(module: string, config: unknown): void {
  const keys = (SYSTEM_ONLY_CONFIG_KEYS[module] ?? []).filter(
    (k) => config !== null && typeof config === "object" && Object.hasOwn(config, k)
  );
  if (keys.length > 0) {
    throw badRequest(
      `an inline '${module}' binding may not set ${keys.join(", ")} — only the execution-system ` +
        `object declares it (ADR-0055). Bind through an execution-system that carries it.`
    );
  }
}

/** Strip system-only keys from an inline binding's stored config — the READ-side twin of
 *  `assertNoSystemOnlyConfig`, for rows written before the write door refused them. */
export function withoutSystemOnlyConfig(
  module: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const keys = SYSTEM_ONLY_CONFIG_KEYS[module] ?? [];
  if (keys.length === 0) return config;
  return Object.fromEntries(Object.entries(config).filter(([k]) => !keys.includes(k)));
}

/** The config keys a module's own manifest DECLARES.
 *
 *  Used to carry module-specific settings from an `execution-system` object into a system-backed
 *  binding's plugin config. Intersecting with this list is what makes that safe: an
 *  execution-system's `properties` are tenant-writable, so copying them wholesale would let a
 *  tenant choose config keys the plugin never advertised. Server-injected keys (`statePath`,
 *  `runnerImage`, …) are deliberately absent from every `configSchema`, so they can never be
 *  reached this way — the same invariant `validatePluginConfig` already rests on.
 *
 *  Returns `[]` for a module with no manifest or no declared properties. */
export function declaredConfigKeys(module: string): string[] {
  const schema = MANIFEST_BY_MODULE[module]?.configSchema as
    { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {});
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

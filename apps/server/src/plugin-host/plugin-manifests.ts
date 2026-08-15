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
import { manifest as terraformManifest } from "@scp/plugin-terraform";
import { manifest as managedIacManifest } from "@scp/plugin-managed-iac";
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

/**
 * The bundled plugin manifest catalog (static — no runtime hot-loading, DESIGN §11) and the
 * config-schema gate every write door must run before a tenant-supplied binding config is stored.
 *
 * Extracted out of `routes/executors.ts` when IaC apply became a SECOND door that stores executor
 * bindings (docs/proposals/post-import-configuration.md §8 C1). The property that made this
 * necessary is the one the original comment named: "a tenant attempt to set those server-governed
 * fields is rejected HERE" — a gate that lives inside one route handler is a gate the next write
 * path silently doesn't have. `managed-iac`'s schema is `additionalProperties: false` with no
 * runnerImage/networkMode/workspaceRoot, so this is what keeps adversarial-review CRITICAL #1
 * closed on both doors rather than on the one that happened to be written first.
 */

/**
 * Narrow a plugin's own manifest to the PUBLIC v1 contract's shape, or fail LOUD at module load.
 *
 * `@scp/plugin-api`'s `PluginKind` and `@scp/schemas`' `PluginKindSchema` are two lists of the same
 * vocabulary, and M21.4 made them diverge on purpose: the plugin contract gained
 * `dependency-index` (a seventh kind) while the v1 RESPONSE enum did not, because a dependency index
 * is not a bindable, form-configurable plugin (see the note on `BUNDLED_PLUGIN_MANIFESTS` below).
 *
 * A silent `filter` here would be the wrong shape for that divergence: the next kind added to the
 * plugin contract AND intended for the API would quietly vanish from this endpoint, and the symptom
 * would be a missing config form nobody could trace. Validating instead means adding such a manifest
 * to the list below fails at BOOT with a message naming the enum that has to widen with it.
 */
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
  terraformManifest,
  managedIacManifest,
  webhookNotifyManifest,
  smtpNotifyManifest
].map(asApiManifest);

/**
 * M21.4's five `dependency-index` manifests (ADR-0032 §7) are DELIBERATELY ABSENT from the list
 * above and present in the module map below. Two reasons, and the second is the load-bearing one:
 *
 *  1. THE LIST ABOVE IS A CONFIG-FORM CATALOG for things a tenant BINDS. A dependency index is not
 *     bindable: there is no `dependency_index_bindings` table and no write door that creates one.
 *     Its instances are constructed by the server from OPERATOR environment
 *     (`dependencies/version-index.ts`'s `resolveIndexInstanceConfig`), so a generated form for it
 *     would offer a tenant a control nothing reads.
 *  2. THAT LIST IS THE BODY OF `GET /api/v1/plugins/manifests`, typed by `@scp/schemas`'
 *     `PluginKindSchema` — a six-value enum in the PUBLIC v1 contract. Adding these here would
 *     require widening that response enum, i.e. an API change, in a milestone that ships no route.
 *     When M21.6 gives dependency indexes a surface, the enum widens with it, deliberately.
 *
 * They ARE in `MANIFEST_BY_MODULE`, which is what `validatePluginConfig` gates on — so the
 * `additionalProperties: false` schemas still refuse a config carrying the OCI index's
 * SERVER-GOVERNED `skopeoBinary`/`allowedRegistryHosts`, exactly as `managed-iac`'s runner settings
 * are refused. Pinned by `plugin-manifests-dependency-index.test.ts` so neither half is "tidied".
 */

/** Every bundled plugin's manifest, keyed by the module name a binding references. */
export const MANIFEST_BY_MODULE: Record<string, { configSchema: unknown }> = {
  github: githubExecutorManifest,
  "github-discovery": githubDiscoveryManifest,
  gitea: giteaManifest,
  "gitea-discovery": giteaDiscoveryManifest,
  gitlab: gitlabManifest,
  "gitlab-discovery": gitlabDiscoveryManifest,
  argocd: argocdManifest,
  "argocd-discovery": argocdDiscoveryManifest,
  terraform: terraformManifest,
  "managed-iac": managedIacManifest,
  "webhook-notify": webhookNotifyManifest,
  "smtp-notify": smtpNotifyManifest,
  "dependency-index-go": goIndexManifest,
  "dependency-index-npm": npmIndexManifest,
  "dependency-index-pypi": pypiIndexManifest,
  "dependency-index-maven": mavenIndexManifest,
  "dependency-index-oci": ociIndexManifest
};

/** Throws `badRequest` if `config` doesn't satisfy `module`'s declared `configSchema`. An unknown
 *  module has no schema to validate against — that's caught separately (the module allowlist in
 *  `executor-bindings-repo.ts`/`notification-bindings-repo.ts`), so here we simply skip. */
export function validatePluginConfig(module: string, config: unknown): void {
  const manifest = MANIFEST_BY_MODULE[module];
  if (!manifest) return;
  validateProperties(manifest.configSchema, config ?? {}, `plugin-config:${module}`);
}

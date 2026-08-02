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

/** Every bundled plugin's `{id, kind, version, configSchema}` — the source a config form is generated FROM. */
export const BUNDLED_PLUGIN_MANIFESTS = [
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
];

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
  "smtp-notify": smtpNotifyManifest
};

/** Throws `badRequest` if `config` doesn't satisfy `module`'s declared `configSchema`. An unknown
 *  module has no schema to validate against — that's caught separately (the module allowlist in
 *  `executor-bindings-repo.ts`/`notification-bindings-repo.ts`), so here we simply skip. */
export function validatePluginConfig(module: string, config: unknown): void {
  const manifest = MANIFEST_BY_MODULE[module];
  if (!manifest) return;
  validateProperties(manifest.configSchema, config ?? {}, `plugin-config:${module}`);
}

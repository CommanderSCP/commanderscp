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
 * `managed-dep` (M21.5) and `managed-scan` are DELIBERATELY absent from the list above and present
 * in the module map below — the same split, for the same reason, as the dependency-index manifests
 * noted further down. That list is a CONFIG-FORM CATALOG for what a tenant binds through
 * `POST /executors`; neither of those classes is dispatched that way in practice. `managed-scan` is
 * constructed directly by `federation/promotion-scan-step.ts`, and `managed-dep`'s instance is
 * assembled by `dependencies/bump-dispatch.ts` from the component's own git-provider binding —
 * its work-list is the subscription resolution, never a wave target, so nothing ever asks "which
 * binding drives this target's pipeline?". Offering a form for a class whose enablement is an
 * operator env var (`SCP_MANAGED_DEP_RUNNER_IMAGE`, unset ⇒ off) would advertise a control that
 * does nothing on most deployments.
 *
 * `managed-iac` IS in the list because a tenant genuinely binds it to a target (DESIGN §12 Mode 2).
 * The distinction is "does a tenant bind this?", not "is it a managed class".
 */

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

/**
 * `fake-executor`, `pipeline-generic` and `managed-scan` are here and NOT in the published list
 * above, for the same reason the dependency indexes are: the list above is the CONFIG-FORM CATALOG
 * (`GET /api/v1/plugins/manifests`), and none of these three is a plugin an operator picks from a
 * form — `fake-executor` is the in-repo test executor, `pipeline-generic` is already published under
 * its `terraform` preset id (byte-identical schema), and `managed-scan` is driven by the commander's
 * promotion scan step rather than bound by hand. Widening the PUBLIC v1 response body is a separate,
 * deliberate change; closing the gate is not.
 *
 * This map, by contrast, is the GATE — the one `validatePluginConfig` reads — and all three were
 * missing from it while sitting on `KNOWN_EXECUTOR_MODULES`. Because `validatePluginConfig` used to
 * return early when it found no manifest, every executor-binding write door
 * (`PUT /executors/{id}/binding`, IaC apply) stored their configs with NO schema validation at all.
 * For `managed-scan` that was arbitrary code execution on the SCP host: the plugin does
 * `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` is not among the keys
 * `resolveExecutorPluginInstance` injects, so nothing else stood in the way. `managed-iac` was safe
 * from the identical config shape ONLY because it was in this map and its schema is
 * `additionalProperties: false` — i.e. by exactly the check that no-oped for its sibling.
 */

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
  terraform: terraformManifest,
  "pipeline-generic": pipelineGenericManifest,
  "managed-iac": managedIacManifest,
  "managed-scan": managedScanManifest,
  /**
   * M21.5 — AND THIS ENTRY IS THE WHOLE POINT OF HAVING AUTHORED A SCHEMA.
   *
   * `managed-dep`'s manifest declares `additionalProperties: false` over the TENANT surface only
   * (`provider`/`appId`/`installationId`/`privateKeySecretKey`/`apiBaseUrl`/`timeoutMs`) and omits
   * every server-governed field. That refusal is worth exactly nothing until the module appears in
   * THIS map, because `validatePluginConfig` looks the module up here and RETURNS SILENTLY when it
   * finds nothing — an unregistered module is an unvalidated one.
   *
   * That is not a hypothetical: shipped `managed-scan` authored the same schema and was never
   * registered, which left `dockerBinary` — the executable `managed-scan` spawns — settable from a
   * tenant binding config. PR #238 closes the class by asserting at BOOT that every module in
   * `executor-bindings-repo.ts`'s allowlist has a manifest here, which is why this entry is a
   * prerequisite for M21.5 starting at all once that lands, not merely good hygiene.
   *
   * The keys this entry refuses, named because they are the ones that matter: `dockerBinary` (what
   * binary is executed), `runnerImage` (what image runs), `workspaceRoot` (what directory is
   * written), and `networkMode` — which is refused here even though nothing reads it any more, so
   * that a binding cannot look as though it configured an egress posture the plugin fixes as a
   * literal.
   */
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

/**
 * Throws `badRequest` if `config` doesn't satisfy `module`'s declared `configSchema`, and ALSO if
 * `module` has no manifest at all.
 *
 * FAILS CLOSED, and the previous early `return` is the reason this comment is long. It read:
 * "an unknown module has no schema to validate against — that's caught separately (the module
 * allowlist)". That sentence is true of an UNKNOWN module and says nothing whatever about the case
 * that actually existed: a module that PASSES the allowlist and has no manifest. `fake-executor`,
 * `pipeline-generic` and `managed-scan` were all in that state on shipped main, so their bindings'
 * configs were stored unread — and `managed-scan`'s config selects the binary it `execFile`s.
 *
 * The allowlists really do run first at every one of this function's four call sites
 * (`routes/executors.ts` binding-create + notification-upsert + discovery-run, and
 * `iac/plans-repo.ts`'s `assertInlineBindingsValid`), so in practice this branch is reached only by
 * a NEW allowlisted module whose author forgot the manifest — which is precisely the mistake being
 * closed, and it must be refused rather than waved through. A never-reached refusal is the correct
 * cost of a gate that cannot be forgotten.
 */
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

/**
 * Fails LOUD at module load if any module on a binding allowlist has no manifest.
 *
 * `validatePluginConfig`'s refusal above is the runtime net; this is the one that means a mistake
 * can never SHIP. The distinction matters because the runtime net only bites on a write door someone
 * exercises, whereas an allowlist entry with no manifest is a defect the moment it is committed —
 * `managed-scan` sat in exactly that state through several milestones with a doc comment in its own
 * package asserting that the gate protected it.
 *
 * A comment is not the guard: the comment above `MANIFEST_BY_MODULE` already reasoned about this
 * exact property for the dependency-index plugins, and `managed-scan` slipped past it anyway.
 * Called at module load by `coordination/executor-bindings-repo.ts` and
 * `notify/notification-bindings-repo.ts`, next to the allowlists themselves, so the two can never
 * drift apart unobserved — a boot that would accept an unvalidated config does not boot.
 */
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

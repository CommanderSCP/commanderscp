import type { ExecutorPlugin, PluginManifest } from "@scp/plugin-api";
import {
  createPipelineGenericExecutorPlugin,
  pipelineGenericConfigSchema,
  type PipelineGenericConfig
} from "@scp/plugin-pipeline-generic";

/**
 * `@scp/plugin-terraform` — Terraform/OpenTofu MODE 1, pipeline-mediated (DESIGN.md §12,
 * BUILD_AND_TEST.md §8 M7 item 3): "the org's pipeline remains the executor... Trigger: kick the
 * org's pipeline (TFC run API, Atlantis, or a GitHub workflow wrapping tofu)." Mode 2
 * (`scp-managed-iac`, SCP performs release management itself) is a SEPARATE package,
 * `@scp/plugin-managed-iac` — the two modes share nothing but the `ExecutorPlugin` interface,
 * exactly as DESIGN §12 frames them as alternatives for orgs with vs. without an existing pipeline.
 *
 * M10.6 (BUILD_AND_TEST.md §8 M10.6): Mode 1 is now a PRESET of the generic pipeline executor,
 * `@scp/plugin-pipeline-generic` — everything that was generic here (URL-templated
 * trigger/status/abort, the idempotency dedup cache, the inbound-only `observe()`) was extracted
 * verbatim into that package (see its module doc for the full behavior). This package supplies
 * only the TFC-flavored defaults `@scp/plugin-pipeline-generic` already ships (`succeededValues`/
 * `failedValues` matching Terraform Cloud's own `Run` status enum — the most structured of Mode
 * 1's three original targets: TFC, Atlantis, a GitHub Actions workflow wrapping tofu) and its own
 * manifest identity (`id: "terraform"`). Behavior is byte-identical to pre-M10.6 — this package's
 * own test suite (`index.test.ts`, unchanged) proves it.
 *
 * `observe()` is intentionally a no-op ([]): Mode 1's actual observe path is INBOUND, not polled —
 * either `scp change report --plan-json` (packages/cli) or a TFC/TFE/Atlantis webhook, both of
 * which land through the SAME `POST /change-sources/terraform/webhook` ingress every other source
 * kind uses (routes/change-sources.ts), never through this plugin's `observe()`. The GATE-VERDICT
 * endpoint the org's apply step consults before applying (DESIGN §12 "the pipeline's apply step
 * asks SCP for a gate verdict... SCP evaluates policies/controls and answers with a Decision") is
 * likewise server-side (`GET /changes/{id}/gate-verdict`, routes/change-sources.ts), reusing M4's
 * existing pure policy-evaluation machinery rather than new engine logic — see that route's doc
 * comment.
 */

/** Back-compat alias — this package's own exported config shape is now
 *  `@scp/plugin-pipeline-generic`'s `PipelineGenericConfig`, unchanged in every field. */
export type TerraformConfig = PipelineGenericConfig;

export const terraformExecutorPlugin: ExecutorPlugin = createPipelineGenericExecutorPlugin();

export function createTerraformExecutorPlugin(): ExecutorPlugin {
  return terraformExecutorPlugin;
}

export const manifest: PluginManifest = {
  id: "terraform",
  kind: "executor",
  version: "0.1.0",
  configSchema: pipelineGenericConfigSchema
};

export default terraformExecutorPlugin;

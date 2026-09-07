import type { ExecutorPlugin, PluginManifest } from "@scp/plugin-api";
import {
  createPipelineGenericExecutorPlugin,
  pipelineGenericConfigSchema,
  type PipelineGenericConfig
} from "@scp/plugin-pipeline-generic";

/** Terraform and OpenTofu, pipeline-mediated. See docs/plugins.md §545. */

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

import os from "node:os";
import path from "node:path";
import type { AppDeps } from "../types.js";
import type { ServerConfig } from "../config.js";
import type { PluginHostInstanceConfig } from "./contract.js";
import { SubprocessPluginHost } from "./host.js";
import {
  DEFAULT_EXECUTOR_INSTANCE_ID,
  DEFAULT_EXECUTOR_MODULE,
  SHARED_PLUGIN_INSTANCE_ORG_ID,
  SHARED_PLUGIN_INSTANCE_SCOPE_KEY
} from "../coordination/executor-config.js";

/** Which role gets a plugin host, and which gets the fake. See docs/plugin-host.md §43. */
export function sharedPluginInstancesForRole(
  role: ServerConfig["role"]
): PluginHostInstanceConfig[] {
  if (role !== "all" && role !== "worker") return [];
  return [
    {
      id: DEFAULT_EXECUTOR_INSTANCE_ID,
      module: DEFAULT_EXECUTOR_MODULE,
      orgId: SHARED_PLUGIN_INSTANCE_ORG_ID,
      scopeKey: SHARED_PLUGIN_INSTANCE_SCOPE_KEY,
      // Durable across the plugin SUBPROCESS restarting (the plugin-host isolation DoD scenario),
      // not across this whole `scpd` process restarting — which is fine, because fake-executor is
      // never a real system of record.
      config: { statePath: path.join(os.tmpdir(), "scpd-fake-executor-state.json") }
    }
  ];
}

/** Constructs the host, publishes it and starts it. See docs/plugin-host.md §44. */
export async function startPluginHostForRole(
  deps: AppDeps,
  role: ServerConfig["role"]
): Promise<SubprocessPluginHost> {
  const host = new SubprocessPluginHost();
  deps.pluginHost = host;
  await host.start(sharedPluginInstancesForRole(role));
  return host;
}

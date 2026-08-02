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

/**
 * WHICH ROLE GETS A PLUGIN HOST, AND WHICH GETS THE SHARED FAKE-EXECUTOR INSTANCE.
 *
 * ============================================================================================
 * THE CONFLATION THIS SEPARATES
 * ============================================================================================
 * `main.ts` used to build the `SubprocessPluginHost` INSIDE its `role === "all" || "worker"` guard,
 * beside pg-boss, the outbox relay and the reconcile/watchdog/observe loops. That guard is about
 * BACKGROUND WORK — who owns the single-writer loops — and hosting a plugin for the duration of one
 * HTTP request is not background work.
 *
 * The consequence was not theoretical. In a split api/worker deployment — which is what the Helm
 * chart ships and how the homelab runs — `deps.pluginHost` was undefined on the api process, the
 * only process that serves HTTP, so `POST /discovery/run` answered 400 for every caller. Discovery
 * was unreachable in the topology the chart defaults to, and the error's own remediation ("run
 * SCP_ROLE=all") was actively wrong: it would have started a SECOND reconcile/watchdog/observe loop
 * set alongside the worker's, which is the one thing the role guard exists to prevent.
 *
 * ============================================================================================
 * THE TWO DECISIONS, NOW SEPARATE
 * ============================================================================================
 *   the HOST      — every role. An idle supervisor with no children costs almost nothing, and it is
 *                   what makes a request-scoped plugin call possible at all.
 *   the INSTANCES — role-gated. The shared fake-executor instance exists for the coordination loops
 *                   (`coordination/executor-config.ts` explains why it is a process-wide singleton),
 *                   so an api-only process starts with NONE. Discovery registers its own instance
 *                   per request, so it never depended on that default and gains nothing from it.
 *
 * Neither egress boundary moves. The chart's executor NetworkPolicies select every pod of the
 * release rather than the worker alone, and the app-level SSRF egress guard is per-plugin-instance,
 * not per-process — so which process dispatches a plugin changes no permission.
 */
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

/**
 * Constructs the host, publishes it on `deps` and starts it with whatever instances this role owns.
 *
 * Assignment happens BEFORE `start()` resolves on purpose: route handlers read `deps.pluginHost` at
 * REQUEST time, and the server does not accept connections until `main` reaches `app.listen`, so
 * there is no window in which a request can observe a half-started host.
 */
export async function startPluginHostForRole(
  deps: AppDeps,
  role: ServerConfig["role"]
): Promise<SubprocessPluginHost> {
  const host = new SubprocessPluginHost();
  deps.pluginHost = host;
  await host.start(sharedPluginInstancesForRole(role));
  return host;
}

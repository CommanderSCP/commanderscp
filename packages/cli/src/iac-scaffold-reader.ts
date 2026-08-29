/**
 * The `scp iac scaffold` half of the estate-reading layer (team-pipeline-iac.md §7/D1, ADR-0047) —
 * turns a `discovery run` proposal into `@scp/iac`'s `ServiceSpec` shape, GROUPED into services by
 * the caller-supplied lookup table. Sibling to `iac-estate-reader.ts` (the `scp iac export` half);
 * split into its own file/commit because scaffold's grouping logic is genuinely independent of
 * export's live-graph reads — both hand their output to the SAME shared emitter
 * (`@scp/iac`'s `estate-program.ts`), landed first.
 */

import type { GraphObject } from "@scp/schemas";

// -------------------------------------------------------------------------------------------
// `scp iac scaffold --from <execution-system-urn>` (§7/D1/ADR-0047)
// -------------------------------------------------------------------------------------------

/** Maps a live `execution-system` object's stored `properties.kind` (set at `scp connect`) to the
 *  discovery plugin module that reads it — the exact mapping the CLI's own `connect` flow already
 *  prints as its "Next:" command (`cli.ts`'s `object("execution-system").create` call site). */
export function discoveryModuleForExecutionSystemKind(kind: string): string {
  return `${kind}-discovery`;
}

/** Builds a `RunDiscoveryRequest` from a live `execution-system` object — the same
 *  `{serverUrl, tokenSecretKey, executionSystemId}` config / `{tokenSecretKey: tokenSecretKey}`
 *  secret-ref shape `scp connect argocd`'s own printed "Next:" command uses. */
export function discoveryRequestForExecutionSystem(executionSystem: GraphObject): {
  pluginModule: string;
  pluginInstanceId: string;
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
} {
  const props = executionSystem.properties as {
    kind?: unknown;
    serverUrl?: unknown;
    tokenSecretKey?: unknown;
  };
  if (typeof props.kind !== "string") {
    throw new Error(
      `execution-system ${executionSystem.urn} has no properties.kind — cannot derive a discovery plugin module`
    );
  }
  const config: Record<string, unknown> = { executionSystemId: executionSystem.id };
  if (typeof props.serverUrl === "string") config["serverUrl"] = props.serverUrl;
  const secretRefs: Record<string, string> = {};
  if (typeof props.tokenSecretKey === "string") {
    config["tokenSecretKey"] = props.tokenSecretKey;
    secretRefs[props.tokenSecretKey] = props.tokenSecretKey;
  }
  return {
    pluginModule: discoveryModuleForExecutionSystemKind(props.kind),
    pluginInstanceId: executionSystem.name,
    config,
    secretRefs
  };
}

export {
  groupDiscoveryProposal,
  type ScaffoldGroupingResult,
  type UngroupedComponent
} from "@scp/iac";

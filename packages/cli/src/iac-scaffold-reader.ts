import type { DiscoveryProposal, GraphObject } from "@scp/schemas";
import { slugify, type ComponentSpec, type PipelineSpec, type ServiceSpec } from "@scp/iac";

/**
 * The `scp iac scaffold` half of the estate-reading layer (team-pipeline-iac.md §7/D1, ADR-0047) —
 * turns a `discovery run` proposal into `@scp/iac`'s `ServiceSpec` shape, GROUPED into services by
 * the caller-supplied lookup table. Sibling to `iac-estate-reader.ts` (the `scp iac export` half);
 * split into its own file/commit because scaffold's grouping logic is genuinely independent of
 * export's live-graph reads — both hand their output to the SAME shared emitter
 * (`@scp/iac`'s `estate-program.ts`), landed first.
 */

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

export interface UngroupedComponent {
  readonly name: string;
  readonly typeId: string;
}

export interface ScaffoldGroupingResult {
  /** One `ServiceSpec` per target service named in `group` — ordered by service name. */
  readonly specs: ServiceSpec[];
  /** ADR-0047's whole point, surfaced rather than defaulted: every proposed component `group` did
   *  not map to a service. NEVER included in `specs` — a `Component` cannot be constructed without
   *  one (round A: `service` is required), so an ungrouped component has no valid code to emit. */
  readonly ungrouped: UngroupedComponent[];
}

/**
 * Groups a `discovery run` proposal's components into services (ADR-0047: "the orphan problem is
 * solved at authoring time, where a human is present") — PURE, no SDK calls; `group` is the CLI's
 * `--group <name>=<service>` flags collapsed to a lookup table. Every discovered `component` object
 * either lands in exactly one returned `ServiceSpec`, or is reported in `ungrouped` — never both,
 * and never silently dropped.
 */
export function groupDiscoveryProposal(
  proposal: DiscoveryProposal,
  group: Record<string, string>
): ScaffoldGroupingResult {
  const byService = new Map<string, ComponentSpec[]>();
  const ungrouped: UngroupedComponent[] = [];

  for (const obj of proposal.objects) {
    if (obj.typeId !== "component") continue;
    const serviceName = group[obj.name];
    if (!serviceName) {
      ungrouped.push({ name: obj.name, typeId: obj.typeId });
      continue;
    }
    const mapping = (proposal.sourceMappings ?? []).find((m) => m.objectName === obj.name);
    const pipeline: PipelineSpec = {
      kind: mapping?.type ?? "configuration",
      // §8: emitted EMPTY on purpose — nothing about real stages was discovered; the guidance for
      // growing this into `staging`/`production` waves travels as a comment (`WAVE_TOPOLOGY_GUIDANCE`).
      waves: [],
      ...(mapping?.repoPattern
        ? {
            source: {
              sourceKind: mapping.sourceKind,
              repoPattern: mapping.repoPattern,
              ...(mapping.pathPattern ? { pathPattern: mapping.pathPattern } : {})
            }
          }
        : {})
    };
    const list = byService.get(serviceName) ?? [];
    list.push({
      constructId: slugify(obj.name),
      name: obj.name,
      // No `urn`: none of this exists in the graph yet (ADR-0047 — that is the entire point of
      // landing through a reviewed manifest instead of `discovery/accept`).
      placements: [],
      pipelines: [pipeline]
    });
    byService.set(serviceName, list);
  }

  const specs: ServiceSpec[] = [...byService.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serviceName, components]) => ({
      stackName: slugify(serviceName),
      serviceName,
      components
    }));

  return { specs, ungrouped };
}

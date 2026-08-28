/**
 * SCAFFOLD GROUPING — the pure decision behind `scp iac scaffold` and the `/connect` wizards
 * (ADR-0047; team-pipeline-iac section 7).
 *
 * MOVED HERE FROM `@scp/cli` when the wizards became scaffolder UI. It was always pure — no SDK
 * calls, no I/O — and it has two consumers now: the CLI, which writes the emitted code to disk, and
 * the web wizard, which shows it for a human to commit. A second copy in the browser would be a
 * second definition of "which components are ungrouped", and the whole point of ADR-0047 is that
 * the ungrouped set is surfaced rather than defaulted. One definition, two callers.
 */

import type { DiscoveryProposal } from "@scp/schemas";
import { slugify } from "./urn.js";
import type { ComponentSpec, PipelineSpec, ServiceSpec } from "./estate-program.js";

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

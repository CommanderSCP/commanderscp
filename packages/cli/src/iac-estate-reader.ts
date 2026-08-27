import type { ScpClient } from "@scp/sdk";
import type {
  ExecutorType,
  GraphObject,
  InfraKind,
  Relationship,
  SourceMapping
} from "@scp/schemas";
import {
  slugify,
  type ComponentSpec,
  type PipelineSourceSpec,
  type PipelineSpec,
  type PlacementSpec,
  type PublishSpec,
  type ServiceSpec
} from "@scp/iac";

/**
 * Turns LIVE SDK reads into the `ServiceSpec` shape `@scp/iac`'s shared emitter
 * (`estate-program.ts`) consumes — the CLI-side half of `scp iac export` (team-pipeline-iac.md
 * §9/D5). `scp iac scaffold`'s own reading logic (a `discovery run` proposal, not a live graph walk)
 * lives beside it in `iac-scaffold-reader.ts`; both hand their output to the SAME shared emitter.
 * Everything here talks to `@scp/sdk`; `@scp/iac` stays free of that dependency (its own module doc
 * explains why), so the SDK-shaped reading logic belongs on this side of the boundary.
 */

async function collectAll<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string | null }>
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

function isBuildKind(kind: ExecutorType): boolean {
  return kind !== "infrastructure" && kind !== "configuration";
}

function deploymentTargetId(placement: GraphObject): string {
  const props = placement.properties as { deploymentTargetId?: unknown };
  const id = props.deploymentTargetId;
  if (typeof id !== "string") {
    throw new Error(`placement ${placement.id} has no deploymentTargetId — cannot export it`);
  }
  return id;
}

// -------------------------------------------------------------------------------------------
// `scp iac export --scope <service-urn>` (§9/D5)
// -------------------------------------------------------------------------------------------

export interface ExportEstateOptions {
  /** `source_mappings` are listed per source kind (`GET /change-sources/{sourceKind}/mappings`,
   *  D9's registration-by-pattern only narrows how a config source APPLIES, not how this read
   *  works) — export has no way to know which kinds an org uses, so it probes each of these and
   *  keeps whatever matches one of the scope's components.
   *  @default ["gitea"] — the platform's own self-hosted default (ADR-0012). */
  readonly sourceKinds?: string[];
}

export async function readServiceExportSpec(
  client: ScpClient,
  scopeIdOrUrn: string,
  opts: ExportEstateOptions = {}
): Promise<ServiceSpec> {
  const sourceKinds = opts.sourceKinds ?? ["gitea"];
  const service = await client.services.get(scopeIdOrUrn);

  const containsRels = await collectAll<Relationship>((cursor) =>
    client.relationships.list({ fromId: service.id, typeId: "contains", cursor })
  );
  const componentIds = containsRels.map((r) => r.toId);
  const componentIdSet = new Set(componentIds);

  const mappingsByComponent = new Map<string, SourceMapping[]>();
  for (const sourceKind of sourceKinds) {
    let mappings: SourceMapping[];
    try {
      mappings = (await client.changeSources.listMappings(sourceKind)).items;
    } catch {
      // An org that never registered this source kind — not a failure, just nothing to add.
      continue;
    }
    for (const m of mappings) {
      if (!componentIdSet.has(m.componentObjectId)) continue;
      const list = mappingsByComponent.get(m.componentObjectId) ?? [];
      list.push(m);
      mappingsByComponent.set(m.componentObjectId, list);
    }
  }

  const components: ComponentSpec[] = [];
  for (const componentId of componentIds) {
    const componentObj = await client.components.get(componentId);
    components.push(
      await readComponentSpec(client, componentObj, mappingsByComponent.get(componentId) ?? [])
    );
  }

  return {
    stackName: slugify(service.name),
    serviceName: service.name,
    serviceUrn: service.urn,
    components
  };
}

async function readComponentSpec(
  client: ScpClient,
  componentObj: GraphObject,
  mappings: SourceMapping[]
): Promise<ComponentSpec> {
  const placementObjects = await collectAll<GraphObject>((cursor) =>
    client.placements.list({ component: componentObj.id, cursor })
  );

  const targetIds = [...new Set(placementObjects.map(deploymentTargetId))];
  const targetById = new Map<string, GraphObject>();
  for (const id of targetIds) {
    targetById.set(id, await client.deploymentTargets.get(id));
  }

  const placements: PlacementSpec[] = placementObjects.map((p) => {
    const target = targetById.get(deploymentTargetId(p));
    if (!target) throw new Error(`deployment-target for placement ${p.id} did not resolve`);
    const kind = (target.properties as { kind?: unknown }).kind;
    return {
      targetUrn: target.urn,
      ...(typeof kind === "string" ? { infraKind: kind as InfraKind } : {})
    };
  });

  const releasesVia = await collectAll<Relationship>((cursor) =>
    client.relationships.list({ fromId: componentObj.id, typeId: "releases_via", cursor })
  );
  const publishesToRels = await collectAll<Relationship>((cursor) =>
    client.relationships.list({ fromId: componentObj.id, typeId: "publishes_to", cursor })
  );

  const pipelines: PipelineSpec[] = [];
  for (const rel of releasesVia) {
    const kind =
      ((rel.properties as { type?: unknown }).type as ExecutorType | undefined) ?? "configuration";
    const topologyObj = await client.object("release-topology").get(rel.toId);
    const rawWaves = ((topologyObj.properties as { waves?: unknown }).waves ?? []) as Array<{
      name?: string;
      mode?: "parallel" | "sequential";
      targets: string[];
      requiresFanIn?: boolean;
    }>;

    const mapping = mappings.find((m) => (m.type ?? "configuration") === kind);
    const source: PipelineSourceSpec | undefined =
      mapping?.repoPattern != null
        ? {
            sourceKind: mapping.sourceKind,
            repoPattern: mapping.repoPattern,
            ...(mapping.pathPattern != null ? { pathPattern: mapping.pathPattern } : {}),
            ...(mapping.refPattern != null
              ? { branch: mapping.refPattern.replace(/^refs\/heads\//, "") }
              : {})
          }
        : undefined;

    let publishesTo: PublishSpec | undefined;
    if (isBuildKind(kind)) {
      const publishRel = publishesToRels[0];
      if (publishRel) {
        const dest = await client.object("execution-system").get(publishRel.toId);
        const repository = (publishRel.properties as { repository?: unknown }).repository;
        publishesTo = {
          destinationUrn: dest.urn,
          ...(typeof repository === "string" ? { repository } : {})
        };
      }
    }

    pipelines.push({
      kind,
      waves: rawWaves.map((w) => ({
        ...(w.name !== undefined ? { name: w.name } : {}),
        mode: w.mode ?? "parallel",
        targets: w.targets,
        ...(w.requiresFanIn !== undefined ? { requiresFanIn: w.requiresFanIn } : {})
      })),
      ...(source ? { source } : {}),
      ...(publishesTo ? { publishesTo } : {})
    });
  }

  return {
    constructId: slugify(componentObj.name),
    name: componentObj.name,
    urn: componentObj.urn,
    placements,
    pipelines
  };
}

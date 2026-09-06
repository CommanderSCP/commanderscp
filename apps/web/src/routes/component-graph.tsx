import { useQuery } from "@tanstack/react-query";
import type { GraphObject } from "@scp/schemas";
import { client } from "../lib/client";
import { useServiceIdParam } from "../lib/use-route-params";
import {
  GraphCanvas,
  type GraphCanvasData,
  type GraphCanvasEdge,
  type GraphCanvasNode
} from "../components/graph/GraphCanvas";
import { GraphLegend } from "../components/graph/GraphLegend";
import { QueryErrorNotice } from "../components/query-error";
import { PageHeader } from "../components/ui/page-header";

const LINK_TYPES = ["consumes", "depends_on"];

interface ComponentGraphResult {
  serviceName: string;
  componentCount: number;
  data: GraphCanvasData;
}

/**
 * `/graph/service/$serviceId` — the COMPONENT layer of the two-layer graph explorer
 * (coordination-ui-views.md § two-layer graph, Phase 3). Reached by clicking a service in the
 * service-layer graph (`/graph`).
 *
 * Shows this service's components + their internal `consumes`/`depends_on` links, PLUS cross-service
 * links (dashed) to *other* services' components. Every node/edge is derived from REAL graph data —
 * nothing is synthesized:
 *   1. `traverse(service, out, contains)` → this service's components.
 *   2. per component `traverse(both, {consumes,depends_on})` → the component-level edges + the typed
 *      neighbor objects (so external components can be named).
 *   3. for each edge endpoint NOT owned by this service, resolve its OWNING service from the real
 *      `contains` parent (`relationships.list({toId, typeId:'contains'})`) — this confirms the edge
 *      genuinely crosses services (never guessed) and supplies the external node's owning-service
 *      label.
 *
 * NOTE (Layer B, deferred): the proposal's optional per-node HEALTH dot (up/degraded/down/no-metric)
 * needs an owner-supplied up/down observe signal that the API does not yet capture — so it is
 * intentionally omitted here rather than fabricated (coordination-ui-views.md Phase 4d).
 */
export function ComponentGraphPage(): React.JSX.Element {
  const serviceId = useServiceIdParam();

  const graphQuery = useQuery<ComponentGraphResult>({
    queryKey: ["component-graph", serviceId],
    enabled: !!serviceId,
    queryFn: async () => {
      if (!serviceId) throw new Error("missing service id");

      const service = await client.services.get(serviceId);

      // 1. This service's components (real `contains` children).
      //
      // maxDepth 2, NOT 1: containment is `service -> [assembly] -> component`, and the assembly
      // rung is optional. At depth 1 a service whose components all sit under an assembly returned
      // only the assembly, which the `typeId === "component"` filter then dropped — so that service
      // rendered a completely empty component graph while genuinely having components one hop
      // further down. Depth 2 covers both shapes; the ladder is capped at three rungs server-side
      // (`assembly -> assembly` is refused outright), so there is no deeper case to miss.
      const contained = await client.graph.traverse({
        objectId: serviceId,
        direction: "out",
        relTypes: ["contains"],
        maxDepth: 2
      });
      const components = contained.objects.filter(
        (o) => o.typeId === "component" && o.id !== serviceId
      );
      const assemblies = contained.objects.filter((o) => o.typeId === "assembly");
      const componentIds = new Set(components.map((c) => c.id));
      // The containment edges themselves are what the canvas reads to decide colour groups — a
      // component under an assembly takes the assembly's colour, a component held directly by the
      // service gets its own (lib/graph-visual.ts `deriveGroupIds`).
      const containsEdges = contained.edges.filter((e) => e.typeId === "contains");

      if (components.length === 0) {
        return { serviceName: service.name, componentCount: 0, data: { objects: [], edges: [] } };
      }

      // 2. Every consumes/depends_on edge incident to those components, plus the typed neighbor
      // objects (names for external nodes). One traverse per component — bounded fan-out.
      const edgeById = new Map<
        string,
        { id: string; fromId: string; toId: string; typeId: string }
      >();
      const objById = new Map<string, GraphObject>();
      for (const c of components) objById.set(c.id, c);

      const perComponent = await Promise.all(
        components.map((c) =>
          client.graph.traverse({
            objectId: c.id,
            direction: "both",
            relTypes: LINK_TYPES,
            maxDepth: 1
          })
        )
      );
      for (const res of perComponent) {
        for (const o of res.objects) objById.set(o.id, o);
        for (const e of res.edges) edgeById.set(e.id, e);
      }

      // Keep only component↔component edges that touch THIS service (drop unrelated
      // external↔external links picked up as second-hop neighbors).
      const edges = [...edgeById.values()].filter((e) => {
        const from = objById.get(e.fromId);
        const to = objById.get(e.toId);
        if (from?.typeId !== "component" || to?.typeId !== "component") return false;
        return componentIds.has(e.fromId) || componentIds.has(e.toId);
      });

      // 3. External component endpoints (owned by a different service) → resolve owning service.
      const externalIds = new Set<string>();
      for (const e of edges) {
        if (!componentIds.has(e.fromId)) externalIds.add(e.fromId);
        if (!componentIds.has(e.toId)) externalIds.add(e.toId);
      }

      const ownerByComponent = new Map<string, string>();
      await Promise.all(
        [...externalIds].map(async (extId) => {
          const rels = await client.relationships.list({
            toId: extId,
            typeId: "contains",
            limit: 1
          });
          const owner = rels.items[0]?.fromId;
          if (owner) ownerByComponent.set(extId, owner);
        })
      );

      const ownerNames = new Map<string, string>();
      await Promise.all(
        [...new Set(ownerByComponent.values())].map(async (sid) => {
          try {
            const svc = await client.services.get(sid);
            ownerNames.set(sid, svc.name);
          } catch {
            // Owning service not readable (e.g. cross-domain) — fall back to the bare name.
          }
        })
      );

      const objects: GraphCanvasNode[] = [
        // The service itself. It is the SCOPE ROOT, and a root that is only in the node set via
        // `rootId` has no name and no type — it rendered as an unnamed default circle labelled with
        // a truncated uuid. Including it as a real node gives it its shape, its name, and the
        // containment edges that make the colour grouping resolve to its direct children.
        { id: service.id, name: service.name, typeId: service.typeId },
        ...assemblies.map((a) => ({ id: a.id, name: a.name, typeId: a.typeId })),
        ...components.map((c) => ({ id: c.id, name: c.name, typeId: c.typeId })),
        ...[...externalIds].map((id): GraphCanvasNode => {
          const name = objById.get(id)?.name ?? id.slice(0, 8);
          const ownerName = ownerNames.get(ownerByComponent.get(id) ?? "");
          return {
            id,
            name: ownerName ? `${name} · ${ownerName}` : name,
            typeId: "component",
            external: true
          };
        })
      ];

      const canvasEdges: GraphCanvasEdge[] = [
        ...containsEdges.map((e) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          typeId: e.typeId
        })),
        ...edges.map((e) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          typeId: e.typeId,
          crossService: !componentIds.has(e.fromId) || !componentIds.has(e.toId)
        }))
      ];

      return {
        serviceName: service.name,
        componentCount: components.length,
        data: { objects, edges: canvasEdges }
      };
    }
  });

  const serviceName = graphQuery.data?.serviceName;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`Components${serviceName ? ` · ${serviceName}` : ""}`}
        description="This service's components and their links, plus cross-service links (dashed) to other services' components."
        backTo="/graph"
        backLabel="Service graph"
        actions={
          <GraphLegend
            shapes={[
              { label: "Service", typeId: "service" },
              { label: "Assembly", typeId: "assembly" },
              { label: "Component", typeId: "component" }
            ]}
            nodes={[{ label: "Other service (external)", color: "#94a3b8", dashed: true }]}
            edges={[{ label: "internal link" }, { label: "cross-service", dashed: true }]}
            note="Colour groups components by the assembly (or service) that holds them."
          />
        }
      />

      <div className="relative h-[32rem] rounded-lg border border-slate-200 bg-white">
        {graphQuery.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            Loading component graph…
          </div>
        )}
        {graphQuery.isError && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <QueryErrorNotice error={graphQuery.error} what="the component graph" />
          </div>
        )}
        {graphQuery.data && graphQuery.data.componentCount === 0 && (
          <div
            className="absolute inset-0 flex items-center justify-center text-sm text-slate-500"
            data-testid="component-graph-empty"
          >
            This service has no components yet.
          </div>
        )}
        <GraphCanvas
          data={graphQuery.data?.data ?? { objects: [], edges: [] }}
          rootId={serviceId}
          layout="cose"
        />
      </div>
    </div>
  );
}

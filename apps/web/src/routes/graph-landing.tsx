import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { client } from "../lib/client";
import { REGISTRIES, getRegistryClient, type RegistryConfig } from "../lib/registries";
import { registryListKey } from "../lib/query-client";
import { GraphCanvas, type GraphCanvasData } from "../components/graph/GraphCanvas";
import { GraphLegend } from "../components/graph/GraphLegend";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";
import { Input } from "../components/ui/input";

/**
 * `/graph` landing — the discoverable entry point for the graph explorer (previously reachable
 * only by already knowing an object id). Provides two ways in:
 *
 *  1. An object picker (registry + type-ahead over that registry's objects) that navigates to the
 *     object-scoped explorer at `/graph/{id}`.
 *  2. A default at-a-glance SERVICE-level org map — every service plus the real `depends_on`/
 *     `consumes`/… edges among them — so the page is never empty. Nodes are clickable (they route
 *     to the object's registry-detail page, same as inside the explorer).
 */
export function GraphLandingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [registryPath, setRegistryPath] = useState<string>("services");
  const [filter, setFilter] = useState("");

  const registry = REGISTRIES.find((r) => r.basePath === registryPath) as RegistryConfig;

  const pickerQuery = useQuery({
    queryKey: registryListKey(registryPath),
    queryFn: () => getRegistryClient(client, registry).list({ limit: 100 })
  });

  const filteredItems = useMemo(() => {
    const items = pickerQuery.data?.items ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(needle) || i.urn.toLowerCase().includes(needle)
    );
  }, [pickerQuery.data, filter]);

  // Default overview: the service-level org map. Fetch services, then the REAL induced-subgraph
  // edges among them via `graph.subgraph` (authz-scoped to any one service — a caller who can list
  // services can read the graph around them). Rendered with no `rootId` — it's an org map, not a
  // single-object walk.
  const overviewQuery = useQuery<GraphCanvasData>({
    queryKey: ["graph-overview", "services"],
    queryFn: async () => {
      const services = await client.services.list({ limit: 100 });
      const objects = services.items.map((s) => ({ id: s.id, name: s.name, typeId: s.typeId }));
      const ids = objects.map((o) => o.id);
      const scope = ids[0];
      if (ids.length < 2 || !scope) return { objects, edges: [] };
      const sub = await client.graph.subgraph({ objectId: scope, ids });
      return {
        objects,
        edges: sub.edges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId }))
      };
    }
  });

  function openObject(id: string): void {
    void navigate({ to: "/graph/$idOrUrn", params: { idOrUrn: id } });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Graph</h1>
        <p className="text-sm text-slate-500">
          Explore ownership, dependencies and blast radius across the graph.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-slate-700">Explore an object</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex w-56 flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Registry</label>
            <Select
              value={registryPath}
              onValueChange={(v) => {
                setRegistryPath(v);
                setFilter("");
              }}
            >
              <SelectTrigger data-testid="graph-picker-registry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REGISTRIES.map((r) => (
                  <SelectItem key={r.basePath} value={r.basePath}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="graph-picker-filter" className="text-xs font-medium text-slate-600">
              Find
            </label>
            <Input
              id="graph-picker-filter"
              value={filter}
              placeholder={`Search ${registry.label.toLowerCase()}…`}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="graph-picker-filter"
            />
          </div>
        </div>

        {pickerQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {pickerQuery.isError && (
          <p className="text-sm text-red-600">
            {pickerQuery.error instanceof Error ? pickerQuery.error.message : "Failed to load"}
          </p>
        )}
        {pickerQuery.data && filteredItems.length === 0 && (
          <p className="text-sm text-slate-500">No matching {registry.label.toLowerCase()}.</p>
        )}
        {filteredItems.length > 0 && (
          <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-100">
            {filteredItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openObject(item.id)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                  data-testid="graph-picker-item"
                >
                  <span className="font-medium text-slate-900">{item.name}</span>
                  <span className="font-mono text-xs text-slate-400">{item.urn}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Service graph</h2>
            <p className="text-xs text-slate-500">
              Services and their <code className="text-slate-600">depends_on</code>/
              <code className="text-slate-600">consumes</code> edges. Click a service to open its
              component graph.
            </p>
          </div>
          <GraphLegend nodes={[{ label: "Service", color: "#2563eb" }]} />
        </div>
        <div className="relative h-[28rem] rounded-lg border border-slate-200 bg-white">
          {overviewQuery.isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              Loading service graph…
            </div>
          )}
          {overviewQuery.isError && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-red-600">
              {overviewQuery.error instanceof Error
                ? overviewQuery.error.message
                : "Failed to load service graph"}
            </div>
          )}
          {overviewQuery.data && overviewQuery.data.objects.length === 0 && (
            <div
              className="absolute inset-0 flex items-center justify-center text-sm text-slate-500"
              data-testid="graph-overview-empty"
            >
              No services yet — create one to see the graph.
            </div>
          )}
          <GraphCanvas
            data={overviewQuery.data ?? { objects: [], edges: [] }}
            layout="concentric"
            onNodeTap={(node) =>
              void navigate({ to: "/graph/service/$serviceId", params: { serviceId: node.id } })
            }
          />
        </div>
      </div>
    </div>
  );
}

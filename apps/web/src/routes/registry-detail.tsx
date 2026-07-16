import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/client";
import { findRegistry, getEdgeClient, getOwnerClient, getRegistryClient } from "../lib/registries";
import { registryDetailKey, registryListKey } from "../lib/query-client";
import { useBasePathParam, useIdOrUrnParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";

/**
 * `/{basePath}/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2) — object properties/labels, owners
 * (if ownable), consumes/depends-on edges (services/components), and a link into the graph
 * explorer rooted at this object. No Decision/"Why?" UI — explicitly deferred to M4.
 */
export function RegistryDetailPage(): React.JSX.Element {
  const basePath = useBasePathParam();
  const idOrUrn = useIdOrUrnParam();
  const registry = findRegistry(basePath);
  const detailKey = registryDetailKey(basePath ?? "", idOrUrn ?? "");

  const objectQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => getRegistryClient(client, registry!).get(idOrUrn!),
    enabled: !!registry && !!idOrUrn
  });

  const ownersQuery = useQuery({
    queryKey: [...detailKey, "owners"],
    queryFn: () => getOwnerClient(client, registry!).listOwners(idOrUrn!),
    enabled: !!registry?.ownable && !!idOrUrn
  });

  const consumesQuery = useQuery({
    queryKey: [...detailKey, "consumes"],
    queryFn: () => getEdgeClient(client, registry!).listConsumes(idOrUrn!),
    enabled: !!registry?.edges && !!idOrUrn
  });

  const dependsOnQuery = useQuery({
    queryKey: [...detailKey, "depends-on"],
    queryFn: () => getEdgeClient(client, registry!).listDependsOn(idOrUrn!),
    enabled: !!registry?.edges && !!idOrUrn
  });

  if (!registry || !idOrUrn) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (objectQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (objectQuery.isError || !objectQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {objectQuery.error instanceof Error ? objectQuery.error.message : "Not found"}
      </p>
    );
  }

  const object = objectQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900" data-testid="object-name">
            {object.name}
          </h1>
          <p className="font-mono text-xs text-slate-500">{object.urn}</p>
        </div>
        <Link to="/graph/$idOrUrn" params={{ idOrUrn: object.id }}>
          <Button variant="outline">Open in graph explorer</Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Properties</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(object.properties).length === 0 ? (
            <p className="text-sm text-slate-500">No properties set.</p>
          ) : (
            <pre className="overflow-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(object.properties, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Labels</CardTitle>
        </CardHeader>
        <CardContent>
          {Object.keys(object.labels).length === 0 ? (
            <p className="text-sm text-slate-500">No labels set.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(object.labels).map(([key, value]) => (
                <Badge key={key} variant="secondary">
                  {key}={String(value)}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {registry.serviceMember && <ComponentServiceCard componentId={object.id} detailKey={detailKey} />}

      {registry.ownable && (
        <Card>
          <CardHeader>
            <CardTitle>Owners</CardTitle>
          </CardHeader>
          <CardContent>
            {(ownersQuery.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-500">No owners.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {ownersQuery.data?.items.map((rel) => (
                  <li key={rel.id} className="font-mono text-xs text-slate-600">
                    {rel.fromId}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {registry.edges && (
        <div className="grid gap-6 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Consumes</CardTitle>
            </CardHeader>
            <CardContent>
              {(consumesQuery.data?.items.length ?? 0) === 0 ? (
                <p className="text-sm text-slate-500">Nothing.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {consumesQuery.data?.items.map((rel) => (
                    <li key={rel.id} className="font-mono text-xs text-slate-600">
                      {rel.toId}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Depends on</CardTitle>
            </CardHeader>
            <CardContent>
              {(dependsOnQuery.data?.items.length ?? 0) === 0 ? (
                <p className="text-sm text-slate-500">Nothing.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {dependsOnQuery.data?.items.map((rel) => (
                    <li key={rel.id} className="font-mono text-xs text-slate-600">
                      {rel.toId}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-xs text-slate-400">
        &quot;Why?&quot; / Decision links aren&apos;t available yet — the Decision Engine lands in a
        later milestone (M4).
      </p>
    </div>
  );
}

/**
 * The component's owning service (M12 P5b) — shows the current `contains` parent (or "unassigned"
 * for an imported orphan) and a selector to assign or atomically move it. `setService` is
 * idempotent, so re-selecting the same service is a no-op.
 */
function ComponentServiceCard({
  componentId,
  detailKey
}: {
  componentId: string;
  detailKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");

  const containsQuery = useQuery({
    queryKey: [...detailKey, "service"],
    queryFn: () => client.relationships.list({ typeId: "contains", toId: componentId, limit: 1 })
  });
  const servicesQuery = useQuery({
    queryKey: registryListKey("services"),
    queryFn: () => client.services.list({ limit: 100 })
  });

  const currentServiceId = containsQuery.data?.items[0]?.fromId;
  const currentService = servicesQuery.data?.items.find((s) => s.id === currentServiceId);

  const setServiceMutation = useMutation({
    mutationFn: (serviceId: string) => client.components.setService(componentId, serviceId),
    onSuccess: async () => {
      setSelected("");
      await queryClient.invalidateQueries({ queryKey: [...detailKey, "service"] });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-sm">
          {containsQuery.isLoading ? (
            <span className="text-slate-500">Loading…</span>
          ) : currentServiceId ? (
            <Link
              to="/$basePath/$idOrUrn"
              params={{ basePath: "services", idOrUrn: currentServiceId }}
              className="font-medium text-slate-900 hover:underline"
              data-testid="component-service"
            >
              {currentService?.name ?? currentServiceId}
            </Link>
          ) : (
            <span className="text-amber-700" data-testid="component-unassigned">
              Unassigned — not part of any service.
            </span>
          )}
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="assign-service" className="text-xs font-medium text-slate-600">
              {currentServiceId ? "Move to service" : "Assign to service"}
            </label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger id="assign-service" data-testid="assign-service-select">
                <SelectValue placeholder="Select a service…" />
              </SelectTrigger>
              <SelectContent>
                {(servicesQuery.data?.items ?? [])
                  .filter((s) => s.id !== currentServiceId)
                  .map((svc) => (
                    <SelectItem key={svc.id} value={svc.id}>
                      {svc.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={!selected || setServiceMutation.isPending}
            onClick={() => selected && setServiceMutation.mutate(selected)}
            data-testid="assign-service-submit"
          >
            {setServiceMutation.isPending ? "Saving…" : currentServiceId ? "Move" : "Assign"}
          </Button>
        </div>
        {setServiceMutation.isError && (
          <p className="text-sm text-red-600">
            {setServiceMutation.error instanceof Error ? setServiceMutation.error.message : "Failed"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

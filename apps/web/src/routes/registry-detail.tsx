import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { client } from "../lib/client";
import { findRegistry, getEdgeClient, getOwnerClient, getRegistryClient } from "../lib/registries";
import { registryDetailKey } from "../lib/query-client";
import { useBasePathParam, useIdOrUrnParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

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
        &quot;Why?&quot; / Decision links aren&apos;t available yet — the Decision Engine lands in
        a later milestone (M4).
      </p>
    </div>
  );
}

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExecutorTypeSchema, type ExecutorType } from "@scp/schemas";
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

      {(object.typeId === "component" || object.typeId === "deployment-target") && (
        <TargetBindingsCard targetId={object.id} detailKey={detailKey} />
      )}

      {object.typeId === "component" && (
        <MergeComponentCard survivorId={object.id} detailKey={detailKey} />
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

/**
 * A target's executor bindings (M12 P5c) — one per pipeline (infra/software). Lists each binding
 * with its module/instance and lets an operator DETACH it or RELABEL which pipeline it drives. This
 * is the UI half of the P5c binding primitives; creating a binding still lives on the Plugins page.
 */
function TargetBindingsCard({
  targetId,
  detailKey
}: {
  targetId: string;
  detailKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const bindingsKey = [...detailKey, "executor-bindings"];
  const bindingsQuery = useQuery({
    queryKey: bindingsKey,
    queryFn: () => client.executors.listBindings(targetId)
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: bindingsKey });

  const deleteMutation = useMutation({
    mutationFn: (type: ExecutorType) => client.executors.deleteBinding(targetId, type),
    onSuccess: invalidate
  });
  const repurposeMutation = useMutation({
    // Relabel a binding to a different routing Type (ADR-0007). The `from` Type names the current
    // binding; the caller picks the new Type from the closed enum.
    mutationFn: ({ from, to }: { from: ExecutorType; to: ExecutorType }) =>
      client.executors.repurposeBinding(targetId, to, from),
    onSuccess: invalidate
  });
  const pending = deleteMutation.isPending || repurposeMutation.isPending;
  const error = deleteMutation.error ?? repurposeMutation.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Executor bindings</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(bindingsQuery.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500" data-testid="no-bindings">
            No executor bindings. Configure one from the Plugins page.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="bindings-list">
            {bindingsQuery.data?.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 rounded border border-slate-200 p-2"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-slate-900">
                    <Badge variant="secondary">{b.type}</Badge>{" "}
                    <Badge variant="outline">{b.category}</Badge> {b.pluginModule}
                  </span>
                  <span className="font-mono text-xs text-slate-500">{b.pluginInstanceId}</span>
                </div>
                <div className="flex gap-2">
                  {/* Relabel this binding to any other routing Type (ADR-0007). */}
                  <Select
                    value={b.type}
                    disabled={pending}
                    onValueChange={(to) =>
                      repurposeMutation.mutate({ from: b.type, to: to as ExecutorType })
                    }
                  >
                    <SelectTrigger className="w-40" data-testid={`repurpose-${b.type}`}>
                      <SelectValue placeholder="Change type" />
                    </SelectTrigger>
                    <SelectContent>
                      {ExecutorTypeSchema.options.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => deleteMutation.mutate(b.type)}
                    data-testid={`unbind-${b.type}`}
                  >
                    Detach
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Merge another component into this one (M12 P5d) — the driving-case fold of a freshly-imported,
 * binding-only duplicate. Picks a LOSER component; on merge, its executor bindings move here and it
 * is soft-deleted. The server rejects a binding-type collision (relabel one first) or an in-flight
 * change, surfaced inline.
 */
function MergeComponentCard({
  survivorId,
  detailKey
}: {
  survivorId: string;
  detailKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [loser, setLoser] = useState("");

  const componentsQuery = useQuery({
    queryKey: registryListKey("components"),
    queryFn: () => client.components.list({ limit: 100 })
  });

  const mergeMutation = useMutation({
    mutationFn: (loserId: string) => client.components.merge(survivorId, loserId),
    onSuccess: async () => {
      setLoser("");
      await queryClient.invalidateQueries({ queryKey: registryListKey("components") });
      await queryClient.invalidateQueries({ queryKey: [...detailKey, "executor-bindings"] });
    }
  });

  const candidates = (componentsQuery.data?.items ?? []).filter((c) => c.id !== survivorId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Merge in a duplicate</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-slate-500">
          Fold a freshly-imported, binding-only component into this one — its executor bindings move
          here and it is soft-deleted.
        </p>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="merge-loser" className="text-xs font-medium text-slate-600">
              Component to merge in
            </label>
            <Select value={loser} onValueChange={setLoser}>
              <SelectTrigger id="merge-loser" data-testid="merge-loser-select">
                <SelectValue placeholder="Select a component…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={!loser || mergeMutation.isPending}
            onClick={() => loser && mergeMutation.mutate(loser)}
            data-testid="merge-submit"
          >
            {mergeMutation.isPending ? "Merging…" : "Merge in"}
          </Button>
        </div>
        {mergeMutation.isError && (
          <p className="text-sm text-red-600">
            {mergeMutation.error instanceof Error ? mergeMutation.error.message : "Failed"}
          </p>
        )}
        {mergeMutation.isSuccess && (
          <p className="text-sm text-green-700" data-testid="merge-success">
            Merged — moved {mergeMutation.data.movedBindingTypes.join(", ") || "no"} binding(s).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

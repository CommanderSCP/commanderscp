import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Unlink } from "lucide-react";
import {
  ExecutorTypeSchema,
  type ExecutorType,
  type GovernanceMoveEnforcement,
  type GovernanceMoveTier,
  type GraphObject,
  type TraverseResult
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { findRegistry, findRegistryByTypeId, getRegistryClient } from "../lib/registries";
import { registryDetailKey, registryListKey } from "../lib/query-client";
import { useBasePathParam, useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";
import {
  ForeignOriginNotice,
  isForeignOriginObject,
  isMergeLoserBlocked,
  isMoveBlocked,
  replicaGuard,
  useOwnDomainId
} from "../lib/replica-origin";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DomainLocalBadge, DomainLocalPublishCard } from "../components/domain-local";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Alert } from "../components/ui/alert";
import { Notice } from "../components/ui/notice";
import { KeyValueList } from "../components/ui/key-value-list";
import { SkeletonRows } from "../components/ui/skeleton";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";
import { queryErrorMessage } from "../components/query-error";

/** `/{basePath}/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2). See docs/web.md §450. */
export function RegistryDetailPage(): React.JSX.Element {
  const basePath = useBasePathParam();
  const idOrUrn = useIdOrUrnParam();
  const registry = findRegistry(basePath);
  const detailKey = registryDetailKey(basePath ?? "", idOrUrn ?? "");
  const { domainId: ownDomainId } = useOwnDomainId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const objectQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => getRegistryClient(client, registry!).get(idOrUrn!),
    enabled: !!registry && !!idOrUrn
  });

  // Owners/consumes/depends-on resolved to full objects (name + type), not bare relationship rows
  // — `client.graph.traverse` returns the neighbor GraphObjects directly, the same pattern
  // `component-graph.tsx` uses to name external nodes. Gated on `objectQuery.data` rather than
  // `idOrUrn` because `traverse`'s `objectId` is a strict UUID and the route param may be a URN.
  const objectId = objectQuery.data?.id;
  const ownersRelatedQuery = useQuery({
    queryKey: [...detailKey, "owners-related"],
    queryFn: () =>
      client.graph.traverse({
        objectId: objectId!,
        direction: "in",
        relTypes: ["owns"],
        maxDepth: 1
      }),
    enabled: !!registry?.ownable && !!objectId
  });
  const consumesRelatedQuery = useQuery({
    queryKey: [...detailKey, "consumes-related"],
    queryFn: () =>
      client.graph.traverse({
        objectId: objectId!,
        direction: "out",
        relTypes: ["consumes"],
        maxDepth: 1
      }),
    enabled: !!registry?.edges && !!objectId
  });
  const dependsOnRelatedQuery = useQuery({
    queryKey: [...detailKey, "depends-on-related"],
    queryFn: () =>
      client.graph.traverse({
        objectId: objectId!,
        direction: "out",
        relTypes: ["depends_on"],
        maxDepth: 1
      }),
    enabled: !!registry?.edges && !!objectId
  });

  if (!registry || !idOrUrn) {
    return (
      <Alert tone="danger" title="Not found">
        This route names no registry object.
      </Alert>
    );
  }
  if (objectQuery.isLoading) {
    return <SkeletonRows n={4} />;
  }
  if (objectQuery.isError || !objectQuery.data) {
    return (
      <Alert tone="danger" title="Not found">
        {objectQuery.error instanceof Error ? objectQuery.error.message : "Not found"}
      </Alert>
    );
  }

  const object = objectQuery.data;
  // Is this object a read-only replica of another domain's. See docs/web.md §451.
  const foreign = isForeignOriginObject(object.originDomainId, ownDomainId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={<span data-testid="object-name">{object.name}</span>}
        description={<span className="font-mono text-xs break-all">{object.urn}</span>}
        meta={
          foreign || object.domainLocal === true ? (
            <span className="flex flex-wrap items-center gap-2">
              {foreign && <ForeignOriginNotice originDomainId={object.originDomainId} />}
              {object.domainLocal === true && (
                <DomainLocalBadge inheritedFrom={object.domainLocalInheritedFrom} />
              )}
            </span>
          ) : undefined
        }
        actions={
          <>
            {/* Service release board (coordination-ui-views.md Phase 2) — the scannable
                per-component status table for this service. Only meaningful for `service`
                objects. */}
            {object.typeId === "service" && (
              <Link to="/services/$idOrUrn" params={{ idOrUrn: object.id }}>
                <Button data-testid="open-release-board">Release board</Button>
              </Link>
            )}
            <Link to="/graph/$idOrUrn" params={{ idOrUrn: object.id }}>
              <Button variant="outline">Open in graph explorer</Button>
            </Link>
            {/* Decisions & Audit explorer (owner-approved 2026-08-23) — every object gets this
                pointer, unconditionally: `GET /decisions` filters by `subjectId` on the wire
                (DecisionListQuerySchema, packages/schemas/src/changes.ts), so the search param
                below is a real server-side filter, not a client one dressed up as an object
                page. */}
            <Link
              to="/admin/decisions"
              search={{ subjectId: object.id }}
              className={cn("text-sm text-slate-600 underline", focusRing)}
              data-testid="object-decisions-link"
            >
              Decisions about this object
            </Link>
          </>
        }
      />

      {/* proposal governance-reach-on-containment-move.md §9.4 Q4 follow-up (owner-approved): a
          read-only pointer to the `governance:move` lattice, on EVERY registry type — the explain
          read is object-scoped and cheap, and every graph object can sit on some rung's containment
          chain. Renders NOTHING while pending, on a failed read, or when the lattice does not reach
          this object — absence here makes no claim; only a successful `enforced: true` answer does. */}
      <GovernedHereLineForObject
        typeId={registry.typeId}
        objectId={object.id}
        detailKey={detailKey}
        fetchEnforcement={(type, id) => client.governanceMove.enforcement(type, id)}
      />

      {/* M20 (ADR-0031 §6): the one-way publish verb. Self-gates on the object's own
          `domainLocal` bit — never on the instance's federation role (see the module doc in
          components/domain-local.tsx). First card so the action and its edge-sweep report are
          visible without scrolling. */}
      <DomainLocalPublishCard
        object={object}
        typeId={registry.typeId}
        invalidateKeys={[detailKey, registryListKey(basePath ?? "")]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Properties</CardTitle>
        </CardHeader>
        <CardContent>
          <PropertiesView properties={object.properties} />
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
                <Badge key={key} variant="neutral">
                  {key}={String(value)}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {registry.serviceMember && (
        <ComponentServiceCard componentId={object.id} detailKey={detailKey} />
      )}

      {registry.ownable && (
        <Card>
          <CardHeader>
            <CardTitle>Owners</CardTitle>
          </CardHeader>
          <CardContent>
            <RelatedObjectList
              query={ownersRelatedQuery}
              selfId={object.id}
              direction="in"
              emptyMessage="No owners."
            />
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
              <RelatedObjectList
                query={consumesRelatedQuery}
                selfId={object.id}
                direction="out"
                emptyMessage="No consumed components."
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Depends on</CardTitle>
            </CardHeader>
            <CardContent>
              <RelatedObjectList
                query={dependsOnRelatedQuery}
                selfId={object.id}
                direction="out"
                emptyMessage="No dependencies."
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* NOT gated on `foreign`: `foreign-origin-writes.integration.test.ts` measures PUT/DELETE/
          PATCH `/executors/:idOrUrn/binding` all SUCCEEDING against a foreign-origin target. This is
          the multi-region workflow (DESIGN.md §12.6) — an outpost binds its OWN local Argo CD to a
          commander-origin deployment-target, then must be able to detach/relabel it. */}
      {(object.typeId === "component" || object.typeId === "deployment-target") && (
        <TargetBindingsCard targetId={object.id} detailKey={detailKey} />
      )}

      {object.typeId === "component" && (
        <MergeComponentCard survivorId={object.id} detailKey={detailKey} />
      )}

      {/* Owner decision 2026-08-18: yes, delete offered for every registry type. Confirm dialog +
          typed-name gate (destructive act); a 409 (container-delete guard, or a governance refusal)
          or a 403 renders the server's sentence verbatim and the dialog stays open — never an
          optimistic removal. Last card: it acts on the whole object every card above describes. */}
      <DeleteObjectCard
        typeLabel={registry.typeId}
        name={object.name}
        urn={object.urn}
        idOrUrn={object.id}
        runDelete={(id) => getRegistryClient(client, registry).delete(id)}
        onDeleted={() => {
          void queryClient.invalidateQueries({ queryKey: registryListKey(basePath ?? "") });
          void navigate({ to: "/$basePath", params: { basePath: basePath ?? "" } });
        }}
      />
    </div>
  );
}

/** Properties, type-aware (spec §4E). See docs/web.md §452. */
function PropertiesView({
  properties
}: {
  properties: Record<string, unknown>;
}): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false);
  const entries = Object.entries(properties);
  if (entries.length === 0) return <p className="text-sm text-slate-500">No properties set.</p>;

  const scalarEntries = entries.filter(([, value]) => value === null || typeof value !== "object");
  const nestedCount = entries.length - scalarEntries.length;

  return (
    <div className="flex flex-col gap-3">
      {scalarEntries.length > 0 && (
        <KeyValueList
          columns={2}
          items={scalarEntries.map(([key, value]) => ({
            label: key,
            value: value === null ? "null" : String(value)
          }))}
        />
      )}
      {nestedCount > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowRaw((v) => !v)}
            data-testid="properties-view-raw-toggle"
          >
            {showRaw ? "Hide raw" : "View raw"} ({nestedCount} nested{" "}
            {nestedCount === 1 ? "value" : "values"})
          </Button>
          {showRaw && (
            <pre className="mt-2 overflow-auto rounded bg-slate-50 p-3 text-xs">
              {JSON.stringify(properties, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Owners/consumes/depends-on, resolved to name + type badge + link. See docs/web.md §453. */
function RelatedObjectList({
  query,
  selfId,
  direction,
  emptyMessage
}: {
  query: { isLoading: boolean; data?: TraverseResult };
  selfId: string;
  /** Which end of each edge is "the other object" — `in` edges point INTO self (owners), `out`
   *  edges point OUT of self (consumes/depends-on). */
  direction: "in" | "out";
  emptyMessage: string;
}): React.JSX.Element {
  if (query.isLoading) return <SkeletonRows n={2} />;
  const objects = query.data?.objects ?? [];
  const edges = query.data?.edges ?? [];
  const byId = new Map(objects.map((o) => [o.id, o]));
  const otherIds = [...new Set(edges.map((e) => (direction === "in" ? e.fromId : e.toId)))].filter(
    (id) => id !== selfId
  );

  if (otherIds.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {otherIds.map((id) => {
        const o = byId.get(id);
        if (!o) {
          // The edge exists but `traverse` did not return its endpoint object — raw id, mono,
          // rather than a name this side cannot vouch for.
          return (
            <li key={id} className="font-mono text-xs text-slate-600">
              {id}
            </li>
          );
        }
        const relatedRegistry = findRegistryByTypeId(o.typeId);
        return (
          <li key={id} className="flex items-center gap-2">
            <Badge variant="neutral" className="capitalize">
              {relatedRegistry?.label ?? o.typeId}
            </Badge>
            {relatedRegistry ? (
              <Link
                to="/$basePath/$idOrUrn"
                params={{ basePath: relatedRegistry.basePath, idOrUrn: o.id }}
                className="font-medium text-slate-900 hover:underline"
              >
                {o.name}
              </Link>
            ) : (
              // No registry maps this typeId — still name it, just not as a link.
              <span className="text-slate-900">{o.name}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The component's owning service (M12 P5b). See docs/web.md §454. */
function ComponentServiceCard({
  componentId,
  detailKey
}: {
  componentId: string;
  detailKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState("");
  const { domainId: ownDomainId } = useOwnDomainId();

  const containsQuery = useQuery({
    queryKey: [...detailKey, "service"],
    queryFn: () => client.relationships.list({ typeId: "contains", toId: componentId, limit: 1 })
  });
  const servicesQuery = useQuery({
    queryKey: registryListKey("services"),
    queryFn: () => client.services.list({ limit: 100 })
  });

  const currentEdge = containsQuery.data?.items[0];
  const currentServiceId = currentEdge?.fromId;
  const currentService = servicesQuery.data?.items.find((s) => s.id === currentServiceId);
  // The one gate here, keyed on the containment edge. See docs/web.md §455.
  const moveBlocked = isMoveBlocked(currentEdge, ownDomainId);
  const moveGuard = replicaGuard(
    moveBlocked,
    "Moving this component would delete its current service edge, which `deleteRelationship` refuses here:"
  );

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
            {/* M20.5/§6a honesty (the M20 author's flagged edge, 2026-08-13): re-parenting is
                where an operator EXPECTS locality to follow, and it never does — locality is set
                at create only. Stated on the move control itself, as a tooltip: always true, so
                it must not shout, but the one place someone reaches for it is here. */}
            <label
              htmlFor="assign-service"
              className="text-xs font-medium text-slate-600"
              title="Moving never changes locality (ADR-0031 §6a): a shared component moved into a domain-local subtree stays shared, and a domain-local one stays local. Locality is set at create; the only exit is the one-way publish."
            >
              {currentServiceId ? "Move to service" : "Assign to service"}
            </label>
            <Select value={selected} onValueChange={setSelected} disabled={moveBlocked}>
              <SelectTrigger id="assign-service" data-testid="assign-service-select" {...moveGuard}>
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
            disabled={moveBlocked || !selected || setServiceMutation.isPending}
            onClick={() => selected && setServiceMutation.mutate(selected)}
            data-testid="assign-service-submit"
            title={moveGuard.title}
          >
            {setServiceMutation.isPending ? "Saving…" : currentServiceId ? "Move" : "Assign"}
          </Button>
        </div>
        {setServiceMutation.isError && (
          <Alert tone="danger">
            {setServiceMutation.error instanceof Error
              ? setServiceMutation.error.message
              : "Failed"}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** A target's executor bindings (M12 P5c). See docs/web.md §456. */
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
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-slate-900">
                    <Badge variant="neutral">{b.type}</Badge>{" "}
                    <Badge variant="neutral">{b.category}</Badge> {b.pluginModule}
                  </span>
                  <span className="break-all font-mono text-xs text-slate-500">
                    {b.pluginInstanceId}
                  </span>
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
                    icon={Unlink}
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
        {error && <Alert tone="danger">{error instanceof Error ? error.message : "Failed"}</Alert>}
      </CardContent>
    </Card>
  );
}

/** Merge another component into this one (M12 P5d). See docs/web.md §457. */
function MergeComponentCard({
  survivorId,
  detailKey
}: {
  survivorId: string;
  detailKey: unknown[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [loser, setLoser] = useState("");
  const { domainId: ownDomainId } = useOwnDomainId();

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

  // The one gate here, and it is keyed on the loser. See docs/web.md §458.
  const candidates = (componentsQuery.data?.items ?? [])
    .filter((c) => c.id !== survivorId)
    .map((c) => ({
      ...c,
      loserBlocked: isMergeLoserBlocked(c, ownDomainId)
    }));

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
                  <SelectItem
                    key={c.id}
                    value={c.id}
                    data-testid={c.loserBlocked ? `merge-loser-blocked-${c.id}` : undefined}
                    {...replicaGuard(
                      c.loserBlocked,
                      "Merging this component in would soft-delete it, which `deleteObject` refuses here:"
                    )}
                  >
                    {/* A disabled Radix item is `pointer-events-none`, so its `title` tooltip is
                        unreachable on hover — the reason has to be visible in the label itself. */}
                    {c.loserBlocked ? `${c.name} — read-only replica, owned elsewhere` : c.name}
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
          <Alert tone="danger">
            {mergeMutation.error instanceof Error ? mergeMutation.error.message : "Failed"}
          </Alert>
        )}
        {mergeMutation.isSuccess && (
          <Notice tone="success" data-testid="merge-success">
            {mergeMutation.data.movedBindingTypes.length === 0
              ? "Merged — no bindings moved."
              : // Real pluralization (copy rule 6) — "binding(s)" is banned.
                `Merged — moved ${mergeMutation.data.movedBindingTypes.length} binding${
                  mergeMutation.data.movedBindingTypes.length === 1 ? "" : "s"
                } (${mergeMutation.data.movedBindingTypes.join(", ")}).`}
          </Notice>
        )}
      </CardContent>
    </Card>
  );
}

// Governed-here line (governance-reach-on-containment-move.md §9.4 Q4 follow-up).

/** Sentence-case labels for the rung tiers a UI ever needs to name (admin-governance.tsx's
 *  `CONTAINER_TIERS` covers the same three plus its own "Org root" spelling for the switch; this is
 *  the read-only prose form used inline in a sentence, so "org root" rather than "Org root"). */
const GOVERNANCE_MOVE_TIER_LABELS: Record<GovernanceMoveTier, string> = {
  org: "org root",
  containment_domain: "containment domain",
  service: "service",
  assembly: "assembly"
};

/** The rendered line itself. See docs/web.md §459. */
export function GovernedHereLine({
  enforcement
}: {
  enforcement: GovernanceMoveEnforcement;
}): React.JSX.Element {
  const rungs = enforcement.rungs;
  const nearest = rungs.length > 0 ? rungs[rungs.length - 1] : undefined;
  const others = rungs.length > 1 ? rungs.slice(0, -1) : [];
  const moreTooltip =
    others.length > 0
      ? `Also enabled at ${others
          .map((r) => `${GOVERNANCE_MOVE_TIER_LABELS[r.tier]} '${r.name}'`)
          .join(", ")}.`
      : undefined;

  return (
    <p className="text-xs text-slate-500" data-testid="governed-here-line">
      Moves here are governed — enforcement enabled at{" "}
      {nearest ? (
        <span title={moreTooltip} data-testid="governed-here-rung">
          {GOVERNANCE_MOVE_TIER_LABELS[nearest.tier]} '
          <span className="font-medium text-slate-700">{nearest.name}</span>'
          {others.length > 0 ? ` (+${others.length} more)` : ""}
        </span>
      ) : (
        "the instance level"
      )}
      {" — "}
      <Link to="/admin/governance" className={cn("underline", focusRing)}>
        Manage
      </Link>
    </p>
  );
}

/** Wires the explain read. See docs/web.md §460. */
export function GovernedHereLineForObject({
  typeId,
  objectId,
  detailKey,
  fetchEnforcement
}: {
  typeId: string;
  objectId: string;
  detailKey: unknown[];
  fetchEnforcement: (type: string, idOrUrn: string) => Promise<GovernanceMoveEnforcement>;
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: [...detailKey, "governance-move-enforcement"],
    queryFn: () => fetchEnforcement(typeId, objectId)
  });
  if (query.data?.enforced !== true) return null;
  return <GovernedHereLine enforcement={query.data} />;
}

// Delete… (owner decision 2026-08-18: every registry type, confirm + rendered refusal).

/** Verbatim server sentence for a delete refusal. See docs/web.md §461. */
export function deleteRefusalMessage(error: unknown): string {
  if (error instanceof ScpApiError) {
    return error.problem?.detail ?? error.message;
  }
  return queryErrorMessage(error);
}

/** The confirm dialog's body, portal-free. See docs/web.md §462. */
export function DeleteObjectDialogBody({
  typeLabel,
  name,
  urn,
  run,
  onDeleted,
  onCancel
}: {
  typeLabel: string;
  name: string;
  urn: string;
  run: () => Promise<GraphObject>;
  onDeleted: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const matches = confirmText === name;

  const doDelete = async () => {
    // Belt and braces beside the disabled button: the real write never fires on a mismatched name,
    // whatever dispatched the click.
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await run();
      onDeleted();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="delete-body">
        <p>
          Permanently removes this {typeLabel} —{" "}
          <span className="font-medium text-slate-900">{name}</span>{" "}
          <span className="font-mono text-xs text-slate-500">{urn}</span>. If anything still depends
          on it, the server refuses and names what to move or delete first.
        </p>
        <label className="block">
          <SectionLabel as="span">
            Type <span className="font-mono text-slate-700">{name}</span> to confirm
          </SectionLabel>
          <Input
            className="mt-1 font-mono"
            value={confirmText}
            disabled={busy}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={name}
            data-testid="delete-confirm-name"
          />
        </label>
        {error !== null ? (
          <Alert tone="danger" data-testid="delete-error">
            {deleteRefusalMessage(error)}
          </Alert>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onClick={() => void doDelete()}
          disabled={busy || !matches}
          data-testid="delete-confirm"
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The card + dialog trigger, threaded provider-free. See docs/web.md §463. */
export function DeleteObjectCard({
  typeLabel,
  name,
  urn,
  idOrUrn,
  runDelete,
  onDeleted
}: {
  typeLabel: string;
  name: string;
  urn: string;
  idOrUrn: string;
  runDelete: (idOrUrn: string) => Promise<GraphObject>;
  onDeleted: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-slate-500">
          Permanently removes this {typeLabel}. This cannot be undone from here.
        </p>
        <Button
          variant="destructive"
          icon={Trash2}
          className="self-start"
          onClick={() => setOpen(true)}
          data-testid="delete-open"
        >
          Delete…
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent data-testid="delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete {typeLabel}</DialogTitle>
            <DialogDescription>
              This soft-deletes the object. If anything still depends on it, the server refuses and
              names what to move or delete first.
            </DialogDescription>
          </DialogHeader>
          {open ? (
            <DeleteObjectDialogBody
              typeLabel={typeLabel}
              name={name}
              urn={urn}
              run={() => runDelete(idOrUrn)}
              onDeleted={() => {
                setOpen(false);
                onDeleted();
              }}
              onCancel={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

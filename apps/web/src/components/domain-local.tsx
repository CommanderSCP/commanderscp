import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import type { PublishObjectResponse, SweptRelationship } from "@scp/schemas";
import { client } from "../lib/client";
import { findRegistryByTypeId } from "../lib/registries";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Notice } from "./ui/notice";
import { Alert } from "./ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

/** M20 (ADR-0031) — the three UI surfaces of a domain-local object. See docs/web.md §40. */

/** Worn wherever the object's name is (list row, detail header). See docs/web.md §41. */
export function DomainLocalBadge({
  inheritedFrom
}: {
  inheritedFrom?: { id: string; urn: string } | null;
}): React.JSX.Element {
  const base =
    "Domain-local (ADR-0031): its existence never leaves this security domain — nothing about it is ever journaled to federation peers. Immutable once set; the only exit is the one-way Publish action on its detail page.";
  const provenance = inheritedFrom
    ? ` Inherited at create from ${inheritedFrom.urn} (M20.5 container declaration — historical provenance, stamped at create).`
    : " Declared directly at create.";
  return (
    <Badge
      variant="neutral"
      icon={EyeOff}
      data-testid="domain-local-badge"
      title={base + provenance}
    >
      domain-local
    </Badge>
  );
}

/** The create-form declaration. See docs/web.md §42. */
export function DomainLocalCreateField({
  checked,
  onChange
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="accent-army-600"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          data-testid="new-domain-local-checkbox"
        />
        Domain-local — never federates
      </label>
      <p className="pl-6 text-xs text-slate-500">
        Its existence never leaves this security domain: nothing about it is journaled to federation
        peers (ADR-0031). Declaring this requires the <code>federation:write</code> permission.
        Immutable once set — the only way out is the one-way publish action on its detail page; the
        reverse (shared → domain-local) is refused permanently, because federation has no un-send.
        Declared on a domain, service or assembly, it propagates: anything created inside inherits
        it at create. Existing objects are never retrofitted — only objects created after the
        declaration inherit.
      </p>
    </div>
  );
}

/** The confirm copy, exported so the test can render it. See docs/web.md §43. */
export function PublishConfirmBody(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-sm text-slate-600">
      <p>
        Publishing is <strong>one-way</strong>. Once this object&apos;s existence has crossed to a
        federation peer it cannot be recalled — <strong>there is no un-publish</strong>, because
        federation has no un-send.
      </p>
      <p>
        The object is re-journaled full-state and federates from this point on, like any shared
        object. Relationships whose other endpoint is still domain-local are withheld — they stay
        home until that endpoint is published too. Peers will see no history from before this
        moment.
      </p>
      <p>
        Order matters (M20.6): an object inside a still-domain-local container cannot be published —
        publish its containers first; a refused publish names them. And publishing a container does
        not publish its children — each child is its own explicit decision.
      </p>
    </div>
  );
}

/** The publish verb (ADR-0031 §6). See docs/web.md §44. */
export function DomainLocalPublishCard({
  object,
  typeId,
  invalidateKeys
}: {
  object: {
    id: string;
    name: string;
    domainLocal?: boolean;
    domainLocalInheritedFrom?: { id: string; urn: string } | null;
  };
  typeId: string;
  /** Query keys to invalidate after a successful publish (detail + list). */
  invalidateKeys: QueryKey[];
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<PublishObjectResponse | null>(null);

  const publishMutation = useMutation({
    mutationFn: () => client.object(typeId).publish(object.id),
    onSuccess: async (response) => {
      setResult(response);
      setConfirmOpen(false);
      await Promise.all(
        invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
      );
    }
  });

  if (object.domainLocal !== true && !result) return null;

  return (
    <Card data-testid="domain-local-publish-card">
      <CardHeader>
        <CardTitle>Federation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {result ? (
          <>
            <Notice tone="success" data-testid="publish-result">
              Published — this object federates from this point on.
            </Notice>
            <div className="grid gap-4 sm:grid-cols-2">
              <EdgeBucket
                heading={`Published with it — ${result.publishedRelationships.length}`}
                edges={result.publishedRelationships}
                emptyText="No relationships crossed with it — the object had no shared edges to sweep."
                testId="publish-published-bucket"
              />
              <EdgeBucket
                heading={`Withheld — ${result.withheldRelationships.length}`}
                edges={result.withheldRelationships}
                emptyText="None — every relationship crossed with it."
                explain="Each withheld edge's other endpoint is still domain-local. Publishing that endpoint releases its edges; nothing here leaked."
                testId="publish-withheld-bucket"
              />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              This object is domain-local: nothing about it — its existence included — is journaled
              to federation peers. Publishing is the one-way exit.
            </p>
            {/* M20.7 provenance — HISTORICAL, read from the server's create-time stamp. It says
                where the bit came from; it deliberately does NOT claim that container still
                withholds publication (the container may have published since — the server's §6b
                check at publish time is the only authority on ordering). */}
            {object.domainLocalInheritedFrom && (
              <p
                className="text-xs text-slate-500"
                data-testid="publish-provenance"
                title="Stamped at create (ADR-0031 §6c). Historical provenance only — whether that container still blocks publication is decided by the server when you publish, not by this label."
              >
                Locality inherited at create from{" "}
                <ProvenanceLink source={object.domainLocalInheritedFrom} />.
              </p>
            )}
            <div>
              <Button
                variant="outline"
                onClick={() => setConfirmOpen(true)}
                data-testid="publish-object-button"
              >
                Publish to federation…
              </Button>
            </div>
            {publishMutation.isError && (
              <Alert tone="danger" data-testid="publish-error">
                {publishMutation.error instanceof Error
                  ? publishMutation.error.message
                  : "Publish failed"}
              </Alert>
            )}
          </>
        )}

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Publish {object.name}?</DialogTitle>
            </DialogHeader>
            <PublishConfirmBody />
            {/* M20.6: a publish refused for a still-local container 409s with the offending
                containers NAMED (name + urn) in the detail — rendered here verbatim, at the point
                of action, so "publish secure-networking first" is guidance rather than a mystery.
                Deliberately NOT pre-blocked: whether every containment parent (both routes) still
                federates is the server's census to run, not a per-row client derivation — M16.3's
                offer-the-write rule and the read-never-infer discipline both apply. */}
            {publishMutation.isError && (
              <Alert tone="danger" data-testid="publish-refused">
                {publishMutation.error instanceof Error
                  ? publishMutation.error.message
                  : "Publish refused"}
              </Alert>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => publishMutation.mutate()}
                disabled={publishMutation.isPending}
                data-testid="publish-confirm"
              >
                {publishMutation.isPending ? "Publishing…" : "Publish permanently"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/** One bucket of the edge-sweep report, from the arrays. See docs/web.md §45. */
function EdgeBucket({
  heading,
  edges,
  emptyText,
  explain,
  testId
}: {
  heading: string;
  edges: SweptRelationship[];
  emptyText: string;
  explain?: string;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-sm font-medium text-slate-900">{heading}</h4>
      {explain && edges.length > 0 && <p className="text-xs text-slate-500">{explain}</p>}
      {edges.length === 0 ? (
        <p className="text-xs text-slate-500">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {edges.map((edge) => (
            <li key={edge.id} className="flex items-baseline gap-1.5 text-xs">
              <span className="shrink-0 font-mono text-slate-500">{edge.typeId}</span>
              <span className="shrink-0 text-slate-400" aria-hidden="true">
                →
              </span>
              <EndpointName edge={edge} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The provenance stamp's container. See docs/web.md §46. */
export function ProvenanceLink({
  source
}: {
  source: { id: string; urn: string };
}): React.JSX.Element {
  const registry = findRegistryByTypeId(source.urn.split(":")[3]);
  const label = source.urn.split(":").pop() ?? source.urn;
  if (!registry) {
    return (
      <span className="font-medium text-slate-700" title={source.urn}>
        {label}
      </span>
    );
  }
  return (
    <Link
      to="/$basePath/$idOrUrn"
      params={{ basePath: registry.basePath, idOrUrn: source.id }}
      className="font-medium text-slate-900 hover:underline"
      title={source.urn}
    >
      {label}
    </Link>
  );
}

/** The other endpoint, linked when its urn names a route. See docs/web.md §47. */
export function EndpointName({ edge }: { edge: SweptRelationship }): React.JSX.Element {
  // `urn:scp:{org}:{type}:{slug}` — segment 3 is the typeId. A degraded urn (vanished endpoint:
  // the server substitutes the raw id) has no such segment and resolves to no registry.
  const registry = findRegistryByTypeId(edge.otherEndpointUrn.split(":")[3]);
  if (!registry) {
    return (
      <span className="break-all text-slate-700" title={edge.otherEndpointUrn}>
        {edge.otherEndpointName}
      </span>
    );
  }
  return (
    <Link
      to="/$basePath/$idOrUrn"
      params={{ basePath: registry.basePath, idOrUrn: edge.otherEndpointId }}
      className="break-all font-medium text-slate-900 hover:underline"
      title={edge.otherEndpointUrn}
    >
      {edge.otherEndpointName}
    </Link>
  );
}

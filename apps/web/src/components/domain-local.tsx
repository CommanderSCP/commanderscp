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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./ui/dialog";

/**
 * M20 (ADR-0031) — the three UI surfaces of a domain-local object: the badge, the create-form
 * declaration, and the one-way publish verb.
 *
 * Everything in this file keys on the OBJECT's own `domainLocal` bit, never on the instance's
 * federation role. That is deliberate and load-bearing (ADR-0031 §Consequences): the commander's
 * UI simply never receives a domain-local object, so there is nothing to conditionally hide — and
 * a role-gated view would reintroduce exactly the failure mode M16.3's write-control census found.
 * Do not add `federation.self` checks here.
 */

/**
 * Worn wherever the object's name is (list row, detail header). `domainLocal` is a declared fact,
 * not an unknown — so this is a neutral pill (spec §1.5), not the amber-dashed honesty badge.
 */
export function DomainLocalBadge(): React.JSX.Element {
  return (
    <Badge
      variant="neutral"
      icon={EyeOff}
      data-testid="domain-local-badge"
      title="Domain-local (ADR-0031), declared at create — directly, or inherited from a domain-local container (M20.5): its existence never leaves this security domain — nothing about it is ever journaled to federation peers. Immutable once set; the only exit is the one-way Publish action on its detail page."
    >
      domain-local
    </Badge>
  );
}

/**
 * The create-form declaration. Create-time only by contract (ADR-0031 §6): shared → domain-local
 * is refused permanently after the fact, so this checkbox is the ONE moment the property can be
 * set — the help text says so instead of letting the operator find out from a 409 later.
 *
 * M20.5 (§6a): declared on a CONTAINER (domain, service, assembly), locality propagates — anything
 * created underneath inherits at ITS create, one hop, along either containment route. The help
 * text names that, and names the boundary: inheritance happens at create only, never as a
 * retrofit of an existing subtree. The payload contract stays omit-when-unchecked — an explicit
 * `domainLocal: false` inside a local container is a 400 by design (the operator asked for shared
 * and must not silently get local), and omitting the field is what lets inheritance decide.
 */
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
        Its existence never leaves this security domain: nothing about it is journaled to
        federation peers (ADR-0031). Declaring this requires the <code>federation:write</code>{" "}
        permission. Immutable once set — the only way out is the one-way publish action on its
        detail page; the reverse (shared → domain-local) is refused permanently, because
        federation has no un-send. Declared on a domain, service or assembly, it propagates:
        anything created inside inherits it at create. Existing objects are never retrofitted —
        only objects created after the declaration inherit.
      </p>
    </div>
  );
}

/**
 * The confirm copy, exported as its own component so `domain-local.test.tsx` can pin the
 * load-bearing phrases without fighting Radix's portal (which renders nothing under
 * `renderToStaticMarkup`).
 */
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
    </div>
  );
}

/**
 * The publish verb (ADR-0031 §6) — an ACTION with an effect, deliberately not a field edit, so
 * the card renders it as one: an explicit button, an irreversible-confirm dialog, and a visible
 * report of the edge sweep afterwards (published vs withheld buckets).
 *
 * Renders `null` unless the object is domain-local (or was just published in this session — the
 * result panel must survive the refetch that flips `domainLocal` to false). Gating is data-driven
 * only; see the module doc.
 */
export function DomainLocalPublishCard({
  object,
  typeId,
  invalidateKeys
}: {
  object: { id: string; name: string; domainLocal?: boolean };
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

/**
 * One bucket of the edge-sweep report, rendered from the DESCRIBED arrays
 * (`publishedRelationships`/`withheldRelationships`) the contract grew after this UI's first cut
 * flagged the bare-id arrays as illegible. Each row is edge type → other endpoint by name, urn in
 * the tooltip. The withheld bucket's endpoint links to its own page when its type is a routed
 * registry — "publish that endpoint" is the operator's next action, and its publish card lives
 * there. A vanished endpoint degrades urn/name to the id server-side, so the name is always safe
 * to render (and the failed registry lookup makes such a row plain text, not a dead link).
 */
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

/**
 * The other endpoint, linked into its registry page when its urn names a routed type.
 *
 * Exported for `domain-local.test.tsx`, which pins BOTH branches — because the no-link branch
 * rides on a server-side FALLBACK, not a contract (the M20 author's caveat, 2026-08-13): a
 * vanished endpoint currently degrades `otherEndpointUrn` to the raw id, which happens to have no
 * type segment and so resolves to no registry. If that fallback ever changes shape (say, to the
 * literal string "unknown"), the pinned test is what turns the change into a red test instead of
 * a dead link discovered by an operator.
 */
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

import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateObjectRequest } from "@scp/schemas";
import { client } from "../lib/client";
import { findRegistry, getRegistryClient } from "../lib/registries";
import { registryListKey } from "../lib/query-client";
import { useBasePathParam } from "../lib/use-route-params";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { PageHeader } from "../components/ui/page-header";
import { DomainLocalBadge, DomainLocalCreateField } from "../components/domain-local";
import { Alert } from "../components/ui/alert";
import { EmptyState } from "../components/ui/empty-state";
import { SkeletonRows } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";

/**
 * The create-request payload's field-inclusion rules, pulled out as a pure function so the wiring
 * claim ("domainId rides through only when a parent domain was actually chosen") is testable without
 * a router or a live mutation. Mirrors the `domainLocal` field's existing omit-when-unset rule
 * immediately below it — an unset optional field is left OUT of the payload, never sent as `""`/`null`.
 */
export function buildCreatePayload(input: {
  name: string;
  serviceMember: boolean;
  serviceId: string;
  domainLocal: boolean;
  isDomainsRegistry: boolean;
  parentDomainId: string;
}): { name: string; service?: string; domainLocal?: true; domainId?: string } {
  return {
    name: input.name,
    ...(input.serviceMember ? { service: input.serviceId } : {}),
    // Omitted when unchecked rather than sent as `false` — only a true declaration needs the
    // `federation:write` permission, and only true is immutable (ADR-0031 §1/§6).
    ...(input.domainLocal ? { domainLocal: true } : {}),
    // G2: empty selection = top-level (no parent), same as today — `domainId` rides through only
    // when the operator actually picked a domain, and only on the domains registry.
    ...(input.isDomainsRegistry && input.parentDomainId ? { domainId: input.parentDomainId } : {})
  };
}

/**
 * The parent-domain picker itself, pulled out as its own component so the "renders for the domains
 * registry only" claim is testable with a plain `renderToStaticMarkup` — `RegistryListPage` needs a
 * router (`useBasePathParam`) to mount at all, but this piece of markup does not.
 *
 * `show` is the caller's `isDomainsRegistry` flag rather than a registry object, so the test can
 * assert both branches without constructing a `RegistryConfig`.
 */
export function ParentDomainField(props: {
  show: boolean;
  value: string;
  onChange: (value: string) => void;
  options: { id: string; name: string }[];
}): React.JSX.Element | null {
  if (!props.show) return null;
  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <label htmlFor="new-parent-domain" className="text-sm font-medium text-slate-700">
        Parent domain
      </label>
      {/* Optional — no selection means top-level (the existing default), not "required" the way the
          service picker is. A subdomain nests one hop under the chosen domain and inherits its
          locality at create (M20.5, ADR-0031 §6a). */}
      <Select value={props.value} onValueChange={props.onChange}>
        <SelectTrigger id="new-parent-domain" data-testid="new-parent-domain-select">
          <SelectValue placeholder="Top-level (no parent)" />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((dom) => (
            <SelectItem key={dom.id} value={dom.id}>
              {dom.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** `/{basePath}` (BUILD_AND_TEST.md §8 M2 item 2) — list view + create-new affordance. */
export function RegistryListPage(): React.JSX.Element {
  const basePath = useBasePathParam();
  const registry = findRegistry(basePath);
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [domainLocal, setDomainLocal] = useState(false);
  const [parentDomainId, setParentDomainId] = useState("");
  const serviceMember = registry?.serviceMember ?? false;
  // G2 (outpost-ui.md §5(b), owner decision 2026-08-13): nested containment domains are first-class
  // — the domains registry alone gets a parent-domain picker at create. No other registry may name a
  // `domain` as its container from this form (a service/component's `domainId` is still inherited via
  // M20.5, never chosen here).
  const isDomainsRegistry = registry?.basePath === "domains";

  const listQuery = useQuery({
    queryKey: registryListKey(basePath ?? ""),
    queryFn: () => getRegistryClient(client, registry!).list({ limit: 100 }),
    enabled: !!registry
  });

  // A service-member registry (component, M12 P5a) needs an owning service picked at create time.
  // Fetch the services list to populate the required selector — only when this registry needs it.
  const servicesQuery = useQuery({
    queryKey: registryListKey("services"),
    queryFn: () => client.services.list({ limit: 100 }),
    enabled: !!registry && serviceMember
  });

  // The parent-domain picker's options — every domain this org already has. Optional (a domain with
  // no parent is a top-level domain, same as today), so this never blocks submit the way the
  // service picker does.
  const domainsQuery = useQuery({
    queryKey: registryListKey("domains"),
    queryFn: () => client.domains.list({ limit: 100 }),
    enabled: !!registry && isDomainsRegistry
  });

  const createMutation = useMutation({
    mutationFn: (input: {
      name: string;
      service?: string;
      domainLocal?: boolean;
      domainId?: string;
    }) =>
      // `service` is only set for a service-member registry; it rides through to
      // `CreateComponentRequest.service`. Cast because the shared client type is the base request.
      // `domainId` is only ever set here for the domains registry — CreateObjectRequest already
      // carries it (packages/schemas/src/objects.ts:39), so no schema change and no generic-client
      // fallback are needed.
      getRegistryClient(client, registry!).create(input as CreateObjectRequest),
    onSuccess: async () => {
      setName("");
      setServiceId("");
      setDomainLocal(false);
      setParentDomainId("");
      setShowCreate(false);
      await queryClient.invalidateQueries({ queryKey: registryListKey(basePath ?? "") });
    }
  });

  if (!registry) {
    return (
      <Alert tone="danger" title="Unknown registry">
        &quot;{basePath}&quot; is not a registry this instance knows about.
      </Alert>
    );
  }

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Create is strict for a service member — block submit until a service is chosen (the server
    // would 400 otherwise). The Select is also marked required for accessibility/native validation.
    if (serviceMember && !serviceId) return;
    createMutation.mutate(
      buildCreatePayload({
        name: trimmed,
        serviceMember,
        serviceId,
        domainLocal,
        isDomainsRegistry,
        parentDomainId
      })
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={registry.label}
        actions={
          <Button onClick={() => setShowCreate((v) => !v)} data-testid="toggle-create">
            {showCreate ? "Cancel" : "New"}
          </Button>
        }
      />

      {showCreate && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4"
          onSubmit={handleCreate}
        >
          <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="new-name" className="text-sm font-medium text-slate-700">
              Name
            </label>
            <Input
              id="new-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              data-testid="new-name-input"
            />
          </div>
          {serviceMember && (
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor="new-service" className="text-sm font-medium text-slate-700">
                Service
              </label>
              <Select value={serviceId} onValueChange={setServiceId} required>
                <SelectTrigger id="new-service" data-testid="new-service-select">
                  <SelectValue placeholder="Select a service…" />
                </SelectTrigger>
                <SelectContent>
                  {(servicesQuery.data?.items ?? []).map((svc) => (
                    <SelectItem key={svc.id} value={svc.id}>
                      {svc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {servicesQuery.data && servicesQuery.data.items.length === 0 && (
                <p className="text-xs text-amber-700" data-testid="no-services-hint">
                  Create a service first — a component must belong to one.
                </p>
              )}
            </div>
          )}
          <ParentDomainField
            show={isDomainsRegistry}
            value={parentDomainId}
            onChange={setParentDomainId}
            options={domainsQuery.data?.items ?? []}
          />
          <Button
            type="submit"
            disabled={createMutation.isPending || (serviceMember && !serviceId)}
            data-testid="submit-create"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
          </div>
          <DomainLocalCreateField checked={domainLocal} onChange={setDomainLocal} />
        </form>
      )}
      {createMutation.isError && (
        <Alert tone="danger">
          {createMutation.error instanceof Error
            ? createMutation.error.message
            : "Failed to create"}
        </Alert>
      )}

      {listQuery.isLoading && <SkeletonRows n={5} />}
      {listQuery.isError && (
        <QueryErrorNotice
          error={listQuery.error}
          what={registry.label.toLowerCase()}
          testId="registry-list-error"
        />
      )}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <EmptyState
          icon={registry.icon}
          message={`No ${registry.label.toLowerCase()} yet.`}
          data-testid="empty-state"
        />
      )}
      {listQuery.data && listQuery.data.items.length > 0 && (
        <Table data-testid="registry-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URN</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listQuery.data.items.map((item) => (
              <TableRow key={item.id} data-testid="registry-row">
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Link
                      to="/$basePath/$idOrUrn"
                      params={{ basePath: registry.basePath, idOrUrn: item.id }}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {item.name}
                    </Link>
                    {item.domainLocal === true && <DomainLocalBadge />}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-slate-500">{item.urn}</TableCell>
                {/* A date is not a status (spec §4E) — plain caption text, not a Badge. */}
                <TableCell className="text-xs text-slate-500">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

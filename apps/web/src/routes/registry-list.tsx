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
import { Alert } from "../components/ui/alert";
import { EmptyState } from "../components/ui/empty-state";
import { SkeletonRows } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";

/** `/{basePath}` (BUILD_AND_TEST.md §8 M2 item 2) — list view + create-new affordance. */
export function RegistryListPage(): React.JSX.Element {
  const basePath = useBasePathParam();
  const registry = findRegistry(basePath);
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [serviceId, setServiceId] = useState("");
  const serviceMember = registry?.serviceMember ?? false;

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

  const createMutation = useMutation({
    mutationFn: (input: { name: string; service?: string }) =>
      // `service` is only set for a service-member registry; it rides through to
      // `CreateComponentRequest.service`. Cast because the shared client type is the base request.
      getRegistryClient(client, registry!).create(input as CreateObjectRequest),
    onSuccess: async () => {
      setName("");
      setServiceId("");
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
      serviceMember ? { name: trimmed, service: serviceId } : { name: trimmed }
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
          className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white p-4"
          onSubmit={handleCreate}
        >
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
          <Button
            type="submit"
            disabled={createMutation.isPending || (serviceMember && !serviceId)}
            data-testid="submit-create"
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
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
                  <Link
                    to="/$basePath/$idOrUrn"
                    params={{ basePath: registry.basePath, idOrUrn: item.id }}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {item.name}
                  </Link>
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

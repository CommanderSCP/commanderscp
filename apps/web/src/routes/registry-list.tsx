import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/client";
import { findRegistry, getRegistryClient } from "../lib/registries";
import { registryListKey } from "../lib/query-client";
import { useBasePathParam } from "../lib/use-route-params";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { Badge } from "../components/ui/badge";

/** `/{basePath}` (BUILD_AND_TEST.md §8 M2 item 2) — list view + create-new affordance. */
export function RegistryListPage(): React.JSX.Element {
  const basePath = useBasePathParam();
  const registry = findRegistry(basePath);
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");

  const listQuery = useQuery({
    queryKey: registryListKey(basePath ?? ""),
    queryFn: () => getRegistryClient(client, registry!).list({ limit: 100 }),
    enabled: !!registry
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string }) => getRegistryClient(client, registry!).create(input),
    onSuccess: async () => {
      setName("");
      setShowCreate(false);
      await queryClient.invalidateQueries({ queryKey: registryListKey(basePath ?? "") });
    }
  });

  if (!registry) {
    return <p className="text-sm text-red-600">Unknown registry &quot;{basePath}&quot;.</p>;
  }

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate({ name: trimmed });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">{registry.label}</h1>
        <Button onClick={() => setShowCreate((v) => !v)} data-testid="toggle-create">
          {showCreate ? "Cancel" : "New"}
        </Button>
      </div>

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
          <Button type="submit" disabled={createMutation.isPending} data-testid="submit-create">
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
        </form>
      )}
      {createMutation.isError && (
        <p className="text-sm text-red-600">
          {createMutation.error instanceof Error ? createMutation.error.message : "Failed to create"}
        </p>
      )}

      {listQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {listQuery.isError && (
        <p className="text-sm text-red-600">
          {listQuery.error instanceof Error ? listQuery.error.message : "Failed to load"}
        </p>
      )}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <p className="text-sm text-slate-500" data-testid="empty-state">
          No {registry.label.toLowerCase()} yet.
        </p>
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
                <TableCell>
                  <Badge variant="secondary">{new Date(item.updatedAt).toLocaleDateString()}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

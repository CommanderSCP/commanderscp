import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/client";
import { initiativeListKey } from "../lib/query-client";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";

/**
 * `/initiatives` (BUILD_AND_TEST.md §8 M5 UI requirement) — every Initiative in the org, plus a
 * "Create Initiative" dialog wrapping `client.initiatives.propose` (packages/sdk/src/client.ts).
 */
export function InitiativeListPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showPropose, setShowPropose] = useState(false);
  const [name, setName] = useState("");
  const [campaigns, setCampaigns] = useState("");
  const [description, setDescription] = useState("");

  const listQuery = useQuery({
    queryKey: initiativeListKey(),
    queryFn: () => client.initiatives.list({ limit: 100 })
  });

  const proposeMutation = useMutation({
    mutationFn: () =>
      client.initiatives.propose({
        name: name.trim(),
        campaigns: campaigns
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
        description: description.trim() || undefined
      }),
    onSuccess: async (created) => {
      setShowPropose(false);
      setName("");
      setCampaigns("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: initiativeListKey() });
      await navigate({ to: "/initiatives/$id", params: { id: created.id } });
    }
  });

  function handlePropose(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    proposeMutation.mutate();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Initiatives</h1>
        <Button onClick={() => setShowPropose(true)} data-testid="propose-initiative-button">
          Create Initiative
        </Button>
      </div>

      {listQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {listQuery.isError && (
        <p className="text-sm text-red-600">
          {listQuery.error instanceof Error ? listQuery.error.message : "Failed to load"}
        </p>
      )}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <p className="text-sm text-slate-500" data-testid="empty-state">
          No initiatives yet.
        </p>
      )}
      {listQuery.data && listQuery.data.items.length > 0 && (
        <Table data-testid="initiative-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listQuery.data.items.map((initiative) => (
              <TableRow key={initiative.id} data-testid="initiative-row">
                <TableCell>
                  <Link
                    to="/initiatives/$id"
                    params={{ id: initiative.id }}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {initiative.name}
                  </Link>
                </TableCell>
                <TableCell>{new Date(initiative.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={showPropose} onOpenChange={setShowPropose}>
        <DialogContent data-testid="propose-initiative-dialog">
          <DialogHeader>
            <DialogTitle>Create Initiative</DialogTitle>
            <DialogDescription>
              An initiative groups related campaigns and rolls up their status (DESIGN §9.5).
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={handlePropose}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="initiative-name" className="text-sm font-medium text-slate-700">
                Name
              </label>
              <Input
                id="initiative-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="initiative-name-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="initiative-campaigns" className="text-sm font-medium text-slate-700">
                Campaigns to link (optional, comma-separated id or URN)
              </label>
              <Input
                id="initiative-campaigns"
                value={campaigns}
                onChange={(e) => setCampaigns(e.target.value)}
                data-testid="initiative-campaigns-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="initiative-description" className="text-sm font-medium text-slate-700">
                Description (optional)
              </label>
              <Input
                id="initiative-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="initiative-description-input"
              />
            </div>
            {proposeMutation.isError && (
              <p className="text-sm text-red-600">
                {proposeMutation.error instanceof Error
                  ? proposeMutation.error.message
                  : "Failed to create initiative"}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowPropose(false)}
                data-testid="propose-initiative-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={proposeMutation.isPending}
                data-testid="propose-initiative-submit"
              >
                {proposeMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

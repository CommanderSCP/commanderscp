import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangeState } from "@scp/sdk";
import { client } from "../lib/client";
import { changeListKey } from "../lib/query-client";
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
import { Badge, type BadgeProps } from "../components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "../components/ui/select";

const CHANGE_STATES: ChangeState[] = [
  "proposed",
  "evaluated",
  "coordinated",
  "executing",
  "validating",
  "promoted",
  "cancelled",
  "rolled_back"
];

const ALL_STATES = "all";

/** Change `state` -> Badge variant (badge.tsx) — shared with change-detail.tsx's header badge. */
export function stateBadgeVariant(state: ChangeState): BadgeProps["variant"] {
  switch (state) {
    case "proposed":
    case "evaluated":
    case "coordinated":
      return "outline";
    case "executing":
    case "validating":
      return "info";
    case "promoted":
      return "success";
    case "cancelled":
    case "rolled_back":
      return "destructive";
    default:
      return "secondary";
  }
}

export function StateBadge({ state }: { state: ChangeState }): React.JSX.Element {
  return (
    <Badge variant={stateBadgeVariant(state)} data-testid="change-state-badge">
      {state}
    </Badge>
  );
}

/**
 * `/changes` (BUILD_AND_TEST.md §8 M3 UI requirement: "UI change list...") — every Change in the
 * org, optionally filtered by `state`, plus a "Propose Change" dialog wrapping
 * `client.changes.propose` (packages/sdk/src/client.ts).
 */
export function ChangeListPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState<string>(ALL_STATES);
  const [showPropose, setShowPropose] = useState(false);
  const [name, setName] = useState("");
  const [targets, setTargets] = useState("");
  const [sourceKind, setSourceKind] = useState("");
  const [correlationKey, setCorrelationKey] = useState("");

  const listQuery = useQuery({
    queryKey: [...changeListKey(), stateFilter],
    queryFn: () =>
      client.changes.list({
        limit: 100,
        state: stateFilter === ALL_STATES ? undefined : (stateFilter as ChangeState)
      })
  });

  const proposeMutation = useMutation({
    mutationFn: () =>
      client.changes.propose({
        name: name.trim(),
        targets: targets
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        sourceKind: sourceKind.trim() || undefined,
        correlationKey: correlationKey.trim() || undefined
      }),
    onSuccess: async (created) => {
      setShowPropose(false);
      setName("");
      setTargets("");
      setSourceKind("");
      setCorrelationKey("");
      await queryClient.invalidateQueries({ queryKey: changeListKey() });
      await navigate({ to: "/changes/$id", params: { id: created.id } });
    }
  });

  function handlePropose(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedName = name.trim();
    const targetList = targets
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (!trimmedName || targetList.length === 0) return;
    proposeMutation.mutate();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Changes</h1>
        <Button onClick={() => setShowPropose(true)} data-testid="propose-change-button">
          Propose Change
        </Button>
      </div>

      <div className="w-56">
        <Select value={stateFilter} onValueChange={(value) => setStateFilter(value)}>
          <SelectTrigger data-testid="change-state-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATES}>All states</SelectItem>
            {CHANGE_STATES.map((state) => (
              <SelectItem key={state} value={state}>
                {state}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {listQuery.isError && (
        <p className="text-sm text-red-600">
          {listQuery.error instanceof Error ? listQuery.error.message : "Failed to load"}
        </p>
      )}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <p className="text-sm text-slate-500" data-testid="empty-state">
          No changes yet.
        </p>
      )}
      {listQuery.data && listQuery.data.items.length > 0 && (
        <Table data-testid="change-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Correlation Key</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listQuery.data.items.map((change) => (
              <TableRow key={change.id} data-testid="change-row">
                <TableCell>
                  <Link
                    to="/changes/$id"
                    params={{ id: change.id }}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {change.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <StateBadge state={change.state} />
                </TableCell>
                <TableCell className="text-slate-600">{change.sourceKind ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs text-slate-500">
                  {change.correlationKey ?? "—"}
                </TableCell>
                <TableCell>{new Date(change.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={showPropose} onOpenChange={setShowPropose}>
        <DialogContent data-testid="propose-change-dialog">
          <DialogHeader>
            <DialogTitle>Propose Change</DialogTitle>
            <DialogDescription>
              Targets are the objects (usually services/components/deployment targets) this change
              acts on — the plan compiler derives wave order from their dependencies.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={handlePropose}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="change-name" className="text-sm font-medium text-slate-700">
                Name
              </label>
              <Input
                id="change-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="change-name-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="change-targets" className="text-sm font-medium text-slate-700">
                Targets (comma-separated id or URN)
              </label>
              <Input
                id="change-targets"
                value={targets}
                onChange={(e) => setTargets(e.target.value)}
                required
                data-testid="change-targets-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="change-source-kind" className="text-sm font-medium text-slate-700">
                Source kind (optional)
              </label>
              <Input
                id="change-source-kind"
                value={sourceKind}
                onChange={(e) => setSourceKind(e.target.value)}
                data-testid="change-source-kind-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="change-correlation-key"
                className="text-sm font-medium text-slate-700"
              >
                Correlation key (optional)
              </label>
              <Input
                id="change-correlation-key"
                value={correlationKey}
                onChange={(e) => setCorrelationKey(e.target.value)}
                data-testid="change-correlation-key-input"
              />
            </div>
            {proposeMutation.isError && (
              <p className="text-sm text-red-600">
                {proposeMutation.error instanceof Error
                  ? proposeMutation.error.message
                  : "Failed to propose change"}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowPropose(false)}
                data-testid="propose-change-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={proposeMutation.isPending}
                data-testid="propose-change-submit"
              >
                {proposeMutation.isPending ? "Proposing…" : "Propose"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

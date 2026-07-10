import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// M5 types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts only re-exports M2/M3-era wire
// types; it never added a Campaign/Initiative re-export block. Importing @scp/schemas directly
// here is within bounds (eslint.config.mjs's own restricted-imports rule: "apps/web/src may
// import only @scp/sdk and @scp/schemas"), matching how change-detail.tsx already does the same
// thing for M4's ApprovalRequest.
import type { CampaignStatus } from "@scp/schemas";
import { client } from "../lib/client";
import { campaignListKey } from "../lib/query-client";
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

/** Campaign `status` -> Badge variant (badge.tsx) — shared with campaign-detail.tsx's header
 *  badge and initiative-detail.tsx's per-member-campaign badges (CampaignStatus is also reused
 *  as InitiativeRollupResponse's `rollupStatus` type, DESIGN §9.5). */
export function campaignStatusBadgeVariant(status: CampaignStatus): BadgeProps["variant"] {
  switch (status) {
    case "proposed":
      return "outline";
    case "active":
      return "info";
    case "completed":
      return "success";
    case "blocked":
    case "failed":
      return "destructive";
    case "partially_rolled_back":
    case "rolled_back":
      return "secondary";
    default:
      return "secondary";
  }
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }): React.JSX.Element {
  return (
    <Badge variant={campaignStatusBadgeVariant(status)} data-testid="campaign-status-badge">
      {status}
    </Badge>
  );
}

/**
 * `/campaigns` (BUILD_AND_TEST.md §8 M5 UI requirement: "campaign board") — every Campaign in
 * the org, plus a "Create Campaign" dialog wrapping `client.campaigns.propose`
 * (packages/sdk/src/client.ts).
 */
export function CampaignListPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showPropose, setShowPropose] = useState(false);
  const [name, setName] = useState("");
  const [targets, setTargets] = useState("");
  const [topology, setTopology] = useState("");
  const [description, setDescription] = useState("");

  const listQuery = useQuery({
    queryKey: campaignListKey(),
    queryFn: () => client.campaigns.list({ limit: 100 })
  });

  const proposeMutation = useMutation({
    mutationFn: () =>
      client.campaigns.propose({
        name: name.trim(),
        targets: targets
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        topology: topology.trim() || undefined,
        description: description.trim() || undefined
      }),
    onSuccess: async (created) => {
      setShowPropose(false);
      setName("");
      setTargets("");
      setTopology("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: campaignListKey() });
      await navigate({ to: "/campaigns/$id", params: { id: created.id } });
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
        <h1 className="text-2xl font-semibold text-slate-900">Campaigns</h1>
        <Button onClick={() => setShowPropose(true)} data-testid="propose-campaign-button">
          Create Campaign
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
          No campaigns yet.
        </p>
      )}
      {listQuery.data && listQuery.data.items.length > 0 && (
        <Table data-testid="campaign-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Targets</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listQuery.data.items.map((campaign) => (
              <TableRow key={campaign.id} data-testid="campaign-row">
                <TableCell>
                  <Link
                    to="/campaigns/$id"
                    params={{ id: campaign.id }}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {campaign.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <CampaignStatusBadge status={campaign.status} />
                </TableCell>
                <TableCell className="text-slate-600">{campaign.targets.length}</TableCell>
                <TableCell>{new Date(campaign.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={showPropose} onOpenChange={setShowPropose}>
        <DialogContent data-testid="propose-campaign-dialog">
          <DialogHeader>
            <DialogTitle>Create Campaign</DialogTitle>
            <DialogDescription>
              Targets are the objects this campaign coordinates change across — the plan compiler
              derives wave order from the release topology (if given) or the targets' own
              dependencies.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={handlePropose}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="campaign-name" className="text-sm font-medium text-slate-700">
                Name
              </label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="campaign-name-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="campaign-targets" className="text-sm font-medium text-slate-700">
                Targets (comma-separated id or URN)
              </label>
              <Input
                id="campaign-targets"
                value={targets}
                onChange={(e) => setTargets(e.target.value)}
                required
                data-testid="campaign-targets-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="campaign-topology" className="text-sm font-medium text-slate-700">
                Topology (optional, id or URN)
              </label>
              <Input
                id="campaign-topology"
                value={topology}
                onChange={(e) => setTopology(e.target.value)}
                data-testid="campaign-topology-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="campaign-description" className="text-sm font-medium text-slate-700">
                Description (optional)
              </label>
              <Input
                id="campaign-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                data-testid="campaign-description-input"
              />
            </div>
            {proposeMutation.isError && (
              <p className="text-sm text-red-600">
                {proposeMutation.error instanceof Error
                  ? proposeMutation.error.message
                  : "Failed to create campaign"}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowPropose(false)}
                data-testid="propose-campaign-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={proposeMutation.isPending}
                data-testid="propose-campaign-submit"
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

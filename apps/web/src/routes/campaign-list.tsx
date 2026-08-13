import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
// M5 types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts only re-exports M2/M3-era wire
// types; it never added a Campaign re-export block. Importing @scp/schemas directly
// here is within bounds (eslint.config.mjs's own restricted-imports rule: "apps/web/src may
// import only @scp/sdk and @scp/schemas"), matching how change-detail.tsx already does the same
// thing for M4's ApprovalRequest.
import type { CampaignStatus } from "@scp/schemas";
import { client } from "../lib/client";
import { campaignListKey } from "../lib/query-client";
import { cn, focusRing } from "../lib/utils";
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
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { SkeletonRows } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";

/** Campaign `status` -> Badge tone (badge.tsx, §1.5) — shared with campaign-detail.tsx's header
 *  badge. */
export function campaignStatusBadgeVariant(status: CampaignStatus): BadgeProps["variant"] {
  switch (status) {
    case "proposed":
      return "neutral";
    case "active":
      return "info";
    case "completed":
      return "success";
    case "blocked":
    case "failed":
      return "danger";
    case "partially_rolled_back":
    case "rolled_back":
      return "neutral";
    default:
      return "neutral";
  }
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }): React.JSX.Element {
  return (
    <Badge variant={campaignStatusBadgeVariant(status)} data-testid="campaign-status-badge">
      {status}
    </Badge>
  );
}

/** A target line that doesn't look like an id or a URN — loose format check only; the real
 *  validation is server-side. Catches obviously-wrong paste noise before the round-trip. */
const ID_OR_URN_LINE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|urn:.+)$/i;

/** Splits a textarea value into non-blank, trimmed lines — one id/URN per line (§4 Group D). */
function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

  const targetLines = useMemo(() => parseLines(targets), [targets]);
  const invalidTargetLines = useMemo(
    () => targetLines.filter((line) => !ID_OR_URN_LINE.test(line)),
    [targetLines]
  );
  const trimmedTopology = topology.trim();
  const topologyInvalid = trimmedTopology.length > 0 && !ID_OR_URN_LINE.test(trimmedTopology);

  const proposeMutation = useMutation({
    mutationFn: () =>
      client.campaigns.propose({
        name: name.trim(),
        targets: targetLines,
        topology: trimmedTopology || undefined,
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
    if (!trimmedName || targetLines.length === 0) return;
    proposeMutation.mutate();
  }

  const newCampaignButton = (
    <Button onClick={() => setShowPropose(true)} data-testid="propose-campaign-button">
      Create Campaign
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Campaigns" actions={newCampaignButton} />

      {listQuery.isLoading && <SkeletonRows n={4} />}
      {listQuery.isError && <QueryErrorNotice error={listQuery.error} what="campaigns" />}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <EmptyState
          icon={Flag}
          message="No campaigns yet."
          action={
            <Button onClick={() => setShowPropose(true)} data-testid="empty-state-propose-campaign">
              New Campaign
            </Button>
          }
          data-testid="empty-state"
        />
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
                <TableCell className="text-xs text-slate-500">
                  {new Date(campaign.createdAt).toLocaleString()}
                </TableCell>
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
          <form className="flex flex-col gap-4" onSubmit={handlePropose}>
            <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                Details
              </legend>
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
            </fieldset>

            <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                Scope
              </legend>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="campaign-targets" className="text-sm font-medium text-slate-700">
                  Targets (one id or URN per line)
                </label>
                <textarea
                  id="campaign-targets"
                  value={targets}
                  onChange={(e) => setTargets(e.target.value)}
                  required
                  rows={4}
                  // No shared Textarea primitive exists yet (ui/README.md) — matches Input's own
                  // classes (§2.12) exactly rather than inventing a second treatment.
                  className={cn(
                    "flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50",
                    focusRing
                  )}
                  data-testid="campaign-targets-input"
                />
                {invalidTargetLines.length > 0 && (
                  <p className="text-xs text-red-600" data-testid="campaign-targets-invalid">
                    Doesn&apos;t look like an id or URN:{" "}
                    {invalidTargetLines.map((line) => `"${line}"`).join(", ")}
                  </p>
                )}
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
                {topologyInvalid && (
                  <p className="text-xs text-red-600" data-testid="campaign-topology-invalid">
                    Doesn&apos;t look like an id or URN: &quot;{trimmedTopology}&quot;
                  </p>
                )}
              </div>
            </fieldset>

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

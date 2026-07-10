import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/client";
import { initiativeDetailKey } from "../lib/query-client";
import { useIdParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
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
import { campaignStatusBadgeVariant } from "./campaign-list";

/**
 * `/initiatives/{id}` (BUILD_AND_TEST.md §8 M5 UI requirement: "initiative roll-up") — one
 * `client.initiatives.get()` call gets the initiative, its member campaigns (each with its own
 * derived `status`), and the traversal-derived `rollupStatus` (DESIGN §9.5, always computed live,
 * never stored). Also includes an "Add Campaign" form wired to `client.initiatives.addCampaign`.
 */
export function InitiativeDetailPage(): React.JSX.Element {
  const id = useIdParam();
  const queryClient = useQueryClient();
  const detailKey = initiativeDetailKey(id ?? "");
  const [campaignInput, setCampaignInput] = useState("");

  const rollupQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => client.initiatives.get(id!),
    enabled: !!id
  });

  const addCampaignMutation = useMutation({
    mutationFn: (campaign: string) => client.initiatives.addCampaign(id!, { campaign }),
    onSuccess: async () => {
      setCampaignInput("");
      await queryClient.invalidateQueries({ queryKey: detailKey });
    }
  });

  function handleAddCampaign(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = campaignInput.trim();
    if (!trimmed) return;
    addCampaignMutation.mutate(trimmed);
  }

  if (!id) {
    return <p className="text-sm text-red-600">Not found.</p>;
  }
  if (rollupQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (rollupQuery.isError || !rollupQuery.data) {
    return (
      <p className="text-sm text-red-600">
        {rollupQuery.error instanceof Error ? rollupQuery.error.message : "Not found"}
      </p>
    );
  }

  const { initiative, campaigns, rollupStatus } = rollupQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-slate-900" data-testid="initiative-name">
            {initiative.name}
          </h1>
          <Badge
            variant={campaignStatusBadgeVariant(rollupStatus)}
            data-testid="initiative-rollup-status-badge"
          >
            {rollupStatus}
          </Badge>
        </div>
        <p className="text-sm text-slate-500">{initiative.description ?? "No description"}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Member campaigns</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {campaigns.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="empty-campaigns">
              No campaigns linked yet.
            </p>
          ) : (
            <Table data-testid="initiative-campaign-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((member) => (
                  <TableRow key={member.campaign.id} data-testid="initiative-campaign-row">
                    <TableCell>
                      <Link
                        to="/campaigns/$id"
                        params={{ id: member.campaign.id }}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {member.campaign.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={campaignStatusBadgeVariant(member.status)}>
                        {member.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <form className="flex items-end gap-2" onSubmit={handleAddCampaign}>
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor="add-campaign-input" className="text-sm font-medium text-slate-700">
                Add campaign (id or URN)
              </label>
              <Input
                id="add-campaign-input"
                value={campaignInput}
                onChange={(e) => setCampaignInput(e.target.value)}
                data-testid="add-campaign-input"
              />
            </div>
            <Button
              type="submit"
              disabled={addCampaignMutation.isPending}
              data-testid="add-campaign-submit"
            >
              {addCampaignMutation.isPending ? "Adding…" : "Add"}
            </Button>
          </form>
          {addCampaignMutation.isError && (
            <p className="text-sm text-red-600" data-testid="add-campaign-error">
              {addCampaignMutation.error instanceof Error
                ? addCampaignMutation.error.message
                : "Failed to add campaign"}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "../lib/client";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";

const patsKey = ["pats"];

/** `/pats` (BUILD_AND_TEST.md §8 M2 item 2, stage 2's PAT API) — list/create/revoke. */
export function PatsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const listQuery = useQuery({
    queryKey: patsKey,
    queryFn: () => client.pats.list()
  });

  const createMutation = useMutation({
    mutationFn: (input: { name: string }) => client.pats.create(input.name),
    onSuccess: async (created) => {
      setCreatedToken(created.token);
      setCopied(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: patsKey });
    }
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => client.pats.revoke(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: patsKey });
    }
  });

  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate({ name: trimmed });
  }

  async function handleCopy(): Promise<void> {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
    } catch {
      // Clipboard API can be unavailable (permissions/insecure context) — the token stays
      // selectable in the dialog regardless, so this is a soft failure, not an error state.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Personal Access Tokens</h1>
        <p className="text-sm text-slate-500">
          Use a PAT as a bearer token for the CLI or API when a browser session isn&apos;t
          available.
        </p>
      </div>

      <form
        className="flex items-end gap-2 rounded-lg border border-slate-200 bg-white p-4"
        onSubmit={handleCreate}
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="pat-name" className="text-sm font-medium text-slate-700">
            Name
          </label>
          <Input
            id="pat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="pat-name-input"
          />
        </div>
        <Button type="submit" disabled={createMutation.isPending} data-testid="pat-create-submit">
          {createMutation.isPending ? "Creating…" : "Create token"}
        </Button>
      </form>

      {listQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {listQuery.data && listQuery.data.items.length === 0 && (
        <p className="text-sm text-slate-500">No tokens yet.</p>
      )}
      {listQuery.data && listQuery.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead aria-label="actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listQuery.data.items.map((pat) => (
              <TableRow key={pat.id}>
                <TableCell>{pat.name}</TableCell>
                <TableCell>{new Date(pat.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  {pat.revokedAt ? (
                    <Badge variant="destructive">Revoked</Badge>
                  ) : (
                    <Badge variant="secondary">Active</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {!pat.revokedAt && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(pat.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={createdToken !== null} onOpenChange={(open) => !open && setCreatedToken(null)}>
        <DialogContent data-testid="pat-token-dialog">
          <DialogHeader>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription>Copy this token now — it will not be shown again.</DialogDescription>
          </DialogHeader>
          <div
            className="break-all rounded bg-slate-50 p-3 font-mono text-xs"
            data-testid="pat-token-value"
          >
            {createdToken}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => void handleCopy()}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button onClick={() => setCreatedToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

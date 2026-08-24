import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { client } from "../lib/client";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { PageHeader } from "../components/ui/page-header";
import { KeyValueList } from "../components/ui/key-value-list";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { federationSelfKey, federationStatusKey } from "../lib/query-client";
import { roleBadge } from "./outposts";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { QueryErrorNotice } from "../components/query-error";
import { ObservationScopeNote } from "./outposts";

function formatDateTime(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function transferStatusBadge(status: string): React.JSX.Element {
  const variant = status === "confirmed" ? "success" : status === "submitted" ? "info" : "neutral";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

/**
 * `/federation` — read-only federation status view (BUILD_AND_TEST.md §8 M6 item 7, "commander
 * federation status UI"; DESIGN.md §13). Consumes ONLY `client.federation.status()`/`.self()`
 * (the generated SDK, per CLAUDE.md's API -> SDK -> CLI/IaC -> UI parity principle) — the exact
 * same endpoints `scp federation status`/`scp federation self` call. Deliberately read-only:
 * pairing, export, import, hand-fill, and overlay authoring all involve carrying a real bundle
 * file (or an out-of-band public-key exchange for air-gapped peers) across a gap this browser
 * tab has no access to, so those stay CLI-only workflows (DESIGN §13) — this page is "what does
 * federation look like right now," not "drive a sync from the browser."
 *
 * Per FederationStatusResponseSchema's own doc comment (packages/schemas/src/federation.ts):
 * `lastSyncedAt` reflects this domain's own last-applied cursor, never a live probe of the peer
 * (air-gapped peers may not be reachable at all) — every timestamp below is labeled "as of", not
 * "live."
 *
 * EVERY QUERY HERE HAS THREE STATES, NOT TWO (ADR-0023). Since the SDK validates responses, a body
 * that does not match the contract REJECTS the `queryFn` — so `isError` is now a reachable state
 * for a 200 response, not only for a 4xx/5xx or a dead network. A page that branches only on
 * `isLoading` and `data` renders an EMPTY card for exactly the fault the boundary exists to
 * report, which is how the diagnosis dies in the query cache instead of reaching an operator. Both
 * cards below therefore render `QueryErrorNotice`, which prints the operation and the offending
 * field verbatim.
 */
export function FederationStatusPage(): React.JSX.Element {
  const selfQuery = useQuery({
    queryKey: federationSelfKey(),
    queryFn: () => client.federation.self()
  });

  const statusQuery = useQuery({
    queryKey: federationStatusKey(),
    queryFn: () => client.federation.status()
  });

  // `GET /federation/self` always succeeds — `ensureFederationSelf` (federation/self-repo.ts)
  // lazily provisions a domain identity with role "unset" the very first time anything reads it,
  // well before an operator necessarily runs `scp federation init` (DESIGN §13: "every row is
  // born federation-ready"). "unset" is the actual not-yet-opted-in signal, not a missing
  // response.
  const notInitialized = selfQuery.data?.role === "unset";

  // `?? []` — the LAST unguarded consumer of `FederationStatusResponse.peers` (Z5). `peers` is
  // required-not-optional, and BEFORE ADR-0023 the SDK validated no response, so a body without the
  // key resolved the query and `statusQuery.data && data.peers.length` threw. The SDK now REJECTS
  // that body at the boundary, so this guard is no longer what stands between the page and a
  // white screen — the `isError` branch below is. It stays anyway: it is the correct reading of a
  // body this component is handed by any other route (a test double, a future cached snapshot),
  // and defence in depth against a shape the contract does not yet forbid costs one operator.
  // `peersLoaded` keeps the loaded-vs-loading distinction the two branches below need, which a bare
  // `?? []` would have collapsed into "no peers paired yet" while still fetching.
  const peers = statusQuery.data?.peers ?? [];
  const peersLoaded = statusQuery.data !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Federation status"
        description="Snapshot as of this domain's last sync — not a live probe."
        meta={
          <span
            className="inline-flex items-center gap-1 text-xs text-slate-500"
            title={
              "Every figure below is this domain's own last-applied journal cursor, never a live " +
              "probe of a peer — federated peers, especially air-gapped ones, may not be reachable " +
              "at all."
            }
          >
            <Info className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
          </span>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>This domain</CardTitle>
          <CardDescription>
            Exchanged with peers out-of-band (`scp federation self` / `scp federation pair`) — this
            browser never dials another domain directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Literal "Loading…" text, not a Skeleton — `federation-status-crash.test.tsx`'s render
              helper polls the HTML for this exact string to know when React Query has settled. */}
          {selfQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {selfQuery.isError && (
            <QueryErrorNotice
              error={selfQuery.error}
              what="this domain's federation identity"
              testId="federation-self-error"
            />
          )}
          {notInitialized && <FederationInitForm />}
          {selfQuery.data && (
            <KeyValueList
              columns={2}
              items={[
                { label: "Name", value: selfQuery.data.name },
                { label: "Role", value: roleBadge(selfQuery.data.role) },
                { label: "Domain ID", value: selfQuery.data.domainId, mono: true },
                { label: "Public key", value: selfQuery.data.publicKey, mono: true }
              ]}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Peers</CardTitle>
          <CardDescription>
            <ObservationScopeNote />
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {statusQuery.isError && (
            <QueryErrorNotice
              error={statusQuery.error}
              what="federation status"
              testId="federation-status-error"
            />
          )}
          {peersLoaded && peers.length === 0 && (
            <p className="text-sm text-slate-500">
              No peers paired yet. Run{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5">scp federation pair</code>.
            </p>
          )}
          {peersLoaded && peers.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Peer</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Last applied sequence</TableHead>
                  <TableHead>Last synced</TableHead>
                  <TableHead>Recent transfers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {peers.map(({ peer, lastAppliedSequence, lastSyncedAt, recentTransfers }) => (
                  <TableRow key={peer.id} data-testid={`federation-peer-${peer.id}`}>
                    <TableCell>
                      <div className="font-medium text-slate-900">{peer.name}</div>
                      <div className="font-mono text-xs text-slate-500">{peer.id}</div>
                    </TableCell>
                    <TableCell>{roleBadge(peer.role)}</TableCell>
                    <TableCell>{lastAppliedSequence ?? "—"}</TableCell>
                    <TableCell>{formatDateTime(lastSyncedAt)}</TableCell>
                    <TableCell>
                      {/* `?? []` — the THIRD site of the identical defect, off the identical
                            `client.federation.status()` call already guarded at `outposts.tsx`
                            and `outpost-detail.tsx`. `recentTransfers` is required-not-optional by
                            `FederationPeerStatusSchema`, and BEFORE ADR-0023 the generated SDK
                            validated NO response at runtime, so one peer whose key the server
                            omitted threw `TypeError: Cannot read properties of undefined (reading
                            'length')` out of `.map` — and because that throw escapes the whole
                            page body, MEASURED `container.innerHTML.length === 0`: `/federation`
                            painted NOTHING, including the rows of every well-formed peer.
                            SINCE ADR-0023 the SDK REJECTS that body at the boundary, so this page
                            never receives it from `client.federation.status()` — the `isError`
                            branch above renders the operation and the field instead. The guard
                            stays as the honest reading of an empty ledger ("none") for any other
                            source of this value, and as one less thing to get right if the
                            contract ever makes the key optional. */}
                      {(recentTransfers ?? []).length === 0 && (
                        <span className="text-sm text-slate-400">none</span>
                      )}
                      {(recentTransfers ?? []).length > 0 && (
                        <div className="flex flex-col gap-1">
                          {(recentTransfers ?? []).slice(0, 5).map((transfer) => (
                            <div key={transfer.id} className="flex items-center gap-1.5 text-xs">
                              <Badge variant="neutral" className="capitalize">
                                {transfer.direction}
                              </Badge>
                              <span className="text-slate-500">{transfer.kind}</span>
                              {transferStatusBadge(transfer.status)}
                              <span className="text-slate-400">
                                {formatDateTime(transfer.createdAt)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The one write surface this page owns: `POST /federation/init` — the commander-config gap the
 * owner flagged (2026-08-11). Everything else about "the commander's own config" deliberately
 * lives elsewhere: per-outpost config is authored on each outpost's detail page and syncs down as
 * commander-origin data, and instance-level operator settings (scan floors, tokens) are
 * deployment env — not a tenant surface. The federation IDENTITY is the one self-config fact in
 * the graph, it is set exactly once, and API-first parity (charter principle 3) says the UI must
 * be able to do what `scp federation init` does.
 *
 * Once initialized the identity renders read-only above — the API exposes no rename/re-role, and
 * offering an edit the server would refuse is the "UI offers writes the server 403s" defect class
 * (M16.3) this repo already paid for once.
 */
function FederationInitForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"commander" | "outpost" | "retrans">("commander");
  const initMutation = useMutation({
    mutationFn: () => client.federation.init({ name: name.trim(), role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: federationSelfKey() });
      await queryClient.invalidateQueries({ queryKey: federationStatusKey() });
    }
  });

  return (
    <div className="flex flex-col gap-3" data-testid="federation-not-initialized">
      <p className="text-sm text-slate-500">
        This domain has no federation identity yet. Initializing names it and declares its role —
        done once, before any pairing.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length > 0) initMutation.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="federation-init-name" className="text-xs font-medium text-slate-600">
            Domain name
          </label>
          <Input
            id="federation-init-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="hq-commander"
            className="w-56"
            data-testid="federation-init-name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="federation-init-role" className="text-xs font-medium text-slate-600">
            Role
          </label>
          {/* Native select, deliberately: three fixed options and the ui Select is a heavier
              Radix surface than this one-shot form warrants. */}
          <select
            id="federation-init-role"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
            data-testid="federation-init-role"
          >
            <option value="commander">commander</option>
            <option value="outpost">outpost</option>
            <option value="retrans">retrans</option>
          </select>
        </div>
        <Button type="submit" disabled={name.trim().length === 0 || initMutation.isPending}>
          Initialize
        </Button>
      </form>
      {/* API-first parity (charter principle 3) is why `retrans` stays a real choice here — this
          form does not shrink the API's own role enum. But a real DEPLOYMENT running as a retrans
          never serves this UI at all: `app.ts` gates SPA registration on
          `federationRole !== "retrans"` (`SCP_FEDERATION_ROLE`, the M16.3 P3 owner decision —
          `retrans-no-spa.integration.test.ts`), so an operator who actually reaches this page is, by
          construction, not on that deployment. Naming that here — only while `retrans` is the
          selection under consideration — keeps the choice honest without removing it. */}
      {role === "retrans" && (
        <p className="text-xs text-slate-500" data-testid="federation-init-retrans-hint">
          A <code>retrans</code> deployment withholds this UI entirely (
          <code>SCP_FEDERATION_ROLE=retrans</code>); its relay work is driven via CLI/API.
          Initializing an org as retrans here is for API-parity and development use.
        </p>
      )}
      {initMutation.isError && (
        <Notice tone="danger">
          {initMutation.error instanceof Error
            ? initMutation.error.message
            : "Initialization failed"}
        </Notice>
      )}
      <p className="text-xs text-slate-500">
        Also available as{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5">scp federation init</code>.
      </p>
    </div>
  );
}

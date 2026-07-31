import { useQuery } from "@tanstack/react-query";
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
import { federationSelfKey, federationStatusKey } from "../lib/query-client";
import { QueryErrorNotice } from "../components/query-error";

function formatDateTime(value: string | null): string {
  if (!value) return "never";
  return new Date(value).toLocaleString();
}

function roleBadge(role: string): React.JSX.Element {
  // "commander" (the single coordinating instance, DESIGN §13) gets the highlighted variant;
  // "outpost", "retrans", and "unset" all render as the same plain badge — this page doesn't
  // (yet) treat retrans as visually distinct, matching its minimal, not-yet-built-out semantics
  // (ADR-0004).
  return (
    <Badge variant={role === "commander" ? "info" : "secondary"} className="capitalize">
      {role}
    </Badge>
  );
}

function transferStatusBadge(status: string): React.JSX.Element {
  const variant = status === "confirmed" ? "success" : status === "submitted" ? "info" : "outline";
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
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Federation</h1>
        <p className="text-sm text-slate-500">
          This domain&apos;s identity and its sync status with every paired peer. All figures are as
          of this domain&apos;s own last-applied journal cursor, never a live probe of a peer
          (DESIGN §13) — federated peers, especially air-gapped ones, may not be reachable at all.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>This domain</CardTitle>
          <CardDescription>
            Exchanged with peers out-of-band (`scp federation self` / `scp federation pair`) — this
            browser never dials another domain directly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {selfQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {selfQuery.isError && (
            <QueryErrorNotice
              error={selfQuery.error}
              what="this domain's federation identity"
              testId="federation-self-error"
            />
          )}
          {notInitialized && (
            <p className="text-sm text-slate-500" data-testid="federation-not-initialized">
              This domain has not been initialized for federation yet. Run{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5">scp federation init</code>.
            </p>
          )}
          {selfQuery.data && (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</dt>
                <dd className="text-sm text-slate-900">{selfQuery.data.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Role</dt>
                <dd className="text-sm">{roleBadge(selfQuery.data.role)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Domain ID
                </dt>
                <dd className="font-mono text-xs text-slate-700">{selfQuery.data.domainId}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Public key
                </dt>
                <dd
                  className="truncate font-mono text-xs text-slate-700"
                  title={selfQuery.data.publicKey}
                >
                  {selfQuery.data.publicKey}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Peers</CardTitle>
          <CardDescription>
            Sync freshness and recent bundle transfers per paired domain.
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
                              <Badge variant="outline" className="capitalize">
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

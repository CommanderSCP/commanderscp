import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CreateObjectRequest, DiscoveryProposal, GraphObject } from "@scp/schemas";
import { client } from "../lib/client";
import { Badge } from "../components/ui/badge";
import { ScaffoldPanel } from "../components/scaffold/scaffold-panel";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";

/** `/connect/argocd` — the M19.1 "Connect Argo CD" wizard. See docs/web.md §320. */

/** The discovery module registered for Argo CD (`KNOWN_DISCOVERY_MODULES`, plugin P3). */
export const ARGOCD_DISCOVERY_MODULE = "argocd-discovery";

/** `scp connect argocd`'s `--token-key` default, kept identical so the CLI and the UI land the same
 *  secret in the same place for the same Argo CD. */
export function defaultTokenKey(name: string): string {
  return `${name.trim() || "argocd"}-argocd-token`;
}

/** The CLI's `opts.url.replace(/\/+$/, "")` — a trailing slash would produce `…//api/v1/applications`
 *  and, worse, two execution systems for one server that differ only by it. */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface ConnectDraft {
  name: string;
  serverUrl: string;
  token: string;
  tokenKey: string;
  allowInternalEgress: boolean;
}

export function emptyDraft(): ConnectDraft {
  return { name: "argocd", serverUrl: "", token: "", tokenKey: "", allowInternalEgress: false };
}

/** The subset of the SDK this wizard may touch, structurally. See docs/web.md §321. */
export interface ConnectDoors {
  putSecret(key: string, value: string): Promise<unknown>;
  createExecutionSystem(req: CreateObjectRequest): Promise<GraphObject>;
  listExecutionSystems(): Promise<GraphObject[]>;
  runDiscovery(executionSystemId: string, instanceId: string): Promise<DiscoveryProposal>;
}

export const sdkDoors: ConnectDoors = {
  putSecret: (key, value) => client.secrets.put(key, { value }),
  createExecutionSystem: (req) => client.object("execution-system").create(req),
  listExecutionSystems: async () => (await client.object("execution-system").list()).items,
  runDiscovery: (executionSystemId, instanceId) =>
    client.discovery.run({
      pluginModule: ARGOCD_DISCOVERY_MODULE,
      pluginInstanceId: instanceId,
      // ONLY the system id. See docs/web.md §322.
      config: { executionSystemId }
    })
};

/** STEP 1, as one function. See docs/web.md §323. */
export async function registerExecutionSystem(
  doors: ConnectDoors,
  draft: ConnectDraft
): Promise<GraphObject> {
  const name = draft.name.trim();
  const serverUrl = normalizeServerUrl(draft.serverUrl);
  const tokenKey = draft.tokenKey.trim() || defaultTokenKey(name);

  await doors.putSecret(tokenKey, draft.token);

  return doors.createExecutionSystem({
    name,
    properties: {
      kind: "argocd",
      serverUrl,
      tokenSecretKey: tokenKey,
      // Omitted rather than written `false`, exactly as the CLI does: an absent property and a
      // declared-false one mean the same thing to `resolveInternalEgress`, and writing the negative
      // makes an untouched checkbox look like a decision someone made.
      ...(draft.allowInternalEgress ? { allowInternalEgress: true } : {})
    }
  });
}

/** A failed write, shown verbatim. `queryErrorMessage` is where the SDK put the operation, the
 *  status and an RFC 9457 problem's `detail` — a fixed string here would hide the one thing that
 *  tells an operator whether they hit a 403, a bad URL or a blocked egress. */
function ErrorNotice({ error, testId }: { error: unknown; testId: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      data-testid={testId}
      className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      {queryErrorMessage(error)}
    </p>
  );
}

export function RegisterStep({
  doors,
  existing,
  onRegistered
}: {
  doors: ConnectDoors;
  /** Already-registered `execution-system` objects, offered so a run that failed at step 2 can be
   *  resumed instead of minting a second system for the same server (and orphaning the first). */
  existing: GraphObject[];
  onRegistered: (system: GraphObject) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<ConnectDraft>(emptyDraft);

  const register = useMutation({
    // NO ARGUMENT, on purpose. `mutate(vars)` retains `vars` in the mutation cache for the life of
    // the observer; passing the token there would park the credential in exactly the kind of store
    // this wizard must keep it out of. The closure reads it and nothing keeps it afterwards.
    mutationFn: async (): Promise<GraphObject> => registerExecutionSystem(doors, draft),
    onSuccess: (system) => {
      // The credential's whole life in this tab ends here.
      setDraft((prev) => ({ ...prev, token: "" }));
      onRegistered(system);
    }
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    register.mutate();
  }

  const tokenKeyPreview = draft.tokenKey.trim() || defaultTokenKey(draft.name);

  return (
    <Card data-testid="connect-argocd-register">
      <CardHeader>
        <CardTitle className="text-base">1. Register your Argo CD</CardTitle>
        <CardDescription>
          Stores the API token in SCP&apos;s write-only secrets store and creates the{" "}
          <code className="font-mono">execution-system</code> object that references it. Equivalent
          to <code className="font-mono">scp connect argocd</code>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {existing.length > 0 && (
          <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">
              Or continue with an Argo CD you already registered
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {existing.map((system) => (
                <Button
                  key={system.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="connect-argocd-existing"
                  onClick={() => onRegistered(system)}
                >
                  {system.name}
                </Button>
              ))}
            </div>
          </div>
        )}

        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="argocd-name" className="text-sm font-medium text-slate-700">
              Name
            </label>
            <Input
              id="argocd-name"
              data-testid="argocd-name-input"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
            <p className="text-xs text-slate-500">
              Names the execution-system object, e.g. <code className="font-mono">prod</code>.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="argocd-url" className="text-sm font-medium text-slate-700">
              Argo CD API server URL
            </label>
            <Input
              id="argocd-url"
              data-testid="argocd-url-input"
              value={draft.serverUrl}
              onChange={(e) => setDraft((prev) => ({ ...prev, serverUrl: e.target.value }))}
              placeholder="https://argocd.example.com"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="argocd-token" className="text-sm font-medium text-slate-700">
              Argo CD API token
            </label>
            <Input
              id="argocd-token"
              data-testid="argocd-token-input"
              type="password"
              autoComplete="off"
              value={draft.token}
              onChange={(e) => setDraft((prev) => ({ ...prev, token: e.target.value }))}
              required
            />
            <p className="text-xs text-slate-500">
              A token scoped by your own Argo CD RBAC. SCP stores it write-only under{" "}
              <code className="font-mono">{tokenKeyPreview}</code> and can never read it back — not
              here, not through the API. SCP never asks for your cluster credentials.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="argocd-token-key" className="text-sm font-medium text-slate-700">
              Secret key (optional)
            </label>
            <Input
              id="argocd-token-key"
              data-testid="argocd-token-key-input"
              value={draft.tokenKey}
              onChange={(e) => setDraft((prev) => ({ ...prev, tokenKey: e.target.value }))}
              placeholder={defaultTokenKey(draft.name)}
            />
          </div>

          {/* HAZARD 1. Presented as a declaration with its boundary named, never as a grant. */}
          <div className="rounded border border-amber-300 bg-amber-50 p-3">
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                data-testid="argocd-internal-egress-checkbox"
                className="mt-0.5"
                checked={draft.allowInternalEgress}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, allowInternalEgress: e.target.checked }))
                }
              />
              <span>
                <span className="font-medium">
                  This Argo CD is reachable only at a private / in-cluster address
                </span>
                <span className="mt-1 block text-xs text-slate-700">
                  Tick this for an in-cluster Argo CD such as{" "}
                  <code className="font-mono">http://argocd-server.argocd.svc</code>. SCP refuses
                  plugin egress to private addresses by default. This is a{" "}
                  <strong>declaration, not a grant</strong>: your operator must also list this host
                  in <code className="font-mono">SCP_INTERNAL_EGRESS_HOSTS</code>, or egress stays
                  blocked and step 2 below will fail (ADR-0003).
                </span>
              </span>
            </label>
          </div>

          {register.isError && (
            <ErrorNotice error={register.error} testId="argocd-register-error" />
          )}

          <div>
            <Button
              type="submit"
              disabled={register.isPending}
              data-testid="argocd-register-submit"
            >
              {register.isPending ? "Registering…" : "Register and continue"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Step 2 — enumerate (and the only real connectivity check there is)

/** One row per proposed object type, so the review screen describes the proposal it actually got. */
export function proposalTypeCounts(proposal: DiscoveryProposal): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const object of proposal.objects)
    counts.set(object.typeId, (counts.get(object.typeId) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function EnumerateStep({
  doors,
  system,
  onProposal,
  onBack
}: {
  doors: ConnectDoors;
  system: GraphObject;
  onProposal: (proposal: DiscoveryProposal) => void;
  onBack: () => void;
}): React.JSX.Element {
  const enumerate = useMutation({
    mutationFn: async (): Promise<DiscoveryProposal> => doors.runDiscovery(system.id, system.name),
    onSuccess: onProposal
  });

  return (
    <Card data-testid="connect-argocd-enumerate">
      <CardHeader>
        <CardTitle className="text-base">2. Enumerate its Applications</CardTitle>
        <CardDescription>
          Runs <code className="font-mono">{ARGOCD_DISCOVERY_MODULE}</code> against{" "}
          <span data-testid="argocd-system-name">{system.name}</span> and returns a{" "}
          <strong>proposal only</strong> — nothing is written to the graph by this wizard at all;
          step 3 turns it into IaC you commit. This call is also the connectivity check: it runs on
          the server, through SCP&apos;s egress guard, with the token you just stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {enumerate.isError && (
          <>
            <ErrorNotice error={enumerate.error} testId="argocd-enumerate-error" />
            <p className="text-xs text-slate-600" data-testid="argocd-enumerate-error-help">
              The execution-system <span className="font-mono">{system.name}</span> is registered
              and was kept — fix the URL, token or egress allowlist and run this step again. A
              private address also needs the host in{" "}
              <code className="font-mono">SCP_INTERNAL_EGRESS_HOSTS</code>.
            </p>
          </>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={enumerate.isPending}
            onClick={() => enumerate.mutate()}
            data-testid="argocd-enumerate-submit"
          >
            {enumerate.isPending ? "Enumerating…" : "Enumerate Applications"}
          </Button>
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ReviewStep({ proposal }: { proposal: DiscoveryProposal }): React.JSX.Element {
  // This step used to import everything, and what replaced it. See docs/web.md §324.
  return (
    <Card data-testid="connect-argocd-review">
      <CardHeader>
        <CardTitle className="text-base">3. Review and scaffold</CardTitle>
        <CardDescription>
          Nothing below exists in the graph, and this step does not create it. Group the components
          into services and commit the IaC.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" data-testid="argocd-proposal-counts">
          {proposalTypeCounts(proposal).map(([typeId, count]) => (
            <Badge key={typeId} variant="info">
              {count} {typeId}
            </Badge>
          ))}
        </div>
        <ScaffoldPanel proposal={proposal} testIdPrefix="argocd-scaffold" />
      </CardContent>
    </Card>
  );
}

// The result — hazard 3 lives here

// `ImportSummary` IS GONE WITH THE WRITE IT SUMMARISED. See docs/web.md §325.

/** The registered execution systems this wizard is about — unchanged, and restored here because it
 *  sat inside the block `ImportSummary` occupied. */
export function argoCdSystems(systems: GraphObject[] | undefined): GraphObject[] {
  return (systems ?? []).filter(
    (system) => (system.properties as { kind?: unknown } | undefined)?.kind === "argocd"
  );
}

export function ConnectArgoCdPage(): React.JSX.Element {
  const [system, setSystem] = useState<GraphObject | null>(null);
  const [proposal, setProposal] = useState<DiscoveryProposal | null>(null);

  const systemsQuery = useQuery({
    queryKey: ["execution-systems"],
    queryFn: () => sdkDoors.listExecutionSystems()
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Connect Argo CD</h1>
        <p className="text-sm text-slate-500">
          Point CommanderSCP at an Argo CD you already run, and import its Applications as
          components SCP coordinates. SCP holds a scoped API token to your Argo CD — never your
          cluster credentials, and it never deploys anything itself.
        </p>
      </div>

      {/* The resume list is a convenience, so a failed read must not block the wizard — but it must
          not be INVISIBLE either (ADR-0023's other half: a rejected query becomes a state, and a
          page that renders only `data` renders nothing for it). Registering afresh still works. */}
      {systemsQuery.isError && (
        <QueryErrorNotice
          error={systemsQuery.error}
          what="the execution systems already registered"
          testId="connect-argocd-systems-error"
        />
      )}

      {proposal !== null ? (
        <ReviewStep proposal={proposal} />
      ) : system !== null ? (
        <EnumerateStep
          doors={sdkDoors}
          system={system}
          onProposal={setProposal}
          onBack={() => setSystem(null)}
        />
      ) : (
        <RegisterStep
          doors={sdkDoors}
          existing={argoCdSystems(systemsQuery.data)}
          onRegistered={setSystem}
        />
      )}
    </div>
  );
}

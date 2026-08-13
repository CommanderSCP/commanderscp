import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  AcceptDiscoveryResponse,
  CreateObjectRequest,
  DiscoveryProposal,
  GraphObject
} from "@scp/schemas";
import { client } from "../lib/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";

/**
 * `/connect/argocd` — the M19.1 "Connect Argo CD" wizard (P5 of
 * `docs/proposals/import-existing-executors.md`; ADR-0002 Mode A "point SCP at the execution system
 * I already run").
 *
 * WHY IT EXISTS. P1–P4 shipped the entire backend in July, and `scp connect argocd` wraps the flow —
 * so the single thing a fresh install most needs to do first is reachable only from a shell, with a
 * PAT and three commands. This is the same flow with a form in front of it.
 *
 * IT IS UI-ONLY, DELIBERATELY. Every step already has a public door: `secrets` → the generic
 * `object("execution-system").create` → `discovery.run` → `discovery.accept`. No API change, no
 * migration, no `pnpm gen`, no oasdiff exposure. `scp connect argocd`
 * (`packages/cli/src/cli.ts`, `connectCmd`) is the reference implementation and this mirrors its real
 * flags — `--url`, `--token`, `--name`, `--token-key`, `--allow-internal-egress` — rather than
 * inventing a second shape for the same act.
 *
 * =============================================================================================
 * THE THREE THINGS THIS FILE EXISTS TO GET RIGHT
 * =============================================================================================
 *
 * 1. THE IN-CLUSTER CASE IS THE FIRST CASE, NOT THE EDGE CASE. SCP's SSRF guard refuses private
 *    addresses, so a wizard with no internal-egress control fails for the most likely first user —
 *    an Argo CD at `http://argocd-server.argocd.svc`. The checkbox below writes the execution
 *    system's `allowInternalEgress` property and is labelled as what ADR-0003 says it is: a
 *    DECLARATION, not a grant. The operator's `SCP_INTERNAL_EGRESS_HOSTS` allowlist is the boundary;
 *    without the host in it the declaration buys nothing, and saying otherwise would teach an
 *    operator to expect a grant they did not make. Never a silent default.
 *
 * 2. IT COLLECTS A CREDENTIAL, AND THE CREDENTIAL LEAVES BY EXACTLY ONE DOOR. The Argo CD API token
 *    reaches `secrets.put` and nothing else — never a query cache, never a URL or search param,
 *    never router state, never a retained mutation `variables` (which is why every mutation here
 *    takes NO argument and closes over its input instead), never a log line, and cleared from
 *    component state the moment the write succeeds. `secrets` is write-only by contract, so the
 *    wizard cannot read it back and does not try. Charter credential asymmetry is unchanged: a
 *    scoped API token TO the operator's Argo CD, never that cluster's own credentials.
 *
 * 3. AN IMPORTED COMPONENT IS A GRAPH ORPHAN, AND THE LAST SCREEN SAYS SO. `discovery accept`
 *    creates components, executor bindings and `source_mappings` — and NO relationships:
 *    `coordinated_by` was never a registered relationship type and the argocd plugin returns
 *    `relationships: []` (the 2026-07-15 correction in the proposal's §3; measured live at 50 apps →
 *    50 components → 0 relationships). `ImportSummary` renders the counts THE SERVER RETURNED, and
 *    the orphan notice keys on that response's relationship count being zero — never on this file's
 *    belief about what the plugin emits. A label named after what the code was believed to do goes
 *    false the first time the code changes underneath it.
 *
 * NO CLIENT-SIDE CONNECTIVITY CHECK, ALSO DELIBERATELY. `scp connect argocd` does a best-effort
 * `GET /api/version` from the operator's own shell. A browser cannot reach a private in-cluster
 * address, so the same probe here would fail for exactly hazard 1 above — and it would be
 * simulating a server behaviour in the client, the class of thing PR #152 removed a gate for. STEP 2
 * IS the connectivity check, and a real one: it runs server-side, through the SSRF guard, with the
 * stored token. Stopping after step 1 is the `--no-validate` equivalent and reaches the same state.
 */

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
  /** Blank ⇒ `defaultTokenKey(name)`, mirroring the CLI's optional `--token-key`. */
  tokenKey: string;
  allowInternalEgress: boolean;
}

export function emptyDraft(): ConnectDraft {
  return { name: "argocd", serverUrl: "", token: "", tokenKey: "", allowInternalEgress: false };
}

/**
 * The subset of the generated SDK this wizard is allowed to touch, as a structural interface so a
 * test can hand in a double and MEASURE which doors were used — in particular that the token
 * reached `putSecret` and nothing else. Every method here is one already-public operation; there is
 * no wizard-specific endpoint anywhere in this flow.
 */
export interface ConnectDoors {
  putSecret(key: string, value: string): Promise<unknown>;
  createExecutionSystem(req: CreateObjectRequest): Promise<GraphObject>;
  listExecutionSystems(): Promise<GraphObject[]>;
  runDiscovery(executionSystemId: string, instanceId: string): Promise<DiscoveryProposal>;
  acceptProposal(proposal: DiscoveryProposal): Promise<AcceptDiscoveryResponse>;
}

export const sdkDoors: ConnectDoors = {
  putSecret: (key, value) => client.secrets.put(key, { value }),
  createExecutionSystem: (req) => client.object("execution-system").create(req),
  listExecutionSystems: async () => (await client.object("execution-system").list()).items,
  runDiscovery: (executionSystemId, instanceId) =>
    client.discovery.run({
      pluginModule: ARGOCD_DISCOVERY_MODULE,
      pluginInstanceId: instanceId,
      // ONLY the system id. `POST /discovery/run` resolves `serverUrl`, `tokenSecretKey`,
      // `secretRefs`, the egress allowlist and `allowInternalEgress` from the PERSISTED system and
      // lets those win over anything a caller sends (routes/executors.ts) — the ADR-0003 fix for
      // "a grant on system X authorizing egress to a caller-supplied address". So the wizard neither
      // re-sends the URL nor ever handles the token again after step 1.
      config: { executionSystemId }
    }),
  acceptProposal: (proposal) => client.discovery.accept({ proposal })
};

/**
 * STEP 1, as one function: store the token, then register the system that references it.
 *
 * ORDER IS LOAD-BEARING and matches the CLI's. Secret first: an execution system whose
 * `tokenSecretKey` names a secret that does not exist is a system that fails at discovery time with
 * a confusing error, whereas a stored secret with no system yet is inert and simply overwritten by
 * the next attempt.
 */
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

// ---------------------------------------------------------------------------------------------
// Step 1 — register
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Step 2 — enumerate (and the only real connectivity check there is)
// ---------------------------------------------------------------------------------------------

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
          <strong>proposal only</strong> — nothing is written to the graph until you accept it in
          step 3. This call is also the connectivity check: it runs on the server, through
          SCP&apos;s egress guard, with the token you just stored.
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

// ---------------------------------------------------------------------------------------------
// Step 3 — review and import
// ---------------------------------------------------------------------------------------------

export function ReviewStep({
  doors,
  proposal,
  onImported
}: {
  doors: ConnectDoors;
  proposal: DiscoveryProposal;
  onImported: (result: AcceptDiscoveryResponse) => void;
}): React.JSX.Element {
  const accept = useMutation({
    mutationFn: async (): Promise<AcceptDiscoveryResponse> => doors.acceptProposal(proposal),
    onSuccess: onImported
  });

  return (
    <Card data-testid="connect-argocd-review">
      <CardHeader>
        <CardTitle className="text-base">3. Review and import</CardTitle>
        <CardDescription>
          Nothing below exists in the graph yet. Accepting creates the objects, their executor
          bindings and their source mappings in one transaction.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2" data-testid="argocd-proposal-counts">
          {proposalTypeCounts(proposal).map(([typeId, count]) => (
            <Badge key={typeId} variant="info">
              {count} {typeId}
            </Badge>
          ))}
          <Badge variant="secondary">{proposal.bindings?.length ?? 0} executor binding</Badge>
          <Badge variant="secondary">{proposal.sourceMappings?.length ?? 0} source mapping</Badge>
          <Badge variant="secondary">{proposal.relationships.length} relationship</Badge>
        </div>

        <ul className="max-h-64 overflow-auto rounded border border-slate-200 text-sm">
          {proposal.objects.map((object) => (
            <li
              key={`${object.typeId}:${object.name}`}
              className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-1.5 last:border-b-0"
              data-testid="argocd-proposal-object"
            >
              <span className="font-mono">{object.name}</span>
              <span className="text-xs text-slate-500">{object.typeId}</span>
            </li>
          ))}
          {proposal.objects.length === 0 && (
            <li className="px-3 py-2 text-slate-500" data-testid="argocd-proposal-empty">
              This Argo CD reported no Applications. Nothing to import.
            </li>
          )}
        </ul>

        {accept.isError && <ErrorNotice error={accept.error} testId="argocd-accept-error" />}

        <div>
          <Button
            type="button"
            disabled={accept.isPending || proposal.objects.length === 0}
            onClick={() => accept.mutate()}
            data-testid="argocd-accept-submit"
          >
            {accept.isPending ? "Importing…" : "Import and coordinate"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The result — hazard 3 lives here
// ---------------------------------------------------------------------------------------------

/**
 * WHAT WAS ACTUALLY CREATED, read off the accept response.
 *
 * Every number here comes from `result`. None is inferred from what `argocd-discovery` is believed
 * to emit — including the relationship count, which is the one this screen would most easily get
 * wrong: today the plugin returns `relationships: []`, so a "linked into your service graph" line
 * would be a lie, and hardcoding "0 relationships" would become a lie the day that changes. The
 * orphan notice keys on the response.
 */
export function ImportSummary({
  result,
  systemName
}: {
  result: AcceptDiscoveryResponse;
  systemName: string;
}): React.JSX.Element {
  const relationships = result.createdRelationshipIds.length;
  const rows: Array<[string, number]> = [
    ["graph objects", result.createdObjectIds.length],
    ["executor bindings", result.createdBindingIds.length],
    ["source mappings", result.createdSourceMappingIds.length],
    ["graph relationships", relationships]
  ];

  return (
    <Card data-testid="connect-argocd-summary">
      <CardHeader>
        <CardTitle className="text-base">Imported from {systemName}</CardTitle>
        <CardDescription>
          SCP now observes, triggers and reports on these Applications.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {rows.map(([label, count]) => (
            <div key={label} data-testid={`argocd-created-${label.replace(/\s+/g, "-")}`}>
              <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="font-mono text-lg text-slate-900">{count}</dd>
            </div>
          ))}
        </dl>

        {relationships === 0 && (
          <div
            className="rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800"
            data-testid="argocd-orphan-notice"
          >
            <p className="font-medium">These components are not part of any service yet.</p>
            <p className="mt-1">
              The import created no graph relationships, so nothing links the new components to a
              service, an owner or a dependency. Coordination works — the executor bindings above
              are what SCP triggers and observes through — but service-level views will not show
              them until you assign each component to a service.
            </p>
          </div>
        )}

        <Link
          to="/$basePath"
          params={{ basePath: "components" }}
          className="text-sm text-slate-700 underline underline-offset-4 hover:text-slate-900"
          data-testid="argocd-view-components-link"
        >
          View the imported components
        </Link>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/**
 * The registered systems this wizard may resume — the ARGO CD ones, keyed on the `kind` property
 * each was created with.
 *
 * `execution-system` is one object type shared by every imported backend (gitea, gitlab, harbor,
 * argocd), so offering the unfiltered list would let an operator run `argocd-discovery` against
 * their Gitea and get a server-side error naming a plugin they never chose. A system with no `kind`
 * is omitted rather than assumed: this reads what is stored, and there is nothing here that could
 * tell an Argo CD from anything else without it.
 */
export function argoCdSystems(systems: GraphObject[] | undefined): GraphObject[] {
  return (systems ?? []).filter(
    (system) => (system.properties as { kind?: unknown } | undefined)?.kind === "argocd"
  );
}

export function ConnectArgoCdPage(): React.JSX.Element {
  const [system, setSystem] = useState<GraphObject | null>(null);
  const [proposal, setProposal] = useState<DiscoveryProposal | null>(null);
  const [result, setResult] = useState<AcceptDiscoveryResponse | null>(null);

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

      {result !== null && system !== null ? (
        <ImportSummary result={result} systemName={system.name} />
      ) : proposal !== null ? (
        <ReviewStep doors={sdkDoors} proposal={proposal} onImported={setResult} />
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

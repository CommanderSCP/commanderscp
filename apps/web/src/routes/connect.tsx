import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type {
  CreateObjectRequest,
  DiscoveryProposal,
  GraphObject,
  PluginManifest
} from "@scp/schemas";
import { client } from "../lib/client";
import { Alert } from "../components/ui/alert";
import { ScaffoldPanel } from "../components/scaffold/scaffold-panel";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { SkeletonRows } from "../components/ui/skeleton";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";
import { ConnectArgoCdPage, normalizeServerUrl } from "./connect-argocd";

/**
 * `/connect/$kind` — B1 of `docs/proposals/outpost-ui.md` §4 Lane B: generalizes the M19.1
 * "Connect Argo CD" wizard (`connect-argocd.tsx`) over the server's OWN discovery-module catalog
 * instead of one Argo-CD-shaped page, so `gitea`/`gitlab` (discovery plugins that already ship —
 * `KNOWN_DISCOVERY_MODULES`, `apps/server/src/routes/executors.ts` — with no wizard and no CLI
 * shortcut) stop dead-ending in "hand-assemble `secrets.put` + `execution-system` create +
 * `discovery.run` + `discovery.accept`" (outpost-ui.md §4, measured state).
 *
 * =============================================================================================
 * "ARGO CD KEEPS ITS TESTIDS" — WHY THIS FILE NEVER RENDERS THE ARGO CD FORM ITSELF
 * =============================================================================================
 * `router.tsx` keeps the STATIC `/connect/argocd` route pointing at the original, untouched
 * `ConnectArgoCdPage` — static beats dynamic in this router's own precedence (the same rule that
 * keeps `/services/{id}/board` alive beside the index route), so a browser hitting
 * `/connect/argocd` always resolves there FIRST and never reaches this file at all. `kind ===
 * "argocd"` below still dispatches to that same page defensively (so this route degrades
 * correctly if the static one is ever removed), but in normal operation it is dead code. This is
 * why B3/B4 below (triage, target rows) do not show up for an Argo CD import today — see risks in
 * the section G4 handoff.
 *
 * =============================================================================================
 * WHY `github` IS NOT IN THE CONNECTABLE SET, EVEN THOUGH IT HAS A DISCOVERY IMPLEMENTATION
 * =============================================================================================
 * `github-discovery`'s config REQUIRES `appId`+`installationId`+`owner`+`repo` and authenticates
 * with a GitHub App PRIVATE KEY — `privateKeySecretKey` in its configSchema, never
 * `tokenSecretKey`. The execution-system-backed discovery merge this wizard relies on for
 * credential handling (`POST /discovery/run`'s `config.executionSystemId` branch,
 * `routes/executors.ts`) is hardcoded to forward exactly ONE secret-bearing field off the
 * persisted system: `tokenSecretKey` (`effectiveSecretRefs = props.tokenSecretKey ? {...} : {}`).
 * A `kind: "github"` execution-system would register fine and then fail to authenticate at
 * discovery time with no field telling it why — the private key secret ref never reaches the
 * plugin. `connectableKinds` below derives the connectable set from the manifests themselves
 * (never a hand-maintained list), so `github` is excluded by that derivation, not a hardcoded
 * exception — see its doc comment.
 */

// -----------------------------------------------------------------------------------------------
// Deriving the connectable set and its form fields FROM the server's own manifest catalog — never
// invented, mirroring plugins.tsx's `SchemaForm` (a separate, minimal copy: that file is owned by
// a different section of this same round, so this does not import from it).
// -----------------------------------------------------------------------------------------------

interface ConfigSchemaProperty {
  type?: string;
  format?: string;
  default?: unknown;
}
interface ConfigSchemaShape {
  required?: string[];
  properties?: Record<string, ConfigSchemaProperty>;
}

function schemaOf(manifest: PluginManifest | undefined): ConfigSchemaShape {
  return (manifest?.configSchema as ConfigSchemaShape | undefined) ?? {};
}

/** The one field name every module this wizard can actually drive declares — see the file-level
 *  comment above for why its PRESENCE is exactly the test for "this wizard can authenticate it". */
const SYSTEM_SECRET_FIELD = "tokenSecretKey";

/** A discovery module reachable through this wizard: its `kind` (the `execution-system.properties
 *  .kind` value and the CLI/executor module name — `manifest.id` with the `-discovery` suffix
 *  stripped) plus the manifest itself, which drives every form field below. */
export interface ConnectableKind {
  kind: string;
  discoveryModule: string;
  manifest: PluginManifest;
}

/** Every `discovery`-kind manifest whose configSchema declares `tokenSecretKey` — i.e. every
 *  module the register→enumerate→accept flow below can actually authenticate. Reads the server's
 *  real catalog (`client.plugins.listManifests()`); nothing here is a hardcoded kind list. */
export function connectableKinds(manifests: PluginManifest[]): ConnectableKind[] {
  return manifests
    .filter((m) => m.kind === "discovery" && m.id.endsWith("-discovery"))
    .map((m) => ({ kind: m.id.slice(0, -"-discovery".length), discoveryModule: m.id, manifest: m }))
    .filter(({ manifest }) => SYSTEM_SECRET_FIELD in (schemaOf(manifest).properties ?? {}));
}

/** Registered systems already carrying this `kind` — the same "offer a resume, don't run the
 *  wrong plugin against the wrong system" filter `argoCdSystems` (`connect-argocd.tsx`) uses. */
export function systemsOfKind(systems: GraphObject[] | undefined, kind: string): GraphObject[] {
  return (systems ?? []).filter(
    (system) => (system.properties as { kind?: unknown } | undefined)?.kind === kind
  );
}

/** Fields NOT collected by the run-time config form: `serverUrl`/`tokenSecretKey` are Step-1
 *  system fields (the execution-system-backed merge injects them at discovery time), and
 *  `baseUrl` is the SAME resolution's explicit-override half (`resolveProviderBaseUrl` in
 *  `packages/plugins/git-provider-core`) — collecting it too would just be a second, confusing
 *  "URL" field doing what the Step-1 Server URL already does via the persisted system. */
const RUN_FIELD_EXCLUDE = new Set(["serverUrl", SYSTEM_SECRET_FIELD, "baseUrl"]);

/** `gitlab-discovery`'s JSON Schema declares no `required` array at all — `discover()`'s
 *  `projectPathOf` needs `projectPath` OR (`owner` AND `repo`), an OR a flat `required` list can't
 *  express (packages/plugins/gitlab/src/index.ts). Asked for like every other git-provider module
 *  here rather than left to a schema that can't say it; `projectPath` stays optional, for a
 *  nested-group self-hosted layout. */
const CLIENT_REQUIRED_OVERRIDE: Record<string, string[]> = { gitlab: ["owner", "repo"] };

export interface RunField {
  name: string;
  required: boolean;
  type?: string;
}

/** The per-run config fields an operator fills at ENUMERATE time (step 2) — `owner`/`repo` and
 *  friends, which vary per scan even against the same registered server, unlike the system-level
 *  fields collected once at register time. */
export function runConfigFields({ kind, manifest }: ConnectableKind): RunField[] {
  const schema = schemaOf(manifest);
  const required = new Set([...(schema.required ?? []), ...(CLIENT_REQUIRED_OVERRIDE[kind] ?? [])]);
  return Object.keys(schema.properties ?? {})
    .filter((name) => !RUN_FIELD_EXCLUDE.has(name))
    .map((name) => ({ name, required: required.has(name), type: schema.properties?.[name]?.type }));
}

const DISPLAY_NAME: Record<string, string> = {
  gitea: "Gitea",
  gitlab: "GitLab",
  argocd: "Argo CD"
};

function displayName(kind: string): string {
  return DISPLAY_NAME[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** camelCase field name -> a plain label. A deterministic transform of the REAL schema field name,
 *  never an invented one — `appId` -> "App ID" style acronym-preserving cases aren't needed by any
 *  field this wizard renders today (github, the one module with them, is excluded above). */
function fieldLabel(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function defaultSecretKey(kind: string, name: string): string {
  return `${name.trim() || kind}-${kind}-token`;
}

// -----------------------------------------------------------------------------------------------
// The doors — same discipline as `connect-argocd.tsx`'s `ConnectDoors`: a structural interface a
// test can hand a double to, and (b3) the two more doors this wizard's triage step needs, copied
// from `registry-detail.tsx`'s `ComponentServiceCard` rather than importing that page.
// -----------------------------------------------------------------------------------------------

export interface ConnectKindDoors {
  putSecret(key: string, value: string): Promise<unknown>;
  createExecutionSystem(req: CreateObjectRequest): Promise<GraphObject>;
  listExecutionSystems(): Promise<GraphObject[]>;
  runDiscovery(
    pluginModule: string,
    pluginInstanceId: string,
    config: Record<string, unknown>
  ): Promise<DiscoveryProposal>;
  listServices(): Promise<GraphObject[]>;
  setService(componentId: string, serviceId: string): Promise<unknown>;
}

export const genericSdkDoors: ConnectKindDoors = {
  putSecret: (key, value) => client.secrets.put(key, { value }),
  createExecutionSystem: (req) => client.object("execution-system").create(req),
  listExecutionSystems: async () => (await client.object("execution-system").list()).items,
  runDiscovery: (pluginModule, pluginInstanceId, config) =>
    client.discovery.run({ pluginModule, pluginInstanceId, config }),
  listServices: async () => (await client.services.list({ limit: 100 })).items,
  setService: (componentId, serviceId) => client.components.setService(componentId, serviceId)
};

export interface GenericConnectDraft {
  name: string;
  serverUrl: string;
  secretValue: string;
  secretKey: string;
  allowInternalEgress: boolean;
}

export function emptyGenericDraft(kind: string): GenericConnectDraft {
  return { name: kind, serverUrl: "", secretValue: "", secretKey: "", allowInternalEgress: false };
}

/** Mirrors `registerExecutionSystem` (`connect-argocd.tsx`): secret first, then the system that
 *  references it — a system whose secret field names something that does not exist yet fails at
 *  discovery time with a confusing error, a stored-but-unreferenced secret is simply inert. */
export async function registerGenericSystem(
  doors: ConnectKindDoors,
  kind: string,
  draft: GenericConnectDraft
): Promise<GraphObject> {
  const name = draft.name.trim();
  const serverUrl = normalizeServerUrl(draft.serverUrl);
  const secretKey = draft.secretKey.trim() || defaultSecretKey(kind, name);

  await doors.putSecret(secretKey, draft.secretValue);

  return doors.createExecutionSystem({
    name,
    properties: {
      kind,
      serverUrl,
      [SYSTEM_SECRET_FIELD]: secretKey,
      ...(draft.allowInternalEgress ? { allowInternalEgress: true } : {})
    }
  });
}

export function RegisterStepGeneric({
  connectable,
  doors,
  existing,
  onRegistered
}: {
  connectable: ConnectableKind;
  doors: ConnectKindDoors;
  existing: GraphObject[];
  onRegistered: (system: GraphObject) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<GenericConnectDraft>(() =>
    emptyGenericDraft(connectable.kind)
  );

  const register = useMutation({
    // NO ARGUMENT — same reason as `connect-argocd.tsx`'s `RegisterStep`: `mutate(vars)` would park
    // the secret in the TanStack mutation cache for the observer's lifetime.
    mutationFn: async (): Promise<GraphObject> =>
      registerGenericSystem(doors, connectable.kind, draft),
    onSuccess: (system) => {
      setDraft((prev) => ({ ...prev, secretValue: "" }));
      onRegistered(system);
    }
  });

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    register.mutate();
  }

  const secretKeyPreview = draft.secretKey.trim() || defaultSecretKey(connectable.kind, draft.name);
  const name = displayName(connectable.kind);

  return (
    <Card data-testid="connect-register-card">
      <CardHeader>
        <CardTitle>1. Register your {name}</CardTitle>
        <CardDescription>
          Stores the API token in SCP&apos;s write-only secrets store and creates the{" "}
          <code className="font-mono">execution-system</code> object that references it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {existing.length > 0 && (
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="text-sm font-medium text-slate-700">
              Or continue with a {name} you already registered
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {existing.map((system) => (
                <Button
                  key={system.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="connect-existing-system"
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
            <label htmlFor="connect-name" className="text-sm font-medium text-slate-700">
              Name
            </label>
            <Input
              id="connect-name"
              data-testid="connect-name-input"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="connect-server-url" className="text-sm font-medium text-slate-700">
              {name} server URL
            </label>
            <Input
              id="connect-server-url"
              data-testid="connect-server-url-input"
              value={draft.serverUrl}
              onChange={(e) => setDraft((prev) => ({ ...prev, serverUrl: e.target.value }))}
              placeholder={`https://${connectable.kind}.example.com`}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="connect-secret" className="text-sm font-medium text-slate-700">
              API token
            </label>
            <Input
              id="connect-secret"
              data-testid="connect-secret-input"
              type="password"
              autoComplete="off"
              value={draft.secretValue}
              onChange={(e) => setDraft((prev) => ({ ...prev, secretValue: e.target.value }))}
              required
            />
            <p className="text-xs text-slate-500">
              SCP stores it write-only under <code className="font-mono">{secretKeyPreview}</code>{" "}
              and can never read it back.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="connect-secret-key" className="text-sm font-medium text-slate-700">
              Secret key (optional)
            </label>
            <Input
              id="connect-secret-key"
              data-testid="connect-secret-key-input"
              value={draft.secretKey}
              onChange={(e) => setDraft((prev) => ({ ...prev, secretKey: e.target.value }))}
              placeholder={defaultSecretKey(connectable.kind, draft.name)}
            />
          </div>

          <div className="rounded border border-amber-300 bg-amber-50 p-3">
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                data-testid="connect-internal-egress-checkbox"
                className="mt-0.5"
                checked={draft.allowInternalEgress}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, allowInternalEgress: e.target.checked }))
                }
              />
              <span>
                <span className="font-medium">
                  This {name} is reachable only at a private / in-cluster address
                </span>
                <span className="mt-1 block text-xs text-slate-700">
                  This is a <strong>declaration, not a grant</strong>: your operator must also list
                  this host in <code className="font-mono">SCP_INTERNAL_EGRESS_HOSTS</code>, or
                  egress stays blocked (ADR-0003).
                </span>
              </span>
            </label>
          </div>

          {register.isError && (
            <Alert tone="danger" role="alert" data-testid="connect-register-error">
              {queryErrorMessage(register.error)}
            </Alert>
          )}

          <div>
            <Button
              type="submit"
              disabled={register.isPending}
              data-testid="connect-register-submit"
            >
              {register.isPending ? "Registering…" : "Register and continue"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Step 2 — enumerate: the run-time config fields (owner/repo/…) PLUS the connectivity check

export function EnumerateStepGeneric({
  connectable,
  doors,
  system,
  onProposal,
  onBack
}: {
  connectable: ConnectableKind;
  doors: ConnectKindDoors;
  system: GraphObject;
  onProposal: (proposal: DiscoveryProposal) => void;
  onBack: () => void;
}): React.JSX.Element {
  const fields = runConfigFields(connectable);
  const [values, setValues] = useState<Record<string, string>>({});

  const enumerate = useMutation({
    mutationFn: async (): Promise<DiscoveryProposal> => {
      const config: Record<string, unknown> = { executionSystemId: system.id };
      for (const field of fields) {
        const raw = values[field.name];
        if (raw === undefined || raw === "") continue;
        config[field.name] =
          field.type === "integer" || field.type === "number" ? Number(raw) : raw;
      }
      return doors.runDiscovery(connectable.discoveryModule, system.name, config);
    },
    onSuccess: onProposal
  });

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    enumerate.mutate();
  }

  return (
    <Card data-testid="connect-enumerate-card">
      <CardHeader>
        <CardTitle>2. Enumerate</CardTitle>
        <CardDescription>
          Runs <code className="font-mono">{connectable.discoveryModule}</code> against{" "}
          <span data-testid="connect-system-name">{system.name}</span> and returns a{" "}
          <strong>proposal only</strong> — nothing is written to the graph until you accept it in
          step 3. This call is also the connectivity check.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {fields.map((field) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label
                htmlFor={`connect-run-${field.name}`}
                className="text-sm font-medium text-slate-700"
              >
                {fieldLabel(field.name)}
                {field.required && <span className="text-red-600"> *</span>}
              </label>
              <Input
                id={`connect-run-${field.name}`}
                data-testid={`connect-run-field-${field.name}`}
                type={field.type === "integer" || field.type === "number" ? "number" : "text"}
                value={values[field.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                required={field.required}
              />
            </div>
          ))}

          {enumerate.isError && (
            <>
              <Alert tone="danger" role="alert" data-testid="connect-enumerate-error">
                {queryErrorMessage(enumerate.error)}
              </Alert>
              <p className="text-xs text-slate-600" data-testid="connect-enumerate-error-help">
                The execution-system <span className="font-mono">{system.name}</span> is registered
                and was kept — fix the fields above or the egress allowlist and run this step again.
              </p>
            </>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={enumerate.isPending}
              data-testid="connect-enumerate-submit"
            >
              {enumerate.isPending ? "Enumerating…" : "Enumerate"}
            </Button>
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Step 3 — review and import (B4: per-type sections + per-object skip, WHEN safe)

type ProposalObject = DiscoveryProposal["objects"][number];

/** One row per proposed object type, in first-seen order — generalizes `proposalTypeCounts`
 *  (`connect-argocd.tsx`) into groups so a `deployment-target` object (B4: "where a discovery
 *  module proposes targets … accept them alongside components") gets its own section with the
 *  IDENTICAL row/skip treatment as `component` — see the section G4 handoff for why no shipped
 *  discovery module actually emits one today. */
export function groupObjectsByType(objects: ProposalObject[]): Array<[string, number[]]> {
  const order: string[] = [];
  const byType = new Map<string, number[]>();
  objects.forEach((object, index) => {
    if (!byType.has(object.typeId)) {
      byType.set(object.typeId, []);
      order.push(object.typeId);
    }
    byType.get(object.typeId)!.push(index);
  });
  return order.map((typeId) => [typeId, byType.get(typeId)!]);
}

/**
 * Filters a proposal down to the CHECKED objects, dropping any `bindings`/`sourceMappings` that
 * name a skipped object (`objectName` match — exact, the SAME key `POST /discovery/accept` itself
 * resolves them by). `relationships` is left untouched: the caller only offers skip when
 * `proposal.relationships.length === 0` (see `ReviewStepGeneric`), because a relationship
 * references its endpoints by a `fromUrn`/`toUrn` each plugin constructs internally and never
 * exposes as a stable per-object key — dropping an object that a relationship still points at
 * would submit a proposal with a dangling endpoint and `POST /discovery/accept` would 404
 * resolving it. That is the "do not fake it client-side" boundary for B4/B3 skip: real, but only
 * where it is safe.
 */
export function filterProposal(
  proposal: DiscoveryProposal,
  uncheckedIndices: Set<number>
): DiscoveryProposal {
  if (uncheckedIndices.size === 0) return proposal;
  const keptObjects = proposal.objects.filter((_, index) => !uncheckedIndices.has(index));
  const keptNames = new Set(keptObjects.map((object) => object.name));
  return {
    ...proposal,
    objects: keptObjects,
    bindings: proposal.bindings?.filter((binding) => keptNames.has(binding.objectName)),
    sourceMappings: proposal.sourceMappings?.filter((mapping) => keptNames.has(mapping.objectName))
  };
}

export function ReviewStepGeneric({
  proposal
}: {
  proposal: DiscoveryProposal;
}): React.JSX.Element {
  // THE STEP THAT USED TO WRITE. It called `discovery.accept`, which committed the proposal
  // straight into the graph — the path that made the homelab's ~50 imported components RBAC
  // orphans, because nothing asked which service they belonged to.
  //
  // It now emits IaC (ADR-0047). The grouping question is asked HERE, before anything exists, which
  // is the whole of the fix: "the orphan problem is solved at authoring time, where a human is
  // present." The post-import orphan-triage screen this wizard used to end on is gone with it —
  // there are no orphans to triage when a component cannot be emitted without a service.
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scaffold</CardTitle>
        <CardDescription>
          {proposal.objects.length} object(s) discovered. Group them into services and commit the
          code — SCP writes nothing here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScaffoldPanel proposal={proposal} testIdPrefix="connect-scaffold" />
      </CardContent>
    </Card>
  );
}

/*
 * THE POST-IMPORT ORPHAN TRIAGE IS GONE, AND THAT IS THE POINT (ADR-0047).
 *
 * `zipCreatedObjects`, `ImportedRow`, the per-component service picker and `ImportSummaryGeneric`
 * existed to repair what the accept path produced: components already written to the graph with no
 * owning service, which the operator then had to find and fix one at a time. The homelab's ~50
 * imported components are why that screen was built.
 *
 * With discovery demoted to a scaffolder there is nothing to repair. Grouping is asked BEFORE
 * anything exists (`ScaffoldPanel`), and a component with no service is simply not emitted — a
 * `Component` cannot be constructed without one. A triage screen for a state that can no longer be
 * reached would be dead code that reads as a safety net.
 */

export function ConnectGenericPage({
  kind,
  doors = genericSdkDoors
}: {
  kind: string;
  doors?: ConnectKindDoors;
}): React.JSX.Element {
  const [system, setSystem] = useState<GraphObject | null>(null);
  const [proposal, setProposal] = useState<DiscoveryProposal | null>(null);

  const manifestsQuery = useQuery({
    queryKey: ["plugin-manifests"],
    queryFn: () => client.plugins.listManifests()
  });
  const systemsQuery = useQuery({
    queryKey: ["execution-systems"],
    queryFn: doors.listExecutionSystems,
    enabled: manifestsQuery.isSuccess
  });

  if (manifestsQuery.isLoading) {
    return <SkeletonRows n={5} />;
  }
  if (manifestsQuery.isError) {
    return (
      <QueryErrorNotice
        error={manifestsQuery.error}
        what="the plugin catalog"
        testId="connect-manifests-error"
      />
    );
  }

  const kinds = connectableKinds(manifestsQuery.data?.items ?? []);
  const connectable = kinds.find((candidate) => candidate.kind === kind);

  if (!connectable) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <PageHeader
          title={`Connect ${displayName(kind)}`}
          description="CommanderSCP cannot walk you through connecting this one."
        />
        <Alert tone="neutral" data-testid="connect-unsupported-kind">
          {kinds.length === 0 ? (
            <p>No connect-ready discovery modules are registered on this instance.</p>
          ) : (
            <p>
              This wizard can walk you through:{" "}
              {kinds.map((candidate, index) => (
                <span key={candidate.kind}>
                  {index > 0 && ", "}
                  <Link
                    to="/connect/$kind"
                    params={{ kind: candidate.kind }}
                    className="underline underline-offset-4"
                  >
                    {displayName(candidate.kind)}
                  </Link>
                </span>
              ))}
              .
            </p>
          )}
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={`Connect ${displayName(kind)}`}
        description={`Point CommanderSCP at a ${displayName(
          kind
        )} you already run, and import what it finds as components SCP coordinates.`}
      />

      {systemsQuery.isError && (
        <QueryErrorNotice
          error={systemsQuery.error}
          what="the execution systems already registered"
          testId="connect-systems-error"
        />
      )}

      {proposal !== null ? (
        <ReviewStepGeneric proposal={proposal} />
      ) : system !== null ? (
        <EnumerateStepGeneric
          connectable={connectable}
          doors={doors}
          system={system}
          onProposal={setProposal}
          onBack={() => setSystem(null)}
        />
      ) : (
        <RegisterStepGeneric
          connectable={connectable}
          doors={doors}
          existing={systemsOfKind(systemsQuery.data, connectable.kind)}
          onRegistered={setSystem}
        />
      )}
    </div>
  );
}

/** Loosely-typed param read (`strict: false`), same pattern as `lib/use-route-params.ts`'s other
 *  accessors — avoids a circular import between router.tsx (imports every page) and the pages. */
function useKindParam(): string | undefined {
  return (useParams({ strict: false }) as { kind?: string }).kind;
}

export function ConnectKindPage(): React.JSX.Element {
  const kind = useKindParam() ?? "";
  // Static beats dynamic, so a browser never reaches this branch via `/connect/argocd` — kept for
  // the reasons in the file-level comment above.
  if (kind === "argocd") return <ConnectArgoCdPage />;
  return <ConnectGenericPage kind={kind} />;
}

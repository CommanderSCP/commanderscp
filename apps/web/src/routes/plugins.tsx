import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bell, Search, type LucideIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ScpApiError } from "@scp/sdk";
// A2 (docs/proposals/outpost-ui.md §3): `ExecutorTypeSchema` is a value (its `.options` drives the
// Select below), not just a type — same direct `@scp/schemas` import `registry-detail.tsx`'s own
// repurpose control already uses (eslint's restricted-imports rule allows it: "apps/web/src may
// import only @scp/sdk and @scp/schemas").
import {
  ExecutorTypeSchema,
  type CreateExecutorBindingRequest,
  type DiscoveryProposal,
  type ExecutorType,
  type PluginManifest
} from "@scp/schemas";
import { client } from "../lib/client";
import { cn, focusRing } from "../lib/utils";
import { Badge, type BadgeProps } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/ui/page-header";
import { Alert } from "../components/ui/alert";
import { SectionLabel } from "../components/ui/section-label";
import { SkeletonRows } from "../components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";

/**
 * `/plugins` — the M7 plugin-configuration surface (BUILD_AND_TEST.md §8 M7 item 5: "plugin
 * config schemas surfaced as validated config forms in UI + CLI"; DESIGN.md §11: "config schemas
 * auto-surface as validated config forms in API, CLI, and UI... plugin authors get interface
 * parity for free"). Consumes ONLY `client.plugins`/`client.executors`/`client.notifications`/
 * `client.discovery` (the generated SDK) — same API-first parity as every other page.
 *
 * The form itself (`SchemaForm` below) is deliberately a MINIMAL JSON-Schema-driven renderer, not
 * a general one: it handles exactly the flat `{type: object, properties: {string|integer|number|
 * boolean}}` shape every M7 plugin manifest actually declares (packages/plugins/*\/src/index.ts's
 * `manifest.configSchema`) — nested `oneOf`/`anyOf`/`$ref` schemas are out of scope for this
 * milestone (no bundled plugin needs them). `secretRefs`/`allowedHosts` are NOT part of any
 * plugin's `configSchema` (they're binding-level, not plugin-level, fields — db/schema.ts's M7
 * section) so they get their own fixed fields below rather than being schema-driven.
 */

interface JsonSchemaProperty {
  type?: string;
  default?: unknown;
  format?: string;
}

function schemaProperties(configSchema: unknown): Record<string, JsonSchemaProperty> {
  const schema = configSchema as { properties?: Record<string, JsonSchemaProperty> } | undefined;
  return schema?.properties ?? {};
}

function schemaRequired(configSchema: unknown): string[] {
  const schema = configSchema as { required?: string[] } | undefined;
  return schema?.required ?? [];
}

/** Renders one input per top-level schema property, tracking values as an untyped record the
 *  caller coerces on submit (`coerceConfigValues`) — booleans/numbers round-trip through a plain
 *  HTML input's string value until then, same pattern the CLI's own `--config <json>` flag
 *  sidesteps entirely by just taking raw JSON; the UI form's whole point is not requiring an
 *  operator to hand-write JSON for the common case. */
function SchemaForm({
  configSchema,
  values,
  onChange
}: {
  configSchema: unknown;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}): React.JSX.Element {
  const properties = schemaProperties(configSchema);
  const required = new Set(schemaRequired(configSchema));
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return <p className="text-sm text-slate-500">This plugin has no configurable fields.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {keys.map((key) => {
        const prop = properties[key]!;
        const isBoolean = prop.type === "boolean";
        return (
          <div key={key} className="flex flex-col gap-1.5">
            <label htmlFor={`plugin-config-${key}`} className="text-sm font-medium text-slate-700">
              {key}
              {required.has(key) && <span className="text-red-600"> *</span>}
              <span className="ml-2 text-xs font-normal text-slate-400">
                {prop.type ?? "string"}
              </span>
            </label>
            {isBoolean ? (
              <select
                id={`plugin-config-${key}`}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm"
                value={values[key] ?? String(prop.default ?? "false")}
                onChange={(e) => onChange(key, e.target.value)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <Input
                id={`plugin-config-${key}`}
                type={prop.type === "integer" || prop.type === "number" ? "number" : "text"}
                value={values[key] ?? (prop.default !== undefined ? String(prop.default) : "")}
                onChange={(e) => onChange(key, e.target.value)}
                required={required.has(key)}
                data-testid={`plugin-config-input-${key}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Coerces the form's string-valued state back into real JSON types per the schema — the
 *  "validated" half of "validated config form" (a required field left empty fails HTML5
 *  `required` before this ever runs; a malformed number input is rejected by the `type="number"`
 *  input itself). Empty optional strings are omitted entirely rather than sent as `""`. */
function coerceConfigValues(
  configSchema: unknown,
  values: Record<string, string>
): Record<string, unknown> {
  const properties = schemaProperties(configSchema);
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (raw === "") continue;
    const prop = properties[key];
    if (prop?.type === "boolean") result[key] = raw === "true";
    else if (prop?.type === "integer" || prop?.type === "number") result[key] = Number(raw);
    else result[key] = raw;
  }
  return result;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof ScpApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A discovery proposal, summarized (spec §4E) — a scannable action/type/name-or-urn table with a
 * counts headline, raw JSON behind a "View raw" toggle instead of always dumping the whole proposal.
 * Discovery only ever proposes CREATEs (`DiscoveryProposalSchema` has no update/delete shape), so
 * every row's action reads "create".
 */
function DiscoveryProposalReview({
  proposal
}: {
  proposal: DiscoveryProposal;
}): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false);
  const objectCount = proposal.objects.length;
  const relCount = proposal.relationships.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Proposal: {objectCount} object{objectCount === 1 ? "" : "s"}, {relCount} relationship
          {relCount === 1 ? "" : "s"}
        </CardTitle>
        <CardDescription>Review before accepting — nothing has been written yet.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {objectCount + relCount > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Name / URN</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposal.objects.map((o, i) => (
                <TableRow key={`object-${i}`}>
                  <TableCell>create object</TableCell>
                  <TableCell className="capitalize">{o.typeId}</TableCell>
                  <TableCell>{o.name}</TableCell>
                </TableRow>
              ))}
              {proposal.relationships.map((r, i) => (
                <TableRow key={`relationship-${i}`}>
                  <TableCell>create relationship</TableCell>
                  <TableCell className="capitalize">{r.typeId}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-600">
                    {/* §1.6: the forward glyph is ArrowRight, never a `→` literal. */}
                    <span className="inline-flex items-center gap-1">
                      {r.fromUrn}
                      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-slate-400" />
                      {r.toUrn}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowRaw((v) => !v)}
            data-testid="discovery-proposal-view-raw-toggle"
          >
            {showRaw ? "Hide raw" : "View raw"}
          </Button>
          {showRaw && (
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">
              {JSON.stringify(proposal, null, 2)}
            </pre>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Shapes `PUT /executors/{idOrUrn}/binding`'s body (A2, docs/proposals/outpost-ui.md §3) — pure so
 * the Type wiring is testable without a live Dialog/mutation. `type` is now ALWAYS included,
 * deliberately: the bug this closes was never that `configuration` was a bad default, it was that
 * `putBinding` sent no `type` at all — so an operator reading their own binding back could not
 * tell whether "configuration" was a choice or a silence. Sending it explicitly, every time, is
 * the fix; the Select just makes the value the operator's own instead of the server's guess.
 */
export function buildExecutorBindingPayload(args: {
  pluginModule: string;
  pluginInstanceId: string;
  config: Record<string, unknown>;
  allowedHosts: string[];
  type: ExecutorType;
}): CreateExecutorBindingRequest {
  return {
    pluginModule: args.pluginModule,
    pluginInstanceId: args.pluginInstanceId,
    config: args.config,
    allowedHosts: args.allowedHosts.length > 0 ? args.allowedHosts : undefined,
    type: args.type
  };
}

/**
 * THE BINDING'S ROUTING TYPE — A2. Extracted out of `ConfigureDialog` so it (and its option set)
 * can be exercised directly: Radix's `SelectContent` portals its items, so the option list itself
 * cannot be asserted from a static render (`domain-local.test.tsx`'s precedent) — this component
 * at least makes the field's PRESENCE, label, and help copy testable without a live Dialog, and
 * `buildExecutorBindingPayload` above covers the value actually reaching the request.
 *
 * `ExecutorTypeSchema.options` — never a hand-copied literal list — so a future Type (D4, ADR-0007)
 * appears here automatically instead of needing a second edit.
 */
export function ExecutorBindingTypeField({
  value,
  onChange
}: {
  value: ExecutorType;
  onChange: (value: ExecutorType) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="executor-binding-type" className="text-sm font-medium text-slate-700">
        Type
      </label>
      <Select value={value} onValueChange={(v) => onChange(v as ExecutorType)}>
        <SelectTrigger id="executor-binding-type" data-testid="executor-binding-type-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ExecutorTypeSchema.options.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-slate-500">
        Routes which pipeline this binding drives: build turns source into an artifact (image,
        rpm, deb, npm), infrastructure stands up substrate, configuration applies a GitOps sync.
      </p>
    </div>
  );
}

function ConfigureDialog({
  manifest,
  open,
  onOpenChange
}: {
  manifest: PluginManifest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [targetIdOrUrn, setTargetIdOrUrn] = useState("");
  const [instanceId, setInstanceId] = useState("");
  // A2 — defaulted to the server's own pre-A2 default ('configuration'), but now a VISIBLE,
  // operator-owned choice instead of a silent one (docs/proposals/outpost-ui.md §3).
  const [bindingType, setBindingType] = useState<ExecutorType>("configuration");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [minSeverity, setMinSeverity] = useState<"info" | "warning" | "critical">("info");
  const [discoveryProposal, setDiscoveryProposal] = useState<DiscoveryProposal | null>(null);

  const isExecutor = manifest.kind === "executor";
  const isNotification = manifest.kind === "notification";
  const isDiscovery = manifest.kind === "discovery";

  const bindMutation = useMutation({
    mutationFn: async () => {
      const config = coerceConfigValues(manifest.configSchema, configValues);
      const hosts = allowedHosts
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      if (isExecutor) {
        return client.executors.putBinding(
          targetIdOrUrn,
          buildExecutorBindingPayload({
            pluginModule: manifest.id,
            pluginInstanceId: instanceId,
            config,
            allowedHosts: hosts,
            type: bindingType
          })
        );
      }
      return client.notifications.putBinding(instanceId, {
        pluginModule: manifest.id,
        config,
        allowedHosts: hosts.length > 0 ? hosts : undefined,
        minSeverity
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["executor-bindings"] });
      void queryClient.invalidateQueries({ queryKey: ["notification-bindings"] });
      onOpenChange(false);
    }
  });

  const discoverMutation = useMutation({
    mutationFn: async () => {
      const config = coerceConfigValues(manifest.configSchema, configValues);
      return client.discovery.run({
        pluginModule: manifest.id,
        pluginInstanceId: instanceId,
        config
      });
    },
    onSuccess: (proposal) => setDiscoveryProposal(proposal)
  });

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!discoveryProposal) throw new Error("no proposal to accept");
      return client.discovery.accept({ proposal: discoveryProposal });
    },
    onSuccess: () => {
      setDiscoveryProposal(null);
      onOpenChange(false);
    }
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (isDiscovery) discoverMutation.mutate();
    else bindMutation.mutate();
  }

  const pending = bindMutation.isPending || discoverMutation.isPending || acceptMutation.isPending;
  const error = bindMutation.error ?? discoverMutation.error ?? acceptMutation.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure {manifest.id}</DialogTitle>
          <DialogDescription>
            {isExecutor && "Binds a Component/DeploymentTarget to this ExecutorPlugin instance."}
            {isNotification &&
              "Configures a notification channel — an org may configure more than one."}
            {isDiscovery &&
              "Runs a repo/topology scan — returns a PROPOSAL only. Nothing is written to the graph until you explicitly accept it."}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {/* Three fieldsets (spec §2.12/§4E): what this binds to, its declared config, and its
              egress/delivery — grouped so a long form reads as three questions, not one blur. */}
          {(isExecutor || isNotification || isDiscovery) && (
            <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
              <legend className="px-1">
                <SectionLabel as="span">Binding</SectionLabel>
              </legend>
              {isExecutor && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="target-id-or-urn" className="text-sm font-medium text-slate-700">
                    Target (Component/DeploymentTarget id or URN)
                  </label>
                  <Input
                    id="target-id-or-urn"
                    value={targetIdOrUrn}
                    onChange={(e) => setTargetIdOrUrn(e.target.value)}
                    required
                    data-testid="executor-target-input"
                  />
                </div>
              )}
              {isExecutor && (
                <ExecutorBindingTypeField value={bindingType} onChange={setBindingType} />
              )}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="instance-id" className="text-sm font-medium text-slate-700">
                  Instance id
                </label>
                <Input
                  id="instance-id"
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                  required
                  data-testid="plugin-instance-id-input"
                />
              </div>
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
            <legend className="px-1">
              <SectionLabel as="span">Configuration</SectionLabel>
            </legend>
            <SchemaForm
              configSchema={manifest.configSchema}
              values={configValues}
              onChange={(key, value) => setConfigValues((prev) => ({ ...prev, [key]: value }))}
            />
          </fieldset>

          {(isExecutor || isNotification) && (
            <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3">
              <legend className="px-1">
                <SectionLabel as="span">Egress &amp; delivery</SectionLabel>
              </legend>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="allowed-hosts" className="text-sm font-medium text-slate-700">
                  Egress allowlist (comma-separated hostnames, optional)
                </label>
                <Input
                  id="allowed-hosts"
                  value={allowedHosts}
                  onChange={(e) => setAllowedHosts(e.target.value)}
                  placeholder="api.github.com"
                />
              </div>
              {isNotification && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="min-severity" className="text-sm font-medium text-slate-700">
                    Minimum severity
                  </label>
                  <select
                    id="min-severity"
                    className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm"
                    value={minSeverity}
                    onChange={(e) => setMinSeverity(e.target.value as typeof minSeverity)}
                  >
                    <option value="info">info</option>
                    <option value="warning">warning</option>
                    <option value="critical">critical</option>
                  </select>
                </div>
              )}
            </fieldset>
          )}

          {error && <Alert tone="danger">{errorMessageOf(error)}</Alert>}

          {discoveryProposal && <DiscoveryProposalReview proposal={discoveryProposal} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {isDiscovery && discoveryProposal ? (
              <Button
                type="button"
                disabled={pending}
                onClick={() => acceptMutation.mutate()}
                data-testid="discovery-accept-button"
              >
                {acceptMutation.isPending ? "Accepting…" : "Accept proposal"}
              </Button>
            ) : (
              <Button type="submit" disabled={pending} data-testid="plugin-configure-submit">
                {pending ? "Submitting…" : isDiscovery ? "Run discovery" : "Save binding"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Three distinguishable-at-a-glance kinds (spec §4E): executor is `info`, discovery `neutral` with
 *  a `Search` icon, notification `warning` with a `Bell` icon — never the same tone twice. */
const KIND_BADGE: Record<string, { variant: BadgeProps["variant"]; icon?: LucideIcon }> = {
  executor: { variant: "info" },
  discovery: { variant: "neutral", icon: Search },
  notification: { variant: "warning", icon: Bell }
};

function KindBadge({ kind }: { kind: string }): React.JSX.Element {
  const spec = KIND_BADGE[kind] ?? { variant: "neutral" as const };
  return (
    <Badge variant={spec.variant} icon={spec.icon}>
      {kind}
    </Badge>
  );
}

export function PluginsPage(): React.JSX.Element {
  const manifestsQuery = useQuery({
    queryKey: ["plugin-manifests"],
    queryFn: () => client.plugins.listManifests()
  });
  const [configuring, setConfiguring] = useState<PluginManifest | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Plugins"
        description="Configure an executor or notification binding, or run a discovery scan, from each plugin's declared settings."
      />
      <p className="-mt-4 text-xs text-slate-500">
        Secrets referenced by a binding are managed separately (
        <code className="rounded bg-slate-100 px-1 py-0.5">scp secret put</code>) and never appear in
        this form.
      </p>

      {/* M19.1 — the launch point for the "Connect Argo CD" wizard. This page configures a plugin
          INSTANCE from its manifest, which is the wrong shape for "point SCP at the Argo CD I already
          run": that act spans a secret, an execution-system object, a discovery run and an accept.
          The wizard owns the flow; this is where an operator looking at executor config finds it.
          (Restyled to the design system on merge: primary action wears the accent, not slate.) */}
      <Card data-testid="connect-argocd-card">
        <CardHeader>
          <CardTitle className="text-base">Connect an Argo CD you already run</CardTitle>
          <CardDescription>
            Register an existing Argo CD server and import its Applications as components SCP
            coordinates — the UI equivalent of <code className="font-mono">scp connect argocd</code>{" "}
            plus <code className="font-mono">scp discovery run|accept</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/connect/argocd"
            className={cn(
              "inline-flex h-9 items-center justify-center rounded-md bg-army-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-army-600",
              focusRing
            )}
            data-testid="connect-argocd-launch"
          >
            Connect Argo CD…
          </Link>
        </CardContent>
      </Card>

      {manifestsQuery.isLoading && <SkeletonRows n={3} />}
      {manifestsQuery.isError && <Alert tone="danger">{errorMessageOf(manifestsQuery.error)}</Alert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {manifestsQuery.data?.items.map((manifest) => (
          <Card key={manifest.id} data-testid="plugin-manifest-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{manifest.id}</CardTitle>
                <KindBadge kind={manifest.kind} />
              </div>
              <CardDescription>v{manifest.version}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfiguring(manifest)}
                data-testid="plugin-configure-button"
              >
                {manifest.kind === "discovery" ? "Run…" : "Configure…"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {configuring && (
        <ConfigureDialog
          manifest={configuring}
          open={configuring !== null}
          onOpenChange={(open) => {
            if (!open) setConfiguring(null);
          }}
        />
      )}
    </div>
  );
}

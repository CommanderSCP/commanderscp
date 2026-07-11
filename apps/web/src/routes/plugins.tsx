import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScpApiError } from "@scp/sdk";
import type { DiscoveryProposal, PluginManifest } from "@scp/schemas";
import { client } from "../lib/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
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
function coerceConfigValues(configSchema: unknown, values: Record<string, string>): Record<string, unknown> {
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
        return client.executors.putBinding(targetIdOrUrn, {
          pluginModule: manifest.id,
          pluginInstanceId: instanceId,
          config,
          allowedHosts: hosts.length > 0 ? hosts : undefined
        });
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
      return client.discovery.run({ pluginModule: manifest.id, pluginInstanceId: instanceId, config });
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
            {isNotification && "Configures a notification channel — an org may configure more than one."}
            {isDiscovery &&
              "Runs a repo/topology scan — returns a PROPOSAL only. Nothing is written to the graph until you explicitly accept it."}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
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
          {(isExecutor || isNotification || isDiscovery) && (
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
          )}
          <SchemaForm
            configSchema={manifest.configSchema}
            values={configValues}
            onChange={(key, value) => setConfigValues((prev) => ({ ...prev, [key]: value }))}
          />
          {(isExecutor || isNotification) && (
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
          )}
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

          {error && <p className="text-sm text-red-600">{errorMessageOf(error)}</p>}

          {discoveryProposal && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">
                  Proposal: {discoveryProposal.objects.length} object(s), {discoveryProposal.relationships.length}{" "}
                  relationship(s)
                </CardTitle>
                <CardDescription>Review before accepting — nothing has been written yet.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">
                  {JSON.stringify(discoveryProposal, null, 2)}
                </pre>
              </CardContent>
            </Card>
          )}

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

function kindBadgeVariant(kind: string): "info" | "secondary" | "success" {
  if (kind === "executor") return "info";
  if (kind === "discovery" || kind === "notification") return "success";
  return "secondary";
}

export function PluginsPage(): React.JSX.Element {
  const manifestsQuery = useQuery({
    queryKey: ["plugin-manifests"],
    queryFn: () => client.plugins.listManifests()
  });
  const [configuring, setConfiguring] = useState<PluginManifest | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Plugins</h1>
        <p className="text-sm text-slate-500">
          Every bundled plugin&apos;s manifest (DESIGN §11) — configure an executor/notification
          binding or run a discovery scan directly from its declared config schema. Secrets
          referenced by a binding are managed separately (<code>scp secret put</code>) and never
          appear in this form.
        </p>
      </div>

      {manifestsQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {manifestsQuery.isError && (
        <p className="text-sm text-red-600">{errorMessageOf(manifestsQuery.error)}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {manifestsQuery.data?.items.map((manifest) => (
          <Card key={manifest.id} data-testid="plugin-manifest-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">{manifest.id}</CardTitle>
                <Badge variant={kindBadgeVariant(manifest.kind)}>{manifest.kind}</Badge>
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

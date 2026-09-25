import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, RefreshCw, ServerCog } from "lucide-react";
import {
  StackBackendSchema,
  type StackBackend,
  type StackBackendPhase,
  type StackBackendView,
  type StackSizeTier,
  type StackUpdatePolicy,
  type StackView
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { cn, focusRing } from "../lib/utils";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { SkeletonRows } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";
import { formatRelative } from "./admin-dependencies";

/**
 * ADMIN › STACK (M29.4, ADR-0058) — the Standard Stack CommanderSCP installs and runs: each
 * backend's desired state and what the stack controller last reported about it.
 *
 * Reading is an ordinary session call. Every change (enable, disable, size, upgrade, the update
 * policy, the diagnostics download) needs the DEPLOYMENT OPERATOR CREDENTIAL as well, because it
 * installs or removes cluster software for every org on the instance. The credential is typed into
 * this page, held in component state for the life of the page and nothing longer — never storage,
 * never a cookie — and sent only as the `x-scp-operator-token` header of those calls, through the
 * SDK like everything else.
 *
 * Honesty (design spec §1.5): an enabled backend the controller has not reported is "pending", in
 * the amber-dashed unknown tone, never a guessed phase; a controller that has stopped reporting is
 * said so above the table, and its last report is labelled as such.
 */

export const stackKey = (): unknown[] => ["stack"];

const DISPLAY: Record<StackBackend, string> = {
  argocd: "Argo CD",
  "argo-workflows": "Argo Workflows",
  "argo-rollouts": "Argo Rollouts",
  "argo-events": "Argo Events",
  gitea: "Gitea"
};

const TIERS: readonly StackSizeTier[] = ["small", "medium", "large"];

type Tone = "success" | "info" | "warning" | "danger" | "neutral" | "unknown";

export function phaseTone(phase: StackBackendPhase): Tone {
  switch (phase) {
    case "ready":
      return "success";
    case "installing":
    case "upgrading":
    case "removing":
      return "info";
    case "degraded":
      return "warning";
    case "failed":
      return "danger";
    case "disabled":
      return "neutral";
  }
}

const selectClass = cn(
  "flex h-8 rounded-md border border-slate-300 bg-white px-2 text-xs shadow-sm disabled:cursor-not-allowed disabled:opacity-50",
  focusRing
);

function refusalOf(error: unknown): string {
  if (error instanceof ScpApiError) return error.problem?.detail ?? error.message;
  return queryErrorMessage(error);
}

function ControllerLine({ view, now }: { view: StackView; now: number }): React.JSX.Element {
  const c = view.controller;
  if (c.lastSeenAt === null) {
    return (
      <Alert tone="info" data-testid="stack-controller-never">
        No stack controller has reported yet. Enabling a backend records what you want; nothing is
        installed until the controller runs on this instance.
      </Alert>
    );
  }
  if (!c.reporting) {
    return (
      <Alert tone="warning" data-testid="stack-controller-stale">
        The stack controller has not reported since {formatRelative(c.lastSeenAt, now)}. The phases
        below are its last report, not the current state.
      </Alert>
    );
  }
  return (
    <p className="flex items-center gap-2 text-xs text-slate-500" data-testid="stack-controller-ok">
      <Badge variant="success">controller reporting</Badge>
      release <span className="font-mono text-slate-600">{c.release}</span> · last report{" "}
      {formatRelative(c.lastSeenAt, now)}
    </p>
  );
}

function PhaseCell({ b }: { b: StackBackendView }): React.JSX.Element {
  if (b.status === null) {
    return b.enabled ? (
      <Badge
        variant="unknown"
        data-testid={`stack-phase-${b.backend}`}
        title="Enabled, and not yet reported by the stack controller"
      >
        pending
      </Badge>
    ) : (
      <span
        className="text-slate-400"
        data-testid={`stack-phase-${b.backend}`}
        title="Never enabled"
      >
        —
      </span>
    );
  }
  return (
    <Badge variant={phaseTone(b.status.phase)} data-testid={`stack-phase-${b.backend}`}>
      {b.status.phase}
    </Badge>
  );
}

function BackendRow({
  b,
  token,
  busy,
  onWrite
}: {
  b: StackBackendView;
  token: string;
  busy: boolean;
  onWrite: (backend: StackBackend, enabled: boolean, sizeTier?: StackSizeTier) => void;
}): React.JSX.Element {
  const noToken = token === "";
  const s = b.status;
  return (
    <TableRow data-testid={`stack-row-${b.backend}`}>
      <TableCell className="font-medium text-slate-900">{DISPLAY[b.backend]}</TableCell>
      <TableCell>
        <PhaseCell b={b} />
      </TableCell>
      <TableCell
        className="font-mono text-xs text-slate-600"
        data-testid={`stack-running-${b.backend}`}
      >
        {s?.runningVersion ?? "—"}
        {s && s.targetVersion && s.targetVersion !== s.runningVersion ? (
          <span className="text-slate-500"> → {s.targetVersion}</span>
        ) : null}
      </TableCell>
      <TableCell>
        <select
          aria-label={`${DISPLAY[b.backend]} size`}
          className={selectClass}
          data-testid={`stack-size-${b.backend}`}
          value={b.sizeTier}
          disabled={noToken || busy || !b.enabled}
          title={noToken ? "Enter the operator credential to change the stack" : undefined}
          onChange={(e) => onWrite(b.backend, b.enabled, e.target.value as StackSizeTier)}
        >
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell className="max-w-md text-xs">
        {s && s.needs.length > 0 ? (
          <ul className="flex flex-col gap-1" data-testid={`stack-needs-${b.backend}`}>
            {s.needs.map((n) => (
              <li key={n.code} className="text-amber-800">
                {n.message}
              </li>
            ))}
          </ul>
        ) : null}
        {s?.lastError ? (
          <p className="mt-1 break-words text-red-700" data-testid={`stack-error-${b.backend}`}>
            {s.lastError}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant={b.enabled ? "outline" : "default"}
          data-testid={`stack-toggle-${b.backend}`}
          disabled={noToken || busy}
          title={noToken ? "Enter the operator credential to change the stack" : undefined}
          onClick={() => onWrite(b.backend, !b.enabled)}
        >
          {b.enabled ? "Disable" : "Enable"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function AdminStackPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const stack = useQuery({
    queryKey: stackKey(),
    queryFn: () => client.stack.get(),
    refetchInterval: 10_000
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();

  async function write(what: string, call: () => Promise<StackView | void>): Promise<void> {
    setBusy(true);
    setRefusal(null);
    setNotice(null);
    try {
      const result = await call();
      if (result) queryClient.setQueryData(stackKey(), result);
      setNotice(what);
    } catch (err) {
      setRefusal(refusalOf(err));
    } finally {
      setBusy(false);
    }
  }

  const onWrite = (backend: StackBackend, enabled: boolean, sizeTier?: StackSizeTier) =>
    void write(
      sizeTier
        ? `${DISPLAY[backend]} set to ${sizeTier}.`
        : `${DISPLAY[backend]} ${enabled ? "enabled" : "disabled"}.`,
      () => client.stack.putBackend(backend, { enabled, ...(sizeTier ? { sizeTier } : {}) }, token)
    );

  async function downloadDiagnostics(): Promise<void> {
    await write("Diagnostics downloaded.", async () => {
      const bundle = await client.stack.diagnostics(token);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `scp-stack-diagnostics-${bundle.generatedAt.replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const view = stack.data;
  const noToken = token === "";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Stack"
        description="The backends CommanderSCP installs and runs for this instance."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              icon={RefreshCw}
              data-testid="stack-upgrade"
              disabled={noToken || busy}
              title="Roll every enabled backend onto this release's versions — approves a held upgrade or retries one that was rolled back"
              onClick={() =>
                void write("Upgrade requested.", () => client.stack.requestUpgrade(token))
              }
            >
              Upgrade
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon={Download}
              data-testid="stack-diagnostics"
              disabled={noToken || busy}
              onClick={() => void downloadDiagnostics()}
            >
              Diagnostics
            </Button>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-slate-400" aria-hidden="true" />
            Operator credential
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Input
            type="password"
            autoComplete="off"
            placeholder="scp_op_…"
            aria-label="Operator credential"
            data-testid="stack-operator-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p
            className="text-xs text-slate-500"
            title="Changes here install or remove cluster software for every org on this instance, which no org role can grant. The credential stays in this page's memory and is sent only with those calls."
          >
            Needed to change the stack. Held in this page only, never stored.
          </p>
        </CardContent>
      </Card>

      {refusal !== null && (
        <Alert tone="danger" data-testid="stack-refusal">
          {refusal}
        </Alert>
      )}
      {notice !== null && refusal === null && (
        <Notice tone="success" data-testid="stack-notice">
          {notice}
        </Notice>
      )}

      {stack.isError ? (
        <QueryErrorNotice error={stack.error} what="the stack" testId="stack-error" />
      ) : view === undefined ? (
        <SkeletonRows n={5} />
      ) : (
        <>
          <ControllerLine view={view} now={now} />
          <Card size="flush">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Backend</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Needs</TableHead>
                  <TableHead className="text-right">
                    <ServerCog className="ml-auto size-4 text-slate-400" aria-label="Action" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {StackBackendSchema.options.map((backend) => {
                  const b = view.backends.find((x) => x.backend === backend);
                  return b ? (
                    <BackendRow key={backend} b={b} token={token} busy={busy} onWrite={onWrite} />
                  ) : null;
                })}
              </TableBody>
            </Table>
          </Card>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            Updates
            <select
              aria-label="Update policy"
              className={selectClass}
              data-testid="stack-update-policy"
              value={view.settings.updatePolicy}
              disabled={noToken || busy}
              onChange={(e) =>
                void write("Update policy saved.", () =>
                  client.stack.putSettings(
                    { updatePolicy: e.target.value as StackUpdatePolicy },
                    token
                  )
                )
              }
            >
              <option value="automatic">automatic</option>
              <option value="manual">manual</option>
            </select>
            <span title="Automatic: a new CommanderSCP release rolls the stack onto its versions, backend by backend, health-checked, falling back on failure. Manual: it waits for Upgrade.">
              when a new release is installed
            </span>
          </div>
        </>
      )}
    </div>
  );
}

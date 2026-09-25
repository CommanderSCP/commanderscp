import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, RefreshCw, ServerCog, ShieldCheck } from "lucide-react";
import {
  StackBackendSchema,
  type StackBackend,
  type StackBackendPhase,
  type StackBackendView,
  type StackServedOrgList,
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
import { Card } from "../components/ui/card";
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
 * Reading is an ordinary session call. Every change (enable, disable, size, purge, upgrade, the
 * update policy, the diagnostics download) needs the INSTANCE-OPERATOR ROLE on the same session —
 * owner decision 2026-09-25: authority is checked server-side against the normal login, and this
 * page never asks for, holds or sends a deployment credential. A user without the role sees the
 * stack and is told why the switches are off.
 *
 * Honesty (design spec §1.5): an enabled backend the controller has not reported is "pending", in
 * the amber-dashed unknown tone, never a guessed phase; a controller that has stopped reporting is
 * said so above the table, and its last report is labelled as such.
 *
 * M29.2 (ADR-0061): each backend's WIRING into SCP — where scpd reaches it, whether its scoped
 * token and TLS trust are handed over — with a Rotate action, and the organizations the stack
 * serves (its wired backends are registered in each). Serving another org is an instance
 * decision: every served org drives the same scoped backend accounts.
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

function WiringCell({ b }: { b: StackBackendView }): React.JSX.Element {
  const w = b.wiring;
  if (w === null) {
    return (
      <span
        className="text-xs text-slate-400"
        data-testid={`stack-wiring-${b.backend}`}
        title="SCP never calls this backend (it reads rollout state through Argo CD), so there is nothing to wire"
      >
        n/a
      </span>
    );
  }
  if (!w.wired) {
    return (
      <span className="text-xs text-slate-400" data-testid={`stack-wiring-${b.backend}`}>
        {b.enabled ? "not yet" : "—"}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5 text-xs" data-testid={`stack-wiring-${b.backend}`}>
      <Badge variant="success">wired</Badge>
      {w.serverUrl ? (
        <span className="font-mono text-slate-600" title="Where scpd reaches it">
          {w.serverUrl}
        </span>
      ) : (
        <span className="text-slate-500">registered (SCP does not call it)</span>
      )}
      {w.caSha256 ? (
        <span className="font-mono text-slate-400" title="sha256 of the CA scpd trusts for it">
          CA {w.caSha256.slice(0, 12)}…
        </span>
      ) : null}
    </span>
  );
}

function PurgeControl({
  backend,
  busy,
  onPurge
}: {
  backend: StackBackend;
  busy: boolean;
  onPurge: (backend: StackBackend) => void;
}): React.JSX.Element {
  // Typed-name confirm (design-system idiom 1): the operator retypes the backend's own name.
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid={`stack-purge-${backend}`}
        disabled={busy}
        title="Delete this disabled backend's retained data (volumes, generated secrets)"
        onClick={() => setOpen(true)}
      >
        Purge data
      </Button>
    );
  }
  return (
    <span className="flex items-center justify-end gap-2">
      <Input
        aria-label={`Type ${backend} to confirm`}
        placeholder={backend}
        className="h-8 w-40 text-xs"
        data-testid={`stack-purge-confirm-${backend}`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <Button
        size="sm"
        variant="destructive"
        data-testid={`stack-purge-go-${backend}`}
        disabled={busy || typed !== backend}
        onClick={() => onPurge(backend)}
      >
        Delete data
      </Button>
    </span>
  );
}

function BackendRow({
  b,
  canChange,
  busy,
  onWrite,
  onPurge,
  onRotate
}: {
  b: StackBackendView;
  canChange: boolean;
  busy: boolean;
  onWrite: (backend: StackBackend, enabled: boolean, sizeTier?: StackSizeTier) => void;
  onPurge: (backend: StackBackend) => void;
  onRotate: (backend: StackBackend) => void;
}): React.JSX.Element {
  const s = b.status;
  const why = canChange ? undefined : NO_ROLE;
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
          disabled={!canChange || busy || !b.enabled}
          title={why}
          onChange={(e) => onWrite(b.backend, b.enabled, e.target.value as StackSizeTier)}
        >
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </TableCell>
      <TableCell>
        <WiringCell b={b} />
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
        <span className="flex items-center justify-end gap-2">
          {!b.enabled && canChange ? (
            <PurgeControl backend={b.backend} busy={busy} onPurge={onPurge} />
          ) : null}
          {b.enabled && b.wiring?.wired && b.wiring.serverUrl ? (
            <Button
              size="sm"
              variant="outline"
              icon={KeyRound}
              data-testid={`stack-rotate-${b.backend}`}
              disabled={!canChange || busy}
              title={
                why ??
                "Rotate: the stack controller mints a new scoped token (for Argo Workflows also a new server certificate), hands it to SCP, and revokes the old one"
              }
              onClick={() => onRotate(b.backend)}
            >
              Rotate
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={b.enabled ? "outline" : "default"}
            data-testid={`stack-toggle-${b.backend}`}
            disabled={!canChange || busy}
            title={
              why ??
              (b.enabled
                ? "Disable: workloads are removed; volumes and generated secrets are kept until you purge them"
                : undefined)
            }
            onClick={() => onWrite(b.backend, !b.enabled)}
          >
            {b.enabled ? "Disable" : "Enable"}
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

const NO_ROLE =
  "Changing the stack needs the instance-operator role — ask an instance operator to grant it";

export const instanceOperatorSelfKey = (): unknown[] => ["instance-operator", "self"];
export const stackOrgsKey = (): unknown[] => ["stack", "orgs"];

/** M29.2: the organizations the stack serves — an instance operator's list and decision. */
function ServedOrgs({
  busy,
  onChange
}: {
  busy: boolean;
  onChange: (what: string, call: () => Promise<StackServedOrgList>) => void;
}): React.JSX.Element {
  const orgs = useQuery({ queryKey: stackOrgsKey(), queryFn: () => client.stack.orgs() });
  const [orgId, setOrgId] = useState("");
  return (
    <Card>
      <div className="flex flex-col gap-3" data-testid="stack-orgs">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Organizations served</h2>
          <p className="text-xs text-slate-500">
            Every wired backend is registered here as an execution system. The backends' accounts
            are shared, so one organization is served at a time until per-organization isolation
            (M29.6) lands: to move the stack, stop serving this one first.
          </p>
        </div>
        {orgs.isError ? (
          <QueryErrorNotice
            error={orgs.error}
            what="the served organizations"
            testId="stack-orgs-error"
          />
        ) : orgs.data === undefined ? (
          <SkeletonRows n={2} />
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {orgs.data.items.length === 0 ? (
              <li className="text-slate-500" data-testid="stack-orgs-none">
                None yet — the deployment's bootstrap organization is served when the first backend
                is wired.
              </li>
            ) : (
              orgs.data.items.map((o) => (
                <li
                  key={o.orgId}
                  className="flex items-center justify-between gap-2"
                  data-testid={`stack-org-${o.orgId}`}
                >
                  <span>
                    <span className="font-medium text-slate-900">{o.orgName}</span>{" "}
                    <span className="font-mono text-slate-400">{o.orgId}</span>{" "}
                    <span className="text-slate-500">
                      ·{" "}
                      {o.attachedBy.mechanism === "install"
                        ? "by default"
                        : `by ${o.attachedBy.username ?? o.attachedBy.mechanism}`}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`stack-org-detach-${o.orgId}`}
                    disabled={busy}
                    onClick={() =>
                      onChange(`${o.orgName} is no longer served.`, () =>
                        client.stack.detachOrg(o.orgId)
                      )
                    }
                  >
                    Stop serving
                  </Button>
                </li>
              ))
            )}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Input
            aria-label="Organization id to serve"
            placeholder="organization id"
            className="h-8 w-80 font-mono text-xs"
            data-testid="stack-org-attach-id"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value.trim())}
          />
          <Button
            size="sm"
            data-testid="stack-org-attach"
            disabled={busy || !/^[0-9a-f-]{36}$/i.test(orgId)}
            onClick={() => {
              onChange("Organization served.", () => client.stack.attachOrg(orgId));
              setOrgId("");
            }}
          >
            Serve
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function AdminStackPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const stack = useQuery({
    queryKey: stackKey(),
    queryFn: () => client.stack.get(),
    refetchInterval: 10_000
  });
  const role = useQuery({
    queryKey: instanceOperatorSelfKey(),
    queryFn: () => client.instanceOperators.self()
  });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();
  const canChange = role.data === true;

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
      () => client.stack.putBackend(backend, { enabled, ...(sizeTier ? { sizeTier } : {}) })
    );

  const onRotate = (backend: StackBackend) =>
    void write(
      `${DISPLAY[backend]}: rotation requested — the controller re-mints and hands over new credentials.`,
      () => client.stack.rotate(backend)
    );

  const onOrgs = (what: string, call: () => Promise<StackServedOrgList>) =>
    void write(what, async () => {
      queryClient.setQueryData(stackOrgsKey(), await call());
      await queryClient.invalidateQueries({ queryKey: stackKey() });
    });

  const onPurge = (backend: StackBackend) =>
    void write(`${DISPLAY[backend]}'s retained data will be deleted.`, () =>
      client.stack.purge(backend)
    );

  async function downloadDiagnostics(): Promise<void> {
    await write("Diagnostics downloaded.", async () => {
      const bundle = await client.stack.diagnostics();
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
              disabled={!canChange || busy}
              title={
                canChange
                  ? "Roll every enabled backend onto this release's versions — approves a held upgrade or retries one that was rolled back"
                  : NO_ROLE
              }
              onClick={() => void write("Upgrade requested.", () => client.stack.requestUpgrade())}
            >
              Upgrade
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon={Download}
              data-testid="stack-diagnostics"
              disabled={!canChange || busy}
              title={canChange ? undefined : NO_ROLE}
              onClick={() => void downloadDiagnostics()}
            >
              Diagnostics
            </Button>
          </>
        }
      />

      {role.isSuccess && !canChange ? (
        <Alert tone="info" data-testid="stack-no-role">
          <ShieldCheck className="mr-1 inline size-4" aria-hidden="true" />
          You can see the stack. Changing it needs the instance-operator role, because it installs
          and removes software for every organization on this instance — an instance operator grants
          it.
        </Alert>
      ) : null}

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
          {view.servesThisOrg !== null ? (
            <p className="text-xs text-slate-500" data-testid="stack-serves-this-org">
              {view.servesThisOrg
                ? "This organization is served: every wired backend is registered here as an execution system."
                : "This organization is not served by the Standard Stack — an instance operator decides which organizations it serves."}
            </p>
          ) : null}
          <Card size="flush">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Backend</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Wired into SCP</TableHead>
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
                    <BackendRow
                      key={backend}
                      b={b}
                      canChange={canChange}
                      busy={busy}
                      onWrite={onWrite}
                      onPurge={onPurge}
                      onRotate={onRotate}
                    />
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
              disabled={!canChange || busy}
              onChange={(e) =>
                void write("Update policy saved.", () =>
                  client.stack.putSettings({ updatePolicy: e.target.value as StackUpdatePolicy })
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
          {canChange ? <ServedOrgs busy={busy} onChange={onOrgs} /> : null}
        </>
      )}
    </div>
  );
}

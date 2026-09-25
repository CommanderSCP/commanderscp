import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import {
  STACK_WORKLOAD_IDENTITY_PROVIDERS,
  type StackCredentialKeyView,
  type StackCredentialState,
  type StackCredentialsView,
  type StackCredentialTarget,
  type StackWorkloadIdentityBinding,
  type StackWorkloadIdentityProvider,
  type StackWorkloadIdentityView
} from "@scp/schemas";
import { client } from "../lib/client";
import { cn, focusRing } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { SkeletonRows } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice } from "../components/query-error";

/**
 * ADMIN › STACK › CREDENTIALS (M29.5, ADR-0062). Credentials a bundled backend needs — a registry
 * push token, cloud credentials, a git token — entered ONCE here and written by the stack
 * controller into the backend's own Secret. WRITE-ONLY, by construction rather than by care: the
 * API has no route that returns a value, so this page can show which keys are set, by whom and when
 * they were delivered, and never what they are. A value typed here lives in the input until Save,
 * then is cleared; it is never put in query state or the URL.
 *
 * Workload identity is offered first where it applies: a declared identity means nothing needs
 * entering at all.
 */

export const stackCredentialsKey = (): unknown[] => ["stack", "credentials"];

const selectClass = cn(
  "flex h-8 rounded-md border border-slate-300 bg-white px-2 text-xs shadow-sm disabled:cursor-not-allowed disabled:opacity-50",
  focusRing
);

const STATE_TONE: Record<StackCredentialState, "success" | "info" | "danger" | "neutral"> = {
  set: "success",
  pending: "info",
  failed: "danger",
  unset: "neutral"
};

function KeyRow({
  k,
  busy,
  onSet,
  onDelete
}: {
  k: StackCredentialKeyView;
  busy: boolean;
  onSet: (t: StackCredentialTarget, value: string) => Promise<boolean>;
  onDelete: (t: StackCredentialTarget) => void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const id = `${k.secretName}-${k.key}`;
  const target = { backend: k.backend, secretName: k.secretName, key: k.key };
  return (
    <TableRow data-testid={`stack-credential-${id}`}>
      <TableCell>
        <div className="font-mono text-xs text-slate-900">{k.key}</div>
        <div className="text-xs text-slate-500">{k.description}</div>
      </TableCell>
      <TableCell>
        <Badge variant={STATE_TONE[k.state]} data-testid={`stack-credential-state-${id}`}>
          {k.pendingOp ? `${k.state} (${k.pendingOp})` : k.state}
        </Badge>
        {k.error ? (
          <div className="mt-1 text-xs text-red-700" data-testid={`stack-credential-error-${id}`}>
            {k.error}
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-slate-500">
        {k.requestedBy ? (k.requestedBy.username ?? k.requestedBy.mechanism) : "—"}
        {k.deliveredAt ? <div>delivered {k.deliveredAt}</div> : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label={`New value for ${k.key}`}
            placeholder={k.state === "set" ? "replace…" : "value"}
            className="h-8 w-48 text-xs"
            data-testid={`stack-credential-input-${id}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            size="sm"
            icon={KeyRound}
            data-testid={`stack-credential-save-${id}`}
            disabled={busy || value.length === 0}
            onClick={() =>
              void onSet(target, value).then((ok) => {
                if (ok) setValue("");
              })
            }
          >
            {k.state === "set" ? "Replace" : "Set"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={Trash2}
            aria-label={`Remove ${k.key}`}
            data-testid={`stack-credential-delete-${id}`}
            disabled={busy || k.state === "unset"}
            onClick={() => onDelete(target)}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function IdentityRow({
  w,
  busy,
  onDeclare,
  onWithdraw
}: {
  w: StackWorkloadIdentityView;
  busy: boolean;
  onDeclare: (w: StackWorkloadIdentityView, b: StackWorkloadIdentityBinding) => void;
  onWithdraw: (w: StackWorkloadIdentityView) => void;
}): React.JSX.Element {
  const [provider, setProvider] = useState<StackWorkloadIdentityProvider>(
    w.binding?.provider ?? "aws-irsa"
  );
  const [identifier, setIdentifier] = useState(w.binding?.identifier ?? "");
  const p = STACK_WORKLOAD_IDENTITY_PROVIDERS[provider];
  const valid = new RegExp(p.pattern).test(identifier);
  const id = `${w.backend}-${w.serviceAccount}`;
  return (
    <TableRow data-testid={`stack-identity-${id}`}>
      <TableCell>
        <div className="font-mono text-xs text-slate-900">
          {w.backend} / {w.serviceAccount}
        </div>
        <div className="text-xs text-slate-500">{w.description}</div>
      </TableCell>
      <TableCell>
        {w.binding ? (
          <Badge variant="success" data-testid={`stack-identity-state-${id}`}>
            {STACK_WORKLOAD_IDENTITY_PROVIDERS[w.binding.provider].label}
          </Badge>
        ) : (
          <Badge variant="neutral" data-testid={`stack-identity-state-${id}`}>
            not declared
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <select
            aria-label={`Workload identity provider for ${w.serviceAccount}`}
            className={selectClass}
            value={provider}
            disabled={busy}
            onChange={(e) => setProvider(e.target.value as StackWorkloadIdentityProvider)}
          >
            {Object.entries(STACK_WORKLOAD_IDENTITY_PROVIDERS).map(([key, v]) => (
              <option key={key} value={key}>
                {v.label}
              </option>
            ))}
          </select>
          <Input
            aria-label={`${p.identifier} for ${w.serviceAccount}`}
            placeholder={p.identifier}
            className="h-8 w-72 font-mono text-xs"
            data-testid={`stack-identity-input-${id}`}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value.trim())}
          />
          <Button
            size="sm"
            data-testid={`stack-identity-save-${id}`}
            disabled={busy || !valid}
            title={valid ? undefined : `Enter a valid ${p.identifier}`}
            onClick={() => onDeclare(w, { provider, identifier } as StackWorkloadIdentityBinding)}
          >
            Declare
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid={`stack-identity-withdraw-${id}`}
            disabled={busy || w.binding === null}
            onClick={() => onWithdraw(w)}
          >
            Withdraw
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function StackCredentials({
  busy,
  write
}: {
  busy: boolean;
  /** The page's audited-write wrapper: sets busy, shows the refusal or the notice. */
  write: (what: string, call: () => Promise<void>) => Promise<boolean>;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const creds = useQuery({
    queryKey: stackCredentialsKey(),
    queryFn: () => client.stack.credentials(),
    refetchInterval: 10_000
  });
  const refresh = (v?: StackCredentialsView) =>
    v
      ? queryClient.setQueryData(stackCredentialsKey(), v)
      : queryClient.invalidateQueries({ queryKey: stackCredentialsKey() });

  const onSet = (t: StackCredentialTarget, value: string) =>
    write(`${t.key}: sent to the stack controller, sealed — SCP keeps no copy.`, async () => {
      await client.stack.setCredential(t, value);
      await refresh();
    });
  const onDelete = (t: StackCredentialTarget) =>
    void write(`${t.key}: the stack controller will remove it.`, async () => {
      await client.stack.deleteCredential(t);
      await refresh();
    });
  const onDeclare = (w: StackWorkloadIdentityView, b: StackWorkloadIdentityBinding) =>
    void write(`${w.serviceAccount}: workload identity declared.`, async () => {
      refresh(
        await client.stack.putWorkloadIdentity(
          { backend: w.backend, serviceAccount: w.serviceAccount },
          b
        )
      );
    });
  const onWithdraw = (w: StackWorkloadIdentityView) =>
    void write(`${w.serviceAccount}: workload identity withdrawn.`, async () => {
      refresh(
        await client.stack.deleteWorkloadIdentity({
          backend: w.backend,
          serviceAccount: w.serviceAccount
        })
      );
    });

  return (
    <Card>
      <div className="flex flex-col gap-4" data-testid="stack-credentials">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Credentials</h2>
          <p className="text-xs text-slate-500">
            Entered once here and written by the stack controller into the backend's own Secret.
            CommanderSCP keeps no copy and cannot show one — a key can be replaced or removed, never
            read. Where the cluster supports workload identity, declare it below instead: then there
            is nothing to enter.
          </p>
        </div>
        {creds.isError ? (
          <QueryErrorNotice
            error={creds.error}
            what="the credentials"
            testId="stack-credentials-error"
          />
        ) : creds.data === undefined ? (
          <SkeletonRows n={3} />
        ) : (
          <>
            {!creds.data.sealingKey.published ? (
              <p className="text-xs text-amber-700" data-testid="stack-credentials-no-key">
                The stack controller has not published its sealing key yet, so no value can be
                entered — it does so on its first run.
              </p>
            ) : null}
            {creds.data.secrets.map((s) => (
              <div key={s.secretName} className="flex flex-col gap-1">
                <div className="text-xs">
                  <span className="font-mono font-medium text-slate-900">{s.secretName}</span>{" "}
                  <span className="text-slate-500">
                    ({s.backend}) — {s.purpose}
                  </span>
                </div>
                <Card size="flush">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Entered by</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.keys.map((k) => (
                        <KeyRow
                          key={k.key}
                          k={k}
                          busy={busy || !creds.data.sealingKey.published}
                          onSet={onSet}
                          onDelete={onDelete}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-slate-900">Workload identity</div>
              <Card size="flush">
                <Table>
                  <TableBody>
                    {creds.data.workloadIdentities.map((w) => (
                      <IdentityRow
                        key={`${w.backend}/${w.serviceAccount}`}
                        w={w}
                        busy={busy}
                        onDeclare={onDeclare}
                        onWithdraw={onWithdraw}
                      />
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

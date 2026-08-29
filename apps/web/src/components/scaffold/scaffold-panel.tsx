import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DiscoveryProposal, ScaffoldDiscoveryResponse } from "@scp/schemas";
import { client } from "../../lib/client";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SectionLabel } from "../ui/section-label";

/**
 * THE SCAFFOLDER — what `/connect` does now that `POST /discovery/accept` is gone (ADR-0047;
 * team-pipeline-iac D1, section 7).
 *
 * ============================================================================================
 * WHAT CHANGED, AND WHY THE GROUPING INPUT IS THE WHOLE POINT
 * ============================================================================================
 * The wizard used to end by WRITING the proposal into the graph. That path bypassed strict create,
 * and the homelab's ~50 imported components landed as RBAC orphans through it — a component with no
 * owning service, invisible to every scope-based permission and every service-shaped read.
 *
 * ADR-0047's fix is not a validation: it is moving the decision to where a human is. So this panel
 * asks the ONE question the old flow never did — which service does each component belong to? — and
 * then emits code rather than rows. Nothing here writes to the graph; the operator commits the
 * output and a normal `scp apply` lands it, through the same strict doors as any other IaC.
 *
 * UNGROUPED COMPONENTS ARE SHOWN, NEVER DEFAULTED. The server returns them separately and they are
 * never in the emitted code — a `Component` cannot be constructed without a service. Defaulting them
 * to some invented service name is exactly the silent orphan-making this replaced.
 *
 * THE EMITTER RUNS SERVER-SIDE, and that is an architectural rule rather than a preference:
 * `apps/web/src` may import only `@scp/sdk` and `@scp/schemas` — never `@scp/iac`, `@scp/cli` or the
 * server (eslint `no-restricted-imports`). The UI reaches everything through the public API, so it
 * asks `POST /discovery/scaffold` and renders the answer. One emitter, behind the API, shared with
 * `scp iac scaffold` — so the wizard and the CLI cannot produce different code from one proposal.
 */

export interface ScaffoldPanelProps {
  readonly proposal: DiscoveryProposal;
  /** Test hook + wizard chrome: what to call the copy affordance's target. */
  readonly testIdPrefix?: string;
  /** The one API call this panel makes. Injected so tests drive the panel without a server, the
   *  same door-double idiom the wizards use. */
  readonly scaffold?: (
    proposal: DiscoveryProposal,
    group: Record<string, string>
  ) => Promise<ScaffoldDiscoveryResponse>;
}

export function ScaffoldPanel({
  proposal,
  testIdPrefix = "scaffold",
  scaffold = (p, group) => client.discovery.scaffold({ proposal: p, group })
}: ScaffoldPanelProps): JSX.Element {
  const componentNames = useMemo(
    () => proposal.objects.filter((o) => o.typeId === "component").map((o) => o.name),
    [proposal]
  );

  // One service per component. `applyToAll` is sugar for the common case (a whole ArgoCD project
  // is one service) and writes real per-component values rather than a hidden default — so what
  // the operator sees in the fields is exactly what the emitted code uses.
  const [group, setGroup] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState("");

  // Re-queried whenever the grouping changes: the server owns both halves of the answer (which
  // stacks, and which components were left ungrouped), so there is nothing to recompute here and
  // no second definition of "ungrouped" to drift.
  const scaffoldQuery = useQuery({
    queryKey: ["discovery-scaffold", proposal, group],
    queryFn: () => scaffold(proposal, group)
  });
  const rendered = scaffoldQuery.data?.stacks ?? [];
  const ungrouped = scaffoldQuery.data?.ungrouped ?? [];

  const [copied, setCopied] = useState(false);
  const allSource = rendered.map((r) => r.source).join("\n\n");

  return (
    <div className="space-y-4" data-testid={`${testIdPrefix}-panel`}>
      <Alert tone="info" data-testid={`${testIdPrefix}-no-write-notice`}>
        Nothing here is written to the graph. This emits <strong>IaC you commit</strong> — review
        it, put it in the component&apos;s repo, and a normal <code>scp apply</code> lands it
        through the same doors as any other stack.
      </Alert>

      <div className="space-y-2">
        <SectionLabel>Which service does each component belong to?</SectionLabel>
        <p className="text-xs text-slate-500" data-testid={`${testIdPrefix}-grouping-why`}>
          A component must belong to a service. Answering here is what stops these landing as
          orphans — which is what the old import did.
        </p>

        {componentNames.length > 1 && (
          <div className="flex items-center gap-2">
            <Input
              aria-label="Service for every component"
              placeholder="one service for all of them"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              data-testid={`${testIdPrefix}-bulk-input`}
            />
            <Button
              type="button"
              variant="outline"
              disabled={bulk.trim() === ""}
              onClick={() =>
                setGroup(Object.fromEntries(componentNames.map((n) => [n, bulk.trim()])))
              }
              data-testid={`${testIdPrefix}-apply-all`}
            >
              Apply to all
            </Button>
          </div>
        )}

        <ul className="space-y-1">
          {componentNames.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <span className="w-1/2 font-mono text-sm">{name}</span>
              <Input
                aria-label={`Service for ${name}`}
                placeholder="service name"
                value={group[name] ?? ""}
                onChange={(e) => setGroup((g) => ({ ...g, [name]: e.target.value }))}
                data-testid={`${testIdPrefix}-service-input`}
              />
            </li>
          ))}
        </ul>
      </div>

      {ungrouped.length > 0 && (
        <Alert tone="warning" data-testid={`${testIdPrefix}-ungrouped`}>
          <strong>
            {ungrouped.length} component(s) have no service and are NOT in the code below:
          </strong>{" "}
          {ungrouped.map((u) => u.name).join(", ")}. Name a service for each, or they are left
          behind — deliberately, because a component without one is an orphan.
        </Alert>
      )}

      {rendered.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <SectionLabel>
              {rendered.length === 1 ? "scp/stack.ts" : `${rendered.length} stacks`}
            </SectionLabel>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(allSource);
                setCopied(true);
              }}
              data-testid={`${testIdPrefix}-copy`}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre
            className="max-h-96 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100"
            data-testid={`${testIdPrefix}-source`}
          >
            {allSource}
          </pre>
        </div>
      )}
    </div>
  );
}

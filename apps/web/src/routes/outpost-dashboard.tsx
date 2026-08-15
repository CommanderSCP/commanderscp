import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight, EyeOff, Server } from "lucide-react";
import type { ExecutorBinding, GraphObject } from "@scp/schemas";
import { client } from "../lib/client";
import { federationSelfKey, registryListKey } from "../lib/query-client";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import { SkeletonRows } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { QueryErrorNotice } from "../components/query-error";
import { DomainLocalBadge } from "../components/domain-local";
import { OutpostFort } from "../components/icons/federation-roles";

/**
 * THE OUTPOST SITE'S HOME (outpost-ui.md §9.3, owner decisions 2026-08-14) — a small, component-
 * level dashboard, not the commander's org-wide one:
 *
 *   the deployment targets THIS OUTPOST CONTROLS
 *     → the components placed on each
 *       → the DOMAIN-SPECIFIC IaC / CaC pipelines (the biggest thing the commander doesn't own)
 *
 * "Controls" is READ, not inferred: a target is this outpost's when its `originDomainId` equals
 * this instance's `federation_self.domainId` — the same fact `coordination/component-pipeline.ts`'s
 * `maintainedBy.isSelf` states per stage. A commander-origin target that has been replicated here
 * is NOT this outpost's; it appears (honestly) as "maintained by <peer>" in the pipeline views and
 * is deliberately absent from this page.
 *
 * "Domain-specific IaC/CaC" = executor bindings of Type `infrastructure` / `configuration`
 * (ADR-0007's facet) whose target is one of the above, or whose bound object is domain-local
 * (ADR-0031). Global IaC/CaC — bindings on commander-origin objects — is the commander's and stays
 * off this page for the same reason its targets do.
 *
 * Nothing here reads the instance's ROLE to decide what to render — the SHELL picked this page by
 * role (§9.2), and inside it every row keys on data. If this outpost controls no targets yet, the
 * page says so and points at the setup lane; it does not go looking for the commander's targets to
 * fill the space.
 */

const IAC_CAC_TYPES = new Set(["infrastructure", "configuration"]);

function placementIds(p: GraphObject): { componentId: string | null; targetId: string | null } {
  const props = p.properties as { componentId?: unknown; deploymentTargetId?: unknown };
  return {
    componentId: typeof props.componentId === "string" ? props.componentId : null,
    targetId: typeof props.deploymentTargetId === "string" ? props.deploymentTargetId : null
  };
}

export function OutpostDashboardPage(): React.JSX.Element {
  const selfQuery = useQuery({
    queryKey: federationSelfKey(),
    queryFn: () => client.federation.self(),
    staleTime: 300_000
  });
  const targetsQuery = useQuery({
    queryKey: registryListKey("deployment-targets"),
    queryFn: () => client.deploymentTargets.list({ limit: 100 })
  });
  const placementsQuery = useQuery({
    queryKey: [...registryListKey("placements"), "outpost-dashboard"],
    queryFn: () => client.placements.list({ limit: 100 })
  });
  const componentsQuery = useQuery({
    queryKey: registryListKey("components"),
    queryFn: () => client.components.list({ limit: 100 })
  });

  const selfDomainId = selfQuery.data?.domainId ?? null;
  const allTargets = targetsQuery.data?.items ?? [];
  // READ: ours = origin matches self. Null self (federation not initialised) → nothing is ours,
  // and the empty state below says why rather than pretending every target is ours.
  const myTargets = selfDomainId
    ? allTargets.filter((t) => t.originDomainId === selfDomainId)
    : [];
  const foreignTargetCount = allTargets.length - myTargets.length;

  const bindingQueries = useQueries({
    queries: myTargets.map((t) => ({
      queryKey: ["executor-bindings", t.id],
      queryFn: () => client.executors.listBindings(t.id)
    }))
  });

  const componentsById = new Map((componentsQuery.data?.items ?? []).map((c) => [c.id, c]));
  const placementsByTarget = new Map<string, GraphObject[]>();
  for (const p of placementsQuery.data?.items ?? []) {
    const { targetId } = placementIds(p);
    if (!targetId) continue;
    const list = placementsByTarget.get(targetId) ?? [];
    list.push(p);
    placementsByTarget.set(targetId, list);
  }

  const loading =
    selfQuery.isLoading || targetsQuery.isLoading || placementsQuery.isLoading || componentsQuery.isLoading;

  const domainLocalComponents = (componentsQuery.data?.items ?? []).filter((c) => c.domainLocal);
  const iacCacBindings = bindingQueries
    .flatMap((q) => q.data ?? [])
    .filter((b) => IAC_CAC_TYPES.has(b.type));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={
          selfQuery.data?.name ? (
            <span className="flex items-center gap-1.5">
              <OutpostFort className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              {selfQuery.data.name} — the targets this outpost controls, what runs on them, and
              this domain&apos;s own IaC and CaC.
            </span>
          ) : undefined
        }
      />

      {loading ? (
        <SkeletonRows n={4} />
      ) : targetsQuery.isError ? (
        <QueryErrorNotice error={targetsQuery.error} what="deployment targets" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Targets this outpost controls"
              value={myTargets.length}
              data-testid="outpost-stat-targets"
            />
            <StatCard
              label="Domain-local components"
              value={domainLocalComponents.length}
              hint={
                componentsQuery.data && componentsQuery.data.items.length >= 100
                  ? "of the first 100 components fetched"
                  : undefined
              }
              data-testid="outpost-stat-domain-local"
            />
            <StatCard
              label="Domain IaC / CaC pipelines"
              value={iacCacBindings.length}
              hint="infrastructure + configuration bindings on this outpost's targets"
              data-testid="outpost-stat-iac-cac"
            />
          </div>

          <div>
            <SectionLabel as="h2" className="mb-3">
              Targets this outpost controls
            </SectionLabel>
            {myTargets.length === 0 ? (
              <EmptyState
                icon={Server}
                message={
                  !selfDomainId
                    ? "Federation isn't initialised on this instance yet, so no target can be attributed to it."
                    : foreignTargetCount > 0
                      ? `No target is maintained by this outpost yet. ${foreignTargetCount} target${foreignTargetCount === 1 ? " is" : "s are"} known here but maintained by another domain — they stay off this page.`
                      : "No deployment targets yet — import or add one from Setup."
                }
                data-testid="outpost-no-targets"
                action={
                  <Link to="/setup" className="inline-flex items-center gap-1 text-sm font-medium text-army-700 hover:underline">
                    Open Setup <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
                  </Link>
                }
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {myTargets.map((target, i) => (
                  <TargetCard
                    key={target.id}
                    target={target}
                    placements={placementsByTarget.get(target.id) ?? []}
                    componentsById={componentsById}
                    bindings={bindingQueries[i]?.data ?? []}
                    bindingsLoading={bindingQueries[i]?.isLoading ?? false}
                  />
                ))}
              </div>
            )}
          </div>

          {domainLocalComponents.length > 0 && (
            <div>
              <SectionLabel as="h2" className="mb-3">
                Domain-local components
              </SectionLabel>
              <Card>
                <CardContent className="pt-4">
                  <ul className="flex flex-col divide-y divide-slate-100">
                    {domainLocalComponents.map((c) => (
                      <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                        <span className="flex items-center gap-2">
                          <Link
                            to="/components/$idOrUrn"
                            params={{ idOrUrn: c.id }}
                            className="font-medium text-slate-900 hover:underline"
                          >
                            {c.name}
                          </Link>
                          <DomainLocalBadge inheritedFrom={c.domainLocalInheritedFrom} />
                        </span>
                        <span className="font-mono text-xs text-slate-500">{c.urn}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One target this outpost controls: what's placed on it, and its IaC/CaC bindings. */
function TargetCard({
  target,
  placements,
  componentsById,
  bindings,
  bindingsLoading
}: {
  target: GraphObject;
  placements: GraphObject[];
  componentsById: Map<string, GraphObject>;
  bindings: ExecutorBinding[];
  bindingsLoading: boolean;
}): React.JSX.Element {
  const iacCac = bindings.filter((b) => IAC_CAC_TYPES.has(b.type));
  return (
    <Card data-testid="outpost-target-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4 shrink-0 text-army-600" strokeWidth={2} aria-hidden="true" />
          <Link
            to="/$basePath/$idOrUrn"
            params={{ basePath: "deployment-targets", idOrUrn: target.id }}
            className="hover:underline"
          >
            {target.name}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div>
          <SectionLabel className="mb-1.5">Placed here</SectionLabel>
          {placements.length === 0 ? (
            <p className="text-slate-500">Nothing is placed on this target yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {placements.map((p) => {
                const { componentId } = placementIds(p);
                const component = componentId ? componentsById.get(componentId) : undefined;
                return (
                  <li key={p.id} className="flex items-center gap-2">
                    {component ? (
                      <>
                        <Link
                          to="/components/$idOrUrn"
                          params={{ idOrUrn: component.id }}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {component.name}
                        </Link>
                        {component.domainLocal && (
                          <Badge variant="neutral" icon={EyeOff} title="Domain-local — never leaves this domain (ADR-0031).">
                            domain-local
                          </Badge>
                        )}
                      </>
                    ) : (
                      // The placement names a component this page's first-100 fetch didn't
                      // include (or a since-deleted one) — say so, don't invent a name.
                      <span className="font-mono text-xs text-slate-500" title="Component not in the fetched page.">
                        {componentId ?? "(unnamed component)"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <SectionLabel className="mb-1.5">Domain IaC / CaC pipelines</SectionLabel>
          {bindingsLoading ? (
            <SkeletonRows n={1} />
          ) : iacCac.length === 0 ? (
            <p className="text-slate-500" data-testid="outpost-target-no-iac-cac">
              No infrastructure or configuration pipeline is bound at this target — its substrate and
              config are managed elsewhere, or not by CommanderSCP.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {iacCac.map((b) => (
                <li key={`${b.targetObjectId}-${b.type}`} className="flex items-center gap-2" data-testid="outpost-iac-cac-binding">
                  <Badge variant="neutral">{b.type}</Badge>
                  <span className="text-slate-700">{b.pluginModule}</span>
                  {b.externalRef && <span className="font-mono text-xs text-slate-500">{b.externalRef}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

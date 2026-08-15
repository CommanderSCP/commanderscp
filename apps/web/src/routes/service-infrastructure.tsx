import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, Info } from "lucide-react";
import { CommanderStar, OutpostFort } from "../components/icons/federation-roles";
import { client } from "../lib/client";
import { serviceBoardKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { Skeleton } from "../components/ui/skeleton";
import { QueryErrorNotice } from "../components/query-error";
import { CATEGORY_LABEL } from "./service-board";

/**
 * `/services/$idOrUrn/infrastructure` — the pipelines bound to the SERVICE ITSELF.
 *
 * Infrastructure often serves a whole service: a cluster, a shared database, a VPC stands up once
 * and every component runs on top. Declaring that as N identical component bindings is duplication
 * that drifts the moment a component is added, so it is declared once on the service.
 *
 * This is a real pipeline, not a label, only because ADR-0027 added the SERVICE rung to
 * `resolveBindingForTarget`. Before it, a binding here was inert config that ALSO blocked releases
 * (fail-closed `no_executor`) — which is why the rung landed before this tab did, rather than the
 * view arriving first and implying an execution path that did not exist.
 *
 * It reads the SAME board response the Board tab does (one cached query, no second endpoint): the
 * per-pipeline summary is computed once server-side for both.
 */
export function ServiceInfrastructurePage(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const query = useQuery({
    queryKey: serviceBoardKey(idOrUrn ?? ""),
    queryFn: () => client.services.board(idOrUrn!),
    enabled: Boolean(idOrUrn)
  });

  if (query.isLoading) {
    return (
      <div className="space-y-4" data-testid="service-infrastructure">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (query.error) {
    return (
      <QueryErrorNotice
        error={query.error}
        what="this service's infrastructure"
        testId="service-infra-error"
      />
    );
  }
  const board = query.data;
  if (!board) return <p className="text-sm text-slate-500">No service.</p>;

  const bound = board.servicePipelines.filter((p) => p.bound);
  // outpost-ui.md §9.3a — the SAME two source shapes the component pipeline renders, one rung up.
  // A service maintained by another domain (on an outpost: the commander) has that domain
  // UPSTREAM of whatever shared IaC/CaC this domain binds under it; a self-maintained or
  // domain-local service is this domain's own — nothing ahead of it. Read from the board's
  // `service.maintainedBy`/`domainLocal`, never inferred.
  const upstream = board.service.maintainedBy;
  const hasUpstream = !upstream.isSelf && upstream.domainId !== null && !board.service.domainLocal;

  return (
    <div className="space-y-4" data-testid="service-infrastructure">
      <PageHeader
        title={board.service.name}
        description={<span className="font-mono text-xs break-all">{board.service.urn}</span>}
        meta={
          hasUpstream ? (
            <span
              className="flex items-center gap-1.5 text-xs text-slate-700"
              data-testid="service-infra-upstream"
              title={`This service is maintained by ${upstream.name ?? upstream.domainId} — its shared infrastructure and configuration are authored there; anything bound here is this domain's local hop.`}
            >
              {upstream.role === "commander" ? (
                <CommanderStar className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              ) : (
                <OutpostFort className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
              )}
              <span className="font-medium">{upstream.name ?? upstream.domainId}</span>
              <span className="text-slate-400">upstream</span>
              <ArrowRight className="size-3.5 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
              <span className="text-slate-500">shared IaC / CaC bound in this domain</span>
            </span>
          ) : board.service.domainLocal ? (
            <span className="text-xs text-slate-500" data-testid="service-infra-no-upstream">
              Domain-local — shared infrastructure and configuration bound here are this
              domain&apos;s own; nothing upstream of them.
            </span>
          ) : undefined
        }
      />

      {bound.length === 0 ? (
        // Rendered, not omitted. "Nothing is bound at the service" is a fact about this service;
        // an empty tab would read as "this view cannot show it". The full rationale for WHY a
        // service-level binding exists moves into the Info icon's tooltip (copy rule 1).
        <Card data-testid="service-infra-none">
          <CardContent className="flex items-center gap-1.5 py-6 text-sm text-slate-600">
            Nothing bound at the service — every pipeline here is declared per component.
            <span title="Infrastructure that serves the whole service — a cluster, a shared database — can be bound once on the service instead, and it will drive every component under it.">
              <Info className="size-3.5 shrink-0 text-slate-400" strokeWidth={1.75} aria-hidden="true" />
            </span>
          </CardContent>
        </Card>
      ) : (
        bound.map((pipeline) => (
          <Card key={pipeline.category} data-testid="service-infra-pipeline">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                {CATEGORY_LABEL[pipeline.category] ?? pipeline.category} pipeline
              </CardTitle>
              <p className="text-[11px] leading-snug text-slate-400">
                bound at the service — it drives every component under it
              </p>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-slate-600">
              {pipeline.bindings.map((b) => (
                <div key={`${b.type}:${b.externalRef}`} data-testid="service-infra-executor">
                  <span className="text-slate-400">{b.type}</span>{" "}
                  {b.url ? (
                    <a
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                      title={b.url}
                    >
                      <span className="font-mono">{b.externalRef || "—"}</span>
                      {b.executionSystemName ? ` @ ${b.executionSystemName}` : ""}
                      <ExternalLink className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                    </a>
                  ) : (
                    <>
                      <span className="font-mono">{b.externalRef || "—"}</span>
                      {b.executionSystemName ? ` @ ${b.executionSystemName}` : ""}
                    </>
                  )}
                </div>
              ))}
              <p className="pt-1 text-slate-400" data-testid="service-infra-serves">
                Serves {board.rows.length} component{board.rows.length === 1 ? "" : "s"} in this
                service.
              </p>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

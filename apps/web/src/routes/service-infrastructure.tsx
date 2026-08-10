import { useQuery } from "@tanstack/react-query";
import { client } from "../lib/client";
import { serviceBoardKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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

  if (query.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (query.error) {
    return (
      <p className="text-sm text-red-600" data-testid="service-infra-error">
        {(query.error as Error).message}
      </p>
    );
  }
  const board = query.data;
  if (!board) return <p className="text-sm text-slate-500">No service.</p>;

  const bound = board.servicePipelines.filter((p) => p.bound);

  return (
    <div className="space-y-4" data-testid="service-infrastructure">
      <div>
        <h1 className="text-xl font-semibold">{board.service.name}</h1>
        <p className="font-mono text-xs text-slate-500">{board.service.urn}</p>
      </div>

      {bound.length === 0 ? (
        // Rendered, not omitted. "Nothing is bound at the service" is a fact about this service;
        // an empty tab would read as "this view cannot show it".
        <Card data-testid="service-infra-none">
          <CardContent className="py-6 text-sm text-slate-600">
            Nothing is bound at the service itself, so every pipeline here is declared per
            component. Infrastructure that serves the whole service — a cluster, a shared database —
            can be bound once on the service instead, and it will drive every component under it.
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
                      className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                      title={b.url}
                    >
                      <span className="font-mono">{b.externalRef || "—"}</span>
                      {b.executionSystemName ? ` @ ${b.executionSystemName}` : ""} ↗
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

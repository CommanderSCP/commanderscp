import { Link, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { ComponentCrate } from "../components/icons/catalog-marks";
import { client } from "../lib/client";
import { assemblyBoardKey } from "../lib/query-client";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";
import { Card, CardContent } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { StatCard } from "../components/ui/stat-card";
import { EmptyState } from "../components/ui/empty-state";
import { Skeleton, SkeletonRows } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice } from "../components/query-error";

type RouterLinkProps = React.ComponentProps<typeof Link>;

/** An outline `Button`-styled router `Link`. See docs/web.md §184. */
function LinkButton({
  to,
  params,
  children
}: {
  to: RouterLinkProps["to"];
  params?: Record<string, string>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={to}
      params={params as unknown as RouterLinkProps["params"]}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-900 transition-colors hover:bg-slate-100",
        focusRing
      )}
    >
      {children}
      <ArrowRight className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
    </Link>
  );
}

/** One assembly: the layout and board, mirroring the service. See docs/web.md §185. */

// The accent (army olive since 2026-08-11) marks the active tab (spec standing decision — "active nav" is one of the accent's
// four sanctioned homes), consistent with `service-detail.tsx`'s identical tab nav.
const TAB_BASE = cn(
  "border-b-2 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-army-800",
  focusRing
);
const TAB_ACTIVE = "border-army-700 text-army-800";
const TAB_INACTIVE = "border-transparent";

export function AssemblyDetailLayout(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b border-army-200" data-testid="assembly-tabs">
        <Link
          to="/assemblies/$idOrUrn"
          params={{ idOrUrn }}
          activeOptions={{ exact: true }}
          className={cn(TAB_BASE, TAB_INACTIVE)}
          activeProps={{ className: cn(TAB_BASE, TAB_ACTIVE) }}
          data-testid="assembly-tab-board"
        >
          Board
        </Link>
        <Link
          to="/assemblies/$idOrUrn/settings"
          params={{ idOrUrn }}
          className={cn(TAB_BASE, TAB_INACTIVE)}
          activeProps={{ className: cn(TAB_BASE, TAB_ACTIVE) }}
          data-testid="assembly-tab-settings"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

export function AssemblyBoardPage(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();

  const assemblyQuery = useQuery({
    queryKey: assemblyBoardKey(idOrUrn ?? "", "self"),
    queryFn: () => client.assemblies.get(idOrUrn!),
    enabled: !!idOrUrn
  });

  // The assembly's components, one hop out along `contains` — the same edge `containmentChain`
  // walks server-side. `maxDepth: 1` because containment is capped at service -> assembly ->
  // component: an assembly never contains another assembly (relationships-repo.ts refuses it).
  const membersQuery = useQuery({
    queryKey: assemblyBoardKey(idOrUrn ?? "", "members"),
    queryFn: () =>
      client.graph.traverse({
        objectId: assemblyQuery.data!.id,
        direction: "out",
        relTypes: ["contains"],
        maxDepth: 1
      }),
    enabled: !!assemblyQuery.data?.id
  });

  if (assemblyQuery.isError) {
    return <QueryErrorNotice error={assemblyQuery.error} what="this assembly" />;
  }
  if (membersQuery.isError) {
    return <QueryErrorNotice error={membersQuery.error} what="this assembly's components" />;
  }
  if (!assemblyQuery.data || membersQuery.isPending) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <SkeletonRows n={3} />
      </div>
    );
  }

  // `traverse` returns the ROOT alongside everything it reached; the assembly is not its own member.
  const components = (membersQuery.data.objects ?? []).filter(
    (o) => o.id !== assemblyQuery.data.id && o.typeId === "component"
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title={<span data-testid="assembly-name">{assemblyQuery.data.name}</span>}
        backTo="/$basePath"
        backParams={{ basePath: "assemblies" }}
        backLabel="Assemblies"
      />

      <StatCard
        label="Components"
        value={components.length}
        icon={ComponentCrate}
        className="w-fit"
      />

      <Card>
        <CardContent className="pt-6">
          {components.length === 0 ? (
            <EmptyState icon={ComponentCrate} message="No components yet." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Component</TableHead>
                  <TableHead>URN</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {components.map((c) => (
                  <TableRow key={c.id} data-testid="assembly-component-row">
                    <TableCell>
                      <Link
                        to="/components/$idOrUrn"
                        params={{ idOrUrn: c.id }}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-500">{c.urn}</TableCell>
                    <TableCell className="text-right">
                      <LinkButton to="/components/$idOrUrn" params={{ idOrUrn: c.id }}>
                        Pipeline
                      </LinkButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

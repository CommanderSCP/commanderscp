import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { ServiceGuidon } from "../components/icons/catalog-marks";
import { client } from "../lib/client";
import { findRegistry, getRegistryClient, type RegistryConfig } from "../lib/registries";
import { registryListKey } from "../lib/query-client";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import { SkeletonRows } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { QueryErrorNotice } from "../components/query-error";
import { ActivityFeed } from "../components/ActivityFeed";

/**
 * `/` (BUILD_AND_TEST.md §8 M2 item 2) — real services as the primary destination, catalog counts
 * below them, live activity demoted to the bottom.
 *
 * This is NOT the "Needs you" dashboard (approvals/blocked/freezes roll-up) design-spec §4A
 * describes as the eventual homepage — that needs a server-side aggregate across changes, freezes
 * and approvals that does not exist yet. See docs/proposals/homepage-dashboard.md for that design;
 * this page is the honest subset buildable from today's list endpoints.
 *
 * The org-name/"Signed in as" block that used to live here is gone — the header bar (AppShell
 * §3.3, `current-org` testid) is the one home of account chrome now.
 */

const CATALOG_BASE_PATHS = ["services", "assemblies", "components", "deployment-targets"] as const;
const CATALOG_REGISTRIES: RegistryConfig[] = CATALOG_BASE_PATHS.map((basePath) => {
  const registry = findRegistry(basePath);
  if (!registry) throw new Error(`dashboard: no registry configured for "${basePath}"`);
  return registry;
});

export function DashboardPage(): React.JSX.Element {
  const servicesQuery = useQuery({
    queryKey: registryListKey("services"),
    queryFn: () => client.services.list({ limit: 100 })
  });

  const catalogCounts = useQueries({
    queries: CATALOG_REGISTRIES.map((registry) => ({
      queryKey: registryListKey(registry.basePath),
      queryFn: () => getRegistryClient(client, registry).list({ limit: 100 })
    }))
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" />

      <div>
        <SectionLabel as="h2" className="mb-3">
          Services
        </SectionLabel>
        {servicesQuery.isLoading ? (
          <SkeletonRows n={4} />
        ) : servicesQuery.isError ? (
          <QueryErrorNotice error={servicesQuery.error} what="services" />
        ) : !servicesQuery.data || servicesQuery.data.items.length === 0 ? (
          <Card size="compact">
            <CardContent className="pt-4 text-sm text-slate-500">No services yet.</CardContent>
          </Card>
        ) : (
          <Card size="flush">
            <ul className="divide-y divide-slate-200">
              {servicesQuery.data.items.map((service) => (
                <li key={service.id}>
                  <Link
                    to="/services/$idOrUrn"
                    params={{ idOrUrn: service.id }}
                    className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-slate-50"
                    data-testid="dashboard-service-link"
                  >
                    <ServiceGuidon
                      className="size-4 shrink-0 text-slate-400"
                      strokeWidth={1.75}
                      aria-hidden="true"
                    />
                    <span className="flex-1 truncate font-medium text-slate-900">
                      {service.name}
                    </span>
                    <ArrowRight
                      className="size-4 shrink-0 text-slate-400"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <SectionLabel as="h2" className="mb-3">
          Catalog
        </SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CATALOG_REGISTRIES.map((registry, i) => {
            const query = catalogCounts[i];
            return (
              <StatCard
                key={registry.basePath}
                label={registry.label}
                // A failed or still-loading count shows no number at all, never a fabricated "0"
                // (spec §4A) — "we could not read this" and "there are none" are different facts.
                value={query?.isSuccess ? query.data.items.length : undefined}
                icon={registry.icon}
                to="/$basePath"
                params={{ basePath: registry.basePath }}
                data-testid={`dashboard-catalog-${registry.basePath}`}
              />
            );
          })}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityFeed />
        </CardContent>
      </Card>
    </div>
  );
}

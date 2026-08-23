import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { client } from "../lib/client";
import { findRegistry, getRegistryClient, type RegistryConfig } from "../lib/registries";
import { registryListKey } from "../lib/query-client";
import { PageHeader } from "../components/ui/page-header";
import { StatCard } from "../components/ui/stat-card";
import { Button } from "../components/ui/button";
import { SkeletonRows } from "../components/ui/skeleton";

/**
 * `/identity` — one nav entry standing in for the four identity registries.
 *
 * Teams, groups, users and service accounts were four of the nine flat REGISTRIES nav entries, and
 * none of them is catalog: they answer "who", not "what we run". This collapses them to a single
 * destination WITHOUT duplicating `RegistryListPage` — each preview row links to that page's own
 * detail route, and "View all" links to the list itself, which still owns listing and creation.
 * Re-mounting `RegistryListPage` here was the alternative and does not work: `useBasePathParam`
 * resolves the registry from the URL's FIRST SEGMENT when there is no `$basePath` param, so anything
 * under `/identity/...` would resolve to the registry "identity" and render "Not found".
 *
 * The counts AND the first few names are the point (spec §4E) — a card that only repeats its own
 * label is what the old dashboard's registry grid was, and it carried no information the nav did not
 * already have.
 */

const IDENTITY_BASE_PATHS = ["teams", "groups", "users", "service-accounts"] as const;
const PREVIEW_COUNT = 5;

const IDENTITY_REGISTRIES: RegistryConfig[] = IDENTITY_BASE_PATHS.map((basePath) => {
  const registry = findRegistry(basePath);
  // A typo here would render a silently empty page; fail loudly at module load instead.
  if (!registry) throw new Error(`identity: no registry configured for "${basePath}"`);
  return registry;
});

export function IdentityPage(): React.JSX.Element {
  const lists = useQueries({
    queries: IDENTITY_REGISTRIES.map((registry) => ({
      queryKey: registryListKey(registry.basePath),
      queryFn: () => getRegistryClient(client, registry).list({ limit: 100 })
    }))
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Identity"
        description="Who can act in this org — the subjects role bindings are granted to."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {IDENTITY_REGISTRIES.map((registry, i) => {
          const query = lists[i];
          const items = query?.data?.items ?? [];
          const preview = items.slice(0, PREVIEW_COUNT);
          return (
            <div key={registry.basePath} className="flex flex-col gap-3">
              <StatCard
                label={registry.label}
                // A failed or still-loading count shows no number at all, never a fabricated "0"
                // — "we could not read this" and "there are none" are different facts.
                value={query?.isSuccess ? items.length : undefined}
                icon={registry.icon}
                data-testid={`identity-card-${registry.basePath}`}
              />
              {query?.isLoading && <SkeletonRows n={PREVIEW_COUNT} />}
              {query?.isSuccess && preview.length === 0 && (
                <p className="text-sm text-slate-500">No {registry.label.toLowerCase()} yet.</p>
              )}
              {preview.length > 0 && (
                <ul
                  className="flex flex-col gap-1"
                  data-testid={`identity-preview-${registry.basePath}`}
                >
                  {preview.map((item) => (
                    <li key={item.id}>
                      <Link
                        to="/$basePath/$idOrUrn"
                        params={{ basePath: registry.basePath, idOrUrn: item.id }}
                        className="block truncate text-sm text-slate-700 hover:text-slate-900 hover:underline"
                      >
                        {item.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/$basePath" params={{ basePath: registry.basePath }} className="self-start">
                <Button variant="ghost" size="sm" icon={ArrowRight}>
                  View all
                </Button>
              </Link>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-slate-500">
        Counts and previews are capped at the first 100 of each registry — open a registry for the
        full list.
      </p>
    </div>
  );
}

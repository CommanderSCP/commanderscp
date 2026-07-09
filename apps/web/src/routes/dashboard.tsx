import { Link } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context";
import { REGISTRIES } from "../lib/registries";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { ActivityFeed } from "../components/ActivityFeed";

/** `/` (BUILD_AND_TEST.md §8 M2 item 2) — org name, quick links into each typed registry, live feed. */
export function DashboardPage(): React.JSX.Element {
  const { user } = useAuth();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900" data-testid="org-name">
          {user?.orgName ?? "Dashboard"}
        </h1>
        <p className="text-sm text-slate-500">Signed in as {user?.username}</p>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Registries
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {REGISTRIES.map((registry) => (
            <Link
              key={registry.basePath}
              to="/$basePath"
              params={{ basePath: registry.basePath }}
              className="rounded-lg border border-slate-200 bg-white p-4 text-sm font-medium text-slate-900 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              {registry.label}
            </Link>
          ))}
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

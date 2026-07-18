import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./components/layout/RootLayout";
import { AuthenticatedLayout } from "./components/layout/AuthenticatedLayout";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { DevicePage } from "./routes/device";
import { PatsPage } from "./routes/pats";
import { RegistryListPage } from "./routes/registry-list";
import { RegistryDetailPage } from "./routes/registry-detail";
import { GraphExplorerPage } from "./routes/graph-explorer";
import { GraphLandingPage } from "./routes/graph-landing";
import { ComponentGraphPage } from "./routes/component-graph";
import { ChangeListPage } from "./routes/change-list";
import { ChangeDetailPage } from "./routes/change-detail";
import { ChangePipelinePage } from "./routes/change-pipeline";
import { ServiceBoardPage } from "./routes/service-board";
import { CampaignListPage } from "./routes/campaign-list";
import { CampaignDetailPage } from "./routes/campaign-detail";
import { InitiativeListPage } from "./routes/initiative-list";
import { InitiativeDetailPage } from "./routes/initiative-detail";
import { FederationStatusPage } from "./routes/federation-status";
import { PluginsPage } from "./routes/plugins";

/**
 * Code-based TanStack Router route tree (BUILD_AND_TEST.md §8 M2 item 2 — "TanStack Router...
 * file-based or code-based, your call"). Code-based avoids depending on the `@tanstack/router-
 * plugin` Vite plugin's generated `routeTree.gen.ts` — one fewer moving part for an air-gapped
 * build (CLAUDE.md), at the cost of hand-listing routes here instead of inferring them from
 * `src/routes/*`.
 *
 * `authenticatedLayoutRoute` is a PATHLESS layout route (no `path`, just an `id`) wrapping every
 * page except `/login` in `<RequireAuth>` + `<AppShell>` — the standard TanStack Router pattern
 * for "all these routes share a guard/chrome" without repeating it per page.
 */
const rootRoute = createRootRoute({ component: RootLayout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage
});

const authenticatedLayoutRoute = createRoute({
  id: "authenticated",
  getParentRoute: () => rootRoute,
  component: AuthenticatedLayout
});

const dashboardRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/",
  component: DashboardPage
});

const deviceRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/device",
  component: DevicePage,
  validateSearch: (search: Record<string, unknown>): { user_code?: string } => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined
  })
});

const patsRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/pats",
  component: PatsPage
});

const graphLandingRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/graph",
  component: GraphLandingPage
});

const graphExplorerRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/graph/$idOrUrn",
  component: GraphExplorerPage
});

// Component layer of the two-layer graph (coordination-ui-views.md Phase 3). A 3-segment static
// `service` prefix — deeper than the 2-segment `/graph/$idOrUrn` object explorer, so the two never
// collide (mirrors how `/services/$id/board` sits under the dynamic registry routes).
const componentGraphRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/graph/service/$serviceId",
  component: ComponentGraphPage
});

const changeListRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/changes",
  component: ChangeListPage
});

const changeDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/changes/$id",
  component: ChangeDetailPage
});

// The component-pipeline view of a change (coordination-ui-views.md phase 1). A static `pipeline`
// leaf under `/changes/$id` — out-ranks nothing ambiguous, and `$id` still resolves change detail.
const changePipelineRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/changes/$id/pipeline",
  component: ChangePipelinePage
});

// The service release board (coordination-ui-views.md Phase 2). A static `/services/$id/board` leaf —
// services otherwise render only through the generic `/$basePath/$idOrUrn` registry-detail route, so
// this dedicated static `/services/...` segment out-ranks the dynamic one (same precedence note below).
const serviceBoardRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/services/$id/board",
  component: ServiceBoardPage
});

const campaignListRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/campaigns",
  component: CampaignListPage
});

const campaignDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/campaigns/$id",
  component: CampaignDetailPage
});

const initiativeListRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/initiatives",
  component: InitiativeListPage
});

const initiativeDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/initiatives/$id",
  component: InitiativeDetailPage
});

const federationStatusRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/federation",
  component: FederationStatusPage
});

const pluginsRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/plugins",
  component: PluginsPage
});

// Static segments (`/login`, `/device`, `/pats`, `/graph/...`, `/changes`, `/changes/...`,
// `/campaigns`, `/campaigns/...`, `/initiatives`, `/initiatives/...`, `/federation`) always
// out-rank the single dynamic `$basePath` segment below at the same depth — standard router
// precedence — so those pages never get shadowed by "an unknown registry named 'device'".
const registryListRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/$basePath",
  component: RegistryListPage
});

const registryDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/$basePath/$idOrUrn",
  component: RegistryDetailPage
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedLayoutRoute.addChildren([
    dashboardRoute,
    deviceRoute,
    patsRoute,
    graphLandingRoute,
    graphExplorerRoute,
    componentGraphRoute,
    changeListRoute,
    changeDetailRoute,
    changePipelineRoute,
    serviceBoardRoute,
    campaignListRoute,
    campaignDetailRoute,
    initiativeListRoute,
    initiativeDetailRoute,
    federationStatusRoute,
    pluginsRoute,
    registryListRoute,
    registryDetailRoute
  ])
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

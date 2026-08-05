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
import { ComponentInfrastructurePage, ComponentPipelinePage } from "./routes/component-pipeline";
import { ComponentDetailLayout } from "./routes/component-detail";
import { ServiceBoardPage } from "./routes/service-board";
import { CampaignListPage } from "./routes/campaign-list";
import { CampaignDetailPage } from "./routes/campaign-detail";
import { InitiativeListPage } from "./routes/initiative-list";
import { InitiativeDetailPage } from "./routes/initiative-detail";
import { FederationStatusPage } from "./routes/federation-status";
import { OutpostsPage } from "./routes/outposts";
import { OutpostDetailPage } from "./routes/outpost-detail";
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

// ONE COMPONENT — a LAYOUT route carrying the Pipeline/Settings tabs, with the pipeline as its index
// child (coordination-ui-views.md §2, corrected 2026-08-03). The static `/components/$idOrUrn`
// segment out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below — the same
// precedence trick `/services/$id/board` uses — so going to a component lands on its pipeline rather
// than a properties table, because the pipeline IS what a component is operationally.
//
// That precedence had a cost this layout repays: it made the generic registry detail UNREACHABLE for
// components, orphaning its labels/owners/move/merge cards. `settings` mounts that same page (not a
// copy) at `/components/$idOrUrn/settings`; `useBasePathParam` resolves `components` from the
// pathname there, since this route has no `$basePath` param. See `routes/component-detail.tsx`.
const componentDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/components/$idOrUrn",
  component: ComponentDetailLayout
});

const componentPipelineRoute = createRoute({
  getParentRoute: () => componentDetailRoute,
  path: "/",
  component: ComponentPipelinePage
});

const componentInfrastructureRoute = createRoute({
  getParentRoute: () => componentDetailRoute,
  path: "/infrastructure",
  component: ComponentInfrastructurePage
});

const componentSettingsRoute = createRoute({
  getParentRoute: () => componentDetailRoute,
  path: "/settings",
  component: RegistryDetailPage
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

// M16.2 phase B — the Outposts UI, deliberately UNDER the existing `/federation` prefix rather than
// beside it: `/federation` and its "Federation" heading already ship and may be bookmarked, so this
// adds to that section instead of renaming it out from under anyone. Static segments out-rank the
// dynamic `$basePath` route below at the same depth, and `outposts` out-ranks nothing ambiguous
// under `/federation`, which has no dynamic child.
const outpostsRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/federation/outposts",
  component: OutpostsPage
});

const outpostDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/federation/outposts/$peerDomainId",
  component: OutpostDetailPage
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
    componentDetailRoute.addChildren([
      componentPipelineRoute,
      componentInfrastructureRoute,
      componentSettingsRoute
    ]),
    serviceBoardRoute,
    campaignListRoute,
    campaignDetailRoute,
    initiativeListRoute,
    initiativeDetailRoute,
    federationStatusRoute,
    outpostsRoute,
    outpostDetailRoute,
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

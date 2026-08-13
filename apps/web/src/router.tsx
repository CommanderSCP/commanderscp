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
import { ChangeDetailPage } from "./routes/change-detail";
import { ChangePipelinePage } from "./routes/change-pipeline";
import { ComponentInfrastructurePage, ComponentPipelinePage } from "./routes/component-pipeline";
import { ComponentDetailLayout } from "./routes/component-detail";
import { ServiceBoardPage } from "./routes/service-board";
import { ServiceDetailLayout } from "./routes/service-detail";
import { ServiceInfrastructurePage } from "./routes/service-infrastructure";
import { CampaignListPage } from "./routes/campaign-list";
import { CampaignDetailPage } from "./routes/campaign-detail";
import { FederationStatusPage } from "./routes/federation-status";
import { OutpostsPage } from "./routes/outposts";
import { OutpostDetailPage } from "./routes/outpost-detail";
import { PluginsPage } from "./routes/plugins";
import { AssemblyBoardPage, AssemblyDetailLayout } from "./routes/assembly-detail";
import { IdentityPage } from "./routes/identity";

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

// ONE SERVICE — a LAYOUT route carrying the Board/Settings tabs, with the release board as its INDEX
// child (coordination-ui-views.md Phase 2, corrected 2026-08-04). `/services/{id}` used to fall
// through to the generic registry detail, so the board — what is releasing, what is blocked, which
// pipelines are bound — sat at a URL only one button linked to. The board is what a service IS
// operationally, so it is the default; the properties table becomes the Settings tab, mounting the
// same `RegistryDetailPage` (not a copy), exactly as `/components/$idOrUrn` does.
// ONE ASSEMBLY — the same layout/index-child shape as a service, two tabs instead of three (see
// routes/assembly-detail.tsx). The static `/assemblies/$idOrUrn` segment out-ranks the dynamic
// `/$basePath/$idOrUrn` registry route, so an assembly lands on its board; `settings` mounts the
// generic RegistryDetailPage, which resolves `assemblies` from the pathname.
const assemblyDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/assemblies/$idOrUrn",
  component: AssemblyDetailLayout
});

const assemblyBoardRoute = createRoute({
  getParentRoute: () => assemblyDetailRoute,
  path: "/",
  component: AssemblyBoardPage
});

const assemblySettingsRoute = createRoute({
  getParentRoute: () => assemblyDetailRoute,
  path: "/settings",
  component: RegistryDetailPage
});

const identityRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/identity",
  component: IdentityPage
});

const serviceDetailRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/services/$idOrUrn",
  component: ServiceDetailLayout
});

const serviceBoardRoute = createRoute({
  getParentRoute: () => serviceDetailRoute,
  path: "/",
  component: ServiceBoardPage
});

const serviceInfrastructureRoute = createRoute({
  getParentRoute: () => serviceDetailRoute,
  path: "/infrastructure",
  component: ServiceInfrastructurePage
});

const serviceSettingsRoute = createRoute({
  getParentRoute: () => serviceDetailRoute,
  path: "/settings",
  component: RegistryDetailPage
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
// `/campaigns`, `/campaigns/...`, `/federation`) always
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
    changeDetailRoute,
    changePipelineRoute,
    componentDetailRoute.addChildren([
      componentPipelineRoute,
      componentInfrastructureRoute,
      componentSettingsRoute
    ]),
    assemblyDetailRoute.addChildren([assemblyBoardRoute, assemblySettingsRoute]),
    identityRoute,
    serviceDetailRoute.addChildren([
      serviceBoardRoute,
      serviceInfrastructureRoute,
      serviceSettingsRoute
    ]),
    campaignListRoute,
    campaignDetailRoute,
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

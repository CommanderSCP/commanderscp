import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { RootLayout } from "./components/layout/RootLayout";
import { AuthenticatedLayout } from "./components/layout/AuthenticatedLayout";
import { LoginPage } from "./routes/login";
import { DashboardPage } from "./routes/dashboard";
import { OutpostDashboardPage } from "./routes/outpost-dashboard";
import { useAuth } from "./lib/auth-context";
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
import { ComponentDependenciesPage } from "./routes/component-dependencies";
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
import { ConnectArgoCdPage } from "./routes/connect-argocd";
import { ConnectKindPage } from "./routes/connect";
import { SetupPage } from "./routes/setup";
import { AdminDependenciesPage } from "./routes/admin-dependencies";
import { AdminGovernancePage } from "./routes/admin-governance";
import { AdminAccessPage } from "./routes/admin-access";
import { AdminDecisionsPage } from "./routes/admin-decisions";
import { AdminAuditPage } from "./routes/admin-audit";

/** Code-based TanStack Router route tree. See docs/web.md §148. */
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

/** HOME is site-shaped (outpost-ui.md §9.3). See docs/web.md §149. */
function HomePage(): React.JSX.Element {
  const { user } = useAuth();
  return user?.instanceRole === "outpost" ? <OutpostDashboardPage /> : <DashboardPage />;
}

const dashboardRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/",
  component: HomePage
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
// collide (mirrors how `/services/$idOrUrn` sits under the dynamic registry routes).
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

// One component: a layout route carrying its tabs. See docs/web.md §150.
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

// The DEPENDENCIES tab (docs/proposals/dependency-subscription-ui.md §4.1). See docs/web.md §151.
const componentDependenciesRoute = createRoute({
  getParentRoute: () => componentDetailRoute,
  path: "/dependencies",
  component: ComponentDependenciesPage
});

// One service: a layout route carrying its tabs. See docs/web.md §152.
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

// The URL the board lived at before it became the index. See docs/web.md §153.
const serviceBoardLegacyRoute = createRoute({
  getParentRoute: () => serviceDetailRoute,
  path: "/board",
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

// The outposts UI, deliberately under the federation path. See docs/web.md §154.
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

// M19.1 — the "Connect Argo CD" wizard. See docs/web.md §155.
const connectArgoCdRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/connect/argocd",
  component: ConnectArgoCdPage
});

// B1 (docs/proposals/outpost-ui.md §4 Lane B). See docs/web.md §156.
const connectKindRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/connect/$kind",
  component: ConnectKindPage
});

// G5 (outpost-ui.md §4 close, owner decision 2026-08-13: "both" — a setup landing ALONGSIDE the
// in-place affordances) — a static 1-segment path, so it out-ranks nothing and needs no precedence
// reasoning beyond "it isn't `$basePath`" (the same fact `/pats`, `/identity`, etc. already rely on).
const setupRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/setup",
  component: SetupPage
});

// Admin › Dependencies (dependency-subscription-ui.md §12, ADR-0032 §7e). See docs/web.md §157.
const adminDependenciesRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/dependencies",
  component: AdminDependenciesPage
});

// Admin › Governance (governance-reach-on-containment-move.md §9.4). See docs/web.md §158.
const adminAccessRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/access",
  component: AdminAccessPage
});

const adminGovernanceRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/governance",
  component: AdminGovernancePage
});

// Admin › Decisions. See docs/web.md §159.
const adminDecisionsRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/decisions",
  component: AdminDecisionsPage,
  validateSearch: (search: Record<string, unknown>): { subjectId?: string } => ({
    subjectId: typeof search.subjectId === "string" ? search.subjectId : undefined
  })
});

// Admin › Audit (owner-approved 2026-08-23) — the hash-chained audit log
// (`GET /audit-events`, `audit:read`). Same static-2-segment precedence reasoning as the two
// routes above. Linked from BOTH nav tables.
const adminAuditRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/audit",
  component: AdminAuditPage
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
      componentDependenciesRoute,
      componentSettingsRoute
    ]),
    assemblyDetailRoute.addChildren([assemblyBoardRoute, assemblySettingsRoute]),
    identityRoute,
    serviceDetailRoute.addChildren([
      serviceBoardRoute,
      serviceBoardLegacyRoute,
      serviceInfrastructureRoute,
      serviceSettingsRoute
    ]),
    campaignListRoute,
    campaignDetailRoute,
    federationStatusRoute,
    outpostsRoute,
    outpostDetailRoute,
    pluginsRoute,
    connectArgoCdRoute,
    connectKindRoute,
    setupRoute,
    adminDependenciesRoute,
    adminGovernanceRoute,
    adminAccessRoute,
    adminDecisionsRoute,
    adminAuditRoute,
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

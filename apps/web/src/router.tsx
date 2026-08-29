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

/**
 * HOME is site-shaped (outpost-ui.md §9.3): the commander gets the org-wide dashboard, the outpost
 * a small component-level one. Selected by `/auth/me`'s install-time `instanceRole` — the ONE
 * place role picks a page — and only here: inside either page every row keys on data.
 */
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

// ONE COMPONENT — a LAYOUT route carrying the Pipeline/Settings tabs, with the pipeline as its index
// child (coordination-ui-views.md §2, corrected 2026-08-03). The static `/components/$idOrUrn`
// segment out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below — the same
// precedence trick `/services/$idOrUrn` uses — so going to a component lands on its pipeline rather
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

// The DEPENDENCIES tab (docs/proposals/dependency-subscription-ui.md §4.1): what this component
// declares, the head of each major line, whether it is subscribed and why, what has been bumped,
// and the offered enable / opt-out writes. A fourth child of the same layout so it is a real,
// deep-linkable URL like the other three. Registered on BOTH sites — the outpost renders the bumps
// section as a sentence, never an empty table that looks up to date.
const componentDependenciesRoute = createRoute({
  getParentRoute: () => componentDetailRoute,
  path: "/dependencies",
  component: ComponentDependenciesPage
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

// `/services/{id}/board` — the URL the board lived at BEFORE it became the index child, kept
// working rather than removed. Two reasons, and the second is why this is a bug fix and not
// politeness: it may be bookmarked or linked from outside the app, and
// `apps/web/e2e/service-board-honesty.spec.ts` navigates to it. That spec is Playwright, every E2E
// job is `main`-only, so removing this path passed EVERY required PR check and would have broken
// only after merge — the exact hole `.github/workflows/ci.yml`'s own §6 comment warns about.
// Renders the same component as the index; a redirect would work too, but two paths onto one view
// is fewer moving parts than a redirect that has to reconstruct params.
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

// M19.1 — the "Connect Argo CD" wizard. A static 2-segment path, so it out-ranks the dynamic
// `/$basePath/$idOrUrn` registry-detail route below exactly as `/graph/service/...` and
// `/federation/outposts` already do. `/connect/<kind>` rather than `/plugins/connect-argocd`
// because the thing being connected is an execution SYSTEM, not a plugin instance — the `/plugins`
// page configures bindings from manifests, which is a different act — and because the next kinds
// (gitea, gitlab, harbor) already have server-side discovery modules and belong beside this one.
const connectArgoCdRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/connect/argocd",
  component: ConnectArgoCdPage
});

// B1 (docs/proposals/outpost-ui.md §4 Lane B) — generalizes the wizard above over the server's own
// discovery-module catalog instead of one Argo-CD-shaped page (routes/connect.tsx). Registered
// BESIDE `connectArgoCdRoute` rather than replacing it: this router's own static-outranks-dynamic
// precedence (the same rule `serviceBoardLegacyRoute` above relies on) means `/connect/argocd`
// always resolves to THAT route first, so its pinned testids are never at risk from this one —
// `/connect/$kind` only ever serves a kind other than "argocd" in normal navigation (gitea, gitlab
// today). See routes/connect.tsx's file-level comment for why "argocd" is still handled
// defensively inside it.
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

// Admin › Dependencies (dependency-subscription-ui.md §12, ADR-0032 §7e) — the org's dependency
// PRODUCER declarations: declare / retract with a dry-run blast radius first. A static 2-segment
// path, so it out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below exactly as
// `/connect/argocd` and `/federation/outposts` do. Linked from the COMMANDER nav only (owner rule
// 2026-08-17: dependency automation is commander-only); the page itself renders the
// "managed at the commander" pointer and issues no reads on any other install-time role.
const adminDependenciesRoute = createRoute({
  getParentRoute: () => authenticatedLayoutRoute,
  path: "/admin/dependencies",
  component: AdminDependenciesPage
});

// Admin › Governance (governance-reach-on-containment-move.md §9.4) — the governance:move
// enforcement lattice: instance rung (read-only), the org rung switch, and the enabled-rungs
// table with Enable at… / Disable. A static 2-segment path, out-ranking the dynamic
// `/$basePath/$idOrUrn` registry-detail route below exactly as `/admin/dependencies` does.
// Linked from BOTH the commander and outpost nav tables (enforcement is per-instance).
// Admin › Access (role-model.md §5 steps 5/6/10) — the role catalogue, who holds what, and the
// caller's own effective permissions at one object. A static 2-segment path, out-ranking the
// dynamic `/$basePath/$idOrUrn` registry-detail route exactly as its siblings do.
//
// BOTH SITES: an outpost's own principals hold roles in its own domain, and step 6's "what may I
// do here" is if anything MORE useful there — a field operator with no commander to ask.
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

// Admin › Decisions (owner-approved 2026-08-23, "Decisions & Audit explorer") — every Decision
// record browsable, filterable by `subjectId`/`kind` exactly as `GET /decisions` allows (charter
// principle 6). `subjectId` search param is what `registry-detail.tsx`'s "Decisions about this
// object" link carries — `useSubjectIdSearchForDecisions` (lib/use-route-params.ts). A static
// 2-segment path, out-ranking the dynamic `/$basePath/$idOrUrn` registry-detail route exactly as
// `/admin/dependencies` and `/admin/governance` do. Linked from BOTH nav tables (decisions and
// audit exist on every deployment).
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

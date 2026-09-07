# web

Long-form reference for the **web** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 517 of 517 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/web/e2e/browse.spec.ts`](#apps-web-e2e-browse-spec-ts) — §1–§1
- [`apps/web/e2e/component-settings-tab.spec.ts`](#apps-web-e2e-component-settings-tab-spec-ts) — §2–§2
- [`apps/web/e2e/connect-argocd.spec.ts`](#apps-web-e2e-connect-argocd-spec-ts) — §3–§6
- [`apps/web/e2e/device.spec.ts`](#apps-web-e2e-device-spec-ts) — §7–§7
- [`apps/web/e2e/fake-argocd.ts`](#apps-web-e2e-fake-argocd-ts) — §8–§8
- [`apps/web/e2e/fixtures.ts`](#apps-web-e2e-fixtures-ts) — §9–§9
- [`apps/web/e2e/global-setup.ts`](#apps-web-e2e-global-setup-ts) — §10–§12
- [`apps/web/e2e/graph.spec.ts`](#apps-web-e2e-graph-spec-ts) — §13–§13
- [`apps/web/e2e/login.spec.ts`](#apps-web-e2e-login-spec-ts) — §14–§14
- [`apps/web/e2e/openapi-conformance.test.ts`](#apps-web-e2e-openapi-conformance-test-ts) — §15–§16
- [`apps/web/e2e/openapi-conformance.ts`](#apps-web-e2e-openapi-conformance-ts) — §17–§19
- [`apps/web/e2e/outposts-no-bypass.spec.ts`](#apps-web-e2e-outposts-no-bypass-spec-ts) — §20–§20
- [`apps/web/e2e/runner-neutral.test.ts`](#apps-web-e2e-runner-neutral-test-ts) — §21–§23
- [`apps/web/e2e/seeded-demo.spec.ts`](#apps-web-e2e-seeded-demo-spec-ts) — §24–§24
- [`apps/web/e2e/service-board-honesty.spec.ts`](#apps-web-e2e-service-board-honesty-spec-ts) — §25–§29
- [`apps/web/e2e/sse-live-update.spec.ts`](#apps-web-e2e-sse-live-update-spec-ts) — §30–§30
- [`apps/web/playwright.config.ts`](#apps-web-playwright-config-ts) — §31–§31
- [`apps/web/src/components/RequireAuth.tsx`](#apps-web-src-components-requireauth-tsx) — §32–§32
- [`apps/web/src/components/decision/DecisionDetailDialog.tsx`](#apps-web-src-components-decision-decisiondetaildialog-tsx) — §33–§33
- [`apps/web/src/components/decision/ReasonDialog.tsx`](#apps-web-src-components-decision-reasondialog-tsx) — §34–§34
- [`apps/web/src/components/decision/WhyLink.tsx`](#apps-web-src-components-decision-whylink-tsx) — §35–§35
- [`apps/web/src/components/decision/decision-format.ts`](#apps-web-src-components-decision-decision-format-ts) — §36–§36
- [`apps/web/src/components/domain-local.test.tsx`](#apps-web-src-components-domain-local-test-tsx) — §37–§39
- [`apps/web/src/components/domain-local.tsx`](#apps-web-src-components-domain-local-tsx) — §40–§47
- [`apps/web/src/components/error-boundary.test.tsx`](#apps-web-src-components-error-boundary-test-tsx) — §48–§48
- [`apps/web/src/components/error-boundary.tsx`](#apps-web-src-components-error-boundary-tsx) — §49–§49
- [`apps/web/src/components/graph/GraphCanvas.tsx`](#apps-web-src-components-graph-graphcanvas-tsx) — §50–§55
- [`apps/web/src/components/graph/GraphLegend.tsx`](#apps-web-src-components-graph-graphlegend-tsx) — §56–§56
- [`apps/web/src/components/icons/catalog-marks.tsx`](#apps-web-src-components-icons-catalog-marks-tsx) — §57–§57
- [`apps/web/src/components/icons/federation-roles.tsx`](#apps-web-src-components-icons-federation-roles-tsx) — §58–§58
- [`apps/web/src/components/layout/AppShell.tsx`](#apps-web-src-components-layout-appshell-tsx) — §59–§62
- [`apps/web/src/components/layout/BrandMark.tsx`](#apps-web-src-components-layout-brandmark-tsx) — §63–§64
- [`apps/web/src/components/layout/RootLayout.tsx`](#apps-web-src-components-layout-rootlayout-tsx) — §65–§65
- [`apps/web/src/components/layout/app-shell-nav.test.tsx`](#apps-web-src-components-layout-app-shell-nav-test-tsx) — §66–§69
- [`apps/web/src/components/pipeline/BoundarySegmentStrip.tsx`](#apps-web-src-components-pipeline-boundarysegmentstrip-tsx) — §70–§74
- [`apps/web/src/components/pipeline/PipelineWaveCard.test.tsx`](#apps-web-src-components-pipeline-pipelinewavecard-test-tsx) — §75–§77
- [`apps/web/src/components/pipeline/PipelineWaveCard.tsx`](#apps-web-src-components-pipeline-pipelinewavecard-tsx) — §78–§95
- [`apps/web/src/components/pipeline/PromotionArrow.tsx`](#apps-web-src-components-pipeline-promotionarrow-tsx) — §96–§99
- [`apps/web/src/components/pipeline/wave-status.ts`](#apps-web-src-components-pipeline-wave-status-ts) — §100–§101
- [`apps/web/src/components/query-error.tsx`](#apps-web-src-components-query-error-tsx) — §102–§102
- [`apps/web/src/components/scaffold/scaffold-panel.test.tsx`](#apps-web-src-components-scaffold-scaffold-panel-test-tsx) — §103–§103
- [`apps/web/src/components/scaffold/scaffold-panel.tsx`](#apps-web-src-components-scaffold-scaffold-panel-tsx) — §104–§104
- [`apps/web/src/components/ui/alert.tsx`](#apps-web-src-components-ui-alert-tsx) — §105–§105
- [`apps/web/src/components/ui/badge.tsx`](#apps-web-src-components-ui-badge-tsx) — §106–§106
- [`apps/web/src/components/ui/button.tsx`](#apps-web-src-components-ui-button-tsx) — §107–§107
- [`apps/web/src/components/ui/card.tsx`](#apps-web-src-components-ui-card-tsx) — §108–§108
- [`apps/web/src/components/ui/key-value-list.tsx`](#apps-web-src-components-ui-key-value-list-tsx) — §109–§109
- [`apps/web/src/components/ui/notice.tsx`](#apps-web-src-components-ui-notice-tsx) — §110–§110
- [`apps/web/src/components/ui/stat-card.tsx`](#apps-web-src-components-ui-stat-card-tsx) — §111–§111
- [`apps/web/src/components/ui/table.tsx`](#apps-web-src-components-ui-table-tsx) — §112–§112
- [`apps/web/src/lib/absent.ts`](#apps-web-src-lib-absent-ts) — §113–§114
- [`apps/web/src/lib/auth-context.tsx`](#apps-web-src-lib-auth-context-tsx) — §115–§115
- [`apps/web/src/lib/change-format.ts`](#apps-web-src-lib-change-format-ts) — §116–§116
- [`apps/web/src/lib/client.ts`](#apps-web-src-lib-client-ts) — §117–§117
- [`apps/web/src/lib/graph-glyphs.test.ts`](#apps-web-src-lib-graph-glyphs-test-ts) — §118–§118
- [`apps/web/src/lib/graph-glyphs.ts`](#apps-web-src-lib-graph-glyphs-ts) — §119–§119
- [`apps/web/src/lib/graph-visual.test.ts`](#apps-web-src-lib-graph-visual-test-ts) — §120–§120
- [`apps/web/src/lib/graph-visual.ts`](#apps-web-src-lib-graph-visual-ts) — §121–§124
- [`apps/web/src/lib/query-client.ts`](#apps-web-src-lib-query-client-ts) — §125–§126
- [`apps/web/src/lib/registries.ts`](#apps-web-src-lib-registries-ts) — §127–§128
- [`apps/web/src/lib/replica-origin.test.tsx`](#apps-web-src-lib-replica-origin-test-tsx) — §129–§129
- [`apps/web/src/lib/replica-origin.tsx`](#apps-web-src-lib-replica-origin-tsx) — §130–§135
- [`apps/web/src/lib/use-event-stream.test.tsx`](#apps-web-src-lib-use-event-stream-test-tsx) — §136–§138
- [`apps/web/src/lib/use-event-stream.ts`](#apps-web-src-lib-use-event-stream-ts) — §139–§142
- [`apps/web/src/lib/use-object-names.ts`](#apps-web-src-lib-use-object-names-ts) — §143–§143
- [`apps/web/src/lib/use-route-params.ts`](#apps-web-src-lib-use-route-params-ts) — §144–§145
- [`apps/web/src/lib/utils.ts`](#apps-web-src-lib-utils-ts) — §146–§146
- [`apps/web/src/router-paths.test.ts`](#apps-web-src-router-paths-test-ts) — §147–§147
- [`apps/web/src/router.tsx`](#apps-web-src-router-tsx) — §148–§159
- [`apps/web/src/routes/admin-access.test.tsx`](#apps-web-src-routes-admin-access-test-tsx) — §160–§161
- [`apps/web/src/routes/admin-access.tsx`](#apps-web-src-routes-admin-access-tsx) — §162–§164
- [`apps/web/src/routes/admin-audit.test.tsx`](#apps-web-src-routes-admin-audit-test-tsx) — §165–§165
- [`apps/web/src/routes/admin-audit.tsx`](#apps-web-src-routes-admin-audit-tsx) — §166–§166
- [`apps/web/src/routes/admin-decisions.test.tsx`](#apps-web-src-routes-admin-decisions-test-tsx) — §167–§167
- [`apps/web/src/routes/admin-decisions.tsx`](#apps-web-src-routes-admin-decisions-tsx) — §168–§168
- [`apps/web/src/routes/admin-dependencies.test.tsx`](#apps-web-src-routes-admin-dependencies-test-tsx) — §169–§169
- [`apps/web/src/routes/admin-dependencies.tsx`](#apps-web-src-routes-admin-dependencies-tsx) — §170–§177
- [`apps/web/src/routes/admin-governance.test.tsx`](#apps-web-src-routes-admin-governance-test-tsx) — §178–§181
- [`apps/web/src/routes/admin-governance.tsx`](#apps-web-src-routes-admin-governance-tsx) — §182–§183
- [`apps/web/src/routes/assembly-detail.tsx`](#apps-web-src-routes-assembly-detail-tsx) — §184–§185
- [`apps/web/src/routes/campaign-detail-hold-wiring.test.tsx`](#apps-web-src-routes-campaign-detail-hold-wiring-test-tsx) — §186–§186
- [`apps/web/src/routes/campaign-detail.tsx`](#apps-web-src-routes-campaign-detail-tsx) — §187–§187
- [`apps/web/src/routes/campaign-list.tsx`](#apps-web-src-routes-campaign-list-tsx) — §188–§189
- [`apps/web/src/routes/change-detail.tsx`](#apps-web-src-routes-change-detail-tsx) — §190–§193
- [`apps/web/src/routes/change-domain-local-badge.test.tsx`](#apps-web-src-routes-change-domain-local-badge-test-tsx) — §194–§194
- [`apps/web/src/routes/change-pipeline-boundary-always-shown.test.tsx`](#apps-web-src-routes-change-pipeline-boundary-always-shown-test-tsx) — §195–§195
- [`apps/web/src/routes/change-pipeline-boundary-honesty.test.tsx`](#apps-web-src-routes-change-pipeline-boundary-honesty-test-tsx) — §196–§201
- [`apps/web/src/routes/change-pipeline-hold.test.tsx`](#apps-web-src-routes-change-pipeline-hold-test-tsx) — §202–§202
- [`apps/web/src/routes/change-pipeline.tsx`](#apps-web-src-routes-change-pipeline-tsx) — §203–§207
- [`apps/web/src/routes/component-dependencies-writes.test.tsx`](#apps-web-src-routes-component-dependencies-writes-test-tsx) — §208–§208
- [`apps/web/src/routes/component-dependencies.test.tsx`](#apps-web-src-routes-component-dependencies-test-tsx) — §209–§209
- [`apps/web/src/routes/component-dependencies.tsx`](#apps-web-src-routes-component-dependencies-tsx) — §210–§223
- [`apps/web/src/routes/component-detail-tabs.test.tsx`](#apps-web-src-routes-component-detail-tabs-test-tsx) — §224–§224
- [`apps/web/src/routes/component-detail.tsx`](#apps-web-src-routes-component-detail-tsx) — §225–§227
- [`apps/web/src/routes/component-graph.tsx`](#apps-web-src-routes-component-graph-tsx) — §228–§229
- [`apps/web/src/routes/component-pipeline-continuous.test.tsx`](#apps-web-src-routes-component-pipeline-continuous-test-tsx) — §230–§243
- [`apps/web/src/routes/component-pipeline-correlated-infra-wiring.test.tsx`](#apps-web-src-routes-component-pipeline-correlated-infra-wiring-test-tsx) — §244–§244
- [`apps/web/src/routes/component-pipeline-correlated-infra.test.tsx`](#apps-web-src-routes-component-pipeline-correlated-infra-test-tsx) — §245–§245
- [`apps/web/src/routes/component-pipeline-density-interaction.test.tsx`](#apps-web-src-routes-component-pipeline-density-interaction-test-tsx) — §246–§246
- [`apps/web/src/routes/component-pipeline-density.test.tsx`](#apps-web-src-routes-component-pipeline-density-test-tsx) — §247–§247
- [`apps/web/src/routes/component-pipeline-writes.test.tsx`](#apps-web-src-routes-component-pipeline-writes-test-tsx) — §248–§248
- [`apps/web/src/routes/component-pipeline.tsx`](#apps-web-src-routes-component-pipeline-tsx) — §249–§317
- [`apps/web/src/routes/connect-argocd.test.tsx`](#apps-web-src-routes-connect-argocd-test-tsx) — §318–§319
- [`apps/web/src/routes/connect-argocd.tsx`](#apps-web-src-routes-connect-argocd-tsx) — §320–§325
- [`apps/web/src/routes/connect.test.tsx`](#apps-web-src-routes-connect-test-tsx) — §326–§329
- [`apps/web/src/routes/connect.tsx`](#apps-web-src-routes-connect-tsx) — §330–§338
- [`apps/web/src/routes/dashboard.tsx`](#apps-web-src-routes-dashboard-tsx) — §339–§339
- [`apps/web/src/routes/device.tsx`](#apps-web-src-routes-device-tsx) — §340–§340
- [`apps/web/src/routes/federation-status-crash.test.tsx`](#apps-web-src-routes-federation-status-crash-test-tsx) — §341–§341
- [`apps/web/src/routes/federation-status-init-hint.test.tsx`](#apps-web-src-routes-federation-status-init-hint-test-tsx) — §342–§342
- [`apps/web/src/routes/federation-status.tsx`](#apps-web-src-routes-federation-status-tsx) — §343–§346
- [`apps/web/src/routes/graph-explorer.tsx`](#apps-web-src-routes-graph-explorer-tsx) — §347–§347
- [`apps/web/src/routes/graph-landing.tsx`](#apps-web-src-routes-graph-landing-tsx) — §348–§348
- [`apps/web/src/routes/identity.tsx`](#apps-web-src-routes-identity-tsx) — §349–§349
- [`apps/web/src/routes/outpost-configuration-interaction.test.tsx`](#apps-web-src-routes-outpost-configuration-interaction-test-tsx) — §350–§350
- [`apps/web/src/routes/outpost-configuration-precondition.test.tsx`](#apps-web-src-routes-outpost-configuration-precondition-test-tsx) — §351–§352
- [`apps/web/src/routes/outpost-configuration-retrans-gate.test.tsx`](#apps-web-src-routes-outpost-configuration-retrans-gate-test-tsx) — §353–§353
- [`apps/web/src/routes/outpost-configuration-tier-precondition.test.tsx`](#apps-web-src-routes-outpost-configuration-tier-precondition-test-tsx) — §354–§354
- [`apps/web/src/routes/outpost-configuration.test.tsx`](#apps-web-src-routes-outpost-configuration-test-tsx) — §355–§365
- [`apps/web/src/routes/outpost-configuration.tsx`](#apps-web-src-routes-outpost-configuration-tsx) — §366–§387
- [`apps/web/src/routes/outpost-dashboard.test.tsx`](#apps-web-src-routes-outpost-dashboard-test-tsx) — §388–§388
- [`apps/web/src/routes/outpost-dashboard.tsx`](#apps-web-src-routes-outpost-dashboard-tsx) — §389–§391
- [`apps/web/src/routes/outpost-detail-status.test.tsx`](#apps-web-src-routes-outpost-detail-status-test-tsx) — §392–§392
- [`apps/web/src/routes/outpost-detail.tsx`](#apps-web-src-routes-outpost-detail-tsx) — §393–§394
- [`apps/web/src/routes/outpost-settings.test.tsx`](#apps-web-src-routes-outpost-settings-test-tsx) — §395–§397
- [`apps/web/src/routes/outpost-settings.tsx`](#apps-web-src-routes-outpost-settings-tsx) — §398–§403
- [`apps/web/src/routes/outposts-co-located.test.tsx`](#apps-web-src-routes-outposts-co-located-test-tsx) — §404–§404
- [`apps/web/src/routes/outposts-crash.test.tsx`](#apps-web-src-routes-outposts-crash-test-tsx) — §405–§406
- [`apps/web/src/routes/outposts-honesty.test.tsx`](#apps-web-src-routes-outposts-honesty-test-tsx) — §407–§421
- [`apps/web/src/routes/outposts.tsx`](#apps-web-src-routes-outposts-tsx) — §422–§442
- [`apps/web/src/routes/plugins-executor-type.test.tsx`](#apps-web-src-routes-plugins-executor-type-test-tsx) — §443–§443
- [`apps/web/src/routes/plugins.tsx`](#apps-web-src-routes-plugins-tsx) — §444–§448
- [`apps/web/src/routes/registry-detail.test.tsx`](#apps-web-src-routes-registry-detail-test-tsx) — §449–§449
- [`apps/web/src/routes/registry-detail.tsx`](#apps-web-src-routes-registry-detail-tsx) — §450–§463
- [`apps/web/src/routes/registry-list-nested-domains.test.tsx`](#apps-web-src-routes-registry-list-nested-domains-test-tsx) — §464–§465
- [`apps/web/src/routes/registry-list.tsx`](#apps-web-src-routes-registry-list-tsx) — §466–§469
- [`apps/web/src/routes/service-board-honesty.test.tsx`](#apps-web-src-routes-service-board-honesty-test-tsx) — §470–§477
- [`apps/web/src/routes/service-board.tsx`](#apps-web-src-routes-service-board-tsx) — §478–§489
- [`apps/web/src/routes/service-detail.tsx`](#apps-web-src-routes-service-detail-tsx) — §490–§490
- [`apps/web/src/routes/service-infrastructure.tsx`](#apps-web-src-routes-service-infrastructure-tsx) — §491–§492
- [`apps/web/src/routes/setup.test.tsx`](#apps-web-src-routes-setup-test-tsx) — §493–§496
- [`apps/web/src/routes/setup.tsx`](#apps-web-src-routes-setup-tsx) — §497–§511
- [`apps/web/src/test-support/render-dom.tsx`](#apps-web-src-test-support-render-dom-tsx) — §512–§513
- [`apps/web/vite.config.ts`](#apps-web-vite-config-ts) — §514–§514
- [`apps/web/vitest.config.ts`](#apps-web-vitest-config-ts) — §515–§517

## `apps/web/e2e/browse.spec.ts`

### §1. Smoke test 2 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section)

Smoke test 2 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to `/services`, assert the list renders without error; create a service directly against the API (via `@scp/sdk`, same real HTTP path `scp service register` uses), reload the page, assert it now appears.

## `apps/web/e2e/component-settings-tab.spec.ts`

### §2. THE GENERIC REGISTRY DETAIL PAGE IS REACHABLE FOR COMPONENTS

THE GENERIC REGISTRY DETAIL PAGE IS REACHABLE FOR COMPONENTS.

`/components/$idOrUrn` is a STATIC route (the pipeline) and static segments out-rank the dynamic `/$basePath/$idOrUrn` that renders `RegistryDetailPage`. So the moment the pipeline shipped, that page — labels, owners, "Move to service", executor-binding repurpose, component merge — became UNREACHABLE for components without anything failing: no test asserted it, and the router comment saying "the generic detail stays reachable for every other registry type" did not notice what "every other" excluded.

Only an end-to-end navigation can prove this. Route PRECEDENCE is the thing under test, and it is decided by the real router over the real URL — a unit test that renders `RegistryDetailPage` directly proves nothing about whether any URL reaches it, which is exactly how the regression got in. This suite is also the only place `useBasePathParam`'s pathname fallback is exercised against a route that genuinely has no `$basePath` param.

## `apps/web/e2e/connect-argocd.spec.ts`

### §3. M19.1 — THE "CONNECT ARGO CD" WIZARD, END TO END

M19.1 — THE "CONNECT ARGO CD" WIZARD, END TO END.

WHAT ONLY THIS LAYER CAN PROVE. `src/routes/connect-argocd.test.tsx` pins the credential and honesty clauses on every PR with no browser; what it cannot pin is that the four SDK doors, real authz, the plugin host, the SSRF egress guard and `discovery accept`'s transaction actually compose into an import. Every one of those is server-side, and the enumerate step in particular is a call the SERVER makes — no amount of client-side stubbing reaches it.

THE FAKE ARGO CD IS NOT A CONVENIENCE, IT IS TWO ASSERTIONS:

```text
* It lives at a PRIVATE address (a loopback in local mode, a compose-network name in CI). SCP
  refuses plugin egress there by default, so the run only succeeds if BOTH ADR-0003 layers
  permit — the operator allowlist the harness sets, and the `allowInternalEgress` declaration
  the wizard's checkbox writes. Ticking that box below is therefore load-bearing: untick it and
  this spec fails at step 2. That is the in-cluster case the wizard exists for.
```

```text
* It demands a Bearer token, so reaching step 3 proves the credential travelled secrets store ->
  server -> plugin subprocess -> Argo CD. A fake that accepted anonymous requests would let a
  wizard that never stored the token pass.
```

THE FINAL ASSERTIONS READ THE GRAPH BACK THROUGH THE SDK, not the success screen. A summary agreeing with itself is not evidence; components and executor bindings that exist afterwards are.

### §4. The review step describes the proposal by type and count

The review step describes the proposal by TYPE and count rather than listing every object: the per-object list belonged to the import flow, where each row was about to become a graph write. Nothing here is about to be written, so what matters is that the proposal arrived intact and is understood as components. The per-app naming assertion did not go away — it moved to step 4, against the emitted SOURCE, which is the artifact that now carries the names.

### §5. --- Step 4: SCAFFOLD, not import

--- Step 4: SCAFFOLD, not import (ADR-0047) -------------------------------------------------

This wizard used to end by clicking "accept", which wrote the proposal into the graph — the path that made imported components RBAC orphans. It now asks which service each component belongs to and emits IaC. The assertions below are the INVERSE of the ones they replace: the old spec proved the components existed in the graph afterwards; this one proves they do NOT, which is the guarantee the removal actually bought.

### §6. Nothing was written, asserted after the refusal

--- NOTHING WAS WRITTEN --------------------------------------------------------------------

The load-bearing half. `POST /discovery/scaffold` renders text; the graph write happens only when a human commits the code and runs `scp apply`. A wizard that quietly kept writing would pass every assertion above.

## `apps/web/e2e/device.spec.ts`

### §7. Smoke test 5 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section)

Smoke test 5 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to `/device?user_code=XXXX-XXXX` while logged in, assert the form is pre-filled. The full approve round-trip against a real polling CLI is covered by M2 step 2's server-side integration test (auth/device-flow.integration.test.ts) — this just proves the page renders and the field is populated from the query param.

## `apps/web/e2e/fake-argocd.ts`

### §8. A fake Argo CD API server for the connect wizard

A fake Argo CD API server for the M19.1 "Connect Argo CD" wizard spec — the LOCAL-target half.

THERE IS A SECOND COPY OF THIS, AND THAT IS DELIBERATE. KEEP THEM IN STEP.
This suite runs in two modes (see `global-setup.ts`). In LOCAL mode the SCP server is in-process, so this module simply listens on 127.0.0.1. In COMPOSE-STACK mode — which is what CI job 9 runs — the SCP server is inside a container and can only reach a service on its own compose network, so the fake there is a container: `deploy/compose/docker-compose.e2e.yml`, an inline `node -e` script on the already-built `scp` image (no second image to pull, which keeps that job offline).

The alternative — one implementation reached over the host network via `host-gateway` — was rejected: it trades a small, self-detecting duplication for a new networking dependency in the CI job whose networking has historically been the fragile part. Self-detecting because `connect-argocd.spec.ts` asserts these exact Application NAMES, so the two fakes drifting apart turns job 9 red on the pull request rather than rotting quietly.

WHY IT DEMANDS A BEARER TOKEN. Without that, a green spec would prove only that the click path works. With it, a green spec proves the credential really travelled secrets store → server → plugin subprocess → Argo CD, which is the half of the wizard that has no other end-to-end cover.

## `apps/web/e2e/fixtures.ts`

### §9. Enables the graph explorer's dev-only Cytoscape testability hook

Enables the graph explorer's dev-only Cytoscape testability hook (apps/web/src/routes/graph-explorer.tsx `window.__cy`) for every subsequent navigation on this page — the ONLY way to reach it against the production build this suite runs against (`import.meta.env.DEV` is false there). Call before navigating.

## `apps/web/e2e/global-setup.ts`

### §10. Playwright `globalSetup` for the apps/web e2e smoke suite

Playwright `globalSetup` for the apps/web e2e smoke suite (BUILD_AND_TEST.md §8 M2 item 2's TESTS section, §4.4). This directory is TEST TOOLING, not shipped app source — unlike apps/web/src/**, it may (and does) depend on `@scp/server` directly (a `workspace:*` devDependency of apps/web, for this purpose only).

Two modes, chosen by whether `PLAYWRIGHT_BASE_URL` is set:

- LOCAL (default, `PLAYWRIGHT_BASE_URL` unset): reuses @scp/server's own Vitest `globalSetup` (test-support/global-setup.ts) for the Testcontainers Postgres bootstrap — same migrated container, same `scp_app` runtime-role provisioning every other integration test uses — by importing its compiled output directly. `@scp/server`'s package.json has no `exports` map restricting subpaths, so `test-support/global-setup.js` and `test-support/harness.js` (`listenTestServer`/`createTestOrg`) are both directly importable as-is; the one server-side change this suite needed was harness.ts's new `withEventRelay` option (see that file) — `listenTestServer` doesn't start the outbox relay by default, and without it the SSE live-update test would hang waiting for an event that never arrives. Boots a REAL scpd instance serving the REAL built `apps/web/dist` (Part D's static mount + SPA fallback in apps/server/src/app.ts) — `pnpm --filter @scp/web build` must run before this suite (not done here; kept as an explicit separate step, matching the task's documented local workflow).

- COMPOSE-STACK (`PLAYWRIGHT_BASE_URL` set, e.g. `http://localhost:8080` — scripts/e2e-web.sh): points at an already-running server (the two-container eval compose stack, with `SCP_SEED_DEMO=true`) instead of bootstrapping a Testcontainers Postgres + in-process server here. This process doesn't own that stack's lifecycle (the calling script does — same teardown-with-log-dump-on-failure pattern as scripts/e2e-m0.sh), so there's no teardown function to return. The bootstrap admin's org/username/one-time password aren't ours to generate here (they come from the compose stack's own boot-time `ensureBootstrapAdmin`), so the caller must supply them via `E2E_ORG_NAME`/`E2E_ADMIN_USERNAME`/`E2E_ADMIN_PASSWORD` — scripts/e2e-web.sh extracts the password from compose logs exactly like scripts/e2e-m0.sh does for the CLI-driven M0 suite.

Either way, exposes the server's origin + admin credentials via `process.env` — inherited by Playwright's worker processes, which fork after this function returns, same mechanism @scp/server's own Vitest globalSetup uses for its test workers.

Playwright's convention (matching Jest's): when `globalSetup`'s default export returns a function, that function becomes the teardown automatically — no separate `globalTeardown` file needed here; returning `undefined` (COMPOSE-STACK mode) means "no teardown".

### §11. The fake is started before the server, so the allowlist

M19.1 — the LOCAL-target fake Argo CD, started BEFORE the server so the allowlist below is in place by the time anything reads it. 127.0.0.1 is a loopback address, so SCP's SSRF guard refuses it unless both ADR-0003 layers permit; this is layer 1 (the operator's host allowlist), exactly as `routes/gitea-discovery.integration.test.ts` sets it, and the wizard's checkbox supplies layer 2. Compose-stack mode gets the same pair from docker-compose.e2e.yml.

### §12. A plugin host, not a reconcile loop, since nothing drives

`withPluginHost` (NOT `withReconcileLoop` — this suite drives nothing and a competing consumer would only add races): `POST /discovery/run` fail-closes on `deps.pluginHost` alone, and `buildApp` in the test harness does not construct one by default. The compose stack's real `main.ts` builds a host for every role, so this is the local target catching up to it, not a difference in what is being tested.

## `apps/web/e2e/graph.spec.ts`

### §13. Smoke test 4 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section)

Smoke test 4 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): create fixture data (two services + a `depends_on` edge) via `@scp/sdk` directly, navigate to `/graph/{idOrUrn}` for the source object, assert the Cytoscape container renders and shows at least the expected node/edge count. Cytoscape renders to `<canvas>`, which isn't otherwise inspectable — this suite exposes `window.__cy` for exactly this purpose (routes/graph-explorer.tsx, gated so it's unreachable outside a Playwright-controlled page — see fixtures.ts `enableGraphTestHook`).

## `apps/web/e2e/login.spec.ts`

### §14. Smoke test 1 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section)

Smoke test 1 (BUILD_AND_TEST.md §8 M2 item 2 TESTS section): navigate to `/`, get redirected to `/login` (RequireAuth's client-side guard reacting to `GET /auth/me`'s 401), fill the local-auth form with the seeded test-org admin credentials, submit, assert redirect to `/` and the dashboard renders the org name.

## `apps/web/e2e/openapi-conformance.test.ts`

### §15. M16.2 phase B (B4) — the no-bypass MATCHER, unit-tested on every PR

M16.2 phase B (B4) — the no-bypass MATCHER, unit-tested on every PR.

`outposts-no-bypass.spec.ts` uses this module to assert that every API path the browser requested is a declared OpenAPI operation. That spec is MAIN-ONLY (every E2E job in `.github/workflows/ci.yml` is gated on `push` to `main`), so if the matcher ever degraded into "accepts everything" the sweep would keep passing and nobody would learn anything from it. This file is the guard on the guard: it exercises the REJECTION cases, against the real emitted contract, in the unit-test job.

### §16. THE EXEMPTION IS GONE, and this is what replaced it

THE EXEMPTION IS GONE, and this is what replaced it.

`GET /api/v1/events/stream` (the SSE live-update channel) used to be the sweep's one carve-out: a raw `app.get` the emitter never saw, opened by `use-event-stream.ts` from `RootLayout` — on EVERY page — with a hand-built URL and a raw `EventSource`. The SSE API-parity work declared the operation and moved the UI onto the generated SDK, so it is now DECLARED and passes on its own merits. Asserting that here (rather than just deleting the old tests) is what stops a regression that dropped the declaration from silently reinstating the gap.

## `apps/web/e2e/openapi-conformance.ts`

### §17. M16.2 phase B (B4) — THE NO-BYPASS MATCHER. Charter principle 3

M16.2 phase B (B4) — THE NO-BYPASS MATCHER.

Charter principle 3: "The UI and CLI consume only the generated SDK; nothing may bypass the public API." Reading the source catches a hand-written `fetch("/api/v1/…")` only if a reviewer notices it. `outposts-no-bypass.spec.ts` checks it from the OUTSIDE instead — it captures every request the browser makes while walking the Outposts UI and asks, of each one, whether the EMITTED OpenAPI document declares that method+path.

This module is the "whether" half, kept separate from the spec on purpose: the spec was main-only (every E2E job in `.github/workflows/ci.yml` is gated on `push` to `main`), and a matcher that silently accepted everything would turn that whole check into a no-op with nothing failing. `openapi-conformance.test.ts` runs it under Vitest on every PR, including the cases that must be REJECTED.

No Playwright import here — that is what makes it unit-testable.

### §18. A path template becomes an anchored regex for one match

`/federation/outposts/{peerDomainId}` → an anchored regex matching one concrete path SEGMENT per template parameter.

`[^/]+` rather than `.+` is the load-bearing part: with `.+`, the template `/federation/outposts/{peerDomainId}` would also match `/federation/outposts/anything/at/all/undeclared`, and the whole sweep would accept paths the contract does not declare.

### §19. The sweep's pass condition

The sweep's pass condition: EVERY captured call is a declared operation. Empty is the pass.

This used to subtract an exemption list holding the one known gap — `GET /api/v1/events/stream`, the SSE live-update channel, which was registered as a raw `app.get` the emitter never saw and opened by `use-event-stream.ts` with a hand-built URL and a raw `EventSource` on every page. The SSE API-parity work closed it at the source: the operation is declared in `tools/openapi/openapi.v1.json` and `apps/web` consumes it through the generated SDK, so it is now matched by `isDeclaredOperation` like every other call. The exemption mechanism is deleted along with the exemption — an empty carve-out list is an invitation to refill it.

## `apps/web/e2e/outposts-no-bypass.spec.ts`

### §20. Nav, list and detail, and nothing bypasses the public API

M16.2 phase B (B4) — NAV → LIST → DETAIL, and NOTHING BYPASSES THE PUBLIC API.

CHARTER PRINCIPLE 3 (API-first parity): "The UI and CLI consume only the generated SDK; nothing may bypass the public API." That is normally checked by reading the source — which catches a hand-written `fetch("/api/v1/…")` only if the reviewer happens to notice it. This spec checks it from the OUTSIDE: it captures EVERY request the browser makes to the API while walking the Outposts UI and asserts each captured method+path matches an operation in the EMITTED OpenAPI document (`tools/openapi/openapi.v1.json` — the same artefact the SDK is generated from and the oasdiff gate runs against). An ad-hoc URL, a hand-built path, a route the contract does not declare: all fail, whichever layer they came from.

WHY THE MATCHER LIVES IN `openapi-conformance.ts` AND HAS ITS OWN UNIT TEST. Every E2E job in `.github/workflows/ci.yml` is guarded by `github.event_name == 'push' && github.ref == 'refs/heads/main'`, so this file does NOT run on pull requests — a matcher that quietly degraded into "accepts everything" would keep this sweep green forever and nobody would learn anything from it. `openapi-conformance.test.ts` exercises its REJECTION cases under Vitest on every PR.

The other every-PR guarantees this milestone owes live in plain vitest for the same reason: `src/components/layout/app-shell-nav.test.tsx` (the nav entry + the route tree), `src/routes/outposts-honesty.test.tsx` (the overview's honest columns), `src/routes/outpost-settings.test.tsx` (the keyless write door) and `src/routes/outpost-configuration.test.tsx` (tier / poke-mode / managed-elsewhere / reconcile). What THIS spec owns, and they cannot, is the real router, real authz, the real generated SDK over the wire, and the sweep below.

## `apps/web/e2e/runner-neutral.test.ts`

### §21. THE PLAYWRIGHT SUITE'S IMPORT GRAPH MUST NOT REACH `vitest`

THE PLAYWRIGHT SUITE'S IMPORT GRAPH MUST NOT REACH `vitest`.

WHAT THIS CLOSES (measured 2026-08-23, CI run 32604689724 job 9, and reproduced locally with a bare `node -e 'await import(".../harness.js")'`). `apps/server/src/test-support/harness.ts` is shared: vitest integration tests use it, and so does `e2e/global-setup.ts` — a PLAYWRIGHT `globalSetup`, which is a plain Node process with no vitest runner anywhere in it. A round that was cleaning up temp directories added `import { mkdtempTrackedForFile } from "@scp/test-tmpdir"` to that harness. `@scp/test-tmpdir` registers its sweep hooks at MODULE LOAD and therefore imports `vitest` at module load — correctly, for its own purpose. The consequence was that `playwright test` died 4 seconds in with "Vitest failed to access its internal state", in BOTH of this suite's modes, before one line of setup ran: not a flake, not the Chromium image, not the `cpu-features`/`ssh2` gyp warnings that shared the log.

WHY A TRANSITIVE WALK AND NOT A GREP FOR ONE PACKAGE NAME. The property is not "harness.ts must not import @scp/test-tmpdir" — that is the one instance. The property is "nothing Playwright loads may reach a module that imports `vitest`", and the next instance will arrive through some other module, several edges down, added by someone who never opens this file. So this resolves first-party imports across the whole workspace, hop by hop, and reports the exact CHAIN — the failure message is the fix instructions.

`vitest/*` subpaths count too (`vitest/suite`, `vitest/config`): `vitest/suite` is what `@scp/test-tmpdir`'s own misuse guard imports, so a re-export of that guard would be caught.

### §22. Resolves a specifier to a first-party source file, or not

Resolves a specifier to a first-party SOURCE file, or `undefined` for anything third-party (not our problem) or unresolvable. Handles the two shapes this graph actually uses: relative `./x.js` (TS/ESM, so `.js` on disk means `.ts` in source) and `@scp/<pkg>[/dist/<path>.js]`, which the Playwright setup deliberately reaches into — `dist/` is mapped back to `src/` so the gate reads the checked-in source rather than a build output that may not exist.

### §23. The Playwright entry points

The Playwright entry points: `globalSetup` plus every `*.spec.ts` (playwright.config.ts's `testMatch`). Derived from disk rather than listed, so a spec added tomorrow is covered without anyone remembering this file — a hand-written list is where the next instance would hide.

## `apps/web/e2e/seeded-demo.spec.ts`

### §24. Compose-stack-only specs, per the literal wording

Compose-stack-only specs (BUILD_AND_TEST.md §8 M2 DoD (a) literal wording; scripts/e2e-web.sh). Skipped entirely for the LOCAL target (`pnpm --filter @scp/web test:e2e`, no `PLAYWRIGHT_BASE_URL`) — that Testcontainers-backed server has neither `SCP_SEED_DEMO` data nor a built `packages/cli/dist/bin.js` alongside it. Requires `pnpm build` (for the CLI binary) in addition to `pnpm --filter @scp/web build` — scripts/e2e-web.sh does both.

## `apps/web/e2e/service-board-honesty.spec.ts`

### §25. The RENDERING half of the service board's federation-honesty rule

The RENDERING half of the service board's federation-honesty rule (apps/web/src/routes/ service-board.tsx, apps/server/src/coordination/service-board.ts).

The server can name every field it cannot observe in `unknownFields` and still fail the operator completely if the browser paints those placeholder zeros the same way it paints a real observed-and-empty value. This spec is what stops that: it pins that an unobservable field renders as an explicit "unknown here" marker, that an observed-and-empty field on the SAME board still renders as the muted dash, and that the not-driven-here count is never dressed as a success.

WHY THE BOARD RESPONSE IS STUBBED (`page.route`), unlike every other spec in this directory, which drives real API writes. The distinction under test only appears when a row's change is a READ-ONLY REPLICA of ANOTHER federation domain's — `objects.origin_domain_id` pointing at a peer. That state is reachable only through a signed bundle import from a genuinely separate instance (`importSyncBundle`); no public API this browser can call produces it, by design (single-writer authority, DESIGN §13). The server-side behaviour is covered where it can be produced honestly — on the real two-database federation topology, in `apps/server/src/coordination/service-board-federation.integration.test.ts` and `service-board-precedence.integration.test.ts`. What is left over, and what this spec owns, is purely "given this contract, does the UI render the distinction" — so the contract is exactly what is fed in. The service itself is real (created through the SDK, real route, real authz), so a silently-failing intercept surfaces as a failing assertion rather than a false pass.

### §26. The exact board contract under test

The exact board contract under test: one row this instance drives (observed-and-empty) and one it does not (every detail field declared unobservable).

TYPED AS THE REAL RESPONSE, and that annotation is the point. This builder and `stubBoard` were both untyped (`payload: unknown`), so when #222 added three REQUIRED fields to `ServiceBoardResponse` — `rows[].pipelines`, `servicePipelines`, `childAssemblies` — this stub kept compiling while serving a payload the UI could no longer render. Typecheck could not see it, the unit fixtures WERE typed so they were fixed, and this one was `main`-only so nothing caught it. With the annotation, the next required field is a compile error in the "2. Static checks" job.

### §27. A null driver means no latest change, not none anywhere

`driver: null` means NO latest change to attribute to anyone, not "this domain drives it" (fix(web) "qualify data-driven-here", src/routes/service-board.tsx) — that renders "none", the third of three states. This row is genuinely locally-driven, so it needs an explicit driver object to assert `data-driven-here="true"` (mirrors the `locallyDriven` fixture in src/routes/service-board-honesty.test.tsx).

### §28. A freeze crosses only if the declaring domain federated it

Board-level: a freeze crosses only if the domain that declared it federated it (M25.7, owner decision D6), and that defaults off — so no row's "not frozen" is a statement about freezes declared in another domain. This comment said "freezes never ride the sync journal" until D6 retracted that; the fixture VALUE is unchanged, because the caveat still fires unconditionally on any peer, and the reason is corrected here rather than left stale in a green spec.

### §29. 5. The board-level freeze-visibility caveat

5. The board-level freeze-visibility caveat: a freeze crosses only if the domain that declared it federated it, and that defaults off (M25.7 / owner decision D6) — so an unfrozen row on a federated instance means "none VISIBLE here", not "none applies", for EVERY row alike.

```text
 THE SECOND COPY OF THE SAME CLAIM IN THIS FILE, and it survived the first pass of the M25.7
 census: the fixture comment at the top was corrected and this one was not, so the file
 asserted the retracted reasoning ("freezes never replicate") and its replacement at once. A
 per-file census that stops at the first hit is the same defect the project instructions name
 for a repo-wide one; the fix is to finish the file.
```

## `apps/web/e2e/sse-live-update.spec.ts`

### §30. Smoke test 3

Smoke test 3 — the core mechanism DoD (a) tests (BUILD_AND_TEST.md §8 M2 item 2): with `/services` already open, create a NEW service via the API WITHOUT reloading the page, and assert it appears within a short timeout. `expect(...).toBeVisible()` is Playwright's built-in auto-retrying (polling) assertion — deliberately NOT a `page.reload()`, which would defeat the point of testing SSE (routes/events.ts -> events/sse-hub.ts -> apps/web's src/lib/use-event-stream.ts query-cache invalidation).

## `apps/web/playwright.config.ts`

### §31. Playwright smoke suite

Playwright smoke suite (BUILD_AND_TEST.md §4.4 "also a `pnpm --filter @scp/web test:e2e` local target against the dev server", §8 M2 item 2 TESTS section). Chromium only, per BUILD_AND_TEST.md §1's toolchain table — no other browsers needed.

`globalSetup` (e2e/global-setup.ts) boots a real backend against the built `apps/web/dist` (`pnpm --filter @scp/web build` must run first — not orchestrated here, kept as an explicit separate step). Serial (`workers: 1`) rather than parallel: this is a small (~5 test) smoke suite sharing one org/server, and serial execution removes an entire class of cross-test data races for negligible extra wall-clock time — simplicity over parallelism here, same call apps/server's own integration suite makes (vitest.integration.config.ts's `singleFork`).

## `apps/web/src/components/RequireAuth.tsx`

### §32. Route guard for every authenticated page

Route guard for every authenticated page (BUILD_AND_TEST.md §8 M2 item 2: "route-guard authenticated routes (redirect to /login if /auth/me 401s)"). Client-side redirect only — the SPA has no server-rendered path to a real HTTP redirect here, `/auth/me`'s 401 is what's authoritative; this just reacts to it.

## `apps/web/src/components/decision/DecisionDetailDialog.tsx`

### §33. The shared FULL-RECORD view of one Decision (charter principle 6)

The shared FULL-RECORD view of one Decision (charter principle 6) — opened from a Why-style affordance on `/admin/decisions` and `/admin/audit`. Every gate/policy engine writes a Decision with its `verdict`, `reasonTree` and `inputContext`; this is the one place all three render, so a future adopter reuses it rather than re-implementing reason formatting.

NOT `WhyLink`/`ReasonDialog`: `WhyLink` anchors within a change's OWN Decisions timeline (or navigates to one) — it has nothing to scroll to on a standalone Decisions/Audit list, which shows every subject's Decisions in one table, not one change's. `ReasonDialog` is the REASON-INPUT dialog behind cancel/rollback, a different concept entirely (it collects a reason, it does not render one). This dialog is the missing third piece: a stand-alone viewer, keyed by id, reusing `decisionSummary` (`decision-format.ts`) for the one-line summary exactly as the change/campaign timelines do — "one renderer for reasons, everywhere" holds at the FORMATTING layer even though the container is new.

`decision === null` covers the fetch-in-flight and fetch-failed states (`error` is rendered verbatim by the caller, never invented here) so this component never shows a stale record under a new id.

## `apps/web/src/components/decision/ReasonDialog.tsx`

### §34. The shared shell for every reason-carrying transition dialog

The shared shell for every reason-carrying transition dialog (design spec §2.13): change cancel/rollback today, campaign rollback after its own migration.

MODULE CONTRACT for later adopters (campaign-detail.tsx): `testIdPrefix` drives every testid and the label/input ids — `${prefix}-dialog`, `${prefix}-reason` (label htmlFor + input id), `${prefix}-reason-input`, `${prefix}-submit` — so passing `testIdPrefix="rollback-campaign"` reproduces the campaign dialog's pinned ids exactly; title/description/submitLabel carry the campaign copy. No changes here are needed to adopt it.

`reasonRequired` drives client-side enforcement of `RollbackChangeRequestSchema`'s `reason: z.string().min(1)` (packages/schemas/src/changes.ts) — cancel's reason is optional server-side, so it stays submittable empty.

## `apps/web/src/components/decision/WhyLink.tsx`

### §35. The shared "Why?" link (design spec §2.13)

The shared "Why?" link (design spec §2.13) — the explainability affordance beside any blocked action. It always lands on the `#decision-<id>` row of a change's Decisions timeline (never a separate page — every Decision that could block a change is already in that list).

MODULE CONTRACT for later adopters (campaign-detail.tsx): same-page use passes only `decisionId` (anchor + smooth scroll, default testid `why-link`); cross-page use adds `changeId` (router Link with the decision hash) and its own `data-testid` when a page pins one.

## `apps/web/src/components/decision/decision-format.ts`

### §36. Decision formatting shared by every timeline surface

Decision formatting shared by every surface that renders a Decision timeline (design spec §2.13): change detail, change pipeline, and (after its own migration) campaign detail. Structural inputs only — nothing here imports a campaign type, so adopting it needs no changes to this module.

## `apps/web/src/components/domain-local.test.tsx`

### §37. House pattern (outposts-honesty.test.tsx)

House pattern (outposts-honesty.test.tsx): `Link` throws outside a RouterProvider, so it is stubbed — but UNLIKE the bare-anchor stub there, this one interpolates `params` into `to`, because the EndpointName tests below assert the href. What that pins is that the component CHOSE the link branch and fed it the right registry basePath + object id; TanStack's own interpolation is covered by the E2E spec against the real router.

### §38. The three properties of this UI a refactor could lose

M20 (ADR-0031) — pins the three properties of the domain-local UI that a refactor could silently lose without a compile error:

1. The publish card is gated on the OBJECT's `domainLocal` bit and nothing else — no federation role ever enters the decision. The commander-side guarantee is structural (the object never arrives), so the only correct client-side condition is the bit itself; a role check would be the conditional-view failure mode M16.3's census found. 2. The confirm copy states irreversibility in the exact terms ADR-0031 §6 uses ("one-way", "no un-publish") — this is the safety copy for an action that cannot be undone, so its presence is behaviour, not wording. (Phrasing may move between elements; the CLAIMS may not disappear.) 3. Nothing in this module offers an inverse. There is deliberately NO un-publish control to assert on; instead we assert the module renders no button/verb containing "un-publish".

Plain `renderToStaticMarkup`, no jsdom — same harness as replica-origin.test.tsx. Radix's dialog portals render nothing statically, which is why the confirm body is exported and asserted directly.

### §39. The link decision is derived entirely from the urn

The sweep report's link decision is derived ENTIRELY from `otherEndpointUrn`'s type segment, and the no-link branch depends on a server-side FALLBACK (a vanished endpoint degrades the urn to the raw id), not on a contract. These pin both branches so a change to that fallback — or to the urn shape — breaks a test here instead of shipping a dead link (M20 author's caveat, 2026-08-13).

## `apps/web/src/components/domain-local.tsx`

### §40. M20 (ADR-0031) — the three UI surfaces of a domain-local object

M20 (ADR-0031) — the three UI surfaces of a domain-local object: the badge, the create-form declaration, and the one-way publish verb.

Everything in this file keys on the OBJECT's own `domainLocal` bit, never on the instance's federation role. That is deliberate and load-bearing (ADR-0031 §Consequences): the commander's UI simply never receives a domain-local object, so there is nothing to conditionally hide — and a role-gated view would reintroduce exactly the failure mode M16.3's write-control census found. Do not add `federation.self` checks here.

### §41. Worn wherever the object's name is (list row, detail header)

Worn wherever the object's name is (list row, detail header). `domainLocal` is a declared fact, not an unknown — so this is a neutral pill (spec §1.5), not the amber-dashed honesty badge.

M20.7 (ADR-0031 §6c): `inheritedFrom` is the server-stamped provenance — `null` means declared directly, present means inherited at create from that container. It is READ, never derived (the whole point of asking the server for it), and it is HISTORY: where the bit came from, not whether that container still withholds publication. Never use it to predict a §6b refusal.

### §42. The create-form declaration

The create-form declaration. Create-time only by contract (ADR-0031 §6): shared → domain-local is refused permanently after the fact, so this checkbox is the ONE moment the property can be set — the help text says so instead of letting the operator find out from a 409 later.

M20.5 (§6a): declared on a CONTAINER (domain, service, assembly), locality propagates — anything created underneath inherits at ITS create, one hop, along either containment route. The help text names that, and names the boundary: inheritance happens at create only, never as a retrofit of an existing subtree. The payload contract stays omit-when-unchecked — an explicit `domainLocal: false` inside a local container is a 400 by design (the operator asked for shared and must not silently get local), and omitting the field is what lets inheritance decide.

### §43. The confirm copy, exported so the test can render it

The confirm copy, exported as its own component so `domain-local.test.tsx` can pin the load-bearing phrases without fighting Radix's portal (which renders nothing under `renderToStaticMarkup`).

### §44. The publish verb (ADR-0031 §6)

The publish verb (ADR-0031 §6) — an ACTION with an effect, deliberately not a field edit, so the card renders it as one: an explicit button, an irreversible-confirm dialog, and a visible report of the edge sweep afterwards (published vs withheld buckets).

Renders `null` unless the object is domain-local (or was just published in this session — the result panel must survive the refetch that flips `domainLocal` to false). Gating is data-driven only; see the module doc.

### §45. One bucket of the edge-sweep report, from the arrays

One bucket of the edge-sweep report, rendered from the DESCRIBED arrays (`publishedRelationships`/`withheldRelationships`) the contract grew after this UI's first cut flagged the bare-id arrays as illegible. Each row is edge type → other endpoint by name, urn in the tooltip. The withheld bucket's endpoint links to its own page when its type is a routed registry — "publish that endpoint" is the operator's next action, and its publish card lives there. A vanished endpoint degrades urn/name to the id server-side, so the name is always safe to render (and the failed registry lookup makes such a row plain text, not a dead link).

### §46. The provenance stamp's container

The provenance stamp's container (M20.7), linked into its registry page when its urn names a routed type — same urn-derived link decision as EndpointName below, same degradation to plain text when the type segment resolves to no registry.

### §47. The other endpoint, linked when its urn names a route

The other endpoint, linked into its registry page when its urn names a routed type.

Exported for `domain-local.test.tsx`, which pins BOTH branches — because the no-link branch rides on a server-side FALLBACK, not a contract (the M20 author's caveat, 2026-08-13): a vanished endpoint currently degrades `otherEndpointUrn` to the raw id, which happens to have no type segment and so resolves to no registry. If that fallback ever changes shape (say, to the literal string "unknown"), the pinned test is what turns the change into a red test instead of a dead link discovered by an operator.

## `apps/web/src/components/error-boundary.test.tsx`

### §48. ADR-0023's CONTAINMENT HALF

ADR-0023's CONTAINMENT HALF. Response validation makes a contract failure loud and single; a boundary makes it contained. `apps/web` shipped the first without the second, so any throw during render unmounted the whole tree and left a literally blank page — MEASURED as `container.innerHTML.length === 0` in `routes/federation-status-crash.test.tsx`'s original form.

These cases pin the boundary's BEHAVIOUR (what an operator can read off the screen), and the last one pins that it is actually MOUNTED around the router outlet — a boundary that exists but wraps nothing is the wording-not-behaviour failure this repo keeps re-learning.

## `apps/web/src/components/error-boundary.tsx`

### §49. THE CONTAINMENT HALF OF ADR-0023

THE CONTAINMENT HALF OF ADR-0023 — `apps/web` HAD NO ERROR BOUNDARY AT ALL.

Response validation makes a contract failure LOUD and SINGLE. A boundary makes it CONTAINED. The two are complements, and until this component the SPA shipped only the first: any throw during render — a validation error surfaced by a `useSuspenseQuery`-style read, an unguarded dereference in one leaf cell, a bug in a formatter — unmounted React's whole tree and left the operator a literally blank page with the diagnosis only in the devtools console. That is measured behaviour, not a worry: `federation-status-crash.test.tsx` recorded `container.innerHTML.length === 0` for exactly one such throw.

WHERE IT SITS. Wrapped around the router `Outlet` in `RootLayout`, so it contains EVERY route. It is deliberately NOT per-card: a boundary is the last line, and the per-query `isError` branches (`QueryErrorNotice`) are the first — a page that handles its own read failure never reaches this component, and a page that does reach it has a bug worth showing as a bug.

WHAT IT RENDERS. The same diagnosis the `isError` branches render — verbatim `error.message`, plus the contract/version-skew framing when the throw is a response-validation failure — because the failure mode this exists to catch is precisely the one a fixed "Something went wrong" would make undiagnosable again. `Try again` clears the captured error and re-renders the route; a transient fault recovers without a full page load, and a persistent one immediately re-renders this panel.

## `apps/web/src/components/graph/GraphCanvas.tsx`

### §50. Shared Cytoscape.js node-link renderer for both `/graph`

Shared Cytoscape.js node-link renderer for both `/graph` (org overview) and `/graph/{idOrUrn}` (object-scoped explorer). Extracted from the original graph-explorer page so the two entry points render identically and the testability hook / click-to-navigate behaviour lives in one place.

`window.__cy` is exposed for Playwright (apps/web/e2e) — Cytoscape renders to `<canvas>`, which isn't otherwise inspectable, so the e2e suite asserts on the real rendered node/edge counts via this handle. Gated on `import.meta.env.DEV` OR the runtime `__SCP_E2E__` flag the e2e suite injects (fixtures.ts) — the flag is what actually matters, since the e2e suite runs against the SAME production build (`vite build`) that ships in the Docker image, where `import.meta.env.DEV` is false. Nothing in real production traffic sets `__SCP_E2E__`, so this never activates outside a Playwright-controlled page.

### §51. FIT, THEN CLAMP

FIT, THEN CLAMP — shared by the auto-fit-on-layout effect and the Maximize control (§4 Group D) so the two never drift into two different "fit" behaviours. `fit` frames the graph with padding; the clamp stops a small graph being magnified past life size, and re-centres after clamping so the content stays put rather than drifting to a corner.

### §52. Per-layout spacing, since the defaults pack too densely

Per-layout spacing. Cytoscape's defaults are tuned for dense graphs and pack a handful of nodes into a tight cluster where the labels (rendered BELOW each node) overlap each other and the neighbouring shapes — so a five-service org map was unreadable despite having room to spare. These widen the spacing enough for a label to sit under its own node; `avoidOverlap`/`nodeOverlap` stop shapes colliding outright.

### §53. The layout options type is a union keyed on the name

Cytoscape types `LayoutOptions` as a UNION of per-layout option shapes keyed on a literal `name`, so a config assembled from a runtime string cannot be narrowed to one member. The cast is at the boundary and the option bag above is the only thing that reaches it; an unknown layout name falls back to bare padding rather than passing something Cytoscape would reject.

### §54. SHAPE = type, COLOUR = group

SHAPE = type, COLOUR = group (lib/graph-visual.ts). Both are computed per node and handed to Cytoscape as data, so there is one style rule instead of one per type — a new object type gets a shape by adding a row to `NODE_SHAPE_BY_TYPE`, not a selector here. This replaced fixed per-type colours (service blue, component purple), which spent the colour channel on something shape already says and left a graph of N components as N identical dots.

### §55. Health overlay (observe-enrichment signal 4)

Health overlay (observe-enrichment signal 4) — a colored border ring keyed on the OPTIONAL `health` node-data field, using the same attribute-selector technique as `node[?external]`/`node[?root]`. A `node[health=...]` selector out-ranks the base `node` rule and is undefined-safe: nodes without health (overlay off, or nothing pushed) match none of these and render exactly as before. Grey = unknown/no push (never fabricated).

## `apps/web/src/components/graph/GraphLegend.tsx`

### §56. Legend for the graph views

Legend for the graph views. Keeps the node/edge encoding legible without cramming a key into the canvas.

TWO CHANNELS, TWO SECTIONS. Shape says what a node IS and is fixed; colour says which group it belongs to and is recomputed per view, so a colour swatch per type would be a lie. `shapes` therefore renders neutral-grey glyphs (the shape is the message, the fill is not), and `note` carries the one sentence explaining what colour means in THIS view.

Star/hexagon/pentagon were previously approximated with a `clip-path` polygon on a plain div — close enough to read at a glance but visibly not the real shape. Those three now render the actual lucide glyph (§4 Group D); circle and the other clip-path-drawable shapes stay divs since a CSS shape IS the real shape for them (no approximation to fix).

## `apps/web/src/components/icons/catalog-marks.tsx`

### §57. THE CATALOG MARKS

THE CATALOG MARKS (owner direction, 2026-08-11): the service → assembly → component trio in the same military-materiel language as the federation role insignia (federation-roles.tsx) — built via `createLucideIcon`, hand-drawn on the 24px grid, air-gap-inert inline path data.

```text
- SERVICE — a GUIDON: the swallow-tail unit standard. The service is the thing an organization
  owns end-to-end; everything beneath it rallies to this flag.
- ASSEMBLY — a CRATE STACK: materiel grouped for movement. An assembly is a macro-component
  "built and released as a set" (GLOSSARY) — literally components stacked together.
- COMPONENT — a single cross-braced AMMO CRATE: the unit that actually ships. Components are
  what releases move through the pipeline, and a crate is the thing that moves.
```

The trio is ordinal on purpose: flag above stack above crate mirrors the containment ladder. Path data is exported separately so `lib/graph-glyphs.ts` can rasterize the SAME drawings into Cytoscape node glyphs — one source of truth per mark, never two drawings that drift.

## `apps/web/src/components/icons/federation-roles.tsx`

### §58. THE FEDERATION ROLE SYMBOLS

THE FEDERATION ROLE SYMBOLS (owner direction, 2026-08-11): minimalist, military-flavoured marks for the three service roles of ADR-0004 — commander / outpost / retrans. Built through `createLucideIcon` so they are first-class lucide citizens: same stroke conventions, same `size-*`/`strokeWidth` props, drop-in wherever a `LucideIcon` is accepted (Badge `icon`, NavIcon, EmptyState). Hand-drawn on the 24px grid; inline path data, so the air-gap posture is unchanged.

The vocabulary (design spec §1.6 extension): - COMMANDER — a five-pointed star over a base bar: the general-officer star, the single most legible "command" mark there is, grounded by the bar so it reads as an insignia rather than a rating/favourite star. (A figure/portrait was considered and rejected: unreadable at 14px, and the star IS the military symbol for command.) - OUTPOST — a crenellated fort tower with a door: the field fortification, distinct at a glance from every rounded lucide glyph around it. - RETRANS — an antenna mast with signal arcs on BOTH sides: receive on one flank, resend on the other — the arcs literally state "retransmission", which one-sided broadcast glyphs (RadioTower, Antenna) do not.

## `apps/web/src/components/layout/AppShell.tsx`

### §59. §3.2 link treatment + the shared focus ring

§3.2 link treatment + the shared focus ring (§2.10). Active gets the army-olive accent — its second sanctioned home — and repaints the entry's icon via the descendant selector, since TanStack's `activeProps` only reaches the anchor itself. DARK-OLIVE SIDEBAR (owner, 2026-08-11 second theme round — "more green undertones in the bars"). The sidebar is the one chrome surface that can carry the army identity at full strength without costing data readability: content cards stay white, the rail goes army-900. Contrast checked: army-100 text on army-900 ≈ 9:1; the army-300 section labels ≈ 6:1.

### §60. The CATALOG rung of the nav

The CATALOG rung of the nav — what this org runs.

Derived from `REGISTRIES` by an ALLOW-LIST rather than by filtering the ones we don't want, so a registry added later (a third container level, say) is absent until someone decides where it belongs, instead of silently appearing in the sidebar. The four identity registries live behind `/identity`; `deployment-target` is surfaced inside the pipeline views, where a target is already a wave target. `components` is BOTH a drill-down (from a service or assembly) and a top-level registry — owner decision 2026-08-10, after the first cut demoted it to drill-down only and that lost the flat "every component in the org" list.

`domains` is out of the nav (owner decision 2026-08-10). The CONTAINMENT domain still exists and is still the rung policy resolution, RBAC scope expansion, freeze scoping and the scan-requirement tier chain all walk — only its registry page left the sidebar. `/domains` stays routed, so creating one or attaching an owner is still reachable by URL; nothing in the UI linked to it but this nav entry. (It is NOT covered by the Outposts page: federation tables carry no foreign key into `objects`, so an outpost's `peerDomainId` and a containment-domain row are different identifier spaces — see docs/GLOSSARY.md, which separates the six live senses of "domain".)

### §61. TWO SITES, ONE BUNDLE

TWO SITES, ONE BUNDLE (outpost-ui.md §9, owner correction 2026-08-14).

The nav is DATA selected by the serving instance's install-time role (`/auth/me`'s `instanceRole`, from `SCP_FEDERATION_ROLE`) — the commander site and the smaller outpost site are two tables rendered by one component, so `app-shell-nav.test.tsx` can pin BOTH shapes and a change to either is a visible diff to a table, not a conditional buried in JSX.

What the outpost site does NOT carry, and why (owner decisions): - Campaigns, Graph — org-wide coordination is the commander's job. - Outposts, Federation status — managing OTHER outposts is commander-only; the outpost's own sync status lives under Admin instead. What it keeps: a smaller Dashboard as home (the targets this outpost controls, at the component level), the Catalog (domain-local objects live there), Setup, and Admin.

This decides nav + route table ONLY. It authorizes nothing and gates no rendering inside a page — M16.3's offer-the-write rule and ADR-0031's data-keyed domain-local rendering are unchanged. Two sites having different page sets is a deployment fact; a role check inside a shared page would still be the lie those precedents forbid.

### §62. The instance's declared federation role, worn under the wordmark

The instance's declared federation role, worn under the wordmark (owner follow-up 2026-08-11: role-aware branding). POST-AUTH ONLY, by decision: the login page must not learn the role — telling an unauthenticated visitor "this box is the commander" is topology disclosure a CDS-adjacent deployment should not make, and it would need a new unauthenticated API field. Here the viewer is already inside; `federationSelfKey` shares its cache with the federation pages, so this costs one fetch per session. `unset` renders nothing — an undesignated role has no insignia (same rule as roleBadge).

## `apps/web/src/components/layout/BrandMark.tsx`

### §63. The brand mark (design spec §3.3)

The brand mark (design spec §3.3): an army-olive tile holding the instance's insignia in white.

SITE-SHAPED (outpost-ui.md §9, owner 2026-08-14): the commander site wears the COMMANDER STAR — the official logo — and the outpost site wears the OUTPOST FORT. Same drawings as the role badges (icons/federation-roles.tsx) and the two favicons (public/favicon*.svg): one insignia per role, three surfaces, zero drift.

`role` is the INSTALL-TIME instance role from `/auth/me` and is therefore POST-AUTH ONLY. The login page passes nothing and gets the star on every instance, deliberately: telling an unauthenticated visitor "this box is an outpost" is topology disclosure a CDS-adjacent deployment must not make (the same rule the role chip has always followed). `sm` (size-7 tile) sits beside the sidebar wordmark; `lg` (size-10) is the centered login mark. Stroke width per §1.6.

### §64. Swap the browser-tab icon to match the site

Swap the browser-tab icon to match the site — called by the shell once the role is known. Idempotent; a no-op when the link already points at the right file. Static default in index.html is the commander star (see the favicon files' own comments for why the outpost variant is never the pre-auth default).

## `apps/web/src/components/layout/RootLayout.tsx`

### §65. Root route component (router.tsx)

Root route component (router.tsx) — owns the app's ONE SSE connection for its whole lifetime, and the app's ONE error boundary (ADR-0023's containment half; `../error-boundary.tsx`). The boundary wraps `Outlet` rather than sitting above this component so a throw inside a route cannot take the SSE subscription down with it: `useEventStream` keeps running, and "Try again" re-renders the route into a still-live tree.

## `apps/web/src/components/layout/app-shell-nav.test.tsx`

### §66. M16.2 phase B (B4) — THE NAV GUARANTEE, on every PR

M16.2 phase B (B4) — THE NAV GUARANTEE, on every PR.

The E2E spec (`apps/web/e2e/outposts-no-bypass.spec.ts`) walks nav → list → detail against the real router. When this was written every E2E job was `main`-only and SKIPPED on pull requests; they now run on PRs and 5z requires them. These two properties stay pinned here regardless, because a nav guarantee is worth a check that costs milliseconds:

```text
1. "Outposts" is REACHABLE from the nav at all (a page nothing links to is a page nobody finds);
2. the pre-existing `/federation` entry SURVIVES. It ships today and may be bookmarked; adding a
   section is not a licence to rename an existing destination out from under one.
```

…plus the route tree itself, asserted against the real `router` object: a nav link to a path with no route is a 404 that no unit test of the sidebar alone would catch.

The three hooks `AppShell` calls (`useAuth`, `useNavigate`, `useQueryClient`) all require providers this file deliberately does not stand up — the sidebar's link set is what is under test, not the auth session — so they are stubbed. `Link` renders a real `<a href>` so the assertions are about destinations rather than about component identity.

### §67. Every `href` the sidebar renders, EXACTLY

Every `href` the sidebar renders, EXACTLY — not by substring.

`expect(html).toContain('href="/federation"')` was the previous form and is satisfied by the Outposts link alone, since `href="/federation/outposts"` contains it: the "Federation survives" assertion could not have failed while Outposts existed. Exact hrefs close that.

### §68. THE OUTPOST SITE

THE OUTPOST SITE (outpost-ui.md §9, owner correction 2026-08-14): the same bundle serves a SMALLER site when the instance's install-time role is `outpost`. Pinned as a table diff against the commander site above — the whole point of making the nav data was that this test could say, per entry, which site carries it and which does not.

### §69. SITE-SHAPED INSIGNIA (outpost-ui.md §9, owner 2026-08-14)

SITE-SHAPED INSIGNIA (outpost-ui.md §9, owner 2026-08-14): the outpost site wears the fort, the commander the star — and the login page ALWAYS wears the star, because the role is post-auth only (topology disclosure). Pinned by the `data-insignia` attribute rather than SVG path text, so a redraw of either icon does not break the test while a swapped role does.

## `apps/web/src/components/pipeline/BoundarySegmentStrip.tsx`

### §70. M16.1 — THE UNIVERSAL BOUNDARY SEGMENT, rendered

M16.1 — THE UNIVERSAL BOUNDARY SEGMENT, rendered (ADR-0011; vocabulary fixed by ADR-0021 D6).

A boundary SEGMENT composed of two boundary PHASES — *transferred* and *validated*. It is NOT a "stage" (a stage is a deployment PLACE, `<domain>[-<location>]-<env>`) and NOT a "wave" (a wave is the set of stages advanced at once). Purely presentational: the server (`coordination/boundary-segment.ts`) computes every state from real ledger rows and real Decisions; this paints them and drives nothing.

## Why a sibling component rather than widening `PromotionState`

`PromotionArrow.tsx`'s own doc comment defines `PromotionState` as the gate/approval state of a promotion **between two consecutive waves**, and says it is "deliberately a small closed set the *existing* model can already answer honestly" — it then refuses a hold/release state on exactly that ground. Adding `unknown` to it would (a) hand every inter-wave arrow, where the model CAN always answer, a way to shrug, and (b) reuse inter-wave promotion vocabulary for a domain-crossing segment that ADR-0021 D6 gives its own words. So `PromotionState` is left untouched and the segment gets its own two-phase vocabulary here.

## The honesty contract (same rule the service board follows)

`segment.unknownFields` names, by dotted path, every field this instance CANNOT OBSERVE. Those fields still carry a zero value on the wire for shape stability — but a zero is not an observation, and it must never be painted like one. Concretely: an exporting instance can never see the receiving outpost's validation outcome, so `validate.state` arrives as `not_reported` AND is named unknown; painting that as anything other than an explicit unknown would be a fabricated pass. Pinned by `apps/web/src/routes/change-pipeline-boundary-honesty.test.tsx`.

### §71. The channel distinguishes an ordinary hop from the other

drizzle/0087 — `hop.channel` distinguishes an ordinary metadata `.scpbundle` hop from a retrans byte-relay leg (`BoundaryTransferHopSchema`'s doc). The split only fires when at least one hop actually carries `'bytes'`: a hop with `channel: null`/`undefined` (pre-0087 row, or a writer that could not determine it) is folded back into the plain count rather than counted as "not a byte relay" — that would assert a metadata reading this instance was never told.

### §72. `isAbsent`, not `!== null`

`isAbsent`, not `!== null`: `authorizedArtifactCount` is required-NULLABLE, and BEFORE ADR-0023 the generated SDK validated no response, so a server that omitted the key reached this branch with `undefined` and printed the literal `undefined authorized artifacts`. SINCE ADR-0023 the SDK rejects that body at the boundary — the key is required, so an omission is a contract violation — and this is defence in depth for every other source of a segment. Same class as the federation cells.

### §73. The always-shown two-phase boundary segment for one change

The always-shown two-phase boundary segment for one change.

`data-verified` is the machine-readable summary, and it is "unknown" — never "false" — whenever the server declared `validate.state` unobservable. A bare `data-verified="false"` over a field listed in `unknownFields` would reintroduce in the DOM exactly the confusion the response shape removes on the wire (the same reasoning as `service-board.tsx`'s `data-blocked`).

### §74. What the pipeline shows when `explain` returned

What the pipeline shows when `explain` returned `boundarySegment: null` — a change that has not crossed a domain boundary. Stated explicitly rather than rendered as an empty/green segment: the segment is ALWAYS SHOWN, and its absence is itself the honest answer (ADR-0013's domain-local exemption / "domain-local changes have a shorter pipeline").

M20-A3 (ADR-0031 §5, docs/proposals/outpost-ui.md) — `boundarySegment: null` used to be AMBIGUOUS between two genuinely different reasons: an ordinary change that just hasn't been promoted yet, and a domain-local change that structurally never crosses a boundary at all. Now that `Change.domainLocal` is on the wire, the caller passes it through and this renders the honest one of the two — never the generic "not yet promoted" reading for a change that in fact has nowhere to be promoted TO.

## `apps/web/src/components/pipeline/PipelineWaveCard.test.tsx`

### §75. The observed-truncation honesty rules, as rendered

`observed.truncation` HONESTY (docs/proposals/observed-truncation-ui.md §3, M23.1g) — the card must not let a platform-side persistence cut render as "the executor never reported this".

MUTATION-SENSITIVITY, stated up front rather than left implicit: every pill assertion below goes RED if the corresponding `dropped: true` in its fixture is flipped to `false` (the field then "renders" instead of being reported truncated) or deleted (the truncation key vanishes, which is rule 6 territory and is pinned separately as its own case). The marker-text assertion goes RED if `realImages`/`imageVersionLabel` is bypassed and `images[0]` is rendered directly again — that is the actual regression this proposal exists to prevent, not a hypothetical.

Same harness as `change-pipeline-hold.test.tsx`: `renderToStaticMarkup`, no jsdom, `Link` stubbed to a bare anchor since it throws outside a `RouterProvider`.

### §76. `ChangeWaveTargetSchema.hold` / `ChangeWaveSchema.heldTargetCount`

`ChangeWaveTargetSchema.hold` / `ChangeWaveSchema.heldTargetCount` (M25.UI increment 2) — the freeze half of a target's hold, read straight off the target rather than a `holdFor` closure (unlike the stage-dependency half, which mirrors `change-pipeline-hold.test.tsx`'s own reasoning for testing at THIS altitude: the card is the thing that owns rendering it once handed the field, and `wave={wave}` on every real page already carries `targets[].hold` straight from the `explain` response — no page-level plumbing is needed for the freeze half at all).

### §77. THE CONTINUOUS-PROBE HALF OF A TARGET'S HOLD

THE CONTINUOUS-PROBE HALF OF A TARGET'S HOLD (team-pipeline-iac D21/D11, increment 8).

WHAT WAS BROKEN: `ChangeWaveTargetSchema.hold.continuousTests` has been on the wire since increment 8 and this component read only `hold.freezes`. A target held SOLELY by a stale or failed probe therefore rendered a `held` badge with NOTHING beneath it — the operator could see that the wave was stuck and not why, for a reason the server had already composed and sent. It is the same shape as the truncated-as-absent lie this card had to fix once before: the data arrived and the UI dropped it.

Case 1 is the load-bearing one. It asserts the LINE, not merely the badge — a test that only checked for `held` would have passed against the broken build, since the badge came from the freeze half and the stage-dependency half all along.

## `apps/web/src/components/pipeline/PipelineWaveCard.tsx`

### §78. THE ONE WAVE CARD

THE ONE WAVE CARD (design spec §2.13) — one compiled wave, one ordered step of a plan, the set of stages advanced at once (ADR-0021 D6), rendered top-to-bottom with `PromotionArrow` connectors.

MODULE CONTRACT — generalized so change surfaces use it today and campaign-detail.tsx migrates onto it later WITHOUT changes here: - `wave` is the narrow STRUCTURAL `PipelineWaveLike` below, which both `ChangeWave` and `CampaignWave` already satisfy (they mirror). Deliberately not a union of the SDK types: a type-only structural prop keeps campaign schemas out of this module's import graph entirely, so bundling/tree-shaking cannot drag them in. - `testIdPrefix` drives every testid: `${prefix}-card`, `${prefix}-status-badge`, `${prefix}-kind-badge`, `${prefix}-target-row`, `${prefix}-observed-image`, `${prefix}-observed-revision`, `${prefix}-observed-rollout`, `${prefix}-executor-link`, `${prefix}-repo-link`, `${prefix}-target-change-link`. Defaults `pipeline-wave` (the change pipeline view); change detail passes `wave` (its historical ids); campaigns pass `campaign-wave`, which reproduces the wave board's pinned ids exactly. - Change-only detail (category/type kinds, attempt, observed version/rollout) and campaign-only detail (`memberChangeObjectId` → the member-Change link) are optional fields: each renders exactly when the data is present, so campaigns get version/executor/rollout parity the moment their wire type carries the fields. - `linksFor` is optional — surfaces that don't fetch binding/source links simply omit it.

### §79. ONE FIELD'S ENTRY IN `observed.truncation`

ONE FIELD'S ENTRY IN `observed.truncation` — mirrors `PersistedJsonFieldTruncation` (`packages/runner-launcher/src/index.ts`) as surfaced through `ChangeWaveTargetSchema` (`packages/schemas/src/changes.ts:346` on #264). `dropped: true` means the field is not in the stored value AT ALL, and that is the persistence bound's doing, not the executor's silence — the whole reason this module cannot keep treating "absent" and "cut" as the same pixels (docs/proposals/observed-truncation-ui.md, charter principle 6).

### §80. One covering freeze on a wave target's `hold.freezes`

One covering freeze on a wave target's `hold.freezes` (`ChangeWaveTargetSchema.hold` — packages/schemas/src/changes.ts, campaigns-rework.md's "wave-target hold projection"). Every field is exactly as the server composed it — `summary` is a rendered-verbatim sentence (charter principle 6: this module composes no copy from raw fields), `scope` is already enriched to `{objectId, name}` (`null` for a platform-tier freeze), and `endsAt` is the window's real boundary, never `now`.

### §81. One holding continuous probe on a wave target

One holding `continuous` probe on a wave target's `hold.continuousTests` (`ContinuousTestHoldSchema`, team-pipeline-iac D21/D11). Composed at read time exactly like the freeze half — a probe that goes green is simply ABSENT on the next read, never a stale "held".

`reason` is carried and rendered because the three states hold identically and mean different things, and an operator's next action differs for each: `no_evidence` and `stale` say go look at the PROBER, `failed` says go look at the TARGET. Collapsing them to "held" would make the badge honest and the page useless. `summary` is server-composed and rendered VERBATIM, per the same rule the freeze line follows.

### §82. The FREEZE-HOLD half of `ChangeWaveTargetSchema.hold`

The FREEZE-HOLD half of `ChangeWaveTargetSchema.hold` — present only while the target is genuinely held by an active freeze, composed at read time (a lifted freeze is simply absent on the next read). CampaignWaveTarget does not carry this yet, so it is optional and a campaign wave simply renders no freeze line — never a fabricated one. The STAGE-DEPENDENCY half of a hold rides a SEPARATE channel (`holdFor` below) for the reason that field's own doc states: it is not part of this schema.

### §83. The CONTINUOUS-PROBE half of the hold

The CONTINUOUS-PROBE half of the hold. Optional on the wire and never sent as an empty array (`ChangeWaveTargetSchema.hold`), so `undefined` here means "no probe holds this target" and NOT "we did not look" — the same absence rule the freeze array follows. Rendering it is what stops a target held solely by a stale probe from showing a `held` badge with nothing under it: the reason was on the wire and this component dropped it.

### §84. Server-computed: freeze-held plus stage-held together

SERVER-COMPUTED (`ChangeWaveSchema.heldTargetCount`) — freeze-held plus stage-dependency-held targets of this wave. NEVER RECOMPUTED HERE: a client tally from `targets[].hold` alone would undercount by exactly the stage-dependency half, which this component has no way to see unless the page also threads `holdFor` — this field is the server's answer regardless of which optional props a given page passes. CampaignWave does not carry it yet, so it is optional and the chip simply does not render for a campaign wave.

### §85. The real-data source/executor links for one wave target

The real-data source/executor links for one wave target (coordination-ui-views.md Layer A, where they are called "Stage source/executor links" — the wave sense of that word, ADR-0021 D6). Every field is optional because it comes from a *separate* lookup that may legitimately be absent: executorRef       — the binding's `externalRef` (e.g. the Argo CD Application name). NB this is sourced from the executor BINDING, never the wave-target's `executorRef` (that is a run ref, null until the target triggers — grounding caveat). executorSystemUrl — the registered `execution-system` object's `serverUrl` (deep-link base). repoPattern       — the source-mapping `repoPattern` (the git source/config repo).

### §86. THE ONE HELPER EVERY `observed.truncation` READ GOES THROUGH

THE ONE HELPER EVERY `observed.truncation` READ GOES THROUGH (proposal §3 rule 4, docs/proposals/observed-truncation-ui.md) — a future read site that calls this instead of indexing `target.observed?.truncation` directly inherits the honesty rule for free, rather than having a chance to re-introduce the "cut looks like absent" lie. Returns the RAW entry (`dropped` may be `false`, e.g. a tail-cut array whose field survived) — callers decide what a `dropped: true` versus a merely-shortened field means for their own slot; see `droppedEntry` below for the common "was this field's own presence removed" case.

### §87. THE REAL, EXECUTOR-REPORTED PREFIX OF `images`

THE REAL, EXECUTOR-REPORTED PREFIX OF `images` — strips the store's marker slot when a cut happened, using the record's `droppedEntries` COUNT and the array's own length, never the marker's own text. The proposal is explicit that a consumer must not pattern-match the stored value (§1: "a cut array's last element is a literal elision-marker string that must never be pattern-matched OR rendered") — the marker is content-shaped and a plugin can legally put those exact characters in a real image ref. When a cut removed every real entry, the stored array is the marker ALONE (`entriesElisionMarker`, `@scp/runner-launcher`) with `dropped` still `false` (the field itself survived); this returns `[]` for that case too, so index 0 is only ever a real entry, structurally guaranteed rather than sniffed.

DELEGATES to `@scp/schemas`'s `realObservedImages` — the SAME function `component-pipeline.ts`'s per-stage `version` derivation calls server-side (per-stage version threading), so the two can never disagree about which prefix of `images` is "real". This wrapper exists only to keep the `ObservedLike` structural type (this module's own, deliberately not `@scp/sdk`'s campaign-carrying types — see the module contract at the top) as the call sites' declared parameter type.

### §88. Rung 1's diagnostic sentence

Rung 1's diagnostic sentence (proposal §1, measured against #264: `boundPersistedJson`'s fallback ladder is `{__scpElided: "<sentence>"}` -> `{__scpElided: true}` -> `null`, so this value is `string | true`). NOT part of the declared SDK shape — `ChangeWaveTargetSchema.observed` names only revision/images/rollout/truncation, so this reads the wire object loosely and on purpose. COPY ONLY: never the guard for the pill (that is §3 rule 5's `truncation`-only key), because `true` and "absent" both mean "no extra sentence available", not "not truncated".

### §89. A short, human-facing label for a deployed image ref

A short, human-facing label for a deployed image ref (ADR-0008 signal 1) — the per-wave version. Prefers the tag (`ghcr.io/x/y:1.2.3` → `1.2.3`); falls back to a git-style short digest (`...@sha256:abcdef0…` → `sha256:abcdef0`); then to the image name. NEVER fabricates — the input is the REAL ref reconcile observed from the executor. The `:`-that-is-a-tag is the last colon AFTER the last `/` (so a `registry:5000/x/y` port is not mistaken for a tag).

### §90. The target's display name, hyperlinked to its component page

The target's display name, hyperlinked to its component page (spec §4C: resolve wave-target UUIDs — a bare UUID renders only as the mono LAST resort, when the server sent neither name nor URN). This is the one renderer of a wave target's identity; every wave surface goes through it.

### §91. WHAT IS WITHHOLDING ONE WAVE TARGET'S TRIGGER

WHAT IS WITHHOLDING ONE WAVE TARGET'S TRIGGER (ADR-0028 increment 4) — the change-pipeline's half of the same fix the component-pipeline view got.

The defect in one sentence: a held target's `change_wave_targets.status` IS `pending`, and so is the status of a target the wave has not reached yet. Rendering the raw column and nothing else made "waiting on something NAMED" and "nothing is happening here" the same picture — on the page an operator opens first when a release is not moving.

It names the dependency, because a badge saying only "held" moves the question from "why is this pending?" to "why is this held?" and no further. Each line is the server's own `describeStageDependencyHold` sentence, the same one the hold Decision's `reasonTree` carries.

The RAW STATUS IS KEPT beside it rather than replaced: the column really does say `pending`, and a view that quietly rewrote it would be lying in the other direction.

### §92. THE FREEZE HALF OF A TARGET'S HOLD

THE FREEZE HALF OF A TARGET'S HOLD (`ChangeWaveTargetSchema.hold`) — one line per covering freeze, mirroring `HeldTargetLine` above (ADR-0028's stage-dependency line) so a target held by BOTH kinds at once renders two lines under the one `held` badge rather than one kind winning. Amber, not blue: a freeze is a governance instrument (design spec §1.5 `warning` tone — "needs attention, degraded, frozen"), where the stage-dependency line's blue is informational ("this clears itself"). `summary` is rendered VERBATIM — server-composed, no client copy.

THE BOLD LABEL ONLY APPEARS WHEN THERE IS A REAL NAME TO SHOW (M25.UI review minor finding 2). `scope: null` means PLATFORM tier (`plan-service.ts`'s `toWaveTargetHold`), not "every org on this instance" — a platform freeze addresses a stage coordinate (environment/region), which can be as narrow as one region, and that wire shape carries no `match` to say which. Composing "instance-wide" here claimed a scope the freeze may not have; `freeze.summary` already states the tier and the coordinate it matched verbatim ("… (platform tier) …"), so a `scope: null` or unresolved-name freeze renders that sentence ALONE rather than a client-invented label beside it.

### §93. The end instant is on the wire so the client can place it

`endsAt` is on the wire precisely so the CLIENT's clock can contextualize it (the schema's stated reason for carrying it; the server summary states the same instant in raw UTC). A title tooltip keeps the verbatim-summary rule: no client-composed prose in the rendered line itself, local time on hover (§ structural conventions — title is the honesty channel tests can see).

### §94. THE CONTINUOUS-PROBE HALF OF A TARGET'S HOLD

THE CONTINUOUS-PROBE HALF OF A TARGET'S HOLD (`ChangeWaveTargetSchema.hold.continuousTests`) — one line per holding probe, mirroring `FreezeHoldLines` above so a target held by a freeze AND a probe renders both under the one `held` badge rather than one kind winning.

WHAT THIS FIXES: the field has been on the wire since increment 8 and this component read only `hold.freezes`, so a target held SOLELY by a stale or failed probe rendered a `held` badge with nothing beneath it — the same shape as the truncated-as-absent lie this card already had to fix once. The reason was always there; the UI dropped it.

AMBER, like the freeze line, not the stage-dependency line's blue: blue is for "this clears itself" (a dependency that will be satisfied by ordinary progress), and a probe hold does NOT clear itself — a human has to go and fix either the prober or the target. Same tone, same `warning` semantics (design spec §1.5).

`reason` IS RENDERED AS ITS OWN LABEL rather than folded into the sentence, because it is the routing information: `no_evidence`/`stale` send an operator to the PROBER, `failed` sends them to the TARGET. The label is a fixed lookup over the closed enum, never composed from the value — a client that prettified an unrecognized reason would invent copy for a state it does not understand. `summary` is the server's sentence, rendered VERBATIM beside it.

### §95. The FREEZE half of a hold, read straight off the target

The FREEZE half of a hold, read straight off the target — no closure prop needed, because `ChangeWaveTargetSchema.hold` rides the target itself rather than a side channel (unlike the stage-dependency half above). A target can carry BOTH kinds at once; `anyHeld` is the union that drives the shared badge/border, and each kind gets its own line below rather than one silently winning.

## `apps/web/src/components/pipeline/PromotionArrow.tsx`

### §96. The gate and approval state between two waves

The gate/approval state of a promotion between two consecutive waves (coordination-ui-views.md §2, Layer A). Deliberately a small closed set the *existing* model can already answer honestly:

```text
open     — the promotion proceeded / the gate evaluates to allow (green)
blocked  — a gate denied it or the upstream wave failed; carries a `decision_id` when the
           server produced one (red, charter principle 6 "every block carries a decision_id")
approval — a required manual approval is still pending (amber)
held     — a stage-scoped component coupling is withholding the trigger (ADR-0028): the release
           is waiting on ANOTHER COMPONENT reaching this same stage (indigo)
pending  — not yet at this gate / awaiting reconcile, no verdict to show (slate)
```

There is NO "manual operator hold/release" state here on purpose — that record does not exist in the model yet (coordination-ui-views.md Layer B, phase 5), so surfacing it would be fabrication. `held` is NOT that: it is a real server-side verdict re-evaluated on every request, and it exists as its own state because both of the states it could otherwise have borrowed would LIE. `blocked` is red and permanent-reading, and conflating a transient self-clearing wait with a denial is the exact bug ADR-0028 wrote `verdict: "hold"` rather than `"block"` to avoid; `approval` claims a human gate that nobody is standing at. The wait is real, it clears itself, and nothing is wrong — so it gets a colour of its own rather than the alarm or the queue.

### §97. A wide arrow drawn between two stacked wave cards

A wide, top-to-bottom promotion arrow drawn between two vertically-stacked wave cards — THE ONLY renderer of wave-to-wave connectors app-wide (design spec §2.13; the `→` literals died with it). `pending` is the plain no-verdict style: connectors with no gate verdict pass it rather than inventing one. Purely presentational: the parent computes `state`/`label`/`detail`/`why` from real change data (wave status, gate reasonTree, control-run evidence, freeze window, approval quorum) — this component only paints it. `detail` is an optional one-line "why" the parent assembles from that real data (never fabricated — omitted when the model has no reason to show); `why` is an optional node (typically a link to the blocking Decision) the parent supplies so this stays routing-agnostic.

### §98. Presentation-only, and never a new `PromotionState`

Presentation-only, and never a new `PromotionState` (owner ask 2026-08-14): the fan-in arrow drawn beneath a DISABLED source-mapping tile. The mapping is still declared — `state` stays whatever the caller passes (normally `"pending"`, since there is no gate verdict here either) — `inert` only lightens the fill and swaps the aria-label, so it reads as "this connector carries nothing right now" rather than an ordinary not-yet-evaluated wait. Omitted (the default), this component is pixel-for-pixel what it always was.

### §99. THE ARROW IS THE SWITCH

THE ARROW IS THE SWITCH (owner, 2026-08-14: "enable/disable should be done via clicking on the arrow; the colour of the arrow indicates whether it's open or closed", then "red should signify closed"). When supplied, the arrow renders as a BUTTON: click opens the source's open/close dialog. OPEN = green; CLOSED = RED. Red is also `blocked` (a gate denying a promotion) — but a switch arrow and a verdict arrow are never the same arrow (a source's fan-in vs a wave-to-wave connector), and the switch says its state in words, so there is no ambiguity in practice. GREY is reserved for arrows that are NOT switches: chain connectors with no verdict, and the commander's opaque input (this domain cannot open/close it) — so grey reads as "not yours to click", never as "closed". Presentation-only otherwise: the parent owns the mutation and passes `busy` while it runs.

## `apps/web/src/components/pipeline/wave-status.ts`

### §100. THE ONE wave-status vocabulary (design spec §2.13)

THE ONE wave-status vocabulary (design spec §2.13) — shared by the change detail wave progression, the change pipeline view, and (after its own migration) the campaign wave board.

MODULE CONTRACT for consumers that are migrated later (campaign-detail.tsx): everything here is structural — helpers take a bare `status` string (wave/wave-target `status` is free-form on the wire; the reconciliation loop only ever writes pending/running/succeeded/failed, DESIGN.md §9.3) or a `{ status: string }`-shaped pair, so ChangeWave and CampaignWave both satisfy the inputs without this module importing either type. No changes here are needed to adopt it.

### §101. Inter-wave promotion state, derived ONLY from wave status

Inter-wave promotion state, derived ONLY from wave status (coordination-ui-views.md Layer A). Wave-to-wave promotion is automatic server-side reconcile — the gate/approval machinery is a change-level concern surfaced on the FINAL arrow, so we do not attribute an approval/deny to a specific inter-wave arrow (that would be inventing a per-wave gate the model does not have). `pending` is the plain no-verdict connector (§2.13): nothing failed and nothing was denied, there is simply no verdict to paint.

## `apps/web/src/components/query-error.tsx`

### §102. THE HUMAN END OF THE SDK RESPONSE-VALIDATION BOUNDARY

THE HUMAN END OF THE SDK RESPONSE-VALIDATION BOUNDARY (ADR-0023).

Validation makes a contract failure LOUD and SINGLE — it converts a body that does not match the OpenAPI contract into one `ScpResponseValidationError` naming the operation and the offending field, instead of a `TypeError` thrown from whichever component happened to dereference the missing key first. That is only half of a fix. In this SPA every read goes through TanStack Query, and a rejected `queryFn` becomes `query.isError` — a STATE. A page that renders only `isLoading` and `data` renders NOTHING for that state, so the diagnosis the boundary just produced dies in the query cache and the operator sees an empty card. This module is the other half: it puts the diagnosis on the screen.

WHAT IT MUST SAY, and why a fixed string is not enough. "Could not load federation status." is indistinguishable across a 401, an unreachable instance, and a version skew — three faults with three different remedies. The one thing the boundary exists to produce is the operation plus the offending field(s), so that is what gets rendered: verbatim `error.message`, plus an explicit "contract" heading and the field list when the failure is a validation failure. An operator can read `peers.0.recentTransfers` off the screen and take it to an upgrade.

## `apps/web/src/components/scaffold/scaffold-panel.test.tsx`

### §103. THE SCAFFOLDER PANEL

THE SCAFFOLDER PANEL — what replaced `POST /discovery/accept` in the wizards (ADR-0047).

THE ONE PROPERTY THAT CARRIES THE ADR
"The orphan problem is solved at authoring time, where a human is present." The old path wrote components into the graph with no owning service — the homelab's ~50 orphans — and the wizard then offered a triage screen to repair them one at a time.

So the case that matters is NOT that code is emitted. It is that a component nobody grouped is **shown and excluded**, never defaulted into some invented service. A panel that quietly emitted a `Component` under a made-up service name would pass a "does it produce code?" test and reintroduce exactly the defect this replaced.

THE DOOR IS A DOUBLE, NOT A MOCK OF `@scp/iac`. The emitter runs server-side (the UI may not import `@scp/iac`), so this stands in for `POST /discovery/scaffold` and applies the SAME rule the server does — a component with no service is reported, never emitted. Testing the panel against a double that defaulted the ungrouped ones would prove the panel renders whatever it is handed, which is true and useless.

MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| the ungrouped banner is not rendered | "(2) an ungrouped component is SHOWN" FAILS | | the panel defaults an ungrouped component to a service name instead of excluding it | "(2)" FAILS on the exclusion half — the name appears in the emitted source | | "Apply to all" writes a hidden default instead of filling the per-component fields | "(3)" FAILS — the inputs no longer show what the code uses |

## `apps/web/src/components/scaffold/scaffold-panel.tsx`

### §104. The scaffolder: what connect does now that accept is gone

THE SCAFFOLDER — what `/connect` does now that `POST /discovery/accept` is gone (ADR-0047; team-pipeline-iac D1, section 7).

WHAT CHANGED, AND WHY THE GROUPING INPUT IS THE WHOLE POINT
The wizard used to end by WRITING the proposal into the graph. That path bypassed strict create, and the homelab's ~50 imported components landed as RBAC orphans through it — a component with no owning service, invisible to every scope-based permission and every service-shaped read.

ADR-0047's fix is not a validation: it is moving the decision to where a human is. So this panel asks the ONE question the old flow never did — which service does each component belong to? — and then emits code rather than rows. Nothing here writes to the graph; the operator commits the output and a normal `scp apply` lands it, through the same strict doors as any other IaC.

UNGROUPED COMPONENTS ARE SHOWN, NEVER DEFAULTED. The server returns them separately and they are never in the emitted code — a `Component` cannot be constructed without a service. Defaulting them to some invented service name is exactly the silent orphan-making this replaced.

THE EMITTER RUNS SERVER-SIDE, and that is an architectural rule rather than a preference: `apps/web/src` may import only `@scp/sdk` and `@scp/schemas` — never `@scp/iac`, `@scp/cli` or the server (eslint `no-restricted-imports`). The UI reaches everything through the public API, so it asks `POST /discovery/scaffold` and renders the answer. One emitter, behind the API, shared with `scp iac scaffold` — so the wizard and the CLI cannot produce different code from one proposal.

## `apps/web/src/components/ui/alert.tsx`

### §105. The one callout treatment (design spec §2.3)

The one callout treatment (design spec §2.3) — every hand-rolled `border-red-300 bg-red-50 …` block converges here, starting with `error-boundary.tsx` and `query-error.tsx`. Tints follow §1.5 with the §2.3 `text-*-800` text weight.

## `apps/web/src/components/ui/badge.tsx`

### §106. The soft-tint status system (design spec §1.5/§2.2)

The soft-tint status system (design spec §1.5/§2.2) — six tones, no solid saturated fills.

`unknown` is the ONLY sanctioned rendering of the honesty pill ("unobservable where an operator should notice"): its literal `text-amber-700` and `border-dashed` classes are test-pinned (`service-board-honesty.test.tsx`) and must never be renamed. Structurally-expected absence is NOT a badge — it renders as `—` in `text-slate-400` with a `title=""` tooltip (spec §1.5).

The legacy names (`default`/`secondary`/`destructive`/`outline`/`info`/`success`) are deprecated ALIASES onto tones so untouched call sites keep compiling mid-migration; they are deleted at the end of group E (spec §2.2).

## `apps/web/src/components/ui/button.tsx`

### §107. `default` is the army-olive accent

`default` is the army-olive accent (design spec §2.12; olive since 2026-08-11) — it lands on every primary action (Sign in, New, Create Campaign, Accept). Status colors never appear here; `destructive` is the only exception and stays red. Every variant carries the shared focus ring (§2.10).

## `apps/web/src/components/ui/card.tsx`

### §108. Card density comes ONLY from this `size` prop

Card density comes ONLY from this `size` prop (design spec §1.4/§2.4) — routes pick a size and never override CardContent padding ad hoc. The size flows to header/content/footer via context so a call site sets it exactly once, on the Card.

## `apps/web/src/components/ui/key-value-list.tsx`

### §109. §2.7 — the one dt/dd treatment

§2.7 — the one dt/dd treatment (outpost-detail, outposts, federation-status, registry-detail Properties). `tooltip` renders as `title=""` on the pair — the sanctioned home for a full honesty sentence whose visible form is a fragment (copy rule 1).

## `apps/web/src/components/ui/notice.tsx`

### §110. §2.11 — one-line MUTATION feedback

§2.11 — one-line MUTATION feedback (approve flows, dialog submits). Query failures always use `QueryErrorNotice`, never this component: a failed read carries a diagnosis, a failed mutation carries a sentence.

## `apps/web/src/components/ui/stat-card.tsx`

### §111. One stat tile, shared by every counting surface

§2.5 — one stat tile for dashboard registry tiles, identity count cards, and the service-board summary stats. `value` is optional on purpose: a count that was never fetched shows a tile without a number, not a fabricated "0" (§4A).

## `apps/web/src/components/ui/table.tsx`

### §112. §2.12 table treatment

§2.12 table treatment: the wrapper carries the surface (`rounded-lg border`) and horizontal scrolling, the header row is a `bg-army-50` band of eyebrow-type `th`s, rows divide with `divide-y` and hover `bg-army-50/60`. Routes never restyle these pieces individually.

## `apps/web/src/lib/absent.ts`

### §113. ABSENT — `null` OR `undefined`, never one of the two

ABSENT — `null` OR `undefined`, never one of the two.

THE BUG THIS EXISTS TO MAKE UNREPEATABLE. Almost every federated reading in this app is `.nullable()` and very often `.optional()` too (`packages/schemas/src/federation.ts`), so BOTH absent values are legal on the wire and a key an older or newer server simply OMITS arrives as `undefined` whatever the TypeScript type says.

WHAT ADR-0023 CHANGED HERE, AND WHAT IT DID NOT. The SDK now runs a generated zod schema over every 2xx JSON body of every spec'd operation, so for a field that is `.nullable()` WITHOUT `.optional()` an omitted key no longer resolves a query — it rejects at the boundary, naming the operation and the field, and this guard became defence in depth for that case. For a field that is `.optional()` NOTHING CHANGED: an omitted key is contract-LEGAL, validation passes it through untouched, and this guard is still the only thing between the renderer and `undefined`. Which of the two applies is per field, so `isAbsent` stays the rule at every site rather than a judgement call made one dereference at a time.

A strict `=== null` check therefore guards ONE of two legal absences and lets the other reach the renderer, where an absent NUMBER prints as an empty string inside otherwise-confident copy (`"⟨nothing⟩ of this domain's own journal entries not yet put on the wire"` reads as "nothing pending") or, worse, falls through to a reassuring branch that states a fact nobody measured.

LIVES IN `lib/` ON PURPOSE (M16.2 phase B, round 3). It was previously a local helper in `routes/outposts.tsx`, which meant every OTHER route re-derived the same guard by hand and the half-guarded `=== null` form kept reappearing — three fresh instances in one review round. One import, one rule.

### §114. THE SERVER'S DECLARED-UNKNOWN LIST, read safely

THE SERVER'S DECLARED-UNKNOWN LIST, read safely (M16.2 phase B, round 4 — Y4).

`unknownFields` is required-NOT-optional on every honesty-carrying response (`ServiceBoardRow`, `ServiceBoardResponse`, `BoundarySegment`, `FederationPeerStatus`), so the generated types promise it is always there — and, exactly as above, nothing at runtime enforces that promise. A server predating the field, or one that failed to populate it, arrives with the key MISSING, and `row.unknownFields.includes(…)` is then a TypeError, not a false reading.

That is the SAME failure that white-screened the outposts pages: not a wrong answer, a dead page, and it kills the whole board rather than the one cell it concerns.

`[]` IS THE RIGHT DEFAULT AND IS ALSO THE RISKY ONE, so it is stated plainly: an empty list means "the server declared nothing unobservable", which makes every field render as OBSERVED. That is the pre-honesty-work behaviour, and it is strictly better than a blank page — but it is why this helper exists as one named, documented place rather than seven inline `?? []`s that each look like an accident.

## `apps/web/src/lib/auth-context.tsx`

### §115. Root-level session provider

Root-level session provider (BUILD_AND_TEST.md §8 M2 item 2's "small root-level provider that calls GET /auth/me once on load"). The SPA can't read the httpOnly `scp_session` cookie itself, so this is the ONLY way it learns whether/who it's logged in as — every route-guard (components/RequireAuth.tsx) and the nav (components/AppShell.tsx) reads from here rather than each firing its own `/auth/me` request.

## `apps/web/src/lib/change-format.ts`

### §116. Change `state` -> Badge variant

Change `state` -> Badge variant (components/ui/badge.tsx).

Lives here rather than on a page because the Changes LIST page was removed (the nav cleanup of 2026-08-10) while four surfaces still colour a change state: change detail, the change pipeline, the service board and the component pipeline. A shared formatter in `lib/` is the honest home for something no single page owns.

## `apps/web/src/lib/client.ts`

### §117. The ONE `ScpClient` instance the whole SPA shares

The ONE `ScpClient` instance the whole SPA shares (DESIGN.md §14 "consumes only @scp/sdk"). Relative `baseUrl` — the SPA is always served BY the same Fastify process the API lives on (apps/server/src/app.ts's static mount, Part D), so this works unmodified in dev (behind Vite's `/api` proxy — vite.config.ts), in the built app served by `scpd`, and in the Playwright e2e suite (apps/web/e2e) regardless of which port the test server happens to bind.

No token is passed at construction: auth is the browser's automatic same-origin `scp_session` cookie (httpOnly, set by `POST /auth/login`) — there is no client-side token to manage (auth/require-auth.ts, routes/auth.ts).

## `apps/web/src/lib/graph-glyphs.test.ts`

### §118. The canvas glyphs are the SAME drawings as the React icons

The canvas glyphs are the SAME drawings as the React icons — this suite pins the contract that makes that true (encoded data URI, white stroke, real path data) and the honest absence for types with no mark. The drawings themselves are pinned by eye; what regresses silently is the plumbing, so the plumbing is what gets tests.

## `apps/web/src/lib/graph-glyphs.ts`

### §119. Cytoscape node GLYPHS

Cytoscape node GLYPHS — the same hand-drawn marks the rest of the UI wears (catalog-marks.tsx, federation-roles.tsx), rasterized into `data:` SVG URIs the canvas can paint inside a node.

Cytoscape draws to <canvas>, so it cannot render a React component; `background-image` with an encoded SVG string is the sanctioned path. The path data is IMPORTED from the icon modules — never re-drawn here — so the sidebar icon, the role badge and the graph node are always the same drawing (the wave-target lesson: a slot with its own copy of the truth drifts).

Encoding note: a data URI is not a network fetch — the SVG travels inside the bundle, so the air-gap posture is untouched.

The glyph SUPPLEMENTS the existing encodings, never replaces them: shape still says type at a distance and colour still says group (graph-visual.ts); the white glyph makes the type legible up close without hovering. Types without a mark simply render as before — an absent glyph is "no mark exists", not an error.

## `apps/web/src/lib/graph-visual.test.ts`

### §120. The owner's colour rule (2026-08-10)

The owner's colour rule (2026-08-10): colour is decided at the HIGHEST LEVEL IN SCOPE — at org level each service is its own colour; inside a service each assembly or directly-held component is; inside an assembly each component is. `deriveGroupIds` claims all three are one rule, so all three are asserted here against the same function rather than three code paths.

## `apps/web/src/lib/graph-visual.ts`

### §121. Graph visual encoding

Graph visual encoding — SHAPE says what a node IS, COLOR says which group it BELONGS TO.

Keeping those two channels independent is the whole design. Type was previously encoded as colour, which meant colour could say only one thing at a time and a graph of eight components was eight identical purple dots. Shape is a stable, absolute property of a node (a component is a component wherever you look at it), so it belongs on the channel that never changes; group membership is RELATIVE to what you are currently looking at, so it belongs on the channel that is recomputed per view.

### §122. Categorical fill palette

Categorical fill palette. Deliberately avoids the health ring's green/amber/red so a fill and a ring on the same node are never confusable — health is an overlay on the BORDER, group is the FILL, and the two must stay readable together.

### §123. Which node's colour to inherit, given what is focused

Which node's colour a node should inherit, GIVEN what is currently being looked at.

The rule the owner specified (2026-08-10): colour is decided at the highest level IN SCOPE. Looking at the org, every service is a different colour; looking at a service, each assembly or directly-held component is a different colour; looking at an assembly, each component is. All three are the same rule — **walk `contains` upward until you reach a child of the thing you are looking at, and take that ancestor's identity** — so this is one function rather than three special cases, and a future rung inherits it for free.

With no `rootId` (an org-level map) the walk goes all the way to the topmost ancestor present, which for a graph of bare services is each service itself.

Cycles cannot occur through `contains` (the server refuses `assembly -> assembly` outright, and a component has exactly one parent by unique index), but the walk is still bounded — a hand-authored relationship type could in principle produce one, and a hung layout is a worse failure than a mis-coloured node.

### §124. Stable group -> colour assignment

Stable group -> colour assignment. Sorted by group id so the same graph renders the same colours across reloads: keying off insertion order would repaint the whole graph whenever the API returned rows in a different order, which reads as though something changed when nothing did.

## `apps/web/src/lib/query-client.ts`

### §125. One shared TanStack Query cache for the whole SPA

One shared TanStack Query cache for the whole SPA. `useEventStream` (lib/use-event-stream.ts) invalidates specific query keys when an SSE event arrives — that's the live-update mechanism (DESIGN.md §14, BUILD_AND_TEST.md §8 M2 DoD (a)) — so query keys below are deliberately structured (`["registry", basePath, ...]`) to make targeted invalidation straightforward.

### §126. Query key for `GET /federation/outposts`

Query key for `GET /federation/outposts` — every `outpost` CONFIG OBJECT (ADR-0022's commander-declared half), as opposed to the peer ROWS in `federationStatusKey`. The detail page reads the LIST rather than only its own peer's row because a peer bound to TWO live config objects is exactly the authority conflict the reconcile verb exists for, and the single-object `GET` answers with the winner alone — it cannot show a conflict it has already resolved.

## `apps/web/src/lib/registries.ts`

### §127. The 8 typed registries

The 8 typed registries (BUILD_AND_TEST.md §8 M2 item 1, routes/typed-registries.ts) — one config entry drives the generic list/detail/create routes and nav instead of 8 hand-copies, mirroring how the server and SDK already factor this (typed-registries.ts, ownership.ts, ScpClient.typedResource/ownerMethods/edgeMethods in packages/sdk/src/client.ts).

### §128. The OPTIONAL level between a service and its components

The OPTIONAL level between a service and its components (migration 0055, `intermediate-grouping.md` D5). Ownable like a service; `edges: false` because `consumes`/`depends_on` describe things that call each other and an assembly does not make a request — the same ruling migration 0055's census recorded, kept consistent here so the UI cannot offer an edge the server would refuse.

## `apps/web/src/lib/replica-origin.test.tsx`

### §129. The primitives behind the two write-control gates

M16.3 P2 (REMEASURED) — the primitives behind the TWO write-control gates that survive, both of which mirror a refusal MEASURED in `apps/server/src/federation/foreign-origin-writes.integration. test.ts`: MOVE across a foreign-origin `contains` edge (`deleteRelationship` 409s) and MERGE with a foreign-origin LOSER (`deleteObject` 409s). Everything else the first cut gated — Detach/Repurpose/Bind, ASSIGN, MOVE across a local edge, merge into a foreign SURVIVOR, and Accept/Rollback/Cancel — the server measurably ACCEPTS, so those gates are gone.

`replicaGuard`'s mandatory `refusal: string` parameter is a WEAKER guarantee than an earlier commit on this PR claimed ("gated on the wrong row is now a type error" — it is not): TypeScript requires a second argument at every call site, but does not check that its CONTENT names a real, measured refusal — `replicaGuard(true, "")` compiles cleanly, and `isMoveBlocked`/ `isMergeLoserBlocked`'s `{ originDomainId: string }` parameter types accept any object with that shape, including a full `GraphObject` for the WRONG row (a component instead of its `contains` edge) — structural typing plus no excess-property check on a passed variable means `tsc --noEmit` is clean either way. What actually keeps each gate honest is this file: every `disabled`/`title` assertion below is pinned to the SPECIFIC measured case it names, so a gate rekeyed onto the wrong row breaks a test here, not a compile. `refusal` is good, enforced-by- convention documentation, not a compile-time guarantee.

No jsdom, no QueryClientProvider — plain vitest + `renderToStaticMarkup`, so this runs in the existing "4. Unit tests" job (transitively required on every PR), same as service-board- honesty.test.tsx.

## `apps/web/src/lib/replica-origin.tsx`

### §130. Measured single-writer gating for the web write controls

M16.3 P2 — MEASURED single-writer-authority gating for `apps/web` write controls.

THE RULE THIS MODULE ENFORCES ON ITSELF: a control is disabled here ONLY where `apps/server/src/federation/foreign-origin-writes.integration.test.ts` MEASURED the server refusing that exact write against a genuinely foreign-origin object, and every surviving `disabled` names the case that measured it. A UI that blocks a write the server would accept is a regression, not caution — the first cut of this module disabled Detach/Repurpose/Assign/Move/ Merge on the strength of a comment asserting "the server refuses this write on a read-only replica regardless", which was untrue for most of them, and broke the documented multi-region workflow (DESIGN.md §12.6 / BUILD_AND_TEST.md M15.6: an outpost binding its OWN local Argo CD to a deployment-target that is commander-origin from the outpost's point of view).

WHAT THE SERVER ACTUALLY REFUSES — the ONLY three things gated anywhere in the app: 1. Mutating/deleting the OBJECT ITSELF — `graph/objects-repo.ts`'s `updateObject`/`deleteObject` ("read-only replica ... cannot be mutated locally"). Measured by that test's two CONTROL cases. `apps/web` offers no rename/delete control on a registry detail page, so this surfaces only as the `ForeignOriginNotice` badge below. 2. Deleting a foreign-origin RELATIONSHIP — `graph/relationships-repo.ts`'s `deleteRelationship`. Reached by MOVING a component whose current `contains` edge is a replica (`components-repo.ts`'s `setComponentService` soft-deletes the old edge first). The decisive origin is the EDGE's, never the component's — an ASSIGN (no edge yet) is a pure `createRelationship`, which never consults its endpoints' origins and succeeds. Measured: "MOVE across a FOREIGN-ORIGIN contains edge 409s". 3. Merging in a foreign-origin LOSER — `coordination/component-merge-repo.ts` soft-deletes the loser via `deleteObject` (case 1). The SURVIVOR's origin is irrelevant: the only write against it is `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings`. Measured: "merge 409s when the LOSER is foreign-origin".

NOT gated, because measured ALLOWED: PUT/DELETE/PATCH `/executors/:idOrUrn/binding` (a binding is per-(org,target,type) LOCAL config — `db/schema.ts`'s `executor_bindings` has no `origin_domain_id` column at all, and `routes/executors.ts` checks only `object:write` RBAC on the target); assigning a foreign-origin component to a service; moving it across a locally-originated edge; and merging INTO a foreign-origin survivor.

ACCEPT/ROLLBACK/CANCEL WERE ON THAT "ALLOWED" LIST AND NO LONGER ARE (S10, PR #171). The reason given here — "the transition verbs write the `changes` state-machine row and never route through `updateObject`, so they answer a foreign-origin change identically to a local one" — was an accurate description of a GAP, not of intended behaviour, and the gap is now closed: `coordination/transition.ts`'s `enforceLocalChangeAuthority` refuses all three with a 409 + `decision_id`, keyed on the change object's `originDomainId`. Measured: "cancel is REFUSED on a foreign-origin change", "accept is REFUSED …", "rollback is REFUSED …".

THIS FILE STILL MUST NOT GATE THEM. PR #152 removed exactly such a client-side gate because it simulated an enforcement the server lacked; now that the server really enforces it, the correct UI behaviour is to let the request go and render the server's 409 and its `decision_id` — a client-side pre-block would hide the Decision that makes the refusal explainable (charter principle 6).

HOW THE UI LEARNS "OWN DOMAIN": `GET /federation/self` (SDK: `client.federation.self()`) returns `{domainId, name, role, publicKey}` for THIS instance — an SDK-reachable mechanism that already existed (M6/M9.3) and was already consumed by `routes/federation-status.tsx`'s read-only status page. This milestone is the first place the response's `domainId` field drives anything beyond display — gating writes and labeling provenance below.

### §131. The one place foreign-origin is decided, as a predicate

Pure predicate — the ONE place "is this row foreign-origin" is decided, applied to whichever row the server actually guards: an OBJECT for cases 1/3 above, a RELATIONSHIP for case 2 (both wire shapes carry `originDomainId` — `packages/schemas/src/graph.ts`). `ownDomainId === undefined` (still loading, or the `federation/self` call errored) is treated as "not (yet) known to be foreign", so missing data can never fabricate a block on a write the server would accept.

### §132. THE MOVE GATE

THE MOVE GATE — `registry-detail.tsx`'s ComponentServiceCard.

Takes the component's CURRENT `contains` edge and NOTHING ELSE, because the edge is the only row the server guards here: `components-repo.ts`'s `setComponentService` soft-deletes it before creating the new one, and `deleteRelationship` 409s on a foreign-origin edge. `undefined` (no edge yet) is an ASSIGN — a pure `createRelationship`, which never consults its endpoints' origins — so it is never blocked. Deliberately does NOT accept the component: the first cut gated on the component's own origin, which blocked two writes the server accepts (ASSIGN on a foreign component, MOVE across a local edge) and missed the one it refuses. Measured in `apps/server/src/federation/foreign-origin-writes.integration.test.ts`.

### §133. THE MERGE GATE

THE MERGE GATE — `registry-detail.tsx`'s MergeComponentCard.

Takes the LOSER candidate and NOTHING ELSE. `component-merge-repo.ts` soft-deletes the loser via `deleteObject` (409 on a replica); the only write against the SURVIVOR is `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings`, so the survivor's origin is irrelevant. Both halves measured in the same integration test.

### §134. The props a write control spreads to disable itself + explain why

The props a write control spreads to disable itself + explain why.

`refusal` is a required parameter and is intended to state the concrete server refusal this gate mirrors, naming the repo function that performs it — every CURRENT call site does this (see `registry-detail.tsx`). TypeScript enforces only that some string is supplied at each call site, not that its content names anything real (`replicaGuard(true, "")` compiles) — the discipline of citing a measured refusal is convention pinned by `replica-origin.test.tsx`'s examples, not a compile-time guarantee. This is still the whole correction over the previous signature, which took no argument at all and emitted one blanket "commander-origin config can only be changed at its origin" for five controls, four of which the server happily accepted.

A pure function (no hooks), so it's directly unit-testable via `renderToStaticMarkup` — the same idiom `service-board-honesty.test.tsx` uses for `isUnknown`/`UnknownHere`.

### §135. The honest provenance marker

The honest provenance marker — deliberately the SAME dashed-amber-border idiom `service-board.tsx`'s `UnknownHere` uses, so an operator reads one visual language for "this instance is not the authority here" everywhere in the app rather than a bespoke one per feature. Its title states ownership plus the ONE refusal measured for the object itself (that integration test's two CONTROL cases: PATCH and DELETE both 409) — deliberately NOT a blanket "nothing works here", because local config against this object (executor bindings, service assignment) demonstrably still does.

## `apps/web/src/lib/use-event-stream.test.tsx`

### §136. The event stream's reconnect behaviour, as the hook sees

M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1): the two web-side catch-up triggers a best-effort, no-replay SSE stream needs (ADR-0025 D4) — a synthetic `scp.sse.resync` frame from the server-side bridge, and this hook's OWN stream (re)establishment, which can happen without one (a browser<->api-pod network blip the bridge's LISTEN never saw).

Both are proven by DELETING THE WIRING, not by reading `use-event-stream.ts`'s source: each test below fails if its corresponding one-line hookup — `onOpen: resync` or the `event.type === RESYNC_EVENT_TYPE` branch — is removed, because nothing else in this file would invalidate the cache for that trigger.

`client.events.stream()` is mocked at the module boundary (not `resilientEventStream` — that reconnect/backoff machinery is proven in packages/sdk/src/event-stream.test.ts already) with a push-controlled async iterator, so a test can drive one frame at a time and assert against the REAL `QueryClient`'s invalidation state instead of a spied call.

### §137. The mount's own `onOpen`

The mount's own `onOpen` (proven independently by the sibling test below) already invalidated everything once. `invalidate()` is a no-op on an already-invalidated query (query-core's guard: `if (!state.isInvalidated) dispatch(...)`), so a second `invalidateQueries()` call from the resync frame would be UNOBSERVABLE unless this is reset first — `setQueryData` dispatches a `"success"` action, which query-core's reducer clears `isInvalidated` on, giving this test a clean baseline attributable to the resync frame alone.

### §138. The mock's open callback already fired synchronously

The mock's `onOpen` already fired synchronously inside `client.events.stream()`, before this point — this is the FIRST (and, in this test, only) connection, and no `scp.sse.resync` frame is ever pushed. If `onOpen: resync` were removed from `use-event-stream.ts`'s call into `client.events.stream()`, `onOpenCalls` below would still be 1 (the mock itself always calls it) but the query would never be marked invalidated — that is the property this asserts.

## `apps/web/src/lib/use-event-stream.ts`

### §139. M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1)

M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1): a synthetic frame the server-side bridge (apps/server/src/events/sse-bridge.ts) pushes to every already-connected client on its own LISTEN (re)connection — the stream is best-effort with no replay (ADR-0025 D4), so this is the signal that some window of events may have been missed. Carries no useful payload; the response is a wholesale cache invalidation, same as a local stream reconnect below.

### §140. Tiny external store

Tiny external store (React 18 `useSyncExternalStore`) for the dashboard's "last few SSE events" activity feed (components/ActivityFeed.tsx, BUILD_AND_TEST.md §8 M2 item 2's "small live activity feed"). Colocated here rather than a second subscription, which would violate "exactly one event stream per session" — this file already owns the one connection, so it also owns the tiny fan-out to whatever wants to render recent events.

### §141. Opens exactly one live event stream per authenticated session

Opens exactly one live event stream per authenticated session (`GET /events/stream` — routes/events.ts, org-scoped) and invalidates the affected TanStack Query cache keys when a `scp.object.*` event arrives — the live-update mechanism DESIGN.md §14 and BUILD_AND_TEST.md §8 M2 DoD (a) test: "`scp service register` → service visible in UI within one SSE tick", with NO page reload.

THROUGH THE SDK, like every other call this app makes. Until the SSE API-parity work this was the app's one hand-built URL and one raw `EventSource` — the single exemption in the no-bypass sweep (`apps/web/e2e/openapi-conformance.ts`) and the single hole named in ADR-0023, where `JSON.parse(event.data) as RelayedEvent` cast raw network bytes to a locally-declared interface. `client.events.stream()` is a generated operation: every frame is validated against the contract schema before it reaches this file, and the reconnect/backoff/`Last-Event-ID` behaviour `EventSource` supplied for free is now explicit and tested (packages/sdk/src/event-stream.ts, event-stream.test.ts). Both exemptions are gone, not relocated.

Dispatch is on `event.type` off the parsed envelope rather than per-type listeners, because the stream is one typed async iterator rather than a DOM event target.

### §142. M26.1 §7.1 item 1: wholesale invalidation on EVERY

M26.1 §7.1 item 1: wholesale invalidation on EVERY (re)connection, local or server-signalled — see `RESYNC_EVENT_TYPE`'s doc comment for why both triggers exist independently. A blanket `invalidateQueries()` rather than resolving which keys might be stale mirrors `onObjectEvent` above: list/detail queries are cheap and cached, and simplicity is CLAUDE.md's #1 decision priority.

## `apps/web/src/lib/use-object-names.ts`

### §143. Resolve object ids to display names, for id-only payloads

Resolve graph-object ids to display names + types, for surfaces whose payload carries only ids.

WHY THIS EXISTS (spec §4C, second pass): the generalized `PipelineWaveCard` grew a `targetName` slot in the overhaul, but the change/campaign wave payloads carry only `targetObjectId` — so the slot sat empty and every wave target still rendered as a raw UUID. The lever existed; nothing pulled it. This hook is the missing supply side, shared by change-detail and campaign-detail.

WHY `graph.traverse` AND NOT A TYPED REGISTRY GET: a wave target may be a component, a service, or any other graph object, and the typed clients 404 across types. `traverse` at depth 1 returns the ROOT object itself (name + typeId) regardless of type — the same property the assembly board and registry-detail already lean on — so one bounded call resolves any id without guessing its registry. Results are cached per id by the query key, so revisits are free.

## `apps/web/src/lib/use-route-params.ts`

### §144. Loosely-typed param/search accessors

Loosely-typed param/search accessors (`strict: false`) so route page components don't need to import their own route object from router.tsx — avoids a circular import between router.tsx (which imports every page component) and the pages themselves.

### §145. Which REGISTRY this page is showing

Which REGISTRY this page is showing — `components`, `services`, `deployment-targets`, …

Falls back to the URL's FIRST SEGMENT when there is no `$basePath` param, which is what lets `RegistryDetailPage` mount at a static path as well as at the generic `/$basePath/$idOrUrn`. `/components/{id}/settings` needs exactly that: `/components/{id}` is a static route (the pipeline, which out-ranks the dynamic one), so its `settings` child has no `$basePath` to read, and without this fallback the alternative is a duplicate copy of a ~570-line page.

The segment is not trusted to BE a registry — `findRegistry` still decides that, and returns undefined for `/changes` or `/federation`, which render "Not found" exactly as an unknown `$basePath` always has.

## `apps/web/src/lib/utils.ts`

### §146. The ONE focus treatment

The ONE focus treatment (design spec §2.10). Applied by every interactive primitive (Button, Input, Select, nav links, PageHeader back links, StatCard links) and by any inline link a route renders itself. Indigo is the accent (spec standing decisions) — focus is one of its four sanctioned homes, so no other ring color may appear anywhere.

## `apps/web/src/router-paths.test.ts`

### §147. THE ROUTE TABLE STILL RESOLVES THE URLS OTHER THINGS DEPEND ON

THE ROUTE TABLE STILL RESOLVES THE URLS OTHER THINGS DEPEND ON.

WHY THIS FILE EXISTS — A REAL REGRESSION THAT PASSED EVERY REQUIRED PR CHECK
The service release board lived at `/services/{id}/board`. Making it the INDEX child of a new `/services/$idOrUrn` tabbed layout removed that path, and NOTHING failed: a route table is data, so typecheck has no opinion about which paths exist; the unit and integration suites never navigate; and the one thing that did navigate there — `e2e/service-board-honesty.spec.ts` — is Playwright. Every E2E job in `.github/workflows/ci.yml` carries `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, so it was SKIPPED on pull requests. The break merged green and surfaced only on `main` — job 9 RED with 5z GREEN beside it. That workflow's §6 comment predicted this precise hole; E2E now runs on pull requests and 5z requires it, which closes the general case.

So the guard belongs where it runs on EVERY PR: over the real route tree, in the "4. Unit tests" job, with no browser and no server. It does not replace the E2E specs — they prove the page renders against real authz and the real SDK. It proves the URL still exists, the cheap half that was missing.

WHEN THIS FAILS: restore the path, or — if the removal is deliberate — change it here AND in every consumer named beside it, as one edit. The annotations exist so "who else uses this URL" cannot be skipped.

MUTATION LOG (each applied alone, then reverted):

| Mutation | Result |
| remove `serviceBoardLegacyRoute` from the tree (the merged regression itself) | `/services/{id}/board` FAILS | | `path: "/board"` -> `"/boards"` | same FAILS — the literal is pinned, not merely "some child exists" | | remove `componentSettingsRoute` | the component-settings case FAILS | | make the walk return every path as `/` | the anti-vacuity test FAILS (an unknown path would "resolve") | | point `serviceBoardLegacyRoute` at a different component | "the SAME view" FAILS — the path surviving while its content moved is the same bug from outside | | `component: ComponentDependenciesPage` -> `RegistryDetailPage` on the /dependencies child | "renders ComponentDependenciesPage" FAILS — the URL registered but pointed at the wrong view |

## `apps/web/src/router.tsx`

### §148. Code-based TanStack Router route tree

Code-based TanStack Router route tree (BUILD_AND_TEST.md §8 M2 item 2 — "TanStack Router... file-based or code-based, your call"). Code-based avoids depending on the `@tanstack/router- plugin` Vite plugin's generated `routeTree.gen.ts` — one fewer moving part for an air-gapped build (CLAUDE.md), at the cost of hand-listing routes here instead of inferring them from `src/routes/*`.

`authenticatedLayoutRoute` is a PATHLESS layout route (no `path`, just an `id`) wrapping every page except `/login` in `<RequireAuth>` + `<AppShell>` — the standard TanStack Router pattern for "all these routes share a guard/chrome" without repeating it per page.

### §149. HOME is site-shaped (outpost-ui.md §9.3)

HOME is site-shaped (outpost-ui.md §9.3): the commander gets the org-wide dashboard, the outpost a small component-level one. Selected by `/auth/me`'s install-time `instanceRole` — the ONE place role picks a page — and only here: inside either page every row keys on data.

### §150. One component: a layout route carrying its tabs

ONE COMPONENT — a LAYOUT route carrying the Pipeline/Settings tabs, with the pipeline as its index child (coordination-ui-views.md §2, corrected 2026-08-03). The static `/components/$idOrUrn` segment out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below — the same precedence trick `/services/$idOrUrn` uses — so going to a component lands on its pipeline rather than a properties table, because the pipeline IS what a component is operationally.

That precedence had a cost this layout repays: it made the generic registry detail UNREACHABLE for components, orphaning its labels/owners/move/merge cards. `settings` mounts that same page (not a copy) at `/components/$idOrUrn/settings`; `useBasePathParam` resolves `components` from the pathname there, since this route has no `$basePath` param. See `routes/component-detail.tsx`.

### §151. The DEPENDENCIES tab (docs/proposals/dependency-subscription-ui.md §4.1)

The DEPENDENCIES tab (docs/proposals/dependency-subscription-ui.md §4.1): what this component declares, the head of each major line, whether it is subscribed and why, what has been bumped, and the offered enable / opt-out writes. A fourth child of the same layout so it is a real, deep-linkable URL like the other three. Registered on BOTH sites — the outpost renders the bumps section as a sentence, never an empty table that looks up to date.

### §152. One service: a layout route carrying its tabs

ONE SERVICE — a LAYOUT route carrying the Board/Settings tabs, with the release board as its INDEX child (coordination-ui-views.md Phase 2, corrected 2026-08-04). `/services/{id}` used to fall through to the generic registry detail, so the board — what is releasing, what is blocked, which pipelines are bound — sat at a URL only one button linked to. The board is what a service IS operationally, so it is the default; the properties table becomes the Settings tab, mounting the same `RegistryDetailPage` (not a copy), exactly as `/components/$idOrUrn` does. ONE ASSEMBLY — the same layout/index-child shape as a service, two tabs instead of three (see routes/assembly-detail.tsx). The static `/assemblies/$idOrUrn` segment out-ranks the dynamic `/$basePath/$idOrUrn` registry route, so an assembly lands on its board; `settings` mounts the generic RegistryDetailPage, which resolves `assemblies` from the pathname.

### §153. The URL the board lived at before it became the index

`/services/{id}/board` — the URL the board lived at BEFORE it became the index child, kept working rather than removed. Two reasons, and the second is why this is a bug fix and not politeness: it may be bookmarked or linked from outside the app, and `apps/web/e2e/service-board-honesty.spec.ts` navigates to it. That spec is Playwright, every E2E job is `main`-only, so removing this path passed EVERY required PR check and would have broken only after merge — the exact hole `.github/workflows/ci.yml`'s own §6 comment warns about. Renders the same component as the index; a redirect would work too, but two paths onto one view is fewer moving parts than a redirect that has to reconstruct params.

### §154. The outposts UI, deliberately under the federation path

M16.2 phase B — the Outposts UI, deliberately UNDER the existing `/federation` prefix rather than beside it: `/federation` and its "Federation" heading already ship and may be bookmarked, so this adds to that section instead of renaming it out from under anyone. Static segments out-rank the dynamic `$basePath` route below at the same depth, and `outposts` out-ranks nothing ambiguous under `/federation`, which has no dynamic child.

### §155. M19.1 — the "Connect Argo CD" wizard

M19.1 — the "Connect Argo CD" wizard. A static 2-segment path, so it out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below exactly as `/graph/service/...` and `/federation/outposts` already do. `/connect/<kind>` rather than `/plugins/connect-argocd` because the thing being connected is an execution SYSTEM, not a plugin instance — the `/plugins` page configures bindings from manifests, which is a different act — and because the next kinds (gitea, gitlab, harbor) already have server-side discovery modules and belong beside this one.

### §156. B1 (docs/proposals/outpost-ui.md §4 Lane B)

B1 (docs/proposals/outpost-ui.md §4 Lane B) — generalizes the wizard above over the server's own discovery-module catalog instead of one Argo-CD-shaped page (routes/connect.tsx). Registered BESIDE `connectArgoCdRoute` rather than replacing it: this router's own static-outranks-dynamic precedence (the same rule `serviceBoardLegacyRoute` above relies on) means `/connect/argocd` always resolves to THAT route first, so its pinned testids are never at risk from this one — `/connect/$kind` only ever serves a kind other than "argocd" in normal navigation (gitea, gitlab today). See routes/connect.tsx's file-level comment for why "argocd" is still handled defensively inside it.

### §157. Admin › Dependencies (dependency-subscription-ui.md §12, ADR-0032 §7e)

Admin › Dependencies (dependency-subscription-ui.md §12, ADR-0032 §7e) — the org's dependency PRODUCER declarations: declare / retract with a dry-run blast radius first. A static 2-segment path, so it out-ranks the dynamic `/$basePath/$idOrUrn` registry-detail route below exactly as `/connect/argocd` and `/federation/outposts` do. Linked from the COMMANDER nav only (owner rule 2026-08-17: dependency automation is commander-only); the page itself renders the "managed at the commander" pointer and issues no reads on any other install-time role.

### §158. Admin › Governance (governance-reach-on-containment-move.md §9.4)

Admin › Governance (governance-reach-on-containment-move.md §9.4) — the governance:move enforcement lattice: instance rung (read-only), the org rung switch, and the enabled-rungs table with Enable at… / Disable. A static 2-segment path, out-ranking the dynamic `/$basePath/$idOrUrn` registry-detail route below exactly as `/admin/dependencies` does. Linked from BOTH the commander and outpost nav tables (enforcement is per-instance). Admin › Access (role-model.md §5 steps 5/6/10) — the role catalogue, who holds what, and the caller's own effective permissions at one object. A static 2-segment path, out-ranking the dynamic `/$basePath/$idOrUrn` registry-detail route exactly as its siblings do.

BOTH SITES: an outpost's own principals hold roles in its own domain, and step 6's "what may I do here" is if anything MORE useful there — a field operator with no commander to ask.

### §159. Admin › Decisions

Admin › Decisions (owner-approved 2026-08-23, "Decisions & Audit explorer") — every Decision record browsable, filterable by `subjectId`/`kind` exactly as `GET /decisions` allows (charter principle 6). `subjectId` search param is what `registry-detail.tsx`'s "Decisions about this object" link carries — `useSubjectIdSearchForDecisions` (lib/use-route-params.ts). A static 2-segment path, out-ranking the dynamic `/$basePath/$idOrUrn` registry-detail route exactly as `/admin/dependencies` and `/admin/governance` do. Linked from BOTH nav tables (decisions and audit exist on every deployment).

## `apps/web/src/routes/admin-access.test.tsx`

### §160. ADMIN › ACCESS

ADMIN › ACCESS — the wired-up page against a stubbed SDK (role-model.md §5 steps 5, 6, 10).

What is pinned, and the mutation each pin exists to catch:

```text
- the page READS all three surfaces (`roles.list`, `roleBindings.list`, `authz.effective`) —
  a `return;` in any of them, or a component that renders static text instead of querying,
  goes RED on the call log;
- INSTANCE-TIER CREDENTIALS ARE NEVER REACHED FROM THE BROWSER, pinned the two ways Admin ›
  Governance had to pin the same property: clicking every control never records an
  `operatorCredentials.*` call, AND the page's own source never mentions the methods. The
  first pin alone was defeated on that page by a real wired button named off-pattern, so both
  are kept here;
- `authz.effective` is called with the SCOPE THE USER TYPED, not the default — a form that
  ignored its input would otherwise answer confidently about the wrong object;
- a DENY binding renders as `danger`, never as an ordinary row: a deny overrides every allow
  at any matching scope, and a reader who skims past it has the answer backwards;
- a role's `deprecated` flag renders as "no new bindings", not "deprecated" — D5 leaves every
  EXISTING binding resolving, and "deprecated" reads as inert;
- an empty effective-permission set renders "you hold no permissions", never an empty table —
  "nothing here" and "we could not ask" are different facts and the endpoint distinguishes them.
```

### §161. Poll until the reads have painted

Poll until the reads have painted. A fixed zero-delay tick is not enough — react-query resolves across several microtask turns, and asserting too early reads as "the page renders nothing", which is indistinguishable from a genuinely broken page. Wait on the CALL LOG, not on rendered text. The first version waited for "Roles" and matched the section heading, which is painted before any query resolves — so every content assertion ran against an empty table and read as a broken page.

## `apps/web/src/routes/admin-access.tsx`

### §162. ADMIN › ACCESS

ADMIN › ACCESS — roles, role bindings, and "what may I do here" (docs/proposals/role-model.md §5 steps 5, 6, 10; server routes `apps/server/src/routes/role-bindings.ts` and `routes/authz.ts`; SDK facades `client.roles`, `client.roleBindings`, `client.authz`).

WHY THIS PAGE EXISTS AT ALL, AND WHY IT IS NOT A PERMISSION MATRIX
The cumulative ladder was guessable — Viewer < Operator < Approver < Administrator < Owner — so a UI could infer a principal's whole permission set from a rank. drizzle/0099's five purpose roles are deliberately NOT ordered: SecurityOfficer holds `scan:override` and no `object:write`; OrgAdmin holds `policy:write` and NOT `scan:override`; neither is above the other. There is nothing left to infer, which is why step 6 built `GET /authz/effective` and why this page asks the server rather than computing anything client-side.

THE OFFER-THE-WRITE RULE (M16.3), APPLIED
Every write here renders for every viewer, and the SERVER'S OWN REFUSAL SENTENCE is what tells them no. This page never hides a button behind a client-side permission guess — a guess that is wrong in the permissive direction is a phantom control, and one wrong in the restrictive direction hides a capability the viewer actually has. The refusals this API produces are written to be read (they name the missing permission and the scope), so showing them is better than pre-empting them.

ONE DELIBERATE EXCEPTION, and it is the same one Admin › Governance makes: instance-tier OPERATOR CREDENTIALS are not offered here. Their write is gated by `x-scp-operator-token`, a deployment credential this browser never holds and should never be asked to hold. The section names the CLI verb instead of rendering a form that could only ever 403.

### §163. "What may I do here"

"What may I do here" — `GET /authz/effective`, which answers about the CALLER and nobody else.

There is no subject picker on purpose. The endpoint takes no `subjectId`, because a caller-chosen authorization anchor is one the caller sets to whatever admits them — the defect the neighbouring grant-preview was rewritten twice to remove. "Who else has authority here" is a real question and a different one.

### §164. Read nothing, offer nothing, and the same call elsewhere

READ-NOTHING, OFFER-NOTHING — deliberately, and the same call Admin › Governance makes for the instance rung.

Every operator-credential verb is gated by `x-scp-operator-token`: a deployment credential this browser never holds and should not be taught to. Rendering a form here could only ever produce a 403, and rendering a LISTING would require sending that token from a browser — so the section names the CLI instead. Present rather than omitted, because an operator looking for this surface should find out where it lives rather than conclude it does not exist.

## `apps/web/src/routes/admin-audit.test.tsx`

### §165. ADMIN › AUDIT

ADMIN › AUDIT — the wired-up page against a stubbed SDK (owner-approved 2026-08-23).

What is pinned, and the mutation each pin exists to catch: - the empty state renders ONLY after a successful zero-row read; mutation: paint it during pending → RED; - pending never paints empty (separate case: an unresolved promise leaves both the table and the empty state absent); - `audit:read` 403 renders the server's sentence VERBATIM via `QueryErrorNotice` — never a generic "could not load" with the detail swallowed, never an empty table; - "Load more" fetches the SERVER's `nextCursor` and appends, never re-fetching page 1; mutation: fire the fetch twice per click → the exactly-one-more-read count assertion goes RED; - a null `subjectId`/`decisionId`/`reason` renders "—", never a fabricated link or blank Why; - the WhyLink-equivalent on `decisionId` fetches `client.decisions.get` by THAT id and opens `DecisionDetailDialog` — mutation: hardcode the first row's id regardless of which was clicked → the "second row's own decision" assertion goes RED.

## `apps/web/src/routes/admin-audit.tsx`

### §166. ADMIN › AUDIT

ADMIN › AUDIT — the hash-chained audit log, browsable (owner-approved 2026-08-23; charter principle 6: "audit events are hash-chained and written in the same transaction as the action"; server route `GET /api/v1/audit-events`, `apps/server/src/routes/audit-events.ts`; SDK `client.auditEvents.list`).

WIRE ORDER, STATED HONESTLY: `listAuditEvents` (`audit/audit-repo.ts`) orders ascending by `seq` — "the order `scp audit verify` needs to re-walk the chain" per that module's own doc comment — and the cursor only ever moves forward (`gt(seq, afterSeq)`). There is no descending/newest-first request this API can answer; this table therefore reads OLDEST FIRST, walking the chain from its start, exactly like every consumer of this endpoint. It is not a "recent activity" feed — an org with a long history needs several "Load more" clicks to reach today. Flagged in openQuestions as a real usability gap, not silently reversed client-side: reversing per PAGE (the only thing this cursor lets you fetch) would not produce newest-first order at all, only a scrambled one.

INTEGRITY IS NOT PROVEN HERE: the chain hash is verified by `scp audit verify` (the CLI walks `beforeHash`/`afterHash`/`prevHash`/`rowHash`) — this page renders the rows the server returns and makes no claim about the chain's integrity beyond that. Stated in the header, not implied by merely displaying the hash columns.

`audit:read` gate (M16.3 offer-the-write — the READ, here — rule): a viewer without the permission gets the server's 403 rendered verbatim by `QueryErrorNotice`, the same as every other admin read in this app; the page issues the one read and shows whatever it says.

## `apps/web/src/routes/admin-decisions.test.tsx`

### §167. ADMIN › DECISIONS

ADMIN › DECISIONS — the wired-up page against a stubbed SDK (owner-approved 2026-08-23, "Decisions & Audit explorer" — charter principle 6).

What is pinned, and the mutation each pin exists to catch: - the empty state renders ONLY after a successful zero-row read — never while pending, never after an error; mutation: paint it during pending → RED (`pending never paints empty` case); mutation: paint it on error instead of `QueryErrorNotice` → RED; - a failed read renders `QueryErrorNotice`'s diagnosis, never a silently empty table; - "Load more" fetches the SERVER's own `nextCursor` and appends — never re-fetches page 1, never fires twice per click; mutation: drop the cursor from the second call → the exact-query assertion goes RED; - the filter form sends `subjectId`/`kind` ONLY when non-empty (never an empty-string filter masquerading as "no filter"), and re-queries from page 1 on Apply — mutation: keep sending a stale cursor after Apply → the "second call has no cursor" assertion goes RED; - the Why affordance opens `DecisionDetailDialog` with the SAME row's record, not a stale one.

## `apps/web/src/routes/admin-decisions.tsx`

### §168. ADMIN › DECISIONS

ADMIN › DECISIONS — every Decision record browsable, not just the one-at-a-time `WhyLink` (owner-approved 2026-08-23; charter principle 6: "every engine verdict persists a Decision record with its inputs"; server route `GET /api/v1/decisions`, `apps/server/src/routes/changes.ts`; SDK `client.decisions.list/get`).

FILTERS AS THE WIRE PROVIDES THEM, no more: `DecisionListQuerySchema` (packages/schemas/src/changes.ts) carries exactly `subjectId` and `kind` besides cursor/limit — both offered here as real server-side filters, nothing client-side pretending to be one. `kind` answers "which mechanism", not "what happened" — several kinds carry more than one verdict against the same subject (see the schema's own doc comment), which is why the verdict badge is still per-row rather than folded into the filter.

CURSOR PAGING, ONE PAGE EAGER: the `decisions` table once grew 1.44 GB/day in a production incident (a reconcile loop re-writing a byte-identical Decision every tick) — this page fetches exactly one page on load and one more per explicit "Load more" click, never on a timer and never unbounded.

WIRE ORDER, NOT RECENCY: `listDecisions` (`coordination/decisions-repo.ts`) orders ascending by `(createdAt, id)` — the same keyset-ascending convention every list endpoint in this app uses — so this table reads oldest-first within whatever filter is applied; "Load more" reveals LATER rows, not older ones. There is no server-side descending order to request.

The Why-style affordance opens `DecisionDetailDialog` (`components/decision/`) — the same `decisionSummary` formatting `change-detail.tsx`/`campaign-detail.tsx` use for their inline timelines, in a standalone viewer keyed by id (see that component's doc for why it is not literally `WhyLink`/`ReasonDialog`).

Honest empties: the "No decisions" state renders ONLY after a successful zero-row read, never while pending, and a failed read shows `QueryErrorNotice`'s diagnosis instead of a table.

## `apps/web/src/routes/admin-dependencies.test.tsx`

### §169. ADMIN › DEPENDENCIES

ADMIN › DEPENDENCIES — the wired-up page against a stubbed SDK (docs/proposals/dependency-subscription-ui.md §12.5).

What is pinned, and the mutation each pin exists to catch: - the ROLE GATE: any non-commander role renders the pointer and issues ZERO SDK calls (spy); mutation: issue the list read regardless of role → RED; - the WIRE gate: `dependencyManagement.managedHere: false` on a commander → pointer, no table; - the empty state renders ONLY after a successful zero-row read — never while pending or after an error; mutation: paint it during pending → RED; - the Declare dialog runs `dryRun: true` BEFORE the write and the Declare button is disabled until a preview exists for the SAME values; mutation: drop the preview gate → RED (the "disabled before preview" assertion and the "no non-dry-run call before preview" spy); invalidation is pinned PER FIELD — ecosystem, coordinate AND producer each re-disable Declare (mutation: drop any one of the three from the preview key → that field's case goes RED); - the picker's components.list query stays inside ObjectListQuerySchema (limit max 100 — a larger value is a 400 on the real server, invisible behind a mocked SDK); mutation: 200 → RED; - PICKER PAGING (§12.7): past 100 components, "Load more" fetches the next page via the SERVER's `nextCursor` and appends it — never a client-guessed offset, never more than one read in flight; mutation: drop the cursor from the second read → the schema-validity assertion and the exact-cursor assertion both go RED; mutation: fire the fetch twice per click → the "exactly one more read" count assertion goes RED; - every refusal status renders the server sentence; the retract dialog renders the real response's open bumps and stays open on them.

The SDK, the auth context and `@tanstack/react-router`'s Link are stubbed; everything else is the real component tree (Radix dialogs included) in a real DOM.

## `apps/web/src/routes/admin-dependencies.tsx`

### §170. ADMIN › DEPENDENCIES

ADMIN › DEPENDENCIES — the org's dependency PRODUCER declarations (docs/proposals/dependency-subscription-ui.md §12; ADR-0032 §7e; server route `apps/server/src/routes/dependency-producers.ts`).

"Dependency producers — which components this org publishes which coordinates from." A declaration is PER COORDINATE (every major, present and future): it removes the coordinate from third-party polling and CLEARS every covered line's observed head (both verbs — a stale head is an M22 vendor-scan-rule input). The blast radius is the set of components subscribed to those lines, unguessable from the request, which is why the dialogs here run `dryRun: true` FIRST and only then offer the write: the Declare button is enabled only after a preview for the SAME ecosystem / coordinate / producer, and editing any field invalidates it. Not a nicety.

COMMANDER SITE ONLY (owner rule 2026-08-17: dependency automation happens only at the commander). The nav carries the entry on the commander table alone; a direct URL on any other install-time role renders `ManagedAtCommanderNotice` (the same reason-aware pointer the Dependencies tab renders) and issues NO reads. On the commander the WIRE is honoured too: a list answer whose `dependencyManagement.managedHere` is false renders the pointer with the server's reason and no table — never an empty table that would read as "nothing declared".

WRITES ARE OFFERED, REFUSALS RENDERED (M16.3 rule): Declare… and Retract… render for every viewer; the server's own sentence is shown for every refusal — 400 (a `service`, not a `component`; nothing to retract), 404 (producer unresolvable in this org), 403 (`policy:write` at the org root), 409 (not a commander on the federation axis). A retraction stops FUTURE triggers only: the REAL response's `openBumpAuthorships[]` are pull requests SCP already opened in other teams' repositories and never closes, so that list is rendered as "still in flight" and the dialog stays open on it until dismissed — it is the operator's take-away.

Every name rendered (producer, declarer, subscribed components) is READ off the server's enriched response (§12.6 Q1) — never looked up N+1 from here, never inferred.

### §171. How a producer verb's refusal is rendered

How a producer verb's refusal is rendered (charter principle 6). 403 → names `policy:write` AT THE ORG ROOT (the route's authority; custody of the producing component is deliberately not enough) plus the server's detail; 409 → the server's sentence (not a commander on the federation axis) plus a Why link when the problem carried a `decision_id`; 400 / 404 → the server's sentence verbatim (a `service` is refused and the message says why; an unresolvable producer names the org). Never a fabricated Why link.

### §172. Per covered line: its major, the head that stood BEFORE

Per covered line: its major, the head that stood BEFORE (what the write clears — `headCleared` says whether there was one), and the subscribed components BY NAME (id fallback; "none subscribed" when empty). An empty `lines[]` is ordinary and says so in the exact §12.3.3 sentence.

### §173. Cursor paging for the picker

Cursor paging for the picker (dependency-subscription-ui.md §12 paging note). `components` above carries only the pages read so far — the first page loads eagerly (`limit: 100`, `ObjectListQuerySchema`'s max), and `onLoadMore` fetches the next one via the cursor the SERVER returned (`nextCursor`), never a client-guessed offset. `loading` disables the affordance so a double-click cannot start a second fetch — there is exactly one in-flight page at a time, never a parallel unbounded loop.

### §174. The declare dialog's CONTENT, portal-free

The declare dialog's CONTENT, portal-free — exported for the test. Two steps, and the second is GATED on the first: "Preview blast radius" runs the verb with `dryRun: true` and renders the report; "Declare" runs it for real, and is enabled ONLY while a preview exists for the SAME ecosystem / coordinate / producer (editing any field invalidates it). `run` is the SDK verb, threaded in so the body stays provider-free.

### §175. The retract dialog's CONTENT, portal-free

The retract dialog's CONTENT, portal-free — exported for the test. Runs the preview (`dryRun: true`) on open — there is nothing to type, the report IS the question — and offers Retract only once it has resolved. After the REAL retract the response's `openBumpAuthorships[]` (bumps SCP already dispatched — pull requests in other teams' repositories that a retraction does NOT close) is rendered as "still in flight" with the Decision id, and the body stays until dismissed: that list is the operator's take-away.

### §176. The page's whole rendering off an already-loaded

The page's whole rendering off an already-loaded, `managedHere: true` list. `producers` is the unpaged org list; the ecosystem chips filter it client-side. Provider-free apart from the two verb callbacks and the components read the declare dialog's picker needs.

### §177. `limit: 100` is ObjectListQuerySchema's MAX

`limit: 100` is ObjectListQuerySchema's MAX (packages/schemas/src/graph.ts) — a larger value is a 400 before auth, which is what every other components.list call site in this app also respects. The first page loads eagerly; an org with more than 100 components gets a "Load more" affordance (`ComponentsLoadMore`) that fetches subsequent pages via the SERVER's own `nextCursor` — never a client-guessed offset, and `useInfiniteQuery` guarantees at most one page in flight at a time.

## `apps/web/src/routes/admin-governance.test.tsx`

### §178. ADMIN › GOVERNANCE

ADMIN › GOVERNANCE — the wired-up page against a stubbed SDK (governance-reach-on-containment-move.md §9.4).

What is pinned, and the mutation each pin exists to catch:

```text
- NO ROLE/WIRE GATE: the page reads and renders identically regardless of `instanceRole` —
  enforcement is per-instance, unlike Admin › Dependencies;
- THE INSTANCE WRITE IS NOT OFFERED IN THE BROWSER, pinned TWO ways because the first way was
  not enough: clicking every control on the page never records a `governanceMove.setInstance`
  call, and the page's own source never mentions the method. (The original pin compared
  `data-testid` against a name pattern; review defeated it with a real wired button — once
  named off-pattern, once with no testid at all — and the suite stayed green both times.)
- the empty rungs table renders ONLY after a successful zero-row read — never while pending;
  mutation: paint it during pending → RED;
- the org rung switch derives its state from the `rungs` list (tier `"org"`), toggles by
  calling enable/disable with the org id, and renders 403/409 refusals VERBATIM with a Why
  link only when `decision_id` is present;
- Disable on an enabled-rungs row fires on ONE click with no intervening confirm dialog;
- the Enable at… picker's list query stays inside `ObjectListQuerySchema` (limit max 100);
- a successful enable/disable shows the Decision id + Why link and re-reads the rungs list.
```

The SDK, the auth context and `@tanstack/react-router`'s Link are stubbed; everything else is the real component tree (Radix dialogs included) in a real DOM.

### §179. STUBBED PURELY SO A CALL WOULD BE VISIBLE

STUBBED PURELY SO A CALL WOULD BE VISIBLE. The page must never reach it — the instance write is operator-token-only and binds every org on the deployment — and the "clicking EVERY control" case below asserts exactly that against this recorder. Leave it here even though nothing calls it: without it a page that DID call `setInstance` would throw `not a function` and the failure would read as an unrelated crash.

### §180. THE FUNCTIONAL PIN, and it replaced a naming-convention one

THE FUNCTIONAL PIN, and it replaced a naming-convention one. The first version of this case collected every control and asserted only that no `data-testid` matched /instance-(set|enable|disable|toggle|write)/ — which review defeated twice, with a real wired button named `instance-live-flip` and again with the same button carrying NO testid at all; the suite stayed 26/26 green both times. A substring check over names cannot see a control, so this asks the only question that matters: was the instance-write METHOD called?

### §181. The static half, which survives a control never rendered

The static half, and it is the one that survives a control this DOM never renders (behind a dialog, a role gate, a lazy branch). `client.governanceMove.setInstance` exists in the SDK (the CLI uses it with an operator token); the browser bundle must not call it, because the browser has no operator token and the write binds enforcement for EVERY org on the deployment. Mutation: add any `setInstance(` call to the page → RED, wired or not, named or not. Read from the vitest root (`apps/web`) rather than `import.meta.url`, which vite rewrites to a non-file scheme. The length assertion keeps the check from passing on a path typo — a "file not found" would otherwise have to throw to be noticed, and a renamed page should fail loudly here rather than quietly stop checking anything.

## `apps/web/src/routes/admin-governance.tsx`

### §182. ADMIN › GOVERNANCE

ADMIN › GOVERNANCE — the `governance:move` enforcement lattice (docs/proposals/governance-reach-on-containment-move.md §9.2/§9.4; owner ruling 2026-08-18; server routes `apps/server/src/routes/governance-move.ts`; SDK facade `client.governanceMove` in `packages/sdk/src/client.ts`).

"When enforcement is on for an object, moving it requires governance:move — held by Administrators and Owners." Enforcement is a top-down monotone OR of enabled RUNGS: the instance rung (deployment-wide, operator-only), the org root, or any containment domain / service / assembly. An upper rung's enable cannot be undone below it — `disable` answers 409 naming the blocker.

BOTH SITES CARRY THIS PAGE (unlike Admin › Dependencies, which is commander-only): enforcement is PER-INSTANCE, and an outpost's own local containment moves are real moves the lattice can govern just as a commander's can. No role/wire gate here — pinned by `app-shell-nav.test.tsx` (both `COMMANDER_NAV` and `OUTPOST_NAV` carry `/admin/governance`).

THREE PIECES, THREE AUTHORITIES (M16.3 offer-the-write rule: every write renders for every viewer, and the server's own refusal sentence is what tells them no):

```text
1. Instance rung — READ-ONLY here. The write is OPERATOR-token only (`SCP_OPERATOR_TOKEN`),
   never a tenant role, because it activates enforcement for every org on the deployment; the
   page names the CLI verb (`scp governance move-enforcement instance set --enabled
   true|false`) rather than offering a browser form for a credential this UI never holds.
2. Org rung — a switch on the org root (`useAuth()`'s `orgId`, from `/auth/me` — ADR-0021 D4
   makes the org id the org root object's id). `policy:write` at-or-above the org root;
   offered to every viewer, and a 403 renders the server's sentence.
3. Enabled rungs (containment domain / service / assembly) — a table with Disable (direct,
   no confirmation dialog: the consequence a confirm step would explain is already the 409
   sentence when disabling is refused) and an Enable at… dialog with a container picker.
```

The picker reads `client.domains.list`/`.services.list`/`.assemblies.list` at `limit: 100` — `ObjectListQuerySchema`'s max (packages/schemas/src/graph.ts); a larger value is a 400 on the real server, invisible behind a mocked SDK, which is why the test parses the query against the real schema rather than trusting the literal here.

Honest empties throughout: an empty rungs table renders ONLY after a successful zero-row read, never while pending, and a failed read shows the diagnosis instead of a table.

### §183. Every write refusal already names what would be needed

Every governance:move write refusal the server sends already NAMES what is needed (403: "…lacks 'policy:write' at scope '…'"; 409: "…is also enabled at <tier> '<name>' above it…") — so this renders the server's sentence verbatim, plus a Why link only when the problem carried a `decision_id` (the disable 409 does not today; never fabricate a link the server did not offer).

## `apps/web/src/routes/assembly-detail.tsx`

### §184. An outline `Button`-styled router `Link`

An outline `Button`-styled router `Link` — mirrors `Button`'s `outline size="sm"` classes plus the shared focus ring (§2.10) onto a `Link`, since `Button` itself renders a `<button>` and cannot navigate. Same pattern as `service-board.tsx`'s `LinkButton` (spec §2.12/§4B: every `→` literal dies).

### §185. One assembly: the layout and board, mirroring the service

ONE ASSEMBLY — the layout + board, mirroring `service-detail.tsx`/`service-board.tsx`.

TWO TABS, NOT THREE. A service carries Board/Infrastructure/Settings; an assembly gets Board/Settings, because there is nothing to put on an Infrastructure tab: `REGISTRIES` marks assemblies `edges: false` (an assembly does not `consumes`/`depends_on` — it does not make a request), and executor bindings resolve at the service or component rung, never here.

WHAT THE BOARD DELIBERATELY DOES NOT SHOW: a rolled-up status for the assembly itself. GLOSSARY.md §assembly rules that an assembly is "not a release unit either: a change is per- component, and rolling 'the assembly is blocked' up out of its children would need a rule nobody has chosen, so the service board shows an assembly with a component count and a link down, not a status." That ruling is not weakened by moving one level in — this board lists the assembly's components and links down to each one's pipeline. Per-component release state belongs here too, but there is no `GET /assemblies/{id}/board` to source it honestly (the service board's releasing/blocked/stable/unknown buckets are computed server-side, beside the freeze and driver-visibility logic that decides what this instance may even claim to know). Inventing it client-side would mean re-deriving that honesty in the browser — exactly the thing the service board exists to avoid — so this ships as an inventory with links, and gains status when the endpoint does.

## `apps/web/src/routes/campaign-detail-hold-wiring.test.tsx`

### §186. THE CAMPAIGN-LAYER HOLD-PARITY WIRING GATE

THE CAMPAIGN-LAYER HOLD-PARITY WIRING GATE (M25.UI) — the change-wave layer's freeze-hold projection (`ChangeWaveTargetSchema.hold` / `ChangeWaveSchema.heldTargetCount`, `change-pipeline-hold.test.tsx`) extended to campaign waves (`CampaignWaveTargetSchema.hold` / `CampaignWaveSchema.heldTargetCount`).

UNLIKE the change-pipeline hold fix, there is no separate value for `campaign-detail.tsx` to discard: a campaign wave target's `hold` rides the target object itself (mirroring the FREEZE half of `ChangeWaveTargetSchema.hold`, which `PipelineWaveCard` already reads straight off `target.hold` with no side-channel prop), and `campaign-detail.tsx` already passes each `explain()` wave straight into `PipelineWaveCard` unmodified (`<PipelineWaveCard wave={wave} .../>`) — the card's `PipelineWaveLike`/`PipelineWaveTargetLike` props are STRUCTURAL, satisfied by `CampaignWave`/`CampaignWaveTarget` the moment the wire type carries the fields, exactly as that module's own contract states ("campaign-detail.tsx migrates onto it later WITHOUT changes here").

The gate this file still closes: nothing here proves the ACTUAL rendered page reflects that — a future refactor of `campaign-detail.tsx` (e.g. mapping `wave` through an intermediate object that drops unfamiliar keys, or hand-rolling a wave card instead of reusing `PipelineWaveCard`) could silently stop passing `hold`/`heldTargetCount` through, and no server-side or schema-side test would ever see it. `renderToStaticMarkup(<CampaignDetailPage/>)` is the only altitude at which "the page renders what `explain()` sent" is a claim at all.

MUTATION-PROVEN (re-run when touching the wave-board mount): replacing `<PipelineWaveCard wave={wave} .../>` with a version that strips `hold`/`heldTargetCount` off `wave` before passing it down reds every assertion in the first `it` here while `PipelineWaveCard.test.tsx`'s own direct tests stay green — the same gap class `component-pipeline-correlated-infra-wiring.test.tsx` closes for the component-pipeline page.

## `apps/web/src/routes/campaign-detail.tsx`

### §187. One campaign, with the wave board view

`/campaigns/{id}` (BUILD_AND_TEST.md §8 M5 UI requirement: "...+ wave board view") — one `client.campaigns.explain()` call gets the campaign, its compiled plan/waves, and every Decision made about it. Polls every 3s (`refetchInterval`), same reasoning as change-detail.tsx: wave/target progress is written by the server-side reconciliation loop, not user action.

Wave board + Decisions render through the shared pipeline/decision module (design spec §2.13), the same one change-detail.tsx uses — `PipelineWaveCard` gives campaign wave targets the same version/executor/rollout detail and target-name resolution a change gets, and `PromotionArrow` is the only wave-to-wave connector app-wide.

## `apps/web/src/routes/campaign-list.tsx`

### §188. M5 types: @scp/schemas, not @scp/sdk

M5 types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts only re-exports M2/M3-era wire types; it never added a Campaign re-export block. Importing @scp/schemas directly here is within bounds (eslint.config.mjs's own restricted-imports rule: "apps/web/src may import only @scp/sdk and @scp/schemas"), matching how change-detail.tsx already does the same thing for M4's ApprovalRequest.

### §189. The campaign board, and what each row carries

`/campaigns` (BUILD_AND_TEST.md §8 M5 UI requirement: "campaign board") — every Campaign in the org, plus a "Create Campaign" dialog wrapping `client.campaigns.propose` (packages/sdk/src/client.ts).

## `apps/web/src/routes/change-detail.tsx`

### §190. M4 governance types: @scp/schemas, not @scp/sdk

M4 governance types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts only re-exports the M3 (and earlier) wire types; M4 never added ApprovalRequest/Freeze/etc. there. Importing @scp/schemas directly here is within bounds (eslint.config.mjs's own restricted-imports rule: "apps/web/src may import only @scp/sdk and @scp/schemas"), matching how packages/cli/src/cli.ts already sources these exact same types.

### §191. One change, with the wave progression view

`/changes/{id}` (BUILD_AND_TEST.md §8 M3 UI requirement: "...+ wave progression view") — one `client.changes.explain()` call gets the change, its compiled plan/waves, and every Decision made about it. Polls every 3s (`refetchInterval`) because wave/target progress is written by the server-side reconciliation loop, not user action — `scp.change.transitioned` (SSE, lib/use-event-stream.ts) only fires on whole-change state transitions, not intra-wave progress, so polling is the only mechanism that reliably surfaces live wave movement here.

Body order (design spec §4C): wave progression, then Decisions — the explainability core — directly after it, then Approvals/Control runs as compact cards.

### §192. These three gate ONLY on change STATE

These three gate ONLY on change STATE — whether the button is offered AT ALL for this lifecycle state.

Accept/Rollback/Cancel are deliberately NOT additionally gated on the change's federation origin — and that is STILL correct, though for the opposite reason it used to be.

WAS (M16.3 P2): the server did not refuse these on a foreign-origin change at all, so a UI gate would have simulated an enforcement that did not exist — which is exactly the defect PR #152 removed. That open question ("whether the server SHOULD refuse an accept on a change another domain drives") is now ANSWERED: S10 / PR #171 added `coordination/transition.ts`'s `enforceLocalChangeAuthority`, and all three verbs are refused with a 409 carrying `decision_id`. `foreign-origin-writes.integration.test.ts` measures the refusals; the "cancel SUCCEEDS" and "accept/rollback SUCCEED from validating" cases this comment used to cite no longer exist.

IS: the buttons stay ungated on origin because the server's refusal is the thing worth showing. Blocking client-side would swallow the 409 and its `decision_id` — the record that makes the block explainable (charter principle 6) — and would re-introduce a second copy of an authority rule that lives in one place on the server. State remains the only client-side gate.

### §193. Mirrors the pipeline page's hold resolution exactly

ADR-0028 increment 4 — mirrors `change-pipeline.tsx`'s `holdFor` exactly (M25.UI review minor finding 1). Without this, `heldTargetCount`'s badge here (composed from BOTH the freeze and stage-dependency halves — routes/changes.ts) told an operator "see each target's own hold line for which" while no stage-dependency hold line existed on this page at all: `explain` was already loaded, `stageDependencyStatus` was already sitting on the response, and the only thing missing was threading it through.

## `apps/web/src/routes/change-domain-local-badge.test.tsx`

### §194. M20-A3 (ADR-0031 §5, docs/proposals/outpost-ui.md)

M20-A3 (ADR-0031 §5, docs/proposals/outpost-ui.md) — `Change.domainLocal` RENDERED.

Two things get pinned here, at two different altitudes, for the same reason `change-pipeline-boundary-always-shown.test.tsx` gives for owning the page altitude separately from `change-pipeline-boundary-honesty.test.tsx`'s component altitude: a component-level test proves the piece is correct in isolation, but only a page-level render proves the page actually WIRES `change.domainLocal` through to it — deleting the `{change.domainLocal && <DomainLocalBadge />}` line, or forgetting to pass `domainLocal` into `NoBoundarySegment`, passes every component-level check while silently regressing the page.

```text
1. `NoBoundarySegment` (`components/pipeline/BoundarySegmentStrip.tsx`) — given `domainLocal`,
   states the HONEST reason a domain-local change's boundary segment is absent ("never leaves
   its domain") instead of the generic "not yet promoted" reading. Component-level, mirroring
   `change-pipeline-boundary-honesty.test.tsx`'s existing coverage of the non-domain-local copy.
2. `ChangePipelinePage` (`routes/change-pipeline.tsx`) — renders the SAME `DomainLocalBadge`
   every domain-local object wears (§ domain-local.test.tsx) next to the change title when
   `change.domainLocal`, absent when not, and drives the honest `NoBoundarySegment` copy above
   off the real `explain()` response. Reuses the exact mocking harness
   `change-pipeline-boundary-always-shown.test.tsx` established (stub `useQuery` off
   `queryKey[1]`, stub the router `Link`, stub `../lib/client`).
```

`change-detail.tsx` renders the identical one-line `{change.domainLocal && <DomainLocalBadge />}` pattern; it is not separately harnessed here because no test in this codebase yet mounts `ChangeDetailPage` (its four `useMutation` calls have no existing mock precedent to follow) and inventing one is out of scope for this change. `DomainLocalBadge` itself is already pinned by `components/domain-local.test.tsx`; what is new here is the CONDITION that gates it.

## `apps/web/src/routes/change-pipeline-boundary-always-shown.test.tsx`

### §195. "THE BOUNDARY SEGMENT IS **ALWAYS SHOWN**"

"THE BOUNDARY SEGMENT IS **ALWAYS SHOWN**" — pinned at the PAGE, by a check that runs on every PR.

## Why this file exists separately from `change-pipeline-boundary-honesty.test.tsx`

That file is the presentational contract: given a segment, does `BoundarySegmentStrip` keep "cannot see" and "observed" distinct and refuse to dress either as a pass? It renders `BoundarySegmentStrip` / `NoBoundarySegment` DIRECTLY. Nothing in it — and nothing anywhere else in the required PR checks — renders `ChangePipelinePage`. The Playwright specs that do walk the real route were `main`-only and SKIPPED on pull requests when this was written; they now run on PRs and 5z requires them. This file still owns the page altitude on the cheap side of the gate.

The gap that left: DELETING the boundary card from `change-pipeline.tsx`, or flipping its `boundarySegment ? <Strip/> : <NoBoundarySegment/>` to render nothing when the segment is null, passes every required PR check with both components still perfectly honest in isolation. "Always shown" is a DoD clause (`docs/BUILD_AND_TEST.md` M16) and it was the one clause no PR-gate test held. This file holds it, at the only altitude that can: the page.

## Both branches, because only one of them is the interesting one

The null branch is where "always shown" actually bites. A change that never crossed a domain boundary is the COMMON case, and the tempting simplification is to render nothing for it — which would silently turn "this change has not crossed a domain boundary" (a statement) into an absence (which an operator reads as "there is nothing to say here", i.e. nothing to check). So the present-and-null cases are asserted as a pair.

## Mocking

The page's data comes from four `useQuery` calls and its id from the router. Both are stubbed at the module seam: `useQuery` answers off `queryKey[1]`, `useIdParam` returns a fixed id, and `../lib/client` is replaced so no `ScpClient` is constructed. Nothing about the boundary card itself is stubbed — the real `ChangePipelinePage`, the real `BoundarySegmentStrip` and the real `NoBoundarySegment` render.

## `apps/web/src/routes/change-pipeline-boundary-honesty.test.tsx`

### §196. The rendering half of the boundary segment's honesty rule

The RENDERING half of the M16.1 boundary segment's honesty rule, pinned by a check that runs on EVERY PR.

Same reasoning — and same mechanism — as `service-board-honesty.test.tsx`: written when the Playwright specs were `main`-only and SKIPPED on pull requests, so a browser-only guard would let the UI regress into `main` with both required checks green. E2E now runs on PRs and 5z requires it; this file stays because it is milliseconds and browser-free, not because nothing else covers it. The server half of this rule is pinned by `apps/server/src/coordination/boundary-segment.integration.test.ts` (two federated domains, real Postgres); this file owns the presentational half — given a segment response, does the UI keep "cannot see" and "observed" visually distinct, and does it refuse to dress either as a pass? It runs in the existing unit-test job (plain `vitest run` + `react-dom/server`), needs no browser and no DOM library, and takes milliseconds.

VOCABULARY (ADR-0021 D6): a boundary SEGMENT of two boundary PHASES. Never a "stage" (a deployment place) and never a "wave" (the set of stages advanced at once).

`Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a `RouterProvider`; routing is not what is under test here.

### §197. THE COMMANDER SIDE

THE COMMANDER SIDE. It exported the promotion bundle; its own ledger row is (and by construction stays) `created`; and it has no data path to the receiving outpost's verification outcome. Both facts are declared by the server in `unknownFields`.

### §198. THE RECEIVING OUTPOST, verification refused

THE RECEIVING OUTPOST, verification refused (fail-closed block Decision).

`authorizedArtifactCount` is `null` here because that is what the SERVER emits on a refusal — the count is read off the Decision's authorized set, i.e. the set the gate was ASKED to check, which on a block still contains the artifacts that FAILED. `boundary-segment.ts` suppresses it rather than let a number sit beside a refusal reading as "n verified anyway". Pinned server-side in `boundary-segment.integration.test.ts` scenario (3).

### §199. drizzle/0087 — THE HOP-COUNT SPLIT

drizzle/0087 — THE HOP-COUNT SPLIT. `transfer.hops[].channel` distinguishes a retrans byte-relay leg from an ordinary metadata `.scpbundle` hop (`BoundaryTransferHopSchema`'s doc). This strip only ever COUNTS hops (it does not list them), so the honest rendering is a split count — "N bundle hop(s) observed here, of which M byte relay" — and ONLY when at least one hop actually carries `channel: 'bytes'`. A hop whose channel is null/absent must fold back into the plain count rather than read as "confirmed not a byte relay", which is a claim nobody made.

### §200. Y3(a) — THE PIN THE `isAbsent` FIX NEVER GOT

Y3(a) — THE PIN THE `isAbsent` FIX NEVER GOT.

Round 3 changed `authorizedArtifactCount === null` to `isAbsent(...)` at `BoundarySegmentStrip.tsx:166` and reported it as mutation-proven. It was not: reverting it left the whole `apps/web` suite GREEN, because every fixture above sets the key to `null` — the case that already worked. The case that did not is the key being ABSENT, which is what a server predating the field actually sends. (Since ADR-0023 the SDK rejects that body before a component ever sees it — `authorizedArtifactCount` is required-nullable, so an omission is a contract violation — but these tests drive the component DIRECTLY, which is the only level at which the guard itself, rather than the boundary in front of it, can be pinned.)

MEASURED mutant output, inside the `signatures verified` phase card: <p … title="undefined authorized artifacts">undefined authorized artifacts</p> — the literal word `undefined`, twice, once visible and once as a tooltip, beside a success badge.

### §201. Y4 — THE X7 CLASS, CLOSED FOR `unknownFields` ITSELF

Y4 — THE X7 CLASS, CLOSED FOR `unknownFields` ITSELF. `isBoundaryUnknown` dereferenced `segment.unknownFields` bare; the field is required-not-optional and BEFORE ADR-0023 the SDK validated nothing, so a server that omitted the honesty list threw inside the strip and took the change page with it. (Since ADR-0023 such a body rejects at the SDK boundary; the guard remains the component's own contract, which is what this file drives.) `declaredUnknowns` reads it as "nothing declared unobservable" — additive honesty on top of a working page, rather than no page.

## `apps/web/src/routes/change-pipeline-hold.test.tsx`

### §202. A HELD WAVE TARGET MUST NOT RENDER AS A BARE `pending`

A HELD WAVE TARGET MUST NOT RENDER AS A BARE `pending` — the CHANGE-pipeline page (ADR-0028 increment 4).

## The defect this pins, and why it survived the increment

A target whose trigger is being withheld by a stage dependency is left at `change_wave_targets.status = 'pending'`: the hold `continue`s in `reconcile.ts` BEFORE `triggerWaveTarget`, so nothing ever writes a different status. `pending` is also what a target shows when its wave has simply not reached it. Those are opposite facts — "waiting on something NAMED, and it will clear itself" versus "nothing is happening here" — and they were the same pixels.

The component-pipeline view was fixed for this. THIS page was not, while the ADR and the proposal were flipped to say every surface had shipped. The data was already on the wire and on this very page's `explain` response: `change-pipeline.tsx` destructured the response and left `stageDependencyStatus` behind. So the failure mode was not a missing feature but a discarded value, which is invisible to every test that asserts on the server's response.

## Why at the PAGE and not at `PipelineWaveCard`

`holdFor` is optional on the card, deliberately: a caller that has not loaded the status must not thereby assert nothing is held. That makes a card-level test unable to catch the actual bug — the card was always capable of rendering a hold once handed one, and the page was the thing not handing it over. `renderToStaticMarkup(<ChangePipelinePage/>)` is the only altitude at which "the page passes the status down" is a claim. Same seam and same mocking as `change-pipeline-boundary-always-shown.test.tsx`, for the reasons its header sets out.

## `apps/web/src/routes/change-pipeline.tsx`

### §203. Reason assembly (signal 3)

Reason assembly (signal 3): the block reason is REUSED from data the view already fetches — the side-effect-free `policyEvaluate` reasonTree/inputContext (identical in shape to a real block Decision, governance.ts:143) plus the `explain.controlRuns[]` evidence. The Decision's opaque reasonTree/inputContext are read defensively (they are typed `z.record` on the wire) — any missing/oddly-shaped field just drops that fragment, it never invents one.

### §204. Assemble the one-line block "why" from real gate + control-run data

Assemble the one-line block "why" from real gate + control-run data. Takes reasonTree/inputContext directly so the caller can pass the PERSISTED block Decision's (accurate — real control outcomes) in preference to the side-effect-free dry-run's (whose empty controlOutcomes can over-name a control). Returns undefined when there is nothing real to show, so the arrow stays a bare colored bar rather than carrying an invented reason.

### §205. The change-level (final) ACCEPTANCE gate

The change-level (final) ACCEPTANCE gate — validating → accepted (ADR-0021 D5; this is the one gate that is NOT a promotion — it is a human decision about a change). Colored from REAL state the change-detail page already loads: a pending ApprovalRequest (amber), a block Decision or a live side-effect-free policyEvaluate `block` verdict (red, with the Decision's `decision_id` when one exists — charter principle 6), else open/pending by change state. The `detail` "why" is assembled ONLY from real data already on the wire (gate reasonTree summary, freeze window from inputContext, joined failing control-run evidence, approval quorum) — never fabricated (ADR-0008, signal 3).

### §206. `/changes/{id}/pipeline` — the component pipeline view

`/changes/{id}/pipeline` — the component pipeline view (coordination-ui-views.md view 2, phase 1; everything rendered is real Layer A data — the "Layer A (real data only)" caveat that used to sit in the subtitle lives here now, not in chrome (copy rule 2)). Renders the change's compiled plan as top-to-bottom wave cards with wide promotion arrows between them colored by real gate/approval state. The per-wave version renders the REAL synced revision reconcile observed from status() (ADR-0008 decision 1), or an explicit placeholder until observed — never a fabricated version. Other Layer B signals (canary %, scan verdicts, health) remain explicit placeholders. Reuses the same `explain()` cache key as change-detail so the two views stay in sync.

### §207. The live stage-dependency verdict for each untriggered one

ADR-0028 increment 4 — the LIVE stage-dependency verdict for each untriggered wave target. `undefined` from a pre-increment-4 server (the field is additive and optional), `null` from a current one meaning "this change coupled nothing at any stage"; both render as they always did.

This page had the field on the wire and threw it away, which is the whole defect: a held target is `pending` in `change_wave_targets.status`, so it was indistinguishable from a target the wave has not reached. Read here rather than re-fetched — it arrives on the same `explain` response the page is already built from, so nothing about this costs a round trip.

## `apps/web/src/routes/component-dependencies-writes.test.tsx`

### §208. WHAT THE CLICK SENDS

WHAT THE CLICK SENDS — the request `client.policies.create` actually receives from the wired-up page, not the builder's return value (component-dependencies.test.tsx pins that half).

DELETE-THE-WIRING: the page's `mutationFn` is the ONLY thing that turns a confirm into a policy write. Replace it with a no-op (or point it at another client method) and every case here dies — the enable and opt-out confirms then send nothing, and the refusal case never sees the 409. Also pinned here: the SDK methods the page READS from (unlock / inventory / bumps) — stub any one out and the render fails on that read.

The SDK, the route param, the auth context and `@tanstack/react-router`'s Link are stubbed; everything else is the real component tree (Radix dialogs included) in a real DOM.

## `apps/web/src/routes/component-dependencies.test.tsx`

### §209. THE DEPENDENCIES TAB

THE DEPENDENCIES TAB — what it renders off the wire, and what it writes (docs/proposals/dependency-subscription-ui.md §4/§5).

Plain `renderToStaticMarkup`, no DOM: every pin here is on rendered markup or on a pure builder. The Radix dialogs portal nothing under a string render, so the dialog BODIES are exported and rendered directly (the precedent every pipeline write test follows). The interaction half — the confirm click reaching `client.policies.create` — is `component-dependencies-writes.test.tsx`.

MUTATIONS WATCHED TO FAIL (each applied alone, then reverted): - badge label read off a local recompute (`enabled ? "enabled" : anyDisable ? "opted out" : …`) instead of `subscription.reason` → "reads reason, never recomputes" RED - `IgnoredPill` returning null → "ignored contribution is never hidden" RED - the not-recorded branch rendering the "No dependencies declared" EmptyState → trichotomy RED - `buildOptOutPolicyRequest` moving the line into `scope` → payload pin RED

## `apps/web/src/routes/component-dependencies.tsx`

### §210. THE DEPENDENCIES TAB of one component

THE DEPENDENCIES TAB of one component (docs/proposals/dependency-subscription-ui.md §4).

It answers, per component: what do I depend on, what is the head of each major line, am I subscribed and why, what has been bumped, and can I enable / opt out here. Everything rendered is READ off three server responses — the instance unlock, the component's dependency inventory (rows carry each line's resolved dependency subscription, resolved AS THE CALLER, plus the component-level ingestion gate) and the bumps SCP authored — and NOTHING is recomputed here:

```text
- the badge on a row switches on `subscription.reason`; the header's component line switches on
  `componentGate.reason` (a different vocabulary, deliberately: the gate is existential over
  lines). This file never writes the enablement AND. A UI that ORed the contributions itself
  would be the second copy of the merge that lets the work-list and the screen disagree.
- an `ignored` contribution (a malformed effect, or an enable behind a condition that cannot be
  evaluated here) is rendered as an amber pill on the row and never hidden: hiding it hides
  exactly the opt-out an operator believed had applied.
- `head.latestVersion: null` renders as `—` "not observed yet" — never "nothing newer".
- `producer` renders only when DECLARED; nothing is inferred from a coordinate.
- an empty inventory is NEVER "No dependencies" unless an ingestion record says the manifests
  were read and declared none. The M21.7 STAMP (`ingestion`) is the trichotomy: `null` is
  never attempted; `ok` + 0 rows is "No dependencies declared — read N manifests"; `partial` /
  `unreadable` list every manifest (repo:path) with its outcome; `not_enabled` says the gate was
  closed. `null` beside a null `lastIngestionDecision` renders amber `unknown` ("not recorded —
  never attempted").
- the server's REQUIRED `dependencyManagement` envelope (ADR-0032 §7d) is the authority: when
  `managedHere` is false the page renders the same "managed at the commander" pointer the role
  gate renders (with the server's reason) and interprets nothing else — an empty inventory there
  is "nothing here ever ingested", not "declares nothing".
```

WRITES ARE OFFERED, REFUSALS RENDERED (M16.3 rule; owner decision §8 Q3). There is no permission introspection, so the enable and opt-out offers render for every viewer and the server's refusal is shown verbatim: 403 names the permission and where it is needed, 409 (a standing delegation to another tool) carries a `decision_id` and gets a Why link. Both writes are ORDINARY POLICY OBJECTS through `client.policies.create` — a dependency subscription IS a `dependencySubscription` effect on a policy — with `scope.objectRef` = this component and the effect-level line selector for an opt-out. This form NEVER offers a group scope (the server refuses a sole-group scope in both directions) and never a per-line "enable" (the chain enables; a line-level enable beside an org-level one would only be explainable, never effective on its own).

The instance unlock is READ-ONLY here (owner decision §8 Q2): the write needs a deployment secret no tenant role can hold, so the pointer is the CLI verb.

`instanceRole` is a PARAMETER of the bumps section (read by the page off `useAuth()` and threaded down, like the pipeline page does) so the renderers stay provider-free in tests. Third-party polls and bump dispatch run only on a declared commander; on any other role the section says so instead of drawing an empty table that would look up to date.

### §211. One PARALLEL read as the view sees it

One PARALLEL read as the view sees it. The page renders as soon as the inventory resolves; the unlock and the bumps are separate queries that may still be pending or may have failed. The view is told WHICH, so a read that has not finished is never painted as "could not be read", and a read that failed is never painted as "none" — the same honesty rule the inventory's empty states follow ("never No <noun> for an unknown").

### §212. The enabling policy for one component

The enabling policy for one component: `scope.objectRef` = the component, one `dependencySubscription` effect `enabled: true` with the chosen granularity/delivery, `enforcement: "advisory"` (the policy document requires an enforcement; the resolver never reads it). `domainId` is THE COMPONENT ITSELF (its own object id): `objects.domain_id` is a general containment-parent pointer (any org object is accepted), `POST /policies` authorizes `policy:write` at `domainId ?? org` and RBAC expands UPWARD from there — so a principal bound at the component, at its containment domain, or at the org all pass, and the written policy is contained by the component, where its team can later PATCH/DELETE it (those routes authorize at the policy's own id). Sending the containment domain instead would refuse the component-bound team; omitting it would refuse everyone below the org root.

### §213. The opt-out policy for ONE major line of one component

The opt-out policy for ONE major line of one component: the SAME `scope.objectRef` (the component — never a line selector in the scope, which has no such thing) and the line named at the EFFECT level (`ecosystem`, `coordinate` VERBATIM, `major` as the ecosystem spells it), with `enabled: false`. A disable at any tier wins, so this opts the line out whatever enabled it. `domainId` = the component itself, for the reasons on `buildEnablePolicyRequest`.

### §214. How a policy write's refusal is rendered

How a policy write's refusal is rendered (charter principle 6: every blocked response is explained). 403 → the permission and where it is needed (`POST /policies` authorizes `policy:write` at the body's `domainId` — this component — and RBAC expands upward, so a binding at the component or anywhere above it passes) plus the server's own detail; 409 → the server's detail (a standing delegation names the file/tool that owns this repo's updates) plus the `decision_id` for a Why link; anything else → the message as received. Never a fabricated Why link: `decisionId` is set only when the problem body carried one.

### §215. The Why dialog's CONTENT, portal-free

The Why dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under renderToStaticMarkup). One row per contribution, exactly as the server recorded it: tier, source, what it contributed, its selector, the granularity/delivery it DECLARED (absent = carried at the most restrictive default) and, for an ignored one, why. Same body for a row's resolution and for the component gate.

### §216. The enable dialog's CONTENT, portal-free

The enable dialog's CONTENT, portal-free — exported for the test. Collects granularity and delivery; the confirm is the ONLY thing that fires the write. States plainly that the first bump is always a pull request whatever the delivery, that auto-merge needs every enabling policy to agree, and (M25.8 / owner decision D8) that an active change freeze over the component withholds only the merge itself — never the pull request, and never permanently: `bump-gate.ts`'s `frozen` refusal kind still GRANTS auto-merge and every capability is in place, and `bump-freeze-redrive.ts` re-asks every open `frozen` bump roughly once a minute (`BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS`), so the merge lands on its own within about a minute of the freeze lifting — all three are the server's rules, repeated so the picker does not misrepresent them.

### §217. What to show when there are no rows, keyed on the stamp

What to show when there are NO rows, keyed on the ingestion stamp, then the newest ingestion Decision, then nothing — never collapsing to "No dependencies" without a record that says the manifests were read and declared none.

### §218. The Merge cell

The Merge cell — READ off what is stored, never inferred: `mergedAt` (a confirmed merge) → "merged <date>"; else the newest merge Decision's verdict; else, when a pull request NUMBER is on record, "not merged" (the stated absence — the server never observes a close-without-merge, so "open" would be a claim it cannot make); else `—`, because with no pull request reported there is nothing whose merge state could be described.

### §219. The bumps section

The bumps section — a table on the commander; on any other role a sentence, because third-party polls and bump dispatch run only on a declared commander and an empty table there would look up to date. On the commander the read's STATE decides: pending → a skeleton row; failed → an amber `unknown` line (the page's error notice carries the diagnosis); only a SUCCESSFUL read with zero rows says "No bumps yet."

### §220. What an OUTPOST

What an OUTPOST (or any non-commander) site renders at `/components/$idOrUrn/dependencies` when the URL is reached directly — the tab itself is hidden there (component-detail.tsx). Owner rule 2026-08-17: dependency automation happens ONLY at the commander — it pulls from public registries to bump the GLOBAL repos, and outposts receive the result down the promotion pipeline — so an outpost holds no dependency inventory and dispatches no bumps. A stated pointer, not an empty page that would read as "no dependencies". Provider-free; role is a PARAMETER.

### §221. "This component is the declared producer of `npm @acme/lib`, …

"This component is the declared producer of `npm @acme/lib`, … — Admin › Dependencies." Rendered ONLY when the org's producer list (`GET /dependencies/producers`, filtered by the page to `producerObjectId === component.id`) is non-empty for this component: it is the one place a TEAM sees that their component's releases now drive other teams' bumps without visiting Admin. Nothing is rendered while the read is pending or when it holds no row for this component — the strip asserts a fact, and its absence asserts nothing. A FAILED read is stated (an amber `unknown` pill), never painted as "not a producer".

### §222. The tab's whole rendering off already-loaded data

The tab's whole rendering off already-loaded data. `onEnable`/`onOptOut` receive the EXACT policy document to write; `writeState` is the page's mutation state so the open dialog can render the refusal. Provider-free so tests can render it with `renderToStaticMarkup`.

### §223. THE SERVER IS THE AUTHORITY

THE SERVER IS THE AUTHORITY (ADR-0032 §7d, M21.7): `dependencyManagement` is computed by the deployment's own commander-only predicate. When it says dependencies are not managed here, the rest of the envelope is not to be interpreted — the same pointer the role gate renders, plus the server's stated reason. Defensive beside the role gate above: a mis-set web-side role must never turn "nothing here ever ingested" into an empty inventory page.

## `apps/web/src/routes/component-detail-tabs.test.tsx`

### §224. THE COMPONENT TAB BAR

THE COMPONENT TAB BAR — the four Links, by testid and label. `router-paths.test.ts` proves the `/dependencies` URL is registered in the real route tree (DELETE-THE-WIRING: drop `componentDependenciesRoute` from `addChildren` and that case dies); this file proves the layout OFFERS the tab (drop the fourth Link and this dies), and that the three pre-existing testids — one of them pinned by `e2e/component-settings-tab.spec.ts` — are still there.

## `apps/web/src/routes/component-detail.tsx`

### §225. The chrome shared by every view of ONE component

The chrome shared by every view of ONE component — Infrastructure, Delivery, Dependencies and Settings.

WHY THIS EXISTS: `RegistryDetailPage` WAS ORPHANED FOR COMPONENTS
`/components/$idOrUrn` is a STATIC route (the pipeline, which is what a component is operationally), and a static segment out-ranks the dynamic `/$basePath/$idOrUrn` that renders the generic registry detail. So from the moment the pipeline shipped, the generic detail page was unreachable for components — and with it its labels, owners, "Move to service", executor-binding repurpose and component-merge cards, ~570 lines that quietly became dead for the one registry whose users need them most.

The fix is a parent route, not a second copy of that page: `/components/$idOrUrn` becomes a layout with an index child (the pipeline) and a `settings` child that mounts `RegistryDetailPage` unchanged. `useBasePathParam` falls back to the pathname's first segment, which is what lets the generic page resolve `components` on a route that has no `$basePath` param.

Every tab is a real URL — deep-linkable, and the back button moves between them — rather than component state, which is the only form of "tab" that survives being shared in a ticket.

WHY INFRASTRUCTURE AND SOFTWARE ARE SEPARATE TABS, not two columns of one page (owner, 2026-08-03): they are two independent pipelines, with their own repos, executors and release histories (docs/GLOSSARY.md "pipeline"). Side by side they compete for the width each one's node chain needs, and they read as halves of one thing. `/components/$id` stays the SOFTWARE pipeline so every existing link keeps landing on a component's usual view.

### §226. Every interactive element carries the shared focus ring

Every interactive element carries the shared focus ring (design spec §2.10). The ACTIVE tab must be unmistakable (owner, 2026-08-14: "make sure we're highlighting which view we're on"). A hairline olive underline on a white bar did not register; the active tab is now a filled army-700 segment with white text — the same treatment the sidebar gives its active entry (§3.2), so "where am I" reads the same way in both navs. Inactive tabs stay quiet text.

### §227. Dependency automation happens only at the commander

Owner rule (2026-08-17): dependency automation happens ONLY at the commander — it pulls from public registries to bump the GLOBAL repos, and outposts receive the result down the promotion pipeline. So the Dependencies tab is a commander-site tab (like Campaigns/Graph in the nav): read from the install-time role, never from data. A direct URL on an outpost still renders a stated pointer (component-dependencies.tsx), never the page.

## `apps/web/src/routes/component-graph.tsx`

### §228. The component layer of the two-layer graph explorer

`/graph/service/$serviceId` — the COMPONENT layer of the two-layer graph explorer (coordination-ui-views.md § two-layer graph, Phase 3). Reached by clicking a service in the service-layer graph (`/graph`).

Shows this service's components + their internal `consumes`/`depends_on` links, PLUS cross-service links (dashed) to *other* services' components. Every node/edge is derived from REAL graph data — nothing is synthesized: 1. `traverse(service, out, contains)` → this service's components. 2. per component `traverse(both, {consumes,depends_on})` → the component-level edges + the typed neighbor objects (so external components can be named). 3. for each edge endpoint NOT owned by this service, resolve its OWNING service from the real `contains` parent (`relationships.list({toId, typeId:'contains'})`) — this confirms the edge genuinely crosses services (never guessed) and supplies the external node's owning-service label.

NOTE (Layer B, deferred): the proposal's optional per-node HEALTH dot (up/degraded/down/no-metric) needs an owner-supplied up/down observe signal that the API does not yet capture — so it is intentionally omitted here rather than fabricated (coordination-ui-views.md Phase 4d).

### §229. This service's components, at depth two rather than one

1. This service's components (real `contains` children).

maxDepth 2, NOT 1: containment is `service -> [assembly] -> component`, and the assembly rung is optional. At depth 1 a service whose components all sit under an assembly returned only the assembly, which the `typeId === "component"` filter then dropped — so that service rendered a completely empty component graph while genuinely having components one hop further down. Depth 2 covers both shapes; the ladder is capped at three rungs server-side (`assembly -> assembly` is refused outright), so there is no deeper case to miss.

## `apps/web/src/routes/component-pipeline-continuous.test.tsx`

### §230. The rendering half of a component's continuous pipeline

THE RENDERING HALF of "a component's pipeline is continuous, and it is the WHOLE journey".

The server half (`apps/server/src/coordination/component-pipeline.integration.test.ts`) proves the projection is well-defined for a component that has never released, and that it carries the stages the component is NOT placed at. This file owns the part a browser can still undo: given that response, does the UI actually PAINT a pipeline — does it keep "not observed" distinct from "nothing deployed", and "not placed" distinct from "placed, nothing released yet"?

Same reasoning and same mechanism as `service-board-honesty.test.tsx`: it runs in the plain unit job (transitively required on PRs), needs no browser, and takes milliseconds. The E2E spec proves the real route and real SDK; this proves the presentational contract.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| render the version cell as `{stage.version}` (empty when null) instead of the unknown treatment | the honesty test FAILS — a blank reads as "nothing deployed" | | drop the `No executor` badge for a null binding | the unbound test FAILS | | gate the stage list on `stage.current` being set | the never-released test FAILS with no stages painted — the old bug, in the UI | | drop `unplacedStages` from `buildJourney`'s input | the interleaving test FAILS — the unplaced stage vanishes, which is the bug this view was rebuilt for | | concatenate the two arrays with NO sort | the interleaving test FAILS — the journey paints gamma→prod→staging | | group waves by NAME instead of wave index | the parallel-wave test FAILS — two same-named sequential waves merge into one row | | drop the "Not placed" badge and the consequence line from `UnplacedStageCard` | the not-placed test FAILS — greyed alone is indistinguishable from quiet | | drop the `registry` node from the software chain | the node-order test FAILS — the glossary puts registry between build and config, so omitting it misdraws the pipeline | | stop deduping build bindings across placements | the dedupe test FAILS — a build repeated at every place would draw as several builds | | render a `<a href="#">` when the server sent `url: null` | both link tests FAIL — a node must be clickable exactly when there is somewhere real to go | | drop the "none required" text when a gate asks for no control | the gate test FAILS — a blank Checks line reads as "we cannot see checks", when none are configured | | render the stage's deployment row from `stage.current` instead of the lane's | the per-lane release test already covers it; noted here because the deployment row is the SECOND consumer of that field | | sort the journey by `wave.index` instead of `order` | ALL TESTS STAY GREEN, and that is CORRECT, not a gap: the server emits `order` as the union index with null-wave entries last, so the two orderings agree on every response it can produce. Recorded here so nobody "fixes" this by writing a test that pins an ordering the API does not promise | | fall back to `deploymentTarget.name` when no facet value is declared | the no-facet test FAILS — the element appears carrying the name, which is exactly the "derived from what it is called" trap | | join the facet as substrate · region · account · cluster | the four-value test FAILS on the fixed order | | draw the registry node only on `buildsHere` (ignore `registry`) | the outpost-case and ambiguous node-order tests FAIL — a declared registry with no build draws nothing | | draw the registry node for `state: "none"` too | the stated-absence test FAILS — a node appears for a fact the server said is absent | | draw the registry node in the INFRA lane when a registry is declared | the infra-lane test FAILS | | render `ambiguous` through the `declared` branch | the ambiguous header test FAILS — no count, no amber | | link the registry name to `url + "/" + repository` (a guessed deep path) | the declared header test FAILS on the base-only href | | drop the `instanceRole === "commander"` gate on the Scan & sign node | SIX tests FAIL — the outpost/undefined-role orders and every pre-§9.3 pinned chain grow a node this site never performs | | draw the Scan & sign node in the infra lane too | the infra-lane test FAILS | | mark a scan row `managed` from `scanner === "openscap"` instead of the wire's `managed` flag | the flag-not-name test FAILS — a trivy managed row loses its mark, an org openscap row gains one | | make the Build tile reviewable whenever an artifact exists (ignore SBOM/PM) | the two "no click affordance" tests FAIL — a button appears with nothing to review | | make the Scan & sign tile reviewable on scans only (ignore exports) | the exports-only test FAILS — a signed manifest is reviewable too | | take the FIRST export as "newest" | the PM-line test FAILS — the older peer is named | | take the FIRST digest as "latest" | the several-digests test FAILS | | link an SBOM location whatever its scheme | the OCI-ref test FAILS — a non-URL is drawn as somewhere to go | | render `artifact: null` through the "not observed" (unknown) branch of the Registry body | the absence-vs-unknown test FAILS | | word the outpost's absent PM the way the commander's is | (pre-§10.1) the outpost test FAILED — superseded: the PM no longer renders on Build at all | | keep the PM line on the Build tile (§10.1) | the "PM is ABSENT from the Build tile" test FAILS on `pipeline-build-pm` | | make the Build tile reviewable on an export alone | the "an export alone does NOT make the Build tile clickable" test FAILS | | render the PM line AFTER the sign lines | the scan → E6 → PM → sign order test FAILS | | drop the manifest section from `ScanSignReviewBody` | the PM section test FAILS | | make the Registry reviewable whenever an artifact exists (ignore `importedManifest`) | the §10.4 "absent → NO Review affordance" test FAILS — a button with nothing to review | | render the absent-imported-manifest line on the commander too | the §10.4 absent test FAILS on the commander half | | word the `importedManifest:unsigned` unknown as the absence sentence | the §10.4 stated-unknown test FAILS | | read `exporterName ?? changeName` on the manifest line | the "nothing reads names" test FAILS |

### §231. The substrate facets a target may declare

pipeline-substrate-registry-scan.md §9.1: `substrate`, `account`, `region`, `cluster` are typed, optional string properties of a deployment-target (migration 0065). A quiet line beside the hint joins ONLY the values that are declared. Null is an ABSENCE of a declaration, not an unknown observation, so it earns no `—` and no badge — and nothing declared means no line at all. `name` is never read: `us-east-1-prod (k8s)` looks parseable and is exactly the trap.

### §232. Which outpost a target is part of, as rendered

pipeline-substrate-registry-scan.md §10.2 — WHICH OUTPOST a target is part of, by the owner's TRUST-DOMAIN RULE. The server resolves it (`stages[].outpost` / `unplacedStages[].outpost`) and the tile RENDERS THE STATE IT IS GIVEN. Every fixture below deliberately names the target something outpost-shaped (`field-cluster`) with a stated outpost that is NOT the target's name, so a tile that derived the line from `deploymentTarget.name` fails.

MUTATION LOG (each applied ALONE, then reverted) | Mutation | Result |
| render `outpost {deploymentTarget.name}` (derive from the name) | the "never reads the target name" tests FAIL | | link the outpost line regardless of `instanceRole` | the plain-text-on-an-outpost-site test FAILS | | render `peer-without-outpost` through the `outpost` branch | the peer test FAILS on "no outpost record" | | render `unknown-domain` as `this instance` | the unknown test FAILS | | render `peer-not-outpost` through the `peer-without-outpost` branch | the peer-not-outpost test FAILS on "no outpost record" / "Federation › Outposts" | | word `peer-not-outpost` as `commander` regardless of `peerRole` | the retrans half ("relay …") and the "unset" tail FAIL | | drop the line from `UnplacedStageCard` | the unplaced test FAILS |

### §233. On an OUTPOST site

On an OUTPOST site (or an unknown role) the SAME absence is stated, but the title does NOT point at Federation › Outposts: the server's self-shape door takes the write only from a commander-role instance (`outpost-binding.ts`, measured in `outpost-config-sync.integration.test.ts`) — an outpost's own record is commander-declared and arrives replicated, and a hint to declare it locally would guide the operator into a 400.

### §234. ADR-0028 INCREMENT 4 — A HELD STAGE IS LEGIBLE AS ONE

ADR-0028 INCREMENT 4 — A HELD STAGE IS LEGIBLE AS ONE.

The defect in one line: a wave target whose trigger is withheld by a stage-scoped component coupling keeps `change_wave_targets.status = "pending"` forever — the server's hold `continue`s before the target is ever handed to an executor — and this view painted that identically to "the wave has not reached this stage yet". Those are opposite facts. One is waiting on something NAMED and clears itself; the other is waiting on nothing.

The server half (`apps/server/src/coordination/stage-dependency-surfaces.integration.test.ts`) proves `stages[].hold` is computed live and self-clearing. This file owns what a browser can still undo: given that response, does the page say WHAT it is waiting on?

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `StatusPill` renders `status ?? "never deployed"` regardless of the hold | 1 fails — `expected 'pending' to contain 'held'`. The pill reads `pending`: the defect verbatim | | `HoldSubnode` maps over `[]` instead of `hold.dependencies` | 4 fail — the naming, id-fallback, edge-provenance and per-lane cases. The card still says "Held here" and gives no way to find out by what | | `holdFor` ignores the lane and returns `stage.hold` whenever it is set | 1 fails — `expected … not to contain 'payments-api'`. The infrastructure lane, whose release here succeeded a month ago, is painted as held by the software pipeline's coupling | | `stateOf` maps a hold to `"blocked"` — the union member that already existed | 2 fail — `expected 'blocked' to be 'held'`. Worth keeping in mind: it type-checks, it renders, and it re-creates the permanent-red marker the server deliberately wrote `verdict: "hold"` rather than `"block"` to avoid | | `arrowInto` checks `held` AFTER `approval` | 1 fails — `expected 'approval' to be 'held'` | | `arrowInto` checks `held` BEFORE `blocked` (by dropping the `blocked` rung) | 1 fails — `expected 'held' to be 'blocked'`. This is the rung the ladder test was given a two-target fixture for; with one target per wave it would have stayed green, which is why the fixture holds a held target and a FAILED one in the same wave |

### §235. ONE TILE PER SOURCE

ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile — commander and outposts alike; the only thing that ever shares a tile is a test with its target"). The target side already obeyed it (one StageCard per target under a wave label). This pins the source side: N inputs → N tiles, side by side, and never two repos inside one tile. The commander-as-opaque-input is itself a tile when present.

### §236. Global sources should be labelled as such in pipelines

§10.6 (owner, 2026-08-16): "Global sources should be labeled as such in pipelines." The eyebrow is READ off each mapping's own `scope` / `mirrorOfShared` — four cases — and it renders on EVERY site, the commander's included (the old `showProvenance` gate hid every eyebrow unless a commander input or a domain-local component was present, which is exactly the site whose global sources went unlabelled). Nothing here reads `upstream` or the site's role: an undeclared scope on the commander is NOT global, it is undeclared, and the tile says so in its title rather than guessing. `sourceProvenance` is the one derivation; the render tests pin that the tiles honour it.

### §237. EACH SOURCE TILE GETS ITS OWN ARROW

EACH SOURCE TILE GETS ITS OWN ARROW (owner, 2026-08-14: "each [source] should have its own arrow so I can enable and disable each as needed", "they should also appear side by side" — for ALL pipelines, commander and outpost). The describe above pins ONE-TILE-PER-SOURCE; this pins the two things layered on top of it: a fan-in arrow PER tile instead of one shared connector for the whole row, and the durable per-mapping enable/disable the correlation matcher now honours (migration 0063's `matchComponentForSource`) — a toggle that does not change matching would be theatre.

### §238. A WAVE LABEL STATES ITS ORDER CLAIM

A WAVE LABEL STATES ITS ORDER CLAIM (owner, 2026-08-14: "why would we deploy to gamma and prod in parallel?"). Targets side by side are legitimately one wave that fans out (us-east-1-prod ∥ us-west-1-prod) — so a row that is NOT a declared wave must say so, or side-by-side placements read as "released to all at once". Pinned: a declared wave labels itself "Wave N · name"; the off-topology row labels itself as unordered placements and never as a wave.

### §239. NOT ONE CLICK

NOT ONE CLICK (owner, 2026-08-14): "Enabled is default. If clicking on it while enabled, it should give you the option to disable for x period of time or until manually enabled again. There should also be a confirmation screen. When disabled, users can enable but it also needs a confirmation screen." The arrow opens a DIALOG; the dialog holds the choice and the confirm; the mutation fires only from the confirm. Radix's dialog renders nothing under renderToStaticMarkup, so the dialog body is pinned by rendering it open via its own component export.

### §240. GREY MEANS "NOT A SWITCH", NEVER "CLOSED"

GREY MEANS "NOT A SWITCH", NEVER "CLOSED" (owner question, 2026-08-14: "the grey arrows are not clickable — is that intentional?"). Yes, and this pins the rule so it stays legible: only arrows this domain can open/close are switches (green open / red closed, always clickable). The commander's opaque-input arrow and every chain connector are NOT switches — grey, not clickable — because there is nothing there for the operator to toggle.

### §241. §9.3 — the ARTIFACT on the tiles

§9.3 — the ARTIFACT on the tiles: Registry body (latest digest), Build (SBOM + PM), Scan & sign (commander only). pipeline-substrate-registry-scan.md §9.3/§9.6. Every rendered value is READ from `artifact` or stated absent; a tile is clickable exactly when it has something to review.

### §242. component-journey-view.md §3 Segment 2

component-journey-view.md §3 Segment 2 — the "upstream build" marker: the observed CI run line beneath "built upstream of CommanderSCP". Server-composed text rendered verbatim; the line exists ONLY in the upstream case (no build binding) and ONLY when the server named a run.

### §243. SITE SCOPE — owner rule 2026-08-17

SITE SCOPE — owner rule 2026-08-17: "the global pipeline should have all things global; the outpost pipeline should only have things managed by that outpost". Read off `stage.outpost` against this instance's own trust domain — never a name, never `maintainedBy`.

## `apps/web/src/routes/component-pipeline-correlated-infra-wiring.test.tsx`

### §244. The delete-the-wiring gate for the correlated section

THE DELETE-THE-WIRING GATE for the correlated-infrastructure section (owner decision, 2026-08-24). `component-pipeline-correlated-infra.test.tsx` proves `CorrelatedInfraSection` renders every claim correctly — by mounting the SECTION directly. That leaves the one line that makes the feature real (`ComponentPipelinePage`'s `showsCorrelatedInfra(lane) ? <CorrelatedInfraSection …>` mount) covered by nothing: the review lens's delete-the-wiring mutation removed it and the whole suite stayed green — the repo's recorded dominant failure class (a component built, tested directly, installed nowhere). This file closes that gate at the PAGE level, through the same mock harness `change-pipeline-hold.test.tsx` established: mock the two hooks and `useQuery`, render the REAL page, and assert on what MOUNTS.

MUTATION-PROVEN (re-run when touching the mount): removing the `showsCorrelatedInfra(lane) ? <CorrelatedInfraSection …> : null` lines from `component-pipeline.tsx` reds the first test here by name while the section's own direct tests stay green — which is exactly the gap this file exists to close.

## `apps/web/src/routes/component-pipeline-correlated-infra.test.tsx`

### §245. THE CORRELATED-INFRASTRUCTURE SECTION

THE CORRELATED-INFRASTRUCTURE SECTION (owner decision, 2026-08-24) — the rendering half. `component-pipeline-correlated-infra.integration.test.ts` (server) proves the response is computed correctly; this proves the client paints exactly what the response states, keeps absent (older server) distinguishable from empty (evaluated, none), and never mounts the section on the software lane, whose pipeline has nothing this fact is about.

## `apps/web/src/routes/component-pipeline-density-interaction.test.tsx`

### §246. TILE DENSITY (pipeline-substrate-registry-scan.md §10.3)

TILE DENSITY (pipeline-substrate-registry-scan.md §10.3) — the BEHAVIOURAL half.

`component-pipeline-density.test.tsx` pins WHAT the compact and expanded markup hold. This file pins that the controls actually MOVE between them, which a string render cannot show (see `test-support/render-dom.tsx` for why a real DOM was taken on):

```text
- a tile's chevron toggles ITS region, and only its;
- the page-level control flips EVERY tile — Expand all, then Collapse all;
- a tile's own chevron OVERRIDES the page-level state locally, until the next page-level flip,
  which wins again (the `version` in the context is what makes the override expire).
```

The tiles render under the SAME `TileDetailsScope` the page mounts, so what is clicked here is what the operator clicks.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `TileDetailsScope` does not bump `version` on a flip | the "override expires on the next page flip" test FAILS — the locally-shut tile stays shut after Expand all | | `useTileDetails` ignores `local` (always follows the scope) | the chevron test FAILS — a click changes nothing | | `useTileDetails` ignores the scope once a local override exists (no version check) | the expiry test FAILS | | the page control flips only `expandedAll` on the FIRST click and never back | the Collapse-all half FAILS |

## `apps/web/src/routes/component-pipeline-density.test.tsx`

### §247. TILE DENSITY (pipeline-substrate-registry-scan.md §10.3, owner)

TILE DENSITY (pipeline-substrate-registry-scan.md §10.3, owner) — the STATIC half.

Every pipeline tile is a COMPACT part plus a Details disclosure, collapsed by default. This file pins, tile by tile, that the compact markup holds EXACTLY the compact set and NOT the detail rows — and that rendering the same tile expanded reveals them (nothing that rendered before §10.3 became unreachable; it moved). The doubles' `detailsExpanded` prop is the pin: omitted, a tile takes the production default (collapsed); `true` opens it through the same context the page's Expand-all control drives.

The BEHAVIOURAL half — a real click on the chevron, Expand all / Collapse all flipping every tile, a tile's own override until the next page flip — lives in `component-pipeline-density-interaction.test.tsx` under happy-dom, because a string cannot fire a handler (see `test-support/render-dom.tsx`).

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| `TileDetails` renders its children whether or not `open` (only `hidden` toggles) | every "compact does NOT contain" assertion FAILS — the detail rows are back in the markup | | `useTileDetails` reads `scope.expandedAll ?? true` (default open) | the collapsed-by-default tests FAIL, and every compact-set test with them | | `NodeShell` draws `<TileDetails>` even with no `details` | the Build "no toggle" test FAILS — a chevron over nothing | | keep `MaintainerLine` in the compact part of `StageCard` | the target compact test FAILS on `stage-maintainer` | | `GateSummary` reads `gate.checks.length` for the "none" branch instead of `gate.policies.length` | the approval-only gate test FAILS — an approval-gated stage reads "none" | | `scanSummary` folds a `fail` row as `pass` when another row passed | the fail-verdict test FAILS | | put the Registry's "from change" back on the compact digest line | the Registry compact test FAILS on "from change" | | drop `aria-label` from the `TileDetails` button (or pass no `label` from `NodeShell`) | the disclosure-ARIA test and the "every kind of tile names WHOSE details" test FAIL | | render the Registry's absent-imported-manifest line for every role (drop the `!== "commander"` guard) | the §10.4 absent-manifest test FAILS on the commander half | | put the Registry's PRESENT imported-manifest line under Details (or drop `registryHasReview`) | the §10.4 present-manifest test FAILS (compact lacks the line / no Review button) |

## `apps/web/src/routes/component-pipeline-writes.test.tsx`

### §248. A1 + B2 (docs/proposals/outpost-ui.md §3/§4)

A1 + B2 (docs/proposals/outpost-ui.md §3/§4) — the two writes this file adds to what was, before this round, a read-only view: source-mapping create/delete, and placement create/delete. Same harness as `component-pipeline-continuous.test.tsx` (plain `renderToStaticMarkup`, no jsdom) and the same `Link` stub — none of the components pinned here use it, but the module-level import in `component-pipeline.tsx` still resolves through this mock when the file loads.

Radix's `SelectContent`/`DialogContent` both portal their children, which render nothing under `renderToStaticMarkup` (domain-local.test.tsx's precedent, reconfirmed by `registry-list-nested-domains.test.tsx`'s G2 parent-domain picker). So this file pins two different things depending on what a component actually claims: - a Select/Dialog TRIGGER's presence, label, and testid — genuinely static, safe to assert; - the VALUE that reaches a request body — via the pure payload-builder functions, never by trying to read a portaled option list back out of static HTML.

## `apps/web/src/routes/component-pipeline.tsx`

### §249. A1/B2 (docs/proposals/outpost-ui.md §3/§4)

A1/B2 (docs/proposals/outpost-ui.md §3/§4): `@scp/sdk`'s index only re-exports the M3-era change-sources types (`CreateSourceMappingRequest`); the delete-tuple and placement-create shapes never got an SDK re-export block. `@scp/schemas` directly is within eslint's own restricted-imports allowance ("apps/web/src may import only @scp/sdk and @scp/schemas"), matching `registry-detail.tsx`'s `ExecutorTypeSchema` import.

### §250. THE COMPONENT PIPELINE

THE COMPONENT PIPELINE — the default view of a component (coordination-ui-views.md §2, corrected 2026-08-03).

A pipeline is a durable property of a component; artifacts move THROUGH it. Two corrections got it here, and this file must keep BOTH:

```text
1. The surface this replaces was keyed on a CHANGE, so a component with nothing in flight had no
   pipeline to open at all. Nothing here may be gated on `stage.current`.
2. The first version of the replacement drew one card per PLACEMENT, so a stage the component is
   NOT placed at rendered nowhere — on the live estate, a two-wave topology showed one card and
   prod was simply absent. The journey is the topology's WAVES, and a stage with no placement is
   drawn greyed and explicitly "not placed" rather than omitted.
```

"Not placed" and "placed, nothing released yet" are deliberately different pictures. The second is ordinary (a new placement); the first says this component's releases never reach that stage, which is usually the most important thing on the page.

Waves stack VERTICALLY with a `PromotionArrow` between them — the same shape `change-pipeline.tsx` uses, and the one that component was drawn for (its arrow points down). Targets inside one wave sit side by side, because that is what a parallel wave means.

### §251. WHICH OF THIS STAGE'S PIPELINES THE HOLD IS ABOUT

WHICH OF THIS STAGE'S PIPELINES THE HOLD IS ABOUT (ADR-0028 increment 4).

`stages[].hold` is keyed on the PLACEMENT — the coupling is evaluated per wave target and a wave target's `target_object_id` is the placement — so it says "a release is being withheld here" without saying which lane. That distinction matters: a change can hold this place's `configuration` target while the infrastructure pipeline here is simply idle, and painting the infra lane "held" would claim a pipeline is waiting when nothing of it is running at all.

The join is the one the response already carries: the hold names its `changeId`, and each lane's `current` names the change whose release is in that lane. The status check is what keeps it exact — a target already handed to an executor is past the hold, whatever another target of the same change at the same place is doing.

### §252. A stage's promotion state, from what the SERVER could observe

A stage's promotion state, from what the SERVER could observe — never invented.

`pending` (grey) is the honest default: it means "nothing has released here", which is a real and common state for a placement, NOT a failure. Only an actually-failed target goes red.

`held` sits between the two and is the reason this function grew a second argument. A held wave target's status is and stays `pending` — the server's hold `continue`s before it is ever handed to an executor — so without the hold it painted identically to "the wave has not reached here yet". Those are opposite facts: one is waiting on something NAMED, the other on nothing.

### §253. The lanes: a component runs several pipelines at once

THE LANES — a component runs SEVERAL pipelines, and they are not stages of one another.

The software pipeline builds an artifact and syncs config; the infrastructure pipeline stands up the substrate underneath it. They have their own executors, their own source repos and their own release histories, and drawing them as one list of stages says a component has a single pipeline when it has two (owner, 2026-08-10: "Each component needs 2 pipelines: infra & software").

Lane membership is by ADR-0007 CATEGORY, which the server derives from the routing Type and sends on the wire — so this file holds no copy of the Type→Category map. `build` and `configuration` share the software lane because that is what `coordination-ui-views.md` §2's "App release" lane is: `Build & test` → `Image registry` → `Config bump` → the deploy stages.

BOTH LANES ALWAYS RENDER. A component with no infrastructure pipeline says so in words; leaving the lane out would make "no infra pipeline is declared" indistinguishable from "this view does not show infra", which is the distinction the whole page is built around.

### §254. THE ARTIFACT and its change-scoped facts (§9.3)

THE ARTIFACT and its change-scoped facts (§9.3) — optional on the wire for the same reason as `registry`. Three readings, and this file keeps them apart everywhere it renders one: `undefined` — an OLDER SERVER; nothing is known either way (the pre-§9.3 "not observed" copy); `null`      — the server SAYS no change of this component carries an artifact digest ("no artifact yet" — a stated absence); an object   — the pick, stated (`changeId`/`changeName`), and every fact read from it.

### §255. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — `undefined` = an OLDER SERVER, which never evaluated correlation and renders no section at all; an object (`changes` possibly empty) = evaluated. Unlike `artifact`/`observedRun`, the server never sends `null` here — evaluated-and-empty is spelled `{ changes: [] }`, not `null` — but the wire type still allows it (the same additive idiom `registry`/`artifact` use), so this reading keeps both apart.

### §256. The substrate facet values actually declared on a target

THE SUBSTRATE FACET VALUES that are actually DECLARED on a target, in the fixed order substrate · account · region · cluster — e.g. `["aws", "210987654321", "us-east-1", "prod-eks"]`.

Only PRESENT values are kept: null is an absence of a declaration, not an unknown observation, so it earns neither a `—` nor a badge (`ComponentPipelineStageSchema.deploymentTarget.substrate`). An empty string is treated the same way — there is nothing to show, and ` · aws` would draw a separator for a value that has no width. `name` is deliberately not in the input type: fixture names like `us-east-1-prod (k8s)` look parseable and are exactly the trap — every rendered value here is READ from the target's own declared properties, never derived from what it is called.

Exported for `component-pipeline-continuous.test.tsx`.

### §257. Which outpost this place is part of

WHICH OUTPOST THIS PLACE IS PART OF (pipeline-substrate-registry-scan.md §10.2, §10.5) — one quiet line in the compact part of every target tile, rendered from the server's STATED `outpost.state`, never from the target's name or its containment domain (GLOSSARY: containment has nothing to do with deployment topology). Five states, five sentences:

```text
- `outpost`               → `outpost <name> · <trustTier>` — a Link to that outpost's page on the
                            COMMANDER site only: the outpost pages are commander-managed — reachable
                            only from the commander's nav (AppShell gates the Federation › Outposts
                            entry on `instanceRole`; router.tsx registers the route everywhere) and
                            their writes are the commander's; plain text anywhere else. The tier is
                            appended only when the server read one (`null` = none declared, not
                            "commercial"). Since §10.5 (object-first resolution) this is ALSO what a
                            self-origin target reads once the HQ outpost (formerly "co-located";
                            GLOSSARY, ADR-0021 D7) is registered —
                            `peerDomainId` is then this instance's own domain, and the link opens
                            that record on the Outposts page (it renders the self-bound record).
- `self`                  → `this instance's domain — no outpost registered` — the STATED ABSENCE
                            of an HQ outpost (quiet; on the COMMANDER the title says how
                            to declare one: Federation › Outposts, `peerDomainId` = this
                            instance's domain; on any other `instanceRole` it says the record is
                            commander-declared and arrives replicated — the server 400s the self
                            shape from a non-commander, so no declare hint is offered there).
- `peer-without-outpost`  → `peer <name> — no outpost record`, quiet, with the way to fix it in
                            `title` (an outpost object is declared under Federation › Outposts).
                            The server states this ONLY for an `outpost`-role peer — the one kind
                            that door accepts.
- `peer-not-outpost`      → `commander <name>` / `relay <name>` (from the wire's `peerRole`; any
                            other role reads `peer <name> (<role>)`) — a paired peer that is NOT an
                            outpost, so there is no "missing record" and NO declare hint: the API
                            refuses an outpost record for it. On an outpost site this is every
                            commander-authored target.
- `unknown-domain`        → `origin domain not known here` — never "ours".
```

`instanceRole` is a PARAMETER (read by the page off `useAuth()`, threaded down like `laneNodes`'s) rather than a hook call here, so the test renderers stay provider-free. Undefined reads as "not known to be the commander" → plain text.

### §258. The declare hint is offered ONLY on the commander

The declare hint is offered ONLY on the commander: the server's self-shape door takes the write only from a commander-role instance (an outpost's own record is commander-declared and arrives replicated — `outpost-binding.ts`, measured in `outpost-config-sync.integration.test.ts`), so pointing an outpost operator at Federation › Outposts would guide them into a 400.

### §259. SITE SCOPE (owner rule, 2026-08-17)

SITE SCOPE (owner rule, 2026-08-17): "the global pipeline should have all things global; the outpost pipeline should only have things managed by that outpost — exceptions being domain-specific sources, along with the other source being the commander."

So on any NON-commander site the journey keeps only the stages whose target is part of THIS instance's own outpost — read off the wire's `stage.outpost` (the trust-domain rule, §10.2/§10.5: the outpost object naming the target's origin domain), matched against this instance's own trust domain (`GET /federation/self`.domainId): the target's `outpost.peerDomainId` equals it, or `outpost.state === "self"` when no record is declared for it yet. Commander-domain targets (their tile already reads `Outpost hq-outpost`) drop out here. Sources are untouched: the server already gives an outpost only its own mappings plus the opaque commander input, which are exactly the two exceptions the owner named. The COMMANDER site is never scoped — it shows every target it coordinates promotion to, each labelled with its outpost.

`instanceRole` and `selfDomainId` are PARAMETERS (read by the page off `useAuth()` and the self query) so the function stays pure and testable; nothing is inferred from names.

### §260. Rebuilds the single ordered pipeline from the response's two arrays

Rebuilds the single ordered pipeline from the response's two arrays.

`stages` and `unplacedStages` are disjoint and `order` is contiguous across their union, so this is a concatenate-and-sort with no inference — see `ComponentPipelineResponseSchema.unplacedStages` for why the wire splits them (widening `placement` to nullable is an oasdiff ERR).

Exported for `component-pipeline-continuous.test.tsx`: the rejoin is the one piece of real logic on this page, so it is tested directly rather than through the DOM.

### §261. Exported only for the test that renders it directly

Exported ONLY for `component-pipeline-continuous.test.tsx`, which renders it directly: the presentational contract (unknown-vs-blank, unbound-is-loud) is what that test owns, and rendering the whole page would drag in the query client for no added coverage. `pipelineKey` is optional and defaults to absent, same reason: a caller that never passes it (every pre-B2 test) gets the exact pre-B2 markup back, with no query client required — the remove-placement affordance (B2) only mounts, and only then needs `useMutation`'s context, once a caller opts in. `detailsExpanded` (§10.3) renders the tile with its Details disclosure OPEN (`true`) or shut (`false`); omitted, the tile follows the page default (collapsed) exactly as production does.

### §262. WHO MAINTAINS THIS PLACE

WHO MAINTAINS THIS PLACE — shown on every stage, placed or not.

The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner, 2026-08-04) — ADR-0017 §2 devolves execution to the originating outpost and leaves the commander owning only the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy inside its own domain. A stage drawn with no domain on it invites the reading that the commander deploys it, which is the one thing charter principle 1 says it does not do.

An UNKNOWN domain renders as unknown rather than as ours: on a replica whose peer row has not arrived, claiming a place is maintained here would be the exact misreading this exists to stop.

### §263. Deployment outcome -> §1.5 tone, with the ADR-0028 hold override

Deployment outcome -> §1.5 tone, with the ADR-0028 hold override (#226): a held target's raw status IS `pending`, and saying so is the bug — here "pending" would mean not "the wave has not reached this stage" but "the wave IS here and something named is withholding it". The hold takes the headline (`held`, info tone — waiting, not wrong); the raw column stays on the wire and in the Deployment row below. Otherwise: in-flight/unrecognised is `warning`, and "never deployed" is `neutral` — a real and ordinary state, not an alarm.

### §264. WHAT IS WITHHOLDING THIS STAGE'S RELEASE

WHAT IS WITHHOLDING THIS STAGE'S RELEASE — a subnode of the stage, beside its entry gate.

A subnode rather than a node of the pipeline, for exactly the reason the gate is one: this is a condition on entering ONE place, not a step the release passes through on its way somewhere.

IT NAMES THE DEPENDENCY, which is the entire point of the increment. A badge saying only "held" would move the operator from "why is this pending?" to "why is this held?" and no further, and the answer is not discoverable from anywhere else on this page. Each line is the server's own `describeStageDependencyHold` sentence — the same one the hold Decision's `reasonTree` carries — so the page and the audit record cannot describe the same verdict differently.

The dependency renders by NAME with the id only as a tooltip, and falls back to the id when the server sent no name (a deleted component, or an `undeclarable` entry whose raw JSON never had an id to resolve). It is never an id dressed up as a name.

### §265. THE REMOVE-PLACEMENT CONFIRM'S COPY

THE REMOVE-PLACEMENT CONFIRM'S COPY (B2) — exported for the same portal reason as `DeleteMappingConfirmBody`. Names the actual consequence rather than a euphemism: the component loses this stage (no release reaches it until placed again), and states the coordination/ execution boundary explicitly (charter principle 1) — removing the placement withdraws SCP's OWN coordination record, it does not touch whatever is already running at the target.

### §266. An unbound placement fake-succeeds under compilation

An unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a)). It must be loud, not absent. Gated on the WHOLE stage, not on this lane: a stage with a software pipeline and no infra one is ordinary (its substrate is managed elsewhere), while a stage bound to NOTHING is the alarm. Also never gated on `binding`, which is merely `bindings[0]` — reading it would be the same mistake this file just stopped making.

### §267. The wave target's status is the outcome at this place

`change_wave_targets.status` IS the deployment outcome at this place. The arrow into the stage already uses it for colour; showing it in words is what makes "deployed and succeeded" distinguishable from "deployed and failed" without reading a colour.

The RAW value is kept even when held — this row is the one place the column is reported verbatim, and a held target really is `pending` — with the reason appended rather than substituted, so the two facts stay separable. Reading `pending` here and nothing else was the whole defect.

### §268. PLACE AT TARGET

PLACE AT TARGET (B2, docs/proposals/outpost-ui.md §4) — the affordance that replaces the formerly-inert "Declare a placement…" prose. Two call sites, two shapes of the same picker:

```text
- `UnplacedStageCard` already knows its own `deploymentTarget` (that IS the stage), so it
  pre-selects it — the picker still lists every target, because an operator opening it here
  may want a DIFFERENT one, but the common case is one click.
- The whole-page empty state (`pipeline-empty`) knows no target at all, so it opens blank.
```

Closed by default (just the button) — the list of deployment targets is fetched lazily (`enabled: open`) so a page with several unplaced stages does not fire the query once per card.

### §269. A DECLARED STAGE THIS COMPONENT NEVER REACHES

A DECLARED STAGE THIS COMPONENT NEVER REACHES.

Greyed and dashed so it reads as an outline of a stage rather than a stage, and it says "not placed" in words — the colour alone would be indistinguishable from "quiet". It deliberately shows NO executor row, NO version row and NO last-release row: those are keyed on a placement that does not exist, and an empty "Executes" line here would read as the ADR-0006 case (a) alarm ("bound to nothing, would fake-succeed") over what is only an absence of a placement.

### §270. The arrow into a wave, coloured by what it can claim

The arrow INTO a wave, coloured by what that wave can honestly claim.

Exported for `component-pipeline-continuous.test.tsx`: the precedence ladder is a contract, and a new state has to be PLACED in it deliberately rather than fall through to whatever is left.

### §271. THE NODES OF ONE PIPELINE, in the order the GLOSSARY defines them

THE NODES OF ONE PIPELINE, in the order the GLOSSARY defines them.

> **pipeline.** The ordered path a release travels for one executor Type — **build → registry → > config → gamma → prod** for a software pipeline; **plan → gate → apply** for an infrastructure > pipeline. (docs/GLOSSARY.md)

So a pipeline is a CHAIN OF NODES, not a list of deploy stages with some metadata attached: the source repo is a node, the registry is a node, each deploy stage is a node. Rendering the repos as a sidebar of one card said they were context for the pipeline rather than the first step of it.

Two nodes are deliberately CONDITIONAL, because drawing them unconditionally would draw steps that nothing runs:

```text
- **build** appears only when this component actually has a build pipeline (a `build`-Category
  binding or source rule). All 148 source mappings on the live estate are `configuration`, so
  for most components today the software pipeline genuinely starts at a config change, and a
  permanently-empty "Build" box would be decoration.
- **registry** appears when the component builds here OR when a registry is DECLARED here
  (`data.registry.state !== "none"` — pipeline-substrate-registry-scan.md §9.2): an outpost
  builds nothing, but its registry still receives the promoted image, and leaving the node out
  there would say the image lands nowhere. The node carries the per-site `registry` fact so
  `RegistryNode` can NAME it; its body is the latest artifact digest when §9.3 projected one,
  else the explicit "no artifact digest recorded yet" — the same unknown/absence-not-blank rule
  the version cell follows.
- **scan-sign** (§9.3, owner §7.2) appears ONLY on the COMMANDER — the scan at source is what
  authorises a cross-boundary transfer (ADR-0013), and the commander alone signs a promotion
  manifest; an outpost neither scans at source nor signs, so drawing the node there would claim
  a step this site never performs. It sits after Registry and before Config, and is drawn where
  a registry node is (something produces or receives an artifact here) or where an artifact is
  already projected — a software lane that starts at a config change and holds no artifact
  would otherwise carry a permanently-"no artifact yet" box, the same decoration argument that
  keeps Build conditional. `instanceRole` is a PARAMETER (read by the page off `useAuth()`, the
  way `router.tsx`/`AppShell.tsx` do) so this stays a pure function the tests can drive.
```

### §272. Builds one lane's node chain

Builds one lane's node chain. Exported for `component-pipeline-continuous.test.tsx` — which nodes appear, and in what order, is the contract this view now IS. `registry` and `artifact` are optional on the wire (older servers), so a caller may omit them: the pre-§9.2 chain then comes back unchanged. `instanceRole` omitted/undefined reads as "not known to be the commander" — the Scan & sign node is never drawn on a guess.

### §273. Whether the lane's shared connector before a node draws

Whether the lane renderer's SHARED connector before `nodes[i]` should draw. A "source" node now fans in: each of its tiles carries its own `PromotionArrow` beneath it (owner, 2026-08-14), so the shared connector immediately after it would be an EXTRA arrow, not the transition's only one — suppressed here so a source's transition is drawn exactly once, at the tile(s). Every other adjacent pair is untouched: `i > 0` is still the whole rule. Exported so the suppression itself is assertable without standing up the fetching page around it.

### §274. THE HEAD OF A LANE

THE HEAD OF A LANE — the repos a push to which releases this component through this pipeline.

This is the durable RULE (`source_mappings`), not release history, so it answers "does a change there affect this?" for a component that has never released — the same property the stages have.

### §275. A node's link OUT of CommanderSCP

A node's link OUT of CommanderSCP — to the repo, the Argo CD application, the Actions tab.

`href` is null whenever the server could not KNOW the address (see `console-urls.ts`), and the label then renders as plain text. That is the whole contract: a node is clickable exactly when there is somewhere real to go, so a link never has to be tried to find out.

`rel="noreferrer"` because these are operator-configured URLs pointing at systems outside this app; `target="_blank"` because losing the pipeline view to navigate to Argo CD is a bad trade.

### §276. PIPELINE NODE ICONS

PIPELINE NODE ICONS — one distinct glyph per node KIND, from the lucide vocabulary (design spec §1.6/§4C's kinds map; the hand-rolled inline SVG set this replaces is gone — one icon system).

Every node previously rendered as an identical white rectangle, so the chain read as a stack of boxes and the KIND of each step was carried only by its title text. The glyph is what makes "repo, build, registry, deploy" legible at a glance (owner, 2026-08-10). The `data-node-icon` attribute is the distinctness contract `component-pipeline-continuous.test.tsx` pins.

### §277. TILE DENSITY (§10.3, owner)

TILE DENSITY (§10.3, owner) — every pipeline tile is a COMPACT part plus a Details disclosure.

The compact part is identity + state (what the tile IS, and the one-line verdict of where it stands); everything else the tile knows moves UNDER "Details", collapsed by default. Nothing that rendered before this became unreachable — it moved. Two controls drive the state:

```text
- the page-level Expand all / Collapse all (`TileDetailsScope`, near the lane header): each
  flip publishes `{ expandedAll, version }` through `TileDetailsContext`, and every tile follows;
- each tile's own chevron (`TileDetails`): a LOCAL override, remembered with the `version` it
  was made under, so it wins until the next page-level flip bumps the version — at which point
  the page-level state wins again. Local to the page: nothing is persisted (no localStorage).
```

The disclosure is a native `<button>` (Enter/Space toggle for free) with `aria-expanded` and `aria-controls` naming the region; the region mounts its children ONLY while open, so a collapsed tile's markup genuinely holds the compact set and nothing else — the property the static-markup tests assert. A tile with nothing to put under Details renders NO toggle at all (`NodeShell` draws it only when `details` is given).

### §278. The page-level control plus the context it drives

The page-level control plus the context it drives. Exported for the tests, which render tiles under it and click the control — the same component the page mounts, so what the test flips is what the operator flips.

### §279. A node's REVIEW affordance

A node's REVIEW affordance (§9.3, owner §7.2: "clickable only once the fact exists"). When `review` is given the tile IS a click target — a `Review` button in its header carrying the `aria-label` the tests pin, and the card body opens the same dialog on click (links and other buttons inside keep their own behaviour). When it is omitted there is NO affordance at all: no button, no pointer, no hover — a tile with nothing to review must not look like one that has.

### §280. THE CHANGE-SOURCE KINDS THIS PAGE OFFERS

THE CHANGE-SOURCE KINDS THIS PAGE OFFERS (A1, docs/proposals/outpost-ui.md §3). `sourceKind` is an open string on the wire (`ChangeSourceEventParamSchema` is `z.string().min(1)`) — but only these three carry a signature verifier in the webhook-adapter registry (`apps/server/src/coordination/webhook-adapters.ts`'s `ADAPTERS`), so offering a fourth here would create a mapping whose deliveries can never authenticate (falls back to the generic HMAC scheme, which is a real but DIFFERENT configuration step, not "this kind works out of the box").

### §281. Shapes the `POST /change-sources/{sourceKind}/mappings` body

Shapes the `POST /change-sources/{sourceKind}/mappings` body — pure so the omit-blanks rule is testable without a live mutation. Optional patterns are OMITTED, never sent as `""`: the schema distinguishes "no filter" (omitted) from an actual empty-string pattern, and a blank input means the operator left the field alone, not that they declared an empty rule. `type` is always sent, deliberately — the whole point of A1/A2 is that "which pipeline" stops being a silent default.

### §282. ADD SOURCE MAPPING

ADD SOURCE MAPPING (A1) — offers exactly `CreateSourceMappingRequestSchema`'s fields, minus `component`: this page already IS the component, so asking for it again would be asking the operator to re-type something the URL already answers. `sourceKind` is a path segment on the wire, not free text — see `SOURCE_KINDS`.

### §283. Shapes the `DELETE /change-sources/{sourceKind}/mappings` body

Shapes the `DELETE /change-sources/{sourceKind}/mappings` body — the full IDENTITY TUPLE (`DeleteSourceMappingRequestSchema`'s own doc: the table has no unique constraint, so a by-id delete would leave a byte-identical survivor still correlating). Pure, so the tuple-not-id claim is testable without a live mutation.

### §284. THE DELETE CONFIRM'S COPY

THE DELETE CONFIRM'S COPY — exported so the honesty claim is assertable directly (Radix's `DialogContent` portals its children, which render nothing under `renderToStaticMarkup`; see `domain-local.test.tsx`'s precedent). States the server's actual behavior rather than a comfortable simplification: EVERY row matching this tuple goes, including duplicates `discovery accept` can leave behind, and there is no edit — only delete and recreate.

### §285. A disabled mapping is a declared rule, not a deletion

A disabled mapping is a DECLARED rule the correlation matcher skips, not a deleted one (owner, 2026-08-14: "a toggle is theatre" unless something downstream honours it — migration 0063's `matchComponentForSource` is that something). Reads `!== false` rather than a bare `!source.enabled` so a value this component genuinely never received (an older cached response, a hand-built test fixture) still reads as enabled rather than silently muting every tile on the page.

### §286. §9.3a (owner, 2026-08-14) — ONE pipeline, mixed-provenance inputs

§9.3a (owner, 2026-08-14) — ONE pipeline, mixed-provenance inputs. When another domain maintains this component (on an outpost: the commander), the commander is an OPAQUE PEER INPUT to this pipeline: its shared repos (ASGs, instance types, …) are known only there — this domain never learns them and must not pretend to. Alongside it, this domain's own mappings are its DOMAIN-SPECIFIC inputs (network config, CIDR bands that stay in-domain), tracked only here. Domain-local component: no commander input at all — its repos are the whole source. A domain-local component cannot have a commander input by construction (it never journaled), so the data and the rule agree; the UI states the shape rather than deciding it.

### §287. ONE TILE PER SOURCE

ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile — commander and outposts alike"). This mirrors what the wave side already does — one StageCard per target, side by side under a wave label — so a lane reads as a chain of tiles at BOTH ends: N source tiles → build → registry → M target tiles per wave. Grouped by declared provenance (mirror-of-shared before domain-specific), each tile carrying its own provenance eyebrow, so three kinds of input read as three tiles rather than one list. §10.6 (owner, 2026-08-16): the eyebrow is READ off each mapping's own `scope`/`mirrorOfShared` and renders on EVERY site — the commander's included (it used to hide unless a commander input or a domain-local component was present, which left the commander's own global sources unlabelled). No site-role inference: an undeclared scope renders NO eyebrow anywhere.

### §288. The source-side twin of an unplaced stage

The source-side twin of an unplaced stage: no push to any repo can start this pipeline, so it only ever runs if someone raises a change by hand. Still carries its own downward arrow (fan-in of one, drawn even when the "one" is empty) so the chain never reads as having stopped here — a domain-local component with zero mappings (rare, ADR-0031) omits the card itself but keeps the connector, since it has no "no repo mapped" claim to make.

### §289. THE COMMANDER AS AN OPAQUE INPUT

THE COMMANDER AS AN OPAQUE INPUT — its own tile, named from maintainedBy (name null = origin matches no known peer; say the id rather than guess). Deliberately NO repo, host, path or ref: this domain does not know them, and a tile that showed any would be an invention. Its own fan-in arrow too (owner, 2026-08-14: "each source should have its own arrow") — plain `pending`, since there is no per-mapping enable/disable concept for an input this domain does not own.

### §290. The declared provenance of ONE mapping, READ off its own fields

The declared provenance of ONE mapping, READ off its own fields (§10.6, outpost-ui.md §9.3a) — never off the site's role or the component's upstream: "mirror" — `mirrorOfShared`: a local copy of a commander-shared repo (wins over `scope`, since a `domain`-scope mapping may mirror a global one and the mirror is the more specific fact); "global" — `scope: "global"`: shared across domains, tracked at the commander; "domain" — `scope: "domain"`: tracked only in this domain; null     — scope NOT DECLARED and not a mirror: NO eyebrow, nothing inferred (the tile's title says how to declare it). `scope` is read as possibly-absent DEFENSIVELY: through the SDK it never is (`ComponentPipelineSourceMappingSchema.scope` is required-nullable and the generated client validates every response body, ADR-0023 — a pre-0066 server's body is a contract error at the boundary, not a tile), so the widening only keeps a hand-built source from throwing here. Exported for the test file only.

### §291. ONE SOURCE TILE

ONE SOURCE TILE — one repo rule, its own card, sitting beside its siblings in the source row, and (owner, 2026-08-14) its own downward arrow beneath it: `tile, then arrow` in one column, so N tiles read as N converging fan-in lines rather than one shared connector for the whole row. `provenance` is the declared kind — see `sourceProvenance` above (§10.6): "mirror" | "global" | "domain" | null (undeclared — no eyebrow, and the card's title says how to declare one). The row body below is the pre-existing per-mapping rendering, unchanged — every testid it carried still carries.

### §292. THE ARROW IS THE SWITCH

THE ARROW IS THE SWITCH (owner, 2026-08-14). The mapping's own fan-in arrow carries its enable/disable: click flips it, colour states it — green = open (a push matching this rule starts a release), shut slate = closed (declared, routes nothing). The mutation lives here so the arrow stays a dumb renderer; a server refusal renders as an Alert after the click, never as a pre-disabled control (M16.3's rule). NOT one click (owner, 2026-08-14: "it shouldn't be one-click to enable/disable"). The arrow OPENS A DIALOG. Closing offers a choice — for a period, or until re-opened by hand — and confirms; opening confirms too. Enabled is the default; a routing rule is not something to flip by a mis-click. The dialog owns the mutation; the arrow stays a dumb renderer.

### §293. THE OPEN/CLOSE DIALOG

THE OPEN/CLOSE DIALOG (owner, 2026-08-14) — the confirmation every flip goes through.

CLOSING asks two things: for how long (a period, after which the rule opens again automatically — evaluated at read time like a freeze window, no timer job — or until re-opened by hand), and then a confirm that names the consequence: while closed, a push matching this rule starts no release. OPENING is one confirm, naming what re-opens. Both are one deliberate click past the arrow, never zero. Server refusals render inside the dialog, at the point of action.

### §294. The dialog's CONTENT, portal-free

The dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under renderToStaticMarkup, even when open; same reason domain-local.tsx exports PublishConfirmBody). Owns the duration choice; the confirm is the ONLY thing that fires the mutation.

### §295. The projection's STATED unknowns

The projection's STATED unknowns (§9.6 — `artifact.unknownFields`): a stored value that does NOT parse is neither a present fact nor a stated absence, and the tiles must never render an absence ("no SBOM reported", "not signed yet") over an unreadable presence. Two flags exist today (`artifact-facts.ts`): `sbom:unparseable` — `sourceRef.sbom` is set but is not an `SbomRef`; `promotionExports:unparseable` — at least one stamped export record does not parse. First-party ingress cannot write either (a malformed report ref is quarantined), so what reaches here is a sourceRef written by a different version or imported through federation — exactly what the flag is on the wire for.

### §296. §10.4 — the IMPORTED promotion manifest, or null

§10.4 — the IMPORTED promotion manifest, or null. `signing.importedManifest` is OPTIONAL on the wire (an older server omits it) — undefined and null both read "none here", so a pre-§10.4 server states the same absence a post-§10.4 outpost that imported nothing does.

### §297. A BUILD NODE

A BUILD NODE — what turns the source into an artifact. Hoisted out of the deploy stages: a build happens once per release, not once per place, whatever scope its binding happens to hang off.

§9.3 (owner §7.2), narrowed by §10.1: ONE artifact fact hangs under the executor line — the SBOM, a BUILD-TIME fact: the reference the first-party change report carried (`sourceRef.sbom`; SCP never generates one and stores no bytes), or "no SBOM reported for this artifact" — or, when the projection STATES `sbom:unparseable`, "recorded but unreadable" (never an absence over an unreadable presence; `sbomUnparseable`).

THE PROMOTION MANIFEST IS NOT HERE (§10.1, owner). The code's export order is scan step → E6 gate → build manifest → sign manifest (promotion-repo.ts phases 1.5–3): the PM is created AFTER the scan and BEFORE the signature, so it is a Scan & sign fact and lives on that tile (`ScanSignCompact`, between the E6 line and the signed line). The tile is clickable ONLY when an SBOM exists (`buildHasReview`); the review dialog renders the SBOM alone.

### §298. §3 Segment 2's "upstream build" marker

§3 Segment 2's "upstream build" marker (component-journey-view.md) — omit the prop entirely (as `BuildNodeForTest`'s callers that predate it do) to mean "older server", the same undefined-vs-null-vs-object reading every other §9.3 field on this tile follows. Rendered ONLY in the upstream case (`bindings.length === 0`) — a coordinated build already names its own executor line above, so drawing this too would be two answers to "where does the build run?"

### §299. component-journey-view.md §3 Segment 2's "upstream build" marker

component-journey-view.md §3 Segment 2's "upstream build" marker — "GitHub Actions · CI · run 30858160395 ↗", never "build: unknown". Every word left of the dots is server-composed and rendered VERBATIM; the dots themselves are the only invented copy. Linked to `observedRun.url` when the server named one; plain text (no affordance invented) when it did not — the `object_ attributes` GitLab webhook shape names a run with no citable url (see `observed-run-facts.ts`). The title tooltip carries `observedAt` in the viewer's LOCAL clock (the `toLocaleString()` idiom this file already uses for every other timestamp it surfaces to a person).

### §300. The Build review dialog's CONTENT, portal-free

The Build review dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under renderToStaticMarkup; same reason `SourceOpenCloseBody` is exported). Every field is the stored value VERBATIM: the SBOM reference as reported. The promotion manifest is reviewed on the Scan & sign tile (§10.1, `ScanSignReviewBody`), not here.

### §301. A REGISTRY NODE

A REGISTRY NODE — where the built artifact lands, and what promotion advances by digest.

The HEADER names the registry this component publishes to AT THIS SITE, read off the response's `registry` (pipeline-substrate-registry-scan.md §9.2 — the component's `publishes_to` edge to a domain-local execution-system, never the `image` executor binding, whose Type says what BUILDS the artifact rather than where it lands). Three states, each STATED rather than chosen:

```text
- `declared`  — `name (kind) · repository`, the name a console link to the registry's base URL
                when the server knew one (base only: no registry deep-link shape is known here,
                and a guessed path is a lie);
- `ambiguous` — more than one `publishes_to` edge. The server does not pick, so neither does
                this node: it says how many, in the design system's amber "operator should
                notice" tone, and the tooltip says what to do about it;
- `none`      — "no registry declared for this component here". An absence, not an unknown —
                the node only appears in this state because the component BUILDS here.
```

A null/absent `registry` is an older server; the header then falls back to the pre-§9.2 sentence.

The BODY is the latest artifact digest (§9.3): the last digest the picked change's `sourceRef` lists, folded with the full value in `title`, and WHICH change it came from. Absent, it says so — "no artifact digest recorded yet" when the server projected `artifact` and found none (a stated absence), or the pre-§9.3 "not observed" when the field is not on the wire at all (an unknown).

### §302. The imported promotion manifest lives on the registry tile

§10.4 — the IMPORTED promotion manifest lives HERE, on the Registry tile of a non-commander site: the registry is where the promoted artifact lands, and the manifest is what it arrived under. The wire carries `artifact.signing.importedManifest` (the importer's stamped `sourceRef.promotionManifest` + `manifestSignature`, verified AT IMPORT by construction — import refuses an unverified bundle), so present it is a compact line — `arrived under a manifest signed by <exporterName ?? exporterDomainId> · N artifacts · verified at import` — and the tile becomes REVIEWABLE (header Review → the manifest fields verbatim). Absent it is a stated absence under Details, and only off the commander: the commander imports nothing (its OWN manifest is on Scan & sign), so it says nothing about imported ones. A STATED unknown on the wire (`importedManifest:unsigned` / `:unparseable`) is neither — it renders as "manifest recorded but unsigned/unreadable" wherever the wire says it, because an unreadable presence must never read as an absence.

### §303. The Registry review dialog's CONTENT, portal-free

The Registry review dialog's CONTENT, portal-free — exported for the test (Radix portals nothing under renderToStaticMarkup). Every field is the stored value VERBATIM: the imported manifest as the importer stamped it (§10.4 — manifestVersion, createdAt, exporterDomainId + the peer's name, peerDomainId, changeUrn, importedFromDomain, artifacts[] type/digest/signatureRef), the signature's presence, and — should the wire state one — the `importedManifest:*` unknown as a note. Nothing is re-verified here; the "verified at import" claim is the importer's (it refuses otherwise) and is made ONLY of a present signature — the wire type admits an empty string (today's server turns one into null + `importedManifest:unsigned`), and an absent signature must never read verified.

### §304. THE SCAN & SIGN NODE (§9.3, owner §7.2)

THE SCAN & SIGN NODE (§9.3, owner §7.2) — the commander's scan AT SOURCE, which is what authorises a cross-boundary transfer (ADR-0013), and the promotion manifest it SIGNS at export (§9.4). Two independent "not yet" facts, each stated on its own line, never merged into one status.

States, top to bottom: - artifact `null`  → "no artifact yet — nothing to scan"; - no scan rows     → "not run — no scan result recorded for <digest>"; - rows             → one per (scanner, digest): `scanner version · digest · status · C H M L · when`, the commander's own managed step marked "managed" (the wire's ONE discriminator; never inferred from the scanner); then "export gate (E6): pass|fail|not run" (E6's own predicate, applied read-only), then the PM line (§10.1 — the manifest is BUILT after the gate and BEFORE the signature, promotion-repo.ts phases 1.5–3, so it reads in that order): "PM created for <peer> · <when> · N artifacts" from the NEWEST export, or "PM not created — created at export to a peer", or the unreadable-stamp wording; then the sign lines — one per export "manifest signed for <peer> <when> (key <fp>)", or "not signed yet — the promotion manifest is signed at export to a peer" — and the origin-signature line, "not recorded" unless a `signatureRef` exists (SCP never signs an origin artifact, ADR-0015). Clickable ONLY when a scan row or an export exists (`scanSignHasReview`); the review dialog holds the full tables and a link to the change for the raw evidence. No CVE rows anywhere: none are stored (§8 "Scan").

§10.3 splits the above into the COMPACT part (`ScanSignCompact`: `scan: <verdict>` folding the rows, the E6 line, the PM line, `signed: …`) and the Details (`ScanSignDetails`: the scan rows or the not-run line, the per-export sign lines or the stated absence, the origin-signature line). With no artifact there is one stated line and no Details.

### §305. The scan rows folded to ONE verdict word for the compact line

The scan rows folded to ONE verdict word for the compact line (§10.3): `not run` with no rows, `pass (N runs)` when every row passed, `fail (…)` when any row failed or timed out, else the rows' own statuses counted (`warning (1 with warnings · 1 passed)`). A summary of the ROWS, read from each row's `status` verbatim — never of E6, whose verdict is the wire's own and has its own line. Exported so the folding is assertable on its own.

### §306. The COMPACT part of the Scan & sign tile (§10.3)

The COMPACT part of the Scan & sign tile (§10.3) — with an artifact, FOUR one-liners in the export order: `scan: …` (the rows folded, `scanSummary`), `export gate (E6): …` (the wire's verdict), `PM …` (§10.1, the newest export), `signed: …` (the newest export's signature, or the stated absence). Without one, the single stated line and nothing else — and no Details.

### §307. The DETAILS of the Scan & sign tile (§10.3)

The DETAILS of the Scan & sign tile (§10.3): the scan rows (or the "not run" line naming the digest), the per-export sign lines (or the stated absence), and the origin-signature line — everything the compact lines fold, in the same scan → sign order.

### §308. The Scan & sign review dialog's CONTENT, portal-free

The Scan & sign review dialog's CONTENT, portal-free — exported for the test. A scan table with every `ScanRunSummary` field (threshold as its JSON when present, digest match, managed), then the PROMOTION MANIFEST(S) verbatim (§10.1 — manifestVersion, createdAt, exporterDomainId, peer, changeUrn, artifacts[] type/digest/signatureRef, per export), then an exports table (what was signed: checksum, key fingerprint, signature presence), and a link to the change's detail page, which renders every control run's raw evidence JSON (`change-detail.tsx`) — the one place the underlying rows live.

### §309. THE GATE INTO A STAGE

THE GATE INTO A STAGE — what must pass before a release may move here.

A REQUIREMENT, not a verdict: it is resolved from durable `policy` objects, so it renders for a component with nothing in flight. A verdict belongs to a change and carries a `decision_id`; the change-scoped pipeline view owns that.

"No automated checks" is stated OUT LOUD rather than left blank. Measured 2026-08-10, every live policy has an empty `requireControls` and the estate holds 0 control bindings and 0 control runs — so a silent gate node would be indistinguishable from a view that cannot see checks, when the truth is that none are configured.

### §310. THE ENTRY GATE OF ONE STAGE

THE ENTRY GATE OF ONE STAGE — a SUBNODE of the stage, not a node of the pipeline.

A gate is not a step a release passes through on its way somewhere; it is a condition on ENTERING one place. Drawn as its own full-width node it doubled the length of every pipeline and implied the release stops somewhere between two stages, which is not where it stops — it stops at the door of the next one (owner, 2026-08-10). Attached to the stage it governs, it also stops needing to merge several placements' policies into one wave-level gate: each target keeps its own.

Resolved from the `policy` objects matching this placement (DESIGN §10.1) — the SAME resolution the wave-boundary gate runs, so this view cannot disagree with the engine about what is required. It is a REQUIREMENT, not a verdict: a verdict belongs to a change in flight and carries a `decision_id`.

"No automated check" is stated rather than left blank. Measured 2026-08-10: every live policy has an empty `requireControls`, and the estate holds 0 control bindings and 0 control runs — so a silent gate would be indistinguishable from a view that cannot see checks, when the truth is that none are configured.

### §311. A CHECK'S STATE, as a mark PLUS a word

A CHECK'S STATE, as a mark PLUS a word — never a mark alone.

The two absences are what a naive rendering loses, and they are the whole point: `not_started` means nothing is at this gate for the check to run against; `pending` means a release IS here and the check has not reported. One is idle, the other is the thing you are waiting on. A single grey dot for both is exactly the confusion this view exists to remove.

WHY NOT A PROGRESS BAR: there is no progress to draw. `control_runs.status` is terminal (pass | fail | warning | skipped | timed_out | expired) and a control that has not reported has no row at all — no start time, no percentage, no expected duration. A bar filling up would be an animation over a number SCP does not have.

### §312. THE ENTRY GATE AS ONE LINE

THE ENTRY GATE AS ONE LINE (§10.3) — the compact form of `GateSubnode`, which keeps the full per-check list under Details.

`entry gate: none — enters as soon as the previous stage succeeds` when no policy gates the stage; else `entry gate: N checks · <counts by status> [· approval required]`. The current UI has NO aggregate verdict for a gate (each check carries its own mark), so none is invented here: the line says how many checks and how many are in each state, coloured by the same precedence the per-check marks use (a failure red, a warning amber, all passed green, else quiet). "approval required" is appended whenever a policy asks for one, so an approval-only gate does not read as `0 checks` and nothing else.

### §313. Placed somewhere the topology never mentions. Real state

Placed somewhere the topology never mentions. Real state — hidden by neither the server nor here — but honestly separated from the declared journey, which is the ordered part.

The label must carry the ORDER claim, not just the membership one (owner, 2026-08-14: "why would we deploy to gamma and prod in parallel?"). Several targets side by side read as one wave that fans out — which is a real and legitimate thing (us-east-1-prod ∥ us-west-1-prod) — so a row that is NOT a wave has to say it is not: these are places the component is placed, with no declared ordering among them.

### §314. THE PROVENANCE SENTENCE

THE PROVENANCE SENTENCE (owner decision, 2026-08-24) — server-composed facts, plain-English sentence, verbatim per the design system's copy rule. Reads `entry.correlatedVia` alone: the PRIMARY route decides the sentence even when `coupledKey` is also set (a change can match BOTH a place and a coupling — the place is the more specific fact, so it is the one said out loud).

### §315. THE CORRELATED-INFRASTRUCTURE SECTION

THE CORRELATED-INFRASTRUCTURE SECTION (owner decision, 2026-08-24) — infrastructure lane ONLY (never rendered on the software lane, and the caller below never mounts it there). Absent vs empty (design system §"honesty-copy rules"): `undefined` renders NO section at all (an older server never evaluated this); an evaluated `{ changes: [] }` renders the section with one quiet line, because "we looked and found none" is a different, honest fact from "we never looked".

### §316. Which site this is, from the install-time instance role

WHICH SITE THIS IS — the install-time `instanceRole` off `/auth/me`, read the way `router.tsx` and `AppShell.tsx` read it (§8 "Commander-only signal"). It decides whether the Scan & sign node is drawn at all and whether a target tile's Outpost line LINKS to the outpost page (§10.2 — that route exists only on the commander site). Deliberately NOT `component.maintainedBy.role`, which is the object's origin, not this instance's role.

### §317. A connector is a verdict only where one exists

Between two nodes, the connector is only a verdict where the model HAS one: a promotion into a deploy stage. Everywhere else it is a plain link, because colouring build→registry green would invent a gate nobody evaluated. A "source" node draws its OWN arrow per tile instead (`sharedConnectorVisible`), so this one is skipped right after it rather than adding a duplicate.

## `apps/web/src/routes/connect-argocd.test.tsx`

### §318. The two wizard guarantees that must hold on every step

M19.1 — the two "Connect Argo CD" wizard guarantees that must hold on EVERY PR, with no browser and no server. The Playwright spec (`e2e/connect-argocd.spec.ts`) proves the flow works against a real server and a fake Argo CD; it runs in CI job 9, which is minutes and a compose stack. These are the two claims that would be silently wrong rather than loudly broken, so they belong in the unit job:

```text
(b) THE CREDENTIAL LEAVES BY ONE DOOR. Proven by SEARCHING FOR THE TOKEN, not by reading the
    code: a sentinel is typed and submitted, then asserted ABSENT from the query cache, the
    mutation cache (where `mutate(vars)` would have parked it), the rendered markup and the
    URL — while `putSecret` is asserted to have RECEIVED it, so the test cannot pass by way of
    a token that never existed. That anti-vacuity half is the point: "the token is nowhere" is
    trivially true of a form that never captured one.
```

```text
(c) THE ORPHAN NOTICE FOLLOWS THE DATA. `discovery accept` creates components and bindings but
    no relationships, so the success screen must not imply a graph link that is not there —
    AND must not hardcode that absence, because the day the plugin emits relationships a
    hardcoded "not part of any service" becomes the lie instead. Both directions are asserted.
```

MUTATION LOG (each applied alone against this file, then reverted):

| Mutation | Result |
| `mutationFn: async (vars) => …` + `register.mutate(draft)` (the token as mutation variables) | token-in-mutation-cache FAILS | | drop `setDraft(prev => ({...prev, token: ""}))` from `onSuccess` | token-in-markup FAILS | | `type="password"` -> `type="text"` on the token input | the password-input case FAILS | | `relationships === 0` -> `true` (always show the orphan notice) | the non-zero case FAILS | | render a literal `0` for the relationship count | the non-zero case FAILS | | `...(draft.allowInternalEgress ? {allowInternalEgress: true} : {})` -> always `true` | the unchecked-checkbox case FAILS | | `putSecret` after `createExecutionSystem` | the ordering case FAILS | | `config: {executionSystemId, serverUrl}` in `sdkDoors.runDiscovery` | the "only the system id" case FAILS |

### §319. THE ORPHAN-NOTICE PAIR IS GONE WITH `ImportSummary`

THE ORPHAN-NOTICE PAIR IS GONE WITH `ImportSummary` (ADR-0047).

Both cases asserted that the post-import screen told the truth about components the accept path had just created without a service — the notice appeared when no relationships were written and stayed away when they were. There is no post-import screen now, and no component can be created without a service: the scaffolder refuses to EMIT one, so the state those cases described is unreachable rather than merely unreported.

What replaced them is `scaffold-panel.test.tsx`'s ungrouped case, which asserts the same concern one step earlier — at authoring time, where ADR-0047 moved it.

## `apps/web/src/routes/connect-argocd.tsx`

### §320. `/connect/argocd` — the M19.1 "Connect Argo CD" wizard

`/connect/argocd` — the M19.1 "Connect Argo CD" wizard (P5 of `docs/proposals/import-existing-executors.md`; ADR-0002 Mode A "point SCP at the execution system I already run").

WHY IT EXISTS. P1–P4 shipped the entire backend in July, and `scp connect argocd` wraps the flow — so the single thing a fresh install most needs to do first is reachable only from a shell, with a PAT and three commands. This is the same flow with a form in front of it.

IT IS UI-ONLY, DELIBERATELY. Every step already has a public door: `secrets` → the generic `object("execution-system").create` → `discovery.run` → `discovery.accept`. No API change, no migration, no `pnpm gen`, no oasdiff exposure. `scp connect argocd` (`packages/cli/src/cli.ts`, `connectCmd`) is the reference implementation and this mirrors its real flags — `--url`, `--token`, `--name`, `--token-key`, `--allow-internal-egress` — rather than inventing a second shape for the same act.

THE THREE THINGS THIS FILE EXISTS TO GET RIGHT

1. THE IN-CLUSTER CASE IS THE FIRST CASE, NOT THE EDGE CASE. SCP's SSRF guard refuses private addresses, so a wizard with no internal-egress control fails for the most likely first user — an Argo CD at `http://argocd-server.argocd.svc`. The checkbox below writes the execution system's `allowInternalEgress` property and is labelled as what ADR-0003 says it is: a DECLARATION, not a grant. The operator's `SCP_INTERNAL_EGRESS_HOSTS` allowlist is the boundary; without the host in it the declaration buys nothing, and saying otherwise would teach an operator to expect a grant they did not make. Never a silent default.

2. IT COLLECTS A CREDENTIAL, AND THE CREDENTIAL LEAVES BY EXACTLY ONE DOOR. The Argo CD API token reaches `secrets.put` and nothing else — never a query cache, never a URL or search param, never router state, never a retained mutation `variables` (which is why every mutation here takes NO argument and closes over its input instead), never a log line, and cleared from component state the moment the write succeeds. `secrets` is write-only by contract, so the wizard cannot read it back and does not try. Charter credential asymmetry is unchanged: a scoped API token TO the operator's Argo CD, never that cluster's own credentials.

3. AN IMPORTED COMPONENT IS A GRAPH ORPHAN, AND THE LAST SCREEN SAYS SO. `discovery accept` creates components, executor bindings and `source_mappings` — and NO relationships: `coordinated_by` was never a registered relationship type and the argocd plugin returns `relationships: []` (the 2026-07-15 correction in the proposal's §3; measured live at 50 apps → 50 components → 0 relationships). `ImportSummary` renders the counts THE SERVER RETURNED, and the orphan notice keys on that response's relationship count being zero — never on this file's belief about what the plugin emits. A label named after what the code was believed to do goes false the first time the code changes underneath it.

NO CLIENT-SIDE CONNECTIVITY CHECK, ALSO DELIBERATELY. `scp connect argocd` does a best-effort `GET /api/version` from the operator's own shell. A browser cannot reach a private in-cluster address, so the same probe here would fail for exactly hazard 1 above — and it would be simulating a server behaviour in the client, the class of thing PR #152 removed a gate for. STEP 2 IS the connectivity check, and a real one: it runs server-side, through the SSRF guard, with the stored token. Stopping after step 1 is the `--no-validate` equivalent and reaches the same state.

### §321. The subset of the SDK this wizard may touch, structurally

The subset of the generated SDK this wizard is allowed to touch, as a structural interface so a test can hand in a double and MEASURE which doors were used — in particular that the token reached `putSecret` and nothing else. Every method here is one already-public operation; there is no wizard-specific endpoint anywhere in this flow.

### §322. ONLY the system id

ONLY the system id. `POST /discovery/run` resolves `serverUrl`, `tokenSecretKey`, `secretRefs`, the egress allowlist and `allowInternalEgress` from the PERSISTED system and lets those win over anything a caller sends (routes/executors.ts) — the ADR-0003 fix for "a grant on system X authorizing egress to a caller-supplied address". So the wizard neither re-sends the URL nor ever handles the token again after step 1.

### §323. STEP 1, as one function

STEP 1, as one function: store the token, then register the system that references it.

ORDER IS LOAD-BEARING and matches the CLI's. Secret first: an execution system whose `tokenSecretKey` names a secret that does not exist is a system that fails at discovery time with a confusing error, whereas a stored secret with no system yet is inert and simply overwritten by the next attempt.

### §324. This step used to import everything, and what replaced it

WAS "3. Review and import", which called `discovery.accept` and wrote the whole proposal — objects, bindings and mappings — in one transaction. ADR-0047 retired that path: it bypassed strict create, and the components it made had no owning service.

Now it scaffolds. The grouping question is asked before anything exists, and the operator commits the emitted code.

### §325. `ImportSummary` IS GONE WITH THE WRITE IT SUMMARISED

`ImportSummary` IS GONE WITH THE WRITE IT SUMMARISED (ADR-0047). It counted the objects, relationships, bindings and mappings that `discovery.accept` had just created. Nothing is created here now — the wizard emits IaC and the operator commits it — so a summary of a write that did not happen would be a screen describing an event that no longer exists.

## `apps/web/src/routes/connect.test.tsx`

### §326. B1/B3/B4 (docs/proposals/outpost-ui.md §4 Lane B)

B1/B3/B4 (docs/proposals/outpost-ui.md §4 Lane B) — `/connect/$kind`'s guarantees that must hold with no browser and no server, mirroring `connect-argocd.test.tsx`'s house pattern:

```text
- B1: the generalized wizard is driven by the server's OWN manifest catalog, and a module whose
  secret field the execution-system-backed merge cannot forward (`github-discovery`'s
  `privateKeySecretKey`) is excluded by DERIVATION, not a hand-maintained list.
- B4: a proposed `deployment-target` object gets the identical review-list/skip treatment as a
  `component` — but ONLY when the proposal actually contains one, and skip is withdrawn the
  moment the proposal carries relationships it cannot safely re-filter.
- B3: the accept response's positional correspondence to the SUBMITTED proposal is what lets the
  triage list name and assign each imported component.
- The Argo CD credential hazard (`connect-argocd.test.tsx` hazard (b)) generalizes: the secret
  still reaches `putSecret` and nowhere else, for a module OTHER than argocd.
```

### §327. Three cases described an affordance that no longer exists

THE THREE CASES THAT WERE HERE DESCRIBED AN AFFORDANCE THAT NO LONGER EXISTS (ADR-0047): a grouped list of proposed objects with a checkbox per row, so an operator could accept a SUBSET, plus the rule that the checkboxes withdrew when relationships made a subset unsafe to submit.

There is no submission now. The step emits IaC, and a proposal is not something you accept part of — you decide which components belong to which service and commit the result. Keeping the checkbox cases would have meant keeping a selection UI whose only consumer was the removed write.

What replaces them lives in `components/scaffold/scaffold-panel.test.tsx`, which tests the decision that actually matters now: grouping, and what happens to a component nobody grouped.

### §328. B3 IS GONE, AND SO IS WHAT IT DESCRIBED

B3 IS GONE, AND SO IS WHAT IT DESCRIBED (ADR-0047).

It pinned the POSITIONAL correspondence between the accept response's `createdObjectIds` and the proposal that was submitted — the join that let the triage list name each imported component — and then that the triage screen appeared exactly when components had landed without a service.

Both describe a graph write that no longer happens. `discovery.accept` is removed; the wizard emits IaC and a component cannot be emitted without a service, so there is no created-object list to zip against and no orphan to triage. The concern moved one step earlier, to `scaffold-panel.test.tsx`'s ungrouped case, which is where ADR-0047 put it: at authoring time, where a human is present.

### §329. The catalog is seeded into the cache rather than fetched

The manifest catalog is SEEDED directly into the QueryClient cache rather than awaited through `listManifestsSpy`'s promise: TanStack Query batches its post-fetch notification outside a plain microtask (a `flush()` awaits only `Promise.resolve()`), so asserting on the settled state needs either a real timer tick or — far more deterministic here — never going through the fetch at all. `connectableKinds`'s own unit tests above already pin the exclusion logic; this only needs to pin that the PAGE wires that result into the right branch.

## `apps/web/src/routes/connect.tsx`

### §330. `/connect/$kind` — B1 of `docs/proposals/outpost-ui.md` §4 Lane B

`/connect/$kind` — B1 of `docs/proposals/outpost-ui.md` §4 Lane B: generalizes the M19.1 "Connect Argo CD" wizard (`connect-argocd.tsx`) over the server's OWN discovery-module catalog instead of one Argo-CD-shaped page, so `gitea`/`gitlab` (discovery plugins that already ship — `KNOWN_DISCOVERY_MODULES`, `apps/server/src/routes/executors.ts` — with no wizard and no CLI shortcut) stop dead-ending in "hand-assemble `secrets.put` + `execution-system` create + `discovery.run` + `discovery.accept`" (outpost-ui.md §4, measured state).

"ARGO CD KEEPS ITS TESTIDS" — WHY THIS FILE NEVER RENDERS THE ARGO CD FORM ITSELF
`router.tsx` keeps the STATIC `/connect/argocd` route pointing at the original, untouched `ConnectArgoCdPage` — static beats dynamic in this router's own precedence (the same rule that keeps `/services/{id}/board` alive beside the index route), so a browser hitting `/connect/argocd` always resolves there FIRST and never reaches this file at all. `kind === "argocd"` below still dispatches to that same page defensively (so this route degrades correctly if the static one is ever removed), but in normal operation it is dead code. This is why B3/B4 below (triage, target rows) do not show up for an Argo CD import today — see risks in the section G4 handoff.

WHY `github` IS NOT IN THE CONNECTABLE SET, EVEN THOUGH IT HAS A DISCOVERY IMPLEMENTATION
`github-discovery`'s config REQUIRES `appId`+`installationId`+`owner`+`repo` and authenticates with a GitHub App PRIVATE KEY — `privateKeySecretKey` in its configSchema, never `tokenSecretKey`. The execution-system-backed discovery merge this wizard relies on for credential handling (`POST /discovery/run`'s `config.executionSystemId` branch, `routes/executors.ts`) is hardcoded to forward exactly ONE secret-bearing field off the persisted system: `tokenSecretKey` (`effectiveSecretRefs = props.tokenSecretKey ? {...} : {}`). A `kind: "github"` execution-system would register fine and then fail to authenticate at discovery time with no field telling it why — the private key secret ref never reaches the plugin. `connectableKinds` below derives the connectable set from the manifests themselves (never a hand-maintained list), so `github` is excluded by that derivation, not a hardcoded exception — see its doc comment.

### §331. The connectable set and its fields come from the manifests

Deriving the connectable set and its form fields FROM the server's own manifest catalog — never invented, mirroring plugins.tsx's `SchemaForm` (a separate, minimal copy: that file is owned by a different section of this same round, so this does not import from it).

### §332. Fields NOT collected by the run-time config form

Fields NOT collected by the run-time config form: `serverUrl`/`tokenSecretKey` are Step-1 system fields (the execution-system-backed merge injects them at discovery time), and `baseUrl` is the SAME resolution's explicit-override half (`resolveProviderBaseUrl` in `packages/plugins/git-provider-core`) — collecting it too would just be a second, confusing "URL" field doing what the Step-1 Server URL already does via the persisted system.

### §333. One schema declares no required array at all

`gitlab-discovery`'s JSON Schema declares no `required` array at all — `discover()`'s `projectPathOf` needs `projectPath` OR (`owner` AND `repo`), an OR a flat `required` list can't express (packages/plugins/gitlab/src/index.ts). Asked for like every other git-provider module here rather than left to a schema that can't say it; `projectPath` stays optional, for a nested-group self-hosted layout.

### §334. The doors — same discipline as `connect-argocd.tsx`'s `ConnectDoors`

The doors — same discipline as `connect-argocd.tsx`'s `ConnectDoors`: a structural interface a test can hand a double to, and (b3) the two more doors this wizard's triage step needs, copied from `registry-detail.tsx`'s `ComponentServiceCard` rather than importing that page.

### §335. One row per proposed object type, in first-seen order

One row per proposed object type, in first-seen order — generalizes `proposalTypeCounts` (`connect-argocd.tsx`) into groups so a `deployment-target` object (B4: "where a discovery module proposes targets … accept them alongside components") gets its own section with the IDENTICAL row/skip treatment as `component` — see the section G4 handoff for why no shipped discovery module actually emits one today.

### §336. Filters a proposal to the checked objects, dropping the rest

Filters a proposal down to the CHECKED objects, dropping any `bindings`/`sourceMappings` that name a skipped object (`objectName` match — exact, the SAME key `POST /discovery/accept` itself resolves them by). `relationships` is left untouched: the caller only offers skip when `proposal.relationships.length === 0` (see `ReviewStepGeneric`), because a relationship references its endpoints by a `fromUrn`/`toUrn` each plugin constructs internally and never exposes as a stable per-object key — dropping an object that a relationship still points at would submit a proposal with a dangling endpoint and `POST /discovery/accept` would 404 resolving it. That is the "do not fake it client-side" boundary for B4/B3 skip: real, but only where it is safe.

### §337. THE STEP THAT USED TO WRITE

THE STEP THAT USED TO WRITE. It called `discovery.accept`, which committed the proposal straight into the graph — the path that made the homelab's ~50 imported components RBAC orphans, because nothing asked which service they belonged to.

It now emits IaC (ADR-0047). The grouping question is asked HERE, before anything exists, which is the whole of the fix: "the orphan problem is solved at authoring time, where a human is present." The post-import orphan-triage screen this wizard used to end on is gone with it — there are no orphans to triage when a component cannot be emitted without a service.

### §338. THE POST-IMPORT ORPHAN TRIAGE IS GONE, AND THAT IS THE POINT

THE POST-IMPORT ORPHAN TRIAGE IS GONE, AND THAT IS THE POINT (ADR-0047).

`zipCreatedObjects`, `ImportedRow`, the per-component service picker and `ImportSummaryGeneric` existed to repair what the accept path produced: components already written to the graph with no owning service, which the operator then had to find and fix one at a time. The homelab's ~50 imported components are why that screen was built.

With discovery demoted to a scaffolder there is nothing to repair. Grouping is asked BEFORE anything exists (`ScaffoldPanel`), and a component with no service is simply not emitted — a `Component` cannot be constructed without one. A triage screen for a state that can no longer be reached would be dead code that reads as a safety net.

## `apps/web/src/routes/dashboard.tsx`

### §339. `/` (BUILD_AND_TEST.md §8 M2 item 2)

`/` (BUILD_AND_TEST.md §8 M2 item 2) — real services as the primary destination, catalog counts below them, live activity demoted to the bottom.

This is NOT the "Needs you" dashboard (approvals/blocked/freezes roll-up) design-spec §4A describes as the eventual homepage — that needs a server-side aggregate across changes, freezes and approvals that does not exist yet. See docs/proposals/homepage-dashboard.md for that design; this page is the honest subset buildable from today's list endpoints.

The org-name/"Signed in as" block that used to live here is gone — the header bar (AppShell §3.3, `current-org` testid) is the one home of account chrome now.

## `apps/web/src/routes/device.tsx`

### §340. `/device` (BUILD_AND_TEST.md §8 M2 item 2)

`/device` (BUILD_AND_TEST.md §8 M2 item 2) — browser approval page for the CLI's device- authorization flow (routes/device-flow.ts `POST /auth/device/approve`). `?user_code=` pre-fills the field; the full CLI polling round-trip is covered by M2 step 2's server-side integration test (auth/device-flow.ts) — this page just needs to render and submit correctly.

## `apps/web/src/routes/federation-status-crash.test.tsx`

### §341. Z1 — `/federation` MUST REPORT A CONTRACT FAILURE, NOT SWALLOW IT

Z1 — `/federation` MUST REPORT A CONTRACT FAILURE, NOT SWALLOW IT.

WHY THIS FILE WAS REWRITTEN (ADR-0023). Its previous form mocked `client.federation.status()` to RESOLVE with a body whose `recentTransfers` key was deleted, and asserted the row rendered "none". The SDK now validates every 2xx JSON body against the generated schema, so THE REAL SDK CAN NO LONGER PRODUCE THAT RESOLUTION — it rejects. The old assertions therefore pinned a scenario that cannot occur while staying green, giving the web suite zero signal about what the page actually does with a malformed response: the vacuous-guard class (wording, not behaviour) in its purest form. The REVERT TEST it advertised — "delete the `?? []`s and this goes red" — had stopped being true for exactly the same reason.

WHAT IT PINS NOW, AND WHY IT DRIVES THE REAL SDK. The behaviour under test spans two packages: the SDK converts a malformed body into an `ScpResponseValidationError`, react-query converts the rejected `queryFn` into `isError`, and this page must RENDER that. Mocking `client` would stub out the first half — the exact half that decides whether the second half is reachable at all. So these tests construct a REAL `ScpClient` over a stubbed `fetch`: everything from the wire bytes up is production code.

THE REGRESSION THIS CLOSES, MEASURED. With the real SDK and a body whose one peer omits `recentTransfers`, the page rendered the identity card and an EMPTY "Peers" card — no peer row, and no occurrence anywhere in the DOM of "fail", "error", "contract", "invalid", or "skew". The failure was detected, diagnosed, and then died in the query cache. Before response validation, the `?? []` guard at least rendered that peer's row with "none". Detection that never reaches a human is worse than the guard it replaced; the `isError` branches restore, and improve on, what an operator sees.

REVERT TEST: delete the `statusQuery.isError` branch in `federation-status.tsx` and the first case below fails on the missing `federation-status-error` node.

## `apps/web/src/routes/federation-status-init-hint.test.tsx`

### §342. The init form offers only roles this instance could hold

LANE A — the init form offers exactly the roles this instance could honestly hold.

OWNER DECISION 2026-08-24, reversing this file's earlier premise. The form USED to offer `retrans` for API-first parity, with a hint shown while it was selected. But a real retrans deployment never serves this UI at all (`app.ts` gates SPA registration on `federationRole !== "retrans"` — M16.3 P3, `retrans-no-spa.integration.test.ts`), so on ANY instance where this form can render, declaring an org retrans is by construction a stray config — it idles relay machinery on a non-boundary box and flips the org's dependencyManagement to `managedHere: false`. The server now refuses it at the init door unless the deployment declares `SCP_FEDERATION_ROLE=retrans` (`apps/server/src/federation/init-role-door.integration.test.ts`), and the form stops offering what every instance able to show it would refuse.

What this file pins: 1. the select offers exactly commander|outpost — no retrans option to walk into the 400; 2. the retrans role stays DISCOVERABLE — a persistent note names where it actually lives (the CDS-boundary deployment + CLI), so the absence reads as structural, never as a hidden capability (design-system honesty: structurally-expected absence is explained).

Driven through the real wired-up `FederationStatusPage` with a real `ScpClient` over a stubbed `fetch`, mirroring `federation-status-crash.test.tsx`'s pattern.

## `apps/web/src/routes/federation-status.tsx`

### §343. `/federation` — read-only federation status view

`/federation` — read-only federation status view (BUILD_AND_TEST.md §8 M6 item 7, "commander federation status UI"; DESIGN.md §13). Consumes ONLY `client.federation.status()`/`.self()` (the generated SDK, per CLAUDE.md's API -> SDK -> CLI/IaC -> UI parity principle) — the exact same endpoints `scp federation status`/`scp federation self` call. Deliberately read-only: pairing, export, import, hand-fill, and overlay authoring all involve carrying a real bundle file (or an out-of-band public-key exchange for air-gapped peers) across a gap this browser tab has no access to, so those stay CLI-only workflows (DESIGN §13) — this page is "what does federation look like right now," not "drive a sync from the browser."

Per FederationStatusResponseSchema's own doc comment (packages/schemas/src/federation.ts): `lastSyncedAt` reflects this domain's own last-applied cursor, never a live probe of the peer (air-gapped peers may not be reachable at all) — every timestamp below is labeled "as of", not "live."

EVERY QUERY HERE HAS THREE STATES, NOT TWO (ADR-0023). Since the SDK validates responses, a body that does not match the contract REJECTS the `queryFn` — so `isError` is now a reachable state for a 200 response, not only for a 4xx/5xx or a dead network. A page that branches only on `isLoading` and `data` renders an EMPTY card for exactly the fault the boundary exists to report, which is how the diagnosis dies in the query cache instead of reaching an operator. Both cards below therefore render `QueryErrorNotice`, which prints the operation and the offending field verbatim.

### §344. `GET /federation/self` always succeeds

`GET /federation/self` always succeeds — `ensureFederationSelf` (federation/self-repo.ts) lazily provisions a domain identity with role "unset" the very first time anything reads it, well before an operator necessarily runs `scp federation init` (DESIGN §13: "every row is born federation-ready"). "unset" is the actual not-yet-opted-in signal, not a missing response.

### §345. The last unguarded consumer of that peer list

`?? []` — the LAST unguarded consumer of `FederationStatusResponse.peers` (Z5). `peers` is required-not-optional, and BEFORE ADR-0023 the SDK validated no response, so a body without the key resolved the query and `statusQuery.data && data.peers.length` threw. The SDK now REJECTS that body at the boundary, so this guard is no longer what stands between the page and a white screen — the `isError` branch below is. It stays anyway: it is the correct reading of a body this component is handed by any other route (a test double, a future cached snapshot), and defence in depth against a shape the contract does not yet forbid costs one operator. `peersLoaded` keeps the loaded-vs-loading distinction the two branches below need, which a bare `?? []` would have collapsed into "no peers paired yet" while still fetching.

### §346. The one write surface this page owns: `POST /federation/init`

The one write surface this page owns: `POST /federation/init` — the commander-config gap the owner flagged (2026-08-11). Everything else about "the commander's own config" deliberately lives elsewhere: per-outpost config is authored on each outpost's detail page and syncs down as commander-origin data, and instance-level operator settings (scan floors, tokens) are deployment env — not a tenant surface. The federation IDENTITY is the one self-config fact in the graph, it is set exactly once, and API-first parity (charter principle 3) says the UI must be able to do what `scp federation init` does.

Once initialized the identity renders read-only above — the API exposes no rename/re-role, and offering an edit the server would refuse is the "UI offers writes the server 403s" defect class (M16.3) this repo already paid for once.

## `apps/web/src/routes/graph-explorer.tsx`

### §347. `/graph/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2)

`/graph/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2) — object-scoped Cytoscape.js explorer fed by M1's named graph-query endpoints. Reachable from `/graph` (the landing/picker) or from an object's registry-detail page.

Edge sourcing: `traverse` already returns the real induced-subgraph edges. The named queries (`impact-of`/`blast-radius`/…) return only the reachable object SET — so we take that set and make a single follow-up `graph.subgraph` call to fetch the REAL relationships among it (root included), rendering the true dependency DAG instead of a synthesized hub-and-spoke star.

## `apps/web/src/routes/graph-landing.tsx`

### §348. The discoverable entry point for the graph explorer

`/graph` landing — the discoverable entry point for the graph explorer (previously reachable only by already knowing an object id). Provides two ways in:

1. An object picker (registry + type-ahead over that registry's objects) that navigates to the object-scoped explorer at `/graph/{id}`. 2. A default at-a-glance SERVICE-level org map — every service plus the real `depends_on`/ `consumes`/… edges among them — so the page is never empty. Nodes are clickable (they route to the object's registry-detail page, same as inside the explorer).

## `apps/web/src/routes/identity.tsx`

### §349. One nav entry standing in for four identity registries

`/identity` — one nav entry standing in for the four identity registries.

Teams, groups, users and service accounts were four of the nine flat REGISTRIES nav entries, and none of them is catalog: they answer "who", not "what we run". This collapses them to a single destination WITHOUT duplicating `RegistryListPage` — each preview row links to that page's own detail route, and "View all" links to the list itself, which still owns listing and creation. Re-mounting `RegistryListPage` here was the alternative and does not work: `useBasePathParam` resolves the registry from the URL's FIRST SEGMENT when there is no `$basePath` param, so anything under `/identity/...` would resolve to the registry "identity" and render "Not found".

The counts AND the first few names are the point (spec §4E) — a card that only repeats its own label is what the old dashboard's registry grid was, and it carried no information the nav did not already have.

## `apps/web/src/routes/outpost-configuration-interaction.test.tsx`

### §350. M16.2 phase B (B3) — WHAT THE CLICK ACTUALLY SENDS

M16.2 phase B (B3) — WHAT THE CLICK ACTUALLY SENDS.

THE ONE THING THIS FILE OWNS, and the reason it is not in `outpost-configuration.test.tsx`: every other web test renders to a STRING (`renderToStaticMarkup`), which cannot fire a handler. So the reconcile panel's central guarantee — that the default button sends the SURVIVOR IT NAMED, never a bare re-derive-it-yourself call — was pinned only as the `data-keep` ATTRIBUTE rendered beside the handler. MEASURED: replacing `onClick={() => onReconcile(defaultKeep.objectId)}` with `onClick={() => onReconcile(undefined)}` left all 102 web tests green.

WHY THE DIFFERENCE MATTERS AT RUNTIME, not just on principle. A bare `POST …/reconcile` with no `?keep=` re-derives the survivor SERVER-SIDE (`outposts-repo.ts` `byAuthority`) at request time — AFTER the operator has read a prediction computed from a possibly-stale `listOutposts()` cache. A claimant row that appeared since that fetch is then soft-deleted having NEVER been previewed, and if it is locally authored that is a journaled tombstone which PROPAGATES to the outpost. A stale `?keep=` id cannot do that: it fails safe with the server's 400.

This file runs in a happy-dom environment (docblock above) so the handlers can be invoked for real; see `src/test-support/render-dom.tsx` for why that dependency was taken.

## `apps/web/src/routes/outpost-configuration-precondition.test.tsx`

### §351. WHAT THE CLICK SENDS TO THE SERVER

WHAT THE CLICK SENDS TO THE SERVER — the request, not the handler argument.

`outpost-configuration-interaction.test.tsx` proves the buttons pass the survivor they NAMED into `onReconcile`. That stops at the panel's boundary: the wired-up card turns that argument into an actual `reconcileOutpost` call, and the argument it adds there — the `?ifClaimant=` precondition — is invisible to every test above it. Without this file, a build that computes a perfect preview and then issues an UNGUARDED call passes the whole web suite.

THE TWO FAILURES IT GUARDS, both silent 200s without the token: * the ADOPT-SHADOW control sends no `keep`, so the server re-derives the survivor from rows read inside its own transaction — a locally-authored claimant that appeared since this card's query resolved outranks the shadow, and the entered value the button promised to keep is DROPPED; * naming the shadow with `keep` instead makes that concurrent row surplus, and removing a row this domain authored journals a tombstone that PROPAGATES to the outpost.

The SDK and `@tanstack/react-router` are stubbed; everything else is the real component tree in a real DOM, so the assertion is on the call the card actually made.

### §352. Wait for a CONDITION, never for a fixed delay

Wait for a CONDITION, never for a fixed delay.

A single `settle()` after render was enough on a fast machine and NOT on a loaded CI runner, where the two queries (`self`, `listOutposts`) had not both resolved before the click — the test then failed looking for a control that simply had not rendered yet. A fixed sleep long enough to be safe everywhere is also a fixed cost paid on every run; polling is both faster and correct.

## `apps/web/src/routes/outpost-configuration-retrans-gate.test.tsx`

### §353. THE STRAY-CONFIG HAZARD, CLOSED

THE STRAY-CONFIG HAZARD, CLOSED (LANE A, retrans-noun sweep).

`TrustTierCard`/the tier editor used to be gated only on a config OBJECT existing, never on the PEER's own federation role. `assertOutpostPeerBinding` (`outpost-binding.ts`, ADR-0004) refuses (400) an UPDATE against a peer whose role is not `outpost` exactly as it refuses a CREATE — so a STRAY config object bound to a peer whose role changed to `retrans` after the object was declared (nothing deletes the row when that happens) rendered a live, clickable Save button the server would refuse confusingly. This file pins the fix: the editor is withheld for such a peer and the SAME refusal sentence `DeclareConfigCard` already renders for a non-outpost peer is shown instead.

It also pins the two other retrans-role gates on this same wired-up section: the CardDescription branch (a retrans peer holds no commander-declared outpost configuration — only poke-mode applies) and the "managed elsewhere" notes being withheld for a retrans peer (freeze windows / the outpost-local Gitea registry / bundled backends are outpost concepts a CDS-boundary retrans has none of, per M13.1).

Driven through the real wired-up `OutpostConfigurationSection` (not just the presentational sub-components) with a mocked SDK, mirroring `outpost-configuration-tier-precondition.test.tsx`'s pattern — a happy-dom render is what lets "no Save control is offered at all" be asserted as an absence in the actual DOM rather than as an attribute beside a control that still renders.

## `apps/web/src/routes/outpost-configuration-tier-precondition.test.tsx`

### §354. The panel's other write door also sends its premise

R2 (PR #156 residual) — THE PANEL'S OTHER WRITE DOOR ALSO SENDS ITS PREMISE.

`outpost-configuration-precondition.test.tsx` pins that reconcile carries `?ifClaimant=`. This file is the same class of test for `tierMutation`: the trust-tier save button reads `config` off screen and edits it, so the request must carry `expectedVersion` — the same optimistic-concurrency premise, on the API's OTHER door for this object (`PATCH /federation/outposts/{peer}`, which has always accepted `expectedVersion` and always declared 412; only this call site omitted it).

## `apps/web/src/routes/outpost-configuration.test.tsx`

### §355. M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION, pinned on every PR

M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION, pinned on every PR.

Four separate contracts live in this card and each has its own way of going wrong:

1. TRUST TIER — absent until set. A blank select that reads as `commercial` is the invented posture this milestone exists to prevent; and phase A has no clear-to-unknown verb, so the placeholder must never be submittable once a tier exists. 2. AN UNVERIFIED SHADOW — must SAY it is one and offer the reconcile verb, and the edit must be gated on the MEASURED 409 (`outpost-handfill-wedge.integration.test.ts`: PATCH on a shadow-only peer answers 409 "read-only replica"), never quietly overwritten. 3. POKE-MODE — labelled THIS SIDE ONLY. One toggle presented as controlling both sides is a claim about a database this instance cannot write. 4. RECONCILE — the two removal outcomes must be visibly different, and a removal that PROPAGATES downstream must say so BEFORE it is taken.

Also pinned: the "managed elsewhere" notes offer NO edit control at all (owner decision), because an edit box that silently does nothing downstream is worse than no box.

M25.7 RETIRED HALF OF THAT REASON. This header used to add "— freezes are TESTED never to ride the journal (`coordination/service-board-precedence.integration.test.ts`)", which was true and pinned until owner decision D6 gave an org-tier freeze a graph object so it CAN cross. The no-edit-control ruling survives on the reason that did NOT change: a freeze is scoped at an object in the org's containment graph and there is no "the outpost this freeze belongs to", so a per-outpost freeze form would be structurally wrong rather than merely absent. The case below pins the REWRITTEN copy, which is what makes this a rewrite rather than a silent deletion.

### §356. That field is required-nullable, and what the SDK did before

`OutpostConfigSchema.trustTier` is required-nullable, and BEFORE ADR-0023 the generated SDK validated no response, so a server that omitted the key handed this component `undefined` (since ADR-0023 that body rejects at the SDK boundary; this drives the component directly, which is where the guard itself lives). Keyed on `=== null`, that fell through to the VALUE branch and rendered an empty `<Badge>` with no `data-trust-tier` attribute — a blank standing in for an unknown — while the select, initialised with `?? ""`, showed a value no option carried.

### §357. THE WINDOW: `originIsSelf` absent

THE WINDOW: `originIsSelf` absent (an older server) and `ownDomainId` not yet resolved. `isConfigForeign` answers FALSE there BY DESIGN — never fabricate a block on a write the server would accept — so gating the unverified marker on `foreign && provenance === "manual"` made a hand-typed shadow render `data-tier-unverified="false"` with an ENABLED edit control: a manual claim presented as this domain's own authority, for as long as the query took.

### §358. ROUND 3 — W3 WAS APPLIED ONE FILE OVER AND NOT HERE

ROUND 3 — W3 WAS APPLIED ONE FILE OVER AND NOT HERE.

`outposts.tsx`'s `TrustTierCell` was fixed to OR the two signals the server emits for this one case; `TrustTierCard` still decided declared-vs-unverified from `provenance` ALONE. But `toOutpostConfig` (`outposts-repo.ts`) pushes `"trustTier"` into `unknownFields` in exactly two cases — no tier at all, or `provenance === "manual"` — so a config that HAS a tier and declares it unknown IS the shadow case, and `OutpostConfigSchema.provenance` is `.nullable().optional()`, so a well-formed response may simply omit the key.

MEASURED before the fix: this config rendered BYTE-IDENTICAL to a signature-verified replica of the same tier — `data-tier-unverified="false"`, no shadow notice, edit control offered.

### §359. The mirror of the test above, and it is not symmetric bookkeeping

The mirror of the test above, and it is not symmetric bookkeeping: the visible "unverified" word was rendered behind `tierUnknown && unverifiedShadow`, so an older server that sends `provenance: "manual"` but declares nothing left an operator with only an ATTRIBUTE and a badge VARIANT to tell a hand-typed claim from this domain's own assertion — neither of which anybody reads. Whenever the value is shown as unverified, it must SAY so.

### §360. The guard rail on the fix above

The guard rail on the fix above. A locally-authored config with NO tier ALSO declares `trustTier` unknown (`if (trustTier === null) unknownFields.push("trustTier")`), and it is the ordinary declare-then-set flow — so keying the unverified/edit-gate on the declaration ALONE would disable the very control this milestone exists to offer. `!isAbsent(config.trustTier)` is what keeps the two apart, and this is what fails if it is dropped.

### §361. That field is required, and what the SDK validated before

`unknownFields` is required-not-optional and BEFORE ADR-0023 the SDK validated no response, so `config.unknownFields.includes(...)` threw a TypeError and BLANKED THE WHOLE CARD — under the very response shape the guards here exist for. Fail loud beats fail dishonest; a white screen is neither. (Since ADR-0023 that body rejects at the SDK boundary; this case drives the component directly, where the guard itself lives.)

### §362. It says where each one is really configured

…and it says where each one really is configured, so "no control here" is not a dead end.

DELIBERATE INVERSION (M25.7, owner decision D6). This line asserted `"does NOT ride the sync journal"` — the operator-facing correction of M16.2's "syncs down" aspiration, true and load-bearing until D6 gave an org-tier freeze a graph object. Asserting the old sentence now would pin a lie in place; asserting nothing would let the note go silent. So it pins the two claims the rewritten copy actually makes: freezes are declared PER OBJECT and never per outpost (the structural reason there is no form here, which D6 did not touch), and reaching this outpost is CONDITIONAL on the declaring domain federating it (the part D6 changed).

### §363. THE MEASURED BYPASS

THE MEASURED BYPASS. With two locally-authored claimants both `reconcile-keep` buttons carried `disabled=""` — either choice drops a row this domain authored, whose tombstone PROPAGATES downstream to the outpost — while the bare `reconcile-default` button called the SAME destructive verb with no preview, no per-outcome block, no confirmation, and a label naming no consequence, and was fully clickable.

### §364. The structural rule, over every arrangement of the keys

THE STRUCTURAL RULE, asserted over every arrangement of the three claimant kinds rather than over the two the review happened to render. `propagates-downstream` means dropping a row THIS domain authored — a journaled tombstone the outpost applies — and that choice must always be made explicitly, per row, behind the confirmation. So: whenever a default IS offered, its own preview contains no such outcome.

### §365. The same half-guard, in the file named for fixing it

ROUND 3 — THE SAME `=== null` HALF-GUARD, IN THE FILE WHOSE COMMIT IS TITLED "guard both, everywhere". `adoptedObjectId` is required-nullable, and BEFORE ADR-0023 the SDK validated no response. (Since ADR-0023 an omitted required key rejects at the SDK boundary; this case drives the component directly, where the guard itself lives.)

MEASURED with `adoptedObjectId: undefined`, BOTH mirrors misfired at once: * `!== null` was TRUE, so the panel emitted `<p data-testid="reconcile-adopted">Adopted <code></code> as this domain's own configuration — it journals down to the outpost from now on.</p>` — an EMPTY element inside a confident claim about a journaling side-effect; and * `=== null` was FALSE, so the honest `reconcile-removed-none` branch was suppressed. The operator was told an adoption happened AND denied the statement that nothing did.

## `apps/web/src/routes/outpost-configuration.tsx`

### §366. M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION

M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION: the `outpost` GRAPH OBJECT half of the authority split (ADR-0022 clause 2). Commander-declared, journaled, and read-only at the outpost.

FOUR THINGS LIVE HERE, AND THEY ARE NOT THE SAME KIND OF THING — which is the point:

1. TRUST TIER — commander-declared config that SYNCS DOWN. Editable, five members, and ABSENT until an operator sets one. There is no clear-to-unknown verb in phase A, so once set it can be changed but not un-asserted. 2. POKE-MODE — a PEER-ROW flag, edited through the same keyless peer PATCH the Settings card uses, and labelled THIS SIDE ONLY. It is both-sides consent: this flag licenses the commander to SEND a wake signal; the outpost's OWN flag, set at the outpost, decides whether it accepts one and stops polling. Presenting one toggle as controlling both sides would be the fabrication. 3. FREEZES / LOCAL GITEA REGISTRY / BUNDLED BACKENDS — READ-ONLY "managed elsewhere" notes (owner decision). They are named, with where they are actually configured, and offered NO edit control. FREEZES USED TO BE HERE FOR A STRONGER REASON — they were TESTED never to ride the journal — and M25.7 (owner decision D6) retracted that: an org-tier freeze declared `federate: true` now rides `object_upsert` and DOES block at the outpost. It stays a read-only note here anyway, on the reason that survives: a freeze is scoped at an object in the ORG's containment graph and there is no "the outpost this freeze belongs to", so PER-OUTPOST freeze configuration is structurally wrong rather than merely unbuilt (campaigns-rework.md "Pre-existing contradictions" #5). The note's copy below was rewritten to match. 4. RECONCILE — the recovery verb for a peer wedged by duplicate config objects, including the `?keep=` form, with the two removal outcomes rendered DISTINCTLY: dropping a row THIS domain authored journals a tombstone that PROPAGATES downstream to the outpost, while dropping an unverified shadow is a silent local cleanup nothing downstream ever sees.

### §367. Is this config object one this instance may write?

Is this config object one this instance may write?

`originIsSelf` is the server's own resolved answer and is preferred; the `originDomainId` compare is the fallback for a response that predates it. `undefined`/unknown is treated as NOT foreign, so missing data can never fabricate a block on a write the server would accept (the `replica-origin.tsx` rule — a UI that blocks an accepted write is a defect this repo has already fixed once).

### §368. The refusal this gate mirrors, named so it can be checked

The refusal this gate MIRRORS, named so the gate can be checked against a measurement rather than against a belief. Both halves are measured on a real two-database topology: `outpost-config-sync.integration.test.ts` ("the OUTPOST's own write … is REFUSED", 409 read-only replica) and `outpost-handfill-wedge.integration.test.ts` (the same 409 when the only row is an unverified hand-filled shadow, which this domain likewise did not author).

### §369. What reconciling with a survivor would do to the others

What reconciling with a given survivor would DO to each of the peer's other claimant rows — derived from each row's OWN provenance, not from a guess about server internals:

```text
* a row THIS DOMAIN AUTHORED → an ordinary JOURNALED TOMBSTONE. It PROPAGATES downstream to the
  outpost, which will drop its replica. This is the destructive case and it must be said before
  the button is pressed, not discovered afterwards.
* an UNVERIFIED hand-filled shadow → a silent local cleanup. This domain never authored it, so
  its removal never rides the journal and nothing downstream sees it.
* a SIGNATURE-VERIFIED REPLICA → REFUSED, unconditionally, with or without `?keep=`. Deleting one
  would claim authorship of a row the real authority still owns and would trade a config wedge
  for a sync wedge. Choosing a survivor that requires deleting one is a 409.
```

### §370. The server's own authority ranking, mirrored

The server's own authority ranking, mirrored — `outposts-repo.ts`'s `byAuthority`: a row THIS DOMAIN AUTHORED outranks a signature-verified replica, which outranks an unverified hand-filled shadow. Every input is already on the wire (`originIsSelf`/`originDomainId`, `provenance`).

### §371. Which row a reconcile with NO `keep` would leave standing

Which row a reconcile with NO `keep` would leave standing — or `null` when this side cannot know.

DELIBERATELY REFUSES TO GUESS. The server breaks a tie inside one authority class by `(created_at, id)`, which is its list order and not something a client should reconstruct and present as a prediction. So a determinate answer means EXACTLY ONE row holds the top rank; two rows of equal authority return `null`, and the panel then declines to offer the default at all rather than preview a survivor it is guessing at. A preview that might be wrong is worse than no default button, because the whole point of the preview is that it is what will happen.

### §372. TRUST TIER — owner-ENTERED, five members, ABSENT UNTIL SET

TRUST TIER — owner-ENTERED, five members, ABSENT UNTIL SET.

The select's members come from `OutpostTrustTierSchema.options` at runtime, so the control cannot drift from the API's enum. When no tier has been asserted, the select shows an unselectable placeholder and the unknown marker sits beside it — never a blank that reads as `commercial`.

### §373. That field is required by the schema, so the fallback is

`?? []` — `unknownFields` is required-not-optional by `OutpostConfigSchema`, and BEFORE ADR-0023 the generated SDK validated NO response, so a server that omitted the key made this dereference throw a TypeError and BLANK THE WHOLE PANEL. Under the very response shape the guard below exists for, that is worse than the unknown it was meant to render: fail loud beats fail dishonest, but a white screen is neither. SINCE ADR-0023 that body is rejected at the SDK boundary instead and the page's `isError` branch names the operation and the field; the guard stays because "nothing declared" is the same reading `isPeerUnknown` gives an older server, for any source of a config that is not this query.

### §374. TWO INDEPENDENT SIGNALS FOR ONE FACT, OR'd

TWO INDEPENDENT SIGNALS FOR ONE FACT, OR'd — the same fix `outposts.tsx`'s `TrustTierCell` got, applied to the file whose own commit is titled "guard both, everywhere" and which had been given only the ownDomainId-load half of it.

```text
* `provenance === "manual"` ALONE, not `foreign && …`. A `"manual"` row IS an unverified
  hand-filled shadow by the schema's own definition — its origin adds nothing. Worse,
  `isConfigForeign` answers FALSE while `ownDomainId` is still loading and the server omitted
  `originIsSelf`: deliberately the right answer for a WRITE gate (never fabricate a block on a
  write the server would accept) and the wrong one for a DISPLAY discriminator.
* A TIER THAT RIDES THE WIRE WHILE THE SERVER DECLARES IT UNOBSERVABLE. `toOutpostConfig`
  pushes `"trustTier"` into `unknownFields` in exactly two cases: no tier at all, or
  `provenance === "manual"`. So a config that HAS a tier and declares it unknown IS the shadow
  case — with the OPTIONAL `provenance` key merely omitted. ADR-0023 does NOT close this one:
  `provenance` is `.nullable().optional()`, so an omitted key is CONTRACT-LEGAL and passes
  response validation untouched. MEASURED: keyed on provenance alone, such a row rendered
  BYTE-IDENTICAL to a signature-verified replica of the same tier — `data-tier-unverified="false"`,
  no shadow notice. `!isAbsent(config.trustTier) &&` is load-bearing and is what keeps this from
  over-blocking: an ordinary locally-authored config with NO tier yet also declares `trustTier`
  unknown, and must stay fully editable — that is the whole declare-then-set flow.
```

### §375. The select value → the request field

The select value → the request field. `""` (the leave-unset option) becomes an ABSENT `trustTier`, never an empty string: `CreateOutpostConfigRequestSchema` is a `z.strictObject` whose `trustTier` is the five-member enum, so `""` is a 400 — and a value silently coerced to a member would be the invented posture this milestone exists to prevent. Absent is the only honest encoding of "the operator has not decided yet", which is exactly why the create body makes the field optional.

### §376. No config object exists for this peer yet

No config object exists for this peer yet. `POST /federation/outposts` binds only to a peer whose role is `outpost` — a `retrans` peer is a MEASURED 400 (`outpost-object.integration.test.ts`), so the create control is not offered for one rather than offered and refused — OR (§10.5) to THIS instance's own trust domain, the HQ outpost (formerly "co-located" — GLOSSARY, ADR-0021 D7; the `coLocated` prop and test ids keep the older spelling): `coLocated` renders that case, for which there is no peer row; the role checked is THIS instance's own (`selfRole`, `federation_self.role`), which must be `commander` — an outpost's own record is commander-declared and arrives replicated, and the server 400s the self shape on any other role (MEASURED — `outpost-config-sync.integration.test.ts`, before and after the replica arrives).

### §377. THE REFUSAL `POST /federation/outposts` MIRRORS, SHARED

THE REFUSAL `POST /federation/outposts` MIRRORS, SHARED. `outpost-binding.ts`'s `REQUIRED_PEER_ROLE` refuses (400) to bind an `outpost` config object to any peer whose role is not `outpost` — on CREATE (`DeclareConfigCard`, below) and, unchanged, on UPDATE of an existing object (`assertOutpostPeerBinding` runs on both doors). So the same sentence covers two distinct moments: no config object exists yet for a non-outpost peer, AND a config object exists but its peer's role no longer is one (e.g. changed post-declare) — a stray row the edit door will 400 on confusingly if offered a live Save button. One refusal, read from the same measured 400 (`outpost-object.integration.test.ts`; ADR-0004), rendered wherever that door would fire.

### §378. POKE-MODE — THIS SIDE ONLY

POKE-MODE — THIS SIDE ONLY (owner decision).

ADR-0009's flag is PER-SIDE. On a commander it means "this side MAY send a contentless wake signal to that peer"; it does not, and cannot, set the outpost's own flag, which is what decides whether the outpost accepts a poke and disables its frequent poll. A single toggle presented as controlling both sides would be a claim about a database this instance cannot write.

The UNILATERAL-SPARSE case is rendered as such: `pokeMode: true` with `lastPokeReceivedAt: null` is this side opted in while the other side has never actually poked — the scheduler keeps polling (`effectiveCadence: "poll"`), and this is how an operator sees it.

### §379. MANAGED ELSEWHERE — READ-ONLY NOTES, NO EDIT CONTROLS

MANAGED ELSEWHERE — READ-ONLY NOTES, NO EDIT CONTROLS (owner decision).

The proposal listed freezes, the outpost-local Gitea registry and the enabled bundled backends as per-outpost configuration. None of the three has a commander-writable data model IN THIS SURFACE, so they are named here, with where they are ACTUALLY configured, and offered no control at all. An edit box that silently does nothing downstream would be worse than no box.

THE FREEZE NOTE WAS REWRITTEN IN M25.7, AND THE RETIRED REASONING MATTERS
This copy used to tell the operator, verbatim, that a freeze is a local projection row that does NOT ride the sync journal, so a freeze declared at the commander is not a freeze at the outpost. That was TRUE and it was the honest correction of M16.2's "commander-origin, syncs down" aspiration, which was found false at build time; it was TESTED by `coordination/service-board-precedence.integration.test.ts`.

OWNER DECISION D6 (2026-08-23) RETRACTED IT. An org-tier freeze declared `federate: true` gets a `freeze` graph object, rides `object_upsert`, and is rebuilt into the outpost's own `freezes` table where it BLOCKS. Leaving the old sentence would now be an operator-facing lie in the exact place an operator goes to ask the question.

WHAT DID NOT CHANGE — and why this stays a note rather than becoming a form: a freeze is scoped at an object in the ORG's containment graph, and there is no "the outpost this freeze belongs to". A service-scoped freeze reaches every placement under it regardless of which outpost executes which region. Per-outpost freeze configuration is structurally wrong, not merely unbuilt (campaigns-rework.md "Pre-existing contradictions" #5), so the honest note is WHERE freezes are declared and what reaches here, not an edit box scoped to a peer.

### §380. `isAbsent`, not `=== null` / `!== null`

`isAbsent`, not `=== null` / `!== null` — the SAME schema class this file already fixed for `config.trustTier`, left half-guarded here. `adoptedObjectId` is required-nullable, and BEFORE ADR-0023 the SDK validated no response, so `undefined` was reachable through the SDK too; SINCE ADR-0023 an omitted required key rejects at the boundary and this is defence in depth for every other source of a result. MEASURED with `adoptedObjectId: undefined`: `!== null` was TRUE, so the panel emitted `<p data-testid="reconcile-adopted">Adopted <code></code> as this domain's own configuration — it journals down to the outpost from now on.</p>` — an EMPTY element inside a confident claim about a journaling side-effect — while the `=== null` mirror below simultaneously suppressed the honest `reconcile-removed-none` branch, so the panel reported an adoption that did not happen AND withheld the statement that nothing did.

### §381. THE RECONCILE PANEL

THE RECONCILE PANEL. Shown when the peer has more than one live claimant row (an authority conflict) — and reachable from the unverified-shadow notice above, which is the single-row case where adoption is the recovery.

Every destructive choice states its consequence BEFORE it is taken, per claimant, from that claimant's own provenance.

### §382. THE DEFAULT IS OFFERED ONLY WHERE IT CANNOT BE THE DESTRUCTIVE CHOICE

THE DEFAULT IS OFFERED ONLY WHERE IT CANNOT BE THE DESTRUCTIVE CHOICE — one rule, not a second copy of the confirmation machinery. It stands down for either reason: * the survivor is INDETERMINATE (two rows of equal authority, tie broken server-side), so any preview would be a guess; or * reconciling with it would drop a row THIS DOMAIN AUTHORED, whose tombstone PROPAGATES to the outpost. That choice must be made explicitly, per row, behind the checkbox below. As it happens the second condition is implied by the first today (a UNIQUE top-ranked survivor means every dropped row ranks strictly lower, hence is foreign, hence never propagates) — it is written out anyway so a later change to `authorityRank` cannot silently reopen the bypass.

### §383. The wired-up Configuration card

The wired-up Configuration card — for a PAIRED PEER (`status`, the peer-status row) or, since pipeline-substrate-registry-scan.md §10.5, for THIS INSTANCE'S OWN DOMAIN (`selfDomain`): the HQ outpost, whose record binds `peerDomainId` = this instance's domain id and has NO peer row. Exactly one of the two is given. The config half (declare / tier / reconcile) is identical for both — it keys on the domain id alone; the poke-mode card is a PEER-ROW flag and is rendered only for a peer (there is no peer row to flag for self, and an instance never pokes itself).

### §384. Hazard closed: the editor was gated on existence alone

HAZARD, CLOSED — the tier editor used to be gated only on a config OBJECT existing, never on the PEER's own role. `assertOutpostPeerBinding` refuses (400) an UPDATE against a peer whose role is not `outpost` exactly as it refuses a CREATE (`outpost-binding.ts`, ADR-0004) — so a STRAY config object bound to a retrans peer (role changed post-declare; nothing deletes the row when that happens) rendered a live, clickable Save button the server would refuse confusingly. The self/HQ path (`status` absent) carries no peer role at all and is untouched — this guards only the peer path, on the SAME role the create door already checks.

### §385. The same premise the reconcile attaches, on the other door

THE SAME PREMISE THE RECONCILE MUTATION ATTACHES, ON THIS PANEL'S OTHER WRITE DOOR (R2, PR #156 residual). The operator reads a tier off `config` and edits it — a prediction from the row on screen, exactly like reconcile's claimant preview — but until this fix the call carried no `expectedVersion`, so a concurrent edit (another operator, or this same peer's `keep` reconcile) was silently overwritten: `updateObject` has always accepted the precondition (`packages/schemas/src/federation.ts`'s `UpdateOutpostConfigRequestSchema`), the PATCH route has always declared its 412, and NOTHING on the write path needed to change — only this call site was leaving its premise unstated. `config.version` is read from the same query result the rendered form derives from, so the request cannot be checked against a different world than the one on screen.

### §386. The precondition, attached where every reconcile passes

THE PRECONDITION, ATTACHED WHERE EVERY RECONCILE THIS PANEL ISSUES PASSES THROUGH.

The panel predicts an outcome from `claimants` and then asks the server to act — but the server derives that outcome from the rows it reads INSIDE its own transaction, which is a different moment. `?ifClaimant=<objectId>:<version>` is that prediction's premise, sent with the request and compared as a set, so a world that moved is a 412 that WROTE NOTHING rather than a 200 that did something else. Both failure directions are covered by this one attachment, which is why it lives on the mutation and not on a button: * the ADOPT-SHADOW control below (`TrustTierCard`'s `onReconcile`) sends no `keep`, so the server re-derives the survivor — a locally-authored row that appeared since this query resolved outranks the shadow, and the operator's entered value is DROPPED while the button promised it would be kept; * naming the shadow with `keep` instead makes that same concurrent row surplus, and removing a row THIS domain authored journals a tombstone that PROPAGATES to the outpost — the removal this panel elsewhere refuses to perform without an explicit confirmation.

The token is built from `claimants` — the exact array the preview above was computed from — so the request cannot be checked against a different world than the one on screen.

### §387. A precondition failure means the list on screen is stale

A 412 says the claimant list on screen is stale, so REFETCH it: the refusal's own text names what moved, and the preview beside it must be the new world, not the one that was refused.

R3 (PR #156 residual) — THIS PANEL REFETCHES; IT DOES NOT RE-RENDER THE CARRIED PREVIEW. `reconcileStaleClaimants(err)` is used ONLY as a 412 detector here — its return value (the fresh `claimants` the refusal carried) is discarded, and `invalidate()` opens a second round trip and a second, if narrower, staleness window instead. `scp federation outpost reconcile` (`packages/cli/src/cli.ts`) takes the other branch: it re-previews straight from the carried list, no second read. Both are correct — a second stale press here is refused again, since the refetch is what the next token derives from — but they are not the same behaviour, and the "no second round trip" rationale on `preconditionFailed` (`apps/server/src/errors.ts`) and on `OutpostReconcileStaleProblemSchema.claimants` (`packages/schemas/src/federation.ts`) describes the CLI's path, not this one.

## `apps/web/src/routes/outpost-dashboard.test.tsx`

### §388. pipeline-substrate-registry-scan.md §10.6 on the OUTPOST DASHBOARD

pipeline-substrate-registry-scan.md §10.6 on the OUTPOST DASHBOARD — the one `SourceMapping` consumer the first §10.6 census missed: it captioned every mapping held on the site "domain- specific" BY CONSTRUCTION (site-role inference), never reading `scope`/`mirrorOfShared`. A mapping declared `scope: global` (the API accepts it on any site) or a `mirrorOfShared` row is not domain-specific, so the caption now states the held count (a fact) and ONLY the labels the rows actually declare.

MUTATION (applied alone, then reverted): count `held` as `domain` regardless of `scope` → the "declared labels only" case FAILS (`1 domain-specific` for an undeclared row).

## `apps/web/src/routes/outpost-dashboard.tsx`

### §389. THE OUTPOST SITE'S HOME

THE OUTPOST SITE'S HOME (outpost-ui.md §9.3/§9.3a, owner decisions 2026-08-14) — a small, component-level dashboard, not the commander's org-wide one:

```text
the deployment targets THIS OUTPOST CONTROLS
  → the components placed on each
    → each component's INPUTS HELD HERE to its one pipeline — the repos this domain holds for
      it and infra/config bindings (network config, CIDR bands, the cluster shared by this
      domain's instances) alongside the shared inputs whose source is opaquely "the commander".
      Whether a held repo is domain-specific, global or a mirror is READ off the mapping's own
      `scope`/`mirrorOfShared` (pipeline-substrate-registry-scan.md §10.6) — this page used to
      caption every held mapping "domain-specific by construction", which a `scope: global`
      or `mirrorOfShared` row makes false.
```

The everyday case is a SHARED component (commander-origin replica) carrying inputs held here. Domain-local COMPONENTS (ADR-0031/M20 — genuinely domain-only software) remain valid but RARE, so they are a secondary section, not the headline. The stat that matters is "components on this outpost's targets with inputs held here", per COMPONENT.

"Controls" is READ, not inferred: a target is this outpost's when its `originDomainId` equals this instance's `federation_self.domainId` — the same fact `coordination/component-pipeline.ts`'s `maintainedBy.isSelf` states per stage. A commander-origin target that has been replicated here is NOT this outpost's; it appears (honestly) as "maintained by <peer>" in the pipeline views and is deliberately absent from this page.

"Domain-specific IaC/CaC" = executor bindings of Type `infrastructure` / `configuration` (ADR-0007's facet) whose target is one of the above, or whose bound object is domain-local (ADR-0031). Global IaC/CaC — bindings on commander-origin objects — is the commander's and stays off this page for the same reason its targets do.

Nothing here reads the instance's ROLE to decide what to render — the SHELL picked this page by role (§9.2), and inside it every row keys on data. If this outpost controls no targets yet, the page says so and points at the setup lane; it does not go looking for the commander's targets to fill the space.

### §390. What this domain holds for one component, read off labels

What this domain holds for ONE component, READ off each mapping's own labels (pipeline-substrate-registry-scan.md §10.6: `scope`/`mirrorOfShared` are declared, never inferred — nothing here infers a scope from the site's role). `held` is the plain fact (mappings this instance holds for the component); the other three are the DECLARED labels among them, each counted only when a mapping actually carries it. Before §10.6 this page captioned every held mapping "domain-specific" by construction; a mapping declared `scope: global` (the API accepts it on any site) or a `mirrorOfShared` row is not domain-specific, so the caption now says only what the rows say. Exported for the test file.

### §391. Every source mapping this instance holds is an input HELD HERE

Every source mapping this instance holds is an input HELD HERE — mappings never federate (ADR-0031 §Context; outpost-ui.md §9.3a), so the commander's own rows are structurally absent and nothing needs filtering out. Whether a held mapping is domain-specific, global or a mirror is READ off its `scope`/`mirrorOfShared` (§10.6), never assumed from being held on this site. Fanned out per kind the same way /setup does; the kinds mirror the pipeline's source-mapping form.

## `apps/web/src/routes/outpost-detail-status.test.tsx`

### §392. The detail page's first section, and what it claimed

`OutpostStatusCard` — the per-outpost detail page's FIRST section, and until now the only exported component on this branch with no test of any kind.

WHAT THIS FILE OWNS, and why it is not a duplicate of `outposts-honesty.test.tsx`: that file pins the OVERVIEW row. This card renders the same cells on a different page, and the failure mode it missed is not a wording failure but a CRASH. `recentTransfers` is required-not-optional by `FederationPeerStatusSchema` and BEFORE ADR-0023 the generated SDK validated no response, so a server that omitted the key reached `transfers.length` on `undefined`. On the overview that throw kills one row's page; here the card is the first child of the detail route, so the throw took Status AND Settings AND Configuration down together — a white screen where three sections should be. SINCE ADR-0023 that body rejects at the SDK boundary instead; these cases drive the CARD directly, which is the only level at which the card's own guard can be pinned.

The guard therefore has to be pinned by RENDERING with the key absent, not by reading the source: removing `?? []` from `outpost-detail.tsx` must make the first test below throw.

`Link` is stubbed for the same reason as in `outposts-honesty.test.tsx` — `useRouter` throws outside a `RouterProvider`.

## `apps/web/src/routes/outpost-detail.tsx`

### §393. `/federation/outposts/$peerDomainId` — M16.2 phase B, one outpost

`/federation/outposts/$peerDomainId` — M16.2 phase B, one outpost.

THE AUTHORITY SPLIT IS THE PAGE'S STRUCTURE, not a footnote on it (ADR-0022). An outpost exists TWICE in a commander's database and each half owns disjoint facts, so the page has one section per half and each section names the door it writes through:

```text
* STATUS (this file, below) — the reading, from `GET /federation/status`. Read-only.
* SETTINGS (B2) — the `federation_peers` ROW: identity, mTLS/transport, reachability. Written
  through the structurally KEYLESS `PATCH /v1/federation/peers/{id}`, never through pair/re-pair
  (a re-pair with a different `publicKey` is a KEY ROTATION that hard-revokes the old key).
* CONFIGURATION (B3) — the `outpost` GRAPH OBJECT: the commander-declared `trustTier`, which
  rides `object_upsert` down to the outpost as a read-only replica.
```

Consumes ONLY the generated SDK (charter principle 3).

### §394. THE HQ OUTPOST'S own card

THE HQ OUTPOST'S own card (pipeline-substrate-registry-scan.md §10.5; formerly "co-located" — GLOSSARY, ADR-0021 D7) — rendered when the route's id is THIS instance's own trust domain. There is no peer row behind it, so NONE of the status cells apply (nothing syncs to or from self, no transport, no poke): the card states what `federation_self` and `FederationStatusResponse.selfOutpost` actually know and nothing more — the same discipline as the Outposts page's self-domain panel.

## `apps/web/src/routes/outpost-settings.test.tsx`

### §395. The settings form writes through the keyless door

M16.2 phase B (B2) — THE SETTINGS FORM WRITES THROUGH THE KEYLESS DOOR, on every PR.

THE DEFECT THIS PREVENTS. `POST /federation/peers` REQUIRES `publicKey` and treats a DIFFERENT value as a KEY ROTATION: it supersedes the peer's current key window and hard-revokes the old key at the applied-sequence anchor. A settings form that reads a peer, changes one field and re-pairs therefore rotates that peer's trust anchor — with a 200, and no signal anywhere. Phase A built `PATCH /v1/federation/peers/{id}` (structurally keyless) for this form; this file pins that the form actually uses it.

THE OTHER HALF OF THE PROOF is server-side, in `apps/server/src/federation/peer-patch.integration.test.ts` ("B2: the WHOLE settings-form save …"), which sends this form's full field set against a real Postgres and asserts `federation_peer_keys` is byte-identical afterwards: no new window row, the existing row's `superseded_at` still NULL. The two halves meet at `PEER_SETTINGS_PATCH_KEYS`, asserted below to be a subset of the PATCH body's own schema — so the field set this form can send is checked against the contract rather than against a comment.

### §396. The text an operator actually reads

The text an operator actually reads — every tag stripped out (so a match cannot be satisfied by an attribute or a `title` tooltip instead of the visible copy), the apostrophe entity `renderToStaticMarkup` emits for a literal `'` decoded back (so an assertion can be written the way the copy is actually read), and whitespace collapsed (tag stripping otherwise leaves doubled spaces at every element boundary, e.g. around <strong>).

### §397. Y4 — THE X7 CLASS, CLOSED FOR `syncScope`

Y4 — THE X7 CLASS, CLOSED FOR `syncScope`.

`syncScope` is required-not-optional on `FederationPeer` and BEFORE ADR-0023 the SDK validated no response, so `peer.syncScope.mode` was a bare dereference of a promise nothing enforced at runtime — the same read that white-screened the outposts pages. Here it would kill the Settings card, which is the only door an operator has to fix the peer whose response is malformed.

SINCE ADR-0023 a body omitting `syncScope` no longer reaches this card through `client.federation.status()` — it rejects at the SDK boundary and `/federation` renders the diagnosis (`federation-status-crash.test.tsx` pins that). These cases drive the COMPONENT directly, which is the only level at which the guard itself — as opposed to the boundary in front of it — can be pinned, and the level that still decides what happens for any other source of a peer (a cached snapshot, a future unspec'd feed).

The guard must not become the OTHER failure: substituting a default mode would tell the operator the peer exports everything, and — since the patch builder omits an UNCHANGED mode — a form left alone would keep whatever the real scope is while displaying a different one.

## `apps/web/src/routes/outpost-settings.tsx`

### §398. M16.2 phase B (B2) — PER-OUTPOST SETTINGS

M16.2 phase B (B2) — PER-OUTPOST SETTINGS: the `federation_peers` ROW half of the authority split (ADR-0022 clause 1). Identity, mTLS/transport, reachability. Local to this side, never journaled.

THE ONE THING THIS FILE EXISTS TO GET RIGHT: it writes through `PATCH /v1/federation/peers/{id}` — the structurally KEYLESS door — and never through `POST /federation/peers`. A re-pair REQUIRES `publicKey`, and a DIFFERENT value there is a KEY ROTATION that supersedes the current key window and hard-revokes the old key at the applied-sequence anchor. A settings form built on the pair route rotates a peer's trust anchor the first time it drops or mangles the key — silently, with a 200. Phase A built the keyless PATCH for exactly this form; using it is not an optimisation, it is the requirement.

WHAT IS DELIBERATELY NOT EDITABLE HERE: * `role` — an identity-level assertion made at pairing (the PATCH body has no `role` at all; `peer-patch.integration.test.ts` measures a smuggled `role` being ignored). * key material — see above. Rotation stays a deliberate CLI re-pair. * `pokeMode` — it IS a peer-row field and the same PATCH carries it, but it is CONSENT-shaped and belongs with the other per-outpost configuration (B3, `outpost-configuration.tsx`), where it can be labelled "this side only" next to the unilateral-sparse warning. Two forms writing one field from two places is how a UI ends up disagreeing with itself. * an `s3-compatible` delivery target — its endpoint/bucket are operator-allowlisted (`SCP_DELIVERY_S3_ENDPOINTS`) and its credentials live in the vault; this form would have to round-trip a shape it cannot fully render, and a partial round-trip REPLACES the stored target. It is shown read-only with a pointer to the CLI, and the patch OMITS the field so the server preserves it.

### §399. The four sync-scope modes this form can SET

The four sync-scope modes this form can SET. `custom` is absent on purpose: it carries a `labelSelector` this form has no editor for, and offering it would mean writing `{mode:'custom'}` with an empty selector — a silent narrowing of what the peer receives. A peer already on `custom` keeps it (the mode select shows it, and an unchanged mode OMITS `syncScope` entirely, which the server reads as preserve).

### §400. The peer's current sync-scope mode, or undefined

THE PEER'S CURRENT SYNC-SCOPE MODE, or `undefined` when the server did not send `syncScope` (Y4).

`syncScope` is required-not-optional on `FederationPeer`, and BEFORE ADR-0023 the generated SDK validated NO response, so `peer.syncScope.mode` was a bare dereference of a field nothing enforced at runtime — the SAME read that white-screened the outposts pages, and here it would kill the Settings form (and with it the only door an operator has to fix the peer).

WHAT ADR-0023 CHANGED, AND WHAT IT DID NOT — the canonical statement of the rule, since this comment is the one the ADR cites. The SDK now runs a generated zod schema over every 2xx JSON body of every SPEC'D operation, so a body missing `syncScope` no longer RESOLVES a query: it REJECTS it, once, naming the operation and the field. Three consequences, all live: 1. A required field arriving through the SDK is now enforced at runtime, so a guard like this one is defence in depth rather than the only thing standing between a page and a TypeError. 2. The failure moved, it did not vanish. Every page that reads through the SDK must render its `isError` state, or the diagnosis dies in the query cache and the operator sees a blank card — the regression this round fixed (`../components/query-error.tsx`). 3. THE BOUND IS THE SPEC'D OPERATIONS — which, since the SSE API-parity work, is every byte the SPA parses off the network. `GET /events/stream` was the one exception (absent from `openapi.v1.json`, so `lib/use-event-stream.ts` cast raw JSON); it is declared now, and each frame is validated by the same generated validator as any 2xx body.

`undefined` RATHER THAN A DEFAULT, deliberately. Substituting `"full"` would be the fabrication class this whole branch exists to remove: it would tell the operator the peer exports everything, and — because the patch builder omits an UNCHANGED mode — a form left alone would silently keep whatever the real scope is while displaying a different one. An unknown mode is unknown.

### §401. THE PATCH BODY, built from the draft

THE PATCH BODY, built from the draft — ABSENT MEANS PRESERVE, everywhere.

Every unchanged field is OMITTED rather than echoed back. That is not tidiness: echoing `syncScope` back would flatten a `custom` scope's `labelSelector` (this form cannot render one), and re-declaring a scope of `full` fires the G8 cursor-re-anchor permit for a save that changed only the peer's display name.

The returned object is typed `UpdateFederationPeerRequest`, which HAS NO KEY FIELDS — so this function is incapable of expressing a rotation even if it wanted to.

### §402. The ONE function the Save button runs

The ONE function the Save button runs: build the body, then send it through the keyless PATCH.

Build and send live together on purpose. Testing them apart would leave the join — "the form sends what the builder built, through the door the builder was written for" — unpinned, which is exactly where a re-pair could slip back in.

### §403. The Settings form

The Settings form. EXPORTED for `outpost-settings.test.tsx`, which renders it directly — the "no key material, no role" property is a rendering property as much as a request-body one.

`onSave` is injected so the test can drive the real submit path against a double; the page below passes the real SDK.

## `apps/web/src/routes/outposts-co-located.test.tsx`

### §404. pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST

pipeline-substrate-registry-scan.md §10.5 — THE HQ OUTPOST (formerly "co-located"; GLOSSARY, ADR-0021 D7 — the file name, the `coLocated` prop and the test ids keep the older spelling; the RENDERED copy says "HQ outpost") on the M16 Outposts surfaces.

A self-bound `outpost` record (`peerDomainId` = THIS instance's own domain) has NO `federation_peers` row, so it can never be a `peers[]` entry and no peer-keyed cell can render it. The census of every join from an outpost record to its peer row on the web side is: * the Outposts overview's table (peer rows) — self is NOT a row; its record is read off `FederationStatusResponse.selfOutpost` into the self-domain panel (`SelfOutpostLine`); * the per-outpost detail page (`findPeerStatus`) — for self's own id it renders the HQ-outpost card + the configuration section keyed on `selfDomain`, not "No peer … is paired"; * the configuration section's DeclareConfigCard (peer role check) — the `coLocated` variant.

WHAT IS PINNED, and how each would fail * `SelfOutpostLine` states three things three ways: a record (name, tier, the marker `HQ outpost · this instance`), `null` = "no outpost registered" + a declare link, `undefined` = "not reported" (an older server) — dropping the undefined arm reads an old server as "none". * The tier of a self record follows the same three-state honesty as a peer row: null → unknown marker, in `unknownFields` → `· unverified`, else the tier. * `SelfDomainPanel` still forbids every peer-row column for self. * `DeclareConfigCard coLocated` renders the declare control with the HQ-outpost copy and does NOT run the peer-role refusal (there is no peer) — but ONLY for `selfRole: "commander"`, the one role the server's self-shape door accepts (`outpost-binding.ts`; measured in `outpost-config-sync.integration.test.ts`): every other role renders the refusal and no control. Without `coLocated` a `commander`-role peer is still refused (the existing case in outpost-configuration.test.tsx). `SelfOutpostLine`'s `null` arm offers the declare link on the same condition and otherwise reads `declared at the commander`.

MUTATION LOG (each applied ALONE, then reverted) | Mutation | Result |
| `SelfOutpostLine`: treat `undefined` like `null` | the "not reported" case FAILS | | `SelfOutpostTier`: ignore `unknownFields` | the unverified case FAILS (`data-tier-provenance="declared"`) | | `DeclareConfigCard`: drop the `!coLocated &&` guard and pass `peer={{role:"commander"}}` | the HQ-outpost case FAILS (`config-role-not-outpost`) | | `DeclareConfigCard`: drop the `selfRole !== "commander"` refusal | the "any OTHER role" case FAILS (`config-declare-save` rendered) | | `SelfOutpostLine`: offer the declare link on every role | the "NON-commander role" case FAILS (`self-outpost-declare-link` present) | | `SelfDomainPanel`: stop threading `selfOutpost` | the registered case FAILS (`data-self-outpost="unreported"`) |

## `apps/web/src/routes/outposts-crash.test.tsx`

### §405. `/outposts` MUST REPORT A CONTRACT FAILURE, NOT AN EMPTY TABLE

`/outposts` MUST REPORT A CONTRACT FAILURE, NOT AN EMPTY TABLE (ADR-0023).

WHY THIS FILE EXISTS. `outposts-honesty.test.tsx` owns the RENDERING contract of one row and drives the components directly with `renderToStaticMarkup`. Nothing drove the PAGE. So the `statusQuery.isError` branch in `outposts.tsx` — the branch that decides whether a response-validation failure ever reaches a human on this page — had no test at all, and the failure mode it prevents is precisely the one the SPA is worst at showing: `peers` defaults to `[]` on a rejected query, `outposts.length === 0`, and the card would otherwise render "No outpost or retrans peers are paired yet" — a confident, false statement of federation state produced by a failure the SDK had already diagnosed in full.

WHY IT DRIVES THE REAL SDK. The behaviour spans two packages: `@scp/sdk` turns a malformed 2xx body into an `ScpResponseValidationError`, react-query turns the rejected `queryFn` into `isError`, and this page must RENDER that. Mocking `client` would stub out the first half — the half that decides whether the second half is reachable at all — which is exactly how a guard test becomes a wording test. So a REAL `ScpClient` runs over a stubbed `fetch`: everything from the wire bytes up is production code.

REVERT TESTS: * delete the `statusQuery.isError` branch in `outposts.tsx` → the first two cases fail on the missing `outposts-error` node, and the first also fails on the fabricated "No outpost or retrans peers are paired yet"; * replace `<QueryErrorNotice error={statusQuery.error} …/>` with a fixed string → the second case fails on the missing operation and field name.

### §406. Asserted on the EMPTY-STATE ELEMENT, not on its sentence

Asserted on the EMPTY-STATE ELEMENT, not on its sentence. This previously pinned the literal copy and broke when the wording changed to say "no OTHER outposts" (the self-domain panel now sits above it, so the old sentence had become untrue). The premise this case exists to establish — that the empty branch is reachable, so its absence in the cases above is the error branch winning — is about which branch rendered, and a testid says that without pinning prose.

## `apps/web/src/routes/outposts-honesty.test.tsx`

### §407. The rendering half of the overview's honesty contract

M16.2 phase B (B1) — THE RENDERING HALF of the Outposts overview's honesty contract, pinned by a check that runs on EVERY PR.

WHY A PLAIN VITEST FILE AND NOT A PLAYWRIGHT SPEC (the same reason `service-board-honesty.test.tsx` exists): originally because every E2E job was `main`-only and SKIPPED on pull requests. E2E now runs on PRs and 5z requires it, so the reason is no longer coverage but COST and ALTITUDE — this is milliseconds, needs no browser, and fails with a diff. The server half of this contract is gated on PRs by `apps/server/src/federation/status-honesty.integration.test.ts` and `outpost-handfill-wedge.integration.test.ts`; the rendering half — where a browser can paint an unobservable field exactly like an observed one and undo all of it — needs a gate of its own. `renderToStaticMarkup` renders to a string in the Node environment Vitest already uses: no browser, no DOM library, no new dependency.

WHAT IT OWNS, one clause per phase-A trap: 1. a peer with NO trust tier renders an explicit unknown, and NEVER `commercial`; 2. an UNVERIFIED (hand-filled shadow) tier is visibly distinguished from a DECLARED one; 3. a peer with NO derivable transport renders an explicit unknown, and NEVER `air-gap`; 4. nothing on the page reads as "the outpost has this" — every outbound string is about what THIS side exported, and the two promised-but-sourceless fields (applied-at-peer, health) render as unknowns rather than as blanks.

`Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a `RouterProvider`; routing is covered by the E2E spec against the real router.

### §408. The text an operator actually READS

The text an operator actually READS — every tag (and therefore every attribute, including the explanatory `title` tooltips) stripped out.

This exists because the naive assertion is wrong in a way that matters: a tooltip saying "this is NOT an air-gap posture" contains the string `air-gap`, so a blanket `not.toContain("air-gap")` over the raw markup fails on honest copy while a cell that silently DROPPED the tooltip would pass. The forbidden thing is the CLAIM — the rendered word, and the machine-readable `data-transport-mode`/`data-trust-tier` attributes — which is what these tests assert separately.

### §409. The markup of exactly one tagged element, tags balanced

The markup of exactly ONE `data-testid`-tagged element, tags balanced.

This exists because a whole-row `toContain` cannot tell WHICH cell satisfied it. The two sourceless cells are the always-taken branch of `SourcelessCell` (the server declares `appliedAtPeer` and `healthRollup` for every peer on every response), so an assertion that a cell's CONTENT is the unknown marker has to be scoped to that cell — otherwise a sibling cell's marker keeps it green while this one renders a fabricated reading.

### §410. A peer in the state phase A cares most about

A peer in the state phase A cares most about: PAIRED, with transport configured, but with NO operator-asserted trust tier and NOTHING ever exported to it. Every null below is a null the server explicitly declared, and none of them is an observation.

### §411. `status-repo.ts` emits TWO signals for this one case

`status-repo.ts` emits TWO signals for this one case — `trustTierProvenance: "unverified"` AND `"trustTier"` in `unknownFields` — and `trustTierProvenance` is `.nullable().optional()`, so a response carrying the tier and the declaration but not the provenance is well-formed. Keyed on provenance alone, such a row fell through to the DECLARED badge and was byte-identical to a tier this commander actually asserted.

### §412. THE ROW ATTRIBUTE, WHICH THE PREVIOUS ROUND'S CENSUS WALKED PAST

THE ROW ATTRIBUTE, WHICH THE PREVIOUS ROUND'S CENSUS WALKED PAST (round 3).

Every test above renders `<TrustTierCell>` DIRECTLY, so `<OutpostRow>`'s own `data-trust-tier` was asserted for no tier case at all — and it was bare (`status.trustTier ?? "unknown"`), with no provenance qualifier beside it. This suite's own stated rule (top of this file) is that the forbidden thing is the CLAIM: the rendered word AND the machine-readable `data-*` attribute. So an unverified peer and a declared one emitted a BYTE-IDENTICAL `<tr … data-trust-tier="commercial">`, which is exactly what an E2E selector or any other DOM consumer keys on.

### §413. A `retrans` peer is a STRONGER claim than "unobservable"

A `retrans` peer is a STRONGER claim than "unobservable": this instance can SOURCE the inapplicability itself — `POST /federation/outposts` refuses (400) to bind an `outpost` config object to any peer whose role is not `outpost` (`outpost-binding.ts`, ADR-0004; measured `outpost-object.integration.test.ts`). So a retrans row must NOT wear the same amber unknown-pill a genuinely undecided outpost tier wears — that would understate what is known.

### §414. Red needs a signal that something set up is not working

Red requires a signal that something SET UP to work is not working. The one such signal in this payload is poke-mode enabled with no poke ever received. Transport-unknown is amber, not red — a freshly enrolled peer has no transport yet and a genuinely air-gapped peer may never have one (bundles move by hand, a supported shape, not a failure). The first QA pass shipped transport-unknown as red and every fresh row lit up like a fire drill; this pins the repair.

### §415. …and THIS is the half that actually bites

…and THIS is the half that actually bites. `status-repo.ts` pushes both field names into `unknownFields` for EVERY peer on EVERY response, so the declared branch is the ALWAYS-TAKEN one — yet asserting only the attributes above leaves the branch's rendered CONTENT entirely unpinned: swap `<UnknownHere/>` for the literal `healthy`, or for a `0`, and every attribute assertion still holds. Scope to each cell and pin what an operator READS.

### §416. That count is nullable and optional, so undefined counts

`pendingExportEntryCount` is `.nullable().OPTIONAL()`, so `undefined` is as legal on the wire as `null` — and ADR-0023 does NOT close this one: an omitted OPTIONAL key is contract-legal and passes the SDK's response validation untouched, so this guard is still the only thing between the renderer and `undefined`. Keying the guard on `=== null` alone let that value through and rendered `<span data-testid="outpost-export-backlog"> of this domain's own journal entries…</span>` — an EMPTY number inside confident copy, reading as "nothing pending".

### §417. THE GUARD THAT ORIGINATED THIS WHOLE CLASS, LEFT HALF-PINNED

THE GUARD THAT ORIGINATED THIS WHOLE CLASS, LEFT HALF-PINNED. `lastExportedThroughSequence` is `.nullable().OPTIONAL()`, but no test ever gave it `undefined` — only `null` and `42` — so reverting `isAbsent(...)` to `=== null` kept the suite green while the mutant rendered `<div data-export-state="exported-handoff-unknown">exported through # on never</div>` — the exact fabrication the guard exists to prevent, and worse than the null case because it asserts an export event with no sequence and no date. Its sibling `pendingExportEntryCount` was pinned for BOTH absent forms; this is the other half.

### §418. The reason itself, scoped to its tooltip and matched loosely

THE REASON ITSELF, scoped to the marker's own tooltip and matched LOOSELY. The previous form (`not.toMatch(/Nothing has been exported to this peer yet/)`) pinned one exact sentence, so restoring the untrue explanation in any other wording — "Nothing has been exported yet, so there is no pending-export backlog." — left the suite green. This PR's own thesis is that the COPY IS THE GUARANTEE, so the copy is what is asserted.

### §419. FAIL LOUD BEATS FAIL DISHONEST, BUT A WHITE SCREEN IS NEITHER

FAIL LOUD BEATS FAIL DISHONEST, BUT A WHITE SCREEN IS NEITHER. `recentTransfers` is required-not-optional and BEFORE ADR-0023 the SDK validated no response, so a server that omitted it made `transfers.length` throw a TypeError that took down the ENTIRE table — every honest unknown on every other row with it, which is strictly worse than the fabrication these tests forbid.

WHAT THIS CASE PINS NOW. It renders the ROW directly, so it pins the row's OWN guard and nothing else — which is still the right level for it: the SDK boundary is one source of a `FederationPeerStatus`, not the only one, and reverting the `?? []` must stay red. What it deliberately does NOT claim is anything about the page: since ADR-0023 this body never reaches the row through `client.federation.status()` (it rejects), and what `/outposts` does with that rejection is pinned end-to-end, against the real SDK, in `outposts-crash.test.tsx`.

### §420. THIS DOMAIN as an outpost

THIS DOMAIN as an outpost — ADR-0026 §9.2 / owner decision D3.

The trap this section owns is the mirror of the peer traps above. This domain has NO `federation_peers` row and NO `outpost` object (ADR-0022 splits those two authorities and self holds neither), so every sync-shaped field is unsourceable for it. Rendering it as a table row would mean blanking seven columns — and a blank is exactly what this file exists to forbid. The panel therefore must not print those fields at all, and must not read as a paired peer.

### §421. The byte-relay tag, and the pin that keeps it a read

drizzle/0087 — THE BYTE-RELAY TAG, and the honesty pin that keeps it a READ, never an INFERENCE.

`channel` is the one place a retrans byte-relay hop is distinguished from an ordinary metadata `.scpbundle` handoff (`BundleTransferSchema`'s doc). The forbidden shortcut is deriving it from anything else already on the row — `checksum === null` or the peer's role both correlate with `channel: 'bytes'` in today's fixtures without being it, and a UI that keyed on either would keep "working" right up until a metadata row with a null checksum (a pre-M16.1 row) got mislabelled a byte relay. So three states, three renderings, and the ABSENT case is the one that actually pins the rule: it must render nothing, and it is the case a `checksum`- or role-based shortcut can't tell apart from `'bytes'` without also being told the channel.

## `apps/web/src/routes/outposts.tsx`

### §422. `/federation/outposts` — M16.2 phase B (B1), THE OUTPOSTS OVERVIEW

`/federation/outposts` — M16.2 phase B (B1), THE OUTPOSTS OVERVIEW: every outpost/retrans peer this instance syncs with, in one table.

WHAT THIS FILE IS ACTUALLY ABOUT. Phase A (ADR-0022) spent four review rounds making the `/federation/status` response say only what it can source: an unasserted trust tier is `null` and named in `unknownFields`; a peer with no transport configured is `null`, NOT `air-gap`; every export figure measures WHAT THIS SIDE PUT ON THE WIRE and there is deliberately no applied-at-the-peer field at all. A browser that paints those nulls as blanks — or, worse, as green ticks — undoes every one of those rounds in one render pass. So the rule here is the same rule `service-board.tsx` follows, applied to federation:

```text
AN UNOBSERVABLE FIELD IS AN EXPLICIT UNKNOWN. It is never blank, never a zero, never a default,
and never a success colour — and no string on this page may read as "the outpost has this".
```

Consumes ONLY the generated SDK (`client.federation.status()`), per charter principle 3. Pinned on every PR by `outposts-honesty.test.tsx` (cheaper than the Playwright suite, which also guarantees that must not regress live in plain vitest + `renderToStaticMarkup`).

### §423. True when the server declared this field unobservable

True when the server explicitly declared this peer-status field UNOBSERVABLE (`FederationPeerStatusSchema.unknownFields`) — as opposed to observed-and-empty. `unknownFields` is optional on the wire (additivity): an older server that never declares anything must not be read as declaring everything observable, so `undefined` means "nothing declared", and the per-cell renderers below still refuse to paint a bare `null` as a reading.

### §424. The honest-unknown marker

The honest-unknown marker — the Badge `unknown` tone (design spec §1.5/§2.2), the ONE sanctioned rendering of the honesty pill app-wide, so an operator reads one visual language for "this instance cannot see / is not the authority" everywhere it appears.

Its own testid (`outpost-unknown`) rather than the board's, so the two suites cannot pass on each other's markup.

### §425. "This side's own record

"This side's own record — nothing here observes the peer." (spec §4E) — the ONE canonical sentence replacing the three drifted paragraph variants that used to say this on `/outposts`, `/outposts/$peerDomainId`, and `/federation` separately. A fragment in chrome (copy rule 1); the full rationale lives in the `title` tooltip.

### §426. THE ATTENTION-DOT COLUMN

THE ATTENTION-DOT COLUMN (spec §4E) — a leading at-a-glance triage signal derived ONLY from signals already computed on this row, never a new fetch or a fabricated threshold:

```text
* `danger` (red) — a signal that something set up to work is NOT working: this side is opted
  into poke-mode but has never actually received one (the named unilateral-sparse case
  `outpost-configuration.tsx` also renders, computed the same way here for the overview).
* `warning` (amber) — "worth a look": transport cannot be derived (no base URL or delivery
  target configured), or the trust tier is unset/unverified.
* `nominal` (slate) — nothing above is true.
```

Transport-unknown is DELIBERATELY warning, not danger (first QA pass got this wrong): a freshly enrolled peer has no transport yet, and a genuinely air-gapped peer may NEVER have one — bundles move by hand, which is a supported deployment shape, not a failure. Red on every fresh or air-gap row is the wall-of-amber problem reborn one tier up: when everything is a fire, nothing is. Red therefore requires a signal that a configured mechanism is misbehaving.

### §427. THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE

THE TIER CLAIM AND ITS QUALIFIER, DERIVED ONCE (round 3, the X4 census miss).

`data-trust-tier` is a CLAIM, and this suite's own stated rule is that the forbidden thing is the claim — the rendered word AND the machine-readable attribute. The ROW carried a bare `data-trust-tier={status.trustTier ?? "unknown"}` with no qualifier beside it, so an unverified hand-typed peer and a commander-declared one produced a BYTE-IDENTICAL `<tr … data-trust-tier="commercial">` — and the row attribute is exactly what an E2E selector or any other DOM consumer keys on. The cell inside had been fixed; the row had not, because the census walked the components rather than the attributes.

So both read this. A qualifier that is computed in one place cannot be applied in one place and forgotten in the other.

### §428. A `retrans` peer is a STRONGER claim than "unobservable"

A `retrans` peer is a STRONGER claim than "unobservable" — this instance can SOURCE its inapplicability: `POST /federation/outposts` refuses (400) to bind an `outpost` config object to any peer whose role is not `outpost` (`outpost-binding.ts`'s `REQUIRED_PEER_ROLE`, ADR-0004; measured `outpost-object.integration.test.ts`). So this is not "no tier was asserted" — it is "no tier can EVER be asserted for this peer" — and the two must not share a rendering.

### §429. Trust tier: the field with no source but a keystroke

TRUST TIER — the field with no source but an operator's own keystrokes, and three distinct states that must never be shown alike (ADR-0022):

```text
* NO TIER — `trustTier: null`, declared unknown. Renders the unknown marker. It must NEVER
  render blank and must never render `commercial`: "the operator has not decided" and "the
  operator asserted the lowest tier" are opposite facts, and defaulting one to the other is the
  invented posture this whole milestone exists to prevent.
* DECLARED — a tier this instance is authoritative for (its own local-origin `outpost` object on
  a commander; the signature-verified commander replica on an outpost). A plain badge.
* UNVERIFIED — the only tier available came from a `provenance:'manual'` HAND-FILLED SHADOW
  (DESIGN §13 hand-fill). The value rides the wire, and the server ALSO lists `trustTier` in
  `unknownFields` for exactly this case. Rendering it as a commander assertion is the
  fabrication phase A's review round 4 fixed on the server; this is the rendering half.
```

### §430. THE RETRANS BRANCH, DERIVED ONCE

THE RETRANS BRANCH, DERIVED ONCE. Read off `trustTierMark` — the SAME derivation `OutpostRow` puts on the row's own `data-trust-tier`/`data-tier-provenance`, so the two cannot disagree — never re-checked with a second bare `status.peer.role === "retrans"` here.

Rendered as the §1.5 STRUCTURALLY-EXPECTED-ABSENCE dash, not a badge: "a retrans can never have a tier" is a permanent structural absence (the same class as the spec's own "Layer B unmodeled fields" example), and §1.5 reserves pills for signal — a column of "not applicable" badges on every retrans row is the wall-of-pills problem reborn one tone over. The honesty sentence rides the title, exactly as the dash idiom prescribes; the amber unknown pill below stays reserved for the genuinely-unobservable outpost case, so the two states cannot be confused.

### §431. Two independent signals for one fact, and which is honest

TWO INDEPENDENT SIGNALS FOR ONE FACT, and the honest branch is whichever fires. The server sets `trustTierProvenance: "unverified"` AND pushes `"trustTier"` into `unknownFields` for exactly this case (`status-repo.ts`: `if (trustTier === null || tier?.unverified === true)`; the pairing is documented on the schema field). `trustTierProvenance` is `.nullable().optional()`, so a response that carries the TIER and the DECLARATION but omits the provenance is well-formed — and keying on provenance alone dropped such a row through to the declared badge below, rendering a hand-typed claim BYTE-IDENTICAL to a commander assertion. That is the fabrication phase A round 4 existed to fix, with the honest signal already on the wire and unread. So: OR them. `rowMark` is the same derivation computed above — not re-run — so the not-applicable branch and this one can never drift into checking the role two different ways.

### §432. TRANSPORT MODE — config-derived, never an observation

TRANSPORT MODE — config-derived, never an observation (phase A replaced a `connectivity` field whose `connected` value asserted reachability nobody had measured).

```text
* `dialable` — an https/mTLS base URL is CONFIGURED. It does not say the peer was ever reached;
  the reachability observations are `lastPullAttemptAt`/`lastPullSuccessAt`/`effectiveCadence`,
  rendered beneath it.
* `air-gap` — no base URL, a delivery target: a file/object channel.
* `null` — NOT DERIVABLE, and emphatically NOT air-gap. Either nothing is configured at all, or
  a base URL federation refuses to dial (plain http) is configured. Reading "no transport" as
  "air-gapped" is the same class of fabrication as reading "no tier" as "commercial".
```

### §433. OUTBOUND — PENDING-EXPORT, AND NOTHING MORE

OUTBOUND — PENDING-EXPORT, AND NOTHING MORE.

Every figure here measures what THIS SIDE PUT ON THE WIRE. The commander cannot observe what a peer applied (`sync_cursors` records only what WE applied FROM a peer; `bundle_transfers` export rows are INSERT-only and never advance), so there is no "up to date", no "in sync", no green tick — a zero backlog means only that this side has bundled everything it has authored, which says nothing whatsoever about whether the outpost received or applied any of it.

### §434. The reason must be one that can be TRUE HERE

The reason must be one that can be TRUE HERE. This branch is only reachable after `neverExported` returned FALSE — something HAS been exported to this peer — so the old copy ("nothing has been exported yet") explained the marker with the one fact this code path rules out. What is actually true is narrower: the count is absent or the server declared it unobservable.

### §435. The two promised-but-sourceless columns, kept visible

THE TWO PROMISED-BUT-SOURCELESS COLUMNS, kept VISIBLE as explicit unknowns rather than quietly dropped (the proposal promised both; a reader who remembers the promise and sees no column assumes it is fine).

```text
* `appliedAtPeer` — what the peer applied. ABSENT from the schema by design; there will be no
  such field until M16.4 builds a return path that can observe it.
* `healthRollup` — the observe-enrichment health rollup. ABSENT from the schema: no health signal
  is replicated per peer.
```

Both are named by the server in `unknownFields`. The `false` branch is not decorative: if a future server stops declaring the name (because it grew a real field, or because it regressed), this renders "not reported" — still never a clean reading, and visibly different from the declared case so the change is noticed rather than silently absorbed.

### §436. Shared tooltip copy for the two sourceless columns

Shared tooltip copy for the two sourceless columns (spec §4E: milestone codes stay out of rendered/tooltip copy — the "M16.4" citation that used to sit here moved to this comment). A return-path confirmation that would source `appliedAtPeer` is a named future increment, not a field that exists today. Shared with `outpost-detail.tsx`'s `OutpostStatusCard`, which renders the same two fields with the same honest reason.

### §437. The byte-relay tag beside a transfer row, for one channel

drizzle/0087 — the byte-relay tag beside a transfer row, ONLY for `channel === 'bytes'`. A `'metadata'` channel renders nothing extra (an ordinary `.scpbundle` handoff is today's default reading and needs no callout), and an ABSENT channel (pre-0087 row, or a writer that could not determine it) renders nothing either — provenance here is READ off the ledger row, never inferred from `checksum === null` or the peer's role, both of which are true for plenty of ordinary metadata rows too.

### §438. Recent transfers: the last rows of this instance's ledger

RECENT TRANSFERS — the last five rows of THIS instance's own per-hop ledger, labelled as such.

Deliberately NOT rendered as a "pending transfers" COUNT: `recentTransfers` is capped at five by the server, so any total derived from it would be a number with no source. A `created` EXPORT row means this side produced a bundle; it never advances, because only the RECEIVER can confirm, in its own database.

### §439. THIS DOMAIN, as an outpost

THIS DOMAIN, as an outpost — ADR-0026 §9.2, owner decision D3: "a commander acting in an outpost capacity IS an outpost and must be shown as one, exempt from polling and poking itself."

Rendered as its OWN panel rather than a row in the table below, and that is the whole design. ADR-0022 splits outpost authority between a `federation_peers` row (transport, keys, sync state) and an `outpost` graph object (declared config) — and **this domain has neither**. Seven of the table's nine columns therefore have no source for self: last sync in, exported by this side, applied at outpost, health, transfers, trust tier, transport. Putting self in the table would mean blanking them, which is exactly the failure this file's module doc exists to prevent — an unobservable field must be an explicit unknown, never a blank. A panel has no columns to blank, so it can state only what `federation_self` actually knows.

The exemption from polling is a DATA fact, not a rendering one: this row is synthesised here and is never written to `federation_peers`, because a self peer row would make the federation-sync loop dial its own `base_url` and sync a journal against itself.

Deliberately NOT shown: the stages this domain coordinates. ADR-0026 D10 makes a stage a DERIVED name over a place-role deployment-target, and none of this instance's targets carry the `environment` property that derivation needs — so there is nothing honest to print yet.

### §440. THE HQ OUTPOST'S TIER

THE HQ OUTPOST'S TIER (§10.5; formerly "co-located" — GLOSSARY, ADR-0021 D7) — the same three states `TrustTierCell` renders for a peer row, read off the OutpostConfig itself (this record has no peer-status row): no tier → the unknown marker; a tier the server ALSO lists in `unknownFields` (an unverified hand-filled shadow) → `<tier> · unverified`; else the plain badge. Never blank, never defaulted.

### §441. THE HQ OUTPOST LINE inside the self-domain panel

THE HQ OUTPOST LINE inside the self-domain panel (pipeline-substrate-registry-scan.md §10.5): the `outpost` record whose `peerDomainId` is THIS instance's own domain, read off `FederationStatusResponse.selfOutpost` — the ONE place a self-bound record can be read, since it has no peer row and so no `peers[]` entry. Three states, each stated: * a record  → its name (linked to `/federation/outposts/$peerDomainId` with self's own id — that page renders the HQ record), its tier, and the marker `HQ outpost · this instance`; * `null`    → `no outpost registered` — a stated absence, with the way to declare one (quiet) ONLY when `self.role` is `commander` (the one role the server's self-shape door accepts); on any other role it reads `declared at the commander` with no link; * absent    → `not reported` — an older server that does not resolve it; NOT read as "none".

### §442. The declare offer is made ONLY where the server accepts the write

The declare offer is made ONLY where the server accepts the write: `outpost-binding.ts` takes the self shape only when `federation_self.role` is `commander` (MEASURED — `outpost-config-sync .integration.test.ts`: an outpost-role instance is 400'd both before and after the replica arrives). On any other role the record is the commander's, and the honest line says so instead of offering a door the server refuses.

## `apps/web/src/routes/plugins-executor-type.test.tsx`

### §443. A2 (docs/proposals/outpost-ui.md §3)

A2 (docs/proposals/outpost-ui.md §3): `putBinding` used to send NO `type` at all — a silent default to 'configuration' with no signal to the operator that a choice was even being made. The fix has two testable halves, and Radix's `SelectContent` portals its items (rendering nothing under `renderToStaticMarkup` — `domain-local.test.tsx`'s precedent), so they are pinned separately rather than by reading a rendered option list back out of static HTML:

```text
1. `ExecutorBindingTypeField` renders a real field (label + trigger + help text) — extracted
   out of `ConfigureDialog`'s Dialog/Portal specifically so it CAN be asserted statically.
2. `buildExecutorBindingPayload` is the pure shape of the actual request; every Type the field
   offers is exercised through it, proving the wiring rather than the DOM.
```

## `apps/web/src/routes/plugins.tsx`

### §444. `/plugins` — the M7 plugin-configuration surface

`/plugins` — the M7 plugin-configuration surface (BUILD_AND_TEST.md §8 M7 item 5: "plugin config schemas surfaced as validated config forms in UI + CLI"; DESIGN.md §11: "config schemas auto-surface as validated config forms in API, CLI, and UI... plugin authors get interface parity for free"). Consumes ONLY `client.plugins`/`client.executors`/`client.notifications`/ `client.discovery` (the generated SDK) — same API-first parity as every other page.

The form itself (`SchemaForm` below) is deliberately a MINIMAL JSON-Schema-driven renderer, not a general one: it handles exactly the flat `{type: object, properties: {string|integer|number| boolean}}` shape every M7 plugin manifest actually declares (packages/plugins/*\/src/index.ts's `manifest.configSchema`) — nested `oneOf`/`anyOf`/`$ref` schemas are out of scope for this milestone (no bundled plugin needs them). `secretRefs`/`allowedHosts` are NOT part of any plugin's `configSchema` (they're binding-level, not plugin-level, fields — db/schema.ts's M7 section) so they get their own fixed fields below rather than being schema-driven.

### §445. One input per top-level schema property, untyped values

Renders one input per top-level schema property, tracking values as an untyped record the caller coerces on submit (`coerceConfigValues`) — booleans/numbers round-trip through a plain HTML input's string value until then, same pattern the CLI's own `--config <json>` flag sidesteps entirely by just taking raw JSON; the UI form's whole point is not requiring an operator to hand-write JSON for the common case.

### §446. A discovery proposal, summarized (spec §4E)

A discovery proposal, summarized (spec §4E) — a scannable action/type/name-or-urn table with a counts headline, raw JSON behind a "View raw" toggle instead of always dumping the whole proposal. Discovery only ever proposes CREATEs (`DiscoveryProposalSchema` has no update/delete shape), so every row's action reads "create".

### §447. Shapes `PUT /executors/{idOrUrn}/binding`'s body

Shapes `PUT /executors/{idOrUrn}/binding`'s body (A2, docs/proposals/outpost-ui.md §3) — pure so the Type wiring is testable without a live Dialog/mutation. `type` is now ALWAYS included, deliberately: the bug this closes was never that `configuration` was a bad default, it was that `putBinding` sent no `type` at all — so an operator reading their own binding back could not tell whether "configuration" was a choice or a silence. Sending it explicitly, every time, is the fix; the Select just makes the value the operator's own instead of the server's guess.

### §448. THE BINDING'S ROUTING TYPE

THE BINDING'S ROUTING TYPE — A2. Extracted out of `ConfigureDialog` so it (and its option set) can be exercised directly: Radix's `SelectContent` portals its items, so the option list itself cannot be asserted from a static render (`domain-local.test.tsx`'s precedent) — this component at least makes the field's PRESENCE, label, and help copy testable without a live Dialog, and `buildExecutorBindingPayload` above covers the value actually reaching the request.

`ExecutorTypeSchema.options` — never a hand-copied literal list — so a future Type (D4, ADR-0007) appears here automatically instead of needing a second edit.

## `apps/web/src/routes/registry-detail.test.tsx`

### §449. Two provider-free pieces threaded onto the detail page

REGISTRY DETAIL — two new, provider-free pieces threaded onto `RegistryDetailPage` this round (`RegistryDetailPage` itself needs a live router for `useBasePathParam`/`useIdOrUrnParam`, so it is not mounted directly here — the house pattern `admin-governance.tsx`/`admin-dependencies.tsx` already use for their own dialogs and views: export the piece that carries the real logic, thread the SDK verb in as a prop, test THAT).

governance-reach-on-containment-move.md §9.4 Q4 follow-up — the "governed here" line: - `enforced: true` with rungs renders the NEAREST rung (last = deepest, per the schema doc's org-root-first ordering) with "+N more" naming the rest in the tooltip; - `enforced: true` with NO rungs (the instance rung alone) names "the instance level" instead of a rung that does not exist; - pending / errored / `enforced: false` all render NOTHING — mutation: render on any of those three → RED (the "absence makes no claim" pin) — each is its own case below; - the fetch fires exactly ONCE per mount (spy call count) — mutation: fire on every render → RED.

Delete… (owner decision 2026-08-18, every registry type): - the confirm gate requires the object's OWN NAME typed back EXACTLY — mutation: drop the gate (always enabled) → RED (a case types a near-miss and asserts Delete stays disabled); - a refusal (409 container-delete guard / 403) renders the server's sentence VERBATIM (`problem.detail`, not the RFC 9457 `title`) and the dialog stays open — mutation: read `.message` instead of `.problem.detail` → RED; mutation: close on error → RED; - success calls `onDeleted` exactly once and nothing is removed optimistically before it does.

## `apps/web/src/routes/registry-detail.tsx`

### §450. `/{basePath}/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2)

`/{basePath}/{idOrUrn}` (BUILD_AND_TEST.md §8 M2 item 2) — object properties/labels, owners (if ownable), consumes/depends-on edges (services/components), and a link into the graph explorer rooted at this object. No Decision/"Why?" UI — explicitly deferred to M4.

### §451. Is this object a read-only replica of another domain's

M16.3 P2 (REMEASURED): is THIS object a read-only replica of another domain's config? It is used ONLY to render the provenance badge below — NOT to gate the cards. Measurement (`apps/server/src/federation/foreign-origin-writes.integration.test.ts`) showed the server accepts every write those cards offer against a foreign-origin object; the two writes it does refuse are keyed on a DIFFERENT row's origin (the `contains` edge, the merge loser), so each card derives its own gate from the row the server actually guards. See `lib/replica-origin.tsx`'s module doc for the full measured table.

### §452. Properties, type-aware (spec §4E)

Properties, type-aware (spec §4E): scalar values (string/number/boolean/null) render plainly in a KeyValueList; nested objects/arrays collapse behind one "view raw" toggle rather than always dumping the whole bag as JSON. No default JSON dump for an object with only scalar properties.

### §453. Owners/consumes/depends-on, resolved to name + type badge + link

Owners/consumes/depends-on, resolved to name + type badge + link (spec §4E) — driven by `client.graph.traverse`'s resolved neighbor objects rather than bare relationship rows. An edge `traverse` could not resolve to an object (its endpoint exists but was not returned — e.g. a foreign domain that does not replicate it here) falls back to the raw id in mono, per spec, rather than silently dropping the edge.

### §454. The component's owning service (M12 P5b)

The component's owning service (M12 P5b) — shows the current `contains` parent (or "unassigned" for an imported orphan) and a selector to assign or atomically move it. `setService` is idempotent, so re-selecting the same service is a no-op.

### §455. The one gate here, keyed on the containment edge

M16.3 P2 (REMEASURED) — the ONE gate here, and it is keyed on the `contains` EDGE, not on the component. `components-repo.ts`'s `setComponentService` soft-deletes the current edge before creating the new one, and `deleteRelationship` refuses a foreign-origin edge (409). An ASSIGN (no current edge) is a pure `createRelationship`, which never consults its endpoints' origins: `foreign-origin-writes.integration.test.ts` measures BOTH "ASSIGN ... SUCCEEDS even when the COMPONENT is foreign-origin" and "MOVE across a LOCALLY-originated contains edge SUCCEEDS even when the COMPONENT is foreign-origin", against "MOVE across a FOREIGN-ORIGIN contains edge 409s". Gating on the component's own origin (the first cut) blocked two writes the server accepts and missed the one it refuses.

### §456. A target's executor bindings (M12 P5c)

A target's executor bindings (M12 P5c) — one per pipeline (infra/software). Lists each binding with its module/instance and lets an operator DETACH it or RELABEL which pipeline it drives. This is the UI half of the P5c binding primitives; creating a binding still lives on the Plugins page.

DELIBERATELY UNGATED ON FEDERATION ORIGIN (M16.3 P2, remeasured). An executor binding is per-(org, target, type) LOCAL operational config: `db/schema.ts`'s `executor_bindings` has no `origin_domain_id` column, it is never carried in a federation journal, and `routes/executors.ts`'s PUT/DELETE/PATCH handlers check only `object:write` RBAC on the target — they never read the target's `originDomainId`. `apps/server/src/federation/ foreign-origin-writes.integration.test.ts` measures all three SUCCEEDING against a genuinely foreign-origin target. Disabling them (the first cut of this milestone) broke the documented multi-region workflow — DESIGN.md §12.6 / BUILD_AND_TEST.md M15.6: "a region is a deployment-target ... its per-region Argo CD is an ordinary per-region executor binding", i.e. an outpost binding its OWN local Argo CD to a target that is commander-origin from where it sits. It was also internally inconsistent with `plugins.tsx`'s bind form, which creates bindings against any target with no origin gating at all: bind-but-never-detach.

### §457. Merge another component into this one (M12 P5d)

Merge another component into this one (M12 P5d) — the driving-case fold of a freshly-imported, binding-only duplicate. Picks a LOSER component; on merge, its executor bindings move here and it is soft-deleted. The server rejects a binding-type collision (relabel one first) or an in-flight change, surfaced inline.

### §458. The one gate here, and it is keyed on the loser

M16.3 P2 (REMEASURED) — the ONE gate here, and it is keyed on the LOSER. `mergeComponents` soft-deletes the loser via `deleteObject`, whose single-writer guard 409s on a replica: `foreign-origin-writes.integration.test.ts`'s "merge 409s when the LOSER is foreign-origin". The SURVIVOR's origin is NOT gated — the only write against it is `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings`, and the same test measures "merge SUCCEEDS when the SURVIVOR is foreign-origin". A foreign-origin loser is rendered DISABLED + EXPLAINED rather than silently dropped from the list (the first cut filtered it out), so an operator can see the candidate and learn why it can't be folded in here.

### §459. The rendered line itself

The rendered line itself — pure, off an already-resolved `GovernanceMoveEnforcement`. Exported for the test: given `enforced: true`, names the NEAREST rung on this object's chain (rungs arrive org-root-first per the schema doc, so the last entry is nearest — "+N more" in the tooltip names the rest); given `enforced: true` with an EMPTY rungs array (the instance rung alone is doing the work — see `GovernanceMoveEnforcement`'s own doc on the OR), names the instance level instead of a rung that does not exist. Callers must not invoke this when `enforced` is false — there is nothing honest to say short of "not enforced here", which is not what this line is for (silence already says that).

### §460. Wires the explain read

Wires the explain read (`GET /objects/{type}/{idOrUrn}/governance-move-enforcement`) to `GovernedHereLine`, provider-free (`fetchEnforcement` threaded in) so it is testable off a spy with no route/client mocking. `queryKeyExtra` is the page's own `detailKey` — keying the read off it (rather than off nothing) is what makes the fetch happen exactly ONCE per object shown, cached by TanStack Query like every other read on this page.

Pending, errored, or a successful `enforced: false` all render NOTHING — the line makes a claim only when it has one to make; absence here is never itself a claim.

### §461. Verbatim server sentence for a delete refusal

Verbatim server sentence for a delete refusal — the container-delete guard's 409 (children, placements, named with a remedy) or a plain 403 both carry the whole explanation in `problem.detail`; `.message` is only the RFC 9457 `title` ("Conflict", "Forbidden"), which is why this reads `.problem?.detail` first, exactly `admin-governance.tsx`'s `governanceMoveWriteRefusal` does for the sibling refusal class.

### §462. The confirm dialog's body, portal-free

The confirm dialog's body, portal-free — exported for the test. Requires the object's OWN NAME typed back (destructive-act gate, the `outposts.tsx`/`component-pipeline.tsx` precedent this feature has no direct sibling for yet); Delete stays disabled until it matches EXACTLY. A refusal (409 container-delete guard, 403) renders the server's sentence verbatim and the dialog stays open — no navigation, no optimistic removal. Success calls `onDeleted`, which the card below turns into invalidate-and-navigate.

### §463. The card + dialog trigger, threaded provider-free

The card + dialog trigger, threaded provider-free (`runDelete`/`onDeleted`) so the whole flow is testable without a router. Danger-styled per the design system's `destructive` Button variant; placed as the LAST card on the page, since it acts on the whole object every card above describes.

## `apps/web/src/routes/registry-list-nested-domains.test.tsx`

### §464. The domains registry and its nesting, by owner decision

G2 (outpost-ui.md §5(b), owner decision 2026-08-13): the domains registry's create form gains an optional "Parent domain" picker, and wires `domainId` into the create payload only when the operator actually chose one.

Plain `renderToStaticMarkup`, no router — `RegistryListPage` itself needs a router (`useBasePathParam`), so this file pins the two pieces that DON'T: the picker's own conditional rendering (pulled out as `ParentDomainField`, house pattern per domain-local.test.tsx's publish-card empty-string check) and the payload-shaping rule (`buildCreatePayload`, a pure function so the wiring claim is testable without a live mutation).

### §465. OWNERSHIP-SHAPED ORDERING (outpost-ui.md §9, owner 2026-08-14)

OWNERSHIP-SHAPED ORDERING (outpost-ui.md §9, owner 2026-08-14) — the outpost's catalog lists put the containers THIS domain owns first, so an operator finds where to hang shared domain IaC/CaC without scanning past commander replicas. Pinned as a pure function: the rule keys ONLY on `originDomainId` vs the instance's own domain — never on labels or names.

## `apps/web/src/routes/registry-list.tsx`

### §466. The payload's field-inclusion rules, as a pure function

The create-request payload's field-inclusion rules, pulled out as a pure function so the wiring claim ("domainId rides through only when a parent domain was actually chosen") is testable without a router or a live mutation. Mirrors the `domainLocal` field's existing omit-when-unset rule immediately below it — an unset optional field is left OUT of the payload, never sent as `""`/`null`.

### §467. OWNERSHIP-SHAPED ORDERING (outpost-ui.md §9, owner 2026-08-14)

OWNERSHIP-SHAPED ORDERING (outpost-ui.md §9, owner 2026-08-14). On an outpost the catalog lists are dominated by commander replicas (measured: 8 of 9 services on the live outpost were replicas), and the one fact an outpost operator needs — "which containers are MINE, so I can hang shared domain IaC/CaC on them?" — was invisible on the list rows. This sorts DOMAIN-OWNED rows first (origin === self), then everything else, each half keeping the API's order; and it is a pure function so the rule is pinned without a router. It runs on BOTH sites — on the commander almost everything is self-owned, so it is a no-op there in practice; the point is that neither site infers ownership from labels or names, only from `originDomainId`.

### §468. The parent-domain picker, pulled out as its own component

The parent-domain picker itself, pulled out as its own component so the "renders for the domains registry only" claim is testable with a plain `renderToStaticMarkup` — `RegistryListPage` needs a router (`useBasePathParam`) to mount at all, but this piece of markup does not.

`show` is the caller's `isDomainsRegistry` flag rather than a registry object, so the test can assert both branches without constructing a `RegistryConfig`.

### §469. Set only for a service-member registry, and rides through

`service` is only set for a service-member registry; it rides through to `CreateComponentRequest.service`. Cast because the shared client type is the base request. `domainId` is only ever set here for the domains registry — CreateObjectRequest already carries it (packages/schemas/src/objects.ts:39), so no schema change and no generic-client fallback are needed.

## `apps/web/src/routes/service-board-honesty.test.tsx`

### §470. The rendering half of the board's federation-honesty rule

The RENDERING half of the service board's federation-honesty rule, pinned by a check that runs on EVERY PR.

WHY THIS FILE EXISTS ALONGSIDE `apps/web/e2e/service-board-honesty.spec.ts`, which asserts the same distinction end-to-end. It was written when every E2E job was `main`-only and SKIPPED on pull requests, so the rendering half of this rule — where a browser can paint an unobservable field exactly like an observed-and-empty one and undo the whole thing — could regress into `main` with both required checks green. **That is no longer true: E2E runs on pull requests and 5z requires it.** This file is kept anyway, for a reason that does not depend on the gap: it is milliseconds against a browser suite's minutes, it fails with a diff instead of a screenshot, and it pins the PRESENTATIONAL contract at a smaller altitude than a page walk can. The server half is pinned by `apps/server/src/coordination/service-board-*.integration.test.ts`. It runs in the "4. Unit tests" job (plain `vitest run`, transitively required), needs no browser, no DOM library and no new dependency — `react-dom/server`'s `renderToStaticMarkup` renders to a string in the Node environment Vitest already uses — and takes milliseconds.

It deliberately does NOT replace the E2E spec, which additionally proves the real route, real authz and the real generated SDK type reach the browser at all. What it owns is the pure presentational contract: given a board response, does the UI keep "cannot see" and "nothing to report" visually distinct, and does it refuse to dress either as a success.

`Link` is stubbed because `@tanstack/react-router`'s `useRouter` throws outside a `RouterProvider`; routing is not what is under test here (the E2E spec covers it against the real router).

### §471. "none", NOT "true". This fixture's `driver` is null

"none", NOT "true". This fixture's `driver` is null — the row has no latest change to attribute to anyone — and the attribute used to default that to `true`, making a row with NOTHING TO DRIVE machine-readable as one this domain drives, indistinguishable from the genuinely-local row asserted below. Same class as `data-blocked` and as the bare row-level `data-trust-tier` in `routes/outposts.tsx`.

### §472. Y4 — THE X7 CLASS, CLOSED FOR `unknownFields` ITSELF

Y4 — THE X7 CLASS, CLOSED FOR `unknownFields` ITSELF.

Every predicate above reads `…unknownFields.includes(field)`. `unknownFields` is required-not-optional on both `ServiceBoardRow` and the board response, and the generated SDK validates nothing, so a server that omits the honesty list made the read a TypeError — and this one is not scoped to a cell: it is called from `BoardRow`, so it takes the WHOLE board down.

`declaredUnknowns` returns `[]` for an absent list. That is the pre-honesty-work reading (every field renders as observed) and it is deliberately the lesser evil: a blank page tells the operator nothing at all, and the honest-unknown markers are additive on top of a working board.

### §473. The as-of label, and its paired ban on presenting stale

DESIGN §13's "as of &lt;bundle/date&gt;" label, and its paired ban on *"presenting stale data as live status"*. §13 names the UI as the layer responsible for the label, so the rendering half needs the same PR-visible gate everything above does — the server can compute an honest `asOf` and a browser that never paints it puts the operator back exactly where they started.

### §474. `rows` is direct-children-only by decision

`rows` is direct-children-only by decision (intermediate-grouping D3), so a service holding its components inside an assembly legitimately has zero rows. The counts are arithmetically right — and unqualified they say "nothing here" about a service that has components one rung down. That is the same failure as a fabricated all-clear, in the emptier direction, so it is pinned in the same file.

### §475. THE TOOLTIP MUST NOT QUOTE THE CADENCE AS THE BOUND

THE TOOLTIP MUST NOT QUOTE THE CADENCE AS THE BOUND. `stale: false` covers ages well past one cadence (the server applies a grace factor), so the old wording — "Within <peer>'s effective sync cadence of 60s" — told the operator that 90-second-old data was inside a 60-second window. Wrong, and checkable against a clock, which is the worst kind of wrong for a freshness label.

### §476. Y3(b) — THE PIN THE `isAbsent` FIX NEVER GOT

Y3(b) — THE PIN THE `isAbsent` FIX NEVER GOT.

Round 3 changed `asOf.stale === null` to `isAbsent(asOf.stale)` here and reported it as mutation-proven. It was not: reverting it left the whole `apps/web` suite GREEN, because the air-gapped test above sets `stale: null` — the case that already worked. The case that did not is the key being ABSENT, which is what an older server sends and which the SDK never validates.

MEASURED mutant output with `stale` omitted: the tooltip reads "Not overdue: this data is 10s old and amer-prod is not counted late until 60s …" — the REASSURANCE branch. Nobody measured that freshness; with no `stale` verdict on the wire there is no basis for "not overdue" at all, and the honest branch (no pull schedule, so no cadence to be late against) is the one that must render.

### §477. The mutation log, each applied alone and then reverted

MUTATION LOG (each applied alone to `BoardAssemblies`, then reverted):

| Mutation | Result |
| drop the count expression, render a bare "components" | 3 tests fail (count, plural, zero) | | remove the `assemblies.length === 0` early return | "renders NOTHING when there are none" fails | | `.filter((a) => a.componentCount > 0)` before mapping | "shows a ZERO count as zero" fails — the absence bug one level down |

## `apps/web/src/routes/service-board.tsx`

### §478. An outline `Button`-styled router `Link`

An outline `Button`-styled router `Link` (spec §2.12/§4B: every `→` literal dies, replaced by `ArrowRight` on an outline Button). `Button` itself renders a `<button>`, so a navigating control cannot use it directly — this mirrors its `outline size="sm"` classes plus the shared focus ring (§2.10) onto a `Link` instead of duplicating a second visual treatment.

### §479. One component's row

One component's row. EXPORTED for `service-board-honesty.test.tsx`, which renders it directly: the unknown-vs-observed distinction below is the whole point of this view, and it must be pinned by a check that runs on every PR at a cheaper altitude than the Playwright suite (which now also runs on PRs).

### §480. The per-pipeline state of one row, one chip per category

THE PER-PIPELINE STATE of one row, as one chip per ADR-0007 Category.

The board used to say ONE thing per component — its latest change — about a component that runs several independent pipelines. Whichever moved most recently spoke for all of them, so a pipeline that had never run was indistinguishable from one that had just succeeded (owner, 2026-08-10).

`not bound` is rendered, not omitted: a component with no infrastructure pipeline is a fact, and an absent chip would read as "this board does not show infra". Same rule as the component pipeline's lanes.

### §481. "none" — not "true" — when the server sent no driver at all

"none" — not "true" — when the server sent no driver at all. `driver` is nullable (no latest change to attribute), and defaulting an ABSENT driver to `true` made a row with nothing to drive machine-readable as one this domain DRIVES, indistinguishable from a real local-origin row. Same class as `data-blocked` above, and as the bare row-level `data-trust-tier` fixed in `routes/outposts.tsx`.

### §482. The releasing / blocked / stable / not-driven-here strip

The releasing / blocked / stable / not-driven-here strip. EXPORTED for the same reason `BoardRow` is: `Not driven here` must never be dressed as a success, and `Stable` must stop being dressed as one the moment the server declares it unobservable.

### §483. The two board-level unknowns, exported so wiring is gated

The two BOARD-LEVEL unknowns, exported so the WIRING is gated and not just the components it feeds. Reading a literal field name out of `unknownFields` inline is exactly the kind of line a later edit silently changes: nothing would fail, and the caveat would just stop appearing.

### §484. The server names that unobservable for three distinct reasons

The server names `summary.stable` unobservable for THREE distinct reasons, all of which mean the same thing to this badge — the count is not an all-clear: (1) a peer paired at a scope that does not carry change objects (`status_only` sends change STATUS without the change; `policies_only` sends neither); (2) evidence of a change in flight on a peer that this instance could not attach to anything local — which is what catches the SENDING side being the narrow one; (3) the upstream this board depends on is overdue by its own sync cadence. Which one it is shows in the "as of" line (3) and the row-level markers (1, 2).

### §485. DESIGN §13's "as of &lt;bundle/date&gt;" label

DESIGN §13's "as of &lt;bundle/date&gt;" label — the requirement paired with an explicit ban on *"presenting stale data as live status"*, and the UI is the layer §13 names as responsible for it. A board on a federated instance renders another domain's changes; without this line nothing on screen distinguishes a live view from a snapshot taken last quarter.

THREE READINGS, THREE TREATMENTS — and `null` is deliberately not one of the other two: - `stale === true`  → the upstream is past the age at which a cycle counts as missed. Warned, and the server has additionally named `summary.stable` unobservable, so the Stable badge drops its green in the same render. - `stale === false` → not overdue. A plain, quiet timestamp. - `stale === null`  → this instance schedules no pulls for that peer at all (an air-gapped peer; an outpost seen from the commander). There is no schedule for the data to be late against, so rendering it as "fresh" would assert something nobody measured. It renders as the bare as-of label, which is exactly the bounded guarantee §13 grants for an air-gapped domain.

THE THRESHOLD IS `staleAfterSeconds`, NEVER `expectedWithinSeconds`. The two differ by the server's grace factor, and this tooltip used to quote the cadence as if it were the bound — telling an operator that 90-second-old data was "within" a 60-second cadence, which is false and is exactly the kind of number a reader checks against a clock. Both are shown, each named for what it is; the factor between them is never recomputed here.

### §486. How many components sit under an assembly, not directly

How many components sit under an ASSEMBLY of this service rather than directly under it.

The four buckets are computed over `rows`, and `rows` is deliberately direct-children-only (intermediate-grouping D3 — an assembly is reported separately, never flattened into its descendants). That is a decided model, and this does not change it. What it changes is the READING: a service whose components all live in an assembly renders four honest zeroes, and four zeroes with no qualifier says "nothing here" when the true statement is "nothing HELD DIRECTLY here". Same class as `stableUnknown` above — a number that is arithmetically right and, unlabelled, tells the operator something false.

### §487. `/services/{id}/board` — the Service release board

`/services/{id}/board` — the Service release board (coordination-ui-views.md § "Service release board", Phase 2, Layer A). One scannable table of the service's components: each row shows that component's latest change per-wave status, its current wave, and any attention signal (the BLOCKED component surfaced in red with a decision_id "Why?" link), and opens the Phase-1 component pipeline. A summary strip counts releasing / blocked / stable / not-driven-here.

Strictly Layer A — real data only. Per-wave image versions/digests and component health are Layer B (not modeled yet); they are shown as an explicit placeholder, never fabricated. The same rule governs federation: a change this instance does not DRIVE (`row.driver.drivenHere === false`) arrives as a read-only replica WITHOUT its plan, Decisions or approvals (and without any freeze the driving domain declared non-federating — M25.7/D6 made an org-tier freeze able to cross, and a replicated one is enforced here like a local one), so every field the server named in `row.unknownFields` renders as an explicit "unknown here" marker — visually distinct from both a clean row and the stable count, never a fourth flavour of fine. Freezes are READ-ONLY status here; declaring/lifting one is a controls-phase concern (Phase 5), so the "Freeze service" affordance is present but disabled.

### §488. ASSEMBLY children of this service

ASSEMBLY children of this service (migration 0055, intermediate-grouping D3).

Their own card rather than rows in the components table: an assembly is a different KIND of child, and a component COUNT is not a release status — putting it in a status column would read as one. Renders nothing at all when there are none, which is every service on the estate today; unlike the pipeline chips, an empty list here is not a fact worth a card, just a service whose components sit directly under it.

### §489. BOARD-LEVEL unknowns (as opposed to a row's own)

BOARD-LEVEL unknowns (as opposed to a row's own): today, freeze visibility on a federated deployment. A freeze crosses a boundary only when the domain that declared it said so (`federate: true`, M25.7 / owner decision D6 — it becomes a graph object and is rebuilt into this instance's own freeze table, where it blocks like any local one), and that DEFAULTS OFF. So on an instance with a federation peer NO row's "not frozen" — driven here or not — can be read as "no freeze applies", and nothing on the wire says how much is missing.

This comment used to say freezes never ride the sync journal in either direction. That was true and deliberate until D6 retracted it; the conclusion the UI draws is unchanged, the reason is not, and the server states the same thing at greater length in `service-board.ts`.

## `apps/web/src/routes/service-detail.tsx`

### §490. The chrome shared by every view of ONE service

The chrome shared by every view of ONE service — Board, Infrastructure and Settings.

WHY THE BOARD IS THE DEFAULT (owner, 2026-08-10): `/services/{id}` fell through to the generic `RegistryDetailPage`, so the operational view of a service — what is releasing, what is blocked, which pipelines are bound — lived at a URL nothing linked to except one button on the properties page. That is the same orphaning `/components/{id}` had, and it gets the same fix: the board IS what a service is operationally, so it is what the route lands on, and the properties table moves to a tab.

The param is `$idOrUrn`, not `$id`, so `RegistryDetailPage` can mount unchanged under `settings` — it reads `useIdOrUrnParam`, and a differently-named param would hand it undefined.

## `apps/web/src/routes/service-infrastructure.tsx`

### §491. The pipelines bound to the service itself

`/services/$idOrUrn/infrastructure` — the pipelines bound to the SERVICE ITSELF.

Infrastructure often serves a whole service: a cluster, a shared database, a VPC stands up once and every component runs on top. Declaring that as N identical component bindings is duplication that drifts the moment a component is added, so it is declared once on the service.

This is a real pipeline, not a label, only because ADR-0027 added the SERVICE rung to `resolveBindingForTarget`. Before it, a binding here was inert config that ALSO blocked releases (fail-closed `no_executor`) — which is why the rung landed before this tab did, rather than the view arriving first and implying an execution path that did not exist.

It reads the SAME board response the Board tab does (one cached query, no second endpoint): the per-pipeline summary is computed once server-side for both.

### §492. The same mixed-provenance model as the sibling surface

outpost-ui.md §9.3a (owner, 2026-08-14) — the same mixed-provenance model as the component pipeline, one rung up. A service maintained by another domain (on an outpost: the commander) has its GLOBALLY SHARED infra/config authored there — opaque to this domain, which only knows the source is the commander; whatever this domain binds at the service is its DOMAIN-SPECIFIC shared-infra input (a cluster shared by this service's components in this domain, say). A self-maintained or domain-local service is this domain's own — nothing ahead of it. Read from the board's `service.maintainedBy`/`domainLocal`, never inferred.

## `apps/web/src/routes/setup.test.tsx`

### §493. The setup checklist, and what the owner decision asked for

G5 (`docs/proposals/outpost-ui.md` §4 close, owner decision 2026-08-13) — the setup landing.

`Link` is stubbed as a bare `<a href>` (the `outposts-honesty.test.tsx` house pattern): every link on this page is a STATIC destination (no `params`), so the simpler stub — the one `service-board-honesty.test.tsx`/`outposts-honesty.test.tsx` use, not `domain-local.test.tsx`'s param-interpolating one — is the honest fit here.

### §494. DELIBERATE INVERSION (M25.1)

DELIBERATE INVERSION (M25.1). Until `DELETE /api/v1/freezes/{id}` shipped, these two cases pinned the OPPOSITE claim: that the tooltip said "no early-lift or delete control yet" and that a freeze row contained no `<button>` at all. That reasoning was CORRECT for the server it was written against — the API genuinely had create/list/get and nothing else, and pinning the absence stopped the UI from implying a control that did not exist. M25.1 made it false, so the pins are flipped in the same change that wires the control, never before and never after.

Non-vacuity: revert `LIFT_SENTENCE` to the retired wording and the first case goes red; drop the `onLift` branch from `FreezeRow` and the second goes red.

### §495. Census, not a spot check: exactly 5 <input>s and 1 <textarea>

Census, not a spot check: exactly 5 <input>s and 1 <textarea> — a seventh field (e.g. a role or scope-TYPE picker) would fail this even if it carried no testid at all.

The count moved 4 -> 5 with M25.2's `atomic`, and the count is the POINT of this case: it is what makes the form's field set track `CreateFreezeRequestSchema` rather than drift from it. `atomic` is a real key on that schema, so it belongs here; bumping the number is the correct response, and inventing a field that is NOT on the schema still fails.

M25.7 ADDED TWO SCHEMA KEYS AND THIS COUNT DELIBERATELY DID NOT MOVE — recorded rather than left to be rediscovered as drift. `federate` and `domainLocal` are gated on `federation:write` at the freeze's scope, not on the `freeze:write` this page's audience holds, and this form has no way to know whether the viewer holds it; an inert checkbox that 403s on submit is worse than no checkbox. Freeze authoring UI is the UI session's surface (coordinated in docs/proposals/campaigns-rework.md §2.3), and `scp freeze create --federate` is the door until then. So the invariant this case pins is now "one field per schema key the form OFFERS, and no field that is not on the schema" — inventing an off-schema field still fails, and adding `federate` later means bumping this to 6 with a testid above.

### §496. The role-gating census

The role-gating census (outpost-ui.md §2 / CLAUDE.md's property-census rule): this page must never key ANY rendering decision on the instance's federation role. A source-level assertion, same spirit as replica-origin's own census tests — here it's the file's own text rather than a derived predicate, because "reads federation.self" has no runtime signal to assert on short of grepping the source.

## `apps/web/src/routes/setup.tsx`

### §497. `/setup` — the owner's "both" answer to outpost-ui.md §4/§8 Q1

`/setup` — the owner's "both" answer to outpost-ui.md §4/§8 Q1: a task-oriented setup landing ALONGSIDE the in-place affordances Lane A/B already build (source-mapping authoring and placements live on `component-pipeline.tsx`; the connect wizard is `routes/connect.tsx`). This page adds nothing new to write — every action here is a link to a surface that already exists, plus A4's freeze card, which had no UI anywhere before this.

DATA-DRIVEN, NEVER ROLE-GATED (outpost-ui.md §2, `domain-local.tsx`'s module doc — same precedent, cited here rather than re-argued): every row on this page keys on what a list call actually returned. There is no read of this instance's declared federation role anywhere in this file, and there must never be one — a commander-role org doing its own domain's setup work is exactly the colocated case §2 exists to cover, and it needs this page rendered identically to an outpost's.

### §498. Setup checklist (A4's sibling in Lane B)

Setup checklist (A4's sibling in Lane B) — one row per "have you connected/placed/mapped X", each a live count plus a link to the real authoring surface. Every count comes from a list call this page actually makes; nothing here is a derived or invented number (CLAUDE.md honesty rules — "never invent a label the API doesn't state").

### §499. `sourceKind`s this wizard/pipeline knows how to route

`sourceKind`s this wizard/pipeline knows how to route (mirrors `SOURCE_KINDS` in `component-pipeline.tsx`'s A1 source-mapping panel). Kept as a separate literal rather than an import: that file belongs to a different section of this same round. If the two ever diverge, the fix is to hoist one shared constant — not to invent a third list.

### §500. The raw list results this checklist is built from

The raw list-call results this page's checklist is built from — shaped exactly like what each `useQuery`/`useQueries` call below actually returns, so a test can hand this component a fixture without standing up React Query at all. A field left `undefined` means "still loading" (or never fetched); an object present, even with an empty `items`, means the call answered.

### §501. Outline-Button-styled router `Link`

Outline-Button-styled router `Link` (design spec §2.12/§4B: every `→` literal dies, replaced by `ArrowRight` on an outline Button). `Button` itself renders a `<button>`, so a navigating control can't use it directly — same shape as `service-board.tsx`'s (unexported) `LinkButton`, duplicated here rather than imported since that file belongs to a different section of this round.

### §502. Freeze card (A4)

Freeze card (A4) — declare, list, lift, and (M25.UI increment 3) adjust the window. `apps/server/src/routes/governance.ts`'s Freezes section registers `POST /freezes`, `GET /freezes`, `GET /freezes/{id}`, `DELETE /freezes/{id}` (M25.1, lift) and `PATCH /freezes/{id}` (M25.1, `updateWindow` — move `endsAt` in either direction). The pre-M25.1 claim that this card could only ever declare and list is stale; see `FreezeRow` for both write controls it now offers.

### §503. Lifted is checked first and outranks the window

`lifted` is checked FIRST and outranks the window, because after M25.1 the window is no longer the only thing that ends a freeze: `liftFreeze` retracts one immediately, whatever `endsAt` says. Reading the window first would render a lifted-but-not-yet-expired freeze as `active` — the UI asserting a freeze is in force that the engine has already stopped enforcing.

### §504. Active + upcoming freezes, soonest-starting first

Active + upcoming freezes, soonest-starting first — plus freezes LIFTED early whose window has not yet passed.

That last clause is the whole reason this is not a one-line filter. A lift is a governance act with a mandatory reason, and if the row vanished the instant it succeeded the operator would get no confirmation that the thing they just retracted is actually retracted — the surface would go silent at exactly the moment it should be most legible. Keeping it visible until the window it WOULD have run to has passed bounds the list (it does not accumulate lifted rows forever) while still showing the outcome. A freeze that simply expired is dropped as before: nothing was done to it and there is nothing to confirm.

### §505. Replaces the earlier sentence about there being no lift

REPLACES the pre-M25.1 `NO_EARLY_LIFT_SENTENCE`, which said "there is no early-lift or delete control yet". That was true of the server it was written against and became false the moment `DELETE /api/v1/freezes/{id}` shipped. It is replaced in the SAME change that wires the Lift control, so there is never a build in which the sentence and the surface disagree.

### §506. That input's value is local wall-clock with no offset

`<input type="datetime-local">`'s value is LOCAL wall-clock time with no offset — the exact inverse of `buildCreateFreezePayload`'s `new Date(form.startsAt)` parse, and the one this module needs to PREFILL the window-edit input from a wire `endsAt` (a UTC ISO instant). Local getters (`getFullYear`/`getMonth`/…), never UTC ones — a UTC read would silently shift the prefilled value by the viewer's own offset.

### §507. Shapes the `POST /freezes` body from the form's raw strings

Shapes the `POST /freezes` body from the form's raw strings — exactly `CreateFreezeRequest`'s fields, no more: `scopeObjectId`, an omit-when-blank `name` (optional per `CreateFreezeRequestSchema`), `startsAt`/`endsAt` (the `<input type="datetime-local">` values, local time with no offset, converted to the `z.string().datetime()` instants the wire schema requires), and `reason`.

### §508. The card's write surface

The card's write surface — offered unconditionally (outpost-ui.md §6: "client-side pre-blocking of writes" is rejected). `createFreeze` (governance.ts) answers 400/401/403 with no `decision_id` (freezes have no gate-orchestrator Decision — measured, unlike change lifecycle transitions), so the refusal is rendered verbatim through the same `queryErrorMessage` every other mutation here uses, with no `decision_id`/"Why?" link to fabricate.

### §509. Platform freezes card (M25.UI increment 3)

Platform freezes card (M25.UI increment 3) — READ-ONLY. `apps/server/src/routes/ instance-freezes.ts`'s module doc states the reason at length: WRITE is operator-only, gated on `SCP_OPERATOR_TOKEN` presented as `x-scp-operator-token` — a deployment-level credential this browser session never holds and must never be asked to type into a form (same posture as `admin-governance.tsx`'s instance rung — see that file's "NO BROWSER WRITE HERE, DELIBERATELY" comment, mirrored below). READ is tenant-facing (`GET /v1/instance/freezes` needs no operator token): a platform freeze is the one freeze a tenant cannot author and by default cannot override, so a tenant that cannot even SEE it cannot be told why its release stopped (charter principle 6) — hence a card at all, where the sibling instance-scan-floors doors have none yet.

### §510. One platform freeze, read-only

One platform freeze, read-only. `freezeWindowStatus`/`freezeStatusBadge` above are reused UNCHANGED — `InstanceFreeze` carries the identical `startsAt`/`endsAt`/`liftedAt` shape `Freeze` does, so a second copy of the same window arithmetic is not needed and would be exactly the kind of drift risk this codebase's census discipline exists to catch.

### §511. Lift, scoped per row

Lift, scoped per row. `variables` is read back for the error case so a refusal renders under the row it belongs to: `freeze:write` is checked AT EACH FREEZE'S OWN SCOPE, so a caller can legitimately be allowed to lift one freeze in this list and refused another, and a single card-level error banner would attribute the refusal to whichever row was clicked last.

## `apps/web/src/test-support/render-dom.tsx`

### §512. THE STRUCTURAL FIX FOR THE "WORDING, NOT BEHAVIOUR" CLASS

THE STRUCTURAL FIX FOR THE "WORDING, NOT BEHAVIOUR" CLASS (M16.2 phase B, round 3).

WHY THIS EXISTS. Every component test in `apps/web` renders through `react-dom/server`'s `renderToStaticMarkup` — a STRING. A string cannot fire a handler, so every behavioural guarantee on this branch had to be pinned as an ATTRIBUTE or a LABEL beside the handler instead of as the handler's own effect. That is not a pin: it is a second copy of the claim, and the two can diverge silently. The measured proof — replacing `onClick={() => onReconcile(defaultKeep.objectId)}` in `outpost-configuration.tsx` with `onClick={() => onReconcile(undefined)}`, i.e. restoring the exact bare destructive verb the reconcile-default work exists to remove, left the whole web suite GREEN, because the only thing asserted was the `data-keep` attribute rendered NEXT TO the handler.

WHY A REAL DOM AND NOT A CLEVERER STRING TRICK. The alternative considered was hoisting the click payload into an exported pure function and asserting that. It is cheaper, but it does not satisfy the acceptance criterion: with no way to INVOKE the handler, `onReconcile(undefined)` written directly in the JSX still goes unnoticed however the payload is computed elsewhere. Only actually dispatching the event and observing the argument closes that gap — and it generalises: disabled buttons really do swallow clicks, state updates really do re-render, so the next interaction guarantee has somewhere to live instead of becoming another attribute.

COST, STATED HONESTLY: one devDependency, `happy-dom` — chosen over `jsdom` as the far smaller of the two, and used ONLY by test files that opt in with a `@vitest-environment happy-dom` docblock. The default Vitest environment for `apps/web` is still Node, so every existing `renderToStaticMarkup` test keeps running exactly as before with no environment cost. Nothing here touches the network (charter principle 5); it is a dev-time dependency in the same class as the Playwright/Chromium toolchain CI already vendors.

### §513. Type into a CONTROLLED `<input>`. Not `el.value = x; fire(input)`

Type into a CONTROLLED `<input>`.

Not `el.value = x; fire(input)`: React installs its own value setter on the element instance and uses it to dedupe change events, so a plain assignment can leave the tracker believing nothing changed and the `onChange` never fires — a silently vacuous test. Going through the PROTOTYPE setter updates the DOM without touching React's tracker, so the dispatched `input` event is seen as a real change. (React's `onChange` is wired to the native `input` event, not `change`.)

## `apps/web/vite.config.ts`

### §514. The web build, and what it emits

Web UI v1 (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14). Builds to static assets served BY the Fastify server (apps/server/src/app.ts) — no dev-time proxy is needed for `pnpm --filter @scp/web dev` against a local `pnpm --filter @scp/server dev` because both halves speak the same-origin `/api/v1` path in production; for local dev-server iteration (Vite's own port), same-origin cookie auth doesn't apply cross-port, so `pnpm dev` here is useful for UI iteration on mocked/no-auth screens but the real login flow is exercised against the built app served by apps/server (this is what `apps/web/e2e` drives, per its own README in global-setup.ts) or via `vite preview` behind the server's static mount.

CLAUDE.md air-gap requirement: zero external requests baked into the bundle — no CDN script tags, no remote font `@import`s. `@tailwindcss/vite` needs no separate `tailwind.config.js`.

Vitest's own config lives in the sibling vitest.config.ts, not here — merging `test` into this file via `vitest/config`'s `defineConfig` pulls in a different bundled Vite version than the project's pinned `vite`, which trips a plugin-type mismatch under `tsc` for `@vitejs/plugin-react`/`@tailwindcss/vite`. Two small config files avoids that entirely.

## `apps/web/vitest.config.ts`

### §515. Standalone from vite.config.ts

Standalone from vite.config.ts (see that file's doc comment for why) — Vitest picks up a same-directory `vitest.config.ts` in preference to `vite.config.ts` automatically, so this is the whole of apps/web's Vitest configuration.

DELIBERATELY still no plugins, and the DEFAULT `environment` is still the Node one. Most component tests under `src/` (e.g. `routes/service-board-honesty.test.tsx`) render through `react-dom/server`'s `renderToStaticMarkup` — a string, no DOM — so they need neither a DOM library nor `@vitejs/plugin-react`: `.tsx` is transformed by Vite's own esbuild honouring tsconfig's `"jsx": "react-jsx"`. That keeps them inside the existing "4. Unit tests" CI job with zero new jobs.

A DOM ENVIRONMENT IS NOW AVAILABLE, PER FILE, AND THAT WAS A DELIBERATE CHOICE (M16.2 phase B, round 3). A string render CANNOT FIRE A HANDLER, so every behavioural guarantee on this branch had been pinned as an ATTRIBUTE or a LABEL rendered NEXT TO the handler — a second copy of the claim, free to diverge from it. It did: replacing `onReconcile(defaultKeep.objectId)` with `onReconcile(undefined)` in `routes/outpost-configuration.tsx` left the entire suite green while restoring exactly the bare destructive call that work existed to remove. `happy-dom` (the smaller of the two DOM libraries; a devDependency of `apps/web` only) fixes the cause: a test that needs real events opts in with a `// @vitest-environment happy-dom` docblock on its FIRST LINE and uses `src/test-support/render-dom.tsx`. No global default changes, so no existing test pays for it.

Its one real job: exclude the PLAYWRIGHT SPECS (apps/web/e2e/*.spec.ts, run only via `pnpm --filter @scp/web test:e2e` / playwright.config.ts) from Vitest's default `**\/*.{test,spec}.*` include glob, which would otherwise also match them and crash trying to run Playwright specs under the wrong test runner ("Playwright Test did not expect test() to be called here") — a pre-existing bug (present before this step's changes, on every prior `e2e/*.spec.ts` file already on this branch), not something newly introduced here.

NARROWED FROM `e2e/**` TO `e2e/**\/*.spec.ts` (M16.2 phase B, B4). The blanket exclusion also hid `e2e/*.test.ts`, so PURE test HELPERS living beside the specs — today `e2e/openapi-conformance.ts`, the matcher that decides whether a captured request path is a declared OpenAPI operation — had no way to be unit-tested in a job that runs on pull requests. The specs cost minutes, so an untested matcher there is a check nobody would notice silently accepting everything. `*.spec.ts` is the Playwright convention this directory already follows, and it is exactly what must not run under Vitest.

### §516. COVERAGE THRESHOLDS — a RATCHET, not a target

COVERAGE THRESHOLDS — a RATCHET, not a target (owner decision 2026-08-01: "measure, then set the floor"); see `apps/server/vitest.config.ts` for the full rationale and the §7 correction.

MEASURED 2026-08-01 on this config: statements/lines 40.25%, branches 77.7%, functions 55.83%. The floors sit a point or two under each. RAISE them as coverage rises; never lower one to make a red run green.

The excluded `e2e/**\/*.spec.ts` Playwright specs run in their own jobs and contribute nothing here, so these numbers describe the component/unit layer alone.

### §517. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.

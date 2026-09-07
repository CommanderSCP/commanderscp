# routes

Long-form reference for the **routes** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 424 of 424 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/routes/auth.integration.test.ts`](#apps-server-src-routes-auth-integration-test-ts) — §1–§1
- [`apps/server/src/routes/auth.ts`](#apps-server-src-routes-auth-ts) — §2–§4
- [`apps/server/src/routes/authz-effective.integration.test.ts`](#apps-server-src-routes-authz-effective-integration-test-ts) — §5–§6
- [`apps/server/src/routes/authz.ts`](#apps-server-src-routes-authz-ts) — §7–§7
- [`apps/server/src/routes/campaign-scope-doors.integration.test.ts`](#apps-server-src-routes-campaign-scope-doors-integration-test-ts) — §8–§11
- [`apps/server/src/routes/campaigns.ts`](#apps-server-src-routes-campaigns-ts) — §12–§26
- [`apps/server/src/routes/change-source-mapping-authz.integration.test.ts`](#apps-server-src-routes-change-source-mapping-authz-integration-test-ts) — §27–§30
- [`apps/server/src/routes/change-sources.ts`](#apps-server-src-routes-change-sources-ts) — §31–§44
- [`apps/server/src/routes/change-target-scope.integration.test.ts`](#apps-server-src-routes-change-target-scope-integration-test-ts) — §45–§55
- [`apps/server/src/routes/changes.ts`](#apps-server-src-routes-changes-ts) — §56–§78
- [`apps/server/src/routes/components.integration.test.ts`](#apps-server-src-routes-components-integration-test-ts) — §79–§79
- [`apps/server/src/routes/components.ts`](#apps-server-src-routes-components-ts) — §80–§83
- [`apps/server/src/routes/containment-move-authz.integration.test.ts`](#apps-server-src-routes-containment-move-authz-integration-test-ts) — §84–§84
- [`apps/server/src/routes/containment-move-cycle-and-source-authz.integration.test.ts`](#apps-server-src-routes-containment-move-cycle-and-source-authz-integration-test-ts) — §85–§87
- [`apps/server/src/routes/containment-parent-doors-census.integration.test.ts`](#apps-server-src-routes-containment-parent-doors-census-integration-test-ts) — §88–§89
- [`apps/server/src/routes/containment-parent-liveness.integration.test.ts`](#apps-server-src-routes-containment-parent-liveness-integration-test-ts) — §90–§91
- [`apps/server/src/routes/containment-root-destination-authz.integration.test.ts`](#apps-server-src-routes-containment-root-destination-authz-integration-test-ts) — §92–§95
- [`apps/server/src/routes/containment-root-source-and-create-rooting.integration.test.ts`](#apps-server-src-routes-containment-root-source-and-create-rooting-integration-test-ts) — §96–§98
- [`apps/server/src/routes/custom-roles.integration.test.ts`](#apps-server-src-routes-custom-roles-integration-test-ts) — §99–§99
- [`apps/server/src/routes/dependency-producers.integration.test.ts`](#apps-server-src-routes-dependency-producers-integration-test-ts) — §100–§113
- [`apps/server/src/routes/dependency-producers.ts`](#apps-server-src-routes-dependency-producers-ts) — §114–§120
- [`apps/server/src/routes/dependency-subscriptions.integration.test.ts`](#apps-server-src-routes-dependency-subscriptions-integration-test-ts) — §121–§129
- [`apps/server/src/routes/dependency-subscriptions.ts`](#apps-server-src-routes-dependency-subscriptions-ts) — §130–§139
- [`apps/server/src/routes/device-flow.integration.test.ts`](#apps-server-src-routes-device-flow-integration-test-ts) — §140–§140
- [`apps/server/src/routes/device-flow.ts`](#apps-server-src-routes-device-flow-ts) — §141–§141
- [`apps/server/src/routes/discovery-effective-config.integration.test.ts`](#apps-server-src-routes-discovery-effective-config-integration-test-ts) — §142–§143
- [`apps/server/src/routes/doctor.ts`](#apps-server-src-routes-doctor-ts) — §144–§144
- [`apps/server/src/routes/events-authz.integration.test.ts`](#apps-server-src-routes-events-authz-integration-test-ts) — §145–§150
- [`apps/server/src/routes/events.ts`](#apps-server-src-routes-events-ts) — §151–§158
- [`apps/server/src/routes/executor-binding-audit.integration.test.ts`](#apps-server-src-routes-executor-binding-audit-integration-test-ts) — §159–§161
- [`apps/server/src/routes/executors.integration.test.ts`](#apps-server-src-routes-executors-integration-test-ts) — §162–§169
- [`apps/server/src/routes/executors.ts`](#apps-server-src-routes-executors-ts) — §170–§181
- [`apps/server/src/routes/federation-audit-witnesses.test.ts`](#apps-server-src-routes-federation-audit-witnesses-test-ts) — §182–§182
- [`apps/server/src/routes/federation-overlay-base-authority.integration.test.ts`](#apps-server-src-routes-federation-overlay-base-authority-integration-test-ts) — §183–§185
- [`apps/server/src/routes/federation-reconcile-412-schema.test.ts`](#apps-server-src-routes-federation-reconcile-412-schema-test-ts) — §186–§186
- [`apps/server/src/routes/federation-relay-builds.integration.test.ts`](#apps-server-src-routes-federation-relay-builds-integration-test-ts) — §187–§187
- [`apps/server/src/routes/federation-status-authz.integration.test.ts`](#apps-server-src-routes-federation-status-authz-integration-test-ts) — §188–§188
- [`apps/server/src/routes/federation.ts`](#apps-server-src-routes-federation-ts) — §189–§211
- [`apps/server/src/routes/gitea-discovery.integration.test.ts`](#apps-server-src-routes-gitea-discovery-integration-test-ts) — §212–§216
- [`apps/server/src/routes/gitlab-discovery.integration.test.ts`](#apps-server-src-routes-gitlab-discovery-integration-test-ts) — §217–§220
- [`apps/server/src/routes/governance-move.ts`](#apps-server-src-routes-governance-move-ts) — §221–§223
- [`apps/server/src/routes/governance.ts`](#apps-server-src-routes-governance-ts) — §224–§243
- [`apps/server/src/routes/graph-read-scope.integration.test.ts`](#apps-server-src-routes-graph-read-scope-integration-test-ts) — §244–§244
- [`apps/server/src/routes/graph.ts`](#apps-server-src-routes-graph-ts) — §245–§248
- [`apps/server/src/routes/health.integration.test.ts`](#apps-server-src-routes-health-integration-test-ts) — §249–§249
- [`apps/server/src/routes/health.ts`](#apps-server-src-routes-health-ts) — §250–§250
- [`apps/server/src/routes/instance-freezes.ts`](#apps-server-src-routes-instance-freezes-ts) — §251–§254
- [`apps/server/src/routes/instance-scan-exclusion-admissions.ts`](#apps-server-src-routes-instance-scan-exclusion-admissions-ts) — §255–§255
- [`apps/server/src/routes/instance-scan-floors.ts`](#apps-server-src-routes-instance-scan-floors-ts) — §256–§256
- [`apps/server/src/routes/list-door-scope.integration.test.ts`](#apps-server-src-routes-list-door-scope-integration-test-ts) — §257–§257
- [`apps/server/src/routes/list-readable-scope.integration.test.ts`](#apps-server-src-routes-list-readable-scope-integration-test-ts) — §258–§264
- [`apps/server/src/routes/objects-generic.ts`](#apps-server-src-routes-objects-generic-ts) — §265–§275
- [`apps/server/src/routes/objects-service-shadowing.integration.test.ts`](#apps-server-src-routes-objects-service-shadowing-integration-test-ts) — §276–§276
- [`apps/server/src/routes/objects.ts`](#apps-server-src-routes-objects-ts) — §277–§277
- [`apps/server/src/routes/oidc.ts`](#apps-server-src-routes-oidc-ts) — §278–§279
- [`apps/server/src/routes/operator-credentials.ts`](#apps-server-src-routes-operator-credentials-ts) — §280–§281
- [`apps/server/src/routes/operator-db.test.ts`](#apps-server-src-routes-operator-db-test-ts) — §282–§283
- [`apps/server/src/routes/operator-db.ts`](#apps-server-src-routes-operator-db-ts) — §284–§285
- [`apps/server/src/routes/org-root-scope-census.test.ts`](#apps-server-src-routes-org-root-scope-census-test-ts) — §286–§292
- [`apps/server/src/routes/ownership.integration.test.ts`](#apps-server-src-routes-ownership-integration-test-ts) — §293–§293
- [`apps/server/src/routes/ownership.ts`](#apps-server-src-routes-ownership-ts) — §294–§298
- [`apps/server/src/routes/pats.integration.test.ts`](#apps-server-src-routes-pats-integration-test-ts) — §299–§299
- [`apps/server/src/routes/pats.ts`](#apps-server-src-routes-pats-ts) — §300–§300
- [`apps/server/src/routes/pipeline-evidence.integration.test.ts`](#apps-server-src-routes-pipeline-evidence-integration-test-ts) — §301–§302
- [`apps/server/src/routes/pipelines.ts`](#apps-server-src-routes-pipelines-ts) — §303–§304
- [`apps/server/src/routes/placements.ts`](#apps-server-src-routes-placements-ts) — §305–§306
- [`apps/server/src/routes/plans-cli.integration.test.ts`](#apps-server-src-routes-plans-cli-integration-test-ts) — §307–§307
- [`apps/server/src/routes/plans.integration.test.ts`](#apps-server-src-routes-plans-integration-test-ts) — §308–§309
- [`apps/server/src/routes/plans.ts`](#apps-server-src-routes-plans-ts) — §310–§312
- [`apps/server/src/routes/policy-fromrole-validation.integration.test.ts`](#apps-server-src-routes-policy-fromrole-validation-integration-test-ts) — §313–§316
- [`apps/server/src/routes/rbac-administrative-floor.integration.test.ts`](#apps-server-src-routes-rbac-administrative-floor-integration-test-ts) — §317–§337
- [`apps/server/src/routes/rbac-permission-splits.integration.test.ts`](#apps-server-src-routes-rbac-permission-splits-integration-test-ts) — §338–§343
- [`apps/server/src/routes/rbac-role-binding-door.integration.test.ts`](#apps-server-src-routes-rbac-role-binding-door-integration-test-ts) — §344–§374
- [`apps/server/src/routes/relationships.ts`](#apps-server-src-routes-relationships-ts) — §375–§379
- [`apps/server/src/routes/role-bindings.ts`](#apps-server-src-routes-role-bindings-ts) — §380–§399
- [`apps/server/src/routes/scan-db.ts`](#apps-server-src-routes-scan-db-ts) — §400–§400
- [`apps/server/src/routes/scan-override-grants.ts`](#apps-server-src-routes-scan-override-grants-ts) — §401–§406
- [`apps/server/src/routes/scanner-assignments.ts`](#apps-server-src-routes-scanner-assignments-ts) — §407–§407
- [`apps/server/src/routes/service-board.integration.test.ts`](#apps-server-src-routes-service-board-integration-test-ts) — §408–§408
- [`apps/server/src/routes/services.integration.test.ts`](#apps-server-src-routes-services-integration-test-ts) — §409–§410
- [`apps/server/src/routes/services.ts`](#apps-server-src-routes-services-ts) — §411–§411
- [`apps/server/src/routes/source-mapping-delete.integration.test.ts`](#apps-server-src-routes-source-mapping-delete-integration-test-ts) — §412–§412
- [`apps/server/src/routes/spa-index-freshness.integration.test.ts`](#apps-server-src-routes-spa-index-freshness-integration-test-ts) — §413–§413
- [`apps/server/src/routes/type-registry.ts`](#apps-server-src-routes-type-registry-ts) — §414–§414
- [`apps/server/src/routes/typed-registries-cli.integration.test.ts`](#apps-server-src-routes-typed-registries-cli-integration-test-ts) — §415–§415
- [`apps/server/src/routes/typed-registries.integration.test.ts`](#apps-server-src-routes-typed-registries-integration-test-ts) — §416–§416
- [`apps/server/src/routes/typed-registries.ts`](#apps-server-src-routes-typed-registries-ts) — §417–§424

## `apps/server/src/routes/auth.integration.test.ts`

### §1. `/auth/me`, `/auth/logout`, `/auth/config`

`/auth/me`, `/auth/logout`, `/auth/config` (M2 step 4 Part A, BUILD_AND_TEST.md §8 M2 item 2) — the Web UI's session-discovery surface. `/auth/config` is public; the other two require auth like everything else (auth/require-auth.ts).

## `apps/server/src/routes/auth.ts`

### §2. Web UI v1 (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2)

Web UI v1 (M2 step 4, BUILD_AND_TEST.md §8 M2 item 2) — the SPA has no way to read the httpOnly `scp_session` cookie itself, so it discovers "am I logged in" via `/auth/me` and ends its session via `/auth/logout`. `/auth/config` is public so the login page can decide whether to render "Continue with SSO" before the visitor has any credentials.

### §3. DENY ROWS ARE EXCLUDED FROM THE UNION AND KEPT IN THE LIST

DENY ROWS ARE EXCLUDED FROM THE UNION AND KEPT IN THE LIST. A deny suppresses the permissions its own role carries at its own scope; it confers nothing anywhere, so folding it into a union of what the caller CAN do would be strictly false. The binding stays visible in `roleBindings` because an operator asking why a control is missing needs to see it.

### §4. A session token

A session token (local-auth or OIDC — both create rows via auth/local-auth.ts `createSession`) gets its row deleted, so it stops working immediately. A PAT is a separate, longer-lived credential the caller may be using from a non-browser context (e.g. the CLI) — "logging out" a PAT isn't a coherent operation (there is no session to end), so that case just no-ops successfully rather than deleting/revoking the PAT itself.

## `apps/server/src/routes/authz-effective.integration.test.ts`

### §5. `GET /api/v1/authz/effective` and `/auth/me`'s identity half

`GET /api/v1/authz/effective` and `/auth/me`'s identity half — role-model.md §5 step 6

THE PROPERTY UNDER TEST IS AGREEMENT, NOT PLAUSIBILITY. An effective-permissions endpoint that returns a believable-looking set is worse than none: a UI renders controls from it, and a set that disagrees with what the doors actually enforce produces either phantom buttons that 403 or hidden buttons the caller was entitled to. So the assertions below do not check the response against a hand-written expectation of what a role "should" carry — they check it against what `authorize` actually does, by making the same call the UI would gate and comparing.

Every test enters through the HTTP surface rather than calling `effectivePermissions` directly. A unit test of the resolver would pass identically whether or not the route were wired into `app.ts` at all, and "built, never installed" is this repo's most expensive recurring defect.

### §6. THE MISTAKE THIS EXISTS TO CATCH

THE MISTAKE THIS EXISTS TO CATCH. `hasPermission` filters to bindings whose ROLE CARRIES THE REQUESTED PERMISSION and only then looks for a deny — so a deny row suppresses exactly the permissions its own role holds, and nothing else. The plausible one-query rewrite (`bool_or(effect='deny')` over ALL matching bindings, ungrouped) instead lets one narrow deny wipe the caller's entire set. Both implementations return a believable-looking array; only this fixture tells them apart.

## `apps/server/src/routes/authz.ts`

### §7. The effective-permissions route, and what roles buy

`GET /api/v1/authz/effective` — role-model.md §5 step 6

WHAT THE PURPOSE ROLES BROKE, AND WHY A READ SURFACE IS THE FIX. The cumulative ladder was guessable: Viewer < Operator < Approver < Administrator < Owner, so a client that knew a principal's rank could infer the whole permission set. drizzle/0099's five purpose roles are deliberately NOT ordered — SecurityOfficer holds `scan:override` and no `object:write`; OrgAdmin holds `policy:write` and NOT `scan:override`; neither is "above" the other — so there is nothing left to infer from. Without this operation a UI's only way to learn whether to render a control is to POST and read the 403, which is not a usable interface.

IT ANSWERS ONLY ABOUT THE CALLER, AND THAT IS THE WHOLE AUTHORIZATION ARGUMENT
There is NO `subjectId` parameter. An earlier shape of the neighbouring grant-preview operation took a caller-chosen authorization anchor and had to be rewritten twice, because a parameter the caller chooses is a parameter the caller sets to whatever admits them (`packages/schemas/src/rbac.ts`'s `GrantPreviewQuerySchema` carries that history). The way this operation avoids re-introducing that class is to have no such parameter at all: it reports facts about the authenticated caller, so there is no other principal whose data could leak.

"Who else has authority here" is a real and separate question. It is NOT this operation, and answering it needs its own disclosure rules — the same care `readableSubsetOf` applies on the preview — rather than a boolean bolted onto this one.

NO PERMISSION BAR, AND THE TRADE IS STATED RATHER THAN ASSUMED
This route demands authentication and nothing else. Demanding `object:read` at the scope was considered and is self-defeating: the caller who most needs the answer is exactly the one who does not know what they hold, and a 403 for "you may not ask what you may do" is indistinguishable from "you may do nothing" — while being a different fact.

WHAT THAT DISCLOSES, HONESTLY: an authenticated member of the org learns whether a given object id exists in their org (404 versus 200). It discloses nothing ABOUT the object — no type, no name, no contents — and nothing about any other principal. The `withTenantTx` RLS boundary keeps the lookup inside the caller's own org, so a cross-org id is a 404 like any other absent one. Accepted as strictly smaller than the alternative's cost.

## `apps/server/src/routes/campaign-scope-doors.integration.test.ts`

### §8. The campaign get-by-id doors scope at the campaign

STEP 2.5a — THE CAMPAIGN GET-BY-ID DOORS ARE SCOPED AT THE CAMPAIGN, NOT AT THE ORG ROOT

THE GUARANTEE UNDER TEST, in one sentence: *an actor bound below the org root can read (and roll back) a campaign that lives inside their own subtree, and cannot read one that does not — while everything an org-root binding could do before still works, identically.*

## Why this file exists at all

`docs/proposals/role-model.md` §8.5: all 334 `403` occurrences across `apps/server`'s tests were enumerated and **zero** of them depend on the org-root pin of any door this increment re-scopes. So the four campaign doors below were entirely unpinned — a re-scope could have shipped holding to nothing, and a mistake in either direction (too wide, or 404-turned-403) would have been silent. These cases were written BEFORE the re-scope and watched fail; the failures are recorded in the mutation log at the bottom of this doc comment.

## Why a campaign's OWN id is a real scope, where a change's is not

§8.4 measured that re-scoping a *change* door to `change.id` is INERT: no `proposeChange` caller in the tree passes a `domainId`, `scp change propose` has no `--domain` flag, and route 1 of `scopeExpandCte` therefore walks a change straight back to the org root. A CAMPAIGN is the opposite case and that is why these four doors are cheap: `POST /campaigns` takes `domainId` on the wire (`CreateCampaignRequestSchema`), resolves it through `resolveDeclaredContainmentParent` and authorizes `object:write` at it — so a campaign genuinely lives under a service when it is authored under one, and `scopeExpandCte`'s route 1 walks campaign -> service -> org root. The fixtures below author campaigns exactly that way, which is what makes the service-bound cases measure the containment walk rather than a coincidence.

## The 404-vs-403 cases are the ones that would have been missed

`scopeExpandCte` seeds its recursive CTE with the raw uuid and never checks that the object exists (`authz/resolve.ts`), so a nonexistent id expands to a one-row set matching no binding — a guaranteed refusal. Scoping at a path param WITHOUT resolving the object first therefore turns every 404 on these routes into a 403, for everybody including an org-root Owner, plus two extra `assertDenyNotTruncated` probe queries per request. Those cases pass before the re-scope too (today's org-root check admits the Owner and the repo 404s afterwards); they exist to pin the ORDER the re-scope has to preserve, and the mutation log shows them going red when it is broken.

MUTATIONS RUN (2026-08-26). Baseline: 5 passed. MEASURED, not predicted — messages are verbatim.
THE WIDENING — each door's `scopeObjectId` reverted to `auth.orgId`, one at a time. All four refusals name the ORG ROOT as the scope, which is the property the re-scope exists to remove:

M-1  GET /campaigns/{id}: `scopeObjectId: found.id` -> `auth.orgId` => "a service-bound reader reaches every get-by-id door..." FAILED on the plain GET: `"lacks 'object:read' at scope '<orgId>'"`, expected 403 to be 200. M-2  GET /campaigns/{id}/explain: `campaign.id` -> `auth.orgId` => the same case FAILED on `/explain`, same detail, expected 403 to be 200. M-3  GET /campaigns/{id}/adoption: `campaignObject.id` -> `auth.orgId` => the same case FAILED on `/adoption`, same detail, expected 403 to be 200. M-4  POST /campaigns/{id}/rollback: `campaignObject.id` -> `auth.orgId` => "a service-bound writer can roll back a campaign in their own subtree..." FAILED: `"lacks 'object:write' at scope '<orgId>'"`, expected 403 to be 200.

THE ORDER — each door's `authorize` moved back ABOVE its resolve and scoped at the raw path param, which is what a mechanical re-scope produces. Every one turns an org-root OWNER's 404 into a 403 (the message even names the ghost uuid as the scope, which is the tell):

M-5  GET /campaigns/{id}  => "a nonexistent campaign id is 404, never 403, for an org-root Owner" FAILED: `"lacks 'object:read' at scope '<ghost uuid>'"`, expected 403 to be 404. M-6  ...`/explain`        => the same case FAILED on `/explain`, expected 403 to be 404. M-7  ...`/adoption`       => the same case FAILED on `/adoption`, expected 403 to be 404. M-8  ...`:rollback`       => the same case FAILED on the rollback leg: `"lacks 'object:write' at scope '<ghost uuid>'"`, expected 403 to be 404.

THE ORG-ROOT ARM (added 2026-08-26 with `authz/org-root-arm.ts`, baseline 6 passed). Scoping at the campaign ALONE is not a pure widening: `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a campaign whose containment parent is tombstoned expands to the seed alone and matches NO binding, org-root Owner included. All four doors now take the permission at the ORG ROOT **or** at the campaign, through one shared definition.

M-9  `checkAtOrgRootOrScopes`'s org-root arm disabled (`if (false && atOrgRoot)`) => "the org-root Owner still reaches a campaign whose containment parent is TOMBSTONED" FAILED on the plain GET: `"lacks 'object:read' at the org root and at campaign '<id>'"`, expected 403 to be 200. The other FIVE cases stayed green — every one of them sits on a campaign whose service is alive, which is exactly why nothing here caught this before.

THE TYPE CONSTRAINT (added 2026-08-26, baseline 7 passed). `:adoption` and `:rollback` resolved their campaign with an ANY-TYPE lookup, so the bar named "campaign" ran at whatever object the caller named, and a live non-campaign id was distinguishable from a ghost one before any authorization ran.

M-10 `resolveCampaignForScope` reverted to `getObjectByIdOrUrnAnyType` on both doors => "a NON-campaign id is 404 on every door" FAILED on the rollback leg: `'<component id>' is not a campaign`, expected 400 to be 404 — `triggerCampaignRollback`'s own refusal, reached only because the campaign bar had already been cleared at a component.

### §9. Two doors cannot get their campaign from the repo in time

`:adoption` and `:rollback` cannot get their campaign from their repo in time to scope on, so they resolve one themselves — and they used to do it with `getObjectByIdOrUrnAnyType`, which resolves ANY type. Two consequences, both closed by `resolveCampaignForScope`:

```text
1. `assertCampaignAuthority` ran at whatever object the caller named. A principal bound at
   a COMPONENT cleared a bar whose message says "campaign", and only the repo behind it
   said no. The bar in the code was not the bar being run.
2. An EXISTENCE ORACLE, opened before any authorization: a live non-campaign id refused
   with 403 while a ghost uuid answered 404, so a caller holding nothing anywhere could
   tell "some object exists here" from "nothing does". The two now answer identically.
```

`:rollback`'s answer for a non-campaign moves from `triggerCampaignRollback`'s 400 to the same 404 the other three doors give — deliberate, and it is what makes case 2 hold.

### §10. Why the re-scope is a disjunction here too

WHY THE RE-SCOPE IS A DISJUNCTION HERE TOO, and why "an org-root binding satisfies a check at any object below it" is not the whole rule. `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a campaign whose containment parent is a tombstone expands to the SEED ALONE and matches no binding — the org-root Owner's included. Without `authz/org-root-arm.ts`'s org-root arm all four doors below are a 403 for a principal with authority over the entire deployment.

WHY THE PARENT IS TOMBSTONED HERE WITH AN UPDATE RATHER THAN A `DELETE` CALL — and why the two API refusals that force it are EXERCISED below rather than described.

The house rule is to build test state through the real API. The source-mapping family's equivalent case does exactly that (`change-source-mapping-authz.integration.test.ts`: delete the component, then its service, then its domain) and so does the change family's (`change-target-scope.integration.test.ts`) — both work because the SEED of the walk is soft-deleted FIRST, and `scopeExpandCte` seeds liveness-blind, so the seed survives its own tombstone while its parents' tombstones cut the chain.

A CAMPAIGN CANNOT BE THE SEED THAT WAY, because the doors under test 404 a tombstoned campaign (`fetchCampaignObject` filters `deleted_at IS NULL`) — the campaign has to stay LIVE. That leaves only "tombstone an ancestor while the campaign lives", and two shipped guards make it unreachable through local API calls, in a pincer:

```text
1. there is no DELETE for a campaign at all — `campaign` is one of
   `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS`, refused on every write verb of the generic
   object route, and it has no typed delete;
2. `deleteObject`'s orphan guard refuses to delete a row that still has live containment
   children (all three routes since the 2026-08-18 widening), and a live campaign is one.
```

Both are asserted below, so this justification is a MEASUREMENT rather than a claim, and so that if either guard ever changes this test says so instead of the comment quietly going stale. The state IS reachable in production: `deleteObject` skips the orphan guard on the FEDERATION-IMPORT path and when removing a foreign shadow, and its own header records the consequence verbatim — "A local child naming a foreign replica as its parent therefore CAN still be orphaned by that authority's delete; recorded as a cost." A campaign declared under a replica service that its authoritative domain later deletes is that sentence. The ROW those paths leave behind is identical to the one written here — `deleted_at` set on the parent, child untouched — and that column is all `scopeExpandCte` reads.

### §11. The widening did not leak the other way

The widening did not leak the other way. A cut chain reaches NO binding, so a check that had simply stopped refusing would look identical to the fix from the Owner's side alone; this probe is what tells the two apart.

WHAT THIS PROBE IS, PRECISELY: `serviceReader` is bound at `serviceA` (the beforeAll fixture), which is unrelated to this case and was never deleted — NOT at `tombService`, the row this test tombstones. So it is an ordinary no-standing-in-this-chain principal, and its 403 shows the org-root arm did not open the door generally. It is deliberately NOT the sharper probe (a principal bound at the tombstoned row itself); that case belongs with whoever pins what a binding below a cut chain should mean, which is an open question, not a settled one.

## `apps/server/src/routes/campaigns.ts`

### §12. `/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5)

`/campaigns` (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5) — the campaign-scoped sibling of `routes/changes.ts`. Deliberately thin: every write here is a graph-object create (`campaign`, pre-seeded built-in type) plus a Decision, exactly like `POST /changes`; there is no transition-guarded verb surface (`:cancel`/`:accept`) because a campaign has no transition- guarded state machine to drive — see `coordination/campaign-status.ts`'s module doc. The one verb a campaign DOES support beyond propose/list/get/explain is `:rollback` (`coordination/campaign-rollback.ts`), mirroring `POST /changes/{id}/rollback` exactly.

### §13. DOES THIS WRITE **WIDEN** THE CAMPAIGN'S DEADLINE

DOES THIS WRITE **WIDEN** THE CAMPAIGN'S DEADLINE — release targets it was withholding from?
OWNER RULING 2026-08-25 (decision D1, option b-i). `POST /campaigns/{id}/deadline` shipped with plain `object:write` behind all three of its acts, and that made the Owner-only per-target waiver one route down — `campaign:deadline-override`, drizzle/0088, Owner ALONE — bypassable by anyone who could not get an Owner to sign one. CLEARING THE DEADLINE IS A STRICT SUPERSET OF WAIVING IT: every target rather than named ones, permanently rather than bounded by `until`, with no per-target `object:write` and no recorded waiver naming who was excused. An Operator refused a one-target waiver simply cleared the whole deadline instead, at a lower price. A WIDER VERB CANNOT RUN AT THE NARROWER VERB'S PERMISSION — the same inversion §4.5 already refused when it declined to check the waiver at the target, applied one route over.

WIDENING IS THE PROPERTY, NOT "CLEARING". A move to a LATER instant releases exactly the targets a clear would, for as long as the new date lasts. Gating only the clear would leave the move as the next bypass: "clear it" becomes "move it to 2099", and the Decision written afterwards would even label it `loosening: true` while it ran at `object:write`.

SETTING A FIRST DEADLINE AND SHORTENING AN EXISTING ONE STAY AT `object:write`, deliberately: both withhold fan-out from strictly MORE targets, never fewer, so neither can launder a waiver, and demanding an Owner for them would push routine campaign hygiene into the escalation the ruling exists to protect.

AN EQUAL VALUE IS NOT A WIDENING, and the comparison is on parsed INSTANTS rather than on the ISO strings — `resolveCampaignDeadline` hands back the `Date` it already parsed. The two renderings that actually reach here differ in their milliseconds (`...T00:00:00Z` vs `...T00:00:00.000Z`, both accepted by `z.string().datetime()`, which is why the stored form and a hand-typed one can disagree), and they sort the WRONG WAY as strings: `'Z' > '.'`, so a string comparison would read a restatement of an unchanged deadline as a slip and demand an Owner for it. Exercised in `campaign-deadline.integration.test.ts` (E5).

A CLEAR IS ALWAYS THE ESCALATED ACT, including on a campaign with no readable deadline to clear. Deliberate: the alternative makes the status code for `deadline: null` depend on what is currently stored, which both leaks that state to a caller who was refused and gives an operator a rule they cannot hold in their head ("clearing needs an Owner, unless it would have done nothing").

A MALFORMED STORED DEADLINE READS AS "NOTHING TO WIDEN" for a set or a move (the caller passes `null` for `beforeAt` in that case). That is honest rather than lenient: `campaign-reconcile.ts` fails open on a document it cannot parse — a malformed bag locks nothing — so replacing it excuses nobody. The clear over it is still escalated, by the flat rule above.

### §14. Fails closed on an instant nobody can compare

FAILS CLOSED ON AN INSTANT NOBODY CAN COMPARE, and that is the opposite of the read-time predicate's deliberate fail-open one module over — this is a permission check, and an uncomparable value here would silently answer "not a widening" and hand back the bypass. Unreachable today: `CampaignDeadlineInputSchema` is `z.string().datetime()`, which this repo's zod validates the CALENDAR with (measured in `resolveCampaignDeadline`'s doc). It is written down because that schema is under standing pressure to loosen toward a bare string (§4.1's federation-wedge argument).

### §15. THE BAR FOR THE FOUR CAMPAIGN GET-BY-ID DOORS

THE BAR FOR THE FOUR CAMPAIGN GET-BY-ID DOORS: the requested permission at the ORG ROOT **or** at the campaign object itself. One place per file, composing the one place per SERVER (`checkAtOrgRootOrScopes`); the block above `GET /api/v1/campaigns/:id` says why the org-root arm is not redundant.

`campaignObjectId` is always an id the caller has already RESOLVED — never a raw path param. That is what keeps an unknown id a 404 instead of the 403 that scoping at an id naming nothing produces for everybody, org-root Owner included. And "resolved" means resolved AS A CAMPAIGN: see `resolveCampaignForScope`, which the two doors that cannot get the campaign from their repo in time use, so the bar this function puts up can never land on some other object.

### §16. The object a campaign door scopes at, resolved first

THE OBJECT A CAMPAIGN DOOR SCOPES AT — resolved first, and 404 unless it really IS a campaign.

`GET /campaigns/{id}` and `:explain` get this for free: `getCampaign` goes through `fetchCampaignObject`, which pins `type_id = 'campaign'`. `:adoption` and `POST :rollback` cannot — their repo call resolves the campaign far too late to scope an authorization check on — so they used `getObjectByIdOrUrnAnyType`, which resolves ANY type. Two things followed from that, both closed here:

1. THE CAMPAIGN BAR WAS SATISFIABLE AT AN ARBITRARY NON-CAMPAIGN OBJECT. Pass a component's id and `assertCampaignAuthority` checked `object:read`/`object:write` at that COMPONENT — so a component-bound principal cleared a bar named "campaign", and only then did the repo answer 404/400. Nothing was disclosed and nothing was written, but the bar an operator reads in the code was not the bar being run, which is exactly the class of comment-that-lies this codebase keeps paying for. 2. IT WIDENED A PRE-AUTHORIZATION EXISTENCE ORACLE. The resolve necessarily runs before the check, so an id that names ANY live object was distinguishable from one that names nothing, to a caller who might hold nothing anywhere. Type-checking here collapses both to one 404.

The 404 message is deliberately IDENTICAL to `fetchCampaignObject`'s, so "no such object", "an object, but not a campaign" and "a soft-deleted campaign" are indistinguishable on the wire — the same shape `routes/changes.ts`'s `resolveChangeForScope` uses for the change family.

SOFT-DELETED ROWS ARE EXCLUDED, unlike the change resolver, and that is not an inconsistency: `fetchCampaignObject` filters `deleted_at IS NULL` and `getObjectByIdOrUrnAnyType` did too, so every campaign door 404'd a tombstoned campaign before this change and still does.

### §17. THE GATE, AND THE ROW FILTER, IN ONE CALL

THE GATE, AND THE ROW FILTER, IN ONE CALL (role-model.md §8.2, increment 2.5b). The org-root `object:read` check this replaced runs first, unchanged, and still throws the same 403 when nothing else grants; a principal bound BELOW the org root now lists the campaigns their binding reaches. A campaign authored with `domainId` genuinely lives under that object (`POST /campaigns` resolves and authorizes it), which is what makes the downward walk find it — §8.4 measured that a CHANGE, by contrast, has no such parent.

### §18. The four get-by-id doors take the root or the campaign

THE FOUR CAMPAIGN GET-BY-ID DOORS TAKE THE ORG ROOT **OR** THE CAMPAIGN (role-model.md §8.7, step 2.5a)
`GET /campaigns/{id}`, `:explain`, `:adoption` and `POST :rollback` each ran at `scopeObjectId: auth.orgId`. `authz/resolve.ts`'s `scope_expand` walks UPWARD only, so a check pinned at the org root is satisfiable by an ORG-ROOT BINDING AND BY NOTHING ELSE — an actor bound at the service a campaign lives in held `object:read` and was still 403'd reading it.

A PURE WIDENING, not a re-aiming — and it takes a DISJUNCTION to be one. "An org-root binding still satisfies a check at any object below it" is almost true, and the exception is the whole point of `authz/org-root-arm.ts`: `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a campaign whose containment parent has been tombstoned expands to the seed alone and matches NO binding, org-root Owner included. `deleteObject`'s orphan guard makes that hard to reach through ordinary local calls — a live campaign is a live `domain_id` child and blocks its parent's delete — but the guard is deliberately NOT applied on the federation-import path or when removing a foreign shadow, so a campaign declared under a REPLICA domain that its authoritative domain later deletes is exactly this state, and `graph/objects-repo.ts` records that orphaning as a known cost. These doors therefore compose the same `checkAtOrgRootOrScopes` the change and source-mapping doors do, rather than restating a fourth copy of the arm. What the scoped arm adds is that a binding BELOW the org root now reaches the campaigns inside its own subtree, and only those.

A CAMPAIGN'S OWN ID IS A REAL SCOPE, WHERE A CHANGE'S IS NOT — the distinction that makes these four the cheap fixes and the `change` doors a separate problem. §8.4 measured that no `proposeChange` caller in the tree passes a `domainId` and `scp change propose` has no `--domain` flag, so a change's containment parent is the org root in practice and re-scoping to it is INERT. `POST /campaigns` is the opposite: `domainId` is on the wire (`CreateCampaignRequestSchema`), it is resolved through `resolveDeclaredContainmentParent` and authorized at, so a campaign authored under a service genuinely lives under it and route 1 of the containment walk finds that service.

THE OBJECT IS RESOLVED BEFORE IT IS SCOPED, ON ALL FOUR, AND THAT ORDER IS LOAD-BEARING. `scopeExpandCte` seeds its recursive CTE with the raw uuid and never checks that the object exists, so an id naming nothing expands to a one-row set matching no binding: authorizing at an unresolved path param turns every 404 on these routes into a 403 — for everybody, org-root Owner included — and adds two `assertDenyNotTruncated` probe queries to each. The reorder costs nothing on the two doors that already loaded the campaign on the very next line, and one cheap row read on the two that did not.

PINNED BY `routes/campaign-scope-doors.integration.test.ts`, mutation-proven in both directions (the widening, and the 404-not-403 order).

### §19. Has each component migrated yet, derived live

M25.5 — "has each of this campaign's components migrated yet?", derived live.

A PURELY ADDITIVE NEW PATH. No existing schema changes shape: `CampaignRecipeSchema` gains one OPTIONAL property (additive on both the request and the response — making an existing REQUIRED response field optional is the oasdiff break this project has already paid for once, and nothing here does that), and every schema this route names is new.

`object:read` AT THE CAMPAIGN, the same scope `:explain` uses, and for the same reason: the answer is assembled from the campaign, its plan and its targets' own inventory/control rows, all of which are already readable at that scope. This route reads and writes nothing — the Decision that accompanies an `adopted` verdict is written by the reconciler's actuator, never by a GET. (It said "at the org" until step 2.5a re-scoped all four get-by-id doors; the sentence's argument was always about being the SAME scope as `:explain`, which it still is.)

### §20. RESOLVE, THEN SCOPE

RESOLVE, THEN SCOPE — see `GET /campaigns/{id}`'s block above. Unlike the two doors there, this one costs a genuine extra row read: `buildCampaignAdoptionReport` resolves the campaign itself (through `getCampaign`, which is also where "that uuid is not a campaign" 404s), and that resolution happens far too late to scope an authorization check on. A single indexed lookup is the price of not turning this route's 404 into a 403; `resolveCampaignForScope` is the cheap half of it — it filters tombstones, pins `type_id = 'campaign'` and resolves nothing else. The TYPE check is not decoration: with a bare any-type lookup the campaign bar was satisfiable at whatever object the caller named (see that function's docblock).

### §21. M25.6a — SET, MOVE or CLEAR this campaign's deadline

M25.6a — SET, MOVE or CLEAR this campaign's deadline (owner decision D4).

THIS IS THE EXIT, AND THAT IS WHY IT SHIPS IN THE SAME INCREMENT AS THE LOCK
**Clearing the deadline unlocks every target at once**, on the next 1 s tick, with no unlock verb and no backfill, because the lock is a read-time predicate. It shipped in the same increment as the lock so the lock was never an entrance with no exit — the failure M25.1 exists to close.

M25.6b has since added the FINER exit beside it: `POST /campaigns/{id}/deadline-override` excuses NAMED targets, behind the Owner-only `campaign:deadline-override` at the campaign plus `object:write` at each target. This verb is the blunt one — all targets at once — and the two are deliberately different radii.

THEY ARE NO LONGER DIFFERENT PRICES IN THE WRONG DIRECTION (owner ruling 2026-08-25, D1 b-i). As shipped, this verb ran at `object:write` for all three acts while the NARROWER waiver needed an Owner — so an Operator refused a one-target waiver could clear the whole deadline instead and excuse everybody, permanently, with no `until` and no per-target check. The WIDENING acts (clearing, and moving the deadline later) therefore now demand `campaign:deadline-override` TOO, on top of `object:write`; setting a first deadline and shortening an existing one are tightenings and stay where they were. `widensCampaignDeadline` at the top of this file carries the full argument, including why the property is "widening" and not "clearing".

THAT IS WHY THIS VERB TAKES `CampaignDeadlineInputSchema` AND NOT `CampaignDeadlineSchema`: the stored document carries `overrides[]`, and accepting them here would let an `object:write` holder mint the waivers the Owner-only permission exists to gate. The waivers already in force are PRESERVED across a set or a move (`setCampaignDeadline`) — dropping them would be a silent tightening nobody expressed — and a clear takes them with it, because there is then nothing left to be excused from.

BOTH CHECKS ARE AT THE CAMPAIGN OBJECT, not at the org root and not at the targets. Not the org root, because `hasPermission` expands the checked scope upward anyway, so checking at the campaign admits everyone an org-root check would AND an Administrator bound at the campaign's own containment domain — the person with the context. Not the targets, because the thing being configured is this campaign's policy about its own fan-out, and a target-scoped check would hand the laggard their own waiver (§4.5's stated inversion, applied one verb over) — which is doubly true of the widening check, since a target-scoped `campaign:deadline-override` would let an Owner of one laggard clear the deadline for the entire campaign.

`reason` IS MANDATORY on all three acts, INCLUDING THE CLEAR — `SetCampaignDeadlineRequestSchema` enforces `min(1)`. Clearing is the LOOSENING, so if any of the three deserves a recorded justification it is that one.

ONE DECISION AND ONE HIGH-SEVERITY AUDIT EVENT, AND THE DECISION CARRIES THE PREVIOUS VALUE
`audit_events` has no payload column, so the Decision is the only place "from what, to what" survives — the same division of labour `freeze.lift` / `freeze.window.*` already use (M25.1). Without the previous value, "the deadline slipped four times" is unreconstructible from a chain of writes that each say only where it landed, which is precisely the accountability the whole mechanism exists to produce.

NO `insertDecisionIfChanged`, and no dedup concern: this is a one-per-API-call authoring record, not a predicate re-evaluated on a timer. ADR-0024's write amplification came from a reconcile loop restating an unchanged verdict 86,400 times a day; a human pressing a button is not that. It writes under its OWN kind (`campaign_deadline_set`) rather than the lock's, so the authoring stream and the enforcement stream stay separable in `scp campaign explain`.

THE CAMPAIGN'S `properties` ARE REWRITTEN THROUGH `updateObject`, so this is a versioned, content-hashed, ordinarily-audited graph write on top of the governance record above it — no side door into `objects.properties`.

### §22. THE SECOND BAR ON THE WIDENING ACTS

THE SECOND BAR ON THE WIDENING ACTS — ADDED, NEVER SUBSTITUTED (owner ruling 2026-08-25)
`object:write` above still governs all three acts of this verb; a WIDENING one additionally demands the Owner-only `campaign:deadline-override` at the campaign. The reasoning — why clearing is a strict superset of the per-target waiver below, and why a move to a later instant is the same act by another name — is on `widensCampaignDeadline`. This is the established idiom (ADR-0043, drizzle/0088): a second, narrower bar beside the existing one, never a replacement for it, so nothing an `object:write` holder could do before becomes unavailable except the acts the ruling names.

THE PREVIOUS VALUE HAS TO BE READ BEFORE THE PERMISSION IS DECIDED — "later than what?" has no answer otherwise. Read HERE rather than taken from `setCampaignDeadline`'s return, because that would decide the authority for a write only after performing it. Same transaction, and the same scope the check above already admitted the caller at, so this discloses nothing to anybody `object:write` did not already let read the campaign.

THIS READ IS NOT LOCKED, AND THE CONSEQUENCE IS BOUNDED RATHER THAN ABSENT — stated, because `setCampaignDeadline` locks the SAME row `FOR UPDATE` a moment later and a reader is entitled to ask why this one does not. Under READ COMMITTED a concurrent writer can SHORTEN the deadline between this read and that lock, and this request's shortening then lands as a move LATER than the value it actually replaced. What that can produce is bounded by the value THIS caller already observed: the gate refuses anything later than `storedDeadline`, so the worst a race yields is a deadline no later than one that stood moments earlier — a lost update, undoing someone else's shortening, never a deadline nobody had authority to set. And it is not silent: `setCampaignDeadline` computes `before` under the lock, so the Decision records the true `from`, `loosening: true`, the actor and their mandatory reason. Taking the lock here instead would need a locked read exported from `coordination/campaign-repo.ts`; that is a repo-layer change, and the exposure above did not earn one.

### §23. A clear, and a move to a later instant, both LOOSEN

A clear, and a move to a later instant, both LOOSEN: strictly fewer targets are withheld from afterwards. Labelled from the values rather than from which branch matched, so the label stays true if the branches are ever reordered.

THE SAME PREDICATE THE PERMISSION GATE USED, called rather than restated. They were two copies of one rule until the 2026-08-25 ruling gave the rule teeth, and copies drift: the day they disagreed, this record would label an act `loosening` that the gate had admitted as a tightening — the Decision and the authority check telling two different stories about the same write, in the one record built to explain it.

### §24. M25.6b — WAIVE THIS CAMPAIGN'S DEADLINE FOR NAMED TARGETS

M25.6b — WAIVE THIS CAMPAIGN'S DEADLINE FOR NAMED TARGETS (§4.5).

THE AUTHORIZATION IS THE SUBSTANCE OF THIS ROUTE. TWO CHECKS, AT TWO DIFFERENT OBJECTS

1. `campaign:deadline-override` **AT THE CAMPAIGN OBJECT** — and this is the load-bearing decision of the whole milestone, so it is written down where the check is rather than only in a document.

```text
 THE THING BEING WAIVED IS *THIS CAMPAIGN'S* DEADLINE. Authority over it is therefore
 authority over the campaign. Checking at the TARGET instead would hand the laggard their own
 waiver: the component's own operator — who holds `object:write` on it by definition, which is
 how they ship — could excuse that component from the very migration the campaign exists to
 force. The mechanism would then coerce exactly the teams that did not think to opt out, which
 is worse than not having it. `hasPermission` expands the checked scope UPWARD, so this admits
 an Owner at the org root AND an Owner bound at the campaign's own containment domain, and
 nobody bound only under a target.
```

```text
 IT IS A NEW PERMISSION (drizzle/0088, Owner-only) AND NOT `freeze:override`, which was
 available and is the wrong shape: sharing it would let a freeze-override holder waive
 migration deadlines and a deadline-waiver holder bypass release freezes — two unrelated blast
 radii on one grant, neither afterwards narrowable without taking the other with it.
```

2. `object:write` **AT EACH NAMED TARGET** — the second, NARROWER bar. A waiver is a permanent, hash-chained governance record naming a specific component; minting one over a component the actor has no standing on at all should not follow from authority over the campaign. Checked per target rather than once at the campaign's domain for `proposeCampaign`'s stated reason: a campaign's targets can span domains a coarse single check would miss.

Both must pass. Neither substitutes for the other, and the order matters only in what an actor learns: campaign authority is checked first, so someone with none of it learns nothing about which objects the campaign targets.

OMITTING `targets` MEANS EVERY TARGET — AND IT IS NOT A SYNONYM FOR CLEARING THE DEADLINE
The deadline stands; each waiver is recorded per target with its own audit event; `until` still expires them individually; and this needs the Owner-only permission at the campaign PLUS `object:write` at every single target. The broad form therefore demands broad standing, which is the property that makes offering it safe.

THE CLEAR VERB ONE ROUTE UP NOW DEMANDS THE SAME OWNER-ONLY PERMISSION (owner ruling 2026-08-25, D1 b-i). It did not when this route shipped, and that was the bypass: clearing excuses every target permanently with no `until` and no per-target check, so the cheaper door was also the wider one. It still costs less than the broad waiver here — no `object:write` at each target, because it configures the campaign's own policy rather than minting a record about components — but it is no longer reachable by someone an Owner declined to give a one-target waiver.

ONE TRANSACTION: THE GRAPH WRITE, ONE DECISION, ONE AUDIT EVENT **PER TARGET**
The `overrides[]` entry lands through `updateObject` — versioned, content-hashed and audited on the ordinary graph path — so there is no side door into `objects.properties`. On top of it:

* ONE `campaign_deadline_override` Decision (`verdict: "allow"`). Its OWN kind, distinct from the tick-driven `campaign_deadline` block rows: `insertDecisionIfChanged` compares against the latest row of a `(subject_id, kind)` pair, so a human `allow` sharing that kind would interleave with the loop's rows and suppression would never fire — ADR-0024's measured 1.44 GB/day rebuilt from parts. * `inputContext` is EXACTLY `{ targets (sorted), until }`. `until` is a stored BOUNDARY, the only clock-shaped value allowed anywhere in this feature's Decisions. `at` and `actorId` are clock- and identity-shaped and are DELIBERATELY absent — they live on the audit event, which is the record built for exactly that, and in the stored waiver itself. The sort is `describeLockedTargets`'s reason: `restatesDecision` canonicalizes object KEYS but preserves array ORDER. * ONE HIGH-SEVERITY AUDIT EVENT PER TARGET, mandatory reason, `decisionId` linked — the `freeze.override` shape, where CRITICAL #2's rule is that a per-scope act writes a per-scope event. One event listing N targets would turn "was component X ever excused from campaign Y?" into a substring search over a blob instead of a subject-keyed query.

No `insertDecisionIfChanged` and no dedup concern: this is one row per human API call, not a predicate restated on a timer.

EFFECT IS IMMEDIATE ON THE NEXT TICK, and there is NO un-waive verb — that is the payoff of a read-time predicate, the same one that makes a moved deadline release its targets with no unlock verb. An `until` in the past is stored, audited and simply not effective.

### §25. A waiver over a non-target is dead data

A WAIVER OVER A NON-TARGET IS DEAD DATA in a permanent record, and an operator who believes they excused a component that was never in the campaign is worse off than one who got an error. Refused BEFORE the per-target authorization: the actor already holds the Owner-only permission at this campaign, so "that object is not one of its targets" tells them nothing they could not read off `GET /campaigns/{id}`.

### §26. RESOLVE, THEN SCOPE, at the campaign

RESOLVE, THEN SCOPE, at the campaign — see `GET /campaigns/{id}`'s block above. The extra row read is here for the same reason as on `:adoption`: `triggerCampaignRollback` resolves the campaign itself (and is where "not a campaign" 400s), which is after the authorization decision has to be made.

A CAMPAIGN-SCOPED WRITER CANNOT REVERT INTO TARGETS THEY HAVE NO STANDING ON, and that is NOT what this check provides. The per-member bar lives inside `triggerCampaignRollback`, which re-checks `object:write` at EVERY member's own target and skips the ones it does not hold — the "every target for writes" rule §8.4 states, already built here before this re-scope and unchanged by it. Widening this door from the org root to the campaign is therefore not a widening of blast radius: it changes who may ASK, not what the ask reaches.

`resolveCampaignForScope`, not a bare any-type lookup: the bar below is named "campaign" and must be RUN at a campaign. It also turns this door's "not a campaign" answer from `triggerCampaignRollback`'s 400 into the same 404 every other campaign door gives, which is what keeps a non-campaign id indistinguishable from a typo.

## `apps/server/src/routes/change-source-mapping-authz.integration.test.ts`

### §27. The three mapping mutation doors take write at the root

THE THREE `source_mappings` MUTATION DOORS TAKE `object:write` AT THE ORG ROOT **OR** AT THE MAPPING'S OWN COMPONENT — and the credential/discovery doors next to them still take the org root and nothing else.

WHY THIS FILE EXISTS
`authz/resolve.ts` expands a checked scope strictly UPWARD, so a check pinned at `auth.orgId` can be satisfied by an org-root binding and by NOTHING else. The pause switch, the scope label and the delete-by-tuple door were all pinned that way, which made the mappings of a component unreachable to the very role that administers the component (docs/proposals/role-model.md §4.2/§8). Increment 2.5a adds the component as a second arm.

IT IS A DISJUNCTION, NOT A MOVE, and that is the whole subtlety. Replacing the org-root arm with the component would NOT have been a pure widening, because `scopeExpandCte` is liveness-blind on its SEED row only: it joins every ANCESTOR `deleted_at IS NULL`, so a component whose containment parents have been tombstoned expands to the seed alone and matches no binding at all — the org-root Owner's included. `authz/org-root-arm.ts`'s `checkAtOrgRootOrScopes` carries the full argument and is the ONE definition every door 2.5a re-scoped composes; the stranded-mapping case below is this family's two-API-call reproduction of it, and it is the merge-loser case the DELETE door was built for.

AND WHY IT ALSO TESTS DOORS THAT WERE DELIBERATELY LEFT ALONE
The re-scope above is an `object:write`-plus-`auth.orgId` pattern, and the same two files hold three more instances of that pattern that MUST NOT be re-scoped (role-model.md §8.6): the encrypted-secret doors, the webhook-secret door, and `/discovery/run`, which makes SCP dial an execution system with stored credentials. Sweeping them mechanically would hand a component-scoped administrator the org's execution-system credentials. Nothing in the tree pinned their org-root requirement — all 334 `403` assertions in `apps/server` were enumerated and ZERO covered any of these doors — so the next person running this census could sweep them and ship green. The last two cases below are that pin.

IT WAS THREE DISCOVERY DOORS AND IS NOW ONE. `/discovery/accept` went with ADR-0047 and `/discovery/backfill-source-mappings` followed it; each took its own case with it, and the pin for the survivor lives in the credential-doors case below, which probes `/discovery/run` directly.

The backfill door was the sharpest instance while it existed, and its lesson is worth keeping after it: 2.5a briefly SUBSTITUTED its org-root check with a per-component `hasPermission`, which authorized once per MATCHED component — so an empty proposal authorized nothing whatsoever and any authenticated principal reached the handler. A door's own bar may be ADDED to from inside a loop, never SUBSTITUTED by one.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| drop `assertSourceMappingWritable`'s COMPONENT arm (check the org root only, i.e. today's pin) | ALL THREE widening cases FAIL — pause switch, scope label and delete-by-tuple each stop at their FIRST assertion, the component-bound admin acting on their own row, with `403 ... lacks 'object:write' at the org root and at source-mapping component '<id>'` where 200 was expected. The tombstoned-ancestor case stays green, so this mutation isolates the widening and nothing else | | drop `assertSourceMappingWritable`'s ORG-ROOT arm (check the component only) | the tombstoned-ancestor case FAILS at its first door, the pause switch: `403 ... lacks 'object:write' at the org root and at source-mapping component '<id>'` where 200 was expected. Nothing else in the file moves — which is exactly why this case had to be written: the ordinary org-root assertions elsewhere all sit on components with LIVE ancestors | | delete the `authorize` at `PUT /secrets/{key}` (a credential door has no object to re-scope TO, so a sweep can only weaken it) | the credential-door case FAILS: 200 where 403 was expected |

### §28. THE CASE THAT MAKES THE RE-SCOPE A DISJUNCTION RATHER THAN A MOVE

THE CASE THAT MAKES THE RE-SCOPE A DISJUNCTION RATHER THAN A MOVE.

`scopeExpandCte` seeds its walk with the raw uuid (no liveness filter), but joins every ANCESTOR `deleted_at IS NULL`. So the chain is CUT at the first tombstone and `scope_expand` collapses to the seed alone, which matches NO binding — including the org-root Owner's. A component-only check would therefore 403 the Owner on the very rows this DELETE door exists to remove: a component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4 — ADR-0026 is about PLACEMENTS and says nothing about merges) soft-deletes the loser component and does not re-point its `source_mappings`, and `deleteObject`'s orphan guard counts only children with `deleted_at IS NULL`, so the loser's containment parents become deletable straight after.

Built here with ordinary API calls in the same order an operator would: delete the component, then its service, then its domain. Nothing below reaches into the database.

### §29. Each pair: refused for one principal, allowed for the other

Each pair is (refused for the component-bound admin, NOT refused for the org root). The second half of every pair is what makes the first half meaningful: it proves the request was otherwise well-formed and that only the actor's standing decided the outcome.

`PUT`/`DELETE /secrets/{key}` and `PUT .../webhook-secret` write the org's encrypted credential material; role-model.md §1.3d splits these into their own `secret:write` permission rather than widening them. `POST /discovery/run` is the door that makes SCP dial an execution system with a stored token.

### §30. The discovery route's org-root bar is a different one

`/discovery/run`'s org-root bar is `object:read`, which the component-bound Administrator holds AT THEIR COMPONENT and nowhere else — so it refuses for exactly the reason under test. The owner's control stops at 400 (an empty argocd config fails `validatePluginConfig`), which is downstream of the authorize call and therefore proves it passed — and, unlike a 200, it dials nothing.

## `apps/server/src/routes/change-sources.ts`

### §31. Change sources: webhook ingress

Change sources: webhook ingress (persist-then-process, DESIGN.md §8) + `source_mappings` CRUD (DESIGN §9.2 correlation). BUILD_AND_TEST.md §8 M3/M7.

**Authentication:** every call still goes through `requireAuth` (Bearer/PAT) — M3's "a source-specific adapter forwards actual provider webhooks here with a configured PAT" posture (a real GitHub App / TFC webhook sender carries no PAT of its own) is UNCHANGED in this milestone; direct, PAT-free provider-to-SCP webhook delivery is documented follow-up work, not this milestone's scope. What M7 DOES add: real, fail-closed HMAC SIGNATURE verification (`coordination/webhook-signature.ts`) layered ON TOP of that PAT auth, for any org+sourceKind pair that has configured a webhook secret (`PUT .../webhook-secret` below). A configured secret makes verification MANDATORY: a missing/invalid signature is REJECTED (401) and the delivery is never persisted at all — no half-measure "persist as unverified and hope". An org/sourceKind with NO secret configured keeps M3's original behavior (`signature_verified: false`, honestly reflecting that no verification happened, never silently defaulted to `true`).

### §32. The replay and redelivery dedupe key for one delivery

MAJOR #5 — the replay/redelivery dedupe key for one webhook delivery. Provider delivery identifiers (stable across a redelivery of the SAME event, distinct for genuinely different events) are strongly preferred; the raw-body hash is the fallback for sources that send no such header (it dedupes byte-identical payloads, which is the best available signal absent a delivery id). Hashing the RAW bytes (`request.rawBody`, captured pre-JSON-parse by app.ts) — not a re-serialized `JSON.stringify(body)` — keeps the fallback stable against key-order/whitespace.

### §33. Persist ONE source event

Persist ONE source event (persist-then-process), shared by the raw `/webhook` ingress and the typed `/report` ingress so the dedupe + conflict-resolution lives in exactly one place. The unique index on (org_id, source_kind, dedupe_key) makes a redelivery of the same key a no-op that returns the FIRST event's id, so a replay never creates a second Change (MAJOR #5). Both callers do their own auth/authorization BEFORE this; this function only writes.

### §34. The write bar for the three mapping mutation doors

THE WRITE BAR FOR THE THREE `source_mappings` MUTATION DOORS below (pause switch, scope label, delete-by-tuple): `object:write` at the ORG ROOT **or** at the mapping's own COMPONENT.

ONE definition of that disjunction serves every door 2.5a re-scoped — `checkAtOrgRootOrScopes` in `authz/org-root-arm.ts`, which is where the argument for the arm and for its ORDER lives. Restated here only in the part that is specific to this family:

THE ORG-ROOT ARM IS LOAD-BEARING FOR EXACTLY THE ROWS THE DELETE DOOR EXISTS FOR. A component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4/§4 — implemented in `coordination/component-merge-repo.ts`, whose header records that the general graph rewrite, `source_mappings` included, is deliberately out of scope) soft-deletes the loser component and leaves its mappings pointing at it. `deleteObject`'s orphan guard counts children with `isNull(objects.deletedAt)` (`graph/objects-repo.ts`), so the loser's containment parents, having no LIVE children left, are then perfectly deletable. A couple of ordinary API calls later the stranded mapping's component has an upward chain that dead-ends at a tombstone, `scope_expand` collapses to the seed alone, and a component-only check would lock the org-root Owner out of the one door that can clean it up.

The 403 names both arms, so an operator reading it can tell which authority they are missing.

### §35. The second door to a materialised dependency edge

ADR-0028 — the SECOND door to a materialised `depends_on` edge, and the one a census by route name misses: `webhook-processor.ts`'s `genericHint` lifts a top-level `stageDependencies` straight off this raw body and threads it into `proposeChange`. The processor itself runs as SYSTEM_ACTOR_ID, so the check cannot live there and be anything other than vacuous — the reporting PRINCIPAL only exists HERE. Checked against exactly what the processor will lift (same `extractHint`, same headers, same payload), so the two cannot drift. The edge's `from` endpoint is deliberately NOT passed: it is chosen at correlation time from an operator-configured `source_mappings` row, not by this caller.

This is not vacuous just because `object:write` at the org root is already required above: that is a DIFFERENT permission, and a custom role granting `object:write` without `relationship:write` would otherwise mint edges here that `POST /relationships` refuses.

### §36. MAJOR #5 — dedupe redeliveries/replays

MAJOR #5 — dedupe redeliveries/replays. Prefer the provider's own delivery identifier (GitHub `X-GitHub-Delivery`, or a generic `X-SCP-Delivery` an adapter can set), which is stable across a redelivery of the SAME event; fall back to a hash of the raw body when no delivery header exists. The unique index on (org_id, source_kind, dedupe_key) makes a second delivery of the same key a no-op (returns the FIRST event's id), so a replayed — even validly-signed — webhook never creates a second Change / fires a second real trigger.

### §37. Typed first-party report ingress

Typed first-party report ingress (DESIGN §12 Mode 1). `scp change-source report <sourceKind>` — a one-line CI step that reports a plan/apply result — POSTs a TYPED body here instead of the raw `/webhook` shape. Two reasons this is its own route, not the webhook with a schema: 1. Contract (charter principle 3): the webhook body is `z.record` by necessity (it accepts arbitrary provider payloads), so it cannot carry a typed SDK. A report is first-party and CAN, so the SDK/CLI get a real generated contract instead of a hand-cast `Record`. 2. Auth model: the webhook does HMAC verification when the org+sourceKind has a secret configured — which would REJECT a report (it carries no HMAC signature), so an org that set a `terraform` webhook secret could not `scp change-source report terraform` at all. A report is authenticated by its PAT (`requireAuth`), the same trusted-first-party stance `observe.ts` takes, so it skips HMAC and sets `signatureVerified: true`. Same persist-then-process path otherwise: it writes a `change_source_events` row that the next reconcile tick correlates (repo/path/correlationKey are read from the top-level payload by `webhook-processor.ts`'s `genericHint`).

### §38. Webhook signing secret configuration (M7)

Webhook signing secret configuration (M7) — an org points its GitHub App / TFC / Atlantis / custom-adapter webhook config at whatever HMAC secret it registers here; the secret's PLAINTEXT is encrypted at rest (secrets/crypto.ts) and referenced by key from `change_source_webhook_secrets`, never stored twice.

### §39. `secret:write` at the org root, NOT `object:write`

`secret:write` at the org root, NOT `object:write` — role-model.md §1.3d, drizzle/0099. The third credential door, and the one whose blast radius is least obvious: this secret is what `POST /change-sources/{kind}/webhook` verifies inbound signatures against, so whoever SETS it can thereafter FORGE signed source events into the estate. The scope stays the org root (§8.6's no-sweep list); only the permission changes.

### §40. PATCH a source_mapping's ONE mutable field

PATCH a source_mapping's ONE mutable field — the pause switch (migration 0063, owner ask 2026-08-14: "each [source] should have its own arrow so I can enable and disable each as needed"). Addressed by id, unlike POST/DELETE above which use the identity tuple: this is a genuine in-place update of one specific row, so an id is both correct and necessary — the identity tuple can be shared by several byte-identical rows, and toggling one must never touch its siblings. Same auth/tenant-tx idiom as the routes above.

### §41. READ THE ROW, THEN BAR AT ITS COMPONENT

READ THE ROW, THEN BAR AT ITS COMPONENT (or the org root — `assertSourceMappingWritable` is a disjunction, and its docblock is where the reasoning lives). A source mapping has no containment scope of its own; the authority that governs it is authority over the component it binds a repo/path pattern to, which is only knowable once the row is loaded. Reading first is also what keeps an unknown id answering 404 (`getSourceMapping` throws it) instead of the 403 that scoping at an id naming nothing would produce for every caller, org-root Owner included. `component_object_id` is immutable (the setter below writes `enabled`/`disabled_until` only), so there is nothing for the second statement to have moved out from under.

### §42. PATCH a source_mapping's declared SCOPE

PATCH a source_mapping's declared SCOPE (migration 0066, §10.6) — a SIBLING of the pause switch above rather than a field on it, so `setSourceMappingEnabled`'s contract stays byte-identical and a caller labelling a mapping never has to restate (and never clobbers) its pause state. Same by-id addressing (one row, never its byte-identical siblings), same auth/tenant-tx idiom. A label only: nothing here changes what a push correlates to.

### §43. DELETE a source_mapping

DELETE a source_mapping. The first operator-facing delete this table has had — before it, the only way to remove a mapping was an IaC apply's prune, so a mapping created by `discovery accept` or by hand could never be taken back through the API.

That gap has a cost beyond inconvenience. A component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4) soft-deletes the absorbed component and STRANDS its mappings; they are neutralised at read time (they no longer match a dead component) but they stay in the table, keep appearing in `GET /mappings`, and cannot be cleaned. On the live homelab that is 5 rows from three merges.

Matches the full IDENTITY TUPLE rather than an id — see `DeleteSourceMappingRequestSchema` for why (duplicates exist; deleting one leaves the survivor correlating). Reports the row COUNT so a no-op is visible instead of looking like success.

### §44. Resolved with `includeDeleted`

Resolved with `includeDeleted`: the mappings most in need of deleting belong to a SOFT-DELETED component (a merged-away pair half), and refusing to resolve it would make exactly those rows undeletable — the gap this route exists to close.

RESOLVED BEFORE THE BAR, AND THE BAR IS SCOPED AT IT. This door addresses rows by the identity tuple, whose component is the object that carries the authority over every row the tuple can reach — so that component is one arm of the check. Resolving first also keeps an unresolvable `component` a 404 rather than the 403 that scoping at a caller-supplied string would produce for everyone.

THE ORG-ROOT ARM IS LOAD-BEARING PRECISELY HERE, and the reason is subtle enough that it is written out in full in `assertSourceMappingWritable`'s docblock: a soft-deleted component still SEEDS the scope walk (the seed row is unfiltered), but `scopeExpandCte` joins each ANCESTOR `deleted_at IS NULL`, so once the merge loser's domain has itself been deleted — which the orphan guard permits, because its only children are already tombstones — the walk from the component reaches nothing, and a component-only check would refuse the org-root Owner the exact rows this route was built to remove.

## `apps/server/src/routes/change-target-scope.integration.test.ts`

### §45. THE READ-SURFACE BLOCKER, change half

THE READ-SURFACE BLOCKER, change half (docs/proposals/role-model.md §4.2, §8.4, increment 2.5a).

`authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD only, so an `authorize()` pinned at `scopeObjectId: auth.orgId` is satisfiable by an ORG-ROOT binding and by nothing else. Every change door was pinned that way, which made the whole point of the proposed purpose roles unreachable: a principal administering one component could hold `object:read`/`object:write` and still be 403'd reading, cancelling or accepting the release against their own component.

§8.4: a change has NO usable scope of its own — `objects.domain_id` for a change is the org root for every internal `proposeChange` caller — so these doors are scoped to the change's TARGETS, read back off the persisted `properties.targets`.

```text
* READ doors take `object:read` at ANY ONE target. A principal who can see one target is
  already told the whole list by `properties.targets`, so an every-target read bar buys nothing
  and would make reads strictly harder to satisfy than the writes they gate.
* WRITE doors take `object:write` at EVERY target — otherwise the admin of one target of a
  five-target change accepts the release into the four they have no standing on.
```

These tests are the safety net that did not exist: all 334 `403` occurrences across `apps/server` tests were enumerated before this increment and ZERO pinned the org-root behaviour of any door changed here (§8.5). Each assertion below was watched to fail against the org-root pin first.

`Operator` bound at a component is the ComponentAdmin SHAPE for the two permissions these doors demand (`object:read` + `object:write`) — the purpose roles themselves are a later increment (§5 step 3) and seeding one here would test a migration this branch does not carry.

THE ORG-ROOT ARM, AND THE MUTATION THAT PROVES THE LAST CASE IN THIS FILE
Scoping at the targets ALONE would not have been a pure widening. `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a target whose containment parents are tombstoned expands to the seed alone and matches NO binding — org-root Owner included — and a change's targets are read back verbatim and never re-resolved. Both helpers therefore take `object:read`/`object:write` at the ORG ROOT **or** at the targets, through the one shared definition in `authz/org-root-arm.ts`.

MEASURED, not predicted (2026-08-26). Baseline: 26 passed. Mutation: `checkAtOrgRootOrScopes`'s org-root arm disabled (`if (false && atOrgRoot)`), everything else untouched:

```text
- "an org-root Owner still reaches a change whose target's ancestors are ALL tombstoned" FAILED
  at its first read assertion, verbatim: `subject '<owner>' lacks 'object:read' at the org root
  and at any target of change '<changeId>' (<targetId>)`, expected 403 to be 200. (It fails
  fast, so the control-runs, approvals, policy-evaluate and cancel legs below it are covered by
  the same mutation only once the assertion above them is relaxed.)
- "GET /decisions?subjectId= — the same disjunction; unfiltered still needs the org-root arm"
  FAILED on the org-root Owner's unfiltered listing: expected 403 to be 200. Two cases, two
  different arms of the same helper, from one mutation.
- The other 24 stayed GREEN — which is the point: every ordinary fixture in this file sits on
  components whose ancestors are LIVE, so nothing here could have caught the defect before the
  tombstoned case was written.
```

THE ORDER OF THE TWO ARMS, AND THE SOFT-DELETE RESOLVE (2026-08-26, baseline 28 passed)
Two further defects, both found by adversarial review of the arm above, both fixed here and each mutation-proven in BOTH directions. Messages verbatim.

M-A  `checkAtOrgRootOrChangeTargets` reads the target set FIRST and throws on it (the shape this increment shipped with): `if (!targetObjectIds) unestablishableChangeTargetSet(...)` moved above the `checkAtOrgRootOrScopes` call => "an org-root Owner READS and CANCELS a change whose persisted target set is unreadable" FAILED on the first shape: `change '<id>' has no readable target set (properties.targets must be a non-empty array of object ids), so authority over it cannot be established`, expected 403 to be 200. One `properties` write by a federation import was enough to 403 the principal with authority over everything. M-B  the opposite direction — an unreadable target set PASSES (`if (!targetObjectIds) return { ok: true }`) => "a component-bound principal is REFUSED on those same rows" FAILED on the first shape: expected 200 to be 403. Trap 4 is still live; the fix is the ORDER, not the removal of the refusal. M-C  `resolveChangeForScope` back to live rows only (drop the `includeDeleted` retry) => "a SOFT-DELETED change is still served where it was before" FAILED on `/changes/{id}/control-runs`: `change '<id>' not found`, expected 404 to be 200. Four doors took that 404 where they returned 200 before 2.5a. M-D  the tombstone 404 dropped from `GET /approvals?changeId=` (the ONE door that had one before 2.5a) => the same case FAILED on its last leg: `{"items":[],"nextCursor":null}`, expected 200 to be 404. Resolving tombstones is not the same as serving them everywhere.

### §46. A second component-scoped principal, on a role with accept

A SECOND component-scoped principal, on a role that also holds `change:accept` (drizzle/0099). `Operator` deliberately does NOT, so from step 3 onward `adminA` can cancel but not accept — see the two `accept`/`rollback` cases below, which use this user for the "the SCOPE door opens" half and keep `adminA` for the refusals. Without the split, those two cases would have gone red on a PERMISSION change while claiming to be about SCOPE.

### §47. The change is proposed, so that edge is not legal

The change is `proposed`, and `proposed -> accepted` is not a legal edge, so the honest outcome once authority is granted is the state conflict. Asserting "409, not 403" is what makes this test fail loudly if the door goes back to demanding an org-root binding.

THE PRINCIPAL IS `ComponentAdmin`, NOT `Operator`, SINCE drizzle/0099. The door now demands `object:write` AND `change:accept` at every target; Operator holds only the first, by design (role-model.md §5 step 3 — the one intentional breakage). Using a role that holds both keeps this case about the SCOPE walk, which is what it was written to measure. The permission half is measured next door, in both directions.

### §48. An unreadable persisted target set refuses a scoped one

Trap 4 — an unreadable persisted target set refuses a SCOPED principal, and only a scoped one

BOTH HALVES ARE LOAD-BEARING AND THEY PULL IN OPPOSITE DIRECTIONS, which is why the ORDER of the two arms is what these cases actually measure:

```text
* `properties.targets` is read back off a PERSISTED row, and `federation/import-repo.ts`'s
  `object_upsert` branch writes a peer's `properties` verbatim (`federation/scope-filter.ts`
  whitelists `typeId === "change"` for it). An empty array must therefore never authorize by
  being empty — `every` over `[]` is vacuously true, which would be a total bypass.
* The pre-2.5a check was `object:read`/`object:write` at `auth.orgId` and never read
  `properties.targets` at all. So a principal bound at the org root who was served these rows
  before must still be served them: a 403 there is an authorization failure reported to the
  one principal with authority over everything, which is the outcome the re-scope must never
  produce.
```

`checkAtOrgRootOrChangeTargets` runs the ORG-ROOT ARM FIRST and only then inspects the target set, which is what lets both hold. The first cut of this increment read the target set first and threw on it, and 403'd the Owner on every one of the three rows below.

### §49. THE PURE-WIDENING REGRESSION

THE PURE-WIDENING REGRESSION. This door never validated its parameter: it handed the raw `idOrUrn` to `change_object_id = $1`, so any uuid that is not a change matched no rows and came back `200 []`. Re-scoping it to the change's TARGETS made an object with no targets hit the target-set refusal — a 403 telling a principal with authority over the entire org that they lack authority. `resolveChangeForScope` turns that back into the honest 404.

Both spellings of "not a change" must answer identically, and neither may be 403: an object that exists but is not a change, and a uuid that names nothing at all.

### §50. The fourth case where a root read becomes a not-found

THE FOURTH ORG-ROOT 200 -> 404, and the line between the 404 that was decided and the one that was an accident.

2.5a made four doors reach their change through `resolveChangeForScope`, which resolved LIVE rows only: `/changes/{idOrUrn}/control-runs`, `/control-runs/{id}/findings`, `GET /approvals/{id}` and its `/votes`. NONE of them resolved a change at all before 2.5a — they authorized at the org root and went straight to their repo — so every one of them served a tombstoned change's rows to an org-root Owner and stopped. Meanwhile the five doors behind `getChange` never filtered `deleted_at` either (`changes-repo.ts`'s `fetchChangeWithObject` has no such clause), so the tombstone was never a 404 anywhere in this family. `resolveChangeForScope` therefore resolves tombstoned rows too, and hands back `deletedAt` so the ONE door that genuinely 404'd them before 2.5a can keep doing so.

`GET /approvals?changeId=` is that one door: its pre-2.5a `getObjectByIdOrUrnAnyType` filtered tombstones. It re-applies the 404 itself, AFTER the read check, matching the pre-2.5a authorize-then-resolve order.

WHY THE TOMBSTONE IS WRITTEN DIRECTLY, measured rather than asserted: `change` is one of `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS`, so every write verb of the generic object route refuses it — the refusal is exercised below rather than described — and there is no typed DELETE for a change. The only in-tree writer of this row shape is a federation `object_tombstone` import, whose two-instance fixture would measure the same single column.

### §51. The change id is caller-supplied, so the check cannot run

`changeId` is caller-supplied on `GET /approvals`, and the scope check cannot run until the change is resolved — so the resolve necessarily happens before any authorization. The existence oracle that would otherwise open is closed by answering the same 404 for "no such object" and for "an object, but not a change". Probed as a principal with NO binding anywhere, which is the party the oracle would matter to.

### §52. The one place the wide arm is not literally the old check

THE ONE PLACE 2.5a's WIDE ARM IS NOT LITERALLY THE OLD CHECK, decided and pinned rather than left implicit. Pre-2.5a `GET /decisions/{id}` demanded `object:read` at the org root; the disjunction §8.6 specifies is `audit:read` at the org root OR `object:read` at the subject. So a principal holding org-root `object:read` and NOT `audit:read` would be newly refused.

DECISION: keep `audit:read`, do not widen the arm to `object:read OR audit:read`. * §8.6's whole point is that the DEPLOYMENT-WIDE read of every verdict ever recorded is an auditor's capability, and `object:read` at the org root is held by four of the five built-in roles. Adding it back to the wide arm re-opens exactly the escalation §8.6 names, and puts the door on the wrong permission just as role-model.md §5 step 3 starts binding purpose roles in the field. * The narrowing has NO POSSIBLE HOLDER today, which is what this case measures rather than asserts: every seeded role carrying `object:read` also carries `audit:read` (`drizzle/0002_rls_rbac_seed.sql`), and there is no custom-role API to author one that does not. A behavioural test cannot construct the victim, so the property is pinned at the source of the victims instead.

If a future migration seeds `object:read` without `audit:read`, or a custom-role API lands, this goes red and the decision above has to be made again with a real principal in hand.

### §53. Almost every Decision is about a change, and its chain

Almost every Decision in this system is about a change, and a change's containment chain runs to the org root — so a subject arm that checked `object:read` at `decision.subjectId` directly was satisfiable ONLY by an org-root binding, i.e. by exactly the principals the `audit:read` arm already admitted. Inert for the roles it was added for. The arm resolves a change subject to its targets, the same expression the sibling change doors scope at.

### §54. ONE DATASET, ONE BAR

ONE DATASET, ONE BAR (the verdict-read rule in routes/changes.ts). `/explain` embeds `listDecisionsForSubject(change)` behind the change's target read bar; `/decisions/:id` serves the same rows. Two different bars over one dataset made "may I see why I was blocked" depend on which URL was opened — and charter principle 6 hands the blocked principal a `decision_id`, which is a reference to nothing if they are 403'd on it.

### §55. The case that makes the org-root arm necessary, not tidy

THE CASE THAT MAKES `authz/org-root-arm.ts` NECESSARY RATHER THAN TIDY.

`scopeExpandCte` seeds its walk with the raw uuid and never filters it, but joins every ANCESTOR `deleted_at IS NULL`. So the chain is CUT at the first tombstone and `scope_expand` collapses to the seed alone, which matches NO binding — the org-root Owner's included. A change's `properties.targets` are read back VERBATIM and deliberately never re-resolved (re-resolving would 404 "cancel the release against the component we just removed"), so a target-only check 403s the Owner on exactly the change an operator opens next.

BUILT WITH ORDINARY API CALLS, in the order an operator would make them: create the domain, the service and the component; propose the change; then delete the component, its service and its domain. `deleteObject`'s orphan guard permits each delete precisely because every child is already a tombstone. Nothing below reaches into the database.

## `apps/server/src/routes/changes.ts`

### §56. The change routes, their sub-resource and the guard

`/changes`, `/change-sources`'s sibling `/decisions` sub-resource, and the guarded-transition verbs (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). Routing note (documented, inherited from routes/plans.ts's own note): DESIGN's `{id}:verb` shorthand does not survive Fastify's router (find-my-way folds `id:verb` into a single param) — every verb here is a conventional `POST /changes/{id}/verb` subpath instead, consistent with `/plans/{id}/apply`.

`evaluate`/`coordinate`/`execute`/`validate` have NO route: those edges are entirely engine-automatic in M3 (coordination/reconcile.ts) — there is no policy/control gate for a human to satisfy before them yet (M4). `cancel`/`accept`/`rollback` are the only human-triggerable edges, plus `propose` (the entry point) — matching BUILD_AND_TEST.md's `scp change propose/accept/rollback/explain` CLI surface exactly, with `cancel`/`list`/`get` alongside for completeness (the guarded transition function already supports `cancel` from every pre-acceptance state; leaving it unreachable via the API would be an arbitrary gap, not a deliberate one).

### §57. M12 P4B Phase 4 — the coupled-pipeline wait status for `explain`

M12 P4B Phase 4 — the coupled-pipeline wait status for `explain`: for a change that declared `requires`, each prerequisite's live satisfaction (and the object name it is `at`, for a readable "Waiting on …" surface). Null when the change coupled nothing, so unchanged for every pre-P4B change. Read-only: it re-evaluates the SAME predicate reconcile uses, it does not transition.

"Did you mean?" (coupled-pipelines.md §3.7): for each UNSATISFIED requirement, also looks up `listProvidedKeysAtScope` — the `provides` keys ANY change has ever declared at that `at` object — so a typo'd key reads as "outstanding; keys provided here: feature-b, feature-c" instead of a bare blank. Only queried for unsatisfied requirements (a satisfied one has nothing to diagnose), and only ever off the read-only `explain`/`wait-status` path — never reconcile's hot loop.

### §58. AUTHORIZATION SCOPE FOR A CHANGE

AUTHORIZATION SCOPE FOR A CHANGE — the change's TARGETS (role-model.md §4.2, §8.4)

WHY NOT `auth.orgId`, WHICH IS WHAT EVERY DOOR HERE USED TO PASS. `authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD only, so `scopeObjectId: auth.orgId` is satisfiable by an ORG-ROOT binding and by nothing else. A principal who administers one service or one component could therefore hold `object:read`/`object:write` and still be refused the read and the accept of the release against their own estate — the read-surface blocker that made every scoped role in role-model.md §3 unusable.

WHY NOT THE CHANGE ITSELF, WHICH IS THE OBVIOUS RE-SCOPE AND IS INERT. A change has no scope of its own: `objects.domain_id` for a change is the ORG ROOT for every one of the five internal `proposeChange` callers (they pass no `domainId` at all), `scp change propose` has no `--domain` flag, and route 1 of the scope walk goes from `change.id` straight back to that same `domain_id`. `scopeObjectId: change.id` would READ as a narrowing to a reviewer and BE the org-root pin it replaced. Measured in role-model.md §8.4, which also records why re-parenting changes onto a nearest-common-ancestor was rejected.

So: the targets, read back off the persisted `properties.targets`.

```text
* READ doors — ANY ONE target. A principal who can see one target is already told the whole
  target list by `properties.targets` on the object they just read, so an every-target read
  bar buys nothing and would make reads strictly HARDER to satisfy than the writes they gate.
* WRITE doors — EVERY target, so that the admin of one target of a five-target change cannot
  accept the release into the four they have no standing on.
```

AND THE ORG-ROOT ARM STAYS, ADDED TO THE TARGET CHECK RATHER THAN REPLACED BY IT. "An org-root binding satisfies a check at any object below it" is ALMOST true and was written here as though it were exhaustive; it is false in exactly the case these doors reach most easily. `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a target whose containment parents have been tombstoned expands to the seed alone and matches NO binding — the org-root Owner's included. A change's targets are read back VERBATIM and deliberately never re-resolved (see `readChangeTargetScopeIds`), so a target that has since been deleted, along with its service and its domain, is the ordinary case rather than the exotic one. Both helpers below therefore compose `authz/org-root-arm.ts`'s `checkAtOrgRootOrScopes`, which is the ONE definition of the org-root arm shared with the campaign doors, the source-mapping doors and `POST /policy-evaluate`, and which argues the arm and its ORDER in full.

AND THE ARM RUNS BEFORE THE TARGET SET IS EVEN READ, WHICH IS WHAT MAKES IT A PURE WIDENING. The pre-2.5a check never looked at `properties.targets`, so nothing about that array may decide an org-root principal's request. `checkAtOrgRootOrChangeTargets` therefore evaluates the org-root arm FIRST and only then inspects the persisted set — a change whose targets are empty, missing or malformed is served to an org-root Owner exactly as it was before, while a SCOPED principal still hits the explicit trap-4 refusal (an unvalidated persisted array must never authorize by being empty). Both properties, one ordering; that helper's docblock argues it in full. This is a FIX, not a caveat: reading the target set first is what the first cut of this increment did, and it 403'd the org-root Owner on any row a federation import had mangled.

SO THE ONLY THING AN ORG-ROOT OWNER CAN NOW GET THAT THEY COULD NOT BEFORE IS A 404, AND ONLY ON AN ID THAT IS NOT A CHANGE:

```text
* An id that is not a change — which `GET /changes/{idOrUrn}/control-runs` used to answer
  `200 []` — is a 404 (`resolveChangeForScope`). Deliberate, and a better answer than `200 []`.
* `GET /approvals?changeId=` is the SAME 200-to-404, on a caller-supplied parameter: it used to
  resolve any object type and hand the id to `listApprovalRequestsForChange`, so a component's
  id came back `200 {items: []}`. It is now the same 404 `resolveChangeForScope` gives
  everywhere. (`GET /approvals/{id}`, its `/votes` and `GET /control-runs/{id}/findings` take
  the same 404 on a `change_object_id` that does not name a change — but that value comes off a
  persisted row, so reaching it means the row is already corrupt.)
```

A SOFT-DELETED change is NOT that 404: `resolveChangeForScope` resolves tombstoned rows too, for the reason its docblock gives — the four doors that reach a change through it did not resolve one at all before 2.5a, and `getChange` (behind the other five) has never filtered `deleted_at`.

Reporting an authorization failure to a principal with authority over the whole org is the one outcome this re-scope must never produce, and after the reorder above there is no input — row contents included — that can produce it.

These live here rather than in `coordination/campaign-scope-authz.ts` (with the propose-time target check) only because this increment's file set is these two route files; they are exported so `routes/governance.ts`'s change-scoped doors use the SAME implementation and the read bar and the write bar cannot drift apart. Moving them next to `assertCoordinationTargetsWithinAuthority` is a mechanical follow-up.

### §59. The object a change-scoped door scopes at, resolved first

THE OBJECT A CHANGE-SCOPED DOOR SCOPES AT — resolved first, and 404 unless it really IS a change.

Two separate things force the resolve-then-scope order and the type check, and both of them are cases where an org-root Owner used to get an answer and must still get the SAME answer:

1. `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so scoping at an unresolved path param expands a nonexistent id to a one-row set matching no binding — turning a 404 into a 403 for everyone, org-root Owner included (role-model.md §8.7's ⚠️). 2. NOT EVERY OBJECT IS A CHANGE, and the target-set refusal below fires on anything with no target set. `GET /changes/{idOrUrn}/control-runs` reached its repo with the raw param and filtered `control_runs.change_object_id = $1`, so a component's id (or any other uuid) came back `200 []`. Without this check the target-set refusal turns that into a **403** — an authorization failure reported to a principal who has full authority over the whole org. A 404 is the honest answer to "that is not a change", and it is a BETTER answer than `200 []`; a 403 is not an answer at all.

The 404 message is deliberately IDENTICAL to `getChange`'s and to the not-found-at-all message, so "no such object" and "an object, but not a change" are indistinguishable on the wire. That closes the existence oracle a pre-authorization resolve would otherwise open on the doors that take a caller-supplied change id (`GET /approvals?changeId=`, `/changes/{idOrUrn}/control-runs`): a principal with no binding anywhere now learns only "this uuid is not a change I will talk to you about", never whether some object with that id exists.

A SOFT-DELETED CHANGE IS STILL RESOLVED, AND THAT IS THE DIFFERENCE BETWEEN THE TWO 404s
This function answers ONE question — "which object is this door scoped at?" — and it must answer it for a tombstoned change, because `changes-repo.ts`'s `fetchChangeWithObject` (behind `getChange`, and therefore behind `GET /changes/{id}`, `/explain`, `cancel`, `accept` and `rollback`) carries no `deleted_at` filter at all. Every one of those doors served a soft-deleted change before 2.5a and still does. Four doors reach their change through THIS function instead — `/changes/{idOrUrn}/control-runs`, `/control-runs/{id}/findings`, `GET /approvals/{id}` and its `/votes` — and none of them resolved the change at all before 2.5a, so a live-rows-only lookup here turned four 200s into 404s for an org-root Owner. That is a regression, not a decision.

So the two answers are kept apart, deliberately:

```text
* "THIS ID IS NOT A CHANGE" stays a 404 for everybody. It is what 2.5a introduced on purpose,
  replacing a misleading `200 []`, and it is the honest answer.
* "THIS CHANGE WAS SOFT-DELETED" is NOT this function's business. `deletedAt` is handed back so
  a door that genuinely had a 404-on-tombstone before 2.5a can keep it — today exactly one
  does (`GET /approvals?changeId=`, whose pre-2.5a `getObjectByIdOrUrnAnyType` filtered
  tombstones), and it re-applies that 404 AFTER the authorization check so the order it had
  before (authorize, then resolve) is preserved on the wire.
```

LIVE ROWS WIN. The lookup is tried live-only first and only then with tombstones included, so a URN reused after a tombstone resolves to the live change exactly as it does today; the second query runs only when the first found nothing, which is the path that used to 404.

### §60. The target ids a change's authority is checked against, DEDUPED

The target ids a change's authority is checked against, DEDUPED — or `null` when the persisted set is empty or malformed, which every caller must treat as "authority cannot be established".

`assertCoordinationTargetsWithinAuthority` opens `if (!Array.isArray(input.targets)) return;`, a silent PASS. That is safe where it lives — it guards PROPOSE, whose schema pins `targets` to `.min(1)`, so the array is validated request input — and it would be a total authorization bypass here, where the array is read back off a PERSISTED row that nothing re-validates. A federation import writes a change object's `properties` verbatim (`import-repo.ts`'s `object_upsert` branch), so "the row says something other than a non-empty string[]" is reachable, not hypothetical. A SCOPED principal is refused outright on such a row: authority over it cannot be established, and the alternative is a total authorization bypass.

AN ORG-ROOT PRINCIPAL IS NOT, because the org-root arm is evaluated before this value is ever consulted — see `checkAtOrgRootOrChangeTargets`, which is where the ordering lives.

DEDUPED, per role-model.md §8.4 ("read `targetObjectIdsOf(change.properties)`, dedupe, `authorize` at each"). A change may legitimately list the same object twice, and without this a write door would run the same `authorize` — and persist the same Decision + audit row — once per repeat, while a read door would re-run the same refused walk. Deduping cannot change any verdict: `hasPermission`/`authorize` are pure in `scopeObjectId`, so the second call at an id can only repeat the first one's answer. The malformed check above runs on the RAW array, before the dedupe, so `["x","x"]` is still a well-formed two-entry set and not a length mismatch.

Returns the ids VERBATIM and does not re-resolve them to objects. `proposeChange` resolves each id-or-URN once at creation and stashes the resolved object ids here, so there is nothing left to resolve — and re-resolving would 404 the moment a target had since been deleted, turning "cancel the release against the component we just removed", the exact request an operator makes about such a change, from a 200 into a 404.

### §61. THE ORDER BOTH CHANGE BARS RUN IN, in one place

THE ORDER BOTH CHANGE BARS RUN IN, in one place: **org-root arm first, target set second.**

Two properties have to hold at once here, and only this ordering gives both.

1. **PURE WIDENING.** Every request that succeeded against the pre-2.5a `scopeObjectId: auth.orgId` pin must still succeed. The pre-2.5a check never looked at `properties.targets` at all, so nothing about that array may decide an org-root principal's request. 2. **TRAP 4 — a persisted target set is not validated input.** `properties.targets` is read back off a row, and `federation/import-repo.ts`'s `object_upsert` branch writes a peer's `properties` VERBATIM (`federation/scope-filter.ts` whitelists `typeId === "change"` for that branch). So an empty, missing or malformed target set arrives on real rows. Treating it as "no targets to check, therefore nothing refuses" would be a total authorization bypass — `Array.prototype.every` over `[]` is vacuously true — so a SCOPED principal must be refused explicitly.

Reading the target set FIRST and throwing on it, which is what this code did until now, made (2) defeat (1): an org-root Owner was handed a 403 on a row a peer had mangled, on a door where the pre-2.5a check would have admitted them without ever reading the row. Reading it SECOND costs nothing and is not a weakening of (2), because the org-root arm is not a "targets are fine" verdict — it is the whole pre-2.5a check, unchanged, at a scope no target can influence.

THE ORG-ROOT ARM IS ONE DEPTH-0 EXPANSION, so running it first is also the cheap order: `scopeExpandCte` seeded at the org root produces a single row, and it returns before any target is walked. `checkAtOrgRootOrScopes` evaluates it first by construction and refuses an empty `scopeObjectIds` explicitly in both quantifiers, so passing `[]` for an unreadable target set falls back to the org-root arm ALONE rather than passing vacuously — which is precisely the shape (1) and (2) need.

The verdict distinguishes the two refusals so each caller can throw its own message: "the row has no readable target set" is a statement about the ROW, "you lack X at the org root and at <these targets>" is a statement about the CALLER, and collapsing them would tell an operator the wrong thing to fix.

### §62. Read bar: at the org root, or at any one target

READ bar: `object:read` at the ORG ROOT **or** at ANY ONE of the change's targets.

`hasPermission` rather than `authorize` throughout (inside `checkAtOrgRootOrScopes`) so a refusal at one arm falls through to the next; one clear 403 naming the whole target set is thrown if none matched. Note that `hasPermission` can still THROW on a refusal it cannot trust (ADR-0037's depth-truncation probe) — a deep containment chain above one target makes the whole read loud rather than silently answering from the remaining targets, which is the direction that convention already chose.

THE ORG-ROOT ARM IS WHY THIS IS NOT JUST A LOOP OVER THE TARGETS. It used to be enough to say "an org-root holder is matched by the FIRST target, because the walk reaches the org root from any object" — and that sentence is false for a target whose containment parents have been tombstoned, where the walk reaches nothing at all. See the block above and `authz/org-root-arm.ts`. The org-root arm is also still the ONE-QUERY common case for an org-root holder: it is tried first and returns before any target is walked — and, per `checkAtOrgRootOrChangeTargets`, before the persisted target set is even inspected.

### §63. Write bar: at the org root, or at every target

WRITE bar: `object:write` at the ORG ROOT **or** at EVERY one of the change's targets — the same per-target loop `assertCoordinationTargetsWithinAuthority` runs at propose time, so a change cannot be stopped, accepted or rolled back by a principal who could not have proposed it.

The org-root arm is the same widening the read bar takes and for the same reason (a tombstoned ancestor cuts a target's chain), and it is tried FIRST — before the persisted target set is read at all (`checkAtOrgRootOrChangeTargets`), which is what keeps the trap-4 refusal from reaching a principal the pre-2.5a check would have admitted. Running it first also keeps a `deny` bound below the org root exactly as inert as the org-root pin left it, rather than newly honouring it. See `authz/org-root-arm.ts`.

THE REFUSAL STILL NAMES THE ONE TARGET THE ACTOR LACKS, not the whole set: that is what `OrgRootOrScopedVerdict`'s `refusedScopeObjectId` carries back, and the message is deliberately word-for-word `authorize()`'s so the wire answer is unchanged from the per-target loop this replaced.

`cancel` TAKES THIS BAR ALONE. `accept` and `rollback` compose `assertAcceptableAtEveryChangeTarget`, which runs this one FIRST and then demands `change:accept` on top of it — see there for why cancel is deliberately left out.

### §64. ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION

ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION — extracted so the two bars `accept` and `rollback` stack cannot drift on the org-root arm, the trap-4 refusal or the wording of the 403. The message names the permission it actually demanded, which is the whole diagnostic value of a stacked bar: "lacks 'change:accept' at scope X" tells an operator to grant a purpose role, while "lacks 'object:write' at scope X" tells them the principal has no standing on that target at all.

### §65. Accept bar: writable everywhere, and then accept

ACCEPT bar: `assertWritableAtEveryChangeTarget` **and then** `change:accept`, each at the ORG ROOT **or** at EVERY one of the change's targets (role-model.md §1.3f/§4.3/§8.4; drizzle/0099).

ADDED, NEVER SUBSTITUTED. `object:write` at every target is still demanded and is still checked FIRST, so this door only ever refuses MORE principals than it did before — a subject who could not accept yesterday cannot accept today by holding `change:accept` alone. Running the generic bar first also keeps the refusal an operator sees for the ordinary "you have no standing on target B" case byte-identical to the one 2.5a shipped; the `change:accept` refusal is reached only by a principal who genuinely does administer every target.

SAME LOOP, SAME QUANTIFIER, SAME ORG-ROOT-ARM ORDERING. Both bars go through `checkAtOrgRootOrChangeTargets`, so the pure-widening property (the org-root arm is evaluated before the persisted target set is even read) and the trap-4 refusal (an empty, missing or malformed `properties.targets` refuses a SCOPED principal explicitly rather than passing vacuously) hold for the new bar exactly as they do for the old one. Writing a second hand-rolled loop here is how those two properties would have silently diverged.

EVERY TARGET, not any: a ComponentAdmin over one target of a five-target change must not be able to accept the release into the four they have no standing on.

WHY `cancel` DOES NOT COMPOSE THIS — the boundary, stated where it is easiest to erase
Cancelling STOPS a release; accepting and rolling back AUTHORIZE one (a rollback proposes a NEW change carrying the original's target set and drives it through the same wave machinery). Folding cancel in would make a cancel-only incident-responder role — hold `object:write`, stop a bad release, authorize nothing — inexpressible, and that is the role an org most obviously wants to seat on-call. `routes/changes.ts`'s cancel handler therefore calls `assertWritableAtEveryChangeTarget` directly and must keep doing so.

THIS IS THE ONE INTENTIONALLY BREAKING GRANT IN THE ROLE DESIGN
drizzle/0099 grants `change:accept` to Owner, Administrator, OrgAdmin, ServiceAdmin and ComponentAdmin, and DELIBERATELY NOT to Operator or Approver. Both of those hold `object:write` and can accept and roll back releases on every deployment today, and on upgrade they stop being able to. That is the intent — accepting a release into production is not the same authority as editing the graph, and it was only ever the same permission because the cumulative ladder had no way to say otherwise (role-model.md §0). It has to be ANNOUNCED, not discovered in a 403.

### §66. THE VERDICT-READ RULE

THE VERDICT-READ RULE — one bar for Decision rows, wherever they are served

Decision rows about one subject are served by TWO doors: `GET /decisions` + `GET /decisions/{id}` (as themselves) and `GET /changes/{id}/explain` (embedded, via `listDecisionsForSubject`, whose subject is the change). One dataset behind two different bars is a defect either way round — it makes "may I see why I was blocked" depend on which URL the caller happened to open. So both sites obey ONE rule, stated here and pointed at from each:

```text
A principal who may READ the thing a verdict is about may read the verdict about it —
`object:read` at the subject, and where the subject is a CHANGE, at ANY ONE of its targets,
which is exactly the bar `assertReadableAtSomeChangeTarget` puts on the change itself.
PLUS, always, the deployment-wide auditor's arm: `audit:read` at the ORG ROOT.
```

WHY THE READ BAR AND NOT SOMETHING STRICTER, decided rather than lowered to match. Charter principle 6 says every blocked response carries a `decision_id`; a `decision_id` its recipient is then 403'd on is a reference to nothing. `/explain` is the door `scp change explain` is built on and has always served these rows to whoever may read the change, so the strict alternative is not "raise /explain" — it is "delete the explanation from the product". The bar that stands is the one that lets the party who was refused read the refusal.

WHY THE ORG-ROOT ARM SURVIVES ANYWAY (role-model.md §8.6). §8.6's caveat is that re-scoping this door to `decision.subjectId` hands the accountability record to the party being held accountable. The target-based arm does NOT reopen that, for two reasons: it is per-subject, so it never becomes an enumeration — an UNFILTERED `GET /decisions` still admits only the org-root arm, and the LIST half (increment 2.5b) is where a filterable listing would have to answer for itself — and the record a target's admin can reach is the record of a release against their own estate, which `/explain` already showed them. What §8.6 protects is the DEPLOYMENT-WIDE read: seeing every verdict ever recorded, across subjects you have no standing on. That stays behind `audit:read` at the org root, and it is the broad arm here.

### §67. DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE

DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE (role-model.md §8.6) — the verdict-read rule above, as code:

```text
`audit:read` at the ORG ROOT     — the auditor's read, deployment-wide, unchanged in reach
OR `object:read` at the SUBJECT  — resolved as the rule says: at ANY ONE TARGET when the
                                   subject is a CHANGE, at the object itself otherwise
```

THE CHANGE CASE IS WHY THE SECOND ARM RESOLVES TARGETS RATHER THAN CHECKING `subjectId` DIRECTLY, and it is not a refinement — without it that arm is INERT for the dominant Decision subject. A change is what almost every Decision in this system is about (`gate`, `wave_target`, `transition`, the promotion and retrans kinds), and a change has no scope of its own: its containment chain runs to the org root (see the block at the top of this file). So `object:read` at `decision.subjectId` for a change-subject Decision is satisfiable only by an ORG-ROOT binding — the very principals the first arm already admits — and the scoped principals the arm exists for would still have been refused.

COMPOSED FROM `checkAtOrgRootOrScopes`, the same one definition of the org-root arm the change, campaign and source-mapping doors use — and this is the door that shows why that helper takes TWO permissions rather than one: the wide arm is `audit:read`, the narrow arm `object:read`, because the two arms answer different questions. `hasPermission`, not `authorize`, on both arms (an arm that threw could not be fallen through) and one clear 403 naming both if neither holds. `readChangeTargetScopeIds`, not `changeTargetScopeIds`, for the same reason: an unestablishable target set must make the SUBJECT arm fail, not the whole check, so the org-root auditor still reads a Decision whose change has since had its `properties` mangled. Refusing there would let a bad row erase the accountability record, which is the opposite of what an audit read is for.

A TOMBSTONED ANCESTOR CANNOT LOCK THE AUDITOR OUT HERE, and that is not luck: the wide arm is checked at the org root, whose expansion is a single depth-0 row, so it is unaffected by whatever happened to the subject's containment chain. The SUBJECT arm alone would be — which is the defect `authz/org-root-arm.ts` exists to prevent everywhere else.

THE WIDE ARM IS THEREFORE NOT LITERALLY THE OLD CHECK, and that is a DECIDED narrowing rather than an oversight — the one place in increment 2.5a where the pre-2.5a check is not reproduced verbatim. Pre-2.5a this door demanded `object:read` at the org root; the arm here demands `audit:read` there. Widening it back to `object:read OR audit:read` was considered and REFUSED: `object:read` at the org root is held by four of the five built-in roles, so folding it in re-opens the exact escalation §8.6 names (handing the deployment-wide record of every verdict ever taken to anyone who can read the estate), and it would put the door on the wrong permission just as role-model.md §5 step 3 begins binding purpose roles in the field.

The narrowing has NO POSSIBLE HOLDER, and that is pinned rather than asserted: every seeded role carrying `object:read` also carries `audit:read` (`drizzle/0002_rls_rbac_seed.sql`), there is no custom-role API to author one that does not, and `change-target-scope.integration.test.ts`'s "the `audit:read` wide arm narrows NOBODY who can exist" case reads the `roles` table and fails if that ever stops being true — at which point this decision has to be made again with a real principal in hand. The argument used to carry a third clause — "and where a subject IS named the second arm admits any org-root `object:read` holder anyway (the scope walk reaches the org root from any object)" — which is exactly the false-exhaustive claim this pass removed everywhere else: a subject whose ancestors are tombstoned reaches nothing. The first two clauses stand on their own and the third is gone. This also puts the door on the permission role-model.md §5 step 3 wants it on, before five purpose roles start being bound in the field.

The subject is looked up with the NON-throwing `findObjectByIdOrUrnAnyType`: a decision outlives its subject (that is what an audit record is for), and a subject that no longer resolves must leave the org-root auditor's read working rather than 404 the accountability record away. That lookup now runs BEFORE the check rather than inside the second arm, because the helper wants the scope set up front — one indexed lookup an org-root auditor did not previously pay for, against the two recursive CTEs the check itself runs.

### §68. The server-owned `sourceRef` keys

The server-owned `sourceRef` keys (`boundaryBundleChecksums`, `promotionExports`) are stamped by the exporter/importer and RENDERED as facts ("manifest signed for <peer>") — a caller who plants one would make the pipeline claim a signing that never happened. Refused loudly rather than stripped silently: `sourceRef` is otherwise kept verbatim, so a caller must learn its payload was not stored as sent. Checked before any tx is opened.

### §69. An emergency change needs a permitted actor

DESIGN §10.3: "a change flagged emergency by a PERMITTED actor" — `object:write` alone is not enough to set `emergency: true`, since that flag is what lets `governance/gate-orchestrator.ts` swap in the (possibly gate-bypassing) emergency policy set instead of the normal required policies. Without this check, any subject who can propose a change at all could self-grant an emergency bypass — the exact "emergency-bypass authz" surface this milestone's security review targets. Only checked when the flag is actually being turned on; a normal (non-emergency) propose is unaffected.

### §70. Bind the change's declared targets to the actor's own

P4B Phase 2: bind the change's DECLARED targets to the actor's own authority. The `object:write`-at-domain check above is NOT enough — a proposer could otherwise target an object in another domain they don't control and inject a release (or, post-P4B, a `requires`/`provides` coupling) against it. Mirrors campaigns exactly (`campaign-scope-authz.ts`). Deliberately HERE at the route, not inside `proposeChange`: the engine's own callers (webhook correlation, rollback, campaign fan-out, federation import) run as trusted system/federation actors that must not face a human-authority check — the route is the only untrusted propose path.

### §71. Resolved first, then scoped

Resolved first, then scoped — see `GET /changes/{id}` above for why that order matters.

ONE BAR for the `decisions` this response embeds: the change's own read bar IS the verdict-read rule's second arm ("a principal who may read the thing a verdict is about may read the verdict about it"), so everything served here is also served by `GET /decisions/{id}` — see THE VERDICT-READ RULE at the top of this file. That was not true before: `/decisions/{id}`'s subject arm checked `object:read` at the change ITSELF, which for a change means the org root, so this door served rows that one refused.

### §72. Which stage dependency withholds, re-evaluated live

ADR-0028 increment 4 — which stage dependency is withholding a trigger, RE-EVALUATED NOW. Deliberately not read off the `stage_dependency` Decision in `decisions` above: that row is a historical record with no clearing counterpart, so it still says `hold` long after the hold released (and on an outpost the latest row of that kind is the import-time `allow`). Null for a change that coupled nothing.

### §73. `ChangeWaveSchema.heldTargetCount`'s SECOND HALF

`ChangeWaveSchema.heldTargetCount`'s SECOND HALF: `plan` already carries the freeze-held count (`getLatestPlanForChange` computes that half unconditionally). This handler is the one caller that ALSO computes `stageDependencyStatus`, so it is the one place that can add the stage-dependency-held count without a second evaluation of that predicate. Only `stageDependencyStatus.waveIndex` can carry any (that status only ever evaluates the active wave), so every other wave's count is freeze-only, unaffected.

NOT DISJOINT BY DEFAULT — the two halves are computed by two independent predicates (`resolveWaveTargetFreezeHolds` and `evaluateStageDependencies`) over the SAME candidate set (the active wave's `pending`/`triggering` targets), unlike `reconcile.ts`'s admission loop, where only one `continue` can fire per target per tick, making the two hold sets disjoint BY CONSTRUCTION (reconcile.ts's invariant 4 on the freeze-hold `continue`). A target that is simultaneously frozen and dependency-held would otherwise be counted in BOTH halves — a one-target wave reporting `heldTargetCount: 2`. Exclude any target this wave's freeze half already counted before adding the stage-dependency half.

`hold.freezes.length > 0`, NOT the mere PRESENCE of `hold`. Those were the same test until increment 8 gave `hold` a second half (`continuousTests`): a target held only by a continuous probe now carries a `hold` with an EMPTY `freezes`, and reading presence would silently start treating it as freeze-held and drop it from the stage-dependency count — an undercount produced by a field that has nothing to do with either half being added.

### §74. The second projection of a control run, same increment

M22.8 — the SECOND projection of `ControlRunSchema`, filled in the same increment as the first. `/control-runs` and `/explain` both render this shape, and shipping the crossing on one but not the other would make "which run authorized production" a question whose answer depends on which endpoint you happened to open — the exact half-installed shape a filterless census of `ControlRunSchema`'s consumers exists to catch. Those two handlers are the complete census.

### §75. Write at every target, and deliberately not accept

`object:write` at EVERY target, and DELIBERATELY NOT `change:accept` — this is the one door of the three that does not compose `assertAcceptableAtEveryChangeTarget`. CANCEL IS NOT ACCEPT: it STOPS a release rather than authorizing one. Folding it into `change:accept` (role-model.md §5 step 3, shipped in drizzle/0099) would make a cancel-only role — the shape an incident responder wants — inexpressible, so an Operator who can no longer accept can still stop a bad release.

### §76. `object:write` AND `change:accept`, each at EVERY target

`object:write` AND `change:accept`, each at EVERY target — one target's admin must not be able to accept the release into the other four, and accepting a release is no longer the same authority as editing the graph (role-model.md §5 step 3, drizzle/0099). BREAKING, DELIBERATELY: Operator and Approver hold `object:write` and are NOT granted `change:accept`, so a principal on either rung stops being able to accept on upgrade.

### §77. Write and accept at every target of the original

`object:write` AND `change:accept` at EVERY target of the ORIGINAL change — a rollback proposes a NEW change carrying that same target set (`coordination/rollback.ts` reads it with the very same `targetObjectIdsOf`) and drives it through the same wave machinery, so it AUTHORIZES a release rather than stopping one. Anything less would also let one target's admin drive a release into the rest. Same breaking grant as `accept` above.

### §78. The subject arm is offered only when a subject is pinned

The subject arm is offered only when the caller PINNED a subject — an unfiltered listing spans every subject in the org, so nothing narrower than the org-root audit read can stand behind it. Row-level filtering of an unpinned listing is the LIST half of this blocker (role-model.md §8.2/§8.7, increment 2.5b) and is deliberately not attempted here: every list repo derives `nextCursor` from the last UNFILTERED row, so post-filtering a page silently shrinks it after the LIMIT.

## `apps/server/src/routes/components.integration.test.ts`

### §79. Strict create-in-service for `component`

Strict create-in-service for `component` (M12 P5a, docs/proposals/organize-after.md). This is the DEDICATED acceptance suite for the invariant "a directly-created component belongs to a service" — the migration proves the rest of the codebase still works through the strict route, and service-contains / plans / typed-registries-cli prove the containment/IaC/CLI edges; here we pin the route contract itself: - POST /components requires a service and writes the `contains` edge atomically; - the GENERIC /objects/component route refuses every write verb (403) — the strict route is the only way in; - IMPORT (discovery/accept) stays permissive — an imported component may be an orphan; - PUT is strict on create, field-only on update; - the create is authority-gated at the service (relationship:write), not just the domain.

## `apps/server/src/routes/components.ts`

### §80. Strict `component` routes

Strict `component` routes (M12 P5a, docs/proposals/organize-after.md). `component` is deliberately NOT a `TYPED_REGISTRY_RESOURCES` entry (the shared template's `POST`/`PUT` cannot require a service and write the `contains` edge atomically) and is refused on the generic `/objects/component` route (`objects-generic.ts`'s `assertNotServiceMemberObjectType`). So this is the ONLY route by which a component is created directly, and it requires a service.

`POST`/create-branch of `PUT` are strict; `GET`/list/`PATCH`/`DELETE` are byte-for-byte the shared template's behaviour (updating/reading/deleting a component needs no service — re-assignment is P5b's `move` verb). Imports (discovery/accept, federation, overlay) call `createObject` directly, never these routes, so they stay permissive.

### §81. GET /components/:idOrUrn/pipeline — THE COMPONENT'S PIPELINE

GET /components/:idOrUrn/pipeline — THE COMPONENT'S PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03). One projection of the component's STAGES — its placements — with what executes at each and what last released there.

The point of the correction: this is well-defined for a component with nothing in flight. The surface it replaces was keyed on a change, so a stable component had no pipeline at all. An extra `/pipeline` segment, so it never collides with the registry's `/:idOrUrn` detail route — same shape as `/services/:idOrUrn/board`.

### §82. GET /components/:idOrUrn/scan-requirements — M22.8

GET /components/:idOrUrn/scan-requirements — M22.8 (ADR-0033 §11, charter principle 3).

THE RULES IN FORCE FOR ONE COMPONENT: the resolved six-tier ceiling and every tier that contributed to it (ADR-0016), plus which exclusion CLASSES the tiers above admit and where a clause of each would actually have effect (ADR-0033 §1).

IT WRITES NO DECISION. That is the whole reason it exists as a separate surface rather than "just call `POST /policy-evaluate`": that endpoint runs the real orchestrator and writes one Decision per call with no suppression, so a polled UI on it would recreate — per viewer, per interval — the 1.44 GB/day amplification ADR-0024 §D0 exists over. Anything added to this handler that writes a row breaks the contract this route is named for.

An extra path segment, so it never collides with the registry's `/:idOrUrn` detail route — the same shape as `/pipeline` above and `/services/:idOrUrn/board`.

### §83. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7), inherited from `graph/objects-repo.ts`'s `deleteObject` — the same choke point, so the same declaration as the typed-registry template next door, and for the reason stated there: the floor runs when `objectTouchesRoleAuthority` says this row is some binding's subject or has a live `member_of` edge, and that probe reads `role_bindings.subject_id`, an unconstrained uuid, rather than a type. Additive: `deleteComponent` previously declared 200/401/403/404.

## `apps/server/src/routes/containment-move-authz.integration.test.ts`

### §84. The containment parent is an authorization-bearing field

THE CONTAINMENT PARENT IS AN AUTHORIZATION-BEARING FIELD, AND EVERY DOOR THAT WRITES IT MUST SAY SO.

`objects.domain_id` is not an ordinary column. RBAC scope expands strictly UPWARD (`authz/resolve.ts`), so the value of this one field decides *who else* holds authority over the row. Two consequences, and this file pins both:

- **B1 — a MOVE is a write at two places.** Re-parenting X under V hands every holder of a binding at V (or above V) authority over X. A door that authorizes only at X therefore lets an actor with write over X alone plant it inside a stranger's subtree. - **B2 — `null` is not a containment parent.** A row with `domain_id IS NULL` is DETACHED: its scope expansion terminates at itself, so no ancestor binding — not even the org root Owner's — can ever reach it again.

Every case here goes through the real HTTP doors (`server.app.inject`), never the repo functions: the defect in both cases was a route that resolved the wrong scope, which a repo-level test cannot see. Cases are grouped by DOOR rather than by defect, because the census that produced this file is "every door that writes a caller-supplied `domainId` onto an existing row" — PATCH and PUT, on the generic route, the typed-registry factory, and the bespoke component route.

## `apps/server/src/routes/containment-move-cycle-and-source-authz.integration.test.ts`

### §85. The two ways a move still broke the org-root chain

THE TWO WAYS A CONTAINMENT MOVE STILL BROKE THE ORG-ROOT CHAIN AFTER `containment-parent-authz.ts` BECAME THE CHOKE POINT.

That module closed two defects — a move authorized only at the object, and a wire `null` written through as a detach. Both are instances of ONE property: *a write that leaves a row whose authority chain does not terminate at the org root, or that hands custody of a row to someone who did not have it*. The choke point closed the two values that had been observed. Two more values reach the same property through the same door, and this file pins both:

- **C1 — a CYCLE is a detach with no `null` in it.** The refusal was `destination === current.id` only: a depth-1 self-parent. Move X under its own child C and neither hop trips it, yet `X -> C -> X` has no org-root ancestor at all. `authz/resolve.ts`'s scope expansion walks UPWARD and terminates inside the loop, so no binding above the cycle — the org root Owner's included — reaches either row again. They cannot be read, edited, moved back or deleted, by anyone, ever. That is byte-for-byte the outcome `domain_id IS NULL` produced.

- **C2 — a move was authorized at the DESTINATION and never at the SOURCE.** Authority expands strictly upward, so holding it AT an object implies nothing about the container the object currently sits in. An actor bound narrowly at X could therefore yank X out of a container they hold nothing at — the mirror image of the defect the module exists to close, and the exact shape `graph/components-repo.ts`'s `setComponentService` already refuses ("the OLD service too on a move (it loses a child)").

Both are pinned on the HTTP door AND on the IaC apply door, because apply is a second, independent copy of the same decision (`iac/plans-repo.ts` calls itself "the apply-path twin of `graph/containment-parent-authz.ts`") and a twin is where the next instance hides.

RE-RUNNING THIS, AND THE THREE SUITES A CHANGE HERE MUST NOT BREAK
With FULL PATHS, because the commit that added this file (`16e836c`) named those suites by bare filename — and a bare filename is a NO-OP here. vitest given a path it cannot resolve runs nothing and EXITS 0; `apps/server`'s `test:integration` script passes `--passWithNoTests`, so that empty run reports success. "Green" then means "never executed". The DEFAULT vitest config additionally EXCLUDES `*.integration.test.ts`, so `--config` is not optional either. From `apps/server` (the `DOCKER_HOST` line is for a local colima socket; CI provides its own Docker):

```text
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true \
  npx vitest run --config vitest.integration.config.ts \
    src/routes/containment-move-cycle-and-source-authz.integration.test.ts \
    src/routes/containment-move-authz.integration.test.ts \
    src/governance/governance-managed-write-doors.integration.test.ts \
    src/dependencies/subscription-authoring-guard.integration.test.ts
```

Then READ THE FILE LIST vitest echoes back and confirm all four are in it before believing the result — that check is the only thing separating a pass from a silent no-op.

### §86. THE API WILL NOT STRAND `stranded` FOR US

THE API WILL NOT STRAND `stranded` FOR US: `deleteObject`'s route-1 orphan guard (M20, the ui-review branch) refuses to tombstone a domain that live children still name — 409, blockers named — precisely so this shape cannot be produced through a door. Pinned here as the negative control, because if that guard ever went quiet this fixture would silently start testing a state the API can produce.

### §87. The shape that makes the depth bound load-bearing

The shape that makes the depth bound load-bearing rather than decorative, and the only shape that isolates it. The destination is a DAG with two routes up:

```text
destination --domain_id--> org root                      (1 hop: the root IS on the chain)
destination --contains---> deepService -...-> movable     (10 hops; the root behind it at 11)
```

So `the org root is missing` does not fire, and yet the move WOULD close a real cycle whose proof lies at the edge of the bound. Under ADR-0037 the walk does not truncate silently: it probes one level PAST the bound and REFUSES when anything is there — and the containment- parent door turns that refusal into its own 400 (`containmentParentChainForDoor`'s conversion branch: "a row under it would sit past the bound on that route"). Delete that conversion — or let the door read a shortened chain — and this case is the one that goes red (measured 2026-08-18: `throw error` in place of the conversion, in CODE, turned exactly this case red while `containment-depth-doors` stayed green — the two files pin two different properties).

WHY THIS BRANCH IS STILL LOAD-BEARING when no door can build the shape any more: the depth invariant is a WRITE door, so rows planted before 2026-08-18, or arrived under the federation-import carve-out, are untouched by it. Whether an estate actually holds one is a measurable fact, not a guess — `scripts/containment-depth-census.sql` asks each database. Review pair, 2026-08-18: zero rows past the bound (deepest live route 5 on the commander, 6 on the outpost); production not measured from a laptop. So today this is defence-in-depth against a state no current door can create, and the comment says so rather than implying a live population.

Nine levels under `movable`: `deep-9`'s own chain is exactly ten hops — the ceiling, complete and readable — so a row under it would sit at hop ELEVEN. Since the owner ruling of 2026-08-18 (ADR-0037 Consequences; `graph/containment-depth-doors.integration.test.ts`) NO door will write that row: `POST /components {service: deep-9}` — the way this fixture used to be built — now answers 400 from the `contains` door. The hop-eleven shape is therefore PLANTED below the doors, exactly as the refusal-3 case above plants its tombstone: the component is created legitimately under a root-level service, and its `contains` edge is then re-pointed at `deep-9` by a direct UPDATE. That is the population this conversion branch exists for — a legacy row, or one that arrived under the federation-import carve-out — and it is labelled as such rather than dressed up as something a door can produce.

## `apps/server/src/routes/containment-parent-doors-census.integration.test.ts`

### §88. THE REST OF THE CENSUS

THE REST OF THE CENSUS: the doors `containment-move-authz.integration.test.ts` does not name.

That file pins the two defects (a move authorized only at the source; a wire `null` written through as a detach) on five doors. It is not the whole census. The property is "a door that accepts a caller-supplied `domainId` for an object write", and enumerating it filterlessly turns up three more:

- `PUT /components/{urn}` — BOTH branches. Measured: deleting this door's call to `resolveDeclaredContainmentParent` broke NOTHING in the sibling file. A door with the same defect and no test is how a fix ships inert. - `POST /components` and the other create doors — the create half of the `null` question. Two create doors already coerced `null` to the org root by hand and four did not; this file pins the agreed meaning on both kinds so the asymmetry cannot come back through whichever door was not looked at.

- the three coordination create doors (`/campaigns`, `/changes`, `/placements`; `/initiatives` is gone — ADR-0036) and `POST /plans/{id}/apply`, whose update entries authorized the object and never the destination.

Plus the two refusals the fix ADDS rather than restores, both of which are the SAME PROPERTY as the `null` detach — "a row whose scope expansion cannot reach the org root" — reached through a different value:

- a row may not become its own containment parent. Reachable the moment `null` started resolving to the org root: `PATCH <org-root> {domainId: null}` would otherwise write a self-loop, and a cycle has no org-root ancestor. NOTE the refusal is no longer the depth-1 test these two cases exercise — a two-hop loop walked straight past that one. It is now a full chain walk (`graph/containment.ts`'s `assertRootedContainmentParent`), pinned at every depth, on both containment routes and on both doors by `containment-move-cycle-and-source-authz.integration.test.ts`. - a SOFT-DELETED object may not be a containment parent. `authz/resolve.ts` joins `parent_o.deleted_at IS NULL` on every hop of the scope walk, so parenting under a tombstone detaches exactly as `null` did. Measured, not reasoned: before the fix, `DELETE /domains/{d}` then `PATCH /services/{s} {domainId: d}` answered 200 and the org-root admin's own next GET of that service answered 403, permanently.

### §89. `/objects/service` is NOT the generic door

`/objects/service` is NOT the generic door. Fastify prefers the literal static route over the parametric `/objects/:type` for that exact path, and `services/objects-service.ts` says so in as many words: "this is the ONLY handler that ever runs for that path". A case aimed there exercises the M0 shadow handler and reports on a door it never touched — the census's own failure mode. `team` has no static shadow and is refused by none of the generic route's type guards, so it genuinely lands in `routes/objects-generic.ts`'s handler.

## `apps/server/src/routes/containment-parent-liveness.integration.test.ts`

### §90. THE VALIDATION HALF OF A `domain_id` WRITE

THE VALIDATION HALF OF A `domain_id` WRITE — "does this id still name a LIVE object in this org?"

`graph/containment-parent-authz.ts` owns the AUTHORIZATION half of a containment-parent move and says so at length. Its own module doc named the other half and assigned it to the repo — this is what it said BEFORE this file existed, quoted because the gap is exactly the gap between the sentence and the code:

```text
> What the repo owns is the invariant half: `resolveContainmentParent` (called from here) is
> what rejects a `domainId` naming an object outside the org, and `createObject` still resolves
> the default parent for itself.
```

`createObject` does exactly that (`objects-repo.ts`, `resolveContainmentParent` on line 1 of its body). `updateObject` did NOT. Its `domain_id` write was

const nextDomainId = input.domainId === undefined ? existing.domainId : input.domainId;

— the caller's value, straight onto the column. Every guard that ran afterwards asked a different question, and the one that looks closest is the one that made this hard to see: `assertRootedContainmentParent` walks `containmentChain(parentId)`, and that walk **deliberately does not filter `deleted_at` on its seed row** ("the TARGET itself is not filtered — governance may legitimately be evaluated over a deleted object"). So a TOMBSTONED parent whose own ancestors are alive seeds the walk, reaches the org root through them, and is pronounced rooted. The refusal that exists for precisely this value — `resolveContainmentParent`'s `deleted_at IS NULL` filter, whose comment records the incident it was installed for — never ran on the update path at all.

## Why that is the unrecoverable state, not a cosmetic one

`authz/resolve.ts`'s `scopeExpandCte` joins `parent_o.deleted_at IS NULL` on every hop. A row parented under a tombstone therefore has its scope expansion terminate at itself: no ancestor binding, **not even the org root Owner's**, reaches it again. It cannot be read, edited, moved back or deleted through the API by anyone, while governance keeps matching it (policy matching reads `properties.scope`, never placement). That is byte-for-byte the state `resolveContainmentParent`'s comment measured — `DELETE /domains/{d}` then `PATCH /services/{s} {domainId: d}` answering 200 — reached here through a different door.

## Which door, and why the HTTP doors alone were not the whole story

Every HTTP door calls `resolveDeclaredContainmentParent`, which calls `resolveContainmentParent`, so the doors were closed. **IaC apply is not a door in that sense.** `POST /plans` resolves the manifest's `domainId` ONCE, at plan-compute time, and PERSISTS the resolved value in the plan's diff; `POST /plans/{id}/apply` — a separate request, arbitrarily later — replays that stored value through `updateObject` without ever calling the helper. Soft-delete the parent in between and the stale pointer is written. That asymmetry is the whole defect: `createObject` re-validates at APPLY time (it calls `resolveContainmentParent` itself), so the same TOCTOU on the CREATE branch is already refused, and only the UPDATE branch was open. `containment-root-source-and-create-rooting` pins the create half; this file pins the update half.

## Installation, and how it is proved

Deleting the `resolveContainmentParent` call from `updateObject` must make the first test below fail. It asserts the ROW, not the status code: an unreachable row is exactly the one a read API would hide, so "the GET 403s" would pass whether or not the write landed.

### §91. THE DOOR HALF, PINNED

THE DOOR HALF, PINNED. It was already closed (`resolveDeclaredContainmentParent` -> `resolveContainmentParent`), and the repo-side guard must not be the only thing holding it — if this ever starts depending on the repo check, the door regressed.

## `apps/server/src/routes/containment-root-destination-authz.integration.test.ts`

### §92. THE OTHER END OF THE OVER-BROAD ORG-ROOT REFUSAL

THE OTHER END OF THE OVER-BROAD ORG-ROOT REFUSAL.

`containment-root-source-and-create-rooting.integration.test.ts` pins R1: moving a ROOT-PARENTED object INTO a container the actor owns stopped demanding org-root authority, because the source check's premise ("the source container's holders lose custody") is false for the org root.

The MIRROR was never reasoned about. Moving an object BACK OUT to the top level — the destination IS the org root — still demanded org-root authority, so an actor who fully owns a subtree could not move their own object out of it. That is R3, and the argument that settles it runs in exactly the same direction as R1's:

```text
- The destination check exists because "re-parenting X under V hands every holder of a binding
  at-or-above V custody of X" (`graph/containment-parent-authz.ts` §1).
- AFTER a move to the top level, X's chain is `X -> org root`, so the holders who would "gain"
  custody are the org root's.
- BEFORE it, X's chain ALREADY terminated at the org root — that is the root-reachability
  invariant `assertRootedContainmentParent` enforces on every `domain_id` write, create half
  included. The org root's holders therefore already held custody of X.
```

So the custodian set STRICTLY SHRINKS across this move — `{X's holders} u {root's holders}` is a subset of `{X's holders} u {every holder on X -> S -> ... -> root}` — and a move that can only remove custodians is not the escalation the check exists to stop. It is the org root and nothing else: every other destination genuinely adds custodians.

## Why the FIRST case in this file is a success and not a refusal

An over-broad refusal and a deliberate one look IDENTICAL from a failing test, and this suite is built almost entirely out of refusals — which is structurally blind to refusing too much. The legitimate direction is therefore asserted first and asserted loudest, and the controls below it exist so a "fix" that simply deleted the destination check would not leave the file green.

## What is deliberately NOT exempt, and is pinned here

- A CREATE at the top level. A fresh row has no chain to already contain the org root, so the "nobody gains" argument does not run: creating a row at the top level really does hand the org root's holders a row they did not have. That check lives at the create doors (and at `iac/plans-repo.ts`'s create branch, which authorizes at `entry.target?.domainId ?? orgId`) and is untouched. - A move into any ORDINARY container the actor holds nothing at. - THE MOVE IS NOT FREE. The SOURCE check still runs, so promoting a row to the top level requires authority over the container it is LEAVING. "Owns the subtree" is the whole entitlement.

Pinned on the HTTP doors AND on the IaC apply door, because `iac/plans-repo.ts` carries its own copy of the destination decision and carried the identical defect — a fix in the helper alone was proven insufficient by mutation on the source-side half one round earlier.

### §93. Bound Administrator at `sourceDomainId` and NOWHERE ELSE

Bound Administrator at `sourceDomainId` and NOWHERE ELSE. Authority expands upward, so this one binding covers the container and everything inside it — "owns the subtree" — while holding nothing whatsoever at the org root.

### §94. The field is omitted, not set to null, and that matters

`domainId` is OMITTED, not set to null, and that is the shape that matters here: the manifest schema documents an absent `domainId` as "defaults to the org root", so `resolveDomainId` turns omission into the org root and the diff records a `domainId` change. This is the shape in which the refusal bit IaC hardest — a stack author who never mentioned containment at all was told they lacked authority at a scope their manifest never named.

### §95. The boundary of the exemption, and why it is not simpler

The boundary of the exemption, and the reason it cannot simply be "the org root is never a scope worth checking". A move's destination check is redundant at the org root because the row was already inside the org root's subtree; a CREATE has no such history, so the org root's holders genuinely acquire something. Both create doors are pinned: the HTTP one here, and the IaC one below, which authorizes at `entry.target?.domainId ?? orgId` in its own branch.

## `apps/server/src/routes/containment-root-source-and-create-rooting.integration.test.ts`

### §96. The two edges that guard was installed on only half of

THE TWO EDGES `containment-parent-authz.ts` WAS INSTALLED ON ONLY HALF OF.

The sibling file `containment-move-cycle-and-source-authz.integration.test.ts` pins the two defects that module closed. Closing them left two edges uncovered, one in each direction:

- **R1 — THE SOURCE CHECK REFUSED TOO MUCH.** "A move is a write at two places" was implemented as "authorize at `current.domainId` unless it is `null`", and `null` is only ever the org root object ITSELF. Every ORDINARY object parented at the org root — which is the DEFAULT for every create that names no `domainId` — therefore carried the org root as its source container, so an otherwise unremarkable reorganisation into a container the actor owns outright demanded ORG-ROOT authority. A suite that only asserts refusals cannot see an over-broad guard, which is why the success case below is the load-bearing one.

```text
 The exemption is exactly the org root and nothing else, and it is PROVABLE rather than a
 judgement call: the source check exists because the source container's holders LOSE custody,
 and `assertRootedContainmentParent` has already proven — one line earlier, on this same path —
 that the destination reaches the org root. So the org root is on the moved row's chain both
 before and after; its holders lose nothing. No other container has that property.
```

- **R2 — THE ROOT-REACHABILITY INVARIANT WAS INSTALLED ON THE MOVE PATH ONLY.** `createObject` never called it, so a CREATE could put a fresh row under a parent whose own chain is broken (an ancestor soft-deleted) and produce exactly the unreachable state the move path refuses. The reasoning that let this through was "a fresh id cannot already be an ancestor" — true, and it covers the CYCLE refusal only. Root-reachability is a property of the PARENT's chain, not of the child's id, and a fresh id says nothing about it.

Both are pinned on the HTTP door AND on the IaC apply door. Apply is a second, independent copy of each decision — it carries its own source-check twin in `iac/plans-repo.ts` (which had R1 too, in the same words) and it reaches `createObject` through its own drained check list without ever calling the door helper (which is why R2's fix belongs at the repo, and why a door-only fix would ship inert here).

### §97. THE API WILL NOT STRAND `stranded` FOR US

THE API WILL NOT STRAND `stranded` FOR US: `deleteObject`'s route-1 orphan guard (M20, the ui-review branch) refuses to tombstone a domain that live children still name — 409, blockers named — precisely so this shape cannot be produced through a door. Pinned as the negative control; the broken chain is then PLANTED the way the refusal's own doc says such rows arise ("a legacy row, or one planted before the doors were closed"): the tombstone is written straight onto the row, below every door.

### §98. THE FIXTURE ITSELF, ASSERTED

THE FIXTURE ITSELF, ASSERTED — and this one is the whole premise. `stranded` must really have lost its route to the org root, or every refusal below would be about something else. The ORG-ROOT ADMIN can no longer read it: containment walks refuse to pass through a tombstone, so its scope expansion terminates at itself and the admin's org-root binding no longer reaches it. The insider bound AT it still can, which is what makes the create attempt below reachable.

## `apps/server/src/routes/custom-roles.integration.test.ts`

### §99. Custom roles, and the precondition this ships on

CUSTOM ROLES — role-model.md §5 step 10

THE PRECONDITION THIS SHIPS ON. The proposal gated custom roles behind closing the `hasRoleAtScope` quorum bypass, and the first test below is the reason: without that fix, an org authoring a zero-permission role named 'Approver' would have made its holders eligible quorum voters everywhere a policy names Approver. `authz/quorum-name-collision.integration.test.ts` pins the resolver; this file pins that the authoring door refuses the name outright, so the two cover the same hazard at the door and at the resolver.

WHAT AUTHORING IS. It confers nothing — `POST /role-bindings` re-runs the full subset rule against whoever tries to bind the result. The bars here keep the CATALOGUE honest: a role that advertises authority its author cannot confer misleads every operator who reads `GET /roles`.

## `apps/server/src/routes/dependency-producers.integration.test.ts`

### §100. THE PRODUCER DECLARATION'S AUTHORING SURFACE, END TO END

THE PRODUCER DECLARATION'S AUTHORING SURFACE, END TO END (ADR-0032 §7e, `routes/dependency-producers.ts`).

WHAT THIS FILE HAS TO PROVE, AND WHY EACH GATE IS THE ONE IT IS
The defect being fixed is "a function with no caller": `declareDependencyLineProducer` existed, was correct, was covered by its own repo tests, and NOTHING IN PRODUCTION CALLED IT — so `produced_by_object_id` was never set, `isInternalDependencyLine` was always false, and the internal half of dependency subscriptions could not fire at all. Four gates, and none of them is satisfied by asserting a row exists:

1. **WIRING.** Deleting `registerDependencyProducerRoutes(app, deps)` from `app.ts` must turn "(1) WIRING …" RED. Shipping a second uncalled function to fix an uncalled function would be absurd, so this is the first case in the file. MEASURED: with the registration commented out, that case fails with a 404 and the rest of the file fails with it. 2. **CAPABILITY, END TO END.** Declare through the ROUTE, then drive the REAL internal-release detection path — an accepted change reaching a `prod` deployment-target with an observed image — and assert a SUBSCRIBED component comes out of `runBumpDispatchJob` as a candidate. Before this change that sequence is IMPOSSIBLE BY CONSTRUCTION, which is what makes it the honest acceptance test. Asserting the row exists is not enough: the column was always writable. 3. **DECLARED, NEVER INFERRED.** No ingestion path may set a producer as a side effect. Pinned as a SOURCE-LEVEL CENSUS over the ingestion modules plus a behavioural check that a full ingestion run leaves `dependency_line_producers` empty — because the property is an ABSENCE, and an absence is what nobody notices regressing. 4. **NEW MAJOR.** Declare, then have ingestion mint a BRAND-NEW major line for that coordinate, and assert the version poll does not hand it to a public index. This is the entire reason the grain is per COORDINATE: under the retired per-line column that new row's producer was NULL because nobody had re-declared it, and the poll fetched the org's own package from a stranger.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Result |
| remove `registerDependencyProducerRoutes` from `app.ts` | 13 of 14 FAIL, "(1) WIRING" first, with a 404 (re-measured after the two cases below were added) | | `listThirdPartyDependencyLinesByIds` drops its `NOT EXISTS` anti-join (`sql\`TRUE\``) | "(5) … is NOT handed to a public index" FAILS — the freshly minted major reaches the poll's work-list | | BOTH producer verbs stop calling `resetLineHead` | 3 FAIL: "(3) CLEARS a poisoned public head", "(4) CLEARS the internal head", and "(7) CAPABILITY" — the last because the retraction in its negative control no longer clears `1.1.0` | | `authorize`'s scope becomes the producer component instead of the org root | "(2) REFUSES an author whose `policy:write` is bound to the producing component" FAILS | | the request schema ACCEPTS `declaredByObjectId` and the route reads it | "(2) the declaring principal is the AUTHENTICATED SUBJECT" FAILS — the impostor id is stored | | `assertDeclarableProducer` drops its `service` arm | "(2) REFUSES a producer that is not a live in-org COMPONENT" FAILS |

TWO SURVIVORS, both fixed here rather than recorded and left:

- **the `service` arm, deleted, left the whole file GREEN.** The case asserted only `400` + `/service/i`, and the generic wrong-type arm answers `400` with a message that also contains the word "service" ("… is a service"). The two arms were indistinguishable to the test. Fixed by pinning the two phrases the owner's ruling actually requires — that the refusal is FIRST-CUT and that it is about POLLING — which is the one place in this file where wording is asserted, and it is asserted because the wording IS the requirement. - **reading `declaredByObjectId` from `request.body` alone left the file GREEN**, because the request schema is a plain `z.object()` and this repo's `z.toJSONSchema()` emits `additionalProperties: false`, so fastify strips the key before the handler sees it. The property survives on TWO independent legs, which is the right shape; the mutation that breaks both at once (add the field to the schema AND read it) is the one in the table above, and it fails.

### §101. `federationRole: "commander"` DECLARES the posture

`federationRole: "commander"` DECLARES the posture. The writes are commander-only and fail-closed on an UNDECLARED deployment (ADR-0032 §7d); the harness leaves `SCP_FEDERATION_ROLE` unset by default, which yields a DEFAULTED commander (`federationRoleDeclared: false`) under which every declare below would answer 409. The refusal gets its own server in "(6)".

### §102. THE WHOLE POINT

THE WHOLE POINT. `declareDependencyLineProducer` was correct, tested, and unreachable. This case asserts REACHABILITY and nothing else, so that "the route file exists" can never again be mistaken for "the capability is installed".

A 404 here means the path is not mounted. Any other status — including a 400 or a 403 — means the route IS mounted and something further in is refusing, which is a different bug and belongs to a different case.

### §103. THE WORDING IS PINNED HERE, DELIBERATELY, and only here

THE WORDING IS PINNED HERE, DELIBERATELY, and only here. The owner's ruling is "refuse a service-valued producer IN THE FIRST CUT, with a message saying so" — the explanation IS the requirement, because both this arm and the generic wrong-type arm return 400 and both mention the word "service". A test matching only /service/i cannot tell them apart: MEASURED — deleting the service arm entirely left the whole file green. These two phrases are the ones an operator acts on (this is temporary; declaring the component instead).

### §104. The policy scope guard is the precedent, and the reason

`governance/policy-scope-authz.ts` is the precedent and the reason: the declaration changes behaviour for every OTHER component in the org that depends on the coordinate, and `scopeExpandCte` expands strictly UPWARD — so a component-bound principal reaches its siblings not at all. Custody of the producing component was never evidence of jurisdiction over its consumers.

### §105. No projected declaration, and the empty string is why

NO PROJECTED DECLARATION, and the empty string is the reason it went. The dry run used to return a `DependencyLineProducer` with `declaredAt: previous?.declaredAt ?? ""` — and `""` is not a timestamp, not "never", and not a value any client can render or parse as a date. The whole object is `null` now, exactly as a dry-run RETRACT already answers, so "no declaration was created" is STATED rather than approximated with an unfillable field.

### §106. The third-party poll has already written a stranger's

The failure without this: the third-party poll has already written a stranger's `9.9.9` as this line's head. The operator declares the producer to stop the poll — and the poisoned head SURVIVES, because `recordDependencyLineHead` refuses backward movement, so internal detection can never bring the head down to the org's real `2.1.0`. The coordinate is left permanently wedged at a version that exists in no registry of the org's.

### §107. ONE OPERATOR ACT, ONE DECISION, ONE AUDIT EVENT

ONE OPERATOR ACT, ONE DECISION, ONE AUDIT EVENT — persist-on-change does not apply to these verbs, and the audit chain is what proves it must not.

THE DEFECT. Both verbs used `insertDecisionIfChanged`, which keys on `(subject_id, kind)`, and the subject here is the PRODUCER — so the comparison asked "is this the last thing this COMPONENT was said to produce?", a question about the wrong noun. Both verbs also append their hash-chained audit event UNCONDITIONALLY, and `insertDecisionIfChanged`'s own header states the rule that makes that combination incoherent: "a caller that pairs the Decision with a hash-chained audit event must suppress that event on the same condition (`created === false`)". The audit event is the one that is right — the operator really did call the verb — so the suppression is what goes, and the counts below are the pairing asserted rather than described.

WHY NOT "PUT THE COORDINATE IN THE IDENTITY". The only identity columns are `subject_id` (a `uuid`, and a coordinate is not one) and `kind` — documented in `decisions-repo.ts` as "the caller's own constant, never user input", with an exact-match operator filter and a b-tree over it. And it would not have been sufficient: an identity of `(producer, coordinate)` still finds P's own earlier row for this same coordinate and still compares equal, which is the P -> Q -> P transfer below.

MUTATION LOG — each applied, run, reverted: | Mutation | Result |
| `insertDecision` -> `insertDecisionIfChanged` in both verbs | FAILS at (b): three identical re-declares write 3 audit events and only 2 Decisions ("expected 2 to be 3") | | drop `displacedProducerObjectId` from the declare's `inputContext` | FAILS at (a): "the first declare displaced nobody: expected undefined to be null". It does NOT restore the suppression on its own while `insertDecision` stands — measured, and recorded because the two changes fix different halves: the field makes a transfer READABLE, the removal makes every act RECORDED | | BOTH together — the true pre-fix state | FAILS at (a) on the defect verbatim: the third declare's `decisionId` IS the first declare's row id, so a transfer between two teams is reported as the original declaration |

### §108. The pairing, which the transfer alone does not pin

(b) THE PAIRING, which is the half the transfer alone does not pin. Three IDENTICAL re-declares in a row: nothing about the world changes after the first, so this is precisely the sequence persist-on-change was suppressing — while the audit chain recorded all three. A Decision log that is missing an act the audit chain asserts happened is principle 6 failing on the quiet side.

### §109. TWO reasons, and the second is why this is not cosmetic

TWO reasons, and the second is why this is not cosmetic: - the WEDGE: the coordinate returns to third-party polling carrying `2.7.0` that the org's own releases put there, so the poll refuses every real public version until upstream passes it — and refuses it as `behind_head`, which reads as normal operation. - the GATE: `latest_version` is an input to the M22 vendor rule, which grants a scan PASS when a component is on the latest of its major line. A head left over from the internal era, on a coordinate that is third-party again, can grant a vendor-pass against a version NO REGISTRY EVER PUBLISHED.

### §110. THE FAILURE THIS PINS, in full

THE FAILURE THIS PINS, in full. X publishes `@acme/lib` and an operator declares it. X then cuts `3.0.0`; the first consumer moves to `^3`; ingestion mints a NEW `dependency_lines` row for major `3`. Under the retired per-line column that row's `produced_by_object_id` is NULL — honestly so, because nobody had re-declared — and `buildLineWorkList` therefore hands `@acme/lib` to a PUBLIC INDEX PLUGIN, where a stranger's package answering `9.9.9` bumps every subscriber onto it. Both barriers built against that read the column, and a column nobody filled in is NULL, so neither fires.

### §111. A source census, because behaviour cannot pin an absence

AND A SOURCE-LEVEL CENSUS, because behaviour alone cannot pin an absence in code that does not run in this test. The capability must be MISSING from the ingestion modules rather than guarded inside them: none of them may so much as name the table or the verb.

`readFile` with an explicit utf8 read rather than `grep -r`, which was measured in this repo to SILENTLY SKIP files carrying NUL bytes — a census with a hole is worse than none.

### §112. THIS IS THE TEST THE DEFECT MADE IMPOSSIBLE

THIS IS THE TEST THE DEFECT MADE IMPOSSIBLE. Every step below existed and worked; the chain could not START, because nothing in production could declare a producer. Asserting the row exists would prove nothing — the column was always writable.

`oci` deliberately: the released version comes from the wave target's `observed.images`, so the chain needs no git provider and the plugin host stays inert.

### §113. A component placed at prod and released there

A component placed at the prod target, released there by a change whose wave target reached `succeeded`, then put into `accepted` — the exact coordination state `internal-release-detection` reconstructs a release from.

The plan is compiled directly rather than waited for from the reconcile loop, the same shortcut `internal-release-detection.integration.test.ts` takes: compilation is what writes the `change_wave_targets` rows the derivation reads, and the loop's own job is covered elsewhere.

EVERY FIXTURE HALF IS READ BACK. A fixture that did not apply turns the absence assertion in (7)(f) into a tautology.

## `apps/server/src/routes/dependency-producers.ts`

### §114. Re-exported so the decision consumers keep working

Re-exported so `GET /decisions?kind=…` consumers and this route's own tests keep one import site. The constant, and the WHOLE ACT it labels, now live in `dependencies/producer-declaration.ts` because IaC apply is a second door into the same table — see that module's header.

### §115. THE PRODUCER DECLARATION'S AUTHORING SURFACE

THE PRODUCER DECLARATION'S AUTHORING SURFACE (ADR-0032 §7e, proposal §12) — API-first per charter principle 3 (API -> SDK -> CLI).

THE DEFECT THIS CLOSES
`dependency_lines.produced_by_object_id` decided whether a line was INTERNAL, and its only writer — `declareDependencyLineProducer` — had NO NON-TEST CALLER: no route, no CLI verb, no job, no IaC construct. So in production the column was never set, `isInternalDependencyLine` was always false, and THE INTERNAL HALF OF DEPENDENCY SUBSCRIPTIONS COULD NOT FIRE AT ALL — half of what was asked for ("internal dependencies refresh the database once released to production"). Third-party polling worked; internal release detection derived lines for the empty set of declared producers. That is the built-never-installed shape, one layer down from where M21.5 already met it.

SO THIS FILE'S OWN WIRING IS THE FIRST THING TO PIN, because shipping a second uncalled function would be absurd. `dependency-producers.integration.test.ts`'s "WIRING: the declare route is REGISTERED" fails if `registerDependencyProducerRoutes` is removed from `app.ts` — deleting the registration was measured to turn it red.

WHAT MUST NOT BE THE FIX
Wiring the producer link into INGESTION. `UpsertDependencyLineInputSchema` has no producer field and `upsertDependencyLine`'s ON CONFLICT set list cannot reach one; the capability is ABSENT from the ingestion verb rather than guarded on it, and since drizzle/0068 the declaration is not even in the same table. Wiring it in would delete "declared, never inferred" and call it a completion. The missing piece was an authoring surface for a deliberately MANUAL declaration, and that is all this file is.

A VERB, NOT A FIELD WRITE — ON TWO OF ADR-0031 §6'S THREE GROUNDS
1. WORK BEYOND THE FIELD WRITE — TRANSFERS, more strongly than for `publish`. A declaration removes EVERY major of the coordinate from the poll's work-list and MOVES THE HEAD-DERIVATION INGRESS for those lines from a public index to the org's own production releases. It also clears observation state. None of that is visible in a field edit. 2. ONE-WAY — DOES NOT TRANSFER, and the verb does not borrow the rhetoric. Retraction is part of the concept, and it is a peer verb below. 3. A LEGIBLE REPORT — TRANSFERS, and is where the verb earns its keep. The response enumerates the lines the declaration covers, each line's head, and the subscribed components per line. THAT LIST IS THE BLAST RADIUS AND IT IS UNGUESSABLE FROM THE REQUEST: the declarer names one coordinate and affects a set of repositories they cannot see. `dryRun` returns the same report and writes nothing, which is the only way to look before you leap.

AUTHORITY, AND THE ACT ITSELF, ARE NOT DEFINED HERE ANY MORE
`policy:write` at the ORG ROOT (owner decision, 2026-08-17), and the four things a write does — the row, the head-clearing, the Decision and the audit event — live in `dependencies/producer-declaration.ts`. This route is now ONE OF TWO DOORS: `iac/plans-repo.ts`'s apply is the other (charter principle 3's IaC rung). Both read `dependencyProducerScopeCheck` for the authority and both call the same two effect functions, so neither the bar nor the effects can drift. That module's header carries the full argument for both; do not restate it here, because two copies of a security rule is how the copies come to disagree.

THE FK CONSTRAINT THE MIGRATIONS COULD NOT EXPRESS
`producer_object_id` is `REFERENCES objects(id)` and ORG-UNBOUND (drizzle/0061's header states why: `objects` carries no `(org_id, id)` unique constraint to hang a composite key on, and RI triggers are not subject to RLS). So the raw table would accept a deployment-target, a user, or ANOTHER TENANT'S OBJECT. 0061's header names the mitigation an eventual route owes — "resolve every caller-supplied object id under the CALLER'S OWN org before it reaches this table" — and `assertDeclarableProducer` is it. Do not read RLS as having done that.

A `service` IS REFUSED, with a message that says so (ADR-0032 §7e, owner decision). Not pedantry: `listProducedLines` derives a head only from the COMPONENT a prod placement names, so today a service-valued declaration derives no head at all while still removing the coordinate from third-party polling — the harmful half, silently, and not the useful half.

COMMANDER-ONLY ON THE FEDERATION AXIS ONLY
The WRITES answer 409 off `commanderOnlyFederationVerdict` for the reason `dependency-subscriptions.ts` already gives at length — "right request, wrong place", and a route must not carry the PROCESS axis (every HTTP request lands on an `SCP_ROLE=api` process in the split topology by design). The READ stays tenant-facing: a team must be able to see why their coordinate is not being polled.

### §116. Resolve the producer to a live, in-org component

Resolve the caller-supplied producer to a LIVE, NON-DELETED, IN-ORG `component`.

Three refusals, each with its own remedy, because collapsing them would send an operator hunting for the wrong thing: - not resolvable in this org -> 404 from `getObjectByIdOrUrnAnyType` (which excludes deleted rows and scopes by `orgId`, so the cross-tenant and tombstone cases land here); - a `service` -> 400 naming the first-cut refusal and what it would silently do; - any other type (a deployment-target, a user) -> 400 naming what was found.

### §117. POST /dependencies/producers — DECLARE

POST /dependencies/producers — DECLARE.

The coordinate travels in the BODY, never a path segment: coordinates contain `/`, `@` and `:` (`github.com/acme/lib`, `@acme/lib`, `docker.io/library/alpine`), and path-segmenting one is a trap `GET /components/:idOrUrn/dependency-subscription` already avoided by using a query.

### §118. NO PROJECTED DECLARATION

NO PROJECTED DECLARATION — `null`, the same answer a dry-run RETRACT already gives, and the reason is `declaredAt` (corrected 2026-08-17). The projection used to fill it with `previous?.declaredAt ?? ""`, and an EMPTY STRING SAYS NOTHING: it is not a timestamp, it is not "never", and a client that renders `declaration.declaredAt` prints blank or throws on a date parse. The two available fixes were to make `declaredAt` nullable or to drop the projection; dropping it is chosen because making a REQUIRED response property nullable is an oasdiff-visible weakening of `DependencyLineProducerSchema` — which is also the READ model of `GET /dependencies/producers`, where `declaredAt` genuinely is always present. One dry run must not loosen a type for every reader of the real thing.

Nothing an operator needs is lost. `ecosystem` and `coordinate` are on the envelope, `dryRun: true` says why this is null, a `producerIdOrUrn` that did not resolve to a live in-org component never reaches here (`assertDeclarableProducer` throws 404/400), so a 200 IS the resolution result — and `lines` is the blast radius the dry run exists for.

### §119. POST /dependencies/producers/retract — the peer verb

POST /dependencies/producers/retract — the peer verb.

A SEPARATE PATH RATHER THAN A `producerIdOrUrn: null`. The two acts have different bodies (a retraction names no producer), different reports (only a retraction can have bumps in flight) and different Decisions, and a nullable field that switches a verb between two meanings is how an omitted key becomes a destructive default.

### §120. GET /dependencies/producers — the read

GET /dependencies/producers — the read. TENANT-FACING and NOT commander-only.

"Why is my coordinate not being polled?" is a question a team on any deployment may legitimately ask, and refusing it there would leave them with a verdict whose reason is unavailable — charter principle 6 failing rather than being satisfied. The answer is QUALIFIED by `dependencyManagement` for the same reason the resolution read is: on a field outpost this table is empty by design (ADR-0032 §7d), and an unqualified empty list reads as "nothing is declared" when the truth is "declarations live at the commander".

## `apps/server/src/routes/dependency-subscriptions.integration.test.ts`

### §121. M21.3 — THE ENABLEMENT CHAIN'S API SURFACE

M21.3 — THE ENABLEMENT CHAIN'S API SURFACE (ADR-0032 §3a/§6, routes/dependency-subscriptions.ts).

The merge itself is proven pure in `dependencies/subscription-resolution.test.ts` and against real Postgres in `dependencies/subscription-resolution.integration.test.ts`. THIS file proves only the things that live in the route layer and nowhere else:

```text
1. THE OPERATOR WRITE IS OPERATOR-ONLY. A perfectly valid TENANT token — the org's bootstrap
   ADMIN, the most privileged principal an org has — is REFUSED, and the NEGATIVE CONTROL is
   that the identical request carrying the deployment operator token SUCCEEDS. Without that
   control a 403 proves only that the route is broken.
2. THE READS ARE TENANT-FACING, and the unlock read is the SAME projection the write returns —
   including `updatedAt: null` for the never-set (locked) default, which is the state a
   deployment ships in.
3. THE RESOLUTION SURFACE CARRIES ITS CONTRIBUTIONS, and they identify WHICH TIER turned an
   enablement off (charter principle 6). That is the entire reason `contributions` exists, so it
   is asserted through the API rather than only at the resolver.
4. READING A COMPONENT'S ENABLEMENT IS READING THE COMPONENT — `object:read` at the component's
   scope, with a narrowly-bound user as the negative control.
```

A subscription is authored here the ONLY way it can be — as a `dependencySubscription` effect on an ordinary `policy` object through the EXISTING policy routes (ADR-0032 §3a). If a bespoke subscription write path is ever added, these tests keep passing and the reviewer should ask why it was needed.

INSTANCE-GLOBAL FIXTURE. `dependency_subscription_unlock` has no `org_id` and the integration suite runs `singleFork` against ONE shared Postgres, so the row is deleted at teardown no matter how this file exits.

### §122. A plugin host, because the backfill route fails closed

`withPluginHost` because the M21.2 backfill route fail-closes on `deps.pluginHost` — reading a dependency manifest is a live plugin call, exactly as `POST /discovery/run` is. No reconcile loop: nothing here needs one, and it would be a live competitor for queued work.

`federationRole: "commander"` because the backfill is COMMANDER-ONLY and fail-closed on an UNDECLARED deployment (ADR-0032 §7d). The harness leaves `SCP_FEDERATION_ROLE` unset by default, which yields a DEFAULTED commander — `federationRoleDeclared: false` — under which every backfill below would answer 409. Setting it here DECLARES the posture these tests mean to exercise; the refusals get their own servers in the block after "(5)".

### §123. Matches the HEADER NAME, not the prose

Matches the HEADER NAME, not the prose. The refusal used to say "operator token"; since role-model.md §5 step 9 replaced the shared env token with named revocable credentials it says "operator credential", and an assertion on the noun would have to be rewritten every time the wording improves. `x-scp-operator-token` is the actionable part and is stable — it stays the header name precisely so existing operators and scripts keep working.

### §124. (5) M21.2 — THE INVENTORY BACKFILL ROUTE

(5) M21.2 — THE INVENTORY BACKFILL ROUTE (ADR-0032 §4)

Ingestion is event-driven, so this route is how an EXISTING estate — and any component that has not released since being enabled — acquires an inventory at all. The behaviour of the ingestion itself is proven against a recording provider in `dependencies/inventory-ingestion.integration.test.ts`; what is proven HERE is that the route reaches it, authorizes it as a write, and does not weaken the enablement gate on the way.

### §125. WHY THIS TEST EXISTS

WHY THIS TEST EXISTS: `source` answers "is this component's inventory maintained by its own releases, or is it only as fresh as the last time an operator ran a backfill?" — two very different readings of one timestamp. Nothing pinned the route's half of it: every test that asserted `backfill` passed the literal into `ingestComponentManifests` itself, so swapping THIS route's label to `"loop"` left all 17 tests in this file and the whole ingestion suite green (measured). A provenance label is only worth having if a mislabel is loud.

### §126. The backfill is commander-only, and the route is not it

(6) THE BACKFILL IS COMMANDER-ONLY, AND THE ROUTE IS NOT THE DOOR AROUND THE JOBS' GUARD
ADR-0032 §7d (owner decision, 2026-08-17): all dependency automation runs on the commander only. The event-driven ingestion loop is guarded, and this route performs THE SAME INGESTION on demand — so an unguarded route would let an outpost rebuild the identical inventory by POSTing, and the loop's guard would be decorative.

A SEPARATE SERVER PER POSTURE, deliberately. `federationRole`/`federationRoleDeclared` are install-time config read from the environment at boot, so they cannot be toggled on the shared fixture without lying about how the value is produced. Each block below boots the deployment shape it is about, which is also what makes the UNDECLARED case reachable at all: it is the harness's own default, and it is the branch that would otherwise never be executed by anything.

WHAT IS ASSERTED IS THE SPECIFIC VIOLATION, not a status code alone: a 409 that came from some other conflict would satisfy `status === 409`, so each case also requires the refusal to name the axis that refused and where the work belongs.

### §127. No role set, exactly what the loader sees when unset

NO `federationRole` — exactly what `loadConfig` sees with `SCP_FEDERATION_ROLE` unset, which is what a pre-M16.3 install and a chart that omits the value both produce. `config. federationRole` therefore READS 'commander' here; only `federationRoleDeclared` separates this from the accepted case, which is why a guard testing the value alone is fail-OPEN for exactly the population most likely to be an outpost.

### §128. THE ROUTE TAKES THE FEDERATION AXIS AND *NOT* THE PROCESS AXIS

THE ROUTE TAKES THE FEDERATION AXIS AND *NOT* THE PROCESS AXIS — AND THAT IS NOW PINNED
The handler calls `commanderOnlyFederationVerdict`, not `commanderOnlyJobVerdict`, deliberately: in the split topology the chart deploys — `SCP_ROLE=api` serving HTTP in front of `SCP_ROLE=worker` draining queues — EVERY HTTP request lands on an api process, so a route carrying the process axis would 409 every caller on a perfectly correct commander.

That reasoning was right and NOTHING PINNED IT. Swapping in the job verdict left `tsc` clean, every unit test green and all 22 backfill integration tests green, because every other server in this file boots at the harness default `SCP_ROLE=all` — which satisfies the process axis and so cannot tell the two verdicts apart. The one deployment shape that distinguishes them is an api process, and until this block nothing in the repo booted one.

### §129. Every resolve answer says whether anything here will act

(7) EVERY RESOLVE ANSWER SAYS WHETHER ANYTHING HERE WILL ACT ON IT (ADR-0032 §7d, M21.7)
Block (6) proves the WRITE door is shut on a non-commander. This block is about the door that stays OPEN and must therefore explain itself.

The resolve route does not refuse on an outpost, and should not: a team there may legitimately ask what their subscription resolves to, and the answer is arithmetically correct — the policies it merges federated down from the commander. What was missing is that NO DEPENDENCY JOB RUNS ON THAT DEPLOYMENT, so `enabled: true` there means "the commander would author a bump", never "a bump will be authored here". An unqualified verdict is an answer whose REASON is unavailable, which is charter principle 6 failing rather than being satisfied.

THE FLAGSHIP ASSERTION IS THE COMBINATION, not either field alone: a resolution that says `enabled: true` sitting beside `managedHere: false`. That pair is the live hole this closes, and asserting `managedHere: false` on a component that resolved to `enabled: false` anyway would not exercise it.

`role_undeclared` GETS ITS OWN POSTURE because it is the branch that reads as `commander` on the config VALUE alone — `loadConfig` defaults `federationRole` to 'commander' when SCP_FEDERATION_ROLE is unset. A deployment there is the exact opposite of what the default says, and it is the population most likely to be an air-gapped outpost.

A SEPARATE SERVER PER POSTURE, for the same reason block (6) does it: these are install-time config read from the environment at boot, so toggling them on a shared fixture would lie about how the value is produced.

## `apps/server/src/routes/dependency-subscriptions.ts`

### §130. M21.3 — the DEPENDENCY-SUBSCRIPTION ENABLEMENT API

M21.3 — the DEPENDENCY-SUBSCRIPTION ENABLEMENT API (ADR-0032 §3a, §6), API-first per charter principle 3 (API -> SDK -> CLI). The DELIBERATE TWIN of `routes/instance-scan-floors.ts` and `routes/scan-db.ts`: same two-audiences / two-credentials shape, same reasons.

- **The instance unlock's READ is tenant-facing.** A component team whose subscription is inert because the DEPLOYMENT never opened the feature has been handed an unexplainable verdict (charter principle 6), so the singleton is readable by any authenticated principal. It runs inside the ordinary tenant transaction under the table's tenant-read RLS policy — the same path resolution itself takes, so no derivation ever needs the privileged connection (ADR-0016 §3's stated reason for preferring this shape). It leaks nothing across tenants because the row holds NO per-tenant data at all.

```text
 **IT DELIBERATELY DOES NOT CARRY `dependencyManagement`, AND THAT IS A DECISION** (M21.7
 follow-up census, ADR-0032 §7d). It is the sibling tenant-facing read of the route below, which
 does carry the envelope, so the asymmetry has to be argued rather than left to look like an
 oversight. Two reasons, and they are about SHAPE, not about cost:
```

```text
   1. THE ENVELOPE QUALIFIES A DERIVED VERDICT; THIS IS NOT ONE. `dependencyManagement` exists
      because the resolve route computes a real, arithmetically correct verdict out of policies
      that FEDERATED DOWN, and reports it on a deployment where nothing will act on it — an
      answer authored elsewhere and inert here. The unlock is the opposite shape:
      `dependency_subscription_unlock` is a LOCAL singleton table (drizzle/0062) that does not
      federate at all, so this route hands back exactly what an operator set on THIS deployment.
      There is no "true elsewhere, inert here" gap for an envelope to close.
   2. THE ONLY CONSUMER THAT TURNS IT INTO A CLAIM ABOUT A SUBSCRIPTION ALREADY CARRIES IT. The
      unlock UNLOCKS and never activates; it becomes an answer about a component only through
      `resolveDependencySubscription`, whose sole API surface is the route below. Qualifying the
      same posture twice on one request path is how two copies of one fact drift.
```

```text
 **THE RESIDUAL, STATED RATHER THAN PAPERED OVER.** Because the unlock does not federate, a
 non-commander deployment's row is INDEPENDENT of the commander's — so a resolve verdict of
 `enabled: false, reason: instance_locked` on a field outpost is a statement about that
 deployment's row, not about what the commander would decide. The envelope already tells the
 reader not to act on the verdict (`managedHere: false`); putting the same envelope on THIS read
 would not close that gap either, because the missing fact is the COMMANDER'S unlock, which this
 deployment does not have and must not invent. Asking the commander is the answer, and that is
 what `managedHere: false` sends a caller to do.
```

- **The instance unlock's WRITE is operator-only, and deliberately NOT an RBAC permission.** The row binds EVERY org on the deployment, so no tenant role — however privileged inside its own org — may grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN` (`x-scp-operator-token`) and executes over the ADMIN connection, because `scp_app` holds no write grant and no write RLS policy exists for the table (drizzle/0062 — two independent barriers). Unset token ⇒ the surface is CLOSED (403), never a fallback to a tenant credential.

- **The resolution READ is tenant-facing and authorized like any other read of the component** (`object:read` at the component's scope, exactly as `GET /components/:idOrUrn/pipeline` does). It is deliberately NOT commander-only — a team on an outpost may legitimately ask what their subscription resolves to — but the answer is QUALIFIED by a required `dependencyManagement` envelope, because on that deployment nothing will ever act on it (ADR-0032 §7d). The backfill below, which WRITES, is refused there instead.

- **The INVENTORY backfill (M21.2)** is an org-scoped WRITE (`object:write` at the org): it reads enabled components' dependency manifests through the plugin host and (re)builds their rows.

- **The two READ-SURFACE routes (M21.6, docs/proposals/dependency-subscription-ui.md §3.1/§3.2)** — `GET /components/:idOrUrn/dependency-inventory` (one row per declared line × dependency manifest, each with the line's head, its declared producer and its resolved dependency subscription; the component-level ingestion gate; the newest ingestion Decision) and `GET /components/:idOrUrn/dependency-bumps` (every bump SCP authored for the component, joined to its change name and its dispatch/merge Decisions). Both `object:read` AT THE COMPONENT, both paged, both resolved AS THE CALLER, both assembled in `dependencies/dependency-read-surface.ts` from the SAME merge every other consumer uses. Neither writes anything. BOTH CARRY THE REQUIRED `dependencyManagement` ENVELOPE (M21.7, ADR-0032 §7d) from the SAME predicate as the resolve route: on a deployment where `managedHere` is false the rest of the envelope is not to be interpreted — an empty inventory there is "nothing here ever ingested a manifest", an empty bump list "nothing is ever dispatched here". They still answer 200 with unchanged RBAC (they are reads; the WRITE below is what refuses).

THE SURFACE, ENUMERATED (six operations, all tagged `dependencies`): GET  /instance/dependency-subscription-unlock          getDependencySubscriptionUnlock PUT  /instance/dependency-subscription-unlock          putDependencySubscriptionUnlock (operator) GET  /components/:idOrUrn/dependency-subscription      getComponentDependencySubscription GET  /components/:idOrUrn/dependency-inventory         listComponentDependencyInventory GET  /components/:idOrUrn/dependency-bumps             listComponentDependencyBumps POST /dependencies/inventory/backfill                  backfillDependencyInventory

THERE IS NO WRITE PATH FOR A SUBSCRIPTION ITSELF HERE, AND ONE MUST NOT BE ADDED. A dependency subscription IS a `dependencySubscription` effect on an ordinary `policy` object (ADR-0032 §3a) — a team subscribes by authoring a policy at their own component through the EXISTING policy routes (`POST /api/v1/policies`, `scp policy register`) and opts one line back out with a second effect at the same or a deeper scope:

```text
  effects: [{ dependencySubscription: { enabled: true } }]
  effects: [{ dependencySubscription: { coordinate: "@acme/lib", enabled: false } }]
```

A bespoke create/update/delete here would be a SECOND authoring path for one concept, needing its own versioning, its own journal handling and its own scope semantics — and the two would drift. The absence is the design, not an omission.

THE WHOLE REQUEST, BECAUSE THE EFFECT ALONE IS NOT ENOUGH TO SUCCEED (ADR-0032 §8g). Naming the effect and the route, as the paragraph above did on its own until M21.7, omits the one field that decides whether a COMPONENT TEAM's request is accepted at all — `domainId`. For the team owning component `11111111-…`:

```text
  POST /api/v1/policies
  {
    "name": "deps-checkout-api",
    "domainId": "11111111-1111-1111-1111-111111111111",
    "properties": {
      "enforcement": "advisory",
      "scope": { "objectRef": "11111111-1111-1111-1111-111111111111" },
      "effects": [{ "dependencySubscription": { "enabled": true } }]
    }
  }
```

The component id appears TWICE and the two occurrences are different questions — `governance/policy-scope-authz.ts`'s header is the authority: `domainId` is CUSTODY (where the row is placed, hence who may later PATCH/DELETE it, since both re-check at the row's own id), while `scope.objectRef` is JURISDICTION (what the policy reaches). Placement bounds reach not at all.

WHY THE COMPONENT'S OWN ID. Authority expands strictly upward from the scope object (`authz/resolve.ts`'s `scopeExpandCte`), so the component's id is the one value accepted for ALL THREE actor shapes — an author whose `policy:write` sits at the component, at its containment domain, or at the org root. Sending the component's containment DOMAIN instead works only for the latter two, and so excludes exactly the component-bound team this flow exists for.

WHAT OMITTING IT DOES. `domainId` is optional and `resolveContainmentParent` (`graph/objects-repo.ts`) resolves `undefined` to THE ORG ROOT, so the custody `authorize` runs there and a narrowly-bound author gets `403 subject '<uuid>' lacks 'policy:write' at scope '<org-root-uuid>'` — a bare uuid for a scope they never asked for, with nothing pointing at the field they omitted. The refusal is correct; it just does not explain itself, which is why this is written here, in ADR-0032 §8g, in the proposal, and on `CreateObjectRequestSchema.domainId` rather than in one of them.

Pinned by `governance.integration.test.ts`'s CRITICAL #1b case (d) — a component-scoped author sending exactly this shape gets a 201 — and its cases (a)–(c), which refuse the broader scopes.

NOTHING HERE COMPUTES THE AND. Every read handler reads; the merge lives in exactly one place (`dependencies/subscription-resolution.ts`'s `mergeDependencySubscription`), so a UI verdict, a CLI answer, the inventory page's per-row `subscription` and the M21.4 ingestion work-list cannot disagree.

### §131. The unlock as the API projects it

The unlock as the API projects it.

`unlocked`/`note` come from `readInstanceSubscriptionUnlock` rather than from a SELECT written here, so NO ROW MEANS LOCKED is decided in exactly ONE place (drizzle/0062's header, pinned by `subscription-resolution.test.ts`). Re-deriving that default in a route is how the API and the resolver would come to disagree about a deployment that has never been configured — the loudest possible bug in the safest-sounding line of code.

`updated_at` is the one field the resolver has no use for and so does not return; it is read alongside, in the SAME transaction, purely so an operator can tell "never set" (`null`) from "deliberately re-locked" (a timestamp).

### §132. An operator connection, for the sibling door's reason

`withOperatorDb` for the reason stated at the sibling door in `routes/governance-move.ts`: the inline `createPool(config.databaseUrl)` dialled an admin connection api/worker pods are never given, and `scp_app` holds SELECT only on this FORCE-RLS table. drizzle/0102 adds the grant + `operator_write` policy. These were the last two instance-scoped tables in the schema without a write principal.

### §133. GET the effective resolution for one (component, line) pair

GET the effective resolution for one (component, line) pair — THE EXPLAINABILITY SURFACE.

An extra `/dependency-subscription` segment, so it never collides with the component registry's `/:idOrUrn` detail route — the same shape as `/components/:idOrUrn/pipeline`.

The line arrives as a QUERY, and the query schema IS `DependencyLineKeySchema` — the natural key of a `dependency_lines` row, reused rather than restated, so the bytes an operator asks about are structurally the bytes a line is identified by. A coordinate travels VERBATIM here (`@acme/lib` stays `@acme/lib`): the selector comparison is byte equality, and a normalising surface would answer about a package nobody named.

### §134. The verdict is qualified by whether anything here acts

THE VERDICT IS QUALIFIED BY WHETHER ANYTHING HERE WILL ACT ON IT (ADR-0032 §7d, M21.7).

This route does NOT refuse on an outpost — the resolution is real and correctly computed from policies that federated down. What is missing is that no dependency job runs on this deployment, so `enabled: true` here means "the commander would author a bump", never "a bump will be authored here". An unqualified `enabled` is an answer whose reason is unavailable, which is charter principle 6 failing rather than being satisfied. Same predicate as the guards, so the envelope and the refusals can never disagree about the posture.

### §135. GET /components/:idOrUrn/dependency-inventory — M21.6 read surface

GET /components/:idOrUrn/dependency-inventory — M21.6 read surface (proposal §3.1, §8 Q1).

WHAT A COMPONENT DECLARES, hydrated: one row per (line, dependency manifest) with the line's observed head, its DECLARED producer and its resolved dependency subscription — plus the component-level ingestion gate and the newest ingestion Decision, so a consumer can tell "no rows because nothing is declared" from "no rows because nothing was ever read" without guessing.

AUTHORIZED AT THE COMPONENT, like the resolution GET and unlike `GET /changes` / `GET /decisions` (org-scoped): a component-scoped viewer must be able to read their own component's page, and this is the route that makes the inventory reachable to them at all.

RESOLVED AS THE CALLER. `actorObjectId` is `auth.subjectObjectId`, exactly as the resolution GET threads it, so `rows[].subscription` for a line is BYTE-EQUAL to what the resolution GET returns that same caller for that same line (pinned). The jobs resolve as the SYSTEM actor; a `scope.group` policy is where the two can differ, and that hazard belongs to the matcher.

`manifestPath` IS A ROW KEY: one line from two manifests is two rows, as it is in the table's primary key. `ingestion` is the M21.7 per-attempt STAMP (`dependency_ingestion_stamps`, read by `findIngestionStampByComponent` in the SAME transaction as the rows): `null` = NEVER ATTEMPTED, `ok` + 0 rows = "read fine, declares nothing" — the trichotomy an empty `rows` alone cannot express, projected as the schema documents.

QUALIFIED BY `dependencyManagement` (ADR-0032 §7d), from the ONE predicate `commander-only.ts` exports — the same call the resolve route makes. This route does NOT refuse on an outpost (a read); it says that nothing here ingests, so an empty page is not "declares nothing".

### §136. GET /components/:idOrUrn/dependency-bumps — M21.6 read surface

GET /components/:idOrUrn/dependency-bumps — M21.6 read surface (proposal §3.2, §8 Q4).

THE BUMPS SCP AUTHORED for this component, newest first: `dependency_bump_authorships` (every field server-written) joined to the change's name and to the newest dispatch and merge Decisions. Progress is `pullRequestNumber` / `headCommit` / `mergedAt` / `merge` — never the change's `state`, which stays `proposed` for a bump's whole life. `pullRequestUrl` is the provider-returned URL `dependency_bump_authorships.pull_request_url` holds (M21.7, 0066) when one was recorded, else `null`; it is never composed from `repo` + number (the provider is not known here; a Gitea-authored bump composed as a GitHub link would 404).

Authorized at the component, like the inventory. On an outpost, or on a commander whose federation role was never declared, no bumps are ever dispatched (fail-closed role guards), so this list is legitimately empty there — the required `dependencyManagement` envelope says so (`managedHere: false`), and a consumer must not render that as "up to date".

### §137. POST /dependencies/inventory/backfill — M21.2

POST /dependencies/inventory/backfill — M21.2 (ADR-0032 §4).

WHY A ROUTE EXISTS AT ALL. Ingestion is event-driven: a correlated, accepted change re-reads its component's dependency manifests. That is the right trigger and it covers only components that release from now on — so on an existing estate the inventory stays EMPTY until each team happens to commit, and every capability above it (the enablement work-list, the version poll, internal detection's manifest-path lookup) resolves over nothing in the meantime. The precedent is `POST /discovery/backfill-source-mappings` — operator-triggered, idempotent, reporting every skip. That route has since been retired (its population closed); the shape it set is what is being followed here, where the population is still open.

THE GATE IS NOT WEAKER HERE. `ingestComponentManifests` resolves enablement itself, before it touches a repo, so a backfill over the whole org reads nothing for an unsubscribed component — this route cannot pass a flag to skip that, because there is none.

THE ACTOR IS THE REQUESTING PRINCIPAL, not the system sentinel, and that is a real difference: `matchPoliciesForTargets` resolves `scope.group` against the actor and the sentinel is a member of nothing (ADR-0032 §6a), so a human running a backfill sees the same enablement the resolution API reports to them.

IT IS COMMANDER-ONLY, AND FAIL-CLOSED ON AN UNDECLARED DEPLOYMENT (ADR-0032 §7d, M21.7). This route is the OPERATOR-TRIGGERED half of the same ingestion the loop performs, so it must not be the door the loop's guard is walked around: an outpost that can no longer ingest on an accepted change could otherwise ingest the identical inventory by POSTing here, and the guard would be decorative. The predicate is `commander-only.ts`'s, shared with the four background jobs, so the two doors cannot drift.

ONLY THE FEDERATION AXIS, DELIBERATELY. The jobs additionally require an `all`/`worker` `SCP_ROLE`; a ROUTE must not, because in the split topology every HTTP request lands on an `SCP_ROLE=api` process by design — carrying the process axis here would refuse every caller on a perfectly correct commander. See `commanderOnlyFederationVerdict`'s own doc.

THAT OMISSION IS PINNED, which it was not when it was written (M21.7 follow-up, MEDIUM 1): swapping in `commanderOnlyJobVerdict` left tsc clean, every unit test green and all 22 backfill integration tests green, because every test server in the repo booted at the harness default `SCP_ROLE=all` — and an `all` process satisfies the process axis, so no fixture could tell the two verdicts apart. `dependency-subscriptions.integration.test.ts`'s "an api-only process on a declared commander" block now boots the api half of the split topology and requires a 200, with an OUTPOST on the same process axis as its negative control.

WHY 409 AND NOT 400/403/404. This is "right request, wrong place": the body is valid, the caller may be entirely entitled, and the resource is not hidden — what is wrong is the DEPLOYMENT the request arrived at. 403 would say the principal lacks permission, which is a different remedy (grant a role) from the real one (call the commander), and this route already spends 403 on the authorization failure it really has. 400 would blame the request, which is well-formed — the sibling `badRequest` below is about THIS PROCESS lacking a plugin host, a narrower "wrong process" the operator fixes by routing to a worker-capable one, and conflating the two would send an outpost operator hunting for a plugin host. 404 would deny the route exists, which is false and unhelpful. 409 Conflict is what this codebase already uses for a request that conflicts with THE STATE OF THIS INSTANCE rather than with the caller's rights — `POST /federation/poke`'s "this instance is not configured for poke-mode from peer X" (routes/federation.ts) is the same shape and the precedent followed here. The detail names why and says WHERE to run it, because a refusal an operator cannot act on is the same as silence. Adding a documented 409 to an existing operation is additive under the /v1 oasdiff gate (a non-success status ADDED is not an ERR-level break; nothing existing is removed and no required response field becomes optional).

### §138. The fetch budget is spent only by components that fetched

THE FETCH BUDGET IS SPENT ONLY BY COMPONENTS THAT ACTUALLY FETCHED. An unsubscribed component costs no provider call at all (the gate refuses before a repo is touched), so a whole-org run still reports every component's enablement while bounding the live I/O this one request performs. Without a bound, `componentIdsOrUrns: undefined` walked every component in the org inline, at up to `MAX_MANIFEST_READS` git-provider round trips each.

### §139. THE DESTRUCTIVE HALF, CARRIED THROUGH THE PROJECTION

THE DESTRUCTIVE HALF, CARRIED THROUGH THE PROJECTION. `ingestComponentManifests` returns `pruned`/`removed` per manifest and this route used to drop both, so a run that deleted a component's whole inventory reported `verdict: "ingested"` and was indistinguishable from a clean one. A receipt that only counts what was added cannot tell an operator they backfilled at the wrong ref.

## `apps/server/src/routes/device-flow.integration.test.ts`

### §140. SCP's own RFC 8628-shaped device-authorization flow for the CLI

SCP's own RFC 8628-shaped device-authorization flow for the CLI (M2 step 2 Part C) — start → approve (by an authenticated browser session) → poll (single-use) end to end, entirely via `app.inject` (no real network round trip through an external IdP needed — this flow is SCP-hosted, not a proxy to one).

## `apps/server/src/routes/device-flow.ts`

### §141. SCP's own RFC 8628-shaped device-authorization flow for the CLI

SCP's own RFC 8628-shaped device-authorization flow for the CLI (M2 step 2 Part C) — see auth/device-flow.ts's module doc for why this is SCP's own flow rather than a proxy to the upstream IdP's device grant. `verificationUri` points at this server's own web UI/API (the browser-side approval page itself lands with the Web UI in a later M2 step — this API is fully exercisable headlessly in the meantime, per BUILD_AND_TEST.md §8 M2 item 3).

## `apps/server/src/routes/discovery-effective-config.integration.test.ts`

### §142. The route validates the config it will actually use

`POST /discovery/run` VALIDATES THE CONFIG IT WILL ACTUALLY USE, NOT THE REQUEST BODY.

THE CONTRADICTION THIS RESOLVES
The handler supports naming an execution-system instead of supplying connection details, and says so in as many words: "a caller may NAME a system, never supply its serverUrl/token/egress allowance". The merge below it stamps the persisted `serverUrl` as server-governed — it WINS over anything the caller sent, which is the SSRF defence (MAJOR #6).

But `validatePluginConfig` ran on `request.body.config` BEFORE that merge, and `argocd-discovery`'s manifest requires `serverUrl`. So the documented call was rejected for missing exactly the field the server was about to supply, and the only way through was to send a dummy `serverUrl` that is then overwritten — a required field whose value is ignored.

Measured on the live homelab 2026-08-02, immediately after #200 made this route reachable at all on an api-only process: `{executionSystemId}` alone answered `400 properties failed JSON Schema validation: / must have required property 'serverUrl'`.

WHY BOTH TESTS EXIST
Moving a validation call is exactly the change that can silently DELETE the validation. So the pair pins both directions: the system-backed path must stop being rejected, AND the inline path must still be rejected for the same missing field. A fix that merely deleted the call would pass the first test and fail the second.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| move `validatePluginConfig` back onto `request.body.config` before the merge (the bug) | the system-backed test FAILS with the `serverUrl` schema error | | delete the `validatePluginConfig` call entirely | the inline test FAILS — an unvalidated config reaches the plugin |

The system-backed test asserts an ABSENCE, which passes for any wrong reason. The first version had the wrong URL, 404'd, and passed vacuously — its sibling caught it by failing on the status. It now pins that the request reached the handler before reading meaning into what it did not say.

### §143. Posts a discovery run and returns `{status, detail}`

Posts a discovery run and returns `{status, detail}` — never throws, so the DETAIL can be read.

`app.inject` rather than the SDK: the SDK throws on a non-2xx, and the whole measurement here is WHICH error came back. Injecting also removes the URL from the set of things that can be wrong — the first version of this file guessed the prefix, 404'd, and made one test pass vacuously.

## `apps/server/src/routes/doctor.ts`

### §144. Operational self-checks for the caller's own org

`GET /api/v1/doctor` — operational self-checks for the CALLER'S OWN org (`scp doctor`).

READ-ONLY, and there is deliberately no companion repair endpoint: see `packages/schemas/doctor.ts` and `graph/integrity-repo.ts` for the same argument. Tenant-scoped like every other report, so one org's operator can never inspect another's. The INSTANCE-wide form of the same checks runs once at boot (`main.ts` -> `federation/self-origin-check.ts::warnOnFederationSelfOriginDivergence`) — that one can span orgs because it answers to the operator of the instance, not to a bearer token.

Nothing here may be added to the reconcile hot path. These checks exist BECAUSE a per-tick probe was rejected: it costs a query on a one-second loop and floods the log for a legitimately idle org.

## `apps/server/src/routes/events-authz.integration.test.ts`

### §145. RBAC ON `GET /events/stream`

RBAC ON `GET /events/stream` — the boundary below tenancy (routes/events.ts).

`sseHub` keys its channels by `orgId`, which is the TENANCY boundary and nothing more. Before this suite existed the route stopped there: any authenticated principal in the org — including one with zero role bindings — was pushed every object's events, each carrying that object's id and a payload, while every REST read of the same objects demanded `object:read` at a resolved scope. These tests drive the SHIPPED path end to end (real HTTP, the generated SDK's `streamEvents`, the real relay → NOTIFY → bridge → `sseHub` → route fan-out) rather than calling the gate directly, because the defect was never in a helper — it was in what the route did not call.

## Every negative assertion here is fenced by a POSITIVE one on the SAME connection

"X never arrived" is the assertion shape that passes for free when nothing could have arrived at all (a stream that never connected, an event that was never relayed, a bridge whose LISTEN was still being established — NOTIFY has no replay). So each test publishes the frame it expects to be REFUSED first, waits until the relay has actually processed that outbox row, and only then publishes a frame that principal IS allowed to see; the refusal is asserted at the moment its successor has already been delivered over the same connection. The route serializes its per-frame permission checks into one promise chain per connection precisely so that order is meaningful.

### §146. Publishes one event and resolves once the relay has it

Publishes one outbox event and resolves with its outbox row id once the relay has PROCESSED it — which is also the SSE frame's `id`, so every assertion below names an exact frame rather than matching on a type or subject that another suite (or the bridge's own reconnect resync) could also have produced.

Waiting for `processed_at` is what makes "published before" mean "reached the hub before": the relay NOTIFYs inside the row's own transaction, but events/sse-bridge.ts fetches each pointer concurrently, so two rows relayed in the same batch can reach `sseHub` in either order. A row whose relay has already committed, followed by a fresh publish that needs its own NOTIFY and its own fetch, cannot.

### §147. A NONCE IN `source`, because

A NONCE IN `source`, because (type, subject) IS NOT UNIQUE and looking a row up by it is how this whole file goes vacuous. Measured while mutation-proving: with the lookup keyed on (type, subject) + `processed_at IS NOT NULL`, the SECOND publish of an already-published pair resolved instantly to the FIRST publish's row — a frame this connection had received several assertions ago. Every `waitForFrame` on it then returned immediately, on the old frame, and the payload-normalization assertion passed with the normalization deleted. `source` is a column this test owns outright, so one nonce makes each publish addressable.

### §148. The stand-in for `main.ts`'s `sseAuthzPool`

The stand-in for `main.ts`'s `sseAuthzPool` — an INSTRUMENTED pool, so "the route ran its permission checks somewhere other than `deps.db`" is an observation rather than a reading of the source. `pg.Pool` emits `acquire` on every checkout, so this counter is exactly "how many tenant transactions the SSE fan-out opened on the isolated pool".

`test-support/harness.ts` builds deps as `{ db, config }` — it does NOT set `sseAuthzDb`, which is precisely why routes/events.ts's fallback exists — so this assignment IS the wiring under test on the runtime side. It is made before any connection is opened, because the route resolves the pool once per connection.

### §149. THE ISOLATION, OBSERVED

THE ISOLATION, OBSERVED — not "a second pool exists" but "the fan-out's checks ran on it".

The previous round put an attacker-influenceable, unbounded-volume database load (one recursive permission walk per connection per distinct subject) onto `deps.db`, the request-serving pool — the exact hazard `main.ts` had already isolated one layer up for the SSE bridge (its `max: 2` pool, review finding SEC-1). `deps.db` has no `max` (pg's default 10) and `createPool` sets `connectionTimeoutMillis: 5000`, so contention there surfaces as timeouts on unrelated API requests.

The subject is a FRESH `randomUUID()` on purpose: the per-connection memo would otherwise answer from cache and no checkout would happen at all, which is how this assertion could pass while proving nothing. A random UUID is a guaranteed memo miss on all three connections, and it is UUID-shaped so it clears the route's pre-pool `UUID_RE` gate and genuinely reaches the database (where it matches no object, so the frame is correctly dropped — asserted below, which is what proves the check RAN rather than being skipped).

### §150. THE COMPOSITION ROOT

THE COMPOSITION ROOT — a SOURCE census, because `main.ts` cannot be imported (`main()` runs at module scope), exactly as background-work.test.ts documents for `startBackgroundLoops`.

The suite above proves the ROUTE prefers `deps.sseAuthzDb` when it is set. Nothing above can prove that anything sets it in a deployed process — the harness deliberately does not, and this repo's dominant failure mode is a component that is built, tested, and wired nowhere. These two assertions are the cheapest detector for the single most likely edit: the `main.ts` line going away in a merge or a revert, leaving every deployed process silently on the fallback.

WHAT THIS DOES NOT PROVE (the same list background-work.test.ts carries): that the assignment is reachable, that the pool it names is the isolated one at runtime, or that it happens before the first request. Only booting the real process could. `readStripped`, not `readFileSync`, so a mention inside the surrounding comment block cannot satisfy it.

## `apps/server/src/routes/events.ts`

### §151. `GET /events/stream` (DESIGN.md §6, §8)

`GET /events/stream` (DESIGN.md §6, §8) — Server-Sent Events fed from this process's in-process `sseHub`, scoped to the caller's org. Since M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1), `sseHub` is fed by events/sse-bridge.ts's LISTEN on `scp_sse_events`, not directly by the outbox relay (events/outbox-relay.ts) — the relay and this route can run in different pods under the default chart topology, so only a Postgres NOTIFY can cross that boundary.

DECLARED IN THE CONTRACT, like everything else. The frames are not a JSON request/response pair, so the 200 cannot be a Fastify response schema (nothing for Fastify to serialize — the handler writes to `reply.raw`); it is declared via `config.openapi.eventStream`, which the emitter turns into `content: { "text/event-stream": … }` (openapi/build-document.ts). That is what lets the generator produce a real `streamEvents` operation, so `apps/web` consumes the stream through the SDK instead of a hand-built URL and a raw `EventSource` — charter principle 3, and the closing of the one exemption `apps/web/e2e/openapi-conformance.ts` used to carry.

`Last-Event-ID` (sent by both `EventSource` and the SDK's SSE client on reconnect) is accepted and IGNORED: `sseHub` is an in-process fan-out of live rows with no per-connection replay buffer, so a reconnecting client resumes at "now" and re-syncs through the query cache it invalidates. That is exactly the behaviour before this change — it is stated here rather than left to be inferred from the absence of code.

## RBAC IS ENFORCED PER FRAME, AT FAN-OUT — the boundary below tenancy

`sseHub` keys its channels by `orgId`, so a subscription enforces the TENANCY boundary and nothing else (events/sse-hub.ts's own doc says exactly that, and says only that). Until this change this route stopped there: it called `requireAuth` and subscribed, making it the ONE read surface in the codebase with no permission demand — every `scp.object.*` / `scp.change.*` frame in the org, each carrying a `subject` object id and a `data` payload, was pushed to ANY authenticated principal in that org, INCLUDING one with zero role bindings. Every REST read demands `object:read` at a resolved scope (services/objects-service.ts, routes/components.ts, routes/changes.ts, …), so a Viewer bound at one service can read that subtree and nothing else; the stream handed that same Viewer the whole org.

So each frame is now admitted per connection by `object:read` at `event.subject`, using the same `authz/resolve.ts` walk every REST read uses — same subject/group expansion, same upward-only containment expansion, same deny-override. There is no second implementation of "may this principal read this object" to drift.

The subscription is still to the whole ORG (one `sseHub` listener keyed by `auth.orgId`), which is deliberate: `sseHub.activeOrgIds()` — the bridge's work-gate and its reconnect resync broadcast (events/sse-bridge.ts) — is defined as "org ids with a connected client", and a narrower subscription key would silently break both. Filtering happens on the way OUT, not by subscribing to less.

### Null `subject`: dropped, except the one contentless synthetic frame

`RelayedEvent.subject` is nullable, and an event with no subject names no object to check `object:read` against. Failing OPEN on null would be a hole a future publisher could walk through without noticing. So null fails CLOSED, with exactly one allowlisted exception: `scp.sse.resync` (events/sse-bridge.ts `makeResyncEvent`), which is not a domain event at all — it is the synthetic "your LISTEN connection was down, some window of events may be missing" signal, minted in-process on every bridge (re)connection, carrying `data: {}` and naming no object. It leaks nothing, and dropping it would break M26.1's catch-up path outright: the client's response to it is a wholesale query-cache invalidation (apps/web/src/lib/ use-event-stream.ts), and every refetch that triggers goes through the REST API, which enforces RBAC properly. A principal with zero bindings therefore gets the nudge and still sees nothing.

Because that exception is keyed on the event TYPE, and `type` is just a column any writer of an `outbox` row chooses, the passthrough frame is rebuilt with `data: {}` rather than forwarded as-is. A frame that skipped the permission check must carry no payload; the only legitimate resync frame already has an empty `data`, so this costs nothing and removes the ability to smuggle a body past the gate by naming that type.

CENSUS (2026-08-25, `grep -rna` over every `eventBus.publish` / `writeOutboxEvent` call): every production publisher sets a non-null subject — graph/objects-repo.ts (created/updated/deleted), graph/relationships-repo.ts (created/deleted), coordination/transition.ts, dependencies/dependency-inventory-repo.ts, coordination/webhook-processor.ts. The resync frame is the only null-subject event that exists, so this allowlist is exactly one synthetic frame wide and a NEW null-subject publisher must argue its own scope rather than inherit an opening.

### A subject that is not a readable object is dropped too — including relationship events

`scp.relationship.*` sets `subject` to the RELATIONSHIP id, not an object id. The containment walk starts at `objects`, so such a subject expands to nothing, matches no binding, and the frame is dropped for EVERY principal — an org-root Owner included. That is a real behaviour change and it is the correct direction: nothing in this repo consumes those frames (apps/web's `use-event-stream.ts` dispatches only on `scp.object.*`, `scp.change.transitioned` and `scp.sse.resync`; there is no other subscriber), and the alternative — treating "the subject isn't an object" as permission to deliver — is precisely the hole this route just closed. If relationship frames are wanted on the stream later, the fix is to give them a scope this walk can reach (e.g. publish the edge's `from` object as the subject), NOT to weaken this gate.

A subject that is not even UUID-shaped is rejected before it reaches the pool, the same gate and for the same reason as events/sse-bridge.ts's `UUID_RE` on the NOTIFY pointer: `scopeObjectId` is cast `::uuid` inside the permission CTE, so a malformed value would otherwise buy an attacker a full connect + BEGIN + SET ROLE + recursive-CTE parse per frame before failing on `22P02`.

### §152. How long one read verdict is reused on one connection

How long ONE `object:read` verdict is reused for on ONE connection.

WHY A MEMO AT ALL: without one, every frame costs one tenant transaction and one recursive-CTE permission query PER CONNECTED CLIENT — an org with N open streams turns a single object update into N walks, and a bulk import into N × rows. The memo makes a burst touching the same objects cost one query per (connection, subject) per window instead.

WHAT IT COSTS, EXPLICITLY: a binding revoked mid-connection keeps working on this stream for up to READ_MEMO_TTL_MS after the last verdict, or until the client reconnects (a new connection starts with an empty memo). Five seconds is the deliberate bound — long enough to collapse the burst that motivates the memo, short enough that "revocation takes effect within seconds" is still true, and short compared to the SSE reconnect/heartbeat cadence. It is a CACHE OF A VERDICT, never of a frame: an object the caller has never been able to read is never delivered, whatever the memo holds. Do not raise this without saying what the new revocation lag is.

### §153. The pool size this route's permission checks run on

`max` for the pool this route's permission checks run on — `main.ts`'s `sseAuthzPool`, which imports this constant so the number and its justification cannot drift apart.

WHY A SEPARATE POOL AT ALL. These checks are NOT request-shaped work. Their volume is set by event volume × connected clients, both influenceable from outside any request, and each one is a tenant transaction (`SET LOCAL ROLE` + `set_config` + a recursive-CTE containment walk). The chain below serializes checks WITHIN a connection, so one connection holds at most one checkout — but N connections mean up to N concurrent checkouts, and `deps.db` is the request-serving pool built in `main.ts` with no `max`, i.e. pg's default of 10. Since `createPool` sets `connectionTimeoutMillis: 5000` (db/client.ts), SSE load spilling onto that pool surfaces as REQUEST TIMEOUTS on unrelated API calls. `main.ts` already made exactly this call one layer up — the SSE bridge gets its own `max: 2` pool (review finding SEC-1) because its work is driven by a NOTIFY channel any DB login can write to. This is the same decision for the same path, and `main.ts` documents them as one block.

WHY FOUR, not two and not ten. The memo above collapses REPEATED subjects on one connection; it does nothing for a stream of DISTINCT subjects (bulk import, backfill, reconcile sweep), which is precisely the load that matters. Two — the bridge's number — would serialize every connected client's stream behind two walks, and the bridge gets away with two because it has ONE consumer, not one per client. Four keeps a slow walk on one connection from head-of-line-blocking every other client's stream while still capping this process's extra connections at four (six with the bridge's two) — a fixed, small addition to the per-pod connection budget, not one per client.

WHAT STARVATION COSTS, EXPLICITLY: a checkout that cannot be served within `connectionTimeoutMillis` throws, `mayRead` FAILS CLOSED, and the frame is dropped on that connection. That is the stream's existing contract under load (see `MAX_PENDING_FRAMES` below, and ADR-0025 D4: no replay) — a dropped frame is recovered by the resync/cache-invalidation path. It is never a failed API request, which is the whole point of not sharing `deps.db`.

### §154. Hard cap on memoized subjects per connection

Hard cap on memoized subjects per connection — an SSE connection lives for hours and sees an unbounded number of distinct subject ids, so an unbounded map here is a memory leak with a timer, not a cache. Oldest-inserted entries are evicted first; an evicted subject simply costs one more query next time it appears.

### §155. Ceiling on frames awaiting their check on one connection

Ceiling on frames awaiting their permission check on ONE connection (the same bounded-backpressure idiom as events/sse-bridge.ts's `MAX_INFLIGHT_FETCHES`). The check is async and the hub's emit is synchronous, so frames queue behind the serialization chain below; a burst arriving faster than the database answers must not grow that queue without limit. Past this many pending, further frames are dropped — best-effort is the stream's own contract (ADR-0025 D4: no replay), and a genuine miss is recovered by the resync/cache-invalidation path, never by unbounded queueing.

### §156. SSE connection caps

SSE connection caps. Each open stream holds a socket, a DB-check queue, and a hub listener for its connection lifetime, so an authenticated caller who opens streams in a loop can exhaust the pod's file descriptors / the SSE authz pool without ever tripping a request-rate limit (the connection is long-lived, not a burst of requests). A per-principal cap stops one identity monopolising the budget; a global cap stops a fleet of identities doing the same. Both refuse with 429 BEFORE the 200 head is written, so the caller sees a clean error rather than a stream that never delivers.

### §157. THE ISOLATED POOL

THE ISOLATED POOL (see `SSE_AUTHZ_POOL_MAX` above and `main.ts`'s two-pool block), resolved per connection rather than at route-registration time because `main.ts` assigns `deps.sseAuthzDb` AFTER `buildApp` — the same late-assignment idiom as `deps.pluginHost`.

THE FALLBACK IS EXPLICIT, NOT INCIDENTAL. `buildApp` is also called by `openapi:emit` and by test-support/harness.ts, which build deps by hand as `{ db, config }`. Those callers get `deps.db` — the pre-existing behaviour, correct but UNISOLATED. It is deliberately a fallback and not a throw: refusing to serve the stream because a hand-built deps lacks a performance isolation would trade a load-shedding property for an availability one. Any process built by `main.ts` — i.e. every deployed process, in every role — has the isolated pool, and routes/events-authz.integration.test.ts asserts both halves of that.

### §158. ORDER IS THE SSE CONTRACT

ORDER IS THE SSE CONTRACT: a stream is a sequence, so the per-frame permission check — which is async, while `sseHub`'s emit is synchronous — must not let a fast verdict overtake a slow one. Every frame is appended to ONE promise chain per connection, so checks are serialized in the exact order the hub emitted them. Each link carries its own `catch`, attached synchronously, so a rejection can never surface as an unhandled rejection (which in Node 22 terminates the process by default) and can never break the chain for the frames behind it.

## `apps/server/src/routes/executor-binding-audit.integration.test.ts`

### §159. EXECUTOR-BINDING LIFECYCLE AUDIT EVENTS

EXECUTOR-BINDING LIFECYCLE AUDIT EVENTS (2026-08-25 gap) — PUT/DELETE (and, found by the same census, PATCH-repurpose) wrote NO audit event at all before this. The only executor-ish audit action ever written was `change.wave_target.no_executor`, a READ-time observation that a stage has no binding, never a record of a binding itself CHANGING. `executor-bindings-repo.ts` is the one function every binding write funnels through (the typed routes below, `iac/plans-repo.ts`'s apply-time create/update/prune, and `POST /discovery/accept`'s binding import) — the audit call lives THERE, not duplicated at each call site, so this file exercises it through the routes and trusts the single shared implementation for the non-route doors (a coverage note in `executor-bindings-repo.ts`'s module comments).

`component-merge-repo.ts`'s `repointExecutorBindingTarget` — the FOURTH binding-identity write door — used to be left deliberately unaudited on the premise that the merge that reaches it wrote no audit event of its own either, so auditing the repoint alone would look like partial coverage. That premise was false (`mergeComponents` already writes `component.delete` for the loser via `deleteObject`, plus a `transition` Decision for the merge itself) and is now corrected; the repoint is audited too (`executor.binding.repoint`) — see the merge describe block below.

`reason` is asserted to carry the Type and plugin module, and NEVER the config/secretRefs payload a binding may carry (charter: audit rows are read by humans and must not become a secrets leak).

ALSO EXERCISED HERE: `subjectDomainLocal` (ADR-0031 S2 / M20.2) on every one of these events — a domain-local target's binding lifecycle must write the LOCAL audit row same as any other, but withhold the `audit_segment` journal entry that would otherwise carry its id to a peer. Checked directly against `sync_journal` (single-domain — the withholding happens at `appendAuditEvent`, before export ever runs, so a real cross-domain round trip would only be re-proving M20.2's own test, not this gap).

### §160. THE FOURTH-DOOR CASE IS GONE WITH ITS DOOR

THE FOURTH-DOOR CASE IS GONE WITH ITS DOOR (ADR-0047). It proved that `discovery/accept`'s binding import wrote `executor.binding.put` like every other binding-identity write — the point being that the audit call lives in `executor-bindings-repo.ts`, not at each call site. That shared implementation is unchanged and still exercised by the route cases here; one fewer caller does not weaken it.

### §161. Every journal row whose payload names both of those

Every `audit_segment` journal row whose payload names `subjectId` AND an `executor.binding.*` action — the withholding check has to read the PAYLOAD, not just count rows, since an unrelated audit_segment naming the SAME subject (the component's own `component.create`, which journals ahead of any binding write) would otherwise inflate a "shared" control's count and make it indistinguishable from a real leak.

## `apps/server/src/routes/executors.integration.test.ts`

### §162. M7 plugin-configuration surface

M7 plugin-configuration surface (routes/executors.ts, routes/change-sources.ts's webhook-secret addition) — real HTTP round trips via the SDK against a real Testcontainers Postgres, on every PR at integration cost, without waiting on the heavier scripts/e2e-m7.sh job. This is the permanent regression coverage for the exact bug scripts/e2e-m7.sh caught manually once: migration 0014 originally never granted `scp_app` DELETE on `secrets`/`notification_bindings` — a gap no unit test or Testcontainers-with-schema-created-fresh-per-suite test would catch unless it actually exercises the DELETE route end to end, which this file now does permanently.

### §163. THE `accept` BINDING-IMPORT CASE IS GONE WITH ITS ROUTE

THE `accept` BINDING-IMPORT CASE IS GONE WITH ITS ROUTE (ADR-0047). It proved that importing a proposal ALSO created the proposed execution-system bindings — import and coordinate in one step (M12 P3b). There is no one-step import now: the scaffolder emits a manifest whose `executorBindings` collection lands through `POST /plans` + apply, which `plans.integration.test.ts`'s C1 round trip covers on the door that still exists.

### §164. The only-path-that-writes claim, now true more strongly

"…THE ONLY PATH THAT WRITES" WAS TRUE, AND IS NOW TRUE MORE STRONGLY. This case proved that a proposal's objects did not exist until someone explicitly accepted it — discovery alone never wrote. With `POST /discovery/accept` removed (ADR-0047) discovery cannot write AT ALL: the only way a proposal becomes estate is a human committing scaffolded IaC and applying it. The case is removed because its subject is gone, not because the property weakened.

### §165. Typed first-party report ingress (M12 P4B Phase 1)

Typed first-party report ingress (M12 P4B Phase 1) — the typed, PAT-authenticated counterpart to the raw `/webhook` route (routes/change-sources.ts). Same persist-then-process pipeline, real generated SDK contract, and — critically — NOT subject to the webhook's HMAC gate.

### §166. The fourth server-governed knob

The fourth server-governed knob. It was previously left AMBIENT while the assertion below pinned the literal `"docker"` — so this test failed on any host that had actually configured a runtime (`SCP_MANAGED_RUNNER_DOCKER_BINARY=podman`), which is exactly the RHEL/air-gapped deployment shape the setting exists for. Controlled here like its three siblings, and set to a value that is NOT the default so the assertion proves the value was INJECTED FROM THE KNOB rather than passing vacuously against the fallback.

### §167. THE OPERATOR'S RUNTIME REACHES *EVERY* MANAGED EXECUTOR

THE OPERATOR'S RUNTIME REACHES *EVERY* MANAGED EXECUTOR — the knob, measured (2026-08-16)
`SCP_MANAGED_RUNNER_DOCKER_BINARY` selects the executable every managed executor `execFile`s. It exists for two reasons, and both are load-bearing:

1. DEPLOYMENT. Regulated, air-gapped and FedRAMP/IL estates are largely RHEL, where a Docker daemon is frequently disallowed and rootless podman is the sanctioned runtime. Rootless podman is verified against the real runners (docs/container-runtimes.md) — but ONLY for the executors the setting actually reaches. 2. DEFENCE IN DEPTH. Injecting it server-side means a future regression in the write-door gate downgrades from remote code execution to an accepted-but-inert config key (see `managedRunnerDockerBinary`'s doc). That argument holds only where the injection happens.

WHY THIS IS A LOOP OVER AN ENUMERATED LIST rather than one more assertion in the test above. The injection is written once PER MODULE, as a separate `if (pluginModule === …)` arm, so the property is only ever as complete as the last person to add a managed class remembered to make it. When this test was written that had already failed: `managed-iac` and `managed-scan` set `dockerBinary`, and `managed-dep` — added later, and which `execFile`s `config.dockerBinary ?? "docker"` exactly like its siblings — did not, on ANY of its three construction paths. An operator setting the knob got podman for two executors and a silent `docker` for the third: on a podman-only host, dependency bumps fail while everything else works, and the second defence above is simply absent for that class.

Adding a fourth managed executor therefore fails HERE until it is wired, which is the point — the list is the census, and a census with no entry for a module is how the third one was missed.

### §168. THE SAME REFUSAL, FOR THE MODULES THAT NEVER HAD IT

THE SAME REFUSAL, FOR THE MODULES THAT NEVER HAD IT. The managed-iac tests above passed while three sibling modules on the very same `KNOWN_EXECUTOR_MODULES` allowlist — `managed-scan`, `pipeline-generic`, `fake-executor` — had no manifest at all, so `validatePluginConfig` found no schema and returned early. Every key of their binding configs was stored unread.

`managed-scan` is the one with teeth: `@scp/plugin-managed-scan` runs `execFile(config.dockerBinary ?? "docker", …)`, and `dockerBinary` was NOT among the keys `resolveExecutorPluginInstance` injects — so a tenant `PUT /executors/{id}/binding` naming any host path reached arbitrary code execution on the SCP host, across the exact boundary the plugin sandbox exists to hold. Proven HERE, at the HTTP write door, not only against `validatePluginConfig`: a unit test cannot show that the door still calls it.

MUTATION-PROVEN: restoring shipped main for one module — drop `"managed-scan"` from `MANIFEST_BY_MODULE`, restore `validatePluginConfig`'s `if (!manifest) return;`, and disable the `assertEveryModuleHasManifest` boot check — makes this test fail with "promise resolved { …(11) } instead of rejecting": the binding carrying `dockerBinary: "/tmp/pwn.sh"` is STORED.

### §169. The tenant-settable run budget is capped at the door

M23.1c — THE TENANT-SETTABLE RUN BUDGET IS CAPPED, AT THE DOOR, ON EVERY MANAGED CLASS.

All three managed manifests shipped `timeoutMs: { type: "integer", minimum: 1000 }` with NO maximum, and the value is settable by any org member with plain `object:write` on a Component. Two consequences, and the second is why the cap is a prerequisite rather than hygiene:

1. `execFile`'s `timeout` is the only thing that stops a wedged `docker start -a`. At 2^31 ms (24.9 days) the runner is unkillable by its own timeout. 2. The plugin HOST now derives that module's `trigger` RPC budget from the same number (`plugin-host/call-policy.ts`), so an unbounded config is an unbounded budget — and `subprocess-entry.ts` answers one RPC at a time, so that instance's `status()`/`observe()`/ `abort()` would head-of-line block behind it for the duration.

PROVEN AT THE HTTP WRITE DOOR, not against `validatePluginConfig`: a unit test cannot show that the door still calls it, and "a config schema that is authored but never registered" is exactly how this repo shipped a live RCE (see the `managed-scan` test above).

MUTATION-PROVEN: delete `maximum` from `@scp/plugin-managed-iac`'s manifest and this test fails with "promise resolved … instead of rejecting" for that module — the 2^31 binding is STORED.

## `apps/server/src/routes/executors.ts`

### §170. Bind a target object to a registered `execution-system`

Bind a target object to a registered `execution-system` (Mode A). Loads the system, derives the plugin module from its `kind` (allowlist-checked) + a shared instance id, and upserts the binding — serverUrl/token are resolved from the system at dispatch, never stored on the binding. Shared by `PUT /binding` (executionSystemId path). `POST /discovery/accept` was the other caller until increment 6 removed it (ADR-0047 — discovery scaffolds, it does not write).

### §171. Authorize first, so an unauthorized caller learns nothing

Authorize FIRST — before the typeId check below — so an unauthorized caller can't use the "'x' is a 'y', not an execution-system" error as a type/existence oracle for objects they may not read.

`object:WRITE`, not object:read: referencing a system makes SCP dispatch with that system's DECRYPTED token (and, if both egress layers agree, its internal-egress reach) — a use-of- credentials capability, not a read. object:read would be no bar at all: the built-in Viewer role (auto-assigned at org root to every first-time login) holds object:read, and authz walks containment to the org root, so every org member would pass. object:write matches the bar this same route already requires on the binding TARGET.

Known trade (ADR-0003): a system shared by many teams must grant them object:write on it, which also lets them modify its serverUrl. A distinct "use" capability would be the finer answer, but that means new RBAC; revisit if shared-system delegation becomes real.

### §172. M7 plugin-configuration surface

M7 plugin-configuration surface (BUILD_AND_TEST.md §8 M7 item 5: "plugin config schemas surfaced as validated config forms in UI/CLI"): executor/notification bindings, encrypted secrets (write-only), the static plugin-manifest catalog a config form is generated FROM, and `DiscoveryPlugin` run/accept (never auto-commits — DESIGN §11).

### §173. `secret:write` at the org root, NOT `object:write`

`secret:write` at the org root, NOT `object:write` — role-model.md §1.3d, drizzle/0099. The permission SUBSTITUTES the generic write verb here; the SCOPE is unchanged and stays one of §8.6's deliberate escalation bars, because these are the tokens SCP uses to reach GitHub/ArgoCD/Terraform and no narrower binding should ever reach them.

BREAKING, DELIBERATELY: an org-root `object:write` holder who does not also hold `secret:write` is now 403 here. drizzle/0099 grants it to Owner, Administrator and OrgAdmin, so the built-in ladder is unaffected.

### §174. The same substitution the write above takes

`secret:write`, the same substitution `PUT` above takes and for a strictly larger reason: DELETING an execution-system credential is an availability kill switch for all coordination on this deployment (role-model.md §1.3d). Symmetry with `PUT` is also the point — a permission that could store a credential but not remove it would make rotation harder than creation.

### §175. Multi-region Argo CD config surface (M15.6, ADR-0017 §3)

Multi-region Argo CD config surface (M15.6, ADR-0017 §3) — a READ + VALIDATE view of one prod environment's per-region Argo CD set: `prod env -> {region -> argocd binding}`. Additive; adds no new object type (a region is a `deployment-target` with properties.environment/region, its Argo CD an ordinary per-region binding). The operator still declares each region by binding it via `PUT /executors/:idOrUrn/binding` — this route surfaces the whole set coherently and flags a region with no Argo CD of its own instead of silently deploying it against nothing.

### §176. Discovery: proposed objects and relationships, reviewed

Discovery (DESIGN §11 — "proposed objects + relationships, reviewed/accepted into the graph, never auto-committed"). `/run` executes discover() live via the in-process PluginHost, which `main.ts` constructs for every role including a pure api process (AppDeps.pluginHost's doc comment records why it used not to); `/accept` is the ONLY path that ever writes what a discovery scan found into the graph.

### §177. `POST /discovery/scaffold` (ADR-0047)

`POST /discovery/scaffold` (ADR-0047) — a discovery proposal in, IaC SOURCE out.

THE REPLACEMENT FOR `accept`, and a different shape on purpose: it writes nothing, reads nothing from the graph, and returns text. Accept's defect was that it wrote — bypassing strict create and leaving components with no owning service. This asks the grouping question instead and hands back code for a human to commit, so the graph write happens through `POST /plans` with every ordinary door in the way.

PURE TRANSFORM, BUT STILL AUTHENTICATED AND AUTHORIZED: a proposal describes an org's estate, and the emitted code names its services and repos. `object:read` at the org root is the same bar `POST /plans` uses for diff computation, which is the closest analogue — a read-shaped request whose body the caller supplied.

IT EXISTS AT ALL because `apps/web` may import only `@scp/sdk` and `@scp/schemas` — never `@scp/iac` (eslint `no-restricted-imports`, the API -> SDK -> CLI -> IaC -> UI chain). The wizard gets the emitter's output the way it gets everything else: through the API.

### §178. Reachable only when `buildApp` was handed deps with no host

Reachable only when `buildApp` was handed deps with no host (tests, `openapi:emit`) — `main.ts` gives every ROLE one, so a deployed process always has it. The old message said "run SCP_ROLE=all", which was both wrong for a split deployment (it would start a SECOND reconcile/watchdog/observe loop set beside the worker's) and unactionable, since api is the only process serving HTTP.

### §179. Execution-system-backed discovery names its own system

Execution-system-backed discovery (e.g. argocd-discovery names its system in `config.executionSystemId`): the PERSISTED system — not the request — is the source of truth for where this plugin may talk, with what token, and whether internal egress is permitted. Mirrors executor-bindings-repo.ts's resolveExecutorPluginInstance discipline ("tenant config first, server-governed fields LAST — they win", CRITICAL #1 / MAJOR #4): a caller may NAME a system, never supply its serverUrl/token/egress allowance. Without this, an internal-egress grant on system X would authorize egress to an arbitrary caller-supplied `config.serverUrl` in the SAME request — a tenant-controlled SSRF into loopback/RFC1918 (egress-guard.ts, MAJOR #6).

### §180. Authorize at the REFERENCED SYSTEM's own scope

Authorize at the REFERENCED SYSTEM's own scope (and BEFORE the typeId check, so the error isn't a type oracle). object:WRITE for the same reason as bindTargetToExecutionSystem: naming a system here dispatches a plugin with its decrypted token, and the handler's org-root object:read above is satisfied by every org member (the Viewer role holds object:read), so an object:read check here would be effectively no gate at all.

### §181. VALIDATE THE EFFECTIVE CONFIG, NOT THE REQUEST BODY

VALIDATE THE EFFECTIVE CONFIG, NOT THE REQUEST BODY.

This used to run on `request.body.config` before the block above, which made the execution-system-backed path IMPOSSIBLE TO USE. `argocd-discovery`'s manifest requires `serverUrl`, and the whole point of naming a system is that the caller does NOT supply one — the comment above says so in as many words ("a caller may NAME a system, never supply its serverUrl/token/egress allowance"), and the merge below stamps the persisted value as server-governed. So the documented call was rejected for missing exactly the field the server was about to provide, and the only way through was to send a dummy `serverUrl` that is then overwritten — a required field whose value is ignored.

Measured on the live homelab 2026-08-02, immediately after the plugin-host fix (#200) made this route reachable at all: `{executionSystemId}` alone answered 400 "must have required property 'serverUrl'".

Validating the EFFECTIVE config is strictly stronger, not weaker. The inline path is unchanged (no system named -> effectiveConfig IS the body). The system-backed path is now checked against what the plugin will actually receive, which is the document that matters — and it still runs BEFORE `host.start`, so nothing is dispatched unvalidated.

## `apps/server/src/routes/federation-audit-witnesses.test.ts`

### §182. The audit-witness read surface the runbook needs

`GET /api/v1/federation/audit-witnesses` — the audit-witness READ surface the post-failover runbook's peers-witness comparison (resilience.md §7.2 step 5) depends on.

A ROUTE UNIT TEST, not integration: `requireAuth`/`withTenantTx`/`authorize`/ `listAuditWitnessesForOrigin` are mocked, and the real `registerFederationRoutes` is exercised through an in-process Fastify instance with the SAME `fastify-type-provider-zod` compilers the real app uses — so this pins the actual schema (the required `originDomainId` query param, the response shape) and the actual wiring (which permission is checked, which repo fn is called, that `witnessedAt` is serialized to an ISO string), not a paraphrase of them.

## `apps/server/src/routes/federation-overlay-base-authority.integration.test.ts`

### §183. THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS

THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS — they annotate a BASE GRAPH OBJECT

THE GUARANTEE UNDER TEST, in one sentence: *creating an overlay on a base object, or reading the merged view of one, additionally demands `object:write` / `object:read` AT THAT BASE OBJECT — on top of, never instead of, the org-root bar those doors already carried.*

## Why these two, and none of the other 22 sites in `routes/federation.ts`

`docs/proposals/role-model.md` §8.6 flags exactly this: `POST /api/v1/federation/overlays` and `GET /api/v1/federation/overlays/{idOrUrn}` live in the federation route file, so a census sorted by FILE sweeps them into the "federation is correctly org-scoped, leave alone" bucket. That bucket is right for the rest — a federation identity, a peer, a journal and an outpost topology are org-level concepts, so `scopeObjectId: auth.orgId` is their true scope. It is wrong for these two, because what they read and write is an annotation ON a service, a component or a policy.

That claim is MEASURED rather than inherited, and the measurement is sharper than "which file is it in". A filterless census of `routes/federation.ts` (2026-08-26) finds 24 `authorize()` sites; 22 demand `federation:read`, `federation:write` or `federation:pair`, and THESE TWO ARE THE ONLY PLACE THE GENERIC GRAPH VERBS `object:read` / `object:write` APPEAR IN THE FILE AT ALL. The generic verbs are exactly the ones whose scope is a graph object, so the PERMISSION is the tell, not the filename. Two near-misses, checked and excluded rather than assumed: `POST /federation/hand-fill` has the same base-object dimension and is not a third gap — its `object:write` bar at the resolved containment scope landed in step 0d and lives in `federation/handfill-repo.ts`, one layer down; `POST /federation/poke` has no `authorize()` at all because it is peer-authenticated (`enforceFederationMtls` plus a both-sides-consent check), not an RBAC door.

## Why the org-root bar STAYS (added, never substituted)

An overlay's row lands at ORG-ROOT containment — `createOverlay` calls `createObject` with no `domainId`. That is a STORAGE fact, not an AUTHORITY fact, and the two must not be confused in either direction:

- Downward: it does not make org-root `object:write` the whole story, because read-time merge (`getMergedOverlayView`, DESIGN §13) means an overlay on a component silently changes what every consumer of that component sees. Authority over the thing being annotated is the bar that was missing. - Upward: it does not make the base check a REPLACEMENT for the org-root one. `overlay-repo.ts`'s governance-managed guard demands `policy:write` at the org root precisely because the row lands there, and PR #286 added a sibling of that argument; substituting a base-scoped check here would let a component-scoped principal mint overlays outranking a commander-origin object. §8.6 lists that guard among the deliberate escalation bars that must not be swept.

## How a test can see an ADDED check at all

Both bars are ANDed, and `scopeExpandCte` walks upward — so anyone who clears the org-root bar ALMOST ALWAYS clears a check at any descendant of it too, and the addition is invisible to an ALLOW-only fixture. `role_bindings.effect` is what makes it visible: a deny at ANY matching scope wins (`authz/resolve.ts`), and a deny bound at the BASE is reached only by a check scoped AT the base. The org-root check is unaffected by it — the org root object has no `domain_id` and no incoming `contains` edge, so its scope expansion is the single row `{org root}`.

"ALMOST": the upward walk joins every ANCESTOR `deleted_at IS NULL`, so a base whose containment parents have been tombstoned expands to the seed alone and matches NO binding — the added bar then refuses the org-root Owner too. That is a SECOND way this addition can refuse, it is ACCEPTED rather than deliberate, and the last case below pins it.

## Why that second case is accepted, and is not measured against the 2.5a pure-widening invariant

Increment 2.5a re-scoped 21 get-by-id doors OFF the org root, and a re-scope must admit everyone it used to — `authz/org-root-arm.ts` exists to make that hold. THESE TWO DOORS ARE NOT IN THAT SET: nothing moved off the org root here, BAR 1 is the pre-2.5a check unchanged, and BAR 2 was added beside it. Adding a bar is a DELIBERATE NARROWING; by construction it refuses some of the principals one bar admitted, or it is not a bar. Judging it by a widening invariant is a category error, and it was made once on this branch before it was named.

The org-root arm cannot be the answer here for the reason the route's block states: on a CONJUNCTION it is satisfied by everyone who just cleared BAR 1, so it would not fix case 2 — it would delete BAR 2 and the deny cases above with it, leaving this file green over one bar. So the consequence is accepted and named instead: **an overlay whose base has tombstoned containment ancestors cannot be created or read by anyone, org-root Owner included, until that base's chain is repaired.** Reachable via the federation-import path, where `deleteObject`'s orphan guard is deliberately not applied — which is where foreign-origin bases live.

That is also why the deny actor is the sharpest available one: it holds `Operator` at the org root, so every refusal below is the base-scoped check and nothing else. The control case beside each proves the door did not simply close.

MUTATIONS RUN (2026-08-26). Baseline: 6 passed. MEASURED, not predicted — messages are verbatim.
M-1  Delete the ADDED `object:write` check at `base.id` from POST /federation/overlays => "a deny at the base object refuses the overlay CREATE" FAILED: expected 201 to be 403. M-2  Delete the ADDED `object:read` check at `view.base.id` from GET /federation/overlays/{id} => "a deny at the base object refuses the merged READ" FAILED: expected 200 to be 403. M-3  SUBSTITUTE rather than add — drop the org-root bar from BOTH doors, keep only the base check. **RUN FIRST AGAINST THIS FILE AS ORIGINALLY WRITTEN, PLUS `governance/governance-managed-write-doors.integration.test.ts`: 29 tests, ALL GREEN.** Nothing in the tree held the half of the ruling that says "added, never substituted", so the tidy-up that voids it was free. "a principal bound ONLY at the base is still refused" was written in response and now FAILS under the same mutation: expected 201 to be 403. That case, not this line, is the finding. M-4  Move the added `object:write` check ABOVE the base resolution (scope at `request.body.base`) => "a base that names nothing is 404, never 403" FAILED: `"lacks 'object:write' at scope '<ghost uuid>'"`, expected 403 to be 404. M-5  Move the added `object:read` check ABOVE `getMergedOverlayView` => the GET half of the same case FAILED: `"lacks 'object:read' at scope '<ghost uuid>'"`, expected 403 to be 404.

THE REFRAME, MEASURED (2026-08-26, baseline 7 passed). The tombstoned-ancestor case below was added, and with it the mutation that shows why the "obvious fix" for it is not one:

M-6  Give BAR 2 an ORG-ROOT ARM — `authorize(… scopeObjectId: base.id)` on the create door replaced by `checkAtOrgRootOrScopes({ orgRootPermission: 'object:write', scopedPermission: 'object:write', quantifier: 'any', scopeObjectIds: [base.id] })`, i.e. exactly what "fixing" case 2 the way the 21 re-scoped doors were fixed would mean => `Tests 2 failed | 5 passed (7)`. "a deny at the base object refuses the overlay CREATE" FAILED (expected 201 to be 403), and "ACCEPTED AND PINNED: a base whose ancestors are TOMBSTONED refuses everyone" FAILED (expected 201 to be 403).

```text
    "a principal bound ONLY at the base is still refused" STAYS GREEN under the mutation, and
    that is the point rather than a gap: it is refused by BAR 1, which the mutation does not
    touch. BAR 2 is the only thing the arm deletes — so the deny-at-base refusal, which BAR 1
    cannot express, is what is actually lost. The arm does not repair BAR 2; it deletes it.
    That measurement is the argument for accepting case 2 rather than papering over it.
```

### §184. THIS CASE EXISTS BECAUSE ITS MUTATION FOUND NOTHING

THIS CASE EXISTS BECAUSE ITS MUTATION FOUND NOTHING. Dropping the org-root `object:write` bar from the create door — keeping only the base-scoped one added beside it — was MEASURED against this file AND `governance/governance-managed-write-doors.integration.test.ts`: 29 tests, all green. Nothing in the tree held the "added, never substituted" half of the ruling, so the obvious tidy-up ("two checks where one would do") was free to land.

What it would have cost: this actor. `Operator` at ONE service and nothing at the org root — authority to write that service, which is not authority to create a row at the org-root containment every overlay lands at, outranking whatever the base's own origin domain is.

### §185. THIS 403 IS INTENTIONAL

THIS 403 IS INTENTIONAL. It is not the pure-widening regression the 21 RE-SCOPED doors had — see the docblock above: these two doors were TIGHTENED, BAR 1 is the pre-2.5a check unchanged and BAR 2 was added beside it, so a widening invariant never governed them. `scopeExpandCte` joins every ancestor `deleted_at IS NULL`, so a base whose containment parents are tombstoned expands to the seed alone and matches NO binding; BAR 2 therefore refuses everybody until the base's chain is repaired. Giving BAR 2 an org-root arm would not fix that — it is satisfied by everyone who cleared BAR 1, so it would delete BAR 2 and the two deny cases above with it.

Pinned so this is a KNOWN state with a written reason rather than a surprise found in production, and so that a future change to either the arm or the walk has to come here and decide on purpose.

WHY THE ANCESTOR IS TOMBSTONED WITH AN UPDATE, MEASURED RATHER THAN ASSERTED: `deleteObject`'s orphan guard refuses to delete a row with live containment children, and the base IS one — the API refusal is exercised below rather than described. The guard is skipped on the federation-import path and when removing a foreign shadow, which is exactly how a foreign-origin base ends up with a tombstoned parent; the ROW those paths leave behind is this one column on the parent, and that is all `scopeExpandCte` reads.

## `apps/server/src/routes/federation-reconcile-412-schema.test.ts`

### §186. Pins the fix, not the currently unreachable live trigger

R1 (PR #156 residual) — PINS THE FIX, not the (currently unreachable) live trigger.

`OutpostReconcileStaleProblemSchema.claimants` used to be REQUIRED. Reconcile's own `assertClaimantsUnchanged` always throws `preconditionFailed` WITH the `claimants` extension, so this never fired through the real route — but the schema, not the throw site, is the contract the zod serializer enforces: a `preconditionFailed(...)` thrown WITHOUT the extension bag (as `updateObject`'s bare `expectedVersion` 412 does, and as any future 412 on this route would by default) would fail response serialization against a REQUIRED `claimants` and come back as a 500, not a 412.

This test reproduces the exact serialization path the real app uses (the same `fastify-type-provider-zod` compilers, an error handler carrying `app.ts`'s branches) around a single throwaway route, rather than the full app + Testcontainers DB — nothing about this failure mode depends on auth, tenancy, or persistence.

ONLY THE FIRST BRANCH IS ON THIS TEST'S PATH — measured by instrumenting the handler, not inferred. It is entered exactly ONCE, with the thrown `ProblemError`, and answers 412. The 500 then comes from Fastify's own response-serialization failure, which does NOT re-enter the user error handler: no second entry was observed. So neither the catch-all nor `app.ts`'s framework-status branch (`frameworkClientProblem`, `errors.ts`) is exercised here, and copying the rest of `app.ts` in would buy no coverage while creating a second implementation to keep in step.

## `apps/server/src/routes/federation-relay-builds.integration.test.ts`

### §187. The operator read surface for the auto-relay ledger

M13.1b — the OPERATOR READ SURFACE for the auto-relay build ledger (owner ask: see queue depth and exhausted rows without DB surgery). HTTP-level, per the delete-the-wiring rule: every assertion here goes through `GET /api/v1/federation/relay-builds` via `server.app.inject`, never `listRelayBuilds` called directly — a route that forgot its `authorize(...)` call, or a handler that dropped the query params on the floor, would be invisible to a repo-level test and is exactly what this file exists to catch.

Fixture rows are seeded through the REAL writers (`seedRelayBuild` / `claimRelayBuild` / `completeRelayBuild` / `exhaustRelayBuild` / `markRelayBuildForwarded`) — the ledger table has no FK to `changes` (drizzle/0047's own header: "the ledger must survive independently of the change row"), so a fixture-only `changeObjectId` is a legitimate row, not a shortcut around a constraint. `updatedAt` is then pinned with a direct SQL nudge so the DESC-ordering assertion does not depend on four transactions landing on four distinguishable wall-clock instants.

## `apps/server/src/routes/federation-status-authz.integration.test.ts`

### §188. E5/PR #102 adversarial-review follow-up

E5/PR #102 adversarial-review follow-up — SIDE-EFFECT-BEFORE-AUTHORIZATION on GET /federation/status. The handler resolves the org's cosign PUBLIC key via `getInstanceCosignPublicKey`, which LAZILY PROVISIONS the org's cosign keypair (a cosign subprocess) on first call. That resolution must run ONLY AFTER the `federation:read` authorize check passes — otherwise an authenticated-but-unauthorized caller could trigger provisioning of their OWN org's keypair just by hitting the route. These tests pin the corrected ordering:

- an authenticated caller LACKING `federation:read` gets 403 AND provisions NO keypair; - the authorized path still returns the cosign public key (and the keypair is provisioned then).

## `apps/server/src/routes/federation.ts`

### §189. Resolve a peer's outbound delivery for a bundle drop

M13.2b (§13.2) — resolve a peer's OUTBOUND delivery for a `.scpbundle` drop, PROVIDER-AWARE and fail-closed BEFORE the export does any work: - asserts the outbound location resolves (filesystem dir OR allowlisted s3 endpoint), else 400; - for an s3 target, ALSO resolves the WRITE-scoped vault credential (`delivery/<peer>/out`) up front — a missing/malformed secret refuses here, so a refused delivery never leaves a signed bundle with nowhere to go. Credentials are resolved at use and passed to `dropDeliveryFile`; never argv/logs/Decisions (ADR-0019 §3).

### §190. `/federation` (DESIGN.md §13, BUILD_AND_TEST.md §8 M6)

`/federation` (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Every mutating route requires `federation:write`; every read requires `federation:read` (roles seeded in drizzle/0012_federation.sql). Scoped at the org root (`auth.orgId`) rather than per-object — federation identity/peers/journal are org-instance-wide concerns, not containment-scoped.

ONE ROUTE TAKES MORE (owner ruling D4, 2026-08-25): `POST /federation/peers` — pairing, i.e. declaring whose signature this instance believes — demands `federation:pair` (drizzle/0094) ON TOP OF `federation:write`. Nothing else does, deliberately: operating an established link must keep working for an actor that cannot establish a new one.

### §191. THE RETRANS DOOR

THE RETRANS DOOR (owner decision 2026-08-24). An org declared `retrans` activates relay machinery (inbox loop, auto-relay obligations) and flips that org's dependencyManagement to `managedHere: false` — correct at a CDS boundary, a stray config anywhere else. The deployment is the arbiter: a real retrans box declares `SCP_FEDERATION_ROLE=retrans` at install time (which is also what withholds its SPA — retrans-no-spa.integration.test.ts), so an org-level retrans declaration on any OTHER deployment is refused here, at the sole write door for `federation_self.role` (initFederationSelf has exactly this one non-test caller). Sentence-only 400, no decision_id — a door-level refusal, not an engine verdict. The wire enum deliberately still carries "retrans" (narrowing it is an oasdiff break, and on a retrans-profile deployment this same route accepts it).

### §192. THE SECOND BAR

THE SECOND BAR (owner ruling D4, 2026-08-25 — docs/proposals/role-model.md §4.1). ADDED, NEVER SUBSTITUTED: the `federation:write` check above is untouched, so this door only ever got harder. This route is where an operator declares WHOSE SIGNATURE this instance believes — `publicKey` is taken verbatim from the body, and `pairPeer` treats a changed value as a KEY ROTATION that supersedes the current window — and from there `POST /federation/imports` (still `federation:write`) will apply anything signed with it through `applyEntry`'s `object_upsert`, i.e. estate write authority without `object:write`. The import path is deliberately left ungated: a throw there wedges a legitimately paired peer's whole signed bundle, and pairing is the link that can be gated without breaking the contract. See `authz/resolve.ts`'s `federation:pair` note.

NO OTHER federation route demands `federation:pair` — not import, export, status, outposts, resync, poke, nor the transport-only peer PATCH — so a paired link keeps working under an actor that cannot establish a new one. (Their own gates are unchanged, which for some is more than `federation:write`: hand-fill also takes `object:write`, a federating freeze also takes `freeze:write`.)

### §193. The narrow, structurally keyless patch for one peer

M16.2 phase A (E4) — GET + the NARROW, STRUCTURALLY KEYLESS PATCH for one peer.

WHY THESE EXIST. Before this increment the ONLY peer write was `POST /federation/peers`, whose body REQUIRES `publicKey` and treats a different value as a KEY ROTATION that supersedes the current key window and hard-revokes the old key. A Settings form that read a peer, changed a base URL and re-paired would silently rotate that peer's trust anchor the moment it dropped or mangled the key — an entire class of UI-caused trust-anchor rotations. `UpdateFederationPeerRequestSchema` admits NO key material and no `role`, so this route CANNOT rotate, supersede or revoke a key: the capability is absent from the contract, not merely unused by the handler.

EVERY PAIR-TIME GUARD IS RE-APPLIED HERE. A new write door that skips the old door's validation is the bypass class this project has hit before (the governance-owned-type invariant). The census and each guard's disposition live on `updatePeerTransport` in `federation/peers-repo.ts`; the two that need route-level work are the delivery-target ALLOWLIST (below, same call as pairing) and the poke/mTLS + re-anchor guards (inside the repo, over the MERGED post-write tuple).

ONE PAIR-TIME BAR IS DELIBERATELY NOT RE-APPLIED: `federation:pair` (owner ruling D4). That permission gates re-keying, and this route's structural keylessness is exactly what makes it not a re-key — "may edit peer transport, may NOT rotate a peer's trust anchor" is now enforced at BOTH the schema and the permission layer, which was the point of splitting the permission. If `UpdateFederationPeerRequestSchema` ever gains a field that can carry key material, this route needs `federation:pair` in the same commit.

### §194. THE FIVE TRANSPORT FIELDS, SPREAD EXPLICITLY

THE FIVE TRANSPORT FIELDS, SPREAD EXPLICITLY (review round 4, H9b). This used to be `{ orgId, domainId: existing.id, ...request.body }` — the spread LAST, so a body-supplied `domainId` would have overridden the RESOLVED peer id and the PATCH would land on a different peer. It is safe today only because fastify-type-provider-zod's validatorCompiler replaces `request.body` with a key-stripping parse — a behaviour documented nowhere near this call site and one nobody would think to re-check when swapping validators. Naming the fields makes the safety local and total: there is no key here that could carry an identity.

### §195. Authorize first, in its own transaction

M17.3 (E5) — authorize FIRST, in its own tx, so the cosign public-key resolution below is GATED behind the permission check: `getInstanceCosignPublicKey` LAZILY PROVISIONS this org's keypair (via a cosign subprocess) on first call, and an authenticated-but-unauthorized caller (no `federation:read`) must never trigger that provisioning just by hitting this route. Mirrors /exports/promotion's ordering (authorize in its own tx, then the out-of-tx work).

### §196. M15.5(c) — the retrans validate-then-relay

M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). SOURCE side: build the signed byte tarball for an imported, M17.4(a)-verified promotion. Only a `role: retrans` instance may run it (the repo function enforces the role, 409 otherwise). The tarball lands in the operator-configured SCP_RELAY_OUT_DIR drop directory — the CDS crossing itself is out-of-band, the same boundary the `.scpbundle` walk draws.

### §197. The outbound drop resolves through the destination peer

M13.2a (§13.2) — the outbound drop resolves through the DESTINATION peer's DeliveryTarget when the request names one; absent a peer, through the instance env (`SCP_RELAY_OUT_DIR`) exactly as before — byte-identical. NEITHER resolvable → fail-closed 400 carrying the named per-gap problem (never a silent default path).

M13.2b scope note: `buildRelayTarball` writes the tarball to a LOCAL directory path, so a relay destination configured for s3-compatible delivery fails closed here with a clear provider-mismatch (requireOutboundDir refuses an s3 target). Relaying the multi-GB tarball DIRECTLY to s3 (build-then-lib-storage-upload) is a follow-on to this increment; the s3 WRITE seam (dropDeliveryFile) and its multipart path already exist and are exercised by the `.scpbundle` drop + the delivery-target suite. Configure a filesystem SCP_RELAY_OUT_DIR (or a filesystem peer deliveryTarget) for relay builds.

### §198. This route is the documented exit from that terminal state

M13.1b — THIS ROUTE IS THE DOCUMENTED EXIT from the auto-relay's terminal `exhausted` state. An operator who fixes whatever the unattended sweep gave up on and re-drives the hop by hand has, by that act, both delivered the bytes and demonstrated the cause is gone; recording the ledger row `built` is simply the truth, and it is what keeps `exhausted` from being a trap that needs superuser SQL to clear. Upserts, so a manual relay on an instance/change with no ledger row (a promotion imported before this milestone) records its outcome too. Deliberately AFTER the refusal check: a refused manual build clears nothing.

### §199. M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE

M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE (owner ask): an operator on the retrans box (CLI/API only — a retrans never serves the SPA, M16.3 P3 owner decision) can see queue depth and exhausted rows without DB surgery. Simple `authorize`-in-its-own-tx shape, like GET /federation/status's own permission gate: this handler has no out-of-tx work (no cosign resolution, no subprocess), so there is no reason to split the transaction the way /status and the export/relay routes must.

ROLE-AGNOSTIC BY CONSTRUCTION (see relay-builds-repo.ts's `listRelayBuilds` doc): the ledger is populated only on a `role: retrans` instance (seeded at promotion import there); on any other role the table is honestly empty, so this route never 409s on role — an empty `items` array is the truth, matching every other read surface in this codebase.

### §200. No pagination cursor

No pagination cursor: this is a bounded TRIAGE read (queue depth + exhausted rows), not enumeration — see RelayBuildListResponseSchema's doc for the `{ items }` shape choice. No existing route bounds a plain (non-cursor) `limit`, so the default/cap here are this route's own choice, documented rather than inherited: 100 keeps the common "show me what's stuck" call cheap, 500 is a generous but finite ceiling against an unbounded scan.

### §201. FEDERATION AUDIT WITNESS

FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7) — the OPERATOR READ SURFACE for the post-failover runbook's peers-witness comparison (resilience.md §7.2 step 5): `scp audit verify` alone cannot see a truncated chain (any prefix of a valid hash chain verifies as valid), so the operator compares the restored origin's chain head against what THIS domain earlier witnessed of it. Same simple authorize-in-its-own-tx shape as `/federation/relay-builds` above — this handler has no out-of-tx work either.

### §202. M14.2 (ADR-0009, docs/proposals/outpost-poke.md)

M14.2 (ADR-0009, docs/proposals/outpost-poke.md) — the INBOUND CONTENTLESS POKE. A commander/ upstream calls this to wake THIS instance's pull NOW instead of waiting for the interval. It carries ZERO data (ADR-0009 no-DATA-commander→outpost invariant): the body is IGNORED and no request schema is declared, so nothing in it can ever drive behavior. Structurally this lives on the instance's OWN /v1 API (never inside the client-only `federation-https` plugin, which keeps its "no server half" property) as an mTLS-gated route, exactly like the other transport verbs.

FAIL-CLOSED on BOTH transport identity AND receiver-side consent (the crux): 1. `enforceFederationMtls` authenticates the caller by client-cert SAN identity. When federation-server-mTLS is UNSET it is a no-op and leaves `mtlsPeerDomainId` undefined — so a bearer-only poke does NOT meet "authenticate the caller as the enrolled commander" (ADR-0009) and is REFUSED here (401). A poke is honored only from an enrolled client cert. 2. BOTH-SIDES CONSENT (owner refinement 2026-07-24): the poke is honored only if THIS receiving instance has ITS OWN `pokeMode=true` for the calling peer (set on this side via `scp federation pair <upstream> --poke-mode`, M14.1). An enrolled peer whose receiver-side pokeMode is false is rejected (409) — the receiver never opted into pokes from it. An unknown/non-enrolled caller is already rejected (403) by `enforceFederationMtls` itself. Idempotent + rate-limited: a per-peer token bucket drops excess pokes (429), and the wake is a plain enqueue, so N pokes in a window → at most one pull. The pull runs on the sync loop's worker, never inline here (return fast). Sync loop not running on this process → accepted no-op.

### §203. M14.4 (D2 — SELF-PROVING SPARSE)

M14.4 (D2 — SELF-PROVING SPARSE): record that a poke from this peer ACTUALLY ARRIVED. The scheduler keeps a pokeMode peer on the FREQUENT cadence until this stamp exists, so an outpost can never go sparse on the strength of its own flag alone (poke-mode is TWO independent flags on TWO instances; the commander's half may never have been enabled). Stamped AFTER the consent + rate-limit gates, so only an HONORED poke counts as proof.

### §204. WAKE — enqueue immediate ticks and return fast

WAKE — enqueue immediate ticks and return fast. The loops' workers do the actual work; we never pull inline. No queue on this process (pure role=api, or the loops are disabled) → accepted-but-no-op (the sparse safety-net is the reliability floor).

THREE loops, THREE independent try/catches (M14.4 S6, extended by M13.1b): 1. the federation-sync loop — the CONNECTED leg (an outpost that dials its commander); the wake carries `{reason:"poke", orgId}` so the worker runs a FORCED tick that bypasses the M14.4 due-gate. The orgId is the CALLER'S OWN AUTHENTICATED org, never a request body. 2. the inbox loop — the AIR-GAP leg. An air-gapped outpost has NO role:commander peer with a baseUrl; its content arrives as a FILE. Without this, the ADR-0009 §38 "required" high-side-retrans→outpost poke would wake a sweep that resolves to ZERO peers. 3. the auto-relay loop — the BYTE leg at a `role: retrans` staging node (M13.1b). Legs 1 and 2 move METADATA; until this one existed, a poke landing on a retrans woke the import of the arriving `.scpbundle` and then waited for a human to run the byte hop (M14.4's honest-scope note, owner decision D3). This is what makes the chain move bytes. Each in its own try/catch so a missing queue on any side still returns accepted:true.

### §205. THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS

THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS (role-model.md §8.6)
Every other `authorize()` in this file is correctly pinned at `auth.orgId`: a federation identity, a peer, a journal, an outpost topology and an import/export are org-level concepts, and a binding narrower than the org root holds authority over none of them. These two are the exception, and a census sorted BY FILE sweeps them into that bucket wrongly — what they write and read is an annotation ON a base graph object: a service, a component, a policy.

SO EACH GAINS A SECOND CHECK AT THE RESOLVED BASE OBJECT — ADDED, NEVER SUBSTITUTED.

WHY THE BASE. `getMergedOverlayView` is a READ-TIME merge (DESIGN §13), so an overlay on a component silently changes what every consumer of that component sees, without touching the component's own row. Authority over the thing being annotated is the bar that was missing.

WHY THE ORG-ROOT BAR STAYS. `createOverlay` calls `createObject` with no `domainId`, so an overlay's row always lands at ORG-ROOT containment. That is a STORAGE fact, not an AUTHORITY fact, and it must not be read in either direction: it does not make org-root `object:write` the whole story (see above), and it does not make a base-scoped check a replacement for it. `federation/overlay-repo.ts`'s governance-managed guard demands `policy:write` AT THE ORG ROOT for exactly the storage reason, and its own doc explains why substituting a base-scoped check there would let a component-scoped principal mint overlays outranking a commander-origin object. §8.6 lists that guard among the deliberate escalation bars this increment must not sweep. Keeping the org-root bar first also keeps these doors' 403 for an unbound caller byte-identical to today's, and keeps the base resolution behind an authorization check.

THESE TWO DOORS WERE **TIGHTENED**, NOT RE-SCOPED — SO THE PURE-WIDENING INVARIANT DOES NOT GOVERN THEM (owner-level judgement, 2026-08-26)
Increment 2.5a re-scoped 21 get-by-id doors OFF `scopeObjectId: auth.orgId` and ONTO the object each governs, and that re-scope carries a strict invariant: every request that succeeded before must still succeed. `authz/org-root-arm.ts` exists to make it hold, because `scopeExpandCte` joins every ancestor `deleted_at IS NULL` and so reaches nothing at all from an object whose parents are tombstoned — something an org-root pin could never do to anybody.

THESE TWO DOORS ARE NOT IN THAT SET. Nothing was moved off the org root here: BAR 1 is the pre-2.5a check, unchanged, and BAR 2 was ADDED beside it. Adding a bar is a DELIBERATE NARROWING — it is the entire point of the change (§8.6, and the hand-fill/publish precedent from PR #286) — so measuring it against an invariant written for a widening is a category error, and it was made once already on this branch. The right question for a conjunction is "does the new bar refuse the right things", not "does it refuse anyone the old bar admitted"; by construction it does refuse some of them, or it would not be a bar.

WHAT BAR 2 REFUSES — TWO CASES, both accepted, neither a defect:

```text
1. an explicit `deny` binding AT THE BASE. The bar's purpose, and pinned by
   `federation-overlay-base-authority.integration.test.ts` — a deny is reached only by a check
   scoped at the base, which is what makes the added bar observable at all.
2. A BASE WHOSE CONTAINMENT ANCESTORS ARE TOMBSTONED. `scopeExpandCte` joins every ancestor
   `deleted_at IS NULL`, so the walk from such a base reaches NOTHING — not even the org root
   — and BAR 2 then refuses EVERYONE, an org-root Owner included. Stated plainly, because it
   is a real operational state and not a footnote: **an overlay whose base has tombstoned
   containment ancestors cannot be created or read by anybody until that base's containment
   chain is repaired.** Reachability is narrow but real — `deleteObject`'s orphan guard stops
   a LIVE base from having a tombstoned parent locally, and is deliberately skipped on the
   federation-import path, which is precisely where a foreign-origin base lives. The remedy is
   to repair the chain (re-import or re-parent the base), not to hold an overlay door open
   over an object nothing can currently establish authority over.
```

AND THE ORG-ROOT ARM IS DELIBERATELY NOT APPLIED TO BAR 2. `checkAtOrgRootOrScopes` composes "at the org root OR at the governed object", which is the right shape for a re-scope and the wrong shape here: BAR 1 has already established that the caller holds the permission at the org root, so an org-root arm on BAR 2 is satisfied by every principal that reaches it. That does not "fix case 2" — it deletes BAR 2 entirely, case 1 with it, and would leave two mutation-proven tests green over a door with one bar. Distinguishing "explicitly denied" from "nothing reached" is the only fix that would preserve case 1, and that is a new authz primitive and an owner decision, not a comment. Case 2 is therefore a KNOWN, ACCEPTED state, pinned by a test that asserts the 403 so it is discovered here rather than in production.

The bar is built now because the increment that gives out bindings below the org root is the one where it starts mattering, and because a later sweep that relaxes the org-root pin here would otherwise leave the door with no bar at all.

THE BASE IS RESOLVED BEFORE IT IS SCOPED. `scopeExpandCte` seeds its CTE with the raw uuid and never checks existence, so a check scoped at an unresolved caller-supplied value refuses everybody — including an org-root Owner, who would get a 403 where a 404 is the honest answer.

PINNED BY `routes/federation-overlay-base-authority.integration.test.ts` (mutation-proven), with the no-regression half in `governance/governance-managed-write-doors.integration.test.ts`.

### §206. BAR 2 — ADDED, at the object being annotated

BAR 2 — ADDED, at the object being annotated: a deliberate NARROWING, not a re-scope, so it carries no org-root arm (the block above says why one would delete the bar). A base whose ancestors are tombstoned refuses everybody here, by design and pinned by test. `createOverlay` resolves the base again a moment later (it is the choke point every one of its type refusals is written against, and moving the resolution out of it would put those refusals behind a route that could drift); one indexed lookup buys an authorization decision that cannot be made from the caller-supplied string alone, and buys the 404 that scoping at that string would destroy.

### §207. BAR 2 — ADDED, at the object being read

BAR 2 — ADDED, at the object being read: the same deliberate narrowing as on the create door, and with the same accepted consequence for a base whose ancestors are tombstoned. The merge is computed FIRST because it is what resolves (and 404s on) the base; it is a pure computed view that writes nothing, and it is already behind BAR 1, so nothing reaches it that today's door would have refused. The response is withheld until authority at the base itself is established.

### §208. Authorization only: the row is still import-authored

Authorization only — the ROW is still authored by `FEDERATION_IMPORT_ACTOR_ID`, which is what makes a later signed bundle reconcile over it (see `handfill-repo.ts`'s module doc). `handFillObject` deliberately does NOT reuse this for the upsert's own `actorObjectId` (that stays the synthetic import actor, which is what makes the row a shadow copy) — it is the subject the governance-authority, policy-scope and governance-label refusals all resolve.

### §209. M16.2 phase A (E1) — `outpost` GRAPH-OBJECT config

M16.2 phase A (E1) — `outpost` GRAPH-OBJECT config: the commander-authored declared config that SYNCS DOWN (nothing written on a `federation_peers` row can, since the journal has no peer-shaped entry kind). Read `federation/outpost-binding.ts` for the authority split between the two halves.

GATED ON `federation:write`/`federation:read`, NOT plain `object:write`. That is deliberate and is why the generic `/objects/outpost` door is refused outright (`routes/objects-generic.ts`): a side door with a weaker permission on the same rows is exactly the governance-owned-type bypass this codebase already paid for once.

### §210. A query parameter rather than a body, so defaults hold

N9 — a QUERY parameter rather than a body, so the default call is unchanged and needs no body at all. Names the row that should SURVIVE; absent keeps the most authoritative one.

`ifClaimant` is the OPTIMISTIC-CONCURRENCY PRECONDITION, repeatable, one `<objectId>:<version>` per claimant the caller previewed. Same wire form as `keep` for the same reason: the default call stays body-free and unchanged. Absent = proceed unchecked (additivity forces that default — see `assertClaimantsUnchanged`).

### §211. The only precondition failure here is a stale claimant

Today the ONLY 412 this route produces is the stale-claimant refusal, so `claimants` is populated on every 412 this handler actually throws — but the field itself is OPTIONAL (R1 fix, PR #156 residual): a bare `preconditionFailed` with no extension must still serialize as 412, not 500, however unreachable that branch is today. Declaring the schema here is also what lets `claimants` through at all: the zod serializer strips every member a response schema does not name, extension members included.

## `apps/server/src/routes/gitea-discovery.integration.test.ts`

### §212. M15.3a end-to-end — the Gitea `DiscoveryPlugin`

M15.3a end-to-end — the Gitea `DiscoveryPlugin` (gitea-discovery) proves the FULL import loop for a bring-your-own Gitea, not just the plugin's own nock unit test: POST /discovery/run (module gitea-discovery, backed by an execution-system kind=gitea) → a real subprocess plugin-host scan of a live (in-process) Gitea contents API → proposal carrying a Component whose sourceMapping.sourceKind is 'gitea' → the proposal's component + source_mapping are landed (through the typed doors since ADR-0047 removed accept) → the imported component SELF-REPORTS: a gitea observed event on its repo/path correlates to a Change. sourceKind='gitea' is the load-bearing link — it matches the gitea EXECUTOR's source_kind, so pulled gitea events correlate against the imported component (before this, nothing produced a gitea-kinded source_mapping, so gitea events correlated against nothing).

The Gitea instance is a real loopback (127.0.0.1) HTTP server: the plugin-host subprocess makes genuine undici calls to it (nock can't reach across the subprocess boundary). Reaching loopback is gated by BOTH the operator allowlist (SCP_INTERNAL_EGRESS_HOSTS, set here) AND the execution- system's `allowInternalEgress` intent (ADR-0003 two-layer) — exactly the path a self-hosted / air-gapped Gitea outpost uses, so this also exercises that egress grant end to end.

### §213. `withPluginHost`, NOT `withReconcileLoop`

`withPluginHost`, NOT `withReconcileLoop` — and that is load-bearing. This suite calls `processChangeSourceEvents` INLINE and then reads `resulting_change_object_id` back synchronously. A live reconcile loop is a competing consumer of exactly those rows: the processor claims with `FOR UPDATE SKIP LOCKED`, so a tick that claims the row first makes the inline call a silent no-op and the follow-up read returns the tick's uncommitted pre-image — NULL. Measured at ~0.7% per event under CPU load, 0/300 with the loop off, and it never reproduces on an idle machine. It failed once in CI on PR #217 and passed on re-run.

The loop would also race the `state === "proposed"` assertion below, since `advanceProposedChanges` moves it to `evaluated`. Only the plugin host is actually needed here: `POST /discovery/run` fail-closes on `deps.pluginHost` alone.

### §214. 1) RUN — a real subprocess plugin-host scan

1) RUN — a real subprocess plugin-host scan. `executionSystemId` names the system whose (server-governed) serverUrl/token/egress the run uses. NOTE (M15.3b): the config carries NO `baseUrl` — the gitea adapter now resolves its REST base from the injected `serverUrl` (the execution-system's own serverUrl, injected server-side and pinned to the egress-allowed host), which is exactly what makes importing an EXISTING (Mode A) Gitea reach it. Only owner/repo are the adapter's own per-run config fields.

### §215. 2) ACCEPT — the only path that writes

2) ACCEPT — the only path that writes. Carry the proposal's objects AND ITS RELATIONSHIPS through, and turn the component's carried sourceMapping into a `sourceMappings[]` entry (the shape accept persists) so the import self-reports. This is exactly the transform a UI/CLI review does.

```text
 THIS STEP USED TO SEND `relationships: []`, and that one token is why the discovery
 relationship channel could be dead in every deployment with this file green. It asserted
 one screen up that the proposal CONTAINS an edge, then imported a proposal containing none
 — so the step between those two facts, the only one that writes, was never crossed here.
 Both `part_of` (unregistered) and the unresolvable endpoint URNs sat in that gap.
 See `routes/discovery-relationship-import.integration.test.ts` for the dedicated census.
```

```text
 The RENAME is kept deliberately, and now proves something: both objects are renamed at
 review time (as a real reviewer does, and as this file must, to stay unique across runs),
 while `relationships` is passed VERBATIM. That only works because an endpoint names the
 object's proposal-local `urn` ALIAS rather than anything derived from its name.
```

### §216. LANDED THROUGH THE ORDINARY DOORS, not `discovery/accept`

LANDED THROUGH THE ORDINARY DOORS, not `discovery/accept` — that route was removed in increment 6 (ADR-0047), and with it the one-call import this section used to make.

What the section is ABOUT is unchanged and is the reason it survives rather than being deleted: a `gitea`-kinded `source_mapping` on a real component is what makes a pulled `gitea` event correlate to a Change. Before that mapping existed, nothing produced a `gitea`-kinded mapping and every such event correlated against nothing. The import mechanism moved to IaC; the correlation property did not move at all, so it is still proven here, against a component created the way a scaffolded manifest creates one.

## `apps/server/src/routes/gitlab-discovery.integration.test.ts`

### §217. M15.3b end-to-end — the GitLab `DiscoveryPlugin`

M15.3b end-to-end — the GitLab `DiscoveryPlugin` (gitlab-discovery) proves the FULL import loop for a bring-your-own GitLab, not just the plugin's own nock unit test: POST /discovery/run (module gitlab-discovery, backed by an execution-system kind=gitlab) → a real subprocess plugin-host scan of a live (in-process) GitLab repository-tree API → proposal carrying a Component whose sourceMapping.sourceKind is 'gitlab' → the proposal's component + source_mapping are landed (through the typed doors since ADR-0047 removed accept) → the imported component SELF-REPORTS: a gitlab observed event on its repo/path correlates to a Change. sourceKind='gitlab' is the load-bearing link — it matches the gitlab EXECUTOR's source_kind, so pulled gitlab events correlate against the imported component (before this, nothing produced a gitlab-kinded source_mapping, so gitlab events correlated against nothing).

The GitLab instance is a real loopback (127.0.0.1) HTTP server: the plugin-host subprocess makes genuine undici calls to it (nock can't reach across the subprocess boundary). Reaching loopback is gated by BOTH the operator allowlist (SCP_INTERNAL_EGRESS_HOSTS, set here) AND the execution- system's `allowInternalEgress` intent (ADR-0003 two-layer) — exactly the path a self-hosted / air-gapped GitLab outpost uses, so this also exercises that egress grant end to end.

### §218. `withPluginHost`, NOT `withReconcileLoop`

`withPluginHost`, NOT `withReconcileLoop` — and that is load-bearing. This suite calls `processChangeSourceEvents` INLINE and then reads `resulting_change_object_id` back synchronously. A live reconcile loop is a competing consumer of exactly those rows: the processor claims with `FOR UPDATE SKIP LOCKED`, so a tick that claims the row first makes the inline call a silent no-op and the follow-up read returns the tick's uncommitted pre-image — NULL. Measured at ~0.7% per event under CPU load, 0/300 with the loop off, and it never reproduces on an idle machine. It failed once in CI on PR #217 and passed on re-run.

The loop would also race the `state === "proposed"` assertion below, since `advanceProposedChanges` moves it to `evaluated`. Only the plugin host is actually needed here: `POST /discovery/run` fail-closes on `deps.pluginHost` alone.

### §219. 2) ACCEPT — the only path that writes

2) ACCEPT — the only path that writes. Carry the proposal's objects AND ITS RELATIONSHIPS through, and turn the component's carried sourceMapping into a sourceMappings[] entry so the import self-reports (the transform a UI/CLI review does).

```text
 THIS STEP USED TO SEND `relationships: []` — see the matching note in
 `gitea-discovery.integration.test.ts` and the census in
 `routes/discovery-relationship-import.integration.test.ts`. Asserting the proposal contains
 an edge and then importing a proposal containing none is how a dead write path stayed green.
```

```text
 Both objects are renamed at review time while `relationships` is passed VERBATIM: that only
 works because an endpoint names the object's proposal-local `urn` ALIAS, not its name.
```

### §220. LANDED THROUGH THE ORDINARY DOORS, not `discovery/accept`

LANDED THROUGH THE ORDINARY DOORS, not `discovery/accept` — that route was removed in increment 6 (ADR-0047), and with it the one-call import this section used to make.

What the section is ABOUT is unchanged and is the reason it survives rather than being deleted: a `gitlab`-kinded `source_mapping` on a real component is what makes a pulled `gitlab` event correlate to a Change. Before that mapping existed, nothing produced a `gitlab`-kinded mapping and every such event correlated against nothing. The import mechanism moved to IaC; the correlation property did not move at all, so it is still proven here, against a component created the way a scaffolded manifest creates one.

## `apps/server/src/routes/governance-move.ts`

### §221. THE `governance:move` LATTICE'S API SURFACE

THE `governance:move` LATTICE'S API SURFACE (charter principle 3: API → SDK → CLI → IaC → UI). Proposal `governance-reach-on-containment-move.md` §9.2; owner ruling 2026-08-18.

Five verbs, and the split between them is an AUTHORITY split, not a convenience one:

- the two READS about an org's own lattice need `object:read` (seeing which of your containers is governed is reading your graph); - the two RUNG WRITES need `policy:write` AT-OR-ABOVE the subject — enabling a rung is a governance-authoring act, held to the same bar as authoring a policy, and `policy:write` is Administrator/Owner only (drizzle/0010:174); - the INSTANCE write needs the deployment OPERATOR TOKEN and nothing a tenant can hold, because the instance rung binds every org on the deployment. Byte-for-byte the `dependency_subscription_unlock` shape (`routes/dependency-subscriptions.ts`): tenant-readable `GET`, operator-only `PUT` through a raw admin pool, because `scp_app` has neither a write grant nor a write RLS policy on that table (drizzle/0083 §2, two independent barriers).

THE EXPLAIN READ ANSWERS ABOUT ONE OBJECT'S CHAIN, AND A MOVE HAS TWO ENDS. `enforced: false` here does NOT promise a move of this object is ungoverned — the destination's chain is ORed in at the door. Said on the schema too (`packages/schemas/src/governance-move.ts`), because a consumer that gets this wrong builds a UI that promises a move will succeed and then shows a 403.

WHY THE EXPLAIN READ SITS UNDER `/objects/:type/:idOrUrn/` RATHER THAN `/objects/:idOrUrn/`: `routes/objects-generic.ts` already claims `:type` at that position, and find-my-way refuses a second parameter NAME in a position it has already bound — a one-segment form would fail at registration, not at request time. `/objects/:type/:idOrUrn/health` is the existing precedent for a per-object sub-resource and this follows it exactly.

EVERY WRITE RECORDS A DECISION AND AN AUDIT EVENT IN THE SAME TRANSACTION (charter principle 6) — and that is now true of a SECOND door, `iac/plans-repo.ts`'s apply (proposal §9.6 Q4), because both go through `governance/move-rung-write.ts` rather than each assembling the act for itself.

### §222. THE LIST READ

THE LIST READ — the whole lattice this org can act on, instance state included.

AUTHORIZED AT THE ORG ROOT (`scopeObjectId: auth.orgId`), NOT at each rung's own subject. This is a narrower bar than the explain read's per-object `object:read` above: a domain-scoped Administrator who can enable/disable a rung on their own domain (a `policy:write`-at-that-scope act) may still lack `object:read` at the org root and so cannot list the org's whole lattice, including the rung they themselves just set. That is a server-authorization decision, not a bug this route comment fixes — flagged here so a UI consumer knows the 403 it may see is expected, not a wiring defect, and states the requirement instead of a caller having to infer it from the `authorize()` call below.

### §223. An operator connection, never an inline pool

`withOperatorDb`, NOT an inline `createPool(config.databaseUrl)` — role-model.md §5 step 9. The inline form was wrong twice: `databaseUrl` is the ADMIN connection, which the hardened Helm shape never gives api/worker pods (so `loadConfig` fell back to its localhost literal and this dialled 127.0.0.1 inside its own pod, returning a bare 500), and `scp_app` holds SELECT only on this FORCE-RLS table anyway. drizzle/0102 adds the grant + `operator_write` policy that make the `scp_operator` connection able to write it.

## `apps/server/src/routes/governance.ts`

### §224. The change doors here use the same two scoping helpers

The change doors in THIS file are scoped by the same two helpers `routes/changes.ts` scopes its own with, imported rather than restated so the read bar and the write bar cannot drift apart across the two files (see their docblock for why a change's scope is its TARGETS). `resolveChangeForScope` comes with them: a door that scopes at a change's targets must first establish that the id it was handed IS a change, or the target-set refusal turns "that is not a change" into a 403 for a principal with full authority.

### §225. The read scope of one approval request

The read scope of one approval request: `object:read` at ANY ONE target of the change it belongs to (role-model.md §8.4 — a change's own `domain_id` is the org root, so the targets are the only real scope). Shared by `GET /approvals/{id}` and its `/votes` sub-resource so the request and its contents can never end up behind different bars.

The change is resolved with the THROWING `resolveChangeForScope` on purpose: `approval_requests.change_object_id` names a change that must exist for the request to mean anything, so an unresolvable one is an honest 404 about a dangling row rather than a 403 that would read as missing standing.

A SOFT-DELETED change is not "unresolvable" here, and neither door re-applies a tombstone 404. Before 2.5a these two resolved no change at all — they authorized at the org root and read the request — so an approval request whose change has since been tombstoned was served, and still is (`resolveChangeForScope`'s docblock has the full account). The 404 this function does produce is for a `change_object_id` that names nothing or names a non-change, which means the row is corrupt.

### §226. One wire projection of a freeze, shared by five routes

ONE wire projection of a freeze row, shared by all five freeze routes.

It was written out four times before M25.1 (create/list/get, and `atomic` had to be added to each), and this increment adds three more fields and two more routes — seven copies of one mapping, where forgetting the new field in ONE of them makes a lifted freeze look live on exactly one endpoint. That is the "census by property" shape the project instructions name: the property is "a place that turns a FreezeRow into wire JSON", so there is now one.

### §227. The publish permission is demanded on every such verb

M25.7 — `federation:write` IS DEMANDED ON EVERY VERB THAT PUBLISHES, NOT ONLY ON CREATE
The create route gates `federate: true` on `federation:write` because declaring a freeze that binds ANOTHER security domain is a categorically different act from describing your own estate (ADR-0043 §3). Both write verbs re-publish — `syncFreezeObject` re-snapshots the object after a lift and after a window edit, and that snapshot rides the next bundle — so gating only the create leaves the same reach reachable with strictly less authority:

```text
a `freeze:write`-only actor could take a federating freeze whose window ends tonight and
`PATCH` its `endsAt` a year out, extending a release-stopping block across a boundary they
hold no federation authority over. The lift direction is the mirror image: retracting a
commander's protection at every downstream instance.
```

Keyed on `objectId !== null` — i.e. on whether `syncFreezeObject` will ACTUALLY publish, read from the row rather than inferred from anything else. A non-federating freeze (the default, and the whole pre-M25.7 estate) never reaches the check, so every existing caller is unchanged.

Checked at the freeze's OWN scope, matching the `freeze:write` check it sits beside and the create route's, so the permission's reach and the freeze's reach stay the same bounded thing.

ADDED, NEVER SUBSTITUTED: `freeze:write` is already authorized by the time this runs.

It is deliberately NOT the replica guard. `freezes-repo.ts`'s `lockFreezeRow` refuses a write to a freeze another DOMAIN owns (409); this refuses a write by an actor without federation authority to a freeze THIS domain owns (403). Neither subsumes the other, and only one of them fires for a commander operator editing a commander freeze.

### §228. Taking protection away from a freeze you did not declare

M25.9 / OWNER RULING D1 (2026-08-25) — TAKING PROTECTION AWAY FROM A FREEZE YOU DID NOT DECLARE
`freeze:override` on top of `freeze:write`, and ONLY when the acting subject is not the freeze's `created_by_actor_id`. The full reasoning, the three artifacts that disagreed and which of `campaigns-rework.md` §1.7's three exits the owner took, is in the lift route's docblock below; this is the one place the rule is spelled.

ONE FUNCTION, TWO CALLERS, DELIBERATELY. `DELETE` (lift) and a SHORTENING `PATCH` are the same act — both end a protection early for everyone the freeze covers — and `freezes-repo.ts`'s `lockFreezeRow` header records what the asymmetric version of a freeze refusal costs: "a lift that is refused while a window edit is not lets an outpost push a commander's `ends_at` to a past instant and achieve the retraction it was refused, through a verb nobody thought to guard." The same sentence is true one authority-model over. A third loosening verb must call this too.

COMPARED ON `created_by_actor_id`, READ FROM THE ROW. Never inferred from who holds what, and never from `lifted_by_actor_id` (which is null until the very write being authorized). For any freeze these routes can write, the column is set once by `createFreeze` and never updated: the only other writer is `governance/freeze-object.ts`'s rebuild, whose update arm is fenced to `object_id = <the peer object>` — a REPLICA row, which `freezes-repo.ts`'s `lockFreezeRow` already refuses both write verbs on with a 409 before authorship could matter. So the value cannot drift out from under an authorization decision made on it, which is what makes the comparison safe against the lift route's unlocked read.

ADDED, NEVER SUBSTITUTED: `freeze:write` at the freeze's own scope is authorized by the time this runs, on both verbs, for every caller. This is a second bar, and it is demanded at THE FREEZE'S OWN SCOPE — the same scope as the `freeze:write` check it sits beside, and the scope DESIGN §10.3 already demands `freeze:override` at for a per-change override ("at that freeze's own scope"), so one permission means one thing on both of its doors. `hasPermission` expands upward only, so an Owner bound at service S can retract an S-scoped freeze a colleague declared and CANNOT reach the org-root freeze that covers everyone — the same bound `freeze:write` gets here, for the same reason. Demanding the override at `auth.orgId` instead would not be a hole (it is strictly narrower: only an org-root Owner would ever clear it), but it would make this bar's reach disagree with the reach of the permission it is stacked on, and would leave a service Owner unable to retract a colleague's freeze inside their own service.

AND THAT PARAGRAPH IS PINNED, NOT MERELY ARGUED — `coordination/freeze-admission.integration. test.ts`, the `M25.9 ladder` case "the override is demanded at THE FREEZE'S OWN SCOPE": a SERVICE-bound Owner lifts a service-scoped freeze an org-root Administrator declared, with a service-bound ADMINISTRATOR refused on the same freeze as its control. Rewrite `scopeObjectId` below to `auth.orgId` and that one case goes red. It exists because review found this claim unmeasured: every OTHER actor in that block is bound at the ORG ROOT, where the two spellings name the same scope, so all of them passed under either. A claim about a second parameter needs a case in which that parameter is the only thing that moved.

### §229. The governance sub-resources that are not typed registries

M4 governance sub-resources that aren't plain typed-registry objects (BUILD_AND_TEST.md §8 M4): control bindings + runs, approval quorum, freezes, and `scp policy evaluate`'s dry-run endpoint. Registered from app.ts alongside `GOVERNANCE_TYPED_REGISTRY_RESOURCES` (routes/typed-registries.ts).

### §230. Read at any one of the change's targets, not the root

`object:read` at ANY ONE of the change's targets, not at the org root — a change's own `domain_id` is the org root, so nothing narrower than the targets is a real scope here.

`resolveChangeForScope` does two things this door needs, both of them about keeping 404 and 403 apart. It resolves before the scope check, because scoping at an unresolved path param turns 404 into 403; and it 404s an id that resolves to something OTHER than a change. Without the type check this door 403s an org-root Owner who passes, say, a component id — the target-set refusal fires on an object that has no targets — where it used to answer `200 []` (`listControlRunsForChange` is a plain `change_object_id = $1` filter, so a non-change id simply matched no rows). Reporting an authorization failure to the one principal with authority over everything is the opposite of the widening this increment is; a 404 is the honest answer and a better one than `200 []`.

Resolving is also a fix in its own right: the raw `idOrUrn` used to be handed straight to a uuid-typed column, so this door has never accepted the URN half of its own parameter.

### §231. M22.8 — WHICH CROSSING THIS RUN AUTHORIZED

M22.8 — WHICH CROSSING THIS RUN AUTHORIZED. Stored since M4, never projected. It became load-bearing at M22.0a, which keyed the cache on gate identity and thereby made several runs per change the NORM rather than an anomaly; until now an operator reading this list saw N rows for one control with no way to tell which one let production through.

Sent unconditionally. The columns are NOT NULL, so the wire fields' optionality is for older generated clients only (see `ControlRunSchema`), never a licence to omit them — and a `?? undefined` here would silently turn a schema-drift bug into a missing field.

### §232. The per-finding decomposition of one scan verdict

M22.9 (ADR-0033 §7) — the per-finding decomposition of ONE scan verdict.

WHY A SEPARATE PATH RATHER THAN `?includeFindings=true` ON THE LIST ABOVE. A change legitimately carries several runs since M22.0a keyed the control cache on gate identity, and each run persists up to `SCAN_FINDINGS_PERSIST_CAP` (2000) findings; folding them into the list response would either be unbounded or need a per-item cap that no cursor can page past. One run per request pages properly and leaves the list response BYTE-IDENTICAL, so the OpenAPI diff is a new operation and nothing else — this repo has already paid once for making an existing required response field optional (oasdiff ERR).

`object:read` at the RUN'S CHANGE'S TARGETS, matching the list endpoint immediately above. These rows are the decomposition of evidence that endpoint already returns in aggregate (`evidence.severityCounts`, `evidence.exclusions`), so a bar that differed from it in EITHER direction would be wrong: stricter would guard the detail while the summary stayed open, and looser — which is what leaving this at the org root while the list moved to the targets would have produced — would let a principal read every finding of a scan they cannot see the verdict of. The two are kept identical on purpose.

### §233. This "list" is always pinned to ONE change

This "list" is always pinned to ONE change (the 400 above is what makes that true), so it is scoped exactly like a get-by-id: `object:read` at ANY ONE of that change's targets. The change is resolved before the check, which is both the 404-not-403 ordering and the only way to reach the targets. (Consequence of moving the required-`changeId` 400 ahead of the authorize: a caller who is BOTH unauthorized AND omits `changeId` now learns the parameter is required before being refused. That leaks nothing about the estate.)

WHAT THE PRE-AUTHORIZATION RESOLVE DOES AND DOES NOT DISCLOSE. `changeId` is caller-supplied, so a principal with no binding anywhere can probe it — and the resolve necessarily runs first, because the targets are where the scope comes from. What it can learn is bounded by `resolveChangeForScope` answering an IDENTICAL 404 for "no such object" and for "an object, but not a change": the only bit distinguishable from outside is "this uuid names a change in my own org that I have no standing on" (403). Callers are already authenticated into that org, uuids are unguessable, and every change-scoped door in this family necessarily says the same thing — so this is the design's floor, not a leak specific to `/approvals`. Naming an arbitrary component id no longer distinguishes it from a typo.

### §234. The one door here that genuinely refused a deleted change

THE ONE DOOR IN THIS FAMILY THAT GENUINELY 404'd A SOFT-DELETED CHANGE BEFORE 2.5a, and it keeps doing so. Its pre-2.5a resolve was `getObjectByIdOrUrnAnyType`, which filters tombstones; `resolveChangeForScope` deliberately does not (four OTHER doors resolved no change at all before 2.5a, and filtering there turned their 200s into 404s — see its docblock). So the tombstone 404 belongs to this door, not to the resolver, and it is re-applied HERE — AFTER the read check, because the pre-2.5a order was authorize-then- resolve, so an unauthorized caller was refused before learning anything about the row.

### §235. Authorize at the approval request's own scope, not root

Authorize `approval:write` at the approval request's OWN scope, not org root (MAJOR #5): a service-scoped approval (`requireApprovals.scope: "service"` → the target's containing service) must be actionable by a service-scoped Approver. The coarse `approval:write` permission check and the fine-grained `hasRoleAtScope` quorum-eligibility check (approvals-repo.ts) now agree on the same scope. Loading the request here also 404s an unknown id before any write.

### §236. The federating form is a second, higher gate

M25.7 / OWNER DECISION D6 — THE FEDERATING FORM IS A SECOND, HIGHER GATE
`freeze:write` above is the permission for freezing YOUR OWN estate, and it is still required — this is ADDED, never substituted. `federation:write` is demanded on top because `federate: true` declares a freeze that BINDS ANOTHER SECURITY DOMAIN: the object rides `object_upsert` to every peer at a scope that carries it, and `governance/freeze-object.ts`'s projection rebuild makes it BLOCK there. That is categorically different from describing your own estate, and it is the exact line ADR-0022 drew for commander-authored outpost config, in the same direction.

Checked at the SCOPE OBJECT, not at the org root, so the permission's reach and the freeze's reach are the same bounded thing — the property `freeze:write` already has here and that the lift route's docblock spells out at length.

ASYMMETRIC ON PURPOSE, exactly like `assertMayDeclareDomainLocal`: only `true` is gated. An ordinary `POST /freezes` is unchanged for every existing caller.

### §237. M25.3: was an inline `endsAt <= startsAt` comparison

M25.3: was an inline `endsAt <= startsAt` comparison — a THIRD copy of the invariant `assertWindowOrdered` was extracted in M25.1 to own (its docblock says so: "a second copy of this comparison is exactly the drift `activeFreezesInWindow`'s header is about"). `createFreeze` calls it defensively a line later anyway, so the only thing the inline copy contributed was a second message that could drift from the real one.

### §238. The authoring door for the whole-wave freeze flag

M25.2 / owner decision D5 — THE AUTHORING DOOR for `freezes.atomic`. Without this line the column exists, the engine reads it, and no operator can ever set it: every freeze on the estate would be per-target with no way to say otherwise, which is the "component built, never installed" shape applied to the one mitigation D5's loosening was approved on. Absent => `false` in `createFreeze`, so an old client is unchanged.

### §239. M25.1 — LIFT AND SHORTEN

M25.1 — LIFT AND SHORTEN. The exits `/freezes` shipped without.

WHY THIS EXISTS. `/api/v1/freezes` was CREATE / LIST / GET, so a freeze could be declared and never retracted or shortened. That was survivable while a freeze parked a WHOLE wave — the operator waited for `endsAt` and the release resumed on its own. M25.2's per-target admission made it unsurvivable: a far-future `endsAt` now holds a SUBSET of a wave's targets while the siblings have already shipped, so a mistyped year leaves a fleet split across two versions with no API exit at all. The only escapes were `scp change cancel` / `scp change rollback`, both of which throw the RELEASE away rather than lifting the FREEZE.

AUTHORIZATION: `freeze:write` AT THE FREEZE'S OWN `scopeObjectId`
SCOPE FIRST, because it is the part that is easy to get silently wrong. `hasPermission` expands the checked scope UPWARD to its containment ancestors (`authz/resolve.ts`'s `scopeExpandCte`), so a binding at the org root satisfies a check at a service, and a binding at a service does NOT satisfy a check at the org root. Checking at the FREEZE'S OWN scope therefore gives exactly the property that matters: an Administrator scoped to one service can lift that service's freeze and CANNOT lift the org-root freeze that covers everyone. This mirrors `checkFreeze`, which authorizes `freeze:override` per freeze at that freeze's own scope — checking only `active[0]`, at one scope, was a shipped bug (CRITICAL #2). Checking at `auth.orgId` here would have been the same bug wearing different clothes.

AND `freeze:override` ON TOP, FOR A FREEZE YOU DID NOT DECLARE — M25.9, OWNER RULING D1
SETTLED 2026-08-25 by owner ruling (decision D1, option a-ii). This block previously read "OPEN, PENDING AN OWNER RULING"; it is now closed, and the exit taken is (b) of the three `docs/proposals/campaigns-rework.md` §1.7 offered:

```text
`freeze:override` is required to LIFT or SHORTEN a freeze YOU DID NOT DECLARE, compared on
`freezes.created_by_actor_id` against the acting subject. Retracting or shortening YOUR OWN
freeze stays `freeze:write` alone.
```

WHAT WAS WRONG WITH `freeze:write` ALONE. An override is per-CHANGE: it lets ONE change past and leaves the freeze standing for everyone else, and `drizzle/0010` grants it to Owner only. A lift is per-FREEZE: it retracts the protection for EVERYONE the freeze covers. Demanding only Administrator-tier `freeze:write` for the lift made the strictly wider-reaching verb take the strictly narrower permission — an Administrator at service S could retract an Owner's S-scoped freeze for everyone with a permission they already held, where the Owner-only override would have admitted exactly one change. Three artifacts disagreed about that: `drizzle/0010`'s comment calls `freeze:override` and `change:emergency` "the two highest-blast-radius bypass permissions (DESIGN §10.3), deliberately NOT granted to Administrator by default", DESIGN §10.3 says getting past a freeze "requires an explicit `freeze:override` permission", and this file argued the opposite from first principles. The ruling makes 0010's comment and DESIGN §10.3 AGREE with this file rather than the reverse: `freeze:override` is once again what it costs to take protection away from a freeze someone else declared, whether by bypassing it for one change or by retracting it for all of them.

AND THE DOCS WERE ACTUALLY EDITED, which is the only thing that makes the sentence above true. The point of the ruling was to stop three artifacts contradicting each other, so naming agreement without producing it would have been the same defect one layer down. What changed, and it is checkable: DESIGN §10.3's **retraction** bullet ("A freeze can be retracted") stated the rule flatly as `freeze:write` at the freeze's own scope with no mention of the override — it now carries the override clause, the actor comparison, and the shorten/extend split. BUILD_AND_TEST.md §8's **M25.1 definition of done** carried the identical superseded wording and now carries the same clause, marked as a deliberate post-ship correction of a DoD rather than a quiet rewrite. §10.3's **Override** bullet already agreed and is untouched — it is the retraction bullet, describing the exact two verbs gated here, that did not. `drizzle/0010`'s comment needs no edit: it says only that the override is not granted to Administrator by default, which is precisely what this bar now relies on.

BOTH PROPERTIES SURVIVE, WHICH IS WHY THE ACTOR IS IN THE RULE AT ALL:

```text
* A SURFACE WITH AN ENTRANCE AND NO EXIT IS THE DEFECT M25.1 EXISTS TO REMOVE. `freeze:write`
  is what declares a freeze. Requiring `freeze:override` to lift EVERY freeze would mean an
  Administrator can create a governance object they cannot retract, and would put every
  mistyped `endsAt` on the estate in front of the Owner — reproducing, one level up, exactly
  the "no way out" M25.1 closed. Your own mistake stays yours to undo, at the same permission
  that made it.
* NO ADMINISTRATOR SILENTLY UNDOING AN OWNER. Someone else's freeze is someone else's
  protection. Scope alone did not give this: `freeze:write` at S covers every freeze at S, no
  matter who declared it, so an Administrator and an Owner bound at the same service were
  indistinguishable to this route. The actor comparison is the part scope cannot express.
```

WHICH ACTS THE SECOND BAR COVERS, and this is the half that is easy to get wrong:

```text
* LIFT (this route) — retracts the protection outright. Covered.
* PATCH that SHORTENS `endsAt` — ends the protection early for everyone covered. It is the
  same act with a different record (`updateFreezeWindow`'s docblock: same effect on
  admission, and deliberately not re-labelled a lift), so gating the lift alone would leave
  the retraction one PATCH away — §1.7 exit (b)'s own caveat, "must cover PATCH-shortening
  too, or it is bypassed in one call". Covered, in the PATCH route below.
* PATCH that EXTENDS `endsAt` — ADDS protection. Nothing is taken from anyone the freeze
  covers, so it stays `freeze:write`, and extending someone else's freeze is deliberately NOT
  an override-tier act. (A federating freeze is the one case where extending IS the sharper
  direction, because it grows a block inside another security domain — that is
  `assertMayEditFederatingFreeze`'s bar, a different permission for a different reason, and
  both apply.)
* PATCH that moves `endsAt` NOWHERE (`direction === "unchanged"`) — nothing was weakened, so
  nothing extra is demanded. Re-saving a form must not require the Owner.
```

The three-way split is why the PATCH route authorizes on `direction` rather than on the verb.

NOT ESCALATABLE FROM BELOW — but the REASON changed on 2026-08-27, and the old one has expired.

This comment used to read "`role_binding:write` has no write API, so an Administrator cannot mint themselves the Owner role and clear the new bar." That was true, and it was load-bearing safety resting on an UNBUILT FEATURE — the kind of argument that expires silently the day somebody ships the obvious missing CRUD. `routes/role-bindings.ts` (role-model.md §5 step 5) ships it: there is now a `POST /api/v1/role-bindings`, and `role_binding:write` is seeded onto Administrator, Owner and OrgAdmin.

THE PROPERTY SURVIVES, ON A DIFFERENT FOOTING. That door applies the NO-ESCALATION SUBSET RULE (`docs/authz/role-binding-door.md` §2): a binding may be written only if every permission the granted role carries is one the acting subject already holds AT THAT SCOPE, computed by running `hasPermission` per member of the target role's array. `Owner` holds `freeze:override`, `change:emergency` and `campaign:deadline-override`; Administrator deliberately holds none of the three (drizzle/0010's comment says so in as many words, and this bar rests on it). So an Administrator granting themselves Owner fails the subset rule on exactly the permission this route demands, and the refusal names it.

AND THE SUBSET RULE HAS TO BOUND *BOTH* DOORS, because there were two. The paragraph above was correct about `POST /role-bindings` and incomplete about everything else: a role binding held by a GROUP resolves for every member (`authz/resolve.ts`'s `subject_expand` walks `member_of`), so until 2026-08-27 an Administrator could bind Owner to a group and then join it — and so could an ORG-ROOT OPERATOR, four rungs lower, since creating that edge needed only the `relationship:write` every org-root principal holds at every object. `docs/authz/role-binding-door.md` §2a closes it by applying the SAME subset rule at `graph/relationships-repo.ts`'s `createRelationship`, so the rule now bounds the membership door as well as the binding door, on every caller of that function — IaC apply included.

WHAT IS CHECKED, STATED WITHOUT A CLOSURE CLAIM. The previous version of this paragraph ended "the only thing that would break it now is somebody granting Administrator `freeze:override`" — and the reversed ordering of the same two requests disproved it within the day, which is the second time a comment here has closed on an exhaustiveness claim its author could not verify. So: three doors apply the subset rule — `POST /role-bindings` (§2), a `member_of` create (§2a), and a grant whose subject is a group/team (§2b, added for that reversed ordering). Pinned by `routes/rbac-role-binding-door.integration.test.ts` and, for the choke-point placement, `iac/iac-member-of-role-escalation.integration.test.ts`.

PATHS KNOWN TO BE OPEN, named here rather than implied, with the full list and the reasoning in `docs/authz/role-binding-door.md` §8:

```text
* §2a applies the subset rule and NOT bar §1, so an actor who already holds everything a
  group's bindings carry may add a THIRD party to that group without `role_binding:write`.
  That is an unauthorised DELEGATION of authority the actor already has; it cannot elevate the
  actor, and it cannot give anyone `freeze:override` the delegator does not already hold.
* A grant to a group is BLIND — §2b refuses on the membership's shape and cannot refuse on the
  members' standing, because no authority bar on that door reads the subject's identity. An
  Owner binding Owner to a team empowers whoever is in it, including a principal who put
  themselves there. That is the Owner's own grant reaching further than the Owner looked; it
  is not reachable by a principal who does not already hold `freeze:override`, so it does not
  clear THIS bar, but it is not closed either.
* `member_of` edges arriving on the FEDERATION IMPORT path are exempt from §2a by design.
```

Granting Administrator `freeze:override` would also break the property, and remains the loudest way to do it — a migration rather than an absence.

An `authorize` failure throws a raw 403 rather than returning a `blocked` verdict, and that differs from `checkFreeze` deliberately: `checkFreeze` runs inside a change's gate evaluation, where a rejected override must become a Decision so the change carries a resolvable `decision_id`. This is a direct authoring call with no change in hand and nothing to explain later — a 403 with no side effects is the honest answer, and matches `POST /freezes`.

AUDIT + DECISION ON BOTH VERBS
Each route writes ONE Decision (`kind: "freeze_window"`, `subjectId` = the freeze id) and ONE high-severity audit event carrying that Decision's id — the shape `freeze.override` already sets in `coordination/transition.ts`, and the same authoring-Decision precedent `graph/components-repo.ts` and `coordination/campaign-repo.ts` use for non-change subjects. The audit event's `reason` is the operator's own words, and the Decision's `inputContext` carries the machine-readable before/after — the audit table has no payload column, so the Decision is where "from what, to what, which direction" survives.

NO `insertDecisionIfChanged` HERE, and no dedup concern: these are one-per-API-call authoring records, not a predicate re-evaluated every tick. ADR-0024's write amplification came from the reconcile loop restating an unchanged verdict; a human pressing a button is not that.

### §240. M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO

M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO. A no-op for a non-federating freeze. Without it a commander could declare a freeze that blocks at an outpost and never retract it there: M25.1's "a surface with an entrance and no exit" defect rebuilt one boundary over, and strictly worse, because `lockFreezeRow`'s replica guard deliberately denies the outpost a local exit. The re-snapshot rides the next bundle like any other object edit.

### §241. A shortening is a retraction, and the same bar applies

M25.9 / OWNER RULING D1 — A SHORTENING IS A RETRACTION, AND THE SAME BAR APPLIES
Only `direction === "shortened"` takes protection away from the people this freeze covers; extending ADDS protection and `"unchanged"` moves nothing, and both of those stay `freeze:write`. See the lift route's docblock for the three-way split.

AFTER `updateFreezeWindow`, NOT BEFORE, AND THAT PLACEMENT IS THE WHOLE CORRECTNESS OF THIS CHECK. `direction` is the authorization INPUT here, and it is only knowable against the row that is actually in force — which is what `lockFreezeRow`'s `FOR UPDATE` inside `updateFreezeWindow` establishes, and nothing else in this handler does. The unlocked `getFreeze` above returns the pre-transaction committed value under READ COMMITTED, so a check written against `existing.endsAt` is decidable on a window that is no longer live: with the freeze at +30d, a concurrent extension in flight and this request asking for +1d, the stale read says "+1d is later than the +0.5d I read, so this is an extension" and admits it — and the UPDATE, which does take the lock, then cuts a 30-day protection to a day for an actor holding no override. That is the exact staleness `freezes-repo.ts`'s `lockFreezeRow` header describes corrupting the audit record, one consequence worse: there it makes a governance record lie, here it decides a permission.

A 403 THROWN HERE STILL HAS NO SIDE EFFECTS. `withTenantTx` is one `db.transaction`, so throwing aborts it and the UPDATE above is rolled back with the row lock — nothing is committed, no Decision, no audit event, no `syncFreezeObject` publish. The route's "an `authorize` failure throws a raw 403 with no side effects" note below still holds exactly as written. Splitting the difference — a cheap stale pre-check plus this one — was rejected on the repo's most-repeated defect: two copies of one refusal, free to disagree, where the copy that runs first is the one nobody re-reads.

### §242. `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7)

`scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7) — a dry-run of the exact same gate orchestrator the real lifecycle/wave gates use, against a change's CURRENT state. Never attempts a transition, never runs a control (host: null — read-only), never writes a Decision on its own EXCEPT one explicitly marked as a dry run, so `scp change explain` never confuses a dry-run check with a real gate verdict.

### §243. The evaluation scope, computed once and used for both

The evaluation scope, computed ONCE and used for both the permission check and the gate below — so this door authorizes at exactly the objects it is about to evaluate against, and the two cannot say different things.

NOT `assertReadableAtSomeChangeTarget`, which refuses an empty/malformed target set: this route deliberately accepts ANY object id, falling back to evaluating against the named object itself, and that fallback is the scope in that case.

THE ORG-ROOT ARM IS HERE FOR THE SAME REASON IT IS ON EVERY OTHER DOOR 2.5A RE-SCOPED, AND THIS SITE WAS EXCUSED ON A CLAIM THAT TURNED OUT TO BE FALSE. It read "an object's own scope walk reaches the org root, so the fallback is no weaker than the org-root pin it replaces". It does not always: `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a scope whose containment parents are tombstoned expands to the seed alone and matches NO binding, org-root Owner included. `targetObjectIds` here are read straight off `changeObject.properties` and never re-resolved — the same verbatim read `routes/changes.ts` documents — so a target deleted along with its service and its domain is exactly the reachable case. `authz/org-root-arm.ts` carries the full argument and is the single definition of the arm.

## `apps/server/src/routes/graph-read-scope.integration.test.ts`

### §244. GRAPH READS HONOUR object:read

GRAPH READS HONOUR object:read (role-model.md §8.6a — the enumeration bypass)
`graph:query` authorizes whether a traversal may RUN from a root; it does NOT constrain the RESULT SET, which the org-only queries returned in full. So a component-scoped principal could read its PARENT SERVICE and SIBLINGS via `/graph/traverse` / `/graph/subgraph` / a named query — the exact horizontal read `GET /objects/{type}/{id}` refuses for that same principal. routes/graph.ts now resolves the caller's `object:read` set (the SAME production door every list uses) and intersects every returned object/edge/path with it.

Fixture: service --contains--> compA, service --contains--> compB (two siblings under one service).

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| routes/graph.ts: pass `null` instead of the resolved set to `traverse` | the component-scoped traverse case FAILS — the parent service + sibling reappear in `objects` | | traverse.ts: return `{objects, edges}` before the `readableIds` intersection | same case FAILS — sibling/parent leak back | | traverse.ts subgraph: drop the both-endpoints-readable filter | the subgraph case FAILS — the service-touching `contains` edges come back |

## `apps/server/src/routes/graph.ts`

### §245. The caller's readable object-id set for graph READS

The caller's readable object-id set for graph READS. `graph:query` (authorized per-route below) decides whether a traversal may RUN from a given root; it does NOT constrain the RESULT SET, which the org-only queries otherwise returned in full — the enumeration bypass role-model.md §8.6a tracked (a component-scoped principal reading its parent service + siblings via traverse, which `GET /objects/{type}/{id}` refuses). This resolves the subject's `object:read` scope through the SAME production door every list uses (`readableScopeForListDoor`) and materializes it to a Set the query functions intersect their output with.

- `null`  → org-root reader: read everything, no post-filter (behaviour identical to before). - a Set   → the ids this subject may read; results are narrowed to it. - throws 403 → the subject holds no `object:read` anywhere (so has nothing to see).

No `?scopeObjectId=` hint is passed: a traversal can legitimately reach readable objects OUTSIDE the query root's own subtree, so the filter must be the subject's FULL readable set.

### §246. Max connections for the ISOLATED graph-query pool

Max connections for the ISOLATED graph-query pool (main.ts wires `deps.graphDb` to a pool sized by this). The traverse/named-query/subgraph/integrity handlers run RECURSIVE CTEs (depth ≤ 10, edge fan-out) whose cost is driven by GRAPH SHAPE and the caller's parameters, not by request volume — an authenticated caller can fire several expensive traversals and, on the shared request pool (pg default max 10, `connectionTimeoutMillis: 5000`), turn every OTHER tenant's ordinary request into a checkout TIMEOUT. Same isolation rationale as the SSE pools (main.ts). A small cap means a starved graph pool degrades only graph reads, never request serving or coordination. Imported by main.ts so the number and this paragraph cannot drift apart.

### §247. Induced-subgraph edges over a caller-supplied object-id set

Induced-subgraph edges over a caller-supplied object-id set. POST (not GET) because the id list can be large (up to 2000 uuids) — too long for a querystring. Read-only despite the verb; authorized identically to the named queries (`graph:query` scoped to `objectId`, the root the caller is exploring). Lets the UI render the REAL edges among a named query's result set instead of a synthesized hub-and-spoke star (routes/graph-explorer.tsx).

### §248. Rows that outlived the object they hang off

Rows that outlived the object they hang off (`graph/integrity-repo.ts` has the full rationale).

READ-ONLY, and there is deliberately NO companion repair endpoint. Repair is performed by the ordinary DELETE doors, each of which already writes its audit event and journal entry in the same transaction as the delete. A bulk-repair endpoint would be a SECOND way to destroy rows, and the cheap version of it would skip both — which is precisely the failure principle 6 exists to prevent, and which raw SQL cleanup of this same backlog would also have caused.

Authorized as `graph:query` scoped to the ORG, not to an object: the report spans the whole tenant, so there is no single root to scope it to. `graph:query` rather than `audit:read` because this is graph structure — the same class of data the named queries already return — and a caller who may traverse the graph may see which of its rows are stranded.

## `apps/server/src/routes/health.integration.test.ts`

### §249. Object health push + read

Object health push + read (observe-enrichment signal 4; ADR-0008 decision 4).

Proves the WHOLE round-trip against REAL Postgres: - an owner PUSH stores health GRAPH-NATIVELY — an object-referencing projection row keyed by objects(id) (DESIGN §4.1), NOT a bespoke top-level concept table (charter principle 2); - the store is UPSERT-IN-PLACE — a second push updates the SAME single row, no history table; - the pushed value is surfaced on the object read AND on the graph node-payload join (the exact node set the two-layer graph UI assembles: services.list + subgraph edges + the health batch); - the REAL pushed value round-trips (degraded → down), never a hardcoded/fabricated one; - RLS isolates health per org.

SCP never probes/polls/computes health — the only write path exercised here is the owner PUSH.

## `apps/server/src/routes/health.ts`

### §250. Object-health push + read

Object-health push + read (observe-enrichment signal 4; ADR-0008 decision 4).

INVARIANT (coordinate-not-execute, charter principle 1): SCP never probes/polls/computes health. The ONLY write path is the owner PUSH (`PUT …/health`); there is no active health-checking verb anywhere. The stored value is an object-referencing PROJECTION row (DESIGN §4.1), not a new top-level concept table (charter principle 2 — graph-native). The read paths surface the latest pushed value; objects with no push are absent (rendered grey/unknown, never fabricated).

## `apps/server/src/routes/instance-freezes.ts`

### §251. M25.3 — THE INSTANCE-SCOPED

M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S API SURFACE (drizzle/0086, docs/proposals/campaigns-rework.md §2, owner decision D1), API-first per charter principle 3.

THE DELIBERATE TWIN of `routes/instance-scan-floors.ts` and `routes/instance-scan-exclusion-admissions.ts` — same instance scope, same DESIGN §4.2 `org_id` exception, same two audiences and two credentials:

- **READ is tenant-facing.** Any authenticated tenant principal may see the freezes that bind them. This is not a convenience: a platform freeze is the one freeze a tenant CANNOT author and (by default) CANNOT override, so a tenant that cannot read it cannot be told why its release stopped — charter principle 6, and the reason `instance_freezes` carries a `tenant_read` RLS policy at all. The read runs inside the ordinary tenant transaction under that policy, the same path gate evaluation takes, so no request path needs the privileged connection to evaluate a gate (ADR-0016 §3). It leaks nothing across tenants because the table holds NO per-tenant rows.

- **WRITE is operator-only, and deliberately NOT an RBAC permission.** A platform freeze stops releases for EVERY org on the deployment; a tenant admin — however privileged inside their own org — must never author, extend or retract one, and the whole authority argument for the tier collapses if they can. So no role can grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN` presented as `x-scp-operator-token`, and executes over the `scp_operator` connection (`withOperatorDb`) because `scp_app` holds SELECT only on the table and has no write RLS policy in any verb (drizzle/0086 — two independent barriers). Unset token => the surface is CLOSED (403), never a fallback to a tenant credential.

```text
 `freeze:write` IS NOT ADDED AT THIS TIER AND NO ROLE, INCLUDING Owner, CAN AUTHOR AN INSTANCE
 FREEZE — verbatim the `instance-scan-floors.ts` posture. The `Permission` union is unchanged
 by this increment.
```

NO IaC, AND NO WRITE CONTROL IN THE UI — THE SAME AS ITS TWO SIBLINGS, AND THAT IS THE DECISION
M22.9's commit message states it for the admissions door and it applies here for the same reason: `scp-iac` plans and applies TENANT graph state under a tenant credential, and the UI is a tenant surface. An instance-scoped resource authored with a deployment-level secret belongs to neither — putting it in an IaC file would put a deployment secret into a tenant's plan, and a PRESSABLE WRITE button in the UI would advertise one no tenant principal can ever use. The distribution path for a multi-site operator is the same deployment tooling (Ansible/Helm) that distributes `SCP_OPERATOR_TOKEN`, PUTting the same freeze to each instance — a platform freeze does not and cannot federate (0086's header).

A READ-ONLY CARD DOES EXIST (M25.UI increment 3, `apps/web/src/routes/setup.tsx`'s "Platform freezes" card) — the rationale above is about the WRITE side only, unchanged since M25.3: READ is tenant-facing (this file's own doc, above) precisely so a tenant blocked by one is not left to guess, and a browser session is exactly where that tenant is looking. The card renders every field and points at the operator's real door (the raw route + `x-scp-operator-token`) rather than a button it cannot make work.

NO DECISION AND NO AUDIT EVENT ARE WRITTEN HERE, AND THAT IS NOT AN OVERSIGHT
`insertDecision` and `appendAuditEvent` are both `org_id NOT NULL`, and the audit chain is hash-chained PER ORG. An instance freeze belongs to no org. Attributing it to the org of whichever tenant principal happened to hold the operator token would write a false record into one tenant's chain about an act that binds all of them; fanning it across every org would forge N records for one act. The honest record is the row itself — `updated_at`, `lifted_at`, `lift_reason` — plus the block Decisions the freeze causes, which ARE org-scoped and DO name it (`inputContext.freeze.tier = "platform"`, `id`, `match`). The same is true of all three operator doors that came before this one; none writes an audit event either.

### §252. The same function the org tier calls, not a third copy

THE SAME FUNCTION the org tier's two write paths call, not a third copy of the comparison — `assertWindowOrdered`'s docblock is explicit that a second copy is the drift `activeFreezesInWindow`'s header is about. A row with `ends_at <= starts_at` reads as permanently inactive to the half-open window predicate with nobody having lifted it, and 0086's `instance_freezes_window_ck` is the second barrier behind this one.

### §253. ON CONFLICT (key)

ON CONFLICT (key) — the key is the addressing identity, and the `id` is deliberately NOT updated on conflict: a Decision recorded weeks ago names that id and must keep naming the row still in force.

`WHERE instance_freezes.lifted_at IS NULL` MAKES A LIFT FINAL, race-free, without a read-then-write check — exactly `liftFreeze`'s idiom one tier down and for the same ruling: a retraction is final and a new freeze is one PUT away. Resurrecting a lifted key would leave the rows that cite its id describing a freeze whose window, reason and match have all silently changed underneath them.

### §254. A SOFT retraction (drizzle/0086), 0085's ruling one tier up

A SOFT retraction (drizzle/0086), 0085's ruling one tier up: the row stays and stays readable through `GET /v1/instance/freezes` forever, because the gate's block Decision and the hold Decision both carry this id in `inputContext` permanently and a hard DELETE would make `scp change explain` name an id that resolves to nothing.

The conditional `WHERE lifted_at IS NULL` makes a second lift a race-free REFUSAL rather than a read-then-write check: `lifted_at`/`lift_reason` are a single record of when this was retracted and why, and letting a repeat caller overwrite them would replace the reason that was actually given.

## `apps/server/src/routes/instance-scan-exclusion-admissions.ts`

### §255. M22.9 — THE INSTANCE-SCOPED EXCLUSION ADMISSIONS' API SURFACE

M22.9 — THE INSTANCE-SCOPED EXCLUSION ADMISSIONS' API SURFACE (ADR-0033 §1, §7a), API-first per charter principle 3 (API -> SDK -> CLI).

WHY THIS ROUTE IS NOT A CONVENIENCE. ADR-0033 §1's admission algebra is a monotone AND *down the tier chain*, and `buildScanExclusionTargetInputs` seeds every target's `representedTiers` with `platform` and `trust_domain` UNCONDITIONALLY. `tierForObjectType` structurally cannot return either rung (it maps graph object types, and `containmentChain` is org-rooted), so NO policy at any tier can contribute those two admissions. Their only source is `scan_exclusion_admissions` (drizzle/0074). Until this route existed that table had no writer outside the integration suite's admin pool — so on a real deployment every clause an operator authored failed the AND at the top rung and M22.2 through M22.7 were inert, invisibly, with a green suite. The feature's mandatory precondition was reachable only by hand-written SQL against the database.

THE FIVE ORG-AND-BELOW RUNGS GET NOTHING HERE, and that is the correct answer rather than a gap. `org`, `containment_domain`, `service`, `assembly` and `component` admit a class through the ALREADY-SHIPPED `scanExclusion` policy effect — `{"scanExclusion": {"admit": ["vendor_latest"]}}` on an ordinary policy document, written over the ordinary policy door, validated by 0074's `property_schema` and gathered per target by `buildScanExclusionTargetInputs`'s policy loop. That surface is live and covered. A second admission surface for those tiers would be a second construction of one rule (charter principle 2: new concepts arrive as policy data).

THE DELIBERATE TWIN OF `routes/instance-scan-floors.ts` — same instance scope, same DESIGN §4.2 `org_id` exception, same two audiences and two credentials:

- **READ is tenant-facing.** Any authenticated tenant principal may see which classes this deployment admits, because a loosening they cannot author and cannot inspect is not explainable (charter principle 6) — and the shipped default (nothing admitted, every clause inert) is exactly the state that is invisible without a read. The read runs inside the ordinary tenant transaction under the table's tenant-read RLS policy, the same path `readInstanceScanExclusionAdmissions` takes at the gate, so no request path needs the privileged connection to evaluate a gate (ADR-0016 §3). It leaks nothing across tenants because the table holds NO per-tenant rows at all.

- **WRITE is operator-only, and deliberately NOT an RBAC permission.** An admission opens a loosening for EVERY org on the deployment; a tenant admin — however privileged inside their own org — must never author one, and D3's whole authority argument collapses if they can. So no role can grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN` (config.operatorToken) presented as `x-scp-operator-token`, and executes over the `scp_operator` connection (`withOperatorDb`) because `scp_app` holds no write grant on the table and no write RLS policy existed for it at all (drizzle/0074 — two independent barriers; 0076 adds the operator role as the one principal both barriers admit). Unset token => the surface is CLOSED (403), never a fallback to a tenant credential.

```text
 THIS PARAGRAPH USED TO SAY "executes over the ADMIN connection", AND THAT WAS FALSE ON THE
 DEPLOYMENT SHAPE IT MATTERED ON. api/worker pods hold no admin connection (the chart gives
 `DATABASE_URL` to the migrations Job alone), so `config.databaseUrl` resolved to the
 `localhost:5432` fallback and the write dialed 127.0.0.1 inside its own pod. And the admin
 connection would not have sufficed anyway on a non-superuser admin: 0074 grants no write to
 anyone. `routes/operator-db.ts` carries the full account.
```

THE PUT IS A WHOLE-SET REPLACE for one `(tier, origin)`, not an add. An additive verb makes WITHDRAWAL the harder operation, and this is a loosening: an operator who believes they have narrowed the admitted set, but whose request only ever added, would leave the loosening in force with no error anywhere. `{"classes": []}` is therefore the revocation, which is why there is no DELETE verb — a second verb meaning "replace with nothing" would be a second way to say one thing.

## `apps/server/src/routes/instance-scan-floors.ts`

### §256. M17.5 — the INSTANCE-SCOPED scan-requirement floors' API surface

M17.5 — the INSTANCE-SCOPED scan-requirement floors' API surface (ADR-0016 §3), API-first per charter principle 3 (API -> SDK -> CLI).

TWO DIFFERENT AUDIENCES, TWO DIFFERENT CREDENTIALS — this is the whole point of the resource:

- **READ is tenant-facing.** Any authenticated tenant principal may see the floors that bind them, because a gate they cannot inspect is not explainable (charter principle 6). The read runs inside the ordinary tenant transaction under the table's tenant-read RLS policy — the same path gate evaluation uses, so no request path needs the privileged connection to evaluate a gate (ADR-0016 §3). It leaks nothing across tenants because the table holds NO per-tenant rows at all: it is instance-wide configuration, identical for every org on the deployment.

- **WRITE is operator-only, and deliberately NOT an RBAC permission.** These floors bind EVERY org on the deployment; a tenant admin — however privileged inside their own org — must never author or loosen them. So no role can grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN` (config.operatorToken), presented as `x-scp-operator-token`, and executes over the `scp_operator` connection (`withOperatorDb`) because the request-serving `scp_app` role holds no write grant on the table and no write RLS policy existed for it at all (drizzle/0029 — two independent barriers; 0076 adds the operator role as the one principal both barriers admit). Unset token ⇒ the surface is CLOSED (403), never a fallback to a tenant credential.

The write path opening a short-lived PRIVILEGED connection is the deliberate asymmetry ADR-0016 §3 settles on: rejected option (b) was routing tenant-request READS through it (every read path would then hand-guarantee what RLS guarantees structurally). Operator WRITES are a different thing entirely — they are not tenant requests, they happen rarely (configuration, not traffic), and they are exactly what "operator-write" means.

THIS DOC USED TO SAY "the ADMIN connection", AND SO DID THE CODE, AND BOTH WERE WRONG WHERE IT COUNTED: api/worker pods hold no admin credential (the chart gives `DATABASE_URL` to the migrations Job alone), so the write dialed `config.databaseUrl`'s `localhost:5432` fallback inside its own pod and 500'd on ECONNREFUSED. `routes/operator-db.ts` carries the full account.

## `apps/server/src/routes/list-door-scope.integration.test.ts`

### §257. The list doors filter rows instead of refusing the page

STEP 2.5b — THE LIST DOORS FILTER ROWS INSTEAD OF REFUSING THE PAGE (`/placements`, `/campaigns`)

THE GUARANTEE UNDER TEST, in one sentence: *a principal bound below the org root lists exactly the placements and campaigns their binding reaches — while every request that worked against the org-root pin still works, byte for byte, and a principal with no allow binding anywhere still gets the same 403.*

## Why these cases are at the DOOR and not at the filter

`authz/readable-scope.integration.test.ts` already proves the downward walk itself, including §8.3's inverse invariant (`hasPermission(o)` iff `o ∈ readableSet`) over every live object of a four-route fixture. What it cannot prove is that anything CALLS it. Until this file existed the filter had exactly one caller — that test — which is this repo's dominant failure mode: built, tested, wired nowhere. So every case below goes through `app.inject` at the real URL, and the mutation log records the filter being deleted from each repo and the named case going red.

## Why the page is filtered in SQL and not in the handler

role-model.md §8.2, measured: both repos are keyset-paginated with `.limit(limit + 1)` and take `nextCursor` from the last row SELECTED, so a handler-side filter shrinks the page after the LIMIT — one readable row on page 1 and zero on pages 6 through 185, each advertising more. These fixtures are far too small to show that, which is exactly why it must not be re-litigated per door: the shape is settled, and what this file pins is that the condition reaches `conditions`.

## The `?scopeObjectId=` cases carry three separate traps

1. **404 must not become 403.** `scopeExpandCte` seeds its walk with the raw uuid and never checks existence, so authorizing at an unresolved query parameter refuses everybody, org-root Owner included (§8.7). 2. **The hint must be resolved AFTER the gate.** Resolving first would let a caller who holds nothing distinguish "id exists" (403 at the hint) from "id does not" (404) — the pre-authorization existence oracle `resolveCampaignForScope` was written to close. 3. **The hint may only ever NARROW.** It is authorized before it is used, so its rows are always a subset of the caller's own.

MUTATIONS RUN (2026-08-26). Baseline: 18 passed. MEASURED, not predicted — messages verbatim.
THE FILTER — deleted from each repo in turn, which is the "built, never installed" check: if the condition never reaches `conditions`, these cases must go red.

M-1  `graph/placements-repo.ts`: the `conditions.push(sql`${objects.id} IN …`)` line deleted => 8 FAILED. "a SERVICE-bound reader lists only the placements and campaigns in their own subtree": `expected Set{ …(3) } to deeply equal Set{ '…' }` — all three placements came back. "the list agrees with get-by-id, object by object" also failed, and its message is the one worth reading: `get-by-id said 403 for <id>; the list said true` — §8.3's disagreement, caught as data rather than as a status code. M-2  `coordination/campaign-repo.ts`: the same line deleted => 5 FAILED, incl. "a COMPONENT- bound reader … and no campaigns at all": `expected Set{ …(3) } to deeply equal Set{}`.

THE HINT — `authz/list-door-scope.ts`:

M-3  the authorization at the resolved hint disabled (`if (false && !atHint)`) => "?scopeObjectId= 403s when the caller lacks authority AT THE HINT" FAILED, `expected 200 to be 403`, the body carrying `comp-b1…@target…` — i.e. the hint had become a WIDENING, handing a `serviceA`-bound reader the rows under `serviceB`. "a hint pointing at a live object OUTSIDE the caller's reach never leaks its rows" failed with it. M-6  the gate skipped whenever a hint is present (`if (!atOrgRoot && scopeObjectRef === undefined)`) — VERBATIM the first draft of this module, which authorized at the hint and never consulted the subject's own roots => "the GATE runs BEFORE the hint is resolved — no pre-authorization existence oracle" FAILED: the stranger's refusal became `lacks 'object:read' at the org root and at scope '<serviceA>'` instead of the org-root wording, so a real id and a ghost id answer differently. This case was written before the module and it caught the defect on the first run.

THE GATE — `authz/list-door-scope.ts`, the half that must NOT widen:

M-7  the `allowRoots.length === 0` refusal deleted => "a subject with NO allow binding anywhere still gets today's 403, worded identically" FAILED: `{"items":[],"nextCursor":null}: expected 200 to be 403`. An empty page instead of a refusal — the widening §8.2 step 5 forbids. M-4  the `unhintedFilter === null` refusal deleted => "an allow AND a deny at the ORG ROOT is a 403, never the whole org" FAILED: `expected 200 to be 403`, body listing ALL THREE placements. This is the sharpest one. `readableObjectFilterSql` short-circuits an org-root ALLOW to `null` = NO FILTER without consulting the deny set, so a subject the org root explicitly DENIES has an allow root of `orgId` and would be handed the entire org. M-5  the subject's deny roots replaced with `[]` in the un-hinted filter => "a DENY below an allow subtracts its subtree from the page, and only its subtree" FAILED: `expected Set{ …(2) } to deeply equal Set{ '<placeC1>' }` — the denied subtree reappeared, a deny failing OPEN on the list while still refusing on get-by-id.

## `apps/server/src/routes/list-readable-scope.integration.test.ts`

### §258. LIST DOORS, ROW-SCOPED

LIST DOORS, ROW-SCOPED — the behavioural gate for role-model.md §8.2 steps 4 + 5 (increment 2.5b)

Before this increment every list door ran ONE check pinned at the org root and then returned every row in the org. `scopeExpandCte` expands UPWARD only and expanding from the org root produces a single row, so that check is satisfiable by an org-root binding AND BY NOTHING ELSE: a ServiceAdmin holding `object:read` over their own service could not list components at all. Not a short list — a 403.

`graph/objects-repo.ts`'s `listObjects` now takes a row filter and pushes it into `conditions`, and its FOUR callers thread it from `authz/list-scope.ts`'s two-arm gate. Four call sites, but ~23 wire routes, because one of them is the typed-registry factory. **This file exercises all four through the real HTTP API**, because "built and tested but wired nowhere" is this repo's dominant failure mode and a repo-level test would not have caught a caller left un-threaded:

| door | file | how this file reaches it |
```text
| `GET /api/v1/components`      | `routes/components.ts`       | `client.components.list()` |
| `GET /api/v1/objects/{type}`  | `routes/objects-generic.ts`  | `client.object("component").list()` |
| `GET /api/v1/services` (+ ~9 more registries) | `routes/typed-registries.ts` | `client.services.list()` |
| `GET /api/v1/objects/service` | `services/objects-service.ts` | `client.objects.service.list()` |
```

The last one is the door a `routes/*.ts` string census cannot see at all (§8.1): `routes/objects.ts` has zero `authorize(` calls, and Fastify prefers its literal `/objects/service` over the parametric `/objects/:type`, so it is the ONLY handler that ever runs for that path.

WHY THE PAGINATION CASE IS THE POINT, NOT AN EXTRA
§8.2 disqualified per-row post-filtering on pagination, not on cost. Every list repo is keyset-paginated with `.limit(query.limit + 1)` and derives `nextCursor` from the last row it SELECTED, so a filter applied to the returned page is applied after the LIMIT. Measured on a 20,910-object estate: an assembly-bound principal's 5 readable components sit at cursor ranks 97/140/254/339/440 of 18,500 — one readable row on page 1, and ZERO on pages 6 through 185, each carrying a valid `nextCursor` — while 27 of 30 `apps/web` list call sites fetch exactly one page.

So "the subject sees only their subtree" is NOT sufficient evidence: a post-filter passes that assertion on a single small page and fails in production. `readable rows paginate exactly` below is the case that separates the two — 25 readable components interleaved with 5 unreadable ones at `limit=10`, asserting every page is FULL, that no page is empty-with-a-cursor, and that the walk terminates having seen each readable row exactly once.

MUTATION LOG — each applied alone, measured, reverted
(filled in below the fixture, beside the test each one kills)

FIXTURE
```text
orgRoot
├── domainA
│   ├── serviceMine    ← the scoped principal's ONLY binding
│   │   └── mine-00 … mine-24        (25 readable components)
│   └── serviceNext
│       └── next-00 … next-04        (5 components, interleaved in creation order)
└── domainB
    └── serviceFar
        └── far-00                   (1 component, the non-leakage arm)
```

Built through the real API. The components are created round-robin so the readable and unreadable rows INTERLEAVE in `created_at` order — the keyset order the cursor walks. A test that created all 25 readable rows first would page correctly even with a post-filter, which is exactly the vacuous-test shape (CLAUDE.md: mutation-prove every guard).

### §259. Mutation-proven: deleting that condition fails this

MUTATION-PROVEN. Deleting the `conditions.push` in `graph/objects-repo.ts`'s `listObjects` (i.e. accepting `readableFilter` and ignoring it — the "built, never installed" shape) fails this test with:

AssertionError: expected [ …(31) ] to deeply equal [ …(25) ]

— the scoped Viewer receives all 31 components, including `serviceFar`'s in a domain they hold nothing in.

### §260. THE CASE §8.2's measurement is about

THE CASE §8.2's measurement is about. 25 readable rows interleaved with 6 unreadable ones at `limit=10`: a correct query-side filter returns 10 + 10 + 5 and stops; a post-filter returns short pages that still carry a cursor.

MUTATION-PROVEN twice over. With the `conditions.push` deleted this fails on the ROW SET (31 ids, not 25). Simulating the disqualified design instead — leaving the filter out of the query and filtering `page.items` in the handler — fails on the CONTRACT assertion inside `walkAllPages`: `page 1 returned 8 of 10 rows but still carries a nextCursor`.

### §261. That claim is about the code, so it is checked as code

"The org-root principal's query is byte-identical to today's" is a claim about the STATEMENT, so it is measured on the statement rather than inferred from the rows (CLAUDE.md: a claim about a tool cannot be verified with that tool; a claim about SQL should not be verified only through its result set, which would still pass if a redundant always-true condition were added).

Two measurements: 1. the gate hands back exactly `null` for an org-root holder — the value `listObjects` documents as "add nothing at all"; 2. the SQL drizzle actually emits for `readableFilter = null` carries no extra predicate and no extra bound parameter, and the SQL emitted for a real filter provably differs — so the first measurement is not vacuous.

The logging drizzle instance is built here over its own pool rather than by changing `db/client.ts`: the production factory takes no logger, and adding one for a test would change the thing being measured.

### §262. Mutation-proven: replacing that branch fails this

MUTATION-PROVEN. Replacing `authz/list-scope.ts`'s `if (allowRoots.length === 0) return refuseAsToday(...)` with a fall-through fails this with a 200 and an empty page: the subject lands on `readableObjectFilterSql`'s match-nothing set instead of a 403, which reads to an operator as "you have no components" rather than "you have no access".

### §263. The short-circuit trap, and why the arm refuses a null

THE SHORT-CIRCUIT TRAP, and the reason arm 2 refuses a `null` instead of returning it.

`readableObjectFilterSql` returns `null` — NO FILTER — whenever the allow roots contain the org id. This subject HAS an org-root allow, so that short-circuit fires; they also have an org-root deny, which is the only thing that can make the org-root arm refuse. Handing the short-circuit back would list the entire org to precisely the subject the org root denies.

MUTATION-PROVEN. Replacing `if (filter === null) return refuseAsToday(...)` with `if (filter === null) return filter` fails this with:

AssertionError: promise resolved "{ items: [ …(31) ], … }" instead of rejecting

— a deny that fails OPEN across every list door in the tree.

### §264. The scoped principal's reach excludes objects above them

The scoped principal's reach must not include the objects ABOVE their binding: `contains` is registered service -> component and the walk follows it backwards, so a binding at a service reaches its components and never its domain. Asserted on a door rather than on the walk, because `authz/readable-scope.integration.test.ts` already pins the walk and this pins that the DOOR uses it.

## `apps/server/src/routes/objects-generic.ts`

### §265. The message names the typed door per type, not one route

THE MESSAGE NAMES THE TYPED DOOR PER TYPE, NOT `/policies` FOR EVERYTHING. The set is now four ids across three subsystems (`policy`/`control`, `scan_override_grant`, and M25.7's `freeze`) and a fixed sentence pointing every one of them at `/api/v1/policies` sends an operator who typed `POST /objects/freeze` to a route that will 404 them — a refusal that misroutes is barely better than no refusal. The permission sentence stays type-agnostic because the gate genuinely is.

### §266. Governance-owned object types

Governance-owned object types (`policy`, `control`) are refused here entirely — mirrors `assertNotSystemManagedRelationship` (routes/relationships.ts) blocking `approves` edges from the generic `/relationships` endpoint. Without this, the generic `/objects/{type}` endpoints created/updated the SAME `policy`/`control` graph objects the typed `/policies`/`/controls` routes do (routes/typed-registries.ts), but checked only generic `object:write` — skipping both the `policy:write` permission gate AND `assertPolicyScopeWithinAuthority`'s binding of a policy's DECLARED scope to the author's own authority (CRITICAL #1b). That gap let a component-scoped Administrator publish an org-wide policy through this endpoint, and let ANY actor holding bare `object:write` (e.g. an Operator with zero `policy:write` anywhere) create an org-wide `required` policy demanding an unreachable approval quorum — a live governance-bypass DoS. Checked before the transaction even opens: no DB round trip is needed to reject a request this endpoint will never legitimately serve.

### §267. A new authority-scoped object type needs its own door

M5 (BUILD_AND_TEST.md §8 M5 security note — "if a new authority-scoped object type is introduced, it needs the governance-managed-types treatment"): `campaign` binds its DECLARED `properties.targets` to the actor's own authority (`coordination/campaign-scope-authz.ts`), exactly the same class of risk `policy.properties.scope` has — so it gets the exact same generic-endpoint block, forcing every caller through `POST /campaigns` (`coordination/campaign-repo.ts`'s `proposeCampaign`), which performs that check per target. A SEPARATE set from `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` on purpose: campaign writes still only need plain `object:write`, never `policy:write` — this is a distinct authority model, not the governance subsystem's.

### §268. M12 P5a (docs/proposals/organize-after.md)

M12 P5a (docs/proposals/organize-after.md): `component` binds its MEMBERSHIP — a directly-created component must belong to a service. That invariant can only be enforced by a create path that takes the service inline and writes the `contains` edge atomically, so `component` is refused on the generic route (all write verbs), forcing creates through the strict `POST /components` (`graph/components-repo.ts`'s `createComponentInService`).

A SEPARATE set from `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS` ON PURPOSE — that set's meaning is target-AUTHORITY binding; a component's reason is service-MEMBERSHIP. Conflating them would be exactly the kind of comment-that-lies this codebase already has too many of. The true IMPORT paths (discovery/accept, federation-journal replay) call `createObject` directly and never touch a create ROUTE, so they stay permissive by construction — the owner ruling. The `SERVICE_MEMBER_OBJECT_TYPE_IDS` set now lives in `graph/service-member-types.ts` so this guard and the federation OVERLAY route (`federation/overlay-repo.ts`) — a user-facing create surface, NOT an import path — agree (owner ruling 2026-07-16: overlay refuses component too).

### §269. The outpost type carries commander-authored config

M16.2 phase A (E1): the `outpost` type carries COMMANDER-AUTHORED federation config, so its writes are gated on `federation:write`, not plain `object:write`. This endpoint checks only the latter — the same permission-mismatch shape that let a bare-`object:write` actor publish governance objects through here (see `assertNotGovernanceManagedObjectType`) — so the type is refused outright and callers go through `/api/v1/federation/outposts`.

The 1:1 peer BINDING is NOT enforced by this refusal: it is enforced inside `graph/objects-repo.ts` for every local write door at once (`federation/outpost-binding.ts` explains why one choke point rather than N route guards). This block is purely about the permission gate.

### §270. A placement's identity is a pair of other objects

ADR-0026 D2/D3 (owner decision D17): a `placement`'s identity IS a pair of other objects, so it cannot be created through a door that takes free-form `properties`. This route would store two UUIDs without resolving them, without checking they name a `component` and a `deployment-target`, and — decisively — without writing the two derived edges that make the pair traversable, leaving an island invisible to every impact query. Refused outright; callers go through `/api/v1/placements`. See `graph/pair-bound-types.ts` for why this is a separate set from the service-membership one rather than a merged "special types" list.

### §271. Generic `/objects/{type}` endpoints over the full graph model

Generic `/objects/{type}` endpoints over the full graph model (DESIGN.md §4.1, §6) — works for ANY registered object type, built-in or org-defined via the type registry, with no special casing (BUILD_AND_TEST.md §8 M1 DoD (b)) EXCEPT the governance-owned `policy`/`control` types, which every write verb below refuses outright (`assertNotGovernanceManagedObjectType` — security fast-follow after PR #9). `PUT .../{urn}` is the idempotent upsert-by-URN path; every `POST` accepts `Idempotency-Key` for replay-safe retries.

Scope decision (documented): list operations check `object:read` at the org-root scope (listing spans arbitrary containment, so a single finer-grained scope isn't meaningful without per-row ReBAC filtering — an M2+ concern); every other operation checks at the specific object's own scope (existing objects) or its resolved containing domain (new objects), so `authz/resolve.ts`'s containment walk is exercised precisely.

### §272. ONE check object for BOTH the gate and the row filter

ONE check object for BOTH the gate and the row filter (role-model.md §8.2 steps 4+5), so the permission the door authorizes with and the permission the filter is computed from cannot be edited apart. The org-root scope is unchanged and is still tried first; what is new is that failing it now falls through to the subject's own scopes instead of 403-ing a ServiceAdmin who can read every row they asked for.

### §273. M20.4 (ADR-0031 §6) — publish a domain-local object

M20.4 (ADR-0031 §6) — publish a domain-local object.

A VERB, not a `PATCH` of `domainLocal`, and the distinction is deliberate: this re-journals the object's current full state and sweeps its edges, so it is an action with an effect rather than a field edit that quietly emits a stream of entries. `PATCH` still cannot express locality at all, which is what keeps the column immutable everywhere except here.

ONE-WAY. There is no un-publish route and there will not be one — federation has no un-send.

### §274. ADDED, NEVER SUBSTITUTED

ADDED, NEVER SUBSTITUTED — `object:write` is a SECOND bar in front of the federation one below, which is unchanged. Publish is still a federation act; it is now also an estate write, because it is one.

THE ASYMMETRY IS THE ARGUMENT. DECLARING locality (`POST /objects/{type}` above, and the five sibling doors `assertMayDeclareDomainLocal` guards) requires BOTH `object:write` and `federation:write` — ADR-0031 §1's split: `object:write` is the permission for describing your estate, `federation:write` is the permission for deciding what crosses a security boundary. Publish is the INVERSE verb of that same decision and until now cost strictly less than making it: `federation:write` alone. That is backwards. `publishDomainLocalObject` does not merely flip a federation flag — it `UPDATE`s the estate row (clearing `domain_local` and its inherited-from provenance), BUMPS `version`, writes an audit event, and sweeps the object plus its edges onto the journal. A subject holding `federation:write` and no `object:write` — the FederationAdmin shape, "operates the link, does not edit the estate" (`federation/handfill-repo.ts`) — was mutating and re-versioning estate rows here.

WHY A REFUSAL IS SAFE AT THIS DOOR, unlike the import path. This is a local operator's per-request POST and its failure mode is one 403 to the caller who typed it. The federation IMPORT path deliberately carries carve-outs instead of bars, because a throw there wedges a peer's whole signed bundle and `inbox-loop.ts` re-fetches it forever. Nothing here can absorb a refusal on someone else's behalf.

Scoped to the object itself for both bars, like every other operation on an existing object in this router; `authz/resolve.ts`'s `scope_expand` walks upward only, so an org-root or ancestor grant already satisfies a check here.

### §275. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7). Tombstoning the principal that holds the org's last administrative binding — or the team that holds it — is refused with 409 from `graph/objects-repo.ts`'s `deleteObject`, a CHOKE POINT this route inherits. An added response code is additive under the oasdiff gate: `deleteObject` previously declared 200/401/403/404.

## `apps/server/src/routes/objects-service-shadowing.integration.test.ts`

### §276. ROUTE SHADOWING vs THE DECLARED CONTRACT

ROUTE SHADOWING vs THE DECLARED CONTRACT (ADR-0023's first catch).

Fastify prefers a literal static route over a parametric one, so `POST/GET /api/v1/objects/service` — the M0 route — is the ONLY handler that ever runs for that exact path. The SDK, meanwhile, has no idea: `client.object(type)` calls the GENERIC `createObject`/`listObjects` operations for every type including `service`. The generic operation's declared response is a full `GraphObject`, so the shadowing handler is bound by the shadowED operation's contract whether or not anyone remembers it exists.

It was not remembered: until ADR-0023 the M0 handler returned five fields, and `client.object("service").create({...}).urn` was `undefined` at runtime while TypeScript insisted it was a `string`. SDK response validation caught it on its first CI run.

This file locks both halves: 1. STRUCTURAL — the set of shadowed (parametric, literal) path pairs in the emitted spec is exactly the one known pair. A new shadowing route added later fails here, with the pair named, instead of quietly inheriting a contract nobody checked. 2. BEHAVIOURAL — driven through the real SDK, which runs the generic operation's response validator against the shadowing handler's actual bytes.

## `apps/server/src/routes/objects.ts`

### §277. The service routes, plus the org path-override form

`POST/GET /api/v1/objects/service` plus the `orgs/{org}` path-override form (DESIGN.md §6), registered from day 1. Backed by the M0 minimal `objects` table — superseded by the generic `/objects/{type}` endpoint over the full graph model in M1.

## `apps/server/src/routes/oidc.ts`

### §278. Generic OIDC login (M2 step 2 Part B, DESIGN.md §7)

Generic OIDC login (M2 step 2 Part B, DESIGN.md §7) — `GET /login` redirects to the IdP, `GET /callback` completes the exchange, JIT-provisions the user, and sets the same session cookie `routes/auth.ts` sets for local-auth. Like `routes/events.ts` (SSE), these are plain browser-redirect routes, not JSON request/response pairs the Zod/OpenAPI contract pipeline models — the success response is a 302 with no body, not a schema-typed payload.

SECURITY: never logs the authorization code, PKCE code_verifier, or any token — see auth/oidc.ts's module doc.

### §279. IdP GROUP SYNC + the login audit event, in ONE transaction

IdP GROUP SYNC + the login audit event, in ONE transaction (`auth/identity-sync.ts`).

TOGETHER ON PURPOSE: a sync that commits without its audit event leaves authority changing with no record, and an audit event that commits without the sync claims a login reconciled membership it did not. Charter principle 6 asks for the audit write to share the action's transaction; this is that rule applied to a login.

AFTER the session is created and BEFORE the cookie is set, so a sync failure — an overage token, most importantly — surfaces as a failed login rather than as a signed-in user whose authority silently did not update.

## `apps/server/src/routes/operator-credentials.ts`

### §280. The instance operator-credential routes

`/api/v1/instance/operator-credentials` — role-model.md §5 step 9 / §3B

The management surface for the credential that replaces `SCP_OPERATOR_TOKEN`.

GATED BY AN OPERATOR CREDENTIAL, NOT BY RBAC — and it must be, because these rows open every instance-tier write door on the deployment. Any RBAC gating would put a tenant permission in front of authority that binds the tenant's neighbours, which is the exact inversion the whole instance tier exists to prevent (role-model.md §1.5: there is no authority tier above an org, so this cannot be modelled as one).

WHICH MAKES IT SELF-REFERENTIAL, DELIBERATELY: minting a credential requires already holding one. The bootstrap `SCP_OPERATOR_TOKEN` is what resolves the regress — set it once, mint a real credential, unset it. `GET` reports `callerMechanism` so an operator can SEE whether the deployment is still on that bootstrap path, because otherwise the migration away from the env token is invisible: minting credentials while leaving the env var set looks identical to having finished.

`requireAuth` RUNS TOO, on every operation. The operator credential is the AUTHORITY; the authenticated principal is the ATTRIBUTION. Both matter and neither substitutes for the other — that split is what the shared env token could not express, since one secret made every operator indistinguishable from every other.

### §281. Revoking your own credential is allowed, with no floor

REVOKING YOUR OWN CREDENTIAL IS ALLOWED, and there is no last-credential floor here — the deliberate opposite of the administrative floor on role bindings (`docs/authz/role-binding-door.md` §7). The difference is recoverability: an org that revokes its last Owner binding has NO way back through the API, whereas a deployment that revokes its last operator credential is recovered by setting SCP_OPERATOR_TOKEN and restarting — an action the operator of a self-hosted instance can always take, because they own the process. A floor here would block the legitimate "revoke everything, we suspect compromise" without protecting against anything unrecoverable.

## `apps/server/src/routes/operator-db.test.ts`

### §282. THE OPERATOR WRITE DOORS' CREDENTIAL, AT THE UNIT LAYER M22.9 R3

THE OPERATOR WRITE DOORS' CREDENTIAL, AT THE UNIT LAYER
M22.9 R3. The defect this file guards was invisible to the integration suite BY CONSTRUCTION, so a unit test is not belt-and-braces here — it is the only layer that can see it at all.

`buildTestServer` passes `DATABASE_URL: testDatabaseUrl()`, the Testcontainers SUPERUSER. A superuser bypasses table grants and RLS unconditionally, and it is reachable, so the integration suite exercised the four operator PUTs over a connection no production pod has and a privilege level no production role has. Both halves of the real failure — no `DATABASE_URL` in an api pod, and no write grant/policy for anyone but a superuser — were outside what those tests could observe. They still are; that is why the derivation is asserted here instead.

WHAT IS *NOT* COVERED HERE, deliberately. The success path (connect, write, read back) needs a real Postgres and belongs to the integration layer, which already runs it. What cannot be asserted at either layer today is that `scp_operator` ITSELF can write — the integration suite connects as the superuser, so drizzle/0076's grants and write RLS policies are exercised by no automated test in this tree. Named rather than implied; see this change's report.

### §283. Loopback port 1

Loopback port 1: nothing listens, ECONNREFUSED arrives immediately, no network leaves the machine (CLAUDE.md: tests never touch the internet). This is the shape an operator hits when the URL is wrong OR when `scp_operator` is still NOLOGIN — drizzle/0076 fixes the role's privilege shape and deliberately leaves LOGIN + password to out-of-band provisioning, so "role exists but cannot authenticate" is a state real deployments pass through.

## `apps/server/src/routes/operator-db.ts`

### §284. The one connection every instance-operator door opens

M22.9 R3 — THE ONE CONNECTION EVERY INSTANCE-OPERATOR WRITE DOOR OPENS.

Four routes author instance-scoped config that binds every org on the deployment — `instance-scan-exclusion-admissions.ts` (ADR-0033), `instance-scan-floors.ts` (ADR-0016), `scanner-assignments.ts` and `scan-db.ts` (ADR-0020) — and all four opened `new pg.Pool({ connectionString: deps.config.databaseUrl })` inline. That was wrong in the same way in all four places, so it is fixed here once rather than four times.

WHAT WAS WRONG. `config.databaseUrl` is the admin/bootstrap connection, and the hardened Helm shape does not give it to the api/worker pods at all (`commanderscp.adminDbEnv` is included by `migrations-job.yaml` and nothing else — M8: only the migrations Job holds admin credentials). With `DATABASE_URL` unset, `loadConfig` falls back to its `postgres://scp:scp@localhost:5432/scp` literal, so each handler dialed 127.0.0.1 INSIDE its own pod and returned a bare 500 on ECONNREFUSED. Behind that sat a second, independent refusal: `scp_app` holds SELECT only on all four tables, which are `FORCE ROW LEVEL SECURITY` with a `FOR SELECT` policy and no write policy for anyone (drizzle/0029, 0035, 0036, 0074). The integration suite never saw either layer because its `DATABASE_URL` is the Testcontainers SUPERUSER, which bypasses grants and RLS outright.

WHY THE FAILURES BELOW ARE 503 AND NOT 500. A 500 says "this request hit a bug"; every operator who met this one met it as an opaque one. These two are deployment facts — a credential this instance was never given, or a role whose password was never provisioned — and the operator reading the response is exactly the person who can fix them, so the response names the env var, the role, and the SQL. Nothing here is retryable by the caller, but a 503 is honest about the instance being unable to serve the surface rather than about the request being malformed.

ONLY THE CONNECT PHASE IS TRANSLATED. Everything the callback does — a CHECK constraint violation, a serialization failure, a rolled-back transaction — propagates untouched, because those are statements about the REQUEST and turning them into 503s would hide real refusals behind an infrastructure-shaped error.

### §285. Constant-time comparison of a presented operator token

CONSTANT-TIME COMPARISON OF A PRESENTED OPERATOR TOKEN AGAINST THE CONFIGURED ONE.

Extracted in M25.3 because it had been copied VERBATIM into SIX route modules (`instance-scan-floors`, `instance-scan-exclusion-admissions`, `scanner-assignments`, `scan-db`, `governance-move`, `dependency-subscriptions`) and M25.3's operator door would have made seven. That is the shape `graph/containment.ts`'s header is about, on a shared secret: six copies of one comparison, each free to drift, and the drift that matters here is silent in the worst direction — a `===` restored in one copy leaks length and timing on a deployment-level credential with no test able to see it.

Each route keeps its OWN `requireOperator` wrapper, deliberately: the 403 sentences differ per surface ("these floors bind every org on the deployment", "an admission opens a loosening for every org on the deployment", ...) and each of those sentences is the operator-facing explanation for that specific door. Only the comparison is shared.

FALSE when the deployment configured no token at all, so a caller who presents nothing against an unset secret is refused rather than admitted — each caller checks `config.operatorToken` first anyway and answers with the "surface is closed" 403, and this is the second barrier.

## `apps/server/src/routes/org-root-scope-census.test.ts`

### §286. THE ORG-ROOT SCOPE CENSUS

THE ORG-ROOT SCOPE CENSUS — a new door may not be pinned at the org root by accident

WHAT THIS GUARDS. `authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD ONLY: the target object plus every containing ancestor. A check written `scopeObjectId: auth.orgId` is therefore satisfied by an ORG-ROOT BINDING AND BY NOTHING ELSE — no service-scoped, assembly- scoped or component-scoped binding can ever reach it, because the walk never goes down. That is correct for a genuinely org-level act (federation identity, the type registry, a deliberate escalation bar) and wrong for a door that governs one object; role-model.md §8 is the analysis, and increment 2.5a re-scoped the get-by-id doors that were wrong.

The re-scopes each have their own behavioural test. NOTHING held the *shape* — a new door added tomorrow with `scopeObjectId: auth.orgId` would be invisible, and §8.5 measured why that matters: all 334 `403` occurrences across `apps/server` tests were enumerated and ZERO of them pin the org-root behaviour of any door 2.5a touched. So this file enumerates every org-root-scoped check in the server and asserts the set equals a checked-in list. A new one fails CI until someone adds it here WITH A JUSTIFICATION — which is the point. The decision gets made, not defaulted into.

WHY THE GLOB IS `apps/server/src/**` AND NOT `routes/*.ts` — THE CENSUS THAT MISSED THE SURFACE
CLAUDE.md: census by PROPERTY, not by symptom; a filter is where the next instance hides. §8.1 recorded the original census doing exactly the wrong thing — `grep -rna 'scopeObjectId: auth.orgId' apps/server/src/routes/*.ts`, which finds 81 lines and misses the surface twice over:

```text
- `routes/objects.ts` contains ZERO `authorize(` calls. Its four routes — `POST`/`GET
  /api/v1/objects/service` and the `/orgs/:org/` variants — delegate to
  `services/objects-service.ts`, where the same property is spelled `scopeObjectId: orgId`
  (no `auth.`) one directory outside the glob. `listServiceObjects()` is in the list below
  because of this, and a `routes/`-only census would never have seen it.
- the create doors spell it `X ?? auth.orgId` — a fallback, not a pin — and some of them assign
  it to a `const scopeObjectId` first (`components.ts:310`, `plans-repo.ts`), so even the
  `scopeObjectId:` property spelling misses them.
```

So: the whole non-test TypeScript tree of `apps/server` (there is no enforcement in `packages/` — §1's 170-call-site census found none), and the anchor is the ASSIGNMENT of a `scopeObjectId`, in either the property form or the `const`/`let` form, whatever function it is later handed to. `authorize`, `hasPermission`, `assertDenyNotTruncated` and the `{permission, scopeObjectId}` pairs `iac/plans-repo.ts` pushes onto a check list are all covered without naming any of them, because naming them would be the next filter.

THE THREE CLASSES, AND WHY ALL THREE ARE CHECKED IN
```text
`ORG_ROOT_PINNED`    the value IS an org-root expression (`auth.orgId`, `orgId`,
                           `input.orgId`, `rootObjectId`). Only an org-root binding satisfies it.
`ORG_ROOT_FALLBACK`  the org root is the `??`/ternary FALLBACK (`declaredParent ??
                           auth.orgId`). Correct-shaped already — it scopes to the declared
                           parent when there is one — but a new door written this way whose
                           left operand is always `undefined` is a pin wearing a disguise.
`ORG_ROOT_DERIVED`   the org id appears only as an ARGUMENT to a helper that computes the
                           scope (`resolveApprovalScope(tx, input.orgId, …)`). Not org-root
                           scoped at all — listed so that "compute it in a helper" is not an
                           unwatched way to reintroduce the pin.
```

READING FILES: NUL BYTES, AND THE KNOWN-POSITIVE CONTROL FOR THIS TEST'S OWN DISCOVERY
CLAUDE.md's NUL rule is about *tools that silently drop files*, and it applies to this file's own discovery, not only to a shell `grep`. Three tracked files under `apps/server/src` carry literal NUL bytes (`dependencies/ingestion-stamp-repo.ts`, `dependencies/internal-release-detection.ts`, `iac/plan-diff.ts` — NUL is a composite-key delimiter there and is CORRECT). `readdirSync` + `readFileSync(f, "utf8")` have no binary heuristic, so they are read like any other file — but "no heuristic" is a claim about a tool, and a claim about a tool cannot be verified by asserting it. `NUL_CARRYING_FILES` is the known-positive control: the test proves those three files were discovered, that they really do contain a NUL byte, and that their text arrived non-empty. If discovery ever starts dropping them, the census does not report green over the gap.

WHAT THIS CANNOT PROVE — read `@scp/source-census`'s index.ts in full before trusting a result
A source census is a grep with good manners. `readStripped` removes comments, so a commented-out check no longer counts as a check (`governance-move.ts:142` and four doc comments in `handfill-repo.ts`/`schema.ts` say `scopeObjectId: auth.orgId` in prose and are correctly absent below). It deliberately PRESERVES string and template contents, so a mention inside a template literal WOULD count — today none of the entries below comes from one, and if a false entry ever appears that is the first thing to check. And it cannot see dead code, a false condition, or the wrong arguments.

SO THIS IS A NECESSARY CONDITION, NEVER A SUFFICIENT ONE. It says "the set of org-root-scoped checks is still exactly this set". It says NOTHING about whether any of them is enforced at runtime — that is what the behavioural tests beside this file are for (`change-target-scope.integration.test.ts`, `campaign-scope-doors.integration.test.ts`, `change-source-mapping-authz.integration.test.ts`, `federation-overlay-base-authority.integration.test.ts`).

STILL OWED: §8.3's INVERSE-WALK INVARIANT — NOT THIS INCREMENT
§8.3 names an invariant nobody has tested: the upward walk and the downward walk must be EXACT inverses, or get-by-id and LIST disagree — an object `authorize()` admits at its own id would be absent from that subject's list, which reads as a cache bug rather than an authz bug. The test is `hasPermission(o)` IFF `o ∈ readableSet(subject)` over a random sample. It cannot be written yet: there is no downward walk to compare against until 2.5b builds `authz/readable-scope.ts`. It is owed, it is the drift detector for the whole model, and this census is not a substitute for it — this file only counts scopes, and the invariant is about what they RESOLVE to.

### §287. The thing acted on has no place in the containment graph

- `org-level` — the thing being acted on has no place in the containment graph below the org root, so there is no narrower scope to check at. The pin is correct and permanent. - `escalation-bar` — org-root ON PURPOSE, so that a narrower binding CANNOT satisfy it. Widening one of these is a security regression, not a fix (role-model.md §8.6). - `list-gate` — a LIST door's gate. §8.2 step 5 keeps this check unchanged — same permission, same org-root scope, evaluated FIRST — and does the widening by filtering rows inside the repo before the `LIMIT` (2.5b), which is what makes that change a pure widening: a caller who cleared it before still clears it, and still gets an UNFILTERED query. On the doors 2.5b has reached the check is no longer written in the route: it moved into `authz/list-door-scope.ts`'s wide arm, one definition for all eight list doors, and it is still org-root pinned there. The entries still naming a route are the doors 2.5b has not reached. - `not-a-check` — a `scopeObjectId` written into a `role_bindings` ROW, not a permission check. Present because the property is "a scope set to the org root" and filtering by call target is where the next instance would hide. - `deferred` — a door 2.5a did not re-scope, because §8.6 excluded it or a later increment owns it. LISTED, NOT ENDORSED: the entry records that the pin is known, with who owns the decision.

### §288. The list doors, and how each is classified

---- LIST doors ------------------------------------------------------------------------------ 2.5b routes EVERY list door's gate through `authz/list-door-scope.ts`'s WIDE ARM — the two entries directly below. Doors reached by 2.5b then fall into two shapes, and BOTH are correct:

```text
- `/campaigns` and `/placements` pass the permission and org id as arguments, so the check is
  no longer written in the route and they have no entry of their own here;
- `listObjects`'s four doors keep a `PermissionCheck` LITERAL in the route and hand the whole
  thing to the shared gate. Nothing is checked twice — the literal IS what the wide arm runs —
  and keeping it buys per-door visibility in this census, which matters most for
  `services/objects-service.ts`, the door a `routes/*.ts` census cannot see at all (§8.1).
```

The remaining route entries (`/changes`, `/change-sources/.../mappings`, `/relationships`, `/dependencies/producers`) are the doors 2.5b has not reached.

### §289. THE ORG ROOT AS A FALLBACK, not as a pin

THE ORG ROOT AS A FALLBACK, not as a pin. Every one of these scopes to a declared containment parent and lands on the org root only when none was declared — which is what `null` MEANS at the wire boundary (ADR-0021 D4), and what `containment-parent-doors-census.integration.test.ts` pins behaviourally. Listed so that a new door whose left operand is always `undefined` — a pin wearing a `??` — cannot arrive unnoticed.

### §290. THE ORG ID AS AN ARGUMENT, not as a scope

THE ORG ID AS AN ARGUMENT, not as a scope. The scope is computed by a helper that takes the org id as its TENANT parameter. These are not org-root scoped — they are listed so that moving a scope computation into a helper is not an unwatched way to reintroduce the pin.

### §291. KNOWN-POSITIVE CONTROL for this file's own discovery

KNOWN-POSITIVE CONTROL for this file's own discovery. These three tracked files under `apps/server/src` contain literal NUL bytes (a composite-key delimiter — correct, and must not be "fixed"; `pnpm nul-census` is the authority on the current set). Every recursive search tool this repo reaches for classifies them as binary and DROPS THEM SILENTLY. This test's discovery must not, and asserting that it does not is the only way to know.

### §292. A stable name for the door this check belongs to

A stable name for the door this check belongs to: `METHOD url` when the site sits inside a `typed.route({…})` block (the form every route file but `events.ts`/`oidc.ts` uses), else the `app.get("…")` form, else the enclosing top-level function. A NAME rather than a line number, so that editing anything above a door does not churn the checked-in list — and so that the failure message names the door a reviewer has to make a decision about.

## `apps/server/src/routes/ownership.integration.test.ts`

### §293. M2 ownership/consumes/depends_on ergonomics

M2 ownership/consumes/depends_on ergonomics (BUILD_AND_TEST.md §8 M2 item 1), exercised through the real SDK over real HTTP (mirrors relationship-authz.integration.test.ts / custom-type.integration.test.ts's style) — these sub-resources are thin wrappers around the exact same `graph/relationships-repo.ts` functions the generic `/relationships` endpoint uses, so correctness here is really about the wrapper's id/urn resolution and BOTH-endpoint RBAC.

## `apps/server/src/routes/ownership.ts`

### §294. The typed resources valid as an ownership endpoint

The 4 typed resources that are valid `owns` "to" endpoints among this milestone's 8 typed resources (drizzle/0002_rls_rbac_seed.sql §6: `owns.to_types`; `contract` isn't one of the 8 typed resources M2 adds, so it has no `/owners` sub-resource here).

### §295. The two resources valid on both sides of those edges

The 2 typed resources valid on both sides of `consumes`/`depends_on` (same migration, §6).

`assembly` is deliberately ABSENT, matching migration 0055's ruling: `depends_on`/`consumes` describe things that actually call each other, and an assembly does not make a request — its components do. Admitting it would put a node in the dependency graph with no runtime edge behind it, which is exactly the "guessing and assumptions" the dependency work is meant to remove.

### §296. The ergonomic owners wrapper over the generic edges

`POST/GET/DELETE /{basePath}/{idOrUrn}/owners[/...]` — ergonomic wrapper around the built-in `owns` relationship type. The owner side's type isn't known ahead of time (team, group, user, or service-account — DESIGN.md §4.1's `owns.from_types`), so it's resolved via `getObjectByIdOrUrnAnyType` rather than a fixed-type lookup; `createRelationship` itself still enforces the endpoint-type and cardinality constraints from the relationship type registry (fromTypes/toTypes/one_to_many), so a wrong-typed owner is a 400 and a second owner on an already-owned target is a 409 — this route does not re-validate either.

Relationship writes (add/remove) require `relationship:write` at BOTH endpoints' scopes, exactly like `routes/relationships.ts` (PR #4 security review, CRITICAL 1) — load-bearing here too, not just on the generic endpoint.

### §297. The ergonomic consumes and depends-on wrapper

`POST/GET/DELETE /{basePath}/{idOrUrn}/consumes|depends-on[/...]` — ergonomic wrapper around the built-in `consumes`/`depends_on` relationship types (both many_to_many, both constrained to service/component on either side — DESIGN.md §4.1). The target's type isn't pre-filtered here: `createRelationship` rejects a wrong-typed target with a 400 against the registry, so pointing `depends-on` at e.g. a `team` fails there, same as the generic `/relationships` endpoint.

### §298. The ownership ergonomics, layered over the generic verbs

Ownership/consumes/depends-on ergonomics (BUILD_AND_TEST.md §8 M2 item 1) layered on top of `routes/typed-registries.ts`'s 8 resources, reusing `graph/relationships-repo.ts`'s `createRelationship`/`deleteRelationship`/`listRelationships` — which already enforce endpoint-type and cardinality constraints from the relationship type registry, so this module never re-validates those — and `authz/resolve.ts`'s `authorize()` at BOTH endpoints' scopes, exactly like `routes/relationships.ts`.

Built from two small parameterized factories (one per sub-resource shape) invoked 4 + 2 times, rather than hand-copied per resource.

## `apps/server/src/routes/pats.integration.test.ts`

### §299. Personal Access Tokens

Personal Access Tokens (M2 step 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — create/use/list/ revoke, expiry, and the load-bearing RBAC-parity property: a PAT must resolve to EXACTLY the same permission scope as the owning user's own session, never more.

## `apps/server/src/routes/pats.ts`

### §300. Personal Access Tokens

Personal Access Tokens (M2 step 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — create/list/revoke for the CALLING user's own tokens only; used as a bearer token via `auth/require-auth.ts`.

PATs are auth-substrate (no RLS — see db/schema.ts, matching orgs/users/sessions), so their own reads/writes go straight through `deps.db`. The audit log IS RLS-protected, so only the audit append runs inside a `withTenantTx` — the one write here that actually needs it.

## `apps/server/src/routes/pipeline-evidence.integration.test.ts`

### §301. The evidence route and the continuous-test hold

`POST /pipelines/evidence` + `ChangeWaveTargetSchema.hold.continuousTests` — the two API-surface halves of team-pipeline-iac increment 8, against REAL PostgreSQL.

EVERY SUBMISSION IN THIS FILE GOES THROUGH HTTP, NEVER THROUGH `pipeline-hooks-repo.ts`
`recordTestRunEvidence`/`recordAlarmEvidence` already have their own storage-layer file (`coordination/pipeline-hooks-repo.integration.test.ts`), and NOTHING this file claims can be proved there: the authorization scope, the strict-body refusal and the server-side producer stamp all live between the socket and those functions. A route proven only at the repo layer is a route whose authz was never exercised — so every write below is `server.app.inject(...)` against the fully-built app (auth plugin, Zod validation, the real handler), and every assertion about what was stored is a SELECT against the row that request produced.

`app.inject` rather than the generated SDK for the submissions specifically, because two of the seven properties are about bodies the SDK's types cannot express: an extra top-level `producer` key, and a `subject` carrying a forged producer claim. A test that could only send well-typed bodies could not reach the refusals that matter.

THE FOUR MUTATIONS THESE TESTS WERE WATCHED TO DIE UNDER (2026-08-27, baseline 8 passed)
Each was applied alone and reverted:

(a) `routes/pipelines.ts`'s `authorize({... scopeObjectId: target.id})` -> `scopeObjectId: input.orgId` (the org root — the bar `POST /change-sources/{kind}/report` uses) => TWO tests failed, both on the SAME shape: "a caller authorized only at ANOTHER target cannot submit for this one" and "stamps the PERSISTED producer from the authenticated subject", each `expected 403 to be 201`, with `subject '<component-scoped principal>' lacks 'object:write' at scope '<org root>'`. The narrowing test failed at its POSITIVE CONTROL — the leg that exists so the case cannot pass by everything being refused — which is exactly where an org-root pin has to show up: it does not let MORE through here, it locks every component-scoped CI principal out. Its refusal leg stayed green, and so, correctly, did the other six tests, all of which submit as the org-root admin. (b) the producer stamp -> read from the caller's body (`producerSubjectId: rawSubject.producer ?? auth.subjectObjectId`, taken off `request.rawBody` so Zod's strip of the unknown `subject.producer` key does not hide it) => "stamps the PERSISTED producer from the authenticated subject" FAILED ALONE, on the stored row: `expected '<impostor id>' to be '<reporter id>'`. The forged id was persisted. (c) `SubmitPipelineEvidenceRequestSchema` `z.strictObject` -> `z.object` (and `@scp/schemas` REBUILT — these tests import the package's `dist`, so a source-only mutation is a false green) => "REFUSES a body carrying an extra top-level `producer` key" FAILED ALONE: `expected 201 to be 400`. (d) `plan-service.ts`'s read-time continuous projection replaced by a persisted one (the verdict map captured on the FIRST read and reused on every later read — what a Decision-fed field does) => the hold-projection test FAILED ALONE on its second half: `expected [ { hookId: 'canary', …(4) } ] to be undefined`. Its first half (the key IS present while held) stayed green, which is what makes the failure attributable to read-time composition rather than to the projection existing at all.

A test that survives its own mutation is vacuous; the results above are the record that these did not.

### §302. The forged claim rides inside `subject`

The forged claim rides inside `subject` — the ONE place a producer-shaped key survives validation at all (`SubmitPipelineEvidenceRequestSchema` is strict at the TOP level; the subject object is a plain `z.object`, so Zod strips unknown keys there rather than refusing). That makes this the sharpest available test of the stamp: a body the server accepts, carrying a producer the server must not believe.

## `apps/server/src/routes/pipelines.ts`

### §303. THE PUSHED-EVIDENCE DOOR

THE PUSHED-EVIDENCE DOOR (team-pipeline-iac increment 8, D21(b) / §14 resolution 8).

`SubmitPipelineEvidenceRequestSchema` shipped in `@scp/schemas` referenced by NO route, which is the built-never-installed shape one layer up from where `pipeline-hooks-repo.ts` met it: the table, the verdict functions and the admission seams were all in place and there was no way for anything outside this process to say "the suite passed" or "the window was quiet". This file is that way in, and it is deliberately ONE route with two dispatch arms rather than a mode bolted onto `POST /change-sources/{kind}/report` (owner ruling, 2026-08-26). The two rules below are the whole reason it is separate; neither survives being folded into the reporter.

RULE 1 — AUTHORIZED AT THE SUBJECT'S TARGET, NOT AT THE ORG ROOT
`SubmitPipelineEvidenceRequestSchema`'s own doc states it: pushed alarm state UNLOCKS A PRODUCTION BAKE GATE, so "who may say the window was quiet" has to be as narrow as "who may deploy there" — an org-root-scoped write permission on a gate unlock is a privilege escalation wearing a reporting API's clothes. That is not a hypothetical difference from the reporter beside it: `POST /change-sources/{kind}/report` takes `object:write` at `auth.orgId`, which `scopeExpandCte` (expanding UPWARD only) makes satisfiable by an ORG-ROOT binding and by nothing else. Every component-scoped CI principal in the estate would have been refused, and every principal that COULD report would have been able to report about every target in the org.

THE PERMISSION IS `object:write` AT THE RESOLVED `targetUrn`, chosen by matching the bar the existing target-scoped doors already set rather than by minting a new one: `coordination/campaign-scope-authz.ts`'s `assertCoordinationTargetsWithinAuthority` — the check that decides who may propose a CHANGE against a target, i.e. literally "who may deploy there" — is `object:write` at each resolved target's own object id, and `iac/plans-repo.ts` uses the same pair for a placement. A new `evidence:write` permission would have to be granted by every built-in role before anyone could use it, and would have started life meaning something subtly different from the deploy bar it is supposed to mirror.

ONE TARGET, EVERY TIME — no org-root disjunction arm. `authz/org-root-arm.ts` exists for doors whose scope can become UNREACHABLE (a change's targets are read back verbatim off `properties` and their ancestors can be tombstoned out from under an org-root Owner). Nothing like that applies here: the target is resolved LIVE from the graph on this very request, so a caller whose target resolves at all has a live object to be scoped by, and adding the arm would hand exactly the org-root-wide unlock this route exists to refuse back to whoever holds the org root.

RULE 2 — THE PRODUCER IS STAMPED, NEVER ACCEPTED
The request is a `strictObject` with no `producer`/`source`/`reportedBy` member, and one must never be added. `federation/scan-evidence.ts` holds the governing rule: PROVENANCE IS THE AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE, because a shape-valid payload is forgeable by anyone who can read the schema. So `producer_subject_id` comes from `auth.subjectObjectId` and `source` is the constant `'pushed'`.

`source` is not a cosmetic label here — `evaluateBakeGate` computes quiet-window coverage PER SOURCE, merging only the intervals one source asserted, so a caller able to choose its own `source` could manufacture single-source coverage of a window nobody observed. The constant is what makes that unreachable through this door.

The strictness is load-bearing in the same direction: a body carrying an extra `producer` key is REFUSED (400) rather than silently stripped. A silent strip would tell a forger their claim was accepted while the server quietly recorded something else, and would let a genuinely-confused CI step ship for months believing it had attributed its own runs.

WHAT THIS ROUTE DOES *NOT* DO
It does not check that a matching hook is DECLARED. Evidence for an undeclared hook is inert — every consumer starts from `pipeline_hooks` and joins evidence to it, so an orphan row is never read by any verdict — and refusing it would make the ORDER of `scp iac apply` and the CI step that reports against it load-bearing, which nothing in D11/D21 asks for.

It records no Decision, so it returns no `decision_id`: nothing here is an engine VERDICT. The refusals it can produce are a 404 (the subject does not resolve), a 403 (`authorize`'s own unexplained-authority refusal, the same shape every other door's 403 has) and a 400 (Zod). The verdicts this evidence FEEDS — `gate`/`continuous_test` — are Decision-backed on the reconcile side and carry their `decision_id` there, which is where charter principle 6 is satisfied for this data.

### §304. Every field of the receipt is read back off the row

EVERY FIELD OF THE RECEIPT IS READ BACK OFF THE PERSISTED ROW, not restated from the constants above: the receipt describes what is IN THE TABLE, so a stamping regression surfaces in the response a reporter actually reads instead of only in a column nobody looks at. The two narrowings below are therefore checks, not casts — both are unreachable while the stamping above stands, and both would be the first sign that it stopped.

## `apps/server/src/routes/placements.ts`

### §305. The placement routes, and the identity they enforce

`placement` routes (ADR-0026 D2/D3/D14, post-import-configuration.md §3, owner decision D17).

`placement` is deliberately NOT a `TYPED_REGISTRY_RESOURCES` entry — the shared template's `POST`/`PUT` take free-form `properties` and cannot require two endpoints, resolve them, type-check them, or write the derived edges atomically. It is refused on the generic `/objects/placement` route and on the federation overlay route (`graph/pair-bound-types.ts`), so this is the ONLY door by which a placement is declared locally, and it requires both endpoints.

NO `PATCH`, deliberately. A placement's properties ARE its identity: re-pointing `componentId`/`deploymentTargetId` would silently make it a different placement while keeping its id, URN, executor binding and wave-target history — and per D8 a pair is DECLARED, so changing one is a new declaration, not an edit. Deleting and re-declaring is the honest form and leaves an audit trail that says so. (Renaming for display is not offered either, since the name is derived from both endpoints and `deriveUrn` never recomputes a URN — §6's D13 finding.)

### §306. THE GATE, AND THE ROW FILTER, IN ONE CALL

THE GATE, AND THE ROW FILTER, IN ONE CALL (role-model.md §8.2, increment 2.5b). The org-root `object:read` check this replaced is still the first thing it runs and still throws the same 403 when nothing else grants; what is new is that a principal bound BELOW the org root now lists the placements their binding reaches instead of being refused outright. See `authz/list-door-scope.ts` for why the resolver is a callback: `?scopeObjectId=` must be resolved AFTER the gate (existence oracle) and authorized at the RESOLVED id (404-becomes-403).

## `apps/server/src/routes/plans-cli.integration.test.ts`

### §307. BUILD_AND_TEST.md §8 M2 DoD (b), literal wording

BUILD_AND_TEST.md §8 M2 DoD (b), literal wording: "an `@scp/iac` stack applied twice is a no-op the second time (plan shows zero actions) ... integration + a CLI-driven test." Uses `startCliSession` (test-support/cli-runner.ts) to spawn the REAL BUILT `scp` binary, same pattern as `graph/custom-type.integration.test.ts`'s CLI half — a genuine black-box exercise of `scp plan`/`scp apply`, not an in-process shortcut.

## `apps/server/src/routes/plans.integration.test.ts`

### §308. `@scp/iac` server-side plan/apply

`@scp/iac` server-side plan/apply — full round trip via the SDK (BUILD_AND_TEST.md §8 M2 item 4). DoD (b): "an `@scp/iac` stack applied twice is a no-op the second time (plan shows zero actions)". `plans-cli.integration.test.ts` covers the same core property driven through the real `scp` binary instead of the SDK directly.

### §309. C1 — sourceMappings / executorBindings

C1 — sourceMappings / executorBindings (docs/proposals/post-import-configuration.md §8). These two are PROJECTION TABLES, not graph objects, so nothing here can be inferred from the object/relationship tests above: their ownership, their prune scope and their write path are all separate code.

## `apps/server/src/routes/plans.ts`

### §310. Server-side `@scp/iac` plan/apply

Server-side `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15): the diff engine lives once here and is identical for the CLI (`scp plan`/`scp apply`), the SDK, and (in later milestones) federation import and drift detection — "Kubernetes-apply semantics, not client-side Terraform semantics" (DESIGN.md §15).

**Routing note (documented deviation):** DESIGN.md's `{id}:verb` syntax (e.g. `/changes/{id}:accept`) does NOT survive Fastify's router (find-my-way) the way it reads — verified empirically: registering `/plans/:id:apply` does not parse as param `id` + literal suffix `:apply`; find-my-way instead treats the whole `id:apply` token as ONE parameter name (`request.params["id:apply"]`), so `/plans/abc` and `/plans/abc:apply` collapse onto the same route and can't be told apart. No `:verb`-style route exists anywhere else in the codebase yet to be consistent with (M3 introduces the first ones), so this module falls back to the conventional REST subpath `POST /plans/{id}/apply` instead — a deliberate, isolated deviation, not a precedent-breaking one.

**Scope decisions (documented):** - `POST /plans` (diff computation) is read-only against the graph and can touch objects across many scopes, so it checks `object:read` at the org-root scope — mirrors `objects-generic.ts`'s list-scope decision. The write-permission gate that actually matters is per-affected-object at apply time (`prepareApplyChecks`, `iac/plans-repo.ts`), not here. - `POST /plans/{id}/apply` checks `object:write`/`relationship:write` at EVERY individual affected object/relationship's own scope, not one coarse check at the org root — the parent task's explicit instruction, mirroring the M1 security review's "relationship writes require write permission at both endpoints' scopes" (CRITICAL 1). Every check runs to completion BEFORE any mutation executes, in the same transaction, so a single denial rolls back the entire apply (fails fully closed — see `plans.integration.test.ts`'s partial-denial test). - A `policy`/`control` object in the manifest is checked against `policy:write` instead of `object:write`, and a `policy` create/update additionally runs `assertPolicyScopeWithinAuthority` — the exact same governance gates the typed `/policies`/ `/controls` routes enforce (security fast-follow after PR #9: `iac/plans-repo.ts`'s `prepareApplyChecks` doc comment has the full story). "The exact same gates" is a claim this file cannot keep on its own, and M21.3 briefly made it FALSE: ADR-0032 §6a's refusal was added to the typed route's `validateWrite` and to nothing else, so a manifest declaring a group-scoped dependency-subscription opt-out applied cleanly through here and the object read back. That refusal now lives at `graph/objects-repo.ts`'s `createObject`/`updateObject` — which apply calls directly — so parity holds by construction rather than by two lists happening to agree.

### §311. D7 SINGLE OWNERSHIP PER STACK

D7 SINGLE OWNERSHIP PER STACK (ADR-0046 §3, team-pipeline-iac §4/§5). A stack bound to a config source is repo-owned: its state is delivered by that repo's sync, and a direct apply against it would be reverted by the very next sync — silently, and with the CLI caller having been told it succeeded. Refused with a 409 naming the owning config source, which is the thing the caller has to change to get their push back.

AT APPLY, NOT AT `POST /plans`, for the reason the commander-only check below it is: computing a diff writes nothing, and seeing what a push WOULD do to a repo-owned stack is a legitimate — and, for a PR dry-run, the intended — thing to ask.

The predicate is `config-source/cli-apply-guard.ts`, which is also what makes "not bound" mean exactly what it does today: every stack no config source claims returns `{ allowed: true }` unconditionally, so this is one new refusal and not a new gate on the existing path.

### §312. Commander-only, but only for the one collection that is

COMMANDER-ONLY, BUT ONLY FOR THE ONE COLLECTION THAT IS (ADR-0032 §7d, §7e). A plan that touches no producer declarations applies anywhere, as it always has; a plan that writes one is refused on a field outpost exactly as `POST /dependencies/producers` is. IaC apply is a SECOND DOOR into `dependency_line_producers`, and a commander-only capability guarded at one door is not guarded — the row would land where no dependency job runs and no inventory exists to act on it, which is the "true elsewhere, inert here" shape `dependencyManagement` exists to close.

The FEDERATION axis only, never the process axis: every HTTP request lands on an `SCP_ROLE=api` process in the split topology, so a route carrying the process axis would refuse every caller on a correct commander (`commander-only.ts`'s "a route does not get both"). Checked at APPLY and not at `POST /plans`: computing a diff writes nothing, and the plan an outpost operator computes is a legitimate way to see what the commander would do.

## `apps/server/src/routes/policy-fromrole-validation.integration.test.ts`

### §313. `fromRole` AUTHORING-TIME VALIDATION

`fromRole` AUTHORING-TIME VALIDATION — role-model.md §5 step 6

THE FAILURE IT REPLACES. Since the quorum-bypass fix, `hasRoleAtScope` resolves BUILT-IN role names only. So a policy naming anything else is not merely wrong — it is UNSATISFIABLE: the gate blocks forever, the Decision reads "0 of 1 approvals", and an operator staring at a live binding of a role with exactly that name concludes the approval engine is broken. A typo and a custom role produce an identical symptom, and nothing anywhere states what a legal value is.

Entered through HTTP, and through BOTH verbs, because the guard sits at the `objects-repo` choke point precisely so that every writer inherits it — a route-level check would have left the update path and IaC apply able to author the unsatisfiable policy.

### §314. `/api/v1/policies`, NOT `/api/v1/objects/policy`

`/api/v1/policies`, NOT `/api/v1/objects/policy`: `policy` is a governance-managed type and the generic object door refuses it outright (403), because that door cannot check the scope authority `policy:write` requires. Writing this test against the generic endpoint would have exercised that refusal instead of this guard — every case would have "failed correctly" for entirely the wrong reason.

### §315. MEASURED, NOT ASSUMED

MEASURED, NOT ASSUMED — and the first version of this test was VACUOUS. It used PUT with a body whose name/urn were rebuilt from a fresh `Date.now()`, so the urn did not match the policy just created; `upsertObjectByUrn` found nothing and took its CREATE branch. Deleting the update guard left the whole file green while deleting the create guard reddened this case — the tell that it was exercising create twice and update never.

PATCH is the verb that reaches `updateObject` (routes/typed-registries.ts), so this is the assertion the update choke point actually answers for.

### §316. The SAME name, so the SAME urn

The SAME name, so the SAME urn.

WHICH BRANCH THIS TAKES IS MEASURED, AND IT IS NOT THE ONE THE OBVIOUS READING SUGGESTS: deleting the CREATE guard reds this case and deleting the UPDATE guard does not, so PUT is answered by `createObject` even against a matching urn. `upsertObjectByUrn` has three branches — create, a direct in-place `UPDATE ... SET` for the hand-filled-id case, and `updateObject` — and this test deliberately does not assert which one runs. It asserts the REFUSAL, which is the property; the PATCH case above is what pins the update choke point.

## `apps/server/src/routes/rbac-administrative-floor.integration.test.ts`

### §317. THE ADMINISTRATOR FLOOR IS A PROPERTY OF THE ORG

THE ADMINISTRATOR FLOOR IS A PROPERTY OF THE ORG — every door that can falsify it

`docs/authz/role-binding-door.md` §7's floor shipped as `assertNotLastAdministrativeBinding`: a rule owned by `routes/role-bindings.ts`'s DELETE handler, phrased as "what would be left if I removed THIS binding". It refused the revoke correctly, its advisory lock serialized it correctly, and it guarded **one of three public-API doors that can empty an org's administrators**. The other two needed no concurrency, no special privilege, and four plain sequential requests each:

```text
A. `DELETE /role-bindings/{id}`  — GUARDED from the start.
B. `DELETE /relationships/{id}`  — remove the `member_of` edge under a group's administrative
                                   binding. THE BINDING ROW SURVIVES, so a revoke-time rule
                                   never runs and the surviving row is counted as an
                                   administrator no live principal resolves through.
C. `DELETE /objects/team/{id}`   — tombstone the group that HOLDS the binding; the edge cascade
                                   is B again, in bulk, from a door that never mentions RBAC.
C'. `DELETE /objects/user/{id}`  — tombstone the principal that holds it DIRECTLY. Removes no
                                   edge at all, so even a cascade-aware guard misses it.
```

Recovery from any of them is hand-written SQL — verbatim the failure mode `packages/schemas/src/rbac.ts` says this door exists to eliminate.

WHAT THIS FILE PINS, AND WHAT IT DOES NOT
The fix is ONE predicate — `assertOrgRetainsAdministrativeFloor`, "does at least one LIVE principal THAT CAN AUTHENTICATE resolve an org-root binding of a role carrying `role_binding:write`" — evaluated AFTER each write, inside the write's transaction, from the choke points (`graph/objects-repo.ts`'s `deleteObject`, `graph/relationships-repo.ts`'s `deleteRelationship`, and the revoke handler). Every case below enters at the ROUTE, so it measures the door and not the predicate agreeing with itself.

IT DOES NOT PROVE THE CHOKE-POINT PLACEMENT. A guard moved from `deleteRelationship` into `routes/relationships.ts` would leave this whole file green while `POST /plans/{id}/apply` went on pruning the edge — the exact shape this programme has paid for twice. That measurement is `iac/iac-administrative-floor.integration.test.ts`'s job and is mutation 4 below.

EVERY REFUSAL IS PAIRED WITH AN ADMISSION on the same door with the same verb, differing only in whether a second administrator survives. Without the pair the guard could be a blanket refusal of every membership removal and every team delete, and every refusal here would still be green.

AND D7 + ITS PREVIEW, WHICH ARE NOT THE FLOOR — why they live here anyway
The acknowledgement (docs/authz/role-binding-door.md §2c) and `GET /role-bindings/grant-preview` (§2d) are grant-side, not floor-side. They are measured here rather than in the door suite for one reason: that suite's `grant()` helper AUTO-ACKNOWLEDGES, so every case in it would pass against a door that had no acknowledgement at all. Cases about the acknowledgement have to be written where the value is composed by hand, and this file is where the group/team fixtures already are.

The preview's cases carry a rule the floor's do not: **a response derived from rows the request does not name is filtered to what the caller could fetch individually.** It has been narrowed twice — the GATE (a caller-chosen `scopeObjectId`) and then the PROJECTION (members are not the subject, so authorizing at the subject disclosed them anyway). Both narrowings are pinned in both directions, and the second one's admission half is the load-bearing half: filtering is only defensible if the granter who needs the acknowledgement can still produce one.

MUTATION LOG — each applied ALONE, CONFIRMED ON DISK before the run, measured, then reverted
See this file's sibling `rbac-role-binding-door.integration.test.ts` for the method: the injected marker is counted off disk with `grep -nac` against a known-positive control before the run and confirmed back to zero after, because a mutation that never applied reads as a pass.

1. `graph/relationships-repo.ts` — deleted the whole `if (existing.typeId === "member_of" && !input.federationImport)` block -> **2 failed, 44 passed.** "DOOR B…": `expected 200 to be 409`, the body being the `member_of` edge with `"deletedAt"` set — the membership really was removed. And `iac/iac-administrative-floor.integration.test.ts`: `the pruning apply must be REFUSED, not resolved: expected null to be an instance of ScpApiError`. Both doors, one deletion. ⚠️ **DOOR C STAYED GREEN**, which contradicted the prediction written here first: the team tombstone is caught by `deleteObject`'s OWN call (mutation 2), not by the cascade. The cascade covers it only when this call is present. Recorded as measured. 2. `graph/objects-repo.ts` — deleted the `if (touchesRoleAuthority)` call at the end of `deleteObject` (the probe left in place, so the file still compiles and `tsc` stays clean) -> **1 failed, 8 passed.** "DOOR C': tombstoning the USER…": `expected 200 to be 409`, the body being the admin's own user object with `deletedAt` set. Door C stayed GREEN here — its cascade is covered by mutation 1's guard. So the two calls cover DIFFERENT cases and each is separately measurable, which is why both exist. 3. `authz/role-binding-door.ts` — `assertOrgRetainsAdministrativeFloor` early-returns unconditionally -> **8 failed across three files, 38 passed.** Here: doors B, C and C'. In `iac-administrative-floor`: the pruning apply. In `rbac-role-binding-door`: "the LAST org-root administrative binding cannot be revoked", "the floor is not satisfied by a binding on an EMPTY group", "the floor does not count a group whose only member is SOFT-DELETED", and the concurrent-revoke case (`expected [200, 200] to deeply equal [200, 409]`). **ONE predicate, four doors** — the claim the whole rework rests on, measured rather than asserted. 4. `graph/relationships-repo.ts` — the floor call MOVED into `routes/relationships.ts`'s DELETE handler (the "obvious" placement), byte-identical call, import added, `tsc` clean -> **0 failed in THIS file — all 8 green — and 1 failed in `iac/iac-administrative-floor.integration.test.ts`.** Door B's refusal, door C's refusal and every admission pair passed against a placement that leaves `POST /plans/{id}/apply` pruning the membership. THIS FILE CANNOT SEE THE CHOKE POINT; that is what the IaC file is for. 5. `authz/role-binding-door.ts` — `objectTouchesRoleAuthority` returns `false` unconditionally (the sound-relevance short-circuit turned into a blanket skip) -> **1 failed, 8 passed.** "DOOR C': …USER…": `expected 200 to be 409`. Door C stayed green (its cascade), so the probe is load-bearing for exactly one of the two object cases — which is what makes it a cost decision rather than a second guard. 6. `authz/role-binding-door.ts` — `revokeAffectsAdministrativeFloor` returns `true` unconditionally (the revoke relevance test removed, so EVERY revoke runs the floor check) -> **0 failed, 45 passed.** Recorded because it is the honest result: the short-circuit is a COST decision and removing it changes no verdict in any suite. What it DOES change is that an org already below the floor could no longer revoke a `deny` row or a service-scoped binding. Not pinned; named in `docs/authz/role-binding-door.md` §7. 7. `authz/role-binding-door.ts` — deleted §2a's member-shape half (the `unbindablePrincipalReasons(reachedByJoiner)` refusal in `assertMayJoinRoleBearingSubject`) -> **1 failed, 44 passed.** "§2b's refusals apply on the JOIN path…": `expected 201 to be 422`, the body being the minted `member_of` edge from the group holding a tombstoned member into the empowered team. The whole door suite stayed green, because it only ever joins USERS. 8. `authz/role-binding-door.ts` — `assertGrantAcknowledgesEmpoweredPrincipals` early-returns -> **3 failed, 42 passed.** All three D7 cases: the missing acknowledgement (`expected 201 to be 422`, the response body being the Owner binding on the team), the stale one (`expected 201 to be 409`), and the omitted-field-on-an-empty-group one. 9. `authz/role-binding-door.ts` — the `notReached` half of the set comparison replaced with `[]` (mismatch detected in ONE direction only) -> **1 failed.** The stale case's second half — an acknowledgement naming a principal the team does NOT reach was admitted (`expected 201 to be 409`). Set EQUALITY, not containment, and a one-directional check would have read as coverage. 10. `routes/role-bindings.ts` — the preview's `if (!verdict.ok)` turned into `if (false && …)` -> **1 failed.** "the preview is gated on `audit:read`": `expected 200 to be 403`, and the 200's body was a membership listing handed to a principal holding nothing. 11. `routes/role-bindings.ts` — the preview returns an EMPTY principal list -> **2 failed.** Both D7 cases that read the value back (`expected [] to deeply equal [ …(2) ]`). The preview is therefore load-bearing rather than decorative: a client that trusted it would send an acknowledgement the door then 409s.

MUTATION LOG — ROUND 6 (2026-08-27): the CREDENTIAL anchor, the preview's subject anchor, the 409
12. `authz/role-binding-door.ts` — the floor's survivor test reverted to revision 2's TYPE test (`!p.deleted && (p.typeId === "user" || p.typeId === "service-account")`) -> **2 failed, 47 passed.** "the floor REFUSES the phantom brick": `expected 200 to be 409`, the body being the revoked Owner binding — the org bricked. And the phantom-service- account half of "a REAL service-account administrator counts", identically. **The WHOLE door suite stayed green (37/37)**, which is the honest measurement: nothing that existed before this round could see the defect. 13. `authz/role-binding-door.ts` — the anchor made TOO STRICT (`!p.deleted && p.credentialed && p.typeId === "user"`) — the mirror-image hazard -> **1 failed, 11 passed.** The service-account ADMISSION: `expected 409 to be 200`, an org that is administrable by a real, logged-in service account reporting "no live principal that can AUTHENTICATE". Both directions of the anchor are therefore pinned by two different cases, and neither passes against the other's bug. 14. `authz/role-binding-door.ts` — `principalsReachedBy` returns `credentialed: true` for every row -> **3 failed, 9 passed.** Both phantom cases, plus **DOOR B** (`expected 200 to be 409`, the body the tombstoned `member_of` edge): with the `users` join short-circuited the EMPTY TEAM counts as its own administrator. The SQL join is what decides, not the caller. 15. `authz/role-binding-door.ts` — the LIVENESS half dropped (`reached.some((p) => p.credentialed)`) -> **2 failed, 47 passed.** "DOOR C': tombstoning the USER…" here, and "the floor does not count a group whose only member is SOFT-DELETED" in the door suite. Liveness and credential are independently load-bearing; neither subsumes the other. 16. `routes/role-bindings.ts` — the preview's `scopeObjectIds: [subject.id]` replaced with `[]` -> **1 failed, 11 passed.** The admission half of "grant-preview is anchored to the SUBJECT": `expected 200 to be 403`. So the subject arm is a real arm and the fix is an ANCHOR, not "org-root only" with extra words. 17. `routes/role-bindings.ts` — the preview's `if (!verdict.ok)` turned into `if (false && …)` -> **2 failed, 10 passed.** The pre-existing gating case, and the new anchor case — whose 200 body IS the disclosure: `{"subjectId":"…","principals":[{"id":"…","typeId":"user", "name":"user-6e7…","depth":1,…}]}`, the membership of a team handed to a principal whose `audit:read` is scoped to an unrelated service. 18. `routes/relationships.ts` — the `409: ProblemSchema` deleted from the DELETE route's schema -> **1 failed.** "every delete route that can hit the floor declares 409": `expected [ '200', '401', '403', '404' ] to include '409'`. ⚠️ The FIRST attempt at this mutation did not apply (the anchor string had been reflowed) and the suite reported **1 passed** — a mutation that never landed reads exactly like a guard that works, which is why the marker is counted off disk with `grep -nac` before every run in this log. 19. `routes/typed-registries.ts` — the same deletion on the shared DELETE template -> **1 failed.** `DELETE /users/{idOrUrn} (deleteUser) … expected [ '200','401','403','404' ] to include '409'`. One template, ten operations.

MUTATION LOG — ROUND 7 (2026-08-27): the preview's PROJECTION, and the floor's TENANT BOUNDARY
Same method: the marker counted off disk with `grep -nac` before the run and confirmed back to zero after, then a `diff` against the pre-mutation copy of the whole file.

20. `routes/role-bindings.ts` — the preview's projection filter removed (`const visible = empowered.filter((p) => readable.has(p.id))` -> `const visible = empowered`) -> **3 failed, 12 passed.** "the preview discloses only principals the caller could read individually" (`the preview leaked a member id: expected '{"subjectId":"01a04398…' not to contain '01a04398-64ed-7253-…'` — the raw 200 body carrying the member's uuid); "D7 survives a FILTERED preview" identically; and "grant-preview is anchored to the SUBJECT" (`expected [ { …(6) } ] to deeply equal []` — the team-scoped Viewer's `principals` array, six fields per member). THAT IS THE DEFECT, in the response body. 21. `authz/role-binding-door.ts` — `readableSubsetOf` returns an EMPTY set unconditionally (the over-filter, i.e. the mirror-image hazard) -> **3 failed, 12 passed.** Every ADMISSION half: "D7: a grant to a group is refused without an acknowledgement and admitted with the right one" (`expected [] to deeply equal [ …(2) ]`), "D7: a STALE acknowledgement…", and the org-root-reader half of the new projection case. Both directions are pinned by different cases, and neither passes against the other's bug — the same shape rounds 6's credential-anchor pair used. 22. `authz/role-binding-door.ts` — `if (filter === null) return new Set(candidateIds)` -> `return new Set()` (`readable-scope.ts`'s "`null` and an empty set are OPPOSITES" trap, which is the refactor most likely to be made here) -> **3 failed, 12 passed.** The same three admission halves. Recorded separately from 21 because it is a different line and a far more plausible edit. 23. `routes/role-bindings.ts` — `acknowledgementComplete: withheldPrincipalCount === 0` -> `true` -> **2 failed, 13 passed.** Both new cases (`expected true to be false`). Without it the field could be a constant and the projection cases would still be green, leaving a client unable to tell an EMPTY team from one it may not see into — which is the confusion D7 exists to prevent. 24. `authz/role-binding-door.ts` — `AND u.org_id = ${orgId}` deleted from `principalsReachedBy`'s `users` LEFT JOIN (the floor's ENTIRE tenant boundary for its fifth input; `users` carries no RLS, so nothing else fences it) -> **1 failed, 14 passed.** "a `users` row in ANOTHER org naming this org's phantom is not this org's administrator": `expected 200 to be 409`, and the body is the org's only `"roleName":"Owner"` binding returned as successfully revoked. **That is the brick, across a tenant boundary**, and before this round nothing in any suite could see it.

NOT MUTATION-PROVEN, and named rather than implied:

```text
- **the credential anchor's own limit**: a `users` row with no password, no `oidc_subject` and
  no live PAT counts as credentialed and cannot actually sign in — and the same is true of an
  IdP-provisioned row whose subject the IdP has since disabled, which is the FIELD-REACHABLE
  shape rather than a hand-SQL one. Deliberate — see `docs/authz/role-binding-door.md` §8 for why
  every tighter anchor is time-varying and why the honest position is that this floor bounds
  what the API can produce and not what an identity provider can.
- **the preview's ONE divergence from `hasPermission`**: `readableObjectFilterSql` returns
  `null` ("everything") for a subject holding an org-root allow even when a `deny` sits lower
  down, so the preview can show such a caller a principal that `hasPermission` in isolation
  would refuse. No case here builds an org-root allow plus a lower deny. It is not a widening of
  what that caller can read — the LIST doors hand them the same rows from the same `null` — and
  the reasoning is at `readableSubsetOf`.
- **the withheld COUNT itself is a disclosure**, and a deliberate one: it tells a caller that a
  group has members they may not see. Weighed against omitting it (which makes the response
  indistinguishable from an empty group) beside `GrantPreviewResponseSchema`. No case measures
  the trade, because it is a decision rather than a behaviour.
- the `!removedForeignShadow` arm of `deleteObject`'s probe. (The `!input.federationImport` arm
  of BOTH new call sites IS now pinned, in both directions, by
  `federation/federation-member-of-exemption.integration.test.ts` — mutations 8 and 9 there.)
- CONCURRENCY on doors B, C and C'. `assertOrgRetainsAdministrativeFloor` takes §0's org lock
  itself and §0 works the act-then-check ordering through, but every case here is sequential.
  The concurrent pair is measured on door A only, in the door suite.
- the LIVENESS half of the predicate (`!p.deleted`). It is pinned in the door suite ("the floor
  does not count a group whose only member is SOFT-DELETED"); this file pins the REACHABILITY
  half. Dropping `!p.deleted` would leave every case here green.
- D7 under genuine CONCURRENCY. The stale case widens the window with a sequential round trip,
  which is what a real client does; a `Promise.all` of a join and a grant is measured for §2a/§2b
  in the door suite and not re-measured for the acknowledgement.
```

### §318. THE FIXTURE EVERY FLOOR CASE NEEDS

THE FIXTURE EVERY FLOOR CASE NEEDS: an org whose ONLY administrator is a live user reached THROUGH a team's org-root Owner binding.

Built entirely through the API — team, membership, grant, then the revoke of the bootstrap admin's own binding — because every step of it is an action a real operator takes when they move an estate from "one bootstrap admin" to "an administrators team", and because a fixture written straight into the tables could produce a state the doors would never have permitted and then measure a refusal against it.

The revoke at the end is ADMITTED, and that is load-bearing: it is the admission pair for door A (the team reaches a live member, so the floor is satisfied) and it is what makes the team's binding the last one standing for doors B, C and C'.

### §319. THE ADMISSION PAIR FIRST, and it is a REDUNDANT MEMBERSHIP

THE ADMISSION PAIR FIRST, and it is a REDUNDANT MEMBERSHIP: seat a second member, remove them again. Identical verb, identical edge type, identical actor — the only difference is that the team still reaches a live principal afterwards. Without this the guard could refuse EVERY `member_of` removal (which would make a compromised membership unremovable, the exact failure §2a's "removal is untouched" paragraph is about) and the refusal below would still be green.

### §320. THE INTERESTING BOUNDARY

THE INTERESTING BOUNDARY. `[]` is the legitimate seat-the-team-later flow AND the exploit's step 2, and no membership-shape-blind rule separates them — which is why the owner ruled for an informed grant rather than a refusal. `[]` is admitted because acknowledging zero is a TRUE statement at the moment of the grant, and because seating the team afterwards runs §2a's subset rule at the choke point: an empty group can only be filled by a principal who already holds everything it carries.

`undefined` and `[]` are therefore NOT the same value here — "I did not look" versus "I looked and it is empty" — and this case measures both against the same empty team.

### §321. WIRES A CREDENTIAL ONTO AN EXISTING GRAPH OBJECT

WIRES A CREDENTIAL ONTO AN EXISTING GRAPH OBJECT — a `users` row naming it, with a local password — and returns a token proving the wiring works.

WRITTEN STRAIGHT INTO `users` ON PURPOSE, and it is not a shortcut around a door: there is no API that creates a `users` row at all. A filterless census of `apps/server/src` finds three writers and all three are internal (`auth/local-auth.ts`'s bootstrap, `auth/oidc.ts`'s JIT provision, and the harness). So for a SERVICE ACCOUNT this IS the deployment procedure — the measured answer to "a service account will have its own shape" is that it has none: there is no service-account token table, `personal_access_tokens` is keyed on `users.id`, and `POST /api/v1/service-accounts` creates a graph object and nothing more.

IT LOGS IN BEFORE RETURNING. Asserting the row exists would prove the fixture wrote a row; logging in proves the principal can authenticate, which is the property the floor claims to count.

### §322. MEASURED BEFORE THIS REVISION

MEASURED BEFORE THIS REVISION — three plain sequential requests, all 2xx, no concurrency and no privilege beyond the bootstrap admin's, ending with `GET /roles` -> 403 and hand-written SQL the only recovery. This is the THIRD shape this predicate has been bypassable with: it counted binding ROWS (an empty group satisfied it), then live OBJECTS OF A PRINCIPAL TYPE (this case), and now counts principals that can AUTHENTICATE.

### §323. THE ADMISSION PAIR

THE ADMISSION PAIR — the identical verb on the identical binding, differing ONLY in whether a principal that can actually sign in survives. Without it the refusal above passes just as well against a floor that refuses every revoke of an org-root Owner binding.

### §324. THE OTHER DIRECTION, IN THE SAME ORG

THE OTHER DIRECTION, IN THE SAME ORG: a PHANTOM service account does not count. Same object type, same role, same scope, same actor — only the `users` row differs. This is what says the anchor is the credential rather than the type, in both directions at once.

### §325. The defect: the preview admitted a scoped holder

THE DEFECT: the preview took a `scopeObjectId` and admitted a holder of `audit:read` at-or-above THAT object — an object the CALLER names. So any scoped `audit:read` holder could name their own service and read the full transitive membership of ANY group in the org. That is §2b's disclosure defect re-introduced one layer up, in the affordance built to make D7 usable.

### §326. THE OLD EXPLOIT, VERBATIM

THE OLD EXPLOIT, VERBATIM — the parameter is gone from the contract, so naming a scope the caller does hold `audit:read` at changes nothing. Asserted rather than assumed, because a plain `z.object` STRIPS unknown query keys at runtime instead of rejecting them: a handler that still read the value would answer 200 here and this file would be the only thing that could tell.

### §327. The admission pair, which says the fix is an anchor

THE ADMISSION PAIR, and it is what says the fix is an ANCHOR rather than "org-root only": the same scoped-only shape of principal, holding `audit:read` at the SUBJECT, is admitted — and is still refused for a team it has no standing over. Same caller, same door, same verb.

### §328. This case asserted the wrong thing here, and why

⚠️ THIS CASE ASSERTED `acknowledgedPrincipalIds === [insider.objectId]` HERE, AND THAT WAS THE NEXT DEFECT. Anchoring the GATE at the subject settles who may ask; it cannot settle what may come back, because the principals disclosed are NOT the subject. This caller is admitted (the anchor is a real arm) and is shown NOBODY, because `object:read` at a team reaches the team and nothing through it. The projection is measured in "the preview discloses only principals the caller could read individually" below; what is pinned here is the ARM.

### §329. THE DEFECT, MEASURED BEFORE THIS ROUND

THE DEFECT, MEASURED BEFORE THIS ROUND: anchoring the GATE at the subject settles who may ASK about a group and settles nothing about what comes BACK, because **the principals disclosed are not the subject**. A member is a separate graph object on its own containment chain and `scopeExpandCte` expands UPWARD, so `audit:read` at a TEAM says nothing whatever about that team's members — and a team-scoped Viewer received a 200 carrying a member's id, typeId and name.

### §330. WHAT THIS CALLER CANNOT ALREADY READ

WHAT THIS CALLER CANNOT ALREADY READ — ESTABLISHED, NOT ASSUMED. The acceptance bar is "the preview must not tell a caller anything they could not already read", and half of that sentence is a claim about OTHER doors. If any of these four ever starts answering, the projection below is stricter than it needs to be and this case says so by going red.

### §331. THE ADMISSION PAIR

THE ADMISSION PAIR — the caller who NEEDS the preview is not the caller who is refused by it. Same door, same subject, same verb; the only difference is where their `audit:read` is bound. A plain org-root VIEWER, deliberately, rather than the bootstrap Owner: the claim being measured is about the org-root ARM, not about being an administrator.

### §332. WHY THAT ADMISSION GENERALISES, verified rather than assumed

WHY THAT ADMISSION GENERALISES, verified rather than assumed. The claim the design rests on is "a caller admitted by the ORG-ROOT arm can already read every rooted object in the org", and it is true only because of a property of the SEEDED CATALOGUE: every built-in role carrying `audit:read` also carries `object:read`. Read from the live catalogue, so a future migration seeding an `audit:read`-without-`object:read` role fails HERE — where the reasoning is — rather than as a mysterious `withheldPrincipalCount` in the field.

### §333. The residual population, measured rather than ruled out

THE RESIDUAL POPULATION, MEASURED END TO END RATHER THAN RULED OUT. Filtering the projection is only defensible if the granter who needs the acknowledgement can still produce one. For an org-root granter that is trivial (the case above). This is the OTHER caller: `audit:read` at-or-above the group from a binding BELOW the org root, whose `object:read` does not reach a member that lives elsewhere in the estate. They get an incomplete preview — and they are NOT handed a field that 409s forever, because the grant door's own 409 names every id it was not given, behind `role_binding:write` plus the whole subset rule, which is a strictly stronger bar than this preview's `audit:read`.

### §334. The role id is read with the admin's token, deliberately

The role id is read with the ADMIN's token, and that is not a shortcut: `GET /roles` is pinned at the org root by design (`routes/role-bindings.ts` says so at the route — the catalogue is scopeless platform metadata), so this scoped granter cannot read it and gets a 403. Costing a scoped principal a role PICKER is the affordance that comment accepts; it is fixture plumbing here, not the thing under test.

### §335. The walk joins the user table to decide credentialed

`principalsReachedBy` LEFT JOINs `users` to decide `credentialed`, and `users` is auth substrate with NO ROW-LEVEL SECURITY (drizzle/0002 §1 grants `scp_app` SELECT and never enables RLS). So `u.org_id = <this org>` is the ENTIRE tenant boundary for the floor's fifth input — every other read in that module is fenced by RLS on `objects`/`relationships`, and this one is fenced by a predicate a refactor can delete without any test noticing.

IT WAS NOT PINNED, and the reason is worth stating: `users.object_id` values do not collide across orgs by accident, so "what fails if I drop it" returned nothing — a census by SYMPTOM. The census by PROPERTY is "a row in another tenant's `users` naming an object in this one", and `users.object_id` has no FOREIGN KEY and no unique constraint (`db/schema.ts`), so that row is a plain INSERT rather than a database-refused impossibility.

### §336. THE ADMISSION PAIR

THE ADMISSION PAIR — the identical revoke, the identical phantom, the identical role and scope. The ONLY difference is which org the `users` row naming it belongs to. Without this, the refusal above passes just as well against a floor that stopped counting credentials at all, or against one that refuses every org-root Owner revoke.

### §337. DOOR B and DOOR C above prove these two routes RETURN 409

DOOR B and DOOR C above prove these two routes RETURN 409. Nothing above proves the contract SAYS SO — and the contract is what the SDK, the CLI and the UI are generated from, so an undeclared status is one a generated client types as impossible. This reads the same `routeRegistry` -> `buildOpenApiDocument` path `pnpm gen` writes `tools/openapi/openapi.v1.json` from, so it measures the artifact rather than the source.

## `apps/server/src/routes/rbac-permission-splits.integration.test.ts`

### §338. STEP 3 — THE THREE PERMISSION SPLITS AND THE FIVE PURPOSE ROLES

STEP 3 — THE THREE PERMISSION SPLITS AND THE FIVE PURPOSE ROLES (role-model.md §5 step 3)

`drizzle/0099` splits `secret:write`, `scan:override` and `change:accept` out of the two generic write verbs, deletes `org:admin`, and seeds SecurityOfficer / FederationAdmin / OrgAdmin / ServiceAdmin / ComponentAdmin. Two of those splits change who can do what on a live deployment, and role-model.md §8.5 measured why that is dangerous here: all 334 `403` occurrences across `apps/server`'s tests were enumerated and **zero** of them pinned any of the behaviour this increment moves. So the splits would otherwise ship with nothing holding them to anything.

EVERY CASE BELOW ENTERS AT THE ROUTE, through `app.inject`, with a real bearer token from the real login flow, against real PostgreSQL. Asserting `hasPermission()` directly would prove the resolver agrees with itself and say nothing about whether the door demands the permission — which is precisely the failure class this repo keeps hitting (a component built and wired nowhere).

THE PAIRING RULE THIS FILE FOLLOWS
Every refusal is paired with an ADMISSION on the same door with the same request body, differing only in the actor's role. A lone 403 proves nothing — a typo'd URL, a schema rejection or a missing fixture all produce one — and the pair is what says the ACTOR'S STANDING decided it.

MUTATION LOG — each applied ALONE, measured, then reverted (2026-08-27)
1. `routes/executors.ts` PUT /secrets/:key — `secret:write` -> `object:write` -> "the credential doors refuse org-root `object:write` alone" FAILED: `{"configured":true,"key":"cred-c76be3f0"}: expected 200 to be 403`. 2. `routes/scan-override-grants.ts` `decide` — deleted the whole `scan:override` `authorize()` -> "DECIDING refuses a `policy:write`-only principal" FAILED: `expected 200 to be 403`, the body carrying `"status":"approved"` — the OrgAdmin really did sign the waiver. 3. `routes/changes.ts` accept handler — `assertAcceptableAtEveryChangeTarget` -> `assertWritableAtEveryChangeTarget` -> "accept and rollback refuse an org-root `object:write` holder" FAILED: `expected 409 to be 403`, detail `illegal transition: 'proposed' -> 'accepted'` — i.e. the org-root Operator cleared authorization and reached the state machine. 4. `routes/changes.ts` CANCEL handler — `assertWritableAtEveryChangeTarget` -> `assertAcceptableAtEveryChangeTarget` -> "CANCEL still works for exactly that principal" FAILED: `expected 403 to be 200`, detail `subject '<id>' lacks 'change:accept' at scope '<orgId>'`. 5. `drizzle/0099` §1 — deleted the `array_remove(permissions, 'org:admin')` statement -> "`org:admin` is gone from Owner" FAILED: `expected [ 'approval:write', ...(22) ] to not include 'org:admin'`. 6. `drizzle/0099` §2c — added `'Operator'` to the `change:accept` grant's name list -> "Operator and Approver deliberately do NOT hold `change:accept`" FAILED: `Operator: expected [ 'audit:read', 'change:accept', ...(7) ] to not include 'change:accept'` — AND case 3 FAILED too (`expected 409 to be 403`). The seed half and the door half agreeing is what says they are the same fact. 7. `drizzle/0099` §3C — added `'scan:override'` to OrgAdmin's permission literal -> "the separation of duty is real" FAILED: `expected [ 'approval:write', ...(17) ] to not include 'scan:override'` — AND "DECIDING refuses a `policy:write`-only principal" FAILED (`expected 200 to be 403`), which is the SoD claim and its enforcement measured as one thing.

Each mutation was CONFIRMED APPLIED before its run, and confirmed REVERTED after — the migration ones by re-reading the `.sql` off disk, the route ones by `git diff --stat` plus a call-site count. A mutation that never landed is a false negative, and this programme has produced one.

### §339. THE PRINCIPAL IS THE ONE THE SPLIT EXISTS TO STOP

THE PRINCIPAL IS THE ONE THE SPLIT EXISTS TO STOP: org-root `Operator`, which holds `object:write` at the org root and therefore satisfied all three of these doors on every deployment before 0099. Three unrelated blast radii shared that one grant — writing the tokens SCP dials GitHub/ArgoCD/Terraform with, DELETING them (an availability kill switch for all coordination), and rotating the HMAC secret that authenticates inbound webhooks, where whoever sets it can thereafter forge signed source events.

### §340. The state-machine bar, not an authority one

The state-machine bar, not an authority one: `securityOfficer` clears BOTH permission bars in every call below. `approve` requires `requested` and `revoke` requires `approved`; `deny` used to require nothing, so `approved -> denied` silently took a LIVE waiver away through the verb that answers a request, skipping revoke's precondition and writing a transition no docblock in the route describes.

### §341. THE SAME ACTOR, THE SAME CHANGE SHAPE, THE OTHER VERB

THE SAME ACTOR, THE SAME CHANGE SHAPE, THE OTHER VERB. Cancelling STOPS a release rather than authorizing one, so it deliberately stays on `object:write` alone. Folding it into `change:accept` would make a cancel-only incident-responder role inexpressible — and that is the role an on-call rota most obviously wants, which is why it is pinned beside the breakage rather than in a file of its own.

### §342. That permission is here, and its absence was a real bug

`federation:pair` IS here, and its absence was a real bug this assertion caught. A first draft of 0099 withheld it fail-closed because §3C's list omitted it while §4.1 and D4 both granted it — the proposal contradicting itself. Owner ruling D6 (2026-08-27) resolved it in D4's favour: FederationAdmin is the ONLY deliberate withholding, because operating a link is not establishing one. Withholding it from OrgAdmin too would leave an org whose only pairing principals are Owner and the D5-deprecated Administrator.

NOT `scan:override`, and that is the design's whole separation of duty: OrgAdmin authors org policy with `policy:write` and cannot waive a scan verdict, SecurityOfficer can waive and holds no `object:write`, and neither is the other. Nor the three bypasses (`freeze:override`, `change:emergency`, `campaign:deadline-override`).

### §343. Org root ONLY, and both are MECHANICAL rather than conventional

Org root ONLY, and both are MECHANICAL rather than conventional: * SecurityOfficer — `OVERRIDE_APPROVAL_TIER_FLOOR = 'org'` and `tierForObjectType` maps no graph object above org, so a domain-bound officer would mint waivers that are approved, audited and INERT. * FederationAdmin — all 14 federation doors pass `scopeObjectId: auth.orgId`, so a narrower binding holds every permission and fails the SCOPE check on every door: a trap.

## `apps/server/src/routes/rbac-role-binding-door.integration.test.ts`

### §344. STEP 5 — THE ROLE AND ROLE-BINDING WRITE DOOR

STEP 5 — THE ROLE AND ROLE-BINDING WRITE DOOR (role-model.md §5 step 5)

`role_binding:write` was seeded onto Administrator and Owner by `drizzle/0002` and checked at ZERO call sites for its entire life. `routes/role-bindings.ts` is the first thing that checks it — and a door that GRANTS AUTHORITY is the most escalation-prone surface in the programme, because every other door in the system can be opened by writing the right binding at this one.

So this file is not "coverage for four new endpoints". It is the behavioural record of eight invariants, each of which ships a working-looking escalation if it is missing:

```text
1. `role_binding:write` AT-OR-ABOVE the binding's scope — NECESSARY, and NOT SUFFICIENT.
2. THE NO-ESCALATION SUBSET RULE, computed by running `hasPermission` per permission of the
   TARGET role — never by reading the actor's own role rows — and applied on DELETE TOO.
3. `effect` is not settable through the write API, by any path.
4. `bindable_at` is validated, because `role_bindings.scope_object_id` has no type constraint.
5. D5 — `Administrator` refuses NEW bindings and names a purpose role; EXISTING ones resolve.
6. An audit event AND a Decision per grant and per revoke, IN THE SAME TRANSACTION as the write.
7. THE SAME SUBSET RULE ON A `member_of` EDGE (§8 below, `role-binding-door.ts` §2a). Writing a
   membership into a role-bearing group confers that role with NO `role_bindings` row, so
   invariant 2 is only true if this one is. The guard lives at
   `graph/relationships-repo.ts`'s `createRelationship` rather than at `POST /relationships`,
   and NOTHING IN THIS FILE CAN TELL THE DIFFERENCE — that is
   `iac/iac-member-of-role-escalation.integration.test.ts`'s job, measured in mutation 13.
8. THE ADMINISTRATOR FLOOR (§9 below). Not an authority bar — both bars pass legitimately
   when the org's only Owner revokes itself, and the org is then unadministrable forever.
   **THIS FILE MEASURES ONE OF ITS FOUR DOORS.** The floor is an invariant of the ORG, not a
   rule on the revoke handler: `DELETE /relationships/{id}`, `DELETE /objects/team/{id}` and
   `DELETE /objects/user/{id}` can each empty it in four plain sequential requests, and
   `routes/rbac-administrative-floor.integration.test.ts` is where those are pinned. Nothing
   here would fail if the other three regressed.
9. D7's ACKNOWLEDGEMENT is likewise measured in that file, not here. What this file's `grant()`
   helper does is AUTO-ACKNOWLEDGE, so cases about the subset rule are not also cases about
   D7 — see its docblock.
```

THE REFUSALS ARE THE FEATURE, AND EVERY ONE IS PAIRED WITH AN ADMISSION
A lone 403 proves nothing — a typo'd URL, a schema rejection, a missing fixture and a genuinely enforced bar all produce one. So every refusal below is paired with an ADMISSION on the same door with the same body, differing only in the actor or in the single field under test. The pair is what says the ACTOR'S STANDING decided it rather than the request being malformed.

EVERY CASE ENTERS AT THE ROUTE through `app.inject`, with a real bearer token from the real login flow, against real PostgreSQL. Calling `assertMayWriteRoleBinding` directly would prove the guard agrees with itself and say nothing about whether the ROUTE calls it — which is this repo's dominant failure (a component built, tested, and wired nowhere).

WHY THE EXPECTED PERMISSION SETS ARE COMPUTED FROM `GET /roles` AND NOT HARD-CODED
`roles.permissions` is a mutable `text[]` — eight migrations have appended to the built-ins so far. A literal `["freeze:override", "change:emergency", "campaign:deadline-override"]` in this file would be a SECOND copy of the seed that drifts from it silently, and the drift direction that matters is the dangerous one: a migration that quietly hands OrgAdmin `freeze:override` would make the escalation case start passing for the wrong reason. `permissionsOf` reads the live catalogue through the API, and `missingFor` derives the exact refusal set from it, so the assertion is "everything the target role has that the actor lacks is named" — which stays true whatever the arrays become, and fails loudly if the difference ever becomes empty.

FIXTURE BINDINGS ARE WRITTEN THROUGH THE HARNESS, NOT THROUGH THE DOOR — DELIBERATELY
`createTestUser` writes `role_bindings` rows straight through the repo layer, applying none of this door's refusals (its docblock says so). That is what makes the fixtures this file needs possible AT ALL: an EXISTING `Administrator` binding that pre-dates D5's deprecation, and an `OrgAdmin` binding at a SERVICE that `bindable_at` would refuse — both are exactly what a live deployment's hand-written SQL left behind, which is the population the door has to keep working for. Anything this file MEASURES goes through the route.

MUTATION LOG — each applied ALONE, CONFIRMED ON DISK, measured, then reverted (2026-08-27)
Every mutation below was confirmed to have landed by re-reading the mutated file off disk (`grep -nac` on the injected marker, checked against a known-positive count) BEFORE the run, and confirmed reverted by the same count going to zero afterwards. A mutation that never applied reads as a pass, and this programme has produced one.

The failure counts include CASCADES, and the cascades are part of the measurement: two of these mutations let an OrgAdmin delete the org's own Owner binding, after which the bootstrap admin's token stops working and six later cases fail on `audit:read`. That is what the defect does to an estate, not noise.

1. `app.ts` — deleted `registerRoleBindingRoutes(app, deps);` (import left in place, so the module still compiles and still type-checks — "built, never installed" exactly) -> **THE WHOLE SUITE DIED, 21 skipped, 1 failed suite.** The `beforeAll` hook threw `GET /roles setup failed: 404 {"message":"Route GET:/api/v1/roles not found",...} — the role-binding routes are NOT REGISTERED. Check that `app.ts` still calls `registerRoleBindingRoutes(app, deps)`; the module compiling is not the same fact as the door being installed.` Nothing else in the tree noticed: `tsc --noEmit` was clean. 2. `role-binding-door.ts` §2 — deleted the whole subset-rule loop and its `throw forbidden` -> **10 failed.** Four directly: "an org-root `role_binding:write` holder CANNOT mint themselves Owner" (`expected 201 to be 403`, the response body carrying `"roleName":"Owner"` — the OrgAdmin really did become Owner); "OrgAdmin CANNOT grant SecurityOfficer" (`expected 201 to be 403`, `"roleName":"SecurityOfficer"`); the `member_of` case's ceiling half; and "DELETE is refused when the binding OUTRANKS the caller" (`expected 200 to be 403`). Then six CASCADES — the Owner binding was really gone, and every later case using the bootstrap token failed `lacks 'audit:read' at the org root` / `lacks 'type_registry:read'`. 3. `role-binding-door.ts` §2 — replaced the per-permission `hasPermission` loop with a read of the actor's own `role_bindings` rows joined to `roles` (the "obvious" implementation) -> **1 failed, and only 1:** "the subset rule holds for authority inherited through `member_of`": `expected 403 to be 201`, detail `subject '<id>' may not grant role 'ComponentAdmin' at scope '<component>': it carries 10 permission(s) the subject does not itself hold there — approval:write, audit:read, change:accept, freeze:write, graph:query, object:read, object:write, relationship:read, relationship:write, type_registry:read`. Every other case stayed green, including all four escalation refusals. THIS IS THE MEASUREMENT THE DOOR'S DOCBLOCK IS ABOUT: one test is the whole distance between the correct implementation and the plausible one, and deleting it would leave a group-derived administrator silently unable to administer anything. 4. `routes/role-bindings.ts` DELETE handler — deleted the `assertMayWriteRoleBinding` call -> **7 failed.** Two directly: "DELETE is refused when the binding OUTRANKS the caller" (`expected 200 to be 403`, response body `"roleName":"Owner"`) and "DELETE also demands bar §1" (`expected 403 to be 201`). Five cascades, same mechanism as mutation 2. 5. `role-binding-door.ts` — `assertRoleBindableAtScope` early-returns unconditionally -> **1 failed.** "a binding at a NONSENSICAL SCOPE TYPE is refused": `expected 201 to be 422`, the body showing a `ComponentAdmin` binding landed on a `user` object. 6. `role-binding-door.ts` — `assertBindableSubject` early-returns unconditionally -> **1 failed.** "a binding to a NON-SUBJECT object is refused": `expected 201 to be 422`, the body showing a binding whose subject is a `component`. 7. `role-binding-door.ts` — `DEPRECATED_BUILTIN_ROLES` emptied to `{}` -> **2 failed.** "a NEW `Administrator` binding is refused and NAMES a purpose role": `expected 201 to be 422`, `"roleName":"Administrator"`. "`GET /roles` marks `Administrator` deprecated": `expected false to be true`. ONE mutation breaking BOTH is the measurement that the listing and the refusal are one fact rather than two that agree. 8. `roles-repo.ts` `insertRoleBinding` — `effect: "allow"` -> `effect: "deny"` -> **1 failed.** "`effect` cannot be set through ANY path": `expected 'deny' to be 'allow'`. Proves the case reads the PERSISTED effect rather than echoing the response. 9. THE MASS-ASSIGNMENT CLAIM HAS TWO LAYERS, so it took two mutations to find which one holds. 9a. `roles-repo.ts` — `effect: "allow"` -> `effect: (input as unknown as { effect?: string }).effect ?? "allow"`, AND `routes/role-bindings.ts` spreading `...body` into the insert input -> **0 failed, 21 passed.** The repo happily honours an `effect` it is handed; the request never carries one, because `CreateRoleBindingRequestSchema` is a plain `z.object` and Zod STRIPS the unknown key before the handler sees it. 9b. the same two edits PLUS `.passthrough()` on `CreateRoleBindingRequestSchema` (`packages/schemas` rebuilt to `dist` — apps/server imports the built package, and skipping that step is a FALSE GREEN) -> **1 failed.** "`effect` cannot be set through ANY path": `expected 'deny' to be 'allow'`. SO THE ZOD CONTRACT IS THE LOAD-BEARING LAYER, not the repo's literal. Anyone loosening that schema — for an unrelated field — re-opens this, and the repo's hard-coded `'allow'` is the belt, not the braces. 10. `routes/role-bindings.ts` POST — the `appendAuditEvent` call moved OUT of the write's `withTenantTx` and into a second one, awaited after the first committed -> **1 failed.** "a failure after the write rolls BOTH the binding and its audit event back (one transaction)": `the role binding survived a failure after the write — it is not in the audit event's transaction: expected [ { …(2) } ] to have a length of +0 but got 1`. The estate held authority that nothing recorded being granted — charter principle 6's exact failure mode. 11. `routes/role-bindings.ts` — `GET /role-bindings`'s `if (!verdict.ok)` -> `if (false && ...)` -> **1 failed.** "`GET /role-bindings` demands `audit:read`": `expected 200 to be 403`, with a 20-row page of the org's ENTIRE binding table — every principal, role and scope — in the body of the response to a caller holding nothing.

MUTATION LOG, ROUND 2 (2026-08-27) — §2a's `member_of` guard and §7's last-administrator floor
12. `graph/relationships-repo.ts` — deleted the whole `if (type.id === "member_of" && !input.federationImport)` block -> **1 failed here** ("THE EXPLOIT CHAIN": `expected 201 to be 403`, the response body being the minted edge itself — `"typeId":"member_of"`, `"deletedAt":null` — from the Operator's user object to the Owner-bearing group) **plus 1 in `iac/iac-member-of-role-escalation.integration.test.ts`**. Both doors, one deletion. 13. THE SAME BLOCK MOVED into `routes/relationships.ts`'s POST handler — the "obvious" placement, byte-identical call -> **0 failed in THIS file, 25 passed; 1 failed in the IaC file.** Every case here that names the escalation passed against a placement that leaves `POST /plans/{id}/apply` minting the edge. This file cannot see the difference, which is exactly why the IaC case exists and why the guard is at the choke point. 14. `role-binding-door.ts` — `assertNotLastAdministrativeBinding` early-returns unconditionally (**THE FUNCTION IS GONE**, replaced 2026-08-27 by the org-wide `assertOrgRetainsAdministrativeFloor` this handler now calls AFTER the delete; the equivalent mutation is number 3 in `routes/rbac-administrative-floor.integration.test.ts`'s log, which fails these same two cases plus five more across two other files) -> **1 failed.** "the LAST org-root administrative binding cannot be revoked": `expected 200 to be 409`, the body being the org's only `"roleName":"Owner"` binding, returned as successfully revoked. That is the brick. 15. `role-binding-door.ts` — `if (remaining > 0) return;` -> `if (remaining < 0) return;`, making the floor a BLANKET refusal of every org-root administrative revoke -> **2 failed.** The ADMISSION half of the same case (`expected 409 to be 200` revoking one of TWO Owners) and, separately, "an EXISTING `Administrator` binding is REVOKABLE". Without this mutation the guard could refuse everything and case 14 would still be green. 16. `role-binding-door.ts` — `missingPermissionsFor`'s per-permission `hasPermission` loop replaced by a read of the actor's own `role_bindings` rows (mutation 3's shape, re-measured because the loop was EXTRACTED into a shared helper in this round and an extraction can lose the property) -> **1 failed, and only 1:** "the subset rule holds for authority inherited through `member_of`". Identical to the original measurement, so the one-definition refactor kept the distinction the whole door rests on.

MUTATION LOG, ROUND 3 (2026-08-27) — §0's ORG LOCK, §2b's ORDERING, and the role-NAME measurement
EVERY ONE OF THESE FIRED ON ATTEMPT 0 of its loop. Applied alone, confirmed on disk by a `grep -nac` on the injected marker before the run and by the same count going to zero after.

17. `routes/role-bindings.ts` DELETE handler — deleted `await lockOrgRoleAuthority(tx, auth.orgId);` (the transaction, both authority bars and §7's floor all left intact) -> **1 failed, on attempt 0.** "CONCURRENCY: two simultaneous revokes cannot empty an org's administrative bindings": `expected [ 200, 200 ] to deeply equal [ 200, 409 ]`, both response bodies being the `"roleName":"Owner"` binding each actor had just successfully revoked. THAT IS THE BRICK, in one round trip. Every sequential case in this file — including the two that exist specifically to pin §7 — stayed green against it. 18. `role-binding-door.ts` — deleted the lock from `assertMayJoinRoleBearingSubject` -> **1 failed, on attempt 0.** "CONCURRENCY: a `member_of` join and a grant onto the same team cannot both be admitted": `[201, 201]`, the bodies being the SecurityOfficer binding on the team and the `member_of` edge into it. Neither door saw the other's write. 19. `routes/role-bindings.ts` POST handler — deleted the lock there, leaving §2a's intact -> **1 failed, on attempt 0**, same case, same `[201, 201]`. Proving BOTH sides separately is what says one instrument covering the whole org is required rather than a guard on each door: with either side unlocked there is no mutual exclusion at all. ⚠️ This mutation did NOT fail against the case's first fixture (grant `Owner`, empty team) — 6 attempts, all green. The grant path reached §2b about fifteen round trips after the join had already committed, so the join simply always won and the outcome was always a legal SERIAL one. The fixture now grants the 9-permission `SecurityOfficer` and pre-binds a benign `Viewer` to the team; both are documented at the case. A mutation that does not fire is not evidence the code is right, and this one nearly read as such. 20. `routes/role-bindings.ts` POST — `assertGrantReachesOnlyBindableMembers` moved back IN FRONT of `assertMayWriteRoleBinding` (its original position) -> **1 failed.** "§2b's 422 names group members only AFTER the authority bars": `expected 422 to be 403`, and the 422's detail — handed to a principal holding no `role_binding:write` anywhere — named the group's member by NAME, by id and by type. 21. `role-binding-door.ts` `assertMayWriteRoleBinding` — added the role-NAME bar §2a says it deliberately does not add (`hasRoleAtScope(actor, role.name, scope)`) -> **1 failed.** "MEASUREMENT (open, not a guard): role NAME authority is conferred by a permissions-subset grant": `expected 403 to be 201`. The measurement is therefore not vacuous — it changes colour the moment anyone closes the property it records.

NOT MUTATION-PROVEN, and named rather than left implied:

```text
- the duplicate-grant 409. Its guard is `role_bindings_grant_key` (drizzle/0097) plus
  `isUniqueViolation`, and every mutation available turns the 409 into a 500 rather than into the
  silent second row the case is about — so the test pins the surfaced conflict, and
  drizzle/0097's own suite pins the constraint.
- §2a's FEDERATION-IMPORT CARVE-OUT. No case here builds a signed bundle, so nothing would fail
  if the `!input.federationImport` condition were dropped and a peer's membership entry started
  403ing — which would wedge that peer's whole bundle. `federation/import-repo.ts`'s own suites
  do not carry a `member_of` entry either.
- §2a's NESTED-GROUP closure. `inheritableBindingsOf` seeds `subjectExpandCte` at the target
  group, so joining group G also inherits the bindings of every group G is itself `member_of`.
  Every case here uses a flat group, so narrowing that query to the group's OWN bindings would
  not fail anything.
- §2a's `effect = 'allow'` filter. Inheriting a `deny` narrows the joiner and is deliberately not
  gated; no case builds a group holding a deny row.
- §0's lock against a THIRD writer. Both concurrent cases fire exactly two requests. A pair of
  concurrent `member_of` joins, or a join racing an IaC apply, is covered by the same lock and is
  not measured here.
```

### §345. Everything the target carries that the actor does not

Everything `target` carries that `actor` does not — the EXACT set the subset rule must name in its refusal. Derived from the live catalogue rather than written down, so a migration that changes either array changes this expectation with it.

Asserts non-empty: if a future migration ever made the difference empty, the refusal case would silently become an admission case still spelled as a refusal, which is the vacuous-test shape this repo keeps producing.

### §346. A brand-new principal holding nothing, as the subject

A brand-new principal holding NOTHING, to be the passive SUBJECT of a grant.

ONE PER CASE, NEVER SHARED. `role_bindings_grant_key` (drizzle/0097) makes `(org, subject, role, scope, effect)` unique, so a subject reused across two cases turns the second one's 201 into a 409 — and the first draft of this file hit exactly that. Worse than the noise: a grant landing in case A silently changes what case B's actor HOLDS, which moves the subset rule's answer. The Owner-escalation case measured 3 missing permissions instead of 4 because an earlier case had granted `SecurityOfficer` to the actor as its own admission half. Fresh subjects make every case's authority state a function of the fixture alone.

### §347. The `member_of` closure below an object

The `member_of` closure below an object — D7's `acknowledgedPrincipalIds` value — read with the DOOR'S OWN walk rather than re-derived here. A fixture helper, not an assertion: the affordance a real client uses (`GET /role-bindings/grant-preview`) is measured on its own case, and using it for every fixture would make an unrelated preview regression fail thirty cases about something else.

### §348. AUTO-ACKNOWLEDGES BY DEFAULT

AUTO-ACKNOWLEDGES BY DEFAULT (D7). Every case in this file that predates the acknowledgement is about something else — the subset rule, `bindable_at`, D5 — and would otherwise 422 on a field it is not measuring. Pass the key EXPLICITLY (including `undefined`, which JSON serialisation drops, producing an absent field) to control it; the D7 cases all do.

The auto value is computed at CALL TIME, after whatever fixture the case has just built, which is exactly what a correct client does.

### §349. The group-derived administrator

The group-derived administrator. `groupBinder` holds NOTHING directly; the authority is on the GROUP, and `hasPermission`'s `subject_expand` walks `member_of` from_id -> to_id to find it. A door that read `role_bindings WHERE subject_id = groupBinder` sees zero rows.

⚠️ THE EDGE IS WRITTEN BEFORE THE GROUP'S BINDING, AND THAT ORDER IS LOAD-BEARING NOW. §2a's guard refuses a `member_of` write into a group that ALREADY holds bindings the actor does not hold; writing the membership first (into a group that holds nothing) is the shape a real deployment uses too — seat the team, then grant it a role. Reversing these two statements would make this fixture fail at setup, which is the correct behaviour and not a bug in it.

### §350. Deleting the wiring is the only check that works here

THE ONLY CHECK THAT WORKS for this repo's dominant failure class is deleting the wiring and watching a test die. `app.ts`'s comment beside `registerRoleBindingRoutes(app, deps)` names this case; delete that line and every assertion below turns into a 404, starting here.

All four verbs, because Fastify registers them independently and three of the four could be present while one was dropped in a merge — which would read as "the door is installed".

### §351. A binder holding root-grade permissions, bound at a service

`scopedBinder` holds org-root-grade permissions, bound AT `serviceS`. `scopeExpandCte` walks UPWARD from the binding's scope object, so the question "does the actor hold `role_binding:write` at THIS scope" resolves true for `serviceS` and everything beneath it, and false for a sibling service. The asymmetry IS the security property — a binding at a component never reaches its service, and one at a service never reaches its sibling.

### §352. The case distinguishing a correct implementation from one

THE CASE THAT DISTINGUISHES A CORRECT IMPLEMENTATION FROM THE OBVIOUS ONE. `groupBinder` has ZERO rows in `role_bindings` — its whole authority is the group's org-root OrgAdmin binding, reached by `hasPermission`'s `subject_expand` walking `member_of`. A door that answered the subset question by reading the ACTOR'S OWN role rows sees an empty array here and refuses every grant, so a group-derived administrator would be silently unable to administer.

### §353. THE REVOKE PATH APPLIES BOTH BARS, not just the subset rule

THE REVOKE PATH APPLIES BOTH BARS, not just the subset rule. `serviceAdmin` has full authority over `serviceS` and no `role_binding:write` anywhere.

WHICH BAR REFUSED IS READ OFF THE MESSAGE, not inferred from the status code — both bars throw 403. Bar §1 is evaluated FIRST and `authorize` names the permission and the scope; bar §2's refusal is a different sentence entirely ("may not revoke a binding of role …"), so a body containing `role_binding:write` is bar §1 and nothing else.

### §354. A deny row overrides every allow at any matching scope

A `deny` row overrides every `allow` at any matching scope, so a writable `effect` would let a `role_binding:write` holder DISABLE authority rather than confer it — and the subset rule is unsound for that direction (writing a deny is not granting authority, so "is deny-X a subset of my permissions" is a category error, not a hard question). The contract therefore has no `effect` at all, and the repo hard-codes `'allow'`.

MEASURED AT THE PERSISTED ROW, never at the response body: a handler that echoed its input would satisfy an assertion on the response while writing whatever it liked.

### §355. The scope column is a bare reference, with what that means

`role_bindings.scope_object_id` is a bare `uuid NOT NULL REFERENCES objects(id)` with no type constraint, so a binding at a `user` is accepted by the database and silently INERT. Inert is not the end of it: `objects.domain_id` carries no type constraint either, so an object parented under that `user` would make the binding SUDDENLY CONFER AUTHORITY — a grant that was harmless when written and is not afterwards, with nothing in between to notice.

### §356. `legacyAdministrator` was bound before the deprecation

`legacyAdministrator` was bound before the deprecation (through the harness, exactly as a live deployment's hand SQL did). Every such binding must keep working, or D5 is a breaking change that 403s the estate's administrators on upgrade.

PROVEN AT AN UNRELATED DOOR, not at this one: `secret:write` is Administrator-tier (drizzle/0099 §2a) and an Operator is refused it, so a 200 here is the ROLE resolving rather than the endpoint being ungated.

### §357. The audit event must be written in the same transaction

CHARTER PRINCIPLE 6 requires the audit event to be written in the SAME TRANSACTION as the action. The failure mode it exists to prevent is authority that exists with nothing recording that it was granted — which is precisely what an audit append in a second transaction produces the first time it fails.

FORCED, not simulated: a trigger on `audit_events` that RAISEs when the reason matches a magic string. The grant's row insert and its Decision both happen BEFORE the audit append, so if the three are not one transaction the binding survives the failure.

### §358. Measured before the guard, with real requests

MEASURED BEFORE THE GUARD, with real requests, and it is the whole reason §2a exists:

```text
step 0  OrgAdmin mints itself Owner                                        -> 403 (§2 holds)
step 1  Owner binds Owner to a GROUP                                       -> 201
step 2  Operator POST /relationships {member_of, from:<self>, to:<group>}  -> 201
step 3  resolve                                                            -> Operator IS Owner
```

`authz/resolve.ts`'s `subject_expand` walks `member_of` from_id -> to_id, so a binding held by a group resolves for every member. Creating that edge takes `relationship:write` at BOTH endpoints — a check designed for exactly this attack, which only constrains a principal whose `relationship:write` is NARROW. An org-root Operator's is not, so the escalation floor was OPERATOR: four rungs below Administrator.

### §359. STEP 2 — and this is the request that used to answer 201

STEP 2 — and this is the request that used to answer 201.

The actor holds org-root `relationship:write` at BOTH endpoints, so the pre-existing both-endpoint check passes and cannot be what refuses this. The companion case below proves that positively: the SAME actor joins a binding-free group and gets 201.

### §360. REMOVAL IS A NARROWING AND STAYS UNGATED, in both directions

REMOVAL IS A NARROWING AND STAYS UNGATED, in both directions. Taking a principal out of a group takes authority AWAY, so gating it on holding the authority being removed is how a compromised membership becomes unremovable. Proven on the ROLE-BEARING group, which is the only shape where the distinction can be observed: the Operator cannot join it (above) and must still be able to leave it.

### §361. MEASURED ON A FRESH ORG before the guard

MEASURED ON A FRESH ORG before the guard: `DELETE /role-bindings/<own Owner binding>` returned 200 and left ZERO bindings. Every endpoint then 403s — `GET /roles` and `GET /role-bindings` included — and nothing can restore a binding, because restoring one needs the `role_binding:write` that nobody now holds. The only fix is hand-written SQL, which is verbatim the failure mode `packages/schemas/src/rbac.ts` says this door exists to eliminate.

BOTH AUTHORITY BARS PASS LEGITIMATELY, so this cannot be fixed by tightening either: the actor holds `role_binding:write`, and Owner's permissions are trivially a subset of Owner's. Nothing counted what would be left.

A FRESH ORG, because the shared fixture org has four org-root `role_binding:write` holders and the guard is therefore silent there — which is itself the point of the admission half.

### §362. Tombstone an object's row while leaving its edges live

Tombstone an object's row while leaving its edges live — the shape a REPLICA edge, a federation-import object tombstone, or a pre-cascade restored dump produces. Written raw ON PURPOSE: `deleteObject` cascade-tombstones locally-authored edges, so the local `DELETE /users/{id}` path cannot produce it and a fixture built through that door would leave §2b's liveness arm untested while looking like it tested it.

### §363. THE REVERSED ORDERING, MEASURED END TO END

THE REVERSED ORDERING, MEASURED END TO END. §2a guards the join; this is the sequence that routes around it by joining BEFORE the group has anything to inherit.

WHAT THIS CASE PINS, and the wording is the point: step 2 is ADMITTED, and that is the correct answer rather than a hole this file failed to close. Every authority bar on the grant door is a question about the ACTOR, the ROLE and the SCOPE — `authorize('role_binding:write', scope)` and `missingPermissionsFor(actor, role.permissions, scope)` — and NONE of them reads the subject's identity. So "could this granter have granted Owner to this principal directly?" has the same answer for every principal in the org, and a refusal phrased that way could never fire. The assertion below states the measured outcome rather than an aspiration, so that if anyone later makes the grant door subject-sensitive this case fails and has to be re-reasoned.

### §364. Without this, the guard could refuse everything and pass

WITHOUT THIS THE GUARD COULD REFUSE EVERY GROUP GRANT AND LOOK CORRECT — and "bind SecurityOfficer to the security team" is the entire point of group bindings, so a blanket refusal here is an availability bug wearing a security guard's clothes.

Same role, same scope, same actor, a team with LIVE members: 201.

### §365. THE ROLE-**NAME** HOLE IN A PERMISSIONS-ONLY SUBSET TEST

THE ROLE-**NAME** HOLE IN A PERMISSIONS-ONLY SUBSET TEST. `hasRoleAtScope` resolves approval quorums by matching `rl.name` with NO `org_id` predicate, so a ZERO-permission org row named 'Approver' makes its holders eligible voters everywhere a policy names Approver. That row is vacuously a subset of everything, so `missingPermissionsFor` returns `[]` and the join door admitted it while the GRANT door (`assertRoleAcceptsNewBindings`) refuses writing it. One predicate now answers both.

The row and its binding are written raw because the API refuses to create either — which is the population this refusal is for: a hand-written row, or one from a restored dump.

### §366. MEASURED against the row-counting version of §7

MEASURED against the row-counting version of §7: bind a `role_binding:write`-carrying role to a team nobody is in, then revoke the real Owner. `count(*)` saw two rows, permitted the delete, and the org was left holding one binding that resolves for NOBODY — unadministrable, with hand-written SQL the only recovery, which is verbatim the failure mode the floor exists to eliminate. A guard bypassable in two requests is not a floor.

### §367. The message moved from naming types to naming reachability

The message moved from "live user or service account" to "live principal that can AUTHENTICATE" when the floor's anchor moved from the graph object's TYPE to the CREDENTIAL (`docs/authz/role-binding-door.md` §7, third revision — the phantom brick). Matched on the phrase that is about THIS case (an empty group) plus the permission, so the assertion stays about the refusal rather than about the sentence around it.

### §368. THE ADMISSION PAIR, AND IT IS THE POINT OF THE WHOLE FIX

THE ADMISSION PAIR, AND IT IS THE POINT OF THE WHOLE FIX: put a LIVE principal in that team and the identical revoke is admitted. Without this the floor could simply refuse every org-root revoke and the refusal above would still be green — and a group binding that never counts is the mirror availability bug (an org that seats its administrators through a team could never retire the bootstrap admin).

### §369. Concurrency: the third ordering, which is neither of those

12. CONCURRENCY — the third ordering, which is NEITHER

§7's floor and §2a/§2b are CHECK-THEN-ACT. Two earlier revisions of this door argued in comments that running the check inside the write's transaction made a race impossible. It does not: PostgreSQL's default READ COMMITTED gives every STATEMENT a fresh snapshot, so two concurrent transactions both read a survivor and both commit.

A SEQUENTIAL TEST CANNOT OBSERVE THIS. Every case above fires one request at a time and every one of them stayed green against the racy code — which is what made two rounds of reviewers believe the comments. These cases fire with `Promise.all` and assert the outcome is one a SERIAL execution could have produced.

### §370. The measurement this case exists for, on a fresh org

THE MEASUREMENT THIS CASE EXISTS FOR — fresh org, two different actors, `Promise.all` of two `DELETE /role-bindings` for the last two org-root administrative bindings, against §7 as it stood with the count and the delete in one transaction and NO LOCK:

```text
attempt 1 -> [200, 200]   administrative bindings remaining = 0   GET /roles = 403 ** BRICK **
attempt 2 -> [200, 409]   1 left
attempt 3 -> [409, 200]   1 left
```

That is the same brick §7 was written to eliminate, reached in ONE round trip instead of two, by an actor who needs no group and no second grant — strictly easier than the two-request bypass the reachable-principal rewrite closed.

REPEATED, because a race that fires two times in three still passes a single attempt one time in three. Each attempt gets its OWN org so the two actors are always the org's last two administrators.

### §371. Two actors each retiring their own binding at once

TWO DIFFERENT ACTORS, EACH RETIRING THEIR OWN BINDING, SIMULTANEOUSLY — which is the shape the brick was measured on. Each actor holds standing for its OWN request under every interleaving, so a refusal here can only be §7's 409 and never a 403 about the actor having lost the binding the other one deleted; that is what makes "exactly one 200 and one 409" an assertion about the floor rather than about which request lost a foot-race.

### §372. Why the instrument had to be one that covers both

THE OTHER HALF OF §0, AND WHY THE INSTRUMENT HAD TO BE ONE THAT COVERS BOTH. §2a reads `role_bindings` for a binding the concurrent grant has not written yet; §2b reads `relationships` for a membership the concurrent join has not written yet. Neither reads a row the other locks, so no `SELECT ... FOR UPDATE` anywhere can serialize them — only something that covers the org.

THE FIXTURE IS BUILT SO THAT **EVERY SERIAL ORDER REFUSES EXACTLY ONE OF THE TWO**, which is what makes the assertion deterministic rather than a coin flip:

```text
grant first -> grant 201 (the team's members are clean)
               join  403 (§2a: the team now holds SecurityOfficer, the actor is an Operator)
join first  -> join  201 (the team holds only a role the actor already has)
               grant 422 (§2b: the team now reaches a soft-deleted principal through G)
NEITHER     -> 201 + 201  <- the defect: the team holds the role AND reaches the joined group
```

THE TWO FIXTURE CHOICES BELOW ARE ABOUT THE WINDOW, and tuning them is safe because the assertion is an INVARIANT — under the lock it holds at any speed, so widening the window can only make a REGRESSION easier to catch, never make a correct implementation flaky. - `SecurityOfficer` (9 permissions) rather than `Owner` (20): the grant's subset rule runs one `hasPermission` per permission of the granted role, and §2b — the read that has to be protected on this side — runs AFTER all of them. - the team pre-holds `Viewer`, a role the Operator already has in full: §2a therefore reads a NON-empty binding set and runs its own probe loop after the read it has to protect, while still admitting the join. Without both, the join finishes about fifteen round trips before the grant reaches §2b, so a grant-side mutation is masked by the join simply always committing first.

### §373. The one grant-path message derived from other rows

§2b's refusal is the one message on the grant path derived from rows the request does not name: the ids, names and types of the principals inside a group. Ordered with the SHAPE refusals — where it originally sat, "because it IS one" — it answered "who is in this group?" for any caller who could reach the route, including one about to be told they have no standing at all. `docs/authz/role-binding-door.md` §7's 409 was already placed after the bars for exactly this reason; this case is what keeps the two consistent.

### §374. NOT A REFUSAL CASE

NOT A REFUSAL CASE. This records a property `docs/authz/role-binding-door.md` §2a and §8 state is OPEN, so that the statement in those comments is measured rather than asserted — and so that anyone who later closes it has a case that changes colour.

THE PROPERTY. A role confers two things: its permission array, and quorum eligibility wherever a policy names it — `hasRoleAtScope` matches `rl.name`, which is how `requireApprovals .fromRole: "Approver"` resolves. The subset rule compares permissions only, so an actor whose permissions are a strict superset of R's may grant R while holding no binding of NAME R. §2a's built-in-name-collision check does not reach this: the role here is the genuine built-in `Approver`, not an org row impersonating it.

## `apps/server/src/routes/relationships.ts`

### §375. The generic edge routes must never write a managed one

The generic `/relationships` write endpoints must never let a client create or delete an engine-owned relationship type directly (adversarial review MAJOR #7 for `approves`; M5 CRITICAL for `coordinates`). The full rationale — and why the dedicated authority-checked paths that legitimately create these edges still work (they call `createRelationship` directly, never this guarded HTTP route) — lives in `graph/system-managed-relationships.ts`. Enforced with 403, at BOTH create and delete.

### §376. Generic `/relationships` endpoints

Generic `/relationships` endpoints (DESIGN.md §4.1, §6) enforcing endpoint-type and cardinality constraints from the relationship type registry at write time.

Relationship writes (create/delete) require `relationship:write` at BOTH endpoints' scopes (DESIGN.md §7; PR #4 security review, CRITICAL 1). This is load-bearing, not pedantry: `member_of` edges feed RBAC subject expansion (authz/resolve.ts), so a from-side-only check would let any subject with `relationship:write` somewhere add themselves `member_of` an arbitrary team/group and inherit its role bindings. Applied uniformly to every relationship type — a member_of-only carve-out would just invite the next type-specific escalation.

### §377. THE SECOND, OPT-IN BAR on a `contains` write

THE SECOND, OPT-IN BAR on a `contains` write (proposal §9.2 door (c), owner ruling 2026-08-18). A `contains` edge IS a containment parent — route 2 of the same walk `objects.domain_id` is route 1 of — so creating one MOVES the `to` object into the `from` container, with exactly the governance-reach consequence a `domainId` write has. Only `contains`; every other relationship type is an ordinary edge and reaches nothing.

### §378. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7). Removing the `member_of` edge that makes an org's last administrative binding reachable is refused with 409 from `graph/relationships-repo.ts`'s `deleteRelationship` — a CHOKE POINT, so this route inherits the refusal and must declare it. Undeclared it would have been serialized as a bare Problem the generated SDK types as impossible. An added response code is additive under the oasdiff gate: `deleteRelationship` previously declared 200/401/403/404.

### §379. Deleting a `contains` edge is a MOVE TO THE ORG ROOT

Deleting a `contains` edge is a MOVE TO THE ORG ROOT: the child stops being contained by `from` and falls back to its `domain_id` route, which every rooted row terminates at. The destination is therefore the org root — and the org root is NOT exempt from this bar (unlike #244's `object:write` pair), because leaving a governed subtree for the top level is precisely the reach reduction `governance:move` gates. See `governance/move-enforcement.ts`.

## `apps/server/src/routes/role-bindings.ts`

### §380. `GET /roles` + `GET/POST/DELETE /role-bindings`

`GET /roles` + `GET/POST/DELETE /role-bindings` — role-model.md §5 step 5

The four operations that make `role_binding:write` real. It was seeded onto Administrator and Owner by `drizzle/0002` and demanded at ZERO call sites for its entire life, because there was no role-binding API at all — so a real deployment had exactly two authority levels (bootstrap admin -> Owner at the org root, `auth/local-auth.ts`; JIT OIDC user -> Viewer at the org root, `auth/oidc.ts`) and every finer scope was reachable only by hand-written SQL: outside RLS, outside the audit chain, with no Decision record. Every purpose role `drizzle/0099` seeds is inert until this file exists, which is why owner ruling D5 makes the seed and this door ONE shippable unit.

WHERE THE REFUSALS LIVE
`authz/role-binding-door.ts` — all of them, with the reasoning. This file resolves inputs, orders the checks, and writes. In particular the no-escalation SUBSET RULE (that module's §2) is what stops an org-root `role_binding:write` holder minting themselves an Owner binding; the natural "at-or-above the scope" rule alone does not, and shipping only the natural rule would have been an escalation door with a permission check on it.

ONE TRANSACTION, ALWAYS — AND ONE TRANSACTION IS NOT ENOUGH
Resolution, both authority bars, the write, the Decision and the audit event all run inside a single `withTenantTx`. Charter principle 6 requires the audit event to be written in the same transaction as the action.

An earlier revision of this paragraph went on to say the same transaction "is also what makes the CHECKS meaningful". **It is necessary and it is not sufficient**, and both handlers below now take `authz/role-binding-door.ts`'s org advisory lock as the FIRST statement of their transaction. PostgreSQL's default READ COMMITTED gives every statement a fresh snapshot, so two concurrent revokes of the last two administrative bindings each read a survivor and both commit — measured [200, 200] with the org left unadministrable. The lock, the measurement, why it is an advisory lock rather than `SELECT ... FOR UPDATE`, and what it does not cover are that module's §0.

WHY A DECISION RECORD AND NOT JUST AN AUDIT ROW
`audit_events` has no payload column, and a REVOKE hard-deletes the row it is about (there is no `deleted_at` on `role_bindings`) — so an audit event alone would record "somebody revoked <a uuid that no longer resolves>" and the estate would lose what authority was removed from whom. The `role_binding` Decision carries the structured before/after the way `freeze.lift` already does, and the audit event carries its `decision_id` plus the operator's own words.

NO DEDUP CONCERN (ADR-0024). These are one-per-API-call authoring records driven by a human pressing a button, not a predicate a reconcile loop restates every tick — which is where the unbounded-decision-growth incident came from. `insertDecision`, not `insertDecisionIfChanged`, matching `routes/governance.ts`'s freeze authoring calls exactly.

A FAILED BAR THROWS A RAW 403 rather than persisting a `blocked` Decision, matching the freeze write doors: this is a direct authoring call with no change in hand and nothing to explain later, so a refusal with no side effects is the honest answer. (`decision_id` on a blocked response is charter principle 6's requirement for ENGINE verdicts — gate evaluations that a change carries forward — not for `authorize()`, which throws bare 403s at all ~170 enforcement sites.)

### §381. The read-only role catalogue, and why it is read-only

GET /api/v1/roles — the read-only catalogue

READ-ONLY, DELIBERATELY, AND NOT FOR THIS INCREMENT'S CONVENIENCE. There is no `POST /roles` and no `role:write` permission, because `hasRoleAtScope` (`authz/resolve.ts`) resolves approval quorum eligibility by joining `roles` and matching `rl.name` with NO `org_id` predicate on the roles row, while the binding half IS org-filtered. An org able to author a zero-permission role named 'Approver' would instantly make its holders eligible quorum voters everywhere a policy names Approver — a self-service quorum bypass. Custom roles are role-model.md §5 step 10 and are gated behind closing that first. (`assertRoleAcceptsNewBindings` closes the half this increment does open: binding an EXISTING hand-written row whose name collides with a built-in.)

GATED ON `type_registry:read` AT THE ORG ROOT — the same permission at the same scope as `GET /api/v1/type-registry` (`routes/type-registry.ts`), which is the closest thing in the tree: a read of the platform's registered definitions rather than of the org's estate. Every built-in role, ladder and purpose alike, carries it, so nothing that can read the estate loses the role catalogue.

⚠️ THE ORG-ROOT PIN IS A REAL LIMIT AND IS NOT A BUG THAT CAN BE FIXED HERE. `scopeExpandCte` expands upward only, so a principal bound ONLY below the org root — a ComponentAdmin at a component — is refused. That is role-model.md §4.2's shape, and the fix that worked there (re-scope onto the object the door governs) has nothing to attach to: the roles catalogue is shared-singleton platform metadata with no containment scope of its own, exactly like the 14 federation doors. Costing a scoped principal a role PICKER is a UI affordance; inventing a scope for a scopeless resource would be an authority claim. Step 6's `GET /authz/effective` is where a scoped principal learns what it holds.

### §382. POST / PATCH / DELETE /api/v1/roles

POST / PATCH / DELETE /api/v1/roles — CUSTOM ROLES (role-model.md §5 step 10)

UNBLOCKED, NOT UNGUARDED. The module doc above recorded these as gated behind a live quorum bypass: `hasRoleAtScope` matched a role NAME with no `org_id` predicate, so an org authoring a zero-permission 'Approver' would have made its holders eligible quorum voters everywhere a policy named Approver. That is closed (`authz/resolve.ts`, owner decision 2026-08-27): quorum eligibility resolves BUILT-IN names only. These three operations ship on top of that fix and would be unsafe without it.

Every refusal is in `docs/authz/role-binding-door.md` §9. This file resolves inputs, orders the bars, and writes the audit chain.

### §383. A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API

A BUILT-IN IS NOT EDITABLE THROUGH ANY ORG'S API. `roles`' RLS admits `org_id IS NULL` for reads, so `getRoleById` legitimately returns a shared singleton — and editing one would rewrite the permission set of every org on the deployment at once. `updateRole`'s `org_id` predicate makes it unaddressable anyway; this refusal exists so the answer is a stated 403 rather than a confusing 404.

### §384. The blast radius, recorded because nothing re-checks it

THE BLAST RADIUS, recorded because it is not re-checked anywhere. Adding a permission widens EVERY EXISTING BINDING of this role with no re-evaluation — the same property `docs/authz/role-binding-door.md` §8 records for built-ins, except reachable through the API here. The subset rule bounds it to the editor's own authority and nothing bounds it to the original author's.

### §385. REFUSES WITH BINDINGS, rather than cascading

REFUSES WITH BINDINGS, rather than cascading. `role_bindings.role_id` is a plain FK, so a cascade here would silently revoke authority from every holder in one request with one audit event naming the ROLE and not the principals — an unreviewable mass revoke wearing a tidy-up's name. The same shape as the containment rule that refuses to delete a container with children: the caller revokes the bindings first, and each revoke is its own audited, floor-checked decision.

### §386. Who holds what and where, gated on audit read

GET /api/v1/role-bindings — who holds what, where

GATED ON `audit:read`, matching `GET /api/v1/audit-events`: a binding listing is an accountability record about principals, not estate data, and `audit:read` is the permission this codebase already uses for "may you see who did what".

THE ORG-ROOT ARM PLUS A SCOPED ARM, via `authz/org-root-arm.ts`. With no `scopeObjectId` filter the request asks for the whole org's bindings and only an org-root `audit:read` holder is admitted (the helper's empty-scope-set case falls back to the org-root arm alone — `every`/`any` over an empty array is guarded there explicitly, because a vacuous `true` on a door is a total bypass). WITH a filter, a principal holding `audit:read` at-or-above that object is admitted too, so a ServiceAdmin can see who is bound at their own service. This is a NEW door, so there is no pre-existing behaviour to widen from and no risk of the re-scope trap the helper's docblock warns about; the org-root arm is here because an org-root reader must not lose a read they would have had, not to rescue anything.

### §387. What the acknowledgement must say, previewed

GET /api/v1/role-bindings/grant-preview — what `acknowledgedPrincipalIds` must say

WITHOUT THIS THE FIELD IS UNUSABLE FROM A CLI, and a required field nobody can compute is a door that is closed rather than guarded. `GET /relationships?typeId=member_of&toId=<group>` gives DIRECT members only; the binding reaches the whole transitive closure, so a client would have to re-implement `memberExpandCte` — including its depth bound and its cycle termination — and any drift between that copy and this server's walk shows up as a 409 the operator cannot fix. One call, the server's own walk, and the value is returned pre-sorted ready to paste.

⚠️ GATED ON `audit:read` AT-OR-ABOVE **THE SUBJECT** — corrected 2026-08-27, and the first gating was the §2b disclosure defect re-introduced one layer up, in the affordance built to make D7 usable.

IT SHIPPED as `checkAtOrgRootOrScopes(… scopeObjectIds: [request.query.scopeObjectId])`, described as "gated exactly like `GET /role-bindings`". The two are not alike, and the difference is which object the named scope BELONGS to. On the binding LISTING, `scopeObjectId` filters the rows returned, so a holder scoped at their own service names their own service and reads bindings at it — the scope and the data are the same object. On the PREVIEW the parameter named a *different* object from the one whose data comes back: the caller chose the scope, the response was the subject's membership, and nothing joined them. So a merely SCOPED `audit:read` holder — a ServiceAdmin, a ComponentAdmin — could name their own service and read the full transitive membership of ANY group in the org.

THE RULE THIS DOOR MUST SATISFY: the preview must not tell a caller anything they could not already read. The membership disclosed belongs to the SUBJECT, so the subject is what the permission is measured at — `audit:read` at the org root (the pre-existing whole-org reader) or at-or-above the subject itself, from the same `authz/org-root-arm.ts` helper the listing uses, so the two doors still cannot disagree about the org-root arm or about the empty-scope-set vacuous-`every` trap.

⚠️ AND THE GATE IS NECESSARY AND NOT SUFFICIENT — corrected again 2026-08-27, because the bar above is measurably not met by anchoring alone. **THE PRINCIPALS DISCLOSED ARE NOT THE SUBJECT.** A `member_of` member is a separate graph object on its own containment chain, and `scopeExpandCte` expands UPWARD, so `audit:read` at-or-above a TEAM says nothing whatever about that team's members. MEASURED: a team-scoped Viewer got a 200 carrying a member's id, typeId and name while the same token's `GET /objects/user/{that id}` answered 403.

SO THE PROJECTION IS FILTERED TOO (`docs/authz/role-binding-door.md` §2d). `readableSubsetOf` keeps only principals inside this caller's readable scope, composed from `authz/readable-scope.ts`'s one definition rather than re-derived — the same set the LIST doors return. That is NOT identical to "what `GET /objects/{type}/{idOrUrn}` would admit": for an org-root reader carrying a lower `deny` the two diverge, and §2d states which way. The remainder is reported as a bare COUNT. What that count still leaks, why it is not nothing, why a digest is no better, and the measurement that D7 remains usable for the caller who needs it are all beside `GrantPreviewResponseSchema` in `packages/schemas/src/rbac.ts`.

`scopeObjectId` IS GONE FROM THE CONTRACT rather than kept and ignored. A parameter that no longer decides anything is a parameter that reads as a control, and the next reader would wire it back to something. The operation is new in this increment and is not in the committed `tools/openapi/openapi.v1.json`, so removing it is not an oasdiff event.

THE SUBJECT IS RESOLVED BEFORE THE CHECK, because it is what the check is measured at. That orders a 404 ahead of a 403 and therefore tells an authenticated caller of this org whether a uuid they already possessed names a live object — the same fact `GET /objects/{type}/{id}` answers. It does NOT disclose membership, type or name, which is the class this door is about. Stated as an accepted consequence rather than left to be found.

STATIC SEGMENT vs `DELETE /role-bindings/:id`: different methods, and find-my-way prefers a static segment over a parameter in any case. There is no `GET /role-bindings/{id}` to collide with — a single binding is read from the list.

### §388. §2d — THE PROJECTION FILTER

§2d — THE PROJECTION FILTER. Applied to the CLOSURE, not to the walk: the walk has to see everything (it is the same set the 409 compares against, and a filtered walk would make `withheldPrincipalCount` unknowable), and only the RESPONSE is narrowed. Costs one query for the caller's readable roots and nothing more for an org-root reader, which is the caller D7 is for.

### §389. Grant: the order of the five refusals is deliberate

POST /api/v1/role-bindings — GRANT

THE ORDER OF THE FIVE REFUSALS IS DELIBERATE, and it is an information-disclosure choice as much as an ergonomic one:

```text
1. resolve the ROLE (404 if it is not visible to this org);
2. `assertRoleAcceptsNewBindings` — D5's Administrator deprecation, and the built-in-name
   collision that would otherwise make this door the second half of a quorum bypass;
3. resolve the SCOPE object and the SUBJECT object (404 if either is not a live object in this
   org), then `assertRoleBindableAtScope` + `assertBindableSubject` — the shape refusals;
4. `role_binding:write` at-or-above the scope;
5. the no-escalation SUBSET RULE;
6. `assertGrantReachesOnlyBindableMembers` — §2b, the members a group subject would empower.
```

THE LINE IS "WHERE DOES THE REFUSAL'S BODY COME FROM", not "is it about shape or authority" — corrected 2026-08-27, because the first ordering put step 6 with the shape refusals at step 3 and leaked. Steps 2 and 3 derive their message from the REQUEST and the row it names, and leak nothing an authenticated principal of this org cannot already read: role rows come from `GET /roles`, object existence from `GET /objects/{type}/{id}`. Putting them first means an operator fixing a typo is told about the typo rather than being told they lack standing to make it. Step 6's 422 names OTHER rows — the ids, names and types of the principals inside a group — so ahead of step 4 it handed the membership of any group in the org to a caller who was about to be 403'd. It now runs last. `docs/authz/role-binding-door.md` §7's 409 was already placed after the bars for the same reason (it discloses how many administrators the org has left); the two are now consistent, and that consistency is the rule rather than two independent judgement calls.

### §390. §0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE THE FIRST READ

§0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE THE FIRST READ. Everything below reads authority state (`roles`, `role_bindings`, the `member_of` closure) and then writes on the strength of what it read. Under READ COMMITTED a concurrent `POST /relationships` {member_of} or a concurrent revoke commits into that gap. Taken here rather than inside the door's assert functions because `getRoleById` below is already a read, and a lock acquired after a read protects nothing the read depends on.

### §391. Idempotency-key parity, as every other post has

`Idempotency-Key` PARITY (DESIGN §6: "every POST accepts an Idempotency-Key header"). Every sibling create route honours it and this one did not, which is not cosmetic HERE: a grant that already landed is refused by `role_bindings_grant_key` with a 409, so a client whose 201 was lost to a dropped connection cannot tell its own retry apart from somebody else having made the grant already — on the one door in the system that hands out authority. With a key the retry replays the original 201 and its binding id.

INSIDE the same `withTenantTx` as the write, the audit event and the Decision, so the stored key and the mutation it guards commit or roll back together. The five refusals below run INSIDE the callback, so a replayed key never re-evaluates them — which is correct: a replay returns the decision that was already made and audited, it does not make a new one.

### §392. Scoped to the actor, the one route that passes it

SCOPED TO THE ACTOR, and this is the one route in the tree that passes it. The stored replay is an authority record — binding id, subject, role, scope — and the key table is ORG-scoped, so without this a principal holding nothing replays an administrator's grant and reads it back. See `idempotency.ts`'s `actorObjectId` doc for why this is a hash-basis change rather than a wider primary key.

### §393. 3 — the two objects

3 — the two objects. `getObjectByIdOrUrnAnyType` refuses a SOFT-DELETED row by default, which matters on both sides: a binding at a tombstoned scope is unreachable authority nobody can revoke (this module's §5), and a binding to a tombstoned subject is a grant to a principal that has been removed. A uuid is required by the schema, so the id-or-URN helper is only ever handed an id here.

### §394. The same subject refusals, applied to the members

6 — THE SAME SUBJECT REFUSALS, APPLIED TO THE MEMBERS THIS BINDING WOULD EMPOWER (`docs/authz/role-binding-door.md` §2b). `assertBindableSubject` above judges the named subject; when that subject is a `group` or `team` the binding also reaches everything `member_of` leads to, and NOTHING looked at that set before 2026-08-27. A no-op for a `user`/`service-account` subject and for an empty group.

AFTER THE AUTHORITY BARS — moved 2026-08-27, and the move is the fix, not a tidy-up. This is the only refusal on the grant path whose message is derived from rows OTHER than the ones the request names: it lists the ids, names and types of the principals inside the group. Ahead of bar §1 it answered "who is in this group?" for any caller who could reach the route, including one about to be refused for having no standing at all. §7's 409 is placed after the bars for the identical reason. §2b's own reasoning — that a standing-based refusal HERE could never fire, because no bar on this door reads the subject's identity — is about what this check can DECIDE, and says nothing about when it may speak.

ONE MEMBERSHIP WALK, TWO JUDGEMENTS. `principalsReachedBy` is called here rather than inside each check so §2b and §2c cannot be handed different answers about the same group — which, under the org lock, they could only be if something raced, and two refusals disagreeing about a concurrent write is the defect §2b exists to close.

### §395. The acknowledgement, per the owner ruling

7 — D7's ACKNOWLEDGEMENT (`docs/authz/role-binding-door.md` §2c, owner ruling 2026-08-27). AFTER §2b, deliberately: §2b names a defect in the ESTATE that no retry fixes (a tombstoned member), this one names a value the caller can re-read and resend, and reporting the unfixable one first costs a round trip fewer. Both are behind the authority bars for §2b's disclosure reason — both name other rows' ids.

### §396. Whom the granter said they were empowering

D7 — WHOM THE GRANTER SAID THEY WERE EMPOWERING, as they said it. `null` for a `user`/`service-account` subject, where the field is not demanded. The set was verified equal to the live closure under §0's lock immediately before the insert, so this is the membership AT THE MOMENT OF THE GRANT and not a claim — the same reason `grantedPermissions` is stored rather than re-read from the role later. Without it the estate can say what authority was handed over and not to whom.

### §397. Revoke: the same two authority bars as a grant

DELETE /api/v1/role-bindings/{id} — REVOKE

THE SAME TWO AUTHORITY BARS AS A GRANT, and that is the half that is easy to leave out. Without the subset rule here, a subject revokes the binding that OUTRANKS them: an OrgAdmin deletes the org's Owner binding and the org is left with nobody who can put it back, using a permission OrgAdmin holds by design. The bar is measured against the role of the binding BEING REVOKED, at that binding's own scope.

AND DELIBERATELY NOT the two GRANT-only refusals. Re-checking D5 would make every existing `Administrator` binding immortal the day the role was deprecated — the exact opposite of a deprecation — and re-checking `bindable_at` would make every binding written at a nonsensical scope permanent, when cleaning those up is half the reason the column exists. See `docs/authz/role-binding-door.md` §4.

PLUS ONE REFUSAL THAT IS NOT AN AUTHORITY BAR AT ALL — the last-administrator 409 (`docs/authz/role-binding-door.md` §7). Both bars above pass legitimately when the org's only Owner revokes their own org-root Owner binding: they hold `role_binding:write`, and Owner's permissions are trivially a subset of Owner's. Measured on a fresh org, that request returned 200 and left ZERO bindings — after which every endpoint 403s, `GET /roles` and `GET /role-bindings` included, and nothing can restore a binding because restoring one needs the `role_binding:write` nobody now holds. This route is the first and only API path that can DELETE a `role_bindings` row, so the guard ships with the verb that creates the hazard.

### §398. Serialize the check with the act, before the read

§0 — SERIALIZE THE CHECK WITH THE ACT, BEFORE `getRoleBindingById` READS. This is the handler the [200, 200] brick was measured on: two concurrent revokes of the last two org-root administrative bindings, each reading a survivor the other was about to delete, both admitted, zero administrative bindings left, every endpoint 403 afterwards. The transaction the comment below correctly insists on does not serialize that on its own — READ COMMITTED gives every statement a fresh snapshot. See `docs/authz/role-binding-door.md` §0.

### §399. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DELETE FIRST, THEN ASK.

This used to be `assertNotLastAdministrativeBinding`, evaluated BEFORE the delete and excluding this row from its own count. That shape is why the floor guarded exactly one of the three doors that can empty an org's administrators: a rule phrased as "what would be left if I removed THIS binding" has to be re-derived, correctly, by every other door — and `DELETE /relationships/{id}` (remove the `member_of` edge under a group's binding) and `DELETE /objects/team/{id}` (tombstone the group holding it) each bricked an org in four plain sequential requests while this guard counted the surviving row and reported success.

The predicate is now the ORG's invariant, evaluated after the mutation and blind to which verb ran, and `graph/relationships-repo.ts` and `graph/objects-repo.ts` call the SAME function. AFTER both authority bars still holds: an actor with no standing must get a 403 about their standing, not a 409 disclosing how many administrators this org has left.

INSIDE this `withTenantTx`, so a refusal rolls the DELETE back with it — the row survives and the org stays administrable. The relevance test below is the cost short-circuit §7 documents; it is a statement about the floor's four inputs, not a filter over callers.

## `apps/server/src/routes/scan-db.ts`

### §400. PUT staleness policy

PUT staleness policy — operator-only, over the `scp_operator` connection: `scp_app` has no write grant and, until 0076, the table had no write RLS policy for ANY role (drizzle/0036 — two independent barriers). This comment said "admin connection" and the code opened one, and both were wrong on the deployment shape it mattered on — api/worker pods carry no admin credential, so the write dialed `config.databaseUrl`'s localhost fallback (routes/operator-db.ts).

## `apps/server/src/routes/scan-override-grants.ts`

### §401. The override request's API surface

M22.6 (ADR-0033 §6a; owner decisions D3, D4) — THE OVERRIDE REQUEST'S API SURFACE.

THE SHAPE THIS COPIES, AND THE ONE IT REFUSES TO
`freeze.override` (DESIGN §10.3, `coordination/transition.ts`) is the model: a MANDATORY non-empty reason, and a HIGH-SEVERITY hash-chained audit event written in the SAME transaction as the act, linked to a Decision. Every route below does both.

The APPROVALS path is explicitly NOT the model, and ADR-0033 names this as a gap that must not be inherited: casting an approval vote writes a row and NO audit event. A surface whose entire purpose is to tolerate a known vulnerability cannot ship with that hole — an approved override is exactly the act an auditor comes looking for, and "it is in the votes table" is not a hash-chained record.

TWO PERMISSIONS, DELIBERATELY DIFFERENT (D3)
```text
RAISE    — `object:write` at the COMPONENT. The component owner already holds this; raising a
           request grants nothing (the grant is inert until approved), so gating it harder would
           only mean the people who know about the finding cannot report it.
APPROVE  — `policy:write` AND `scan:override`, both at the OBJECT NAMING THE TIER THAT SET THE
           RULE. `authz/resolve.ts`'s `scopeExpandCte` walks UPWARD from the named object, so a
           binding at that tier or above satisfies the check and a binding BELOW it never does.
DENY /
REVOKE   — the same two permissions at the same object. The authority to grant and the
           authority to take back must be the same one, or a waiver becomes harder to remove
           than to make.
```

`scan:override` was ADDED beside `policy:write` by role-model.md §5 step 3 (drizzle/0099) rather than replacing it, because authoring a scan ceiling and waiving it were otherwise the same permission string at the same scope — see the second `authorize()` in `decide` for the full argument, including why the addition is a behavioural no-op on every deployment that exists today.

THE PERMISSION CHECK IS NOT THE WHOLE OF D3, AND THE FIRST VERSION OF THIS FILE ASSUMED IT WAS. `scopeExpandCte` expanding upward cuts both ways: naming a LOWER object strictly WIDENS the set of principals whose bindings satisfy the approve check. `tierObjectId` came from the REQUESTER and was compared to nothing, so the party seeking a waiver picked the authority that would grant it — name your own service, approve at your own service, and a platform-set `maxCritical: 0` is waived. The tier is now DERIVED at three points, none of which trusts the claim: - RAISE   — `assertOverrideTierStanding`: the named object must be on the component's own containment chain. - APPROVE — the same check re-derived (a grant can reach the row through IaC or federation without ever having passed the raise route), plus a refusal while an INSTANCE floor outranks the derived tier, plus SEPARATION OF DUTIES: the subject who raised the request may not be the one who approves it (approve only — deny and revoke stay open, because withdrawing a waiver must never be harder than granting one). - THE GATE — `applyOverrideAuthorityBar`, the decisive one: the grant's tier is re-derived from the target's chain and compared against the most senior tier that contributed to the effective ceiling (`EffectiveScanThreshold.contributors`).

WHAT DOES *NOT* DECIDE WHO MAY RAISE: `owners-of`. It walks `domain_id` ONLY and never joins `contains`, so it does not see a component's service or assembly — using it here would silently exclude every component whose owner is attached one rung up, which is the common shape.

WHY THESE ROUTES EXIST AT ALL RATHER THAN `POST /objects/scan_override_grant`
`scan_override_grant` is in `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, so the generic object endpoint refuses it outright and the IaC plan/apply path demands `policy:write`.

THAT MAPPING WAS NEVER THE DEFENCE, and this docblock used to claim it was ("without that, a holder of plain `object:write` could write `{status: "approved", …}` directly"). `policy:write` at a containment domain is an ordinary scoped policy-author binding, and the IaC plan/apply path demands exactly that at the target domain — so the manifest went through, minting an approved grant with no tier check, no Decision, no audit event and no future-expiry validation. The real defence is `governance/scan-override-grant-authoring-guard.ts`, installed at the `graph/objects-repo.ts` choke point every local write door funnels through: the five DECISION properties are writable only by `decide` below, which sets the internal flag that lets them past. Raising a `requested` grant stays open through every door, because it authorizes nothing.

### §402. ...AND IT MUST BE AN ANCESTOR

...AND IT MUST BE AN ANCESTOR. Resolving proves the row exists and nothing else. Because `scopeExpandCte` expands UPWARD, a requester naming any object they happen to hold `policy:write` at would be choosing the authority that approves their own waiver — D3's escalation guard, self-selected. The named object must be on THIS component's containment chain, and the gate re-derives its tier from that same chain (D3).

### §403. Approver standing is the tier that set the rule

D3 — APPROVER STANDING IS THE TIER THAT SET THE RULE, and the tier is DERIVED here rather than taken from the stored `tierObjectId` on trust. The chain check is re-run at decide time (not merely inherited from create) because a grant can reach this row through a door that never ran it: an IaC manifest or a federated peer can write a `requested` grant naming any object at all, and a `contains` edge can be removed after the request was raised.

### §404. `scan:override` — ADDED, NEVER SUBSTITUTED

`scan:override` — ADDED, NEVER SUBSTITUTED (role-model.md §1.3e, drizzle/0099). Both bars are demanded, at the same derived tier object, so nothing that could decide a waiver before this permission existed can decide one without it.

THE DEFECT IT CLOSES. Authoring the scan rule and waiving it were the SAME permission string at the SAME scope: `policy:write` at the tier authors the ceiling (`routes/typed-registries.ts`), and `policy:write` at the tier used to be the whole of the authority to excuse a finding from it. The docblock above already concedes the consequence — the raiser≠approver check "survives intact the moment any SECOND principal holds the same scoped `policy:write`" — which is exactly a separation of duty that is not one.

A BEHAVIOURAL NO-OP ON EVERY LIVE DEPLOYMENT, which is why it is safe to ADD to a door that is already in use: drizzle/0010 grants `policy:write` to Administrator and Owner alone, and drizzle/0099 grants `scan:override` to exactly those two (plus the new SecurityOfficer), so the set of principals who can sign a waiver is identical before and after.

WHAT IT BUYS IS THAT IT CAN BE WITHHELD SEPARATELY. The new OrgAdmin holds `policy:write` and NOT `scan:override`: an org can seat an estate administrator who authors org policy and a security officer who owns the waiver, and neither is the other (owner ruling D3).

ON THE DERIVED TIER, not `auth.orgId`, and not the stored `tierObjectId` on trust — the same object the `policy:write` bar above uses, for the same reason: naming a LOWER object widens the set of principals whose bindings satisfy an upward walk, so both bars have to sit on the value `assertOverrideTierStanding` just re-derived from the component's chain.

RAISING A REQUEST IS UNCHANGED and stays `object:write` at the COMPONENT (see the RAISE door). A `requested` grant authorizes nothing until it is signed here, so gating the report of a finding harder than the waiver of one would only stop the people who know about it from saying so.

### §405. SEPARATION OF DUTIES

SEPARATION OF DUTIES — the raiser may not be the approver (owner decision, 2026-08-18).

APPROVE ONLY, deliberately, and for the same reason the instance-floor check above is approve-only: taking a waiver back must never be harder than making one. Denying or revoking your own request is ordinary withdrawal and stays free.

WHAT THIS IS AND IS NOT. It is defence in depth for the D3 authority bar, not a replacement for it: the escalation the bar exists to stop survives this check intact the moment any SECOND principal holds the same scoped `policy:write`. It closes only the one-actor shape — raise at a tier you hold, then immediately sign your own waiver — which is also the cheapest shape to reach and the only one that leaves a single name on both halves of the record.

IT CANNOT BIND A FEDERATED GRANT, and that is correct rather than a gap. A grant arriving over the journal was decided at its AUTHORING instance, where this check ran; re-deciding it here is not a thing this door does. `requestedByActorId` from a peer also names a subject in that domain's `objects`, so comparing it to a local subject id would be meaningless.

### §406. THE ONE CALLER THAT MAY WRITE A DECISION

THE ONE CALLER THAT MAY WRITE A DECISION. `graph/objects-repo.ts` refuses `status`, `expiresAt`, `decidedByActorId`, `decidedAt` and `decisionReason` at every other local door; this is the path that earns them, having just run the derived-tier authority check above and about to write the Decision and the hash-chained audit event below, in this same transaction. The flag is a TypeScript-only field on the repo input — no request body reaches it, and `grep -rna scanOverrideGrantDecision` finds exactly this one setter.

## `apps/server/src/routes/scanner-assignments.ts`

### §407. M13.3a — the SCANNER-ASSIGNMENT REGISTRY's API surface

M13.3a — the SCANNER-ASSIGNMENT REGISTRY's API surface (ADR-0020 §2, proposal §13.3), API-first per charter principle 3 (API -> SDK -> CLI). This is the DELIBERATE TWIN of `routes/instance-scan-floors.ts`: same two-audiences / two-credentials shape, same operator-write mechanics, because scanner assignments are instance-scoped config exactly as scan floors are.

- **READ is tenant-facing.** Any authenticated tenant principal may see the assignments — a scan step / gate a tenant cannot inspect is not explainable (charter principle 6). The read runs inside the ordinary tenant transaction under the table's tenant-read RLS policy (drizzle/0035), the same path `resolveScannersForType` takes; it leaks nothing across tenants because the table holds NO per-tenant rows — it is instance-wide configuration.

- **WRITE is operator-only, and deliberately NOT an RBAC permission.** These assignments bind EVERY org on the deployment; a tenant admin must never author them. So no role can grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN` (config.operatorToken), presented as `x-scp-operator-token`, and executes over the `scp_operator` connection (`withOperatorDb`) because the request-serving `scp_app` role holds no write grant on the table and no write RLS policy existed for it at all (drizzle/0035 — two independent barriers, mirrored from 0029; 0076 adds the operator role as the one principal both barriers admit). Unset token ⇒ the surface is CLOSED (403), never a fallback to a tenant credential.

```text
 THAT LINE USED TO READ "the ADMIN connection", AND THE CODE MATCHED IT, AND BOTH WERE WRONG ON
 the shape it mattered on: api/worker pods hold no admin credential (the chart gives
 `DATABASE_URL` to the migrations Job alone), so the write dialed `config.databaseUrl`'s
 `localhost:5432` fallback inside its own pod. `routes/operator-db.ts` has the full account.
```

## `apps/server/src/routes/service-board.integration.test.ts`

### §408. The service release board projection, end to end

GET /services/:idOrUrn/board — the service release board projection (docs/proposals/coordination-ui-views.md § "Service release board", Phase 2, Layer A).

The board is a Layer-A projection: it aggregates a service's contained components and each component's LATEST change's per-wave summary. This suite pins the honest-empty baseline — a service whose components have never been a change target must project real rows with NULL latest-change and EMPTY waves (never a fabricated version/status) — plus auth/404 behaviour. The with-a-change wave projection rides the broader coordination suites that already seed plans/waves.

## `apps/server/src/routes/services.integration.test.ts`

### §409. Phase 2 coordination UI: the Service release board projection

Phase 2 coordination UI: the Service release board projection (GET /services/:idOrUrn/board, docs/proposals/coordination-ui-views.md § "Service release board"). Pins the contract of the ONE net-new server capability — "the latest change that targeted this component" — plus the Layer-A projection around it: per-component latest-change waves, the releasing/blocked/stable summary, the emergency + blocked attention signals (with the block Decision's id), and authz.

Plans are compiled directly via the engine (`compileAndPersistPlan`), the same shortcut coordination.integration.test.ts uses — a freshly-proposed change has no wave-target rows yet, and the board's join keys off exactly those rows, so the test must materialize a plan to exercise it.

### §410. A regression in a single-domain org, with no federation

REGRESSION (single-domain org — no federation anywhere in this test). An observed `blocked` must never be displaced by a newer change this domain knows less about.

THE DEFECT this pins: the board's two lookups — the wave-target join (a REAL local observation: compiled plan, rolled waves, failed target) and the change-object `properties.targets` fallback (which knows only that a change exists) — were merged by "whichever `created_at` is greater", across two DIFFERENT timestamps (`changes.created_at` vs `objects.created_at`) that share no clock. So proposing ANY newer change against the same component — with no plan compiled, nothing executed, nothing observed — silently replaced the failed one, and `summary.blocked` fell to 0. Every field the operator needs (waves, the failed count, the block signal) vanished with it, on the commander's OWN board, for a release it is itself driving.

The fix is a strict fallback: the planned arm is authoritative for any component it covers, and the declared arm is consulted only for components it does not. There is no cross-clock comparison left to get wrong.

## `apps/server/src/routes/services.ts`

### §411. Service-scoped read projections

Service-scoped read projections (docs/proposals/coordination-ui-views.md Phase 2). Distinct from the generic typed-registry `/services` CRUD (routes/typed-registries.ts) — this file adds the release board, a cross-object aggregation the templated registry routes can't express. The path carries an extra `/board` segment, so it never collides with the registry's `/:idOrUrn` detail route.

## `apps/server/src/routes/source-mapping-delete.integration.test.ts`

### §412. DELETING A SOURCE MAPPING

DELETING A SOURCE MAPPING — the first operator-facing delete this table has had.

WHY THE ROUTE EXISTS
Before this, the ONLY way to remove a `source_mappings` row was an IaC apply's prune. A mapping created by `discovery accept` or by hand could never be taken back through the API.

The cost is not inconvenience. A `docs/proposals/post-import-configuration.md` §6 pair merge soft-deletes the absorbed component and STRANDS its mappings: they stop matching (a dead component is excluded at read time) but they stay in the table and keep appearing in `GET /mappings`, with no way to clean them. On the live homelab that is 5 rows left by three merges.

WHY THE IDENTITY TUPLE AND NOT AN ID
`source_mappings` has no unique constraint and `POST /discovery/accept` inserts unconditionally, so an estate can hold several byte-identical rows — the homelab does. A by-id delete would remove one and leave the survivor still correlating, so the operator would see "deleted" and a push would still route there. Matching the tuple removes everything that says the same thing, which is the reasoning `deleteSourceMappingsMatching` was already written with for IaC prune.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| resolve the component WITHOUT `includeDeleted` | the stranded-mapping test FAILS with 404 — the rows most needing deletion are exactly the undeletable ones | | return 204 instead of the row count | the duplicate test FAILS — it can no longer tell 2 rows removed from 0 | | delete only the first matching row | the duplicate test FAILS — the survivor still correlates |

## `apps/server/src/routes/spa-index-freshness.integration.test.ts`

### §413. THE SPA SHELL IS SERVED FRESH

THE SPA SHELL IS SERVED FRESH — `/` and every deep link agree on what `index.html` currently is.

The defect this pins is an ASYMMETRY, not staleness in the abstract. `app.ts` serves one document from two places: `GET /` comes from `@fastify/static` (which reads the file per request), while every SPA client-side route falls through to the low-priority `app.get("/*")` catch-all. That catch-all used to memoize the file into a process-lifetime `let cachedIndexHtml`, so the two sources answered differently the moment the file changed underneath a running server.

WHY THAT MATTERS, concretely: rebuilding the web app under a running server (the ordinary local loop) makes Vite emit new content-hashed asset filenames and delete the old ones. `/` then correctly referenced the new bundle while `/services/anything` kept handing out HTML pointing at files that no longer existed — two 404s, a blank page, and nothing at all in the server log. It reproduces under plain `curl`, so it is not browser caching.

WHAT THIS TEST PINS — the PROPERTY ("a deep link reflects what is on disk now"), not the symptom ("asset hashes match"). Asserting on hashes would pass against a server that happened to have cached the right generation, and would need rewriting every time the bundler's naming changed. Writing a sentinel and demanding it come back is the property stated directly.

HERMETIC BY CONSTRUCTION. `webDistRoot` is resolved from `__dirname` in `app.ts` and is not injectable, so this test writes a real `apps/web/dist/index.html`, exercises the server against it, and restores the previous state exactly in `finally` — including deleting the file (and the directory) when they did not exist, which is the case in any CI job that runs server tests without building the web app first. It therefore neither depends on a prior `pnpm --filter @scp/web build` nor leaves one damaged.

MUTATION-PROVEN: restoring the `cachedIndexHtml ??= await readFile(...)` memoization makes the second assertion in the first test go red (the deep link keeps serving generation 1), while the `/`-vs-deep-link agreement test also fails. Applied alone and reverted.

## `apps/server/src/routes/type-registry.ts`

### §414. Runtime type registry (DESIGN.md §4.1)

Runtime type registry (DESIGN.md §4.1): org-scoped custom object/relationship types as data inserts. Anything registered here is immediately usable through the generic `/objects/{type}` and `/relationships` endpoints — no deploy, no migration (BUILD_AND_TEST.md §8 M1 DoD (b)).

## `apps/server/src/routes/typed-registries-cli.integration.test.ts`

### §415. That command is named in the charter verification

`scp service register` is named explicitly in BUILD_AND_TEST.md's charter verification table and used by later E2E/seed work, so it — and its 7 sibling `register` commands plus the ownership convenience commands — must exist with these exact names against the real built CLI binary (test-support/cli-runner.ts), not just typecheck. Mirrors graph/custom-type.integration.test.ts's CLI black-box style.

## `apps/server/src/routes/typed-registries.integration.test.ts`

### §416. M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1)

M2 typed registries (BUILD_AND_TEST.md §8 M2 item 1): thin layers over the same objects/object_types substrate the generic `/objects/{type}` endpoint uses. Uses `app.inject` directly (not the SDK) to exercise the real HTTP contract, mirroring test-support/smoke.integration.test.ts's style.

## `apps/server/src/routes/typed-registries.ts`

### §417. Plural naming for the list operation, when adding s fails

PLURAL PascalCase for the list operationId, when `resourceName + "s"` is wrong.

Every resource through `Domain`..`ServiceAccount` pluralises by appending `s`, so this was never needed. `Assembly` does not — the naive form is `listAssemblys`. That matters more than it looks: the operationId is the generated SDK method name and `/v1` is additive-only, so a misspelling shipped once is a misspelling forever (renaming an operationId is an oasdiff break — see OASDIFF-EXCEPTIONS.md, where two such renames each cost an exception).

### §418. The 8 typed convenience resources this milestone adds

The 8 typed convenience resources this milestone adds (BUILD_AND_TEST.md §8 M2 item 1), invoked once each via `registerTypedRegistryRoutes` from app.ts. `typeId` matches the pre-seeded `object_types.id` exactly (drizzle/0002_rls_rbac_seed.sql §5).

### §419. The OPTIONAL level between a service and its components

The OPTIONAL level between a service and its components (migration 0055, `intermediate-grouping.md` D5). A plain typed registry like `service` — it needs no bespoke route, because the level is expressed by `contains` edges rather than by columns of its own. NOT listed in `components-repo.ts`'s parent check: that routes through `isContainerType` (containment.ts), which is the single definition of "may contain components".

### §420. M4 governance resources (BUILD_AND_TEST.md §8 M4 item 1/2)

M4 governance resources (BUILD_AND_TEST.md §8 M4 item 1/2): Policy and Control documents are graph objects of the pre-seeded `policy`/`control` types (0002_rls_rbac_seed.sql §5), managed through this exact same typed-registry machinery — versioned via `objects.version` (bumped on every update, pinned into Decisions — DESIGN §10.1/§10.4), scope/enforcement/condition/effects validated at write time by the Ajv property-schema path (drizzle/0010_governance.sql §5). The only difference from `TYPED_REGISTRY_RESOURCES` above: writes require 'policy:write' rather than the generic 'object:write' (DESIGN §7's example role bindings name it explicitly).

### §421. Bind the policy's declared scope to the author's authority

CRITICAL #1b — bind the policy's DECLARED scope to the author's own authority. All three write paths (POST / PATCH-with-properties / PUT) call `validateWrite`, so declaring it at the config covers every door THIS FILE opens.

"Every door this file opens" is the limit of what a route-level hook can claim, and it is why ADR-0032 §6a's sibling refusal is NOT here. That one shipped in this exact spot, and the census of where `assertPolicyScopeWithinAuthority` is ALSO installed — `iac/plans-repo.ts:733` and `:758` — is what showed the spot to be the wrong altitude: `POST /plans` + `/plans/{id}/apply`, `POST /federation/hand-fill` and `POST /federation/overlays` all reach `createObject` without passing through here. It now lives at `graph/objects-repo.ts`'s `createObject`/`updateObject`, the one choke point every local write door funnels through, and this route inherits it there.

This check has NOT moved with it, and that is a distinction rather than an omission — it is `federation/domain-local.ts`'s "authorization at the door, invariant at the repo" split. ADR-0032 §6a's refusal is an INVARIANT: it reads only the document, needs no subject, and is the same answer for every caller, so the repo is where it belongs. This one is AUTHORIZATION: it resolves the author's `policy:write` at the DECLARED scope. Pushing it down would make it run for the federation importer and every internal caller too, whose `actorObjectId` is a SYNTHETIC subject (`FEDERATION_IMPORT_ACTOR_ID`) — which is precisely how an authorization check quietly becomes a no-op. It stays at the doors, and its own three-site census (here + `iac/plans-repo.ts`'s create and update branches) is what keeps it honest.

### §422. M2 typed convenience endpoints

M2 typed convenience endpoints: thin, friendlier-path layers over the exact same generic graph substrate `routes/objects-generic.ts` uses — same graph/objects-repo.ts functions, same auth/authorize/idempotency structure, same RBAC scope semantics. The only differences are ergonomic: a fixed path (`/api/v1/domains` instead of `/api/v1/objects/domain`), a hardcoded `typeId` (never a route param, never client-suppliable), and distinct OpenAPI operationId/tags per resource for SDK/CLI method naming. No new top-level tables, no new authz/audit code paths: objects created here are the exact same `objects` rows the generic `/objects/{type}` endpoint sees, and vice versa (proven by typed-registries.integration.test.ts).

Called once per entry in `TYPED_REGISTRY_RESOURCES` (app.ts) rather than hand-copied 8 times.

Scope decision: identical to objects-generic.ts (see that file's module doc) — list checks `object:read` at org-root scope; every other operation checks at the object's own scope (existing objects) or its resolved containing domain (new objects).

### §423. The shared factory behind every typed registry

The shared factory behind EVERY typed registry, so this one composition covers all ~10 of them. `readPermission` is whatever the registry declared (`policy:read` for the governance ones, `object:read` for the rest) and the SAME value feeds the gate and the row filter — a filter computed from a different permission than the gate checked would either widen or silently empty the list.

### §424. THE ADMINISTRATOR FLOOR

THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7), inherited from `graph/objects-repo.ts`'s `deleteObject`. DECLARED ON THE TEMPLATE, therefore on all ten typed registries, and NOT on a hand-picked four — even though only `user`, `service-account`, `group` and `team` can hold a role binding through the write door. `role_bindings.subject_id` is a bare uuid with no foreign key and no type constraint (the property `ROLE_BINDING_SUBJECT_TYPES` names), so a hand-written or restored row can make ANY object a binding's subject, and `objectTouchesRoleAuthority` — which is what decides whether the floor runs — reads that column and not a type. Narrowing the declaration to the four would be a filter over the symptom rather than the property, and over-declaring a response code costs a client nothing. Additive under the oasdiff gate: `deleteDomain`, `deleteService`, `deleteAssembly`, `deleteDeploymentTarget`, `deleteTeam`, `deleteGroup`, `deleteUser`, `deleteServiceAccount`, `deletePolicy` and `deleteControl` each previously declared 200/401/403/404.

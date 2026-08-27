import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { productionSourceFiles, readStripped } from "@scp/source-census";

/**
 * ================================================================================================
 * THE ORG-ROOT SCOPE CENSUS — a new door may not be pinned at the org root by accident
 * ================================================================================================
 *
 * WHAT THIS GUARDS. `authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD ONLY: the
 * target object plus every containing ancestor. A check written `scopeObjectId: auth.orgId` is
 * therefore satisfied by an ORG-ROOT BINDING AND BY NOTHING ELSE — no service-scoped, assembly-
 * scoped or component-scoped binding can ever reach it, because the walk never goes down. That is
 * correct for a genuinely org-level act (federation identity, the type registry, a deliberate
 * escalation bar) and wrong for a door that governs one object; role-model.md §8 is the analysis,
 * and increment 2.5a re-scoped the get-by-id doors that were wrong.
 *
 * The re-scopes each have their own behavioural test. NOTHING held the *shape* — a new door added
 * tomorrow with `scopeObjectId: auth.orgId` would be invisible, and §8.5 measured why that matters:
 * all 334 `403` occurrences across `apps/server` tests were enumerated and ZERO of them pin the
 * org-root behaviour of any door 2.5a touched. So this file enumerates every org-root-scoped check
 * in the server and asserts the set equals a checked-in list. A new one fails CI until someone adds
 * it here WITH A JUSTIFICATION — which is the point. The decision gets made, not defaulted into.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE GLOB IS `apps/server/src/**` AND NOT `routes/*.ts` — THE CENSUS THAT MISSED THE SURFACE
 * ------------------------------------------------------------------------------------------------
 * CLAUDE.md: census by PROPERTY, not by symptom; a filter is where the next instance hides. §8.1
 * recorded the original census doing exactly the wrong thing — `grep -rna 'scopeObjectId:
 * auth.orgId' apps/server/src/routes/*.ts`, which finds 81 lines and misses the surface twice over:
 *
 *   - `routes/objects.ts` contains ZERO `authorize(` calls. Its four routes — `POST`/`GET
 *     /api/v1/objects/service` and the `/orgs/:org/` variants — delegate to
 *     `services/objects-service.ts`, where the same property is spelled `scopeObjectId: orgId`
 *     (no `auth.`) one directory outside the glob. `listServiceObjects()` is in the list below
 *     because of this, and a `routes/`-only census would never have seen it.
 *   - the create doors spell it `X ?? auth.orgId` — a fallback, not a pin — and some of them assign
 *     it to a `const scopeObjectId` first (`components.ts:310`, `plans-repo.ts`), so even the
 *     `scopeObjectId:` property spelling misses them.
 *
 * So: the whole non-test TypeScript tree of `apps/server` (there is no enforcement in `packages/` —
 * §1's 170-call-site census found none), and the anchor is the ASSIGNMENT of a `scopeObjectId`, in
 * either the property form or the `const`/`let` form, whatever function it is later handed to.
 * `authorize`, `hasPermission`, `assertDenyNotTruncated` and the `{permission, scopeObjectId}` pairs
 * `iac/plans-repo.ts` pushes onto a check list are all covered without naming any of them, because
 * naming them would be the next filter.
 *
 * ------------------------------------------------------------------------------------------------
 * THE THREE CLASSES, AND WHY ALL THREE ARE CHECKED IN
 * ------------------------------------------------------------------------------------------------
 *   {@link ORG_ROOT_PINNED}    the value IS an org-root expression (`auth.orgId`, `orgId`,
 *                              `input.orgId`, `rootObjectId`). Only an org-root binding satisfies it.
 *   {@link ORG_ROOT_FALLBACK}  the org root is the `??`/ternary FALLBACK (`declaredParent ??
 *                              auth.orgId`). Correct-shaped already — it scopes to the declared
 *                              parent when there is one — but a new door written this way whose
 *                              left operand is always `undefined` is a pin wearing a disguise.
 *   {@link ORG_ROOT_DERIVED}   the org id appears only as an ARGUMENT to a helper that computes the
 *                              scope (`resolveApprovalScope(tx, input.orgId, …)`). Not org-root
 *                              scoped at all — listed so that "compute it in a helper" is not an
 *                              unwatched way to reintroduce the pin.
 *
 * ------------------------------------------------------------------------------------------------
 * READING FILES: NUL BYTES, AND THE KNOWN-POSITIVE CONTROL FOR THIS TEST'S OWN DISCOVERY
 * ------------------------------------------------------------------------------------------------
 * CLAUDE.md's NUL rule is about *tools that silently drop files*, and it applies to this file's own
 * discovery, not only to a shell `grep`. Three tracked files under `apps/server/src` carry literal
 * NUL bytes (`dependencies/ingestion-stamp-repo.ts`, `dependencies/internal-release-detection.ts`,
 * `iac/plan-diff.ts` — NUL is a composite-key delimiter there and is CORRECT). `readdirSync` +
 * `readFileSync(f, "utf8")` have no binary heuristic, so they are read like any other file — but
 * "no heuristic" is a claim about a tool, and a claim about a tool cannot be verified by asserting
 * it. {@link NUL_CARRYING_FILES} is the known-positive control: the test proves those three files
 * were discovered, that they really do contain a NUL byte, and that their text arrived non-empty.
 * If discovery ever starts dropping them, the census does not report green over the gap.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS CANNOT PROVE — read `@scp/source-census`'s index.ts in full before trusting a result
 * ------------------------------------------------------------------------------------------------
 * A source census is a grep with good manners. {@link readStripped} removes comments, so a
 * commented-out check no longer counts as a check (`governance-move.ts:142` and four doc comments
 * in `handfill-repo.ts`/`schema.ts` say `scopeObjectId: auth.orgId` in prose and are correctly
 * absent below). It deliberately PRESERVES string and template contents, so a mention inside a
 * template literal WOULD count — today none of the entries below comes from one, and if a false
 * entry ever appears that is the first thing to check. And it cannot see dead code, a false
 * condition, or the wrong arguments.
 *
 * SO THIS IS A NECESSARY CONDITION, NEVER A SUFFICIENT ONE. It says "the set of org-root-scoped
 * checks is still exactly this set". It says NOTHING about whether any of them is enforced at
 * runtime — that is what the behavioural tests beside this file are for
 * (`change-target-scope.integration.test.ts`, `campaign-scope-doors.integration.test.ts`,
 * `change-source-mapping-authz.integration.test.ts`,
 * `federation-overlay-base-authority.integration.test.ts`).
 *
 * ------------------------------------------------------------------------------------------------
 * STILL OWED: §8.3's INVERSE-WALK INVARIANT — NOT THIS INCREMENT
 * ------------------------------------------------------------------------------------------------
 * §8.3 names an invariant nobody has tested: the upward walk and the downward walk must be EXACT
 * inverses, or get-by-id and LIST disagree — an object `authorize()` admits at its own id would be
 * absent from that subject's list, which reads as a cache bug rather than an authz bug. The test is
 * `hasPermission(o)` IFF `o ∈ readableSet(subject)` over a random sample. It cannot be written yet:
 * there is no downward walk to compare against until 2.5b builds `authz/readable-scope.ts`. It is
 * owed, it is the drift detector for the whole model, and this census is not a substitute for it —
 * this file only counts scopes, and the invariant is about what they RESOLVE to.
 */

/** One org-root-scoped `scopeObjectId` assignment, keyed by where it lives rather than by line
 *  number so that ordinary edits above it do not churn the list. */
interface CensusEntry {
  /** `<path under apps/server/src> :: <METHOD url | enclosingFunction()> :: <permission>`. */
  site: string;
  /** Why this one is allowed to be org-root scoped. `deferred` is an INVENTORY line, not an
   *  endorsement — see {@link ENTRY_CLASSES}. */
  cls: EntryClass;
  why: string;
}

/**
 * - `org-level` — the thing being acted on has no place in the containment graph below the org
 *   root, so there is no narrower scope to check at. The pin is correct and permanent.
 * - `escalation-bar` — org-root ON PURPOSE, so that a narrower binding CANNOT satisfy it. Widening
 *   one of these is a security regression, not a fix (role-model.md §8.6).
 * - `list-gate` — a LIST door's gate. §8.2 step 5 keeps this check unchanged — same permission, same
 *   org-root scope, evaluated FIRST — and does the widening by filtering rows inside the repo before
 *   the `LIMIT` (2.5b), which is what makes that change a pure widening: a caller who cleared it
 *   before still clears it, and still gets an UNFILTERED query. On the doors 2.5b has reached the
 *   check is no longer written in the route: it moved into `authz/list-door-scope.ts`'s wide arm,
 *   one definition for all eight list doors, and it is still org-root pinned there. The entries
 *   still naming a route are the doors 2.5b has not reached.
 * - `not-a-check` — a `scopeObjectId` written into a `role_bindings` ROW, not a permission check.
 *   Present because the property is "a scope set to the org root" and filtering by call target is
 *   where the next instance would hide.
 * - `deferred` — a door 2.5a did not re-scope, because §8.6 excluded it or a later increment owns
 *   it. LISTED, NOT ENDORSED: the entry records that the pin is known, with who owns the decision.
 */
const ENTRY_CLASSES = [
  "org-level",
  "escalation-bar",
  "list-gate",
  "not-a-check",
  "deferred"
] as const;
type EntryClass = (typeof ENTRY_CLASSES)[number];

/**
 * EVERY CHECK WHOSE SCOPE IS UNCONDITIONALLY THE ORG ROOT. Adding an entry is a deliberate act: say
 * in `why` what makes this door org-level, or which increment owns re-scoping it.
 */
const ORG_ROOT_PINNED: readonly CensusEntry[] = [
  // ---- not a permission check at all: the two production writers of `role_bindings` -------------
  {
    site: "auth/local-auth.ts :: ensureBootstrapAdmin() :: -",
    cls: "not-a-check",
    why: "writes the bootstrap admin's Owner binding AT the org root; a binding row's scope, not a check"
  },
  {
    site: "auth/oidc.ts :: provisionNewOidcUser() :: -",
    cls: "not-a-check",
    why: "writes a JIT OIDC user's Viewer binding at the org root; a binding row's scope, not a check"
  },

  // ---- deliberate escalation bars: org-root so a NARROWER binding cannot satisfy them -----------
  {
    site: "coordination/region-membership-guard.ts :: assertMayUndeclareRegionMembership() :: object:write",
    cls: "escalation-bar",
    why: "withdrawing a region declaration changes the set every regional deploy gate reads, so it is barred at the same org scope getRegionalExecutors reads that set at"
  },
  {
    site: "dependencies/producer-declaration.ts :: dependencyProducerScopeCheck() :: policy:write",
    cls: "escalation-bar",
    why: "a producer declaration matches coordinates org-wide, so it carries org-wide blast radius; the pair exists so the route and the IaC apply cannot drift on scope"
  },
  {
    site: "federation/handfill-repo.ts :: assertGovernanceAuthorityForHandFill() :: policy:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 names this one of four deliberate org-root escalation bars on the federation hand-fill path"
  },
  {
    site: "federation/handfill-repo.ts :: assertObjectWriteAuthorityForHandFill() :: object:write",
    cls: "escalation-bar",
    why: "hand-fill writes objects the peer named, not objects the caller named, so the caller needs authority over the whole org rather than over one target"
  },
  {
    site: "federation/overlay-repo.ts :: createOverlay() :: policy:write",
    cls: "escalation-bar",
    why: "a governance-managed overlay is always created at org-root containment, so its bar is the same org-root policy:write /api/v1/policies applies"
  },
  {
    site: "governance/governance-labels.ts :: assertMayWriteGovernanceLabels() :: policy:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — a deliberate org-root escalation bar; a label decides which policies bind, so writing one from below would be self-promotion"
  },
  {
    site: "governance/policy-scope-authz.ts :: assertPolicyScopeWithinAuthority() :: policy:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — a deliberate org-root escalation bar; a policy scope that can match objects org-wide has org-wide blast radius"
  },

  // ---- audit: the wide arm of the accountability read -------------------------------------------
  {
    site: "routes/audit-events.ts :: GET /api/v1/audit-events :: audit:read",
    cls: "org-level",
    why: "the audit chain is one hash-linked sequence per org and is not sliceable by containment, so reading it is an org-level act"
  },

  // ---- the WIDE ARM of every 2.5a disjunction, defined once -------------------------------------
  {
    site: "authz/org-root-arm.ts :: checkAtOrgRootOrScopes() :: check.orgRootPermission",
    cls: "org-level",
    why: "THE ONE DEFINITION of the WIDE arm every door increment 2.5a re-scoped composes — 'at the org root OR at the object this door governs'. It is org-root BY CONSTRUCTION: the narrow arm beside it, in the same function, is the scoped half. It is what makes the re-scope a PURE WIDENING, because scopeExpandCte joins every ANCESTOR deleted_at IS NULL and so reaches nothing at all from an object whose parents have been tombstoned — which an org-root pin could never do to anybody. On the change doors the arm is also evaluated BEFORE the persisted target set is read at all (checkAtOrgRootOrChangeTargets), so a row a federation import mangled cannot 403 an org-root principal while the trap-4 refusal still stops a scoped one. It is deliberately NOT composed by the two federation OVERLAY doors: those ADDED a bar rather than re-scoping one, so an org-root arm there would be inert and would delete the bar — see their entries below. Composed by routes/changes.ts (assertReadableAtSomeChangeTarget, assertWritableAtEveryChangeTarget, assertDecisionReadable — where the wide arm is audit:read and the narrow one object:read, §8.6's deliberate disjunction, whose SUBJECT arm resolves a change to its TARGETS rather than checking the change itself, because a change's own chain runs to the org root and a direct check there would be inert), routes/campaigns.ts (assertCampaignAuthority), routes/change-sources.ts (assertSourceMappingWritable) and routes/governance.ts (POST /policy-evaluate). This entry existing exactly once is the point: three hand-written copies is how graph/containment.ts drifted"
  },

  // ---- CI ingress and credential doors: role-model.md §8.6's explicit no-sweep list --------------
  {
    site: "routes/change-sources.ts :: POST /api/v1/change-sources/:sourceKind/webhook :: object:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — CI ingress is org-root DELIBERATELY: the principal is a robot with no per-object standing, and an existing test rests its whole argument on that"
  },
  {
    site: "routes/change-sources.ts :: POST /api/v1/change-sources/:sourceKind/report :: object:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — the second CI ingress door, same robot principal, same deliberate org-root pin"
  },
  {
    site: "routes/change-sources.ts :: PUT /api/v1/change-sources/:sourceKind/webhook-secret :: secret:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — a credential door, now SPLIT onto secret:write (drizzle/0099) rather than widened: whoever sets this HMAC secret can thereafter forge signed source events, so a sweep would have handed a ComponentAdmin the org's webhook secret. The org-root SCOPE is unchanged and stays deliberate; only the permission moved"
  },
  {
    site: "routes/executors.ts :: PUT /api/v1/secrets/:key :: secret:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6/§1.3d — the org's execution-system credentials, SPLIT onto secret:write by drizzle/0099 rather than widened. The permission substituted object:write here; the org-root scope is unchanged, because no narrower binding should ever reach the tokens SCP dials GitHub/ArgoCD/Terraform with"
  },
  {
    site: "routes/executors.ts :: GET /api/v1/secrets :: object:read",
    cls: "escalation-bar",
    why: "lists which credential keys the org holds; belongs with the credential doors above, not with the object reads"
  },
  {
    site: "routes/executors.ts :: DELETE /api/v1/secrets/:key :: secret:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — deleting an execution-system credential is the same credential door as PUT and takes the same secret:write (drizzle/0099); it is also an availability kill switch for all coordination on the deployment, so if the two ever differ this is the one that should be HARDER"
  },
  {
    site: "routes/executors.ts :: POST /api/v1/discovery/run :: object:read",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — discovery makes SCP dial an execution system with STORED credentials, so the bar is org-root regardless of what it discovers"
  },
  {
    site: "routes/executors.ts :: POST /api/v1/discovery/accept :: object:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 — accepting a discovery proposal creates objects the caller never named, from a run that used the org's credentials"
  },
  {
    site: "routes/executors.ts :: POST /api/v1/discovery/backfill-source-mappings :: object:write",
    cls: "escalation-bar",
    why: "role-model.md §8.6 names this door beside /discovery/run and /accept as one that must NOT be swept; it was briefly replaced by a per-component check inside backfillSourceMappings, which authorized NOTHING for an empty or fully-skipped proposal — a door's bar cannot live in a per-entry loop"
  },

  // ---- federation: identity and link operation are instance-level acts ---------------------------
  {
    site: "routes/federation.ts :: POST /api/v1/federation/init :: federation:write",
    cls: "org-level",
    why: "designates this DEPLOYMENT's federation role; there is no object below the org root that a role designation could be scoped to"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/self :: federation:read",
    cls: "org-level",
    why: "returns this org's own federation identity; federation:read is explicitly NOT being re-scoped (§8.5), and outposts-rbac.integration.test.ts already pins this behaviour"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/peers :: federation:write",
    cls: "org-level",
    why: "a peer is the org's counterpart, not a row in the org's containment graph"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/peers :: federation:pair",
    cls: "escalation-bar",
    why: "owner ruling D4's SECOND bar on pairing, added on top of federation:write; org-root so that no sub-org binding can ever admit a peer"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/peers/:id :: federation:read",
    cls: "org-level",
    why: "a peer row hangs off the org, so its id expands to nothing narrower than the org root"
  },
  {
    site: "routes/federation.ts :: PATCH /api/v1/federation/peers/:id :: federation:write",
    cls: "org-level",
    why: "re-keying or retiring a peer is the same org-level act as adding one"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/peers :: federation:read",
    cls: "org-level",
    why: "lists the org's peers; federation state has no containment scope to filter by"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/status :: federation:read",
    cls: "org-level",
    why: "reports link health for the whole deployment, aggregated across every peer, so no single object bounds what it returns"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/exports :: federation:write",
    cls: "org-level",
    why: "an export bundle draws from the org's whole journal, so partial authority cannot bound what it emits"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/resync :: federation:write",
    cls: "org-level",
    why: "resets the journal cursor for every link at once"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/peers/:id/resync :: federation:write",
    cls: "org-level",
    why: "resets one link's journal cursor; the link, not any object, is the subject"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/exports/promotion :: federation:write",
    cls: "org-level",
    why: "signs a promotion manifest with the org's federation identity"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/imports :: federation:write",
    cls: "escalation-bar",
    why: "an import applies arbitrary typed entries ANYWHERE in the org (applyEntry resolves any registered typeId), so the bar must be the org root"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/relay :: federation:write",
    cls: "org-level",
    why: "the retrans relay channel is a property of the deployment"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/relay/import :: federation:write",
    cls: "escalation-bar",
    why: "same arbitrary-entry reach as POST /federation/imports, arriving over the relay channel"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/relay-builds :: federation:read",
    cls: "org-level",
    why: "relay builds are per-link records, not per-object ones"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/overlays :: object:write",
    cls: "org-level",
    why: "BAR 1 of a CONJUNCTION, and the only one this census can see. An overlay is ALWAYS created at org-root containment, so its own scope IS the org root; the governance-managed sub-case adds overlay-repo.ts's policy:write bar on top. 2.5a ADDED a second bar at the resolved BASE object beside this one — it did NOT re-scope this one, which is why this entry stays. The pair is a deliberate TIGHTENING and the pure-widening invariant that governs the 21 re-scoped doors does not apply to it; the accepted consequence (a base with tombstoned ancestors is unreachable to everyone until its chain is repaired) is argued at the doors and pinned by routes/federation-overlay-base-authority.integration.test.ts"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/overlays/:idOrUrn :: object:read",
    cls: "org-level",
    why: "BAR 1 of the same conjunction as the create door above — overlays live at the org root, so re-scoping to the overlay's own id would expand to the same set. The base-scoped BAR 2 was added beside it, never substituted for it, and deliberately carries NO org-root arm: on a conjunction that arm is satisfied by everyone who just cleared this bar, so composing authz/org-root-arm.ts there would delete BAR 2 rather than fix anything (measured — mutation M-6 in the overlay test turns three cases red at once)"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/hand-fill :: federation:write",
    cls: "escalation-bar",
    why: "the outer door of the hand-fill path guarded by handfill-repo.ts's two org-root bars above"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/outposts :: federation:write",
    cls: "org-level",
    why: "an outpost record is a deployment-level relationship with a peer"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/outposts :: federation:read",
    cls: "org-level",
    why: "lists peer deployments; federation:read is explicitly not a re-scope candidate (§8.5)"
  },
  {
    site: "routes/federation.ts :: GET /api/v1/federation/outposts/:peerDomainId :: federation:read",
    cls: "org-level",
    why: "the peerDomainId names a PEER's domain, which is not an object in this org's graph, so it cannot be a scope"
  },
  {
    site: "routes/federation.ts :: PATCH /api/v1/federation/outposts/:peerDomainId :: federation:write",
    cls: "org-level",
    why: "same peer-side subject as the GET; there is no local object to scope at"
  },
  {
    site: "routes/federation.ts :: POST /api/v1/federation/outposts/:peerDomainId/reconcile :: federation:write",
    cls: "org-level",
    why: "reconciles the whole link's config state with the peer"
  },

  // ---- the type registry: a type is not contained by anything -----------------------------------
  {
    site: "routes/type-registry.ts :: POST /api/v1/type-registry/object-types :: type_registry:write",
    cls: "org-level",
    why: "an object TYPE is org-wide vocabulary and sits in no containment chain"
  },
  {
    site: "routes/type-registry.ts :: GET /api/v1/type-registry/object-types :: type_registry:read",
    cls: "org-level",
    why: "reads that same org-wide vocabulary; an object type is not owned by any container, so there is nothing narrower to scope the read at"
  },
  {
    site: "routes/type-registry.ts :: POST /api/v1/type-registry/relationship-types :: type_registry:write",
    cls: "org-level",
    why: "a relationship TYPE is org-wide vocabulary and sits in no containment chain"
  },
  {
    site: "routes/type-registry.ts :: GET /api/v1/type-registry/relationship-types :: type_registry:read",
    cls: "org-level",
    why: "reads that same org-wide vocabulary; a relationship type names endpoint types, not instances, so it has no containment scope"
  },

  // ---- org-scoped configuration with no per-object subject ---------------------------------------
  {
    site: "routes/doctor.ts :: GET /api/v1/doctor :: federation:read",
    cls: "org-level",
    why: "self-checks span the whole org, and the only check today compares this org's federation identity against its objects' origins"
  },
  {
    site: "routes/graph.ts :: GET /api/v1/graph/integrity :: graph:query",
    cls: "org-level",
    why: "reports rows that outlived the object they hang off, org-wide; a partial view would report a partial integrity verdict as a whole one"
  },
  {
    site: "routes/governance-move.ts :: GET /api/v1/governance/move-enforcement/rungs :: object:read",
    cls: "org-level",
    why: "lists every container where governance:move enforcement is enabled, plus the INSTANCE rung, which has no org-scoped subject at all"
  },
  {
    site: "routes/executors.ts :: GET /api/v1/environments/:environment/regional-executors :: object:read",
    cls: "org-level",
    why: "the view spans every region deployment-target in the environment; per-target reads are already gated when the operator binds each region"
  },
  {
    site: "routes/executors.ts :: PUT /api/v1/notifications/bindings/:instanceId :: object:write",
    cls: "org-level",
    why: "a notification binding is keyed by plugin instance id and hangs off the org, not off a graph object"
  },
  {
    site: "routes/executors.ts :: GET /api/v1/notifications/bindings :: object:read",
    cls: "org-level",
    why: "lists the same org-keyed rows the PUT writes; a plugin instance id is not a graph object, so there is no narrower scope"
  },
  {
    site: "routes/executors.ts :: DELETE /api/v1/notifications/bindings/:instanceId :: object:write",
    cls: "org-level",
    why: "removes the same org-keyed row the PUT writes, at the same scope, so the two doors cannot disagree on who may manage a binding"
  },
  {
    site: "routes/dependency-subscriptions.ts :: POST /api/v1/dependencies/inventory/backfill :: object:write",
    cls: "deferred",
    why: "DEFERRED — ingestion writes the org's whole inventory and defaults to every component when none is named; a per-component re-scope needs the target list first, like changes did"
  },

  // ---- LIST doors ------------------------------------------------------------------------------
  // 2.5b routes EVERY list door's gate through `authz/list-door-scope.ts`'s WIDE ARM — the two
  // entries directly below. Doors reached by 2.5b then fall into two shapes, and BOTH are correct:
  //
  //   - `/campaigns` and `/placements` pass the permission and org id as arguments, so the check is
  //     no longer written in the route and they have no entry of their own here;
  //   - `listObjects`'s four doors keep a `PermissionCheck` LITERAL in the route and hand the whole
  //     thing to the shared gate. Nothing is checked twice — the literal IS what the wide arm runs —
  //     and keeping it buys per-door visibility in this census, which matters most for
  //     `services/objects-service.ts`, the door a `routes/*.ts` census cannot see at all (§8.1).
  //
  // The remaining route entries (`/changes`, `/change-sources/.../mappings`, `/relationships`,
  // `/dependencies/producers`) are the doors 2.5b has not reached.
  {
    site: "authz/list-door-scope.ts :: readableScopeForListDoor() :: -",
    cls: "list-gate",
    why: "THE ONE DEFINITION of every LIST door's gate (role-model.md §8.2 step 5, increment 2.5b). Same permission, same org-root scope, run FIRST — so a caller who could list before still lists, over an unfiltered query (readableObjectFilterSql returns null for an org-root allow, i.e. today's SQL verbatim). What changed is only the REFUSAL path: instead of 403ing a subject bound below the org root, the door now resolves that subject's own allow roots and filters rows to their subtrees inside the repo, before the LIMIT. Left in the route as a literal `authorize({scopeObjectId: auth.orgId})` the widening would be measurably INERT — scope_expand from the org root is the org root alone, so the only subject who clears it is the one for whom the filter is null. The permission reads `-` because the call passes it by shorthand; it is the door's own permission parameter, object:read on both current callers"
  },
  {
    site: "authz/list-door-scope.ts :: refuseAtOrgRoot() :: input.permission",
    cls: "list-gate",
    why: "the SAME check again, on the refusal path only, so the 403 a subject with no allow binding anywhere receives is produced by re-running today's check rather than by a re-typed message that could drift from authorize()'s wording. Never reached when hasPermission has granted"
  },
  {
    site: "routes/changes.ts :: GET /api/v1/changes :: object:read",
    cls: "list-gate",
    why: "LIST — same pure-widening shape: keep the gate, filter the rows in 2.5b"
  },
  {
    site: "routes/change-sources.ts :: GET /api/v1/change-sources/:sourceKind/mappings :: object:read",
    cls: "list-gate",
    why: "LIST of source_mappings for one source kind; the per-mapping component scope is a 2.5b row filter, not a gate change"
  },
  {
    site: "routes/components.ts :: GET base :: object:read",
    cls: "list-gate",
    why: "DONE (2.5b) — the door §8.2 measured the per-row-filter failure on (5 readable components at cursor ranks 97..440 of 18,500). This literal is now the input to authz/list-door-scope.ts's wide arm, and listObjects filters rows in its WHERE before the LIMIT; routes/list-readable-scope.integration.test.ts pins full pages and an honest cursor"
  },
  {
    site: "routes/objects-generic.ts :: GET /api/v1/objects/:type :: object:read",
    cls: "list-gate",
    why: "DONE (2.5b) — one of listObjects's four callers, all four threaded; this literal is the input to the shared wide arm, not a second check"
  },
  {
    site: "routes/relationships.ts :: GET /api/v1/relationships :: relationship:read",
    cls: "list-gate",
    why: "LIST — a relationship's scope is its endpoints, which is a row filter, not a gate"
  },
  {
    site: "routes/typed-registries.ts :: GET base :: readPermission",
    cls: "list-gate",
    why: "DONE (2.5b) — the shared factory behind every typed registry, so one threading covers ~10 of them; readPermission drives BOTH the wide arm and the row filter, so the two cannot be edited apart"
  },
  {
    site: "routes/dependency-producers.ts :: GET /api/v1/dependencies/producers :: object:read",
    cls: "list-gate",
    why: "LIST of the org's own declarations; deliberately object:read and NOT the org-root policy:write the writes need"
  },
  {
    site: "services/objects-service.ts :: listServiceObjects() :: object:read",
    cls: "list-gate",
    why: "DONE (2.5b) — the door a routes/*.ts census cannot see at all (§8.1); it is the only handler that ever runs for GET /objects/service, and it is threaded like the three a string census does find"
  },

  // ---- deferred: §8.6 excluded these, or a later increment owns them ------------------------------
  {
    site: "routes/change-sources.ts :: POST /api/v1/change-sources/:sourceKind/mappings :: object:write",
    cls: "deferred",
    why: "DEFERRED — creating a mapping binds an org-wide repo/path pattern; the component it names is checked separately by source-mappings-repo.ts, and narrowing this gate is not 2.5a"
  },
  {
    site: "routes/governance.ts :: GET /api/v1/freezes :: object:read",
    cls: "deferred",
    why: "role-model.md §8.6 — a freeze blocking a ComponentAdmin is declared ABOVE them, so this needs the UPWARD closure; a downward filter would return only the freezes NOT blocking them and read green while the release is held"
  },
  {
    site: "routes/governance.ts :: GET /api/v1/freezes/:id :: object:read",
    cls: "deferred",
    why: "same upward-closure question as the list: re-scoping to freeze.scopeObjectId would hide exactly the freezes a narrow subject most needs to see"
  },
  {
    site: "routes/plans.ts :: POST /api/v1/plans :: object:read",
    cls: "deferred",
    why: "role-model.md §8.6 — re-scoping downward WIDENS here: the manifest is caller-supplied and the persisted diff reports each named object's current state"
  },
  {
    site: "routes/plans.ts :: GET /api/v1/plans/:id :: object:read",
    cls: "deferred",
    why: "reading a plan reads the same caller-supplied manifest and its diff, so it inherits POST /plans's exclusion"
  }
];

/**
 * THE ORG ROOT AS A FALLBACK, not as a pin. Every one of these scopes to a declared containment
 * parent and lands on the org root only when none was declared — which is what `null` MEANS at the
 * wire boundary (ADR-0021 D4), and what `containment-parent-doors-census.integration.test.ts` pins
 * behaviourally. Listed so that a new door whose left operand is always `undefined` — a pin wearing
 * a `??` — cannot arrive unnoticed.
 */
const ORG_ROOT_FALLBACK: readonly CensusEntry[] = [
  {
    site: "governance/gate-orchestrator.ts :: checkFreeze() :: freeze:override",
    cls: "org-level",
    why: "a PLATFORM-tier freeze is declared instance-wide and has no scope object, so overriding one is checked at the org root; every other tier is checked at its own declared scope"
  },
  {
    site: "iac/plans-repo.ts :: prepareApplyChecks() :: writePermissionFor",
    cls: "org-level",
    why: "each manifest entry is checked at its own declared containment parent; org root only when the entry declares none"
  },
  {
    site: "routes/campaigns.ts :: POST /api/v1/campaigns :: object:write",
    cls: "org-level",
    why: "create at the declared parent; the per-target authority check is assertCoordinationTargetsWithinAuthority, separately"
  },
  {
    site: "routes/changes.ts :: POST /api/v1/changes :: object:write",
    cls: "org-level",
    why: "create at the declared parent; §8.4 — a change has no scope of its own, so its TARGETS are what carry authority"
  },
  {
    site: "routes/changes.ts :: POST /api/v1/changes :: change:emergency",
    cls: "org-level",
    why: "the emergency escalation is checked at the same declared parent as the create it accompanies"
  },
  {
    site: "routes/components.ts :: POST base :: object:write",
    cls: "org-level",
    why: "components.ts:310's declaredParent form IS the in-tree pattern 2.5a copied; org root only when no parent was declared"
  },
  {
    site: "routes/components.ts :: PUT `${base}/:urn` :: object:write",
    cls: "org-level",
    why: "the upsert branch of the same door, checked at the same declared parent"
  },
  {
    site: "routes/objects-generic.ts :: POST /api/v1/objects/:type :: object:write",
    cls: "org-level",
    why: "generic create at the declared parent; the `?? auth.orgId` is ADR-0021 D4's wire meaning of `domainId: null`, not a pin"
  },
  {
    site: "routes/objects-generic.ts :: POST /api/v1/objects/:type :: -",
    cls: "org-level",
    why: "ADR-0031's assertMayDeclareDomainLocal, checked at the same declared parent as the create beside it"
  },
  {
    site: "routes/objects-generic.ts :: PUT /api/v1/objects/:type/:urn :: object:write",
    cls: "org-level",
    why: "on an existing row the scope is the row itself; on a create it is the declared parent, org root only when none was declared"
  },
  {
    site: "routes/placements.ts :: POST base :: object:write",
    cls: "org-level",
    why: "create at the declared parent; a placement declares its own containment like every other typed create door"
  },
  {
    site: "routes/typed-registries.ts :: POST base :: writePermission",
    cls: "org-level",
    why: "the shared typed-registry factory's create, at the declared parent"
  },
  {
    site: "routes/typed-registries.ts :: POST base :: -",
    cls: "org-level",
    why: "ADR-0031's assertMayDeclareDomainLocal on the same create"
  },
  {
    site: "routes/typed-registries.ts :: PUT `${base}/:urn` :: writePermission",
    cls: "org-level",
    why: "typed-registries.ts:311-315's existing-row form is the OTHER in-tree pattern 2.5a copied: existing row -> its own id, create -> declared parent"
  },
  {
    site: "services/objects-service.ts :: createServiceObject() :: object:write",
    cls: "org-level",
    why: "the door a routes/*.ts census cannot see (§8.1); spelled `scopeObjectId ?? orgId` with no `auth.` prefix"
  },
  {
    site: "services/objects-service.ts :: createServiceObject() :: -",
    cls: "org-level",
    why: "ADR-0031's assertMayDeclareDomainLocal on that same invisible door, covering both POST /objects/service and its /orgs/:org/ form"
  }
];

/**
 * THE ORG ID AS AN ARGUMENT, not as a scope. The scope is computed by a helper that takes the org id
 * as its TENANT parameter. These are not org-root scoped — they are listed so that moving a scope
 * computation into a helper is not an unwatched way to reintroduce the pin.
 */
const ORG_ROOT_DERIVED: readonly CensusEntry[] = [
  {
    site: "governance/gate-orchestrator.ts :: prewarmGovernanceForChange() :: -",
    cls: "org-level",
    why: "resolveApprovalScope(tx, input.orgId, primaryTarget, req.scope) — the org id is the tenant argument; the scope resolves from the change's primary TARGET"
  },
  {
    site: "governance/gate-orchestrator.ts :: evaluateGovernanceGate() :: -",
    cls: "org-level",
    why: "the same resolveApprovalScope call on the evaluate path; both must agree, which is why they are both listed"
  },
  {
    site: "services/objects-service.ts :: createServiceObject() :: object:write",
    cls: "org-level",
    why: "resolveDeclaredContainmentParent({orgId, …}) — the org id is the tenant argument; the result is the DECLARED parent, and the `?? orgId` fallback beside it is the entry above"
  }
];

/**
 * KNOWN-POSITIVE CONTROL for this file's own discovery. These three tracked files under
 * `apps/server/src` contain literal NUL bytes (a composite-key delimiter — correct, and must not be
 * "fixed"; `pnpm nul-census` is the authority on the current set). Every recursive search tool this
 * repo reaches for classifies them as binary and DROPS THEM SILENTLY. This test's discovery must
 * not, and asserting that it does not is the only way to know.
 */
const NUL_CARRYING_FILES = [
  "dependencies/ingestion-stamp-repo.ts",
  "dependencies/internal-release-detection.ts",
  "iac/plan-diff.ts"
] as const;

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** An expression that IS the org root: `orgId`, `auth.orgId`, `input.orgId`, `check.orgId`, and the
 *  `getOrgRootObjectId` results, whose value is the org id by the bootstrap invariant. */
const ORG_ROOT_EXPRESSION =
  /^(?:[A-Za-z_$][\w$]*\.)*orgId$|^(?:root|orgRoot)ObjectId!?$|^orgRootId!?$/;
/** The same, anywhere inside a larger expression. */
const ORG_ROOT_TOKEN =
  /(?:^|[^\w$.])(?:(?:[A-Za-z_$][\w$]*\.)*orgId|(?:root|orgRoot)ObjectId|orgRootId)\b/;
/** BOTH spellings of "a scopeObjectId is being set": the object property, and the `const`/`let`
 *  that is later passed as one. Missing the second is how `components.ts:310` and
 *  `iac/plans-repo.ts` stayed invisible to the original census. */
const SCOPE_ASSIGNMENT = /\bscopeObjectId\s*:|\b(?:const|let)\s+scopeObjectId(?:\s*:[^=]*)?\s*=/g;

/** The value expression assigned at `start`, up to the `,`/`;`/closer that ends it at depth 0. */
function valueExpression(source: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    const c = source[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) break;
  }
  return source.slice(start, i).trim().replace(/\s+/g, " ");
}

/** The expression with every `name(...)` call collapsed to `@`, so that an org id passed as a
 *  helper's TENANT argument stops looking like a scope. */
function withoutCallArguments(expression: string): string {
  let previous: string;
  let current = expression;
  do {
    previous = current;
    current = current.replace(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\s*\([^()]*\)/g, "@");
  } while (current !== previous);
  return current;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `{` opening the object literal that encloses `index`, or -1. */
function enclosingBrace(source: string, index: number): number {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    if (source[i] === "}") depth++;
    else if (source[i] === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * A stable name for the door this check belongs to: `METHOD url` when the site sits inside a
 * `typed.route({…})` block (the form every route file but `events.ts`/`oidc.ts` uses), else the
 * `app.get("…")` form, else the enclosing top-level function. A NAME rather than a line number, so
 * that editing anything above a door does not churn the checked-in list — and so that the failure
 * message names the door a reviewer has to make a decision about.
 */
function doorOf(source: string, index: number): string {
  let innermost: { open: number; close: number } | null = null;
  for (const match of source.matchAll(/(?:typed|app|server)\s*\.\s*route\s*\(\s*\{/g)) {
    const open = source.indexOf("{", match.index);
    const close = matchingBrace(source, open);
    if (open < index && index < close && (!innermost || open > innermost.open)) {
      innermost = { open, close };
    }
  }
  if (innermost) {
    const head = source.slice(innermost.open, innermost.close);
    const method = /method\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? "?";
    // `url:` is a literal in most files and a `base`/template in the shared route factories
    // (`components.ts`, `placements.ts`, `typed-registries.ts`) — keep whichever text is there.
    const url = /url\s*:\s*("[^"]*"|`[^`]*`|[A-Za-z_$][\w$]*)/.exec(head)?.[1] ?? "?";
    return `${method} ${url.replace(/^"|"$/g, "")}`;
  }
  let inline: RegExpExecArray | RegExpMatchArray | null = null;
  for (const match of source.matchAll(
    /\b(?:app|server|typed)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*"([^"]+)"/g
  )) {
    if (match.index < index) inline = match;
  }
  if (inline) return `${inline[1]!.toUpperCase()} ${inline[2]!}`;
  let fn = "?";
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=/gm
  )) {
    if (match.index < index) fn = `${match[1] ?? match[2]}()`;
  }
  return fn;
}

interface Site {
  site: string;
  expression: string;
}

interface Census {
  pinned: Site[];
  fallback: Site[];
  derived: Site[];
  scannedFiles: string[];
}

function runCensus(): Census {
  const census: Census = { pinned: [], fallback: [], derived: [], scannedFiles: [] };
  for (const file of productionSourceFiles(SERVER_SRC).sort()) {
    const rel = relative(SERVER_SRC, file);
    census.scannedFiles.push(rel);
    // `readStripped`, never a bare `readFileSync`: a commented-out check must not count as a check.
    const source = readStripped(file);
    for (const match of source.matchAll(SCOPE_ASSIGNMENT)) {
      const expression = valueExpression(source, match.index + match[0].length);
      let bucket: Site[];
      if (ORG_ROOT_EXPRESSION.test(expression)) bucket = census.pinned;
      else if (ORG_ROOT_TOKEN.test(withoutCallArguments(expression))) bucket = census.fallback;
      else if (ORG_ROOT_TOKEN.test(expression)) bucket = census.derived;
      else continue;
      const open = enclosingBrace(source, match.index);
      const literal = open === -1 ? "" : source.slice(open, matchingBrace(source, open) + 1);
      const permission =
        /permission\s*:\s*"([^"]+)"/.exec(literal)?.[1] ??
        /permission\s*:\s*([A-Za-z_$][\w$.]*)/.exec(literal)?.[1] ??
        "-";
      bucket.push({
        site: `${rel} :: ${doorOf(source, match.index)} :: ${permission}`,
        expression
      });
    }
  }
  return census;
}

const REMEDY = [
  "",
  "A NEW org-root-scoped check is not automatically wrong — but it is automatically a DECISION.",
  "`authz/resolve.ts` expands a scope UPWARD ONLY, so a check pinned at the org id can be satisfied",
  "by an org-root binding and by nothing else: no service-, assembly- or component-scoped binding",
  "can ever reach it. Before adding an entry, answer which one this is:",
  "",
  "  org-level      the subject has no place in the containment graph below the org root",
  "                 (federation identity, the type registry, instance configuration).",
  "  escalation-bar org-root ON PURPOSE, so a narrower binding CANNOT satisfy it. Widening one of",
  "                 these is a security regression (role-model.md §8.6).",
  "  list-gate      a LIST door. Keep this check and filter rows inside the repo before the LIMIT",
  "                 (role-model.md §8.2) — post-filtering a keyset page silently drops rows.",
  "  deferred       you know it should be narrower and something else owns that. Say WHAT owns it.",
  "",
  "If it is none of those, the door governs an object — scope it to that object instead. The in-tree",
  "pattern is `routes/components.ts:310-311` and `routes/typed-registries.ts:311-315`. RESOLVE THE",
  "OBJECT FIRST and 404 if it is absent: `scopeExpandCte` seeds the CTE with the raw uuid and never",
  "checks existence, so scoping at an unresolved path param turns a 404 into a 403.",
  ""
].join("\n");

function diff(label: string, actual: Site[], allowlist: readonly CensusEntry[]): string {
  const listed = new Set(allowlist.map((e) => e.site));
  const found = new Map(actual.map((s) => [s.site, s.expression]));
  const unlisted = [...found.keys()].filter((s) => !listed.has(s)).sort();
  const stale = [...listed].filter((s) => !found.has(s)).sort();
  if (unlisted.length === 0 && stale.length === 0) return "";
  const lines = [`${label}: the set of org-root-scoped checks changed.`, ""];
  for (const s of unlisted) lines.push(`  + UNLISTED  ${s}   (scope: ${found.get(s)!})`);
  for (const s of stale) lines.push(`  - STALE     ${s}   (no longer found — was it re-scoped?)`);
  if (unlisted.length > 0) lines.push(REMEDY);
  if (stale.length > 0) {
    lines.push(
      "",
      "A STALE entry means the door was re-scoped, renamed or deleted — most likely re-scoped, which",
      "is the direction this work is going. DELETE THE ENTRY. Do not re-pin the door at the org root",
      "to make this green: that would undo a widening and lock every sub-org binding back out.",
      ""
    );
  }
  return lines.join("\n");
}

describe("org-root scope census", () => {
  const census = runCensus();

  it("discovery reads the NUL-carrying files instead of silently dropping them", () => {
    // The control, in both directions: the files are in the scanned set AND they really do carry
    // the byte that makes every recursive search tool drop them. If a future edit removes the NUL
    // from all three, this control stops controlling anything, so assert the byte too.
    for (const rel of NUL_CARRYING_FILES) {
      expect(census.scannedFiles, `${rel} was dropped from discovery`).toContain(rel);
      const bytes = readFileSync(resolve(SERVER_SRC, rel));
      expect(bytes.includes(0), `${rel} no longer contains a NUL byte`).toBe(true);
      expect(readStripped(resolve(SERVER_SRC, rel)).length).toBeGreaterThan(0);
    }
    // A discovery that returned almost nothing would make every assertion below vacuously green.
    expect(census.scannedFiles.length).toBeGreaterThan(250);
    expect(census.pinned.length + census.fallback.length + census.derived.length).toBeGreaterThan(
      50
    );
  });

  it("every check pinned unconditionally at the org root is on the allowlist", () => {
    expect(diff("ORG_ROOT_PINNED", census.pinned, ORG_ROOT_PINNED)).toBe("");
  });

  it("every check that FALLS BACK to the org root is on the fallback list", () => {
    expect(diff("ORG_ROOT_FALLBACK", census.fallback, ORG_ROOT_FALLBACK)).toBe("");
  });

  it("every scope computed from the org id by a helper is on the derived list", () => {
    expect(diff("ORG_ROOT_DERIVED", census.derived, ORG_ROOT_DERIVED)).toBe("");
  });

  it("every entry carries a real justification and a known class", () => {
    for (const entry of [...ORG_ROOT_PINNED, ...ORG_ROOT_FALLBACK, ...ORG_ROOT_DERIVED]) {
      expect(ENTRY_CLASSES, entry.site).toContain(entry.cls);
      // A one-word "why" is how an allowlist stops forcing the decision it exists to force.
      expect(entry.why.length, `${entry.site} needs a real justification`).toBeGreaterThan(40);
    }
    const sites = [...ORG_ROOT_PINNED, ...ORG_ROOT_FALLBACK].map((e) => e.site);
    expect(new Set(sites).size, "duplicate site key — the key stopped being unique").toBe(
      sites.length
    );
  });
});

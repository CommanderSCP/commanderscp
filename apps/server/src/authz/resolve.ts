import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";
import {
  CONTAINMENT_WALK_MAX_DEPTH,
  WALK_TRUNCATION_PROBE_DEPTH,
  placementParentsSql,
  walkDepthExceeded
} from "../graph/containment.js";

/**
 * RBAC permission resolution (DESIGN.md §7). One recursive CTE does both expansions the design
 * calls for in the same query:
 *
 *  - **Subject expansion**: the acting subject (a `user`/`service-account` graph object) plus
 *    every group/team it transitively belongs to via built-in `member_of` relationships.
 *  - **Scope (containment) expansion**: the target object plus every containing ancestor, by two
 *    routes — `objects.domain_id` up to the org root (every object's chain is BUILT to terminate
 *    there — graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so
 *    this walk never needs NULL special-casing beyond the root itself; a TOMBSTONED ancestor cuts
 *    it short, which is the caveat on route 1 in `scopeExpandCte`'s doc and matters more than it
 *    reads), AND the `contains` edge from a component to its service (migration 0021), which is
 *    what finally makes DESIGN §7's documented `component -> service -> domain -> organization`
 *    chain real. See `scopeExpandCte`.
 *
 * `role_bindings` rows whose `(subject, scope)` pair matches either expansion, and whose role
 * grants the requested permission, are collected; an explicit `deny` at ANY matching scope wins
 * over any `allow` (deny-override, DESIGN.md §7). No matching binding at all is a default deny.
 * Both expansions are depth-limited to 10 (DESIGN.md §5's traversal bound, reused here).
 */
/**
 * THE PERMISSION CATALOGUE — the single runtime source of truth, and the reason it is an
 * ARRAY and not a union.
 *
 * This was a hand-written `type Permission = "a" | "b" | ...` union for its whole life, which
 * a TypeScript build erases: there was NO value at runtime enumerating the permissions this
 * system defines, so nothing could ever ask "is every permission I define actually granted to
 * somebody, and demanded somewhere?". `org:admin` is what that costs — seeded to Owner by
 * drizzle/0002, demanded at ZERO call sites for its entire life, and removed only when a human
 * ran a census by hand in 2026-08 because `GET /roles` was about to publish it.
 *
 * `Permission` is now DERIVED from this array (below), so the type and the enumeration cannot
 * disagree: adding a member to one adds it to the other, and there is no edit that changes the
 * union without changing what the drift gate iterates. That is the property; the array is just
 * how it is obtained.
 *
 * ORDER IS PRESENTATION ONLY. Grouped by the milestone that introduced each member, because
 * the comments below carry the reasoning per member and reasoning reads chronologically.
 * Nothing depends on the order — `role-model.md` §5 step 4's gate compares SETS.
 */
export const PERMISSIONS = [
  "object:read",
  "object:write",
  "relationship:read",
  "relationship:write",
  "type_registry:read",
  "type_registry:write",
  "role_binding:write",
  "graph:query",
  "audit:read",
  // (`org:admin` was here. Seeded to Owner alone by drizzle/0002 and demanded at ZERO call sites
  // for its whole life, it was REMOVED by drizzle/0099 — the one deliberate subtraction in an
  // otherwise additive design, taken now because role-model.md §5 step 5's `GET /roles` is about
  // to publish these strings, and a permission that gates nothing while advertising authority in
  // a roles listing is worse than no permission at all. Subtraction from a built-in role is
  // normally unsafe here — `org_id IS NULL` rows are SHARED SINGLETONS read by every org through
  // the `roles` RLS `USING (... OR org_id IS NULL)` clause, so removing a permission narrows every
  // org on every deployment at once with no per-org opt-out (role-model.md §2). It is safe for
  // exactly this one because no code path has ever asked for it, which is a property the
  // filterless census re-run for drizzle/0099 measured rather than assumed.)
  "approval:write",
  // M4 governance (DESIGN.md §7's example role bindings name these exactly):
  "policy:write",
  "freeze:write",
  "freeze:override",
  "change:emergency",
  // M6 federation (DESIGN.md §13) — OPERATING the link (export/import/hand-fill/outposts/resync/
  // poke) vs read-only status/self. Pairing still requires `federation:write` and ALSO requires
  // `federation:pair` below, so `federation:write` alone no longer admits a peer.
  "federation:read",
  "federation:write",
  // THE SECOND BAR ON PAIRING — adding a federation peer, or re-keying one (owner ruling D4,
  // 2026-08-25; docs/proposals/role-model.md §4.1). Demanded by `POST /api/v1/federation/peers`
  // (`routes/federation.ts`) ON TOP OF the `federation:write` that door already demanded — added,
  // never substituted, so nothing that could pair before this permission existed can pair without it.
  //
  // THE CHAIN IT CLOSES. `POST /federation/peers` takes the peer's Ed25519 `publicKey` VERBATIM from
  // the request body, and `POST /federation/imports` — same single `federation:write` — hands every
  // entry of a bundle signed by that key to `applyEntry`, whose `object_upsert` branch resolves ANY
  // registered `typeId` through `upsertObjectByUrn`. So on `federation:write` alone: pair a peer with
  // a keypair you generated, import a bundle you signed with it, and you hold estate write authority
  // having never held `object:write`. Pairing is the only link in that chain that can be gated — a
  // throw on the IMPORT path wedges a legitimately paired peer's whole signed bundle, and an import
  // from a legitimately paired peer writing what that peer sent IS the federation contract working.
  //
  // WHY NOT JUST `federation:write`. The two are different acts: operating a link that somebody with
  // standing established, versus establishing one. Only the second decides WHOSE SIGNATURE this
  // instance will believe, which is the trust anchor for every bundle that arrives afterwards. A
  // FederationAdmin role — `federation:read` + `federation:write`, `object:write` deliberately
  // withheld — is being written on exactly that split, so folding the two together would make the
  // role a lie the day it is bound.
  //
  // NARROWS NOTHING LIVE. drizzle/0094 grants it to Administrator and Owner, which drizzle/0012
  // already makes the only holders of `federation:write`; no principal that can pair today loses the
  // ability. It is withheld from the future FederationAdmin, which is the whole point.
  //
  // SCOPED AT THE ORG ROOT, like every other check on these routes: `federation_peers` rows are an
  // org-instance-wide concern with no containment scope of their own.
  //
  // NOT DEMANDED BY `PATCH /federation/peers/{id}`, which is transport-only: its request schema
  // (`UpdateFederationPeerRequestSchema`) admits no key material at all, so that door cannot rotate,
  // supersede or revoke a trust anchor — the capability is absent from the contract, not merely
  // unused. Editing a peer's endpoint stays `federation:write`; the moment that body could carry a
  // key, this permission belongs there too.
  "federation:pair",
  // The OPT-IN second bar on a containment MOVE (drizzle/0083,
  // docs/proposals/governance-reach-on-containment-move.md §9.2, owner ruling 2026-08-18). Demanded
  // at-or-above the moved object AND at-or-above the destination — and ONLY where a rung of the
  // move-enforcement lattice is enabled, so it is inert on every deployment that has set none.
  //
  // Granted by drizzle/0083 to Administrator and Owner alone (owner decision Q2-A), deliberately NOT
  // to Operator: Operator/Approver/Administrator/Owner all hold `object:write`, so an
  // Operator-and-above grant would make every principal who can move also able to move under
  // enforcement — the lattice would be inert until custom roles exist, and nothing authors one yet.
  "governance:move",
  // M25.6b (campaigns-rework §4.5, ADR-0042 §9) — WAIVE A CAMPAIGN'S DEADLINE FOR ONE TARGET.
  // Granted by drizzle/0088 to Owner ALONE, the `freeze:override` grant's shape exactly.
  //
  // CHECKED AT THE CAMPAIGN OBJECT, never at the target. The thing being waived is *this campaign's*
  // deadline, so the authority that waives it is authority over the campaign; a target-scoped check
  // would hand the laggard their own waiver — the component's own operator excusing the component
  // from the migration the campaign exists to force. `routes/campaigns.ts` then demands plain
  // `object:write` AT EACH NAMED TARGET as a second, narrower bar, so a waiver cannot be minted over
  // a component the actor has no standing on.
  //
  // DELIBERATELY NOT `freeze:override`, which was available and is the wrong shape: one permission
  // would then carry two unrelated blast radii — a freeze-override holder could waive migration
  // deadlines and a deadline-waiver holder could bypass release freezes — and neither grant could
  // afterwards be narrowed without taking the other with it.
  "campaign:deadline-override",
  // ===========================================================================================
  // THE THREE PERMISSION SPLITS (role-model.md §5 step 3; drizzle/0099)
  // ===========================================================================================
  // The permission census behind them found `object:write` demanded at 62 call sites and
  // `object:read` at 45 — 107 of 170 — while every purpose-built high-consequence permission
  // (`freeze:override`, `change:emergency`, `campaign:deadline-override`, `approval:write`,
  // `audit:read`) is demanded exactly once. The care spent designing narrow permissions was not
  // reflected in what actually gated the estate. These three take the highest-consequence acts
  // back out of the two generic verbs.
  //
  // ONE OF THE THREE SUBSTITUTES, TWO ARE ADDED. Which is which is the load-bearing detail and is
  // stated on each member below; getting it backwards either silently deletes a bar or breaks a
  // door nobody meant to break.

  // SUBSTITUTES `object:write` at the three CREDENTIAL doors (role-model.md §1.3d): `PUT` and
  // `DELETE /api/v1/secrets/{key}` (`routes/executors.ts`) and `PUT
  // /api/v1/change-sources/{sourceKind}/webhook-secret` (`routes/change-sources.ts`). Scope is
  // unchanged — still the org root, still one of §8.6's deliberate escalation bars — and ONLY the
  // permission moves.
  //
  // THREE UNRELATED BLAST RADII SHARED ONE GRANT. Writing the tokens SCP uses to reach
  // GitHub/ArgoCD/Terraform; DELETING them, which is an availability kill switch for all
  // coordination on the deployment; and rotating the HMAC secret that authenticates inbound
  // webhooks — where whoever sets the secret can thereafter forge signed source events into the
  // estate. There was no way to give anyone ordinary org-root `object:write` without also handing
  // them every execution-system credential the org holds.
  //
  // THIS IS A BREAKING CHANGE, DELIBERATELY, AND THE ONLY SUBSTITUTION OF THE THREE. A principal
  // holding org-root `object:write` and nothing else is now 403 at all three doors. drizzle/0099
  // grants it to Owner, Administrator and the new OrgAdmin, so the built-in ladder is unaffected;
  // what loses the capability is a custom or purpose role that holds `object:write` alone.
  //
  // WITHHELD FROM SecurityOfficer ON PURPOSE. Holding the org's outbound credentials is an
  // OPERATIONS act, not a compliance one — a security officer authors ceilings and decides
  // waivers, and giving them custody of the tokens that reach production would put the auditor
  // inside the thing being audited.
  "secret:write",
  // ADDED TO — never substituted for — the `policy:write` already demanded on the scan-override
  // DECIDE door (approve | deny | revoke) in `routes/scan-override-grants.ts`. Both are demanded,
  // at the same derived tier object, in that order.
  //
  // AUTHORING A SCAN CEILING AND WAIVING IT WERE THE SAME PERMISSION STRING AT THE SAME SCOPE
  // (role-model.md §1.3e): rule authoring is `policy:write` at the tier
  // (`routes/typed-registries.ts`), and deciding a waiver against that rule was `policy:write` at
  // the tier too. A textbook separation-of-duty violation, which the route file itself concedes —
  // its raiser≠approver check "survives intact the moment any SECOND principal holds the same
  // scoped `policy:write`", which is to say it closes the one-actor shape and nothing else.
  //
  // GRANTED TO Owner, Administrator AND the new SecurityOfficer (owner ruling D3 — no sixth
  // `ScanWaiverApprover` role). Granting it to Administrator is what makes this a NO-OP on every
  // live deployment: `policy:write` is held today by Administrator and Owner alone (drizzle/0010),
  // so every principal who can decide a waiver today still can, and no in-flight waiver starts
  // 403ing on upgrade.
  //
  // THE SEPARATION OF DUTY IS THAT IT IS SEPARATELY WITHHOLDABLE. OrgAdmin holds `policy:write`
  // and NOT this, so an org can seat an estate administrator who authors org policy and a security
  // officer who owns the waiver, and neither is the other. That was impossible while the two acts
  // shared one string, because the cumulative ladder welds a permission's blast radius to its rank.
  "scan:override",
  // ADDED TO — never substituted for — the `object:write` already demanded at EVERY target of
  // `POST /api/v1/changes/{id}/accept` and `POST /api/v1/changes/{id}/rollback`
  // (`routes/changes.ts`). Same per-target loop, same EVERY-target quantifier, same org-root arm
  // evaluated first; see `assertAcceptableAtEveryChangeTarget`.
  //
  // WHY PER TARGET AND NOT AT THE CHANGE (role-model.md §4.3/§8.4, MEASURED). A change has no
  // scope of its own: `objects.domain_id` for a change is the org root for every one of the five
  // internal `proposeChange` callers, and `scp change propose` has no `--domain` flag, so both
  // `scopeObjectId: change.domainId` and `scopeObjectId: change.id` are inert — they READ as a
  // narrowing and ARE the org-root pin they replaced.
  //
  // `cancel` DELIBERATELY DOES NOT DEMAND IT. Cancelling STOPS a release rather than authorizing
  // one; folding it in would make a cancel-only incident-responder role — hold `object:write`,
  // stop a bad release, authorize nothing — inexpressible, and that role is the obvious one an org
  // wants to seat on-call.
  //
  // THIS IS THE ONE INTENTIONALLY BREAKING GRANT IN THE DESIGN. drizzle/0099 grants it to Owner,
  // Administrator, OrgAdmin, ServiceAdmin and ComponentAdmin, and DELIBERATELY NOT to Operator or
  // Approver — both of which hold `object:write` and can accept and roll back releases today. On
  // upgrade they stop being able to, which is the point: accepting a release into production is
  // not the same authority as editing the graph, and it was only ever the same string because the
  // ladder had no way to say otherwise. It must be announced, not discovered.
  "change:accept"
] as const;

/**
 * One permission string. DERIVED from {@link PERMISSIONS} rather than declared beside it —
 * see that array's doc for why the runtime value has to exist at all.
 */
export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionCheck {
  orgId: string;
  subjectObjectId: string;
  permission: Permission;
  /** The object whose containment chain is checked — usually the object being read/written. */
  scopeObjectId: string;
}

/**
 * THE `member_of` CLOSURE — **ONE definition of the walk, emitted in either direction.**
 *
 * `member_of` is registered `from_id = the member`, `to_id = the group`. Reading it forwards answers
 * "which groups does this principal count as" (`subjectExpandCte`); reading the SAME edges backwards
 * answers "which principals does this group reach" (`memberExpandCte`). Everything else about the
 * two is identical — the org predicate, the live-edge filter, the depth bound, and `UNION` rather
 * than `UNION ALL` so a `member_of` cycle terminates instead of spinning — so the direction is a
 * parameter here rather than a second body.
 *
 * That is not tidiness. The two directions are used to answer the two halves of ONE rule
 * (`authz/role-binding-door.ts` §2a and §2b): the join door asks "what will this joiner inherit"
 * and the grant door asks "who does this binding reach". If the walks disagreed about a live edge,
 * about the bound, or about cycle termination, one ordering of the same two requests would be
 * guarded and the other would not — which is the defect §2b exists to close, re-introduced one level
 * down.
 *
 * `sql.raw` is used for the CTE and column NAMES only. Both are module-local string literals chosen
 * by the two wrappers below; no caller supplies either.
 */
type MemberOfWalkDirection = "member-to-groups" | "group-to-members";

function memberOfClosureCte(opts: {
  orgId: string;
  seedObjectId: string;
  cteName: string;
  columnName: string;
  direction: MemberOfWalkDirection;
  maxDepth: number;
}) {
  const cte = sql.raw(opts.cteName);
  const column = sql.raw(opts.columnName);
  const step =
    opts.direction === "member-to-groups"
      ? sql`SELECT r.to_id, w.depth + 1 FROM relationships r JOIN ${cte} w ON r.from_id = w.${column}`
      : sql`SELECT r.from_id, w.depth + 1 FROM relationships r JOIN ${cte} w ON r.to_id = w.${column}`;
  return sql`
    ${cte} AS (
      SELECT ${opts.seedObjectId}::uuid AS ${column}, 0 AS depth
      UNION
      ${step}
      WHERE r.org_id = ${opts.orgId} AND r.type_id = 'member_of' AND r.deleted_at IS NULL
        AND w.depth < ${opts.maxDepth}
    )
  `;
}

/**
 * THE `member_of` SUBJECT EXPANSION — emitted as the `subject_expand` CTE term.
 *
 * "Who does this subject count as" — itself, plus every group/team it transitively belongs to,
 * walked `from_id -> to_id` over live `member_of` edges. It is the reason a role binding held by a
 * GROUP grants authority to that group's members, and therefore the reason `graph/relationships-repo.ts`
 * has to apply the role-binding door's subset rule when a `member_of` edge is CREATED
 * (`authz/role-binding-door.ts` §2a): writing this edge is what makes the binding reach a new
 * principal.
 *
 * EXTRACTED 2026-08-27 BECAUSE IT WAS ABOUT TO BE HAND-TYPED FOR THE FIFTH TIME. The three copies in
 * this file — `hasPermission`, `hasRoleAtScope` and `assertDenyNotTruncated` — were byte-identical
 * apart from the depth bound, and they now compose this. Copies that are NOT converted here, named
 * rather than left for the next census to rediscover: `authz/readable-scope.ts` (the LIST-door
 * closure) and `governance/policy-resolve.ts` (`isMemberOf`, and `ownedByGroupOrItsMembers`'s
 * downward group→members walk, which is `memberExpandCte`'s question with a different SELECT list
 * and deliberately no depth bound). Those are out of this change's scope; this docblock is the
 * record that they exist.
 */
export function subjectExpandCte(
  orgId: string,
  subjectObjectId: string,
  // ADR-0037: the shared bound by default; the truncation PROBE passes one-past-the-bound so a deny
  // can be told apart from a walk that was cut. Callers other than the probe never override.
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
  return memberOfClosureCte({
    orgId,
    seedObjectId: subjectObjectId,
    cteName: "subject_expand",
    columnName: "subject_id",
    direction: "member-to-groups",
    maxDepth
  });
}

/**
 * THE INVERSE WALK — emitted as the `member_expand` CTE term. Same edges, same bound, read the other
 * way: the seed group/team, plus every principal (and nested group) that transitively reaches it.
 *
 * WHY A SECOND DIRECTION EXISTS AT ALL. `subjectExpandCte` is seeded at a KNOWN principal and finds
 * the groups above it, which is what a permission check needs. `authz/role-binding-door.ts` §2b asks
 * the opposite question — a binding is about to be written ON a group, and the door needs the
 * principals BELOW it — and the group is the known end there. Seeding `subjectExpandCte` at the
 * group would walk further UP into the groups the group belongs to, which is a different set and
 * answers nothing about who the binding empowers.
 *
 * The seed row is included at depth 0, so a caller that also wants "the subject itself" gets it
 * without a special case; a caller that wants members ONLY filters `depth > 0`.
 */
export function memberExpandCte(
  orgId: string,
  groupObjectId: string,
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
  return memberOfClosureCte({
    orgId,
    seedObjectId: groupObjectId,
    cteName: "member_expand",
    columnName: "member_id",
    direction: "group-to-members",
    maxDepth
  });
}

/**
 * The scope (containment) expansion, shared by `hasPermission` and `hasRoleAtScope` so the two can
 * never drift — they answer different questions ("has permission P" vs "holds role R") but MUST agree
 * on what "at-or-above this scope" means, or an Approver bound at a service would be eligible for one
 * check and not the other.
 *
 * Walks the target object plus every containing ancestor, by THREE routes:
 *
 *  1. `objects.domain_id` — up to the org root (objects-repo.ts defaults `domainId` to the org root at
 *     creation, so every chain STARTS OUT terminating there). It does not always END there: the
 *     ancestor JOIN below filters `deleted_at IS NULL`, so the walk STOPS at the first tombstoned
 *     ancestor and `scope_expand` is then whatever it reached below that point — the seed row alone
 *     when the immediate parent is the tombstone. Such a set matches no org-root binding at all,
 *     the Owner's included. That is deliberate (see the JOIN's own comment) and it is why every
 *     door re-scoped off an org-root pin needs `authz/org-root-arm.ts`'s disjunction rather than a
 *     bare check at the object it governs.
 *  2. `contains` — a component's SERVICE is a containing scope (migration 0021,
 *     docs/proposals/service-component-model.md). DESIGN §7 has always described the chain as
 *     `component -> service -> domain -> organization`; until 0021 there was no service edge to walk,
 *     so the documented behaviour did not exist. This is what makes a service-scoped role binding
 *     reach that service's components.
 *  3+4. a `placement`'s COMPONENT and its DEPLOYMENT-TARGET (ADR-0026), composed from the very same
 *     fragment `graph/containment.ts` walks — `placementParentsSql`. Sharing the SQL is deliberate:
 *     routes 1 and 2 are hand-synced between these two files and DID drift once, with a
 *     service-scoped freeze failing open and a service-scoped approval failing closed. A route that
 *     exists in one copy cannot drift — route 4 was added to the fragment alone and appeared here
 *     for free. Consequence: a role bound at a COMPONENT also grants that permission over that
 *     component's placements — which is the model (a placement is that component at one place, and
 *     declaring one already requires `relationship:write` over the component) — and a role bound at
 *     a DEPLOYMENT-TARGET grants it over everything placed there, which is what makes "operator of
 *     prod" expressible. Authority tracks the governance chain rather than lagging it. Measured
 *     before landing: 0 of the estate's role bindings are scoped to a deployment-target, so route 4
 *     widens nothing that exists today.
 *
 * The `contains` edge is registered service -> component, so it is walked BACKWARDS here
 * (`r.to_id` = the object being checked, `r.from_id` = its service). That asymmetry is the security
 * property: a binding at a SERVICE reaches its components, but a binding at a COMPONENT never reaches
 * the service (a service has no incoming `contains` edge), nor its sibling components. Route 3 keeps
 * it: a binding at a placement reaches nothing above it except by continuing up through the
 * component, and a placement has no children.
 *
 * All four routes live in ONE recursive term via LATERAL: PostgreSQL permits the CTE self-reference
 * exactly once, so several recursive branches would error ("recursive reference ... more than once").
 * `UNION` (not `UNION ALL`) dedupes — with several routes the chain is a DAG, not a line (a
 * component's domain is reachable directly AND via its service), and dedupe keeps that from
 * re-walking.
 */
function scopeExpandCte(
  orgId: string,
  scopeObjectId: string,
  // ADR-0037: the shared bound by default; the truncation PROBE passes one-past-the-bound so a
  // deny can be told apart from a walk that was cut. Callers other than the probe never override.
  maxDepth: number = CONTAINMENT_WALK_MAX_DEPTH
) {
  return sql`
    scope_expand AS (
      SELECT ${scopeObjectId}::uuid AS scope_id, 0 AS depth
      UNION
      SELECT p.parent_id, se.depth + 1
      FROM scope_expand se
      CROSS JOIN LATERAL (
        SELECT o.domain_id AS parent_id
        FROM objects o
        WHERE o.id = se.scope_id AND o.domain_id IS NOT NULL
        UNION ALL
        SELECT r.from_id
        FROM relationships r
        WHERE r.to_id = se.scope_id
          AND r.org_id = ${orgId}
          AND r.type_id = 'contains'
          AND r.deleted_at IS NULL
        UNION ALL
        ${placementParentsSql(orgId, sql`se.scope_id`)}
      ) p
      -- A DELETED ancestor grants nothing. Kept in step with graph/containment.ts's identical
      -- filter: a role bound at a service that was later deleted must stop reaching that service's
      -- live components. deleteObject's edge cascade cannot cover replica edges or rows already in
      -- the database, so this is the backstop for both.
      JOIN objects parent_o
        ON parent_o.id = p.parent_id
       AND parent_o.org_id = ${orgId}
       AND parent_o.deleted_at IS NULL
      -- The SAME bound graph/containment.ts's walk uses, imported rather than re-typed: these two
      -- walks are hand-synced on their routes (see the header), and a bound that drifted would let
      -- a scope be governed at a depth authority cannot reach. The member_of SUBJECT walks below
      -- are a different concept and keep their own literal. ADR-0037: the truncation PROBE passes
      -- one-past-the-bound through maxDepth; nothing else overrides it.
      -- (No backticks in this comment: it lives inside a JS template literal.)
      -- sql.raw, not a bound parameter: an untyped $n compared against a recursive CTE's derived
      -- depth column is where PostgreSQL cannot infer a type. maxDepth is a module constant either
      -- way, never caller input.
      WHERE p.parent_id IS NOT NULL AND se.depth < ${sql.raw(String(maxDepth))}
    )
  `;
}

/**
 * ADR-0037 — the deny-path truncation probe, and why it runs only on deny.
 *
 * An ALLOW found within the bound is always valid: the binding was reached, the grant is real.
 * A DENY is the direction that can lie — "no binding reached" is indistinguishable from "the
 * binding exists at an ancestor the walk never got to" (measured 2026-08-13: an org-root admin
 * 403'd inside a deep domain chain with a detail naming neither depth nor bound, and the operator
 * debugging that message debugs RBAC, not nesting). So `hasPermission`/`hasRoleAtScope` call this
 * only after computing a refusal: both walks are re-run ONE level past the bound, and if either
 * frontier is still expanding the refusal is converted into a loud depth error instead of a
 * silent false. The hot allow-path pays nothing.
 */
async function assertDenyNotTruncated(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string,
  scopeObjectId: string,
  denialOf: string
): Promise<void> {
  const result = await tx.execute<{ kind: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(orgId, subjectObjectId, WALK_TRUNCATION_PROBE_DEPTH)},
    ${scopeExpandCte(orgId, scopeObjectId, WALK_TRUNCATION_PROBE_DEPTH)}
    (SELECT 'subject' AS kind FROM subject_expand WHERE depth >= ${WALK_TRUNCATION_PROBE_DEPTH} LIMIT 1)
    UNION ALL
    (SELECT 'scope' AS kind FROM scope_expand WHERE depth >= ${WALK_TRUNCATION_PROBE_DEPTH} LIMIT 1)
  `);
  const truncated = result.rows.map((r) => r.kind);
  if (truncated.length > 0) {
    throw walkDepthExceeded(
      truncated.includes("scope")
        ? `the containment chain above scope '${scopeObjectId}'`
        : `the member_of chain above subject '${subjectObjectId}'`,
      `${denialOf} was refused, but the refusal cannot be trusted: a grant may exist beyond the ` +
        `bound. Flatten the nesting, or bind the role nearer the scope.`
    );
  }
}

export async function hasPermission(tx: TenantTx, check: PermissionCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
    SELECT DISTINCT rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
      AND ${check.permission} = ANY(rl.permissions)
  `);

  const effects = result.rows.map((r) => r.effect);
  if (effects.includes("deny")) return false;
  if (effects.includes("allow")) return true;
  // ADR-0037: no binding reached at all — the one outcome a truncated walk can fabricate.
  // (An explicit deny above is a REAL binding that was reached; only the nothing-found case is
  // converted. Every caller inherits this, which is the point: false-by-depth must not exist.)
  await assertDenyNotTruncated(
    tx,
    check.orgId,
    check.subjectObjectId,
    check.scopeObjectId,
    `'${check.permission}'`
  );
  return false;
}

/** Throws 403 Forbidden (RFC 9457) when `hasPermission` would return false. */
export async function authorize(tx: TenantTx, check: PermissionCheck): Promise<void> {
  const allowed = await hasPermission(tx, check);
  if (!allowed) {
    throw forbidden(
      `subject '${check.subjectObjectId}' lacks '${check.permission}' at scope '${check.scopeObjectId}'`
    );
  }
}

export interface RoleCheck {
  orgId: string;
  subjectObjectId: string;
  /** Built-in or org-defined role NAME (e.g. 'Approver') — DESIGN §10.2's "N-of-M quorum from a
   *  role/group". Matched by name, not id, so both a built-in role and an org's own custom role
   *  sharing that name qualify (mirrors how `createTestUser`/route handlers already resolve
   *  roles by name elsewhere). */
  roleName: string;
  scopeObjectId: string;
}

/**
 * Approval-quorum eligibility (DESIGN §10.2, BUILD_AND_TEST.md §8 M4 "N-of-M can't be forged").
 * Structurally identical to `hasPermission`'s recursive CTE (same subject/scope expansion,
 * same deny-override) but matches on the BINDING'S ROLE NAME instead of a permission string —
 * "does this subject hold role R at-or-above this scope", independent of whatever permissions R
 * happens to grant. A SEPARATE query (not a `hasPermission` wrapper) because "holds role Approver"
 * and "has permission approval:write" are different questions: an org could grant 'approval:write'
 * to a broader custom role without that role being an eligible *quorum member* for a policy that
 * specifically names 'Approver'.
 */
export async function hasRoleAtScope(tx: TenantTx, check: RoleCheck): Promise<boolean> {
  const result = await tx.execute<{ effect: string }>(sql`
    WITH RECURSIVE ${subjectExpandCte(check.orgId, check.subjectObjectId)},
    ${scopeExpandCte(check.orgId, check.scopeObjectId)}
    SELECT DISTINCT rb.effect
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
      AND rb.scope_object_id IN (SELECT scope_id FROM scope_expand)
      AND rl.name = ${check.roleName}
  `);

  const effects = result.rows.map((r) => r.effect);
  if (effects.includes("deny")) return false;
  if (effects.includes("allow")) return true;
  // ADR-0037, same conversion as hasPermission: a quorum member silently vanishing because the
  // walk was cut is a quorum that fails mysteriously; erroring here fails the gate closed AND
  // says why.
  await assertDenyNotTruncated(
    tx,
    check.orgId,
    check.subjectObjectId,
    check.scopeObjectId,
    `role '${check.roleName}' at scope`
  );
  return false;
}

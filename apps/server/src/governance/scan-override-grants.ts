import { and, eq, isNull, sql } from "drizzle-orm";
import {
  SCAN_OVERRIDE_GRANT_TYPE_ID,
  ScanOverrideGrantStatusSchema,
  type RefusedScanOverrideGrant,
  type ScanApprovedOverrides,
  type ScanOverrideGrant,
  type ScanOverrideGrantCandidate,
  type ScanOverrideGrantFact,
  type ScanOverrideGrantStatus,
  type ScanRequirementTier
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";

/**
 * M22.6 (ADR-0033 §6a; owner decisions D3, D4, D9) — THE OVERRIDE REQUEST, as a governance-managed
 * graph object.
 *
 * ===========================================================================================
 * WHY A GRAPH OBJECT AND NOT A TABLE (charter principle 2)
 * ===========================================================================================
 * A grant is a governed thing with an owner, an authority, a lifecycle and — under D9 — a
 * requirement to FEDERATE. `objects` already provides all four, including the journal entry kind
 * that makes the fourth possible: `JournalEntryKindSchema` admits exactly nine entry kinds and none
 * of them is a bespoke row, so a grant stored outside `objects` could never cross a federation
 * boundary at all. ADR-0026 D9 made this same call for `placement` and 0051's header records the
 * same deciding fact.
 *
 * ===========================================================================================
 * WHY `approval_requests` COULD NOT BE REUSED — measured, not assumed
 * ===========================================================================================
 * Three structural refusals, any one of which is fatal:
 *   1. `change_object_id NOT NULL` — it is CHANGE-KEYED. D4's grant is standing, per
 *      (component x finding), and outlives every change.
 *   2. TWO-STATE (`pending | satisfied`) — no deny, no revoke, no expire.
 *   3. ENGINE-MATERIALIZED with no create API — a human cannot raise one.
 * The shape to copy is `freeze.override` (DESIGN §10.3): a mandatory non-empty reason and a
 * HIGH-SEVERITY hash-chained audit event per act. The approvals path is explicitly NOT the shape to
 * copy — a vote writes no audit event today, and that gap must not be inherited by a surface whose
 * entire purpose is to tolerate a known vulnerability.
 *
 * ===========================================================================================
 * APPROVER STANDING (D3): THE TIER THAT SET THE RULE — and it needs NO new authority model
 * ===========================================================================================
 * A platform-set floor is waivable only at platform; an assembly-set ceiling at assembly. Escalation
 * is then self-evident: you cannot waive a constraint stricter than your own authority.
 *
 * VERIFIED END TO END against this tree rather than taken from the ADR:
 *   - `authz/resolve.ts`'s `scopeExpandCte` starts at the named `scopeObjectId` and walks UPWARD
 *     (`objects.domain_id`, `contains`, and the two placement routes). So a `policy:write` binding at
 *     the named tier object — or at anything ABOVE it — satisfies the check, and a binding BELOW it
 *     (at a component, say) never reaches its assembly or its siblings. Authority expands strictly
 *     upward, which is exactly D3's "you cannot waive what you could not have authored".
 *   - `policy-scope-authz.ts` requires `policy:write` AT-OR-ABOVE the object for a BOUNDED
 *     `objectRef`; the org-root bar applies only to unscoped, selector and group scopes. Naming the
 *     tier's object concretely IS the bounded case.
 * So the approve check below is one ordinary `authorize({permission: "policy:write", scopeObjectId:
 * tierObjectId})` call. That is the whole of why D3 was affordable — AND IT IS NOT SUFFICIENT ON ITS
 * OWN, which the first version of this module got wrong.
 *
 * THE HOLE THAT WAS HERE. `scopeExpandCte` expanding upward cuts BOTH ways: a binding below the named
 * object never satisfies the check, but naming a LOWER object strictly WIDENS the set of principals
 * that do. `tierObjectId` was supplied by the REQUESTER and compared to nothing, so the party seeking
 * a waiver chose the authority that would grant it — name your own service, approve at your own
 * service, and a platform-set `maxCritical: 0` is waived while the audit trail truthfully records
 * "under authority of '<service>'". The authorize call was never wrong; what was missing was any
 * DERIVATION of which object it should be pointed at.
 *
 * THE TIER IS NOW DERIVED, at three places, none of which trusts the claim:
 *   - RAISE and APPROVE call {@link assertOverrideTierStanding} — the named object must lie on the
 *     component's own containment chain, and the approve half additionally refuses while an INSTANCE
 *     floor is set (no graph object maps to `platform`/`trust_domain`, so such a grant could never
 *     apply and approving it would leave the approver with a false belief).
 *   - THE GATE calls {@link applyOverrideAuthorityBar}, which is the decisive one: it re-derives the
 *     grant's tier from the target's chain and compares it against the tier that actually set the
 *     ceiling. See that function's docblock for the full argument, including why the bar is EVERY
 *     contributing tier rather than only the binding one.
 *
 * A note on what CANNOT decide who may RAISE a request: `owners-of` walks `domain_id` only and never
 * joins `contains`, so it does not see a component's service or assembly. Raising is therefore gated
 * on plain `object:write` at the component — the permission a component owner already has — rather
 * than on an ownership query that would be silently wrong for every component whose owner is
 * attached at the service.
 *
 * ===========================================================================================
 * EXPIRY IS A READ-TIME SQL WINDOW, NEVER A STATUS A JOB FLIPS
 * ===========================================================================================
 * Following `freezes-repo.ts`'s `activeFreezesForScopes`, which compares `starts_at`/`ends_at`
 * against `at` on every read. There is NO sweeper anywhere in this tree and no `boss.schedule` usage
 * to build one on, so a design that needed one would ship a grant that never expires. The
 * `ScanOverrideGrantStatus` enum therefore has no `expired` member: adding one would be a promise
 * that something transitions rows into it, and any reader that then trusted the status alone would
 * honour an expired grant.
 *
 * The comparison is done IN SQL (`(properties->>'expiresAt')::timestamptz > now()`) rather than in
 * TypeScript, for the same reason the freeze window is: a filter the database applies cannot be
 * skipped by a second caller who forgot it. The in-memory `expiresAt` that travels on the resolved
 * fact is for the AUDIT TRAIL ("until when"), never a second enforcement point.
 */

export interface ScanOverrideGrantRow {
  id: string;
  urn: string;
  name: string;
  properties: Record<string, unknown>;
  createdAt: Date;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The API projection of one grant object. Every field is read out of `properties` defensively: the
 *  registered schema is typed-but-open (drizzle/0075) and a row can arrive over federation from a
 *  peer with a newer vocabulary, so a missing key must render as `null` rather than throw. */
export function projectScanOverrideGrant(row: ScanOverrideGrantRow): ScanOverrideGrant {
  const p = row.properties;
  const status = ScanOverrideGrantStatusSchema.safeParse(p.status);
  return {
    id: row.id,
    urn: row.urn,
    name: row.name,
    // An UNRECOGNISED status renders as `requested` — the state that grants nothing. Never
    // `approved`: a status this deployment cannot parse must not be read as authorization.
    status: status.success ? status.data : "requested",
    componentId: str(p.componentId) ?? "",
    vulnerabilityId: str(p.vulnerabilityId) ?? "",
    pkgName: str(p.pkgName) ?? null,
    tierObjectId: str(p.tierObjectId) ?? "",
    reason: str(p.reason) ?? "",
    expiresAt: str(p.expiresAt) ?? null,
    decidedByActorId: str(p.decidedByActorId) ?? null,
    decidedAt: str(p.decidedAt) ?? null,
    decisionReason: str(p.decisionReason) ?? null,
    requestedByActorId: str(p.requestedByActorId) ?? "",
    createdAt: row.createdAt.toISOString()
  };
}

/** Fetch one grant by id. Returns `undefined` rather than throwing so the route can decide between a
 *  404 and a 403 without a try/catch around a repo. */
export async function findScanOverrideGrant(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<ScanOverrideGrantRow | undefined> {
  const rows = await tx
    .select({
      id: objects.id,
      urn: objects.urn,
      name: objects.name,
      properties: objects.properties,
      createdAt: objects.createdAt
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, id),
        eq(objects.typeId, SCAN_OVERRIDE_GRANT_TYPE_ID),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { ...row, properties: row.properties as Record<string, unknown> };
}

/** Every grant for one component, newest first — the operator's read surface, INCLUDING expired and
 *  denied ones. Deliberately unfiltered: an operator asking "what has been granted here" must see
 *  the ones that no longer apply, which is the opposite of what the RESOLVER below needs. */
export async function listScanOverrideGrantsForComponent(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<ScanOverrideGrantRow[]> {
  const rows = await tx
    .select({
      id: objects.id,
      urn: objects.urn,
      name: objects.name,
      properties: objects.properties,
      createdAt: objects.createdAt
    })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, SCAN_OVERRIDE_GRANT_TYPE_ID),
        isNull(objects.deletedAt),
        sql`${objects.properties}->>'componentId' = ${componentObjectId}`
      )
    )
    .orderBy(objects.createdAt);
  return rows.map((r) => ({ ...r, properties: r.properties as Record<string, unknown> }));
}

/**
 * THE RESOLVER — grants that are LIVE for this target right now.
 *
 * Three conditions, all applied by the database in one statement:
 *   1. `status = 'approved'` — a `requested`, `denied` or `revoked` grant authorizes nothing.
 *   2. `expiresAt` PRESENT and STILL IN THE FUTURE. An approved grant with no `expiresAt` is
 *      REFUSED rather than treated as unlimited: D4's grant is standing *with an expiry*, and a row
 *      that lost its expiry (a hand-written property, a federated row from a peer that omitted it) is
 *      exactly the shape that must not become a permanent blanket waiver.
 *   3. it names THIS component.
 *
 * `at` is injected rather than read from `now()` so a test can pin the boundary; production callers
 * pass the gate's own instant. The comparison is a timestamptz cast in SQL — a text comparison on an
 * ISO string would be *almost* right and would silently mis-order the moment a peer wrote an offset
 * other than `Z`.
 *
 * THE CAST IS GUARDED, AND THAT IS NOT DECORATION — it is the second instance of a class this repo
 * has already paid for once. `graph/containment.ts` wraps its `::uuid` in a `CASE ... ~ pattern` for
 * exactly this reason, and the sweep for that property did not reach this cast when it was written.
 *
 * `expiresAt` is a FREE-FORM STRING on this path. The registered `property_schema` types it only as
 * `{"type": "string"}`, and the M22.6 authoring guard — which refuses the field outright at every
 * local door — deliberately EXEMPTS `federationImport`, because a throw there aborts a peer's whole
 * signed bundle. D9 federates grants fully, so an approved grant for this component legitimately
 * arrives over the journal, and `import-repo.ts` writes its properties verbatim after an Ajv check
 * that a bare `type: string` passes. One peer row carrying `expiresAt: "never"` would make a BARE
 * cast throw inside every gate evaluation for that org — prewarm, wave boundary, `POST
 * /policy-evaluate` and the commander promotion scan all die, so no change in the org can be
 * validated or advanced until an operator finds the row. Fail-open by way of a crash, from across a
 * trust boundary.
 *
 * With the `CASE`, a malformed value yields NULL, `NULL > $at` is NULL, and the row is simply not
 * returned — the grant is NOT live. That is the fail-CLOSED direction and it agrees with condition 2
 * above: a grant that lost a usable expiry authorizes nothing.
 *
 * `CASE` rather than a sibling `WHERE` conjunct, for the reason containment.ts records: only `CASE`
 * guarantees the ordering. Postgres may evaluate two same-cost-class jsonb quals in either order, so
 * a guard sitting beside the cast is not a guard.
 */

/**
 * ISO-8601 instants, as TEXT, before Postgres is asked to read one.
 *
 * DELIBERATELY WIDER THAN `toISOString()`. Narrowing this to the `Z` shape Node emits would reject
 * legitimate federated grants from a peer that wrote a numeric offset — and the docblock above
 * anticipates exactly that peer. A fail-closed wrong answer is still a wrong answer: it would drop a
 * valid waiver silently. So offsets are accepted, and Postgres remains the thing that decides what
 * the instant MEANS; this pattern only decides whether it is safe to ask.
 */
const ISO_TIMESTAMP_TEXT_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$";

export async function resolveApprovedOverridesForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  at: Date
): Promise<ScanOverrideGrantCandidate[]> {
  const rows = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, SCAN_OVERRIDE_GRANT_TYPE_ID),
        isNull(objects.deletedAt),
        sql`${objects.properties}->>'componentId' = ${targetObjectId}`,
        sql`${objects.properties}->>'status' = 'approved'`,
        // THE READ-TIME WINDOW. `freezes-repo.ts`'s pattern, and the reason ADR-0033 §6a forbids a
        // status column a job flips: nothing in this tree would ever flip it.
        //
        // Guarded exactly as `graph/containment.ts` guards its `::uuid` — see the docblock above for
        // why an unguarded cast here is a tenant-wide denial of service reachable from a peer.
        sql`CASE
              WHEN ${objects.properties}->>'expiresAt' ~ ${ISO_TIMESTAMP_TEXT_PATTERN}
              THEN (${objects.properties}->>'expiresAt')::timestamptz
            END > ${at.toISOString()}::timestamptz`
      )
    );
  const grants: ScanOverrideGrantCandidate[] = [];
  for (const row of rows) {
    const p = row.properties as Record<string, unknown>;
    const vulnerabilityId = str(p.vulnerabilityId);
    const tierObjectId = str(p.tierObjectId);
    const expiresAt = str(p.expiresAt);
    // A grant missing any CONSTITUTIVE field excuses nothing. The registry schema requires three of
    // these, but a federated row from a peer running an older migration would not have been
    // validated against THIS deployment's registry, so the check is here too.
    if (!vulnerabilityId || !tierObjectId || !expiresAt) continue;
    // THE SAME REFUSAL, IN JS, and not redundant with the SQL `CASE` above. The window decides which
    // ROWS come back; this decides what a `ScanOverrideGrantCandidate` is allowed to CARRY. A future
    // caller reading `.expiresAt` off a candidate — to render it, to compare it, to put it in a
    // Decision — must not receive a string that is not an instant, and it should not have to know
    // that a SQL predicate two dozen lines up was the only thing keeping it honest.
    if (Number.isNaN(Date.parse(expiresAt))) continue;
    grants.push({
      grantObjectId: row.id,
      vulnerabilityId,
      ...(str(p.pkgName) ? { pkgName: str(p.pkgName)! } : {}),
      tierObjectId,
      expiresAt
    });
  }
  // Sorted by content so two identical evaluations serialize identically into the gate Decision's
  // `inputContext` — the M22.0 write-suppression rule. `grantObjectId` is a stored uuid, not a value
  // that varies between evaluations, so it is safe to sort on and safe to record.
  grants.sort((a, b) => (a.grantObjectId < b.grantObjectId ? -1 : 1));
  return grants;
}

/**
 * D3, ENFORCED — the authority bar, applied to one target's live grants.
 *
 * ===========================================================================================
 * WHAT WAS WRONG, IN ONE SENTENCE
 * ===========================================================================================
 * `tierObjectId` was chosen freely by the REQUESTER, resolved with `getObjectByIdOrUrnAnyType` on
 * trust, and read afterwards only for PRESENCE. Because `scopeExpandCte` expands UPWARD, naming a
 * LOWER object strictly WIDENS the approver set — so the party seeking a waiver selected the
 * authority that would grant it, and a service lead could approve away a platform-set floor while
 * the audit trail truthfully recorded "under authority of '<service>'".
 *
 * ===========================================================================================
 * THE FIX: THE TIER IS DERIVED, THE CLAIM IS ONLY VALIDATED
 * ===========================================================================================
 * Two derivations, neither of which reads anything the requester wrote:
 *
 *   - THE GRANT'S OWN TIER comes from placing `tierObjectId` on THIS TARGET'S containment chain and
 *     reading `tierForObjectType` off the placement. A named object that is not on the chain is not
 *     an ancestor of the component, holds no authority over it through any route the RBAC walk uses,
 *     and is refused outright — never silently mapped to `component`.
 *   - THE BAR (`requiredTier`) comes from `EffectiveScanThreshold.contributors`, the provenance M22.0
 *     recorded so a block could name the tier that bound it.
 *
 * A grant applies only when its derived tier is AT OR ABOVE the bar. `TIER_ORDER` is top-down, so
 * "at or above" is `rank <= rank`.
 *
 * ===========================================================================================
 * WHY THE BAR IS *EVERY* CONTRIBUTOR AND NOT ONLY THE BINDING ONE
 * ===========================================================================================
 * Tempting and wrong: "only the tier whose value is the per-severity MIN is being waived". Excluding
 * a finding removes it from the COUNT, which loosens every ceiling on that severity at once — a
 * count of 6 dropping to 5 satisfies a platform ceiling of 5 just as surely as it satisfies the
 * service ceiling of 0 that produced the block. So the bar is the most senior tier that set ANY
 * ceiling; anything narrower lets a junior tier defeat a senior one indirectly.
 *
 * ===========================================================================================
 * TWO CONSEQUENCES, STATED RATHER THAN DISCOVERED
 * ===========================================================================================
 *   - AN INSTANCE FLOOR MAKES GRANTS INERT. `readInstanceScanFloors` contributes at `platform` /
 *     `trust_domain`, and `tierForObjectType` maps no graph object to either — those rungs are
 *     authored with the deployment operator token, which no tenant role can grant. So while an
 *     instance floor is set, no grant can clear the bar. That is D3 read literally ("a platform-set
 *     floor is waivable only at platform") and it is why the approve route refuses up front rather
 *     than letting an operator believe they granted something.
 *   - WITH NO TIER-SET CEILING THE BAR IS `org`, AND IT IS NEVER `component`. This bullet used to
 *     claim the opposite — "no constraint stricter than the requester's own authority to escalate
 *     past" — which was false, and measurably so: the gate still enforces a ceiling from the control
 *     binding's `config.threshold` (authored at CONTROL scope, off the component's chain) or, when
 *     nothing else decides a severity, from the scan plugin's shipped fail-closed 0/0. Exclusions
 *     are subtracted from the counts BEFORE they are compared, so a bar of `component` let a
 *     service-scoped `policy:write` holder waive a ceiling they had no standing to author. The floor
 *     is `org` — the most senior rung a tenant can author at — and it only ever tightens the bottom:
 *     `platform`/`trust_domain` contributions still raise the bar past it. See
 *     `requiredOverrideApprovalTier` in `scan-requirements.ts` for the full argument, the rejected
 *     alternative, and what the floor deliberately does NOT close.
 */
export function applyOverrideAuthorityBar(input: {
  candidates: readonly ScanOverrideGrantCandidate[];
  /** Tier of every object on this target's containment chain, by object id. */
  chainTierByObjectId: Readonly<Record<string, ScanRequirementTier>>;
  requiredTier: ScanRequirementTier;
  /** `TIER_ORDER.indexOf` — injected so this module never grows a second copy of the tier order. */
  rankOf: (tier: ScanRequirementTier) => number;
}): { granted: ScanOverrideGrantFact[]; refused: RefusedScanOverrideGrant[] } {
  const granted: ScanOverrideGrantFact[] = [];
  const refused: RefusedScanOverrideGrant[] = [];
  const bar = input.rankOf(input.requiredTier);
  for (const candidate of input.candidates) {
    const tier = input.chainTierByObjectId[candidate.tierObjectId];
    if (tier === undefined) {
      refused.push({
        grantObjectId: candidate.grantObjectId,
        reason: "tier_not_on_containment_chain"
      });
      continue;
    }
    if (input.rankOf(tier) > bar) {
      refused.push({
        grantObjectId: candidate.grantObjectId,
        tier,
        reason: "tier_below_required"
      });
      continue;
    }
    granted.push({ ...candidate, tier });
  }
  granted.sort((a, b) => (a.grantObjectId < b.grantObjectId ? -1 : 1));
  refused.sort((a, b) => (a.grantObjectId < b.grantObjectId ? -1 : 1));
  return { granted, refused };
}

/**
 * PURE — compose several targets' live grants into the ONE set that describes the change.
 *
 * AN INTERSECTION, never a union, for exactly the reason ADR-0033 §3 forbids unioning clauses: one
 * verdict is produced for one artifact across the change's whole target set, and a grant approved for
 * component A that leaked onto sibling B would tolerate a vulnerability on a component nobody
 * approved anything for.
 *
 * The intersection is on the (vulnerabilityId, pkgName) PAIR — what the grant actually excuses — and
 * NOT on `grantObjectId`, which is per-component by construction and would make every multi-target
 * intersection empty. The surviving `grantObjectId` is the first in the deterministic order, so the
 * evidence names a real, resolvable grant rather than a synthesized one.
 */
export function intersectApprovedOverrides(
  perTarget: readonly ScanApprovedOverrides[]
): ScanApprovedOverrides | undefined {
  if (perTarget.length === 0) return undefined;
  const keyOf = (g: ScanOverrideGrantFact): string =>
    JSON.stringify([g.vulnerabilityId, g.pkgName ?? null]);
  let surviving: Map<string, ScanOverrideGrantFact> | undefined;
  for (const facts of perTarget) {
    const here = new Map<string, ScanOverrideGrantFact>();
    for (const g of facts.grants) if (!here.has(keyOf(g))) here.set(keyOf(g), g);
    if (surviving === undefined) {
      surviving = here;
      continue;
    }
    for (const key of [...surviving.keys()]) if (!here.has(key)) surviving.delete(key);
  }
  const grants = [...(surviving ?? new Map<string, ScanOverrideGrantFact>()).values()].sort(
    (a, b) => (a.grantObjectId < b.grantObjectId ? -1 : 1)
  );
  return { grants };
}

/** The `properties` bag a newly-raised request is created with. Exported so the route and the tests
 *  agree on the shape without a second literal. */
export function newScanOverrideGrantProperties(input: {
  componentId: string;
  vulnerabilityId: string;
  pkgName?: string | undefined;
  tierObjectId: string;
  reason: string;
  requestedByActorId: string;
}): Record<string, unknown> {
  const status: ScanOverrideGrantStatus = "requested";
  return {
    componentId: input.componentId,
    vulnerabilityId: input.vulnerabilityId,
    ...(input.pkgName ? { pkgName: input.pkgName } : {}),
    tierObjectId: input.tierObjectId,
    status,
    reason: input.reason,
    requestedByActorId: input.requestedByActorId
  };
}

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

/** The override request, as a governed object. See docs/governance.md §348. */

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

/** The resolver: grants live for this target right now. See docs/governance.md §349. */

/** Instants as text, before Postgres is asked to read one. See docs/governance.md §350. */
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
        // THE READ-TIME WINDOW. See docs/governance.md §351.
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
    // The same refusal in code, not redundant with the query. See docs/governance.md §352.
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

/** The authority bar, applied to one target's live grants. See docs/governance.md §353. */
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

/** Pure: composes several targets' live grants into one. See docs/governance.md §354. */
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

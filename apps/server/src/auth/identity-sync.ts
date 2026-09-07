import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { unauthorized } from "../errors.js";

/** IdP GROUP SYNC. See docs/auth.md §10. */

/** The property, on a `group` or `team` object, that maps it to an IdP claim value. */
export const EXTERNAL_IDENTITY_PROPERTY = "externalIdentity";

export interface ExternalIdentityMapping {
  /** Free-form, matched case-sensitively against the values in the configured claim. */
  claimValue: string;
}

/** Reads the mapping off an object's properties, or `null` when it carries none. */
export function externalIdentityOf(properties: unknown): ExternalIdentityMapping | null {
  if (!properties || typeof properties !== "object") return null;
  const raw = (properties as Record<string, unknown>)[EXTERNAL_IDENTITY_PROPERTY];
  if (!raw || typeof raw !== "object") return null;
  const claimValue = (raw as { claimValue?: unknown }).claimValue;
  if (typeof claimValue !== "string" || claimValue.length === 0) return null;
  return { claimValue };
}

/** Pulls the claim values out of a validated ID token. See docs/auth.md §11. */
export function claimValuesFrom(claims: Record<string, unknown>, claimName: string): string[] {
  const overage = claims._claim_names;
  if (overage && typeof overage === "object" && claimName in (overage as object)) {
    throw unauthorized(
      `the identity provider did not send the '${claimName}' claim directly: the token carries a ` +
        `_claim_names/_claim_sources overage pointer, which means this user belongs to more ` +
        `groups than the provider will inline (Entra's limit is ~200). Resolving it requires an ` +
        `outbound call to the provider's directory API, which this deployment does not make. Use ` +
        `APP ROLES rather than the groups claim (SCP_OIDC_ROLE_CLAIM defaults to 'roles'), or ` +
        `configure the provider to emit only groups assigned to this application. Signing in ` +
        `without the claim would silently strip this user's group-derived authority.`
    );
  }

  const raw = claims[claimName];
  if (raw === undefined || raw === null) return [];
  // A single-valued claim is legal and common (one app role assigned).
  if (typeof raw === "string") return raw.length > 0 ? [raw] : [];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export interface SyncOutcome {
  joined: string[];
  left: string[];
  /** Claim values that matched no mapped group — reported, never an error. */
  unmatchedClaimValues: string[];
}

/** Reconciles mapped group membership through the edge doors. See docs/auth.md §12. */
export async function syncExternalGroupMembership(
  tx: TenantTx,
  input: {
    orgId: string;
    subjectObjectId: string;
    claimValues: readonly string[];
    requestId: string;
  }
): Promise<SyncOutcome> {
  // Every MAPPED group in the org. Deliberately read in full rather than filtered by the claim
  // values: the delete arm needs the groups the principal is in but should NOT be, which a
  // claim-filtered query cannot see.
  const mapped = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, input.orgId),
        inArray(objects.typeId, ["group", "team"]),
        sql`${objects.deletedAt} IS NULL`,
        sql`${objects.properties} -> ${EXTERNAL_IDENTITY_PROPERTY} ->> 'claimValue' IS NOT NULL`
      )
    );

  const wanted = new Set(input.claimValues);
  const desired = new Set<string>();
  const matchedValues = new Set<string>();
  const mappedIds: string[] = [];

  for (const row of mapped) {
    mappedIds.push(row.id);
    const mapping = externalIdentityOf(row.properties);
    if (!mapping) continue;
    if (wanted.has(mapping.claimValue)) {
      desired.add(row.id);
      matchedValues.add(mapping.claimValue);
    }
  }

  if (mappedIds.length === 0) {
    return { joined: [], left: [], unmatchedClaimValues: [...wanted].sort() };
  }

  // Current membership, restricted to MAPPED groups. An unmapped group's membership is none of this
  // function's business and is never read, let alone deleted.
  const current = await tx
    .select({ id: relationships.id, toId: relationships.toId })
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, input.orgId),
        eq(relationships.typeId, "member_of"),
        eq(relationships.fromId, input.subjectObjectId),
        inArray(relationships.toId, mappedIds),
        sql`${relationships.deletedAt} IS NULL`
      )
    );

  const held = new Map(current.map((r) => [r.toId, r.id]));
  const joined: string[] = [];
  const left: string[] = [];

  for (const groupId of desired) {
    if (held.has(groupId)) continue;
    await createRelationship(tx, {
      orgId: input.orgId,
      // The principal being synced is both the edge's subject and the closest thing to an actor
      // there is. Recorded rather than left null so the audit trail names a graph object, and
      // deliberately NOT an org-root system id, which would read as "an administrator did this".
      actorObjectId: input.subjectObjectId,
      requestId: input.requestId,
      typeId: "member_of",
      fromId: input.subjectObjectId,
      toId: groupId,
      identitySync: true
    });
    joined.push(groupId);
  }

  for (const [groupId, relId] of held) {
    if (desired.has(groupId)) continue;
    // Removal needs NO exemption: `assertMayJoinRoleBearingSubject` guards the JOIN only, because
    // leaving a group is a narrowing. This is the ordinary delete path, unmodified.
    await deleteRelationship(tx, {
      orgId: input.orgId,
      actorObjectId: input.subjectObjectId,
      requestId: input.requestId,
      id: relId
    });
    left.push(groupId);
  }

  return {
    joined: joined.sort(),
    left: left.sort(),
    unmatchedClaimValues: [...wanted].filter((v) => !matchedValues.has(v)).sort()
  };
}

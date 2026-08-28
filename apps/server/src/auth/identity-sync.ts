import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { createRelationship, deleteRelationship } from "../graph/relationships-repo.js";
import { unauthorized } from "../errors.js";

/**
 * ================================================================================================
 * IdP GROUP SYNC — claim values to SCP group membership
 * ================================================================================================
 *
 * THE PROBLEM. Generic OIDC authenticates an Entra/Okta/Keycloak user and JIT-provisions them as a
 * Viewer at the org root. That is the whole of it: 500 people in the directory can sign in on day
 * one and all 500 are Viewers until an admin makes 500 decisions. Nothing has ever read a claim
 * beyond `sub`/`email`/`preferred_username`/`name`.
 *
 * THE SHAPE. An SCP `group` or `team` object carries {@link EXTERNAL_IDENTITY_PROPERTY}, naming the
 * claim value it mirrors. At login, the values in the configured claim are matched against those
 * objects and `member_of` edges are reconciled. Roles are bound to the GROUP, once, by a human,
 * through the existing door — so the estate keeps one decision per group instead of one per person,
 * and every existing read surface (`GET /role-bindings`, `GET /authz/effective`) explains the
 * result without knowing the IdP exists.
 *
 * ------------------------------------------------------------------------------------------------
 * THE IdP IS AUTHORITATIVE FOR A MAPPED GROUP — including deletions
 * ------------------------------------------------------------------------------------------------
 * Reconciliation REMOVES memberships as well as adding them, and it does not distinguish an edge it
 * created from one a human added by hand. For a group carrying a mapping, the directory is the
 * source of truth, full stop: adding somebody to it through `POST /relationships` is undone at that
 * person's next login.
 *
 * That is a deliberate choice over the alternative — marking edges as sync-owned and leaving
 * hand-made ones alone — because the alternative produces a group whose membership no single system
 * can state. Half the members come from Entra and half from somebody's afternoon, the two are
 * indistinguishable in the UI, and removing a person from the directory silently leaves their
 * authority in place. A mapped group means "this group is the directory's"; an estate that wants a
 * hand-managed group should not map one.
 *
 * UNMAPPED GROUPS ARE NEVER TOUCHED. The reconciliation's delete arm is scoped to groups that carry
 * a mapping, so ordinary teams are entirely outside this system.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS IS EXEMPT FROM THE `member_of` SUBSET RULE, AND WHERE THE BAR WENT INSTEAD
 * ------------------------------------------------------------------------------------------------
 * `graph/relationships-repo.ts` applies the no-escalation subset rule to every `member_of` create:
 * writing that edge confers whatever the group's bindings carry, so the actor must already hold it.
 * A login sync has NO human actor and could never satisfy it — the "actor" is the identity
 * provider.
 *
 * Owner decision: the sync is carved out, and the bar moves to AUTHORING THE MAPPING
 * (`authz/identity-mapping-door.ts`). The reasoning is that the escalation §2a closes is a
 * low-privileged principal choosing to join a high-privileged group — and here nobody chooses their
 * own claims. Entra does. So the question worth gating is not "may this person join" but "who
 * decided that this claim value means this group", and that is a human act with a human actor,
 * which can carry the full subset rule.
 *
 * WHAT THAT LEAVES OPEN, STATED RATHER THAN IMPLIED: whoever administers the identity provider can
 * grant any authority any mapped group carries, without any SCP permission at all. That is not a
 * bug — it is what federating identity MEANS, and it is true of every SSO integration ever built —
 * but it moves part of the estate's trust boundary into the directory, and an operator should
 * decide that knowingly. `role-binding-door.ts`'s grant preview reports whether a subject is
 * externally synced for exactly this reason.
 */

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

/**
 * Pulls the claim values out of a validated ID token.
 *
 * ⚠️ THE OVERAGE CASE FAILS THE LOGIN LOUDLY, and that is the single most important line here.
 * Entra omits the `groups` claim entirely once a user is in roughly 200 groups, substituting
 * `_claim_names` / `_claim_sources` that point at MS Graph. Resolving those needs an outbound call
 * to graph.microsoft.com, which CLAUDE.md principle 5 forbids — so SCP cannot see the user's groups
 * at all in that case.
 *
 * The tempting behaviour is to treat "no claim" as "no groups" and carry on. That would sign the
 * user in with their entire group-derived authority silently removed — and worse, the
 * reconciliation below would then REVOKE the memberships they legitimately had, because an empty
 * desired set is indistinguishable from "the IdP says they are in nothing". A privileged user would
 * be quietly demoted at their next login, and the only symptom would be permissions that used to
 * work. That is a check passing because it never ran.
 *
 * So an overage token is refused with an explanation naming the fix. This costs a login; the
 * alternative costs an unexplained privilege loss that looks like an SCP bug.
 */
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
  /** Group/team object ids the principal was ADDED to. */
  joined: string[];
  /** Group/team object ids the principal was REMOVED from. */
  left: string[];
  /** Claim values that matched no mapped group — reported, never an error. */
  unmatchedClaimValues: string[];
}

/**
 * Reconciles one principal's membership of MAPPED groups against the claim values in their token.
 *
 * GOES THROUGH `createRelationship`/`deleteRelationship` with an `identitySync` flag, rather than
 * writing rows directly. The first draft of this function did write them directly, and the compiler
 * caught why that is wrong: `relationships` carries `origin_domain_id` and `content_hash`, which
 * `createRelationship` computes for federation. Hand-rolling the insert would have meant a SECOND
 * definition of how a relationship's identity is derived — the exact duplicated-walk defect this
 * codebase keeps paying for — and it would have silently produced edges a federation journal could
 * not replay.
 *
 * So the exemption is one boolean on the existing input, sibling to `federationImport`, read at one
 * `if`. Every other guard that function applies — cardinality, cycles, governance labels — still
 * runs.
 */
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

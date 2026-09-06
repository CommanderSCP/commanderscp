import { and, eq, isNull } from "drizzle-orm";
import type { GraphObject } from "@scp/schemas";
import { freezes } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  createObject,
  findObjectByIdOrUrnAnyType,
  isUuid,
  updateObject
} from "../graph/objects-repo.js";
import { deriveUrn } from "../graph/urn.js";
import type { FreezeRow } from "./freezes-repo.js";

/**
 * ============================================================================================
 * M25.7 — THE WIRE FORM OF A FREEZE (owner decision D6, ADR-0043)
 * ============================================================================================
 *
 * Until this increment a freeze could not cross a security boundary at all, and that was a
 * DELIBERATE, TESTED ABSENCE rather than a gap: `db/schema.ts`'s "M4 Governance Engine" banner said
 * in so many words that the generic object model has no place for freezes (that banner now carries
 * the narrowed claim — the ENFORCEMENT state still has no place there, which is why the projection
 * table below stays; only the WIRE form became an object — and it is cited by section rather than
 * by line for that reason), `service-board.ts` told operators that a null
 * `activeFreeze` means "no freeze declared HERE", and
 * `coordination/service-board-precedence.integration.test.ts` pinned it. D6 overturns that. This
 * module is the overturn's home in code, the way `federation/domain-local.ts` is ADR-0031's and
 * `federation/outpost-binding.ts` is ADR-0022's.
 *
 * ## Why an object and not a journal kind
 *
 * `JournalEntryKindSchema` is a nine-literal `z.enum` that ALSO appears in the 200 response of
 * `POST /federation/exports`. Widening it is an oasdiff `response-property-one-of-added` break —
 * and, far worse, a FAIL-CLOSED CLIFF: `POST /federation/imports` validates the whole bundle
 * against `SyncBundleSchema` at the ROUTE boundary, so an older peer receiving an unknown kind
 * 400s the ENTIRE bundle, losing every unrelated entry in it and retrying forever from
 * `inbox-loop.ts`. `import-repo.ts`'s tolerant `default: return;` is never reached. A registered
 * object type rides the EXISTING `object_upsert` every peer already understands: zero new kind,
 * zero enum widening, zero oasdiff exposure, zero new importer branch.
 *
 * ## Object PLUS projection, not object INSTEAD OF projection
 *
 * The `freezes` row stays and is rebuilt at the importing instance. Everything that ENFORCES a
 * freeze reads that table — `activeFreezesInWindow` (the single owner of the half-open window
 * predicate), `freezesByTarget`, `checkFreeze`, `evaluateFreezeHolds`, the service board — and
 * re-expressing the window predicate as jsonb comparisons on a hot gate path would buy nothing
 * except a second copy of the one comparison `freezes-repo.ts`'s header exists to keep singular.
 * So: the object is what TRAVELS, the row is what BLOCKS, and
 * {@link rebuildFreezeProjectionFromObject} is the join between them. Without that rebuild this
 * feature would ship a replicated row nothing reads.
 *
 * ## One authoring door
 *
 * `freeze` is in BOTH of `governance-managed-types.ts`'s sets, and it needs both — the first
 * version of this paragraph named only the first and was wrong about what that bought.
 *
 * `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` makes two of the five caller-supplied-`typeId` doors refuse
 * the type outright (`/objects/{type}`, `/discovery/accept`). Without it a holder of plain
 * `object:write` could `POST /api/v1/objects/freeze` and mint a graph object that becomes a
 * BLOCKING freeze at every downstream instance — an escalation across a security boundary authored
 * with the weakest write permission in the system.
 *
 * But at the other THREE doors (`POST /plans`+apply, `/federation/overlays`, `/federation/hand-fill`)
 * that membership is an instruction to demand `policy:write` INSTEAD of `object:write` — a
 * permission UPGRADE, not a refusal — and `policy:write` is neither of the two permissions a freeze
 * actually requires. Measured: an actor holding `policy:write` at a narrow domain, and
 * `freeze:write`/`federation:write` nowhere, could mint a federating freeze through any of the
 * three, with its declared `properties.scopeObjectId` bound to nothing (that path scope-binds
 * `policy` and `campaign` only) and with no `freezes` row here, leaving it unliftable at both ends.
 * `PROJECTION_BOUND_OBJECT_TYPE_IDS` is what closes those three, by refusal.
 *
 * `POST /api/v1/freezes` (gated on `federation:write` for the federating form) is therefore the
 * only way a `freeze` object is ever created locally, which is also what keeps the object and its
 * projection row in step: one door, one writer, no census to keep re-running.
 *
 * ## What does NOT live here
 *
 * A PLATFORM-TIER FREEZE, and it cannot. `SyncJournalEntrySchema.orgId` is required,
 * `appendJournalEntry` takes `input.orgId`, the hash chain is keyed `(orgId, originDomainId)`, and
 * `exportSyncBundle` runs inside `withTenantTx`. `instance_freezes` (drizzle/0086) has no `org_id`
 * and is declared by no commander. ADR-0040 and GLOSSARY's "platform-tier freeze" entry both say
 * so and both stay true after M25.7. Org tier and below only.
 */
export const FREEZE_OBJECT_TYPE_ID = "freeze";

/** Registered by drizzle/0089 as a BUILTIN type, on both sides, because `object_types` is a
 *  migration seed and never journals — which is exactly what lets this ride `object_upsert` with no
 *  type-registration entry kind.
 *
 *  A PEER THAT HAS NOT RUN 0089 DOES NOT HAVE THE TYPE, and that case is now survivable rather than
 *  fatal. `createObject` 404s on an unregistered type and the `object_upsert` branch has no
 *  try/catch, so the first federated freeze reaching an un-upgraded peer used to abort its ENTIRE
 *  signed bundle — and `inbox-loop.ts` would retry the same bundle forever, wedging the channel on
 *  a version skew that a rolling upgrade produces by construction. `import-repo.ts` now checks
 *  registration BEFORE the write and skips-and-records the entry instead (one entry lost, channel
 *  intact; a from-genesis re-sync replays it once the peer has the migration). This paragraph is
 *  the corrected version of a claim that used to read as though the seed made the hazard
 *  impossible — it makes it impossible only once BOTH ends have run the migration. */
export function isFreezeObjectType(typeId: string): boolean {
  return typeId === FREEZE_OBJECT_TYPE_ID;
}

/** Derived from the freeze's UUID, never from its human `name`: two freezes may legitimately share
 *  a label, and the urn is the key `upsertObjectByUrn` matches on at the receiving instance. */
export function freezeObjectUrn(orgId: string, freezeId: string): string {
  return deriveUrn(orgId, FREEZE_OBJECT_TYPE_ID, freezeId);
}

/** THE SNAPSHOT THAT TRAVELS. See docs/governance/freeze-object.md §1. */
export function freezeObjectProperties(
  freeze: FreezeRow,
  scopeObjectUrn: string | null
): Record<string, unknown> {
  return {
    freezeId: freeze.id,
    scopeObjectId: freeze.scopeObjectId,
    ...(scopeObjectUrn === null ? {} : { scopeObjectUrn }),
    name: freeze.name,
    startsAt: freeze.startsAt.toISOString(),
    endsAt: freeze.endsAt.toISOString(),
    reason: freeze.reason,
    atomic: freeze.atomic,
    createdByActorId: freeze.createdByActorId,
    liftedAt: freeze.liftedAt === null ? null : freeze.liftedAt.toISOString(),
    liftedByActorId: freeze.liftedByActorId,
    liftReason: freeze.liftReason
  };
}

export interface AttachFreezeObjectInput {
  orgId: string;
  freeze: FreezeRow;
  actorObjectId: string;
  requestId: string;
  /** ADR-0031: LOCALITY IS DECLARED, NEVER INFERRED. An OUTPOST-declared freeze passes `true` so
   *  the object exists as an ordinary first-class graph object locally while `scope-filter.ts`
   *  withholds it in BOTH directions, even under `full` scope. Gated on `federation:write` at the
   *  route by `assertMayDeclareDomainLocal`, like every other declaration of locality. */
  domainLocal?: boolean | undefined;
}

/**
 * Mints the `freeze` graph object for an already-inserted `freezes` row and links the two.
 *
 * ORDER IS ROW-THEN-OBJECT, and it has to be: the object's `properties.freezeId` IS the row's
 * primary key, and that identity is what makes the rebuild at the far end idempotent and what keeps
 * a `freeze_admission` Decision written at an outpost resolvable against `GET /v1/freezes/{id}` at
 * the commander. Both statements are in the caller's transaction, so a freeze can never exist with
 * a half-attached object.
 *
 * `createObject` journals the `object_upsert` itself (`graph/objects-repo.ts`) — there is no
 * federation-specific code on this path at all, which is the entire point of choosing an object.
 */
export async function attachFreezeObject(
  tx: TenantTx,
  input: AttachFreezeObjectInput
): Promise<FreezeRow> {
  const { orgId, freeze } = input;
  const scope = await findObjectByIdOrUrnAnyType(tx, orgId, freeze.scopeObjectId);
  const object = await createObject(tx, {
    orgId,
    typeId: FREEZE_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    urn: freezeObjectUrn(orgId, freeze.id),
    // The graph display name. `properties.name` carries the freeze's own nullable label verbatim, so
    // the rebuild restores `null` as `null` rather than as this fallback string.
    name: freeze.name ?? `freeze ${freeze.id}`,
    properties: freezeObjectProperties(freeze, scope?.urn ?? null),
    domainLocal: input.domainLocal
  });
  const [row] = await tx
    .update(freezes)
    .set({ objectId: object.id })
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, freeze.id)))
    .returning();
  if (!row) throw new Error(`freeze '${freeze.id}' vanished while attaching its graph object`);
  return row as FreezeRow;
}

/**
 * RE-SNAPSHOTS a federated freeze's object after a lift or a window edit, so the change rides the
 * next bundle. A NO-OP for a freeze with no object — which is every freeze on a pre-M25.7 estate
 * and every freeze authored without `federate`, so the two write verbs stay byte-identical there.
 *
 * Called from the two write ROUTES rather than from `freezes-repo.ts`, and the split is the one
 * `federation/domain-local.ts` names: the repo owns the invariant that cannot be forgotten (its
 * `lockFreezeRow` refuses the write outright on a replica, so no door can edit a foreign freeze),
 * this owns the per-request follow-through. Forgetting it does not corrupt anything — it leaves the
 * downstream copy stale until the next edit — but the lift case is the one that matters, so both
 * routes have a test.
 */
export async function syncFreezeObject(
  tx: TenantTx,
  input: { orgId: string; freeze: FreezeRow; actorObjectId: string; requestId: string }
): Promise<void> {
  const { orgId, freeze } = input;
  if (!freeze.objectId) return;
  const scope = await findObjectByIdOrUrnAnyType(tx, orgId, freeze.scopeObjectId);
  await updateObject(tx, {
    orgId,
    typeId: FREEZE_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: freeze.objectId,
    properties: freezeObjectProperties(freeze, scope?.urn ?? null)
  });
}

/** Reads a string property, or `null` when it is absent or not a string. No coercion: this parses
 *  untyped bundle-payload JSON, and a `Number` or an object silently stringified into a governance
 *  window is the shape a fail-open is built from. */
function str(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function instant(properties: Record<string, unknown>, key: string): Date | null {
  const raw = str(properties, key);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A string property that is genuinely a UUID, or `null`.
 *
 * LOAD-BEARING, NOT DEFENSIVE NOISE, and the same argument `import-repo.ts`'s
 * `recordableChangeObjectId` records for `federation_unattached_change_status.change_object_id`.
 * Four of the columns this module writes are `uuid` — `freezes.id`, `scope_object_id`,
 * `created_by_actor_id`, `lifted_by_actor_id` — while the properties they come from are untyped
 * bundle-payload JSON (`z.record(z.string(), z.unknown())` on the wire, and drizzle/0089's
 * registered schema constrains them only to non-empty strings). Handing Postgres `"not-a-uuid"`
 * for a `uuid` column raises `22P02 invalid input syntax`, which does NOT merely fail this
 * function: it POISONS the whole import transaction, so every subsequent statement fails, the
 * peer's entire signed bundle is rejected, and `inbox-loop.ts` retries it forever. One malformed
 * freeze would take the channel down.
 *
 * A non-UUID is therefore treated EXACTLY like an absent value — skip, never throw — which is the
 * ruling {@link rebuildFreezeProjectionFromObject}'s docblock states for every other malformed
 * field. `isUuid` is `graph/objects-repo.ts`'s, unchanged and not re-implemented.
 */
function uuidStr(properties: Record<string, unknown>, key: string): string | null {
  const value = str(properties, key);
  return value !== null && isUuid(value) ? value : null;
}

/** THE IMPORT SIDE. See docs/governance/freeze-object.md §2. */
export async function rebuildFreezeProjectionFromObject(
  tx: TenantTx,
  input: {
    orgId: string;
    object: GraphObject;
    /** `FEDERATION_IMPORT_ACTOR_ID`, passed in rather than imported so this module does not depend
     *  on `federation/import-repo.ts` (which depends on it). Used only when the payload carries no
     *  `createdByActorId`; `freezes.created_by_actor_id` is NOT NULL and has no FK. */
    fallbackActorId: string;
  }
): Promise<void> {
  const { orgId, object } = input;
  const properties = object.properties;

  // `freezeId` becomes `freezes.id`, a `uuid` PRIMARY KEY — hence `uuidStr`, not `str`.
  const freezeId = uuidStr(properties, "freezeId");
  const startsAt = instant(properties, "startsAt");
  const endsAt = instant(properties, "endsAt");
  const reason = str(properties, "reason");
  if (!freezeId || !startsAt || !endsAt || !reason) return;
  // The window invariant `assertWindowOrdered` enforces at both local write doors, re-checked on a
  // payload this instance did not author. A row with `ends_at <= starts_at` is one the local POST
  // route refuses to produce and one the half-open predicate reads as permanently inactive — a
  // freeze that is silently never in force is worse than an absent one, so it is not stored.
  if (endsAt <= startsAt) return;

  // URN FIRST, id second — and the ORDER is what makes the UUID guard tolerant rather than merely
  // strict. A locally-resolved scope contributes a real `objects.id`, so a payload whose raw
  // `scopeObjectId` is malformed still produces an enforceable row when its urn resolves here. Only
  // when NEITHER yields a UUID is the freeze unstorable — `freezes.scope_object_id` is a `uuid`
  // column and there is no honest value left to put in it — and it is skipped like any other
  // malformed entry.
  const scopeUrn = str(properties, "scopeObjectUrn");
  const resolvedScope =
    scopeUrn === null ? null : await findObjectByIdOrUrnAnyType(tx, orgId, scopeUrn);
  const scopeObjectId = resolvedScope?.id ?? uuidStr(properties, "scopeObjectId");
  if (!scopeObjectId) return;

  const values = {
    orgId,
    objectId: object.id,
    scopeObjectId,
    name: str(properties, "name"),
    startsAt,
    endsAt,
    reason,
    // NOT NULL, no FK, and a `uuid` column: a non-UUID from a peer falls back to the synthetic
    // import actor rather than poisoning the transaction. The field travels for explainability
    // only, so the fallback loses provenance for one row and nothing else.
    createdByActorId: uuidStr(properties, "createdByActorId") ?? input.fallbackActorId,
    atomic: properties.atomic === true,
    liftedAt: instant(properties, "liftedAt"),
    // Nullable `uuid`. Note `liftedAt` is deliberately NOT conditioned on this resolving: the LIFT
    // is the fact that stops enforcement, and dropping it because the actor id was malformed would
    // leave a freeze standing at this instance that its declaring domain has already retracted.
    liftedByActorId: uuidStr(properties, "liftedByActorId"),
    liftReason: str(properties, "liftReason")
  };

  await tx
    .insert(freezes)
    .values({ id: freezeId, ...values })
    .onConflictDoUpdate({
      target: freezes.id,
      set: values,
      // Only ever overwrite the row this object owns. A `freeze_admission` Decision cites
      // `freeze.id` forever, so silently rewriting a locally-authored row that happened to collide
      // would rewrite the explanation of a block that already happened.
      where: eq(freezes.objectId, object.id)
    });
}

/** THE TOMBSTONE SIDE. See docs/governance/freeze-object.md §3. */
export async function liftFreezeProjectionForTombstonedObject(
  tx: TenantTx,
  input: {
    orgId: string;
    objectId: string;
    /** `FEDERATION_IMPORT_ACTOR_ID`, passed in for the same reason `fallbackActorId` is: this
     *  module must not depend on `federation/import-repo.ts`, which depends on it. */
    actorId: string;
  }
): Promise<void> {
  await tx
    .update(freezes)
    .set({
      liftedAt: new Date(),
      liftedByActorId: input.actorId,
      // Names the MECHANISM, not a human's words, because no human at this instance did this. An
      // operator reading `scp freeze list` here needs to know the freeze stopped because its
      // declaring domain deleted its wire form, not because someone here retracted it — which they
      // could not have done.
      liftReason:
        "the declaring domain tombstoned this freeze's graph object (federation import, M25.7)"
    })
    .where(
      and(
        eq(freezes.orgId, input.orgId),
        eq(freezes.objectId, input.objectId),
        isNull(freezes.liftedAt)
      )
    );
}

/** The freeze this object projects to, or `null` — the read the service board and any future
 *  object-first reader needs, kept here so the `object_id` link is resolved in one direction only
 *  in one place. */
export async function findFreezeForObject(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<FreezeRow | null> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.objectId, objectId)))
    .limit(1);
  return (rows[0] as FreezeRow | undefined) ?? null;
}

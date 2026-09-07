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

/** M25.7 — THE WIRE FORM OF A FREEZE. See docs/governance.md §66. */
export const FREEZE_OBJECT_TYPE_ID = "freeze";

/** Registered as a builtin type, on both sides. See docs/governance.md §67. */
export function isFreezeObjectType(typeId: string): boolean {
  return typeId === FREEZE_OBJECT_TYPE_ID;
}

/** Derived from the freeze's UUID, never from its human `name`: two freezes may legitimately share
 *  a label, and the urn is the key `upsertObjectByUrn` matches on at the receiving instance. */
export function freezeObjectUrn(orgId: string, freezeId: string): string {
  return deriveUrn(orgId, FREEZE_OBJECT_TYPE_ID, freezeId);
}

/** THE SNAPSHOT THAT TRAVELS. See docs/governance.md §68. */
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

/** Mints the graph object for an inserted row, and links. See docs/governance.md §69. */
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

/** Re-snapshots a federated freeze after a lift or edit. See docs/governance.md §70. */
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

/** A string property that is genuinely a UUID, or `null`. See docs/governance.md §71. */
function uuidStr(properties: Record<string, unknown>, key: string): string | null {
  const value = str(properties, key);
  return value !== null && isUuid(value) ? value : null;
}

/** THE IMPORT SIDE. See docs/governance.md §72. */
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

  // URN FIRST, id second. See docs/governance.md §73.
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

/** THE TOMBSTONE SIDE. See docs/governance.md §74. */
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

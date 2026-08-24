import { and, eq, gt, isNull, lte, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { freezes } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";

/**
 * Freeze windows (DESIGN §10.3): "a built-in policy effect with time windows and scope
 * (org/domain/service/component)." A dedicated projection table (db/schema.ts's doc comment) —
 * `governance/gate-orchestrator.ts`'s `checkFreeze` queries this directly rather than folding
 * freezes into the policy-document model, since a freeze's scope/window semantics ("does this
 * window cover this object, right now") don't need CEL at all — a freeze either covers the target
 * or it doesn't. (`coordination/gates.ts` is the thin adapter above that orchestrator; it does not
 * touch this file.)
 */

export interface FreezeRow {
  id: string;
  orgId: string;
  scopeObjectId: string;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  createdAt: Date;
  /** M25.2 / owner decision D5 — `true` parks the WHOLE wave (pre-M25.2 behaviour), `false` (the
   *  default) admits the wave's uncovered targets and holds only the covered ones.
   *
   *  READ IN TWO PLACES, AND IT MUST BE BOTH: `gate-orchestrator.ts`'s `partiallyFrozen` predicate
   *  (the wave boundary) and `coordination/freeze-hold.ts`'s `evaluateFreezeHolds` (every tick of
   *  the trigger loop). The gate fires exactly ONCE, on `pending -> running`, so a gate-only reader
   *  makes `atomic` silently degrade to per-target for any freeze that opens after the wave started
   *  — which is the very case M25.2's second half exists to fix. */
  atomic: boolean;
  /** M25.1 — non-null means this freeze was RETRACTED by an operator and is no longer in force,
   *  whatever `endsAt` says. See `activeFreezesInWindow`, the one place it is filtered. */
  liftedAt: Date | null;
  liftedByActorId: string | null;
  liftReason: string | null;
}

export interface CreateFreezeInput {
  orgId: string;
  scopeObjectId: string;
  name?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  /** Defaults to `false` — see `freezes.atomic` (drizzle/0084). Reachable from
   *  `POST /api/v1/freezes` (`CreateFreezeRequestSchema.atomic`, optional) and `scp freeze create
   *  --atomic`, because a loosening whose escape hatch ships one increment later has a window in
   *  which the escape hatch does not exist. */
  atomic?: boolean | undefined;
}

/**
 * THE WINDOW-ORDER INVARIANT, in one place — `endsAt` must be strictly after `startsAt`.
 *
 * Extracted in M25.1 because `PATCH /freezes/{id}` is a SECOND writer of `ends_at` and a second
 * copy of this comparison is exactly the drift `activeFreezesInWindow`'s header is about, one
 * comparison over: a PATCH that admitted `endsAt <= startsAt` would leave a row `createFreeze`
 * refuses to produce, which the half-open window predicate then reads as permanently inactive
 * without anyone having lifted it.
 *
 * Throws `badRequest`, not `notFound`. It was `notFound` before this increment — a copy-paste that
 * would have reported a malformed window as a missing freeze to any caller that did not pre-check;
 * the route pre-checked, so it was never observable, which is why it survived.
 */
export function assertWindowOrdered(startsAt: Date, endsAt: Date): void {
  if (endsAt <= startsAt) {
    throw badRequest(
      `freeze endsAt (${endsAt.toISOString()}) must be after startsAt (${startsAt.toISOString()})`
    );
  }
}

export async function createFreeze(tx: TenantTx, input: CreateFreezeInput): Promise<FreezeRow> {
  assertWindowOrdered(input.startsAt, input.endsAt); // validated again at the route/schema layer; defensive here
  const [row] = await tx
    .insert(freezes)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      scopeObjectId: input.scopeObjectId,
      name: input.name ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
      createdByActorId: input.createdByActorId,
      atomic: input.atomic ?? false
    })
    .returning();
  return row as FreezeRow;
}

export async function getFreeze(tx: TenantTx, orgId: string, id: string): Promise<FreezeRow> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, id)))
    .limit(1);
  if (!rows[0]) throw notFound(`freeze '${id}' not found`);
  return rows[0] as FreezeRow;
}

/**
 * `getFreeze` UNDER A ROW LOCK — the read half of every read-modify-write in this file.
 *
 * BOTH WRITE VERBS ARE READ-MODIFY-WRITES, and both put the value they read into a PERMANENT
 * RECORD: `updateFreezeWindow` derives `direction` from `before.endsAt` and the route writes
 * `endsAt: { from, to }` into a Decision, while `liftFreeze` names `before.liftedAt` in its
 * conflict message. Under READ COMMITTED an UNLOCKED read is a stale snapshot the whole way to
 * COMMIT: two operators PATCH one freeze, both read `endsAt = T`, A commits `T1`, B's UPDATE then
 * blocks on the row lock, re-checks only `lifted_at IS NULL`, and writes `T2` from B's stale
 * snapshot. B's audit record then says "from T" — a window that was never live at the moment B
 * edited it — and, if `T < T1 < T2`, is stamped `freeze.window.extended` for an edit that actually
 * SHORTENED the live window. That is a hash-chained governance record asserting the opposite of
 * what happened, which principle 6 does not survive.
 *
 * `FOR UPDATE` parks the second transaction AT THE READ rather than at the UPDATE, so `before` is
 * whatever A committed and the direction and the audited `from` are both computed against the
 * value that was actually in force. Neither edit is lost and neither is refused. Same instrument,
 * same reason, as `coordination/transition.ts` (change rows), `graph/objects-repo.ts`'s
 * `lockObjectRow` and `dependencies/version-poll.ts`'s declaration re-read.
 *
 * NOT exported: an unlocked `getFreeze` is right for the two READ routes (`GET /freezes/{id}` and
 * the list), and taking a write lock there would serialize readers behind an editor for nothing.
 */
async function lockFreezeRow(tx: TenantTx, orgId: string, id: string): Promise<FreezeRow> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, id)))
    .limit(1)
    .for("update");
  if (!rows[0]) throw notFound(`freeze '${id}' not found`);
  return rows[0] as FreezeRow;
}

export async function listFreezes(tx: TenantTx, orgId: string): Promise<FreezeRow[]> {
  const rows = await tx.select().from(freezes).where(eq(freezes.orgId, orgId));
  return rows as FreezeRow[];
}

/**
 * EVERY freeze in the org whose window covers `at` — no scope filter at all.
 *
 * THE ONLY PLACE THAT KNOWS THE WINDOW PREDICATE (`starts_at <= at < ends_at`), and that is the
 * whole reason it is a function rather than an inlined `where`. `graph/containment.ts`'s header
 * records what a second copy of one idea costs here specifically: three row-returning copies of the
 * containment walk drifted, one of them kept a `domain_id`-only walk, and a service-scoped freeze
 * failed OPEN as a result. A second copy of the *window* predicate is the same hazard one column
 * over — the half-open boundary (`lte` on the start, `gt` on the end) is exactly the kind of detail
 * two copies stop agreeing about, and both directions of that disagreement are silent.
 *
 * Served by the `freezes_org_window` index. Returns [] for an org with no active freeze, which is
 * the overwhelmingly common case and the one `freeze-scope.ts`'s INERTNESS property is built on:
 * this query runs before any containment walk, so an org with nothing frozen pays one indexed read
 * per change per tick and not a single graph traversal.
 *
 * EXPIRY IS THIS PREDICATE AND NOTHING ELSE. There is no sweeper and no status column: the first
 * tick after `ends_at` a freeze simply stops being returned here. See `scan-override-grants.ts`,
 * which followed this file for the same reason.
 *
 * ============================================================================================
 * M25.1 — AND `lifted_at IS NULL`, THE ONLY LIVENESS FILTER IN THE SYSTEM
 * ============================================================================================
 * A freeze can now be RETRACTED before its window closes (`liftFreeze`, `DELETE /freezes/{id}`),
 * and that retraction is a soft one: the row stays, permanently readable by id, because two
 * Decision writers carry `freeze.id` in their `inputContext` and a hard delete would dangle every
 * one of them (charter principle 6).
 *
 * The filter belongs HERE and nowhere else, for the same reason the window predicate does. Every
 * consumer of "is this freeze in force" composes over this function — `activeFreezesForScopes`,
 * `freeze-scope.ts`'s `freezesByTarget`, and through them `checkFreeze`, `evaluateFreezeHolds` and
 * the service board's freeze resolution — so one `isNull` retires a freeze on every path at once,
 * INCLUDING the release path: `reconcile.ts`'s per-target loop simply stops seeing a hold and
 * `clearFreezeAdmissionHold` writes its `allow` row on the next tick, with no lift-specific code
 * anywhere in reconcile. A second liveness filter added elsewhere would be free to disagree with
 * this one, silently and in either direction — the shape that once made a service-scoped freeze
 * fail OPEN (`graph/containment.ts`'s header).
 *
 * The index is deliberately unchanged: `freezes_org_window` already narrows to freezes covering
 * this instant, which is zero rows for nearly every org nearly all the time, so this is a filter
 * over a handful of rows at most.
 */
export async function activeFreezesInWindow(
  tx: TenantTx,
  orgId: string,
  at: Date
): Promise<FreezeRow[]> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(
      and(
        eq(freezes.orgId, orgId),
        freezeWindowCovers(freezes.startsAt, freezes.endsAt, freezes.liftedAt, at)
      )
    );
  return rows as FreezeRow[];
}

/**
 * ============================================================================================
 * M25.3 — THE WINDOW PREDICATE ITSELF, COLUMN-GENERIC, SO TWO TABLES CAN SHARE ONE COPY
 * ============================================================================================
 * `starts_at <= at < ends_at AND lifted_at IS NULL`, half-open on purpose: a freeze whose
 * `ends_at` is exactly `at` is over.
 *
 * The instance-scoped tier (drizzle/0086, `instance-freezes-repo.ts`) is a SECOND TABLE, and a
 * second table cannot share the first's `where` clause. It could only have shared the RULE, and
 * the choices were to write the comparison out again there or to factor it here. Everything
 * `activeFreezesInWindow`'s docblock says about a second copy applies verbatim — the half-open
 * boundary is exactly the detail two copies stop agreeing about, in either direction, silently,
 * and `service-board.ts` has already hand-rolled this comparison once. So the claim above
 * ("THE ONLY PLACE THAT KNOWS THE WINDOW PREDICATE") stays TRUE and simply moved one level down:
 * both tiers' reads are built from this fragment, and neither spells `lte`/`gt`/`isNull` itself.
 *
 * Deliberately NOT parameterised on the org filter: the org tier has one and the instance tier
 * structurally cannot (no `org_id` column — the DESIGN §4.2 exception). Folding an optional org
 * predicate in here would let a caller omit it by passing `undefined`, which at the ORG tier is a
 * cross-tenant read. The caller `and()`s its own tenancy filter, where forgetting it is visible.
 */
export function freezeWindowCovers(
  startsAt: PgColumn,
  endsAt: PgColumn,
  liftedAt: PgColumn,
  at: Date
): SQL | undefined {
  return and(lte(startsAt, at), gt(endsAt, at), isNull(liftedAt));
}

/**
 * THE MEMBERSHIP RULE — pure, no database, unit-testable on its own.
 *
 * EXACT-SET MEMBERSHIP, NOT CONTAINMENT, and that contract is the dangerous half of this file: this
 * function does no walking whatsoever, so any id the caller omits from `scopeObjectIds` is a freeze
 * that silently does not block. Callers must build the set with `graph/containment.ts`'s
 * `containmentScopeIds` (or, per target, `containmentChain`), which walks BOTH containment routes.
 * A caller that hand-rolled a `domain_id`-only walk omitted the target's SERVICE, and a
 * service-scoped freeze failed OPEN — the incident `graph/containment.ts` exists to have ended. If
 * you give this function ids from anywhere else, walk every route first.
 */
export function filterFreezesByScopes<T extends Pick<FreezeRow, "scopeObjectId">>(
  rows: T[],
  scopeObjectIds: string[]
): T[] {
  if (scopeObjectIds.length === 0) return [];
  const scopes = new Set(scopeObjectIds);
  return rows.filter((f) => scopes.has(f.scopeObjectId));
}

/** Freezes active RIGHT NOW (`at`) whose scope is one of `scopeObjectIds` — the caller passes the
 *  target's full containment chain (org/domain/service/component ids) so a freeze declared at any
 *  containment level is found regardless of which exact object the gate check is evaluating.
 *
 *  THE COMPOSITION of the two functions above, and byte-identical in behaviour to the single
 *  function it replaced: same half-open window, same exact-set membership, same empty-input short
 *  circuit, same order (the window query has no `ORDER BY` and the filter preserves whatever it
 *  returns — `checkFreeze`'s override loop is order-independent by construction and must stay so).
 *  Read `filterFreezesByScopes`'s warning before calling it: this function inherits every word of
 *  it, including that any omitted id is a freeze that silently does not block.
 *
 *  `governance/freeze-scope.ts`'s `freezesByTarget` answers the SAME question per target, and the
 *  two are set-equal by construction because `containmentScopeIds` IS the union of the per-target
 *  chains. That equality is pinned by a test; if you change either, change both. */
export async function activeFreezesForScopes(
  tx: TenantTx,
  orgId: string,
  scopeObjectIds: string[],
  at: Date
): Promise<FreezeRow[]> {
  if (scopeObjectIds.length === 0) return [];
  return filterFreezesByScopes(await activeFreezesInWindow(tx, orgId, at), scopeObjectIds);
}

// =============================================================================================
// M25.1 — THE TWO WRITE VERBS THAT WERE MISSING
//
// `/api/v1/freezes` shipped as CREATE / LIST / GET. A freeze could be declared and never
// retracted or shortened, which was survivable only while a freeze parked a WHOLE wave: the
// operator waited for `ends_at` and the release resumed. M25.2 made it unsurvivable — a
// far-future `ends_at` now holds a SUBSET of a wave's targets while the siblings have shipped, so
// a mistyped year leaves a fleet split across two versions with no API exit. The only escapes
// were `scp change cancel` / `scp change rollback`, which throw the RELEASE away, not the FREEZE.
//
// BOTH VERBS ARE `freeze:write` AT THE FREEZE'S OWN SCOPE, and the routes enforce that (this file
// never authorizes — same split as everywhere else in the repo layer). See `routes/governance.ts`
// for the reasoning about `freeze:write` vs `freeze:override`.
// =============================================================================================

export interface LiftFreezeInput {
  orgId: string;
  id: string;
  /** MANDATORY and non-empty — checked at the route, defended here. */
  reason: string;
  actorObjectId: string;
  /** Injectable for tests; production passes nothing. Recorded verbatim as `lifted_at`. */
  now?: Date | undefined;
}

/**
 * RETRACT a freeze: it stops being in force immediately, whatever `ends_at` says.
 *
 * A SOFT lift (drizzle/0085). The row stays and stays readable by id, because
 * `gate-orchestrator.ts`'s freeze-block Decision carries `inputContext.freeze.id` and
 * `reconcile.ts`'s `recordFreezeAdmissionHold` carries `inputContext.held[].freezes[].id`, both
 * permanently. A hard delete would make `scp change explain` name an id that resolves to nothing —
 * precisely the question ("what was this freeze that blocked me?") that charter principle 6 exists
 * to keep answerable.
 *
 * NOT EXPRESSIBLE AS `ends_at = now()`, which is why this needed a column at all: a freeze
 * SCHEDULED for next week has `starts_at` in the future, so that assignment would produce
 * `ends_at < starts_at` — a row violating the invariant `assertWindowOrdered` enforces on both
 * write paths. A scheduled freeze declared by mistake is exactly the freeze someone needs to
 * retract, so the encoding has to cover it.
 *
 * IDEMPOTENT? NO — a second lift is a `conflict`, deliberately. `lifted_at`, `lifted_by_actor_id`
 * and `lift_reason` are a single record of WHO retracted this and WHY; silently letting a second
 * caller overwrite them would replace the operator who actually lifted it (and their reason) with
 * whoever repeated the call, and the audit event pair would then disagree with the row. The
 * conditional `UPDATE ... WHERE lifted_at IS NULL` makes that a race-free refusal rather than a
 * read-then-write check.
 */
export async function liftFreeze(tx: TenantTx, input: LiftFreezeInput): Promise<FreezeRow> {
  if (input.reason.trim().length === 0) {
    throw badRequest("lifting a freeze requires a non-empty reason");
  }
  // Loaded first so an unknown id is a 404 rather than the 409 the no-op UPDATE below would
  // otherwise produce, and so the caller gets the BEFORE row for its audit event and Decision.
  // UNDER `FOR UPDATE` (`lockFreezeRow`): the conditional UPDATE below already makes a double lift
  // a race-free REFUSAL, but the refusal's message quotes `before.liftedAt`, and an unlocked read
  // that raced the winning lift would report "already lifted at undefined" — naming no instant and
  // no operator, in the one message whose entire job is to say who got there first.
  const before = await lockFreezeRow(tx, input.orgId, input.id);
  const [row] = await tx
    .update(freezes)
    .set({
      liftedAt: input.now ?? new Date(),
      liftedByActorId: input.actorObjectId,
      liftReason: input.reason
    })
    .where(and(eq(freezes.orgId, input.orgId), eq(freezes.id, input.id), isNull(freezes.liftedAt)))
    .returning();
  if (!row) {
    throw conflict(
      `freeze '${input.id}' was already lifted at ${before.liftedAt?.toISOString()} — a lift records who retracted it and why, and is not overwritten`
    );
  }
  return row as FreezeRow;
}

/** Which way a window edit moved, for the audit event and the Decision. A SHORTENING is a
 *  governance LOOSENING (the freeze stops protecting sooner); an EXTENSION is a TIGHTENING. Both
 *  need `freeze:write`; they are distinguished because "who made governance weaker, and when" is
 *  the question an audit log is read with.
 *
 *  `"unchanged"` IS A THIRD CASE AND NOT A ROUNDING ERROR. A comparison written as
 *  `endsAt < before.endsAt ? "shortened" : "extended"` — which is how this shipped — folds equality
 *  into the wrong arm: `PATCH { endsAt: <the value it already has> }` is an ordinary thing for a
 *  form-backed UI to send on save, and it wrote a hash-chained `freeze.window.extended` event, plus
 *  a Decision asserting an extension, with `from === to`. Nothing was extended. Refusing the call
 *  instead would be equally truthful and worse to use, so the third label is the answer: the record
 *  says what happened, and `loosening` stays false because no protection was weakened. */
export type FreezeWindowDirection = "shortened" | "extended" | "unchanged";

export interface UpdateFreezeWindowInput {
  orgId: string;
  id: string;
  endsAt: Date;
  /** MANDATORY and non-empty on BOTH directions — see the route's docblock. */
  reason: string;
  actorObjectId: string;
}

export interface UpdateFreezeWindowResult {
  before: FreezeRow;
  after: FreezeRow;
  direction: FreezeWindowDirection;
}

/**
 * Move a freeze's `ends_at`, in EITHER direction.
 *
 * SHORTENING to a past instant is left as an ordinary window edit and is NOT silently re-labelled
 * a lift. It has the same effect on admission — the freeze leaves the half-open window and every
 * consumer of `activeFreezesInWindow` stops seeing it on the next read — and a different record,
 * which is the truth: the operator said "this ends sooner", not "I retract this". The distinction
 * is not academic, because it is reversible (a later PATCH can push `ends_at` forward again and
 * the freeze returns) where a lift is not.
 *
 * `startsAt` is deliberately NOT editable. Moving the start of a window that is already open is
 * either a no-op or a rewriting of history — "this freeze was in force from a time it was not" —
 * and neither is a thing an operator has asked for. `endsAt` is the whole of the escape hatch
 * M25.1 exists to provide.
 *
 * REFUSED ON A LIFTED FREEZE (`conflict`). Extending one would produce a row whose `ends_at`
 * promises protection that `lifted_at` cancels, readable either way by anyone who does not know
 * which filter wins; the honest answer is that a retraction is final and a new freeze is one POST
 * away.
 */
export async function updateFreezeWindow(
  tx: TenantTx,
  input: UpdateFreezeWindowInput
): Promise<UpdateFreezeWindowResult> {
  if (input.reason.trim().length === 0) {
    throw badRequest("changing a freeze window requires a non-empty reason");
  }
  // `FOR UPDATE` — see `lockFreezeRow`. `direction` and the Decision's `endsAt.from` are BOTH
  // derived from this row, so reading it unlocked would let a concurrent PATCH make both false.
  const before = await lockFreezeRow(tx, input.orgId, input.id);
  if (before.liftedAt) {
    throw conflict(
      `freeze '${input.id}' was lifted at ${before.liftedAt.toISOString()} — a retraction is final; declare a new freeze instead of re-opening this one`
    );
  }
  // THE SAME invariant `createFreeze` enforces, from the same function. A PATCH that admitted
  // `endsAt <= startsAt` would leave a row the POST route refuses to produce.
  assertWindowOrdered(before.startsAt, input.endsAt);
  const direction: FreezeWindowDirection =
    input.endsAt < before.endsAt
      ? "shortened"
      : input.endsAt > before.endsAt
        ? "extended"
        : "unchanged"; // equality is its own case — see `FreezeWindowDirection`
  const [row] = await tx
    .update(freezes)
    .set({ endsAt: input.endsAt })
    .where(and(eq(freezes.orgId, input.orgId), eq(freezes.id, input.id), isNull(freezes.liftedAt)))
    .returning();
  if (!row) throw conflict(`freeze '${input.id}' was lifted concurrently`);
  return { before, after: row as FreezeRow, direction };
}

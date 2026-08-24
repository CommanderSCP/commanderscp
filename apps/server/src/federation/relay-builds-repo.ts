/**
 * M13.1b — the AUTO-RELAY BUILD LEDGER's data access (`federation_relay_builds`, drizzle/0047).
 *
 * The scheduler state behind the staging node's unattended onward BYTE hop: which imported
 * promotions still owe a relay tarball, which worker is building one right now, how many verdicts a
 * failing one has produced, and which are terminally done. The loop that consumes it is
 * `auto-relay.ts`; the causal writer that seeds it is `promotion-repo.ts`; the terminal writers are
 * the forward path (`retrans-relay.ts`) and the manual relay route.
 *
 * ## The two rules this module exists to enforce
 *
 * 1. **THE CLAIM IS A FENCE, AND EVERY RELEASE IS FENCED BY IT.** `claimRelayBuild` is a single
 *    `INSERT … ON CONFLICT DO UPDATE … WHERE` — atomic by construction, so N worker replicas ticking
 *    together produce at most one build per change per lease window. That is only half the problem:
 *    a lease can EXPIRE while a build is still running (a multi-GB skopeo pull can outrun any
 *    default), so two workers can legitimately hold the same change in sequence. If the releases
 *    were keyed on `(org_id, change_object_id)` alone, the SLOW worker's late write would clobber
 *    the fast one's terminal state — flipping a `built` row back to `pending` (rebuilding and
 *    re-dropping bytes across the boundary) or stamping `exhausted` with a durable, hash-chained
 *    explanation that says "nothing crossed the boundary" about bytes that did. So every release
 *    carries the `attempts` value its own claim returned and is guarded on
 *    `status = 'pending' AND attempts = <that value>`; a stale claimant matches zero rows, learns it
 *    lost the lease, and writes NOTHING — no ledger change, no Decision, no audit event.
 *
 * 2. **A TERMINAL STATE IS TERMINAL.** `built`, `forwarded` and `exhausted` are never re-opened by a
 *    release path. Only {@link reopenRelayBuild} — reached exclusively from a SUCCESSFUL manual
 *    relay — moves a row out of `exhausted`, which is what keeps the operator's existing
 *    `POST /api/v1/federation/relay` the documented, sufficient exit from a boundary stall.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationRelayBuilds } from "../db/schema.js";

export type RelayBuildStatus = "pending" | "built" | "forwarded" | "exhausted";

export interface RelayBuildRow {
  changeObjectId: string;
  sourceChangeObjectId: string | null;
  status: RelayBuildStatus;
  attempts: number;
  failedAttempts: number;
  lastReason: string | null;
  lastDecisionId: string | null;
  tarballPath: string | null;
}

/** A successful claim: the fence token every release for this attempt must carry. */
export interface RelayBuildClaim {
  changeObjectId: string;
  sourceChangeObjectId: string | null;
  /** The `attempts` value this claim wrote — the fence. */
  attempts: number;
  /** Verdict-producing failures BEFORE this attempt; the cap is measured against this + 1. */
  failedAttempts: number;
}

/**
 * CAUSAL SEED — called by the promotion import, in the import's own transaction, on a `role:
 * retrans` instance only. Idempotent: `ON CONFLICT DO NOTHING` means a replayed bundle (or a
 * re-import after the hop already completed) can never resurrect a terminal row or reset a backoff.
 * Returns true when a NEW row was seeded.
 */
export async function seedRelayBuild(
  tx: TenantTx,
  input: { orgId: string; changeObjectId: string; sourceChangeObjectId: string | null }
): Promise<boolean> {
  const inserted = await tx.execute(sql`
    INSERT INTO federation_relay_builds
      (id, org_id, change_object_id, source_change_object_id, status, attempts, failed_attempts,
       next_attempt_at, created_at, updated_at)
    VALUES (${uuidv7()}, ${input.orgId}, ${input.changeObjectId}, ${input.sourceChangeObjectId},
            'pending', 0, 0, now(), now(), now())
    ON CONFLICT (org_id, change_object_id) DO NOTHING
    RETURNING id
  `);
  return (inserted.rows as unknown[]).length > 0;
}

/**
 * The DUE candidates: seeded rows whose retry gate has passed, whose lease (if any) has lapsed, and
 * whose change is still in a state where relaying bytes is meaningful.
 *
 * The `changes` join is a PK lookup, not a scan, and exists for exactly one reason: a promotion can
 * be cancelled or rolled back AFTER it was imported and seeded, and pushing its bytes across a
 * security boundary afterwards is never right. Those rows stay `pending` rather than being marked
 * terminal — a cancellation is not this loop's verdict to record, and if the change is later
 * un-cancelled the hop simply resumes.
 */
export async function listDueRelayBuilds(
  tx: TenantTx,
  orgId: string,
  limit: number
): Promise<RelayBuildRow[]> {
  const rows = await tx.execute(sql`
    SELECT b.change_object_id, b.source_change_object_id, b.status, b.attempts, b.failed_attempts,
           b.last_reason, b.last_decision_id, b.tarball_path
      FROM federation_relay_builds b
      JOIN changes c ON c.org_id = b.org_id AND c.object_id = b.change_object_id
     WHERE b.org_id = ${orgId}
       AND b.status = 'pending'
       AND b.next_attempt_at <= now()
       AND (b.claimed_until IS NULL OR b.claimed_until <= now())
       AND c.state NOT IN ('cancelled', 'rolled_back')
     ORDER BY b.created_at, b.change_object_id
     LIMIT ${limit}
  `);
  return (
    rows.rows as {
      change_object_id: string;
      source_change_object_id: string | null;
      status: RelayBuildStatus;
      attempts: number;
      failed_attempts: number;
      last_reason: string | null;
      last_decision_id: string | null;
      tarball_path: string | null;
    }[]
  ).map((r) => ({
    changeObjectId: r.change_object_id,
    sourceChangeObjectId: r.source_change_object_id,
    status: r.status,
    attempts: Number(r.attempts),
    failedAttempts: Number(r.failed_attempts),
    lastReason: r.last_reason,
    lastDecisionId: r.last_decision_id,
    tarballPath: r.tarball_path
  }));
}

/**
 * THE ATOMIC CLAIM. One statement takes the row lock and re-evaluates the due predicate against the
 * CURRENT row, which an enumerate-then-update pair cannot do (its read is stale by the time it
 * writes). Returns the fence token, or `null` when the row was not claimable (another worker holds
 * the lease, it is backing off, or it went terminal between enumeration and now).
 *
 * `attempts` increments here, `failed_attempts` does NOT — see the migration header: a worker that
 * claims and is then evicted must not spend the change's lifetime verdict budget.
 */
export async function claimRelayBuild(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  leaseSeconds: number
): Promise<RelayBuildClaim | null> {
  const lease = sql.raw(`interval '${Math.max(1, Math.floor(leaseSeconds))} seconds'`);
  const result = await tx.execute(sql`
    UPDATE federation_relay_builds
       SET attempts = attempts + 1,
           claimed_until = now() + ${lease},
           updated_at = now()
     WHERE org_id = ${orgId}
       AND change_object_id = ${changeObjectId}
       AND status = 'pending'
       AND next_attempt_at <= now()
       AND (claimed_until IS NULL OR claimed_until <= now())
    RETURNING change_object_id, source_change_object_id, attempts, failed_attempts
  `);
  const row = (
    result.rows as {
      change_object_id: string;
      source_change_object_id: string | null;
      attempts: number;
      failed_attempts: number;
    }[]
  )[0];
  if (!row) return null;
  return {
    changeObjectId: row.change_object_id,
    sourceChangeObjectId: row.source_change_object_id,
    attempts: Number(row.attempts),
    failedAttempts: Number(row.failed_attempts)
  };
}

/** FENCED release — success. Returns false when this worker no longer holds the claim (its lease
 *  lapsed and someone else took over), in which case the caller must write nothing else. */
export async function completeRelayBuild(
  tx: TenantTx,
  orgId: string,
  claim: RelayBuildClaim,
  args: { tarballPath: string; decisionId: string }
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE federation_relay_builds
       SET status = 'built',
           claimed_until = NULL,
           last_reason = NULL,
           last_decision_id = ${args.decisionId},
           tarball_path = ${args.tarballPath},
           updated_at = now()
     WHERE org_id = ${orgId}
       AND change_object_id = ${claim.changeObjectId}
       AND status = 'pending'
       AND attempts = ${claim.attempts}
    RETURNING id
  `);
  return (result.rows as unknown[]).length > 0;
}

/** FENCED release — a failed attempt that is NOT yet terminal: record the verdict and schedule the
 *  next one. Returns false when the claim was lost (write nothing else). */
export async function backoffRelayBuild(
  tx: TenantTx,
  orgId: string,
  claim: RelayBuildClaim,
  args: { backoffSeconds: number; reason: string; decisionId: string | null }
): Promise<boolean> {
  const backoff = sql.raw(`interval '${Math.max(1, Math.floor(args.backoffSeconds))} seconds'`);
  const result = await tx.execute(sql`
    UPDATE federation_relay_builds
       SET failed_attempts = failed_attempts + 1,
           next_attempt_at = now() + ${backoff},
           claimed_until = NULL,
           last_reason = ${args.reason},
           last_decision_id = ${args.decisionId},
           updated_at = now()
     WHERE org_id = ${orgId}
       AND change_object_id = ${claim.changeObjectId}
       AND status = 'pending'
       AND attempts = ${claim.attempts}
    RETURNING id
  `);
  return (result.rows as unknown[]).length > 0;
}

/** FENCED release — TERMINAL exhaustion. Returns false when the claim was lost, and the caller MUST
 *  then skip its Decision + audit event: a verdict that could not be recorded as terminal state
 *  would otherwise be re-derived and re-written on every subsequent tick, forever (#153's shape). */
export async function exhaustRelayBuild(
  tx: TenantTx,
  orgId: string,
  claim: RelayBuildClaim,
  args: { reason: string; decisionId: string }
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE federation_relay_builds
       SET status = 'exhausted',
           failed_attempts = failed_attempts + 1,
           claimed_until = NULL,
           last_reason = ${args.reason},
           last_decision_id = ${args.decisionId},
           updated_at = now()
     WHERE org_id = ${orgId}
       AND change_object_id = ${claim.changeObjectId}
       AND status = 'pending'
       AND attempts = ${claim.attempts}
    RETURNING id
  `);
  return (result.rows as unknown[]).length > 0;
}

/**
 * TERMINAL, out-of-band: this node RECEIVED the bytes rather than building them (the high-side
 * retrans hop — `validateAndForwardRelayTarball` succeeded for this change). Upserts, because the
 * high side seeds a row at import exactly like the low side does and a tarball can arrive before or
 * after that seed.
 *
 * IT MUST BE ABLE TO CORRECT AN `exhausted` ROW, not only a `pending` one. Both boundary nodes are
 * `role: retrans` and both seed at import, so a high side with `SCP_RETRANS_AUTO_RELAY` mistakenly
 * set burns its verdict budget in ~15 minutes of backoff — while the CDS transfer that will deliver
 * the tarball can take far longer (the default claim lease is an hour, and it exists precisely
 * because multi-GB moves are slow). Restricting this to `pending` left the arriving bytes unable to
 * correct the record they disprove: the row stayed `exhausted`, asserting the hop never happened, on
 * the very node that had just validated and forwarded it. `built` is deliberately NOT correctable
 * here — a node that genuinely built and dropped this change's tarball is the low side, and an
 * arriving tarball for it would be a loop, not a correction.
 */
export async function markRelayBuildForwarded(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    sourceChangeObjectId: string | null;
    forwardedPath: string;
    decisionId: string;
  }
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO federation_relay_builds
      (id, org_id, change_object_id, source_change_object_id, status, attempts, failed_attempts,
       next_attempt_at, last_reason, last_decision_id, tarball_path, created_at, updated_at)
    VALUES (${uuidv7()}, ${input.orgId}, ${input.changeObjectId}, ${input.sourceChangeObjectId},
            'forwarded', 0, 0, now(),
            ${"bytes arrived here and were validated-and-forwarded — this node receives the hop, it does not build it"},
            ${input.decisionId}, ${input.forwardedPath}, now(), now())
    ON CONFLICT (org_id, change_object_id) DO UPDATE
       SET status = 'forwarded',
           claimed_until = NULL,
           last_reason = excluded.last_reason,
           last_decision_id = excluded.last_decision_id,
           tarball_path = excluded.tarball_path,
           updated_at = now()
     WHERE federation_relay_builds.status IN ('pending', 'exhausted')
  `);
}

/**
 * THE EXIT FROM `exhausted` — reached only from a SUCCESSFUL manual `POST /api/v1/federation/relay`.
 * An operator who fixes whatever the sweep gave up on and re-drives the hop by hand has, by that
 * act, both delivered the bytes and demonstrated the cause is gone; recording it `built` is simply
 * the truth, and it means a terminal row is never a trap that needs superuser SQL to clear.
 * Upserts, so a manual relay on a change with no ledger row (a commander/outpost, or a promotion
 * imported before this milestone) records the outcome too.
 */
export async function reopenRelayBuild(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    sourceChangeObjectId: string | null;
    tarballPath: string;
    decisionId: string;
  }
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO federation_relay_builds
      (id, org_id, change_object_id, source_change_object_id, status, attempts, failed_attempts,
       next_attempt_at, last_reason, last_decision_id, tarball_path, created_at, updated_at)
    VALUES (${uuidv7()}, ${input.orgId}, ${input.changeObjectId}, ${input.sourceChangeObjectId},
            'built', 0, 0, now(),
            ${"relayed by an operator-invoked build (POST /federation/relay)"},
            ${input.decisionId}, ${input.tarballPath}, now(), now())
    ON CONFLICT (org_id, change_object_id) DO UPDATE
       SET status = 'built',
           failed_attempts = 0,
           claimed_until = NULL,
           last_reason = excluded.last_reason,
           last_decision_id = excluded.last_decision_id,
           tarball_path = excluded.tarball_path,
           updated_at = now()
  `);
}

/** Read one row (tests + operator diagnostics). */
export async function getRelayBuild(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<RelayBuildRow | null> {
  const rows = await tx
    .select()
    .from(federationRelayBuilds)
    .where(
      and(
        eq(federationRelayBuilds.orgId, orgId),
        eq(federationRelayBuilds.changeObjectId, changeObjectId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    changeObjectId: row.changeObjectId,
    sourceChangeObjectId: row.sourceChangeObjectId,
    status: row.status as RelayBuildStatus,
    attempts: row.attempts,
    failedAttempts: row.failedAttempts,
    lastReason: row.lastReason,
    lastDecisionId: row.lastDecisionId,
    tarballPath: row.tarballPath
  };
}

/**
 * The FULL row — every column {@link RelayBuildRow} omits (the two scheduling columns
 * `nextAttemptAt`/`claimedUntil` and the two audit timestamps) PLUS everything `RelayBuildRow`
 * already carries. A deliberately SEPARATE interface rather than a widened `RelayBuildRow`: the
 * loop/claim/release functions above only ever needed the narrower shape, and widening it would
 * have every one of those call sites start carrying scheduling columns whose exposure was never
 * reviewed for them. This is the OPERATOR TRIAGE projection — {@link listRelayBuilds} below is its
 * only producer.
 */
export interface RelayBuildLedgerRow {
  changeObjectId: string;
  sourceChangeObjectId: string | null;
  status: RelayBuildStatus;
  attempts: number;
  failedAttempts: number;
  /** ISO-8601 — the retry gate: a 'pending' row is workable only at/after this instant. */
  nextAttemptAt: string;
  /** ISO-8601, or `null` when unclaimed. */
  claimedUntil: string | null;
  lastReason: string | null;
  lastDecisionId: string | null;
  tarballPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * OPERATOR READ SURFACE (M13.1b, owner ask) — `GET /api/v1/federation/relay-builds`: see queue
 * depth and exhausted rows without DB surgery. Every row for this org, optionally filtered by
 * `status`, ordered by `updated_at DESC` (most recent activity first) — this is TRIAGE, not the
 * work queue, so the ordering is deliberately NOT `listDueRelayBuilds`'s `created_at,
 * change_object_id` (that function and its predicate are untouched by this one).
 *
 * ROLE-AGNOSTIC BY CONSTRUCTION: rows exist only on a `role: retrans` instance (seeded at
 * promotion import there, `promotion-repo.ts`); on any other role the table is honestly empty, so
 * this list returns an empty array rather than a 409 — matching how every other read in this
 * codebase treats "nothing here" versus "not entitled to look".
 */
export async function listRelayBuilds(
  tx: TenantTx,
  orgId: string,
  opts: { status?: RelayBuildStatus; limit: number }
): Promise<RelayBuildLedgerRow[]> {
  const conditions = [eq(federationRelayBuilds.orgId, orgId)];
  if (opts.status) conditions.push(eq(federationRelayBuilds.status, opts.status));

  const rows = await tx
    .select()
    .from(federationRelayBuilds)
    .where(and(...conditions))
    .orderBy(desc(federationRelayBuilds.updatedAt))
    .limit(opts.limit);
  return rows.map((row) => ({
    changeObjectId: row.changeObjectId,
    sourceChangeObjectId: row.sourceChangeObjectId,
    status: row.status as RelayBuildStatus,
    attempts: row.attempts,
    failedAttempts: row.failedAttempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    claimedUntil: row.claimedUntil?.toISOString() ?? null,
    lastReason: row.lastReason,
    lastDecisionId: row.lastDecisionId,
    tarballPath: row.tarballPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }));
}

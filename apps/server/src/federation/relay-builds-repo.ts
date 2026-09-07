/** M13.1b — the AUTO-RELAY BUILD LEDGER's data access. See docs/federation.md §457. */
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

/** Causal seed, written in the import's own transaction. See docs/federation.md §458. */
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

/** The DUE candidates. See docs/federation.md §459. */
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

/** THE ATOMIC CLAIM. See docs/federation.md §460. */
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

/** Terminal and out-of-band: this node received the bytes. See docs/federation.md §461. */
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

/** THE EXIT FROM `exhausted`. See docs/federation.md §462. */
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

/** The FULL row. See docs/federation.md §463. */
export interface RelayBuildLedgerRow {
  changeObjectId: string;
  sourceChangeObjectId: string | null;
  status: RelayBuildStatus;
  attempts: number;
  failedAttempts: number;
  /** ISO-8601 — the retry gate: a 'pending' row is workable only at/after this instant. */
  nextAttemptAt: string;
  claimedUntil: string | null;
  lastReason: string | null;
  lastDecisionId: string | null;
  tarballPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** OPERATOR READ SURFACE. See docs/federation.md §464. */
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

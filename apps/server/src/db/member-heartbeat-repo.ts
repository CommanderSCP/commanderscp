import { gt } from "drizzle-orm";
import type { Db } from "./client.js";
import { memberClusterHeartbeat } from "./schema.js";

/** §7.4 — how long since a heartbeat still counts a member cluster as LIVE. Generous relative to any
 *  boot cadence so a briefly-restarting pod is not mistaken for a decommissioned cluster; the
 *  version-skew gate only ever REFUSES on a live trailing heartbeat, never on a stale one. */
export const MEMBER_HEARTBEAT_LIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export interface MemberHeartbeat {
  clusterId: string;
  appVersion: string;
  updatedAt: Date;
}

/** Upsert THIS process's member-cluster heartbeat. Called on boot; the row's key is the cluster id,
 *  so a cluster can only ever refresh its own row (instance-wide table, no org context needed). */
export async function recordMemberClusterHeartbeat(
  db: Db,
  clusterId: string,
  appVersion: string
): Promise<void> {
  await db
    .insert(memberClusterHeartbeat)
    .values({ clusterId, appVersion })
    .onConflictDoUpdate({
      target: memberClusterHeartbeat.clusterId,
      set: { appVersion, updatedAt: new Date() }
    });
}

/** Every member cluster whose heartbeat is within the live window. */
export async function listLiveMemberHeartbeats(
  db: Db,
  windowMs: number = MEMBER_HEARTBEAT_LIVE_WINDOW_MS
): Promise<MemberHeartbeat[]> {
  const cutoff = new Date(Date.now() - windowMs);
  const rows = await db
    .select({
      clusterId: memberClusterHeartbeat.clusterId,
      appVersion: memberClusterHeartbeat.appVersion,
      updatedAt: memberClusterHeartbeat.updatedAt
    })
    .from(memberClusterHeartbeat)
    .where(gt(memberClusterHeartbeat.updatedAt, cutoff));
  return rows;
}

/**
 * §7.4 version-skew gate — pure, so the migrations Job's refusal is directly testable. REFUSES (by
 * throwing) iff any LIVE member cluster reports a version DIFFERENT from `deployingVersion` — i.e. an
 * old (or newer) member cluster is still up, so the contract half must wait. `own` heartbeats already
 * on the deploying version are fine (this cluster restarting), and an empty set is fine (first
 * deploy). N and N+1 only: it is the DIFFERENCE that blocks a contract migration, since a contract
 * migration is safe only once every member runs the release that shipped its expand half.
 */
export function assertNoVersionSkewOrThrow(
  liveHeartbeats: MemberHeartbeat[],
  deployingVersion: string
): void {
  const trailing = [...new Set(liveHeartbeats.map((h) => h.appVersion))].filter(
    (v) => v !== deployingVersion
  );
  if (trailing.length > 0) {
    throw new Error(
      `[scpd] refusing a CONTRACT-phase migration: ${trailing.length} member-cluster version(s) other ` +
        `than the deploying version '${deployingVersion}' are still LIVE (${trailing.join(", ")}). A ` +
        "contract migration must wait until every member cluster runs the release that shipped its " +
        "expand half (§7.4, N and N+1 only). Roll every member cluster to this version first, or deploy " +
        "the expand phase (SCP_MIGRATION_PHASE unset) instead of contract."
    );
  }
}

/** True for a Postgres "relation does not exist" (42P01) — the heartbeat table's own bootstrap
 *  deploy, before 0093 has applied, has no table to read, and the gate must fail OPEN there. */
export function isMissingHeartbeatTable(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "42P01";
}

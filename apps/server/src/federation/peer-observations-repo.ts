import { and, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { boundPersistedJson } from "@scp/runner-launcher";
import type { TrustDomainId, WaveTargetObservedPayload } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeerObservations } from "../db/schema.js";
import { isTerminalHookRunStatus } from "../coordination/pipeline-hook-runs.js";
import { isTerminalWaveTargetStatus } from "../coordination/wave-targets-repo.js";
import { OBSERVED_WEIGHT_FRESHNESS_MS } from "../coordination/stage-dependency-hold.js";

/**
 * THE RECEIVER HALF of the `wave_target_observed` journal kind (pipeline-mockup-data.md §5.3, owner
 * decisions D3/D4 of 2026-09-16) — the read-only replica of what a PEER observed, plus the ordering
 * and freshness rules the replica is only honest with.
 *
 * The sender half is `wave-target-observed-journal.ts`, and the split is the echo-loop guard: that
 * module writes the journal and never this table, this one writes this table and never the journal.
 * `pipeline-hooks-repo.ts` needs a `federationImport` flag because its sender and receiver share a
 * function; here they share nothing, so there is no code path from an import back to an append.
 */

// ---------------------------------------------------------------------------------------------
// Ordering: what "later" means for an observation
// ---------------------------------------------------------------------------------------------

/** Is this reported status a FINAL one for its subject? One definition per subject, both delegated
 *  to the module that owns the status vocabulary rather than restated here — the wave-target set has
 *  already grown twice (`REFUSED_WAVE_TARGET_STATUSES`) and a copy would have gone stale. An
 *  unrecognised status (a peer one migration ahead) is NOT terminal, which is the safe reading: it
 *  can still be recorded before a terminal arrives, and can never overwrite one. */
export function isTerminalObservedStatus(
  subject: WaveTargetObservedPayload["subject"],
  status: string
): boolean {
  return subject === "hook_run"
    ? isTerminalHookRunStatus(status)
    : isTerminalWaveTargetStatus(status);
}

/** What the receiver already holds for one identity, reduced to the two facts ordering needs. */
export interface StoredObservationOrder {
  subject: WaveTargetObservedPayload["subject"];
  status: string;
  observedAt: Date;
}

/**
 * THE MONOTONE RECEIVER (proposal §9 mitigation 4). Out-of-order delivery is normal, not
 * exceptional: an air-gapped outpost hands over bundle FILES, and two of them can be imported in
 * either order. Duplicates are normal too — a re-poll of the same run on two worker replicas emits
 * the same transition twice.
 *
 * Three rules, in order:
 *  1. An OLDER reading never overwrites a newer one (`observedAt` strictly older → ignore). Equal
 *     timestamps apply, so a replayed identical entry is idempotent rather than refused.
 *  2. A terminal reading is never walked BACK to a non-terminal one, however new the sender says it
 *     is. A run that succeeded and is then re-reported as `running` is a replay or a reset at the
 *     peer; following it would make a commander's display oscillate on a fact that has settled.
 *  3. Otherwise apply — including same-status-newer-reading, which is how rollout progress inside
 *     one `observing` status reaches the commander at all.
 */
export function shouldApplyPeerObservation(
  stored: StoredObservationOrder | undefined,
  incoming: { subject: WaveTargetObservedPayload["subject"]; status: string; observedAt: Date }
): boolean {
  if (!stored) return true;
  if (incoming.observedAt.getTime() < stored.observedAt.getTime()) return false;
  if (
    isTerminalObservedStatus(stored.subject, stored.status) &&
    !isTerminalObservedStatus(incoming.subject, incoming.status)
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The replica
// ---------------------------------------------------------------------------------------------

export interface PeerObservationRow {
  peerDomainId: TrustDomainId;
  subject: "target" | "hook_run";
  changeObjectId: string;
  targetObjectId: string | null;
  type: string | null;
  waveIndex: number | null;
  componentObjectId: string | null;
  hookId: string | null;
  hookKind: string | null;
  status: string;
  attempt: number;
  externalUrl: string | null;
  startedAt: Date | null;
  observation: unknown;
  observedAt: Date;
  receivedAt: Date;
}

/** The identity columns of one payload — the tuple the UNIQUE constraint keys on. Derived from the
 *  payload in ONE place so the SELECT, the INSERT and the conflict target cannot disagree. */
function identityOf(payload: WaveTargetObservedPayload): {
  subject: "target" | "hook_run";
  changeObjectId: string;
  targetObjectId: string | null;
  type: string | null;
  hookId: string | null;
  waveIndex: number | null;
} {
  return payload.subject === "target"
    ? {
        subject: "target",
        changeObjectId: payload.changeObjectId,
        targetObjectId: payload.targetObjectId,
        type: payload.type,
        hookId: null,
        waveIndex: payload.waveIndex
      }
    : {
        subject: "hook_run",
        changeObjectId: payload.changeObjectId,
        targetObjectId: payload.targetObjectId,
        type: null,
        hookId: payload.hookId,
        waveIndex: payload.waveIndex
      };
}

/** Matches one identity, spelling NULL as `IS NULL`. A plain `= NULL` finds nothing, which would
 *  make every `postMerge` run look unseen and insert a row per transition — the exact reading
 *  `findHookRun` documents for the same nullable identity parts. */
function identityWhere(
  orgId: string,
  peerDomainId: TrustDomainId,
  identity: ReturnType<typeof identityOf>
) {
  const nullable = (column: unknown, value: string | number | null) =>
    value === null ? sql`${column} IS NULL` : sql`${column} = ${value}`;
  return and(
    eq(federationPeerObservations.orgId, orgId),
    eq(federationPeerObservations.peerDomainId, peerDomainId),
    eq(federationPeerObservations.subject, identity.subject),
    eq(federationPeerObservations.changeObjectId, identity.changeObjectId),
    nullable(federationPeerObservations.targetObjectId, identity.targetObjectId),
    nullable(federationPeerObservations.type, identity.type),
    nullable(federationPeerObservations.hookId, identity.hookId),
    nullable(federationPeerObservations.waveIndex, identity.waveIndex)
  );
}

export type PeerObservationOutcome = "applied" | "ignored_out_of_order";

/**
 * Applies one arriving observation to the local replica.
 *
 * `peerDomainId` is the RECEIVER's finding — `importSyncBundle` passes the domain whose signature
 * the bundle verified against, and nothing in the payload can influence it (the payload carries no
 * provenance field at all; see `WaveTargetObservedPayloadSchema`). `receivedAt` is this instance's
 * clock. Together they are the only two facts on the row a reader may take as this domain's own.
 */
export async function recordPeerObservation(
  tx: TenantTx,
  input: {
    orgId: string;
    peerDomainId: TrustDomainId;
    payload: WaveTargetObservedPayload;
    now?: Date;
  }
): Promise<PeerObservationOutcome> {
  const { orgId, peerDomainId, payload } = input;
  const now = input.now ?? new Date();
  const identity = identityOf(payload);
  const observedAt = new Date(payload.observedAt);

  const [existing] = await tx
    .select({
      status: federationPeerObservations.status,
      observedAt: federationPeerObservations.observedAt
    })
    .from(federationPeerObservations)
    .where(identityWhere(orgId, peerDomainId, identity))
    .limit(1);

  if (
    !shouldApplyPeerObservation(
      existing
        ? { subject: identity.subject, status: existing.status, observedAt: existing.observedAt }
        : undefined,
      { subject: identity.subject, status: payload.status, observedAt }
    )
  ) {
    return "ignored_out_of_order";
  }

  // RE-BOUNDED AT THE RECEIVER. The sender bounds its own payload, and a sender is exactly the
  // party that cannot be relied on to have done so.
  const observation = boundPersistedJson(
    payload.subject === "target" ? { rollout: payload.rollout ?? null } : {}
  ).value;

  const values = {
    id: uuidv7(),
    orgId,
    peerDomainId,
    subject: identity.subject,
    changeObjectId: identity.changeObjectId,
    targetObjectId: identity.targetObjectId,
    type: identity.type,
    waveIndex: identity.waveIndex,
    componentObjectId: payload.subject === "hook_run" ? payload.componentObjectId : null,
    hookId: identity.hookId,
    hookKind: payload.subject === "hook_run" ? payload.kind : null,
    status: payload.status,
    attempt: payload.attempt,
    externalUrl: payload.subject === "hook_run" ? payload.externalUrl : null,
    startedAt: payload.subject === "hook_run" ? new Date(payload.startedAt) : null,
    observation,
    observedAt,
    receivedAt: now
  };

  await tx
    .insert(federationPeerObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [
        federationPeerObservations.orgId,
        federationPeerObservations.peerDomainId,
        federationPeerObservations.subject,
        federationPeerObservations.changeObjectId,
        federationPeerObservations.targetObjectId,
        federationPeerObservations.type,
        federationPeerObservations.hookId,
        federationPeerObservations.waveIndex
      ],
      set: {
        componentObjectId: values.componentObjectId,
        hookKind: values.hookKind,
        status: values.status,
        attempt: values.attempt,
        externalUrl: values.externalUrl,
        startedAt: values.startedAt,
        observation: values.observation,
        observedAt: values.observedAt,
        // `first_seen_at` is deliberately NOT in this set: it dates the first time this domain heard
        // about the subject at all, which is the only way to tell a long-silent peer from a new one.
        receivedAt: values.receivedAt
      }
    });
  return "applied";
}

/** Every peer-reported observation for a set of changes, newest identity first. One indexed read
 *  (`federation_peer_observation_by_change`) for the whole board, not one per row. */
export async function listPeerObservationsForChanges(
  tx: TenantTx,
  orgId: string,
  changeObjectIds: string[]
): Promise<Map<string, PeerObservationRow[]>> {
  const byChange = new Map<string, PeerObservationRow[]>();
  if (changeObjectIds.length === 0) return byChange;
  const rows = await tx
    .select()
    .from(federationPeerObservations)
    .where(
      and(
        eq(federationPeerObservations.orgId, orgId),
        inArray(federationPeerObservations.changeObjectId, changeObjectIds)
      )
    );
  for (const row of rows) {
    const list = byChange.get(row.changeObjectId) ?? [];
    list.push({
      peerDomainId: row.peerDomainId,
      subject: row.subject as "target" | "hook_run",
      changeObjectId: row.changeObjectId,
      targetObjectId: row.targetObjectId,
      type: row.type,
      waveIndex: row.waveIndex,
      componentObjectId: row.componentObjectId,
      hookId: row.hookId,
      hookKind: row.hookKind,
      status: row.status,
      attempt: row.attempt,
      externalUrl: row.externalUrl,
      startedAt: row.startedAt,
      observation: row.observation,
      observedAt: row.observedAt,
      receivedAt: row.receivedAt
    });
    byChange.set(row.changeObjectId, list);
  }
  return byChange;
}

// ---------------------------------------------------------------------------------------------
// Honesty: not reported vs reported stale vs a real reading
// ---------------------------------------------------------------------------------------------

/**
 * THE FRESHNESS BOUND, shared rather than chosen. `OBSERVED_WEIGHT_FRESHNESS_MS` is the same
 * constant `stage-dependency-hold.ts` ages an observed canary weight against before it will let a
 * release proceed on it. A second number here would let a commander call a reading fresh that the
 * hold calls stale, about the same row.
 */
export const PEER_OBSERVATION_FRESHNESS_MS = OBSERVED_WEIGHT_FRESHNESS_MS;

export type PeerObservationFreshness =
  | { state: "fresh"; ageSeconds: number }
  | { state: "stale"; ageSeconds: number; staleAfterSeconds: number };

/**
 * `fresh` or `stale` for a reading this domain HAS. The third case — `not_reported` — is not
 * computed here because it is the absence of a row, and the caller is the only one who can see an
 * absence (`service-board.ts` reports it as `peerObserved: null` plus the `unknownFields` path,
 * which is how this repo has said "not observed here" since the board shipped).
 *
 * Aged against `observedAt`, the peer's own statement of when it looked — not against `receivedAt`.
 * A bundle that sat on a USB stick for a day and arrived a second ago is NOT a fresh reading, and
 * measuring from arrival would claim it was.
 */
export function classifyPeerObservationFreshness(
  observedAt: Date,
  now: Date,
  freshnessMs: number = PEER_OBSERVATION_FRESHNESS_MS
): PeerObservationFreshness {
  const ageMs = Math.max(0, now.getTime() - observedAt.getTime());
  const ageSeconds = Math.floor(ageMs / 1000);
  return ageMs <= freshnessMs
    ? { state: "fresh", ageSeconds }
    : { state: "stale", ageSeconds, staleAfterSeconds: Math.floor(freshnessMs / 1000) };
}

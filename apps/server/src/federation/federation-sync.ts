/**
 * M14.0 — the OUTPOST LIVE-PULL SCHEDULER (docs/proposals/outpost-poke.md §"Milestone scope",
 * ADR-0009; owner full-scope decision 2026-07-24). The deferred federation-over-HTTP live-sync
 * substrate the poke design assumed already existed but did NOT: M6 shipped the FILE transport +
 * the `federation-https` PLUGIN contract, but the SCHEDULED live pull (an outpost dialing its
 * commander over mTLS on an interval to pull+import config-journal segments) and the outbound mTLS
 * cert injection were deferred. M14.0 builds them; the later poke increments (M14.1–M14.4) optimize
 * THIS loop's latency, they do not replace it.
 *
 * ## The reliability model this loop IS (decided — proposal §4, owner 2026-07-18)
 *
 * The poke design's reliability floor is a SPARSE SAFETY-NET reconcile plus PULL-ON-(RE)CONNECT/
 * STARTUP. This loop provides BOTH backstop legs from day one:
 *   - **Pull-on-startup:** the loop's first `boss.send` fires an immediate tick when the loop starts
 *     — a fresh (re)connected process pulls once right away rather than waiting a full interval.
 *   - **Sparse safety-net:** the self-rescheduling interval tick IS the safety net. In poll-mode it
 *     is the (configurable) frequent poll; in poke-mode (M14.4) its FREQUENT leg is disabled while
 *     startup + a sparse interval remain, so a dropped poke self-heals within a bounded window. The
 *     poke becomes a latency optimization over this reliable floor — never a single point of failure.
 *
 * ## Opt-in + role (mirrors `startInboxLoop`/`startObserveLoop` EXACTLY)
 *
 * DEFAULT-OFF: scheduled only when `SCP_FEDERATION_SYNC_LOOP=1` AND the process runs a worker role
 * (`SCP_ROLE=all|worker`, gated in `main.ts` beside the other loops). Without the flag this returns
 * an inert handle and the queue is never created — an unconfigured instance does not spin. Chosen as
 * an env var (not per-peer config) because whether THIS instance runs unattended live-pull is an
 * instance-deployment concern, exactly like `SCP_INBOX_LOOP`. Interval:
 * `SCP_FEDERATION_SYNC_INTERVAL_SECONDS` (default 60s, floor 5s) — a bounded cadence like the
 * observe loop's, NOT the 1s reconcile tick.
 *
 * ## Per tick (per org, then every org — the `runInboxSweep` shape)
 *
 * For each COMMANDER peer with a `baseUrl` (the outpost's record of its commander — what to dial):
 *   1. **Fail-closed mTLS gate (PIECE 1).** If the peer requires mTLS (`https://` baseUrl) and this
 *      instance has no client-cert material, REFUSE the dial — a block Decision + no import, never a
 *      silent plain-HTTP/bearer-only fallback (`federation-outbound.ts`).
 *   2. **Pull.** POST `/federation/exports` with `sinceSequence` = this side's cursor for the peer
 *      (`cursors-repo.ts`), presenting this instance's client cert + the federation bearer.
 *   3. **Import UNCHANGED.** Feed the returned `.scpbundle` VERBATIM to `importSyncBundle` — the
 *      caller-independent fail-closed verification (checksum + Ed25519 signature at the sequence-
 *      anchored key window + hash-chain continuity from the last applied entry) is byte-for-byte the
 *      file/CLI path. Import advances the cursor in the SAME tx as it applies, so the next tick
 *      resumes from exactly what was durably applied — idempotent (a re-pulled bundle re-applies as
 *      a no-op) and resumable.
 *   4. **Fail-closed on a bad bundle.** A 409 from the verify path (tamper/forgery/broken chain)
 *      records a block Decision and the tick CONTINUES to the next peer/org — one bad bundle never
 *      bricks the sweep, and NO existing import verification is weakened.
 *
 * OUT OF SCOPE here (M14.1–M14.4): the `pokeMode` per-outpost flag, the contentless poke endpoint,
 * the commander poke sender, and the scheduler's poke-mode (disable-frequent-leg) behavior. This
 * loop is the reliable floor those optimize.
 */
import { v7 as uuidv7 } from "uuid";
import type PgBoss from "pg-boss";
import type { SyncBundle } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs } from "../db/schema.js";
import { ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { listPeers, type FederationPeerRow } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { importSyncBundle, FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import {
  FederationDialRefused,
  federationPeerRequiresMtls,
  pullSyncBundleFromCommander,
  resolveFederationClientMtls,
  type FederationClientMtls
} from "./federation-outbound.js";

export const FEDERATION_SYNC_QUEUE = "federation-sync-tick";

export const FEDERATION_SYNC_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SCP_FEDERATION_SYNC_INTERVAL_SECONDS ?? 60)
);

/** The explicit operator enable (opt-in — see the module header). */
export function federationSyncLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCP_FEDERATION_SYNC_LOOP === "1";
}

/** The loop's OWN block-verdict kind — written when a dial is refused fail-closed or a pulled bundle
 *  is rejected by the verify path (so an unattended refusal is always explainable, principle 6). */
export const FEDERATION_SYNC_DECISION_KIND = "federation-sync-pull";

/** One commander-peer's terminal outcome for a tick — returned for tests/observability. */
export interface FederationSyncOutcome {
  peerDomainId: string;
  outcome: "imported" | "refused" | "error";
  detail: string;
  decisionId: string | null;
  appliedEntries?: number;
}

export interface FederationSyncOptions {
  /** Test seam / config override; production ticks read the live env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject already-resolved client-cert material instead of reading files from `env`. */
  mtls?: FederationClientMtls | null;
}

/** Records a block Decision + hash-chained audit event for a refused/failed pull, in one tx. */
async function recordSyncBlock(
  db: Db,
  args: { orgId: string; peer: FederationPeerRow; reason: string }
): Promise<string> {
  return withTenantTx(db, args.orgId, async (tx) => {
    const decision = await insertDecision(tx, {
      orgId: args.orgId,
      kind: FEDERATION_SYNC_DECISION_KIND,
      subjectId: args.peer.id,
      verdict: "block",
      inputContext: {
        peerDomainId: args.peer.id,
        peerName: args.peer.name,
        baseUrl: args.peer.baseUrl
      },
      reasonTree: { summary: args.reason }
    });
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.sync.refused",
      subjectId: args.peer.id,
      reason: `federation sync from commander '${args.peer.name}' refused: ${args.reason}`,
      decisionId: decision.id,
      requestId: `federation-sync:${args.peer.id}:${uuidv7()}`
    });
    return decision.id;
  });
}

/** Pull + import from ONE commander peer. Never throws — every outcome (success, fail-closed refusal,
 *  transient error) is returned so the sweep continues to the next peer/org. */
export async function pullFromCommanderPeer(
  db: Db,
  orgId: string,
  selfDomainId: string,
  peer: FederationPeerRow,
  ctx: { bearer?: string; mtls?: FederationClientMtls },
  now: number = Date.now()
): Promise<FederationSyncOutcome> {
  void now;
  if (!peer.baseUrl) {
    return {
      peerDomainId: peer.id,
      outcome: "error",
      detail: "commander peer has no baseUrl configured — nothing to dial (skipped)",
      decisionId: null
    };
  }

  const requireMtls = federationPeerRequiresMtls(peer.baseUrl);
  // Fail-closed gate BEFORE any network I/O: an mTLS-required peer with no client cert is refused
  // with a block Decision, never dialed plain.
  if (requireMtls && !ctx.mtls) {
    const reason =
      `commander '${peer.name}' (${peer.baseUrl}) requires mTLS but this instance has no client-cert ` +
      "material configured (SCP_FEDERATION_MTLS_CERT_FILE / _KEY_FILE) — dial refused fail-closed";
    const decisionId = await recordSyncBlock(db, { orgId, peer, reason });
    return { peerDomainId: peer.id, outcome: "refused", detail: reason, decisionId };
  }

  let bundle: SyncBundle;
  try {
    const cursor = await withTenantTx(db, orgId, (tx) => getCursor(tx, orgId, peer.id, peer.id));
    bundle = await pullSyncBundleFromCommander({
      baseUrl: peer.baseUrl,
      selfDomainId,
      sinceSequence: cursor.sequence,
      bearer: ctx.bearer,
      mtls: ctx.mtls
    });
  } catch (err) {
    if (err instanceof FederationDialRefused) {
      // Belt-and-braces: the pre-flight gate above already refuses this, but if the dialer itself
      // refuses, record it as a block too (never a silent skip).
      const decisionId = await recordSyncBlock(db, { orgId, peer, reason: err.message });
      return { peerDomainId: peer.id, outcome: "refused", detail: err.message, decisionId };
    }
    // A transient dial/HTTP error (commander down, 401, network): NOT a block Decision (nothing was
    // verified-and-rejected) — retried next tick.
    return {
      peerDomainId: peer.id,
      outcome: "error",
      detail: err instanceof Error ? err.message : String(err),
      decisionId: null
    };
  }

  try {
    const result = await withTenantTx(db, orgId, (tx) => importSyncBundle(tx, orgId, bundle));
    return {
      peerDomainId: peer.id,
      outcome: "imported",
      detail: `applied ${result.appliedEntries}, skipped ${result.skippedEntries}, cursor at ${result.lastAppliedSequence}`,
      decisionId: null,
      appliedEntries: result.appliedEntries
    };
  } catch (err) {
    // 409 = the verify path REFUSED (checksum/signature/chain — identical to the file/CLI outcome,
    // carrying its Decision when the path persisted one). Record a block; the sweep continues.
    if (err instanceof ProblemError && err.status === 409) {
      const reason = err.detail ?? err.message;
      const decisionId = err.decisionId ?? (await recordSyncBlock(db, { orgId, peer, reason }));
      return { peerDomainId: peer.id, outcome: "refused", detail: reason, decisionId };
    }
    // Any other error (transient DB, unpaired peer 404, etc.) — retried next tick, no block.
    return {
      peerDomainId: peer.id,
      outcome: "error",
      detail: err instanceof ProblemError ? (err.detail ?? err.message) : String(err),
      decisionId: null
    };
  }
}

/** One org's tick: pull from every commander peer that has a baseUrl. */
export async function federationSyncOrgTick(
  db: Db,
  orgId: string,
  options?: FederationSyncOptions
): Promise<FederationSyncOutcome[]> {
  const env = options?.env ?? process.env;
  const bearer = env.SCP_FEDERATION_SYNC_BEARER || undefined;
  // `mtls: null` in options means "explicitly none" (fail-closed test); undefined means "resolve
  // from env" (production).
  const mtls =
    options?.mtls === null ? undefined : (options?.mtls ?? resolveFederationClientMtls(env));

  const { self, peers } = await withTenantTx(db, orgId, async (tx) => ({
    self: await ensureFederationSelf(tx, orgId),
    peers: await listPeers(tx, orgId)
  }));

  const commanderPeers = peers.filter((p) => p.role === "commander" && p.baseUrl);
  const outcomes: FederationSyncOutcome[] = [];
  for (const peer of commanderPeers) {
    try {
      outcomes.push(await pullFromCommanderPeer(db, orgId, self.domainId, peer, { bearer, mtls }));
    } catch (err) {
      // ONE BAD PEER NEVER BRICKS THE TICK.
      console.error(`[federation-sync] org ${orgId} peer ${peer.id} failed (will retry):`, err);
      outcomes.push({
        peerDomainId: peer.id,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
        decisionId: null
      });
    }
  }
  return outcomes;
}

/** Every org, one tick — mirrors `runInboxSweep`. */
export async function runFederationSyncSweep(
  db: Db,
  options?: FederationSyncOptions
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await federationSyncOrgTick(db, org.id, options);
    } catch (err) {
      console.error(`[federation-sync] org ${org.id} tick failed:`, err);
    }
  }
}

/**
 * M14.2 (ADR-0009) — enqueue ONE immediate federation-sync tick: the contentless poke's "come pull
 * NOW" wake. Sent with NO singleton so it always lands as a fresh immediate job (the poke endpoint's
 * per-peer rate limiter is what bounds it to at most one pull per window — reusing the loop's own
 * throttling `singletonKey` here would let a queued interval tick SWALLOW the wake, defeating it).
 * The pull itself runs on the loop's worker, never inline in the request path.
 *
 * THROWS when the queue does not exist — i.e. the sync loop was never started on this process
 * (`SCP_FEDERATION_SYNC_LOOP` unset, or a pure `role=api` process). The caller treats that as
 * "accepted-but-no-op" (proposal §"Milestone scope"): the poke is still honored, the sparse
 * safety-net + a worker process are the reliability floor.
 */
export async function wakeFederationSyncNow(boss: PgBoss): Promise<void> {
  await boss.send(FEDERATION_SYNC_QUEUE, {});
}

export interface FederationSyncLoopHandle {
  stop(): Promise<void>;
}

/**
 * Self-rescheduling pg-boss loop — the SAME singleton shape as `startInboxLoop`/`startObserveLoop`
 * (a `boss.work` handler that re-`send`s itself with `startAfter` + `singletonKey`). Runs only under
 * `SCP_ROLE=all|worker` (wired in `main.ts`) AND only when the operator explicitly enabled it
 * (`SCP_FEDERATION_SYNC_LOOP=1`) — otherwise an inert handle and the queue is never created.
 *
 * The initial `boss.send(FEDERATION_SYNC_QUEUE, {})` is the PULL-ON-STARTUP backstop leg: a fresh
 * (re)connected worker pulls once immediately rather than waiting a full interval.
 */
export async function startFederationSyncLoop(
  boss: PgBoss,
  db: Db
): Promise<FederationSyncLoopHandle> {
  if (!federationSyncLoopEnabled()) {
    return { async stop() {} };
  }
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(FEDERATION_SYNC_QUEUE);
  await boss.work(FEDERATION_SYNC_QUEUE, async () => {
    if (stopped) return;
    const tick = runFederationSyncSweep(db);
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    await boss.send(
      FEDERATION_SYNC_QUEUE,
      {},
      {
        startAfter: FEDERATION_SYNC_INTERVAL_SECONDS,
        singletonKey: "tick",
        singletonSeconds: FEDERATION_SYNC_INTERVAL_SECONDS
      }
    );
  });
  // PULL-ON-STARTUP: fire the first tick immediately (the reconnect/startup backstop leg).
  await boss.send(FEDERATION_SYNC_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}

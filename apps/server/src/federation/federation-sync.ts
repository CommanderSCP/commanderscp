/** M14.0 — the OUTPOST LIVE-PULL SCHEDULER. See docs/federation.md §162. */
import { v7 as uuidv7 } from "uuid";
import type PgBoss from "pg-boss";
import type { SyncBundle } from "@scp/schemas";
import { JOURNAL_DIVERGENCE_PROBLEM_TYPE } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs } from "../db/schema.js";
import { ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import {
  claimPeerPull,
  listPeers,
  markPeerPullSuccess,
  type FederationPeerRow
} from "./peers-repo.js";
import { getCursor, FEDERATION_DIVERGENCE_DECISION_KIND } from "./cursors-repo.js";
import { importSyncBundle, FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import {
  FederationDialRefused,
  FederationExportRefused,
  federationClientMtlsConfigured,
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

/** M14.4 — the FREQUENT (poll-mode) cadence, resolved from a LIVE env per tick. Same value and
 *  floor as {@link FEDERATION_SYNC_INTERVAL_SECONDS}, which stays as-is for the loop's own
 *  self-reschedule; this function exists because the due-gate must be resolvable per tick (an
 *  import-frozen module const is untestable and cannot follow a re-read config). */
export function frequentIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SCP_FEDERATION_SYNC_INTERVAL_SECONDS ?? 60);
  return Math.max(5, Number.isFinite(raw) ? raw : 60);
}

/** M14.4 — the SPARSE safety-net cadence default (owner decision D1, 2026-07-24): 15 minutes. */
export const FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS = 900;

/** M14.4 — the SPARSE cadence CEILING. See docs/federation.md §163. */
export const FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS = 43_200;

/** The sparse safety-net interval, in seconds. See docs/federation.md §164. */
export function resolveSparseIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(
    env.SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS ??
      FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS
  );
  const value = Number.isFinite(raw) ? raw : FEDERATION_SYNC_SPARSE_INTERVAL_DEFAULT_SECONDS;
  return Math.min(
    FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS,
    Math.max(frequentIntervalSeconds(env), value)
  );
}

/** The explicit operator enable (opt-in — see the module header). */
export function federationSyncLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCP_FEDERATION_SYNC_LOOP === "1";
}

/** Inputs to the per-peer cadence decision — all resolved once per tick by the caller. */
export interface PeerCadenceInputs {
  frequent: number;
  sparse: number;
  /** Does THIS instance actually have outbound client-cert material right now? (owner decision D4) */
  hasClientCerts: boolean;
}

/** The cadence a peer is CURRENTLY on — what the scheduler uses and what `federation status` reports.
 *  `"poke"` means "the frequent poll is disabled for this peer; the sparse safety-net + pokes carry
 *  it". Anything that invalidates poke-mode in practice reports `"poll"`. */
export type PeerSyncCadence = "poke" | "poll";

/** M14.4 — the EFFECTIVE cadence for one peer. See docs/federation.md §165. */
export function peerSyncCadence(
  peer: Pick<
    FederationPeerRow,
    "pokeMode" | "lastPokeReceivedAt" | "lastPullAttemptAt" | "lastPullSuccessAt"
  >,
  inputs: Pick<PeerCadenceInputs, "hasClientCerts">
): PeerSyncCadence {
  if (!peer.pokeMode) return "poll";
  if (!peer.lastPokeReceivedAt) return "poll"; // D2 — never actually poked.
  if (!inputs.hasClientCerts) return "poll"; // D4 — the poke path is dead without certs.
  if (peer.lastPullAttemptAt) {
    const attempt = Date.parse(peer.lastPullAttemptAt);
    const success = peer.lastPullSuccessAt ? Date.parse(peer.lastPullSuccessAt) : null;
    if (success === null || success < attempt) return "poll"; // the reconnect leg.
  }
  return "poke";
}

export function effectivePullIntervalSeconds(
  peer: Parameters<typeof peerSyncCadence>[0],
  inputs: PeerCadenceInputs
): number {
  return peerSyncCadence(peer, inputs) === "poke" ? inputs.sparse : inputs.frequent;
}

/** M14.4 — THE MODE SWITCH, as a pure DB-free predicate. See docs/federation.md §166. */
export function isPeerDue(
  peer: Parameters<typeof peerSyncCadence>[0],
  now: Date,
  inputs: PeerCadenceInputs
): boolean {
  if (!peer.lastPullAttemptAt) return true;
  const intervalMs = effectivePullIntervalSeconds(peer, inputs) * 1000;
  return now.getTime() - Date.parse(peer.lastPullAttemptAt) >= intervalMs;
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
  /** M14.4 (S4) — a FORCED tick. See docs/federation.md §167. */
  force?: boolean;
  /** Test seam — deterministic clock for the due-gate/claim (defaults to `new Date()`). */
  now?: Date;
}

/** The runtime client-cert probe, and why it never throws. See docs/federation.md §168. */
export const FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS = 60 * 60 * 1000;

let lastCertResolveWarning: string | undefined;
let lastCertResolveWarningAt = 0;

function probeRuntimeClientMtls(env: NodeJS.ProcessEnv): {
  mtls: FederationClientMtls | undefined;
  usable: boolean;
} {
  try {
    const mtls = resolveFederationClientMtls(env);
    lastCertResolveWarning = undefined;
    lastCertResolveWarningAt = 0;
    // No material CONFIGURED at all is not a fault — it is the pre-M8 default (bearer-only http
    // peers). It is still "no runtime certs" for D4's purposes.
    return { mtls, usable: Boolean(mtls) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    const isNewFault = detail !== lastCertResolveWarning;
    const isStale = now - lastCertResolveWarningAt >= FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS;
    if (isNewFault || isStale) {
      lastCertResolveWarning = detail;
      lastCertResolveWarningAt = now;
      console.warn(
        "[federation-sync] client-cert material is CONFIGURED but unusable — falling back to the " +
          `FREQUENT poll cadence for every peer (owner decision D4) and continuing to pull: ${detail}`
      );
    }
    return { mtls: undefined, usable: false };
  }
}

/** The same probe, as the single answer to that question. See docs/federation.md §169. */
export function federationClientCertsUsable(env: NodeJS.ProcessEnv = process.env): boolean {
  return probeRuntimeClientMtls(env).usable;
}

/** Test seam: forget the rate-limited warning so a test can assert it is emitted. */
export function resetFederationCertWarningDedupe(): void {
  lastCertResolveWarning = undefined;
  lastCertResolveWarningAt = 0;
}

/** Records a block Decision and audit event in one transaction. See docs/federation.md §170. */
async function recordSyncBlock(
  db: Db,
  args: { orgId: string; peer: FederationPeerRow; reason: string }
): Promise<string> {
  return withTenantTx(db, args.orgId, async (tx) => {
    const recorded = await insertDecisionIfChanged(tx, {
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
    if (!recorded.created) return recorded.decision.id;
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.sync.refused",
      subjectId: args.peer.id,
      reason: `federation sync from commander '${args.peer.name}' refused: ${args.reason}`,
      decisionId: recorded.decision.id,
      requestId: `federation-sync:${args.peer.id}:${uuidv7()}`
    });
    return recorded.decision.id;
  });
}

/** Records a standing importer-side journal divergence. See docs/federation.md §171. */
async function recordImportDivergence(
  db: Db,
  args: { orgId: string; peer: FederationPeerRow; reason: string }
): Promise<string> {
  return withTenantTx(db, args.orgId, async (tx) => {
    const recorded = await insertDecisionIfChanged(tx, {
      orgId: args.orgId,
      kind: FEDERATION_DIVERGENCE_DECISION_KIND,
      subjectId: args.peer.id,
      verdict: "block",
      inputContext: { peerDomainId: args.peer.id, peerName: args.peer.name },
      reasonTree: { summary: "journal divergence standing with this peer — resync required (§7.2)" }
    });
    if (!recorded.created) return recorded.decision.id;
    await appendAuditEvent(tx, {
      orgId: args.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.divergence.detected",
      subjectId: args.peer.id,
      reason: `journal divergence with peer '${args.peer.name}': ${args.reason}`,
      decisionId: recorded.decision.id,
      requestId: `federation-divergence:${args.peer.id}:${uuidv7()}`
    });
    return recorded.decision.id;
  });
}

/** Pull + import from ONE commander peer. Never throws — every outcome (success, fail-closed refusal,
 *  transient error) is returned so the sweep continues to the next peer/org. */
export async function pullFromCommanderPeer(
  db: Db,
  orgId: string,
  selfDomainId: string,
  peer: FederationPeerRow,
  ctx: { bearer?: string; mtls?: FederationClientMtls }
): Promise<FederationSyncOutcome> {
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
      // RAIL 2 (§7.2): send the applied-row anchor ONLY as a full-scope receiver holding a real
      // anchor. A sparse receiver's `cursor.rowHash` is null and it deliberately omits it (it never
      // held the tail entry's hash), so the exporter runs rail 2 only where an anchor exists.
      ...(peer.syncScope.mode === "full" && cursor.rowHash !== null
        ? { lastAppliedRowHash: cursor.rowHash }
        : {}),
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
    if (err instanceof FederationExportRefused && err.type === JOURNAL_DIVERGENCE_PROBLEM_TYPE) {
      // RAILS 1/2 (§7.2), the puller's half of "both sides record": the exporter verified a
      // fork/rollback and refused. This is a STANDING condition (the puller's cursor cannot advance
      // until a resync), not a transient failure — persist-on-change block under the DIVERGENCE kind
      // so rail 5 can key off it, exactly as the exporter recorded on its side.
      const decisionId = await recordImportDivergence(db, {
        orgId,
        peer,
        reason: `commander refused as journal_divergence: ${err.detail}`
      });
      return { peerDomainId: peer.id, outcome: "refused", detail: err.detail, decisionId };
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
    // THE one caller that is a live pull — the sole writer of `transport: 'live-pull'`.
    const result = await withTenantTx(db, orgId, (tx) =>
      importSyncBundle(tx, orgId, bundle, "live-pull")
    );
    return {
      peerDomainId: peer.id,
      outcome: "imported",
      detail: `applied ${result.appliedEntries}, skipped ${result.skippedEntries}, cursor at ${result.lastAppliedSequence}`,
      decisionId: null,
      appliedEntries: result.appliedEntries
    };
  } catch (err) {
    // 409 = the verify path REFUSED. See docs/federation.md §172.
    if (err instanceof ProblemError && err.status === 409) {
      const reason = err.detail ?? err.message;
      // RAIL 4 (§7.2): an import refused for a signed-tail-attestation regression/fork is a STANDING
      // divergence — record it under the divergence kind (rail 5's signal), not the generic sync
      // kind. Every OTHER 409 (checksum/signature/chain) stays a plain sync block.
      const decisionId =
        err.type === JOURNAL_DIVERGENCE_PROBLEM_TYPE
          ? await recordImportDivergence(db, { orgId, peer, reason })
          : (err.decisionId ?? (await recordSyncBlock(db, { orgId, peer, reason })));
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

/** One org's tick. See docs/federation.md §173. */
export async function federationSyncOrgTick(
  db: Db,
  orgId: string,
  options?: FederationSyncOptions
): Promise<FederationSyncOutcome[]> {
  const env = options?.env ?? process.env;
  const bearer = env.SCP_FEDERATION_SYNC_BEARER || undefined;
  // `mtls: null` in options means "explicitly none" (fail-closed test); an injected value is used
  // as-is; undefined means "resolve from env" (production) — through the NEVER-THROWING probe, so a
  // rotated-away secret degrades the cadence instead of killing the tick (see
  // {@link probeRuntimeClientMtls}, owner decision D4).
  let mtls: FederationClientMtls | undefined;
  let certMaterialUsable: boolean;
  if (options?.mtls === null) {
    mtls = undefined;
    certMaterialUsable = federationClientMtlsConfigured(env);
  } else if (options?.mtls) {
    mtls = options.mtls;
    certMaterialUsable = true;
  } else {
    const probed = probeRuntimeClientMtls(env);
    mtls = probed.mtls;
    certMaterialUsable = probed.usable;
  }
  // Resolved PER TICK from the live env (never an import-frozen module const).
  const cadence: PeerCadenceInputs = {
    frequent: frequentIntervalSeconds(env),
    sparse: resolveSparseIntervalSeconds(env),
    // D4: the RUNTIME question, not the pair-time one — injected material counts, and so does
    // material that actually READ off disk; neither ⇒ the poke path is dead ⇒ frequent cadence.
    hasClientCerts: certMaterialUsable
  };
  const now = options?.now ?? new Date();
  const force = options?.force === true;

  const { self, peers } = await withTenantTx(db, orgId, async (tx) => ({
    self: await ensureFederationSelf(tx, orgId),
    peers: await listPeers(tx, orgId)
  }));

  const commanderPeers = peers.filter((p) => p.role === "commander" && p.baseUrl);
  const outcomes: FederationSyncOutcome[] = [];
  for (const peer of commanderPeers) {
    try {
      // THE DUE-GATE + THE CLAIM. The pure predicate decides; the conditional UPDATE enforces it
      // atomically (and stamps the attempt) so concurrent replicas cannot double-pull. A forced
      // (poke) tick skips the predicate AND the window predicate in the claim, but still stamps.
      if (!force && !isPeerDue(peer, now, cadence)) continue;
      const claimed = await withTenantTx(db, orgId, (tx) =>
        claimPeerPull(tx, orgId, peer.id, {
          now,
          intervalSeconds: effectivePullIntervalSeconds(peer, cadence),
          force
        })
      );
      if (!claimed) continue; // another replica already took this peer's slot this window.

      const outcome = await pullFromCommanderPeer(db, orgId, self.domainId, peer, { bearer, mtls });
      // Only a real import re-arms the sparse cadence; a refusal/error deliberately leaves
      // `lastPullSuccessAt` behind `lastPullAttemptAt`, which is the reconnect leg (S5).
      if (outcome.outcome === "imported") {
        await withTenantTx(db, orgId, (tx) => markPeerPullSuccess(tx, orgId, peer.id, now));
      }
      outcomes.push(outcome);
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

/** Every org, one tick. See docs/federation.md §174. */
export async function runFederationSyncSweep(
  db: Db,
  options?: FederationSyncOptions & { orgId?: string }
): Promise<void> {
  const orgRows = options?.orgId
    ? [{ id: options.orgId }]
    : await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await federationSyncOrgTick(db, org.id, options);
    } catch (err) {
      console.error(`[federation-sync] org ${org.id} tick failed:`, err);
    }
  }
}

/** Enqueues one immediate federation-sync tick. See docs/federation.md §175. */
export async function wakeFederationSyncNow(boss: PgBoss, orgId?: string): Promise<void> {
  await boss.send(FEDERATION_SYNC_QUEUE, {
    reason: FEDERATION_SYNC_POKE_REASON,
    ...(orgId ? { orgId } : {})
  });
}

/** The `reason` a tick carries. See docs/federation.md §176. */
export const FEDERATION_SYNC_POKE_REASON = "poke";

/** The reconnect tick's reason, and why it is not empty. See docs/federation.md §177. */
export const FEDERATION_SYNC_STARTUP_REASON = "startup";

/** RETIRED (M26, §4-A4's second correction). See docs/federation.md §178. */

/** The wake payload a tick carries (see {@link FEDERATION_SYNC_POKE_REASON}). */
export interface FederationSyncJobData {
  reason?: string;
  orgId?: string;
}

export interface FederationSyncLoopHandle {
  stop(): Promise<void>;
}

/** Self-rescheduling pg-boss loop. See docs/federation.md §179. */
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
  await boss.work(FEDERATION_SYNC_QUEUE, async (jobs: { data?: FederationSyncJobData }[]) => {
    if (stopped) return;
    // TWO INDEPENDENT FLAGS. See docs/federation.md §180.
    const batch = jobs ?? [];
    const pokeJobs = batch.filter((job) => job.data?.reason === FEDERATION_SYNC_POKE_REASON);
    const startupJobs = batch.filter((job) => job.data?.reason === FEDERATION_SYNC_STARTUP_REASON);
    const intervalJobs = batch.filter(
      (job) =>
        job.data?.reason !== FEDERATION_SYNC_POKE_REASON &&
        job.data?.reason !== FEDERATION_SYNC_STARTUP_REASON
    );
    // An empty batch (defensive) is treated as an interval tick so the chain can never stall.
    const reschedule = batch.length === 0 || startupJobs.length > 0 || intervalJobs.length > 0;
    const orgIds = [...new Set(pokeJobs.map((job) => job.data?.orgId).filter(Boolean))] as string[];

    const run = async (): Promise<void> => {
      // A startup/reconnect tick FORCES EVERY org: the process just (re)connected and has no idea
      // which peers went stale while it was down. This subsumes any interval/poke job in the batch.
      if (startupJobs.length > 0) {
        await runFederationSyncSweep(db, { force: true });
        return;
      }
      if (pokeJobs.length > 0) {
        // A poke names its own org; a poke with no org (an older/unknown payload) forces every org.
        if (orgIds.length === 0) {
          await runFederationSyncSweep(db, { force: true });
        } else {
          for (const orgId of orgIds) {
            await runFederationSyncSweep(db, { force: true, orgId });
          }
        }
      }
      // A plain interval tick still runs its own DUE-GATED all-org sweep (and is the only work an
      // ordinary tick does).
      if (intervalJobs.length > 0 || batch.length === 0) {
        await runFederationSyncSweep(db);
      }
    };
    const tick = run();
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    if (!reschedule) return;
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
  // PULL-ON-(RE)CONNECT: fire the first tick immediately, FORCED. See docs/federation.md §181.
  await boss.send(FEDERATION_SYNC_QUEUE, { reason: FEDERATION_SYNC_STARTUP_REASON });
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}

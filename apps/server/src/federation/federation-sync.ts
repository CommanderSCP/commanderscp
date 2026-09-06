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
 *   - **Pull-on-(re)connect:** the loop's first `boss.send` fires an immediate FORCED tick when the
 *     loop starts (`reason: "startup"`) — a fresh (re)connected process pulls every peer right away
 *     rather than waiting a full interval. It must FORCE past the M14.4 due-gate because that gate's
 *     state (`last_pull_attempt_at`) is a DB column that SURVIVES the restart.
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
 * ## M14.4 — SCHEDULER MODE (the disable-the-frequent-leg half; owner decisions D1–D4, 2026-07-24)
 *
 * The tick now runs a PER-PEER DUE-GATE before pulling, so poke-mode really does disable the
 * frequent poll rather than merely decorating it:
 *   - {@link resolveSparseIntervalSeconds} (D1) — the sparse cadence, an INSTANCE env var
 *     (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900s), resolved PER TICK.
 *   - {@link peerSyncCadence} / {@link isPeerDue} — the pure decision. A peer goes sparse only when
 *     it is pokeMode AND has ACTUALLY been poked (D2, self-proving) AND this instance has runtime
 *     client-cert material (D4) AND its last pull succeeded (the reconnect leg). Anything else keeps
 *     the frequent poll — a one-sided misconfiguration costs nothing but the polling it already did.
 *   - `claimPeerPull` (peers-repo) — an ATOMIC conditional UPDATE, so N worker replicas still make
 *     at most one pull per peer per window (an in-memory throttle would multiply the effective rate
 *     by the replica count and defeat "sparse" entirely).
 *   - {@link wakeFederationSyncNow} + the handler's `force` path — a poke BYPASSES the due-gate and
 *     does NOT re-schedule. Without that bypass the poke would be swallowed by the very gate it
 *     complements ("this peer isn't due for another 14 minutes") and pull nothing.
 *
 * ### FORCE and RESCHEDULE are TWO INDEPENDENT FLAGS (not one boolean)
 *
 * The due-gate has two distinct kinds of tick that must bypass it, and they differ in the OTHER
 * axis — whether the tick owes the loop a re-schedule:
 *
 * | tick             | `reason`    | forces past the due-gate | re-schedules the interval chain |
 * |------------------|-------------|--------------------------|---------------------------------|
 * | interval         | (none)      | no                       | YES                             |
 * | pull-on-(re)connect | `startup` | YES                    | YES — it BOOTSTRAPS the chain   |
 * | poke             | `poke`      | YES                      | no — it rides ALONGSIDE the chain |
 *
 * The STARTUP tick must force. `last_pull_attempt_at` is a DB COLUMN, so it SURVIVES a process
 * restart: a peer that pulled two minutes before a rolling upgrade / OOM kill / node drain comes
 * back NON-NULL and NOT due, and a non-forcing startup tick would pull NOTHING — the outpost then
 * stays stale for the remainder of the sparse window. Pull-on-(re)connect is an explicit leg of the
 * decided reliability floor (proposal §4); poke-mode must not weaken it.
 *
 * But it must ALSO re-schedule: the startup tick is the tick that STARTS the self-rescheduling
 * chain. Collapsing the two flags into one boolean breaks one of them — "forced ⇒ no re-schedule"
 * kills the loop outright, "forced ⇒ re-schedule" reintroduces the duplicate interval jobs the poke
 * path deliberately avoids.
 *
 * Still out of scope here: the `pokeMode` flag itself (M14.1, peers-repo), the contentless poke
 * endpoint (M14.2, routes/federation.ts) and the commander poke sender (M14.3, poke-sender.ts).
 */
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

/** M14.4 — the SPARSE cadence CEILING: 12 hours. See docs/federation/federation-sync.md §1. */
export const FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS = 43_200;

/**
 * M14.4 (owner decision D1) — the SPARSE safety-net interval, in seconds, resolved from `env`.
 *
 * An INSTANCE-level env var (`SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS`, default 900) and
 * deliberately NOT a per-peer column: a per-peer value on the commander's row would let a COMMANDER
 * operator dictate a downstream instance's own polling cadence — a policy inversion — and would drag
 * a tuning knob through the whole schema→API→SDK→CLI→UI parity chain for no gain. How often THIS
 * instance reconciles is an instance-deployment concern, exactly like `SCP_FEDERATION_SYNC_LOOP`.
 *
 * Clamped into `[frequentIntervalSeconds(env), 43200]`: a sparse interval BELOW the frequent one is
 * meaningless (it would make "sparse" denser than "frequent"), and the ceiling is pg-boss's
 * archive-window assertion (see {@link FEDERATION_SYNC_SPARSE_INTERVAL_MAX_SECONDS}).
 *
 * PURE and resolved PER TICK — never an import-frozen module const.
 */
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

/** M14.4 — the EFFECTIVE cadence for one peer. See docs/federation/federation-sync.md §2. */
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

/**
 * M14.4 — THE MODE SWITCH, as a pure DB-free predicate: is this peer due for a pull at `now`?
 *
 * `true` when the peer has never been attempted (`lastPullAttemptAt === null` — deliberately "due
 * now", so every pre-M14.4 row survives the gate untouched and drizzle/0038 needs no backfill; note
 * this does NOT cover pull-on-(re)connect, since the column survives a restart — that leg FORCES,
 * see {@link FEDERATION_SYNC_STARTUP_REASON}) or when its
 * {@link effectivePullIntervalSeconds} has elapsed since the last attempt. The scheduler re-checks
 * the same condition inside an atomic conditional UPDATE (`claimPeerPull`) so the decision is also
 * safe across worker replicas; this predicate exists so the truth table itself is unit-testable
 * without a database.
 */
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
  /**
   * M14.4 (S4) — a FORCED tick: pull every peer of the org REGARDLESS of the due-gate. Set by the
   * poke wake (`reason: "poke"`). Without this the poke would be swallowed by the very feature it
   * complements: the due-gate would answer "this peer isn't due for another 14 minutes" and pull
   * NOTHING, leaving pokes decorative while nearly every test stayed green.
   */
  force?: boolean;
  /** Test seam — deterministic clock for the due-gate/claim (defaults to `new Date()`). */
  now?: Date;
}

/**
 * M14.4 (owner decision D4) — the RUNTIME client-cert probe, and the reason it never throws.
 *
 * {@link resolveFederationClientMtls} throws in TWO situations: a HALF-configured cert/key pair, and
 * `readFileSync` failing on a configured-but-missing/unreadable file (a rotated-away or unmounted
 * secret — `SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE` still set, the file gone). Calling it
 * unguarded from the tick made that throw escape into `runFederationSyncSweep`'s per-org catch,
 * where it was logged as "org <id> tick failed" and NO peer was pulled at ANY cadence —
 * `last_pull_attempt_at` never advanced again. That is strictly worse than the decided behaviour.
 *
 * D4 decided the opposite: "refuse to go sparse without runtime client-cert material — mirroring
 * the M14.3 sender's inert-without-certs rule, so BOTH HALVES of poke-mode fail the same way." The
 * sender going inert is harmless; the scheduler going DEAD is not. So a throw here degrades to
 * `hasClientCerts: false` — the peer drops back to the FREQUENT cadence and KEEPS BEING PULLED (an
 * https peer's pull is then refused fail-closed with its own block Decision, exactly as designed;
 * an http peer's pull still succeeds). Never a dead tick.
 *
 * The cause is a real operational fault, so it is surfaced at WARN — but RATE-LIMITED, because this
 * runs on every tick of every org and an unfixed missing secret would otherwise emit a log line a
 * minute forever. Rate-limited is NOT once-ever: a long-lived worker that emitted its single line
 * hours ago would leave an operator investigating a sparse-vs-frequent divergence today with nothing
 * to find in the log window they are actually looking at. So the same message re-fires once per
 * {@link FEDERATION_CERT_WARNING_REWARN_INTERVAL_MS} for as long as the fault persists, and a
 * successful resolve clears the suppression so a recurrence warns immediately.
 */
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

/**
 * M14.4 fix (N5) — the SAME runtime probe, exposed as the single answer to "does this instance have
 * usable outbound client-cert material RIGHT NOW?".
 *
 * `GET /federation/status` reports `effectiveCadence` — the cadence the scheduler is ACTUALLY
 * running each peer at — and that endpoint exists precisely so an operator can SEE a
 * sparse-vs-frequent divergence. Computing it from the cheap presence check
 * ({@link federationClientMtlsConfigured}, paths set?) made status and scheduler disagree in exactly
 * the case D4 exists for: paths still set, the mounted secret rotated away. The scheduler falls back
 * to the frequent cadence (and warns); the presence check says "configured", so status would have
 * reported `poke` for a peer being polled every minute. Both sides now call THIS, so they agree by
 * construction rather than by coincidence.
 *
 * Never throws (see above), and the file reads are two small secrets — cheap enough for a per-request
 * status call, and deliberately NOT cached, since the whole point is that the answer changes when the
 * file underneath changes.
 */
export function federationClientCertsUsable(env: NodeJS.ProcessEnv = process.env): boolean {
  return probeRuntimeClientMtls(env).usable;
}

/** Test seam: forget the rate-limited warning so a test can assert it is emitted. */
export function resetFederationCertWarningDedupe(): void {
  lastCertResolveWarning = undefined;
  lastCertResolveWarningAt = 0;
}

/**
 * Records a block Decision + hash-chained audit event for a refused/failed pull, in one tx.
 *
 * PERSIST-ON-CHANGE (`coordination/decisions-repo.ts`'s `insertDecisionIfChanged`): every refusal
 * reachable from here is a STANDING condition, not an event — an mTLS-required peer with no
 * client-cert material configured, or a dialer that refuses that peer — and nothing anywhere marks
 * the peer "already refused". The sweep re-attempts it on the default 60 s cadence, so before this
 * guard a single misconfigured peer appended 1,440 identical Decisions AND 1,440 identical
 * hash-chained audit events per day, indefinitely. The re-attempt is deliberately unchanged: it is
 * how a rotated-in cert or a repaired peer is noticed, and the FIRST refusal — plus the first
 * refusal with any DIFFERENT reason — is still fully recorded and audited.
 *
 * The audit event is suppressed on exactly the same condition as the Decision, never independently:
 * appending a `federation.sync.refused` event for a tick where nothing changed would make the
 * hash-chain assert an occurrence that did not occur (and `scp audit verify` cannot be repaired
 * afterwards by deleting rows). Same pairing `coordination/pre-deploy-gate.ts`'s idempotent pass
 * path uses.
 *
 * Returns the standing Decision's id either way — a suppressed restatement still hands the caller a
 * resolvable `decision_id` for the peer's `refused` outcome (charter principle 6), never null.
 */
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

/**
 * Records a STANDING importer-side journal divergence with a peer (rails 1/2/4, §7.2), under the
 * dedicated `federation-divergence` kind so RAIL 5 (`permitCursorReanchor`) can find it precisely.
 * Same persist-on-change + paired-audit discipline as `recordSyncBlock` (one row per stuck peer, not
 * one per 60s retry). The block STANDS until the resync operation (§7.2.6) supersedes it — which is
 * why the reason is kept stable and the live divergence detail rides only on the refusal, not here.
 */
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
    // 409 = the verify path REFUSED (checksum/signature/chain — identical to the file/CLI outcome,
    // carrying its Decision when the path persisted one). Record a block; the sweep continues.
    //
    // THIS IS THE LIVE-PULL SURFACE for `verifySegment`'s contiguity diagnostic: a pull never
    // reaches an operator's terminal, so `err.detail` — which for a chain break is the full
    // "compare `scp federation peers` on BOTH domains" guidance rather than a tampering alarm — is
    // what lands in the peer's `refused` outcome AND, verbatim, in the block Decision's reason.
    // Nothing here may summarise or truncate it.
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

/**
 * One org's tick: pull from every commander peer that has a baseUrl AND is DUE.
 *
 * M14.4 adds the per-peer due-gate between "which peers could I pull" and "pull it": a poll-mode
 * peer is due once per FREQUENT interval, a proven poke-mode peer only once per SPARSE interval —
 * so poke-mode really does disable the frequent poll instead of merely decorating it. The gate is
 * enforced by an ATOMIC conditional claim (`claimPeerPull`), never an in-memory map, so N worker
 * replicas still produce at most one pull per peer per window. A FORCED tick (`options.force`, the
 * poke wake) bypasses the window entirely — see {@link FederationSyncOptions.force}.
 */
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

/**
 * Every org, one tick — mirrors `runInboxSweep`. M14.4: `options.orgId` narrows the sweep to ONE
 * org (the poke wake, whose org comes from the CALLER'S OWN AUTHENTICATED identity — never from a
 * request body, so the poke stays contentless and one tenant's poke can never re-time another
 * tenant's peers).
 */
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
 *
 * M14.4 (S4) — the wake now carries `{ reason: "poke", orgId }`. WHY: with the M14.4 due-gate in
 * place, a wake indistinguishable from an interval tick would be gated by that very due-gate ("this
 * peer isn't due for another 14 minutes") and pull NOTHING — the poke silently swallowed by the
 * feature it complements. `reason: "poke"` makes the handler run a FORCED tick. The `orgId` is
 * derived from the CALLER'S OWN AUTHENTICATED org at the route (`auth.orgId`), NEVER from the
 * request body — the poke stays CONTENTLESS, and one tenant's poke cannot re-time another tenant's
 * peers.
 */
export async function wakeFederationSyncNow(boss: PgBoss, orgId?: string): Promise<void> {
  await boss.send(FEDERATION_SYNC_QUEUE, {
    reason: FEDERATION_SYNC_POKE_REASON,
    ...(orgId ? { orgId } : {})
  });
}

/** The `reason` a tick carries. See docs/federation/federation-sync.md §3. */
export const FEDERATION_SYNC_POKE_REASON = "poke";

/**
 * M14.4 fix — the pull-on-(re)connect tick's `reason`, and why it is not just `{}`.
 *
 * The startup tick used to send `{}`, which made it an ordinary NON-forced tick, on the assumption
 * that "a NULL `last_pull_attempt_at` reads as due, so pull-on-startup survives the due-gate". That
 * assumption is FALSE after the first ever pull: `last_pull_attempt_at` is a DB column and SURVIVES
 * the restart. A proven poke-mode peer whose last pull succeeded two minutes before a worker
 * restart is NOT due, so the startup sweep pulled nothing and the outpost stayed stale for the rest
 * of the sparse window. `reason: "startup"` forces past the gate — restoring the pull-on-(re)connect
 * leg of the decided reliability floor, which poke-mode must not weaken.
 */
export const FEDERATION_SYNC_STARTUP_REASON = "startup";

/**
 * RETIRED (M26, §4-A4's second correction) — this used to be `= 10`, the startup send's own singleton
 * window. It is gone rather than re-tuned, and the reasoning is worth keeping because it was subtle
 * enough to be got wrong twice:
 *
 * The original note correctly established that the chain's `"tick"` key was off limits (a pending
 * interval tick would swallow a startup send filed under it), and concluded that a DISTINCT key with
 * a short window was therefore safe. It is not. `job_i4` counts jobs in every state except
 * `cancelled`, so the slot is held by a COMPLETED job too — which means the thing a restart most
 * reliably collides with is *its own previous boot*, the one case a "restart storm" window is least
 * able to distinguish from the storm it was meant to collapse. There is no window size that separates
 * them: shrink it and simultaneous replicas stop deduping, grow it and restarts get swallowed for
 * longer.
 *
 * The startup send is now UNKEYED (`LOOP_STARTUP_SEND_IS_UNKEYED`, events/pgboss.ts), like every other
 * loop's. Note that simply dropping `singletonSeconds` while keeping the key would NOT have worked
 * either — it only makes the key inert (job_i4 requires `singleton_on IS NOT NULL`), leaving code that
 * reads as if it dedupes while doing nothing at all.
 */

/** The wake payload a tick carries (see {@link FEDERATION_SYNC_POKE_REASON}). */
export interface FederationSyncJobData {
  reason?: string;
  orgId?: string;
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
 * The initial `boss.send(FEDERATION_SYNC_QUEUE, { reason: "startup" })` is the PULL-ON-(RE)CONNECT
 * backstop leg: a fresh (re)connected worker pulls once immediately — FORCED past the due-gate,
 * because the gate's state lives in a DB column that survives the restart (see
 * {@link FEDERATION_SYNC_STARTUP_REASON}) — rather than waiting a full interval.
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
  await boss.work(FEDERATION_SYNC_QUEUE, async (jobs: { data?: FederationSyncJobData }[]) => {
    if (stopped) return;
    // TWO INDEPENDENT FLAGS. See docs/federation/federation-sync.md §4.
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
  // PULL-ON-(RE)CONNECT: fire the first tick immediately, FORCED (see the constant's doc) — and it
  // is this tick that bootstraps the self-rescheduling interval chain. SENT UNKEYED, so it ALWAYS
  // inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).
  //
  // This send used to carry its own `"startup"` key with a 10s window, on the reasoning that N
  // replicas restarting together should dedupe their startup pulls among themselves while staying
  // off the chain's `"tick"` key. That reasoning was half right — `"tick"` is indeed off limits —
  // and half fatal: job_i4 counts COMPLETED jobs as holding the slot, so a worker that bounced
  // inside its own 10s window had its startup send silently dropped and came back with the
  // pull-on-(re)connect leg missing. Losing that leg is invisible: the loop still ticks on its
  // interval, so nothing errors and nothing alerts — the outpost is just stale for a whole window,
  // which is exactly the reliability floor this send exists to hold up.
  //
  // The dedupe is deliberately given up rather than re-tuned, because no window size fixes it: any
  // (key, bucket) pair a restart can share with its own previous boot can swallow it. Redundant
  // startup pulls are merely wasteful — the tick claims work per peer, and imports advance a
  // forward-only cursor, so a duplicate pull converges instead of corrupting.
  await boss.send(FEDERATION_SYNC_QUEUE, { reason: FEDERATION_SYNC_STARTUP_REASON });
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}

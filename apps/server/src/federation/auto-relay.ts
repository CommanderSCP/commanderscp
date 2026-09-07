/** M13.1b — the staging node's AUTO-RELAY. See docs/federation.md §36. */
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs } from "../db/schema.js";
import { describeError, ProblemError } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { listPeers } from "./peers-repo.js";
import { resolveOnwardDeliveryDir } from "./delivery-target.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import {
  backoffRelayBuild,
  claimRelayBuild,
  completeRelayBuild,
  exhaustRelayBuild,
  listDueRelayBuilds,
  type RelayBuildClaim
} from "./relay-builds-repo.js";
import { buildRelayTarball, relayConfigFromEnv, type RelayConfig } from "./retrans-relay.js";

export const AUTO_RELAY_QUEUE = "federation-auto-relay-tick";

/** The loop's OWN verdict kind — written ONLY when the verdict budget is exhausted. Every
 *  per-attempt verdict before it is `buildRelayTarball`'s own `retrans-relay-validate` Decision,
 *  identical to the manual path's. */
export const AUTO_RELAY_DECISION_KIND = "retrans-auto-relay";

/** The explicit operator enable. Default OFF (see the module header's opt-in section). */
export function autoRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCP_RETRANS_AUTO_RELAY === "1";
}

/** Interval floor between sweeps (`SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS`, default 60, floor 5) —
 *  resolved from the LIVE env per tick, never an import-frozen const (the M14.4 rule). */
export function autoRelayIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS ?? 60);
  return Math.max(5, Number.isFinite(raw) ? raw : 60);
}

/** How many VERDICT-producing failures a change gets before it goes TERMINAL `exhausted`
 *  (`SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS`, default 5, clamped to [1, 20]). Claims that never reach
 *  a verdict (an evicted worker) do not count — see `relay-builds-repo.ts`'s two counters. */
export function autoRelayMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS ?? 5);
  if (!Number.isFinite(raw)) return 5;
  return Math.min(20, Math.max(1, Math.floor(raw)));
}

/** The CLAIM LEASE. See docs/federation.md §37. */
export function autoRelayLeaseSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS ?? 3600);
  if (!Number.isFinite(raw)) return 3600;
  return Math.min(86400, Math.max(60, Math.floor(raw)));
}

/** Exponential backoff before the NEXT attempt, keyed on verdicts so far: 60s, 120s, 240s, … capped
 *  at 1 h. A flapping source registry is retried promptly; a broken one is not hammered. */
export function autoRelayBackoffSeconds(failedAttempts: number): number {
  const exponent = Math.max(0, Math.min(6, failedAttempts - 1));
  return Math.min(3600, 60 * 2 ** exponent);
}

/** Per-org, per-tick batch cap. Deliberately small — each item can pull GBs through skopeo. Nothing
 *  starves: rows are ordered oldest-seed-first and the leftovers are the next tick's oldest. */
export const AUTO_RELAY_BATCH_LIMIT = 5;

/** One change's outcome for this sweep — returned for tests/observability, never persisted. */
export interface AutoRelayOutcome {
  changeObjectId: string;
  outcome:
    | "built" // the signed tarball was produced and dropped for the onward hop.
    | "refused" // this attempt refused (block Decision); retried until the verdict cap.
    | "exhausted" // TERMINAL: the verdict cap was reached.
    | "claimed-elsewhere" // another worker holds the lease, or the row went terminal meanwhile.
    | "lease-lost" // this worker's lease lapsed mid-build; another worker owns the outcome.
    | "bookkeeping-failed" // THE BYTES CROSSED but the ledger write did not land — never a verdict.
    | "deferred" // a config gap — no attempt burned, retried next tick.
    | "disabled";
  detail: string;
  decisionId: string | null;
  tarballPath?: string;
}

export interface AutoRelaySweepOptions {
  /** Test seam / config override; production ticks read the live env (`relayConfigFromEnv`). */
  relayConfig?: RelayConfig;
  /** Test seam: env used for the enable/cap/lease knobs (production reads `process.env`). */
  env?: NodeJS.ProcessEnv;
}

// Terminal bookkeeping — every write FENCED on the claim (see relay-builds-repo.ts's rule 1).

/** One failed attempt. See docs/federation.md §38. */
async function finalizeFailure(
  db: Db,
  orgId: string,
  claim: RelayBuildClaim,
  args: {
    maxAttempts: number;
    reason: string;
    decisionId: string | null;
    /** Skip the remaining budget: the failure is DETERMINISTIC (a 400 — "no verified manifest",
     *  "empty authorized set"), so four more identical attempts would only cost four more permanent
     *  Decision + audit rows to reach the same answer. Kept as its own flag rather than shrinking
     *  `maxAttempts`, so the Decision records the operator's real configured cap. */
    exhaustNow?: boolean;
  }
): Promise<AutoRelayOutcome> {
  const verdicts = claim.failedAttempts + 1;
  if (!args.exhaustNow && verdicts < args.maxAttempts) {
    const backoffSeconds = autoRelayBackoffSeconds(verdicts);
    const held = await withTenantTx(db, orgId, (tx) =>
      backoffRelayBuild(tx, orgId, claim, {
        backoffSeconds,
        reason: args.reason,
        decisionId: args.decisionId
      })
    );
    if (!held) return leaseLost(orgId, claim);
    console.error(
      `[auto-relay] org ${orgId}: change ${claim.changeObjectId} attempt ${verdicts}/` +
        `${args.maxAttempts} failed, retrying in ${backoffSeconds}s: ${args.reason}`
    );
    return {
      changeObjectId: claim.changeObjectId,
      outcome: "refused",
      detail: args.reason,
      decisionId: args.decisionId
    };
  }

  const summary =
    `auto-relay gave up after ${verdicts} failed attempt(s)` +
    (args.exhaustNow
      ? ` (the failure is deterministic — retrying the remaining ${args.maxAttempts - verdicts} ` +
        `attempt(s) of the configured budget would reach the same answer)`
      : "") +
    ` — the onward byte tarball for this promotion was NOT built and nothing crossed the ` +
    `boundary. Last failure: ${args.reason}. ` +
    `Fix the cause and re-drive the hop with 'scp federation relay --change ` +
    `${claim.changeObjectId}': a successful manual build delivers the bytes AND clears this state. ` +
    `This change will not be retried automatically.`;
  const decisionId = await withTenantTx(db, orgId, async (tx) => {
    // The Decision id is minted first so the terminal row can cite it, but NOTHING is persisted
    // unless the fenced ledger write below matches — the transaction is rolled back by the throw.
    const decision = await insertDecision(tx, {
      orgId,
      kind: AUTO_RELAY_DECISION_KIND,
      subjectId: claim.changeObjectId,
      verdict: "block",
      inputContext: {
        sourceChangeObjectId: claim.sourceChangeObjectId,
        failedAttempts: verdicts,
        maxAttempts: args.maxAttempts,
        deterministic: args.exhaustNow === true,
        lastDecisionId: args.decisionId
      },
      reasonTree: { summary }
    });
    const held = await exhaustRelayBuild(tx, orgId, claim, {
      reason: args.reason,
      decisionId: decision.id
    });
    if (!held) throw new LeaseLost();
    await appendAuditEvent(tx, {
      orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.relay.auto.exhausted",
      subjectId: claim.changeObjectId,
      reason: summary,
      decisionId: decision.id,
      // Deterministic, like every sibling federation audit requestId: exhaustion is TERMINAL and
      // happens at most once per change, and the fenced write above is what guarantees that — a
      // random component would only obscure a duplicate if one ever appeared.
      requestId: `federation-auto-relay:${claim.changeObjectId}`
    });
    return decision.id;
  }).catch((err) => {
    if (err instanceof LeaseLost) return null;
    throw err;
  });
  if (decisionId === null) return leaseLost(orgId, claim);
  console.error(`[auto-relay] org ${orgId}: ${summary}`);
  return {
    changeObjectId: claim.changeObjectId,
    outcome: "exhausted",
    detail: summary,
    decisionId
  };
}

/** Internal signal: the fenced write matched no row, so this transaction must persist nothing. */
class LeaseLost extends Error {}

function leaseLost(orgId: string, claim: RelayBuildClaim): AutoRelayOutcome {
  const detail =
    `this worker's claim (attempt ${claim.attempts}) was no longer held when the build finished — ` +
    `another worker took the lease over and owns the outcome; nothing was recorded here`;
  console.warn(`[auto-relay] org ${orgId}: change ${claim.changeObjectId}: ${detail}`);
  return { changeObjectId: claim.changeObjectId, outcome: "lease-lost", detail, decisionId: null };
}

/** One org's auto-relay sweep. See docs/federation.md §39. */
export async function autoRelayOrgTick(
  db: Db,
  orgId: string,
  masterKey: Buffer,
  options?: AutoRelaySweepOptions & { multiTenantInstance?: boolean }
): Promise<AutoRelayOutcome[]> {
  const env = options?.env ?? process.env;
  const config = options?.relayConfig ?? relayConfigFromEnv();
  const { self, peers } = await withTenantTx(db, orgId, async (tx) => ({
    self: await ensureFederationSelf(tx, orgId),
    peers: await listPeers(tx, orgId)
  }));

  // THE ROLE PRE-GATE (ADR-0004). Cheap and honest: a commander/outpost seeds nothing and has no
  // onward hop to make. This is NOT a second source of truth — `buildRelayTarball`'s own 409 arm
  // remains the authoritative gate and still refuses any non-retrans caller, whatever reaches it.
  if (self.role !== "retrans") return [];

  const due = await withTenantTx(db, orgId, (tx) =>
    listDueRelayBuilds(tx, orgId, AUTO_RELAY_BATCH_LIMIT)
  );
  if (due.length === 0) return [];

  // Normally unreachable in production. See docs/federation.md §40.
  if (!autoRelayEnabled(env)) {
    return due.map((row) => ({
      changeObjectId: row.changeObjectId,
      outcome: "disabled" as const,
      detail: "SCP_RETRANS_AUTO_RELAY is not set — the onward byte hop stays operator-gated",
      decisionId: null
    }));
  }

  // The onward drop is INSTANCE/PEER config, resolved ONCE per tick. See docs/federation.md §41.
  const onward = resolveOnwardDeliveryDir(peers, config, undefined, { strict: true });
  if ("problem" in onward) {
    console.warn(
      `[auto-relay] org ${orgId}: ${due.length} promotion(s) owe the onward byte hop but the ` +
        `delivery drop is unresolvable: ${onward.problem} (config gap — retried next tick, no ` +
        `attempt consumed)`
    );
    return due.map((row) => ({
      changeObjectId: row.changeObjectId,
      outcome: "deferred" as const,
      detail: `onward drop unresolvable: ${onward.problem}`,
      decisionId: null
    }));
  }
  if (onward.peerDomainId === undefined && options?.multiTenantInstance === true) {
    const problem =
      "this instance hosts more than one org and the onward drop resolved to the INSTANCE-WIDE " +
      "SCP_RELAY_OUT_DIR — two tenants would share one CDS intake namespace, where a tarball name " +
      "chosen by one org's peer can displace another's verified bytes. Configure a per-peer " +
      "deliveryTarget (org-scoped, SCP_DELIVERY_ROOTS-bounded) for the boundary peer";
    console.warn(`[auto-relay] org ${orgId}: refusing the onward drop: ${problem}`);
    return due.map((row) => ({
      changeObjectId: row.changeObjectId,
      outcome: "deferred" as const,
      detail: `onward drop unresolvable: ${problem}`,
      decisionId: null
    }));
  }

  const maxAttempts = autoRelayMaxAttempts(env);
  const leaseSeconds = autoRelayLeaseSeconds(env);
  const outcomes: AutoRelayOutcome[] = [];

  for (const row of due) {
    // PHASE 1 — CLAIM, in its own try. A throw here (transient DB error, pool exhaustion) means
    // there is NO claim, so it must never reach `finalizeFailure`: an unfenced "failure" with no
    // ledger row would write a Decision + audit event that no terminal state backs, and the row
    // would be re-served on the very next tick, forever. Skip and retry next tick instead.
    let claim: RelayBuildClaim | null;
    try {
      claim = await withTenantTx(db, orgId, (tx) =>
        claimRelayBuild(tx, orgId, row.changeObjectId, leaseSeconds)
      );
    } catch (err) {
      console.error(
        `[auto-relay] org ${orgId}: could not claim change ${row.changeObjectId} (retried next tick):`,
        err
      );
      outcomes.push({
        changeObjectId: row.changeObjectId,
        outcome: "deferred",
        detail: `claim failed: ${describeError(err)}`,
        decisionId: null
      });
      continue;
    }
    if (!claim) {
      outcomes.push({
        changeObjectId: row.changeObjectId,
        outcome: "claimed-elsewhere",
        detail:
          "not claimable this tick (another worker holds the lease, or the row went terminal)",
        decisionId: null
      });
      continue;
    }

    // PHASE 2 — THE BUILD, and NOTHING ELSE inside this try. See docs/federation.md §42.
    const held = claim;
    let outcome: Awaited<ReturnType<typeof buildRelayTarball>>;
    try {
      // THE ONE CALL. Same function, same role arm, same Decisions and audit events as
      // `POST /api/v1/federation/relay`. Deliberately outside any transaction: `buildRelayTarball`
      // manages its own transaction phases around the skopeo/cosign subprocesses (the codebase-wide
      // no-subprocess-while-holding-a-pooled-connection rule).
      outcome = await buildRelayTarball(db, {
        orgId,
        changeIdOrUrn: held.changeObjectId,
        masterKey,
        outDir: onward.dir,
        onwardPeerDomainId: onward.peerDomainId,
        config
      });
    } catch (err) {
      // ONE BAD CHANGE NEVER BRICKS THE TICK. See docs/federation.md §43.
      const deterministic = err instanceof ProblemError && err.status === 400;
      const reason = describeError(err);
      try {
        outcomes.push(
          await finalizeFailure(db, orgId, held, {
            maxAttempts,
            exhaustNow: deterministic,
            reason,
            decisionId: err instanceof ProblemError ? (err.decisionId ?? null) : null
          })
        );
      } catch (bookkeepingErr) {
        // The build already failed; a failure to RECORD that must not take the sweep down. The row
        // keeps its lease and becomes workable again when the lease lapses.
        console.error(
          `[auto-relay] org ${orgId}: change ${held.changeObjectId} failed (${reason}) and its ` +
            `ledger update ALSO failed:`,
          bookkeepingErr
        );
        outcomes.push({
          changeObjectId: held.changeObjectId,
          outcome: "refused",
          detail: reason,
          decisionId: null
        });
      }
      continue;
    }

    if (outcome.refused) {
      // A refusal published nothing (the fail-closed arm rms its partial), so this IS a verdict.
      outcomes.push(
        await finalizeFailure(db, orgId, held, {
          maxAttempts,
          reason: outcome.reason,
          decisionId: outcome.decisionId
        })
      );
      continue;
    }

    // PHASE 3 — bookkeeping about a crossing that already happened. See docs/federation.md §44.
    const success = outcome;
    try {
      const stillHeld = await withTenantTx(db, orgId, (tx) =>
        completeRelayBuild(tx, orgId, held, {
          tarballPath: success.tarballPath,
          decisionId: success.decisionId
        })
      );
      if (!stillHeld) {
        // The bytes ARE built and dropped (buildRelayTarball wrote its own allow Decision + audit
        // event, exactly as the manual path does) — only this worker's bookkeeping is void.
        outcomes.push(leaseLost(orgId, held));
        continue;
      }
    } catch (bookkeepingErr) {
      console.error(
        `[auto-relay] org ${orgId}: change ${held.changeObjectId} WAS relayed to ` +
          `${success.tarballPath}, but recording it in the ledger failed — the obligation stays ` +
          `open and will be re-run when the claim lease lapses (no verdict consumed, no Decision ` +
          `written; the allow Decision + audit event for the build itself already stand):`,
        bookkeepingErr
      );
      outcomes.push({
        changeObjectId: held.changeObjectId,
        outcome: "bookkeeping-failed",
        detail: `relayed to ${success.tarballPath} but the ledger write failed: ${describeError(bookkeepingErr)}`,
        decisionId: success.decisionId,
        tarballPath: success.tarballPath
      });
      continue;
    }
    console.log(
      `[auto-relay] org ${orgId}: change ${held.changeObjectId} relayed unattended -> ` +
        `${success.tarballPath} (${success.artifacts.length} artifact(s))`
    );
    outcomes.push({
      changeObjectId: held.changeObjectId,
      outcome: "built",
      detail: "signed relay tarball built and dropped for the onward hop",
      decisionId: success.decisionId,
      tarballPath: success.tarballPath
    });
  }
  return outcomes;
}

export async function runAutoRelaySweep(
  db: Db,
  masterKey: Buffer,
  options?: AutoRelaySweepOptions
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  const multiTenantInstance = orgRows.length > 1;
  for (const org of orgRows) {
    try {
      await autoRelayOrgTick(db, org.id, masterKey, { ...options, multiTenantInstance });
    } catch (err) {
      console.error(`[auto-relay] org ${org.id} tick failed:`, err);
    }
  }
}

// The loop (the interval FLOOR) + the poke wake (the optimization).

/** The routing marker on a poke-driven tick — a marker, not content (the poke stays contentless:
 *  WHICH promotions are owed is discovered by the sweep, exactly as on an interval tick). */
export const AUTO_RELAY_POKE_REASON = "poke";

export interface AutoRelayJobData {
  reason?: string;
}

/** Enqueue ONE immediate auto-relay tick. See docs/federation.md §45. */
export async function wakeAutoRelayNow(boss: PgBoss): Promise<void> {
  await boss.send(AUTO_RELAY_QUEUE, { reason: AUTO_RELAY_POKE_REASON });
}

export interface AutoRelayLoopHandle {
  stop(): Promise<void>;
}

/** Self-rescheduling pg-boss loop. See docs/federation.md §46. */
export async function startAutoRelayLoop(
  boss: PgBoss,
  db: Db,
  masterKey: Buffer
): Promise<AutoRelayLoopHandle> {
  if (!autoRelayEnabled()) {
    return { async stop() {} };
  }
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(AUTO_RELAY_QUEUE);
  await boss.work(AUTO_RELAY_QUEUE, async (jobs: { data?: AutoRelayJobData }[]) => {
    if (stopped) return;
    // A POKE WAKE DOES NOT RE-SCHEDULE. See docs/federation.md §47.
    const batch = jobs ?? [];
    const reschedule =
      batch.length === 0 || batch.some((job) => job.data?.reason !== AUTO_RELAY_POKE_REASON);
    const tick = runAutoRelaySweep(db, masterKey);
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    if (!reschedule) return;
    // Resolved from the LIVE env per tick, never an import-frozen module const (M14.4's rule).
    const interval = autoRelayIntervalSeconds();
    await boss.send(
      AUTO_RELAY_QUEUE,
      {},
      { startAfter: interval, singletonKey: "tick", singletonSeconds: interval }
    );
  });
  // Startup kick: UNKEYED, so it always inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).
  // Never give this send a singletonKey+window — not the chain's "tick" and not a private key
  // either: job_i4 counts COMPLETED jobs, so any window lets a previous boot swallow it silently.
  await boss.send(AUTO_RELAY_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}

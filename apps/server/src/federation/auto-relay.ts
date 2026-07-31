/**
 * M13.1b — the staging node's AUTO-RELAY (docs/proposals/airgap-cds-validate-promote.md §13.1,
 * BUILD_AND_TEST.md M13.1b): *"when a promotion import succeeds on a `retrans`-role instance, the
 * loop schedules `buildRelayTarball` for it."* This is the last operator-gated step of the CDS
 * boundary walk — M14.4 shipped the poke chain unattended end to end but left hop 2's BYTES needing
 * an operator command (its honest-scope note, owner decision D3). This module removes that command
 * and nothing else.
 *
 * ## What it is NOT
 *
 * Not a new trust decision, not a new verification path, not a new authority. It calls exactly the
 * function the route calls — `retrans-relay.ts::buildRelayTarball`, whose ADR-0004 409 role arm is
 * UNTOUCHED — so an unattended relay leaves byte-identical Decisions and hash-chained audit events
 * to an operator-invoked one. It writes no promotion state: **the retrans never terminates a
 * promotion** (ADR-0004), and nothing here touches `changes.state`, waves, approvals, or executors.
 * It merges no channel artifacts: the `.scpbundle` and the byte tarball stay two separate files
 * (ADR-0009 — metadata bundles remain byte-free). It re-signs nothing and adds no verification
 * authority — the receiving outpost's M17.4(a)+(b) gates run exactly as before.
 *
 * ## The work list is CAUSAL, never derived
 *
 * The sweep drives exclusively off `federation_relay_builds` (drizzle/0047), whose rows are written
 * by the promotion import itself (`promotion-repo.ts`, same transaction, `role: retrans` only). It
 * deliberately does NOT stand a predicate scan over `changes` for "imported + manifest + artifacts",
 * because that description also fits every promotion the HIGH-side retrans successfully FORWARDED:
 * that node would enumerate builds it can never perform — its source registry is on the far side of
 * the air gap, which is the entire reason a tarball exists — and would bury a real crossing under a
 * trail of fabricated refusals. Causal seeding also means enabling the feature never drains a
 * historical backlog across the CDS, and `validateAndForwardRelayTarball` marking its row
 * `forwarded` is the positive signal that this node receives the hop rather than building it.
 *
 * ## Opt-in, and why its own loop
 *
 * DEFAULT-OFF behind `SCP_RETRANS_AUTO_RELAY=1`. Unattended byte egress across a security boundary
 * is the most consequential automation in this system, and the codebase's shape for every unattended
 * loop is an explicit instance-level operator enable (`SCP_INBOX_LOOP`, `SCP_FEDERATION_SYNC_LOOP`)
 * rather than replicated config — an upstream operator must never be able to switch on byte movement
 * at someone else's boundary. Leaving it unset keeps exactly the M14.4 posture: ingest automated,
 * egress hand-gated. **Enable it on the retrans that can reach the SOURCE registry (the low side).**
 * A high-side node has nothing to build; if it is enabled there anyway, the forward path's
 * `forwarded` terminal state stops the obligation as soon as the bytes arrive.
 *
 * It is its OWN pg-boss loop, not a phase of the inbox tick, for a correctness reason: a CONNECTED
 * low-side retrans receives its promotion bundles over the M14.0 HTTP live-sync, not as files, so it
 * may legitimately run with no inbox at all. Hanging auto-relay off `SCP_INBOX_LOOP` would make the
 * whole feature unreachable in exactly that topology. One queue per capability is also what
 * `main.ts` already does for reconcile / watchdog / observe / inbox / federation-sync.
 *
 * ## Trigger: interval floor + poke optimization (ADR-0009)
 *
 * A self-rescheduling pg-boss singleton cloned from `startInboxLoop` is the RELIABLE FLOOR;
 * {@link wakeAutoRelayNow} — the third leg of the M14.4 poke handler, beside the sync and inbox
 * wakes — is the low-latency optimization. A dropped poke self-heals on the next interval tick,
 * which is precisely ADR-0009's never-poke-only reliability model. A poke wake does NOT re-schedule
 * (M14.4's reasoning: pg-boss computes a singleton slot at insert, so a wake landing in a different
 * slot would leave two pending ticks).
 *
 * ## Bounded by construction — #153's bug class, deliberately not re-introduced
 *
 * `buildRelayTarball` turns EVERY per-artifact failure into a refusal carrying a block Decision, and
 * cannot distinguish a transient registry outage from a permanently tampered artifact. Retrying
 * every tick would restate a block Decision once a minute forever per failing change — the exact
 * pathology PR #153 measured at 1.44 GB/day in production, and worse here because each Decision is
 * cited by a hash-chained audit event, which ADR-0024 classes as never-deleted. So:
 *
 *   - a failing change gets {@link autoRelayMaxAttempts} VERDICTS (not claims — an evicted worker
 *     must not spend the budget without deciding anything), with exponential backoff, then TERMINAL
 *     `exhausted` and no further work;
 *   - a Decision is written ONLY when the fenced ledger write that makes it terminal succeeded, so a
 *     verdict can never be re-derived and re-written on the next tick;
 *   - the persisted failure payload is truncated at the source (`RELAY_FAILURE_DETAIL_LIMIT`), so
 *     the bound is on bytes as well as rows.
 *
 * Worst case per permanently-failing change: `maxAttempts` `retrans-relay-validate` blocks + one
 * `retrans-auto-relay` block, each with its audit event — a fixed, small, one-time cost.
 *
 * The exit from `exhausted` is the operator's existing `POST /api/v1/federation/relay`, unchanged
 * and always available: a successful manual build delivers the bytes AND clears the row (the route
 * calls `reopenRelayBuild`), so a terminal row is never a trap needing superuser SQL.
 *
 * ## Zero-trust survives automation
 *
 * Nothing here reads the inbox, parses a file name, or takes a byte of untrusted input: its only
 * inputs are this instance's OWN federation role, its OWN operator env, and rows the M17.4(a)-
 * verified import path wrote in its OWN database. The authorized artifact set is re-derived inside
 * `buildRelayTarball` from the signed manifest on every attempt, the two egress allowlists
 * (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS` / `SCP_ARTIFACT_BLOB_BASE_URLS`) guard every dial as before,
 * and the onward drop directory is operator config (`SCP_DELIVERY_ROOTS`-bounded when per-peer) —
 * never anything a bundle said.
 */
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

/** The CLAIM LEASE (`SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS`, default 3600 = 1 h, clamped to
 *  [60, 86400]). A claimed row is invisible to other workers until the lease expires, so N replicas
 *  produce at most one build per change per window; a process that dies mid-build lets its lease
 *  lapse and the change is reclaimed — no janitor. It should comfortably exceed the slowest
 *  realistic pull of a multi-GB artifact set: a lease that expires mid-build is survivable (every
 *  release is fenced on the claim, so the slow worker's late write is refused rather than clobbering
 *  the fast one's result) but wasteful. */
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
    | "disabled"; // seeded work exists but SCP_RETRANS_AUTO_RELAY is not set.
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

// -------------------------------------------------------------------------------------------------
// Terminal bookkeeping — every write FENCED on the claim (see relay-builds-repo.ts's rule 1).
// -------------------------------------------------------------------------------------------------

/**
 * One failed attempt: record the verdict and schedule the next one, or go TERMINAL `exhausted`.
 *
 * THE ORDER MATTERS. The ledger write happens FIRST and its row count is the gate on everything
 * else. If it matched nothing, this worker's lease was taken over by another while the build ran —
 * that other worker owns the outcome, and writing a Decision or audit event here would either
 * contradict it or (worse) leave a verdict with no terminal state behind it, which the next tick
 * would re-derive and re-write forever. So a lost claim writes NOTHING.
 *
 * Exhaustion is the ONE thing an unattended sweep does that has no manual-CLI equivalent — the loop
 * giving up — so it gets its own `retrans-auto-relay` block Decision + hash-chained audit event
 * (charter principle 6: no unattended terminal state is explainable-by-nobody).
 */
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
  const verdicts = claim.failedAttempts + 1; // including this one.
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

// -------------------------------------------------------------------------------------------------
// The sweep.
// -------------------------------------------------------------------------------------------------

/**
 * One org's auto-relay sweep. Exported for the integration suite (the 13.1b DoD is asserted through
 * it); production reaches it via {@link runAutoRelaySweep}.
 *
 * `multiTenantInstance` is threaded from the caller (which already enumerated orgs) rather than
 * re-counted here — see the drop-resolution guard below for why it matters.
 */
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

  // Normally unreachable in production: `startAutoRelayLoop` returns an inert handle and never
  // creates the queue when the flag is unset, so nothing ticks at all. Kept as belt-and-braces for
  // the test seam and for a live env change under a running loop — NOT as the anti-silence
  // mechanism. The real "this hop is owed but automation is off" signal is emitted ONCE PER
  // PROMOTION at the causal seed site (`promotion-repo.ts`), which is reachable by construction.
  if (!autoRelayEnabled(env)) {
    return due.map((row) => ({
      changeObjectId: row.changeObjectId,
      outcome: "disabled" as const,
      detail: "SCP_RETRANS_AUTO_RELAY is not set — the onward byte hop stays operator-gated",
      decisionId: null
    }));
  }

  // The onward drop is INSTANCE/PEER config, resolved ONCE per tick — never per change, and never
  // from anything a bundle said. `strict` because this is the AUTOMATED path: a peer configured for
  // a provider this hop cannot deliver to (s3 — the documented 13.2b follow-on) must produce a
  // NAMED problem, exactly as the manual route 400s on it, rather than quietly falling through to
  // the instance env and marking a build `built` whose bytes reach a directory nobody watches.
  //
  // MULTI-TENANT GUARD: `SCP_RELAY_OUT_DIR` is instance-wide while this sweep runs per org, and the
  // tarball basename is chosen by the exporting domain (`scp-relay-<sourceChangeObjectId>.tar.gz`).
  // On an instance hosting several orgs that would put two tenants' boundary artifacts in one
  // namespace, where a name chosen by org B's peer can displace org A's verified bytes. The
  // profiled deployment is single-org per boundary ("a retrans instance serves exactly one
  // boundary/peer", retrans-relay.ts), so rather than invent a path scheme that would break every
  // operator's CDS watcher, a multi-tenant instance FAILS CLOSED on the shared env fallback and is
  // told to configure a per-peer deliveryTarget (which is org-scoped by construction).
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

    // PHASE 2 — THE BUILD, and NOTHING ELSE inside this try.
    //
    // The boundary of this try is a correctness property, not tidiness. `buildRelayTarball` renames
    // the finished tarball into the CDS intake as its LAST act, so once it returns without refusing,
    // THE BYTES HAVE CROSSED — an operator's CDS may already have picked them up. Anything after
    // that point is bookkeeping about an event that already happened. If the post-build ledger write
    // were inside this try, a transient DB error there would be caught below as a *build failure*:
    // `failed_attempts` would tick up, the next tick would rebuild and re-drop the same bytes, and on
    // the last budgeted verdict the loop would persist a hash-chained, never-deleted
    // `federation.relay.auto.exhausted` event asserting "nothing crossed the boundary" about a
    // crossing that did happen. A durable audit record must never say that.
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
      // ONE BAD CHANGE NEVER BRICKS THE TICK (the inbox loop's containment rule). A throw here means
      // the build did NOT complete, so nothing was published and recording a failure is the truth. A
      // 400 is a DETERMINISTIC input problem (`buildRelayTarball`'s "no verified manifest" / "empty
      // authorized set" refusals) — retrying it changes nothing, so it exhausts at once. Everything
      // else (a missing/unpinned skopeo, a dead registry surfacing as a throw) gets the budget.
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

    // PHASE 3 — bookkeeping about a crossing that already happened. A failure here is NEVER a build
    // failure: it consumes no verdict, schedules no rebuild, and writes no Decision. The row simply
    // keeps its lease and is reclaimed when it lapses, at which point the ledger converges. The
    // observable cost of that convergence is one rebuilt tarball with the SAME name, published
    // atomically over the old one — which the receiver re-verifies from scratch either way (ADR-0019
    // §2 step 7). Losing a little work is the correct trade against a false permanent record.
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

/** Every org, one tick — mirrors `runInboxSweep`/`runObserveSweep`. */
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

// -------------------------------------------------------------------------------------------------
// The loop (the interval FLOOR) + the poke wake (the optimization).
// -------------------------------------------------------------------------------------------------

/** The routing marker on a poke-driven tick — a marker, not content (the poke stays contentless:
 *  WHICH promotions are owed is discovered by the sweep, exactly as on an interval tick). */
export const AUTO_RELAY_POKE_REASON = "poke";

export interface AutoRelayJobData {
  reason?: string;
}

/**
 * Enqueue ONE immediate auto-relay tick — the third leg of the M14.4 poke handler, beside
 * `wakeFederationSyncNow` and `wakeInboxNow`. A plain `boss.send` with NO singleton (so a queued
 * interval tick can never swallow the wake) and, like its siblings, it THROWS when the queue does
 * not exist — the caller treats that as accepted-but-no-op.
 *
 * WHY THE THIRD LEG. ADR-0009's chain is commander → low-side retrans → CDS → high-side retrans →
 * outpost. A poke landing on the low-side retrans previously woke its inbox (so it imports the
 * arriving `.scpbundle`) and its sync loop (so it pulls) — but hop 2, the BYTES, then waited for a
 * human. Waking this loop is what makes the poke chain move bytes rather than only metadata.
 */
export async function wakeAutoRelayNow(boss: PgBoss): Promise<void> {
  await boss.send(AUTO_RELAY_QUEUE, { reason: AUTO_RELAY_POKE_REASON });
}

export interface AutoRelayLoopHandle {
  stop(): Promise<void>;
}

/**
 * Self-rescheduling pg-boss loop — the SAME singleton shape as `startInboxLoop`/`startObserveLoop`.
 * Runs only under `SCP_ROLE=all|worker` (wired in `main.ts` beside the other loops) AND only when
 * the operator explicitly enabled it (`SCP_RETRANS_AUTO_RELAY=1`); otherwise this returns an inert
 * handle and the queue is never created, so an instance that never opted into unattended byte
 * egress does not even have a queue to poke.
 */
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
    // A POKE WAKE DOES NOT RE-SCHEDULE (the M14.4 rule, verbatim): pg-boss computes a singleton slot
    // from now() AT INSERT, so a wake landing in a different slot than the already-pending interval
    // tick is not deduped and would leave TWO pending ticks. Keyed on "the batch contains a non-poke
    // job" rather than "no poke present", so a batchSize>1 queue could never consume the interval
    // job and skip its re-schedule.
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
  await boss.send(AUTO_RELAY_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}

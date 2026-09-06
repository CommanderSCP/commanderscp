/**
 * M14.3 (ADR-0009, docs/proposals/outpost-poke.md §"Milestone scope") — the COMMANDER POKE SENDER.
 *
 * The OTHER half of poke-mode: M14.2 built the inbound endpoint an outpost exposes; this is the
 * commander sending the contentless wake to it. When this instance produces something a downstream
 * peer should pull (a config-journal append — every graph/coordination mutation writes one in the
 * SAME tx that writes the outbox row, journal-repo.ts), a poke-mode peer is nudged to pull NOW
 * instead of waiting for its interval, and best-effort so.
 *
 * ## The trigger is OUTBOX-DERIVED (DESIGN §5/§8) — no new event source
 *
 * The sender does NOT invent a feed. It hangs off the EXISTING transactional-outbox relay
 * (events/outbox-relay.ts): after the relay commits a batch, it hands the sender the distinct
 * org ids that just produced events (`onEventsRelayed`), post-commit and fire-and-forget — NEVER in
 * the mutation's own transaction. Any outbox activity for an org means that commander mutated
 * something (and thus appended journal entries a peer would pull), so the sender pokes that org's
 * poke-mode downstream peers. A pull is idempotent and drains everything pending, so an occasional
 * poke that finds nothing new is a harmless no-op — the deliberately-sparse over-poke this design
 * accepts (Simplicity first). The per-peer coalescer bounds it to at most one poke per window.
 *
 * ## Best-effort, NOT reliable (the DECIDED model — proposal §4, owner 2026-07-18)
 *
 * A poke is FIRE-AND-FORGET. A failed/refused/timed-out poke is logged at debug and dropped — it is
 * NOT retried-to-confirmation and it NEVER blocks or fails the underlying journal append / transfer
 * (which already committed; this runs off the relay, after the fact). The receiver's sparse
 * safety-net reconcile + next poll/reconnect self-heals a missed poke within a bounded window. This
 * is a latency optimization over a reliable floor, never a delivery guarantee. (Reliable
 * poke-delivery / retry-until-pull-confirmed was considered and REJECTED.)
 *
 * ## Opt-in / default-off (SCOPE 5)
 *
 * Inert unless BOTH hold: (a) the peer is `pokeMode=true` AND a downstream role (outpost/retrans)
 * AND its `baseUrl` is an https/mTLS-capable endpoint — see {@link isPokeTarget}; a poll-mode peer is
 * never poked, and a `commander`-role (UPSTREAM) peer is never poked (the shared `pokeMode` column
 * means "I accept pokes from it" on that side, not "I poke it" — filtering by role keeps an outpost
 * from poking its own commander). And (b) this instance has outbound client-cert material
 * (`SCP_FEDERATION_MTLS_CERT_FILE`/`_KEY_FILE`); without it the whole sender is inert and the
 * fail-closed dialer would refuse anyway.
 *
 * ## Fail-closed at THREE layers (M14.3 hardening) — the poke is always mutually authenticated
 *
 * A poke carries no signed payload of its own, so the mTLS transport is the ONLY thing proving the
 * caller is the enrolled commander (ADR-0009 §5). Three independent layers enforce that, so no single
 * bad row or wrong merge can put the federation bearer on the wire in cleartext:
 *   1. `pairPeer`'s pair-time guard checks the EFFECTIVE post-write `(pokeMode, baseUrl)` tuple, making
 *      `pokeMode=true` on a non-https baseUrl unrepresentable through every write path;
 *   2. {@link isPokeTarget} independently requires an https baseUrl, so a malformed row is SKIPPED
 *      rather than dialed; and
 *   3. `sendPokeToPeer` refuses a non-https target outright and passes `requireMtls: true` as a
 *      CONSTANT (never scheme-derived), so the dial refuses before any socket is opened.
 *
 * ## Coalesce / rate-limit (SCOPE 4 — be a good citizen)
 *
 * The receiver is already idempotent + rate-limited, but the sender does not spam it: a per-`(org,
 * peer)` token bucket (the SAME {@link PokeRateLimiter} the receiver uses, capacity 1) collapses
 * multiple pending signals in one short window into at most one poke. Mirrors the send window to the
 * receiver's `SCP_FEDERATION_POKE_MIN_INTERVAL_SECONDS` knob so the two sides are symmetric.
 */
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { listPeers, type FederationPeerRow } from "./peers-repo.js";
import {
  FederationDialRefused,
  federationClientMtlsConfigured,
  federationPeerRequiresMtls,
  resolveFederationClientMtls,
  sendPokeToPeer,
  type FederationClientMtls
} from "./federation-outbound.js";
import { PokeRateLimiter } from "./poke-rate-limit.js";

/** Send-side coalesce window (seconds). Reuses the receiver's min-interval knob so the send and
 *  receive windows are symmetric; floor 1s. */
export const POKE_SEND_COALESCE_SECONDS = Math.max(
  1,
  Number(process.env.SCP_FEDERATION_POKE_MIN_INTERVAL_SECONDS ?? 5)
);

/**
 * Is this peer a poke TARGET for the sender? True iff it is a DOWNSTREAM peer (outpost/retrans) that
 * has opted into pokes (`pokeMode`), has a `baseUrl` to dial, AND that baseUrl is an https/mTLS-capable
 * endpoint. A `commander`-role peer is UPSTREAM and is never poked (see the module header on the
 * shared `pokeMode` column's per-side meaning).
 *
 * ## Why the https requirement is part of the TARGET TEST (fail-closed, defense in depth)
 *
 * `pokeMode=true` MEANS "mTLS-capable peer": the poke has to authenticate the caller as the enrolled
 * commander (ADR-0009 §5), and only the mTLS transport carries that identity. `pairPeer`'s
 * effective-state guard makes `pokeMode=true` on a non-https baseUrl UNREPRESENTABLE, but the sender
 * must not DEPEND on the row being well-formed: a non-https poke-mode row (a hand-edited DB, a row
 * predating the guard) must be SKIPPED like a poll-mode peer rather than dialed. Dialing it would put
 * the federation bearer on the wire in CLEARTEXT with no mutual authentication — the scheme-derived
 * `requireMtls` never fires for an `http://` URL, so nothing downstream would have refused it.
 */
export function isPokeTarget(peer: FederationPeerRow): boolean {
  return (
    (peer.role === "outpost" || peer.role === "retrans") &&
    peer.pokeMode &&
    typeof peer.baseUrl === "string" &&
    peer.baseUrl.length > 0 &&
    // Fail-closed: a poke-mode peer whose baseUrl is not https is NOT a target — never dialed.
    federationPeerRequiresMtls(peer.baseUrl)
  );
}

/** One peer's terminal outcome for a poke round — returned for tests/observability. */
export interface PokeSendOutcome {
  peerDomainId: string;
  outcome: "sent" | "refused" | "error" | "coalesced";
  detail: string;
}

export interface PokeSendContext {
  bearer?: string;
  mtls?: FederationClientMtls;
  /** When present, gates each peer through the per-`(org,peer)` coalesce bucket first. */
  limiter?: PokeRateLimiter;
  /** Optional debug sink (defaults to `console.debug`). Best-effort failures log here, never throw. */
  log?: (msg: string) => void;
}

/**
 * Poke every poke-mode downstream peer of ONE org, best-effort. NEVER throws — each peer's outcome
 * (sent / coalesced / fail-closed refused / transient error) is captured and returned so one bad or
 * unreachable peer never affects another, and nothing propagates back to the outbox relay. When
 * `ctx.limiter` is supplied, a peer whose bucket is empty this window is `coalesced` (not dialed).
 */
export async function pokeDownstreamPeersForOrg(
  db: Db,
  orgId: string,
  ctx: PokeSendContext
): Promise<PokeSendOutcome[]> {
  const log = ctx.log ?? ((msg: string) => console.debug?.(`[poke-sender] ${msg}`));
  const peers = await withTenantTx(db, orgId, (tx) => listPeers(tx, orgId));
  const targets = peers.filter(isPokeTarget);
  // Observability for the fail-closed skip: a peer that WANTS pokes but cannot receive one over an
  // authenticated transport is silently dropped by `isPokeTarget`; say so at debug so an operator can
  // tell "no poke because poll-mode" apart from "no poke because the baseUrl is not mTLS-capable".
  for (const peer of peers) {
    if (
      (peer.role === "outpost" || peer.role === "retrans") &&
      peer.pokeMode &&
      !isPokeTarget(peer)
    ) {
      log(`skipping poke: non-mTLS baseUrl on poke-mode peer '${peer.name}' (fail-closed)`);
    }
  }
  const outcomes: PokeSendOutcome[] = [];
  for (const peer of targets) {
    if (ctx.limiter && !ctx.limiter.tryConsume(`${orgId}:${peer.id}`)) {
      // Coalesced: an earlier signal already poked this peer inside the current window. The receiver
      // is idempotent anyway, so dropping the extra is exactly the good-citizen behavior we want.
      outcomes.push({
        peerDomainId: peer.id,
        outcome: "coalesced",
        detail: "coalesced within the send window (at most one poke per window)"
      });
      continue;
    }
    const baseUrl = peer.baseUrl!;
    // Belt-and-braces fail-closed: never send a poke plain-HTTP to an https peer with no client cert.
    // (`sendPokeToPeer` → `federationDialJson` also refuses this, but skipping here avoids the dial.)
    if (federationPeerRequiresMtls(baseUrl) && !ctx.mtls) {
      log(
        `peer '${peer.name}' requires mTLS but no client cert configured — poke not sent (fail-closed)`
      );
      outcomes.push({
        peerDomainId: peer.id,
        outcome: "refused",
        detail: "peer requires mTLS but this instance has no client-cert material (fail-closed)"
      });
      continue;
    }
    try {
      const { status } = await sendPokeToPeer({ baseUrl, bearer: ctx.bearer, mtls: ctx.mtls });
      if (status >= 200 && status < 300) {
        outcomes.push({ peerDomainId: peer.id, outcome: "sent", detail: `HTTP ${status}` });
      } else {
        // A refused/rate-limited/erroring receiver — best-effort, so log+drop, never retry-to-confirm.
        log(
          `poke to '${peer.name}' returned HTTP ${status} — dropped (best-effort; safety-net heals)`
        );
        outcomes.push({ peerDomainId: peer.id, outcome: "error", detail: `HTTP ${status}` });
      }
    } catch (err) {
      if (err instanceof FederationDialRefused) {
        log(`poke to '${peer.name}' refused fail-closed: ${err.message}`);
        outcomes.push({ peerDomainId: peer.id, outcome: "refused", detail: err.message });
      } else {
        // Unreachable / TLS / timeout — best-effort: log + drop. NEVER escalates; the underlying
        // journal append/transfer already committed and is entirely unaffected.
        const detail = err instanceof Error ? err.message : String(err);
        log(`poke to '${peer.name}' failed: ${detail} — dropped (best-effort; safety-net heals)`);
        outcomes.push({ peerDomainId: peer.id, outcome: "error", detail });
      }
    }
  }
  return outcomes;
}

export interface CommanderPokeSenderOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam — coalesce window in ms (defaults to `POKE_SEND_COALESCE_SECONDS * 1000`). */
  coalesceMs?: number;
  /** Test seam — deterministic clock for the coalesce bucket (defaults to `Date.now`). */
  now?: () => number;
  /** Test seam — inject resolved client-cert material. `null` = explicitly none (fail-closed);
   *  `undefined` = resolve from `env`. */
  mtls?: FederationClientMtls | null;
  /** Test seam — capture the fire-and-forget outcomes of each org's poke round. */
  onRoundComplete?: (orgId: string, outcomes: PokeSendOutcome[]) => void;
  log?: (msg: string) => void;
}

export interface CommanderPokeSender {
  /** Outbox-relay hook: post-commit, fire-and-forget, per distinct org that produced events. */
  onEventsRelayed(orgIds: Iterable<string>): void;
  /** Awaits any in-flight poke rounds (test seam / graceful shutdown). */
  drain(): Promise<void>;
  /** Stops the sender: no new rounds start; clears coalesce state. */
  stop(): Promise<void>;
}

/**
 * Builds the commander poke sender wired into the outbox relay in main.ts (worker/all role only).
 * INERT unless outbound client-cert material is present AND readable — `onEventsRelayed` is then a
 * no-op (no peer scan, no dial), and material that is configured but unreadable says so at
 * `console.error`. Otherwise each distinct org that produced outbox events triggers a best-effort,
 * coalesced poke round to that org's poke-mode downstream peers, off the relay's post-commit path.
 */
export function createCommanderPokeSender(
  db: Db,
  opts: CommanderPokeSenderOptions = {}
): CommanderPokeSender {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((msg: string) => console.debug?.(`[poke-sender] ${msg}`));
  /** The one message an operator must not miss — a misconfiguration that turned the sender OFF.
   *  Same injectable sink when a caller supplies one (so it stays testable), but `console.error`
   *  rather than `console.debug` by default: a disabled component announced at debug level is a
   *  component that goes unnoticed. */
  const loud = opts.log ?? ((msg: string) => console.error(`[poke-sender] ${msg}`));
  const coalesceMs = opts.coalesceMs ?? POKE_SEND_COALESCE_SECONDS * 1000;
  const limiter = new PokeRateLimiter({ capacity: 1, refillIntervalMs: coalesceMs, now: opts.now });
  const bearer = env.SCP_FEDERATION_SYNC_BEARER || undefined;

  // Resolve outbound client-cert material ONCE (not per outbox batch — it reads files). `null` from
  // opts means "explicitly none"; a half-configured or unreadable pair throws in
  // `resolveFederationClientMtls` — for this best-effort optimization we swallow that into INERT
  // rather than crash boot (the sync loop / dialer surface the misconfig loudly elsewhere).
  //
  // THE THROW PATH DISABLES THE SENDER, and it has to say so itself. `federationClientMtlsConfigured`
  // is a pure presence check over the two env paths, which is exactly what is TRUE when resolution
  // threw (paths set, material unreadable) — so ORing it in left `active` true after a failure that
  // had just logged "inert". The sender then scanned peers and produced a fail-closed refusal per
  // peer per coalesce window forever, while the boot log said it was doing nothing.
  let mtls: FederationClientMtls | undefined;
  /** Resolution threw: there is no usable material, whatever the env paths claim. */
  let mtlsUnresolvable = false;
  if (opts.mtls !== undefined) {
    mtls = opts.mtls ?? undefined;
  } else {
    try {
      mtls = resolveFederationClientMtls(env);
    } catch (err) {
      mtlsUnresolvable = true;
      mtls = undefined;
      loud(
        "POKE SENDER DISABLED — outbound mTLS client-cert material is configured but could not be " +
          `read: ${String(err)}. No peer will be poked until it is fixed; downstream peers still ` +
          "sync on their own poll schedule, so this delays wake-ups rather than losing them."
      );
    }
  }
  // Inert when there is no way to authenticate a poke (SCOPE 5). `opts.mtls === null` forces inert;
  // so does a failed resolution, which is strictly more fail-closed than the refusal loop it
  // replaces — nothing was ever dialed on that path either.
  const active =
    opts.mtls === null || mtlsUnresolvable
      ? false
      : Boolean(mtls) || federationClientMtlsConfigured(env);
  if (!active && !mtlsUnresolvable) {
    log("poke sender inert — no outbound mTLS client-cert material configured");
  }

  let stopped = false;
  const inFlight = new Set<Promise<void>>();

  function onEventsRelayed(orgIds: Iterable<string>): void {
    if (stopped || !active) return;
    for (const orgId of orgIds) {
      const round = pokeDownstreamPeersForOrg(db, orgId, { bearer, mtls, limiter, log })
        .then((outcomes) => {
          opts.onRoundComplete?.(orgId, outcomes);
        })
        .catch((err) => {
          // pokeDownstreamPeersForOrg never throws, but guard the whole chain anyway — a poke round
          // must never surface an unhandled rejection into the relay's post-commit path.
          log(`poke round for org ${orgId} failed: ${String(err)}`);
        })
        .finally(() => {
          inFlight.delete(round);
        });
      inFlight.add(round);
    }
  }

  return {
    onEventsRelayed,
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
    async stop() {
      stopped = true;
      await Promise.allSettled([...inFlight]);
      limiter.reset();
    }
  };
}

/** The commander-side poke sender. See docs/federation.md §380. */
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

/** Is this peer a poke TARGET for the sender? See docs/federation.md §381. */
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

/** Poke every poke-mode downstream peer of ONE org, best-effort. See docs/federation.md §382. */
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

/** Builds the sender wired into the outbox relay. See docs/federation.md §383. */
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

  // Resolve outbound client-cert material ONCE. See docs/federation.md §384.
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

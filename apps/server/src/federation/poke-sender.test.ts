import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import type { FederationPeerRow } from "./peers-repo.js";
import {
  FederationDialRefused,
  sendPokeToPeer,
  type FederationClientMtls
} from "./federation-outbound.js";
import { createCommanderPokeSender, isPokeTarget } from "./poke-sender.js";
import type { Db } from "../db/client.js";
import { PokeRateLimiter } from "./poke-rate-limit.js";
import { asTrustDomainId } from "@scp/schemas";

/**
 * M14.3 unit coverage for the commander poke SENDER's pure pieces: the poke-target gate
 * (pokeMode + downstream-role + baseUrl), the fail-closed contentless dial, and the send-side
 * coalesce bucket. The two-domain network round trip is in `poke-sender.integration.test.ts`.
 */

function peer(overrides: Partial<FederationPeerRow>): FederationPeerRow {
  return {
    id: asTrustDomainId("peer-1"),
    orgId: "org-1",
    name: "the-outpost",
    role: "outpost",
    baseUrl: "https://outpost.example:8443",
    syncScope: { mode: "full" },
    deliveryTarget: null,
    cosignPublicKey: null,
    pokeMode: true,
    // M14.4 scheduler due-state — irrelevant to the SENDER's target gate (it pokes on outbox
    // activity, not on a schedule), so the fixture leaves all three at "never".
    lastPullAttemptAt: null,
    lastPullSuccessAt: null,
    lastPokeReceivedAt: null,
    pairedAt: new Date().toISOString(),
    publicKey: "pk",
    ...overrides
  };
}

describe("M14.3 isPokeTarget — the pokeMode gate + downstream-role filter (SCOPE 1/5)", () => {
  it("a downstream outpost peer with pokeMode=true and a baseUrl IS a target", () => {
    expect(isPokeTarget(peer({ role: "outpost" }))).toBe(true);
  });

  it("a downstream retrans peer with pokeMode=true and a baseUrl IS a target", () => {
    expect(isPokeTarget(peer({ role: "retrans" }))).toBe(true);
  });

  it("a peer with pokeMode=false is NOT a target (default-off, poll-mode)", () => {
    expect(isPokeTarget(peer({ pokeMode: false }))).toBe(false);
  });

  it("a commander-role (UPSTREAM) peer is NEVER a target even with pokeMode=true", () => {
    // The shared pokeMode column means 'I accept pokes from it' on the receiver side — poking the
    // upstream commander would be wrong direction. Role filter prevents it.
    expect(isPokeTarget(peer({ role: "commander" }))).toBe(false);
  });

  it("a poke-mode peer with no baseUrl is NOT a target (nothing to dial)", () => {
    expect(isPokeTarget(peer({ baseUrl: null }))).toBe(false);
  });

  // ---- M14.3 fail-closed hardening: pokeMode=true IMPLIES an https/mTLS-capable baseUrl -------
  // `pairPeer`'s effective-state guard makes such a row unrepresentable, but the SENDER must not
  // depend on that: a malformed row (hand-edited DB / predating the guard) must be SKIPPED, not
  // dialed — dialing it would put the federation bearer on the wire in cleartext, unauthenticated.

  it("a poke-mode peer with a plain-HTTP baseUrl is NOT a target (fail-closed, never dialed)", () => {
    expect(isPokeTarget(peer({ baseUrl: "http://outpost.example:8080" }))).toBe(false);
  });

  it("the https requirement is case-insensitive and rejects other schemes outright", () => {
    expect(isPokeTarget(peer({ baseUrl: "HTTPS://outpost.example:8443" }))).toBe(true);
    expect(isPokeTarget(peer({ baseUrl: "HTTP://outpost.example:8080" }))).toBe(false);
    expect(isPokeTarget(peer({ baseUrl: "file:///etc/passwd" }))).toBe(false);
    expect(isPokeTarget(peer({ baseUrl: "ftp://outpost.example" }))).toBe(false);
  });
});

describe("M14.3 sendPokeToPeer — contentless + fail-closed (SCOPE 2/5)", () => {
  it("REFUSES fail-closed (no socket opened) when an https peer has no client-cert material", async () => {
    // https ⟺ mTLS-required in this system — with no mtls the dialer throws BEFORE any fetch, so a
    // poke is never sent plain-HTTP to an mTLS peer.
    await expect(
      sendPokeToPeer({ baseUrl: "https://outpost.example:8443", bearer: "t", mtls: undefined })
    ).rejects.toBeInstanceOf(FederationDialRefused);
  });

  it("REFUSES a NON-https target even WITH client-cert material — and sends ZERO pokes", async () => {
    // The credential-leak regression: `requireMtls` used to be DERIVED from the target's own scheme,
    // so a plain-http poke target opted ITSELF out of mTLS and would have received
    // `Authorization: Bearer <federation bearer>` in CLEARTEXT with no mutual authentication. It is
    // now the CONSTANT true plus an outright non-https refusal. Proven against a REAL http listener:
    // it must never see a single request.
    let requests = 0;
    const server: Server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const mtls: FederationClientMtls = { cert: "unused-cert-pem", key: "unused-key-pem" };
    try {
      await expect(
        sendPokeToPeer({ baseUrl: `http://127.0.0.1:${port}`, bearer: "leak-me", mtls })
      ).rejects.toBeInstanceOf(FederationDialRefused);
      // ZERO pokes sent: refused before any socket was opened, so the bearer never hit the wire.
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("M14.3 send-side coalesce bucket — at most one poke per window (SCOPE 4)", () => {
  it("collapses a burst for the same peer to a single allowed send, then refills", () => {
    let clock = 1_000_000;
    const limiter = new PokeRateLimiter({ capacity: 1, refillIntervalMs: 5000, now: () => clock });
    const key = "org-1:peer-1";
    // First signal in the window: allowed (leading edge → one poke).
    expect(limiter.tryConsume(key)).toBe(true);
    expect(limiter.tryConsume(key)).toBe(false);
    expect(limiter.tryConsume(key)).toBe(false);
    expect(limiter.tryConsume("org-1:peer-2")).toBe(true);
    // After the window refills, the first peer is allowed one more.
    clock += 5000;
    expect(limiter.tryConsume(key)).toBe(true);
    expect(limiter.tryConsume(key)).toBe(false);
  });
});

/**
 * UNREADABLE mTLS MATERIAL DISABLES THE SENDER — the log and the behavior have to agree.
 *
 * `resolveFederationClientMtls` throws when the two env paths are set but the files cannot be read
 * (or only one is set). The sender caught that, logged "inert", and then computed `active` as
 * `Boolean(mtls) || federationClientMtlsConfigured(env)` — and that second disjunct is a pure
 * presence check over exactly the paths that are set in this case. So it stayed ACTIVE: a peer scan
 * (a DB query) per org per outbox batch, and a fail-closed refusal per peer per coalesce window,
 * forever, while the operator had been told it was doing nothing.
 *
 * The db is a Proxy that RECORDS every property access, so "did not scan peers" is measured rather
 * than inferred from an absent log line — the round's own catch swallows anything thrown inside it,
 * which is exactly how the active-after-failure sender stayed invisible.
 */
describe("createCommanderPokeSender — mTLS resolution that THROWS disables the sender", () => {
  /** Records touches instead of throwing: a throw would be swallowed by the round's catch. */
  function spyDb(): { db: Db; touches: string[] } {
    const touches: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_target, prop) {
          touches.push(String(prop));
          return undefined;
        }
      }
    ) as Db;
    return { db, touches };
  }

  /** For the two log cases, which construct the sender and never signal it. */
  const unusedDb = spyDb().db;

  const unreadableEnv = {
    SCP_FEDERATION_MTLS_CERT_FILE: "/nonexistent/scp-poke-sender-cert.pem",
    SCP_FEDERATION_MTLS_KEY_FILE: "/nonexistent/scp-poke-sender-key.pem"
  };

  it("no-ops onEventsRelayed instead of scanning peers and refusing a poke per window", async () => {
    const { db, touches } = spyDb();
    const sender = createCommanderPokeSender(db, { env: unreadableEnv, log: () => {} });
    try {
      sender.onEventsRelayed(["org-1", "org-2"]);
      await sender.drain();
      // `withTenantTx` reaches for `db.transaction` first thing, so one touch is one peer scan.
      expect(touches).toEqual([]);
    } finally {
      await sender.stop();
    }
  });

  it("says the sender is DISABLED, and why, in one unambiguous line", () => {
    const lines: string[] = [];
    createCommanderPokeSender(unusedDb, { env: unreadableEnv, log: (m) => lines.push(m) });
    // Exactly one line: the old code logged "inert" here AND kept running, so a second, softer
    // "inert — no material configured" line alongside it would be the same ambiguity again.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("POKE SENDER DISABLED");
    expect(lines[0]).toContain("could not be read");
    // The cause, not just the verdict — the operator needs the path that failed.
    expect(lines[0]).toContain("/nonexistent/scp-poke-sender-cert.pem");
  });

  it("still logs the ordinary inert line when nothing is configured at all", () => {
    const lines: string[] = [];
    createCommanderPokeSender(unusedDb, { env: {}, log: (m) => lines.push(m) });
    // Not a misconfiguration: poke mode is opt-in and default-off, and that case must NOT shout.
    expect(lines).toEqual(["poke sender inert — no outbound mTLS client-cert material configured"]);
  });
});

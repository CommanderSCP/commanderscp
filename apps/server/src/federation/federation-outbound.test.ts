import { describe, it, expect, afterEach } from "vitest";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import {
  FederationDialRefused,
  federationClientMtlsConfigured,
  federationDialJson,
  federationPeerRequiresMtls,
  resolveFederationClientMtls
} from "./federation-outbound.js";
import {
  FEDERATION_SYNC_INTERVAL_SECONDS,
  FEDERATION_SYNC_QUEUE,
  federationSyncLoopEnabled,
  startFederationSyncLoop
} from "./federation-sync.js";

/**
 * M14.0 unit coverage — the cert-resolution + FAIL-CLOSED path (PIECE 1) and the loop's opt-in +
 * interval (PIECE 2). No network / no DB — the mTLS round-trip and import are proven in
 * `federation-sync.integration.test.ts`.
 */
describe("M14.0 federation outbound mTLS dialer (fail-closed)", () => {
  it("resolveFederationClientMtls: unset env -> undefined (no client cert, the default)", () => {
    expect(resolveFederationClientMtls({})).toBeUndefined();
    expect(federationClientMtlsConfigured({})).toBe(false);
  });

  it("resolveFederationClientMtls: a HALF-configured cert/key pair fails LOUD (never silently degrades)", () => {
    expect(() =>
      resolveFederationClientMtls({ SCP_FEDERATION_MTLS_CERT_FILE: "/tmp/only-cert.pem" })
    ).toThrow(/both .* must be set together/);
    expect(() =>
      resolveFederationClientMtls({ SCP_FEDERATION_MTLS_KEY_FILE: "/tmp/only-key.pem" })
    ).toThrow(/both .* must be set together/);
  });

  it("federationClientMtlsConfigured: true only when BOTH cert and key file paths are present", () => {
    expect(
      federationClientMtlsConfigured({
        SCP_FEDERATION_MTLS_CERT_FILE: "/c",
        SCP_FEDERATION_MTLS_KEY_FILE: "/k"
      })
    ).toBe(true);
    expect(federationClientMtlsConfigured({ SCP_FEDERATION_MTLS_CERT_FILE: "/c" })).toBe(false);
  });

  it("federationPeerRequiresMtls: https requires mTLS; http / null does not", () => {
    expect(federationPeerRequiresMtls("https://commander.example.com")).toBe(true);
    expect(federationPeerRequiresMtls("HTTPS://Commander.Example.Com")).toBe(true);
    expect(federationPeerRequiresMtls("http://commander.internal")).toBe(false);
    expect(federationPeerRequiresMtls(null)).toBe(false);
    expect(federationPeerRequiresMtls(undefined)).toBe(false);
  });

  it("federationDialJson: an mTLS-required dial with NO client cert REFUSES (no plain-HTTP fallback)", async () => {
    await expect(
      federationDialJson({
        url: "https://commander.example.com/api/v1/federation/exports",
        body: { peer: "x", sinceSequence: 0 },
        requireMtls: true,
        mtls: undefined
      })
    ).rejects.toBeInstanceOf(FederationDialRefused);
  });
});

describe("M14.0 federation sync loop (opt-in + interval)", () => {
  it("federationSyncLoopEnabled: DEFAULT-OFF — only SCP_FEDERATION_SYNC_LOOP=1 enables it", () => {
    expect(federationSyncLoopEnabled({})).toBe(false);
    expect(federationSyncLoopEnabled({ SCP_FEDERATION_SYNC_LOOP: "0" })).toBe(false);
    expect(federationSyncLoopEnabled({ SCP_FEDERATION_SYNC_LOOP: "true" })).toBe(false);
    expect(federationSyncLoopEnabled({ SCP_FEDERATION_SYNC_LOOP: "1" })).toBe(true);
  });

  it("interval has a 5s floor and defaults sensibly (bounded cadence, not the 1s reconcile tick)", () => {
    expect(FEDERATION_SYNC_INTERVAL_SECONDS).toBeGreaterThanOrEqual(5);
  });
});

/** A fake pg-boss that records queue creation / work registration / sends without touching Postgres —
 *  the work handler is registered but never invoked, so `runFederationSyncSweep` (and the DB) is
 *  never reached; this proves ONLY the loop's own wiring (inert-when-off, pull-on-startup send). */
function fakeBoss(): {
  boss: PgBoss;
  createdQueues: string[];
  workRegistrations: string[];
  sends: string[];
} {
  const createdQueues: string[] = [];
  const workRegistrations: string[] = [];
  const sends: string[] = [];
  const boss = {
    async createQueue(name: string) {
      createdQueues.push(name);
    },
    async work(name: string) {
      workRegistrations.push(name);
    },
    async send(name: string) {
      sends.push(name);
      return "job-id";
    }
  } as unknown as PgBoss;
  return { boss, createdQueues, workRegistrations, sends };
}

describe("M14.0 federation sync loop wiring (mirrors startInboxLoop)", () => {
  const original = process.env.SCP_FEDERATION_SYNC_LOOP;
  afterEach(() => {
    if (original === undefined) delete process.env.SCP_FEDERATION_SYNC_LOOP;
    else process.env.SCP_FEDERATION_SYNC_LOOP = original;
  });

  it("DEFAULT-OFF: no env -> inert handle, the queue is never created and nothing is scheduled", async () => {
    delete process.env.SCP_FEDERATION_SYNC_LOOP;
    const fake = fakeBoss();
    const handle = await startFederationSyncLoop(fake.boss, {} as unknown as Db);
    await handle.stop();
    expect(fake.createdQueues).toEqual([]);
    expect(fake.workRegistrations).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("enabled: creates the queue, registers the worker, and PULL-ON-STARTUP fires an immediate tick send", async () => {
    process.env.SCP_FEDERATION_SYNC_LOOP = "1";
    const fake = fakeBoss();
    const handle = await startFederationSyncLoop(fake.boss, {} as unknown as Db);
    await handle.stop();
    expect(fake.createdQueues).toEqual([FEDERATION_SYNC_QUEUE]);
    expect(fake.workRegistrations).toEqual([FEDERATION_SYNC_QUEUE]);
    // Exactly one immediate send (the pull-on-startup leg) — the self-reschedule send only fires
    // from inside the work handler, which this fake never invokes.
    expect(fake.sends).toEqual([FEDERATION_SYNC_QUEUE]);
  });
});

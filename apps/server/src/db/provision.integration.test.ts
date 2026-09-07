import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "./client.js";
import { provisionPgBossRole, provisionRuntimeRole } from "./provision.js";
import { testDatabaseUrl } from "../test-support/harness.js";

/** B9 — the credential-clobber guard. See docs/db.md §13. */
describe("B9: provisionRuntimeRole / provisionPgBossRole password-clobber guard", () => {
  const adminUrl = testDatabaseUrl();
  const adminPool = createPool(adminUrl);
  let role: string;

  beforeEach(() => {
    role = `scp_provision_probe_${randomUUID().replace(/-/g, "_")}`;
  });

  afterEach(async () => {
    const client = await adminPool.connect();
    try {
      await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(role)}`);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await adminPool.end();
  });

  /** Black-box: does `user`/`password` actually authenticate against this test's database? */
  async function canConnectAs(user: string, password: string): Promise<boolean> {
    const url = new URL(adminUrl);
    url.username = encodeURIComponent(user);
    url.password = encodeURIComponent(password);
    const client = new pg.Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5000
    });
    try {
      await client.connect();
      return true;
    } catch (err) {
      const code = (err as { code?: unknown } | null | undefined)?.code;
      if (typeof code === "string" && code.startsWith("28")) return false;
      throw err;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  it("(a) fresh role: creates it with LOGIN + the configured password, and it can connect", async () => {
    const before = await adminPool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    expect(before.rowCount).toBe(0);

    await provisionRuntimeRole(adminPool, role, "initial-pw-1");

    const after = await adminPool.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
      [role]
    );
    expect(after.rows[0]?.rolcanlogin).toBe(true);
    await expect(canConnectAs(role, "initial-pw-1")).resolves.toBe(true);
  });

  it("a role that already exists but was created NOLOGIN (the migration shape, e.g. drizzle/0002's `CREATE ROLE scp_app NOLOGIN ...`) gets LOGIN + the configured password on first provisioning, with no verification misfire", async () => {
    // Mirrors what migrations leave before first boot provisions. See docs/db.md §14.
    const client = await adminPool.connect();
    try {
      await client.query(
        `CREATE ROLE ${client.escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
    } finally {
      client.release();
    }

    await provisionRuntimeRole(adminPool, role, "first-pw");

    await expect(canConnectAs(role, "first-pw")).resolves.toBe(true);
  });

  it("(b) re-provisioning with the SAME password is a no-op: no error, prior password still valid", async () => {
    await provisionRuntimeRole(adminPool, role, "same-pw");

    await expect(provisionRuntimeRole(adminPool, role, "same-pw")).resolves.toBeUndefined();

    await expect(canConnectAs(role, "same-pw")).resolves.toBe(true);
  });

  it("(c) DIFFERENT password refuses, names the clobber hazard, and leaves the live credential untouched", async () => {
    await provisionRuntimeRole(adminPool, role, "cluster-a-pw");

    await expect(provisionRuntimeRole(adminPool, role, "cluster-b-pw")).rejects.toThrow(
      /clobbered/i
    );

    // The refusal must be REAL, not merely a thrown message: cluster A's credential is still live,
    // and cluster B's was never applied.
    await expect(canConnectAs(role, "cluster-a-pw")).resolves.toBe(true);
    await expect(canConnectAs(role, "cluster-b-pw")).resolves.toBe(false);
  });

  it("(d) different password + allowPasswordReset: true performs the deliberate reset", async () => {
    await provisionRuntimeRole(adminPool, role, "old-pw");

    await provisionRuntimeRole(adminPool, role, "new-pw", { allowPasswordReset: true });

    await expect(canConnectAs(role, "new-pw")).resolves.toBe(true);
    await expect(canConnectAs(role, "old-pw")).resolves.toBe(false);
  });

  it("SCP_PROVISION_ALLOW_PASSWORD_RESET=1 makes reset the default with no explicit option", async () => {
    await provisionRuntimeRole(adminPool, role, "old-pw-2");

    const prev = process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET;
    process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET = "1";
    try {
      await provisionRuntimeRole(adminPool, role, "new-pw-2");
    } finally {
      if (prev === undefined) delete process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET;
      else process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET = prev;
    }

    await expect(canConnectAs(role, "new-pw-2")).resolves.toBe(true);
    await expect(canConnectAs(role, "old-pw-2")).resolves.toBe(false);
  });

  it("a connectivity-class failure (not auth) during the probe propagates rather than being read as a mismatch", async () => {
    await provisionRuntimeRole(adminPool, role, "pw-1");

    // Connection limit zero makes every future attempt fail loudly. See docs/db.md §15.
    const client = await adminPool.connect();
    try {
      await client.query(`ALTER ROLE ${client.escapeIdentifier(role)} CONNECTION LIMIT 0`);
    } finally {
      client.release();
    }

    await expect(provisionRuntimeRole(adminPool, role, "pw-1")).rejects.toMatchObject({
      code: "53300"
    });
  });

  it("provisionPgBossRole applies the same guard (refuses on mismatch, leaves the live credential untouched)", async () => {
    await provisionPgBossRole(adminPool, role, "boss-pw-a");

    await expect(provisionPgBossRole(adminPool, role, "boss-pw-b")).rejects.toThrow(/clobbered/i);

    await expect(canConnectAs(role, "boss-pw-a")).resolves.toBe(true);
    await expect(canConnectAs(role, "boss-pw-b")).resolves.toBe(false);
  });

  it("(PV-1, §7.5 credential-clobber) two clusters CONCURRENTLY provisioning a NOLOGIN role with DIFFERENT passwords: exactly one wins, the other is forced onto verify-or-refuse — never a silent clobber", async () => {
    // The exact bootstrap race B9 must survive. See docs/db.md §16.
    const ITERATIONS = 8;
    for (let i = 0; i < ITERATIONS; i++) {
      const raceRole = `scp_provision_race_${randomUUID().replace(/-/g, "_")}`;
      const client = await adminPool.connect();
      try {
        await client.query(
          `CREATE ROLE ${client.escapeIdentifier(raceRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
        );
      } finally {
        client.release();
      }

      try {
        const results = await Promise.allSettled([
          provisionRuntimeRole(adminPool, raceRole, "cluster-a-pw"),
          provisionRuntimeRole(adminPool, raceRole, "cluster-b-pw")
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        // One blind winner; the loser MUST have been forced onto verify-or-refuse, not its own blind
        // ALTER. (Without the lock, BOTH fulfill — the silent clobber — which fails here.)
        expect(fulfilled, `iteration ${i}: exactly one provisioning should win`).toHaveLength(1);
        expect(rejected, `iteration ${i}: the loser must refuse, not clobber`).toHaveLength(1);
        expect(String(rejected[0]!.reason)).toMatch(/clobbered/i);

        // Coherent outcome: EXACTLY one password is live (the winner's), never both/neither.
        const aLive = await canConnectAs(raceRole, "cluster-a-pw");
        const bLive = await canConnectAs(raceRole, "cluster-b-pw");
        expect(aLive, `iteration ${i}: exactly one password must be live`).not.toBe(bLive);
      } finally {
        const cleanup = await adminPool.connect();
        try {
          await cleanup.query(`DROP ROLE IF EXISTS ${cleanup.escapeIdentifier(raceRole)}`);
        } finally {
          cleanup.release();
        }
      }
    }
  }, 60_000);
});

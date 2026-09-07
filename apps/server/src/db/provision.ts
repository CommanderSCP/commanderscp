import pg from "pg";

const { Client } = pg;

/** An env flag restores the unconditional password rotation. See docs/db.md §17. */
function passwordResetAllowedByDefault(): boolean {
  return process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET === "1";
}

/** True for a Postgres SQLSTATE class-28 error. See docs/db.md §18. */
function isAuthenticationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("28");
}

/** Connects only to learn whether the password already matches. See docs/db.md §19. */
async function passwordMatchesLiveRole(
  adminPool: pg.Pool,
  user: string,
  password: string
): Promise<boolean> {
  const adminConnectionString = adminPool.options.connectionString;
  if (!adminConnectionString) {
    // Every construction site in this codebase goes through db/client.ts's `createPool` (or, in
    // test-support, a bare `new pg.Pool({ connectionString })`) — both always set this.
    throw new Error(
      "provisionRuntimeRole/provisionPgBossRole's password-verification probe requires the admin " +
        "pool to have been constructed with a connectionString"
    );
  }
  const probeUrl = new URL(adminConnectionString);
  probeUrl.username = encodeURIComponent(user);
  probeUrl.password = encodeURIComponent(password);
  const probe = new Client({
    connectionString: probeUrl.toString(),
    connectionTimeoutMillis: 5000
  });
  try {
    await probe.connect();
    return true;
  } catch (err) {
    if (isAuthenticationError(err)) return false;
    throw err;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

/** The shared compare-and-skip implementation behind both roles. See docs/db.md §20. */
/** Namespace classid for this module's per-role provisioning advisory lock, kept distinct from
 *  every other `pg_advisory_*` key in the codebase (db-clone.ts's `0x5c70c10e`, the per-org audit/
 *  journal `hashtext(orgId)` locks, coordination/advisory-lock.ts's change keys). Paired with
 *  `hashtext(role)` as the second int, so the lock is per-role. */
const PROVISION_ADVISORY_CLASSID = 0x5c_70_50_72;

async function ensureManagedRolePassword(
  adminPool: pg.Pool,
  role: string,
  password: string,
  allowPasswordReset: boolean
): Promise<void> {
  // Serialize the WHOLE read-decide-write per role. See docs/db.md §21.
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      PROVISION_ADVISORY_CLASSID,
      role
    ]);

    const existsResult = await client.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = $1",
      [role]
    );
    const existingRow = existsResult.rows[0];
    const roleIdent = client.escapeIdentifier(role);
    const passwordLit = client.escapeLiteral(password);

    if (!existingRow) {
      await client.query(`CREATE ROLE ${roleIdent} WITH LOGIN PASSWORD ${passwordLit}`);
      await client.query("COMMIT");
      return;
    }

    if (!existingRow.rolcanlogin) {
      // First provisioning of the migration-created NOLOGIN shell. Now serialized: a concurrent
      // second caller blocks on the advisory lock above and, on re-read, sees `rolcanlogin = true`.
      await client.query(`ALTER ROLE ${roleIdent} WITH LOGIN PASSWORD ${passwordLit}`);
      await client.query("COMMIT");
      return;
    }

    // Genuine re-provisioning: the role already has a LIVE password. Verify by actually connecting
    // as it (never by comparing anything at rest). The probe uses its own separate connection; the
    // advisory lock on THIS transaction's connection is held throughout, so a racing caller cannot
    // slip a clobbering ALTER in between the verify and the decision below.
    if (await passwordMatchesLiveRole(adminPool, role, password)) {
      await client.query("COMMIT");
      return; // Already correct — no ALTER, nothing to clobber.
    }

    if (!allowPasswordReset) {
      await client.query("ROLLBACK");
      throw new Error(
        `[scpd] refusing to reset the password for role "${role}": a connection using the ` +
          "configured password failed authentication, which means this role's LIVE password on the " +
          "shared database differs from what THIS cluster is configured with — another member " +
          "cluster's credentials would be clobbered. Set postgres.existingSecret identically across " +
          "member clusters, or set SCP_PROVISION_ALLOW_PASSWORD_RESET=1 to rotate deliberately."
      );
    }

    await client.query(`ALTER ROLE ${roleIdent} WITH LOGIN PASSWORD ${passwordLit}`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Boot-time runtime-role provisioning. See docs/db.md §22. */
export async function provisionRuntimeRole(
  adminPool: pg.Pool,
  runtimeUser: string,
  runtimePassword: string,
  options?: { allowPasswordReset?: boolean }
): Promise<void> {
  await ensureManagedRolePassword(
    adminPool,
    runtimeUser,
    runtimePassword,
    options?.allowPasswordReset ?? passwordResetAllowedByDefault()
  );
}

/** Boot-time pg-boss role provisioning. See docs/db.md §23. */
export async function provisionPgBossRole(
  adminPool: pg.Pool,
  pgBossUser: string,
  pgBossPassword: string,
  options?: { allowPasswordReset?: boolean }
): Promise<void> {
  await ensureManagedRolePassword(
    adminPool,
    pgBossUser,
    pgBossPassword,
    options?.allowPasswordReset ?? passwordResetAllowedByDefault()
  );
}

/** Derives the runtime. See docs/db.md §24. */
export function deriveRuntimeDatabaseUrl(
  adminDatabaseUrl: string,
  runtimeUser = "scp_app"
): string {
  const url = new URL(adminDatabaseUrl);
  url.username = runtimeUser;
  return url.toString();
}

/** Extracts the user + password the runtime pool will authenticate with (for provisioning). */
export function runtimeCredentials(runtimeDatabaseUrl: string): { user: string; password: string } {
  const url = new URL(runtimeDatabaseUrl);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password)
  };
}

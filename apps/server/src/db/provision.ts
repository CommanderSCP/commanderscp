import pg from "pg";

const { Client } = pg;

/**
 * `SCP_PROVISION_ALLOW_PASSWORD_RESET=1` restores the pre-B9 unconditional-ALTER behavior for a
 * deliberate, operator-initiated password rotation (proposal multi-region-instance-resilience.md
 * §4-B9, §7.4). Read directly from `process.env` rather than through `config.ts`: `config.ts`
 * itself imports `deriveRuntimeDatabaseUrl` from this module, so importing `loadConfig` back here
 * would be circular. Every call site may still override per-call via the `allowPasswordReset`
 * option (used by the guard's own tests).
 */
function passwordResetAllowedByDefault(): boolean {
  return process.env.SCP_PROVISION_ALLOW_PASSWORD_RESET === "1";
}

/**
 * True for a Postgres SQLSTATE class-28 error ("Invalid Authorization Specification" — 28000 role/
 * db mismatch, 28P01 bad password): the ONLY signal that means "this role's live password differs
 * from what we're configured with." Anything else (refused connection, DNS failure, timeout, the
 * role's own CONNECTION LIMIT) is a connectivity failure, not evidence of a clobber risk, and must
 * propagate instead of being read as "needs a reset."
 */
function isAuthenticationError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("28");
}

/**
 * Connects as `user`/`password` against the same server + database `adminPool` targets, purely to
 * find out whether that password is ALREADY the role's live password — a read, never a write.
 * Returns `true` (matches — the ALTER can be skipped), `false` (a class-28 auth failure — a
 * DIFFERENT password is live), or throws (a non-auth connectivity failure, which proves nothing
 * about the password and must not be treated as a mismatch).
 */
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

/**
 * Shared implementation behind `provisionRuntimeRole`/`provisionPgBossRole` (B9 —
 * multi-region-instance-resilience.md §4-B9, §7.4's "compare-and-skip-or-refuse rather than
 * unconditional reset"). The old behavior was `ALTER ROLE ... WITH LOGIN PASSWORD` unconditionally,
 * every boot — harmless for one cluster, but a second member cluster installed against the SAME
 * shared database with its OWN independently-generated password would silently clobber the first
 * cluster's live credentials on every one of ITS boots. Now:
 *
 *   - role doesn't exist yet → CREATE it with LOGIN + the configured password.
 *   - role exists but has never been granted LOGIN before (`rolcanlogin = false` — this is what
 *     the migration files leave it as: `CREATE ROLE scp_app NOLOGIN ...`, drizzle/0002 etc.) →
 *     there is no LIVE password to clobber, so this is a FIRST provisioning wearing the role's
 *     migration-created shell, not a re-provisioning. Grant LOGIN + the configured password
 *     directly (via ALTER, since the role object already exists) — no verification needed or
 *     possible, since a NOLOGIN role rejects every password with the SAME class-28 error a real
 *     mismatch would, which would otherwise misfire this guard on every fresh install.
 *   - role exists AND already has LOGIN (a previous boot provisioned it) — this is a genuine
 *     RE-provisioning. If the configured password is ALREADY live (verified by actually
 *     connecting as it, never by comparing anything at rest) → skip the ALTER. Nothing to clobber.
 *     If it is NOT live → refuse loudly, naming the hazard, unless `allowPasswordReset` is set, in
 *     which case this falls back to the old unconditional ALTER for a deliberate,
 *     operator-initiated rotation.
 */
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
  // Serialize the WHOLE read-decide-write per role (review finding PV-1). Without this, two member
  // clusters' migration Jobs bootstrapping concurrently both read the role while it is still
  // NOLOGIN (the migration-created shell), both take the "first provisioning" branch, and both
  // blindly `ALTER ROLE ... PASSWORD` — the second silently clobbers the first's credentials, the
  // exact failure B9 exists to prevent, just at first boot. A transaction-level advisory lock
  // (auto-released on COMMIT/ROLLBACK) makes the second caller wait, then re-read AFTER the first
  // committed LOGIN — so it sees `rolcanlogin = true` and falls into the verify-or-refuse branch
  // instead of a blind ALTER. The whole sequence therefore runs on ONE held connection.
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

/**
 * Boot-time runtime-role provisioning (PR #4 review, CRITICAL 3). Runs over the admin/bootstrap
 * connection immediately after migrations, then the admin pool is closed — the request-serving
 * pool connects as the login role provisioned here and never sees superuser privileges.
 *
 * The migration files fix `scp_app`'s privilege shape (NOSUPERUSER, NOBYPASSRLS, table grants,
 * RLS policies — drizzle/0002, 0003); this only grants LOGIN and sets the password, which cannot
 * live in committed SQL. Idempotent: safe on every boot.
 *
 * B9 GUARD (multi-region-instance-resilience.md §4-B9, §7.4): does NOT unconditionally reset the
 * password any more — see `ensureManagedRolePassword`'s doc comment above. `options.
 * allowPasswordReset` defaults to `SCP_PROVISION_ALLOW_PASSWORD_RESET=1` when omitted.
 */
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

/**
 * Boot-time pg-boss role provisioning (M3 tracked security follow-up: pg-boss no longer connects
 * on the admin/superuser URL for its own `pgboss` schema). Same mechanism and same reasoning as
 * `provisionRuntimeRole` above — drizzle/0008_pgboss_role.sql fixes `scp_pgboss`'s privilege
 * shape (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, owns only the `pgboss` schema, no grants on `public`
 * at all); this only grants LOGIN and sets the password, which cannot live in committed SQL. A
 * distinct function (rather than reusing `provisionRuntimeRole` under this name) keeps main.ts's
 * boot sequence self-documenting: each role provisioned in Phase 1 gets its own named call.
 * Idempotent: safe on every boot.
 *
 * B9 GUARD: same compare-and-skip-or-refuse behavior as `provisionRuntimeRole` — see
 * `ensureManagedRolePassword`.
 */
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

/**
 * Derives the runtime (least-privileged) connection string from the admin one: same host, port,
 * database, and password — only the user is swapped to `scp_app`. Operators who manage the role
 * themselves override with an explicit SCP_RUNTIME_DATABASE_URL instead.
 */
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

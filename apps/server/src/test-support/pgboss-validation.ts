import PgBoss from "pg-boss";

/** A connection string that cannot resolve: these probes must never reach a database. */
const UNREACHABLE = "postgres://u:p@127.0.0.1:1/none";

/** Run pg-boss's REAL send-time validation against a set of send options.
 *
 *  `Manager.send` calls `Attorney.checkSendArgs` before `createJob`, so an instance that was never
 *  `start()`ed still reaches every assert and only then fails on the absent connection. That lets a
 *  unit test check the library's actual rule instead of a local restatement of it — so a pg-boss
 *  upgrade that moves the bound fails the test rather than silently invalidating our constant.
 *
 *  @returns the assertion message if pg-boss REJECTED the options, or `undefined` if they got past
 *  validation (any later database failure is expected and deliberately swallowed). */
export async function pgBossSendRejection(options: unknown): Promise<string | undefined> {
  const boss = new PgBoss({ connectionString: UNREACHABLE, schema: "pgboss" });
  try {
    await boss.send("probe-queue", {}, options as Parameters<PgBoss["send"]>[2]);
    return undefined;
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return error.code === "ERR_ASSERTION" ? String(error.message) : undefined;
  }
}

/** Apply pg-boss's real send-time validation, throwing exactly as pg-boss would.
 *
 *  For use inside a FAKE boss. A fake whose `send` accepts options the real one rejects turns
 *  every assertion about the send into a statement about the fake: the reschedule that throws in
 *  production resolves happily under test, and the loop looks alive. Route a fake's `send` through
 *  this and the fake fails where the real client fails. */
export async function assertPgBossWouldAccept(options: unknown): Promise<void> {
  const rejection = await pgBossSendRejection(options);
  if (rejection === undefined) return;
  const error = new Error(rejection) as Error & { code?: string };
  error.code = "ERR_ASSERTION";
  throw error;
}

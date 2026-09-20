/** pg-boss's send-time bound on a singleton window, and the clamp that keeps loops inside it.
 *
 *  This module deliberately imports nothing: it is pulled in by every self-rescheduling loop in
 *  coordination/ and federation/, and a cycle here would resolve the constant to `undefined` at
 *  runtime with no error (see the import-cycle hazard in docs/BUILD_AND_TEST.md §4.4). */

/** pg-boss asserts `singletonSeconds <= archiveSeconds` in `attorney.js` `checkSendArgs`, where
 *  `archiveSeconds = archiveCompletedAfterSeconds || ARCHIVE_DEFAULT` and `ARCHIVE_DEFAULT` is 12h.
 *  `startPgBoss` (events/pgboss.ts) constructs PgBoss without `archiveCompletedAfterSeconds`, so
 *  the default is the live bound. Change that constructor and this constant goes stale silently —
 *  `pgboss-singleton-window.test.ts` fails if an archive override ever appears. */
export const PGBOSS_ARCHIVE_SECONDS = 43_200;

/** Clamp a loop's interval to the widest singleton window pg-boss will accept.
 *
 *  Apply to `singletonSeconds` ONLY — never to `startAfter`, which carries the loop's real cadence
 *  and has no such bound. A 24h loop stays a 24h loop; it just dedupes on a 12h bucket, which is
 *  still far wider than the burst of concurrent reschedules the key exists to collapse.
 *
 *  Unclamped, an interval above the bound makes `boss.send` THROW at the end of the handler — the
 *  very call that files the next tick. The sweep that already ran looks fine, the job is marked
 *  failed, and the chain is dead until the next process restart, with no error surface above the
 *  job row. That is how `dependency-version-poll-tick` shipped broken at its own default of
 *  86400s: every tick failed at the reschedule, so it only ever ran on a worker boot. */
export function clampSingletonSeconds(seconds: number): number {
  return Math.min(seconds, PGBOSS_ARCHIVE_SECONDS);
}

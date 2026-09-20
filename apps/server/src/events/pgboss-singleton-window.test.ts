import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchingParen, productionSourceFiles, readStripped } from "@scp/source-census";
import { pgBossSendRejection } from "../test-support/pgboss-validation.js";
import { PGBOSS_ARCHIVE_SECONDS, clampSingletonSeconds } from "./pgboss-limits.js";

/** pg-boss refuses a singleton window wider than its archive interval, and it refuses it at SEND
 *  time — inside the handler that files the next tick. An unclamped interval therefore does not
 *  misconfigure a loop, it KILLS it: the sweep runs, the reschedule throws, and the chain is gone
 *  until the process restarts. See docs/coordination.md and dependencies/version-poll.ts. */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

const SEND_CALL = /boss\.send\s*\(/g;
const HAS_WINDOW = /singletonSeconds\s*:/;
/** THE REQUIRED SHAPE: the window must be the clamp's return value, not a raw interval. */
const CLAMPED_WINDOW = /singletonSeconds\s*:\s*clampSingletonSeconds\s*\(/;

function sendCallArguments(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(SEND_CALL)) {
    const openParen = match.index + match[0].length - 1;
    const close = matchingParen(source, openParen);
    if (close === -1) continue;
    calls.push(source.slice(openParen + 1, close));
  }
  return calls;
}

describe("PGBOSS_ARCHIVE_SECONDS is pg-boss's real bound, not our belief about it", () => {
  it("the bound itself is ACCEPTED by pg-boss", async () => {
    expect(
      await pgBossSendRejection({ startAfter: 1, singletonSeconds: PGBOSS_ARCHIVE_SECONDS })
    ).toBeUndefined();
  });

  it("KNOWN-POSITIVE CONTROL — one second above the bound is REJECTED", async () => {
    // Without this the test above passes just as well against a probe that can never reject
    // anything, which is the failure mode that let the original defect ship green.
    const rejection = await pgBossSendRejection({
      startAfter: 1,
      singletonSeconds: PGBOSS_ARCHIVE_SECONDS + 1
    });
    expect(rejection).toMatch(/cannot exceed archive interval/);
  });

  it("the shipped default that broke dependency-version-poll is rejected, and the clamp fixes it", async () => {
    const broken = 86_400;
    expect(await pgBossSendRejection({ startAfter: broken, singletonSeconds: broken })).toMatch(
      /throttling interval 86400s cannot exceed archive interval 43200s/
    );
    expect(
      await pgBossSendRejection({
        startAfter: broken,
        singletonSeconds: clampSingletonSeconds(broken)
      })
    ).toBeUndefined();
  });

  it("startPgBoss does not override archiveCompletedAfterSeconds (which would move the bound)", () => {
    // The constant is only correct while the boss is built on pg-boss's ARCHIVE_DEFAULT. If an
    // override is ever added, this fails here rather than at 3am inside a loop handler.
    const source = readStripped(join(SERVER_SRC, "events/pgboss.ts"));
    expect(source).toContain("new PgBoss(");
    expect(source).not.toContain("archiveCompletedAfterSeconds");
  });
});

describe("every self-rescheduling loop clamps its singleton window", () => {
  const files = productionSourceFiles(SERVER_SRC);

  it("finds production source files to census at all (the census is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the windowed sends it exists to police (the census target exists)", () => {
    const windowed = files.flatMap((file) =>
      sendCallArguments(readStripped(file)).filter((args) => HAS_WINDOW.test(args))
    );
    // Eight loops carry a window today. If this collapses toward zero the matcher has drifted and
    // the assertion below would pass by finding nothing.
    expect(windowed.length).toBeGreaterThanOrEqual(8);
  });

  it("no boss.send opens a singleton window from an unclamped interval", () => {
    const offenders: { file: string; snippet: string }[] = [];
    for (const file of files) {
      for (const args of sendCallArguments(readStripped(file))) {
        if (!HAS_WINDOW.test(args)) continue;
        if (CLAMPED_WINDOW.test(args)) continue;
        offenders.push({
          file: relative(SERVER_SRC, file),
          snippet: args.replace(/\s+/g, " ").trim().slice(0, 120)
        });
      }
    }

    expect(
      offenders,
      "a `boss.send` sets `singletonSeconds` from a raw interval. pg-boss asserts " +
        "`singletonSeconds <= archiveSeconds` (12h) at SEND time, so if that interval is ever " +
        "configured above the bound the reschedule throws INSIDE the tick handler: the sweep " +
        "completes, the next tick is never filed, and the loop is dead until the process restarts " +
        "— no error surface, no failing health check, just a `failed` job row. Wrap the value in " +
        "`clampSingletonSeconds(...)` (events/pgboss-limits.ts). Clamp the WINDOW only; " +
        "`startAfter` carries the real cadence and has no such bound."
    ).toEqual([]);
  });

  it("the matcher would still catch the original defect (it is not just re-passing)", () => {
    const original = `DEPENDENCY_VERSION_POLL_QUEUE, {}, { startAfter: interval, singletonKey: "tick", singletonSeconds: interval }`;
    const fixed = `DEPENDENCY_VERSION_POLL_QUEUE, {}, { startAfter: interval, singletonKey: "tick", singletonSeconds: clampSingletonSeconds(interval) }`;
    const noWindow = `DEPENDENCY_VERSION_POLL_QUEUE, {}`;

    const flagged = (args: string) => HAS_WINDOW.test(args) && !CLAMPED_WINDOW.test(args);

    expect(flagged(original), "the shipped defect must be caught").toBe(true);
    expect(flagged(fixed), "the fixed shape must NOT be caught").toBe(false);
    expect(flagged(noWindow), "an unkeyed startup kick has no window, so is not flagged").toBe(
      false
    );
  });
});

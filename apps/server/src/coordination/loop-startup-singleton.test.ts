import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchingParen, productionSourceFiles, readStripped } from "@scp/source-census";

/**
 * ================================================================================================
 * A STARTUP KICK MAY NEVER SHARE THE INTERVAL CHAIN'S SINGLETON KEY
 * ================================================================================================
 *
 * THE PROPERTY: *a self-rescheduling pg-boss loop's STARTUP `boss.send` must not carry the same
 * `singletonKey` as the reschedule inside its own handler.*
 *
 * WHY IT IS FATAL, in pg-boss's own terms (10.4.2, `src/plans.js`):
 *   - the unique index is `(name, singleton_on, COALESCE(singleton_key,''))` WHERE `state <>
 *     'cancelled'`, so a COMPLETED or ACTIVE job STILL HOLDS the slot;
 *   - `singleton_on` is a wall-clock BUCKET (`floor(epoch/singletonSeconds)*singletonSeconds`);
 *   - a losing insert is `ON CONFLICT DO NOTHING RETURNING id` — it returns NULL **silently**, and
 *     no call site checks.
 * A self-rescheduling loop's only other source of ticks is the reschedule inside its handler, so one
 * swallowed send means no job -> no handler -> no reschedule -> **the loop is dead forever**, with no
 * error, no log, and no failing health check. That is the same shape as the starvation bug that
 * stopped production coordination for 13 days behind green health checks (CLAUDE.md).
 *
 * THIS IS NOT HYPOTHETICAL. M26.1's §4-A4 item gave six loops' startup sends the chain's `"tick"`
 * key. Measured: a 60s loop's first reschedule (sent ~2s after its startup job, inside the SAME 60s
 * bucket) was swallowed by that just-completed startup job — the loop ran ONE sweep and died, on
 * ~58 of every 60 boots, in production as well as in tests. It reached CI as four integration files
 * timing out waiting for engine progress, with no error anywhere.
 *
 * THE REMEDY IS AN UNKEYED STARTUP SEND — no key and no window, so it ALWAYS inserts
 * (`LOOP_STARTUP_SEND_IS_UNKEYED`, events/pgboss.ts). A distinct key with a short window was tried
 * second and is ALSO wrong: it fixed the chain collision but then swallowed a crash-restarted
 * worker's kick with that worker's OWN previous boot, killing crash resumption. Any key+window can
 * swallow, because job_i4 counts completed jobs; only "no window" cannot. §4-A4's replica dedupe is
 * deliberately given up — redundant sweeps are safe (FOR UPDATE SKIP LOCKED), a dead loop is not.
 *
 * HOW THIS CENSUS DECIDES. Within each `boss.send(...)` call, a `startAfter` marks the RESCHEDULE
 * (the chain deliberately owns `"tick"`); a send WITHOUT `startAfter` is a startup kick, and a
 * startup kick carrying `singletonKey: "tick"` is the defect. Comment-stripped so a doc comment
 * quoting the bad shape (there is one, in events/pgboss.ts) cannot trip it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

const SEND_CALL = /boss\.send\s*\(/g;
const CHAIN_KEY = /singletonKey\s*:\s*"tick"/;
const RESCHEDULE_MARKER = /startAfter\s*:/;

interface Offender {
  file: string;
  snippet: string;
}

/** Every `boss.send(...)` argument list in one file, source-order, as text. */
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

describe("a loop's startup kick never reuses the interval chain's singleton key", () => {
  const files = productionSourceFiles(SERVER_SRC);

  it("finds production source files to census at all (the census is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the boss.send call sites it exists to police (the census target exists)", () => {
    const withSends = files.filter((file) => sendCallArguments(readStripped(file)).length > 0);
    // Seven self-rescheduling loops plus the wake paths — if this collapses toward zero the matcher
    // has drifted and every assertion below would pass vacuously.
    expect(withSends.length).toBeGreaterThanOrEqual(6);
  });

  it("the chain reschedules DO still use the shared 'tick' key (the other half of the contract)", () => {
    const chainSends = files.flatMap((file) =>
      sendCallArguments(readStripped(file)).filter(
        (args) => RESCHEDULE_MARKER.test(args) && CHAIN_KEY.test(args)
      )
    );
    expect(
      chainSends.length,
      'no reschedule carries `singletonKey: "tick"` any more — either the loops changed shape or ' +
        "this census's matcher has drifted; in both cases the startup assertion below is vacuous"
    ).toBeGreaterThanOrEqual(6);
  });

  it("no STARTUP send (a boss.send with no startAfter) carries the chain's 'tick' key", () => {
    const offenders: Offender[] = [];
    for (const file of files) {
      for (const args of sendCallArguments(readStripped(file))) {
        if (RESCHEDULE_MARKER.test(args)) continue; // the reschedule legitimately owns "tick"
        if (!CHAIN_KEY.test(args)) continue;
        offenders.push({
          file: relative(SERVER_SRC, file),
          snippet: args.replace(/\s+/g, " ").trim().slice(0, 120)
        });
      }
    }

    expect(
      offenders,
      'a self-rescheduling loop\'s STARTUP send carries `singletonKey: "tick"`, the same key its ' +
        "own reschedule uses. pg-boss counts COMPLETED jobs as holding the singleton slot, so one of " +
        "the two is silently dropped (ON CONFLICT DO NOTHING) and the loop can die after a single " +
        "sweep with no error at all. Send the startup kick UNKEYED — `boss.send(QUEUE, {})` with no " +
        "singletonKey and no window (see LOOP_STARTUP_SEND_IS_UNKEYED in events/pgboss.ts). Do not " +
        "reach for a private key + short window instead: that was tried, and it swallowed a " +
        "crash-restarted worker's kick with that worker's own previous boot."
    ).toEqual([]);
  });
});

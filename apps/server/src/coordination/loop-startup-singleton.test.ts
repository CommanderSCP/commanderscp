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

/**
 * THE INGREDIENT THAT MAKES A SEND SWALLOWABLE — `singletonSeconds`, not `singletonKey`.
 *
 * `job_i4` is `(name, singleton_on, COALESCE(singleton_key,'')) WHERE state <> 'cancelled' AND
 * singleton_on IS NOT NULL`, and `singleton_on` is populated ONLY when `singletonSeconds` is passed.
 * So:
 *   - a key WITHOUT seconds constrains nothing at all under the standard policy (no `singleton_on`
 *     ⇒ the row is not in the index). `internal-release-loop.ts` and `inventory-ingestion-loop.ts`
 *     both send `{singletonKey: changeObjectId}` in that shape;
 *   - seconds WITHOUT a key still takes a slot, since the key is `COALESCE(singleton_key,'')`.
 * Matching on `singletonSeconds` therefore catches every immediate send that pg-boss can silently
 * drop, and only those. Matching on the literal `"tick"` — which is all this census originally did —
 * missed the second occurrence of this very bug, where the key was `"startup"`.
 */
const SWALLOWABLE_WINDOW = /singletonSeconds\s*:/;

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

  it("no IMMEDIATE send (a boss.send with no startAfter) opens a singleton window at all", () => {
    const offenders: Offender[] = [];
    for (const file of files) {
      for (const args of sendCallArguments(readStripped(file))) {
        if (RESCHEDULE_MARKER.test(args)) continue; // the reschedule legitimately owns "tick"
        if (!SWALLOWABLE_WINDOW.test(args)) continue;
        offenders.push({
          file: relative(SERVER_SRC, file),
          snippet: args.replace(/\s+/g, " ").trim().slice(0, 120)
        });
      }
    }

    expect(
      offenders,
      "an IMMEDIATE `boss.send` carries `singletonSeconds`, which puts it in a wall-clock bucket that " +
        "pg-boss's job_i4 can already consider occupied. Because that index is `WHERE state <> " +
        "'cancelled'`, a COMPLETED job holds the slot too — so the job an immediate send most " +
        "reliably collides with is the one THIS PROCESS filed on its previous boot. The losing " +
        "insert is ON CONFLICT DO NOTHING RETURNING id: it returns NULL, nobody checks, and for a " +
        "self-rescheduling loop that means no job -> no handler -> no reschedule -> dead forever, " +
        "with no error, no log and no failing health check. Send it UNKEYED — `boss.send(QUEUE, {})` " +
        "(LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts). A private key with a short window is NOT " +
        "the answer; that was shipped as the fix and became the second occurrence of this bug."
    ).toEqual([]);
  });

  it("the widened rule would still have caught BOTH historical shapes (the census is not just re-passing)", () => {
    // Anti-regression for the CENSUS ITSELF. Occurrence 1 used the chain's key; occurrence 2 used a
    // private "startup" key — and the original matcher, which tested for the literal "tick", waved
    // the second one straight through while the defect was live in federation-sync. Both shapes are
    // asserted here as strings so the matcher cannot narrow back to one of them unnoticed.
    const occurrence1 = `RECONCILE_QUEUE, {}, { singletonKey: "tick", singletonSeconds: 60 }`;
    const occurrence2 = `FEDERATION_SYNC_QUEUE, { reason: "startup" }, { singletonKey: "startup", singletonSeconds: 10 }`;
    const fixed = `FEDERATION_SYNC_QUEUE, { reason: "startup" }`;
    const reschedule = `INBOX_QUEUE, {}, { startAfter: 60, singletonKey: "tick", singletonSeconds: 60 }`;
    const keyOnly = `INTERNAL_RELEASE_QUEUE, job, { singletonKey: changeObjectId }`;

    const flagged = (args: string) =>
      !RESCHEDULE_MARKER.test(args) && SWALLOWABLE_WINDOW.test(args);

    expect(flagged(occurrence1), "occurrence 1 (shared 'tick' key) must be caught").toBe(true);
    expect(flagged(occurrence2), "occurrence 2 (private 'startup' key) must be caught").toBe(true);
    expect(flagged(fixed), "the unkeyed fix must NOT be flagged").toBe(false);
    expect(flagged(reschedule), "a legitimate interval reschedule must NOT be flagged").toBe(false);
    expect(flagged(keyOnly), "a key with no window is inert under job_i4, so not flagged").toBe(
      false
    );
  });
});

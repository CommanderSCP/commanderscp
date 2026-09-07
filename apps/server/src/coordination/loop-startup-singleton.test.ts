import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchingParen, productionSourceFiles, readStripped } from "@scp/source-census";

/** A startup kick may never share the interval singleton key. See docs/coordination.md §553. */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

const SEND_CALL = /boss\.send\s*\(/g;
const CHAIN_KEY = /singletonKey\s*:\s*"tick"/;
const RESCHEDULE_MARKER = /startAfter\s*:/;

/** THE INGREDIENT THAT MAKES A SEND SWALLOWABLE. See docs/coordination.md §554. */
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
        if (RESCHEDULE_MARKER.test(args)) continue;
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

import { describe, expect, it } from "vitest";
import type { ExecutorEvent } from "@scp/plugin-api";
import {
  advanceWatermarks,
  parseCursorToken,
  serializeCursorToken,
  watermarkFor
} from "./observe.js";

/**
 * The observe cursor, and the starvation a single shared watermark caused.
 *
 * A git-provider adapter polls two resources with different TIME BASES and merges them:
 * `[...pollCommits(since), ...pollRuns(since)]`. Commits carry the author date; workflow runs carry
 * the run's creation time. A CI run is always created AFTER the commit that triggered it, so with
 * one watermark for both, the run dragged the cursor past its own commit and the next `?since=`
 * query excluded that commit **permanently** — skipped, not delayed.
 *
 * Measured on the homelab: commit `bfddca9` at `02:32:14Z` was never ingested, because the
 * `workflow_run` it triggered at `02:32:17Z` advanced the shared cursor three seconds past it.
 */

/**
 * A full snapshot of `Object.prototype`'s own property names, captured at module load. Asserting
 * that three named keys are absent only proves those three are absent; this proves NOTHING was
 * added or removed. A leaked pollution would make every later assertion in the run untrustworthy,
 * so it is checked rather than assumed.
 */
const OBJECT_PROTOTYPE_KEYS_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort().join(",");

describe("observe cursor: each event kind advances independently", () => {
  const ev = (kind: string, occurredAt: string) =>
    ({ kind, occurredAt, correlation: {}, raw: {} }) as ExecutorEvent;

  it("a workflow run does NOT drag the commit watermark past its own commit", () => {
    // The exact homelab sequence. Before the fix both kinds shared one watermark, so after this
    // tick the commit cursor read 02:32:17Z and the 02:32:14Z commit could never be returned again.
    const after = advanceWatermarks(
      [ev("push", "2026-08-02T02:32:14Z"), ev("workflow_run", "2026-08-02T02:32:17Z")],
      {}
    );

    expect(watermarkFor(after, "push")).toBe("2026-08-02T02:32:14Z");
    expect(watermarkFor(after, "workflow_run")).toBe("2026-08-02T02:32:17Z");
  });

  it("a tick carrying ONLY workflow runs leaves the commit watermark untouched", () => {
    // The steady-state version of the same starvation: CI is far chattier than commits, so most
    // ticks are runs-only. Those must not move the commit cursor forward at all.
    const before = { push: "2026-08-02T02:00:00Z", workflow_run: "2026-08-02T02:00:00Z" };
    const after = advanceWatermarks([ev("workflow_run", "2026-08-02T03:00:00Z")], before);

    expect(after.push).toBe("2026-08-02T02:00:00Z");
    expect(after.workflow_run).toBe("2026-08-02T03:00:00Z");
  });

  it("a watermark only ever moves FORWARD", () => {
    // Out-of-order arrivals must not rewind a cursor, or events already ingested would be re-polled
    // every tick forever.
    const after = advanceWatermarks([ev("push", "2026-08-01T00:00:00Z")], {
      push: "2026-08-02T00:00:00Z"
    });

    expect(after.push).toBe("2026-08-02T00:00:00Z");
  });

  it("a legacy scalar token seeds EVERY kind, so the first tick after upgrade cannot flood", () => {
    // Stored cursors are bare ISO strings. If an unseen kind started from nothing, the first poll
    // after this ships would re-fetch that resource's entire history.
    const marks = parseCursorToken("2026-08-02T02:32:17Z");

    expect(watermarkFor(marks, "push")).toBe("2026-08-02T02:32:17Z");
    expect(watermarkFor(marks, "workflow_run")).toBe("2026-08-02T02:32:17Z");
    expect(watermarkFor(marks, "sync")).toBe("2026-08-02T02:32:17Z");
  });

  it("a legacy scalar stops applying to a kind once that kind has its own watermark", () => {
    // The upgrade path in full: seed from the scalar, then diverge. A kind that has advanced must
    // read its OWN value, not the frozen legacy one.
    const seeded = parseCursorToken("2026-08-02T02:00:00Z");
    const after = advanceWatermarks([ev("workflow_run", "2026-08-02T03:00:00Z")], seeded);

    expect(watermarkFor(after, "workflow_run")).toBe("2026-08-02T03:00:00Z");
    expect(watermarkFor(after, "push")).toBe("2026-08-02T02:00:00Z");
  });

  it("round-trips through the stored token, and serializes stably", () => {
    const marks = advanceWatermarks(
      [ev("push", "2026-08-02T02:32:14Z"), ev("workflow_run", "2026-08-02T02:32:17Z")],
      {}
    );
    const token = serializeCursorToken(marks);

    expect(parseCursorToken(token)).toEqual(marks);
    // Key order must not churn the row on an unchanged cursor.
    expect(serializeCursorToken(marks)).toBe(token);
  });

  /**
   * `ExecutorEvent.kind` is a string a PLUGIN supplies, and nothing validates it against an
   * allow-list — `custom` exists precisely so a plugin can invent kinds. A kind of `__proto__`
   * therefore reaches the watermark map as a key, where on the base commit it hit
   * `Object.prototype`'s accessor instead of being stored.
   */
  describe("an event kind of __proto__ is an ordinary kind, not a hole in the cursor", () => {
    it("advances its watermark like any other kind (it used to be a permanent no-op)", () => {
      // MEASURED on the base commit: four ticks, and the mark set stayed `[]` the whole time while
      // a control kind advanced normally — so the cursor never moved and the provider was re-polled
      // from the same point on every tick, forever.
      let marks = parseCursorToken(null);
      for (const t of ["21", "22", "23", "24"]) {
        marks = advanceWatermarks([ev("__proto__", `2026-08-${t}T00:00:00Z`)], marks);
      }
      expect(Object.keys(marks)).toEqual(["__proto__"]);
      expect(watermarkFor(marks, "__proto__")).toBe("2026-08-24T00:00:00Z");
    });

    it("reads back as a timestamp, not as Object.prototype", () => {
      // Base commit returned the object itself, which reached the provider as `?since=[object
      // Object]`.
      const marks = advanceWatermarks(
        [ev("__proto__", "2026-08-24T00:00:00Z")],
        parseCursorToken(null)
      );
      const since = watermarkFor(marks, "__proto__");
      expect(typeof since).toBe("string");
      expect(`?since=${String(since)}`).not.toContain("[object Object]");
    });

    it("survives the serialize/parse round trip instead of being dropped from the token", () => {
      const marks = advanceWatermarks(
        [ev("__proto__", "2026-08-24T00:00:00Z"), ev("push", "2026-08-23T00:00:00Z")],
        parseCursorToken(null)
      );
      const token = serializeCursorToken(marks);
      expect(token).toContain("__proto__");
      const round = parseCursorToken(token);
      expect(watermarkFor(round, "__proto__")).toBe("2026-08-24T00:00:00Z");
      expect(watermarkFor(round, "push")).toBe("2026-08-23T00:00:00Z");
      expect(serializeCursorToken(round)).toBe(token);
    });

    it("does not let an inherited member masquerade as a watermark", () => {
      // `marks["toString"]` on a prototype-bearing object is a FUNCTION. `watermarkFor` must say
      // "no watermark", not hand a function to the provider.
      const marks = parseCursorToken('{"push":"2026-08-23T00:00:00Z"}');
      for (const inherited of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
        expect(watermarkFor(marks, inherited)).toBeUndefined();
      }
      // ... and a kind named after an inherited member still advances on its own merits.
      const after = advanceWatermarks([ev("toString", "2026-08-24T00:00:00Z")], marks);
      expect(watermarkFor(after, "toString")).toBe("2026-08-24T00:00:00Z");
    });

    it("leaves Object.prototype unmutated", () => {
      const probe = {} as Record<string, unknown>;
      expect(probe.polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, "_legacy")).toBe(false);
      // Not just the named keys: nothing was added to or removed from Object.prototype at all.
      expect(Object.getOwnPropertyNames(Object.prototype).sort().join(",")).toBe(
        OBJECT_PROTOTYPE_KEYS_AT_LOAD
      );
    });
  });

  it("a corrupt token degrades to no watermark rather than wedging the instance", () => {
    // Re-polling is safe — dedupe collapses anything already ingested — whereas a throw here would
    // stall observe for that instance on every tick, forever.
    expect(parseCursorToken("{not json")).toEqual({});
    expect(parseCursorToken("[1,2]")).toEqual({});
    expect(parseCursorToken(null)).toEqual({});
  });
});

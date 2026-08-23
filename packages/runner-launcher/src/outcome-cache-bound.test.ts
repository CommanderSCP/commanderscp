import { describe, expect, it } from "vitest";
import {
  RUN_OUTCOME_CACHE_MAX_DURABLE,
  RUN_OUTCOME_CACHE_MAX_IN_MEMORY,
  pruneOutcomeMap,
  pruneOutcomeRecord
} from "./index.js";

/**
 * MEDIUM (M23.0 verification pass 7, finding M1) — BOUNDING ONE ENTRY DID NOT BOUND THE MAP.
 *
 * The previous round capped each managed executor's `detail` and left the CACHES that hold them
 * unpruned. Measured on managed-iac's durable ledger at 500 keys: `bytes=2074290`,
 * `bytesPerKey=4149` — the per-entry bound working perfectly while the map grew without limit,
 * because the map is a different quantity from the entry. Worse for that one specifically:
 * `loadState` `JSON.parse`s the whole file on EVERY `status()` poll and `saveState` rewrites it
 * whole on every `trigger()`, so an unbounded ledger is O(total history ever) of parsing on a loop
 * that ticks once a second.
 *
 * THIS FILE PINS THE MECHANISM. The three plugins' own suites pin that they are WIRED to it.
 */
describe("MEDIUM: an outcome cache is bounded by ENTRY COUNT, not only by entry size", () => {
  describe("pruneOutcomeMap (the in-memory form)", () => {
    it("drops the OLDEST entries and keeps the newest, in insertion order", () => {
      const store = new Map<string, number>();
      for (let i = 0; i < 10; i++) store.set(`k${i}`, i);
      expect(pruneOutcomeMap(store, 4)).toBe(6);
      expect([...store.keys()]).toEqual(["k6", "k7", "k8", "k9"]);
    });

    it("is a no-op at or under the cap — it must not churn a cache that is behaving", () => {
      const store = new Map<string, number>([
        ["a", 1],
        ["b", 2]
      ]);
      expect(pruneOutcomeMap(store, 2)).toBe(0);
      expect(pruneOutcomeMap(store, 5)).toBe(0);
      expect([...store.keys()]).toEqual(["a", "b"]);
    });

    it("a cap of zero empties it, and a negative cap is refused rather than obeyed", () => {
      const store = new Map([["a", 1]]);
      expect(pruneOutcomeMap(new Map([["a", 1]]), 0)).toBe(1);
      // Negative would mean "keep less than nothing"; treating it as a no-op keeps a
      // miscomputed cap from silently destroying a working cache.
      expect(pruneOutcomeMap(store, -1)).toBe(0);
      expect(store.size).toBe(1);
    });

    it("SIZE IS BOUNDED AFTER ANY NUMBER OF INSERTS — the property, not one example", () => {
      const store = new Map<string, number>();
      for (let i = 0; i < 5_000; i++) {
        store.set(`key-${i}`, i);
        pruneOutcomeMap(store, 50);
        expect(store.size).toBeLessThanOrEqual(50);
      }
      // …and the entry just written is always still there, which is what a `status()` poll
      // immediately after a `trigger()` depends on.
      expect(store.get("key-4999")).toBe(4999);
    });
  });

  describe("pruneOutcomeRecord (the durable-JSON form)", () => {
    it("drops the OLDEST keys and keeps the newest", () => {
      const store: Record<string, number> = {};
      for (let i = 0; i < 10; i++) store[`k${i}`] = i;
      expect(pruneOutcomeRecord(store, 3)).toBe(7);
      expect(Object.keys(store)).toEqual(["k7", "k8", "k9"]);
    });

    it("is a no-op at or under the cap", () => {
      const store: Record<string, number> = { a: 1, b: 2 };
      expect(pruneOutcomeRecord(store, 2)).toBe(0);
      expect(Object.keys(store)).toEqual(["a", "b"]);
    });

    it("SIZE IS BOUNDED AFTER ANY NUMBER OF INSERTS, with UUID-shaped keys", () => {
      // UUID-shaped on purpose: `Object.keys` returns INTEGER-LIKE keys first in numeric order and
      // only then string keys in insertion order, and every key these caches use is an
      // `idempotencyKey` or a `randomUUID()`. Using "0","1","2" here would test a property the
      // production keys do not have.
      const store: Record<string, number> = {};
      for (let i = 0; i < 3_000; i++) {
        store[`0199ab${String(i).padStart(6, "0")}-7f00-7000-8000-000000000000`] = i;
        pruneOutcomeRecord(store, 40);
        expect(Object.keys(store).length).toBeLessThanOrEqual(40);
      }
      expect(Object.keys(store).length).toBe(40);
    });

    it("EVEN WITH INTEGER-LIKE KEYS the COUNT is still bounded — only the choice degrades", () => {
      // The caveat stated as a test rather than only as a comment: no production key is
      // integer-like, but if one ever were, the property that matters (the map does not grow
      // without limit) must not depend on the ordering assumption.
      const store: Record<string, number> = {};
      for (let i = 0; i < 500; i++) {
        store[String(i)] = i;
        pruneOutcomeRecord(store, 25);
      }
      expect(Object.keys(store).length).toBeLessThanOrEqual(25);
    });
  });

  describe("the caps themselves", () => {
    it("the DURABLE cap is 200 — a per-poll parse cost, so it is the tighter of the two", () => {
      // Stated as a literal, for the reason the detail-magnitude tests exist: an assertion against
      // the constant that defines a bound cannot notice the constant moving. 200 x ~4.2 KB is a
      // ~840 KB ceiling on managed-iac's ledger, re-parsed on every `status()` poll.
      expect(RUN_OUTCOME_CACHE_MAX_DURABLE).toBe(200);
    });

    it("the IN-MEMORY cap is 1 000 — O(1) lookups and lost on restart, so it can afford more", () => {
      expect(RUN_OUTCOME_CACHE_MAX_IN_MEMORY).toBe(1_000);
    });

    it("THE TWO ARE DIFFERENT ON PURPOSE, and that is the whole reason it is a parameter", () => {
      // managed-iac re-reads and re-parses its entire ledger on every poll, so its size is CPU per
      // tick as well as disk; managed-scan's and managed-dep's `Map.get` is O(1) whatever the size.
      // Collapsing the two into one constant would either waste memory or re-introduce the parse
      // cost, so a change that equalises them should have to delete this.
      expect(RUN_OUTCOME_CACHE_MAX_DURABLE).toBeLessThan(RUN_OUTCOME_CACHE_MAX_IN_MEMORY);
    });
  });
});

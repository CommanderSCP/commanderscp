import { describe, expect, it } from "vitest";
import type { TenantTx } from "../db/tenant-tx.js";
import { filterFreezesByScopes, type FreezeRow } from "./freezes-repo.js";
import { instanceFreezeCovers, type InstanceFreezeRow } from "./instance-freezes-repo.js";
import { freezesByTarget, unionFreezes, type EffectiveFreeze } from "./freeze-scope.js";

/**
 * THE TWO PROPERTIES `freeze-scope.ts` DECLARES, measured without a database.
 *
 * The set-equality property needs real containment walks and lives in
 * `coordination/freeze-admission.integration.test.ts`. What lives HERE is everything that can be
 * measured by counting: the INERTNESS short-circuit (a claim about how many queries are issued,
 * which no assertion on a return value can see — the function returns the same empty answer either
 * way) and `unionFreezes`'s dedupe/ordering (pure).
 *
 * THE FAKE `tx` IS THE INSTRUMENT, not a convenience. `containmentChain` is the only thing in this
 * module that calls `tx.execute`, and the two window reads are the only things that call
 * `tx.select` without a `.limit()`, so counting the calls distinguishes "walked nothing" from
 * "walked and found nothing" — which is exactly the distinction the inertness claim is about and
 * exactly the one a real database would hide.
 *
 * M25.3 ADDED A THIRD AND FOURTH QUERY SHAPE and the fake counts them separately, because the
 * whole point of the inertness property is arithmetic: the instance-tier window read (`selects`,
 * now 2 per call) and `readStageCoordinate`'s two `.limit(1)` lookups (`coordinateReads`, which
 * must stay 0 unless a coordinate-ADDRESSED instance freeze is live). A fake that answered both
 * window reads from one counter would report the post-M25.3 cost as unchanged, which is the
 * vacuous version of this test.
 */

/** The ORG arm of `EffectiveFreeze` — narrowed, so `filterFreezesByScopes` keeps its tag. */
type OrgTierFreeze = Extract<EffectiveFreeze, { tier: "org" }>;

function freeze(id: string, scopeObjectId: string, atomic = false): OrgTierFreeze {
  return {
    // M25.3 — `freezesByTarget` now returns a TIER UNION; the org arm is what this fixture is.
    tier: "org",
    id,
    orgId: "org",
    scopeObjectId,
    name: id,
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-12-31T00:00:00Z"),
    reason: "test",
    createdByActorId: "actor",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    atomic,
    // M25.1 — a row this fixture hands back has by definition already passed
    // `activeFreezesInWindow`'s `lifted_at IS NULL` filter, so the live value is the only one that
    // can reach `filterFreezesByScopes`/`unionFreezes`.
    liftedAt: null,
    liftedByActorId: null,
    liftReason: null
  };
}

/**
 * A `tx` that answers the two queries this module can issue and counts each one.
 *
 * `selects` counts `activeFreezesInWindow`'s window read; `executes` counts `containmentChain`'s
 * recursive CTE, one per target walked. `chains` supplies the ancestor ids each successive walk
 * reports, IN THE ORDER `freezesByTarget` walks its targets — which the loop guarantees, and which
 * also means a fake that runs out of chains is a walk the test did not expect.
 */
function countingTx(
  windowRows: EffectiveFreeze[],
  chains: string[][] = [],
  instanceRows: InstanceFreezeRow[] = []
) {
  const counts = { selects: 0, executes: 0, coordinateReads: 0 };
  const remaining = [...chains];
  // `freezesByTarget` issues the ORG window read first and the INSTANCE window read second; the
  // order is fixed by the function and asserted by the fake answering them in that order.
  let windowRead = 0;
  const tx = {
    select: () => ({
      from: () => ({
        // Drizzle's builder is a THENABLE, so `await ...where(...)` and `...where(...).limit(1)`
        // are two different terminations of one chain. Counting at the termination rather than at
        // `where()` is what lets the fake tell a window read from a coordinate lookup.
        where: () => ({
          limit: () => {
            counts.coordinateReads++;
            // `[]` => "not a live placement" / "not a live deployment-target", which is what every
            // target in this file is: `readStageCoordinate` returns null and only a
            // `matchAllEnvironments` instance freeze can cover it.
            return Promise.resolve([]);
          },
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (err: unknown) => unknown
          ): unknown => {
            counts.selects++;
            const rows = windowRead === 0 ? windowRows : instanceRows;
            windowRead++;
            return Promise.resolve(rows).then(resolve, reject);
          }
        })
      })
    }),
    execute: () => {
      counts.executes++;
      const chain = remaining.shift();
      if (!chain) throw new Error("unexpected containment walk — the fake has no chain left");
      return Promise.resolve({
        rows: chain.map((id, i) => ({ id, type_id: "component", depth: i, labels: {} }))
      });
    }
  } as unknown as TenantTx;
  return { counts, tx };
}

describe("freezesByTarget: INERTNESS (property 1)", () => {
  it("walks ZERO containment chains when the org has no active freeze", async () => {
    const { counts, tx } = countingTx([]);

    const byTarget = await freezesByTarget(tx, "org", ["t1", "t2", "t3", "t4"], new Date());

    // The answer is right...
    expect(byTarget).toEqual([
      { targetObjectId: "t1", freezes: [] },
      { targetObjectId: "t2", freezes: [] },
      { targetObjectId: "t3", freezes: [] },
      { targetObjectId: "t4", freezes: [] }
    ]);
    // ...and it cost ONE org-wide indexed read and not a single graph traversal. This is the
    // assertion the 1s tick depends on: move a containment walk above the short-circuit, or fold
    // the window read into the loop, and `executes` becomes 4.
    // ...and it cost TWO org-wide indexed reads — one per tier, the instance one over a table that
    // ships empty — and not a single graph traversal or coordinate lookup.
    expect(counts.selects).toBe(2);
    expect(counts.executes).toBe(0);
    expect(counts.coordinateReads).toBe(0);
  });

  it("DOES walk once per target the moment the org has one active freeze — the control", async () => {
    // Without this case the assertion above would pass just as well against a function that never
    // walked anything at all, which is the vacuous version of the same test.
    const { counts, tx } = countingTx([freeze("f1", "svc")], [["org", "svc", "t1"]]);

    await freezesByTarget(tx, "org", ["t1"], new Date());

    expect(counts.selects).toBe(2);
    expect(counts.executes).toBe(1);
    // Still ZERO coordinate reads: no instance freeze is live, so nothing asks where the target
    // runs. This is the conjunct that keeps M25.3's cost off the org-tier path entirely.
    expect(counts.coordinateReads).toBe(0);
  });

  it("returns an entry for EVERY target, covered or not — a caller never interprets a missing key", async () => {
    const f = freeze("f1", "svc-a");
    const { tx } = countingTx(
      [f],
      [
        ["org", "svc-a", "t1"], // covered by f1's scope
        ["org", "svc-b", "t2"] // not covered
      ]
    );

    const byTarget = await freezesByTarget(tx, "org", ["t1", "t2"], new Date());

    expect(byTarget.map((e) => e.targetObjectId)).toEqual(["t1", "t2"]);
    expect(byTarget[0]!.freezes.map((x) => x.id)).toEqual(["f1"]);
    expect(byTarget[1]!.freezes).toEqual([]);
  });
});

describe("unionFreezes", () => {
  it("dedupes by id and keeps first-appearance order", () => {
    const a = freeze("a", "svc");
    const b = freeze("b", "comp");
    const union = unionFreezes([
      { targetObjectId: "t1", freezes: [a, b] },
      { targetObjectId: "t2", freezes: [a] },
      { targetObjectId: "t3", freezes: [] }
    ]);
    expect(union.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("is empty when nothing is frozen — the shape `checkFreeze`'s early return reads", () => {
    expect(
      unionFreezes([
        { targetObjectId: "t1", freezes: [] },
        { targetObjectId: "t2", freezes: [] }
      ])
    ).toEqual([]);
  });

  it("distributes over the per-target split: the union of the parts is the whole", () => {
    // The in-memory half of the set-equality property `freeze-scope.ts` claims by construction.
    // `filterFreezesByScopes` over the UNION of two chains must equal the union of it applied to
    // each chain — which is what makes `freezesByTarget` + `unionFreezes` interchangeable with
    // `activeFreezesForScopes(containmentScopeIds(...))` at `checkFreeze`'s call site.
    const rows = [freeze("f-org", "org"), freeze("f-a", "svc-a"), freeze("f-b", "svc-b")];
    const chainA = ["org", "svc-a", "t1"];
    const chainB = ["org", "svc-b", "t2"];

    const whole = filterFreezesByScopes(rows, [...new Set([...chainA, ...chainB])]);
    const parts = unionFreezes([
      { targetObjectId: "t1", freezes: filterFreezesByScopes(rows, chainA) },
      { targetObjectId: "t2", freezes: filterFreezesByScopes(rows, chainB) }
    ]);

    expect(new Set(parts.map((f) => f.id))).toEqual(new Set(whole.map((f) => f.id)));
    expect(parts).toHaveLength(3);
  });
});

describe("filterFreezesByScopes", () => {
  it("is EXACT-SET MEMBERSHIP — an ancestor the caller omitted is a freeze that does not block", () => {
    // The documented, dangerous half of the contract, asserted rather than only commented: this is
    // the shape a `domain_id`-only walk produced when a service-scoped freeze failed OPEN.
    const rows = [freeze("f-svc", "svc")];
    expect(filterFreezesByScopes(rows, ["org", "svc", "comp"]).map((f) => f.id)).toEqual(["f-svc"]);
    expect(filterFreezesByScopes(rows, ["org", "comp"])).toEqual([]);
  });

  it("returns [] for an empty scope set without inspecting the rows", () => {
    expect(filterFreezesByScopes([freeze("f", "svc")], [])).toEqual([]);
  });
});

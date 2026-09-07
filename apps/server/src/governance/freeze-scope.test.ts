import { describe, expect, it } from "vitest";
import type { TenantTx } from "../db/tenant-tx.js";
import { filterFreezesByScopes } from "./freezes-repo.js";
import { type InstanceFreezeRow } from "./instance-freezes-repo.js";
import {
  freezesByTarget,
  rollbackExemptible,
  unionFreezes,
  type EffectiveFreeze
} from "./freeze-scope.js";

/** The two properties this declares, measured without a db. See docs/governance.md §75. */

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
    liftReason: null,
    // M25.7 — a NON-federating freeze, which is the default and what this module's arithmetic is
    // about. Resolution is deliberately blind to whether a freeze also has a graph object: an
    // IMPORTED freeze is an ordinary org-tier row by the time it gets here (`import-repo.ts`
    // rebuilt it into this same table), so it costs the same reads and takes the same path.
    objectId: null
  };
}

/** An instance-tier row as `activeInstanceFreezesInWindow` returns it (M25.3, drizzle/0086). The
 *  fake below hands these back from the SECOND window read; the matcher is unit-tested on its own
 *  in `instance-freezes-repo.test.ts` and what is measured here is only the resolution COST. */
function instanceFreeze(
  match: Partial<
    Pick<InstanceFreezeRow, "matchAllEnvironments" | "matchEnvironment" | "matchRegion">
  >
): InstanceFreezeRow {
  return {
    id: "inst-1",
    key: "inst-1",
    name: null,
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-12-31T00:00:00Z"),
    reason: "test",
    matchAllEnvironments: false,
    matchEnvironment: null,
    matchRegion: null,
    atomic: false,
    overridable: false,
    note: null,
    // Already past `activeInstanceFreezesInWindow`'s `lifted_at IS NULL` filter by construction.
    liftedAt: null,
    liftReason: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...match
  };
}

/** A transaction that answers two queries and counts them. See docs/governance.md §76. */
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

    expect(byTarget).toEqual([
      { targetObjectId: "t1", freezes: [] },
      { targetObjectId: "t2", freezes: [] },
      { targetObjectId: "t3", freezes: [] },
      { targetObjectId: "t4", freezes: [] }
    ]);
    // One org-wide indexed read, and no graph traversal. See docs/governance.md §77.
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

  it("M25.3: a LIVE instance freeze costs coordinate reads and STILL no containment walk when the org declared nothing", async () => {
    // The instance tier is resolved from its OWN window read, so an org with no freeze of its own
    // walks NO containment chain even while a platform freeze is in force — the org-tier cost and
    // the instance-tier cost are independent, which is what keeps a deployment-wide freeze from
    // turning every tick into a graph traversal for every org on the instance.
    const { counts, tx } = countingTx([], [], [instanceFreeze({ matchEnvironment: "prod" })]);

    await freezesByTarget(tx, "org", ["t1", "t2"], new Date());

    expect(counts.selects, "one window read per tier").toBe(2);
    expect(counts.executes, "the ORG tier declared nothing — no chain is walked").toBe(0);
    // Two lookups per target: the placement hop, then the deployment-target's properties.
    expect(counts.coordinateReads).toBe(4);
  });

  it("M25.3: a DEPLOYMENT-WIDE instance freeze reads no coordinates at all — it covers every target regardless", async () => {
    // The conjunct that makes the widest freeze the CHEAPEST one. `matchAllEnvironments` consults
    // no coordinate, so asking the graph where each target runs would be two reads per target per
    // tick answering a question the matcher never looks at.
    const { counts, tx } = countingTx([], [], [instanceFreeze({ matchAllEnvironments: true })]);

    const byTarget = await freezesByTarget(tx, "org", ["t1", "t2"], new Date());

    expect(counts.coordinateReads).toBe(0);
    expect(counts.executes).toBe(0);
    // And it covered both targets even though neither declares anything — the one form that does.
    expect(byTarget.map((e) => e.freezes.map((f) => f.tier))).toEqual([["platform"], ["platform"]]);
  });

  it("returns an entry for EVERY target, covered or not — a caller never interprets a missing key", async () => {
    const f = freeze("f1", "svc-a");
    const { tx } = countingTx(
      [f],
      [
        ["org", "svc-a", "t1"],
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

describe("rollbackExemptible — owner decision D7 stops at the tier boundary (M25.3)", () => {
  // The predicate BOTH D7 seams consult (`gate-orchestrator.ts`'s `freezeExemptRollback` and
  // `reconcile.ts`'s per-target `continue`). Unit-tested here because it is the whole rule, and
  // because the integration cases that exercise it cost a container each.
  const org = { tier: "org" } as const;
  const platform = { tier: "platform" } as const;

  it("exempts a set of org freezes and refuses any set containing a platform freeze", () => {
    expect(rollbackExemptible([]), "nothing covering is trivially exempt").toBe(true);
    expect(rollbackExemptible([org, org])).toBe(true);
    expect(rollbackExemptible([platform])).toBe(false);
    // THE MIXED CASE, and the direction that matters: an org freeze beside a platform one does NOT
    // lend the set the exemption. `every` and not `some`, and a one-element test cannot tell the
    // two apart — which is why both orders are here.
    expect(rollbackExemptible([org, platform])).toBe(false);
    expect(rollbackExemptible([platform, org])).toBe(false);
  });
});

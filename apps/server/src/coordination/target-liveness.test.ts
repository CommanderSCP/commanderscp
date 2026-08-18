import { describe, expect, it } from "vitest";
import type { TenantTx } from "../db/tenant-tx.js";
import { readTargetLiveness } from "./target-liveness.js";

/**
 * THE FAIL DIRECTION, pinned on its own because it is the half that fails SILENTLY.
 *
 * "A deleted target must not be driven" is easy to get right and loud when it is wrong — the
 * integration suite catches it. Its twin is neither: **a transient read failure must not look like a
 * deletion.** Get that backwards and a thirty-second database blip terminalizes every wave target in
 * flight across the fleet, parks every change behind an unresolvable block Decision, and — because a
 * tombstone is never undone — leaves an operator with no remedy but to cancel and re-propose all of
 * them. That is a far worse outage than the one this feature prevents, and nothing about it would
 * look like a bug: every Decision would say, confidently and falsely, "its target was deleted".
 *
 * The property that prevents it is small and easy to erase: {@link readTargetLiveness} has NO
 * try/catch and no "unknown" verdict, so a query fault PROPAGATES. The obvious "simplification" —
 * folding it into a `Promise<boolean>` that catches its own errors, or adding a defensive
 * `.catch(() => ({ live: false }))` at a call site — is exactly the mutation this file exists to
 * fail on.
 *
 * A unit test rather than an integration one, deliberately: the fault being modelled is the
 * DATABASE ITSELF failing, and there is no way to ask a healthy Testcontainers Postgres to do that
 * for one query and not the next.
 */

/** The minimum of drizzle's builder chain `readTargetLiveness` actually walks:
 *  `select().from().where().limit()`. `resolve` supplies whatever that chain settles to. */
function fakeTx(resolve: () => Promise<unknown[]>): TenantTx {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => resolve()
  };
  return { select: () => chain } as unknown as TenantTx;
}

describe("readTargetLiveness fail direction", () => {
  it("THROWS when the read fails — a database fault is NOT a deletion", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const tx = fakeTx(() => Promise.reject(boom));

    // Rejects. It does NOT resolve to `{ live: false }` — which is what would let a blip park the
    // fleet. The caller's existing per-target catch turns this into "retry next tick", having
    // terminalized nothing and dispatched nothing.
    await expect(readTargetLiveness(tx, "org", "target")).rejects.toThrow(
      "connection terminated unexpectedly"
    );
  });

  it("ABSENCE IS NOT PERMISSION: no row at all refuses, and is reported as `missing`, not `deleted`", async () => {
    const tx = fakeTx(() => Promise.resolve([]));

    const liveness = await readTargetLiveness(tx, "org", "gone-entirely");

    expect(liveness.live).toBe(false);
    // The two are kept apart on purpose. `missing` and `deleted` reach the same refusal but describe
    // different events, and a Decision that guessed between them would be a label named after the
    // branch that matched rather than after what is true.
    expect(liveness).toMatchObject({ reason: "missing", objectId: "gone-entirely", via: "target" });
  });

  it("a live NON-placement target is live, with no second query", async () => {
    let reads = 0;
    const tx = fakeTx(() => {
      reads += 1;
      return Promise.resolve([{ id: "c1", typeId: "component", deletedAt: null, properties: {} }]);
    });

    expect(await readTargetLiveness(tx, "org", "c1")).toEqual({ live: true });
    // The placement pair hop must not fire for the legacy shape — this check runs on every first
    // trigger of every wave target on the instance, and 277 of 281 measured changes target exactly
    // one component (ADR-0026).
    expect(reads).toBe(1);
  });

  it("a TOMBSTONED target is refused as `deleted`, naming its type", async () => {
    const tx = fakeTx(() =>
      Promise.resolve([{ id: "c1", typeId: "component", deletedAt: new Date(), properties: {} }])
    );

    expect(await readTargetLiveness(tx, "org", "c1")).toMatchObject({
      live: false,
      reason: "deleted",
      objectId: "c1",
      typeId: "component",
      via: "target"
    });
  });

  it("a LIVE placement whose COMPONENT is tombstoned is refused — and names the component, not the placement", async () => {
    // The ADR-0026 stage shape. `deleteObject` cascades to `relationships` only, so this pairing —
    // a placement with `deleted_at IS NULL` referencing a dead component through its properties —
    // is the ordinary state of the graph after a component is deleted, not a corrupt one.
    const rows: Record<string, unknown[]> = {
      p1: [
        {
          id: "p1",
          typeId: "placement",
          deletedAt: null,
          properties: { componentId: "c1", deploymentTargetId: "d1" }
        }
      ],
      c1: [{ id: "c1", typeId: "component", deletedAt: new Date(), properties: {} }]
    };
    const order = ["p1", "c1"];
    let i = 0;
    const tx = fakeTx(() => Promise.resolve(rows[order[i++]!]!));

    expect(await readTargetLiveness(tx, "org", "p1")).toMatchObject({
      live: false,
      reason: "deleted",
      objectId: "c1",
      typeId: "component",
      via: "placement.component"
    });
  });

  it("a LIVE placement whose DEPLOYMENT-TARGET is tombstoned is refused too — both halves are checked", async () => {
    // The half most likely to be forgotten: a check that stopped at `componentId` would pass this
    // and go on deploying into a place that no longer exists.
    const order: unknown[][] = [
      [
        {
          id: "p1",
          typeId: "placement",
          deletedAt: null,
          properties: { componentId: "c1", deploymentTargetId: "d1" }
        }
      ],
      [{ id: "c1", typeId: "component", deletedAt: null, properties: {} }],
      [{ id: "d1", typeId: "deployment-target", deletedAt: new Date(), properties: {} }]
    ];
    let i = 0;
    const tx = fakeTx(() => Promise.resolve(order[i++]!));

    expect(await readTargetLiveness(tx, "org", "p1")).toMatchObject({
      live: false,
      reason: "deleted",
      objectId: "d1",
      typeId: "deployment-target",
      via: "placement.deploymentTarget"
    });
  });

  it("a MALFORMED placement (no pair in its properties) is NOT reported as deleted", async () => {
    // A shape fault is not a tombstone. The resolvers that already refuse such a row own that case
    // (`plan-service.ts` skips it outright); reporting "deleted" here would put a false statement in
    // an audit-chained Decision about an object nobody touched.
    const tx = fakeTx(() =>
      Promise.resolve([{ id: "p1", typeId: "placement", deletedAt: null, properties: {} }])
    );

    expect(await readTargetLiveness(tx, "org", "p1")).toEqual({ live: true });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, objects, relationships } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** A PUSH'S CORRELATION IDENTITY, through the REAL github adapter (journey-view §8.16).
 *  See docs/coordination.md §1114.
 *
 *  This file exists because the D2 fan-out tests were GREEN while the feature was dead in production.
 *  They drive sourceKind `terraform`, which has no entry in the webhook adapter registry, so the flat
 *  generic hint shape applied and carried no `correlationKey` — leaving the processor's synthesised
 *  per-event key free to fire. A real `github` delivery resolves the github adapter, which set
 *  `correlationKey: p.ref`, so `hint.correlationKey ?? (fansOut ? synthesised : undefined)` always took
 *  the ref and the synthesis never ran. Everything here is therefore driven with sourceKind `github`
 *  and a real push payload: that is the only shape that exercises the path production uses. */
describe("a push's correlation identity (github adapter, §8.16)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const label = () => randomUUID().slice(0, 8);
  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  beforeAll(async () => {
    // `processChangeSourceEvents` is driven from the RECONCILE loop (`reconcile.ts:1813`), not the
    // event relay — a webhook that is accepted but never processed looks exactly like a webhook that
    // was refused, which is why this is stated rather than copied.
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "push-correlation");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  /** A github `push` delivery, shaped the way GitHub actually sends one.
   *
   *  Delivered with `x-github-event: push` and NOT through `client.changeSources.webhook()`, which
   *  sends a bare body. The header is what selects the adapter's event case — without it `mapEvent`
   *  returns null, the generic flat hint applies, and the whole delivery silently falls back to the
   *  very path that made the D2 tests pass while production used another. That fallback is invisible:
   *  the webhook is still accepted and the event still settles, it just matches no mapping. */
  async function push(repo: string, ref: string, paths: string[]): Promise<string> {
    const sha = randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/change-sources/github/webhook",
      headers: {
        authorization: `Bearer ${org.adminToken}`,
        "content-type": "application/json",
        "x-github-event": "push"
      },
      payload: {
        ref,
        after: sha,
        head_commit: { id: sha, added: paths, modified: [], removed: [] },
        commits: [{ id: sha, added: paths, modified: [], removed: [] }],
        repository: { full_name: repo }
      }
    });
    expect(res.statusCode, `webhook accepted: ${res.body}`).toBeLessThan(300);
    return (res.json() as { eventId: string }).eventId;
  }

  async function settled(eventId: string) {
    return await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        return rows[0]?.processedAt ? rows[0] : undefined;
      },
      { describe: `the processor to settle event ${eventId}` }
    );
  }

  /** The changes of ONE component, with their correlation keys.
   *
   *  Scoped to the component, not the org: every case here shares one org, so an org-wide count grows
   *  with each case that ran before it and the assertions would drift as cases are added or reordered. */
  async function changeRows(componentId: string) {
    return inOrg((tx) =>
      tx
        .select({
          objectId: changes.objectId,
          correlationKey: changes.correlationKey,
          props: objects.properties
        })
        .from(changes)
        .innerJoin(objects, eq(objects.id, changes.objectId))
        .where(
          and(
            eq(changes.orgId, org.orgId),
            sql`${objects.properties} @> ${JSON.stringify({ targets: [componentId] })}::jsonb`
          )
        )
    );
  }

  /** The coordinated-change groups reachable from ONE component's changes, and how many changes each
   *  holds — scoped for `changeRows`' reason. A group is counted by ALL its members, not only this
   *  component's, because "did two unrelated releases land in one group" is the question. */
  async function groups(componentId: string) {
    const mine = new Set((await changeRows(componentId)).map((r) => r.objectId));
    return inOrg(async (tx) => {
      const edges = await tx
        .select({ fromId: relationships.fromId, toId: relationships.toId })
        .from(relationships)
        .where(and(eq(relationships.orgId, org.orgId), eq(relationships.typeId, "correlates")));
      const groupIds = new Set(edges.filter((e) => mine.has(e.fromId)).map((e) => e.toId));
      const out: { name: string | null; members: number }[] = [];
      for (const groupId of groupIds) {
        const row = await tx
          .select({ name: objects.name })
          .from(objects)
          .where(and(eq(objects.orgId, org.orgId), eq(objects.id, groupId)));
        out.push({
          name: row[0]?.name ?? null,
          members: edges.filter((e) => e.toId === groupId).length
        });
      }
      return out;
    });
  }

  it("TWO separate pushes to the SAME branch are two events, NOT one group — the measured defect", async () => {
    // On the homelab this produced `Coordinated: refs/heads/*` with 34 unrelated commits in it,
    // because the adapter handed the branch name over as the event's identity.
    const component = await createTestComponent(admin, { name: `pc-two-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo
    });

    await settled(await push(repo, "refs/heads/main", ["src/a.ts"]));
    await settled(await push(repo, "refs/heads/main", ["src/b.ts"]));

    const rows = await changeRows(component.id);
    expect(rows, "two pushes, two releases").toHaveLength(2);
    for (const r of rows) {
      // NULL, not the branch. A single-Type push is one release and needs no group at all.
      expect(r.correlationKey).toBeNull();
      expect(r.correlationKey).not.toBe("refs/heads/main");
    }
    expect(
      await groups(component.id),
      "no coordinated-change group is created for a plain push"
    ).toEqual([]);
  }, 120_000);

  it("a BOTH-ARMS push fans out and gets ONE synthesised per-event key — D2, alive through the real adapter", async () => {
    // THE TEST THAT WOULD HAVE CAUGHT IT. Before §8.16 the hint carried `refs/heads/main`, so the
    // processor's `change-source-event:<id>` synthesis was unreachable on this path and both arms were
    // filed under the branch — together with every other push to it.
    const component = await createTestComponent(admin, { name: `pc-fan-${label()}` });
    const repo = `acme/${label()}`;
    // The mixed repo of §8.3: `chart/**` typed `chart`, the remainder typed `image`.
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo,
      type: "image"
    });
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo,
      pathPattern: "chart/**",
      type: "chart"
    });

    const eventId = await push(repo, "refs/heads/main", ["src/main.ts", "chart/values.yaml"]);
    await settled(eventId);

    const rows = await changeRows(component.id);
    expect(rows, "one push touching both arms ⇒ two releases").toHaveLength(2);
    const keys = new Set(rows.map((r) => r.correlationKey));
    expect(keys.size, "both arms share ONE key").toBe(1);
    const key = [...keys][0];
    // The synthesised per-EVENT key, naming the event row — not the branch.
    expect(key).toBe(`change-source-event:${eventId}`);
    expect(key).not.toBe("refs/heads/main");
    // Both Types are present, so this really is the fan-out and not one release counted twice.
    expect(new Set(rows.map((r) => (r.props as Record<string, unknown>).type))).toEqual(
      new Set(["image", "chart"])
    );

    // ONE group, holding exactly the two arms — which is what makes the two releases findable as one
    // real-world event, the whole point of D2.
    expect(await groups(component.id)).toEqual([
      { name: `Coordinated: change-source-event:${eventId}`, members: 2 }
    ]);
  }, 120_000);

  it("two both-arms pushes to one branch get DIFFERENT keys and separate groups", async () => {
    // The composition of the two cases above, and the one a ref-keyed identity gets wrong most
    // quietly: each push's two arms belong together, and the two pushes do not belong to each other.
    const component = await createTestComponent(admin, { name: `pc-both-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo,
      type: "image"
    });
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo,
      pathPattern: "chart/**",
      type: "chart"
    });

    const first = await push(repo, "refs/heads/main", ["src/a.ts", "chart/values.yaml"]);
    await settled(first);
    const second = await push(repo, "refs/heads/main", ["src/b.ts", "chart/values.yaml"]);
    await settled(second);

    const rows = await changeRows(component.id);
    expect(rows).toHaveLength(4);
    const byKey = new Map<string | null, number>();
    for (const r of rows) byKey.set(r.correlationKey, (byKey.get(r.correlationKey) ?? 0) + 1);
    expect(byKey.size, "two distinct events").toBe(2);
    expect([...byKey.values()], "two arms each").toEqual([2, 2]);

    const g = await groups(component.id);
    expect(g).toHaveLength(2);
    expect(g.every((entry) => entry.members === 2)).toBe(true);
    expect(new Set(g.map((entry) => entry.name))).toEqual(
      new Set([
        `Coordinated: change-source-event:${first}`,
        `Coordinated: change-source-event:${second}`
      ])
    );
  }, 120_000);

  it("the ref still ROUTES: a ref-scoped mapping matches a polled-or-delivered push, key or no key", async () => {
    // Dropping the key must not touch routing. `ref` was always the routing input (ADR-0030 §1) and
    // is surfaced under its own name; this is the guard that the two were genuinely separable.
    const component = await createTestComponent(admin, { name: `pc-ref-${label()}` });
    const other = await createTestComponent(admin, { name: `pc-ref-other-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo,
      refPattern: "refs/heads/main"
    });
    await admin.changeSources.createMapping("github", {
      component: other.id,
      repoPattern: repo,
      refPattern: "refs/heads/dev"
    });

    await settled(await push(repo, "refs/heads/dev", ["src/a.ts"]));
    // Asserted in BOTH directions: the dev push reached the dev mapping's component and did NOT reach
    // the main one. One-sided, this would also pass if the push had matched nothing at all.
    const routed = await changeRows(other.id);
    expect(routed, "the dev ref routed to the dev mapping's component").toHaveLength(1);
    expect((routed[0]!.props as { targets?: string[] }).targets).toEqual([other.id]);
    expect(await changeRows(component.id), "and not to the main-ref mapping's").toHaveLength(0);
    // …and it still carries no grouping key: routing and identity were genuinely separable.
    expect(routed[0]!.correlationKey).toBeNull();
  }, 120_000);
});

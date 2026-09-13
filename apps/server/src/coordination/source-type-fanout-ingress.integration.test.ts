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

/** A both-arms push becomes TWO releases, end to end (journey-view §8.7 D2, ADR-0007 / M12 P4A).
 *
 *  The correlator-level rules are held down in `source-mapping-type-fanout.integration.test.ts`;
 *  this file is the ingress consequence — that the processor actually proposes one change per
 *  matched Type, in ONE savepoint, findable afterwards as one event. */
describe("ingress fan-out: one push, one release per matched Type", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "type-fanout-ingress");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  const label = () => randomUUID().slice(0, 8);

  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** The mixed repo of journey-view §8.3: `chart/**` typed `chart`, the remainder typed `image`. */
  async function mixedRepo() {
    const sourceKind = "terraform";
    const component = await createTestComponent(admin, { name: `fanout-${label()}` });
    const repo = `acme/${label()}`;
    await admin.changeSources.createMapping(sourceKind, {
      repoPattern: repo,
      component: component.id,
      type: "image"
    } as Parameters<typeof admin.changeSources.createMapping>[1]);
    await admin.changeSources.createMapping(sourceKind, {
      repoPattern: repo,
      pathPattern: "chart/**",
      component: component.id,
      type: "chart"
    } as Parameters<typeof admin.changeSources.createMapping>[1]);
    return { sourceKind, repo, componentId: component.id };
  }

  /** The RAW webhook ingress, not the typed report: `ChangeReportRequestSchema` is a strict object
   *  carrying `path` and no `paths`, so the typed first-party report cannot express a push that
   *  touched two files at all — and a push touching one file can never fan out. A real git push
   *  arrives here, where the adapter (or the flat generic shape) supplies the full changed-file
   *  set. */
  const push = async (sourceKind: string, payload: Record<string, unknown>): Promise<string> => {
    const { eventId } = await admin.changeSources.webhook(sourceKind, payload);
    return eventId;
  };

  async function settled(eventId: string) {
    return await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        const row = rows[0];
        return row?.processedAt ? row : undefined;
      },
      { describe: `the processor to settle event ${eventId}` }
    );
  }

  /** Every change the event produced, found the way a fan-out has to be found: by the key the two
   *  arms share, since `resulting_change_object_id` is one column and can only name one of them. */
  async function changesForKey(correlationKey: string) {
    return await inOrg(async (tx) => {
      const rows = await tx
        .select({
          objectId: changes.objectId,
          urn: objects.urn,
          name: objects.name,
          props: objects.properties
        })
        .from(changes)
        .innerJoin(objects, eq(objects.id, changes.objectId))
        .where(and(eq(changes.orgId, org.orgId), eq(changes.correlationKey, correlationKey)));
      return rows.map((r) => ({
        objectId: r.objectId,
        urn: r.urn,
        name: r.name,
        type: (r.props as Record<string, unknown> | null)?.type as string | undefined
      }));
    });
  }

  it("a push touching BOTH arms proposes two changes — chart AND image — grouped as one event", async () => {
    const { sourceKind, repo } = await mixedRepo();

    const eventId = await push(sourceKind, {
      repo,
      paths: ["chart/values.yaml", "src/server.ts"]
    });
    const row = await settled(eventId);

    // A git push carries NO correlationKey (no adapter sets one), so the fan-out synthesises one
    // from the event row. Without it the two arms would be two unrelated releases.
    const correlationKey = `change-source-event:${eventId}`;
    const produced = await changesForKey(correlationKey);

    expect(produced.map((c) => c.type).sort()).toEqual(["chart", "image"]);
    // The event column can only name one arm; it names the highest-ranked one. Asserted so that a
    // future change making it name the OTHER arm — or null — is a visible decision, not a drift.
    expect(row.resultingChangeObjectId).toBe(produced.find((c) => c.type === "chart")!.objectId);
    // `objects` is UNIQUE on (org_id, urn) and both arms share one event id, so a fan-out that did
    // not disambiguate would have thrown a 500 and refused the whole event.
    expect(new Set(produced.map((c) => c.urn)).size).toBe(2);
    expect(produced.every((c) => c.name?.includes(`(${c.type})`))).toBe(true);

    // Both arms hang off ONE coordinated-change object, which is what makes them findable together.
    const group = await inOrg((tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "coordinated-change"),
            sql`${objects.labels} ->> 'correlationKey' = ${correlationKey}`
          )
        )
    );
    expect(group).toHaveLength(1);

    // The edge runs change -> group (`correlates`), so the members are the `from` side.
    const members = await inOrg((tx) =>
      tx
        .select({ fromId: relationships.fromId })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "correlates"),
            eq(relationships.toId, group[0]!.id)
          )
        )
    );
    expect(new Set(members.map((m) => m.fromId))).toEqual(new Set(produced.map((c) => c.objectId)));
  });

  it("a CHART-ONLY push is still one release — the whole-repo image mapping does not tag along", async () => {
    // The per-path ownership rule. Globs have no negation, so the `image` mapping written for "the
    // remainder" also matches `chart/values.yaml`; asking which mappings match the EVENT would
    // propose a spurious image release on every chart bump. This is the guard for that.
    const { sourceKind, repo } = await mixedRepo();

    const eventId = await push(sourceKind, { repo, paths: ["chart/values.yaml"] });
    const row = await settled(eventId);

    expect(row.resultingChangeObjectId).toBeTruthy();
    // One Type means no fan-out, so NO key is synthesised and the change keeps the null it always
    // had — the single-Type path stays byte-identical to its pre-D2 behaviour.
    const produced = await changesForKey(`change-source-event:${eventId}`);
    expect(produced).toEqual([]);

    const stored = await inOrg((tx) =>
      tx.select().from(changes).where(eq(changes.objectId, row.resultingChangeObjectId!))
    );
    expect(stored[0]!.correlationKey).toBeNull();
  });

  it("a fan-out carrying a COUPLING declaration is refused whole — neither arm lands", async () => {
    // `provides` names what ONE release provides. Duplicating it onto both arms would declare the
    // same thing twice; attaching it to one would be a guess. Refuse, and refuse atomically.
    const { sourceKind, repo } = await mixedRepo();

    const eventId = await push(sourceKind, {
      repo,
      paths: ["chart/values.yaml", "src/server.ts"],
      provides: ["api-v2"]
    });
    const row = await settled(eventId);

    expect(row.resultingChangeObjectId).toBeNull();
    // Atomic: the savepoint wraps BOTH proposes, so a refusal on the second must not leave the
    // first behind. The synthesised key is the only handle on the arms, so an empty result here is
    // the proof that nothing landed.
    expect(await changesForKey(`change-source-event:${eventId}`)).toEqual([]);
  });
});

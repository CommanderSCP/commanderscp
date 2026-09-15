import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  changeSourceEvents,
  changeWaveTargets,
  changes,
  objects,
  sourceMappings
} from "../db/schema.js";
import { matchComponentsForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE DECLARED RELEASE PATH of a mapping — `source_mappings.journey_kind`, migration 0112,
 *  journey-view §8.14. See docs/coordination.md §906a.
 *
 *  This column exists because `type` was doing two jobs, and the SECOND describe block below is the
 *  test that would have caught it: describing a service repo's journey by retyping its mapping `image`
 *  made every release from it resolve a `build` binding that does not exist and terminalise
 *  `no_executor`. That is measured here as a permanent control, so a future "simplification" that
 *  folds the journey back into `type` fails rather than silently stopping deployments. */
describe("source mapping: declared journey kind (migration 0112, §8.14)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let executionSystem: GraphObject;

  const label = () => randomUUID().slice(0, 8);
  const inOrg = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(server.deps.db, org.orgId, fn);

  beforeAll(async () => {
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "mapping-journey-kind");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: `gamma-${label()}`,
      properties: { environment: "gamma" }
    });
    executionSystem = await admin.object("execution-system").create({
      name: `argocd-${label()}`,
      properties: { kind: "fake-executor", serverUrl: "https://argo.example" }
    });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const match = (sourceKind: string, repo: string, paths?: string[]) =>
    inOrg((tx) =>
      matchComponentsForSource(tx, org.orgId, { sourceKind, repo, paths }).then((m) => m[0] ?? null)
    );

  // ---------------------------------------------------------------------------------------------
  // The label itself: it round-trips, it is settable and retractable, and the value set is closed.
  // ---------------------------------------------------------------------------------------------

  it("round-trips incl. NULL: declared at create, read back on create/list/pipeline; omitted = not declared", async () => {
    const component = await createTestComponent(admin, { name: `jk-rt-${label()}` });
    const sourceKind = `jk-rt-${uuidv7()}`;

    const src = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/agentkit",
      journeyKind: "source"
    });
    expect(src.journeyKind).toBe("source");
    // The routing Type is UNTOUCHED by declaring a journey — it defaulted, and stayed defaulted.
    // This one assertion is the whole design: a source-code journey that still routes to config.
    expect(src.type).toBe("configuration");

    const cfg = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/agentkit-gitops",
      journeyKind: "config"
    });
    expect(cfg.journeyKind).toBe("config");

    const undeclared = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/legacy"
      // omitted → NOT declared. Not "config because it defaults to the config pipeline", not
      // "source because the repo name looks like a service" (§8.3 rejected repo-identity).
    });
    expect(undeclared.journeyKind).toBeNull();

    const listed = await admin.changeSources.listMappings(sourceKind);
    const byRepo = new Map(listed.items.map((m) => [m.repoPattern, m.journeyKind]));
    expect(byRepo.get("acme/agentkit")).toBe("source");
    expect(byRepo.get("acme/agentkit-gitops")).toBe("config");
    expect(byRepo.get("acme/legacy")).toBeNull();

    // The pipeline projection carries it READ, per source — the lane builder's input.
    const pipeline = await admin.components.pipeline(component.id);
    const projected = new Map(pipeline.sources.map((s) => [s.repoPattern, s.journeyKind]));
    expect(projected.get("acme/agentkit")).toBe("source");
    expect(projected.get("acme/agentkit-gitops")).toBe("config");
    expect(projected.get("acme/legacy")).toBeNull();
  });

  it("PATCH .../journey-kind sets and CLEARS it by id, leaving type, scope, pause state and a byte-identical sibling alone", async () => {
    const component = await createTestComponent(admin, { name: `jk-patch-${label()}` });
    const sourceKind = `jk-patch-${uuidv7()}`;

    const declare = () =>
      admin.changeSources.createMapping(sourceKind, {
        component: component.id,
        repoPattern: "acme/shared",
        type: "infrastructure",
        scope: "global",
        enabled: false
      });
    const a = await declare();
    const b = await declare();
    expect(a.journeyKind).toBeNull();

    const set = await admin.changeSources.setMappingJourneyKind(sourceKind, a.id, "source");
    expect(set.id).toBe(a.id);
    expect(set.journeyKind).toBe("source");
    // THE POINT OF THE SEPARATE ROUTE: re-declaring the journey moves nothing that routes.
    expect(set.type).toBe("infrastructure");
    expect(set.scope).toBe("global");
    expect(set.enabled).toBe(false);
    expect(set.effectivelyEnabled).toBe(false);

    // The byte-identical sibling is NOT relabelled: by-id means one row.
    const listed = await admin.changeSources.listMappings(sourceKind);
    expect(listed.items.find((m) => m.id === b.id)?.journeyKind).toBeNull();
    expect(listed.items.find((m) => m.id === a.id)?.journeyKind).toBe("source");

    // Re-declare, then RETRACT with null — a mis-declared path must be removable, not just corrected.
    expect(
      (await admin.changeSources.setMappingJourneyKind(sourceKind, a.id, "config")).journeyKind
    ).toBe("config");
    const cleared = await admin.changeSources.setMappingJourneyKind(sourceKind, a.id, null);
    expect(cleared.journeyKind).toBeNull();
    expect(cleared.type).toBe("infrastructure");

    // A miss on the id (or the source kind) is a 404, never a silent no-op.
    await expect(
      admin.changeSources.setMappingJourneyKind(sourceKind, uuidv7(), "source")
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      admin.changeSources.setMappingJourneyKind(`other-${sourceKind}`, a.id, "source")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a value outside source|config at the wire — the CHECK never gets to see one", async () => {
    const component = await createTestComponent(admin, { name: `jk-bad-${label()}` });
    const sourceKind = `jk-bad-${uuidv7()}`;
    const created = await fetch(`${server.baseUrl}/change-sources/${sourceKind}/mappings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${org.adminToken}` },
      body: JSON.stringify({
        sourceKind,
        component: component.id,
        repoPattern: "acme/x",
        journeyKind: "chart"
      })
    });
    // `chart` is a real ExecutorType and NOT a journey kind — the most likely wrong value anyone
    // would send, and exactly the conflation this field exists to end.
    expect(created.status).toBe(400);

    const ok = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/y"
    });
    const patched = await fetch(
      `${server.baseUrl}/change-sources/${sourceKind}/mappings/${ok.id}/journey-kind`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${org.adminToken}` },
        body: JSON.stringify({ journeyKind: "image" })
      }
    );
    expect(patched.status).toBe(400);
  });

  it("the CHECK closes the set AT REST, and the one surface it cannot close degrades to null", async () => {
    const component = await createTestComponent(admin, { name: `jk-skew-${label()}` });
    const sourceKind = `jk-skew-${uuidv7()}`;
    const created = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/skew",
      journeyKind: "source"
    });

    // THE COLUMN: closed at both ends. Zod refuses the value on the wire (above) and the CHECK
    // refuses it at rest, so a row carrying an unreadable journey kind is genuinely unreachable —
    // which is why the value set can be closed here and not merely validated.
    const refusal = await inOrg((tx) =>
      tx
        .execute(
          sql`UPDATE source_mappings SET journey_kind = 'from-the-future'
              WHERE id = ${created.id}::uuid AND org_id = ${org.orgId}::uuid`
        )
        .then(
          () => null,
          (err: unknown) => err
        )
    );
    // Asserted on the CONSTRAINT NAME, off the driver error `cause` — drizzle's own message only
    // repeats the SQL, so matching it would pass for any failed UPDATE, including one that failed
    // because the column does not exist. Naming the constraint is what makes this a proof.
    expect(refusal, "the UPDATE must be refused").not.toBeNull();
    expect((refusal as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      "source_mappings_journey_kind_check"
    );
    expect(
      (await admin.changeSources.listMappings(sourceKind)).items.find((m) => m.id === created.id)
        ?.journeyKind
    ).toBe("source");

    // THE CHANGE'S COPY: jsonb, so NO constraint can close it — and a change imported from a peer
    // running a different CommanderSCP is the real way an unrecognised value arrives. `journeyKindOf`
    // degrades it to null (one missing label), deliberately unlike `typeOf`, which THROWS on an
    // unrecognised Type because guessing there would route a release nobody asked for.
    const change = await admin.changes.propose({
      name: `jk-skew-change-${label()}`,
      targets: [component.id],
      properties: { journeyKind: "from-the-future" }
    });
    const props = await inOrg(async (tx) => {
      const rows = await tx
        .select({ props: objects.properties })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, change.id)));
      return rows[0]?.props as Record<string, unknown> | undefined;
    });
    expect(props?.journeyKind, "stored verbatim — the projection reads, it does not rewrite").toBe(
      "from-the-future"
    );
    // That the READER degrades it to null is `journey-kind-reader.test.ts` — a pure unit test, because
    // the assertion is about one function over an arbitrary jsonb value and needs no database.
  });

  // ---------------------------------------------------------------------------------------------
  // §8.14 — THE REASON THE COLUMN EXISTS. A journey kind must never reach routing.
  // ---------------------------------------------------------------------------------------------

  it("is INERT for correlation: two mappings differing ONLY in journey kind route identically", async () => {
    const sourceKind = `jk-inert-${uuidv7()}`;
    const repo = `acme/mixed-${label()}`;
    const svc = await createTestComponent(admin, { name: `jk-svc-${label()}` });
    const gitops = await createTestComponent(admin, { name: `jk-gitops-${label()}` });

    await admin.changeSources.createMapping(sourceKind, {
      component: svc.id,
      repoPattern: repo,
      pathPattern: "src/**",
      journeyKind: "source"
    });
    await admin.changeSources.createMapping(sourceKind, {
      component: gitops.id,
      repoPattern: repo,
      pathPattern: "chart/**",
      journeyKind: "config"
    });

    const a = await match(sourceKind, repo, ["src/main.ts"]);
    const b = await match(sourceKind, repo, ["chart/values.yaml"]);
    expect(a?.componentObjectId).toBe(svc.id);
    expect(b?.componentObjectId).toBe(gitops.id);
    // Both route to the CONFIG pipeline. The journeys differ; the routing does not.
    expect(a?.type).toBe("configuration");
    expect(b?.type).toBe("configuration");

    // Swap both declarations and the routing is byte-identical — the kind neither promotes nor
    // demotes a row in the matcher's precedence, and it never blocks a match.
    const listed = await admin.changeSources.listMappings(sourceKind);
    for (const m of listed.items) {
      await admin.changeSources.setMappingJourneyKind(
        sourceKind,
        m.id,
        m.journeyKind === "source" ? "config" : "source"
      );
    }
    expect((await match(sourceKind, repo, ["src/main.ts"]))?.componentObjectId).toBe(svc.id);
    expect((await match(sourceKind, repo, ["chart/values.yaml"]))?.componentObjectId).toBe(
      gitops.id
    );

    // It IS carried on the match — unlike `scope`, which is absent — because the CHANGE has to record
    // it. Carried, then never read by anything that routes; the two describe blocks are that claim.
    expect(a).toEqual({
      componentObjectId: svc.id,
      type: "configuration",
      classification: null,
      journeyKind: "source"
    });
  });

  it("a `source`-journey release DISPATCHES, where the same release described by retyping to `image` goes no_executor (the §8.14 measurement, as a regression test)", async () => {
    const sourceKind = `jk-dispatch-${uuidv7()}`;
    const component = await createTestComponent(admin, { name: `jk-dispatch-${label()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    // The estate's shape: a `configuration` binding at the placement, and nothing else. No `build`
    // binding exists anywhere — which is exactly the condition that made retyping fatal.
    await admin.executors.putBinding(placement.id, {
      executionSystemId: executionSystem.id,
      externalRef: "app"
    });
    const topo = await admin.object("release-topology").create({
      name: `topo-${label()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });

    const terminalized = async (type: string) =>
      await waitUntil(
        async () => {
          const rows = await inOrg((tx) =>
            tx
              .select()
              .from(changeWaveTargets)
              .where(eq(changeWaveTargets.targetObjectId, placement.id))
          );
          const row = rows.find((r) => r.type === type);
          return row && (row.status === "no_executor" || row.executorPluginId) ? row : undefined;
        },
        { describe: `a ${type} wave target to terminalize`, timeoutMs: 40_000 }
      );

    // THE SUBJECT: the journey is declared `source` — the thing D3 wanted to express — and the
    // release DISPATCHES, because the declaration went to `journey_kind` and not to `type`.
    await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/svc",
      journeyKind: "source"
    });
    await admin.changeSources.webhook(sourceKind, {
      repo: "acme/svc",
      ref: "refs/heads/main",
      paths: ["src/main.ts"]
    });
    const dispatched = await terminalized("configuration");
    expect(dispatched.status).not.toBe("no_executor");
    expect(dispatched.executorPluginId).not.toBeNull();

    // THE CONTROL: the SAME journey described the old way — by retyping the mapping `image` — is
    // refused, fail-closed, at the same placement with the same binding. This is the measurement
    // §8.14 recorded, and it is the reason `journey_kind` is a separate column. If someone folds the
    // journey back into `type`, the assertion above breaks and this one keeps passing.
    await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/svc-retyped",
      type: "image"
    });
    await admin.changeSources.webhook(sourceKind, {
      repo: "acme/svc-retyped",
      ref: "refs/heads/main",
      paths: ["src/main.ts"]
    });
    const refused = await terminalized("image");
    expect(refused.status).toBe("no_executor");
    expect(refused.executorPluginId).toBeNull();
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // The change records the journey it took.
  // ---------------------------------------------------------------------------------------------

  it("stamps the matched mapping's journey kind onto the CHANGE, and projects it per stage", async () => {
    const sourceKind = `jk-stamp-${uuidv7()}`;
    const component = await createTestComponent(admin, { name: `jk-stamp-${label()}` });
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    const topo = await admin.object("release-topology").create({
      name: `topo-${label()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });
    await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/stamped",
      journeyKind: "source"
    });

    const { eventId } = await admin.changeSources.webhook(sourceKind, {
      repo: "acme/stamped",
      ref: "refs/heads/main",
      paths: ["src/main.ts"]
    });
    const settled = await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        return rows[0]?.processedAt ? rows[0] : undefined;
      },
      { describe: `the processor to settle event ${eventId}` }
    );
    const changeId = settled.resultingChangeObjectId!;
    expect(changeId).toBeTruthy();

    const props = await inOrg(async (tx) => {
      const rows = await tx
        .select({ props: objects.properties })
        .from(changes)
        .innerJoin(objects, eq(objects.id, changes.objectId))
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, changeId)));
      return rows[0]?.props as Record<string, unknown> | undefined;
    });
    expect(props?.journeyKind).toBe("source");
    // The routing Type on the same change is untouched — both facts, side by side, on one release.
    expect(props?.type).toBe("configuration");

    // And it reaches the view per stage, read off the change (not recomputed from the mapping).
    const current = await waitUntil(
      async () => {
        const p = await admin.components.pipeline(component.id);
        // THIS change's current, not "a" current: the integration suite shares one Postgres and one
        // reconcile loop, so a stage can legitimately be showing someone else's release first.
        return p.stages[0]?.currents.find((c) => c.changeId === changeId);
      },
      { describe: `the gamma stage to show change ${changeId}`, timeoutMs: 40_000 }
    );
    expect(current.journeyKind).toBe("source");
  }, 120_000);

  it("a release whose mapping declares NO journey stores no key at all — byte-identical to a pre-0112 change", async () => {
    const sourceKind = `jk-absent-${uuidv7()}`;
    const component = await createTestComponent(admin, { name: `jk-absent-${label()}` });
    await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/undeclared"
    });
    const { eventId } = await admin.changeSources.webhook(sourceKind, {
      repo: "acme/undeclared",
      ref: "refs/heads/main",
      paths: ["src/main.ts"]
    });
    const settled = await waitUntil(
      async () => {
        const rows = await inOrg((tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        return rows[0]?.processedAt ? rows[0] : undefined;
      },
      { describe: `the processor to settle event ${eventId}` }
    );
    const props = await inOrg(async (tx) => {
      const rows = await tx
        .select({ props: objects.properties })
        .from(changes)
        .innerJoin(objects, eq(objects.id, changes.objectId))
        .where(
          and(eq(changes.orgId, org.orgId), eq(changes.objectId, settled.resultingChangeObjectId!))
        );
      return rows[0]?.props as Record<string, unknown> | undefined;
    });
    // ABSENT, not `null`: the same discipline as `provides`/`requires`, so no existing estate's
    // change objects change shape when this column ships.
    expect(props).not.toHaveProperty("journeyKind");
  }, 120_000);

  it("the column defaults to NULL on every row that predates it", async () => {
    // The 148 live mappings on the estate all read NULL — asserted here against a row inserted
    // without the field, because "nothing is inferred" is the claim migration 0112 makes.
    const component = await createTestComponent(admin, { name: `jk-default-${label()}` });
    const sourceKind = `jk-default-${uuidv7()}`;
    const created = await admin.changeSources.createMapping(sourceKind, {
      component: component.id,
      repoPattern: "acme/pre-existing",
      type: "image",
      classification: "dev",
      scope: "global",
      mirrorOfShared: true
    });
    expect(created.journeyKind).toBeNull();
    const raw = await inOrg((tx) =>
      tx
        .select({ journeyKind: sourceMappings.journeyKind })
        .from(sourceMappings)
        .where(eq(sourceMappings.id, created.id))
    );
    expect(raw[0]?.journeyKind).toBeNull();
  });
});

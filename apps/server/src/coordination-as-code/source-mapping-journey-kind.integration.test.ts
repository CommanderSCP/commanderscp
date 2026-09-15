import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest, ManifestSourceMapping } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, sourceMappings } from "../db/schema.js";

/** DECLARING A SOURCE'S RELEASE PATH IN IaC (journey-view §8.14, migration 0112).
 *  See docs/coordination-as-code.md §87a.
 *
 *  `plan-diff.test.ts` pins the VERDICTS; this file pins that the APPLY actually writes them. The
 *  distinction matters here more than usual: the diff raises ONE `update` action for a drift in either
 *  of two independent attributes, so an apply that converges only the field it happened to think of
 *  would show a green plan, report success, and leave the other attribute silently unchanged. */
describe("IaC: a source mapping's declared journey kind (§8.14)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-journey-kind");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  function manifestFor(stackName: string, mapping: ManifestSourceMapping): DesiredStateManifest {
    const svc = `urn:scp:${stackName}:service:svc`;
    const comp = `urn:scp:${stackName}:component:api`;
    return {
      stackName,
      objects: [
        { urn: svc, typeId: "service", name: `svc-${stackName}` },
        { urn: comp, typeId: "component", name: `api-${stackName}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: svc, toUrn: comp }],
      sourceMappings: [mapping]
    };
  }

  async function apply(manifest: DesiredStateManifest) {
    const plan = await admin.plans.create(manifest);
    const entries = plan.diff.sourceMappings ?? [];
    await admin.plans.apply(plan.id);
    return entries;
  }

  /** The live rows for a stack's component, id included — the id is what proves in-place convergence. */
  async function liveRows(componentUrn: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const comp = await tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, componentUrn))
      });
      if (!comp) return [];
      return tx
        .select({
          id: sourceMappings.id,
          type: sourceMappings.type,
          scope: sourceMappings.scope,
          journeyKind: sourceMappings.journeyKind
        })
        .from(sourceMappings)
        .where(eq(sourceMappings.componentObjectId, comp.id));
    });
  }

  it("creates with the declared journey kind, then CONVERGES a changed one in place — same row, not a delete + create", async () => {
    const stack = `jk-${uuidv7().slice(0, 8)}`;
    const comp = `urn:scp:${stack}:component:api`;
    const base: ManifestSourceMapping = {
      componentUrn: comp,
      sourceKind: "github",
      repoPattern: "acme/agentkit"
    };

    const created = await apply(manifestFor(stack, { ...base, journeyKind: "source" }));
    expect(created.map((e) => e.action)).toEqual(["create"]);
    const afterCreate = await liveRows(comp);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]!.journeyKind).toBe("source");
    // The routing Type defaulted and is untouched: a source-code journey on the config pipeline.
    expect(afterCreate[0]!.type).toBe("configuration");
    const originalId = afterCreate[0]!.id;

    // Re-declare the journey only. This must be an in-place UPDATE.
    const updated = await apply(manifestFor(stack, { ...base, journeyKind: "config" }));
    expect(updated.map((e) => e.action)).toEqual(["update"]);
    const afterUpdate = await liveRows(comp);
    expect(afterUpdate).toHaveLength(1);
    expect(afterUpdate[0]!.journeyKind).toBe("config");
    // THE ASSERTION THAT MATTERS: the SAME row. A changed label must never prune and recreate a live
    // route — the id is the only thing that can tell those two apart after the fact.
    expect(afterUpdate[0]!.id).toBe(originalId);

    // Re-applying the same manifest proposes nothing.
    expect(
      (await apply(manifestFor(stack, { ...base, journeyKind: "config" }))).map((e) => e.action)
    ).toEqual(["noop"]);
  }, 120_000);

  it("converges BOTH attributes on one `update` — the diff raises a single action for two independent drifts", async () => {
    const stack = `jk-both-${uuidv7().slice(0, 8)}`;
    const comp = `urn:scp:${stack}:component:api`;
    const base: ManifestSourceMapping = {
      componentUrn: comp,
      sourceKind: "github",
      repoPattern: "acme/both"
    };

    await apply(manifestFor(stack, { ...base, scope: "domain", journeyKind: "config" }));
    const before = await liveRows(comp);
    expect(before[0]).toMatchObject({ scope: "domain", journeyKind: "config" });

    const entries = await apply(
      manifestFor(stack, { ...base, scope: "global", journeyKind: "source" })
    );
    // ONE entry, ONE update, and its reason names BOTH fields.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe("update");
    expect(entries[0]!.reason).toContain("scope differs");
    expect(entries[0]!.reason).toContain("journey kind differs");

    const after = await liveRows(comp);
    expect(after).toHaveLength(1);
    // BOTH written. Applying only one would pass every plan-level assertion above.
    expect(after[0]!.scope).toBe("global");
    expect(after[0]!.journeyKind).toBe("source");
    expect(after[0]!.id).toBe(before[0]!.id);
  }, 120_000);

  it("an OMITTED journeyKind leaves a hand-set declaration alone — the field is unmanaged, not cleared", async () => {
    const stack = `jk-omit-${uuidv7().slice(0, 8)}`;
    const comp = `urn:scp:${stack}:component:api`;
    const base: ManifestSourceMapping = {
      componentUrn: comp,
      sourceKind: "github",
      repoPattern: "acme/omitted"
    };
    await apply(manifestFor(stack, base));
    const rows = await liveRows(comp);
    expect(rows[0]!.journeyKind).toBeNull();

    // An operator declares the path by hand, out of band (the PATCH route).
    const componentId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const c = await tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, comp))
      });
      return c!.id;
    });
    void componentId;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(sourceMappings)
        .set({ journeyKind: "source" })
        .where(eq(sourceMappings.id, rows[0]!.id))
    );

    // Re-applying the SAME manifest — which has never heard of the field — must be a noop that leaves
    // the hand-set value standing. A manifest that wiped it would be an IaC run silently undoing an
    // operator's declaration on every apply.
    const entries = await apply(manifestFor(stack, base));
    expect(entries.map((e) => e.action)).toEqual(["noop"]);
    expect((await liveRows(comp))[0]!.journeyKind).toBe("source");
  }, 120_000);

  it("refuses a manifest whose journeyKind is not source|config, before any plan exists", async () => {
    const stack = `jk-bad-${uuidv7().slice(0, 8)}`;
    const comp = `urn:scp:${stack}:component:api`;
    const manifest = manifestFor(stack, {
      componentUrn: comp,
      sourceKind: "github",
      repoPattern: "acme/bad",
      // `chart` is a real ExecutorType and not a journey kind — the conflation this field ends.
      journeyKind: "chart" as unknown as "source"
    });
    await expect(admin.plans.create(manifest)).rejects.toMatchObject({ status: 400 });
    // Nothing was created by the refused plan.
    const created = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ id: objects.id }).from(objects).where(eq(objects.urn, comp))
    );
    expect(created).toHaveLength(0);
  }, 120_000);
});

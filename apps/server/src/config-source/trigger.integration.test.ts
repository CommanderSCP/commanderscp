import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { GitFileReadPluginClient, PluginHost } from "../plugin-host/contract.js";
import { changeSourceEvents, configSourceSyncQueue, objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { processChangeSourceEvents } from "../coordination/webhook-processor.js";
import { reconcileOrgTick } from "../coordination/reconcile.js";
import { createInMemoryFakeHost } from "../coordination/test-support/fake-plugin-host.js";
import { upsertExecutorBinding } from "../coordination/executor-bindings-repo.js";
import { createObject } from "../graph/objects-repo.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE CONFIG-SOURCE TRIGGER, END TO END (ADR-0046 section 2; proposal section 4, increment 4).
 *
 * ============================================================================================
 * WHAT WAS MISSING UNTIL NOW
 * ============================================================================================
 * The registration (round B), the sync engine (round C) and the ownership record (D26) all landed
 * and NOTHING CALLED THEM. `syncConfigSourceCommit` had no production caller — the repo's named
 * dominant failure, and I said so in every PR rather than implying a live path.
 *
 * This is the path: a push arrives as a `change_source_events` row -> the webhook pass ENQUEUES it
 * against every registration covering that repo -> a reconcile tick DRAINS the queue, reads the
 * manifest over the plugin RPC, and applies it as the team.
 *
 * ============================================================================================
 * MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | delete the enqueue from `processChangeSourceEvents` | (1) and (2) FAIL — nothing is recorded, so nothing drains |
 * | **delete the drain from `reconcileOrgTick`** | (2) and (3) FAIL, and (1) stays green — the enqueue half cannot tell a wired drain from an unwired one, which is why (2) and (3) go through the REAL tick rather than calling the drain directly |
 * | the drain never marks an entry processed | (2) and (3) FAIL — the entry stays pending and is re-applied on the next tick |
 *
 * THREE FIXTURE FACTS THIS TEST TAUGHT ME, each a failure first and each recorded where it bit:
 * a GitHub delivery needs its `x-github-event` HEADER or `extractHint` falls back to the flat
 * generic shape and never sees the repo; `bindingRepoIdentity` reads `owner`+`repo` (or a GitLab
 * `projectPath`), never a bare `repo`; and two registrations covering ONE repo is
 * `registration_ambiguous` by design, so sharing a repo across cases made every drain refuse — the
 * matcher working and the fixture wrong.
 */
describe("config-source trigger: push -> enqueue -> drain -> apply", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  /** PER FIXTURE, not shared. Two registrations covering one repo is `registration_ambiguous` by
   *  design (D9's loud refusal, proven in `resolve-bindings`/`registration-match` tests) — sharing a
   *  repo across cases made every drain refuse, which is the matcher working and the fixture wrong. */
  function repoFor(suffix: string): string {
    return `payments/api-${suffix}`;
  }

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "trigger");
  });

  afterAll(async () => {
    await server.close();
  });

  /** A host that can read one file — the seam `createInMemoryFakeHost` deliberately refuses, since
   *  every other test drives executors rather than git reads. */
  function hostReturning(content: string | null): PluginHost {
    const base = createInMemoryFakeHost();
    return {
      ...base,
      gitFileRead(): GitFileReadPluginClient {
        return {
          readFileAtRef: async (request) =>
            content === null
              ? {
                  outcome: "not_found",
                  missing: "path",
                  path: request.path,
                  requestedRef: request.ref
                }
              : {
                  outcome: "found",
                  path: request.path,
                  requestedRef: request.ref,
                  commitSha: request.ref,
                  content,
                  sizeBytes: Buffer.byteLength(content, "utf8")
                }
        };
      }
    } as PluginHost;
  }

  async function fixture(label: string) {
    const suffix = randomUUID().slice(0, 8);
    const team = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "team",
        actorObjectId: org.orgId,
        requestId: `trigger-${label}`,
        name: `team-${suffix}`
      })
    );
    // The team applies as itself (D9), so it needs authority where the manifest writes. Owner at the
    // org root keeps this test about the TRIGGER rather than about authorization, which
    // `sync-engine.integration.test.ts` already covers in both directions.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const role = await tx.query.roles.findFirst({
        where: (r, { and: a, eq: e, isNull }) => a(isNull(r.orgId), e(r.name, "Owner"))
      });
      await tx.execute(
        (await import("drizzle-orm")).sql`
          INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
          VALUES (gen_random_uuid(), ${org.orgId}::uuid, ${team.id}::uuid, ${role!.id}::uuid, ${org.orgId}::uuid, 'allow')
        `
      );
    });

    // Created as a principal that actually HOLDS `role_binding:write` at the named team — the
    // delegation door (#315) demands it, because a config source grants a repo that team's whole
    // write reach. The org-root OBJECT carries no bindings of its own, so it cannot author one; that
    // refusal is the guard working, and the fixture has to satisfy it like any operator would.
    const author = await createTestUser(server, org, [{ role: "Owner", scope: org.orgId }]);
    const configSource = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "config-source",
        actorObjectId: author.objectId,
        requestId: `trigger-${label}`,
        name: `cs-${suffix}`,
        properties: {
          repo: repoFor(suffix),
          ref: "main",
          paths: ["scp/manifest.json"],
          team: team.id
        }
      })
    );

    // Instance resolution needs a git-provider binding naming this repo — SCP will not read one
    // repo with another binding's credential (`manifest-reader.ts`).
    const target = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "deployment-target",
        actorObjectId: org.orgId,
        requestId: `trigger-${label}`,
        name: `dt-${suffix}`
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: target.id,
        type: "configuration",
        pluginModule: "github",
        pluginInstanceId: `git-${suffix}`,
        // `bindingRepoIdentity` reads `owner`+`repo` (or a GitLab `projectPath`) — a bare `repo`
        // names no repository and resolves no instance, which is how a real GitHub binding is
        // configured anyway.
        config: { owner: "payments", repo: `api-${suffix}` },
        actorObjectId: org.orgId,
        requestId: `trigger-${label}`
      })
    );

    return {
      configSourceId: configSource.id,
      suffix,
      repo: repoFor(suffix),
      stackName: `stack-${suffix}`
    };
  }

  async function pendingFor(configSourceId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(configSourceSyncQueue)
        .where(
          and(
            eq(configSourceSyncQueue.orgId, org.orgId),
            eq(configSourceSyncQueue.configSourceId, configSourceId)
          )
        )
    );
  }

  /** A push delivery for `REPO`, persisted the way the webhook route persists one. */
  async function deliverPush(repo: string, commitSha: string, paths: string[]) {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values({
        id: randomUUID(),
        orgId: org.orgId,
        sourceKind: "github",
        dedupeKey: randomUUID(),
        // GitHub names its event in a header; without it `extractHint` falls back to the generic
        // flat shape and never sees the repo or commit (`webhook-adapters.ts`).
        headers: { "x-github-event": "push" },
        payload: {
          repository: { full_name: repo },
          after: commitSha,
          ref: "refs/heads/main",
          head_commit: { id: commitSha, added: paths, modified: [], removed: [] }
        }
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
  }

  it("(1) a push to a registered repo ENQUEUES a sync — the webhook pass records it and writes nothing else", async () => {
    const f = await fixture("a");
    expect(await pendingFor(f.configSourceId)).toHaveLength(0);

    await deliverPush(f.repo, "c0ffee11", ["scp/manifest.json"]);

    const queued = await pendingFor(f.configSourceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ repo: f.repo, commitSha: "c0ffee11", processedAt: null });
    // The paths came from the delivery, which is what decides WHICH manifests the drain reads.
    expect(queued[0]?.paths).toContain("scp/manifest.json");
  });

  it("(2) the tick DRAINS it: the manifest is read, applied, and the object exists", async () => {
    const f = await fixture("b");
    const componentName = `api-${f.suffix}`;
    const serviceUrn = `urn:scp:${f.stackName}:service:${componentName}`;
    await deliverPush(f.repo, "beef2222", ["scp/manifest.json"]);

    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      hostReturning(
        JSON.stringify({
          stackName: f.stackName,
          objects: [{ urn: serviceUrn, typeId: "service", name: componentName, properties: {} }],
          relationships: []
        })
      ),
      server.deps.celSandbox!,
      server.deps.config.secretsMasterKey
    );

    // THE OBJECT THE REPO DECLARED IS IN THE GRAPH — the whole chain, from a delivery row to a row
    // in `objects`, with no human in between.
    const landed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.urn, serviceUrn)))
    );
    expect(landed).toHaveLength(1);
    // Applied as the TEAM, and owned by the stack that declared it.
    expect(landed[0]?.managedByStack).toBe(f.stackName);

    const drained = await pendingFor(f.configSourceId);
    expect(drained[0]?.processedAt).not.toBeNull();
    expect(drained[0]?.lastError).toBeNull();
  });

  it("(3) an unreadable manifest is DRAINED with its reason — never retried forever", async () => {
    const f = await fixture("c");
    await deliverPush(f.repo, "dead3333", ["scp/manifest.json"]);

    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      hostReturning(null),
      server.deps.celSandbox!,
      server.deps.config.secretsMasterKey
    );

    const entries = await pendingFor(f.configSourceId);
    // Marked processed even though nothing applied: "the repo is ahead of the graph" is a DISPLAYED
    // state (section 4's failure honesty), not an entry that spins forever. The reason lives in the
    // Decision the engine wrote, which is why `lastError` is null — the engine returned a status
    // rather than throwing.
    expect(entries[0]?.processedAt).not.toBeNull();
  });
});

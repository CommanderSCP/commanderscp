import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { configSourceStacks, decisions, objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  findStackConfigSourceBinding,
  listConfigSourceRegistrations
} from "./config-sources-repo.js";
import { CONFIG_SOURCE_SYNC_DECISION_KIND, syncConfigSourceCommit } from "./sync-engine.js";
import type { ManifestRead } from "./sync-engine.js";

/**
 * THE SYNC ENGINE, END TO END (ADR-0046 §1/§2; team-pipeline-iac §4/§5, D3/D9/D26).
 *
 * ============================================================================================
 * WHAT THIS FILE HAS TO PROVE
 * ============================================================================================
 * Round A merged four pure decisions and wired none of them; round B made the registration real.
 * This is the caller, and the properties that matter are the ones a green "it applied" would not
 * establish:
 *
 *  1. **THE TEAM IS THE ACTOR, AND ITS AUTHORITY BINDS.** A manifest that reaches outside the
 *     team's scope is refused even though the sync loop holds no credential and could trivially
 *     have called `executePlanDiff` with a system actor — the shortcut ADR-0046 §1 names and
 *     forbids, whose defining property is that everything still works.
 *  2. **EVERY REFUSAL IS EVALUATED, NOT THE FIRST.** The status an operator reads is all of them.
 *  3. **FAILURE IS DISPLAYED, NEVER INFERRED.** Unreadable, unparseable, invalid, refused, frozen
 *     — each produces a status AND a Decision carrying the commit SHA and manifest content hash.
 *  4. **FREEZES HOLD, THEY DO NOT BLOCK** — nothing is written, nothing errors, and the same
 *     commit applies once the window lifts.
 *  5. **D26: OWNERSHIP FOLLOWS DELIVERY** — a stack nobody wrote into `stackTeams` is repo-owned
 *     after the sync applies it, and D7's refusal then covers it.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | apply with `SYSTEM_ACTOR_ID` instead of the team, checks skipped — THE SHORTCUT ADR-0046 §1 FORBIDS | (1) FAILS: the out-of-scope manifest applies. Nothing else notices, which is the whole reason that shortcut is named in the ADR rather than left to judgement. |
 * | collect only the FIRST authz refusal (`break`) | (1) FAILS: one refusal reported where three are real. |
 * | `findStackConfigSourceBinding` drops the delivered half | (4) FAILS: a stack the sync just applied reads as unowned, so a CLI push would be admitted and reverted. |
 * | record the delivery AFTER `executePlanDiff` instead of before | (6) FAILS: the second config source's objects are written before the ownership refusal is discovered. |
 * | the delivery upsert loses its `setWhere` ownership guard | (6) FAILS: ownership silently transfers to whichever source pushed last — D9's "never last-writer-wins", in the one place a read-then-write cannot see it. |
 * | freeze targets read `id` only, without the `scopeObjectId` fallback | (7) FAILS: a create-only manifest waves straight through an active freeze, because a diff of creates has no ids yet and an empty target list is indistinguishable from "nothing frozen". |
 *
 * THE LAST ONE WAS A REAL DEFECT, found by writing the case rather than by review: the first cut of
 * `affectedObjectIds` returned ids only.
 */
describe("config-source sync engine", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const REPO = "git.corp.example/payments/api";

  interface Fixture {
    org: TestOrg;
    configSourceId: string;
    teamId: string;
    serviceId: string;
    stackName: string;
  }

  async function post(url: string, token: string, payload: unknown) {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as never
    });
    return {
      status: res.statusCode,
      body: res.body === "" ? {} : (res.json() as Record<string, unknown>)
    };
  }

  /** A team bound Operator at a SERVICE it owns — the realistic shape, and the one that makes
   *  property (1) meaningful: the team can write inside its service and nowhere else. */
  async function fixture(
    label: string,
    stackTeams: Record<string, string> | undefined = undefined
  ) {
    const org = await createTestOrg(server, label);
    const service = await post("/api/v1/objects/service", org.adminToken, {
      name: `svc-${randomUUID().slice(0, 8)}`
    });
    const team = await post("/api/v1/objects/team", org.adminToken, {
      name: `team-${randomUUID().slice(0, 8)}`
    });
    const serviceId = service.body.id as string;
    const teamId = team.body.id as string;

    await createTestUser(server, org, [{ role: "Operator", scope: serviceId }]);
    // The TEAM is the subject the sync runs as, so the binding must be on the team object itself.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const role = await tx.query.roles.findFirst({
        where: (r, { and: a, eq: e, isNull }) => a(isNull(r.orgId), e(r.name, "Operator"))
      });
      if (!role) throw new Error("Operator role missing");
      await tx.execute(
        // Bind the TEAM (subject) the Operator role AT THE SERVICE (scope).
        // Raw insert for the same reason `createTestUser` uses the repo layer: no user-management
        // API exists for team bindings.
        // eslint-disable-next-line
        require("drizzle-orm").sql`
          INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
          VALUES (gen_random_uuid(), ${org.orgId}::uuid, ${teamId}::uuid, ${role.id}::uuid, ${serviceId}::uuid, 'allow')
        `
      );
    });

    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const cs = await post("/api/v1/objects/config-source", org.adminToken, {
      name: `cs-${randomUUID().slice(0, 8)}`,
      properties: {
        repo: REPO,
        ref: "main",
        paths: ["scp/manifest.json", "**/scp/manifest.json"],
        team: teamId,
        ...(stackTeams ? { stackTeams } : {})
      }
    });
    expect(cs.status).toBe(201);

    return {
      org,
      configSourceId: cs.body.id as string,
      teamId,
      serviceId,
      stackName
    } satisfies Fixture;
  }

  async function runSync(
    f: Fixture,
    read: ManifestRead,
    opts: { commitSha?: string; changedPaths?: string[] } = {}
  ) {
    return withTenantTx(server.deps.db, f.org.orgId, async (tx) => {
      const registry = await listConfigSourceRegistrations(tx, f.org.orgId);
      const document = registry.documents.get(f.configSourceId);
      if (!document) throw new Error("config source did not parse");
      return syncConfigSourceCommit(tx, f.org.orgId, {
        registrations: registry.registrations,
        configSourceId: f.configSourceId,
        document,
        repoIdentity: REPO,
        commitSha: opts.commitSha ?? "c0ffee1234567890",
        changedPaths: opts.changedPaths ?? ["scp/manifest.json"],
        now: new Date(),
        requestId: `sync-${randomUUID().slice(0, 8)}`,
        readManifest: async () => read
      });
    });
  }

  function manifestFor(f: Fixture, componentName: string, domainId?: string, count = 1): string {
    return JSON.stringify({
      stackName: f.stackName,
      objects: Array.from({ length: count }, (_, i) => ({
        urn: `urn:scp:${f.org.orgName}:service:${componentName}${i === 0 ? "" : `-${i}`}`,
        typeId: "service",
        name: `${componentName}${i === 0 ? "" : `-${i}`}`,
        ...(domainId ? { domainId } : {}),
        properties: {}
      })),
      relationships: []
    });
  }

  async function decisionsFor(f: Fixture) {
    return withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, f.org.orgId),
            eq(decisions.kind, CONFIG_SOURCE_SYNC_DECISION_KIND),
            eq(decisions.subjectId, f.configSourceId)
          )
        )
    );
  }

  it("(1) applies as the TEAM, and the team's authority binds: a manifest inside its service lands, one outside is refused", async () => {
    const f = await fixture("sync-authz", undefined);

    // INSIDE the team's scope (domainId = the service it is bound at).
    const inside = await runSync(
      f,
      { ok: true, content: manifestFor(f, `in-${randomUUID().slice(0, 6)}`, f.serviceId) },
      { commitSha: "aaa1111" }
    );
    expect(inside).toHaveLength(1);
    expect(inside[0]?.status.status).toBe("applied");
    expect(inside[0]?.teamObjectId).toBe(f.teamId);

    // OUTSIDE it: no `domainId`, so the object lands at the org root and the check runs there —
    // where this team holds nothing. The sync holds no credential and could have used a system
    // actor; if it had, this would apply.
    const outside = await runSync(
      f,
      { ok: true, content: manifestFor(f, `out-${randomUUID().slice(0, 6)}`, undefined, 3) },
      { commitSha: "bbb2222" }
    );
    expect(outside[0]?.status.status).toBe("authz_refused");
    const refused = outside[0]?.status as unknown as { refusals: { reason: string }[] };
    // ALL THREE, not the first. The route throws on the first denial because it answers with an
    // HTTP status; this answers with a status an operator reads, and one refusal at a time sends
    // them round the loop once per object.
    expect(refused.refusals).toHaveLength(3);
    expect(refused.refusals[0]?.reason).toContain("object:write");

    // Nothing landed for the refused one.
    const rows = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.orgId, f.org.orgId))
    );
    expect(rows.some((r) => r.name.startsWith("out-"))).toBe(false);
  });

  it("(2) every stopping point is a DISPLAYED status with a Decision carrying the commit SHA", async () => {
    const f = await fixture("sync-honesty", undefined);

    const unreadable = await runSync(
      f,
      { ok: false, detail: "404 from provider" },
      { commitSha: "r1" }
    );
    expect(unreadable[0]?.status).toEqual({
      status: "manifest_unreadable",
      detail: "404 from provider"
    });

    const unparseable = await runSync(f, { ok: true, content: "{not json" }, { commitSha: "r2" });
    expect(unparseable[0]?.status.status).toBe("manifest_invalid");

    const invalid = await runSync(
      f,
      { ok: true, content: JSON.stringify({ objects: [] }) },
      { commitSha: "r3" }
    );
    expect(invalid[0]?.status.status).toBe("manifest_invalid");

    const all = await decisionsFor(f);
    expect(all).toHaveLength(3);
    expect(all.map((d) => d.verdict).sort()).toEqual([
      "manifest_invalid",
      "manifest_invalid",
      "manifest_unreadable"
    ]);
    // D3: the boundary goes in the Decision. Every one carries the commit it was computed from.
    expect(all.map((d) => (d.inputContext as { commitSha: string }).commitSha).sort()).toEqual([
      "r1",
      "r2",
      "r3"
    ]);
    // …and the ones that got as far as reading bytes carry the content hash, so a re-sync of the
    // same bytes is recognisable as the same input rather than merely the same commit.
    const hashed = all.filter(
      (d) => (d.inputContext as { manifestContentHash?: string }).manifestContentHash
    );
    expect(hashed).toHaveLength(2);
  });

  it("(3) a commit touching nothing the registration selects is a quiet no-op, not an error and not a Decision", async () => {
    const f = await fixture("sync-quiet", undefined);
    const outcomes = await runSync(
      f,
      { ok: true, content: manifestFor(f, "never-read", f.serviceId) },
      {
        changedPaths: ["README.md", "src/index.ts"]
      }
    );
    expect(outcomes).toEqual([]);
    expect(await decisionsFor(f)).toHaveLength(0);
  });

  it("(4) D26: a stack nobody claimed becomes repo-owned by DELIVERY, and D7's refusal then covers it", async () => {
    const f = await fixture("sync-d26", undefined);

    // Before any delivery: unclaimed, so unowned — a CLI push would be allowed.
    const before = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      findStackConfigSourceBinding(tx, f.org.orgId, f.stackName)
    );
    expect(before).toBeNull();

    const applied = await runSync(f, {
      ok: true,
      content: manifestFor(f, `d26-${randomUUID().slice(0, 6)}`, f.serviceId)
    });
    expect(applied[0]?.status.status).toBe("applied");

    // After: repo-owned, named by the config source that delivered it. This is the gap D26 closes —
    // `stackTeams` is still empty, so the pre-D26 predicate would still say "unowned" here.
    const after = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      findStackConfigSourceBinding(tx, f.org.orgId, f.stackName)
    );
    expect(after?.configSourceId).toBe(f.configSourceId);

    const delivery = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx
        .select()
        .from(configSourceStacks)
        .where(
          and(
            eq(configSourceStacks.orgId, f.org.orgId),
            eq(configSourceStacks.stackName, f.stackName)
          )
        )
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.teamObjectId).toBe(f.teamId);
    expect(delivery[0]?.configSourceId).toBe(f.configSourceId);
  });

  it("(5) re-syncing unchanged bytes is a no_op, and the delivery row is updated rather than duplicated", async () => {
    const f = await fixture("sync-idempotent", undefined);
    const content = manifestFor(f, `idem-${randomUUID().slice(0, 6)}`, f.serviceId);

    const first = await runSync(f, { ok: true, content }, { commitSha: "first" });
    expect(first[0]?.status.status).toBe("applied");

    const second = await runSync(f, { ok: true, content }, { commitSha: "second" });
    expect(second[0]?.status).toEqual({ status: "no_op" });

    const rows = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx
        .select()
        .from(configSourceStacks)
        .where(
          and(
            eq(configSourceStacks.orgId, f.org.orgId),
            eq(configSourceStacks.stackName, f.stackName)
          )
        )
    );
    expect(rows).toHaveLength(1);
    // The row tracks the LATEST delivery, so the status surface can say which commit the graph is at.
    expect(rows[0]?.lastCommitSha).toBe("second");
  });

  it("(6) one stack has one owner: a second config source delivering it is refused, and the graph is untouched", async () => {
    const f = await fixture("sync-owner-a", undefined);
    const componentName = `dual-${randomUUID().slice(0, 6)}`;
    const first = await runSync(f, {
      ok: true,
      content: manifestFor(f, componentName, f.serviceId)
    });
    expect(first[0]?.status.status).toBe("applied");

    // A SECOND config source in the same org, same repo pattern is refused by `registration-match`
    // — so this one uses a different repo to reach the DELIVERY guard specifically, which is the
    // layer that catches what a read-then-write race would slip past.
    const second = await post("/api/v1/objects/config-source", f.org.adminToken, {
      name: `cs2-${randomUUID().slice(0, 8)}`,
      properties: {
        repo: "git.corp.example/other/repo",
        ref: "main",
        paths: ["scp/manifest.json"],
        team: f.teamId
      }
    });
    expect(second.status).toBe(201);

    const outcomes = await withTenantTx(server.deps.db, f.org.orgId, async (tx) => {
      const registry = await listConfigSourceRegistrations(tx, f.org.orgId);
      const secondId = second.body.id as string;
      return syncConfigSourceCommit(tx, f.org.orgId, {
        registrations: registry.registrations,
        configSourceId: secondId,
        document: registry.documents.get(secondId)!,
        repoIdentity: "git.corp.example/other/repo",
        commitSha: "steal",
        changedPaths: ["scp/manifest.json"],
        now: new Date(),
        requestId: "sync-steal",
        readManifest: async () => ({
          ok: true,
          content: manifestFor(f, `${componentName}-stolen`, f.serviceId)
        })
      });
    });

    expect(outcomes[0]?.status).toEqual({
      status: "stack_owned_elsewhere",
      ownerConfigSourceId: f.configSourceId
    });

    // The refusal came BEFORE the apply: the second manifest's object was never created.
    const rows = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.orgId, f.org.orgId))
    );
    expect(rows.some((r) => r.name === `${componentName}-stolen`)).toBe(false);
  });

  it("(7) freezes HOLD, they do not block: nothing is written, nothing errors, and the same commit applies once the window is gone", async () => {
    const f = await fixture("sync-freeze", undefined);
    const componentName = `frozen-${randomUUID().slice(0, 6)}`;
    const content = manifestFor(f, componentName, f.serviceId);

    const freeze = await post("/api/v1/freezes", f.org.adminToken, {
      scopeObjectId: f.serviceId,
      name: `fz-${randomUUID().slice(0, 6)}`,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "config-source sync hold test"
    });
    expect(freeze.status).toBe(201);

    const held = await runSync(f, { ok: true, content }, { commitSha: "held" });
    expect(held[0]?.status.status).toBe("freeze_held");
    expect((held[0]?.status as unknown as { freezeIds: string[] }).freezeIds).toContain(
      freeze.body.id as string
    );

    // HELD, NOT FAILED: nothing was written, and — the half that makes it a hold rather than a
    // refusal — no delivery was recorded either, so the stack is not silently claimed by a sync
    // that did not happen.
    let rows = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.orgId, f.org.orgId))
    );
    expect(rows.some((r) => r.name === componentName)).toBe(false);
    const noDelivery = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      findStackConfigSourceBinding(tx, f.org.orgId, f.stackName)
    );
    expect(noDelivery).toBeNull();

    // Lift it, and the SAME commit applies on the next sync with no operator action on the repo.
    const lifted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/freezes/${freeze.body.id as string}`,
      headers: { authorization: `Bearer ${f.org.adminToken}` },
      // A body on a DELETE — `LiftFreezeRequestSchema` requires a reason, because lifting a freeze
      // is a governance act rather than a cleanup.
      payload: { reason: "test window over" } as never
    });
    expect(lifted.statusCode, lifted.body).toBe(200);

    const applied = await runSync(f, { ok: true, content }, { commitSha: "held" });
    expect(applied[0]?.status.status).toBe("applied");
    rows = await withTenantTx(server.deps.db, f.org.orgId, (tx) =>
      tx.select().from(objects).where(eq(objects.orgId, f.org.orgId))
    );
    expect(rows.some((r) => r.name === componentName)).toBe(true);
  });
});

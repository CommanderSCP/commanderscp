import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";
import { GOVERNANCE_MOVE_DECISION_KIND } from "../governance/move-rung-write.js";

/** ORPHAN-GUARD ROUTE 7, AND THE AUDITED EXIT FOR A STRANDED RUNG. See docs/graph.md §125d.
 *
 *  Why this file exists at all: docs/graph.md §125b recorded `governance_move_rungs` as one of eight
 *  tables with "no `.delete(...)` statement anywhere in the codebase — no route, no CLI verb, no repo
 *  function", and used that to rule out a route 7. The census behind that sentence was keyed on the
 *  DRIZZLE identifier, and this table's delete is raw SQL (`governance/move-enforcement.ts`), reached
 *  from an HTTP route, a CLI verb AND the IaC apply prune. Every claim below is asserted rather than
 *  argued, because the previous claim was argued rather than asserted. */
describe("a governance:move rung and the container it sits on", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "rung-orphan");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Tombstone the object row beneath the API — the ONLY way to make an unpinned orphan rung now that
   *  route 7 refuses it through every door. The same name the mapping, binding, placement and
   *  integrity suites use, so one grep finds every site that manufactures a pre-guard orphan. */
  async function legacySoftDelete(objectId: string, orgId = org.orgId): Promise<void> {
    const rows = await withTenantTx(server.deps.db, orgId, async (tx) => {
      await tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE id = ${objectId}::uuid AND org_id = ${orgId}::uuid`
      );
      return tx.execute(
        sql`SELECT deleted_at FROM objects WHERE id = ${objectId}::uuid AND org_id = ${orgId}::uuid`
      );
    });
    const row = (rows as unknown as { rows: { deleted_at: unknown }[] }).rows[0];
    expect(row?.deleted_at, "fixture soft-delete must actually have landed").not.toBeNull();
  }

  it("ROUTE 7 refuses deleting a container while a rung is enabled on it, and names both doors", async () => {
    // The guard is justified by what the row DOES, not by tidiness: `governance_move_rungs` is live
    // config (drizzle/0083 — "NOTHING CHANGES UNTIL A RUNG IS SET") whose own history lives elsewhere,
    // in a Decision and an audit event per write. So refusing to strand it costs no record, which is
    // exactly the argument routes 5 and 6 could not make for their tables' hard deletes.
    const svc = await admin.services.create({ name: `guarded-${uuidv7().slice(0, 8)}` });
    await admin.governanceMove.enable(svc.urn, {});

    const refusal = await admin.services.delete(svc.urn).then(
      () => null,
      (e: unknown) => e as ScpApiError
    );
    expect(refusal, "route 7 must refuse").toBeInstanceOf(ScpApiError);
    const detail = JSON.stringify(refusal);
    // A refusal an operator cannot act on is a wall, not a guard — so it names the HTTP door AND the
    // CLI verb, with this object's own URN already substituted in.
    expect(detail).toContain("governance:move rung is still enabled");
    expect(detail).toContain("DELETE /governance/move-enforcement/rungs/{idOrUrn}");
    expect(detail).toContain(`scp governance move-enforcement disable ${svc.urn}`);

    // Nothing half-applied: the service is still live and still governed.
    expect((await admin.services.get(svc.urn)).id).toBe(svc.id);

    // …and the delete lands once the operator walks the door the refusal named.
    await admin.governanceMove.disable(svc.urn);
    const deleted = await admin.services.delete(svc.urn);
    expect(deleted.id).toBe(svc.id);
  });

  it("route 7 does NOT refuse an object that carries no rung — a hint that always printed is a wall", async () => {
    const svc = await admin.services.create({ name: `unrunged-${uuidv7().slice(0, 8)}` });
    const deleted = await admin.services.delete(svc.urn);
    expect(deleted.id).toBe(svc.id);
  });

  it("THE CARVE-OUT: a rung PINNED by an upper rung is exempt, or the container would be undeletable", async () => {
    // This is route 6's `managed_by_policy_id` exemption in different clothing, and it is the whole
    // difference between a guard and a wall. `disableGovernanceMoveRung` throws 409 while an upper
    // rung stands, so refusing the delete over a pinned rung would leave the container undeletable by
    // anyone in the org — and when the pin is the INSTANCE rung, the only remedy is a deployment-wide
    // operator switch every other org shares. The org-root rung used here reaches the same branch.
    const svc = await admin.services.create({ name: `pinned-${uuidv7().slice(0, 8)}` });
    await admin.governanceMove.enable(svc.urn, {});
    await admin.governanceMove.enable(org.orgId, {});
    try {
      // The pin is real: the disable door itself refuses, which is what makes the exemption necessary.
      await expect(admin.governanceMove.disable(svc.urn)).rejects.toBeInstanceOf(ScpApiError);

      const deleted = await admin.services.delete(svc.urn);
      expect(deleted.id, "exempt — otherwise the org root would have to be disabled first").toBe(
        svc.id
      );

      // And the row it left behind is REPORTED rather than silently dropped, with the reason naming
      // the rung that pins it — the same rule the placement arm follows.
      const listed = (await admin.graph.integrity()).orphanGovernanceMoveRungs.find(
        (r) => r.ownerUrn === svc.urn
      );
      expect(listed, "the exemption is honest only if the row is reported").toBeDefined();
      expect(listed!.tier).toBe("service");
      expect(listed!.repairable, "the door would 409 — never offer it as actionable").toBe(false);
      expect(listed!.blockedReason).toContain("also enabled");
    } finally {
      await admin.governanceMove.disable(org.orgId);
    }
  });

  it("the DISABLE door reaches a rung whose subject is a tombstone; the ENABLE door still refuses one", async () => {
    // `includeDeleted` went on the DELETE handler alone. Before it, a rung stranded by a pre-route-7
    // delete answered 404 at the one door that could clear it while
    // `GET /governance/move-enforcement/rungs` went on listing it — that read LEFT JOINs `objects`
    // with no liveness filter. Detection and repair disagreeing, and nothing failed, because no test
    // ever tried the repair the list implies.
    const svc = await admin.services.create({ name: `stranded-${uuidv7().slice(0, 8)}` });
    await admin.governanceMove.enable(svc.urn, {});
    await legacySoftDelete(svc.id);

    // The list read shows it — under its old name, looking perfectly healthy.
    expect(
      (await admin.governanceMove.rungs()).rungs.some((r) => r.subjectObjectId === svc.id)
    ).toBe(true);

    const response = await admin.governanceMove.disable(svc.urn);
    expect(response.subjectObjectId).toBe(svc.id);
    expect(response.enabled).toBe(false);
    expect(
      (await admin.governanceMove.rungs()).rungs.some((r) => r.subjectObjectId === svc.id),
      "detection and repair agree"
    ).toBe(false);

    // The asymmetry, asserted: removal reaches further than creation, never the reverse. A PUT that
    // accepted a tombstone would mint the very orphan route 7 exists to prevent.
    await expect(admin.governanceMove.enable(svc.urn, {})).rejects.toBeInstanceOf(ScpApiError);
  });

  it("disabling a stranded rung writes its Decision AND its audit event, in the same transaction", async () => {
    // The row is hard-deleted, so there is no tombstone and no revision to read the change off — and
    // the subject is already a tombstone, so there is not even an object mutation. The Decision and
    // the audit event are the only surviving record, which is why the repair goes through
    // `disableGovernanceMoveRungWithEffects` rather than the bare statement.
    const svc = await admin.services.create({ name: `audited-${uuidv7().slice(0, 8)}` });
    await admin.governanceMove.enable(svc.urn, {});
    await legacySoftDelete(svc.id);
    const response = await admin.governanceMove.disable(svc.urn);

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "governance.move_enforcement.disable" && e.subjectId === svc.id
    );
    expect(events, "removing a stranded row is an action, not a cleanup").toHaveLength(1);
    expect(events[0]!.decisionId).toBe(response.decisionId);

    const decision = await admin.decisions.get(response.decisionId);
    expect(decision.kind).toBe(GOVERNANCE_MOVE_DECISION_KIND);
    expect(decision.verdict).toBe("disabled");
  });

  it("`/graph/integrity` reports an orphan rung with its TIER, and the door it points at works", async () => {
    // Detection and repair asserted in ONE test, which is the only arrangement in which they cannot
    // drift apart — the arrangement #375 found missing on the binding door, where the report had been
    // promising a repair that 404'd.
    const svc = await admin.services.create({ name: `reported-${uuidv7().slice(0, 8)}` });
    await admin.governanceMove.enable(svc.urn, {});

    expect(
      (await admin.graph.integrity()).orphanGovernanceMoveRungs.some((r) => r.ownerUrn === svc.urn),
      "a rung on a LIVE container is not an orphan"
    ).toBe(false);

    await legacySoftDelete(svc.id);

    const orphans = (await admin.graph.integrity()).orphanGovernanceMoveRungs.filter(
      (r) => r.ownerUrn === svc.urn
    );
    expect(orphans).toHaveLength(1);
    // `id` IS the subject's object id: this table's primary key is `subject_object_id` alone, so the
    // row has no identity of its own to report.
    expect(orphans[0]!.id).toBe(svc.id);
    expect(orphans[0]!.tier, "the STORED literal, not recomputed from the type").toBe("service");
    expect(orphans[0]!.detail).toContain(svc.name);
    expect(orphans[0]!.repairable).toBe(true);
    expect(orphans[0]!.blockedReason).toBeNull();

    await admin.governanceMove.disable(svc.urn);
    expect(
      (await admin.graph.integrity()).orphanGovernanceMoveRungs.some((r) => r.ownerUrn === svc.urn)
    ).toBe(false);
  });

  /** A fresh org per `--repair` arm. `--repair` is org-scoped and destructive by design, so sharing
   *  one org between arms would let one arm's repair consume another's fixture with every assertion
   *  still passing — the vacuous-green shape. */
  async function repairFixture(tag: string): Promise<{
    cli: CliInvocation;
    admin2: ScpClient;
    orgId: string;
  }> {
    const o = await createTestOrg(server, `rung-repair-${tag}-${uuidv7().slice(0, 6)}`);
    const cli = await startCliSession(server.baseUrl);
    await cli.run(["login", "--username", o.adminUsername, "--password", o.adminPassword]);
    return {
      cli,
      admin2: new ScpClient({ baseUrl: server.baseUrl, token: o.adminToken }),
      orgId: o.orgId
    };
  }

  type Outcome = { outcome: string; count: number };
  type Row = {
    kind: string;
    id: string;
    owner: string;
    type: string;
    lane: string;
    detail: string;
    repairable: boolean;
  };

  it("THE OPERATOR LOOP through the real CLI: `graph integrity` -> `--repair` -> clean", async () => {
    const { cli, admin2, orgId } = await repairFixture("loop");
    try {
      const svc = await admin2.services.create({ name: `cli-${uuidv7().slice(0, 8)}` });
      await admin2.governanceMove.enable(svc.urn, {});
      await legacySoftDelete(svc.id, orgId);

      const report = await cli.runJson<Row[]>(["graph", "integrity"]);
      const row = report.find(
        (r) => r.kind === "orphan-governance-move-rung" && r.owner === svc.urn
      );
      expect(row, "the CLI must name the OWNER urn, which is what the door takes").toBeDefined();
      // The TIER is its own column, lined up with `scp governance move-enforcement rungs`, so nothing
      // has to be parsed back out of a sentence.
      expect(row!.type).toBe("service");
      expect(row!.repairable).toBe(true);

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      expect(
        out.find((r) => r.outcome.startsWith("governance-move-rungs-disabled"))?.count,
        "the rung went, so the run was not a no-op"
      ).toBe(1);
      // The record is the mitigation, since there is no prompt: one line per row, naming tier, name
      // and urn — a count cannot answer "which container did this ungovern?".
      const named = out.find((r) => r.outcome.startsWith("governance-move-rung-disabled"));
      expect(named?.outcome).toContain("service");
      expect(named?.outcome).toContain(svc.urn);

      expect(
        (await cli.runJson<Row[]>(["graph", "integrity"])).some(
          (r) => r.kind === "orphan-governance-move-rung" && r.owner === svc.urn
        ),
        "the report the operator verifies with agrees with the door --repair used"
      ).toBe(false);
      // …and the second, independent record: the hash-chained audit log.
      const page = await admin2.auditEvents.list({ limit: 200 });
      expect(
        page.items.filter(
          (e) => e.action === "governance.move_enforcement.disable" && e.subjectId === svc.id
        ),
        "one per row, through the ordinary door"
      ).toHaveLength(1);
    } finally {
      await cli.cleanup();
    }
  });

  it("--repair SKIPS a PINNED orphan rung, says why, and leaves it reported", async () => {
    const { cli, admin2, orgId } = await repairFixture("pinned");
    try {
      const svc = await admin2.services.create({ name: `skip-${uuidv7().slice(0, 8)}` });
      await admin2.governanceMove.enable(svc.urn, {});
      await admin2.governanceMove.enable(orgId, {});
      await legacySoftDelete(svc.id, orgId);

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      expect(out.find((r) => r.outcome.startsWith("governance-move-rungs-disabled"))?.count).toBe(
        0
      );
      expect(out.find((r) => r.outcome === "governance-move-rungs-skipped")?.count).toBe(1);
      const skipped = out.find((r) =>
        r.outcome.startsWith(`governance-move-rung-skipped ${svc.urn}`)
      );
      expect(skipped?.count, "reported, never attempted").toBe(1);
      expect(skipped!.outcome, "and the output states the reason, not just the count").toContain(
        "also enabled"
      );

      // Still there, and still reported — a skip is not a silent drop.
      expect(
        (await admin2.graph.integrity()).orphanGovernanceMoveRungs.some(
          (r) => r.ownerUrn === svc.urn
        )
      ).toBe(true);
    } finally {
      await cli.cleanup();
    }
  });

  it("--repair leaves a LIVE container's rung alone — the blast radius is structural", async () => {
    // The guarantee that makes an unprompted `--repair` tolerable: the loop iterates the REPORT, and a
    // row is only in the report when its subject is already soft-deleted. Asserted rather than
    // reasoned about, because "it only touches orphans" is the kind of claim that stays true by
    // accident. A second, orphaned rung in the same org makes the run genuinely do work.
    const { cli, admin2, orgId } = await repairFixture("untouched");
    try {
      const live = await admin2.services.create({ name: `live-${uuidv7().slice(0, 8)}` });
      await admin2.governanceMove.enable(live.urn, {});
      const dead = await admin2.services.create({ name: `dead-${uuidv7().slice(0, 8)}` });
      await admin2.governanceMove.enable(dead.urn, {});
      await legacySoftDelete(dead.id, orgId);

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      expect(out.find((r) => r.outcome.startsWith("governance-move-rungs-disabled"))?.count).toBe(
        1
      );

      expect(
        (await admin2.governanceMove.enforcement("service", live.urn)).enforced,
        "the live container is still governed"
      ).toBe(true);
      const page = await admin2.auditEvents.list({ limit: 200 });
      expect(
        page.items.filter(
          (e) => e.action === "governance.move_enforcement.disable" && e.subjectId === live.id
        ),
        "and nothing was even attempted against it"
      ).toHaveLength(0);
    } finally {
      await cli.cleanup();
    }
  });
});

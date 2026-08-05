import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeSourceEvents, decisions } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ADR-0028 increment 1 — the declaration channel, end to end and INERT.
 *
 * What is proved here: a stage dependency declared by a microservice's own CI (`scp change-source
 * report`, owner ruling D2) survives the whole ingress path and lands on the stored change with its
 * object references RESOLVED; an unresolvable one is refused where it was authored rather than
 * becoming a hold that never clears; and NOTHING about the release changes — every change below
 * still drives to `validating` exactly as it did before this increment, because nothing reads
 * `properties.stageDependencies` yet. That inertness is the point of the increment, so it is
 * asserted rather than assumed.
 *
 * Real reconcile loop, real Postgres, real (default fake-executor) execution — the same shape as
 * `coupling.integration.test.ts`, whose report-ingress section this mirrors deliberately: a
 * declaration made through the CI channel must behave identically to one made through `POST
 * /changes`, and the only way to know is to run both.
 *
 * INCREMENT 2 gave the declaration its first reader — `proposeChange` now materialises each entry as
 * a `depends_on` edge (`stage-dependency-edges.integration.test.ts`). The inertness asserted here is
 * unaffected and still worth asserting: an edge changes the GRAPH, not the release, and every change
 * below still drives to `validating` exactly as its undeclared twin does. If that stops being true,
 * it will be because something started reading the edges at run time, and this is where it shows.
 */
describe("stage dependencies: the declaration channel (ADR-0028 increment 1)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "stagedeps");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  const stateOf = async (id: string): Promise<string> => (await admin.changes.get(id)).state;
  const reaches = (id: string, state: string, ms = 25_000) =>
    waitUntil(async () => ((await stateOf(id)) === state ? true : undefined), {
      describe: `change ${id} reaches '${state}'`,
      timeoutMs: ms
    });

  /** Polls until the loop's processor has consumed the given ingress event, and returns its row. */
  const processedEvent = (eventId: string) =>
    waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
        );
        return rows[0]?.processedAt ? rows[0] : undefined;
      },
      { describe: `change_source_event ${eventId} processed`, timeoutMs: 25_000 }
    );

  const createTarget = (environment: string) =>
    admin.object("deployment-target").create({
      name: `${environment}-${randomUUID().slice(0, 8)}`,
      properties: { environment }
    });

  // -----------------------------------------------------------------------------------------
  // PROPOSE-TIME RESOLUTION. Both halves of the reference — `dependsOn` and every `atTargets`
  // member — are resolved to object ids where the declaration was AUTHORED. An unresolved
  // `dependsOn` would be a hold that never clears; an unresolved `atTargets` would scope the
  // coupling to a place that does not exist, which reads as "applies nowhere" — the mirror-image
  // fail-open. Neither is allowed to be discovered later.
  // -----------------------------------------------------------------------------------------

  it("POST /changes stores the declaration with `dependsOn` and `atTargets` RESOLVED to object ids", async () => {
    const b = await createTestComponent(admin, { name: "resolve-dep-b" });
    const a = await createTestComponent(admin, { name: "resolve-dep-a" });
    const gamma = await createTarget("gamma");

    // Declared by URN on both halves — so a stored id proves resolution actually ran, rather than
    // the input having been an id already.
    const change = await admin.changes.propose({
      name: "declares a stage dependency by URN",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.urn, minWeight: 10, atTargets: [gamma.urn] }]
    });

    const stored = await admin.changes.get(change.id);
    expect(stored.properties.stageDependencies).toEqual([
      { dependsOn: b.id, minWeight: 10, atTargets: [gamma.id] }
    ]);
    expect(b.urn).not.toBe(b.id);
    expect(gamma.urn).not.toBe(gamma.id);
  });

  it("INERT: a change declaring a stage dependency releases exactly as an undeclared one does", async () => {
    // Increment 1 adds a declaration and no reader. If this change parked, held, or diverged in any
    // way from its uncoupled twin, the increment would not be inert — and the whole point of
    // shipping the channel separately is that it cannot change a live release.
    const b = await createTestComponent(admin, { name: "inert-dep-b" });
    const a = await createTestComponent(admin, { name: "inert-dep-a" });
    // The twin releases DIFFERENT components on purpose. Two concurrent changes targeting the SAME
    // component stall the first one in `executing` indefinitely — measured on this tree with two
    // plain changes and no ADR-0028 field anywhere, so it is a pre-existing same-target contention
    // and not this increment's business. Sharing a component here would make this test fail for a
    // reason it does not test.
    const twinTarget = await createTestComponent(admin, { name: "inert-dep-twin" });

    const declared = await admin.changes.propose({
      name: "declares a dependency, changes nothing",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }]
    });
    const plain = await admin.changes.propose({
      name: "declares nothing",
      targets: [twinTarget.id]
    });

    await reaches(declared.id, "validating");
    await reaches(plain.id, "validating");
    // And it never parked on the shipped `waiting` engine — a stage dependency is a different
    // mechanism at a different grain, and must not be routed into that one.
    expect((await admin.changes.explain(declared.id)).waitStatus).toBeNull();
  }, 60_000);

  it("a change declaring NO stage dependency stores no `stageDependencies` key at all", async () => {
    // Byte-identical to a pre-ADR-0028 change: the absence keeps every future reader's fast path a
    // pure absence check, and keeps old and new rows indistinguishable when nothing was declared.
    const a = await createTestComponent(admin, { name: "absent-dep-a" });
    const change = await admin.changes.propose({ name: "no declaration", targets: [a.id] });
    const stored = await admin.changes.get(change.id);
    // `targets` proves the properties map really was read back (an empty/absent map would satisfy
    // the negative assertion below for the wrong reason).
    expect(stored.properties.targets).toEqual([a.id]);
    expect(stored.properties).not.toHaveProperty("stageDependencies");
    // An explicitly EMPTY array is the same thing — a caller declaring nothing.
    const empty = await admin.changes.propose({
      name: "empty declaration",
      targets: [a.id],
      stageDependencies: []
    });
    expect((await admin.changes.get(empty.id)).properties).not.toHaveProperty("stageDependencies");
  });

  it("an unresolvable `dependsOn` is a 404 at propose time — never a hold that can never clear", async () => {
    const a = await createTestComponent(admin, { name: "bad-dependson-a" });
    await expect(
      admin.changes.propose({
        name: "depends on a nonexistent component",
        targets: [a.id],
        stageDependencies: [{ dependsOn: "urn:scp:does-not-exist:component:nope" }]
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("an unresolvable `atTargets` entry is ALSO a 404 — scoping to a place that does not exist is a silent fail-open", async () => {
    const b = await createTestComponent(admin, { name: "bad-attargets-b" });
    const a = await createTestComponent(admin, { name: "bad-attargets-a" });
    await expect(
      admin.changes.propose({
        name: "scopes the coupling to a nonexistent place",
        targets: [a.id],
        stageDependencies: [
          { dependsOn: b.id, atTargets: ["urn:scp:does-not-exist:deployment-target:nope"] }
        ]
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  // -----------------------------------------------------------------------------------------
  // THE CI REPORT PATH — the headline channel (owner ruling D2). `scp change-source report` is
  // where a microservice's own pipeline declares what it must not deploy ahead of.
  // -----------------------------------------------------------------------------------------

  it("a declaration on a typed CI report lands on the stored change, resolved, end to end", async () => {
    const b = await createTestComponent(admin, { name: "report-dep-b" });
    const a = await createTestComponent(admin, { name: "report-dep-a" });
    const gamma = await createTarget("gamma");
    const repo = `acme/report-stagedep-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: repo, component: a.id });

    const report = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      stageDependencies: [{ dependsOn: b.urn, minWeight: 25, atTargets: [gamma.urn] }]
    });
    const event = await processedEvent(report.eventId);
    const changeId = event.resultingChangeObjectId;
    expect(changeId).not.toBeNull();

    // The SAME propose-time resolution the typed API path gets — not a second, looser code path.
    const change = await admin.changes.get(changeId!);
    expect(change.properties.stageDependencies).toEqual([
      { dependsOn: b.id, minWeight: 25, atTargets: [gamma.id] }
    ]);

    // Still inert: the report-born change releases like any other.
    await reaches(changeId!, "validating");
  }, 60_000);

  it("a report with an unresolvable `dependsOn` is REFUSED: event processed, NO change, Decision + audit recorded", async () => {
    // The async counterpart of the 404 above. This route is persist-then-process, so a caller-shaped
    // defect cannot 4xx the reporter — it must surface as a recorded refusal instead, never as a
    // silent drop and never as the infinite retry a permanent defect would otherwise cause.
    const a = await createTestComponent(admin, { name: "report-bad-dependson-a" });
    const repo = `acme/report-bad-stagedep-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: repo, component: a.id });

    const report = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      stageDependencies: [{ dependsOn: "urn:scp:does-not-exist:component:nope" }]
    });
    const event = await processedEvent(report.eventId);
    expect(event.resultingChangeObjectId).toBeNull();

    const refusals = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, "ingress"),
            eq(decisions.subjectId, report.eventId)
          )
        )
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.verdict).toBe("block");
    expect(JSON.stringify(refusals[0]!.inputContext)).toContain("does-not-exist");

    const audits = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, org.orgId),
            eq(auditEvents.action, "change_source.event.refused"),
            eq(auditEvents.subjectId, report.eventId)
          )
        )
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decisionId).toBe(refusals[0]!.id);
  }, 60_000);

  it("a raw webhook payload with a MALFORMED `stageDependencies` is refused, never proposed as if uncoupled", async () => {
    // Fail-CLOSED, the same call `requires` makes and for the same reason: dropping the declaration
    // would run the release with no hold at all, ahead of the very component its author named. The
    // typed /report route's Zod validation makes this shape unreachable for SDK/CLI reporters — the
    // raw /webhook ingress is where junk can still arrive.
    const a = await createTestComponent(admin, { name: "webhook-malformed-stagedep-a" });
    const repo = `acme/webhook-malformed-stagedep-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: repo, component: a.id });

    const ingress = await admin.changeSources.webhook("terraform", {
      repo,
      stageDependencies: [{ minWeight: 10 }] // no `dependsOn` — names nothing
    });
    const event = await processedEvent(ingress.eventId);
    expect(event.resultingChangeObjectId).toBeNull();

    const refusals = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.kind, "ingress"),
            eq(decisions.subjectId, ingress.eventId)
          )
        )
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.verdict).toBe("block");
    expect((refusals[0]!.reasonTree as { summary: string }).summary).toContain("refused");
    expect(JSON.stringify(refusals[0]!.inputContext)).toContain("stageDependencies");
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // ROLLBACK. A rollback must NOT inherit the original's stage dependencies — undoing a release is
  // not the release, and holding an undo behind the very dependency the undo exists to escape is
  // exactly backwards. Today this holds because `rollback.ts` does not spread the original's
  // properties; that is an accident a tidy-up refactor could undo, so it is pinned as behaviour —
  // the same guard the `provides`/`requires` precedent carries deliberately.
  // -----------------------------------------------------------------------------------------

  it("a rollback of a change that declared stage dependencies inherits NONE of them", async () => {
    const b = await createTestComponent(admin, { name: "rollback-stagedep-b" });
    const a = await createTestComponent(admin, { name: "rollback-stagedep-a" });
    const gamma = await createTarget("gamma");

    const declared = await admin.changes.propose({
      name: "declares stage dependencies, then is rolled back",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id, minWeight: 10, atTargets: [gamma.id] }]
    });
    await reaches(declared.id, "validating");
    expect((await admin.changes.get(declared.id)).properties.stageDependencies).toHaveLength(1);

    const rollback = await admin.changes.rollback(declared.id, "test: undo the declared change");
    expect(rollback.rollbackOfObjectId).toBe(declared.id);
    await reaches(rollback.id, "accepted");

    const rolled = await admin.changes.get(rollback.id);
    expect(rolled.properties.stageDependencies).toBeUndefined();
  }, 60_000);
});

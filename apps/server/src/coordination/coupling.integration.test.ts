import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeSourceEvents, changes, decisions, objects } from "../db/schema.js";
import { runWatchdogSweep } from "./watchdog.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Coupled pipelines (M12 P4B — docs/proposals/coupled-pipelines.md). A change declaring
 * `requires: [{key, at}]` parks in `waiting` and is released to `executing` only once ANOTHER change
 * reaches `validating`/`promoted` and `provides` that key at that object. Real reconcile loop, real
 * Postgres, real (default fake-executor) execution — a change with no binding still drives to
 * `validating` via the shared default instance, so no executor wiring is needed here.
 *
 * The decisive behaviours: a waiter PARKS (does not execute) while its prerequisite is outstanding;
 * it RELEASES the moment the correct provider validates; a provider of the same key at a DIFFERENT
 * object does NOT release it (the `at` is load-bearing); and a bad `at` is a 404 at propose, never a
 * silent forever-wait.
 */
describe("coupled pipelines: a change waits on a cross-change prerequisite (M12 P4B)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
    org = await createTestOrg(server, "coupling");
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

  it("a change with no requires goes straight to validating — behaviour-preserving", async () => {
    const comp = await createTestComponent(admin, { name: "no-requires" });
    const change = await admin.changes.propose({ name: "plain release", targets: [comp.id] });
    await reaches(change.id, "validating");
  });

  it("a change with an UNSATISFIED requirement parks in waiting, then RELEASES when the provider validates", async () => {
    const infra = await createTestComponent(admin, { name: "coupling-infra" });
    const app = await createTestComponent(admin, { name: "coupling-app" });

    // The software release requires `feature-a` provided at the infra object. No provider exists yet.
    const waiter = await admin.changes.propose({
      name: "software waiting on infra",
      targets: [app.id],
      requires: [{ key: "feature-a", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // It stays parked — a wait triggers nothing and never silently advances. Give it several ticks.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await stateOf(waiter.id)).toBe("waiting");

    // The infra release provides the key at the infra object; it drives to validating on its own.
    const provider = await admin.changes.propose({
      name: "infra providing feature-a",
      targets: [infra.id],
      provides: ["feature-a"]
    });
    await reaches(provider.id, "validating");

    // Now the waiter's prerequisite is satisfied — it releases and completes.
    await reaches(waiter.id, "validating");
  });

  it("a provider of the same key at a DIFFERENT object does NOT release the waiter — `at` is load-bearing", async () => {
    const infra = await createTestComponent(admin, { name: "spec-infra" });
    const other = await createTestComponent(admin, { name: "spec-other" });
    const app = await createTestComponent(admin, { name: "spec-app" });

    const waiter = await admin.changes.propose({
      name: "waits on key@infra specifically",
      targets: [app.id],
      requires: [{ key: "shared-key", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // A provider of `shared-key` but at `other`, not `infra`. It validates — and must NOT satisfy the
    // waiter, whose requirement names `infra`.
    const wrongProvider = await admin.changes.propose({
      name: "provides shared-key at the WRONG object",
      targets: [other.id],
      provides: ["shared-key"]
    });
    await reaches(wrongProvider.id, "validating");
    // Give the waiter several more ticks AFTER the wrong provider validated: if the predicate
    // ignored `at` (matched on key alone), this is exactly when it would wrongly release. It must
    // still be parked.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await stateOf(waiter.id)).toBe("waiting");

    // The CORRECT provider (same key, at infra) releases it — proving the wait was genuine, not stuck.
    const rightProvider = await admin.changes.propose({
      name: "provides shared-key at infra",
      targets: [infra.id],
      provides: ["shared-key"]
    });
    await reaches(rightProvider.id, "validating");
    await reaches(waiter.id, "validating");
  });

  it("explain surfaces the wait status — the outstanding requirement (named), then satisfied by the provider (Phase 4)", async () => {
    const infra = await createTestComponent(admin, { name: "explain-infra" });
    const app = await createTestComponent(admin, { name: "explain-app" });
    const waiter = await admin.changes.propose({
      name: "explained waiter",
      targets: [app.id],
      requires: [{ key: "feat-x", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // While parked: waitStatus shows the requirement OUTSTANDING, with the `at` object's name.
    let explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus).not.toBeNull();
    expect(explained.waitStatus!.waiting).toBe(true);
    expect(explained.waitStatus!.requirements).toEqual([
      { key: "feat-x", at: infra.id, atName: "explain-infra", satisfied: false, satisfiedByChangeId: null }
    ]);

    // Provide it; the waiter releases.
    const provider = await admin.changes.propose({
      name: "explain provider",
      targets: [infra.id],
      provides: ["feat-x"]
    });
    await reaches(provider.id, "validating");
    await reaches(waiter.id, "validating");

    // Now waitStatus shows it satisfied, and names the providing change.
    explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus!.waiting).toBe(false);
    expect(explained.waitStatus!.requirements[0]).toMatchObject({
      satisfied: true,
      satisfiedByChangeId: provider.id
    });

    // A change that declared no requires has a null waitStatus — unchanged for every pre-P4B change.
    const plain = await admin.changes.propose({ name: "no coupling", targets: [app.id] });
    expect((await admin.changes.explain(plain.id)).waitStatus).toBeNull();
  });

  it("a bad `at` reference is a 404 at propose time — never a silent forever-wait", async () => {
    const app = await createTestComponent(admin, { name: "bad-at-app" });
    await expect(
      admin.changes.propose({
        name: "requires a nonexistent object",
        targets: [app.id],
        requires: [{ key: "feature-a", at: "urn:scp:does-not-exist:component:nope" }]
      })
    ).rejects.toMatchObject({ status: 404 }); // getObjectByIdOrUrnAnyType 404s on an unresolvable ref
  });

  // -----------------------------------------------------------------------------------------
  // M12 P4B close-out — REPORT-INGRESS COUPLING THREADING (coupled-pipelines.md §3.8, §6#1).
  // The CI report (`scp change-source report` → `POST /change-sources/{sourceKind}/report`) is
  // THE declaration channel for a pipeline (a raw provider push webhook cannot carry a key), so a
  // report-declared coupling must behave IDENTICALLY to `POST /changes`' typed fields.
  // -----------------------------------------------------------------------------------------

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

  it("a coupling declared on a typed report behaves IDENTICALLY to POST /changes: the change parks in waiting, then releases when a report-born provider validates", async () => {
    const infra = await createTestComponent(admin, { name: "report-infra" });
    const app = await createTestComponent(admin, { name: "report-app" });
    const infraRepo = `acme/report-infra-${randomUUID().slice(0, 8)}`;
    const appRepo = `acme/report-app-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: infraRepo, component: infra.id });
    await admin.changeSources.createMapping("terraform", { repoPattern: appRepo, component: app.id });

    // The app pipeline reports WITH a requirement — its change must park, exactly as a direct
    // `POST /changes` with the same `requires` does.
    const waiterReport = await admin.changeSources.report("terraform", {
      status: "applied",
      repo: appRepo,
      requires: [{ key: "report-feature", at: infra.id }]
    });
    const waiterEvent = await processedEvent(waiterReport.eventId);
    const waiterId = waiterEvent.resultingChangeObjectId!;
    expect(waiterId).not.toBeNull();
    await reaches(waiterId, "waiting");

    // The report-born waiter's stored requires carry the RESOLVED object id — same propose-time
    // `at` resolution as POST /changes.
    const waiter = await admin.changes.get(waiterId);
    expect(waiter.properties.requires).toEqual([{ key: "report-feature", at: infra.id }]);

    // The infra pipeline reports WITH the provides key — once ITS change validates, the waiter
    // releases. End to end, both halves declared by `scp change-source report` bodies alone.
    const providerReport = await admin.changeSources.report("terraform", {
      status: "applied",
      repo: infraRepo,
      provides: ["report-feature"]
    });
    const providerEvent = await processedEvent(providerReport.eventId);
    const providerId = providerEvent.resultingChangeObjectId!;
    const provider = await admin.changes.get(providerId);
    expect(provider.properties.provides).toEqual(["report-feature"]);
    await reaches(providerId, "validating");
    await reaches(waiterId, "validating");

    // Explainability (coupled-pipelines.md §3.6): the waiting->executing release Decision pins,
    // per requirement key, WHICH change satisfied it at release time.
    const explained = await admin.changes.explain(waiterId);
    const release = explained.decisions.find(
      (d) =>
        d.kind === "transition" &&
        (d.inputContext as { fromState?: string; toState?: string }).fromState === "waiting" &&
        (d.inputContext as { fromState?: string; toState?: string }).toState === "executing"
    );
    expect(release).toBeDefined();
    expect(release!.inputContext.satisfiedRequirements).toEqual([
      { key: "report-feature", at: infra.id, satisfiedByChangeObjectId: providerId }
    ]);
  });

  it("a report with an unresolvable `requires[].at` is REFUSED, not silently dropped: event marked processed with no change, Decision + audit recorded (the async counterpart of POST /changes' 404)", async () => {
    const app = await createTestComponent(admin, { name: "report-bad-at-app" });
    const repo = `acme/report-bad-at-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: repo, component: app.id });

    const report = await admin.changeSources.report("terraform", {
      status: "applied",
      repo,
      requires: [{ key: "feature-a", at: "urn:scp:does-not-exist:component:nope" }]
    });
    const event = await processedEvent(report.eventId);

    // Refused: processed (never retried), but NO change was minted from it.
    expect(event.resultingChangeObjectId).toBeNull();

    // The refusal is a recorded engine verdict (charter principle 6): a Decision naming the defect…
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
    expect((refusals[0]!.reasonTree as { summary: string }).summary).toContain("refused");
    expect(JSON.stringify(refusals[0]!.inputContext)).toContain("does-not-exist");

    // …hash-chained to an audit event in the same transaction.
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
  });

  it("a raw webhook payload with a MALFORMED `requires` is refused (fail-closed), never proposed as if uncoupled", async () => {
    const app = await createTestComponent(admin, { name: "webhook-malformed-app" });
    const repo = `acme/webhook-malformed-${randomUUID().slice(0, 8)}`;
    await admin.changeSources.createMapping("terraform", { repoPattern: repo, component: app.id });

    // The typed /report route's Zod validation makes this shape unreachable for SDK/CLI callers —
    // the raw /webhook z.record ingress is where junk can still arrive.
    const ingress = await admin.changeSources.webhook("terraform", {
      repo,
      requires: [{ key: "missing-the-at-half" }]
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
    expect((refusals[0]!.reasonTree as { summary: string }).summary).toContain("malformed");
  });

  // -----------------------------------------------------------------------------------------
  // M12 P4B close-out — FAIL-CLOSED on malformed STORED `requires` (coupled-pipelines.md §6#14).
  // Propose-time typed validation refuses junk at the API, so a malformed stored entry can only
  // arrive PAST the schema (federation peer skew, legacy row, operator surgery) — injected here
  // with raw SQL exactly as such a row would exist in the wild. The change must be treated as
  // UNSATISFIABLE: park in waiting, never release, never crash the sweep for its siblings, and
  // wait-status must name the offending entry.
  // -----------------------------------------------------------------------------------------

  it("a waiter whose stored requires is corrupted PARKS (never releases, never executes), the sweep keeps serving healthy waiters, and wait-status names the malformed entry", async () => {
    const infra = await createTestComponent(admin, { name: "malformed-infra" });
    const app = await createTestComponent(admin, { name: "malformed-app" });

    // A well-formed waiter parks first…
    const corrupted = await admin.changes.propose({
      name: "will be corrupted",
      targets: [app.id],
      requires: [{ key: "malformed-key", at: infra.id }]
    });
    await reaches(corrupted.id, "waiting");

    // …then its stored requires is corrupted PAST the schema (raw SQL — the federation-skew /
    // legacy-row shape the API can no longer produce).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({
          properties: sql`jsonb_set(${objects.properties}, '{requires}', '[{"key":"malformed-key"}]'::jsonb)`
        })
        .where(eq(objects.id, corrupted.id))
    );

    // Even PROVIDING the original key must not release it now — the malformed entry is
    // unsatisfiable, and satisfying the parseable-looking key would be exactly the fail-open bug.
    const provider = await admin.changes.propose({
      name: "provides malformed-key at infra",
      targets: [infra.id],
      provides: ["malformed-key"]
    });
    await reaches(provider.id, "validating");

    // A HEALTHY waiter proposed AFTER the corrupted row still parks and releases — one bad row
    // never bricks the sweep for the others.
    const healthy = await admin.changes.propose({
      name: "healthy waiter behind the corrupted one",
      targets: [app.id],
      requires: [{ key: "healthy-key", at: infra.id }]
    });
    await reaches(healthy.id, "waiting");
    const healthyProvider = await admin.changes.propose({
      name: "provides healthy-key at infra",
      targets: [infra.id],
      provides: ["healthy-key"]
    });
    await reaches(healthyProvider.id, "validating");
    await reaches(healthy.id, "validating");

    // The corrupted waiter is still parked — fail-closed, not crashed and not released.
    expect(await stateOf(corrupted.id)).toBe("waiting");

    // The 2am surface: wait-status names the malformed entry verbatim.
    const explained = await admin.changes.explain(corrupted.id);
    expect(explained.waitStatus).not.toBeNull();
    expect(explained.waitStatus!.waiting).toBe(true);
    expect(explained.waitStatus!.malformed).toEqual([{ key: "malformed-key" }]);
  }, 60_000);

  it("a change REACHING coordinated with malformed stored requires PARKS in waiting instead of executing (routing guard fail-closed)", async () => {
    const app = await createTestComponent(admin, { name: "guard-malformed-app" });

    // Materialize a change row directly in `coordinated` carrying junk requires — the state a
    // version-skewed peer's row would be in when the routing guard first sees it. Raw inserts (no
    // createObject) deliberately bypass every API-side validation layer.
    const changeObjectId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const appRow = await tx.select().from(objects).where(eq(objects.id, app.id));
      const now = new Date();
      await tx.insert(objects).values({
        id: changeObjectId,
        orgId: org.orgId,
        domainId: appRow[0]!.domainId,
        typeId: "change",
        name: "raw coordinated change with junk requires",
        urn: `urn:scp:test:change:guard-malformed-${changeObjectId}`,
        properties: { targets: [app.id], requires: "not-even-an-array" },
        labels: {},
        originDomainId: appRow[0]!.originDomainId,
        contentHash: "test-fixture",
        createdAt: now,
        updatedAt: now
      });
      await tx.insert(changes).values({
        objectId: changeObjectId,
        orgId: org.orgId,
        state: "coordinated",
        stateEnteredAt: now,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      });
    });

    // The routing guard must send it to `waiting` (fail-closed park), NEVER `executing`.
    await reaches(changeObjectId, "waiting");
    // And it stays there — unsatisfiable is unsatisfiable.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await stateOf(changeObjectId)).toBe("waiting");
    const explained = await admin.changes.explain(changeObjectId);
    expect(explained.waitStatus!.malformed).toEqual(["not-even-an-array"]);
  }, 60_000);

  it("the watchdog's 24h `waiting` warn NAMES the unsatisfied {key, at} pairs, not a generic message (§3.6 explainability)", async () => {
    const infra = await createTestComponent(admin, { name: "watchdog-infra" });
    const app = await createTestComponent(admin, { name: "watchdog-app" });
    const waiter = await admin.changes.propose({
      name: "watchdog-named waiter",
      targets: [app.id],
      requires: [{ key: "watchdog-key", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    // Simulate 25h of no progress (the `waiting` SLA is 24h) — `opts.now` is the established
    // clock-injection seam, same as coordination.integration.test.ts's watchdog tests.
    const farFuture = new Date(Date.now() + 25 * 60 * 60_000);
    const flags = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      runWatchdogSweep(tx, org.orgId, createInMemoryFakeHost(), server.deps.config.secretsMasterKey, {
        requestId: "coupling-watchdog-test",
        now: farFuture
      })
    );
    const flagged = flags.find((f) => f.changeObjectId === waiter.id);
    expect(flagged).toBeDefined();

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.id, flagged!.decisionId))
    );
    const reasonTree = rows[0]!.reasonTree as { waitingOn?: string };
    // The warn names the actual outstanding requirement — key AND scope — not a generic stall line.
    expect(reasonTree.waitingOn).toContain("watchdog-key");
    expect(reasonTree.waitingOn).toContain(infra.id);
    expect((rows[0]!.inputContext as Record<string, unknown>).unsatisfiedRequirements).toEqual([
      { key: "watchdog-key", at: infra.id }
    ]);
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // M12 P4B close-out — ROLLBACK EXEMPTION (coupled-pipelines.md §3.4): a rollback change NEVER
  // parks and inherits NEITHER half of a coupling. Today that is true because rollback.ts happens
  // not to spread the original's properties — an accident a tidy-up refactor could undo. This
  // pins it as behaviour.
  // -----------------------------------------------------------------------------------------

  it("a rollback of a coupled change neither waits nor inherits provides/requires — even when the original's prerequisite is no longer satisfied", async () => {
    const infra = await createTestComponent(admin, { name: "rollback-infra" });
    const app = await createTestComponent(admin, { name: "rollback-app" });

    const provider = await admin.changes.propose({
      name: "rollback-test provider",
      targets: [infra.id],
      provides: ["rollback-feature"]
    });
    await reaches(provider.id, "validating");

    // A change coupled on BOTH sides: requires the provider's key, provides one of its own.
    const coupled = await admin.changes.propose({
      name: "coupled change to roll back",
      targets: [app.id],
      provides: ["coupled-own-key"],
      requires: [{ key: "rollback-feature", at: infra.id }]
    });
    await reaches(coupled.id, "validating");

    // Kill the prerequisite: cancel the provider. If the rollback below INHERITED the original's
    // `requires`, no provider in {validating, promoted} would exist any more and it would park in
    // `waiting` forever — so it completing is the load-bearing assertion, not just a state check.
    await admin.changes.cancel(provider.id, "test: remove the satisfier before rolling back");

    const rollback = await admin.changes.rollback(coupled.id, "test: roll back the coupled change");
    expect(rollback.rollbackOfObjectId).toBe(coupled.id);
    // A rollback change auto-promotes once its waves succeed (reconcile's completeExecution).
    await reaches(rollback.id, "promoted");

    // Inherited NEITHER half of the coupling.
    const rolled = await admin.changes.get(rollback.id);
    expect(rolled.properties.requires).toBeUndefined();
    expect(rolled.properties.provides).toBeUndefined();

    // And it never parked: no waiting-entry Decision exists for it.
    const explained = await admin.changes.explain(rollback.id);
    const waitingTransitions = explained.decisions.filter(
      (d) =>
        d.kind === "transition" &&
        (d.inputContext as { toState?: string }).toState === "waiting"
    );
    expect(waitingTransitions).toHaveLength(0);
    expect(explained.waitStatus).toBeNull();
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // M12 P4B close-out — STARVATION (coupled-pipelines.md §3.5 hazard): the waiting sweep serves
  // oldest-`updated_at` first with a batch cap of 25 (reconcile's BATCH_LIMIT). Without the
  // round-robin bump, >25 stuck waiters with frozen `updated_at` would occupy every batch slot
  // forever and a releasable waiter behind them would never even be EVALUATED.
  // -----------------------------------------------------------------------------------------

  it("a releasable waiter behind >BATCH_LIMIT stuck waiters still releases (round-robin bump)", async () => {
    const STUCK_COUNT = 26; // one more than reconcile.ts's BATCH_LIMIT (25)
    const scope = await createTestComponent(admin, { name: "starvation-scope" });
    const app = await createTestComponent(admin, { name: "starvation-app" });

    // 26 waiters stuck on keys nobody will ever provide.
    const stuck: string[] = [];
    for (let i = 0; i < STUCK_COUNT; i += 1) {
      const c = await admin.changes.propose({
        name: `stuck waiter ${i}`,
        targets: [app.id],
        requires: [{ key: `never-provided-${i}`, at: scope.id }]
      });
      stuck.push(c.id);
    }
    for (const id of stuck) await reaches(id, "waiting", 60_000);

    // The releasable waiter arrives LAST — youngest `updated_at`, i.e. sorted BEHIND all 26 in the
    // oldest-first batch. This is exactly the row the pre-fix sweep could never reach.
    const releasable = await admin.changes.propose({
      name: "releasable waiter behind the stuck herd",
      targets: [app.id],
      requires: [{ key: "starvation-release", at: scope.id }]
    });
    await reaches(releasable.id, "waiting", 60_000);

    const provider = await admin.changes.propose({
      name: "provides starvation-release",
      targets: [scope.id],
      provides: ["starvation-release"]
    });
    await reaches(provider.id, "validating", 60_000);

    // Within a few sweeps the round-robin must rotate the releasable waiter into the batch and
    // release it. (Without the bump this times out: the same 25 frozen rows fill every batch.)
    await reaches(releasable.id, "validating", 60_000);

    // The stuck herd is untouched semantically: still waiting, not cancelled, not executed.
    expect(await stateOf(stuck[0]!)).toBe("waiting");
  }, 240_000);

  // -----------------------------------------------------------------------------------------
  // M12 P4B Phase 4 ergonomics close-out — KEY-REUSE WARN (coupled-pipelines.md §6#8): "key reuse
  // fails open" — if more than one change satisfies the same requirement key at the same `at`,
  // the chosen provider id is otherwise silently arbitrary. The release Decision must record every
  // qualifying provider, not just the one it pinned, WITHOUT ever blocking the release.
  // -----------------------------------------------------------------------------------------

  it("two providers of the same key@scope, one waiter: releases exactly once, and the release Decision records the ambiguity", async () => {
    const infra = await createTestComponent(admin, { name: "ambiguous-infra" });
    const app = await createTestComponent(admin, { name: "ambiguous-app" });

    const providerA = await admin.changes.propose({
      name: "ambiguous provider A",
      targets: [infra.id],
      provides: ["reused-key"]
    });
    await reaches(providerA.id, "validating");

    const providerB = await admin.changes.propose({
      name: "ambiguous provider B",
      targets: [infra.id],
      provides: ["reused-key"]
    });
    await reaches(providerB.id, "validating");

    // Both providers already validate BEFORE the waiter exists — required so the sweep sees BOTH
    // qualifying providers on the waiter's FIRST evaluation. A waiter proposed normally at this
    // point would skip `waiting` entirely: `advanceCoordinatedChanges` checks satisfaction AT the
    // coordinated->{waiting,executing} routing decision (reconcile.ts §"one whose prerequisites
    // are ALREADY satisfied — proceeds straight to executing"), so it would never touch the
    // `waiting -> executing` release path `ambiguousProvidersFor` hangs off — the same reason the
    // proposed-first ordering doesn't work here either: proposing the waiter before ANY provider,
    // then creating the two providers one at a time, races the sweep against providerB's creation
    // (as soon as providerA alone validates, the very next tick already finds the requirement
    // satisfied and releases before providerB exists — confirmed empirically, not a hypothetical).
    // So the waiter is materialized directly IN `waiting`, exactly the raw-insert technique the
    // malformed-requires tests above use for the same reason — but ALSO given a compiled plan
    // (`compileAndPersistPlan`, normally produced by the `evaluated -> coordinated` step this raw
    // insert bypasses), because without one `reconcileExecutingChange` finds no wave to run and
    // the change would hang in `executing` forever rather than ever reaching `validating`.
    const waiterObjectId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const appRow = await tx.select().from(objects).where(eq(objects.id, app.id));
      const now = new Date();
      await tx.insert(objects).values({
        id: waiterObjectId,
        orgId: org.orgId,
        domainId: appRow[0]!.domainId,
        typeId: "change",
        name: "raw waiter with two qualifying providers",
        urn: `urn:scp:test:change:ambiguous-waiter-${waiterObjectId}`,
        properties: { targets: [app.id], requires: [{ key: "reused-key", at: infra.id }] },
        labels: {},
        originDomainId: appRow[0]!.originDomainId,
        contentHash: "test-fixture",
        createdAt: now,
        updatedAt: now
      });
      await tx.insert(changes).values({
        objectId: waiterObjectId,
        orgId: org.orgId,
        state: "waiting",
        stateEnteredAt: now,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
      });
      await compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: waiterObjectId,
        targetObjectIds: [app.id],
        topologyObjectId: null,
        topologyVersion: null
      });
    });
    await reaches(waiterObjectId, "validating");

    // Releases exactly ONCE — a single `waiting -> executing` transition Decision, not one per
    // qualifying provider.
    const explained = await admin.changes.explain(waiterObjectId);
    const releases = explained.decisions.filter(
      (d) =>
        d.kind === "transition" &&
        (d.inputContext as { fromState?: string; toState?: string }).fromState === "waiting" &&
        (d.inputContext as { fromState?: string; toState?: string }).toState === "executing"
    );
    expect(releases).toHaveLength(1);

    // The ambiguity is recorded beside the pinned `satisfiedRequirements`, naming both providers —
    // never blocking (the waiter released anyway).
    const inputContext = releases[0]!.inputContext as {
      satisfiedRequirements: Array<{ key: string; at: string; satisfiedByChangeObjectId: string }>;
      ambiguousProviders?: Array<{ key: string; at: string; providerChangeObjectIds: string[] }>;
    };
    expect(inputContext.satisfiedRequirements).toEqual([
      {
        key: "reused-key",
        at: infra.id,
        satisfiedByChangeObjectId: inputContext.satisfiedRequirements[0]!.satisfiedByChangeObjectId
      }
    ]);
    expect(inputContext.ambiguousProviders).toEqual([
      { key: "reused-key", at: infra.id, providerChangeObjectIds: expect.arrayContaining([providerA.id, providerB.id]) }
    ]);
    expect(inputContext.ambiguousProviders![0]!.providerChangeObjectIds).toHaveLength(2);
  }, 60_000);

  it("a SINGLE provider (the common case) never records ambiguousProviders", async () => {
    const infra = await createTestComponent(admin, { name: "unambiguous-infra" });
    const app = await createTestComponent(admin, { name: "unambiguous-app" });

    // Waiter proposed FIRST (no provider exists yet) so it genuinely PARKS in `waiting` and its
    // release goes through `advanceWaitingChanges` — the one place `ambiguousProvidersFor` runs —
    // rather than the already-satisfied-at-propose-time fast path (`advanceCoordinatedChanges`
    // proceeding straight to `executing`), which pins no `satisfiedRequirements`/`ambiguousProviders`
    // at all. Same ordering as the pre-existing "parks, then releases" tests above.
    const waiter = await admin.changes.propose({
      name: "waiter with exactly one qualifying provider",
      targets: [app.id],
      requires: [{ key: "sole-key", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    const provider = await admin.changes.propose({
      name: "sole provider",
      targets: [infra.id],
      provides: ["sole-key"]
    });
    await reaches(provider.id, "validating");
    await reaches(waiter.id, "validating");

    const explained = await admin.changes.explain(waiter.id);
    const release = explained.decisions.find(
      (d) =>
        d.kind === "transition" &&
        (d.inputContext as { fromState?: string; toState?: string }).fromState === "waiting" &&
        (d.inputContext as { fromState?: string; toState?: string }).toState === "executing"
    );
    expect(release).toBeDefined();
    expect((release!.inputContext as Record<string, unknown>).ambiguousProviders).toBeUndefined();
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // M12 P4B Phase 4 ergonomics close-out — "DID YOU MEAN?" (coupled-pipelines.md §3.7): for an
  // UNSATISFIED requirement, wait-status additionally lists the `provides` keys that DO exist at
  // that `at` object — the typo-diagnosis aid `listProvidedKeysAtScope` exists for.
  // -----------------------------------------------------------------------------------------

  it("explain's wait status lists 'did you mean' provided keys for an outstanding (typo'd) requirement, at the SAME scope only", async () => {
    const infra = await createTestComponent(admin, { name: "didyoumean-infra" });
    const otherScope = await createTestComponent(admin, { name: "didyoumean-other-scope" });
    const app = await createTestComponent(admin, { name: "didyoumean-app" });

    // A real provider at `infra`, under the CORRECT key.
    const provider = await admin.changes.propose({
      name: "provides the real key",
      targets: [infra.id],
      provides: ["feature-a"]
    });
    await reaches(provider.id, "validating");

    // A provider at a DIFFERENT scope — must NOT show up in the "did you mean" for `infra`.
    const wrongScopeProvider = await admin.changes.propose({
      name: "provides a similarly-named key at the wrong scope",
      targets: [otherScope.id],
      provides: ["feature-z-wrong-scope"]
    });
    await reaches(wrongScopeProvider.id, "validating");

    // The waiter asks for a TYPO'd key at the right scope — never satisfied.
    const waiter = await admin.changes.propose({
      name: "waiter with a typo'd key",
      targets: [app.id],
      requires: [{ key: "feture-a", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    const explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus!.waiting).toBe(true);
    const req = explained.waitStatus!.requirements[0]!;
    expect(req.satisfied).toBe(false);
    expect(req.didYouMean).toEqual(["feature-a"]);
    expect(req.didYouMean).not.toContain("feature-z-wrong-scope");

    // `scp change wait-status` renders the SAME data via the SAME explain call — no dedicated route.
    // (Exercised at the SDK layer here; the CLI is a thin renderer over exactly this response.)
    expect(explained.waitStatus).toEqual((await admin.changes.explain(waiter.id)).waitStatus);
  }, 60_000);

  it("once satisfied, 'did you mean' disappears — the question is moot for a satisfied requirement", async () => {
    const infra = await createTestComponent(admin, { name: "didyoumean-satisfied-infra" });
    const app = await createTestComponent(admin, { name: "didyoumean-satisfied-app" });

    const waiter = await admin.changes.propose({
      name: "waiter that will be satisfied",
      targets: [app.id],
      requires: [{ key: "will-be-satisfied", at: infra.id }]
    });
    await reaches(waiter.id, "waiting");

    let explained = await admin.changes.explain(waiter.id);
    // No provider exists at all yet — nothing to suggest.
    expect(explained.waitStatus!.requirements[0]!.didYouMean ?? []).toEqual([]);

    const provider = await admin.changes.propose({
      name: "provides will-be-satisfied",
      targets: [infra.id],
      provides: ["will-be-satisfied"]
    });
    await reaches(provider.id, "validating");
    await reaches(waiter.id, "validating");

    explained = await admin.changes.explain(waiter.id);
    expect(explained.waitStatus!.requirements[0]!.satisfied).toBe(true);
    expect(explained.waitStatus!.requirements[0]!.didYouMean).toBeUndefined();
  }, 60_000);
});

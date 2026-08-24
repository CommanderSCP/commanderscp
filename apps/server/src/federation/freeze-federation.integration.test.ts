import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { ProblemError } from "../errors.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { createObject, updateObject } from "../graph/objects-repo.js";
import {
  createFreeze,
  liftFreeze,
  listFreezes,
  updateFreezeWindow
} from "../governance/freezes-repo.js";
import { attachFreezeObject, syncFreezeObject } from "../governance/freeze-object.js";
import { evaluateFreezeHolds } from "../coordination/freeze-hold.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { pairPeer } from "./peers-repo.js";
import { ensureFederationSelf, initFederationSelf, type FederationSelf } from "./self-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * ================================================================================================
 * M25.7 (owner decision D6, ADR-0043) — AN ORG-TIER FREEZE DECLARED AT THE COMMANDER BLOCKS AT THE
 * OUTPOST. AND THE FOUR CONTROLS WITHOUT WHICH THAT SENTENCE IS CHEAP.
 * ================================================================================================
 *
 * THIS INCREMENT RETRACTS A DELIBERATE, TESTED ABSENCE. Until 2026-08-24 no freeze could cross a
 * boundary at all: a freeze was a projection row with no graph object, `JournalEntryKindSchema`
 * carries nine kinds and none is freeze-shaped, `coordination/service-board-precedence.integration.
 * test.ts` pinned the absence, and `apps/web/src/routes/outpost-configuration.tsx` explained it to
 * operators verbatim. D6 overturns it for the ORG TIER ONLY.
 *
 * Run on the real two-database harness (`test-support/isolated-domain.ts` — two separate Postgres
 * DATABASES, because federation import preserves an object's id VERBATIM and two orgs sharing one
 * physical `objects` table would collide on a primary key no real deployment can), through the real
 * export -> verify -> import path, exactly as `outpost-config-sync.integration.test.ts` does for
 * ADR-0022's `outpost` object. No new harness: the point of choosing a graph object is that there is
 * no freeze-specific transport to test.
 *
 * ================================================================================================
 * THE ASSERTION IS ADMISSION, NOT ROW EXISTENCE
 * ================================================================================================
 * A `freezes` row at the outpost proves replication and nothing else. What D6 asked for is that the
 * freeze STOPS SOMETHING, so case B drives `coordination/freeze-hold.ts`'s `evaluateFreezeHolds` —
 * the predicate `reconcile.ts`'s per-target `continue` actually reads before triggering a wave
 * target — and asserts the replicated component is HELD, naming the commander's freeze id.
 *
 * ================================================================================================
 * THE CONTROLS, AND WHY EACH ONE EXISTS
 * ================================================================================================
 *  - CASE D — a freeze authored WITHOUT `federate` appears in NO bundle entry and produces NO row
 *    at the outpost. Without this, "it federates" is satisfied by a change that federates
 *    EVERYTHING, which is both the wrong feature and a confidentiality regression.
 *  - CASE E — a PLATFORM-tier freeze still does not federate. The sync journal is org-scoped at
 *    every layer and `instance_freezes` has no `org_id`; ADR-0040 and GLOSSARY both say so and both
 *    must stay true after this increment.
 *  - CASE C — re-importing the same bundle converges. `ON CONFLICT (id) DO UPDATE` on a key that is
 *    the ORIGIN's freeze id is the whole idempotency argument; a duplicate row would double every
 *    hold and make the second one un-liftable from anywhere.
 *  - CASE F — the outpost cannot LIFT or SHORTEN the commander's freeze, through either write verb
 *    or through the raw graph write path. A guard on `objects` alone would leave `freezes.lifted_at`
 *    — the column the window predicate actually filters on — locally writable.
 *  - CASE G — an outpost-declared `domainLocal` freeze never travels (ADR-0031).
 *
 * NO FIXED SLEEPS ANYWHERE (`integration-sleep-census.test.ts` is a CI gate). Nothing here is
 * asynchronous in the wall-clock sense: every step is a transaction this test drives itself, and the
 * one clock-sensitive predicate (`evaluateFreezeHolds`) takes an injectable `now`.
 */
describe("M25.7: an org-tier freeze federates and blocks at the outpost (Testcontainers, two databases)", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let commanderSelf: FederationSelf;
  let outpostSelf: FederationSelf;

  /** The component the commander freezes. Replicated to the outpost by the same bundle. */
  let componentId: string;
  /** A second component nothing freezes — the per-target control inside case B. */
  let siblingComponentId: string;
  /** The federating freeze's row id, identical at both instances by construction. */
  let federatedFreezeId: string;

  const WINDOW_START = new Date("2026-01-01T00:00:00.000Z");
  const WINDOW_END = new Date("2027-01-01T00:00:00.000Z");
  /** Inside the window, injected rather than slept to. */
  const DURING = new Date("2026-06-01T00:00:00.000Z");

  async function expectProblem(
    call: Promise<unknown>,
    status: number,
    detail: RegExp
  ): Promise<void> {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ProblemError);
        const problem = err as ProblemError;
        expect(problem.status).toBe(status);
        expect(problem.detail ?? "").toMatch(detail);
      }
    );
  }

  /** Registers `b` as a peer of `a` with `b`'s REAL exchanged public key (DESIGN §13 pairing). */
  async function pair(
    a: IsolatedDomain,
    b: IsolatedDomain,
    role: "commander" | "outpost"
  ): Promise<void> {
    const key = await withTenantTx(b.db, b.orgId, (tx) => ensureInstanceKey(tx, b.orgId));
    const self = await withTenantTx(b.db, b.orgId, (tx) => ensureFederationSelf(tx, b.orgId));
    await withTenantTx(a.db, a.orgId, (tx) =>
      pairPeer(tx, {
        orgId: a.orgId,
        domainId: self.domainId,
        name: b.orgName,
        role,
        publicKey: key.publicKey
      })
    );
  }

  /** The commander's own journal tail, exported and imported at the outpost, as production does. */
  async function syncDown(): Promise<void> {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
  }

  /** Every entry the commander would ship to the outpost right now, from sequence 0. */
  async function commanderBundleEntries() {
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName)
    );
    return bundle.entries;
  }

  async function outpostFreezeRows() {
    return withTenantTx(outpost.db, outpost.orgId, (tx) => listFreezes(tx, outpost.orgId));
  }

  beforeAll(async () => {
    commander = await createIsolatedDomain("cmdrFrz");
    outpost = await createIsolatedDomain("outpFrz");

    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      initFederationSelf(tx, {
        orgId: commander.orgId,
        name: commander.orgName,
        role: "commander"
      })
    );
    outpostSelf = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      initFederationSelf(tx, { orgId: outpost.orgId, name: outpost.orgName, role: "outpost" })
    );

    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");

    // The estate the freeze is about. Ordinary `component` objects, created at the COMMANDER, so
    // they replicate down with their ids intact and the outpost's containment walk can reach them.
    const [frozen, sibling] = await withTenantTx(commander.db, commander.orgId, async (tx) => [
      await createObject(tx, {
        orgId: commander.orgId,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "m257-component",
        name: "checkout-api"
      }),
      await createObject(tx, {
        orgId: commander.orgId,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "m257-sibling",
        name: "search-api"
      })
    ]);
    componentId = frozen!.id;
    siblingComponentId = sibling!.id;
  }, 180_000);

  afterAll(async () => {
    await commander?.close();
    await outpost?.close();
  });

  it("A: a commander freeze declared `federate` arrives at the outpost as a `freeze` object with the COMMANDER's origin, and rebuilds a projection row with the SAME id", async () => {
    const declared = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const row = await createFreeze(tx, {
        orgId: commander.orgId,
        scopeObjectId: componentId,
        name: "quarter close",
        startsAt: WINDOW_START,
        endsAt: WINDOW_END,
        reason: "commander-declared change freeze",
        createdByActorId: commander.orgId
      });
      return attachFreezeObject(tx, {
        orgId: commander.orgId,
        freeze: row,
        actorObjectId: commander.orgId,
        requestId: "m257-declare"
      });
    });
    federatedFreezeId = declared.id;
    expect(declared.objectId).not.toBeNull();

    await syncDown();

    // The OBJECT landed, authored by the commander — the ADR-0022 shape, re-proven for `freeze`.
    const replicated = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      tx
        .select()
        .from(objects)
        .where(and(eq(objects.orgId, outpost.orgId), eq(objects.id, declared.objectId!)))
        .limit(1)
    );
    expect(replicated[0]?.typeId).toBe("freeze");
    expect(replicated[0]?.originDomainId).toBe(commanderSelf.domainId);
    expect(replicated[0]?.originDomainId).not.toBe(outpostSelf.domainId);

    // …and the PROJECTION ROW was rebuilt from it. Same id as the commander's, which is what keeps
    // a `freeze_admission` Decision written here resolvable against `GET /v1/freezes/{id}` there.
    const rows = await outpostFreezeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(declared.id);
    expect(rows[0]!.objectId).toBe(declared.objectId);
    expect(rows[0]!.scopeObjectId).toBe(componentId);
    expect(rows[0]!.reason).toBe("commander-declared change freeze");
    expect(rows[0]!.startsAt.toISOString()).toBe(WINDOW_START.toISOString());
    expect(rows[0]!.endsAt.toISOString()).toBe(WINDOW_END.toISOString());
    expect(rows[0]!.liftedAt).toBeNull();
  });

  it("B: THE POINT — the imported freeze BLOCKS a change at the outpost, and holds only what it covers", async () => {
    // `evaluateFreezeHolds` is the predicate `reconcile.ts`'s per-target loop reads immediately
    // before `triggerWaveTarget`; a target present in this map is a target that will not be
    // triggered. Asserting a ROW exists would prove replication and nothing about admission.
    const holds = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId: outpost.orgId,
        targetObjectIds: [componentId, siblingComponentId],
        now: DURING
      })
    );

    const held = holds.get(componentId);
    expect(held, "the outpost did not hold the component the commander froze").toBeDefined();
    expect(held!.freezes.map((f) => f.id)).toEqual([federatedFreezeId]);
    expect(held!.freezes[0]!.tier).toBe("org");
    expect(held!.freezes[0]!.name).toBe("quarter close");
    // The per-target control INSIDE the positive case (ADR-0039): a freeze that covers one target
    // must not park its siblings, and an "everything is held" bug would satisfy the line above.
    expect(holds.has(siblingComponentId)).toBe(false);
  });

  it("C: re-importing the SAME bundle is a no-op — one row, unchanged", async () => {
    const before = await outpostFreezeRows();
    await syncDown();
    await syncDown();
    const after = await outpostFreezeRows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    // `created_at` defaults to `now()` on INSERT, so a second INSERT (rather than the intended
    // ON CONFLICT DO UPDATE) would move it even if the id somehow survived.
    expect(after[0]!.createdAt.toISOString()).toBe(before[0]!.createdAt.toISOString());
    expect(after[0]!.objectId).toBe(before[0]!.objectId);
  });

  it("D: THE CONTROL — a freeze authored WITHOUT `federate` rides no bundle and produces no row at the outpost", async () => {
    // Without this case, "it federates" would be satisfied by an implementation that federates
    // every freeze — the wrong feature, and a confidentiality regression on every existing estate.
    const local = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createFreeze(tx, {
        orgId: commander.orgId,
        scopeObjectId: siblingComponentId,
        name: "local only",
        startsAt: WINDOW_START,
        endsAt: WINDOW_END,
        reason: "not federated",
        createdByActorId: commander.orgId
      })
    );
    expect(local.objectId).toBeNull();

    const entries = await commanderBundleEntries();
    const mentions = entries.filter((e) => JSON.stringify(e.payload).includes(local.id));
    expect(mentions, "a non-federating freeze reached the wire").toEqual([]);

    await syncDown();
    const rows = await outpostFreezeRows();
    expect(rows.map((r) => r.id)).toEqual([federatedFreezeId]);

    // And it still blocks WHERE IT WAS DECLARED — a control that only proved "nothing happened"
    // would also pass against a create that silently failed.
    const homeHolds = await withTenantTx(commander.db, commander.orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId: commander.orgId,
        targetObjectIds: [siblingComponentId],
        now: DURING
      })
    );
    expect(homeHolds.get(siblingComponentId)?.freezes.map((f) => f.id)).toEqual([local.id]);
  });

  it("E: a PLATFORM-tier freeze still does not federate — the journal is org-scoped at every layer", async () => {
    // Written over the ADMIN connection because `instance_freezes` is operator-write / tenant-read
    // (drizzle/0086 + 0076): production writes it through the deployment-token route on the
    // operator connection, and the tenant pool structurally cannot.
    const adminPool = new pg.Pool({ connectionString: commander.adminUrl });
    const platformId = uuidv7();
    try {
      await adminPool.query(
        `INSERT INTO instance_freezes (id, key, name, starts_at, ends_at, reason, match_all_environments)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [
          platformId,
          "m257-platform",
          "deployment-wide",
          WINDOW_START.toISOString(),
          WINDOW_END.toISOString(),
          "operator maintenance"
        ]
      );
    } finally {
      await adminPool.end();
    }

    // No entry names it, in either identity it has.
    const entries = await commanderBundleEntries();
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain(platformId);
    expect(serialised).not.toContain("m257-platform");

    await syncDown();

    // …and the outpost's own instance table is untouched. Read over the outpost's ADMIN connection
    // so the assertion is about the TABLE and not about what the tenant role may select.
    const outpostAdmin = new pg.Pool({ connectionString: outpost.adminUrl });
    try {
      const { rows } = await outpostAdmin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM instance_freezes`
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await outpostAdmin.end();
    }
    // The org-tier freeze is still there, so this case is not passing because sync broke.
    expect((await outpostFreezeRows()).map((r) => r.id)).toEqual([federatedFreezeId]);
  });

  it("F: the OUTPOST cannot lift or shorten the commander's freeze — 409 on both write verbs and on the raw graph write", async () => {
    // (a) LIFT. The verb an outpost operator would actually reach for.
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        liftFreeze(tx, {
          orgId: outpost.orgId,
          id: federatedFreezeId,
          reason: "we want to ship",
          actorObjectId: outpost.orgId
        })
      ),
      409,
      // The refusal must NAME THE REMEDY, not just refuse: an outpost operator who is told only
      // "no" has no next step, and the next step is deliberately not "ask the commander to lift it".
      /read-only replica declared by domain .*freeze:override/is
    );

    // (b) SHORTEN. The verb a guard installed only on the lift path would leave open — and it
    //     achieves the same retraction by moving `endsAt` into the past.
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        updateFreezeWindow(tx, {
          orgId: outpost.orgId,
          id: federatedFreezeId,
          endsAt: new Date("2026-01-02T00:00:00.000Z"),
          reason: "we want to ship",
          actorObjectId: outpost.orgId
        })
      ),
      409,
      /read-only replica declared by domain/i
    );

    // (c) THE RAW GRAPH WRITE, so the refusal is provably `graph/objects-repo.ts`'s EXISTING
    //     single-writer guard and not something this increment invented on top. If someone later
    //     makes the outpost path writable, all three halves go red together.
    const objectId = (await outpostFreezeRows())[0]!.objectId!;
    await expectProblem(
      withTenantTx(outpost.db, outpost.orgId, (tx) =>
        updateObject(tx, {
          orgId: outpost.orgId,
          typeId: "freeze",
          actorObjectId: outpost.orgId,
          requestId: "m257-outpost-raw-write",
          idOrUrn: objectId,
          properties: { freezeId: federatedFreezeId, liftedAt: new Date().toISOString() }
        })
      ),
      409,
      /read-only replica/i
    );

    // NOTHING MOVED, and it is still holding. A refusal that left a half-write behind is not a
    // refusal, and this is the assertion that distinguishes them.
    const after = (await outpostFreezeRows())[0]!;
    expect(after.liftedAt).toBeNull();
    expect(after.endsAt.toISOString()).toBe(WINDOW_END.toISOString());
    const holds = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId: outpost.orgId,
        targetObjectIds: [componentId],
        now: DURING
      })
    );
    expect(holds.has(componentId)).toBe(true);
  });

  it("F2: the COMMANDER's lift DOES reach down — an entrance with no exit is the defect M25.1 removed, and it must not come back one boundary over", async () => {
    const lifted = await withTenantTx(commander.db, commander.orgId, async (tx) => {
      const row = await liftFreeze(tx, {
        orgId: commander.orgId,
        id: federatedFreezeId,
        reason: "incident resolved",
        actorObjectId: commander.orgId
      });
      await syncFreezeObject(tx, {
        orgId: commander.orgId,
        freeze: row,
        actorObjectId: commander.orgId,
        requestId: "m257-lift"
      });
      return row;
    });
    expect(lifted.liftedAt).not.toBeNull();

    await syncDown();

    const row = (await outpostFreezeRows()).find((r) => r.id === federatedFreezeId)!;
    expect(row.liftedAt).not.toBeNull();
    expect(row.liftReason).toBe("incident resolved");
    // The only filter that matters: `activeFreezesInWindow`'s `lifted_at IS NULL`. The outpost
    // stops holding on the next evaluation, with no lift-specific code anywhere in reconcile.
    const holds = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId: outpost.orgId,
        targetObjectIds: [componentId],
        now: DURING
      })
    );
    expect(holds.has(componentId)).toBe(false);
  });

  it("G: an OUTPOST-declared `domainLocal` freeze blocks locally and never travels (ADR-0031)", async () => {
    // Locality is DECLARED, never inferred. `scope-filter.ts` withholds a domain-local entry in
    // BOTH directions even under `full` scope — and `objects-repo.ts` does not journal it at all,
    // so there is nothing to withhold in the first place.
    const local = await withTenantTx(outpost.db, outpost.orgId, async (tx) => {
      const component = await createObject(tx, {
        orgId: outpost.orgId,
        typeId: "component",
        actorObjectId: outpost.orgId,
        requestId: "m257-outpost-component",
        name: "edge-cache"
      });
      const row = await createFreeze(tx, {
        orgId: outpost.orgId,
        scopeObjectId: component.id,
        name: "site maintenance",
        startsAt: WINDOW_START,
        endsAt: WINDOW_END,
        reason: "outpost-declared",
        createdByActorId: outpost.orgId
      });
      const attached = await attachFreezeObject(tx, {
        orgId: outpost.orgId,
        freeze: row,
        actorObjectId: outpost.orgId,
        requestId: "m257-outpost-declare",
        domainLocal: true
      });
      return { componentId: component.id, freeze: attached };
    });
    expect(local.freeze.objectId).not.toBeNull();

    // It blocks HERE — the positive half, without which "it did not travel" is satisfied by a
    // freeze that was never created.
    const holds = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      evaluateFreezeHolds(tx, {
        orgId: outpost.orgId,
        targetObjectIds: [local.componentId],
        now: DURING
      })
    );
    expect(holds.get(local.componentId)?.freezes.map((f) => f.id)).toEqual([local.freeze.id]);

    // …and nothing about it reaches the commander. Exported from the OUTPOST's own journal, which
    // is the direction a domain-local declaration is normally worried about.
    const upward = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName)
    );
    const serialised = JSON.stringify(upward.entries);
    expect(serialised).not.toContain(local.freeze.id);
    expect(serialised).not.toContain(local.freeze.objectId!);
  });
});

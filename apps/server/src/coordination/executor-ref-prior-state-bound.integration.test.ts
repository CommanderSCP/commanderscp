import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { mkdtempTrackedForFile } from "@scp/test-tmpdir";
import { PERSISTED_JSON_ELIDED_KEY, PERSISTED_JSON_MAX_CHARS } from "@scp/runner-launcher";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets } from "../db/schema.js";

/** HIGH (M23.0 verification pass 12). See docs/coordination.md §470. */

/** The vendor fields a real executor returns beside the two `ExternalRunRef` names. Small, many,
 *  and — the point — emitted BEFORE `externalId`, because insertion order is what the bound seats
 *  in and a plugin does not put the field we depend on first. */
const VENDOR_FIELD_COUNT = 200;
const vendorFields = Object.fromEntries(
  Array.from({ length: VENDOR_FIELD_COUNT }, (_, i) => [`x-vendor-${i}`, `v${i}`])
);

/** An escape, not a literal: a NUL byte in a tracked source file is dropped by every recursive
 *  search this repository runs (CLAUDE.md). */
const NUL = "\u0000";
/** Everything this bound is made of, handed back to it as DATA, on the column whose damage strands
 *  a target for good: the byte `jsonb` refuses, astral pairs for the width cut to land inside, and
 *  the bound's own two markers as content. */
const HOSTILE_URL =
  `fake-executor://hostile/${NUL}${PERSISTED_JSON_ELIDED_KEY}[elided: 9 more entries]` +
  `${"\u{1F600}\u{1F4A9}\u{10000}".repeat(1_500)}${NUL}END`;

/** The structured prior state. `version` is LAST, so it is the leaf a prefix-seating rule drops,
 *  and 7 is deliberately not a version any trigger in this file would reach by accident. */
const PRIOR_STATE_VERSION = "v7";
const structuredPriorState = {
  ...Object.fromEntries(
    Array.from({ length: VENDOR_FIELD_COUNT }, (_, i) => [`tf-resource-${i}`, `serial-${i}`])
  ),
  version: PRIOR_STATE_VERSION
};

describe("executor_ref and prior_state_ref: the two bounded columns nothing drove end to end", () => {
  let server: ListeningTestServer;
  let statePath: string;
  let orgId: string;
  let admin: ScpClient;
  const manyFieldTargetId = uuidv7();
  const hostileTargetId = uuidv7();
  const priorStateTargetId = uuidv7();

  beforeAll(async () => {
    // NON-VACUITY, BEFORE THE SERVER BOOTS. Each clause is a separate way an arm could go vacuous:
    // a ref small enough that no rule would have cut it, a hostile string carrying no NUL, a
    // structured prior state the old flat rule would have seated whole anyway.
    expect(JSON.stringify({ ...vendorFields, externalId: "x" }).length).toBeGreaterThan(2_000);
    expect(VENDOR_FIELD_COUNT * 96).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);
    expect(HOSTILE_URL.includes(NUL)).toBe(true);
    expect(HOSTILE_URL.length).toBeGreaterThan(PERSISTED_JSON_MAX_CHARS);
    expect(Object.keys(structuredPriorState).at(-1)).toBe("version");

    // Our own state file, so the arm reads what was decided. See docs/coordination.md §471.
    const stateDir = await mkdtempTrackedForFile(join(tmpdir(), "scp-test-exec-ref-"));
    statePath = join(stateDir, "fake-executor-state.json");

    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      fakeExecutorConfig: {
        statePath,
        runRefExtrasByTarget: {
          [manyFieldTargetId]: vendorFields,
          [hostileTargetId]: { vendorPayload: HOSTILE_URL }
        },
        stateRefByTarget: {
          [priorStateTargetId]: structuredPriorState
        }
      }
    });

    const org = await createTestOrg(server, "executor-ref-bound");
    orgId = org.orgId;
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** The most recent wave target row for a component, once it carries an `executor_ref`. */
  async function triggeredRow(forTargetId: string) {
    return waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, orgId),
                eq(changeWaveTargets.targetObjectId, forTargetId)
              )
            )
            .orderBy(desc(changeWaveTargets.createdAt))
            .limit(1)
        );
        return rows.find((r) => r.executorRef !== null);
      },
      { describe: `an executor_ref for ${forTargetId}`, timeoutMs: 30_000 }
    );
  }

  /** Waits to leave proposed, and only if still waiting. See docs/coordination.md §472. */
  async function proposeAndAccept(name: string, targetObjectId: string): Promise<string> {
    const change = await admin.changes.propose({ name, targets: [targetObjectId] });
    const state = await waitUntil(
      async () => {
        const current = (await admin.changes.get(change.id)).state;
        return current === "proposed" ? undefined : current;
      },
      { describe: `change ${change.id} (${name}) leaves 'proposed'`, timeoutMs: 20_000 }
    );
    if (state === "validating") await admin.changes.accept(change.id);
    return change.id;
  }

  it("ARM 1: `externalId` survives a ref whose vendor fields come first, so the run is still pollable", async () => {
    const component = await createTestComponent(admin, {
      id: manyFieldTargetId,
      name: "exec-ref-many-fields"
    });
    expect(component.id).toBe(manyFieldTargetId);
    await proposeAndAccept("a change whose executor returns 200 vendor fields", manyFieldTargetId);

    const row = await triggeredRow(manyFieldTargetId);
    const ref = row.executorRef as Record<string, unknown>;

    // The row really was bounded, and the ref really was the many-field shape — otherwise this arm
    // is about a payload nothing cut.
    expect(JSON.stringify(ref).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    expect(Object.keys(ref).length).toBeGreaterThan(50);
    expect(ref["x-vendor-0"]).toBe("v0");

    // THE LEAF, READ THE WAY EVERY EXECUTOR PLUGIN READS IT. `parseTargetRef` splits on `::`, and
    // `status()` compares the whole string against the run it minted.
    expect(typeof ref.externalId).toBe("string");
    expect(String(ref.externalId).startsWith(`${manyFieldTargetId}::`)).toBe(true);

    // THE LEVER, NOT THE SIGNAL. A `succeeded` target is proof that `status(executor_ref)`
    // recognised the run; a damaged `externalId` yields `pending` ("unknown run"), reconcile writes
    // `observing`, and this never terminalises — no error anywhere.
    const settled = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, row.id)))
        );
        return rows[0]?.status === "succeeded" ? rows[0] : undefined;
      },
      {
        describe: `wave target ${row.id} terminalises (i.e. status() could interpret its ref)`,
        timeoutMs: 30_000
      }
    );
    expect(settled.status).toBe("succeeded");
  });

  it("ARM 2: a ref carrying a NUL, astral pairs and this bound's own markers is still WRITTEN", async () => {
    const component = await createTestComponent(admin, {
      id: hostileTargetId,
      name: "exec-ref-hostile"
    });
    expect(component.id).toBe(hostileTargetId);
    await proposeAndAccept("a change whose executor returns a hostile run ref", hostileTargetId);

    // Reaching `triggered` at all IS the assertion: `markWaveTargetTriggered` writes this ref into
    // a `jsonb` column, and `jsonb` refuses U+0000 outright. Unsanitised, that update throws, the
    // row stays `triggering`, and the next tick re-claims and re-fires the trigger, forever.
    const row = await triggeredRow(hostileTargetId);
    const ref = row.executorRef as Record<string, unknown>;
    expect(JSON.stringify(ref).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);

    // NON-VACUITY, AND IT IS NOT OPTIONAL HERE. Measured while writing the mutation log: with the
    // `runRefExtrasByTarget` seam deleted this arm went GREEN, because the whole hostile payload
    // rides on that seam and the ref went back to `{externalId, url}` — the arm would then be
    // asserting that an ordinary ref is persistable. So the payload's arrival is asserted first.
    const payload = String(ref.vendorPayload);
    expect(typeof ref.vendorPayload, "the hostile payload never reached the column").toBe("string");
    expect(payload.length).toBeGreaterThan(1_000);
    // U+FFFD is what `persistableText` leaves where a NUL was, one code unit for one — so its
    // presence is proof the NUL really travelled through the plugin host and was SANITISED here,
    // rather than never having been in the value.
    expect(payload.includes("\uFFFD"), "no NUL ever reached the sanitiser").toBe(true);

    // What Postgres actually accepted: no NUL, and well-formed UTF-16 (a width cut landing inside
    // a surrogate pair is the other half of the §4.4a incident).
    const persisted = JSON.stringify(ref)!;
    expect(persisted.includes(NUL)).toBe(false);
    expect((persisted as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);

    // And the leaf every plugin reads is intact beside 8 000 characters of hostile sibling.
    expect(String(ref.externalId).startsWith(`${hostileTargetId}::`)).toBe(true);
    const settled = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, row.id)))
        );
        return rows[0]?.status === "succeeded" ? rows[0] : undefined;
      },
      { describe: `hostile-ref wave target ${row.id} terminalises`, timeoutMs: 30_000 }
    );
    expect(settled.status).toBe("succeeded");
  });

  it("ARM 3: a rollback restores the state the ORIGINAL run reported, not the fallback", async () => {
    const component = await createTestComponent(admin, {
      id: priorStateTargetId,
      name: "prior-state-structured"
    });
    expect(component.id).toBe(priorStateTargetId);

    // Change 1 gives the target a succeeded run, which is what change 2's trigger snapshots its
    // prior state FROM (`findLatestSucceededExecution` + a fresh `status()` call).
    await proposeAndAccept("change 1", priorStateTargetId);
    await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, orgId),
                eq(changeWaveTargets.targetObjectId, priorStateTargetId),
                eq(changeWaveTargets.status, "succeeded")
              )
            )
        );
        return rows.length > 0 ? rows : undefined;
      },
      { describe: "change 1 succeeded", timeoutMs: 30_000 }
    );

    const change2 = await proposeAndAccept("change 2", priorStateTargetId);
    const change2Target = await waitUntil(
      async () => {
        const rows = await withTenantTx(server.deps.db, orgId, (tx) =>
          tx
            .select()
            .from(changeWaveTargets)
            .where(
              and(
                eq(changeWaveTargets.orgId, orgId),
                eq(changeWaveTargets.targetObjectId, priorStateTargetId)
              )
            )
            .orderBy(desc(changeWaveTargets.createdAt))
            .limit(1)
        );
        return rows.find((r) => r.priorStateRef !== null);
      },
      { describe: "change 2 captured a prior_state_ref", timeoutMs: 30_000 }
    );

    // THE COLUMN. Bounded, and the load-bearing leaf — the LAST key of 201 — is still there.
    const prior = change2Target.priorStateRef as Record<string, unknown>;
    expect(JSON.stringify(prior).length).toBeLessThanOrEqual(PERSISTED_JSON_MAX_CHARS);
    expect(prior["tf-resource-0"]).toBe("serial-0");
    expect(prior.version, "the leaf a rollback reads was elided").toBe(PRIOR_STATE_VERSION);

    // THE LEVER: the executor's own `coercePriorStateRef` over the persisted column, observed in
    // the executor's own state. Version 7 is only reachable by reading that leaf; every failure
    // mode of the coercion falls back to 0.
    const rollback = await admin.changes.rollback(change2, "pass 12: undo change 2");
    expect(rollback.rollbackOfObjectId).toBe(change2);
    await waitUntil(
      async () => ((await admin.changes.get(change2)).state === "rolled_back" ? true : undefined),
      { describe: `change 2 ${change2} reaches 'rolled_back'`, timeoutMs: 30_000 }
    );

    const executorState = JSON.parse(await readFile(statePath, "utf8")) as {
      targets: Record<string, { version: number }>;
    };
    expect(
      executorState.targets[priorStateTargetId]?.version,
      "the rollback restored the coercion's fallback, i.e. the prior state was unreadable"
    ).toBe(Number(PRIOR_STATE_VERSION.slice(1)));
  });
});

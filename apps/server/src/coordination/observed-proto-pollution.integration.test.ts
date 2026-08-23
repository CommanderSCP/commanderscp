import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { and, desc, eq } from "drizzle-orm";
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

/**
 * ================================================================================================
 * M23.0 verification pass 15 — `__proto__` FROM A REAL PLUGIN, THROUGH A REAL SUBPROCESS, INTO A
 * REAL POSTGRES ROW.
 * ================================================================================================
 * Pass 14 found prototype pollution reachable from an untrusted executor's response and closed it
 * with `isUnsafePersistedKey`. Everything that proves it is a UNIT test over a value handed
 * straight to `boundPersistedJson` (`persisted-json-proto.test.ts`). That is the same gap pass 12
 * recorded for `executor_ref`: the defect is about what a PLUGIN can put in a ROW, and no fixture
 * drove a plugin.
 *
 * The gap is not academic, because `__proto__` only behaves this way on a specific path. Writing
 * `{ __proto__: x }` in TypeScript sets the prototype and produces NO own key, so a test written
 * the obvious way asserts nothing. The key has to arrive the way a plugin's actually does:
 * `JSON.parse`, which is specified to DEFINE the property rather than assign it. This file makes
 * every hop real —
 *
 *     JSON.parse in the test  ->  config JSON  ->  plugin subprocess  ->  JSON-RPC response
 *       ->  the server's JSON.parse  ->  boundPluginJson  ->  jsonb column  ->  read back
 *
 * — and asserts on the row, not on a return value.
 *
 * BOTH WRITE SITES, because the guard is spelled twice and a census that checked one would have
 * missed the other:
 *   * `executor_ref` via `runRefExtrasByTarget` — the key lands at the ROOT of the walked object,
 *     which is the only place `walkObjectFields` phase 1 can refuse a ROOT field;
 *   * `observed_state.rollout` via `rolloutByTarget` — NESTED, so it exercises the same guard at
 *     depth, where the loss has to roll up into the root field that contains it.
 *
 * WHAT "HANDLED DELIBERATELY" MEANS HERE, stated so a future round cannot satisfy it by accident:
 * the stored object's prototype is `Object.prototype`, the key is not an own property of the row,
 * nothing the plugin nested under it is readable through the row, and — for `observed_state`, the
 * column an operator reads — the loss is REPORTED rather than silent. `executor_ref` gets no report
 * by the deliberate decision recorded in `wave-targets-repo.ts`, and this file pins that too, so
 * "no signal there" stays a decision instead of decaying into an oversight.
 *
 * ================================================================================================
 * AND ONE THING THIS FILE MEASURED THAT THE THREAT MODEL DID NOT SAY — READ THIS BEFORE ADDING AN
 * ARM HERE
 * ================================================================================================
 * THE POLLUTION ITSELF DOES NOT SURVIVE INTO THE ROW, AND NO ROW ASSERTION CAN SEE IT. Measured by
 * deleting `isUnsafePersistedKey`'s guard, rebuilding, and re-running this file: the four
 * prototype/own-key/payload/serialised-form checks in `assertNotAGadget` ALL STAYED GREEN for
 * `executor_ref`. `JSON.stringify` does not serialise a prototype, so a polluted object becomes a
 * clean row on its way into `jsonb`, and `JSON.parse` on the way out hands back an object whose
 * prototype is `Object.prototype` no matter what happened in the server's memory.
 *
 * So pass 14's defect is an IN-PROCESS hazard — the object the server holds between the bound and
 * the write, whose failed property lookups consult plugin data — and `persisted-json-proto.test.ts`
 * is the right instrument for it. What IS observable at the row is the defect's SECOND half, which
 * pass 14 recorded and nothing drove end to end: the field is CHARGED against the budget and then
 * silently dropped, so its siblings are cut to pay for a field that was never stored. That is what
 * the root arm below asserts, with a fixture measured to separate the two builds at the production
 * budget (`vendorField` survives whole at 4 000 characters; against the unguarded build it comes
 * back at 3 822). An arm here that only reads prototypes proves nothing — it is green either way.
 */

/**
 * A root-level `__proto__`, as a plugin's serialiser would actually emit it. Built by `JSON.parse`
 * because the object literal `{ __proto__: … }` sets the prototype and creates no own key — a test
 * written that way is green against the unguarded build too.
 *
 * THE TWO LENGTHS ARE MEASURED, NOT DECORATIVE. `executor_ref` is bounded at the default
 * `PERSISTED_JSON_MAX_CHARS` (8 000). At 4 000 + 4 000 the pair saturates it, so a `__proto__`
 * field that is charged and then dropped takes its cost out of `vendorField` — the only
 * ROW-OBSERVABLE consequence of the guard (see the header). Measured END TO END across the two
 * builds — through the plugin, so the run ref's own `externalId` and `url` are in the budget too:
 * guarded keeps `vendorField` at 4 000, unguarded returns 3 822.
 */
const PROTO_PAYLOAD_CHARS = 4_000;
const VENDOR_FIELD_CHARS = 4_000;
const PROTO_RUN_REF_EXTRAS = JSON.parse(
  `{"__proto__":{"p":"${"P".repeat(PROTO_PAYLOAD_CHARS)}"},"vendorField":"${"V".repeat(VENDOR_FIELD_CHARS)}"}`
) as Record<string, unknown>;

/** The same hazard NESTED, one level below the root of `observed_state`. */
const PROTO_ROLLOUT = JSON.parse(
  '{"phase":"Progressing","__proto__":{"polluted":"from-rollout"},"weight":60}'
) as Record<string, unknown>;

describe("`__proto__` from a plugin reaches a real row and is refused there", () => {
  let server: ListeningTestServer;
  let orgId: string;
  let admin: ScpClient;
  const refTargetId = uuidv7();
  const rolloutTargetId = uuidv7();

  beforeAll(async () => {
    // NON-VACUITY BEFORE THE SERVER BOOTS. If `__proto__` ever stopped being an OWN key of these
    // fixtures, every arm below would pass for the wrong reason — there would be nothing to refuse.
    expect(Object.getOwnPropertyNames(PROTO_RUN_REF_EXTRAS)).toContain("__proto__");
    expect(Object.getOwnPropertyNames(PROTO_ROLLOUT)).toContain("__proto__");
    // …and they are own DATA properties on ordinary objects, not a prototype that got set.
    expect(Object.getPrototypeOf(PROTO_RUN_REF_EXTRAS)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(PROTO_ROLLOUT)).toBe(Object.prototype);
    // …and `JSON.stringify` really does put the key on the wire to the subprocess, which is the
    // hop that makes this an end-to-end test rather than a unit test with extra steps.
    expect(JSON.stringify(PROTO_RUN_REF_EXTRAS)).toContain('"__proto__"');
    expect(JSON.stringify(PROTO_ROLLOUT)).toContain('"__proto__"');

    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      fakeExecutorConfig: {
        runRefExtrasByTarget: { [refTargetId]: PROTO_RUN_REF_EXTRAS },
        // Held non-terminal so reconcile keeps writing `observing` readings for the rollout arm.
        forcePhase: { [rolloutTargetId]: "running" },
        rolloutByTarget: { [rolloutTargetId]: PROTO_ROLLOUT }
      }
    });

    const org = await createTestOrg(server, "proto-pollution");
    orgId = org.orgId;
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function rowOnceWritten(
    forTargetId: string,
    ready: (row: typeof changeWaveTargets.$inferSelect) => boolean,
    describeWhat: string
  ) {
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
        return rows.find(ready);
      },
      { describe: describeWhat, timeoutMs: 30_000 }
    );
  }

  /** Every check that makes "the row is not a pollution gadget" a fact rather than a hope. Applied
   *  identically to both columns, because the guard is spelled twice and one spelling could rot. */
  function assertNotAGadget(stored: unknown, where: string): void {
    expect(typeof stored, `${where}: not an object`).toBe("object");
    const obj = stored as Record<string, unknown>;
    // (i) THE PROTOTYPE IS OURS. This is the assertion the defect failed: the plugin's object had
    // become the stored object's prototype.
    expect(Object.getPrototypeOf(obj), `${where}: prototype is not Object.prototype`).toBe(
      Object.prototype
    );
    // (ii) THE KEY IS NOT AN OWN PROPERTY — refused, not stored honestly. Own-property enumeration
    // rather than `in`, because `in` walks the prototype chain and would be true for every object.
    expect(
      Object.getOwnPropertyNames(obj),
      `${where}: __proto__ was stored as an own key`
    ).not.toContain("__proto__");
    // (iii) NOTHING THE PLUGIN NESTED UNDER IT IS READABLE THROUGH THE ROW — the payload, not just
    // the key name. A guard that dropped the key but kept the effect would pass (i) and (ii).
    expect(obj.polluted, `${where}: the plugin's payload is readable off the row`).toBeUndefined();
    // (iv) AND IT DID NOT ESCAPE INTO THE SERIALISED FORM either — the bytes a consumer receives.
    expect(JSON.stringify(obj), `${where}: __proto__ survived into the wire form`).not.toContain(
      "__proto__"
    );
  }

  it("ROOT: `executor_ref` — a plugin's `__proto__` never becomes the row's prototype", async () => {
    const component = await createTestComponent(admin, {
      id: refTargetId,
      name: "proto-executor-ref"
    });
    expect(component.id).toBe(refTargetId);
    await admin.changes.propose({ name: "proto-executor-ref", targets: [refTargetId] });

    const row = await rowOnceWritten(
      refTargetId,
      (r) => r.executorRef !== null,
      "an executor_ref carrying the plugin's run ref"
    );
    const stored = row.executorRef as Record<string, unknown>;
    // NON-VACUITY ON THE ROW: the run ref really did make the trip, so this is a test of a refused
    // key and not of a write that never happened.
    expect(stored.externalId, "the run ref lost the handle the plugin is polled with").toBeTruthy();

    // THE DISCRIMINATING ASSERTION, and the only one on this column that is (see the header).
    // A refused key must cost its siblings NOTHING. Against the unguarded build `__proto__` is
    // charged and then silently dropped, and `vendorField` comes back at 3 822 instead of 4 000 —
    // a plugin paying for a field the row never received, out of the field it did.
    expect(
      String(stored.vendorField ?? "").length,
      "a refused key was charged to the budget and its sibling paid for it"
    ).toBe(VENDOR_FIELD_CHARS);

    // The prototype/own-key/payload checks below are pinned because they are the PROPERTY, even
    // though the row round trip means they cannot fail on their own — a future change that made
    // `executor_ref` reachable without a `JSON.stringify` in between would need them already here.
    assertNotAGadget(stored, "executor_ref");

    // AND THE GLOBAL PROTOTYPE IS UNTOUCHED — the blast radius, not just this row. A `[[Set]]` of
    // `__proto__` on one object cannot reach `Object.prototype`, but a future "fix" that assigned
    // the key somewhere else could, and this is the cheapest place to notice.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("NESTED: `observed_state.rollout` — the guard holds below the root, and SAYS SO", async () => {
    const component = await createTestComponent(admin, {
      id: rolloutTargetId,
      name: "proto-rollout"
    });
    expect(component.id).toBe(rolloutTargetId);
    await admin.changes.propose({ name: "proto-rollout", targets: [rolloutTargetId] });

    const row = await rowOnceWritten(
      rolloutTargetId,
      (r) => (r.observedState as { rollout?: unknown } | null)?.rollout !== undefined,
      "an observed_state carrying the plugin's rollout"
    );
    const observed = row.observedState as {
      rollout?: Record<string, unknown>;
      truncation?: Record<string, { dropped: boolean; droppedFields?: number }>;
    };
    const rollout = observed.rollout!;
    // NON-VACUITY: the rollout's ordinary fields survived, so the refusal below is about the one
    // key and not about a rollout that never arrived.
    expect(rollout.phase, "the rollout's ordinary fields never reached the row").toBe(
      "Progressing"
    );
    expect(rollout.weight).toBe(60);

    assertNotAGadget(rollout, "observed_state.rollout");
    // The enclosing object is not a gadget either — the guard is per-object, and the root is a
    // different `walkObjectFields` call from the one that refused the key.
    expect(Object.getPrototypeOf(observed)).toBe(Object.prototype);

    // AND THE LOSS IS REPORTED, rolled up into the ROOT FIELD that contains it — M23.1g's property,
    // on the one column an operator reads. Without this, a refused key is a silent removal, which
    // is the exact defect M23.1g exists to end.
    expect(
      observed.truncation?.rollout,
      "a refused key inside `rollout` was removed in silence"
    ).toMatchObject({ droppedFields: 1 });
  });

  it("THE DELIBERATE ASYMMETRY: `executor_ref` carries no truncation report, by decision", async () => {
    // `wave-targets-repo.ts` discards the report for this column on purpose — its reader is the
    // PLUGIN, not an operator. Pinned so the decision has to be re-made rather than drifted into:
    // if a future round starts reporting here, this arm reddens and the record gets updated.
    const row = await rowOnceWritten(
      refTargetId,
      (r) => r.executorRef !== null,
      "the executor_ref row again"
    );
    expect(Object.getOwnPropertyNames(row.executorRef as object)).not.toContain("truncation");
  });
});

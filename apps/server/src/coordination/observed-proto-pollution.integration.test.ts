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

/** M23.0 verification pass 15. See docs/coordination.md §572. */

/** A root-level `__proto__`, as a serialiser would emit it. See docs/coordination.md §573. */
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

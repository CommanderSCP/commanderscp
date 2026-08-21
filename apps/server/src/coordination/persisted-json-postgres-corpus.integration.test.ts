import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADVERSARIAL_ALL } from "@scp/runner-launcher";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changePlans, changeWaveTargets, changeWaves } from "../db/schema.js";
import { markWaveTargetTriggered, updateWaveTargetObserved } from "./wave-targets-repo.js";

/**
 * ==================================================================================================
 * M23.1f CLAUSE 4 — ZERO ROWS REFUSED BY A **REAL** POSTGRES, WITH THE PRE-BOUND SHAPE AS THE CONTROL
 * ==================================================================================================
 *
 * WHAT WAS MISSING, EXACTLY. The hostile corpus (`adversarial-corpus.ts`) was asserted only against
 * PROXIES: `isWellFormed()`, "contains no NUL", "renders under 8,000 characters". Every one of those
 * is a belief about what PostgreSQL will accept, held in a pure unit test with no database anywhere
 * near it — and M23.1f's own first finding is that one of those beliefs was FALSE:
 * `String.prototype.isWellFormed()` returns **true** for a NUL-carrying string that `jsonb` refuses.
 * A proxy that has already been wrong once is not evidence about the real thing.
 *
 * AND THE NON-VACUITY CONTROL COULD NOT BE WRITTEN AT ALL WITHOUT A SERVER. "Zero refused" is what a
 * corpus of empty strings produces too. The only control that means anything is "the SAME shapes,
 * NOT bounded, ARE refused" — a question with no answer outside a real PostgreSQL. Measured here on
 * PostgreSQL 16 via Testcontainers: **0 refusals after the bound; 11 refusals before it**, split
 * between `unsupported Unicode escape sequence` (the NUL class) and `invalid input syntax for type
 * json` (the lone-surrogate class).
 *
 * WHY IT DRIVES THE REPOSITORY AND NOT A HAND-BUILT TABLE. `updateWaveTargetObserved` and
 * `markWaveTargetTriggered` inside `withTenantTx` are the production write path for all three
 * plugin-supplied `jsonb` columns — `observed_state`, `executor_ref`, `prior_state_ref`. A probe
 * against a table of the same column types would prove `jsonb` accepts the bytes and prove nothing
 * about whether these functions hand it those bytes.
 *
 * WHAT IT IS NOT. It is not an end-to-end test: no plugin, no subprocess host, no reconcile tick.
 * `executor-ref-prior-state-bound.integration.test.ts` is that, for TWO hostile shapes; this file is
 * the whole corpus at the repository boundary, which is the layer where the refusal happens.
 */

let server: ListeningTestServer;
let orgId: string;
let targetId: string;

beforeAll(async () => {
  server = await listenTestServer();
  const org = await createTestOrg(server);
  orgId = org.orgId;
  targetId = uuidv7();
  // THE MINIMUM ROW CHAIN, AND THE DATABASE IS WHAT ESTABLISHED IT. A first draft inserted a wave
  // target with a fabricated `wave_id`, on the belief that these columns carry no foreign key; the
  // insert failed with `change_wave_targets_wave_id_fkey`, which is the census being corrected by
  // the only instrument that can settle it. `target_object_id` genuinely has none (index only), so
  // it stays synthetic — this file is about the three jsonb COLUMNS and a real placement behind the
  // row would change nothing about what `jsonb` accepts.
  const planId = uuidv7();
  const waveId = uuidv7();
  await withTenantTx(server.deps.db, orgId, async (tx) => {
    await tx
      .insert(changePlans)
      .values({ id: planId, orgId, changeObjectId: uuidv7(), status: "compiled" });
    await tx.insert(changeWaves).values({ id: waveId, orgId, planId, waveIndex: 0 });
    await tx.insert(changeWaveTargets).values({
      id: targetId,
      orgId,
      waveId,
      targetObjectId: uuidv7(),
      status: "pending"
    });
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

/**
 * The message at the BOTTOM of the cause chain. drizzle wraps a driver rejection in its own
 * `Failed query: …`, so `String(err)` is the SQL text and says nothing at all about why PostgreSQL
 * refused — which would make an assertion about the refusal CLASS an assertion about drizzle's
 * wrapper wording instead.
 */
function rootCause(err: unknown): string {
  let cursor = err;
  while (cursor instanceof Error && cursor.cause !== undefined) cursor = cursor.cause;
  return String(cursor).split("\n")[0]!.slice(0, 200);
}

/** Reads the row back, so nothing here can pass by having written nothing. */
async function readRow(): Promise<{
  observedState: unknown;
  executorRef: unknown;
  priorStateRef: unknown;
}> {
  return withTenantTx(server.deps.db, orgId, async (tx) => {
    const rows = await tx
      .select({
        observedState: changeWaveTargets.observedState,
        executorRef: changeWaveTargets.executorRef,
        priorStateRef: changeWaveTargets.priorStateRef
      })
      .from(changeWaveTargets)
      .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)))
      .limit(1);
    return rows[0]!;
  });
}

describe("M23.1f clause 4: the whole hostile corpus, through the repository, into a real Postgres", () => {
  it(`BOUNDED: not one of the ${ADVERSARIAL_ALL.length} shapes is refused, in any of the three columns`, async () => {
    const refused: string[] = [];
    let written = 0;
    let unserialisable = 0;

    for (const { name, value } of ADVERSARIAL_ALL) {
      // COLUMN 1 — `observed_state`, via the observe write path. The shape is wrapped so the value
      // sits where a plugin's own payload sits rather than replacing the whole column, which is the
      // position the bound's per-field seats are about.
      try {
        await withTenantTx(server.deps.db, orgId, async (tx) => {
          await updateWaveTargetObserved(tx, orgId, targetId, "observing", {
            revision: `r-${name}`,
            images: [`ghcr.io/x/y:1`],
            rollout: { phase: "Progressing", weight: 60 },
            ...(value === undefined ? {} : { hostile: value })
          } as never);
        });
      } catch (err) {
        refused.push(`observed_state / ${name}: ${String(err).slice(0, 200)}`);
      }

      // COLUMNS 2 and 3 — `executor_ref` and `prior_state_ref`, via the trigger write path. Its
      // UPDATE is guarded on `status = 'triggering'`, so the guard is satisfied first: without that
      // the statement matches zero rows and PostgreSQL never sees the value at all, which is a
      // vacuous pass wearing a real database's clothes.
      try {
        const applied = await withTenantTx(server.deps.db, orgId, async (tx) => {
          await tx
            .update(changeWaveTargets)
            .set({ status: "triggering" })
            .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));
          return markWaveTargetTriggered(tx, orgId, targetId, {
            executorPluginId: "scp-fake-executor",
            executorRef: { externalId: `run-${written}`, hostile: value } as never,
            priorStateRef: value === undefined ? null : (value as never)
          });
        });
        if (!applied) {
          refused.push(`executor_ref / ${name}: the guarded UPDATE matched no row (vacuous)`);
        } else {
          written += 1;
        }
      } catch (err) {
        refused.push(`executor_ref+prior_state_ref / ${name}: ${String(err).slice(0, 200)}`);
      }
      if (value === undefined) unserialisable += 1;
    }

    expect(refused.slice(0, 10), "a bounded shape was refused by a real PostgreSQL").toStrictEqual(
      []
    );
    // NON-VACUITY: the loop really wrote, and the last write really landed.
    expect(written).toBe(ADVERSARIAL_ALL.length);
    const row = await readRow();
    expect(row.executorRef).not.toBeNull();
    expect(row.observedState).not.toBeNull();
    // One shape in the corpus is `undefined`, which has nothing to serialise. Named, so a corpus
    // that quietly became all-undefined would not read as a clean sweep.
    expect(unserialisable).toBe(1);
  }, 300_000);

  it("THE CONTROL: the SAME shapes, NOT bounded, ARE refused — and by more than one refusal", async () => {
    /**
     * Without this arm the test above is satisfied by a corpus of empty strings. The values go into
     * the same column of the same row through the same driver, with only the bound removed; drizzle
     * serialises them to `jsonb` exactly as the repository does.
     *
     * Each refusal is its own transaction, because a failed statement poisons the transaction it is
     * in — a single tx would report one refusal and then `current transaction is aborted` for every
     * shape after it, which counts the FIRST failure N times and is a different measurement.
     */
    const refusals: string[] = [];
    for (const { name, value } of ADVERSARIAL_ALL) {
      if (value === undefined) continue;
      try {
        await withTenantTx(server.deps.db, orgId, async (tx) => {
          await tx
            .update(changeWaveTargets)
            .set({ observedState: value as never })
            .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));
        });
      } catch (err) {
        refusals.push(`${name}: ${rootCause(err)}`);
      }
    }
    expect(
      refusals.length,
      "NOT ONE pre-bound shape was refused, so 'the bound makes them storable' is a claim about nothing. Either the corpus stopped being hostile or this is not a real PostgreSQL."
    ).toBeGreaterThanOrEqual(3);
    /**
     * AND THE REFUSALS ARE NAMED, not merely counted, because a count drifts silently: eleven
     * refusals for eleven SIZE reasons would satisfy a count while proving nothing about the
     * encoding class this bound exists for. Measured on PostgreSQL 16 through this write path —
     * **11 of the 34 pre-bound shapes refuse**, by three distinct mechanisms:
     *
     *   `unsupported Unicode escape sequence \u0000` — the byte `jsonb` refuses outright, and the
     *     one `String.prototype.isWellFormed()` says YES to. Seven shapes reach it: `NUL bytes`,
     *     `the whole C0 range`, `NUL as an OBJECT KEY`, `NUL inside an astral pair`,
     *     `every BMP code unit`, `a NUL-only string` — and note that a NUL in a KEY refuses exactly
     *     as a NUL in a value does, which no proxy in the unit layer was asking about.
     *   `invalid input syntax for type json` — an unpaired surrogate the driver cannot encode as
     *     valid UTF-8: `lone surrogates`, `adjacent unpaired surrogates`,
     *     `U+FFFD beside a raw high surrogate`.
     *   a `TypeError` before a byte leaves Node: `a self-referential object` (a cycle) and
     *     `a bigint` (`JSON.stringify` throws on it).
     *
     * The set is pinned EXACTLY. A shape leaving it means the corpus stopped being hostile in a way
     * a count would not show; a shape joining it means the bound stopped covering something.
     */
    const refusedNames = new Set(refusals.map((r) => r.slice(0, r.indexOf(":"))));
    expect([...refusedNames].sort()).toStrictEqual(
      [
        "NUL as an OBJECT KEY",
        "NUL bytes",
        "NUL inside an astral pair",
        "U+FFFD beside a raw high surrogate",
        "a NUL-only string",
        "a bigint",
        "a self-referential object",
        "adjacent unpaired surrogates",
        "every BMP code unit",
        "lone surrogates",
        "the whole C0 range"
      ].sort()
    );
    const joined = refusals.join(" | ");
    expect(
      /unsupported Unicode escape sequence/i.test(joined),
      `no pre-bound shape produced the NUL refusal this bound exists for: ${joined.slice(0, 500)}`
    ).toBe(true);
    expect(
      /invalid input syntax for type json/i.test(joined),
      `no pre-bound shape produced the lone-surrogate refusal: ${joined.slice(0, 500)}`
    ).toBe(true);
  }, 300_000);

  it("…and the bound is what makes the difference: the SAME value, bounded, goes in", async () => {
    // The pair, on one shape, so the difference is attributable to the bound and not to two
    // different code paths. `NUL bytes` is the shape whose proxy (`isWellFormed`) said yes and
    // whose real answer was no — the finding this whole clause exists because of.
    const nul = ADVERSARIAL_ALL.find((c) => c.name === "NUL bytes")!;
    let rawRefused = false;
    try {
      await withTenantTx(server.deps.db, orgId, async (tx) => {
        await tx
          .update(changeWaveTargets)
          .set({ observedState: nul.value as never })
          .where(and(eq(changeWaveTargets.orgId, orgId), eq(changeWaveTargets.id, targetId)));
      });
    } catch {
      rawRefused = true;
    }
    expect(
      rawRefused,
      "a raw NUL-carrying value was ACCEPTED — this is not the encoding this bound was built against"
    ).toBe(true);

    await withTenantTx(server.deps.db, orgId, async (tx) => {
      await updateWaveTargetObserved(tx, orgId, targetId, "observing", nul.value as never);
    });
    const row = await readRow();
    expect(JSON.stringify(row.observedState)).not.toContain("\\u0000");
    expect(row.observedState).not.toBeNull();
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { testDatabaseUrl } from "../test-support/harness.js";
import { LEGAL_TRANSITIONS } from "./transitions.js";

/** THE DRIFT TRIPWIRE. See docs/coordination.md §1011. */
describe("state_transitions seed mirrors LEGAL_TRANSITIONS exactly (M12 P4B drift tripwire)", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  });

  afterAll(async () => {
    await pool.end();
  });

  const edgeKey = (e: { from: string; to: string; trigger: string }): string =>
    `${e.from} -> ${e.to} [${e.trigger}]`;

  it("the DB seed rows EXACTLY equal transitions.ts's LEGAL_TRANSITIONS (both directions, triggers included)", async () => {
    const result = await pool.query<{ from_state: string; to_state: string; trigger: string }>(
      "SELECT from_state, to_state, trigger FROM state_transitions"
    );
    const dbEdges = result.rows.map((r) =>
      edgeKey({ from: r.from_state, to: r.to_state, trigger: r.trigger })
    );
    const codeEdges = LEGAL_TRANSITIONS.map(edgeKey);

    // (from, to) is unique in both (the DB enforces it via state_transitions_pk; assert it for the
    // constant too so a duplicated edge can't hide inside set comparison).
    expect(new Set(dbEdges).size).toBe(dbEdges.length);
    expect(new Set(codeEdges).size).toBe(codeEdges.length);

    // Sorted-array equality == set equality both directions, and on failure vitest prints the
    // exact missing/extra edge — the actionable message ("add a migration" / "remove a stale row").
    expect([...dbEdges].sort()).toEqual([...codeEdges].sort());
  });

  it("the three M12 P4B `waiting` edges are seeded (0032 applied)", async () => {
    const result = await pool.query<{ from_state: string; to_state: string; trigger: string }>(
      "SELECT from_state, to_state, trigger FROM state_transitions WHERE from_state = 'waiting' OR to_state = 'waiting' ORDER BY from_state, to_state"
    );
    expect(result.rows).toEqual([
      { from_state: "coordinated", to_state: "waiting", trigger: "await-prerequisites" },
      { from_state: "waiting", to_state: "cancelled", trigger: "cancel" },
      { from_state: "waiting", to_state: "executing", trigger: "prerequisites-satisfied" }
    ]);
  });
});

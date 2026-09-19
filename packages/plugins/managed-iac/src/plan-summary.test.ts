import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizePlanFile, summarizePlanJson } from "./plan-summary.js";

/** Unit tests for the plan-summary extraction (pipeline-mockup-data.md §6). See
 *  docs/plugins.md — the structured `tofu show -json` reader, never a stdout scrape. */

function planJson(resourceChanges: Array<{ actions: string[] }>): string {
  return JSON.stringify({
    resource_changes: resourceChanges.map((rc) => ({ change: { actions: rc.actions } }))
  });
}

describe("summarizePlanJson: honesty — absent, never zeroed", () => {
  it("malformed JSON -> absent", () => {
    expect(summarizePlanJson("{ not json")).toBeUndefined();
  });

  it("valid JSON with no resource_changes array -> absent (e.g. a rollback's state-format evidence)", () => {
    // `tofu show -json <state file>` shape: no `resource_changes` key at all.
    expect(
      summarizePlanJson(JSON.stringify({ format_version: "1.2", values: {} }))
    ).toBeUndefined();
  });

  it("resource_changes present but not an array -> absent", () => {
    expect(summarizePlanJson(JSON.stringify({ resource_changes: "nope" }))).toBeUndefined();
  });

  it("top-level JSON is not an object -> absent", () => {
    expect(summarizePlanJson("42")).toBeUndefined();
    expect(summarizePlanJson("null")).toBeUndefined();
  });

  it("a genuinely empty resource_changes array is a REAL zero-change plan, not absence", () => {
    const summary = summarizePlanJson(planJson([]));
    expect(summary).toEqual({ ref: expect.any(String), add: 0, change: 0, destroy: 0 });
  });

  it("an entry with a malformed 'change' or 'actions' shape is skipped, not fatal to the whole parse", () => {
    const raw = JSON.stringify({
      resource_changes: [
        { change: { actions: ["create"] } },
        { change: "not-an-object" },
        { notChange: true },
        { change: { actions: "not-an-array" } }
      ]
    });
    expect(summarizePlanJson(raw)).toMatchObject({ add: 1, change: 0, destroy: 0 });
  });
});

describe("summarizePlanJson: counts", () => {
  it("a plain add/change/destroy mix", () => {
    const summary = summarizePlanJson(
      planJson([
        { actions: ["create"] },
        { actions: ["create"] },
        { actions: ["update"] },
        { actions: ["delete"] },
        { actions: ["no-op"] },
        { actions: ["read"] }
      ])
    );
    expect(summary).toMatchObject({ add: 2, change: 1, destroy: 1 });
  });

  it("a destroy-heavy plan (multiple deletes, zero creates/changes)", () => {
    const summary = summarizePlanJson(
      planJson([{ actions: ["delete"] }, { actions: ["delete"] }, { actions: ["delete"] }])
    );
    expect(summary).toMatchObject({ add: 0, change: 0, destroy: 3 });
  });

  it("a replace (actions carrying BOTH create and delete) counts as ONE add AND ONE destroy, never a change — matching tofu's own summary line convention", () => {
    const summary = summarizePlanJson(planJson([{ actions: ["delete", "create"] }]));
    expect(summary).toMatchObject({ add: 1, change: 0, destroy: 1 });
  });

  it("ref is a stable sha256 hex digest of the exact bytes parsed, so a re-read of unchanged evidence reports the SAME ref", () => {
    const raw = planJson([{ actions: ["create"] }]);
    const first = summarizePlanJson(raw);
    const second = summarizePlanJson(raw);
    expect(first?.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.ref).toBe(second?.ref);
    const differentRaw = planJson([{ actions: ["delete"] }]);
    expect(summarizePlanJson(differentRaw)?.ref).not.toBe(first?.ref);
  });
});

describe("summarizePlanFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "managed-iac-plan-summary-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("missing plan.json -> absent, never throws", async () => {
    await expect(summarizePlanFile(dir)).resolves.toBeUndefined();
  });

  it("reads and parses a real plan.json off disk", async () => {
    await writeFile(join(dir, "plan.json"), planJson([{ actions: ["create"] }]), "utf8");
    await expect(summarizePlanFile(dir)).resolves.toMatchObject({ add: 1, change: 0, destroy: 0 });
  });
});

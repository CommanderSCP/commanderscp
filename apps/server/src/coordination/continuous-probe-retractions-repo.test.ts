import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { probeScheduleId } from "./continuous-probe-retractions-repo.js";

/** The schedule id joins two callers that never meet. See docs/coordination.md §338. */
describe("probeScheduleId", () => {
  const component = "01a05810-2983-71ef-9328-8d0c044f0a48";

  it("is a pure function of (component, hookId) — same inputs, same id, every time", () => {
    expect(probeScheduleId(component, "canary")).toBe(probeScheduleId(component, "canary"));
  });

  it("separates two hooks of one component, and one hook across two components", () => {
    // Without both halves a retraction of one probe would remove another one's schedule.
    expect(probeScheduleId(component, "canary")).not.toBe(probeScheduleId(component, "smoke"));
    expect(probeScheduleId(component, "canary")).not.toBe(
      probeScheduleId("01a05810-2b41-72dc-9fc6-be7d522af494", "canary")
    );
  });

  it("separates components MINTED IN THE SAME BURST — the collision the old derivation had", () => {
    // The case that found it, and it is the ordinary shape. See docs/coordination.md §339.
    const ids = Array.from({ length: 200 }, () => uuidv7());
    expect(new Set(ids.map((id) => id.slice(0, 8))).size, "control: prefixes DO collide").toBe(1);
    expect(new Set(ids.map((id) => probeScheduleId(id, "canary"))).size).toBe(ids.length);
  });

  it("emits a DNS-ish name whatever the operator called the hook", () => {
    // The hook id is operator vocabulary and reaches an executor resource name unmodified otherwise.
    const id = probeScheduleId(component, "Canary Probe/EU_1!");
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id.startsWith("scp-probe-")).toBe(true);
  });

  it("fits a DNS label whatever the hook is called, and stays distinct when truncation bites", () => {
    // A 300-character hook id must not produce a 300-character resource name. Truncation is on the
    // READABLE segment alone — the discriminator is the hash, so two hook ids that differ only past
    // the cut still get different schedules.
    const long = probeScheduleId(component, "p".repeat(300));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).not.toBe(probeScheduleId(component, `${"p".repeat(300)}-smoke`));
    // A hook id with nothing DNS-safe in it degrades to the hash rather than to a leading dash.
    expect(probeScheduleId(component, "!!!")).toMatch(/^scp-probe-[a-f0-9]{12}$/);
  });
});

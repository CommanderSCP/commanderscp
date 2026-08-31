import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { probeScheduleId } from "./continuous-probe-retractions-repo.js";

/**
 * `probeScheduleId` IS THE JOIN BETWEEN TWO CALLERS THAT NEVER MEET. The driver derives it to
 * DECLARE a schedule; `deleteHook` derives it to record a RETRACTION for one, in a different
 * transaction, possibly on a different replica, possibly weeks apart. If the two ever disagree the
 * retraction names an id the executor never heard of and the orphaned cron keeps firing — silently,
 * which is exactly the failure migration 0111 exists to end.
 *
 * So the properties below are about the derivation itself, at the unit layer, rather than about
 * either caller: the integration case (`pipeline-hook-admission.integration.test.ts` property 5d)
 * proves the two agree TODAY, and these prove why they will keep agreeing.
 */
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
    // THE CASE THAT FOUND IT, and it is the ordinary shape rather than a corner: an IaC apply
    // creates a whole stack's components in one transaction, and the previous derivation used
    // `componentObjectId.slice(0, 8)`. Object ids are uuidv7, whose first 12 hex characters are the
    // 48-bit millisecond clock — so the first 8 are its top 32 bits and hold steady for ~65 seconds.
    // Every component in one apply shared them, and two `canary` probes became one schedule.
    //
    // Real ids from `uuid`'s own v7, not hand-written strings: the property is about what the
    // generator produces, and a fixture that invented two conveniently-different uuids would pass
    // against the broken derivation.
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

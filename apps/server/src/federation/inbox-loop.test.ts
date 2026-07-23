import { afterEach, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import { INBOX_QUEUE, inboxLoopEnabled, startInboxLoop } from "./inbox-loop.js";

/**
 * M13.1a — the inbox loop's OPT-IN INERTNESS, asserted (not merely inspected). The loop is
 * DEFAULT-OFF: an instance whose operator never set `SCP_INBOX_LOOP=1` must NEVER create the
 * queue, register a worker, or schedule a tick — the returned handle is inert and `stop()` is a
 * no-op. (The full ingest behaviour is proven in inbox-loop.integration.test.ts against real
 * Postgres; this unit pins the enable gate so an unconfigured instance provably does not spin.)
 */
describe("M13.1a inbox loop opt-in inertness (unit)", () => {
  const savedEnv = process.env.SCP_INBOX_LOOP;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SCP_INBOX_LOOP;
    else process.env.SCP_INBOX_LOOP = savedEnv;
  });

  function fakeBoss() {
    return {
      createQueue: vi.fn(async () => {}),
      work: vi.fn(async () => "worker-id"),
      send: vi.fn(async () => "job-id")
    } as unknown as PgBoss;
  }

  it("inboxLoopEnabled is true ONLY for SCP_INBOX_LOOP=1 (default off)", () => {
    expect(inboxLoopEnabled({})).toBe(false);
    expect(inboxLoopEnabled({ SCP_INBOX_LOOP: "0" })).toBe(false);
    expect(inboxLoopEnabled({ SCP_INBOX_LOOP: "true" })).toBe(false);
    expect(inboxLoopEnabled({ SCP_INBOX_LOOP: "" })).toBe(false);
    expect(inboxLoopEnabled({ SCP_INBOX_LOOP: "1" })).toBe(true);
  });

  it("an UNCONFIGURED instance (no SCP_INBOX_LOOP) NEVER creates the queue, registers a worker, or schedules a tick — the handle is inert and stop() is a no-op", async () => {
    delete process.env.SCP_INBOX_LOOP;
    const boss = fakeBoss();
    const handle = await startInboxLoop(boss, {} as Db, Buffer.alloc(32, 0));

    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();

    // The inert handle's stop() resolves without touching the boss (no in-flight tick to await).
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("with SCP_INBOX_LOOP=1 the loop DOES arm (queue created + worker registered + first tick sent) — proving the guard gates a working loop, not a broken one", async () => {
    process.env.SCP_INBOX_LOOP = "1";
    const boss = fakeBoss();
    const handle = await startInboxLoop(boss, {} as Db, Buffer.alloc(32, 0));

    expect(boss.createQueue).toHaveBeenCalledWith(INBOX_QUEUE);
    expect(boss.work).toHaveBeenCalledOnce();
    // The initial tick is enqueued (the worker handler itself is never invoked by this fake boss,
    // so no sweep runs — the db is never touched).
    expect(boss.send).toHaveBeenCalled();

    await handle.stop();
  });
});

import type PgBoss from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  DEPENDENCY_VERSION_POLL_QUEUE,
  dependencyVersionPollIntervalSeconds,
  dependencyVersionPollRoleGuard,
  norecordFor,
  startDependencyVersionPollLoop
} from "./version-poll.js";
import type { HeadRefusalReason } from "./line-head.js";
import { PGBOSS_ARCHIVE_SECONDS } from "../events/pgboss-limits.js";
import { assertPgBossWouldAccept, pgBossSendRejection } from "../test-support/pgboss-validation.js";

/** THE ROLE GUARD. See docs/dependencies.md §429. */

const ROLES = ["all", "api", "worker"] as const;
const FEDERATION_ROLES = ["commander", "outpost", "retrans"] as const;
/** Every guard input below states the DECLARED case explicitly; the undeclared axis has its own
 *  suite, because it is a third independent question and not a variant of the other two. */
const DECLARED = { federationRoleDeclared: true } as const;

describe("dependencyVersionPollRoleGuard", () => {
  it("NEGATIVE CONTROL — a commander running background work DOES poll", () => {
    for (const role of ["all", "worker"] as const) {
      const verdict = dependencyVersionPollRoleGuard({
        role,
        federationRole: "commander",
        ...DECLARED
      });
      expect(verdict.allowed).toBe(true);
    }
  });

  it("an OUTPOST never polls, on any process role", () => {
    for (const role of ROLES) {
      const verdict = dependencyVersionPollRoleGuard({
        role,
        federationRole: "outpost",
        ...DECLARED
      });
      expect(verdict.allowed, role).toBe(false);
      // The air-gap sentence is this capability's own reason. See docs/dependencies.md §430.
      if (role === "api") {
        expect(verdict.reason, role).toMatch(/SCP_ROLE/);
      } else {
        expect(verdict.reason, role).toMatch(/air-gapped/);
      }
    }
  });

  it("a RETRANS node never polls, on any process role", () => {
    for (const role of ROLES) {
      expect(
        dependencyVersionPollRoleGuard({ role, federationRole: "retrans", ...DECLARED }).allowed
      ).toBe(false);
    }
  });

  it("an api-only process never polls, on any federation role", () => {
    for (const federationRole of FEDERATION_ROLES) {
      const verdict = dependencyVersionPollRoleGuard({
        role: "api",
        federationRole,
        ...DECLARED
      });
      expect(verdict.allowed).toBe(false);
    }
  });

  it("the two axes are INDEPENDENT — exactly one combination out of nine is allowed per role", () => {
    const allowed = FEDERATION_ROLES.flatMap((federationRole) =>
      ROLES.map((role) => ({ role, federationRole, ...DECLARED }))
    ).filter((combo) => dependencyVersionPollRoleGuard(combo).allowed);
    expect(allowed).toEqual([
      { role: "all", federationRole: "commander", ...DECLARED },
      { role: "worker", federationRole: "commander", ...DECLARED }
    ]);
  });
});

/** The guard was fail-open, and that is a third axis. See docs/dependencies.md §431. */
describe("dependencyVersionPollRoleGuard — an UNDECLARED federation role (MINOR D)", () => {
  it("still refuses an explicitly-declared outpost (the pre-existing axis is untouched)", () => {
    expect(
      dependencyVersionPollRoleGuard({
        role: "worker",
        federationRole: "outpost",
        federationRoleDeclared: true
      }).allowed
    ).toBe(false);
  });

  it("REFUSES a defaulted commander — an undeclared deployment does not reach the internet", () => {
    for (const role of ["all", "worker"] as const) {
      const verdict = dependencyVersionPollRoleGuard({
        role,
        federationRole: "commander",
        federationRoleDeclared: false
      });
      expect(verdict.allowed).toBe(false);
      // The reason must name the REMEDY, not just the refusal: an operator who genuinely runs a
      // commander has to be able to turn this on from the log line alone.
      expect(verdict.reason).toMatch(/SCP_FEDERATION_ROLE/);
    }
  });

  it("NEGATIVE CONTROL — declaring `commander` explicitly turns it back on", () => {
    const verdict = dependencyVersionPollRoleGuard({
      role: "worker",
      federationRole: "commander",
      federationRoleDeclared: true
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe("dependencyVersionPollIntervalSeconds", () => {
  it("is daily by default", () => {
    expect(dependencyVersionPollIntervalSeconds({})).toBe(86_400);
  });

  it("floors at 5 minutes, so a misconfigured value cannot become a hot loop against a registry", () => {
    expect(
      dependencyVersionPollIntervalSeconds({ SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS: "1" })
    ).toBe(300);
    // NEGATIVE CONTROL: a legitimate override above the floor is honoured, so the floor is a floor
    // and not a hardcoded constant.
    expect(
      dependencyVersionPollIntervalSeconds({ SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS: "3600" })
    ).toBe(3600);
  });
});

describe("startDependencyVersionPollLoop", () => {
  function fakeBoss() {
    return {
      createQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => "worker-id"),
      send: vi.fn(async () => "job-id")
    };
  }
  const db = {} as Db;
  const host = {} as PluginHost;

  it("a refused role returns an inert handle and NEVER CREATES THE QUEUE", async () => {
    // Not merely "skips the work inside the handler": an outpost that created the queue would still
    // wake every day to decide to do nothing, and would still hold a pg-boss worker for it.
    const boss = fakeBoss();
    const handle = await startDependencyVersionPollLoop(boss as unknown as PgBoss, db, host, {
      role: "worker",
      federationRole: "outpost",
      federationRoleDeclared: true
    });
    await handle.stop();
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL — a commander worker creates the queue and seeds the first tick", async () => {
    const boss = fakeBoss();
    const handle = await startDependencyVersionPollLoop(boss as unknown as PgBoss, db, host, {
      role: "worker",
      federationRole: "commander",
      federationRoleDeclared: true
    });
    await handle.stop();
    expect(boss.createQueue).toHaveBeenCalledWith(DEPENDENCY_VERSION_POLL_QUEUE);
    expect(boss.work).toHaveBeenCalledTimes(1);
    // §4-A4/M26.1, CORRECTED TWICE. See docs/dependencies.md §432.
    expect(boss.send).toHaveBeenCalledWith(DEPENDENCY_VERSION_POLL_QUEUE, {});
  });
});

/** The explanation must name the rule that actually refused. See docs/dependencies.md §433. */
describe("norecordFor — the refusal's explanation follows the refusal", () => {
  /** Every reason the door can return, spelled out. A literal list, not `Object.keys` of anything:
   *  the point is that a NEW reason has to be added here by hand and then explained. */
  const OWNERSHIP: HeadRefusalReason[] = [
    "line_is_internal",
    "line_is_third_party",
    "line_transferred"
  ];
  const VERSION: HeadRefusalReason[] = [
    "behind_head",
    "different_major_line",
    "different_tag_variant",
    "major_line_not_comparable",
    "version_not_comparable"
  ];

  it("an OWNERSHIP refusal is NOT explained by the head-movement rule", () => {
    for (const reason of OWNERSHIP) {
      const text = norecordFor(reason);
      expect(text, reason).not.toMatch(/never moves backwards/);
      expect(text, reason).not.toMatch(/never leaves the line it names/);
      // …and it says what DID refuse: who may write, rather than what the version is.
      expect(text, reason).toMatch(/declared|own this line|does not own/);
    }
  });

  it("a VERSION refusal still IS — the negative control, without which the above is satisfied by silence", () => {
    expect(norecordFor("behind_head")).toMatch(/never moves backwards/);
    for (const reason of VERSION.filter((r) => r !== "behind_head")) {
      expect(norecordFor(reason), reason).toMatch(/never leaves the line it names/);
    }
  });

  it("`behind_head` and `different_major_line` do not share one sentence either", () => {
    // The two version rules are two different facts — "your answer is older than the head" and
    // "your answer is not on this line" — and merging them was the same collapse one step smaller.
    expect(norecordFor("behind_head")).not.toBe(norecordFor("different_major_line"));
  });

  it("every reason cites the rule it is applying", () => {
    // What this does not do, so it is not read as the gate. See docs/dependencies.md §434.
    for (const reason of [...OWNERSHIP, ...VERSION]) {
      expect(norecordFor(reason), reason).toMatch(/ADR-0032 §7/);
    }
  });
});

/** THE RESCHEDULE, EXECUTED. The suite above drives `startDependencyVersionPollLoop` but discards
 *  the handler `boss.work` is given, so the tick body — and the `boss.send` that files the next
 *  tick — never ran under test. That is why this loop shipped dead at its own default interval:
 *  every assertion about the cadence was about the GETTER's return value, and pg-boss's objection
 *  is to what the getter's value is then USED for. See docs/dependencies.md. */
describe("a version-poll tick files the next tick at the default (86400s) interval", () => {
  /** No orgs, so the sweep is a no-op and only the RESCHEDULE is under test. */
  const emptyDb = { select: () => ({ from: async () => [] }) } as unknown as Db;

  async function runOneTick(): Promise<{ queue: string; options?: unknown }[]> {
    const sends: { queue: string; options?: unknown }[] = [];
    let handler: (() => Promise<void>) | undefined;
    const boss = {
      createQueue: async () => undefined,
      work: async (_queue: string, h: () => Promise<void>) => {
        handler = h;
        return "worker-id";
      },
      send: async (queue: string, _data: unknown, options?: unknown) => {
        // The fake validates EXACTLY as the real client does. Without this the fake accepts the
        // very options pg-boss refuses, and every assertion below becomes a claim about the fake.
        await assertPgBossWouldAccept(options);
        sends.push({ queue, options });
        return "job-id";
      }
    } as unknown as PgBoss;

    const handle = await startDependencyVersionPollLoop(boss, emptyDb, {} as PluginHost, {
      role: "worker",
      federationRole: "commander",
      federationRoleDeclared: true
    });
    sends.length = 0; // drop the startup kick; the CHAIN is what is under test
    await handler!();
    await handle.stop();
    return sends;
  }

  it("the tick completes and files exactly one follow-up (before the clamp this REJECTED)", async () => {
    // The regression in one line: unclamped, `boss.send` threw ERR_ASSERTION here, the job was
    // marked failed, and nothing filed the next tick.
    const sends = await runOneTick();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.queue).toBe(DEPENDENCY_VERSION_POLL_QUEUE);
  });

  it("keeps the full 24h CADENCE — the clamp narrows the window, never the interval", async () => {
    const [tick] = await runOneTick();
    expect(dependencyVersionPollIntervalSeconds({})).toBe(86_400);
    expect(tick?.options).toMatchObject({ startAfter: 86_400, singletonKey: "tick" });
  });

  it("and the window it does file is one pg-boss will actually accept", async () => {
    const [tick] = await runOneTick();
    const options = tick?.options as { singletonSeconds?: number } | undefined;
    expect(options?.singletonSeconds).toBeLessThanOrEqual(PGBOSS_ARCHIVE_SECONDS);
    // Not a restatement of the rule — the options the loop really produced, handed to pg-boss's
    // own validator.
    expect(await pgBossSendRejection(tick?.options)).toBeUndefined();
  });
});

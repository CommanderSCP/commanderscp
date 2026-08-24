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

/**
 * THE ROLE GUARD (ADR-0032 §7, BUILD_AND_TEST.md M21.4).
 *
 * The hazard is specific and is not hypothetical: there is no trustworthy RUNTIME
 * commander/outpost predicate — `self_domain.role` is per-ORG, set lazily post-install through the
 * federation API, and advisory — so a background job with no explicit guard runs on AIR-GAPPED
 * OUTPOSTS too, dialling package registries that are unreachable by design and writing a Decision
 * per dependency about it, every day, forever.
 *
 * Both directions are pinned here. A test that only asserted the refusals would pass just as well
 * against a guard that refuses EVERYTHING, i.e. against a feature that never runs at all — so the
 * negative control (a commander worker DOES run it, and really creates the queue) is the half that
 * makes the rest mean something.
 */

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
      // The air-gap sentence is THIS capability's own reason for the FEDERATION axis, so it belongs
      // to the federation branch and only to it. On an `api` process the guard refuses on the
      // PROCESS axis first (M21.7 follow-up, LOW 5 — all three hand-written copies now test the
      // axes in one order, so a given misconfiguration sends an operator to ONE setting rather than
      // to whichever one the job that complained happened to check first); telling that operator
      // about air-gaps would be naming the wrong remedy.
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

/**
 * THE GUARD WAS FAIL-OPEN, AND THAT IS A THIRD AXIS, NOT A SHADE OF THE FIRST (M21.4 MINOR D).
 *
 * `config.federationRole` DEFAULTS to `commander` when `SCP_FEDERATION_ROLE` is unset (config.ts),
 * because that default is right for the question it was introduced to answer — "may this process
 * serve the SPA?" — where it preserves every pre-M16.3 deployment byte-for-byte. It is the WRONG
 * default for "may this process dial package registries on a daily timer?": an outpost installed
 * before that env var existed, or from a chart that omits it, is indistinguishable from a declared
 * commander. The deployments most likely to be air-gapped are exactly the ones most likely to be
 * undeclared, so the pre-fix guard let precisely the wrong population through — silently, since
 * "allowed" also logged nothing.
 *
 * These pin the safe default and its remedy. Note the FIRST test would pass against the old guard
 * too — it is the second one that is the fix, and the third is the negative control that stops the
 * fix from degenerating into "never poll".
 */
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
        // Exactly what `loadConfig` produces with SCP_FEDERATION_ROLE unset.
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
    // §4-A4/M26.1: the initial send now carries the SAME singletonKey/singletonSeconds as the
    // reschedule send, so N replicas restarting together don't N-fire the first tick.
    expect(boss.send).toHaveBeenCalledWith(
      DEPENDENCY_VERSION_POLL_QUEUE,
      {},
      {
        singletonKey: "tick",
        singletonSeconds: dependencyVersionPollIntervalSeconds()
      }
    );
  });
});

/**
 * THE DECISION'S PLAIN-ENGLISH EXPLANATION MUST NAME THE RULE THAT ACTUALLY REFUSED (principle 6).
 *
 * The defect this pins was one fixed sentence — "a head never moves backwards and never leaves the
 * line it names" — appended to EVERY `not_recorded` verdict. It is true of the version rules and it
 * is not the rule that fires for an OWNERSHIP refusal: `line_is_internal` says the coordinate has a
 * declared producer, which is not a statement about the version at all, and the index's answer may
 * have been perfectly ahead of the standing head. An operator reading that Decision goes looking for
 * a version-ordering problem on a line whose actual problem is a declaration — a Decision that
 * explains the wrong rule is worse than one that says nothing.
 *
 * MUTATION LOG — applied, watched fail, reverted, watched pass:
 * | Mutation | Result |
 * |---|---|
 * | restore the single fixed sentence for every reason (the pre-fix state) | TWO failures — the ownership case, and "`behind_head` and `different_major_line` do not share one sentence either". The second is the collapse one step smaller, and it falls out of the same mutation |
 * | give the ownership reasons the version wording and vice versa | TWO failures, one per grouped case: the mapping is pinned in BOTH directions, so "the strings merely differ" does not satisfy it |
 */
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
    // WHAT THIS DOES NOT DO, stated so nobody reads it as the exhaustiveness gate: the two lists
    // above are hand-maintained, so a NEW `HeadRefusalReason` is not covered here at all. What
    // covers it is the compiler — `norecordFor`'s switch has no `default:` arm and the package sets
    // `noImplicitReturns`, so an unexplained reason fails to build. That gate lives in the source,
    // not in this file, and adding a `default:` arm would silently remove it.
    for (const reason of [...OWNERSHIP, ...VERSION]) {
      expect(norecordFor(reason), reason).toMatch(/ADR-0032 §7/);
    }
  });
});

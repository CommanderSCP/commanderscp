import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";
import type { DependencyLine } from "@scp/schemas";
import { BACKGROUND_LOOPS } from "../background-work.js";
import type { DomainEventJob } from "../events/pgboss.js";
import {
  DOMAIN_EVENT_ROUTERS,
  domainEventRouters,
  type RouterGuardConfig
} from "../events/domain-event-registry.js";
import {
  advancedLineHeadRouter,
  bumpDispatchRoleGuard,
  isLineHeadAdvancedEvent,
  planBump,
  startBumpDispatchLoop,
  DEPENDENCY_BUMP_QUEUE
} from "./bump-dispatch.js";
import { DEPENDENCY_LINE_HEAD_ADVANCED_EVENT } from "./dependency-inventory-repo.js";

/**
 * M21.5 — the three pure decisions the bump dispatcher makes, pinned without a database.
 *
 * The WIRING is proven in `bump-dispatch.integration.test.ts`, through the router, the queue and the
 * loop; this file covers the parts that would otherwise only be exercised incidentally by it — the
 * role guard's two axes, the router's predicate, and the plan that decides what a bump would SAY.
 */

const npmLine = (
  overrides: Partial<Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion">>
): Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion"> => ({
  ecosystem: "npm",
  major: "1",
  tagPattern: null,
  latestVersion: "1.4.0",
  ...overrides
});

/**
 * ================================================================================================
 * THE CENSUS THAT `bump-dispatch.integration.test.ts` STRUCTURALLY CANNOT DO
 * ================================================================================================
 * That file registers the router and starts the loop ITSELF, because that is the only way to drive
 * them deterministically against a Testcontainers database. Which means it would keep passing if
 * the composition root never wired either one — the production process would start with no router on
 * `domain-events` and no worker on `dependency-bump`, and every subscribed component would receive
 * nothing, forever, with a green suite. That is the EXACT failure this milestone exists to close,
 * four times over, so it gets an assertion of its own rather than a reviewer's attention.
 *
 * BOTH HALVES ARE NOW ASSERTED BY RUNNING THEM, and neither is a substring any more.
 *
 * The ROUTER half moved first (M21.7): the router list lives in `events/domain-event-registry.ts`,
 * a pure importable value. The LOOP half followed (2026-08-17): the eleven loop startups moved out
 * of `main.ts` into `background-work.ts`'s `BACKGROUND_LOOPS`, for exactly the same reason and after
 * exactly the same measurement.
 *
 * WHAT THE SUBSTRING VERSION OF THIS BLOCK WAS WORTH, measured twice:
 *   - commenting out `const bumpDispatchLoop = await startBumpDispatchLoop(boss, {…})` left this
 *     describe block — INCLUDING the case named "starts the worker, and stops it on shutdown" —
 *     passing 20/20, and the whole apps/server unit suite green at 972/972 (M21.7, on RAW text);
 *   - flipping `main.ts`'s background-work condition to `false`, killing this loop and ten others,
 *     left it green again — this time even with comments stripped, because stripping cannot see a
 *     dead branch.
 *
 * So the claim below is now membership in a registry that `background-work.test.ts` STARTS, checked
 * by FUNCTION IDENTITY. `@scp/source-census`'s package doc lists what the text version could never
 * have proven; this file no longer relies on any of it.
 */
describe("the composition root actually wires it", () => {
  it("registers the router in the production registry, under THIS capability's guard", () => {
    // Identity, not name: the mis-binding this rules out is the registry pairing this router with
    // some OTHER capability's guard, and thereby authoring repository writes from an outpost. Until
    // ADR-0032 §7d (2026-08-17) that hazard was concrete — internal detection's guard allowed every
    // federation role, so binding to it would have been a live escape. Every dependency guard now
    // reaches the same verdict (`commander-only.test.ts` proves that across the full matrix), which
    // makes this assertion a defence against the NEXT divergence rather than a current one — and
    // that is exactly when an identity check is worth keeping rather than deleting.
    const entries = DOMAIN_EVENT_ROUTERS.filter(
      (entry) => entry.factory === advancedLineHeadRouter
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.guard).toBe(bumpDispatchRoleGuard);
  });

  it("registers it on a declared commander worker, and on NOTHING else", () => {
    const queuesFor = (config: RouterGuardConfig): string[] =>
      domainEventRouters(config).map((router) => router.queue);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    ).toContain(DEPENDENCY_BUMP_QUEUE);
    // The guard's two axes, observed at the REGISTRATION rather than on the guard in isolation:
    // an api process, an outpost, and a deployment that never declared its federation role must
    // none of them end up with this router on the shared event stream.
    expect(
      queuesFor({ role: "api", federationRole: "commander", federationRoleDeclared: true })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
  });

  it("is in the production loop registry — the thing that actually starts it", () => {
    // IDENTITY, not a name and not a substring: the registry holds the function object this test
    // imported. A local shadow, a wrapper, or a lookalike in another module is a different object
    // and fails here. `background-work.test.ts` then STARTS every registry entry against a probe
    // boss and asserts each one creates its own queue — so "registered" is not a paper claim.
    const entries = BACKGROUND_LOOPS.filter((entry) => entry.loop === startBumpDispatchLoop);
    expect(entries).toHaveLength(1);
  });

  it("actually starts and creates ITS OWN queue when the registry runs it", async () => {
    // The behavioural half, driven through the REAL registry entry rather than by calling the
    // starter directly — which is the difference between "this loop works" and "this loop is wired".
    const created: string[] = [];
    const boss = {
      createQueue: async (queue: string) => void created.push(queue),
      work: async () => "worker-id",
      send: async () => "job-id",
      schedule: async () => undefined
    } as unknown as PgBoss;

    const entry = BACKGROUND_LOOPS.find((candidate) => candidate.loop === startBumpDispatchLoop)!;
    const handle = await entry.start({
      boss,
      db: undefined as never,
      host: undefined as never,
      sandbox: undefined as never,
      config: {
        role: "worker",
        federationRole: "commander",
        federationRoleDeclared: true,
        secretsMasterKey: Buffer.alloc(32)
      } as never
    });
    await handle.stop();

    expect(created).toContain(DEPENDENCY_BUMP_QUEUE);
  });

  it("never takes a competing consumer on the shared domain-event stream", async () => {
    // `boss.work` on `domain-events` does not deduplicate — a second worker there STEALS M21.4's
    // events and receives roughly half of its own. An ABSENCE assertion, so it deliberately reads
    // the files RAW: a comment marker only makes a violation harder to hide, and stripping would
    // narrow what counts as one (`@scp/source-census`'s hash.ts doc states this rule).
    //
    // Both composition files, because the loops MOVED: checking only `main.ts` after 2026-08-17
    // would be a census aimed at where the code used to be — the exact "fixed some call sites"
    // failure CLAUDE.md names.
    const srcDir = dirname(fileURLToPath(new URL(".", import.meta.url)));
    for (const file of ["main.ts", "background-work.ts"]) {
      const raw = readFileSync(join(srcDir, file), "utf8");
      expect(raw, `${file} registers a competing consumer on domain-events`).not.toMatch(
        /work<[^>]*>\(\s*DOMAIN_EVENTS_QUEUE/
      );
    }
  });
});

describe("bumpDispatchRoleGuard — derived, not copied from either M21.4 job", () => {
  const base = {
    role: "worker" as const,
    federationRole: "commander" as const,
    federationRoleDeclared: true
  };

  it("allows a background-work process on an explicitly declared commander", () => {
    expect(bumpDispatchRoleGuard(base).allowed).toBe(true);
    expect(bumpDispatchRoleGuard({ ...base, role: "all" }).allowed).toBe(true);
  });

  it("refuses an api-only process — background work belongs to all/worker", () => {
    const verdict = bumpDispatchRoleGuard({ ...base, role: "api" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
  });

  it("is FAIL-CLOSED on an UNDECLARED federation role, which is the whole point of the second axis", () => {
    // `federationRole` DEFAULTS to `commander` so every pre-M16.3 deployment keeps serving the SPA.
    // A guard testing only the value would therefore let through exactly the population most likely
    // to be air-gapped — an outpost that predates the setting — and this job WRITES to a repository.
    const verdict = bumpDispatchRoleGuard({ ...base, federationRoleDeclared: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not declared/);
  });

  it("refuses a declared outpost or retrans", () => {
    expect(bumpDispatchRoleGuard({ ...base, federationRole: "outpost" }).allowed).toBe(false);
    expect(bumpDispatchRoleGuard({ ...base, federationRole: "retrans" }).allowed).toBe(false);
  });
});

describe("the router predicate", () => {
  const event = (type: string): DomainEventJob => ({
    id: "e1",
    orgId: "o1",
    type,
    subject: "line-1"
  });

  it("matches the head-advance event and nothing else", () => {
    expect(isLineHeadAdvancedEvent(event(DEPENDENCY_LINE_HEAD_ADVANCED_EVENT))).toBe(true);
    expect(isLineHeadAdvancedEvent(event("scp.change.transitioned"))).toBe(false);
    expect(isLineHeadAdvancedEvent(event("scp.object.created"))).toBe(false);
  });

  it("enqueues onto its OWN queue, and does no work in the router", async () => {
    const sent: { queue: string; job: unknown; options: unknown }[] = [];
    const boss = {
      send: async (queue: string, job: unknown, options?: unknown) => {
        sent.push({ queue, job, options });
        return "job-id";
      }
    };
    const router = advancedLineHeadRouter();
    expect(router.queue).toBe(DEPENDENCY_BUMP_QUEUE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await router.route(boss as any, event(DEPENDENCY_LINE_HEAD_ADVANCED_EVENT));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await router.route(boss as any, event("scp.change.transitioned"));
    expect(sent).toEqual([
      // OPTIONS ARE CAPTURED AND ASSERTED EMPTY on purpose. This used to send
      // `{ singletonKey: lineId }` with a comment claiming it collapsed a redelivery; pg-boss scopes
      // every `singleton_key` uniqueness index to the `short`/`singleton`/`stately` policies, and
      // this queue is created with the default `standard`, so the key was recorded and ignored. An
      // inert option is invisible unless something looks at it — so this looks.
      { queue: DEPENDENCY_BUMP_QUEUE, job: { orgId: "o1", lineId: "line-1" }, options: undefined }
    ]);
  });

  it("ignores an advance event carrying no line subject rather than enqueuing a job for nothing", async () => {
    const sent: unknown[] = [];
    const boss = {
      send: async (_q: string, job: unknown) => {
        sent.push(job);
        return "id";
      }
    };
    const router = advancedLineHeadRouter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await router.route(boss as any, {
      id: "e",
      orgId: "o",
      type: DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
      subject: null
    });
    expect(sent).toEqual([]);
  });
});

describe("planBump — what the bump would SAY, and every refusal that names its own cause", () => {
  it("composes by SUBSTITUTION, so the declaration's range operator survives", () => {
    const plan = planBump({
      line: npmLine({ latestVersion: "1.4.0" }),
      declaration: { declaredVersion: "^1.2.3", resolvedVersion: "1.2.3" },
      granularity: "minor_and_patch"
    });
    expect(plan).toEqual({ due: true, fromVersion: "^1.2.3", toVersion: "^1.4.0" });
  });

  it("keeps a `v` prefix, and a variant suffix, for the same reason", () => {
    expect(
      planBump({
        line: npmLine({ ecosystem: "go", latestVersion: "1.9.0" }),
        declaration: { declaredVersion: "v1.2.3", resolvedVersion: "1.2.3" },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "v1.2.3", toVersion: "v1.9.0" });
    expect(
      planBump({
        line: npmLine({
          ecosystem: "oci",
          major: "3",
          tagPattern: "-alpine",
          latestVersion: "3.19.1-alpine"
        }),
        declaration: { declaredVersion: "3.18.0-alpine", resolvedVersion: "3.18.0-alpine" },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "3.18.0-alpine", toVersion: "3.19.1-alpine" });
  });

  it("refuses a MINOR move under `patch` granularity — the most restrictive wins", () => {
    const plan = planBump({
      line: npmLine({ latestVersion: "1.4.0" }),
      declaration: { declaredVersion: "1.2.3", resolvedVersion: "1.2.3" },
      granularity: "patch"
    });
    expect(plan).toMatchObject({ due: false, reason: "beyond_granularity" });
  });

  it("allows a PATCH move under `patch` granularity", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.2.9" }),
        declaration: { declaredVersion: "1.2.3", resolvedVersion: "1.2.3" },
        granularity: "patch"
      })
    ).toEqual({ due: true, fromVersion: "1.2.3", toVersion: "1.2.9" });
  });

  it("refuses an OPEN RANGE rather than resolving one — resolving a lockfile is CI by definition", () => {
    expect(
      planBump({
        line: npmLine({}),
        declaration: { declaredVersion: "^1", resolvedVersion: null },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declaration_pins_no_version" });
  });

  it("refuses when the head is not observed — NULL is 'not yet observed', never 'nothing newer exists'", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: null }),
        declaration: { declaredVersion: "^1.2.3", resolvedVersion: "1.2.3" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "no_head_observed" });
  });

  it("refuses when the component is already at or ahead of the head", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: { declaredVersion: "^1.4.0", resolvedVersion: "1.4.0" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "already_at_or_ahead_of_head" });
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: { declaredVersion: "^1.5.0", resolvedVersion: "1.5.0" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "already_at_or_ahead_of_head" });
  });

  it("refuses a head that is not on the line as the line is defined NOW", () => {
    // A stored head whose variant no longer matches: the line follows `-alpine` and the head is the
    // plain flavour. Two flavours of one release are not an upgrade path.
    expect(
      planBump({
        line: npmLine({
          ecosystem: "oci",
          major: "3",
          tagPattern: "-alpine",
          latestVersion: "3.19.1"
        }),
        declaration: { declaredVersion: "3.18.0-alpine", resolvedVersion: "3.18.0-alpine" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "head_not_on_line" });
  });

  it("refuses a declaration whose resolved version is not a substring of it, rather than reformatting", () => {
    // The two columns disagree about what the file says. Every way of proceeding is a guess about
    // somebody else's manifest, and the edit target would be text that does not appear in the file.
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: { declaredVersion: ">=1.2 <2", resolvedVersion: "1.2.3" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declaration_not_composable" });
  });

  it("refuses a declared version this ecosystem's grammar cannot read", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: { declaredVersion: "latest", resolvedVersion: "latest" },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declared_version_not_comparable" });
  });
});

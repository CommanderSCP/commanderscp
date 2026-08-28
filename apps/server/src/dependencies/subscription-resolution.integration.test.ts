import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { DependencyEcosystemSchema, type DependencyLineKey } from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { users } from "../db/schema.js";
import { mergeContributorEffects } from "../governance/policy-model.js";
import { matchPoliciesForTargets } from "../governance/policy-resolve.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  RawScpAppClient,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { upsertComponentDependency, upsertDependencyLine } from "./dependency-inventory-repo.js";
import {
  gatherSubscriptionCandidates,
  listSubscribedComponentLines,
  readInstanceSubscriptionUnlock,
  resolveDependencySubscription
} from "./subscription-resolution.js";

/**
 * M21.3 — THE ENABLEMENT CHAIN AGAINST REAL POSTGRES (ADR-0032 §3a/§6, migration 0062).
 *
 * The pure algebra is proven without a database in `subscription-resolution.test.ts`. THIS file
 * proves the five things that only a real database and the real policy machinery can:
 *
 *   1. THE SUBSTRATE LANDED. `dependency_subscription_unlock` exists, ships EMPTY (no row = locked),
 *      is tenant-READABLE and tenant-UNWRITABLE — both barriers from 0062's header, probed with a
 *      RAW `scp_app` connection rather than through application code.
 *   2. A `dependencySubscription` EFFECT VALIDATES on a real `policy` object, and the malformed
 *      shapes are refused at AUTHORING TIME (400) rather than resolving to nothing later. That is
 *      the half of "absent never means enabled" that lives in the JSON Schema.
 *   3. THE WORK-LIST IS DERIVED, NOT FILTERED. A disabled component and an opted-out line are absent
 *      from `listSubscribedComponentLines`, and the enabled ones are present — the negative control
 *      without which the absences prove nothing.
 *   4. TIER LABELS COME FROM `typeId`, NOT FROM POSITION, over a REAL four-rung containment chain
 *      (org -> containment domain -> service -> component). `containmentChain` can hand back a chain
 *      whose index 0 is not the org (BUILD_AND_TEST.md M21.3's "root labels can lie"), so this is
 *      asserted rather than assumed.
 *   5. THE CEL-CONDITION WIRING EXISTS, over a policy whose `condition` was AUTHORED THROUGH THE
 *      API. The pure merge honours `candidate.conditional`, but the line that SETS it from
 *      `match.condition` was pinned by NOTHING — deleting it left every unit and every integration
 *      test green while a conditional ENABLE silently became an unconditional one.
 *
 * Plus the property that makes ADR-0032 §3a consequence 4 true rather than merely intended: a policy
 * carrying a `dependencySubscription` effect adds NOTHING to what the gate enforces.
 *
 * INSTANCE-GLOBAL FIXTURE, HANDLED LIKE THE SCAN FLOORS. `dependency_subscription_unlock` has no
 * `org_id` and the integration suite runs `singleFork` against ONE shared Postgres, so the row is
 * deleted at teardown no matter how this file exits — a stray unlock is inert for every other suite
 * today, but "inert today" is not a reason to leak deployment state out of a test file.
 */
describe("M21.3 dependency-subscription enablement (ADR-0032 §6, migration 0062)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  /** The bootstrap admin's graph `user` object — the acting subject policy matching resolves
   *  `scope.group` against, threaded exactly as the gate threads it. */
  let actorObjectId: string;

  /** Components and lines shared by the work-list suite. */
  let subscribedComponent: string;
  let unsubscribedComponent: string;
  let lineWanted: DependencyLineKey;
  let lineOptedOut: DependencyLineKey;
  let lineWantedId: string;
  let lineOptedOutId: string;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** The unlock is operator-written over the ADMIN connection — `scp_app` holds no write grant and
   *  no write RLS policy exists (0062's two barriers). A test that could set it through the tenant
   *  pool would be proving the barriers absent. */
  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.3 integration fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  /** A policy carrying ONLY a `dependencySubscription` effect, scoped at one object — the whole
   *  authoring surface (ADR-0032 §3a: no new object type, no new relationship type). */
  async function subscriptionPolicy(
    name: string,
    scopeObjectId: string,
    effect: Record<string, unknown>,
    /** Extra top-level policy-document keys — `condition` is the one this file needs, and it is
     *  passed through verbatim so the CEL string reaching `matchPoliciesForTargets` is a real
     *  authored one rather than a hand-set flag. */
    extraProperties: Record<string, unknown> = {}
  ) {
    return admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ dependencySubscription: effect }],
        ...extraProperties
      }
    });
  }

  async function declare(componentObjectId: string, key: DependencyLineKey): Promise<string> {
    return inOrg(async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, key);
      await upsertComponentDependency(tx, org.orgId, {
        componentObjectId,
        lineId: line.id,
        manifestPath: "package.json",
        declaredVersion: "^1.0.0"
      });
      return line.id;
    });
  }

  async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ScpApiError) return err;
      throw err;
    }
    throw new Error("expected an ScpApiError, but the call succeeded");
  }

  const workList = (componentObjectIds?: string[]) =>
    inOrg((tx) =>
      listSubscribedComponentLines(tx, org.orgId, {
        actorObjectId,
        ...(componentObjectIds ? { componentObjectIds } : {})
      })
    );

  /** `(component, line)` pairs of the work-list, as comparable strings. */
  const pairsOf = (items: Awaited<ReturnType<typeof workList>>): string[] =>
    items.map((i) => `${i.componentObjectId}::${i.line.coordinate}@${i.line.major}`).sort();

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dep-subscription");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const [adminRow] = await server.deps.db
      .select({ objectId: users.objectId })
      .from(users)
      .where(eq(users.username, org.adminUsername));
    if (!adminRow?.objectId) throw new Error("expected the bootstrap admin to have a user object");
    actorObjectId = adminRow.objectId;

    subscribedComponent = (await createOrphanComponent(server, org, `subscribed-${uuidv7()}`)).id;
    unsubscribedComponent = (await createOrphanComponent(server, org, `unsubscribed-${uuidv7()}`)).id;

    // Two npm lines under ONE component. Coordinates go in verbatim, and the opted-out one is the
    // slug-colliding spelling of the other (`graph/urn.ts` collapses both to `acme-lib`), so an
    // opt-out that normalised would take the wrong line with it.
    lineWanted = { ecosystem: "npm", coordinate: "@acme/lib", major: "1" };
    lineOptedOut = { ecosystem: "npm", coordinate: "acme-lib", major: "1" };
    lineWantedId = await declare(subscribedComponent, lineWanted);
    lineOptedOutId = await declare(subscribedComponent, lineOptedOut);
    // The UNSUBSCRIBED component declares the SAME lines — so its absence from the work-list is
    // about enablement and never about it having nothing to declare.
    await declare(unsubscribedComponent, lineWanted);
    await declare(unsubscribedComponent, lineOptedOut);
  });

  afterAll(async () => {
    // Instance-global row: removed regardless of how this file exits.
    await setInstanceUnlock(null).catch(() => undefined);
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (1) The substrate — migration 0062's table, its default, and its two write barriers
  // -----------------------------------------------------------------------------------------

  describe("(1) the instance unlock substrate", () => {
    it("ships EMPTY, and no row reads as LOCKED — absent never means enabled", async () => {
      await setInstanceUnlock(null);
      const unlock = await inOrg(readInstanceSubscriptionUnlock);
      expect(unlock.unlocked).toBe(false);
      expect(unlock.source).toBe("instance:dependency_subscription_unlock");

      // NEGATIVE CONTROL: the reader is not hardwired to `false` — a real row reads back true, so
      // the assertion above is about the MISSING ROW.
      await setInstanceUnlock(true);
      expect((await inOrg(readInstanceSubscriptionUnlock)).unlocked).toBe(true);
      // …and an explicit `false` row is locked too: both spellings of "off" agree.
      await setInstanceUnlock(false);
      expect((await inOrg(readInstanceSubscriptionUnlock)).unlocked).toBe(false);
    });

    it("is tenant-READABLE and tenant-UNWRITABLE, probed on a RAW scp_app connection", async () => {
      await setInstanceUnlock(false);
      const raw = await RawScpAppClient.connect();
      try {
        await raw.setOrgContext(org.orgId);

        // Barrier check, write side: no grant AND no write RLS policy (0062's two independent
        // barriers). Either alone would deny; both are present so a future re-grant still fails.
        await expect(
          raw.query(
            `UPDATE dependency_subscription_unlock SET unlocked = true WHERE id = 'default'`
          )
        ).rejects.toThrow(/permission denied/i);
        await expect(
          raw.query(
            `INSERT INTO dependency_subscription_unlock (id, unlocked) VALUES ('default', true)`
          )
        ).rejects.toThrow(/permission denied/i);
        await expect(
          raw.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`)
        ).rejects.toThrow(/permission denied/i);

        // NEGATIVE CONTROL: the very same connection CAN read — the refusals above are about WRITE
        // privileges, not about a connection that cannot see the table at all. A gate a tenant
        // cannot inspect is not explainable (charter principle 6), which is why read is open.
        const read = await raw.query<{ unlocked: boolean }>(
          `SELECT unlocked FROM dependency_subscription_unlock WHERE id = 'default'`
        );
        expect(read.rows[0]?.unlocked).toBe(false);
      } finally {
        await raw.close();
      }
    });

    it("is a SINGLETON — a second id is refused by the CHECK", async () => {
      const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
      try {
        await expect(
          pool.query(
            `INSERT INTO dependency_subscription_unlock (id, unlocked) VALUES ('other', true)`
          )
        ).rejects.toThrow(/dependency_subscription_unlock_singleton_ck/);

        // NEGATIVE CONTROL: the same connection writes the ONE legal id without complaint.
        await pool.query(
          `INSERT INTO dependency_subscription_unlock (id, unlocked) VALUES ('default', false)
             ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked`
        );
      } finally {
        await pool.end();
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  // (2) The policy document schema — 0062's second half
  // -----------------------------------------------------------------------------------------

  describe("(2) the `dependencySubscription` policy effect validates", () => {
    it("accepts a well-formed effect on a real `policy` object, and refuses the shapes that would fail open", async () => {
      // The whole authoring surface, on an ordinary policy — no new object type anywhere.
      const created = await subscriptionPolicy("schema-accepts", subscribedComponent, {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        major: "1",
        enabled: true,
        granularity: "patch",
        delivery: "pull_request"
      });
      expect(created.id).toBeTruthy();

      // `enabled` is REQUIRED. Without the requirement, a typo'd key would produce an inert
      // opt-out-shaped effect that opts nothing out — refused here instead, at authoring time.
      const missingEnabled = await expectApiError(() =>
        subscriptionPolicy("schema-missing-enabled", subscribedComponent, {
          coordinate: "@acme/lib"
        })
      );
      expect(missingEnabled.status).toBe(400);

      // A mistyped ecosystem on a SELECTOR silently voids the selector, and a voided selector on an
      // OPT-OUT fails open — which is why 0062 carries the enum even though 0061 deliberately left
      // the ecosystem set to packages/schemas alone.
      const badEcosystem = await expectApiError(() =>
        subscriptionPolicy("schema-bad-ecosystem", subscribedComponent, {
          ecosystem: "nmp",
          enabled: false
        })
      );
      expect(badEcosystem.status).toBe(400);

      const badDelivery = await expectApiError(() =>
        subscriptionPolicy("schema-bad-delivery", subscribedComponent, {
          enabled: true,
          delivery: "merge-it-please"
        })
      );
      expect(badDelivery.status).toBe(400);
    });

    it("refuses a MISTYPED SELECTOR KEY — on an enable AND on an opt-out (0062 `additionalProperties: false`)", async () => {
      // THE SAME PROPERTY AS THE ECOSYSTEM ENUM ABOVE, one level up: a selector that fails to bind
      // must void ITSELF, not the constraint. Ajv is compiled with `strict: false`
      // (`graph/property-validation.ts:14`), so without `additionalProperties: false` an unknown key
      // raises nothing here AND is then STRIPPED by the resolver's parse — arriving at the merge as
      // an effect with NO selectors, i.e. a WILDCARD. One transposed character would subscribe every
      // dependency line in the scope, and the same typo on an opt-out would wildcard the DISABLE.
      const typoEnable = await expectApiError(() =>
        subscriptionPolicy("schema-typo-enable", subscribedComponent, {
          enabled: true,
          coordinat: "@acme/lib"
        })
      );
      expect(typoEnable.status).toBe(400);
      // WHICH 400 — asserted on `problem.detail`, because a bare `status` check would pass equally
      // against a refusal from the URN, the name, or the scope-authority guard, and this test would
      // then be green for the wrong reason. It is the SCHEMA that must refuse this document.
      expect(typoEnable.problem?.detail).toMatch(/JSON Schema/i);
      expect(typoEnable.problem?.detail).toMatch(/must NOT have additional properties/i);
      expect(typoEnable.problem?.detail).toMatch(/dependencySubscription/);

      const typoOptOut = await expectApiError(() =>
        subscriptionPolicy("schema-typo-optout", subscribedComponent, {
          enabled: false,
          coordinat: "@acme/lib"
        })
      );
      expect(typoOptOut.status).toBe(400);

      // …and a typo in one of the SETTINGS keys is refused for the same reason: `granularit` would
      // have been stripped into "declared nothing", which is now a vote for the default rather than
      // an abstention but is still not what the author wrote.
      expect(
        (
          await expectApiError(() =>
            subscriptionPolicy("schema-typo-granularity", subscribedComponent, {
              enabled: true,
              granularit: "patch"
            })
          )
        ).status
      ).toBe(400);

      // NEGATIVE CONTROL: the correctly-spelled keys are accepted on the same object, so the three
      // refusals above are about the UNKNOWN KEY and not about a schema that refuses selectors.
      const ok = await subscriptionPolicy("schema-typo-control", subscribedComponent, {
        enabled: true,
        coordinate: "@acme/lib",
        granularity: "patch"
      });
      expect(ok.id).toBeTruthy();
    });

    it("keeps 0062's ecosystem enum in step with `DependencyEcosystemSchema`", async () => {
      // The price of refusing a mistyped selector at authoring time is a SECOND copy of the
      // ecosystem list (0062's header states it). This reads the enum that actually landed in
      // `object_types.property_schema` rather than the migration text, so a later migration that
      // re-states the document and drops an ecosystem is caught too.
      const rows = await inOrg((tx) =>
        tx.execute<{ ecosystems: string[] }>(sql`
          SELECT property_schema
                   -> 'properties' -> 'effects' -> 'items' -> 'properties'
                   -> 'dependencySubscription' -> 'properties' -> 'ecosystem' -> 'enum'
                 AS ecosystems
          FROM object_types WHERE id = 'policy'
        `)
      );
      expect([...(rows.rows[0]?.ecosystems ?? [])].sort()).toEqual(
        [...DependencyEcosystemSchema.options].sort()
      );
    });

    it("adds NOTHING to what the gate enforces — the effect is invisible to `mergeContributorEffects`", async () => {
      // ADR-0032 §3a consequence 4: `dependencySubscription` is deliberately absent from
      // `policy-model.ts`'s `PolicyEffect` union, so it can never be an "unsatisfied effect". Here
      // that is proven over the REAL matcher against a REAL policy object, not a hand-built input.
      await subscriptionPolicy("gate-untouched-subscription", subscribedComponent, {
        enabled: true
      });
      const matched = await inOrg((tx) =>
        matchPoliciesForTargets(tx, {
          orgId: org.orgId,
          targetObjectIds: [subscribedComponent],
          actorObjectId
        })
      );
      expect(matched.length).toBeGreaterThan(0); // the policies really did match
      const merged = mergeContributorEffects(matched);
      expect(merged.requireControls).toEqual([]);
      expect(merged.requireApprovals).toEqual([]);

      // NEGATIVE CONTROL: the same merge over the same chain DOES pick up a real require-effect —
      // so the two empty arrays above are about `dependencySubscription` being ignored, not about a
      // matcher that returned nothing usable.
      await admin.policies.create({
        name: "gate-untouched-control",
        urn: `urn:scp:${org.orgId}:policy:gate-untouched-control`,
        properties: {
          scope: { objectRef: subscribedComponent },
          enforcement: "required",
          effects: [{ requireControls: ["some-control"] }]
        }
      });
      const merged2 = mergeContributorEffects(
        await inOrg((tx) =>
          matchPoliciesForTargets(tx, {
            orgId: org.orgId,
            targetObjectIds: [subscribedComponent],
            actorObjectId
          })
        )
      );
      expect(merged2.requireControls).toEqual(["some-control"]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (3) The work-list — derived from the resolution, never filtered beside it
  // -----------------------------------------------------------------------------------------

  describe("(3) the ingestion work-list", () => {
    beforeAll(async () => {
      // The subscription itself: the whole component, minus one line.
      await subscriptionPolicy("subscribe-component", subscribedComponent, { enabled: true });
      await subscriptionPolicy("opt-out-one-line", subscribedComponent, {
        coordinate: "acme-lib",
        enabled: false
      });
      await setInstanceUnlock(true);
    });

    it("excludes the opted-out line and the component nothing enabled — and INCLUDES the enabled one", async () => {
      const items = await workList();

      // THE NEGATIVE CONTROL, first: something IS in the list, so the absences below are real
      // exclusions rather than an empty query.
      expect(pairsOf(items)).toEqual([`${subscribedComponent}::@acme/lib@1`]);

      // The opted-out line — the deepest level may only subtract, and it did.
      expect(items.some((i) => i.lineId === lineOptedOutId)).toBe(false);
      // A component with the identical declarations and no enabling policy: absent never enables.
      expect(items.some((i) => i.componentObjectId === unsubscribedComponent)).toBe(false);
      // And the one that IS subscribed carries the line's natural key verbatim.
      expect(items[0]?.lineId).toBe(lineWantedId);
      expect(items[0]?.line).toEqual(lineWanted);
      // No enabling contribution declared settings, so both resolve to the most restrictive option.
      expect(items[0]?.granularity).toBe("patch");
      expect(items[0]?.delivery).toBe("pull_request");
    });

    it("carries the contribution chain, so the work item explains itself (principle 6)", async () => {
      const [item] = await workList([subscribedComponent]);
      const contributed = item?.contributions.map((c) => `${c.tier}:${c.contributed}`) ?? [];
      expect(contributed).toContain("instance:unlock");
      expect(contributed).toContain("component:enable");
      // The opt-out is a real contribution on the OTHER line, and it names the level that acted.
      const optedOut = await inOrg((tx) =>
        resolveDependencySubscription(tx, {
          orgId: org.orgId,
          componentObjectId: subscribedComponent,
          actorObjectId,
          line: lineOptedOut
        })
      );
      expect(optedOut.enabled).toBe(false);
      expect(optedOut.reason).toBe("disabled");
      expect(optedOut.contributions.find((c) => c.contributed === "disable")).toMatchObject({
        tier: "component",
        selector: { coordinate: "acme-lib" }
      });
    });

    it("the instance level UNLOCKS AND NEVER ACTIVATES — locking empties the list, unlocking alone fills nothing", async () => {
      await setInstanceUnlock(false);
      expect(await workList()).toEqual([]);

      // NEGATIVE CONTROL: unlocking the SAME fixture brings the enabled pair straight back, so the
      // empty list above is the lock and not a broken fixture.
      await setInstanceUnlock(true);
      expect(pairsOf(await workList())).toEqual([`${subscribedComponent}::@acme/lib@1`]);

      // …and the unlock ACTIVATES NOTHING on its own: the component with no enabling policy stays
      // out of the list while the deployment is unlocked (ADR-0006 — never a default).
      expect(await workList([unsubscribedComponent])).toEqual([]);
    });

    it("agrees with `resolveDependencySubscription` on EVERY pair — the AND is written once", async () => {
      // If the work-list re-expressed the AND instead of deriving it, this is the test that would
      // catch the two copies drifting apart.
      const included = new Set(
        (await workList()).map((i) => `${i.componentObjectId}::${i.lineId}`)
      );
      for (const componentObjectId of [subscribedComponent, unsubscribedComponent]) {
        for (const line of [lineWanted, lineOptedOut]) {
          const resolution = await inOrg((tx) =>
            resolveDependencySubscription(tx, {
              orgId: org.orgId,
              componentObjectId,
              actorObjectId,
              line
            })
          );
          const lineId = line === lineWanted ? lineWantedId : lineOptedOutId;
          expect(
            included.has(`${componentObjectId}::${lineId}`),
            `${componentObjectId} / ${line.coordinate} must agree`
          ).toBe(resolution.enabled);
        }
      }
      // NEGATIVE CONTROL: the comparison is not vacuously true over an all-false set.
      expect(included.size).toBe(1);
    });

    it("counts a line declared from TWO dependency manifests once", async () => {
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: subscribedComponent,
          lineId: lineWantedId,
          manifestPath: "packages/api/package.json",
          declaredVersion: "^1.2.0"
        })
      );
      // One work item, not two polls of the same registry for the same line.
      expect(await workList([subscribedComponent])).toHaveLength(1);

      // NEGATIVE CONTROL: a genuinely DIFFERENT line on the same component does add an item.
      const extra: DependencyLineKey = {
        ecosystem: "go",
        coordinate: "github.com/acme/other",
        major: "v1"
      };
      await declare(subscribedComponent, extra);
      expect(pairsOf(await workList([subscribedComponent]))).toEqual([
        `${subscribedComponent}::@acme/lib@1`,
        `${subscribedComponent}::github.com/acme/other@v1`
      ]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (4) Tier labels over a REAL containment chain — derived from typeId, never from position
  // -----------------------------------------------------------------------------------------

  describe("(4) tier labels and a higher-tier opt-out", () => {
    let chainComponent: string;

    beforeAll(async () => {
      // org root -> containment domain -> service -> component, the component reachable from BOTH
      // the service (`contains`) and the org root (its own `domain_id`) — the real four-rung chain.
      const domain = await admin.object("domain").create({ name: `dom-${uuidv7()}` });
      const service = await admin
        .object("service")
        .create({ name: `svc-${uuidv7()}`, domainId: domain.id });
      chainComponent = (await createOrphanComponent(server, org, `chain-${uuidv7()}`)).id;
      await admin.relationships.create({
        typeId: "contains",
        fromId: service.id,
        toId: chainComponent
      });
      await subscriptionPolicy("chain-enable-component", chainComponent, { enabled: true });
      await subscriptionPolicy("chain-enable-service", service.id, { enabled: true });
      await setInstanceUnlock(true);
    });

    it("labels each contribution from the matched object's OWN typeId, not from its chain index", async () => {
      const candidates = await inOrg((tx) =>
        gatherSubscriptionCandidates(tx, {
          orgId: org.orgId,
          componentObjectId: chainComponent,
          actorObjectId
        })
      );
      const byTier = new Map(candidates.map((c) => [c.tier, c.objectTypeId]));
      // `containmentChain` can return a chain whose index 0 is a top-level DOMAIN rather than the
      // org (it truncates at depth<10 and then recomputes depth over what it returned), so the tier
      // must be derived from `typeId`. Both labels below carry the verbatim type that produced them.
      expect(byTier.get("component")).toBe("component");
      expect(byTier.get("service")).toBe("service");
      expect(candidates.every((c) => c.objectTypeId !== undefined)).toBe(true);
    });

    it("an opt-out ABOVE the component defeats the component's own enable", async () => {
      const line: DependencyLineKey = { ecosystem: "python", coordinate: "acme-sdk", major: "3" };
      await declare(chainComponent, line);

      // NEGATIVE CONTROL, taken FIRST: with only the two enables in play, the line is subscribed.
      const before = await inOrg((tx) =>
        resolveDependencySubscription(tx, {
          orgId: org.orgId,
          componentObjectId: chainComponent,
          actorObjectId,
          line
        })
      );
      expect(before.enabled).toBe(true);

      // The org tier may only ever subtract — and it does, over two deeper enables.
      await subscriptionPolicy("chain-optout-org", org.orgId, {
        coordinate: "acme-sdk",
        enabled: false
      });
      const after = await inOrg((tx) =>
        resolveDependencySubscription(tx, {
          orgId: org.orgId,
          componentObjectId: chainComponent,
          actorObjectId,
          line
        })
      );
      expect(after.enabled).toBe(false);
      expect(after.reason).toBe("disabled");
      expect(after.contributions.find((c) => c.contributed === "disable")).toMatchObject({
        tier: "org",
        objectTypeId: "organization"
      });
      expect(after.contributions.filter((c) => c.contributed === "enable")).toHaveLength(2);

      // …and the work-list follows, because it is derived from this same resolution.
      expect(await workList([chainComponent])).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (5) A REAL CEL `condition` ON A REAL POLICY — the wiring, not just the flag
  //
  // The pure merge honours `candidate.conditional` and `subscription-resolution.test.ts` pins both
  // of its directions. What NOTHING pinned is the line that SETS it: `gatherSubscriptionCandidates`
  // reading `match.condition` off the matched policy. Deleting that one spread left all 26 unit and
  // all 13 integration tests green, because every test that exercised a condition hand-built the
  // flag instead of authoring a policy that carries one. With the wiring gone a conditional ENABLE
  // becomes an unconditional one, and `{"condition": "env == \"prod\""}` subscribes a component the
  // condition excludes — the exact fail-open the module doc calls out as load-bearing.
  //
  // So this suite authors the condition through the API and reads the flag back out of the real
  // matcher. Nothing here hand-sets `conditional`.
  // -----------------------------------------------------------------------------------------

  describe("(5) a CEL condition authored on a real policy", () => {
    let conditionalComponent: string;
    let conditionalLine: DependencyLineKey;

    /** A condition the resolver could not evaluate even in principle: enablement resolution has no
     *  change context at all, which is exactly why an unevaluable condition may never ENABLE. */
    const CONDITION = 'change.properties.environment == "prod"';

    beforeAll(async () => {
      conditionalComponent = (await createOrphanComponent(server, org, `conditional-${uuidv7()}`)).id;
      conditionalLine = { ecosystem: "go", coordinate: "github.com/acme/conditional", major: "v2" };
      await declare(conditionalComponent, conditionalLine);
      await setInstanceUnlock(true);
    });

    const resolveHere = () =>
      inOrg((tx) =>
        resolveDependencySubscription(tx, {
          orgId: org.orgId,
          componentObjectId: conditionalComponent,
          actorObjectId,
          line: conditionalLine
        })
      );

    it("carries the condition off the matched policy — a conditional ENABLE is admitted to NEITHER side", async () => {
      await subscriptionPolicy(
        "conditional-enable",
        conditionalComponent,
        { enabled: true },
        { condition: CONDITION }
      );

      // The wiring itself: the flag comes from the matcher, on a policy whose `condition` was
      // authored through the API. If `gatherSubscriptionCandidates` stopped reading
      // `match.condition`, this is the assertion that fails first.
      const candidates = await inOrg((tx) =>
        gatherSubscriptionCandidates(tx, {
          orgId: org.orgId,
          componentObjectId: conditionalComponent,
          actorObjectId
        })
      );
      const conditional = candidates.filter((c) => c.conditional === true);
      expect(conditional).toHaveLength(1);
      expect(conditional[0]?.source).toMatch(/conditional-enable/);

      // …and the consequence, which is the part that matters: the enable does not enable.
      const resolution = await resolveHere();
      expect(resolution.enabled).toBe(false);
      expect(resolution.reason).toBe("not_enabled");
      expect(resolution.contributions).toContainEqual(
        expect.objectContaining({
          contributed: "ignored",
          ignoredReason: "condition_unevaluable"
        })
      );
      // The work-list is derived from the same resolution, so a condition SCP cannot evaluate never
      // reaches the ingestion path either.
      expect(await workList([conditionalComponent])).toEqual([]);
    });

    it("NEGATIVE CONTROL: the identical policy WITHOUT a condition does enable the same pair", async () => {
      // Without this, everything above passes equally against a component nothing could ever
      // subscribe — a fixture that never enabled, rather than a condition that refused to.
      await subscriptionPolicy("conditional-control-enable", conditionalComponent, {
        enabled: true
      });
      const resolution = await resolveHere();
      expect(resolution.enabled).toBe(true);
      // The conditional contribution is STILL reported as ignored beside the one that worked —
      // "which level did what" stays answerable (principle 6).
      expect(
        resolution.contributions.filter((c) => c.ignoredReason === "condition_unevaluable")
      ).toHaveLength(1);
      expect(pairsOf(await workList([conditionalComponent]))).toEqual([
        `${conditionalComponent}::github.com/acme/conditional@v2`
      ]);
    });

    it("a conditional OPT-OUT is admitted IN FULL — subtracting is the direction that cannot fail open", async () => {
      // The asymmetry, over the real matcher: the same unevaluable condition that disqualifies an
      // enable does not disqualify a disable, because dropping the disable would leave a line
      // subscribed that its own opt-out named.
      await subscriptionPolicy(
        "conditional-optout",
        conditionalComponent,
        { coordinate: "github.com/acme/conditional", enabled: false },
        { condition: CONDITION }
      );
      const resolution = await resolveHere();
      expect(resolution.enabled).toBe(false);
      expect(resolution.reason).toBe("disabled");
      expect(resolution.contributions).toContainEqual(
        expect.objectContaining({
          contributed: "disable",
          selector: { coordinate: "github.com/acme/conditional" }
        })
      );
      expect(await workList([conditionalComponent])).toEqual([]);
    });
  });
});

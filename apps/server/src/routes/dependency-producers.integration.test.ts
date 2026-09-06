import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { auditEvents, changeWaveTargets, changes, decisions, objects } from "../db/schema.js";
import { compileAndPersistPlan } from "../coordination/plan-service.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  getDependencyLineByKey,
  getDependencyLineProducer,
  listDependencyLineProducers,
  listThirdPartyDependencyLinesByIds,
  recordDependencyLineHead,
  upsertComponentDependency,
  upsertDependencyLine
} from "../dependencies/dependency-inventory-repo.js";
import { detectInternalReleases } from "../dependencies/internal-release-detection.js";
import { runBumpDispatchJob } from "../dependencies/bump-dispatch.js";
import { buildLineWorkList } from "../dependencies/version-poll.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { PRODUCER_DECISION_KIND } from "./dependency-producers.js";

/**
 * THE PRODUCER DECLARATION'S AUTHORING SURFACE, END TO END (ADR-0032 §7e,
 * `routes/dependency-producers.ts`).
 *
 * ============================================================================================
 * WHAT THIS FILE HAS TO PROVE, AND WHY EACH GATE IS THE ONE IT IS
 * ============================================================================================
 * The defect being fixed is "a function with no caller": `declareDependencyLineProducer` existed,
 * was correct, was covered by its own repo tests, and NOTHING IN PRODUCTION CALLED IT — so
 * `produced_by_object_id` was never set, `isInternalDependencyLine` was always false, and the
 * internal half of dependency subscriptions could not fire at all. Four gates, and none of them is
 * satisfied by asserting a row exists:
 *
 *  1. **WIRING.** Deleting `registerDependencyProducerRoutes(app, deps)` from `app.ts` must turn
 *     "(1) WIRING …" RED. Shipping a second uncalled function to fix an uncalled function would be
 *     absurd, so this is the first case in the file. MEASURED: with the registration commented out,
 *     that case fails with a 404 and the rest of the file fails with it.
 *  2. **CAPABILITY, END TO END.** Declare through the ROUTE, then drive the REAL internal-release
 *     detection path — an accepted change reaching a `prod` deployment-target with an observed image
 *     — and assert a SUBSCRIBED component comes out of `runBumpDispatchJob` as a candidate. Before
 *     this change that sequence is IMPOSSIBLE BY CONSTRUCTION, which is what makes it the honest
 *     acceptance test. Asserting the row exists is not enough: the column was always writable.
 *  3. **DECLARED, NEVER INFERRED.** No ingestion path may set a producer as a side effect. Pinned as
 *     a SOURCE-LEVEL CENSUS over the ingestion modules plus a behavioural check that a full
 *     ingestion run leaves `dependency_line_producers` empty — because the property is an ABSENCE,
 *     and an absence is what nobody notices regressing.
 *  4. **NEW MAJOR.** Declare, then have ingestion mint a BRAND-NEW major line for that coordinate,
 *     and assert the version poll does not hand it to a public index. This is the entire reason the
 *     grain is per COORDINATE: under the retired per-line column that new row's producer was NULL
 *     because nobody had re-declared it, and the poll fetched the org's own package from a stranger.
 *
 * ============================================================================================
 * MUTATION LOG — each applied, watched fail, reverted, watched pass
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | remove `registerDependencyProducerRoutes` from `app.ts` | 13 of 14 FAIL, "(1) WIRING" first, with a 404 (re-measured after the two cases below were added) |
 * | `listThirdPartyDependencyLinesByIds` drops its `NOT EXISTS` anti-join (`sql\`TRUE\``) | "(5) … is NOT handed to a public index" FAILS — the freshly minted major reaches the poll's work-list |
 * | BOTH producer verbs stop calling `resetLineHead` | 3 FAIL: "(3) CLEARS a poisoned public head", "(4) CLEARS the internal head", and "(7) CAPABILITY" — the last because the retraction in its negative control no longer clears `1.1.0` |
 * | `authorize`'s scope becomes the producer component instead of the org root | "(2) REFUSES an author whose `policy:write` is bound to the producing component" FAILS |
 * | the request schema ACCEPTS `declaredByObjectId` and the route reads it | "(2) the declaring principal is the AUTHENTICATED SUBJECT" FAILS — the impostor id is stored |
 * | `assertDeclarableProducer` drops its `service` arm | "(2) REFUSES a producer that is not a live in-org COMPONENT" FAILS |
 *
 * TWO SURVIVORS, both fixed here rather than recorded and left:
 *
 *  - **the `service` arm, deleted, left the whole file GREEN.** The case asserted only
 *    `400` + `/service/i`, and the generic wrong-type arm answers `400` with a message that also
 *    contains the word "service" ("… is a service"). The two arms were indistinguishable to the
 *    test. Fixed by pinning the two phrases the owner's ruling actually requires — that the refusal
 *    is FIRST-CUT and that it is about POLLING — which is the one place in this file where wording
 *    is asserted, and it is asserted because the wording IS the requirement.
 *  - **reading `declaredByObjectId` from `request.body` alone left the file GREEN**, because the
 *    request schema is a plain `z.object()` and this repo's `z.toJSONSchema()` emits
 *    `additionalProperties: false`, so fastify strips the key before the handler sees it. The
 *    property survives on TWO independent legs, which is the right shape; the mutation that breaks
 *    both at once (add the field to the schema AND read it) is the one in the table above, and it
 *    fails.
 */
describe("the dependency-line PRODUCER declaration (ADR-0032 §7e)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let prodTarget: string;
  /** The admin's SUBJECT object id — what the route must stamp as the declaring principal. Read
   *  from `GET /auth/me` rather than assumed, so this test asserts the server's own notion of who
   *  is calling and not a value the fixture invented. */
  let adminSubjectObjectId: string;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  const declareUrl = () => `${server.baseUrl}/dependencies/producers`;
  const retractUrl = () => `${server.baseUrl}/dependencies/producers/retract`;
  const listUrl = (query: Record<string, string> = {}) =>
    `${server.baseUrl}/dependencies/producers?${new URLSearchParams(query).toString()}`;

  async function post(
    url: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function get(
    url: string,
    token: string
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** Every producer Decision about one subject, OLDEST FIRST — the order an operator reads the
   *  coordinate's history in. `PRODUCER_DECISION_KIND` is imported rather than retyped so the test
   *  cannot pass against a kind the route no longer writes. */
  async function decisionsForSubject(subjectId: string) {
    return inOrg((tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, PRODUCER_DECISION_KIND)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );
  }

  /** The hash-chained audit events one verb wrote about one subject. The COUNTERPART of
   *  `decisionsForSubject`: the two must agree, because a chain that asserts an act the Decision log
   *  has no row for is charter principle 6 failing quietly. */
  async function auditEventsForSubject(subjectId: string, action: string) {
    return inOrg((tx) =>
      tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, org.orgId),
            eq(auditEvents.subjectId, subjectId),
            eq(auditEvents.action, action)
          )
        )
    );
  }

  /** The instance unlock is operator-written over the ADMIN connection — `scp_app` holds no write
   *  grant (drizzle/0062's two barriers). Instance-global, so it is removed at teardown. */
  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'producer-declaration integration fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  /** A host that is wired for NOTHING. Every gate below is reached before any plugin call, and a
   *  throwing stub makes "we got further than expected" a loud failure instead of a silent one. */
  const inertHost: PluginHost = {
    async start() {},
    async stop() {},
    async stopInstances() {},
    gitFileRead: () => {
      throw new Error("not wired");
    },
    executor: () => {
      throw new Error("not wired");
    },
    control: () => {
      throw new Error("not wired");
    },
    discovery: () => {
      throw new Error("not wired");
    },
    notification: () => {
      throw new Error("not wired");
    },
    federationTransport: () => {
      throw new Error("not wired");
    },
    dependencyIndex: () => {
      throw new Error("not wired");
    }
  } as unknown as PluginHost;

  beforeAll(async () => {
    // `federationRole: "commander"` DECLARES the posture. The writes are commander-only and
    // fail-closed on an UNDECLARED deployment (ADR-0032 §7d); the harness leaves
    // `SCP_FEDERATION_ROLE` unset by default, which yields a DEFAULTED commander
    // (`federationRoleDeclared: false`) under which every declare below would answer 409. The
    // refusal gets its own server in "(6)".
    server = await listenTestServer({ federationRole: "commander" });
    org = await createTestOrg(server, "dep-producer");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    adminSubjectObjectId = (await admin.auth.me()).subjectObjectId;
    prodTarget = (
      await admin.deploymentTargets.create({
        name: `prod-${uuidv7()}`,
        properties: { environment: "prod" }
      })
    ).id;
    await setInstanceUnlock(true);
  });

  afterAll(async () => {
    await setInstanceUnlock(null).catch(() => undefined);
    await server?.close();
  });

  // (1) WIRING — the gate that exists because the bug WAS a function with no caller

  describe("(1) WIRING", () => {
    it("the declare route is REGISTERED — delete the registration in app.ts and this goes red", async () => {
      // THE WHOLE POINT. `declareDependencyLineProducer` was correct, tested, and unreachable. This
      // case asserts REACHABILITY and nothing else, so that "the route file exists" can never again
      // be mistaken for "the capability is installed".
      //
      // A 404 here means the path is not mounted. Any other status — including a 400 or a 403 —
      // means the route IS mounted and something further in is refusing, which is a different bug
      // and belongs to a different case.
      const producer = await createOrphanComponent(server, org, `wiring-producer-${uuidv7()}`);
      const response = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate: `@acme/wiring-${uuidv7()}`,
        producerIdOrUrn: producer.id,
        dryRun: true
      });
      expect(response.status, JSON.stringify(response.json)).not.toBe(404);
      expect(response.status).toBe(200);

      // ...and both peers, because three routes registered by one function can still be registered
      // one at a time by a careless edit.
      expect(
        (await post(retractUrl(), org.adminToken, { ecosystem: "npm", coordinate: "@x/y" })).status
      ).not.toBe(404);
      expect((await get(listUrl(), org.adminToken)).status).toBe(200);
    });
  });

  // (2) THE VERB: authority, the FK constraint, and the provenance that must not be forgeable

  describe("(2) the declare verb", () => {
    it("the declaring principal is the AUTHENTICATED SUBJECT, and a body field cannot forge it", async () => {
      // The verifier's finding: `declaredByObjectId` was caller-supplied, so principle 6's "which
      // principal asserted this coordinate is ours" was answerable only with whatever the asserter
      // typed. The request below TRIES to name someone else and is ignored — the extra key is not
      // in the schema at all, so this also pins that the schema stayed closed.
      const producer = await createOrphanComponent(server, org, `provenance-${uuidv7()}`);
      const impostor = await createOrphanComponent(server, org, `impostor-${uuidv7()}`);
      const coordinate = `@acme/provenance-${uuidv7()}`;
      const response = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: producer.id,
        declaredByObjectId: impostor.id
      });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      // THE WIRE VIEW names both ends (§12.6 Q1): the producer by its component name, the declarer
      // by the ADMIN's own name — not the impostor's, which is the same provenance fact as below,
      // read off the response instead of the table.
      const view = response.json.declaration as {
        producerObjectId: string;
        declaredByObjectId: string;
        producer: { objectId: string; name: string };
        declaredBy: { objectId: string; name: string };
      };
      expect(view.producer).toEqual({ objectId: producer.id, name: producer.name });
      expect(view.declaredBy.objectId).toBe(adminSubjectObjectId);
      expect(view.declaredBy.objectId).not.toBe(impostor.id);
      expect(view.declaredBy.name).not.toBe("");

      const stored = await inOrg((tx) =>
        getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
      );
      expect(stored?.producerObjectId).toBe(producer.id);
      // The ADMIN's own subject, not the id the body named.
      expect(stored?.declaredByObjectId).not.toBe(impostor.id);
      expect(stored?.declaredByObjectId).toBe(adminSubjectObjectId);
    });

    it("REFUSES a producer that is not a live in-org COMPONENT — a service by name, anything else by type", async () => {
      const coordinate = `@acme/type-check-${uuidv7()}`;

      // A SERVICE is refused in the first cut, and the message says why (owner decision). It would
      // otherwise remove the coordinate from third-party polling — the harmful half — and derive no
      // head at all, because `listProducedLines` reads the COMPONENT a prod placement names.
      const service = await admin.services.create({ name: `svc-${uuidv7()}` });
      const refusedService = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: service.id
      });
      expect(refusedService.status).toBe(400);
      // THE WORDING IS PINNED HERE, DELIBERATELY, and only here. The owner's ruling is "refuse a
      // service-valued producer IN THE FIRST CUT, with a message saying so" — the explanation IS the
      // requirement, because both this arm and the generic wrong-type arm return 400 and both
      // mention the word "service". A test matching only /service/i cannot tell them apart:
      // MEASURED — deleting the service arm entirely left the whole file green. These two phrases
      // are the ones an operator acts on (this is temporary; declaring the component instead).
      expect(JSON.stringify(refusedService.json)).toMatch(/first cut/i);
      expect(JSON.stringify(refusedService.json)).toMatch(/polling/i);

      // A DEPLOYMENT-TARGET is refused too — `producer_object_id REFERENCES objects(id)` is
      // org-unbound and type-blind (drizzle/0061's header), so this refusal is the ROUTE's and
      // nothing else's.
      const refusedTarget = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: prodTarget
      });
      expect(refusedTarget.status).toBe(400);
      expect(JSON.stringify(refusedTarget.json)).toMatch(/deployment-target/);

      // An id that names nothing in THIS org is a 404 rather than a stored dangling reference.
      const refusedUnknown = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: uuidv7()
      });
      expect(refusedUnknown.status).toBe(404);

      // NOTHING WAS WRITTEN by any of the three. Without this the refusals could be satisfied by a
      // route that stores the row and then throws.
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      ).toBeNull();

      // NEGATIVE CONTROL: a real component on the identical request is accepted, so the three
      // refusals above are about the producer's TYPE and not about the route refusing everything.
      const component = await createOrphanComponent(server, org, `real-${uuidv7()}`);
      const accepted = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: component.id
      });
      expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    });

    it("REFUSES an author whose `policy:write` is bound to the producing component — custody is not jurisdiction", async () => {
      // `governance/policy-scope-authz.ts` is the precedent and the reason: the declaration changes
      // behaviour for every OTHER component in the org that depends on the coordinate, and
      // `scopeExpandCte` expands strictly UPWARD — so a component-bound principal reaches its
      // siblings not at all. Custody of the producing component was never evidence of jurisdiction
      // over its consumers.
      const producer = await createOrphanComponent(server, org, `authz-producer-${uuidv7()}`);
      // `Administrator` at the PRODUCER's own scope: the built-in role that DOES hold `policy:write`
      // (drizzle/0010), bound narrowly. So this author fails on SCOPE and not on permission — which
      // is the distinction the case is about, and a role without `policy:write` would satisfy the
      // 403 for the wrong reason.
      const bounded = await createTestUser(server, org, [
        { role: "Administrator", scope: producer.id }
      ]);
      const coordinate = `@acme/authz-${uuidv7()}`;

      const refused = await post(declareUrl(), bounded.token, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: producer.id
      });
      expect(refused.status).toBe(403);
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      ).toBeNull();

      // ...and retraction takes the same bar, so an author who cannot declare cannot un-declare
      // someone else's coordinate either.
      await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: producer.id
      });
      const refusedRetract = await post(retractUrl(), bounded.token, {
        ecosystem: "npm",
        coordinate
      });
      expect(refusedRetract.status).toBe(403);
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      ).not.toBeNull();

      // NEGATIVE CONTROL: the ORG-ROOT admin's identical request succeeds, so the 403s are about
      // the scope of the author's authority and not about a broken route.
      expect(
        (await post(retractUrl(), org.adminToken, { ecosystem: "npm", coordinate })).status
      ).toBe(200);
    });

    it("`dryRun` reports the blast radius and writes NOTHING", async () => {
      // The only way a declarer can see WHOSE repositories they are about to affect before they do.
      // A dry run that reported an empty radius would be worse than none, so the positive half is
      // asserted alongside the "nothing was written" half.
      const producer = await createOrphanComponent(server, org, `dry-producer-${uuidv7()}`);
      const consumer = await createOrphanComponent(server, org, `dry-consumer-${uuidv7()}`);
      const coordinate = `@acme/dry-${uuidv7()}`;
      const line = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "1" })
      );
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId: line.id,
          manifestPath: "package.json",
          declaredVersion: "^1.0.0"
        })
      );
      await admin.policies.create({
        name: `dry-sub-${uuidv7()}`,
        properties: {
          scope: { objectRef: consumer.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      });
      await inOrg((tx) =>
        recordDependencyLineHead(
          tx,
          org.orgId,
          {
            lineId: line.id,
            latestVersion: "1.4.0",
            latestDigest: null
          },
          { kind: "third_party" }
        )
      );

      const response = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: producer.id,
        dryRun: true
      });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      expect(response.json.dryRun).toBe(true);
      const lines = response.json.lines as {
        lineId: string;
        headBefore: { latestVersion: string | null };
        headCleared: boolean;
        subscribedComponentObjectIds: string[];
      }[];
      expect(lines).toHaveLength(1);
      expect(lines[0]?.lineId).toBe(line.id);
      // THE UNGUESSABLE HALF: the consumer's id is not in the request anywhere.
      expect(lines[0]?.subscribedComponentObjectIds).toEqual([consumer.id]);
      // ...AND NAMED, server-side (dependency-subscription-ui.md §12.6 Q1, owner 2026-08-18): the
      // report a human confirms before the write names what it reaches. Same set, same order.
      expect(
        (lines[0] as unknown as { subscribedComponents: { objectId: string; name: string }[] })
          .subscribedComponents
      ).toEqual([{ objectId: consumer.id, name: consumer.name }]);
      // ...and WHAT WOULD BE LOST, which is the most consequential thing the verb does.
      expect(lines[0]?.headBefore.latestVersion).toBe("1.4.0");
      expect(lines[0]?.headCleared).toBe(true);
      expect(response.json.decisionId).toBeNull();

      // NO PROJECTED DECLARATION, and the empty string is the reason it went. The dry run used to
      // return a `DependencyLineProducer` with `declaredAt: previous?.declaredAt ?? ""` — and `""`
      // is not a timestamp, not "never", and not a value any client can render or parse as a date.
      // The whole object is `null` now, exactly as a dry-run RETRACT already answers, so "no
      // declaration was created" is STATED rather than approximated with an unfillable field.
      expect(response.json.declaration).toBeNull();

      // NOTHING WAS WRITTEN — neither the declaration nor the head clearing it previewed.
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      ).toBeNull();
      expect(
        (
          await inOrg((tx) =>
            getDependencyLineByKey(tx, org.orgId, { ecosystem: "npm", coordinate, major: "1" })
          )
        )?.latestVersion
      ).toBe("1.4.0");
    });
  });

  // (3) DECLARING CLEARS THE HEAD — the direction that undoes a poisoning

  describe("(3) declaring clears the observed head", () => {
    it("CLEARS a poisoned public head, so the declaration actually undoes the confusion it exists to prevent", async () => {
      // The failure without this: the third-party poll has already written a stranger's `9.9.9` as
      // this line's head. The operator declares the producer to stop the poll — and the poisoned
      // head SURVIVES, because `recordDependencyLineHead` refuses backward movement, so internal
      // detection can never bring the head down to the org's real `2.1.0`. The coordinate is left
      // permanently wedged at a version that exists in no registry of the org's.
      const producer = await createOrphanComponent(server, org, `clear-producer-${uuidv7()}`);
      const coordinate = `@acme/poisoned-${uuidv7()}`;
      const line = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "9" })
      );
      const poisoned = await inOrg((tx) =>
        recordDependencyLineHead(
          tx,
          org.orgId,
          {
            lineId: line.id,
            latestVersion: "9.9.9",
            latestDigest: null
          },
          { kind: "third_party" }
        )
      );
      // FIXTURE READ-BACK: without a head actually stored, "the head was cleared" passes for the
      // wrong reason on a line that never had one.
      expect(poisoned.recorded).toBe(true);

      const response = await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate,
        producerIdOrUrn: producer.id
      });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      const impact = (
        response.json.lines as {
          headBefore: { latestVersion: string | null };
          headCleared: boolean;
        }[]
      )[0];
      expect(impact?.headBefore.latestVersion, "the report must name what was discarded").toBe(
        "9.9.9"
      );
      expect(impact?.headCleared).toBe(true);

      const after = await inOrg((tx) =>
        getDependencyLineByKey(tx, org.orgId, { ecosystem: "npm", coordinate, major: "9" })
      );
      expect(after?.latestVersion).toBeNull();
      expect(after?.latestDigest).toBeNull();
      expect(after?.latestObservedAt).toBeNull();

      // A DECISION AND A `decisionId` accompany the write (principle 6).
      expect(typeof response.json.decisionId).toBe("string");
    });

    /**
     * ONE OPERATOR ACT, ONE DECISION, ONE AUDIT EVENT — persist-on-change does not apply to these
     * verbs, and the audit chain is what proves it must not.
     *
     * THE DEFECT. Both verbs used `insertDecisionIfChanged`, which keys on `(subject_id, kind)`, and
     * the subject here is the PRODUCER — so the comparison asked "is this the last thing this
     * COMPONENT was said to produce?", a question about the wrong noun. Both verbs also append their
     * hash-chained audit event UNCONDITIONALLY, and `insertDecisionIfChanged`'s own header states the
     * rule that makes that combination incoherent: "a caller that pairs the Decision with a
     * hash-chained audit event must suppress that event on the same condition (`created === false`)".
     * The audit event is the one that is right — the operator really did call the verb — so the
     * suppression is what goes, and the counts below are the pairing asserted rather than described.
     *
     * WHY NOT "PUT THE COORDINATE IN THE IDENTITY". The only identity columns are `subject_id` (a
     * `uuid`, and a coordinate is not one) and `kind` — documented in `decisions-repo.ts` as "the
     * caller's own constant, never user input", with an exact-match operator filter and a b-tree over
     * it. And it would not have been sufficient: an identity of `(producer, coordinate)` still finds
     * P's own earlier row for this same coordinate and still compares equal, which is the P -> Q -> P
     * transfer below.
     *
     * MUTATION LOG — each applied, run, reverted:
     * | Mutation | Result |
     * |---|---|
     * | `insertDecision` -> `insertDecisionIfChanged` in both verbs | FAILS at (b): three identical re-declares write 3 audit events and only 2 Decisions ("expected 2 to be 3") |
     * | drop `displacedProducerObjectId` from the declare's `inputContext` | FAILS at (a): "the first declare displaced nobody: expected undefined to be null". It does NOT restore the suppression on its own while `insertDecision` stands — measured, and recorded because the two changes fix different halves: the field makes a transfer READABLE, the removal makes every act RECORDED |
     * | BOTH together — the true pre-fix state | FAILS at (a) on the defect verbatim: the third declare's `decisionId` IS the first declare's row id, so a transfer between two teams is reported as the original declaration |
     */
    it("every declare and retract records its OWN Decision — one per audit event, transfers included", async () => {
      const p = await createOrphanComponent(server, org, `xfer-p-${uuidv7()}`);
      const q = await createOrphanComponent(server, org, `xfer-q-${uuidv7()}`);
      const coordinate = `@acme/transfer-${uuidv7()}`;
      const declareTo = async (producerId: string) => {
        const r = await post(declareUrl(), org.adminToken, {
          ecosystem: "npm",
          coordinate,
          producerIdOrUrn: producerId
        });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        return r.json.decisionId as string;
      };

      const first = await declareTo(p.id);
      await declareTo(q.id);
      const third = await declareTo(p.id);

      // (a) THE TRANSFER. The coordinate came back to P from Q; under the old guard the third act
      // was byte-identical to P's first row and the response handed back that first row's id.
      expect(
        third,
        "a transfer back to P must not be reported as P's original declaration"
      ).not.toBe(first);
      const afterTransfer = await decisionsForSubject(p.id);
      expect(afterTransfer.map((d) => d.id)).toEqual([first, third]);

      // …AND IT IS LEGIBLE AS ONE. Without the displaced producer on the record the two rows differ
      // only by their timestamps, and "who did this coordinate come from" is unanswerable.
      expect(
        (afterTransfer[0]?.inputContext as { displacedProducerObjectId?: unknown })
          .displacedProducerObjectId,
        "the first declare displaced nobody"
      ).toBeNull();
      expect(
        (afterTransfer[1]?.inputContext as { displacedProducerObjectId?: unknown })
          .displacedProducerObjectId,
        "the third declare took the coordinate back from Q"
      ).toBe(q.id);

      // (b) THE PAIRING, which is the half the transfer alone does not pin. Three IDENTICAL
      // re-declares in a row: nothing about the world changes after the first, so this is precisely
      // the sequence persist-on-change was suppressing — while the audit chain recorded all three.
      // A Decision log that is missing an act the audit chain asserts happened is principle 6
      // failing on the quiet side.
      const idempotent = await createOrphanComponent(server, org, `xfer-idem-${uuidv7()}`);
      const idemCoordinate = `@acme/idempotent-${uuidv7()}`;
      for (let i = 0; i < 3; i += 1) {
        const r = await post(declareUrl(), org.adminToken, {
          ecosystem: "npm",
          coordinate: idemCoordinate,
          producerIdOrUrn: idempotent.id
        });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
      }
      const idemDecisions = await decisionsForSubject(idempotent.id);
      const idemAudits = await auditEventsForSubject(idempotent.id, "dependency.producer.declare");
      expect(idemAudits.length, "three calls, three audit events").toBe(3);
      expect(
        idemDecisions.length,
        "…and three Decisions, because the audit chain must not assert an act the Decision log denies"
      ).toBe(3);
      expect(new Set(idemDecisions.map((d) => d.id)).size, "three DISTINCT rows").toBe(3);

      // (c) A RETRACT, THEN AN IDENTICAL RE-DECLARE — four operator acts about P, four Decisions.
      expect(
        (await post(retractUrl(), org.adminToken, { ecosystem: "npm", coordinate })).status
      ).toBe(200);
      const fourth = await declareTo(p.id);
      const finalForP = await decisionsForSubject(p.id);
      expect(finalForP.map((d) => d.id)).toEqual([first, third, expect.any(String), fourth]);
      expect(finalForP[2]?.verdict).toBe("retracted");
    });
  });

  // (4) RETRACTING — the direction that is a SECURITY fix, not a wedge fix

  describe("(4) the retract verb", () => {
    it("CLEARS the internal head, because a stale head is an input to a security gate and not merely a wedge", async () => {
      // TWO reasons, and the second is why this is not cosmetic:
      //   - the WEDGE: the coordinate returns to third-party polling carrying `2.7.0` that the org's
      //     own releases put there, so the poll refuses every real public version until upstream
      //     passes it — and refuses it as `behind_head`, which reads as normal operation.
      //   - the GATE: `latest_version` is an input to the M22 vendor rule, which grants a scan PASS
      //     when a component is on the latest of its major line. A head left over from the internal
      //     era, on a coordinate that is third-party again, can grant a vendor-pass against a
      //     version NO REGISTRY EVER PUBLISHED.
      const producer = await createOrphanComponent(server, org, `retract-producer-${uuidv7()}`);
      const coordinate = `@acme/retract-${uuidv7()}`;
      const line = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "2" })
      );
      expect(
        (
          await post(declareUrl(), org.adminToken, {
            ecosystem: "npm",
            coordinate,
            producerIdOrUrn: producer.id
          })
        ).status
      ).toBe(200);
      // The internal era: a head derived from the org's own release, ahead of anything public.
      const internalHead = await inOrg((tx) =>
        recordDependencyLineHead(
          tx,
          org.orgId,
          {
            lineId: line.id,
            latestVersion: "2.7.0",
            latestDigest: null
          },
          { kind: "internal", producerObjectId: producer.id }
        )
      );
      expect(internalHead.recorded, "the fixture head must have landed").toBe(true);

      const response = await post(retractUrl(), org.adminToken, { ecosystem: "npm", coordinate });
      expect(response.status, JSON.stringify(response.json)).toBe(200);
      expect(response.json.declaration).toBeNull();
      const impact = (
        response.json.lines as {
          headBefore: { latestVersion: string | null };
          headCleared: boolean;
        }[]
      )[0];
      expect(impact?.headBefore.latestVersion).toBe("2.7.0");
      expect(impact?.headCleared).toBe(true);

      const after = await inOrg((tx) =>
        getDependencyLineByKey(tx, org.orgId, { ecosystem: "npm", coordinate, major: "2" })
      );
      expect(after?.latestVersion).toBeNull();

      // THE DECLARATION IS GONE and the line is pollable again — retraction MEANS the coordinate
      // goes back to the public index, so this is the positive half of the same act.
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      ).toBeNull();
      expect(
        (await inOrg((tx) => listThirdPartyDependencyLinesByIds(tx, org.orgId, [line.id]))).length
      ).toBe(1);
    });

    it("REFUSES to retract a coordinate nobody declared, rather than reporting a successful no-op", async () => {
      const response = await post(retractUrl(), org.adminToken, {
        ecosystem: "go",
        coordinate: `github.com/acme/never-declared-${uuidv7()}`
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.json)).toMatch(/nothing to retract/i);
    });
  });

  // (5) NEW MAJOR — the whole reason the grain is the COORDINATE

  describe("(5) a brand-new major of a declared coordinate", () => {
    it("is NOT handed to a public index — the hole per-line grain re-armed at every major bump", async () => {
      // THE FAILURE THIS PINS, in full. X publishes `@acme/lib` and an operator declares it. X then
      // cuts `3.0.0`; the first consumer moves to `^3`; ingestion mints a NEW `dependency_lines` row
      // for major `3`. Under the retired per-line column that row's `produced_by_object_id` is NULL
      // — honestly so, because nobody had re-declared — and `buildLineWorkList` therefore hands
      // `@acme/lib` to a PUBLIC INDEX PLUGIN, where a stranger's package answering `9.9.9` bumps
      // every subscriber onto it. Both barriers built against that read the column, and a column
      // nobody filled in is NULL, so neither fires.
      const producer = await createOrphanComponent(server, org, `major-producer-${uuidv7()}`);
      const consumer = await createOrphanComponent(server, org, `major-consumer-${uuidv7()}`);
      const coordinate = `@acme/newmajor-${uuidv7()}`;

      // Declared while only major `2` exists.
      const majorTwo = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "2" })
      );
      expect(
        (
          await post(declareUrl(), org.adminToken, {
            ecosystem: "npm",
            coordinate,
            producerIdOrUrn: producer.id
          })
        ).status
      ).toBe(200);

      // NOW ingestion mints major `3` — the same call `placeDeclarationOnLine` makes, which is the
      // ONLY thing in the tree that mints a line. NO second declaration is made.
      const majorThree = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "3" })
      );
      expect(majorThree.id).not.toBe(majorTwo.id);

      // The consumer subscribes to the NEW major, which is what puts it in the poll's work-list at
      // all — the work-list IS the subscription resolution, so without this the absence below would
      // be "nobody subscribed", not "the poll refused an internal line".
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId: majorThree.id,
          manifestPath: "package.json",
          declaredVersion: "^3.0.0"
        })
      );
      await admin.policies.create({
        name: `major-sub-${uuidv7()}`,
        properties: {
          scope: { objectRef: consumer.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      });

      const workList = await buildLineWorkList(server.deps.db, org.orgId);
      expect(
        workList.map((w) => w.line.id),
        "a brand-new major of a DECLARED coordinate must never reach the third-party poll"
      ).not.toContain(majorThree.id);

      // NEGATIVE CONTROL, and it is the one that makes the assertion above about the DECLARATION.
      // An identically-shaped, identically-subscribed coordinate that nobody declared IS in the
      // work-list — so the absence is not "the work-list is empty" or "this fixture never applied".
      const undeclared = `@acme/undeclared-${uuidv7()}`;
      const undeclaredLine = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, {
          ecosystem: "npm",
          coordinate: undeclared,
          major: "3"
        })
      );
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId: undeclaredLine.id,
          manifestPath: "package.json",
          declaredVersion: "^3.0.0"
        })
      );
      const withControl = await buildLineWorkList(server.deps.db, org.orgId);
      expect(withControl.map((w) => w.line.id)).toContain(undeclaredLine.id);
      expect(withControl.map((w) => w.line.id)).not.toContain(majorThree.id);
    });

    it("...and an identically-spelled coordinate in ANOTHER ecosystem is still third-party — the join is on the PAIR", async () => {
      // A coordinate carries no ecosystem in itself. Matching the anti-join on `coordinate` alone
      // would let an `npm` declaration silently remove an `oci` line of the same string from the
      // poll — the false-positive direction, whose symptom is an ABSENCE of security updates.
      const producer = await createOrphanComponent(server, org, `pair-producer-${uuidv7()}`);
      const consumer = await createOrphanComponent(server, org, `pair-consumer-${uuidv7()}`);
      const shared = `acme/shared-${uuidv7()}`;

      await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate: shared, major: "1" })
      );
      const ociLine = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "oci", coordinate: shared, major: "1" })
      );
      expect(
        (
          await post(declareUrl(), org.adminToken, {
            ecosystem: "npm",
            coordinate: shared,
            producerIdOrUrn: producer.id
          })
        ).status
      ).toBe(200);

      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId: ociLine.id,
          manifestPath: "Dockerfile",
          declaredVersion: "1.2.3"
        })
      );
      await admin.policies.create({
        name: `pair-sub-${uuidv7()}`,
        properties: {
          scope: { objectRef: consumer.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      });

      const workList = await buildLineWorkList(server.deps.db, org.orgId);
      expect(
        workList.map((w) => w.line.id),
        "the `oci` line shares only the coordinate string; nobody declared it"
      ).toContain(ociLine.id);
    });
  });

  // (6) DECLARED, NEVER INFERRED — an absence, pinned as one

  describe("(6) declared, never inferred", () => {
    it("NO ingestion module can write a producer — a source-level census, because the property is an ABSENCE", async () => {
      // BEHAVIOURAL FIRST. Run the line-minting verb the ingestion path actually calls, over a
      // coordinate whose name is as "internal-looking" as a name can be, and require that no
      // declaration appears.
      const coordinate = `@${org.orgId.slice(0, 8)}-internal/looks-ours-${uuidv7()}`;
      await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "npm", coordinate, major: "1" })
      );
      expect(
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        ),
        "observing a manifest must never conclude a coordinate is ours"
      ).toBeNull();

      // AND A SOURCE-LEVEL CENSUS, because behaviour alone cannot pin an absence in code that does
      // not run in this test. The capability must be MISSING from the ingestion modules rather than
      // guarded inside them: none of them may so much as name the table or the verb.
      //
      // `readFile` with an explicit utf8 read rather than `grep -r`, which was measured in this repo
      // to SILENTLY SKIP files carrying NUL bytes — a census with a hole is worse than none.
      const { readFile } = await import("node:fs/promises");
      const here = new URL(".", import.meta.url);
      const ingestionModules = [
        "../dependencies/inventory-ingestion.ts",
        "../dependencies/inventory-ingestion-loop.ts",
        "../dependencies/manifest-reader.ts",
        "../dependencies/version-poll.ts",
        "../dependencies/version-index.ts",
        "../dependencies/version-index-feed.ts"
      ];
      for (const relative of ingestionModules) {
        const source = await readFile(new URL(relative, here), "utf8");
        expect(
          source.length,
          `${relative} must be readable for this census to mean anything`
        ).toBeGreaterThan(0);
        for (const forbidden of [
          "declareDependencyLineProducer",
          "dependencyLineProducers",
          "dependency_line_producers"
        ]) {
          // A COMMENT mentioning the verb is fine and several do; a CALL is not. The test looks for
          // the symbol outside a comment by stripping comments first, which keeps the census honest
          // without forbidding the explanation.
          const withoutComments = source
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
          expect(
            withoutComments,
            `${relative} must not reach the producer declaration — the capability is ABSENT from ingestion, not guarded in it (ADR-0032 §7)`
          ).not.toContain(forbidden);
        }
      }
    });
  });

  // (7) CAPABILITY, END TO END — the acceptance test that was impossible by construction

  describe("(7) CAPABILITY: an internal release reaches a subscriber's bump candidate", () => {
    it("declare -> real prod release -> internal head -> a subscribed component is a bump candidate", async () => {
      // THIS IS THE TEST THE DEFECT MADE IMPOSSIBLE. Every step below existed and worked; the chain
      // could not START, because nothing in production could declare a producer. Asserting the row
      // exists would prove nothing — the column was always writable.
      //
      // `oci` deliberately: the released version comes from the wave target's `observed.images`, so
      // the chain needs no git provider and the plugin host stays inert.
      const producer = await createOrphanComponent(server, org, `cap-producer-${uuidv7()}`);
      const consumer = await createOrphanComponent(server, org, `cap-consumer-${uuidv7()}`);
      const coordinate = `registry.internal/acme/cap-${uuidv7()}`;

      // (a) THE DECLARATION, through the ROUTE — not the repo function. That is the whole point.
      const declared = await post(declareUrl(), org.adminToken, {
        ecosystem: "oci",
        coordinate,
        producerIdOrUrn: producer.id
      });
      expect(declared.status, JSON.stringify(declared.json)).toBe(200);

      // (b) A CONSUMER that declares the line and is SUBSCRIBED. The derivation refuses to record
      // for a line nobody subscribes to, so this is load-bearing rather than scenery.
      const line = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, { ecosystem: "oci", coordinate, major: "1" })
      );
      await inOrg((tx) =>
        upsertComponentDependency(tx, org.orgId, {
          componentObjectId: consumer.id,
          lineId: line.id,
          manifestPath: "Dockerfile",
          declaredVersion: "1.0.0",
          resolvedVersion: "1.0.0"
        })
      );
      await admin.policies.create({
        name: `cap-sub-${uuidv7()}`,
        properties: {
          scope: { objectRef: consumer.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      });

      // (c) THE REAL RELEASE PATH: the producer placed at a `prod` deployment-target, an accepted
      // change whose wave target SUCCEEDED, carrying the image the release published.
      const changeObjectId = await releaseToProd(producer.id, [`${coordinate}:1.1.0`]);

      // (d) THE REAL DETECTION, the function the loop runs.
      await detectInternalReleases(server.deps.db, org.orgId, { changeObjectId });

      const head = await inOrg((tx) =>
        getDependencyLineByKey(tx, org.orgId, { ecosystem: "oci", coordinate, major: "1" })
      );
      expect(
        head?.latestVersion,
        "the org's own production release must have become this internal line's head"
      ).toBe("1.1.0");

      // (e) AND THE SUBSCRIBER IS A BUMP CANDIDATE. `runBumpDispatchJob` is the exact function the
      // worker runs; the inert host means it stops at the component's missing git binding, which is
      // AFTER the candidate has been derived — so the component's presence in the outcome is proof
      // the fan-out reached it.
      const outcome = await runBumpDispatchJob(
        { db: server.deps.db, host: inertHost, config: server.deps.config },
        { orgId: org.orgId, lineId: line.id }
      );
      const named = [
        ...outcome.dispatched.map((d) => d.componentObjectId),
        ...outcome.skipped.map((s) => s.componentObjectId)
      ];
      expect(named, "the subscribed component must be reached as a bump candidate").toContain(
        consumer.id
      );
      // ...and NOT because the line had no head: that skip reason would mean the chain broke at (d)
      // and this assertion was satisfied by the wrong thing.
      expect(outcome.skipped.find((s) => s.componentObjectId === consumer.id)?.reason).not.toBe(
        "no_head_observed"
      );

      // (f) NEGATIVE CONTROL — RETRACT, release again, and NOTHING is derived. Without this, step
      // (d) could be satisfied by a detection path that ignores the declaration entirely.
      expect(
        (await post(retractUrl(), org.adminToken, { ecosystem: "oci", coordinate })).status
      ).toBe(200);
      const secondChange = await releaseToProd(producer.id, [`${coordinate}:1.2.0`]);
      await detectInternalReleases(server.deps.db, org.orgId, { changeObjectId: secondChange });
      const afterRetract = await inOrg((tx) =>
        getDependencyLineByKey(tx, org.orgId, { ecosystem: "oci", coordinate, major: "1" })
      );
      expect(
        afterRetract?.latestVersion,
        "with no declaration the org's release derives nothing — and the retraction cleared 1.1.0"
      ).toBeNull();
    });
  });

  describe("(8) the list read", () => {
    it("returns this org's declarations, narrows VERBATIM, and carries the dependencyManagement envelope", async () => {
      const producer = await createOrphanComponent(server, org, `list-producer-${uuidv7()}`);
      const scoped = `@acme/List-${uuidv7()}`;
      await post(declareUrl(), org.adminToken, {
        ecosystem: "npm",
        coordinate: scoped,
        producerIdOrUrn: producer.id
      });

      const all = await get(listUrl(), org.adminToken);
      expect(all.status).toBe(200);
      expect((all.json.producers as { coordinate: string }[]).map((p) => p.coordinate)).toContain(
        scoped
      );
      // The envelope is REQUIRED: on a field outpost the list is empty BY DESIGN, and an unqualified
      // empty list reads as "nothing is declared" when the truth is "you asked the wrong deployment".
      expect((all.json.dependencyManagement as { managedHere: boolean }).managedHere).toBe(true);

      const exact = await get(listUrl({ ecosystem: "npm", coordinate: scoped }), org.adminToken);
      expect((exact.json.producers as unknown[]).length).toBe(1);
      // NAMED rows (the wire view, §12.6 Q1): producer and declarer by name, ids beside them. One
      // batched `objects` read serves the whole list; a client never pays N+1 reads it may not be
      // authorized to make (a user object is readable by few).
      const row = (
        exact.json.producers as {
          producerObjectId: string;
          declaredByObjectId: string;
          producer: { objectId: string; name: string };
          declaredBy: { objectId: string; name: string };
        }[]
      )[0]!;
      expect(row.producer).toEqual({ objectId: producer.id, name: producer.name });
      expect(row.declaredBy.objectId).toBe(row.declaredByObjectId);
      expect(row.declaredBy.name).not.toBe("");

      // VERBATIM, not slugified: `@acme/List-x` and `acme-list-x` share a URN slug and must not
      // share an answer.
      const lowered = await get(
        listUrl({ ecosystem: "npm", coordinate: scoped.toLowerCase() }),
        org.adminToken
      );
      expect((lowered.json.producers as unknown[]).length).toBe(0);

      // The declarations really are in the table this asserts about, read through the repo — so a
      // route that fabricated a response would not satisfy the case above.
      const stored = await inOrg((tx) =>
        listDependencyLineProducers(tx, org.orgId, { ecosystem: "npm", coordinate: scoped })
      );
      expect(stored).toHaveLength(1);
    });
  });

  const placedPairs = new Set<string>();

  /**
   * A component placed at the prod target, released there by a change whose wave target reached
   * `succeeded`, then put into `accepted` — the exact coordination state `internal-release-detection`
   * reconstructs a release from.
   *
   * The plan is compiled directly rather than waited for from the reconcile loop, the same shortcut
   * `internal-release-detection.integration.test.ts` takes: compilation is what writes the
   * `change_wave_targets` rows the derivation reads, and the loop's own job is covered elsewhere.
   *
   * EVERY FIXTURE HALF IS READ BACK. A fixture that did not apply turns the absence assertion in
   * (7)(f) into a tautology.
   */
  async function releaseToProd(
    componentObjectId: string,
    observedImages: string[]
  ): Promise<string> {
    const pairKey = `${componentObjectId}::${prodTarget}`;
    if (!placedPairs.has(pairKey)) {
      await admin.placements.create({
        component: componentObjectId,
        deploymentTarget: prodTarget
      });
      placedPairs.add(pairKey);
    }
    const topo = await admin.object("release-topology").create({
      name: `topo-${uuidv7()}`,
      properties: { waves: [{ name: "wave", mode: "parallel", targets: [prodTarget] }] }
    });
    const change = await admin.changes.propose({
      name: `rel-${uuidv7()}`,
      targets: [componentObjectId]
    });
    const plan = await inOrg((tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: [componentObjectId],
        topologyObjectId: topo.id,
        topologyVersion: null
      })
    );
    const rowIds = plan.waves.flatMap((w) => w.targets.map((t) => t.id));
    expect(rowIds.length, "the plan must have compiled exactly one wave target").toBe(1);

    // Written through `withTenantTx`: `deps.db` alone carries NO org context and both tables are
    // under `org_isolation`, so an update on the bare pool matches zero rows and says so nowhere.
    await inOrg(async (tx) => {
      await tx
        .update(changeWaveTargets)
        .set({ status: "succeeded", observedState: { images: observedImages } })
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            inArray(changeWaveTargets.id, rowIds as string[])
          )
        );
      await tx
        .update(changes)
        .set({ state: "accepted" })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)));
    });

    const [row] = await inOrg((tx) =>
      tx
        .select({ state: changes.state })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    expect(row?.state, "the change fixture must have taken").toBe("accepted");
    const [waveRow] = await inOrg((tx) =>
      tx
        .select({ status: changeWaveTargets.status, observed: changeWaveTargets.observedState })
        .from(changeWaveTargets)
        .where(
          and(
            eq(changeWaveTargets.orgId, org.orgId),
            inArray(changeWaveTargets.id, rowIds as string[])
          )
        )
    );
    expect(waveRow?.status, "the wave-target fixture must have taken").toBe("succeeded");
    expect(
      (waveRow?.observed as { images?: string[] } | null)?.images,
      "the observed images fixture must have taken"
    ).toEqual(observedImages);

    // The prod target really is prod — `environment` is a deployment-target PROPERTY, not a table,
    // so a typo here would make (7) pass or fail on the wrong thing.
    const [target] = await inOrg((tx) =>
      tx
        .select({ properties: objects.properties })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, prodTarget)))
    );
    expect((target?.properties as { environment?: string })?.environment).toBe("prod");
    return change.id;
  }
});

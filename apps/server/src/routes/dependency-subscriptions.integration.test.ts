import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { DependencyLineKey, DependencySubscriptionContribution } from "@scp/schemas";
import type { ReadFileAtRefResult } from "@scp/git-provider-core";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createSourceMapping } from "../coordination/source-mappings-repo.js";
import { upsertExecutorBinding } from "../coordination/executor-bindings-repo.js";
import type { GitFileReadPluginClient, PluginHost } from "../plugin-host/contract.js";

/**
 * M21.3 — THE ENABLEMENT CHAIN'S API SURFACE (ADR-0032 §3a/§6, routes/dependency-subscriptions.ts).
 *
 * The merge itself is proven pure in `dependencies/subscription-resolution.test.ts` and against real
 * Postgres in `dependencies/subscription-resolution.integration.test.ts`. THIS file proves only the
 * things that live in the route layer and nowhere else:
 *
 *   1. THE OPERATOR WRITE IS OPERATOR-ONLY. A perfectly valid TENANT token — the org's bootstrap
 *      ADMIN, the most privileged principal an org has — is REFUSED, and the NEGATIVE CONTROL is
 *      that the identical request carrying the deployment operator token SUCCEEDS. Without that
 *      control a 403 proves only that the route is broken.
 *   2. THE READS ARE TENANT-FACING, and the unlock read is the SAME projection the write returns —
 *      including `updatedAt: null` for the never-set (locked) default, which is the state a
 *      deployment ships in.
 *   3. THE RESOLUTION SURFACE CARRIES ITS CONTRIBUTIONS, and they identify WHICH TIER turned an
 *      enablement off (charter principle 6). That is the entire reason `contributions` exists, so it
 *      is asserted through the API rather than only at the resolver.
 *   4. READING A COMPONENT'S ENABLEMENT IS READING THE COMPONENT — `object:read` at the component's
 *      scope, with a narrowly-bound user as the negative control.
 *
 * A subscription is authored here the ONLY way it can be — as a `dependencySubscription` effect on
 * an ordinary `policy` object through the EXISTING policy routes (ADR-0032 §3a). If a bespoke
 * subscription write path is ever added, these tests keep passing and the reviewer should ask why it
 * was needed.
 *
 * INSTANCE-GLOBAL FIXTURE. `dependency_subscription_unlock` has no `org_id` and the integration
 * suite runs `singleFork` against ONE shared Postgres, so the row is deleted at teardown no matter
 * how this file exits.
 */
describe("M21.3 dependency-subscription API (ADR-0032 §6)", () => {
  const OPERATOR_TOKEN = "m21-3-operator-token";

  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let componentId: string;

  /** The unlock's URL — spelled once, so a rename cannot silently make a test hit nothing.
   *  `server.baseUrl` already ends in `/api/v1` (harness.ts:270). */
  const UNLOCK_URL = () => `${server.baseUrl}/instance/dependency-subscription-unlock`;

  const resolveUrl = (component: string, line: Record<string, string>) =>
    `${server.baseUrl}/components/${component}/dependency-subscription?${new URLSearchParams(line).toString()}`;

  /** A raw HTTP PUT of the unlock, so the operator header can be OMITTED entirely — which is what a
   *  tenant client actually sends, and which the SDK's `setUnlock` cannot express (it requires one). */
  async function putUnlock(
    token: string,
    body: Record<string, unknown>,
    operatorToken?: string
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(UNLOCK_URL(), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(operatorToken !== undefined ? { "x-scp-operator-token": operatorToken } : {})
      },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function getUnlock(
    token: string
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(UNLOCK_URL(), { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** Deletes the instance singleton — the deployment's shipped state (no row = locked). */
  async function clearUnlock(): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
    } finally {
      await pool.end();
    }
  }

  /** A policy carrying ONLY a `dependencySubscription` effect — the whole authoring surface. */
  async function subscriptionPolicy(
    name: string,
    scopeObjectId: string,
    effect: Record<string, unknown>
  ): Promise<void> {
    await admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ dependencySubscription: effect }]
      }
    });
  }

  const line: DependencyLineKey = { ecosystem: "npm", coordinate: "@acme/lib", major: "1" };

  beforeAll(async () => {
    // `withPluginHost` because the M21.2 backfill route fail-closes on `deps.pluginHost` — reading a
    // dependency manifest is a live plugin call, exactly as `POST /discovery/run` is. No
    // reconcile loop: nothing here needs one, and it would be a live competitor for queued work.
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN, withPluginHost: true });
    org = await createTestOrg(server, "dep-sub-api");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    componentId = (await createOrphanComponent(admin, `dep-sub-api-${uuidv7()}`)).id;
    await clearUnlock();
  });

  afterAll(async () => {
    await clearUnlock().catch(() => undefined);
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (1) The operator write — the whole reason this resource is split in two
  // -----------------------------------------------------------------------------------------

  describe("(1) PUT the instance unlock is OPERATOR-only", () => {
    it("REFUSES the org's bootstrap admin with no operator token — negative control: the SAME request with the operator token succeeds", async () => {
      await clearUnlock();

      // The most privileged principal an ORG has, presenting a valid session, is still not an
      // OPERATOR: the unlock binds every org on the deployment, so no tenant role can grant it.
      const refused = await putUnlock(org.adminToken, { unlocked: true });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.json)).toMatch(/operator token/i);

      // …and a WRONG operator token is refused too, so the 403 above is not merely "header absent".
      const wrongToken = await putUnlock(org.adminToken, { unlocked: true }, "not-the-token");
      expect(wrongToken.status).toBe(403);

      // THE REFUSAL WAS REAL, not a no-op that also happened to 403: nothing was written.
      expect((await getUnlock(org.adminToken)).json.unlocked).toBe(false);

      // NEGATIVE CONTROL — the identical body WITH the deployment operator token is accepted. Without
      // this the two 403s above would be satisfied by a route that refuses everything.
      const accepted = await putUnlock(org.adminToken, { unlocked: true }, OPERATOR_TOKEN);
      expect(accepted.status).toBe(200);
      expect(accepted.json.unlocked).toBe(true);
    });

    it("REFUSES an unauthenticated caller even WITH the operator token — the token is not a login", async () => {
      const response = await fetch(UNLOCK_URL(), {
        method: "PUT",
        headers: { "content-type": "application/json", "x-scp-operator-token": OPERATOR_TOKEN },
        body: JSON.stringify({ unlocked: true })
      });
      expect(response.status).toBe(401);
    });

    it("REQUIRES `unlocked` — an omitted flag is a 400, never a silent lock", async () => {
      // Absent never means enabled (ADR-0032 §6) — but a PUT that silently LOCKED a deployment
      // because a field name was misspelled is the same failure in the other direction.
      const response = await putUnlock(org.adminToken, { note: "no flag" }, OPERATOR_TOKEN);
      expect(response.status).toBe(400);

      // NEGATIVE CONTROL: the same body WITH the flag is accepted, so the 400 is about `unlocked`
      // and not about the route rejecting every body.
      const ok = await putUnlock(
        org.adminToken,
        { unlocked: false, note: "no flag" },
        OPERATOR_TOKEN
      );
      expect(ok.status).toBe(200);
      expect(ok.json.unlocked).toBe(false);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (2) The tenant read of the unlock
  // -----------------------------------------------------------------------------------------

  describe("(2) GET the instance unlock is tenant-readable", () => {
    it("reads the never-set default as LOCKED with a NULL `updatedAt` — negative control: a written row carries a timestamp", async () => {
      await clearUnlock();
      const shipped = await getUnlock(org.adminToken);
      expect(shipped.status).toBe(200);
      expect(shipped.json.unlocked).toBe(false);
      // NEVER SET, not "re-locked". Flattening these two into one boolean is exactly what
      // `updatedAt` exists to prevent.
      expect(shipped.json.updatedAt).toBeNull();
      expect(shipped.json.source).toBe("instance:dependency_subscription_unlock");

      // NEGATIVE CONTROL: a deliberately-locked deployment reads `false` too, but WITH a timestamp —
      // so the null above is about the missing row, not about `updatedAt` never being populated.
      const relocked = await putUnlock(
        org.adminToken,
        { unlocked: false, note: "deliberately off" },
        OPERATOR_TOKEN
      );
      expect(relocked.status).toBe(200);
      const read = await getUnlock(org.adminToken);
      expect(read.json.unlocked).toBe(false);
      expect(read.json.updatedAt).not.toBeNull();
      expect(read.json.note).toBe("deliberately off");
    });

    it("is readable by a NON-admin tenant principal — an inert subscription must be explainable", async () => {
      // Only a `self`-scoped Viewer: it can read nothing of the org's graph. The unlock is still
      // readable, because a team whose subscription is inert because the DEPLOYMENT never opened
      // the feature has otherwise been handed an unexplainable verdict (charter principle 6).
      const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
      const response = await getUnlock(viewer.token);
      expect(response.status).toBe(200);
      expect(typeof response.json.unlocked).toBe("boolean");
    });
  });

  // -----------------------------------------------------------------------------------------
  // (3) The resolution surface — the explainability payload
  // -----------------------------------------------------------------------------------------

  describe("(3) GET the (component, line) resolution", () => {
    const tiersThatTurnedItOff = (contributions: DependencySubscriptionContribution[]) =>
      contributions.filter((c) => c.contributed === "lock" || c.contributed === "disable");

    it("names the LOCKED INSTANCE as the level that turned it off, and stops naming it once unlocked", async () => {
      await clearUnlock();
      await subscriptionPolicy(`enable-${uuidv7()}`, componentId, { enabled: true });

      const locked = await admin.dependencySubscriptions.resolve(componentId, line);
      expect(locked.resolution.enabled).toBe(false);
      expect(locked.resolution.reason).toBe("instance_locked");
      // WHICH LEVEL TURNED THIS OFF — answerable from the response alone (principle 6).
      expect(tiersThatTurnedItOff(locked.resolution.contributions).map((c) => c.tier)).toEqual([
        "instance"
      ]);
      // The component's own enable is REPORTED even though the verdict is off, so the reader can
      // see that the only missing conjunct is the deployment's.
      expect(
        locked.resolution.contributions.some(
          (c) => c.tier === "component" && c.contributed === "enable"
        )
      ).toBe(true);

      // NEGATIVE CONTROL for the whole assertion above: unlock the deployment and the same
      // (component, line) resolves ENABLED, with nothing left turning it off.
      expect((await putUnlock(org.adminToken, { unlocked: true }, OPERATOR_TOKEN)).status).toBe(
        200
      );
      const unlocked = await admin.dependencySubscriptions.resolve(componentId, line);
      expect(unlocked.resolution.enabled).toBe(true);
      expect(unlocked.resolution.reason).toBe("enabled");
      expect(tiersThatTurnedItOff(unlocked.resolution.contributions)).toEqual([]);
      // The most restrictive settings are what an enable with no declaration resolves to — absent is
      // never the looser option, and auto-merge is never reached by omission (ADR-0032 §8).
      expect(unlocked.resolution.granularity).toBe("patch");
      expect(unlocked.resolution.delivery).toBe("pull_request");
    });

    it("echoes the coordinate VERBATIM and resolves the slug-colliding spelling separately", async () => {
      expect((await putUnlock(org.adminToken, { unlocked: true }, OPERATOR_TOKEN)).status).toBe(
        200
      );
      // `graph/urn.ts` collapses `@acme/lib` and `acme-lib` into ONE slug. The enable above carries
      // no `coordinate` selector, so BOTH are enabled — the point here is that the response reports
      // the bytes that were asked about, so an operator can see which one they actually named.
      const collided = await admin.dependencySubscriptions.resolve(componentId, {
        ecosystem: "npm",
        coordinate: "acme-lib",
        major: "1"
      });
      expect(collided.line.coordinate).toBe("acme-lib");
      const scoped = await admin.dependencySubscriptions.resolve(componentId, line);
      expect(scoped.line.coordinate).toBe("@acme/lib");
    });

    it("400s on a line key the shared schema refuses — negative control: the valid key resolves", async () => {
      const bad = await fetch(
        resolveUrl(componentId, { ecosystem: "nmp", coordinate: "@acme/lib", major: "1" }),
        { headers: { authorization: `Bearer ${org.adminToken}` } }
      );
      expect(bad.status).toBe(400);

      const good = await fetch(resolveUrl(componentId, line), {
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(good.status).toBe(200);
    });

    it("resolves a line the component does NOT declare — it answers ENABLEMENT, not declaration", async () => {
      expect((await putUnlock(org.adminToken, { unlocked: true }, OPERATOR_TOKEN)).status).toBe(
        200
      );
      const undeclared = await admin.dependencySubscriptions.resolve(componentId, {
        ecosystem: "go",
        coordinate: "github.com/never/declared",
        major: "v2"
      });
      // 200, not 404: the wildcard enable covers every ecosystem, so this is a real answer about a
      // dependency the team is about to add — which is when the question is most worth asking.
      expect(undeclared.resolution.enabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (4) Reading a component's enablement is reading the component
  // -----------------------------------------------------------------------------------------

  describe("(4) the resolution read is authorized at the component", () => {
    it("REFUSES a principal with no read on the component — negative control: the admin reads it", async () => {
      const stranger = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
      const refused = await fetch(resolveUrl(componentId, line), {
        headers: { authorization: `Bearer ${stranger.token}` }
      });
      expect(refused.status).toBe(403);

      // NEGATIVE CONTROL: the same URL, the same instant, with a principal that DOES hold
      // `object:read` at the component — so the 403 is about the subject, not about the route.
      const allowed = await fetch(resolveUrl(componentId, line), {
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(allowed.status).toBe(200);
    });

    it("404s on a component that does not exist", async () => {
      const response = await fetch(resolveUrl(uuidv7(), line), {
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(response.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------------------------
  // (5) M21.2 — THE INVENTORY BACKFILL ROUTE (ADR-0032 §4)
  //
  // Ingestion is event-driven, so this route is how an EXISTING estate — and any component that has
  // not released since being enabled — acquires an inventory at all. The behaviour of the ingestion
  // itself is proven against a recording provider in
  // `dependencies/inventory-ingestion.integration.test.ts`; what is proven HERE is that the route
  // reaches it, authorizes it as a write, and does not weaken the enablement gate on the way.
  // -----------------------------------------------------------------------------------------

  describe("(5) POST /dependencies/inventory/backfill", () => {
    it("REFUSES a principal with no object:write — negative control: the admin is accepted", async () => {
      const stranger = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
      const refused = await fetch(`${server.baseUrl}/dependencies/inventory/backfill`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${stranger.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ componentIdsOrUrns: [componentId] })
      });
      expect(refused.status).toBe(403);

      const allowed = await fetch(`${server.baseUrl}/dependencies/inventory/backfill`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${org.adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ componentIdsOrUrns: [componentId] })
      });
      expect(allowed.status).toBe(200);
    });

    it("404s on a component that does not exist rather than reporting `0 ingested`", async () => {
      // An operator who named a component must not be told nothing happened when the NAME was wrong.
      const response = await fetch(`${server.baseUrl}/dependencies/inventory/backfill`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${org.adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ componentIdsOrUrns: [uuidv7()] })
      });
      expect(response.status).toBe(404);
    });

    it("reports every component INCLUDING the refusals, and fetches nothing for an unenabled one", async () => {
      await clearUnlock();
      const response = await admin.dependencySubscriptions.backfillInventory({
        componentIdsOrUrns: [componentId]
      });
      // The deployment is LOCKED, so the chain's first conjunct closes the gate.
      expect(response.ref).toBe("HEAD");
      expect(response.components).toHaveLength(1);
      expect(response.components[0]).toMatchObject({
        componentObjectId: componentId,
        verdict: "not_enabled",
        // THE RECEIPT: zero provider reads. The route cannot pass a flag that skips the gate,
        // because there is none.
        reads: 0,
        manifestsIngested: 0
      });
      expect(response.notEnabled).toBe(1);
      expect(response.ingested).toBe(0);
    });

    it("echoes the ref it was asked for, so the answer is self-describing", async () => {
      const response = await admin.dependencySubscriptions.backfillInventory({
        componentIdsOrUrns: [componentId],
        ref: "refs/heads/release-1"
      });
      expect(response.ref).toBe("refs/heads/release-1");
    });

    // ---------------------------------------------------------------------------------------
    // THE SUCCESS PATH — never driven before, so the whole projection below was unexercised
    // ---------------------------------------------------------------------------------------
    describe("a run that actually reads manifests", () => {
      const BACKFILL_REPO = "acme/backfill";
      /** Swapped onto `deps.pluginHost` for these tests only: the route resolves the host per
       *  request, so this is the seam that lets a backfill actually read a file. */
      let bodies: Record<string, string> = {};

      function fakeHost(): PluginHost {
        const notWired = (): never => {
          throw new Error("this fixture only wires gitFileRead()");
        };
        return {
          async start() {},
          async stop() {},
          async stopInstances() {},
          executor: notWired,
          control: notWired,
          discovery: notWired,
          notification: notWired,
          federationTransport: notWired,
          dependencyIndex: notWired,
          gitFileRead(): GitFileReadPluginClient {
            return {
              readFileAtRef: async (request): Promise<ReadFileAtRefResult> => {
                const body = bodies[request.path];
                if (body === undefined) {
                  return {
                    outcome: "not_found",
                    missing: "path",
                    path: request.path,
                    requestedRef: request.ref
                  };
                }
                return {
                  outcome: "found",
                  path: request.path,
                  requestedRef: request.ref,
                  commitSha: "f".repeat(40),
                  content: body,
                  sizeBytes: Buffer.byteLength(body, "utf8")
                };
              }
            };
          }
        };
      }

      let realHost: PluginHost | undefined;
      let backfillComponent = "";

      beforeAll(async () => {
        realHost = server.deps.pluginHost;
        server.deps.pluginHost = fakeHost();
        await putUnlock(
          org.adminToken,
          { unlocked: true, note: "M21.2 backfill fixture" },
          OPERATOR_TOKEN
        );
        const component = await createOrphanComponent(admin, `backfill-${uuidv7()}`);
        backfillComponent = component.id;
        await withTenantTx(server.deps.db, org.orgId, async (tx) => {
          await createSourceMapping(tx, {
            orgId: org.orgId,
            sourceKind: "github",
            repoPattern: BACKFILL_REPO,
            componentIdOrUrn: component.id,
            type: "configuration"
          });
          await upsertExecutorBinding(tx, {
            orgId: org.orgId,
            targetObjectId: component.id,
            pluginModule: "github",
            pluginInstanceId: `gh-${uuidv7()}`,
            config: { appId: "1", installationId: "2", owner: "acme", repo: "backfill" }
          });
        });
        await subscriptionPolicy(`backfill-enable-${uuidv7()}`, component.id, {
          enabled: true
        });
      });

      afterAll(async () => {
        server.deps.pluginHost = realHost;
        await clearUnlock().catch(() => undefined);
      });

      it("REPORTS THE DESTRUCTIVE HALF — a run that deleted an inventory is not identical to a clean one", async () => {
        // The receipt used to project only what was ADDED, so a run that emptied a component's
        // whole inventory reported `verdict: "ingested"` and looked exactly like a no-op. An
        // operator backfilling at the wrong ref had no signal at all.
        bodies = { "package.json": JSON.stringify({ dependencies: { "@acme/lib": "^1.2.3" } }) };
        const seeded = await admin.dependencySubscriptions.backfillInventory({
          componentIdsOrUrns: [backfillComponent]
        });
        expect(seeded.components[0]).toMatchObject({
          verdict: "ingested",
          manifestsIngested: 1,
          declarationsRecorded: 1,
          // A CLEAN run reports zero — which is what makes the non-zero below meaningful.
          declarationsPruned: 0,
          manifestsRemoved: 0
        });
        expect(seeded.declarationsPruned).toBe(0);
        expect(seeded.ingested).toBe(1);

        // Now the same backfill at a ref where the manifest is not there at all.
        bodies = {};
        const destructive = await admin.dependencySubscriptions.backfillInventory({
          componentIdsOrUrns: [backfillComponent]
        });
        expect(destructive.components[0]).toMatchObject({
          verdict: "ingested",
          declarationsPruned: 1,
          manifestsRemoved: 1
        });
        expect(destructive.declarationsPruned).toBe(1);
      });

      it("BOUNDS the live provider I/O one request performs, and says what it did not reach", async () => {
        // With no `componentIdsOrUrns` this walks every component in the org inline, at up to 40
        // live git reads each — one HTTP request holding an unbounded number of round trips against
        // a user's provider, with a client that timed out long ago.
        bodies = { "package.json": JSON.stringify({ dependencies: { "@acme/lib": "^1.2.3" } }) };
        const second = await createOrphanComponent(admin, `backfill-2nd-${uuidv7()}`);
        await withTenantTx(server.deps.db, org.orgId, async (tx) => {
          await createSourceMapping(tx, {
            orgId: org.orgId,
            sourceKind: "github",
            repoPattern: BACKFILL_REPO,
            componentIdOrUrn: second.id,
            type: "configuration"
          });
          await upsertExecutorBinding(tx, {
            orgId: org.orgId,
            targetObjectId: second.id,
            pluginModule: "github",
            pluginInstanceId: `gh-${uuidv7()}`,
            config: { appId: "1", installationId: "2", owner: "acme", repo: "backfill" }
          });
        });
        await subscriptionPolicy(`backfill-enable2-${uuidv7()}`, second.id, {
          enabled: true
        });

        const response = await admin.dependencySubscriptions.backfillInventory({
          componentIdsOrUrns: [backfillComponent, second.id],
          fetchBudget: 1
        });
        expect(response.notAttempted).toBe(1);
        const unattempted = response.components.find((c) => c.verdict === "not_attempted");
        expect(unattempted?.reads).toBe(0);
        // NEGATIVE CONTROL: the budget bounded the run rather than breaking it — the first
        // component was fully ingested.
        expect(response.ingested).toBe(1);
        expect(response.components.find((c) => c.verdict === "ingested")?.reads).toBeGreaterThan(0);
      });
    });
  });
});

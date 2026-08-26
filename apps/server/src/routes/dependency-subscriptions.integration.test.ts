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
import { findIngestionStampByComponent } from "../dependencies/ingestion-stamp-repo.js";
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
    //
    // `federationRole: "commander"` because the backfill is COMMANDER-ONLY and fail-closed on an
    // UNDECLARED deployment (ADR-0032 §7d). The harness leaves `SCP_FEDERATION_ROLE` unset by
    // default, which yields a DEFAULTED commander — `federationRoleDeclared: false` — under which
    // every backfill below would answer 409. Setting it here DECLARES the posture these tests mean
    // to exercise; the refusals get their own servers in the block after "(5)".
    server = await listenTestServer({
      operatorToken: OPERATOR_TOKEN,
      withPluginHost: true,
      federationRole: "commander"
    });
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

    it("QUALIFIES the verdict with `dependencyManagement` — a declared commander says it manages them HERE", async () => {
      // The POSITIVE half of the envelope (ADR-0032 §7d). This server declares
      // `SCP_FEDERATION_ROLE=commander`, so the verdict beside it is one something will actually act
      // on. Block (7) is the negative control: the same field on three deployments where nothing
      // ever will.
      expect(server.deps.config.federationRole).toBe("commander");
      expect(server.deps.config.federationRoleDeclared).toBe(true);
      const resolved = await admin.dependencySubscriptions.resolve(componentId, line);
      expect(resolved.dependencyManagement).toEqual({ managedHere: true, reason: "commander" });
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
            config: { appId: "1", installationId: "2", owner: "acme", repo: "backfill" },
            actorObjectId: org.orgId,
            requestId: "test-setup"
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

      it("STAMPS ITS OWN PRODUCER — a backfill's receipt says `backfill`, not `loop`", async () => {
        // WHY THIS TEST EXISTS: `source` answers "is this component's inventory maintained by its
        // own releases, or is it only as fresh as the last time an operator ran a backfill?" — two
        // very different readings of one timestamp. Nothing pinned the route's half of it: every
        // test that asserted `backfill` passed the literal into `ingestComponentManifests` itself,
        // so swapping THIS route's label to `"loop"` left all 17 tests in this file and the whole
        // ingestion suite green (measured). A provenance label is only worth having if a mislabel
        // is loud.
        bodies = { "package.json": JSON.stringify({ dependencies: { "@acme/lib": "^1.2.3" } }) };
        const target = await createOrphanComponent(admin, `backfill-stamp-${uuidv7()}`);
        await withTenantTx(server.deps.db, org.orgId, async (tx) => {
          await createSourceMapping(tx, {
            orgId: org.orgId,
            sourceKind: "github",
            repoPattern: BACKFILL_REPO,
            componentIdOrUrn: target.id,
            type: "configuration"
          });
          await upsertExecutorBinding(tx, {
            orgId: org.orgId,
            targetObjectId: target.id,
            pluginModule: "github",
            pluginInstanceId: `gh-${uuidv7()}`,
            config: { appId: "1", installationId: "2", owner: "acme", repo: "backfill" },
            actorObjectId: org.orgId,
            requestId: "test-setup"
          });
        });
        await subscriptionPolicy(`backfill-enable-stamp-${uuidv7()}`, target.id, { enabled: true });

        const response = await admin.dependencySubscriptions.backfillInventory({
          componentIdsOrUrns: [target.id]
        });
        expect(response.components[0]).toMatchObject({ verdict: "ingested" });

        const stamp = await withTenantTx(server.deps.db, org.orgId, (tx) =>
          findIngestionStampByComponent(tx, org.orgId, target.id)
        );
        // The route is the ONLY producer that ran here — nothing in this file calls the ingestion
        // directly — so this value can only have come from `routes/dependency-subscriptions.ts`.
        expect(stamp?.source).toBe("backfill");
        // Beside it, the evidence that this is the pass that actually wrote the inventory: a source
        // label asserted on an empty receipt would pin wording rather than behaviour.
        expect(stamp?.outcome).toBe("ok");
        expect(stamp?.rowsWritten).toBe(1);
        expect(stamp?.manifests.map((m) => [m.repo, m.path])).toEqual([
          [BACKFILL_REPO, "package.json"]
        ]);
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
            config: { appId: "1", installationId: "2", owner: "acme", repo: "backfill" },
            actorObjectId: org.orgId,
            requestId: "test-setup"
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

/**
 * ================================================================================================
 * (6) THE BACKFILL IS COMMANDER-ONLY, AND THE ROUTE IS NOT THE DOOR AROUND THE JOBS' GUARD
 * ================================================================================================
 * ADR-0032 §7d (owner decision, 2026-08-17): all dependency automation runs on the commander only.
 * The event-driven ingestion loop is guarded, and this route performs THE SAME INGESTION on demand
 * — so an unguarded route would let an outpost rebuild the identical inventory by POSTing, and the
 * loop's guard would be decorative.
 *
 * A SEPARATE SERVER PER POSTURE, deliberately. `federationRole`/`federationRoleDeclared` are
 * install-time config read from the environment at boot, so they cannot be toggled on the shared
 * fixture without lying about how the value is produced. Each block below boots the deployment
 * shape it is about, which is also what makes the UNDECLARED case reachable at all: it is the
 * harness's own default, and it is the branch that would otherwise never be executed by anything.
 *
 * WHAT IS ASSERTED IS THE SPECIFIC VIOLATION, not a status code alone: a 409 that came from some
 * other conflict would satisfy `status === 409`, so each case also requires the refusal to name the
 * axis that refused and where the work belongs.
 */
describe("(6) POST /dependencies/inventory/backfill is COMMANDER-ONLY (ADR-0032 §7d)", () => {
  /** Calls the route over real HTTP and returns the status plus the RFC7807 detail. The SDK is not
   *  used here because it throws on a non-2xx and the body is the thing under test. */
  async function backfill(
    target: ListeningTestServer,
    token: string
  ): Promise<{ status: number; detail: string }> {
    const response = await fetch(`${target.baseUrl}/dependencies/inventory/backfill`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    return { status: response.status, detail: body.detail ?? "" };
  }

  describe("an explicitly declared OUTPOST", () => {
    let outpost: ListeningTestServer;
    let outpostOrg: TestOrg;

    beforeAll(async () => {
      outpost = await listenTestServer({ withPluginHost: true, federationRole: "outpost" });
      outpostOrg = await createTestOrg(outpost, "dep-backfill-outpost");
    }, 120_000);

    afterAll(async () => {
      await outpost?.close();
    });

    it("REFUSES with 409, names the role, and says to run it on the commander", async () => {
      const { status, detail } = await backfill(outpost, outpostOrg.adminToken);
      // 409 rather than 403: the caller is the org's bootstrap ADMIN and is entirely entitled —
      // what is wrong is the DEPLOYMENT, which is a conflict with this instance's state.
      expect(status).toBe(409);
      expect(detail).toContain("outpost");
      expect(detail).toMatch(/COMMANDER-ONLY/);
      expect(detail).toMatch(/RUN IT ON THE COMMANDER/);
    });

    it("REFUSES THE ORG ADMIN, which is the proof it is not an authorization check", async () => {
      // The negative control for the status choice itself. This principal holds `object:write` at
      // the org scope — the exact permission the handler authorizes — so a 403 here would send an
      // operator to grant a role that is already granted. The same token succeeds against the
      // declared-commander server in block (5).
      const { status } = await backfill(outpost, outpostOrg.adminToken);
      expect(status).not.toBe(403);
      expect(status).toBe(409);
    });
  });

  describe("a deployment that never DECLARED its federation role (the fail-closed branch)", () => {
    let undeclared: ListeningTestServer;
    let undeclaredOrg: TestOrg;

    beforeAll(async () => {
      // NO `federationRole` — exactly what `loadConfig` sees with `SCP_FEDERATION_ROLE` unset, which
      // is what a pre-M16.3 install and a chart that omits the value both produce. `config.
      // federationRole` therefore READS 'commander' here; only `federationRoleDeclared` separates
      // this from the accepted case, which is why a guard testing the value alone is fail-OPEN for
      // exactly the population most likely to be an outpost.
      undeclared = await listenTestServer({ withPluginHost: true });
      undeclaredOrg = await createTestOrg(undeclared, "dep-backfill-undeclared");
    }, 120_000);

    afterAll(async () => {
      await undeclared?.close();
    });

    it("REFUSES with 409 even though `federationRole` reads 'commander'", async () => {
      expect(undeclared.deps.config.federationRole).toBe("commander");
      expect(undeclared.deps.config.federationRoleDeclared).toBe(false);
      const { status, detail } = await backfill(undeclared, undeclaredOrg.adminToken);
      expect(status).toBe(409);
      expect(detail).toMatch(/not declared/);
      // The REMEDY has to be in the line, or an operator running a genuine commander cannot turn
      // it back on from the log alone.
      expect(detail).toMatch(/federationRole/);
    });

    it("is refused BEFORE the plugin-host check, so the operator gets the true answer", async () => {
      // Ordering matters for the remedy: this server HAS a plugin host, so the assertion that
      // distinguishes the two refusals is that the 409's detail is about federation and never about
      // a plugin-host-capable process — a 400 would send an outpost operator hunting for a worker.
      const { status, detail } = await backfill(undeclared, undeclaredOrg.adminToken);
      expect(status).toBe(409);
      expect(detail).not.toMatch(/plugin-host-capable/);
    });
  });

  /**
   * ==============================================================================================
   * THE ROUTE TAKES THE FEDERATION AXIS AND *NOT* THE PROCESS AXIS — AND THAT IS NOW PINNED
   * ==============================================================================================
   * The handler calls `commanderOnlyFederationVerdict`, not `commanderOnlyJobVerdict`, deliberately:
   * in the split topology the chart deploys — `SCP_ROLE=api` serving HTTP in front of
   * `SCP_ROLE=worker` draining queues — EVERY HTTP request lands on an api process, so a route
   * carrying the process axis would 409 every caller on a perfectly correct commander.
   *
   * That reasoning was right and NOTHING PINNED IT. Swapping in the job verdict left `tsc` clean,
   * every unit test green and all 22 backfill integration tests green, because every other server in
   * this file boots at the harness default `SCP_ROLE=all` — which satisfies the process axis and so
   * cannot tell the two verdicts apart. The one deployment shape that distinguishes them is an api
   * process, and until this block nothing in the repo booted one.
   */
  describe("an api-only process on a declared commander — the split topology", () => {
    let apiOnly: ListeningTestServer;
    let apiOnlyOrg: TestOrg;
    let outpostApi: ListeningTestServer;
    let outpostApiOrg: TestOrg;

    beforeAll(async () => {
      apiOnly = await listenTestServer({
        withPluginHost: true,
        federationRole: "commander",
        role: "api"
      });
      apiOnlyOrg = await createTestOrg(apiOnly, "dep-backfill-api-only");
      // The negative control's deployment: the SAME process axis, a different federation role, so
      // the only thing that can explain the two different answers is the axis the route reads.
      outpostApi = await listenTestServer({
        withPluginHost: true,
        federationRole: "outpost",
        role: "api"
      });
      outpostApiOrg = await createTestOrg(outpostApi, "dep-backfill-outpost-api");
    }, 120_000);

    afterAll(async () => {
      await apiOnly?.close();
      await outpostApi?.close();
    });

    it("ACCEPTS the backfill — the process axis belongs to the jobs, never to this route", async () => {
      // The fixture's own guard first: an `all` process would satisfy a job-shaped guard too, so a
      // `role` option that silently failed to apply would make everything below vacuous — which is
      // exactly how this gap survived the previous round.
      expect(apiOnly.deps.config.role).toBe("api");
      expect(apiOnly.deps.config.federationRole).toBe("commander");
      expect(apiOnly.deps.config.federationRoleDeclared).toBe(true);

      const response = await fetch(`${apiOnly.baseUrl}/dependencies/inventory/backfill`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiOnlyOrg.adminToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
      const body = (await response.json()) as { ref?: string; detail?: string };
      // Asserted as the SPECIFIC violation rather than "not 409": a job-shaped guard here answers
      // 409 with "SCP_ROLE is 'api'", and that string is what a swap would put in front of an
      // operator whose deployment is correct.
      expect(`${response.status} ${body.detail ?? ""}`.trim()).toBe("200");
      expect(body.ref).toBe("HEAD");
    });

    it("NEGATIVE CONTROL — the same api process on an OUTPOST is still refused", async () => {
      // Without this, "an api process is accepted" would be satisfied just as well by a route with
      // no commander guard at all — which is the door the whole of block (6) exists to close.
      const { status, detail } = await backfill(outpostApi, outpostApiOrg.adminToken);
      expect(status).toBe(409);
      expect(detail).toMatch(/COMMANDER-ONLY/);
      // …and the refusal names the FEDERATION axis, never the process one, even though this process
      // would also fail a job guard. An operator on an outpost must not be sent to find a worker.
      expect(detail).not.toMatch(/SCP_ROLE/);
    });
  });
});

/**
 * ================================================================================================
 * (7) EVERY RESOLVE ANSWER SAYS WHETHER ANYTHING HERE WILL ACT ON IT (ADR-0032 §7d, M21.7)
 * ================================================================================================
 * Block (6) proves the WRITE door is shut on a non-commander. This block is about the door that
 * stays OPEN and must therefore explain itself.
 *
 * The resolve route does not refuse on an outpost, and should not: a team there may legitimately ask
 * what their subscription resolves to, and the answer is arithmetically correct — the policies it
 * merges federated down from the commander. What was missing is that NO DEPENDENCY JOB RUNS ON THAT
 * DEPLOYMENT, so `enabled: true` there means "the commander would author a bump", never "a bump will
 * be authored here". An unqualified verdict is an answer whose REASON is unavailable, which is
 * charter principle 6 failing rather than being satisfied.
 *
 * THE FLAGSHIP ASSERTION IS THE COMBINATION, not either field alone: a resolution that says
 * `enabled: true` sitting beside `managedHere: false`. That pair is the live hole this closes, and
 * asserting `managedHere: false` on a component that resolved to `enabled: false` anyway would not
 * exercise it.
 *
 * `role_undeclared` GETS ITS OWN POSTURE because it is the branch that reads as `commander` on the
 * config VALUE alone — `loadConfig` defaults `federationRole` to 'commander' when
 * SCP_FEDERATION_ROLE is unset. A deployment there is the exact opposite of what the default says,
 * and it is the population most likely to be an air-gapped outpost.
 *
 * A SEPARATE SERVER PER POSTURE, for the same reason block (6) does it: these are install-time
 * config read from the environment at boot, so toggling them on a shared fixture would lie about
 * how the value is produced.
 */
describe("(7) the resolve answer is QUALIFIED by whether dependencies are managed here", () => {
  /** The instance unlock is a DEPLOYMENT-GLOBAL singleton in the shared test database, so it is set
   *  once here and deleted at teardown no matter how this block exits. Written by SQL rather than
   *  through the operator route because what it is doing here is fixture setup, not the subject. */
  async function setUnlock(unlocked: boolean): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked) {
        await pool.query(
          `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
             VALUES ('default', true, 'M21.7 envelope fixture', now())
           ON CONFLICT (id) DO UPDATE SET unlocked = true, updated_at = now()`
        );
      } else {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
      }
    } finally {
      await pool.end();
    }
  }

  const line: DependencyLineKey = { ecosystem: "npm", coordinate: "@acme/lib", major: "1" };

  const POSTURES = [
    {
      label: "an explicitly declared OUTPOST",
      options: { federationRole: "outpost" as const },
      reason: "outpost"
    },
    {
      label: "an explicitly declared RETRANS",
      options: { federationRole: "retrans" as const },
      reason: "retrans"
    },
    {
      // NO `federationRole` — exactly what `loadConfig` sees with SCP_FEDERATION_ROLE unset.
      label: "a deployment that never DECLARED a federation role",
      options: {},
      reason: "role_undeclared"
    }
  ] as const;

  beforeAll(async () => {
    await setUnlock(true);
  }, 120_000);

  afterAll(async () => {
    await setUnlock(false).catch(() => undefined);
  });

  for (const posture of POSTURES) {
    describe(posture.label, () => {
      let target: ListeningTestServer;
      let targetOrg: TestOrg;
      let client: ScpClient;
      let component: string;

      beforeAll(async () => {
        target = await listenTestServer({ ...posture.options });
        targetOrg = await createTestOrg(target, `dep-env-${posture.reason}`);
        client = new ScpClient({ baseUrl: target.baseUrl, token: targetOrg.adminToken });
        component = (await createOrphanComponent(client, `dep-env-${posture.reason}-${uuidv7()}`))
          .id;
        // A component-scoped enable, authored the only way a subscription can be — a
        // `dependencySubscription` effect on an ordinary policy (ADR-0032 §3a). With the instance
        // unlocked above, this makes the pair resolve ENABLED on a deployment that will never act
        // on it, which is the state the envelope exists to explain.
        await client.policies.create({
          name: `dep-env-${posture.reason}-${uuidv7()}`,
          urn: `urn:scp:${targetOrg.orgId}:policy:dep-env-${posture.reason}-${uuidv7()}`,
          properties: {
            scope: { objectRef: component },
            enforcement: "advisory",
            effects: [{ dependencySubscription: { enabled: true } }]
          }
        });
      }, 120_000);

      afterAll(async () => {
        await target?.close();
      });

      it(`answers an ENABLED subscription while saying nothing here will act on it — reason '${posture.reason}'`, async () => {
        const resolved = await client.dependencySubscriptions.resolve(component, line);
        // The verdict itself is real and correct — this is not a refusal, and it must not become
        // one. Without it the assertion below would pass on a deployment that simply resolved to
        // `false` for an unrelated reason, which is not the hole being closed.
        expect(resolved.resolution.enabled).toBe(true);
        expect(resolved.resolution.reason).toBe("enabled");
        // …and the qualifier that makes it honest.
        expect(resolved.dependencyManagement.managedHere).toBe(false);
        expect(resolved.dependencyManagement.reason).toBe(posture.reason);
      });

      it("never reports the DEFAULTED role as an answer — the deployment's own config is the oracle", () => {
        // The undeclared posture is the one that would be mislabelled `commander`, so the config it
        // actually booted with is asserted here rather than assumed from the option object.
        expect(target.deps.config.federationRoleDeclared).toBe(
          posture.reason !== "role_undeclared"
        );
        if (posture.reason === "role_undeclared") {
          // The trap in one line: the VALUE reads 'commander' and the honest answer does not.
          expect(target.deps.config.federationRole).toBe("commander");
        }
      });
    });
  }
});

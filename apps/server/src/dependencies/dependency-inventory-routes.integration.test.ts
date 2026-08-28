import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import {
  asTrustDomainId,
  type ComponentDependencyBumpsResponse,
  type ComponentDependencyInventoryResponse,
  type DependencyLineKey
} from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { dependencyBumpAuthorships, users } from "../db/schema.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { createSourceMapping } from "../coordination/source-mappings-repo.js";
import { createObject } from "../graph/objects-repo.js";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { recordBumpChange } from "./bump-actuator.js";
import { markBumpMerged, recordBumpPullRequest } from "./bump-authorship-repo.js";
import { DEPENDENCY_BUMP_DECISION_KIND } from "./bump-dispatch.js";
import { DEPENDENCY_BUMP_MERGE_DECISION_KIND } from "./bump-gate.js";
import {
  declareDependencyLineProducer,
  recordDependencyLineHead,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import { ingestComponentManifests } from "./inventory-ingestion.js";
import { resolveComponentIngestionGate } from "./subscription-resolution.js";

/**
 * M21.6 — THE READ SURFACE against real Postgres and the real app
 * (docs/proposals/dependency-subscription-ui.md §3.1/§3.2/§5).
 *
 *   GET /components/{idOrUrn}/dependency-inventory
 *   GET /components/{idOrUrn}/dependency-bumps
 *
 * What this file pins, and why each pin is the shape it is:
 *
 *  1. DELETE-THE-WIRING. Both routes are requested THROUGH THE APP and asserted 200. Remove either
 *     `typed.route({...})` registration in `routes/dependency-subscriptions.ts` and the matching
 *     test 404s. (Proven once at authoring time; this test is what keeps it proven.)
 *  2. ONE ROW PER (line, dependency manifest). `manifestPath` is in `component_dependencies`' key,
 *     so a line declared from two manifests is two rows — a consumer that wants one-per-line groups.
 *  3. NO SECOND AND. Every row's `subscription` is BYTE-EQUAL (JSON.stringify) to what
 *     `GET /components/{id}/dependency-subscription` returns THE SAME CALLER for THE SAME LINE. That
 *     equality dies the moment anyone recomputes `enabled` locally in the read path — mutated once
 *     to watch it die, then restored.
 *  4. `componentGate` EQUALS the ingestion gate — the same `resolveComponentIngestionGate` answer for
 *     the same actor, not a re-derivation.
 *  5. `ingestion` IS THE M21.7 STAMP, read in the same transaction: `null` (never attempted) and a
 *     null `lastIngestionDecision` UNTIL an ingested pass writes both — then the stamp carries the
 *     pass's outcome/source/rows and its per-repo `manifests[]`, and the Decision its id and
 *     manifest paths. Mutation: `ingestion: null` hard-coded in the route → the ingested case RED.
 *  5a. BOTH responses carry `dependencyManagement` from `dependencyManagementOf(config)` — on this
 *     file's DECLARED commander `{ managedHere: true, reason: "commander" }`, and on an UNDECLARED
 *     server (a second harness) `{ managedHere: false, reason: "role_undeclared" }` with the same
 *     200 and the same RBAC (the reads do not refuse; the envelope qualifies). Mutation: drop the
 *     spread from either route → the response serializer refuses the missing required field.
 *  6. RBAC IS AT THE COMPONENT: a Viewer bound at the component 200s, a principal bound nowhere near
 *     it 403s, an unknown component 404s. This is the property that makes the inventory reachable to
 *     a component team at all (`GET /changes` / `GET /decisions` are org-scoped and would 403 them).
 *  7. THE COORDINATE TRAVELS VERBATIM (`@acme/lib`).
 *  8. PAGINATION terminates and neither drops nor repeats a row; a syntactically valid but
 *     semantically garbage cursor (a non-uuid id, an unparseable date) is the FIRST PAGE, not a 500.
 *  8a. RESOLVED AS THE CALLER — not merely "byte-equal to resolve() for the admin". The objectRef
 *     policies above match independently of the actor, so the admin and the SYSTEM sentinel gather
 *     the SAME candidates and a read path that hard-coded `SYSTEM_ACTOR_ID` (or dropped the
 *     parameter) would leave every other pin green. The one place the actor changes the answer is a
 *     group-only enable (acting half `via: "group"` — no `owns` edge), which the authoring guard
 *     refuses at every local door but which reaches the DB over the `federationImport` exemption.
 *     A member of that group reads `enabled` and the org admin reads `not_enabled` for the SAME
 *     row; both byte-equal to THEIR OWN resolve(). Mutated once (actor → SYSTEM sentinel in
 *     `dependency-read-surface.ts`): this pin RED, everything else green; restored.
 *  9. BUMPS: rows are joined to the change name and to the newest merge Decision (drop the join and
 *     the test dies — mutated once), `pullRequestUrl` is READ off the authorship row (the URL the
 *     provider returned, stored by `recordBumpPullRequest`) — present on the row that has one, `null`
 *     on the row that does not, never composed — newest dispatch first,
 *     the dispatch Decision's delivery is read (not the tenant-writable `source_ref`), and RBAC is
 *     at the component.
 *
 * INSTANCE-GLOBAL FIXTURE: the unlock singleton is deleted at teardown however this file exits.
 */
describe("M21.6 dependency read surface — inventory + bumps routes", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let actorObjectId: string;

  let component: string;
  let producerComponent: string;
  let lineWanted: DependencyLineKey;
  let lineOptedOut: DependencyLineKey;
  let lineWantedId: string;
  let lineOptedOutId: string;

  const REPO = "acme/widgets";
  const RESOLVED_COMMIT = "b".repeat(40);

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.6 read-surface fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  async function subscriptionPolicy(
    name: string,
    scopeObjectId: string,
    effect: Record<string, unknown>
  ) {
    return admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "advisory",
        effects: [{ dependencySubscription: effect }]
      }
    });
  }

  async function declare(
    componentObjectId: string,
    key: DependencyLineKey,
    manifestPath: string,
    declaredVersion = "^1.0.0"
  ): Promise<string> {
    return inOrg(async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, key);
      await upsertComponentDependency(tx, org.orgId, {
        componentObjectId,
        lineId: line.id,
        manifestPath,
        declaredVersion,
        resolvedVersion: declaredVersion.replace(/^\^/, ""),
        observedRepo: REPO,
        observedRef: RESOLVED_COMMIT
      });
      return line.id;
    });
  }

  async function getInventory(
    idOrUrn: string,
    token: string,
    query: Record<string, string> = {}
  ): Promise<{ status: number; body: ComponentDependencyInventoryResponse }> {
    const qs = new URLSearchParams(query).toString();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${encodeURIComponent(idOrUrn)}/dependency-inventory${qs ? `?${qs}` : ""}`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.json() as ComponentDependencyInventoryResponse };
  }

  async function getBumps(
    idOrUrn: string,
    token: string,
    query: Record<string, string> = {}
  ): Promise<{ status: number; body: ComponentDependencyBumpsResponse }> {
    const qs = new URLSearchParams(query).toString();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${encodeURIComponent(idOrUrn)}/dependency-bumps${qs ? `?${qs}` : ""}`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.json() as ComponentDependencyBumpsResponse };
  }

  beforeAll(async () => {
    // A DECLARED commander: the envelope's `managedHere: true` arm. The undeclared arm gets its own
    // server in (1) below.
    server = await listenTestServer({ federationRole: "commander" });
    org = await createTestOrg(server, "dep-read-surface");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const [adminRow] = await server.deps.db
      .select({ objectId: users.objectId })
      .from(users)
      .where(eq(users.username, org.adminUsername));
    if (!adminRow?.objectId) throw new Error("expected the bootstrap admin to have a user object");
    actorObjectId = adminRow.objectId;
    await setInstanceUnlock(true);

    component = (await createOrphanComponent(server, org, `reader-${uuidv7()}`)).id;
    producerComponent = (await createOrphanComponent(server, org, `producer-${uuidv7()}`)).id;

    // Two npm lines; the opted-out one is the slug-colliding spelling of the other, so a read
    // surface that normalised would show the wrong subscription on the wrong row.
    lineWanted = { ecosystem: "npm", coordinate: "@acme/lib", major: "1" };
    lineOptedOut = { ecosystem: "npm", coordinate: "acme-lib", major: "1" };
    // ONE line from TWO manifests -> two rows; the other from one.
    lineWantedId = await declare(component, lineWanted, "package.json", "^1.2.0");
    await declare(component, lineWanted, "services/api/package.json", "^1.1.0");
    lineOptedOutId = await declare(component, lineOptedOut, "package.json", "^1.0.0");

    // A DECLARED producer on the wanted COORDINATE (ADR-0032 §7e — the grain is the coordinate,
    // `dependency_line_producers`, not the line), and an OBSERVED head — so `producer` and `head`
    // are asserted against stored facts rather than against nulls that would pass for the wrong
    // reason. The opted-out line's coordinate (`acme-lib`, the slug-colliding spelling) is NOT
    // declared: a producer read that matched by URN slug instead of by verbatim coordinate would
    // show a producer on that row too.
    await inOrg(async (tx) => {
      await declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: lineWanted.ecosystem,
        coordinate: lineWanted.coordinate,
        producerObjectId: producerComponent,
        declaredByObjectId: actorObjectId
      });
      // The head is written by the INTERNAL ingress naming the declared producer — the coordinate
      // is declared, so a third-party (poll) write would be refused (`line-head.ts`).
      const head = await recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId: lineWantedId, latestVersion: "1.4.0", latestDigest: null },
        { kind: "internal", producerObjectId: producerComponent }
      );
      expect(head.recorded, "the observed-head fixture must have taken").toBe(true);
    });

    await subscriptionPolicy(`enable-${uuidv7()}`, component, { enabled: true });
    await subscriptionPolicy(`optout-${uuidv7()}`, component, {
      coordinate: "acme-lib",
      enabled: false
    });
  });

  afterAll(async () => {
    await setInstanceUnlock(null).catch(() => undefined);
    await server?.close();
  });

  // -----------------------------------------------------------------------------------------
  // (1) DELETE-THE-WIRING — both routes answer through the app
  // -----------------------------------------------------------------------------------------
  describe("(1) the routes are registered", () => {
    it("GET /components/{id}/dependency-inventory answers 200 through the app, carrying the REQUIRED dependencyManagement envelope", async () => {
      const { status, body } = await getInventory(component, org.adminToken);
      expect(status).toBe(200);
      expect(body.dependencyManagement).toEqual({ managedHere: true, reason: "commander" });
    });

    it("GET /components/{id}/dependency-bumps answers 200 through the app, carrying the REQUIRED dependencyManagement envelope", async () => {
      const { status, body } = await getBumps(component, org.adminToken);
      expect(status).toBe(200);
      expect(body.dependencyManagement).toEqual({ managedHere: true, reason: "commander" });
    });

    it("on a deployment that does NOT manage dependencies (undeclared role) both reads still answer 200 with the same RBAC — the envelope says `managedHere: false`, and the rest is not to be interpreted", async () => {
      // A second harness with NO SCP_FEDERATION_ROLE: `dependencyManagementOf` reads the fail-closed
      // `role_undeclared` (the branch whose config VALUE reads 'commander' — labelling from the value
      // alone would say the opposite of the truth). Same predicate as the resolve route and the
      // backfill's 409, so the three cannot disagree about the posture.
      const undeclared = await listenTestServer();
      try {
        const uOrg = await createTestOrg(undeclared, "dep-read-undeclared");
        const uAdmin = new ScpClient({ baseUrl: undeclared.baseUrl, token: uOrg.adminToken });
        const c = (await createOrphanComponent(server, org, `undeclared-${uuidv7()}`)).id;
        const inv = await undeclared.app.inject({
          method: "GET",
          url: `/api/v1/components/${c}/dependency-inventory`,
          headers: { authorization: `Bearer ${uOrg.adminToken}` }
        });
        expect(inv.statusCode, inv.body).toBe(200);
        const invBody = inv.json() as ComponentDependencyInventoryResponse;
        expect(invBody.dependencyManagement).toEqual({
          managedHere: false,
          reason: "role_undeclared"
        });
        // Structurally empty AND never attempted — which the envelope tells a reader not to read as
        // "declares nothing".
        expect(invBody.rows).toEqual([]);
        expect(invBody.ingestion).toBeNull();
        const bumps = await undeclared.app.inject({
          method: "GET",
          url: `/api/v1/components/${c}/dependency-bumps`,
          headers: { authorization: `Bearer ${uOrg.adminToken}` }
        });
        expect(bumps.statusCode, bumps.body).toBe(200);
        expect((bumps.json() as ComponentDependencyBumpsResponse).dependencyManagement).toEqual({
          managedHere: false,
          reason: "role_undeclared"
        });
      } finally {
        await undeclared.close();
      }
    });
  });

  // -----------------------------------------------------------------------------------------
  // (2) The inventory
  // -----------------------------------------------------------------------------------------
  describe("(2) the inventory", () => {
    it("returns one row per (line, dependency manifest), coordinates verbatim, head and producer read", async () => {
      const { status, body } = await getInventory(component, org.adminToken);
      expect(status).toBe(200);
      expect(body.component.id).toBe(component);
      expect(body.component.name).toMatch(/^reader-/);
      expect(body.nextCursor).toBeNull();

      const keys = body.rows
        .map((r) => `${r.manifestPath}:${r.line.coordinate}@${r.line.major}`)
        .sort();
      expect(keys).toEqual([
        "package.json:@acme/lib@1",
        "package.json:acme-lib@1",
        "services/api/package.json:@acme/lib@1"
      ]);

      const wantedRoot = body.rows.find(
        (r) => r.line.id === lineWantedId && r.manifestPath === "package.json"
      )!;
      // Verbatim — the scoped npm name survives untouched.
      expect(wantedRoot.line.coordinate).toBe("@acme/lib");
      expect(wantedRoot.declaredVersion).toBe("^1.2.0");
      expect(wantedRoot.resolvedVersion).toBe("1.2.0");
      expect(wantedRoot.observedRepo).toBe(REPO);
      expect(wantedRoot.observedRef).toBe(RESOLVED_COMMIT);
      // The head is what detection OBSERVED, never what the manifest declares.
      expect(wantedRoot.head.latestVersion).toBe("1.4.0");
      expect(wantedRoot.head.latestObservedAt).not.toBeNull();
      // The producer is DECLARED — read off the line, with its name resolved.
      expect(wantedRoot.producer).toEqual({
        objectId: producerComponent,
        name: expect.stringMatching(/^producer-/)
      });

      const optedOut = body.rows.find((r) => r.line.id === lineOptedOutId)!;
      // The other line has no producer and no observed head: both null, both meaning "not
      // recorded", never "third-party" / "nothing newer".
      expect(optedOut.producer).toBeNull();
      expect(optedOut.head).toEqual({
        latestVersion: null,
        latestDigest: null,
        latestObservedAt: null
      });
      // And the two subscriptions differ the way the policies say: an opt-out on `acme-lib` alone.
      expect(wantedRoot.subscription.enabled).toBe(true);
      expect(wantedRoot.subscription.reason).toBe("enabled");
      expect(optedOut.subscription.enabled).toBe(false);
      expect(optedOut.subscription.reason).toBe("disabled");
    });

    it("every row's `subscription` is BYTE-EQUAL to the resolution GET for the same actor and line (no second AND)", async () => {
      const { body } = await getInventory(component, org.adminToken);
      expect(body.rows.length).toBe(3);
      for (const row of body.rows) {
        const resolved = await admin.dependencySubscriptions.resolve(component, {
          ecosystem: row.line.ecosystem,
          coordinate: row.line.coordinate,
          major: row.line.major
        });
        expect(JSON.stringify(row.subscription)).toBe(JSON.stringify(resolved.resolution));
      }
      // NEGATIVE CONTROL for the control: the two lines really do resolve differently, so the
      // equality above is not three copies of one constant.
      const reasons = new Set(body.rows.map((r) => r.subscription.reason));
      expect(reasons).toEqual(new Set(["enabled", "disabled"]));
    });

    it("`componentGate` is the ingestion gate — same enabled/reason/contributions for the same actor", async () => {
      const { body } = await getInventory(component, org.adminToken);
      const gate = await inOrg((tx) =>
        resolveComponentIngestionGate(tx, {
          orgId: org.orgId,
          componentObjectId: component,
          actorObjectId
        })
      );
      expect(body.componentGate).toEqual({
        enabled: gate.enabled,
        reason: gate.reason,
        contributions: gate.contributions
      });
      expect(body.componentGate.enabled).toBe(true);
      expect(body.componentGate.reason).toBe("enabled");

      // A component with NO enabling policy reads a CLOSED gate with its explanation — the negative
      // control that the equality above is not comparing two "enabled" constants.
      const bare = (await createOrphanComponent(server, org, `bare-${uuidv7()}`)).id;
      const bareRead = await getInventory(bare, org.adminToken);
      expect(bareRead.body.componentGate.enabled).toBe(false);
      expect(bareRead.body.componentGate.reason).toBe("no_enabling_contribution");
      expect(bareRead.body.componentGate.contributions.map((c) => c.contributed)).toEqual([
        "unlock"
      ]);
      expect(bareRead.body.rows).toEqual([]);
    });

    it("`ingestion` (the M21.7 stamp) and `lastIngestionDecision` are both null until an ingested pass writes them — then the stamp reads the pass's outcome, source, rows and per-repo manifests, in the same read", async () => {
      const before = await getInventory(component, org.adminToken);
      expect(before.body.ingestion).toBeNull();
      expect(before.body.lastIngestionDecision).toBeNull();

      // A real ingestion pass with a fake reader (the way `inventory-ingestion.integration.test.ts`
      // does): the component gets a source mapping so the probe has a prefix, then ingests ONE
      // manifest declaring one line.
      const ingested = (await createOrphanComponent(server, org, `ingested-${uuidv7()}`)).id;
      await inOrg((tx) =>
        createSourceMapping(tx, {
          orgId: org.orgId,
          sourceKind: "github",
          repoPattern: REPO,
          pathPattern: "svc/api/**",
          componentIdOrUrn: ingested,
          type: "configuration"
        })
      );
      await subscriptionPolicy(`enable-ingested-${uuidv7()}`, ingested, { enabled: true });
      const files: Record<string, string> = {
        "svc/api/package.json": JSON.stringify({
          name: "svc-api",
          dependencies: { "@acme/lib": "^1.2.0" }
        })
      };
      const readManifest = async (request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult> => {
        const entry = files[request.path];
        if (entry === undefined) {
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
          commitSha: RESOLVED_COMMIT,
          content: entry,
          sizeBytes: Buffer.byteLength(entry, "utf8")
        };
      };
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        componentObjectId: ingested,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest,
        actorObjectId,
        source: "backfill"
      });
      expect(outcome.verdict).toBe("ingested");

      const after = await getInventory(ingested, org.adminToken);
      expect(after.status).toBe(200);
      // THE STAMP, as the write door recorded it: this pass (a backfill) read the repo, wrote one
      // row, and its per-repo slice names the manifest it read.
      expect(after.body.ingestion).not.toBeNull();
      expect(after.body.ingestion).toMatchObject({
        source: "backfill",
        outcome: "ok",
        rowsWritten: 1
      });
      expect(after.body.ingestion!.lastAttemptAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const readEntry = after.body.ingestion!.manifests.find(
        (m) => m.path === "svc/api/package.json"
      );
      expect(readEntry, "the read manifest is in the stamp's slice").toMatchObject({
        repo: REPO,
        outcome: "ok",
        rows: 1
      });
      expect(readEntry!.at).toBe(after.body.ingestion!.lastAttemptAt);
      expect(after.body.lastIngestionDecision).not.toBeNull();
      expect(after.body.lastIngestionDecision!.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(after.body.lastIngestionDecision!.manifestPathsRead).toEqual(["svc/api/package.json"]);
      // The other probed candidates under the prefix were absent — recorded as such.
      expect(after.body.lastIngestionDecision!.manifestPathsAbsent.length).toBeGreaterThan(0);
      expect(after.body.lastIngestionDecision!.skipped).toEqual([]);
      // And the row the pass wrote is what the inventory shows, ref included.
      expect(after.body.rows.map((r) => `${r.manifestPath}:${r.line.coordinate}`)).toEqual([
        "svc/api/package.json:@acme/lib"
      ]);
      expect(after.body.rows[0]!.observedRef).toBe(RESOLVED_COMMIT);
    });

    it("authorizes object:read AT THE COMPONENT — component viewer 200, stranger 403, unknown 404", async () => {
      const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: component }]);
      const stranger = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);

      const asViewer = await getInventory(component, viewer.token);
      expect(asViewer.status).toBe(200);
      expect(asViewer.body.rows.length).toBe(3);

      const asStranger = await getInventory(component, stranger.token);
      expect(asStranger.status).toBe(403);

      const unknown = await getInventory(randomUUID(), org.adminToken);
      expect(unknown.status).toBe(404);

      // Also by URN — the same `idOrUrn` addressing every other component route accepts.
      const byUrn = await getInventory((await admin.components.get(component)).urn, viewer.token);
      expect(byUrn.status).toBe(200);
    });

    it("pages with limit/cursor — terminates, no row dropped or repeated", async () => {
      const first = await getInventory(component, org.adminToken, { limit: "2" });
      expect(first.status).toBe(200);
      expect(first.body.rows.length).toBe(2);
      expect(first.body.nextCursor).not.toBeNull();
      const second = await getInventory(component, org.adminToken, {
        limit: "2",
        cursor: first.body.nextCursor!
      });
      expect(second.status).toBe(200);
      expect(second.body.rows.length).toBe(1);
      expect(second.body.nextCursor).toBeNull();
      const all = [...first.body.rows, ...second.body.rows].map(
        (r) => `${r.line.id}:${r.manifestPath}`
      );
      expect(new Set(all).size).toBe(3);
      // A limit above the ceiling is refused, not silently clamped.
      const tooBig = await getInventory(component, org.adminToken, { limit: "201" });
      expect(tooBig.status).toBe(400);
    });

    it("a well-formed but GARBAGE cursor (non-uuid lineId) is the first page, never a 500", async () => {
      const garbage = Buffer.from(JSON.stringify({ lineId: "nope", manifestPath: "x" })).toString(
        "base64url"
      );
      const res = await getInventory(component, org.adminToken, { cursor: garbage });
      expect(res.status).toBe(200);
      expect(res.body.rows.length).toBe(3);
    });

    it("rows are resolved AS THE CALLER: a group-only enable (imported, acting half) reads `enabled` for a member and `not_enabled` for the org admin, each byte-equal to THEIR resolve()", async () => {
      // A fresh component with ONE declared line and NO objectRef policy, so the only enable in
      // play is the group-scoped one below.
      const groupComp = (await createOrphanComponent(server, org, `group-read-${uuidv7()}`)).id;
      await declare(
        groupComp,
        { ecosystem: "go", coordinate: "golang.org/x/net", major: "0" },
        "go.mod",
        "v0.30.0"
      );
      const group = await admin.groups.create({ name: `dep-readers-${uuidv7()}` });
      // The member can READ the component (object:read at it) and is transitively member_of the
      // group; the admin is bound at the org root and is a member of nothing.
      const member = await createTestUser(server, org, [{ role: "Viewer", scope: groupComp }]);
      await admin.relationships.create({
        typeId: "member_of",
        fromId: member.objectId,
        toId: group.id
      });
      // A SOLE-group-scoped enable — refused 400 by every local write door (ADR-0032 §6a, both
      // directions), so it is planted the one way it can reach the DB: the `federationImport`
      // path, where the choke-point guard is skipped (objects-repo.ts). Foreign origin, revision 1.
      await inOrg((tx) =>
        createObject(tx, {
          orgId: org.orgId,
          typeId: "policy",
          actorObjectId,
          requestId: randomUUID(),
          name: `group-only-enable-${uuidv7()}`,
          properties: {
            scope: { group: group.id },
            enforcement: "advisory",
            effects: [{ dependencySubscription: { enabled: true } }]
          },
          federationImport: { originDomainId: asTrustDomainId(randomUUID()), revision: 1 }
        })
      );

      const asMember = await getInventory(groupComp, member.token);
      expect(asMember.status).toBe(200);
      expect(asMember.body.rows.length).toBe(1);
      const memberRow = asMember.body.rows[0]!;
      expect(memberRow.subscription.reason).toBe("enabled");
      expect(memberRow.subscription.contributions.map((c) => c.contributed)).toEqual([
        "unlock",
        "enable"
      ]);
      const memberClient = new ScpClient({ baseUrl: server.baseUrl, token: member.token });
      const memberResolved = await memberClient.dependencySubscriptions.resolve(groupComp, {
        ecosystem: "go",
        coordinate: "golang.org/x/net",
        major: "0"
      });
      expect(JSON.stringify(memberRow.subscription)).toBe(
        JSON.stringify(memberResolved.resolution)
      );

      const asAdmin = await getInventory(groupComp, org.adminToken);
      const adminRow = asAdmin.body.rows[0]!;
      expect(adminRow.subscription.reason).toBe("not_enabled");
      const adminResolved = await admin.dependencySubscriptions.resolve(groupComp, {
        ecosystem: "go",
        coordinate: "golang.org/x/net",
        major: "0"
      });
      expect(JSON.stringify(adminRow.subscription)).toBe(JSON.stringify(adminResolved.resolution));
      // And the gate follows the same actor: the member's gate is open, the admin's is not.
      expect(asMember.body.componentGate.reason).toBe("enabled");
      expect(asAdmin.body.componentGate.reason).toBe("no_enabling_contribution");
    });
  });

  // -----------------------------------------------------------------------------------------
  // (3) The bumps
  // -----------------------------------------------------------------------------------------
  describe("(3) the bumps", () => {
    let bumped: string;
    let olderChange: string;
    let newerChange: string;
    let mergeDecisionId: string;

    beforeAll(async () => {
      bumped = (await createOrphanComponent(server, org, `bumped-${uuidv7()}`)).id;
      const line = await inOrg((tx) =>
        upsertDependencyLine(tx, org.orgId, {
          ecosystem: "npm",
          coordinate: "@acme/bumpable",
          major: "2"
        })
      );
      const author = (fromVersion: string, toVersion: string) =>
        inOrg((tx) =>
          recordBumpChange(tx, {
            orgId: org.orgId,
            changeObjectId: randomUUID(),
            requestId: `test-${randomUUID()}`,
            componentObjectId: bumped,
            lineId: line.id,
            repo: REPO,
            baseBranch: "main",
            ecosystem: "npm",
            coordinate: "@acme/bumpable",
            manifestPath: "package.json",
            declaredManifestPaths: ["package.json"],
            fromVersion,
            toVersion,
            delivery: { delivery: "pull_request", reason: "test fixture" }
          })
        );
      olderChange = (await author("^2.0.0", "^2.1.0")).changeObjectId;
      newerChange = (await author("^2.1.0", "^2.2.0")).changeObjectId;
      // Make the order unambiguous rather than relying on two `now()`s landing a millisecond apart.
      await inOrg((tx) =>
        tx
          .update(dependencyBumpAuthorships)
          .set({ createdAt: sql`now() - interval '1 hour'` })
          .where(
            and(
              eq(dependencyBumpAuthorships.orgId, org.orgId),
              eq(dependencyBumpAuthorships.changeObjectId, olderChange)
            )
          )
      );
      // The older bump: opened as #41 WITH the provider's URL, merged; the newer: open, no PR yet.
      await inOrg(async (tx) => {
        await recordBumpPullRequest(
          tx,
          org.orgId,
          olderChange,
          41,
          "https://git.example.test/acme/bumpable/pull/41"
        );
        await markBumpMerged(tx, org.orgId, olderChange);
        // A superseded merge verdict, then the one that stands — the read must pick the NEWEST.
        await insertDecision(tx, {
          orgId: org.orgId,
          kind: DEPENDENCY_BUMP_MERGE_DECISION_KIND,
          subjectId: olderChange,
          verdict: "withheld",
          inputContext: { refusal: "no_head_commit" },
          reasonTree: { summary: "first look" }
        });
        const merged = await insertDecision(tx, {
          orgId: org.orgId,
          kind: DEPENDENCY_BUMP_MERGE_DECISION_KIND,
          subjectId: olderChange,
          verdict: "merged",
          inputContext: { pullRequestNumber: 41 },
          reasonTree: { summary: "merged on the second look" }
        });
        mergeDecisionId = merged.id;
        // A dispatch Decision on the newer bump — the read takes delivery from HERE (server-written),
        // never from the change's tenant-writable `source_ref`.
        await insertDecision(tx, {
          orgId: org.orgId,
          kind: DEPENDENCY_BUMP_DECISION_KIND,
          subjectId: newerChange,
          verdict: "dispatched",
          inputContext: { requestedDelivery: "auto_merge", effectiveDelivery: "pull_request" },
          reasonTree: { summary: "x", delivery: "first look is always a pull request" }
        });
      });
    });

    it("lists newest-first, joined to the change name and the newest merge Decision; pullRequestUrl is READ off the row — the stored provider URL, else null", async () => {
      const { status, body } = await getBumps(bumped, org.adminToken);
      expect(status).toBe(200);
      expect(body.component.id).toBe(bumped);
      expect(body.rows.map((r) => r.changeId)).toEqual([newerChange, olderChange]);

      const [newer, older] = body.rows as [
        ComponentDependencyBumpsResponse["rows"][number],
        ComponentDependencyBumpsResponse["rows"][number]
      ];
      // The change NAME is the join to `objects` — what `recordBumpChange` named it.
      expect(older.changeName).toBe("dependency bump: @acme/bumpable ^2.0.0 -> ^2.1.0");
      expect(newer.changeName).toBe("dependency bump: @acme/bumpable ^2.1.0 -> ^2.2.0");
      expect(older.line).toEqual({
        id: expect.any(String),
        ecosystem: "npm",
        coordinate: "@acme/bumpable",
        major: "2"
      });
      expect(older.repo).toBe(REPO);
      expect(older.baseBranch).toBe("main");
      expect(older.authoredRef).toBe(`refs/heads/scp/dep-bump/${olderChange}`);
      expect(older.pullRequestNumber).toBe(41);
      expect(older.mergedAt).not.toBeNull();
      // THE MERGE JOIN — the NEWEST merge Decision, not the first.
      expect(older.merge).toEqual({
        verdict: "merged",
        decisionId: mergeDecisionId,
        evaluatedAt: expect.any(String)
      });
      // Nothing dispatched-Decision on the older one in this fixture: delivery reads null, not a
      // guess out of `source_ref`.
      expect(older.delivery).toBeNull();
      expect(older.deliveryReason).toBeNull();

      expect(newer.pullRequestNumber).toBeNull();
      expect(newer.mergedAt).toBeNull();
      expect(newer.headCommit).toBeNull();
      expect(newer.merge).toBeNull();
      expect(newer.delivery).toBe("pull_request");
      expect(newer.deliveryReason).toBe("first look is always a pull request");

      // READ, NEVER SYNTHESISED: the older row carries exactly the URL the provider returned (as
      // `recordBumpPullRequest` stored it); the newer row, with no PR recorded, is `null` — not a
      // link composed from `repo` + number.
      expect(older.pullRequestUrl).toBe("https://git.example.test/acme/bumpable/pull/41");
      expect(newer.pullRequestUrl).toBeNull();
      expect(body.nextCursor).toBeNull();
    });

    it("a well-formed but GARBAGE cursor (unparseable date / non-uuid id) is the first page, never a 500", async () => {
      for (const junk of [
        { createdAt: "garbage", id: randomUUID() },
        { createdAt: new Date().toISOString(), id: "x" }
      ]) {
        const cursor = Buffer.from(JSON.stringify(junk)).toString("base64url");
        const res = await getBumps(bumped, org.adminToken, { cursor });
        expect(res.status, JSON.stringify(junk)).toBe(200);
        expect(res.body.rows.map((r) => r.changeId)).toEqual([newerChange, olderChange]);
      }
    });

    it("pages newest-first with limit/cursor", async () => {
      const first = await getBumps(bumped, org.adminToken, { limit: "1" });
      expect(first.body.rows.map((r) => r.changeId)).toEqual([newerChange]);
      expect(first.body.nextCursor).not.toBeNull();
      const second = await getBumps(bumped, org.adminToken, {
        limit: "1",
        cursor: first.body.nextCursor!
      });
      expect(second.body.rows.map((r) => r.changeId)).toEqual([olderChange]);
      expect(second.body.nextCursor).toBeNull();
    });

    it("authorizes object:read AT THE COMPONENT — component viewer 200, stranger 403, unknown 404", async () => {
      const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: bumped }]);
      const stranger = await createTestUser(server, org, [{ role: "Viewer", scope: "self" }]);
      expect((await getBumps(bumped, viewer.token)).status).toBe(200);
      expect((await getBumps(bumped, stranger.token)).status).toBe(403);
      expect((await getBumps(randomUUID(), org.adminToken)).status).toBe(404);
      // A component with no bumps is an EMPTY list, 200 — never a 404: absence of bumps is a fact
      // about dispatch (commander-only, fail-closed), not about the component.
      const quiet = await getBumps(component, org.adminToken);
      expect(quiet.status).toBe(200);
      expect(quiet.body.rows).toEqual([]);
    });
  });
});

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type {
  DiscoveryPlugin,
  DiscoveryProposal,
  PluginContext,
  ScopedHttpRequest,
  ScopedHttpResponse
} from "@scp/plugin-api";
import { createGithubDiscoveryPlugin } from "@scp/plugin-github";
import { createGiteaDiscoveryPlugin } from "@scp/plugin-gitea";
import { createGitlabDiscoveryPlugin } from "@scp/plugin-gitlab";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { containmentChain } from "../graph/containment.js";

/**
 * THE DISCOVERY RELATIONSHIP CHANNEL, END TO END — a real plugin's `discover()` output pushed
 * through the real `POST /discovery/accept` door, asserting the ROW lands.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS — TWO DEFECTS, AND THE FIXTURE THAT HID BOTH
 * ================================================================================================
 * Discovery's whole purpose is to propose objects AND the edges between them. Until this file, the
 * edge half had **never worked, not once, in any deployment**, and the suite was green throughout.
 *
 * Both halves were measured through the real door before anything was changed:
 *
 *  1. **The type was not registered.** Every `DiscoveryPlugin` in the tree emitted `part_of`, which
 *     no migration defines. Accept answered `404 relationship type 'part_of' is not registered`.
 *     `docs/proposals/service-component-model.md` §2 had considered `component --part_of--> service`
 *     and REJECTED it — the owner accepted `contains` (decision 1), landed as migration `0021` —
 *     and the plugins were simply never moved to the decision.
 *  2. **The endpoints resolved to nothing.** Fixing (1) alone only moves the 404: with the type
 *     corrected, the real gitea proposal still failed `404 object
 *     'urn:scp:component:gitea:acme/widgets/service-a' not found`. A proposed object carried only
 *     `typeId`/`name` while accept mints `urn:scp:{orgId}:{typeId}:{slug(name)}`, so a proposal's
 *     relationships had no way to name the proposal's own objects. Hence
 *     `DiscoveryProposalObjectSchema.urn`, the batch-local alias, and the third case below.
 *
 * **THE FIXTURE THAT HID IT, which is the more important half.** Every end-to-end discovery test in
 * the tree sent `relationships: []` at the accept step — including the two (gitea, gitlab) that
 * assert the plugin PROPOSES an edge one screen earlier. So each proved the proposal contained an
 * edge, then imported a proposal containing none, and the broken path between those two facts was
 * never crossed. `apps/server/src/routes/relationship-typeid-doors.integration.test.ts` hit defect
 * (1) head-on while writing an unrelated authorization census, recorded it in its header, and
 * routed around it. This file is the crossing.
 *
 * ================================================================================================
 * WHAT MAKES THESE CASES NON-VACUOUS
 * ================================================================================================
 *  - **The proposal is not hand-written.** It comes from the plugin's own `discover()`, driven over
 *    a stubbed `ScopedHttpClient` (no network — CLAUDE.md). A hand-written proposal would assert
 *    only that the door accepts a shape someone typed here; this asserts it accepts the shape the
 *    plugin actually produces, which is the shape that was broken.
 *  - **The row is read from the TABLE**, never from `GET /relationships` — a list route that
 *    filtered or a response that reported an id would otherwise satisfy the assertion without a row.
 *  - **All three git plugins**, because the bug was identical in three files and a fix applied to
 *    one of three is this repo's named failure mode (CLAUDE.md, "census by property").
 *  - **The last case asserts CONSEQUENCE, not just presence**: the imported component's containment
 *    chain now contains its service. That is what makes `contains` the right edge and any
 *    other spelling decoration — a `part_of` row, had it been registered, would have satisfied
 *    "a row landed" while leaving the component governed by nothing.
 */
describe("discovery relationship import: plugin discover() -> accept -> row (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `object:write` + `relationship:write` at the org root — what `/discovery/accept` requires of a
   *  legitimate import since the door began authorizing relationship endpoints (PR #256). */
  let importer: TestUser;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "disc-rel");
    importer = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Plugin drivers — each returns the REAL proposal, over a stub http client keyed by path.
  // -------------------------------------------------------------------------------------------

  /** A `PluginContext` whose http client answers from a canned path -> body map and 404s otherwise.
   *  A MISS is deliberately a 404 rather than a throw: every discover() here treats a non-2xx as
   *  "nothing to see", so a typo'd path would silently yield an empty proposal — which the
   *  per-plugin object-count assertions below catch. */
  function stubCtx(config: unknown, routes: Record<string, unknown>): PluginContext {
    return {
      orgId: org.orgId,
      scopeKey: "default",
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {}
      } as unknown as PluginContext["logger"],
      secrets: {
        get: async (key: string) => (key === "gh-key" ? GITHUB_PRIVATE_KEY : undefined)
      } as unknown as PluginContext["secrets"],
      http: {
        async request(req: ScopedHttpRequest): Promise<ScopedHttpResponse> {
          const url = new URL(req.url);
          const body = routes[`${req.method} ${url.pathname}${url.search}`];
          return body === undefined
            ? { status: 404, headers: {}, body: undefined }
            : { status: 200, headers: {}, body };
        }
      },
      config
    };
  }

  /** A throwaway RSA key so the github plugin's app-JWT signing is exercised for real rather than
   *  stubbed out — the token exchange is the only reason its driver differs from the other two. */
  const GITHUB_PRIVATE_KEY = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;

  interface PluginCase {
    /** The plugin, its config, and the canned API responses that make it find one component. */
    readonly name: string;
    readonly plugin: () => DiscoveryPlugin;
    /** `repo` and `dir` are generated per call — see `proposalFrom` for why `dir` must vary. */
    readonly build: (
      repo: string,
      dir: string
    ) => { config: unknown; routes: Record<string, unknown> };
    /** The name the plugin gives the proposed SERVICE object for this repo. */
    readonly serviceName: (repo: string) => string;
  }

  const OWNER = "acme";

  const PLUGIN_CASES: PluginCase[] = [
    {
      name: "gitea",
      plugin: createGiteaDiscoveryPlugin,
      serviceName: (repo) => repo,
      build: (repo, dir) => ({
        config: { baseUrl: "https://gitea.example.com", owner: OWNER, repo, tokenPlaintext: "pat" },
        routes: {
          [`GET /api/v1/repos/${OWNER}/${repo}/contents/`]: [{ name: dir, path: dir, type: "dir" }],
          [`GET /api/v1/repos/${OWNER}/${repo}/contents/${dir}`]: [
            { name: "go.mod", path: `${dir}/go.mod`, type: "file" }
          ]
        }
      })
    },
    {
      name: "github",
      plugin: createGithubDiscoveryPlugin,
      serviceName: (repo) => repo,
      build: (repo, dir) => ({
        config: {
          apiBaseUrl: "https://api.github.com",
          appId: `app-${repo}`,
          installationId: `inst-${repo}`,
          owner: OWNER,
          repo,
          privateKeySecretKey: "gh-key"
        },
        routes: {
          [`POST /app/installations/inst-${repo}/access_tokens`]: {
            token: "ghs-test",
            expires_at: new Date(Date.now() + 3_600_000).toISOString()
          },
          [`GET /repos/${OWNER}/${repo}/contents/`]: [{ name: dir, path: dir, type: "dir" }],
          [`GET /repos/${OWNER}/${repo}/contents/${dir}`]: [
            { name: "go.mod", path: `${dir}/go.mod`, type: "file" }
          ]
        }
      })
    },
    {
      name: "gitlab",
      plugin: createGitlabDiscoveryPlugin,
      // gitlab names the service after the LAST path segment of `owner/repo`, not the whole path.
      serviceName: (repo) => repo,
      build: (repo, dir) => {
        const project = encodeURIComponent(`${OWNER}/${repo}`);
        return {
          config: {
            baseUrl: "https://gitlab.example.com",
            projectPath: `${OWNER}/${repo}`,
            tokenPlaintext: "pat"
          },
          routes: {
            [`GET /api/v4/projects/${project}/repository/tree?per_page=100`]: [
              { name: dir, path: dir, type: "tree" }
            ],
            [`GET /api/v4/projects/${project}/repository/tree?per_page=100&path=${dir}`]: [
              { name: "go.mod", path: `${dir}/go.mod`, type: "blob" }
            ]
          }
        };
      }
    }
  ];

  /**
   * The plugin's real proposal for a fresh repo, with a fresh COMPONENT DIRECTORY NAME.
   *
   * The directory must vary, and finding out why is worth recording: a proposed component is named
   * after its bare directory, and accept derives `urn:scp:{orgId}:component:{slug(name)}` from that
   * name alone — the repo is nowhere in it. So importing `acme/repo-1/service-a` and then
   * `acme/repo-2/service-a` into one org is a `409 urn ... already in use`, which is what the first
   * run of this file hit with all three cases using `service-a`. That is a real property of the
   * import path (the reviewer is expected to rename), not something this file should paper over —
   * it is called out here so the next reader does not rediscover it as a flake.
   */
  async function proposalFrom(kase: PluginCase, repo: string): Promise<DiscoveryProposal> {
    const { config, routes } = kase.build(repo, `cmp-${randomUUID().slice(0, 8)}`);
    return kase.plugin().discover(stubCtx(config, routes));
  }

  async function accept(proposal: DiscoveryProposal) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/discovery/accept",
      headers: { authorization: `Bearer ${importer.token}` },
      payload: { proposal } as unknown as Record<string, unknown>
    });
  }

  /** Live, non-tombstoned edges of this type between these two objects — read from the TABLE. */
  async function liveEdges(typeId: string, fromId: string, toId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, typeId),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
  }

  async function objectRow(id: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, typeId: objects.typeId, name: objects.name })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, id)))
    );
    return rows[0]!;
  }

  // -------------------------------------------------------------------------------------------
  // THE CROSSING — one case per plugin, each importing that plugin's own proposal VERBATIM.
  // -------------------------------------------------------------------------------------------

  it.each(PLUGIN_CASES.map((c) => [c.name, c] as const))(
    "%s: the plugin's own discover() proposal imports VERBATIM and the contains row lands",
    async (_name, kase) => {
      const repo = `widgets-${randomUUID().slice(0, 8)}`;
      const proposal = await proposalFrom(kase, repo);

      // The proposal is what the plugin produced, not what this test wants it to be — if the stub
      // routes ever stop matching, these two catch it here instead of turning the real assertion
      // below into a vacuous pass over an empty array.
      expect(proposal.objects).toHaveLength(2);
      expect(proposal.relationships).toHaveLength(1);
      expect(proposal.relationships[0]?.typeId).toBe("contains");

      // ACCEPTED VERBATIM. No `relationships: []`, no renaming, no reshaping — the exact object the
      // plugin returned. That is the only version of this test that measures the production path.
      const res = await accept(proposal);
      expect(res.statusCode, res.body).toBe(201);

      const body = res.json() as { createdObjectIds: string[]; createdRelationshipIds: string[] };
      expect(body.createdObjectIds).toHaveLength(2);
      expect(body.createdRelationshipIds).toHaveLength(1);

      // Which created id is which comes from the ROWS, not from array order in the response.
      const created = await Promise.all(body.createdObjectIds.map(objectRow));
      const service = created.find((o) => o.typeId === "service");
      const component = created.find((o) => o.typeId === "component");
      expect(service?.name).toBe(kase.serviceName(repo));
      expect(component?.name).toMatch(/^cmp-/);

      expect(
        await liveEdges("contains", service!.id, component!.id),
        "201 with the edge missing is the exact failure this file exists to make impossible"
      ).toHaveLength(1);

      // DIRECTION IS PART OF THE CONTRACT. `contains` is service -> component, and
      // `graph/containment.ts` route 2 walks it backwards on that assumption; a reversed edge would
      // still be one row of the right type between the right two objects.
      expect(await liveEdges("contains", component!.id, service!.id)).toHaveLength(0);
    }
  );

  it("the imported component's containment chain contains its service — the edge is not decoration", async () => {
    // The CONSEQUENCE case. A row of some other type between the same two objects would satisfy
    // every assertion above and still leave the component an orphan for policy scope, RBAC scope
    // expansion, domain inheritance and pipeline resolution — all of which are derived from this
    // chain. This is what makes `contains` the right edge rather than a naming preference.
    const repo = `chain-${randomUUID().slice(0, 8)}`;
    const proposal = await proposalFrom(PLUGIN_CASES[0]!, repo);

    const res = await accept(proposal);
    expect(res.statusCode, res.body).toBe(201);
    const created = await Promise.all(
      (res.json() as { createdObjectIds: string[] }).createdObjectIds.map(objectRow)
    );
    const service = created.find((o) => o.typeId === "service")!;
    const component = created.find((o) => o.typeId === "component")!;

    const chain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      containmentChain(tx, org.orgId, component.id)
    );
    expect(
      chain.map((entry) => entry.id),
      "a component whose chain omits its service is governed by nothing scoped at that service"
    ).toContain(service.id);
  });

  // -------------------------------------------------------------------------------------------
  // THE ALIAS — defect (2). Its own cases, because it is a distinct mechanism from the type name
  // and would otherwise be proven only incidentally by the three above.
  // -------------------------------------------------------------------------------------------

  it("an edge naming a proposed object that declared NO urn is refused, not silently dropped", async () => {
    // The pre-fix behaviour, pinned as the contract for a proposal that omits the alias: the
    // endpoint resolves against nothing and the request fails loudly. A door that skipped
    // unresolvable edges would return 201 having written no relationship — indistinguishable from
    // success, and exactly the shape of the bug this file closes.
    const serviceName = `noalias-svc-${randomUUID().slice(0, 8)}`;
    const componentName = `noalias-cmp-${randomUUID().slice(0, 8)}`;
    const res = await accept({
      objects: [
        { typeId: "service", name: serviceName },
        { typeId: "component", name: componentName }
      ],
      relationships: [
        {
          typeId: "contains",
          fromUrn: "urn:scp:service:gitea:acme/noalias",
          toUrn: "urn:scp:component:gitea:acme/noalias/cmp"
        }
      ]
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).toContain("urn:scp:service:gitea:acme/noalias");
  });

  it("two proposed objects declaring the same alias is a 409 — which object an edge meant would depend on array order", async () => {
    const alias = `urn:scp:service:gitea:acme/dupe-${randomUUID().slice(0, 8)}`;
    const res = await accept({
      objects: [
        { typeId: "service", name: `dupe-a-${randomUUID().slice(0, 8)}`, urn: alias },
        { typeId: "service", name: `dupe-b-${randomUUID().slice(0, 8)}`, urn: alias }
      ],
      relationships: []
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(alias);
  });

  it("an alias that shadows a LIVE object is a 409 — it would redirect an edge onto the new object", async () => {
    const existing = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: `shadowed-${randomUUID().slice(0, 8)}` }
    });
    expect(existing.statusCode, existing.body).toBe(201);
    const existingUrn = (existing.json() as { urn: string }).urn;

    const res = await accept({
      objects: [
        { typeId: "service", name: `shadower-${randomUUID().slice(0, 8)}`, urn: existingUrn }
      ],
      relationships: []
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(existingUrn);
  });

  it("an alias is BATCH-LOCAL: the object is stored under its own derived urn, not the alias", async () => {
    // If the alias were persisted as the object's URN, a second import of the same repo would
    // collide on it and the imported object would carry a URN outside the org-scoped scheme.
    const alias = `urn:scp:service:gitea:acme/local-${randomUUID().slice(0, 8)}`;
    const name = `alias-local-${randomUUID().slice(0, 8)}`;
    const res = await accept({
      objects: [{ typeId: "service", name, urn: alias }],
      relationships: []
    });
    expect(res.statusCode, res.body).toBe(201);

    const id = (res.json() as { createdObjectIds: string[] }).createdObjectIds[0]!;
    const stored = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select({ urn: objects.urn }).from(objects).where(eq(objects.id, id))
    );
    expect(stored[0]?.urn).toBe(`urn:scp:${org.orgId}:service:${name}`);
    expect(stored[0]?.urn).not.toBe(alias);
  });
});

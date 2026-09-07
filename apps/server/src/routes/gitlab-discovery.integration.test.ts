import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, relationships } from "../db/schema.js";
import { processChangeSourceEvents } from "../coordination/webhook-processor.js";

/** M15.3b end-to-end — the GitLab `DiscoveryPlugin`. See docs/routes.md §217. */
describe("M15.3b: gitlab-discovery import loop (BYO GitLab → proposal → land → self-report)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gitlab: Server;
  let gitlabBaseUrl: string;
  const projectPath = "acme/widgets";
  const projectIdEncoded = encodeURIComponent(projectPath);
  const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

  // A minimal, REAL GitLab repository-tree server. Requires `PRIVATE-TOKEN: <PAT>` (proving the
  // resolved secret threaded through) and keys the project on the URL-encoded `owner%2Frepo` :id.
  function startGitlabMock(): Promise<{ srv: Server; baseUrl: string }> {
    const srv = createServer((req, res) => {
      if (req.headers["private-token"] !== "gitlab-e2e-pat") {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "401 Unauthorized" }));
        return;
      }
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      const treePath = `/api/v4/projects/${projectIdEncoded}/repository/tree`;
      if (url.pathname === treePath) {
        res.setHeader("content-type", "application/json");
        const path = url.searchParams.get("path");
        if (!path) {
          res.end(
            JSON.stringify([
              { name: "service-a", path: "service-a", type: "tree" },
              { name: "docs", path: "docs", type: "tree" },
              { name: "README.md", path: "README.md", type: "blob" } // not a tree
            ])
          );
          return;
        }
        if (path === "service-a") {
          res.end(
            JSON.stringify([
              { name: "go.mod", path: "service-a/go.mod", type: "blob" },
              { name: "main.go", path: "service-a/main.go", type: "blob" }
            ])
          );
          return;
        }
        if (path === "docs") {
          res.end(JSON.stringify([{ name: "index.md", path: "docs/index.md", type: "blob" }]));
          return;
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `unexpected path ${req.url}` }));
    });
    return new Promise((resolve) => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
  }

  beforeAll(async () => {
    // Layer 1 of the two-layer internal-egress grant (ADR-0003) — the operator allowlist. Set BEFORE
    // the server boots so the request-time resolver reads it. 127.0.0.1 is the loopback GitLab mock.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    ({ srv: gitlab, baseUrl: gitlabBaseUrl } = await startGitlabMock());
    // withReconcileLoop wires a real SubprocessPluginHost onto deps.pluginHost — /discovery/run
    // fail-closes without one (the API-only-role guard). This is the SCP_ROLE=all equivalent.
    server = await listenTestServer({
      // `withPluginHost`, NOT `withReconcileLoop`. See docs/routes.md §218.
      withPluginHost: true
    });
    org = await createTestOrg(server, "m15-gitlab-discovery");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => gitlab?.close(() => resolve()));
    if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
    else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
  });

  /** Insert one unprocessed event and run the processor (bypasses HTTP/token — correlation is the
   *  subject here). Returns the resulting change object id, or null when nothing correlated. */
  async function reportAndProcess(
    sourceKind: string,
    payload: Record<string, unknown>
  ): Promise<string | null> {
    const eventId = uuidv7();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.insert(changeSourceEvents).values({
        id: eventId,
        orgId: org.orgId,
        sourceKind,
        signatureVerified: true,
        dedupeKey: `test:${eventId}`,
        headers: {},
        payload
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    return rows[0]?.resultingChangeObjectId ?? null;
  }

  it("runs gitlab-discovery against a BYO GitLab, lands the proposal's component, and it self-reports a gitlab event", async () => {
    // Register the BYO GitLab as an execution-system (kind=gitlab) with declared internal-egress
    // intent (layer 2). The token lives in the secrets table, referenced by key — never on the object.
    await admin.secrets.put("gitlab-e2e-token", { value: "gitlab-e2e-pat" });
    const sys = await admin.object("execution-system").create({
      name: `gitlab-byo-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "gitlab",
        serverUrl: gitlabBaseUrl,
        tokenSecretKey: "gitlab-e2e-token",
        allowInternalEgress: true // layer 2; layer 1 is SCP_INTERNAL_EGRESS_HOSTS
      }
    });

    // 1) RUN — a real subprocess plugin-host scan. The config carries NO baseUrl: the gitlab adapter
    //    resolves its REST base from the injected serverUrl (the execution-system's own serverUrl,
    //    pinned to the egress-allowed host) — exactly what makes importing an EXISTING (Mode A) GitLab
    //    reach it. Only projectPath is the adapter's own per-run config field.
    const proposal = await admin.discovery.run({
      pluginModule: "gitlab-discovery",
      pluginInstanceId: `gitlab-disc-${randomUUID().slice(0, 8)}`,
      config: {
        executionSystemId: sys.id,
        projectPath
      }
    });

    // One Service (repo root) + one Component (service-a, the go.mod dir); docs has no marker → skipped.
    const services = proposal.objects.filter((o) => o.typeId === "service");
    const components = proposal.objects.filter((o) => o.typeId === "component");
    expect(services).toHaveLength(1);
    expect(components).toHaveLength(1);
    const component = components[0]!;
    expect(component.name).toBe("service-a");
    const sourceMapping = component.properties?.sourceMapping as
      { sourceKind?: string; repoPattern?: string; pathPattern?: string } | undefined;
    expect(sourceMapping?.sourceKind).toBe("gitlab");
    expect(sourceMapping?.repoPattern).toBe(projectPath);
    expect(sourceMapping?.pathPattern).toBe("service-a/**");
    expect(proposal.relationships).toEqual([
      {
        typeId: "contains",
        fromUrn: `urn:scp:service:gitlab:${projectPath}`,
        toUrn: `urn:scp:component:gitlab:${projectPath}/service-a`
      }
    ]);

    // 2) ACCEPT — the only path that writes. See docs/routes.md §219.
    const uniqueName = `${component.name}-${randomUUID().slice(0, 8)}`;
    const uniqueServiceName = `${services[0]!.name}-${randomUUID().slice(0, 8)}`;
    // LANDED THROUGH THE ORDINARY DOORS, not `discovery/accept`. See docs/routes.md §220.
    const importedService = await admin.services.create({ name: uniqueServiceName });
    const imported = await admin.components.create({
      name: uniqueName,
      service: importedService.id
    });
    await admin.changeSources.createMapping("gitlab", {
      component: imported.id,
      repoPattern: sourceMapping!.repoPattern!,
      ...(sourceMapping!.pathPattern ? { pathPattern: sourceMapping!.pathPattern } : {}),
      type: "configuration"
    });

    // The `contains` edge the typed component door writes atomically — asserted from the TABLE, as
    // before, because a returned id is not a row.
    const edges = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          typeId: relationships.typeId,
          fromId: relationships.fromId,
          toId: relationships.toId
        })
        .from(relationships)
        .where(eq(relationships.toId, imported.id))
    );
    expect(edges.some((e) => e.typeId === "contains" && e.fromId === importedService.id)).toBe(
      true
    );

    const componentId = imported.id;

    // 3) The imported component's gitlab source_mapping exists and is listable under 'gitlab'.
    const mappings = await admin.changeSources.listMappings("gitlab");
    expect(
      mappings.items.some(
        (m) => m.componentObjectId === componentId && m.repoPattern === projectPath
      )
    ).toBe(true);

    // 4) SELF-REPORT — a gitlab observed event on the mapped repo/path correlates to a Change. This is
    //    the closed observe-correlation gap: sourceKind='gitlab' wires the event to the import.
    const changeId = await reportAndProcess("gitlab", {
      repo: projectPath,
      path: "service-a/deploy.yaml", // must satisfy the mapping's pathPattern 'service-a/**'
      correlationKey: "refs/heads/main"
    });
    expect(changeId).not.toBeNull();
    const change = await admin.changes.get(changeId!);
    expect(change.state).toBe("proposed");

    // Control: a gitlab event on a DIFFERENT repo has no mapping → correlates against nothing → drops.
    const orphan = await reportAndProcess("gitlab", {
      repo: `unmapped/${randomUUID().slice(0, 8)}`,
      correlationKey: "refs/heads/main"
    });
    expect(orphan).toBeNull();
  });
});

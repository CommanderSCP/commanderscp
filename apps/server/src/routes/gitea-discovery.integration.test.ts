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
import { changeSourceEvents } from "../db/schema.js";
import { processChangeSourceEvents } from "../coordination/webhook-processor.js";

/**
 * M15.3a end-to-end — the Gitea `DiscoveryPlugin` (gitea-discovery) proves the FULL import loop for a
 * bring-your-own Gitea, not just the plugin's own nock unit test:
 *   POST /discovery/run (module gitea-discovery, backed by an execution-system kind=gitea) →
 *   a real subprocess plugin-host scan of a live (in-process) Gitea contents API →
 *   proposal carrying a Component whose sourceMapping.sourceKind is 'gitea' →
 *   POST /discovery/accept imports objects + source_mappings →
 *   the imported component SELF-REPORTS: a gitea observed event on its repo/path correlates to a
 *   Change. sourceKind='gitea' is the load-bearing link — it matches the gitea EXECUTOR's
 *   source_kind, so pulled gitea events correlate against the imported component (before this,
 *   nothing produced a gitea-kinded source_mapping, so gitea events correlated against nothing).
 *
 * The Gitea instance is a real loopback (127.0.0.1) HTTP server: the plugin-host subprocess makes
 * genuine undici calls to it (nock can't reach across the subprocess boundary). Reaching loopback is
 * gated by BOTH the operator allowlist (SCP_INTERNAL_EGRESS_HOSTS, set here) AND the execution-
 * system's `allowInternalEgress` intent (ADR-0003 two-layer) — exactly the path a self-hosted /
 * air-gapped Gitea outpost uses, so this also exercises that egress grant end to end.
 */
describe("M15.3a: gitea-discovery import loop (BYO Gitea → proposal → accept → self-report)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gitea: Server;
  let giteaBaseUrl: string;
  const owner = "acme";
  const repo = "widgets";
  const OWNER_REPO = `${owner}/${repo}`;
  const prevEgressHosts = process.env.SCP_INTERNAL_EGRESS_HOSTS;

  // A minimal, REAL Gitea contents-API server (GitHub-compatible shapes). Two paths: the repo root
  // listing and one top-level dir carrying a go.mod marker. Requires the `Authorization: token <PAT>`
  // header the gitea adapter sends — proving the resolved secret actually threaded through.
  function startGiteaMock(): Promise<{ srv: Server; baseUrl: string }> {
    const srv = createServer((req, res) => {
      const auth = req.headers["authorization"];
      if (auth !== "token gitea-e2e-pat") {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: "bad token" }));
        return;
      }
      const url = req.url ?? "";
      if (url === `/api/v1/repos/${owner}/${repo}/contents/`) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify([
            { name: "service-a", path: "service-a", type: "dir" },
            { name: "docs", path: "docs", type: "dir" }, // no marker inside → skipped
            { name: "README.md", path: "README.md", type: "file" } // not a dir → no contents call
          ])
        );
        return;
      }
      if (url === `/api/v1/repos/${owner}/${repo}/contents/service-a`) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify([
            { name: "go.mod", path: "service-a/go.mod", type: "file" },
            { name: "main.go", path: "service-a/main.go", type: "file" }
          ])
        );
        return;
      }
      if (url === `/api/v1/repos/${owner}/${repo}/contents/docs`) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "index.md", path: "docs/index.md", type: "file" }]));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `unexpected path ${url}` }));
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
    // the server boots so the request-time resolver (routes/executors.ts's resolveInternalEgress)
    // reads it. 127.0.0.1 is where the loopback Gitea mock listens.
    process.env.SCP_INTERNAL_EGRESS_HOSTS = "127.0.0.1";
    ({ srv: gitea, baseUrl: giteaBaseUrl } = await startGiteaMock());
    // withReconcileLoop wires a real SubprocessPluginHost onto deps.pluginHost — /discovery/run
    // fail-closes without one (the API-only-role guard). This is the SCP_ROLE=all equivalent.
    server = await listenTestServer({ withEventRelay: true, withReconcileLoop: true });
    org = await createTestOrg(server, "m15-gitea-discovery");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => gitea?.close(() => resolve()));
    if (prevEgressHosts === undefined) delete process.env.SCP_INTERNAL_EGRESS_HOSTS;
    else process.env.SCP_INTERNAL_EGRESS_HOSTS = prevEgressHosts;
  });

  /** Insert one unprocessed event and run the processor (bypasses HTTP/HMAC — correlation is the
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

  it("runs gitea-discovery against a BYO Gitea, imports the proposal, and the component self-reports a gitea event", async () => {
    // Register the BYO Gitea as an execution-system (kind=gitea) with declared internal-egress intent
    // (layer 2). The token lives in the secrets table, referenced by key — never on the object.
    await admin.secrets.put("gitea-e2e-token", { value: "gitea-e2e-pat" });
    const sys = await admin.object("execution-system").create({
      name: `gitea-byo-${randomUUID().slice(0, 8)}`,
      properties: {
        kind: "gitea",
        serverUrl: giteaBaseUrl,
        tokenSecretKey: "gitea-e2e-token",
        allowInternalEgress: true // layer 2 of the two-layer grant; layer 1 is SCP_INTERNAL_EGRESS_HOSTS
      }
    });

    // 1) RUN — a real subprocess plugin-host scan. `executionSystemId` names the system whose
    //    (server-governed) serverUrl/token/egress the run uses; baseUrl/owner/repo are the gitea
    //    adapter's own config fields (it reads `baseUrl`, not the generic `serverUrl`).
    const proposal = await admin.discovery.run({
      pluginModule: "gitea-discovery",
      pluginInstanceId: `gitea-disc-${randomUUID().slice(0, 8)}`,
      config: {
        executionSystemId: sys.id,
        baseUrl: giteaBaseUrl,
        owner,
        repo
      }
    });

    // The scan proposes one Service (repo root) + one Component (service-a, the go.mod dir); docs has
    // no marker → skipped. The component's sourceMapping is gitea-kinded — the whole point.
    const services = proposal.objects.filter((o) => o.typeId === "service");
    const components = proposal.objects.filter((o) => o.typeId === "component");
    expect(services).toHaveLength(1);
    expect(components).toHaveLength(1);
    const component = components[0]!;
    expect(component.name).toBe("service-a");
    const sourceMapping = component.properties?.sourceMapping as
      | { sourceKind?: string; repoPattern?: string; pathPattern?: string }
      | undefined;
    expect(sourceMapping?.sourceKind).toBe("gitea");
    expect(sourceMapping?.repoPattern).toBe(OWNER_REPO);
    expect(sourceMapping?.pathPattern).toBe("service-a/**");
    expect(proposal.relationships).toEqual([
      {
        typeId: "part_of",
        fromUrn: `urn:scp:component:gitea:${OWNER_REPO}/service-a`,
        toUrn: `urn:scp:service:gitea:${OWNER_REPO}`
      }
    ]);

    // 2) ACCEPT — the only path that writes. Carry the proposal's objects/relationships through, and
    //    turn the component's carried sourceMapping into a `sourceMappings[]` entry (the shape accept
    //    persists) so the import self-reports. This is exactly the transform a UI/CLI review does.
    const uniqueName = `${component.name}-${randomUUID().slice(0, 8)}`;
    const accept = await admin.discovery.accept({
      proposal: {
        objects: [
          { typeId: "component", name: uniqueName, properties: component.properties ?? {} }
        ],
        relationships: [],
        sourceMappings: [
          {
            objectName: uniqueName,
            sourceKind: "gitea",
            repoPattern: sourceMapping!.repoPattern,
            pathPattern: sourceMapping!.pathPattern
          }
        ]
      }
    });
    expect(accept.createdObjectIds).toHaveLength(1);
    expect(accept.createdSourceMappingIds).toHaveLength(1);
    const componentId = accept.createdObjectIds[0]!;

    // 3) The imported component's gitea source_mapping exists and is listable under 'gitea'.
    const mappings = await admin.changeSources.listMappings("gitea");
    expect(
      mappings.items.some(
        (m) => m.componentObjectId === componentId && m.repoPattern === OWNER_REPO
      )
    ).toBe(true);

    // 4) SELF-REPORT — a gitea observed event on the mapped repo/path correlates to a Change. This is
    //    the closed observe-correlation gap: sourceKind='gitea' is what wires the event to the import.
    const changeId = await reportAndProcess("gitea", {
      repo: OWNER_REPO,
      path: "service-a/deploy.yaml", // must satisfy the mapping's pathPattern 'service-a/**'
      correlationKey: "refs/heads/main"
    });
    expect(changeId).not.toBeNull();
    const change = await admin.changes.get(changeId!);
    expect(change.state).toBe("proposed");

    // Control: a gitea event on a DIFFERENT repo has no mapping → correlates against nothing → drops.
    const orphan = await reportAndProcess("gitea", {
      repo: `unmapped/${randomUUID().slice(0, 8)}`,
      correlationKey: "refs/heads/main"
    });
    expect(orphan).toBeNull();
  });
});

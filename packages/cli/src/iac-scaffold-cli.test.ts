import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryProposal, GraphObject, RunDiscoveryRequest } from "@scp/schemas";

/**
 * `scp iac scaffold` — DRIVEN through `buildProgram().parseAsync([...])` against a stubbed
 * `@scp/sdk` (house pattern). What matters here — and what a unit test of `groupDiscoveryProposal`
 * alone cannot pin — is that the ACTION BODY resolves the execution-system into a discovery request,
 * calls `discovery.run`, and prints the grouped/ungrouped split honestly (ADR-0047's whole point:
 * "the orphan problem is solved at authoring time" only holds if ungrouped components are actually
 * loud here, not just correctly computed by a pure function nothing calls).
 */

const EXECUTION_SYSTEM_ID = "0198f000-0000-7000-8000-000000000001";
const EXECUTION_SYSTEM_URN = "urn:scp:acme:execution-system:argocd-prod";

const executionSystem: GraphObject = {
  id: EXECUTION_SYSTEM_ID,
  orgId: "0198f000-0000-7000-8000-0000000000aa",
  domainId: null,
  typeId: "execution-system",
  name: "argocd-prod",
  urn: EXECUTION_SYSTEM_URN,
  properties: {
    kind: "argocd",
    serverUrl: "https://argocd.internal",
    tokenSecretKey: "argocd-tok"
  },
  labels: {},
  originDomainId: "0198f000-0000-7000-8000-0000000000aa",
  revision: 1,
  provenance: null,
  domainLocal: false,
  domainLocalInheritedFrom: null,
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null
} as GraphObject;

const proposal: DiscoveryProposal = {
  objects: [
    { typeId: "component", name: "checkout-api", properties: { sourceRepo: "checkout/api" } },
    { typeId: "component", name: "mystery-app", properties: {} }
  ],
  relationships: [],
  sourceMappings: [
    {
      objectName: "checkout-api",
      sourceKind: "github",
      repoPattern: "acme/checkout-api",
      type: "configuration"
    }
  ]
};

const discoveryRunCalls: RunDiscoveryRequest[] = [];
const objectGetCalls: { typeId: string; idOrUrn: string }[] = [];

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    discovery = {
      run: async (req: RunDiscoveryRequest) => {
        discoveryRunCalls.push(req);
        return proposal;
      }
    };
    object(typeId: string) {
      return {
        get: async (idOrUrn: string) => {
          objectGetCalls.push({ typeId, idOrUrn });
          if (typeId === "execution-system") return executionSystem;
          throw new Error(`unexpected object(${typeId}).get(${idOrUrn})`);
        }
      };
    }
  }
  return { ScpClient, ScpApiError, reconcileStaleClaimants: () => null };
});

let configDir: string;
const savedEnv = { ...process.env };
let logged: string[] = [];

async function run(args: string[]): Promise<void> {
  const { buildProgram } = await import("./cli.js");
  await buildProgram().parseAsync(["node", "scp", "iac", "scaffold", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
});

beforeEach(async () => {
  discoveryRunCalls.length = 0;
  objectGetCalls.length = 0;
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-iac-scaffold-"));
  process.env.SCP_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, "credentials.json"),
    JSON.stringify({
      baseUrl: "http://localhost:8080/api/v1",
      token: "tok",
      org: "acme",
      expiresAt: "2030-01-01T00:00:00Z"
    })
  );
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(configDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
  process.exitCode = undefined;
});

describe("scp iac scaffold — resolving the execution system into a discovery request", () => {
  it("reads the execution-system object and derives pluginModule/config/secretRefs from it", async () => {
    await run(["--from", EXECUTION_SYSTEM_URN, "--group", "checkout-api=payments"]);
    expect(objectGetCalls).toEqual([{ typeId: "execution-system", idOrUrn: EXECUTION_SYSTEM_URN }]);
    expect(discoveryRunCalls).toEqual([
      {
        pluginModule: "argocd-discovery",
        pluginInstanceId: "argocd-prod",
        config: {
          executionSystemId: EXECUTION_SYSTEM_ID,
          serverUrl: "https://argocd.internal",
          tokenSecretKey: "argocd-tok"
        },
        secretRefs: { "argocd-tok": "argocd-tok" }
      }
    ]);
  });
});

describe("scp iac scaffold — grouping (ADR-0047)", () => {
  it("emits construct code only for GROUPED components, under the named service", async () => {
    await run(["--from", EXECUTION_SYSTEM_URN, "--group", "checkout-api=payments"]);
    const out = logged.join("\n");
    expect(out).toContain("service: payments");
    expect(out).toContain('new Component(stack, "checkout-api"');
    // The grouped component's proposed source mapping made it in as a real, non-placeholder repo.
    expect(out).toContain('repo: "acme/checkout-api"');
    expect(out).not.toContain('new Component(stack, "mystery-app"');
  });

  it("UNGROUPED components are reported LOUDLY, never silently included or silently dropped", async () => {
    await run(["--from", EXECUTION_SYSTEM_URN, "--group", "checkout-api=payments"]);
    const out = logged.join("\n");
    expect(out).toMatch(/UNGROUPED \(1\)/);
    expect(out).toContain("mystery-app");
    expect(out).toMatch(/--group/);
  });

  it("with NO --group at all, every discovered component is ungrouped and NOTHING is emitted as code", async () => {
    await run(["--from", EXECUTION_SYSTEM_URN]);
    const out = logged.join("\n");
    expect(out).not.toContain("new Component(");
    expect(out).toMatch(/UNGROUPED \(2\)/);
    expect(out).toContain("checkout-api");
    expect(out).toContain("mystery-app");
  });

  it("--group-file merges with --group, which takes precedence on a conflict", async () => {
    const groupFile = path.join(configDir, "groups.json");
    await writeFile(
      groupFile,
      JSON.stringify({ "checkout-api": "file-service", "mystery-app": "file-service" })
    );
    await run([
      "--from",
      EXECUTION_SYSTEM_URN,
      "--group-file",
      groupFile,
      "--group",
      "checkout-api=flag-service"
    ]);
    const out = logged.join("\n");
    // --group wins for checkout-api: it lands under "flag-service", not the file's "file-service".
    expect(out).toContain("service: flag-service");
    expect(out).toContain('new Component(stack, "checkout-api"');
    const flagServiceBlock = out.slice(out.indexOf("service: flag-service"));
    expect(flagServiceBlock).not.toContain('new Component(stack, "mystery-app"');
    // mystery-app, named ONLY in the file (never overridden by --group), still lands under it.
    expect(out).toContain("service: file-service");
    expect(out).toContain('new Component(stack, "mystery-app"');
  });

  it("--output-dir writes one file per service and says how many placeholders each got", async () => {
    const outDir = path.join(configDir, "out");
    await run([
      "--from",
      EXECUTION_SYSTEM_URN,
      "--group",
      "checkout-api=payments",
      "--group",
      "mystery-app=payments",
      "--output-dir",
      outDir
    ]);
    const written = await readFile(path.join(outDir, "payments.scaffold.ts"), "utf8");
    expect(written).toContain('new Component(stack, "checkout-api"');
    expect(written).toContain('new Component(stack, "mystery-app"');
    // `mystery-app` had no proposed source mapping — it gets the loud placeholder.
    expect(written).toContain("SCP-EXPORT PLACEHOLDER");
    const out = logged.join("\n");
    expect(out).toMatch(/Wrote .*payments\.scaffold\.ts \(2 component\(s\), 1 placeholder\(s\)\)/);
  });

  it("emits the §8 commented starter wave topology guidance", async () => {
    await run(["--from", EXECUTION_SYSTEM_URN, "--group", "checkout-api=payments"]);
    const out = logged.join("\n");
    expect(out).toContain("Starter wave topology");
    expect(out).toContain("staging");
    expect(out).toContain("production");
    expect(out).not.toMatch(/\bgamma\b/i);
  });
});

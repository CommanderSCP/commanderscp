import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphObject, Relationship, SourceMapping } from "@scp/schemas";

/**
 * `scp iac export` — DRIVEN through `buildProgram().parseAsync([...])` against a stubbed `@scp/sdk`
 * (the house pattern: `outpost-reconcile-precondition.test.ts`/`dependency-read-verbs-wire.test.ts`).
 * What matters here is CLI wiring and honesty, not the emitter's own logic — `@scp/iac`'s
 * `estate-program.test.ts` and this package's `iac-estate-program.roundtrip.test.ts` already prove
 * the emitter itself (round-trip, typecheck, placeholder behavior). This file proves the ACTION BODY
 * actually calls `readServiceExportSpec` off the SDK and prints its answer honestly, including the
 * placeholder count.
 */

const SERVICE_ID = "0198f000-0000-7000-8000-000000000001";
const COMPONENT_ID = "0198f000-0000-7000-8000-000000000002";
const TARGET_ID = "0198f000-0000-7000-8000-000000000003";
const TOPOLOGY_ID = "0198f000-0000-7000-8000-000000000004";

function graphObject(overrides: Partial<GraphObject>): GraphObject {
  return {
    id: "0198f000-0000-7000-8000-000000000000",
    orgId: "0198f000-0000-7000-8000-0000000000aa",
    domainId: null,
    typeId: "service",
    name: "unnamed",
    urn: "urn:scp:acme:service:unnamed",
    properties: {},
    labels: {},
    originDomainId: "0198f000-0000-7000-8000-0000000000aa",
    revision: 1,
    provenance: null,
    domainLocal: false,
    domainLocalInheritedFrom: null,
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  } as GraphObject;
}

const service = graphObject({
  id: SERVICE_ID,
  typeId: "service",
  name: "Payments",
  urn: "urn:scp:acme:service:payments"
});
const component = graphObject({
  id: COMPONENT_ID,
  typeId: "component",
  name: "payments-api",
  urn: "urn:scp:acme:component:payments-api"
});
const target = graphObject({
  id: TARGET_ID,
  typeId: "deployment-target",
  name: "commercial-amer-production",
  urn: "urn:scp:acme:deployment-target:commercial-amer-production"
});
const executionSystem = graphObject({
  id: "0198f000-0000-7000-8000-000000000005",
  typeId: "execution-system",
  name: "org-registry",
  urn: "urn:scp:acme:execution-system:org-registry",
  properties: { kind: "harbor" }
});
const topology = graphObject({
  id: TOPOLOGY_ID,
  typeId: "release-topology",
  name: "payments-api-image-pipeline",
  urn: "urn:scp:acme:release-topology:payments-api-image-pipeline",
  properties: {
    waves: [{ name: "production", mode: "parallel", targets: [target.urn] }]
  }
});

const containsRel: Relationship = {
  id: "0198f000-0000-7000-8000-000000000010",
  orgId: service.orgId,
  typeId: "contains",
  fromId: SERVICE_ID,
  toId: COMPONENT_ID,
  properties: {},
  labels: {},
  originDomainId: service.orgId,
  revision: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null
};
const releasesViaRel: Relationship = {
  ...containsRel,
  id: "0198f000-0000-7000-8000-000000000011",
  typeId: "releases_via",
  fromId: COMPONENT_ID,
  toId: TOPOLOGY_ID,
  properties: { type: "image" }
};
const publishesToRel: Relationship = {
  ...containsRel,
  id: "0198f000-0000-7000-8000-000000000012",
  typeId: "publishes_to",
  fromId: COMPONENT_ID,
  toId: executionSystem.id,
  properties: { repository: "payments/payments-api" }
};

const placementObject = graphObject({
  id: "0198f000-0000-7000-8000-000000000020",
  typeId: "placement",
  name: "payments-api@commercial-amer-production",
  urn: "urn:scp:acme:placement:payments-api-commercial-amer-production",
  properties: { componentId: COMPONENT_ID, deploymentTargetId: TARGET_ID }
});

const giteaMapping: SourceMapping = {
  id: "0198f000-0000-7000-8000-000000000030",
  orgId: service.orgId,
  sourceKind: "gitea",
  repoPattern: "payments/payments-api",
  pathPattern: null,
  refPattern: "refs/heads/main",
  componentObjectId: COMPONENT_ID,
  type: "image",
  category: "build",
  classification: null,
  mirrorOfShared: false,
  enabled: true,
  disabledUntil: null,
  effectivelyEnabled: true,
  scope: null,
  createdAt: "2026-08-01T00:00:00.000Z"
};

const listMappingsCalls: string[] = [];

vi.mock("@scp/sdk", () => {
  class ScpApiError extends Error {}
  class ScpClient {
    services = { get: async (idOrUrn: string) => (idOrUrn === service.urn ? service : service) };
    components = { get: async (_id: string) => component };
    relationships = {
      list: async (q: { fromId: string; typeId: string }) => {
        const all = [containsRel, releasesViaRel, publishesToRel];
        return { items: all.filter((r) => r.fromId === q.fromId && r.typeId === q.typeId) };
      }
    };
    placements = {
      list: async (_q: { component: string }) => ({ items: [placementObject] })
    };
    deploymentTargets = { get: async (_id: string) => target };
    changeSources = {
      listMappings: async (sourceKind: string) => {
        listMappingsCalls.push(sourceKind);
        return { items: sourceKind === "gitea" ? [giteaMapping] : [] };
      }
    };
    object(typeId: string) {
      return {
        get: async (id: string) => {
          if (typeId === "release-topology") return topology;
          if (typeId === "execution-system") return executionSystem;
          throw new Error(`unexpected object(${typeId}).get(${id})`);
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
  await buildProgram().parseAsync(["node", "scp", "iac", "export", ...args]);
}

beforeAll(async () => {
  await import("./cli.js");
});

beforeEach(async () => {
  listMappingsCalls.length = 0;
  logged = [];
  configDir = await mkdtemp(path.join(tmpdir(), "scp-iac-export-"));
  process.env.SCP_CONFIG_DIR = configDir;
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(
      path.join(configDir, "credentials.json"),
      JSON.stringify({
        baseUrl: "http://localhost:8080/api/v1",
        token: "tok",
        org: "acme",
        expiresAt: "2030-01-01T00:00:00Z"
      })
    )
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

describe("scp iac export --format ts", () => {
  it("emits construct code for the scope's subtree and reports 0 placeholders when a mapping exists", async () => {
    await run(["--scope", service.urn]);
    expect(listMappingsCalls).toEqual(["gitea"]); // the default, probed exactly once
    const out = logged.join("\n");
    expect(out).toContain("new Component(stack,");
    expect(out).toContain('urn: "urn:scp:acme:component:payments-api"');
    expect(out).toContain("new ImagePipeline(");
    expect(out).toContain('repo: "payments/payments-api"');
    expect(out).toContain("DeploymentTarget.fromUrn(");
    expect(out).toMatch(/Exported 1 component\(s\)/);
    expect(out).toMatch(/0 pipeline\(s\) had no source mapping/);
    // The summary line itself always names the marker as guidance text; what must be ABSENT is an
    // actual placeholder BLOCK (the `!!!`-bracketed form `renderEstateProgram` only emits per D18 gap).
    expect(out).not.toContain("!!! SCP-EXPORT PLACEHOLDER");
  });

  it("threads --source-kind into changeSources.listMappings", async () => {
    await run(["--scope", service.urn, "--source-kind", "gitea,github"]);
    expect(listMappingsCalls.sort()).toEqual(["gitea", "github"]);
  });

  it("--output writes the file instead of stdout, and says so", async () => {
    const outPath = path.join(configDir, "stack.ts");
    await run(["--scope", service.urn, "--output", outPath]);
    const written = await readFile(outPath, "utf8");
    expect(written).toContain("new Component(stack,");
    const out = logged.join("\n");
    expect(out).toContain(`Wrote construct code to ${outPath}`);
  });

  it("refuses an unknown --format before touching the network", async () => {
    listMappingsCalls.length = 0;
    await expect(run(["--scope", service.urn, "--format", "yaml"])).rejects.toThrow(/--format/);
    expect(listMappingsCalls).toEqual([]);
  });
});

describe("scp iac export --format json", () => {
  it("emits the synthesized manifest, not construct code", async () => {
    await run(["--scope", service.urn, "--format", "json"]);
    const jsonLine = logged.find((l) => l.trim().startsWith("{"));
    expect(jsonLine).toBeDefined();
    const manifest = JSON.parse(jsonLine!) as { objects: { urn: string }[] };
    expect(manifest.objects.some((o) => o.urn === "urn:scp:acme:component:payments-api")).toBe(
      true
    );
  });
});

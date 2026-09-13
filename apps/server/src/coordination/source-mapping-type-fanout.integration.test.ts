import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { matchComponentsForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** One release per matched TYPE (journey-view §8.7 D2, ADR-0007 / M12 P4A).
 *
 *  The regression this file exists to hold down: `matchComponentForSource` returned the single
 *  highest-ranked match, and Rule 1 ranks by how many globs are set, so a `chart/**` mapping
 *  outranks a whole-repo `image` mapping. A push touching BOTH arms therefore routed as `chart`
 *  alone and silently skipped the build spine — the artifact the chart references was never built. */
describe("source mapping Type fan-out: a both-arms push is two releases, not the narrower one", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-type-fanout");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const component = async (name: string): Promise<string> =>
    (await createTestComponent(admin, { name: `${name}-${uuidv7()}` })).id;

  const mapping = (input: {
    sourceKind: string;
    componentIdOrUrn: string;
    type: ExecutorType;
    repoPattern?: string;
    pathPattern?: string;
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, { orgId: org.orgId, ...input })
    );

  const match = (sourceKind: string, repo: string, paths: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentsForSource(tx, org.orgId, { sourceKind, repo, paths })
    );

  /** The mixed repo of §8.3: `chart/**` typed `chart`, everything else typed `image`. */
  const mixedRepo = async (label: string) => {
    const sourceKind = `fanout-${label}-${uuidv7()}`;
    const repo = `acme/svc-${uuidv7()}`;
    const target = await component(label);
    await mapping({ sourceKind, componentIdOrUrn: target, type: "image", repoPattern: repo });
    await mapping({
      sourceKind,
      componentIdOrUrn: target,
      type: "chart",
      repoPattern: repo,
      pathPattern: "chart/**"
    });
    return { sourceKind, repo, target };
  };

  it("a push touching BOTH arms yields both Types — the image arm is not lost to the narrower chart mapping", async () => {
    const { sourceKind, repo } = await mixedRepo("both");

    const matches = await match(sourceKind, repo, ["chart/values.yaml", "src/server.ts"]);

    expect(matches.map((m) => m.type)).toEqual(["chart", "image"]);
    // Rank order is preserved, so `[0]` is still exactly what the pre-D2 single-match call
    // returned: `chart/**` sets one more glob than the whole-repo mapping and wins Rule 1. The
    // defect was never the ORDER — it was that everything after `[0]` was discarded.
    expect(matches[0]!.type).toBe("chart");
  });

  it("a chart-only push is ONE release, on the chart path", async () => {
    const { sourceKind, repo } = await mixedRepo("chart-only");

    const matches = await match(sourceKind, repo, ["chart/values.yaml"]);

    expect(matches.map((m) => m.type)).toEqual(["chart"]);
  });

  it("a code-only push is ONE release, on the image path", async () => {
    const { sourceKind, repo } = await mixedRepo("code-only");

    const matches = await match(sourceKind, repo, ["src/server.ts"]);

    expect(matches.map((m) => m.type)).toEqual(["image"]);
  });

  it("two mappings of the SAME Type still collapse to one — fan-out is per Type, never per mapping", async () => {
    // The deliberate narrowing in `matchComponentsForSource`: same-Type matches dedupe to the
    // highest-ranked of them EVEN WHEN THEY NAME DIFFERENT COMPONENTS (the monorepo-of-services
    // case). Fanning out per component is a wider change than D2 decided, and it would multiply
    // changes on every estate that exists today. If this ever becomes two, that decision was
    // reversed somewhere without saying so.
    const sourceKind = `fanout-same-type-${uuidv7()}`;
    const repo = `acme/mono-${uuidv7()}`;
    const svcA = await component("svc-a");
    const svcB = await component("svc-b");
    await mapping({
      sourceKind,
      componentIdOrUrn: svcA,
      type: "image",
      repoPattern: repo,
      pathPattern: "svc-a/**"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: svcB,
      type: "image",
      repoPattern: repo,
      pathPattern: "svc-b/**"
    });

    const matches = await match(sourceKind, repo, ["svc-a/main.go", "svc-b/main.go"]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.type).toBe("image");
  });

  it("no mapping matches — an empty array, which is the `continue` the processor reads", async () => {
    const matches = await match(`fanout-none-${uuidv7()}`, `acme/nothing-${uuidv7()}`, ["a.txt"]);

    expect(matches).toEqual([]);
  });
});

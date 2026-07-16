import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { createSourceMapping } from "./source-mappings-repo.js";
import { matchComponentForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `matchComponentForSource` precedence (M12 P4A follow-up).
 *
 * Both `repo_pattern` and `path_pattern` are nullable and a null pattern is skipped by the matcher,
 * so a catch-all mapping matches EVERY event of its sourceKind and overlaps with every specific
 * mapping next to it. The match had no ORDER BY, so which of the two won was whatever Postgres
 * happened to return. Since P4A the winning row also carries `purpose`, so that coin flip picks
 * WHICH PIPELINE the release drives, not just which component.
 *
 * Each case uses its own sourceKind: the match is scoped to (orgId, sourceKind), so a private
 * sourceKind is what makes "these two mappings and no others matched" true.
 */
describe("source mapping precedence: the most-constrained mapping wins, deterministically", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-precedence");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const component = async (name: string): Promise<string> =>
    (await createTestComponent(admin, { name: `${name}-${uuidv7()}` })).id;

  /**
   * One mapping per transaction, exactly as the create route does it — and load-bearing here:
   * `created_at` defaults to `now()`, which in Postgres is the TRANSACTION timestamp, so two
   * mappings written in one tx would share a `created_at` and this suite could not control which
   * is "older".
   */
  const mapping = (input: {
    sourceKind: string;
    componentIdOrUrn: string;
    purpose: "infra" | "software";
    repoPattern?: string;
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, { orgId: org.orgId, ...input })
    );

  const match = (sourceKind: string, repo: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo })
    );

  it("the SPECIFIC mapping wins over a catch-all inserted BEFORE it", async () => {
    // The order that fails without the ORDER BY: a seq scan returns rows in physical (insertion)
    // order, so the catch-all — inserted first, and also the OLDER row — comes back first and wins.
    // It is deliberately also the older row: that makes this case prove the SPECIFICITY rank, not
    // merely that some ORDER BY exists. A plain `ORDER BY created_at` would pick the catch-all.
    const sourceKind = `precedence-catchall-first-${uuidv7()}`;
    const repo = `acme/terraform-${uuidv7()}`;
    const fallbackComponent = await component("fallback");
    const infraComponent = await component("infra");

    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, purpose: "software" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      purpose: "infra",
      repoPattern: repo
    });

    const result = await match(sourceKind, repo);
    // Asserted on the resolved VALUES, not on a truthy match: routing this event to the fallback
    // component's SOFTWARE pipeline is precisely the wrong outcome, and it must be named.
    expect(result).toEqual({ componentObjectId: infraComponent, purpose: "infra" });
  });

  it("the SAME specific mapping wins when the catch-all is inserted AFTER it", async () => {
    // The mirror insert order. Together with the case above this is what separates a real rule from
    // luck: if the winner depended on row order, exactly one of these two cases would fail.
    const sourceKind = `precedence-catchall-last-${uuidv7()}`;
    const repo = `acme/terraform-${uuidv7()}`;
    const infraComponent = await component("infra");
    const fallbackComponent = await component("fallback");

    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      purpose: "infra",
      repoPattern: repo
    });
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, purpose: "software" });

    const result = await match(sourceKind, repo);
    expect(result).toEqual({ componentObjectId: infraComponent, purpose: "infra" });
  });

  it("the winner is STABLE across repeated matches of the same event", async () => {
    const sourceKind = `precedence-repeat-${uuidv7()}`;
    const repo = `acme/terraform-${uuidv7()}`;
    const fallbackComponent = await component("fallback");
    const infraComponent = await component("infra");
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, purpose: "software" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      purpose: "infra",
      repoPattern: repo
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => match(sourceKind, repo)));

    // Length FIRST: `[].every(...)` is true, so a Promise.all that somehow yielded nothing would
    // make the assertion below pass vacuously.
    expect(results).toHaveLength(5);
    expect(
      results.every((r) => r?.componentObjectId === infraComponent && r.purpose === "infra")
    ).toBe(true);
  });

  it("the catch-all still wins an event no specific mapping matches — it is a fallback, not dead", async () => {
    // The other half of the rank: demoting the catch-all must not stop it catching.
    const sourceKind = `precedence-fallback-${uuidv7()}`;
    const fallbackComponent = await component("fallback");
    const infraComponent = await component("infra");
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, purpose: "software" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      purpose: "infra",
      repoPattern: `acme/terraform-${uuidv7()}`
    });

    const result = await match(sourceKind, "acme/something-else-entirely");
    expect(result).toEqual({ componentObjectId: fallbackComponent, purpose: "software" });
  });

  it("two EQUALLY constrained overlapping mappings resolve to the OLDER one", async () => {
    // Rule 2, pinned. `acme/*` and `acme/app-1` both set exactly one pattern, so they tie on rank
    // and the exact pattern does NOT beat the wildcard — the older mapping wins. This is the
    // documented limit of the rank rather than an accident, and it is asserted so that changing it
    // has to be a decision someone makes on purpose.
    const sourceKind = `precedence-tie-${uuidv7()}`;
    const suffix = uuidv7();
    const wildcardComponent = await component("wildcard");
    const exactComponent = await component("exact");

    await mapping({
      sourceKind,
      componentIdOrUrn: wildcardComponent,
      purpose: "software",
      repoPattern: `acme-${suffix}/*`
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: exactComponent,
      purpose: "infra",
      repoPattern: `acme-${suffix}/app`
    });

    const result = await match(sourceKind, `acme-${suffix}/app`);
    expect(result).toEqual({ componentObjectId: wildcardComponent, purpose: "software" });
  });
});

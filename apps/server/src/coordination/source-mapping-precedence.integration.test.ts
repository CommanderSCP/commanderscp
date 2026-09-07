import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType } from "@scp/schemas";
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

/** `matchComponentForSource` precedence (M12 P4A follow-up). See docs/coordination.md §903. */
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

  /** One mapping per transaction, exactly as the route does. See docs/coordination.md §904. */
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

  const match = (sourceKind: string, repo: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo })
    );

  /** `match`, plus the event's changed-file set — needed by the path-pattern cases below. */
  const matchPath = (sourceKind: string, repo: string, paths: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, paths })
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

    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, type: "configuration" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      type: "infrastructure",
      repoPattern: repo
    });

    const result = await match(sourceKind, repo);
    // Asserted on the resolved VALUES, not on a truthy match: routing this event to the fallback
    // component's configuration pipeline is precisely the wrong outcome, and it must be named.
    expect(result).toEqual({
      componentObjectId: infraComponent,
      type: "infrastructure",
      classification: null
    });
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
      type: "infrastructure",
      repoPattern: repo
    });
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, type: "configuration" });

    const result = await match(sourceKind, repo);
    expect(result).toEqual({
      componentObjectId: infraComponent,
      type: "infrastructure",
      classification: null
    });
  });

  it("the winner is STABLE across repeated matches of the same event", async () => {
    const sourceKind = `precedence-repeat-${uuidv7()}`;
    const repo = `acme/terraform-${uuidv7()}`;
    const fallbackComponent = await component("fallback");
    const infraComponent = await component("infra");
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, type: "configuration" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      type: "infrastructure",
      repoPattern: repo
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => match(sourceKind, repo)));

    // Length FIRST: `[].every(...)` is true, so a Promise.all that somehow yielded nothing would
    // make the assertion below pass vacuously.
    expect(results).toHaveLength(5);
    expect(
      results.every((r) => r?.componentObjectId === infraComponent && r.type === "infrastructure")
    ).toBe(true);
  });

  it("the catch-all still wins an event no specific mapping matches — it is a fallback, not dead", async () => {
    // The other half of the rank: demoting the catch-all must not stop it catching.
    const sourceKind = `precedence-fallback-${uuidv7()}`;
    const fallbackComponent = await component("fallback");
    const infraComponent = await component("infra");
    await mapping({ sourceKind, componentIdOrUrn: fallbackComponent, type: "configuration" });
    await mapping({
      sourceKind,
      componentIdOrUrn: infraComponent,
      type: "infrastructure",
      repoPattern: `acme/terraform-${uuidv7()}`
    });

    const result = await match(sourceKind, "acme/something-else-entirely");
    expect(result).toEqual({
      componentObjectId: fallbackComponent,
      type: "configuration",
      classification: null
    });
  });

  it("the EXACT pattern beats the wildcard even when the wildcard is OLDER", async () => {
    // This assertion was inverted on 2026-08-02. See docs/coordination.md §905.
    const sourceKind = `precedence-tie-${uuidv7()}`;
    const suffix = uuidv7();
    const wildcardComponent = await component("wildcard");
    const exactComponent = await component("exact");

    await mapping({
      sourceKind,
      componentIdOrUrn: wildcardComponent,
      type: "configuration",
      repoPattern: `acme-${suffix}/*`
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: exactComponent,
      type: "infrastructure",
      repoPattern: `acme-${suffix}/app`
    });

    const result = await match(sourceKind, `acme-${suffix}/app`);
    expect(result).toEqual({
      componentObjectId: exactComponent,
      type: "infrastructure",
      classification: null
    });
  });

  it("`*` beats `**`, because `*` cannot cross a slash and so matches strictly less", async () => {
    const sourceKind = `precedence-star-${uuidv7()}`;
    const suffix = uuidv7();
    const doubleStar = await component("double-star");
    const singleStar = await component("single-star");

    await mapping({
      sourceKind,
      componentIdOrUrn: doubleStar,
      type: "configuration",
      repoPattern: `acme-${suffix}/**`
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: singleStar,
      type: "infrastructure",
      repoPattern: `acme-${suffix}/*`
    });

    const result = await match(sourceKind, `acme-${suffix}/app`);
    expect(result).toEqual({
      componentObjectId: singleStar,
      type: "infrastructure",
      classification: null
    });
  });

  it("the LONGER literal prefix wins between two same-shaped patterns", async () => {
    // The homelab case in miniature, and the one the wildcard tier alone cannot decide: both of
    // these are `**` patterns, so they tie on rule 2a and only the literal-text count separates
    // them. Without it this falls to creation order — which is exactly the trap that motivated the
    // change, since 89 real mappings routed correctly only because of the sequence they were made in.
    const sourceKind = `precedence-literal-${uuidv7()}`;
    const suffix = uuidv7();
    const broad = await component("broad");
    const narrow = await component("narrow");

    await mapping({
      sourceKind,
      componentIdOrUrn: broad,
      type: "configuration",
      repoPattern: `acme-${suffix}/repo`,
      pathPattern: "alloy/**"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: narrow,
      type: "infrastructure",
      repoPattern: `acme-${suffix}/repo`,
      pathPattern: "alloy/manifests/**"
    });

    const result = await matchPath(sourceKind, `acme-${suffix}/repo`, [
      "alloy/manifests/deploy.yaml"
    ]);
    expect(result).toEqual({
      componentObjectId: narrow,
      type: "infrastructure",
      classification: null
    });
  });

  it("a genuine tie STILL resolves to the older mapping — rule 3 is not removed", async () => {
    // Specificity settles what it can; identical shapes still fall through to age, so an
    // established mapping keeps its releases when someone adds an equally specific one later.
    const sourceKind = `precedence-still-oldest-${uuidv7()}`;
    const suffix = uuidv7();
    const older = await component("older");
    const newer = await component("newer");

    await mapping({
      sourceKind,
      componentIdOrUrn: older,
      type: "configuration",
      repoPattern: `acme-${suffix}/app`
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: newer,
      type: "infrastructure",
      repoPattern: `acme-${suffix}/app`
    });

    const result = await match(sourceKind, `acme-${suffix}/app`);
    expect(result).toEqual({
      componentObjectId: older,
      type: "configuration",
      classification: null
    });
  });

  it("a fully-constrained mapping still beats a more SPECIFIC single-pattern one — rule 1 outranks rule 2", async () => {
    // The ordering between the two rules, pinned. An exact repo-only pattern is more "specific" in
    // isolation, but setting BOTH globs is the stronger claim and must keep winning — otherwise
    // adding a path pattern to a mapping could demote it.
    const sourceKind = `precedence-rule1-first-${uuidv7()}`;
    const suffix = uuidv7();
    const bothPatterns = await component("both");
    const exactRepoOnly = await component("exact-repo-only");

    await mapping({
      sourceKind,
      componentIdOrUrn: bothPatterns,
      type: "configuration",
      repoPattern: `acme-${suffix}/**`,
      pathPattern: "**"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: exactRepoOnly,
      type: "infrastructure",
      repoPattern: `acme-${suffix}/app`
    });

    const result = await matchPath(sourceKind, `acme-${suffix}/app`, ["anything.yaml"]);
    expect(result).toEqual({
      componentObjectId: bothPatterns,
      type: "configuration",
      classification: null
    });
  });
});

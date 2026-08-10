import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ExecutorType, PipelineClassification } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { sourceMappings } from "../db/schema.js";
import { createSourceMapping, deleteSourceMappingsMatching } from "./source-mappings-repo.js";
import { matchComponentForSource } from "./correlation.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M18 / ADR-0030 §1–§2 — a dev pipeline is SELECTED by the source ref, and its dev-ness is READ
 * from the operator's declaration on the winning mapping.
 *
 * What this suite is really pinning is that `ref_pattern` behaves as a PEER of the two globs that
 * predate it, in all four places that matters: matching, fail-closed skipping, precedence, and
 * IDENTITY. The last one is the reason this file exists rather than a couple more cases in
 * `source-mapping-precedence`: a ref is the first glob on this table that two otherwise-identical
 * rows can legitimately differ by, so it is the first one whose absence from the identity tuple
 * would silently destroy a live route.
 *
 * Each case uses its own `sourceKind`. The match is scoped to `(orgId, sourceKind)`, so a private
 * source kind is what makes "these mappings and no others matched" a true statement.
 */
describe("dev pipelines route by source ref (ADR-0030)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dev-pipeline-routing");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const component = async (name: string): Promise<string> =>
    (await createTestComponent(admin, { name: `${name}-${uuidv7()}` })).id;

  /** One mapping per transaction — `created_at` is the TRANSACTION timestamp, so two mappings
   *  written in one tx would tie on the rule-3 tiebreak and make "older" uncontrollable. */
  const mapping = (input: {
    sourceKind: string;
    componentIdOrUrn: string;
    type: ExecutorType;
    repoPattern?: string;
    pathPattern?: string;
    refPattern?: string;
    classification?: PipelineClassification;
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      createSourceMapping(tx, { orgId: org.orgId, ...input })
    );

  const match = (sourceKind: string, repo: string, ref?: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, ...(ref ? { ref } : {}) })
    );

  it("routes the dev branch and the main branch of ONE repo to different pipelines", async () => {
    // The whole point of the milestone: before `ref_pattern` these two pushes were indistinguishable
    // to correlation — same repo, same (absent) path, same source kind — so they resolved to the
    // same component AND the same routing Type.
    const sourceKind = `dev-split-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const devComponent = await component("dev");
    const prodComponent = await component("prod");

    await mapping({
      sourceKind,
      componentIdOrUrn: devComponent,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/dev",
      classification: "dev"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: prodComponent,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/main"
    });

    expect(await match(sourceKind, repo, "refs/heads/dev")).toEqual({
      componentObjectId: devComponent,
      type: "configuration",
      // READ from the winning mapping, not inferred from the branch name.
      classification: "dev"
    });
    expect(await match(sourceKind, repo, "refs/heads/main")).toEqual({
      componentObjectId: prodComponent,
      type: "configuration",
      classification: null
    });
  });

  it("a ref-scoped mapping is SKIPPED for an event carrying no ref — fail-closed, not fallback-to-any", async () => {
    // The same rule `repoPattern` and `pathPattern` already follow: a mapping must never claim a
    // release whose ref it cannot prove. A registry/package push carries no ref and must not be
    // swept into the dev pipeline merely because nothing else matched.
    const sourceKind = `dev-noref-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const devComponent = await component("dev-only");

    await mapping({
      sourceKind,
      componentIdOrUrn: devComponent,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/dev"
    });

    expect(await match(sourceKind, repo)).toBeNull();
    expect(await match(sourceKind, repo, "refs/heads/dev")).not.toBeNull();
  });

  it("a NULL ref_pattern still matches every ref — the pre-0056 mapping is untouched", async () => {
    // The additive-expand guarantee the migration rests on. If this ever goes red, every mapping on
    // every existing estate changed behaviour on upgrade.
    const sourceKind = `dev-null-ref-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const anyRef = await component("any-ref");

    await mapping({ sourceKind, componentIdOrUrn: anyRef, type: "configuration", repoPattern: repo });

    for (const ref of ["refs/heads/dev", "refs/heads/main", "refs/tags/v1.0.0"]) {
      expect(await match(sourceKind, repo, ref)).toEqual({
        componentObjectId: anyRef,
        type: "configuration",
        classification: null
      });
    }
    expect(await match(sourceKind, repo)).not.toBeNull();
  });

  it("repo+ref (two globs) outranks a repo-only catch-all inserted BEFORE it", async () => {
    // Rule 1 must count the ref. The catch-all is deliberately the OLDER row, so a bare
    // `ORDER BY created_at` — or a rule 1 that still counts only two globs — picks it and fails.
    const sourceKind = `dev-rank-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const catchAll = await component("catch-all");
    const devComponent = await component("dev-specific");

    await mapping({
      sourceKind,
      componentIdOrUrn: catchAll,
      type: "configuration",
      repoPattern: repo
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: devComponent,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/dev",
      classification: "dev"
    });

    expect(await match(sourceKind, repo, "refs/heads/dev")).toEqual({
      componentObjectId: devComponent,
      type: "configuration",
      classification: "dev"
    });
    // ...and a ref the specific mapping does not claim still falls through to the catch-all.
    expect(await match(sourceKind, repo, "refs/heads/main")).toEqual({
      componentObjectId: catchAll,
      type: "configuration",
      classification: null
    });
  });

  it("rule 1 COUNTS the ref: two wide globs outrank one narrow one", async () => {
    // Isolates rule 1 from rule 2a, which the case above does NOT do — there, the ref-scoped mapping
    // also wins on narrowest-wildcard, so dropping the ref from rule 1 leaves that test green. (It
    // did: this case exists because that mutation survived.)
    //
    // Here the two ranks DISAGREE, so only the one that runs first can decide it:
    //   catchAll  — repo exact, no ref     -> rule 1 count 1, rule 2a tier 3
    //   devWide   — repo `**` + ref `**`   -> rule 1 count 2, rule 2a tier 1+1 = 2
    // Rule 1 (applied first, and counting three globs) picks `devWide`. A rule 1 that still counted
    // only two globs ties at 1 and falls through to rule 2a, which picks `catchAll` instead.
    const sourceKind = `dev-rank1-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const catchAll = await component("rank1-exact-repo");
    const devWide = await component("rank1-two-wide");

    await mapping({
      sourceKind,
      componentIdOrUrn: catchAll,
      type: "configuration",
      repoPattern: repo
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: devWide,
      type: "configuration",
      repoPattern: "acme/**",
      refPattern: "refs/heads/**",
      classification: "dev"
    });

    expect(await match(sourceKind, repo, "refs/heads/dev")).toEqual({
      componentObjectId: devWide,
      type: "configuration",
      classification: "dev"
    });
  });

  it("globs over refs: `refs/heads/release/*` matches one segment and not two", async () => {
    // `*` cannot cross a `/`, which is what makes it outrank `**` in rule 2a. Pinned here because
    // ref hierarchies are exactly where that distinction earns its keep.
    const sourceKind = `dev-glob-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const releases = await component("releases");

    await mapping({
      sourceKind,
      componentIdOrUrn: releases,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/release/*"
    });

    expect(await match(sourceKind, repo, "refs/heads/release/1.2")).not.toBeNull();
    expect(await match(sourceKind, repo, "refs/heads/release/1.2/hotfix")).toBeNull();
    expect(await match(sourceKind, repo, "refs/heads/main")).toBeNull();
  });

  it("deleting the dev mapping leaves the production one routing — the ref is part of the IDENTITY", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before the ref joined the identity tuple, these two rows
    // matched the same `(component, repo, path, type)` tuple, so pruning the dev route deleted the
    // production route with it and reported a `deleted` count the operator reads as success.
    const sourceKind = `dev-identity-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const shared = await component("shared");

    await mapping({
      sourceKind,
      componentIdOrUrn: shared,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/dev",
      classification: "dev"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: shared,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/main"
    });

    const removed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteSourceMappingsMatching(tx, {
        orgId: org.orgId,
        componentObjectId: shared,
        sourceKind,
        repoPattern: repo,
        pathPattern: null,
        refPattern: "refs/heads/dev",
        type: "configuration"
      })
    );

    expect(removed).toBe(1);
    expect(await match(sourceKind, repo, "refs/heads/dev")).toBeNull();
    expect(await match(sourceKind, repo, "refs/heads/main")).toEqual({
      componentObjectId: shared,
      type: "configuration",
      classification: null
    });
  });

  it("a ref-agnostic prune does NOT reach a ref-scoped row — absent means null, never wildcard", async () => {
    // The back-compat half of the same property (ADR-0030 §1): a caller written before `refPattern`
    // existed passes null and must under-delete visibly rather than over-delete silently.
    const sourceKind = `dev-prune-scope-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const shared = await component("prune-scope");

    await mapping({
      sourceKind,
      componentIdOrUrn: shared,
      type: "configuration",
      repoPattern: repo,
      refPattern: "refs/heads/dev"
    });

    const removed = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      deleteSourceMappingsMatching(tx, {
        orgId: org.orgId,
        componentObjectId: shared,
        sourceKind,
        repoPattern: repo,
        pathPattern: null,
        refPattern: null,
        type: "configuration"
      })
    );

    // 0, and the row survives — the loud failure, not the silent one.
    expect(removed).toBe(0);
    expect(await match(sourceKind, repo, "refs/heads/dev")).not.toBeNull();
  });

  it("an unrecognised stored classification reads back as null, never as a recognised label", async () => {
    // `classification` is plain text with the closed set enforced in Zod, so a version-skewed or
    // hand-edited row can hold anything. It must degrade to "unclassified" rather than crash the
    // routing path or, worse, be mistaken for a label the UI treats as meaningful.
    const sourceKind = `dev-bad-label-${uuidv7()}`;
    const repo = `acme/app-${uuidv7()}`;
    const comp = await component("bad-label");

    const created = await mapping({
      sourceKind,
      componentIdOrUrn: comp,
      type: "configuration",
      repoPattern: repo,
      classification: "dev"
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(sourceMappings)
        .set({ classification: "staging" })
        .where(eq(sourceMappings.id, created.id))
    );

    expect(await match(sourceKind, repo, "refs/heads/main")).toEqual({
      componentObjectId: comp,
      type: "configuration",
      classification: null
    });
  });
});

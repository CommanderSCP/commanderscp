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

/**
 * Path-based routing — one repository fanning out to per-directory components.
 *
 * THE BUG THIS FIXES, stated concretely because the failure was silent. `matchComponentForSource`
 * returns ONE component: the most-constrained mapping, ties broken oldest-first. A `path_pattern`
 * mapping was skipped outright whenever the event carried no path, and nothing populated a path for
 * a git push — the hint had only a SINGULAR `path`, which cannot represent a commit because a
 * commit touches many files. So on a monorepo every mapping was necessarily repo-only, every
 * repo-only mapping ranked equally, and the OLDEST one won every event forever. Every other mapping
 * on that repository never fired, and every release was attributed to one arbitrary component.
 *
 * Measured on the homelab before the fix: 45 of 47 source mappings had never fired, and 286 changes
 * across four repositories had landed on exactly two components.
 *
 * Each case uses its own `sourceKind` — the match is scoped to (orgId, sourceKind), so a private
 * sourceKind is what makes "these mappings and no others matched" true.
 */
describe("source mapping: a repository routes by changed path, not just by name", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "mapping-path-routing");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const component = async (name: string): Promise<string> =>
    (await createTestComponent(admin, { name: `${name}-${uuidv7()}` })).id;

  /** One mapping per transaction — `created_at` defaults to the TRANSACTION timestamp, so two
   *  mappings written in one tx would tie and this suite could not control which is "older". */
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

  const match = (sourceKind: string, repo: string, paths?: string[]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      matchComponentForSource(tx, org.orgId, { sourceKind, repo, paths })
    );

  it("routes two components in ONE repository by which directory the push touched", async () => {
    // The headline case. Both mappings name the same repo and differ only by path, which is exactly
    // the shape a GitOps monorepo needs and the shape that could not work before: with no `paths`
    // on the hint, BOTH of these were skipped and the match returned null.
    const sourceKind = `path-routing-fanout-${uuidv7()}`;
    const repo = `jag8765-personal/homelab-gitops-${uuidv7()}`;
    const loki = await component("loki");
    const pihole = await component("pihole");

    await mapping({
      sourceKind,
      componentIdOrUrn: loki,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "loki/**"
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: pihole,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "pihole/**"
    });

    // Same repository, same mappings — only the changed files differ, and that alone must decide.
    await expect(match(sourceKind, repo, ["loki/values.yaml"])).resolves.toEqual({
      componentObjectId: loki,
      type: "configuration",
      classification: null
    });
    await expect(match(sourceKind, repo, ["pihole/values.yaml"])).resolves.toEqual({
      componentObjectId: pihole,
      type: "configuration",
      classification: null
    });
  });

  it("matches on ANY changed path, not only the first", async () => {
    // A push carries a whole changed set. Asserting the LAST entry matches is what proves the
    // matcher scans the list rather than peeking at `paths[0]`.
    const sourceKind = `path-routing-any-${uuidv7()}`;
    const repo = `acme/monorepo-${uuidv7()}`;
    const tailscale = await component("tailscale");

    await mapping({
      sourceKind,
      componentIdOrUrn: tailscale,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "tailscale/**"
    });

    await expect(
      match(sourceKind, repo, ["README.md", "docs/notes.md", "tailscale/values.yaml"])
    ).resolves.toEqual({
      componentObjectId: tailscale,
      type: "configuration",
      classification: null
    });
  });

  it("a path-scoped mapping BEATS an older repo-only mapping on the same repository", async () => {
    // The live homelab shape: `agentkit-auto` held the oldest repo-only mapping on homelab-gitops
    // and therefore absorbed every push to it. Specificity must outrank age, or adding the
    // per-directory mappings would be inert — 43 rows that look configured and never fire.
    const sourceKind = `path-routing-beats-older-${uuidv7()}`;
    const repo = `jag8765-personal/homelab-gitops-${uuidv7()}`;
    const incumbent = await component("incumbent-repo-only");
    const trivy = await component("trivy");

    await mapping({
      sourceKind,
      componentIdOrUrn: incumbent,
      type: "configuration",
      repoPattern: repo
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: trivy,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "trivy-operator/**"
    });

    await expect(match(sourceKind, repo, ["trivy-operator/values.yaml"])).resolves.toEqual({
      componentObjectId: trivy,
      type: "configuration",
      classification: null
    });
  });

  it("falls back to the repo-only mapping when the push touched no mapped directory", async () => {
    // The complement of the case above, and the reason the fallback must be kept: a push to a
    // directory nobody claimed still has to route somewhere rather than vanish.
    const sourceKind = `path-routing-fallback-${uuidv7()}`;
    const repo = `jag8765-personal/homelab-gitops-${uuidv7()}`;
    const incumbent = await component("incumbent-repo-only");
    const trivy = await component("trivy");

    await mapping({
      sourceKind,
      componentIdOrUrn: incumbent,
      type: "configuration",
      repoPattern: repo
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: trivy,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "trivy-operator/**"
    });

    await expect(match(sourceKind, repo, ["scripts/backup.sh"])).resolves.toEqual({
      componentObjectId: incumbent,
      type: "configuration",
      classification: null
    });
  });

  it("an event with NO path information never matches a path-scoped mapping", async () => {
    // The documented degradation, pinned so it cannot drift into fail-OPEN. When a provider cannot
    // determine the changed set (a truncated commit-file list, a poll past its fetch budget), a
    // path-scoped mapping must NOT claim the release — it cannot prove the release is its own. The
    // event routes by repository instead, which is the pre-existing behaviour.
    const sourceKind = `path-routing-nopaths-${uuidv7()}`;
    const repo = `jag8765-personal/homelab-gitops-${uuidv7()}`;
    const incumbent = await component("incumbent-repo-only");
    const trivy = await component("trivy");

    await mapping({
      sourceKind,
      componentIdOrUrn: incumbent,
      type: "configuration",
      repoPattern: repo
    });
    await mapping({
      sourceKind,
      componentIdOrUrn: trivy,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "trivy-operator/**"
    });

    // Undefined paths, and an explicitly empty list — both mean "not determined", never "changed
    // nothing", and both must decline the path-scoped mapping.
    await expect(match(sourceKind, repo, undefined)).resolves.toEqual({
      componentObjectId: incumbent,
      type: "configuration",
      classification: null
    });
    await expect(match(sourceKind, repo, [])).resolves.toEqual({
      componentObjectId: incumbent,
      type: "configuration",
      classification: null
    });
  });

  it("a path-scoped mapping does not match a push into a DIFFERENT repository", async () => {
    // Both patterns are ANDed. A mapping whose path matches but whose repo does not must not fire —
    // otherwise `loki/**` would claim loki changes in every repository in the org.
    const sourceKind = `path-routing-repo-and-${uuidv7()}`;
    const repo = `acme/intended-${uuidv7()}`;
    const other = `acme/unrelated-${uuidv7()}`;
    const loki = await component("loki");

    await mapping({
      sourceKind,
      componentIdOrUrn: loki,
      type: "configuration",
      repoPattern: repo,
      pathPattern: "loki/**"
    });

    await expect(match(sourceKind, other, ["loki/values.yaml"])).resolves.toBeNull();
  });
});

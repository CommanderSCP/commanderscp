import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";
import type { DependencyLine } from "@scp/schemas";
import { BACKGROUND_LOOPS } from "../background-work.js";
import type { DomainEventJob } from "../events/pgboss.js";
import {
  DOMAIN_EVENT_ROUTERS,
  domainEventRouters,
  type RouterGuardConfig
} from "../events/domain-event-registry.js";
import {
  advancedLineHeadRouter,
  bumpDispatchRoleGuard,
  isLineHeadAdvancedEvent,
  planBump,
  startBumpDispatchLoop,
  DEPENDENCY_BUMP_QUEUE
} from "./bump-dispatch.js";
import { DEPENDENCY_LINE_HEAD_ADVANCED_EVENT } from "./dependency-inventory-repo.js";
import { manifestIsEditableInThisBuild } from "./bump-actuator.js";

/** The three pure decisions the dispatcher makes. See docs/dependencies.md §70. */

const npmLine = (
  overrides: Partial<Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion">>
): Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion"> => ({
  ecosystem: "npm",
  major: "1",
  tagPattern: null,
  latestVersion: "1.4.0",
  ...overrides
});

/** The census the integration suite structurally cannot do. See docs/dependencies.md §71. */
describe("the composition root actually wires it", () => {
  it("registers the router in the production registry, under THIS capability's guard", () => {
    // Identity, not name. See docs/dependencies.md §72.
    const entries = DOMAIN_EVENT_ROUTERS.filter(
      (entry) => entry.factory === advancedLineHeadRouter
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.guard).toBe(bumpDispatchRoleGuard);
  });

  it("registers it on a declared commander worker, and on NOTHING else", () => {
    const queuesFor = (config: RouterGuardConfig): string[] =>
      domainEventRouters(config).map((router) => router.queue);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: true })
    ).toContain(DEPENDENCY_BUMP_QUEUE);
    // The guard's two axes, observed at the REGISTRATION rather than on the guard in isolation:
    // an api process, an outpost, and a deployment that never declared its federation role must
    // none of them end up with this router on the shared event stream.
    expect(
      queuesFor({ role: "api", federationRole: "commander", federationRoleDeclared: true })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "outpost", federationRoleDeclared: true })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
    expect(
      queuesFor({ role: "worker", federationRole: "commander", federationRoleDeclared: false })
    ).not.toContain(DEPENDENCY_BUMP_QUEUE);
  });

  it("is in the production loop registry — the thing that actually starts it", () => {
    // IDENTITY, not a name and not a substring: the registry holds the function object this test
    // imported. A local shadow, a wrapper, or a lookalike in another module is a different object
    // and fails here. `background-work.test.ts` then STARTS every registry entry against a probe
    // boss and asserts each one creates its own queue — so "registered" is not a paper claim.
    const entries = BACKGROUND_LOOPS.filter((entry) => entry.loop === startBumpDispatchLoop);
    expect(entries).toHaveLength(1);
  });

  it("actually starts and creates ITS OWN queue when the registry runs it", async () => {
    // The behavioural half, driven through the REAL registry entry rather than by calling the
    // starter directly — which is the difference between "this loop works" and "this loop is wired".
    const created: string[] = [];
    const boss = {
      createQueue: async (queue: string) => void created.push(queue),
      work: async () => "worker-id",
      send: async () => "job-id",
      schedule: async () => undefined
    } as unknown as PgBoss;

    const entry = BACKGROUND_LOOPS.find((candidate) => candidate.loop === startBumpDispatchLoop)!;
    const handle = await entry.start({
      boss,
      db: undefined as never,
      host: undefined as never,
      sandbox: undefined as never,
      config: {
        role: "worker",
        federationRole: "commander",
        federationRoleDeclared: true,
        secretsMasterKey: Buffer.alloc(32)
      } as never
    });
    await handle.stop();

    expect(created).toContain(DEPENDENCY_BUMP_QUEUE);
  });

  it("never takes a competing consumer on the shared domain-event stream", async () => {
    // `boss.work` on `domain-events` does not deduplicate. See docs/dependencies.md §73.
    const srcDir = dirname(fileURLToPath(new URL(".", import.meta.url)));
    for (const file of ["main.ts", "background-work.ts"]) {
      const raw = readFileSync(join(srcDir, file), "utf8");
      expect(raw, `${file} registers a competing consumer on domain-events`).not.toMatch(
        /work<[^>]*>\(\s*DOMAIN_EVENTS_QUEUE/
      );
    }
  });
});

describe("bumpDispatchRoleGuard — derived, not copied from either M21.4 job", () => {
  const base = {
    role: "worker" as const,
    federationRole: "commander" as const,
    federationRoleDeclared: true
  };

  it("allows a background-work process on an explicitly declared commander", () => {
    expect(bumpDispatchRoleGuard(base).allowed).toBe(true);
    expect(bumpDispatchRoleGuard({ ...base, role: "all" }).allowed).toBe(true);
  });

  it("refuses an api-only process — background work belongs to all/worker", () => {
    const verdict = bumpDispatchRoleGuard({ ...base, role: "api" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/SCP_ROLE/);
  });

  it("is FAIL-CLOSED on an UNDECLARED federation role, which is the whole point of the second axis", () => {
    // `federationRole` DEFAULTS to `commander` so every pre-M16.3 deployment keeps serving the SPA.
    // A guard testing only the value would therefore let through exactly the population most likely
    // to be air-gapped — an outpost that predates the setting — and this job WRITES to a repository.
    const verdict = bumpDispatchRoleGuard({ ...base, federationRoleDeclared: false });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/not declared/);
  });

  it("refuses a declared outpost or retrans", () => {
    expect(bumpDispatchRoleGuard({ ...base, federationRole: "outpost" }).allowed).toBe(false);
    expect(bumpDispatchRoleGuard({ ...base, federationRole: "retrans" }).allowed).toBe(false);
  });
});

describe("the router predicate", () => {
  const event = (type: string): DomainEventJob => ({
    id: "e1",
    orgId: "o1",
    type,
    subject: "line-1"
  });

  it("matches the head-advance event and nothing else", () => {
    expect(isLineHeadAdvancedEvent(event(DEPENDENCY_LINE_HEAD_ADVANCED_EVENT))).toBe(true);
    expect(isLineHeadAdvancedEvent(event("scp.change.transitioned"))).toBe(false);
    expect(isLineHeadAdvancedEvent(event("scp.object.created"))).toBe(false);
  });

  it("enqueues onto its OWN queue, and does no work in the router", async () => {
    const sent: { queue: string; job: unknown; options: unknown }[] = [];
    const boss = {
      send: async (queue: string, job: unknown, options?: unknown) => {
        sent.push({ queue, job, options });
        return "job-id";
      }
    };
    const router = advancedLineHeadRouter();
    expect(router.queue).toBe(DEPENDENCY_BUMP_QUEUE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await router.route(boss as any, event(DEPENDENCY_LINE_HEAD_ADVANCED_EVENT));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await router.route(boss as any, event("scp.change.transitioned"));
    expect(sent).toEqual([
      // OPTIONS ARE CAPTURED AND ASSERTED EMPTY on purpose. See docs/dependencies.md §74.
      { queue: DEPENDENCY_BUMP_QUEUE, job: { orgId: "o1", lineId: "line-1" }, options: undefined }
    ]);
  });

  it("ignores an advance event carrying no line subject rather than enqueuing a job for nothing", async () => {
    const sent: unknown[] = [];
    const boss = {
      send: async (_q: string, job: unknown) => {
        sent.push(job);
        return "id";
      }
    };
    const router = advancedLineHeadRouter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fixture is one method wide
    await router.route(boss as any, {
      id: "e",
      orgId: "o",
      type: DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
      subject: null
    });
    expect(sent).toEqual([]);
  });
});

describe("planBump — what the bump would SAY, and every refusal that names its own cause", () => {
  it("composes by SUBSTITUTION, so the declaration's range operator survives", () => {
    const plan = planBump({
      line: npmLine({ latestVersion: "1.4.0" }),
      declaration: {
        declaredVersion: "^1.2.3",
        resolvedVersion: "1.2.3",
        resolvedDigest: null,
        manifestPath: "package.json"
      },
      granularity: "minor_and_patch"
    });
    expect(plan).toEqual({ due: true, fromVersion: "^1.2.3", toVersion: "^1.4.0" });
  });

  it("keeps a `v` prefix, and a variant suffix, for the same reason", () => {
    expect(
      planBump({
        line: npmLine({ ecosystem: "go", latestVersion: "1.9.0" }),
        declaration: {
          declaredVersion: "v1.2.3",
          resolvedVersion: "1.2.3",
          resolvedDigest: null,
          manifestPath: "go.mod"
        },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "v1.2.3", toVersion: "v1.9.0" });
    expect(
      planBump({
        line: npmLine({
          ecosystem: "oci",
          major: "3",
          tagPattern: "-alpine",
          latestVersion: "3.19.1-alpine"
        }),
        declaration: {
          declaredVersion: "3.18.0-alpine",
          resolvedVersion: "3.18.0-alpine",
          resolvedDigest: null,
          manifestPath: "Dockerfile"
        },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "3.18.0-alpine", toVersion: "3.19.1-alpine" });
  });

  it("refuses a MINOR move under `patch` granularity — the most restrictive wins", () => {
    const plan = planBump({
      line: npmLine({ latestVersion: "1.4.0" }),
      declaration: {
        declaredVersion: "1.2.3",
        resolvedVersion: "1.2.3",
        resolvedDigest: null,
        manifestPath: "package.json"
      },
      granularity: "patch"
    });
    expect(plan).toMatchObject({ due: false, reason: "beyond_granularity" });
  });

  it("allows a PATCH move under `patch` granularity", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.2.9" }),
        declaration: {
          declaredVersion: "1.2.3",
          resolvedVersion: "1.2.3",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "patch"
      })
    ).toEqual({ due: true, fromVersion: "1.2.3", toVersion: "1.2.9" });
  });

  it("refuses an OPEN RANGE rather than resolving one — resolving a lockfile is CI by definition", () => {
    expect(
      planBump({
        line: npmLine({}),
        declaration: {
          declaredVersion: "^1",
          resolvedVersion: null,
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declaration_pins_no_version" });
  });

  it("refuses when the head is not observed — NULL is 'not yet observed', never 'nothing newer exists'", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: null }),
        declaration: {
          declaredVersion: "^1.2.3",
          resolvedVersion: "1.2.3",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "no_head_observed" });
  });

  it("refuses when the component is already at or ahead of the head", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: {
          declaredVersion: "^1.4.0",
          resolvedVersion: "1.4.0",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "already_at_or_ahead_of_head" });
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: {
          declaredVersion: "^1.5.0",
          resolvedVersion: "1.5.0",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "already_at_or_ahead_of_head" });
  });

  it("refuses a head that is not on the line as the line is defined NOW", () => {
    // A stored head whose variant no longer matches: the line follows `-alpine` and the head is the
    // plain flavour. Two flavours of one release are not an upgrade path.
    expect(
      planBump({
        line: npmLine({
          ecosystem: "oci",
          major: "3",
          tagPattern: "-alpine",
          latestVersion: "3.19.1"
        }),
        declaration: {
          declaredVersion: "3.18.0-alpine",
          resolvedVersion: "3.18.0-alpine",
          resolvedDigest: null,
          manifestPath: "Dockerfile"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "head_not_on_line" });
  });

  it("refuses a declaration whose resolved version is not a substring of it, rather than reformatting", () => {
    // The two columns disagree about what the file says. Every way of proceeding is a guess about
    // somebody else's manifest, and the edit target would be text that does not appear in the file.
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: {
          declaredVersion: ">=1.2 <2",
          resolvedVersion: "1.2.3",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declaration_not_composable" });
  });

  it("refuses a declared version this ecosystem's grammar cannot read", () => {
    expect(
      planBump({
        line: npmLine({ latestVersion: "1.4.0" }),
        declaration: {
          declaredVersion: "latest",
          resolvedVersion: "latest",
          resolvedDigest: null,
          manifestPath: "package.json"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declared_version_not_comparable" });
  });

  it("refuses a DUE bump into a file this build's editor may not write, BEFORE any container", () => {
    // A file KIND the write allowlist does not name. See docs/dependencies.md §75.
    const plan = planBump({
      line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
      declaration: {
        declaredVersion: "3.18.0",
        resolvedVersion: "3.18.0",
        resolvedDigest: null,
        manifestPath: "chart/kustomization.yaml"
      },
      granularity: "minor_and_patch"
    });
    expect(plan).toMatchObject({ due: false, reason: "manifest_not_editable_in_this_build" });
    // The detail must say the bump WAS due: "there is nothing to do" and "there is something to do
    // that this build cannot do" are different operator stories behind the same absent pull request.
    expect(plan).toMatchObject({ detail: expect.stringContaining("3.19.1") });
    expect(plan).toMatchObject({
      detail: expect.stringContaining("still inventoried and still polled")
    });
  });

  it("NEGATIVE CONTROL: the same line and versions in a Dockerfile ARE due", () => {
    // Without this, the assertion above is satisfied by a `planBump` that refuses every oci bump.
    expect(
      planBump({
        line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
        declaration: {
          declaredVersion: "3.18.0",
          resolvedVersion: "3.18.0",
          resolvedDigest: null,
          manifestPath: "chart/Dockerfile"
        },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "3.18.0", toVersion: "3.19.1" });
  });

  it("M21.7 SPLIT SHAPES: the same line and versions in a chart's values.yaml ARE now due", () => {
    // The behaviour change the split-shape round exists for. See docs/dependencies.md §76.
    expect(
      planBump({
        line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
        declaration: {
          declaredVersion: "3.18.0",
          resolvedVersion: "3.18.0",
          resolvedDigest: null,
          manifestPath: "chart/values.yaml"
        },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "3.18.0", toVersion: "3.19.1" });
  });

  /** A declaration pinned by a digest as well as a tag. See docs/dependencies.md §77. */
  it("refuses a DUE bump for a declaration pinned by a DIGEST as well as a version", () => {
    const plan = planBump({
      line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
      declaration: {
        declaredVersion: "3.18.0",
        resolvedVersion: "3.18.0",
        resolvedDigest: `sha256:${"a".repeat(64)}`,
        manifestPath: "chart/values.yaml"
      },
      granularity: "minor_and_patch"
    });
    expect(plan).toMatchObject({ due: false, reason: "declaration_pinned_by_digest" });
    // The detail must say the bump WAS due, exactly as the editability refusal does: "nothing to
    // do" and "something to do that would do nothing" are different operator stories.
    expect(plan).toMatchObject({ detail: expect.stringContaining("3.19.1") });
  });

  it("…and in a Dockerfile too — the refusal is about the DECLARATION, not about the file kind", () => {
    // A digest-pinned `FROM` is in a perfectly writable file, so a rule ordered after the
    // editability question would leave this case with no refusal at all. `alpine:3.19@sha256:…` is
    // the commonest way an org pins a base image and it has been bumpable-but-inert since M21.5.
    expect(
      planBump({
        line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
        declaration: {
          declaredVersion: "3.18.0",
          resolvedVersion: "3.18.0",
          resolvedDigest: `sha256:${"b".repeat(64)}`,
          manifestPath: "Dockerfile"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "declaration_pinned_by_digest" });
  });

  it("NEGATIVE CONTROL: the identical declaration with NO digest is due", () => {
    // Without this the two assertions above are satisfied by a `planBump` that refuses every oci
    // bump — and the digest column is null for every language ecosystem, so a rule that read it
    // wrongly would silently stop all bumping everywhere.
    expect(
      planBump({
        line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.19.1" }),
        declaration: {
          declaredVersion: "3.18.0",
          resolvedVersion: "3.18.0",
          resolvedDigest: null,
          manifestPath: "chart/values.yaml"
        },
        granularity: "minor_and_patch"
      })
    ).toEqual({ due: true, fromVersion: "3.18.0", toVersion: "3.19.1" });
  });

  it("the editability question is asked LAST — a bump that is not due reports why it is not due", () => {
    // Asking it earlier would replace an accurate "already at head" with a refusal about a file
    // nobody wanted to write, on every poll, forever.
    expect(
      planBump({
        line: npmLine({ ecosystem: "oci", major: "3", latestVersion: "3.18.0" }),
        declaration: {
          declaredVersion: "3.18.0",
          resolvedVersion: "3.18.0",
          resolvedDigest: null,
          manifestPath: "chart/kustomization.yaml"
        },
        granularity: "minor_and_patch"
      })
    ).toMatchObject({ due: false, reason: "already_at_or_ahead_of_head" });
  });
});

/** The write allowlist, pinned across both modules. See docs/dependencies.md §78. */
describe("the write allowlist, pinned across the two modules that restate it", () => {
  const CASES: ReadonlyArray<readonly [string, string]> = [
    ["npm", "package.json"],
    ["npm", "src/package.json"],
    ["npm", "package-lock.json"],
    ["npm", "values.yaml"],
    ["go", "go.mod"],
    ["go", "go.sum"],
    ["go", "Dockerfile"],
    ["maven", "pom.xml"],
    ["maven", "build.gradle"],
    ["python", "pyproject.toml"],
    ["python", "requirements.txt"],
    ["python", "requirements-dev.txt"],
    ["python", "poetry.lock"],
    ["oci", "Dockerfile"],
    ["oci", "Containerfile"],
    ["oci", "Dockerfile.prod"],
    ["oci", "api.Dockerfile"],
    ["oci", "chart/values.yaml"],
    ["oci", "values.yaml"],
    // The near-misses M21.7 deliberately did NOT open. The ingestion side reads exactly the basename
    // `values.yaml`, so a spelling it never parses must stay unwritable on both sides — otherwise
    // SCP would author into a file it has never read a dependency out of.
    ["oci", "values.yml"],
    ["oci", "chart/prod-values.yaml"],
    ["oci", "chart/values.yaml.tpl"],
    ["oci", "chart/Chart.yaml"],
    ["oci", "deployment.yaml"],
    ["oci", "kustomization.yaml"]
  ];

  it("the server's answer matches the plugin's, accept AND refuse, for every spelling", async () => {
    const { manifestParserFor } = await import("@scp/plugin-managed-dep");
    for (const [ecosystem, path] of CASES) {
      let pluginAccepts = true;
      try {
        manifestParserFor(ecosystem as Parameters<typeof manifestParserFor>[0], path);
      } catch {
        pluginAccepts = false;
      }
      expect(
        manifestIsEditableInThisBuild(ecosystem, path),
        `${ecosystem} ${path}: the server and the plugin disagree about whether this file may be written`
      ).toBe(pluginAccepts);
    }
  });

  it("NEGATIVE CONTROL: the two lists are not both 'yes' — `kustomization.yaml` is refused by both", async () => {
    // Otherwise the pinning above is satisfied by two functions that accept everything, and the
    // fail-closed property this whole seam exists for would be untested. `kustomization.yaml` is the
    // refused YAML now that `values.yaml` is not — chosen deliberately, so the control does not turn
    // on "YAML is refused" (it no longer is) but on "this file kind is".
    const { manifestParserFor } = await import("@scp/plugin-managed-dep");
    expect(manifestIsEditableInThisBuild("oci", "chart/kustomization.yaml")).toBe(false);
    expect(() => manifestParserFor("oci", "chart/kustomization.yaml")).toThrow();
    expect(manifestIsEditableInThisBuild("oci", "Dockerfile")).toBe(true);
  });

  it("POSITIVE CONTROL: `values.yaml` is now accepted by BOTH, and by the yaml parser", async () => {
    // The M21.7 split-shape change, pinned on both restatements at once. Asserted on the PARSER
    // identity rather than on "it did not throw": an entry that matched the basename and handed back
    // `parseDockerfile` would satisfy a throw-free assertion and mis-read every chart in the org.
    const { manifestParserFor } = await import("@scp/plugin-managed-dep");
    expect(manifestIsEditableInThisBuild("oci", "chart/values.yaml")).toBe(true);
    const parser = manifestParserFor("oci", "chart/values.yaml");
    expect(parser("image:\n  repository: acme/api\n  tag: 1.2.3\n")).toMatchObject([
      { ecosystem: "oci", coordinate: "acme/api", declared: "1.2.3", line: 3 }
    ]);
  });
});

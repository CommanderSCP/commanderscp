import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { DependencyLineKey } from "@scp/schemas";
import type { DependencyIndexPlugin, PluginContext } from "@scp/plugin-api";
import {
  createGoIndexPlugin,
  createMavenIndexPlugin,
  createNpmIndexPlugin,
  createPypiIndexPlugin
} from "@scp/plugin-dependency-index-registries";
import { createOciIndexPlugin } from "@scp/plugin-dependency-index-oci";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { decisions, outbox } from "../db/schema.js";
import type {
  DependencyIndexPluginClient,
  PluginHost,
  PluginHostInstanceConfig
} from "../plugin-host/contract.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
  declareDependencyLineProducer,
  getDependencyLineProducer,
  getDependencyLineById,
  recordDependencyLineHead,
  resetLineHead,
  retractDependencyLineProducer,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import { buildDependencyIndexFeed, DEPENDENCY_INDEX_FEED_FILE } from "./version-index-feed.js";
import {
  DEPENDENCY_VERSION_POLL_DECISION_KIND,
  buildLineWorkList,
  pollOrgDependencyVersions
} from "./version-poll.js";

/** M21.4 — THE DAILY VERSION POLL AGAINST REAL POSTGRES. See docs/dependencies.md §420. */
describe("M21.4 dependency version poll (ADR-0032 §7)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let scratch: string;
  let skopeoBin: string;
  let feedDir: string;

  /** The component whose subscription is ENABLED, and one whose is not. */
  let subscribed: string;
  let unsubscribed: string;
  const lineIds = new Map<string, string>();

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.4 integration fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  async function declare(componentObjectId: string, key: DependencyLineKey, tagPattern?: string) {
    const id = await inOrg(async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, {
        ...key,
        ...(tagPattern !== undefined ? { tagPattern } : {})
      });
      await upsertComponentDependency(tx, org.orgId, {
        componentObjectId,
        lineId: line.id,
        manifestPath: "manifest",
        declaredVersion: "1.0.0"
      });
      return line.id;
    });
    lineIds.set(`${key.ecosystem}:${key.coordinate}`, id);
    return id;
  }

  /**
   * An in-process `PluginHost` that constructs the REAL index plugin for whichever module the real
   * `resolveIndexInstanceConfig` asked for, with that instance's real config.
   */
  function realIndexHost(): PluginHost & {
    /** Ids started but not yet stopped — the standing subprocess count on a real host. */
    readonly live: Set<string>;
    readonly stopped: string[];
  } {
    const started = new Map<string, PluginHostInstanceConfig>();
    const live = new Set<string>();
    const stopped: string[] = [];
    const notWired = (): never => {
      throw new Error("this host only wires dependencyIndex()");
    };
    return {
      live,
      stopped,
      async start(instances) {
        for (const instance of instances) {
          started.set(instance.id, instance);
          live.add(instance.id);
        }
      },
      async stop() {
        live.clear();
      },
      async stopInstances(ids) {
        for (const id of ids) {
          stopped.push(id);
          live.delete(id);
        }
      },
      executor: notWired,
      control: notWired,
      discovery: notWired,
      notification: notWired,
      federationTransport: notWired,
      gitFileRead: notWired,
      dependencyIndex(instanceId: string): DependencyIndexPluginClient {
        const instance = started.get(instanceId);
        if (!instance) throw new Error(`instance ${instanceId} was never started`);
        const factories: Partial<Record<string, () => DependencyIndexPlugin>> = {
          "dependency-index-go": createGoIndexPlugin,
          "dependency-index-npm": createNpmIndexPlugin,
          "dependency-index-pypi": createPypiIndexPlugin,
          "dependency-index-maven": createMavenIndexPlugin,
          "dependency-index-oci": createOciIndexPlugin
        };
        const plugin = factories[instance.module]?.();
        if (!plugin) throw new Error(`no index plugin for module ${instance.module}`);
        const ctx: PluginContext = {
          orgId: instance.orgId,
          scopeKey: instance.scopeKey,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          secrets: { get: async () => undefined },
          http: {
            request: async () => {
              throw new Error("this integration test wires no HTTP index");
            }
          },
          config: instance.config
        };
        return {
          listVersions: (query) => plugin.listVersions(ctx, query),
          resolveDigest: (ref) => plugin.resolveDigest(ctx, ref),
          describeIndex: async () => plugin.describeIndex()
        };
      }
    };
  }

  async function countDecisions(subjectId: string): Promise<number> {
    return inOrg(async (tx) => {
      const rows = await tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, DEPENDENCY_VERSION_POLL_DECISION_KIND)
          )
        );
      return rows.length;
    });
  }

  /** Only the org's own registry is reachable. NO language index url, NO operator feed. */
  const AIRGAP_ENV: NodeJS.ProcessEnv = {};

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dep-version-poll");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // No acting-user lookup here, and that is the point. See docs/dependencies.md §421.

    scratch = mkdtempSync(join(tmpdir(), "scp-version-poll-"));
    feedDir = join(scratch, "feed");
    // A fake vendored skopeo printing the REAL `list-tags` / `inspect` documents.
    skopeoBin = join(scratch, "skopeo");
    writeFileSync(
      skopeoBin,
      `#!/bin/sh
case "$1" in
  list-tags) echo '{"Repository":"registry.internal/acme/base","Tags":["3.18.9","3.19.0","3.19.1","3.19.2-alpine","latest","20240115"]}';;
  inspect) echo '{"Name":"registry.internal/acme/base","Digest":"sha256:${"b".repeat(64)}"}';;
  *) exit 1;;
esac
`,
      "utf8"
    );
    chmodSync(skopeoBin, 0o755);
    AIRGAP_ENV.SCP_SKOPEO_BIN = skopeoBin;
    AIRGAP_ENV.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = "registry.internal";
    // `resolveSkopeo()` reads process.env directly (it is install-time deployment config, not a
    // per-call parameter), so the pinned-binary override is set on the process for this file.
    process.env.SCP_SKOPEO_BIN = skopeoBin;

    subscribed = (await createOrphanComponent(server, org, `poll-sub-${uuidv7()}`)).id;
    unsubscribed = (await createOrphanComponent(server, org, `poll-unsub-${uuidv7()}`)).id;

    await declare(subscribed, {
      ecosystem: "oci",
      coordinate: "registry.internal/acme/base",
      major: "3.19"
    });
    await declare(subscribed, { ecosystem: "go", coordinate: "example.com/go-lib", major: "v1" });
    await declare(subscribed, { ecosystem: "npm", coordinate: "@acme/lib", major: "4" });
    await declare(subscribed, { ecosystem: "python", coordinate: "acme-py", major: "2" });
    await declare(subscribed, { ecosystem: "maven", coordinate: "com.acme:lib", major: "6" });
    // The opted-out line and the unsubscribed component's line: both DECLARED, so their absence
    // from the poll is about enablement rather than about having nothing to poll.
    await declare(subscribed, { ecosystem: "npm", coordinate: "@acme/opted-out", major: "1" });
    await declare(unsubscribed, { ecosystem: "npm", coordinate: "@acme/lib", major: "4" });

    await admin.policies.create({
      name: `dep-sub-enable-${uuidv7().slice(0, 8)}`,
      urn: `urn:scp:${org.orgId}:policy:dep-sub-enable`,
      properties: {
        scope: { objectRef: subscribed },
        enforcement: "advisory",
        effects: [{ dependencySubscription: { enabled: true } }]
      }
    });
    await admin.policies.create({
      name: `dep-sub-optout-${uuidv7().slice(0, 8)}`,
      urn: `urn:scp:${org.orgId}:policy:dep-sub-optout`,
      properties: {
        scope: { objectRef: subscribed },
        enforcement: "advisory",
        effects: [
          {
            dependencySubscription: {
              enabled: false,
              ecosystem: "npm",
              coordinate: "@acme/opted-out"
            }
          }
        ]
      }
    });
    await setInstanceUnlock(true);
  });

  afterAll(async () => {
    await setInstanceUnlock(null).catch(() => undefined);
    delete process.env.SCP_SKOPEO_BIN;
    rmSync(scratch, { recursive: true, force: true });
    await server?.close();
  });

  // (0) The index subprocesses have a LIFECYCLE (M21.4 MINOR E)

  /** A daily job that never stops what it starts accumulates. See docs/dependencies.md §422. */
  it("stops every index plugin instance it started, and starts at least one (M21.4 MINOR E)", async () => {
    const host = realIndexHost();
    await pollOrgDependencyVersions(server.deps.db, org.orgId, { host, env: AIRGAP_ENV });

    // NEGATIVE CONTROL FIRST, and it is the half that matters: a sweep that started nothing would
    // satisfy "nothing is left running" trivially, and this suite would be asserting about a
    // fixture that never applied.
    expect(
      host.stopped.length,
      "the sweep must actually have started an index instance"
    ).toBeGreaterThan(0);
    for (const id of host.stopped) expect(id).toMatch(/^dependency-index:/);
    expect(host.live, "no index subprocess is left standing after the sweep").toEqual(new Set());
  });

  it("stops what it started even when the sweep throws (M21.4 MINOR E)", async () => {
    const host = realIndexHost();
    const exploding: PluginHost = {
      ...host,
      dependencyIndex(instanceId: string) {
        const real = host.dependencyIndex(instanceId);
        return {
          ...real,
          listVersions: async () => {
            throw new Error("injected: this index is broken");
          }
        };
      }
    };
    // The per-line catch turns this into `unavailable` rather than a throw, so drive the failure
    // through the layer that CAN throw: the Decision write is inside the same try, and the teardown
    // must be in a `finally` either way.
    await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: exploding,
      env: AIRGAP_ENV
    });
    expect(host.live, "a failing sweep still tears down its subprocesses").toEqual(new Set());
  });

  // (4) The air-gap asymmetry — images work, language ecosystems report unavailable

  it("air-gap: with only a local registry configured, IMAGE detection works and the four language ecosystems report UNAVAILABLE", async () => {
    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env: AIRGAP_ENV
    });
    const byLine = new Map(results.map((r) => [r.lineId, r]));

    // IMAGES: fully served by the org's own registry, through the existing skopeo reach.
    const image = byLine.get(lineIds.get("oci:registry.internal/acme/base")!);
    expect(image?.outcome.status).toBe("observed");
    if (image?.outcome.status !== "observed") throw new Error("unreachable");
    // `latest` and `20240115` were offered and SKIPPED (not string-ordered); `3.19.2-alpine` is a
    // different variant line; `3.18.9` is a different minor line.
    expect(image.outcome.head).toEqual({ version: "3.19.1", digest: `sha256:${"b".repeat(64)}` });
    expect(image.headRecorded).toBe(true);

    // …and the observation really landed on the row, digest included.
    const row = await inOrg((tx) => getDependencyLineById(tx, org.orgId, image.lineId));
    expect(row?.latestVersion).toBe("3.19.1");
    expect(row?.latestDigest).toBe(`sha256:${"b".repeat(64)}`);
    expect(row?.latestObservedAt).not.toBeNull();

    // LANGUAGE ECOSYSTEMS: no index, no feed ⇒ an explicit unavailable, and NOTHING recorded.
    for (const key of [
      "go:example.com/go-lib",
      "npm:@acme/lib",
      "python:acme-py",
      "maven:com.acme:lib"
    ]) {
      const result = byLine.get(lineIds.get(key)!);
      expect(result?.outcome.status, key).toBe("unavailable");
      if (result?.outcome.status !== "unavailable") throw new Error("unreachable");
      expect(result.outcome.reason).toBe("not_configured");
      expect(result.headRecorded).toBe(false);
      const languageRow = await inOrg((tx) => getDependencyLineById(tx, org.orgId, result.lineId));
      // (3) NOTHING RECORDED — `latest_version` NULL is "not yet observed", which is emphatically
      // not "no newer version exists".
      expect(languageRow?.latestVersion, key).toBeNull();
    }
  });

  // (2) The work-list is the resolution, not a filter

  it("a component whose subscription is not enabled, and an opted-out line, are NEVER polled", async () => {
    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env: AIRGAP_ENV
    });
    const polled = new Set(results.map((r) => r.lineId));

    // The opted-out line is declared by the SUBSCRIBED component and is still absent.
    expect(polled.has(lineIds.get("npm:@acme/opted-out")!)).toBe(false);
    expect(await countDecisions(lineIds.get("npm:@acme/opted-out")!)).toBe(0);

    // NEGATIVE CONTROL: the same component's other npm line IS polled, so the absence above is
    // about the opt-out and not about npm, the component, or the poll being inert.
    expect(polled.has(lineIds.get("npm:@acme/lib")!)).toBe(true);

    // The unsubscribed component declares `@acme/lib` too — one LINE, polled once, with only the
    // enabled component named as a subscriber.
    const decisionRows = await inOrg((tx) =>
      tx
        .select({ inputContext: decisions.inputContext })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, lineIds.get("npm:@acme/lib")!),
            eq(decisions.kind, DEPENDENCY_VERSION_POLL_DECISION_KIND)
          )
        )
    );
    const context = decisionRows[0]?.inputContext as { subscribedComponentObjectIds?: string[] };
    expect(context?.subscribedComponentObjectIds).toEqual([subscribed]);
    expect(context?.subscribedComponentObjectIds).not.toContain(unsubscribed);
  });

  it("locking the instance empties the work-list entirely — the first conjunct still governs", async () => {
    await setInstanceUnlock(false);
    try {
      const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
        host: realIndexHost(),
        env: AIRGAP_ENV
      });
      expect(results).toEqual([]);
    } finally {
      await setInstanceUnlock(true);
    }
  });

  it("a SECOND identical tick writes ZERO new Decision rows", async () => {
    // An operator feed makes every ecosystem answer, so this exercises the `observed` verdict as
    // well as the `unavailable` one — the amplification hazard applies to both.
    const env: NodeJS.ProcessEnv = { ...AIRGAP_ENV, SCP_DEPENDENCY_INDEX_FEED_DIR: feedDir };
    rmSync(feedDir, { recursive: true, force: true });
    mkdirSync(feedDir, { recursive: true });
    writeFileSync(
      join(feedDir, DEPENDENCY_INDEX_FEED_FILE),
      buildDependencyIndexFeed([
        {
          ecosystem: "go",
          coordinate: "example.com/go-lib",
          versions: ["v1.2.0", "v1.3.0", "v2.0.0"]
        },
        { ecosystem: "npm", coordinate: "@acme/lib", versions: ["4.17.20", "4.17.21", "5.0.0"] },
        { ecosystem: "python", coordinate: "acme-py", versions: ["2.1.0", "2.2.0"] },
        { ecosystem: "maven", coordinate: "com.acme:lib", versions: ["6.1.3", "6.1.4"] }
      ]),
      "utf8"
    );

    const first = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env
    });
    expect(first.length).toBeGreaterThan(0);
    const before = new Map<string, number>();
    for (const result of first) before.set(result.lineId, await countDecisions(result.lineId));
    // Every line answered this time — the feed covers the four language ecosystems and the local
    // registry covers the image — so the second tick is comparing a full set of real verdicts.
    expect(first.every((r) => r.outcome.status === "observed")).toBe(true);

    const second = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env
    });

    for (const result of second) {
      // `created === false` is `insertDecisionIfChanged`'s own report that it suppressed a
      // byte-identical restatement…
      expect(result.decisionCreated, `line ${result.lineId} rewrote its verdict`).toBe(false);
      // …and the row count is the independent check on it, in case the flag ever lies.
      expect(await countDecisions(result.lineId)).toBe(before.get(result.lineId));
    }
  });

  it("a CHANGED head does write a new Decision — suppression is content-keyed, not identity-keyed", async () => {
    // NEGATIVE CONTROL for the test above: without this, a resolver that suppressed EVERYTHING
    // (never writing after the first row) would pass it perfectly.
    const env: NodeJS.ProcessEnv = { ...AIRGAP_ENV, SCP_DEPENDENCY_INDEX_FEED_DIR: feedDir };
    const lineId = lineIds.get("npm:@acme/lib")!;
    const before = await countDecisions(lineId);

    writeFileSync(
      join(feedDir, DEPENDENCY_INDEX_FEED_FILE),
      buildDependencyIndexFeed([
        {
          ecosystem: "go",
          coordinate: "example.com/go-lib",
          versions: ["v1.2.0", "v1.3.0", "v2.0.0"]
        },
        // 4.17.22 is new on the v4 line.
        {
          ecosystem: "npm",
          coordinate: "@acme/lib",
          versions: ["4.17.20", "4.17.21", "4.17.22", "5.0.0"]
        },
        { ecosystem: "python", coordinate: "acme-py", versions: ["2.1.0", "2.2.0"] },
        { ecosystem: "maven", coordinate: "com.acme:lib", versions: ["6.1.3", "6.1.4"] }
      ]),
      "utf8"
    );

    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env
    });
    const npm = results.find((r) => r.lineId === lineId);
    expect(npm?.outcome.status).toBe("observed");
    if (npm?.outcome.status !== "observed") throw new Error("unreachable");
    expect(npm.outcome.head.version).toBe("4.17.22");
    expect(npm.decisionCreated).toBe(true);
    expect(await countDecisions(lineId)).toBe(before + 1);

    const row = await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId));
    expect(row?.latestVersion).toBe("4.17.22");
    // A language ecosystem carries no digest at all, so the pair this observation wrote is
    // (4.17.22, null).
    expect(row?.latestDigest).toBeNull();
  });

  // The head is a HEAD — an index that goes backwards does not drag it back

  it("an index that no longer offers the head does NOT walk the line backwards", async () => {
    // Runs against the state the test above left: this line's head is 4.17.22. A feed regenerated
    // from a mirror that has not caught up — or a yanked release — now offers only 4.17.21, which is
    // the greatest version ON THE LINE that the index knows. Writing it would move every subscriber
    // back onto a release they have already passed, and nothing would look wrong afterwards.
    const env: NodeJS.ProcessEnv = { ...AIRGAP_ENV, SCP_DEPENDENCY_INDEX_FEED_DIR: feedDir };
    const lineId = lineIds.get("npm:@acme/lib")!;
    expect(
      (await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId)))?.latestVersion,
      "the fixture this test depends on"
    ).toBe("4.17.22");

    writeFileSync(
      join(feedDir, DEPENDENCY_INDEX_FEED_FILE),
      buildDependencyIndexFeed([
        { ecosystem: "npm", coordinate: "@acme/lib", versions: ["4.17.20", "4.17.21"] }
      ]),
      "utf8"
    );

    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: realIndexHost(),
      env
    });
    const npm = results.find((r) => r.lineId === lineId);
    // The index ANSWERED and was understood — this is not `unavailable`, and that distinction is
    // what makes the refusal below about the ordering rather than about a failed fetch.
    expect(npm?.outcome.status).toBe("observed");
    if (npm?.outcome.status !== "observed") throw new Error("unreachable");
    expect(npm.outcome.head.version).toBe("4.17.21");
    expect(npm.headRecorded, "nothing was written").toBe(false);
    expect(npm.headRefusedReason).toBe("behind_head");

    const row = await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId));
    expect(row?.latestVersion, "the head stands where the newer observation left it").toBe(
      "4.17.22"
    );

    // …and the refusal is LEGIBLE rather than silent (charter principle 6).
    const decisionRows = await inOrg((tx) =>
      tx
        .select({ verdict: decisions.verdict, reasonTree: decisions.reasonTree })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, lineId),
            eq(decisions.kind, DEPENDENCY_VERSION_POLL_DECISION_KIND)
          )
        )
        .orderBy(decisions.createdAt)
    );
    const latest = decisionRows[decisionRows.length - 1];
    expect(latest?.verdict).toBe("not_recorded");
    expect(JSON.stringify(latest?.reasonTree)).toMatch(/behind_head/);
  });

  it("a NEW tag whose digest cannot be resolved never inherits the PREVIOUS version's digest", async () => {
    // The row asserts a PAIR. See docs/dependencies.md §423.
    const lineId = lineIds.get("oci:registry.internal/acme/base")!;
    const before = await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId));
    expect(before?.latestVersion, "the fixture this test depends on").toBe("3.19.1");
    expect(before?.latestDigest, "…and it must carry a digest to go stale").toBe(
      `sha256:${"b".repeat(64)}`
    );

    // A registry that offers a NEWER tag and whose `inspect` fails — a mirror that lists tags it
    // cannot serve manifests for, an expired credential, a transient 5xx.
    const brokenInspect = join(scratch, "skopeo-broken-inspect");
    writeFileSync(
      brokenInspect,
      `#!/bin/sh
case "$1" in
  list-tags) echo '{"Repository":"registry.internal/acme/base","Tags":["3.19.1","3.19.2"]}';;
  *) exit 1;;
esac
`,
      "utf8"
    );
    chmodSync(brokenInspect, 0o755);
    const previousSkopeo = process.env.SCP_SKOPEO_BIN;
    process.env.SCP_SKOPEO_BIN = brokenInspect;
    try {
      const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
        host: realIndexHost(),
        env: { ...AIRGAP_ENV, SCP_SKOPEO_BIN: brokenInspect }
      });
      const image = results.find((r) => r.lineId === lineId);
      expect(image?.outcome.status).toBe("observed");
      if (image?.outcome.status !== "observed") throw new Error("unreachable");
      expect(image.outcome.head.version).toBe("3.19.2");
      expect(image.outcome.head.digest, "explicitly null, never absent").toBeNull();
      expect(image.headRecorded).toBe(true);
    } finally {
      if (previousSkopeo === undefined) delete process.env.SCP_SKOPEO_BIN;
      else process.env.SCP_SKOPEO_BIN = previousSkopeo;
    }

    const row = await inOrg((tx) => getDependencyLineById(tx, org.orgId, lineId));
    expect(row?.latestVersion).toBe("3.19.2");
    expect(
      row?.latestDigest,
      "3.19.1's bytes must not be reported as 3.19.2's — the pair moves together"
    ).toBeNull();
  });

  // (5) The ingress split — an internal line is never polled

  it("an INTERNAL line is NEVER asked of an index, while a third-party line IS", async () => {
    // THE FAILURE THIS PINS IS DEPENDENCY CONFUSION. See docs/dependencies.md §424.
    const internalLineId = await declare(subscribed, {
      ecosystem: "npm",
      coordinate: "@acme/internal-lib",
      major: "2"
    });
    await inOrg((tx) =>
      declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/internal-lib",
        producerObjectId: subscribed,
        declaredByObjectId: subscribed
      })
    );
    // READ BACK: without the producer declaration this test proves nothing at all — the coordinate
    // would simply be third-party and the assertions below would be about a fixture that never
    // applied. (`internalLineId` is still asserted on below; it is minted above.)
    expect(internalLineId).toBeTruthy();
    expect(
      (
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, {
            ecosystem: "npm",
            coordinate: "@acme/internal-lib"
          })
        )
      )?.producerObjectId
    ).toBe(subscribed);

    // A host that RECORDS every coordinate it is asked about and answers generously — so an
    // absence below is "nobody asked", not "the index had nothing".
    const asked: string[] = [];
    const recordingHost: PluginHost = {
      async start() {},
      async stop() {},
      async stopInstances() {},
      gitFileRead: () => {
        throw new Error("not wired");
      },
      executor: () => {
        throw new Error("not wired");
      },
      control: () => {
        throw new Error("not wired");
      },
      discovery: () => {
        throw new Error("not wired");
      },
      notification: () => {
        throw new Error("not wired");
      },
      federationTransport: () => {
        throw new Error("not wired");
      },
      dependencyIndex(): DependencyIndexPluginClient {
        return {
          listVersions: async (query) => {
            asked.push(`${query.ecosystem}:${query.coordinate}`);
            return { status: "available", versions: [{ version: "9.9.9" }, { version: "2.9.9" }] };
          },
          resolveDigest: async () => ({
            status: "unavailable" as const,
            reason: "not_configured" as const,
            detail: "this recording host resolves no digests"
          }),
          describeIndex: async () => ({ ecosystem: "npm" as const, reportsDigest: false })
        };
      }
    };

    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: recordingHost,
      // An npm index IS configured here, so the npm lines genuinely reach the plugin — without this
      // they would fall through to the feed and "never asked" would be true for the wrong reason.
      env: { ...AIRGAP_ENV, SCP_DEPENDENCY_INDEX_NPM_URL: "https://npm.internal" }
    });

    expect(asked, "the internal coordinate was never fetched").not.toContain(
      "npm:@acme/internal-lib"
    );
    // NEGATIVE CONTROL: the very same tick, the same ecosystem, the same subscribing component —
    // the THIRD-PARTY line IS asked. Without this the absence above is satisfied by a poll that
    // fetched nothing at all.
    expect(asked, "…and a third-party line on the same tick IS").toContain("npm:@acme/lib");

    // Nothing was recorded for it, and no verdict was written about it either: it is not in this
    // ingress's work-list at all, rather than fetched-and-discarded.
    expect(results.map((r) => r.lineId)).not.toContain(internalLineId);
    expect(await countDecisions(internalLineId)).toBe(0);
    const internalRow = await inOrg((tx) => getDependencyLineById(tx, org.orgId, internalLineId));
    expect(internalRow?.latestVersion, "a stranger's 9.9.9 never reached this line").toBeNull();
  });

  // (6) THE RACE ACROSS THE TRANSACTION BOUNDARY — rule 0 at the write door

  /** Replay of the measured race, at the exact seam. See docs/dependencies.md §425. */
  it("a declare landing mid-poll REFUSES the in-flight public head, fires no bump, and leaves the line fixable", async () => {
    const coordinate = `@acme/race-declare-${uuidv7().slice(0, 8)}`;
    const lineId = await declare(subscribed, { ecosystem: "npm", coordinate, major: "2" });

    // t0 — THE POLL'S OWN WORK-LIST, before anything is declared. This is the transaction whose
    // `ThirdPartyLine` brand used to be the only barrier, and it genuinely holds this line: without
    // that the refusal below would be about a line the poll never intended to write.
    const work = await buildLineWorkList(server.deps.db, org.orgId);
    const item = work.find((w) => w.line.id === lineId);
    expect(item, "t0: the poll must have picked this line up as THIRD-PARTY").toBeDefined();

    // t1 — the declaration lands in the window, exactly as the two producer verbs write it: the
    // declaration and `resetLineHead` for every line of the coordinate, in ONE transaction.
    await inOrg(async (tx) => {
      await declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: "npm",
        coordinate,
        producerObjectId: subscribed,
        declaredByObjectId: subscribed
      });
      await resetLineHead(tx, org.orgId, lineId);
    });

    const outboxBefore = await headAdvancedRows(lineId);

    // t2 — the poll's write call, with the answer it fetched at t0.
    const refused = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.99.0", latestDigest: null },
        { kind: "third_party" }
      )
    );
    expect(refused.recorded, "the public head must be REFUSED, not written").toBe(false);
    if (refused.recorded) throw new Error("unreachable");
    expect(refused.reason).toBe("line_is_internal");
    expect(refused.detail).toMatch(/producer is declared/);
    expect(refused.line.latestVersion, "the column was left alone").toBeNull();

    // AND NO FAN-OUT. The event is emitted at the write door, so a refusal that still emitted would
    // author bump PRs in other teams' repositories onto a stranger's version — the damage the head
    // column is only the record of.
    expect(
      (await headAdvancedRows(lineId)).length,
      "a refused head emits no line_head_advanced event"
    ).toBe(outboxBefore.length);

    // …AND THE LINE IS STILL FIXABLE, which is the half that made the original defect permanent:
    // the poll no longer visits an internal line, so if 2.99.0 had landed nothing would ever have
    // corrected it and the org's real 2.1.0 would be refused as `behind_head` forever.
    const internal = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        // `subscribed` IS the component the declare at t1 named, so this is the ingress the line now
        // belongs to — the success direction that keeps the refusal above about the ingress split.
        { lineId, latestVersion: "2.1.0", latestDigest: null },
        { kind: "internal", producerObjectId: subscribed }
      )
    );
    expect(internal.recorded, "the legitimate internal head records").toBe(true);
    if (!internal.recorded) throw new Error("unreachable");
    expect(internal.movement).toBe("advanced");
    expect(internal.line.latestVersion).toBe("2.1.0");
    expect(
      (await headAdvancedRows(lineId)).length,
      "…and THAT advance does fan out, so the absence above is about the refusal"
    ).toBe(outboxBefore.length + 1);

    // The fact that made it unrecoverable, asserted rather than described: the poll's work-list no
    // longer contains the line, so nothing in that ingress could have corrected a bad head.
    const workAfter = await buildLineWorkList(server.deps.db, org.orgId);
    expect(workAfter.map((w) => w.line.id)).not.toContain(lineId);
  });

  /** THE SAME RACE WITH THE ARROW REVERSED. See docs/dependencies.md §426. */
  it("a retract landing mid-derivation REFUSES the in-flight internal head, and the public head then records", async () => {
    const coordinate = `@acme/race-retract-${uuidv7().slice(0, 8)}`;
    const lineId = await declare(subscribed, { ecosystem: "npm", coordinate, major: "2" });
    await inOrg((tx) =>
      declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: "npm",
        coordinate,
        producerObjectId: subscribed,
        declaredByObjectId: subscribed
      })
    );
    // FIXTURE READ-BACK: the line is genuinely internal at the moment the derivation starts, so the
    // refusal below is about the retraction and not about a declaration that never landed.
    expect(
      (
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      )?.producerObjectId
    ).toBe(subscribed);

    // The retraction lands mid-flight, as the retract verb writes it: the delete plus the clearing,
    // in one transaction.
    await inOrg(async (tx) => {
      await retractDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate });
      await resetLineHead(tx, org.orgId, lineId);
    });

    const outboxBefore = await headAdvancedRows(lineId);
    const refused = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.7.0", latestDigest: null },
        { kind: "internal", producerObjectId: subscribed }
      )
    );
    expect(refused.recorded).toBe(false);
    if (refused.recorded) throw new Error("unreachable");
    expect(refused.reason).toBe("line_is_third_party");
    expect(refused.line.latestVersion).toBeNull();
    expect((await headAdvancedRows(lineId)).length).toBe(outboxBefore.length);

    // POSITIVE CONTROL: the ingress that DOES own the line now writes it, so the refusal is about
    // who was asking and not about a door that has stopped writing.
    const polled = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.3.1", latestDigest: null },
        { kind: "third_party" }
      )
    );
    expect(polled.recorded).toBe(true);
    if (!polled.recorded) throw new Error("unreachable");
    expect(polled.line.latestVersion).toBe("2.3.1");
  });

  /** THE SAME RACE ONE LEVEL FINER. See docs/dependencies.md §427. */
  it("a TRANSFER landing mid-derivation REFUSES the FORMER producer's head, and the NEW producer's records", async () => {
    const coordinate = `@acme/race-transfer-${uuidv7().slice(0, 8)}`;
    const lineId = await declare(subscribed, { ecosystem: "npm", coordinate, major: "2" });
    // Q is a SECOND, REAL component. Without it this test could only compare a component against
    // itself, which is the very comparison the boolean form got right.
    const q = await createOrphanComponent(server, org, `race-transfer-new-producer-${uuidv7()}`);

    // t0 — the coordinate is P's (`subscribed`). P's derivation reads this in phase 1 and then
    // leaves the transaction to fetch a manifest.
    await inOrg((tx) =>
      declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: "npm",
        coordinate,
        producerObjectId: subscribed,
        declaredByObjectId: subscribed
      })
    );
    // FIXTURE READ-BACK: the line is genuinely P's at the moment the derivation starts, so the
    // refusal below is about the transfer and not about a declaration that never landed.
    expect(
      (
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      )?.producerObjectId
    ).toBe(subscribed);

    // t1 — THE TRANSFER, exactly as the declare verb writes it: the upsert (which displaces P) plus
    // `resetLineHead` for every line of the coordinate, in ONE transaction.
    await inOrg(async (tx) => {
      await declareDependencyLineProducer(tx, org.orgId, {
        ecosystem: "npm",
        coordinate,
        producerObjectId: q.id,
        declaredByObjectId: q.id
      });
      await resetLineHead(tx, org.orgId, lineId);
    });
    // AND THE COORDINATE IS STILL INTERNAL — the fact that makes this case distinct from the retract
    // test above, and the reason a boolean saw nothing wrong here.
    expect(
      (
        await inOrg((tx) =>
          getDependencyLineProducer(tx, org.orgId, { ecosystem: "npm", coordinate })
        )
      )?.producerObjectId,
      "the transfer must leave a declaration standing, naming Q"
    ).toBe(q.id);

    const outboxBefore = await headAdvancedRows(lineId);

    // t2 — P's phase-3 write, with the version it resolved at t0.
    const refused = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.9.9", latestDigest: null },
        { kind: "internal", producerObjectId: subscribed }
      )
    );
    expect(refused.recorded, "the FORMER producer's head must be REFUSED, not written").toBe(false);
    if (refused.recorded) throw new Error("unreachable");
    expect(refused.reason).toBe("line_transferred");
    expect(refused.detail).toContain(q.id);
    expect(refused.detail).toContain(subscribed);
    expect(refused.line.latestVersion, "the column was left alone").toBeNull();

    // AND NO FAN-OUT. The bump event is emitted at the write door, so a refusal that still emitted
    // would author PRs in other teams' repositories onto a version the coordinate's own publisher
    // did not release — the head column is only the record of that damage.
    expect(
      (await headAdvancedRows(lineId)).length,
      "a refused head emits no line_head_advanced event"
    ).toBe(outboxBefore.length);

    // …AND Q'S GENUINE RELEASE THEN RECORDS. This is the half that made the defect permanent: had
    // P's 2.9.9 landed, Q's 2.4.0 would be BEHIND it and refused forever, with no poll to correct
    // the line (it is internal) and no API to reset the column.
    const legit = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.4.0", latestDigest: null },
        { kind: "internal", producerObjectId: q.id }
      )
    );
    expect(legit.recorded, "the new producer's head records").toBe(true);
    if (!legit.recorded) throw new Error("unreachable");
    expect(legit.movement).toBe("advanced");
    expect(legit.line.latestVersion).toBe("2.4.0");
    expect(
      (await headAdvancedRows(lineId)).length,
      "…and THAT advance does fan out, so the absence above is about the refusal"
    ).toBe(outboxBefore.length + 1);

    // THE SUCCESS DIRECTION, CHECKED EXPLICITLY: the rule refuses a MISMATCH, not every internal
    // write. Q writing again to a line still declared to Q must still record — without this the
    // refusal above is satisfied by a door that has simply stopped writing internal heads.
    const again = await inOrg((tx) =>
      recordDependencyLineHead(
        tx,
        org.orgId,
        { lineId, latestVersion: "2.5.0", latestDigest: null },
        { kind: "internal", producerObjectId: q.id }
      )
    );
    expect(again.recorded).toBe(true);
    if (!again.recorded) throw new Error("unreachable");
    expect(again.line.latestVersion).toBe("2.5.0");
  });

  /** The refusal's explanation, read back from the table. See docs/dependencies.md §428. */
  it("the PERSISTED Decision for a line_is_internal refusal explains OWNERSHIP, not version ordering", async () => {
    const coordinate = `@acme/norecord-call-site-${uuidv7().slice(0, 8)}`;
    const lineId = await declare(subscribed, { ecosystem: "npm", coordinate, major: "2" });

    // The declaration lands DURING the poll, from inside the index round trip — the same window the
    // replay above drives at the repo seam, entered here through the code under test.
    let declaredDuringPoll = false;
    const declaringHost: PluginHost = {
      async start() {},
      async stop() {},
      async stopInstances() {},
      gitFileRead: () => {
        throw new Error("not wired");
      },
      executor: () => {
        throw new Error("not wired");
      },
      control: () => {
        throw new Error("not wired");
      },
      discovery: () => {
        throw new Error("not wired");
      },
      notification: () => {
        throw new Error("not wired");
      },
      federationTransport: () => {
        throw new Error("not wired");
      },
      dependencyIndex(): DependencyIndexPluginClient {
        return {
          listVersions: async (query) => {
            if (query.coordinate !== coordinate) {
              // Every OTHER line in this org's work-list answers nothing, so this tick writes one
              // `not_recorded` verdict and nothing else that could be mistaken for it.
              return {
                status: "unavailable" as const,
                reason: "not_configured" as const,
                detail: "this host answers only the coordinate under test"
              };
            }
            if (!declaredDuringPoll) {
              declaredDuringPoll = true;
              await inOrg(async (tx) => {
                await declareDependencyLineProducer(tx, org.orgId, {
                  ecosystem: "npm",
                  coordinate,
                  producerObjectId: subscribed,
                  declaredByObjectId: subscribed
                });
                await resetLineHead(tx, org.orgId, lineId);
              });
            }
            return { status: "available" as const, versions: [{ version: "2.99.0" }] };
          },
          resolveDigest: async () => ({
            status: "unavailable" as const,
            reason: "not_configured" as const,
            detail: "no digests here"
          }),
          describeIndex: async () => ({ ecosystem: "npm" as const, reportsDigest: false })
        };
      }
    };

    const results = await pollOrgDependencyVersions(server.deps.db, org.orgId, {
      host: declaringHost,
      env: { ...AIRGAP_ENV, SCP_DEPENDENCY_INDEX_NPM_URL: "https://npm.internal" }
    });

    // The fixture APPLIED, and it produced a real refusal of the shape this case is about — without
    // both of these the assertions below would pass on a Decision that was never written.
    expect(declaredDuringPoll, "the declaration must have landed inside the poll").toBe(true);
    const polled = results.find((r) => r.lineId === lineId);
    expect(polled?.headRefusedReason).toBe("line_is_internal");

    const [row] = await inOrg((tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, lineId),
            eq(decisions.kind, DEPENDENCY_VERSION_POLL_DECISION_KIND)
          )
        )
    );
    expect(row?.verdict).toBe("not_recorded");
    const reasonTree = row?.reasonTree as { reason?: string; norecord?: string };
    expect(reasonTree.reason).toBe("line_is_internal");

    // THE TEXT ITSELF. Positive: it explains the rule that actually fired. Negative: it does NOT
    // explain the version rules, which are true of this poll and simply not why nothing was
    // recorded — an operator reading that would go looking for a version-ordering problem on a line
    // whose head is perfectly ahead of the standing one.
    expect(reasonTree.norecord).toMatch(/a producer is declared for this coordinate/);
    expect(reasonTree.norecord).toMatch(/dependency confusion/);
    expect(reasonTree.norecord).not.toMatch(/never moves backwards/);
    expect(reasonTree.norecord).not.toMatch(/never leaves the line it names/);
  });

  async function headAdvancedRows(lineId: string) {
    return inOrg((tx) =>
      tx
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.orgId, org.orgId),
            eq(outbox.type, DEPENDENCY_LINE_HEAD_ADVANCED_EVENT),
            eq(outbox.subject, lineId)
          )
        )
    );
  }
});

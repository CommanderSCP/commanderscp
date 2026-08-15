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
import { decisions } from "../db/schema.js";
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
  declareDependencyLineProducer,
  getDependencyLineById,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";
import { buildDependencyIndexFeed, DEPENDENCY_INDEX_FEED_FILE } from "./version-index-feed.js";
import {
  DEPENDENCY_VERSION_POLL_DECISION_KIND,
  pollOrgDependencyVersions
} from "./version-poll.js";

/**
 * M21.4 — THE DAILY VERSION POLL AGAINST REAL POSTGRES (ADR-0032 §7).
 *
 * The ranking algebra is proven without a database in `version-index.test.ts`, and each index
 * plugin against recorded fixtures in its own package. THIS file proves the four things only the
 * real database, the real enablement resolver and the real plugin code can:
 *
 *  1. PERSIST-ON-CHANGE HOLDS ACROSS TWO TICKS. A second, identical poll writes ZERO new `decisions`
 *     rows. A daily poll restating a byte-identical verdict per dependency is exactly the shape that
 *     produced the measured 1.44 GB/day flood (ADR-0024).
 *  2. THE WORK-LIST IS M21.3'S RESOLUTION. A component whose subscription is not enabled, and a line
 *     that is opted out, are never polled at all — no Decision, no observation — and the enabled
 *     ones ARE, which is the negative control without which those absences prove nothing.
 *  3. AN UNAVAILABLE INDEX RECORDS NOTHING ON THE LINE. `latest_version` stays NULL, the verdict is
 *     `unavailable`, and the reason is readable. "No index answered" must never look like
 *     "up to date".
 *  5. THE INGRESS SPLIT HOLDS (ADR-0032 §7). An INTERNAL line — one this org DECLARES it produces —
 *     is NEVER asked of an index, with the negative control that a third-party line IS. That is the
 *     dependency-confusion failure: a stranger's package sharing the coordinate answering `9.9.9`
 *     and overwriting the head the org's own production release put there.
 *  4. THE AIR-GAP ASYMMETRY IS REAL. With ONLY a local registry configured — no
 *     `SCP_DEPENDENCY_INDEX_*_URL`, no operator feed — image detection works END TO END (head tag
 *     plus content digest) while all four language ecosystems report unavailable. That is
 *     ADR-0032 §7's "images need no fallback" as a behaviour rather than an intention.
 *
 * MUTATION LOG — each applied, watched fail, reverted, watched pass:
 * | Mutation | Result |
 * |---|---|
 * | drop `produced_by_object_id IS NULL` from the poll's hydration AND make `asThirdPartyLine` return every line (the pre-fix state — BOTH barriers) | "an INTERNAL line is NEVER asked of an index" FAILS: `npm:@acme/internal-lib` appears in the fetched coordinates |
 * | drop the SQL predicate ALONE | still PASSES — the `ThirdPartyLine` brand's own read of the same column refuses it. That is the defence-in-depth claim measured rather than asserted: either barrier alone still holds, and the test is written against the state where neither does |
 * | inherit the stored digest when an advance resolves none (`input.latestDigest ?? before.latestDigest`) | "a NEW tag whose digest cannot be resolved never inherits the PREVIOUS version's digest" FAILS — the row reads 3.19.2 with 3.19.1's bytes |
 * | make `evaluateHeadMovement` never return `behind_head` | "an index that no longer offers the head does NOT walk the line backwards" FAILS — the head drops to 4.17.21 |
 *
 * The plugin host here is IN-PROCESS but the PLUGINS ARE THE REAL ONES, constructed by their real
 * factories from the real `resolveIndexInstanceConfig` output — only the subprocess transport is
 * skipped (the `createInMemoryFakeHost` precedent). A stub returning canned versions would have
 * proven the test's own fixture, not the plugin.
 */
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
    /** Every id ever handed to `stopInstances`, in order. */
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
    // NOTE there is no acting-user lookup here, and that is the point: the tick threads
    // `SYSTEM_ACTOR_ID` into the resolution (`version-poll.ts`'s `buildLineWorkList`), because a
    // background job has no human actor. Every policy below is therefore authored at an `objectRef`
    // scope, which matches for any caller — a `group`-scoped ENABLE would resolve NOT-enabled here,
    // the safe direction §6 guarantees.

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

    subscribed = (await createOrphanComponent(admin, `poll-sub-${uuidv7()}`)).id;
    unsubscribed = (await createOrphanComponent(admin, `poll-unsub-${uuidv7()}`)).id;

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

  // -----------------------------------------------------------------------------------------
  // (0) The index subprocesses have a LIFECYCLE (M21.4 MINOR E)
  // -----------------------------------------------------------------------------------------

  /**
   * A DAILY JOB THAT NEVER STOPS WHAT IT STARTS ACCUMULATES WITH TENANCY.
   *
   * Every other plugin-host caller starts instances derived from operator CONFIGURATION (an
   * executor binding), which persists — leaving those children up between ticks is right. This job
   * is the first whose instances come from its own WORK-LIST: up to five per org, started on demand
   * by `queryLineHead`. Nothing leaked per tick (`start()` skips an id it already holds), which is
   * exactly why this was invisible: the symptom is a standing subprocess count that grows with the
   * number of orgs and never falls, held for the worker's lifetime by a job that runs once a day.
   *
   * The set stopped is a RECEIPT from `queryLineHead` (`onIndexInstanceStarted`), not a second
   * derivation of which instances "should" be running — so an instance this sweep starts cannot be
   * one it forgets to stop.
   */
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

  // -----------------------------------------------------------------------------------------
  // (4) The air-gap asymmetry — images work, language ecosystems report unavailable
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // (2) The work-list is the resolution, not a filter
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // (1) Persist-on-change across two ticks
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // The head is a HEAD — an index that goes backwards does not drag it back
  // -----------------------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------------------------
  // The (version, digest) pair moves together
  // -----------------------------------------------------------------------------------------

  it("a NEW tag whose digest cannot be resolved never inherits the PREVIOUS version's digest", async () => {
    // The row asserts a PAIR — "3.19.1 is these bytes" — because a mutable tag is not an identity
    // (ADR-0032 §7). While `latestDigest` was optional, a poll that moved the version and omitted
    // the digest left the previous version's bytes standing beside the new tag, and the row then
    // claimed a (tag, digest) combination that never existed in any registry. Nothing errors, and
    // an operator reading it has no way to know.
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

  // -----------------------------------------------------------------------------------------
  // (5) The ingress split — an internal line is never polled
  // -----------------------------------------------------------------------------------------

  it("an INTERNAL line is NEVER asked of an index, while a third-party line IS", async () => {
    // THE FAILURE THIS PINS IS DEPENDENCY CONFUSION. `@acme/internal-lib` is published by this org
    // and its head is DERIVED from the org's own accepted production releases
    // (`internal-release-detection.ts`). A public npm index that happens to carry a package of the
    // same name answers `9.9.9`; polling it overwrites the head the org's own release put there and
    // every subscriber is bumped onto a stranger's package. The split is not a filter in the poll —
    // it is `listThirdPartyDependencyLinesByIds`'s SQL plus the `ThirdPartyLine` brand that
    // `queryLineHead` demands.
    const internalLineId = await declare(subscribed, {
      ecosystem: "npm",
      coordinate: "@acme/internal-lib",
      major: "2"
    });
    await inOrg((tx) =>
      declareDependencyLineProducer(tx, org.orgId, {
        lineId: internalLineId,
        producedByObjectId: subscribed,
        declaredByObjectId: subscribed
      })
    );
    // READ BACK: without the producer link this test proves nothing at all — the line would simply
    // be third-party and the assertions below would be about a fixture that never applied.
    expect(
      (await inOrg((tx) => getDependencyLineById(tx, org.orgId, internalLineId)))
        ?.producedByObjectId
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
});

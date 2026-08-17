import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { unwrapDriverError } from "../db/pg-errors.js";
import { changes, decisions, dependencyIngestionStamps, users } from "../db/schema.js";
import { createSourceMapping } from "../coordination/source-mappings-repo.js";
import { upsertExecutorBinding } from "../coordination/executor-bindings-repo.js";
import { DOMAIN_EVENTS_QUEUE, startPgBoss } from "../events/pgboss.js";
import type { GitFileReadPluginClient, PluginHost } from "../plugin-host/contract.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  listComponentDependencies,
  listDependencyLinesByIds
} from "./dependency-inventory-repo.js";
import {
  findIngestionStampByComponent,
  listIngestionStampsByComponents,
  recordIngestionStamp
} from "./ingestion-stamp-repo.js";
import {
  DEPENDENCY_INVENTORY_DECISION_KIND,
  ingestComponentManifests
} from "./inventory-ingestion.js";
import { resolveComponentIngestionGate } from "./subscription-resolution.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import {
  ingestChangeInventory,
  inventoryIngestionRouter,
  runInventoryIngestionJob,
  startInventoryIngestionLoop,
  type InventoryIngestionLoopHandle
} from "./inventory-ingestion-loop.js";

/**
 * M21.2 — DEPENDENCY-INVENTORY INGESTION AGAINST REAL POSTGRES (ADR-0032 §4, §6).
 *
 * ============================================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================================
 * `upsertComponentDependency` and `pruneComponentDependencies` had NO non-test caller, so
 * `component_dependencies` was empty on every real deployment and every capability above it —
 * the enablement work-list, the version poll, internal detection's manifest-path lookup — resolved
 * over nothing. Four earlier M21 components failed the same way and every one had passing tests,
 * because the tests called the component directly.
 *
 * So the assertions here are about the REAL PATH: the worker's own job function
 * (`runInventoryIngestionJob`), driving the real change row, the real `source_ref`, the real
 * enablement resolution and the real repo functions. Only the git provider is faked — and it is
 * faked with a RECORDER, not a mock, because the load-bearing claim about a disabled component is
 * that NOTHING WAS FETCHED, and the only honest evidence for that is an empty recording.
 *
 * ============================================================================================
 * THE FIVE PROPERTIES
 * ============================================================================================
 *  1. WIRED — the exact function the pg-boss worker calls, given the change id its router enqueues,
 *     writes the component's inventory. Deleting the wiring makes this red.
 *  2. GATED BY CONSTRUCTION — a component with no enabling subscription produces ZERO recorded
 *     reads, and the caller cannot opt out of that.
 *  3. UNREADABLE IS NOT EMPTY — each failure mode separately: a 404 HTML body, an LFS pointer, a
 *     truncated file, a size refusal, a reader throw, a missing REF. Every one leaves the existing
 *     inventory intact. A missing PATH is the one case that does prune, because it is the one case
 *     that is evidence about the manifest.
 *  4. IDEMPOTENT — a second pass over unchanged manifests adds no row, deletes no row, preserves
 *     `created_at`, and writes NO new Decision.
 *  5. PRUNE IS PER MANIFEST PATH — re-reading a `go.mod` never deletes what a `Dockerfile` declared.
 */
describe("M21.2 dependency-inventory ingestion (ADR-0032 §4/§6)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let actorObjectId: string;

  const inOrg = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** Operator-written over the ADMIN connection — `scp_app` holds no write grant on the singleton
   *  (0062's two barriers). Instance-global, so it is removed at teardown regardless of exit. */
  async function setInstanceUnlock(unlocked: boolean | null): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      if (unlocked === null) {
        await pool.query(`DELETE FROM dependency_subscription_unlock WHERE id = 'default'`);
        return;
      }
      await pool.query(
        `INSERT INTO dependency_subscription_unlock (id, unlocked, note, updated_at)
           VALUES ('default', $1, 'M21.2 ingestion fixture', now())
         ON CONFLICT (id) DO UPDATE SET unlocked = EXCLUDED.unlocked, updated_at = now()`,
        [unlocked]
      );
    } finally {
      await pool.end();
    }
  }

  /**
   * A recording fake git provider.
   *
   * IT RECORDS EVERY CALL, and that is the point rather than a convenience: "a disabled component is
   * never fetched" is an assertion about calls that did NOT happen, and a mock's `not.toHaveBeenCalled`
   * proves the same thing only if the mock is the ONLY route to the provider. A recorder that the
   * ingestion is handed, and whose log is asserted empty, is evidence about this run.
   */
  function recordingReader(files: Record<string, string | ReadFileAtRefResult>) {
    const reads: { repo: string | undefined; path: string; ref: string }[] = [];
    const read = async (request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult> => {
      reads.push({ repo: request.repo, path: request.path, ref: request.ref });
      const entry = files[request.path];
      if (entry === undefined) {
        // The routine answer to a probe: four of the five ecosystems are absent on any given
        // component (`read-file.ts`), so this must not throw and must not be an error.
        return {
          outcome: "not_found",
          missing: "path",
          path: request.path,
          requestedRef: request.ref
        };
      }
      if (typeof entry !== "string") return entry;
      return {
        outcome: "found",
        path: request.path,
        requestedRef: request.ref,
        // Deliberately NOT the requested ref: `readFileAtRef` returns what the ref RESOLVED to, and
        // that resolved commit is what must land on the row.
        commitSha: RESOLVED_COMMIT,
        content: entry,
        sizeBytes: Buffer.byteLength(entry, "utf8")
      };
    };
    return { read, reads };
  }

  const RESOLVED_COMMIT = "a".repeat(40);
  const REPO = "acme/widgets";

  const GO_MOD = `module github.com/acme/widgets

go 1.22

require (
	github.com/Masterminds/semver/v3 v3.2.1
	github.com/spf13/cobra v1.8.0
)
`;
  const DOCKERFILE = `FROM node:18.19.0-alpine\nRUN echo hi\n`;

  /** Enable dependency subscriptions for one component at `objectRef` scope — the whole authoring
   *  surface (ADR-0032 §3a). `objectRef` rather than `group` because the event-driven path resolves
   *  as the system sentinel, which is a member of nothing (§6a). */
  async function enable(componentObjectId: string): Promise<void> {
    const name = `sub-${uuidv7()}`;
    await admin.policies.create({
      name,
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      properties: {
        scope: { objectRef: componentObjectId },
        enforcement: "advisory",
        effects: [{ dependencySubscription: { enabled: true } }]
      }
    });
  }

  /** A component with a `source_mappings` row, which is where the probe prefix comes from. */
  async function componentWithMapping(
    label: string,
    pathPattern: string | null,
    repoPattern: string = REPO
  ): Promise<string> {
    const component = await createOrphanComponent(admin, `${label}-${uuidv7()}`);
    await addMapping(component.id, pathPattern, repoPattern);
    return component.id;
  }

  /** A second (third, …) `source_mappings` row for an existing component — the shape a component
   *  fed by two repositories actually has. */
  async function addMapping(
    componentIdOrUrn: string,
    pathPattern: string | null,
    repoPattern: string
  ): Promise<void> {
    await inOrg((tx) =>
      createSourceMapping(tx, {
        orgId: org.orgId,
        sourceKind: "github",
        repoPattern,
        ...(pathPattern !== null ? { pathPattern } : {}),
        componentIdOrUrn,
        type: "configuration"
      })
    );
  }

  /**
   * An ACCEPTED change targeting `componentObjectId`, carrying the canonical `source_ref` keys the
   * webhook ingress now lifts.
   *
   * The state is set directly because this file is about ingestion, not about the acceptance gate —
   * and it is READ BACK, because a fixture that silently did not apply would make every assertion
   * below pass for the wrong reason (`changes` is under `org_isolation` RLS, so a write on the bare
   * pool matches zero rows and says so nowhere).
   */
  async function acceptedChange(
    componentObjectId: string,
    sourceRef: Record<string, unknown>
  ): Promise<string> {
    const change = await admin.changes.propose({
      name: `rel-${uuidv7()}`,
      targets: [componentObjectId]
    });
    await inOrg((tx) =>
      tx
        .update(changes)
        .set({ state: "accepted", sourceRef })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    const [row] = await inOrg((tx) =>
      tx
        .select({ state: changes.state, sourceRef: changes.sourceRef })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    expect(row?.state, "the accepted-change fixture must have taken").toBe("accepted");
    expect(row?.sourceRef, "the source_ref fixture must have taken").toMatchObject(sourceRef);
    return change.id;
  }

  const inventoryOf = (componentObjectId: string) =>
    inOrg((tx) => listComponentDependencies(tx, org.orgId, componentObjectId));

  /** The component's ingestion stamp, or `null` — which means NEVER ATTEMPTED and nothing else. */
  const stampOf = (componentObjectId: string) =>
    inOrg((tx) => findIngestionStampByComponent(tx, org.orgId, componentObjectId));

  async function coordinatesOf(componentObjectId: string): Promise<string[]> {
    const rows = await inventoryOf(componentObjectId);
    const lines = await inOrg((tx) =>
      listDependencyLinesByIds(
        tx,
        org.orgId,
        rows.map((r) => r.lineId)
      )
    );
    const byId = new Map(lines.map((l) => [l.id, l]));
    return rows
      .map(
        (r) => `${r.manifestPath}:${byId.get(r.lineId)?.coordinate}@${byId.get(r.lineId)?.major}`
      )
      .sort();
  }

  const decisionsFor = (subjectId: string) =>
    inOrg((tx) =>
      tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, DEPENDENCY_INVENTORY_DECISION_KIND)
          )
        )
    );

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dep-inventory-ingest");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const [adminRow] = await server.deps.db
      .select({ objectId: users.objectId })
      .from(users)
      .where(eq(users.username, org.adminUsername));
    if (!adminRow?.objectId) throw new Error("expected the bootstrap admin to have a user object");
    actorObjectId = adminRow.objectId;
    await setInstanceUnlock(true);
  });

  afterAll(async () => {
    await setInstanceUnlock(null).catch(() => undefined);
    await server?.close();
  });

  // -------------------------------------------------------------------------------------------
  // 1. WIRED
  // -------------------------------------------------------------------------------------------
  describe("the real path", () => {
    it("the worker's own job function ingests an accepted change's component inventory", async () => {
      const component = await componentWithMapping("wired", "svc/api/**");
      await enable(component);
      const changeId = await acceptedChange(component, {
        repo: REPO,
        ref: "refs/heads/main",
        commit: RESOLVED_COMMIT
      });
      const reader = recordingReader({
        "svc/api/go.mod": GO_MOD,
        "svc/api/Dockerfile": DOCKERFILE
      });

      // THE EXACT FUNCTION `startInventoryIngestionLoop`'s worker calls, with the EXACT job shape
      // `inventoryIngestionRouter` enqueues — not a copy of either, and with the REAL manifest
      // reader the job builds for itself.
      const outcome = await runInventoryIngestionJob(
        {
          db: server.deps.db,
          host: server.deps.pluginHost!,
          config: server.deps.config
        },
        { orgId: org.orgId, changeObjectId: changeId }
      );

      // THE WIRING ASSERTION. The job read the change row, resolved its target to this component,
      // passed the enablement gate and reached the provider — which legibly refuses, because this
      // test org has no git-provider binding for `acme/widgets` and SCP will not read one repo with
      // another binding's credential (`manifest-reader.ts`). Every hop except the provider is real,
      // and the refusal is the receipt that the last hop was attempted.
      expect(outcome.verdict).toBe("evaluated");
      expect(outcome.components.map((c) => c.componentObjectId)).toEqual([component]);
      const attempted = outcome.components[0]!;
      expect(attempted.verdict).toBe("ingested");
      expect(attempted.reads).toBeGreaterThan(0);
      expect(attempted.skipped.every((s) => s.reason === "read_failed")).toBe(true);
      expect(attempted.skipped[0]?.detail).toContain("executor binding");
      // And it asked for the right paths at the right point: the prefix came from the component's
      // own `source_mappings`, and the ref from `source_ref.commit`.
      expect(attempted.skipped.map((s) => s.path)).toContain("svc/api/go.mod");

      // Now the same ingestion with a recording reader, to assert what it WRITES.
      const ingest = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(ingest.verdict).toBe("ingested");

      expect(await coordinatesOf(component)).toEqual([
        "svc/api/Dockerfile:node@18",
        "svc/api/go.mod:github.com/Masterminds/semver/v3@3",
        "svc/api/go.mod:github.com/spf13/cobra@1"
      ]);

      // The row records the RESOLVED commit, not the ref that was asked for — a branch name is not
      // an identity.
      const rows = await inventoryOf(component);
      expect(new Set(rows.map((r) => r.observedRef))).toEqual(new Set([RESOLVED_COMMIT]));

      // `oci` carries its literal variant suffix onto the line; the language ecosystems never do.
      const lines = await inOrg((tx) =>
        listDependencyLinesByIds(
          tx,
          org.orgId,
          rows.map((r) => r.lineId)
        )
      );
      expect(lines.find((l) => l.ecosystem === "oci")?.tagPattern).toBe("-alpine");
      expect(lines.filter((l) => l.ecosystem === "go").every((l) => l.tagPattern === null)).toBe(
        true
      );
      // NOTHING declared a producer. `produced_by_object_id` is a separate verb precisely so
      // ingestion cannot set it as a side effect of observing a manifest.
      expect(lines.every((l) => l.producedByObjectId === null)).toBe(true);
    });

    it("drives from the change: a change targeting no component ingests nothing", async () => {
      const service = await admin.object("service").create({ name: `svc-${uuidv7()}` });
      const changeId = await acceptedChange(service.id, { repo: REPO, commit: RESOLVED_COMMIT });
      const outcome = await ingestChangeInventory(
        { db: server.deps.db, host: server.deps.pluginHost!, config: server.deps.config },
        { orgId: org.orgId, changeObjectId: changeId }
      );
      expect(outcome.verdict).toBe("not_applicable");
    });

    it("re-reads the change's state rather than trusting the event that delivered it", async () => {
      const component = await componentWithMapping("stale-event", null);
      await enable(component);
      const change = await admin.changes.propose({
        name: `rel-${uuidv7()}`,
        targets: [component]
      });
      // Never accepted. The router only enqueues on `toState === 'accepted'`, but delivery is
      // at-least-once and out of band, so the handler must not act on a change that has moved on.
      const outcome = await ingestChangeInventory(
        { db: server.deps.db, host: server.deps.pluginHost!, config: server.deps.config },
        { orgId: org.orgId, changeObjectId: change.id }
      );
      expect(outcome.verdict).toBe("not_applicable");
      expect(outcome.detail).toContain("not 'accepted'");
      expect(await inventoryOf(component)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. GATED BY CONSTRUCTION
  // -------------------------------------------------------------------------------------------
  describe("the enablement gate", () => {
    it("a component with NO enabling subscription is never fetched — zero recorded reads", async () => {
      const component = await componentWithMapping("disabled", null);
      // Deliberately NOT enabled.
      const reader = recordingReader({ "go.mod": GO_MOD });
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("not_enabled");
      // THE ASSERTION THIS FILE EXISTS FOR: not "the mock was not called" but "this run made no
      // request of the provider at all".
      expect(reader.reads).toEqual([]);
      expect(outcome.reads).toBe(0);
      expect(await inventoryOf(component)).toEqual([]);
      // And no Decision: a component that is simply not subscribed is the common case on any
      // estate, and a row per accepted change saying so is the 1.44 GB/day shape.
      expect(await decisionsFor(component)).toEqual([]);
    });

    it("a LOCKED deployment fetches nothing, however enabled the component is", async () => {
      const component = await componentWithMapping("locked", null);
      await enable(component);
      await setInstanceUnlock(false);
      try {
        const reader = recordingReader({ "go.mod": GO_MOD });
        const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
          source: "backfill",
          componentObjectId: component,
          repo: REPO,
          ref: RESOLVED_COMMIT,
          readManifest: reader.read
        });
        expect(outcome.verdict).toBe("not_enabled");
        expect(reader.reads).toEqual([]);
      } finally {
        await setInstanceUnlock(true);
      }
      // The NEGATIVE CONTROL, without which the absence above proves nothing: the same component,
      // the same reader, with the deployment unlocked again.
      const reader = recordingReader({ "go.mod": GO_MOD });
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("ingested");
      expect(reader.reads.length).toBeGreaterThan(0);
    });

    it("an opted-out LINE is still INVENTORIED — an opt-out subtracts a subscription, not an observation", async () => {
      const component = await componentWithMapping("opted-out", null);
      await enable(component);
      const name = `optout-${uuidv7()}`;
      await admin.policies.create({
        name,
        urn: `urn:scp:${org.orgId}:policy:${name}`,
        properties: {
          scope: { objectRef: component },
          enforcement: "advisory",
          effects: [
            {
              dependencySubscription: { coordinate: "github.com/spf13/cobra", enabled: false }
            }
          ]
        }
      });
      const reader = recordingReader({ "go.mod": GO_MOD });
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      // Both lines are recorded. If the opt-out had suppressed the write, the prune would then have
      // deleted the row, the inventory would forget the component declares cobra at all, and
      // re-enabling would need a fresh push to recover it.
      expect(await coordinatesOf(component)).toEqual([
        "go.mod:github.com/Masterminds/semver/v3@3",
        "go.mod:github.com/spf13/cobra@1"
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. UNREADABLE IS NOT EMPTY — every failure mode, separately
  // -------------------------------------------------------------------------------------------
  describe("a manifest that cannot be read is skipped, never treated as declaring nothing", () => {
    /** A component with a populated inventory, ready to be re-ingested against a broken read.
     *  Returns the coordinates that must survive. */
    async function seeded(
      label: string,
      files: Record<string, string> = { "go.mod": GO_MOD }
    ): Promise<{ component: string; before: string[] }> {
      const component = await componentWithMapping(label, null);
      await enable(component);
      const reader = recordingReader(files);
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("ingested");
      const before = await coordinatesOf(component);
      expect(
        before.length,
        "the seed must have taken, or every survival check below is vacuous"
      ).toBeGreaterThan(0);
      return { component, before };
    }

    async function reingest(
      component: string,
      files: Record<string, string | ReadFileAtRefResult>
    ) {
      return ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader(files).read
      });
    }

    it("a 404 HTML body — ManifestParseError, caught per manifest", async () => {
      const { component, before } = await seeded("html-404");
      const outcome = await reingest(component, {
        "go.mod": "<!DOCTYPE html>\n<html><body>Not Found</body></html>\n"
      });
      expect(outcome.skipped.map((s) => s.reason)).toContain("manifest_unparseable");
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("an unexpanded Git-LFS pointer — valid text that the one non-throwing parser would ACCEPT", async () => {
      // ON `requirements.txt` DELIBERATELY. A pointer handed to `parseGoMod` throws and lands in the
      // parse-error arm anyway, so a go.mod case would pass with the LFS guard deleted and prove
      // nothing. `parseRequirementsTxt` NEVER throws (the format has no required construct to miss),
      // so the pointer's own lines would become this component's python inventory and the prune
      // would then delete the real declarations. This is the case the guard exists for.
      const { component, before } = await seeded("lfs", {
        "requirements.txt": "requests==2.31.0\nurllib3==2.2.1\n"
      });
      expect(before).toEqual(["requirements.txt:requests@2", "requirements.txt:urllib3@2"]);
      const outcome = await reingest(component, {
        "requirements.txt":
          "version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 42\n"
      });
      expect(outcome.skipped.find((s) => s.path === "requirements.txt")?.reason).toBe(
        "lfs_pointer"
      );
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("a TRUNCATED file — the bytes that arrived are not the format", async () => {
      // Seeded FROM the manifest that is then truncated, so the survival assertion is about the
      // rows this truncation could actually have destroyed. Seeding from a different manifest would
      // make the check pass on the per-path prune alone and prove nothing about truncation.
      const { component, before } = await seeded("truncated", { Dockerfile: DOCKERFILE });
      expect(before).toEqual(["Dockerfile:node@18"]);
      const outcome = await reingest(component, {
        // The response was cut before the `FROM` arrived: valid text, plausibly a Dockerfile, and
        // not one. `parseDockerfile` throws rather than reporting a base-image-free build.
        Dockerfile: "# syntax=docker/dockerfile:1\n# build the widget service\n"
      });
      expect(outcome.skipped.find((s) => s.path === "Dockerfile")?.reason).toBe(
        "manifest_unparseable"
      );
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("a file the provider REFUSED to decode — the file is there and was not read", async () => {
      const { component, before } = await seeded("too-large");
      const outcome = await reingest(component, {
        "go.mod": {
          outcome: "refused",
          reason: "too_large",
          detail: "42000000 bytes exceeds the decode bound",
          path: "go.mod",
          requestedRef: RESOLVED_COMMIT,
          sizeBytes: 42_000_000
        }
      });
      expect(outcome.skipped.find((s) => s.path === "go.mod")?.reason).toBe("too_large");
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("a reader that THROWS — no binding, an auth failure, an egress refusal", async () => {
      const { component, before } = await seeded("throws");
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: async () => {
          throw new Error("no github/gitea/gitlab executor binding is configured for this repo");
        }
      });
      expect(outcome.skipped.every((s) => s.reason === "read_failed")).toBe(true);
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("a missing REF is evidence about the ref, NOT about the manifest — nothing is pruned", async () => {
      const { component, before } = await seeded("bad-ref");
      const outcome = await reingest(component, {
        "go.mod": {
          outcome: "not_found",
          missing: "ref",
          path: "go.mod",
          requestedRef: RESOLVED_COMMIT,
          detail: "no commit b0b0 in acme/widgets"
        }
      });
      expect(outcome.skipped.find((s) => s.path === "go.mod")?.reason).toBe("ref_not_found");
      // A force-pushed branch must not empty the inventory of every component in the repo.
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("an INDETERMINATE not-found (GitLab answers both questions in one call) prunes nothing", async () => {
      const { component, before } = await seeded("indeterminate");
      const outcome = await reingest(component, {
        "go.mod": {
          outcome: "not_found",
          missing: "unknown",
          path: "go.mod",
          requestedRef: RESOLVED_COMMIT,
          detail: "404 Project Not Found"
        }
      });
      expect(outcome.skipped.find((s) => s.path === "go.mod")?.reason).toBe("read_indeterminate");
      expect(await coordinatesOf(component)).toEqual(before);
    });

    it("a missing PATH is the ONE case that does prune — the manifest was deleted", async () => {
      const { component, before } = await seeded("deleted");
      expect(before.length).toBe(2);
      // The recorder answers `not_found: path` for anything it does not hold, so an empty file set
      // IS "the manifest is gone from the repo".
      const outcome = await reingest(component, {});
      expect(outcome.manifests).toEqual([
        { path: "go.mod", declared: 0, pruned: 2, removed: true }
      ]);
      expect(await coordinatesOf(component)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. IDEMPOTENT
  // -------------------------------------------------------------------------------------------
  describe("idempotency", () => {
    it("re-ingesting an unchanged manifest adds no row, deletes no row, and writes NO new Decision", async () => {
      const component = await componentWithMapping("idempotent", null);
      await enable(component);
      const files = { "go.mod": GO_MOD, Dockerfile: DOCKERFILE };

      const first = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader(files).read
      });
      expect(first.decision?.created).toBe(true);
      const rowsBefore = await inventoryOf(component);
      const createdAtBefore = rowsBefore.map((r) => r.createdAt).sort();
      expect(rowsBefore.length).toBe(3);

      const second = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        // A DIFFERENT ref, deliberately: the second pass is a later commit with identical manifest
        // content, which is the ordinary case and the one that would churn a Decision per push if
        // the commit were part of the Decision's inputs.
        repo: REPO,
        ref: "b".repeat(40),
        readManifest: recordingReader(files).read
      });
      expect(second.manifests.every((m) => m.pruned === 0)).toBe(true);
      expect(second.decision?.created, "a byte-identical verdict must not append a row").toBe(
        false
      );
      expect(second.decision?.id).toBe(first.decision?.id);

      const rowsAfter = await inventoryOf(component);
      expect(rowsAfter.length).toBe(3);
      // `created_at` records when a declaration was FIRST seen; re-observing must not reset it.
      expect(rowsAfter.map((r) => r.createdAt).sort()).toEqual(createdAtBefore);
      expect(await decisionsFor(component)).toHaveLength(1);
    });

    it("a CHANGED manifest updates in place and prunes only what it dropped", async () => {
      const component = await componentWithMapping("changed", null);
      await enable(component);
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD, Dockerfile: DOCKERFILE }).read
      });
      expect(await coordinatesOf(component)).toHaveLength(3);

      const dropped = GO_MOD.replace(/\tgithub.com\/spf13\/cobra v1.8.0\n/, "");
      expect(dropped).not.toContain("cobra");
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": dropped, Dockerfile: DOCKERFILE }).read
      });

      // THE PRUNE IS PER MANIFEST PATH: the `go.mod` lost one dependency and the `Dockerfile`'s
      // declaration is untouched. A component-wide prune would have deleted the image line too.
      expect(outcome.manifests.find((m) => m.path === "go.mod")?.pruned).toBe(1);
      expect(outcome.manifests.find((m) => m.path === "Dockerfile")?.pruned).toBe(0);
      expect(await coordinatesOf(component)).toEqual([
        "Dockerfile:node@18",
        "go.mod:github.com/Masterminds/semver/v3@3"
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. WHAT CANNOT BE PLACED ON A LINE
  // -------------------------------------------------------------------------------------------
  it("a declaration with no comparable version is reported, never guessed onto a line", async () => {
    const component = await componentWithMapping("unpinned", null);
    await enable(component);
    const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      // `FROM alpine` pins nothing; Docker's implicit `:latest` is a RESOLUTION rule and writing it
      // as a version would invent text the author never wrote.
      readManifest: recordingReader({ Dockerfile: "FROM alpine\n" }).read
    });
    expect(outcome.declarationsSkipped).toEqual([
      {
        path: "Dockerfile",
        ecosystem: "oci",
        coordinate: "alpine",
        reason: "no_comparable_version",
        detail: expect.stringContaining("no comparable numeric core")
      }
    ]);
    expect(await inventoryOf(component)).toEqual([]);
  });

  // -------------------------------------------------------------------------------------------
  // 6. A COMPONENT FED BY TWO REPOSITORIES — the shape that silently emptied an inventory
  // -------------------------------------------------------------------------------------------
  describe("two repositories feed one component", () => {
    const OTHER_REPO = "acme/charts";

    it("a release from the SECOND repo does not delete the first repo's inventory", async () => {
      // THE BLOCKER, in the shape no path-scoped rule can resolve: BOTH mappings constrain no path,
      // so both passes probe exactly the same root candidates. Repo A has the `go.mod`, repo B has
      // the `Dockerfile`, and each pass therefore sees the OTHER's manifest as `not_found: "path"`
      // — the one branch that prunes. Attribution has to be on the row (`observed_repo`) or it is
      // not recoverable at all.
      const component = await componentWithMapping("two-repo-root", null, REPO);
      await addMapping(component, null, OTHER_REPO);
      await enable(component);

      const fromCode = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      expect(fromCode.verdict).toBe("ingested");
      const fromCharts = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: OTHER_REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ Dockerfile: DOCKERFILE }).read
      });
      expect(fromCharts.verdict).toBe("ingested");

      // BOTH repositories' declarations coexist. Before the fix the second pass's probe of
      // `go.mod` in `acme/charts` came back not-found and deleted the first pass's two rows.
      expect(await coordinatesOf(component)).toEqual([
        "Dockerfile:node@18",
        "go.mod:github.com/Masterminds/semver/v3@3",
        "go.mod:github.com/spf13/cobra@1"
      ]);

      // AND IT SURVIVES A THIRD PASS, i.e. the steady state of a component that releases from both
      // repositories — which is when this used to lose one side's inventory on EVERY release.
      const again = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      expect(again.manifests.every((m) => m.pruned === 0)).toBe(true);
      expect(await coordinatesOf(component)).toHaveLength(3);

      // The rows say WHERE each came from, which is what makes the prune attributable at all.
      const rows = await inventoryOf(component);
      expect(rows.find((r) => r.manifestPath === "Dockerfile")?.observedRepo).toBe(OTHER_REPO);
      expect(rows.filter((r) => r.manifestPath === "go.mod").map((r) => r.observedRepo)).toEqual([
        REPO,
        REPO
      ]);
    });

    it("a pass does not even PROBE the other repository's manifest paths", async () => {
      // The other half of the fix, one level earlier: the candidate set comes from the mappings
      // that name THIS repo. Deriving it from every mapping spent reads in the wrong repository and
      // manufactured the `not_found` that the prune then acted on.
      const component = await componentWithMapping("two-repo-subtree", "svc/api/**", REPO);
      await addMapping(component, "deploy/**", OTHER_REPO);
      await enable(component);

      const reader = recordingReader({ "svc/api/go.mod": GO_MOD });
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(reader.reads.length).toBeGreaterThan(0);
      expect(reader.reads.every((r) => r.path.startsWith("svc/api/"))).toBe(true);
      expect(reader.reads.some((r) => r.path.startsWith("deploy/"))).toBe(false);
    });

    it("a repository NONE of the component's mappings names is refused, unfetched", async () => {
      const component = await componentWithMapping("wrong-repo", null, REPO);
      await enable(component);
      const reader = recordingReader({ "go.mod": GO_MOD });
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: "someone/else",
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("not_addressable");
      expect(reader.reads).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. THE REPO ROOT IS NOT EVERY COMPONENT'S OWN
  // -------------------------------------------------------------------------------------------
  it("a component scoped to a subdirectory never claims the monorepo ROOT's manifests", async () => {
    // Two components in one repository, each scoped by `path_pattern` to its own subtree, and a
    // root `package.json` sitting between them. The root used to be an unconditional probe prefix,
    // so BOTH components ingested it as their own declarations — one file, two owners, and a prune
    // from either one acting on it.
    const alpha = await componentWithMapping("mono-alpha", "svc/alpha/**");
    const beta = await componentWithMapping("mono-beta", "svc/beta/**");
    await enable(alpha);
    await enable(beta);
    const files = {
      "package.json": JSON.stringify({ dependencies: { "@root/only": "^9.9.9" } }),
      "svc/alpha/go.mod": GO_MOD,
      "svc/beta/Dockerfile": DOCKERFILE
    };

    const alphaReader = recordingReader(files);
    await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: alpha,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: alphaReader.read
    });
    const betaReader = recordingReader(files);
    await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: beta,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: betaReader.read
    });

    expect(alphaReader.reads.some((r) => r.path === "package.json")).toBe(false);
    expect(betaReader.reads.some((r) => r.path === "package.json")).toBe(false);
    expect(await coordinatesOf(alpha)).toEqual([
      "svc/alpha/go.mod:github.com/Masterminds/semver/v3@3",
      "svc/alpha/go.mod:github.com/spf13/cobra@1"
    ]);
    expect(await coordinatesOf(beta)).toEqual(["svc/beta/Dockerfile:node@18"]);
  });

  // -------------------------------------------------------------------------------------------
  // 8. AN INCOMPLETE BODY IS NOT AN EMPTY MANIFEST
  // -------------------------------------------------------------------------------------------
  it("a PARTIAL body is refused upstream and prunes nothing — the case no parser can see", async () => {
    // `parseRequirementsTxt` cannot throw (its format has no required construct to miss), so a body
    // cut in half parses "successfully" as FEWER dependencies and the prune deletes the rest. The
    // structural guard for that is the byte count, not the text — `decodeBoundedBase64` refuses a
    // payload shorter than the size the provider declares, and it arrives here as a refusal, which
    // this module already treats as "the file is there and was not read".
    const component = await componentWithMapping("partial", null);
    await enable(component);
    const full = "requests==2.31.0\nurllib3==2.2.1\nboto3==1.34.0\n";
    await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: recordingReader({ "requirements.txt": full }).read
    });
    const before = await coordinatesOf(component);
    expect(before).toHaveLength(3);

    const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: recordingReader({
        "requirements.txt": {
          outcome: "refused",
          reason: "incomplete_body",
          detail: "github: 'requirements.txt' arrived as 17 bytes but the provider declares 46",
          path: "requirements.txt",
          requestedRef: RESOLVED_COMMIT,
          sizeBytes: 17
        }
      }).read
    });
    expect(outcome.skipped.find((s) => s.path === "requirements.txt")?.reason).toBe(
      "incomplete_body"
    );
    expect(await coordinatesOf(component)).toEqual(before);
  });

  // -------------------------------------------------------------------------------------------
  // 9. TWO PASSES ARE ORDERED — an older one may not land last
  // -------------------------------------------------------------------------------------------
  it("an OLDER pass that lands after a newer one writes NOTHING and prunes nothing", async () => {
    // Nothing orders two passes: both delivery hops are at-least-once and the queue is a competing
    // consumer, so a retry of an earlier accept can arrive after a later one. Applied out of order,
    // the older pass prunes each manifest down to what the OLDER commit declared.
    //
    // The interleave is REAL here, not simulated by editing a timestamp: the old pass's reader
    // blocks inside phase 2 until the newer pass has fully committed, then returns.
    const component = await componentWithMapping("ordering", null);
    await enable(component);
    const OLD_GO_MOD = GO_MOD.replace(/\tgithub.com\/spf13\/cobra v1.8.0\n/, "");
    expect(OLD_GO_MOD).not.toContain("cobra");

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldPass = ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: "0".repeat(40),
      readManifest: async (request) => {
        await gate;
        if (request.path !== "go.mod") {
          return {
            outcome: "not_found",
            missing: "path",
            path: request.path,
            requestedRef: request.ref
          };
        }
        return {
          outcome: "found",
          path: request.path,
          requestedRef: request.ref,
          commitSha: "0".repeat(40),
          content: OLD_GO_MOD,
          sizeBytes: Buffer.byteLength(OLD_GO_MOD, "utf8")
        };
      }
    });

    // The NEWER pass runs to completion while the older one is still reading.
    const newer = await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: recordingReader({ "go.mod": GO_MOD }).read
    });
    expect(newer.verdict).toBe("ingested");
    expect(await coordinatesOf(component)).toHaveLength(2);

    release();
    const older = await oldPass;
    expect(older.verdict).toBe("superseded");
    expect(older.reads).toBeGreaterThan(0);
    // The newer commit's declaration survives. Without the guard the older pass's prune deletes
    // `cobra` — a dependency the component currently declares — and the M21.4 poll stops seeing it.
    expect(await coordinatesOf(component)).toEqual([
      "go.mod:github.com/Masterminds/semver/v3@3",
      "go.mod:github.com/spf13/cobra@1"
    ]);
    // NOTHING was recorded for the superseded pass, not even a Decision: an alternating verdict is
    // the persist-on-change shape `insertDecisionIfChanged` exists to refuse.
    const decisionRows = await decisionsFor(component);
    expect(decisionRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // 10. THE DECISION IS A FUNCTION OF WHAT THE COMPONENT DECLARES — of nothing else
  // -------------------------------------------------------------------------------------------
  describe("Decision idempotency, field by field", () => {
    it("a component whose REF never resolves writes ONE Decision, not one per change", async () => {
      // The stated invariant was "the inputs carry NO ref, NO commit and NO timestamp", and it was
      // false in this branch: the skip's `detail` interpolated `input.ref`, and the provider's own
      // `detail` names the commit too. Every accepted change therefore appended a Decision saying
      // the same thing about the same component.
      const component = await componentWithMapping("bad-ref-decision", null);
      await enable(component);
      const badRef = (ref: string) => async (request: { path: string }) => ({
        outcome: "not_found" as const,
        missing: "ref" as const,
        path: request.path,
        requestedRef: ref,
        detail: `no commit ${ref.slice(0, 8)} in ${REPO}`
      });

      const first = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: "1".repeat(40),
        readManifest: badRef("1".repeat(40))
      });
      expect(first.decision?.created).toBe(true);
      expect(first.skipped.some((s) => s.reason === "ref_not_found")).toBe(true);

      const second = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: "2".repeat(40),
        readManifest: badRef("2".repeat(40))
      });
      expect(second.decision?.created).toBe(false);
      expect(await decisionsFor(component)).toHaveLength(1);
    });

    it("does not carry the gate's WITNESS, which is not a function of what the component declares", async () => {
      // The dedup key used to include the witness — ONE line the merge happened to be satisfied on,
      // taken as the first selector out of `matchPoliciesForTargets`' UNORDERED result. Two
      // identical runs could therefore disagree, and `insertDecisionIfChanged` compares against the
      // LATEST row, so an alternating value appends forever (ADR-0024's measured 1.44 GB/day).
      //
      // The order is now canonical (pinned behaviourally in `component-ingestion-gate.test.ts`,
      // where reversing the candidate list must produce the same witness) AND the Decision does not
      // carry it at all. This asserts the second half against the PERSISTED row: `contributions`
      // survives, so "which level decided this" is still answerable, and the witness does not.
      const component = await componentWithMapping("witness-free", null);
      await enable(component);
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      expect(outcome.decision?.created).toBe(true);

      const [row] = await inOrg((tx) =>
        tx
          .select({ reasonTree: decisions.reasonTree })
          .from(decisions)
          .where(and(eq(decisions.orgId, org.orgId), eq(decisions.id, outcome.decision!.id)))
      );
      const gate = (row?.reasonTree as { gate?: Record<string, unknown> } | null)?.gate;
      expect(gate?.contributions, "the explanation is still there").toBeDefined();
      expect(gate).not.toHaveProperty("witness");
      // The gate STILL produced one — this is not passing because the resolution stopped computing
      // it, which is the way an assertion about an absent key goes vacuous.
      expect(
        (
          await inOrg((tx) =>
            resolveComponentIngestionGate(tx, {
              orgId: org.orgId,
              componentObjectId: component,
              actorObjectId: SYSTEM_ACTOR_ID
            })
          )
        ).witness
      ).toBeDefined();
    });
  });

  it("the backfill actor is threaded, so a human's own enablement is what a backfill sees", async () => {
    // The event path resolves as the system sentinel (a member of no group); the backfill route
    // passes the requesting principal. Proven here at the ingestion's own seam rather than through
    // the route, which needs a live plugin host.
    const component = await componentWithMapping("actor", null);
    await enable(component);
    const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
      source: "backfill",
      componentObjectId: component,
      repo: REPO,
      ref: RESOLVED_COMMIT,
      readManifest: recordingReader({ "go.mod": GO_MOD }).read,
      actorObjectId
    });
    expect(outcome.verdict).toBe("ingested");
  });

  // -------------------------------------------------------------------------------------------
  // 11. THE PRODUCTION PATH, END TO END — a domain event puts ROWS IN THE TABLE
  // -------------------------------------------------------------------------------------------
  /**
   * EVERY TEST ABOVE CALLS `ingestComponentManifests` (or the job function) DIRECTLY, and the one
   * that claimed to be "the real path" reached the provider and had EVERY READ FAIL — the rows it
   * asserted came from a separate call with a hand-supplied reader. So the suite proved the repo
   * layer and proved nothing about the path that fills the table in production.
   *
   * Two distinct gaps close here, and they are distinct on purpose:
   *
   *  A. THE WIRING IS EXECUTED. Deleting `startInventoryIngestionLoop`'s `boss.createQueue` AND its
   *     `boss.work` left the ENTIRE suite green — only a substring match on `main.ts` still passed,
   *     and a substring match is not a test of behaviour. This drives the real loop over a real
   *     pg-boss, from the exact payload `events/outbox-relay.ts` puts on the domain-event queue.
   *
   *  B. A ROW REACHES THE TABLE THROUGH IT. The manifest read goes through
   *     `createGitProviderManifestReader` -> the repo's own git binding -> `host.gitFileRead`, so
   *     the only thing faked is the provider itself.
   *
   *   outbox -> domain-events -> inventoryIngestionRouter -> dependency-inventory-ingestion queue
   *          -> this loop's worker -> ingestComponentManifests -> component_dependencies
   */
  describe("the production path: a domain event lands rows (wiring + end to end)", () => {
    let boss: Awaited<ReturnType<typeof startPgBoss>> | undefined;
    let loop: InventoryIngestionLoopHandle | undefined;
    const fileReads: { instanceId: string; request: ReadFileAtRefRequest }[] = [];
    const WIRED_REPO = "acme/wired-inventory";
    /** The disabled component lives in its OWN repository so "was it fetched for?" is answerable
     *  from the recorded reads. Sharing a repo with the enabled one would make that assertion
     *  vacuous — every read would be attributable to either component. */
    const DISABLED_REPO = "acme/wired-disabled";
    const PACKAGE_JSON = JSON.stringify({
      name: "@acme/wired",
      dependencies: { "@acme/lib": "^2.3.4" }
    });

    /** A host that answers the file read and records WHICH INSTANCE was asked — the instance id is
     *  the proof the repo's own binding, not a guess, chose the credential. */
    function recordingHost(): PluginHost {
      const notWired = (): never => {
        throw new Error("this fixture only wires gitFileRead()");
      };
      const bodies: Record<string, string> = {
        "package.json": PACKAGE_JSON,
        Dockerfile: DOCKERFILE
      };
      return {
        async start() {},
        async stop() {},
        async stopInstances() {},
        executor: notWired,
        control: notWired,
        discovery: notWired,
        notification: notWired,
        federationTransport: notWired,
        dependencyIndex: notWired,
        gitFileRead(instanceId: string): GitFileReadPluginClient {
          return {
            readFileAtRef: async (request): Promise<ReadFileAtRefResult> => {
              fileReads.push({ instanceId, request });
              const body = bodies[request.path];
              if (body === undefined) {
                return {
                  outcome: "not_found",
                  missing: "path",
                  path: request.path,
                  requestedRef: request.ref
                };
              }
              return {
                outcome: "found",
                path: request.path,
                requestedRef: request.ref,
                commitSha: RESOLVED_COMMIT,
                content: body,
                sizeBytes: Buffer.byteLength(body, "utf8")
              };
            }
          };
        }
      };
    }

    beforeAll(async () => {
      // The ROUTER is registered with pg-boss, because `boss.work()` is a competing consumer: a
      // second worker on `domain-events` would steal half the events rather than add a listener.
      boss = await startPgBoss(server.deps.config.pgBossDatabaseUrl, [inventoryIngestionRouter()]);
      loop = await startInventoryIngestionLoop(boss, {
        db: server.deps.db,
        host: recordingHost(),
        config: server.deps.config
      });
    }, 60_000);

    afterAll(async () => {
      await loop?.stop();
      await boss?.stop({ graceful: false, timeout: 1000 }).catch(() => undefined);
    });

    /** The exact payload `events/outbox-relay.ts` sends for a change transition. */
    async function deliverAccept(changeObjectId: string): Promise<void> {
      await boss!.send(DOMAIN_EVENTS_QUEUE, {
        id: uuidv7(),
        orgId: org.orgId,
        type: "scp.change.transitioned",
        source: `/changes/${changeObjectId}`,
        subject: changeObjectId,
        data: { fromState: "validating", toState: "accepted", trigger: null }
      });
    }

    /** A component in `WIRED_REPO` with the git binding `manifest-reader.ts` resolves the read
     *  through. Without the binding SCP refuses to read the repo with another binding's credential,
     *  which is exactly how the delivered "real path" test ended up asserting nothing. */
    async function wiredComponent(label: string, repo = WIRED_REPO): Promise<string> {
      const component = await componentWithMapping(label, null, repo);
      await inOrg((tx) =>
        upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: component,
          pluginModule: "github",
          pluginInstanceId: `gh-${uuidv7()}`,
          config: {
            appId: "1",
            installationId: "2",
            owner: repo.split("/")[0],
            repo: repo.split("/")[1]
          }
        })
      );
      return component;
    }

    it("an ENABLED component's manifests reach component_dependencies; a DISABLED one's do not", async () => {
      const enabled = await wiredComponent("wired-enabled");
      const disabled = await wiredComponent("wired-disabled", DISABLED_REPO);
      await enable(enabled);
      // `disabled` is deliberately NOT enabled — the negative control that the enabled one provides
      // the positive half of, in the SAME delivery through the SAME loop.

      const changeId = await acceptedChange(enabled, {
        repo: WIRED_REPO,
        ref: "refs/heads/main",
        commit: RESOLVED_COMMIT
      });
      const disabledChangeId = await acceptedChange(disabled, {
        repo: DISABLED_REPO,
        ref: "refs/heads/main",
        commit: RESOLVED_COMMIT
      });

      await deliverAccept(changeId);
      await deliverAccept(disabledChangeId);

      const rows = await waitUntil(
        async () => {
          const current = await inventoryOf(enabled);
          return current.length >= 2 ? current : undefined;
        },
        {
          describe:
            "the inventory-ingestion loop to write this component's declarations from a domain event",
          timeoutMs: 30_000,
          intervalMs: 200
        }
      );

      // THE ROWS THEMSELVES, through the production caller — not through a direct call with a
      // hand-supplied reader.
      expect(await coordinatesOf(enabled)).toEqual([
        "Dockerfile:node@18",
        "package.json:@acme/lib@2"
      ]);
      // The RESOLVED commit, the repository, and the declared text verbatim.
      expect(new Set(rows.map((r) => r.observedRef))).toEqual(new Set([RESOLVED_COMMIT]));
      expect(new Set(rows.map((r) => r.observedRepo))).toEqual(new Set([WIRED_REPO]));
      expect(rows.find((r) => r.manifestPath === "package.json")?.declaredVersion).toBe("^2.3.4");

      // And it went through the plugin-host file-read client, at the released commit, on the
      // instance the repo's OWN binding names.
      const read = fileReads.find(
        (r) => r.request.repo === WIRED_REPO && r.request.path === "package.json"
      );
      expect(read, "the manifest was read through host.gitFileRead").toBeDefined();
      expect(read?.request.ref).toBe(RESOLVED_COMMIT);

      // THE NEGATIVE CONTROL, and it is only meaningful beside the positive one above: the same
      // loop, the same repo, the same binding, one accepted change each — and the unsubscribed
      // component has no rows and was never fetched for.
      expect(await inventoryOf(disabled)).toEqual([]);
      expect(fileReads.some((r) => r.request.repo === DISABLED_REPO)).toBe(false);
    }, 60_000);

    /**
     * THE SAME WIRING QUESTION, ASKED OF THE STAMP (M21.7).
     *
     * The stamp's whole purpose is to explain an EMPTY inventory, so a test that asserts rows
     * cannot notice the stamp is missing — and "built, and nothing calls it" is this milestone's
     * dominant defect, six times over. This therefore drives the production path end to end
     * (the outbox payload -> router -> queue -> worker -> `ingestComponentManifests`) and asserts
     * the STAMP: for a component that ingests, and for one the gate refuses.
     *
     * Deleting the `recordIngestionStamp` call from `inventory-ingestion.ts` makes this test RED at
     * the `waitUntil`. No test that calls the repo function directly can do that.
     */
    it("the loop STAMPS what it ingested — and stamps a refused component too", async () => {
      const stamped = await wiredComponent("wired-stamped");
      const refused = await wiredComponent("wired-refused", DISABLED_REPO);
      await enable(stamped);
      // `refused` is deliberately NOT enabled: its empty inventory is precisely the state the stamp
      // exists to explain, so it is asserted here on the real path rather than in a direct call.

      await deliverAccept(
        await acceptedChange(stamped, {
          repo: WIRED_REPO,
          ref: "refs/heads/main",
          commit: RESOLVED_COMMIT
        })
      );
      await deliverAccept(
        await acceptedChange(refused, {
          repo: DISABLED_REPO,
          ref: "refs/heads/main",
          commit: RESOLVED_COMMIT
        })
      );

      const stamp = await waitUntil(async () => (await stampOf(stamped)) ?? undefined, {
        describe: "the ingestion loop to write this component's ingestion stamp",
        timeoutMs: 30_000,
        intervalMs: 200
      });

      // WHICH PRODUCER — the loop, not the backfill. Every direct-call test in this file passes
      // `"backfill"`, so this value can only have come from `inventory-ingestion-loop.ts`.
      expect(stamp.source).toBe("loop");
      expect(stamp.outcome).toBe("ok");
      // THE OK PATH PROVES ITSELF: two declarations were written and the stamp says two. A stamp
      // asserted only for existence would be satisfied by any write at all.
      expect(stamp.rowsWritten).toBe(2);
      expect(stamp.manifests.map((m) => [m.path, m.outcome])).toEqual([
        ["Dockerfile", "ok"],
        ["package.json", "ok"]
      ]);
      // It describes THIS PASS: the same read time the rows carry, not the moment it was written.
      const rows = await inventoryOf(stamped);
      expect(rows.length).toBe(2);
      expect(new Set(rows.map((r) => r.observedAt))).toEqual(new Set([stamp.lastAttemptAt]));

      // THE REFUSED COMPONENT — its empty list is now EXPLAINED rather than silent.
      const refusedStamp = await waitUntil(async () => (await stampOf(refused)) ?? undefined, {
        describe: "the ingestion loop to stamp the component whose enablement gate is closed",
        timeoutMs: 30_000,
        intervalMs: 200
      });
      expect(refusedStamp.outcome).toBe("not_enabled");
      expect(refusedStamp.source).toBe("loop");
      expect(refusedStamp.rowsWritten).toBe(0);
      expect(refusedStamp.manifests).toEqual([]);
      expect(await inventoryOf(refused)).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------------------------
  // 12. THE STAMP — WHICH OF THREE MEANINGS THIS COMPONENT'S EMPTY INVENTORY HAS (M21.7, 0065)
  // -------------------------------------------------------------------------------------------
  /**
   * `component_dependencies.observed_at` is per ROW, so a component with no rows carries no
   * timestamp anywhere and three truths look identical: never ingested; ingested and genuinely
   * declares nothing; ingestion ran and every manifest was unreadable. Each test below pins ONE of
   * those readings against real Postgres, through the real ingestion.
   */
  describe("the ingestion stamp", () => {
    /** A component that is enabled and mapped at the repo root — the ordinary subject. */
    async function enabledComponent(label: string): Promise<string> {
      const component = await componentWithMapping(label, null);
      await enable(component);
      return component;
    }

    it("READ AND EMPTY is stamped `ok` with rowsWritten 0 — the reading that could not be recorded", async () => {
      const component = await enabledComponent("stamp-empty");
      // Every probe answers "not there", which is positive evidence: this component genuinely
      // declares nothing. Before the stamp, this and "never looked" were the same empty table.
      const reader = recordingReader({});

      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("ingested");
      expect(reader.reads.length).toBeGreaterThan(0);

      const stamp = await stampOf(component);
      expect(stamp?.outcome).toBe("ok");
      expect(stamp?.rowsWritten).toBe(0);
      expect(stamp?.manifests).toEqual([]);
      expect(stamp?.source).toBe("backfill");
      expect(await inventoryOf(component)).toEqual([]);
    });

    it("MIXED is stamped `partial` and NAMES the file that could not be read", async () => {
      const component = await enabledComponent("stamp-partial");
      const reader = recordingReader({
        "go.mod": GO_MOD,
        // A 404 HTML body: the parser throws, the manifest is skipped, and its rows are left
        // alone. This is the mixed case the per-path array exists for.
        "package.json": "<!DOCTYPE html>\n<html><body>404 Not Found</body></html>\n"
      });

      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });

      const stamp = await stampOf(component);
      expect(stamp?.outcome).toBe("partial");
      // The `go.mod` declarations landed and are counted; the `package.json` did not.
      expect(stamp?.rowsWritten).toBe(2);
      expect(stamp?.manifests.map((m) => [m.path, m.outcome])).toEqual([
        ["go.mod", "ok"],
        ["package.json", "unreadable"]
      ]);
      // WHICH file and WHY — the empty-state copy has to be able to name it.
      expect(stamp?.manifests.find((m) => m.path === "package.json")?.detail).toContain(
        "unreadable is not empty"
      );
    });

    it("NOTHING READ is stamped `unreadable`, and the inventory it could not re-read still stands", async () => {
      const component = await enabledComponent("stamp-unreadable");
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      expect((await inventoryOf(component)).length).toBe(2);

      // The provider is now failing every call. "Unreadable is not empty": the rows survive.
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: async () => {
          throw new Error("provider is down");
        }
      });

      const stamp = await stampOf(component);
      expect(stamp?.outcome).toBe("unreadable");
      // `rowsWritten` describes THIS PASS, not the component: the component still has two rows and
      // this pass wrote none of them. Conflating the two would let a failed pass report the
      // inventory as freshly confirmed.
      expect(stamp?.rowsWritten).toBe(0);
      expect((await inventoryOf(component)).length).toBe(2);
      expect(stamp?.manifests.some((m) => m.path === "go.mod" && m.outcome === "unreadable")).toBe(
        true
      );
    });

    it("a NOT-ENABLED component is stamped `not_enabled`, with nothing fetched", async () => {
      // The gate is closed, so ADR-0032 §6 says nothing may be read — and the stamp must still
      // exist, because this is the most common reason an inventory is empty on a real estate and
      // it is the one a reader most needs told apart from "we could not read it".
      const component = await componentWithMapping("stamp-not-enabled", null);
      const reader = recordingReader({ "go.mod": GO_MOD });

      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("not_enabled");
      expect(reader.reads).toEqual([]);

      const stamp = await stampOf(component);
      expect(stamp?.outcome).toBe("not_enabled");
      expect(stamp?.rowsWritten).toBe(0);
      expect(stamp?.detail).toContain("not enabled");
    });

    it("an UNADDRESSABLE component is stamped too — the detail carries what no per-path entry could", async () => {
      const component = await enabledComponent("stamp-unaddressable");
      const reader = recordingReader({ "go.mod": GO_MOD });

      // Enabled, but this pass is pointed at a repository none of the component's mappings names.
      const outcome = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: "acme/somewhere-else",
        ref: RESOLVED_COMMIT,
        readManifest: reader.read
      });
      expect(outcome.verdict).toBe("not_addressable");
      expect(reader.reads).toEqual([]);

      const stamp = await stampOf(component);
      // `unreadable`, not `ok`: this pass reached no manifest, so it is NOT evidence that the
      // component declares nothing. There is no PATH to hang the explanation on, which is exactly
      // why the stamp carries a `detail` column beside the per-path array.
      expect(stamp?.outcome).toBe("unreadable");
      expect(stamp?.manifests).toEqual([]);
      expect(stamp?.detail).toContain("acme/somewhere-else");
    });

    it("a refusal for a repository this component is NOT MAPPED TO leaves the good stamp standing", async () => {
      // THE DEFECT THIS PINS: the refusal above and the good pass below are about DIFFERENT FACTS —
      // "this repository is not this component's" versus "this component's manifests cannot be
      // read" — and the stamp used to write the first over the second. An accepted change reaching
      // a component from an unmapped repo is ordinary (`source_mappings` is a glob-matched
      // correlation), so a healthy component's receipt was destroyed by the next unrelated release.
      const component = await enabledComponent("stamp-unmapped-over-good");
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      const good = await stampOf(component);
      expect(good?.outcome).toBe("ok");
      expect(good?.rowsWritten).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const refusal = await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: "acme/somewhere-else",
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      expect(refusal.verdict).toBe("not_addressable");

      const after = await stampOf(component);
      // THE WHOLE ROW IS UNTOUCHED — verdict, evidence, row count and freshness. `last_attempt_at`
      // is deliberately in that list: it is what a reader means by "when were these manifests last
      // looked at", and this pass looked at none of them.
      expect(after).toEqual(good);
      expect(after?.outcome).toBe("ok");
      expect(after?.rowsWritten).toBe(2);
      expect(after?.manifests.map((m) => [m.repo, m.path, m.outcome])).toEqual([
        [REPO, "go.mod", "ok"]
      ]);
      expect((await inventoryOf(component)).length).toBe(2);
      // The negative control for "then just do not stamp on that path at all" is the test above:
      // with NO stamp yet, the same refusal MUST create one, because the absence of a row means
      // "never attempted" and this component has been attempted.
    });

    it("a good pass over one repository does NOT erase the other repository's unreadable verdict", async () => {
      // THE DEFECT THIS PINS: the stamp is per COMPONENT but ingestion is per (COMPONENT,
      // REPOSITORY). A widgets pass whose `go.mod` read failed wrote `unreadable`; a charts release
      // minutes later wrote `ok` over it — and "manifests unreadable" was rendered as "genuinely
      // declares nothing", which is the exact lie the stamp was built to prevent.
      const CHARTS = "acme/charts";
      const component = await componentWithMapping("stamp-two-repo-erase", null, REPO);
      await addMapping(component, null, CHARTS);
      await enable(component);

      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: async () => {
          throw new Error("provider is down for acme/widgets");
        }
      });
      expect((await stampOf(component))?.outcome).toBe("unreadable");

      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: CHARTS,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ Dockerfile: DOCKERFILE }).read
      });

      const mixed = await stampOf(component);
      // PARTIAL — the honest reading of one healthy source and one broken one, and a reading that
      // was unreachable while the row was replaced wholesale.
      expect(mixed?.outcome).toBe("partial");
      // Each side is attributed, so an operator can see WHICH repository is broken.
      expect(mixed?.manifests.find((m) => m.repo === CHARTS)).toMatchObject({
        path: "Dockerfile",
        outcome: "ok",
        rows: 1
      });
      expect(mixed?.manifests.some((m) => m.repo === REPO && m.outcome === "unreadable")).toBe(
        true
      );
      // The row count is the COMPONENT's, summed across repositories — not the last pass's.
      expect(mixed?.rowsWritten).toBe(1);
      expect((await inventoryOf(component)).length).toBe(1);

      // AND IT HEALS: widgets comes back, its slice is replaced by the pass that read it, and the
      // component is `ok` again. A merge that only ever accumulated would leave `partial` forever.
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      const healed = await stampOf(component);
      expect(healed?.outcome).toBe("ok");
      expect(healed?.rowsWritten).toBe(3);
      expect(healed?.manifests.map((m) => [m.repo, m.path])).toEqual([
        [CHARTS, "Dockerfile"],
        [REPO, "go.mod"]
      ]);
    });

    it("NEVER ATTEMPTED is the ABSENCE of a row, and one pass is what creates it", async () => {
      const component = await enabledComponent("stamp-absent");
      // The distinction the whole table rests on: no row means nothing has ever looked. There is
      // no `outcome` value for it, because only a pass that ran could write one.
      expect(await stampOf(component)).toBeNull();

      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({}).read
      });
      expect(await stampOf(component)).not.toBeNull();
    });

    it("re-ingesting ADVANCES lastAttemptAt and PRESERVES createdAt", async () => {
      const component = await enabledComponent("stamp-restated");
      const ingest = () =>
        ingestComponentManifests(server.deps.db, org.orgId, {
          source: "backfill",
          componentObjectId: component,
          repo: REPO,
          ref: RESOLVED_COMMIT,
          readManifest: recordingReader({ "go.mod": GO_MOD }).read
        });

      await ingest();
      const first = await stampOf(component);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ingest();
      const second = await stampOf(component);

      // `created_at` is out of the upsert's SET list — "first attempted" must not be reset by a
      // re-observation, the same property `upsertComponentDependency` holds for a declaration.
      expect(second?.createdAt).toBe(first?.createdAt);
      expect(Date.parse(second!.lastAttemptAt)).toBeGreaterThan(Date.parse(first!.lastAttemptAt));
    });

    it("an OLDER pass over the SAME repository cannot overwrite a NEWER slice", async () => {
      const component = await enabledComponent("stamp-ordering");
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      const winner = await stampOf(component);
      expect(winner?.outcome).toBe("ok");

      // A retry of an EARLIER pass over the SAME repository, delivered late — both hops are
      // at-least-once and the queue is a competing consumer. Landing it would put an `unreadable`
      // receipt over rows that are fine.
      await inOrg((tx) =>
        recordIngestionStamp(tx, org.orgId, {
          componentObjectId: component,
          lastAttemptAt: new Date(Date.parse(winner!.lastAttemptAt) - 60_000),
          source: "loop",
          repo: REPO,
          outcome: "unreadable",
          detail: "an older pass, delivered late",
          manifests: [
            { path: "go.mod", outcome: "unreadable", rows: 0, detail: "provider was down" }
          ]
        })
      );

      const after = await stampOf(component);
      expect(after?.outcome).toBe("ok");
      expect(after?.rowsWritten).toBe(2);
      expect(after?.lastAttemptAt).toBe(winner!.lastAttemptAt);
      expect(after?.source).toBe("backfill");
      expect(after?.manifests).toEqual(winner?.manifests);
    });

    it("an older pass over a DIFFERENT repository still contributes its slice", async () => {
      // The other half of per-repository ordering, and the reason the guard is not a row-level one.
      // Ordering the whole row would DROP this pass — it is older than the widgets pass — and the
      // charts verdict would be lost entirely, which is the same silence the table replaces.
      const CHARTS = "acme/charts";
      const component = await componentWithMapping("stamp-ordering-cross-repo", null, REPO);
      await addMapping(component, null, CHARTS);
      await enable(component);
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      const widgets = await stampOf(component);

      await inOrg((tx) =>
        recordIngestionStamp(tx, org.orgId, {
          componentObjectId: component,
          lastAttemptAt: new Date(Date.parse(widgets!.lastAttemptAt) - 60_000),
          source: "loop",
          repo: CHARTS,
          outcome: "unreadable",
          manifests: [
            { path: "Dockerfile", outcome: "unreadable", rows: 0, detail: "provider was down" }
          ]
        })
      );

      const after = await stampOf(component);
      expect(after?.outcome).toBe("partial");
      expect(after?.manifests.map((m) => [m.repo, m.path, m.outcome])).toEqual([
        [CHARTS, "Dockerfile", "unreadable"],
        [REPO, "go.mod", "ok"]
      ]);
      // The row-level fields still describe the LATEST attempt on the component, which this is not.
      expect(after?.lastAttemptAt).toBe(widgets!.lastAttemptAt);
      expect(after?.source).toBe("backfill");
    });

    it("CONCURRENT passes over different repositories do not lose each other's slices", async () => {
      // The merge is a READ-MODIFY-WRITE, so it is only correct while it is serialised: two passes
      // that both read the pre-state would each write a row missing the other's slice, and the
      // per-repository merge would be defeated at the write by the very race it exists to survive.
      // `recordIngestionStamp` therefore takes the same transaction-scoped advisory lock
      // `ingestComponentManifests`' phase 3 already holds — deleting that `pg_advisory_xact_lock`
      // line reddens this test (measured).
      //
      // Eight repositories rather than two: a lost update needs an interleaving, and one pair can
      // serialise by luck where eight cannot.
      const component = await componentWithMapping("stamp-concurrent", null, "acme/repo-0");
      const repos = Array.from({ length: 8 }, (_, i) => `acme/repo-${i}`);
      for (const repo of repos.slice(1)) await addMapping(component, null, repo);
      await enable(component);

      await Promise.all(
        repos.map((repo, i) =>
          ingestComponentManifests(server.deps.db, org.orgId, {
            source: "backfill",
            componentObjectId: component,
            repo,
            ref: RESOLVED_COMMIT,
            // A DISTINCT declaration per repository. Identical ones would collapse onto one
            // `component_dependencies` row — the row's key is (component, line, manifest path) and
            // does not include the repo — and the test would then be measuring that collapse
            // rather than whether a slice was lost.
            readManifest: recordingReader({ Dockerfile: `FROM svc-${i}:1.0.0\n` }).read
          })
        )
      );

      const stamp = await stampOf(component);
      // EVERY repository is represented, and the row count is their sum — the two things a lost
      // update destroys.
      expect(new Set(stamp?.manifests.map((m) => m.repo))).toEqual(new Set(repos));
      expect(stamp?.rowsWritten).toBe(repos.length);
      expect((await inventoryOf(component)).length).toBe(repos.length);
    });

    it("reads many components' stamps in ONE round trip, and a component with none is simply absent", async () => {
      const withStamp = await enabledComponent("stamp-batch-a");
      const alsoStamped = await enabledComponent("stamp-batch-b");
      const never = await enabledComponent("stamp-batch-never");
      for (const component of [withStamp, alsoStamped]) {
        await ingestComponentManifests(server.deps.db, org.orgId, {
          source: "backfill",
          componentObjectId: component,
          repo: REPO,
          ref: RESOLVED_COMMIT,
          readManifest: recordingReader({ "go.mod": GO_MOD }).read
        });
      }

      const stamps = await inOrg((tx) =>
        listIngestionStampsByComponents(tx, org.orgId, [withStamp, alsoStamped, never])
      );
      expect(new Set(stamps.map((s) => s.componentObjectId))).toEqual(
        new Set([withStamp, alsoStamped])
      );
      // Absent rather than a null placeholder — a missing key IS "never attempted", the same
      // reading the single lookup's `null` carries.
      expect(stamps.some((s) => s.componentObjectId === never)).toBe(false);
      expect(await inOrg((tx) => listIngestionStampsByComponents(tx, org.orgId, []))).toEqual([]);
    });

    it("scp_app holds NO DELETE grant — deleting a stamp would FORGE 'never attempted'", async () => {
      // The absence of a row is load-bearing (it means "nothing has ever looked at this
      // component"), so the one operation that can manufacture that absence is not granted. Same
      // shape as 0061's `dependency_lines` and 0064's authorships.
      const rows = await server.deps.db.execute<{ privilege_type: string }>(
        sql`SELECT privilege_type
            FROM information_schema.role_table_grants
            WHERE grantee = 'scp_app'
              AND table_name = 'dependency_ingestion_stamps'`
      );
      expect(rows.rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    });

    it("RLS isolates a stamp by org, in BOTH directions", async () => {
      const component = await enabledComponent("stamp-rls");
      await ingestComponentManifests(server.deps.db, org.orgId, {
        source: "backfill",
        componentObjectId: component,
        repo: REPO,
        ref: RESOLVED_COMMIT,
        readManifest: recordingReader({ "go.mod": GO_MOD }).read
      });
      const stranger = uuidv7();

      // USING: another org's session cannot SEE the row, even asking for it by this org's id
      // explicitly — so this is the policy refusing, not the query's own predicate.
      const visible = await withTenantTx(server.deps.db, stranger, (tx) =>
        tx
          .select()
          .from(dependencyIngestionStamps)
          .where(eq(dependencyIngestionStamps.orgId, org.orgId))
      );
      expect(visible).toEqual([]);

      // WITH CHECK: nor can a stranger WRITE a row stamped with this org's id. Without that half a
      // policy is a read filter only, and a stranger could plant a receipt on somebody else's
      // component.
      //
      // TWO THINGS THIS TEST HAD TO LEARN BY MUTATION rather than by reading the policy, both of
      // which had left the earlier version asserting almost nothing:
      //
      //  1. THE SUBJECT MUST HAVE NO ROW YET. Aimed at a component that already had one, the
      //     refusal came from the upsert's ON CONFLICT DO UPDATE meeting a row the USING clause
      //     hides — Postgres refuses that with 42501 too, whatever WITH CHECK says.
      //  2. THE STATEMENT MUST BE A PLAIN INSERT. `recordIngestionStamp` is an upsert, and for an
      //     INSERT ... ON CONFLICT Postgres also checks the policy's USING qual against the
      //     PROPOSED row — so a cross-org upsert is refused ("new row violates row-level security
      //     policy", `ExecWithCheckOptions`) even with `WITH CHECK (true)` installed. MEASURED: no
      //     route through the write door can distinguish the WITH CHECK half at all.
      //
      // Hence both writes below. The raw INSERT isolates WITH CHECK — it is the only statement
      // whose refusal that clause alone produces, and `WITH CHECK (true)` lets it through. The
      // write door then proves the real writer is refused as well, which `USING (true)` breaks.
      const control = await enabledComponent("stamp-rls-control");
      await inOrg((tx) =>
        recordIngestionStamp(tx, org.orgId, {
          componentObjectId: control,
          lastAttemptAt: new Date(),
          source: "loop",
          repo: REPO,
          outcome: "ok",
          manifests: []
        })
      );
      // THE POSITIVE CONTROL, and without it a refusal proves only that these writes always fail:
      // the identical one from the OWNING org's session lands.
      expect(
        await stampOf(control),
        "the owning org must be able to write this row"
      ).not.toBeNull();

      // The SQLSTATE is asserted rather than "it threw": these inserts carry NOT NULL columns, a
      // foreign key and a primary key, so a bare `.rejects.toThrow()` would stay green if the
      // policy were dropped and something unrelated failed instead. `42501` is the policy refusing.
      const planted = await enabledComponent("stamp-rls-planted");
      const withCheckRefusal = await withTenantTx(server.deps.db, stranger, (tx) =>
        tx.insert(dependencyIngestionStamps).values({
          orgId: org.orgId,
          componentObjectId: planted,
          lastAttemptAt: new Date(),
          source: "loop",
          outcome: "ok",
          rowsWritten: 0,
          manifests: []
        })
      ).then(
        () => null,
        (err: unknown) => unwrapDriverError(err)
      );
      expect(withCheckRefusal, "WITH CHECK must refuse a cross-org INSERT").not.toBeNull();
      expect((withCheckRefusal as { code?: string }).code).toBe("42501");
      expect(await stampOf(planted)).toBeNull();

      const unstamped = await enabledComponent("stamp-rls-fresh");
      expect(
        await stampOf(unstamped),
        "the subject must have NO row, or ON CONFLICT is what fails"
      ).toBeNull();
      const refusal = await withTenantTx(server.deps.db, stranger, (tx) =>
        recordIngestionStamp(tx, org.orgId, {
          componentObjectId: unstamped,
          lastAttemptAt: new Date(),
          source: "loop",
          repo: REPO,
          outcome: "ok",
          manifests: []
        })
      ).then(
        () => null,
        (err: unknown) => unwrapDriverError(err)
      );
      expect(refusal, "the row check must refuse the write door too").not.toBeNull();
      expect((refusal as { code?: string }).code).toBe("42501");
      // AND NOTHING LANDED. The SQLSTATE says the statement was refused; this says the table agrees
      // — read back as the OWNING org, which is the only session that could see a planted row.
      expect(await stampOf(unstamped)).toBeNull();
    });
  });
});

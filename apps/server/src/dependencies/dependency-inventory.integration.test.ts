import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { relationships, users } from "../db/schema.js";
import { slugify } from "../graph/urn.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  RawScpAppClient,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  declareDependencyLineProducer,
  getDependencyLineByKey,
  listComponentDependencies,
  listComponentsDeclaringLine,
  listDependencyLinesByIds,
  pruneComponentDependencies,
  recordDependencyLineHead,
  upsertComponentDependency,
  upsertDependencyLine
} from "./dependency-inventory-repo.js";

/**
 * M21.2 — the dependency inventory substrate (ADR-0032 §3/§4/§5/§7, migration 0060).
 *
 * Five properties are load-bearing and each is pinned here rather than left to the migration's
 * comments, because a comment naming a hazard is a signal to sweep, not evidence it was handled
 * (CLAUDE.md, "census by property"):
 *
 *   1. The tables ROUND-TRIP, and both hot queries are the single-hop lookups ADR-0032 §4 promises.
 *   2. RLS ISOLATES TWO ORGS. A dependency inventory is a map of an org's entire software estate;
 *      this is the one that leaks something if it is wrong, so it is probed with a RAW `scp_app`
 *      connection (no application code, no `withTenantTx`) exactly as `graph/rls.integration.test.ts`
 *      does — the database's own defenses, independent of whether the repo layer remembers to filter.
 *   3. `@acme/lib` and `acme-lib` are DIFFERENT LINES. This is the URN-collision case that is the
 *      whole reason the inventory is tabular, and the test asserts the collision is REAL by running
 *      the coordinates through `slugify` itself rather than asserting against a remembered claim.
 *   4. NO `depends_on` EDGE, and no relationship at all, is minted by any of it (ADR-0032 §5).
 *   5. THE THREE INGRESSES DO NOT CLOBBER EACH OTHER. Manifest ingestion, operator declaration and
 *      registry observation write disjoint column sets of one `dependency_lines` row, and the ONLY
 *      thing enforcing that is the literal SET list of each write (ADR-0032 §7 is why the verbs are
 *      separate at all). No constraint, no trigger and no type catches a widened SET list.
 *
 *      Asserting that field-by-field is necessary but NOT sufficient, and the earlier draft of this
 *      header claimed the field-by-field assertions settled it. They do not: a clobber is only
 *      observable if no LATER write restores the field, so each pair of ingresses has to be
 *      exercised in the order that puts the suspect verb LAST. Both tests here that combined
 *      declaration with observation declared first, which made a `latest_*` clobber inside
 *      `declareDependencyLineProducer` invisible to all of them. The three pairs are now covered in
 *      the orders that can see a clobber: ingestion last ("manifest re-ingestion cannot clobber..."),
 *      observation last ("records an observed line head..."), declaration last ("declaring a
 *      producer AFTER the head was observed..."), each with a negative control proving the suspect
 *      write did land on the row.
 *
 * Every absence assertion below carries a NEGATIVE CONTROL in the same test — a test proving nothing
 * happened is vacuous unless it also proves the thing that SHOULD happen did.
 */
describe("dependency inventory substrate (ADR-0032, migration 0060)", () => {
  let server: ListeningTestServer;
  let orgA: TestOrg;
  let orgB: TestOrg;
  let clientA: ScpClient;
  let clientB: ScpClient;
  /** Org A's bootstrap admin's graph `user` object — the PRINCIPAL a producer declaration is
   *  attributed to (charter principle 6: "who asserted this line is internal?"). */
  let adminObjectIdA: string;

  beforeAll(async () => {
    server = await listenTestServer();
    orgA = await createTestOrg(server, "dep-inventory-a");
    orgB = await createTestOrg(server, "dep-inventory-b");
    clientA = new ScpClient({ baseUrl: server.baseUrl, token: orgA.adminToken });
    clientB = new ScpClient({ baseUrl: server.baseUrl, token: orgB.adminToken });
    const [adminRow] = await server.deps.db
      .select({ objectId: users.objectId })
      .from(users)
      .where(eq(users.username, orgA.adminUsername));
    if (!adminRow?.objectId) throw new Error("expected the bootstrap admin to have a user object");
    adminObjectIdA = adminRow.objectId;
  });

  afterAll(async () => {
    await server?.close();
  });

  const componentIn = async (client: ScpClient, name: string): Promise<string> =>
    (await createTestComponent(client, { name: `${name}-${uuidv7()}` })).id;

  const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, orgA.orgId, fn);
  const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, orgB.orgId, fn);

  // -----------------------------------------------------------------------------------------
  // (a) Round-trip
  // -----------------------------------------------------------------------------------------

  it("round-trips a line and a component's declaration of it, in both directions", async () => {
    const componentId = await componentIn(clientA, "api");

    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/lib",
        major: "v1"
      })
    );
    expect(line.coordinate).toBe("github.com/acme/lib");
    expect(line.major).toBe("v1");
    // Third-party until DECLARED otherwise (ADR-0032 §7). Absent never means internal.
    expect(line.producedByObjectId).toBeNull();
    expect(line.producedByDeclaredAt).toBeNull();
    // `tag_pattern` is `oci`-only and is normalised to NULL for the language ecosystems.
    expect(line.tagPattern).toBeNull();

    const declaration = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: line.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.4.0",
        resolvedVersion: "1.4.0",
        observedRef: "refs/heads/main"
      })
    );
    expect(declaration.declaredVersion).toBe("v1.4.0");
    expect(declaration.resolvedVersion).toBe("1.4.0");
    expect(declaration.observedRef).toBe("refs/heads/main");

    // FORWARD — "what does component C declare?"
    const forward = await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId));
    expect(forward).toHaveLength(1);
    expect(forward[0]?.lineId).toBe(line.id);

    // REVERSE — "which components declare line L?" (the dependency-subscription fan-out list).
    const reverse = await inA((tx) => listComponentsDeclaringLine(tx, orgA.orgId, line.id));
    expect(reverse.map((r) => r.componentObjectId)).toEqual([componentId]);

    const hydrated = await inA((tx) => listDependencyLinesByIds(tx, orgA.orgId, [line.id]));
    expect(hydrated.map((l) => l.id)).toEqual([line.id]);
  });

  it("upsert is idempotent on the natural key and does not mint a second line", async () => {
    const key = { ecosystem: "npm", coordinate: "@acme/idem", major: "1" } as const;
    const first = await inA((tx) => upsertDependencyLine(tx, orgA.orgId, key));
    const second = await inA((tx) => upsertDependencyLine(tx, orgA.orgId, key));
    expect(second.id).toBe(first.id);

    const fetched = await inA((tx) => getDependencyLineByKey(tx, orgA.orgId, key));
    expect(fetched?.id).toBe(first.id);
  });

  it("re-observing a manifest updates the declaration in place, and a prune scoped to ONE manifest leaves the others alone", async () => {
    const componentId = await componentIn(clientA, "prune");
    const go = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/kept",
        major: "v1"
      })
    );
    const npmLine = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/dropped",
        major: "2"
      })
    );
    const image = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "docker.io/library/alpine",
        major: "3",
        tagPattern: "3.*"
      })
    );
    // `tag_pattern` is `oci`-ONLY — normalised to NULL at the single write choke point so a language
    // ecosystem can never carry a field a later parser would mistake for configuration.
    expect(image.tagPattern).toBe("3.*");
    expect(npmLine.tagPattern).toBeNull();

    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: go.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.0.0"
      })
    );
    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: npmLine.id,
        manifestPath: "package.json",
        declaredVersion: "^2.0.0"
      })
    );
    // The image case: a `FROM alpine:3.18` in the component's own build input, carrying the DIGEST,
    // because a mutable tag is not an identity (ADR-0032 §7).
    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: image.id,
        manifestPath: "Dockerfile",
        declaredVersion: "3.18",
        resolvedVersion: "3.18.4",
        resolvedDigest: "sha256:" + "a".repeat(64),
        observedRef: "refs/heads/main"
      })
    );

    // Re-observing the same (component, line, manifest) UPDATES; it does not insert a second row.
    const updated = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: go.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.5.0"
      })
    );
    expect(updated.declaredVersion).toBe("v1.5.0");
    expect(await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId))).toHaveLength(
      3
    );

    // A `package.json` re-read that no longer declares `@acme/dropped` prunes exactly that row.
    const removed = await inA((tx) =>
      pruneComponentDependencies(tx, orgA.orgId, {
        componentObjectId: componentId,
        manifestPath: "package.json",
        keepLineIds: []
      })
    );
    expect(removed).toBe(1);

    // NEGATIVE CONTROL for the prune's scoping: `go.mod` and `Dockerfile` are untouched. Without the
    // manifest-path predicate this would be 0 and the whole component's inventory would be gone.
    const survivors = await inA((tx) => listComponentDependencies(tx, orgA.orgId, componentId));
    expect(survivors.map((s) => s.manifestPath).sort()).toEqual(["Dockerfile", "go.mod"]);
    const dockerfile = survivors.find((s) => s.manifestPath === "Dockerfile");
    expect(dockerfile?.resolvedDigest).toBe("sha256:" + "a".repeat(64));

    // Scoping the forward lookup to one manifest is the same single-hop read, narrowed.
    const onlyGoMod = await inA((tx) =>
      listComponentDependencies(tx, orgA.orgId, componentId, { manifestPath: "go.mod" })
    );
    expect(onlyGoMod.map((d) => d.lineId)).toEqual([go.id]);

    // A declaration row is a SNAPSHOT OF ONE MANIFEST READ, not an accumulator. The update branch
    // writes `resolvedVersion`/`resolvedDigest`/`observedRef` as `input ?? null`
    // (dependency-inventory-repo.ts:298-304), so a re-read that resolves nothing CLEARS what the
    // last read resolved — deliberately the opposite of `recordDependencyLineHead`'s digest rule
    // (omitted keeps, explicit null clears): the head is a fact about the LINE that must survive a
    // manifest sweep, while these three are only what THIS manifest said THIS time, and a stale
    // digest beside a fresh `declaredVersion` would claim bytes nobody resolved.
    //
    // Pinned because nothing else did: deleting all three keys from that SET list left every other
    // test in this file green. If M21.3 ever wants preserve-on-omit here, this assertion is the
    // conversation — change both halves together, not one.
    const reread = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: image.id,
        manifestPath: "Dockerfile",
        declaredVersion: "3.19"
      })
    );
    // NEGATIVE CONTROL: the update branch ran, so the three NULLs are a clear and not a no-op.
    expect(reread.declaredVersion).toBe("3.19");
    expect(reread.resolvedVersion).toBeNull();
    expect(reread.resolvedDigest).toBeNull();
    expect(reread.observedRef).toBeNull();
  });

  it("a prune is scoped to ONE component — another component's identical declaration survives", async () => {
    // The prune's WHERE has three predicates and the test above exercised only one component, so
    // `manifest_path` alone reproduced every assertion it made: dropping
    // `eq(componentDependencies.componentObjectId, input.componentObjectId)` from `scope`
    // (dependency-inventory-repo.ts:378-382) left all 23 tests green. Two components declaring the
    // same line from a file with the same NAME is not an exotic case — `package.json` is the path
    // for every npm component in the org — so under that mutation one component's re-ingestion
    // deletes every OTHER component's declarations read from any file also called `package.json`,
    // emptying the org's npm inventory one ingestion at a time while the function returns a rowCount
    // the caller reads as a successful prune.
    //
    // The `keepLineIds` list is non-empty here for a second reason: the only other prune test passes
    // `[]`, which takes the short-circuit branch, so the `notInArray` half of that ternary
    // (repo:386-388) — the branch real re-ingestion always takes — had no coverage at all.
    const mine = await componentIn(clientA, "prune-scope-mine");
    const theirs = await componentIn(clientA, "prune-scope-theirs");
    const dropped = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/prune-scope-dropped",
        major: "1"
      })
    );
    const kept = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/prune-scope-kept",
        major: "1"
      })
    );

    // BOTH components declare the dropped line from a manifest at the SAME path.
    for (const componentObjectId of [mine, theirs]) {
      await inA((tx) =>
        upsertComponentDependency(tx, orgA.orgId, {
          componentObjectId,
          lineId: dropped.id,
          manifestPath: "package.json",
          declaredVersion: "^1.0.0"
        })
      );
    }
    await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: mine,
        lineId: kept.id,
        manifestPath: "package.json",
        declaredVersion: "^1.2.0"
      })
    );

    // `mine`'s `package.json` is re-read and no longer declares `@acme/prune-scope-dropped`.
    const removed = await inA((tx) =>
      pruneComponentDependencies(tx, orgA.orgId, {
        componentObjectId: mine,
        manifestPath: "package.json",
        keepLineIds: [kept.id]
      })
    );
    // ONE row, not two: the count itself is an assertion about scope, not just about the delete.
    expect(removed).toBe(1);

    // NEGATIVE CONTROL: the prune really ran — `mine` lost the dropped line and kept the kept one,
    // so "the other component survived" below is not "the delete matched nothing".
    const mineNow = await inA((tx) =>
      listComponentDependencies(tx, orgA.orgId, mine, { manifestPath: "package.json" })
    );
    expect(mineNow.map((d) => d.lineId)).toEqual([kept.id]);

    // THE PROPERTY: the other component's declaration of the very same line, from a manifest at the
    // very same path, is untouched. Its inventory is not `mine`'s to prune.
    const theirsNow = await inA((tx) =>
      listComponentDependencies(tx, orgA.orgId, theirs, { manifestPath: "package.json" })
    );
    expect(theirsNow.map((d) => d.lineId)).toEqual([dropped.id]);
  });

  it("re-observing a declaration preserves createdAt and advances observedAt", async () => {
    // Two timestamps with opposite rules, and the difference between them is one key's presence in
    // an ON CONFLICT SET list — nothing structural. `createdAt` answers "how long has this component
    // been on this line?", which a poll that reset it every few hours would make permanently read
    // "minutes"; `observedAt` answers "when did we last look?", which a poll that failed to move it
    // would make a stale inventory indistinguishable from a fresh one.
    const componentId = await componentIn(clientA, "timestamps");
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "python",
        coordinate: "acme-timestamps",
        major: "1"
      })
    );
    const declaration = {
      componentObjectId: componentId,
      lineId: line.id,
      manifestPath: "pyproject.toml"
    };
    const first = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, { ...declaration, declaredVersion: "~=1.2" })
    );

    // `observedAt` is a JS `new Date()`, which has MILLISECOND resolution. Without this wait the two
    // writes can land in the same millisecond on a fast machine and the "advances" assertion below
    // would be green for a reason that has nothing to do with the SET list.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, { ...declaration, declaredVersion: "~=1.3" })
    );
    // NEGATIVE CONTROL: the update branch ran, so "createdAt unchanged" below is not "no write".
    expect(second.declaredVersion).toBe("~=1.3");
    expect(second.createdAt).toBe(first.createdAt);
    expect(new Date(second.observedAt).getTime()).toBeGreaterThan(
      new Date(first.observedAt).getTime()
    );
  });

  it("the producer link is a separate verb, is retractable, and cannot be half-written", async () => {
    const producer = await componentIn(clientA, "publisher");
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "maven",
        coordinate: "com.acme:internal-lib",
        major: "3"
      })
    );
    // NEGATIVE CONTROL: ingestion alone never makes a line internal (ADR-0032 §7 — declared, never
    // inferred). The coordinate here is as "internal-looking" as a name can be and it changes nothing.
    expect(line.producedByObjectId).toBeNull();

    const declared = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: producer,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(declared.producedByObjectId).toBe(producer);
    expect(declared.producedByDeclaredAt).not.toBeNull();

    const retracted = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: null,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(retracted.producedByObjectId).toBeNull();
    // The declaration timestamp is cleared WITH the link — a stale "declared at" beside a null
    // producer would read as evidence a human had asserted something they had retracted.
    expect(retracted.producedByDeclaredAt).toBeNull();
    expect(retracted.producedByDeclaredByObjectId).toBeNull();

    // The database refuses a HALF-WRITTEN producer link even from raw SQL. Note what this does and
    // does not buy (0060's "INTERNAL vs THIRD-PARTY" header): the capability that is MISSING rather
    // than guarded is ingestion's — `UpsertDependencyLineInput` has no producer field. This CHECK is
    // the weaker half; it catches a raw-SQL or future-verb half-write, not a non-human caller of
    // `declareDependencyLineProducer`, which always stamps all three columns.
    const raw = await RawScpAppClient.connect();
    await raw.setOrgContext(orgA.orgId);
    await expect(
      raw.query("UPDATE dependency_lines SET produced_by_object_id = $1 WHERE id = $2", [
        producer,
        line.id
      ])
    ).rejects.toThrow(/dependency_lines_internal_is_declared/i);

    // A link with a timestamp but NO DECLARING PRINCIPAL is refused too. Without the second conjunct
    // of the CHECK this row would store cleanly, and `produced_by_declared_by_object_id`'s own
    // COMMENT — "which principal asserted this line is internal?" must be answerable — would be
    // false while every constraint passed.
    await expect(
      raw.query(
        `UPDATE dependency_lines
            SET produced_by_object_id = $1, produced_by_declared_at = now()
          WHERE id = $2`,
        [producer, line.id]
      )
    ).rejects.toThrow(/dependency_lines_internal_is_declared/i);

    // ...and a FABRICATED principal is refused by the foreign key, so the answer cannot be a uuid
    // that names nothing either. NULL and "made up" are the two ways the question goes unanswerable.
    await expect(
      raw.query(
        `UPDATE dependency_lines
            SET produced_by_object_id = $1, produced_by_declared_at = now(),
                produced_by_declared_by_object_id = $2
          WHERE id = $3`,
        [producer, uuidv7(), line.id]
      )
    ).rejects.toThrow(/foreign key/i);

    // NEGATIVE CONTROL for all three rejections: the SAME raw statement with a real principal
    // succeeds, so the failures above are the constraints doing work and not a malformed statement.
    const accepted = await raw.query(
      `UPDATE dependency_lines
          SET produced_by_object_id = $1, produced_by_declared_at = now(),
              produced_by_declared_by_object_id = $2
        WHERE id = $3`,
      [producer, adminObjectIdA, line.id]
    );
    expect(accepted.rowCount).toBe(1);
    await raw.close();
  });

  it("records an observed line head without disturbing identity or the declared producer link", async () => {
    const producer = await componentIn(clientA, "head-producer");
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "registry.internal/base/node",
        major: "22",
        tagPattern: "22.*"
      })
    );
    // NULL is "not yet observed", NOT "no newer version exists" — absent never means zero.
    expect(line.latestVersion).toBeNull();
    expect(line.latestObservedAt).toBeNull();

    // The PRODUCER half of this test's name has to be SET UP before it can be asserted. An earlier
    // draft skipped this declaration, so the three `produced_by_*` columns were NULL either way and
    // the "does not disturb the producer link" claim was carried entirely by the test's title — the
    // vacuous shape where a test is green for the wrong reason.
    const declared = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: producer,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(declared.producedByObjectId).toBe(producer);

    const observed = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "22.6.0",
        latestDigest: "sha256:" + "b".repeat(64)
      })
    );
    expect(observed.latestVersion).toBe("22.6.0");
    expect(observed.latestDigest).toBe("sha256:" + "b".repeat(64));
    expect(observed.latestObservedAt).not.toBeNull();
    // Identity columns are untouched by an observation.
    expect(observed.coordinate).toBe("registry.internal/base/node");
    expect(observed.major).toBe("22");
    expect(observed.tagPattern).toBe("22.*");
    // ...and so is the producer link, all three columns of it. Registry observation and operator
    // declaration are different ingresses (ADR-0032 §7); the observation's SET list reaching
    // `produced_by_*` is a one-key edit that no constraint and no type would catch.
    expect(observed.producedByObjectId).toBe(producer);
    expect(observed.producedByDeclaredAt).toBe(declared.producedByDeclaredAt);
    expect(observed.producedByDeclaredByObjectId).toBe(adminObjectIdA);
  });

  it("declaring a producer AFTER the head was observed cannot clobber the observation", async () => {
    // The MIRROR of the test above, and the ORDER is the entire content of it. Every test in this
    // file that combined these two verbs declared the producer FIRST and observed SECOND, so a
    // `latest_*` clobber by `declareDependencyLineProducer` was always overwritten by the later
    // observation and could not be seen by any assertion: adding
    // `latestVersion: null, latestDigest: null, latestObservedAt: null` to that function's SET list
    // (dependency-inventory-repo.ts:207-212) left all 23 tests green. A disjointness test only pins
    // the writer that runs LAST — each pair of ingresses has to be asserted in the order that puts
    // the SUSPECT verb after the field it must not touch.
    //
    // What the widened SET list would cost: an operator marking a line internal wipes M21.4's
    // observed head, and the line then reads NULL — which 0060:200-201 defines as "NOT YET
    // OBSERVED", not "no newer version exists" (absent never means zero). A dependency subscription
    // resolving against that line is silently starved of exactly the bump it exists to fire, with
    // nothing erroring and nothing to distinguish it from a line the poll has not reached yet.
    const producer = await componentIn(clientA, "declare-after-observe");
    const digest = "sha256:" + "e".repeat(64);
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "registry.internal/base/declare-after-observe",
        major: "22",
        tagPattern: "22.*"
      })
    );

    // OBSERVATION FIRST — this is the state the declaration must leave alone.
    const observed = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "22.7.0",
        latestDigest: digest
      })
    );
    expect(observed.latestObservedAt).not.toBeNull();

    const declared = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: producer,
        declaredByObjectId: adminObjectIdA
      })
    );
    // NEGATIVE CONTROL: the declaration genuinely landed on this row, so the three surviving
    // observation fields below are not "the update matched nothing".
    expect(declared.producedByObjectId).toBe(producer);
    expect(declared.producedByDeclaredAt).not.toBeNull();

    // All THREE observation columns survive — the trio moves together (0060:198-206), so pinning
    // only `latest_version` would leave a SET list that nulls the digest and the timestamp green.
    expect(declared.latestVersion).toBe("22.7.0");
    expect(declared.latestDigest).toBe(digest);
    expect(declared.latestObservedAt).toBe(observed.latestObservedAt);

    // RETRACTION runs the same SET list down its other branch (`retracting`,
    // dependency-inventory-repo.ts:204). Un-marking a line internal is no more entitled to erase the
    // registry's observation than marking it was.
    const retracted = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: null,
        declaredByObjectId: adminObjectIdA
      })
    );
    expect(retracted.producedByObjectId).toBeNull();
    expect(retracted.latestVersion).toBe("22.7.0");
    expect(retracted.latestDigest).toBe(digest);
    expect(retracted.latestObservedAt).toBe(observed.latestObservedAt);
  });

  it("an omitted latestDigest leaves the stored one alone; an explicit null clears it", async () => {
    // For `oci`, the digest is what a version claim MEANS (ADR-0032 §7) — "we are on 3.20" is a
    // statement about bytes. The two cases below are distinguished by `undefined` vs `null` in
    // `recordDependencyLineHead`, which is a distinction TypeScript does not enforce anywhere: the
    // inverted implementation (`latestDigest: input.latestDigest ?? null`) compiles identically, and
    // under it a language-ecosystem poll that omits the field would silently wipe an image line's
    // digest — a version claim that no longer says anything about bytes.
    const digest = "sha256:" + "d".repeat(64);
    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "oci",
        coordinate: "registry.internal/base/digest-semantics",
        major: "3",
        tagPattern: "3.*"
      })
    );
    const withDigest = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "3.20.0",
        latestDigest: digest
      })
    );
    expect(withDigest.latestDigest).toBe(digest);

    // OMITTED — the key never reaches the SET list, so the stored digest survives.
    const omitted = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, { lineId: line.id, latestVersion: "3.20.1" })
    );
    // NEGATIVE CONTROL: the write happened, so the surviving digest is not "nothing was updated".
    expect(omitted.latestVersion).toBe("3.20.1");
    expect(omitted.latestDigest).toBe(digest);

    // EXPLICIT null — the caller is saying this line has no digest, which is what the four language
    // ecosystems supply. It clears.
    const cleared = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "3.20.2",
        latestDigest: null
      })
    );
    expect(cleared.latestVersion).toBe("3.20.2");
    expect(cleared.latestDigest).toBeNull();
  });

  it("manifest re-ingestion cannot clobber a declared producer or an observed head", async () => {
    // The three ingresses of one `dependency_lines` row — manifest ingestion (this test's
    // re-upsert), operator declaration and registry observation — write disjoint column sets, and
    // separate verbs are the whole reason ADR-0032 §7 splits them. Nothing but the literal
    // ON CONFLICT SET list in `upsertDependencyLine` enforces the disjointness: widening it to
    // `latest_*` or `produced_by_*` type-checks, and every round-trip test in this file still
    // passes. This is the test that does not.
    const producer = await componentIn(clientA, "reingest-producer");
    const key = {
      ecosystem: "oci",
      coordinate: "registry.internal/base/reingest",
      major: "3",
      tagPattern: "3.*"
    } as const;

    const line = await inA((tx) => upsertDependencyLine(tx, orgA.orgId, key));
    const declared = await inA((tx) =>
      declareDependencyLineProducer(tx, orgA.orgId, {
        lineId: line.id,
        producedByObjectId: producer,
        declaredByObjectId: adminObjectIdA
      })
    );
    const observed = await inA((tx) =>
      recordDependencyLineHead(tx, orgA.orgId, {
        lineId: line.id,
        latestVersion: "3.20.1",
        latestDigest: "sha256:" + "c".repeat(64)
      })
    );

    // The manifest ingress runs again over the same natural key, carrying a NEW tag pattern — the
    // one column its update branch is allowed to touch.
    const reingested = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, { ...key, tagPattern: "3.2*" })
    );
    expect(reingested.id).toBe(line.id);
    // NEGATIVE CONTROL: the update branch genuinely executed, so the six preserved fields below are
    // not "the upsert did nothing".
    expect(reingested.tagPattern).toBe("3.2*");

    // The operator's declaration survives an ingestion run. If it did not, a nightly manifest sweep
    // would quietly return every internal line to third-party.
    expect(reingested.producedByObjectId).toBe(producer);
    expect(reingested.producedByDeclaredAt).toBe(declared.producedByDeclaredAt);
    expect(reingested.producedByDeclaredByObjectId).toBe(adminObjectIdA);
    // ...and so does M21.4's observation. A component declaring `3.18` says nothing about the head
    // of the line, so ingestion must not be able to overwrite what the registry poll recorded.
    expect(reingested.latestVersion).toBe("3.20.1");
    expect(reingested.latestDigest).toBe(observed.latestDigest);
    expect(reingested.latestObservedAt).toBe(observed.latestObservedAt);

    // The OTHER half of that one permitted column, which had nothing holding it: an ingestion that
    // OMITS the pattern must not erase one. `coalesce(excluded.tag_pattern, existing)`
    // (dependency-inventory-repo.ts:132-134) is the whole mechanism — replacing it with a plain
    // `excluded.tag_pattern` left all 25 tests green, and omission is the COMMON case, not the
    // exotic one: a Dockerfile parser has no notion of a tag pattern, so every sweep would clear
    // the one an operator set and M21.4 would be left following a line with no shape to follow.
    // The negative control is the assertion two lines up — the same branch, given a pattern, wrote
    // it — so this is not "the upsert cannot write tag_pattern at all".
    const withoutPattern = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: key.ecosystem,
        coordinate: key.coordinate,
        major: key.major
      })
    );
    expect(withoutPattern.id).toBe(line.id);
    expect(withoutPattern.tagPattern).toBe("3.2*");
  });

  // -----------------------------------------------------------------------------------------
  // (c) The URN-collision case — the reason the inventory is a table at all
  // -----------------------------------------------------------------------------------------

  it("treats '@acme/lib', 'acme/lib' and 'acme-lib' as THREE lines, which one URN could not", () => {
    // The hazard, asserted rather than remembered: `deriveUrn`'s slug collapses all three into one
    // identity (graph/urn.ts:6-14), which is a 409 with no auto-suffix and no upsert-by-coordinate.
    expect(slugify("@acme/lib")).toBe("acme-lib");
    expect(slugify("acme/lib")).toBe("acme-lib");
    expect(slugify("acme-lib")).toBe("acme-lib");
  });

  it("keys lines on the VERBATIM coordinate, so URN-colliding coordinates stay distinct", async () => {
    const coordinates = ["@acme/lib", "acme/lib", "acme-lib"];
    const lines = await inA(async (tx) => {
      const out = [];
      for (const coordinate of coordinates) {
        out.push(
          await upsertDependencyLine(tx, orgA.orgId, { ecosystem: "npm", coordinate, major: "1" })
        );
      }
      return out;
    });

    // Three coordinates, three ids, and each stored byte-for-byte as written.
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
    expect(lines.map((l) => l.coordinate)).toEqual(coordinates);

    // Each is independently addressable by its own natural key — the property a shared slug destroys.
    for (const [i, coordinate] of coordinates.entries()) {
      const fetched = await inA((tx) =>
        getDependencyLineByKey(tx, orgA.orgId, { ecosystem: "npm", coordinate, major: "1" })
      );
      expect(fetched?.id).toBe(lines[i]?.id);
    }

    // NEGATIVE CONTROL: the key really is a key. Re-upserting one of them returns the SAME row, so
    // the three-way distinctness above is the coordinate doing work, not the upsert failing to
    // deduplicate anything at all.
    const again = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        major: "1"
      })
    );
    expect(again.id).toBe(lines[0]?.id);
  });

  it("separates lines that differ ONLY by major, and lines that differ ONLY by ecosystem", async () => {
    const one = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "python",
        coordinate: "shared-name",
        major: "1"
      })
    );
    const two = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "python",
        coordinate: "shared-name",
        major: "2"
      })
    );
    const otherEcosystem = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "npm",
        coordinate: "shared-name",
        major: "1"
      })
    );
    expect(new Set([one.id, two.id, otherEcosystem.id]).size).toBe(3);

    // Three DISTINCT ROWS is the unique index's doing. Retrieving each one BY ITS OWN KEY is a
    // different property with a different mechanism — `getDependencyLineByKey`'s own four-predicate
    // WHERE (dependency-inventory-repo.ts:153-160) — and two of those four had nothing pinning
    // them: dropping `eq(ecosystem)` or `eq(major)` from it left all 25 tests green, because every
    // other lookup in this file uses coordinates unique within the org. With `.limit(1)` and no
    // ORDER BY, the caller then silently gets an ARBITRARY sibling: an M21.3 ingestion resolving
    // `major: "2"` would hang its declarations off the `major: "1"` row, and a subscription on one
    // major would fire on the other's head.
    const byKey = (k: { ecosystem: "python" | "npm"; coordinate: string; major: string }) =>
      inA((tx) => getDependencyLineByKey(tx, orgA.orgId, k));
    expect((await byKey({ ecosystem: "python", coordinate: "shared-name", major: "1" }))?.id).toBe(
      one.id
    );
    expect((await byKey({ ecosystem: "python", coordinate: "shared-name", major: "2" }))?.id).toBe(
      two.id
    );
    expect((await byKey({ ecosystem: "npm", coordinate: "shared-name", major: "1" }))?.id).toBe(
      otherEcosystem.id
    );
  });

  // -----------------------------------------------------------------------------------------
  // (b) RLS — the load-bearing one
  // -----------------------------------------------------------------------------------------

  describe("RLS isolates two orgs' inventories", () => {
    let lineAId: string;
    let componentAId: string;

    beforeAll(async () => {
      componentAId = await componentIn(clientA, "rls-secret");
      const line = await inA((tx) =>
        upsertDependencyLine(tx, orgA.orgId, {
          ecosystem: "go",
          coordinate: "github.com/acme/org-a-only",
          major: "v1"
        })
      );
      lineAId = line.id;
      await inA((tx) =>
        upsertComponentDependency(tx, orgA.orgId, {
          componentObjectId: componentAId,
          lineId: lineAId,
          manifestPath: "go.mod",
          declaredVersion: "v1.0.0"
        })
      );
    });

    it("both tables ENABLE and FORCE row level security", async () => {
      // FORCE matters independently of ENABLE: without it the table's OWNER bypasses every policy,
      // and a migration or maintenance path running as owner would read across orgs.
      const rows = await server.deps.db.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`SELECT relname, relrowsecurity, relforcerowsecurity
             FROM pg_class
             WHERE relname IN ('dependency_lines', 'component_dependencies')`);
      const byName = new Map(rows.rows.map((r) => [r.relname, r]));
      expect(byName.size).toBe(2);
      for (const name of ["dependency_lines", "component_dependencies"]) {
        expect(byName.get(name)?.relrowsecurity, name).toBe(true);
        expect(byName.get(name)?.relforcerowsecurity, name).toBe(true);
      }
    });

    it("the policy carries BOTH a USING and a WITH CHECK qual on each table", async () => {
      // A USING-only policy filters reads but lets an org WRITE a row stamped with another org's id.
      const rows = await server.deps.db.execute<{
        tablename: string;
        qual: string | null;
        with_check: string | null;
      }>(sql`SELECT tablename, qual, with_check
             FROM pg_policies
             WHERE tablename IN ('dependency_lines', 'component_dependencies')
               AND policyname = 'org_isolation'`);
      expect(rows.rows).toHaveLength(2);
      for (const row of rows.rows) {
        expect(row.qual, row.tablename).toContain("app.current_org_id");
        expect(row.with_check, row.tablename).toContain("app.current_org_id");
      }
    });

    it("org B cannot READ org A's lines or declarations — raw scp_app connection, no app code", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      const lines = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const deps = await raw.query(
        "SELECT * FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      expect(lines.rows).toHaveLength(0);
      expect(deps.rows).toHaveLength(0);

      // NEGATIVE CONTROL, in the same test so the zeroes above cannot be explained by "the rows were
      // never written". Under org A's context the SAME queries on the SAME connection return them.
      await raw.setOrgContext(orgA.orgId);
      const linesA = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const depsA = await raw.query(
        "SELECT * FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      await raw.close();
      expect(linesA.rows).toHaveLength(1);
      expect(depsA.rows).toHaveLength(1);
    });

    it("fails closed when app.current_org_id is never set", async () => {
      const raw = await RawScpAppClient.connect();
      const lines = await raw.query("SELECT * FROM dependency_lines WHERE id = $1", [lineAId]);
      const deps = await raw.query("SELECT * FROM component_dependencies");
      await raw.close();
      expect(lines.rows).toHaveLength(0);
      expect(deps.rows).toHaveLength(0);
    });

    it("org B cannot UPDATE or DELETE org A's rows", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      const updated = await raw.query(
        "UPDATE dependency_lines SET coordinate = 'pwned' WHERE id = $1",
        [lineAId]
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await raw.query(
        "DELETE FROM component_dependencies WHERE component_object_id = $1",
        [componentAId]
      );
      expect(deleted.rowCount).toBe(0);
      await raw.close();

      // NEGATIVE CONTROL: the row is untouched and still readable by its owner.
      const stillThere = await inA((tx) => listDependencyLinesByIds(tx, orgA.orgId, [lineAId]));
      expect(stillThere[0]?.coordinate).toBe("github.com/acme/org-a-only");
    });

    it("org B cannot INSERT a row claiming org A's org_id (WITH CHECK)", async () => {
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      await expect(
        raw.query(
          `INSERT INTO dependency_lines (id, org_id, ecosystem, coordinate, major)
           VALUES ($1, $2, 'npm', 'cross-org', '1')`,
          [uuidv7(), orgA.orgId]
        )
      ).rejects.toThrow(/row-level security/i);
      await raw.close();
    });

    it("a declaration cannot reference ANOTHER org's line even under its own org's context", async () => {
      // Barrier 2 (0060 header): the composite `(org_id, line_id)` foreign key. RLS's WITH CHECK
      // only pins the row's OWN org_id, so without this key org B could stamp a row with its own
      // org_id pointing at org A's line — a dangling cross-tenant reference that no read would
      // reveal. The failure here is an FK violation, NOT an RLS one, which is what proves the second
      // barrier is the thing doing the work.
      const componentB = await componentIn(clientB, "rls-b");
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);
      await expect(
        raw.query(
          `INSERT INTO component_dependencies
             (org_id, component_object_id, line_id, manifest_path, declared_version)
           VALUES ($1, $2, $3, 'go.mod', 'v1.0.0')`,
          [orgB.orgId, componentB, lineAId]
        )
      ).rejects.toThrow(/component_dependencies_line_fk|foreign key/i);
      await raw.close();

      // NEGATIVE CONTROL: the identical insert against org B's OWN line succeeds, so the rejection
      // above is the cross-org reference and not a broken statement.
      const ownLine = await inB((tx) =>
        upsertDependencyLine(tx, orgB.orgId, {
          ecosystem: "go",
          coordinate: "github.com/acme/org-b-only",
          major: "v1"
        })
      );
      const ok = await inB((tx) =>
        upsertComponentDependency(tx, orgB.orgId, {
          componentObjectId: componentB,
          lineId: ownLine.id,
          manifestPath: "go.mod",
          declaredVersion: "v1.0.0"
        })
      );
      expect(ok.lineId).toBe(ownLine.id);
    });

    it("RECORDS THE RESIDUAL: a cross-org OBJECT reference is not structurally prevented", async () => {
      // Barrier 2 (the composite key) covers `line_id` AND NOTHING ELSE. `component_object_id`,
      // `produced_by_object_id` and `produced_by_declared_by_object_id` are plain, ORG-UNBOUND
      // `REFERENCES objects(id)` — `objects` has no `(org_id, id)` unique constraint to hang a
      // composite key on. Referential-integrity triggers are not subject to RLS, so the FK check
      // reads org A's row and passes.
      //
      // This test asserts the CURRENT behaviour rather than the desired one, because 0060's header
      // claimed "two structural barriers keep a cross-org reference impossible" without saying WHICH
      // reference, and an unasserted scope is how that claim stayed unexamined. A future migration
      // that binds `objects` by `(org_id, id)` SHOULD break this test — that is the point of it.
      const strayComponentA = await componentIn(clientA, "cross-org-residual");
      const ownLine = await inB((tx) =>
        upsertDependencyLine(tx, orgB.orgId, {
          ecosystem: "npm",
          coordinate: "@acme/residual",
          major: "1"
        })
      );
      const raw = await RawScpAppClient.connect();
      await raw.setOrgContext(orgB.orgId);

      // Org B's own org_id (so RLS WITH CHECK passes) pointing at ORG A's component object.
      const accepted = await raw.query(
        `INSERT INTO component_dependencies
           (org_id, component_object_id, line_id, manifest_path, declared_version)
         VALUES ($1, $2, $3, 'package.json', '^1.0.0')`,
        [orgB.orgId, strayComponentA, ownLine.id]
      );
      expect(accepted.rowCount).toBe(1);

      // ...and THAT is the disclosure: an id naming nothing is rejected, so success-versus-FK-failure
      // is an existence oracle over another tenant's object ids for anything already holding a raw
      // `scp_app` connection. Not reachable through the API today (M21.2 has no route); the
      // mitigation an M21.3 route owes is to resolve caller-supplied object ids under the CALLER's
      // own org before they reach this table.
      await expect(
        raw.query(
          `INSERT INTO component_dependencies
             (org_id, component_object_id, line_id, manifest_path, declared_version)
           VALUES ($1, $2, $3, 'other.json', '^1.0.0')`,
          [orgB.orgId, uuidv7(), ownLine.id]
        )
      ).rejects.toThrow(/foreign key/i);

      // Leave no cross-org row behind: sibling assertions in this describe read org A's and org B's
      // inventories, and a stray row would make one of them pass or fail for an unrelated reason.
      const cleaned = await raw.query(
        "DELETE FROM component_dependencies WHERE org_id = $1 AND component_object_id = $2",
        [orgB.orgId, strayComponentA]
      );
      expect(cleaned.rowCount).toBe(1);
      await raw.close();
    });

    it("the repo layer scoped to org B returns nothing of org A's, by either hot query", async () => {
      expect(await inB((tx) => listDependencyLinesByIds(tx, orgB.orgId, [lineAId]))).toEqual([]);
      expect(await inB((tx) => listComponentsDeclaringLine(tx, orgB.orgId, lineAId))).toEqual([]);
      expect(await inB((tx) => listComponentDependencies(tx, orgB.orgId, componentAId))).toEqual(
        []
      );
      expect(
        await inB((tx) =>
          getDependencyLineByKey(tx, orgB.orgId, {
            ecosystem: "go",
            coordinate: "github.com/acme/org-a-only",
            major: "v1"
          })
        )
      ).toBeNull();
    });

    it("scp_app holds no DELETE grant on dependency_lines, and does hold one on the projection", async () => {
      // Lines are the identity a dependency subscription is written against; deleting one would
      // orphan the subscription. The projection must be prunable — a manifest can drop a dependency.
      const rows = await server.deps.db.execute<{ table_name: string; privilege_type: string }>(
        sql`SELECT table_name, privilege_type
            FROM information_schema.role_table_grants
            WHERE grantee = 'scp_app'
              AND privilege_type = 'DELETE'
              AND table_name IN ('dependency_lines', 'component_dependencies')`
      );
      const tables = rows.rows.map((r) => r.table_name);
      expect(tables).toContain("component_dependencies");
      expect(tables).not.toContain("dependency_lines");
    });
  });

  // -----------------------------------------------------------------------------------------
  // ADR-0032 §5 and §3 — the two boundaries that are not visible in any single query
  // -----------------------------------------------------------------------------------------

  it("mints NO relationship — package dependencies never become a depends_on edge", async () => {
    const componentId = await componentIn(clientA, "no-edge");
    const before = await inA(
      async (tx) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(relationships)
            .where(eq(relationships.orgId, orgA.orgId))
        )[0]?.count ?? 0
    );

    // The counting query must be able to SEE edges, or "after === before" would hold for a broken
    // query too. `createTestComponent` mints real `contains`/`part_of` edges, so this is > 0.
    expect(before).toBeGreaterThan(0);

    const line = await inA((tx) =>
      upsertDependencyLine(tx, orgA.orgId, {
        ecosystem: "go",
        coordinate: "github.com/acme/no-edge",
        major: "v1"
      })
    );
    const declaration = await inA((tx) =>
      upsertComponentDependency(tx, orgA.orgId, {
        componentObjectId: componentId,
        lineId: line.id,
        manifestPath: "go.mod",
        declaredVersion: "v1.0.0"
      })
    );

    const after = await inA(
      async (tx) =>
        (
          await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(relationships)
            .where(eq(relationships.orgId, orgA.orgId))
        )[0]?.count ?? 0
    );

    // The absence: not one edge of ANY type, `depends_on` included. That type is the wave-plan
    // toposort input and a cycle among co-placed targets is a hard plan-compile error, while package
    // graphs routinely contain cycles (ADR-0032 §5).
    expect(after).toBe(before);
    const dependsOn = await inA((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(relationships)
        .where(eq(relationships.typeId, "depends_on"))
    );
    expect(dependsOn[0]?.count).toBe(0);

    // NEGATIVE CONTROL: the ingestion genuinely happened, so "zero edges" is not "zero work".
    expect(declaration.lineId).toBe(line.id);
    expect(await inA((tx) => listComponentsDeclaringLine(tx, orgA.orgId, line.id))).toHaveLength(1);
  });

  it("no source file in src/dependencies declares a recursive CTE (ADR-0032 §3's boundary)", () => {
    // The boundary that justifies the whole tabular representation is a DISCIPLINE, and ADR-0032
    // says in as many words that it "must be enforced by test, not by intention".
    //
    // The census reads the WHOLE DIRECTORY, not one named file. M21.3 (ingestion) and M21.4
    // (detection) land siblings here, and a census that names its one file is exactly where the
    // next instance hides — census with no filters (CLAUDE.md).
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    // ...and the census must have material, or an empty directory listing is a green empty loop.
    expect(sources).toContain("dependency-inventory-repo.ts");
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(/\bwith\s+recursive\b/i.test(text), file).toBe(false);
    }

    // NEGATIVE CONTROL for the matcher itself — the single most common way an absence assertion goes
    // vacuous is a pattern that never matches anything. `graph/named-queries.ts` is where this
    // codebase's recursive CTE actually lives (the one measured at 7+ minutes then disk exhaustion),
    // so the same regex MUST fire there.
    const namedQueries = readFileSync(
      fileURLToPath(new URL("../graph/named-queries.ts", import.meta.url)),
      "utf8"
    );
    expect(/\bwith\s+recursive\b/i.test(namedQueries)).toBe(true);

    // WHAT THIS DOES NOT PROVE, said plainly so the census is not read as more than it is:
    //   - It catches a LITERAL recursive CTE in this directory's source, and nothing else. The
    //     realistic route to a transitive walk carries no such SQL at all: an application-level loop
    //     that calls `listComponentDependencies` for each line it just got back, or a caller in
    //     another directory doing the same. This census passes clean over both.
    //   - What actually discourages that route is the contract, not this test: no shape in
    //     `packages/schemas/src/dependencies.ts` returns a LINE's own dependencies, so there is
    //     nothing to loop into without adding one — which is a review-time decision, deliberately.
  });
});

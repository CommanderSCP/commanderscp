import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "./objects-repo.js";
import { findArtifactByIdentity, mintArtifactObjects } from "./artifacts-repo.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `mintArtifactObjects` / `upsertArtifactByIdentity` (ADR-0045 D2) — the identity race a
 * concurrent double-mint creates, and the FIX for the dead race-catch this file pins:
 * `createObject` (objects-repo.ts) already converts the raw pg `23505` unique violation into a
 * `ProblemError` 409 BEFORE `artifacts-repo.ts`'s own `catch` ever sees it, so a
 * `isUniqueViolation(err, "objects_artifact_one_per_digest_type")` check there can never match —
 * the 409 used to escape `mintArtifactObjects` uncaught instead of converging, which could reject
 * a signature-verified promotion import over nothing but timing.
 */
describe("mintArtifactObjects: the identity race converges instead of throwing", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "artifact-mint-race");
  });

  afterAll(async () => {
    await server?.close();
  });

  const mintOptions = (requestId: string) => ({
    actorObjectId: org.orgId,
    requestId,
    mintedBy: "export" as const
  });

  it("a second mint of an identity that already exists converges on the SAME row, no throw", async () => {
    const digest = `sha256:${randomUUID().replace(/-/g, "")}`;
    const artifactType = "oci";

    const first = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      mintArtifactObjects(tx, org.orgId, [{ artifactType, digest }], mintOptions("mint-first"))
    );
    const second = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      mintArtifactObjects(tx, org.orgId, [{ artifactType, digest }], mintOptions("mint-second"))
    );

    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  /**
   * Resolves once some backend in this database is genuinely PARKED on a lock — the positive
   * signal that proves the second mint's INSERT collided with the first's still-open one, rather
   * than hoping a fixed sleep bought enough time (`test-support/integration-sleep-census.test.ts`).
   * Polls fast (25ms) because the state is local and near-instant.
   */
  async function waitForBlockedBackend(db: Db, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.execute(
        sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' limit 1`
      );
      if (rows.rows.length > 0) return;
      if (Date.now() > deadline) {
        throw new Error(
          "no backend ever blocked on a lock — the interleaving this test forces never happened, " +
            "so its verdict is meaningless"
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it(
    "FORCED INTERLEAVING: a mint racing an in-flight, uncommitted insert of the same identity " +
      "converges on the winner's row — never a 409 escaping the caller",
    async () => {
      // The deterministic form of the race, driven at the repo seam so the interleaving is exact
      // rather than hoped for: tx1 inserts the artifact row directly (bypassing the mint wrapper's
      // own find-first check, exactly as a genuinely concurrent second promotion attempt would look
      // to THIS call) and STAYS OPEN, holding both unique indexes' entries uncommitted, while tx2
      // runs the real `mintArtifactObjects` path. Under READ COMMITTED, tx2's own
      // `findArtifactByIdentity` read returns nothing no matter when it lands inside this window (it
      // cannot see tx1's uncommitted row), so it always proceeds to INSERT — which then blocks
      // behind tx1's uncommitted row until tx1 commits, at which point Postgres raises the unique
      // violation `createObject` turns into a 409 `ProblemError`. That is exactly the shape the fix
      // in `artifacts-repo.ts` exists to catch and resolve by re-reading, rather than let escape.
      const digest = `sha256:${randomUUID().replace(/-/g, "")}`;
      const artifactType = "oci";

      let preCreatedId = "";
      let releaseTx1!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        releaseTx1 = resolve;
      });
      let signalTx1Inserted!: () => void;
      const tx1InsertedGate = new Promise<void>((resolve) => {
        signalTx1Inserted = resolve;
      });

      const tx1Promise = withTenantTx(server.deps.db, org.orgId, async (tx) => {
        const row = await createObject(tx, {
          orgId: org.orgId,
          typeId: "artifact",
          actorObjectId: org.orgId,
          requestId: "artifact-race-tx1-precreate",
          id: uuidv7(),
          name: `${artifactType}:${digest}`,
          properties: { digest, artifactType, mintedBy: "export" }
        });
        preCreatedId = row.id;
        // Only NOW is there something real for tx2 to collide with.
        signalTx1Inserted();
        // HOLD the transaction open — uncommitted — until told to release, so tx2's INSERT stays
        // blocked on tx1's row rather than racing tx1's own commit.
        await releaseGate;
        return row;
      });

      // tx2 — the real mint path — starts ONLY once tx1's row is genuinely inserted (still
      // uncommitted), so its own `findArtifactByIdentity` is guaranteed to see nothing (READ
      // COMMITTED cannot see tx1's uncommitted write) and proceed to INSERT, which then collides.
      await tx1InsertedGate;
      const tx2Promise = withTenantTx(server.deps.db, org.orgId, (tx) =>
        mintArtifactObjects(
          tx,
          org.orgId,
          [{ artifactType, digest }],
          mintOptions("artifact-race-tx2-mint")
        )
      );

      // Proves tx2 actually collided with tx1's uncommitted row (impossible for this test to pass
      // vacuously) before releasing tx1 to let both resolve.
      await waitForBlockedBackend(server.deps.db);
      releaseTx1();

      const [, minted] = await Promise.all([tx1Promise, tx2Promise]);

      expect(preCreatedId).not.toBe("");
      expect(minted).toHaveLength(1);
      // Converged on tx1's row — the winner of the race — not a second row, and not a throw.
      expect(minted[0]!.id).toBe(preCreatedId);

      const stored = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        findArtifactByIdentity(tx, org.orgId, artifactType, digest)
      );
      expect(stored?.id).toBe(preCreatedId);
    },
    30_000
  );

  it("a TRUE concurrent double-mint (two independent callers, Promise.all) converges on ONE row", async () => {
    // The production shape: no contrived pre-create, just two callers racing the same identity —
    // the scheduler's mercy rather than a forced interleaving, kept alongside the deterministic
    // test above the same way `boundary-segment.integration.test.ts` keeps both: this one pins the
    // ordinary concurrent-caller path, the forced one pins the fix itself.
    const digest = `sha256:${randomUUID().replace(/-/g, "")}`;
    const artifactType = "oci";

    const results = await Promise.all([
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        mintArtifactObjects(tx, org.orgId, [{ artifactType, digest }], mintOptions("mint-race-a"))
      ),
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        mintArtifactObjects(tx, org.orgId, [{ artifactType, digest }], mintOptions("mint-race-b"))
      )
    ]);

    const ids = new Set(results.map(([artifact]) => artifact!.id));
    expect(ids.size).toBe(1);

    const stored = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      findArtifactByIdentity(tx, org.orgId, artifactType, digest)
    );
    expect(stored?.id).toBe([...ids][0]);
  });
});

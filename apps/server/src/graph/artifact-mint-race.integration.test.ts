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

/** `mintArtifactObjects` / `upsertArtifactByIdentity` (ADR-0045 D2). See docs/graph.md §1. */
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

  /** Resolves once a backend is genuinely parked on a lock. See docs/graph.md §2. */
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
      // The deterministic race, driven at the repo seam. See docs/graph.md §3.
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

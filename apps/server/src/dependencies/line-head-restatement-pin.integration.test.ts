import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { dependencyLines } from "../db/schema.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { evaluateHeadMovement } from "./line-head.js";
import { recordDependencyLineHead, upsertDependencyLine } from "./dependency-inventory-repo.js";

/** That timestamp means when we last looked, not moved. See docs/dependencies.md §320. */

const SCAN_GATE =
  "M22.4 vendor-latest scan exclusions (governance/scan-vendor-latest.ts) read " +
  "dependency_lines.latest_observed_at as a FRESHNESS bound. If a no-op restatement stops " +
  "refreshing it, every stable dependency ages into 'stale' and the security gate silently stops " +
  "granting the vendor-pass. See this file's header before changing this.";

describe("line head: a RESTATEMENT still refreshes latest_observed_at (M22.4 depends on it)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "line-head-restate");
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  it("evaluateHeadMovement reports an identical re-observation as MOVES, movement=restated", () => {
    const line = {
      ecosystem: "npm" as const,
      major: "4",
      tagPattern: null,
      latestVersion: "4.17.21"
    };
    const movement = evaluateHeadMovement(line, "4.17.21");
    expect(movement.moves, SCAN_GATE).toBe(true);
    expect(movement.moves ? movement.movement : "(refused)", SCAN_GATE).toBe("restated");
  });

  it("recordDependencyLineHead ADVANCES latest_observed_at when the head has not moved", async () => {
    const observedAt = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const line = await upsertDependencyLine(tx, org.orgId, {
        ecosystem: "npm",
        coordinate: "@scp/restatement-pin",
        major: "4"
      });

      const first = await recordDependencyLineHead(
        tx,
        org.orgId,
        {
          lineId: line.id,
          latestVersion: "4.17.21",
          latestDigest: null
        },
        // The coordinate has NO declared producer (this test never declares one), which is exactly
        // and only when a public-index answer is legitimate — `line-head.ts`'s `third_party` arm.
        // Required with no default since main's head-write ingress split: an omitted argument does
        // not compile, deliberately.
        { kind: "third_party" }
      );
      expect(first.recorded).toBe(true);

      // Force the stored observation into the past by more than any plausible test runtime, so the
      // second write's effect is unambiguous rather than a millisecond of clock noise.
      const backdated = new Date(Date.now() - 60 * 60 * 1000);
      await tx
        .update(dependencyLines)
        .set({ latestObservedAt: backdated })
        .where(and(eq(dependencyLines.orgId, org.orgId), eq(dependencyLines.id, line.id)));

      // THE SAME VERSION AGAIN — exactly what the daily poll does to every stable line, every day.
      const restated = await recordDependencyLineHead(
        tx,
        org.orgId,
        {
          lineId: line.id,
          latestVersion: "4.17.21",
          latestDigest: null
        },
        // The coordinate has NO declared producer (this test never declares one), which is exactly
        // and only when a public-index answer is legitimate — `line-head.ts`'s `third_party` arm.
        // Required with no default since main's head-write ingress split: an omitted argument does
        // not compile, deliberately.
        { kind: "third_party" }
      );
      expect(restated.recorded, SCAN_GATE).toBe(true);
      expect(restated.recorded ? restated.movement : "(refused)", SCAN_GATE).toBe("restated");

      const [row] = await tx
        .select({ latestObservedAt: dependencyLines.latestObservedAt })
        .from(dependencyLines)
        .where(and(eq(dependencyLines.orgId, org.orgId), eq(dependencyLines.id, line.id)));
      return { stored: row?.latestObservedAt ?? null, backdated };
    });

    expect(observedAt.stored, SCAN_GATE).not.toBeNull();
    expect(observedAt.stored!.getTime(), SCAN_GATE).toBeGreaterThan(observedAt.backdated.getTime());
  });
});

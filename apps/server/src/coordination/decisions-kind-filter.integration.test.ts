import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { Decision } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";
import { insertDecision } from "./decisions-repo.js";

/**
 * ADR-0028 increment 4 — `GET /decisions?kind=…`, and the CLI flag it exists for.
 *
 * THE QUESTION IT ANSWERS, stated the way the operator asks it: "was my coupling enforced here?"
 * `federation/promotion-repo.ts` has promised `scp decision list --kind stage_dependency` as the
 * answer since ADR-0028 landed, and the filter did not exist — `--subject-id` alone was the whole
 * surface, which requires already knowing the change id. That is precisely what the person asking
 * does not have.
 *
 * THE KIND-WITHOUT-SUBJECT CASE IS THE POINT, so it is the first case here rather than an
 * afterthought: with a subject the query was already served by drizzle/0044's index, and it is the
 * subjectless shape that needed drizzle/0056 to stop being a parallel seq scan.
 *
 * Decisions are written through `insertDecision`, the repo's own writer, across SEVERAL subjects —
 * a single-subject fixture would pass identically if the implementation had quietly required
 * `subjectId` alongside `kind`, which is the shape this test exists to refuse.
 */
describe("decisions: the `kind` filter (ADR-0028 increment 4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  const subjectA = randomUUID();
  const subjectB = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "deckind");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // Two subjects, three kinds, and the SAME kind carrying two different verdicts — the overload
    // that makes "a kind is not a state" a real caveat rather than a stylistic one:
    // `stage_dependency` is written as a `hold` by reconcile and as an `allow` by the promotion
    // import's strip.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      for (const [subjectId, kind, verdict] of [
        [subjectA, "stage_dependency", "hold"],
        [subjectA, "gate", "allow"],
        [subjectA, "watchdog", "warn"],
        [subjectB, "stage_dependency", "allow"],
        [subjectB, "gate", "block"]
      ] as const) {
        await insertDecision(tx, {
          orgId: org.orgId,
          kind,
          subjectId,
          verdict,
          inputContext: { fixture: true },
          reasonTree: { summary: `${kind}/${verdict} for ${subjectId}` }
        });
      }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  const kindsOf = (items: Decision[]) => [...new Set(items.map((d) => d.kind))].sort();

  it("filters by kind ACROSS subjects, with no subject id — the shape the promise is about", async () => {
    const page = await admin.decisions.list({ kind: "stage_dependency", limit: 50 });
    expect(kindsOf(page.items)).toEqual(["stage_dependency"]);
    // Both subjects come back. This is the assertion that fails if `kind` were only ever honoured
    // alongside `subjectId`, or if it were quietly ANDed onto one.
    expect([...new Set(page.items.map((d) => d.subjectId))].sort()).toEqual(
      [subjectA, subjectB].sort()
    );
    // A kind is not a state: the same kind carries both verdicts, and the caller reads them apart.
    expect(page.items.map((d) => d.verdict).sort()).toEqual(["allow", "hold"]);
  }, 60_000);

  it("intersects with `subjectId` rather than replacing it", async () => {
    const page = await admin.decisions.list({
      subjectId: subjectA,
      kind: "stage_dependency",
      limit: 50
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.subjectId).toBe(subjectA);
    expect(page.items[0]!.verdict).toBe("hold");
  }, 60_000);

  it("omitting `kind` still returns every kind — the pre-existing call is unchanged", async () => {
    const page = await admin.decisions.list({ subjectId: subjectA, limit: 50 });
    expect(kindsOf(page.items)).toEqual(["gate", "stage_dependency", "watchdog"]);
  }, 60_000);

  it("survives the keyset cursor — page 2 of a filtered list is still filtered", async () => {
    // The filter is one more `WHERE` condition beside the cursor predicate, and the cursor is
    // `(created_at, id)`. Dropping the filter on the second page would be invisible to any
    // single-page test, and would show up in production as a "filtered" list that grows the whole
    // table two pages in.
    const first = await admin.decisions.list({ kind: "gate", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await admin.decisions.list({
      kind: "gate",
      limit: 50,
      cursor: first.nextCursor!
    });
    expect(kindsOf(second.items)).toEqual(["gate"]);
    expect(second.items.map((d) => d.id)).not.toContain(first.items[0]!.id);
  }, 60_000);

  it("`scp decision list --kind stage_dependency` — the promised command, through the real binary", async () => {
    // Black-box, against the built CLI (`test-support/cli-runner.ts`), because the promise in
    // `federation/promotion-repo.ts` is a COMMAND LINE. An SDK-only test would leave the flag
    // itself — the part an operator types — unexercised.
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);
      const rows = await cli.runJson<Decision[]>([
        "decision",
        "list",
        "--kind",
        "stage_dependency",
        "--output",
        "json"
      ]);
      expect(rows.length).toBeGreaterThan(0);
      expect(kindsOf(rows)).toEqual(["stage_dependency"]);
    } finally {
      await cli.cleanup();
    }
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** The service release board projection, end to end. See docs/routes.md §408. */
describe("service board: GET /services/:idOrUrn/board (Phase 2, Layer A)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "service-board");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  it("projects each contained component as a row, with honest empties when no change has targeted it", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const market = await admin.components.create({ name: "market", service: svc.id });
    const gateway = await admin.components.create({ name: "gateway", service: svc.id });

    const board = await admin.services.board(svc.id);

    expect(board.service.id).toBe(svc.id);
    expect(board.serviceFreeze).toBeNull();

    // one row per contained component (the `contains` edges written by component create)
    const rows = new Map(board.rows.map((r) => [r.component.id, r]));
    expect(rows.size).toBe(2);
    expect(rows.has(market.id)).toBe(true);
    expect(rows.has(gateway.id)).toBe(true);

    // no change has targeted these components → Layer-A honest empties, never fabricated
    for (const row of board.rows) {
      expect(row.latestChangeId).toBeNull();
      expect(row.changeState).toBeNull();
      expect(row.currentWave).toBeNull();
      expect(row.waves).toEqual([]);
      expect(row.attention.blocked).toBe(false);
      expect(row.attention.awaitingApproval).toBe(false);
      expect(row.attention.emergency).toBe(false);
      expect(row.attention.decisionId).toBeNull();
      expect(row.activeFreeze).toBeNull();
      // No change at all ⇒ no authority to name, and — critically — the empties above ARE real
      // observations in this single-domain org, so nothing is declared unobservable.
      expect(row.driver).toBeNull();
      expect(row.unknownFields).toEqual([]);
    }

    // summary strip: all stable, none releasing/blocked/not-driven-here; the four sum to rows.length
    expect(board.summary).toEqual({ releasing: 0, blocked: 0, stable: 2, notDrivenHere: 0 });
  });

  it("returns 404 for an unknown / non-service id", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${randomUUID()}/board`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const svc = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
    const res = await server.app.inject({ method: "GET", url: `/api/v1/services/${svc.id}/board` });
    expect(res.statusCode).toBe(401);
  });
});

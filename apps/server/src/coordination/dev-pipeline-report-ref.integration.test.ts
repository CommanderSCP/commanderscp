import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes } from "../db/schema.js";
import { processChangeSourceEvents } from "./webhook-processor.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ADR-0030 §1 — a first-party CI report reaches a REF-SCOPED mapping, through the real typed
 * ingress.
 *
 * This is the end of the chain the milestone actually needs, and it is the half that a unit test of
 * `matchComponentForSource` cannot reach. `ChangeReportRequestSchema` is a **`strictObject`**, so
 * declaring `ref` on it was not cosmetic: an undeclared key is REFUSED, not stripped, and a dev CI
 * step reporting its build's ref would have received a validation error instead of a route. Teaching
 * the processor's generic hint extractor to read `ref` was necessary and NOT sufficient — this suite
 * exists because that distinction is invisible from either side alone.
 *
 * It also underwrites the runbook (`docs/runbooks/dev-pipeline-fast-crossing.md`), whose whole
 * premise is a CI step reporting a scanned dev build so the later crossing short-circuits. That
 * instruction has to be executable, not plausible.
 *
 * Transport is the generated SDK's `changeSources.report(...)` — a real PAT-authed HTTP call
 * (charter principle 3), not a hand-built row.
 */
describe("ADR-0030: a typed CI report routes by git ref", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dev-report-ref");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function resolveComponent(eventId: string): Promise<string | null> {
    await withTenantTx(server.deps.db, org.orgId, (tx) => processChangeSourceEvents(tx, org.orgId));
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(rows[0]!.processedAt).not.toBeNull();
    return rows[0]!.resultingChangeObjectId;
  }

  async function targetsOf(changeObjectId: string): Promise<Record<string, unknown>> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    return (rows[0]!.sourceRef ?? {}) as Record<string, unknown>;
  }

  it("routes a `refs/heads/dev` report to the dev mapping and a `refs/heads/main` one to production", async () => {
    const sourceKind = `terraform`;
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const devComponent = await createTestComponent(admin, {
      name: `dev-${randomUUID().slice(0, 8)}`
    });
    const prodComponent = await createTestComponent(admin, {
      name: `prod-${randomUUID().slice(0, 8)}`
    });

    // Written through the real API, which is also what proves the CLI/SDK surface can express it.
    await admin.changeSources.createMapping(sourceKind, {
      repoPattern: repo,
      refPattern: "refs/heads/dev",
      component: devComponent.id,
      classification: "dev"
    });
    await admin.changeSources.createMapping(sourceKind, {
      repoPattern: repo,
      refPattern: "refs/heads/main",
      component: prodComponent.id
    });

    const dev = await admin.changeSources.report(sourceKind, {
      status: "applied",
      repo,
      ref: "refs/heads/dev",
      correlationKey: `dev-${randomUUID().slice(0, 8)}`
    });
    const prod = await admin.changeSources.report(sourceKind, {
      status: "applied",
      repo,
      ref: "refs/heads/main",
      correlationKey: `prod-${randomUUID().slice(0, 8)}`
    });

    const devChange = await resolveComponent(dev.eventId);
    const prodChange = await resolveComponent(prod.eventId);
    expect(devChange).not.toBeNull();
    expect(prodChange).not.toBeNull();
    expect(devChange).not.toBe(prodChange);

    // The ref survives onto the change's sourceRef, so "which branch produced this release?" is
    // answerable afterwards rather than only at routing time.
    expect((await targetsOf(devChange!)).ref).toBe("refs/heads/dev");
    expect((await targetsOf(prodChange!)).ref).toBe("refs/heads/main");
  });

  it("a report with NO ref does not reach a ref-scoped mapping — fail-closed through the real ingress", async () => {
    const sourceKind = `terraform`;
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const devComponent = await createTestComponent(admin, {
      name: `noref-${randomUUID().slice(0, 8)}`
    });
    await admin.changeSources.createMapping(sourceKind, {
      repoPattern: repo,
      refPattern: "refs/heads/dev",
      component: devComponent.id
    });

    const { eventId } = await admin.changeSources.report(sourceKind, {
      status: "applied",
      repo,
      correlationKey: `noref-${randomUUID().slice(0, 8)}`
    });

    // Correctly DROPPED, not swept into the dev pipeline: the event is marked processed with no
    // resulting change, which is how "no mapping matched" is recorded.
    expect(await resolveComponent(eventId)).toBeNull();
  });
});

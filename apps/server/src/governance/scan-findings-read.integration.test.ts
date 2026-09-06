import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { SCAN_FINDINGS_PERSIST_CAP, type ScanEvidence } from "@scp/schemas";
import { testDatabaseUrl } from "../test-support/harness.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { SCAN_RULE_TEST_CONTROL_REF } from "./test-support/scan-rule-control.js";

/**
 * M22.9 (ADR-0033 §7) — `GET /control-runs/{id}/findings` IS REGISTERED, AND THE MARKER REACHES THE
 * WIRE.
 *
 * `scan_findings` was write-only: two producers wrote it, both discarded the return, and the only
 * reads anywhere in the tree were integration tests reaching into the table. The read route closes
 * that. What it did NOT come with was a proof it is INSTALLED — the wire contract is pinned in
 * `packages/schemas/src/governance.test.ts` and the repo function in
 * `scan-findings.integration.test.ts`, and neither touches the handler, so deleting the `typed.route`
 * block killed no test. This repo's dominant defect is a component built, tested green against
 * itself, and installed nowhere.
 *
 * SO EVERY CASE HERE SPEAKS REAL HTTP to a really-listening server, and the rows under test are
 * produced by the REAL lifecycle gate driving the REAL subprocess plugin host running the REAL
 * `scan-result-control` against a loopback Trivy-shaped result. Nothing calls `loadScanFindings`.
 *
 * WHY `fetch` RATHER THAN THE SDK: `@scp/sdk`'s handwritten client exposes `controlRuns.listForChange`
 * and nothing else, and the generated `listControlRunFindings` is not re-exported from the package
 * index — so there is no SDK method to call today. That gap is real and worth naming: `apps/web` and
 * the CLI consume ONLY the SDK (charter principle 3), so until a wrapper lands this route has no
 * first-party consumer. These cases pin the HTTP surface the wrapper would sit on.
 *
 * WHAT THESE CASES DO NOT COVER, stated rather than glossed: the `unsupported` marker. It is produced
 * only by an OpenSCAP verdict, which arrives through the commander's managed scan step and not
 * through any bound ControlPlugin, so it cannot be reached over HTTP from here at all — it is pinned
 * at the producer in `scan-findings.integration.test.ts` (P2). `truncated` and ABSENT are both
 * reachable and both covered below, which is what makes "a non-`full` marker survives to the wire" a
 * measurement rather than an assumption.
 *
 * MUTATIONS RUN against this file (2026-08-18) — the MEASURED result, applied against a passing suite
 * and reverted by an exact inverse edit. Baseline: 5 passed. Nothing below is a prediction.
 *
 *   M-1  DELETE the whole `typed.route({ method: "GET", url: "/api/v1/control-runs/:id/findings" })`
 *        block from `routes/governance.ts`
 *          -> 5 failed here (F1-F5), all with `expected 404 to be 200`. AND: the server's ENTIRE unit
 *             suite stayed green under the same deletion — 81 files, 1173 tests — which is the
 *             measurement this file exists for. `packages/schemas/src/governance.test.ts` pins the
 *             wire CONTRACT and `scan-findings.integration.test.ts` pins the repo function, and
 *             neither of them ever reaches the handler.
 *
 *             NOTE WHAT F3 WOULD HAVE DONE ALONE: its cross-org assertion is `404`, which is exactly
 *             what a deleted route answers, so the tenancy case is satisfied by the mutation. It dies
 *             only because of the positive control on the line above it — the OWNER reading their own
 *             run and getting 200. That control is not decoration; without it the tenancy case is a
 *             test that passes when the feature is absent.
 */

const OPERATOR_TOKEN = "m22-9-findings-read-operator-token-fixture";
const MATCH_DIGEST = "sha256:eeee888888888888888888888888888888888888888888888888888888888888";

interface TrivySource {
  url: string;
  close(): Promise<void>;
}

/**
 * Loopback-only Trivy fixture (never the internet). `?n=<count>` produces that many synthetic HIGH
 * findings — the only way to reach `SCAN_FINDINGS_PERSIST_CAP` through the real plugin; `?fix=y,n`
 * controls per-finding `FixedVersion`, which is what makes one finding excludable by a
 * `no_fix_available` clause and its neighbour not.
 */
async function startTrivySource(): Promise<TrivySource> {
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bulk = Number(url.searchParams.get("n") ?? "0");
    const cve = (url.searchParams.get("cve") ?? "").split(",").filter(Boolean);
    const pkg = (url.searchParams.get("pkg") ?? "").split(",");
    const fix = (url.searchParams.get("fix") ?? "").split(",");
    const severity = url.searchParams.get("severity") ?? "LOW";
    const vulnerabilities =
      bulk > 0
        ? Array.from({ length: bulk }, (_, i) => ({
            VulnerabilityID: `CVE-2026-${100000 + i}`,
            PkgName: `pkg${i}`,
            Severity: severity,
            FixedVersion: "9.9.9"
          }))
        : cve.map((id, i) => ({
            VulnerabilityID: id,
            PkgName: pkg[i] || `pkg${i}`,
            Severity: severity,
            ...(fix[i] === "n" ? {} : { FixedVersion: "9.9.9" })
          }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        SchemaVersion: 2,
        ArtifactName: "registry.test/app:1.0",
        ArtifactType: "container_image",
        Metadata: { RepoDigests: [`registry.test/app@${MATCH_DIGEST}`], ImageID: MATCH_DIGEST },
        Results: [
          {
            Target: "registry.test/app:1.0 (alpine 3.19)",
            Class: "os-pkgs",
            Vulnerabilities: vulnerabilities
          }
        ]
      })
    );
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/scan`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

interface WebhookSource {
  url: string;
  close(): Promise<void>;
}

/** The `webhook-control` escape hatch's endpoint — a control that PASSES while producing evidence
 *  that is not a scan verdict at all. The only way to reach the ABSENT marker over HTTP. */
async function startWebhookSource(): Promise<WebhookSource> {
  const httpServer = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "pass", evidence: { via: "test-webhook" } }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

describe("M22.9: GET /control-runs/{id}/findings, over real HTTP", () => {
  let server: ListeningTestServer;
  let trivy: TrivySource;
  let webhook: WebhookSource;
  let adminPool: pg.Pool;
  let operator: ScpClient;

  beforeAll(async () => {
    [trivy, webhook] = await Promise.all([startTrivySource(), startWebhookSource()]);
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      operatorToken: OPERATOR_TOKEN,
      pluginHostOptions: {
        callTimeoutMs: 20_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    adminPool = new pg.Pool({ connectionString: testDatabaseUrl() });
    const bootstrap = await createTestOrg(server, "findings-read-operator");
    operator = new ScpClient({ baseUrl: server.baseUrl, token: bootstrap.adminToken });
  }, 180_000);

  /** Instance-scoped `scan_exclusion_admissions` rows are GLOBAL to the deployment — cleared in an
   *  `afterEach` that runs regardless of outcome, and once more at teardown, so a row left behind
   *  cannot silently admit loosenings for anything that later shares this database. */
  async function clearInstanceAdmissions() {
    await adminPool?.query("DELETE FROM scan_exclusion_admissions").catch(() => undefined);
  }

  afterEach(clearInstanceAdmissions);

  afterAll(async () => {
    await clearInstanceAdmissions();
    await adminPool?.end();
    await server?.close();
    await trivy?.close();
    await webhook?.close();
  });

  // -----------------------------------------------------------------------------------------
  // The route under test — spoken to as a client would, with no SDK in the way.
  // -----------------------------------------------------------------------------------------

  async function getFindings(
    token: string | null,
    controlRunId: string,
    query: Record<string, string> = {}
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const qs = new URLSearchParams(query).toString();
    // `baseUrl` ALREADY carries the `/api/v1` prefix (test-support/harness.ts) — repeating it here
    // produces a 404 from Fastify's router that is indistinguishable from the route being absent,
    // which is exactly the reading this file exists to make trustworthy.
    const response = await fetch(
      `${server.baseUrl}/control-runs/${controlRunId}/findings${qs ? `?${qs}` : ""}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // -----------------------------------------------------------------------------------------
  // Fixtures — the M22.9 admission write door and the real gate.
  // -----------------------------------------------------------------------------------------

  async function admitAtInstance(cls: string) {
    for (const tier of ["platform", "trust_domain"] as const) {
      const current = await operator.instanceScanExclusionAdmissions.list();
      const classes = new Set(
        current.filter((a) => a.tier === tier && a.origin === "local").map((a) => a.class)
      );
      classes.add(cls as (typeof current)[number]["class"]);
      await operator.instanceScanExclusionAdmissions.put(
        tier,
        { origin: "local", classes: [...classes] },
        OPERATOR_TOKEN
      );
    }
  }

  async function orgWithComponent(label: string) {
    const org = await createTestOrg(server, label);
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const containmentDomain = await admin.object("domain").create({ name: `dom-${label}` });
    const service = await admin
      .object("service")
      .create({ name: `svc-${label}`, domainId: containmentDomain.id });
    const component = await createOrphanComponent(server, org, `comp-${label}`);
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    return { org, admin, component };
  }

  /** A real control bound to the real `scan-result-control`, pointed at the loopback fixture. */
  async function scanControl(
    admin: ScpClient,
    org: TestOrg,
    opts: { suffix: string; params: Record<string, string> }
  ) {
    const control = await admin.controls.create({
      name: `scan-control-${opts.suffix}`,
      urn: `urn:scp:${org.orgId}:control:${opts.suffix}`,
      properties: { category: "security" }
    });
    await admin.controls.putBinding(control.id, {
      pluginModule: "scan-result-control",
      pluginInstanceId: `scan-${control.id}`,
      config: {
        url: `${trivy.url}?${new URLSearchParams(opts.params).toString()}`,
        expectedDigest: MATCH_DIGEST
      }
    });
    return control;
  }

  async function requireControl(
    admin: ScpClient,
    name: string,
    scopeObjectId: string,
    controlId: string
  ) {
    return admin.policies.create({
      name,
      properties: {
        scope: { objectRef: scopeObjectId },
        enforcement: "required",
        effects: [{ requireControls: [controlId] }]
      }
    });
  }

  async function waitForControlRun(
    admin: ScpClient,
    changeId: string,
    controlId: string,
    status: "pass" | "fail"
  ) {
    return waitUntil(
      async () => {
        const matching = (await admin.controlRuns.listForChange(changeId)).items
          .filter((r) => r.controlObjectId === controlId && r.status === status)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return matching[0];
      },
      { describe: `control ${controlId} on ${changeId} reports '${status}'`, timeoutMs: 30_000 }
    );
  }

  it("F1: the persisted decomposition of a REAL gate's scan verdict is readable, with the retention class the write decided", async () => {
    // THE ROUTE'S REASON TO EXIST. `SCAN_EXCLUSION_EVIDENCE_CAP` (100) bounds the per-clause
    // enumeration on `evidence.exclusions.applied` while `appliedCount` stays EXACT, so past 100
    // exclusions these class-`E` rows are the ONLY per-finding record of what an operator chose to
    // tolerate (ADR-0033 D10, charter principle 6). A run whose findings are all class `O` would not
    // show that, which is why this fixture excludes one of the two.
    await admitAtInstance("no_fix_available");
    const { org, admin, component } = await orgWithComponent("findings-read");

    await admin.policies.create({
      name: "clause-read",
      properties: {
        scope: { objectRef: org.orgId },
        enforcement: "advisory",
        effects: [
          { scanExclusion: { exclude: { class: "no_fix_available" } } },
          // M22.8 — a scan rule that requires no scan control is refused at the authoring door. The
          // reference is DANGLING on purpose (see the constant's own doc): a real bound control here
          // would add a second control run and change which run this case is about.
          { requireControls: [SCAN_RULE_TEST_CONTROL_REF] }
        ]
      }
    });

    // Two LOW findings so the verdict is decided by nothing this case cares about: `zlib` HAS a fix
    // (ordinary, class O), `openssl` does not (excluded, class E).
    const control = await scanControl(admin, org, {
      suffix: "findings-read",
      params: { cve: "CVE-2026-8001,CVE-2026-8002", pkg: "zlib,openssl", fix: "y,n" }
    });
    await requireControl(admin, "gate-read", component.id, control.id);

    const change = await admin.changes.propose({ name: "findings-read", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    expect((run.evidence as unknown as ScanEvidence).exclusions?.appliedCount).toBe(1);

    const { status, body } = await getFindings(org.adminToken, run.id);
    expect(status).toBe(200);
    // THE MARKER, on the wire and not merely in the evidence. `full` is the only state under which a
    // consumer may treat the rows below as the set the scanner produced.
    expect(body.findingsRecord).toBe("full");
    expect(body.nextCursor).toBeNull();
    const items = body.items as Record<string, unknown>[];
    expect(items.map((f) => f.vulnerabilityId)).toEqual(["CVE-2026-8001", "CVE-2026-8002"]);
    // ORDINAL is the finding's identity — it has no other one — and it is the paging key in F2.
    expect(items.map((f) => f.ordinal)).toEqual([0, 1]);
    // ...and the two facts only the WRITE knew. `E` is the accepted-risk row.
    expect(items.map((f) => f.retentionClass)).toEqual(["O", "E"]);
    expect(items[1]).toMatchObject({ pkgName: "openssl", severity: "low" });
    // ABSENCE SURVIVES AS ABSENCE. `fixedVersion` is the field the `no_fix_available` clause matched
    // on, and the row that has none omits the key rather than sending `null` — `ScanFindingSchema`'s
    // attribution fields are `.optional()` and never nullable, so a `null` would fail the response
    // schema (`toPersistedScanFinding` drops them for exactly that reason). A consumer that read
    // `fixedVersion === null` as "no fix" would be reading a key that is never sent.
    expect(items[1]).not.toHaveProperty("fixedVersion");
    expect(items[0]).toMatchObject({ pkgName: "zlib", fixedVersion: "9.9.9" });
  });

  it("F2: the route PAGES by ordinal, and every page carries the marker", async () => {
    // PAGING IS NOT OPTIONAL on this surface: `SCAN_FINDINGS_PERSIST_CAP` is 2000 rows per run and
    // M22.0a made several runs per change the norm. Driven at `limit=1` over a two-row set rather
    // than over a large one, because what needs proving is that the cursor ADVANCES and TERMINATES,
    // and a 2000-row walk would prove the same thing 1000 times more slowly.
    //
    // THE MARKER ON THE SECOND PAGE is the assertion that is easy to omit and matters most: a
    // consumer that pages sees `findingsRecord` on the first response and would otherwise have to
    // remember it — and `ControlRunFindingsResponseSchema` makes it required precisely so no page can
    // be read without it.
    const { org, admin, component } = await orgWithComponent("findings-page");
    const control = await scanControl(admin, org, {
      suffix: "findings-page",
      params: { cve: "CVE-2026-8101,CVE-2026-8102", pkg: "zlib,openssl", fix: "y,y" }
    });
    await requireControl(admin, "gate-page", component.id, control.id);
    const change = await admin.changes.propose({ name: "findings-page", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");

    const first = await getFindings(org.adminToken, run.id, { limit: "1" });
    expect(first.status).toBe(200);
    expect((first.body.items as unknown[]).length).toBe(1);
    expect(first.body.findingsRecord).toBe("full");
    expect(first.body.nextCursor).toBeTruthy();

    const second = await getFindings(org.adminToken, run.id, {
      limit: "1",
      cursor: first.body.nextCursor as string
    });
    expect(second.status).toBe(200);
    const secondItems = second.body.items as Record<string, unknown>[];
    expect(secondItems.map((f) => f.ordinal)).toEqual([1]);
    expect(second.body.findingsRecord).toBe("full");

    // TERMINATION, and it costs no extra round trip: `loadScanFindings` reads `limit + 1` rows, so the
    // page that returns the last row already knows there is no next one. A `nextCursor` that stayed
    // truthy here would hand an SDK `listAll*` iterator an empty page forever.
    expect(second.body.nextCursor).toBeNull();

    // A MALFORMED CURSOR PAGES FROM THE START rather than throwing — the same deliberate choice
    // `decodeSeqCursor` makes in `audit-repo.ts`. It cannot loop an iterator, because `ordinal` is a
    // total order with no ties and the keyset comparison is strictly `>`. Pinned because "restart"
    // and "400" are both defensible and only one of them is what this route does.
    const garbage = await getFindings(org.adminToken, run.id, {
      limit: "1",
      cursor: "not-a-cursor"
    });
    expect(garbage.status).toBe(200);
    expect((garbage.body.items as Record<string, unknown>[]).map((f) => f.ordinal)).toEqual([0]);

    // THE CAP IS ENFORCED BY THE ROUTE, not left to the caller: `CursorPageQuerySchema` maxes `limit`
    // at 100, so the only unbounded read of a 2000-row set is one the server refuses.
    const overLimit = await getFindings(org.adminToken, run.id, { limit: "101" });
    expect(overLimit.status).toBe(400);
  });

  it("F3: a run belonging to ANOTHER org is not readable — and neither is anything without a token", async () => {
    // TENANCY, at the route rather than at the repo. `loadScanFindings` scopes on `org_id`, so a
    // cross-org read is a 404 (not a 403): the id does not name anything this tenant can see, and
    // saying "forbidden" would confirm the run exists.
    const owner = await orgWithComponent("findings-mine");
    const control = await scanControl(owner.admin, owner.org, {
      suffix: "findings-mine",
      params: { cve: "CVE-2026-8201", pkg: "zlib", fix: "y" }
    });
    await requireControl(owner.admin, "gate-mine", owner.component.id, control.id);
    const change = await owner.admin.changes.propose({
      name: "findings-mine",
      targets: [owner.component.id]
    });
    const run = await waitForControlRun(owner.admin, change.id, control.id, "pass");

    // The owner can read it — without this line a route that 404'd for EVERYONE would satisfy the
    // assertion below and mean nothing.
    expect((await getFindings(owner.org.adminToken, run.id)).status).toBe(200);

    const stranger = await createTestOrg(server, "findings-stranger");
    const crossOrg = await getFindings(stranger.adminToken, run.id);
    expect(crossOrg.status).toBe(404);
    expect(JSON.stringify(crossOrg.body)).not.toContain("CVE-2026-8201");

    expect((await getFindings(null, run.id)).status).toBe(401);
    // A well-formed uuid that names nothing is the same 404, so an absent run and another tenant's
    // run are indistinguishable from outside.
    expect(
      (await getFindings(owner.org.adminToken, "00000000-0000-4000-8000-000000000000")).status
    ).toBe(404);
  });

  it("F4: a NON-scan control's run answers `findingsRecord: null` — the ABSENT state, said positively", async () => {
    // THE STATE A BARE ARRAY CANNOT EXPRESS. `webhook-control` returns `status` and `evidence`
    // verbatim from an operator-configured endpoint, so its run is a real, passing control outcome
    // whose evidence is not a scan verdict — the same shape every pre-M22.1b run has. A consumer that
    // read `items: []` and stopped would conclude "this scan found nothing"; the `null` says "there
    // is no finding set here at all, and no exclusion can apply".
    const { org, admin, component } = await orgWithComponent("findings-absent");
    const control = await admin.controls.create({
      name: "webhook-control-absent",
      urn: `urn:scp:${org.orgId}:control:findings-absent`,
      properties: { category: "security" }
    });
    await admin.controls.putBinding(control.id, {
      pluginModule: "webhook-control",
      pluginInstanceId: `wh-${control.id}`,
      config: { url: webhook.url }
    });
    await requireControl(admin, "gate-absent", component.id, control.id);

    const change = await admin.changes.propose({
      name: "findings-absent",
      targets: [component.id]
    });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");

    const { status, body } = await getFindings(org.adminToken, run.id);
    expect(status).toBe(200);
    // REQUIRED-and-nullable, never omitted: an absent key would be indistinguishable from a client
    // too old to know it, which is the ambiguity the field exists to remove.
    expect(Object.keys(body)).toContain("findingsRecord");
    expect(body.findingsRecord).toBeNull();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("F5: a set over the cap reports `truncated` on the wire, and the rows stop at the cap", async () => {
    // THE OTHER NON-`full` MARKER, and the reason it has to reach the wire: `truncated` REFUSES every
    // exclusion for this scan ("you cannot except what you did not record", ADR-0033 §7). A caller
    // handed 2000 rows with no marker would read a partial set as the whole one — and would read the
    // absence of class-`E` rows as "nothing was tolerated" rather than "nothing COULD be".
    const { org, admin, component } = await orgWithComponent("findings-trunc");
    const control = await scanControl(admin, org, {
      suffix: "findings-trunc",
      // One more than the cap, at LOW severity so the verdict is not what this case measures.
      params: { n: String(SCAN_FINDINGS_PERSIST_CAP + 1), severity: "LOW" }
    });
    await requireControl(admin, "gate-trunc", component.id, control.id);
    const change = await admin.changes.propose({ name: "findings-trunc", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");
    // The CAP bounds what is PERSISTED; it never moves what the scanner found.
    expect((run.evidence as unknown as ScanEvidence).severityCounts.low).toBe(
      SCAN_FINDINGS_PERSIST_CAP + 1
    );

    const { status, body } = await getFindings(org.adminToken, run.id, { limit: "100" });
    expect(status).toBe(200);
    expect(body.findingsRecord).toBe("truncated");
    expect((body.items as unknown[]).length).toBe(100);
    expect(body.nextCursor).toBeTruthy();

    // WALKED TO THE END over the wire, rather than jumping there with the server's own cursor codec:
    // the point is that the cursor a CLIENT is handed advances and terminates, and importing
    // `encodeOrdinalCursor` to skip ahead would test the codec against itself. Bounded so a
    // non-advancing cursor fails as a loop-guard rather than hanging the suite.
    let cursor = body.nextCursor as string | null;
    let seen = (body.items as unknown[]).length;
    let lastOrdinal = -1;
    for (let page = 0; page < 40 && cursor; page += 1) {
      const next = await getFindings(org.adminToken, run.id, { limit: "100", cursor });
      expect(next.status).toBe(200);
      // EVERY page, not just the first — see F2.
      expect(next.body.findingsRecord).toBe("truncated");
      const rows = next.body.items as Record<string, unknown>[];
      seen += rows.length;
      if (rows.length > 0) lastOrdinal = rows[rows.length - 1]!.ordinal as number;
      cursor = next.body.nextCursor as string | null;
    }
    // The rows stop AT the cap — one short of what the scanner reported, which is the whole claim
    // `truncated` is making.
    expect(seen).toBe(SCAN_FINDINGS_PERSIST_CAP);
    expect(lastOrdinal).toBe(SCAN_FINDINGS_PERSIST_CAP - 1);
    expect(cursor).toBeNull();
  });

  it("F6: the SDK wrapper reaches the same route — API/SDK parity, not just an API", async () => {
    // CHARTER PRINCIPLE 3: every capability is API -> SDK -> CLI -> IaC -> UI, and the UI and CLI
    // consume ONLY the generated SDK. A route with no client wrapper therefore has no first-party
    // consumer, which is how a surface ships complete-on-paper and unreachable in practice — the
    // exact shape M22.9's admission door already shipped in once.
    //
    // Every other case here speaks raw `fetch` ON PURPOSE, so that a 404 means "the route is not
    // registered" rather than "the wrapper is wrong". This one is the opposite question, and it is
    // the only case in the file that can answer it: the wrapper was added AFTER the route, and an
    // unexercised wrapper is the same defect class one layer up.
    await admitAtInstance("no_fix_available");
    const { org, admin, component } = await orgWithComponent("findings-sdk");

    const control = await scanControl(admin, org, {
      suffix: "findings-sdk",
      params: { cve: "CVE-2026-8401,CVE-2026-8402", pkg: "zlib,openssl", fix: "y,n" }
    });
    await requireControl(admin, "gate-sdk", component.id, control.id);
    const change = await admin.changes.propose({ name: "findings-sdk", targets: [component.id] });
    const run = await waitForControlRun(admin, change.id, control.id, "pass");

    const viaSdk = await admin.controlRuns.findings(run.id);
    // THE MARKER COMES BACK THROUGH THE WRAPPER. If `findings()` returned only the rows — the shape
    // `scan-findings-repo.ts` explicitly refuses to hand out — a consumer could never learn that a
    // `truncated` set had every exclusion refused, and would read an empty `items` as "nothing was
    // excluded". Asserting it here is what stops the wrapper being narrowed to a bare array later.
    expect(viaSdk.findingsRecord).toBe("full");
    expect(viaSdk.nextCursor).toBeNull();
    expect(viaSdk.items.map((f) => f.vulnerabilityId)).toEqual(["CVE-2026-8401", "CVE-2026-8402"]);

    // ...and it is the SAME answer the raw route gives. Two readings that disagreed would mean the
    // wrapper had acquired semantics of its own, which is precisely what principle 3 forbids.
    const raw = await getFindings(org.adminToken, run.id);
    expect(raw.status).toBe(200);
    expect(viaSdk.items.length).toBe((raw.body.items as unknown[]).length);
    expect(viaSdk.findingsRecord).toBe(raw.body.findingsRecord);

    // The paging parameter is threaded rather than swallowed — `limit` is the one argument a caller
    // can pass, so a wrapper that dropped it would page silently wrong.
    const firstOnly = await admin.controlRuns.findings(run.id, { limit: 1 });
    expect(firstOnly.items).toHaveLength(1);
    expect(firstOnly.nextCursor).not.toBeNull();
  });
});

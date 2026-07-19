import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Governance engine integration suite (BUILD_AND_TEST.md §8 M4 DoD, Testcontainers postgres:16):
 * everything the unit suite (policy-model.test.ts, evaluate.test.ts, cel-sandbox.test.ts) can't
 * reach because it needs a real graph (containment, `member_of`), a real subprocess plugin host
 * (webhook-control, fake-executor), and the real gate seam (coordination/gates.ts) wired through
 * the real HTTP API. Every scenario drives the public API via `@scp/sdk`'s `ScpClient`, exactly
 * like a real caller — this is deliberately NOT a white-box test of governance/*.ts's internals
 * (those are the unit suite's job).
 *
 * Most scenarios share ONE server (module-level `beforeAll`/`afterAll`) — real Postgres, real
 * outbox relay, real reconcile loop, real subprocess plugin host — to amortize boot cost, same
 * pattern as coordination.integration.test.ts. The automatic-rollback scenario gets its own server
 * because it needs `FakeExecutorConfig.forcePhase` pre-configured at plugin-instance boot time for
 * specific, test-known target object ids (harness.ts's `fakeExecutorConfig` passthrough, added for
 * exactly this).
 */

// -----------------------------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------------------------

interface TestWebhookServer {
  url: string;
  close(): Promise<void>;
}

/** A real HTTP server on loopback (never the internet — BUILD_AND_TEST.md's "tests never touch
 *  the internet" is about egress off the test host, not inter-process loopback calls the way
 *  Testcontainers Postgres itself already is) that `@scp/plugin-webhook-control` — running for
 *  real inside a spawned subprocess — POSTs to. Responds with whatever `ControlOutcomeStatus` the
 *  caller asked for via the `x-test-outcome` request header (set per `control_bindings.config`),
 *  so ONE server fixture can back many differently-configured control bindings across many tests. */
async function startTestWebhookServer(): Promise<TestWebhookServer> {
  const server = createServer((req, res) => {
    const outcome = (req.headers["x-test-outcome"] as string | undefined) ?? "pass";
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let controlId: string | null = null;
      try {
        controlId = (JSON.parse(raw || "{}") as { controlId?: string }).controlId ?? null;
      } catch {
        // malformed body — evidence just omits controlId, not a test failure
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: outcome, evidence: { via: "test-webhook", controlId } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}

async function expectApiError(fn: () => Promise<unknown>): Promise<ScpApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ScpApiError) return err;
    throw err;
  }
  throw new Error("expected the call to throw an ScpApiError, but it completed successfully");
}

interface PolicyEffectsInput {
  requireControlIds?: string[];
  requireApprovals?: { count: number; fromRole: string; scope: string };
}

interface CreatePolicyOpts extends PolicyEffectsInput {
  name: string;
  urnSuffix: string;
  enforcement: "advisory" | "recommended" | "required";
  scopeObjectId?: string;
  scopeGroupId?: string;
  condition?: string;
  emergencyPolicy?: boolean;
  autoRollbackOnFailure?: boolean;
}

/** A `policy`-typed graph object (DESIGN §10.1) via the real typed-registry API — every test below
 *  builds its policy documents this way rather than poking the DB directly, so the Ajv property
 *  validation path (0010_governance.sql's JSON Schema) is exercised too. */
async function createPolicy(admin: ScpClient, org: TestOrg, opts: CreatePolicyOpts) {
  const effects: Record<string, unknown>[] = [];
  if (opts.requireControlIds && opts.requireControlIds.length > 0) {
    effects.push({ requireControls: opts.requireControlIds });
  }
  if (opts.requireApprovals) {
    effects.push({ requireApprovals: opts.requireApprovals });
  }
  const scope = opts.scopeObjectId
    ? { objectRef: opts.scopeObjectId }
    : opts.scopeGroupId
      ? { group: opts.scopeGroupId }
      : undefined;
  return admin.policies.create({
    name: opts.name,
    urn: `urn:scp:${org.orgId}:policy:${opts.urnSuffix}`,
    properties: {
      ...(scope ? { scope } : {}),
      enforcement: opts.enforcement,
      ...(opts.condition ? { condition: opts.condition } : {}),
      effects,
      ...(opts.emergencyPolicy !== undefined ? { emergencyPolicy: opts.emergencyPolicy } : {}),
      ...(opts.autoRollbackOnFailure !== undefined ? { autoRollbackOnFailure: opts.autoRollbackOnFailure } : {})
    }
  });
}

/** A real `control` graph object bound to the real `webhook-control` plugin (DESIGN §10.2's
 *  escape hatch), pointed at `startTestWebhookServer()`'s fixture with a fixed canned outcome —
 *  the ONE real ControlPlugin module `governance/control-runner.ts` will provision a subprocess
 *  instance for (see its `KNOWN_CONTROL_MODULES` doc comment). */
async function createWebhookControl(
  admin: ScpClient,
  org: TestOrg,
  opts: { urnSuffix: string; webhookUrl: string; outcome: string }
) {
  const control = await admin.controls.create({
    name: `control-${opts.urnSuffix}`,
    urn: `urn:scp:${org.orgId}:control:${opts.urnSuffix}`,
    properties: { category: "security" }
  });
  await admin.controls.putBinding(control.id, {
    pluginModule: "webhook-control",
    pluginInstanceId: `wh-${control.id}`,
    config: { url: opts.webhookUrl, headers: { "x-test-outcome": opts.outcome } }
  });
  return control;
}

async function waitForValidating(admin: ScpClient, changeId: string, timeoutMs = 25_000) {
  return waitUntil(async () => (await admin.changes.get(changeId)).state === "validating" || undefined, {
    describe: `change ${changeId} reaches 'validating'`,
    timeoutMs
  });
}

/** A required policy scoped directly to a change's own (single) target ALSO gates that target's
 *  wave boundary, not just the `validating->promoted` lifecycle edge (coordination/gates.ts's
 *  module doc: every wave boundary is real-governance-evaluated in M4, unlike most other
 *  lifecycle edges) — so `requireControls`/`requireApprovals` effects on such a policy resolve
 *  (control runs for real; approval requests materialize) from wave 0's FIRST gate check, well
 *  before — and independently of — the change ever reaching `validating`. This is the right place
 *  to wait for an approval request in tests below, instead of `waitForValidating` (which the wave
 *  gate blocking would make this policy's own approval/control effects prevent from ever firing). */
async function waitForApprovalRequest(admin: ScpClient, changeId: string, timeoutMs = 25_000) {
  return waitUntil(
    async () => {
      const page = await admin.approvals.list({ changeId, limit: 20 });
      return page.items[0];
    },
    { describe: `approval request materialized for change ${changeId}`, timeoutMs }
  );
}

async function waitForControlRun(
  admin: ScpClient,
  changeId: string,
  controlId: string,
  status: string,
  timeoutMs = 25_000
) {
  return waitUntil(
    async () => {
      const runs = await admin.controlRuns.listForChange(changeId);
      const run = runs.items.find((r) => r.controlObjectId === controlId);
      return run?.status === status ? run : undefined;
    },
    { describe: `control ${controlId} run on change ${changeId} reports '${status}'`, timeoutMs }
  );
}

/** Asserts a change has NOT progressed past `executing` after a grace period long enough for
 *  several reconcile ticks (1s interval) to have had their chance — the direct way to observe "the
 *  wave stayed blocked" without racing the reconcile loop's own timing. */
async function assertStaysExecuting(admin: ScpClient, changeId: string, graceMs = 3_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  const change = await admin.changes.get(changeId);
  expect(change.state).toBe("executing");
}

// -----------------------------------------------------------------------------------------

describe("governance integration (real graph, real subprocess plugin host)", () => {
  let server: ListeningTestServer;
  let webhook: TestWebhookServer;

  beforeAll(async () => {
    webhook = await startTestWebhookServer();
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 15_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 }
    });
  });

  afterAll(async () => {
    await server.close();
    await webhook.close();
  });

  // -----------------------------------------------------------------------------------------
  // Stricter-wins resolution matrix (org/domain/service/component conflicts) — real containment
  // walk (policy-resolve.ts) + real merge (policy-model.ts), through `scp policy evaluate`'s
  // dry-run endpoint. The pure-merge algorithm itself is exhaustively table/property-tested in
  // policy-model.test.ts; this proves the DB-driven "gather" half actually feeds it correctly.
  // -----------------------------------------------------------------------------------------

  it("resolves a 4-level org->domain->service->component chain: required wins over an attempted domain-level weaken, controls union, non-sibling policies never leak in", async () => {
    const org = await createTestOrg(server, "stricter-wins");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "sw-domain" });
    const siblingDomain = await admin.domains.create({ name: "sw-sibling-domain" });
    const service = await admin.services.create({ name: "sw-service", domainId: domain.id });
    const component = await createTestComponent(admin, { name: "sw-component", domainId: service.id });

    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "org",
      enforcement: "required",
      scopeObjectId: org.orgId,
      requireControlIds: ["org-control"]
    });
    await createPolicy(admin, org, {
      // Attempts to WEAKEN the org-level 'required' down to 'advisory' at the domain level — must
      // never succeed (policy-model.ts's "no weaken effect exists in this schema").
      name: "prod-security",
      urnSuffix: "domain",
      enforcement: "advisory",
      scopeObjectId: domain.id,
      requireControlIds: ["domain-control"]
    });
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "service",
      enforcement: "recommended",
      scopeObjectId: service.id,
      requireControlIds: ["service-control"]
    });
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "component",
      enforcement: "required",
      scopeObjectId: component.id,
      requireControlIds: ["component-control"]
    });
    // A policy scoped to a SIBLING domain (not in component's containment chain) must never match.
    await createPolicy(admin, org, {
      name: "unrelated-sibling-policy",
      urnSuffix: "sibling",
      enforcement: "required",
      scopeObjectId: siblingDomain.id,
      requireControlIds: ["sibling-control"]
    });

    const change = await admin.changes.propose({ name: "sw-change", targets: [component.id] });
    const result = await admin.policyEvaluate(change.id);

    const policies = (result.reasonTree as { policies: Array<Record<string, unknown>> }).policies;
    expect(policies.some((p) => p.name === "unrelated-sibling-policy")).toBe(false);

    const entry = policies.find((p) => p.name === "prod-security");
    expect(entry).toBeDefined();
    expect(entry!.enforcement).toBe("required"); // never weakened by the domain-level 'advisory'

    const controlIds = (entry!.effects as Array<{ kind: string; detail: Record<string, unknown> }>)
      .filter((e) => e.kind === "requireControls")
      .map((e) => e.detail.controlObjectId as string)
      .sort();
    expect(controlIds).toEqual(["component-control", "domain-control", "org-control", "service-control"]);
    expect((entry!.contributingPolicyVersions as unknown[]).length).toBe(4);

    // Required + none of the 4 controls has ever run -> blocks (fails closed, never a silent pass).
    expect(result.verdict).toBe("block");

    // This change's `requireControls` reference synthetic (non-object) ids on purpose — this test
    // only cares about resolution, never about a real control actually running — so its
    // wave-boundary gate can never satisfy them. Cancel it rather than leaving it to occupy the
    // shared reconcile loop's every-tick attention (and the resulting per-tick 'blocked' Decision
    // inserts) for the remaining lifetime of this describe block's server.
    await admin.changes.cancel(change.id, "test cleanup: resolution-only fixture, never meant to execute");
  });

  // -----------------------------------------------------------------------------------------
  // CRITICAL #1a (adversarial review): a lower-scope same-named policy with a FALSE/broken
  // condition must NOT neutralize a higher-scope required policy's effects. The pre-fix evaluator
  // ANDed every contributor's condition, so one false condition zeroed the whole merged policy.
  // -----------------------------------------------------------------------------------------

  it("a second same-named policy with a FALSE condition does NOT weaken a higher-scope required policy — the required control still gates (block persists)", async () => {
    const org = await createTestOrg(server, "condition-bypass");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "cb-domain" });
    const component = await createTestComponent(admin, { name: "cb-component", domainId: domain.id });
    const realControl = await createWebhookControl(admin, org, {
      urnSuffix: "cb-real-scan",
      webhookUrl: webhook.url,
      outcome: "pass"
    });

    // Org-level REQUIRED, unconditional, requiring a real (satisfiable) control.
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "cb-org",
      enforcement: "required",
      scopeObjectId: org.orgId,
      requireControlIds: [realControl.id]
    });
    // A second same-named policy scoped to the component with an always-false condition and no
    // controls — the "neutralizer". Must NOT drop the org's required control.
    await createPolicy(admin, org, {
      name: "prod-security",
      urnSuffix: "cb-neutralizer",
      enforcement: "advisory",
      scopeObjectId: component.id,
      condition: "1 == 2"
    });

    const change = await admin.changes.propose({ name: "cb-change", targets: [component.id] });

    // Before the control passes, the gate must BLOCK (the org required control is unsatisfied) —
    // i.e. the false-condition contributor did NOT neutralize it. Assert via a dry-run evaluate
    // that the required control effect is present and unsatisfied.
    const evalResult = await admin.policyEvaluate(change.id);
    const entry = (evalResult.reasonTree as { policies: Array<Record<string, unknown>> }).policies.find(
      (p) => p.name === "prod-security"
    );
    expect(entry).toBeDefined();
    expect(entry!.fired).toBe(true);
    expect(entry!.enforcement).toBe("required");
    const realControlEffect = (
      entry!.effects as Array<{ kind: string; detail: Record<string, unknown> }>
    ).find((e) => e.kind === "requireControls" && e.detail.controlObjectId === realControl.id);
    expect(realControlEffect).toBeDefined();

    // And end-to-end: the change only reaches 'validating' once the REAL required control passes
    // (proving the required effect genuinely gated the wave, not silently dropped). The control
    // returns pass, so it eventually clears.
    await waitForControlRun(admin, change.id, realControl.id, "pass");
    await waitForValidating(admin, change.id);
    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // CRITICAL #1b (adversarial review): a policy's DECLARED scope is bound to the author's own
  // `policy:write` authority — a component-scoped author cannot publish an org-wide (or
  // higher-scope) policy, which was the planting vector that made #1a exploitable.
  // -----------------------------------------------------------------------------------------

  it("a component-scoped policy author cannot declare an org-wide (or org-root-scoped) policy — only one bounded to their own component", async () => {
    const org = await createTestOrg(server, "scope-authority");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "sa-domain" });
    const component = await createTestComponent(admin, { name: "sa-component", domainId: domain.id });

    // Administrator holds 'policy:write' (M4 migration) — bind it at the COMPONENT only, so this
    // author's policy authority is exactly that component and below.
    const author = await createTestUser(server, org, [{ role: "Administrator", scope: component.id }]);
    const authorClient = new ScpClient({ baseUrl: server.baseUrl, token: author.token });

    // (a) org-wide (UNSCOPED) policy, even placed at their own component → 403 (needs org-root authority).
    const orgWide = await expectApiError(() =>
      authorClient.policies.create({
        name: "sneaky-org-wide",
        domainId: component.id,
        properties: { enforcement: "required", effects: [{ requireControls: ["x"] }] }
      })
    );
    expect(orgWide.status).toBe(403);

    // (b) a policy scoped to the ORG ROOT via objectRef → 403 (needs policy:write at org root).
    const orgScoped = await expectApiError(() =>
      authorClient.policies.create({
        name: "sneaky-org-scoped",
        domainId: component.id,
        properties: { scope: { objectRef: org.orgId }, enforcement: "required" }
      })
    );
    expect(orgScoped.status).toBe(403);

    // (c) a label-selector policy (org-wide blast radius) → 403.
    const selectorScoped = await expectApiError(() =>
      authorClient.policies.create({
        name: "sneaky-selector",
        domainId: component.id,
        properties: { scope: { selector: { labels: { env: "prod" } } }, enforcement: "required" }
      })
    );
    expect(selectorScoped.status).toBe(403);

    // (d) a policy scoped to their OWN component → allowed.
    const componentScoped = await authorClient.policies.create({
      name: "legit-component-policy",
      domainId: component.id,
      properties: { scope: { objectRef: component.id }, enforcement: "required" }
    });
    expect(componentScoped.id).toBeTruthy();

    // Sanity: the admin (org-root Owner) CAN still create an org-wide policy.
    const adminOrgWide = await admin.policies.create({
      name: "legit-org-wide",
      properties: { enforcement: "advisory" }
    });
    expect(adminOrgWide.id).toBeTruthy();
  });

  // -----------------------------------------------------------------------------------------
  // Security fast-follow after PR #9's adversarial review: CRITICAL #1b's scope-authority binding
  // was only wired into the TYPED `/policies` route. The generic `/objects/{type}` endpoint and
  // the IaC plan/apply path both create/mutate the exact same `policy`/`control` graph objects but
  // checked only generic `object:write` (never `policy:write`, never
  // `assertPolicyScopeWithinAuthority`) — a live governance bypass reachable by (a) a
  // component-scoped Administrator (the same actor the test above blocks on the typed route), and
  // (b) an Operator holding ZERO `policy:write` anywhere, planting an org-wide `required` policy
  // demanding an unreachable approval quorum (an org-wide governance DoS any non-Viewer role could
  // trigger).
  // -----------------------------------------------------------------------------------------

  it("the generic /api/v1/objects/policy (and /control) endpoint refuses every write verb — both exploits are blocked", async () => {
    const org = await createTestOrg(server, "generic-policy-bypass");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "gpb-domain" });
    const component = await createTestComponent(admin, { name: "gpb-component", domainId: domain.id });

    // Exploit (a): a component-scoped Administrator — holds 'policy:write' ONLY at `component` —
    // tries the generic endpoint instead of the typed route CRITICAL #1b already blocks.
    const author = await createTestUser(server, org, [{ role: "Administrator", scope: component.id }]);
    const authorClient = new ScpClient({ baseUrl: server.baseUrl, token: author.token });
    const exploitA = await expectApiError(() =>
      authorClient.object("policy").create({
        name: "sneaky-org-wide-via-generic",
        domainId: component.id,
        properties: { enforcement: "required", effects: [{ requireControls: ["x"] }] }
      })
    );
    expect(exploitA.status).toBe(403);

    // Exploit (b): an Operator holding ZERO 'policy:write' anywhere plants an org-wide `required`
    // policy demanding an unreachable approval quorum, via the generic endpoint.
    const operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const operatorClient = new ScpClient({ baseUrl: server.baseUrl, token: operator.token });
    const exploitB = await expectApiError(() =>
      operatorClient.object("policy").create({
        name: "dos-policy-via-generic",
        properties: {
          enforcement: "required",
          effects: [{ requireApprovals: { count: 99, fromRole: "NonexistentRole" } }]
        }
      })
    );
    expect(exploitB.status).toBe(403);

    // `control` gets the same treatment — the generic endpoint checked only `object:write`, never
    // `policy:write`, so even a plain Operator could fabricate a control definition.
    const exploitControl = await expectApiError(() =>
      operatorClient
        .object("control")
        .create({ name: "fake-control-via-generic", properties: { category: "security" } })
    );
    expect(exploitControl.status).toBe(403);

    // PATCH/PUT/DELETE are refused too, even for the ORG-ROOT OWNER who would otherwise have every
    // permission needed — proves this is an unconditional type-level block, not a permission gap.
    const legitPolicy = await admin.policies.create({
      name: "legit-for-generic-block-test",
      properties: { enforcement: "advisory" }
    });
    await expect(
      admin.object("policy").update(legitPolicy.id, { properties: { enforcement: "recommended" } })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      admin.object("policy").upsertByUrn(legitPolicy.urn, {
        name: legitPolicy.name,
        properties: { enforcement: "recommended" }
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("policy").delete(legitPolicy.id)).rejects.toMatchObject({ status: 403 });

    // The policy is untouched by any of the blocked calls — still 'advisory', still live.
    const stillLegit = await admin.policies.get(legitPolicy.id);
    expect(stillLegit.properties).toMatchObject({ enforcement: "advisory" });
  });

  it("IaC plan/apply enforces the same 'policy:write' + scope-authority binding as the typed route — a plain Operator's apply is blocked, and a component-scoped Administrator cannot smuggle an org-wide policy through a manifest", async () => {
    const org = await createTestOrg(server, "iac-policy-bypass");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const domain = await admin.domains.create({ name: "iac-pb-domain" });
    const component = await createTestComponent(admin, { name: "iac-pb-component", domainId: domain.id });

    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const policyUrn = `urn:scp:${stackName}:policy:evil`;
    // `domainId: component.id` on every variant here matters: it's what makes the object's own
    // CONTAINMENT check pass (the author genuinely holds 'policy:write' at `component`) so the
    // test isolates the DECLARED-scope-authority check specifically — exactly how the typed-route
    // CRITICAL #1b test above is built (it sets `domainId: component.id` on every attempt too).
    function manifestWithPolicy(scope?: Record<string, unknown>): DesiredStateManifest {
      return {
        stackName,
        objects: [
          {
            urn: policyUrn,
            typeId: "policy",
            name: "evil-policy-via-iac",
            domainId: component.id,
            properties: {
              ...(scope ? { scope } : {}),
              enforcement: "required",
              effects: [{ requireApprovals: { count: 99, fromRole: "NonexistentRole" } }]
            }
          }
        ],
        relationships: []
      };
    }

    // Exploit (b, via IaC): an Operator holding ZERO 'policy:write' anywhere plans and attempts to
    // apply an org-wide `required` policy. `POST /plans` (diff computation) only needs
    // `object:read`, so the plan itself computes fine — the block must land at apply time.
    const operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const operatorClient = new ScpClient({ baseUrl: server.baseUrl, token: operator.token });
    const opPlan = await operatorClient.plans.create(manifestWithPolicy());
    await expect(operatorClient.plans.apply(opPlan.id)).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("policy").get(policyUrn)).rejects.toMatchObject({ status: 404 });

    // Exploit (a, via IaC): a component-scoped Administrator (holds 'policy:write' ONLY at
    // `component`) tries an org-wide (unscoped) policy through a manifest apply. Also bound as a
    // Viewer at the ORG ROOT — `POST /plans` checks `object:read` at org root regardless of
    // manifest content (routes/plans.ts's own documented scope decision, unrelated to this fix),
    // so without this second binding the actor couldn't reach `/plans` at all and the test
    // wouldn't isolate the `policy:write`/scope-authority variable this fix is actually about.
    // Viewer grants no write permission of any kind, so the actor's WRITE authority stays exactly
    // 'policy:write' at `component` and nothing broader.
    const author = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Administrator", scope: component.id }
    ]);
    const authorClient = new ScpClient({ baseUrl: server.baseUrl, token: author.token });
    const orgWidePlan = await authorClient.plans.create(manifestWithPolicy());
    await expect(authorClient.plans.apply(orgWidePlan.id)).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("policy").get(policyUrn)).rejects.toMatchObject({ status: 404 });

    // Non-regression: the SAME author's apply succeeds for a policy scoped to their OWN component —
    // IaC still legitimately manages policy objects, just under the same authority binding the
    // typed route enforces.
    const scopedPlan = await authorClient.plans.create(manifestWithPolicy({ objectRef: component.id }));
    const { summary } = await authorClient.plans.apply(scopedPlan.id);
    expect(summary).toMatchObject({ creates: 1 });
    const created = await admin.object("policy").get(policyUrn);
    expect(created.properties).toMatchObject({ scope: { objectRef: component.id } });

    // `control` objects get the same 'policy:write' gate in the IaC path too (not just
    // 'object:write') — a plain Operator can't fabricate one through a manifest apply either.
    const controlStackName = `${stackName}-control`;
    const controlUrn = `urn:scp:${controlStackName}:control:fake`;
    const controlManifest: DesiredStateManifest = {
      stackName: controlStackName,
      objects: [
        {
          urn: controlUrn,
          typeId: "control",
          name: "fake-control-via-iac",
          properties: { category: "security" }
        }
      ],
      relationships: []
    };
    const controlPlan = await operatorClient.plans.create(controlManifest);
    await expect(operatorClient.plans.apply(controlPlan.id)).rejects.toMatchObject({ status: 403 });
    await expect(admin.object("control").get(controlUrn)).rejects.toMatchObject({ status: 404 });
  });

  // -----------------------------------------------------------------------------------------
  // Required control blocks promote; hybrid gate (scan AND approval — either missing blocks);
  // control outcomes + evidence persisted and referenced by the Decision (joined by
  // controlObjectId — see routes/changes.ts's explain handler / control_runs.decision_id's own
  // doc comment for why there's no raw FK).
  // -----------------------------------------------------------------------------------------

  describe("required control + hybrid gate (scan AND approval)", () => {
    it("hybrid: the control failing blocks the wave even though the approval is already satisfied — the change never leaves 'executing'", async () => {
      const org = await createTestOrg(server, "hybrid-control-fails");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
      const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });

      const target = await createTestComponent(admin, { name: "hybrid-fail-target" });
      const control = await createWebhookControl(admin, org, {
        urnSuffix: "hybrid-fail-scan",
        webhookUrl: webhook.url,
        outcome: "fail"
      });
      await createPolicy(admin, org, {
        name: "hybrid-release",
        urnSuffix: "hybrid-fail",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id],
        requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
      });

      const change = await admin.changes.propose({ name: "hybrid-fail-change", targets: [target.id] });

      // Satisfy the approval half up front — materializes from wave 0's own gate check, not from
      // 'validating' (see waitForApprovalRequest's doc comment).
      const approvalRequest = await waitForApprovalRequest(admin, change.id);
      await approverClient.approvals.vote(approvalRequest.id);
      const quorum = await admin.approvals.get(approvalRequest.id);
      expect(quorum.status).toBe("satisfied");

      // The control genuinely runs (real subprocess, real webhook POST) and reports 'fail'.
      await waitForControlRun(admin, change.id, control.id, "fail");

      // Approval satisfied, control failing -> hybrid still blocks: the wave can never start, so
      // the change can never even reach 'validating' for a 'promote' call to be a meaningful
      // re-test of this same gate — the wave's own blocked gate Decision is the real assertion.
      await assertStaysExecuting(admin, change.id);

      const explained = await admin.changes.explain(change.id);
      const gateBlock = explained.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
      expect(gateBlock).toBeDefined();
      const policyEntry = (
        (gateBlock!.reasonTree as { policies?: Array<Record<string, unknown>> }).policies ?? []
      ).find((p) => p.name === "hybrid-release");
      expect(policyEntry).toBeDefined();
      const controlEffect = (
        policyEntry!.effects as Array<{ kind: string; satisfied: boolean; detail: Record<string, unknown> }>
      ).find((e) => e.kind === "requireControls");
      expect(controlEffect?.satisfied).toBe(false);
      expect(controlEffect?.detail.outcome).toBe("fail");
    });

    it("hybrid: the control passing is not enough on its own — approval still gates promote; once both are satisfied promote succeeds and evidence is explainable", async () => {
      const org = await createTestOrg(server, "hybrid-approval-gates");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
      const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });

      const target = await createTestComponent(admin, { name: "hybrid-pass-target" });
      const control = await createWebhookControl(admin, org, {
        urnSuffix: "hybrid-pass-scan",
        webhookUrl: webhook.url,
        outcome: "pass"
      });
      await createPolicy(admin, org, {
        name: "hybrid-release",
        urnSuffix: "hybrid-pass",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id],
        requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
      });

      const change = await admin.changes.propose({ name: "hybrid-pass-change", targets: [target.id] });

      const approvalRequest = await waitForApprovalRequest(admin, change.id);
      // The control passes, but no approval has been cast yet -> the wave stays blocked, so the
      // change stays 'executing' (not 'validating' — see waitForApprovalRequest's doc comment).
      await waitForControlRun(admin, change.id, control.id, "pass");
      await assertStaysExecuting(admin, change.id);

      // Cast the approval — now both halves are satisfied; the wave's NEXT gate check unblocks
      // it, it executes for real against the fake executor, and the change naturally reaches
      // 'validating' on its own.
      await approverClient.approvals.vote(approvalRequest.id);
      await waitForValidating(admin, change.id);

      const promoted = await admin.changes.promote(change.id);
      expect(promoted.state).toBe("promoted");

      // "scp change explain reconstructs policy version + control outcome + evidence" (flagship
      // E2E's own phrasing, BUILD_AND_TEST.md §8 M4): the allow Decision's reasonTree carries the
      // policy version + outcome status; the evidence payload is only ever on controlRuns, joined
      // by controlObjectId.
      const explained = await admin.changes.explain(change.id);
      const allowDecision = explained.decisions.find(
        (d) => d.kind === "transition" && d.verdict === "allow" && (d.inputContext.toState as string) === "promoted"
      );
      expect(allowDecision).toBeDefined();
      // transition.ts: `decision.reasonTree = { summary, gate: gate.reasonTree }` — the per-policy
      // detail (name/enforcement/effects/contributingPolicyVersions) lives on the GATE'S reasonTree
      // (evaluate.ts's `GovernanceEvaluationResult.reasonTree.policies`), nested under `gate` here;
      // `inputContext.gate` (gate-orchestrator.ts's `GateOutcome.inputContext`) is a different,
      // coarser object (matchedPolicyCount/effectivePolicyCount) with no `policies` array at all.
      const gateReasonTree = (allowDecision!.reasonTree as { gate?: { policies?: Array<Record<string, unknown>> } })
        .gate;
      const policyEntry = gateReasonTree?.policies?.find((p) => p.name === "hybrid-release");
      expect(policyEntry).toBeDefined();
      expect((policyEntry!.contributingPolicyVersions as Array<{ policyObjectId: string }>)[0]?.policyObjectId).toBe(
        (await admin.policies.get(`urn:scp:${org.orgId}:policy:hybrid-pass`)).id
      );

      const controlRunEntry = explained.controlRuns.find((r) => r.controlObjectId === control.id);
      expect(controlRunEntry).toBeDefined();
      expect(controlRunEntry!.status).toBe("pass");
      expect(controlRunEntry!.evidence).toMatchObject({ via: "test-webhook" });
    });
  });

  // -----------------------------------------------------------------------------------------
  // N-of-M approval quorum integrity: no double-vote, no non-member vote, satisfied only once
  // quorum is genuinely reached — SECURITY-SENSITIVE surface.
  // -----------------------------------------------------------------------------------------

  it("N-of-M quorum: rejects a non-member vote (403), rejects a double-vote by the same actor (409), and is satisfied only once 2 DISTINCT eligible voters have voted", async () => {
    const org = await createTestOrg(server, "quorum");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, { name: "quorum-target" });
    await createPolicy(admin, org, {
      name: "quorum-gate",
      urnSuffix: "quorum",
      enforcement: "required",
      scopeObjectId: target.id,
      requireApprovals: { count: 2, fromRole: "Approver", scope: org.orgId }
    });

    const change = await admin.changes.propose({ name: "quorum-change", targets: [target.id] });

    const approverA = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const approverB = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const nonMember = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const clientA = new ScpClient({ baseUrl: server.baseUrl, token: approverA.token });
    const clientB = new ScpClient({ baseUrl: server.baseUrl, token: approverB.token });
    const clientNonMember = new ScpClient({ baseUrl: server.baseUrl, token: nonMember.token });

    // Materializes from wave 0's own gate check (this required policy is scoped directly to the
    // wave's own target), not from 'validating' — see waitForApprovalRequest's doc comment.
    const approvalRequest = await waitForApprovalRequest(admin, change.id);

    const nonMemberErr = await expectApiError(() => clientNonMember.approvals.vote(approvalRequest.id));
    expect(nonMemberErr.status).toBe(403);

    await clientA.approvals.vote(approvalRequest.id);
    let status = await admin.approvals.get(approvalRequest.id);
    expect(status).toMatchObject({ voteCount: 1, status: "pending" });

    const doubleVoteErr = await expectApiError(() => clientA.approvals.vote(approvalRequest.id));
    expect(doubleVoteErr.status).toBe(409);

    // Quorum not yet reached (1/2) -> the wave stays blocked -> the change stays 'executing'.
    await assertStaysExecuting(admin, change.id);

    await clientB.approvals.vote(approvalRequest.id);
    status = await admin.approvals.get(approvalRequest.id);
    expect(status).toMatchObject({ voteCount: 2, status: "satisfied" });

    // Quorum reached -> the wave unblocks on its next gate check, executes, and the change
    // naturally reaches 'validating'.
    await waitForValidating(admin, change.id);
    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");

    // Every accepted vote carries a verifiable Ed25519 attestation (DESIGN §10.2).
    const votes = await admin.approvals.listVotes(approvalRequest.id);
    expect(votes).toHaveLength(2);
    for (const vote of votes) {
      expect(vote.attestation.signature.length).toBeGreaterThan(0);
      expect(vote.attestation.record.approverSubjectId).toBe(vote.voterObjectId);
    }

    // DESIGN §10.2: "approvals are recorded as `approves` relationships" — graph-visible, not
    // just rows in the approval_votes projection table.
    for (const voterObjectId of [approverA.objectId, approverB.objectId]) {
      const approvesRels = await admin.relationships.list({
        fromId: voterObjectId,
        toId: change.id,
        typeId: "approves"
      });
      expect(approvesRels.items.length).toBeGreaterThanOrEqual(1);
    }
  });

  // -----------------------------------------------------------------------------------------
  // MAJOR #7 (adversarial review): `approves` edges are DESIGN §10.2 approval EVIDENCE and are
  // system-managed — the generic /relationships endpoint must refuse to fabricate one (a
  // graph-visible fake "X approved this"), so approval evidence only ever derives from the
  // DB-vote-backed approval-vote path.
  // -----------------------------------------------------------------------------------------

  it("the generic /relationships endpoint refuses to create OR delete a system-managed 'approves' edge (403) — even for an org-root Owner", async () => {
    const org = await createTestOrg(server, "approves-guard");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const a = await createTestComponent(admin, { name: "ag-from" });
    const b = await createTestComponent(admin, { name: "ag-to" });

    // Even the bootstrap admin (org-root Owner) cannot fabricate one — it's engine-owned, not a
    // permission question.
    const createErr = await expectApiError(() =>
      admin.relationships.create({ typeId: "approves", fromId: a.id, toId: b.id })
    );
    expect(createErr.status).toBe(403);
    expect(JSON.stringify(createErr.problem)).toMatch(/system-managed/i);

    // A legitimate `approves` edge (from a real vote) also cannot be hand-deleted via the generic
    // endpoint. Produce one via the real vote path, then attempt to delete it.
    const target = await createTestComponent(admin, { name: "ag-target" });
    await createPolicy(admin, org, {
      name: "approves-guard-policy",
      urnSuffix: "approves-guard",
      enforcement: "required",
      scopeObjectId: target.id,
      requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
    });
    const change = await admin.changes.propose({ name: "ag-change", targets: [target.id] });
    const approvalRequest = await waitForApprovalRequest(admin, change.id);
    const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });
    await approverClient.approvals.vote(approvalRequest.id);

    const edges = await admin.relationships.list({ fromId: approver.objectId, toId: change.id, typeId: "approves" });
    expect(edges.items.length).toBeGreaterThanOrEqual(1);
    const deleteErr = await expectApiError(() => admin.relationships.delete(edges.items[0]!.id));
    expect(deleteErr.status).toBe(403);
    expect(JSON.stringify(deleteErr.problem)).toMatch(/system-managed/i);
  });

  // -----------------------------------------------------------------------------------------
  // MAJOR #5 (adversarial review): a requireApprovals.scope written as a scope-KIND keyword
  // (DESIGN §10.1's own example `"scope":"service"`) must resolve to the change target's
  // containing service — NOT crash the reconcile tick with a raw `::uuid` cast (22P02).
  // -----------------------------------------------------------------------------------------

  it("requireApprovals scope written as the DESIGN keyword 'service' resolves to the target's containing service (no 22P02 crash) and gates a service-level Approver's vote", async () => {
    const org = await createTestOrg(server, "scope-keyword");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const service = await admin.services.create({ name: "sk-service" });
    const component = await createTestComponent(admin, { name: "sk-component", domainId: service.id });

    await createPolicy(admin, org, {
      name: "service-approval",
      urnSuffix: "scope-keyword",
      enforcement: "required",
      scopeObjectId: component.id,
      // The DESIGN §10.1 example scope KIND keyword — not a uuid.
      requireApprovals: { count: 1, fromRole: "Approver", scope: "service" }
    });

    const change = await admin.changes.propose({ name: "sk-change", targets: [component.id] });

    // The approval request materializes with scopeObjectId resolved to the SERVICE (not the raw
    // string "service"), so an Approver bound at the service is eligible.
    const approvalRequest = await waitForApprovalRequest(admin, change.id);
    expect(approvalRequest.scopeObjectId).toBe(service.id);

    const serviceApprover = await createTestUser(server, org, [{ role: "Approver", scope: service.id }]);
    const serviceApproverClient = new ScpClient({ baseUrl: server.baseUrl, token: serviceApprover.token });
    await serviceApproverClient.approvals.vote(approvalRequest.id);
    const satisfied = await admin.approvals.get(approvalRequest.id);
    expect(satisfied.status).toBe("satisfied");

    // The change proceeds all the way to promoted — proving the whole path (materialize with
    // resolved scope → eligible vote → quorum) worked, and never crashed a gate tick.
    await waitForValidating(admin, change.id);
    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // The SAME keyword, on the shape migration 0021 actually created. The test above wires the
  // component to the service with `domainId: service.id` — a component whose *containing domain* IS
  // a service object. That is not the service/component model: 0021 links them with a `contains`
  // edge and leaves `domain_id` pointing at the org root. On that real shape, gate-orchestrator's
  // domain_id-only walk found no ancestor of kind 'service', `resolveApprovalScope` returned null,
  // and the caller treats null as an UNSATISFIABLE required approval — fail CLOSED, with prewarm
  // skipping materialization so no human could vote it through either. Wedged forever.
  // -----------------------------------------------------------------------------------------

  it("requireApprovals scope keyword 'service' resolves through the `contains` edge (not just domain_id) and is satisfiable by a service-level Approver", async () => {
    const org = await createTestOrg(server, "scope-keyword-contains");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const service = await admin.services.create({ name: "skc-service" });
    // The component's domain_id defaults to the ORG ROOT — deliberately NOT the service. The ONLY
    // thing linking C to S is the `contains` edge, exactly as migration 0021 registers it
    // (service --contains--> component, walked backwards). Do not "fix" this to `domainId:
    // service.id`: that would re-create the sibling test above and stop covering this bug.
    const component = await createTestComponent(admin, { name: "skc-component", service: service.id });

    await createPolicy(admin, org, {
      name: "service-approval-contains",
      urnSuffix: "scope-keyword-contains",
      enforcement: "required",
      scopeObjectId: component.id,
      requireApprovals: { count: 1, fromRole: "Approver", scope: "service" }
    });

    const change = await admin.changes.propose({ name: "skc-change", targets: [component.id] });

    // With the domain_id-only walk this never materializes at all (the scope resolves to null and
    // both prewarm and the gate skip it) — the wait times out, which IS the bug.
    const approvalRequest = await waitForApprovalRequest(admin, change.id);
    expect(approvalRequest.scopeObjectId).toBe(service.id);

    // ... and the resolved scope is genuinely satisfiable: an Approver bound at the SERVICE (not at
    // the component, not at the org root) can vote it to quorum.
    const serviceApprover = await createTestUser(server, org, [{ role: "Approver", scope: service.id }]);
    const serviceApproverClient = new ScpClient({ baseUrl: server.baseUrl, token: serviceApprover.token });
    await serviceApproverClient.approvals.vote(approvalRequest.id);
    const satisfied = await admin.approvals.get(approvalRequest.id);
    expect(satisfied.status).toBe("satisfied");

    // The change reaches promoted — the required approval was satisfiable, not a permanent wedge.
    await waitForValidating(admin, change.id);
    const promoted = await admin.changes.promote(change.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // Freezes: block, mandatory reason, and — MAJOR #6 — a REJECTED override (unauthorized / no
  // reason) is now routed through the Decision+audit path (409 carrying decision_id, an audited
  // rejected-transition Decision), NOT a rolled-back raw 403. Authorized override succeeds and
  // audits with the reason. SECURITY-SENSITIVE surface.
  // -----------------------------------------------------------------------------------------

  it("freeze blocks promote; a rejected override (unauthorized / no-reason) carries decision_id + is audited (MAJOR #6); authorized override with a reason succeeds and writes an audited, Decision-linked freeze.override event", async () => {
    const org = await createTestOrg(server, "freeze");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, { name: "freeze-target" });
    const change = await admin.changes.propose({ name: "freeze-change", targets: [target.id] });
    await waitForValidating(admin, change.id);

    const now = Date.now();
    await admin.freezes.create({
      scopeObjectId: target.id,
      name: "code-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "holiday code freeze"
    });

    const blocked = await expectApiError(() => admin.changes.promote(change.id));
    expect(blocked.status).toBe(409);
    expect(blocked.problem?.decision_id).toBeTruthy();

    // Administrator has 'freeze:write' (M4 migration) but deliberately NOT 'freeze:override' —
    // the two highest-blast-radius bypass permissions are Owner-only. MAJOR #6: an unauthorized
    // override is now a 409 carrying decision_id (a real, audited rejected-transition Decision),
    // not a bare 403 that leaves no trace.
    const administrator = await createTestUser(server, org, [{ role: "Administrator", scope: org.orgId }]);
    const administratorClient = new ScpClient({ baseUrl: server.baseUrl, token: administrator.token });
    const unauthorizedOverride = await expectApiError(() =>
      administratorClient.changes.promote(change.id, "let me through please", true)
    );
    expect(unauthorizedOverride.status).toBe(409);
    expect(unauthorizedOverride.problem?.decision_id).toBeTruthy();
    // The rejected override left an audited Decision naming the rejection.
    const rejectDecision = await admin.decisions.get(unauthorizedOverride.problem!.decision_id!);
    expect(rejectDecision.verdict).toBe("block");
    expect(JSON.stringify(rejectDecision.reasonTree)).toMatch(/override rejected/i);

    // Owner HAS 'freeze:override' but omits the mandatory reason — also a rejected-override 409.
    const missingReason = await expectApiError(() => admin.changes.promote(change.id, undefined, true));
    expect(missingReason.status).toBe(409);
    expect(missingReason.problem?.decision_id).toBeTruthy();

    // Owner, with a reason, succeeds.
    const promoted = await admin.changes.promote(change.id, "hotfix approved by incident commander", true);
    expect(promoted.state).toBe("promoted");

    const auditPage = await admin.auditEvents.list({ limit: 100 });
    const overrideEvent = auditPage.items.find((e) => e.action === "freeze.override");
    expect(overrideEvent).toBeDefined();
    expect(overrideEvent!.reason).toBe("hotfix approved by incident commander");
    expect(overrideEvent!.decisionId).toBeTruthy();

    const decision = await admin.decisions.get(overrideEvent!.decisionId!);
    expect(decision.verdict).toBe("allow");
    expect(decision.kind).toBe("transition");
    // The rejected attempts were also audited as blocked transitions (MAJOR #6 — nothing rolls
    // back silently): at least one `change.transition.blocked` event exists for this change.
    const blockedEvents = auditPage.items.filter((e) => e.action === "change.transition.blocked");
    expect(blockedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------------------------
  // A freeze scoped at a SERVICE must block that service's components. DESIGN §10.3 lists
  // `service` as a freeze scope level, but gate-orchestrator's freeze walk followed `domain_id`
  // only — services and components are siblings under a domain, so the service id never entered
  // the scope set. `activeFreezesForScopes` matches by EXACT SET MEMBERSHIP, so the freeze was
  // simply not found: it failed OPEN, silently, with the freeze still listed as active.
  // -----------------------------------------------------------------------------------------

  it("a freeze scoped at a SERVICE blocks a change targeting a component that service CONTAINS (and does not block a component it doesn't)", async () => {
    const org = await createTestOrg(server, "service-freeze");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const service = await admin.services.create({ name: "sf-service" });
    // Same real shape as the keyword test: domain_id stays the org root; the `contains` edge is the
    // only link. A domain_id-only walk cannot see the service from the component.
    const contained = await createTestComponent(admin, { name: "sf-contained", service: service.id });
    // Negative control (the orphan-import case): a component the service does NOT contain. Guards
    // against a "fix" that over-blocks by scooping up unrelated objects.
    const unrelated = await createTestComponent(admin, { name: "sf-unrelated" });

    const frozenChange = await admin.changes.propose({ name: "sf-frozen-change", targets: [contained.id] });
    const freeChange = await admin.changes.propose({ name: "sf-free-change", targets: [unrelated.id] });
    await waitForValidating(admin, frozenChange.id);
    await waitForValidating(admin, freeChange.id);

    const now = Date.now();
    await admin.freezes.create({
      scopeObjectId: service.id,
      name: "sf-service-freeze",
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      reason: "service-wide freeze"
    });

    // THE BUG: without the `contains` route this promote SUCCEEDS — the freeze is active, covers the
    // component's service, and blocks nothing.
    const blocked = await expectApiError(() => admin.changes.promote(frozenChange.id));
    expect(blocked.status).toBe(409);
    expect(blocked.problem?.decision_id).toBeTruthy();
    // Blocked BY THIS FREEZE specifically — not by some unrelated policy that happens to 409.
    const decision = await admin.decisions.get(blocked.problem!.decision_id!);
    expect(decision.verdict).toBe("block");
    expect(JSON.stringify(decision.reasonTree)).toMatch(/sf-service-freeze/);

    // The unrelated component is untouched: containment confers the freeze, proximity does not.
    const promoted = await admin.changes.promote(freeChange.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // CRITICAL #2 (adversarial review): a narrow-scope override must NOT slip a change past a
  // BROADER simultaneous freeze the actor has no authority over. `activeFreezesForScopes` can
  // return several; only checking the first one was the bypass.
  // -----------------------------------------------------------------------------------------

  it("a narrow-scope freeze:override does NOT bypass a broader simultaneous freeze the actor lacks authority over — every active freeze must be individually overridden", async () => {
    const org = await createTestOrg(server, "multi-freeze");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const service = await admin.services.create({ name: "mf-service" });
    const component = await createTestComponent(admin, { name: "mf-component", domainId: service.id });
    const change = await admin.changes.propose({ name: "mf-change", targets: [component.id] });
    await waitForValidating(admin, change.id);

    const now = Date.now();
    const startsAt = new Date(now - 60_000).toISOString();
    const endsAt = new Date(now + 3_600_000).toISOString();
    // TWO simultaneous freezes over the change's scope: a narrow one at the component, a broader
    // one at the org root.
    await admin.freezes.create({ scopeObjectId: component.id, name: "component-freeze", startsAt, endsAt, reason: "narrow" });
    await admin.freezes.create({ scopeObjectId: org.orgId, name: "org-freeze", startsAt, endsAt, reason: "broad org-wide freeze" });

    // An actor who can PROMOTE (Administrator at org root grants object:write, the route-level
    // permission the promote endpoint checks — but NOT freeze:override, which is Owner-only) AND
    // holds freeze:override ONLY at the component (Owner bound there). So they can override the
    // component freeze but have no authority over the broader org-root freeze.
    const narrowOverrider = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId },
      { role: "Owner", scope: component.id }
    ]);
    const narrowClient = new ScpClient({ baseUrl: server.baseUrl, token: narrowOverrider.token });

    // Their override covers the component freeze but NOT the org-root freeze → still blocked.
    // (Also needs object:write to attempt the promote transition at all — Owner grants it.)
    const stillBlocked = await expectApiError(() =>
      narrowClient.changes.promote(change.id, "I can only override the component freeze", true)
    );
    expect(stillBlocked.status).toBe(409);
    expect(stillBlocked.problem?.decision_id).toBeTruthy();

    // The org-root Owner (admin) holds freeze:override at org root, which covers BOTH freezes via
    // containment → the override succeeds and BOTH freezes are individually audited.
    const promoted = await admin.changes.promote(change.id, "incident: overriding both freezes", true);
    expect(promoted.state).toBe("promoted");

    const auditPage = await admin.auditEvents.list({ limit: 200 });
    const overrideEvents = auditPage.items.filter((e) => e.action === "freeze.override");
    expect(overrideEvents.length).toBeGreaterThanOrEqual(2); // one per overridden freeze
  });

  // -----------------------------------------------------------------------------------------
  // Group-scoped policy (DESIGN §7's member_of expansion, reused for policy scope).
  // -----------------------------------------------------------------------------------------

  it("a group-scoped policy fires for a member_of subject and does not fire for a non-member", async () => {
    const org = await createTestOrg(server, "group-scope");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, { name: "group-scope-target" });
    const group = await admin.groups.create({ name: "release-managers" });

    const member = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const nonMember = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    await admin.relationships.create({ typeId: "member_of", fromId: member.objectId, toId: group.id });

    await createPolicy(admin, org, {
      name: "group-gate",
      urnSuffix: "group-gate",
      enforcement: "required",
      scopeGroupId: group.id,
      requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId }
    });

    const memberClient = new ScpClient({ baseUrl: server.baseUrl, token: member.token });
    const nonMemberClient = new ScpClient({ baseUrl: server.baseUrl, token: nonMember.token });

    const changeAsMember = await memberClient.changes.propose({ name: "as-member", targets: [target.id] });
    await waitForValidating(memberClient, changeAsMember.id);
    const memberBlocked = await expectApiError(() => memberClient.changes.promote(changeAsMember.id));
    expect(memberBlocked.status).toBe(409);

    const changeAsNonMember = await nonMemberClient.changes.propose({ name: "as-non-member", targets: [target.id] });
    await waitForValidating(nonMemberClient, changeAsNonMember.id);
    const promoted = await nonMemberClient.changes.promote(changeAsNonMember.id);
    expect(promoted.state).toBe("promoted");
  });

  // -----------------------------------------------------------------------------------------
  // Emergency changes (DESIGN §10.3) — SECURITY-SENSITIVE surface: only a permitted actor
  // (change:emergency) may flag a change emergency; a flagged change follows a CONFIGURED
  // emergencyPolicy set instead of the normal required policies, never a blanket bypass, and the
  // bypass itself is visible in the Decision trail (never a silent allow indistinguishable from
  // "no policy applied").
  // -----------------------------------------------------------------------------------------

  describe("emergency changes", () => {
    it("an emergency change follows the configured emergencyPolicy (bypassing an otherwise-unsatisfiable normal required policy) while a non-emergency change against the SAME target stays blocked — both fully audited", async () => {
      const org = await createTestOrg(server, "emergency");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "emergency-target" });

      // Deliberately unsatisfiable in this test (nobody ever votes) — any change that gets past
      // this one did so via the emergency bypass, not by chance.
      await createPolicy(admin, org, {
        name: "normal-required-gate",
        urnSuffix: "emergency-normal",
        enforcement: "required",
        scopeObjectId: target.id,
        requireApprovals: { count: 1, fromRole: "Owner", scope: target.id }
      });

      // The org's configured emergency policy for this scope — effect-free (vacuously satisfied)
      // so an emergency change sails through once the normal policy above is swapped out for it.
      await createPolicy(admin, org, {
        name: "emergency-bypass-policy",
        urnSuffix: "emergency-bypass",
        enforcement: "required",
        scopeObjectId: target.id,
        emergencyPolicy: true
      });

      // Non-emergency change against the SAME target: the normal required policy applies (it is
      // NOT filtered out for a non-emergency change) and can never be satisfied -> stays parked.
      const normalChange = await admin.changes.propose({ name: "normal-change", targets: [target.id] });
      await assertStaysExecuting(admin, normalChange.id, 4_000);

      // Emergency change, proposed by a permitted actor (the bootstrap admin holds Owner, which
      // has change:emergency per the M4 migration) -> gate-orchestrator.ts swaps in ONLY the
      // configured emergencyPolicy set -> proceeds cleanly through both the wave boundary and the
      // validating->promoted lifecycle edge.
      const emergencyChange = await admin.changes.propose({
        name: "emergency-change",
        targets: [target.id],
        emergency: true
      });
      await waitForValidating(admin, emergencyChange.id);
      const promoted = await admin.changes.promote(emergencyChange.id);
      expect(promoted.state).toBe("promoted");

      // Fully audited: the bypass is a NAMED fact in the Decision trail, not a silent allow — a
      // retrospective reader can tell this change went through the emergency path.
      const explained = await admin.changes.explain(emergencyChange.id);
      const emergencyDecision = explained.decisions.find((d) => {
        const gate = (d.reasonTree as { gate?: { emergencyNote?: unknown } }).gate;
        return typeof gate?.emergencyNote === "string";
      });
      expect(emergencyDecision).toBeDefined();
      expect(String((emergencyDecision!.reasonTree as { gate: { emergencyNote: string } }).gate.emergencyNote)).toMatch(
        /emergency/i
      );
    });

    it("a non-permitted actor cannot flag a change emergency (403) — the SAME actor can still propose an ordinary change", async () => {
      const org = await createTestOrg(server, "emergency-authz");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const target = await createTestComponent(admin, { name: "emergency-authz-target" });

      // Administrator: object:write (can propose ordinary changes) but deliberately NOT
      // change:emergency (Owner-only per the M4 migration — the two highest-blast-radius bypass
      // permissions, freeze:override and change:emergency, are never granted to Administrator).
      const administrator = await createTestUser(server, org, [{ role: "Administrator", scope: org.orgId }]);
      const administratorClient = new ScpClient({ baseUrl: server.baseUrl, token: administrator.token });

      const err = await expectApiError(() =>
        administratorClient.changes.propose({ name: "attempted-emergency", targets: [target.id], emergency: true })
      );
      expect(err.status).toBe(403);

      const ordinary = await administratorClient.changes.propose({ name: "ordinary-change", targets: [target.id] });
      expect(ordinary.emergency).toBe(false);
    });
  });

  // -----------------------------------------------------------------------------------------
  // M17.1 (ADR-0013): the `scan-result-control` ControlPlugin — a coordinated Trivy scan VERDICT
  // turned into gate evidence, proven through the REAL gate seam (not a plugin-unit tautology):
  // a required policy naming the scan control genuinely blocks promotion when the verdict fails
  // (over-threshold OR digest-mismatch) and lets it through when the verdict passes. SCP consumes
  // the verdict; it never runs Trivy (charter coordinate-not-execute).
  // -----------------------------------------------------------------------------------------

  describe("scan-result-control (Trivy verdict as a boundary-authorization gate)", () => {
    const MATCH_DIGEST = "sha256:aaaa000000000000000000000000000000000000000000000000000000000000";
    const OTHER_DIGEST = "sha256:bbbb111111111111111111111111111111111111111111111111111111111111";
    let scanSource: TestWebhookServer;

    /** A real loopback HTTP server (never the internet — same rationale as `startTestWebhookServer`)
     *  serving a REAL-Trivy-shaped result JSON. The desired verdict is encoded in the request URL's
     *  query (`?digest=<sha256:…>&sev=CRITICAL,HIGH`), so ONE fixture backs many differently-configured
     *  scan-control bindings — mirroring how the webhook fixture uses the `x-test-outcome` header. */
    async function startTrivySource(): Promise<TestWebhookServer> {
      const httpServer = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const digest = url.searchParams.get("digest") ?? MATCH_DIGEST;
        const sev = (url.searchParams.get("sev") ?? "").split(",").filter(Boolean);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            SchemaVersion: 2,
            ArtifactName: "registry.test/app:1.0",
            ArtifactType: "container_image",
            Metadata: { RepoDigests: [`registry.test/app@${digest}`], ImageID: digest },
            Results: [
              {
                Target: "registry.test/app:1.0 (alpine 3.19)",
                Vulnerabilities: sev.map((s, i) => ({ VulnerabilityID: `CVE-2026-${9000 + i}`, Severity: s }))
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

    /** A real `control` graph object bound to the real `scan-result-control` plugin, pointed at the
     *  Trivy fixture with a fixed scanned `digest` + `severities`. `expectedDigest` is OPTIONAL: pass
     *  it to exercise the operator-pinned fallback path (a change with no tracked artifact digest);
     *  OMIT it to prove the gate threads the CHANGE's own tracked `sourceRef.artifact_digest` into
     *  `context.artifactDigest`, which the plugin binds against (context wins over config, ADR-0013). */
    async function createScanControl(
      admin: ScpClient,
      org: TestOrg,
      opts: { urnSuffix: string; digest: string; severities?: string[]; expectedDigest?: string; threshold?: Record<string, number> }
    ) {
      const control = await admin.controls.create({
        name: `scan-control-${opts.urnSuffix}`,
        urn: `urn:scp:${org.orgId}:control:${opts.urnSuffix}`,
        properties: { category: "security" }
      });
      const params = new URLSearchParams({ digest: opts.digest, sev: (opts.severities ?? []).join(",") });
      await admin.controls.putBinding(control.id, {
        pluginModule: "scan-result-control",
        pluginInstanceId: `scan-${control.id}`,
        config: {
          url: `${scanSource.url}?${params.toString()}`,
          ...(opts.expectedDigest ? { expectedDigest: opts.expectedDigest } : {}),
          ...(opts.threshold ? { threshold: opts.threshold } : {})
        }
      });
      return control;
    }

    beforeAll(async () => {
      scanSource = await startTrivySource();
    });
    afterAll(async () => {
      await scanSource.close();
    });

    it("a required policy naming the scan control BLOCKS promotion when the Trivy verdict is over threshold (a Critical) — the wave never leaves 'executing' and the block is an audited Decision citing the failed control", async () => {
      const org = await createTestOrg(server, "scan-fail");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "scan-fail-target" });
      const control = await createScanControl(admin, org, {
        urnSuffix: "scan-fail",
        digest: MATCH_DIGEST, // digest matches the change's artifact — it's the VULN that blocks, not the binding
        severities: ["CRITICAL", "HIGH"],
        expectedDigest: MATCH_DIGEST
      });
      await createPolicy(admin, org, {
        name: "scan-gate",
        urnSuffix: "scan-fail-policy",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id]
      });

      const change = await admin.changes.propose({ name: "scan-fail-change", targets: [target.id] });

      // The control genuinely runs (real subprocess, real Trivy-JSON fetch) and reports 'fail'.
      const run = await waitForControlRun(admin, change.id, control.id, "fail");
      // Evidence is the TYPED scan verdict — digest bound (match), counts, threshold applied.
      expect(run.evidence).toMatchObject({ scanner: "trivy", digestMatch: true });
      expect((run.evidence as { severityCounts: { critical: number } }).severityCounts.critical).toBe(1);

      // Failed required control -> the wave can never start -> the change stays 'executing'.
      await assertStaysExecuting(admin, change.id);

      const explained = await admin.changes.explain(change.id);
      const gateBlock = explained.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
      expect(gateBlock).toBeDefined();
      const policyEntry = (
        (gateBlock!.reasonTree as { policies?: Array<Record<string, unknown>> }).policies ?? []
      ).find((p) => p.name === "scan-gate");
      const controlEffect = (
        policyEntry!.effects as Array<{ kind: string; satisfied: boolean; detail: Record<string, unknown> }>
      ).find((e) => e.kind === "requireControls");
      expect(controlEffect?.satisfied).toBe(false);
      expect(controlEffect?.detail.outcome).toBe("fail");
    });

    it("a CLEAN Trivy verdict whose scanned digest MATCHES the change's artifact PROMOTES — and the pass evidence is explainable", async () => {
      const org = await createTestOrg(server, "scan-pass");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "scan-pass-target" });
      const control = await createScanControl(admin, org, {
        urnSuffix: "scan-pass",
        digest: MATCH_DIGEST,
        severities: ["MEDIUM", "LOW"], // under the default (Critical=0, High=0) threshold
        expectedDigest: MATCH_DIGEST
      });
      await createPolicy(admin, org, {
        name: "scan-gate",
        urnSuffix: "scan-pass-policy",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id]
      });

      const change = await admin.changes.propose({ name: "scan-pass-change", targets: [target.id] });

      await waitForControlRun(admin, change.id, control.id, "pass");
      await waitForValidating(admin, change.id);
      const promoted = await admin.changes.promote(change.id);
      expect(promoted.state).toBe("promoted");

      const explained = await admin.changes.explain(change.id);
      const controlRun = explained.controlRuns.find((r) => r.controlObjectId === control.id);
      expect(controlRun!.status).toBe("pass");
      expect(controlRun!.evidence).toMatchObject({
        scanner: "trivy",
        digestMatch: true,
        artifactDigest: MATCH_DIGEST,
        expectedDigest: MATCH_DIGEST
      });
    });

    it("a DIGEST MISMATCH blocks even a perfectly CLEAN scan — a verdict for a DIFFERENT artifact must not authorize the change (ADR-0013 'nothing slipped in')", async () => {
      const org = await createTestOrg(server, "scan-mismatch");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "scan-mismatch-target" });
      // ZERO vulnerabilities, but the scan is of OTHER_DIGEST while the change promotes MATCH_DIGEST.
      const control = await createScanControl(admin, org, {
        urnSuffix: "scan-mismatch",
        digest: OTHER_DIGEST,
        severities: [],
        expectedDigest: MATCH_DIGEST
      });
      await createPolicy(admin, org, {
        name: "scan-gate",
        urnSuffix: "scan-mismatch-policy",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id]
      });

      const change = await admin.changes.propose({ name: "scan-mismatch-change", targets: [target.id] });

      const run = await waitForControlRun(admin, change.id, control.id, "fail");
      expect(run.evidence).toMatchObject({ digestMatch: false, artifactDigest: OTHER_DIGEST, expectedDigest: MATCH_DIGEST });
      expect(run.detail).toMatch(/digest mismatch/i);

      // Clean but mismatched -> still blocked: the wave stays parked.
      await assertStaysExecuting(admin, change.id);
    });

    // -------------------------------------------------------------------------------------------
    // The binding is to the CHANGE's REAL tracked artifact — NOT to an operator-typed config value.
    // These two tests set NO `config.expectedDigest`; the ONLY digest the verdict can bind against is
    // the change's own `sourceRef.artifact_digest`, which the gate now threads into
    // `context.artifactDigest`. This is what makes ADR-0013's "nothing slipped in" non-tautological:
    // the same `policy:write` author can no longer type the expected digest next to the scan source.
    // -------------------------------------------------------------------------------------------

    it("binds to the change's REAL tracked artifact digest: a CLEAN scan of a DIFFERENT digest than the change's sourceRef.artifact_digest BLOCKS — with NO config.expectedDigest to pin (context wins, not a config tautology)", async () => {
      const org = await createTestOrg(server, "scan-real-mismatch");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "scan-real-mismatch-target" });
      // ZERO vulnerabilities and NO operator-pinned expectedDigest — the scan is of OTHER_DIGEST.
      const control = await createScanControl(admin, org, {
        urnSuffix: "scan-real-mismatch",
        digest: OTHER_DIGEST,
        severities: []
        // expectedDigest deliberately OMITTED — the only digest to bind against is the change's own.
      });
      await createPolicy(admin, org, {
        name: "scan-gate",
        urnSuffix: "scan-real-mismatch-policy",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id]
      });

      // The change PROMOTES MATCH_DIGEST — carried in its own tracked sourceRef.artifact_digest.
      const change = await admin.changes.propose({
        name: "scan-real-mismatch-change",
        targets: [target.id],
        sourceRef: { artifact_digest: MATCH_DIGEST }
      });

      const run = await waitForControlRun(admin, change.id, control.id, "fail");
      // The verdict was bound to the CHANGE's tracked digest (context), NOT to any config value.
      expect(run.evidence).toMatchObject({
        digestMatch: false,
        artifactDigest: OTHER_DIGEST,
        expectedDigest: MATCH_DIGEST
      });
      expect(run.detail).toMatch(/digest mismatch/i);

      // Clean but bound to a DIFFERENT artifact than the change is promoting -> blocked, audited.
      await assertStaysExecuting(admin, change.id);
      const explained = await admin.changes.explain(change.id);
      const gateBlock = explained.decisions.find((d) => d.kind === "gate" && d.verdict === "block");
      expect(gateBlock).toBeDefined();
      expect(gateBlock!.id).toBeTruthy(); // a resolvable decision_id (charter principle 6)
    });

    it("binds to the change's REAL tracked artifact digest: a CLEAN scan whose scanned digest MATCHES the change's sourceRef.artifact_digest PROMOTES — again with NO config.expectedDigest", async () => {
      const org = await createTestOrg(server, "scan-real-match");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

      const target = await createTestComponent(admin, { name: "scan-real-match-target" });
      const control = await createScanControl(admin, org, {
        urnSuffix: "scan-real-match",
        digest: MATCH_DIGEST,
        severities: ["MEDIUM", "LOW"] // under the default (Critical=0, High=0) threshold
        // expectedDigest deliberately OMITTED — binding is against the change's own tracked digest.
      });
      await createPolicy(admin, org, {
        name: "scan-gate",
        urnSuffix: "scan-real-match-policy",
        enforcement: "required",
        scopeObjectId: target.id,
        requireControlIds: [control.id]
      });

      const change = await admin.changes.propose({
        name: "scan-real-match-change",
        targets: [target.id],
        sourceRef: { artifact_digest: MATCH_DIGEST }
      });

      await waitForControlRun(admin, change.id, control.id, "pass");
      await waitForValidating(admin, change.id);
      const promoted = await admin.changes.promote(change.id);
      expect(promoted.state).toBe("promoted");

      const explained = await admin.changes.explain(change.id);
      const controlRun = explained.controlRuns.find((r) => r.controlObjectId === control.id);
      expect(controlRun!.status).toBe("pass");
      // Bound to the change's tracked digest (threaded via context.artifactDigest), no config pin.
      expect(controlRun!.evidence).toMatchObject({
        scanner: "trivy",
        digestMatch: true,
        artifactDigest: MATCH_DIGEST,
        expectedDigest: MATCH_DIGEST
      });
    });
  });
});

// -----------------------------------------------------------------------------------------
// Automatic rollback fires on wave (control/gate) failure — its own server because it needs
// `FakeExecutorConfig.forcePhase` fixed at plugin-instance boot time for specific,
// test-known target object ids (created with an explicit `id:`).
// -----------------------------------------------------------------------------------------

describe("governance integration: automatic rollback on wave failure", () => {
  let server: ListeningTestServer;
  const autoRollbackTargetId = randomUUID();
  const parkedTargetId = randomUUID();

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: { callTimeoutMs: 8_000, restartBackoffBaseMs: 50, maxRestartBackoffMs: 300 },
      fakeExecutorConfig: { forcePhase: { [autoRollbackTargetId]: "failed", [parkedTargetId]: "failed" } }
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("a failed wave under an autoRollbackOnFailure policy triggers rollback automatically, labeled 'automatic' (not 'manual') in the Decision trail — and a rollback change's OWN failed wave never recurses into a rollback-of-a-rollback", async () => {
    const org = await createTestOrg(server, "auto-rollback");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, { id: autoRollbackTargetId, name: "auto-rollback-target" });
    await createPolicy(admin, org, {
      name: "auto-rollback-policy",
      urnSuffix: "auto-rollback",
      enforcement: "advisory", // enforcement gates promote; autoRollbackOnFailure is independent of it
      scopeObjectId: target.id,
      autoRollbackOnFailure: true
    });

    const change = await admin.changes.propose({ name: "will-fail", targets: [target.id] });

    // `forcePhase` has no trigger-kind distinction (this file's module doc) — `autoRollbackTargetId`
    // fails EVERY trigger, sync or rollback alike, so the auto-triggered rollback change's own wave
    // fails too and never reaches 'promoted'. That's deliberately exercised by the SECOND
    // assertion below (no infinite rollback-of-a-rollback regress), not a test gap — this test's
    // real subject is the TRIGGER itself, not the rollback's own eventual success (already proven
    // by coordination.integration.test.ts's "rollback restores prior known-good state" case).
    const trigger = await waitUntil(
      async () => {
        const explained = await admin.changes.explain(change.id);
        return explained.decisions.find((d) => d.kind === "rollback_trigger");
      },
      { describe: `change ${change.id}'s wave failure auto-triggers a rollback`, timeoutMs: 30_000 }
    );
    expect(trigger.verdict).toBe("rollback");
    expect(trigger.inputContext["trigger"]).toBe("automatic");
    expect(String(trigger.reasonTree["summary"])).toMatch(/automatic/i);

    const rollbackChangeObjectId = trigger.inputContext["rollbackChangeObjectId"] as string;
    expect(rollbackChangeObjectId).toBeTruthy();

    // coordination/reconcile.ts's fix under test: a ROLLBACK change's own failed wave must not
    // recurse — it just parks (like any other non-qualifying failed wave), never triggering a
    // SECOND rollback_trigger Decision against itself. Give the reconcile loop several more ticks
    // (it would have looped many times over by now if the fix weren't in place) before asserting
    // the negative.
    await waitUntil(
      async () => {
        const explained = await admin.changes.explain(rollbackChangeObjectId);
        return explained.decisions.some((d) => d.kind === "wave_target" && d.verdict === "block") ? true : undefined;
      },
      { describe: `rollback change ${rollbackChangeObjectId}'s own wave is observed failing`, timeoutMs: 15_000 }
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const rollbackExplained = await admin.changes.explain(rollbackChangeObjectId);
    expect(rollbackExplained.decisions.filter((d) => d.kind === "rollback_trigger")).toHaveLength(0);
  });

  it("a failed wave with NO autoRollbackOnFailure policy stays parked for manual rollback (M3 behavior unchanged)", async () => {
    const org = await createTestOrg(server, "manual-park");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const target = await createTestComponent(admin, { id: parkedTargetId, name: "parked-target" });
    const change = await admin.changes.propose({ name: "will-park", targets: [target.id] });

    await waitUntil(
      async () => {
        const explained = await admin.changes.explain(change.id);
        return explained.plan?.waves.some((w) => w.status === "failed") ? true : undefined;
      },
      { describe: `change ${change.id}'s wave fails`, timeoutMs: 20_000 }
    );

    // A few more reconcile ticks (1s interval) — long enough that a wrongly-firing auto-rollback
    // would have shown up — then assert it genuinely never did.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const stillExecuting = await admin.changes.get(change.id);
    expect(stillExecuting.state).toBe("executing");

    const explained = await admin.changes.explain(change.id);
    expect(explained.decisions.some((d) => d.kind === "rollback_trigger")).toBe(false);
  });
});

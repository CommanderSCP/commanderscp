import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * M22.8 — A SCAN RULE THAT REQUIRES NO SCAN IS REFUSED AT AUTHORING TIME
 * (`governance/scan-rule-authoring-guard.ts`).
 *
 * The refusal is only worth having if it is installed at the CHOKE POINT rather than at one route.
 * ADR-0032 §6a's sibling shipped at the typed `/policies` route and a filterless census then found
 * three more doors reaching `createObject` with a free-form `typeId` and free-form `properties`.
 * G2 below plants the identical refused document through IaC apply, which is one of those three, and
 * would go green against a route-only install — which is exactly why it exists.
 *
 * WHAT THE REFUSAL DOES *NOT* CLAIM matters as much as what it does, and G5/G6 pin both edges:
 * an unbound control is NOT proof that a policy is inert (bindings are a separate call and a
 * refusal there would make authoring order-dependent), and an `admit`-only `scanExclusion` is an
 * ADMISSION rather than a rule about a finding and is exempt.
 */

describe("M22.8 scan-rule authoring guard", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer({});
    org = await createTestOrg(server, "m22-8-guard");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  async function control(name: string, pluginModule?: string): Promise<string> {
    const c = await admin.controls.create({
      name: `${name}-${randomUUID().slice(0, 8)}`,
      properties: { category: "security" }
    });
    if (pluginModule) {
      await admin.controls.putBinding(c.id, {
        pluginModule,
        pluginInstanceId: `${pluginModule}-${c.id}`,
        config:
          pluginModule === "scan-result-control"
            ? {
                url: "http://127.0.0.1:1/never-fetched",
                expectedDigest: `sha256:${"0".repeat(64)}`
              }
            : { url: "http://127.0.0.1:1/never-fetched" }
      });
    }
    return c.id;
  }

  function createPolicy(effects: Record<string, unknown>[]) {
    const name = `guard-${randomUUID().slice(0, 8)}`;
    // No explicit `urn` — the server derives a name-slug one, and every `name` here is unique.
    return admin.policies.create({
      name,
      properties: { scope: { objectRef: org.orgId }, enforcement: "advisory", effects }
    });
  }

  async function expectRefused(promise: Promise<unknown>, mustMention: string) {
    await promise.then(
      () => {
        throw new Error("expected the scan-rule authoring guard to refuse this document");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const apiError = err as ScpApiError;
        expect(apiError.status, "a shape refusal, not an authority one").toBe(400);
        expect(apiError.problem?.detail ?? "").toContain(mustMention);
      }
    );
  }

  // -----------------------------------------------------------------------------------------
  // G1 — the default first-time SecOps document.
  // -----------------------------------------------------------------------------------------

  it("G1 refuses a scanThreshold policy that requires no control at all", async () => {
    await expectRefused(createPolicy([{ scanThreshold: { maxHigh: 0 } }]), "requires no control");
  });

  it("G1b refuses an exclusion CLAUSE policy that requires no control at all", async () => {
    await expectRefused(
      createPolicy([{ scanExclusion: { exclude: { class: "no_fix_available" } } }]),
      "requires no control"
    );
  });

  // -----------------------------------------------------------------------------------------
  // G2 — THE CHOKE-POINT PROOF. The same document, a different door.
  // -----------------------------------------------------------------------------------------

  it("G2 refuses the same document through IaC apply — the door a route-level install would miss", async () => {
    const stackName = `guard-iac-${randomUUID().slice(0, 8)}`;

    // ANTI-VACUITY CONTROL FIRST: the same actor, the same door, a LEGAL scan-rule document. If this
    // failed, every refusal in this test would be meaningless — it would mean IaC simply cannot
    // apply a policy here.
    const okStack = `guard-iac-ok-${randomUUID().slice(0, 8)}`;
    const scanControlId = await control("iac-scan", "scan-result-control");
    const okManifest: DesiredStateManifest = {
      stackName: okStack,
      objects: [
        {
          urn: `urn:scp:${okStack}:policy:legal`,
          typeId: "policy",
          name: `legal-${okStack}`,
          properties: {
            scope: { objectRef: org.orgId },
            enforcement: "advisory",
            effects: [{ scanThreshold: { maxHigh: 0 } }, { requireControls: [scanControlId] }]
          }
        }
      ],
      relationships: []
    };
    const okPlan = await admin.plans.create(okManifest);
    await admin.plans.apply(okPlan.id);

    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn: `urn:scp:${stackName}:policy:smuggled`,
          typeId: "policy",
          name: `smuggled-${stackName}`,
          properties: {
            scope: { objectRef: org.orgId },
            enforcement: "advisory",
            effects: [{ scanThreshold: { maxHigh: 0 } }]
          }
        }
      ],
      relationships: []
    };
    // Plan computation is read-only and never reaches `createObject`; the refusal lands at APPLY.
    const plan = await admin.plans.create(manifest);
    await expectRefused(admin.plans.apply(plan.id), "requires no control");
  }, 120_000);

  // -----------------------------------------------------------------------------------------
  // G3/G4 — "names no SCAN control" is about the BINDING, not about naming something.
  // -----------------------------------------------------------------------------------------

  it("G3 accepts a scanThreshold policy that requires a control bound to the scan-verdict plugin", async () => {
    const scanControlId = await control("scan", "scan-result-control");
    const created = await createPolicy([
      { scanThreshold: { maxHigh: 0 } },
      { requireControls: [scanControlId] }
    ]);
    expect(created.id).toBeDefined();
  });

  it("G4 refuses a scanThreshold policy whose ONLY required control is bound to a non-scan plugin", async () => {
    // This is the case a naive "did you name any control?" check would let through: `allControlIds`
    // is non-empty, the ceiling resolves and even lands in the Decision, and no scan verdict is ever
    // produced for it to constrain.
    const webhookControlId = await control("webhook", "webhook-control");
    await expectRefused(
      createPolicy([{ scanThreshold: { maxHigh: 0 } }, { requireControls: [webhookControlId] }]),
      "requires only non-scan controls"
    );
  });

  // -----------------------------------------------------------------------------------------
  // G5/G6 — the two deliberate NON-refusals.
  // -----------------------------------------------------------------------------------------

  it("G5 accepts a policy naming an UNBOUND control — absence of a binding is never proof of inertness", async () => {
    // A control object and its binding are two API calls. Refusing here would make policy authoring
    // order-dependent, and — because the UPDATE half checks the value about to be STORED — would
    // make an already-valid policy un-editable the moment somebody dropped its binding.
    const unboundControlId = await control("unbound");
    const created = await createPolicy([
      { scanThreshold: { maxHigh: 0 } },
      { requireControls: [unboundControlId] }
    ]);
    expect(created.id).toBeDefined();
  });

  it("G6 accepts an admit-ONLY scanExclusion with no controls — an admission is not a rule about a finding", async () => {
    const created = await createPolicy([{ scanExclusion: { admit: ["no_fix_available"] } }]);
    expect(created.id).toBeDefined();
    // NEGATIVE CONTROL: the same document plus an `exclude` half IS a rule, and IS refused.
    await expectRefused(
      createPolicy([
        { scanExclusion: { admit: ["no_fix_available"], exclude: { class: "no_fix_available" } } }
      ]),
      "requires no control"
    );
  });

  // -----------------------------------------------------------------------------------------
  // G7 — THE UPDATE HALF. An enforceable rule must not be able to become inert by PATCH.
  // -----------------------------------------------------------------------------------------

  it("G7 refuses a PATCH that strips the requireControls out from under an accepted ceiling", async () => {
    const scanControlId = await control("patch-scan", "scan-result-control");
    const created = await createPolicy([
      { scanThreshold: { maxHigh: 0 } },
      { requireControls: [scanControlId] }
    ]);

    await expectRefused(
      admin.policies.update(created.id, {
        properties: {
          scope: { objectRef: org.orgId },
          enforcement: "advisory",
          effects: [{ scanThreshold: { maxHigh: 0 } }]
        }
      }),
      "requires no control"
    );

    // And the stored document is untouched — a refusal reachable only after a partial write is not
    // a refusal.
    const reread = await admin.policies.get(created.id);
    expect(
      (reread.properties as { effects: unknown[] }).effects,
      "the accepted document must survive the refused PATCH intact"
    ).toHaveLength(2);
  });

  // -----------------------------------------------------------------------------------------
  // G8 — a MALFORMED ceiling is inert for a reason this guard does not own, and is not refused here.
  // -----------------------------------------------------------------------------------------

  it("G8 does not refuse an EMPTY scanThreshold — it sets no ceiling, so it is not a rule", async () => {
    // `parseScanThresholdEffect` contributes nothing for an effect with no severity key, so this
    // document is already inert for its own reason. Refusing it here would answer the author with a
    // message about scan controls when the actual problem is an empty ceiling.
    const created = await createPolicy([{ scanThreshold: {} }]);
    expect(created.id).toBeDefined();
  });
});

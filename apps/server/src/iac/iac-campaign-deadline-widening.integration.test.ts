import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";

/**
 * ================================================================================================
 * THE IaC DOOR ONTO A CAMPAIGN'S DEADLINE — owner ruling 2026-08-25 (decision D1, option b-i)
 * ================================================================================================
 *
 * ## The bypass this closes
 *
 * The ruling — *clearing a campaign's deadline, or moving it to a later instant, costs the
 * Owner-only `campaign:deadline-override` on top of `object:write`* — shipped as a check inside the
 * handler for `POST /api/v1/campaigns/{id}/deadline`, and nowhere else.
 *
 * `campaign.properties` has THREE write doors. `governance/campaign-recipe-guard.ts` wrote that
 * census down one milestone earlier, for this exact property bag, and said in as many words that a
 * route-level guard is invisible to two of them. IaC apply is door 2: `iac/plans-repo.ts`'s
 * `executePlanDiff` calls `updateObject` DIRECTLY with a free-form `typeId` and free-form
 * `properties`, `writePermissionFor("campaign")` returns plain `object:write`, and the update
 * branch's only campaign-specific check reads `targets`. `plan-diff.ts` diffs `properties`
 * WHOLESALE and the apply replaces them wholesale, so a manifest that simply OMITS `deadline`
 * deletes it.
 *
 * MEASURED, not reasoned about — see the mutation log below. With the choke-point guard removed
 * (the pre-guard tree), an Operator holding org-root `object:write` and no
 * `campaign:deadline-override` gets a **200** from `POST /plans` + `/plans/{id}/apply` and the
 * deadline is gone from the stored row: no reason, no Decision, no `loosening` label, no
 * `campaign.deadline.set` audit event, and every target the campaign was withholding its changes
 * from releases on the next tick. That is exactly the effect the route refuses that same subject
 * with a 403 (`coordination/campaign-deadline.integration.test.ts` E5), at exactly the permission
 * the route was raised above.
 *
 * ## What these cases assert, and why they are not about an error message
 *
 * That the STORED deadline is unchanged after a refusal, and actually changed after an admitted
 * write. A refusal that still wrote the row would satisfy a status-code assertion.
 *
 * BOTH DIRECTIONS, ONE SUBJECT, ONE CAMPAIGN — that is R3, and it is the case that carries the
 * argument. The same Operator, on the same campaign, through the same door, is ADMITTED the
 * shortening and the unchanged restatement and REFUSED the removal. So what they lack is
 * `campaign:deadline-override` and not standing on the campaign; a refusal-only file would be
 * equally green against a guard that simply refused every IaC write touching a campaign, which
 * would take IaC-managed deadlines away from everyone below Owner.
 *
 * ## Mutation log (each applied ALONE against a green suite, then reverted — house rule)
 *
 * | Mutation | Result |
 * |---|---|
 * | delete the `assertMayWidenCampaignDeadline` call from `graph/objects-repo.ts`'s `updateObject` — i.e. restore the hole | **R1, R2, R3 and R6 FAIL** (4 failed / 2 passed). R1: `AssertionError: dropping the key from the manifest deletes the deadline, which releases every withheld target — the same act the route refuses: expected 200 to be 403`. R2: `... 'drop the key' becomes 'set it to 2099': expected 200 to be 403`. R3: `the same subject, the same campaign, the same door — only the direction changed: expected 200 to be 403`. R6: `a deadline nobody can parse withholds nothing — it is a clear wearing the key: expected 200 to be 403`. The 200s are the bypass itself: the apply succeeded and the deadline was gone from the row. |
 * | narrow the guard's equality test from `incoming.at <= stored.at` to `incoming.at < stored.at`, so an UNCHANGED instant reads as a widening | **R3 FAILS**: `AssertionError: restating a deadline releases nobody: expected 403 to be 200`. |
 * | give the guard `routes/campaigns.ts`'s FLAT rule (a removal is escalated even when nothing readable was stored) | **R5 FAILS**: `AssertionError: nothing was being withheld, so this write releases nobody: expected 403 to be 200` — every deadline-less campaign in the estate would need an Owner to re-apply. |
 *
 * R3 EARNED ITS PLACE ON THAT LIST THE HARD WAY, and the first draft is recorded because the trap is
 * general. Written as a plain re-apply of the identical manifest it was VACUOUS: byte-identical
 * properties make the diff entry a `noop`, `executePlanDiff` never calls `updateObject`, and the
 * mutation above left the file 6/6 green. See the case body for what it does instead.
 *
 * ## What is deliberately NOT here
 *
 * The `federationImport` half. `updateObject` runs this guard inside the block that exempts imports,
 * and that exemption is load-bearing: `federation/import-repo.ts`'s `object_upsert` branch has no
 * try/catch, so one permission refusal there wedges a peer's whole signed bundle — and the importing
 * instance holds no role bindings for the exporting domain's operator, so EVERY imported campaign
 * whose deadline moved later would wedge it. Hand-fill, the other supplier of that flag, cannot
 * reach a locally authored campaign at all: it passes a FOREIGN `originDomainId`, so
 * `updateObject`'s single-writer check 409s first (`federation/handfill-repo.ts`).
 */
describe("IaC apply cannot widen a campaign's deadline at plain object:write", () => {
  let server: TestServer;
  let org: TestOrg;
  /** `object:write` over every object in the org; drizzle/0088 grants `campaign:deadline-override`
   *  to Owner ALONE — so this subject holds exactly the authority the IaC door demanded and nothing
   *  more. The bootstrap admin (`org.adminToken`) is the org-root Owner. */
  let operator: TestUser;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "iac-campaign-deadline");
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  });

  afterAll(async () => {
    await server?.close();
  });

  async function inject(
    token: string,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ statusCode: number; body: string; json: Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = res.json() as Record<string, unknown>;
    } catch {
      /* a 204/empty body is not a case any of these drive */
    }
    return { statusCode: res.statusCode, body: res.body, json: parsed };
  }

  /** The deadline as it is ACTUALLY STORED on the campaign row — never the API's rendering of it,
   *  which is the thing under test on the write side. */
  async function storedDeadline(campaignObjectId: string): Promise<unknown> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await tx.query.objects.findFirst({
        where: (t, { eq }) => eq(t.id, campaignObjectId)
      });
      return (row!.properties as Record<string, unknown>).deadline;
    });
  }

  /**
   * A campaign with ONE component target and a deadline, plus the stack name and urn a manifest
   * needs to address it.
   *
   * THE DEADLINE IS AUTHORED AT CREATE TIME (`POST /api/v1/campaigns`, which
   * `CreateCampaignRequestSchema` lets carry one) rather than through `POST
   * /campaigns/{id}/deadline`. Two reasons, and the second is the point: it is one call instead of
   * two, and it means the fixture never exercises the route-level check these cases are here to
   * prove is insufficient on its own. A create is always a FIRST set, so it takes plain
   * `object:write` either way and the setup does not depend on the ruling it is testing.
   *
   * The urn is DECLARED rather than derived: `CreateCampaignRequestSchema` accepts one, and a test
   * that re-implemented `deriveUrn`'s slug rules would be asserting its own arithmetic.
   */
  async function fixture(label: string): Promise<{
    campaignId: string;
    campaignUrn: string;
    campaignName: string;
    componentId: string;
    stackName: string;
    at: string;
  }> {
    const suffix = randomUUID().slice(0, 8);
    const stackName = `camp-${label}-${suffix}`;
    const service = await inject(org.adminToken, "/api/v1/services", {
      name: `svc-${label}-${suffix}`
    });
    expect(service.statusCode, service.body).toBe(201);
    const component = await inject(org.adminToken, "/api/v1/components", {
      name: `comp-${label}-${suffix}`,
      service: service.json.id as string
    });
    expect(component.statusCode, component.body).toBe(201);

    const campaignName = `campaign-${label}-${suffix}`;
    const campaignUrn = `urn:scp:${org.orgId}:campaign:${campaignName}`;
    // A WHOLE-SECOND BASE so every instant renders with `.000` and a restatement can be compared
    // byte-for-byte against what was stored.
    const base = Math.floor(Date.now() / 1000) * 1000;
    const at = new Date(base + 90 * 24 * 60 * 60 * 1000).toISOString();
    const campaign = await inject(org.adminToken, "/api/v1/campaigns", {
      name: campaignName,
      urn: campaignUrn,
      targets: [component.json.id as string],
      deadline: { at }
    });
    expect(campaign.statusCode, campaign.body).toBe(201);

    return {
      campaignId: campaign.json.id as string,
      campaignUrn,
      campaignName,
      componentId: component.json.id as string,
      stackName,
      at
    };
  }

  /** `POST /plans` then `POST /plans/{id}/apply`, as `token`. Returns the APPLY's response — a plan
   *  that cannot even be computed is a different failure and is asserted separately. */
  async function planAndApply(
    token: string,
    manifest: DesiredStateManifest
  ): Promise<{ statusCode: number; body: string; json: Record<string, unknown> }> {
    const plan = await inject(token, "/api/v1/plans", { manifest });
    expect(plan.statusCode, `plan compute is not the door under test: ${plan.body}`).toBe(201);
    return inject(token, `/api/v1/plans/${plan.json.id as string}/apply`, {});
  }

  function manifestFor(
    f: { campaignUrn: string; campaignName: string; componentId: string; stackName: string },
    deadline: { at: string } | undefined
  ): DesiredStateManifest {
    return {
      stackName: f.stackName,
      objects: [
        {
          urn: f.campaignUrn,
          typeId: "campaign",
          name: f.campaignName,
          properties: {
            targets: [f.componentId],
            type: "configuration",
            ...(deadline !== undefined ? { deadline } : {})
          }
        }
      ],
      relationships: []
    };
  }

  it("R1: a manifest that OMITS `deadline` is refused — the wholesale properties replace is a clear", async () => {
    const f = await fixture("omit");

    const applied = await planAndApply(operator.token, manifestFor(f, undefined));
    expect(
      applied.statusCode,
      "dropping the key from the manifest deletes the deadline, which releases every withheld target — the same act the route refuses"
    ).toBe(403);
    expect(applied.body).toContain("campaign:deadline-override");

    // NOTHING HALF-APPLIED. The refusal throws inside `executePlanDiff`, i.e. inside the apply
    // route's own transaction, so the whole apply rolls back.
    expect(await storedDeadline(f.campaignId)).toEqual({ at: f.at });
  });

  it("R2: a manifest that moves `deadline` to a LATER instant is refused for the same reason", async () => {
    const f = await fixture("later");
    const later = new Date(Date.parse(f.at) + 30 * 24 * 60 * 60 * 1000).toISOString();

    const applied = await planAndApply(operator.token, manifestFor(f, { at: later }));
    expect(
      applied.statusCode,
      "gating only the removal would leave the move as the next bypass: 'drop the key' becomes 'set it to 2099'"
    ).toBe(403);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: f.at });
  });

  it("R3: the SAME Operator may SHORTEN it, and may restate it unchanged — the gate is about direction", async () => {
    const f = await fixture("shorten");
    const nearer = new Date(Date.parse(f.at) - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ---- SHORTEN. A tightening: strictly MORE targets are withheld afterwards, so it cannot
    // launder a waiver and it stays at `object:write`. This is the assertion that fails if the guard
    // is written as "any campaign-deadline edit needs an Owner" — the over-broad refusal that would
    // make IaC unable to manage a deadlined campaign at all.
    const shortened = await planAndApply(operator.token, manifestFor(f, { at: nearer }));
    expect(shortened.statusCode, shortened.body).toBe(200);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: nearer });

    // ---- RESTATE THE SAME INSTANT IN A DIFFERENT RENDERING. Two things at once, and both are the
    // reason it is written this way rather than as a plain re-apply of the identical manifest:
    //
    //   1. IT REACHES THE GUARD AT ALL. A byte-identical re-apply is a `noop` in the diff, so
    //      `executePlanDiff` never calls `updateObject` and the comparison is never made — a case
    //      that would pass with the whole guard deleted AND with the comparison inverted, which is
    //      the definition of vacuous. MEASURED: written as a plain re-apply, mutating the guard's
    //      `<=` to `<` left this file 6/6 green. Changing the milliseconds makes `properties`
    //      textually different, so the entry is a real `update`.
    //   2. IT PINS THE COMPARISON TO PARSED INSTANTS, never to the ISO strings. `...T00:00:00Z` and
    //      `...T00:00:00.000Z` are the same instant and both are accepted by `z.string().datetime()`,
    //      but they sort the WRONG WAY as strings (`'Z' > '.'`) — so a string compare here would read
    //      an unchanged deadline as a slip and demand an Owner for a no-op re-apply.
    const restated = nearer.replace(".000Z", "Z");
    expect(
      restated,
      "the fixture's instants must render with milliseconds for this to bite"
    ).not.toBe(nearer);
    const again = await planAndApply(operator.token, manifestFor(f, { at: restated }));
    expect(again.statusCode, "restating a deadline releases nobody").toBe(200);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: restated });

    // ---- AND NOW THE OTHER DIRECTION, ON THIS SAME CAMPAIGN AND FROM THIS SAME SUBJECT. This is
    // what makes the two 200s above mean something: the Operator is refused the widening not because
    // they lost standing on the campaign somewhere along the way, but because of the DIRECTION of the
    // write. A refusal-only case and an admission-only case cannot draw that distinction between
    // them; only one subject exercising both can.
    const widened = await planAndApply(operator.token, manifestFor(f, undefined));
    expect(
      widened.statusCode,
      "the same subject, the same campaign, the same door — only the direction changed"
    ).toBe(403);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: restated });
  });

  it("R4: an OWNER applies the same widening manifest and it lands — the bar is a permission, not a ban on the door", async () => {
    const f = await fixture("owner");

    // The bootstrap admin is an org-root Owner, which is where drizzle/0088 put
    // `campaign:deadline-override`, and `hasPermission` expands the checked scope UPWARD from the
    // campaign to reach it. If the guard were mis-scoped — resolved at a target, say, or at some
    // object an org-root binding does not reach — THIS is what would fail, and the failure would be
    // "IaC can no longer manage a deadlined campaign at all".
    const applied = await planAndApply(org.adminToken, manifestFor(f, undefined));
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await storedDeadline(f.campaignId)).toBeUndefined();
  });

  it("R5: a campaign with NO deadline is applied by the Operator freely — the guard is a delta, not a key-presence test", async () => {
    const suffix = randomUUID().slice(0, 8);
    const stackName = `camp-none-${suffix}`;
    const service = await inject(org.adminToken, "/api/v1/services", {
      name: `svc-none-${suffix}`
    });
    const component = await inject(org.adminToken, "/api/v1/components", {
      name: `comp-none-${suffix}`,
      service: service.json.id as string
    });
    const campaignName = `campaign-none-${suffix}`;
    const campaignUrn = `urn:scp:${org.orgId}:campaign:${campaignName}`;
    const campaign = await inject(org.adminToken, "/api/v1/campaigns", {
      name: campaignName,
      urn: campaignUrn,
      targets: [component.json.id as string]
    });
    expect(campaign.statusCode, campaign.body).toBe(201);

    // THE CASE THAT MAKES THE FLAT RULE UNTENABLE, and the reason this guard asks a NARROWER
    // question than `routes/campaigns.ts` does. The route treats a clear as escalated even over a
    // campaign with no readable deadline, so that a status code cannot leak stored state. Applying
    // that rule here would demand an Owner for every routine re-apply of every deadline-less
    // campaign in the estate — the manifest omits `deadline` on every single one of them.
    const applied = await planAndApply(operator.token, {
      stackName,
      objects: [
        {
          urn: campaignUrn,
          typeId: "campaign",
          name: campaignName,
          properties: { targets: [component.json.id as string], type: "configuration" }
        }
      ],
      relationships: []
    });
    expect(applied.statusCode, "nothing was being withheld, so this write releases nobody").toBe(
      200
    );
  });

  it("R6: replacing a readable deadline with an UNREADABLE document is a widening too", async () => {
    const f = await fixture("malformed");

    // `resolveCampaignDeadline` reports this as `malformed`, and `campaign-reconcile.ts` fails OPEN
    // on a malformed bag — it locks nothing and writes a `warn`. So in EFFECT this releases exactly
    // the targets a clear would, which is why it is priced like one. A guard that merely asked "is
    // the `deadline` key still present?" would let this through, and the bypass would be one typo
    // wide.
    //
    // Reachable only through a free-form-`properties` door: `CampaignDeadlineInputSchema` refuses it
    // at both typed authoring doors. That is exactly what makes it this file's business.
    const applied = await planAndApply(operator.token, {
      stackName: f.stackName,
      objects: [
        {
          urn: f.campaignUrn,
          typeId: "campaign",
          name: f.campaignName,
          properties: {
            targets: [f.componentId],
            type: "configuration",
            deadline: { at: "next Tuesday" }
          }
        }
      ],
      relationships: []
    });
    expect(
      applied.statusCode,
      "a deadline nobody can parse withholds nothing — it is a clear wearing the key"
    ).toBe(403);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: f.at });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { CampaignDeadlineSchema } from "@scp/schemas";
import type {
  CampaignDeadline,
  CampaignDeadlineOverride,
  DesiredStateManifest
} from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";

/** THE IaC DOOR ONTO A CAMPAIGN'S DEADLINE. See docs/coordination-as-code.md §6. */
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

  /** A campaign with one target and a deadline, plus the stack. See docs/coordination-as-code.md §7. */
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

  /** The stored `deadline` document, typed — for the waiver cases, which restate it verbatim. */
  async function storedDeadlineDoc(campaignObjectId: string): Promise<CampaignDeadline> {
    return (await storedDeadline(campaignObjectId)) as CampaignDeadline;
  }

  /** The waivers as ACTUALLY STORED, `[]` when there are none. */
  async function storedOverrides(campaignObjectId: string): Promise<CampaignDeadlineOverride[]> {
    const doc = (await storedDeadline(campaignObjectId)) as CampaignDeadline | undefined;
    return doc?.overrides ?? [];
  }

  function manifestFor(
    f: { campaignUrn: string; campaignName: string; componentId: string; stackName: string },
    /** FREE-FORM, not `CampaignDeadlineInput` — this door takes an arbitrary document, and the
     *  waiver cases below depend on being able to send the one key both typed authoring doors
     *  refuse. */
    deadline: Record<string, unknown> | undefined
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

    // ---- RESTATE THE SAME INSTANT IN A DIFFERENT RENDERING. See docs/coordination-as-code.md §8.
    const restated = nearer.replace(".000Z", "Z");
    expect(
      restated,
      "the fixture's instants must render with milliseconds for this to bite"
    ).not.toBe(nearer);
    const again = await planAndApply(operator.token, manifestFor(f, { at: restated }));
    expect(again.statusCode, "restating a deadline releases nobody").toBe(200);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: restated });

    // And now the other direction, on the same campaign. See docs/coordination-as-code.md §9.
    const widened = await planAndApply(operator.token, manifestFor(f, undefined));
    expect(
      widened.statusCode,
      "the same subject, the same campaign, the same door — only the direction changed"
    ).toBe(403);
    expect(await storedDeadline(f.campaignId)).toEqual({ at: restated });
  });

  it("R4: an OWNER applies the same widening manifest and it lands — the bar is a permission, not a ban on the door", async () => {
    const f = await fixture("owner");

    // The bootstrap admin is an owner, which is where it sits. See docs/coordination-as-code.md §10.
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

    // The case that makes the flat rule untenable. See docs/coordination-as-code.md §11.
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

    // The resolver calls this malformed, and the loop then. See docs/coordination-as-code.md §12.
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

  /** R1-R6 above closed the deadline INSTANT at this door. See docs/coordination-as-code.md §13. */

  /** A fully-formed waiver, minted the way a MANIFEST mints one. See docs/coordination-as-code.md §14. */
  function waiver(targetObjectId: string, until?: string): CampaignDeadlineOverride {
    return {
      targetObjectId,
      reason: "we will migrate eventually, honest",
      actorId: operator.objectId,
      at: new Date().toISOString(),
      ...(until !== undefined ? { until } : {})
    };
  }

  it("W1: an Operator's manifest that ADDS a waiver, with `at` byte-identical, is refused", async () => {
    const f = await fixture("waive-add");
    const document = { at: f.at, overrides: [waiver(f.componentId)] };

    // THE SECOND SUFFICIENT CAUSE, CLOSED BEFORE THE REQUEST IS MADE. R6 refuses an UNREADABLE
    // deadline document for a different reason; if this one did not parse, W1 would be green as a
    // duplicate of R6 and would survive deleting the waiver delta entirely.
    expect(
      CampaignDeadlineSchema.safeParse(document).success,
      "this document must be READABLE, or the refusal below is R6's and not this case's"
    ).toBe(true);
    expect(document.at, "and its instant must be the stored one, byte for byte").toBe(f.at);

    const applied = await planAndApply(operator.token, manifestFor(f, document));
    expect(
      applied.statusCode,
      "the instant never moved, so only the waiver can be refusing this — and a waiver is exactly what /deadline-override refuses this subject"
    ).toBe(403);
    expect(applied.body).toContain("campaign:deadline-override");

    expect(await storedDeadline(f.campaignId)).toEqual({ at: f.at });
    expect(await storedOverrides(f.campaignId)).toHaveLength(0);

    // ---- THE CONTROL, THROUGH THE TYPED DOOR, on the same campaign and the same subject: the act
    // this manifest performs is the act that route exists to gate, and it refuses this subject too.
    // Without it, "the manifest was refused" would not establish that the manifest was doing
    // anything the platform considers privileged.
    const direct = await inject(
      operator.token,
      `/api/v1/campaigns/${f.campaignId}/deadline-override`,
      { targets: [f.componentId], reason: "the honest way round" }
    );
    expect(direct.statusCode, "the two doors must price the same act the same way").toBe(403);
  });

  it("W2: an OWNER applies that same manifest and the waiver lands — the bar is a permission", async () => {
    const f = await fixture("waive-owner");
    const document = { at: f.at, overrides: [waiver(f.componentId)] };

    const applied = await planAndApply(org.adminToken, manifestFor(f, document));
    expect(applied.statusCode, applied.body).toBe(200);

    const stored = await storedOverrides(f.campaignId);
    expect(
      stored,
      "the Owner's waiver is stored, so W1's refusal was about authority"
    ).toHaveLength(1);
    expect(stored[0]!.targetObjectId).toBe(f.componentId);
    // THE INSTANT IS UNTOUCHED on both sides of W1/W2 — neither case is about the date at all.
    expect((await storedDeadlineDoc(f.campaignId)).at).toBe(f.at);
  });

  it("W3: RESTATING the waivers already in force is free at `object:write` — the delta is empty", async () => {
    const f = await fixture("waive-roundtrip");

    // MINTED THROUGH THE TYPED DOOR, by the Owner. Two things at once. See docs/coordination-as-code.md §15.
    const minted = await inject(
      org.adminToken,
      `/api/v1/campaigns/${f.campaignId}/deadline-override`,
      { targets: [f.componentId], reason: "excused while the vendor ships" }
    );
    expect(minted.statusCode, `the override door must still work: ${minted.body}`).toBe(200);
    const inForce = (await storedDeadlineDoc(f.campaignId)).overrides!;
    expect(inForce).toHaveLength(1);

    // ---- RE-APPLY THE IDENTICAL WAIVERS. NOT a byte-identical manifest. See docs/coordination-as-code.md §16.
    const restated = f.at.replace(".000Z", "Z");
    expect(
      restated,
      "the fixture's instants must render with milliseconds for this to bite"
    ).not.toBe(f.at);
    const again = await planAndApply(
      operator.token,
      manifestFor(f, { at: restated, overrides: inForce })
    );
    expect(
      again.statusCode,
      "IaC re-applies an unchanged manifest constantly — a round-trip releases nobody"
    ).toBe(200);
    expect(await storedOverrides(f.campaignId)).toEqual(inForce);

    // ---- AND THE SAME WAIVERS CARRIED ACROSS A TIGHTENING OF THE INSTANT. Strictly more targets
    // are withheld afterwards and no target is excused any further than it already was, so this is
    // the shape an ordinary IaC-managed campaign takes every day and it must stay at `object:write`.
    const nearer = new Date(Date.parse(f.at) - 30 * 24 * 60 * 60 * 1000).toISOString();
    const tightened = await planAndApply(
      operator.token,
      manifestFor(f, { at: nearer, overrides: inForce })
    );
    expect(tightened.statusCode, tightened.body).toBe(200);
    expect((await storedDeadlineDoc(f.campaignId)).at).toBe(nearer);
    expect(await storedOverrides(f.campaignId)).toEqual(inForce);
  });

  it("W4: the SAME Operator may SHORTEN a waiver's `until` and may not EXTEND it", async () => {
    const f = await fixture("waive-until");
    const far = new Date(Date.parse(f.at) + 60 * 24 * 60 * 60 * 1000).toISOString();
    const near = new Date(Date.parse(f.at) + 10 * 24 * 60 * 60 * 1000).toISOString();

    const minted = await inject(
      org.adminToken,
      `/api/v1/campaigns/${f.campaignId}/deadline-override`,
      { targets: [f.componentId], reason: "excused while the vendor ships", until: far }
    );
    expect(minted.statusCode, minted.body).toBe(200);
    const inForce = (await storedDeadlineDoc(f.campaignId)).overrides!;
    expect(inForce[0]!.until).toBe(far);

    // ---- SHORTEN. The waiver ends sooner, so the target comes back under the deadline sooner:
    // strictly LESS is released. This is the assertion that fails if the delta is written as "any
    // edit to `overrides` needs an Owner", which would make an IaC-managed campaign with one waiver
    // unmanageable below Owner.
    const shortened = await planAndApply(
      operator.token,
      manifestFor(f, { at: f.at, overrides: [{ ...inForce[0]!, until: near }] })
    );
    expect(shortened.statusCode, shortened.body).toBe(200);
    expect((await storedOverrides(f.campaignId))[0]!.until).toBe(near);

    // ---- EXTEND, on this same campaign and from this same subject. What changed is the DIRECTION,
    // not the subject's standing — the distinction a refusal-only case cannot draw.
    const extended = await planAndApply(
      operator.token,
      manifestFor(f, { at: f.at, overrides: [{ ...inForce[0]!, until: far }] })
    );
    expect(
      extended.statusCode,
      "moving a waiver's expiry later excuses the target for longer, which releases it"
    ).toBe(403);
    expect((await storedOverrides(f.campaignId))[0]!.until).toBe(near);

    // ---- AND DROPPING `until` ALTOGETHER IS THE WIDEST EXTENSION THERE IS, not a removal: an
    // absent `until` means "until the deadline is cleared or the target adopts"
    // (`findEffectiveDeadlineOverride`). A delta that compared only the two strings would read this
    // as "nothing to compare" and let the unbounded waiver through — one key wide.
    const { until: _dropped, ...forever } = inForce[0]!;
    const unbounded = await planAndApply(
      operator.token,
      manifestFor(f, { at: f.at, overrides: [forever] })
    );
    expect(
      unbounded.statusCode,
      "an absent `until` never expires, so removing the key is the widest extension of all"
    ).toBe(403);
    expect((await storedOverrides(f.campaignId))[0]!.until).toBe(near);
  });

  it("W5: REMOVING a waiver is a tightening and stays at `object:write`", async () => {
    const f = await fixture("waive-remove");

    const minted = await inject(
      org.adminToken,
      `/api/v1/campaigns/${f.campaignId}/deadline-override`,
      { targets: [f.componentId], reason: "excused while the vendor ships" }
    );
    expect(minted.statusCode, minted.body).toBe(200);
    expect(await storedOverrides(f.campaignId)).toHaveLength(1);

    // The deliberate divergence from the sibling four lines up. See docs/coordination-as-code.md §17.
    const removed = await planAndApply(operator.token, manifestFor(f, { at: f.at }));
    expect(removed.statusCode, "re-locking an excused target releases nobody").toBe(200);
    expect(await storedOverrides(f.campaignId)).toHaveLength(0);
    expect((await storedDeadlineDoc(f.campaignId)).at).toBe(f.at);
  });
});

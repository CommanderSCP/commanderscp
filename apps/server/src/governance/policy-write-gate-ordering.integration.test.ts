import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";

/**
 * ==================================================================================================
 * PIN — OWNED BY THE M21.7 SESSION. DO NOT "FIX" THIS IN A UI MILESTONE.
 * ==================================================================================================
 *
 * `POST /api/v1/policies` (routes/typed-registries.ts, the shared typed-registry factory) authorizes
 * `policy:write` at `resolveDomainId(body.domainId) ?? org` FIRST, and only THEN runs the
 * scope-authority check (`assertPolicyScopeWithinAuthority`: an `objectRef`-scoped policy needs
 * `policy:write` at-or-above THAT object). RBAC scope expansion walks UPWARD only. So a principal
 * whose `policy:write` binding sits AT a component — the exact "component team enables its own
 * dependency subscription" shape ADR-0032 §6 describes — is refused at the FIRST gate whenever the
 * body omits `domainId`, before the check that would have admitted them ever runs.
 *
 * This file MEASURES that ordering and pins it as it stands today, so that:
 *   - the M21.6 web client knows it must send `domainId` (the component's containment domain, or
 *     the component itself) with an objectRef-scoped policy, and its 403 copy names "policy:write at
 *     this component's domain (or the org)";
 *   - whoever changes the ordering (the M21.7 session has taken it to the owner) sees exactly which
 *     assertion flips and updates this pin deliberately, rather than the behaviour drifting behind
 *     a UI-milestone commit.
 *
 * Nothing here is a statement that the ordering is RIGHT. It is a statement of what the server
 * DOES, measured, so nothing else in this round is built on a guess about it.
 */
describe("PIN (M21.7-owned): POST /policies authorizes policy:write at domainId ?? org BEFORE the scope-authority check", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let componentId: string;
  /** The `domain` object the component is contained in — what the component's `domainId` names. */
  let containmentDomainId: string;
  /** `policy:write` (Administrator) bound ONLY at the component — nowhere above it. */
  let componentAdmin: TestUser;

  async function postPolicy(
    token: string,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/policies",
      headers: { authorization: `Bearer ${token}` },
      payload: body
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  const subscriptionPolicyBody = (extra: Record<string, unknown> = {}) => ({
    name: `pin-${uuidv7()}`,
    properties: {
      scope: { objectRef: componentId },
      enforcement: "advisory",
      effects: [{ dependencySubscription: { enabled: true } }]
    },
    ...extra
  });

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "policy-gate-order");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    // A REAL containment domain, so "the component's domainId" below is a `domain` object strictly
    // between the component and the org root — not the org root itself, which is what a component
    // created with no `domainId` is contained by (and where a binding would equal an org binding).
    const domain = await admin.domains.create({ name: `dom-${uuidv7()}` });
    containmentDomainId = domain.id;
    const component = await createTestComponent(admin, {
      name: `gate-order-${uuidv7()}`,
      domainId: domain.id
    });
    componentId = component.id;
    expect(component.domainId, "the component must be contained in the test domain").toBe(
      domain.id
    );
    componentAdmin = await createTestUser(server, org, [
      { role: "Administrator", scope: componentId }
    ]);
  });

  afterAll(async () => {
    await server?.close();
  });

  it("MEASURED: an objectRef-scoped policy WITHOUT domainId is 403 for a principal holding policy:write only at that component", async () => {
    const res = await postPolicy(componentAdmin.token, subscriptionPolicyBody());
    // The first gate: `policy:write` at the ORG (domainId omitted) — the component-scoped binding
    // is never reached, so the scope-authority check that would admit this caller never runs.
    expect(res.status).toBe(403);
    expect(String(res.body.detail ?? res.body.title)).toMatch(/policy:write/);
  });

  it("MEASURED: the SAME body WITH domainId = the component itself is 201 for that principal (any org object is accepted as domainId)", async () => {
    const res = await postPolicy(
      componentAdmin.token,
      subscriptionPolicyBody({ domainId: componentId })
    );
    expect(res.status).toBe(201);
  });

  it("MEASURED: with domainId = the component's containment domain, a binding AT the component still 403s (upward-only), a binding AT that domain is 201, and that domain-bound principal WITHOUT domainId is 403", async () => {
    // A binding at the component is BELOW the domain scope; the first gate refuses.
    const res = await postPolicy(
      componentAdmin.token,
      subscriptionPolicyBody({ domainId: containmentDomainId })
    );
    expect(res.status).toBe(403);

    // The shape the M21.6 web client relies on: `domainId` = `component.domainId`, from a principal
    // bound at that domain -> 201.
    const domainAdmin = await createTestUser(server, org, [
      { role: "Administrator", scope: containmentDomainId }
    ]);
    const ok = await postPolicy(
      domainAdmin.token,
      subscriptionPolicyBody({ domainId: containmentDomainId })
    );
    expect(ok.status).toBe(201);
    // …and that same principal WITHOUT domainId meets the first gate at the ORG and is refused —
    // the ordering, seen from one rung up.
    const noDomain = await postPolicy(domainAdmin.token, subscriptionPolicyBody());
    expect(noDomain.status).toBe(403);
  });

  it("CONTROL: the org-root admin creates the same policy with or without domainId (the ordering is invisible from the org root)", async () => {
    expect((await postPolicy(org.adminToken, subscriptionPolicyBody())).status).toBe(201);
    expect(
      (await postPolicy(org.adminToken, subscriptionPolicyBody({ domainId: componentId }))).status
    ).toBe(201);
  });
});

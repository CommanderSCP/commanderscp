import { describe, expect, it } from "vitest";
import { CreateServiceObjectRequestSchema, ServiceObjectSchema } from "./objects.js";

describe("service object schemas", () => {
  it("accepts a well-formed create request", () => {
    expect(CreateServiceObjectRequestSchema.safeParse({ name: "billing" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(CreateServiceObjectRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  /** A complete `service` object on the wire: every `GraphObject` field plus M0's `type`. */
  function wellFormedServiceObject(): Record<string, unknown> {
    return {
      id: "0198f2a0-0000-7000-8000-000000000001",
      orgId: "0198f2a0-0000-7000-8000-000000000002",
      domainId: "0198f2a0-0000-7000-8000-000000000003",
      typeId: "service",
      type: "service",
      name: "billing",
      urn: "urn:scp:0198f2a0-0000-7000-8000-000000000002:service:billing",
      properties: {},
      labels: {},
      originDomainId: "0198f2a0-0000-7000-8000-000000000004",
      revision: 1,
      provenance: null,
      // M20.1 (ADR-0031) — required on the wire and always present, so this fixture must carry it
      // to keep its own "every `GraphObject` field" claim true. `false` is the ordinary case: an
      // object that federates normally, which is what the rest of this fixture describes.
      domainLocal: false,
      version: 1,
      createdAt: "2026-07-08T12:00:00.000Z",
      updatedAt: "2026-07-08T12:00:00.000Z",
      deletedAt: null
    };
  }

  it("validates a well-formed service object", () => {
    expect(ServiceObjectSchema.safeParse(wellFormedServiceObject()).success).toBe(true);
  });

  it("keeps M0's `type` discriminator required — widening must stay additive", () => {
    const { type: _dropped, ...withoutType } = wellFormedServiceObject();
    expect(ServiceObjectSchema.safeParse(withoutType).success).toBe(false);
  });

  it("REJECTS the pre-ADR-0023 five-field subset", () => {
    // The shape `POST /objects/service` used to return. It is a contract violation: that route
    // shadows the generic `POST /objects/{type}`, whose declared response is a full `GraphObject`,
    // so `client.object("service").create(...).urn` was `undefined` while typed `string`
    // (docs/adr/0023-sdk-response-validation.md §5).
    const result = ServiceObjectSchema.safeParse({
      id: "0198f2a0-0000-7000-8000-000000000001",
      orgId: "0198f2a0-0000-7000-8000-000000000002",
      type: "service",
      name: "billing",
      createdAt: "2026-07-08T12:00:00.000Z"
    });
    expect(result.success).toBe(false);
    const missing = result.error?.issues.map((i) => i.path.join(".")) ?? [];
    expect(missing).toContain("urn");
    expect(missing).toContain("typeId");
    expect(missing).toContain("domainId");
  });
});

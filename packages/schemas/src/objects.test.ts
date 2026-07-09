import { describe, expect, it } from "vitest";
import { CreateServiceObjectRequestSchema, ServiceObjectSchema } from "./objects.js";

describe("service object schemas", () => {
  it("accepts a well-formed create request", () => {
    expect(CreateServiceObjectRequestSchema.safeParse({ name: "billing" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(CreateServiceObjectRequestSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("validates a well-formed service object", () => {
    const result = ServiceObjectSchema.safeParse({
      id: "0198f2a0-0000-7000-8000-000000000001",
      orgId: "0198f2a0-0000-7000-8000-000000000002",
      type: "service",
      name: "billing",
      createdAt: "2026-07-08T12:00:00.000Z"
    });
    expect(result.success).toBe(true);
  });
});

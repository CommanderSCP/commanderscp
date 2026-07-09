import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./objects-service.js";

describe("cursor pagination codec", () => {
  it("round-trips createdAt + id", () => {
    const row = {
      createdAt: new Date("2026-07-08T12:00:00.000Z"),
      id: "0198f2a0-0000-7000-8000-000000000001"
    };
    const cursor = encodeCursor(row);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(row.id);
    expect(decoded?.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it("rejects malformed cursors instead of throwing", () => {
    expect(decodeCursor("not-a-real-cursor")).toBeNull();
    expect(
      decodeCursor(Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url"))
    ).toBeNull();
  });
});

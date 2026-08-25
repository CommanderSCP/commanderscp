import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePointer } from "./sse-bridge.js";

/**
 * The NOTIFY-payload gate (review findings SEC-1 cheap-fetch leg + SEC-3 log injection). Every
 * legitimate pointer id is an `outbox.id` (`uuid`), so anything not UUID-shaped cannot back a row
 * and must be rejected BEFORE it reaches the pool or a log line. This pins that the payload gate
 * is a UUID gate, not just a `typeof === "string"` gate.
 */
describe("sse-bridge parsePointer — UUID gate", () => {
  it("accepts a well-formed {id, orgId} and carries orgId as a hint", () => {
    const id = randomUUID();
    const orgId = randomUUID();
    expect(parsePointer({ id, orgId })).toEqual({ id, orgHint: orgId });
  });

  it("accepts a valid id with no orgId — hint is simply absent", () => {
    const id = randomUUID();
    expect(parsePointer({ id })).toEqual({ id, orgHint: undefined });
  });

  it("REJECTS a non-UUID id (would otherwise cost a full connect+SELECT to fail on 22P02)", () => {
    expect(parsePointer({ id: "not-a-uuid", orgId: randomUUID() })).toBeUndefined();
  });

  it("REJECTS an id carrying a newline (CRLF log-injection vector) even if otherwise long", () => {
    const injected = `${randomUUID()}\n{"level":30,"msg":"forged log line"}`;
    expect(parsePointer({ id: injected })).toBeUndefined();
  });

  it("REJECTS a numeric or missing id", () => {
    expect(parsePointer({ id: 12345 })).toBeUndefined();
    expect(parsePointer({ orgId: randomUUID() })).toBeUndefined();
    expect(parsePointer({})).toBeUndefined();
    expect(parsePointer(null)).toBeUndefined();
    expect(parsePointer("string")).toBeUndefined();
  });

  it("drops a non-UUID orgId hint to undefined (never trusted, never compared as-is)", () => {
    const id = randomUUID();
    expect(parsePointer({ id, orgId: "../../etc" })).toEqual({ id, orgHint: undefined });
    expect(parsePointer({ id, orgId: 999 })).toEqual({ id, orgHint: undefined });
  });
});

import { describe, expect, it } from "vitest";
import {
  apiPathOf,
  isDeclaredOperation,
  loadOpenApiDocument,
  operationsOf,
  templateToRegExp,
  undeclaredCalls,
  unexpectedCalls
} from "./openapi-conformance.js";

/** M16.2 phase B (B4) — the no-bypass MATCHER, unit-tested on every PR. See docs/web.md §15. */

const doc = loadOpenApiDocument();
const operations = operationsOf(doc);

describe("openapi conformance: the matcher can actually reject", () => {
  it("accepts the operations the Outposts UI depends on", () => {
    for (const call of [
      { method: "GET", path: "/federation/status" },
      { method: "GET", path: "/federation/outposts" },
      { method: "GET", path: "/federation/self" },
      { method: "PATCH", path: "/federation/peers/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" },
      { method: "PATCH", path: "/federation/outposts/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" },
      {
        method: "POST",
        path: "/federation/outposts/1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e/reconcile"
      }
    ]) {
      expect(isDeclaredOperation(operations, call), `${call.method} ${call.path}`).toBe(true);
    }
  });

  it("REJECTS a path the contract does not declare", () => {
    expect(
      isDeclaredOperation(operations, { method: "GET", path: "/federation/not-an-operation" })
    ).toBe(false);
    expect(undeclaredCalls(operations, [{ method: "GET", path: "/made/up" }])).toEqual([
      { method: "GET", path: "/made/up" }
    ]);
  });

  it("REJECTS a declared path under the wrong METHOD", () => {
    // `/federation/status` is GET-only. A sweep that ignored the method would wave through a write
    // to a read endpoint.
    expect(isDeclaredOperation(operations, { method: "DELETE", path: "/federation/status" })).toBe(
      false
    );
  });

  it("a template parameter matches ONE segment, never a deeper path", () => {
    const pattern = templateToRegExp("/federation/outposts/{peerDomainId}");
    expect(pattern.test("/federation/outposts/abc")).toBe(true);
    // THE BUG THIS FORBIDS: `.+` instead of `[^/]+` would make one templated route a wildcard that
    // declares every undeclared path beneath it.
    expect(pattern.test("/federation/outposts/abc/undeclared")).toBe(false);
    expect(pattern.test("/federation/outposts")).toBe(false);
  });

  it("recognises API calls and ignores the SPA's own assets", () => {
    expect(apiPathOf("http://localhost:1234/api/v1/federation/status")).toBe("/federation/status");
    expect(apiPathOf("http://localhost:1234/api/v1/federation/outposts/x/reconcile?keep=y")).toBe(
      "/federation/outposts/x/reconcile"
    );
    expect(apiPathOf("http://localhost:1234/federation/outposts")).toBeNull();
    expect(apiPathOf("http://localhost:1234/assets/index-abc123.js")).toBeNull();
  });

  /** THE EXEMPTION IS GONE, and this is what replaced it. See docs/web.md §16. */
  it("accepts the SSE stream as a DECLARED operation — no carve-out involved", () => {
    const sse = { method: "GET", path: "/events/stream" };
    expect(isDeclaredOperation(operations, sse)).toBe(true);
    expect(undeclaredCalls(operations, [sse])).toEqual([]);
    expect(unexpectedCalls(operations, [sse])).toEqual([]);
  });

  it("exempts nothing at all — an undeclared call is unexpected, whatever it is", () => {
    const madeUp = { method: "GET", path: "/made/up" };
    // The stream is GET-only; the old exemption was one operation, and now there is none.
    expect(unexpectedCalls(operations, [{ method: "POST", path: "/events/stream" }])).toEqual([
      { method: "POST", path: "/events/stream" }
    ]);
    expect(unexpectedCalls(operations, [madeUp])).toEqual([madeUp]);
    expect(
      unexpectedCalls(operations, [
        { method: "GET", path: "/events/stream" },
        { method: "GET", path: "/federation/status" }
      ])
    ).toEqual([]);
  });

  it("PREMISE: the document really was loaded and really has operations", () => {
    // Without this, every assertion above could be passing over an empty list.
    expect(operations.length).toBeGreaterThan(50);
    expect(operations.some((op) => op.template === "/federation/outposts/{peerDomainId}")).toBe(
      true
    );
  });
});

import { describe, expect, it } from "vitest";
import { isScopedHttpResponseTooLargeError, scopedHttpResponseTooLargeError } from "./index.js";

/** The one runtime surface this interface package carries. See docs/plugin-api.md §26. */
describe("scopedHttpResponseTooLargeError / isScopedHttpResponseTooLargeError", () => {
  it("builds an Error carrying responseTooLarge/limitBytes/url, and the message names the limit", () => {
    const err = scopedHttpResponseTooLargeError("https://gitea.example.com/x", 4096);
    expect(err).toBeInstanceOf(Error);
    expect(err.responseTooLarge).toBe(true);
    expect(err.limitBytes).toBe(4096);
    expect(err.url).toBe("https://gitea.example.com/x");
    expect(err.message).toContain("4096");
    expect(err.message).toContain("https://gitea.example.com/x");
    expect(err.message.toLowerCase()).toContain("aborted mid-stream");
  });

  it("isScopedHttpResponseTooLargeError recognizes only ITS OWN product", () => {
    const ours = scopedHttpResponseTooLargeError("https://x", 10);
    expect(isScopedHttpResponseTooLargeError(ours)).toBe(true);

    // NEGATIVE CONTROLS — an ordinary error, a look-alike plain object with the wrong value, and
    // the usual non-object inputs must all read as false, not throw.
    expect(isScopedHttpResponseTooLargeError(new Error("boom"))).toBe(false);
    expect(isScopedHttpResponseTooLargeError({ responseTooLarge: "true" })).toBe(false);
    expect(isScopedHttpResponseTooLargeError({ responseTooLarge: false })).toBe(false);
    expect(isScopedHttpResponseTooLargeError(null)).toBe(false);
    expect(isScopedHttpResponseTooLargeError(undefined)).toBe(false);
    expect(isScopedHttpResponseTooLargeError("responseTooLarge")).toBe(false);
  });
});

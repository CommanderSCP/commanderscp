import { describe, expect, it } from "vitest";
import { STUB } from "./index.js";

/** This package is a walking-skeleton scaffold with no behaviour. See docs/plugins.md §248. */
describe("@scp/plugin-local-auth (M0 scaffold)", () => {
  it("is a scaffold: the package builds and exports its stub marker, and nothing more", () => {
    expect(STUB).toBe(true);
  });
});

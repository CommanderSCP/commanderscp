import { describe, expect, it } from "vitest";
import type { TenantTx } from "../db/tenant-tx.js";
import { resolveScannersForType } from "./scanner-registry.js";

/**
 * M13.3a — `resolveScannersForType` unit tests (ADR-0020 §2). The table read is driven through a
 * STUB `tx` returning canned rows, so the resolution/parsing behaviour is testable without a
 * database (the real seeded-table read is proven in the integration suite). What matters here is the
 * mapping from a stored `methods` jsonb to the returned `ScanMethod[]`, and the fail-closed `[]`
 * meanings.
 */

/** A minimal `TenantTx` whose only `execute` returns the given rows for `methods`. */
function stubTx(rows: Array<{ methods: unknown }>): TenantTx {
  return {
    execute: async () => ({ rows })
  } as unknown as TenantTx;
}

describe("resolveScannersForType", () => {
  it("returns the assigned methods for a seeded type", async () => {
    const methods = await resolveScannersForType(stubTx([{ methods: ["trivy"] }]), "image");
    expect(methods).toEqual(["trivy"]);
  });

  it("returns [] for an EMPTY assignment (configuration -> no managed scanner)", async () => {
    const methods = await resolveScannersForType(stubTx([{ methods: [] }]), "configuration");
    expect(methods).toEqual([]);
  });

  it("returns [] for an UNKNOWN type (no row) — fail-closed, not a throw", async () => {
    const methods = await resolveScannersForType(stubTx([]), "not-a-real-type");
    expect(methods).toEqual([]);
  });

  it("preserves multi-method assignments and de-duplicates", async () => {
    const methods = await resolveScannersForType(
      stubTx([{ methods: ["trivy", "openscap", "trivy"] }]),
      "image"
    );
    expect(methods.sort()).toEqual(["openscap", "trivy"]);
  });

  it("drops invalid/garbage method entries rather than throwing (version-skew safety)", async () => {
    const methods = await resolveScannersForType(
      stubTx([{ methods: ["trivy", "grype", 42, null] }]),
      "image"
    );
    expect(methods).toEqual(["trivy"]);
  });

  it("returns [] when the stored methods value is not an array", async () => {
    const methods = await resolveScannersForType(stubTx([{ methods: "trivy" }]), "image");
    expect(methods).toEqual([]);
  });
});

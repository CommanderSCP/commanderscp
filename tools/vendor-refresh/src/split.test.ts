import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_PART_BYTES,
  partFileName,
  splitAtDocumentBoundaries,
  splitIntoNamedParts
} from "./split.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

describe("splitAtDocumentBoundaries", () => {
  it("returns the whole input as one part when it is already small", () => {
    const raw = "a: 1\n---\nb: 2\n---\nc: 3";
    expect(splitAtDocumentBoundaries(raw)).toEqual([raw]);
  });

  it("never splits mid-document — every part is a whole number of the original documents", () => {
    const big = "x".repeat(MAX_PART_BYTES);
    const docs = [big, big, "small: true"];
    const raw = docs.join("\n---\n");
    const parts = splitAtDocumentBoundaries(raw);
    expect(parts.length).toBeGreaterThan(1);
    // Every part, re-split on the same separator, is a contiguous run of whole original documents —
    // never a byte fragment of one.
    const reconsumed = parts.flatMap((part) => part.split("\n---\n"));
    expect(reconsumed).toEqual(docs);
  });

  it("rejoining with \\n---\\n reproduces the original byte-for-byte, for many shapes", () => {
    const shapes = [
      "one: doc",
      "a: 1\n---\nb: 2",
      Array.from({ length: 500 }, (_, i) => `doc: ${i}\nfield: ${"y".repeat(20_000)}`).join(
        "\n---\n"
      ),
      "" // the empty-string edge: split("\n---\n") on "" yields [""]
    ];
    for (const raw of shapes) {
      const parts = splitAtDocumentBoundaries(raw);
      expect(parts.join("\n---\n")).toBe(raw);
    }
  });

  it("keeps every part at or under MAX_PART_BYTES when any single document allows it", () => {
    const doc = "field: " + "z".repeat(500_000); // ~500KB per document
    const raw = Array.from({ length: 20 }, () => doc).join("\n---\n");
    const parts = splitAtDocumentBoundaries(raw);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(MAX_PART_BYTES);
    }
  });

  it("a single document bigger than the limit becomes its own oversized part rather than being cut", () => {
    const hugeDoc = "field: " + "w".repeat(MAX_PART_BYTES + 1000);
    const raw = `small: true\n---\n${hugeDoc}`;
    const parts = splitAtDocumentBoundaries(raw);
    expect(parts).toEqual(["small: true", hugeDoc]);
  });

  it("is deterministic: the same input always splits into the same parts", () => {
    const raw = Array.from(
      { length: 50 },
      (_, i) => `doc: ${i}\n` + "pad: " + "p".repeat(90_000)
    ).join("\n---\n");
    expect(splitAtDocumentBoundaries(raw)).toEqual(splitAtDocumentBoundaries(raw));
  });
});

describe("partFileName", () => {
  it("zero-pads to two digits, matching the files already in the tree", () => {
    expect(partFileName(1, 4)).toBe("install-part-01.yaml");
    expect(partFileName(4, 4)).toBe("install-part-04.yaml");
    expect(partFileName(10, 12)).toBe("install-part-10.yaml");
  });

  it("refuses a split that would need 3+ digit part numbers rather than mis-naming it", () => {
    expect(() => partFileName(1, 100)).toThrow(/3\+ digit/);
  });
});

describe("splitIntoNamedParts", () => {
  it("names parts install-part-01.yaml.. in order and they still rejoin to the input", () => {
    const doc = "field: " + "q".repeat(500_000);
    const raw = Array.from({ length: 12 }, () => doc).join("\n---\n");
    const named = splitIntoNamedParts(raw);
    expect(named.length).toBeGreaterThan(1);
    expect(named.map((p) => p.name)).toEqual(
      named.map((_, i) => `install-part-${String(i + 1).padStart(2, "0")}.yaml`)
    );
    expect(named.map((p) => p.content).join("\n---\n")).toBe(raw);
  });

  it("reproduces the REAL argo-workflows split already in the tree at the same cut count shape", () => {
    // Not a re-derivation of the exact historical byte cuts (MAX_PART_BYTES here need not equal
    // whatever ad hoc threshold produced the original four files) — a property check that the
    // function this tool will actually run against a full argo-workflows install.yaml produces a
    // reassembling, correctly-named split of a similar order of magnitude.
    const vendorDir = resolve(REPO_ROOT, "deploy/helm-bundled/vendor/argo-workflows");
    const partNames = readdirSync(vendorDir)
      .filter((f) => /^install-part-\d+\.yaml$/.test(f))
      .sort();
    expect(partNames.length).toBeGreaterThan(0);
    const whole = partNames.map((f) => readFileSync(resolve(vendorDir, f), "utf8")).join("\n---\n");
    const named = splitIntoNamedParts(whole);
    expect(named.map((p) => p.content).join("\n---\n")).toBe(whole);
    // Same order of magnitude of parts (upstream's install.yaml has not 10x'd in size).
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(20);
  });
});

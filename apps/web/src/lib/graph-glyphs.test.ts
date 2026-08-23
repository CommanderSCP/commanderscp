import { describe, expect, it } from "vitest";
import { glyphForType, hasGlyph } from "./graph-glyphs";

/**
 * The canvas glyphs are the SAME drawings as the React icons — this suite pins the contract that
 * makes that true (encoded data URI, white stroke, real path data) and the honest absence for
 * types with no mark. The drawings themselves are pinned by eye; what regresses silently is the
 * plumbing, so the plumbing is what gets tests.
 */
describe("graph glyphs: the marks travel into the canvas unchanged", () => {
  it("every marked type yields an encoded SVG data URI with a white stroke", () => {
    for (const type of ["service", "assembly", "component", "organization", "outpost"]) {
      const uri = glyphForType(type);
      expect(uri, type).toBeDefined();
      expect(uri!.startsWith("data:image/svg+xml;utf8,"), type).toBe(true);
      const svg = decodeURIComponent(uri!.slice("data:image/svg+xml;utf8,".length));
      expect(svg, type).toContain('stroke="#ffffff"');
      expect(svg, type).toContain('viewBox="0 0 24 24"');
      // Real geometry made it across — at least one drawable element with coordinates.
      expect(/<(path d="|rect x="|circle cx=")/.test(svg), type).toBe(true);
      // React's `key` prop is list bookkeeping, not SVG — it must not leak into the markup.
      expect(svg, type).not.toContain("key=");
    }
  });

  it("a type with no mark yields undefined — the node renders as before, never a broken image", () => {
    expect(glyphForType("deployment-target")).toBeUndefined();
    expect(glyphForType("something-custom")).toBeUndefined();
    expect(glyphForType(undefined)).toBeUndefined();
  });

  it("hasGlyph agrees with glyphForType", () => {
    for (const type of ["service", "assembly", "component", "team", undefined]) {
      expect(hasGlyph(type)).toBe(glyphForType(type) !== undefined);
    }
  });
});

import { describe, expect, it } from "vitest";
import { assignGroupColors, deriveGroupIds, shapeForType, sizeForType } from "./graph-visual";

/**
 * The owner's colour rule (2026-08-10): colour is decided at the HIGHEST LEVEL IN SCOPE — at org
 * level each service is its own colour; inside a service each assembly or directly-held component
 * is; inside an assembly each component is. `deriveGroupIds` claims all three are one rule, so all
 * three are asserted here against the same function rather than three code paths.
 */

const contains = (fromId: string, toId: string) => ({
  fromId,
  toId,
  typeId: "contains" as const
});

describe("deriveGroupIds: colour is decided at the highest level in scope", () => {
  // org -> service -> [assembly] -> component
  const objects = [
    { id: "svc-a" },
    { id: "svc-b" },
    { id: "asm-1" },
    { id: "comp-in-asm-1" },
    { id: "comp-in-asm-2" },
    { id: "comp-direct" }
  ];
  const edges = [
    contains("svc-a", "asm-1"),
    contains("asm-1", "comp-in-asm-1"),
    contains("asm-1", "comp-in-asm-2"),
    contains("svc-a", "comp-direct")
  ];

  it("ORG scope (no root): everything under a service takes that SERVICE's identity", () => {
    const g = deriveGroupIds(objects, edges, undefined);
    expect(g.get("asm-1")).toBe("svc-a");
    expect(g.get("comp-in-asm-1")).toBe("svc-a");
    expect(g.get("comp-direct")).toBe("svc-a");
    // A service with nothing above it groups as itself, which is what makes "each service a
    // different colour" fall out of the same rule.
    expect(g.get("svc-a")).toBe("svc-a");
    expect(g.get("svc-b")).toBe("svc-b");
  });

  it("SERVICE scope: the assembly and the direct component are DIFFERENT groups", () => {
    const g = deriveGroupIds(objects, edges, "svc-a");
    expect(g.get("asm-1")).toBe("asm-1");
    expect(g.get("comp-direct")).toBe("comp-direct");
    // Components inside the assembly inherit the assembly, not their own identity — otherwise
    // "each assembly is a colour" would be false the moment an assembly held two components.
    expect(g.get("comp-in-asm-1")).toBe("asm-1");
    expect(g.get("comp-in-asm-2")).toBe("asm-1");
    expect(g.get("comp-in-asm-1")).not.toBe(g.get("comp-direct"));
  });

  it("ASSEMBLY scope: each component inside it is its OWN group", () => {
    const g = deriveGroupIds(objects, edges, "asm-1");
    expect(g.get("comp-in-asm-1")).toBe("comp-in-asm-1");
    expect(g.get("comp-in-asm-2")).toBe("comp-in-asm-2");
    expect(g.get("comp-in-asm-1")).not.toBe(g.get("comp-in-asm-2"));
  });

  it("ignores non-containment edges — a consumes link must not decide colour", () => {
    const g = deriveGroupIds(
      [{ id: "a" }, { id: "b" }],
      [{ fromId: "a", toId: "b", typeId: "consumes" }],
      undefined
    );
    expect(g.get("b")).toBe("b");
  });

  it("terminates on a containment cycle instead of hanging the render", () => {
    const g = deriveGroupIds([{ id: "x" }, { id: "y" }], [contains("x", "y"), contains("y", "x")], undefined);
    expect(g.get("x")).toBeDefined();
    expect(g.get("y")).toBeDefined();
  });
});

describe("assignGroupColors", () => {
  it("is STABLE under input reordering — the same graph must not repaint between reloads", () => {
    const a = assignGroupColors(["svc-b", "svc-a", "svc-c"]);
    const b = assignGroupColors(["svc-c", "svc-b", "svc-a"]);
    for (const key of ["svc-a", "svc-b", "svc-c"]) {
      expect(a.get(key)).toBe(b.get(key));
    }
  });

  it("gives distinct groups distinct colours up to the palette size", () => {
    const colors = assignGroupColors(["a", "b", "c", "d"]);
    expect(new Set(colors.values()).size).toBe(4);
  });
});

describe("shape and size encode TYPE, independently of colour", () => {
  it("gives service, assembly and component three different shapes", () => {
    const shapes = ["service", "assembly", "component"].map(shapeForType);
    expect(new Set(shapes).size).toBe(3);
  });

  it("sizes descend with the containment rung", () => {
    expect(sizeForType("service")).toBeGreaterThan(sizeForType("assembly"));
    expect(sizeForType("assembly")).toBeGreaterThan(sizeForType("component"));
  });

  it("falls back rather than throwing for an unregistered type", () => {
    expect(shapeForType("something-new")).toBe(shapeForType(undefined));
    expect(sizeForType("something-new")).toBe(sizeForType(undefined));
  });
});

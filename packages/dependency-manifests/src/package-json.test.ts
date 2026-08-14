import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { parsePackageJson } from "./package-json.js";

/** A real-shaped workspace `package.json` — the same blocks this repo's own packages carry. */
const REAL_PACKAGE_JSON = `{
  "name": "@scp/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@scp/schemas": "workspace:*",
    "drizzle-orm": "0.36.4",
    "fastify": "^5.1.0",
    "pg-boss": "~10.1.5",
    "zod": ">=3.23.8 <4",
    "@acme/lib": "^2.0.0",
    "patched-thing": "git+https://github.com/acme/patched-thing.git#v1.2.3",
    "anything-goes": "*"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.0",
    "vitest": "^3.0.0"
  },
  "optionalDependencies": {
    "fsevents": "^2.3.3"
  },
  "peerDependencies": {
    "react": ">=18"
  },
  "bundledDependencies": ["drizzle-orm"]
}`;

describe("parsePackageJson", () => {
  const deps = parsePackageJson(REAL_PACKAGE_JSON);
  const byName = new Map(deps.map((d) => [d.coordinate, d]));

  it("reads dependencies, devDependencies and optionalDependencies and nothing else", () => {
    expect(byName.get("fastify")?.scope).toBe("runtime");
    expect(byName.get("typescript")?.scope).toBe("dev");
    expect(byName.get("fsevents")).toMatchObject({
      scope: "runtime",
      declaredIn: "optionalDependencies"
    });
    // peerDependencies are an assertion about the CONSUMER's tree, not something this component
    // installs; bundledDependencies is a name list already covered by `dependencies`.
    expect(byName.has("react")).toBe(false);
  });

  it("keeps scoped names verbatim — the URN-collision hazard of ADR-0032 Context 2", () => {
    // `@acme/lib`, `acme/lib` and `acme-lib` all slug to one URN. This string IS the identity, so
    // any lowercasing/hyphenating here would re-create the collision the projection table avoids.
    expect(byName.get("@acme/lib")?.coordinate).toBe("@acme/lib");
    expect(byName.get("@fastify/cors")?.coordinate).toBe("@fastify/cors");
    expect(byName.get("@types/node")?.coordinate).toBe("@types/node");
  });

  it("distinguishes an exact pin from a range instead of flattening both to 'a version'", () => {
    expect(byName.get("drizzle-orm")).toMatchObject({
      constraint: "pinned",
      declared: "0.36.4",
      version: { major: 0, minor: 36, patch: 4 }
    });
    expect(byName.get("fastify")).toMatchObject({
      constraint: "range",
      declared: "^5.1.0",
      version: { major: 5, minor: 1, patch: 0 }
    });
    expect(byName.get("pg-boss")?.constraint).toBe("range");
  });

  it("does not invent a comparable version for a compound range it cannot reduce", () => {
    const zod = byName.get("zod");
    expect(zod?.constraint).toBe("range");
    expect(zod?.declared).toBe(">=3.23.8 <4");
    // ">=3.23.8 <4" has two clauses; producing 3.23.8 for it would assert a floor as if it were the
    // declared version. Undefined is the honest answer.
    expect(zod?.version).toBeUndefined();
  });

  it("marks non-registry specifiers unresolved rather than parsing a version out of a URL", () => {
    expect(byName.get("@scp/schemas")).toMatchObject({
      constraint: "unresolved",
      declared: "workspace:*"
    });
    const patched = byName.get("patched-thing");
    expect(patched?.constraint).toBe("unresolved");
    // The URL fragment literally contains `v1.2.3`. Reading it would be a guess about a git ref.
    expect(patched?.version).toBeUndefined();
  });

  it("records '*' as unpinned and writes no declared text for it", () => {
    const any = byName.get("anything-goes");
    expect(any?.constraint).toBe("unpinned");
    expect(any?.declared).toBeUndefined();
    expect(any?.version).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a manifest with only devDependencies still yields them", () => {
    // Guards against a mutation that simply returned [] whenever `dependencies` is absent.
    const only = parsePackageJson('{"devDependencies":{"vitest":"^3.0.0"}}');
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ coordinate: "vitest", scope: "dev" });
  });

  it("throws on an unreadable manifest instead of returning an empty inventory", () => {
    // "declares nothing" and "could not be read" produce identical rows and mean opposite things;
    // collapsing them would silently DELETE a component's dependency set on the next ingestion.
    expect(() => parsePackageJson("{ not json")).toThrow(ManifestParseError);
    expect(() => parsePackageJson("[]")).toThrow(ManifestParseError);
    expect(() => parsePackageJson('{"dependencies": ["fastify"]}')).toThrow(ManifestParseError);
    expect(() => parsePackageJson('{"dependencies": {"fastify": 5}}')).toThrow(ManifestParseError);
    // NEGATIVE CONTROL: a genuinely empty manifest is NOT an error.
    expect(parsePackageJson('{"name":"x"}')).toEqual([]);
  });
});

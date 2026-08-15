import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { parseGoMod } from "./go-mod.js";

/**
 * A real-shaped `go.mod`: two `require` blocks (the direct/indirect split `go mod tidy` emits), a
 * single-line `require`, a `replace` BLOCK whose contents are line-shaped exactly like a require
 * block, plus `exclude`, `retract` and `toolchain`.
 */
const ARGO_SHAPED_GO_MOD = `module github.com/CommanderSCP/outpost-agent

go 1.22.5

toolchain go1.22.5

require github.com/pkg/errors v0.9.1

require (
	github.com/go-logr/logr v1.4.2
	github.com/prometheus/client_golang v1.19.1
	github.com/spf13/cobra v1.8.1
	github.com/stretchr/testify v1.9.0
	golang.org/x/sync v0.7.0
	// A comment inside the block, which go mod edit does write.
	k8s.io/apimachinery v0.30.2
)

require (
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	golang.org/x/sys v0.21.0 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)

replace (
	github.com/evil/module v1.0.0 => github.com/good/module v1.0.1
	k8s.io/client-go => k8s.io/client-go v0.30.2
)

exclude github.com/broken/thing v1.2.3

retract (
	v1.0.0 // Published by mistake.
)
`;

describe("parseGoMod", () => {
  const deps = parseGoMod(ARGO_SHAPED_GO_MOD);
  const coords = deps.map((d) => d.coordinate);

  it("reads both the single-line and the block form of require", () => {
    expect(coords).toContain("github.com/pkg/errors"); // single-line
    expect(coords).toContain("github.com/spf13/cobra"); // block
    expect(coords).toContain("k8s.io/apimachinery"); // block, after an interior comment
  });

  it("EXCLUDES // indirect requirements — the ADR-0032 §4 direct-only rule", () => {
    // These six are the transitive closure leaking into the file. Storing them would be storing an
    // SBOM by another name (ADR-0013).
    for (const indirect of [
      "github.com/beorn7/perks",
      "github.com/cespare/xxhash/v2",
      "github.com/davecgh/go-spew",
      "github.com/inconshreveable/mousetrap",
      "golang.org/x/sys",
      "google.golang.org/protobuf"
    ]) {
      expect(coords, indirect).not.toContain(indirect);
    }
  });

  it("NEGATIVE CONTROL: the direct requirements from the very same blocks ARE reported", () => {
    // Without this, "excludes indirect" would pass just as well if the parser returned nothing at
    // all — the vacuous-absence failure. Six direct requirements, exactly.
    expect(coords).toEqual([
      "github.com/pkg/errors",
      "github.com/go-logr/logr",
      "github.com/prometheus/client_golang",
      "github.com/spf13/cobra",
      "github.com/stretchr/testify",
      "golang.org/x/sync",
      "k8s.io/apimachinery"
    ]);
  });

  it("does not read replace / exclude / retract blocks as requirements", () => {
    expect(coords).not.toContain("github.com/evil/module");
    expect(coords).not.toContain("github.com/good/module");
    expect(coords).not.toContain("k8s.io/client-go");
    expect(coords).not.toContain("github.com/broken/thing");
    // `retract ( v1.0.0 )` is a bare version with no module path — a two-token check keeps it out.
    expect(coords).not.toContain("v1.0.0");
  });

  it("records the exact version, its comparable core, the scope and the line", () => {
    const cobra = deps.find((d) => d.coordinate === "github.com/spf13/cobra");
    expect(cobra).toMatchObject({
      ecosystem: "go",
      declared: "v1.8.1",
      constraint: "pinned",
      // go.mod expresses no dev/build distinction; every requirement is runtime.
      scope: "runtime",
      declaredIn: "require",
      version: { major: 1, minor: 8, patch: 1, precision: 3 }
    });
    expect(
      ARGO_SHAPED_GO_MOD.split("\n")[cobra?.line !== undefined ? cobra.line - 1 : -1]
    ).toContain("cobra");
  });

  it("keeps a pseudo-version parseable but suffixed, so it cannot be ordered against a release", () => {
    const [dep] = parseGoMod("require github.com/x/y v0.0.0-20240115120000-abc123def456\n");
    expect(dep?.version).toMatchObject({ major: 0, minor: 0, patch: 0 });
    expect(dep?.version?.suffix).toBe("-20240115120000-abc123def456");
  });

  it("mints nothing for a malformed require line rather than a half-built dependency", () => {
    expect(parseGoMod("require github.com/x/y\n")).toEqual([]);
    expect(parseGoMod("require\n")).toEqual([]);
  });

  it("does not mistake a module whose comment merely starts with the word indirectly", () => {
    const [dep] = parseGoMod("require github.com/x/y v1.0.0 // indirectlyRelated helper\n");
    // `indirect` is matched on a word boundary; `indirectlyRelated` is not the marker.
    expect(dep?.coordinate).toBe("github.com/x/y");
  });
});

/**
 * The fixture above has replace/exclude/retract blocks, but EVERY line in them is independently
 * rejected by `parseRequireLine`'s two-token rule — so the block-directive tracking and the token
 * rule were each other's alibi and neither was pinned. Replacing `block === "require"` with
 * `block !== undefined`, or deleting the `tokens.length > 2` check, left the whole suite green.
 *
 * These fixtures separate them: two-token lines inside non-`require` blocks (which the token rule
 * cannot catch) and an over-long line inside a `require` block (which the block tracking cannot).
 */
describe("parseGoMod — the two safety nets, pinned independently", () => {
  it("does not mint a requirement from a TWO-TOKEN line inside an exclude block", () => {
    // `go mod edit -exclude github.com/broken/thing@v1.2.3` writes exactly this. Two tokens — the
    // token rule passes it — so only the block directive keeps it out. Reading it would mint a
    // phantom DIRECT requirement on a module the component deliberately EXCLUDES.
    expect(parseGoMod("module m\n\nexclude (\n\tgithub.com/broken/thing v1.2.3\n)\n")).toEqual([]);
  });

  it("does not mint a requirement from a TWO-TOKEN line inside a retract block", () => {
    // A retract RANGE `[v1.1.0, v1.2.0]` splits into exactly two tokens as well.
    expect(parseGoMod("module m\n\nretract (\n\t[v1.1.0, v1.2.0]\n)\n")).toEqual([]);
  });

  it("does not mint a requirement from a TWO-TOKEN line inside a replace block", () => {
    // `go mod edit -dropreplace` leaves wildcard replaces of this shape behind in real files.
    expect(parseGoMod("module m\n\nreplace (\n\tgithub.com/a/b v1.0.0\n)\n")).toEqual([]);
  });

  it("NEGATIVE CONTROL: the identical two-token line inside a require block IS a requirement", () => {
    // Without this, the three assertions above would pass if the parser had stopped reading blocks
    // altogether — the vacuous-absence failure.
    expect(
      parseGoMod("module m\n\nrequire (\n\tgithub.com/broken/thing v1.2.3\n)\n").map(
        (d) => d.coordinate
      )
    ).toEqual(["github.com/broken/thing"]);
  });

  it("refuses a require line with MORE than two tokens", () => {
    // The other arm of the same check, and the one the fixture never reached. A `replace`-shaped
    // line is what arrives here if the block tracking above ever regresses.
    expect(parseGoMod("require github.com/a/b => github.com/c/d v1.0.1\n")).toEqual([]);
    expect(parseGoMod("module m\n\nrequire (\n\tgithub.com/x/y v1.0.0 v2.0.0\n)\n")).toEqual([]);
  });

  it("refuses input that is not a go.mod, rather than reporting an empty module", () => {
    // A 404 body or an unexpanded LFS pointer fetched upstream. Returning [] here is
    // indistinguishable from a module with no requirements, and Go is sequenced FIRST
    // (ADR-0032 §10), so the next pass would silently DELETE the component's Go inventory.
    expect(() => parseGoMod("<html>404 Not Found</html>")).toThrow(ManifestParseError);
    expect(() =>
      parseGoMod("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n")
    ).toThrow(ManifestParseError);
    expect(() => parseGoMod("")).toThrow(ManifestParseError);
    // NEGATIVE CONTROL: a real go.mod that genuinely requires nothing is NOT an error.
    expect(parseGoMod("module github.com/x/y\n\ngo 1.22.5\n")).toEqual([]);
  });
});

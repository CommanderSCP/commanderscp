import { describe, expect, it } from "vitest";
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

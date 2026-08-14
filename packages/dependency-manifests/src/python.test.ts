import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { parsePyprojectToml, parseRequirementsTxt } from "./python.js";

/** A real-shaped PEP 621 pyproject with a build-system table, extras and PEP 735 dev groups. */
const PEP621 = `[build-system]
requires = ["hatchling>=1.24.2", "hatch-vcs"]
build-backend = "hatchling.build"

[project]
name = "scp-outpost-tools"
version = "0.4.1"
description = """
A multi-line description, which exists here precisely because a line-oriented
scanner would trip over the [bracketed] text on the next line and mistake it
for a [table.header].
"""
requires-python = ">=3.11"
dependencies = [
  "httpx>=0.27,<0.29",
  "pydantic==2.8.2",
  "click",                       # no constraint at all
  "celery[redis]>=5.4",
  "tomli; python_version < '3.11'",
  "internal-widgets @ https://artifacts.example.internal/internal_widgets-1.4.0-py3-none-any.whl",
]

[project.optional-dependencies]
postgres = ["psycopg[binary]>=3.2"]
otel = ["opentelemetry-sdk>=1.26.0"]

[dependency-groups]
dev = ["pytest>=8.3", "ruff==0.6.2", {include-group = "lint"}]
lint = ["mypy>=1.11"]
`;

describe("parsePyprojectToml — PEP 621", () => {
  const deps = parsePyprojectToml(PEP621);
  const byName = new Map(deps.map((d) => [`${d.declaredIn}|${d.coordinate}`, d]));

  it("survives the multi-line string without mis-reading a bracketed line as a table header", () => {
    // If `[bracketed]`/`[table.header]` inside the description were taken as table headers, every
    // key after them would be attributed to a table that does not exist and `[project].dependencies`
    // would come back empty.
    expect(deps.some((d) => d.declaredIn === "project.dependencies")).toBe(true);
  });

  it("records declared-vs-pinned as different statements", () => {
    expect(byName.get("project.dependencies|pydantic")).toMatchObject({
      constraint: "pinned",
      declared: "==2.8.2",
      version: { major: 2, minor: 8, patch: 2 }
    });
    expect(byName.get("project.dependencies|httpx")).toMatchObject({
      constraint: "range",
      declared: ">=0.27,<0.29"
    });
    expect(byName.get("project.dependencies|click")).toMatchObject({ constraint: "unpinned" });
    expect(byName.get("project.dependencies|click")?.declared).toBeUndefined();
  });

  it("strips extras from the coordinate but keeps the fact on the record", () => {
    // `celery[redis]` and `celery` are the SAME distribution. Keying on the bracketed form would
    // split one package into two inventory identities and break the reverse query.
    const celery = byName.get("project.dependencies|celery");
    expect(celery?.coordinate).toBe("celery");
    expect(celery?.note).toContain("[redis]");
  });

  it("strips an environment marker without dropping the dependency", () => {
    // A conditionally-installed package still needs its bumps. The marker gated INSTALLATION, not
    // identity, and `tomli` itself carries no version constraint — so `unpinned`, and crucially not
    // absent and not a version scraped out of the marker's own `'3.11'`.
    const tomli = byName.get("project.dependencies|tomli");
    expect(tomli).toMatchObject({ constraint: "unpinned" });
    expect(tomli?.version).toBeUndefined();
  });

  it("marks a direct-reference URL unresolved rather than reading 1.4.0 out of the filename", () => {
    const w = byName.get("project.dependencies|internal-widgets");
    expect(w?.constraint).toBe("unresolved");
    expect(w?.version).toBeUndefined();
  });

  it("scopes build-system requires as build, and PEP 735 groups as dev", () => {
    expect(byName.get("build-system.requires|hatchling")?.scope).toBe("build");
    expect(byName.get("dependency-groups.dev|pytest")?.scope).toBe("dev");
    expect(byName.get("dependency-groups.lint|mypy")?.scope).toBe("dev");
    // `{include-group = "lint"}` is a reference to another group, not a package.
    expect(deps.some((d) => d.coordinate === "include-group")).toBe(false);
  });

  it("names the optional-dependencies GROUP rather than guessing a scope from it", () => {
    expect(byName.get("project.optional-dependencies.postgres|psycopg")).toMatchObject({
      scope: "runtime",
      constraint: "range"
    });
    expect(byName.get("project.optional-dependencies.otel|opentelemetry-sdk")).toBeDefined();
  });
});

/** A real-shaped Poetry project, including the traps: `python`, a git table, a legacy dev block. */
const POETRY = `[tool.poetry]
name = "legacy-service"
version = "1.9.0"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.32.3"
sqlalchemy = "2.0.32"
some-fork = {git = "https://github.com/acme/some-fork.git", rev = "abc1234"}
tricky = [{version = "^1.0", python = "<3.12"}, {version = "^2.0", python = ">=3.12"}]
anything = "*"

[tool.poetry.group.dev.dependencies]
pytest = "^8.3.2"

[tool.poetry.dev-dependencies]
black = "^24.8.0"
`;

describe("parsePyprojectToml — Poetry", () => {
  const deps = parsePyprojectToml(POETRY);
  const byName = new Map(deps.map((d) => [d.coordinate, d]));

  it("EXCLUDES the `python` interpreter constraint — it is not a package", () => {
    // Subscribing to "the 3.x line of python" would produce a commit changing the supported
    // interpreter range.
    expect(byName.has("python")).toBe(false);
  });

  it("NEGATIVE CONTROL: the real packages in that same table ARE reported", () => {
    expect(byName.get("requests")).toMatchObject({
      scope: "runtime",
      constraint: "range",
      declared: "^2.32.3",
      version: { major: 2, minor: 32, patch: 3 }
    });
    // Poetry's bare version means EXACTLY that version, unlike npm's caret default.
    expect(byName.get("sqlalchemy")?.constraint).toBe("pinned");
    expect(byName.get("anything")?.constraint).toBe("unpinned");
  });

  it("marks git and multiple-constraints specifiers unresolved", () => {
    expect(byName.get("some-fork")).toMatchObject({ constraint: "unresolved" });
    expect(byName.get("some-fork")?.version).toBeUndefined();
    expect(byName.get("tricky")).toMatchObject({ constraint: "unresolved" });
  });

  it("discovers group names from the document rather than a hard-coded list", () => {
    expect(byName.get("pytest")).toMatchObject({
      scope: "dev",
      declaredIn: "tool.poetry.group.dev.dependencies"
    });
    expect(byName.get("black")).toMatchObject({
      scope: "dev",
      declaredIn: "tool.poetry.dev-dependencies"
    });
  });

  it("throws rather than returning an empty inventory for something that is not TOML", () => {
    expect(() => parsePyprojectToml("<<< not toml >>>")).toThrow(ManifestParseError);
  });
});

/** A `pip-compile`-style requirements file: pinned, hashed, with options and continuations. */
const REQUIREMENTS = `#
# This file is autogenerated by pip-compile
#
--index-url https://pypi.internal.example/simple
-r base.txt
-e .

certifi==2024.7.4 \\
    --hash=sha256:c198e21b1289c2ab85ee4e67bb4b4ef3ead0892059901a8d5b622f24a1101e90
charset-normalizer==3.3.2
idna==3.7          # via requests
requests==2.32.3
urllib3>=1.21.1,<3
uvicorn[standard]==0.30.6
https://files.example.internal/wheels/thing-1.0-py3-none-any.whl
`;

describe("parseRequirementsTxt", () => {
  const deps = parseRequirementsTxt(REQUIREMENTS);
  const coords = deps.map((d) => d.coordinate);

  it("skips option lines instead of following them to another file", () => {
    // Following `-r base.txt` would be I/O, which this package never does; `-e .` is the component
    // itself.
    expect(coords).not.toContain("base.txt");
    expect(coords).not.toContain("-r");
    expect(coords).not.toContain(".");
  });

  it("NEGATIVE CONTROL: the real requirements in that same file ARE reported", () => {
    expect(coords).toEqual([
      "certifi",
      "charset-normalizer",
      "idna",
      "requests",
      "urllib3",
      "uvicorn"
    ]);
  });

  it("strips --hash fragments and line continuations", () => {
    expect(deps[0]).toMatchObject({
      coordinate: "certifi",
      declared: "==2024.7.4",
      constraint: "pinned"
    });
  });

  it("records pinned vs range distinctly, which is the whole point for this file type", () => {
    expect(deps.find((d) => d.coordinate === "requests")?.constraint).toBe("pinned");
    expect(deps.find((d) => d.coordinate === "urllib3")?.constraint).toBe("range");
  });

  it("does not infer a scope from the filename", () => {
    // requirements.txt expresses no scope; a `requirements-dev.txt` convention is a FILENAME, and
    // inferring from it is the provenance-label mistake.
    expect(deps.every((d) => d.scope === "runtime")).toBe(true);
  });

  it("drops a bare URL requirement, which names no distribution to key on", () => {
    expect(coords.some((c) => c.includes("http"))).toBe(false);
  });

  it("reports the line number of each requirement", () => {
    const lines = REQUIREMENTS.split("\n");
    for (const dep of deps) {
      expect(lines[(dep.line ?? 0) - 1]).toContain(dep.coordinate);
    }
  });
});

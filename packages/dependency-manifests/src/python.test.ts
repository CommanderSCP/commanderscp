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

  it("keeps distributions whose NAME merely begins with a URL scheme word", () => {
    // The bare-URL guard is a SCHEME test, not a prefix test. Unanchored, `/^(https?|git\+|file:)/i`
    // discarded every one of these — five real, widely-used PyPI packages — with no row, no note and
    // no error. `httpx` is in the pyproject fixture above, but that path never reaches this
    // prefilter, so the suite crossed the breaking code without touching it.
    const parsed = parseRequirementsTxt(
      "httpx==0.27.2\nhttpcore==1.0.5\nhttptools==0.6.1\nhttplib2==0.22.0\nhttpie==3.2.3\nrequests==2.32.3\n"
    );
    expect(parsed.map((d) => d.coordinate)).toEqual([
      "httpx",
      "httpcore",
      "httptools",
      "httplib2",
      "httpie",
      "requests"
    ]);
    // Same class, other schemes: `filelock` and `gitpython` are real packages too.
    expect(parseRequirementsTxt("filelock==3.15.4\ngitpython==3.1.43\n").map((d) => d.coordinate)) //
      .toEqual(["filelock", "gitpython"]);
  });

  it("NEGATIVE CONTROL: an actual URL or VCS line is still dropped", () => {
    // Without this the fix above would pass just as well if the guard had simply been deleted.
    expect(
      parseRequirementsTxt(
        "https://files.example.internal/wheels/thing-1.0-py3-none-any.whl\n" +
          "http://files.example.internal/wheels/other-1.0.whl\n" +
          "git+https://github.com/acme/thing.git@v1.2.3\n" +
          "git+ssh://git@github.com/acme/other.git\n" +
          "file:///opt/wheels/local-1.0.whl\n" +
          "./local-package\n" +
          "/opt/wheels/abs\n"
      )
    ).toEqual([]);
  });

  it("skips a pip OPTION line whose argument is itself a package name", () => {
    // `--only-binary`/`--no-binary` take a distribution list, so their argument is the one option
    // argument that would otherwise read as a requirement.
    //
    // HONEST NOTE on what this pins: there is exactly ONE mechanism now. The leading-`-` guard that
    // used to sit in `flush()` was provably unreachable (PEP508_RE is anchored on `[A-Za-z0-9]`, so
    // no `-` line could ever reach it) and has been deleted; this test pins the OBSERVABLE property,
    // and the invariant it depends on is documented on PEP508_RE where it is enforced. Said out loud
    // because a test that names a mechanism it does not exercise is the vacuous-test failure in its
    // most convincing form.
    const parsed = parseRequirementsTxt(
      "--only-binary numpy\n--no-binary pandas\n-c constraints.txt\n--find-links ./wheels\nnumpy==2.0.1\n"
    );
    expect(parsed.map((d) => d.coordinate)).toEqual(["numpy"]);
    expect(parsed[0]?.line).toBe(5);
  });

  it("drops ALL FOUR pip VCS schemes, not just git+", () => {
    // The class is "a pip VCS scheme prefix", not "git+". pip documents git, hg, svn and bzr (pip
    // docs, "VCS Support"); with only `git+` listed, the other three fell through to PEP508_RE and
    // minted distribution rows literally named `hg`, `svn` and `bzr` — phantom packages no index
    // resolves, attached to a real component. Asserted one scheme per line so a regression names
    // which scheme regressed instead of collapsing into one empty-array failure.
    for (const line of [
      "git+https://example.invalid/x.git@v1\n",
      "hg+https://example.invalid/x\n",
      "svn+https://example.invalid/y\n",
      "bzr+http://example.invalid/z\n",
      "git+ssh://git@example.invalid/x.git\n",
      "hg+ssh://hg@example.invalid/x\n"
    ]) {
      expect(parseRequirementsTxt(line), line).toEqual([]);
    }
  });

  it("NEGATIVE CONTROL: distributions whose names ARE those scheme words survive", () => {
    // Without this the fix above passes just as well if the guard grew into a prefix test again.
    // `svn`, `hgapi`, `bzrlib` and `gitpython` are all real PyPI distributions, and a component that
    // declares `svn==1.0.1` must still get a row — it is the drop-a-real-package failure the
    // httpx/httpcore case above was written for, one ecosystem-scheme over. `svn` is the sharp one:
    // the coordinate is the bare scheme word.
    expect(
      parseRequirementsTxt("svn==1.0.1\nhgapi==1.7.4\nbzrlib==2.7.0\ngitpython==3.1.43\n").map(
        (d) => d.coordinate
      )
    ).toEqual(["svn", "hgapi", "bzrlib", "gitpython"]);
  });

  it("NEGATIVE CONTROL: the two valid PEP 508 forms that also contain `+` and `:` survive", () => {
    // SCHEME_LINE_RE keys on `+`/`:` immediately after the leading token, so these are the inputs
    // that would break if it were loosened to "contains a `+` or `:`" — and both are ordinary:
    // a PEP 440 local version (`+cu118`, every CUDA wheel in existence) and a PEP 508 direct
    // reference, whose URL carries a `:` and whose specifier the parser deliberately leaves
    // unresolved rather than reading a version out of the path.
    const local = parseRequirementsTxt("torch==2.0.1+cu118\n");
    expect(local.map((d) => d.coordinate)).toEqual(["torch"]);
    expect(local[0]).toMatchObject({ declared: "==2.0.1+cu118", constraint: "pinned" });

    const direct = parseRequirementsTxt("widgets @ https://artifacts.invalid/widgets-1.4.0.whl\n");
    expect(direct.map((d) => d.coordinate)).toEqual(["widgets"]);
    expect(direct[0]?.constraint).toBe("unresolved");
  });

  it("refuses a scheme-shaped but MALFORMED line instead of naming a package after the scheme", () => {
    // Neither of these is a URL (no `//`, no scheme colon) and neither is valid PEP 508 (`+` and `:`
    // cannot follow a distribution name). Parsed as requirements they yield the coordinates `http`
    // and `git` — a distribution named after the scheme of the URL somebody meant to type.
    //
    // This behaviour was UNPINNED IN EITHER DIRECTION: HEAD dropped both by accident (the old
    // unanchored prefix test happened to catch them, while deleting httpx et al.), and narrowing the
    // regex to require the delimiter turned them into phantom rows with nothing to notice. The
    // deliberate choice is refusal, per `dockerfile.ts:209-214`: a wrong identity is worse than a
    // missing one, and the same one guard (SCHEME_LINE_RE) delivers both verdicts because the
    // OUTCOME for a well-formed and a malformed URL line is the same. Per-LINE refusal, not
    // ManifestParseError — see the next assertion.
    expect(parseRequirementsTxt("http:example\n")).toEqual([]);
    expect(parseRequirementsTxt("git+https//broken\n")).toEqual([]);
    expect(parseRequirementsTxt("https:/example.invalid/x.whl\n")).toEqual([]);

    // One malformed line does not mean the file is not a requirements.txt: the correctly-spelled
    // lines beside it keep their rows, and the line numbers stay true to the physical file.
    const mixed = parseRequirementsTxt("requests==2.32.3\nhttp:example\nurllib3>=1.21.1\n");
    expect(mixed.map((d) => d.coordinate)).toEqual(["requests", "urllib3"]);
    expect(mixed.map((d) => d.line)).toEqual([1, 3]);
  });
});

describe("parseRequirementsTxt — which clause of a multi-clause specifier is the version", () => {
  /**
   * ADR-0032 §7's "skipped rather than guessed" applied to PEP 440 specifiers.
   *
   * Nothing pinned the clause-selection rule before: no test asserted `version` for ANY multi-clause
   * specifier, so first-clause, last-clause and "whatever parses" were indistinguishable. The rule
   * is now: the clause that denotes a FLOOR, or undefined.
   */
  it("does not record an EXCLUDED version as the declared one", () => {
    // `packaging.SpecifierSet.__str__` sorts clauses, and `!` (0x21) sorts before `>` (0x3E), so
    // exclusion-first is what a pip-compile / PKG-INFO round-trip actually emits.
    const [dep] = parseRequirementsTxt("sqlalchemy!=1.4.0,>=1.3\n");
    expect(dep?.declared).toBe("!=1.4.0,>=1.3");
    // 1.4.0 is the one version this manifest FORBIDS. Recording it inverts the field.
    expect(dep?.version).toMatchObject({ major: 1, minor: 3, patch: 0, raw: "1.3" });
  });

  it("does not record an UPPER BOUND as the declared one", () => {
    // `<` (0x3C) also sorts before `>`, so ceiling-first is equally canonical.
    const [dep] = parseRequirementsTxt("urllib3<3,>=1.21.1\n");
    expect(dep?.version).toMatchObject({ major: 1, minor: 21, patch: 1, raw: "1.21.1" });
    // A detection tick that read 3.0.0 here reports "already at 3.0.0" for a component on 1.21.x
    // and never bumps it again.
    expect(dep?.version?.major).not.toBe(3);
  });

  it("returns UNDEFINED where no clause states a floor at all", () => {
    expect(parseRequirementsTxt("cryptography<43\n")[0]?.version).toBeUndefined();
    expect(parseRequirementsTxt("cryptography<=42.0.8\n")[0]?.version).toBeUndefined();
    expect(parseRequirementsTxt("cryptography!=42.0.0\n")[0]?.version).toBeUndefined();
    // The row itself still exists — only the version is withheld.
    expect(parseRequirementsTxt("cryptography<43\n")[0]).toMatchObject({
      coordinate: "cryptography",
      constraint: "range",
      declared: "<43"
    });
  });

  it("NEGATIVE CONTROL: every floor operator still yields its version", () => {
    const floors: ReadonlyArray<readonly [string, number]> = [
      [">=2.1.0", 2],
      [">2.1.0", 2],
      ["==2.1.0", 2],
      ["===2.1.0", 2],
      ["~=2.1.0", 2]
    ];
    for (const [spec, major] of floors) {
      expect(parseRequirementsTxt(`pkg${spec}\n`)[0]?.version, spec).toMatchObject({ major });
    }
    // …and the floor is found wherever it sits in the clause list.
    expect(parseRequirementsTxt("pkg>=2.1.0,<3\n")[0]?.version).toMatchObject({ minor: 1 });
    expect(parseRequirementsTxt("pkg<3,!=2.5.0,>=2.1.0\n")[0]?.version).toMatchObject({ minor: 1 });
  });

  it("applies the same rule to Poetry's own operators, which share the helper", () => {
    const poetry = parsePyprojectToml(
      '[tool.poetry.dependencies]\ncaret = "^2.32.3"\ntilde = "~1.4"\nbare = "2.0.32"\nceiling = "<3.0.0"\n'
    );
    const byName = new Map(poetry.map((d) => [d.coordinate, d]));
    expect(byName.get("caret")?.version).toMatchObject({ major: 2, minor: 32, patch: 3 });
    expect(byName.get("tilde")?.version).toMatchObject({ major: 1, minor: 4 });
    expect(byName.get("bare")?.version).toMatchObject({ major: 2, minor: 0, patch: 32 });
    expect(byName.get("ceiling")?.version).toBeUndefined();
  });
});

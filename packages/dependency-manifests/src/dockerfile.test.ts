import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./types.js";
import { parseDockerfile } from "./dockerfile.js";

/**
 * A genuine multi-stage build of the shape this repo's own root Dockerfile uses: a builder stage, a
 * vendored-tool stage pinned by digest, and a runtime stage that copies from both. The last two
 * `FROM`s reference STAGES, not images.
 */
const MULTI_STAGE = `# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22.11.0

FROM --platform=$BUILDPLATFORM node:22.11.0-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \\
 && pnpm install --frozen-lockfile \\
 && pnpm run build

FROM ghcr.io/sigstore/cosign/cosign@sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7 AS cosign

FROM build AS prune
RUN pnpm prune --prod

FROM node:22.11.0-bookworm-slim AS runtime
COPY --from=prune /app /app
COPY --from=cosign /ko-app/cosign /opt/scp/bin/cosign
CMD ["node", "dist/index.js"]
`;

describe("parseDockerfile — multi-stage", () => {
  const deps = parseDockerfile(MULTI_STAGE);

  it("does NOT report a FROM that references an earlier stage", () => {
    // `FROM build AS prune` names the stage declared by `FROM … AS build`. A naive parser reports a
    // dependency on an image called "build", which no registry has; a subscription on it would
    // either dangle forever or match an unrelated public image.
    expect(deps.map((d) => d.coordinate)).not.toContain("build");
    expect(deps.map((d) => d.coordinate)).not.toContain("prune");
  });

  it("reports exactly the three real images, in file order", () => {
    expect(deps.map((d) => d.coordinate)).toEqual([
      "node",
      "ghcr.io/sigstore/cosign/cosign",
      "node"
    ]);
  });

  it("ignores instruction flags such as --platform", () => {
    // `--platform=$BUILDPLATFORM` selects an architecture of the SAME dependency and must not be
    // mistaken for the image operand.
    expect(deps[0]).toMatchObject({ coordinate: "node", declared: "22.11.0-bookworm-slim" });
  });

  it("carries a digest pin as identity, with no tag invented for it", () => {
    const cosign = deps[1];
    expect(cosign).toMatchObject({
      coordinate: "ghcr.io/sigstore/cosign/cosign",
      constraint: "pinned",
      digest: "sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7"
    });
    expect(cosign?.declared).toBeUndefined();
    expect(cosign?.version).toBeUndefined();
  });

  it("classifies base images as build scope", () => {
    expect(deps.every((d) => d.scope === "build" && d.ecosystem === "oci")).toBe(true);
  });
});

describe("parseDockerfile — NEGATIVE CONTROL for the stage-reference case", () => {
  /**
   * The identical file, with the one difference that the third `FROM` names a genuine second image
   * (`alpine:3.19`) instead of the `build` stage.
   *
   * Without this control, "the stage reference yields no dependency" would pass just as well if the
   * parser dropped every third FROM, or every FROM whose operand lacks a slash, or simply returned
   * fewer results than it should. The control proves the exclusion is driven by stage-ness.
   */
  const WITH_REAL_SECOND_IMAGE = MULTI_STAGE.replace(
    "FROM build AS prune",
    "FROM alpine:3.19 AS prune"
  );

  it("yields the extra dependency once the stage reference becomes a real image", () => {
    const base = parseDockerfile(MULTI_STAGE);
    const control = parseDockerfile(WITH_REAL_SECOND_IMAGE);

    expect(base).toHaveLength(3);
    expect(control).toHaveLength(4);
    expect(control.map((d) => d.coordinate)).toContain("alpine");

    const alpine = control.find((d) => d.coordinate === "alpine");
    expect(alpine).toMatchObject({
      declared: "3.19",
      constraint: "pinned",
      version: { major: 3, minor: 19, patch: 0, precision: 2 }
    });
    // A two-component tag names a LINE, not a point; the receipt is on the record.
    expect(alpine?.note).toContain("moving tag");
  });

  it("still keeps the `prune` STAGE name out, even though its FROM is now a real image", () => {
    // `FROM alpine:3.19 AS prune` declares the stage; the later `COPY --from=prune` is not a FROM.
    expect(parseDockerfile(WITH_REAL_SECOND_IMAGE).map((d) => d.coordinate)).not.toContain("prune");
  });
});

describe("parseDockerfile — the owner's headline case", () => {
  it("reads FROM alpine:1.0 as a bumpable image line", () => {
    // proposal §6.3: alpine publishes 1.1, the subscription rewrites this line.
    const [dep] = parseDockerfile("FROM alpine:1.0\n");
    expect(dep).toMatchObject({
      ecosystem: "oci",
      coordinate: "alpine",
      declared: "1.0",
      constraint: "pinned",
      scope: "build",
      declaredIn: "FROM",
      line: 1,
      version: { major: 1, minor: 0, patch: 0, precision: 2 }
    });
  });
});

describe("parseDockerfile — the awkward reference forms", () => {
  it("records a bare FROM as unpinned and does NOT write 'latest' into declared", () => {
    const [dep] = parseDockerfile("FROM alpine\n");
    expect(dep).toMatchObject({ coordinate: "alpine", constraint: "unpinned" });
    expect(dep?.declared).toBeUndefined();
    expect(dep?.version).toBeUndefined();
    expect(dep?.note).toContain(":latest");
  });

  it("keeps BOTH a tag and a digest when both are present", () => {
    const [dep] = parseDockerfile(
      "FROM alpine:3.19@sha256:c5b1261d6d3e43071626931fc004f70149baeba2c8ec672bd4f27761f8e1ad6b\n"
    );
    expect(dep).toMatchObject({
      coordinate: "alpine",
      declared: "3.19",
      digest: "sha256:c5b1261d6d3e43071626931fc004f70149baeba2c8ec672bd4f27761f8e1ad6b",
      constraint: "pinned"
    });
  });

  it("reports an ARG-interpolated TAG as unresolved rather than resolving the ARG default", () => {
    const dockerfile = "ARG TAG=3.19\nFROM alpine:${TAG}\n";
    const [dep] = parseDockerfile(dockerfile);
    expect(dep).toMatchObject({ coordinate: "alpine", constraint: "unresolved" });
    // The default in the file is overridable with `docker build --build-arg TAG=edge`, so 3.19 is
    // a guess. It must not appear as the parsed version.
    expect(dep?.version).toBeUndefined();
    expect(dep?.note).toContain("build-arg");
  });

  it("reports an ARG-interpolated IMAGE NAME as wholly unresolved, verbatim", () => {
    const [dep] = parseDockerfile("ARG BASE=alpine\nFROM ${BASE}:3.19\n");
    expect(dep).toMatchObject({ coordinate: "${BASE}:3.19", constraint: "unresolved" });
    expect(dep?.version).toBeUndefined();
  });

  it("does not mis-split a shell-style default containing a colon", () => {
    // `${BASE:-alpine}` — a last-colon-wins split reports a package named "${BASE".
    const [dep] = parseDockerfile("FROM ${BASE:-alpine}\n");
    expect(dep?.coordinate).toBe("${BASE:-alpine}");
    expect(dep?.constraint).toBe("unresolved");
  });

  it("treats a registry port as a port, not a tag", () => {
    const [dep] = parseDockerfile("FROM localhost:5000/team/base:1.4.2\n");
    expect(dep).toMatchObject({
      coordinate: "localhost:5000/team/base",
      declared: "1.4.2",
      version: { major: 1, minor: 4, patch: 2 }
    });
  });

  it("carries an unparseable tag with NO version, never a string-ordered one (ADR-0032 §7)", () => {
    const deps = parseDockerfile("FROM alpine:latest\nFROM redis:stable-bookworm\n");
    expect(deps).toHaveLength(2);
    expect(deps.every((d) => d.version === undefined)).toBe(true);
    expect(deps[0]?.note).toContain("never string-ordered");
    // NEGATIVE CONTROL: the same call path on a well-formed tag DOES produce a version.
    expect(parseDockerfile("FROM alpine:3.19.1\n")[0]?.version).toMatchObject({ patch: 1 });
  });

  it("yields nothing for FROM scratch — there is no registry entry to bump", () => {
    expect(parseDockerfile("FROM scratch\nCOPY app /app\n")).toEqual([]);
  });

  it("handles lower-case keywords, `as` in any case, and comments between instructions", () => {
    const deps = parseDockerfile(
      "# build it\nfrom golang:1.22 as Builder\n\n# ship it\nFROM BUILDER\n"
    );
    expect(deps.map((d) => d.coordinate)).toEqual(["golang"]);
  });

  it("joins continued lines so a FROM split across lines is still one instruction", () => {
    const deps = parseDockerfile("FROM \\\n  alpine:3.19 \\\n  AS base\nFROM base\n");
    expect(deps.map((d) => d.coordinate)).toEqual(["alpine"]);
  });

  it("drops a comment INSIDE a continuation rather than splicing it into the instruction", () => {
    // The load-bearing case the comment-skip describes, and the one neither fixture contained: both
    // had comments only BETWEEN instructions, where stripping them changes nothing. Docker's own
    // parser drops a comment line mid-continuation.
    //
    // With the skip disabled the instruction breaks in two — `FROM alpine:3.19 # …` and a stray
    // `AS base` — so the stage `base` is never declared and the later `FROM base` is minted as a
    // phantom dependency on an image no registry has.
    const deps = parseDockerfile(
      "FROM alpine:3.19 \\\n# why this base and not the slim one\n  AS base\nFROM base\nRUN true\n"
    );
    expect(deps.map((d) => d.coordinate)).toEqual(["alpine"]);
    expect(deps[0]?.declared).toBe("3.19");
  });

  it("keeps a stage named after its own base image as a real dependency", () => {
    // `FROM alpine AS alpine` is ordinary style. Recording the stage name BEFORE testing this
    // instruction's own operand against the stage set made the FROM shadow itself and deleted a
    // genuine bumpable dependency. A stage cannot reference itself, so the test must run first.
    expect(parseDockerfile("FROM alpine AS alpine\nRUN true\n").map((d) => d.coordinate)) //
      .toEqual(["alpine"]);
    expect(parseDockerfile("FROM node:22 AS node\nRUN true\n").map((d) => d.coordinate)) //
      .toEqual(["node"]);
    // NEGATIVE CONTROL: a LATER FROM naming that stage is still correctly excluded — the stage does
    // shadow the image from the next instruction onward, which is Docker's own rule.
    expect(
      parseDockerfile("FROM alpine AS alpine\nFROM alpine\nRUN true\n").map((d) => d.coordinate)
    ).toEqual(["alpine"]);
  });

  it("refuses a malformed reference instead of minting a garbage row", () => {
    // An empty coordinate is an identity every malformed manifest in the org collides on, and an
    // empty digest recorded as `pinned` is a pin to nothing.
    expect(parseDockerfile("FROM :1.0\nRUN true\n")).toEqual([]);
    expect(parseDockerfile("FROM alpine@\nRUN true\n")).toEqual([]);
    expect(parseDockerfile("FROM alpine:\nRUN true\n")).toEqual([]);
    // NEGATIVE CONTROL: the well-formed spellings of each still parse.
    expect(parseDockerfile("FROM alpine:1.0\n")[0]?.coordinate).toBe("alpine");
    expect(parseDockerfile("FROM alpine@sha256:abc\n")[0]?.digest).toBe("sha256:abc");
  });

  it("does not tell an operator that a sha-pinned base image floats", () => {
    // `1a2b3c4d` is a git sha that happens to start with a digit — roughly six in ten do — and it
    // parses to precision 1. Labelling it "a moving tag: it names a line, not a point" is a note
    // named after WHICH BRANCH matched, and it is false: a sha names exactly one point. The same
    // branch also covered date stamps like `20240115`, where it is equally false.
    const sha = parseDockerfile("FROM alpine:1a2b3c4d\n")[0];
    expect(sha?.note).not.toContain("moving tag");
    expect(sha?.note).toContain("commit sha");
    const stamp = parseDockerfile("FROM alpine:20240115\n")[0];
    expect(stamp?.note).not.toContain("moving tag");
    expect(stamp?.note).toContain("date stamp");
    // NEGATIVE CONTROL: a tag that genuinely spells a partial version line still says so, and a
    // fully-specified one still carries no note at all.
    expect(parseDockerfile("FROM alpine:3.19\n")[0]?.note).toContain("moving tag");
    expect(parseDockerfile("FROM alpine:3.19.1\n")[0]?.note).toBeUndefined();
  });

  it("refuses input that is not a Dockerfile, rather than reporting no base image", () => {
    // `FROM` is the only required Dockerfile instruction, so its absence means a bad fetch — a 404
    // body, an HTML error page, an unexpanded LFS pointer. Returning [] is indistinguishable from
    // "declares no base image" and silently deletes the component's image inventory next pass.
    expect(() => parseDockerfile("<html>404 Not Found</html>")).toThrow(ManifestParseError);
    expect(() => parseDockerfile("")).toThrow(ManifestParseError);
    expect(() => parseDockerfile("# just a comment\nRUN true\n")).toThrow(ManifestParseError);
    // NEGATIVE CONTROL: a Dockerfile whose only FROM yields no dependency is NOT an error.
    expect(parseDockerfile("FROM scratch\nCOPY app /app\n")).toEqual([]);
  });
});

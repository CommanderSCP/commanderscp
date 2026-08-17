import { describe, expect, it } from "vitest";

import { parseKubernetesImages } from "./kubernetes-images.js";
import { ManifestParseError, type DeclaredDependency } from "./types.js";

/**
 * M21.7 — the Kubernetes/Helm image reader, trap by trap
 * (`docs/proposals/kubernetes-image-references.md` §2 shapes, §4 traps).
 *
 * EVERY ASSERTION NAMES THE SPECIFIC OUTCOME, never a count. "two declarations were returned" is
 * satisfied by two wrong ones, and the failure this parser exists to prevent — a version read
 * through YAML's coercion, an unreadable reference reported as absence — is invisible to a count.
 *
 * The one place a count DOES appear is as a negative control beside a named assertion: e.g. that a
 * file full of `imagePullPolicy`/`imagePullSecrets` keys yields NOTHING, which is what proves the
 * exact-key rule is doing work rather than the fixture being uninteresting.
 */

/** The entry for one coordinate, or `undefined`. Assertions name the entry they mean. */
const at = (declarations: readonly DeclaredDependency[], coordinate: string) =>
  declarations.find((d) => d.coordinate === coordinate);

describe("parseKubernetesImages — the shapes that ARE read (§2.1)", () => {
  it("A: one scalar `image: repo/name:tag` is a pinned oci declaration on the same line", () => {
    const [entry, ...rest] = parseKubernetesImages('image: "acme/api:1.2.3"\n');
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      ecosystem: "oci",
      coordinate: "acme/api",
      declared: "1.2.3",
      constraint: "pinned",
      scope: "runtime",
      declaredIn: "image",
      line: 1
    });
    expect(entry?.version?.raw).toBe("1.2.3");
  });

  it("A: splits registry ports and digests with the SAME rules the Dockerfile parser uses", () => {
    // Not a second splitter: `localhost:5000/foo:1.2` is a port plus a tag, and the `@` is cut
    // before the colon so a digest's own `algo:hex` colon is not read as a tag separator. A second
    // implementation is how two parsers come to place one image on two different lines.
    const port = at(parseKubernetesImages("image: localhost:5000/foo:1.2\n"), "localhost:5000/foo");
    expect(port?.declared).toBe("1.2");
    const both = at(parseKubernetesImages("image: acme/api:1.2.3@sha256:abc123\n"), "acme/api");
    expect(both?.declared).toBe("1.2.3");
    expect(both?.digest).toBe("sha256:abc123");
  });

  it("B: `image: {repository, tag}` is read, and the note says no single line carries both", () => {
    const entry = at(
      parseKubernetesImages("image:\n  repository: acme/api\n  tag: 1.2.3\n"),
      "acme/api"
    );
    expect(entry?.constraint).toBe("pinned");
    expect(entry?.declared).toBe("1.2.3");
    // The coordinate is on the `repository` line and the version on the `tag` line, which is
    // exactly why this shape cannot be bumped by a single-changed-line verifier. Reported, not
    // hidden.
    expect(entry?.note).toContain("no single line of this file carries both");
    expect(entry?.declaredIn).toBe("image.tag");
  });

  it("C: `{registry, repository, tag}` joins ONE `/`, and says the coordinate is constructed", () => {
    const entry = at(
      parseKubernetesImages("image:\n  registry: ghcr.io\n  repository: acme/api\n  tag: 1.2.3\n"),
      "ghcr.io/acme/api"
    );
    expect(entry?.declared).toBe("1.2.3");
    // The joined coordinate appears NOWHERE contiguously in the file. An operator reading a refused
    // bump must be able to learn that from the inventory rather than from the verifier.
    expect(entry?.note).toContain("appears nowhere contiguously");
  });

  it("D: a tag AND a digest are both carried, and neither is derived from the other", () => {
    const entry = at(
      parseKubernetesImages(
        "image:\n  repository: acme/api\n  tag: 1.2.3\n  digest: sha256:deadbeef\n"
      ),
      "acme/api"
    );
    // Tag is a mutable label; the digest is identity. Collapsing them loses one of the two facts.
    expect(entry?.declared).toBe("1.2.3");
    expect(entry?.digest).toBe("sha256:deadbeef");
  });

  it("D: a digest-only pin is `pinned` with NO comparable version, so it mints no line", () => {
    const entry = at(parseKubernetesImages("image: acme/api@sha256:deadbeef\n"), "acme/api");
    expect(entry?.constraint).toBe("pinned");
    expect(entry?.digest).toBe("sha256:deadbeef");
    expect(entry?.declared).toBeUndefined();
    expect(entry?.version).toBeUndefined();
  });

  it("reads a POD SPEC the same way it reads chart values — one walk, no per-convention branch", () => {
    // §3: raw manifests are out of the parser table this round because they are UNADDRESSABLE, not
    // because the shape is hard. The parser is written shape-complete so turning them on later is a
    // registration decision rather than parser work — and this is what says so.
    const declarations = parseKubernetesImages(
      [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "spec:",
        "  template:",
        "    spec:",
        "      initContainers:",
        "        - name: init",
        "          image: busybox:1.36.1",
        "      containers:",
        "        - name: web",
        "          image: ghcr.io/acme/web:2.1.0",
        "      ephemeralContainers:",
        "        - image: acme/debug:0.4.0"
      ].join("\n")
    );
    expect(at(declarations, "busybox")?.declaredIn).toBe(
      "spec.template.spec.initContainers[0].image"
    );
    expect(at(declarations, "ghcr.io/acme/web")?.declaredIn).toBe(
      "spec.template.spec.containers[0].image"
    );
    expect(at(declarations, "acme/debug")?.declared).toBe("0.4.0");
  });

  it("reads a CronJob's doubly-nested pod template", () => {
    const entry = at(
      parseKubernetesImages(
        [
          "kind: CronJob",
          "spec:",
          "  jobTemplate:",
          "    spec:",
          "      template:",
          "        spec:",
          "          containers:",
          "            - image: acme/cron:1.0.1"
        ].join("\n")
      ),
      "acme/cron"
    );
    expect(entry?.declaredIn).toBe("spec.jobTemplate.spec.template.spec.containers[0].image");
  });
});

describe("T1 — YAML coerces the version away, and declared_version is an EDIT TARGET", () => {
  it('`tag: 1.20` is declared as "1.20", not as the number 1.2 YAML parses it to', () => {
    // THE TRAP THAT SILENTLY CORRUPTS AN EDIT TARGET. `component_dependencies.declared_version` is
    // "the exact string the actuator has to edit; a normalised copy would be an edit target that
    // does not appear in the file". Reading `node.value` here yields 1.2 — a string that is not in
    // the file, on a row the bump path would then search for and never find.
    const entry = at(
      parseKubernetesImages("image:\n  repository: acme/api\n  tag: 1.20\n"),
      "acme/api"
    );
    expect(entry?.declared).toBe("1.20");
    expect(entry?.declared).not.toBe("1.2");
    expect(entry?.version?.raw).toBe("1.20");
    expect(entry?.version?.minor).toBe(20);
  });

  it("`tag: 3.10` keeps its trailing zero too — the same coercion, a different pair of versions", () => {
    const entry = at(
      parseKubernetesImages("image:\n  repository: acme/api\n  tag: 3.10\n"),
      "acme/api"
    );
    expect(entry?.declared).toBe("3.10");
    expect(entry?.version?.minor).toBe(10);
  });

  it("a QUOTED version is carried without its quotes, so the edit target is the text inside", () => {
    const entry = at(
      parseKubernetesImages('image:\n  repository: acme/api\n  tag: "1.20"\n'),
      "acme/api"
    );
    expect(entry?.declared).toBe("1.20");
  });
});

describe("the shapes reported `unresolved` — FOUND and not readable, never silently absent (§2.2)", () => {
  it("E: a bare `tag:` with no image or repository beside it names the DOTTED KEY PATH", () => {
    // The owner's called-out case: the image name is in the chart's templates or hard-coded, so
    // this file versions something it does not name.
    const [entry, ...rest] = parseKubernetesImages("controller:\n  image:\n    tag: 1.4.2\n");
    expect(rest).toEqual([]);
    expect(entry?.coordinate).toBe("controller.image.tag");
    expect(entry?.constraint).toBe("unresolved");
    // No version, so `placeDeclarationOnLine` returns null and it can never mint a phantom line.
    expect(entry?.version).toBeUndefined();
    expect(entry?.note).toContain("no image or repository is declared beside this tag");
  });

  it("F: a Go-templated tag is unresolved, never rendered", () => {
    const [entry] = parseKubernetesImages(
      'image:\n  repository: acme/api\n  tag: "{{ .Chart.AppVersion }}"\n'
    );
    expect(entry?.coordinate).toBe("image.tag");
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.note).toContain("Go template");
    // AND THE IMAGE IS NOT RECORDED AS UNPINNED EITHER. A file that DOES declare a version must not
    // come back saying it declares none — that is the same lie one level down.
    expect(
      at(parseKubernetesImages('image:\n  repository: acme/api\n  tag: "{{ .V }}"\n'), "acme/api")
    ).toBeUndefined();
  });

  it("F: a templated REPOSITORY is unresolved — the coordinate itself is not knowable", () => {
    const [entry] = parseKubernetesImages(
      'image:\n  repository: "{{ .Values.global.registry }}/api"\n  tag: 1.2.3\n'
    );
    expect(entry?.coordinate).toBe("image.repository");
    expect(entry?.constraint).toBe("unresolved");
  });

  it("G: a value reached through an ALIAS is unresolved — the edit site is not the read site", () => {
    const [entry] = parseKubernetesImages(
      "appVersion: &v 1.2.3\nimage:\n  repository: acme/api\n  tag: *v\n"
    );
    expect(entry?.coordinate).toBe("image.tag");
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.note).toContain("alias");
  });

  it("G: a MERGE KEY is reported, because the keys it brings in are not in this mapping at all", () => {
    // Silence here would be the exact absence-read-as-nothing this parser exists to remove: the
    // merged mapping may declare an image and this parser cannot see it.
    const declarations = parseKubernetesImages(
      "base: &b\n  repository: acme/api\n  tag: 1.0.0\napp:\n  <<: *b\n"
    );
    const merge = at(declarations, "app.<<");
    expect(merge?.constraint).toBe("unresolved");
    expect(merge?.note).toContain("merges keys from a YAML anchor");
    // The ANCHOR's own mapping is a real declaration site and is still read normally.
    expect(at(declarations, "acme/api")?.declared).toBe("1.0.0");
  });

  it("H: a `tag:` that is not a scalar is unresolved rather than stringified", () => {
    const [entry] = parseKubernetesImages(
      "image:\n  repository: acme/api\n  tag:\n    - 1\n    - 2\n"
    );
    expect(entry?.coordinate).toBe("image.tag");
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.note).toContain("not a scalar");
  });

  it("a malformed reference is refused outright, not minted with an empty coordinate", () => {
    // An empty name is an identity every malformed manifest in the org would collide on.
    const [entry] = parseKubernetesImages('image: ":1.0"\n');
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.coordinate).toBe("image");
    expect(entry?.note).toContain("not a well-formed image reference");
  });

  it("NEGATIVE CONTROL: an `image:` MAPPING is not itself reported unresolved", () => {
    // `image: {repository, tag}` is the ordinary Helm shape. Reporting the mapping as "not a
    // scalar" would attach an unresolved entry — and therefore an `unsupported` stamp — to every
    // well-formed chart in the estate.
    const declarations = parseKubernetesImages("image:\n  repository: acme/api\n  tag: 1.2.3\n");
    expect(declarations.map((d) => d.constraint)).toEqual(["pinned"]);
  });
});

describe("T3/T4/T5 — what is carried and what is refused about a version", () => {
  it("T4: a bare `image: acme/api` is `unpinned`, and `latest` is NOT invented for it", () => {
    const entry = at(parseKubernetesImages("image: acme/api\n"), "acme/api");
    expect(entry?.constraint).toBe("unpinned");
    expect(entry?.declared).toBeUndefined();
    expect(entry?.note).toContain("resolution rule");
  });

  it("T3: an unorderable tag is carried with NO comparable version", () => {
    for (const tag of ["latest", "stable", "edge"]) {
      const entry = at(parseKubernetesImages(`image: acme/api:${tag}\n`), "acme/api");
      expect(entry?.declared, tag).toBe(tag);
      expect(entry?.version, tag).toBeUndefined();
      expect(entry?.note, tag).toContain("never string-ordered");
    }
  });

  it("T3: a precision-1 tag gets its OWN note — a registry cannot tell a date stamp from a major", () => {
    const dated = at(parseKubernetesImages("image: acme/api:20240115\n"), "acme/api");
    expect(dated?.note).toContain("date stamp or a commit sha");
    // And a genuine two-component tag is described as the moving tag it is, not as the same thing.
    const moving = at(parseKubernetesImages("image: acme/api:3.19\n"), "acme/api");
    expect(moving?.note).toContain("moving tag");
  });

  it("T5: only the key literally spelled `digest` is read", () => {
    const declarations = parseKubernetesImages(
      "image:\n  repository: acme/api\n  tag: 1.2.3\n  imageDigest: sha256:nope\n  sha: sha256:also-nope\n"
    );
    expect(at(declarations, "acme/api")?.digest).toBeUndefined();
  });

  it("the variant suffix survives verbatim, because the line's tag pattern is taken from it", () => {
    const entry = at(
      parseKubernetesImages("image:\n  repository: acme/api\n  tag: 3.19-alpine\n"),
      "acme/api"
    );
    expect(entry?.declared).toBe("3.19-alpine");
    expect(entry?.version?.suffix).toBe("-alpine");
  });
});

describe("T7 — multi-document streams", () => {
  it("parses EVERY document, and prefixes each key path with its document index", () => {
    const declarations = parseKubernetesImages(
      [
        "kind: Deployment",
        "spec:",
        "  containers:",
        "    - image: acme/api:1.2.3",
        "---",
        "kind: Deployment",
        "spec:",
        "  containers:",
        "    - image: acme/worker:4.5.6"
      ].join("\n")
    );
    expect(at(declarations, "acme/api")?.declaredIn).toBe("doc[0].spec.containers[0].image");
    expect(at(declarations, "acme/worker")?.declaredIn).toBe("doc[1].spec.containers[0].image");
  });

  it("a document that is not a mapping is SKIPPED, as long as another document is one", () => {
    const declarations = parseKubernetesImages("image: acme/api:1.2.3\n---\n- a\n- b\n");
    expect(at(declarations, "acme/api")?.declared).toBe("1.2.3");
  });
});

describe("T9 — the same image twice in one file is ONE row, and says so", () => {
  it("collapses identical declarations and NAMES every key path that fed the entry", () => {
    // The inventory's key is `(org, component, line, manifest_path)`, so two occurrences are one
    // row. An operator must learn that at ingestion, not from a bump that mysteriously refuses.
    const declarations = parseKubernetesImages(
      [
        "kind: Deployment",
        "spec:",
        "  containers:",
        "    - image: acme/api:1.2.3",
        "    - image: acme/api:1.2.3"
      ].join("\n")
    );
    const entry = at(declarations, "acme/api");
    expect(declarations).toHaveLength(1);
    expect(entry?.note).toContain("spec.containers[0].image");
    expect(entry?.note).toContain("spec.containers[1].image");
    expect(entry?.note).toContain("ONE inventory row");
  });

  it("two DIFFERENT versions of one image stay two entries, each warned about the other", () => {
    const declarations = parseKubernetesImages(
      "a:\n  image: acme/api:1.2.3\nb:\n  image: acme/api:1.3.0\n"
    );
    expect(declarations.map((d) => d.declared)).toEqual(["1.2.3", "1.3.0"]);
    for (const entry of declarations) {
      expect(entry.note).toContain("more than once with differing versions");
    }
  });
});

describe("T11 — `image` is an EXACT key, never a substring", () => {
  it("imagePullPolicy, imagePullSecrets, initImage and global.imageRegistry declare nothing", () => {
    const declarations = parseKubernetesImages(
      [
        "imagePullPolicy: Always",
        "imagePullSecrets:",
        "  - name: regcred",
        "initImage: acme/init:1.0.0",
        "imageCredentials:",
        "  registry: ghcr.io",
        "global:",
        "  imageRegistry: ghcr.io"
      ].join("\n")
    );
    // A count IS the assertion here, and it is a negative control: every one of those keys contains
    // "image", and a substring match would mint five phantom dependencies.
    expect(declarations).toEqual([]);
  });
});

describe("T8/T12 — unreadable must never collapse into empty (the whole prune argument)", () => {
  it("a 404 HTML body throws, even though it is perfectly valid YAML", () => {
    // THE CASE JSON AND TOML GET FOR FREE AND YAML DOES NOT. `<!doctype html>…` parses as a plain
    // scalar, so a naive reader returns "zero images" — and one values file can be the sole
    // declaration site for a dozen images, all of which the next pass would then prune.
    expect(() => parseKubernetesImages("<!doctype html><title>404</title>")).toThrow(
      ManifestParseError
    );
  });

  it("an unexpanded Git-LFS pointer throws — it is valid YAML too", () => {
    expect(() =>
      parseKubernetesImages("version https://git-lfs.github.com/spec/v1\noid sha256:ab\nsize 12\n")
    ).toThrow(ManifestParseError);
  });

  it("the EMPTY STRING throws rather than reporting zero images", () => {
    expect(() => parseKubernetesImages("")).toThrow(ManifestParseError);
    expect(() => parseKubernetesImages("   \n\n")).toThrow(ManifestParseError);
  });

  it("invalid YAML throws", () => {
    expect(() => parseKubernetesImages("image: [unclosed\n")).toThrow(ManifestParseError);
  });

  it("NEGATIVE CONTROL: a comments-only values file returns [] and does NOT throw", () => {
    // The honest empty: the file is there, it is YAML, and it declares nothing. Without this
    // control every assertion above is satisfied by a parser that throws unconditionally — and a
    // throw here would report a real chart as `unreadable` forever.
    expect(parseKubernetesImages("# nothing pinned here\n")).toEqual([]);
  });

  it("NEGATIVE CONTROL: an ordinary chart with no images returns [] and does NOT throw", () => {
    expect(
      parseKubernetesImages("replicaCount: 2\nservice:\n  type: ClusterIP\n  port: 80\n")
    ).toEqual([]);
  });
});

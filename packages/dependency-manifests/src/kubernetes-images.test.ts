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
 *
 * MUTATION LOG — ROUND 5, the false positives (each applied ALONE against a green suite, then
 * reverted). The whole suite passed on the first run after the fix, which is the shape a vacuous
 * test has, so every one of these was run before the round was called done.
 *
 *  1. Delete the image-context guard (`if (!underImageKey && image.kind !== "text") return;`)
 *     → 6 named tests red, all in "T13 — the `image` key is what makes a mapping an image".
 *  2. `isUsableCoordinate` returns true unconditionally → 5 red, incl. the pre-existing
 *     "a malformed reference is refused outright" — so the empty-coordinate rule is one rule.
 *  2b. Keep the empty check, delete only the per-segment check → 3 red. (Deleting only the
 *     `text === ""` clause kills NOTHING: it is redundant with the segment check, kept for
 *     legibility. Recorded rather than quietly left as an untested branch.)
 *  3. `registryRead` drops the `.trim() !== ""` test → 4 red, incl. the two realistic-file cases.
 *  4. Hoist the merge-key report above the context guard (the pre-fix behaviour) → 3 red.
 *  5. `parseAllDocuments(content)` without `{ uniqueKeys: false }` → 3 red, and the timing budget
 *     fails at 7.1 s against its 2 s bound rather than passing slowly.
 *  6. Delete the BLOCK_LITERAL/BLOCK_FOLDED refusal in `readKey` → 1 red.
 *  7. `isDigestShaped` returns true → 3 red, ONE OF THEM IN `dockerfile.test.ts` — which is the
 *     point of putting the helper in `dockerfile.ts` rather than here.
 *  8. `isEmptyDocument` narrowed back to `root === null` → 1 red.
 *  9. Suppress the duplicate-image-key report → 1 red.
 *
 * FIXTURE MUTATION: stripping the non-image furniture out of `REALISTIC_VALUES` leaves the suite
 * green — expected, since removing a hazard cannot fail a test. What proves the fixture is
 * load-bearing is mutation 1: with the guard gone, that one file alone reddens six cases.
 */

/** The entry for one coordinate, or `undefined`. Assertions name the entry they mean. */
const at = (declarations: readonly DeclaredDependency[], coordinate: string) =>
  declarations.find((d) => d.coordinate === coordinate);

/**
 * A REAL sha256 digest, spelled at full length everywhere a fixture needs one.
 *
 * `sha256:deadbeef` used to do this job, and it is not a digest — it is 8 hex characters where 64
 * belong. Since M21.7's own fix checks the shape, a short fixture would now pass for the wrong
 * reason (refused as malformed) in tests written to prove the digest is CARRIED.
 */
const DIGEST = "sha256:bea051df6a6d3bc84288b6db098df38a81d87b7ed226f34d22aaae1bc329c2b7";
const DIGEST_2 = "sha256:c5b1261d6d3e43071626931fc004f70149baeba2c8ec672bd4f27761f8e1ad6b";

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
    const both = at(parseKubernetesImages(`image: acme/api:1.2.3@${DIGEST}\n`), "acme/api");
    expect(both?.declared).toBe("1.2.3");
    expect(both?.digest).toBe(DIGEST);
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
      parseKubernetesImages(`image:\n  repository: acme/api\n  tag: 1.2.3\n  digest: ${DIGEST}\n`),
      "acme/api"
    );
    // Tag is a mutable label; the digest is identity. Collapsing them loses one of the two facts.
    expect(entry?.declared).toBe("1.2.3");
    expect(entry?.digest).toBe(DIGEST);
  });

  it("D: a digest-only pin is `pinned` with NO comparable version, so it mints no line", () => {
    const entry = at(parseKubernetesImages(`image: acme/api@${DIGEST}\n`), "acme/api");
    expect(entry?.constraint).toBe("pinned");
    expect(entry?.digest).toBe(DIGEST);
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

  it("G: a MERGE KEY IN AN IMAGE BLOCK is reported — the merged keys are not in this mapping", () => {
    // Silence here would be the exact absence-read-as-nothing this parser exists to remove: the
    // merged mapping may declare an image and this parser cannot see it.
    const declarations = parseKubernetesImages(
      "image: &img\n  repository: acme/api\n  tag: 1.0.0\nsidecar:\n  image:\n    <<: *img\n"
    );
    const merge = at(declarations, "sidecar.image.<<");
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
    // AND AS A NUMBER. The sentence above is for an operator; this is what a gate can read. A bump
    // actuator that edits one of two merged sites leaves the other behind, and it must be able to
    // refuse on a fact rather than by matching the prose of a note.
    expect(entry?.occurrences).toBe(2);
  });

  it("an UNMERGED declaration reports one occurrence, so the field is never 'set only when bad'", () => {
    // The negative control for the assertion above: if `occurrences` were populated only on the
    // merge path, `occurrences > 1` would be indistinguishable from `occurrences === undefined` for
    // a consumer, and the gate would be reading absence rather than a count.
    const declarations = parseKubernetesImages("image: acme/api:1.2.3\n");
    expect(at(declarations, "acme/api")?.occurrences).toBe(1);
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

/**
 * A values file with the FURNITURE a real chart carries.
 *
 * Every false positive this block exists to catch comes from a file richer than a test author
 * invents: the shapes below are taken from charts that ship — a `sources:` block that names an
 * upstream repository and its release tag, a Kafka client's `schemaRegistry.registry`, a package
 * feed's `registry`, a `<<:` merging resource presets, a `tag` used as a pod LABEL, and the
 * `registry: ""` placeholder that means "the default registry". Exactly TWO images are declared in
 * it, and a parser that reads `repository`/`registry`/`tag` off whatever mapping carries them
 * reports six.
 */
const REALISTIC_VALUES = [
  "## upstream provenance this chart records verbatim",
  "sources:",
  "  - name: upstream",
  "    repository: https://github.com/acme/api",
  "    tag: v2.4.0",
  "",
  "## the schema registry the client talks to — a URL, not an image host",
  "kafka:",
  "  bootstrapServers: kafka-0.kafka.svc:9092",
  "  schemaRegistry:",
  "    registry: http://schema-registry.kafka.svc:8081",
  "    subjectNameStrategy: TopicNameStrategy",
  "",
  "## the package feed an init container installs from",
  "npm:",
  "  registry: https://registry.npmjs.org",
  "  scope: '@acme'",
  "",
  "resourcePresets: &resources",
  "  limits:",
  "    cpu: 500m",
  "    memory: 512Mi",
  "",
  "global:",
  "  imageRegistry: ''",
  "  imagePullSecrets: []",
  "",
  "controller:",
  "  replicaCount: 2",
  "  imagePullPolicy: IfNotPresent",
  "  imagePullSecrets:",
  "    - name: regcred",
  "  resources:",
  "    <<: *resources",
  "  podLabels:",
  "    tag: canary",
  "  image:",
  "    registry: ''",
  "    repository: acme/controller",
  "    tag: 1.11.2",
  "",
  "metrics:",
  "  enabled: true",
  "  image: ghcr.io/acme/metrics:0.7.1"
].join("\n");

describe("T13 — the `image` key is what makes a mapping an image, and nothing else is", () => {
  it("reads exactly the TWO images in a realistic values file and invents no others", () => {
    // THE FALSE-POSITIVE CLASS, END TO END. A phantom coordinate makes SCP author a bump against
    // something that does not exist, or rewrite the wrong line in a real file.
    const declarations = parseKubernetesImages(REALISTIC_VALUES);
    expect(declarations.map((d) => d.coordinate)).toEqual([
      "acme/controller",
      "ghcr.io/acme/metrics"
    ]);
    // `registry: ''` is the placeholder for "the default registry", so the coordinate is the
    // repository alone — NOT `/acme/controller`, which would be a second line for the same image.
    expect(at(declarations, "acme/controller")?.declared).toBe("1.11.2");
  });

  it("and reports NOTHING unresolved about it, because `unsupported` must stay meaningful", () => {
    // `projectIngestionStamp` stamps a manifest `unsupported` and its component `partial` when
    // every declaration in it is unresolved, and names every unresolved one in the Decision. A
    // parser that reported this file's `sources[0].tag`, its two non-image `registry` keys and its
    // `resources.<<` would fire that warning on ordinary charts — and a warning that fires on
    // everything is a warning nobody reads, which destroys the honesty mechanism M21.7 exists for.
    expect(
      parseKubernetesImages(REALISTIC_VALUES).filter((d) => d.constraint === "unresolved")
    ).toEqual([]);
  });

  it("a bare `tag:` is reported INSIDE an image block and silent OUTSIDE one — the same key", () => {
    // The pair is the point: the honest report the round was built for survives, and the identical
    // key elsewhere in the file says nothing. One of these without the other is either the
    // false-positive class or a regression of the owner's called-out case.
    const inside = parseKubernetesImages("controller:\n  image:\n    tag: 1.4.2\n");
    expect(inside.map((d) => d.coordinate)).toEqual(["controller.image.tag"]);
    expect(inside[0]?.constraint).toBe("unresolved");
    expect(parseKubernetesImages("controller:\n  podLabels:\n    tag: 1.4.2\n")).toEqual([]);
  });

  it("`repository:` and `registry:` outside an image block mint nothing at all", () => {
    expect(
      parseKubernetesImages(
        "sources:\n  - repository: https://github.com/acme/api\n    tag: v2.4.0\n"
      )
    ).toEqual([]);
    expect(
      parseKubernetesImages("npm:\n  registry: https://registry.npmjs.org\n  scope: '@acme'\n")
    ).toEqual([]);
  });

  it("an `image:` MAPPING does not put its PARENT in context — the parent's own `tag:` is not read", () => {
    // The image block's context belongs to the block, one hop. Granting it to the parent reads
    // `controller.tag` — a chart version, here — as a version for `acme/api`.
    const declarations = parseKubernetesImages(
      "controller:\n  tag: chart-2.0\n  image:\n    repository: acme/api\n    tag: 1.2.3\n"
    );
    expect(declarations.map((d) => d.coordinate)).toEqual(["acme/api"]);
    expect(at(declarations, "acme/api")?.declared).toBe("1.2.3");
  });

  it("a `<<:` merge is reported in an image block and ignored on a resources block", () => {
    // Scoped for the same reason: `<<: *resourceDefaults` is ordinary YAML, and reporting it
    // stamped the whole manifest `unsupported`.
    expect(
      parseKubernetesImages("presets: &p\n  cpu: 500m\ncontroller:\n  resources:\n    <<: *p\n")
    ).toEqual([]);
    const inImage = parseKubernetesImages(
      "defaults: &d\n  repository: acme/api\nimage:\n  <<: *d\n  tag: 1.2.3\n"
    );
    expect(at(inImage, "image.<<")?.constraint).toBe("unresolved");
  });

  it("STATED RESIDUE: a sibling `registry` beside an `image:` SCALAR is not joined, and says so", () => {
    // ingress-nginx's shape: the repository lives under `image:` beside a `registry:`. An `image:`
    // scalar is a complete reference in a pod spec, so joining would double a registry it may
    // already name — the un-joined half is named instead of silently dropped.
    const entry = at(
      parseKubernetesImages(
        "controller:\n  image:\n    registry: registry.k8s.io\n    image: ingress-nginx/controller\n    tag: v1.11.2\n"
      ),
      "ingress-nginx/controller"
    );
    expect(entry?.declared).toBe("v1.11.2");
    expect(entry?.note).toContain("is NOT joined onto this coordinate");
  });
});

describe("T14 — an EMPTY coordinate is a SHARED line, not one bad row", () => {
  it('`repository: ""` is refused outright and reported at its own key path', () => {
    // `dependency_lines` is keyed `(org, ecosystem, coordinate, major)` ORG-WIDE, so an empty
    // coordinate is a cross-component merge: every component carrying this placeholder lands on
    // one line, one team's subscription governs another's, and a bump fans out across components
    // that never declared the image.
    const [entry, ...rest] = parseKubernetesImages('image:\n  repository: ""\n  tag: 1.2.3\n');
    expect(rest).toEqual([]);
    expect(entry?.coordinate).toBe("image.repository");
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.version).toBeUndefined();
    expect(entry?.note).toContain("would collapse onto ONE line");
  });

  it("near-empty spellings are refused too, and none of them mints a coordinate", () => {
    for (const repository of ['""', '"   "', '"/"', '"acme//api"', '"acme/api/"', '"acme api"']) {
      const declarations = parseKubernetesImages(
        `image:\n  repository: ${repository}\n  tag: 1.2.3\n`
      );
      expect(
        declarations.map((d) => d.constraint),
        repository
      ).toEqual(["unresolved"]);
      expect(declarations[0]?.coordinate, repository).toBe("image.repository");
    }
    // And with a registry beside it, so the refusal is not something the join happens to hide.
    const joined = parseKubernetesImages(
      'image:\n  registry: ghcr.io\n  repository: ""\n  tag: 1.2.3\n'
    );
    expect(joined.map((d) => d.coordinate)).toEqual(["image.repository"]);
    expect(at(joined, "ghcr.io/")).toBeUndefined();
  });

  it("an `image:` scalar with an unusable name is refused, not minted", () => {
    expect(parseKubernetesImages('image: ":1.0"\n')[0]?.constraint).toBe("unresolved");
    expect(parseKubernetesImages('image: "/acme/api:1.0"\n')[0]?.coordinate).toBe("image");
    // NEGATIVE CONTROL: a registry PORT is a colon inside a usable name and must still parse.
    expect(
      at(parseKubernetesImages("image: localhost:5000/foo:1.2\n"), "localhost:5000/foo")
    ).toBeDefined();
  });
});

describe('T15 — `registry: ""` means the DEFAULT registry, not a registry named empty', () => {
  it("the empty registry is absent, so the coordinate is not split by a leading slash", () => {
    // The common case, not an edge: it is the placeholder a chart ships so `global.imageRegistry`
    // can override it. Joined naively it yields `/acme/api`, and the SAME image then sits on two
    // different `dependency_lines` rows depending on whether a values file spelled the registry.
    const withEmpty = at(
      parseKubernetesImages('image:\n  registry: ""\n  repository: acme/api\n  tag: 1.2.3\n'),
      "acme/api"
    );
    expect(withEmpty?.constraint).toBe("pinned");
    expect(withEmpty?.declared).toBe("1.2.3");
    const withNone = at(
      parseKubernetesImages("image:\n  repository: acme/api\n  tag: 1.2.3\n"),
      "acme/api"
    );
    // ONE identity across both spellings — the assertion the split-line defect fails.
    expect(withEmpty?.coordinate).toBe(withNone?.coordinate);
    expect(
      parseKubernetesImages('image:\n  registry: ""\n  repository: acme/api\n  tag: 1.2.3\n').map(
        (d) => d.coordinate
      )
    ).not.toContain("/acme/api");
  });

  it("a whitespace-only registry is the same placeholder; a malformed one is reported", () => {
    expect(
      at(
        parseKubernetesImages('image:\n  registry: "   "\n  repository: acme/api\n  tag: 1.2.3\n'),
        "acme/api"
      )?.declared
    ).toBe("1.2.3");
    const slash = parseKubernetesImages(
      'image:\n  registry: "/"\n  repository: acme/api\n  tag: 1.2.3\n'
    );
    expect(slash.map((d) => d.coordinate)).toEqual(["image.registry"]);
    expect(slash[0]?.constraint).toBe("unresolved");
  });

  it("NEGATIVE CONTROL: a real registry is still joined with exactly one slash", () => {
    // Without this the three assertions above are satisfied by a parser that ignores `registry`.
    const entry = at(
      parseKubernetesImages("image:\n  registry: ghcr.io\n  repository: acme/api\n  tag: 1.2.3\n"),
      "ghcr.io/acme/api"
    );
    expect(entry?.declared).toBe("1.2.3");
    expect(entry?.note).toContain("appears nowhere contiguously");
  });
});

describe("T5 — a `digest:` has to BE a digest", () => {
  it("a truncated or non-digest value is reported and the TAG-pinned row survives without it", () => {
    // `resolved_digest` is what the version poller compares a registry's answer against, so a
    // value that is not a digest is a row that reads as identity-pinned and can never match.
    for (const bad of ["latest", "sha256:abc", `sha256:${"z".repeat(64)}`, "1.2.3"]) {
      const declarations = parseKubernetesImages(
        `image:\n  repository: acme/api\n  tag: 1.2.3\n  digest: "${bad}"\n`
      );
      const refused = at(declarations, "image.digest");
      expect(refused?.constraint, bad).toBe("unresolved");
      expect(refused?.note, bad).toContain("is not an OCI digest");
      // The real dependency is NOT lost over a bad neighbouring key.
      const kept = at(declarations, "acme/api");
      expect(kept?.declared, bad).toBe("1.2.3");
      expect(kept?.digest, bad).toBeUndefined();
      expect(kept?.note, bad).toContain("was NOT recorded");
    }
  });

  it("a `@…` that is not a digest refuses the whole one-scalar reference", () => {
    const [entry, ...rest] = parseKubernetesImages("image: acme/api:1.2.3@sha256:abc\n");
    expect(rest).toEqual([]);
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.note).toContain("is not an OCI digest");
  });

  it("NEGATIVE CONTROL: a full-length digest is carried by both spellings", () => {
    expect(
      at(
        parseKubernetesImages(
          `image:\n  repository: acme/api\n  tag: 1.2.3\n  digest: ${DIGEST_2}\n`
        ),
        "acme/api"
      )?.digest
    ).toBe(DIGEST_2);
    expect(at(parseKubernetesImages(`image: acme/api@${DIGEST_2}\n`), "acme/api")?.digest).toBe(
      DIGEST_2
    );
  });
});

describe("T1 — a BLOCK SCALAR is not an edit target", () => {
  it("`tag: |` is unresolved, and its trailing newline never reaches the inventory", () => {
    const declarations = parseKubernetesImages(
      "image:\n  repository: acme/api\n  tag: |\n    1.2.3\n"
    );
    const entry = at(declarations, "image.tag");
    expect(entry?.constraint).toBe("unresolved");
    expect(entry?.note).toContain("block scalar");
    // The specific violation: no declaration in this file carries `1.2.3\n` as its version text.
    for (const declaration of declarations) {
      expect(declaration.declared ?? "").not.toContain("\n");
    }
    // The folded form is the same trap with a different marker.
    expect(
      at(
        parseKubernetesImages("image:\n  repository: acme/api\n  tag: >\n    1.2.3\n"),
        "image.tag"
      )?.constraint
    ).toBe("unresolved");
  });
});

describe("T17 — duplicate keys, and the composer scan that was quadratic", () => {
  it("a flat mapping with 32 000 siblings parses in well under a second of budget", () => {
    // NOT A MICRO-BENCHMARK — a property of a call that sits in the ingestion path behind a 1 MiB
    // read cap. `yaml`'s duplicate-key check rescans every sibling already composed for each new
    // pair, so this input took 7.1 s with it on and 0.17 s with it off; at the cap it is the
    // difference between a minute of CPU per manifest and a fifth of a second. The header used to
    // claim the work was "linear in the bytes the read cap already bounds", and it was not.
    const lines = ["image: acme/api:1.2.3"];
    for (let i = 0; i < 32_000; i++) lines.push(`key${i}: value${i}`);
    const content = `${lines.join("\n")}\n`;

    const started = performance.now();
    const declarations = parseKubernetesImages(content);
    const elapsed = performance.now() - started;

    // The file is still READ correctly — a fast parser that returned nothing would pass a timing
    // assertion on its own.
    expect(declarations.map((d) => d.coordinate)).toEqual(["acme/api"]);
    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);

  it("a duplicated NON-image key no longer fails the whole file forever", () => {
    // Turning the scan off means `yaml` stops throwing on any duplicate key anywhere. That throw
    // was the wrong outcome anyway: it stamped the manifest `unreadable`, whose own words are
    // "this attempt failed and the next may not", about a file that fails identically forever.
    const declarations = parseKubernetesImages(
      "replicaCount: 1\nreplicaCount: 2\nimage: acme/api:1.2.3\n"
    );
    expect(declarations.map((d) => d.coordinate)).toEqual(["acme/api"]);
  });

  it("a duplicated IMAGE key is REPORTED, because Helm takes the last and a reader takes the first", () => {
    // The one thing the composer's scan was protecting, kept where it matters. Silently taking the
    // first `tag:` would record a version Helm does not use.
    const declarations = parseKubernetesImages(
      "image:\n  repository: acme/api\n  tag: 1.2.3\n  tag: 9.9.9\n"
    );
    expect(declarations.map((d) => d.coordinate)).toEqual(["image.tag"]);
    expect(declarations[0]?.constraint).toBe("unresolved");
    expect(declarations[0]?.note).toContain("declared more than once");
    // NEGATIVE CONTROL: the same keys spelled once resolve normally.
    expect(
      at(parseKubernetesImages("image:\n  repository: acme/api\n  tag: 1.2.3\n"), "acme/api")
        ?.declared
    ).toBe("1.2.3");
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

  it("a file whose only document is EMPTY returns [] — `unreadable` said the next pass may work", () => {
    // `yaml` composes `---` as a Scalar node holding null, not as `contents: null`, so the "some
    // root is not a mapping" refusal caught it and the manifest was stamped `unreadable` — "this
    // attempt failed and the next may not" about a file whose next ten thousand passes fail
    // identically. An empty document is an honest empty, and honest empty is `ok / 0 rows`.
    expect(parseKubernetesImages("---\n")).toEqual([]);
    expect(parseKubernetesImages("null\n")).toEqual([]);
    expect(parseKubernetesImages("---\n---\n")).toEqual([]);
    // NEGATIVE CONTROL, and it is the whole prune argument: a NON-empty scalar root still throws.
    // Without this the assertions above are satisfied by dropping trap 8 altogether.
    expect(() => parseKubernetesImages("---\n<!doctype html>\n")).toThrow(ManifestParseError);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readHashStripped, readStripped, stripComments } from "@scp/source-census";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * ================================================================================================
 * THE OFFLINE-CI GATE — "everything, CI included, must run offline" as a CHECK, not a claim
 * ================================================================================================
 *
 * Charter principle 5 and the working convention "Tests never touch the internet". CI was breaking
 * both: `promotion-scan-step.integration.test.ts` pulled its scan subjects straight from Docker Hub,
 * `oidc.integration.test.ts` pulled Keycloak from quay.io, and the two pinned-CLI installers
 * `docker create`d out of quay.io/ghcr.io — all on the REQUIRED integration gate. Measured over ~31
 * days of history, ~13% of failing integration-shard jobs (3 of 23, on PR branches AND on `main`)
 * were external-registry failures rather than anything to do with the code.
 *
 * `tools/ci-mirror/images.list` is the census that closed it. This file is what stops the census
 * from rotting — and it exists because the LAST attempt at this property was a comment. Job 5's env
 * block asserted, in prose, that ryuk was "THE LAST UNMIRRORED DOCKER HUB PULL ON THE REQUIRED
 * GATE'S PATH"; four classes of pull were open at the time, and stayed open for months behind that
 * sentence. A well-written comment naming a hazard is a signal to sweep, not evidence it was
 * handled (CLAUDE.md, "census by property, not by symptom").
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS PROVES, AND WHAT IT CANNOT — read `@scp/source-census`'s own module doc first
 * ------------------------------------------------------------------------------------------------
 * This is a SOURCE CENSUS: it reads the repo's own text and asserts what it still says. It proves a
 * NECESSARY condition ("no file names an image the mirror does not carry"), never a sufficient one.
 * It cannot see an image name assembled at runtime, one arriving through an env var this file does
 * not know about, or a `docker pull` inside a shell script a test spawns.
 *
 * THE RUNNING HALF IS THE `blackhole` STEP in workflow job 5: before the suite starts, every
 * upstream registry this manifest mirrors is pointed at 127.0.0.1 in /etc/hosts. A pull this census
 * cannot see still cannot succeed. Read the two together — the census says "you did not write it
 * down", the blackhole says "and it would not have worked anyway".
 *
 * NUL-BYTE NOTE: the walker below reads files through Node, which is why it sees all of them. Four
 * source files in this repo contain NUL bytes, and plain `grep -r` skips those SILENTLY — printing
 * nothing at all, not even "Binary file matches". A census run with `grep` (rather than `grep -a`)
 * would report a clean sweep over a tree it never fully read.
 */

const MANIFEST = path.join(REPO_ROOT, "tools/ci-mirror/images.list");
const MIRROR_SCRIPT = "scripts/ci-mirror.sh";
const MIRROR_NAMESPACE = "ghcr.io/commanderscp/mirror";

/** The env var the skopeo-sourced subject suites read. Must agree with `ci-mirror.sh seed`. */
const SUBJECT_REGISTRY_ENV = "SCP_TEST_SUBJECT_REGISTRY";

interface Entry {
  /** The upstream ref exactly as written, `${PIN_VAR}` references included. */
  readonly upstream: string;
  /** The literal string the consumer names the image by. */
  readonly alias: string;
}

function parseManifest(): Entry[] {
  const out: Entry[] = [];
  for (const raw of readFileSync(MANIFEST, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    expect(fields, `${line}: expected exactly two whitespace-separated fields`).toHaveLength(2);
    out.push({ upstream: fields[0]!, alias: fields[1]! });
  }
  return out;
}

/** Every `.ts` file in the tree — tests INCLUDED, and not only tests. */
function everyTypeScriptFile(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyTypeScriptFile(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const SOURCE_ROOTS = ["apps", "packages", "deploy/airgap", "tools"];
/**
 * Every `.ts` in the tree EXCEPT this file. A census that quotes the patterns it hunts for cannot
 * be a subject of itself — the example refs in the assertion messages and doc comments above would
 * be reported as real findings. This is the only exclusion, and it is the file doing the excluding;
 * anything else earning one would be a filter, and a filter is where the next instance hides.
 */
const ALL_TS = SOURCE_ROOTS.flatMap((root) =>
  everyTypeScriptFile(path.join(REPO_ROOT, root))
).filter((f) => path.resolve(f) !== path.resolve(import.meta.filename));

/**
 * Read and comment-strip the whole tree ONCE. Three assertions below walk it, and doing the strip
 * per assertion put this file over vitest's 5s default the moment the suite ran alongside its
 * siblings rather than alone — a census that times out is a census that does not run.
 */
const SOURCES: { rel: string; source: string }[] = ALL_TS.map((file) => ({
  rel: path.relative(REPO_ROOT, file),
  source: stripComments(readFileSync(file, "utf8"))
}));

const entries = parseManifest();
const aliases = new Set(entries.map((e) => e.alias));

describe("the CI mirror manifest is well-formed", () => {
  it("lists something, and every alias exactly once", () => {
    expect(entries.length).toBeGreaterThan(5);
    expect(aliases.size, "a duplicate alias would make one entry silently unreachable").toBe(
      entries.length
    );
  });

  it("pins every upstream ref by DIGEST — a tag is not an identity", () => {
    for (const { upstream } of entries) {
      // `${PIN_VAR}` entries are pinned by the pin.env they name; that coupling is asserted below.
      if (upstream.startsWith("${")) continue;
      expect(upstream, `${upstream} must be digest-pinned`).toMatch(
        /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/
      );
    }
  });

  it("names the two CLI pins by VARIABLE, so the manifest cannot drift from tools/*/pin.env", () => {
    // The alternative — copying the digests in — is the "quadruple-string coupling" this repo has
    // been bitten by before (tools/cosign/pin.env's own header). Referencing the variable removes
    // the second copy rather than adding a test to watch it.
    const upstreams = entries.map((e) => e.upstream);
    expect(upstreams).toContain("${SKOPEO_PINNED_IMAGE}");
    expect(upstreams).toContain("${COSIGN_PINNED_IMAGE}");
  });
});

describe("every image a source file names is mirrored", () => {
  /**
   * Testcontainers pulls whatever string it is handed. This is the assertion that would have caught
   * `quay.io/keycloak/keycloak:26.0` — the one Testcontainers image job 4d never mirrored, invisible
   * to a sweep that looked only for `docker.io`.
   *
   * NOT restricted to `*.test.ts`, deliberately: `test-support/global-setup.ts` is the file that
   * starts the Postgres every integration test uses, and it is not a test file. A filter is where
   * the next instance hides.
   */
  it("every GenericContainer / PostgreSqlContainer image resolves to a manifest alias", () => {
    const found: { file: string; image: string }[] = [];
    for (const { rel, source } of SOURCES) {
      for (const m of source.matchAll(
        /new\s+(?:Generic|PostgreSql|[A-Za-z]+)Container\(\s*([^)\s,]+)/g
      )) {
        const arg = m[1]!;
        if (/^["'`]/.test(arg)) {
          found.push({ file: rel, image: arg.slice(1, -1) });
          continue;
        }
        // An identifier: resolve a `const NAME = "…"` in the same file. If it cannot be resolved,
        // FAIL rather than skip — an unreadable image name is exactly where the next hole lives.
        const decl = new RegExp(String.raw`const\s+${arg}\s*=\s*"([^"]+)"`).exec(source);
        expect(
          decl,
          `${rel}: cannot resolve the image handed to a Container constructor ('${arg}') — ` +
            `give it a same-file string constant so this gate can see it`
        ).not.toBeNull();
        found.push({ file: rel, image: decl![1]! });
      }
    }
    expect(
      found.length,
      "the census found no containers at all — it has stopped matching"
    ).toBeGreaterThan(3);
    for (const { file, image } of found) {
      expect(
        aliases,
        `${file} starts '${image}', which tools/ci-mirror/images.list does not mirror — ` +
          `CI would pull it live from an outside registry`
      ).toContain(image);
    }
  });

  /**
   * skopeo talks to a registry directly and never consults the local Docker image store, so the
   * `docker tag` that keeps Testcontainers off Docker Hub is invisible to it. A hardcoded external
   * host in a `docker://` source is therefore a live pull no amount of mirroring can intercept —
   * which is precisely how `docker://docker.io/library/debian:11` took a whole suite down with a
   * 502 and ZERO individual test failures. Those refs must be built from a configurable prefix.
   */
  it("no source file hardcodes an external registry host in a docker:// ref", () => {
    for (const { rel, source } of SOURCES) {
      for (const m of source.matchAll(/docker:\/\/([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\//g)) {
        expect(
          m[1],
          `${rel} hardcodes 'docker://${m[1]}/…'. skopeo cannot be ` +
            `served by a local re-tag, so build the ref from ${SUBJECT_REGISTRY_ENV} instead`
        ).toBe(MIRROR_NAMESPACE.split("/")[0]);
      }
    }
  });

  it("the subject suites read the same env var ci-mirror.sh exports", () => {
    const readers = SOURCES.filter((s) => s.source.includes(SUBJECT_REGISTRY_ENV));
    expect(
      readers.length,
      `no source file reads ${SUBJECT_REGISTRY_ENV} — the seed step would export it to nobody`
    ).toBeGreaterThan(0);
    for (const { rel, source } of readers) {
      // The fallback keeps a fresh clone runnable with no GHCR credentials; without it, CI's
      // export would be load-bearing for local dev too.
      expect(source, `${rel} must default ${SUBJECT_REGISTRY_ENV} to upstream`).toContain(
        `process.env.${SUBJECT_REGISTRY_ENV} ?? "docker.io/library"`
      );
    }
    // Both halves: that the script exports the var at all, and that the namespace it exports is the
    // one this file (and the manifest's header) says it is.
    const script = readHashStripped(path.join(REPO_ROOT, MIRROR_SCRIPT));
    expect(script).toContain(`MIRROR_NAMESPACE="${MIRROR_NAMESPACE}"`);
    expect(script).toContain(`${SUBJECT_REGISTRY_ENV}=\${MIRROR_NAMESPACE}`);
  });
});

describe("the mirror is actually wired into CI and the installers", () => {
  // Hash-stripped, not raw: a `#`-commented-out `run:` line would satisfy a raw `.toContain`, which
  // is the failure mode `@scp/source-census` exists for.
  const ci = readHashStripped(path.join(REPO_ROOT, ".github/workflows/ci.yml"));

  it("job 4d mirrors, job 5 seeds, and job 5 denies the upstream registries", () => {
    for (const mode of ["push", "seed", "blackhole"]) {
      expect(ci, `ci.yml must run '${MIRROR_SCRIPT} ${mode}'`).toContain(
        `${MIRROR_SCRIPT} ${mode}`
      );
    }
  });

  it("the deny step comes AFTER the seed and BEFORE the integration suite", () => {
    // Order is the whole of this step's meaning: blackholing before the mirror is seeded would deny
    // the images the job needs, and blackholing after the suite would deny nothing.
    const seed = ci.indexOf(`${MIRROR_SCRIPT} seed`);
    const deny = ci.indexOf(`${MIRROR_SCRIPT} blackhole`);
    const suite = ci.indexOf("pnpm test:integration");
    expect(seed).toBeGreaterThan(-1);
    expect(deny).toBeGreaterThan(seed);
    expect(suite).toBeGreaterThan(deny);
  });

  it("the deny list can never include the mirror's own registry", () => {
    // ghcr.io serves the mirror; denying it would deny everything. The script guards this, and the
    // cosign pin — a ghcr.io ref — is the entry that would otherwise put it on the list.
    const script = readHashStripped(path.join(REPO_ROOT, MIRROR_SCRIPT));
    expect(script).toMatch(/\[\s*"\$\{registry\}"\s*=\s*"ghcr\.io"\s*\]\s*&&\s*continue/);
  });

  it("both pinned-CLI installers take their image from the mirror override", () => {
    for (const [script, envVar, pinVar] of [
      ["scripts/install-pinned-skopeo.sh", "SCP_SKOPEO_IMAGE_REF", "SKOPEO_PINNED_IMAGE"],
      ["scripts/install-pinned-cosign.sh", "SCP_COSIGN_IMAGE_REF", "COSIGN_PINNED_IMAGE"]
    ] as const) {
      const text = readHashStripped(path.join(REPO_ROOT, script));
      expect(text, `${script} must accept ${envVar}, defaulting to the pin`).toContain(
        `\${${envVar}:-\${${pinVar}}}`
      );
      // The override is only safe because the fail-closed version assertion still runs on whatever
      // was installed. If that ever goes, the override becomes a way to install an unvetted binary.
      expect(text, `${script} must still fail closed on the version`).toMatch(/FATAL: pinned/);
      expect(readHashStripped(path.join(REPO_ROOT, MIRROR_SCRIPT))).toContain(`${envVar}=`);
    }
  });

  it("scripts/doctor.mjs is untouched by the override (it reports the PIN, not the mirror)", () => {
    // Guards a plausible wrong fix: making doctor report where CI happened to fetch the binary
    // would turn an operator-facing provenance report into a CI implementation detail.
    const doctor = readStripped(path.join(REPO_ROOT, "scripts/doctor.mjs"));
    expect(doctor).not.toContain("SCP_SKOPEO_IMAGE_REF");
    expect(doctor).not.toContain("SCP_COSIGN_IMAGE_REF");
  });
});

/**
 * ------------------------------------------------------------------------------------------------
 * THE VAR MUST ARRIVE, NOT MERELY BE EXPORTED — the gap that took both shards red
 * ------------------------------------------------------------------------------------------------
 * `ci-mirror.sh seed` wrote `SCP_TEST_SUBJECT_REGISTRY` into $GITHUB_ENV, the workflow log showed it
 * set on every later step, and the two subject suites read it with a `docker.io/library` fallback —
 * and the suites still went to Docker Hub, because the suites do not run in the job's shell. They
 * run under `turbo run test:integration`, and turbo's env mode is STRICT: a task receives only the
 * vars named in its `env`/`passThroughEnv` plus a small system set. An undeclared var is not passed
 * through empty, it is ABSENT — so `?? "docker.io/library"` took the fallback and the blackhole,
 * working exactly as designed, denied it.
 *
 * The existing assertion above ("the subject suites read the same env var ci-mirror.sh exports")
 * passed throughout. It checked the producer and it checked the consumer; nothing checked the pipe
 * between them. That is the shape this block exists to make impossible for the NEXT var: the repo
 * had already paid for this lesson once — `SCP_RUNNER_*_IMAGE_REF` are in `passThroughEnv` for the
 * same reason — and paying twice is what a census is supposed to prevent.
 */
describe("every var the seed step exports actually reaches the process that reads it", () => {
  const TURBO_JSON = "turbo.json";
  const turbo = JSON.parse(readFileSync(path.join(REPO_ROOT, TURBO_JSON), "utf8")) as {
    tasks: Record<string, { passThroughEnv?: string[] }>;
  };
  const passThrough = new Set(turbo.tasks["test:integration"]?.passThroughEnv ?? []);

  /**
   * The ONLY seeded vars whose consumer is a workflow step that runs directly, outside turbo:
   *
   *   - `SCP_SKOPEO_IMAGE_REF` / `SCP_COSIGN_IMAGE_REF` — the two pinned-CLI installers, which are
   *     their own `run:` steps.
   *   - `SKOPEO_IMAGE` / `COSIGN_IMAGE` — the root Dockerfile's own build ARGs, read by BUILDKIT
   *     during `docker compose build`. Added 2026-08-18 with consumer form 4 (see
   *     `tools/ci-mirror/images.list`): a digest-pinned `FROM` resolves at the registry, so it can be
   *     served by neither a local re-tag nor an installer's env var, and until these were exported the
   *     image build pulled quay.io LIVE. An image build is not a turbo task and never will be, so
   *     `passThroughEnv` is the wrong home for them — but they are still seeded vars, so they still
   *     have to be declared SOMEWHERE, which is what this list is for.
   *
   * Every other seeded var is read inside the test process, which turbo starts. An entry here is a
   * claim that gets checked below, not an exemption — and a NEW seeded var is required to pass by
   * default.
   */
  const CONSUMED_OUTSIDE_TURBO = new Set([
    "SCP_SKOPEO_IMAGE_REF",
    "SCP_COSIGN_IMAGE_REF",
    "SKOPEO_IMAGE",
    "COSIGN_IMAGE"
  ]);

  /** Every `KEY=` the script exports, read out of the script rather than re-typed here. */
  const seeded = [
    ...readHashStripped(path.join(REPO_ROOT, MIRROR_SCRIPT)).matchAll(
      /^\s*echo "([A-Z_][A-Z0-9_]*)=/gm
    )
  ].map((m) => m[1]!);

  it("the seed step exports something, including the subject registry", () => {
    // Anchors the regex against the script silently changing shape (a `printf`, a heredoc): an
    // empty `seeded` would make every assertion below vacuously true.
    expect(seeded.length).toBeGreaterThan(1);
    expect(seeded).toContain(SUBJECT_REGISTRY_ENV);
  });

  it("each one is declared in turbo's passThroughEnv, or is consumed outside turbo", () => {
    for (const name of seeded) {
      if (CONSUMED_OUTSIDE_TURBO.has(name)) continue;
      expect(
        passThrough.has(name),
        `${MIRROR_SCRIPT} seed exports ${name}, but ${TURBO_JSON}'s test:integration task does not ` +
          `list it in passThroughEnv — turbo runs strict, so the test process will NOT see it and ` +
          `whatever default the reader falls back to is what CI actually gets`
      ).toBe(true);
    }
  });

  it("nothing claimed to be consumed outside turbo is read inside a test process", () => {
    // Keeps the allowlist honest: the day a suite starts reading one of these, the claim that it
    // never needs to cross turbo's boundary is false, and this fails instead of the suite silently
    // taking a fallback.
    for (const name of CONSUMED_OUTSIDE_TURBO) {
      const readers = SOURCES.filter((s) => s.source.includes(`process.env.${name}`));
      expect(
        readers.map((r) => r.rel),
        `${name} is listed as consumed only by a direct workflow step, but TypeScript reads it — ` +
          `either add it to ${TURBO_JSON}'s passThroughEnv or stop claiming it stays outside turbo`
      ).toEqual([]);
    }
  });
});

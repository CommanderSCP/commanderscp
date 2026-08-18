import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { applyManifestBump, type ManifestBumpSpec } from "./bump-edit.js";

/**
 * M21.5 — THE RUNNER SHIM AND THE REFERENCE EDIT PRODUCE THE SAME BYTES.
 *
 * ================================================================================================
 * WHY THIS IS NOT OPTIONAL
 * ================================================================================================
 * `bump-edit.ts`'s `applyManifestBump` is the REFERENCE edit, and it is what every other test in
 * this package uses as a stand-in runner. That makes the whole orchestrator suite conditional on a
 * claim nothing checked: that `apps/runner-dep/run.sh` — the thing that actually runs in production
 * — agrees with it. If it does not, every bump is REFUSED by `verifyManifestBump` at run time while
 * the suite stays green, which is the "vacuous test" shape this repository has shipped before.
 *
 * So this runs the real shim, over the real fixtures, and requires BYTE-IDENTICAL output. It uses
 * `/bin/sh` and the host's `awk`; the production image is BusyBox and the script is POSIX
 * throughout, with no GNU-only constructs (no `sub()`/regex matching, no `-v`, no `sed -i`).
 *
 * The trailing-newline case is the one worth naming: awk always terminates its last record with a
 * newline, so a manifest that had none would come back one line longer and be refused by
 * `verifyManifestBump` with `line_count_changed` — a refusal an operator could do nothing about. The
 * shim restores the input's own byte shape, and the fixture below is what proves it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const runSh = join(here, "..", "..", "..", "..", "apps", "runner-dep", "run.sh");
const scratch = mkdtempSync(join(tmpdir(), "scp-runner-dep-test-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run the shim exactly as `runEditorContainer` does: five argv strings and the file at /work/in —
 * plus the anchor pair when, and ONLY when, the spec carries one. The conditional append is the
 * production shape, not a test convenience: it is what makes an image that predates the anchor
 * receive a byte-identical five-operand command line (`run.sh`'s "VERSION SKEW" table).
 */
function runShim(
  content: string,
  spec: ManifestBumpSpec
): { ok: true; output: string } | { ok: false; stderr: string } {
  const work = mkdtempSync(join(scratch, "run-"));
  mkdirSync(join(work, "in"), { recursive: true });
  mkdirSync(join(work, "out"), { recursive: true });
  writeFileSync(join(work, "in", "manifest"), content, "utf8");
  try {
    execFileSync(
      "/bin/sh",
      [
        runSh,
        spec.ecosystem,
        spec.manifestPath,
        spec.coordinate,
        spec.fromVersion,
        spec.toVersion,
        ...(spec.anchor ? [String(spec.anchor.line), spec.anchor.text] : [])
      ],
      {
        // The shim resolves `in/manifest` and `out/manifest` against the WORKING DIRECTORY, which
        // the image fixes as `WORKDIR /work`. Running it from a scratch dir is therefore the same
        // code path, not an adapted one. `env: {}` mirrors the container: no environment is passed,
        // and the shim reads none.
        env: {},
        cwd: work,
        stdio: "pipe",
        encoding: "utf8"
      }
    );
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return { ok: false, stderr: e.stderr ?? e.message };
  }
  return { ok: true, output: readFileSync(join(work, "out", "manifest"), "utf8") };
}

describe.skipIf(process.platform === "win32")(
  "apps/runner-dep/run.sh agrees with the reference edit, byte for byte",
  () => {
    const cases: { name: string; content: string; spec: ManifestBumpSpec }[] = [
      {
        name: "npm — a scoped coordinate with a range operator",
        content: [
          "{",
          '  "name": "acme-web",',
          '  "dependencies": {',
          '    "@acme/lib": "^1.2.3",',
          '    "@acme/other": "^1.2.3"',
          "  }",
          "}",
          ""
        ].join("\n"),
        spec: {
          ecosystem: "npm",
          coordinate: "@acme/lib",
          manifestPath: "package.json",
          fromVersion: "^1.2.3",
          toVersion: "^1.4.0"
        }
      },
      {
        name: "go — a module path and a v-prefixed tag",
        content: ["module acme/web", "", "require (", "\tgithub.com/acme/lib v1.2.3", ")", ""].join(
          "\n"
        ),
        spec: {
          ecosystem: "go",
          coordinate: "github.com/acme/lib",
          manifestPath: "go.mod",
          fromVersion: "v1.2.3",
          toVersion: "v1.9.0"
        }
      },
      {
        name: "oci — a base image with a variant suffix",
        content: ["FROM alpine:3.18-alpine AS build", "RUN true", ""].join("\n"),
        spec: {
          ecosystem: "oci",
          coordinate: "alpine",
          manifestPath: "Dockerfile",
          fromVersion: "3.18-alpine",
          toVersion: "3.19-alpine"
        }
      },
      {
        name: "python — a pinned requirement",
        content: ["acme-lib==1.4.0", "other-lib==2.0.0", ""].join("\n"),
        spec: {
          ecosystem: "python",
          coordinate: "acme-lib",
          manifestPath: "requirements.txt",
          fromVersion: "1.4.0",
          toVersion: "1.5.1"
        }
      },
      {
        name: "maven — a groupId:artifactId across two lines",
        content: [
          "<project>",
          "  <dependencies>",
          "    <dependency>",
          "      <groupId>com.acme</groupId>",
          "      <artifactId>lib</artifactId>",
          "      <version>1.2.3</version>",
          "    </dependency>",
          "  </dependencies>",
          "</project>",
          ""
        ].join("\n"),
        spec: {
          ecosystem: "maven",
          // The coordinate as `dependency_lines` stores it does not appear on the `<version>` line,
          // so this case is a REFUSAL for both implementations — which is the agreement that
          // matters here (a shim that "helpfully" edited it would diverge from the verifier).
          coordinate: "com.acme:lib",
          manifestPath: "pom.xml",
          fromVersion: "1.2.3",
          toVersion: "1.3.0"
        }
      },
      {
        name: "a manifest with NO trailing newline keeps its byte shape",
        content: ['{"dependencies":{"@acme/lib":"1.2.3"}}'].join("\n"),
        spec: {
          ecosystem: "npm",
          coordinate: "@acme/lib",
          manifestPath: "package.json",
          fromVersion: "1.2.3",
          toVersion: "1.4.0"
        }
      },

      // ----------------------------------------------------------------------------------------
      // M21.7 — the ANCHORED cases. Both implementations changed for these, so both must be
      // compared, and the REFUSALS are compared too: agreement on the happy path is the half a
      // fixture list gets for free, and a shim that "helpfully" edited where the reference refuses
      // would be a wrong edit in somebody's repository that no test noticed.
      // ----------------------------------------------------------------------------------------
      {
        name: "oci/values.yaml — a split shape, edited by the anchor (five other 1.2.3s untouched)",
        content: [
          "global:",
          "  imageTag: 1.2.3",
          "api:",
          "  image:",
          "    repository: acme/api",
          "    tag: 1.2.3",
          "worker:",
          "  image:",
          "    repository: acme/worker",
          "    tag: 1.2.3",
          "appVersion: 1.2.3",
          ""
        ].join("\n"),
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 6, text: "    tag: 1.2.3" }
        }
      },
      {
        name: "oci/values.yaml — SHAPE C, whose coordinate is in the file nowhere at all",
        content: [
          "image:",
          "  registry: ghcr.io",
          "  repository: acme/api",
          "  tag: 1.2.3",
          ""
        ].join("\n"),
        spec: {
          ecosystem: "oci",
          coordinate: "ghcr.io/acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 4, text: "  tag: 1.2.3" }
        }
      },
      {
        name: "an anchored split shape with NO trailing newline keeps its byte shape too",
        content: "image:\n  repository: acme/api\n  tag: 1.2.3",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 3, text: "  tag: 1.2.3" }
        }
      },
      {
        name: "REFUSAL: the anchor text no longer matches the file's own bytes",
        content: "image:\n  repository: acme/api\n  tag: 1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 3, text: "  tag: 1.2.3 # pinned" }
        }
      },
      {
        // THIS IS THE CASE THAT KILLS THE WRAP MUTATION, and it is why `run.sh` needs no explicit
        // range guard: make the shim fold an out-of-range anchor back into the file
        // (`anchor_nr = ((anchor_nr - 1) % NR) + 1`) and line 99 lands on the tag line and EDITS,
        // so this goes red. The anchor-text comparison is the whole control.
        name: "REFUSAL: the anchor points past the end of the file",
        content: "image:\n  repository: acme/api\n  tag: 1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 99, text: "  tag: 1.2.3" }
        }
      },
      {
        // A LINE NUMBER PAST EVERY AWK'S INTEGER RANGE — the ONE input where the three
        // implementations do not compute the same number. The shell validator accepts it (digits
        // only, no leading zero), so it reaches awk, where `anchor_line + 0` is a float that `%d`
        // clamps: at 2^63-1 under the host's awk, at 2147483647 under the BusyBox awk the image
        // actually runs (both measured), while the reference simply indexes `beforeLines[1e20 - 1]`
        // and gets `undefined`. All three must refuse.
        //
        // WHAT THIS PINS, STATED HONESTLY: a PLATFORM property, not a code branch. No mutation of
        // ours kills it — the case above is the one that kills the wrap mutation — and it is here
        // because `run.sh` carried an explicit `anchor_nr > NR` guard that no mutation killed
        // either, and it was deleted as dead code. Deleting a guard obliges someone to have checked
        // the value range it nominally covered on every awk in play; this case is that check, kept
        // permanently rather than done once and written into a comment.
        name: "REFUSAL: an anchor line past every awk's integer range refuses on both sides",
        content: "image:\n  repository: acme/api\n  tag: 1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          // `1e20`, not the 21 digits spelled out: a literal that long is a lint error for losing
          // precision, and losing precision is beside the point here. `String(1e20)` is
          // "100000000000000000000", which is what actually reaches argv — digits only, no leading
          // zero, so the shell validator accepts it and awk is the thing that has to cope.
          anchor: { line: 1e20, text: "  tag: 1.2.3" }
        }
      },
      {
        name: "REFUSAL: the anchored line carries no version to replace",
        content: "image:\n  repository: acme/api\n  tag: 1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 2, text: "  repository: acme/api" }
        }
      },
      {
        name: "REFUSAL: the coordinate rule speaks and the anchor disagrees with it (the veto)",
        content: "image: acme/api:1.2.3\nothers:\n  tag: 1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 3, text: "  tag: 1.2.3" }
        }
      },
      {
        name: "REFUSAL: the coordinate rule is AMBIGUOUS, and an anchor may not resolve it",
        content: "image: acme/api:1.2.3\nsidecar: acme/api:1.2.3\n",
        spec: {
          ecosystem: "oci",
          coordinate: "acme/api",
          manifestPath: "chart/values.yaml",
          fromVersion: "1.2.3",
          toVersion: "1.2.4",
          anchor: { line: 1, text: "image: acme/api:1.2.3" }
        }
      },
      {
        name: "an anchor that AGREES with a speaking coordinate rule edits the same line either way",
        content: "FROM alpine:3.18\nRUN true\n",
        spec: {
          ecosystem: "oci",
          coordinate: "alpine",
          manifestPath: "Dockerfile",
          fromVersion: "3.18",
          toVersion: "3.19",
          anchor: { line: 1, text: "FROM alpine:3.18" }
        }
      }
    ];

    it.each(cases)("$name", ({ content, spec }) => {
      const reference = applyManifestBump(content, spec);
      const shim = runShim(content, spec);
      if (reference === undefined) {
        // The reference refuses (zero or several candidate lines). The shim must refuse too — a
        // shim that produced SOMETHING here would be editing a declaration nobody identified.
        expect(shim.ok, "the shim must refuse where the reference refuses").toBe(false);
        return;
      }
      expect(shim.ok).toBe(true);
      expect(shim.ok && shim.output).toBe(reference);
    });

    it("refuses when NO line carries both the coordinate and the declared version", () => {
      const result = runShim('{"dependencies":{"@acme/other":"1.0.0"}}\n', {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        manifestPath: "package.json",
        fromVersion: "1.2.3",
        toVersion: "1.4.0"
      });
      expect(result.ok).toBe(false);
    });

    it("refuses when SEVERAL lines do — choosing would be a guess about which declaration was meant", () => {
      const content = ['"@acme/lib": "1.2.3",', '"@acme/lib": "1.2.3"', ""].join("\n");
      const spec: ManifestBumpSpec = {
        ecosystem: "npm",
        coordinate: "@acme/lib",
        manifestPath: "package.json",
        fromVersion: "1.2.3",
        toVersion: "1.4.0"
      };
      expect(applyManifestBump(content, spec)).toBeUndefined();
      expect(runShim(content, spec).ok).toBe(false);
    });

    it("the anchored and unanchored paths produce IDENTICAL bytes where both have an answer", () => {
      // The contiguous case is the one an image that predates the anchor must keep handling. If the
      // anchored branch ever selected differently — or reconstructed the line differently — this is
      // where an operator would see a diff that depends on which build produced it.
      const content = "FROM alpine:3.18\nRUN true\n";
      const base: ManifestBumpSpec = {
        ecosystem: "oci",
        coordinate: "alpine",
        manifestPath: "Dockerfile",
        fromVersion: "3.18",
        toVersion: "3.19"
      };
      const anchored: ManifestBumpSpec = {
        ...base,
        anchor: { line: 1, text: "FROM alpine:3.18" }
      };
      const five = runShim(content, base);
      const seven = runShim(content, anchored);
      expect(five.ok && seven.ok).toBe(true);
      expect(five.ok && five.output).toBe(seven.ok ? seven.output : "different");
      expect(five.ok && five.output).toBe(applyManifestBump(content, base));
    });

    it("refuses HALF an anchor — a line number with no text, and text with no line number", () => {
      // Not reachable through `runShim` (it appends the pair or neither), and that is exactly why it
      // is asserted directly: the shim is a public argv contract, and proceeding on half an anchor
      // would mean editing a line whose bytes nobody checked.
      const work = mkdtempSync(join(scratch, "half-"));
      mkdirSync(join(work, "in"), { recursive: true });
      mkdirSync(join(work, "out"), { recursive: true });
      writeFileSync(join(work, "in", "manifest"), "  tag: 1.2.3\n", "utf8");
      const argvs = [
        ["oci", "chart/values.yaml", "acme/api", "1.2.3", "1.2.4", "1"],
        ["oci", "chart/values.yaml", "acme/api", "1.2.3", "1.2.4", "", "  tag: 1.2.3"],
        ["oci", "chart/values.yaml", "acme/api", "1.2.3", "1.2.4", "0", "  tag: 1.2.3"],
        ["oci", "chart/values.yaml", "acme/api", "1.2.3", "1.2.4", "1x", "  tag: 1.2.3"]
      ];
      for (const argv of argvs) {
        let failed = false;
        try {
          execFileSync("/bin/sh", [runSh, ...argv], {
            env: {},
            cwd: work,
            stdio: "pipe",
            encoding: "utf8"
          });
        } catch {
          failed = true;
        }
        expect(failed, `argv ${JSON.stringify(argv)} must be refused`).toBe(true);
      }
    });

    it("refuses an unknown ecosystem loudly rather than ignoring the argument it does not branch on", () => {
      const result = runShim('"@acme/lib": "1.2.3"\n', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the point is an invalid value
        ecosystem: "rubygems" as any,
        coordinate: "@acme/lib",
        manifestPath: "Gemfile",
        fromVersion: "1.2.3",
        toVersion: "1.4.0"
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.stderr).toMatch(/unknown ecosystem/);
    });
  }
);

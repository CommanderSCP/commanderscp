import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyManifestBump, type ManifestBumpSpec } from "./bump-edit.js";
import {
  BUMP_SPEC,
  DECLARED_MANIFEST_PATHS,
  PACKAGE_JSON_BUMPED,
  VALUES_BUMP_SPEC,
  VALUES_YAML_BASE,
  VALUES_YAML_PATH,
  githubHandler,
  recordingCtx
} from "./write-test-support.js";

/**
 * ================================================================================================
 * THE CHARTER'S RUNNER/ORCHESTRATOR SPLIT, MEASURED (charter `scp-managed-dep`, amended 2026-08-15)
 * ================================================================================================
 * The 2026-08-15 amendment states the split in two sentences:
 *
 *   "Runner network egress is `--network none`; the runner holds no credential, contains no package
 *    manager, and edits only the bytes handed to it."
 *   "The orchestrator holds the per-run, repository-scoped, short-lived credential and reaches the
 *    git provider on the runner's behalf."
 *
 * Both halves were previously only DOCUMENTED here. A comment describing a containment property is
 * not the property; this file drives a real `trigger()` with every `docker` invocation mocked (so it
 * runs on every PR under `pnpm test`, no Docker required) and asserts what the container was
 * actually launched with — the same shape, and the same reason, as `@scp/plugin-managed-scan`'s
 * shipped `index.test.ts` containment block.
 *
 * WHAT EACH ASSERTION IS FOR, since a list of `expect`s is not self-explaining:
 *  - `--network none`      — the runner reaches no hosts. Without it, "never resolves a lockfile"
 *                            stops being a property of the image and becomes a hope.
 *  - no `-v`/`--mount`, no docker.sock — nothing of the host is reachable from inside, so a
 *                            path-escape in the editor has nowhere to escape TO. Bytes go in and out
 *                            by `docker cp`.
 *  - no `-e`/`--env`, and the token appears in NO argv — the credential does not cross into the
 *                            runner. This is the half the amendment had to be qualified for, so it
 *                            is the half most worth measuring.
 *  - argv is exactly the five descriptor strings — seven for a split shape, where the last two are
 *                            the M21.7 anchor (a line number and that line's own bytes). Nothing on
 *                            that command line can be a file body, a host path, or a command; the
 *                            anchor text is one line the container already holds in the file it was
 *                            handed, and the shim only ever COMPARES it.
 *  - the ORCHESTRATOR made the provider calls — the credential is used, but on this side of the
 *                            boundary. Asserted positively so "no network in the runner" cannot be
 *                            satisfied by there being no network anywhere.
 */

interface DockerCall {
  file: string;
  args: string[];
}
const dockerCalls: DockerCall[] = [];
/** The bytes the stand-in runner "produces". Set per test; the copy-OUT mock writes them. */
let editedOutput: string | undefined = PACKAGE_JSON_BUMPED;
/**
 * THE ARGV-DRIVEN STAND-IN RUNNER, used by the split-shape block below.
 *
 * With `editedOutput` set, the mock writes a fixed string and the docker argv is decorative — which
 * is fine for the hostile-output cases, and useless for proving the orchestrator SENT something.
 * With it `undefined`, the mock instead reconstructs the bump spec FROM THE `docker create` ARGV,
 * reads the bytes that were copied in, and applies the reference edit. That is what makes the
 * anchor's wiring load-bearing: delete the two operands from `runEditorContainer`, or delete the
 * `locateVersionLine` call that produces them, and the reference edit has no anchor, refuses the
 * split shape, and a NAMED test below goes red.
 */
let copiedInDir: string | undefined;

vi.mock("node:child_process", () => {
  return {
    execFile: (
      file: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void
    ) => {
      dockerCalls.push({ file, args });
      const sub = args[0];
      if (sub === "create") {
        cb(null, { stdout: "dep-container-abc\n", stderr: "" });
        return;
      }
      if (sub === "cp" && args[2]?.endsWith(":/work/in")) {
        // `${inDir}/.` — remember where the orchestrator put the bytes it handed the runner.
        copiedInDir = (args[1] as string).replace(/\/\.$/, "");
        cb(null, { stdout: "", stderr: "" });
        return;
      }
      if (sub === "cp" && args[1]?.includes(":/work/out")) {
        // The copy-OUT step is where the runner's product appears. Writing it here is what makes
        // this a stand-in RUNNER rather than a stub: the orchestrator reads real bytes off disk and
        // puts them through both verifiers, exactly as it would with the real image.
        const dest = args[2] as string;
        const produce = async (): Promise<string | undefined> => {
          if (editedOutput !== undefined) return editedOutput;
          // The argv tail after the image name: ecosystem, manifestPath, coordinate, fromVersion,
          // toVersion — and, only for a split shape, anchorLine and anchorText.
          const createArgs = dockerCalls.find((c) => c.args[0] === "create")?.args ?? [];
          // THE EXACT IMAGE, not `startsWith("scp-runner-dep")`. The create line now also carries
          // `--name scp-runner-<runId>`, and a prefix match would happily pick the NAME out of a run
          // whose key began with "dep" — silently reading the operands from the wrong offset and
          // producing a refusal that reads like a parser bug.
          const trailing = createArgs.slice(createArgs.indexOf("scp-runner-dep:vetted") + 1);
          const [ecosystem, manifestPath, coordinate, fromVersion, toVersion, line, text] =
            trailing;
          const original = await readFile(join(copiedInDir as string, "manifest"), "utf8");
          return applyManifestBump(original, {
            ecosystem: ecosystem as ManifestBumpSpec["ecosystem"],
            manifestPath: manifestPath as string,
            coordinate: coordinate as string,
            fromVersion: fromVersion as string,
            toVersion: toVersion as string,
            ...(line !== undefined && text !== undefined
              ? { anchor: { line: Number(line), text } }
              : {})
          });
        };
        void produce().then(
          (bytes) =>
            bytes === undefined
              ? // The reference edit REFUSED. A real runner exits 3 here; the orchestrator sees a
                // failed container, so the mock reports one rather than writing nothing.
                cb(new Error("scp-runner-dep: no line could be selected for the edit"))
              : void writeFile(join(dest, "manifest"), bytes, "utf8").then(
                  () => cb(null, { stdout: "", stderr: "" }),
                  (err: Error) => cb(err)
                ),
          (err: Error) => cb(err)
        );
        return;
      }
      cb(null, { stdout: "", stderr: "" }); // start / rm
    }
  };
});

const { createManagedDepExecutorPlugin, __resetManagedDepOutcomes, RUNNER_NETWORK_MODE } =
  await import("./index.js");

let scratch: string;

beforeEach(async () => {
  dockerCalls.length = 0;
  __resetManagedDepOutcomes();
  scratch = await mkdtemp(join(tmpdir(), "managed-dep-unit-"));
  editedOutput = PACKAGE_JSON_BUMPED;
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** The token the fake provider mints — the string that must appear on NO docker command line. */
const RUN_TOKEN = "ghs_run_scoped";

function bumpIntent(overrides: Record<string, unknown> = {}, key?: string) {
  return {
    kind: "custom" as const,
    // Random by default — these cases do not read the argv's name. The one that does passes its own.
    idempotencyKey: key ?? `run-${Math.random()}`,
    parameters: {
      ecosystem: BUMP_SPEC.ecosystem,
      coordinate: BUMP_SPEC.coordinate,
      manifestPath: BUMP_SPEC.manifestPath,
      declaredManifestPaths: DECLARED_MANIFEST_PATHS,
      fromVersion: BUMP_SPEC.fromVersion,
      toVersion: BUMP_SPEC.toVersion,
      repo: "acme/widget",
      baseBranch: "main",
      changeObjectId: "0198f3c1-1111-7000-8000-000000000001",
      delivery: "pull_request",
      ...overrides
    }
  };
}

function runCtx(configOverrides: Record<string, unknown> = {}) {
  const { ctx, calls } = recordingCtx(githubHandler());
  return {
    ctx: {
      ...ctx,
      config: {
        runnerImage: "scp-runner-dep:vetted",
        networkMode: "none",
        workspaceRoot: scratch,
        appId: "12345",
        installationId: "67890",
        privateKeyPem,
        ...configOverrides
      }
    },
    calls
  };
}

function createCall(): DockerCall | undefined {
  return dockerCalls.find((c) => c.args[0] === "create");
}

describe("the runner half — no network, no credential, no host", () => {
  it("launches the vetted image with --network none, no bind mount and no docker socket", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const create = createCall();
    expect(create).toBeDefined();
    const args = create!.args;
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("scp-runner-dep:vetted");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--mount");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args).not.toContain("--privileged");

    // Bytes in and out by `docker cp`, and the container destroyed unconditionally.
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[2]?.endsWith(":/work/in"))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "cp" && c.args[1]?.endsWith(":/work/out/."))).toBe(
      true
    );
    expect(dockerCalls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);

    // ...and the run actually completed, so none of the above passed by nothing having happened.
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
  });

  it("hands the runner exactly the five descriptor strings — nothing that could be a file body", async () => {
    // FIVE, not seven: this is a CONTIGUOUS npm bump, the coordinate rule finds its own line, and no
    // anchor is derived. That the pair is appended only when there is one is what makes an image
    // built before M21.7 receive a byte-identical command line (`run.sh`'s version-skew table).
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx();
    await plugin.trigger(ctx, bumpIntent());

    const args = createCall()!.args;
    const trailing = args.slice(args.indexOf("scp-runner-dep:vetted") + 1);
    expect(trailing).toEqual([
      BUMP_SPEC.ecosystem,
      BUMP_SPEC.manifestPath,
      BUMP_SPEC.coordinate,
      BUMP_SPEC.fromVersion,
      BUMP_SPEC.toVersion
    ]);
  });

  it("passes NO credential to the container — not on argv, not through -e, not through --env-file", async () => {
    // ================================================================================================
    // THE SWEEP THAT CATCHES A FOURTH MANAGED PLUGIN FOR FREE.
    // ================================================================================================
    // This used to check `-e`/`--env` and the joined command line. Since the port grew a `secretEnv`
    // that Docker delivers through `--env-file`, "no `-e`" is no longer the whole of "no credential
    // reaches the runner": a plugin could pass a credential with no `-e` anywhere in sight. Both
    // delivery mechanisms are named here, and the value sweep runs over every ELEMENT of every argv
    // rather than over the joined line — a joined line cannot say WHICH argument carried the secret,
    // and its failure message is a wall of text nobody reads.
    //
    // IT IS ALSO THE ONLY ASSERTION HERE THAT DOES NOT NEED UPDATING WHEN A NEW SECRET APPEARS: it
    // iterates the credentials this test knows the orchestrator actually resolved.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    await plugin.trigger(ctx, bumpIntent());

    // The orchestrator really did mint the token, so this is a live negative, not a vacuous one.
    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(true);

    /** Every secret value that existed during this run — the run-scoped token and the app key. */
    const resolvedSecrets = [RUN_TOKEN, privateKeyPem, privateKeyPem.slice(0, 40)];
    for (const call of dockerCalls) {
      for (const arg of call.args) {
        for (const secret of resolvedSecrets) {
          expect(arg, `a docker argv element carried a resolved secret: ${arg}`).not.toContain(
            secret
          );
        }
      }
      expect(call.args, "the runner is given no environment").not.toContain("-e");
      expect(call.args, "the runner is given no environment").not.toContain("--env");
      // THE SECOND DELIVERY MECHANISM. `scp-managed-dep` holds no credential at all, so the port
      // must never stage an env-file for it — an env-file here would mean a credential on disk for
      // a runner whose charter clause says it holds none (amended 2026-08-15).
      expect(call.args, "a credential file was staged for a runner that holds none").not.toContain(
        "--env-file"
      );
    }
  });

  it("EVERY container it launches is NAMED AND LABELLED — an orphan is attributable", async () => {
    // M23.0's defect 1, from the plugin's side. The port proves that a `--name` on the spec reaches
    // the argv; only this proves that THIS plugin puts one there, and that the labels name the right
    // executor. Without it, a plugin that passed `labels: {}` would leave containers no operator
    // could sweep for and every port test would still be green.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx();
    await plugin.trigger(ctx, bumpIntent({}, "attributable-1"));

    const args = createCall()!.args;
    expect(args[args.indexOf("--name") + 1]).toBe("scp-runner-attributable-1");
    expect(args[args.indexOf("--label") + 1]).toBe("scp.executor=scp-managed-dep");
    expect(args.filter((a) => a === "--label")).toHaveLength(2);
    // ...and the container is torn down by that NAME, which is the identity that survives a `create`
    // that never answered.
    expect(dockerCalls.at(-1)!.args).toStrictEqual(["rm", "-f", "scp-runner-attributable-1"]);
  });

  it("launches `--network none` UNCONDITIONALLY — a config naming another mode changes nothing", async () => {
    // THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, and the reversal is the charter rather
    // than a change of mind. It previously mirrored `managed-scan`'s "honours the server-injected
    // networkMode" — correct THERE, because the 2026-07-23 amendment QUALIFIES that class's network
    // clause ("excepting operator-allowlisted registry pulls for the subject artifact's bytes"), so
    // an operator setting is exactly what the charter contemplates for it.
    //
    // The `scp-managed-dep` clause carries no such qualifier: "Runner network egress is `--network
    // none`; the runner holds no credential, contains no package manager, and edits only the bytes
    // handed to it" (2026-08-15). An operator-settable knob with a `none` default is an
    // operator-facing way to contradict an unqualified clause, so the value is a LITERAL
    // (`RUNNER_NETWORK_MODE`) and `SCP_MANAGED_DEP_NETWORK_MODE` is now read by nothing.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx } = runCtx({ networkMode: "bridge-for-test" });
    await plugin.trigger(ctx, bumpIntent());
    const args = createCall()!.args;
    expect(RUNNER_NETWORK_MODE).toBe("none");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });
});

describe("the orchestrator half — it is the side that holds the credential and reaches the host", () => {
  it("mints a scoped token, opens the pull request, and revokes the token", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    expect(calls.some((c) => c.url.endsWith("/access_tokens"))).toBe(true);
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).toContain("@acme/lib");
  });

  /**
   * THE FIRST VERIFIER IS LOAD-BEARING, proven by a case only IT can catch.
   *
   * The runner returns a perfectly well-formed manifest that bumps the right dependency to the
   * WRONG version. `verifyManifestOnlyEdit` accepts it — and is right to: every one of its gates
   * holds (the dependency set is identical, exactly one already-declared version moved, the change
   * is confined to that version's own text). It has no idea which version was ASKED for; that fact
   * lives in the descriptor, which is what `verifyManifestBump` anchors on.
   *
   * This case exists because a mutation run found the gap: deleting the runner-output verdict check
   * left the earlier "added a dependency" case green, since the second verifier caught that one
   * anyway. A refusal that another layer would have caught is not evidence that this layer works.
   */
  it("REFUSES a runner that bumped to a version nobody asked for — the descriptor-anchored check", async () => {
    editedOutput = PACKAGE_JSON_BUMPED.replace('"^1.4.0"', '"^9.9.9"');
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("non_version_edit");
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
  });

  it("REFUSES to publish output the verifiers reject — and reaches the provider's write route not at all", async () => {
    // The runner returns a legitimate bump PLUS an added dependency. That is the failure mode the
    // whole verification layer exists for: the image could be rebuilt wrong, replaced, or simply
    // given a manifest its editor mis-parses, and every layer above would otherwise not be able to
    // tell.
    editedOutput = PACKAGE_JSON_BUMPED.replace(
      '"@acme/lib": "^1.4.0"',
      '"@acme/lib": "^1.4.0",\n    "evil": "1.0.0"'
    );
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(ctx, bumpIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    // Nothing was written: no commit, no pull request. The read of the manifest and the token mint
    // happened (they precede the runner), which is why this asserts on the WRITE routes rather than
    // on a request count.
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
    // ...and the credential was still revoked on the way out of the failed run.
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/installation/token"))).toBe(
      true
    );
  });
});

/**
 * ================================================================================================
 * M21.7 — THE SPLIT SHAPE, END TO END, AND THE WIRING GATE ON THE ANCHOR
 * ================================================================================================
 * Everything below drives the REAL `trigger()` against a chart's `values.yaml` whose coordinate and
 * version are on different lines. The stand-in runner is argv-driven here (`editedOutput = undefined`),
 * so it can only produce bytes if the orchestrator actually SENT an anchor — which is the delete-the-
 * wiring gate this milestone's standing rule asks for:
 *
 *   * delete the two operands from `runEditorContainer`'s `docker create` argv → the stand-in runner
 *     has no anchor, the reference edit refuses, and "authors the bump" below goes red;
 *   * delete the `locateVersionLine` call in `trigger()` → the spec carries no anchor, the operands
 *     are not appended, and the same test goes red;
 *   * delete `verifyManifestBump`'s anchored branch → the runner's bytes are refused and the same
 *     test goes red with `wrong_declaration_changed`.
 *
 * A component built and never installed is this repository's dominant failure, and a suite that
 * reached `applyManifestBump` directly would be green with all three of those deletions in place.
 */
describe("a split-shape Helm image is BUMPED, not merely detected", () => {
  function valuesIntent(overrides: Record<string, unknown> = {}) {
    return {
      kind: "custom" as const,
      idempotencyKey: `values-${Math.random()}`,
      parameters: {
        ecosystem: VALUES_BUMP_SPEC.ecosystem,
        coordinate: VALUES_BUMP_SPEC.coordinate,
        manifestPath: VALUES_YAML_PATH,
        declaredManifestPaths: [VALUES_YAML_PATH],
        fromVersion: VALUES_BUMP_SPEC.fromVersion,
        toVersion: VALUES_BUMP_SPEC.toVersion,
        repo: "acme/widget",
        baseBranch: "main",
        changeObjectId: "0198f3c1-1111-7000-8000-000000000002",
        delivery: "pull_request",
        ...overrides
      }
    };
  }

  function valuesCtx(base: string = VALUES_YAML_BASE) {
    const { ctx, calls } = recordingCtx(githubHandler({}, {}, base));
    return {
      calls,
      ctx: {
        ...ctx,
        config: {
          runnerImage: "scp-runner-dep:vetted",
          workspaceRoot: scratch,
          appId: "12345",
          installationId: "67890",
          privateKeyPem
        }
      }
    };
  }

  beforeEach(() => {
    // ARGV-DRIVEN: the stand-in runner reads the docker command line and the copied-in bytes.
    editedOutput = undefined;
  });

  it("authors the bump: the anchor reaches the runner and the edited values.yaml is committed", async () => {
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = valuesCtx();
    const ref = await plugin.trigger(ctx, valuesIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.detail).not.toMatch(/REFUSED|failed/);
    expect(status.phase).toBe("succeeded");

    // THE ARGV: seven strings, the last two being the anchor the orchestrator derived. `tag: 1.2.3`
    // is on line 6 of the fixture, and `repository: acme/api` on line 5 — asserting the NUMBER is
    // what distinguishes "an anchor was sent" from "the right anchor was sent".
    const args = createCall()!.args;
    const trailing = args.slice(args.indexOf("scp-runner-dep:vetted") + 1);
    expect(trailing).toEqual([
      "oci",
      VALUES_YAML_PATH,
      "acme/api",
      "1.2.3",
      "1.2.4",
      "6",
      "    tag: 1.2.3"
    ]);

    // THE BYTES THAT WERE COMMITTED: only the image's own tag moved. `global.imageTag` and
    // `appVersion` carry the same version text and must be untouched.
    const write = calls.find((c) => c.method === "PUT" && c.url.includes("/contents/"));
    const committed = Buffer.from((write?.body as { content: string }).content, "base64").toString(
      "utf8"
    );
    expect(committed).toBe(VALUES_YAML_BASE.replace("    tag: 1.2.3", "    tag: 1.2.4"));
    expect(committed).toContain("  imageTag: 1.2.3");
    expect(committed).toContain("appVersion: 1.2.3");
  });

  it("D2: a split-shape bump is delivered as a PULL REQUEST even when the server granted auto_merge", async () => {
    // The residual risk is a parser-association bug, and a human on the diff is the control for it.
    // Asserted on the provider calls, not on a flag: the merge route must not be reached at all.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = valuesCtx();
    const ref = await plugin.trigger(
      ctx,
      valuesIntent({ delivery: "auto_merge", expectedHeadCommit: "a1b2c3d4".repeat(5) })
    );

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(false);
    expect(status.detail).toMatch(/not auto-merged/);
  });

  it("NEGATIVE CONTROL: a CONTIGUOUS bump with auto_merge is still merged — D2 is scoped", async () => {
    // Without this, the assertion above is satisfied by a plugin that stopped merging anything. The
    // package.json bump is CONTIGUOUS — the coordinate rule finds its line unaided — so no anchor is
    // in play, the widening did no work, and the governed grant is actuated as granted.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = runCtx();
    const ref = await plugin.trigger(
      ctx,
      bumpIntent({ delivery: "auto_merge", expectedHeadCommit: "a1b2c3d4".repeat(5) })
    );
    expect((await plugin.status(ctx, ref)).phase).toBe("succeeded");
    expect(calls.some((c) => c.url.includes("/merge"))).toBe(true);
  });

  it("REFUSES `anchor_not_derivable` before any container when neither selector has an answer", async () => {
    // A stale inventory row: the manifest no longer declares `1.2.3` anywhere the parser can bind to
    // this coordinate. Before this round the run would start a container and come back with "the
    // runner failed", which reads as a broken image.
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = valuesCtx(
      "global:\n  imageTag: 1.2.3\napi:\n  image:\n    repository: acme/api\n    tag: 9.9.9\n"
    );
    const ref = await plugin.trigger(ctx, valuesIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("anchor_not_derivable");
    // NO CONTAINER AT ALL, and nothing written.
    expect(dockerCalls).toHaveLength(0);
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
  });

  it("REFUSES a runner that edited the wrong image's identical tag, and writes nothing", async () => {
    // The runner returns a values file where the OTHER declaration's version moved. The anchored
    // branch of `verifyManifestBump` catches it on the line number; nothing reaches the repository.
    editedOutput = [
      "global:",
      "  imageTag: 1.2.4",
      "api:",
      "  image:",
      "    repository: acme/api",
      "    tag: 1.2.3",
      "appVersion: 1.2.3",
      ""
    ].join("\n");
    const plugin = createManagedDepExecutorPlugin();
    const { ctx, calls } = valuesCtx();
    const ref = await plugin.trigger(ctx, valuesIntent());

    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toContain("anchor_line_not_changed");
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toBe(false);
  });
});

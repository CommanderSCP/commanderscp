import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeNodeSpawns } from "@scp/source-census";

/**
 * ==================================================================================================
 * M23.6 CLAUSE 1, CLOSED BEHAVIOURALLY — "NOTHING WAS SPAWNED" AS AN OBSERVATION
 * ==================================================================================================
 *
 * WHAT WAS WRONG WITH THE GATE THIS REPLACES, MEASURED RATHER THAN SUSPECTED. `runner-iac.yaml`'s
 * replacement for the retired HONEST SCOPE note asserts "NOTHING SPAWNS A CONTAINER CLI ON THIS
 * PATH". Two things stood behind that sentence and neither could carry it:
 *
 *   1. THE LEDGER. `spawnRunnerProcess` records every spawn it makes, and each managed plugin
 *      asserts the ledger is empty on the Kubernetes path. But the ledger only sees what goes
 *      THROUGH it. A real `child_process.execFile(dockerBinary, …)` planted in
 *      `resolveRunnerLauncher`'s Kubernetes branch left all three of those tests GREEN while the
 *      verification pass recorded FOURTEEN spawns actually happening.
 *   2. THE SOURCE CENSUS in `no-docker-on-kubernetes.test.ts`, which is what did redden. It is a
 *      statement about TEXT. A census can prove a string is present; it can never prove an execution
 *      is absent, because the next spawn is written in whatever spelling the census does not hold —
 *      a helper in a new file, a rename, a dynamic `import()`. This repository has a named failure
 *      for reading text and calling it behaviour, and `@scp/source-census`'s own module doc opens
 *      with ten instances of it.
 *
 * SO THE OBSERVATION MOVES OUTSIDE THE SUBJECT. Every case below runs the BUILT package in a child
 * `node` whose `node:child_process` was wrapped before the subject loaded, and asserts over the list
 * of processes that were actually created. See `@scp/source-census`'s `spawn-observer.ts` for the
 * mechanism, the `util.promisify.custom` trap that would have made it silently blind to the exact
 * call this package makes, what it does not cover, and why an injectable spawner on
 * `RunnerLauncherConfig` — the shape the clause's own wording suggested — was rejected as both a new
 * hole in the server-injected config surface AND strictly weaker than this.
 *
 * THE CONTROLS ARE THE POINT, NOT THE PADDING. An observer that recorded nothing at all would
 * satisfy the negative arm forever, and this file's whole reason for existing is that a green
 * negative arm was already worthless once. So: the Docker path must be observed spawning (which also
 * proves the promisified route is wrapped, since that is the only way this package spawns), a raw
 * `execFile` in the driver must be observed, and — the measurement that names the defect — that same
 * raw `execFile` must be observed while `runnerSpawnCount()` stays at zero, which is the ledger's
 * blind spot reproduced on purpose so it cannot be quietly re-introduced as the whole gate.
 *
 * COST, STATED. Four child `node` processes, ~1s each, plus one `tsc -b`. The subject has to be
 * reachable as built `dist` (vitest's loader is not in the picture, deliberately — the module-cycle
 * defect `module-load.integration.test.ts` exists for was invisible to it), and the driver is a
 * string rather than type-checked code.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const ENTRY = resolve(PACKAGE_ROOT, "dist/index.js");

let workspaceRoot: string;

beforeAll(async () => {
  // FRESH `dist`, for the reason `module-load.integration.test.ts` states: the subject of every case
  // below is the BUILT output, and a stale one reports the previous commit's answer.
  await execFileAsync("npx", ["tsc", "-b"], { cwd: PACKAGE_ROOT, timeout: 180_000 });
  workspaceRoot = await mkdtemp(join(tmpdir(), "scp-nospawn-"));
}, 190_000);

afterAll(async () => {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
});

/**
 * A stateful in-child fake API server, deliberately NOT a canned response list: the adapter POSTs a
 * Job and then PATCHes and DELETEs it BY NAME, and a list cannot notice being asked about a name it
 * never issued. Written as source because it has to be constructed inside the observed child.
 */
const FAKE_IO = `
const NS = "scp";
const jobsRoot = "/apis/batch/v1/namespaces/" + NS + "/jobs";
const secretsRoot = "/api/v1/namespaces/" + NS + "/secrets";
const podsRoot = "/api/v1/namespaces/" + NS + "/pods";
const eventsRoot = "/api/v1/namespaces/" + NS + "/events";
const jobs = new Map();
let uid = 0;
const wire = [];
const io = {
  request: async (req) => {
    const path = req.path.split("?")[0];
    wire.push(req.method + " " + path);
    if (req.method === "POST" && path === jobsRoot) {
      uid += 1;
      const stamped = { ...req.body, metadata: { ...req.body.metadata, uid: "uid-" + uid } };
      jobs.set(req.body.metadata.name, stamped);
      return { status: 201, body: JSON.stringify(stamped) };
    }
    if (req.method === "POST" && path === secretsRoot) return { status: 201, body: "{}" };
    if (req.method === "GET" && path === jobsRoot) {
      return { status: 200, body: JSON.stringify({ items: [...jobs.values()] }) };
    }
    if (req.method === "GET" && path.startsWith(jobsRoot + "/")) {
      const job = jobs.get(path.slice(jobsRoot.length + 1));
      return job
        ? { status: 200, body: JSON.stringify(job) }
        : { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
    }
    if (req.method === "PATCH" && path.startsWith(jobsRoot + "/")) return { status: 200, body: "{}" };
    if (req.method === "DELETE" && path.startsWith(jobsRoot + "/")) {
      jobs.delete(path.slice(jobsRoot.length + 1));
      return { status: 200, body: "{}" };
    }
    if (req.method === "DELETE" && path.startsWith(secretsRoot + "/")) return { status: 200, body: "{}" };
    if (req.method === "GET" && path === eventsRoot) return { status: 200, body: '{"items":[]}' };
    if (req.method === "GET" && path === podsRoot) {
      return {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              metadata: { name: "scp-runner-b1-abcde" },
              status: {
                phase: "Succeeded",
                containerStatuses: [{ name: "runner", state: { terminated: { exitCode: 0 } } }]
              }
            }
          ]
        })
      };
    }
    if (req.method === "GET" && path.endsWith("/log")) return { status: 200, body: "ok" };
    return { status: 404, body: JSON.stringify({ reason: "NotFound" }) };
  },
  copyDir: async () => undefined,
  removeDir: async () => undefined
};
`;

function spec(runId: string, workspace: string): string {
  return `{
    runId: ${JSON.stringify(runId)},
    labels: { "scp.run-id": ${JSON.stringify(runId)} },
    image: "ghcr.io/commanderscp/scp-runner-iac:pinned",
    operands: ["plan"],
    networkMode: "none",
    env: ["A=1"],
    secretEnv: [],
    copyIn: [{ hostDir: ${JSON.stringify(join(workspace, "in"))}, containerPath: "/work/in" }],
    copyOut: {
      containerPath: "/work/out",
      hostDir: ${JSON.stringify(join(workspace, "out"))},
      when: "on-success",
      onFailure: "swallow"
    },
    timeoutMs: 30000,
    maxBuffer: 8388608
  }`;
}

describe("M23.6 clause 1, behaviourally: the Kubernetes path creates NO process, observed", () => {
  it("A WHOLE RUN AND A REAP ON THE KUBERNETES PATH SPAWN NOTHING — the shipped resolver, real Node", async () => {
    const driver = `
${FAKE_IO}
const m = await import(${JSON.stringify(ENTRY)});
// THE SHIPPED SELECTION PATH, not a hand-built launcher: the mutation this case exists for lived in
// \`resolveRunnerLauncher\`'s Kubernetes branch, which only this entry point reaches.
const launcher = m.resolveRunnerLauncher({
  runnerLauncher: "kubernetes",
  dockerBinary: "docker",
  kubernetes: {
    namespace: NS,
    workspaceRoot: ${JSON.stringify(workspaceRoot)},
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    io
  }
});
const result = await launcher.run(${spec("b1", workspaceRoot)});
const reaped = await launcher.reap();
await m.whenKubernetesReapSettled(NS);
console.log(JSON.stringify({
  succeeded: result.succeeded,
  failure: result.failure ?? null,
  wire,
  reaped,
  ledger: m.runnerSpawnCount()
}));
`;
    const run = await observeNodeSpawns({ module: driver, timeoutMs: 120_000 });
    expect(run.ok, `the driver did not complete:\n${run.stderr}`).toBe(true);
    const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
      succeeded: boolean;
      wire: string[];
      ledger: number;
    };
    // NON-VACUITY FIRST, TWICE OVER: a run that never happened spawns nothing either, and a run that
    // reached the adapter but failed at the first request would not exercise teardown or the log read.
    expect(report.succeeded, "the Kubernetes run did not succeed, so it drove only its first route").toBe(
      true
    );
    expect(report.wire).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect(report.wire).toContain("PATCH /apis/batch/v1/namespaces/scp/jobs/scp-runner-b1");
    expect(report.wire).toContain("DELETE /apis/batch/v1/namespaces/scp/jobs/scp-runner-b1");
    expect(report.wire.some((w) => w.endsWith("/log"))).toBe(true);
    // …AND THE MEASUREMENT ITSELF.
    expect(
      run.spawns,
      `a process was created on the Kubernetes path: ${JSON.stringify(run.spawns)}`
    ).toStrictEqual([]);
    // The ledger agrees, which is the SAME claim from inside — kept so that a future change which
    // makes the two disagree is visible as a disagreement rather than as one silent green.
    expect(report.ledger).toBe(0);
  }, 180_000);

  it("THE DOCKER PATH IS OBSERVED SPAWNING — the control, and the proof the promisified route is wrapped", async () => {
    // `packages/runner-launcher` spawns ONLY through `promisify(execFile)`. `execFile` carries its own
    // implementation on `util.promisify.custom` which calls the module-INTERNAL `execFile`, so a naive
    // wrapper over the export would record every callback-style call and miss every call this package
    // actually makes. If that were still true this case would report zero spawns.
    const driver = `
const m = await import(${JSON.stringify(ENTRY)});
const launcher = m.resolveRunnerLauncher({ dockerBinary: "scp-no-such-container-cli" });
await launcher.run(${spec("b2", workspaceRoot)}).catch(() => undefined);
await m.whenReapSettled();
console.log(JSON.stringify({ ledger: m.runnerSpawnCount() }));
`;
    const run = await observeNodeSpawns({ module: driver, timeoutMs: 120_000 });
    expect(run.ok, `the driver did not complete:\n${run.stderr}`).toBe(true);
    expect(
      run.spawns.length,
      "the Docker path created no process, so the negative arm above proves nothing"
    ).toBeGreaterThan(0);
    // THE BINARY BY NAME, which is what makes a rename visible — the clause's own words.
    expect(run.binaries).toContain("scp-no-such-container-cli");
    expect(run.spawns.some((s) => s.via.includes("[promisified]"))).toBe(true);
    expect(JSON.parse(run.stdout.trim()).ledger).toBeGreaterThan(0);
  }, 180_000);

  it("A RAW `execFile` IS OBSERVED WHILE THE LEDGER STAYS AT ZERO — the blind spot, reproduced", async () => {
    /**
     * THE DEFECT, EXECUTED. This is the shape of the mutation that left the three per-plugin ledger
     * assertions green: a spawn that does not go through `spawnRunnerProcess`. It is planted in the
     * driver rather than in the package so it can stand permanently, and it asserts BOTH halves —
     * the observer sees it, and `runnerSpawnCount()` does not. Delete the observer and the only thing
     * left watching this is a count that reads zero.
     */
    const driver = `
const m = await import(${JSON.stringify(ENTRY)});
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const before = m.runnerSpawnCount();
await promisify(execFile)("scp-planted-container-cli", ["version"]).catch(() => undefined);
console.log(JSON.stringify({ before, after: m.runnerSpawnCount() }));
`;
    const run = await observeNodeSpawns({ module: driver, timeoutMs: 60_000 });
    expect(run.ok, `the driver did not complete:\n${run.stderr}`).toBe(true);
    expect(run.binaries).toContain("scp-planted-container-cli");
    const { before, after } = JSON.parse(run.stdout.trim()) as { before: number; after: number };
    expect(
      after,
      "the ledger saw a spawn that never went through spawnRunnerProcess — if this ever becomes true, the ledger alone is a sufficient gate and this file can say so"
    ).toBe(before);
  }, 90_000);

  it("THE OBSERVER'S OWN NON-VACUITY: a child that spawns nothing reports nothing, and exits 0", async () => {
    const run = await observeNodeSpawns({ module: `console.log("quiet");`, timeoutMs: 30_000 });
    expect(run.ok, run.stderr).toBe(true);
    expect(run.stdout.trim()).toBe("quiet");
    expect(run.spawns).toStrictEqual([]);
  }, 60_000);
});

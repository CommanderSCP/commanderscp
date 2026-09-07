import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeNodeSpawns } from "@scp/source-census";
import { K8S_SA_DIR } from "./index.js";

/** M23.6 CLAUSE 1, CLOSED BEHAVIOURALLY. See docs/runner-launcher.md §325. */

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

/** A stateful in-child fake, not a canned response list. See docs/runner-launcher.md §326. */
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
    expect(
      report.succeeded,
      "the Kubernetes run did not succeed, so it drove only its first route"
    ).toBe(true);
    expect(report.wire).toContain("POST /apis/batch/v1/namespaces/scp/jobs");
    expect(report.wire).toContain("PATCH /apis/batch/v1/namespaces/scp/jobs/scp-runner-b1");
    expect(report.wire).toContain("DELETE /apis/batch/v1/namespaces/scp/jobs/scp-runner-b1");
    expect(report.wire.some((w) => w.endsWith("/log"))).toBe(true);
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
    /** THE DEFECT, EXECUTED. See docs/runner-launcher.md §327. */
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

  /** THE HOLE THE CASE ABOVE LEFT, NAMED AND MEASURED. See docs/runner-launcher.md §328. */
  it("NO INJECTED `io`: the resolver BUILDS ITS OWN TRANSPORT and still spawns nothing", async () => {
    const driver = `
const m = await import(${JSON.stringify(ENTRY)});
const before = m.kubernetesConstructionCount();
// NO \`io\`, NO \`dockerBinary\` — the shape production actually has.
const launcher = m.resolveRunnerLauncher({
  runnerLauncher: "kubernetes",
  kubernetes: {
    namespace: "scp",
    workspaceRoot: ${JSON.stringify(workspaceRoot)},
    workspaceVolume: { kind: "persistentVolumeClaim", claimName: "scp-runner-workspace" },
    // A DEAD LOCAL PORT, so that if this ever runs somewhere a projected token DOES exist, the
    // request cannot leave the machine. Nothing in this repository's tests may touch a network.
    apiBase: "http://127.0.0.1:1"
  }
});
const constructed = m.kubernetesConstructionCount() - before;
let failure = "";
await launcher.run(${spec("b5", workspaceRoot)}).catch((e) => { failure = String(e && e.message ? e.message : e); });
await launcher.reap().catch(() => undefined);
await m.whenKubernetesReapSettled("scp");
console.log(JSON.stringify({ constructed, failure, ledger: m.runnerSpawnCount() }));
`;
    const run = await observeNodeSpawns({ module: driver, timeoutMs: 120_000 });
    expect(run.ok, `the driver did not complete:\n${run.stderr}`).toBe(true);
    const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
      constructed: number;
      failure: string;
      ledger: number;
    };
    // NON-VACUITY 1 — THE `??` RIGHT-HAND SIDE WAS EVALUATED. Two constructions: the launcher, and
    // the transport the resolver built for itself. An injected `io` makes this ONE, which is exactly
    // the number every other case in this file produces and the reason none of them could see the
    // planted spawn.
    expect(
      report.constructed,
      "the resolver did not build its own transport, so the branch this case exists for was not evaluated"
    ).toBe(2);
    // NON-VACUITY 2 — THE DEFAULT `readToken` ACTUALLY RAN. It is the resolver's own closure, and its
    // ENOENT names the projected-token path, which no other code in this package mentions. This
    // process is not a pod; if it ever is, this assertion is the thing that says so.
    expect(
      report.failure,
      "the run did not reach the default transport's token read, so nothing past construction was driven"
    ).toContain(`${K8S_SA_DIR}/token`);
    expect(
      run.spawns,
      `a process was created while the resolver built and used its own transport: ${JSON.stringify(run.spawns)}`
    ).toStrictEqual([]);
    expect(report.ledger).toBe(0);
  }, 180_000);

  it("THE DEFAULT TRANSPORT'S THREE CLOSURES, EXECUTED — `readToken`, `copyDir`, `removeDir`", async () => {
    /** The case above reaches `readToken` and stops there. See docs/runner-launcher.md §329. */
    const scratch = join(workspaceRoot, "closures");
    const driver = `
const m = await import(${JSON.stringify(ENTRY)});
const { mkdir, writeFile, readFile, stat } = await import("node:fs/promises");
const io = m.createDefaultKubernetesIo("http://127.0.0.1:1");
const from = ${JSON.stringify(join("SCRATCH", "from"))}.replace("SCRATCH", ${JSON.stringify(scratch)});
const to = ${JSON.stringify(join("SCRATCH", "to"))}.replace("SCRATCH", ${JSON.stringify(scratch)});
await mkdir(from + "/nested", { recursive: true });
await writeFile(from + "/nested/a.txt", "bytes-that-moved");
let tokenError = "";
await io
  .request({ step: "create", method: "GET", path: "/api", timeoutMs: 5_000 })
  .catch((e) => { tokenError = String(e && e.message ? e.message : e); });
await io.copyDir({ step: "copy-in", fromDir: from, toDir: to, timeoutMs: 5_000 });
const copied = await readFile(to + "/nested/a.txt", "utf8");
await io.removeDir({ step: "teardown", dir: to, timeoutMs: 5_000 });
let gone = false;
await stat(to).catch(() => { gone = true; });
console.log(JSON.stringify({ tokenError, copied, gone, ledger: m.runnerSpawnCount() }));
`;
    const run = await observeNodeSpawns({ module: driver, timeoutMs: 60_000 });
    expect(run.ok, `the driver did not complete:\n${run.stderr}`).toBe(true);
    const report = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
      tokenError: string;
      copied: string;
      gone: boolean;
      ledger: number;
    };
    // ALL THREE CLOSURES DEMONSTRABLY RAN, each by a signal only that closure can produce.
    expect(report.tokenError).toContain(`${K8S_SA_DIR}/token`);
    expect(report.copied, "`copyDir` moved no bytes, so 'it spawned nothing' is empty").toBe(
      "bytes-that-moved"
    );
    expect(report.gone, "`removeDir` removed nothing, so 'it spawned nothing' is empty").toBe(true);
    expect(
      run.spawns,
      `the default transport created a process: ${JSON.stringify(run.spawns)}`
    ).toStrictEqual([]);
    expect(report.ledger).toBe(0);
  }, 90_000);

  it("THE OBSERVER'S OWN NON-VACUITY: a child that spawns nothing reports nothing, and exits 0", async () => {
    const run = await observeNodeSpawns({ module: `console.log("quiet");`, timeoutMs: 30_000 });
    expect(run.ok, run.stderr).toBe(true);
    expect(run.stdout.trim()).toBe("quiet");
    expect(run.spawns).toStrictEqual([]);
  }, 60_000);
});

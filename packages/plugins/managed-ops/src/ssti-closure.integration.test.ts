import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * M27.2 / ADR-0002 — "tenant parameters are data-only, never rendered as Jinja2", asked of a REAL
 * ANSIBLE RUN rather than of the marshaller.
 *
 * A unit test over `params_to_vars.py` would assert that it emits `!unsafe` tags. That proves the
 * script writes the string we told it to write; it proves nothing about whether Ansible then
 * honours it, which is the only question that matters. So each case runs an actual playbook and
 * reads back what the task rendered.
 *
 * THE NEGATIVE CONTROL IS THE PROOF. `expectedLiteral` on its own is satisfiable by a broken run
 * that produced no output at all — and during development it *was*: a play that failed left a
 * stale output file behind and the assertion read the previous run's content. Every case therefore
 * runs the identical play twice, once with the hardener and once without, and asserts the
 * unhardened run EVALUATES. If the payload stops evaluating unhardened, the test is no longer
 * measuring anything and says so by failing.
 */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_OPS_CONTEXT = resolve(__dirname, "../../../../apps/runner-ops");
const IMAGE_TAG = "scp-runner-ops:m27-2-ssti-test";

let dockerReady = false;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const PLAY = `- hosts: localhost
  connection: local
  gather_facts: false
  tasks:
    - copy:
        dest: /work/out.txt
        content: "pkg={{ pkg }} deep={{ nested.deep[0] }} plain={{ plain }} count={{ count }}"
`;

/** Runs the play against `params`, with or without the hardening boundary, and returns what the
 *  task actually rendered. Removes the output file first so a failed play cannot be read as a
 *  passing literal. */
async function render(params: unknown, harden: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scp-ssti-"));
  try {
    await writeFile(join(dir, "params.json"), JSON.stringify(params));
    await writeFile(join(dir, "play.yml"), PLAY);
    const varsStep = harden
      ? "python /usr/local/bin/params_to_vars.py /work/params.json > /tmp/v.yml"
      : "cp /work/params.json /tmp/v.yml";
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${dir}:/work`,
        "--entrypoint",
        "sh",
        IMAGE_TAG,
        "-c",
        `rm -f /work/out.txt; ${varsStep} && ` +
          `ansible-playbook -i localhost, -e @/tmp/v.yml /work/play.yml >/dev/null 2>&1; ` +
          `cat /work/out.txt 2>/dev/null || echo "__PLAY_PRODUCED_NOTHING__"`
      ],
      { timeout: 180_000 }
    );
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  dockerReady = await dockerAvailable();
  if (!dockerReady) return;
  await execFileAsync("docker", ["build", "-t", IMAGE_TAG, RUNNER_OPS_CONTEXT], {
    timeout: 540_000,
    maxBuffer: 32 * 1024 * 1024
  });
}, 600_000);

describe("scp-runner-ops SSTI closure (M27.2)", () => {
  const PAYLOAD = {
    pkg: "{{ 7*7 }}",
    nested: { deep: ["{{ 6*6 }}"] },
    plain: "nginx",
    count: 3
  };

  it("a tenant parameter reaches the task as a LITERAL STRING, at any depth", async () => {
    if (!dockerReady) return expectSkipped();
    const hardened = await render(PAYLOAD, true);
    expect(hardened).not.toContain("__PLAY_PRODUCED_NOTHING__");
    expect(hardened).toContain("pkg={{ 7*7 }}");
    // Nested inside a dict inside a list. The obvious implementation walks only top-level keys,
    // which is a hole big enough to drive a lookup through.
    expect(hardened).toContain("deep={{ 6*6 }}");
    // An ordinary value is untouched, and a non-string keeps its type rather than being coerced.
    expect(hardened).toContain("plain=nginx");
    expect(hardened).toContain("count=3");
  }, 300_000);

  it("NEGATIVE CONTROL — the same payload DOES evaluate without the boundary", async () => {
    if (!dockerReady) return expectSkipped();
    const raw = await render(PAYLOAD, false);
    expect(raw).not.toContain("__PLAY_PRODUCED_NOTHING__");
    // 49 and 36, not the braces. If this ever stops being true the payload has gone inert and the
    // test above is measuring nothing — which is precisely the failure this control exists to catch.
    expect(raw).toContain("pkg=49");
    expect(raw).toContain("deep=36");
  }, 300_000);

  it("refuses a parameter that would reconfigure the run rather than feed it", async () => {
    if (!dockerReady) return expectSkipped();
    const dir = await mkdtemp(join(tmpdir(), "scp-ssti-reserved-"));
    try {
      await writeFile(
        join(dir, "params.json"),
        JSON.stringify({ ansible_connection: "local", pkg: "nginx" })
      );
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${dir}:/work`,
          "--entrypoint",
          "sh",
          IMAGE_TAG,
          "-c",
          "python /usr/local/bin/params_to_vars.py /work/params.json >/dev/null 2>&1 && echo ACCEPTED || echo REFUSED"
        ],
        { timeout: 120_000 }
      );
      // Marking it unsafe would not help: the danger is that `ansible_connection` is HONOURED at
      // all, so the whole `ansible_*` namespace is refused rather than sanitised.
      expect(stdout.trim()).toBe("REFUSED");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

/** See the note in lockdown.integration.test.ts — `it.runIf` is evaluated at collection time, so a
 *  docker-gated suite written that way reports green while running nothing. */
function expectSkipped(): void {
  console.warn(
    "[ssti-closure.integration] no reachable Docker daemon — the M27.2 SSTI proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}

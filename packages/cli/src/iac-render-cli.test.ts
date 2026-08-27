import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import {
  Component,
  Cluster,
  DeploymentTarget,
  ImagePipeline,
  InfrastructurePipeline,
  Service,
  Stack,
  synthToFile,
  waves
} from "@scp/iac";
import { buildProgram } from "./cli.js";

/**
 * `scp iac render` (team-pipeline-iac.md D21(d), §12) — DRIVEN through `buildProgram().parseAsync
 * ([...])`, the established pattern for a Commander `.action()` closure (`dependency-read-verbs-
 * wire.test.ts`'s doc explains why: neither a pure-printer unit test nor a hand-called function
 * reaches the closure itself). This is deliberately OFFLINE — no login, no `--base-url` — so unlike
 * most of this file's siblings it needs no stubbed `@scp/sdk` client.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scp-iac-render-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFixtureManifest(manifestPath: string): Promise<void> {
  const stack = new Stack("payments-api");
  const svc = new Service(stack, "payments", { name: "Payments" });
  const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });
  const stagingAmer = new DeploymentTarget(stack, "commercial-amer-staging", {
    name: "commercial-amer-staging"
  });
  const prodAmer = new DeploymentTarget(stack, "commercial-amer-production", {
    name: "commercial-amer-production"
  });
  const infra = new InfrastructurePipeline(api, "infra", {
    repo: "payments/payments-infra",
    waves: [[prodAmer]]
  });
  const payBlue = new Cluster(infra, "pay-blue", { name: "pay-blue", within: prodAmer });
  const image = new ImagePipeline(api, {
    repo: "payments/payments-api",
    branch: "main",
    waves: waves.linear([stagingAmer, prodAmer])
  });
  image.placeAt(payBlue);
  await synthToFile(stack, manifestPath);
}

describe("scp iac render — command wiring", () => {
  it("registers --manifest, --write and --output", () => {
    const program = buildProgram();
    const render = findCommand(program, ["iac", "render"]);
    expect(render, "no `scp iac render` command registered").toBeDefined();
    const longFlags = render!.options.map((o) => o.long);
    expect(longFlags).toContain("--manifest");
    expect(longFlags).toContain("--write");
    expect(longFlags).toContain("--output");
  });
});

describe("scp iac render — stdout (table/text) form", () => {
  it("prints the pipeline picture and the D21(d) honesty disclaimer to stdout", async () => {
    const manifestPath = join(dir, "manifest.json");
    await writeFixtureManifest(manifestPath);

    const lines: string[] = [];
    const spy = console.log;
    console.log = (msg?: unknown) => {
      lines.push(String(msg));
    };
    try {
      await buildProgram().parseAsync(["node", "scp", "iac", "render", "--manifest", manifestPath]);
    } finally {
      console.log = spy;
    }
    const out = lines.join("\n");
    expect(out).toContain("commercial-amer-staging");
    expect(out).toContain("commercial-amer-production");
    expect(out).toContain("manifest-only");
    // D6/D21(e): staging/production vocabulary only — never gamma, never bare prod.
    expect(out).not.toMatch(/\bgamma\b/i);
  });
});

describe("scp iac render --write — drift-checkable codegen", () => {
  it("writes the generated section to the target file", async () => {
    const manifestPath = join(dir, "manifest.json");
    await writeFixtureManifest(manifestPath);
    const sourcePath = join(dir, "stack.ts");
    await writeFile(sourcePath, "// hand-written pipeline declarations\n", "utf8");

    await buildProgram().parseAsync([
      "node",
      "scp",
      "iac",
      "render",
      "--manifest",
      manifestPath,
      "--write",
      sourcePath
    ]);

    const written = await readFile(sourcePath, "utf8");
    expect(written).toContain("// hand-written pipeline declarations");
    expect(written).toContain("manifest-only");
    expect(written).toContain("commercial-amer-production");
  });

  it("running --write TWICE against the same manifest is byte-identical (the drift check's premise)", async () => {
    const manifestPath = join(dir, "manifest.json");
    await writeFixtureManifest(manifestPath);
    const sourcePath = join(dir, "stack.ts");
    await writeFile(sourcePath, "// hand-written pipeline declarations\n", "utf8");

    await buildProgram().parseAsync([
      "node",
      "scp",
      "iac",
      "render",
      "--manifest",
      manifestPath,
      "--write",
      sourcePath
    ]);
    const once = await readFile(sourcePath, "utf8");

    await buildProgram().parseAsync([
      "node",
      "scp",
      "iac",
      "render",
      "--manifest",
      manifestPath,
      "--write",
      sourcePath
    ]);
    const twice = await readFile(sourcePath, "utf8");

    expect(twice).toBe(once);
  });
});

describe("scp iac render --output json", () => {
  it("emits the same honesty disclaimer in the JSON form — it is not a text-only courtesy", async () => {
    const manifestPath = join(dir, "manifest.json");
    await writeFixtureManifest(manifestPath);

    let printed = "";
    const spy = console.log;
    console.log = (msg?: unknown) => {
      printed = String(msg);
    };
    try {
      await buildProgram().parseAsync([
        "node",
        "scp",
        "iac",
        "render",
        "--manifest",
        manifestPath,
        "--output",
        "json"
      ]);
    } finally {
      console.log = spy;
    }
    const parsed = JSON.parse(printed) as { pipelines: unknown[]; disclaimer: string };
    expect(parsed.disclaimer).toContain("manifest-only");
    expect(parsed.pipelines.length).toBeGreaterThan(0);
  });
});
